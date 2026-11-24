import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter } from "../src/adapters/types.js";
import { BatchValidationError, runBatch } from "../src/batch.js";
import { runCli } from "../src/cli.js";
import type { Task } from "../src/task-file.js";
import { TaskStore } from "../src/task-store.js";
import {
  acquireWatchLock,
  heartbeatWatchLock,
  releaseWatchLock,
  watchLockPath,
} from "../src/watch-lock.js";
import { stopRequestPath, watchDirectory, watchQueue } from "../src/watch.js";
import type { WorkerConfig, WorkerDeps } from "../src/worker.js";
import { buildContinuousTask as task } from "./helpers/task-fixture.js";
import {
  createStopRequests, createWatchEventSeam, doneAdapter, passAcceptance, runWatchCli,
  seedTaskFile, waitForCondition as waitFor, workerConfigFixture,
} from "./helpers/watch-fixture.js";

let root: string;
let tasks: string;
let work: string;
let control: string;
let store: TaskStore;
let cfg: WorkerConfig;
let turns: string[];
let listeners: Map<string, () => void>;
let watchFs: ReturnType<typeof createWatchEventSeam>["watchFs"];
let stop: ReturnType<typeof createStopRequests>;
let releaseActive: (() => void) | undefined;
let activeStarted: (() => void) | undefined;
let adapterCalls: string[];

async function seed(definition: Task): Promise<void> {
  await seedTaskFile(tasks, definition);
}

function adapter(): AgentAdapter {
  return doneAdapter({
    tasksDir: tasks,
    sessionId: (id) => `s-${id}`,
    beforeResult: async (_args, id) => {
      turns.push(id);
      if (id === "a" && activeStarted !== undefined) {
        activeStarted();
        await new Promise<void>((resolve) => { releaseActive = resolve; });
      }
    },
  });
}

/** Every adapter surface is loud: idle proof must show this log stays empty. */
function idleAdapter(): AgentAdapter {
  return {
    prompt: async () => { adapterCalls.push("prompt"); throw new Error("prompt during idle"); },
    start: () => { adapterCalls.push("start"); throw new Error("start during idle"); },
    resolveModel: async (model) => { adapterCalls.push("resolveModel"); return model; },
    contextUsage: async () => { adapterCalls.push("contextUsage"); return 0; },
    contextLimit: async () => { adapterCalls.push("contextLimit"); return 100; },
    sessionUsage: async () => {
      adapterCalls.push("sessionUsage");
      return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
    },
    canResumeSession: async () => { adapterCalls.push("canResumeSession"); return "unavailable"; },
  };
}

function deps(customStore: TaskStore = store): WorkerDeps {
  return {
    store: customStore,
    adapter: adapter(),
    acceptance: passAcceptance,
  };
}

function cliWatch(
  agent: AgentAdapter = adapter(),
  customStore: TaskStore = store,
  fallbackMs = 1_000,
  debounceMs = 5,
  errors: string[] = [],
): Promise<number> {
  return runWatchCli({
    root, tasksDir: tasks, workdir: work, agent,
    acceptance: passAcceptance,
    store: customStore,
    err: (line) => { errors.push(line); },
    watch: { watchFs, fallbackMs, debounceMs },
  });
}

function stopThroughCli(): Promise<void> {
  return stop.throughCli();
}

function requestStop(): Promise<void> {
  return stop.request();
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "taskctl-watch-"));
  tasks = join(root, "tasks");
  work = join(root, "work");
  control = join(root, ".taskctl");
  await mkdir(tasks);
  await mkdir(work);
  store = new TaskStore(tasks);
  ({ listeners, watchFs } = createWatchEventSeam());
  stop = createStopRequests(tasks, listeners);
  cfg = workerConfigFixture({ tasksDir: tasks, workdir: work, lockTtlMs: 5_000, heartbeatMs: 20 });
  turns = [];
  releaseActive = undefined;
  activeStarted = undefined;
  adapterCalls = [];
});

afterEach(async () => {
  releaseActive?.();
  await rm(root, { recursive: true, force: true });
});

