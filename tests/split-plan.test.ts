import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  applySplitPlan,
  allocateChildIds,
  parseSplitPlan,
  readSplitPlan,
  renderSplitPlan,
  SPLIT_PLAN_SCHEMA,
  writeSplitPlan,
  type SplitPlan,
} from "../src/split.js";
import { definitionDigest, readRuntime } from "../src/runtime.js";
import { ready } from "../src/scheduler.js";
import { TaskStore } from "../src/task-store.js";
import { serializeTaskFile, type Task } from "../src/task-file.js";
import { buildTaskFile } from "./helpers/task-fixture.js";

let root: string;
let tasks: string;
let store: TaskStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "taskctl-splitplan-"));
  tasks = join(root, "tasks");
  await mkdir(tasks);
  store = new TaskStore(tasks);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function parent(overrides: Partial<Task> = {}): Task {
  return buildTaskFile({
    id: "003-feature",
    title: "导出功能",
    status: "draft",
    description: "给产品加导出功能",
    criteria: ["C1 导出的表格含表头", "C2 旧路由仍可用"],
    ...overrides,
  });
}

/** What a compliant planner answers. `mutate` edits the object before it is serialised. */
function plannerOutput(mutate: (plan: Record<string, any>) => void = () => {}): string {
  const plan = {
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
      criteria: ["C1 导出的表格含表头", "C2 旧路由仍可用", "C3 端到端导出一次成功"],
    },
  };
  mutate(plan);
  return JSON.stringify(plan);
}

async function seed(task: Task): Promise<void> {
  await writeFile(join(tasks, `${task.id}.md`), serializeTaskFile(task), "utf8");
}

async function planned(task: Task = parent(), text: string = plannerOutput()): Promise<SplitPlan> {
  return parseSplitPlan(text, { parent: task, spec: "## 目标\n导出", board: [task], model: "m/x", now: new Date("2026-11-24T00:00:00Z") });
}

/** Every file under the tasks dir, by relative path, for byte-level comparison. */
async function snapshot(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else out.set(relative(tasks, path), await readFile(path, "utf8"));
    }
  }
  await walk(tasks);
  return out;
}

const rejects = (promise: Promise<unknown>, pattern: RegExp) => expect(promise).rejects.toThrow(pattern);

describe("planning", () => {
  it("assigns child ids from the board's sequence and maps key references to them", async () => {
    const plan = await planned();

    expect(plan).toMatchObject({ schema: SPLIT_PLAN_SCHEMA, parentId: "003-feature", parentDigest: definitionDigest(parent()), createdAt: "2026-11-24T00:00:00.000Z", model: "m/x" });
    expect(plan.children.map((child) => child.id)).toEqual(["004-feature-api", "005-feature-ui"]);
    expect(plan.children[1]!.dependsOn).toEqual(["004-feature-api"]);
    expect(plan.children[0]!.dependsOn).toEqual([]);
    expect(plan.integration).toEqual({ instructions: "把按钮接到 API 上，端到端跑一遍导出。", criteria: ["C1 导出的表格含表头", "C2 旧路由仍可用", "C3 端到端导出一次成功"] });
  });

  it("numbers criteria itself, whatever numbering the model used", async () => {
    const plan = await planned(parent(), plannerOutput((plan) => {
      plan.children[0].criteria = ["C3 契约测试通过", "C7 旧路由返回 200"];
    }));
    expect(plan.children[0]!.criteria).toEqual(["C1 契约测试通过", "C2 旧路由返回 200"]);
  });

  it("copies from the parent what the plan may not lower", async () => {
    const plan = await planned(parent({ risk: "high", humanCheck: true, tolerate: ["extra_file"], keepAtRoot: ["report.json"], workdir: "app", model: "p/m", effort: "high" }));
    expect(plan.inherited).toEqual({
      risk: "high", humanCheck: true, tolerate: ["extra_file"], keepAtRoot: ["report.json"], workdir: "app", model: "p/m", effort: "high",
    });
  });

  it("allocates ids past the highest number on the board", () => {
    const board = [buildTaskFile({ id: "009-latest" }), buildTaskFile({ id: "notes" })];
    expect(allocateChildIds("003-feature", ["api", "ui"], board)).toEqual(["010-feature-api", "011-feature-ui"]);
    // Numbered past whatever is there, even a task that already has the very key asked for.
    expect(allocateChildIds("003-feature", ["latest"], [buildTaskFile({ id: "009-latest" })])).toEqual(["010-feature-latest"]);
  });

  it.each([
    ["output that is not JSON", "这是我的拆分建议：先做 API 再做按钮", /JSON/],
    ["a single child", plannerOutput((plan) => { plan.children.pop(); }), /at least two/],
    ["a dependency on a key that is not a child", plannerOutput((plan) => { plan.children[1].dependsOn = ["docs"]; }), /not a child of this plan/],
    ["a child that depends on itself", plannerOutput((plan) => { plan.children[1].dependsOn = ["ui"]; }), /depends on itself/],
    ["a dependency cycle", plannerOutput((plan) => { plan.children[0].dependsOn = ["ui"]; }), /cycle/],
    ["a child without criteria", plannerOutput((plan) => { plan.children[1].criteria = []; }), /criteri/],
    ["mechanical verification without a command", plannerOutput((plan) => { delete plan.children[0].acceptance; }), /mechanical/],
    ["render verification without targets", plannerOutput((plan) => { plan.children[1].verify = "render"; }), /render/],
    ["an unknown verification mode", plannerOutput((plan) => { plan.children[1].verify = "vibes"; }), /verify/],
    ["duplicate keys", plannerOutput((plan) => { plan.children[1].key = "api"; }), /duplicate/],
    ["a key that cannot be an id", plannerOutput((plan) => { plan.children[1].key = "Export Button"; }), /key/],
    ["a key that is empty", plannerOutput((plan) => { plan.children[1].key = "  "; }), /key/],
    ["a child without a body", plannerOutput((plan) => { plan.children[1].body = ""; }), /body/],
    ["a dropped final criterion", plannerOutput((plan) => { plan.integration.criteria = ["C1 导出的表格含表头"]; }), /final criteri/],
    ["an altered final criterion", plannerOutput((plan) => { plan.integration.criteria = ["C1 导出的表格含表头", "C2 旧路由不再需要"]; }), /final criteri/],
    ["no integration step", plannerOutput((plan) => { plan.integration.instructions = ""; }), /integration/],
    ["no integration section at all", plannerOutput((plan) => { delete plan.integration; }), /integration/],
  ])("rejects %s", async (_name, text, pattern) => {
    await rejects(planned(parent(), text), pattern);
  });

  it("refuses to plan a nested split", async () => {
    await rejects(planned(parent({ parentId: "001-root" })), /nested/);
  });

  it("round-trips through its file, and treats an unreadable plan as an error rather than no plan", async () => {
    const plan = await planned();
    await writeSplitPlan(tasks, plan);
    expect(await readSplitPlan(tasks, plan.parentId)).toEqual(plan);

    await writeFile(join(tasks, "003-feature", "split-plan.json"), "{ torn write", "utf8");
    await expect(readSplitPlan(tasks, plan.parentId)).rejects.toThrow(/unreadable/);
    expect(await readSplitPlan(tasks, "missing")).toBeNull();
  });

  it("prints a plan a person can approve or reject", async () => {
    const text = renderSplitPlan(await planned()).join("\n");
    expect(text).toContain("003-feature");
    expect(text).toContain("004-feature-api  导出 API");
    expect(text).toContain("005-feature-ui  导出按钮");
    expect(text).toContain("depends_on 004-feature-api");
    expect(text).toContain("npm test -- api");
    expect(text).toContain("把按钮接到 API 上，端到端跑一遍导出。");
    expect(text).toContain("C3 端到端导出一次成功");
  });
});

