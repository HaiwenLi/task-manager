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
});
