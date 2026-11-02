import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { latestNote, notePath, writeNote, type HandoffNote } from "../src/handoff.js";

function note(seq: number, overrides: Partial<HandoffNote> = {}): HandoffNote {
  return {
    task: "a",
    seq,
    status: "running；锁已持有",
    done: "完成了 claim 与心跳",
    found: "tasks/<id>/ 辅助目录会被复用",
    next: "继续实现验收关",
    files: ["src/claim.ts", "tests/claim.test.ts"],
    ...overrides,
  };
}

let tasksDir: string;

beforeEach(async () => {
  tasksDir = await mkdtemp(join(tmpdir(), "taskctl-handoff-"));
});

afterEach(async () => {
  await rm(tasksDir, { recursive: true, force: true });
});

describe("notePath", () => {
  it("places a 4-digit-padded note under tasks/<id>/sessions/", () => {
    expect(notePath(tasksDir, "a", 1)).toBe(join(tasksDir, "a", "sessions", "0001-handoff.md"));
    expect(notePath(tasksDir, "a", 42)).toBe(join(tasksDir, "a", "sessions", "0042-handoff.md"));
  });
});

describe("writeNote", () => {
  it("writes frontmatter task/seq plus the five fixed section headings", async () => {
    const path = await writeNote(tasksDir, note(1));
    expect(path).toBe(join(tasksDir, "a", "sessions", "0001-handoff.md"));

    const raw = await readFile(path, "utf8");
    expect(raw).toContain("task: a");
    expect(raw).toContain("seq: 1");
    expect(raw).toContain("## Status");
    expect(raw).toContain("## Done");
    expect(raw).toContain("## Found");
    expect(raw).toContain("## Next");
    expect(raw).toContain("## Files");
  });

});

describe("latestNote", () => {
  it("returns null when no note was ever written", async () => {
    await expect(latestNote(tasksDir, "a")).resolves.toBeNull();
  });

  it("returns null when the sessions directory exists but holds no notes", async () => {
    await mkdir(join(tasksDir, "a", "sessions"), { recursive: true });
    await expect(latestNote(tasksDir, "a")).resolves.toBeNull();
  });

  it("reads back the five sections with identical content", async () => {
    const n = note(1, {
      status: "blocked：等待人工确认",
      done: "完成了存储层与锁",
      found: "Windows 路径需走 node:path",
      next: "补齐 handoff 档案",
      files: ["src/task-store.ts", "src/claim.ts", "src/handoff.ts"],
    });
    await writeNote(tasksDir, n);

    const latest = await latestNote(tasksDir, "a");
    expect(latest).not.toBeNull();
    expect(latest!.seq).toBe(1);
    expect(latest!.markdown).toContain(`## Status\n${n.status}`);
    expect(latest!.markdown).toContain(`## Done\n${n.done}`);
    expect(latest!.markdown).toContain(`## Found\n${n.found}`);
    expect(latest!.markdown).toContain(`## Next\n${n.next}`);
    expect(latest!.markdown).toContain(`## Files\n${n.files.map((f) => `- ${f}`).join("\n")}`);
  });

  it("keeps both numbered notes on disk; the highest seq is the latest", async () => {
    await writeNote(tasksDir, note(1, { done: "第一段：解析器" }));
    await writeNote(tasksDir, note(2, { done: "第二段：锁与心跳" }));

    const names = await readdir(join(tasksDir, "a", "sessions"));
    expect(names).toContain("0001-handoff.md");
    expect(names).toContain("0002-handoff.md");

    const latest = await latestNote(tasksDir, "a");
    expect(latest!.seq).toBe(2);
    expect(latest!.markdown).toContain("第二段：锁与心跳");
  });

  it("preserves Chinese and multiline content verbatim", async () => {
    const multiline = "第一行：实现 writeNote\n第二行：实现 latestNote\n第三行（含中文标点——保留）";
    await writeNote(tasksDir, note(3, { found: multiline }));

    const latest = await latestNote(tasksDir, "a");
    expect(latest!.markdown).toContain(`## Found\n${multiline}`);
  });
});