describe("publication", () => {
  it("publishes gated children, links the parent last, and leaves the parent a draft", async () => {
    const task = parent({ risk: "high", humanCheck: true });
    await seed(task);
    const plan = await planned(task);
    const result = await applySplitPlan(tasks, plan);

    expect(result).toEqual({ written: ["004-feature-api", "005-feature-ui"], alreadyPresent: [], parentLinked: true });

    const api = await store.get("004-feature-api");
    expect(api).toMatchObject({
      status: "open", parentId: "003-feature", title: "导出 API", criteria: ["C1 契约测试通过", "C2 旧路由返回 200"],
      acceptance: "npm test -- api", verify: "mechanical", execution: "iterative", complexity: "complex",
      dependsOn: [], risk: "high", humanCheck: true, quick: false, sessions: [], retries: 0,
    });
    expect(api.description).toContain("复用现有查询层");
    expect(await store.get("005-feature-ui")).toMatchObject({ status: "open", parentId: "003-feature", execution: "continuous", complexity: "simple", dependsOn: ["004-feature-api"] });

    const linked = await store.get("003-feature");
    expect(linked.status).toBe("draft");
    expect(linked.dependsOn).toEqual(["004-feature-api", "005-feature-ui"]);
    expect(linked.description).toContain("给产品加导出功能");
    expect(linked.description.match(/## 拆分与整合/g)).toHaveLength(1);
    expect(linked.description).toContain("- 004-feature-api「导出 API」");
    expect(linked.description).toContain("把按钮接到 API 上，端到端跑一遍导出。");
    expect(linked.criteria).toEqual(["C1 导出的表格含表头", "C2 旧路由仍可用", "C3 端到端导出一次成功"]);
    expect(await readRuntime(tasks, "003-feature", "split-applied.json")).toMatchObject({ schema: SPLIT_PLAN_SCHEMA });

    // Published, but nothing in the bundle may run until the parent is signed.
    expect(ready(await store.list(), new Set()).map((task) => task.id)).toEqual([]);
  });

  it("appends to dependencies and criteria the parent already had", async () => {
    await seed(parent({ dependsOn: ["002-base"], criteria: ["C1 导出的表格含表头", "C2 旧路由仍可用"] }));
    await seed(buildTaskFile({ id: "002-base", status: "done" }));
    const plan = await planned(await store.get("003-feature"));
    await applySplitPlan(tasks, plan);

    const linked = await store.get("003-feature");
    expect(linked.dependsOn.slice(0, 1)).toEqual(["002-base"]);
    expect(linked.dependsOn).toHaveLength(3);
    expect(linked.criteria).toEqual(["C1 导出的表格含表头", "C2 旧路由仍可用", "C3 端到端导出一次成功"]);
  });

  it("re-applying the same plan changes no bytes", async () => {
    await seed(parent());
    const plan = await planned();
    await applySplitPlan(tasks, plan);
    const before = await snapshot();

    const again = await applySplitPlan(tasks, plan);

    expect(again).toEqual({ written: [], alreadyPresent: ["004-feature-api", "005-feature-ui"], parentLinked: true });
    expect(await snapshot()).toEqual(before);
  });

  it("resumes after a crash before the parent link, on the same ids", async () => {
    await seed(parent());
    const plan = await planned();
    const crash = { beforeParentLink: async () => { throw new Error("simulated crash"); } };

    await expect(applySplitPlan(tasks, plan, crash)).rejects.toThrow("simulated crash");

    // Children exist and are held back by the still-unlinked, still-draft parent.
    expect((await store.get("004-feature-api")).parentId).toBe("003-feature");
    expect((await store.get("003-feature")).dependsOn).toEqual([]);
    expect(ready(await store.list(), new Set())).toEqual([]);

    const resumed = await applySplitPlan(tasks, plan);
    expect(resumed).toEqual({ written: [], alreadyPresent: ["004-feature-api", "005-feature-ui"], parentLinked: true });
    expect((await store.get("003-feature")).dependsOn).toEqual(["004-feature-api", "005-feature-ui"]);
  });

  it("refuses a parent that is not a draft, and writes nothing", async () => {
    await seed(parent({ status: "open" }));
    const before = await snapshot();
    await expect(applySplitPlan(tasks, await planned())).rejects.toThrow(/expected draft/);
    expect(await snapshot()).toEqual(before);
  });

  it("refuses when the parent definition changed after the plan was made", async () => {
    await seed(parent());
    const plan = await planned();
    await store.updateFields("003-feature", { criteria: ["C1 完全不同的标准"] });

    const before = await snapshot();
    await expect(applySplitPlan(tasks, plan)).rejects.toThrow(/changed since the plan was made/);
    expect(await snapshot()).toEqual(before);
  });

  it("is a no-op once linked, even if the parent was then edited by hand", async () => {
    await seed(parent());
    const plan = await planned();
    await applySplitPlan(tasks, plan);
    await store.updateFields("003-feature", { criteria: ["C1 导出的表格含表头", "C2 旧路由仍可用", "C3 端到端导出一次成功", "C4 人工补充"] });
    const before = await snapshot();

    const again = await applySplitPlan(tasks, plan);

    expect(again.parentLinked).toBe(true);
    expect(await snapshot()).toEqual(before);
  });

  it("refuses to publish over a child that differs from the plan, before writing anything else", async () => {
    await seed(parent());
    const plan = await planned();
    await seed(buildTaskFile({ id: "005-feature-ui", status: "open", parentId: "003-feature", title: "被人改过的标题" }));
    const before = await snapshot();

    await expect(applySplitPlan(tasks, plan)).rejects.toThrow(/005-feature-ui.*differs from the plan/s);
    expect(await snapshot()).toEqual(before);
    await expect(readFile(join(tasks, "004-feature-api.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a planned id that belongs to an unrelated task", async () => {
    await seed(parent());
    await seed(buildTaskFile({ id: "009-other", status: "open" }));
    const plan = await planned();
    plan.children[1]!.id = "009-other";
    plan.children[1]!.dependsOn = [];

    await expect(applySplitPlan(tasks, plan)).rejects.toThrow(/009-other.*not a child of 003-feature/);
  });

  it("refuses when the parent already has a child outside the plan", async () => {
    await seed(parent());
    await seed(buildTaskFile({ id: "004-feature-old", status: "open", parentId: "003-feature" }));
    const before = await snapshot();

    // Otherwise the link would name two children and silently orphan the third,
    // which would then wait forever on a parent that never lists it.
    await expect(applySplitPlan(tasks, await planned())).rejects.toThrow(/004-feature-old.*not in this plan/);
    expect(await snapshot()).toEqual(before);
  });

  it("publishes a hand-edited plan as written, without a model", async () => {
    await seed(parent());
    const plan = await planned();
    plan.children[0]!.title = "导出 API（人工改名）";
    plan.children[1]!.dependsOn = [];

    await applySplitPlan(tasks, plan);

    expect((await store.get("004-feature-api")).title).toBe("导出 API（人工改名）");
    expect((await store.get("005-feature-ui")).dependsOn).toEqual([]);
  });

  it("rejects a plan file that no longer passes validation", async () => {
    await seed(parent());
    const plan = await planned();
    plan.children[1]!.dependsOn = ["999-nowhere"];
    await expect(applySplitPlan(tasks, plan)).rejects.toThrow(/not a child of this plan/);
    expect(await store.list()).toHaveLength(1);
  });
});
