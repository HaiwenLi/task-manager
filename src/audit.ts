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
