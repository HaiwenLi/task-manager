import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter } from "../src/adapters/types.js";
import type { AcceptanceResult } from "../src/acceptance.js";
import { appendJournal, type JournalLine, readJournal } from "../src/journal.js";
import { humanTouches, modelFirstPass, summarizeFlow } from "../src/metrics.js";
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
const at = (time: string, stage: string, event: string, detail = ""): JournalLine => ({ at: time, stage, event, detail });

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

/** 捕获 CLI 输出的注入 seam。 */
function capture(): {
  lines: string[];
  errors: string[];
  deps: { log: (line: string) => void; err: (line: string) => void };
} {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    deps: {
      log: (line) => lines.push(line),
      err: (line) => errors.push(line),
    },
  };
}

describe("humanTouches", () => {
  it("counts human touches per task and kind", () => {
    const touches = humanTouches(new Map([["a", [
      at("2026-01-01T00:00:00Z", "clarify", "spec-drafted"),
      at("2026-01-01T01:00:00Z", "human", "approved"),
      at("2026-01-01T02:00:00Z", "review", "verdict", "fail x"),
      at("2026-01-01T03:00:00Z", "human", "rejected", "worker"),
      at("2026-01-01T04:00:00Z", "split", "applied"),
    ]]]));
    expect(touches).toEqual([{ task: "a", byEvent: { approved: 1, rejected: 1, applied: 1 }, total: 3, waitedMs: 3_600_000 }]);
  });

  it("skips tasks nobody touched", () => {
    expect(humanTouches(new Map([["a", [line("worker", "done")]]]))).toEqual([]);
  });

  it("counts a spot check as a touch, and waits only for a push that has a time and a line before it", () => {
    const touches = humanTouches(new Map([["a", [
      at("", "human", "accepted"),                                        // the first line: nothing to wait from
      at("not a time", "human", "audited", "fail worker: 漏了边界条件"),     // counted, like a rejection; never waited for
      at("2026-01-01T00:10:00Z", "worker", "claimed"),
      at("2026-01-01T00:40:00Z", "human", "retry", "archived to x"),      // a retry pushes the task on again: half an hour
      at("2026-01-01T00:40:30Z", "split", "applied"),                     // a touch, never a wait
    ]]]));
    expect(touches).toEqual([{ task: "a", byEvent: { accepted: 1, audited: 1, retry: 1, applied: 1 }, total: 4, waitedMs: 30 * 60_000 }]);
  });
});

describe("modelFirstPass", () => {
  it("counts a first review pass per model", () => {
    const rows = [
      { model: "plan/m", journal: [line("worker", "claimed"), line("review", "verdict", "pass"), line("review", "done")] },
      { model: "plan/m", journal: [line("worker", "claimed"), line("worker", "rework"), line("worker", "claimed"), line("review", "verdict", "pass external=2")] },
      { model: "zen/p", journal: [line("worker", "claimed"), line("review", "verdict", "fail c1")] },
      { model: null, journal: [line("worker", "claimed"), line("review", "done")] },
    ];
    expect(modelFirstPass(rows)).toEqual([
      { model: "plan/m", tasks: 2, firstReviewPassed: 2, noReview: 0 },
      { model: "zen/p", tasks: 1, firstReviewPassed: 0, noReview: 0 },
      { model: "(unknown)", tasks: 1, firstReviewPassed: 0, noReview: 1 },
    ]);
  });

  it("judges the attempt that finished the task: a verdict before its last claim is another attempt's", () => {
    // Each journal holds a failed review, a rework, a new claim and a second review. Only the second attempt's
    // first verdict decides, so the one whose last attempt passed is the one first review passed.
    const rows = [
      { model: "plan/m", journal: [line("worker", "claimed"), line("review", "verdict", "fail c1"), line("worker", "rework"), line("worker", "claimed"), line("review", "verdict", "pass")] },
      { model: "zen/p", journal: [line("worker", "claimed"), line("review", "verdict", "pass"), line("review", "rework"), line("worker", "claimed"), line("review", "verdict", "fail c1")] },
    ];
    expect(modelFirstPass(rows)).toEqual([
      { model: "plan/m", tasks: 1, firstReviewPassed: 1, noReview: 0 },
      { model: "zen/p", tasks: 1, firstReviewPassed: 0, noReview: 0 },
    ]);
  });

  it("counts a finished task whose journal holds no verdict as not reviewed", () => {
    // Before any claim, and after one: neither segment has a review verdict.
    expect(modelFirstPass([{ model: "plan/m", journal: [] }, { model: "plan/m", journal: [line("worker", "claimed")] }]))
      .toEqual([{ model: "plan/m", tasks: 2, firstReviewPassed: 0, noReview: 2 }]);
  });
});

