import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Model fallback chains.
 *
 * A provider rejection (429 / quota / auth / 5xx) says nothing about the work:
 * it is a statement about one account. Retrying the same exhausted model until
 * `retryLimit` is the one failure mode a single-model setup cannot escape, so
 * each role may declare a chain of alternatives after its primary model.
 *
 * The rotation index lives in `tasks/<id>/models.json` rather than
 * `attempt.json`, because it has to survive the very retries it causes: a new
 * attempt starts from a fresh record, and would otherwise forget that the head
 * of the chain is the model that just refused.
 *
 * It is advisory state, not evidence. A damaged file reads as "start at the
 * head" — losing the index costs one rejected attempt, while refusing to run
 * would strand a healthy task over a cache file.
 */
export type ModelRole = "worker" | "reviewer";
export type ModelRotation = { worker?: number; reviewer?: number; reason?: string; updatedAt?: string };
export type Handover = { role: ModelRole; from: string; to: string; index: number };

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

/** The model at a rotation index; an unusable index means the head of the chain. */
export function modelAt(chain: readonly string[], index: number | undefined): string | undefined {
  const at = index ?? 0;
  return Number.isInteger(at) && at >= 0 && at < chain.length ? chain[at] : chain[0];
}

function indexOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

export async function readModelRotation(tasksDir: string, id: string): Promise<ModelRotation> {
  let raw: string;
  try {
    raw = await readFile(join(tasksDir, id, FILE), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (typeof parsed !== "object" || parsed === null) return {};
    return {
      worker: indexOf(parsed.worker),
      reviewer: indexOf(parsed.reviewer),
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
  await rename(tmp, file);
}

/**
 * Advance one role to the next model in its chain, or report that the chain is
 * spent. The write is a plain read-modify-write under a unique temp name: two
 * controllers can only rotate the same task if the task lock was stolen, and in
 * that case the loser's fencing token makes its write irrelevant.
 */
export async function rotateModel(
  tasksDir: string,
  id: string,
  role: ModelRole,
  chain: readonly string[],
  reason: string,
  now: Date = new Date(),
): Promise<Handover | null> {
  const current = await readModelRotation(tasksDir, id);
  const index = current[role] ?? 0;
  const next = index + 1;
  if (next >= chain.length) return null;
  await writeModelRotation(tasksDir, id, { ...current, [role]: next, reason, updatedAt: now.toISOString() });
  return { role, from: modelAt(chain, index) ?? "", to: chain[next] as string, index: next };
}

/** Back to the head of every chain — a manual retry is a fresh start. */
export async function resetModelRotation(tasksDir: string, id: string): Promise<void> {
  await writeModelRotation(tasksDir, id, {});
}
