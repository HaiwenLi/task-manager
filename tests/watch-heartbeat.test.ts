import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter } from "../src/adapters/types.js";
import type { WatchOptions } from "../src/watch.js";
import type { WorkerConfig, WorkerDeps } from "../src/worker.js";
import { buildContinuousTask as task } from "./helpers/task-fixture.js";

/**
 * `rename` is replaced here so the watch lock's heartbeat can be refused once.
 * Whether a refused write ends the watcher is the whole question, and it cannot
 * be asked while the OS cooperates.
 */
const state = vi.hoisted(() => ({
  /** One entry per rename onto the watch lock: an error to throw, or nothing. */
  refusals: [] as Array<NodeJS.ErrnoException | undefined>,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (from: string, to: string): Promise<void> => {
      if (String(to).endsWith("watch.lock")) {
        const next = state.refusals.shift();
        if (next !== undefined) throw next;
      }
      return actual.rename(from, to);
    },
  };
});

const {
  createStopRequests, createWatchEventSeam, doneAdapter, passAcceptance, seedTaskFile, waitForConditionAsync, workerConfigFixture,
} = await import("./helpers/watch-fixture.js");
const { TaskStore } = await import("../src/task-store.js");
const { watchLockPath } = await import("../src/watch-lock.js");
const { watchQueue } = await import("../src/watch.js");

const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: simulated`), { code });

let root: string;
let tasks: string;
let store: InstanceType<typeof TaskStore>;
let cfg: WorkerConfig;
let listeners: Map<string, () => void>;
let watchFs: NonNullable<WatchOptions["watchFs"]>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "taskctl-watch-heartbeat-"));
  tasks = join(root, "tasks");
  const work = join(root, "work");
  await mkdir(tasks);
  await mkdir(work);
  store = new TaskStore(tasks);
  ({ listeners, watchFs } = createWatchEventSeam());
  cfg = workerConfigFixture({ tasksDir: tasks, workdir: work, lockTtlMs: 5_000, heartbeatMs: 20 });
  state.refusals = [];
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function deps(): WorkerDeps {
  return {
    store,
    adapter: doneAdapter({ tasksDir: tasks, sessionId: (id) => `s-${id}` }) as AgentAdapter,
    acceptance: passAcceptance,
  };
}

function options(errors: string[]): WatchOptions {
  return { watchFs, fallbackMs: 60_000, debounceMs: 5, onError: (message) => errors.push(message) };
}

describe("watch heartbeat", () => {
  it("keeps owning the board when one heartbeat cannot be written", async () => {
    await seedTaskFile(tasks, task("a"));
    // Not a busy destination, so there is nothing to retry. The lock record is
    // still this watcher's; only a lock that is no longer ours may end the
    // watch. Two heartbeats in a row are refused: the watcher keeps trying and
    // reports it once.
    state.refusals = [errno("EIO"), errno("EIO")];
    const stop = createStopRequests(tasks, listeners);
    const errors: string[] = [];
    const queue = watchQueue(cfg, deps(), options(errors));
    await waitForConditionAsync(async () => (await store.get("a")).status === "done");
    // Several more heartbeats after the refused one.
    await delay(120);

    expect(errors.filter((message) => /heartbeat/.test(message))).toHaveLength(1);
    await stop.request();
    await expect(queue).resolves.toEqual({ reason: "stop" });
    expect((await store.get("a")).status).toBe("done");
  });

  it("still ends the watch when the lock is no longer its own", async () => {
    await seedTaskFile(tasks, task("a"));
    const errors: string[] = [];
    const queue = watchQueue(cfg, deps(), options(errors));
    await waitForConditionAsync(async () => (await store.get("a")).status === "done");
    // The lock disappears between two heartbeats, as it does after a takeover.
    const owner = (JSON.parse(await readFile(watchLockPath(tasks), "utf8")) as { worker: string }).worker;
    const { releaseWatchLock } = await import("../src/watch-lock.js");
    await releaseWatchLock(tasks, owner);

    await expect(queue).rejects.toThrow(/ownership generation changed/);
    expect(errors).toEqual([]);
  });
});
