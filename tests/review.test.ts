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
    const r = parseVerdict("我觉得还行，但说不好。", criteria);
    expect(r.verdict).toBe("unclear");
    expect(r.raw).toContain("我觉得还行");
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
      window: { startedAt: "2026-11-16T00:00:00.000Z", finishedAt: "2026-11-16T00:20:00.000Z" },
    });
    expect(prompt).toContain("## 验收标准");
    expect(prompt).toContain("command npm test");
    expect(prompt).toContain("改好了");
    expect(prompt).toContain("只输出一个 JSON");
    expect(prompt).not.toContain("sessionId");
  });

  it("states the tolerated drift and the window, and says so when nothing is tolerated", () => {
    const base = {
      spec: "",
      acceptanceMarkdown: "",
      handoff: null,
      journal: [],
      window: { startedAt: "2026-11-16T00:00:00.000Z", finishedAt: "2026-11-16T00:20:00.000Z" },
    };
    const tolerated = parseTaskFile(
      "---\ntitle: 填表\nstatus: running\ncriteria:\n  - C1 填了 32 行\ntolerate:\n  - new_column\n  - external_cell_change\nsessions: []\nretries: 0\n---\n正文",
      "002-b",
    );
    const withDrift = buildReviewPrompt({ ...base, task: tolerated });
    expect(withDrift).toContain("## 容忍的外部变更");
    expect(withDrift).toContain("new_column");
    expect(withDrift).toContain("external_cell_change");
    expect(withDrift).toContain("2026-11-16T00:20:00.000Z");
    expect(withDrift).toContain("externalChanges");
    // A changed header meaning is not "a new column": the hint and rule 5 have
    // to agree, or the reviewer gets opposite instructions on the one case the
    // real incident involved.
    expect(withDrift).not.toContain("表头/列序变了");
    expect(withDrift).toContain("时间上从严");
    expect(withDrift).toContain("证据说明不了先后");

    const strict = parseTaskFile(
      "---\ntitle: 填表\nstatus: running\ncriteria:\n  - C1 填了 32 行\nsessions: []\nretries: 0\n---\n正文",
      "003-c",
    );
    expect(buildReviewPrompt({ ...base, task: strict })).toContain("(本任务没有声明");
  });

  it("sets a stress-testing stance, not a lenient one", () => {
    const task = parseTaskFile(
      "---\ntitle: 登录改版\nstatus: running\ncriteria:\n  - C1 npm test 全绿\nsessions: []\nretries: 0\n---\n正文",
      "004-d",
    );
    const prompt = buildReviewPrompt({
      task,
      spec: "",
      acceptanceMarkdown: "",
      handoff: null,
      journal: [],
      window: { startedAt: "2026-11-16T00:00:00.000Z", finishedAt: "2026-11-16T00:20:00.000Z" },
    });
    expect(prompt).toContain("压力测试");
    expect(prompt).toContain("先找做不到");
  });

  it("demands evidence to cite a concrete artifact, and ties empty evidence to unclear", () => {
    const task = parseTaskFile(
      "---\ntitle: 登录改版\nstatus: running\ncriteria:\n  - C1 npm test 全绿\nsessions: []\nretries: 0\n---\n正文",
      "005-e",
    );
    const prompt = buildReviewPrompt({
      task,
      spec: "",
      acceptanceMarkdown: "",
      handoff: null,
      journal: [],
      window: { startedAt: "2026-11-16T00:00:00.000Z", finishedAt: "2026-11-16T00:20:00.000Z" },
    });
    expect(prompt).toContain("读了哪个产物/文件");
    expect(prompt).toContain("空 evidence 的那条标准判 unclear");
  });

  it("tells defects to carry severity, and says a nit-only verdict must not fail", () => {
    const task = parseTaskFile(
      "---\ntitle: 登录改版\nstatus: running\ncriteria:\n  - C1 npm test 全绿\nsessions: []\nretries: 0\n---\n正文",
      "006-f",
    );
    const prompt = buildReviewPrompt({
      task,
      spec: "",
      acceptanceMarkdown: "",
      handoff: null,
      journal: [],
      window: { startedAt: "2026-11-16T00:00:00.000Z", finishedAt: "2026-11-16T00:20:00.000Z" },
    });
    expect(prompt).toContain("🔴");
    expect(prompt).toContain("🟢");
    expect(prompt).toContain("只有 🟢，不要 fail");
  });

  it("asks the reviewer to restate the task and criteria, and to go unclear on a mismatch", () => {
    const task = parseTaskFile(
      "---\ntitle: 登录改版\nstatus: running\ncriteria:\n  - C1 npm test 全绿\nsessions: []\nretries: 0\n---\n正文",
      "007-g",
    );
    const prompt = buildReviewPrompt({
      task,
      spec: "",
      acceptanceMarkdown: "",
      handoff: null,
      journal: [],
      window: { startedAt: "2026-11-16T00:00:00.000Z", finishedAt: "2026-11-16T00:20:00.000Z" },
    });
    expect(prompt).toContain("先写你对本任务和验收标准的复述");
    expect(prompt).toContain("判 unclear");
  });
});
