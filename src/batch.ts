import { lockLive } from "./claim.js";
import { draftAncestor } from "./eligibility.js";
import { modelWaitHolds, type ModelWaitHold } from "./model-wait.js";
import { definitionDigest, readAttempt } from "./runtime.js";
import { readExecutionState, type WorkerSessionFact } from "./execution-state.js";
import { assertAcyclic, passBudget, ready, taskWorkdir } from "./scheduler.js";
import { pruneGuardRefusals } from "./guard-refusals.js";
import type { Task } from "./task-file.js";
import { runTask, settleExhausted, type TaskOutcome, type WorkerConfig, type WorkerDeps } from "./worker.js";

/** Every reason an explicitly requested batch cannot start, in selection order. */
export class BatchValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`invalid batch selection:\n- ${issues.join("\n- ")}`);
    this.name = "BatchValidationError";
  }
}

/**
 * The definition-only part of §13.2. `earlier` is the ordered selection's
 * prefix, so a dependency may already be done or be claimed before this task.
 * Cross-task workdir equality is checked by the whole-selection validator.
 */
export function batchEligibility(
  task: Task,
  board: Task[],
  earlier: ReadonlySet<string>,
): string | null {
  if (task.status !== "open") return `task ${task.id}: status ${task.status} is not open`;
  const execution = task.execution ?? (task.complexity === "simple" ? "continuous" : "iterative");
  if (execution !== "continuous") return `task ${task.id}: execution is not continuous`;
  if (task.verify !== "mechanical" && task.verify !== "render") {
    return `task ${task.id}: verify must be mechanical or render`;
  }
  if (task.risk !== "normal") return `task ${task.id}: expected normal risk, not ${task.risk}`;
  if (task.humanCheck) return `task ${task.id}: human_check is required`;
  const byId = new Map(board.map((candidate) => [candidate.id, candidate]));
  const ancestor = draftAncestor(task, byId);
  if (ancestor !== null) return `task ${task.id}: draft ancestor ${ancestor.id} has not been approved`;
  const statuses = new Map(board.map((candidate) => [candidate.id, candidate.status]));
  for (const dependency of task.dependsOn) {
    if (statuses.get(dependency) !== "done" && !earlier.has(dependency)) {
      return `task ${task.id}: dependency ${dependency} is neither done nor earlier in the selection`;
    }
  }
  return null;
}

/**
 * One shared runtime probe for explicit and automatic selection. Both callers
 * must see the same eligibility, workdir, live-lock, model-wait hold and
 * unsettled-attempt checks; only the terminal handling differs (collect issues
 * vs stop prefix).
 */
type BatchTaskProbe = { issue: string | null; workdir: string; expectedWorkdir: string };

async function probeBatchTask(
  cfg: WorkerConfig,
  task: Task,
  board: Task[],
  earlier: Set<string>,
  expectedWorkdir: string | undefined,
  holds: ReadonlyMap<string, ModelWaitHold>,
): Promise<BatchTaskProbe> {
  const workdir = taskWorkdir(cfg.workdir, task);
  const expected = expectedWorkdir ?? workdir;
  let issue = batchEligibility(task, board, earlier);
  if (issue === null && workdir !== expected) {
    issue = `task ${task.id}: workdir ${workdir} differs from the first selected workdir ${expected}`;
  }
  if (issue === null && await lockLive(cfg.tasksDir, task.id, cfg.lockTtlMs)) {
    issue = `task ${task.id}: a live lock is held by another execution`;
  }
  if (issue === null) {
    const hold = holds.get(task.id);
    if (hold !== undefined) {
      issue = hold.kind === "window"
        ? `task ${task.id}: deferred until ${hold.nextAt} (round ${hold.rounds})`
        : `task ${task.id}: its model rounds are spent for the running controller`;
    }
  }
  if (issue === null) {
    try {
      const previous = await readAttempt(cfg.tasksDir, task.id);
      if (previous !== null && previous.phase !== "settled") {
        issue = `task ${task.id}: previous attempt is not settled (${previous.phase})`;
      }
    } catch (error) {
      issue = `task ${task.id}: previous attempt is not settled (${error instanceof Error ? error.message : String(error)})`;
    }
  }
  return { issue, workdir, expectedWorkdir: expected };
}

