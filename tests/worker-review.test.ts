import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "../src/task-store.js";
import { runTask, type WorkerConfig } from "../src/worker.js";
import type { AgentAdapter } from "../src/adapters/types.js";
import { latestNote } from "../src/handoff.js";
import type { ReviewResult } from "../src/review.js";

let root: string;
let tasks: string;
let cwd: string;
let store: TaskStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "taskctl-review-"));
  tasks = join(root, "tasks");
  cwd = join(root, "work");
  await mkdir(tasks);
  await mkdir(cwd);
  store = new TaskStore(tasks);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

type SeedOptions = {
  criteria?: string[];
  risk?: "normal" | "high";
  humanCheck?: boolean;
  reviewRounds?: number;
};

async function seed(options: SeedOptions = {}): Promise<void> {
  const criteria = options.criteria ?? ["C1 ok"];
  const lines = [
    "---",
    "title: Review task",
    "status: open",
    'acceptance: "check"',
    ...(criteria.length > 0 ? ["criteria:", ...criteria.map((criterion) => `  - ${criterion}`)] : []),
    ...(options.risk === "high" ? ["risk: high"] : []),
    ...(options.humanCheck ? ["human_check: true"] : []),
    `review_rounds: ${options.reviewRounds ?? 0}`,
    "sessions: []",
    "retries: 0",
    "---",
    "Do work",
    "",
  ];
  await writeFile(join(tasks, "a.md"), lines.join("\n"), "utf8");
}

function config(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    tasksDir: tasks,
    workdir: cwd,
    agent: "fixture",
    contextThreshold: 0.8,
    retryLimit: 2,
    lockTtlMs: 5_000,
    heartbeatMs: 50,
    ...overrides,
  };
}

/** A turn that requests completion; the worker then polls `done.requested`. */
function adapter(): AgentAdapter {
  return {
    prompt: async () => {
      await mkdir(join(tasks, "a"), { recursive: true });
      await writeFile(join(tasks, "a", "done.requested"), "done");
      return { sessionId: "s", text: "done", exitCode: 0 };
    },
    contextUsage: async () => 0,
    contextLimit: async () => 100,
  };
}

const pass = async () => ({ passed: true, skipped: false as const, exitCode: 0, output: "observed" });

const verdict = (result: ReviewResult) => async () => result;

const okReview: ReviewResult = {
  verdict: "pass",
  criteria: [{ id: "C1", pass: true, evidence: "ok" }],
  externalChanges: [],
  defects: [],
  summary: "ok",
};

describe("worker review stage", () => {
  it("a passing review finishes the task", async () => {
    await seed();
    const deps = { store, adapter: adapter(), acceptance: pass, review: verdict(okReview) };
    await runTask(config(), deps, await store.get("a"), "w1");
    expect((await store.get("a")).status).toBe("done");
  });

  it("a failing review sends the task back to open with a note and a round", async () => {
    await seed();
    const failReview: ReviewResult = {
      verdict: "fail",
      criteria: [{ id: "C1", pass: false, evidence: "exit 1" }],
      externalChanges: [],
      defects: ["宽度仍写死"],
      summary: "未达 C1",
    };
    const deps = { store, adapter: adapter(), acceptance: pass, review: verdict(failReview) };
    await runTask(config(), deps, await store.get("a"), "w1");
    const task = await store.get("a");
    expect(task.status).toBe("open");
    expect(task.reviewRounds).toBe(1);
    const note = await latestNote(tasks, "a");
    expect(note?.markdown).toContain("review-failed");
    expect(note?.markdown).toContain("宽度仍写死");
  });

  it("a task without criteria never reaches done on its own", async () => {
    await seed({ criteria: [] });
    const deps = { store, adapter: adapter(), acceptance: pass, review: verdict(okReview) };
    await runTask(config(), deps, await store.get("a"), "w1");
    expect((await store.get("a")).status).toBe("awaiting-human");
  });

  it("a passing review on a high-risk task stops at awaiting-human", async () => {
    await seed({ risk: "high" });
    const deps = { store, adapter: adapter(), acceptance: pass, review: verdict(okReview) };
    await runTask(config(), deps, await store.get("a"), "w1");
    expect((await store.get("a")).status).toBe("awaiting-human");
  });

  it("an unclear verdict goes to awaiting-human instead of retrying", async () => {
    await seed();
    const unclear: ReviewResult = { verdict: "unclear", criteria: [], externalChanges: [], defects: [], summary: "证据不足" };
    const deps = { store, adapter: adapter(), acceptance: pass, review: verdict(unclear) };
    await runTask(config(), deps, await store.get("a"), "w1");
    expect((await store.get("a")).status).toBe("awaiting-human");
  });

  it("exceeding maxReviewRounds blocks the task", async () => {
    await seed({ reviewRounds: 2 });
    const failReview: ReviewResult = {
      verdict: "fail",
      criteria: [{ id: "C1", pass: false, evidence: "x" }],
      externalChanges: [],
      defects: [],
      summary: "未达",
    };
    const deps = { store, adapter: adapter(), acceptance: pass, review: verdict(failReview) };
    await runTask(config({ maxReviewRounds: 2 }), deps, await store.get("a"), "w1");
    expect((await store.get("a")).status).toBe("blocked");
  });
});
