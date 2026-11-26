// What the backend says when it refuses a turn must reach every place that reports a refusal —
// the deferral record, the outage report, the preserved review — and a refusal the backend
// typed must be one whatever its words. Both were found live on 2026-11-26 (opencode 2.4.2,
// Tasks 16 and 17 of the model-refusals plan): an unknown model is refused with a single
// `error` event and nothing on stderr, and the report, the journal and the record all said
// "no output"; a default model that was gone answered `provider.invalid-request` with "Upstream
// request failed: Model is unavailable." — no word on the adapter's list — and read as an
// ordinary failure the turn would have spent a retry instead of deferring the task.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { OpenCodeAdapter } from "../src/adapters/opencode.js";
import type { AgentAdapter, PromptResult } from "../src/adapters/types.js";
import { resetGuardState } from "../src/budget.js";
import type { Execution } from "../src/execution.js";
import { readModelWait } from "../src/model-wait.js";
import { readRuntime } from "../src/runtime.js";
import { outageReport } from "../src/stuck.js";
import { runTask, type WorkerConfig } from "../src/worker.js";
import { TaskStore } from "../src/task-store.js";

const fixture = fileURLToPath(new URL("./adapters/fake-opencode.mjs", import.meta.url));
const backend = (): OpenCodeAdapter => new OpenCodeAdapter({ bin: process.execPath, binArgsPrefix: [fixture] });
/** What the fake prints for an unknown model: the shape the real service printed for one. */
const SAID = "provider.no-route: Variant unavailable for anthropic/sonnet: high";

const HOOKS = ["FAKE_PROVIDER_NOROUTE", "FAKE_PROVIDER_UNAVAILABLE", "FAKE_ERROR_UNTYPED", "FAKE_ERROR_EVENTS", "FAKE_EXIT_CODE"];

afterEach(() => {
  for (const hook of HOOKS) delete process.env[hook];
});

describe("a turn the backend refused", () => {
  it("is a provider failure when the backend typed it so, whatever its words", async () => {
    process.env.FAKE_PROVIDER_UNAVAILABLE = "1";

    const result = await backend().prompt({ text: "hi", cwd: process.cwd() });

    expect(result.exitCode).toBe(1);
    expect(result.failure).toBe("provider");
  });

  it("opens with the backend's own words from its error event", async () => {
    process.env.FAKE_PROVIDER_NOROUTE = "1";

    const result = await backend().prompt({ text: "hi", cwd: process.cwd() });

    expect(result.failure).toBe("provider");
    expect(result.text).toBe(SAID);
  });

  it("carries words no refusal list knows, once the type has decided", async () => {
    process.env.FAKE_PROVIDER_UNAVAILABLE = "1";

    const result = await backend().prompt({ text: "hi", cwd: process.cwd() });

    expect(result.text).toBe("provider.invalid-request: Upstream request failed: Model is unavailable.");
  });

  it("keeps the words of the last of several error events, ahead of what the model got out: they say how the turn ended", async () => {
    process.env.FAKE_ERROR_EVENTS = JSON.stringify([
      { type: "provider.rate-limit", message: "busy" },
      { type: "provider.no-route", message: "Variant unavailable for anthropic/sonnet: high" },
    ]);

    const result = await backend().prompt({ text: "hi", cwd: process.cwd() });

    expect(result.failure).toBe("provider");
    expect(result.text).toBe(`${SAID}\nworking`);
  });

  it("says only what the model said of a turn that succeeded, whatever errors it passed", async () => {
    process.env.FAKE_ERROR_EVENTS = JSON.stringify([{ type: "provider.no-route", message: "Variant unavailable for anthropic/sonnet: high" }]);
    process.env.FAKE_EXIT_CODE = "0";

    const result = await backend().prompt({ text: "hi", cwd: process.cwd() });

    expect(result.exitCode).toBe(0);
    expect(result.failure).toBeUndefined();
    expect(result.text).toBe("working");
  });

  it("stays an ordinary failure when no provider typed it and no refusal word marks it, and still says what it was", async () => {
    process.env.FAKE_ERROR_UNTYPED = "1";

    const result = await backend().prompt({ text: "hi", cwd: process.cwd() });

    expect(result.exitCode).toBe(1);
    expect(result.failure).toBeUndefined();
    expect(result.text).toBe("UnknownError: the tool stack broke");
  });

  it("keeps a successful turn's text to itself", async () => {
    const result = await backend().prompt({ text: "hi", cwd: process.cwd() });

    expect(result.exitCode).toBe(0);
    expect(result.text).toBe("你好，任务完成。");
  });
});

