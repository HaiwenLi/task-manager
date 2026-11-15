import { resolve } from "node:path";
import { runTask, type WorkerConfig, type WorkerDeps } from "./worker.js";
import type { Task } from "./task-file.js";

/** Where a task runs: its own `workdir` under the configured one, or the configured one. */
export function taskWorkdir(base: string, task: Task): string {
  return task.workdir === undefined ? base : resolve(base, task.workdir);
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

function ready(tasks: Task[], done: Set<string>): Task[] {
  return tasks.filter(
    (task) => task.status === "open" && task.dependsOn.every((dependency) => done.has(dependency)),
  );
}

/**
 * Run eligible tasks with up to `cfg.parallel` in flight, never two in the
 * same workdir. A dependency that is not `done` keeps its dependants in `open`:
 * the queue is re-scanned, not reordered.
 */
export async function runScheduler(
  cfg: WorkerConfig,
  deps: WorkerDeps,
): Promise<{ done: string[]; blocked: string[] }> {
  const limit = Math.max(1, cfg.parallel ?? 2);
  const result = { done: [] as string[], blocked: [] as string[] };
  const snapshot = await deps.store.list();
  assertAcyclic(snapshot);

  const doneIds = new Set(snapshot.filter((task) => task.status === "done").map((task) => task.id));
  const pending = new Map(ready(snapshot, doneIds).map((task) => [task.id, task]));
  const busy = new Set<string>();
  const inflight = new Map<string, Promise<void>>();

  const startAvailable = (): void => {
    for (const [id, task] of pending) {
      if (inflight.size >= limit) return;
      const workdir = taskWorkdir(cfg.workdir, task);
      if (busy.has(workdir)) continue;
      pending.delete(id);
      busy.add(workdir);
      const run = (async () => {
        try {
          const outcome = await runTask({ ...cfg, workdir }, deps, task, `worker-${process.pid}-${id}`);
          if (outcome === "done") result.done.push(id);
          if (outcome === "blocked") result.blocked.push(id);
        } finally {
          busy.delete(workdir);
          inflight.delete(id);
        }
      })();
      inflight.set(id, run);
    }
  };

  while (pending.size > 0 || inflight.size > 0) {
    startAvailable();
    if (inflight.size === 0) break;
    await Promise.race([...inflight.values()]);
  }
  return result;
}
