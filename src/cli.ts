import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { LOCK_TTL_MS_DEFAULT } from "./claim.js";
import { latestNote, writeNote } from "./handoff.js";
import { TaskStore } from "./task-store.js";
import { runWorker, type WorkerConfig } from "./worker.js";
import { OpenCodeAdapter } from "./adapters/opencode.js";
import type { AgentAdapter } from "./adapters/types.js";

/** Injection seams for tests: adapter (for `run`), clock (for `done`), output. */
export type CliDeps = {
  adapter?: AgentAdapter;
  now?: () => Date;
  log?: (line: string) => void;
  err?: (line: string) => void;
};

/** Resolved `taskctl.json` — a WorkerConfig plus the adapter's binary name. */
type ResolvedConfig = WorkerConfig & { opencodeBin?: string };

/** Usage problem (unknown command/flag, missing value): exit code 2. */
class UsageError extends Error {}

const USAGE = [
  "usage:",
  "  taskctl run [--config taskctl.json]",
  "  taskctl done --task <id> [--tasks-dir <dir>]",
  "  taskctl note --task <id> --status <s> --done <d> --found <f> --next <n> [--files <a,b>] [--tasks-dir <dir>]",
  "  taskctl status [--tasks-dir <dir>]",
].join("\n");

/** Marker file the `done` subcommand writes; mirrors task-store's DONE_MARKER. */
const DONE_MARKER = "done.requested";

/** Default `--tasks-dir` for the agent-facing subcommands (matches the protocol copy). */
const TASKS_DIR_DEFAULT = "tasks";

/**
 * Parse argv and run one subcommand. Hand-rolled `--flag value` parsing —
 * no CLI dependency (binding constraint). Values pass through untouched, so
 * newlines, quotes and Chinese land in note files verbatim (Review Focus 5).
 * Returns the process exit code: 0 ok, 1 runtime error, 2 usage error.
 */
