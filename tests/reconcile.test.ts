import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cancelTask, reconcileTask, retryTask } from "../src/reconcile.js";
import { writeRuntime } from "../src/runtime.js";
import { serializeTaskFile, type TaskStatus } from "../src/task-file.js";
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

async function writeTask(status: TaskStatus, extra: { retries?: number; reviewRounds?: number } = {}): Promise<void> {
  await writeFile(join(tasksDir, "t1.md"), serializeTaskFile(buildTaskFile({ id: "t1", title: "t1", status, ...extra })), "utf8");
}

async function writeAttempt(phase: "active" | "uncertain" | "settled", pid?: number): Promise<void> {
  await mkdir(join(tasksDir, "t1"), { recursive: true });
  await writeRuntime(tasksDir, "t1", "attempt.json", {
    attemptId: "a1",
    backend: "opencode",
    workspace: join(root, "work"),
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
    const findings = await reconcileTask(tasksDir, "t1", 60_000, registryDir);
    expect(findings.verdict).toBe("retry-allowed");
  });

  it("treats a live pid as something that must be stopped first", async () => {
    await writeTask("blocked");
    await writeAttempt("uncertain", process.pid);
    const findings = await reconcileTask(tasksDir, "t1", 60_000, registryDir);
    expect(findings.pidAlive).toBe(true);
    expect(findings.verdict).toBe("stop-process-first");
  });

  it("does not offer a retry for an active attempt", async () => {
    await writeTask("blocked");
    await writeAttempt("active");
    const findings = await reconcileTask(tasksDir, "t1", 60_000, registryDir);
    expect(findings.verdict).toBe("manual-review");
  });
});

describe("retry", () => {
  it("refuses to replay an unsettled attempt", async () => {
    await writeTask("blocked");
    await writeAttempt("active");
    const outcome = await retryTask(tasksDir, "t1", 60_000, new Date(), registryDir);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain("active");
  });

  it("refuses while a live task lock is held", async () => {
    await writeTask("blocked");
    await mkdir(join(tasksDir, "t1"), { recursive: true });
    await writeFile(join(tasksDir, "t1", "lock.json"), JSON.stringify({ worker: "w", heartbeat: Date.now() }), "utf8");
    const outcome = await retryTask(tasksDir, "t1", 600_000, new Date(), registryDir);
    expect(outcome.ok).toBe(false);
  });

  it("archives a settled attempt and reopens the task", async () => {
    await writeTask("blocked", { retries: 2, reviewRounds: 1 });
    await writeAttempt("settled");
    await writeRuntime(tasksDir, "t1", "acceptance.json", { passed: false });

    const outcome = await retryTask(tasksDir, "t1", 60_000, new Date("2026-11-16T08:00:00.000Z"), registryDir);
    expect(outcome.ok).toBe(true);

    const archiveName = "2026-11-16T08-00-00-000Z";
    const archived = await readdir(join(tasksDir, "t1", "archive", archiveName));
    expect(archived.sort()).toEqual(["acceptance.json", "attempt.json"]);
    expect(await readdir(join(tasksDir, "t1"))).not.toContain("attempt.json");

    const rendered = await readFile(join(tasksDir, "t1.md"), "utf8");
    expect(rendered).toContain("status: open");
    expect(rendered).toContain("retries: 0");
  });

  it("refuses tasks that are not blocked", async () => {
    await writeTask("done");
    const outcome = await retryTask(tasksDir, "t1", 60_000, new Date(), registryDir);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain("done");
  });
});

describe("cancel", () => {
  it("reports nothing to stop when no execution identity is recorded", async () => {
    await writeTask("blocked");
    const outcome = await cancelTask(tasksDir, "t1");
    expect(outcome.stopped).toBe(false);
    expect(outcome.reason).toContain("no pid");
  });

  it("reports an already-gone pid as stopped", async () => {
    await writeTask("blocked");
    await writeAttempt("uncertain", 999_999);
    const outcome = await cancelTask(tasksDir, "t1");
    expect(outcome.stopped).toBe(true);
    expect(outcome.reason).toContain("already gone");
  });
});
