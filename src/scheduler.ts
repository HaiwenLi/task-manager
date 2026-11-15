import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { runTask, type WorkerConfig, type WorkerDeps } from "./worker.js";
import type { Task } from "./task-file.js";

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
 * hang rather than an error.
 */
export function assertAcyclic(tasks: Task[]): void {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!byId.has(dependency)) {
        throw new Error(`task ${task.id}: unknown task in depends_on: ${dependency}`);
      }
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
}

/** How many passes over the queue one `run` may take before giving up. */
const MAX_PASSES = 50;

function ready(tasks: Task[], done: Set<string>): Task[] {
  return tasks.filter(
    (task) => task.status === "open" && task.dependsOn.every((dependency) => done.has(dependency)),
  );
}

/**
 * Run eligible tasks with up to `cfg.parallel` in flight, never two in the same
 * resource (a workdir, or the git repository it sits in). A task returned to
 * `open` by the reviewer is claimed again in the next pass, so one `taskctl run`
 * drives the rework loop until the retry limits stop it.
 */
export async function runScheduler(
  cfg: WorkerConfig,
  deps: WorkerDeps,
): Promise<{ done: string[]; blocked: string[] }> {
  const limit = Math.max(1, cfg.parallel ?? 2);
  const result = { done: [] as string[], blocked: [] as string[] };

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const snapshot = await deps.store.list();
    assertAcyclic(snapshot);

    const doneIds = new Set(snapshot.filter((task) => task.status === "done").map((task) => task.id));
    const pending = new Map(ready(snapshot, doneIds).map((task) => [task.id, task]));
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
        ranThisPass += 1;
        const run = (async () => {
          try {
            const outcome = await runTask({ ...cfg, workdir }, deps, task, `worker-${process.pid}-${id}`);
            if (outcome === "done" && !result.done.includes(id)) result.done.push(id);
            if (outcome === "blocked" && !result.blocked.includes(id)) result.blocked.push(id);
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
  }
  return result;
}
