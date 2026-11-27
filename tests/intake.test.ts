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
  const spec = (claimedLane: string | null, sufficiency: string, questions = "") => [
    "## 目标", "交付", "## 验收标准", "- C1 可验证",
    ...(claimedLane === null ? [] : ["## 管理分类", claimedLane]),
    "## 信息充分性", sufficiency,
    "## 分类理由", "依据明确", "## 补问", questions,
  ].join("\n");

  it("keeps the information verdict and the reason, and has no lane to give", () => {
    expect(parseIntakeAssessment(spec("quick", "clear"))).toEqual({ sufficiency: "clear", reason: "依据明确", questions: [] });
    expect(parseIntakeAssessment(spec("simple", "assumptions"))).toMatchObject({ sufficiency: "assumptions" });
    expect(parseIntakeAssessment(spec("complex", "needs-information"))).toMatchObject({ sufficiency: "needs-information" });
  });

  it("ignores a 管理分类 section, whatever it says, and does not count it as an assessment", () => {
    expect(parseIntakeAssessment(spec("tiny", "clear")).sufficiency).toBe("clear");
    // A spec from before the sufficiency section existed was never judged: it reads as clear.
    expect(parseIntakeAssessment("## 目标\n旧格式")).toEqual({ sufficiency: "clear", reason: "", questions: [] });
    expect(parseIntakeAssessment("## 目标\n交付\n## 管理分类\nsimple")).toEqual({ sufficiency: "clear", reason: "", questions: [] });
  });

  it("treats a verdict it cannot read as missing information", () => {
    expect(parseIntakeAssessment(spec("simple", "perhaps")).sufficiency).toBe("needs-information");
    expect(parseIntakeAssessment(spec(null, "perhaps")).sufficiency).toBe("needs-information");
  });

  it("keeps only three outcome-changing questions", () => {
    expect(parseIntakeAssessment(spec("simple", "needs-information", "- Q1\n- Q2\n- Q3\n- Q4")).questions).toEqual(["Q1", "Q2", "Q3"]);
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
    expect(prompt).toContain("clear、assumptions、needs-information");
    expect(prompt).not.toContain("## 管理分类");
    expect(prompt).not.toContain("管理分类只能是");
    expect(prompt).not.toContain("quick、simple、complex");
    expect(prompt).toContain("## 信息充分性");
  });

  it("numbers its rules without a gap", () => {
    const task = parseTaskFile("---\ntitle: x\nstatus: draft\nsessions: []\nretries: 0\n---\n正文", "001-a");
    const prompt = buildClarifyPrompt({ task, type: "code", profile: null });
    expect([...prompt.matchAll(/^(\d+)\. /gm)].map((match) => Number(match[1]))).toEqual([1, 2, 3, 4, 5, 6, 7]);
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
