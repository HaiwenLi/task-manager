import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  batchEligibility,
  BatchValidationError,
  runBatch,
  validateBatchSelection,
  type BatchRunOptions,
} from "../src/batch.js";
import { claim } from "../src/claim.js";
import { newRunContext, processRun, writeModelWait } from "../src/model-wait.js";
import { writeRuntime, type AttemptRecord } from "../src/runtime.js";
import { passBudget } from "../src/scheduler.js";
import type { Task } from "../src/task-file.js";
import type { WorkerConfig, WorkerDeps } from "../src/worker.js";
import { buildTaskFile } from "./helpers/task-fixture.js";

function eligible(id: string, overrides: Partial<Task> = {}): Task {
  return buildTaskFile({
    id,
    complexity: "simple",
    execution: "continuous",
    verify: "mechanical",
    acceptance: "check",
    criteria: ["C1 ok"],
    ...overrides,
  });
}

describe("batchEligibility", () => {
  it("accepts continuous mechanical work with an earlier selected dependency and different models", () => {
    const a = eligible("a", { model: "w/one" });
    const b = eligible("b", { model: "w/two", dependsOn: ["a"] });
    const board = [b, a];
    expect(batchEligibility(a, board, new Set())).toBeNull();
    expect(batchEligibility(b, board, new Set(["a"]))).toBeNull();
  });

  it.each([
    ["a non-open status", { status: "done" }, "not open"],
    ["iterative execution", { execution: "iterative" }, "continuous"],
    ["human verification", { verify: "human" }, "mechanical or render"],
    ["high risk", { risk: "high" }, "normal risk"],
    ["a human gate", { humanCheck: true }, "human_check"],
  ] as Array<[string, Partial<Task>, string]>)("rejects %s", (_name, overrides, reason) => {
    const task = eligible("a", overrides);
    expect(batchEligibility(task, [task], new Set())).toContain(reason);
  });

  it("rejects a task below a draft ancestor", () => {
    const parent = eligible("parent", { status: "draft" });
    const child = eligible("child", { parentId: parent.id });
    expect(batchEligibility(child, [child, parent], new Set())).toContain("draft ancestor parent");
  });

  it("requires every dependency to be done or earlier in the selection", () => {
    const a = eligible("a");
    const b = eligible("b", { dependsOn: ["a"] });
    expect(batchEligibility(b, [a, b], new Set())).toContain("dependency a");
    expect(batchEligibility(b, [a, b], new Set(["a"]))).toBeNull();
    expect(batchEligibility(b, [{ ...a, status: "done" }, b], new Set())).toBeNull();
  });
});

