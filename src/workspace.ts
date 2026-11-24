import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, readlink, realpath, rmdir, unlink, writeFile } from "node:fs/promises";
import { renameWithRetry } from "./replace.js";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);
const LOCK_NAME = ".taskctl-workspace.lock";
const DEFAULT_REGISTRY = join(tmpdir(), "opencode", "taskctl-workspaces");
const REGISTRY_VERSION = "taskctl-workspaces-v1";

interface ReservationRecord {
  token: string;
  cwd: string;
  gitCommonDir: string | null;
}

export interface WorkspaceReservation {
  cwd: string;
  release(): Promise<void>;
}

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

// realpath collapses junction/symlink aliases; Windows comparisons additionally
// fold case (without changing the actual path passed to adapters).
function pathKey(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function within(root: string, path: string): boolean {
  const rel = relative(pathKey(root), pathKey(path));
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/** A process-shared mutex. Waiting has a deadline; ownership never has a TTL. */
async function withRegistryMutex<T>(registryDir: string, action: () => Promise<T>): Promise<T> {
  await mkdir(registryDir, { recursive: true });
  const mutex = join(registryDir, "mutex");
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      await mkdir(mutex);
      break;
    } catch (error) {
      const failure = code(error) ?? "";
      // Concurrent creation of the same name reports EEXIST everywhere, but can
      // surface as EPERM/EBUSY on Windows. Retry those only there: on POSIX a
      // real permission error must be reported, not turned into a 5s wait.
      const retryable = failure === "EEXIST" ||
        (process.platform === "win32" && (failure === "EPERM" || failure === "EBUSY"));
      if (!retryable) throw error;
      if (Date.now() >= deadline) {
        throw new Error(`Workspace registry mutex is busy (last error ${failure}); no automatic stale-lock takeover`);
      }
      await delay(10);
    }
  }
  const identity = await lstat(mutex);
  const marker = join(mutex, randomUUID());
  await writeFile(marker, "owner", { flag: "wx" });
  try {
    return await action();
  } finally {
    const current = await lstat(mutex);
    if (!current.isDirectory() || current.dev !== identity.dev || current.ino !== identity.ino) {
      throw new Error("Workspace registry mutex was replaced");
    }
    await unlink(marker);
    await rmdir(mutex);
  }
}

