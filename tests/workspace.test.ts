import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { artifactDigest, reserveWorkspace } from "../src/workspace.js";

const exec = promisify(execFile);
let root: string;
let cwd: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "taskctl-workspace-"));
  cwd = join(root, "workspace");
  await mkdir(cwd);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function git(...args: string[]): Promise<void> {
  await exec("git", ["-C", cwd, ...args]);
}

describe("reserveWorkspace", () => {
  it("allows exactly one concurrent owner and releases idempotently", async () => {
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => reserveWorkspace(cwd, `attempt-${i}`)));
    const winners = results.filter((item) => item !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.cwd).toBe(await realpath(cwd));
    await winners[0]!.release();
    const next = await reserveWorkspace(cwd, "next");
    expect(next).not.toBeNull();
    await winners[0]!.release();
    expect(await reserveWorkspace(cwd, "blocked")).toBeNull();
    await next!.release();
  });

  it("resolves junction/symlink aliases and Windows case aliases", async () => {
    const alias = join(root, "alias");
    await symlink(cwd, alias, process.platform === "win32" ? "junction" : "dir");
    const owner = await reserveWorkspace(alias, "owner");
    expect(owner!.cwd).toBe(await realpath(cwd));
    expect(await reserveWorkspace(cwd, "other")).toBeNull();
    if (process.platform === "win32") expect(await reserveWorkspace(cwd.toUpperCase(), "case")).toBeNull();
    await owner!.release();
  });

  it("does not steal an old, corrupt, or incompletely initialized reservation", async () => {
    const lock = join(cwd, ".taskctl-workspace.lock");
    await mkdir(lock);
    await writeFile(join(lock, "owner.json"), "corrupt");
    await utimes(lock, new Date(0), new Date(0));
    expect(await reserveWorkspace(cwd, "new")).toBeNull();
    await rm(join(lock, "owner.json"));
    expect(await reserveWorkspace(cwd, "new")).toBeNull();
  });

  it("coordinates separate processes and retains a crashed holder's reservation", async () => {
    const fixture = fileURLToPath(new URL("./workspace/reserve-child.ts", import.meta.url));
    const results = await Promise.all(Array.from({ length: 4 }, (_, i) =>
      exec(process.execPath, ["--import", "tsx", fixture, cwd, `child-${i}`])));
    expect(results.map(({ stdout }) => stdout.trim()).sort()).toEqual(["busy", "busy", "busy", "won"]);
    expect(await reserveWorkspace(cwd, "after-exit")).toBeNull();
  }, 30_000);

  it("leaves a replaced reservation untouched even with the same attempt ID", async () => {
    const first = await reserveWorkspace(cwd, "same-attempt");
    const lock = join(cwd, ".taskctl-workspace.lock");
    await rename(lock, join(cwd, ".taskctl-old.lock"));
    const replacement = await reserveWorkspace(cwd, "same-attempt");
    const before = await readdir(lock);
    await first!.release();
    expect(await readdir(lock)).toEqual(before);
    expect(await reserveWorkspace(cwd, "third")).toBeNull();
    await replacement!.release();
  });

  it("does not delete a foreign file replacing the lock directory", async () => {
    const reservation = await reserveWorkspace(cwd, "owner");
    const lock = join(cwd, ".taskctl-workspace.lock");
    await rename(lock, join(cwd, ".taskctl-old.lock"));
    await writeFile(lock, "foreign reservation");
    await expect(reservation!.release()).resolves.toBeUndefined();
    expect(await readFile(lock, "utf8")).toBe("foreign reservation");
    expect(await reserveWorkspace(cwd, "other")).toBeNull();
  });

  it("does not delete a replaced directory even if it contains copied ownership metadata", async () => {
    const reservation = await reserveWorkspace(cwd, "owner");
    const lock = join(cwd, ".taskctl-workspace.lock");
    const old = join(cwd, ".taskctl-old.lock");
    const names = await readdir(lock);
    await rename(lock, old);
    await mkdir(lock);
    for (const name of names) await writeFile(join(lock, name), await readFile(join(old, name)));
    await reservation!.release();
    expect(await readdir(lock)).toEqual(names);
  });

  it("serializes a repository, nested cwd, and every linked worktree via the common Git dir", async () => {
    await git("init");
    await git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "init");
    const linked = join(root, "linked");
    await git("worktree", "add", "-b", "linked", linked);
    const nested = join(cwd, "nested");
    await mkdir(nested);
    const first = await reserveWorkspace(nested, "first");
    expect(await reserveWorkspace(cwd, "second")).toBeNull();
    expect(await reserveWorkspace(linked, "third")).toBeNull();
    await first!.release();
    const second = await reserveWorkspace(linked, "second");
    expect(second).not.toBeNull();
    await second!.release();
  }, 20_000);

  it("allows independent non-Git workspaces and surfaces an invalid cwd", async () => {
    const other = join(root, "other");
    await mkdir(other);
    const a = await reserveWorkspace(cwd, "a");
    const b = await reserveWorkspace(other, "b");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    await a!.release();
    await b!.release();
    await expect(reserveWorkspace(join(root, "absent"), "bad")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("artifactDigest", () => {
  it("is a stable SHA256, independent of mtimes and directory insertion order", async () => {
    await writeFile(join(cwd, "b"), "two");
    await writeFile(join(cwd, "a"), "one");
    const digest = await artifactDigest(cwd);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    await rm(join(cwd, "b"));
    await writeFile(join(cwd, "b"), "two");
    await utimes(join(cwd, "a"), new Date(0), new Date(0));
    expect(await artifactDigest(cwd)).toBe(digest);
    const alias = join(root, "alias");
    await symlink(cwd, alias, process.platform === "win32" ? "junction" : "dir");
    expect(await artifactDigest(alias)).toBe(digest);
  });

  it("detects tracked, untracked, and ignored bytes plus additions, removals, and renames", async () => {
    await git("init");
    await writeFile(join(cwd, ".gitignore"), "ignored.txt\n");
    await writeFile(join(cwd, "tracked.txt"), "before");
    await git("add", "tracked.txt", ".gitignore");
    let previous: string;
    for (const file of ["tracked.txt", "untracked.txt", "ignored.txt"]) {
      await writeFile(join(cwd, file), "before");
      previous = await artifactDigest(cwd);
      await writeFile(join(cwd, file), "after!");
      const current = await artifactDigest(cwd);
      expect(current).not.toBe(previous);
      previous = current;
    }
    previous = await artifactDigest(cwd);
    await writeFile(join(cwd, "added.txt"), "new file");
    expect(await artifactDigest(cwd)).not.toBe(previous);
    previous = await artifactDigest(cwd);
    await rename(join(cwd, "untracked.txt"), join(cwd, "renamed.txt"));
    expect(await artifactDigest(cwd)).not.toBe(previous);
    previous = await artifactDigest(cwd);
    await rm(join(cwd, "renamed.txt"));
    expect(await artifactDigest(cwd)).not.toBe(previous);
  });

  it("ignores Git internals, dependencies, and taskctl metadata but not ordinary config", async () => {
    const before = await artifactDigest(cwd);
    for (const name of [".git", "node_modules", ".taskctl", ".taskctl-workspace.lock"]) {
      await mkdir(join(cwd, name));
      await writeFile(join(cwd, name, "noise"), "mutable metadata");
    }
    expect(await artifactDigest(cwd)).toBe(before);
    await writeFile(join(cwd, "taskctl.json"), "{}");
    expect(await artifactDigest(cwd)).not.toBe(before);
  });

  it("supports explicit absolute or relative task-directory exclusions without prefix collisions", async () => {
    await mkdir(join(cwd, "tasks"));
    await mkdir(join(cwd, "tasks-source"));
    const before = await artifactDigest(cwd, ["tasks"]);
    await writeFile(join(cwd, "tasks", "attempt.json"), "running");
    expect(await artifactDigest(cwd, [join(cwd, "tasks")])).toBe(before);
    await writeFile(join(cwd, "tasks-source", "code.ts"), "source");
    expect(await artifactDigest(cwd, ["tasks"])).not.toBe(before);
  });

  it("canonicalizes absolute exclusions given through a workspace alias", async () => {
    const alias = join(root, "alias");
    await symlink(cwd, alias, process.platform === "win32" ? "junction" : "dir");
    await mkdir(join(cwd, "tasks"));
    const before = await artifactDigest(alias, [join(alias, "tasks")]);
    await writeFile(join(cwd, "tasks", "task.md"), "metadata");
    expect(await artifactDigest(alias, [join(alias, "tasks")])).toBe(before);
  });

  it("ignores exclusions outside, equal to, or above the workspace root", async () => {
    await writeFile(join(cwd, "source.ts"), "source");
    const before = await artifactDigest(cwd);
    expect(await artifactDigest(cwd, [root, cwd, join(root, "elsewhere")])).toBe(before);
    expect(await artifactDigest(cwd, [".", ".."])).toBe(before);
  });

  it("does not traverse outside-root directory links or cycles, but fingerprints link targets", async () => {
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "secret"), "first");
    const link = join(cwd, "link");
    await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
    await symlink(cwd, join(cwd, "cycle"), process.platform === "win32" ? "junction" : "dir");
    const before = await artifactDigest(cwd);
    await writeFile(join(outside, "secret"), "changed");
    expect(await artifactDigest(cwd)).toBe(before);
    await rm(link);
    await symlink(root, link, process.platform === "win32" ? "junction" : "dir");
    expect(await artifactDigest(cwd)).not.toBe(before);
    expect(await readFile(join(outside, "secret"), "utf8")).toBe("changed");
  });
});
