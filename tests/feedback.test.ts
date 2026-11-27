import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FEEDBACK_LIMIT,
  FEEDBACK_NOTE_LIMIT,
  FEEDBACK_PACKET_CHARS,
  FEEDBACK_PACKET_ENTRIES,
  pickFeedback,
  readFeedback,
  readRelevantFeedback,
  recordFeedback,
  selectRelevantFeedback,
} from "../src/feedback.js";
import { readQuestions } from "../src/questions.js";
import { runCli } from "../src/cli.js";
import { readProfile } from "../src/profile.js";
import { definitionDigest } from "../src/runtime.js";
import { readSpec } from "../src/spec.js";
import { serializeTaskFile } from "../src/task-file.js";
import { TaskStore } from "../src/task-store.js";
import { buildTaskFile } from "./helpers/task-fixture.js";
import type { AgentAdapter } from "../src/adapters/types.js";
import type { FeedbackRecord } from "../src/feedback.js";

let root: string;
let tasks: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "taskctl-feedback-"));
  tasks = join(root, "tasks");
  await mkdir(tasks);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const silent = { log: () => {}, err: () => {} };

/** A record `minute` minutes into 2026, so "newest first" is a fact and not file order. */
function note(overrides: Partial<FeedbackRecord> & { task: string; note: string }, minute = 0): FeedbackRecord {
  return {
    action: "reject",
    verdict: "fail",
    stage: "clarify",
    taskType: "code",
    at: new Date(2026, 0, 1, 0, minute).toISOString(),
    ...overrides,
  };
}

describe("human feedback history", () => {
  it("keeps bounded relevant human notes and ignores empty preferences", async () => {
    await recordFeedback(tasks, note({ task: "a", note: "先说明兼容约束" }));
    expect(await recordFeedback(tasks, note({ task: "b", action: "accept", verdict: "pass", stage: "none", note: "  " }, 1))).toBe(false);
    await recordFeedback(tasks, note({ task: "c", action: "audit", verdict: "fail", stage: "worker", taskType: "office", note: "表格要保留原格式" }, 2));

    const feedback = await readRelevantFeedback(tasks, { type: "code", intent: "兼容约束" });
    expect(feedback).toContain("先说明兼容约束");
    expect(feedback).not.toContain("表格要保留原格式");
    expect(feedback).not.toContain("task: b");
    expect(await readRelevantFeedback(tasks, { type: "design", intent: "海报" })).toBeNull();
  });

  it("bounds the stored history to the newest records", async () => {
    for (let i = 0; i < FEEDBACK_LIMIT + 5; i++) {
      await recordFeedback(tasks, note({ task: `t${i}`, note: `纠正 ${i}` }, i));
    }
    const stored = await readFeedback(tasks);
    expect(stored).toHaveLength(FEEDBACK_LIMIT);
    expect(stored[0]!.task).toBe("t5");
    expect(stored.at(-1)!.task).toBe(`t${FEEDBACK_LIMIT + 4}`);
  });

  it("bounds each note and the packet handed to a clarify session", async () => {
    const long = "长".repeat(FEEDBACK_NOTE_LIMIT + 50);
    await recordFeedback(tasks, note({ task: "long", note: long }));
    expect(Array.from((await readFeedback(tasks))[0]!.note)).toHaveLength(FEEDBACK_NOTE_LIMIT + 1);

    for (let i = 0; i < FEEDBACK_PACKET_ENTRIES + 4; i++) {
      await recordFeedback(tasks, note({ task: `p${i}`, note: `备注 ${i}${"则".repeat(FEEDBACK_NOTE_LIMIT)}` }, 10 + i));
    }
    const packet = (await readRelevantFeedback(tasks, { type: "code", intent: "改 README 错字" }))!;
    const lines = packet.split("\n");
    // An entry cap alone would hand the model eight wall-of-text notes, so the
    // packet also stops at a character budget — always keeping the first entry.
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.length).toBeLessThan(FEEDBACK_PACKET_ENTRIES);
    expect(Array.from(packet).length).toBeLessThanOrEqual(FEEDBACK_PACKET_CHARS);
    // Nothing was chosen by relevance here, so what survives is simply the newest.
    expect(lines[0]).toContain(`备注 ${FEEDBACK_PACKET_ENTRIES + 3}`);
  });

  it("ranks same-type notes by literal overlap, newest first, and caps the packet", async () => {
    const record = (task: string, taskType: "code" | "office", text: string, minute: number) =>
      recordFeedback(tasks, note({ task, taskType, action: "audit", verdict: "fail", stage: "worker", note: text }, minute));
    await record("old", "code", "导出按钮宽度不要写死", 1);
    await record("rel-1", "code", "登录页要保留旧路由", 2);
    await record("other-type", "office", "登录页表格保留原格式", 3);
    await record("rel-2", "code", "登录页需要兼容 V1", 4);
    for (let i = 0; i < FEEDBACK_PACKET_ENTRIES; i++) {
      await record(`filler-${i}`, "code", `无关备注 ${i}`, 10 + i);
    }

    const packet = (await readRelevantFeedback(tasks, { type: "code", intent: "改登录页的横幅" }))!;
    const lines = packet.split("\n");
    expect(lines).toHaveLength(FEEDBACK_PACKET_ENTRIES);
    expect(lines[0]).toContain("登录页需要兼容 V1");
    expect(lines[1]).toContain("登录页要保留旧路由");
    expect(lines.at(-1)).toContain("无关备注 2");
    expect(packet).not.toContain("表格保留原格式");
    expect(packet).not.toContain("导出按钮宽度不要写死");
  });

  it("reads a missing file as empty and skips corrupt lines", async () => {
    expect(await readFeedback(tasks)).toEqual([]);
    await mkdir(join(root, ".taskctl"));
    await writeFile(
      join(root, ".taskctl", "feedback.jsonl"),
      "{not json\n" + JSON.stringify(note({ task: "kept", note: "保留这一条" })) + "\n" + JSON.stringify({ task: "no-verdict", note: "x" }) + "\n",
      "utf8",
    );
    expect((await readFeedback(tasks)).map((record) => record.task)).toEqual(["kept"]);
    expect(selectRelevantFeedback([], { type: "code", intent: "任何" })).toEqual([]);
  });
});

