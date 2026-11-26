import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "../src/task-store.js";
import type { Task } from "../src/task-file.js";
import { runScheduler, type SchedulerOptions } from "../src/scheduler.js";
import { selectAutomaticBatch } from "../src/batch.js";
import { EXIT_OUTAGE, runCli } from "../src/cli.js";
import { retryTask } from "../src/reconcile.js";
import { resetGuardState } from "../src/budget.js";
import type { AgentAdapter } from "../src/adapters/types.js";
import type { TaskOutcome, WorkerConfig, WorkerDeps, WorkerEvent } from "../src/worker.js";
import { MODEL_ROUNDS_DEFAULT, type ModelWaitRecord, type RunContext, newRunContext, processRun, readModelWait, writeModelWait } from "../src/model-wait.js";
import { outageReport, renderOutageReport } from "../src/stuck.js";
import { readGuardRefusals, recordGuardRefusal } from "../src/guard-refusals.js";
import { watchLockPath } from "../src/watch-lock.js";
import { stopRequestPath, watchQueue, type WatchFs } from "../src/watch.js";
import { adapterOf, CATALOGUE } from "./helpers/catalogue-fixture.js";
import { buildContinuousTask, buildTaskFile } from "./helpers/task-fixture.js";
import { createStopRequests, createWatchEventSeam, doneTaskId, markDoneTask, passAcceptance, seedTaskFile, workerConfigFixture } from "./helpers/watch-fixture.js";

let root: string;
let tasks: string;
let cwd: string;
let store: TaskStore;
let cfg: WorkerConfig;
let listeners: Map<string, () => void>;
let watchFs: WatchFs;
let stop: ReturnType<typeof createStopRequests>;
let deps: WorkerDeps;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "taskctl-outage-"));
  tasks = join(root, "tasks");
  cwd = join(root, "work");
  await mkdir(tasks);
  await mkdir(cwd);
  store = new TaskStore(tasks);
  await mkdir(join(cwd, "a"), { recursive: true });
  await mkdir(join(cwd, "b"), { recursive: true });
  await mkdir(join(cwd, "same"), { recursive: true });
  resetGuardState();
  cfg = workerConfigFixture({ tasksDir: tasks, workdir: cwd, lockTtlMs: 5_000, heartbeatMs: 20 });
  ({ listeners, watchFs } = createWatchEventSeam());
  stop = createStopRequests(tasks, listeners);
  deps = { store, adapter: idle(), acceptance: passAcceptance };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function seed(id: string, extra: string[] = []): Promise<void> {
  const lines = [
    "---",
    "schema: taskctl/v1",
    `title: ${id}`,
    "status: open",
    'acceptance: "check"',
    "criteria:",
    "  - C1 ok",
    ...extra,
    "sessions: []",
    "retries: 0",
    "---",
    "work",
    "",
  ];
  await writeFile(join(tasks, `${id}.md`), lines.join("\n"), "utf8");
}

function config(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    tasksDir: tasks,
    workdir: cwd,
    agent: "fixture",
    contextThreshold: 0.8,
    retryLimit: 1,
    lockTtlMs: 20_000,
    heartbeatMs: 1_000,
    maxTurnsPerSession: 1,
    ...overrides,
  };
}

/** Tasks block at the turn cap, so this gate is never reached; the tests below
 * only assert scheduling. */
const failGate = async () => ({ passed: false, skipped: false as const, exitCode: 1, output: "no" });

