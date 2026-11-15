import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "../src/task-store.js";
import { runScheduler } from "../src/scheduler.js";
import type { WorkerConfig } from "../src/worker.js";
import type { AgentAdapter } from "../src/adapters/types.js";

let root: string;
let tasks: string;
let cwd: string;
let store: TaskStore;
let claimed: string[];
let active: number;
let peak: number;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "taskctl-sched-"));
  tasks = join(root, "tasks");
  cwd = join(root, "work");
  await mkdir(tasks);
  await mkdir(cwd);
  store = new TaskStore(tasks);
  claimed = [];
  await mkdir(join(cwd, "a"), { recursive: true });
  await mkdir(join(cwd, "b"), { recursive: true });
  await mkdir(join(cwd, "same"), { recursive: true });
  active = 0;
  peak = 0;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function seed(id: string, extra: string[] = []): Promise<void> {
  const lines = [
    "---",
    `title: ${id}`,
    "status: open",
    'acceptance: "check"',
    "criteria:",
    "  - C1 ok",
    ...extra,
    "sessions: []",
    "retries: 0",
    "---",
    "work",
    "",
  ];
  await writeFile(join(tasks, `${id}.md`), lines.join("\n"), "utf8");
}

/** A turn that holds the slot briefly so overlaps are observable. */
function adapter(): AgentAdapter {
  return {
    prompt: async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active--;
      return { sessionId: "s", text: "done", exitCode: 0 };
    },
    contextUsage: async () => 0,
    contextLimit: async () => 100,
  };
}

function config(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    tasksDir: tasks,
    workdir: cwd,
    agent: "fixture",
    contextThreshold: 0.8,
    retryLimit: 1,
    lockTtlMs: 20_000,
    heartbeatMs: 1_000,
    ...overrides,
  };
}

/** Fails the acceptance gate so tasks end `blocked` and no review runs. */
const failGate = async () => ({ passed: false, skipped: false as const, exitCode: 1, output: "no" });

describe("runScheduler", () => {
  it("runs two tasks with disjoint workdirs at the same time", async () => {
    await seed("001-a", ["workdir: a"]);
    await seed("002-b", ["workdir: b"]);
    claimed = ["001-a", "002-b"];
    await runScheduler(config({ parallel: 2 }), { store, adapter: adapter(), acceptance: failGate });
    expect(peak).toBe(2);
  });

  it("serializes tasks that share a workdir", async () => {
    await seed("001-a", ["workdir: same"]);
    await seed("002-b", ["workdir: same"]);
    await runScheduler(config({ parallel: 2 }), { store, adapter: adapter(), acceptance: failGate });
    expect(peak).toBe(1);
  });

  it("skips a task whose dependency is not done", async () => {
    await seed("001-a");
    await seed("002-b", ["depends_on:", "  - 001-a"]);
    await store.setStatus("001-a", "blocked");
    await runScheduler(config({ parallel: 2 }), { store, adapter: adapter(), acceptance: failGate });
    expect((await store.get("002-b")).status).toBe("open");
  });

  it("rejects a dependency cycle before running anything", async () => {
    await seed("001-a", ["depends_on:", "  - 002-b"]);
    await seed("002-b", ["depends_on:", "  - 001-a"]);
    await expect(runScheduler(config(), { store, adapter: adapter(), acceptance: failGate })).rejects.toThrow(/cycle/);
  });

  it("rejects a dependency on a task that does not exist", async () => {
    await seed("001-a", ["depends_on:", "  - 999-ghost"]);
    await expect(runScheduler(config(), { store, adapter: adapter(), acceptance: failGate })).rejects.toThrow(/unknown task/);
  });

  it("serializes two directories inside one git repository", async () => {
    // Workspace reservation treats a whole git common dir as one resource, so
    // the scheduler must not start a sibling directory task either.
    await mkdir(join(cwd, ".git"), { recursive: true });
    await seed("001-a", ["workdir: a"]);
    await seed("002-b", ["workdir: b"]);
    await runScheduler(config({ parallel: 2 }), { store, adapter: adapter(), acceptance: failGate });
    expect(peak).toBe(1);
  });

  it("never claims draft or awaiting-human tasks", async () => {
    await seed("001-a");
    await seed("002-b");
    await store.setStatus("001-a", "draft");
    await store.setStatus("002-b", "awaiting-human");
    await runScheduler(config({ parallel: 2 }), { store, adapter: adapter(), acceptance: failGate });
    expect(await store.get("001-a")).toMatchObject({ status: "draft" });
    expect(await store.get("002-b")).toMatchObject({ status: "awaiting-human" });
  });
});
