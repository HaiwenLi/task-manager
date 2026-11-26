import type { AgentAdapter, CatalogueCost, CatalogueModel } from "./adapters/types.js";
import { reviewerChain, taskChain } from "./models.js";
import type { Task } from "./task-file.js";
import type { WorkerConfig } from "./worker.js";

/**
 * The budget guard: which models may run, judged from the cost the backend
 * reports for them.
 *
 * A provider rejection says nothing about the work, so a task walks a chain
 * of models, and nothing said what those models cost. On 2026-11-25 a chain
 * copied from an older project ran six tasks on pay-per-token models while
 * the same machine's subscription models cost nothing. So every model a task
 * may run on is judged before anything is claimed — and once more after the
 * claim, before any session starts, on the task as the board then holds it —
 * and what was not allowed explicitly is refused:
 *
 * - `free` (every reported price is 0) runs unless `allowedProviders` is set
 *   and leaves the provider out;
 * - `paid` (some reported price is not 0) needs `allowedModels` to name it,
 *   `allowPaidModels`, or a `maxCostPerMillion` it does not exceed;
 * - `unknown` (no catalogue entry, or no reported price) needs `allowedModels`
 *   to name it or `allowedProviders` to name its provider. Kimi Coding Plan's
 *   models report no cost, which is why that provider has to be named:
 *   allowing is always explicit.
 *
 * A disabled model is never allowed. An adapter that cannot list models is
 * not guarded at all. Everything else fails closed: a catalogue that cannot
 * be read, that times out or that is empty refuses every model the call asked
 * about, because none of that is a stable truth about a backend that can run
 * anything (one probe of the real service saw no models where three later
 * probes saw 124 each).
 *
 * `checkModels` and `judgeRefs` never throw: a backend that cannot be read is
 * a refusal, not an exception (`catalogueOf` and `defaultRefOf` do reject, to
 * say so). Nothing here quotes a catalogue entry: the backend's own records
 * carry credentials, so a verdict holds only the fields it was built from.
 */

/** What a configuration allows. All four may be absent; see {@link classify} for how each class is judged. */
export type BudgetPolicy = { allowedProviders?: string[]; allowedModels?: string[]; allowPaidModels?: boolean; maxCostPerMillion?: number };

/** `free`: every reported price is 0. `paid`: some reported price is not. `unknown`: no catalogue entry, or no reported price. */
export type CostClass = "free" | "paid" | "unknown";

export type ModelVerdict = {
  ref: string; providerID: string; costClass: CostClass;
  dollarsPerMillion: number | null; enabled: boolean | null; variants: string[];
  allowed: boolean; reason?: string;
};

/** How long one read of the backend may take before the guard gives up on it. */
export const CATALOGUE_TIMEOUT_MS = 30_000;

export type GuardState = {
  /** `${taskId}\n${refs}` keys already reported in this process. */
  reported: Set<string>;
  /**
   * At most one fetch per adapter and directory, keyed by the directory the
   * catalogue was asked in. An entry is deleted the moment its promise rejects,
   * so a failure is never remembered.
   */
  catalogues: WeakMap<AgentAdapter, Map<string, Promise<CatalogueModel[]>>>;
  /** The same, per directory, for the backend's default model. A backend without one answers `null`, and that is kept. */
  defaultRefs: WeakMap<AgentAdapter, Map<string, Promise<string | null>>>;
  timeoutMs: number;
};

/** What the verdict of a failed read says: nothing the call asked about may run. */
const UNREADABLE = "模型目录读不到";
const EMPTY = "模型目录是空的（后端没有报出任何模型）";
const UNJUDGED = "护栏无法判定";
const UNCONFIRMED_DEFAULT = "后端默认模型无法确认";
/** The ref of the verdict that stands for a default model nobody could name. */
const BACKEND_DEFAULT = "(backend default)";
/** How much of an error message a reason quotes. */
const MESSAGE_CHARS = 200;

/** The state callers use when they pass none: one per process. */
let moduleState: GuardState = newGuardState(CATALOGUE_TIMEOUT_MS);

export function newGuardState(timeoutMs?: number): GuardState {
  return {
    reported: new Set<string>(),
    catalogues: new WeakMap(),
    defaultRefs: new WeakMap(),
    timeoutMs: timeoutMs ?? CATALOGUE_TIMEOUT_MS,
  };
}

/** Forgets what was reported and fetched. Tests call `resetGuardState()` in `beforeEach`; with no argument it resets the module's own state. */
export function resetGuardState(state: GuardState = moduleState): void {
  state.reported.clear();
  // A WeakMap cannot be emptied in place, and a fetch kept across a reset is a fetch nobody has asked for since.
  state.catalogues = new WeakMap();
  state.defaultRefs = new WeakMap();
}

