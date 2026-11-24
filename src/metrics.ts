import { readJournal, type JournalLine } from "./journal.js";
import { readRuntime } from "./runtime.js";
import type { Task } from "./task-file.js";

/** The intake facts `tasks/<id>/classification.json` contributes to the metrics. */
export type ClassificationSummary = {
  lane?: unknown;
  proposedLane?: unknown;
  sufficiency?: unknown;
  laneEscalated?: unknown;
};

/** What the flow metrics are computed from: the board, its journals, its intake records. */
export type FlowInput = {
  tasks: Array<Pick<Task, "id" | "status">>;
  journals: Map<string, JournalLine[]>;
  /** `null` marks a task whose record exists but cannot be read. */
  classifications: Map<string, ClassificationSummary | null>;
};

const LANE_RANK: Record<string, number> = { quick: 0, simple: 1, complex: 2 };

/** `part/total` as a whole percent, or `-` when there is nothing to take a share of. */
function percent(part: number, total: number): string {
  return total === 0 ? "-" : `${Math.round((part / total) * 100)}%`;
}

/**
 * The flow of work, as opposed to {@link summarizeAudits}, which is what a
 * human judged. The point of keeping them apart: "the task came back" can mean
 * taskctl sent it back on its own evidence (cheap, intended) or a person had
 * to send it back (the repetition this tool exists to remove). One number for
 * both would hide exactly the trend that matters.
 *
 * - first-pass: a finished task no human ever rejected;
 * - automatic rework: rounds the controller started itself — an acceptance
 *   failure or a failed review resumed the worker — and the tasks involved;
 * - user rework: tasks a human rejected at least once.
 *
 * Rounds are counted from the journal events that record the decision, never
 * inferred from neighbouring lines or from counters a later `retry` resets.
 */
export function summarizeFlow(input: FlowInput): string[] {
  const journalOf = (id: string): JournalLine[] => input.journals.get(id) ?? [];
  const saw = (id: string, stage: string, event: string): boolean =>
    journalOf(id).some((line) => line.stage === stage && line.event === event);
  const rounds = (stage: string, event: string): number =>
    input.tasks.reduce((sum, task) => sum + journalOf(task.id).filter((line) => line.stage === stage && line.event === event).length, 0);

  const completed = input.tasks.filter((task) => task.status === "done");
  const firstPass = completed.filter((task) => !saw(task.id, "human", "rejected"));
  const userReworked = input.tasks.filter((task) => saw(task.id, "human", "rejected"));
  const acceptanceRework = rounds("worker", "rework");
  const reviewRework = rounds("review", "rework");
  const autoReworked = input.tasks.filter((task) => saw(task.id, "worker", "rework") || saw(task.id, "review", "rework"));

  let classified = 0;
  let needsInformation = 0;
  let assumptions = 0;
  let escalated = 0;
  for (const task of input.tasks) {
    const record = input.classifications.get(task.id);
    // Only tasks that went through classification have an intake outcome at all.
    if (!record) continue;
    classified += 1;
    if (record.sufficiency === "needs-information") needsInformation += 1;
    if (record.sufficiency === "assumptions") assumptions += 1;
    const applied = LANE_RANK[String(record.lane)];
    const proposed = LANE_RANK[String(record.proposedLane)];
    if (record.laneEscalated === true || (applied !== undefined && proposed !== undefined && applied > proposed)) escalated += 1;
  }

  return [
    `首轮通过率  ${percent(firstPass.length, completed.length)}  (${firstPass.length}/${completed.length})`,
    `自动返工  ${autoReworked.length} 个任务  ${acceptanceRework + reviewRework} 轮（验收 ${acceptanceRework}，复核 ${reviewRework}）`,
    `人工打回  ${userReworked.length} 个任务`,
    `接入信息  needs-information ${needsInformation} / ${classified}（${percent(needsInformation, classified)}）  assumptions ${assumptions}`,
    `分类升级  ${escalated} / ${classified}`,
    `复核保留  ${rounds("review", "review-pending")}`,
    `只复核恢复  ${rounds("review", "review-only")}`,
  ];
}

/** {@link summarizeFlow} over a board: every task's journal and classification record. */
export async function readFlow(tasksDir: string, tasks: FlowInput["tasks"]): Promise<string[]> {
  const read = async (id: string): Promise<[JournalLine[], ClassificationSummary | null]> =>
    [await readJournal(tasksDir, id), await readClassification(tasksDir, id)];
  const entries = await Promise.all(tasks.map(async (task) => [task.id, ...(await read(task.id))] as const));
  return summarizeFlow({
    tasks,
    journals: new Map(entries.map(([id, journal]) => [id, journal])),
    classifications: new Map(entries.map(([id, , record]) => [id, record])),
  });
}

/**
 * The intake record of one task. A missing, torn or non-object record reads
 * as `null`: it is not evidence of any intake outcome, so it is not counted.
 */
async function readClassification(tasksDir: string, id: string): Promise<ClassificationSummary | null> {
  let parsed: unknown;
  try {
    parsed = await readRuntime<unknown>(tasksDir, id, "classification.json");
  } catch (err) {
    if (err instanceof SyntaxError) return null;
    throw err;
  }
  return typeof parsed === "object" && parsed !== null ? (parsed as ClassificationSummary) : null;
}
