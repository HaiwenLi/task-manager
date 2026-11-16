import { spawn } from "node:child_process";
import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { LOCK_TTL_MS_DEFAULT, lockLive } from "./claim.js";
import { appendJournal } from "./journal.js";
import { readAttempt, writeRuntime, type AttemptRecord } from "./runtime.js";
import { TaskStore } from "./task-store.js";
import type { TaskStatus } from "./task-file.js";
import { reservationsFor } from "./workspace.js";

/**
 * Operator reconciliation for `blocked` tasks.
 *
 * The controller never retries an interrupted or uncertain execution on its own
 * (ADR-0007). These helpers turn the manual recovery procedure from the README
 * into commands, while keeping the same rules: an execution that may still be
 * running is never replayed, and a retry only ever starts from evidence that
 * nothing is left to run.
 */
export type ReconcileVerdict = "retry-allowed" | "stop-process-first" | "already-terminal" | "manual-review";

export type ReconcileFindings = {
  id: string;
  status: TaskStatus;
  attempt: AttemptRecord | null;
  lockLive: boolean;
  reservations: Array<{ token: string; cwd: string }>;
  pid: number | null;
  pidAlive: boolean;
  verdict: ReconcileVerdict;
  notes: string[];
};

function processAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Read-only diagnosis: what would a retry have to clear, and is it safe yet? */
export async function reconcileTask(
  tasksDir: string,
  id: string,
  ttlMs: number = LOCK_TTL_MS_DEFAULT,
  registryDir?: string,
): Promise<ReconcileFindings> {
  const store = new TaskStore(tasksDir);
  const task = await store.get(id);
  const attempt = await readAttempt(tasksDir, id);
  const live = await lockLive(tasksDir, id, ttlMs);
  const alive = processAlive(attempt?.pid);
  const reservations = attempt?.workspace === undefined ? [] : await reservationsFor(attempt.workspace, registryDir);

  const notes: string[] = [];
  if (attempt === null) notes.push("no attempt.json: a retry only has to reopen the task");
  if (attempt !== null && attempt.phase !== "settled") {
    notes.push(`attempt phase is ${attempt.phase} (${attempt.operation})`);
  }
  if (live) notes.push("a live task lock is still held");
  if (alive) notes.push(`attempt pid ${attempt!.pid} is still alive`);
  if (reservations.length > 0) {
    notes.push(`${reservations.length} workspace reservation(s) still cover ${attempt!.workspace}`);
  }
  if (task.status === "done" || task.status === "review" || task.status === "awaiting-human") {
    notes.push(`task is ${task.status}; nothing to reconcile`);
  }

  let verdict: ReconcileVerdict;
  if (task.status === "open" || task.status === "running") verdict = "manual-review";
  else if (task.status === "done" || task.status === "review" || task.status === "awaiting-human") verdict = "already-terminal";
  else if (alive) verdict = "stop-process-first";
  else if (attempt !== null && attempt.phase !== "settled") verdict = "manual-review";
  else if (live || reservations.length > 0) verdict = "manual-review";
  else verdict = "retry-allowed";

  return {
    id,
    status: task.status,
    attempt,
    lockLive: live,
    reservations: reservations.map((record) => ({ token: record.token, cwd: record.cwd })),
    pid: attempt?.pid ?? null,
    pidAlive: alive,
    verdict,
    notes,
  };
}

export type RetryOutcome = { ok: true; archive: string } | { ok: false; reason: string };

/**
 * Reopen a blocked task after the operator has confirmed nothing is still
 * running: archive the previous attempt evidence, reset the attempt counters and
 * set the task back to `open`. Refuses whenever any evidence of a live execution
 * remains — that is the whole point of the guard.
 */
export async function retryTask(
  tasksDir: string,
  id: string,
  ttlMs: number = LOCK_TTL_MS_DEFAULT,
  now: Date = new Date(),
  registryDir?: string,
): Promise<RetryOutcome> {
  const store = new TaskStore(tasksDir);
  const task = await store.get(id);
  if (task.status !== "blocked") {
    return { ok: false, reason: `task ${id} is ${task.status}; retry only reopens blocked tasks` };
  }
  const attempt = await readAttempt(tasksDir, id);
  if (attempt !== null && attempt.phase !== "settled") {
    return { ok: false, reason: `attempt ${attempt.attemptId} is ${attempt.phase}; stop the execution and reconcile first` };
  }
  if (await lockLive(tasksDir, id, ttlMs)) {
    return { ok: false, reason: "a live task lock is still held" };
  }
  if (attempt?.workspace !== undefined) {
    const covered = await reservationsFor(attempt.workspace, registryDir);
    if (covered.length > 0) {
      return {
        ok: false,
        reason: `workspace ${attempt.workspace} is still reserved (${covered.map((record) => record.token).join(", ")})`,
      };
    }
  }

  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const archive = join(tasksDir, id, "archive", stamp);
  await mkdir(archive, { recursive: true });
  for (const name of ["attempt.json", "acceptance.json", "review.json"]) {
    await rename(join(tasksDir, id, name), join(archive, name)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  await store.updateFields(id, { retries: 0, reviewRounds: 0 });
  await store.setStatus(id, "open");
  await appendJournal(tasksDir, id, { stage: "human", event: "retry", detail: `archived to ${archive}` });
  return { ok: true, archive };
}

export type CancelOutcome = { stopped: boolean; reason: string; pid: number | null };

/** Stop the recorded execution tree, then mark the attempt uncertain for review. */
export async function cancelTask(
  tasksDir: string,
  id: string,
  now: Date = new Date(),
): Promise<CancelOutcome> {
  const attempt = await readAttempt(tasksDir, id);
  if (attempt?.pid === undefined) {
    return { stopped: false, reason: "no pid recorded in attempt.json; nothing to stop", pid: null };
  }
  if (!processAlive(attempt.pid)) {
    return { stopped: true, reason: `pid ${attempt.pid} already gone`, pid: attempt.pid };
  }
  const killed = await killTree(attempt.pid);
  if (!killed) {
    return { stopped: false, reason: `could not stop pid ${attempt.pid}; reconcile manually`, pid: attempt.pid };
  }
  await writeRuntime(tasksDir, id, "attempt.json", {
    ...attempt,
    phase: "uncertain",
    reason: `operator cancelled at ${now.toISOString()}`,
    updatedAt: now.toISOString(),
  });
  await appendJournal(tasksDir, id, { stage: "human", event: "cancel", detail: `stopped pid ${attempt.pid}` });
  return { stopped: true, reason: `stopped pid ${attempt.pid}`, pid: attempt.pid };
}

function killTree(pid: number): Promise<boolean> {
  if (process.platform === "win32") {
    return new Promise((resolvePromise) => {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("error", () => resolvePromise(false));
      killer.once("close", (code) => resolvePromise(code === 0));
    });
  }
  try {
    process.kill(-pid, "SIGKILL");
    return Promise.resolve(true);
  } catch {
    return Promise.resolve(false);
  }
}