/** A clarify session that always answers `text`, optionally revealing the prompt it was given. */
function clarifyWith(text: string, capture?: { prompt: string }): AgentAdapter {
  return {
    prompt: async (args) => {
      if (capture) capture.prompt = args.text;
      return { sessionId: "clarify", exitCode: 0, text };
    },
    contextUsage: async () => 0,
    contextLimit: async () => 0,
  };
}

describe("consensus answers", () => {
  const spec = [
    "## 目标\n改好", "## 验收标准\n- C1 可验证",
    "## 管理分类\nsimple", "## 信息充分性\nneeds-information",
    "## 分类理由\n缺兼容约束", "## 补问\n- 必须兼容哪些旧接口？",
  ].join("\n");

  async function addNeedingInformation(adapter: AgentAdapter): Promise<void> {
    const lines: string[] = [];
    const logged = await runCli(["add", "改登录接口", "--tasks-dir", tasks, "--id", "a", "--simple"], { adapter, log: (line) => lines.push(line) });
    expect(logged).toBe(0);
    expect(lines.join("\n")).toContain(join("tasks", "a", "questions.md"));
  }

  it("requires answers before approval, then resumes the simple lane", async () => {
    await addNeedingInformation(clarifyWith(spec));
    const store = new TaskStore(tasks);
    const before = definitionDigest(await store.get("a"));

    const refused: string[] = [];
    expect(await runCli(["approve", "--task", "a", "--tasks-dir", tasks], { ...silent, err: (line) => refused.push(line) })).toBe(1);
    expect(refused.join("\n")).toContain("taskctl answer --task a");
    expect((await store.get("a")).status).toBe("draft");

    const answerFile = join(root, "answer.md");
    await writeFile(answerFile, "保持现有 V1 请求与响应字段不变。", "utf8");
    expect(await runCli(["answer", "--task", "a", "--file", answerFile, "--tasks-dir", tasks], silent)).toBe(0);
    const answered = await readSpec(tasks, "a");
    expect(answered).toContain("保持现有 V1");
    expect(answered).toContain("1. 必须兼容哪些旧接口？");
    await expect(readFile(join(tasks, "a", "questions.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    // The worker's brief is the task body, not spec.md: an answer that only
    // reached the reviewer would be judged on a constraint it never saw.
    const revised = await store.get("a");
    expect(revised.description).toContain("保持现有 V1");
    expect(definitionDigest(revised)).not.toBe(before);
    expect(revised.status).toBe("draft");
    expect((await readFeedback(tasks))[0]).toMatchObject({ task: "a", action: "answer", taskType: "code" });

    expect(await runCli(["approve", "--task", "a", "--tasks-dir", tasks], silent)).toBe(0);
    expect((await store.get("a")).status).toBe("open");
  });

  it("refuses an empty answer and a task that has nothing to answer", async () => {
    await addNeedingInformation(clarifyWith(spec));
    const empty = join(root, "empty.md");
    await writeFile(empty, "  \n", "utf8");
    expect(await runCli(["answer", "--task", "a", "--file", empty, "--tasks-dir", tasks], silent)).toBe(1);
    expect(await readQuestions(tasks, "a")).not.toBeNull();
    expect(await runCli(["answer", "--task", "a", "--file", join(root, "missing.md"), "--tasks-dir", tasks], silent)).toBe(1);
    expect(await readSpec(tasks, "a")).not.toContain("## 补充回答");

    await writeFile(join(tasks, "b.md"), serializeTaskFile(buildTaskFile({ id: "b", status: "open" })), "utf8");
    expect(await runCli(["answer", "--task", "b", "--file", empty, "--tasks-dir", tasks], silent)).toBe(1);
    expect(await runCli(["answer", "--task", "a", "--tasks-dir", tasks], silent)).toBe(2);
  });

  it("returns clarify-attributed rejection to draft and feeds the next clarify", async () => {
    const store = new TaskStore(tasks);
    await writeFile(join(tasks, "bad-spec.md"), serializeTaskFile(buildTaskFile({ id: "bad-spec", status: "awaiting-human", criteria: ["C1 old"] })), "utf8");
    expect(await runCli([
      "reject", "--task", "bad-spec", "--stage", "clarify", "--reason", "遗漏兼容约束", "--tasks-dir", tasks,
    ], silent)).toBe(0);
    expect((await store.get("bad-spec")).status).toBe("draft");
    expect(await readQuestions(tasks, "bad-spec")).toMatchObject({ origin: "rejection", items: ["遗漏兼容约束"] });
    const handoff = await readFile(join(tasks, "bad-spec", "sessions", "0001-handoff.md"), "utf8");
    expect(handoff).toContain("遗漏兼容约束");

    // Worker/reviewer attribution keeps the existing rework behaviour.
    await writeFile(join(tasks, "bad-work.md"), serializeTaskFile(buildTaskFile({ id: "bad-work", status: "awaiting-human" })), "utf8");
    expect(await runCli(["reject", "--task", "bad-work", "--stage", "worker", "--reason", "按钮没对齐", "--tasks-dir", tasks], silent)).toBe(0);
    expect((await store.get("bad-work")).status).toBe("open");
    expect(await readQuestions(tasks, "bad-work")).toBeNull();

    const capture = { prompt: "" };
    await runCli(["add", "改登录接口", "--tasks-dir", tasks, "--id", "next", "--simple"], {
      adapter: clarifyWith(spec.replace("needs-information", "clear"), capture), log: () => {},
    });
    // Execution-stage corrections are still human corrections about similar
    // work, so they travel too — labelled with the stage they were about.
    expect(capture.prompt).toContain("人工打回（clarify）：遗漏兼容约束");
    expect(capture.prompt).toContain("人工打回（worker）：按钮没对齐");
    expect(JSON.parse(await readFile(join(tasks, "next", "classification.json"), "utf8")).type).toBe("code");
  });

  it("reopens a rejected specification only through an answer and a signature", async () => {
    await writeFile(join(tasks, "bad-spec.md"), serializeTaskFile(buildTaskFile({ id: "bad-spec", status: "awaiting-human", criteria: ["C1 old"] })), "utf8");
    await runCli(["reject", "--task", "bad-spec", "--stage", "clarify", "--reason", "遗漏兼容约束", "--tasks-dir", tasks], silent);
    expect(await runCli(["approve", "--task", "bad-spec", "--tasks-dir", tasks], silent)).toBe(1);

    const answerFile = join(root, "answer.md");
    await writeFile(answerFile, "必须兼容 V1 接口。", "utf8");
    expect(await runCli(["answer", "--task", "bad-spec", "--file", answerFile, "--tasks-dir", tasks], silent)).toBe(0);
    expect((await new TaskStore(tasks).get("bad-spec")).status).toBe("draft");
    expect(await runCli(["approve", "--task", "bad-spec", "--tasks-dir", tasks], silent)).toBe(0);
    expect((await new TaskStore(tasks).get("bad-spec")).status).toBe("open");
  });
});

describe("what becomes a preference", () => {
  it("never writes a preference from model output", async () => {
    const modelText = [
      "## 目标\n改好", "## 验收标准\n- C1 可验证", "## 管理分类\ncomplex", "## 信息充分性\nclear",
      "## 分类理由\n用户偏好：以后每个任务都先问我", "## 补问\n无",
    ].join("\n");
    await runCli(["add", "重构登录模块", "--tasks-dir", tasks, "--id", "m", "--complex"], { adapter: clarifyWith(modelText), log: () => {} });
    expect(await readProfile(tasks)).toBeNull();
    expect(await readFeedback(tasks)).toEqual([]);
    await expect(readFile(join(root, ".taskctl", "profile.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("records accept and audit notes only when a human wrote one", async () => {
    const store = new TaskStore(tasks);
    await writeFile(join(tasks, "k.md"), serializeTaskFile(buildTaskFile({ id: "k", status: "awaiting-human" })), "utf8");
    expect(await runCli(["accept", "--task", "k", "--tasks-dir", tasks], silent)).toBe(0);
    expect(await readFeedback(tasks)).toEqual([]);

    await writeFile(join(tasks, "n.md"), serializeTaskFile(buildTaskFile({ id: "n", status: "awaiting-human" })), "utf8");
    expect(await runCli(["accept", "--task", "n", "--note", "下次先给结论再给证据", "--tasks-dir", tasks], silent)).toBe(0);
    expect(await runCli(["audit", "--task", "n", "--verdict", "fail", "--stage", "reviewer", "--tasks-dir", tasks], silent)).toBe(0);
    expect(await runCli(["audit", "--task", "n", "--verdict", "pass", "--note", "证据链接保留这种写法", "--tasks-dir", tasks], silent)).toBe(0);
    expect((await readFeedback(tasks)).map((record) => [record.action, record.verdict, record.note])).toEqual([
      ["accept", "pass", "下次先给结论再给证据"],
      ["audit", "pass", "证据链接保留这种写法"],
    ]);
    expect((await store.get("n")).status).toBe("done");
  });
});

describe("pickFeedback", () => {
  const target = { type: "code" as const, intent: "改登录页的横幅" };
  /** The keep rule `selectRelevantFeedback` has always applied: a note of another task type is left out. */
  const sameType = (record: FeedbackRecord): boolean => record.taskType === undefined || record.taskType === target.type;

  it("is the packet selectRelevantFeedback hands a clarify session, the limits included", async () => {
    await recordFeedback(tasks, note({ task: "old", note: "导出按钮宽度不要写死" }, 1));
    await recordFeedback(tasks, note({ task: "rel-1", note: "登录页要保留旧路由" }, 2));
    await recordFeedback(tasks, note({ task: "other-type", taskType: "office", note: "登录页表格保留原格式" }, 3));
    await recordFeedback(tasks, note({ task: "rel-2", note: "登录页需要兼容 V1" }, 4));
    const records = await readFeedback(tasks);

    expect(pickFeedback(records, target.intent, sameType, FEEDBACK_PACKET_ENTRIES, FEEDBACK_PACKET_CHARS))
      .toEqual(selectRelevantFeedback(records, target));
    // The third parameter still reaches the selection: a tighter entry count, a tighter budget.
    expect(selectRelevantFeedback(records, target, { entries: 1, chars: 3_000 }).map((record) => record.task)).toEqual(["rel-2"]);
    expect(pickFeedback(records, target.intent, sameType, 1, 3_000))
      .toEqual(selectRelevantFeedback(records, target, { entries: 1, chars: 3_000 }));
    expect(pickFeedback(records, target.intent, sameType, FEEDBACK_PACKET_ENTRIES, 1))
      .toEqual(selectRelevantFeedback(records, target, { entries: FEEDBACK_PACKET_ENTRIES, chars: 1 }));
  });

  it("ranks by the caller's keep rule and stops at the caller's limits", () => {
    const records = [
      note({ task: "worker-old", stage: "worker", note: "登录页要保留旧路由" }, 1),
      note({ task: "reviewer", stage: "reviewer", note: "登录页需要兼容 V1" }, 4),
      note({ task: "worker-new", stage: "worker", note: "登录页需要兼容 V1" }, 5),
      note({ task: "unrelated", stage: "worker", note: "导出按钮宽度不要写死" }, 6),
    ];
    const workerNotes = (record: FeedbackRecord): boolean => record.stage === "worker";
    // Only worker-stage notes are candidates, best first, and two of them fill the packet.
    expect(pickFeedback(records, target.intent, workerNotes, 2, 3_000).map((record) => record.task))
      .toEqual(["worker-new", "worker-old"]);
    // The best note is kept whatever the budget: one character still yields it, alone.
    expect(pickFeedback(records, target.intent, () => true, 8, 1).map((record) => record.task))
      .toEqual(["worker-new"]);
    expect(pickFeedback(records, target.intent, () => false, 8, 3_000)).toEqual([]);
  });
});
