import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter } from "../src/adapters/types.js";
import { resetGuardState } from "../src/budget.js";
import { runCli } from "../src/cli.js";
import { readJournal } from "../src/journal.js";
import { directModel } from "../src/models.js";
import { readRuntime } from "../src/runtime.js";
import { serializeTaskFile } from "../src/task-file.js";
import { TaskStore } from "../src/task-store.js";
import { adapterOf, CATALOGUE } from "./helpers/catalogue-fixture.js";
import { buildTaskFile } from "./helpers/task-fixture.js";

/** A spec with one criterion and a classification, as a clarify session answers. */
const CLARIFIED = "## 目标\n改好\n## 验收标准\n- C1 可验证\n## 管理分类\ncomplex\n## 信息充分性\nclear\n";
/** The guard's line for the shared catalogue's paid model, as `renderVerdicts` writes it. */
const PAID = "- zen/p  provider=zen  enabled=true  variants=-  拒绝：按量计费，约 $15 / 百万 token；未列入 allowedModels";

let root: string;
let tasks: string;
let work: string;
let configPath: string;

/** An adapter that answers every session with `text` and notes the model it was asked for. */
function answering(text: string): { adapter: AgentAdapter; asked: Array<string | undefined> } {
  const asked: Array<string | undefined> = [];
  return {
    asked,
    adapter: {
      prompt: async (args) => { asked.push(args.model); return { sessionId: "s", exitCode: 0, text }; },
      contextUsage: async () => 0, contextLimit: async () => 0,
    },
  };
}

beforeEach(async () => {
  resetGuardState();
  root = await mkdtemp(join(tmpdir(), "taskctl-direct-model-"));
  tasks = join(root, "tasks");
  work = join(root, "work");
  await mkdir(tasks);
  await mkdir(work);
  configPath = join(root, "taskctl.json");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("the model a session that runs on one model uses", () => {
  it("is `model`, else the head of `modelChain`, else the backend's default", () => {
    expect(directModel({ model: "a/one", modelChain: ["c/one"] })).toBe("a/one");
    expect(directModel({ modelChain: ["c/one", "c/two"] })).toBe("c/one");
    expect(directModel({})).toBeUndefined();
  });
});

describe("the clarify session of add and the planner of split", () => {
  it("run on the head of `modelChain` when `model` is unset, and their records say so", async () => {
    await writeFile(configPath, JSON.stringify({ tasksDir: tasks, workdir: work, modelChain: ["plan/a"] }), "utf8");
    const { adapter, asked } = answering(CLARIFIED);

    expect(await runCli(["add", "整理登录模块并补测试", "--config", configPath, "--id", "001-big"], { log: () => {}, adapter })).toBe(0);
    expect(await new TaskStore(tasks).get("001-big")).toMatchObject({ status: "draft" });
    // The answer is not a plan, so `split` rejects it — after asking the planner.
    expect(await runCli(["split", "--task", "001-big", "--config", configPath], { log: () => {}, adapter })).toBe(1);

    expect(asked).toEqual(["plan/a", "plan/a"]);
    expect(await readRuntime<{ model: string }>(tasks, "001-big", "classification.json")).toMatchObject({ model: "plan/a" });
  });

  it("fall back to the backend's default model when neither is set, and the record says so", async () => {
    const { adapter, asked } = answering("## 目标\n改好\n## 验收标准\n- C1 可验证\n");

    expect(await runCli(["add", "一个很小的任务", "--simple", "--tasks-dir", tasks, "--id", "002-tiny"], { log: () => {}, adapter })).toBe(0);

    expect(asked).toEqual([undefined]);
    expect(await readRuntime<{ model: string }>(tasks, "002-tiny", "classification.json")).toMatchObject({ model: "(backend-default)" });
  });

  it("are judged by the budget guard on that model before either starts", async () => {
    // The chain's head is paid and not allowed: no clarify session, no task file.
    await writeFile(configPath, JSON.stringify({ tasksDir: tasks, workdir: work, modelChain: ["zen/p"] }), "utf8");
    const errors: string[] = [];
    const asked: Array<string | undefined> = [];
    const guarded: AgentAdapter = {
      ...adapterOf(CATALOGUE, "plan/m"),
      prompt: async (args) => { asked.push(args.model); return { sessionId: "s", exitCode: 0, text: CLARIFIED }; },
      contextUsage: async () => 0, contextLimit: async () => 0,
    };

    expect(await runCli(["add", "整理表格", "--config", configPath, "--id", "003-paid"], { log: () => {}, err: (line) => { errors.push(line); }, adapter: guarded })).toBe(1);

    expect(errors.join("\n")).toContain(PAID);
    expect(asked).toEqual([]);
    expect(await readdir(tasks)).toEqual([]);
  });

  it("run on the head of `modelChain` when the guard allows it", async () => {
    await writeFile(configPath, JSON.stringify({ tasksDir: tasks, workdir: work, modelChain: ["zen/p"], allowedModels: ["zen/p"] }), "utf8");
    const asked: Array<string | undefined> = [];
    const guarded: AgentAdapter = {
      ...adapterOf(CATALOGUE, "plan/m"),
      prompt: async (args) => { asked.push(args.model); return { sessionId: "s", exitCode: 0, text: CLARIFIED }; },
      contextUsage: async () => 0, contextLimit: async () => 0,
    };

    expect(await runCli(["add", "整理表格", "--config", configPath, "--id", "004-allowed"], { log: () => {}, adapter: guarded })).toBe(0);

    expect(asked).toEqual(["zen/p"]);
    expect(await readRuntime<{ model: string }>(tasks, "004-allowed", "classification.json")).toMatchObject({ model: "zen/p" });
  });

  it("the planner is refused the same way, and that is journaled", async () => {
    await writeFile(join(tasks, "a.md"), serializeTaskFile(buildTaskFile({
      id: "a", title: "导出功能", status: "draft", description: "给产品加导出功能", criteria: ["C1 导出的表格含表头"],
    })), "utf8");
    await mkdir(join(tasks, "a"), { recursive: true });
    await writeFile(join(tasks, "a", "spec.md"), "## 目标\n导出\n\n## 验收标准\n- C1 导出的表格含表头\n", "utf8");
    await writeFile(configPath, JSON.stringify({ tasksDir: tasks, workdir: work, modelChain: ["zen/p"] }), "utf8");
    const errors: string[] = [];
    const asked: Array<string | undefined> = [];
    const guarded: AgentAdapter = {
      ...adapterOf(CATALOGUE, "plan/m"),
      prompt: async (args) => { asked.push(args.model); return { sessionId: "s", exitCode: 0, text: "{}" }; },
      contextUsage: async () => 0, contextLimit: async () => 0,
    };

    expect(await runCli(["split", "--task", "a", "--config", configPath], { log: () => {}, err: (line) => { errors.push(line); }, adapter: guarded })).toBe(1);

    expect(errors).toEqual([PAID]);
    expect(asked).toEqual([]);
    expect((await readJournal(tasks, "a")).find((line) => line.stage === "split" && line.event === "budget-refused")?.detail).toBe("zen/p");
  });
});
