import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  batchEligibility,
  BatchValidationError,
  validateBatchSelection,
} from "../src/batch.js";
import { claim } from "../src/claim.js";
import { writeRuntime, type AttemptRecord } from "../src/runtime.js";
import type { Task } from "../src/task-file.js";
import type { WorkerConfig } from "../src/worker.js";
import { buildTaskFile } from "./helpers/task-fixture.js";

const base = join(tmpdir(), "taskctl-batch-base");

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
    expect(batchEligibility(a, board, new Set(), base)).toBeNull();
    expect(batchEligibility(b, board, new Set(["a"]), base)).toBeNull();
  });

  it.each([
    ["a non-open status", { status: "done" }, "not open"],
    ["iterative execution", { execution: "iterative" }, "continuous"],
    ["human verification", { verify: "human" }, "mechanical or render"],
    ["high risk", { risk: "high" }, "normal risk"],
    ["a human gate", { humanCheck: true }, "human_check"],
  ] as Array<[string, Partial<Task>, string]>)("rejects %s", (_name, overrides, reason) => {
    const task = eligible("a", overrides);
    expect(batchEligibility(task, [task], new Set(), base)).toContain(reason);
  });

  it("rejects a task below a draft ancestor", () => {
    const parent = eligible("parent", { status: "draft" });
    const child = eligible("child", { parentId: parent.id });
    expect(batchEligibility(child, [child, parent], new Set(), base)).toContain("draft ancestor parent");
  });

  it("requires every dependency to be done or earlier in the selection", () => {
    const a = eligible("a");
    const b = eligible("b", { dependsOn: ["a"] });
    expect(batchEligibility(b, [a, b], new Set(), base)).toContain("dependency a");
    expect(batchEligibility(b, [a, b], new Set(["a"]), base)).toBeNull();
    expect(batchEligibility(b, [{ ...a, status: "done" }, b], new Set(), base)).toBeNull();
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
});
