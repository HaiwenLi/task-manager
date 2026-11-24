import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROFILE_MAX_CHARS,
  SPEC_MAX_CHARS,
  WORKER_FEEDBACK_LIMIT,
  WORKER_FEEDBACK_MAX_CHARS,
  clipHeadTail,
  clippedSpec,
  isWorkerRelevant,
  profileSection,
  readContextSections,
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
