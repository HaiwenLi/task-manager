import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { artifactDigest, reserveWorkspace as reserveWorkspaceInRegistry } from "../src/workspace.js";

const exec = promisify(execFile);
let root: string;
let cwd: string;
let registryDir: string;
const reserveWorkspace = (path: string, attemptId: string) => reserveWorkspaceInRegistry(path, attemptId, registryDir);
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "taskctl-workspace-"));
  cwd = join(root, "workspace");
  registryDir = join(root, "registry");
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
      exec(process.execPath, ["--import", "tsx", fixture, cwd, `child-${i}`, registryDir])));
    expect(results.map(({ stdout }) => stdout.trim()).sort()).toEqual(["busy", "busy", "busy", "won"]);
    expect(await reserveWorkspace(cwd, "after-exit")).toBeNull();
  }, 30_000);

  it("coordinates overlapping parent/child paths across separate processes", async () => {
    const nested = join(cwd, "nested");
    await mkdir(nested);
    const fixture = fileURLToPath(new URL("./workspace/reserve-child.ts", import.meta.url));
    const results = await Promise.all([cwd, nested].map((path, i) =>
      exec(process.execPath, ["--import", "tsx", fixture, path, `child-${i}`, registryDir])));
    expect(results.map(({ stdout }) => stdout.trim()).sort()).toEqual(["busy", "won"]);
  }, 30_000);

  it("leaves a replaced reservation untouched even with the same attempt ID", async () => {
    const first = await reserveWorkspace(cwd, "same-attempt");
    const lock = join(cwd, ".taskctl-workspace.lock");
    await rename(lock, join(cwd, ".taskctl-old.lock"));
    await mkdir(lock);
    await writeFile(join(lock, "foreign.json"), "foreign reservation");
    const before = await readdir(lock);
    await first!.release();
    expect(await readdir(lock)).toEqual(before);
    expect(await reserveWorkspace(cwd, "third")).toBeNull();
    expect(await reserveWorkspace(cwd, "same-attempt")).toBeNull();
  });

  it("keeps a canonical path reserved when git init changes its repository topology", async () => {
    const first = await reserveWorkspace(cwd, "nongit");
    await git("init");
    expect(await reserveWorkspace(cwd, "git")).toBeNull();
    await first!.release();
    const next = await reserveWorkspace(cwd, "after-release");
    expect(next).not.toBeNull();
    await next!.release();
  }, 20_000);

  it("a pre-init path reservation also excludes a newly linked worktree using its metadata", async () => {
    const first = await reserveWorkspace(cwd, "before-init");
    await git("init");
    await git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "init");
    const linked = join(root, "linked-after-init");
    await git("worktree", "add", "-b", "new-linked", linked);
    const conflicting = await reserveWorkspace(linked, "metadata-conflict");
    // Clean up even on RED: the assertion must not strand a test reservation.
    if (conflicting) await conflicting.release();
    await first!.release();
    expect(conflicting).toBeNull();
  }, 20_000);

  it("serializes overlapping non-Git parent/child paths in both acquisition orders", async () => {
    const nested = join(cwd, "nested");
    await mkdir(nested);
    const parent = await reserveWorkspace(cwd, "parent");
    expect(await reserveWorkspace(nested, "child")).toBeNull();
    await parent!.release();
    const child = await reserveWorkspace(nested, "child");
    expect(child).not.toBeNull();
    expect(await reserveWorkspace(cwd, "parent")).toBeNull();
    await child!.release();
  }, 20_000);

  it("retains the durable registry record if the local marker is deleted", async () => {
    const reservation = await reserveWorkspace(cwd, "owner");
    await rm(join(cwd, ".taskctl-workspace.lock"), { recursive: true });
    expect(await reserveWorkspace(cwd, "other")).toBeNull();
    await reservation!.release();
    expect(await reserveWorkspace(cwd, "after-release")).toBeNull();
  });

  it("fails closed on a corrupted or missing initialized registry", async () => {
    const reservation = await reserveWorkspace(cwd, "owner");
    await reservation!.release();
    const state = join(registryDir, "reservations.json");
    await writeFile(state, "{corrupt");
    await expect(reserveWorkspace(cwd, "corrupt")).rejects.toThrow();
    await rm(state);
    await expect(reserveWorkspace(cwd, "missing")).rejects.toThrow();
  });

  it("rejects malformed registry records instead of silently dropping them", async () => {
    const reservation = await reserveWorkspace(cwd, "owner");
    await reservation!.release();
    await writeFile(join(registryDir, "reservations.json"), JSON.stringify([{ token: "unknown", cwd: "relative" }]));
    await expect(reserveWorkspace(cwd, "invalid")).rejects.toThrow();
  });

  it("does not release a local marker after its registry ownership token is replaced", async () => {
    const reservation = await reserveWorkspace(cwd, "owner");
    const state = join(registryDir, "reservations.json");
    const records = JSON.parse(await readFile(state, "utf8"));
    records[0].token = "foreign-owner";
    await writeFile(state, JSON.stringify(records));
    const before = await readdir(join(cwd, ".taskctl-workspace.lock"));
    await reservation!.release();
    expect(await readdir(join(cwd, ".taskctl-workspace.lock"))).toEqual(before);
    expect(await reserveWorkspace(cwd, "next")).toBeNull();
  });

  it("does not reinitialize a registry directory containing unknown state", async () => {
    await mkdir(registryDir);
    await writeFile(join(registryDir, "unknown-state"), "unknown ownership");
    await expect(reserveWorkspace(cwd, "unknown")).rejects.toThrow(/registry/i);
  });

  it("never steals an old registry mutex", async () => {
    await mkdir(join(registryDir, "mutex"), { recursive: true });
    await utimes(join(registryDir, "mutex"), new Date(0), new Date(0));
    await expect(reserveWorkspace(cwd, "blocked")).rejects.toThrow(/mutex.*busy/i);
    expect(await readdir(join(registryDir, "mutex"))).toEqual([]);
  }, 15_000);

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

  it("rejects outside-root links and fingerprints internal links without traversing cycles", async () => {
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "secret"), "first");
    const link = join(cwd, "link");
    await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
    await symlink(cwd, join(cwd, "cycle"), process.platform === "win32" ? "junction" : "dir");
    await expect(artifactDigest(cwd)).rejects.toThrow(/outside|escaped/i);
    await rm(link);
    const inside = join(cwd, "inside");
    await mkdir(inside);
    await symlink(inside, link, process.platform === "win32" ? "junction" : "dir");
    const before = await artifactDigest(cwd);
    await rm(link);
    await symlink(cwd, link, process.platform === "win32" ? "junction" : "dir");
    expect(await artifactDigest(cwd)).not.toBe(before);
    expect(await readFile(join(outside, "secret"), "utf8")).toBe("first");
  });
});
