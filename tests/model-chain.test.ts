import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter, PromptResult } from "../src/adapters/types.js";
import { classifyDispatchFailure, matchesQuotaHint } from "../src/dispatch.js";
import { latestNote } from "../src/handoff.js";
import { journalTail } from "../src/journal.js";
import { configChain, readModelRotation } from "../src/models.js";
import type { ReviewResult } from "../src/review.js";
import { TaskStore } from "../src/task-store.js";
import { runTask, type WorkerConfig, type WorkerEvent } from "../src/worker.js";

let root: string;
let tasks: string;
let cwd: string;
let store: TaskStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "taskctl-chain-"));
  tasks = join(root, "tasks");
  cwd = join(root, "work");
  await mkdir(tasks);
  await mkdir(cwd);
  store = new TaskStore(tasks);
  await writeFile(join(tasks, "a.md"), [
    "---", "schema: taskctl/v1", "title: dispatch task", "status: open",
    'acceptance: "check"', "criteria:", "  - C1 ok",
    "sessions: []", "retries: 0", "review_rounds: 0", "---", "干活", "",
  ].join("\n"), "utf8");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function config(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    tasksDir: tasks, workdir: cwd, agent: "fixture", contextThreshold: 0.8,
    retryLimit: 1, lockTtlMs: 5_000, heartbeatMs: 50,
    // No waiting in tests: the schedule is asserted on its own below.
    quotaBackoffMs: [0],
    ...overrides,
  };
}

const passing = async () => ({ passed: true, skipped: false as const, exitCode: 0, output: "ok" });
const passingReview = async (): Promise<ReviewResult> => ({
  verdict: "pass", criteria: [{ id: "C1", pass: true, evidence: "ok" }],
  externalChanges: [], defects: [], summary: "ok",
});

/** A refusal that looks like an exhausted allowance. */
const quotaRefusal = (text = "Error: weekly limit reached for this account"): PromptResult =>
  ({ sessionId: "", exitCode: 1, text, failure: "provider", tokens: 0 });

/**
 * A backend that answers per model. `"done"` means the turn also requests
 * completion, which is how a worker signals it is finished.
 */
function adapter(byModel: Record<string, PromptResult | "done">): { adapter: AgentAdapter; seen: string[] } {
  const seen: string[] = [];
  const answer = async (args: { model?: string }): Promise<PromptResult> => {
    const model = args.model ?? "(default)";
    seen.push(model);
    const behaviour = byModel[model];
    if (behaviour === undefined) throw new Error(`unexpected model ${model}`);
    if (behaviour !== "done") return behaviour;
    await mkdir(join(tasks, "a"), { recursive: true });
    await writeFile(join(tasks, "a", "done.requested"), "done");
    return { sessionId: `ses-${model}`, text: "done", exitCode: 0 };
  };
  return {
    seen,
    adapter: {
      prompt: (args) => answer(args),
      start: (args) => ({
        result: answer(args),
        inspect: () => ({ state: "exited" as const }),
        cancel: async () => true,
      }),
      contextUsage: async () => 0,
      contextLimit: async () => 100,
    },
  };
}

async function run(agent: AgentAdapter, events: WorkerEvent[] = [], overrides: Partial<WorkerConfig> = {}) {
  return runTask(config(overrides), {
    store, adapter: agent, acceptance: passing, review: passingReview,
    onEvent: (event) => { events.push(event); },
  }, await store.get("a"), "w1");
}

const chain = ["q/one", "q/two", "q/three"];

describe("model chain configuration", () => {
  it("is the whole chain when set, and [model] plus fallbacks when not", () => {
    expect(configChain("a/one", undefined, ["b/two"])).toEqual(["a/one", "b/two"]);
    expect(configChain("a/one", ["c/one", "c/two"], [])).toEqual(["c/one", "c/two"]);
    // Fallbacks still append: the two ways of declaring alternatives compose.
    expect(configChain("a/one", ["c/one"], ["b/two"])).toEqual(["c/one", "b/two"]);
    // An empty chain is "unset", not "no models".
    expect(configChain("a/one", [], undefined)).toEqual(["a/one"]);
  });
});

