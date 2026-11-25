import { waitReason } from "./eligibility.js";
import { lockLive, LOCK_TTL_MS_DEFAULT } from "./claim.js";
import { readGuardRefusals, type GuardRefusal } from "./guard-refusals.js";
import { latestNote } from "./handoff.js";
import { readJournal } from "./journal.js";
import {
  DEFAULT_MODEL_KEY, formatDuration, modelKey, modelRoundsOf, readModelWait,
  type ModelWaitRecord, type ModelWaitStage,
} from "./model-wait.js";
import { questionsPath, readQuestions } from "./questions.js";
import { readAttempt, readRuntime, type AttemptRecord } from "./runtime.js";
import { reviewerChain, taskChain } from "./models.js";
import type { Task } from "./task-file.js";
import type { WorkerConfig } from "./worker.js";

/** Every line of the report carries it, so an operator can grep one stop out of a long log. */
export const OUTAGE_PREFIX = "[model-outage]";

/** What the run stopped for (design §7), gathered once and rendered line by line. */
export type OutageReport = {
  taskId: string;
  stage: ModelWaitStage;
  rounds: number;
  modelRounds: number;
  firstRefusedAt: string;
  stoppedAt: string;
  models: Array<{ model: string; reason?: string; source?: "turn" | "table"; at?: string }>;
  waiting: string[];
};

/**
 * The report a run owes when it stops for an outage: what each model of the
 * task's chain said in the last round, how long the task tried, which tasks
 * are still waiting — every one of them runnable again — and whose decision
 * it is. Reads only what the attempt already wrote (`model-wait.json`, the
 * board), so the controller can call it after everything has settled.
 */
export async function outageReport(
  cfg: WorkerConfig, board: readonly Task[], taskId: string, now = new Date(),
): Promise<OutageReport> {
  const record: ModelWaitRecord | null = await readModelWait(cfg.tasksDir, taskId);
  const task = board.find((candidate) => candidate.id === taskId);
  const stage: ModelWaitStage = record?.stage ?? "worker";
  const chain = chainOf(cfg, task, stage);
  const refusals = record?.refusals ?? [];
  const models = chain.map((model) => {
    const refusal = refusals.filter((candidate) => candidate.model === modelKey(model)).at(-1);
    return refusal === undefined ? { model } : { model, reason: refusal.reason, source: refusal.source, at: refusal.at };
  });
  // `waitReason` reads a mutable board snapshot; this one is readonly, so it gets its own copy.
  const boardCopy = [...board];
  // A task the budget guard refused is not part of the report (design §7): it keeps the guard's own line.
  const refused = new Set((await readGuardRefusals(cfg.tasksDir)).map((entry) => entry.taskId));
  return {
    taskId,
    stage,
    rounds: record?.rounds ?? 0,
    modelRounds: modelRoundsOf(cfg),
    firstRefusedAt: record?.firstRefusedAt ?? record?.updatedAt ?? now.toISOString(),
    stoppedAt: now.toISOString(),
    models,
    // A task waiting on a dependency or an unapproved bundle is not free to run again.
    waiting: boardCopy.filter((candidate) => candidate.status === "open" && waitReason(candidate, boardCopy) === null && !refused.has(candidate.id))
      .map((candidate) => candidate.id),
  };
}

/** The chain the task's refusals are about: the reviewer's for a review record, else the worker's; never empty. */
function chainOf(cfg: WorkerConfig, task: Task | undefined, stage: ModelWaitStage): string[] {
  const chain = task === undefined
    ? []
    : stage === "review"
      ? reviewerChain(cfg, task)
      : taskChain(cfg, task);
  return chain.length === 0 ? [DEFAULT_MODEL_KEY] : chain;
}

/**
 * The stop, in lines an operator reads top to bottom: the verdict, what each
 * model said (a model the last round never tried says so, and a cooling one
 * says whose refusal it is cooling from), the rounds and the time spent, the
 * tasks that can simply be run again, and the decision that is the owner's.
 */
