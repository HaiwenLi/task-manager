import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter } from "../src/adapters/types.js";
import { runCli } from "../src/cli.js";
import { serializeTaskFile, type Task } from "../src/task-file.js";
import { TaskStore } from "../src/task-store.js";
import {
  acquireWatchLock,
  heartbeatWatchLock,
  releaseWatchLock,
  watchLockPath,
} from "../src/watch-lock.js";
import { stopRequestPath, watchQueue, type WatchFs } from "../src/watch.js";
import type { WorkerConfig, WorkerDeps } from "../src/worker.js";
import { buildTaskFile } from "./helpers/task-fixture.js";

let root: string;
let tasks: string;
let work: string;
let control: string;
let store: TaskStore;
let cfg: WorkerConfig;
let turns: string[];
let listeners: Map<string, () => void>;
let releaseActive: (() => void) | undefined;
let activeStarted: (() => void) | undefined;

function task(id: string, overrides: Partial<Task> = {}): Task {
  return buildTaskFile({
    id,
    title: id,
    status: "open",
    complexity: "simple",
    execution: "continuous",
    verify: "mechanical",
    acceptance: "check",
    criteria: ["C1 ok"],
    model: "w/one",
    ...overrides,
  });
}

async function seed(definition: Task): Promise<void> {
  await writeFile(join(tasks, `${definition.id}.md`), serializeTaskFile(definition), "utf8");
}

function adapter(): AgentAdapter {
  return {
    prompt: async (args) => {
      const id = /taskctl done --task (\S+) --tasks-dir/.exec(args.text)![1]!;
      turns.push(id);
      if (id === "a" && activeStarted !== undefined) {
        activeStarted();
        await new Promise<void>((resolve) => { releaseActive = resolve; });
      }
      await mkdir(join(tasks, id), { recursive: true });
      await writeFile(join(tasks, id, "done.requested"), "done");
      return { sessionId: `s-${id}`, exitCode: 0, text: "done" };
    },
    contextUsage: async () => 0,
    contextLimit: async () => 100,
  };
}

function deps(customStore: TaskStore = store): WorkerDeps {
  return {
    store: customStore,
    adapter: adapter(),
    acceptance: async () => ({ passed: true, skipped: false as const, exitCode: 0, output: "ok" }),
  };
}

const watchFs: WatchFs = (path, listener) => {
  listeners.set(path, listener);
  return { close: () => { listeners.delete(path); } };
};

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("condition did not become true before timeout");
    await delay(10);
  }
}

async function waitForAsync(check: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error("async condition did not become true before timeout");
    await delay(10);
  }
}

async function requestStop(): Promise<void> {
  await writeFile(stopRequestPath(tasks), new Date().toISOString(), "utf8");
  listeners.get(control)?.();
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "taskctl-watch-"));
  tasks = join(root, "tasks");
  work = join(root, "work");
  control = join(root, ".taskctl");
  await mkdir(tasks);
  await mkdir(work);
  store = new TaskStore(tasks);
  cfg = {
    tasksDir: tasks,
    workdir: work,
    agent: "fixture",
    model: "w/one",
    contextThreshold: 0.8,
    retryLimit: 1,
    lockTtlMs: 5_000,
    heartbeatMs: 20,
  };
  turns = [];
  listeners = new Map();
  releaseActive = undefined;
  activeStarted = undefined;
});

afterEach(async () => {
  releaseActive?.();
  await rm(root, { recursive: true, force: true });
});

describe("watch ownership", () => {
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
  it("does zero model calls while idle and still wakes on the fallback", async () => {
    let scans = 0;
    const counting = Object.create(store) as TaskStore;
    counting.list = async () => { scans++; return store.list(); };
    const running = watchQueue(cfg, deps(counting), { watchFs, fallbackMs: 20, debounceMs: 5 });
    try {
      await waitFor(() => scans >= 2);
      expect(turns).toEqual([]);
      const heartbeat = JSON.parse(await readFile(watchLockPath(tasks), "utf8")).heartbeat as number;
      await delay(30);
      expect(JSON.parse(await readFile(watchLockPath(tasks), "utf8")).heartbeat).toBeGreaterThan(heartbeat);
    } finally {
      await requestStop();
      await running;
    }
    expect(turns).toEqual([]);
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

  it("picks up a newly added open task without another run", async () => {
    const running = watchQueue(cfg, deps(), { watchFs, fallbackMs: 1_000, debounceMs: 5 });
    try {
      await waitFor(() => listeners.has(tasks));
      await seed(task("a"));
      listeners.get(tasks)?.();
      await waitForAsync(async () => (await store.get("a")).status === "done");
      expect(turns).toEqual(["a"]);
    } finally {
      await requestStop();
      await running;
    }
  });

  it("coalesces a filesystem burst into one scheduling scan", async () => {
    let scans = 0;
    const counting = Object.create(store) as TaskStore;
    counting.list = async () => { scans++; return store.list(); };
    const running = watchQueue(cfg, deps(counting), { watchFs, fallbackMs: 1_000, debounceMs: 20 });
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
      await requestStop();
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
    const running = watchQueue(cfg, deps(), { watchFs, fallbackMs: 1_000, debounceMs: 5 });
    try {
      await began;
      await requestStop();
      releaseActive?.();
      await running;
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

  it("discovers work through the real watch CLI and drains through the real stop CLI", async () => {
    const configPath = join(root, "taskctl.json");
    await writeFile(configPath, JSON.stringify({
      tasksDir: tasks,
      workdir: work,
      model: "w/one",
      lockTtlMs: 5_000,
      heartbeatMs: 20,
    }), "utf8");
    const errors: string[] = [];
    const running = runCli(["watch", "--config", configPath], {
      adapter: adapter(),
      acceptance: async () => ({ passed: true, skipped: false as const, exitCode: 0, output: "ok" }),
      log: () => {},
      err: (line) => { errors.push(line); },
      watch: { watchFs, fallbackMs: 1_000, debounceMs: 5 },
    });
    await waitFor(() => listeners.has(tasks));
    await seed(task("a"));
    listeners.get(tasks)?.();
    await waitForAsync(async () => (await store.get("a")).status === "done");

    expect(await runCli(["stop", "--tasks-dir", tasks], { log: () => {}, err: () => {} })).toBe(0);
    await expect(running).resolves.toBe(0);
    expect(errors).toEqual([]);
    expect(turns).toEqual(["a"]);
  });
});
