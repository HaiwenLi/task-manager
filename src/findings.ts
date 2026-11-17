import { readRuntime } from "./runtime.js";
import { journalTail } from "./journal.js";
import type { Task } from "./task-file.js";

/**
 * Turn one task's artifacts into a draft finding.
 *
 * The point is to stop real-task friction from dying in a chat log. `findings`
 * records what happened; the judgment of what it means is deliberately left to a
 * later triage step, because a machine's guess recorded as fact is how a backlog
 * fills with things nobody can act on.
 *
 * Everything here is extracted from artifacts the orchestrator wrote, so a
 * finding is self-contained: another machine cannot resolve `tasks/<id>/`, and a
 * pointer into it would be a dead link.
 */

/** Journal events worth carrying into a finding, with the wording a reader needs. */
const INTERESTING: Record<string, string> = {
  escalated: "运行期判断这件事比开单时更大（升级）",
  blocked: "被阻塞",
  rework: "返工",
  handoff: "会话交接：一次没干完",
  "turn-failed": "回合失败",
  "model-fallback": "模型降级",
  "model-fallback-failed": "降级无法记录",
  "render-unavailable": "渲染检查跑不起来",
  "definition-drift": "执行期任务定义被改，本次验收作废",
  "spec-invalid": "spec 没有可判定的验收标准",
  "clarify-failed": "澄清会话失败",
};

export type FindingDraft = {
  /** Suggested filename stem: `<date>-<slug>.md`. */
  slug: string;
  /** How many machine-checkable signals were found; 0 means the task left no trace. */
  signals: number;
  markdown: string;
};

/** Signals no journal line records: counters, and the verdict itself. */
type Signal = { label: string; raw?: string };

export async function buildFinding(tasksDir: string, task: Task, now = new Date()): Promise<FindingDraft> {
  const date = now.toISOString().slice(0, 10);
  const journal = await journalTail(tasksDir, task.id, 200);
  const review = await readRuntime<{
    verdict?: string;
    criteria?: Array<{ id?: string; pass?: boolean; evidence?: string }>;
    defects?: string[];
    model?: string;
  }>(tasksDir, task.id, "review.json");
  const acceptance = await readRuntime<{ passed?: boolean; exitCode?: number | null; command?: string }>(
    tasksDir, task.id, "acceptance.json",
  );
  const renderEvidence = await readRuntime<{ ok?: boolean; views?: Array<{ target?: string; viewport?: string; problems?: string[] }> }>(
    tasksDir, task.id, "render.json",
  );
  const attempt = await readRuntime<{ phase?: string; reason?: string }>(tasksDir, task.id, "attempt.json");

  const signals: Signal[] = [];
  const evidence: string[] = [];

  const counters = [
    `status=${task.status}`,
    `retries=${task.retries}`,
    `reviewRounds=${task.reviewRounds}`,
    `sessions=${task.sessions.length}`,
    `complexity=${task.complexity}`,
    `verify=${task.verify}${task.quick ? "（快速车道）" : ""}`,
  ].join("，");

  for (const line of journal) {
    const parsed = /^(\S+)\s{2}(\S+)\s{2}(\S+)(?:\s{2}(.*))?$/.exec(line);
    if (!parsed) continue;
    const [, at, , event, detail] = parsed;
    const label = INTERESTING[event!];
    const isFailedAcceptance = event === "acceptance" && (detail ?? "").startsWith("failed");
    if (!label && !isFailedAcceptance) continue;
    signals.push({ label: `${label ?? "验收命令失败"}${detail ? `：${detail}` : ""}`, raw: line });
    evidence.push(line);
  }

  if (task.retries > 0 || task.reviewRounds > 0 || task.sessions.length > 1) {
    signals.push({
      label: `代价：${task.retries} 次失败尝试、${task.reviewRounds} 轮复核失败、${task.sessions.length} 个会话`,
    });
  }

  if (review) {
    const failed = (review.criteria ?? []).filter((criterion) => criterion.pass === false);
    const pass = (review.criteria ?? []).length;
    signals.push({
      label: `复核 ${review.verdict ?? "?"}：${pass - failed.length}/${pass} 条标准通过` +
        (failed.length > 0 ? `，未过 ${failed.map((c) => c.id ?? "?").join("、")}` : ""),
    });
    for (const criterion of failed) {
      signals.push({ label: `${criterion.id ?? "?"}：${criterion.evidence ?? "（无 evidence）"}` });
    }
    for (const defect of review.defects ?? []) signals.push({ label: `缺陷：${defect}` });
    evidence.push(`review.json: verdict=${review.verdict ?? "?"} model=${review.model ?? "(default)"}`);
  }

  if (acceptance && acceptance.passed === false) {
    signals.push({ label: `验收命令失败（exit ${acceptance.exitCode ?? "null"}）：${acceptance.command ?? "(none)"}` });
  }

  const badViews = (renderEvidence?.views ?? []).filter((view) => (view.problems ?? []).length > 0);
  for (const view of badViews) {
    signals.push({ label: `渲染失败 ${view.target ?? "?"} @ ${view.viewport ?? "?"}：${(view.problems ?? []).join("、")}` });
  }

  if (attempt && attempt.phase !== undefined && attempt.phase !== "settled") {
    signals.push({ label: `执行停止未确认：phase=${attempt.phase}${attempt.reason ? `，${attempt.reason}` : ""}` });
  }

  const slug = slugOf(task);
  const markdown = composeFinding({ date, task, counters, signals, evidence });
  return { slug: `${date}-${slug}`, signals: signals.length, markdown };
}