export function renderOutageReport(report: OutageReport): string[] {
  return [
    `${OUTAGE_PREFIX} ${report.taskId}: every model refused; stopping here. Nothing is blocked, and every waiting task can simply be run again.`,
    ...report.models.map((entry) =>
      entry.reason === undefined
        ? `${OUTAGE_PREFIX}   ${entry.model}  not tried in the last round`
        : entry.source === "table"
          ? `${OUTAGE_PREFIX}   ${entry.model}  not tried in the last round: cooling from another task's refusal at ${entry.at} — ${entry.reason}`
          : `${OUTAGE_PREFIX}   ${entry.model}  ${entry.reason}`,
    ),
    `${OUTAGE_PREFIX}   rounds ${report.rounds} of ${report.modelRounds}, over ${formatDuration(Date.parse(report.stoppedAt) - Date.parse(report.firstRefusedAt))}, since ${report.firstRefusedAt}`,
    `${OUTAGE_PREFIX}   waiting, all still runnable: ${report.waiting.join(", ")}`,
    `${OUTAGE_PREFIX}   your decision: to use another model, put it into modelChain in taskctl.json, allow it (allowedModels when the backend's catalogue does not report it as free), check it with taskctl models, and run again (taskctl run, or taskctl watch). Models outside the plan may be billed per use.`,
  ];
}

/** The one line `taskctl status --stuck` prints when nothing is held or waiting. */
const NOTHING_STUCK = "没有受阻或等待的任务";

/** A chain walk longer than this is a cycle, whatever the files say (as in eligibility.ts). */
const MAX_DEPENDENCY_DEPTH = 64;

/** Where a review's parked record lives, beside `attempt.json`. */
const REVIEW_PENDING_FILE = "review-pending.json";

/** One model's verdict, as either runtime record keeps it. */
type RefusalLine = { model: string; reason: string };

/** The shape `stuckLines` reads out of `review-pending.json`; the rest of the record is none of its business. */
type PendingRecord = { updatedAt?: string; refusals?: RefusalLine[] };

/** What `stuckLines` needs beyond the board: the round budget, and how a controller's liveness is read. */
export type StuckConfig = { modelRounds?: number; lockTtlMs?: number };

/** Everything one task's line is built from; gathered once for the whole board. */
type StuckContext = {
  modelRounds: number;
  lockTtlMs: number;
  guards: Map<string, GuardRefusal>;
  tasksDir: string;
  board: readonly Task[];
  /** Whether a controller is running, read off the board's task locks; computed at most once. */
  running: () => Promise<boolean>;
};

/**
 * The answer to "which tasks are stuck, and why": one line per task that is
 * held or waiting, in board order, and a single line when there is none.
 * Reads files only — the board, the deferral and review records, the guard's
 * record, the task locks — and asks the guard for nothing: what is printed is
 * what was judged when the record was written, never a fresh backend call.
 */
export async function stuckLines(tasksDir: string, board: readonly Task[], cfg: StuckConfig): Promise<string[]> {
  const guards = new Map((await readGuardRefusals(tasksDir)).map((entry) => [entry.taskId, entry]));
  // Read only when a spent deferral asks, and only once: every lockLive is a file read.
  let live: boolean | undefined;
  const context: StuckContext = {
    modelRounds: modelRoundsOf(cfg),
    lockTtlMs: cfg.lockTtlMs ?? LOCK_TTL_MS_DEFAULT,
    guards,
    tasksDir,
    board,
    running: async () => {
      if (live === undefined) {
        live = false;
        for (const candidate of board) {
          if (await lockLive(tasksDir, candidate.id, context.lockTtlMs)) {
            live = true;
            break;
          }
        }
      }
      return live;
    },
  };
  const lines: string[] = [];
  for (const task of board) {
    const line = await stuckLine(task, context);
    if (line !== null) lines.push(line);
  }
  return lines.length === 0 ? [NOTHING_STUCK] : lines;
}

