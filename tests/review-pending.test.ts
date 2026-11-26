import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.js";
import { latestNote } from "../src/handoff.js";
import { readJournal } from "../src/journal.js";
import { noteModelRefusal } from "../src/model-cooldown.js";
import { readModelWait } from "../src/model-wait.js";
import { readAttempt, readRuntime } from "../src/runtime.js";
import { runTask, type WorkerConfig, type WorkerDeps } from "../src/worker.js";
import type { AgentAdapter, PromptResult } from "../src/adapters/types.js";
import type { Execution } from "../src/execution.js";
import type { ReviewEvidence, ReviewResult } from "../src/review.js";
import { TaskStore } from "../src/task-store.js";
import { doneAdapter } from "./helpers/watch-fixture.js";

let root: string;
let tasks: string;
let work: string;
let store: TaskStore;

const providerRefusal: ReviewResult = {
  verdict: "unclear", criteria: [], externalChanges: [], defects: [],
  summary: "provider quota refused", failure: "provider",
};
const passVerdict: ReviewResult = {
  verdict: "pass", criteria: [{ id: "C1", pass: true, evidence: "acceptance passed" }],
  externalChanges: [], defects: [], summary: "ok",
};
const pass = async () => ({ passed: true, skipped: false as const, exitCode: 0, output: "observed" });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "taskctl-review-pending-"));
  tasks = join(root, "tasks");
  work = join(root, "work");
  await mkdir(tasks);
  await mkdir(work);
  store = new TaskStore(tasks);
  await writeFile(join(tasks, "a.md"), [
    "---", "schema: taskctl/v1", "title: Review later", "status: open",
    'acceptance: "check"', "criteria:", "  - C1 work is good",
    "sessions: []", "retries: 0", "review_rounds: 0", "---", "Do work", "",
  ].join("\n"), "utf8");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function config(): WorkerConfig {
  return {
    tasksDir: tasks, workdir: work, agent: "opencode", reviewerModel: "r/one",
    contextThreshold: 0.8, retryLimit: 2, lockTtlMs: 5_000, heartbeatMs: 50,
    // Rounds run back to back in these tests; the window must not hold the next attempt.
    modelCooldownMs: 0,
  };
}

function workerAdapter(calls: string[]): AgentAdapter {
  return {
    prompt: async () => {
      calls.push("worker");
      await mkdir(join(tasks, "a"), { recursive: true });
      await writeFile(join(tasks, "a", "done.requested"), "done");
      return { sessionId: "worker-session", text: "done", exitCode: 0 };
    },
    contextUsage: async () => 0,
    contextLimit: async () => 100,
  };
}

async function park(calls: string[], acceptance = vi.fn(pass)) {
  const deps: WorkerDeps = {
    store, adapter: workerAdapter(calls), acceptance,
    review: async () => providerRefusal,
  };
  const outcome = await runTask(config(), deps, await store.get("a"), "w1");
  return { outcome, deps };
}

/**
 * A backend whose worker turns answer at once and whose review turn never
 * ends on its own, but stops when asked (copied from the fault-isolation
 * suite): the shape of a reviewer that hits the turn timeout while its
 * shutdown stays confirmable.
 */
function slowReviewer(): AgentAdapter {
  const worker = doneAdapter({ tasksDir: tasks, sessionId: (id) => `s-${id}` });
  return {
    ...worker,
    start: (args): Execution<PromptResult> => {
      let state: "running" | "exited" = "running";
      if (!args.text.includes("独立复核者")) {
        const result = worker.prompt(args).finally(() => { state = "exited"; });
        return { result, inspect: () => ({ state }), cancel: async () => false };
      }
      return {
        result: new Promise<PromptResult>(() => {}),
        inspect: () => ({ state }),
        cancel: async () => { state = "exited"; return true; },
      };
    },
  };
}