describe("quota classification", () => {
  it("reads a hint word as quota even for a slow, chatty turn", () => {
    expect(classifyDispatchFailure({
      failure: "provider", exitCode: 1, durationMs: 60_000, tokens: 900,
      output: "429 Too Many Requests: quota exceeded",
    })).toBe("quota");
  });

  it("reads a fast, zero-token refusal as quota even without a hint word", () => {
    expect(classifyDispatchFailure({
      failure: "provider", exitCode: 1, durationMs: 400, tokens: 0, output: "request failed",
    })).toBe("quota");
  });

  it("leaves a refusal that did work, or is not a provider refusal, on the ordinary path", () => {
    expect(classifyDispatchFailure({
      failure: "provider", exitCode: 1, durationMs: 60_000, tokens: 5_000, output: "model overloaded",
    })).toBe("provider");
    expect(classifyDispatchFailure({
      exitCode: 1, durationMs: 100, tokens: 0, output: "weekly limit",
    })).toBeUndefined();
  });

  it("matches the documented hint vocabulary", () => {
    for (const word of ["weekly limit", "usage limit", "rate limit", "quota", "credit", "balance"]) {
      expect(matchesQuotaHint(`Error: ${word} reached`)).toBe(true);
    }
    expect(matchesQuotaHint("Error: model not found")).toBe(false);
  });
});

describe("dispatch on a quota refusal", () => {
  it("advances the chain without spending a retry, and finishes on a funded model", async () => {
    const events: WorkerEvent[] = [];
    const { adapter: agent, seen } = adapter({
      "q/one": quotaRefusal(),
      "q/two": quotaRefusal("Error: usage limit for this 5-hour window"),
      "q/three": "done",
    });

    const outcome = await run(agent, events, { model: "q/one", modelChain: chain });

    expect(outcome).toBe("done");
    expect(seen).toEqual(["q/one", "q/two", "q/three"]);
    const task = await store.get("a");
    expect(task.retries).toBe(0);
    expect(task.status).toBe("done");
    expect((await readModelRotation(tasks, "a")).worker).toMatchObject({ index: 2, model: "q/three" });
  });

  it("blocks with a note naming every refused model when the chain is spent", async () => {
    const events: WorkerEvent[] = [];
    const { adapter: agent, seen } = adapter({
      "q/one": quotaRefusal("Error: weekly limit reached"),
      "q/two": quotaRefusal("Error: 用量上限已达"),
      "q/three": quotaRefusal("Error: insufficient credit balance"),
    });

    const outcome = await run(agent, events, { model: "q/one", modelChain: chain });

    expect(outcome).toBe("blocked");
    expect(seen).toEqual(chain);
    const task = await store.get("a");
    expect(task.status).toBe("blocked");
    // The whole point: an allowance this task cannot control costs no retries.
    expect(task.retries).toBe(0);
    expect(events.find((event) => event.type === "blocked")?.detail).toContain("retries untouched");

    const note = await latestNote(tasks, "a");
    expect(note?.markdown).toContain("blocked:needs-owner");
    for (const model of chain) expect(note?.markdown).toContain(model);
    expect((await journalTail(tasks, "a", 20)).join("\n")).toContain("quota exhausted on every model: q/one -> q/two -> q/three");
  });

  it("still spends a retry on a provider failure that is not about quota", async () => {
    const events: WorkerEvent[] = [];
    const { adapter: agent, seen } = adapter({
      "q/one": { sessionId: "s", exitCode: 1, text: "model overloaded", failure: "provider", tokens: 5_000 },
    });

    const outcome = await run(agent, events, { model: "q/one", modelChain: ["q/one"] });

    expect(outcome).toBe("blocked");
    expect(seen).toEqual(["q/one"]);
    expect((await store.get("a")).retries).toBe(1);
    expect(events.find((event) => event.type === "blocked")?.detail).toContain("retry limit");
    expect(await latestNote(tasks, "a")).toBeNull();
  });
});

/**
 * A backend whose answer depends on how many times it has been asked, so a
 * model can refuse once (its quota window is closed) and answer on the next
 * visit (the window reset while the chain walked).
 */
