import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FIXED_SOURCE_MAX_CHARS,
  PROFILE_MAX_CHARS,
  SPEC_MAX_CHARS,
  WORKER_FEEDBACK_LIMIT,
  WORKER_FEEDBACK_MAX_CHARS,
  clipHeadTail,
  clippedSpec,
  isWorkerRelevant,
  profileSection,
  readContextSections,
  readFixedSources,
  sourceName,
  sourcesDetail,
} from "../src/context.js";
import { recordFeedback, type FeedbackRecord } from "../src/feedback.js";
import { writeSpec } from "../src/spec.js";
import type { Task } from "../src/task-file.js";
import { buildTaskFile } from "./helpers/task-fixture.js";

let root: string;
let tasks: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "taskctl-context-"));
  tasks = join(root, "tasks");
  await mkdir(tasks);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const task: Task = buildTaskFile({ id: "a", title: "任务A", description: "A 的正文" });

/** A correction a human left on an earlier task, `minute` minutes into 2026. */
function correction(overrides: Partial<FeedbackRecord> & { note: string }, minute = 0): FeedbackRecord {
  return {
    task: "old",
    title: "任务A",
    action: "reject",
    verdict: "fail",
    stage: "worker",
    at: new Date(2026, 0, 1, 0, minute).toISOString(),
    ...overrides,
  };
}

describe("context sections", () => {
  it("clips head and tail to the limit with a visible marker", () => {
    const out = clipHeadTail("a".repeat(5_000) + "b".repeat(5_000), 1_000, "<CUT>");
    expect(out).toHaveLength(1_000);
    expect(out.startsWith("aaaa")).toBe(true);
    expect(out.endsWith("bbbb")).toBe(true);
    expect(out).toContain("<CUT>");
    expect(clipHeadTail("short", 1_000, "<CUT>")).toBe("short");
  });

  it("clips a long spec to the limit and leaves a short one whole", () => {
    expect(clippedSpec("  # Spec\nbody  ")).toBe("# Spec\nbody");
    const long = clippedSpec("a".repeat(5_000) + "b".repeat(5_000));
    expect(long).toHaveLength(SPEC_MAX_CHARS);
    expect(long.startsWith("aaaa")).toBe(true);
    expect(long.endsWith("bbbb")).toBe(true);
    expect(long).toContain("中段已省略");
  });

  it("keeps the newest profile entries past the limit and says how much was cut", () => {
    const lines = Array.from({ length: 400 }, (_, i) => `- 2026-11-${String((i % 28) + 1).padStart(2, "0")}  rule ${i}`);
    const { text, truncatedChars } = profileSection(lines.join("\n"));
    expect(truncatedChars).toBeGreaterThan(0);
    expect(text.length).toBeLessThanOrEqual(PROFILE_MAX_CHARS + 40);
    expect(text).toContain("rule 399");
    expect(text).not.toContain("rule 0\n");
    expect(profileSection("- one").truncatedChars).toBe(0);
  });

  it("still keeps the tail when the last rule alone is longer than the limit", () => {
    const profile = `- 2026-11-01  short rule\n- 2026-11-02  ${"长".repeat(2_500)}\n`;
    const { text, truncatedChars } = profileSection(profile);
    expect(truncatedChars).toBeGreaterThan(0);
    expect(text).toContain("这里只保留最新的部分");
    // Moving to the next line break would move past everything there is to keep.
    expect(text).toContain("长".repeat(100));
    expect(text.endsWith("长".repeat(100) + "\n")).toBe(true);
  });

  it("selects the corrections a worker can act on", () => {
    const record = (action: string, stage: string) => ({ action, stage, verdict: "fail", note: "n", task: "t" }) as FeedbackRecord;
    expect(isWorkerRelevant(record("reject", "worker"))).toBe(true);
    expect(isWorkerRelevant(record("audit", "worker"))).toBe(true);
    expect(isWorkerRelevant(record("accept", "none"))).toBe(true);
    expect(isWorkerRelevant(record("reject", "reviewer"))).toBe(false);
    expect(isWorkerRelevant(record("reject", "clarify"))).toBe(false);
    expect(isWorkerRelevant(record("answer", "none"))).toBe(false);
  });

  it("reads nothing when the files are absent", async () => {
    expect(await readContextSections(tasks, task, { spec: true, preferences: true }))
      .toEqual({ profileTruncatedChars: 0 });
  });

  it("caps worker feedback at five entries and 1500 chars", async () => {
    // seven reject/worker notes of 400 chars each about the same topic, one reject/reviewer note
    for (let i = 0; i < 7; i++) {
      await recordFeedback(tasks, correction(
        { task: `old-${i}`, note: `WORKER CORRECTION ${i} ${"改".repeat(400)}` },
        i,
      ));
    }
    await recordFeedback(tasks, correction({ task: "reviewed", stage: "reviewer", note: `REVIEWER NOTE ${"改".repeat(400)}` }));
    const sections = await readContextSections(tasks, task, { spec: false, preferences: true });
    const notes = sections.feedback!.split("\n");
    expect(notes.length).toBeLessThanOrEqual(WORKER_FEEDBACK_LIMIT);
    expect(sections.feedback!.length).toBeLessThanOrEqual(WORKER_FEEDBACK_MAX_CHARS);
    expect(sections.feedback).not.toContain("REVIEWER NOTE");
    // Seven corrections were on file: the caps left some out, they did not leave everything out.
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.length).toBeLessThan(7);
  });

  it("reads each file only while its switch is on", async () => {
    await writeSpec(tasks, "a", "## 目标\nSPEC LINE\n");
    await mkdir(join(root, ".taskctl"));
    await writeFile(join(root, ".taskctl", "profile.md"), "- 2026-11-25  PREFERENCE LINE\n", "utf8");
    await recordFeedback(tasks, correction({ note: "WORKER CORRECTION" }));

    expect(await readContextSections(tasks, task, { spec: true, preferences: true })).toEqual({
      // The prompt writes the fixed spec note itself, so the section carries the spec alone.
      spec: "## 目标\nSPEC LINE",
      profile: "- 2026-11-25  PREFERENCE LINE\n",
      feedback: expect.stringContaining("WORKER CORRECTION"),
      profileTruncatedChars: 0,
    });
    expect(await readContextSections(tasks, task, { spec: false, preferences: false })).toEqual({ profileTruncatedChars: 0 });
    expect(await readContextSections(tasks, task, { spec: true, preferences: false })).toEqual({
      spec: "## 目标\nSPEC LINE",
      profileTruncatedChars: 0,
    });
    expect(await readContextSections(tasks, task, { spec: false, preferences: true })).toEqual({
      profile: "- 2026-11-25  PREFERENCE LINE\n",
      feedback: expect.stringContaining("WORKER CORRECTION"),
      profileTruncatedChars: 0,
    });
  });

  it("renders every chosen correction on one line", async () => {
    // A note breaks its lines; so can a task title, which `renderEntry` quotes.
    await recordFeedback(tasks, correction({ title: "登录页\n按钮没对齐", note: "第一行\n第二行 保留这种写法" }));
    const sections = await readContextSections(tasks, task, { spec: false, preferences: true });
    expect(sections.feedback!.split("\n")).toHaveLength(1);
    expect(sections.feedback).toContain("old（登录页 按钮没对齐）");
    expect(sections.feedback).toContain("人工打回（worker）：第一行 / 第二行 保留这种写法");
    // No heading of its own: `buildWorkerPrompt` writes it, once.
    expect(sections.feedback).not.toContain("## ");
  });
});