describe("watch ownership", () => {
  it("keeps a watcher error off the uncaught-exception path", () => {
    // 目录被删等情况下 fs.watch 会发出 error 事件；没有监听器时 EventEmitter 直接抛出，
    // 绕过 watchQueue 的 finally，看板锁就此残留。
    const watcher = watchDirectory(tasks, () => {}) as unknown as { emit(event: string, error: Error): boolean; close(): void };

    expect(() => watcher.emit("error", new Error("directory removed"))).not.toThrow();
    watcher.close();
  });

  it("creates, heartbeats, and releases only the same complete generation", async () => {
    const first = await acquireWatchLock(tasks, "watch-one:generation-1", cfg.lockTtlMs);
    expect(first.acquired).toBe(true);
    expect((await acquireWatchLock(tasks, "watch-two:generation-2", cfg.lockTtlMs)).acquired).toBe(false);
    const before = JSON.parse(await readFile(watchLockPath(tasks), "utf8")).heartbeat as number;
    await delay(5);
    expect(await heartbeatWatchLock(tasks, "watch-two:generation-2")).toBe(false);
    expect(await heartbeatWatchLock(tasks, "watch-one:generation-1")).toBe(true);
    const after = JSON.parse(await readFile(watchLockPath(tasks), "utf8")).heartbeat as number;
    expect(after).toBeGreaterThan(before);

    await releaseWatchLock(tasks, "watch-two:generation-2");
    expect(JSON.parse(await readFile(watchLockPath(tasks), "utf8")).worker).toBe("watch-one:generation-1");
    await releaseWatchLock(tasks, "watch-one:generation-1");
    expect((await acquireWatchLock(tasks, "watch-two:generation-2", cfg.lockTtlMs)).acquired).toBe(true);
    await releaseWatchLock(tasks, "watch-one:generation-1");
    expect(JSON.parse(await readFile(watchLockPath(tasks), "utf8")).worker).toBe("watch-two:generation-2");
    await releaseWatchLock(tasks, "watch-two:generation-2");
  });

  it("diagnoses a stale record without stealing or rewriting it", async () => {
    await mkdir(control, { recursive: true });
    const stale = JSON.stringify({ worker: "watch-old:generation", heartbeat: Date.now() - 60_000 });
    await writeFile(watchLockPath(tasks), stale, "utf8");

    const result = await acquireWatchLock(tasks, "watch-new:generation", 1_000);

    expect(result).toMatchObject({ acquired: false, reason: "stale" });
    expect(await readFile(watchLockPath(tasks), "utf8")).toBe(stale);
  });

  it("diagnoses a corrupt record", async () => {
    await mkdir(control, { recursive: true });
    await writeFile(watchLockPath(tasks), "not json", "utf8");
    expect(await acquireWatchLock(tasks, "watch-new:generation", 1_000))
      .toMatchObject({ acquired: false, reason: "corrupt" });
  });
});

