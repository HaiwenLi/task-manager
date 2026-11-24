import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter } from "../src/adapters/types.js";
import { dependencySummary, DEPENDENCY_SUMMARY_CHARS } from "../src/dependencies.js";
import { writeNote } from "../src/handoff.js";
import { buildWorkerPrompt } from "../src/protocol.js";
import { buildReviewPrompt, type ReviewEvidence } from "../src/review.js";
import { writeRuntime } from "../src/runtime.js";
import { serializeTaskFile } from "../src/task-file.js";
import { TaskStore } from "../src/task-store.js";
import { runTask, type WorkerConfig } from "../src/worker.js";
import { buildTaskFile } from "./helpers/task-fixture.js";

let root: string;
let tasks: string;
let work: string;
let store: TaskStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "taskctl-deps-"));
  tasks = join(root, "tasks");
  work = join(root, "work");
  await mkdir(tasks);
  await mkdir(work);
  store = new TaskStore(tasks);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("dependencySummary", () => {
  it("tells the integrating task what each dependency concluded and where the evidence is", async () => {
    await writeNote(tasks, {
      task: "001-api", seq: 1,
      status: "接口已实现，契约测试通过",
      done: "实现了 /v1 导出", found: "旧路由需保留", next: "无",
      files: ["src/api.ts", "tests/api.test.ts"],
    });
    await mkdir(join(tasks, "001-api"), { recursive: true });
    await writeFile(join(tasks, "001-api", "acceptance.json"), "{}", "utf8");
    await writeRuntime(tasks, "001-api", "review.json", { verdict: "pass" });
    const board = [
      buildTaskFile({ id: "001-api", title: "导出 API", status: "done" }),
      buildTaskFile({ id: "002-docs", title: "使用文档", status: "done" }),
      buildTaskFile({ id: "003-integrate", title: "整合", status: "open", dependsOn: ["001-api", "002-docs"] }),
    ];

    const summary = (await dependencySummary(tasks, board[2]!, board))!;

    expect(summary).toContain("- 001-api「导出 API」 · done");
    expect(summary).toContain("交接状态：接口已实现，契约测试通过");
    expect(summary).toContain("产物：src/api.ts, tests/api.test.ts");
    expect(summary).toContain(`验收记录 ${join(tasks, "001-api", "acceptance.json")}`);
    expect(summary).toContain("复核 pass");
    // A dependency that left nothing behind is reported as exactly that, not padded.
    expect(summary).toContain("- 002-docs「使用文档」 · done");
    expect(summary).not.toContain("002-docs/acceptance.json");
    expect(summary).not.toContain("旧路由需保留"); // the handoff's findings are not replayed, only its status
  });

  it("is absent for a task that depends on nothing, and skips ids that are not on the board", async () => {
    expect(await dependencySummary(tasks, buildTaskFile({ id: "solo" }), [])).toBeNull();
    const board = [buildTaskFile({ id: "real", status: "done" })];
    const summary = await dependencySummary(tasks, buildTaskFile({ id: "t", dependsOn: ["ghost", "real"] }), board);
    expect(summary).toBe("- real「real」 · done");
  });

  it("reports a dependency that is not done as such, instead of implying it finished", async () => {
    const board = [buildTaskFile({ id: "stuck", title: "卡住的", status: "blocked" })];
    expect(await dependencySummary(tasks, buildTaskFile({ id: "t", dependsOn: ["stuck"] }), board)).toBe("- stuck「卡住的」 · blocked");
  });

  it("survives an unreadable review record", async () => {
    await mkdir(join(tasks, "a"), { recursive: true });
    await writeFile(join(tasks, "a", "review.json"), "{ torn", "utf8");
    const board = [buildTaskFile({ id: "a", status: "done" })];
    expect(await dependencySummary(tasks, buildTaskFile({ id: "t", dependsOn: ["a"] }), board)).toBe("- a「a」 · done");
  });

  it("is bounded however many dependencies there are", async () => {
    const board = [];
    for (let i = 0; i < 12; i++) {
      const id = `dep-${i}`;
      board.push(buildTaskFile({ id, title: `依赖 ${i}`, status: "done" }));
      await writeNote(tasks, { task: id, seq: 1, status: "长".repeat(400), done: "x", found: "y", next: "z", files: [] });
    }
    const summary = (await dependencySummary(tasks, buildTaskFile({ id: "t", dependsOn: board.map((task) => task.id) }), board))!;

    expect(Array.from(summary).length).toBeLessThanOrEqual(DEPENDENCY_SUMMARY_CHARS);
    expect(summary).toContain("截断");
    // The truncation says how much is missing rather than ending mid-thought.
    expect(summary).toMatch(/截断：其余 \d+ 个依赖未列出/);
  });
});

