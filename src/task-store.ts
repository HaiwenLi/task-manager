import { readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseTaskFile, serializeTaskFile } from "./task-file.js";
import type { Task, TaskStatus } from "./task-file.js";

/** Marker file (in `tasks/<id>/`) written by `taskctl done`, polled by the worker. */
const DONE_MARKER = "done.requested";

/**
 * Filesystem store over a `tasks/` directory. Task files live at
 * `tasks/<id>.md`; per-task side files (locks, notes, markers) live in the
 * `tasks/<id>/` directory. Every mutation is a read-modify-write through
 * `<file>.tmp` + rename, so an interrupted write can never corrupt a task
 * file (ADR-0001).
 */
export class TaskStore {
  constructor(private readonly tasksDir: string) {}

  /** All tasks, sorted by filename. Only `*.md` files count as tasks. */
  async list(): Promise<Task[]> {
    const entries = await readdir(this.tasksDir, { withFileTypes: true });
    const names = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name)
      .sort();
    const tasks: Task[] = [];
    for (const name of names) {
      tasks.push(await this.get(idFromFilename(name)));
    }
    return tasks;
  }

  /** Read one task; `id` is the filename stem of `tasks/<id>.md`. */
  async get(id: string): Promise<Task> {
    return parseTaskFile(await readFile(this.taskFile(id), "utf8"), id);
  }

  /** Atomically move a task to a new lifecycle status. */
  async setStatus(id: string, status: TaskStatus): Promise<void> {
    await this.update(id, (task) => {
      task.status = status;
    });
  }

  /** Append a session id to the task's session chain (oldest first). */
  async appendSession(id: string, sessionId: string): Promise<void> {
    await this.update(id, (task) => {
      task.sessions.push(sessionId);
    });
  }

  /** Increment the retry counter and return the new value. */
  async incRetries(id: string): Promise<number> {
    const { retries } = await this.update(id, (task) => {
      task.retries += 1;
    });
    return retries;
  }

  /** True once `tasks/<id>/done.requested` exists. */
  async readDoneMarker(id: string): Promise<boolean> {
    try {
      await stat(this.doneMarkerFile(id));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw err;
    }
  }

  /** Remove the marker; clearing an absent marker is a no-op. */
  async clearDoneMarker(id: string): Promise<void> {
    await rm(this.doneMarkerFile(id), { force: true });
  }

  private taskFile(id: string): string {
    return join(this.tasksDir, `${id}.md`);
  }

  private doneMarkerFile(id: string): string {
    return join(this.tasksDir, id, DONE_MARKER);
  }

  /**
   * Read-modify-write that lands via `<file>.tmp` + rename, so readers only
   * ever see the old or the new file, never a half-written one.
   */
  private async update(id: string, mutate: (task: Task) => void): Promise<Task> {
    const task = await this.get(id);
    mutate(task);
    const file = this.taskFile(id);
    const tmp = `${file}.tmp`;
    await writeFile(tmp, serializeTaskFile(task), "utf8");
    await rename(tmp, file);
    return task;
  }
}

function idFromFilename(name: string): string {
  return name.slice(0, -".md".length);
}
