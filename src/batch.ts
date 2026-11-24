import { lockLive } from "./claim.js";
import { draftAncestor } from "./eligibility.js";
import { readAttempt } from "./runtime.js";
import { assertAcyclic, taskWorkdir } from "./scheduler.js";
import type { Task } from "./task-file.js";
import type { WorkerConfig } from "./worker.js";

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
  baseWorkdir: string,
): string | null {
  void baseWorkdir;
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
  if (ids.length === 0) throw new BatchValidationError(["no tasks selected"]);

  const normalized = ids.map((id) => id.trim());
  const byId = new Map(board.map((task) => [task.id, task]));
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
    selected.push(task);
    const ineligible = batchEligibility(task, board, earlier, cfg.workdir);
    if (ineligible !== null) issues.push(ineligible);
    earlier.add(id);

    const workdir = taskWorkdir(cfg.workdir, task);
    expectedWorkdir ??= workdir;
    if (workdir !== expectedWorkdir) {
      issues.push(`task ${id}: workdir ${workdir} differs from the first selected workdir ${expectedWorkdir}`);
    }

    if (await lockLive(cfg.tasksDir, id, cfg.lockTtlMs)) {
      issues.push(`task ${id}: a live lock is held by another execution`);
    }
    try {
      const previous = await readAttempt(cfg.tasksDir, id);
      if (previous !== null && previous.phase !== "settled") {
        issues.push(`task ${id}: previous attempt is not settled (${previous.phase})`);
      }
    } catch (error) {
      issues.push(`task ${id}: previous attempt is not settled (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  if (issues.length > 0) throw new BatchValidationError(issues);
  return selected;
}
