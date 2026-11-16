import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconcileTask, retryTask } from "../src/reconcile.js";
import { writeRuntime } from "../src/runtime.js";
import { serializeTaskFile, type TaskStatus } from "../src/task-file.js";
import { reserveWorkspace } from "../src/workspace.js";
import { buildTaskFile } from "./helpers/task-fixture.js";

let root: string;
let tasksDir: string;
let registryDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "taskctl-reconcile-"));
  tasksDir = join(root, "tasks");
  registryDir = join(root, "registry");
  await mkdir(tasksDir, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeTask(
  status: TaskStatus,
  extra: { retries?: number; reviewRounds?: number; workdir?: string } = {},
): Promise<void> {
  await writeFile(join(tasksDir, "t1.md"), serializeTaskFile(buildTaskFile({ id: "t1", title: "t1", status, ...extra })), "utf8");
}

async function writeAttempt(
  phase: "active" | "uncertain" | "settled",
  pid?: number,
  workspace: string | null = join(root, "work"),
): Promise<void> {
  await mkdir(join(tasksDir, "t1"), { recursive: true });
  await writeRuntime(tasksDir, "t1", "attempt.json", {
    attemptId: "a1",
    backend: "opencode",
    ...(workspace === null ? {} : { workspace }),
    startedAt: "2026-11-16T08:00:00.000Z",
    updatedAt: "2026-11-16T08:00:00.000Z",
    phase,
    operation: "agent turn",
    ...(pid === undefined ? {} : { pid }),
  });
}

describe("reconcile", () => {
  it("offers a retry when nothing is left to run", async () => {
    await writeTask("blocked");
    // Without an attempt, the owned path comes from the configured base workdir.
    const findings = await reconcileTask(tasksDir, "t1", { registryDir, baseWorkdir: root });
    expect(findings.verdict).toBe("retry-allowed");
    expect(findings.workspace).toBe(root);
  });

  it("never points at a kill when a settled attempt's pid happens to be alive", async () => {
    await writeTask("blocked");
    await writeAttempt("settled", process.pid);
    const findings = await reconcileTask(tasksDir, "t1", { registryDir });
    expect(findings.pidAlive).toBe(true);
    // A settled attempt with a live pid is PID reuse, not a running execution.
    expect(findings.verdict).toBe("retry-allowed");
    expect(findings.notes.join(" ")).toContain("PID reuse");
  });

  it("does not offer a retry for an active attempt", async () => {
    await writeTask("blocked");
    await writeAttempt("active");
    const findings = await reconcileTask(tasksDir, "t1", { registryDir });
    expect(findings.verdict).toBe("manual-review");
  });

  it("reports an unknown owned path instead of pretending it checked", async () => {
    await writeTask("blocked");
    await writeAttempt("settled", undefined, null);
    const findings = await reconcileTask(tasksDir, "t1", { registryDir });
    expect(findings.workspace).toBeNull();
    expect(findings.verdict).toBe("manual-review");
  });
});

describe("retry", () => {
  it("refuses to replay an unsettled attempt", async () => {
    await writeTask("blocked");
    await writeAttempt("active");
    const outcome = await retryTask(tasksDir, "t1", { registryDir });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain("active");
  });

  it("refuses while a live task lock is held", async () => {
    await writeTask("blocked");
    await mkdir(join(tasksDir, "t1"), { recursive: true });
    await writeFile(join(tasksDir, "t1", "lock.json"), JSON.stringify({ worker: "w", heartbeat: Date.now() }), "utf8");
    const outcome = await retryTask(tasksDir, "t1", { ttlMs: 600_000, registryDir });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain("lock");
  });

  it("refuses while the owned workspace is still reserved", async () => {
    const workspace = join(root, "work");
    await mkdir(workspace, { recursive: true });
    const holder = await reserveWorkspace(workspace, "holder", registryDir);
    expect(holder).not.toBeNull();
    await writeTask("blocked");
    await writeAttempt("settled", undefined, workspace);

    const outcome = await retryTask(tasksDir, "t1", { registryDir });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain("still reserved");

    await holder!.release();
    const after = await retryTask(tasksDir, "t1", { registryDir });
    expect(after.ok).toBe(true);
  });

  it("refuses when the owned path cannot be determined", async () => {
    await writeTask("blocked");
    await writeAttempt("settled", undefined, null);
    const outcome = await retryTask(tasksDir, "t1", { registryDir });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain("cannot be determined");
  });

  it("archives a settled attempt and reopens the task", async () => {
    await writeTask("blocked", { retries: 2, reviewRounds: 1 });
    await writeAttempt("settled");
    await writeRuntime(tasksDir, "t1", "acceptance.json", { passed: false });
    await writeRuntime(tasksDir, "t1", "review.json", { verdict: "fail" });

    const outcome = await retryTask(tasksDir, "t1", {
      registryDir,
      now: new Date("2026-11-16T08:00:00.000Z"),
    });
    expect(outcome.ok).toBe(true);

    const archived = await readdir(join(tasksDir, "t1", "archive", "2026-11-16T08-00-00-000Z"));
    expect(archived.sort()).toEqual(["acceptance.json", "attempt.json", "review.json"]);
    const remaining = await readdir(join(tasksDir, "t1"));
    expect(remaining).not.toContain("attempt.json");

    const rendered = await readFile(join(tasksDir, "t1.md"), "utf8");
    expect(rendered).toContain("status: open");
    expect(rendered).toContain("retries: 0");
    expect(rendered).toContain("review_rounds: 0");
  });

  it("refuses tasks that are not blocked", async () => {
    await writeTask("done");
    const outcome = await retryTask(tasksDir, "t1", { registryDir });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain("done");
  });
});
