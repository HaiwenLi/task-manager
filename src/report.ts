import { TaskStore } from "./task-store.js";
import { journalTail } from "./journal.js";
import { readAudits, type AuditRecord } from "./audit.js";
import { readRuntime } from "./runtime.js";
import { readSpec } from "./spec.js";
import type { Task } from "./task-file.js";
import { readUsage, summarizeUsage } from "./usage.js";

type AcceptanceFile = {
  command?: string; exitCode?: number | null; passed?: boolean; output?: string;
  artifactBefore?: string; artifactAfter?: string; definitionMatches?: boolean;
};

type ReviewFile = {
  verdict?: string; summary?: string; defects?: string[]; model?: string; externalChanges?: string[]; reviewerSessionId?: string;
  /** The declaration the reviewer actually worked under, and the digest it belonged to. */
  tolerate?: string[]; definitionDigest?: string;
  criteria?: Array<{ id?: string; pass?: boolean; evidence?: string }>;
};

/**
 * Everything a human needs to judge one task without opening five files. Every
 * line comes from an artifact the orchestrator wrote, not from the worker's
 * self-report.
 */
export async function buildReport(tasksDir: string, id: string): Promise<string[]> {
  const task = await new TaskStore(tasksDir).get(id);
  const spec = await readSpec(tasksDir, id);
  const acceptance = await readRuntime<AcceptanceFile>(tasksDir, id, "acceptance.json");
  const review = await readRuntime<ReviewFile>(tasksDir, id, "review.json");
  const journal = await journalTail(tasksDir, id, 15);
  const audits = (await readAudits(tasksDir)).filter((record) => record.task === id);
  const usage = summarizeUsage(await readUsage(tasksDir, id));

  return [
    `task ${id}: ${task.title}`,
    `status ${task.status}  retries ${task.retries}  reviewRounds ${task.reviewRounds}  sessions ${task.sessions.length}`,
    `complexity ${task.complexity}  execution ${task.execution}  risk ${task.risk}  humanCheck ${task.humanCheck}`,
    `verify ${task.verify}${task.quick ? "  (quick lane: no spec)" : ""}` +
      (task.renderTargets.length > 0 ? `  targets ${task.renderTargets.join(", ")}` : ""),
    ...(task.tolerate.length > 0 ? [`tolerate ${task.tolerate.join(", ")}`] : []),
    "",
    "## spec",
    ...(spec === null ? ["(no spec)"] : [firstLine(spec)]),
    "",
    "## acceptance",
    ...(acceptance === null
      ? ["(not run yet)"]
      : [
          `command  ${acceptance.command ?? "(none)"}`,
          `result   ${acceptance.passed === true ? "passed" : "failed"}  exit ${acceptance.exitCode ?? "null"}  definitionMatch ${acceptance.definitionMatches ?? "?"}`,
          `artifacts ${short(acceptance.artifactBefore)} → ${short(acceptance.artifactAfter)}`,
          ...(acceptance.output === undefined ? [] : [`output   ${firstLine(acceptance.output)}`]),
        ]),
    "",
    "## review",
    ...(review === null
      ? ["(no reviewer verdict recorded)"]
      : [
          `verdict  ${review.verdict ?? "?"}  ${review.summary ?? ""}${review.model === undefined ? "" : `  model ${review.model}`}`,
          ...(review.reviewerSessionId === undefined ? [] : [`reviewerSessionId ${review.reviewerSessionId}`]),
          ...declarationLines(review, task.tolerate),
          ...(review.criteria ?? []).map(
            (criterion) => `  [${criterion.pass === true ? "x" : " "}] ${criterion.id ?? "?"} ${firstLine(criterion.evidence ?? "")}`,
          ),
          ...((review.defects ?? []).length > 0 ? [`defects  ${(review.defects ?? []).join("; ")}`] : []),
          ...toleratedLines(review.externalChanges ?? []),
        ]),
    "",
    "## usage",
    ...(usage.length === 0 ? ["(no usage records)"] : usage.flatMap((group) => [
      `${group.role}/${group.model}  input ${group.input}  output ${group.output}  reasoning ${group.reasoning}  cacheRead ${group.cacheRead}  cacheWrite ${group.cacheWrite}${group.cost === undefined ? "" : `  cost ${group.cost}`}`,
      ...(group.unknown > 0 || group.resets > 0 ? [`  unknown ${group.unknown}  resets ${group.resets}`] : []),
    ])),
    "",
    "## journal",
    ...(journal.length > 0 ? journal : ["(empty)"]),
    "",
    "## human audits",
    ...(audits.length > 0 ? audits.map(renderAudit) : ["(none)"]),
  ];
}

/**
 * The declaration the verdict was actually reached under. Today's task file is
 * not evidence about an older review: narrowing `tolerate` after a pass must not
 * read as if the reviewer had been allowed what the file now says.
 */
function declarationLines(review: ReviewFile, current: readonly string[]): string[] {
  if (review.tolerate === undefined) return [];
  const reviewed = review.tolerate;
  const same = [...reviewed].sort().join(",") === [...current].sort().join(",");
  const asReviewed = reviewed.length === 0 ? "(none)" : reviewed.join(", ");
  return [`tolerate(at review) ${asReviewed}${same ? "" : `  (changed since; now ${current.length === 0 ? "(none)" : current.join(", ")})`}`];
}

/** One page, so a pathological list is summarised instead of pushing the rest off. */
const TOLERATED_SHOWN = 5;

function toleratedLines(changes: readonly string[]): string[] {
  if (changes.length === 0) return [];
  const shown = changes.slice(0, TOLERATED_SHOWN).map((change) => `  ~ ${firstLine(change)}`);
  const rest = changes.length - shown.length;
  return [
    "tolerated (attributed to someone else, not this task):",
    ...shown,
    ...(rest > 0 ? [`  ~ (+${rest} more; see tasks/<id>/review.json)`] : []),
  ];
}

function renderAudit(record: AuditRecord): string {
  const stage = record.stage === "none" ? "" : ` stage=${record.stage}`;
  const note = record.note === undefined ? "" : ` ${record.note}`;
  return `${record.at.slice(0, 19)} ${record.verdict}${stage}${record.highlight === true ? " ★highlight" : ""}${note}`;
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim().slice(0, 120) ?? "";
}

function short(digest: string | undefined): string {
  return digest === undefined ? "?" : digest.slice(0, 12);
}
