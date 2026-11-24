import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionUsageSnapshot } from "./adapters/types.js";
import { withMutex } from "./mutex.js";

export type UsageRole = "worker" | "reviewer" | "intake";
export type UsageRecord = {
  at: string;
  role: UsageRole;
  sessionId: string;
  model?: string;
  durationMs: number;
  snapshot: SessionUsageSnapshot | null;
  delta: SessionUsageSnapshot | null;
  reset: boolean;
};

export type UsageSummary = SessionUsageSnapshot & {
  role: UsageRole;
  model: string;
  unknown: number;
  resets: number;
};

const derivedDir = (tasksDir: string) => join(tasksDir, "..", ".taskctl");
const sessionsFile = (tasksDir: string) => join(derivedDir(tasksDir), "usage-sessions.json");
const usageLock = (tasksDir: string) => join(derivedDir(tasksDir), "usage.lock");

/** Append one role's usage, using a board-level baseline for shared sessions. */
export async function recordUsage(options: {
  tasksDir: string;
  id: string;
  role: UsageRole;
  sessionId: string;
  model?: string;
  durationMs: number;
  snapshot?: SessionUsageSnapshot;
  at?: Date;
}): Promise<UsageRecord> {
  await mkdir(derivedDir(options.tasksDir), { recursive: true });
  await mkdir(join(options.tasksDir, options.id), { recursive: true });
  return withMutex(usageLock(options.tasksDir), async () => {
    const previous = await readSnapshots(options.tasksDir);
    const snapshot = options.snapshot ?? null;
    const prior = previous[options.sessionId];
    const delta = snapshot === null ? null : difference(prior, snapshot);
    const model = snapshot?.model ?? options.model ?? prior?.model;
    const record: UsageRecord = {
      at: (options.at ?? new Date()).toISOString(),
      role: options.role,
      sessionId: options.sessionId,
      ...(model === undefined ? {} : { model }),
      durationMs: options.durationMs,
      snapshot,
      delta: delta === null ? null : { ...delta, ...(model === undefined ? {} : { model }) },
      reset: snapshot !== null && prior !== undefined && delta === null,
    };
    if (snapshot !== null) {
      previous[options.sessionId] = snapshot;
      await writeSnapshots(options.tasksDir, previous);
    }
    await appendFile(join(options.tasksDir, options.id, "usage.jsonl"), `${JSON.stringify(record)}\n`, "utf8");
    return record;
  });
}

export async function readUsage(tasksDir: string, id: string): Promise<UsageRecord[]> {
  let raw: string;
  try {
    raw = await readFile(join(tasksDir, id, "usage.jsonl"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return raw.split(/\r?\n/).flatMap((line) => {
    if (line.trim().length === 0) return [];
    try {
      const value = JSON.parse(line) as UsageRecord;
      return typeof value.sessionId === "string" && typeof value.role === "string" ? [value] : [];
    } catch {
      return [];
    }
  });
}

export function summarizeUsage(records: readonly UsageRecord[]): UsageSummary[] {
  const groups = new Map<string, UsageSummary>();
  for (const record of records) {
    const model = record.delta?.model ?? record.snapshot?.model ?? record.model ?? "(unknown)";
    const key = `${record.role}/${model}`;
    const group = groups.get(key) ?? {
      role: record.role, model, input: 0, output: 0, reasoning: 0,
      cacheRead: 0, cacheWrite: 0, unknown: 0, resets: 0,
    };
    if (record.delta === null) group.unknown++;
    else {
      group.input += record.delta.input;
      group.output += record.delta.output;
      group.reasoning += record.delta.reasoning;
      group.cacheRead += record.delta.cacheRead;
      group.cacheWrite += record.delta.cacheWrite;
      if (record.delta.cost !== undefined) group.cost = (group.cost ?? 0) + record.delta.cost;
    }
    if (record.reset) group.resets++;
    groups.set(key, group);
  }
  return [...groups.values()];
}

function difference(prior: SessionUsageSnapshot | undefined, current: SessionUsageSnapshot): SessionUsageSnapshot | null {
  if (prior !== undefined && (
    current.input < prior.input || current.output < prior.output || current.reasoning < prior.reasoning
    || current.cacheRead < prior.cacheRead || current.cacheWrite < prior.cacheWrite
    || (current.cost !== undefined && prior.cost !== undefined && current.cost < prior.cost)
  )) return null;
  return {
    input: current.input - (prior?.input ?? 0),
    output: current.output - (prior?.output ?? 0),
    reasoning: current.reasoning - (prior?.reasoning ?? 0),
    cacheRead: current.cacheRead - (prior?.cacheRead ?? 0),
    cacheWrite: current.cacheWrite - (prior?.cacheWrite ?? 0),
    ...(current.cost !== undefined ? { cost: current.cost - (prior?.cost ?? 0) } : {}),
  };
}

async function readSnapshots(tasksDir: string): Promise<Record<string, SessionUsageSnapshot>> {
  try {
    const parsed = JSON.parse(await readFile(sessionsFile(tasksDir), "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, SessionUsageSnapshot>
      : {};
  } catch {
    return {};
  }
}

async function writeSnapshots(tasksDir: string, snapshots: Record<string, SessionUsageSnapshot>): Promise<void> {
  const target = sessionsFile(tasksDir);
  const tmp = `${target}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(snapshots, null, 2), "utf8");
  await rename(tmp, target);
}
