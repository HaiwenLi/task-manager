import { readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { declaredTaskSchema, parseTaskFile, serializeTaskFile, TASK_SCHEMA } from "./task-file.js";
import type { Task, TaskStatus } from "./task-file.js";

/** Marker file (in `tasks/<id>/`) written by `taskctl done`, polled by the worker. */
const DONE_MARKER = "done.requested";

/** What one pass over `tasks/` found: registered tasks, and files it refused. */
export type TaskScan = {
  tasks: Task[];
  /**
   * `.md` files that did not declare {@link TASK_SCHEMA}, by filename. They are
   * reported once by `taskctl status` and never parsed, scheduled, or rewritten.
   */
  ignored: string[];
};

/** The pipeline fields a caller may patch in one guarded write. */
export type TaskFieldsPatch = Partial<
  Pick<
    Task,
    "status" | "description" | "criteria" | "workdir" | "complexity" | "execution" | "risk" | "humanCheck" | "dependsOn" | "retries" | "reviewRounds"
  >
>;

/**
 * Filesystem store over a `tasks/` directory. Task files live at
 * `tasks/<id>.md`; per-task side files (locks, notes, markers) live in the
 * `tasks/<id>/` directory. Every mutation is a read-modify-write through
 * `<file>.tmp` + rename, so an interrupted write can never corrupt a task
 * file (ADR-0001).
 */
export class TaskStore {
  constructor(private readonly tasksDir: string) {}

  /**
   * All registered tasks, sorted by filename, plus the files that were refused
   * registration. Only `*.md` files count; among those, only one whose
   * frontmatter declares {@link TASK_SCHEMA} is a task (ADR-0001's "Markdown is
   * the source of truth" is about content, not about the directory being a
   * task inbox). Anything else — a hand-taken snapshot, a scratch note, a draft
   * nobody has declared — is reported and left alone.
   */
  async scan(): Promise<TaskScan> {
    const entries = await readdir(this.tasksDir, { withFileTypes: true });
    const names = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name)
      .sort();
    const tasks: Task[] = [];
    const ignored: string[] = [];
    for (const name of names) {
      const id = idFromFilename(name);
      const raw = await readFile(this.taskFile(id), "utf8");
      // A file that does not declare the schema is not parsed at all: its body
      // is somebody's notes, not a task description with fields.
      if (declaredTaskSchema(raw) !== TASK_SCHEMA) {
        ignored.push(name);
        continue;
      }
      tasks.push(parseTaskFile(raw, id));
    }
    return { tasks, ignored };
  }

  /** All registered tasks, sorted by filename. */
  async list(): Promise<Task[]> {
    return (await this.scan()).tasks;
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

  /** Increment the failed-review counter and return the new value. */
  async incReviewRounds(id: string): Promise<number> {
    const { reviewRounds } = await this.update(id, (task) => {
      task.reviewRounds += 1;
    });
    return reviewRounds;
  }

  /** Patch a fixed set of pipeline fields; keys absent from `patch` stay unchanged. */
  async updateFields(id: string, patch: TaskFieldsPatch): Promise<Task> {
    return this.update(id, (task) => {
      for (const key of Object.keys(patch) as Array<keyof TaskFieldsPatch>) {
        const value = patch[key];
        if (value !== undefined) {
          (task as unknown as Record<string, unknown>)[key] = value;
        }
      }
    });
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
