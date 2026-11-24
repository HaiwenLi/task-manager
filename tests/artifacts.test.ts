import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  DEFAULT_SCRATCH_PATTERNS,
  logDirOf,
  resolveArtifacts,
  scratchDirOf,
  snapshotRoot,
  sweepRoot,
  taskDirOf,
} from "../src/artifacts.js";

const exec = promisify(execFile);

let root: string;
let workdir: string;
let scratchDir: string;

/** A real Git workspace: tracked deliverable committed, litter created per test. */
async function gitWorkspace(): Promise<void> {
  root = await mkdtemp(join(tmpdir(), "taskctl-sweep-"));
  workdir = join(root, "ws");
  await mkdir(workdir);
  await exec("git", ["init"], { cwd: workdir });
  await exec("git", ["-c", "user.email=t@taskctl", "-c", "user.name=taskctl", "add", "-A"], { cwd: workdir });
  await exec("git", ["-c", "user.email=t@taskctl", "-c", "user.name=taskctl", "commit", "-m", "init", "--allow-empty"], { cwd: workdir });
  await writeFile(join(workdir, "deliverable.dat"), "tracked payload", "utf8");
  await exec("git", ["-c", "user.email=t@taskctl", "-c", "user.name=taskctl", "add", "deliverable.dat"], { cwd: workdir });
  await exec("git", ["-c", "user.email=t@taskctl", "-c", "user.name=taskctl", "commit", "-m", "deliverable"], { cwd: workdir });
  scratchDir = join(root, "tasks", "t1", "scratch");
}

