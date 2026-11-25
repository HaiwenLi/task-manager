import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter, PromptResult } from "../src/adapters/types.js";
import { latestNote } from "../src/handoff.js";
import { readJournal } from "../src/journal.js";
import { clearModelCooldown, noteModelRefusal } from "../src/model-cooldown.js";
import { readAttempt, readRuntime } from "../src/runtime.js";
import { runCli } from "../src/cli.js";
import { serializeTaskFile, type Task } from "../src/task-file.js";
import { TaskStore } from "../src/task-store.js";
import { runTask, settleExhausted, WRAP_UP_INSTRUCTION, type TaskOutcome, type WorkerConfig, type WorkerDeps, type WorkerEvent } from "../src/worker.js";
import { DEFAULT_MODEL_KEY, MODEL_ROUNDS_DEFAULT, clearModelWait, newRunContext, readModelWait, writeModelWait, type RunContext } from "../src/model-wait.js";
import { buildTaskFile } from "./helpers/task-fixture.js";
import { doneTaskId, markDoneTask, seedTaskFile } from "./helpers/watch-fixture.js";

let root: string;
let tasks: string;
let work: string;
let store: TaskStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "taskctl-model-rounds-"));
  tasks = join(root, "tasks");
  work = join(root, "work");
  await mkdir(tasks, { recursive: true });
  await mkdir(work, { recursive: true });
  store = new TaskStore(tasks);
  await writeFile(join(tasks, "a.md"), serializeTaskFile(buildTaskFile({
    id: "a", title: "a", acceptance: "check", criteria: ["C1 ok"],
  })), "utf8");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const CHAIN = ["q/one", "q/two", "q/three", "q/four"];

type Behaviour = PromptResult | "done";
type BackendTables = { turns?: Record<string, Behaviour>; reviews?: Record<string, Behaviour> };
/** A backend keyed by (role, model). The turn table may be given flat, without the `turns` key. "done" requests completion of the task the prompt names. */
function backend(tables: BackendTables | Record<string, Behaviour>): { adapter: AgentAdapter; seen: string[] } {
  const seen: string[] = [];
  const named = tables as BackendTables;
  const turns = named.turns ?? (tables as Record<string, Behaviour>);
  const answer = async (args: Parameters<AgentAdapter["prompt"]>[0]): Promise<PromptResult> => {
    const model = args.model ?? DEFAULT_MODEL_KEY;
    const review = args.title?.startsWith("review:") === true;
    seen.push(`${review ? "review:" : ""}${model}`);
    const behaviour = (review ? named.reviews : turns)?.[model];
    if (behaviour === undefined) throw new Error(`unexpected ${review ? "review" : "turn"} model ${model}`);
    if (behaviour !== "done") return behaviour;
    await markDoneTask(args.text, tasks);
    return { sessionId: `ses-${model}`, text: "done", exitCode: 0 };
  };
  return {
    seen,
    adapter: {
      prompt: answer,
      start: (args) => ({ result: answer(args), inspect: () => ({ state: "exited" as const }), cancel: async () => true }),
      contextUsage: async () => 0, contextLimit: async () => 100,
    },
  };
}
const refusal = (text: string): PromptResult => ({ sessionId: "", exitCode: 1, text, failure: "provider", tokens: 0 });
const passing = async () => ({ passed: true, skipped: false as const, exitCode: 0, output: "ok" });
const passingReview: WorkerDeps["review"] = async () => ({
  verdict: "pass", criteria: [{ id: "C1", pass: true, evidence: "ok" }], externalChanges: [], defects: [], summary: "ok",
});

function config(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    tasksDir: tasks, workdir: work, agent: "fixture", model: CHAIN[0], modelChain: CHAIN,
    contextThreshold: 0.8, retryLimit: 1, lockTtlMs: 5_000, heartbeatMs: 50, quotaBackoffMs: [0],
    // Rounds run back to back in these tests; the window is asserted on its own.
    modelCooldownMs: 0, ...overrides,
  };
}

