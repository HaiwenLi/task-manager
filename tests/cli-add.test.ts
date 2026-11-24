import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.js";
import { TaskStore } from "../src/task-store.js";
import { readSpec } from "../src/spec.js";
import { journalTail } from "../src/journal.js";
import type { AgentAdapter } from "../src/adapters/types.js";

function fakeAdapter(text: string): AgentAdapter {
  return {
    prompt: async () => ({ sessionId: "s-1", exitCode: 0, text }),
    contextUsage: async () => 0,
    contextLimit: async () => 0,
  };
}

const silent = { log: () => {} };

function assessedSpec(lane: string, sufficiency = "clear", questions = ""): string {
  return [
    "## 目标\n改好", "## 验收标准\n- C1 可验证",
    `## 管理分类\n${lane}`, `## 信息充分性\n${sufficiency}`,
    "## 分类理由\n模型评估", `## 补问\n${questions}`,
  ].join("\n");
}

describe("taskctl add", () => {
  it("puts a complex intent in draft with spec and criteria", async () => {
    const dir = await mkdtemp(join(tmpdir(), "taskctl-add-"));
    const adapter = fakeAdapter("## 目标\n改好\n## 验收标准\n- C1 npm test 全绿\n- C2 文案正确\n");
    const code = await runCli(["add", "重构登录模块", "--tasks-dir", dir, "--id", "001-login"], { ...silent, adapter });

    expect(code).toBe(0);
    const task = await new TaskStore(dir).get("001-login");
    expect(task.status).toBe("draft");
    expect(task.complexity).toBe("complex");
    expect(task.criteria).toEqual(["C1 npm test 全绿", "C2 文案正确"]);
    expect(task.description).toContain("重构登录模块");
    expect(await readSpec(dir, "001-login")).toContain("## 目标");
  });

  it("sends an explicitly simple intent straight to open but still keeps a spec", async () => {
    const dir = await mkdtemp(join(tmpdir(), "taskctl-add-"));
    const adapter = fakeAdapter("## 目标\n修好\n## 验收标准\n- C1 错字为零\n");
    const code = await runCli(["add", "这是个简单任务：修 README 错字", "--tasks-dir", dir, "--id", "002-typo"], { ...silent, adapter });

    expect(code).toBe(0);
    const task = await new TaskStore(dir).get("002-typo");
    expect(task.status).toBe("open");
    expect(task.complexity).toBe("simple");
    expect(await readSpec(dir, "002-typo")).not.toBeNull();
  });

  it("a spec without numbered criteria keeps the task in draft and logs the failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "taskctl-add-"));
    const adapter = fakeAdapter("## 目标\n改好\n## 验收标准\n差不多就行\n");
    const code = await runCli(["add", "重构登录模块", "--tasks-dir", dir, "--id", "003-x"], { ...silent, adapter });

    expect(code).toBe(1);
    expect((await new TaskStore(dir).get("003-x")).status).toBe("draft");
    expect((await journalTail(dir, "003-x", 5)).join("\n")).toMatch(/spec-invalid/);
  });

  it("a failed clarify session leaves the task in draft and returns 1", async () => {
    const dir = await mkdtemp(join(tmpdir(), "taskctl-add-"));
    const adapter: AgentAdapter = {
      prompt: async () => ({ sessionId: "s-1", exitCode: 1, text: "" }),
      contextUsage: async () => 0,
      contextLimit: async () => 0,
    };
    const code = await runCli(["add", "重构登录模块", "--tasks-dir", dir, "--id", "004-y"], { ...silent, adapter });

    expect(code).toBe(1);
    expect((await new TaskStore(dir).get("004-y")).status).toBe("draft");
    expect((await journalTail(dir, "004-y", 5)).join("\n")).toMatch(/clarify-failed/);
  });

  it("accepts --simple written before the intent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "taskctl-add-"));
    const adapter = fakeAdapter("## 目标\n修好\n## 验收标准\n- C1 错字为零\n");
    const code = await runCli(["add", "--simple", "修 README 错字", "--tasks-dir", dir, "--id", "005-typo"], { ...silent, adapter });
    expect(code).toBe(0);
    const task = await new TaskStore(dir).get("005-typo");
    expect(task.complexity).toBe("simple");
    expect(task.status).toBe("open");
    expect(task.description).toBe("修 README 错字");
  });

  it("records an acceptance command given on the command line", async () => {
    const dir = await mkdtemp(join(tmpdir(), "taskctl-add-"));
    const adapter = fakeAdapter("## 目标\n好\n## 验收标准\n- C1 好\n");
    await runCli(["add", "改登录页", "--acceptance", "npm test", "--tasks-dir", dir, "--id", "006-login"], { ...silent, adapter });
    expect((await new TaskStore(dir).get("006-login")).acceptance).toBe("npm test");
  });

  it("uses model classification to select a simple continuous lane", async () => {
    const dir = await mkdtemp(join(tmpdir(), "taskctl-add-"));
    const adapter = fakeAdapter(assessedSpec("simple"));
    const code = await runCli(["add", "重构登录模块", "--tasks-dir", dir, "--id", "classified-simple"], { ...silent, adapter });

    expect(code).toBe(0);
    const task = await new TaskStore(dir).get("classified-simple");
    expect(task).toMatchObject({ status: "open", complexity: "simple", execution: "continuous", verify: "human", quick: false });
    expect(JSON.parse(await readFile(join(dir, "classified-simple", "classification.json"), "utf8"))).toMatchObject({ lane: "simple", proposedLane: "simple", sufficiency: "clear" });
  });

  it("keeps needs-information in draft and writes bounded questions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "taskctl-add-"));
    const adapter = fakeAdapter(assessedSpec("simple", "needs-information", "- Q1\n- Q2\n- Q3\n- Q4"));
    const code = await runCli(["add", "改登录页", "--tasks-dir", dir, "--id", "needs-info"], { ...silent, adapter });

    expect(code).toBe(0);
    const task = await new TaskStore(dir).get("needs-info");
    expect(task.status).toBe("draft");
    const questions = await readFile(join(dir, "needs-info", "questions.md"), "utf8");
    expect(questions).toContain("Q3");
    expect(questions).not.toContain("Q4");
  });

  it("records an unusable model lane as taskctl's own escalation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "taskctl-add-"));
    const adapter = fakeAdapter(assessedSpec("tiny"));
    const code = await runCli(["add", "修 README 错字", "--tasks-dir", dir, "--id", "bad-lane"], { ...silent, adapter });

    expect(code).toBe(0);
    expect(await new TaskStore(dir).get("bad-lane")).toMatchObject({ status: "draft", complexity: "complex", execution: "iterative" });
    expect(JSON.parse(await readFile(join(dir, "bad-lane", "classification.json"), "utf8")))
      .toMatchObject({ lane: "complex", proposedLane: null, laneEscalated: true });
  });

  it("lets an explicit operator lane override model classification", async () => {
    const dir = await mkdtemp(join(tmpdir(), "taskctl-add-"));
    const adapter = fakeAdapter(assessedSpec("complex"));
    const code = await runCli(["add", "--simple", "修 README 错字", "--tasks-dir", dir, "--id", "operator-simple"], { ...silent, adapter });

    expect(code).toBe(0);
    const task = await new TaskStore(dir).get("operator-simple");
    expect(task).toMatchObject({ status: "open", complexity: "simple", execution: "continuous" });
    expect(JSON.parse(await readFile(join(dir, "operator-simple", "classification.json"), "utf8"))).toMatchObject({ lane: "simple", proposedLane: "complex" });
  });

  it("records an explicit execution policy independent of complexity", async () => {
    const dir = await mkdtemp(join(tmpdir(), "taskctl-add-"));
    const adapter = fakeAdapter("## 目标\n好\n## 验收标准\n- C1 好\n");
    const code = await runCli([
      "add", "--simple", "--execution", "iterative", "修 README 错字",
      "--tasks-dir", dir, "--id", "006-policy",
    ], { ...silent, adapter });

    expect(code).toBe(0);
    const task = await new TaskStore(dir).get("006-policy");
    expect(task.complexity).toBe("simple");
    expect(task.execution).toBe("iterative");
  });

  it("assigns the next numeric id when none is given", async () => {
    const dir = await mkdtemp(join(tmpdir(), "taskctl-add-"));
    const adapter = fakeAdapter("## 目标\n好\n## 验收标准\n- C1 好\n");
    await runCli(["add", "第一件事", "--tasks-dir", dir], { ...silent, adapter });
    await runCli(["add", "第二件事", "--tasks-dir", dir], { ...silent, adapter });
    const ids = (await new TaskStore(dir).list()).map((task) => task.id).sort();
    expect(ids).toEqual(["001-task", "002-task"]);
  });
});