export async function runCli(argv: string[], deps: CliDeps = {}): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  try {
    return await dispatch(argv, deps, log);
  } catch (e) {
    if (e instanceof UsageError) {
      err(`taskctl: ${e.message}`);
      err(USAGE);
      return 2;
    }
    err(`taskctl: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

async function dispatch(argv: string[], deps: CliDeps, log: (line: string) => void): Promise<number> {
  const { command, positionals, flags } = parseArgs(argv);
  if (command === undefined) {
    throw new UsageError("missing command");
  }
  if (positionals.length > 0) {
    throw new UsageError(`unexpected argument "${positionals[0]}"`);
  }
  switch (command) {
    case "run":
      checkFlags(command, flags, ["config"], []);
      return runCommand(flags, deps, log);
    case "done":
      checkFlags(command, flags, ["task", "tasks-dir"], ["task"]);
      return doneCommand(flags, deps, log);
    case "note":
      checkFlags(command, flags, ["task", "status", "done", "found", "next", "files", "tasks-dir"], [
        "task",
        "status",
        "done",
        "found",
        "next",
      ]);
      return noteCommand(flags, log);
    case "status":
      checkFlags(command, flags, ["tasks-dir"], []);
      return statusCommand(flags, log);
    default:
      throw new UsageError(`unknown command "${command}"`);
  }
}

/** `taskctl run` — load config, assemble adapter + store, drain the queue. */
async function runCommand(flags: Map<string, string>, deps: CliDeps, log: (line: string) => void): Promise<number> {
  const configPath = flags.get("config") ?? "taskctl.json";
  const cfg = resolveConfig(await readConfig(configPath), configPath);
  const adapter = deps.adapter ?? new OpenCodeAdapter({ bin: cfg.opencodeBin });
  const store = new TaskStore(cfg.tasksDir);
  // Plan Task 9：逐事件打印 [task] 状态 单行日志 —— 事件发生即输出，
  // 而不是整队跑完再补一份总结
  await runWorker(cfg, {
    store,
    adapter,
    onEvent: (evt) => log(`[${evt.taskId}] ${evt.type}${evt.detail ? ` ${evt.detail}` : ""}`),
  });
  return 0;
}

/** `taskctl done --task <id>` — write the marker the worker polls for. */
async function doneCommand(flags: Map<string, string>, deps: CliDeps, log: (line: string) => void): Promise<number> {
  const tasksDir = flags.get("tasks-dir") ?? TASKS_DIR_DEFAULT;
  const id = flags.get("task")!;
  await mkdir(join(tasksDir, id), { recursive: true });
  const marker = join(tasksDir, id, DONE_MARKER);
  await writeFile(marker, (deps.now ?? (() => new Date))().toISOString(), "utf8");
  log(marker);
  return 0;
}

/** `taskctl note …` — append the next numbered handoff note, print its path. */
async function noteCommand(flags: Map<string, string>, log: (line: string) => void): Promise<number> {
  const tasksDir = flags.get("tasks-dir") ?? TASKS_DIR_DEFAULT;
  const files = (flags.get("files") ?? "")
    .split(",")
    .map((file) => file.trim())
    .filter((file) => file.length > 0);
  const latest = await latestNote(tasksDir, flags.get("task")!);
  const path = await writeNote(tasksDir, {
    task: flags.get("task")!,
    seq: (latest?.seq ?? 0) + 1,
    status: flags.get("status")!,
    done: flags.get("done")!,
    found: flags.get("found")!,
    next: flags.get("next")!,
    files,
  });
  log(path);
  return 0;
}

/** `taskctl status` — one table row per task. */
async function statusCommand(flags: Map<string, string>, log: (line: string) => void): Promise<number> {
  const tasksDir = flags.get("tasks-dir") ?? TASKS_DIR_DEFAULT;
  const store = new TaskStore(tasksDir);
  const tasks = await store.list();
  const rows: string[][] = [["id", "status", "retries", "sessions", "note"]];
  for (const task of tasks) {
    const note = await latestNote(tasksDir, task.id);
    rows.push([
      task.id,
      task.status,
      String(task.retries),
      String(task.sessions.length),
      note === null ? "-" : statusLineFromNote(note.markdown),
    ]);
  }
  for (const line of renderTable(rows)) {
    log(line);
  }
  return 0;
}

/** `--flag value` tokens into a map; bare tokens become positionals. */
function parseArgs(argv: string[]): { command?: string; positionals: string[]; flags: Map<string, string> } {
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token.startsWith("--")) {
      const value = argv[++i];
      if (value === undefined) {
        throw new UsageError(`option ${token} requires a value`);
      }
      flags.set(token.slice(2), value);
    } else {
      positionals.push(token);
    }
  }
  return { command: positionals.shift(), positionals, flags };
}

/** Reject unknown flags, then require the mandatory ones. */
function checkFlags(command: string, flags: Map<string, string>, allowed: string[], required: string[]): void {
  for (const key of flags.keys()) {
    if (!allowed.includes(key)) {
      throw new UsageError(`unknown option --${key} for command ${command}`);
    }
  }
  for (const key of required) {
    if (!flags.has(key)) {
      throw new UsageError(`missing required option --${key} for command ${command}`);
    }
  }
}

/** Read `taskctl.json`; a missing file means "all defaults". */
async function readConfig(path: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`config ${path}: invalid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`config ${path}: expected a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/** Fields a `taskctl.json` may carry (v0.1). */
const CONFIG_KEYS = new Set([
  "tasksDir",
  "workdir",
  "agent",
  "model",
  "effort",
  "contextThreshold",
  "retryLimit",
  "lockTtlMs",
  "heartbeatMs",
  "turnTimeoutMs",
  "acceptanceTimeoutMs",
  "maxSessionsPerTask",
  "maxTurnsPerSession",
  "opencodeBin",
]);

/** Merge config file over the defaults; every present field is validated. */
function resolveConfig(raw: Record<string, unknown>, path: string): ResolvedConfig {
  for (const key of Object.keys(raw)) {
    if (!CONFIG_KEYS.has(key)) {
      throw new Error(`config ${path}: unknown field "${key}"`);
    }
  }
  const agent = string(raw, "agent", path) ?? "opencode";
  if (agent !== "opencode") {
    throw new Error(`config ${path}: unknown agent "${agent}" (v0.1: opencode)`);
  }
  return {
    tasksDir: resolve(string(raw, "tasksDir", path) ?? TASKS_DIR_DEFAULT),
    workdir: resolve(string(raw, "workdir", path) ?? process.cwd()),
    agent,
    model: string(raw, "model", path),
    effort: string(raw, "effort", path),
    contextThreshold: number(raw, "contextThreshold", path) ?? 0.8,
    retryLimit: integer(raw, "retryLimit", path) ?? 3,
    lockTtlMs: number(raw, "lockTtlMs", path) ?? LOCK_TTL_MS_DEFAULT,
    heartbeatMs: number(raw, "heartbeatMs", path) ?? 60_000,
    turnTimeoutMs: number(raw, "turnTimeoutMs", path),
    acceptanceTimeoutMs: number(raw, "acceptanceTimeoutMs", path),
    maxSessionsPerTask: integer(raw, "maxSessionsPerTask", path),
    maxTurnsPerSession: integer(raw, "maxTurnsPerSession", path),
    opencodeBin: string(raw, "opencodeBin", path),
  };
}

function string(raw: Record<string, unknown>, key: string, path: string): string | undefined {
  const value = raw[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`config ${path}: field "${key}" must be a non-empty string`);
  }
  return value;
}

function number(raw: Record<string, unknown>, key: string, path: string): number | undefined {
  const value = raw[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`config ${path}: field "${key}" must be a positive finite number`);
  }
  return value;
}

function integer(raw: Record<string, unknown>, key: string, path: string): number | undefined {
  const value = number(raw, key, path);
  if (value !== undefined && !Number.isInteger(value)) {
    throw new Error(`config ${path}: field "${key}" must be an integer`);
  }
  return value;
}

/**
 * The `## Status` section's first non-empty line — the "一句话状态" a
 * `taskctl note` leaves behind. Multiline statuses are represented by their
 * first line so every table row stays a single line.
 */
function statusLineFromNote(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const heading = lines.indexOf("## Status");
  if (heading === -1) {
    return "-";
  }
  for (let i = heading + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("## ")) {
      break;
    }
    if (line.trim().length > 0) {
      return line.trim();
    }
  }
  return "-";
}

/** Pad every column to the widest cell; the last column is trim-ended. */
function renderTable(rows: string[][]): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows.map((row) =>
    row.map((cell, i) => cell.padEnd(widths[i]!)).join("  ").trimEnd(),
  );
}
