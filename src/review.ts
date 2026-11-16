import type { AgentAdapter, PromptResult } from "./adapters/types.js";
import type { Execution } from "./execution.js";
import { DRIFT_HINTS, type Task } from "./task-file.js";

export type Verdict = "pass" | "fail" | "unclear";

/** One criterion's outcome, as reported by the reviewer. */
export type CriterionResult = { id: string; pass: boolean; evidence: string };

/**
 * The reviewer's whole answer. `unclear` is the safe verdict: it parks the task
 * for a human instead of spending a retry on a guess. `raw` keeps the model's
 * actual words so a parse failure can be diagnosed instead of guessed at.
 */
export type ReviewResult = {
  verdict: Verdict;
  criteria: CriterionResult[];
  defects: string[];
  summary: string;
  /**
   * Differences the reviewer attributed to someone else and excused under the
   * task's `tolerate` declaration. Recorded, never silent: a tolerated change is
   * still a fact a human should be able to read back from `review.json`.
   */
  externalChanges: string[];
  raw?: string;
  /** The backend rejected the review turn itself (quota/auth/5xx); no judging happened. */
  failure?: "provider";
};

export type ReviewEvidence = {
  task: Task;
  spec: string;
  acceptanceMarkdown: string;
  handoff: string | null;
  journal: string[];
  /**
   * When this attempt started and when the work was handed to the review. The
   * reviewer needs both edges to tell "this changed while the task ran" from
   * "this was never done": the first is drift, the second is a defect.
   */
  window: { startedAt: string; finishedAt: string };
};

/**
 * The reviewer sees evidence, never the worker's conversation: spec, the
 * acceptance command and its result, the handoff note, the journal tail. It is
 * asked for one JSON object so a stray sentence cannot silently become a verdict.
 */
export function buildReviewPrompt(evidence: ReviewEvidence): string {
  return [
    "你是独立复核者。你只能依据下面这些材料判断，不要猜测你没看到的东西。",
    "",
    "## 任务",
    `标题：${evidence.task.title}`,
    "验收标准：",
    ...evidence.task.criteria.map((criterion) => `- ${criterion}`),
    "",
    "## spec",
    evidence.spec.trim(),
    "",
    "## 验收命令与结果",
    evidence.acceptanceMarkdown.trim() || "(没有验收记录)",
    "",
    "## 执行者的交接笔记",
    evidence.handoff?.trim() || "(没有交接笔记)",
    "",
    "## 容忍的外部变更",
    ...(evidence.task.tolerate.length > 0
      ? evidence.task.tolerate.map((kind) => `- ${kind}：${DRIFT_HINTS[kind]}`)
      : ["(本任务没有声明；任何附带改动都按原规则判定)"]),
    "",
    "## 时间窗口",
    `本次执行开始：${evidence.window.startedAt}`,
    `交给复核：${evidence.window.finishedAt}`,
    "",
    "## 运行日志尾部",
    ...(evidence.journal.length > 0 ? evidence.journal : ["(空)"]),
    "",
    "## 规则",
    "1. 逐条判定上面的验收标准，id 用 C1、C2 原样。",
    "2. 证据不足以下结论时判 unclear，不要为了给出结论而猜。",
    "3. 不要评价你没看到的实现细节，也不要要求额外的材料。",
    "4. 只输出一个 JSON 对象，不要写解释、不要用代码块包裹。",
    "5. 只有「容忍的外部变更」里列出的类别可以归因为外部变更；清单外的结构变化（删列、改表头含义等）仍按原规则判 fail。",
    "6. 归因为外部变更的差异写进 externalChanges，每条以标准编号开头（如 `C1：表头多出备注列`），说明它影响了哪条；这类差异本身不构成 fail 的理由。",
    "7. 本任务自己该写的东西没写、写错、写少了，必须 fail——外部变更不能当挡箭牌。",
    "8. 时间上从严：只有证据能说明差异发生在「本次执行开始」之后的，才按外部变更处理；证据说明不了先后，就按本任务的问题处理（判 fail 或 unclear），不要替它猜成外部变更。",
    "",
    "JSON 形状：",
    `{"verdict":"pass|fail|unclear","criteria":[{"id":"C1","pass":true,"evidence":"依据"}],"externalChanges":["归因为外部变更的差异"],"defects":["必须修的点"],"summary":"一句话"}`,
  ].join("\n");
}

/**
 * Turn a reviewer's raw text into a {@link ReviewResult}. Anything that cannot
 * be read as a well-formed verdict becomes `unclear`, never `fail`: a mangled
 * answer is not evidence that the work is wrong, and a `fail` would spend a
 * retry on a parsing problem.
 */
