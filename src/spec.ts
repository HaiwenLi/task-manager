import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Raised when a draft spec cannot be turned into checkable criteria. */
export class SpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpecError";
  }
}

/** `tasks/<id>/spec.md` — the clarified spec a human approves. */
export function specPath(tasksDir: string, id: string): string {
  return join(tasksDir, id, "spec.md");
}

/** Write the spec; the task directory is created on first use. */
export async function writeSpec(tasksDir: string, id: string, markdown: string): Promise<string> {
  const dir = join(tasksDir, id);
  await mkdir(dir, { recursive: true });
  const path = specPath(tasksDir, id);
  await writeFile(path, markdown, "utf8");
  return path;
}

/** Read the spec, or `null` when the task has none yet. */
export async function readSpec(tasksDir: string, id: string): Promise<string | null> {
  try {
    return await readFile(specPath(tasksDir, id), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

/**
 * Pull the numbered criteria out of the `## 验收标准` section. A draft with no
 * numbered criterion is rejected rather than softened into a pass: acceptance
 * that cannot be checked is not acceptance (ADR-0007).
 */
export function extractCriteria(specMarkdown: string): string[] {
  const lines = specMarkdown.split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s*验收标准\s*$/.test(line.trim()));
  if (start === -1) {
    throw new SpecError("spec 缺少「## 验收标准」，验收标准至少一条，且需以 C1、C2 编号");
  }
  const criteria: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s/.test(line)) break;
    const match = /^\s*[-*]\s*(C\d+)\s+(.+)$/.exec(line);
    if (match) {
      criteria.push(`${match[1]} ${match[2]!.trim()}`);
    }
  }
  if (criteria.length === 0) {
    throw new SpecError("验收标准至少一条，且需以 C1、C2 编号");
  }
  return criteria;
}
