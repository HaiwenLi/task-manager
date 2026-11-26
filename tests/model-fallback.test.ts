import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter, PromptResult } from "../src/adapters/types.js";
import { modelChain, readModelRotation } from "../src/models.js";
import { journalTail } from "../src/journal.js";
import { readModelWait } from "../src/model-wait.js";
import { TaskStore } from "../src/task-store.js";
import { runTask, type WorkerConfig, type WorkerEvent } from "../src/worker.js";

let root: string;
let tasks: string;
let cwd: string;
let store: TaskStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "taskctl-models-"));
  tasks = join(root, "tasks");
  cwd = join(root, "work");
  await mkdir(tasks);
  await mkdir(cwd);
  store = new TaskStore(tasks);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A task with criteria (so the review gate runs) and, by default, its own model. */
async function seed(model: string | null = "w/one"): Promise<void> {
  await writeFile(join(tasks, "a.md"), [
    "---",
    "schema: taskctl/v1",
    "title: Fallback task",
    "status: open",
    'acceptance: "check"',
    "criteria:",
    "  - C1 done",
    ...(model === null ? [] : [`model: ${model}`]),
    "review_rounds: 0",
    "sessions: []",
    "retries: 0",
    "---",
    "Do work",
    "",
  ].join("\n"), "utf8");
}

function config(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    tasksDir: tasks,
    workdir: cwd,
    agent: "fixture",
    contextThreshold: 0.8,
    retryLimit: 1,
    lockTtlMs: 5_000,
    heartbeatMs: 50,
    ...overrides,
  };
}

type Behaviour = PromptResult | "done";
type Args = Parameters<AgentAdapter["prompt"]>[0];

/** A passing reviewer answer; criteria ids are reported back verbatim. */
const PASS_VERDICT: Behaviour = {
  sessionId: "s-review",
  exitCode: 0,
  text: '{"verdict":"pass","criteria":[{"id":"C1","pass":true,"evidence":"ok"}],"defects":[],"summary":"ok"}',
};
const rejected = (model: string): PromptResult => ({ sessionId: `s-${model}`, text: "", exitCode: 1, failure: "provider" });

/**
 * One fake backend, keyed by the model it was asked to use. Worker turns and
 * review turns get separate tables, because both may run on the same model name
 * and the point of these tests is which model was handed what.
 */
function adapter(
  tables: { turns: Record<string, Behaviour>; reviews?: Record<string, Behaviour> },
  models: string[] = [],
  sessions: (string | undefined)[] = [],
): AgentAdapter {
  const answer = async (args: Args): Promise<PromptResult> => {
    const model = args.model ?? "(default)";
    const review = args.title?.startsWith("review:") === true;
    models.push(`${review ? "review:" : ""}${model}`);
    if (!review) sessions.push(args.sessionId);
    const behaviour = (review ? tables.reviews : tables.turns)?.[model];
    if (behaviour === undefined) throw new Error(`unexpected ${review ? "review" : "turn"} model ${model}`);
    if (behaviour !== "done") return behaviour;
    // The real worker signals completion through `taskctl done`.
    await mkdir(join(tasks, "a"), { recursive: true });
    await writeFile(join(tasks, "a", "done.requested"), "done");
    return { sessionId: `s-${model}`, text: "done", exitCode: 0 };
  };
  return {
    prompt: answer,
    start: (args: Args) => ({
      result: answer(args),
      inspect: () => ({ state: "exited" as const }),
      cancel: async () => true,
    }),
    contextUsage: async () => 0,
    contextLimit: async () => 100,
  };
}

const pass = async () => ({ passed: true, skipped: false as const, exitCode: 0, output: "observed" });

async function run(agent: AgentAdapter, events: WorkerEvent[] = [], overrides: Partial<WorkerConfig> = {}) {
  return runTask(config(overrides), {
    store,
    adapter: agent,
    acceptance: pass,
    onEvent: (event) => { events.push(event); },
  }, await store.get("a"), "w1");
}

describe("model chain", () => {
  it("needs a primary and drops blanks and repeats", () => {
    expect(modelChain(undefined, ["x/y"])).toEqual([]);
    expect(modelChain("a/one", undefined)).toEqual(["a/one"]);
    expect(modelChain("a/one", ["", "a/one", "b/two"])).toEqual(["a/one", "b/two"]);
  });
});