function composeFinding(args: { date: string; task: Task; counters: string; signals: Signal[]; evidence: string[] }): string {
  const { date, task, counters, signals, evidence } = args;
  const observed = [
    `- ${counters}`,
    ...(signals.length > 0
      ? signals.map((signal) => `- ${signal.label}`)
      : ["- 没有从产物里抽到机器可查的信号。这条如果值得记，说明它不在这套机制能看见的范围内——请手工补。"]),
  ];
  return [
    "---",
    `date: ${date}`,
    `source_task: ${task.id}`,
    "kind: unset",
    "severity: unset",
    "---",
    "",
    `# ${task.title}`,
    "",
    "## 观察到什么",
    "",
    ...observed,
    "",
    "## 在哪里发生",
    "",
    `- 任务：\`${task.id}\``,
    `- 阶段：${stagesOf(signals)}`,
    "- 证据：",
    "",
    "```text",
    ...(evidence.length > 0 ? evidence : ["（无原始行）"]),
    "```",
    "",
    "## 复现条件",
    "",
    "（待填：什么输入、什么状态下会再发生。不确定就写「不确定」，不要写成必然。）",
    "",
    "## 猜测的成因（可选，明确标成猜测）",
    "",
    "（待填。没有猜测就删掉这一节；有的话开头写「猜测：」。）",
    "",
  ].join("\n");
}

/** Which orchestrator stages the signals came from; derived, never asserted. */
function stagesOf(signals: Signal[]): string {
  const stages = new Set<string>();
  for (const signal of signals) {
    if (/复核/.test(signal.label)) stages.add("review");
    if (/渲染/.test(signal.label)) stages.add("render");
    if (/验收/.test(signal.label)) stages.add("acceptance");
    if (/升级|阻塞|交接|回合|降级|定义/.test(signal.label)) stages.add("worker");
    if (/澄清|spec/.test(signal.label)) stages.add("clarify");
  }
  return stages.size > 0 ? [...stages].join(" / ") : "未知（见证据）";
}

/** ASCII slug from the task title; a title with too little ASCII falls back to the task id. */
function slugOf(task: Task): string {
  const slug = task.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  // A Chinese title can leave a stray latin word ("unc") or nothing at all; that is
  // not a name anyone can find later, so the id wins unless the slug is substantial.
  if (slug.length >= 10) return slug;
  return task.id.replace(/[^A-Za-z0-9._-]+/g, "-") || task.id;
}
