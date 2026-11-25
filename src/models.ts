import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { renameWithRetry } from "./replace.js";
import { join } from "node:path";

/**
 * Model fallback chains.
 *
 * A provider rejection (429 / quota / auth / 5xx) says nothing about the work:
 * it is a statement about one account. Retrying the same exhausted model until
 * `retryLimit` is the one failure mode a single-model setup cannot escape, so
 * each role may declare a chain of alternatives after its primary model.
 *
 * The rotation lives in `tasks/<id>/models.json` rather than `attempt.json`,
 * because it has to survive the very retries it causes: a new attempt starts
 * from a fresh record, and would otherwise forget that the head of the chain is
 * the model that just refused.
 *
 * It is advisory state, not evidence, and that shapes both halves of the I/O:
 *
 * - reads are total. A missing, unreadable, truncated or nonsensical file means
 *   "start at the head". Losing the position costs one rejected attempt; letting
 *   the error escape would push a settled turn into `uncertain`, leak the
 *   workspace reservation, and abort the whole queue over a cache file.
 * - a position records *which model it chose*, not just an index. If someone
 *   changes the primary model in `taskctl.json`, an old index would silently
 *   select a fallback that no longer means what it did; re-anchoring on mismatch
 *   puts the new primary back in front.
 */
export type ModelRole = "worker" | "reviewer";

/** How far down the chain a role has moved, and the model that position was chosen for. */
export type RotationEntry = { index: number; model: string };
/**
 * How many times each role has wrapped around to the head of the chain. A wrap
 * is a re-probe of models that refused earlier — their quota window may have
 * reset while the chain was walking — so the budget is per attempt, not forever.
 */
export type ModelRotation = {
  worker?: RotationEntry;
  reviewer?: RotationEntry;
  cycles?: Partial<Record<ModelRole, number>>;
  reason?: string;
  updatedAt?: string;
};
export type Handover = { role: ModelRole; from: string; to: string };

const FILE = "models.json";

/**
 * Primary first, then the declared fallbacks; blanks and repeats are dropped.
 *
 * Without a primary the chain is empty: fallbacks are additive, never a way to
 * choose a model that nobody configured. A task's own `model` counts as the
 * primary, so a per-task model still gets the configured fallbacks.
 */
export function modelChain(primary: string | undefined, fallbacks: readonly string[] | undefined): string[] {
  const head = typeof primary === "string" ? primary.trim() : "";
  if (head === "") return [];
  const chain = [head];
  for (const candidate of fallbacks ?? []) {
    if (typeof candidate !== "string") continue;
    const name = candidate.trim();
    if (name !== "" && !chain.includes(name)) chain.push(name);
  }
  return chain;
}

/**
 * The chain a configuration describes.
 *
 * `modelChain` is the whole ordered chain when it is set — its head is the
 * primary, the rest are the alternatives — and its absence is equivalent to a
 * one-element chain `[model]`, which is what every config written before the key
 * existed means. `modelFallbacks` still appends after either form, so the two
 * ways of declaring alternatives compose instead of competing.
 */
export function configChain(
  primary: string | undefined,
  chain: readonly string[] | undefined,
  fallbacks: readonly string[] | undefined,
): string[] {
  if (chain !== undefined && chain.length > 0) {
    return modelChain(chain[0], [...chain.slice(1), ...(fallbacks ?? [])]);
  }
  return modelChain(primary, fallbacks);
}

/**
 * The chain a task's worker dispatches on: the task's own model, else the
 * configured chain, then fallbacks. With a task model the configured `model`
 * is not an alternative: the task named the model its work runs on, so that
 * one is the head, and what may follow it is the rest of the configured chain
 * and the fallbacks. The budget guard judges exactly this list.
 */
export function taskChain(
  cfg: { model?: string; modelChain?: string[]; modelFallbacks?: string[] },
  task: { model?: string },
): string[] {
  return task.model === undefined
    ? configChain(cfg.model, cfg.modelChain, cfg.modelFallbacks)
    : modelChain(task.model, [...(cfg.modelChain ?? []), ...(cfg.modelFallbacks ?? [])]);
}

/**
 * The chain the reviewer dispatches on: its own model, then its fallbacks,
 * when one is configured — never the task's or the worker's then. With no
 * reviewer model the chain is the worker's (`taskChain`), so a review that
 * inherits it starts at the task's own model. Review independence is a fresh
 * session, not a different model: the backend's default is never chosen on the
 * reviewer's behalf. One definition of it, for the worker and for the budget
 * guard.
 */
