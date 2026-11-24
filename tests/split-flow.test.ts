import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter } from "../src/adapters/types.js";
import { runCli } from "../src/cli.js";
import type { ReviewEvidence, ReviewResult } from "../src/review.js";
import { readRuntime } from "../src/runtime.js";
import { runScheduler } from "../src/scheduler.js";
import { TaskStore } from "../src/task-store.js";
import { serializeTaskFile } from "../src/task-file.js";
import type { WorkerConfig } from "../src/worker.js";
import { buildTaskFile } from "./helpers/task-fixture.js";

let root: string;
let tasks: string;
let work: string;
let store: TaskStore;
let configPath: string;

/** Every planner call, and every worker turn with the task it was for. */
let planned: string[];
let turns: Array<{ id: string; text: string }>;
let reviewed: ReviewEvidence[];

const PARENT_CRITERIA = ["C1 导出的表格含表头", "C2 旧路由仍可用"];

/** One adapter for both roles: it answers the planner's brief, and plays a worker that asks to be done. */
function adapter(planner: () => string = plannerOutput): AgentAdapter {
  return {
    prompt: async (args) => {
      if (args.text.startsWith("你是任务拆分规划器")) {
        planned.push(args.text);
        return { sessionId: "plan", exitCode: 0, text: planner() };
      }
      // The header carries the title; the id is in the command the worker is told to run.
      const id = /taskctl done --task (\S+) --tasks-dir/.exec(args.text)![1]!;
      turns.push({ id, text: args.text });
      await mkdir(join(tasks, id), { recursive: true });
      await writeFile(join(tasks, id, "done.requested"), "done");
      return { sessionId: `s-${id}`, text: "done", exitCode: 0 };
    },
    contextUsage: async () => 0,
    contextLimit: async () => 100,
  };
}

function plannerOutput(): string {
  return JSON.stringify({
    children: [
      {
        key: "api", title: "导出 API", body: "实现 /v1/export，复用现有查询层。",
        criteria: ["C1 契约测试通过", "C2 旧路由返回 200"],
        acceptance: "npm test -- api", verify: "mechanical", execution: "iterative", dependsOn: [],
      },
      {
        key: "ui", title: "导出按钮", body: "在工具栏加一个导出按钮，调用 /v1/export。",
        criteria: ["C1 点击后下载到文件"],
        verify: "human", execution: "continuous", dependsOn: ["api"],
      },
    ],
    integration: {
      instructions: "把按钮接到 API 上，端到端跑一遍导出。",
      criteria: [...PARENT_CRITERIA, "C3 端到端导出一次成功"],
    },
  });
}

const passingReview = (evidence: ReviewEvidence): ReviewResult => ({
  verdict: "pass",
  criteria: evidence.task.criteria.map((criterion) => ({ id: criterion.split(/\s+/)[0]!, pass: true, evidence: "ok" })),
  externalChanges: [], defects: [], summary: "ok",
});

function cfg(): WorkerConfig {
  return {
    tasksDir: tasks, workdir: work, agent: "fixture", contextThreshold: 0.8,
    retryLimit: 1, lockTtlMs: 20_000, heartbeatMs: 1_000, maxTurnsPerSession: 2,
  };
}

function workerDeps() {
  return {
    store,
    adapter: adapter(),
    acceptance: async () => ({ passed: true, skipped: false as const, exitCode: 0, output: "ok" }),
    review: async (evidence: ReviewEvidence) => {
      reviewed.push(evidence);
      return passingReview(evidence);
    },
  };
}

async function cli(args: string[], deps: { adapter?: AgentAdapter; log?: (line: string) => void; err?: (line: string) => void } = {}): Promise<{ code: number; out: string[] }> {
  const out: string[] = [];
  const code = await runCli(args, { ...deps, log: (line) => { out.push(line); deps.log?.(line); } });
  return { code, out };
}

