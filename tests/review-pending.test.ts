import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.js";
import { latestNote } from "../src/handoff.js";
import { readRuntime } from "../src/runtime.js";
import { runTask, type WorkerConfig, type WorkerDeps } from "../src/worker.js";
import type { AgentAdapter } from "../src/adapters/types.js";
import type { ReviewResult } from "../src/review.js";
import { TaskStore } from "../src/task-store.js";

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

describe("review-pending recovery", () => {
  it("preserves work through provider exhaustion and CLI review-only retry", async () => {
    const calls: string[] = [];
    const acceptance = vi.fn(pass);
    const parked = await park(calls, acceptance);
    expect(parked.outcome).toBe("blocked");
    expect(calls).toEqual(["worker"]);
    expect(acceptance).toHaveBeenCalledTimes(1);
    expect((await store.get("a")).retries).toBe(0);
    expect(await readRuntime(tasks, "a", "review-pending.json")).toMatchObject({ definitionDigest: expect.any(String) });

    const configPath = join(root, "taskctl.json");
    await writeFile(configPath, JSON.stringify({ tasksDir: tasks, workdir: work, reviewerModel: "r/two" }), "utf8");
    const review = vi.fn(async () => passVerdict);
    const code = await runCli(["retry", "--task", "a", "--review-only", "--config", configPath], {
      adapter: workerAdapter(calls), acceptance, review, log: () => {},
    });

    expect(code).toBe(0);
    expect(review).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["worker"]);
    expect(acceptance).toHaveBeenCalledTimes(1);
    expect((await store.get("a")).status).toBe("done");
    expect(await readRuntime(tasks, "a", "review-pending.json")).toBeNull();

    // One park, one recovery, and neither is a rework round: the worker and
    // the acceptance gate still ran exactly once each.
    const lines: string[] = [];
    expect(await runCli(["metrics", "--tasks-dir", tasks], { log: (line) => lines.push(line) })).toBe(0);
    const metrics = lines.join("\n");
    expect(metrics).toMatch(/复核保留\s+1/);
    expect(metrics).toMatch(/只复核恢复\s+1/);
    expect(metrics).toMatch(/自动返工\s+0 个任务/);
    expect(metrics).toMatch(/首轮通过率\s+100%\s+\(1\/1\)/);
  });

  it("rejects review-only recovery when the artifact changed", async () => {
    const calls: string[] = [];
    await park(calls);
    await writeFile(join(work, "changed.txt"), "new artifact", "utf8");
    const review = vi.fn(async () => passVerdict);

    const outcome = await runTask(config(), {
      store, adapter: workerAdapter(calls), acceptance: pass, review,
    }, await store.get("a"), "review-only", { reviewOnly: true });

    expect(outcome).toBe("blocked");
    expect(review).not.toHaveBeenCalled();
    expect(calls).toEqual(["worker"]);
  });

  it("rejects review-only recovery when the definition changed", async () => {
    const calls: string[] = [];
    await park(calls);
    const file = join(tasks, "a.md");
    await writeFile(file, (await readFile(file, "utf8")).replace("C1 work is good", "C1 loosen the bar"), "utf8");
    const review = vi.fn(async () => passVerdict);

    const outcome = await runTask(config(), {
      store, adapter: workerAdapter(calls), acceptance: pass, review,
    }, await store.get("a"), "review-only", { reviewOnly: true });

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
    }, await store.get("a"), "review-only", { reviewOnly: true });

    expect(outcome).toBe("open");
    expect(calls).toEqual(["worker"]);
    expect((await store.get("a")).status).toBe("open");
    expect((await latestNote(tasks, "a"))?.markdown).toContain("review-failed");
    expect(await readRuntime(tasks, "a", "review-pending.json")).toBeNull();
  });
});
