import matter from "gray-matter";
import type { GrayMatterFile } from "gray-matter";
import { dump } from "js-yaml";

/**
 * Lifecycle of a task as it moves through the pipeline.
 * `draft` and `awaiting-human` are human gates: the orchestrator parks a task
 * there and only a human command moves it out.
 */
export type TaskStatus = "draft" | "open" | "running" | "review" | "awaiting-human" | "done" | "blocked";

/** How much clarification a task gets before execution starts. */
export type TaskComplexity = "simple" | "complex";

/** How the controller paces work; independent of intake complexity and proof. */
export type TaskExecution = "continuous" | "iterative";

/** `high` tasks never finish on the reviewer's verdict alone. */
export type TaskRisk = "normal" | "high";

/**
 * What has to agree that the work is finished.
 *
 * `human` is the reviewer's verdict and stays the default. `mechanical` and
 * `render` replace that verdict with evidence the orchestrator produces itself:
 * a command that exits zero, or a headless render of the page that shows up and
 * fits. They exist because a reviewer reads code and diffs and never pixels — a
 * blank HTML page passes a code review, which is exactly what happened on the
 * task this was written for.
 */
export type TaskVerify = "human" | "mechanical" | "render";

/**
 * A kind of change a task declares it will not be blamed for.
 *
 * Work often runs against an artifact other people edit at the same time — a
 * shared spreadsheet, a table someone adds a column to. Without a declaration,
 * every such difference looks like the task's own careless edit, and the
 * reviewer has no choice but to fail it. The declaration is the operator's, not
 * the model's: it is parsed here, it is part of the task definition, and the
 * reviewer may only excuse the kinds listed.
 */
export type DriftKind = "external_cell_change" | "new_column" | "deleted_row" | "extra_file";

/** How each tolerated kind reads to a human and to the reviewer. */
export const DRIFT_HINTS: Record<DriftKind, string> = {
  external_cell_change: "别的单元格被改了，不是本任务写的那几个",
  // Deliberately narrower than "the table structure may change": a column
  // inserted by someone else is drift, a header whose meaning changed is a
  // different table and must fail. The prompt's rule 5 says the same thing; the
  // two used to disagree on the one case the real incident involved.
  new_column: "别人插入了一列（判据：没有改动已有列的含义，也没有删列）",
  deleted_row: "不是本任务写入的行消失了",
  // Only sound in the direction "someone else put a file here": a missing or
  // wrong deliverable is still the task's problem, whatever else appeared.
  extra_file: "别人往工作目录放了文件；本任务该产出的东西仍然必须存在且正确",
};

const DRIFT_KINDS = Object.keys(DRIFT_HINTS) as DriftKind[];

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
  /** Numbered acceptance criteria (`C1 …`); the reviewer judges exactly these. */
  criteria: string[];
  complexity: TaskComplexity;
  /** Continuous starts with one turn; iterative permits bounded feedback loops. */
  execution: TaskExecution;
  /** Optional worker-side bounded generation/check, distinct from acceptance. */
  workerSelfCheck?: string;
  workerSelfCheckTimeoutMs?: number;
  risk: TaskRisk;
  /** Workspace for this task, relative to the configured workdir. */
  workdir?: string;
  /**
   * Root-level filenames this task exempt from the post-turn sweep
   * (globs in the same dialect as `artifacts.scratchPatterns`). Empty means
   * nothing is exempt. Not part of the definition digest: it decides where
   * litter is parked, not what "done" means.
   */
  keepAtRoot: string[];
  /** Tasks that must be `done` before this one may be claimed. */
  dependsOn: string[];
  /** Explicit human sign-off regardless of risk. */
  humanCheck: boolean;
  /** External changes this task agrees to tolerate; see {@link DriftKind}. */
  tolerate: DriftKind[];
  /**
   * Captured without a clarify session and without a spec: the intent itself is
   * the definition. Cheap to start, and the cost is that nothing was written down
   * to check the work against — which is why a quick task is never left to finish
   * on its own say-so.
   */
  quick: boolean;
  /** What stands in for the reviewer's verdict; see {@link TaskVerify}. */
  verify: TaskVerify;
  /** Files a `render` check opens, relative to the workdir; empty otherwise. */
  renderTargets: string[];
  /** How many review rounds have failed so far. */
  reviewRounds: number;
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

