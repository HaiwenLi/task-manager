import { lstat, rename } from "node:fs/promises";

/**
 * Backoff for a rename that Windows refused.
 *
 * `rename` onto an existing file is not atomic-with-wait on Windows: while
 * another process holds a handle on the destination (an editor, a watcher, or
 * the second of two `taskctl board` runs) it fails with `EPERM` instead of
 * waiting. The failure is transient by nature — the handle goes away — so the
 * replacement is retried a bounded number of times rather than turned into an
 * error on the first collision. The total ceiling is ~3.9s, well under the
 * interval at which a person retries a command by hand.
 *
 * Every replace of an existing file goes through here. While only the board
 * did, one refused rename of a lock file cancelled the turn that was running,
 * and one refused rotation record blocked a task as "quota exhausted on every
 * model" while every model was healthy.
 */
const RENAME_RETRY_DELAYS_MS: readonly number[] = [5, 25, 125, 625, 3125];

/**
 * Errors that mean "the destination was busy", not "the write is wrong".
 * `ENOENT` (the temp file vanished), a full disk and everything else propagate
 * on the first attempt: retrying them only delays the same error.
 */
const TRANSIENT_RENAME_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

/** Whether `path` is a directory. Anything else, including a missing path, is not. */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Rename, retrying only a destination held by a concurrent handle. */
export async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const delay = RENAME_RETRY_DELAYS_MS[attempt];
      if (code === undefined || !TRANSIENT_RENAME_CODES.has(code) || delay === undefined) throw err;
      // Windows refuses a rename onto a directory with the same EPERM as a busy
      // file. No wait makes the destination stop being a directory, so this
      // refusal is final: it is reported now, not after the whole budget.
      if (await isDirectory(to)) throw err;
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
}
