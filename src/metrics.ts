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

/** What a person had to do with one task: how often, of which kind, and how long the task waited for them. */
export type HumanTouch = { task: string; byEvent: Record<string, number>; total: number; waitedMs: number };

/** The first review of the tasks one model finished: how many passed it, and how many never had one. */
export type ModelFirstPass = { model: string; tasks: number; firstReviewPassed: number; noReview: number };

/** The human events that push a stopped task on again. Every other touch is counted, and is not waited for. */
const PUSHED_ON: ReadonlySet<string> = new Set(["approved", "answered", "accepted", "retry"]);

/**
 * Where a person had to step in, per task, and how long the task waited for
 * them: the cost the flow metrics above cannot see, since a task can pass
 * first time and still have cost a signature, an answer and an acceptance.
 *
 * A human touch is a journal line with stage `human` — a draft approved, a
 * question answered, work accepted or sent back, a spot check (`audited`), a
 * retry — or a split plan that was `applied`. `total` counts them, and
 * `byEvent` counts them by event, in the order the journal first has each.
 *
 * `waitedMs` is how long a person was waited for: for each touch that pushes
 * a stopped task on again (`approved`, `answered`, `accepted`, `retry`) the
 * time since the line before it, when there is one and both times parse. A
 * rejection or a spot check sends nothing on, so it is counted and adds no
 * time. It is wall-clock time, nights and weekends included, so it overstates
 * what a person actually spent: an approximation, which the output says so.
 *
 * Tasks come in the order of `journals`, and a task nobody touched is not
 * listed.
 */
export function humanTouches(journals: ReadonlyMap<string, readonly JournalLine[]>): HumanTouch[] {
  const touches: HumanTouch[] = [];
  for (const [task, journal] of journals) {
    const byEvent: Record<string, number> = {};
    let total = 0;
    let waitedMs = 0;
    journal.forEach((line, index) => {
      if (line.stage !== "human" && !(line.stage === "split" && line.event === "applied")) return;
      byEvent[line.event] = (byEvent[line.event] ?? 0) + 1;
      total += 1;
      const previous = journal[index - 1];
      if (line.stage !== "human" || !PUSHED_ON.has(line.event) || previous === undefined) return;
      const waited = Date.parse(line.at) - Date.parse(previous.at);
      if (Number.isFinite(waited)) waitedMs += waited;
    });
    if (total > 0) touches.push({ task, byEvent, total, waitedMs });
  }
  return touches;
}

/**
 * How often the first review passed, per model: what an owner changes models
 * by. The caller passes finished tasks only, each with the model its
 * acceptance ran on (`acceptance.json`; `render.json` for a task the render
 * check accepted, which writes no `acceptance.json`), or `null` when no
 * record says; a null model is reported as `(unknown)`.
 *
 * The first review is the first `review`/`verdict` line of the part of the
 * journal after its last `worker`/`claimed` — the attempt that finished the
 * task — or of the whole journal when nothing was claimed. A verdict whose
 * detail begins with `pass` counts as passed (tolerated external changes
 * follow it: `pass external=2`); any other verdict counts as not passed; no
 * verdict at all counts as `noReview`, a task that finished on a mechanical
 * or render check and never saw a reviewer.
 *
 * A reviewer turn the provider refused is no review, and counts as none: the
 * worker journals it as a verdict degraded to `unclear` with
 * `review`/`provider-failed` right after it, and that pair is passed over.
 * The next verdict line of the segment decides; with none, the task is
 * `noReview`, since no reviewer judged the work. A verdict with no such line
 * after it is a review, a real `unclear` included: not passed.
 *
 * A model appears once, where it first appears in `rows`.
 */
export function modelFirstPass(rows: readonly { model: string | null; journal: readonly JournalLine[] }[]): ModelFirstPass[] {
  const byModel = new Map<string, ModelFirstPass>();
  for (const { model, journal } of rows) {
    const name = model ?? "(unknown)";
    const lastClaim = journal.findLastIndex((line) => line.stage === "worker" && line.event === "claimed");
    const segment = journal.slice(lastClaim + 1);
    // The verdict that decides is the first one that is a review. A verdict with `provider-failed` right after
    // it is the degraded one of a turn the provider refused, which is no review.
    const verdict = segment.find((line, index) =>
      line.stage === "review" && line.event === "verdict" && !providerFailedFollows(segment[index + 1]));
    const row = byModel.get(name) ?? { model: name, tasks: 0, firstReviewPassed: 0, noReview: 0 };
    row.tasks += 1;
    if (verdict === undefined) row.noReview += 1;
    else if (verdict.detail.startsWith("pass")) row.firstReviewPassed += 1;
    byModel.set(name, row);
  }
  return [...byModel.values()];
}

/**
 * Whether `next`, the journal line right after a `review`/`verdict` line,
 * says that verdict was the degraded one of a turn the provider refused: the
 * worker journals the two together, the verdict first.
 */
function providerFailedFollows(next: JournalLine | undefined): boolean {
  return next !== undefined && next.stage === "review" && next.event === "provider-failed";
}

/**
 * {@link summarizeFlow}'s input, read from a board: every task's journal and
 * classification record. The journals come back with it, so the other views
 * that need them ({@link humanTouches}) cost a board no second read.
 */
export async function readFlowInput(tasksDir: string, tasks: FlowInput["tasks"]): Promise<FlowInput> {
  const read = async (id: string): Promise<[JournalLine[], ClassificationSummary | null]> =>
    [await readJournal(tasksDir, id), await readClassification(tasksDir, id)];
  const entries = await Promise.all(tasks.map(async (task) => [task.id, ...(await read(task.id))] as const));
  return {
    tasks,
    journals: new Map(entries.map(([id, journal]) => [id, journal])),
    classifications: new Map(entries.map(([id, , record]) => [id, record])),
  };
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