/** One attempt of `id`. The review passes through a seam unless a case passes `{ review: undefined }`. */
async function run(
  adapter: AgentAdapter, events: WorkerEvent[] = [], overrides: Partial<WorkerConfig> = {},
  gates: Partial<Pick<WorkerDeps, "acceptance" | "review">> = {}, id = "a",
): Promise<TaskOutcome> {
  return runTask(config(overrides), {
    store, adapter, acceptance: passing, review: passingReview, ...gates,
    onEvent: (event) => { events.push(event); },
  }, await store.get(id), `w-${id}`);
}
const allRefuse = () => backend(Object.fromEntries(CHAIN.map((model) => [model, refusal(`Error: 503 on ${model}`)])));
const journal = async () => (await readJournal(tasks, "a")).map((line) => `${line.stage} ${line.event} ${line.detail}`).join("\n");
const table = async () => JSON.parse(await readFile(join(root, ".taskctl", "model-cooldowns.json"), "utf8")) as { models: Record<string, unknown> };

describe("a fully refused round", () => {
  it("moves to the next model at once and defers the task without spending a retry", async () => {
    const { adapter, seen } = allRefuse();
    const events: WorkerEvent[] = [];

    expect(await run(adapter, events)).toBe("open");

    expect(seen).toEqual(CHAIN);
    expect(await store.get("a")).toMatchObject({ status: "open", retries: 0 });
    expect(await latestNote(tasks, "a")).toBeNull();
    expect(events.some((event) => event.type === "blocked")).toBe(false);
    expect(events.find((event) => event.type === "model-deferred")?.detail)
      .toMatch(/^every model refused or cooling; round 1\/4; next \S+; retries untouched$/);
    expect(await readModelWait(tasks, "a")).toMatchObject({
      runId: expect.any(String), stage: "worker", rounds: 1,
      refusals: CHAIN.map((model) => ({ model, source: "turn", reason: expect.stringContaining(`Error: 503 on ${model}`) })),
    });
    expect(await journal()).toMatch(/worker model-deferred round 1\/4; next \S+; q\/one: exit 1 in \d+ms, Error: 503 on q\/one \| q\/two:/);
    expect((await readAttempt(tasks, "a"))?.phase).toBe("settled");
  });

  it("spends no retry on a refusal that came after the turn had done work", async () => {
    const { adapter, seen } = backend({ "q/one": { sessionId: "s", exitCode: 1, text: "model overloaded", failure: "provider", tokens: 5_000 } });

    expect(await run(adapter, [], { model: "q/one", modelChain: ["q/one"] })).toBe("open");

    expect(seen).toEqual(["q/one"]);
    expect(await store.get("a")).toMatchObject({ status: "open", retries: 0 });
  });

  it("sets the next time modelCooldownMs from the end of the round, sixty seconds by default", async () => {
    const { adapter } = allRefuse();
    const cfg = config();
    delete cfg.modelCooldownMs;

    await runTask(cfg, { store, adapter, acceptance: passing, review: passingReview }, await store.get("a"), "w-a");

    const record = (await readModelWait(tasks, "a"))!;
    expect(Date.parse(record.nextAt) - Date.parse(record.updatedAt)).toBe(60_000);
  });

  it("is refused by the claim path while its time lies in the future, like an unfinished dependency", async () => {
    expect(await run(allRefuse().adapter, [], { modelCooldownMs: 60_000 })).toBe("open");
    const again = allRefuse();

    expect(await run(again.adapter, [], { modelCooldownMs: 60_000 })).toBe("skipped");

    expect(again.seen).toEqual([]);
    const lapsed = (await readModelWait(tasks, "a"))!;
    await writeModelWait(tasks, "a", { ...lapsed, nextAt: new Date(Date.now() - 1_000).toISOString() });
    for (const model of CHAIN) await clearModelCooldown(tasks, model); // the shared window has lapsed too

    expect(await run(again.adapter, [], { modelCooldownMs: 60_000 })).toBe("open");

    expect(again.seen).toHaveLength(4);
    expect(await readModelWait(tasks, "a")).toMatchObject({ rounds: 2 });
  });

  it("waits only until the earliest expiry when every model is already cooling", async () => {
    // Another task was refused on q/three half a window ago, and on the other models just now.
    const now = Date.now();
    for (const model of CHAIN) await noteModelRefusal(tasks, model, {
      reason: `429 on ${model}`, cooldownMs: 60_000, now: new Date(now - (model === "q/three" ? 30_000 : 0)),
    });
    const { adapter, seen } = allRefuse();

    expect(await run(adapter)).toBe("open");

    expect(seen).toEqual([]);
    expect(await readModelWait(tasks, "a")).toMatchObject({ rounds: 0, nextAt: new Date(now + 30_000).toISOString() });
  });

  it("ends the deferral once a model accepts the turn", async () => {
    expect(await run(allRefuse().adapter)).toBe("open");
    const served = backend({ "q/one": "done" }); // every round starts at the head of the chain

    expect(await run(served.adapter)).toBe("done");

    expect(served.seen).toEqual(["q/one"]);
    expect(await readModelWait(tasks, "a")).toBeNull();
  });

  it("waits for the window when every model is already cooling, and such a pass is not a round", async () => {
    for (const model of CHAIN) await noteModelRefusal(tasks, model, { reason: `429 on ${model}`, cooldownMs: 60_000 });
    const { adapter, seen } = allRefuse();
    const events: WorkerEvent[] = [];

    expect(await run(adapter, events)).toBe("open");
    expect(await run(allRefuse().adapter)).toBe("skipped"); // the record's time is the table's earliest expiry, still ahead

    expect(seen).toEqual([]);
    expect(await store.get("a")).toMatchObject({ status: "open", retries: 0 });
    expect(await readModelWait(tasks, "a")).toMatchObject({
      rounds: 0, firstRefusedAt: null,
      refusals: CHAIN.map((model) => ({ model, source: "table", reason: `429 on ${model}` })),
    });
    expect(events.some((event) => event.type === "blocked")).toBe(false);
    expect(await journal()).toMatch(/model-deferred round 0\/4; next /);
  });

  it("counts rounds within one run, and starts another run from round 0", async () => {
    const first = newRunContext();
    for (let round = 1; round <= 3; round++) expect(await run(allRefuse().adapter, [], { run: first })).toBe("open");
    expect(await readModelWait(tasks, "a")).toMatchObject({ runId: first.id, rounds: 3 });

    const second = newRunContext();
    expect(await run(allRefuse().adapter, [], { run: second })).toBe("open");

    expect(await readModelWait(tasks, "a")).toMatchObject({ runId: second.id, rounds: 1 });
  });

  it("is not offered again in this run once its rounds are spent, and nothing is decided in the attempt", async () => {
    const context = newRunContext();
    for (let i = 0; i < MODEL_ROUNDS_DEFAULT; i++) expect(await run(allRefuse().adapter, [], { run: context })).toBe("open");
    const again = allRefuse();

    expect(await run(again.adapter, [], { run: context })).toBe("skipped");
    expect(again.seen).toEqual([]);

    // The attempt that ran out of rounds only recorded it. The decision is the controller's (Task 5).
    expect(await store.get("a")).toMatchObject({ status: "open", retries: 0 });
    expect(await latestNote(tasks, "a")).toBeNull();
    expect(await journal()).not.toMatch(/model-outage/);

    expect(await run(allRefuse().adapter, [], { run: newRunContext() })).toBe("open");
    expect(await readModelWait(tasks, "a")).toMatchObject({ rounds: 1 });
  });

  it("treats a refused wrap-up turn as a refusal too, and notes the table for it", async () => {
    const overBudget: AgentAdapter = {
      prompt: async (args) => args.text === WRAP_UP_INSTRUCTION
        ? refusal("Error: 429 during wrap-up")
        : { sessionId: "s-a", exitCode: 0, text: "still working" },
      contextUsage: async () => 90, contextLimit: async () => 100,
    };

    expect(await run(overBudget, [], { model: "q/one", modelChain: ["q/one"] })).toBe("open");

    expect(await store.get("a")).toMatchObject({ status: "open", retries: 0 });
    expect(await readModelWait(tasks, "a")).toMatchObject({
      rounds: 1, refusals: [{ model: "q/one", source: "turn", reason: expect.stringContaining("429 during wrap-up") }],
    });
    expect((await table()).models["q/one"]).toBeDefined();
  });

  it("records a refusal of the unnamed default model when no chain is configured", async () => {
    const { adapter, seen } = backend({ [DEFAULT_MODEL_KEY]: refusal("Error: no route") });
    const cfg = config();
    delete cfg.model;
    delete cfg.modelChain;

    expect(await runTask(cfg, { store, adapter, acceptance: passing, review: passingReview }, await store.get("a"), "w-a")).toBe("open");

    expect(seen).toEqual([DEFAULT_MODEL_KEY]);
    expect(await readModelWait(tasks, "a")).toMatchObject({ rounds: 1, refusals: [{ model: DEFAULT_MODEL_KEY, source: "turn" }] });
  });
});

