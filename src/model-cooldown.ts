import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withMutex } from "./mutex.js";

export type ModelCooldownEntry = {
  model: string;
  observedAt: string;
  retryAfter: string;
  category: "quota" | "provider";
  reason: string;
};

type CooldownStore = { version: 1; models: Record<string, ModelCooldownEntry> };

const directory = (tasksDir: string) => join(tasksDir, "..", ".taskctl");
const file = (tasksDir: string) => join(directory(tasksDir), "model-cooldowns.json");
const lock = (tasksDir: string) => join(directory(tasksDir), "model-cooldowns.lock");

/** Read an unexpired refusal for one exact provider/model, if any. */
export async function modelCooldown(tasksDir: string, model: string, now: Date = new Date()): Promise<ModelCooldownEntry | null> {
  const store = await readStore(tasksDir);
  const entry = store.models[model];
  if (!entry) return null;
  const retryAfter = Date.parse(entry.retryAfter);
  return Number.isFinite(retryAfter) && retryAfter > now.getTime() ? entry : null;
}

/** Earliest active retry window among a chain, used when every model is cooling. */
export async function nextModelCooldown(tasksDir: string, chain: readonly string[], now: Date = new Date()): Promise<ModelCooldownEntry | null> {
  const entries = await Promise.all(chain.map((model) => modelCooldown(tasksDir, model, now)));
  return entries.filter((entry): entry is ModelCooldownEntry => entry !== null)
    .sort((a, b) => Date.parse(a.retryAfter) - Date.parse(b.retryAfter))[0] ?? null;
}

/** Record a refusal shared by every task and run on this board. */
export async function noteModelRefusal(
  tasksDir: string,
  model: string,
  options: { reason: string; category?: "quota" | "provider"; cooldownMs: number; now?: Date },
): Promise<ModelCooldownEntry> {
  const now = options.now ?? new Date();
  const entry: ModelCooldownEntry = {
    model,
    observedAt: now.toISOString(),
    retryAfter: new Date(now.getTime() + options.cooldownMs).toISOString(),
    category: options.category ?? "provider",
    reason: options.reason.slice(0, 1_000),
  };
  await mutate(tasksDir, (store) => {
    store.models[model] = entry;
    return store;
  });
  return entry;
}

/** A successful dispatch clears only that model's old refusal. */
export async function clearModelCooldown(tasksDir: string, model: string): Promise<void> {
  await mutate(tasksDir, (store) => {
    delete store.models[model];
    return store;
  });
}

async function mutate(tasksDir: string, update: (store: CooldownStore) => CooldownStore): Promise<void> {
  await mkdir(directory(tasksDir), { recursive: true });
  await withMutex(lock(tasksDir), async () => {
    const store = update(await readStore(tasksDir));
    const target = file(tasksDir);
    const tmp = `${target}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(store, null, 2), "utf8");
    await rename(tmp, target);
  });
}

async function readStore(tasksDir: string): Promise<CooldownStore> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file(tasksDir), "utf8"));
  } catch {
    return { version: 1, models: {} };
  }
  if (typeof parsed !== "object" || parsed === null) return { version: 1, models: {} };
  const models = (parsed as Record<string, unknown>).models;
  if (typeof models !== "object" || models === null || Array.isArray(models)) return { version: 1, models: {} };
  const valid: Record<string, ModelCooldownEntry> = {};
  for (const [key, value] of Object.entries(models as Record<string, unknown>)) {
    if (!validEntry(key, value)) continue;
    valid[key] = value;
  }
  return { version: 1, models: valid };
}

function validEntry(model: string, value: unknown): value is ModelCooldownEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return entry.model === model
    && typeof entry.observedAt === "string"
    && typeof entry.retryAfter === "string"
    && (entry.category === "quota" || entry.category === "provider")
    && typeof entry.reason === "string";
}
