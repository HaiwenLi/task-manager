import { TaskStore } from "./task-store.js";
import { journalTail } from "./journal.js";
import { readAudits, type AuditRecord } from "./audit.js";
import { readRuntime } from "./runtime.js";
import { readSpec } from "./spec.js";
import type { Task } from "./task-file.js";

type AcceptanceFile = {
  command?: string; exitCode?: number | null; passed?: boolean; output?: string;
  artifactBefore?: string; artifactAfter?: string; definitionMatches?: boolean;
};

type ReviewFile = {
  verdict?: string; summary?: string; defects?: string[];
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

  return [
    `task ${id}: ${task.title}`,
    `status ${task.status}  retries ${task.retries}  reviewRounds ${task.reviewRounds}  sessions ${task.sessions.length}`,
    `complexity ${task.complexity}  risk ${task.risk}  humanCheck ${task.humanCheck}`,
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
          `verdict  ${review.verdict ?? "?"}  ${review.summary ?? ""}`,
          ...(review.criteria ?? []).map(
            (criterion) => `  [${criterion.pass === true ? "x" : " "}] ${criterion.id ?? "?"} ${firstLine(criterion.evidence ?? "")}`,
          ),
          ...((review.defects ?? []).length > 0 ? [`defects  ${(review.defects ?? []).join("; ")}`] : []),
        ]),
    "",
    "## journal",
    ...(journal.length > 0 ? journal : ["(empty)"]),
    "",
    "## human audits",
    ...(audits.length > 0 ? audits.map(renderAudit) : ["(none)"]),
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