describe("validateBatchSelection", () => {
  let root: string;
  let tasksDir: string;
  let workdir: string;
  let cfg: WorkerConfig;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "taskctl-batch-validation-"));
    tasksDir = join(root, "tasks");
    workdir = join(root, "work");
    await mkdir(tasksDir, { recursive: true });
    await mkdir(workdir, { recursive: true });
    cfg = {
      tasksDir,
      workdir,
      agent: "fixture",
      contextThreshold: 0.8,
      retryLimit: 1,
      lockTtlMs: 5_000,
      heartbeatMs: 50,
    };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns the whole valid selection in exact requested order", async () => {
    const a = eligible("a", { model: "w/one" });
    const b = eligible("b", { model: "w/two" });
    const selected = await validateBatchSelection(cfg, ["b", "a"], [a, b]);
    expect(selected.map((task) => task.id)).toEqual(["b", "a"]);
  });

  it("rejects an empty selection", async () => {
    await expect(validateBatchSelection(cfg, [], [eligible("a")])).rejects.toThrow("no tasks");
  });

  it("collects empty, duplicate, and unknown ids instead of stopping at the first", async () => {
    const error = await validateBatchSelection(cfg, ["", "a", "a", "missing"], [eligible("a")])
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BatchValidationError);
    const issues = (error as BatchValidationError).issues.join("\n");
    expect(issues).toContain("empty task id");
    expect(issues).toContain("duplicate task a");
    expect(issues).toContain("unknown task missing");
  });

  it("rejects mixed resolved workdirs", async () => {
    const a = eligible("a");
    const b = eligible("b", { workdir: "elsewhere" });
    const error = await validateBatchSelection(cfg, ["a", "b"], [a, b])
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BatchValidationError);
    expect((error as BatchValidationError).issues.join("\n")).toContain("workdir");
  });

  it("rejects a live lock without trying to steal it", async () => {
    const a = eligible("a");
    expect(await claim(tasksDir, a.id, "another-owner", cfg.lockTtlMs)).toBe(true);
    const error = await validateBatchSelection(cfg, ["a"], [a]).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BatchValidationError);
    expect((error as BatchValidationError).issues.join("\n")).toContain("live lock");
  });

  it.each(["active", "uncertain"] as const)("rejects a previous %s attempt", async (phase) => {
    const a = eligible("a");
    await mkdir(join(tasksDir, a.id), { recursive: true });
    const attempt: AttemptRecord = {
      attemptId: "old",
      backend: "fixture",
      workspace: workdir,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      phase,
      operation: "worker",
    };
    await writeRuntime(tasksDir, a.id, "attempt.json", attempt);
    const error = await validateBatchSelection(cfg, ["a"], [a]).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BatchValidationError);
    expect((error as BatchValidationError).issues.join("\n")).toContain("not settled");
  });

  it("allows a settled previous attempt", async () => {
    const a = eligible("a");
    await mkdir(join(tasksDir, a.id), { recursive: true });
    const attempt: AttemptRecord = {
      attemptId: "old",
      backend: "fixture",
      workspace: workdir,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      phase: "settled",
      operation: "finished",
    };
    await writeRuntime(tasksDir, a.id, "attempt.json", attempt);
    await expect(validateBatchSelection(cfg, ["a"], [a])).resolves.toEqual([a]);
  });

  it("refuses a selection that names a deferred task before any claim", async () => {
    const run = newRunContext();
    cfg.run = run;
    const nextAt = new Date(Date.now() + 60_000).toISOString();
    await mkdir(join(tasksDir, "a"), { recursive: true });
    await writeModelWait(tasksDir, "a", {
      runId: run.id, stage: "worker", rounds: 1, firstRefusedAt: new Date().toISOString(), refusals: [],
      nextAt, updatedAt: new Date().toISOString(),
    });
    const a = eligible("a");
    const b = eligible("b");

    const error = await validateBatchSelection(cfg, ["a", "b"], [a, b]).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BatchValidationError);
    expect((error as BatchValidationError).issues.join("\n")).toBe(`task a: deferred until ${nextAt} (round 1)`);
  });

  it("refuses a selection that names a task whose rounds this run has spent", async () => {
    const run = newRunContext();
    cfg.run = run;
    const now = new Date().toISOString();
    await mkdir(join(tasksDir, "a"), { recursive: true });
    await writeModelWait(tasksDir, "a", {
      runId: run.id, stage: "worker", rounds: 4, firstRefusedAt: now, refusals: [], nextAt: now, updatedAt: now,
    });

    const error = await validateBatchSelection(cfg, ["a"], [eligible("a")]).catch((caught: unknown) => caught);

    expect((error as BatchValidationError).issues.join("\n")).toBe("task a: its model rounds are spent for the running controller");
  });
});