beforeEach(async () => {
  await gitWorkspace();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function write(name: string, content = "litter"): Promise<void> {
  await writeFile(join(workdir, name), content, "utf8");
}

async function exists(name: string): Promise<boolean> {
  try {
    await readFile(join(workdir, name), "utf8");
    return true;
  } catch {
    return false;
  }
}

describe("path helpers", () => {
  it("derives taskDir/logDir/scratchDir under the task's own directory", () => {
    expect(taskDirOf(join("x", "tasks"), "t1")).toBe(join("x", "tasks", "t1"));
    expect(logDirOf(join("x", "tasks"), "t1")).toBe(join("x", "tasks", "t1", "logs"));
    expect(scratchDirOf(join("x", "tasks"), "t1")).toBe(join("x", "tasks", "t1", "scratch"));
  });
});

describe("resolveArtifacts", () => {
  it("absent block means sweep on with the default patterns", () => {
    expect(resolveArtifacts(undefined, "taskctl.json")).toEqual({
      sweep: true,
      scratchPatterns: DEFAULT_SCRATCH_PATTERNS,
    });
    expect(DEFAULT_SCRATCH_PATTERNS).toEqual(["*.log", "*.tmp", "_*", "*.sha", "*.txt"]);
  });

  it("accepts a full block and keeps explicit patterns verbatim", () => {
    expect(resolveArtifacts({ sweep: false, scratchPatterns: ["*.log"] }, "taskctl.json")).toEqual({
      sweep: false,
      scratchPatterns: ["*.log"],
    });
  });

  it("sweep alone flips the switch; patterns fall back to defaults", () => {
    expect(resolveArtifacts({ sweep: false }, "taskctl.json")).toEqual({
      sweep: false,
      scratchPatterns: DEFAULT_SCRATCH_PATTERNS,
    });
  });

  it("rejects malformed blocks loudly", () => {
    expect(() => resolveArtifacts("nope", "taskctl.json")).toThrow(/artifacts.*object/);
    expect(() => resolveArtifacts({ sweep: "false" }, "taskctl.json")).toThrow(/sweep.*boolean/);
    expect(() => resolveArtifacts({ scratchPatterns: "*.log" }, "taskctl.json")).toThrow(/scratchPatterns/);
    expect(() => resolveArtifacts({ scratchPatterns: [""] }, "taskctl.json")).toThrow(/scratchPatterns/);
    expect(() => resolveArtifacts({ unknown: 1 }, "taskctl.json")).toThrow(/unknown artifacts field/);
  });
});

describe("sweepRoot", () => {
  it("moves a newly created untracked pattern match into scratch", async () => {
    const before = await snapshotRoot(workdir);
    await write("_diag_probe.m");

    const outcome = await sweepRoot({ workdir, scratchDir, before, patterns: ["_*"], keepAtRoot: [] });

    expect(outcome.moved).toHaveLength(1);
    expect(outcome.skipped).toBeUndefined();
    await expect(exists("_diag_probe.m")).resolves.toBe(false);
    await expect(readFile(join(scratchDir, "_diag_probe.m"), "utf8")).resolves.toBe("litter");
  });

  it("never touches a tracked file, however tempting its name", async () => {
    const before = await snapshotRoot(workdir);
    // The turn "adds" a file to the index: tracked, brand new at root level.
    await write("new-tracked.log", "staged deliverable");
    await exec("git", ["add", "new-tracked.log"], { cwd: workdir });

    const outcome = await sweepRoot({ workdir, scratchDir, before, patterns: ["*.log"], keepAtRoot: [] });

    expect(outcome.moved).toHaveLength(0);
    await expect(readFile(join(workdir, "new-tracked.log"), "utf8")).resolves.toBe("staged deliverable");
  });

  it("never touches a file that existed before the turn, even untracked and matching", async () => {
    await write("stale.log", "older litter");
    const before = await snapshotRoot(workdir);

    const outcome = await sweepRoot({ workdir, scratchDir, before, patterns: ["*.log"], keepAtRoot: [] });

    expect(outcome.moved).toHaveLength(0);
    await expect(readFile(join(workdir, "stale.log"), "utf8")).resolves.toBe("older litter");
  });

  it("leaves pattern misses alone", async () => {
    const before = await snapshotRoot(workdir);
    await write("result.m");

    const outcome = await sweepRoot({ workdir, scratchDir, before, patterns: ["*.log"], keepAtRoot: [] });

    expect(outcome.moved).toHaveLength(0);
    await expect(exists("result.m")).resolves.toBe(true);
  });

  it("honours the keepAtRoot exemption", async () => {
    const before = await snapshotRoot(workdir);
    await write("run.log");

    const outcome = await sweepRoot({ workdir, scratchDir, before, patterns: ["*.log"], keepAtRoot: ["run.log"] });

    expect(outcome.moved).toHaveLength(0);
    await expect(readFile(join(workdir, "run.log"), "utf8")).resolves.toBe("litter");
  });

  it("also sweeps files git ignores — hygiene does not lean on .gitignore", async () => {
    await writeFile(join(workdir, ".gitignore"), "*.tmp\n", "utf8");
    await exec("git", ["add", ".gitignore"], { cwd: workdir });
    await exec("git", ["-c", "user.email=t@taskctl", "-c", "user.name=taskctl", "commit", "-m", "ignore"], { cwd: workdir });
    const before = await snapshotRoot(workdir);
    await write("cache.tmp");

    const outcome = await sweepRoot({ workdir, scratchDir, before, patterns: ["*.tmp"], keepAtRoot: [] });

    expect(outcome.moved).toHaveLength(1);
    await expect(exists("cache.tmp")).resolves.toBe(false);
  });

  it("moves nothing outside the workspace root (non-recursive)", async () => {
    const before = await snapshotRoot(workdir);
    await mkdir(join(workdir, "nested"), { recursive: true });
    await writeFile(join(workdir, "nested", "deep.log"), "nested litter", "utf8");
    await write("root.log");

    const outcome = await sweepRoot({ workdir, scratchDir, before, patterns: ["*.log"], keepAtRoot: [] });

    expect(outcome.moved.map((move) => move.from)).toEqual([join(workdir, "root.log")]);
    await expect(readFile(join(workdir, "nested", "deep.log"), "utf8")).resolves.toBe("nested litter");
  });

  it("never overwrites: a taken scratch name gets a -N suffix", async () => {
    await mkdir(scratchDir, { recursive: true });
    await writeFile(join(scratchDir, "run.log"), "previous sweep", "utf8");
    const before = await snapshotRoot(workdir);
    await write("run.log", "this turn");

    const outcome = await sweepRoot({ workdir, scratchDir, before, patterns: ["*.log"], keepAtRoot: [] });

    expect(outcome.moved).toHaveLength(1);
    await expect(readFile(join(scratchDir, "run.log"), "utf8")).resolves.toBe("previous sweep");
    await expect(readFile(join(scratchDir, "run-1.log"), "utf8")).resolves.toBe("this turn");
  });

  it("returns before consulting Git when no new root candidate matches", async () => {
    const plain = join(root, "plain-no-candidates");
    await mkdir(plain);
    await writeFile(join(plain, "result.m"), "deliverable", "utf8");
    const before = await snapshotRoot(plain);

    const outcome = await sweepRoot({ workdir: plain, scratchDir, before, patterns: ["*.log"], keepAtRoot: [] });

    expect(outcome).toEqual({ moved: [], failures: [] });
  });

  it("reports a skip instead of guessing when the workdir is not a Git repository", async () => {
    const plain = join(root, "plain");
    await mkdir(plain);
    const before = await snapshotRoot(plain);
    await writeFile(join(plain, "a.log"), "x", "utf8");

    const outcome = await sweepRoot({ workdir: plain, scratchDir, before, patterns: ["*.log"], keepAtRoot: [] });

    expect(outcome.moved).toHaveLength(0);
    expect(outcome.skipped).toContain("git unavailable");
    await expect(readFile(join(plain, "a.log"), "utf8")).resolves.toBe("x");
  });

  it("moves nothing when the before-snapshot already holds every pattern match", async () => {
    await write("a.log");
    const before = await snapshotRoot(workdir);
    await write("b.log");

    const outcome = await sweepRoot({ workdir, scratchDir, before, patterns: ["*.log"], keepAtRoot: [] });

    expect(outcome.moved.map((move) => move.from)).toEqual([join(workdir, "b.log")]);
    await expect(exists("a.log")).resolves.toBe(true);
  });
});
