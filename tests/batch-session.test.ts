import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter, PromptResult, SessionReuseStatus } from "../src/adapters/types.js";
import { runBatch, type BatchRunOptions } from "../src/batch.js";
import { runCli } from "../src/cli.js";
import type { Execution } from "../src/execution.js";
import { readExecutionState, recordWorkerSession } from "../src/execution-state.js";
import { readJournal } from "../src/journal.js";
import { readRuntime } from "../src/runtime.js";
import type { Task } from "../src/task-file.js";
import { TaskStore } from "../src/task-store.js";
import { readUsage } from "../src/usage.js";
import { runTask, type WorkerConfig, type WorkerDeps } from "../src/worker.js";
import { buildContinuousTask as task } from "./helpers/task-fixture.js";
import { manualStopNow } from "./helpers/stop-fixture.js";
import {
  doneAdapter, passAcceptance, seedTaskFile, workerConfigFixture, writeBatchConfig,
} from "./helpers/watch-fixture.js";

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
let configPath: string;
let cliLines: string[];
let store: TaskStore;
let cfg: WorkerConfig;
let turns: Turn[];
let probeCalls: Array<{ sessionId: string; expected: { model: string; cwd: string } }>;
let probeStatus: SessionReuseStatus;
let usageTurns: number;

async function seed(...definitions: Task[]): Promise<void> {
  await seedTaskFile(tasks, ...definitions);
}

function adapter(): AgentAdapter {
  return doneAdapter({
    tasksDir: tasks,
    sessionId: (id, args) => args.sessionId ?? (id === "a" ? "ses-shared" : `fresh-${id}`),
    beforeResult: async (args, id) => {
      turns.push({ id, sessionId: args.sessionId, cwd: args.cwd, env: args.env, text: args.text });
    },
    canResumeSession: async (sessionId, expected) => {
      probeCalls.push({ sessionId, expected });
      return probeStatus;
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
  });
}

function deps(agent: AgentAdapter = adapter()): WorkerDeps {
  return {
    store,
    adapter: agent,
    acceptance: passAcceptance,
  };
}

async function cli(ids: string, agent: AgentAdapter = adapter()): Promise<number> {
  return runCli(["run", "--batch", ids, "--config", configPath], {
    adapter: agent,
    acceptance: passAcceptance,
    log: (line) => { cliLines.push(line); },
    err: (line) => { cliLines.push(line); },
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "taskctl-batch-session-"));
  tasks = join(root, "tasks");
  work = join(root, "work");
  await mkdir(tasks);
  await mkdir(work);
  store = new TaskStore(tasks);
  configPath = await writeBatchConfig(root, { tasksDir: tasks, workdir: work });
  cliLines = [];
  cfg = workerConfigFixture({ tasksDir: tasks, workdir: work });
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

    const code = await cli("a,b");

    expect(code).toBe(0);
    expect((await store.get("a")).status).toBe("done");
    expect((await store.get("b")).status).toBe("done");
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

    const code = await cli("a,b");

    expect(code).toBe(0);
    expect((await store.get("b")).status).toBe("done");
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

    const code = await cli("a,b");

    expect(code).toBe(0);
    expect((await store.get("b")).status).toBe("done");
    expect(turns.map((turn) => turn.sessionId)).toEqual([undefined, undefined]);
    expect(probeCalls).toHaveLength(1);
    expect((await readJournal(tasks, "b")).some((entry) => entry.event === "session-reuse-skipped")).toBe(true);
  });

  it("blocks on an active probe and leaves later tasks unclaimed", async () => {
    await seed(task("a"), task("b"), task("c"));
    probeStatus = "active";

    const code = await cli("a,b,c");

    expect(code).toBe(0);
    expect(cliLines.join("\n")).toContain("stopped at b (blocked)");
    expect(cliLines.join("\n")).toContain("unclaimed: c");
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

    const code = await cli("a,b,c");

    expect(code).toBe(0);
    expect(cliLines.join("\n")).toContain("stopped at b (awaiting-human)");
    expect(cliLines.join("\n")).toContain("unclaimed: c");
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

  it("an interrupted batch turn returns its task to open and no later batch continues its session", async () => {
    await seed(task("a"), task("b"), task("c"));
    const stop = manualStopNow();
    let began!: () => void;
    const inFlight = new Promise<void>((resolve) => { began = resolve; });
    const base = adapter();
    const cut: AgentAdapter = {
      ...base,
      start: (args): Execution<PromptResult> => {
        // Only b's turn hangs; it is the turn that continues a's session.
        if (!args.text.includes("当前任务：b")) {
          // A turn that runs to its result like `legacyExecution` does: the
          // state flips to exited when the result settles, so the turn is not
          // judged uncertain — only b's turn is ever cancelled.
          let state: "running" | "exited" = "running";
          const result = base.prompt(args).finally(() => { state = "exited"; });
          return { result, inspect: () => ({ state }), cancel: async () => false, interruptible: false };
        }
        began();
        // `start` replaces the turn `prompt` (and with it this suite's turn
        // record) would have run, so the record is written here: the cut turn
        // shows the session it continued.
        turns.push({ id: "b", sessionId: args.sessionId, cwd: args.cwd, env: args.env, text: args.text });
        let state: "running" | "exited" = "running";
        return { result: new Promise<PromptResult>(() => {}), inspect: () => ({ state, sessionId: args.sessionId ?? "fresh-b" }), cancel: async () => { state = "exited"; return true; } };
      },
    };
    const running = runBatch(cfg, { ...deps(cut), stop }, ["a", "b", "c"]);
    await inFlight;
    stop.trigger("file");
    expect(await running).toEqual({ done: ["a"], stoppedAt: "b", outcome: "stopped", pending: ["c"] });
    expect(await store.get("b")).toMatchObject({ status: "open", retries: 0 });
    expect(await readExecutionState(tasks, "b")).toMatchObject({ latestWorker: { sessionId: "ses-shared", clean: false } });
    // The next batch does not continue what was cut.
    const again = await runBatch(cfg, deps(), ["b", "c"]);
    expect(again.done).toEqual(["b", "c"]);
    expect(turns.filter((turn) => turn.id === "b").map((turn) => turn.sessionId)).toEqual(["ses-shared", undefined]);
  }, 10_000);
});
