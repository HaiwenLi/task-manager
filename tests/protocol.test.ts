import { describe, expect, it } from "vitest";
import { buildWorkerPrompt } from "../src/protocol.js";
import type { Task } from "../src/task-file.js";
import { resolve } from "node:path";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "protocol-a",
    title: "组装任务协议",
    description: "把工作规则与交接笔记拼进 Worker 提示词。",
    status: "running",
    sessions: ["ses-1"],
    retries: 0,
    ...overrides,
  };
}

const ctx = { workdir: resolve("fixture-workspaces", "protocol-a"), tasksDir: resolve("fixture-tasks") };

/** The protocol is spec-fixed copy; the first-session render is pinned verbatim. */
const FIRST_SESSION_PROMPT = `# 任务：组装任务协议

把工作规则与交接笔记拼进 Worker 提示词。

## 工作规则
- 工作目录：${ctx.workdir}；只在此目录内改动
- 完成全部要求后，运行：taskctl done --task protocol-a --tasks-dir "${ctx.tasksDir}"
- 阶段性发现请随时运行：taskctl note --task protocol-a --tasks-dir "${ctx.tasksDir}" --status <一句话状态> --done <已完成> --found <关键发现> --next <下一步> --files <逗号分隔文件>
- 若收到"上下文预算告急"的收尾指令：立即运行一次 taskctl note（尽量详尽，同上参数），然后只回复 HANDOFF_READY

## 上一段会话的交接笔记
（这是本任务第一个会话，无前序笔记）
`;

describe("buildWorkerPrompt", () => {
  it("renders the fixed protocol verbatim on the first session (no handoff)", () => {
    expect(buildWorkerPrompt(task(), ctx)).toBe(FIRST_SESSION_PROMPT);
  });

  it("shows the first-session placeholder when no handoff is given", () => {
    const prompt = buildWorkerPrompt(task(), ctx);
    expect(prompt).toContain("## 上一段会话的交接笔记\n（这是本任务第一个会话，无前序笔记）\n");
  });

  it("injects the previous session's handoff note verbatim", () => {
    const handoff = "---\ntask: protocol-a\nseq: 1\n---\n\n## Status\nrunning；第二段会话接管\n## Found\n锁需要心跳续期，否则会被接管\n";
    const prompt = buildWorkerPrompt(task(), { ...ctx, handoff });

    expect(prompt).toContain(`## 上一段会话的交接笔记\n${handoff}\n`);
    expect(prompt).not.toContain("第一个会话");
  });

  it("interpolates title, description, id, workdir and tasksDir", () => {
    const workdir = resolve("fixture-workspaces", "z-9"), tasksDir = resolve("fixture-tasks");
    const prompt = buildWorkerPrompt(
      task({ id: "z-9", title: "深路径插值", description: "多行描述第一行\n多行描述第二行" }),
      { workdir, tasksDir },
    );

    expect(prompt).toContain("# 任务：深路径插值\n\n多行描述第一行\n多行描述第二行\n\n## 工作规则");
    expect(prompt).toContain(`- 工作目录：${workdir}；只在此目录内改动`);
    expect(prompt).toContain(`taskctl done --task z-9 --tasks-dir "${tasksDir}"`);
    expect(prompt).toContain(`taskctl note --task z-9 --tasks-dir "${tasksDir}" --status`);
  });

  it("double-quotes the absolute tasks dir on every taskctl invocation", () => {
    const prompt = buildWorkerPrompt(task(), ctx);
    // done 与 note 两处都要带双引号绝对路径（Worker 的 cwd 是 workdir）
    expect(prompt.split(`--tasks-dir "${ctx.tasksDir}"`)).toHaveLength(3);
  });

  it("leaks no unescaped braces down either path", () => {
    for (const handoff of [undefined, "上一段完成了协议模板的中文标点校验。"]) {
      const prompt = buildWorkerPrompt(task(), { ...ctx, handoff });
      expect(prompt).not.toContain("{");
      expect(prompt).not.toContain("}");
    }
  });
});
