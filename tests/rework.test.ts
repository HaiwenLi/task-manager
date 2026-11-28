vi.mock("../src/render.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/render.js")>();
  return { ...actual, checkRender: vi.fn() };
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "../src/task-store.js";
import { runTask, WRAP_UP_INSTRUCTION, type WorkerConfig } from "../src/worker.js"; // WRAP_UP_INSTRUCTION: T7
import type { AgentAdapter } from "../src/adapters/types.js";
import type { AcceptanceResult } from "../src/acceptance.js";
import type { ReviewResult } from "../src/review.js";
import { latestNote, writeNote } from "../src/handoff.js"; // writeNote: T7
import { readJournal } from "../src/journal.js";
import { serializeTaskFile } from "../src/task-file.js";
import type { Task } from "../src/task-file.js";
import { buildTaskFile } from "./helpers/task-fixture.js";
import { PROBLEM_TEXT, checkRender } from "../src/render.js"; // T5
import {
  REWORK_FILE, REWORK_OUTPUT_CHARS, readRwork, renderRwork, reworkPathOf, type ReworkFeedback,
} from "../src/rework.js";
import { artifactDigest } from "../src/workspace.js";
import { writeRuntime, writeRuntimeText } from "../src/runtime.js";
import { runCli } from "../src/cli.js"; // T7
import { retryTask } from "../src/reconcile.js"; // T7

let root: string;
let tasks: string;
let work: string;
let store: TaskStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "taskctl-rework-"));
  tasks = join(root, "tasks");
  work = join(root, "work");
  await mkdir(tasks);
  await mkdir(work);
  store = new TaskStore(tasks);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

const reworkPath = (): string => reworkPathOf(tasks, "a");
/** How the rework line names the file: 先读, then the absolute path in backticks. */
const pointer = (): string => `先读 \`${reworkPath()}\``;

function config(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return { tasksDir: tasks, workdir: work, agent: "fixture", contextThreshold: 0.8, retryLimit: 3, lockTtlMs: 5_000, heartbeatMs: 50, ...overrides };
}

async function seed(overrides: Partial<Task> = {}): Promise<void> {
  await writeFile(join(tasks, "a.md"), serializeTaskFile(buildTaskFile({
    id: "a", title: "任务 A", status: "open", acceptance: "npm test", criteria: ["C1 ok", "C2 fine"], ...overrides,
  })), "utf8");
}

const failed: AcceptanceResult = { passed: false, exitCode: 1, output: "断言失败： expected 2, got 1", skipped: false };
const passed: AcceptanceResult = { passed: true, exitCode: 0, output: "ok", skipped: false };
const passVerdict: ReviewResult = {
  verdict: "pass", criteria: [{ id: "C1", pass: true, evidence: "ok" }, { id: "C2", pass: true, evidence: "ok" }],
  externalChanges: [], defects: [], summary: "ok",
};
const failVerdict: ReviewResult = {
  verdict: "fail", criteria: [{ id: "C1", pass: false, evidence: "读了 src/a.ts，看到宽度写死" }, { id: "C2", pass: true, evidence: "ok" }],
  externalChanges: [], defects: ["🔴 宽度改为自适应"], summary: "未达 C1",
};

/** An acceptance gate: the first run answers `results[0]`, the second `results[1]`, every later one the last. */
function gate(...results: AcceptanceResult[]): (command: string, cwd: string) => Promise<AcceptanceResult> {
  let runs = 0;
  return async () => results[Math.min(runs++, results.length - 1)]!;
}

/** A reviewer: the first turn answers `verdicts[0]`, the second `verdicts[1]`, every later one the last. */
function judge(...verdicts: ReviewResult[]): () => Promise<ReviewResult> {
  let rounds = 0;
  return async () => verdicts[Math.min(rounds++, verdicts.length - 1)]!;
}

type PromptArgs = Parameters<AgentAdapter["prompt"]>[0];
type PromptResult = Awaited<ReturnType<AgentAdapter["prompt"]>>;
type Turn = { text: string; sessionId: string | undefined; model: string | undefined; rework: string | null };

/**
 * A worker that records, at the start of every turn, what it was given — the
 * prompt, the session, the model, and whether `rework.md` was on disk — and
 * then requests completion. `script` may answer a turn differently, `usage`
 * is what the context probe reports for a session, `text` is the default reply.
 */
function recorder(
  script: (turn: number, args: PromptArgs) => PromptResult | undefined | Promise<PromptResult | undefined> = () => undefined,
  usage: (sessionId: string) => number = () => 0,
  text = "done",
): { turns: Turn[]; adapter: AgentAdapter } {
  const turns: Turn[] = [];
  const adapter: AgentAdapter = {
    prompt: async (args) => {
      const turn = turns.push({
        text: args.text, sessionId: args.sessionId, model: args.model,
        rework: await readFile(reworkPath(), "utf8").catch(() => null),
      });
      const answer = await script(turn, args);
      if (answer !== undefined) return answer;
      await mkdir(join(tasks, "a"), { recursive: true });
      await writeFile(join(tasks, "a", "done.requested"), "done");
      return { sessionId: "s", text, exitCode: 0 };
    },
    contextUsage: async (sessionId) => usage(sessionId),
    contextLimit: async () => 100,
  };
  return { turns, adapter };
}