const START = new Date("2026-11-25T10:00:00.000Z");
const idle = (): AgentAdapter => ({
  prompt: async () => { throw new Error("a seam replaced runTask; nothing may be dispatched"); },
  contextUsage: async () => 0, contextLimit: async () => 100,
});
const deferral = (run: RunContext, overrides: Partial<ModelWaitRecord> = {}): ModelWaitRecord => ({
  runId: run.id, stage: "worker", rounds: 1, firstRefusedAt: START.toISOString(), refusals: [],
  nextAt: new Date(START.getTime() + 60_000).toISOString(), updatedAt: START.toISOString(), ...overrides,
});
/** A task that has run out of rounds in `run`, as the attempt leaves it. */
const spent = (run: RunContext): ModelWaitRecord => deferral(run, {
  rounds: MODEL_ROUNDS_DEFAULT,
  refusals: [{ model: "q/one", at: START.toISOString(), reason: "exit 1 in 240ms, Error: 503 service unavailable", source: "turn" }],
});
// The seam the tests hand to `runScheduler` runs one offered task with the
// three arguments it actually uses (`runTask` takes a worker id and options
// besides); typed at its own arity, a call site reads the same as the brief's.
const settle = async (_cfg: WorkerConfig, deps: WorkerDeps, task: Task): Promise<TaskOutcome> => {
  await deps.store.setStatus(task.id, "done");
  return "done";
};
const refusing = (): AgentAdapter => ({
  prompt: async () => ({ sessionId: "", exitCode: 1, text: "Error: 503 service unavailable", failure: "provider" as const, tokens: 0 }),
  contextUsage: async () => 0, contextLimit: async () => 100,
});

describe("runScheduler and a deferral", () => {
  it("waits for the nearest time, says so, and runs another pass when nothing else is runnable", async () => {
    await seed("001-a");
    const run = newRunContext(START);
    await writeModelWait(tasks, "001-a", deferral(run));
    let now = START;
    const slept: number[] = [];
    const offered: string[] = [];
    const events: WorkerEvent[] = [];

    const result = await runScheduler(config({ run }), {
      store, adapter: idle(), acceptance: failGate, onEvent: (event) => { events.push(event); },
    }, {
      run: async (cfg, deps, task) => { offered.push(task.id); return settle(cfg, deps, task); },
      now: () => now,
      sleep: async (ms) => { slept.push(ms); now = new Date(now.getTime() + ms); },
    });

    expect(result).toEqual({ done: ["001-a"], blocked: [], pending: [] });
    expect(slept).toEqual([60_000]);
    expect(offered).toEqual(["001-a"]); // not before the wait
    // A wait nobody can see is the anti-goal: one line names the task and the time.
    expect(events.filter((event) => event.type === "model-wait")).toEqual([{
      type: "model-wait", taskId: "001-a",
      detail: "waiting 1m 00s for the next model window (round 1/4; next 2026-11-25T10:01:00.000Z)",
    }]);
  });

  it("a pass that only waited does not count against the pass budget", async () => {
    // The wait comes first (nothing else is runnable), then two working passes
    // follow under a budget of two: had the waiting pass counted, the second
    // working pass would have been cut off and 002-b left in `pending`.
    await seed("001-a");
    await seed("002-b", ["depends_on:", "  - 001-a"]);
    const run = newRunContext(START);
    await writeModelWait(tasks, "001-a", deferral(run));
    let now = START;

    const result = await runScheduler(config({ run }), { store, adapter: idle(), acceptance: failGate }, {
      run: settle, now: () => now, sleep: async (ms) => { now = new Date(now.getTime() + ms); }, maxPasses: 2,
    });

    expect(result).toEqual({ done: ["001-a", "002-b"], blocked: [], pending: [] });
  });

  it("a lapsed deferral whose claim is refused ends the run instead of spinning", async () => {
    await seed("001-a");
    await writeModelWait(tasks, "001-a", deferral(newRunContext(), { nextAt: new Date(Date.now() - 1_000).toISOString() }));
    const slept: number[] = [];
    let offers = 0;

    const result = await runScheduler(config(), { store, adapter: idle(), acceptance: failGate }, {
      run: async () => { offers++; return "skipped"; }, sleep: async (ms) => { slept.push(ms); },
    });

    expect(result).toEqual({ done: [], blocked: [], pending: [] });
    expect(offers).toBe(1);
    expect(slept).toEqual([]);
  });

  it("a deferred task at the head of the queue does not stop the rest of the board", async () => {
    await seed("001-a", ["workdir: a"]);
    await seed("002-b", ["workdir: b"]);
    const run = newRunContext(START);
    await writeModelWait(tasks, "001-a", deferral(run));
    let now = START;
    const offered: string[] = [];

    const result = await runScheduler(config({ parallel: 1, run }), { store, adapter: idle(), acceptance: failGate }, {
      run: async (cfg, deps, task) => { offered.push(task.id); return settle(cfg, deps, task); },
      now: () => now, sleep: async (ms) => { now = new Date(now.getTime() + ms); },
    });

    expect(offered).toEqual(["002-b", "001-a"]); // b first; a once its window has opened
    expect(result).toEqual({ done: ["002-b", "001-a"], blocked: [], pending: [] });
  });

  it("leaves a task the budget guard refused out of the wait and the decision", async () => {
    // The guard's `refused` and a deferral are two exclusions. A guard refusal makes no hold and no
    // round, so the run waits for the deferred task alone and never decides the refused one.
    await seed("001-refused", ["workdir: a"]);
    await seed("002-wait", ["workdir: b"]);
    const run = newRunContext(START);
    await writeModelWait(tasks, "002-wait", deferral(run));
    let now = START;
    const offered: string[] = [];

    const result = await runScheduler(config({ parallel: 1, run }), { store, adapter: idle(), acceptance: failGate }, {
      run: async (cfg, deps, task) => {
        offered.push(task.id);
        return task.id === "001-refused" ? "refused" : settle(cfg, deps, task);
      },
      now: () => now, sleep: async (ms) => { now = new Date(now.getTime() + ms); },
    });

    expect(offered).toEqual(["001-refused", "002-wait"]); // the refused task once, the deferred one after the wait
    expect(result).toEqual({ done: ["002-wait"], blocked: [], pending: [], refused: ["001-refused"] });
  });
});

