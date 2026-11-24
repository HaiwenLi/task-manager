import { beforeEach, describe, expect, it } from "vitest";
import type { AgentAdapter, CatalogueModel } from "../src/adapters/types.js";
import {
  baseRef, CATALOGUE_TIMEOUT_MS, catalogueOf, checkModels, classify, defaultRefOf, judgeRefs,
  newGuardState, policyOf, renderVerdicts, resetGuardState, reviewerModels, workerModels,
} from "../src/budget.js";
import type { Task } from "../src/task-file.js";
import type { WorkerConfig } from "../src/worker.js";
import { CATALOGUE, DISABLED, FREE, PAID, UNKNOWN, adapterOf, entry } from "./helpers/catalogue-fixture.js";

describe("budget guard", () => {
  beforeEach(() => {
    resetGuardState();
  });

  const free = FREE; const paid = PAID; const unknown = UNKNOWN; const disabled = DISABLED; const catalogue = CATALOGUE;
  const cfg = { model: "cfg/two", reviewerModel: "cfg/review" } as WorkerConfig;
  const task = { id: "t" } as Task;

  it("strips the variant suffix", () => { expect(baseRef("plan/m#high")).toBe("plan/m"); expect(baseRef("plan/m")).toBe("plan/m"); });
  it("classifies free, paid, unknown and absent", () => {
    expect(classify("plan/m", catalogue, {}).costClass).toBe("free");
    expect(classify("plan/m#high", catalogue, {}).costClass).toBe("free");
    expect(classify("zen/p", catalogue, {}).dollarsPerMillion).toBe(15);
    expect(classify("kimi/k", catalogue, {}).costClass).toBe("unknown");
    expect(classify("nope/x", catalogue, {})).toMatchObject({ costClass: "unknown", enabled: null, providerID: "nope" });
  });
  it("finds a model by id or by modelID", () => {
    expect(classify("p/k-alias", [entry("p/k", [{ input: 0, output: 0 }], { modelID: "k-alias" })], {}).costClass).toBe("free");
  });
  it("refuses what was not explicitly allowed", () => {
    expect(classify("zen/p", catalogue, {}).allowed).toBe(false);
    expect(classify("kimi/k", catalogue, {}).allowed).toBe(false);
    expect(classify("plan/m", catalogue, { allowedProviders: ["kimi"] }).allowed).toBe(false);
  });
  it("allows what was explicitly allowed", () => {
    expect(classify("zen/p", catalogue, { allowedModels: ["zen/p"] }).allowed).toBe(true);
    expect(classify("zen/p", catalogue, { allowPaidModels: true }).allowed).toBe(true);
    expect(classify("zen/p", catalogue, { maxCostPerMillion: 15 }).allowed).toBe(true);
    expect(classify("zen/p", catalogue, { maxCostPerMillion: 0 }).allowed).toBe(false);
    expect(classify("kimi/k", catalogue, { allowedProviders: ["kimi"] }).allowed).toBe(true);
    expect(classify("kimi/k", catalogue, { allowedModels: ["kimi/k"] }).allowed).toBe(true);
    expect(classify("plan/m", catalogue, { allowedProviders: ["plan"] }).allowed).toBe(true);
  });
  it("never allows a disabled model", () => {
    expect(classify("plan/m", [disabled], { allowedProviders: ["plan"], allowedModels: ["plan/m"], allowPaidModels: true }).allowed).toBe(false);
    expect(classify("plan/m", [disabled], {}).reason).toBe("后端里已禁用");
  });
  it("collects the worker and reviewer models of a task", () => {
    expect(workerModels(cfg, { ...task, model: "task/one#low" })).toEqual(["task/one", "cfg/two"]);
    expect(reviewerModels(cfg)).toEqual(["cfg/review"]);
  });
  it("answers nothing when the adapter cannot list models", async () => {
    expect(await checkModels(cfg, {} as AgentAdapter, { worker: ["zen/p"], reviewer: [] })).toEqual([]);
    expect(await judgeRefs(["zen/p"], {}, {} as AgentAdapter)).toEqual([]);
    expect(classify("zen/p", null, {}).allowed).toBe(true);
  });
  it("refuses paid and unknown models and keeps a disabled one out", async () => {
    const state = newGuardState(1_000);
    const refused = await checkModels(cfg, adapterOf(catalogue), { worker: ["plan/m#high", "zen/p", "kimi/k"], reviewer: ["plan/m"] }, state);
    expect(refused.map((v) => v.ref).sort()).toEqual(["kimi/k", "zen/p"]);
    expect(refused[0].reason).toBeTruthy();
  });
  it("judges the backend default when a chain is empty", async () => {
    const refused = await checkModels(cfg, adapterOf(catalogue, "zen/p"), { worker: [], reviewer: [] }, newGuardState(1_000));
    expect(refused.map((v) => v.ref)).toEqual(["zen/p"]);            // judged once even though both chains are empty
  });
  it("does not judge the worker side of a review-only recovery", async () => {
    expect(await checkModels(cfg, adapterOf(catalogue, "zen/p"), { reviewer: ["plan/m"] }, newGuardState(1_000))).toEqual([]);
  });
  it("refuses with a named reason when the backend default cannot be read", async () => {
    const refused = await checkModels(cfg, adapterOf(catalogue, null), { worker: [], reviewer: [] }, newGuardState(1_000));
    expect(refused).toMatchObject([{ ref: "(backend default)", costClass: "unknown", reason: "后端默认模型无法确认" }]);
  });
  it("gives up on a catalogue that never answers, and does not remember the timeout", async () => {
    const state = newGuardState(200);
    let hang = true;
    const once = { ...adapterOf([]), modelCatalog: () => hang ? (hang = false, new Promise<never>(() => {})) : Promise.resolve(catalogue) };
    const refused = await checkModels(cfg, once, { worker: ["plan/m"] }, state);
    expect(refused.map((v) => v.ref)).toEqual(["plan/m"]);
    expect(refused[0].reason).toContain("模型目录读不到");
    expect(await checkModels(cfg, once, { worker: ["plan/m"] }, state)).toEqual([]);
  });
  it("forgets a catalogue fetch that failed", async () => {
    let fail = true;
    let calls = 0;
    const flaky = { ...adapterOf(catalogue), modelCatalog: async () => { calls++; if (fail) { fail = false; throw new Error("service unreachable"); } return catalogue; } };
    const state = newGuardState(1_000);
    expect((await checkModels(cfg, flaky, { worker: ["plan/m"] }, state))[0].reason).toContain("模型目录读不到");
    expect(await checkModels(cfg, flaky, { worker: ["plan/m"] }, state)).toEqual([]);
    expect(calls).toBe(2);
  });
  it("forgets a backend default that could not be read", async () => {
    let fail = true;
    const flaky = { ...adapterOf(catalogue), defaultModelRef: async () => { if (fail) { fail = false; throw new Error("service unreachable"); } return "plan/m"; } };
    const state = newGuardState(1_000);
    expect((await checkModels(cfg, flaky, { worker: [] }, state))[0].ref).toBe("(backend default)");
    expect(await checkModels(cfg, flaky, { worker: [] }, state)).toEqual([]);
  });
  it("does not take an empty catalogue for truth", async () => {
    const refused = await checkModels(cfg, adapterOf([]), { worker: ["plan/m"] }, newGuardState(1_000));
    expect(refused.map((v) => v.ref)).toEqual(["plan/m"]);
    expect(refused[0].reason).toContain("模型目录是空的");
  });
  it("judges every ref once, allowed or not", async () => {
    const verdicts = await judgeRefs(["plan/m#high", "zen/p", "zen/p", "nope/x"], {}, adapterOf(catalogue), newGuardState(1_000));
    expect(verdicts.map((v) => [v.ref, v.allowed])).toEqual([["plan/m", true], ["zen/p", false], ["nope/x", false]]);
    expect(verdicts[0].variants).toEqual(["high"]);
    expect((await judgeRefs([], {}, adapterOf(catalogue, "zen/p"), newGuardState(1_000))).map((v) => v.ref)).toEqual(["zen/p"]);
  });
  it("renders verdicts without credential-bearing fields", () => {
    const text = renderVerdicts([classify("plan/m", catalogue, {}), classify("zen/p", catalogue, {})]);
    expect(text).toContain("- plan/m  provider=plan  enabled=true  variants=high  放行（免费）");
    expect(text).toContain("拒绝：按量计费，约 $15 / 百万 token；未列入 allowedModels");
    expect(text).not.toMatch(/apiKey|headers/);
  });

  // Beyond the plan's list: what it states in the rules that the tests above
  // only touch in passing.

  it("reads the policy off the configuration and keeps a zero price cap", () => {
    expect(policyOf({})).toStrictEqual({});
    expect(policyOf({ allowedProviders: ["plan"], maxCostPerMillion: 0 })).toStrictEqual({ allowedProviders: ["plan"], maxCostPerMillion: 0 });
  });

  it("forgets what was reported and fetched, the module's own state included", async () => {
    expect(CATALOGUE_TIMEOUT_MS).toBe(30_000);
    const state = newGuardState();
    expect(state.timeoutMs).toBe(CATALOGUE_TIMEOUT_MS);
    expect(newGuardState(250).timeoutMs).toBe(250);

    // One fetch per adapter for as long as it holds; none across a reset.
    let calls = 0;
    const counting = { ...adapterOf(catalogue), modelCatalog: async () => { calls++; return catalogue; } };
    await catalogueOf(counting);
    await catalogueOf(counting);
    expect(calls).toBe(1);
    resetGuardState();
    await catalogueOf(counting);
    expect(calls).toBe(2);

    state.reported.add("a\n[]");
    resetGuardState(state);
    expect(state.reported.size).toBe(0);
  });

  it("answers null when the adapter cannot list models or name a default", async () => {
    expect(await catalogueOf({} as AgentAdapter)).toBeNull();
    const noDefault = { modelCatalog: async () => catalogue } as unknown as AgentAdapter;
    expect(await defaultRefOf(noDefault)).toBeNull();
    // An empty chain on an adapter that cannot name the default: unconfirmed, so refused.
    expect((await checkModels(cfg, noDefault, { worker: [] }, newGuardState(1_000))).map((v) => v.ref)).toEqual(["(backend default)"]);
  });

  it("answers every ref it was asked about, once, when it fails closed", async () => {
    const refused = await checkModels(cfg, adapterOf([]), { worker: ["plan/m#high", "zen/p"], reviewer: ["plan/m"] }, newGuardState(1_000));
    expect(refused.map((v) => v.ref)).toEqual(["plan/m", "zen/p"]);
    for (const verdict of refused) {
      expect(verdict).toStrictEqual({
        ref: verdict.ref, providerID: verdict.ref.slice(0, verdict.ref.indexOf("/")), costClass: "unknown", dollarsPerMillion: null,
        enabled: null, variants: [], allowed: false, reason: "模型目录是空的（后端没有报出任何模型）",
      });
    }
    // The first 200 characters of the error, never more.
    const long = { ...adapterOf(catalogue), modelCatalog: async () => { throw new Error(`x${"y".repeat(500)}z`); } };
    const reason = (await checkModels(cfg, long, { worker: ["plan/m"] }, newGuardState(1_000)))[0].reason ?? "";
    expect(reason).toMatch(/^模型目录读不到（xy{199}）$/);
  });

  it("names the reason for each refusal, and nothing for a model that may run", () => {
    const unknownReason = "成本未知（目录里没有它，或它不报成本）；未列入 allowedModels，provider 也不在 allowedProviders 里";
    expect(classify("plan/m", catalogue, { allowedProviders: ["kimi"] }).reason).toBe("provider plan 不在 allowedProviders 里");
    expect(classify("nope/x", catalogue, {}).reason).toBe(unknownReason);
    expect(classify("kimi/k", catalogue, {}).reason).toBe(unknownReason);
    expect(classify("zen/p", catalogue, {}).reason).toBe("按量计费，约 $15 / 百万 token；未列入 allowedModels");
    expect(classify("zen/p", catalogue, { allowPaidModels: true })).not.toHaveProperty("reason");
    expect(classify("plan/m", catalogue, {})).not.toHaveProperty("reason");
    // A ref without a provider has no provider to vouch for it.
    expect(classify("k", catalogue, {})).toMatchObject({ ref: "k", providerID: "", allowed: false });
    // Its model is the whole ref, so it still matches an entry that names no provider either.
    expect(classify("k#high", [entry("/k", [{ input: 0, output: 0 }])], {})).toMatchObject({ ref: "k", providerID: "", costClass: "free", allowed: true });
  });

  it("does not refuse a backend default that may run", async () => {
    expect(await checkModels(cfg, adapterOf(catalogue, "plan/m"), { worker: [] }, newGuardState(1_000))).toEqual([]);
    expect(await judgeRefs([], {}, adapterOf(catalogue, "plan/m"), newGuardState(1_000))).toMatchObject([{ ref: "plan/m", allowed: true }]);
    // The default is judged as if it were in the chain: once, beside the refs that were asked about.
    expect((await checkModels(cfg, adapterOf(catalogue, "zen/p"), { worker: ["zen/p#high"], reviewer: [] }, newGuardState(1_000))).map((v) => v.ref)).toEqual(["zen/p"]);
    expect(await checkModels(cfg, adapterOf(catalogue, "zen/p"), { worker: ["plan/m"] }, newGuardState(1_000))).toEqual([]);
  });

  it("gives up on a backend default that never answers, and does not remember the timeout", async () => {
    const state = newGuardState(200);
    let hang = true;
    const once = { ...adapterOf(catalogue), defaultModelRef: () => hang ? (hang = false, new Promise<never>(() => {})) : Promise.resolve("plan/m") };
    expect(await judgeRefs([], {}, once, state)).toMatchObject([{ ref: "(backend default)", reason: "后端默认模型无法确认" }]);
    expect((await judgeRefs([], {}, once, state)).map((v) => v.ref)).toEqual(["plan/m"]);
  });

  it("turns an unexpected error into a refusal with a named reason instead of throwing", async () => {
    // An adapter whose catalogue is not a list at all.
    const broken = { ...adapterOf(catalogue), modelCatalog: async () => ({ no: "list" }) as unknown as CatalogueModel[] };
    const refused = await checkModels(cfg, broken, { worker: ["plan/m"] }, newGuardState(1_000));
    expect(refused).toMatchObject([{ ref: "plan/m", costClass: "unknown", enabled: null, variants: [], allowed: false }]);
    expect(refused[0].reason).toMatch(/^护栏无法判定（.+）$/);
    // A sync throw inside the adapter is a failed read, not a crash.
    const throwing = { ...adapterOf(catalogue), modelCatalog: (() => { throw new Error("boom"); }) as unknown as AgentAdapter["modelCatalog"] };
    expect((await checkModels(cfg, throwing, { worker: ["plan/m"] }, newGuardState(1_000)))[0].reason).toBe("模型目录读不到（boom）");
  });

  it("collects the whole chain a role may run on, the task's own model first", () => {
    const chained = {
      model: "cfg/one", modelChain: ["chain/one", "chain/two#high"], modelFallbacks: ["chain/two", "fb/one"],
      reviewerModel: "r/one", reviewerModelFallbacks: ["r/one#low", "r/two"],
    } as WorkerConfig;
    expect(workerModels(chained, task)).toEqual(["chain/one", "chain/two", "fb/one"]);
    expect(workerModels(chained, { ...task, model: "task/one" })).toEqual(["task/one", "chain/one", "chain/two", "fb/one"]);
    expect(workerModels({ ...chained, modelChain: undefined }, task)).toEqual(["cfg/one", "chain/two", "fb/one"]);
    expect(workerModels({ ...chained, modelChain: undefined }, { ...task, model: "task/one" })).toEqual(["task/one", "cfg/one", "chain/two", "fb/one"]);
    expect(reviewerModels(chained)).toEqual(["r/one", "r/two"]);
    expect(workerModels({ reviewerModel: "r" } as WorkerConfig, { ...task, model: "task/one" })).toEqual(["task/one"]);
    expect(workerModels({} as WorkerConfig, task)).toEqual([]);
  });
});
