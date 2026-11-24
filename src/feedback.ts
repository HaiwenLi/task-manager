import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { renameWithRetry } from "./replace.js";
import { join } from "node:path";
import type { AuditStage } from "./audit.js";
import { detectType, TEMPLATES, type TaskType } from "./intake.js";
import { readRuntime } from "./runtime.js";

/**
 * How a human note reached taskctl. `answer` is the operator answering intake
 * questions; the others are judgements on work that came back.
 */
export type FeedbackAction = "reject" | "audit" | "accept" | "answer";

/**
 * One human-authored note, stored verbatim. Nothing in this file is ever
 * written by a model: it is the inspectable record of what a person corrected,
 * and a clarify session reads a bounded slice of it instead of repeating a
 * question or a mistake.
 */
export type FeedbackRecord = {
  task: string;
  /**
   * Title of the judged task as it was when the note was written. It is what
   * makes a note findable for similar later work.
   */
  title?: string;
  action: FeedbackAction;
  verdict: "pass" | "fail";
  stage: AuditStage;
  /** Intake type the task was recorded under; absent when unknown. */
  taskType?: TaskType;
  note: string;
  at: string;
};

/** What a command knows when it asks for a note to be recorded. */
export type FeedbackEvent = Pick<FeedbackRecord, "action" | "verdict" | "stage" | "note">;

/** Newest records kept in the file. */
export const FEEDBACK_LIMIT = 200;
/** Longest note kept, in code points. */
export const FEEDBACK_NOTE_LIMIT = 600;
/** Longest packet handed to one clarify session: entries, and code points in total. */
export const FEEDBACK_PACKET_ENTRIES = 8;
export const FEEDBACK_PACKET_CHARS = 3_000;

const ACTIONS: readonly FeedbackAction[] = ["reject", "audit", "accept", "answer"];
const STAGES: readonly AuditStage[] = ["clarify", "worker", "reviewer", "none"];

/** `.taskctl/feedback.jsonl` next to the tasks dir — readable, editable, not state. */
export function feedbackPath(tasksDir: string): string {
  return join(tasksDir, "..", ".taskctl", "feedback.jsonl");
}

/**
 * Append one human note. Returns false, and writes nothing, for an empty note:
 * a plain pass carries no correction, so it must not become a "preference".
 *
 * The common path is an append. Only once the file holds {@link FEEDBACK_LIMIT}
 * lines is it compacted (atomically) down to the newest records, so a wrong
 * note can still be deleted by hand without touching anything else.
 */
export async function recordFeedback(tasksDir: string, record: FeedbackRecord): Promise<boolean> {
  const note = clip(record.note.trim(), FEEDBACK_NOTE_LIMIT);
  if (note.length === 0) return false;
  const kept = { ...record, note };
  const file = feedbackPath(tasksDir);
  await mkdir(join(file, ".."), { recursive: true });
  let raw = "";
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < FEEDBACK_LIMIT) {
    await appendFile(file, `${JSON.stringify(kept)}\n`, "utf8");
    return true;
  }
  // Compaction also drops corrupt lines: what is rewritten is what parses.
  const valid = lines.flatMap((line) => {
    const parsed = parseRecord(line);
    return parsed === null ? [] : [parsed];
  });
  const recent = [...valid.slice(valid.length - (FEEDBACK_LIMIT - 1)), kept];
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, recent.map((entry) => `${JSON.stringify(entry)}\n`).join(""), "utf8");
  await renameWithRetry(tmp, file);
  return true;
}