describe("what a refusal reports", () => {
  let tasks: string;
  let work: string;
  let store: TaskStore;

  beforeEach(async () => {
    const root = await mkdtemp(join(tmpdir(), "taskctl-refusal-words-"));
    tasks = join(root, "tasks");
    work = join(root, "work");
    await mkdir(tasks);
    await mkdir(work);
    store = new TaskStore(tasks);
    await writeFile(join(tasks, "a.md"), [
      "---", "schema: taskctl/v1", "title: Refused", "status: open",
      'acceptance: "check"', "criteria:", "  - C1 work is good",
      "sessions: []", "retries: 0", "review_rounds: 0", "---", "Do work", "",
    ].join("\n"), "utf8");
    resetGuardState();
  });

  afterEach(async () => {
    await rm(join(tasks, ".."), { recursive: true, force: true });
  });

  function config(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
    return {
      tasksDir: tasks, workdir: work, agent: "opencode", modelChain: ["anthropic/sonnet"],
      contextThreshold: 0.8, retryLimit: 1, lockTtlMs: 5_000, heartbeatMs: 50,
      ...overrides,
    };
  }

  /** Worker turns answer at once and ask for completion; the review turn is the real adapter's, on the fake backend. */
  function refusingReviewer(calls: string[]): AgentAdapter {
    const real = backend();
    const start = (args: Parameters<AgentAdapter["prompt"]>[0]): Execution<PromptResult> => {
      if (args.text.includes("独立复核者")) return real.start(args);
      let state: "running" | "exited" = "running";
      const result = (async (): Promise<PromptResult> => {
        calls.push("worker");
        await mkdir(join(tasks, "a"), { recursive: true });
        await writeFile(join(tasks, "a", "done.requested"), "done");
        return { sessionId: "worker-session", text: "done", exitCode: 0 };
      })().finally(() => { state = "exited"; });
      return { result, inspect: () => ({ state }), cancel: async () => false };
    };
    return {
      prompt: async (args) => start(args).result,
      contextUsage: async () => 0,
      contextLimit: async () => 100,
      start,
    };
  }

  it("names what the backend said in the deferral record and in the outage report", async () => {
    process.env.FAKE_PROVIDER_NOROUTE = "1";

    const outcome = await runTask(config(), { store, adapter: backend() }, await store.get("a"), "w1");

    expect(outcome).toBe("open");
    expect(await readModelWait(tasks, "a")).toMatchObject({
      stage: "worker",
      refusals: [{ model: "anthropic/sonnet", source: "turn", reason: expect.stringContaining(SAID) }],
    });
    expect(await outageReport(config(), [await store.get("a")], "a")).toMatchObject({
      models: [{ model: "anthropic/sonnet", source: "turn", reason: expect.stringContaining(SAID) }],
    });
  });

  it("names it for a refused review too, where the report and a recovery read it", async () => {
    process.env.FAKE_PROVIDER_NOROUTE = "1";
    const calls: string[] = [];

    const outcome = await runTask(config({ reviewerModel: "anthropic/sonnet" }), {
      store, adapter: refusingReviewer(calls),
      acceptance: async () => ({ passed: true, skipped: false as const, exitCode: 0, output: "observed" }),
    }, await store.get("a"), "w1");

    expect(outcome).toBe("open");
    expect(calls).toEqual(["worker"]);
    expect(await readModelWait(tasks, "a")).toMatchObject({
      stage: "review",
      refusals: [{ model: "anthropic/sonnet", source: "turn", reason: SAID }],
    });
    expect(await readRuntime(tasks, "a", "review-pending.json")).toMatchObject({
      refusals: [{ model: "anthropic/sonnet", reason: SAID }],
    });
  });
});