describe("watchQueue", () => {
  it("does zero adapter calls while idle and still wakes on the fallback", async () => {
    let scans = 0;
    const counting = Object.create(store) as TaskStore;
    counting.list = async () => { scans++; return store.list(); };
    const running = cliWatch(idleAdapter(), counting, 20, 5);
    try {
      await waitFor(() => scans >= 2);
      expect(adapterCalls).toEqual([]);
      const heartbeat = JSON.parse(await readFile(watchLockPath(tasks), "utf8")).heartbeat as number;
      await delay(30);
      expect(JSON.parse(await readFile(watchLockPath(tasks), "utf8")).heartbeat).toBeGreaterThan(heartbeat);
    } finally {
      await stopThroughCli();
      await running;
    }
    expect(adapterCalls).toEqual([]);
    await expect(readFile(watchLockPath(tasks), "utf8")).rejects.toThrow("ENOENT");
  });

  it("waits for an explicit wake after an open outcome", async () => {
    await seed(task("a"));
    let claims = 0;
    const running = watchQueue(cfg, deps(), {
      watchFs,
      fallbackMs: 1_000,
      debounceMs: 5,
      runOne: async () => {
        claims++;
        if (claims === 2) await requestStop();
        return "open";
      },
    });
    try {
      await waitFor(() => claims >= 1);
      await delay(30);
      expect(claims).toBe(1);
      listeners.get(tasks)?.();
      await running;
    } finally {
      if (claims < 2) await requestStop();
      await running;
    }
    expect(claims).toBe(2);
  });

  it("waits after an exhausted open batch", async () => {
    await seed(task("a"));
    await seed(task("b"));
    let batches = 0;
    const running = watchQueue(cfg, deps(), {
      watchFs,
      fallbackMs: 1_000,
      debounceMs: 5,
      runBatch: async () => {
        batches++;
        if (batches === 2) await requestStop();
        return { done: [], stoppedAt: "a", outcome: "open", pending: ["b"] };
      },
    });
    try {
      await waitFor(() => batches >= 1);
      await delay(30);
      expect(batches).toBe(1);
      listeners.get(tasks)?.();
      await running;
    } finally {
      if (batches < 2) await requestStop();
      await running;
    }
    expect(batches).toBe(2);
  });

  it("picks up a newly added open task without another run", async () => {
    const running = watchQueue(cfg, deps(), { watchFs, fallbackMs: 1_000, debounceMs: 5 });
    try {
      await waitFor(() => listeners.has(tasks));
      await seed(task("a"));
      listeners.get(tasks)?.();
      await waitFor(() => turns.includes("a"));
      expect(turns).toEqual(["a"]);
    } finally {
      await requestStop();
      await running;
    }
    expect((await store.get("a")).status).toBe("done");
  });

  it("coalesces a filesystem burst into one scheduling scan", async () => {
    let scans = 0;
    const counting = Object.create(store) as TaskStore;
    counting.list = async () => { scans++; return store.list(); };
    const running = cliWatch(adapter(), counting, 1_000, 20);
    try {
      await waitFor(() => scans === 1 && listeners.has(tasks));
      scans = 0;
      for (let index = 0; index < 10; index++) {
        listeners.get(tasks)?.();
        await delay(2);
      }
      await delay(60);
      expect(scans).toBe(1);
      expect(turns).toEqual([]);
    } finally {
      await stopThroughCli();
      await running;
    }
  });

  it("refuses a second live watcher through the real CLI", async () => {
    const secondErrors: string[] = [];
    const running = cliWatch();
    try {
      await waitFor(() => listeners.has(tasks));
      const code = await cliWatch(adapter(), store, 1_000, 5, secondErrors);
      expect(code).toBe(1);
      expect(secondErrors.join("\n")).toContain("held");
      expect(turns).toEqual([]);
    } finally {
      await stopThroughCli();
      await running;
    }
  });

  it("refuses a second watcher and does not let --resume clear its stop request", async () => {
    expect((await acquireWatchLock(tasks, "watch-first:generation", cfg.lockTtlMs)).acquired).toBe(true);
    await writeFile(stopRequestPath(tasks), "stop", "utf8");

    await expect(watchQueue(cfg, deps(), { watchFs, resume: true })).rejects.toThrow("held");

    expect(await readFile(stopRequestPath(tasks), "utf8")).toBe("stop");
    expect(turns).toEqual([]);
    await releaseWatchLock(tasks, "watch-first:generation");
  });

  it("diagnoses a stale watch record instead of dispatching", async () => {
    await mkdir(control, { recursive: true });
    const stale = JSON.stringify({ worker: "watch-old:generation", heartbeat: Date.now() - 60_000 });
    await writeFile(watchLockPath(tasks), stale, "utf8");

    await expect(watchQueue(cfg, deps(), { watchFs })).rejects.toThrow("stale");

    expect(await readFile(watchLockPath(tasks), "utf8")).toBe(stale);
    expect(turns).toEqual([]);
  });

  it("requires explicit resume for an existing stop request", async () => {
    await mkdir(control, { recursive: true });
    await writeFile(stopRequestPath(tasks), "stop", "utf8");

    let plainError: Error | undefined;
    const plain = watchQueue(cfg, deps(), { watchFs }).catch((error: unknown) => {
      plainError = error instanceof Error ? error : new Error(String(error));
    });
    try {
      await waitFor(() => plainError !== undefined || listeners.has(tasks));
      expect(plainError?.message).toContain("resume");
      expect(await readFile(stopRequestPath(tasks), "utf8")).toBe("stop");
    } finally {
      if (plainError === undefined) await requestStop();
      await plain;
    }

    const resumed = watchQueue(cfg, deps(), { watchFs, resume: true, fallbackMs: 1_000 });
    try {
      await waitFor(() => listeners.has(tasks));
      await expect(readFile(stopRequestPath(tasks), "utf8")).rejects.toThrow("ENOENT");
    } finally {
      await requestStop();
      await resumed;
    }
  });

  it("keeps serving the board while one task file cannot be read, and resumes once it is mended", async () => {
    await seed(task("a"));
    await writeFile(join(tasks, "broken.md"), [
      "---", "schema: taskctl/v1", "title: broken", "status: open", "sessions: []", "---", "a required field is missing", "",
    ].join("\n"), "utf8");
    const reported: string[] = [];
    const running = watchQueue(cfg, deps(), {
      watchFs, fallbackMs: 1_000, debounceMs: 5, onError: (message) => { reported.push(message); },
    });
    try {
      await waitFor(() => reported.length > 0);
      expect(reported[0]).toContain("broken");
      expect(turns).toEqual([]);

      await rm(join(tasks, "broken.md"));
      listeners.get(tasks)?.();
      await waitFor(() => turns.includes("a"));
    } finally {
      await requestStop();
      await running;
    }
    expect((await store.get("a")).status).toBe("done");
  });

  it("ends only the batch when its selection stops validating mid-flight", async () => {
    await seed(task("a"));
    await seed(task("b"));
    let claimedElsewhere = true;
    const reported: string[] = [];
    const running = watchQueue(cfg, deps(), {
      watchFs, fallbackMs: 1_000, debounceMs: 5,
      runBatch: async (batchCfg, batchDeps, ids) => {
        if (claimedElsewhere) {
          // Another controller claimed a selected task between grouping and the batch's own re-validation.
          claimedElsewhere = false;
          throw new BatchValidationError([`task ${ids[0]}: a live lock is held by another execution`]);
        }
        return runBatch(batchCfg, batchDeps, ids);
      },
      onError: (message) => { reported.push(message); },
    });
    try {
      await waitFor(() => reported.length > 0);
      expect(reported[0]).toContain("live lock");
      expect(turns).toEqual([]);

      listeners.get(tasks)?.();
      await waitFor(() => turns.includes("b"));
    } finally {
      await requestStop();
      await running;
    }
    expect((await store.get("b")).status).toBe("done");
  });

  it("does not claim ordinarily when stop arrives during the board read", async () => {
    await seed(task("a"));
    let boardStarted!: () => void;
    let releaseBoard!: () => void;
    const began = new Promise<void>((resolve) => { boardStarted = resolve; });
    const blocked = new Promise<void>((resolve) => { releaseBoard = resolve; });
    const blockedStore = Object.create(store) as TaskStore;
    blockedStore.list = async () => {
      boardStarted();
      await blocked;
      return store.list();
    };
    let claims = 0;
    const running = watchQueue(cfg, deps(blockedStore), {
      watchFs,
      fallbackMs: 1_000,
      debounceMs: 5,
      runOne: async () => { claims++; return "done"; },
    });
    try {
      await began;
      await requestStop();
      releaseBoard();
      await running;
    } finally {
      releaseBoard();
      await requestStop();
      await running;
    }
    expect(claims).toBe(0);
  });

  it("does not claim ordinarily when ownership is lost during the board read", async () => {
    await seed(task("a"));
    let boardStarted!: () => void;
    let releaseBoard!: () => void;
    const began = new Promise<void>((resolve) => { boardStarted = resolve; });
    const blocked = new Promise<void>((resolve) => { releaseBoard = resolve; });
    const blockedStore = Object.create(store) as TaskStore;
    blockedStore.list = async () => {
      boardStarted();
      await blocked;
      return store.list();
    };
    let claims = 0;
    const running = watchQueue(cfg, deps(blockedStore), {
      watchFs,
      fallbackMs: 1_000,
      debounceMs: 5,
      runOne: async () => { claims++; return "done"; },
    });
    try {
      await began;
      const owner = JSON.parse(await readFile(watchLockPath(tasks), "utf8")).worker as string;
      await releaseWatchLock(tasks, owner);
      await delay(50);
      releaseBoard();
      await expect(running).rejects.toThrow("ownership");
    } finally {
      releaseBoard();
      await requestStop();
      await running.catch(() => {});
    }
    expect(claims).toBe(0);
  });

  it("settles the active task on stop and leaves the next task unclaimed", async () => {
    await seed(task("a"));
    await seed(task("b"));
    let started!: () => void;
    activeStarted = () => { started(); };
    const began = new Promise<void>((resolve) => { started = resolve; });
    const running = cliWatch();
    try {
      await began;
      await stopThroughCli();
      releaseActive?.();
      const code = await running;
      expect(code).toBe(0);
    } finally {
      releaseActive?.();
    }
    expect(turns).toEqual(["a"]);
    expect((await store.get("a")).status).toBe("done");
    expect((await store.get("b")).status).toBe("open");
    expect(await readFile(stopRequestPath(tasks), "utf8")).not.toBeNull();
  });

  it("stops claiming after heartbeat ownership is lost", async () => {
    await seed(task("a"));
    await seed(task("b"));
    let started!: () => void;
    activeStarted = () => { started(); };
    const began = new Promise<void>((resolve) => { started = resolve; });
    const running = watchQueue(cfg, deps(), { watchFs, fallbackMs: 1_000, debounceMs: 5 });
    try {
      await began;
      const owner = JSON.parse(await readFile(watchLockPath(tasks), "utf8")).worker as string;
      await releaseWatchLock(tasks, owner);
      await delay(50);
      releaseActive?.();
      await expect(running).rejects.toThrow("ownership");
    } finally {
      releaseActive?.();
    }
    expect(turns).toEqual(["a"]);
    expect((await store.get("a")).status).toBe("done");
    expect((await store.get("b")).status).toBe("open");
  });
});

