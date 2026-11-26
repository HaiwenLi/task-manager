import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { modelCooldown } from "./model-cooldown.js";
import { readRuntime, writeRuntime } from "./runtime.js";

/** The runtime file a deferral is written to, beside `attempt.json`. */
export const MODEL_WAIT_FILE = "model-wait.json";

export const MODEL_ROUNDS_DEFAULT = 4;
export const MODEL_COOLDOWN_MS_DEFAULT = 60_000;

/** The one model a run serves when no chain is configured, as the evidence keys it. */
export const DEFAULT_MODEL_KEY = "(default)";

export type ModelWaitStage = "worker" | "review";

export type ModelRefusal = { model: string; at: string; reason: string; source: "turn" | "table" };

export type ModelWaitRecord = {
  runId: string;
  stage: ModelWaitStage;
  /** Rounds of this run in which this task itself was refused by every model it tried. */
  rounds: number;
  /** When this run's first refusal of this task happened; null while the task itself was never refused. */
  firstRefusedAt: string | null;
  /** The latest refusal of each model tried or skipped in the last round, in the order first tried. */
  refusals: ModelRefusal[];
  /** Earliest time at which the task may be claimed again. */
  nextAt: string;
  updatedAt: string;
};

export type ModelWaitHold = { kind: "window"; nextAt: string; rounds: number } | { kind: "exhausted"; rounds: number };

/** What one `run` / `watch` / `retry` process remembers across its tasks. */
export type RunContext = { id: string; accepted: Map<string, number> };

export type ModelWaitConfig = { tasksDir: string; run?: RunContext; modelRounds?: number };

/** A run's context: its id is its start time, so a record names the run that wrote it. */
export function newRunContext(now: Date = new Date()): RunContext {
  return { id: now.toISOString(), accepted: new Map() };
}

let processContext: RunContext | null = null;

/** The one context callers that pass none share, so a forgotten context can never defer a task forever. */
export function processRun(): RunContext {
  processContext ??= newRunContext();
  return processContext;
}

/** The unnamed default model is one model, keyed like every entry of a chain. */
export const modelKey: (model: string | undefined) => string = (model) => model ?? DEFAULT_MODEL_KEY;

/** A chain with no entries still names one model to ask about: the default. */
export function chainKeys(chain: readonly string[]): string[] {
  return chain.length === 0 ? [DEFAULT_MODEL_KEY] : chain.map(modelKey);
}

export function modelRoundsOf(cfg: { modelRounds?: number }): number {
  return cfg.modelRounds ?? MODEL_ROUNDS_DEFAULT;
}

export function modelCooldownMsOf(cfg: { modelCooldownMs?: number }): number {
  return cfg.modelCooldownMs ?? MODEL_COOLDOWN_MS_DEFAULT;
}

/**
 * What a refused turn said, without naming the model twice: the first
 * non-empty line of its output (or `no output`), after the exit code and, when
 * the duration is known, the time it took.
 */
export function refusalReason(result: { exitCode: number; text?: string; durationMs?: number }): string {
  const first = (result.text ?? "").split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? "no output";
  const exit = result.durationMs === undefined ? `exit ${result.exitCode}` : `exit ${result.exitCode} in ${result.durationMs}ms`;
  return `${exit}, ${first.slice(0, 240)}`;
}

/** One refusal per model: the latest, in the order first tried. */
export function addRefusal(list: readonly ModelRefusal[], refusal: ModelRefusal): ModelRefusal[] {
  const next = [...list];
  const index = next.findIndex((entry) => entry.model === refusal.model);
  if (index === -1) next.push(refusal);
  else next[index] = refusal;
  return next;
}

/** What this task tried comes first; the models already cooling follow, once each. */
export function mergeRefusals(tried: readonly ModelRefusal[], cooling: readonly ModelRefusal[]): ModelRefusal[] {
  const triedModels = new Set(tried.map((entry) => entry.model));
  return [...tried, ...cooling.filter((entry) => !triedModels.has(entry.model))];
}

/** The first model of the chain another turn was accepted on strictly after `since`, else null. */
export function servedSince(run: RunContext, chain: readonly string[], since: number): string | null {
  for (const key of chainKeys(chain)) {
    const acceptedAt = run.accepted.get(key);
    if (acceptedAt !== undefined && acceptedAt > since) return key;
  }
  return null;
}

