import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter, SessionReuseStatus } from "../src/adapters/types.js";
import { runBatch, type BatchRunOptions } from "../src/batch.js";
import { recordWorkerSession } from "../src/execution-state.js";
import { readJournal } from "../src/journal.js";
import { readRuntime } from "../src/runtime.js";
import { serializeTaskFile, type Task } from "../src/task-file.js";
import { TaskStore } from "../src/task-store.js";
import { readUsage } from "../src/usage.js";
import { runTask, type WorkerConfig, type WorkerDeps } from "../src/worker.js";
import { buildTaskFile } from "./helpers/task-fixture.js";

type Turn = {
  id: string;
  sessionId?: string;
  cwd: string;
  env?: Record<string, string>;
  text: string;
};

let root: string;
let tasks: string;
let work: string;
let store: TaskStore;
let cfg: WorkerConfig;
let turns: Turn[];
let probeCalls: Array<{ sessionId: string; expected: { model: string; cwd: string } }>;
let probeStatus: SessionReuseStatus;
let usageTurns: number;

function task(id: string, overrides: Partial<Task> = {}): Task {
  return buildTaskFile({
    id,
    title: id,
    status: "open",
    complexity: "simple",
    execution: "continuous",
    verify: "mechanical",
    acceptance: "check",
    criteria: ["C1 ok"],
    model: "w/one",
    ...overrides,
  });
}

async function seed(...definitions: Task[]): Promise<void> {
  for (const definition of definitions) {
    await writeFile(join(tasks, `${definition.id}.md`), serializeTaskFile(definition), "utf8");
  }
}

function adapter(): AgentAdapter {
  return {
    canResumeSession: async (sessionId, expected) => {
      probeCalls.push({ sessionId, expected });
      return probeStatus;
    },
    prompt: async (args) => {
      const id = /taskctl done --task (\S+) --tasks-dir/.exec(args.text)![1]!;
      turns.push({ id, sessionId: args.sessionId, cwd: args.cwd, env: args.env, text: args.text });
      await mkdir(join(tasks, id), { recursive: true });
      await writeFile(join(tasks, id, "done.requested"), "done");
      return {
        sessionId: args.sessionId ?? (id === "a" ? "ses-shared" : `fresh-${id}`),
        exitCode: 0,
        text: "done",
      };
    },
    sessionUsage: async () => {
      usageTurns++;
      return {
        input: usageTurns === 1 ? 10 : 15,
        output: usageTurns === 1 ? 5 : 9,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
      };
    },
    contextUsage: async () => 0,
    contextLimit: async () => 100,
  };
}

