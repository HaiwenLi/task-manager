import { randomUUID } from "node:crypto";
import { watch as fsWatch } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { readyTasks, runBatch, selectAutomaticBatch } from "./batch.js";
import { lockLive } from "./claim.js";
import { assertAcyclic, taskWorkdir } from "./scheduler.js";
import { runTask, type WorkerConfig, type WorkerDeps } from "./worker.js";
import { controlDir, acquireWatchLock, heartbeatWatchLock, releaseWatchLock } from "./watch-lock.js";

export const stopRequestPath = (tasksDir: string): string => join(controlDir(tasksDir), "stop.requested");

/**
 * How long the queue leaves a task the budget guard refused out of its
 * candidates before it offers the task again. Offering it at every wake would
 * not change the answer: the policy is fixed for the life of the process, and
 * a catalogue that was read is remembered. What can have changed by then is a
 * catalogue that could not be read — a backend that was down, or that answered
 * nothing — because a failed read is never remembered and is asked for again.
 */
export const REFUSED_RETRY_MS = 300_000;

/** Minimal filesystem seam: production uses `fs.watch`; tests fire listeners. */
export type WatchFs = (path: string, listener: () => void) => { close(): void };

export type WatchOptions = {
  resume?: boolean;
  debounceMs?: number;
  fallbackMs?: number;
  runOne?: typeof runTask;
  runBatch?: typeof runBatch;
  watchFs?: WatchFs;
  /** Sees each scheduling error the queue survives, so the operator learns why it is waiting. */
  onError?: (message: string) => void;
  /** Test seam; production uses {@link REFUSED_RETRY_MS}. */
  refusedRetryMs?: number;
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
 * The production watcher. A watcher error (its directory removed, a handle
 * limit) is kept off the uncaught-exception path: an `error` event with no
 * listener is thrown by the emitter, which would bypass the lock release in
 * `watchQueue`. The fallback scan still wakes the loop meanwhile.
 */
export function watchDirectory(path: string, listener: () => void): { close(): void } {
  const watcher = fsWatch(path, listener);
  watcher.on("error", () => {});
  return watcher;
}

/**
 * Own and drain one board until `.taskctl/stop.requested` appears. The loop is
 * sequential on purpose: new arrivals are considered only between operations,
 * and a stop never becomes a process-tree kill or an uncertain replay.
 *
 * A task the budget guard refused is left out of the candidates for a while
 * and judged again after that (see {@link scheduleOnce}), so the task behind
 * it is run instead of the refused one being offered at every wake.
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
  const watchFs: WatchFs = options.watchFs ?? watchDirectory;
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
  let heartbeatFailureReported = false;
  // When each task was last refused by the budget guard: this queue's own memory, for as long as the queue lives.
  const refusedAt = new Map<string, number>();
  const refusedRetryMs = options.refusedRetryMs ?? REFUSED_RETRY_MS;

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
          // Only a lock that is no longer ours ends the watch (the branch
          // above). A heartbeat that could not be written says nothing about who
          // holds the lock record, so the watcher reports it once and the next
          // tick tries again.
          if (!heartbeatFailureReported) {
            heartbeatFailureReported = true;
            options.onError?.(`watch heartbeat could not be written (${error instanceof Error ? error.message : String(error)}); the lock is still held, the next heartbeat retries`);
          }
          if (!stopping && ownershipError === undefined) beat();
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
      let scheduled: Awaited<ReturnType<typeof scheduleOnce>>;
      try {
        scheduled = await scheduleOnce(cfg, deps, runOne, runSelected, stopOrLost, refusedAt, refusedRetryMs);
      } catch (error) {
        if (ownershipError !== undefined) throw ownershipError;
        // A board that cannot be scheduled right now — a hand-edited file with
        // a typo, a dependency cycle, a selection another controller claimed
        // first — is not a reason to abandon a long-lived manager. Say what was
        // seen and wait for the next change: the fallback scan retries, so the
        // queue resumes by itself once the board is mended, and `stop` still ends it.
        const message = error instanceof Error ? error.message : String(error);
        options.onError?.(`scheduling paused: ${message.replace(/\s+/g, " ").slice(0, 500)}; waiting for the next change`);
        await waitForWake();
        continue;
      }
      if (scheduled === "stopped") {
        if (ownershipError !== undefined) throw ownershipError;
        return;
      }
      if (scheduled === "worked") continue;
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

/** One scheduling boundary. Only a worked cycle justifies an immediate fresh snapshot. */
async function scheduleOnce(
  cfg: WorkerConfig,
  deps: WorkerDeps,
  runOne: typeof runTask,
  runSelected: typeof runBatch,
  shouldStop: () => Promise<boolean>,
  /** When each task was last refused by the budget guard; the queue's own memory. */
  refusedAt: Map<string, number>,
  retryMs: number,
): Promise<"worked" | "wait" | "stopped"> {
  // A task refused lately is *cooling*: to offer it again now would only ask
  // the guard the same question and get the same answer.
  const cooling = (id: string): boolean => {
    const at = refusedAt.get(id);
    return at !== undefined && Date.now() - at < retryMs;
  };
  const board = await deps.store.list();
  assertAcyclic(board);
  let candidate = undefined as (typeof board)[number] | undefined;
  // Before anything else, and whatever the guard says about the task: a dead
  // lock must still be taken over. But a task the guard refused is left out
  // until the retry interval has passed, like any other — offered at every
  // wake, it would be refused at every wake, and the rest of the board would
  // never run.
  for (const task of board) {
    if (task.status === "running" && !cooling(task.id) && !await lockLive(cfg.tasksDir, task.id, cfg.lockTtlMs)) {
      candidate = task;
      break;
    }
  }
  if (candidate === undefined) {
    // The selection still sees the whole board, because dependencies have to
    // resolve; a cooling task is only taken out of what it selected.
    const selected = (await selectAutomaticBatch(cfg, board)).filter((id) => !cooling(id));
    if (selected.length >= 2) {
      // The selection is fixed at this boundary. Arrivals during it are picked
      // up by a later board scan, never appended to the active batch.
      const result = await runSelected(cfg, deps, selected, { shouldStop });
      if (result.stoppedAt !== undefined && result.outcome === "refused") {
        refusedAt.set(result.stoppedAt, Date.now());
        // The refusal itself ran nothing, so when nothing else in the batch
        // did either it is no reason for an immediate fresh snapshot: the
        // queue waits, and the next pass leaves the task out. What the batch
        // finished before the refusal may have made other tasks eligible,
        // and those are not worth waiting for: the next pass leaves the
        // refused task out just the same, so nothing can spin.
        return result.done.length > 0 ? "worked" : "wait";
      }
      // A batch that exhausted its open budget did no terminal work: wait for
      // the next event/fallback exactly like the ordinary open outcome.
      return result.done.length > 0 || (result.stoppedAt !== undefined && result.outcome !== "open")
        ? "worked"
        : "wait";
    }
    candidate = selected.length === 1
      ? board.find((task) => task.id === selected[0])
      : readyTasks(board).find((task) => !cooling(task.id));
  }
  if (candidate === undefined) return "wait";
  // Selection has several await boundaries. Stop and heartbeat loss must be
  // rechecked here, next to the ordinary claim, not only at the outer loop.
  if (await shouldStop()) return "stopped";
  const outcome = await runOne(
    { ...cfg, workdir: taskWorkdir(cfg.workdir, candidate) },
    deps,
    candidate,
    `watch-${process.pid}-${candidate.id}`,
  );
  if (outcome === "refused") refusedAt.set(candidate.id, Date.now());
  return outcome === "open" || outcome === "skipped" || outcome === "refused" ? "wait" : "worked";
}