describe("taskctl metrics: human touches and first review pass by model", () => {
  /** `taskctl.json` under the temp root, naming the tasks dir. */
  async function writeConfig(): Promise<string> {
    const path = join(root, "taskctl.json");
    await writeFile(path, JSON.stringify({ tasksDir: tasks }), "utf8");
    return path;
  }

  /** A finished task: its file, and nothing else. */
  async function seedDone(id: string): Promise<void> {
    await writeFile(join(tasks, `${id}.md`), serializeTaskFile(buildTaskFile({ id, status: "done" })), "utf8");
  }

  /**
   * The journal, written by `appendJournal`, which stamps each line with the
   * clock: so the clock is moved to the time of each line before it is
   * appended. Only `Date` is faked; the writes themselves stay real.
   */
  async function journalAt(id: string, ...entries: ReadonlyArray<readonly [time: string, stage: string, event: string, detail?: string]>): Promise<void> {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      for (const [time, stage, event, detail] of entries) {
        vi.setSystemTime(new Date(time));
        await appendJournal(tasks, id, { stage, event, ...(detail === undefined ? {} : { detail }) });
      }
    } finally {
      vi.useRealTimers();
    }
  }

  it("the metrics command shows both views", async () => {
    // a done task "a"; its journal an hour between lines: the spec drafted, a person approving it, the review passing, the person accepting
    await seedDone("a");
    await journalAt("a",
      ["2026-01-01T00:00:00Z", "clarify", "spec-drafted", "criteria=2"],
      ["2026-01-01T01:00:00Z", "human", "approved", "criteria=2"],
      ["2026-01-01T02:00:00Z", "review", "verdict", "pass"],
      ["2026-01-01T03:00:00Z", "human", "accepted"],
    );
    // acceptance.json with model "plan/m"
    await writeRuntime(tasks, "a", "acceptance.json", { command: "check", passed: true, exitCode: 0, output: "ok", model: "plan/m" });
    const config = await writeConfig();
    const cap = capture();   // copied from tests/cli.test.ts:65-80
    expect(await runCli(["metrics", "--config", config], cap.deps)).toBe(0);
    const text = cap.lines.join("\n");
    expect(text).toContain("人工触点");
    expect(text).toMatch(/a\s+共 2 次/);
    expect(text).toContain("等人 2h0m");
    expect(text).toContain("等人时长为墙钟时间，包含夜间和周末，是近似值");
    expect(text).toContain("按模型的首轮复核通过");
    expect(text).toMatch(/plan\/m\s+任务 1\s+首轮通过 1\s+未复核 0\s+首轮通过率 100%/);
    // The whole of both lines: each kind of touch by name, in the order the journal has them, and the two hours
    // a person was waited for, one before the approval and one before the acceptance.
    expect(text).toContain("a  共 2 次（approved×1, accepted×1）  等人 2h0m");
  });

  it("names no model for a task whose acceptance record is torn or says none", async () => {
    await seedDone("a");
    await seedDone("b");
    // a was accepted before the model was recorded; b's record was torn by a write that did not finish.
    for (const id of ["a", "b"]) await mkdir(join(tasks, id), { recursive: true });
    await writeRuntime(tasks, "a", "acceptance.json", { command: "check", passed: true, exitCode: 0 });
    await mkdir(join(tasks, "b"), { recursive: true });
    await writeFile(join(tasks, "b", "acceptance.json"), "{ torn write", "utf8");
    const cap = capture();
    expect(await runCli(["metrics", "--config", await writeConfig()], cap.deps)).toBe(0);
    expect(cap.lines.slice(-2)).toEqual(["按模型的首轮复核通过", "(unknown)  任务 2  首轮通过 0  未复核 2  首轮通过率 -"]);
  });

  it("says none where nobody touched a task, and shows a dash and an unknown model where nothing was reviewed or recorded", async () => {
    // An old run: the journal has a claim and no verdict, and there is no acceptance record to say which model ran.
    await seedDone("a");
    await appendJournal(tasks, "a", { stage: "worker", event: "claimed" });
    const cap = capture();
    expect(await runCli(["metrics", "--config", await writeConfig()], cap.deps)).toBe(0);
    const touches = cap.lines.indexOf("人工触点");
    expect(touches).toBeGreaterThanOrEqual(0);
    expect(cap.lines.slice(touches, touches + 3)).toEqual(["人工触点", "等人时长为墙钟时间，包含夜间和周末，是近似值", "（无）"]);
    expect(cap.lines.slice(-2)).toEqual(["按模型的首轮复核通过", "(unknown)  任务 1  首轮通过 0  未复核 1  首轮通过率 -"]);
  });
});