async function writeRegistry(registryDir: string, records: ReservationRecord[]): Promise<void> {
  const temporary = join(registryDir, `reservations-${randomUUID()}.tmp`);
  const file = await open(temporary, "wx");
  try {
    await file.writeFile(JSON.stringify(records));
    await file.sync();
  } finally {
    await file.close();
  }
  await renameWithRetry(temporary, join(registryDir, "reservations.json"));
  // Windows does not expose directory fsync through this API. The registry file
  // itself is flushed before publishing, and always before local acquisition.
  if (process.platform !== "win32") {
    const directory = await open(registryDir, "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }
}

async function readRegistry(registryDir: string): Promise<ReservationRecord[]> {
  const initialized = join(registryDir, "initialized");
  try {
    if (await readFile(initialized, "utf8") !== REGISTRY_VERSION) throw new Error("Unknown workspace registry version");
  } catch (error) {
    if (code(error) !== "ENOENT") throw error;
    // A missing state file is safe only during first initialization. Publish a
    // durable sentinel first, so interruption can never reset existing ownership.
    if ((await readdir(registryDir)).some((name) => name !== "mutex")) {
      throw new Error("Workspace registry has unknown state without an initialization sentinel");
    }
    const sentinel = await open(initialized, "wx");
    try {
      await sentinel.writeFile(REGISTRY_VERSION);
      await sentinel.sync();
    } finally {
      await sentinel.close();
    }
    await writeRegistry(registryDir, []);
  }
  const records: unknown = JSON.parse(await readFile(join(registryDir, "reservations.json"), "utf8"));
  if (!Array.isArray(records)) throw new Error("Invalid workspace registry");
  const tokens = new Set<string>();
  for (const record of records) {
    if (!record || typeof record !== "object" || typeof record.token !== "string" || !record.token ||
        typeof record.cwd !== "string" || !isAbsolute(record.cwd) ||
        !(record.gitCommonDir === null || (typeof record.gitCommonDir === "string" && isAbsolute(record.gitCommonDir))) ||
        tokens.has(record.token)) throw new Error("Invalid workspace registry record");
    tokens.add(record.token);
  }
  return records as ReservationRecord[];
}

async function gitCommonDir(canonical: string): Promise<string | null> {
  try {
    // `--path-format=absolute` needs Git 2.31+; a 2.28 install echoes the
    // unknown flag back as a path (realpath then fails). Ask without it and
    // resolve the possibly-relative answer against the -C directory.
    const { stdout } = await exec("git", ["-C", canonical, "rev-parse", "--git-common-dir"], {
      env: { ...process.env, LC_ALL: "C" },
    });
    const raw = stdout.replace(/\r?\n$/, "");
    if (raw.length === 0) return null;
    return await realpath(isAbsolute(raw) ? raw : resolve(canonical, raw));
  } catch (error) {
    // Other failures (unsafe repository, unreadable Git metadata, missing Git)
    // must fail closed rather than accidentally reserve only one worktree.
    const failure = error as { code?: number; stderr?: string };
    if (failure.code !== 128 || !failure.stderr?.includes("not a git repository")) throw error;
    return null;
  }
}

/**
 * Reserve a canonical path range and its Git common directory across processes.
 * The local marker is always in cwd, so git init/removal cannot change lock identity.
 * Registry records precede local acquisition and never expire. Missing/replaced
 * markers, interrupted operations and corrupt state require operator cleanup.
 * registryDir is an isolation hook for tests; production callers share the default.
 */
export async function reserveWorkspace(
  cwd: string,
  attemptId: string,
  registryDir: string = DEFAULT_REGISTRY,
): Promise<WorkspaceReservation | null> {
  const canonical = await realpath(cwd);
  if (!(await lstat(canonical)).isDirectory()) throw new Error(`Workspace is not a directory: ${canonical}`);
  const common = await gitCommonDir(canonical);
  const record: ReservationRecord = { token: randomUUID(), cwd: canonical, gitCommonDir: common };
  return withRegistryMutex(registryDir, async () => {
    const records = await readRegistry(registryDir);
    // Repository metadata is itself a path range: a reservation acquired before
    // git init must exclude later worktrees sharing metadata under that path.
    const requested = common === null ? [canonical] : [canonical, common];
    if (records.some((other) => {
      const held = other.gitCommonDir === null ? [other.cwd] : [other.cwd, other.gitCommonDir];
      return requested.some(a => held.some(b => within(a, b) || within(b, a)));
    })) return null;
    await writeRegistry(registryDir, [...records, record]);
    const lock = join(canonical, LOCK_NAME);
    const marker = join(lock, `${record.token}.json`);
    const owner = JSON.stringify({ ...record, attemptId });
    // Identity of the lock dir we create here; null while acquisition has not
    // read it yet (it may be what fails), which the catch handles explicitly.
    let dirIdentity: Awaited<ReturnType<typeof lstat>> | null = null;
    let created = false;
    try {
      await mkdir(lock);
      created = true;
      dirIdentity = await lstat(lock);
      await writeFile(marker, owner, { flag: "wx" });
      const markerId = await lstat(marker);
      let released = false;
      return {
        cwd: canonical,
        async release() {
          if (released) return;
          await withRegistryMutex(registryDir, async () => {
            const currentRecords = await readRegistry(registryDir);
            const currentRecord = currentRecords.find((item) => item.token === record.token);
            if (!currentRecord || currentRecord.cwd !== canonical || currentRecord.gitCommonDir !== common) return;
            try {
              const current = await lstat(lock);
              const currentMarker = await lstat(marker);
              if (!current.isDirectory() || current.dev !== dirIdentity!.dev || current.ino !== dirIdentity!.ino ||
                  !currentMarker.isFile() || currentMarker.dev !== markerId.dev || currentMarker.ino !== markerId.ino ||
                  await readFile(marker, "utf8") !== owner) return;
              await unlink(marker);
              await rmdir(lock);
            } catch (error) {
              if (["ENOENT", "ENOTDIR", "ENOTEMPTY", "EEXIST"].includes(code(error) ?? "")) return;
              throw error;
            }
            await writeRegistry(registryDir, currentRecords.filter((item) => item.token !== record.token));
          });
          released = true;
        },
      };
    } catch (error) {
      // Acquisition failed after the record was published. Undo the local
      // artifacts first, then the record: an orphaned record has no owner, so
      // nothing can ever release it and every later attempt for this path range
      // is refused (observed live: three leaked records and a stale lock dir
      // permanently wedged a workspace).
      if (created) {
        // The registry mutex is held, so the directory at this path is the one
        // this call just created unless a foreign actor raced us. Compare
        // identities only when they were actually read: lstat may be what failed.
        const current = dirIdentity === null ? null : await lstat(lock).catch(() => null);
        const ours = dirIdentity === null || (current !== null && current.isDirectory() &&
          current.dev === dirIdentity.dev && current.ino === dirIdentity.ino);
        if (ours) {
          await unlink(marker).catch(() => {});
          await rmdir(lock).catch(() => {});
        }
      }
      await writeRegistry(registryDir, records).catch(() => {});
      if (code(error) === "EEXIST") return null;
      throw error;
    }
  });
}

/**
 * Reservations covering this path (either direction), for operator diagnostics.
 * Read-only: it never mutates the registry.
 */
export async function reservationsFor(
  cwd: string,
  registryDir: string = DEFAULT_REGISTRY,
): Promise<ReservationRecord[]> {
  const canonical = await realpath(cwd).catch(() => cwd);
  // Mirror reserveWorkspace: a repository's common dir is part of the range, so
  // worktrees sharing metadata must count as covered even when their own paths
  // do not nest. A path that no longer exists (deleted workspace, renamed
  // checkout) has no metadata to read: fall back to the plain path comparison
  // instead of failing the diagnosis.
  let common: string | null = null;
  try {
    common = await gitCommonDir(canonical);
  } catch {
    common = null;
  }
  const requested = common === null ? [canonical] : [canonical, common];
  let records: ReservationRecord[] = [];
  try {
    records = await readRegistry(registryDir);
  } catch (error) {
    // No registry means no reservations yet. A corrupt one still throws: the
    // caller must not conclude "free" from unreadable ownership state.
    if (code(error) !== "ENOENT") throw error;
  }
  return records.filter((record) => {
    const held = record.gitCommonDir === null ? [record.cwd] : [record.cwd, record.gitCommonDir];
    return requested.some((a) => held.some((b) => within(a, b) || within(b, a)));
  });
}

/**
 * Translate one ignore pattern into an anchored RegExp over workspace-relative
 * posix paths. A `*` stays inside one segment, `?` matches one non-separator
 * character, and a `**` segment crosses segments (a leading or trailing
 * double-star segment also matches zero segments). Everything else is literal
 * — there are no character classes and no negation, and matching is
 * case-sensitive everywhere. Separators may be spelled with a backslash
 * (they are normalised); patterns are relative to the workspace.
 */
export function ignorePatternRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  let source = "^";
  let i = 0;
  while (i < normalized.length) {
    const char = normalized[i]!;
    if (char === "*") {
      if (normalized[i + 1] === "*") {
        while (normalized[i + 1] === "*") i++;
        if (normalized[i + 1] === "/") { source += "(?:.*/)?"; i += 2; }
        else source += ".*";
        continue;
      }
      source += "[^/]*";
      i++;
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      i++;
      continue;
    }
    source += char.replace(/[\\^$.|+(){}\[\]]/g, "\\$&");
    i++;
  }
  return new RegExp(source + "$");
}

/**
 * Compile `artifactIgnore` patterns into one predicate over relative posix
 * paths. A pattern that can match the empty string covers the workspace root
 * itself: gutting the drift check that way must be a loud error, not a silent
 * pass-everything configuration.
 */
export function compileIgnorePatterns(patterns: string[]): (rel: string) => boolean {
  const regexps = patterns.map((pattern) => {
    const regexp = ignorePatternRegExp(pattern);
    if (regexp.test("")) throw new Error(`artifactIgnore pattern matches the whole workspace: ${pattern}`);
    return regexp;
  });
  return (rel: string) => regexps.some((regexp) => regexp.test(rel));
}

/**
 * SHA256 of a sorted, framed manifest and streamed file contents. Includes all
 * tracked, untracked and ignored files except .git, node_modules, .taskctl and
 * .taskctl-* metadata. Explicit exclusions may be absolute or cwd-relative and
 * exclude entire subtrees strictly inside cwd (e.g. an auxiliary tasksDir).
 * Outside paths, cwd itself, and ancestors of cwd cannot exclude source files.
 * `ignorePatterns` are workspace-relative paths or globs (see
 * {@link ignorePatternRegExp}); a matched file — or a directory whose every
 * descendant is matched — leaves the manifest entirely, so an acceptance
 * command writing only ignored paths is not drift.
 *
 * Links are entries containing their target text, never traversal edges; resolved
 * targets outside the root are rejected, while internal cycles are permitted. This
 * is not an atomic filesystem snapshot: callers must reserve the workspace and
 * compare before/after execution. Unsupported special files fail closed. Build
 * outputs are included; Git ignore rules are deliberately not consulted.
 */
export async function artifactDigest(
  cwd: string,
  excludePaths: string[] = [],
  ignorePatterns: string[] = [],
): Promise<string> {
  const root = await realpath(cwd);
  const logicalRoot = resolve(cwd);
  const ignored = compileIgnorePatterns(ignorePatterns);
  const exclusions = (await Promise.all(excludePaths.map(async (path) => {
    const absolute = resolve(logicalRoot, path);
    // Rebase exclusions spelled through the same alias, including a tasksDir
    // that has not been created yet. Other existing aliases use realpath.
    if (within(logicalRoot, absolute)) return resolve(root, relative(logicalRoot, absolute));
    try {
      return await realpath(absolute);
    } catch (error) {
      if (code(error) !== "ENOENT") throw error;
      return absolute;
    }
  }))).filter((path) => within(root, path) && pathKey(path) !== pathKey(root));
  const manifest = createHash("sha256");
  // v2: directory lines moved after their children and disappear together with
  // every child, so a directory that only holds ignored (or no) entries cannot
  // register as drift just by existing.
  manifest.update("taskctl-artifact-v2\n");

  /** Visit one directory; the count is how many entries it contributed. */
  async function visit(directory: string): Promise<number> {
    if (!within(root, await realpath(directory))) throw new Error(`Workspace directory escaped root: ${directory}`);
    const names = (await readdir(directory)).sort();
    let recorded = 0;
    for (const name of names) {
      if (name === ".git" || name === "node_modules" || name === ".taskctl" || name.startsWith(".taskctl-")) continue;
      const path = join(directory, name);
      if (exclusions.some((excluded) => within(excluded, path))) continue;
      const entry = await lstat(path);
      const rel = relative(root, path).split(sep).join("/");
      if (ignored(rel)) continue;
      if (entry.isSymbolicLink()) {
        if (!within(root, await realpath(path))) throw new Error(`Workspace link escaped root: ${path}`);
        manifest.update(JSON.stringify(["link", rel, await readlink(path)]) + "\n");
        recorded++;
      } else if (entry.isDirectory()) {
        const contributed = await visit(path);
        if (contributed > 0) {
          manifest.update(JSON.stringify(["directory", rel]) + "\n");
          recorded += contributed;
        }
      } else if (entry.isFile()) {
        if (!within(root, await realpath(path))) throw new Error(`Workspace file escaped root: ${path}`);
        const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const opened = await handle.stat();
          if (!opened.isFile() || opened.dev !== entry.dev || opened.ino !== entry.ino) {
            throw new Error(`Workspace file changed during digest: ${path}`);
          }
          const contents = createHash("sha256");
          for await (const chunk of handle.createReadStream({ autoClose: false })) contents.update(chunk);
          manifest.update(JSON.stringify(["file", rel, contents.digest("hex")]) + "\n");
        } finally {
          await handle.close();
        }
        recorded++;
      } else {
        throw new Error(`Unsupported workspace entry: ${path}`);
      }
    }
    return recorded;
  }

  await visit(root);
  return manifest.digest("hex");
}
