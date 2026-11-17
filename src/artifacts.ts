import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, copyFile, lstat, mkdir, readdir, rename, unlink } from "node:fs/promises";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import { ignorePatternRegExp } from "./workspace.js";

const exec = promisify(execFile);

/** Environment variable carrying the task's own directory to the worker. */
export const TASK_DIR_ENV = "TASKCTL_TASK_DIR";
/** Environment variable carrying the worker's mandatory log directory. */
export const LOG_DIR_ENV = "TASKCTL_LOG_DIR";

/** `<tasksDir>/<id>` — runtime records, notes and evidence for one task. */
export const taskDirOf = (tasksDir: string, id: string): string => join(tasksDir, id);
/** `<taskDir>/logs` — where a worker must write logs and temporary files. */
export const logDirOf = (tasksDir: string, id: string): string => join(tasksDir, id, "logs");
/** `<taskDir>/scratch` — where the post-turn sweep parks root litter. */
export const scratchDirOf = (tasksDir: string, id: string): string => join(tasksDir, id, "scratch");

/**
 * Default `artifacts.scratchPatterns` (confirmed 2026-11-17): the shapes the
 * 001–004 runs left behind at the workspace root — run logs, temp files,
 * underscore-prefixed scratch, checksums and redirected text output.
 */
export const DEFAULT_SCRATCH_PATTERNS = ["*.log", "*.tmp", "_*", "*.sha", "*.txt"];

/** Resolved `artifacts` block of `taskctl.json`. */
export type ArtifactsConfig = {
  /** Whether the post-turn root sweep runs at all. */
  sweep: boolean;
  /** Filename globs (workspace-root, single-segment dialect) that count as litter. */
  scratchPatterns: string[];
};

/**
 * Parse and validate the `artifacts` object from `taskctl.json`. Absent means
 * the defaults (sweep on, default patterns); a malformed block is a config
 * error, never a silent no-op — an operator who writes `"sweep": "false"`
 * meant to turn the sweep off and must hear that they did not.
 */
export function resolveArtifacts(raw: unknown, path: string): ArtifactsConfig {
  if (raw === undefined) return { sweep: true, scratchPatterns: [...DEFAULT_SCRATCH_PATTERNS] };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`config ${path}: field "artifacts" must be an object`);
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "sweep" && key !== "scratchPatterns") {
      throw new Error(`config ${path}: unknown artifacts field "${key}"`);
    }
  }
  const sweep = record.sweep === undefined ? true : record.sweep;
  if (typeof sweep !== "boolean") {
    throw new Error(`config ${path}: artifacts.sweep must be a boolean`);
  }
  const patterns = record.scratchPatterns === undefined ? DEFAULT_SCRATCH_PATTERNS : record.scratchPatterns;
  if (!Array.isArray(patterns) || patterns.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    throw new Error(`config ${path}: artifacts.scratchPatterns must be an array of non-empty strings`);
  }
  return { sweep, scratchPatterns: [...patterns] };
}

/** The config a run actually uses when `taskctl.json` carries no `artifacts` block. */
export function artifactsOrDefault(cfg: ArtifactsConfig | undefined): ArtifactsConfig {
  return cfg ?? { sweep: true, scratchPatterns: [...DEFAULT_SCRATCH_PATTERNS] };
}

/**
 * Non-recursive listing of the workspace root, taken immediately before a
 * turn. Only names absent from this snapshot are sweep candidates later:
 * a file that existed before the turn — tracked or not — is never touched.
 */
export async function snapshotRoot(workdir: string): Promise<Set<string>> {
  try {
    return new Set(await readdir(workdir));
  } catch {
    return new Set();
  }
}

/**
 * Root-level entries Git reports as untracked (`??`) or ignored (`!!`).
 * Ignored counts as untracked on purpose: artifact hygiene does not lean on
 * `.gitignore` (the same stance as the acceptance digest, which never consults
 * ignore rules). Null when Git cannot answer — no Git on PATH, not a
 * repository, or the call failed — and the caller must then leave the sweep
 * inert rather than guess at "untracked".
 */