describe("runScheduler and a task that ran out of rounds", () => {
  it("offers nothing more once a task has run out of rounds, and names that task", async () => {
    await seed("001-a", ["workdir: a"]);
    await seed("002-b", ["workdir: b"]);
    const run = newRunContext(START);
    const offered: string[] = [];

    const result = await runScheduler(config({ parallel: 1, run }), { store, adapter: idle(), acceptance: failGate }, {
      run: async (cfg, deps, task) => {
        offered.push(task.id);
        if (task.id === "001-a") { await writeModelWait(tasks, "001-a", spent(run)); return "open"; }
        return settle(cfg, deps, task);
      },
    });

    // b is next in the queue and is not started: the decision comes first.
    expect(offered).toEqual(["001-a"]);
    expect(result).toEqual({ done: [], blocked: [], pending: [], outage: { taskId: "001-a" } });
  });

  it("leaves a task already in flight to settle", async () => {
    await seed("001-a", ["workdir: a"]);
    await seed("002-b", ["workdir: b"]);
    const run = newRunContext(START);
    let ranOut!: () => void;
    const ranOutAt = new Promise<void>((resolve) => { ranOut = resolve; });

    const result = await runScheduler(config({ parallel: 2, run }), { store, adapter: idle(), acceptance: failGate }, {
      run: async (cfg, deps, task) => {
        if (task.id === "001-a") { await writeModelWait(tasks, "001-a", spent(run)); ranOut(); return "open"; }
        await ranOutAt; // b's work finishes only after a ran out of rounds
        return settle(cfg, deps, task);
      },
    });

    expect(result).toEqual({ done: ["002-b"], blocked: [], pending: [], outage: { taskId: "001-a" } });
  });

  it("never reports an outage while another task is being served", async () => {
    await seed("001-a", ["workdir: a", "model: q/one"]);
    await seed("002-b", ["workdir: b"]);
    const run = newRunContext(START);
    let ranOut!: () => void;
    const ranOutAt = new Promise<void>((resolve) => { ranOut = resolve; });

    const result = await runScheduler(config({ parallel: 2, run }), { store, adapter: idle(), acceptance: failGate }, {
      run: async (cfg, deps, task) => {
        if (task.id === "001-a") { await writeModelWait(tasks, "001-a", spent(run)); ranOut(); return "open"; }
        await ranOutAt; // b's turn is still running when a runs out of rounds…
        run.accepted.set("q/one", START.getTime() + 30_000); // …and is accepted after it, on a model of a's chain: evidence the attempt could not have seen
        return settle(cfg, deps, task);
      },
    });

    expect(result).toEqual({ done: ["002-b"], blocked: ["001-a"], pending: [] });
  });

  it("a run without an outage returns no outage field", async () => {
    await seed("001-a");
    const result = await runScheduler(config(), { store, adapter: idle(), acceptance: failGate }, { run: settle });
    expect(Object.keys(result)).toEqual(["done", "blocked", "pending"]);
  });
});