describe("worker model fallback", () => {
  it("hands a rejected turn to the next model without spending a retry", async () => {
    await seed();
    const events: WorkerEvent[] = [];
    const models: string[] = [];
    const agent = adapter({
      turns: { "w/one": rejected("w/one"), "w/two": "done" },
      reviews: { "w/two": PASS_VERDICT },
    }, models);

    const outcome = await run(agent, events, { modelFallbacks: ["w/two"] });

    // retryLimit is 1: a spent retry would have blocked the task here.
    expect(outcome).toBe("done");
    expect(models.filter((model) => !model.startsWith("review:"))).toEqual(["w/one", "w/two"]);
    expect(events.find((event) => event.type === "model-fallback")?.detail).toBe("worker: w/one -> w/two");
    expect((await store.get("a")).retries).toBe(0);
    expect((await readModelRotation(tasks, "a")).worker).toEqual({ index: 1, model: "w/two" });
    expect((await journalTail(tasks, "a", 20)).join("\n")).toContain("model-fallback");
  });

  it("starts a new session for the model that takes over", async () => {
    await seed();
    const models: string[] = [];
    const sessions: (string | undefined)[] = [];
    const agent = adapter({
      turns: { "w/one": rejected("w/one"), "w/two": "done" },
      reviews: { "w/two": PASS_VERDICT },
    }, models, sessions);

    expect(await run(agent, [], { modelFallbacks: ["w/two"] })).toBe("done");
    // The rejected turn's session is neither resumed nor recorded as a session
    // the task spent: the next provider must not inherit another backend's
    // transcript, and a turn that did no work is not part of the session chain.
    expect(sessions).toEqual([undefined, undefined]);
    expect((await store.get("a")).sessions).toEqual(["s-w/two"]);
  });

  it("defers once the chain is spent, keeping the last model chosen", async () => {
    await seed();
    const models: string[] = [];
    const agent = adapter({ turns: { "w/one": rejected("w/one"), "w/two": rejected("w/two") } }, models);

    const outcome = await run(agent, [], { modelFallbacks: ["w/two"] });

    expect(outcome).toBe("open");
    expect(models).toEqual(["w/one", "w/two"]);
    expect((await store.get("a")).retries).toBe(0);
    expect((await readModelRotation(tasks, "a")).worker).toEqual({ index: 1, model: "w/two" });
  });

  it("starts every round at the head of the chain", async () => {
    await seed();
    const models: string[] = [];
    const dead = { turns: { "w/one": rejected("w/one"), "w/two": rejected("w/two") } };
    // The first attempt spends the whole chain and defers.
    // This test targets per-task rotation, not the newer board-level cooldown.
    await run(adapter(dead, models), [], { modelFallbacks: ["w/two"], modelCooldownMs: 0 });
    await store.updateFields("a", { retries: 0 });
    await store.setStatus("a", "open");
    const healthy = { turns: { "w/one": "done", "w/two": "done" }, reviews: { "w/one": PASS_VERDICT } } satisfies Parameters<typeof adapter>[0];
    await run(adapter(healthy, models), [], { modelFallbacks: ["w/two"], modelCooldownMs: 0 });

    expect(models.filter((model) => !model.startsWith("review:"))).toEqual(["w/one", "w/two", "w/one"]);
  });
});

describe("reviewer model fallback", () => {
  it("runs the review on the worker chain when no reviewer model is configured", async () => {
    await seed();
    const models: string[] = [];
    const agent = adapter({ turns: { "w/one": "done" }, reviews: { "w/one": PASS_VERDICT } }, models);

    expect(await run(agent, [])).toBe("done");
    expect(models).toEqual(["w/one", "review:w/one"]);
  });

  it("reviews on the model that took over when the worker was refused on the head", async () => {
    await seed();
    const models: string[] = [];
    const agent = adapter({ turns: { "w/one": rejected("w/one"), "w/two": "done" }, reviews: { "w/two": PASS_VERDICT } }, models);

    expect(await run(agent, [], { modelFallbacks: ["w/two"] })).toBe("done");
    // w/one is cooling on the worker's own refusal, so the inherited chain is walked past it.
    expect(models.filter((model) => model.startsWith("review:"))).toEqual(["review:w/two"]);
  });

  it("resolves reviewer variants before dispatch instead of appending effort blindly", async () => {
    await seed();
    const agent = adapter({ turns: { "w/one": "done" }, reviews: { "r/one": PASS_VERDICT } });
    const resolutions: string[] = [];
    const reviewEfforts: (string | undefined)[] = [];
    agent.resolveModel = async (model, effort) => {
      resolutions.push(`${model ?? "(default)"}#${effort ?? "(none)"}`);
      return model;
    };
    const start = agent.start!.bind(agent);
    agent.start = (args) => {
      if (args.title?.startsWith("review:")) reviewEfforts.push(args.effort);
      return start(args);
    };

    expect(await run(agent, [], { reviewerModel: "r/one", reviewerEffort: "high" })).toBe("done");
    expect(resolutions).toContain("r/one#high");
    expect(reviewEfforts).toEqual([undefined]);
  });

  it("re-reviews with the next model instead of re-running the work", async () => {
    await seed();
    const models: string[] = [];
    const agent = adapter({
      turns: { "w/one": "done" },
      reviews: { "r/one": rejected("r/one"), "r/two": PASS_VERDICT },
    }, models);
    const cfg = { reviewerModel: "r/one", reviewerModelFallbacks: ["r/two"] };

    // The rejected review is retried inside the review stage: the single retry
    // is untouched, and the task does not go back through the worker, which
    // would duplicate the side effects of a task that is not idempotent.
    expect(await run(agent, [], cfg)).toBe("done");
    expect((await store.get("a")).retries).toBe(0);
    expect((await readModelRotation(tasks, "a")).reviewer).toEqual({ index: 1, model: "r/two" });
    expect(models.filter((model) => !model.startsWith("review:"))).toEqual(["w/one"]);
    expect(models.filter((model) => model.startsWith("review:"))).toEqual(["review:r/one", "review:r/two"]);
  });

  it("defers the review without rerunning successful work when no reviewer model is left", async () => {
    await seed();
    const models: string[] = [];
    const agent = adapter({ turns: { "w/one": "done" }, reviews: { "r/one": rejected("r/one") } }, models);

    expect(await run(agent, [], { reviewerModel: "r/one", retryLimit: 2 })).toBe("open");
    expect(models.filter((model) => !model.startsWith("review:"))).toEqual(["w/one"]);
    expect(models.filter((model) => model.startsWith("review:"))).toEqual(["review:r/one"]);
    expect((await store.get("a")).retries).toBe(0);
    expect((await store.get("a")).status).toBe("open");
    expect(await readModelWait(tasks, "a")).toMatchObject({ stage: "review", rounds: 1 });
  });
});