describe("dependency summaries in prompts", () => {
  const task = buildTaskFile({ id: "003-integrate", dependsOn: ["001-api"] });
  const ctx = { workdir: "W", tasksDir: "T", taskDir: "TD", logDir: "L" };

  it("adds a section to the worker prompt only when the task has dependencies", () => {
    const withDeps = buildWorkerPrompt(task, { ...ctx, dependencies: "- 001-api「导出 API」 · done" });
    expect(withDeps).toContain("## 依赖任务的结果");
    expect(withDeps).toContain("- 001-api「导出 API」 · done");
    expect(withDeps).toContain("不要重做这些任务");
    expect(buildWorkerPrompt(task, ctx)).not.toContain("依赖任务的结果");
  });

  it("adds a section to the review prompt only when there is something to show", () => {
    const evidence: ReviewEvidence = {
      task, spec: "", acceptanceMarkdown: "(没有验收记录)", handoff: null, journal: [],
      window: { startedAt: "2026-11-24T00:00:00Z", finishedAt: "2026-11-24T00:01:00Z" },
    };
    const plain = buildReviewPrompt(evidence);
    expect(plain).not.toContain("依赖任务的结果");
    expect(buildReviewPrompt({ ...evidence, dependencies: "- 001-api「导出 API」 · done" })).toContain("本条复核判断的是整合");
  });

  it("reaches the worker of a task whose dependency is done, and not a task with none", async () => {
    // Mechanical with a passing gate: each task finishes on its own evidence,
    // so what is under test is the prompt, not the review.
    const mechanical = { verify: "mechanical" as const, acceptance: "check" };
    await writeFile(join(tasks, "001-api.md"), serializeTaskFile(buildTaskFile({ id: "001-api", title: "导出 API", status: "done", ...mechanical })), "utf8");
    await writeNote(tasks, { task: "001-api", seq: 1, status: "接口已实现", done: "x", found: "y", next: "z", files: ["src/api.ts"] });
    await writeFile(join(tasks, "003-integrate.md"), serializeTaskFile(buildTaskFile({ id: "003-integrate", status: "open", dependsOn: ["001-api"], ...mechanical })), "utf8");
    await writeFile(join(tasks, "004-solo.md"), serializeTaskFile(buildTaskFile({ id: "004-solo", status: "open", ...mechanical })), "utf8");
    const prompts: string[] = [];
    const adapter: AgentAdapter = {
      prompt: async (args) => {
        prompts.push(args.text);
        const id = /^# 任务：(.*)$/m.exec(args.text)![1]!;
        await mkdir(join(tasks, id), { recursive: true });
        await writeFile(join(tasks, id, "done.requested"), "done");
        return { sessionId: `s-${id}`, text: "done", exitCode: 0 };
      },
      contextUsage: async () => 0,
      contextLimit: async () => 100,
    };
    const cfg: WorkerConfig = {
      tasksDir: tasks, workdir: work, agent: "fixture", contextThreshold: 0.8,
      retryLimit: 1, lockTtlMs: 20_000, heartbeatMs: 1_000, maxTurnsPerSession: 2,
    };
    const deps = { store, adapter, acceptance: async () => ({ passed: true, skipped: false as const, exitCode: 0, output: "ok" }) };

    expect(await runTask(cfg, deps, await store.get("003-integrate"), "w1")).toBe("done");
    expect(await runTask(cfg, deps, await store.get("004-solo"), "w2")).toBe("done");

    expect(prompts[0]).toContain("## 依赖任务的结果");
    expect(prompts[0]).toContain("产物：src/api.ts");
    expect(prompts[1]).not.toContain("依赖任务的结果");

    // The reviewer of an integrating task is shown the same facts.
    const seen: ReviewEvidence[] = [];
    await writeFile(join(tasks, "005-reviewed.md"), serializeTaskFile(buildTaskFile({
      id: "005-reviewed", status: "open", dependsOn: ["001-api"], criteria: ["C1 ok"], acceptance: "check",
    })), "utf8");
    const reviewed = await runTask(cfg, {
      store, adapter, acceptance: deps.acceptance,
      review: async (evidence) => {
        seen.push(evidence);
        return { verdict: "pass", criteria: [{ id: "C1", pass: true, evidence: "ok" }], externalChanges: [], defects: [], summary: "ok" };
      },
    }, await store.get("005-reviewed"), "w3");

    expect(reviewed).toBe("done");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.dependencies).toContain("产物：src/api.ts");
    expect(buildReviewPrompt(seen[0]!)).toContain("本条复核判断的是整合");
  });
});
