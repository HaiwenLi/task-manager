import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Task } from "./task-file.js";
import { renameWithRetry } from "./replace.js";
import { withMutex } from "./mutex.js";

/** One refusal of one task, as the guard judged it then: the task, the time, the guard's line. */
export type GuardRefusal = { taskId: string; at: string; line: string };

type GuardRefusalRecord = { version: 1; refusals: Record<string, GuardRefusal> };

/** Beside `model-cooldowns.json`, in the control directory (`controlDir`, src/watch-lock.ts). */
const directory = (tasksDir: string) => join(tasksDir, "..", ".taskctl");
const file = (tasksDir: string) => join(directory(tasksDir), "guard-refusals.json");
const lock = (tasksDir: string) => join(directory(tasksDir), "guard-refusals.lock");

/**
 * Record or replace the refusal of one task. Never throws.
 *
 * The record is advisory: a refusal and its line stand without it, so a write
 * that fails is swallowed here. Nothing of it lands in the task's own
 * directory — that guarantee (ADR-0012) is what the record exists to keep.
 */
export async function recordGuardRefusal(tasksDir: string, taskId: string, line: string, now?: Date): Promise<void> {
  const entry: GuardRefusal = { taskId, at: (now ?? new Date()).toISOString(), line };
  try {
    await mutate(tasksDir, (record) => {
      record.refusals[taskId] = entry;
      return record;
    });
  } catch {
    // The refusal and its line stand without the record.
  }
}

/**
 * Remove the entry of one task; nothing is written when it has none. Never
 * throws: a stale entry must never block a task or end a queue.
 */
export async function clearGuardRefusal(tasksDir: string, taskId: string): Promise<void> {
  try {
    if ((await readRecord(tasksDir)).refusals[taskId] === undefined) return;
    await mutate(tasksDir, (record) => {
      delete record.refusals[taskId];
      return record;
    });
  } catch {
    // Advisory: what cannot be cleared changes nothing.
  }
}

/**
 * Remove the entries of tasks that are no longer `open` on the board. Never
 * throws, and a record with nothing to drop is not rewritten — an absent or
 * empty record creates no `.taskctl` and takes no lock.
 */
export async function pruneGuardRefusals(tasksDir: string, board: readonly Pick<Task, "id" | "status">[]): Promise<void> {
  try {
    const record = await readRecord(tasksDir);
    const open = new Set(board.filter((task) => task.status === "open").map((task) => task.id));
    const kept = Object.keys(record.refusals).filter((taskId) => open.has(taskId));
    if (kept.length === Object.keys(record.refusals).length) return;
    await mutate(tasksDir, (current) => {
      for (const taskId of Object.keys(current.refusals)) {
        if (!open.has(taskId)) delete current.refusals[taskId];
      }
      return current;
    });
  } catch {
    // Advisory: what cannot be pruned changes nothing.
  }
}

/** Every entry, by task id. A missing or unreadable record reads as empty. */
export async function readGuardRefusals(tasksDir: string): Promise<GuardRefusal[]> {
  return Object.values((await readRecord(tasksDir)).refusals);
}

/**
 * One locked read-modify-write of the record, shaped like the cooldown table's
 * (`mutate`, src/model-cooldown.ts): the directory is made, the record's own
 * mutex is taken — only a watcher holds the watch lock, so two controllers can
 * be alive on one board — and the replacement lands through a temporary file
 * beside the target. A write that fails removes its temporary file.
 */
async function mutate(tasksDir: string, update: (record: GuardRefusalRecord) => GuardRefusalRecord): Promise<void> {
  await mkdir(directory(tasksDir), { recursive: true });
  await withMutex(lock(tasksDir), async () => {
    const record = update(await readRecord(tasksDir));
    const target = file(tasksDir);
    const tmp = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(record, null, 2), "utf8");
      await renameWithRetry(tmp, target);
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
  });
}

/** The record as it stands, with every entry that is not one read out of it. */
async function readRecord(tasksDir: string): Promise<GuardRefusalRecord> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file(tasksDir), "utf8"));
  } catch {
    return { version: 1, refusals: {} };
  }
  if (typeof parsed !== "object" || parsed === null) return { version: 1, refusals: {} };
  const refusals = (parsed as Record<string, unknown>).refusals;
  if (typeof refusals !== "object" || refusals === null || Array.isArray(refusals)) return { version: 1, refusals: {} };
  const valid: Record<string, GuardRefusal> = {};
  for (const [key, value] of Object.entries(refusals as Record<string, unknown>)) {
    if (!validEntry(key, value)) continue;
    valid[key] = value;
  }
  return { version: 1, refusals: valid };
}

/** An entry counts only when its `taskId` is its key and `at` and `line` are strings. */
function validEntry(taskId: string, value: unknown): value is GuardRefusal {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return entry.taskId === taskId && typeof entry.at === "string" && typeof entry.line === "string";
}
