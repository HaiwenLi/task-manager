import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { MAX_REVIEW_ROUNDS_DEFAULT, runTask, type WorkerConfig, type WorkerDeps } from "./worker.js";
import type { Task } from "./task-file.js";
import { draftAncestor } from "./eligibility.js";

/** Where a task runs: its own `workdir` under the configured one, or the configured one. */
export function taskWorkdir(base: string, task: Task): string {
  return task.workdir === undefined ? base : resolve(base, task.workdir);
}

/**
 * The resource a workdir belongs to. Workspace reservation already treats a git
 * repository as one resource (its common dir is reserved), so the scheduler must
 * agree: two sibling task directories in one repo queue instead of colliding.
 */
export async function resourceKey(cwd: string): Promise<string> {
  let current = resolve(cwd);
  for (;;) {
    try {
      await stat(join(current, ".git"));
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(cwd);
      current = parent;
    }
  }
}

/**
 * Reject unknown dependencies and cycles before anything runs. A cycle would
 * otherwise leave every participant permanently waiting, which looks like a
 * hang rather than an error. Parent links are checked the same way: an unknown
 * one is a broken board, and a cycle is a bundle that can never be approved.
 */
export function assertAcyclic(tasks: Task[]): void {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!byId.has(dependency)) {
        throw new Error(`task ${task.id}: unknown task in depends_on: ${dependency}`);
      }
    }
    if (task.parentId !== undefined && !byId.has(task.parentId)) {
      throw new Error(`task ${task.id}: unknown task in parent_id: ${task.parentId}`);
    }
  }
  const state = new Map<string, "visiting" | "done">();
  const visit = (id: string, path: string[]): void => {
    const seen = state.get(id);
    if (seen === "done") return;
    if (seen === "visiting") {
      throw new Error(`dependency cycle: ${[...path, id].join(" -> ")}`);
    }
    state.set(id, "visiting");
    for (const dependency of byId.get(id)!.dependsOn) {
      visit(dependency, [...path, id]);
    }
    state.set(id, "done");
  };
  for (const task of tasks) visit(task.id, []);
  for (const task of tasks) {
    const path: string[] = [];
    let current: Task | undefined = task;
    while (current !== undefined && current.parentId !== undefined) {
      if (path.includes(current.id)) {
        throw new Error(`parent cycle: ${[...path.slice(path.indexOf(current.id)), current.id].join(" -> ")}`);
      }
      path.push(current.id);
      current = byId.get(current.parentId);
    }
  }
}

/** How many passes over the queue one `run` may take before giving up. */
const MAX_PASSES = 50;

/**
 * Open, with every dependency done and every ancestor approved. The last
 * condition is what holds a split bundle: its children are written as `open`,
 * and stay unclaimed until the parent is signed.
 *
 * The claim path checks the same thing again against a fresher board, so this
 * filter alone is not what keeps an unapproved child safe — it is what keeps
 * the scheduler from offering one.
 */
export function ready(tasks: Task[], done: Set<string>): Task[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return tasks.filter(
    (task) => task.status === "open"
      && task.dependsOn.every((dependency) => done.has(dependency))
      && draftAncestor(task, byId) === null,
  );
}

/** Test seams for the pass loop; production callers pass neither. */
export type SchedulerOptions = {
  /** Stop after this many passes and report what is still ready. */
  maxPasses?: number;
  /**
   * How one offered task is run. Replacing it lets a test exercise the pass
   * loop — readiness, the budget, the report — without paying for a real
   * claim, workspace reservation and digest per level of a long chain.
   */
  run?: typeof runTask;
};

/**
 * Run eligible tasks with up to `cfg.parallel` in flight, never two in the same
 * resource (a workdir, or the git repository it sits in). A task returned to
 * `open` by the reviewer is claimed again in the next pass, so one `taskctl run`
 * drives the rework loop until the retry limits stop it.
 *
 * `pending` lists ready tasks that were left unstarted because the pass budget
 * ran out. It is normally empty: the run ends because nothing is left to do.
 *
 * A task the budget guard refused (`src/budget.ts`) is offered once and is
 * not progress: it stays `open`, no model session was started for it, it is
 * unclaimed once the offer has returned, and the guard's answer will not
 * change while this run lasts. It is not offered again in a later pass, not
 * listed in `pending` (another `run` will not start it), and named once in
 * `refused`, which is present only when something was refused.
 */
