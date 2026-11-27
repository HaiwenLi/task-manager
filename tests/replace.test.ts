import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renameWithRetry } from "../src/replace.js";
import { serializeTaskFile } from "../src/task-file.js";
import { journalTail } from "../src/journal.js";
import { readAttempt } from "../src/runtime.js";
import { runTask, type WorkerConfig } from "../src/worker.js";
import type { AgentAdapter } from "../src/adapters/types.js";
import { TaskStore } from "../src/task-store.js";
import { buildContinuousTask } from "./helpers/task-fixture.js";

/**
 * `rename` is replaced by a plan keyed on the destination. Which writers survive
 * a refusal is invisible while the OS cooperates, and on Windows it does not
 * always: a rename onto a file another handle holds fails with `EPERM` instead
 * of waiting. This machine does it often enough to fail the suite by itself.
 */
const state = vi.hoisted(() => ({
  /** Failures still to inject, per destination suffix. */
  refusals: new Map<string, Array<NodeJS.ErrnoException | null>>(),
  /** Rename attempts seen, per destination suffix. */
  attempts: new Map<string, number>(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (from: string, to: string): Promise<void> => {
      for (const [suffix, plan] of state.refusals) {
        if (!String(to).endsWith(suffix)) continue;
        state.attempts.set(suffix, (state.attempts.get(suffix) ?? 0) + 1);
        const next = plan.shift();
        if (next !== undefined && next !== null) throw next;
      }
      return actual.rename(from, to);
    },
  };
});

const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: simulated`), { code });

/** Refuse the next renames onto every path ending in `suffix`, once per code. */
function refuse(suffix: string, ...codes: string[]): void {
  state.refusals.set(suffix, codes.map(errno));
}

let root: string;
let tasks: string;
let work: string;
let store: TaskStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "taskctl-replace-"));
  tasks = join(root, "tasks");
  work = join(root, "work");
  await mkdir(tasks, { recursive: true });
  await mkdir(work, { recursive: true });
  store = new TaskStore(tasks);
  state.refusals.clear();
  state.attempts.clear();
  await writeFile(join(tasks, "a.md"), serializeTaskFile(buildContinuousTask("a")), "utf8");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function config(...chain: string[]): WorkerConfig {
  return {
    tasksDir: tasks, workdir: work, agent: "fixture", model: "q/one", modelChain: chain,
    modelCooldownMs: 900_000, quotaBackoffMs: [0], contextThreshold: 0.8,
    retryLimit: 1, lockTtlMs: 5_000, heartbeatMs: 5,
  };
}

const accepted = async () => ({ passed: true, skipped: false as const, exitCode: 0, output: "ok" });

/** A worker turn long enough for the lock heartbeat to tick inside it. */
const steady: AgentAdapter = {
  prompt: async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    await writeFile(join(tasks, "a", "done.requested"), "done");
    return { sessionId: "ses-a", exitCode: 0, text: "done" };
  },
  contextUsage: async () => 0, contextLimit: async () => 100,
};

/**
 * `steady`, held for a moment right before its turn starts. The wait is the
 * adapter's own, outside the task mutex, so a background heartbeat due in the
 * meantime runs on time instead of queueing behind it.
 */
const afterAHeartbeat: AgentAdapter = {
  ...steady,
  resolveModel: async (model) => {
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    return model;
  },
};

async function run(cfg: WorkerConfig, adapter: AgentAdapter): Promise<string> {
  return runTask(cfg, { store, adapter, acceptance: accepted }, await store.get("a"), "a-run");
}

const journal = async (): Promise<string> => (await journalTail(tasks, "a", 30)).join("\n");

describe("a file replace the OS refused", () => {
  it("is retried for the lock heartbeat instead of being read as a lost lock", async () => {
    refuse("lock.json", "EPERM");

    expect(await run(config(), steady)).toBe("done");
    expect(state.refusals.get("lock.json")).toEqual([]);
    expect(state.attempts.get("lock.json") ?? 0).toBeGreaterThanOrEqual(2);
    expect(await readAttempt(tasks, "a")).toMatchObject({ phase: "settled" });
    // A busy destination is absorbed by the retry; it never surfaces as a failed heartbeat.
    expect(await journal()).not.toMatch(/heartbeat-write-failed/);
  });

  it("does not end the attempt when the background heartbeat cannot be written", async () => {
    // Not a busy destination, so there is nothing to retry. The lock is still
    // this controller's: whether it may keep writing is decided by the lock
    // itself before every guarded write, not by one failed heartbeat. The turn
    // starts late, so the first writer to be refused is the background heartbeat.
    refuse("lock.json", "EIO");

    expect(await run(config(), afterAHeartbeat)).toBe("done");
    expect(await readAttempt(tasks, "a")).toMatchObject({ phase: "settled" });
    expect(await journal()).toMatch(/heartbeat-write-failed/);
  });

  it("does not end the attempt when the refresh before an operation cannot be written", async () => {
    // The background heartbeat (1.6 s) never fires inside this attempt, so the
    // refresh `controlled` does before the turn is the first writer to be refused.
    refuse("lock.json", "EIO");

    expect(await run({ ...config(), heartbeatMs: 5_000 }, steady)).toBe("done");
    expect(await readAttempt(tasks, "a")).toMatchObject({ phase: "settled" });
    expect(await journal()).toMatch(/heartbeat-write-failed/);
  });

  it("is retried while recording a handover instead of being read as an exhausted chain", async () => {
    refuse("models.json", "EPERM");
    const seen: string[] = [];
    const handedOver: AgentAdapter = {
      prompt: async (args) => {
        seen.push(args.model ?? "(default)");
        if (args.model === "w/one") {
          return { sessionId: "", exitCode: 1, text: "weekly limit reached", failure: "provider", tokens: 0 };
        }
        await writeFile(join(tasks, "a", "done.requested"), "done");
        return { sessionId: "ses-two", exitCode: 0, text: "done" };
      },
      contextUsage: async () => 0, contextLimit: async () => 100,
    };

    expect(await run(config("q/two"), handedOver)).toBe("done");
    expect(seen).toEqual(["w/one", "q/two"]);
  });

  it("does not spend the retry budget when the destination is a directory", async () => {
    // Windows refuses a rename onto a directory with the same EPERM as a busy
    // file. Unlike a busy file, no wait makes the destination stop being a
    // directory, so the refusal is final and is reported on the first attempt.
    const dir = join(root, "models.json");
    const plan = join(root, "models.json.tmp");
    await mkdir(dir);
    await writeFile(plan, "{}", "utf8");
    refuse("models.json", "EPERM", "EPERM", "EPERM", "EPERM", "EPERM", "EPERM");

    await expect(renameWithRetry(plan, dir)).rejects.toMatchObject({ code: "EPERM" });
    expect(state.attempts.get("models.json")).toBe(1);
    // What was to be written is still there: nothing of the caller's is lost.
    expect(await readFile(plan, "utf8")).toBe("{}");
  });

  it("still retries a first write whose destination does not exist yet", async () => {
    // Giving up at once is for a directory at the destination only. A
    // destination that is merely not there yet is the ordinary first write,
    // and a refusal of it is retried like any other.
    const plan = join(root, "fresh.json.tmp");
    await writeFile(plan, "{}", "utf8");
    refuse("fresh.json", "EPERM");

    await expect(renameWithRetry(plan, join(root, "fresh.json"))).resolves.toBeUndefined();
    expect(await readFile(join(root, "fresh.json"), "utf8")).toBe("{}");
  });

  it("is retried while writing the rework document, and the rework turn still happens", async () => {
    // rework.md is what a rework turn is told to read. A rename of it that
    // Windows refuses must not cost the turn it was written for.
    refuse("rework.md", "EPERM");
    const prompts: string[] = [];
    const reworking: AgentAdapter = {
      prompt: async (args) => {
        prompts.push(args.text);
        await writeFile(join(tasks, "a", "done.requested"), "done");
        return { sessionId: "ses-a", exitCode: 0, text: "done" };
      },
      contextUsage: async () => 0, contextLimit: async () => 100,
    };
    const acceptance = vi.fn()
      .mockResolvedValueOnce({ passed: false, exitCode: 1, output: "boom", skipped: false })
      .mockResolvedValueOnce(accepted());
    const review = async () => ({ verdict: "pass" as const, criteria: [{ id: "C1", pass: true, evidence: "ok" }], externalChanges: [], defects: [], summary: "ok" });

    expect(await runTask({ ...config(), retryLimit: 2 }, { store, adapter: reworking, acceptance, review }, await store.get("a"), "a-run")).toBe("done");
    expect(state.refusals.get("rework.md")).toEqual([]);
    expect(state.attempts.get("rework.md")).toBeGreaterThanOrEqual(2);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain(`先读 \`${join(tasks, "a", "rework.md")}\``);
  });
});