/**
 * Whether a refusal of this task was not yet reported in this process. The
 * first call for a task and its refused refs says `true` and records the key
 * `${taskId}\n${JSON.stringify(refs)}` in the state's `reported` set; a later
 * call with the same task and refs says `false`. With no state it uses the
 * module's own, so `resetGuardState()` resets it.
 */
export function noteReported(taskId: string, refs: readonly string[], state: GuardState = moduleState): boolean {
  const key = `${taskId}\n${JSON.stringify(refs)}`;
  if (state.reported.has(key)) return false;
  state.reported.add(key);
  return true;
}

/** The four budget keys of a configuration, each present only when it is set (a cap of 0 is a setting). */
export function policyOf(cfg: Pick<WorkerConfig, "allowedProviders" | "allowedModels" | "allowPaidModels" | "maxCostPerMillion">): BudgetPolicy {
  const { allowedProviders, allowedModels, allowPaidModels, maxCostPerMillion } = cfg;
  return {
    ...(allowedProviders === undefined ? {} : { allowedProviders }),
    ...(allowedModels === undefined ? {} : { allowedModels }),
    ...(allowPaidModels === undefined ? {} : { allowPaidModels }),
    ...(maxCostPerMillion === undefined ? {} : { maxCostPerMillion }),
  };
}

/** A model without its variant: everything from the first `#` is dropped, since a variant is the same model at another effort. */
export function baseRef(model: string): string {
  const hash = model.indexOf("#");
  return hash < 0 ? model : model.slice(0, hash);
}

/**
 * Judge one model against the catalogue under a policy. `catalogue === null`
 * means the adapter cannot list models: nothing is known and nothing is
 * refused. An entry is the one with that provider whose `id` is the model, or
 * whose `modelID` is the model when no `id` matches.
 */
export function classify(ref: string, catalogue: readonly CatalogueModel[] | null, policy: BudgetPolicy): ModelVerdict {
  const base = baseRef(ref);
  const slash = base.indexOf("/");
  const providerID = slash < 0 ? "" : base.slice(0, slash);
  const model = slash < 0 ? base : base.slice(slash + 1);
  const absent: ModelVerdict = { ref: base, providerID, costClass: "unknown", dollarsPerMillion: null, enabled: null, variants: [], allowed: false };
  if (catalogue === null) return { ...absent, allowed: true };
  const entry = catalogue.find((m) => m.providerID === providerID && m.id === model)
    ?? catalogue.find((m) => m.providerID === providerID && m.modelID === model);
  if (entry === undefined) return decide(absent, policy);
  const price = priceOf(entry.cost);
  const costClass: CostClass = entry.cost.length === 0 ? "unknown" : price === 0 ? "free" : "paid";
  const verdict: ModelVerdict = {
    ref: base, providerID, costClass,
    dollarsPerMillion: costClass === "unknown" ? null : price,
    enabled: entry.enabled, variants: [...entry.variants], allowed: false,
  };
  if (entry.enabled === false) return { ...verdict, reason: "后端里已禁用" };
  return decide(verdict, policy);
}

/**
 * The models the worker of one task may run on: exactly the chain the worker
 * dispatches on (`taskChain`), so the guard judges no model the worker would
 * never run and misses none it might.
 */
export function workerModels(cfg: WorkerConfig, task: Task): string[] {
  return unique(taskChain(cfg, task));
}

/**
 * The models the reviewer may run on: `reviewerChain(cfg, task)` — its own
 * chain when one is configured, else the worker's chain, the task's own model
 * included. The task is optional so `taskctl models` keeps judging the
 * configuration alone: a task's own model is listed there on its own.
 */
export function reviewerModels(cfg: WorkerConfig, task: Pick<Task, "model"> = { model: undefined }): string[] {
  return unique(reviewerChain(cfg, task));
}

/**
 * `null` when the adapter has no `modelCatalog`. Rejects when the call fails
 * or exceeds the state's timeout. The catalogue is read in `cwd` — the
 * directory the session runs in, since the backend answers by it — and kept
 * per adapter and directory; with no directory it is the process's own.
 */
export function catalogueOf(adapter: AgentAdapter, state: GuardState = moduleState, cwd?: string): Promise<CatalogueModel[] | null> {
  if (typeof adapter.modelCatalog !== "function") return Promise.resolve(null);
  // An empty list is no answer: zero models is never a stable truth about a backend that can run anything.
  return kept(state.catalogues, adapter, cwd, state.timeoutMs, () => adapter.modelCatalog!(cwd), (models) => !Array.isArray(models) || models.length === 0);
}

/**
 * `null` when the backend has no default. Rejects when it cannot be read; a
 * failure is not remembered. Read in `cwd` and kept per directory, like the
 * catalogue ({@link catalogueOf}).
 */