function deps(agent: AgentAdapter = adapter()): WorkerDeps {
  return {
    store,
    adapter: agent,
    acceptance: async () => ({ passed: true, skipped: false as const, exitCode: 0, output: "ok" }),
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "taskctl-batch-session-"));
  tasks = join(root, "tasks");
  work = join(root, "work");
  await mkdir(tasks);
  await mkdir(work);
  store = new TaskStore(tasks);
  cfg = {
    tasksDir: tasks,
    workdir: work,
    agent: "fixture",
    model: "w/one",
    contextThreshold: 0.8,
    retryLimit: 1,
    lockTtlMs: 20_000,
    heartbeatMs: 1_000,
  };
  turns = [];
  probeCalls = [];
  probeStatus = "reusable";
  usageTurns = 0;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("cross-task batch sessions", () => {
  it("uses one safe session while keeping prompts, env, acceptance, sessions, and usage independent", async () => {
    await seed(task("a"), task("b"));

    const result = await runBatch(cfg, deps(), ["a", "b"]);

    expect(result.done).toEqual(["a", "b"]);
    expect(turns.map((turn) => turn.sessionId)).toEqual([undefined, "ses-shared"]);
    expect(probeCalls).toHaveLength(1);
    expect(probeCalls[0]).toEqual({
      sessionId: "ses-shared",
      expected: { model: "w/one", cwd: await realpath(work) },
    });
    expect(turns.map((turn) => turn.id)).toEqual(["a", "b"]);
    expect(turns[0]!.text).toContain("当前任务：a");
    expect(turns[1]!.text).toContain("当前任务：b");
    expect(turns[1]!.text).toContain("前面已完成：a");
    expect(turns[1]!.text).toContain("不要重做");
    for (const turn of turns) {
      expect(turn.env?.TASKCTL_TASK_DIR).toBe(join(tasks, turn.id));
      expect(turn.env?.TASKCTL_LOG_DIR).toBe(join(tasks, turn.id, "logs"));
    }
    expect((await store.get("a")).sessions).toEqual(["ses-shared"]);
    expect((await store.get("b")).sessions).toEqual(["ses-shared"]);
    expect(await readRuntime(tasks, "a", "acceptance.json")).not.toBeNull();
    expect(await readRuntime(tasks, "b", "acceptance.json")).not.toBeNull();
    expect((await readUsage(tasks, "a"))[0]?.delta?.input).toBe(10);
    expect((await readUsage(tasks, "b"))[0]?.delta?.input).toBe(5);
  });

  it("starts fresh after an actual model mismatch and records why", async () => {
    await seed(task("a"), task("b", { model: "w/two" }));

    const result = await runBatch(cfg, deps(), ["a", "b"]);

    expect(result.done).toEqual(["a", "b"]);
    expect(turns.map((turn) => turn.sessionId)).toEqual([undefined, undefined]);
    expect(probeCalls).toEqual([]);
    expect((await store.get("b")).sessions).toEqual(["fresh-b"]);
    const reuse = (await readJournal(tasks, "b")).filter((entry) => entry.event === "session-reuse-skipped");
    expect(reuse).toHaveLength(1);
    expect(reuse[0]!.detail).toContain("w/one");
    expect(reuse[0]!.detail).toContain("w/two");
  });

  it("starts fresh and journals an unavailable probe when the adapter cannot probe sessions", async () => {
    await seed(task("a"), task("b"));
    const probeless = adapter();
    delete probeless.canResumeSession;

    const result = await runBatch(cfg, deps(probeless), ["a", "b"]);

    expect(result.done).toEqual(["a", "b"]);
    expect(turns.map((turn) => turn.sessionId)).toEqual([undefined, undefined]);
    const reuse = (await readJournal(tasks, "b")).filter((entry) => entry.event === "session-reuse-skipped");
    expect(reuse).toHaveLength(1);
    expect(reuse[0]!.detail).toContain("ses-shared");
    expect(reuse[0]!.detail).toContain("unavailable");
  });

  it("starts fresh and journals when the backend reuse state is unavailable", async () => {
    await seed(task("a"), task("b"));
    probeStatus = "unavailable";

    const result = await runBatch(cfg, deps(), ["a", "b"]);

    expect(result.done).toEqual(["a", "b"]);
    expect(turns.map((turn) => turn.sessionId)).toEqual([undefined, undefined]);
    expect(probeCalls).toHaveLength(1);
    expect((await readJournal(tasks, "b")).some((entry) => entry.event === "session-reuse-skipped")).toBe(true);
  });

  it("blocks on an active probe and leaves later tasks unclaimed", async () => {
    await seed(task("a"), task("b"), task("c"));
    probeStatus = "active";

    const result = await runBatch(cfg, deps(), ["a", "b", "c"]);

    expect(result.done).toEqual(["a"]);
    expect(result.stoppedAt).toBe("b");
    expect(result.outcome).toBe("blocked");
    expect(result.pending).toEqual(["c"]);
    expect(turns.map((turn) => turn.id)).toEqual(["a"]);
    expect((await store.get("b")).status).toBe("blocked");
    expect((await store.get("c")).status).toBe("open");
    expect(await readRuntime(tasks, "b", "acceptance.json")).toBeNull();
  });

  it("stops on a real awaiting-human outcome and leaves later tasks unclaimed", async () => {
    await seed(
      task("a"),
      task("b", { quick: true, acceptance: undefined, criteria: [] }),
      task("c"),
    );

    const result = await runBatch(cfg, deps(), ["a", "b", "c"]);

    expect(result.done).toEqual(["a"]);
    expect(result.stoppedAt).toBe("b");
    expect(result.outcome).toBe("awaiting-human");
    expect(result.pending).toEqual(["c"]);
    expect(turns.map((turn) => turn.id)).toEqual(["a", "b"]);
    expect((await store.get("b")).status).toBe("awaiting-human");
    expect((await store.get("c")).status).toBe("open");
  });

  it("does not offer a dirty previous worker fact to the probe", async () => {
    await seed(task("a"), task("b"));
    const run: BatchRunOptions["run"] = async (runCfg, runDeps, current, workerId, options) => {
      const outcome = await runTask(runCfg, runDeps, current, workerId, options);
      if (current.id === "a") {
        await recordWorkerSession(tasks, "a", { sessionId: "ses-shared", model: "w/one", clean: false });
      }
      return outcome;
    };

    const result = await runBatch(cfg, deps(), ["a", "b"], { run });

    expect(result.done).toEqual(["a", "b"]);
    expect(turns.map((turn) => turn.sessionId)).toEqual([undefined, undefined]);
    expect(probeCalls).toEqual([]);
  });

  it("withholds a dirty fact from the next task's batch options", async () => {
    await seed(task("a"), task("b"));
    let resumeFrom: unknown = "not observed";
    const run: BatchRunOptions["run"] = async (runCfg, runDeps, current, workerId, options) => {
      if (current.id === "a") {
        const outcome = await runTask(runCfg, runDeps, current, workerId, options);
        await recordWorkerSession(tasks, "a", { sessionId: "ses-shared", model: "w/one", clean: false });
        return outcome;
      }
      resumeFrom = options?.batch?.resumeFrom;
      return "done";
    };

    await runBatch(cfg, deps(), ["a", "b"], { run });

    expect(resumeFrom).toBeUndefined();
  });

  it("uses the current task's own session on an open retry, not the batch candidate", async () => {
    await seed(task("a"), task("b", { model: "w/two" }));
    let reopened = false;
    const run: BatchRunOptions["run"] = async (runCfg, runDeps, current, workerId, options) => {
      const outcome = await runTask(runCfg, runDeps, current, workerId, options);
      if (current.id === "b" && !reopened) {
        reopened = true;
        await store.setStatus("b", "open");
        return "open";
      }
      return outcome;
    };

    const result = await runBatch(cfg, deps(), ["a", "b"], { run });

    expect(result.done).toEqual(["a", "b"]);
    expect(turns.map((turn) => turn.sessionId)).toEqual([undefined, undefined, "fresh-b"]);
    const reopenedTurns = turns.filter((turn) => turn.id === "b");
    expect(reopenedTurns).toHaveLength(2);
    for (const turn of reopenedTurns) {
      expect(turn.text).toContain("当前任务：b");
      expect(turn.text).toContain("前面已完成：a");
      expect(turn.text).toContain("不要重做");
    }
    expect(probeCalls).toEqual([
      { sessionId: "fresh-b", expected: { model: "w/two", cwd: await realpath(work) } },
    ]);
  });
});