describe("runBatch", () => {
  let root: string;
  let tasksDir: string;
  let workdir: string;
  let cfg: WorkerConfig;
  let board: Task[];
  let deps: WorkerDeps;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "taskctl-batch-run-"));
    tasksDir = join(root, "tasks");
    workdir = join(root, "work");
    await mkdir(tasksDir, { recursive: true });
    await mkdir(workdir, { recursive: true });
    cfg = {
      tasksDir,
      workdir,
      agent: "fixture",
      contextThreshold: 0.8,
      retryLimit: 1,
      lockTtlMs: 5_000,
      heartbeatMs: 50,
    };
    board = [];
    deps = {
      store: { list: async () => board } as WorkerDeps["store"],
      adapter: {
        prompt: async () => { throw new Error("the run seam must replace the adapter"); },
        contextUsage: async () => 0,
        contextLimit: async () => 100,
      },
    };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("runs exactly the requested order and never offers an unselected task", async () => {
    const a = eligible("a");
    const b = eligible("b");
    const c = eligible("c");
    board = [b, c, a];
    const calls: string[] = [];
    const run: BatchRunOptions["run"] = async (_cfg, _deps, task) => {
      calls.push(task.id);
      return "done";
    };
    const result = await runBatch(cfg, deps, ["a", "b"], { run });
    expect(calls).toEqual(["a", "b"]);
    expect(result).toEqual({ done: ["a", "b"], stoppedAt: undefined, outcome: undefined, pending: [] });
  });

  it("validates the entire selection before the first runner call", async () => {
    board = [eligible("a"), eligible("b", { execution: "iterative" })];
    const run = async () => {
      throw new Error("must not run");
    };
    await expect(runBatch(cfg, deps, ["a", "b"], { run })).rejects.toThrow("continuous");
  });

  it.each(["blocked", "awaiting-human", "skipped"] as const)("stops on %s and leaves later ids unclaimed", async (outcome) => {
    board = [eligible("a"), eligible("b"), eligible("c")];
    const calls: string[] = [];
    const run: BatchRunOptions["run"] = async (_cfg, _deps, task) => {
      calls.push(task.id);
      return outcome;
    };
    const result = await runBatch(cfg, deps, ["a", "b", "c"], { run });
    expect(calls).toEqual(["a"]);
    expect(result.done).toEqual([]);
    expect(result.stoppedAt).toBe("a");
    expect(result.outcome).toBe(outcome);
    expect(result.pending).toEqual(["b", "c"]);
  });

  it("finishes the current open retry before claiming the next task", async () => {
    board = [eligible("a"), eligible("b")];
    const calls: string[] = [];
    let attempts = 0;
    const run: BatchRunOptions["run"] = async (_cfg, _deps, task) => {
      calls.push(task.id);
      if (task.id === "a" && attempts++ === 0) return "open";
      return "done";
    };
    const result = await runBatch(cfg, deps, ["a", "b"], { run });
    expect(calls).toEqual(["a", "a", "b"]);
    expect(result.done).toEqual(["a", "b"]);
  });

  it("bounds an open loop and does not move on to the next task", async () => {
    board = [eligible("a"), eligible("b")];
    const calls: string[] = [];
    const run: BatchRunOptions["run"] = async (_cfg, _deps, task) => {
      calls.push(task.id);
      return "open";
    };
    const result = await runBatch(cfg, deps, ["a", "b"], { run });
    expect(calls).toHaveLength(passBudget(1, cfg));
    expect(result.stoppedAt).toBe("a");
    expect(result.outcome).toBe("open");
    expect(result.pending).toEqual(["b"]);
  });

  it.each(["delete", "definition", "workdir"] as const)("rejects a mid-batch %s change before claim", async (change) => {
    const a = eligible("a");
    const b = eligible("b");
    const c = eligible("c");
    board = [a, b, c];
    const calls: string[] = [];
    const run: BatchRunOptions["run"] = async (_cfg, _deps, task) => {
      calls.push(task.id);
      if (change === "delete") board = [a, c];
      if (change === "definition") board = [a, { ...b, title: "edited" }, c];
      if (change === "workdir") board = [a, { ...b, workdir: "elsewhere" }, c];
      return "done";
    };
    await expect(runBatch(cfg, deps, ["a", "b", "c"], { run })).rejects.toThrow(BatchValidationError);
    expect(calls).toEqual(["a"]);
  });

  it("revalidates the definition before an open retry of the same task", async () => {
    const a = eligible("a");
    const b = eligible("b");
    board = [a, b];
    const calls: string[] = [];
    const run: BatchRunOptions["run"] = async (_cfg, _deps, task) => {
      calls.push(task.id);
      board = [{ ...a, title: "edited during review" }, b];
      return "open";
    };
    await expect(runBatch(cfg, deps, ["a", "b"], { run })).rejects.toThrow(BatchValidationError);
    expect(calls).toEqual(["a"]);
  });

  it("honors a stop request between attempts without claiming the next task", async () => {
    board = [eligible("a"), eligible("b"), eligible("c")];
    const calls: string[] = [];
    let stopped = false;
    const run: BatchRunOptions["run"] = async (_cfg, _deps, task) => {
      calls.push(task.id);
      stopped = true;
      return "done";
    };
    const result = await runBatch(cfg, deps, ["a", "b", "c"], {
      run,
      shouldStop: async () => stopped,
    });
    expect(calls).toEqual(["a"]);
    expect(result).toEqual({ done: ["a"], stoppedAt: "b", outcome: "stop-requested", pending: ["b", "c"] });
  });

  it("stops on a deferred current task and says when it may run again", async () => {
    board = [eligible("a"), eligible("b")];
    const calls: string[] = [];
    const nextAt = new Date(Date.now() + 60_000).toISOString();

    const result = await runBatch(cfg, deps, ["a", "b"], {
      run: async (_cfg, _deps, task) => {
        calls.push(task.id);
        if (task.id === "a") {
          const now = new Date().toISOString();
          await mkdir(join(tasksDir, "a"), { recursive: true });
          await writeModelWait(tasksDir, "a", {
            runId: processRun().id, stage: "worker", rounds: 1, firstRefusedAt: null, refusals: [],
            nextAt, updatedAt: now,
          });
          return "open";
        }
        return "done";
      },
    });

    expect(calls).toEqual(["a"]);
    expect(result).toEqual({ done: [], stoppedAt: "a", outcome: "open", pending: ["a", "b"], deferredUntil: nextAt });
  });

  it("stops on an outage with that outcome and leaves the rest unclaimed", async () => {
    board = [eligible("a"), eligible("b"), eligible("c")];
    const calls: string[] = [];
    const run = newRunContext();
    cfg.run = run;

    const result = await runBatch(cfg, deps, ["a", "b", "c"], {
      run: async (_cfg, _deps, task) => {
        calls.push(task.id);
        if (task.id === "a") {
          const now = new Date().toISOString();
          await mkdir(join(tasksDir, "a"), { recursive: true });
          await writeModelWait(tasksDir, "a", {
            runId: run.id, stage: "worker", rounds: 4, firstRefusedAt: now, refusals: [], nextAt: now, updatedAt: now,
          });
          return "open"; // the attempt that ran out of rounds decides nothing
        }
        return "done";
      },
    });

    expect(calls).toEqual(["a"]);
    expect(result).toEqual({ done: [], stoppedAt: "a", outcome: "outage", pending: ["b", "c"] });
  });
});