describe("renderRwork", () => {
  const base = { task: { id: "a", title: "任务 A" }, tasksDir: "T", at: "2026-11-25T10:00:00.000Z" };
  const text = (...lines: string[]) => `${lines.join("\n")}\n`;
  const header = ["# 返工说明：任务 A（a）", "", "写于 2026-11-25T10:00:00.000Z。上一回合没有通过：先读完这份说明，再动手。", ""];
  const done = '- 改完后请求完成：taskctl done --task a --tasks-dir "T"';
  const acceptance: ReworkFeedback = { kind: "acceptance", command: "npm test", exitCode: 1, output: "断言失败： expected 2, got 1" };

  it("tells an acceptance failure from the exit code, the command and the output, and says what to do", () => {
    expect(renderRwork({ ...base, feedback: acceptance })).toBe(text(
      ...header,
      "## 上一回合为什么没有通过",
      "",
      "控制器的验收命令失败了（exit 1）。验收命令退出 0，任务才能进入下一步。",
      "",
      "验收命令：npm test",
      "",
      "验收输出：",
      "",
      "断言失败： expected 2, got 1",
      "",
      "## 需要改变什么",
      "",
      "- 按上面的验收输出修复；输出被截断时，先读完整的验收记录再判断。",
      "- 先做有界的定向自验（任务声明了 worker_self_check 就用 taskctl check），不要反复重跑全量验收。",
      done,
    ));
  });

  it("says a gate that could not start as exit null, and a silent one as silent", () => {
    const doc = renderRwork({ ...base, feedback: { kind: "acceptance", command: "npm test", exitCode: null, output: "" } });
    expect(doc).toContain("控制器的验收命令失败了（exit null）。");
    expect(doc).toContain("验收命令没有留下任何输出。");
    expect(doc).not.toContain("验收输出：");
  });

  it("says an output of only whitespace as silent", () => {
    const doc = renderRwork({ ...base, feedback: { kind: "acceptance", command: "npm test", exitCode: 1, output: " \r\n\t\n" } });
    expect(doc).toContain("验收命令没有留下任何输出。");
    expect(doc).not.toContain("验收输出：");
  });

  it("keeps the tail of a long acceptance output and says where the whole of it is", () => {
    const output = `${"头".repeat(5_000)}${"尾".repeat(1_500)}`;
    const doc = renderRwork({ ...base, feedback: { kind: "acceptance", command: "npm test", exitCode: 1, output } });
    expect(doc).toContain("尾".repeat(1_500));
    expect(doc).not.toContain("头".repeat(2_501));
    expect(doc).toContain(
      `验收输出（只保留结尾 ${REWORK_OUTPUT_CHARS} 个字符，前面省略 2500 个字符；`
      + `完整输出在 ${join("T", "a", "acceptance.json")} 的 output 字段，被 taskctl retry 归档后在 ${join("T", "a", "archive")} 下）：`,
    );
  });

  it("counts code points, not UTF-16 units, when it cuts", () => {
    const output = `x${"😀".repeat(REWORK_OUTPUT_CHARS + 1)}`;
    const doc = renderRwork({ ...base, feedback: { kind: "acceptance", command: "npm test", exitCode: 1, output } });
    expect(doc).toContain("😀".repeat(REWORK_OUTPUT_CHARS));
    expect(doc).toContain("前面省略 2 个字符");
    expect(doc).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  it("turns CRLF and CR into LF and changes nothing else in the output", () => {
    const doc = renderRwork({ ...base, feedback: { kind: "acceptance", command: "npm test", exitCode: 1, output: "a\r\nb\rc  two  spaces" } });
    expect(doc).toContain("\n\na\nb\nc  two  spaces\n\n");
  });

  it("lists each failed criterion with the reviewer's evidence, then the defects to fix", () => {
    const feedback: ReworkFeedback = {
      kind: "review", round: 2, summary: "未达 C1",
      failed: [{ id: "C1", pass: false, evidence: "读了 src/a.ts，看到宽度写死" }],
      defects: ["🔴 宽度改为自适应", "🟡 文案不一致"],
    };
    expect(renderRwork({ ...base, feedback })).toBe(text(
      ...header,
      "## 上一回合为什么没有通过",
      "",
      "独立复核没有通过（第 2 轮）：未达 C1",
      "",
      "没有通过的验收标准，以及复核者看到的依据：",
      "",
      "- C1：读了 src/a.ts，看到宽度写死",
      "",
      "## 需要改变什么",
      "",
      "- 🔴 宽度改为自适应",
      "- 🟡 文案不一致",
      done,
    ));
  });

  it("says so when the reviewer gave no summary, no evidence or no defects", () => {
    const doc = renderRwork({ ...base, feedback: { kind: "review", round: 1, summary: "", failed: [{ id: "C2", pass: false, evidence: "" }], defects: [] } });
    expect(doc).toContain("独立复核没有通过（第 1 轮）：复核未通过");
    expect(doc).toContain("- C2：（复核者没有给出依据）");
    expect(doc).toContain("- 按上面没有通过的验收标准返工。");
  });

  it("cuts one piece of reviewer evidence or one defect at a thousand characters", () => {
    const doc = renderRwork({
      ...base,
      feedback: { kind: "review", round: 1, summary: "s", failed: [{ id: "C1", pass: false, evidence: "证".repeat(1_200) }], defects: ["缺".repeat(1_200)] },
    });
    expect(doc).toContain(`- C1：${"证".repeat(1_000)}…`);
    expect(doc).toContain(`- ${"缺".repeat(1_000)}…`);
    expect(doc).not.toContain("证".repeat(1_001));
  });

  it("names each view that failed the render check and where its screenshot is", () => {
    const failures = ["W\\index.html @ 390x844: 横向溢出：页面比视口宽，内容被裁掉或需要横向滚动"];
    expect(renderRwork({ ...base, feedback: { kind: "render", failures } })).toBe(text(
      ...header,
      "## 上一回合为什么没有通过",
      "",
      "渲染验收失败：下面的页面在下面的视口上，没有同时做到画得出来、有可读内容、不横向溢出、没有未捕获异常。",
      "",
      "- W\\index.html @ 390x844: 横向溢出：页面比视口宽，内容被裁掉或需要横向滚动",
      "",
      "## 需要改变什么",
      "",
      `- 修到每个目标页面在每个视口上都满足上面四条。失败那一屏的截图在 ${join("T", "a", "evidence")}，先看它。`,
      done,
    ));
  });

  it("tells a turn that did not ask to be judged why that matters and what to do, and keeps the reasons it was already sent back for", () => {
    const why = "上一回合正常结束，但没有请求完成（没有运行 taskctl done）。连续执行的任务本应在一个回合内做完并请求验收；没有做到，任务已升级为迭代执行（iterative）。控制器没有可以验收的成果。";
    expect(renderRwork({ ...base, feedback: { kind: "no-completion", why, previous: null } })).toBe(text(
      ...header,
      "## 上一回合为什么没有通过",
      "",
      why,
      "",
      "## 需要改变什么",
      "",
      `- 已经做完：请求完成，taskctl done --task a --tasks-dir "T"`,
      "- 还没做完：继续做，并用 taskctl note 记下现状、卡点和下一步。",
      "- 任务比声明的更大：单独输出一行 ESCALATE: <原因>。",
    ));
    const carried = renderRwork({ ...base, feedback: { kind: "no-completion", why, previous: acceptance } });
    expect(carried).toContain("## 仍然适用的上一轮否决\n\n## 上一回合为什么没有通过\n\n控制器的验收命令失败了（exit 1）。");
    expect(carried.match(/^# /gm)).toHaveLength(1);
    expect(carried.match(/## 仍然适用的上一轮否决/g)).toHaveLength(1);
  });

  it("carries a document written by an earlier attempt under one heading", () => {
    const earlier = renderRwork({ ...base, at: "2026-11-25T09:00:00.000Z", feedback: acceptance });
    expect(renderRwork({ ...base, feedback: { kind: "carried", markdown: earlier } }))
      .toBe(earlier.replace("写于 2026-11-25T09:00:00.000Z", "写于 2026-11-25T10:00:00.000Z"));
  });

  it("carries a document with no heading whole, not just its last line", () => {
    // Only a hand-edited rework.md can lack a `## ` heading; dropping all but
    // the last line would silently lose the rest of it.
    const rendered = renderRwork({ ...base, feedback: { kind: "carried", markdown: "第一行\n第二行\n" } });
    expect(rendered).toContain("第一行\n第二行");
  });

  it("adds the worker's own ESCALATE reason when it gave one, after everything else", () => {
    const doc = renderRwork({
      ...base, feedback: { kind: "no-completion", why: "没有请求完成。", previous: null }, escalation: "产物从一张表变成了三张",
    });
    expect(doc.endsWith(
      "## 需要改变什么\n\n- 已经做完：请求完成，taskctl done --task a --tasks-dir \"T\"\n"
      + "- 还没做完：继续做，并用 taskctl note 记下现状、卡点和下一步。\n"
      + "- 任务比声明的更大：单独输出一行 ESCALATE: <原因>。\n\n"
      + "## 你在上一回合提出的升级\n\nESCALATE: 产物从一张表变成了三张\n\n"
      + "本任务因此升级为迭代执行：此后必须经过独立复核，不能再用自己的证据收尾。\n",
    )).toBe(true);
  });
});

describe("rework.md on disk", () => {
  it("writeRuntimeText writes text verbatim, replaces what was there, and leaves no temp file", async () => {
    await mkdir(join(tasks, "a"));
    await writeRuntimeText(tasks, "a", REWORK_FILE, "# 一\n\nbody\r\n");
    expect(await readFile(reworkPathOf(tasks, "a"), "utf8")).toBe("# 一\n\nbody\r\n");
    await writeRuntimeText(tasks, "a", REWORK_FILE, "# 二\n");
    expect(await readRwork(tasks, "a")).toBe("# 二\n");
    expect(await readRwork(tasks, "nobody")).toBeNull();
    expect(await readdir(join(tasks, "a"))).toEqual([REWORK_FILE]);
  });

  it("writeRuntime lands the same way", async () => {
    await mkdir(join(tasks, "a"));
    await writeRuntime(tasks, "a", "x.json", { b: [1] });
    expect(JSON.parse(await readFile(join(tasks, "a", "x.json"), "utf8"))).toEqual({ b: [1] });
    expect(await readdir(join(tasks, "a"))).toEqual(["x.json"]);
  });

  it("sits outside the artifact digest", async () => {
    // The tasks directory inside the workspace is excluded from the digest the
    // acceptance gate compares; the document must not be able to invalidate evidence.
    const inside = join(work, "tasks");
    await mkdir(join(inside, "a"), { recursive: true });
    await writeFile(join(work, "src.txt"), "source", "utf8");
    const before = await artifactDigest(work, [inside]);
    await writeRuntimeText(inside, "a", REWORK_FILE, "# 返工说明\n");
    expect(await artifactDigest(work, [inside])).toBe(before);
    // Control: the file is real, and would count from anywhere else in the tree.
    expect(await artifactDigest(work)).not.toBe(before);
  });
});

describe("an acceptance failure", () => {
  it("is written to rework.md before the rework turn, and that turn — not the first — is pointed at it", async () => {
    await seed();
    const { turns, adapter } = recorder();

    expect(await runTask(config(), { store, adapter, acceptance: gate(failed, passed), review: async () => passVerdict }, await store.get("a"), "w1")).toBe("done");

    expect(turns.map((turn) => turn.sessionId)).toEqual([undefined, "s"]);
    expect(turns[0]!.rework).toBeNull();
    expect(turns[0]!.text).not.toContain("rework.md");
    expect(turns[1]!.text).toContain(pointer());
    // One line pointing at the file: the document itself is not in the prompt.
    expect(turns[1]!.text).not.toContain("返工说明");
    expect(turns[1]!.text).not.toContain("## 需要改变什么");
    expect(turns[1]!.rework).toContain("# 返工说明：任务 A（a）");
    expect(turns[1]!.rework).toContain("控制器的验收命令失败了（exit 1）。");
    expect(turns[1]!.rework).toContain("验收命令：npm test");
    expect(turns[1]!.rework).toContain("断言失败： expected 2, got 1");
    expect(turns[1]!.rework).toContain(`taskctl done --task a --tasks-dir "${tasks}"`);
  });

  it("still writes the acceptance-failed handoff note it wrote before", async () => {
    await seed();
    const { adapter } = recorder();
    await runTask(config(), { store, adapter, acceptance: gate(failed, passed), review: async () => passVerdict }, await store.get("a"), "w1");
    const note = await latestNote(tasks, "a");
    expect(note?.markdown).toContain("## Status\nacceptance-failed");
    expect(note?.markdown).toContain("断言失败： expected 2, got 1");
  });

  it("is written for a continuous task as well, after its escalation", async () => {
    await seed({ complexity: "simple", execution: "continuous" });
    const { turns, adapter } = recorder();
    expect(await runTask(config(), { store, adapter, acceptance: gate(failed, passed), review: async () => passVerdict }, await store.get("a"), "w1")).toBe("done");
    expect(turns[1]!.rework).toContain("验收命令：npm test");
    expect(turns[1]!.text).toContain(pointer());
    expect((await readJournal(tasks, "a")).some((line) => line.event === "escalated")).toBe(true);
  });

  it("is written again before a turn that follows a crashed rework turn", async () => {
    // The rework turn dies (exit 1) and the document is lost with it. Nothing
    // new was rejected, so the turn after it is pointed at the same document.
    await seed();
    const { turns, adapter } = recorder(async (turn) => {
      if (turn !== 2) return undefined;
      await rm(reworkPath(), { force: true });
      return { sessionId: "s", text: "进程崩了", exitCode: 1 };
    });
    expect(await runTask(config(), { store, adapter, acceptance: gate(failed, passed), review: async () => passVerdict }, await store.get("a"), "w1")).toBe("done");
    expect(turns).toHaveLength(3);
    expect(turns[2]!.rework).toContain("控制器的验收命令失败了（exit 1）。");
    expect(turns[2]!.text).toContain(pointer());
  });
});

describe("a failed review", () => {
  it("is written to rework.md with each failed criterion, the reviewer's evidence and the defects, and the review note stays", async () => {
    await seed();
    const { turns, adapter } = recorder();

    expect(await runTask(config(), { store, adapter, acceptance: gate(passed), review: judge(failVerdict, passVerdict) }, await store.get("a"), "w1")).toBe("done");

    expect(turns[1]!.rework).toContain("独立复核没有通过（第 1 轮）：未达 C1");
    expect(turns[1]!.rework).toContain("- C1：读了 src/a.ts，看到宽度写死");
    expect(turns[1]!.rework).not.toContain("C2：");
    expect(turns[1]!.rework).toContain("- 🔴 宽度改为自适应");
    expect(turns[1]!.rework).toContain(`taskctl done --task a --tasks-dir "${tasks}"`);
    expect(turns[1]!.text).toContain(pointer());
    const note = await latestNote(tasks, "a");
    expect(note?.markdown).toContain("## Status\nreview-failed");
    expect(note?.markdown).toContain("🔴 宽度改为自适应");
  });

  it("writes nothing for a verdict that blocks the task instead of sending it back", async () => {
    await seed();
    const { turns, adapter } = recorder();
    expect(await runTask(config({ maxReviewRounds: 0 }), { store, adapter, acceptance: gate(passed), review: judge(failVerdict) }, await store.get("a"), "w1")).toBe("blocked");
    expect(turns).toHaveLength(1);
    expect(await readRwork(tasks, "a")).toBeNull();
  });
});

describe("a failed render check", () => {
  const view = (viewport: string, problems: string[]) => ({
    target: join(work, "index.html"), viewport, ok: problems.length === 0, problems,
    screenshot: join(tasks, "a", "evidence", `index-${viewport}.png`),
    measurements: { scrollWidth: 900, clientWidth: 390, textLength: 20, images: 0, brokenImages: 0 },
  });

  it("is written to rework.md — the only feedback a render failure has ever left — and the turn is pointed at it", async () => {
    await writeFile(join(tasks, "a.md"), serializeTaskFile(buildTaskFile({ id: "a", title: "任务 A", status: "open", verify: "render", renderTargets: ["index.html"] })), "utf8");
    vi.mocked(checkRender).mockReset()
      .mockResolvedValueOnce({ ok: false, browser: "fake", at: "2026-11-25T10:00:00.000Z", views: [view("390x844", ["overflow"]), view("1440x900", ["script-error"])] })
      .mockResolvedValue({ ok: true, browser: "fake", at: "2026-11-25T10:00:01.000Z", views: [view("1440x900", [])] });
    const { turns, adapter } = recorder();

    expect(await runTask(config(), { store, adapter }, await store.get("a"), "w1")).toBe("done");

    expect(turns[1]!.rework).toContain("渲染验收失败");
    expect(turns[1]!.rework).toContain(`${join(work, "index.html")} @ 390x844: ${PROBLEM_TEXT.overflow}`);
    expect(turns[1]!.rework).toContain(`${join(work, "index.html")} @ 1440x900: ${PROBLEM_TEXT["script-error"]}`);
    expect(turns[1]!.rework).toContain(join(tasks, "a", "evidence"));
    expect(turns[1]!.text).toContain(pointer());
    expect(await latestNote(tasks, "a")).toBeNull();
  });

  it("writes nothing when the retry budget, not the worker, ends the attempt", async () => {
    // The document is tied to the rework turn that follows, not to the verdict.
    await writeFile(join(tasks, "a.md"), serializeTaskFile(buildTaskFile({ id: "a", title: "任务 A", status: "open", verify: "render", renderTargets: ["index.html"] })), "utf8");
    vi.mocked(checkRender).mockReset().mockResolvedValue({ ok: false, browser: "fake", at: "2026-11-25T10:00:00.000Z", views: [view("390x844", ["overflow"])] });
    const { turns, adapter } = recorder();
    expect(await runTask(config({ retryLimit: 1 }), { store, adapter }, await store.get("a"), "w1")).toBe("blocked");
    expect(turns).toHaveLength(1);
    expect(await readRwork(tasks, "a")).toBeNull();
  });
});

describe("a turn that ends without a completion request", () => {
  const noCompletion = { sessionId: "s", text: "还在做", exitCode: 0 };

  it("a continuous task's first turn that does not request completion is told why before the next turn", async () => {
    await seed({ complexity: "simple", execution: "continuous" });
    const { turns, adapter } = recorder((turn) => (turn === 1 ? noCompletion : undefined));

    expect(await runTask(config(), { store, adapter, acceptance: gate(passed), review: async () => passVerdict }, await store.get("a"), "w1")).toBe("done");

    expect(turns).toHaveLength(2);
    expect(turns[0]!.rework).toBeNull();
    expect(turns[1]!.rework).toContain("没有请求完成（没有运行 taskctl done）");
    expect(turns[1]!.rework).toContain("升级为迭代执行（iterative）");
    expect(turns[1]!.text).toContain(pointer());
    expect((await readJournal(tasks, "a")).some((line) => line.event === "escalated")).toBe(true);
  });

  it("an iterative task working turn by turn is not told it did not pass", async () => {
    await seed();
    const { turns, adapter } = recorder((turn) => (turn === 1 ? noCompletion : undefined));

    expect(await runTask(config(), { store, adapter, acceptance: gate(passed), review: async () => passVerdict }, await store.get("a"), "w1")).toBe("done");

    expect(turns).toHaveLength(2);
    expect(turns[1]!.rework).toBeNull();
    expect(turns[1]!.text).not.toContain("rework.md");
    expect(turns[1]!.text).not.toContain("上一回合没有通过");
  });

  it("a session whose turn budget runs out is told so in the session that replaces it", async () => {
    await seed();
    const { turns, adapter } = recorder((turn) => (turn <= 2 ? noCompletion : undefined));

    expect(await runTask(config({ maxTurnsPerSession: 2 }), { store, adapter, acceptance: gate(passed), review: async () => passVerdict }, await store.get("a"), "w1")).toBe("done");

    expect(turns.map((turn) => turn.sessionId)).toEqual([undefined, "s", undefined]);
    expect(turns[1]!.rework).toBeNull();
    expect(turns[2]!.rework).toContain("本会话的 2 个回合已用完，仍没有请求完成（没有运行 taskctl done）");
    expect(turns[2]!.text).toContain(pointer());
  });

  it("keeps the reasons of a rejection the session was already working on", async () => {
    await seed();
    const { turns, adapter } = recorder((turn) => (turn === 2 || turn === 3 ? noCompletion : undefined));

    expect(await runTask(config({ maxTurnsPerSession: 2 }), { store, adapter, acceptance: gate(failed, passed), review: async () => passVerdict }, await store.get("a"), "w1")).toBe("done");

    // Turn 1 fails the gate (a document); turn 2 exhausts the budget on top of it.
    expect(turns[2]!.rework).toContain("本会话的 2 个回合已用完");
    expect(turns[2]!.rework).toContain("## 仍然适用的上一轮否决");
    expect(turns[2]!.rework).toContain("断言失败： expected 2, got 1");
    // Turn 3 is ordinary progress again: the same document, not a third layer.
    expect(turns[3]!.rework!.match(/## 仍然适用的上一轮否决/g)).toHaveLength(1);
    expect(turns[3]!.rework).toContain("本会话的 2 个回合已用完");
  });
});

describe("the worker's own ESCALATE reason", () => {
  it("is written into the document when the worker escalates in a turn that does not request completion", async () => {
    await seed();
    const { turns, adapter } = recorder((turn) => (turn === 1 ? { sessionId: "s", text: "范围比预想大\nESCALATE: 产物从一张表变成了三张", exitCode: 0 } : undefined));

    expect(await runTask(config(), { store, adapter, acceptance: gate(passed), review: async () => passVerdict }, await store.get("a"), "w1")).toBe("done");

    expect(turns[1]!.rework).toContain("没有请求完成（没有运行 taskctl done）；你在这一回合里把任务升级了");
    expect(turns[1]!.rework).toContain("## 你在上一回合提出的升级");
    expect(turns[1]!.rework).toContain("ESCALATE: 产物从一张表变成了三张");
    expect(turns[1]!.rework).toContain("此后必须经过独立复核");
    expect(turns[1]!.text).toContain(pointer());
  });

  it("travels with a later rejection in the same attempt", async () => {
    // Turn 1 escalates and asks to be judged; the gate fails. The document
    // says why the gate failed and repeats the worker's own reason.
    await seed();
    const { turns, adapter } = recorder(undefined, undefined, "ESCALATE: 产物从一张表变成了三张");

    expect(await runTask(config(), { store, adapter, acceptance: gate(failed, passed), review: async () => passVerdict }, await store.get("a"), "w1")).toBe("done");

    expect(turns[1]!.rework).toContain("验收命令：npm test");
    expect(turns[1]!.rework).toContain("## 你在上一回合提出的升级");
    expect(turns[1]!.rework).toContain("ESCALATE: 产物从一张表变成了三张");
  });

  it("writes nothing by itself when the worker escalates and passes", async () => {
    await seed({ complexity: "simple", execution: "continuous" });
    const { turns, adapter } = recorder(undefined, undefined, "ESCALATE: 产物从一张表变成了三张");
    expect(await runTask(config(), { store, adapter, acceptance: gate(passed), review: async () => passVerdict }, await store.get("a"), "w1")).toBe("done");
    expect(turns).toHaveLength(1);
    expect(await readRwork(tasks, "a")).toBeNull();
  });

  it("is told to the session that replaces one the worker escalated and overfilled", async () => {
    await seed();
    // Turn 1 escalates, does not request completion, and leaves the session over
    // budget: the wrap-up follows, and the new session needs both the handoff
    // note and the document.
    let work = 0;
    const { turns, adapter } = recorder(async (turn, args) => {
      if (args.text === WRAP_UP_INSTRUCTION) {
        await writeNote(tasks, { task: "a", seq: 2, status: "进行中；预算告急", done: "范围比预想大", found: "产物从一张表变成了三张", next: "继续做", files: [] });
        return { sessionId: args.sessionId!, text: "HANDOFF_READY", exitCode: 0 };
      }
      work += 1;
      return work === 1 ? { sessionId: "s", text: "范围比预想大\nESCALATE: 产物从一张表变成了三张", exitCode: 0 } : undefined;
    }, (sessionId) => (sessionId === "s" && work >= 1 ? 900_000 : 0));

    expect(await runTask(config({ model: "w/one" }), { store, adapter, acceptance: gate(passed), review: async () => passVerdict }, await store.get("a"), "w1")).toBe("done");

    expect(turns.map((turn) => turn.sessionId)).toEqual([undefined, "s", undefined]);
    expect(turns[1]!.text).toBe(WRAP_UP_INSTRUCTION);
    expect(turns[2]!.rework).toContain("你在这一回合里把任务升级了");
    expect(turns[2]!.rework).toContain("## 你在上一回合提出的升级");
    expect(turns[2]!.rework).toContain("ESCALATE: 产物从一张表变成了三张");
    expect(turns[2]!.text).toContain(pointer());
    expect(turns[2]!.text).toContain("范围比预想大");
  });

  it("is not told to the next session when an ordinary turn overfills it", async () => {
    await seed();
    // The control: no escalation, so the wrap-up leaves nothing for the worker to be told.
    let work = 0;
    const { turns, adapter } = recorder(async (turn, args) => {
      if (args.text === WRAP_UP_INSTRUCTION) {
        await writeNote(tasks, { task: "a", seq: 1, status: "进行中", done: "做了一半", found: "无", next: "继续做", files: [] });
        return { sessionId: args.sessionId!, text: "HANDOFF_READY", exitCode: 0 };
      }
      work += 1;
      return work === 1 ? { sessionId: "s", text: "还在做", exitCode: 0 } : undefined;
    }, (sessionId) => (sessionId === "s" && work >= 1 ? 900_000 : 0));

    expect(await runTask(config({ model: "w/one" }), { store, adapter, acceptance: gate(passed), review: async () => passVerdict }, await store.get("a"), "w1")).toBe("done");

    expect(turns.map((turn) => turn.sessionId)).toEqual([undefined, "s", undefined]);
    expect(turns[2]!.rework).toBeNull();
    expect(turns[2]!.text).not.toContain("rework.md");
    expect(turns[2]!.text).toContain("做了一半");
  });
});

describe("a rework owed beyond the turn that follows", () => {
  const providerRefusal: ReviewResult = { verdict: "unclear", criteria: [], externalChanges: [], defects: [], summary: "provider quota refused", failure: "provider" };
  const refusal: PromptResult = { sessionId: "", exitCode: 1, text: "weekly limit reached", failure: "provider", tokens: 0 };

  it("survives a model switch: the session opened on the next model is pointed at the same document", async () => {
    await seed();
    const { turns, adapter } = recorder((turn, args) => (turn === 2 && args.model === "w/one" ? refusal : undefined));
    const cfg = config({ model: "w/one", modelFallbacks: ["q/two"], quotaBackoffMs: [0] });

    expect(await runTask(cfg, { store, adapter, acceptance: gate(failed, passed), review: async () => passVerdict }, await store.get("a"), "w1")).toBe("done");

    expect(turns.map((turn) => turn.model)).toEqual(["w/one", "w/one", "q/two"]);
    expect(turns.map((turn) => turn.sessionId)).toEqual([undefined, "s", undefined]);
    expect(turns[2]!.rework).toContain("断言失败： expected 2, got 1");
    expect(turns[2]!.text).toContain(pointer());
  });

  it("survives a context wrap: the new session gets the handoff note and the pointer", async () => {
    await seed();
    // A model is named: `overBudget` answers false without asking when the
    // turn ran on none.
    let work = 0;
    const { turns, adapter } = recorder(async (turn, args) => {
      if (args.text === WRAP_UP_INSTRUCTION) {
        await writeNote(tasks, { task: "a", seq: 2, status: "进行中；预算告急", done: "修了一半", found: "断言在第 3 行", next: "继续修", files: [] });
        return { sessionId: args.sessionId!, text: "HANDOFF_READY", exitCode: 0 };
      }
      work += 1;
      return work === 2 ? { sessionId: "s", text: "还在修", exitCode: 0 } : undefined;
    }, (sessionId) => (sessionId === "s" && work >= 2 ? 900_000 : 0));

    expect(await runTask(config({ model: "w/one" }), { store, adapter, acceptance: gate(failed, passed), review: async () => passVerdict }, await store.get("a"), "w1")).toBe("done");

    // The recorder notes every prompt, the wrap-up turn included: turn 1
    // fails the gate, turn 2 is ordinary progress on the rejection, turn 3
    // wraps the session up, turn 4 opens the new one.
    expect(turns.map((turn) => turn.sessionId)).toEqual([undefined, "s", "s", undefined]);
    expect(turns[2]!.text).toBe(WRAP_UP_INSTRUCTION);
    // Turn 2 was ordinary progress on the rejection; the wrap that followed it
    // did not turn it into a new one.
    expect(turns[3]!.rework).toContain("控制器的验收命令失败了（exit 1）。");
    expect(turns[3]!.rework).not.toContain("没有请求完成");
    expect(turns[3]!.text).toContain(pointer());
    expect(turns[3]!.text).toContain("修了一半");
  });

  it("is handed to a later attempt by a review-only recovery that fails", async () => {
    await seed();
    // Written for part 1 as its plan builds it (its Task 6): a refused review
    // defers the task — `open`, its evidence kept — instead of parking it,
    // and the next claim resumes the review by itself. `modelCooldownMs: 0`
    // lets that claim through at once, and lets the refused model be asked again.
    // 1. The worker finishes, the gate passes, the reviewer refuses: deferred.
    const first = recorder();
    const deferred = config({ reviewerModel: "r/two", modelCooldownMs: 0 });
    expect(await runTask(deferred, { store, adapter: first.adapter, acceptance: gate(passed), review: async () => providerRefusal }, await store.get("a"), "w1")).toBe("open");
    expect(await readRwork(tasks, "a")).toBeNull();

    // 2. The next claim resumes the review on the preserved evidence and
    //    reaches a real fail verdict. It runs no worker, so the rework turn
    //    belongs to a later attempt.
    expect(await runTask(deferred, { store, adapter: first.adapter, acceptance: gate(passed), review: judge(failVerdict) }, await store.get("a"), "w2")).toBe("open");
    expect(await readRwork(tasks, "a")).toContain("独立复核没有通过（第 1 轮）：未达 C1");

    // 3. That attempt's first turn is the rework turn.
    const second = recorder();
    expect(await runTask(config({ reviewerModel: "r/two" }), { store, adapter: second.adapter, acceptance: gate(passed), review: judge(passVerdict) }, await store.get("a"), "w3")).toBe("done");
    expect(second.turns[0]!.text).toContain(pointer());
    expect(second.turns[0]!.rework).toContain("独立复核没有通过（第 1 轮）：未达 C1");
    expect(await readRwork(tasks, "a")).toBeNull();
  });

  it("stays on disk when the attempt is blocked, so a retry is pointed at it", async () => {
    await seed();
    const first = recorder();
    expect(await runTask(config({ retryLimit: 2 }), { store, adapter: first.adapter, acceptance: gate(failed) }, await store.get("a"), "w1")).toBe("blocked");
    expect(await readRwork(tasks, "a")).toContain("断言失败： expected 2, got 1");

    expect(await retryTask(tasks, "a", { baseWorkdir: work })).toMatchObject({ ok: true });
    const second = recorder();
    expect(await runTask(config({ retryLimit: 2 }), { store, adapter: second.adapter, acceptance: gate(passed), review: async () => passVerdict }, await store.get("a"), "w2")).toBe("done");
    expect(second.turns[0]!.text).toContain(pointer());
    expect(second.turns[0]!.rework).toContain("断言失败： expected 2, got 1");
    expect(await readRwork(tasks, "a")).toBeNull();
  });

  it("is removed when the work passes, so a session opened after a human reject is not pointed at a stale rejection", async () => {
    await seed({ risk: "high" });
    const first = recorder();
    expect(await runTask(config(), { store, adapter: first.adapter, acceptance: gate(passed), review: judge(failVerdict, passVerdict) }, await store.get("a"), "w1")).toBe("awaiting-human");
    expect(first.turns[1]!.rework).toContain("独立复核没有通过（第 1 轮）");
    expect(await readRwork(tasks, "a")).toBeNull();

    const rejected: string[] = [];
    expect(await runCli(["reject", "--task", "a", "--reason", "按钮没对齐", "--tasks-dir", tasks], { log: (line) => rejected.push(line) })).toBe(0);
    const second = recorder();
    expect(await runTask(config(), { store, adapter: second.adapter, acceptance: gate(passed), review: judge(passVerdict) }, await store.get("a"), "w2")).toBe("awaiting-human");

    expect(second.turns[0]!.text).not.toContain("rework.md");
    expect(second.turns[0]!.rework).toBeNull();
    // What the worker is told is the human's reason, through the note reject wrote.
    expect(second.turns[0]!.text).toContain("按钮没对齐");
  });

  it("a document that cannot be removed is journaled, and the task still finishes", async () => {
    await seed();
    // The worker has read the document in turn 2; before the pass is settled a
    // directory sits where the file was. Node refuses `rm` on a directory that
    // is not removed recursively (`ERR_FS_EISDIR`), on every platform.
    const { turns, adapter } = recorder(async (turn) => {
      if (turn !== 2) return undefined;
      await rm(reworkPath(), { force: true });
      await mkdir(reworkPath());
    });

    expect(await runTask(config(), { store, adapter, acceptance: gate(failed, passed), review: async () => passVerdict }, await store.get("a"), "w1")).toBe("done");

    expect(turns[1]!.rework).toContain("控制器的验收命令失败了（exit 1）。");
    expect((await readJournal(tasks, "a")).some((line) => line.event === "rework-clear-failed")).toBe(true);
  });

  it("a carried document is pointed at as it was written, and not rewritten", async () => {
    await seed();
    // An earlier attempt left this document; its time is its own.
    const earlier = renderRwork({ task: { id: "a", title: "任务 A" }, tasksDir: tasks, at: "2026-11-25T09:00:00.000Z", feedback: { kind: "acceptance", command: "npm test", exitCode: 1, output: "断言失败： expected 2, got 1" } });
    await mkdir(join(tasks, "a"), { recursive: true });
    await writeRuntimeText(tasks, "a", REWORK_FILE, earlier);
    const { turns, adapter } = recorder((turn) => (turn === 1 ? { sessionId: "s", text: "还在修", exitCode: 0 } : undefined));

    expect(await runTask(config(), { store, adapter, acceptance: gate(passed), review: async () => passVerdict }, await store.get("a"), "w1")).toBe("done");

    expect(turns).toHaveLength(2);
    expect(turns[0]!.rework).toBe(earlier);
    expect(turns[1]!.rework).toBe(turns[0]!.rework);
    expect(turns[1]!.text).toContain(pointer());
    expect(await readRwork(tasks, "a")).toBeNull();
  });
});
