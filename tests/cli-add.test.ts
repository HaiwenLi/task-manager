import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
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

  it("assigns the next numeric id when none is given", async () => {
    const dir = await mkdtemp(join(tmpdir(), "taskctl-add-"));
    const adapter = fakeAdapter("## 目标\n好\n## 验收标准\n- C1 好\n");
    await runCli(["add", "第一件事", "--tasks-dir", dir], { ...silent, adapter });
    await runCli(["add", "第二件事", "--tasks-dir", dir], { ...silent, adapter });
    const ids = (await new TaskStore(dir).list()).map((task) => task.id).sort();
    expect(ids).toEqual(["001-task", "002-task"]);
  });
});