/** The line for one task, or `null` when nothing about it is held or waiting. */
async function stuckLine(task: Task, ctx: StuckContext): Promise<string | null> {
  // A task the budget guard refused keeps the guard's line while it is still
  // `open`: what was judged then, from the record, and never a fresh call.
  const guard = ctx.guards.get(task.id);
  if (guard !== undefined && task.status === "open") {
    return guardLine(task.id, guard);
  }
  switch (task.status) {
    case "blocked":
      return blockedLine(ctx.tasksDir, task.id);
    case "open": {
      const wait = await readModelWait(ctx.tasksDir, task.id);
      if (wait !== null) return deferralLine(task.id, wait, ctx);
      return dependencyLine(task, ctx);
    }
    case "awaiting-human":
      return `${task.id}  等放行  ${await noteStatus(ctx.tasksDir, task.id)}`;
    case "draft": {
      const children = ctx.board.filter((other) => other.parentId === task.id).length;
      const bundle = children === 0 ? "" : `（拆分包：${children} 个子任务随之放行）`;
      const questions = await readQuestions(ctx.tasksDir, task.id);
      const asked = questions === null
        ? ""
        : `；待回答问题 ${questions.items.length} 条（${questionsPath(ctx.tasksDir, task.id)}）`;
      return `${task.id}  等签字${bundle}${asked}`;
    }
    default:
      // Any other status with open questions is waiting on a person, not on the queue.
      return await questionsLine(ctx.tasksDir, task.id);
  }
}

/** The guard's verdict lines, then and there, with a pointer at today's judgement. */
function guardLine(id: string, guard: GuardRefusal): string {
  const verdicts = guard.line.split(/\r?\n/).filter((line) => line.trim().length > 0).join(" | ");
  return `${id}  等护栏放行  ${verdicts}；判定于 ${guard.at}，现在的判定以 taskctl models 为准`;
}

/** A deferred task's round and next time; a spent one says whose decision it waits for. */
async function deferralLine(id: string, wait: ModelWaitRecord, ctx: StuckContext): Promise<string> {
  if (wait.rounds < ctx.modelRounds) {
    return `${id}  等模型窗口  第 ${wait.rounds}/${ctx.modelRounds} 轮，下次 ${wait.nextAt}`;
  }
  // The decision is the controller's, taken once no attempt is in flight
  // (design §6, step 5); while attempts are still settling it says so, and
  // only when the board's locks are all cold does it fall to the owner.
  const inFlight = await ctx.running();
  return `${id}  等模型窗口  第 ${wait.rounds}/${ctx.modelRounds} 轮已用尽，${
    inFlight ? "等在跑的尝试结算后判断" : "等所有者处理：改好配置后新的 taskctl run 从第 0 轮开始"
  }`;
}

/**
 * The held task an `open` task's dependency chain ends at, or `null`: the
 * root's id and its own reason, followed through tasks that are merely
 * `open` (a root that is itself only deferred is not the reason this task
 * cannot finish).
 */
async function heldRoot(
  tasksDir: string, id: string, byId: Map<string, Task>, visited: Set<string>, depth: number,
): Promise<{ id: string; why: string } | null> {
  if (visited.has(id) || depth > MAX_DEPENDENCY_DEPTH) return null;
  visited.add(id);
  const task = byId.get(id);
  if (task === undefined) return { id, why: "不在看板上" };
  switch (task.status) {
    case "blocked":
      return { id, why: `已阻塞：${(await blockedWhy(tasksDir, id)).reason}` };
    case "awaiting-human":
      return { id, why: `等放行：${await noteStatus(tasksDir, id)}` };
    case "draft":
      return { id, why: "等签字" };
    case "open":
      for (const next of task.dependsOn) {
        const found = await heldRoot(tasksDir, next, byId, visited, depth + 1);
        if (found !== null) return found;
      }
      return null;
    default:
      return null;
  }
}

/** The 等受阻依赖 line of an `open` task held through its dependencies, or `null` when none is held. */
async function dependencyLine(task: Task, ctx: StuckContext): Promise<string | null> {
  const byId = new Map(ctx.board.map((other) => [other.id, other]));
  for (const direct of task.dependsOn) {
    const root = await heldRoot(ctx.tasksDir, direct, byId, new Set([task.id]), 0);
    if (root !== null) {
      const via = root.id === direct ? "" : `（经 ${direct}）`;
      return `${task.id}  等受阻依赖  ${root.id}${via}：${root.why}`;
    }
  }
  return null;
}

