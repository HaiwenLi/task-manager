import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordWorkerSession } from "../src/execution-state.js";
import { writeRuntime } from "../src/runtime.js";
import { runTask, type WorkerConfig } from "../src/worker.js";
import type { AgentAdapter } from "../src/adapters/types.js";
import { TaskStore } from "../src/task-store.js";

let root: string;
let tasks: string;
let work: string;
let store: TaskStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "taskctl-session-resume-"));
  tasks = join(root, "tasks");
  work = join(root, "work");
  await mkdir(tasks);
  await mkdir(work);
  store = new TaskStore(tasks);
  await writeFile(join(tasks, "a.md"), [
    "---", "schema: taskctl/v1", "title: Resume", "status: open",
    'acceptance: "check"', "criteria:", "  - C1 ok", "model: w/one",
    "sessions:", "  - ses-old", "retries: 0", "review_rounds: 0", "---", "Work", "",
  ].join("\n"), "utf8");
  await mkdir(join(tasks, "a"), { recursive: true });
  await writeRuntime(tasks, "a", "attempt.json", {
    attemptId: "old", backend: "fixture", workspace: work,
    startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    phase: "settled", operation: "finished",
  });
  await recordWorkerSession(tasks, "a", { sessionId: "ses-old", model: "w/one", clean: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function config(): WorkerConfig {
  return { tasksDir: tasks, workdir: work, agent: "fixture", contextThreshold: 0.8, retryLimit: 1, lockTtlMs: 5_000, heartbeatMs: 50 };
}

function adapter(status: "reusable" | "active" | "unavailable", prompts: Array<{ sessionId?: string }>): AgentAdapter {
  return {
    canResumeSession: async () => status,
    prompt: async (args) => {
      prompts.push({ sessionId: args.sessionId });
      await writeFile(join(tasks, "a", "done.requested"), "done");
      return { sessionId: "ses-old", exitCode: 0, text: "done" };
    },
    contextUsage: async () => 0,
    contextLimit: async () => 100,
  };
}

const acceptance = async () => ({ passed: true, skipped: false as const, exitCode: 0, output: "ok" });
const review = async () => ({ verdict: "pass" as const, criteria: [{ id: "C1", pass: true, evidence: "ok" }], externalChanges: [], defects: [], summary: "ok" });

describe("persisted worker session reuse", () => {
  it("resumes a matching idle session from a settled attempt", async () => {
    const prompts: Array<{ sessionId?: string }> = [];
    const outcome = await runTask(config(), { store, adapter: adapter("reusable", prompts), acceptance, review }, await store.get("a"), "w1");
    expect(outcome).toBe("done");
    expect(prompts).toEqual([{ sessionId: "ses-old" }]);
    expect((await store.get("a")).sessions).toEqual(["ses-old"]);
  });

  it("blocks instead of competing with a backend session that is still active", async () => {
    const prompts: Array<{ sessionId?: string }> = [];
    const outcome = await runTask(config(), { store, adapter: adapter("active", prompts), acceptance, review }, await store.get("a"), "w1");
    expect(outcome).toBe("blocked");
    expect(prompts).toEqual([]);
    expect((await store.get("a")).status).toBe("blocked");
  });

  it("starts fresh when the backend reuse state is unavailable", async () => {
    const prompts: Array<{ sessionId?: string }> = [];
    const probe = vi.fn(async () => "unavailable" as const);
    const agent = adapter("unavailable", prompts);
    agent.canResumeSession = probe;
    const outcome = await runTask(config(), { store, adapter: agent, acceptance, review }, await store.get("a"), "w1");
    expect(outcome).toBe("done");
    expect(prompts).toEqual([{ sessionId: undefined }]);
    expect(probe).toHaveBeenCalledOnce();
  });
});