describe("the outage report", () => {
  it("says what each model said, how long it tried, what is waiting, and whose decision it is", () => {
    expect(renderOutageReport({
      taskId: "003-report", stage: "worker", rounds: 4, modelRounds: 4,
      firstRefusedAt: "2026-11-25T10:00:00.000Z", stoppedAt: "2026-11-25T10:04:03.000Z",
      models: [
        { model: "q/one", reason: "exit 1 in 240ms, Error: weekly limit reached", source: "turn", at: "2026-11-25T10:04:00.000Z" },
        { model: "q/two", reason: "rate limited", source: "table", at: "2026-11-25T10:03:00.000Z" },
        { model: "q/three" },
      ],
      waiting: ["003-report", "004-later"],
    })).toEqual([
      "[model-outage] 003-report: every model refused; stopping here. Nothing is blocked, and every waiting task can simply be run again.",
      "[model-outage]   q/one  exit 1 in 240ms, Error: weekly limit reached",
      "[model-outage]   q/two  not tried in the last round: cooling from another task's refusal at 2026-11-25T10:03:00.000Z — rate limited",
      "[model-outage]   q/three  not tried in the last round",
      "[model-outage]   rounds 4 of 4, over 4m 03s, since 2026-11-25T10:00:00.000Z",
      "[model-outage]   waiting, all still runnable: 003-report, 004-later",
      "[model-outage]   your decision: to use another model, put it into modelChain in taskctl.json, allow it (allowedModels when the backend's catalogue does not report it as free), check it with taskctl models, and run again (taskctl run, or taskctl watch). Models outside the plan may be billed per use.",
    ]);
  });

  it("names each reviewer model's reason from the record, as it names each worker model's", async () => {
    await seedTaskFile(tasks, buildContinuousTask("001-review", { model: "w/one" }));
    await writeModelWait(tasks, "001-review", deferral(newRunContext(START), {
      stage: "review", rounds: MODEL_ROUNDS_DEFAULT,
      refusals: [{ model: "r/one", at: START.toISOString(), reason: "Error: 429 too many requests", source: "turn" }],
    }));

    const report = await outageReport({ ...config(), reviewerModel: "r/one" }, await store.list(), "001-review", new Date("2026-11-25T10:04:03.000Z"));

    expect(report.models).toMatchObject([{ model: "r/one", reason: "Error: 429 too many requests" }]);
    expect(renderOutageReport(report)[1]).toBe("[model-outage]   r/one  Error: 429 too many requests");
  });

  it("a task the budget guard refused is not in the waiting list of the outage report", async () => {
    await seedTaskFile(tasks, buildContinuousTask("001-spent"), buildContinuousTask("004-refused"), buildContinuousTask("005-waiting"));
    await writeModelWait(tasks, "001-spent", spent(newRunContext(START)));
    await recordGuardRefusal(tasks, "004-refused", "- zen/p  provider=zen  enabled=true  variants=-  拒绝：按量计费，约 $15 / 百万 token；未列入 allowedModels", new Date(START));

    const report = await outageReport(config(), await store.list(), "001-spent", new Date("2026-11-25T10:04:03.000Z"));

    // It keeps the guard's own line, which the run printed; it is not "still runnable" work of this report's.
    expect(report.waiting).toEqual(["001-spent", "005-waiting"]);
  });
});

