import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { renameWithRetry } from "./replace.js";
import { join } from "node:path";
import { withMutex } from "./mutex.js";

/** The sibling `.taskctl` runtime-control directory shared by watch paths. */
export const controlDir = (tasksDir: string): string => join(tasksDir, "..", ".taskctl");
export const watchLockPath = (tasksDir: string): string => join(controlDir(tasksDir), "watch.lock");
const watchMutexPath = (tasksDir: string): string => join(controlDir(tasksDir), ".watch-mutation.lock");

type WatchLock = { worker: string; heartbeat: number };
type LockState =
  | { status: "missing" }
  | { status: "corrupt" }
  | { status: "held"; lock: WatchLock };

export type WatchLockAcquisition =
  | { acquired: true }
  | { acquired: false; reason: "held" | "stale" | "corrupt"; detail: string };

/**
 * Acquire the board's single watch owner by create-exclusive. Unlike task
 * takeover, a stale watch record is not evidence that replay is safe: diagnose
 * it and leave the file for the operator to reconcile.
 */
export async function acquireWatchLock(
  tasksDir: string,
  owner: string,
  ttlMs: number,
): Promise<WatchLockAcquisition> {
  await mkdir(controlDir(tasksDir), { recursive: true });
  return withMutex(watchMutexPath(tasksDir), async () => {
    const path = watchLockPath(tasksDir);
    const lock: WatchLock = { worker: owner, heartbeat: Date.now() };
    if (await tryCreate(path, lock)) return { acquired: true };
    const state = await readState(path);
    if (state.status === "missing") {
      // A legacy writer removed it outside the mutex. One retry is still an
      // atomic create; no existing record is overwritten.
      if (await tryCreate(path, lock)) return { acquired: true };
      return { acquired: false, reason: "corrupt", detail: "watch lock changed while it was being acquired" };
    }
    if (state.status === "corrupt") {
      return { acquired: false, reason: "corrupt", detail: `corrupt watch lock ${path}; reconcile it manually` };
    }
    if (Date.now() - state.lock.heartbeat > ttlMs) {
      return {
        acquired: false,
        reason: "stale",
        detail: `stale watch lock ${path} (owner ${state.lock.worker}, heartbeat ${new Date(state.lock.heartbeat).toISOString()}); confirm the owner is gone before removing it`,
      };
    }
    return {
      acquired: false,
      reason: "held",
      detail: `watch lock held by ${state.lock.worker}; a second watcher will not poll or dispatch`,
    };
  });
}

/**
 * The name of the live watch owner, or null. A missing, corrupt or stale
 * record is no live controller: `run` may start then, and a stale record is
 * the watch's own diagnosis to make, not this reader's to steal.
 */
export async function liveWatchOwner(tasksDir: string, ttlMs: number, now = Date.now()): Promise<string | null> {
  const state = await readState(watchLockPath(tasksDir));
  if (state.status !== "held") return null;
  return now - state.lock.heartbeat <= ttlMs ? state.lock.worker : null;
}

/** Refresh only the complete owner generation that still holds the record. */
export async function heartbeatWatchLock(tasksDir: string, owner: string): Promise<boolean> {
  const path = watchLockPath(tasksDir);
  if ((await readState(path)).status === "missing") return false;
  return withMutex(watchMutexPath(tasksDir), async () => {
    const state = await readState(path);
    if (state.status !== "held" || state.lock.worker !== owner) return false;
    const temporary = `${path}.tmp`;
    await writeFile(temporary, JSON.stringify({ worker: owner, heartbeat: Date.now() } satisfies WatchLock), "utf8");
    await renameWithRetry(temporary, path);
    return true;
  });
}

/** Release only our own generation; a successor's record is left untouched. */
export async function releaseWatchLock(tasksDir: string, owner: string): Promise<void> {
  await mkdir(controlDir(tasksDir), { recursive: true });
  return withMutex(watchMutexPath(tasksDir), async () => {
    const path = watchLockPath(tasksDir);
    const state = await readState(path);
    if (state.status !== "held" || state.lock.worker !== owner) return;
    await rm(path, { force: true });
  });
}

async function tryCreate(path: string, lock: WatchLock): Promise<boolean> {
  let handle: FileHandle;
  try {
    handle = await open(path, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify(lock), "utf8");
  } finally {
    await handle.close();
  }
  return true;
}

async function readState(path: string): Promise<LockState> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.worker === "string" && typeof parsed.heartbeat === "number" && Number.isFinite(parsed.heartbeat)) {
      return { status: "held", lock: { worker: parsed.worker, heartbeat: parsed.heartbeat } };
    }
  } catch {
    // Fall through to the same conservative diagnosis as a valid JSON value
    // with the wrong shape.
  }
  return { status: "corrupt" };
}
