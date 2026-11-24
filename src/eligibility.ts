import type { Task } from "./task-file.js";

/**
 * Why an `open` task is not ready to be claimed.
 *
 * - `bundle-approval`: a split child whose ancestor is still `draft`. The bundle
 *   it belongs to has not been signed, so nothing in it may run.
 * - `dependencies`: it waits on tasks that are not `done`. `stuck` names the
 *   ones that will not finish on their own (blocked, parked at a human gate,
 *   back in draft, or no longer on the board), so waiting on them is visible
 *   instead of looking like an unexplained `open` task.
 */
export type WaitReason =
  | { kind: "bundle-approval"; ancestor: string }
  | { kind: "dependencies"; pending: string[]; stuck: string[] };

/** A parent chain longer than this is a cycle, whatever the files say. */
const MAX_ANCESTORS = 64;

/**
 * The nearest ancestor of `task` that is still `draft`, or `null` when every
 * ancestor has been approved. "Nearest" and "every" are the same answer here:
 * a draft anywhere up the chain means the bundle is unsigned.
 *
 * A parent that is not on the board counts as a gate. `assertAcyclic` rejects
 * that board before anything runs, so this only matters to a caller that got
 * there some other way — and it must fail closed, not run an orphan.
 */
export function draftAncestor(task: Pick<Task, "id" | "parentId">, byId: Map<string, Pick<Task, "id" | "status" | "parentId">>): Pick<Task, "id"> | null {
  let current = task;
  for (let depth = 0; current.parentId !== undefined; depth++) {
    if (depth >= MAX_ANCESTORS) return { id: current.parentId };
    const parent = byId.get(current.parentId);
    if (parent === undefined) return { id: current.parentId };
    if (parent.status === "draft") return parent;
    current = parent;
  }
  return null;
}

/**
 * The scheduler's question — "may this be claimed now?" — answered from one
 * board snapshot. The same answer is used at claim time against a fresh
 * snapshot, so a stale plan or a hand edit between the two cannot slip a task
 * through.
 */
export function waitReason(task: Task, board: Task[]): WaitReason | null {
  if (task.status !== "open") return null;
  const byId = new Map(board.map((other) => [other.id, other]));
  const ancestor = draftAncestor(task, byId);
  if (ancestor !== null) return { kind: "bundle-approval", ancestor: ancestor.id };
  const statusOf = new Map(board.map((other) => [other.id, other.status]));
  const pending = task.dependsOn.filter((id) => statusOf.get(id) !== "done");
  if (pending.length === 0) return null;
  const stuck = pending.filter((id) => {
    const status = statusOf.get(id);
    return status === undefined || status === "blocked" || status === "awaiting-human" || status === "draft";
  });
  return { kind: "dependencies", pending, stuck };
}
