import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAudit, readAudits, summarizeAudits } from "../src/audit.js";
import { runCli } from "../src/cli.js";
import { TaskStore } from "../src/task-store.js";
import { serializeTaskFile } from "../src/task-file.js";
import { buildTaskFile } from "./helpers/task-fixture.js";

const silent = { log: () => {}, err: () => {} };

/** Audits live next to the tasks dir, so every test needs its own repo-like root. */
async function setup(): Promise<{ root: string; tasksDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "taskctl-human-"));
  const tasksDir = join(root, "tasks");
  await mkdir(tasksDir, { recursive: true });
  return { root, tasksDir };
}

async function seedTask(tasksDir: string, id: string, status: "open" | "done" | "awaiting-human"): Promise<void> {
  await mkdir(join(tasksDir, id), { recursive: true });
  await writeFile(join(tasksDir, `${id}.md`), serializeTaskFile(buildTaskFile({ id, title: id, status })), "utf8");
}

describe("taskctl accept", () => {
  it("moves awaiting-human to done and records a highlighted audit", async () => {
    const { tasksDir } = await setup();
    await seedTask(tasksDir, "001-a", "awaiting-human");
    expect(await runCli(["accept", "--task", "001-a", "--tasks-dir", tasksDir], silent)).toBe(0);
    expect((await new TaskStore(tasksDir).get("001-a")).status).toBe("done");
    const audits = await readAudits(tasksDir);
    expect(audits[0]).toMatchObject({ task: "001-a", verdict: "pass", highlight: true });
  });

  it("refuses a task that is not awaiting a human", async () => {
    const { tasksDir } = await setup();
    await seedTask(tasksDir, "002-b", "open");
    expect(await runCli(["accept", "--task", "002-b", "--tasks-dir", tasksDir], silent)).toBe(1);
    expect((await new TaskStore(tasksDir).get("002-b")).status).toBe("open");
  });
});

describe("taskctl reject", () => {
  it("returns the task to open with the reason and the failing stage", async () => {
    const { tasksDir } = await setup();
    await seedTask(tasksDir, "003-c", "awaiting-human");
    expect(
      await runCli(["reject", "--task", "003-c", "--reason", "导出按钮宽度仍写死", "--stage", "worker", "--tasks-dir", tasksDir], silent),
    ).toBe(0);
    expect((await new TaskStore(tasksDir).get("003-c")).status).toBe("open");
    expect((await readAudits(tasksDir))[0]).toMatchObject({ verdict: "fail", stage: "worker" });
    const note = await readFile(join(tasksDir, "003-c", "sessions", "0001-handoff.md"), "utf8");
    expect(note).toContain("导出按钮宽度仍写死");
  });

  it("rejects an unknown stage", async () => {
    const { tasksDir } = await setup();
    await seedTask(tasksDir, "004-d", "awaiting-human");
    expect(
      await runCli(["reject", "--task", "004-d", "--reason", "x", "--stage", "nope", "--tasks-dir", tasksDir], silent),
    ).toBe(2);
  });
});

describe("taskctl audit", () => {
  it("records a spot check on a done task without changing its status", async () => {
    const { tasksDir } = await setup();
    await seedTask(tasksDir, "005-e", "done");
    expect(
      await runCli(["audit", "--task", "005-e", "--verdict", "fail", "--stage", "reviewer", "--note", "漏了边界条件", "--tasks-dir", tasksDir], silent),
    ).toBe(0);
    expect((await new TaskStore(tasksDir).get("005-e")).status).toBe("done");
    expect((await readAudits(tasksDir))[0]).toMatchObject({ verdict: "fail", stage: "reviewer", note: "漏了边界条件" });
  });

  it("refuses to audit a task that is not done", async () => {
    const { tasksDir } = await setup();
    await seedTask(tasksDir, "006-f", "open");
    expect(await runCli(["audit", "--task", "006-f", "--verdict", "pass", "--tasks-dir", tasksDir], silent)).toBe(1);
  });
});

describe("summarizeAudits", () => {
  it("counts failures per stage and highlights, and reports the rework rate", async () => {
    const { tasksDir } = await setup();
    await appendAudit(tasksDir, { task: "001-a", at: "2026-11-16T00:00:00Z", verdict: "fail", stage: "reviewer" });
    await appendAudit(tasksDir, { task: "001-a", at: "2026-11-16T00:01:00Z", verdict: "pass", stage: "none", highlight: true });
    await appendAudit(tasksDir, { task: "002-b", at: "2026-11-16T00:02:00Z", verdict: "fail", stage: "reviewer" });
    const tasks = [
      buildTaskFile({ id: "001-a", status: "done", reviewRounds: 2 }),
      buildTaskFile({ id: "002-b", status: "open", reviewRounds: 0 }),
    ];
    const text = summarizeAudits(await readAudits(tasksDir), tasks).join("\n");
    expect(text).toMatch(/reviewer\s+2/);
    expect(text).toMatch(/highlight\s+1/);
    expect(text).toMatch(/返工率\s+50%/);
  });
});