async function seedParent(): Promise<void> {
  await writeFile(join(tasks, "003-feature.md"), serializeTaskFile(buildTaskFile({
    id: "003-feature", title: "导出功能", status: "draft", description: "给产品加导出功能", criteria: PARENT_CRITERIA,
  })), "utf8");
  await mkdir(join(tasks, "003-feature"), { recursive: true });
  await writeFile(join(tasks, "003-feature", "spec.md"), "## 目标\n导出\n\n## 验收标准\n- C1 导出的表格含表头\n- C2 旧路由仍可用\n", "utf8");
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "taskctl-splitflow-"));
  tasks = join(root, "tasks");
  work = join(root, "work");
  await mkdir(tasks);
  await mkdir(work);
  store = new TaskStore(tasks);
  configPath = join(root, "taskctl.json");
  await writeFile(configPath, JSON.stringify({ tasksDir: tasks, workdir: work }), "utf8");
  planned = [];
  turns = [];
  reviewed = [];
  await seedParent();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("taskctl split", () => {
  it("plans and publishes in one step, and the planner is shown the parent's intent, spec and final criteria", async () => {
    const { code, out } = await cli(["split", "--task", "003-feature", "--apply", "--config", configPath], { adapter: adapter() });

    expect(code).toBe(0);
    expect(planned).toHaveLength(1);
    expect(planned[0]).toContain("给产品加导出功能");
    expect(planned[0]).toContain("## 目标");
    expect(planned[0]).toContain("- C2 旧路由仍可用");
    expect(out.join("\n")).toContain("004-feature-api  导出 API");
    expect(out.join("\n")).toContain("split applied");
    expect((await store.list()).map((task) => `${task.id}:${task.status}`).sort())
      .toEqual(["003-feature:draft", "004-feature-api:open", "005-feature-ui:open"]);
  });

  it("without --apply writes only the plan, which a later --apply publishes without asking the model again", async () => {
    const plan = await cli(["split", "--task", "003-feature", "--config", configPath], { adapter: adapter() });
    expect(plan.code).toBe(0);
    expect((await store.list()).map((task) => task.id)).toEqual(["003-feature"]);
    expect(plan.out.join("\n")).toContain("split-plan.json");

    const applied = await cli(["split", "--task", "003-feature", "--apply", "--config", configPath], { adapter: adapter() });
    expect(applied.code).toBe(0);
    expect((await store.list()).map((task) => task.id).sort()).toEqual(["003-feature", "004-feature-api", "005-feature-ui"]);
    expect(planned).toHaveLength(1);

    // Running it again shows the plan that exists. It does not buy a new one.
    const again = await cli(["split", "--task", "003-feature", "--config", configPath], { adapter: adapter() });
    expect(again.code).toBe(0);
    expect(again.out.join("\n")).toContain("005-feature-ui  导出按钮");
    expect(planned).toHaveLength(1);
  });

  it("refuses a parent that is not a draft, or one that still has unanswered questions", async () => {
    await store.setStatus("003-feature", "open");
    const notDraft = await cli(["split", "--task", "003-feature", "--config", configPath], { adapter: adapter(), err: () => {} });
    expect(notDraft.code).toBe(1);
    expect(planned).toEqual([]);

    await store.setStatus("003-feature", "draft");
    await writeFile(join(tasks, "003-feature", "questions.md"), "# 待回答的问题\n\n## 待回答\n\n1. 要兼容哪些旧路由？\n", "utf8");
    const unanswered = await cli(["split", "--task", "003-feature", "--apply", "--config", configPath], { adapter: adapter(), err: () => {} });
    expect(unanswered.code).toBe(1);
    expect(planned).toEqual([]);
    expect((await store.list()).map((task) => task.id)).toEqual(["003-feature"]);
  });

  it("rejects an invalid plan with its reason, keeps the planner's words, and publishes nothing", async () => {
    const { code, out } = await cli(["split", "--task", "003-feature", "--apply", "--config", configPath], {
      adapter: adapter(() => "我觉得应该先做按钮。"),
    });

    expect(code).toBe(1);
    expect(out.join("\n")).toMatch(/split-plan-invalid.*JSON/);
    expect((await store.list()).map((task) => task.id)).toEqual(["003-feature"]);
    expect(await readFile(join(tasks, "003-feature", "split-plan.rejected.txt"), "utf8")).toContain("先做按钮");
    expect((await readRuntime(tasks, "003-feature", "split-plan.json"))).toBeNull();
  });
});

