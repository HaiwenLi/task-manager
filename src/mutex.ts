import { mkdir, rmdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

/** Cooperative cross-process exclusion. Never steal a mutex based on age.
 * A crashed holder requires operator reconciliation rather than unsafe replay. */
export async function withMutex<T>(path: string, action: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    try { await mkdir(path); break; }
    catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // Windows can briefly report delete-pending directories as EPERM rather
      // than EEXIST. Retrying is safe: we still require a successful mkdir.
      if (code !== "EEXIST" && !(process.platform === "win32" && (code === "EPERM" || code === "EACCES"))) throw err;
      if (Date.now() >= deadline) throw new Error(`mutex unavailable; reconcile stopped owner before removing ${path}`);
      await delay(10);
    }
  }
  try { return await action(); }
  finally { await rmdir(path); }
}
