import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReport } from "../src/report.js";
import { journalTail } from "../src/journal.js";
import { readRuntime } from "../src/runtime.js";
import { TaskStore } from "../src/task-store.js";
import { parseTaskFile, serializeTaskFile, TaskFileError } from "../src/task-file.js";
import { definitionDigest } from "../src/runtime.js";
import { runTask, type WorkerConfig } from "../src/worker.js";
import type { AgentAdapter } from "../src/adapters/types.js";
import type { ReviewResult } from "../src/review.js";

let root: string;
let tasks: string;
let cwd: string;
let store: TaskStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "taskctl-drift-"));
  tasks = join(root, "tasks");
  cwd = join(root, "work");
  await mkdir(tasks);
  await mkdir(cwd);
  store = new TaskStore(tasks);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function seed(extra: string[] = []): Promise<void> {
  await writeFile(join(tasks, "a.md"), [
    "---",
    "title: 填表",
    "status: open",
    'acceptance: "check"',
    "criteria:",
    "  - C1 32 行全部填好",
    ...extra,
    "review_rounds: 0",
    "sessions: []",
    "retries: 0",
    "---",
    "把 32 行填进共享表",
    "",
  ].join("\n"), "utf8");
}

/** A turn that requests completion; the worker then polls `done.requested`. */
function adapter(): AgentAdapter {
  return {
    prompt: async () => {
      await mkdir(join(tasks, "a"), { recursive: true });
      await writeFile(join(tasks, "a", "done.requested"), "done");
      return { sessionId: "s", text: "done", exitCode: 0 };
    },
    contextUsage: async () => 0,
    contextLimit: async () => 100,
  };
}

/** A turn that also rewrites its own task file, like a worker shelling out would. */
function adapterThatRewrites(edit: (markdown: string) => string): AgentAdapter {
  return {
    prompt: async () => {
      await mkdir(join(tasks, "a"), { recursive: true });
      await writeFile(join(tasks, "a", "done.requested"), "done");
      await writeFile(join(tasks, "a.md"), edit(await readFile(join(tasks, "a.md"), "utf8")), "utf8");
      return { sessionId: "s", text: "done", exitCode: 0 };
    },
    contextUsage: async () => 0,
    contextLimit: async () => 100,
  };
}

/** A task with criteria and no acceptance command: the review-only path. */
async function seedReviewOnly(): Promise<void> {
  await writeFile(join(tasks, "a.md"), [
    "---", "title: 填表", "status: open", "criteria:", "  - C1 32 行全部填好",
    "review_rounds: 0", "sessions: []", "retries: 0", "---", "把 32 行填进共享表", "",
  ].join("\n"), "utf8");
}

function config(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    tasksDir: tasks,
    workdir: cwd,
    agent: "fixture",
    contextThreshold: 0.8,
    retryLimit: 1,
    lockTtlMs: 5_000,
    heartbeatMs: 50,
    ...overrides,
  };
}

const pass = async () => ({ passed: true, skipped: false as const, exitCode: 0, output: "32 行已写入" });
const review = (result: ReviewResult) => async () => result;

const passedWithDrift: ReviewResult = {
  verdict: "pass",
  criteria: [{ id: "C1", pass: true, evidence: "32 行都在" }],
  externalChanges: ["表头多了 1 列（备注），不是本任务加的", "另 4 个单元格被别人改过"],
  defects: [],
  summary: "本任务的行都对；其余差异来自外部",
};

