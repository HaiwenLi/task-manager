import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter, PromptResult } from "../src/adapters/types.js";
import { OpenCodeAdapter } from "../src/adapters/opencode.js";
import { runCli } from "../src/cli.js";
import type { Execution } from "../src/execution.js";
import { readJournal } from "../src/journal.js";
import { noteModelRefusal } from "../src/model-cooldown.js";
import { readAttempt, readRuntime } from "../src/runtime.js";
import { runScheduler } from "../src/scheduler.js";
import { TaskStore } from "../src/task-store.js";
import { runTask, type WorkerConfig, type WorkerDeps, type WorkerEvent } from "../src/worker.js";
import { reserveWorkspace } from "../src/workspace.js";
import { buildContinuousTask as task, buildTaskFile } from "./helpers/task-fixture.js";
import { doneAdapter, markDoneTask, passAcceptance, seedTaskFile, workerConfigFixture, writeBatchConfig } from "./helpers/watch-fixture.js";

let root: string;
let tasks: string;
let work: string;
let store: TaskStore;
let cfg: WorkerConfig;
let events: WorkerEvent[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "taskctl-fault-isolation-"));
  tasks = join(root, "tasks");
  work = join(root, "work");
  await mkdir(tasks);
  await mkdir(work);
  store = new TaskStore(tasks);
  cfg = workerConfigFixture({ tasksDir: tasks, workdir: work, lockTtlMs: 5_000, heartbeatMs: 1_000 });
  events = [];
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function deps(agent: AgentAdapter, overrides: Partial<WorkerDeps> = {}): WorkerDeps {
  return {
    store,
    adapter: agent,
    acceptance: passAcceptance,
    onEvent: (event) => { events.push(event); },
    ...overrides,
  };
}

/** The workspace is free again exactly when a fresh reservation succeeds. */
async function workspaceFree(): Promise<boolean> {
  const probe = await reserveWorkspace(work, "probe");
  await probe?.release();
  return probe !== null;
}

/**
 * A backend whose worker turns answer at once and whose review turn never
 * ends on its own, but stops when asked: the shape of a reviewer that hits
 * the turn timeout while its shutdown stays confirmable.
 */
function slowReviewer(): AgentAdapter {
  const worker = doneAdapter({ tasksDir: tasks, sessionId: (id) => `s-${id}` });
  return {
    ...worker,
    start: (args): Execution<PromptResult> => {
      let state: "running" | "exited" = "running";
      if (!args.text.includes("独立复核者")) {
        const result = worker.prompt(args).finally(() => { state = "exited"; });
        return { result, inspect: () => ({ state }), cancel: async () => false };
      }
      return {
        result: new Promise<PromptResult>(() => {}),
        inspect: () => ({ state }),
        cancel: async () => { state = "exited"; return true; },
      };
    },
  };
}

/** A store whose next session append fails the way a full disk does. */
function storeFailingNextAppend(): TaskStore {
  const flaky = Object.create(store) as TaskStore;
  let failNext = true;
  flaky.appendSession = async (...args: Parameters<TaskStore["appendSession"]>) => {
    if (failNext) {
      failNext = false;
      throw new Error("disk full");
    }
    return store.appendSession(...args);
  };
  return flaky;
}

