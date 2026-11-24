import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    "schema: taskctl/v1",
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

  it("a failing review resumes the same worker session with a note and a round", async () => {
    await seed();
    const failReview: ReviewResult = {
      verdict: "fail",
      criteria: [{ id: "C1", pass: false, evidence: "exit 1" }],
      externalChanges: [],
      defects: ["宽度仍写死"],
      summary: "未达 C1",
    };
    const sessions: (string | undefined)[] = [];
    const prompts: string[] = [];
    const worker: AgentAdapter = {
      prompt: async (args) => {
        sessions.push(args.sessionId);
        prompts.push(args.text);
        await mkdir(join(tasks, "a"), { recursive: true });
        await writeFile(join(tasks, "a", "done.requested"), "done");
        return { sessionId: "s", text: "done", exitCode: 0 };
      },
      contextUsage: async () => 0,
      contextLimit: async () => 100,
    };
    const review = vi.fn().mockResolvedValueOnce(failReview).mockResolvedValueOnce(okReview);
    const deps = { store, adapter: worker, acceptance: pass, review };

    expect(await runTask(config(), deps, await store.get("a"), "w1")).toBe("done");
    const task = await store.get("a");
    expect(task.status).toBe("done");
    expect(task.reviewRounds).toBe(1);
    expect(sessions).toEqual([undefined, "s"]);
    expect(prompts[1]).toContain("review-failed");
    expect(prompts[1]).toContain("宽度仍写死");
    expect(review).toHaveBeenCalledTimes(2);
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

  it("a stalled rework (same failing criterion, nothing moved) blocks early", async () => {
    await seed({ criteria: ["C1 ok", "C2 ok"], reviewRounds: 1 });
    // A worker that made no change: C1 still fails, C2 still passes, same as
    // the previous round recorded in review.json below.
    const unchanged: ReviewResult = {
      verdict: "fail",
      criteria: [
        { id: "C1", pass: false, evidence: "exit 1" },
        { id: "C2", pass: true, evidence: "ok" },
      ],
      externalChanges: [],
      defects: ["C1 还是没修"],
      summary: "未达 C1",
    };
    const deps = { store, adapter: adapter(), acceptance: pass, review: verdict(unchanged) };

    // Seed the previous round's review.json so the stall check has something to
    // compare against (the same failing set).
    await mkdir(join(tasks, "a"), { recursive: true });
    const { writeRuntime } = await import("../src/runtime.js");
    await writeRuntime(tasks, "a", "review.json", {
      ...unchanged,
      model: "m",
      tolerate: [],
      definitionDigest: "d",
      at: new Date().toISOString(),
    });

    await runTask(config({ maxReviewRounds: 5 }), deps, await store.get("a"), "w1");
    const task = await store.get("a");
    expect(task.status).toBe("blocked");
    // Not incremented further: the stall is its own terminal, before another round.
    expect(task.reviewRounds).toBe(1);
  });

  it("a progressing rework (a criterion flipped or a new one failed) keeps reworking", async () => {
    await seed({ criteria: ["C1 ok", "C2 ok"], reviewRounds: 1 });
    // The worker fixed C1 but broke C2: criterion set changed, so it's progress
    // (touching new ground), not a stall.
    const flipped: ReviewResult = {
      verdict: "fail",
      criteria: [
        { id: "C1", pass: true, evidence: "ok" },
        { id: "C2", pass: false, evidence: "regression" },
      ],
      externalChanges: [],
      defects: ["C2 新问题"],
      summary: "C2 回升错误",
    };
    const deps = { store, adapter: adapter(), acceptance: pass, review: vi.fn().mockResolvedValueOnce(flipped).mockResolvedValueOnce(okReview) };

    await mkdir(join(tasks, "a"), { recursive: true });
    const { writeRuntime } = await import("../src/runtime.js");
    await writeRuntime(tasks, "a", "review.json", {
      verdict: "fail",
      criteria: [
        { id: "C1", pass: false, evidence: "exit 1" },
        { id: "C2", pass: true, evidence: "ok" },
      ],
      externalChanges: [],
      defects: ["C1 没修"],
      summary: "未达 C1",
      model: "m",
      tolerate: [],
      definitionDigest: "d",
      at: new Date().toISOString(),
    });

    await runTask(config({ maxReviewRounds: 5 }), deps, await store.get("a"), "w1");
    const task = await store.get("a");
    expect(task.status).toBe("done");
    expect(task.reviewRounds).toBe(2);
    expect(deps.review).toHaveBeenCalledTimes(2);
  });
});