/** All records, oldest first. A missing file reads as empty; a corrupt line is skipped. */
export async function readFeedback(tasksDir: string): Promise<FeedbackRecord[]> {
  let raw: string;
  try {
    raw = await readFile(feedbackPath(tasksDir), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return raw.split(/\r?\n/).flatMap((line) => {
    const parsed = parseRecord(line);
    return parsed === null ? [] : [parsed];
  });
}

/**
 * The notes worth showing one clarify session, best first — or `null` when
 * there is nothing of that task type.
 *
 * Selection is deterministic and cheap: notes of another task type are left
 * out, the rest are ranked by how many literal keywords they share with the
 * new intent, newest first on a tie, and the packet stops at an entry count
 * and a character budget. No embedding, no model call.
 */
export function selectRelevantFeedback(
  records: FeedbackRecord[],
  target: { type: TaskType; intent: string },
  limits: { entries: number; chars: number } = { entries: FEEDBACK_PACKET_ENTRIES, chars: FEEDBACK_PACKET_CHARS },
): FeedbackRecord[] {
  const wanted = keywords(target.intent);
  const ranked = records
    .flatMap((record, index) => {
      if (record.taskType !== undefined && record.taskType !== target.type) return [];
      const score = overlap(wanted, keywords(`${record.title ?? ""}\n${record.note}`));
      return [{ record, index, score }];
    })
    .sort((a, b) => b.score - a.score || b.record.at.localeCompare(a.record.at) || b.index - a.index);
  const chosen: FeedbackRecord[] = [];
  let used = 0;
  for (const { record } of ranked) {
    const cost = Array.from(renderEntry(record)).length;
    // The best note is always kept, whatever its length.
    if (chosen.length > 0 && (chosen.length >= limits.entries || used + cost > limits.chars)) break;
    chosen.push(record);
    used += cost;
  }
  return chosen;
}

/** {@link selectRelevantFeedback} rendered for the clarify prompt, or `null` when empty. */
export async function readRelevantFeedback(
  tasksDir: string,
  target: { type: TaskType; intent: string },
): Promise<string | null> {
  const chosen = selectRelevantFeedback(await readFeedback(tasksDir), target);
  return chosen.length === 0 ? null : chosen.map(renderEntry).join("\n");
}

/**
 * Record a note about one task, attributing it to the type that task was
 * recorded under. A task that never went through `add` (or whose record is
 * unreadable) is typed from its own text, the same way `add` would have.
 */
export async function recordTaskFeedback(
  tasksDir: string,
  task: { id: string; title: string; description: string },
  event: FeedbackEvent,
  at: Date = new Date(),
): Promise<boolean> {
  return recordFeedback(tasksDir, {
    task: task.id,
    title: task.title,
    taskType: await recordedTaskType(tasksDir, task),
    action: event.action,
    verdict: event.verdict,
    stage: event.stage,
    note: event.note,
    at: at.toISOString(),
  });
}

async function recordedTaskType(tasksDir: string, task: { id: string; title: string; description: string }): Promise<TaskType> {
  let recorded: { type?: unknown } | null = null;
  try {
    recorded = await readRuntime<{ type?: unknown }>(tasksDir, task.id, "classification.json");
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
  }
  const type = recorded?.type;
  return typeof type === "string" && Object.hasOwn(TEMPLATES, type) ? (type as TaskType) : detectType(`${task.title} ${task.description}`);
}

function renderEntry(record: FeedbackRecord): string {
  const who = record.title === undefined ? record.task : `${record.task}（${clip(record.title, 40)}）`;
  return `- ${record.at.slice(0, 10)}  ${who}  ${describe(record)}：${record.note.replace(/\s*\r?\n\s*/g, " / ")}`;
}

function describe(record: FeedbackRecord): string {
  switch (record.action) {
    case "reject":
      return `人工打回（${record.stage}）`;
    case "audit":
      return `人工抽查 ${record.verdict}${record.stage === "none" ? "" : `（${record.stage}）`}`;
    case "accept":
      return "人工放行时的备注";
    case "answer":
      return "人工对澄清问题的回答";
  }
}

function parseRecord(line: string): FeedbackRecord | null {
  if (line.trim().length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.task !== "string" || typeof record.note !== "string" || typeof record.at !== "string") return null;
  if (!ACTIONS.includes(record.action as FeedbackAction) || !STAGES.includes(record.stage as AuditStage)) return null;
  if (record.verdict !== "pass" && record.verdict !== "fail") return null;
  return {
    task: record.task,
    ...(typeof record.title === "string" ? { title: record.title } : {}),
    action: record.action as FeedbackAction,
    verdict: record.verdict,
    stage: record.stage as AuditStage,
    ...(isTaskType(record.taskType) ? { taskType: record.taskType } : {}),
    note: record.note,
    at: record.at,
  };
}

function isTaskType(value: unknown): value is TaskType {
  return typeof value === "string" && Object.hasOwn(TEMPLATES, value);
}

/**
 * Literal keywords: ASCII words and identifiers whole, CJK as character pairs
 * (a single Han character is too common to mean anything).
 */
function keywords(text: string): Set<string> {
  const found = new Set<string>();
  for (const match of text.matchAll(/[a-z0-9][a-z0-9_.-]+/gi)) found.add(match[0].toLowerCase());
  for (const run of text.matchAll(/[\u3400-\u9fff\uf900-\ufaff]+/g)) {
    const chars = Array.from(run[0]);
    for (let i = 0; i + 1 < chars.length; i++) found.add(chars[i]! + chars[i + 1]!);
  }
  return found;
}

function overlap(wanted: Set<string>, present: Set<string>): number {
  let score = 0;
  for (const keyword of wanted) if (present.has(keyword)) score += 1;
  return score;
}

/** Trim to `limit` code points, marking a cut so a reader knows it happened. */
function clip(text: string, limit: number): string {
  const points = Array.from(text);
  return points.length <= limit ? text : `${points.slice(0, limit).join("")}…`;
}