export async function runScheduler(
  cfg: WorkerConfig,
  deps: WorkerDeps,
  options: SchedulerOptions = {},
): Promise<{ done: string[]; blocked: string[]; pending: string[]; refused?: string[] }> {
  const limit = Math.max(1, cfg.parallel ?? 2);
  const runOne = options.run ?? runTask;
  const result: { done: string[]; blocked: string[]; pending: string[]; refused?: string[] }
    = { done: [], blocked: [], pending: [] };
  const refused = new Set<string>();

  for (let pass = 0; ; pass++) {
    const snapshot = await deps.store.list();
    assertAcyclic(snapshot);

    const doneIds = new Set(snapshot.filter((task) => task.status === "done").map((task) => task.id));
    const pending = new Map(
      ready(snapshot, doneIds).filter((task) => !refused.has(task.id)).map((task) => [task.id, task]),
    );
    const busy = new Set<string>();
    const inflight = new Map<string, Promise<void>>();
    let ranThisPass = 0;

    const startAvailable = async (): Promise<void> => {
      for (const [id, task] of pending) {
        if (inflight.size >= limit) return;
        const workdir = taskWorkdir(cfg.workdir, task);
        const key = await resourceKey(workdir);
        if (busy.has(key)) continue;
        pending.delete(id);
        busy.add(key);
        const run = (async () => {
          try {
            const outcome = await runOne({ ...cfg, workdir }, deps, task, `worker-${process.pid}-${id}`);
            // A refused claim ran nothing: counting it as progress would offer
            // the same held task again until a pass count ran out. A task the
            // budget guard refused ran nothing either, so it is not progress
            // either; and it is not offered again in this run.
            if (outcome !== "skipped" && outcome !== "refused") ranThisPass += 1;
            if (outcome === "done" && !result.done.includes(id)) result.done.push(id);
            if (outcome === "blocked" && !result.blocked.includes(id)) result.blocked.push(id);
            if (outcome === "refused") refused.add(id);
          } finally {
            busy.delete(key);
            inflight.delete(id);
          }
        })();
        inflight.set(id, run);
      }
    };

    while (pending.size > 0 || inflight.size > 0) {
      await startAvailable();
      if (inflight.size === 0) break;
      await Promise.race([...inflight.values()]);
    }

    // Nothing ran: no eligible task left, so another pass would change nothing.
    // Progress is "did we run anything", not "did a status string change" — a
    // rework legitimately returns a task to the status it started in.
    if (ranThisPass === 0) break;
    // The backstop is not a statement about how long legitimate work takes. A
    // dependency chain costs one pass per level, so a fixed count used to cut
    // a valid deep chain off and leave the rest in `open` without a word.
    if (pass + 1 >= (options.maxPasses ?? passBudget(snapshot.length, cfg))) {
      const after = await deps.store.list();
      const doneNow = new Set(after.filter((task) => task.status === "done").map((task) => task.id));
      // A refused task is not work left for another `run`: that run would refuse it too.
      result.pending = ready(after, doneNow).filter((task) => !refused.has(task.id)).map((task) => task.id);
      break;
    }
  }
  // Present only when something was refused, so a caller that compares the whole object sees what it always did.
  if (refused.size > 0) result.refused = [...refused];
  return result;
}

/**
 * Passes a run may take before it stops and says so. Every task can be offered
 * once, fail `retryLimit` times and go through its review rounds; twice that
 * per task leaves room for the dependency levels between those attempts. It is
 * a backstop against a loop that never settles, not a budget real work fits in.
 */
export function passBudget(taskCount: number, cfg: Pick<WorkerConfig, "retryLimit" | "maxReviewRounds">): number {
  const perTask = 1 + cfg.retryLimit + (cfg.maxReviewRounds ?? MAX_REVIEW_ROUNDS_DEFAULT);
  return MAX_PASSES + 2 * taskCount * perTask;
}
