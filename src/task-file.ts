import matter from "gray-matter";
import type { GrayMatterFile } from "gray-matter";
import { dump } from "js-yaml";

/** Lifecycle of a task as it moves through the orchestrator. */
export type TaskStatus = "open" | "running" | "done" | "blocked";

/**
 * A task as stored in `tasks/<id>.md`: YAML frontmatter + markdown body.
 * The body is the description; `model` is `provider/model`; `effort` maps to
 * the OpenCode variant of that model.
 */
export type Task = {
  /** Filename stem of the task file; authoritative over any frontmatter copy. */
  id: string;
  title: string;
  /** Markdown body below the frontmatter. */
  description: string;
  status: TaskStatus;
  /** Agent model in `provider/model` form. */
  model?: string;
  /** OpenCode effort variant (e.g. `high`). */
  effort?: string;
  /** Command that must pass before a task may be marked done. */
  acceptance?: string;
  /** Session ids that have worked on this task, oldest first. */
  sessions: string[];
  /** Number of failed attempts so far. */
  retries: number;
};

/** Raised when a task file cannot be parsed or fails field validation. */
export class TaskFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskFileError";
  }
}

const STATUSES: readonly TaskStatus[] = ["open", "running", "done", "blocked"];

/**
 * Parse the contents of `tasks/<id>.md`. `id` comes from the filename, not the
 * frontmatter, so the store can trust it even when the file is corrupted.
 * Throws {@link TaskFileError} (message includes the file id) on malformed
 * frontmatter or invalid fields.
 */
export function parseTaskFile(raw: string, id: string): Task {
  const lines = raw.split(/\r?\n/);
  if (lines[0] !== undefined && lines[0].trim() === "---") {
    const closed = lines.slice(1).some((line) => line.trim() === "---");
    if (!closed) {
      throw new TaskFileError(`task file ${id}: frontmatter is missing its closing --- delimiter`);
    }
  }

  let parsed: GrayMatterFile;
  try {
    parsed = matter(raw);
  } catch (err) {
    throw new TaskFileError(`task file ${id}: invalid YAML frontmatter (${errorMessage(err)})`);
  }

  const data = parsed.data ?? {};
  return {
    id,
    title: requiredString(data, "title", id),
    description: parsed.content,
    status: parseStatus(data, id),
    model: optionalString(data, "model", id),
    effort: optionalString(data, "effort", id),
    acceptance: optionalString(data, "acceptance", id),
    sessions: parseSessions(data, id),
    retries: parseRetries(data, id),
  };
}

/**
 * Render a task back to `tasks/<id>.md` form. Optional fields are omitted when
 * unset; values stay on one line each (`lineWidth: -1`) so the files are
 * grep-friendly and diffs stay small.
 */
export function serializeTaskFile(task: Task): string {
  const frontmatter: Record<string, unknown> = {
    id: task.id,
    title: task.title,
    status: task.status,
    ...(task.model !== undefined && { model: task.model }),
    ...(task.effort !== undefined && { effort: task.effort }),
    ...(task.acceptance !== undefined && { acceptance: task.acceptance }),
    sessions: task.sessions,
    retries: task.retries,
  };
  return `---\n${dump(frontmatter, { lineWidth: -1 })}---\n${task.description}`;
}

function parseStatus(data: Record<string, unknown>, id: string): TaskStatus {
  const status = data.status;
  if (typeof status !== "string" || !STATUSES.includes(status as TaskStatus)) {
    throw new TaskFileError(
      `task file ${id}: unknown status ${JSON.stringify(status) ?? ""} (expected one of: ${STATUSES.join(", ")})`,
    );
  }
  return status as TaskStatus;
}

function requiredString(data: Record<string, unknown>, key: string, id: string): string {
  const value = data[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new TaskFileError(`task file ${id}: missing required field ${key}`);
  }
  return value;
}

function optionalString(data: Record<string, unknown>, key: string, id: string): string | undefined {
  const value = data[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new TaskFileError(`task file ${id}: field ${key} must be a string`);
  }
  return value;
}

function parseSessions(data: Record<string, unknown>, id: string): string[] {
  const value = data.sessions;
  if (!Array.isArray(value) || value.some((session) => typeof session !== "string")) {
    throw new TaskFileError(`task file ${id}: field sessions must be a list of session ids`);
  }
  // gray-matter caches parsed frontmatter by source text. Never hand its
  // mutable array to a caller: equal task files must not share session chains.
  return [...value];
}

function parseRetries(data: Record<string, unknown>, id: string): number {
  const value = data.retries;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new TaskFileError(`task file ${id}: field retries must be a non-negative integer`);
  }
  return value;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