describe("taskctl run", () => {
  const writeConfig = async (settings: Record<string, unknown>): Promise<string> => {
    const path = join(root, "taskctl.json");
    await writeFile(path, JSON.stringify({ tasksDir: tasks, workdir: cwd, lockTtlMs: 5_000, heartbeatMs: 20, ...settings }), "utf8");
    return path;
  };

  it("prints the report and exits 3 on an outage, leaving every waiting task runnable", async () => {
    await seedTaskFile(tasks, buildContinuousTask("001-a", { model: "q/one" }), buildContinuousTask("002-held"));
    await store.setStatus("002-held", "blocked"); // blocked before the run: it is not "waiting"
    const configPath = await writeConfig({ modelChain: ["q/one"], modelRounds: 1 });
    const lines: string[] = [];

    const code = await runCli(["run", "--config", configPath], { adapter: refusing(), acceptance: passAcceptance, log: (line) => { lines.push(line); }, err: (line) => { lines.push(line); } });

    expect(code).toBe(EXIT_OUTAGE);
    expect(code).toBe(3);
    expect(await store.get("001-a")).toMatchObject({ status: "open", retries: 0 });
    expect(lines.some((line) => line.startsWith("[001-a] outage "))).toBe(true);
    const report = lines.filter((line) => line.startsWith("[model-outage]"));
    expect(report).toHaveLength(5);
    expect(report[0]).toBe("[model-outage] 001-a: every model refused; stopping here. Nothing is blocked, and every waiting task can simply be run again.");
    expect(report[1]).toMatch(/^\[model-outage\]   q\/one  exit 1 in \d+ms, Error: 503 service unavailable$/);
    expect(report[2]).toMatch(/^\[model-outage\]   rounds 1 of 1, over \d+s, since 2026-/);
    expect(report[3]).toBe("[model-outage]   waiting, all still runnable: 001-a");
  });

  it("keeps exit code 0 when a task ends blocked", async () => {
    // The exit code for "tasks were blocked" is 0 today and must not move.
    await seedTaskFile(tasks, buildTaskFile({ id: "001-a", title: "a", acceptance: 'node -e "process.exit(1)"', criteria: ["C1 ok"], model: "q/one", verify: "mechanical" }));
    const configPath = await writeConfig({ modelChain: ["q/one"], retryLimit: 1 });
    const doneMarking: AgentAdapter = {
      prompt: async (args) => { await markDoneTask(args.text, tasks); return { sessionId: "s", exitCode: 0, text: "done" }; },
      contextUsage: async () => 0, contextLimit: async () => 100,
    };

    expect(await runCli(["run", "--config", configPath], {
      adapter: doneMarking, acceptance: async () => ({ passed: false, skipped: false as const, exitCode: 1, output: "no" }), log: () => {}, err: () => {},
    })).toBe(0);
    expect(await store.get("001-a")).toMatchObject({ status: "blocked" });
  });

  it("exits 3, not 1, when a task also hit a controller error", async () => {
    // The code names why the run stopped (design §7); the controller error is still said beside the report.
    await seedTaskFile(tasks, buildContinuousTask("001-b"), buildContinuousTask("002-a", { model: "q/one" }));
    const configPath = await writeConfig({ modelChain: ["q/one"], modelRounds: 1 });
    const flaky = Object.create(store) as TaskStore;
    let failNext = true;
    flaky.appendSession = async (...args: Parameters<TaskStore["appendSession"]>) => {
      if (failNext) { failNext = false; throw new Error("disk full"); }
      return store.appendSession(...args);
    };
    const mixed: AgentAdapter = {
      prompt: async (args) => {
        if (doneTaskId(args.text) === "001-b") { await markDoneTask(args.text, tasks); return { sessionId: "s-b", exitCode: 0, text: "done" }; }
        return { sessionId: "", exitCode: 1, text: "Error: 503", failure: "provider" as const, tokens: 0 };
      },
      contextUsage: async () => 0, contextLimit: async () => 100,
    };
    const lines: string[] = [];

    const code = await runCli(["run", "--config", configPath], { adapter: mixed, acceptance: passAcceptance, store: flaky, log: (line) => { lines.push(line); }, err: (line) => { lines.push(line); } });

    expect(code).toBe(EXIT_OUTAGE);
    expect(lines.some((line) => line.startsWith("[001-b] controller-error "))).toBe(true);
    expect(lines).toContain("[scheduler] 1 task(s) blocked by a controller error; see the controller-error line(s) above");
    expect(lines.some((line) => line.startsWith("[model-outage] 002-a:"))).toBe(true);
    expect(await store.get("001-b")).toMatchObject({ status: "blocked" });
    expect(await store.get("002-a")).toMatchObject({ status: "open" });
  });

  it("exits 3, not 1, when tasks were also refused by the budget guard", async () => {
    // 001-paid runs on a paid model the guard refuses; 002-a runs on a free one the provider refuses.
    // They share one workdir, so they are offered in board order: the refused one first, because a task
    // that has run out of rounds ends the offering and nothing after it would be offered, refused or not.
    await seedTaskFile(tasks, buildContinuousTask("001-paid", { model: "zen/p" }), buildContinuousTask("002-a", { model: "plan/m" }));
    const configPath = await writeConfig({ modelChain: ["plan/m"], modelRounds: 1 });
    const lines: string[] = [];

    const code = await runCli(["run", "--config", configPath], {
      adapter: { ...refusing(), ...adapterOf(CATALOGUE, "plan/m") }, acceptance: passAcceptance,
      log: (line) => { lines.push(line); }, err: (line) => { lines.push(line); },
    });

    expect(code).toBe(EXIT_OUTAGE);
    expect(lines.filter((line) => line.startsWith("[001-paid] refused "))).toHaveLength(1);
    expect(lines).toContain("[scheduler] 1 task(s) refused by the budget guard; no model session was started for them");
    expect(lines.filter((line) => line.startsWith("[model-outage]"))).toHaveLength(5);
    expect(await store.get("001-paid")).toMatchObject({ status: "open", retries: 0 });
  });
});

