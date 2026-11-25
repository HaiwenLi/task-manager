import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter, PromptResult } from "../src/adapters/types.js";
import { latestNote } from "../src/handoff.js";
import { readJournal } from "../src/journal.js";
import { clearModelCooldown, noteModelRefusal } from "../src/model-cooldown.js";
import { readAttempt } from "../src/runtime.js";
import { serializeTaskFile } from "../src/task-file.js";
import { TaskStore } from "../src/task-store.js";
import { runTask, WRAP_UP_INSTRUCTION, type TaskOutcome, type WorkerConfig, type WorkerDeps, type WorkerEvent } from "../src/worker.js";
import { DEFAULT_MODEL_KEY, MODEL_ROUNDS_DEFAULT, newRunContext, readModelWait, writeModelWait } from "../src/model-wait.js";
import { buildTaskFile } from "./helpers/task-fixture.js";
import { markDoneTask } from "./helpers/watch-fixture.js";

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
