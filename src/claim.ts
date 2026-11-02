import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { withMutex } from "./mutex.js";

/** Lock file name inside the per-task auxiliary directory `tasks/<id>/`. */
const LOCK_FILE = "lock.json";

/** A live worker must refresh its lock at least this often (ADR-0001). */
export const LOCK_TTL_MS_DEFAULT = 10 * 60_000;

/** Contents of `lock.json`: who owns the task and when it last checked in. */
export type Lock = {
  worker: string;
  /** Epoch milliseconds of the last heartbeat. */
  heartbeat: number;
};

type LockState =
  | { status: "missing" }
  | { status: "corrupt" }
  | { status: "held"; lock: Lock };

/**
 * Atomically take ownership of a task by creating `tasks/<id>/lock.json`
 * ("create is claim": `open 'wx'` fails with EEXIST if anyone got there
 * first). Returns false when a live lock is held — by any worker,
 * including the caller. An expired lock may be taken over:
 * the old lock is archived as `lock.json.stale-<ts>` and a fresh one is
 * created under the same mutex as renewal, release, and guarded writes.
 * Ownership takeover alone does NOT authorize replay of previous execution.
 * `ttlMs` governs the staleness window (the caller passes its configured
 * `lockTtlMs`; the documented ten-minute default applies when omitted).
 */
export async function claim(
  tasksDir: string,
  taskId: string,
  workerId: string,
  ttlMs: number = LOCK_TTL_MS_DEFAULT,
): Promise<boolean> {
  const auxDir = join(tasksDir, taskId);
  await mkdir(auxDir, { recursive: true });
  return withMutex(join(auxDir, ".mutation.lock"), async () => {
    const lockPath = join(auxDir, LOCK_FILE);
    const lock: Lock = { worker: workerId, heartbeat: Date.now() };
    if (await tryCreateLock(lockPath, lock)) return true;
    if (!(await isStale(lockPath, ttlMs))) return false;
    // Legacy/manual writers may still remove the file outside the protocol.
    try {
      await rename(lockPath, `${lockPath}.stale-${Date.now()}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    return tryCreateLock(lockPath, lock);
  });
}

/**
 * Refresh the heartbeat of a lock the worker still owns. Returns true when
 * the refresh landed — the caller is still the owner and may keep working.
 * Returns false when the lock is missing, torn, or already held by someone
 * else: the caller must stop touching the task immediately ("心跳停 →
 * 接管" cuts both ways — a heartbeat must never resurrect a worker over
 * the new owner, and the old owner must never release the new owner's
 * lock or keep mutating the task).
 */
export async function heartbeat(tasksDir: string, taskId: string, workerId: string): Promise<boolean> {
  if ((await readLockState(join(tasksDir, taskId, LOCK_FILE))).status === "missing") return false;
  return withMutex(join(tasksDir, taskId, ".mutation.lock"), async () => {
    const lockPath = join(tasksDir, taskId, LOCK_FILE);
    const state = await readLockState(lockPath);
    if (state.status !== "held" || state.lock.worker !== workerId) return false;
    const tmp = `${lockPath}.tmp`;
    await writeFile(tmp, JSON.stringify({ worker: workerId, heartbeat: Date.now() } satisfies Lock), "utf8");
    await rename(tmp, lockPath);
    return true;
  });
}

/**
 * Drop the lock; releasing an absent lock is a no-op. With `expectedWorker`,
 * a lock that has since been taken over by someone else is left alone — a
 * terminal release must never delete the successor's lock. With an expected
 * generation, missing or corrupt locks are also left alone.
 */
export async function release(tasksDir: string, taskId: string, expectedWorker?: string): Promise<void> {
  await mkdir(join(tasksDir, taskId), { recursive: true });
  return withMutex(join(tasksDir, taskId, ".mutation.lock"), async () => {
    const lockPath = join(tasksDir, taskId, LOCK_FILE);
    if (expectedWorker !== undefined) {
      const state = await readLockState(lockPath);
      if (state.status !== "held" || state.lock.worker !== expectedWorker) return;
    }
    await rm(lockPath, { force: true });
  });
}

export class OwnershipLostError extends Error {
  constructor() { super("task ownership generation changed"); }
}

/** The check and action share the takeover mutex; not a check-then-write. */
export async function withOwnership<T>(tasksDir: string, taskId: string, workerId: string, action: () => Promise<T>): Promise<T> {
  return withMutex(join(tasksDir, taskId, ".mutation.lock"), async () => {
    const state = await readLockState(join(tasksDir, taskId, LOCK_FILE));
    if (state.status !== "held" || state.lock.worker !== workerId) throw new OwnershipLostError();
    return action();
  });
}

/**
 * True while a live (fresh) lock exists, held by anyone: a `running` task
 * with a live lock has an active owner and must be left alone. A missing,
 * corrupt or stale lock reads as not-live, so the caller may attempt a
 * takeover (`claim` remains the atomic authority on who wins).
 */
export async function lockLive(tasksDir: string, taskId: string, ttlMs: number): Promise<boolean> {
  const state = await readLockState(join(tasksDir, taskId, LOCK_FILE));
  if (state.status !== "held") {
    return false;
  }
  return Date.now() - state.lock.heartbeat <= ttlMs;
}

/**
 * True when the lock's heartbeat is older than `ttlMs`. A missing lock is
 * not stale (nothing is held); a corrupt one is — liveness cannot be
 * proven, so a crashed mid-write holder must not wedge the task.
 */
export async function isStale(lockPath: string, ttlMs: number): Promise<boolean> {
  const state = await readLockState(lockPath);
  if (state.status === "missing") {
    return false;
  }
  if (state.status === "corrupt") {
    return true;
  }
  return Date.now() - state.lock.heartbeat > ttlMs;
}

/** Create `lockPath` exclusively; the create itself is the claim. */
async function tryCreateLock(lockPath: string, lock: Lock): Promise<boolean> {
  let handle: FileHandle;
  try {
    handle = await open(lockPath, "wx");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw err;
  }
  try {
    await handle.writeFile(JSON.stringify(lock), "utf8");
  } finally {
    await handle.close();
  }
  return true;
}

/** Read a lock file, distinguishing absent from unparsable. */
async function readLockState(lockPath: string): Promise<LockState> {
  let raw: string;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "missing" };
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "corrupt" };
  }
  if (typeof parsed === "object" && parsed !== null) {
    const { worker, heartbeat } = parsed as Record<string, unknown>;
    if (typeof worker === "string" && typeof heartbeat === "number" && Number.isFinite(heartbeat)) {
      return { status: "held", lock: { worker, heartbeat } };
    }
  }
  return { status: "corrupt" };
}