describe("taskctl run --batch", () => {
  it("reports an outage and exits 3", async () => {
    await seedTaskFile(tasks, buildContinuousTask("001-a", { model: "q/one" }), buildContinuousTask("002-b", { model: "q/one" }));
    const configPath = join(root, "taskctl.json");
    await writeFile(configPath, JSON.stringify({
      tasksDir: tasks, workdir: cwd, modelChain: ["q/one"], modelRounds: 1, lockTtlMs: 5_000, heartbeatMs: 20,
    }), "utf8");
    const lines: string[] = [];

    const code = await runCli(["run", "--batch", "001-a,002-b", "--config", configPath], {
      adapter: refusing(), acceptance: passAcceptance, log: (line) => { lines.push(line); }, err: (line) => { lines.push(line); },
    });

    expect(code).toBe(EXIT_OUTAGE);
    expect(lines).toContain("[batch] stopped at 001-a (outage); unclaimed: 002-b");
    expect(lines.filter((line) => line.startsWith("[model-outage]"))).toHaveLength(5);
    expect(await store.get("002-b")).toMatchObject({ status: "open" });
  });

  it("says when a deferred task may run again, and exits 0", async () => {
    await seedTaskFile(tasks, buildContinuousTask("001-a", { model: "q/one" }), buildContinuousTask("002-b", { model: "q/one" }));
    const configPath = join(root, "taskctl.json");
    await writeFile(configPath, JSON.stringify({
      tasksDir: tasks, workdir: cwd, modelChain: ["q/one"], modelRounds: 2, modelCooldownMs: 30_000, lockTtlMs: 5_000, heartbeatMs: 20,
    }), "utf8");
    const lines: string[] = [];

    const code = await runCli(["run", "--batch", "001-a,002-b", "--config", configPath], {
      adapter: refusing(), acceptance: passAcceptance, log: (line) => { lines.push(line); }, err: (line) => { lines.push(line); },
    });

    expect(code).toBe(0);
    expect(lines.some((line) => /^\[batch\] stopped at 001-a \(open\); deferred until \S+, run again then; unclaimed: 001-a, 002-b$/.test(line))).toBe(true);
  });
});

