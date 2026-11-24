import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter } from "../src/adapters/types.js";
import type { AcceptanceResult } from "../src/acceptance.js";
import { type JournalLine, readJournal } from "../src/journal.js";
import { summarizeFlow } from "../src/metrics.js";
import type { ReviewResult } from "../src/review.js";
import { writeRuntime } from "../src/runtime.js";
import { runCli } from "../src/cli.js";
import { TaskStore } from "../src/task-store.js";
import { buildTaskFile } from "./helpers/task-fixture.js";
import { runTask, type WorkerConfig } from "../src/worker.js";
import { serializeTaskFile } from "../src/task-file.js";

let root: string;
let tasks: string;
let work: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "taskctl-metrics-"));
  tasks = join(root, "tasks");
  work = join(root, "work");
  await mkdir(tasks);
  await mkdir(work);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const line = (stage: string, event: string, detail = ""): JournalLine => ({ at: "2026-11-24T00:00:00Z", stage, event, detail });

describe("summarizeFlow", () => {
  it("separates first-pass user acceptance from automatic and user-requested rework", () => {
    const text = summarizeFlow({
      tasks: [{ id: "a", status: "done" }, { id: "b", status: "done" }, { id: "c", status: "open" }],
      journals: new Map([
        // Sent back by the controller, then finished: nobody was asked.
        ["a", [line("worker", "claimed"), line("worker", "acceptance", "failed exit=1"), line("worker", "rework"), line("worker", "acceptance", "passed exit=0"), line("worker", "done")]],
        // One automatic review round, then a human sent it back before accepting.
        ["b", [line("review", "started"), line("review", "rework", "round 1"), line("human", "rejected", "stage=clarify x"), line("human", "accepted")]],
        // Rejected by a human and not finished: reworked by the user, never completed.
        ["c", [line("human", "rejected", "stage=worker y")]],
      ]),
      classifications: new Map(),
    }).join("\n");

    expect(text).toMatch(/首轮通过率\s+50%\s+\(1\/2\)/);
    expect(text).toMatch(/自动返工\s+2 个任务\s+2 轮（验收 1，复核 1）/);
    expect(text).toMatch(/人工打回\s+2 个任务/);
  });

  it("counts intake outcomes only among tasks that were classified", () => {
    const text = summarizeFlow({
      tasks: [{ id: "a", status: "done" }, { id: "b", status: "draft" }, { id: "c", status: "open" }, { id: "d", status: "draft" }],
      journals: new Map(),
      classifications: new Map([
        ["a", { lane: "simple", proposedLane: "simple", sufficiency: "clear", laneEscalated: false }],
        // The model gave no usable lane, so taskctl chose the conservative one.
        ["b", { lane: "complex", proposedLane: null, sufficiency: "needs-information", laneEscalated: true }],
        // Applied lane more conservative than the proposed one.
        ["c", { lane: "complex", proposedLane: "simple", sufficiency: "assumptions", laneEscalated: false }],
        // d was never classified: not in any intake denominator.
      ]),
    }).join("\n");

    expect(text).toMatch(/接入信息\s+needs-information 1 \/ 3（33%）\s+assumptions 1/);
    expect(text).toMatch(/分类升级\s+2 \/ 3/);
  });

  it("prints a dash, not 0%, when there is nothing to measure", () => {
    const text = summarizeFlow({ tasks: [], journals: new Map(), classifications: new Map() }).join("\n");
    expect(text).toMatch(/首轮通过率\s+-\s+\(0\/0\)/);
    expect(text).toMatch(/接入信息\s+needs-information 0 \/ 0（-）/);
    expect(text).not.toMatch(/0%/);
  });

  it("counts parks and review-only recoveries from their own journal events", () => {
    const text = summarizeFlow({
      tasks: [{ id: "a", status: "done" }],
      journals: new Map([["a", [line("review", "started"), line("review", "review-pending"), line("review", "review-only"), line("review", "started"), line("worker", "done")]]]),
      classifications: new Map(),
    }).join("\n");
    expect(text).toMatch(/复核保留\s+1/);
    expect(text).toMatch(/只复核恢复\s+1/);
    // A park is not a rework round: the worker and its acceptance never ran again.
    expect(text).toMatch(/自动返工\s+0 个任务/);
  });
});

