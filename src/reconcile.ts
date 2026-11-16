import { mkdir, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { LOCK_TTL_MS_DEFAULT, lockLive } from "./claim.js";
import { appendJournal } from "./journal.js";
import { withMutex } from "./mutex.js";
import { readAttempt, type AttemptRecord } from "./runtime.js";
import { TaskStore } from "./task-store.js";
import type { Task } from "./task-file.js";
import { reservationsFor } from "./workspace.js";

/**
 * Operator reconciliation for `blocked` tasks.
 *
 * The controller never retries an interrupted or uncertain execution on its own
 * (ADR-0007). This module turns the *safe half* of the manual recovery procedure
 * into commands: diagnose read-only, and reopen only when the evidence proves
 * nothing is left to run. It deliberately does not kill processes by a recorded
 * PID — ADR-0007 forbids that, because PIDs are reused and nothing in
 * `attempt.json` proves the PID still belongs to that execution.
 */
export type ReconcileVerdict = "retry-allowed" | "already-terminal" | "manual-review";

export type ReconcileFindings = {
  id: string;
  status: Task["status"];
  attempt: AttemptRecord | null;
  lockLive: boolean;
  /** Path whose reservations were inspected, or null when it cannot be known. */
  workspace: string | null;
  reservations: Array<{ token: string; cwd: string }>;
  pid: number | null;
  pidAlive: boolean;
  verdict: ReconcileVerdict;
  notes: string[];
};

export type ReconcileOptions = {
  ttlMs?: number;
  registryDir?: string;
  /** Configured base workdir, used to resolve `task.workdir` when the attempt has none. */
  baseWorkdir?: string;
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

/** The path an execution of this task would own, as far as it can be known. */
export function ownedPath(task: Task, attempt: AttemptRecord | null, baseWorkdir?: string): string | null {
  if (attempt?.workspace !== undefined) return attempt.workspace;
  if (baseWorkdir === undefined) return null;
  return task.workdir === undefined ? baseWorkdir : resolve(baseWorkdir, task.workdir);
}

/** Read-only diagnosis: what would a retry have to clear, and is it safe yet? */
export async function reconcileTask(
  tasksDir: string,
  id: string,
  options: ReconcileOptions = {},
): Promise<ReconcileFindings> {
  const ttlMs = options.ttlMs ?? LOCK_TTL_MS_DEFAULT;
  const store = new TaskStore(tasksDir);
  const task = await store.get(id);
  const attempt = await readAttempt(tasksDir, id);
  const live = await lockLive(tasksDir, id, ttlMs);
  const workspace = ownedPath(task, attempt, options.baseWorkdir);
  const reservations = workspace === null ? [] : await reservationsFor(workspace, options.registryDir);
  const settled = attempt !== null && attempt.phase === "settled";
  const pidAlive = processAlive(attempt?.pid);

  const notes: string[] = [];
  if (attempt === null) notes.push("no attempt.json: reopening only has to flip the status");
  if (attempt !== null && !settled) notes.push(`attempt phase is ${attempt.phase} (${attempt.operation}); it is not settled`);
  if (live) notes.push("a live task lock is still held");
  if (settled && pidAlive) {
    notes.push(`recorded pid ${attempt!.pid} is alive but the attempt is settled: treat it as PID reuse and do not kill it`);
  }
  if (!settled && pidAlive) {
    notes.push(`recorded pid ${attempt!.pid} is alive; taskctl cannot verify it is still this execution, stop it outside taskctl only after checking`);
  }
  if (workspace === null) notes.push("the owned path cannot be determined, so reservations cannot be checked");
  else if (reservations.length > 0) notes.push(`${reservations.length} workspace reservation(s) still cover ${workspace} (${reservations.map((r) => r.token).join(", ")})`);

  let verdict: ReconcileVerdict;
  if (task.status === "done" || task.status === "review" || task.status === "awaiting-human") {
    verdict = "already-terminal";
  } else if (task.status !== "blocked") {
    verdict = "manual-review";
  } else if (attempt !== null && !settled) {
    verdict = "manual-review";
  } else if (live || reservations.length > 0 || workspace === null) {
    verdict = "manual-review";
  } else {
    verdict = "retry-allowed";
  }

  return {
    id,
    status: task.status,
    attempt,
    lockLive: live,
    workspace,
    reservations: reservations.map((record) => ({ token: record.token, cwd: record.cwd })),
    pid: attempt?.pid ?? null,
    pidAlive,
    verdict,
    notes,
  };
}

export type RetryOutcome = { ok: true; archive: string } | { ok: false; reason: string };

/** Files belonging to one attempt; archiving them clears the evidence trail for a rerun. */
const ATTEMPT_EVIDENCE = ["attempt.json", "acceptance.json", "review.json"] as const;

/**
 * Reopen a blocked task whose previous attempt is settled and unreferenced.
 *
 * Guards, in order: blocked status, settled (or absent) attempt, no live task
 * lock, and no workspace reservation for the path this task would own. The
 * checks and the writes run under the same task mutation mutex the controller
 * uses, so a concurrent claim cannot slip between them.
 */
export async function retryTask(
  tasksDir: string,
  id: string,
  options: ReconcileOptions & { now?: Date } = {},
): Promise<RetryOutcome> {
  const ttlMs = options.ttlMs ?? LOCK_TTL_MS_DEFAULT;
  const now = options.now ?? new Date();
  const refusal = await retryRefusal(tasksDir, id, options, ttlMs);
  if (refusal !== null) return { ok: false, reason: refusal };

  return withMutex(join(tasksDir, id, ".mutation.lock"), async (): Promise<RetryOutcome> => {
    // Re-read inside the mutex: the guards above ran against an earlier snapshot.
    const again = await retryRefusal(tasksDir, id, options, ttlMs);
    if (again !== null) return { ok: false, reason: again };

    const stamp = now.toISOString().replace(/[:.]/g, "-");
    const archive = join(tasksDir, id, "archive", stamp);
    await mkdir(archive, { recursive: true });
    for (const name of ATTEMPT_EVIDENCE) {
      await rename(join(tasksDir, id, name), join(archive, name)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    const store = new TaskStore(tasksDir);
    await store.updateFields(id, { retries: 0, reviewRounds: 0 });
    await store.setStatus(id, "open");
    await appendJournal(tasksDir, id, { stage: "human", event: "retry", detail: `archived to ${archive}` });
    return { ok: true, archive };
  });
}

/** Every reason a retry must be refused, or null when it is safe. */
async function retryRefusal(
  tasksDir: string,
  id: string,
  options: ReconcileOptions,
  ttlMs: number,
): Promise<string | null> {
  const store = new TaskStore(tasksDir);
  const task = await store.get(id);
  if (task.status !== "blocked") return `task ${id} is ${task.status}; retry only reopens blocked tasks`;

  const attempt = await readAttempt(tasksDir, id);
  if (attempt !== null && attempt.phase !== "settled") {
    return `attempt ${attempt.attemptId} is ${attempt.phase}; confirm the execution is gone and settle it manually first`;
  }
  if (await lockLive(tasksDir, id, ttlMs)) return "a live task lock is still held";

  const workspace = ownedPath(task, attempt, options.baseWorkdir);
  if (workspace === null) return "the owned workspace path cannot be determined; pass --config with workdir";
  const covered = await reservationsFor(workspace, options.registryDir);
  if (covered.length > 0) {
    return `workspace ${workspace} is still reserved (${covered.map((record) => record.token).join(", ")})`;
  }
  return null;
}