describe("watch", () => {
  it("a deferred task at the head of the queue does not hold the rest of the board", async () => {
    await seedTaskFile(tasks, buildContinuousTask("001-a"), buildContinuousTask("002-b"));
    await writeModelWait(tasks, "001-a", deferral(processRun(), { nextAt: new Date(Date.now() + 60_000).toISOString() }));
    const offered: string[] = [];

    expect(await watchQueue(cfg, deps, {
      watchFs, fallbackMs: 1_000, debounceMs: 5,
      runOne: async (_cfg, _deps, task) => {
        offered.push(task.id);
        if (task.id === "002-b") await stop.request();
        return "done";
      },
    })).toEqual({ reason: "stop" });

    expect(offered).toEqual(["002-b"]);
    expect(await store.get("001-a")).toMatchObject({ status: "open" });
  });

  it("keeps the guard's own handling of a refused task beside the deferral", async () => {
    // 001-a is refused by the guard, 002-b comes back deferred: neither is offered again at once,
    // and 003-c behind them runs. A guard refusal leaves no deferral behind.
    await seedTaskFile(tasks, buildTaskFile({ id: "001-a", title: "a" }), buildTaskFile({ id: "002-b", title: "b" }), buildTaskFile({ id: "003-c", title: "c" }));
    const offered: string[] = [];

    expect(await watchQueue(cfg, deps, {
      // Longer than the fallback scan: a shorter interval re-offers the refused task at every wake.
      watchFs, fallbackMs: 1_000, debounceMs: 5, refusedRetryMs: 10_000,
      runOne: async (_cfg, _deps, task) => {
        offered.push(task.id);
        if (task.id === "002-b") await writeModelWait(tasks, "002-b", deferral(processRun(), { nextAt: new Date(Date.now() + 60_000).toISOString() }));
        if (task.id === "003-c") await stop.request();
        return task.id === "001-a" ? "refused" : task.id === "002-b" ? "open" : "done";
      },
    })).toEqual({ reason: "stop" });

    expect(offered).toEqual(["001-a", "002-b", "003-c"]);
    expect(await readModelWait(tasks, "001-a")).toBeNull();
  });

  it("exits on an outage without offering another task, releases its lock, and writes no stop request", async () => {
    await seedTaskFile(tasks, buildTaskFile({ id: "001-a", title: "a" }), buildTaskFile({ id: "002-b", title: "b" }));
    const offered: string[] = [];

    expect(await watchQueue(cfg, deps, {
      watchFs, fallbackMs: 1_000, debounceMs: 5,
      runOne: async (_cfg, _deps, task) => {
        offered.push(task.id);
        await writeModelWait(tasks, task.id, spent(processRun()));
        return "open";
      },
    })).toEqual({ reason: "outage", taskId: "001-a" });

    expect(offered).toEqual(["001-a"]);
    await expect(readFile(watchLockPath(tasks), "utf8")).rejects.toThrow("ENOENT");
    await expect(readFile(stopRequestPath(tasks), "utf8")).rejects.toThrow("ENOENT");
  });

  it("a batch that met an outage ends the queue too", async () => {
    await seedTaskFile(tasks, buildContinuousTask("001-a"), buildContinuousTask("002-b"));

    expect(await watchQueue(cfg, deps, {
      watchFs, fallbackMs: 1_000, debounceMs: 5,
      runBatch: async () => ({ done: [], stoppedAt: "001-a", outcome: "outage", pending: ["002-b"] }),
    })).toEqual({ reason: "outage", taskId: "001-a" });
  });

  it("selectAutomaticBatch leaves a deferred head out and groups what follows", async () => {
    const board = [buildContinuousTask("001-a"), buildContinuousTask("002-b"), buildContinuousTask("003-c")];
    await writeModelWait(tasks, "001-a", deferral(processRun(), { nextAt: new Date(Date.now() + 60_000).toISOString() }));

    expect(await selectAutomaticBatch(cfg, board)).toEqual(["002-b", "003-c"]);
  });

  it("offers a task the owner retried by hand again after its recorded time, from round 0, and does not block it again at once", async () => {
    await seedTaskFile(tasks, buildTaskFile({ id: "001-a", title: "a" }));
    // As a run leaves a task it held as its own problem: blocked, its rounds spent, its next time still ahead.
    const nextAt = new Date(Date.now() + 400).toISOString();
    await writeModelWait(tasks, "001-a", deferral(processRun(), { rounds: MODEL_ROUNDS_DEFAULT, nextAt }));
    await store.setStatus("001-a", "blocked");
    const offered: Array<{ at: number; record: ModelWaitRecord | null }> = [];
    // A bound on a queue that never offers the task: the case then fails on `offered`, not on time.
    const safety = setTimeout(() => { void stop.request(); }, 5_000);

    const running = watchQueue(cfg, deps, {
      watchFs, fallbackMs: 50, debounceMs: 5,
      runOne: async (_cfg, _deps, task) => {
        offered.push({ at: Date.now(), record: await readModelWait(tasks, task.id) });
        // Refused again: a first round, not a fifth.
        await writeModelWait(tasks, task.id, deferral(processRun(), { rounds: 1, nextAt: new Date(Date.now() + 60_000).toISOString() }));
        await stop.request();
        return "open";
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 100)); // the queue is running, and leaves the blocked task alone
    expect(await retryTask(tasks, "001-a", { baseWorkdir: cwd, registryDir: join(root, "registry") })).toMatchObject({ ok: true });

    expect(await running).toEqual({ reason: "stop" });
    clearTimeout(safety);
    expect(offered).toHaveLength(1);
    expect(offered[0]!.at).toBeGreaterThanOrEqual(Date.parse(nextAt)); // not before the recorded time
    expect(offered[0]!.record).toMatchObject({ rounds: 0, firstRefusedAt: null, nextAt });
    expect(await store.get("001-a")).toMatchObject({ status: "open" }); // not held as its own problem on the first new round
  });
});

describe("taskctl watch", () => {
  it("prints the report and exits 3 on an outage", async () => {
    await seedTaskFile(tasks, buildContinuousTask("001-a", { model: "q/one" }));
    const configPath = join(root, "taskctl.json");
    await writeFile(configPath, JSON.stringify({
      tasksDir: tasks, workdir: cwd, modelChain: ["q/one"], modelRounds: 1, lockTtlMs: 5_000, heartbeatMs: 20,
    }), "utf8");
    const lines: string[] = [];

    const code = await runCli(["watch", "--config", configPath], {
      adapter: refusing(), acceptance: passAcceptance,
      watch: { watchFs, fallbackMs: 1_000, debounceMs: 5 },
      log: (line) => { lines.push(line); }, err: (line) => { lines.push(line); },
    });

    expect(code).toBe(EXIT_OUTAGE);
    expect(lines.filter((line) => line.startsWith("[model-outage]"))).toHaveLength(5);
    await expect(readFile(stopRequestPath(tasks), "utf8")).rejects.toThrow("ENOENT"); // the next watch needs no --resume
    expect(await store.get("001-a")).toMatchObject({ status: "open", retries: 0 });
  });
});