/**
 * The one frontmatter value that turns a Markdown file in `tasks/` into a task.
 *
 * "Markdown is the source of truth" (ADR-0001) never said *every* Markdown file
 * is a task: a hand-taken snapshot dropped into the directory was picked up and
 * scheduled six times before anyone noticed. Registration is therefore explicit
 * — the file declares the schema it was written for, and everything else in the
 * directory is inert. Adding a field to the vocabulary later becomes a migration
 * with a name, not a silent reinterpretation of existing files.
 */
export const TASK_SCHEMA = "taskctl/v1";

/**
 * The `schema` a file's frontmatter declares, or `undefined` when it declares
 * none (or cannot be read at all).
 *
 * Only the frontmatter is looked at: the body of a non-task Markdown file is
 * arbitrary text and must never be parsed as one.
 */
export function declaredTaskSchema(raw: string): unknown {
  try {
    return (matter(raw).data ?? {})["schema"];
  } catch {
    return undefined;
  }
}

const STATUSES: readonly TaskStatus[] = ["draft", "open", "running", "review", "awaiting-human", "done", "blocked"];
const COMPLEXITIES: readonly TaskComplexity[] = ["simple", "complex"];
const EXECUTIONS: readonly TaskExecution[] = ["continuous", "iterative"];
const RISKS: readonly TaskRisk[] = ["normal", "high"];
const VERIFIES: readonly TaskVerify[] = ["human", "mechanical", "render"];

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
  // A render check with no target would report success having opened nothing, so
  // the pairing is validated here rather than at the point of use.
  const verify = parseEnum(data, "verify", VERIFIES, "human", id);
  const complexity = parseEnum(data, "complexity", COMPLEXITIES, "complex", id);
  const renderTargets = parseStringList(data, "render_targets", id);
  if (verify === "render" && renderTargets.length === 0) {
    throw new TaskFileError(`task file ${id}: verify render needs at least one render_targets entry`);
  }
  return {
    id,
    title: requiredString(data, "title", id),
    description: parsed.content,
    status: parseStatus(data, id),
    model: optionalString(data, "model", id),
    effort: optionalString(data, "effort", id),
    acceptance: optionalString(data, "acceptance", id),
    criteria: parseCriteria(data, id),
    complexity,
    execution: parseEnum(data, "execution", EXECUTIONS, complexity === "simple" ? "continuous" : "iterative", id),
    workerSelfCheck: optionalString(data, "worker_self_check", id),
    workerSelfCheckTimeoutMs: optionalPositiveInteger(data, "worker_self_check_timeout_ms", id),
    risk: parseEnum(data, "risk", RISKS, "normal", id),
    workdir: optionalString(data, "workdir", id),
    keepAtRoot: parseStringList(data, "keep_at_root", id),
    dependsOn: parseDependsOn(data, id),
    humanCheck: parseHumanCheck(data, id),
    tolerate: parseTolerate(data, id),
    quick: parseQuick(data, id),
    verify,
    renderTargets,
    reviewRounds: parseReviewRounds(data, id),
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
    // Registration marker first: `tasks/` holds other Markdown too, and only a
    // file that declares the schema is scheduled (see {@link TASK_SCHEMA}).
    schema: TASK_SCHEMA,
    id: task.id,
    title: task.title,
    status: task.status,
    ...(task.model !== undefined && { model: task.model }),
    ...(task.effort !== undefined && { effort: task.effort }),
    ...(task.acceptance !== undefined && { acceptance: task.acceptance }),
    ...(task.criteria.length > 0 && { criteria: task.criteria }),
    complexity: task.complexity,
    execution: task.execution,
    ...(task.workerSelfCheck !== undefined && { worker_self_check: task.workerSelfCheck }),
    ...(task.workerSelfCheckTimeoutMs !== undefined && { worker_self_check_timeout_ms: task.workerSelfCheckTimeoutMs }),
    ...(task.risk === "high" && { risk: task.risk }),
    ...(task.workdir !== undefined && { workdir: task.workdir }),
    ...(task.keepAtRoot.length > 0 && { keep_at_root: task.keepAtRoot }),
    ...(task.dependsOn.length > 0 && { depends_on: task.dependsOn }),
    ...(task.humanCheck && { human_check: task.humanCheck }),
    ...(task.tolerate.length > 0 && { tolerate: task.tolerate }),
    ...(task.quick && { quick: task.quick }),
    ...(task.verify !== "human" && { verify: task.verify }),
    ...(task.renderTargets.length > 0 && { render_targets: task.renderTargets }),
    sessions: task.sessions,
    retries: task.retries,
    review_rounds: task.reviewRounds,
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

function optionalPositiveInteger(data: Record<string, unknown>, key: string, id: string): number | undefined {
  const value = data[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new TaskFileError(`task file ${id}: field ${key} must be a positive integer`);
  }
  return value;
}

function parseEnum<T extends string>(
  data: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  fallback: T,
  id: string,
): T {
  const value = data[key];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new TaskFileError(
      `task file ${id}: field ${key} must be one of: ${allowed.join(", ")}`,
    );
  }
  return value as T;
}

