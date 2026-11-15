import { describe, expect, it } from "vitest";
import { buildClarifyPrompt, detectComplexity, detectType, TEMPLATES } from "../src/intake.js";
import { parseTaskFile } from "../src/task-file.js";

describe("detectComplexity", () => {
  it("only an explicit statement downgrades to simple", () => {
    expect(detectComplexity("这是个简单任务：修一下 README 的错字")).toBe("simple");
    expect(detectComplexity("这是一个简单任务")).toBe("simple");
    expect(detectComplexity("simple: fix typo")).toBe("simple");
    expect(detectComplexity("简单任务：改个错字")).toBe("simple");
    expect(detectComplexity("重构登录模块")).toBe("complex");
    expect(detectComplexity("不太复杂，改个文案")).toBe("complex");
  });

  it("does not downgrade on a negation or a mere mention", () => {
    expect(detectComplexity("这不是简单任务，要重构登录模块")).toBe("complex");
    expect(detectComplexity("上次那个简单任务又出问题了")).toBe("complex");
  });
});

describe("detectType", () => {
  it("routes by obvious keywords", () => {
    expect(detectType("调研一下文档站的方案")).toBe("research");
    expect(detectType("做一份季度汇报 PPT")).toBe("design");
    expect(detectType("整理这个 Excel 表格")).toBe("office");
    expect(detectType("修一下登录接口")).toBe("code");
  });
});

describe("TEMPLATES", () => {
  it("every type carries required, inferable and ask buckets", () => {
    for (const type of ["code", "office", "research", "design"] as const) {
      expect(TEMPLATES[type].required.length).toBeGreaterThan(0);
      expect(TEMPLATES[type].infer.length).toBeGreaterThan(0);
      expect(TEMPLATES[type].ask.length).toBeGreaterThan(0);
    }
  });
});

describe("buildClarifyPrompt", () => {
  it("carries the template, the intent and the hard rules", () => {
    const task = parseTaskFile(
      "---\ntitle: 登录改版\nstatus: draft\nsessions: []\nretries: 0\n---\n这是个简单任务：改登录页",
      "001-a",
    );
    const prompt = buildClarifyPrompt({ task, type: "code", profile: null });
    expect(prompt).toContain("改动后是什么样");
    expect(prompt).toContain("不许把无法判定的东西写成可判定");
    expect(prompt).toContain("最多 3 条");
    expect(prompt).toContain("## 目标");
    expect(prompt).toContain("## 验收标准");
    expect(prompt).toContain("改登录页");
  });

  it("injects the profile when there is one", () => {
    const task = parseTaskFile("---\ntitle: x\nstatus: draft\nsessions: []\nretries: 0\n---\n正文", "001-a");
    const prompt = buildClarifyPrompt({ task, type: "code", profile: "偏好：短句，不要寒暄" });
    expect(prompt).toContain("偏好：短句，不要寒暄");
  });
});