function scripted(script: Record<string, Array<PromptResult | "done">>): { adapter: AgentAdapter; seen: string[] } {
  const seen: string[] = [];
  const step = new Map<string, number>();
  const answer = async (args: { model?: string }): Promise<PromptResult> => {
    const model = args.model ?? "(default)";
    seen.push(model);
    const at = step.get(model) ?? 0;
    step.set(model, at + 1);
    const behaviour = script[model]?.[at];
    if (behaviour === undefined) throw new Error(`unexpected dispatch: ${model} step ${at}`);
    if (behaviour !== "done") return behaviour;
    await mkdir(join(tasks, "a"), { recursive: true });
    await writeFile(join(tasks, "a", "done.requested"), "done");
    return { sessionId: `ses-${model}-${at}`, text: "done", exitCode: 0 };
  };
  return {
    seen,
    adapter: {
      prompt: (args) => answer(args),
      start: (args) => ({
        result: answer(args),
        inspect: () => ({ state: "exited" as const }),
        cancel: async () => true,
      }),
      contextUsage: async () => 0,
      contextLimit: async () => 100,
    },
  };
}

describe("cyclic chain (chainCycles)", () => {
  it("wraps to the head when the tail refuses, and finishes on a recovered model", async () => {
    const first = scripted({
      "q/one": [quotaRefusal(), "done"],
      "q/two": [quotaRefusal()],
      "q/three": [quotaRefusal()],
    });

    const outcome = await run(first.adapter, [], { model: "q/one", modelChain: chain, chainCycles: 1 });

    // The whole chain refused once; the wrap gave the head a second chance and
    // its window had reset — exactly the cyclic behaviour an operator asked
    // for: park only when the whole cycle is out of allowance.
    expect(outcome).toBe("done");
    expect(first.seen).toEqual(["q/one", "q/two", "q/three", "q/one"]);
    expect((await store.get("a")).retries).toBe(0);
    expect(await readModelRotation(tasks, "a")).toMatchObject({
      worker: { index: 0, model: "q/one" },
      cycles: { worker: 1 },
    });
  });

  it("parks for the owner only after the whole cycle refused, retries untouched", async () => {
    const events: WorkerEvent[] = [];
    const allDown = scripted({
      "q/one": [quotaRefusal(), quotaRefusal()],
      "q/two": [quotaRefusal(), quotaRefusal()],
      "q/three": [quotaRefusal(), quotaRefusal()],
    });

    const outcome = await run(allDown.adapter, events, { model: "q/one", modelChain: chain, chainCycles: 1 });

    expect(outcome).toBe("blocked");
    expect(allDown.seen).toEqual([...chain, ...chain]);
    const task = await store.get("a");
    expect(task.status).toBe("blocked");
    expect(task.retries).toBe(0);
    const blocked = events.find((event) => event.type === "blocked")?.detail ?? "";
    expect(blocked).toContain("1 wrap(s)");
    expect(blocked).toContain("owner decision required");
    const note = await latestNote(tasks, "a");
    expect(note?.markdown).toContain("blocked:needs-owner");
    expect(note?.markdown).toContain("付费档");
    expect((await journalTail(tasks, "a", 20)).join("\n")).toContain("chainCycles=1 wrap(s) included");
  });

  it("gives a new attempt a fresh wrap budget while keeping the position", async () => {
    const allDown = scripted({
      "q/one": [quotaRefusal(), quotaRefusal()],
      "q/two": [quotaRefusal(), quotaRefusal()],
      "q/three": [quotaRefusal(), quotaRefusal()],
    });
    await run(allDown.adapter, [], { model: "q/one", modelChain: chain, chainCycles: 1 });
    await store.updateFields("a", { retries: 0 });
    await store.setStatus("a", "open");

    // The rerun starts at the tail (the rotation survived, so the dead head is
    // not retried first) and may wrap again (the budget reset with the attempt)
    // — here the tail is still down and the head has recovered.
    const recovered = scripted({
      "q/three": [quotaRefusal()],
      "q/one": ["done"],
      "q/two": [quotaRefusal()],
    });
    const outcome = await run(recovered.adapter, [], { model: "q/one", modelChain: chain, chainCycles: 1 });

    expect(outcome).toBe("done");
    expect(recovered.seen).toEqual(["q/three", "q/one"]);
    expect((await store.get("a")).retries).toBe(0);
  });
});