describe("tolerate declaration", () => {
  it("parses known kinds, drops duplicates, and defaults to none", () => {
    const task = parseTaskFile(
      "---\ntitle: t\nstatus: open\ncriteria:\n  - C1 ok\ntolerate:\n  - new_column\n  - external_cell_change\n  - new_column\nsessions: []\nretries: 0\n---\nbody",
      "001-a",
    );
    expect(task.tolerate).toEqual(["new_column", "external_cell_change"]);

    const strict = parseTaskFile("---\ntitle: t\nstatus: open\ncriteria:\n  - C1 ok\nsessions: []\nretries: 0\n---\nbody", "002-b");
    expect(strict.tolerate).toEqual([]);
  });

  it("rejects an unknown kind instead of excusing nothing", () => {
    expect(() => parseTaskFile(
      "---\ntitle: t\nstatus: open\ncriteria:\n  - C1 ok\ntolerate:\n  - new_colunm\nsessions: []\nretries: 0\n---\nbody",
      "003-c",
    )).toThrow(TaskFileError);
    expect(() => parseTaskFile(
      "---\ntitle: t\nstatus: open\ncriteria:\n  - C1 ok\ntolerate: new_column\nsessions: []\nretries: 0\n---\nbody",
      "004-d",
    )).toThrow(/must be a list/);
  });

  it("round-trips through the task file", () => {
    const task = parseTaskFile(
      "---\ntitle: t\nstatus: open\ncriteria:\n  - C1 ok\ntolerate:\n  - deleted_row\nsessions: []\nretries: 0\n---\nbody",
      "005-e",
    );
    const again = parseTaskFile(serializeTaskFile(task), "005-e");
    expect(again.tolerate).toEqual(["deleted_row"]);
  });

  it("is part of the task definition, so widening it mid-run invalidates acceptance", () => {
    const strict = parseTaskFile("---\ntitle: t\nstatus: open\ncriteria:\n  - C1 ok\nsessions: []\nretries: 0\n---\nbody", "006-f");
    const tolerant = parseTaskFile(
      "---\ntitle: t\nstatus: open\ncriteria:\n  - C1 ok\ntolerate:\n  - new_column\nsessions: []\nretries: 0\n---\nbody",
      "006-f",
    );
    expect(definitionDigest(strict)).not.toBe(definitionDigest(tolerant));
  });
});

describe("tolerated drift through the review stage", () => {
  it("passes, but records what was excused, under which declaration", async () => {
    await seed(["tolerate:", "  - new_column", "  - external_cell_change"]);
    await runTask(config(), { store, adapter: adapter(), acceptance: pass, review: review(passedWithDrift) }, await store.get("a"), "w1");

    expect((await store.get("a")).status).toBe("done");
    const recorded = await readRuntime<{
      externalChanges: string[]; model?: string; tolerate?: string[]; definitionDigest?: string;
    }>(tasks, "a", "review.json");
    expect(recorded?.externalChanges).toHaveLength(2);
    // The permission is evidence too: an older verdict must not be re-read
    // against a declaration that has since been narrowed.
    expect(recorded?.tolerate).toEqual(["new_column", "external_cell_change"]);
    expect(recorded?.definitionDigest).toBe(definitionDigest(await store.get("a")));
    expect((await journalTail(tasks, "a", 20)).join("\n")).toContain("external=2");

    // A tolerated change is a fact a human can still read back.
    const report = (await buildReport(tasks, "a")).join("\n");
    expect(report).toContain("tolerate new_column, external_cell_change");
    expect(report).toContain("tolerate(at review) new_column, external_cell_change");
    expect(report).toContain("~ 表头多了 1 列");
  });

  it("marks a declaration that changed after the verdict", async () => {
    await seed(["tolerate:", "  - new_column", "  - external_cell_change"]);
    await runTask(config(), { store, adapter: adapter(), acceptance: pass, review: review(passedWithDrift) }, await store.get("a"), "w1");

    // The operator narrows the field afterwards; the old verdict was reached
    // under the old declaration and the report has to say so.
    const narrowed = (await readFile(join(tasks, "a.md"), "utf8")).replace("  - external_cell_change\n", "");
    await writeFile(join(tasks, "a.md"), narrowed, "utf8");

    const report = (await buildReport(tasks, "a")).join("\n");
    expect(report).toContain("tolerate(at review) new_column, external_cell_change");
    expect(report).toContain("changed since; now new_column");
  });

  it("records the attempt window on the review-only path", async () => {
    await seedReviewOnly();
    await runTask(config(), { store, adapter: adapter(), acceptance: pass, review: review(passedWithDrift) }, await store.get("a"), "w1");

    // No command means no command window; without the attempt window the
    // reviewer has no time evidence at all and every declared tolerance would
    // have to be refused to stay safe.
    const record = await readRuntime<{ startedAt?: string; finishedAt?: string; skipped?: boolean }>(tasks, "a", "acceptance.json");
    expect(record?.skipped).toBe(true);
    expect(record?.startedAt).toBeTruthy();
    expect(record?.finishedAt).toBeTruthy();
    expect((record?.startedAt ?? "") <= (record?.finishedAt ?? "")).toBe(true);
  });

  it("refuses a verdict reached while the definition was being rewritten", async () => {
    await seed(["tolerate:", "  - new_column"]);
    const drifting = async (): Promise<ReviewResult> => {
      const current = await readFile(join(tasks, "a.md"), "utf8");
      await writeFile(join(tasks, "a.md"), current.replace("  - new_column", "  - deleted_row"), "utf8");
      return passedWithDrift;
    };

    const outcome = await runTask(config(), { store, adapter: adapter(), acceptance: pass, review: drifting }, await store.get("a"), "w1");

    // The reviewer said pass, but the task file it was reading no longer exists
    // in that shape: completing it would hand a human a `done` task judged
    // against a definition nobody approved.
    expect(outcome).toBe("blocked");
    expect((await store.get("a")).status).toBe("blocked");
    expect((await journalTail(tasks, "a", 20)).join("\n")).toContain("definition-drift");
  });

  it("does not turn a failing verdict into a pass", async () => {
    await seed(["tolerate:", "  - new_column"]);
    const failed: ReviewResult = {
      verdict: "fail",
      criteria: [{ id: "C1", pass: false, evidence: "只写了 17 行，不是 32 行" }],
      externalChanges: ["多了一列，已按声明容忍"],
      defects: ["少写 15 行"],
      summary: "本任务自己的行没写全",
    };
    await runTask(config(), { store, adapter: adapter(), acceptance: pass, review: review(failed) }, await store.get("a"), "w1");
    const task = await store.get("a");
    expect(task.status).toBe("open");
    expect(task.reviewRounds).toBe(1);
  });

  it("keeps the reviewer's window and the acceptance facts in the prompt", async () => {
    await seed(["tolerate:", "  - new_column"]);
    let seen = "";
    await runTask(config({ model: "w/one" }), {
      store,
      adapter: adapter(),
      acceptance: pass,
      review: async (evidence) => {
        seen = [evidence.window.startedAt, evidence.window.finishedAt, evidence.acceptanceMarkdown].join("\n");
        return passedWithDrift;
      },
    }, await store.get("a"), "w1");
    // The window has two distinct edges, and the acceptance facts carry the model
    // that produced the work.
    expect(seen.split("\n")[0]).not.toBe(seen.split("\n")[1]);
    expect(seen).toContain("windows: startedAt");
    expect(seen).toContain("model: w/one");
  });
});