describe("watch and stop CLI parsing", () => {
  it("stop writes the request and requires --tasks-dir", async () => {
    expect(await runCli(["stop", "--tasks-dir", tasks], { log: () => {}, err: () => {} })).toBe(0);
    expect(await readFile(stopRequestPath(tasks), "utf8")).not.toBeNull();
    expect(await runCli(["stop"], { log: () => {}, err: () => {} })).toBe(2);
  });

  it("watch requires --config", async () => {
    expect(await runCli(["watch"], { log: () => {}, err: () => {} })).toBe(2);
  });

  it("watch refuses while a stop request exists and names --resume", async () => {
    await mkdir(control, { recursive: true });
    await writeFile(stopRequestPath(tasks), "stop", "utf8");
    const errors: string[] = [];

    const code = await runWatchCli({
      root, tasksDir: tasks, workdir: work, agent: adapter(), acceptance: passAcceptance,
      err: (line) => { errors.push(line); }, watch: { watchFs, fallbackMs: 1_000, debounceMs: 5 },
    });

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("watch --resume");
  });

  it("watch --resume clears an existing stop request and serves the board through the real CLI", async () => {
    await mkdir(control, { recursive: true });
    await writeFile(stopRequestPath(tasks), "stop", "utf8");
    const errors: string[] = [];
    const running = runWatchCli({
      root, tasksDir: tasks, workdir: work, agent: adapter(), acceptance: passAcceptance, resume: true,
      err: (line) => { errors.push(line); }, watch: { watchFs, fallbackMs: 1_000, debounceMs: 5 },
    });
    await waitFor(() => listeners.has(tasks));
    await expect(readFile(stopRequestPath(tasks), "utf8")).rejects.toThrow("ENOENT");

    await seed(task("a"));
    listeners.get(tasks)?.();
    await waitFor(() => turns.includes("a"));
    await requestStop();

    await expect(running).resolves.toBe(0);
    expect(errors).toEqual([]);
    expect((await store.get("a")).status).toBe("done");
  });

  it("discovers work through the real watch CLI and drains through the real stop CLI", async () => {
    const errors: string[] = [];
    const running = runWatchCli({
      root, tasksDir: tasks, workdir: work, agent: adapter(),
      acceptance: passAcceptance,
      err: (line) => { errors.push(line); },
      watch: { watchFs, fallbackMs: 1_000, debounceMs: 5 },
    });
    await waitFor(() => listeners.has(tasks));
    await seed(task("a"));
    listeners.get(tasks)?.();
    await waitFor(() => turns.includes("a"));

    expect(await runCli(["stop", "--tasks-dir", tasks], { log: () => {}, err: () => {} })).toBe(0);
    await expect(running).resolves.toBe(0);
    expect(errors).toEqual([]);
    expect(turns).toEqual(["a"]);
    expect((await store.get("a")).status).toBe("done");
    const logsDir = join(tasks, "a", "logs");
    const logs = (await readdir(logsDir)).filter((name) => /^run-.+\.log$/.test(name));
    expect(logs).toHaveLength(1);
    const events = await readFile(join(logsDir, logs[0]!), "utf8");
    expect(events).toContain("[a] claimed");
    expect(events).toContain("[a] done");
  });
});
