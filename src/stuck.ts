import { waitReason } from "./eligibility.js";
import {
  DEFAULT_MODEL_KEY, formatDuration, modelKey, modelRoundsOf, readModelWait,
  type ModelWaitRecord, type ModelWaitStage,
} from "./model-wait.js";
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
  return {
    taskId,
    stage,
    rounds: record?.rounds ?? 0,
    modelRounds: modelRoundsOf(cfg),
    firstRefusedAt: record?.firstRefusedAt ?? record?.updatedAt ?? now.toISOString(),
    stoppedAt: now.toISOString(),
    models,
    // A task waiting on a dependency or an unapproved bundle is not free to run again.
    waiting: boardCopy.filter((candidate) => candidate.status === "open" && waitReason(candidate, boardCopy) === null)
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