describe("a worker cannot write its own definition", () => {
  const widenTolerate = (markdown: string) =>
    markdown.replace("criteria:", "tolerate:\n  - external_cell_change\ncriteria:");
  const softenCriteria = (markdown: string) =>
    markdown.replace("C1 32 行全部填好", "C1 大致填一下就行");

  it.each([
    ["widens tolerate", widenTolerate],
    ["softens its own criteria", softenCriteria],
  ])("blocks when the worker %s mid-turn on the review-only path", async (_label, edit) => {
    await seedReviewOnly();
    let reviewed = 0;
    const outcome = await runTask(config(), {
      store,
      adapter: adapterThatRewrites(edit),
      acceptance: pass,
      review: async () => { reviewed += 1; return passedWithDrift; },
    }, await store.get("a"), "w1");

    // The reviewer never sees evidence gathered under a definition the worker
    // wrote for itself; the human has to look at what changed.
    expect(outcome).toBe("blocked");
    expect(reviewed).toBe(0);
    expect((await store.get("a")).status).toBe("blocked");
    expect((await journalTail(tasks, "a", 20)).join("\n")).toContain("definition-drift");
  });

  it("ignores the order of the tolerated kinds", () => {
    const one = parseTaskFile(
      "---\ntitle: t\nstatus: open\ncriteria:\n  - C1 ok\ntolerate:\n  - new_column\n  - deleted_row\nsessions: []\nretries: 0\n---\nbody",
      "007-g",
    );
    const other = parseTaskFile(
      "---\ntitle: t\nstatus: open\ncriteria:\n  - C1 ok\ntolerate:\n  - deleted_row\n  - new_column\nsessions: []\nretries: 0\n---\nbody",
      "007-g",
    );
    expect(definitionDigest(one)).toBe(definitionDigest(other));
  });
});
