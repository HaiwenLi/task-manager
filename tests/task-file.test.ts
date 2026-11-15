import { describe, expect, it } from "vitest";
import { TaskFileError, parseTaskFile, serializeTaskFile } from "../src/task-file.js";

const raw = `---
id: fix-login
title: 修复登录超时
status: open
acceptance: npm test
sessions: []
retries: 0
---
修复登录页超时问题`;

describe("parseTaskFile", () => {
  it("does not share mutable session chains between identical Markdown parses", () => {
    const raw = "---\ntitle: Same\nstatus: open\nsessions: []\nretries: 0\n---\nSame task";
    const first = parseTaskFile(raw, "first");
    first.sessions.push("belongs-only-to-first");
    expect(parseTaskFile(raw, "second").sessions).toEqual([]);
  });
  it("parses frontmatter and body", () => {
    const t = parseTaskFile(raw, "fix-login");
    expect(t.id).toBe("fix-login");
    expect(t.title).toBe("修复登录超时");
    expect(t.description).toContain("登录页");
    expect(t.status).toBe("open");
    expect(t.acceptance).toBe("npm test");
    expect(t.sessions).toEqual([]);
  });

  it("defaults optionals", () => {
    // 无 model/effort/acceptance 的文件 → undefined
    const minimal = `---
id: fix-login
title: 修复登录超时
status: open
sessions: []
retries: 0
---
正文`;
    const t = parseTaskFile(minimal, "fix-login");
    expect(t.model).toBeUndefined();
    expect(t.effort).toBeUndefined();
    expect(t.acceptance).toBeUndefined();
  });

  it("round-trips serialize→parse idempotent", () => {
    // serializeTaskFile(parseTaskFile(raw)) 再解析字段相等
    const t = parseTaskFile(raw, "fix-login");
    const again = parseTaskFile(serializeTaskFile(t), t.id);
    expect(again).toEqual(t);
  });

  it("throws TaskFileError with file id on broken frontmatter", () => {
    // 缺 --- 结束符
    const broken = raw.replace("\n---\n", "\n");
    expect(() => parseTaskFile(broken, "fix-login")).toThrow(TaskFileError);
    expect(() => parseTaskFile(broken, "fix-login")).toThrow(/fix-login/);
  });

  it("throws TaskFileError with file id on unknown status", () => {
    const invalid = raw.replace("status: open", "status: wip");
    expect(() => parseTaskFile(invalid, "fix-login")).toThrow(TaskFileError);
    expect(() => parseTaskFile(invalid, "fix-login")).toThrow(/fix-login/);
  });

  it("parses and round-trips the pipeline fields", () => {
    const pipeline = `---
title: 登录页改版
status: draft
complexity: complex
risk: high
criteria:
  - C1 登录接口 401 时前端提示文案正确
  - C2 npm test 全绿
workdir: packages/web
depends_on:
  - 003-api
human_check: true
sessions: []
retries: 0
review_rounds: 2
---
正文`;
    const t = parseTaskFile(pipeline, "005-login");
    expect(t.status).toBe("draft");
    expect(t.criteria).toEqual(["C1 登录接口 401 时前端提示文案正确", "C2 npm test 全绿"]);
    expect(t.dependsOn).toEqual(["003-api"]);
    expect(t.workdir).toBe("packages/web");
    expect(t.risk).toBe("high");
    expect(t.humanCheck).toBe(true);
    expect(t.reviewRounds).toBe(2);
    expect(parseTaskFile(serializeTaskFile(t), t.id)).toEqual(t);
  });

  it("defaults the pipeline fields", () => {
    const t = parseTaskFile("---\ntitle: x\nstatus: open\nsessions: []\nretries: 0\n---\n", "001-x");
    expect(t.complexity).toBe("complex");
    expect(t.risk).toBe("normal");
    expect(t.criteria).toEqual([]);
    expect(t.dependsOn).toEqual([]);
    expect(t.humanCheck).toBe(false);
    expect(t.reviewRounds).toBe(0);
  });

  it("rejects a task that depends on itself", () => {
    const selfDep = `---\ntitle: x\nstatus: open\ndepends_on:\n  - 001-x\nsessions: []\nretries: 0\n---\n`;
    expect(() => parseTaskFile(selfDep, "001-x")).toThrow(/itself/);
  });

  it("rejects the review status on a task file", () => {
    const review = raw.replace("status: open", "status: awaiting-human");
    expect(parseTaskFile(review, "fix-login").status).toBe("awaiting-human");
  });
});