describe("a failure confined to one task", () => {
  it("parks only the review when the reviewer times out with a confirmed shutdown", async () => {
    await seedTaskFile(tasks, task("a", { verify: "human", criteria: ["C1 ok"] }));

    const outcome = await runTask({ ...cfg, turnTimeoutMs: 300 }, deps(slowReviewer()), await store.get("a"), "w1");

    expect(outcome).toBe("blocked");
    expect((await store.get("a")).status).toBe("blocked");
    // Work and acceptance are kept; only the missing review is pending.
    expect(await readRuntime(tasks, "a", "review-pending.json")).not.toBeNull();
    expect((await readAttempt(tasks, "a"))?.phase).toBe("settled");
    expect(await workspaceFree()).toBe(true);
    expect((await readJournal(tasks, "a")).some((line) => line.event === "review-pending" && /timed out/.test(line.detail)))
      .toBe(true);
  }, 10_000);

  it("labels the evidence with the model that ran even when it cooled down just before acceptance", async () => {
    await seedTaskFile(tasks, task("a"));
    const cooling = Object.create(store) as TaskStore;
    let noted = false;
    cooling.readDoneMarker = async (...args: Parameters<TaskStore["readDoneMarker"]>) => {
      if (!noted) {
        noted = true;
        await noteModelRefusal(tasks, "w/one", { reason: "another task saw a 5xx", cooldownMs: 600_000 });
      }
      return store.readDoneMarker(...args);
    };

    const outcome = await runTask(cfg, deps(doneAdapter({ tasksDir: tasks, sessionId: (id) => `s-${id}` }), { store: cooling }),
      await store.get("a"), "w1");

    expect(outcome).toBe("done");
    expect((await store.get("a")).status).toBe("done");
    expect((await readRuntime<Record<string, unknown>>(tasks, "a", "acceptance.json"))?.model).toBe("w/one");
  });

  it("blocks a task whose backend cannot be spawned, without false uncertainty or a leaked reservation", async () => {
    await seedTaskFile(tasks, task("a"));

    const outcome = await runTask(cfg, deps(new OpenCodeAdapter({ bin: "taskctl-no-such-binary" })), await store.get("a"), "w1");

    expect(outcome).toBe("blocked");
    expect((await store.get("a")).status).toBe("blocked");
    expect((await readAttempt(tasks, "a"))?.phase).toBe("settled");
    expect(await workspaceFree()).toBe(true);
    expect(events.map((event) => event.type)).toContain("controller-error");
  });

  it("keeps serving the board when one task hits a controller bug", async () => {
    await seedTaskFile(tasks, task("a"), task("b"));

    const result = await runScheduler(cfg, deps(doneAdapter({ tasksDir: tasks, sessionId: (id) => `s-${id}` }), { store: storeFailingNextAppend() }));

    expect(result).toMatchObject({ done: ["b"], blocked: ["a"] });
    expect((await readAttempt(tasks, "a"))?.phase).toBe("settled");
    expect((await readJournal(tasks, "a")).some((line) => line.event === "controller-error" && /disk full/.test(line.detail)))
      .toBe(true);
    expect(await workspaceFree()).toBe(true);
  });

  it("says once when the context budget cannot be checked", async () => {
    await seedTaskFile(tasks, buildTaskFile({
      id: "a", complexity: "complex", verify: "mechanical", criteria: ["C1 ok"], acceptance: "check", model: "w/one",
    }));
    let turns = 0;
    const blindLimit: AgentAdapter = {
      prompt: async (args) => {
        turns++;
        if (turns >= 3) await markDoneTask(args.text, tasks);
        return { sessionId: "s-a", exitCode: 0, text: "working" };
      },
      contextUsage: async () => 0,
      contextLimit: async () => { throw new Error("unknown model w/one"); },
    };

    const outcome = await runTask(cfg, deps(blindLimit), await store.get("a"), "w1");

    expect(outcome).toBe("done");
    expect(turns).toBe(3);
    // 静默的「没超预算」读起来像一个测出来的答案；控制面不回答时要在 journal 里看得见，且只说一次。
    const lines = (await readJournal(tasks, "a")).filter((line) => line.event === "context-budget-unavailable");
    expect(lines).toHaveLength(1);
    expect(lines[0]?.detail).toContain("unknown model");
  });

  it("taskctl run drains the rest of the board and exits 1 when a task hit a controller error", async () => {
    await seedTaskFile(tasks, task("a"), task("b"));
    const configPath = await writeBatchConfig(root, { tasksDir: tasks, workdir: work, lockTtlMs: 5_000, heartbeatMs: 20 });
    const lines: string[] = [];

    const code = await runCli(["run", "--config", configPath], {
      adapter: doneAdapter({ tasksDir: tasks, sessionId: (id) => `s-${id}` }),
      acceptance: passAcceptance,
      store: storeFailingNextAppend(),
      log: (line) => { lines.push(line); },
      err: (line) => { lines.push(line); },
    });

    expect(code).toBe(1);
    expect((await store.get("a")).status).toBe("blocked");
    expect((await store.get("b")).status).toBe("done");
    expect(lines.join("\n")).toContain("controller-error");
  });
});