export function reviewerChain(
  cfg: { reviewerModel?: string; reviewerModelFallbacks?: string[]; model?: string; modelChain?: string[]; modelFallbacks?: string[] },
  task: { model?: string } = {},
): string[] {
  const own = modelChain(cfg.reviewerModel, cfg.reviewerModelFallbacks);
  return own.length > 0 ? own : taskChain(cfg, task);
}

/** Where the chain actually stands: a position recorded for a different model is stale. */
export function chainPosition(chain: readonly string[], entry: RotationEntry | undefined): number {
  if (entry === undefined) return 0;
  return chain[entry.index] === entry.model ? entry.index : 0;
}

function entry(value: unknown): RotationEntry | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const index = record.index;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0) return undefined;
  if (typeof record.model !== "string" || record.model.length === 0) return undefined;
  return { index, model: record.model };
}

export async function readModelRotation(tasksDir: string, id: string): Promise<ModelRotation> {
  let raw: string;
  try {
    raw = await readFile(join(tasksDir, id, FILE), "utf8");
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (typeof parsed !== "object" || parsed === null) return {};
    return {
      worker: entry(parsed.worker),
      reviewer: entry(parsed.reviewer),
      ...(typeof parsed.cycles === "object" && parsed.cycles !== null
        ? {
            cycles: {
              ...(typeof (parsed.cycles as Record<string, unknown>).worker === "number" ? { worker: (parsed.cycles as Record<string, number>).worker } : {}),
              ...(typeof (parsed.cycles as Record<string, unknown>).reviewer === "number" ? { reviewer: (parsed.cycles as Record<string, number>).reviewer } : {}),
            },
          }
        : {}),
      ...(typeof parsed.reason === "string" ? { reason: parsed.reason } : {}),
      ...(typeof parsed.updatedAt === "string" ? { updatedAt: parsed.updatedAt } : {}),
    };
  } catch {
    return {};
  }
}

export async function writeModelRotation(tasksDir: string, id: string, rotation: ModelRotation): Promise<void> {
  const dir = join(tasksDir, id);
  await mkdir(dir, { recursive: true });
  const file = join(dir, FILE);
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(rotation, null, 2), "utf8");
  await renameWithRetry(tmp, file);
}

/**
 * Advance one role to the next model in its chain, or report that the chain is
 * spent.
 *
 * With `maxCycles > 0` the chain is a cycle, not a queue: reaching the tail
 * wraps back to the head (a model that refused earlier may have recovered —
 * quota windows reset while the chain walks) until the wrap budget is spent.
 * Only then is the chain truly "spent" and the caller parks the task for a
 * human instead of retrying.
 *
 * A failed write throws: the caller contains it (see `fallBack` in the worker),
 * because a rotation that cannot be recorded must not be reported as progress.
 * Writing is how the position survives the retry, so an unrecorded handover
 * would send the next turn back to the model that just refused.
 */
export async function rotateModel(
  tasksDir: string,
  id: string,
  role: ModelRole,
  chain: readonly string[],
  reason: string,
  maxCycles = 0,
  now: Date = new Date(),
): Promise<Handover | null> {
  const current = await readModelRotation(tasksDir, id);
  const index = chainPosition(chain, current[role]);
  const next = index + 1;
  const cycles = current.cycles?.[role] ?? 0;
  if (next >= chain.length) {
    if (chain.length === 0 || cycles >= maxCycles) return null;
    const to = chain[0]!;
    await writeModelRotation(tasksDir, id, {
      ...current,
      [role]: { index: 0, model: to },
      cycles: { ...current.cycles, [role]: cycles + 1 },
      reason,
      updatedAt: now.toISOString(),
    });
    return { role, from: chain[index]!, to };
  }
  const to = chain[next]!;
  await writeModelRotation(tasksDir, id, {
    ...current,
    [role]: { index: next, model: to },
    cycles: current.cycles,
    reason,
    updatedAt: now.toISOString(),
  });
  return { role, from: chain[index]!, to };
}

/**
 * Give a role a fresh wrap budget for a new attempt. The position stays where
 * it is — a rerun still does not retry the dead head first — but the chain may
 * wrap around to it again, so a recovered model re-enters the rotation instead
 * of the task parking forever on a tail that never comes back. Advisory, like
 * the rotation itself: a lost or unreadable file is a no-op, never an error.
 */
export async function resetChainCycles(tasksDir: string, id: string, role: ModelRole): Promise<void> {
  try {
    const current = await readModelRotation(tasksDir, id);
    if ((current.cycles?.[role] ?? 0) === 0) return;
    await writeModelRotation(tasksDir, id, { ...current, cycles: { ...current.cycles, [role]: 0 } });
  } catch {
    // Advisory state only: a reset that cannot be read or written costs at
    // most one rejected dispatch, never a task.
  }
}