/** Whole seconds: below a minute `<s>s`, else `<m>m <ss>s` with the seconds padded to two. */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** A chain model's active table entry, read as a refusal of this task. */
export async function coolingRefusals(tasksDir: string, chain: readonly string[], now: Date = new Date()): Promise<ModelRefusal[]> {
  const entries = await Promise.all(chain.map(async (model) => ({ model, cooling: await modelCooldown(tasksDir, model, now) })));
  return entries.flatMap(({ model, cooling }) =>
    cooling === null ? [] : [{ model, at: cooling.observedAt, reason: cooling.reason, source: "table" as const }],
  );
}

/**
 * A record that cannot be read is no deferral: a missing file, an unparsable
 * one and a malformed one all read as null, like every other reader of a
 * runtime record.
 */
export async function readModelWait(tasksDir: string, id: string): Promise<ModelWaitRecord | null> {
  let parsed: unknown;
  try {
    parsed = await readRuntime<unknown>(tasksDir, id, MODEL_WAIT_FILE);
  } catch (err) {
    if (err instanceof SyntaxError) return null;
    throw err;
  }
  return isModelWaitRecord(parsed) ? parsed : null;
}

export async function writeModelWait(tasksDir: string, id: string, record: ModelWaitRecord): Promise<void> {
  await mkdir(join(tasksDir, id), { recursive: true });
  await writeRuntime(tasksDir, id, MODEL_WAIT_FILE, record);
}

/** Cleared without a trace, whether or not a record exists. */
export async function clearModelWait(tasksDir: string, id: string): Promise<void> {
  await rm(join(tasksDir, id, MODEL_WAIT_FILE), { force: true });
}

/**
 * What keeps a task from being offered now, in this order: exhausted when this
 * run itself spent the rounds; else a window while `nextAt` is later than now;
 * else nothing. Exhausted is not a verdict — it only keeps the task from being
 * offered between the attempt that ran out of rounds and the controller's
 * decision.
 */
export function modelWaitHold(record: ModelWaitRecord | null, runId: string, modelRounds: number, now: Date): ModelWaitHold | null {
  if (record === null) return null;
  if (record.rounds >= modelRounds && record.runId === runId) return { kind: "exhausted", rounds: record.rounds };
  const nextAt = Date.parse(record.nextAt);
  if (Number.isFinite(nextAt) && nextAt > now.getTime()) return { kind: "window", nextAt: record.nextAt, rounds: record.rounds };
  return null;
}

/** The held tasks of a board, by id, and nothing else. */
export async function modelWaitHolds(cfg: ModelWaitConfig, ids: readonly string[], now: Date = new Date()): Promise<Map<string, ModelWaitHold>> {
  const records = await Promise.all(ids.map((id) => readModelWait(cfg.tasksDir, id)));
  const runId = cfg.run?.id ?? processRun().id;
  const modelRounds = modelRoundsOf(cfg);
  const holds = new Map<string, ModelWaitHold>();
  records.forEach((record, index) => {
    const hold = modelWaitHold(record, runId, modelRounds, now);
    if (hold !== null) holds.set(ids[index], hold);
  });
  return holds;
}

function isModelWaitRecord(value: unknown): value is ModelWaitRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.runId === "string"
    && (record.stage === "worker" || record.stage === "review")
    && typeof record.rounds === "number"
    && Number.isInteger(record.rounds)
    && record.rounds >= 0
    && (typeof record.firstRefusedAt === "string" || record.firstRefusedAt === null)
    && Array.isArray(record.refusals)
    && record.refusals.every(isModelRefusal)
    && typeof record.nextAt === "string"
    && typeof record.updatedAt === "string";
}

function isModelRefusal(value: unknown): value is ModelRefusal {
  if (typeof value !== "object" || value === null) return false;
  const refusal = value as Record<string, unknown>;
  return typeof refusal.model === "string"
    && typeof refusal.at === "string"
    && typeof refusal.reason === "string"
    && (refusal.source === "turn" || refusal.source === "table");
}