/** The `待回答问题` line, or `null` when the task has none. */
async function questionsLine(tasksDir: string, id: string): Promise<string | null> {
  const questions = await readQuestions(tasksDir, id);
  return questions === null
    ? null
    : `${id}  待回答问题 ${questions.items.length} 条（${questionsPath(tasksDir, id)}）`;
}

/** The latest handoff note's status line, or `-`. */
async function noteStatus(tasksDir: string, id: string): Promise<string> {
  const note = await latestNote(tasksDir, id);
  return note === null ? "-" : statusLineFromNote(note.markdown);
}

/** Why a task is `blocked`, and since when, from the newest evidence it carries. */
async function blockedWhy(
  tasksDir: string, id: string,
): Promise<{ reason: string; since: string; models: RefusalLine[] }> {
  let reason: string | null = null;
  let since: string | null = null;
  let fromPending = false;
  const note = await noteStatus(tasksDir, id);
  if (note !== "-") {
    reason = note;
    since = "-";
  } else {
    const line = (await readJournal(tasksDir, id))
      .filter((entry) => entry.event === "blocked" && entry.detail.trim().length > 0)
      .at(-1);
    if (line !== undefined) {
      reason = line.detail;
      since = line.at;
    }
  }
  let pending: PendingRecord | null = null;
  if (reason === null) {
    pending = await readPending(tasksDir, id);
    const refusal = pending?.refusals?.at(-1);
    if (refusal !== undefined) {
      reason = `只差复核：${refusal.model}：${refusal.reason}`;
      since = typeof pending?.updatedAt === "string" ? pending.updatedAt : "-";
      fromPending = true;
    }
  }
  if (reason === null) {
    const attempt = await readAttemptQuietly(tasksDir, id);
    if (attempt !== null && typeof attempt.reason === "string" && attempt.reason.length > 0) {
      reason = attempt.reason;
      since = attempt.updatedAt;
    }
  }
  // The models of a refusal: the deferral record's, else the parked review's —
  // unless the 只差复核 line above already names them.
  const wait = await readModelWait(tasksDir, id);
  let models: RefusalLine[] = wait?.refusals ?? [];
  if (models.length === 0 && !fromPending) {
    pending ??= await readPending(tasksDir, id);
    models = pending?.refusals ?? [];
  }
  return { reason: reason ?? "-", since: since ?? "-", models };
}

/** The `已阻塞` line: what it says, since when, and every refusing model when one refused it. */
async function blockedLine(tasksDir: string, id: string): Promise<string> {
  const { reason, since, models } = await blockedWhy(tasksDir, id);
  const modelText = models.length === 0
    ? ""
    : `；模型：${models.map((refusal) => `${refusal.model}：${refusal.reason}`).join(" | ")}`;
  return `${id}  已阻塞  ${reason}；自 ${since}${modelText}`;
}

/**
 * The parked review's record; a missing or unreadable one reads as none, like
 * every other reader of a runtime record — a torn file must not crash a
 * command whose only job is to say where things stand.
 */
async function readPending(tasksDir: string, id: string): Promise<PendingRecord | null> {
  try {
    return await readRuntime<PendingRecord>(tasksDir, id, REVIEW_PENDING_FILE);
  } catch {
    return null;
  }
}

/** The attempt's record; an unreadable one reads as none, for the same reason. */
async function readAttemptQuietly(tasksDir: string, id: string): Promise<AttemptRecord | null> {
  try {
    return await readAttempt(tasksDir, id);
  } catch {
    return null;
  }
}

/**
 * The `## Status` section's first non-empty line — the "一句话状态" a
 * `taskctl note` leaves behind. Multiline statuses are represented by their
 * first line so every table row stays a single line.
 */
export function statusLineFromNote(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const heading = lines.indexOf("## Status");
  if (heading === -1) {
    return "-";
  }
  for (let i = heading + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("## ")) {
      break;
    }
    if (line.trim().length > 0) {
      return line.trim();
    }
  }
  return "-";
}