export function defaultRefOf(adapter: AgentAdapter, state: GuardState = moduleState, cwd?: string): Promise<string | null> {
  if (typeof adapter.defaultModelRef !== "function") return Promise.resolve(null);
  return kept(state.defaultRefs, adapter, cwd, state.timeoutMs, () => adapter.defaultModelRef!(cwd), () => false);
}

/**
 * The disallowed verdicts for the roles that will run in one task. An absent
 * role is not judged. Never throws: an adapter that cannot list models answers
 * `[]`, and a backend that cannot be read refuses everything it was asked about.
 * The backend is asked in `cfg.workdir`: the directory the task's sessions
 * start in, which the backend answers by.
 */
export async function checkModels(
  cfg: WorkerConfig,
  adapter: AgentAdapter,
  roles: { worker?: readonly string[]; reviewer?: readonly string[] },
  state: GuardState = moduleState,
): Promise<ModelVerdict[]> {
  // No catalogue, no guard: the fakes that never list models must pass untouched.
  if (typeof adapter.modelCatalog !== "function") return [];
  const lists = [roles.worker, roles.reviewer].filter((list): list is readonly string[] => list !== undefined);
  if (lists.length === 0) return [];
  const asked = unique(lists.flat());
  try {
    // A role with an empty chain runs on the backend default, so that is judged too, once.
    const verdicts = await judge(asked, lists.some((list) => list.length === 0), policyOf(cfg), adapter, state, cfg.workdir);
    return verdicts.filter((v) => !v.allowed);
  } catch (error) {
    return closed(asked, `${UNJUDGED}（${messageOf(error)}）`);
  }
}

/**
 * Every verdict for one list of refs, each ref once, in the order given; an
 * empty list judges the backend default. Never throws. The backend is asked
 * in `cwd`, the directory the session would start in; with none, in the
 * process's own.
 */
export async function judgeRefs(
  refs: readonly string[],
  policy: BudgetPolicy,
  adapter: AgentAdapter,
  state: GuardState = moduleState,
  cwd?: string,
): Promise<ModelVerdict[]> {
  if (typeof adapter.modelCatalog !== "function") return [];
  const asked = unique(refs);
  try {
    return await judge(asked, asked.length === 0, policy, adapter, state, cwd);
  } catch (error) {
    return closed(asked.length > 0 ? asked : [BACKEND_DEFAULT], `${UNJUDGED}（${messageOf(error)}）`);
  }
}

/** One line per verdict, built from the verdict's own fields only. */
export function renderVerdicts(verdicts: readonly ModelVerdict[]): string {
  return verdicts.map((verdict) => {
    const cost = verdict.costClass === "free"
      ? "免费"
      : verdict.costClass === "paid"
        ? `按量计费，约 $${shown(verdict.dollarsPerMillion)} / 百万 token`
        : "成本未知";
    return `- ${verdict.ref}  provider=${verdict.providerID || "-"}  enabled=${verdict.enabled ?? "-"}  variants=${verdict.variants.join(",") || "-"}  ${verdict.allowed ? `放行（${cost}）` : `拒绝：${verdict.reason}`}`;
  }).join("\n");
}

/**
 * Judge every ref once against the backend's catalogue, and the backend
 * default when a chain is empty. The default is judged as if it were in the
 * chain, so it names the default's own ref; a default nobody could name is
 * its own verdict. A catalogue that cannot be read, or that is empty, refuses
 * every ref it was asked about. Both reads are made in `cwd`.
 */
async function judge(
  asked: readonly string[],
  onDefault: boolean,
  policy: BudgetPolicy,
  adapter: AgentAdapter,
  state: GuardState,
  cwd?: string,
): Promise<ModelVerdict[]> {
  // Both reads go out together, so a backend that answers neither costs one timeout, not two.
  const [fallback, listing] = await Promise.allSettled([
    onDefault ? defaultRefOf(adapter, state, cwd) : Promise.resolve<string | null>(null),
    catalogueOf(adapter, state, cwd),
  ]);
  const refs = [...asked];
  const verdicts: ModelVerdict[] = [];
  if (onDefault) {
    const ref = fallback.status === "fulfilled" && typeof fallback.value === "string" ? baseRef(fallback.value) : "";
    // Absent, unreadable or timed out: the role still runs on some model, and nobody can say which.
    if (ref === "") verdicts.push(unconfirmedDefault());
    else if (!refs.includes(ref)) refs.push(ref);
  }
  if (listing.status === "rejected") {
    return [...closed(refs, `${UNREADABLE}（${head(messageOf(listing.reason))}）`), ...verdicts];
  }
  // `null` cannot happen here (the callers return before an adapter without `modelCatalog`); one would still be no models.
  const catalogue = listing.value ?? [];
  if (catalogue.length === 0) return [...closed(refs, EMPTY), ...verdicts];
  return [...refs.map((ref) => classify(ref, catalogue, policy)), ...verdicts];
}

