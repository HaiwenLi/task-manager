import { stat } from "node:fs/promises";
import { join } from "node:path";
import { latestNote } from "./handoff.js";
import { readRuntime } from "./runtime.js";
import type { Task } from "./task-file.js";

/** Longest summary of one dependency, in code points. */
const PER_DEPENDENCY_CHARS = 600;
/** Longest summary overall, however many dependencies there are. */
export const DEPENDENCY_SUMMARY_CHARS = 3_000;
/** Room kept for the line that says how much was left out. */
const MARKER_RESERVE = 120;

/**
 * What each dependency produced, for the task that has to build on it.
 *
 * An integrating task used to start from its own text alone and re-discover
 * what its predecessors did — or worse, redo it. This hands over the facts
 * that are stable once a dependency is done: its id and title, its final
 * state, the status line of its latest handoff, the files that handoff names,
 * and where its acceptance and review evidence lives.
 *
 * It is a summary, not a transcript: no session is replayed, a handoff's
 * findings and next steps are not carried over, and the whole thing is bounded
 * however many dependencies there are.
 */
export async function dependencySummary(
  tasksDir: string,
  task: Pick<Task, "dependsOn">,
  board: Task[],
): Promise<string | null> {
  if (task.dependsOn.length === 0) return null;
  const byId = new Map(board.map((other) => [other.id, other]));
  const blocks: string[] = [];
  let used = 0;
  for (const [index, id] of task.dependsOn.entries()) {
    // Not on the board: the scheduler refuses such a board before anything
    // runs, so this is only reached by a caller that got here another way.
    const dependency = byId.get(id);
    if (dependency === undefined) continue;
    const block = await describeDependency(tasksDir, dependency);
    const cost = Array.from(block).length + 1;
    if (blocks.length > 0 && used + cost + MARKER_RESERVE > DEPENDENCY_SUMMARY_CHARS) {
      const omitted = task.dependsOn.length - index;
      blocks.push(`[…taskctl 截断：其余 ${omitted} 个依赖未列出；完整记录在各自的 tasks/<id>/ 目录]`);
      break;
    }
    blocks.push(block);
    used += cost;
  }
  return blocks.length === 0 ? null : blocks.join("\n");
}

async function describeDependency(tasksDir: string, dependency: Task): Promise<string> {
  const dir = join(tasksDir, dependency.id);
  const note = await latestNote(tasksDir, dependency.id);
  const review = await readVerdict(tasksDir, dependency.id);
  const lines = [`- ${dependency.id}「${dependency.title}」 · ${dependency.status}`];
  const status = note === null ? "" : firstLine(sectionLines(note.markdown, "Status"));
  if (status.length > 0) lines.push(`  交接状态：${status}`);
  const files = note === null ? [] : sectionLines(note.markdown, "Files").flatMap((line) => {
    const match = /^\s*-\s+(.+)$/.exec(line);
    return match ? [match[1]!.trim()] : [];
  });
  if (files.length > 0) lines.push(`  产物：${files.join(", ")}`);
  const evidence: string[] = [];
  if (await exists(join(dir, "acceptance.json"))) evidence.push(`验收记录 ${join(dir, "acceptance.json")}`);
  if (review !== null) evidence.push(`复核 ${review}`);
  if (evidence.length > 0) lines.push(`  证据：${evidence.join("；")}`);
  return clip(lines.join("\n"), PER_DEPENDENCY_CHARS);
}

/** The recorded review verdict, or `null` when there is none or it cannot be read. */
async function readVerdict(tasksDir: string, id: string): Promise<string | null> {
  try {
    const record = await readRuntime<{ verdict?: unknown }>(tasksDir, id, "review.json");
    return typeof record?.verdict === "string" ? record.verdict : null;
  } catch (err) {
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/** The lines under one `## Section` heading of a handoff note. */
function sectionLines(markdown: string, title: string): string[] {
  const lines = markdown.split(/\r?\n/);
  const start = lines.indexOf(`## ${title}`);
  if (start === -1) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    out.push(line);
  }
  return out;
}

function firstLine(lines: string[]): string {
  return lines.find((line) => line.trim().length > 0)?.trim() ?? "";
}

/** Trim to `limit` code points, marking a cut so a reader knows it happened. */
function clip(text: string, limit: number): string {
  const points = Array.from(text);
  return points.length <= limit ? text : `${points.slice(0, limit).join("")}…`;
}
