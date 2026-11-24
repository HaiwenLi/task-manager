import { randomUUID } from "node:crypto";
import { watch as fsWatch } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { runBatch, selectAutomaticBatch } from "./batch.js";
import { lockLive } from "./claim.js";
import { assertAcyclic, ready, taskWorkdir } from "./scheduler.js";
import { runTask, type WorkerConfig, type WorkerDeps } from "./worker.js";
import { acquireWatchLock, heartbeatWatchLock, releaseWatchLock } from "./watch-lock.js";

const controlDir = (tasksDir: string): string => join(tasksDir, "..", ".taskctl");
export const stopRequestPath = (tasksDir: string): string => join(controlDir(tasksDir), "stop.requested");

/** Minimal filesystem seam: production uses `fs.watch`; tests fire listeners. */
export type WatchFs = (path: string, listener: () => void) => { close(): void };

export type WatchOptions = {
  resume?: boolean;
  debounceMs?: number;
  fallbackMs?: number;
  runOne?: typeof runTask;
  runBatch?: typeof runBatch;
  watchFs?: WatchFs;
};

async function stopRequested(tasksDir: string): Promise<boolean> {
  try {
    await readFile(stopRequestPath(tasksDir), "utf8");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Own and drain one board until `.taskctl/stop.requested` appears. The loop is
 * sequential on purpose: new arrivals are considered only between operations,
 * and a stop never becomes a process-tree kill or an uncertain replay.
 */
export async function watchQueue(
  cfg: WorkerConfig,
  deps: WorkerDeps,
  options: WatchOptions = {},
): Promise<void> {
  await mkdir(cfg.tasksDir, { recursive: true });
  const owner = `watch-${process.pid}:${randomUUID()}`;
  const acquired = await acquireWatchLock(cfg.tasksDir, owner, cfg.lockTtlMs);
  if (!acquired.acquired) throw new Error(acquired.detail);

  const debounceMs = options.debounceMs ?? 250;
  const fallbackMs = options.fallbackMs ?? 30_000;
  const watchFs: WatchFs = options.watchFs ?? ((path, listener) => fsWatch(path, listener));
  const runOne = options.runOne ?? runTask;
  const runSelected = options.runBatch ?? runBatch;
  const watchers: Array<{ close(): void }> = [];
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let fallback: ReturnType<typeof setTimeout> | undefined;
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  let renewal: Promise<void> | undefined;
  let wakeResolver: (() => void) | undefined;
  let wakeRequested = false;
  let stopping = false;
  let ownershipError: Error | undefined;

  const wake = (): void => {
    wakeRequested = true;
    if (fallback !== undefined) clearTimeout(fallback);
    fallback = undefined;
    const resolve = wakeResolver;
    wakeResolver = undefined;
    resolve?.();
  };
  const onFilesystem = (): void => {
    if (debounce !== undefined) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = undefined;
      wake();
    }, debounceMs);
  };
  const waitForWake = async (): Promise<void> => {
    if (wakeRequested) {
      wakeRequested = false;
      return;
    }
    fallback = setTimeout(wake, fallbackMs);
    await new Promise<void>((resolve) => { wakeResolver = resolve; });
    if (fallback !== undefined) clearTimeout(fallback);
    fallback = undefined;
    wakeRequested = false;
  };
  const stopOrLost = async (): Promise<boolean> => ownershipError !== undefined || await stopRequested(cfg.tasksDir);
  const beat = (): void => {
    heartbeatTimer = setTimeout(() => {
      renewal = (async () => {
        try {
          if (!await heartbeatWatchLock(cfg.tasksDir, owner)) {
            ownershipError = new Error("watch ownership generation changed; no further tasks will be claimed");
            wake();
            return;
          }
          if (!stopping && ownershipError === undefined) beat();
        } catch (error) {
          ownershipError = error instanceof Error ? error : new Error(String(error));
          wake();
        }
      })();
    }, Math.max(1, Math.min(cfg.heartbeatMs, cfg.lockTtlMs / 3)));
  };

  try {
    if (await stopRequested(cfg.tasksDir)) {
      if (!options.resume) throw new Error(`stop is already requested at ${stopRequestPath(cfg.tasksDir)}; use watch --resume to clear it explicitly`);
      // Lock acquisition came first: a second watcher --resume cannot clear a
      // live owner's stop request.
      await rm(stopRequestPath(cfg.tasksDir), { force: true });
    }
    watchers.push(watchFs(cfg.tasksDir, onFilesystem));
    watchers.push(watchFs(controlDir(cfg.tasksDir), onFilesystem));
    beat();

    for (;;) {
      if (await stopRequested(cfg.tasksDir)) return;
      if (ownershipError !== undefined) throw ownershipError;
      const worked = await scheduleOnce(cfg, deps, runOne, runSelected, stopOrLost);
      if (worked) continue;
      await waitForWake();
    }
  } finally {
    stopping = true;
    for (const watcher of watchers.splice(0)) watcher.close();
    if (debounce !== undefined) clearTimeout(debounce);
    if (fallback !== undefined) clearTimeout(fallback);
    if (heartbeatTimer !== undefined) clearTimeout(heartbeatTimer);
    await renewal;
    await releaseWatchLock(cfg.tasksDir, owner);
  }
}

/** One scheduling boundary. Returns false when there is nothing safe to offer. */
async function scheduleOnce(
  cfg: WorkerConfig,
  deps: WorkerDeps,
  runOne: typeof runTask,
  runSelected: typeof runBatch,
  shouldStop: () => Promise<boolean>,
): Promise<boolean> {
  const board = await deps.store.list();
  assertAcyclic(board);
  let candidate = undefined as (typeof board)[number] | undefined;
  for (const task of board) {
    if (task.status === "running" && !await lockLive(cfg.tasksDir, task.id, cfg.lockTtlMs)) {
      candidate = task;
      break;
    }
  }
  if (candidate === undefined) {
    const selected = await selectAutomaticBatch(cfg, board);
    if (selected.length >= 2) {
      // The selection is fixed at this boundary. Arrivals during it are picked
      // up by a later board scan, never appended to the active batch.
      const result = await runSelected(cfg, deps, selected, { shouldStop });
      return result.done.length > 0 || result.stoppedAt !== undefined;
    }
    const done = new Set(board.filter((task) => task.status === "done").map((task) => task.id));
    candidate = selected.length === 1
      ? board.find((task) => task.id === selected[0])
      : ready(board, done)[0];
  }
  if (candidate === undefined) return false;
  const outcome = await runOne(
    { ...cfg, workdir: taskWorkdir(cfg.workdir, candidate) },
    deps,
    candidate,
    `watch-${process.pid}-${candidate.id}`,
  );
  return outcome !== "skipped";
}
