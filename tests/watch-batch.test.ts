import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter } from "../src/adapters/types.js";
import { selectAutomaticBatch } from "../src/batch.js";
import { runCli } from "../src/cli.js";
import { writeRuntime, type AttemptRecord } from "../src/runtime.js";
import type { Task } from "../src/task-file.js";
import { TaskStore } from "../src/task-store.js";
import { watchQueue } from "../src/watch.js";
import type { WorkerConfig, WorkerDeps, WorkerEvent } from "../src/worker.js";
import { buildContinuousTask as task } from "./helpers/task-fixture.js";
import {
  createStopRequests, createWatchEventSeam, doneAdapter, passAcceptance, runWatchCli,
  seedTaskFile, waitForConditionAsync as waitForAsync, workerConfigFixture, writeBatchConfig,
} from "./helpers/watch-fixture.js";

let root: string;
let tasks: string;
let work: string;
let store: TaskStore;
let cfg: WorkerConfig;
let turns: Array<{ id: string; sessionId?: string; text: string }>;
let probeCalls: string[];
let reviewed: string[];
let events: WorkerEvent[];
let listeners: Map<string, () => void>;
let watchFs: ReturnType<typeof createWatchEventSeam>["watchFs"];
let onTurn: ((id: string) => Promise<void>) | undefined;
let stop: ReturnType<typeof createStopRequests>;

async function seed(definition: Task): Promise<void> {
  await seedTaskFile(tasks, definition);
}

function adapter(): AgentAdapter {
  return doneAdapter({
    tasksDir: tasks,
    sessionId: (id, args) => args.sessionId ?? `ses-${id}`,
    beforeResult: async (args, id) => {
      turns.push({ id, sessionId: args.sessionId, text: args.text });
      await onTurn?.(id);
    },
    canResumeSession: async (sessionId) => {
      probeCalls.push(sessionId);
      return "reusable";
    },
  });
}

const reviewFor: NonNullable<WorkerDeps["review"]> = async (evidence) => {
  reviewed.push(evidence.task.id);
  return {
    verdict: "pass" as const,
    criteria: evidence.task.criteria.map((criterion) => ({ id: criterion.split(/\s+/)[0]!, pass: true, evidence: "ok" })),
    externalChanges: [],
    defects: [],
    summary: "ok",
  };
};

function deps(): WorkerDeps {
  return {
    store,
    adapter: adapter(),
    acceptance: passAcceptance,
    review: reviewFor,
    onEvent: (event) => { events.push(event); },
  };
}

function cliWatch(): Promise<number> {
  return runWatchCli({
    root, tasksDir: tasks, workdir: work, agent: adapter(),
    acceptance: passAcceptance,
    review: reviewFor,
    watch: { watchFs, fallbackMs: 1_000, debounceMs: 5 },
  });
}

function requestStop(): Promise<void> {
  return stop.request();
}