describe("rotation is advisory", () => {
  it("starts at the head when models.json is damaged", async () => {
    await seed();
    await mkdir(join(tasks, "a"), { recursive: true });
    await writeFile(join(tasks, "a", "models.json"), "{ not json", "utf8");
    const models: string[] = [];
    const agent = adapter({ turns: { "w/one": "done" }, reviews: { "w/one": PASS_VERDICT } }, models);

    expect(await run(agent, [], { modelFallbacks: ["w/two"] })).toBe("done");
    expect(models.filter((model) => !model.startsWith("review:"))).toEqual(["w/one"]);
  });

  it("treats an unreadable models.json as no rotation at all", async () => {
    await seed();
    // A directory where the record should be: the read cannot succeed, and a
    // cache file must never turn a working task into an uncertain attempt.
    await mkdir(join(tasks, "a", "models.json"), { recursive: true });
    const models: string[] = [];
    const agent = adapter({ turns: { "w/one": "done" }, reviews: { "w/one": PASS_VERDICT } }, models);

    expect(await run(agent, [], { modelFallbacks: ["w/two"] })).toBe("done");
    expect(models.filter((model) => !model.startsWith("review:"))).toEqual(["w/one"]);
  });

  it("ends as a deferral instead of throwing when a rotation cannot be recorded", async () => {
    await seed();
    await mkdir(join(tasks, "a", "models.json"), { recursive: true });
    const models: string[] = [];
    const agent = adapter({
      turns: { "w/one": rejected("w/one"), "w/two": rejected("w/two") },
    }, models);

    // The write fails (the path is a directory). The attempt must end as a
    // deferral with a journal line, not as an exception out of a turn that had
    // already settled.
    expect(await run(agent, [], { modelFallbacks: ["w/two"] })).toBe("open");
    expect((await journalTail(tasks, "a", 20)).join("\n")).toContain("model-fallback-failed");
  });

  it("walks a chain changed between two rounds from its new head", async () => {
    await seed(null);
    const models: string[] = [];
    // The first round is refused on both models and leaves the position on the second.
    await run(adapter({ turns: { "w/one": rejected("w/one"), "w/two": rejected("w/two") } }, models), [], { model: "w/one", modelFallbacks: ["w/two"], modelCooldownMs: 0 });
    expect((await readModelRotation(tasks, "a")).worker).toEqual({ index: 1, model: "w/two" });
    // Between the rounds the owner puts another model at the head. The recorded position still names
    // w/two, and w/two is still the second model: only the reset brings the round to the new head.
    const agent = adapter({ turns: { "w/three": "done" }, reviews: { "w/three": PASS_VERDICT } }, models);

    expect(await run(agent, [], { model: "w/three", modelFallbacks: ["w/two"], modelCooldownMs: 0 })).toBe("done");
    expect(models).toEqual(["w/one", "w/two", "w/three", "review:w/three"]);
  });

  it("ignores a fallback list when no primary model is configured", async () => {
    await seed(null);
    const models: string[] = [];
    const agent = adapter({ turns: { "(default)": "done" }, reviews: { "(default)": PASS_VERDICT } }, models);

    expect(await run(agent, [], { modelFallbacks: ["w/two"] })).toBe("done");
    expect(models).toEqual(["(default)", "review:(default)"]);
    expect((await readModelRotation(tasks, "a")).worker).toBeUndefined();
  });
});