async function untrackedRootNames(workdir: string): Promise<Set<string> | null> {
  let stdout: string;
  try {
    const result = await exec(
      "git",
      ["-C", workdir, "-c", "core.quotepath=false", "status", "--porcelain", "-z", "--ignored=traditional"],
      {
        maxBuffer: 8 * 1024 * 1024,
        timeout: 10_000,
        env: { ...process.env, LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0" },
      },
    );
    stdout = result.stdout;
  } catch {
    return null;
  }
  const names = new Set<string>();
  const fields = stdout.split("\0").filter((field) => field.length > 0);
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!;
    if (field.length < 4) continue; // `XY <path>` is the shortest legal shape
    const status = field.slice(0, 2);
    const path = field.slice(3);
    // In -z format a rename/copy entry carries its origin path as the next
    // field; skip it so it is never mistaken for an entry of its own.
    if (status.includes("R") || status.includes("C")) i++;
    if (status !== "??" && status !== "!!") continue;
    if (path.includes("/")) continue; // root level only; directories arrive as `name/`
    names.add(path);
  }
  return names;
}

/** One swept file: where it stood, where it landed. Absolute paths both. */
export type SweepMove = { from: string; to: string };

/** What a sweep actually did — the caller journals this, nothing more. */
export type SweepOutcome = {
  moved: SweepMove[];
  failures: Array<{ file: string; error: string }>;
  /** Set when the sweep did not even consider candidates, and why. */
  skipped?: string;
};

/**
 * Move this turn's new, untracked, pattern-matching root files into
 * `<taskDir>/scratch/`. Never deletes, never overwrites (a name already taken
 * in scratch gets a `-N` suffix), never touches directories, and never throws:
 * per-file failures land in `failures` for the caller to journal.
 *
 * A file moves only when ALL of these hold:
 *  - it did not exist in the pre-turn snapshot;
 *  - Git reports it untracked or ignored now;
 *  - its name matches a `scratchPatterns` glob;
 *  - it matches no `keepAtRoot` glob (the task's exemption list).
 */
export async function sweepRoot(opts: {
  workdir: string;
  scratchDir: string;
  before: ReadonlySet<string>;
  patterns: string[];
  keepAtRoot: string[];
}): Promise<SweepOutcome> {
  const outcome: SweepOutcome = { moved: [], failures: [] };
  const untracked = await untrackedRootNames(opts.workdir);
  if (untracked === null) {
    return { ...outcome, skipped: "git unavailable (not a repository or git missing); sweep stayed inert" };
  }
  let names: string[];
  try {
    names = (await readdir(opts.workdir)).sort();
  } catch (error) {
    return { ...outcome, skipped: `workspace root unreadable: ${message(error)}` };
  }
  const litter = opts.patterns.map((pattern) => ignorePatternRegExp(pattern));
  const keep = opts.keepAtRoot.map((pattern) => ignorePatternRegExp(pattern));
  await mkdir(opts.scratchDir, { recursive: true });
  for (const name of names) {
    if (opts.before.has(name)) continue;
    if (!untracked.has(name)) continue;
    const from = join(opts.workdir, name);
    let entry;
    try {
      entry = await lstat(from);
    } catch {
      continue; // vanished between listing and lstat; nothing to move
    }
    if (!entry.isFile()) continue; // only regular files move, never directories
    if (!litter.some((regexp) => regexp.test(name))) continue;
    if (keep.some((regexp) => regexp.test(name))) continue;
    try {
      outcome.moved.push({ from, to: await moveInto(from, opts.scratchDir, name) });
    } catch (error) {
      outcome.failures.push({ file: from, error: message(error) });
    }
  }
  return outcome;
}

/**
 * Move one file into `scratchDir`, suffixing `-N` before the extension when
 * the name is already taken. `rename` overwrites on every platform, so
 * existence is checked first — a sweep must never lose what an earlier sweep
 * parked. Cross-device renames fall back to copy+unlink, which is still a
 * move; a partial copy is removed so it cannot shadow the intact original.
 */
async function moveInto(from: string, scratchDir: string, name: string): Promise<string> {
  const extension = extname(name);
  const stem = name.slice(0, name.length - extension.length);
  for (let attempt = 0; ; attempt++) {
    const candidate = join(scratchDir, attempt === 0 ? name : `${stem}-${attempt}${extension}`);
    if (await exists(candidate)) continue;
    try {
      await rename(from, candidate);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      try {
        await copyFile(from, candidate);
        await unlink(from);
        return candidate;
      } catch (copyError) {
        await unlink(candidate).catch(() => {});
        throw copyError;
      }
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