describe("after modelRounds rounds", () => {
  const round = (adapter: AgentAdapter, context: RunContext, overrides: Partial<WorkerConfig> = {}) => run(adapter, [], { run: context, ...overrides });
  const seed = (id: string, overrides: Partial<Task> = {}) => seedTaskFile(tasks, buildTaskFile({ id, title: id, acceptance: "check", criteria: ["C1 ok"], ...overrides }));
  /** What a controller does once nothing is in flight, for the tasks it got back deferred. */
  const settle = async (cfg: WorkerConfig, deferred: string[]) => {
    const events: WorkerEvent[] = [];
    const outcome = await settleExhausted(cfg, {
      store, adapter: allRefuse().adapter, acceptance: passing, review: passingReview, onEvent: (event) => { events.push(event); },
    }, await store.list(), deferred);
    return { outcome, events };
  };

  it("with no task served, the task is left open, retries untouched, and the run is told to stop", async () => {
    const context = newRunContext();
    const outcomes: TaskOutcome[] = [];
    for (let i = 0; i < MODEL_ROUNDS_DEFAULT; i++) outcomes.push(await round(allRefuse().adapter, context));
    // Four rounds by default, and not one of them decided anything.
    expect(outcomes).toEqual(["open", "open", "open", "open"]);

    const { outcome, events } = await settle(config({ run: context }), ["a"]);

    expect(outcome).toEqual({ held: [], outage: { taskId: "a" } });
    expect(await store.get("a")).toMatchObject({ status: "open", retries: 0 });
    expect(await readModelWait(tasks, "a")).toMatchObject({ runId: context.id, rounds: 4 });
    expect(await latestNote(tasks, "a")).toBeNull();
    expect(events.some((event) => event.type === "blocked")).toBe(false);
    expect(events.find((event) => event.type === "outage")?.detail).toContain("nothing is blocked, every waiting task can be run again");
    expect(await journal()).toMatch(/worker model-outage rounds 4\/4 over \S+ since \S+; no task served on the chain; q\/one:/);
  });

  it("honours a configured round budget", async () => {
    const context = newRunContext();
    expect(await round(allRefuse().adapter, context, { modelRounds: 2 })).toBe("open");

    // One round of two is not spent: there is nothing to decide.
    expect((await settle(config({ run: context, modelRounds: 2 }), ["a"])).outcome).toEqual({ held: [] });

    expect(await round(allRefuse().adapter, context, { modelRounds: 2 })).toBe("open");
    expect((await settle(config({ run: context, modelRounds: 2 }), ["a"])).outcome).toEqual({ held: [], outage: { taskId: "a" } });
  });

  it("with another task served on a chain model, only this task is blocked, and the note names every model", async () => {
    await seed("b");
    const context = newRunContext();
    for (let i = 0; i < MODEL_ROUNDS_DEFAULT; i++) expect(await round(allRefuse().adapter, context)).toBe("open");
    const serving = backend({ "q/one": refusal("Error: 503 on the way"), "q/two": "done" });
    expect(await run(serving.adapter, [], { run: context }, {}, "b")).toBe("done");

    const { outcome, events } = await settle(config({ run: context }), ["a"]);

    expect(outcome).toEqual({ held: ["a"] });
    expect(await store.get("a")).toMatchObject({ status: "blocked", retries: 0 });
    const note = (await latestNote(tasks, "a"))!.markdown;
    expect(note).toContain("blocked:needs-owner");
    for (const model of CHAIN) expect(note).toContain(model);
    expect(note).toContain("未消耗 retries");
    expect(events.find((event) => event.type === "blocked")?.detail).toContain("the task itself is the problem");
    expect(await journal()).toContain("refused by every model in 4 round(s) while q/two served another task");
    expect(await readModelWait(tasks, "a")).toMatchObject({ rounds: 4 });
    expect(await store.get("b")).toMatchObject({ status: "done" });
  });

  it("a success that later refusals overwrote in the shared table is still evidence", async () => {
    await seed("b");
    await seed("c");
    const context = newRunContext();
    for (const id of ["a", "c"]) for (let i = 0; i < MODEL_ROUNDS_DEFAULT - 1; i++) {
      expect(await run(allRefuse().adapter, [], { run: context }, {}, id)).toBe("open");
    }
    // b is served on q/two only; c is refused on every model.
    const serveBRefuseC: AgentAdapter = {
      prompt: async (args) => {
        if (doneTaskId(args.text) === "b" && args.model === "q/two") {
          await markDoneTask(args.text, tasks);
          return { sessionId: "ses-b", exitCode: 0, text: "done" };
        }
        return refusal("Error: this model will not serve this task");
      },
      contextUsage: async () => 0, contextLimit: async () => 100,
    };

    expect(await run(serveBRefuseC, [], { run: context }, {}, "b")).toBe("done");
    // a's and c's fourth rounds are refused right after b's success and write q/two's entry again.
    expect(await run(allRefuse().adapter, [], { run: context })).toBe("open");
    expect(await run(serveBRefuseC, [], { run: context }, {}, "c")).toBe("open");
    expect((await table()).models["q/two"]).toBeDefined(); // the shared table alone says "refusing"

    const { outcome } = await settle(config({ run: context }), ["a", "c"]);

    expect(outcome).toEqual({ held: ["a", "c"] });
    expect(await store.get("a")).toMatchObject({ status: "blocked" });
    expect(await store.get("b")).toMatchObject({ status: "done" });
  });

  it("does not count a turn accepted before the task's first refusal", async () => {
    await seed("b");
    const context = newRunContext();
    expect(await run(backend({ "q/one": refusal("Error: 503 on the way"), "q/two": "done" }).adapter, [], { run: context }, {}, "b")).toBe("done");
    for (let i = 0; i < MODEL_ROUNDS_DEFAULT; i++) expect(await round(allRefuse().adapter, context)).toBe("open");

    expect((await settle(config({ run: context }), ["a"])).outcome).toEqual({ held: [], outage: { taskId: "a" } });
  });

  it("waits for the attempt in flight: a task served after the round that ran out is still evidence", async () => {
    await seed("b");
    const context = newRunContext();
    for (let i = 0; i < MODEL_ROUNDS_DEFAULT; i++) expect(await round(allRefuse().adapter, context)).toBe("open");
    // Nothing was decided while b's turn was still to come.
    expect((await readJournal(tasks, "a")).some((line) => line.event === "model-outage")).toBe(false);
    expect(await store.get("a")).toMatchObject({ status: "open" });

    const serving = backend({ "q/one": refusal("Error: 503 on the way"), "q/two": "done" });
    expect(await run(serving.adapter, [], { run: context }, {}, "b")).toBe("done");

    expect((await settle(config({ run: context }), ["a"])).outcome).toEqual({ held: ["a"] });
    expect(await store.get("a")).toMatchObject({ status: "blocked" });
  });

  it("decides nothing for a task that is no longer open", async () => {
    const context = newRunContext();
    for (let i = 0; i < MODEL_ROUNDS_DEFAULT; i++) expect(await round(allRefuse().adapter, context)).toBe("open");
    await store.setStatus("a", "blocked"); // by hand, while no controller was running

    expect((await settle(config({ run: context }), ["a"])).outcome).toEqual({ held: [] });
    expect((await readJournal(tasks, "a")).some((line) => line.event === "model-outage")).toBe(false);
  });
});