/**
 * Validate the entire explicit selection before any task is claimed. Runtime
 * checks are deliberately conservative: a live owner or any unsettled previous
 * attempt needs reconciliation, not an automatic replay inside a batch.
 */
export async function validateBatchSelection(
  cfg: WorkerConfig,
  ids: string[],
  board: Task[],
): Promise<Task[]> {
  assertAcyclic(board);
  await pruneGuardRefusals(cfg.tasksDir, board);
  if (ids.length === 0) throw new BatchValidationError(["no tasks selected"]);

  const normalized = ids.map((id) => id.trim());
  const byId = new Map(board.map((task) => [task.id, task]));
  const holds = await modelWaitHolds(cfg, board.filter((task) => task.status === "open").map((task) => task.id));
  const selected: Task[] = [];
  const issues: string[] = [];
  const seen = new Set<string>();
  const earlier = new Set<string>();
  let expectedWorkdir: string | undefined;

  for (const [index, id] of normalized.entries()) {
    if (id.length === 0) {
      issues.push(`empty task id at position ${index + 1}`);
      continue;
    }
    if (seen.has(id)) {
      issues.push(`duplicate task ${id}`);
      continue;
    }
    seen.add(id);
    const task = byId.get(id);
    if (task === undefined) {
      issues.push(`unknown task ${id}`);
      continue;
    }
    const probe = await probeBatchTask(cfg, task, board, earlier, expectedWorkdir, holds);
    expectedWorkdir = probe.expectedWorkdir;
    selected.push(task);
    earlier.add(id);
    if (probe.issue !== null) issues.push(probe.issue);
  }

  if (issues.length > 0) throw new BatchValidationError(issues);
  return selected;
}

/** The one readiness derivation shared by automatic selection and watch's fallback head. */
export function readyTasks(board: Task[]): Task[] {
  const done = new Set(board.filter((task) => task.status === "done").map((task) => task.id));
  return ready(board, done);
}

/**
 * Choose the contiguous eligible prefix of the ready queue. An ineligible task
 * is never skipped: watch runs that earlier task ordinarily instead of letting
 * later work jump it merely to form a cheaper batch. A task waiting for its
 * next model window is not "ineligible" in this sense — its deferral is a
 * second exclusion beside the guard's cooling one — but it does not hold the
 * prefix either: it is taken out of the queue before the walk, and what
 * follows it is selected.
 */
export async function selectAutomaticBatch(
  cfg: WorkerConfig,
  board: Task[],
): Promise<string[]> {
  assertAcyclic(board);
  const held = await modelWaitHolds(cfg, board.filter((task) => task.status === "open").map((task) => task.id));
  const candidates = readyTasks(board).filter((task) => !held.has(task.id));
  const maximum = cfg.batchMaxTasks ?? 5;
  const selected: string[] = [];
  const earlier = new Set<string>();
  let expectedWorkdir: string | undefined;

  for (const task of candidates) {
    if (selected.length >= maximum) break;
    const probe = await probeBatchTask(cfg, task, board, earlier, expectedWorkdir, held);
    if (probe.issue !== null) break;
    selected.push(task.id);
    earlier.add(task.id);
    expectedWorkdir = probe.expectedWorkdir;
  }
  return selected;
}

export type BatchResult = {
  done: string[];
  stoppedAt?: string;
  /** `outage` names a stop for a model outage; the controller that ran the batch reports the decision. */
  outcome?: TaskOutcome | "stop-requested" | "outage";
  /** Present only when the batch stopped on a task deferred for a window: when it may be claimed again. */
  deferredUntil?: string;
  /** Selected ids that were never claimed. */
  pending: string[];
};

export type BatchRunOptions = {
  /** Test seam, equivalent to the scheduler's `options.run`. */
  run?: typeof runTask;
  /** Checked before every attempt; an active attempt is never interrupted. */
  shouldStop?: () => Promise<boolean>;
};

/**
 * Execute an explicit selection in order. Each task still goes through the
 * ordinary claim/acceptance path. Only the current task's `open` outcome is
 * retried; a later task is never used to make progress past a stopped one.
 */
