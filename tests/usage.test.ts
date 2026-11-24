import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReport } from "../src/report.js";
import { readUsage, recordUsage, summarizeUsage } from "../src/usage.js";
import { writeRuntime } from "../src/runtime.js";
import { serializeTaskFile } from "../src/task-file.js";
import { buildTaskFile } from "./helpers/task-fixture.js";

let root: string;
let tasks: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "taskctl-usage-"));
  tasks = join(root, "tasks");
  await mkdir(tasks);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const snapshot = (input: number) => ({ input, output: 10, reasoning: 5, cacheRead: 2, cacheWrite: 1, cost: input / 1000, model: "w/one" });

describe("usage snapshots and deltas", () => {
  it("charges only the new segment when tasks share a session", async () => {
    await recordUsage({ tasksDir: tasks, id: "a", role: "worker", sessionId: "s", durationMs: 10, snapshot: snapshot(100) });
    await recordUsage({ tasksDir: tasks, id: "a", role: "worker", sessionId: "s", durationMs: 10, snapshot: snapshot(150) });
    await recordUsage({ tasksDir: tasks, id: "b", role: "worker", sessionId: "s", durationMs: 10, snapshot: snapshot(175) });

    const a = await readUsage(tasks, "a");
    const b = await readUsage(tasks, "b");
    expect(a.map((record) => record.delta?.input)).toEqual([100, 50]);
    expect(b.map((record) => record.delta?.input)).toEqual([25]);
    expect(summarizeUsage(b)[0]).toMatchObject({ role: "worker", model: "w/one", input: 25, output: 0, reasoning: 0 });
  });

  it("marks counter resets and unavailable snapshots as unknown instead of zero cost", async () => {
    await recordUsage({ tasksDir: tasks, id: "a", role: "worker", sessionId: "s", durationMs: 10, snapshot: snapshot(200) });
    await recordUsage({ tasksDir: tasks, id: "a", role: "worker", sessionId: "s", durationMs: 10, snapshot: snapshot(20) });
    await recordUsage({ tasksDir: tasks, id: "a", role: "worker", sessionId: "s", durationMs: 10, snapshot: undefined });

    const records = await readUsage(tasks, "a");
    expect(records[1]).toMatchObject({ delta: null, reset: true });
    expect(records[2]).toMatchObject({ delta: null, snapshot: null });
    expect(summarizeUsage(records)[0].unknown).toBe(2);
  });

  it("renders usage and reviewer session evidence in the task report", async () => {
    const task = buildTaskFile({ id: "a", title: "Usage task" });
    await writeFile(join(tasks, "a.md"), serializeTaskFile(task), "utf8");
    await recordUsage({ tasksDir: tasks, id: "a", role: "worker", sessionId: "s-worker", durationMs: 12, snapshot: snapshot(100) });
    await writeRuntime(tasks, "a", "review.json", {
      verdict: "pass", summary: "ok", model: "r/one", reviewerSessionId: "s-review", criteria: [], defects: [], externalChanges: [],
    });

    const report = (await buildReport(tasks, "a")).join("\n");
    expect(report).toContain("reviewerSessionId s-review");
    expect(report).toContain("## usage");
    expect(report).toContain("worker/w/one");
    expect(report).toContain("input 100");
  });
});
