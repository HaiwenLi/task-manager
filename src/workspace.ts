import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readlink, realpath, rmdir, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const LOCK_NAME = ".taskctl-workspace.lock";

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

/**
 * Conservatively reserve an entire Git common directory, including all linked
 * worktrees. Non-Git directories use a lock inside the canonical cwd instead.
 * Reservations never expire: a crashed holder requires explicit operator cleanup.
 */
export async function reserveWorkspace(cwd: string, attemptId: string): Promise<WorkspaceReservation | null> {
  const canonical = await realpath(cwd);
  if (!(await lstat(canonical)).isDirectory()) throw new Error(`Workspace is not a directory: ${canonical}`);
  let lockRoot = canonical;
  try {
    const { stdout } = await exec("git", ["-C", canonical, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
      env: { ...process.env, LC_ALL: "C" },
    });
    lockRoot = await realpath(stdout.trim());
  } catch (error) {
    // Other failures (unsafe repository, unreadable Git metadata, missing Git)
    // must fail closed rather than accidentally reserve only one worktree.
    const failure = error as { code?: number; stderr?: string };
    if (failure.code !== 128 || !failure.stderr?.includes("not a git repository")) throw error;
  }

  const lock = join(lockRoot, LOCK_NAME);
  try {
    await mkdir(lock);
  } catch (error) {
    if (code(error) === "EEXIST") return null;
    throw error;
  }
  // Ownership is unique per acquisition, not merely per attemptId. Deleting only
  // this marker, never recursively deleting the lock, protects a replacement.
  const identity = await lstat(lock);
  const marker = join(lock, `${randomUUID()}.json`);
  await writeFile(marker, JSON.stringify({ attemptId, cwd: canonical }), { flag: "wx" });
  let released = false;
  return {
    cwd: canonical,
    async release() {
      if (released) return;
      try {
        const current = await lstat(lock);
        if (!current.isDirectory() || current.dev !== identity.dev || current.ino !== identity.ino) {
          released = true;
          return;
        }
        await unlink(marker);
      } catch (error) {
        if (code(error) !== "ENOENT" && code(error) !== "ENOTDIR") throw error;
        released = true;
        return;
      }
      released = true;
      try {
        await rmdir(lock);
      } catch (error) {
        if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(code(error) ?? "")) throw error;
      }
    },
  };
}

/**
 * SHA256 of a sorted, framed manifest and streamed file contents. Includes all
 * tracked, untracked and ignored files except .git, node_modules, .taskctl and
 * .taskctl-* metadata. Explicit exclusions may be absolute or cwd-relative and
 * exclude entire subtrees strictly inside cwd (e.g. an auxiliary tasksDir).
 * Outside paths, cwd itself, and ancestors of cwd cannot exclude source files.
 *
 * Links are entries containing their target text, never traversal edges. This
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
