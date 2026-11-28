import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CriterionResult } from "./review.js";

/** The document the controller writes before every rework turn, under `tasks/<id>/`. */
export const REWORK_FILE = "rework.md";

/** How much of a long acceptance output the document keeps (its tail), in code points. */
export const REWORK_OUTPUT_CHARS = 4_000;

/** How long one piece of reviewer evidence, or one defect, may be, in code points. */
export const REWORK_LINE_CHARS = 1_000;

/** Why the previous turn was sent back — the record the rework document is rendered from. */
export type ReworkFeedback =
  | { kind: "acceptance"; command: string; exitCode: number | null; output: string }
  | { kind: "review"; round: number; summary: string; failed: CriterionResult[]; defects: string[] }
  | { kind: "render"; failures: string[] }
  | { kind: "no-completion"; why: string; previous: ReworkFeedback | null }
  | { kind: "carried"; markdown: string };

export function reworkPathOf(tasksDir: string, id: string): string {
  return join(tasksDir, id, REWORK_FILE);
}

/** The last `n` code points of `text` — a cut that never splits a character. */
function tail(text: string, n: number): string {
  return Array.from(text).slice(-n).join("");
}

/** `text` cut at {@link REWORK_LINE_CHARS} code points with `…` when it is longer. */
function clip(text: string): string {
  const points = Array.from(text);
  return points.length > REWORK_LINE_CHARS ? points.slice(0, REWORK_LINE_CHARS).join("") + "…" : text;
}

/**
 * The lines that carry an acceptance output: `\r\n` and `\r` turned into `\n`,
 * nothing else changed; a long output keeps its tail and says where the whole
 * of it is, an empty or whitespace-only one is said to be silent.
 */
function acceptanceOutputLines(output: string, tasksDir: string, id: string): string[] {
  const normalized = output.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (normalized.trim() === "") return ["验收命令没有留下任何输出。"];
  const omitted = Array.from(normalized).length - REWORK_OUTPUT_CHARS;
  if (omitted > 0) {
    return [
      `验收输出（只保留结尾 ${REWORK_OUTPUT_CHARS} 个字符，前面省略 ${omitted} 个字符；`
      + `完整输出在 ${join(tasksDir, id, "acceptance.json")} 的 output 字段，被 taskctl retry 归档后在 ${join(tasksDir, id, "archive")} 下）：`,
      "",
      tail(normalized, REWORK_OUTPUT_CHARS),
    ];
  }
  return ["验收输出：", "", normalized];
}

/** The document's body for one feedback record — every line under the header. */
function bodyLines(feedback: ReworkFeedback, id: string, tasksDir: string): string[] {
  const lines: string[] = [];
  const done = `- 改完后请求完成：taskctl done --task ${id} --tasks-dir "${tasksDir}"`;
  if (feedback.kind === "acceptance") {
    lines.push(
      "## 上一回合为什么没有通过",
      "",
      `控制器的验收命令失败了（exit ${feedback.exitCode}）。验收命令退出 0，任务才能进入下一步。`,
      "",
      `验收命令：${feedback.command}`,
      "",
      ...acceptanceOutputLines(feedback.output, tasksDir, id),
      "",
      "## 需要改变什么",
      "",
      "- 按上面的验收输出修复；输出被截断时，先读完整的验收记录再判断。",
      "- 先做有界的定向自验（任务声明了 worker_self_check 就用 taskctl check），不要反复重跑全量验收。",
      done,
    );
    return lines;
  }
  if (feedback.kind === "review") {
    const summary = feedback.summary === "" ? "复核未通过" : feedback.summary;
    lines.push(
      "## 上一回合为什么没有通过",
      "",
      `独立复核没有通过（第 ${feedback.round} 轮）：${summary}`,
      "",
      "没有通过的验收标准，以及复核者看到的依据：",
      "",
    );
    for (const criterion of feedback.failed) {
      const evidence = criterion.evidence === "" ? "（复核者没有给出依据）" : clip(criterion.evidence);
      lines.push(`- ${criterion.id}：${evidence}`);
    }
    lines.push("", "## 需要改变什么", "");
    if (feedback.defects.length === 0) {
      lines.push("- 按上面没有通过的验收标准返工。");
    } else {
      for (const defect of feedback.defects) lines.push(`- ${clip(defect)}`);
    }
    lines.push(done);
    return lines;
  }
  if (feedback.kind === "render") {
    lines.push(
      "## 上一回合为什么没有通过",
      "",
      "渲染验收失败：下面的页面在下面的视口上，没有同时做到画得出来、有可读内容、不横向溢出、没有未捕获异常。",
      "",
    );
    for (const failure of feedback.failures) lines.push(`- ${failure}`);
    lines.push(
      "",
      "## 需要改变什么",
      "",
      `- 修到每个目标页面在每个视口上都满足上面四条。失败那一屏的截图在 ${join(tasksDir, id, "evidence")}，先看它。`,
      done,
    );
    return lines;
  }
  if (feedback.kind === "no-completion") {
    lines.push(
      "## 上一回合为什么没有通过",
      "",
      feedback.why,
      "",
      "## 需要改变什么",
      "",
      `- 已经做完：请求完成，taskctl done --task ${id} --tasks-dir "${tasksDir}"`,
      "- 还没做完：继续做，并用 taskctl note 记下现状、卡点和下一步。",
      "- 任务比声明的更大：单独输出一行 ESCALATE: <原因>。",
    );
    if (feedback.previous !== null) {
      lines.push("## 仍然适用的上一轮否决", "");
      lines.push(...bodyLines(feedback.previous, id, tasksDir));
    }
    return lines;
  }
  // A document an earlier attempt wrote, reproduced from its first `## ` on: it
  // is carried under this attempt's header, never with a second `# ` heading.
  // The carried body may already hold an escalation block from the attempt
  // that wrote it, and this attempt's own, if it gives one, follows it as a
  // second such section.
  const whole = feedback.markdown.replace(/\n$/, "").split("\n");
  const start = whole.findIndex((line) => line.startsWith("## "));
  return whole.slice(start);
}

export function renderRwork(args: {
  task: { id: string; title: string };
  tasksDir: string;
  at: string;
  feedback: ReworkFeedback;
  escalation?: string;
}): string {
  const { task, tasksDir, at, feedback, escalation } = args;
  const lines = [
    `# 返工说明：${task.title}（${task.id}）`,
    "",
    `写于 ${at}。上一回合没有通过：先读完这份说明，再动手。`,
    "",
    ...bodyLines(feedback, task.id, tasksDir),
  ];
  if (escalation !== undefined) {
    lines.push(
      "",
      "## 你在上一回合提出的升级",
      "",
      `ESCALATE: ${escalation}`,
      "",
      "本任务因此升级为迭代执行：此后必须经过独立复核，不能再用自己的证据收尾。",
    );
  }
  return lines.join("\n") + "\n";
}

/** Read the rework document; a missing file reads as null, any other error propagates. */
export async function readRwork(tasksDir: string, id: string): Promise<string | null> {
  try {
    return await readFile(reworkPathOf(tasksDir, id), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * The document an earlier attempt left behind, read back as a feedback record.
 * Its `carried` kind renders the stored markdown from its first `## ` heading
 * on, so the next attempt's rework turn is pointed at the same document.
 */
export async function carriedRework(tasksDir: string, id: string): Promise<ReworkFeedback | null> {
  const markdown = await readRwork(tasksDir, id);
  return markdown === null ? null : { kind: "carried", markdown };
}
