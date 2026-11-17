import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Task } from "./task-file.js";

export type AttemptRecord = {
  attemptId: string;
  backend: string;
  workspace: string;
  startedAt: string;
  updatedAt: string;
  phase: "active" | "uncertain" | "settled";
  operation: string;
  pid?: number;
  sessionId?: string;
  reason?: string;
};

/** Where the claim-time definition snapshot lives, beside `attempt.json`. */
const DEFINITION_FILE = "definition.json";

/** The definition as it was when the attempt claimed the task. */
export type DefinitionSnapshot = {
  taskId: string;
  /** Digest of {@link definitionFields} at claim time. */
  digest: string;
  /** The digested fields, verbatim, so a drifted attempt can be diffed by hand. */
  fields: Record<string, unknown>;
  at: string;
};

export async function readAttempt(tasksDir: string, id: string): Promise<AttemptRecord | null> {
  try {
    const record = JSON.parse(await readFile(join(tasksDir, id, "attempt.json"), "utf8"));
    if (!record || typeof record.attemptId !== "string" || !["active", "uncertain", "settled"].includes(record.phase)) {
      throw new Error("invalid attempt record; reconcile manually");
    }
    return record;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Read one runtime record; a missing file reads as null. */
export async function readRuntime<T>(tasksDir: string, id: string, name: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(join(tasksDir, id, name), "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function writeRuntime(tasksDir: string, id: string, name: string, record: unknown): Promise<void> {
  const file = join(tasksDir, id, name);
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(record, null, 2), "utf8");
  await rename(tmp, file);
}

/**
 * The fields that make up a task's definition — the ones an attempt is judged
 * against.
 *
 * Narrow on purpose: an operator legitimately edits lifecycle fields while work
 * runs. Lowering `retries` so a task is not exhausted on the next failure,
 * parking a task, appending a session id — none of that changes what "done"
 * means, and none of it may invalidate evidence that was collected under the
 * same definition. (Task 013 run 13: an acceptance that really exited 0 was
 * thrown away because `retries` went 5 → 0 mid-run.)
 *
 * Everything here is instead a statement of intent: what to build, how it will
 * be judged, what it may not be blamed for. `tolerate` and `human_check` are
 * included for the same reason — widening what the reviewer may excuse, or
 * dropping the human gate, after the fact is a different task, not progress on
 * this one.
 */
export function definitionFields(task: Task): Record<string, unknown> {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    acceptance: task.acceptance,
    model: task.model,
    effort: task.effort,
    criteria: task.criteria,
    // How much clarification the task gets, and whether it may finish on its own
    // evidence, decide the bar rather than decorating it.
    complexity: task.complexity,
    risk: task.risk,
    humanCheck: task.humanCheck,
    dependsOn: task.dependsOn,
    // What has to agree the work is done is part of the definition: switching a
    // task from a reviewer's verdict to a render check mid-attempt changes the
    // bar, and must invalidate the attempt rather than be reviewed under it.
    verify: task.verify,
    renderTargets: [...task.renderTargets],
    // Sorted: the same set of tolerated kinds in a different order is the same
    // declaration, and must not invalidate an attempt.
    tolerate: [...task.tolerate].sort(),
  };
}

/** Definition only: orchestrator-owned lifecycle fields do not change intent. */
export function definitionDigest(task: Task): string {
  return createHash("sha256").update(JSON.stringify(definitionFields(task))).digest("hex");
}

/**
 * Persist the definition the attempt is starting under, next to `attempt.json`.
 *
 * The in-memory copy dies with the process; the file is what a later check —
 * acceptance, review, or a takeover after a crash — compares against. That is
 * the whole point of the digest: it must describe the definition the work ran
 * by, not the one that happens to be on disk when the evidence is judged.
 */
export async function writeDefinitionSnapshot(tasksDir: string, task: Task, now: Date = new Date()): Promise<DefinitionSnapshot> {
  const snapshot: DefinitionSnapshot = {
    taskId: task.id,
    digest: definitionDigest(task),
    fields: definitionFields(task),
    at: now.toISOString(),
  };
  await writeRuntime(tasksDir, task.id, DEFINITION_FILE, snapshot);
  return snapshot;
}

/**
 * The claim-time snapshot, or null when this attempt has none (a legacy run, or
 * one whose claim never got that far). Unreadable snapshots read as absent: the
 * caller falls back to its in-memory digest rather than trusting garbage.
 */
export async function readDefinitionSnapshot(tasksDir: string, id: string): Promise<DefinitionSnapshot | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(tasksDir, id, DEFINITION_FILE), "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (err instanceof SyntaxError) return null;
    throw err;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.digest !== "string" || !/^[a-f0-9]{64}$/.test(record.digest)) return null;
  return {
    taskId: typeof record.taskId === "string" ? record.taskId : id,
    digest: record.digest,
    fields: typeof record.fields === "object" && record.fields !== null ? record.fields as Record<string, unknown> : {},
    at: typeof record.at === "string" ? record.at : "",
  };
}