describe("readJournal", () => {
  it("splits each line into time, stage, event and detail, and reads a missing journal as empty", async () => {
    const { appendJournal } = await import("../src/journal.js");
    await appendJournal(tasks, "a", { stage: "review", event: "rework", detail: "round 1: C1  width  still  wrong" });
    await appendJournal(tasks, "a", { stage: "human", event: "accepted" });
    expect(await readJournal(tasks, "missing")).toEqual([]);

    const [first, second] = await readJournal(tasks, "a");
    expect(first).toMatchObject({ stage: "review", event: "rework", detail: "round 1: C1  width  still  wrong" });
    expect(first!.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(second).toMatchObject({ stage: "human", event: "accepted", detail: "" });
  });
});

describe("taskctl metrics", () => {
  const passingReview = async (): Promise<ReviewResult> => ({
    verdict: "pass", criteria: [{ id: "C1", pass: true, evidence: "ok" }], externalChanges: [], defects: [], summary: "ok",
  });

  /** A worker turn that claims completion; the acceptance gate then decides. */
  function workerAdapter(): AgentAdapter {
    return {
      prompt: async () => {
        await mkdir(join(tasks, "a"), { recursive: true });
        await writeFile(join(tasks, "a", "done.requested"), "done");
        return { sessionId: `ses-${Math.random()}`, text: "done", exitCode: 0 };
      },
      contextUsage: async () => 0,
      contextLimit: async () => 100,
    };
  }

  async function metrics(): Promise<string> {
    const lines: string[] = [];
    expect(await runCli(["metrics", "--tasks-dir", tasks], { log: (text) => lines.push(text) })).toBe(0);
    return lines.join("\n");
  }

  it("counts a controller-handled acceptance retry as automatic rework, not as a failed first pass", async () => {
    const store = new TaskStore(tasks);
    await writeFile(join(tasks, "a.md"), [
      "---", "schema: taskctl/v1", "title: bio gate", "status: open",
      'acceptance: "check"', "criteria:", "  - C1 bio 相似度 >= 0.90",
      "sessions: []", "retries: 0", "review_rounds: 0", "---", "重建 bio 图并与基线比相似度", "",
    ].join("\n"), "utf8");
    let gates = 0;
    const acceptance = async (): Promise<AcceptanceResult> => {
      gates += 1;
      return gates === 1 ? { passed: false, exitCode: 1, output: "similarity 0.80", skipped: false } : { passed: true, exitCode: 0, output: "similarity 0.93", skipped: false };
    };
    const cfg: WorkerConfig = { tasksDir: tasks, workdir: work, agent: "fixture", contextThreshold: 0.8, retryLimit: 5, lockTtlMs: 5_000, heartbeatMs: 50 };
    expect(await runTask(cfg, { store, adapter: workerAdapter(), acceptance, review: passingReview }, await store.get("a"), "w1")).toBe("done");

    const text = await metrics();
    expect(text).toMatch(/首轮通过率\s+100%\s+\(1\/1\)/);
    expect(text).toMatch(/自动返工\s+1 个任务\s+1 轮（验收 1，复核 0）/);
    expect(text).toMatch(/人工打回\s+0 个任务/);
    expect((await readJournal(tasks, "a")).filter((entry) => entry.event === "rework")).toHaveLength(1);
  });

  it("drops a task from first-pass acceptance once a human sends it back", async () => {
    const store = new TaskStore(tasks);
    await writeFile(join(tasks, "b.md"), serializeTaskFile(buildTaskFile({ id: "b", status: "awaiting-human" })), "utf8");
    const silent = { log: () => {} };

    await store.setStatus("b", "done");
    expect(await metrics()).toMatch(/首轮通过率\s+100%\s+\(1\/1\)/);

    // A spot check that fails does not ask for rework; the task stays done and first-pass.
    await store.setStatus("b", "done");
    expect(await runCli(["audit", "--task", "b", "--verdict", "fail", "--stage", "reviewer", "--tasks-dir", tasks], silent)).toBe(0);
    expect(await metrics()).toMatch(/首轮通过率\s+100%\s+\(1\/1\)/);

    await store.setStatus("b", "awaiting-human");
    expect(await runCli(["reject", "--task", "b", "--stage", "worker", "--reason", "按钮没对齐", "--tasks-dir", tasks], silent)).toBe(0);
    await store.setStatus("b", "awaiting-human");
    expect(await runCli(["accept", "--task", "b", "--tasks-dir", tasks], silent)).toBe(0);

    const text = await metrics();
    expect(text).toMatch(/首轮通过率\s+0%\s+\(0\/1\)/);
    expect(text).toMatch(/人工打回\s+1 个任务/);
    expect(text).toMatch(/自动返工\s+0 个任务/);
  });

  it("reads intake outcomes from classification records and ignores unreadable ones", async () => {
    await writeFile(join(tasks, "a.md"), serializeTaskFile(buildTaskFile({ id: "a", status: "open" })), "utf8");
    await writeFile(join(tasks, "b.md"), serializeTaskFile(buildTaskFile({ id: "b", status: "draft" })), "utf8");
    await writeFile(join(tasks, "c.md"), serializeTaskFile(buildTaskFile({ id: "c", status: "open" })), "utf8");
    for (const id of ["a", "b", "c"]) await mkdir(join(tasks, id), { recursive: true });
    await writeRuntime(tasks, "a", "classification.json", { lane: "simple", proposedLane: "simple", sufficiency: "clear", laneEscalated: false });
    await writeRuntime(tasks, "b", "classification.json", { lane: "complex", proposedLane: "quick", sufficiency: "needs-information", laneEscalated: false });
    await writeFile(join(tasks, "c", "classification.json"), "{ torn write", "utf8");

    const text = await metrics();
    expect(text).toMatch(/接入信息\s+needs-information 1 \/ 2（50%）/);
    expect(text).toMatch(/分类升级\s+1 \/ 2/);
  });
});
