import { describe, expect, it } from "vitest";
import { buildClarifyPrompt, detectType, parseIntakeAssessment, TEMPLATES } from "../src/intake.js";
import { parseTaskFile } from "../src/task-file.js";

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

describe("parseIntakeAssessment", () => {
  const spec = (lane: string, sufficiency: string, questions = "") => [
    "## 目标", "交付", "## 验收标准", "- C1 可验证",
    "## 管理分类", lane, "## 信息充分性", sufficiency,
    "## 分类理由", "依据明确", "## 补问", questions,
  ].join("\n");

  it("parses the management lane and information outcome independently", () => {
    expect(parseIntakeAssessment(spec("quick", "clear"), "complex")).toMatchObject({ lane: "quick", sufficiency: "clear", reason: "依据明确" });
    expect(parseIntakeAssessment(spec("simple", "assumptions"), "complex")).toMatchObject({ lane: "simple", sufficiency: "assumptions" });
    expect(parseIntakeAssessment(spec("complex", "needs-information"), "simple")).toMatchObject({ lane: "complex", sufficiency: "needs-information" });
  });

  it("falls back conservatively on missing or contradictory assessments", () => {
    // A spec from before these sections existed keeps the lane it was added
    // with: nothing was escalated, so nothing is reported as one.
    expect(parseIntakeAssessment("## 目标\n旧格式", "complex")).toMatchObject({ lane: "complex", sufficiency: "clear", laneEscalated: false });
    expect(parseIntakeAssessment("## 目标\n旧格式", "simple")).toMatchObject({ lane: "simple", laneEscalated: false });
    // An unusable lane becomes complex whatever the fallback was, and is
    // recorded as taskctl's own decision rather than the model's.
    expect(parseIntakeAssessment(spec("tiny", "clear"), "simple")).toMatchObject({ lane: "complex", laneEscalated: true });
    expect(parseIntakeAssessment(spec("simple", "perhaps"), "complex")).toMatchObject({ lane: "simple", sufficiency: "needs-information", laneEscalated: false });
  });

  it("keeps only three outcome-changing questions", () => {
    const parsed = parseIntakeAssessment(spec("simple", "needs-information", "- Q1\n- Q2\n- Q3\n- Q4"), "complex");
    expect(parsed.questions).toEqual(["Q1", "Q2", "Q3"]);
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
    expect(prompt).toContain("## 管理分类");
    expect(prompt).toContain("## 信息充分性");
    expect(prompt).toContain("quick、simple、complex");
  });

  it("injects the profile and bounded human feedback when present", () => {
    const task = parseTaskFile("---\ntitle: x\nstatus: draft\nsessions: []\nretries: 0\n---\n正文", "001-a");
    const prompt = buildClarifyPrompt({
      task, type: "code", profile: "偏好：短句，不要寒暄",
      feedback: "用户曾纠正：不要自行扩大验收范围",
    });
    expect(prompt).toContain("偏好：短句，不要寒暄");
    expect(prompt).toContain("不要自行扩大验收范围");
  });
});
