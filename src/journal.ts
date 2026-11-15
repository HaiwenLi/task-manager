import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** One journal entry: which stage did what, with an optional one-line detail. */
export type JournalEntry = { stage: string; event: string; detail?: string };

/** Longest detail we keep on one line; longer text is truncated, not wrapped. */
const DETAIL_LIMIT = 500;

/**
 * Append one line to `tasks/<id>/journal.md`. The journal is a human-readable
 * record of what the orchestrator did, not a state store: nothing reads task
 * status back out of it. One line per event keeps `git diff` and `grep` useful.
 */
export async function appendJournal(tasksDir: string, id: string, entry: JournalEntry): Promise<void> {
  const dir = join(tasksDir, id);
  await mkdir(dir, { recursive: true });
  const detail = entry.detail === undefined ? "" : `  ${singleLine(entry.detail)}`;
  await appendFile(join(dir, "journal.md"), `${new Date().toISOString()}  ${entry.stage}  ${entry.event}${detail}\n`, "utf8");
}

/** The last `n` non-empty journal lines, oldest first; a missing journal reads as empty. */
export async function journalTail(tasksDir: string, id: string, n: number): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(join(tasksDir, id, "journal.md"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  return lines.slice(Math.max(0, lines.length - n));
}

/**
 * Collapse newlines and cap the length so one entry can never split a line.
 * Truncation counts code points, so a surrogate pair is never cut in half.
 */
function singleLine(text: string): string {
  const flat = text.replace(/\r\n?|\n/g, "⏎");
  const points = Array.from(flat);
  return points.length <= DETAIL_LIMIT ? flat : `${points.slice(0, DETAIL_LIMIT).join("")}…`;
}