describe("readFixedSources", () => {
  /** A directory of source files under the temp root; what each file holds is the record. */
  async function sources(files: Record<string, string>): Promise<string> {
    const dir = join(root, "owner-rules");
    await mkdir(dir);
    for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content, "utf8");
    return dir;
  }

  it("reads each file whole, in the order configured, each behind its own name", async () => {
    const dir = await sources({ "voice.md": "# 写法\n\n称呼一律「你」\n", "contract.md": "- 不打印密钥\n- 不改默认模型\n" });

    const { text, files } = await readFixedSources([join(dir, "voice.md"), join(dir, "contract.md")]);

    // The ends trimmed, the blocks one blank line apart, and in the order configured — not the directory's.
    expect(text).toBe("【voice.md】\n# 写法\n\n称呼一律「你」\n\n【contract.md】\n- 不打印密钥\n- 不改默认模型");
    expect(files).toEqual([
      { name: "voice.md", state: "read", chars: 13 },
      { name: "contract.md", state: "read", chars: 16 },
    ]);
  });

  it("strips a byte-order mark and Windows line ends", async () => {
    const dir = await sources({ "voice.md": "\uFEFF# 写法\r\n\r\n称呼一律「你」\r\n" });

    const { text } = await readFixedSources([join(dir, "voice.md")]);

    expect(text).toBe("【voice.md】\n# 写法\n\n称呼一律「你」");
  });

  it("reports a file that is not there as missing, under a directory that is not there too", async () => {
    const { text, files } = await readFixedSources([join(root, "no-such-dir", "notes.md"), join(root, "tasks", "voice.md")]);

    expect(files).toEqual([
      { name: "notes.md", state: "missing", chars: 0 },
      { name: "voice.md", state: "missing", chars: 0 },
    ]);
    // Nothing was read, so there is no text at all rather than an empty one.
    expect(text).toBeUndefined();
  });

  it("keeps reading past a file that is missing", async () => {
    const dir = await sources({ "voice.md": "称呼一律「你」", "contract.md": "- 不打印密钥" });

    const { text, files } = await readFixedSources([join(dir, "voice.md"), join(dir, "notes.md"), join(dir, "contract.md")]);

    expect(text).toBe("【voice.md】\n称呼一律「你」\n\n【contract.md】\n- 不打印密钥");
    expect(files.map((file) => file.state)).toEqual(["read", "missing", "read"]);
  });

  it("reports a file that cannot be read as unreadable, by the error's code", async () => {
    // A directory where a file is named: the read fails with EISDIR.
    const { text, files } = await readFixedSources([join(root, "tasks")]);

    expect(files).toEqual([{ name: "tasks", state: "unreadable", chars: 0, detail: "EISDIR" }]);
    expect(text).toBeUndefined();
  });

  it("reports a file with nothing in it as empty", async () => {
    const dir = await sources({ "blank.md": " \r\n\t\n", "zero.md": "", "mark.md": "\uFEFF" });

    const { text, files } = await readFixedSources([join(dir, "blank.md"), join(dir, "zero.md"), join(dir, "mark.md")]);

    expect(files).toEqual([
      { name: "blank.md", state: "empty", chars: 0 },
      { name: "zero.md", state: "empty", chars: 0 },
      { name: "mark.md", state: "empty", chars: 0 },
    ]);
    expect(text).toBeUndefined();
  });

  it("clips a file past the limit to its head and tail, behind a line that says how long the whole file is", async () => {
    const dir = await sources({ "contract.md": "甲".repeat(6_000) + "丙".repeat(1_000) + "乙".repeat(3_000) });

    const { text, files } = await readFixedSources([join(dir, "contract.md")]);

    expect(files).toEqual([{ name: "contract.md", state: "clipped", chars: FIXED_SOURCE_MAX_CHARS }]);
    const opening = "【contract.md】\n（文件共 10000 字符，这里只保留开头和结尾）\n";
    expect(text!.startsWith(opening)).toBe(true);
    const content = text!.slice(opening.length);
    // Exactly the limit, opening with the file's own opening and closing with its own closing; the middle is gone.
    expect(content).toHaveLength(FIXED_SOURCE_MAX_CHARS);
    expect(content.startsWith("甲".repeat(100))).toBe(true);
    expect(content.endsWith("乙".repeat(100))).toBe(true);
    expect(content).toContain("这个文件过长，中段已省略");
    expect(content).not.toContain("丙");
  });

  it("reads a file exactly at the limit whole", async () => {
    const dir = await sources({ "voice.md": "字".repeat(FIXED_SOURCE_MAX_CHARS) });

    const { text, files } = await readFixedSources([join(dir, "voice.md")]);

    expect(files).toEqual([{ name: "voice.md", state: "read", chars: FIXED_SOURCE_MAX_CHARS }]);
    expect(text).toBe(`【voice.md】\n${"字".repeat(FIXED_SOURCE_MAX_CHARS)}`);
  });

  it("carries a file's name into the text, and never the directory it is in", async () => {
    const dir = await sources({ "voice.md": "称呼一律「你」" });

    const { text } = await readFixedSources([join(dir, "voice.md")]);

    expect(text).toContain("【voice.md】\n称呼一律「你」");
    // The directory has a name of its own, so this cannot pass because nothing was read.
    expect(text).not.toContain("owner-rules");
    expect(text).not.toContain(root);
  });

  it("sourcesDetail names each file once, with what came of it", () => {
    expect(sourcesDetail([
      { name: "voice.md", state: "read", chars: 1934 },
      { name: "contract.md", state: "clipped", chars: FIXED_SOURCE_MAX_CHARS },
      { name: "blank.md", state: "empty", chars: 0 },
      { name: "notes.md", state: "missing", chars: 0 },
      { name: "x.md", state: "unreadable", chars: 0, detail: "EISDIR" },
    ])).toBe("voice.md=1934; contract.md=clipped(8000); blank.md=empty; notes.md=missing; x.md=unreadable(EISDIR)");
  });

  it("names a source by what follows its last separator, of either kind", () => {
    // `path.basename` splits on a backslash only where a backslash is a separator, so a name taken with it would
    // carry a whole Windows path on POSIX. The name is cut by hand, the same way on every platform.
    expect(sourceName("C:\\rules\\voice.md")).toBe("voice.md");
    expect(sourceName("/etc/rules/voice.md")).toBe("voice.md");
    expect(sourceName("C:/rules\\voice.md")).toBe("voice.md");
    expect(sourceName("voice.md")).toBe("voice.md");
  });
});
