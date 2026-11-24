import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readExecutionState, recordEscalation, recordWorkerSession } from "../src/execution-state.js";
import { retryTask } from "../src/reconcile.js";
import { writeRuntime } from "../src/runtime.js";
import { serializeTaskFile } from "../src/task-file.js";
import { TaskStore } from "../src/task-store.js";
import { buildTaskFile } from "./helpers/task-fixture.js";

let root: string;
let tasks: string;
let work: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "taskctl-execution-state-"));
  tasks = join(root, "tasks");
  work = join(root, "work");
  await mkdir(tasks, { recursive: true });
  await mkdir(work, { recursive: true });
  const task = buildTaskFile({ id: "a", complexity: "simple", execution: "continuous" });
  await writeFile(join(tasks, "a.md"), serializeTaskFile(task), "utf8");
  await mkdir(join(tasks, "a"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("execution state", () => {
  it("derives an absent state and records the latest worker session", async () => {
    expect(await readExecutionState(tasks, "a", "continuous")).toMatchObject({
      requiresReview: false,
      effectiveExecution: "continuous",
      reasons: [],
    });

    await recordWorkerSession(tasks, "a", { sessionId: "ses-one", model: "p/one" });
    await recordWorkerSession(tasks, "a", { sessionId: "ses-two", model: "p/two" });
    expect((await readExecutionState(tasks, "a")).latestWorker).toEqual({ sessionId: "ses-two", model: "p/two" });
  });

  it("keeps escalation sticky and appends reasons", async () => {
    await recordEscalation(tasks, "a", "first turn ended without done");
    await recordEscalation(tasks, "a", "review failed");
    const state = await readExecutionState(tasks, "a");
    expect(state.requiresReview).toBe(true);
    expect(state.effectiveExecution).toBe("iterative");
    expect(state.reasons).toEqual(["first turn ended without done", "review failed"]);
  });

  it("fails safe on corrupt state without offering a session to reuse", async () => {
    await recordWorkerSession(tasks, "a", { sessionId: "ses-old", model: "p/one" });
    await writeFile(join(tasks, "a", "execution-state.json"), "{not json", "utf8");
    const state = await readExecutionState(tasks, "a");
    expect(state.requiresReview).toBe(true);
    expect(state.effectiveExecution).toBe("iterative");
    expect(state.latestWorker).toBeUndefined();
    expect(state.diagnostic).toMatch(/unreadable|invalid/i);
  });

  it("does not archive or reset escalation on an ordinary manual retry", async () => {
    await recordEscalation(tasks, "a", "must stay reviewed");
    const store = new TaskStore(tasks);
    await store.setStatus("a", "blocked");
    await writeRuntime(tasks, "a", "attempt.json", {
      attemptId: "old", backend: "fixture", workspace: work,
      startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      phase: "settled", operation: "finished",
    });

    const result = await retryTask(tasks, "a", { baseWorkdir: work, registryDir: join(root, "registry") });
    expect(result.ok).toBe(true);
    expect((await readExecutionState(tasks, "a")).requiresReview).toBe(true);
    expect((await readExecutionState(tasks, "a")).reasons).toContain("must stay reviewed");
  });
});