/** The allowed flag, and the reason when the answer is no. The reason is the same whatever made the class fall short. */
function decide(verdict: ModelVerdict, policy: BudgetPolicy): ModelVerdict {
  const { allowedProviders, allowedModels, allowPaidModels, maxCostPerMillion } = policy;
  const named = allowedModels?.includes(verdict.ref) === true;
  const providerNamed = allowedProviders?.includes(verdict.providerID) === true;
  const price = verdict.dollarsPerMillion;
  const allowed = verdict.costClass === "free"
    ? allowedProviders === undefined || allowedProviders.length === 0 || providerNamed
    : verdict.costClass === "paid"
      ? named || allowPaidModels === true || (maxCostPerMillion !== undefined && price !== null && maxCostPerMillion >= price)
      : named || providerNamed;
  if (allowed) return { ...verdict, allowed: true };
  const reason = verdict.costClass === "free"
    ? `provider ${verdict.providerID} 不在 allowedProviders 里`
    : verdict.costClass === "paid"
      ? `按量计费，约 $${shown(price)} / 百万 token；未列入 allowedModels`
      : "成本未知（目录里没有它，或它不报成本）；未列入 allowedModels，provider 也不在 allowedProviders 里";
  return { ...verdict, reason };
}

/** Every ref answered the same way: unknown, and not allowed. */
function closed(refs: readonly string[], reason: string): ModelVerdict[] {
  return refs.map((ref) => ({
    ref, providerID: providerOf(ref), costClass: "unknown", dollarsPerMillion: null, enabled: null, variants: [], allowed: false, reason,
  }));
}

function unconfirmedDefault(): ModelVerdict {
  return { ref: BACKEND_DEFAULT, providerID: "", costClass: "unknown", dollarsPerMillion: null, enabled: null, variants: [], allowed: false, reason: UNCONFIRMED_DEFAULT };
}

/**
 * The one promise a state keeps per adapter and directory for a read of the
 * backend, bounded by the state's timeout. It is dropped the moment it
 * rejects, and when it answers nothing usable, so the next call asks again: a
 * failure is never remembered, and neither is an empty answer — for that
 * directory, while another directory's answer stays.
 */
function kept<T>(
  slot: WeakMap<AgentAdapter, Map<string, Promise<T>>>,
  adapter: AgentAdapter,
  cwd: string | undefined,
  timeoutMs: number,
  read: () => Promise<T>,
  answersNothing: (value: T) => boolean,
): Promise<T> {
  // No directory is the process's own, which is where an adapter asks without one: one entry for both.
  const directory = cwd ?? process.cwd();
  const perDirectory = slot.get(adapter) ?? new Map<string, Promise<T>>();
  slot.set(adapter, perDirectory);
  const pending = perDirectory.get(directory);
  if (pending !== undefined) return pending;
  const started = bounded(read, timeoutMs);
  perDirectory.set(directory, started);
  // Only its own entry: a reset, or a later fetch, must not be undone by this one settling late.
  const forget = () => {
    const current = slot.get(adapter);
    if (current === perDirectory && current.get(directory) === started) current.delete(directory);
  };
  void started.then((value) => { if (answersNothing(value)) forget(); }, forget);
  return started;
}

/** A read that gives up after `ms`: a backend that never answers must not hold the guard, and the queue behind it, forever. */
function bounded<T>(read: () => Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer within ${ms}ms`)), ms);
    // `read` runs inside the promise, so one that throws before it answers rejects instead of throwing into the caller.
    Promise.resolve().then(read).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))); },
    );
  });
}

/** Variant suffixes dropped and repeats dropped, in the order given. */
function unique(models: readonly string[]): string[] {
  const refs: string[] = [];
  for (const model of models) {
    const ref = baseRef(String(model));
    if (!refs.includes(ref)) refs.push(ref);
  }
  return refs;
}

/** The provider of a ref: the part before the first `/`, or `""` without one. */
function providerOf(ref: string): string {
  const slash = ref.indexOf("/");
  return slash < 0 ? "" : ref.slice(0, slash);
}

/** The summed price of a model per million tokens, over every row it reports. */
function priceOf(cost: readonly CatalogueCost[]): number {
  return cost.reduce((sum, row) => sum + row.input + row.output, 0);
}

/** A price as an owner reads it: summed floats leave noise past the decimals that mean anything (`0.1 + 0.2`). */
function shown(dollars: number | null): string {
  return String(Number((dollars ?? 0).toFixed(6)));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The first {@link MESSAGE_CHARS} characters: a backend's error can be long, and a reason is read by a person. */
function head(message: string): string {
  return message.slice(0, MESSAGE_CHARS);
}