function finished(...ids: string[]): boolean {
  return ids.every((id) => events.some((event) => event.taskId === id && event.type === "done"));
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "taskctl-watch-batch-"));
  tasks = join(root, "tasks");
  work = join(root, "work");
  await mkdir(tasks);
  await mkdir(work);
  store = new TaskStore(tasks);
  ({ listeners, watchFs } = createWatchEventSeam());
  stop = createStopRequests(tasks, listeners);
  cfg = workerConfigFixture({ tasksDir: tasks, workdir: work, lockTtlMs: 5_000, heartbeatMs: 20 });
  turns = [];
  probeCalls = [];
  reviewed = [];
  events = [];
  onTurn = undefined;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("selectAutomaticBatch", () => {
  it("caps the eligible prefix at batchMaxTasks and defaults to five", async () => {
    const board = ["a", "b", "c", "d", "e", "f"].map((id) => task(id));
    cfg.batchMaxTasks = 2;
    expect(await selectAutomaticBatch(cfg, board)).toEqual(["a", "b"]);
    delete cfg.batchMaxTasks;
    expect(await selectAutomaticBatch(cfg, board)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("does not jump an ineligible head or group across an ineligible middle task", async () => {
    const a = task("a");
    const b = task("b", { verify: "human" });
    const c = task("c");
    expect(await selectAutomaticBatch(cfg, [b, a, c])).toEqual([]);
    expect(await selectAutomaticBatch(cfg, [a, b, c])).toEqual(["a"]);
  });

  it("returns a singleton when grouping is disabled", async () => {
    cfg.batchMaxTasks = 1;
    expect(await selectAutomaticBatch(cfg, [task("a"), task("b")])).toEqual(["a"]);
  });
});

describe("watch automatic batches", () => {
  it("forms one safe batch from two eligible tasks", async () => {
    await seed(task("a"));
    await seed(task("b"));
    onTurn = async (id) => {
      if (id === "b") await requestStop();
    };
    let code: number | undefined;
    try {
      code = await cliWatch();
    } finally {
      if (code === undefined) await requestStop();
    }
    expect(code).toBe(0);
    expect(turns.map((turn) => turn.id)).toEqual(["a", "b"]);
    expect(turns.map((turn) => turn.sessionId)).toEqual([undefined, "ses-a"]);
    expect(probeCalls).toEqual(["ses-a"]);
  });

  it("runs every task ordinarily when batchMaxTasks is 1", async () => {
    cfg.batchMaxTasks = 1;
    await seed(task("a"));
    await seed(task("b"));
    const running = watchQueue(cfg, deps(), { watchFs, fallbackMs: 1_000 });
    try {
      await waitForAsync(async () => finished("a", "b"));
    } finally {
      await requestStop();
      await running;
    }
    expect(turns.map((turn) => turn.sessionId)).toEqual([undefined, undefined]);
    expect(probeCalls).toEqual([]);
    expect(turns.every((turn) => !turn.text.includes("连续批次"))).toBe(true);
  });

  it("runs an earlier human-verified task alone before grouping later eligible work", async () => {
    await seed(task("a", { verify: "human" }));
    await seed(task("b"));
    await seed(task("c"));
    onTurn = async (id) => {
      if (id === "c") await requestStop();
    };
    let code: number | undefined;
    try {
      code = await cliWatch();
    } finally {
      if (code === undefined) await requestStop();
    }
    expect(code).toBe(0);
    expect(turns.map((turn) => turn.id)).toEqual(["a", "b", "c"]);
    expect(reviewed).toEqual(["a"]);
    expect(turns.map((turn) => turn.sessionId)).toEqual([undefined, undefined, "ses-b"]);
  });

  it("prioritizes an unfinished non-live running task", async () => {
    await seed(task("a", { status: "running" }));
    await mkdir(join(tasks, "a"), { recursive: true });
    const attempt: AttemptRecord = {
      attemptId: "old",
      backend: "fixture",
      workspace: work,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      phase: "settled",
      operation: "finished",
    };
    await writeRuntime(tasks, "a", "attempt.json", attempt);
    await seed(task("b"));
    await seed(task("c"));
    const running = watchQueue(cfg, deps(), { watchFs, fallbackMs: 1_000 });
    try {
      await waitForAsync(async () => finished("a", "b", "c"));
    } finally {
      await requestStop();
      await running;
    }
    expect(turns.map((turn) => turn.id)).toEqual(["a", "b", "c"]);
  });

  it("does not claim later selected tasks when stop arrives during an automatic batch", async () => {
    await seed(task("a"));
    await seed(task("b"));
    await seed(task("c"));
    onTurn = async (id) => {
      if (id === "a") await requestStop();
    };
    const running = watchQueue(cfg, deps(), { watchFs, fallbackMs: 1_000, debounceMs: 5 });
    await running;
    expect(turns.map((turn) => turn.id)).toEqual(["a"]);
    expect((await store.get("a")).status).toBe("done");
    expect((await store.get("b")).status).toBe("open");
    expect((await store.get("c")).status).toBe("open");
  });

  it("does not insert a new arrival into the active batch", async () => {
    await seed(task("a"));
    await seed(task("b"));
    onTurn = async (id) => {
      if (id === "a") {
        await seed(task("c"));
        listeners.get(tasks)?.();
      }
      if (id === "b") await requestStop();
    };
    let code: number | undefined;
    try {
      code = await cliWatch();
    } finally {
      if (code === undefined) await requestStop();
    }
    expect(code).toBe(0);
    expect(turns.map((turn) => turn.id)).toEqual(["a", "b"]);
    expect((await store.get("c")).status).toBe("open");
  });

  it("reads batchMaxTasks through the real CLI config path", async () => {
    await seed(task("a"));
    await seed(task("b"));
    const configPath = await writeBatchConfig(root, {
      tasksDir: tasks, workdir: work, batchMaxTasks: 2, lockTtlMs: 5_000, heartbeatMs: 20,
    });

    const code = await runCli(["run", "--batch", "a,b", "--config", configPath], {
      adapter: adapter(),
      acceptance: passAcceptance,
      log: () => {},
      err: () => {},
    });

    expect(code).toBe(0);
    expect(turns.map((turn) => turn.id)).toEqual(["a", "b"]);
  });
});
