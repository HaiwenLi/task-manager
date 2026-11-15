import type { AgentAdapter } from "./adapters/types.js";
import type { Execution } from "./execution.js";
import type { Task } from "./task-file.js";

export type Verdict = "pass" | "fail" | "unclear";

/** One criterion's outcome, as reported by the reviewer. */
export type CriterionResult = { id: string; pass: boolean; evidence: string };

/**
 * The reviewer's whole answer. `unclear` is the safe verdict: it parks the task
 * for a human instead of spending a retry on a guess.
 */
export type ReviewResult = { verdict: Verdict; criteria: CriterionResult[]; defects: string[]; summary: string };

export type ReviewEvidence = {
  task: Task;
  spec: string;
  acceptanceMarkdown: string;
  handoff: string | null;
  journal: string[];
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
    "## 运行日志尾部",
    ...(evidence.journal.length > 0 ? evidence.journal : ["(空)"]),
    "",
    "## 规则",
    "1. 逐条判定上面的验收标准，id 用 C1、C2 原样。",
    "2. 证据不足以下结论时判 unclear，不要为了给出结论而猜。",
    "3. 不要评价你没看到的实现细节，也不要要求额外的材料。",
    "4. 只输出一个 JSON 对象，不要写解释、不要用代码块包裹。",
    "",
    "JSON 形状：",
    `{"verdict":"pass|fail|unclear","criteria":[{"id":"C1","pass":true,"evidence":"依据"}],"defects":["必须修的点"],"summary":"一句话"}`,
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
    return degraded(ids, "reviewer output was not a JSON verdict");
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
  const summary = typeof parsed.summary === "string" ? parsed.summary : "";
  const allPassed = merged.every((criterion) => criterion.pass);

  if (missing || verdict === "unclear") {
    return { verdict: "unclear", criteria: merged, defects, summary };
  }
  if (verdict === "fail" && allPassed) {
    return { verdict: "unclear", criteria: merged, defects, summary };
  }
  // A "pass" that contradicts its own criterion results is a fail: the
  // per-criterion evidence is the specific claim, the overall word is not.
  if (verdict === "pass" && !allPassed) {
    return { verdict: "fail", criteria: merged, defects, summary };
  }
  return { verdict, criteria: merged, defects, summary };
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
  const finish = (result: { exitCode: number; text: string }): ReviewResult =>
    result.exitCode !== 0
      ? degraded(
          evidence.task.criteria.map((criterion) => criterion.split(/\s+/)[0]!),
          `review turn failed with exit ${result.exitCode}`,
        )
      : parseVerdict(result.text, evidence.task.criteria);

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
