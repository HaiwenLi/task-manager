import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rmdir, unlink, writeFile } from "node:fs/promises";
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
      if (code(error) !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new Error("Workspace registry mutex is busy; no automatic stale-lock takeover");
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
  await rename(temporary, join(registryDir, "reservations.json"));
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
    const { stdout } = await exec("git", ["-C", canonical, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
      env: { ...process.env, LC_ALL: "C" },
    });
    return await realpath(stdout.replace(/\r?\n$/, ""));
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
    try {
      await mkdir(lock);
    } catch (error) {
      if (code(error) === "EEXIST") return null;
      throw error;
    }
    const identity = await lstat(lock);
    const marker = join(lock, `${record.token}.json`);
    const owner = JSON.stringify({ ...record, attemptId });
    await writeFile(marker, owner, { flag: "wx" });
    const markerIdentity = await lstat(marker);
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
            if (!current.isDirectory() || current.dev !== identity.dev || current.ino !== identity.ino ||
                !currentMarker.isFile() || currentMarker.dev !== markerIdentity.dev || currentMarker.ino !== markerIdentity.ino ||
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
  });
}

/**
 * SHA256 of a sorted, framed manifest and streamed file contents. Includes all
 * tracked, untracked and ignored files except .git, node_modules, .taskctl and
 * .taskctl-* metadata. Explicit exclusions may be absolute or cwd-relative and
 * exclude entire subtrees strictly inside cwd (e.g. an auxiliary tasksDir).
 * Outside paths, cwd itself, and ancestors of cwd cannot exclude source files.
 *
 * Links are entries containing their target text, never traversal edges; resolved
 * targets outside the root are rejected, while internal cycles are permitted. This
 * is not an atomic filesystem snapshot: callers must reserve the workspace and
 * compare before/after execution. Unsupported special files fail closed. Build
 * outputs are included; Git ignore rules are deliberately not consulted.
 */
export async function artifactDigest(cwd: string, excludePaths: string[] = []): Promise<string> {
  const root = await realpath(cwd);
  const logicalRoot = resolve(cwd);
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
  manifest.update("taskctl-artifact-v1\n");

  async function visit(directory: string): Promise<void> {
    if (!within(root, await realpath(directory))) throw new Error(`Workspace directory escaped root: ${directory}`);
    const names = (await readdir(directory)).sort();
    for (const name of names) {
      if (name === ".git" || name === "node_modules" || name === ".taskctl" || name.startsWith(".taskctl-")) continue;
      const path = join(directory, name);
      if (exclusions.some((excluded) => within(excluded, path))) continue;
      const entry = await lstat(path);
      const rel = relative(root, path).split(sep).join("/");
      if (entry.isSymbolicLink()) {
        if (!within(root, await realpath(path))) throw new Error(`Workspace link escaped root: ${path}`);
        manifest.update(JSON.stringify(["link", rel, await readlink(path)]) + "\n");
      } else if (entry.isDirectory()) {
        manifest.update(JSON.stringify(["directory", rel]) + "\n");
        await visit(path);
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
      } else {
        throw new Error(`Unsupported workspace entry: ${path}`);
      }
    }
  }

  await visit(root);
  return manifest.digest("hex");
}