describe("the lock heartbeat", () => {
  it("still ends the attempt when the lock is no longer its own", async () => {
    // Another controller takes the task over while the turn is running. The
    // background heartbeat is what notices, and it cuts the turn off at once:
    // nothing more is written and the successor's lock is left alone. The lock
    // is forged across more than one heartbeat period (50 ms), because a
    // heartbeat that lands in between writes its own record back.
    let finished = false;
    let loopDone!: () => void;
    const settled = new Promise<void>((resolve) => { loopDone = resolve; });
    const lock = join(tasks, "a", "lock.json");
    const takenOver: AgentAdapter = {
      prompt: async () => {
        try {
          for (let i = 0; i < 8; i++) {
            await writeFile(`${lock}.forged`, JSON.stringify({ worker: "someone-else", heartbeat: Date.now() }), "utf8");
            await renameWithRetry(`${lock}.forged`, lock);
            await new Promise<void>((resolve) => setTimeout(resolve, 10));
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 400));
          finished = true;
          return { sessionId: "ses-a", exitCode: 0, text: "done" };
        } finally {
          loopDone();
        }
      },
      contextUsage: async () => 0, contextLimit: async () => 100,
    };

    expect(await run({ ...config(), heartbeatMs: 50 }, takenOver)).toBe("skipped");
    expect(finished).toBe(false);
    expect(await readFile(lock, "utf8")).toContain("someone-else");
    expect(await store.get("a")).toMatchObject({ status: "running", sessions: [] });
    // The attempt was cut off while the fake's loop was still forging the lock.
    // Let the loop run out before `afterEach` removes the directory: a write that
    // lands during the removal fails it with ENOTEMPTY, which made this test
    // fail every other run on Windows without saying anything about the lock.
    await settled;
  });
});

describe("replace discipline", () => {
  it("replaces a file only through the retrying rename", async () => {
    // A bare `await rename(` is allowed only for the helper itself and for the
    // three moves onto a name nothing else holds. Everything that replaces an
    // existing file goes through `renameWithRetry`.
    const src = fileURLToPath(new URL("../src/", import.meta.url));
    const direct: string[] = [];
    for (const name of (await readdir(src)).filter((file) => file.endsWith(".ts")).sort()) {
      const lines = (await readFile(join(src, name), "utf8")).split(/\r?\n/);
      for (const line of lines) {
        if (/\bawait rename\(/.test(line)) direct.push(`${name}: ${line.trim()}`);
      }
    }

    expect(direct).toEqual([
      "artifacts.ts: await rename(from, candidate);",
      "claim.ts: await rename(lockPath, `${lockPath}.stale-${Date.now()}`);",
      "reconcile.ts: await rename(join(tasksDir, id, name), join(archive, name)).catch((error: NodeJS.ErrnoException) => {",
      "replace.ts: await rename(from, to);",
    ]);
  });
});