describe("review-pending recovery", () => {
  it("preserves work through provider exhaustion and recovers by itself through `taskctl run`", async () => {
    const calls: string[] = [];
    const acceptance = vi.fn(pass);
    const parked = await park(calls, acceptance);
    expect(parked.outcome).toBe("open");
    expect(calls).toEqual(["worker"]);
    expect(acceptance).toHaveBeenCalledTimes(1);
    expect((await store.get("a")).retries).toBe(0);
    expect(await readRuntime(tasks, "a", "review-pending.json")).toMatchObject({ definitionDigest: expect.any(String) });

    const configPath = join(root, "taskctl.json");
    await writeFile(configPath, JSON.stringify({ tasksDir: tasks, workdir: work, reviewerModel: "r/two" }), "utf8");
    const review = vi.fn(async () => passVerdict);
    const code = await runCli(["run", "--config", configPath], {
      adapter: workerAdapter(calls), acceptance, review, log: () => {},
    });

    expect(code).toBe(0);
    expect(review).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["worker"]);
    expect(acceptance).toHaveBeenCalledTimes(1);
    expect((await store.get("a")).status).toBe("done");
    expect(await readRuntime(tasks, "a", "review-pending.json")).toBeNull();

    // One park, one recovery, and neither is a rework round: the worker and
    // the acceptance gate still ran exactly once each. A refused review no
    // longer parks, so nothing is preserved by a park — the deferral keeps it.
    const lines: string[] = [];
    expect(await runCli(["metrics", "--tasks-dir", tasks], { log: (line) => lines.push(line) })).toBe(0);
    const metrics = lines.join("\n");
    expect(metrics).toMatch(/复核保留\s+0/);
    expect(metrics).toMatch(/只复核恢复\s+1/);
    expect(metrics).toMatch(/自动返工\s+0 个任务/);
    expect(metrics).toMatch(/首轮通过率\s+100%\s+\(1\/1\)/);
  });

  it("recovers a task that declares its own workdir without refusing it as changed", async () => {
    // 调度器、watch、批次都先把任务的 workdir 解析成实际目录；只复核的恢复也必须这样做，
    // 否则针对另一个目录重算摘要，恢复永远被拒，而 reconcile 还在推荐它。
    const calls: string[] = [];
    const sub = join(work, "sub");
    await mkdir(sub, { recursive: true });
    await writeFile(join(sub, "out.txt"), "the work product", "utf8");
    const file = join(tasks, "a.md");
    await writeFile(file, (await readFile(file, "utf8")).replace('acceptance: "check"', 'acceptance: "check"\nworkdir: sub'), "utf8");
    const parked = await runTask({ ...config(), workdir: sub }, {
      store, adapter: workerAdapter(calls), acceptance: pass, review: async () => providerRefusal,
    }, await store.get("a"), "w1");
    expect(parked).toBe("open");

    const configPath = join(root, "taskctl.json");
    await writeFile(configPath, JSON.stringify({ tasksDir: tasks, workdir: work, reviewerModel: "r/two" }), "utf8");
    const review = vi.fn(async () => passVerdict);
    const errors: string[] = [];
    const code = await runCli(["run", "--config", configPath], {
      adapter: workerAdapter(calls), acceptance: pass, review, log: () => {}, err: (line) => { errors.push(line); },
    });

    expect(code, errors.join("\n")).toBe(0);
    expect(review).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["worker"]);
    expect((await store.get("a")).status).toBe("done");
    // Recovery is an entry point like run and watch: it leaves the same per-task event log.
    const logs = (await readdir(join(tasks, "a", "logs"))).filter((name) => /^run-.+\.log$/.test(name));
    expect(logs).toHaveLength(1);
    expect(await readFile(join(tasks, "a", "logs", logs[0]!), "utf8")).toContain("[a] done");
  });

  it("names the cooling reviewer model in the preserved record", async () => {
    await noteModelRefusal(tasks, "r/one", { reason: "another task saw a 429", cooldownMs: 600_000 });
    const calls: string[] = [];
    const review = vi.fn(async () => passVerdict);

    const outcome = await runTask(config(), { store, adapter: workerAdapter(calls), acceptance: pass, review }, await store.get("a"), "w1");

    expect(outcome).toBe("open");
    expect(review).not.toHaveBeenCalled();
    expect(await readRuntime<{ refusals: Array<{ model: string }> }>(tasks, "a", "review-pending.json"))
      .toMatchObject({ refusals: [{ model: "r/one" }] });
    expect(await readModelWait(tasks, "a")).toMatchObject({ stage: "review", rounds: 0 });
  });

  it("rejects review-only recovery when the artifact changed", async () => {
    const calls: string[] = [];
    await park(calls);
    await writeFile(join(work, "changed.txt"), "new artifact", "utf8");
    const review = vi.fn(async () => passVerdict);

    const outcome = await runTask(config(), {
      store, adapter: workerAdapter(calls), acceptance: pass, review,
    }, await store.get("a"), "review-only");

    expect(outcome).toBe("blocked");
    expect(review).not.toHaveBeenCalled();
    expect(calls).toEqual(["worker"]);
  });

  describe("the configuration file inside the work directory", () => {
    // The usual layout — `taskctl.json` in the project root, the root being the work
    // directory. The file is the controller's input, not an artifact of the work: neither the
    // digest taken around an acceptance command nor the one a review recovery is gated on may
    // count it (found live, 2026-11-26: the recovery was refused as "artifacts changed" for the
    // configuration edit the outage report itself advises).
    const roots: string[] = [];
    afterEach(async () => {
      for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
    });

    async function layout(task: string[], settings: Record<string, unknown> = {}) {
      const root = await mkdtemp(join(tmpdir(), "taskctl-review-pending-config-"));
      roots.push(root);
      const tasksDir = join(root, "tasks");
      await mkdir(tasksDir);
      await writeFile(join(tasksDir, "a.md"), [
        "---", "schema: taskctl/v1", "title: Review later", "status: open", ...task,
        "sessions: []", "retries: 0", "review_rounds: 0", "---", "Do work", "",
      ].join("\n"), "utf8");
      const configPath = join(root, "taskctl.json");
      const write = (more: Record<string, unknown>) =>
        writeFile(configPath, JSON.stringify({ tasksDir, workdir: root, ...settings, ...more }), "utf8");
      const worker = (calls: string[]) => doneAdapter({
        tasksDir, sessionId: () => "worker-session", beforeResult: async () => { calls.push("worker"); },
      });
      return { board: new TaskStore(tasksDir), configPath, write, worker };
    }

    const WITH_COMMAND = ['acceptance: "check"', "criteria:", "  - C1 work is good"];
    const NO_COMMAND = ["criteria:", "  - C1 work is good"];
    /** One refused round is an outage: the run stops with the review preserved. */
    const ONE_ROUND = { modelRounds: 1, modelCooldownMs: 20 };

    async function refuseThenRecover(
      board: TaskStore, configPath: string,
      write: (more: Record<string, unknown>) => Promise<void>,
      worker: (calls: string[]) => AgentAdapter,
    ) {
      const calls: string[] = [];
      const acceptance = vi.fn(pass);
      expect(await runCli(["run", "--config", configPath], {
        adapter: worker(calls), acceptance, review: async () => providerRefusal, log: () => {},
      })).toBe(3);
      expect((await board.get("a")).status).toBe("open");

      await write({ reviewerModel: "r/two" }); // what the outage report advises
      const review = vi.fn(async () => passVerdict);
      const code = await runCli(["run", "--config", configPath], {
        adapter: worker(calls), acceptance, review, log: () => {},
      });
      return { code, review, calls, acceptance };
    }

    it("does not send a mechanical task to review because of it", async () => {
      const { board, configPath, write, worker } = await layout(['acceptance: "check"', "verify: mechanical"]);
      await write({});
      const calls: string[] = [];

      expect(await runCli(["run", "--config", configPath], {
        adapter: worker(calls), acceptance: pass, log: () => {},
      })).toBe(0);

      expect(calls).toEqual(["worker"]);
      expect((await board.get("a")).status).toBe("done");
    });

    it("is not a changed artifact for a review that recovers by itself", async () => {
      const { board, configPath, write, worker } = await layout(WITH_COMMAND, { reviewerModel: "r/one", ...ONE_ROUND });
      await write({});

      const { code, review, calls, acceptance } = await refuseThenRecover(board, configPath, write, worker);

      expect(code).toBe(0);
      expect(review).toHaveBeenCalledTimes(1);
      expect(calls).toEqual(["worker"]);
      expect(acceptance).toHaveBeenCalledTimes(1);
      expect((await board.get("a")).status).toBe("done");
    });

    it("is not one for a task with no acceptance command either, where the preserved record takes the digest itself", async () => {
      const { board, configPath, write, worker } = await layout(NO_COMMAND, { reviewerModel: "r/one", ...ONE_ROUND });
      await write({});

      const { code, review, calls } = await refuseThenRecover(board, configPath, write, worker);

      expect(code).toBe(0);
      expect(review).toHaveBeenCalledTimes(1);
      expect(calls).toEqual(["worker"]);
      expect((await board.get("a")).status).toBe("done");
    });
  });

  it("rejects review-only recovery when the definition changed", async () => {
    const calls: string[] = [];
    await park(calls);
    const file = join(tasks, "a.md");
    await writeFile(file, (await readFile(file, "utf8")).replace("C1 work is good", "C1 loosen the bar"), "utf8");
    const review = vi.fn(async () => passVerdict);

    const outcome = await runTask(config(), {
      store, adapter: workerAdapter(calls), acceptance: pass, review,
    }, await store.get("a"), "review-only");

    expect(outcome).toBe("blocked");
    expect(review).not.toHaveBeenCalled();
    expect(calls).toEqual(["worker"]);
  });

  it("opens real review rework without invoking the worker during review-only recovery", async () => {
    const calls: string[] = [];
    await park(calls);
    const failVerdict: ReviewResult = {
      verdict: "fail", criteria: [{ id: "C1", pass: false, evidence: "wrong artifact" }],
      externalChanges: [], defects: ["fix the artifact"], summary: "not good",
    };

    const outcome = await runTask({ ...config(), reviewerModel: "r/two" }, {
      store, adapter: workerAdapter(calls), acceptance: pass, review: async () => failVerdict,
    }, await store.get("a"), "review-only");

    expect(outcome).toBe("open");
    expect(calls).toEqual(["worker"]);
    expect((await store.get("a")).status).toBe("open");
    expect((await latestNote(tasks, "a"))?.markdown).toContain("review-failed");
    expect(await readRuntime(tasks, "a", "review-pending.json")).toBeNull();
  });

  it("shows the reviewer the window of the attempt that produced the evidence, not of the recovery", async () => {
    // 只复核的恢复是另一次、更晚的尝试。时间窗是评审员区分「任务改的」和「外部漂移」的唯一依据；
    // 给它恢复尝试自己的窗口，等于说全部产出都发生在执行开始之前。
    const calls: string[] = [];
    expect((await park(calls)).outcome).toBe("open");
    const pending = await readRuntime<{ window?: { startedAt: string; finishedAt: string } }>(tasks, "a", "review-pending.json");
    expect(pending?.window).toEqual({ startedAt: (await readAttempt(tasks, "a"))?.startedAt, finishedAt: expect.any(String) });

    const windows: Array<{ startedAt: string; finishedAt: string } | undefined> = [];
    const review = vi.fn(async (evidence: ReviewEvidence) => {
      windows.push(evidence.window);
      return passVerdict;
    });
    const outcome = await runTask({ ...config(), reviewerModel: "r/two" }, {
      store, adapter: workerAdapter(calls), acceptance: pass, review,
    }, await store.get("a"), "review-only");

    expect(outcome).toBe("done");
    expect(windows).toEqual([pending?.window]);
  });

  it("keeps the first window when a recovery is deferred again", async () => {
    const calls: string[] = [];
    expect((await park(calls)).outcome).toBe("open");
    const first = (await readRuntime<{ window?: unknown }>(tasks, "a", "review-pending.json"))?.window;
    expect(first).toEqual({ startedAt: expect.any(String), finishedAt: expect.any(String) });

    const outcome = await runTask({ ...config(), reviewerModel: "r/two" }, {
      store, adapter: workerAdapter(calls), acceptance: pass, review: async () => providerRefusal,
    }, await store.get("a"), "w2");

    expect(outcome).toBe("open");
    const again = await readRuntime<{ window?: unknown; refusals: unknown[] }>(tasks, "a", "review-pending.json");
    expect(again?.refusals).toHaveLength(2);
    expect(again?.window).toEqual(first);
  });

  it("shows the reviewer the window of the attempt whose work it reviews", async () => {
    const windows: Array<{ startedAt: string; finishedAt: string } | undefined> = [];
    const review = vi.fn(async (evidence: ReviewEvidence) => {
      windows.push(evidence.window);
      return passVerdict;
    });
    const calledBefore = new Date().toISOString();

    expect(await runTask(config(), { store, adapter: workerAdapter([]), acceptance: pass, review }, await store.get("a"), "w1")).toBe("done");

    expect(windows).toHaveLength(1);
    expect(windows[0]?.startedAt).toBe((await readAttempt(tasks, "a"))?.startedAt);
    expect(Date.parse(windows[0]!.startedAt)).toBeGreaterThanOrEqual(Date.parse(calledBefore));
  });

  it("a parked review is still recovered by `taskctl retry --review-only`", async () => {
    // A reviewer that runs out of time still parks today: the manual path stays covered.
    const calls: string[] = [];
    const outcome = await runTask({ ...config(), turnTimeoutMs: 300 }, {
      store, adapter: slowReviewer(), acceptance: pass,
    }, await store.get("a"), "w1");

    expect(outcome).toBe("blocked");
    expect(await readRuntime(tasks, "a", "review-pending.json")).not.toBeNull();
    expect((await readJournal(tasks, "a")).some((line) => line.event === "review-pending" && /timed out/.test(line.detail)))
      .toBe(true);

    const configPath = join(root, "taskctl.json");
    await writeFile(configPath, JSON.stringify({ tasksDir: tasks, workdir: work, reviewerModel: "r/two" }), "utf8");
    const review = vi.fn(async () => passVerdict);
    const code = await runCli(["retry", "--task", "a", "--review-only", "--config", configPath], {
      adapter: workerAdapter(calls), acceptance: pass, review, log: () => {},
    });

    expect(code).toBe(0);
    expect((await store.get("a")).status).toBe("done");
  });
});