export function parseVerdict(text: string, criteria: string[]): ReviewResult {
  const ids = criteria.map((criterion) => criterion.split(/\s+/)[0]!);
  const parsed = extractJson(text);
  if (parsed === null) {
    return { ...degraded(ids, "reviewer output was not a JSON verdict"), raw: text };
  }
  const verdict = parsed.verdict;
  if (verdict !== "pass" && verdict !== "fail" && verdict !== "unclear") {
    return degraded(ids, "reviewer verdict missing or unknown");
  }
  const reported = new Map<string, CriterionResult>();
  const rawCriteria = Array.isArray(parsed.criteria) ? parsed.criteria : [];
  for (const entry of rawCriteria) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (id.length === 0) continue;
    reported.set(id, {
      id,
      pass: record.pass === true,
      evidence: typeof record.evidence === "string" ? record.evidence : "",
    });
  }
  const merged: CriterionResult[] = ids.map(
    (id) => reported.get(id) ?? { id, pass: false, evidence: "reviewer did not report this criterion" },
  );
  const missing = merged.some((criterion) => criterion.evidence === "reviewer did not report this criterion");
  const defects = Array.isArray(parsed.defects)
    ? parsed.defects.filter((defect): defect is string => typeof defect === "string")
    : [];
  const externalChanges = Array.isArray(parsed.externalChanges)
    ? parsed.externalChanges
        .filter((change): change is string => typeof change === "string")
        .map((change) => change.trim())
        .filter((change) => change.length > 0)
    : [];
  const summary = typeof parsed.summary === "string" ? parsed.summary : "";
  const allPassed = merged.every((criterion) => criterion.pass);

  if (missing || verdict === "unclear") {
    return { verdict: "unclear", criteria: merged, defects, summary, externalChanges, raw: text };
  }
  if (verdict === "fail" && allPassed) {
    return { verdict: "unclear", criteria: merged, defects, summary, externalChanges, raw: text };
  }
  // A "pass" that contradicts its own criterion results is a fail: the
  // per-criterion evidence is the specific claim, the overall word is not.
  if (verdict === "pass" && !allPassed) {
    return { verdict: "fail", criteria: merged, defects, summary, externalChanges, raw: text };
  }
  return { verdict, criteria: merged, defects, summary, externalChanges, raw: text };
}

/** Run one review turn in a fresh session and parse its verdict. */
export async function runReview(
  deps: ReviewDeps,
  evidence: ReviewEvidence,
): Promise<ReviewResult> {
  return startReview(deps, evidence).result;
}

export type ReviewDeps = { adapter: AgentAdapter; cwd: string; model?: string; effort?: string; title?: string };

/**
 * A review turn as a cancellable handle. The worker needs the handle, not just
 * the promise: a review that times out must be stopped and confirmed stopped
 * before the task is retried (ADR-0007).
 */
export function startReview(deps: ReviewDeps, evidence: ReviewEvidence): Execution<ReviewResult> {
  const args = {
    text: buildReviewPrompt(evidence),
    cwd: deps.cwd,
    model: deps.model,
    effort: deps.effort,
    title: `review: ${deps.title ?? evidence.task.title}`,
  };
  const finish = (result: PromptResult): ReviewResult => {
    if (result.exitCode === 0) return parseVerdict(result.text, evidence.task.criteria);
    const degradedResult = degraded(
      evidence.task.criteria.map((criterion) => criterion.split(/\s+/)[0]!),
      `review turn failed with exit ${result.exitCode}`,
    );
    // A backend rejection is not a verdict: the worker must retry, not ask a
    // human to judge work the reviewer never looked at.
    return result.failure === "provider" ? { ...degradedResult, failure: "provider" } : degradedResult;
  };

  if (deps.adapter.start) {
    const inner = deps.adapter.start(args);
    return {
      result: inner.result.then(finish),
      inspect: inner.inspect,
      cancel: inner.cancel,
    };
  }
  let state: "running" | "exited" = "running";
  const result = deps.adapter.prompt(args).then(finish).finally(() => { state = "exited"; });
  return { result, inspect: () => ({ state }), cancel: async () => false };
}

function degraded(ids: string[], reason: string): ReviewResult {
  return {
    verdict: "unclear",
    criteria: ids.map((id) => ({ id, pass: false, evidence: reason })),
    externalChanges: [],
    defects: [],
    summary: reason,
  };
}

/** Try the fenced block first, then the outermost braces; null when neither parses. */
function extractJson(text: string): Record<string, unknown> | null {
  const candidates: string[] = [];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced?.[1]) candidates.push(fenced[1]);
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const value: unknown = JSON.parse(candidate.trim());
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
    } catch {
      // try the next candidate
    }
  }
  return null;
}
