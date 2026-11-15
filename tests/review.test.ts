import { describe, expect, it } from "vitest";
import { buildReviewPrompt, parseVerdict } from "../src/review.js";
import { parseTaskFile } from "../src/task-file.js";

const criteria = ["C1 npm test 全绿", "C2 401 时文案正确"];

describe("parseVerdict", () => {
  it("parses a bare JSON verdict", () => {
    const r = parseVerdict(
      `{"verdict":"pass","criteria":[{"id":"C1","pass":true,"evidence":"exit 0"},{"id":"C2","pass":true,"evidence":"ok"}],"defects":[],"summary":"ok"}`,
      criteria,
    );
    expect(r.verdict).toBe("pass");
    expect(r.criteria).toHaveLength(2);
    expect(r.summary).toBe("ok");
  });

  it("parses a fenced JSON verdict surrounded by prose", () => {
    const text = "我先看了下。\n```json\n{\"verdict\":\"fail\",\"criteria\":[{\"id\":\"C1\",\"pass\":false,\"evidence\":\"exit 1\"},{\"id\":\"C2\",\"pass\":true,\"evidence\":\"ok\"}],\"defects\":[\"宽度仍写死\"],\"summary\":\"未达 C1\"}\n```\n请返工。";
    const r = parseVerdict(text, criteria);
    expect(r.verdict).toBe("fail");
    expect(r.defects).toEqual(["宽度仍写死"]);
  });

  it("unparsable output becomes unclear, never fail", () => {
    expect(parseVerdict("我觉得还行，但说不好。", criteria).verdict).toBe("unclear");
    expect(parseVerdict(`{"verdict":"maybe"}`, criteria).verdict).toBe("unclear");
  });

  it("a criterion the reviewer omitted counts as not passed and downgrades to unclear", () => {
    const r = parseVerdict(
      `{"verdict":"pass","criteria":[{"id":"C1","pass":true,"evidence":"ok"}],"defects":[],"summary":"ok"}`,
      criteria,
    );
    expect(r.verdict).toBe("unclear");
    expect(r.criteria.find((c) => c.id === "C2")?.pass).toBe(false);
  });

  it("a fail verdict whose criteria all passed is treated as unclear", () => {
    const r = parseVerdict(
      `{"verdict":"fail","criteria":[{"id":"C1","pass":true,"evidence":"ok"},{"id":"C2","pass":true,"evidence":"ok"}],"defects":[],"summary":"x"}`,
      criteria,
    );
    expect(r.verdict).toBe("unclear");
  });

  it("a pass verdict with a failed criterion is a fail, not a pass", () => {
    const r = parseVerdict(
      `{"verdict":"pass","criteria":[{"id":"C1","pass":false,"evidence":"exit 1"},{"id":"C2","pass":true,"evidence":"ok"}],"defects":[],"summary":"总体可以"}`,
      criteria,
    );
    expect(r.verdict).toBe("fail");
    expect(r.criteria.find((c) => c.id === "C1")?.pass).toBe(false);
  });

  it("a truthy but non-boolean pass value does not count as passed", () => {
    const r = parseVerdict(
      `{"verdict":"pass","criteria":[{"id":"C1","pass":"true"},{"id":"C2","pass":1}],"defects":[],"summary":"ok"}`,
      criteria,
    );
    expect(r.verdict).toBe("fail");
  });
});

describe("buildReviewPrompt", () => {
  it("carries evidence only, and asks for a single JSON object", () => {
    const task = parseTaskFile(
      "---\ntitle: 登录改版\nstatus: running\ncriteria:\n  - C1 npm test 全绿\nsessions: []\nretries: 0\n---\n正文",
      "001-a",
    );
    const prompt = buildReviewPrompt({
      task,
      spec: "## 验收标准\n- C1 npm test 全绿\n",
      acceptanceMarkdown: "command npm test\nexit 0",
      handoff: "## Done\n改好了",
      journal: ["2026-11-16T00:00:00.000Z  worker  running"],
    });
    expect(prompt).toContain("## 验收标准");
    expect(prompt).toContain("command npm test");
    expect(prompt).toContain("改好了");
    expect(prompt).toContain("只输出一个 JSON");
    expect(prompt).not.toContain("sessionId");
  });
});
