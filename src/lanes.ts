import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { LANES, TEMPLATES, type ManagementLane, type TaskType } from "./intake.js";

/**
 * One operator-declared lane, kept as evidence: the material the later
 * classifier and the three description lists are built from. Written for every
 * `add` that put a task on the board, and never read back as state.
 */
export type LaneExample = {
  id: string;
  at: string;
  lane: ManagementLane;
  type: TaskType;
  title: string;
  intent: string;
  criteria: number;
};

/** Longest intent kept, in code points. */
export const LANE_INTENT_LIMIT = 500;

const FILE = "lanes.jsonl";

/** `.taskctl/lanes.jsonl` next to the tasks dir, like the feedback and audit logs. */
export function lanesPath(tasksDir: string): string {
  return join(tasksDir, "..", ".taskctl", FILE);
}

/**
 * Append one example. The directory is created on first use and the intent is
 * bounded there, so a caller never has to know the limit. The file is never
 * compacted: it is the evidence, not a cache.
 */
export async function appendLaneExample(tasksDir: string, example: LaneExample): Promise<void> {
  const file = lanesPath(tasksDir);
  await mkdir(join(file, ".."), { recursive: true });
  await appendFile(file, `${JSON.stringify({ ...example, intent: boundedIntent(example.intent) })}\n`, "utf8");
}

/** The intent on one line of the file: trimmed, and cut at the limit with a marked tail. */
function boundedIntent(intent: string): string {
  const trimmed = intent.trim();
  const points = Array.from(trimmed);
  return points.length <= LANE_INTENT_LIMIT ? trimmed : `${points.slice(0, LANE_INTENT_LIMIT).join("")}…`;
}

/** All examples, oldest first; a missing file reads as empty and a corrupt line is skipped. */
export async function readLaneExamples(tasksDir: string): Promise<LaneExample[]> {
  let raw: string;
  try {
    raw = await readFile(lanesPath(tasksDir), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const records: LaneExample[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    let record: LaneExample | null = null;
    try {
      const parsed = JSON.parse(line) as Partial<LaneExample>;
      if (isLaneExample(parsed)) record = parsed;
    } catch {
      // A corrupt line is skipped: the file is evidence, not state.
    }
    if (record !== null) records.push(record);
  }
  return records;
}

function isLaneExample(value: Partial<LaneExample>): value is LaneExample {
  return isLane(value.lane)
    && typeof value.type === "string" && value.type in TEMPLATES
    && typeof value.id === "string" && typeof value.at === "string"
    && typeof value.title === "string" && typeof value.intent === "string"
    && typeof value.criteria === "number";
}

function isLane(value: unknown): value is ManagementLane {
  return typeof value === "string" && (LANES as readonly string[]).includes(value);
}

/**
 * The examples grouped by lane, in the fixed order of `LANES`: a header with the
 * count, one line per example in file order, then — only when the intent says
 * more than the title — the whole intent on one indented line, its line breaks
 * turned into `" / "`. An empty group prints `  (none)`: that no examples exist
 * for a lane is what its reader most needs to see.
 */
export function renderLanes(examples: LaneExample[]): string[] {
  const lines: string[] = [];
  for (const lane of LANES) {
    const group = examples.filter((example) => example.lane === lane);
    lines.push(`lane ${lane} (${group.length})`);
    if (group.length === 0) {
      lines.push("  (none)");
      continue;
    }
    for (const example of group) {
      lines.push(`  ${example.at.slice(0, 10)}  ${example.id}  ${example.type}  criteria=${example.criteria}  ${example.title}`);
      if (example.intent !== example.title) {
        lines.push(`      ${example.intent.replace(/\r\n|\r|\n/g, " / ")}`);
      }
    }
  }
  return lines;
}
