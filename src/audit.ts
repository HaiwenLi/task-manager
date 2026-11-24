import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** Which stage a human judged to be at fault. */
export type AuditStage = "clarify" | "worker" | "reviewer" | "none";

/** One human decision about a finished or returned task. */
export type AuditRecord = {
  task: string;
  at: string;
  verdict: "pass" | "fail";
  stage: AuditStage;
  note?: string;
  highlight?: boolean;
};

const FILE = "audits.jsonl";

function auditFile(tasksDir: string): string {
  return join(tasksDir, "..", ".taskctl", FILE);
}

/** Append one audit line; the directory is created on first use. */
export async function appendAudit(tasksDir: string, record: AuditRecord): Promise<void> {
  const file = auditFile(tasksDir);
  await mkdir(join(file, ".."), { recursive: true });
  await appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
}

/** All audit records, oldest first; a missing file reads as empty. */
export async function readAudits(tasksDir: string): Promise<AuditRecord[]> {
  let raw: string;
  try {
    raw = await readFile(auditFile(tasksDir), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const records: AuditRecord[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as AuditRecord;
      if (typeof parsed.task === "string" && (parsed.verdict === "pass" || parsed.verdict === "fail")) {
        records.push(parsed);
      }
    } catch {
      // A corrupt line is skipped: the audit log is evidence, not state.
    }
  }
  return records;
}

/**
 * Which stage keeps failing. This is the learning signal: a reviewer that keeps
 * being overruled, or a worker that keeps needing rework, is the thing to fix.
 *
 * Rework is deliberately not summarised here. An audit records what a human
 * judged, and that says nothing about how often taskctl sent work back on its
 * own; `metrics.ts` keeps the two apart instead of reporting one number.
 */
export function summarizeAudits(records: AuditRecord[]): string[] {
  const stages: AuditStage[] = ["clarify", "worker", "reviewer", "none"];
  const counts = new Map(stages.map((stage) => [stage, { fail: 0, total: 0 }]));
  for (const record of records) {
    const bucket = counts.get(record.stage) ?? counts.get("none")!;
    bucket.total += 1;
    if (record.verdict === "fail") bucket.fail += 1;
  }
  const highlighted = records.filter((record) => record.verdict === "pass" && record.highlight === true).length;
  return [
    `audits  ${records.length}`,
    ...stages.map((stage) => {
      const bucket = counts.get(stage)!;
      return `${stage}  ${bucket.fail} fail / ${bucket.total}`;
    }),
    `highlight  ${highlighted}`,
  ];
}