function parseCriteria(data: Record<string, unknown>, id: string): string[] {
  const value = data.criteria;
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new TaskFileError(`task file ${id}: field criteria must be a list of non-empty strings`);
  }
  return [...value];
}

function parseDependsOn(data: Record<string, unknown>, id: string): string[] {
  const value = data.depends_on;
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new TaskFileError(`task file ${id}: field depends_on must be a list of task ids`);
  }
  if (value.includes(id)) {
    throw new TaskFileError(`task file ${id}: depends_on must not include itself`);
  }
  return [...value];
}

/**
 * Tolerated drift kinds. An unknown kind is an error, not a silent no-op: a typo
 * in `new_colunm` would otherwise look like a declaration while excusing
 * nothing, and the operator would read the rework as the reviewer ignoring them.
 */
function parseTolerate(data: Record<string, unknown>, id: string): DriftKind[] {
  const value = data.tolerate;
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new TaskFileError(`task file ${id}: field tolerate must be a list of kinds`);
  }
  const kinds: DriftKind[] = [];
  for (const item of value) {
    const kind = typeof item === "string" ? item.trim() : "";
    if (!(DRIFT_KINDS as readonly string[]).includes(kind)) {
      throw new TaskFileError(
        `task file ${id}: unknown tolerate kind "${typeof item === "string" ? item : String(item)}" (expected one of: ${DRIFT_KINDS.join(", ")})`,
      );
    }
    if (!kinds.includes(kind as DriftKind)) kinds.push(kind as DriftKind);
  }
  return kinds;
}

function parseHumanCheck(data: Record<string, unknown>, id: string): boolean {
  const value = data.human_check;
  if (value === undefined) {
    return false;
  }
  if (typeof value !== "boolean") {
    throw new TaskFileError(`task file ${id}: field human_check must be a boolean`);
  }
  return value;
}

function parseQuick(data: Record<string, unknown>, id: string): boolean {
  const value = data.quick;
  if (value === undefined) {
    return false;
  }
  if (typeof value !== "boolean") {
    throw new TaskFileError(`task file ${id}: field quick must be a boolean`);
  }
  return value;
}

function parseStringList(data: Record<string, unknown>, key: string, id: string): string[] {
  const value = data[key];
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new TaskFileError(`task file ${id}: field ${key} must be a list of non-empty strings`);
  }
  return [...value];
}

function parseReviewRounds(data: Record<string, unknown>, id: string): number {
  const value = data.review_rounds;
  if (value === undefined) {
    return 0;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new TaskFileError(`task file ${id}: field review_rounds must be a non-negative integer`);
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