describe("a split bundle through the scheduler", () => {
  async function publish(): Promise<void> {
    const { code } = await cli(["split", "--task", "003-feature", "--apply", "--config", configPath], { adapter: adapter() });
    expect(code).toBe(0);
  }

  it("runs nothing before approval, then the children in dependency order, then the parent's integration", async () => {
    await publish();

    // Published, signed by nobody: not one turn is spent.
    expect(await runScheduler(cfg(), workerDeps())).toEqual({ done: [], blocked: [], pending: [] });
    expect(turns).toEqual([]);
    expect(reviewed).toEqual([]);

    const approval = await cli(["approve", "--task", "003-feature", "--tasks-dir", tasks]);
    expect(approval.code).toBe(0);
    expect(approval.out.join("\n")).toContain("bundle: 2 child task(s) released");

    const result = await runScheduler(cfg(), workerDeps());

    expect([...result.done].sort()).toEqual(["003-feature", "004-feature-api", "005-feature-ui"]);
    expect(turns.map((turn) => turn.id)).toEqual(["004-feature-api", "005-feature-ui", "003-feature"]);
    expect((await store.list()).every((task) => task.status === "done")).toBe(true);
  }, 20_000);

  it("briefs the integrating parent on its children, and tells its reviewer to judge the integration", async () => {
    await publish();
    await store.setStatus("003-feature", "open");
    await runScheduler(cfg(), workerDeps());

    const parentTurn = turns.find((turn) => turn.id === "003-feature")!;
    expect(parentTurn.text).toContain("## 依赖任务的结果");
    expect(parentTurn.text).toContain("- 004-feature-api「导出 API」 · done");
    expect(parentTurn.text).toContain("- 005-feature-ui「导出按钮」 · done");
    // A child with nothing behind it is not told about dependencies at all.
    expect(turns.find((turn) => turn.id === "004-feature-api")!.text).not.toContain("依赖任务的结果");

    const parentReview = reviewed.find((evidence) => evidence.task.id === "003-feature")!;
    expect(parentReview.dependencies).toContain("004-feature-api");
    expect(parentReview.dependencies).toContain("005-feature-ui");
    // A child that builds on another child gets the same briefing about it.
    expect(reviewed.find((evidence) => evidence.task.id === "005-feature-ui")!.dependencies).toContain("- 004-feature-api");
  }, 20_000);

  it("starts the parent's own attempt only after every child has settled", async () => {
    await publish();
    await store.setStatus("003-feature", "open");
    await runScheduler(cfg(), workerDeps());

    type Attempt = { startedAt: string; updatedAt: string; phase: string };
    const attemptOf = async (id: string): Promise<Attempt> => readRuntime<Attempt>(tasks, id, "attempt.json") as Promise<Attempt>;
    const parent = await attemptOf("003-feature");
    const children = await Promise.all(["004-feature-api", "005-feature-ui"].map(attemptOf));

    // The attempt is what holds the workspace reservation. Its start is after
    // the children's settles, so no reservation was held while waiting.
    expect(children.every((child) => child.phase === "settled" && child.updatedAt <= parent.startedAt)).toBe(true);
  }, 20_000);

  it("keeps a parent waiting, visibly, when one of its children is stuck", async () => {
    await publish();
    await store.setStatus("003-feature", "open");
    await store.setStatus("004-feature-api", "blocked");

    const result = await runScheduler(cfg(), workerDeps());

    expect(result).toEqual({ done: [], blocked: [], pending: [] });
    expect(turns).toEqual([]);
    const status = await cli(["status", "--tasks-dir", tasks]);
    expect(status.out.join("\n")).toContain("依赖受阻：004-feature-api（已阻塞）");
  });
});

describe("what status, board and report say about a split", () => {
  it("names bundle waiting, dependency waiting and a stuck dependency instead of a bare open", async () => {
    await cli(["split", "--task", "003-feature", "--apply", "--config", configPath], { adapter: adapter() });

    const held = (await cli(["status", "--tasks-dir", tasks])).out.join("\n");
    expect(held).toContain("等父任务批准（003-feature 仍是 draft）");
    expect(held).toContain("等签字（拆分包：2 个子任务随之放行）");
    const board = (await cli(["board", "--tasks-dir", tasks])).out.join("\n");
    expect(board).toContain("等父任务批准（003-feature 仍是 draft）");

    await store.setStatus("003-feature", "open");
    const waiting = (await cli(["status", "--tasks-dir", tasks])).out.join("\n");
    expect(waiting).toContain("等依赖：004-feature-api");
    expect(waiting).toContain("等依赖：004-feature-api, 005-feature-ui");
    expect(waiting).not.toContain("等父任务批准");

    await store.setStatus("004-feature-api", "awaiting-human");
    const stuck = (await cli(["status", "--tasks-dir", tasks])).out.join("\n");
    expect(stuck).toContain("依赖受阻：004-feature-api（等放行）");
    expect(stuck).not.toContain("等依赖：");
  });

  it("report shows which bundle a task belongs to, or which children wait on it", async () => {
    await cli(["split", "--task", "003-feature", "--apply", "--config", configPath], { adapter: adapter() });

    const parent = (await cli(["report", "--task", "003-feature", "--tasks-dir", tasks])).out.join("\n");
    expect(parent).toContain("children 004-feature-api (open), 005-feature-ui (open)");
    const child = (await cli(["report", "--task", "004-feature-api", "--tasks-dir", tasks])).out.join("\n");
    expect(child).toContain("parent 003-feature (draft)");
  });
});