export async function runBatch(
  cfg: WorkerConfig,
  deps: WorkerDeps,
  ids: string[],
  options: BatchRunOptions = {},
): Promise<BatchResult> {
  const selected = await validateBatchSelection(cfg, ids, await deps.store.list());
  const originals = new Map(selected.map((task) => [task.id, {
    digest: definitionDigest(task),
    workdir: taskWorkdir(cfg.workdir, task),
  }]));
  const runOne = options.run ?? runTask;
  const shouldStop = options.shouldStop ?? (async () => false);
  const done: string[] = [];
  let previousWorker: WorkerSessionFact | undefined;

  for (const [index, selectedTask] of selected.entries()) {
    const original = originals.get(selectedTask.id)!;
    const preamble = `## 连续批次\n- 当前任务：${selectedTask.id}\n- 前面已完成：${done.join(", ") || "无"}\n- 不要重做前面已完成的任务，也不要修改它们的定义或任务文件；只完成当前任务并独立验收。\n\n`;
    for (let attempt = 1; ; attempt++) {
      if (await shouldStop()) {
        return {
          done,
          stoppedAt: selectedTask.id,
          outcome: "stop-requested",
          pending: selected.slice(index).map((task) => task.id),
        };
      }

      // Selection-time approval is not authority to claim a later task. Compare
      // against the originally selected definition on every attempt, including
      // reviewer-driven retries of the current task.
      const board = await deps.store.list();
      assertAcyclic(board);
      const current = board.find((task) => task.id === selectedTask.id);
      const issues: string[] = [];
      if (current === undefined) {
        issues.push(`task ${selectedTask.id}: selected task is no longer on the board`);
      } else {
        if (definitionDigest(current) !== original.digest) {
          issues.push(`task ${selectedTask.id}: definition changed before its batch claim`);
        }
        const workdir = taskWorkdir(cfg.workdir, current);
        if (workdir !== original.workdir) {
          issues.push(`task ${selectedTask.id}: workdir ${workdir} changed from selected workdir ${original.workdir}`);
        }
      }
      if (issues.length > 0) throw new BatchValidationError(issues);

      const outcome = await runOne(
        { ...cfg, workdir: original.workdir },
        deps,
        current!,
        `batch-${process.pid}-${selectedTask.id}`,
        {
          batch: {
            preamble,
            ...(attempt === 1 && previousWorker !== undefined ? { resumeFrom: previousWorker } : {}),
          },
        },
      );
      if (outcome === "done") {
        done.push(selectedTask.id);
        const latest = (await readExecutionState(cfg.tasksDir, selectedTask.id)).latestWorker;
        previousWorker = latest?.clean && latest.model ? { ...latest } : undefined;
        break;
      }
      if (outcome !== "open") {
        return {
          done,
          stoppedAt: selectedTask.id,
          outcome,
          pending: selected.slice(index + 1).map((task) => task.id),
        };
      }
      // A batch is serial, so nothing else is in flight: a task that ran out
      // of rounds is decided here, and a deferral ends the batch, which does
      // not wait inside itself.
      const settled = await settleExhausted(cfg, deps, board, [selectedTask.id]);
      const rest = selected.slice(index + 1).map((task) => task.id);
      if (settled.outage !== undefined) return { done, stoppedAt: settled.outage.taskId, outcome: "outage", pending: rest };
      if (settled.held.includes(selectedTask.id)) return { done, stoppedAt: selectedTask.id, outcome: "blocked", pending: rest };
      const hold = (await modelWaitHolds(cfg, [selectedTask.id])).get(selectedTask.id);
      if (hold !== undefined) {
        return {
          done, stoppedAt: selectedTask.id, outcome,
          pending: selected.slice(index).map((task) => task.id),
          ...(hold.kind === "window" ? { deferredUntil: hold.nextAt } : {}),
        };
      }
      if (attempt >= passBudget(1, cfg)) {
        return {
          done,
          stoppedAt: selectedTask.id,
          outcome,
          pending: selected.slice(index + 1).map((task) => task.id),
        };
      }
    }
  }
  return { done, stoppedAt: undefined, outcome: undefined, pending: [] };
}