const PASS: PromptResult = { sessionId: "s-review", exitCode: 0, text: '{"verdict":"pass","criteria":[{"id":"C1","pass":true,"evidence":"ok"}],"externalChanges":[],"defects":[],"summary":"ok"}' };
const FAIL: PromptResult = { sessionId: "s-review", exitCode: 0, text: '{"verdict":"fail","criteria":[{"id":"C1","pass":false,"evidence":"wrong"}],"externalChanges":[],"defects":["fix it"],"summary":"not good"}' };
const REVIEW = { modelChain: ["w/one"], reviewerModel: "r/one", reviewerModelFallbacks: ["r/two"] };
const refused = () => backend({
  turns: { "w/one": "done" },
  reviews: { "r/one": refusal("Error: 429 too many requests"), "r/two": refusal("Error: weekly limit reached") },
});
const pending = () => readRuntime<{ definitionDigest: string; refusals: Array<{ model: string }>; window?: unknown }>(tasks, "a", "review-pending.json");
/** What a controller does once nothing is in flight, for the tasks it got back deferred. */
const settleReview = async (cfg: WorkerConfig, deferred: string[]) => settleExhausted(cfg, {
  store, adapter: refused().adapter, acceptance: passing,
}, await store.list(), deferred);

describe("a refused review", () => {
  it("walks the reviewer chain, and a fully refused round defers with the evidence preserved", async () => {
    const { adapter, seen } = refused();
    const events: WorkerEvent[] = [];

    expect(await run(adapter, events, REVIEW, { review: undefined })).toBe("open");

    expect(seen).toEqual(["w/one", "review:r/one", "review:r/two"]);
    expect(await store.get("a")).toMatchObject({ status: "open", retries: 0, reviewRounds: 0 });
    expect(await pending()).toMatchObject({ definitionDigest: expect.any(String), refusals: [{ model: "r/one" }, { model: "r/two" }] });
    expect(await readModelWait(tasks, "a")).toMatchObject({
      stage: "review", rounds: 1,
      refusals: [{ model: "r/one", reason: "Error: 429 too many requests" }, { model: "r/two", reason: "Error: weekly limit reached" }],
    });
    expect(events.some((event) => event.type === "blocked")).toBe(false);
  });

  it("the next claim after the window resumes the review by itself, without the worker or the acceptance", async () => {
    expect(await run(refused().adapter, [], REVIEW, { review: undefined })).toBe("open");
    const acceptance = vi.fn(passing);
    const { adapter, seen } = backend({ turns: { "w/one": "done" }, reviews: { "r/one": PASS } });

    expect(await run(adapter, [], REVIEW, { review: undefined, acceptance })).toBe("done");

    expect(seen).toEqual(["review:r/one"]);
    expect(acceptance).toHaveBeenCalledTimes(0); // this attempt ran no gate; the first one ran it once
    expect((await readJournal(tasks, "a")).some((line) => line.stage === "review" && line.event === "review-only")).toBe(true);
    expect(await pending()).toBeNull();
    expect(await readModelWait(tasks, "a")).toBeNull();
    expect(await store.get("a")).toMatchObject({ status: "done" });
  });

  it("a fail verdict after that resumption opens rework without invoking the worker", async () => {
    expect(await run(refused().adapter, [], REVIEW, { review: undefined })).toBe("open");
    const { adapter, seen } = backend({ turns: { "w/one": "done" }, reviews: { "r/one": FAIL } });

    expect(await run(adapter, [], REVIEW, { review: undefined })).toBe("open");

    expect(seen).toEqual(["review:r/one"]);
    expect(await store.get("a")).toMatchObject({ status: "open" });
    expect((await latestNote(tasks, "a"))?.markdown).toContain("review-failed");
    expect(await pending()).toBeNull();
  });

  it("after modelRounds rounds with no task served, keeps the evidence and tells the run to stop", async () => {
    const context = newRunContext();
    const one = () => run(refused().adapter, [], { ...REVIEW, run: context }, { review: undefined });
    expect(await one()).toBe("open");
    const first = (await pending())?.window;
    for (let i = 1; i < MODEL_ROUNDS_DEFAULT; i++) expect(await one()).toBe("open");

    expect(await settleReview(config({ ...REVIEW, run: context }), ["a"])).toEqual({ held: [], outage: { taskId: "a" } });

    expect(await store.get("a")).toMatchObject({ status: "open", retries: 0 });
    expect((await pending())?.window).toEqual(first);
    expect(await readModelWait(tasks, "a")).toMatchObject({ stage: "review", rounds: 4 });
  });

  it("after modelRounds rounds with another task served on a chain model, parks the task as today", async () => {
    await seedTaskFile(tasks, buildTaskFile({ id: "b", title: "b", acceptance: "check", criteria: ["C1 ok"] }));
    const context = newRunContext();
    for (let i = 0; i < MODEL_ROUNDS_DEFAULT; i++) expect(await run(refused().adapter, [], { ...REVIEW, run: context }, { review: undefined })).toBe("open");
    const serving = backend({ turns: { "w/one": "done" }, reviews: { "r/one": PASS } });
    expect(await run(serving.adapter, [], { ...REVIEW, run: context }, { review: undefined }, "b")).toBe("done");

    expect(await settleReview(config({ ...REVIEW, run: context }), ["a"])).toEqual({ held: ["a"] });

    expect(await store.get("a")).toMatchObject({ status: "blocked", retries: 0 });
    expect(await pending()).not.toBeNull();
    expect(await journal()).toMatch(/review review-pending .*own problem: refused in 4 round\(s\) while r\/one served another task/);
  });

  it("asks about the chain that refused, not about the worker's chain", async () => {
    await seedTaskFile(tasks, buildTaskFile({ id: "b", title: "b", acceptance: "check", criteria: ["C1 ok"], verify: "mechanical" }));
    const context = newRunContext();
    const reviewerOnly = { ...REVIEW, reviewerModelFallbacks: [] };
    for (let i = 0; i < MODEL_ROUNDS_DEFAULT; i++) expect(await run(refused().adapter, [], { ...reviewerOnly, run: context }, { review: undefined })).toBe("open");
    // b's worker is served on w/one and needs no review: not evidence for r/one.
    expect(await run(backend({ turns: { "w/one": "done" } }).adapter, [], { ...reviewerOnly, run: context }, { review: undefined }, "b")).toBe("done");

    expect(await settleReview(config({ ...reviewerOnly, run: context }), ["a"])).toEqual({ held: [], outage: { taskId: "a" } });
  });

  it("an open task that carries preserved evidence is never sent back through the worker, whoever wrote the record", async () => {
    expect(await run(refused().adapter, [], REVIEW, { review: undefined })).toBe("open");
    await clearModelWait(tasks, "a"); // the deferral is gone; the preserved evidence is what counts
    const { adapter, seen } = backend({ turns: { "w/one": "done" }, reviews: { "r/one": PASS } });

    expect(await run(adapter, [], REVIEW, { review: undefined })).toBe("done");

    expect(seen).toEqual(["review:r/one"]);
  });

  it("the digest gate still refuses an automatic resumption on changed artifacts", async () => {
    expect(await run(refused().adapter, [], REVIEW, { review: undefined })).toBe("open");
    await writeFile(join(work, "changed-after-the-work.txt"), "drift", "utf8");
    const { adapter, seen } = backend({ turns: { "w/one": "done" }, reviews: { "r/one": PASS } });
    const events: WorkerEvent[] = [];

    expect(await run(adapter, events, REVIEW, { review: undefined })).toBe("blocked");

    expect(seen).toEqual([]);
    expect(events.find((event) => event.type === "blocked")?.detail).toContain("review-only recovery refused");
    expect(await pending()).not.toBeNull();
  });

  it("a retry --review-only asked for inside the window is not run, and says until when", async () => {
    // Deferred for a real window, and blocked as the controller blocks it once its rounds are spent.
    expect(await run(refused().adapter, [], { ...REVIEW, modelCooldownMs: 60_000 }, { review: undefined })).toBe("open");
    await store.setStatus("a", "blocked");
    const nextAt = (await readModelWait(tasks, "a"))!.nextAt;
    const { adapter, seen } = backend({ turns: { "w/one": "done" }, reviews: { "r/one": PASS } });
    const configPath = join(root, "taskctl.json");
    await writeFile(configPath, JSON.stringify({ tasksDir: tasks, workdir: work, ...REVIEW }), "utf8");
    const lines: string[] = [];

    const code = await runCli(["retry", "--task", "a", "--review-only", "--config", configPath], { adapter, log: (line) => { lines.push(line); } });

    expect(code).toBe(1);
    expect(lines).toEqual([`review-only recovery is held by a model window until ${nextAt}; ask again then`]);
    expect(seen).toEqual([]); // no claim, no session
  });
});
