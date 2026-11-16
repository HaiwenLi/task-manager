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

/** Definition only: orchestrator-owned lifecycle fields do not change intent. */
export function definitionDigest(task: Task): string {
  return createHash("sha256").update(JSON.stringify({ id: task.id, title: task.title,
    description: task.description, acceptance: task.acceptance, model: task.model, effort: task.effort,
    // Criteria and the human gate are part of what "done" means: changing them
    // mid-run must invalidate the acceptance, not silently grandfather it in.
    // A tolerated drift kind is the same kind of change: it decides what the
    // reviewer may excuse, so widening it after the fact would be a new task.
    criteria: task.criteria, risk: task.risk, humanCheck: task.humanCheck, dependsOn: task.dependsOn,
    tolerate: task.tolerate })).digest("hex");
}
