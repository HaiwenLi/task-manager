import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter, PromptResult } from "../src/adapters/types.js";
import { runCli, type CliDeps } from "../src/cli.js";
import type { Execution } from "../src/execution.js";
import { controlDir } from "../src/watch-lock.js";
import { readAttempt } from "../src/runtime.js";
import { stopNowRequestPath, stopRequestPath } from "../src/stop.js";
import { TaskStore } from "../src/task-store.js";
import { runTask, type WorkerConfig } from "../src/worker.js";
import { buildContinuousTask as task } from "./helpers/task-fixture.js";
import { adapterOf, CATALOGUE } from "./helpers/catalogue-fixture.js";
import { manualSignals } from "./helpers/stop-fixture.js";
import {
  createWatchEventSeam, doneAdapter, passAcceptance, runWatchCli, seedTaskFile,
  waitForCondition, waitForConditionAsync, workerConfigFixture,
} from "./helpers/watch-fixture.js";

let root: string;
let tasks: string;
let work: string;
let configPath: string;
let cliLines: string[];
let store: TaskStore;
let cfg: WorkerConfig;
let adapterCalls: string[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "taskctl-stop-cli-"));
  tasks = join(root, "tasks");
  work = join(root, "work");
  await mkdir(tasks);
  await mkdir(work);
  store = new TaskStore(tasks);
  configPath = join(root, "taskctl.json");
  await writeFile(configPath, JSON.stringify({
    tasksDir: tasks, workdir: work, lockTtlMs: 5_000, heartbeatMs: 1_000, retryLimit: 1,
  }), "utf8");
  cliLines = [];
  adapterCalls = [];
  cfg = workerConfigFixture({ tasksDir: tasks, workdir: work, lockTtlMs: 5_000, heartbeatMs: 1_000 });
});

afterEach(async () => { await rm(root, { recursive: true, force: true }); });

/** The loud idle adapter of tests/watch.test.ts: every surface records and throws, so idle proof is real. */
function idleAdapter(): AgentAdapter {
  return {
    prompt: async () => { adapterCalls.push("prompt"); throw new Error("prompt during idle"); },
    start: () => { adapterCalls.push("start"); throw new Error("start during idle"); },
    resolveModel: async (model) => { adapterCalls.push("resolveModel"); return model; },
    contextUsage: async () => { adapterCalls.push("contextUsage"); return 0; },
    contextLimit: async () => { adapterCalls.push("contextLimit"); return 100; },
    sessionUsage: async () => {
      adapterCalls.push("sessionUsage");
      return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
    },
    canResumeSession: async () => { adapterCalls.push("canResumeSession"); return "unavailable"; },
  };
}

/**
 * A backend whose next `hangTurns` worker turns hang until the controller stops them; later turns answer at once.
 * (The slowReviewer shape of tests/fault-isolation.test.ts, one turn at a time.)
 */
function hangingWorker(hangTurns: number, options: { confirm?: boolean; text?: string } = {}): AgentAdapter & { started: Promise<void> } {
  const worker = doneAdapter({ tasksDir: tasks, sessionId: (id) => `s-${id}` });
  let hanging = hangTurns;
  let notify!: () => void;
  const started = new Promise<void>((resolve) => { notify = resolve; });
  return {
    ...worker,
    started,
    start: (args): Execution<PromptResult> => {
      if (hanging <= 0 || (options.text !== undefined && !args.text.includes(options.text))) {
        // A turn that answers must also report its exit, or the worker reads
        // every completed turn as a shutdown it cannot confirm (the brief's
        // literal `state: "running"` blocked `done` turns; the worker's own
        // `legacyExecution` is the shape followed here).
        let state: "running" | "exited" = "running";
        const result = worker.prompt(args).finally(() => { state = "exited"; });
        return { result, inspect: () => ({ state }), cancel: async () => false, interruptible: false };
      }
      hanging -= 1;
      notify();
      let state: "running" | "exited" = "running";
      return {
        result: new Promise<PromptResult>(() => {}),
        inspect: () => ({ state }),
        cancel: async () => { if (options.confirm !== false) state = "exited"; return options.confirm !== false; },
      };
    },
  };
}

/** A reviewer turn that never ends on its own but stops when asked, worker turns quick: parks the review. */
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

const runCliQuiet = (argv: string[], deps: CliDeps = {}) => runCli(argv, { log: () => {}, err: () => {}, ...deps });
const settledAttempt = async (id: string) => readAttempt(tasks, id);

it("taskctl run observes stop --now from another process, returns the task to open and exits without re-claiming", async () => {
  await seedTaskFile(tasks, task("a"));
  const agent = hangingWorker(1);
  const lines: string[] = [];
  const running = runCli(["run", "--config", configPath], { adapter: agent, acceptance: passAcceptance, log: (line) => lines.push(line), err: (line) => lines.push(line) });
  await agent.started;
  expect(await runCliQuiet(["stop", "--tasks-dir", tasks, "--now"])).toBe(0);
  expect(await running).toBe(0);
  expect(await store.get("a")).toMatchObject({ status: "open", retries: 0 });
  expect(await settledAttempt("a")).toMatchObject({ phase: "settled", reason: "stopped by operator" });
  expect(lines.join("\n")).toContain("[a] stopped agent turn; cancellation confirmed");
  expect(lines.join("\n")).toContain("stopped by the operator: a; run again to continue");
}, 10_000);

it("watch exits on stop --now mid-attempt, and the next watch needs --resume", async () => {
  await seedTaskFile(tasks, task("a"));
  const agent = hangingWorker(1);
  const { listeners, watchFs } = createWatchEventSeam();
  const running = runWatchCli({ root, tasksDir: tasks, workdir: work, agent, acceptance: passAcceptance, watch: { watchFs, fallbackMs: 1_000, debounceMs: 5 } });
  await agent.started;
  expect(await runCliQuiet(["stop", "--tasks-dir", tasks, "--now"])).toBe(0);
  await expect(running).resolves.toBe(0);
  expect((await store.get("a")).status).toBe("open");

  const errors: string[] = [];
  await expect(runWatchCli({ root, tasksDir: tasks, workdir: work, agent, acceptance: passAcceptance, err: (line) => errors.push(line), watch: { watchFs, fallbackMs: 1_000, debounceMs: 5 } }))
    .resolves.toBe(1);
  expect(errors.join("\n")).toContain("watch --resume");

  const resumed = runWatchCli({ root, tasksDir: tasks, workdir: work, agent, acceptance: passAcceptance, resume: true, watch: { watchFs, fallbackMs: 1_000, debounceMs: 5 } });
  await waitForConditionAsync(async () => (await store.get("a")).status === "done");
  await writeFile(stopRequestPath(tasks), "again", "utf8");
  listeners.get(controlDir(tasks))?.();
  await expect(resumed).resolves.toBe(0);
  expect((await store.get("a")).status).toBe("done");
}, 15_000);

it("SIGINT on run does what stop --now does and exits 130", async () => {
  await seedTaskFile(tasks, task("a"));
  const agent = hangingWorker(1);
  const signals = manualSignals();
  const lines: string[] = [];
  const running = runCli(["run", "--config", configPath], { adapter: agent, acceptance: passAcceptance, signals, log: (line) => lines.push(line), err: (line) => lines.push(line) });
  await agent.started;
  signals.fire("SIGINT");
  expect(await running).toBe(130);
  expect(await store.get("a")).toMatchObject({ status: "open", retries: 0 });
  // The request outlives the process, exactly as `stop --now` writes it.
  expect(await readFile(stopRequestPath(tasks), "utf8")).toBeDefined();
  expect(await readFile(stopNowRequestPath(tasks), "utf8")).toBeDefined();
  expect(lines.join("\n")).toContain("SIGINT received: running work is interrupted; nothing new is claimed");
}, 10_000);

it("SIGTERM on watch exits 143", async () => {
  await seedTaskFile(tasks, task("a"));
  const agent = hangingWorker(1);
  const signals = manualSignals();
  const { watchFs } = createWatchEventSeam();
  const running = runCli(["watch", "--config", configPath], { adapter: agent, acceptance: passAcceptance, signals, log: () => {}, err: () => {}, watch: { watchFs, fallbackMs: 1_000, debounceMs: 5 } });
  await agent.started;
  signals.fire("SIGTERM");
  expect(await running).toBe(143);
  expect((await store.get("a")).status).toBe("open");
}, 10_000);

it("SIGINT on an idle watch exits 130 at once and leaves the stop request", async () => {
  const signals = manualSignals();
  const { listeners, watchFs } = createWatchEventSeam();
  // A fallback of a minute: without a wake on the signal this test would time out, not pass.
  const running = runCli(["watch", "--config", configPath], { adapter: idleAdapter(), acceptance: passAcceptance, signals, log: () => {}, err: () => {}, watch: { watchFs, fallbackMs: 60_000, debounceMs: 5 } });
  await waitForCondition(() => listeners.has(tasks));
  const started = Date.now();
  signals.fire("SIGINT");
  expect(await running).toBe(130);
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(await readFile(stopRequestPath(tasks), "utf8")).toBeDefined();
  // The loud adapter proved the watch idle: nothing asked it for anything.
  expect(adapterCalls).toEqual([]);
}, 10_000);

it.each(["a request from the board", "a signal"] as const)("an unconfirmed stop exits 1, for %s", async (asked) => {
  // One case per test on purpose: the first would leave an `uncertain` attempt and its reservation behind,
  // and a task with an unsettled attempt is not run again.
  await seedTaskFile(tasks, task("a"));
  const agent = hangingWorker(1, { confirm: false });
  const signals = manualSignals();
  const lines: string[] = [];
  const running = runCli(["run", "--config", configPath], { adapter: agent, acceptance: passAcceptance, signals, log: (line) => lines.push(line), err: (line) => lines.push(line) });
  await agent.started;
  if (asked === "a signal") signals.fire("SIGINT"); else expect(await runCliQuiet(["stop", "--tasks-dir", tasks, "--now"])).toBe(0);
  expect(await running).toBe(1);
  expect((await store.get("a")).status).toBe("blocked");
  expect(await settledAttempt("a")).toMatchObject({ phase: "uncertain" });
  expect(lines.join("\n")).toContain("could not be confirmed and need reconciliation: a");
}, 15_000);

it.each(["a request from the board", "a signal"] as const)("an unconfirmed stop of a watch exits 1, for %s", async (asked) => {
  // One case per test: an `uncertain` attempt is left behind, and a task with
  // an unsettled attempt is not run again.
  await seedTaskFile(tasks, task("a"));
  const agent = hangingWorker(1, { confirm: false });
  const signals = manualSignals();
  const lines: string[] = [];
  const { watchFs } = createWatchEventSeam();
  const running = runCli(["watch", "--config", configPath], { adapter: agent, acceptance: passAcceptance, signals, log: (line) => lines.push(line), err: (line) => lines.push(line), watch: { watchFs, fallbackMs: 1_000, debounceMs: 5 } });
  await agent.started;
  if (asked === "a signal") signals.fire("SIGINT"); else expect(await runCliQuiet(["stop", "--tasks-dir", tasks, "--now"])).toBe(0);
  // The unconfirmed attempt is the watch's report to give: the signal's 130 (or
  // the board request's 0) would present it as clean.
  expect(await running).toBe(1);
  expect((await store.get("a")).status).toBe("blocked");
  expect(await settledAttempt("a")).toMatchObject({ phase: "uncertain" });
  expect(lines.join("\n")).toContain("could not be confirmed and need reconciliation: a");
}, 15_000);

it("a run that refused a task and was then stopped exits 1 and says both", async () => {
  // `model: undefined` is the smallest deviation from the brief's `task("b")`:
  // buildContinuousTask's default `w/one` is not in CATALOGUE, and the guard
  // refused it as cost-unknown (reproduced: "[b] refused - w/one"), so the
  // brief's own comment — "b runs on the backend's default, which is free" —
  // needs a task without a model of its own.
  await seedTaskFile(tasks, task("a", { model: "zen/p" }), task("b", { model: undefined }));
  // A real guard on a scripted turn: `zen/p` is paid and not allowed; `b` runs on the backend's default, which is free.
  const agent = { ...hangingWorker(1), ...adapterOf(CATALOGUE, "plan/m") };
  const signals = manualSignals();
  const lines: string[] = [];
  const running = runCli(["run", "--config", configPath], { adapter: agent, acceptance: passAcceptance, signals, log: (line) => lines.push(line), err: (line) => lines.push(line) });
  await agent.started;
  signals.fire("SIGINT");
  expect(await running).toBe(1);
  expect(lines.join("\n")).toContain("refused by the budget guard");
  expect(lines.join("\n")).toContain("[b] stopped agent turn; cancellation confirmed");
  expect(lines.join("\n")).toContain("[scheduler] stopped by the operator: b; run again to continue");
  expect(await store.get("a")).toMatchObject({ status: "open" });
  expect(await store.get("b")).toMatchObject({ status: "open", retries: 0 });
}, 10_000);

it("a stop --now left by an earlier controller does not stop the next run", async () => {
  expect(await runCliQuiet(["stop", "--tasks-dir", tasks, "--now"])).toBe(0);
  await seedTaskFile(tasks, task("a"));
  expect(await runCliQuiet(["run", "--config", configPath], { adapter: doneAdapter({ tasksDir: tasks, sessionId: (id) => `s-${id}` }), acceptance: passAcceptance })).toBe(0);
  expect((await store.get("a")).status).toBe("done");
});

it("a second SIGINT while stopping changes nothing", async () => {
  await seedTaskFile(tasks, task("a"));
  const agent = hangingWorker(1);
  const signals = manualSignals();
  const lines: string[] = [];
  const running = runCli(["run", "--config", configPath], { adapter: agent, acceptance: passAcceptance, signals, log: (line) => lines.push(line), err: (line) => lines.push(line) });
  await agent.started;
  signals.fire("SIGINT");
  signals.fire("SIGINT");
  expect(await running).toBe(130);
  expect(lines.filter((line) => line.includes("SIGINT received:"))).toHaveLength(1);
  expect(lines.filter((line) => line.includes("SIGINT received again: still stopping"))).toHaveLength(1);
  // The repeated write queues behind the first instead of racing it on the
  // request's temporary file.
  expect(lines.join("\n")).not.toContain("stop request could not be written");
  expect((await store.get("a")).status).toBe("open");
}, 10_000);

it("SIGINT during run --batch stops the batch and leaves the rest unclaimed", async () => {
  await seedTaskFile(tasks, task("a"), task("b"), task("c"));
  const agent = hangingWorker(1, { text: "当前任务：b" });
  const signals = manualSignals();
  const lines: string[] = [];
  const running = runCli(["run", "--batch", "a,b,c", "--config", configPath], { adapter: agent, acceptance: passAcceptance, signals, log: (line) => lines.push(line), err: (line) => lines.push(line) });
  await agent.started;
  signals.fire("SIGINT");
  expect(await running).toBe(130);
  expect(lines.join("\n")).toContain("[batch] stopped at b (stopped); unclaimed: c");
  expect(await store.get("b")).toMatchObject({ status: "open", retries: 0 });
  expect(await readAttempt(tasks, "c")).toBeNull();
}, 10_000);

it("retry --review-only stopped by the operator leaves the task blocked with its parked review", async () => {
  await seedTaskFile(tasks, task("a", { verify: "human", criteria: ["C1 ok"] }));
  // Park it with a reviewer that timed out, the park part 1 keeps; a refused reviewer defers instead.
  expect(await runTask({ ...cfg, turnTimeoutMs: 300 }, { store, adapter: slowReviewer(), acceptance: passAcceptance }, await store.get("a"), "w1")).toBe("blocked");
  const pending = await readFile(join(tasks, "a", "review-pending.json"), "utf8");
  const agent = hangingWorker(1, { text: "独立复核者" });
  const signals = manualSignals();
  const running = runCli(["retry", "--task", "a", "--review-only", "--config", configPath], { adapter: agent, acceptance: passAcceptance, signals, log: () => {}, err: () => {} });
  await agent.started;
  signals.fire("SIGINT");
  expect(await running).toBe(130);
  expect((await store.get("a")).status).toBe("blocked");
  expect(await readFile(join(tasks, "a", "review-pending.json"), "utf8")).toBe(pending);
}, 10_000);

it("retry --review-only: a stop that lands while the guard reads the catalogue answers the signal's code", async () => {
  // The task's own model is free in the catalogue, so the guard judges the
  // recovery allowed and reaches its second stop check, which is where the
  // signal lands: nothing is claimed and no turn starts (D11).
  await seedTaskFile(tasks, task("a", { verify: "human", criteria: ["C1 ok"], model: "plan/m" }));
  expect(await runTask({ ...cfg, turnTimeoutMs: 300 }, { store, adapter: slowReviewer(), acceptance: passAcceptance }, await store.get("a"), "w1")).toBe("blocked");
  const pending = await readFile(join(tasks, "a", "review-pending.json"), "utf8");
  const signals = manualSignals();
  const lines: string[] = [];
  const agent: AgentAdapter = {
    ...adapterOf(CATALOGUE, "plan/m"),
    modelCatalog: async () => { signals.fire("SIGINT"); return CATALOGUE; },
  };
  const running = runCli(["retry", "--task", "a", "--review-only", "--config", configPath], { adapter: agent, acceptance: passAcceptance, signals, log: (line) => lines.push(line), err: (line) => lines.push(line) });
  // `runTask` answered `skipped`; the signal's own code is the recovery's.
  expect(await running).toBe(130);
  expect((await store.get("a")).status).toBe("blocked");
  expect(await readFile(join(tasks, "a", "review-pending.json"), "utf8")).toBe(pending);
  expect(lines.join("\n")).toContain("stopped by the operator");
  expect(lines.join("\n")).not.toContain("review-only recovery refused or still unavailable");
}, 10_000);

it("retry --review-only: an unconfirmed stop during the recovery exits 1 and says what needs reconciliation", async () => {
  await seedTaskFile(tasks, task("a", { verify: "human", criteria: ["C1 ok"] }));
  expect(await runTask({ ...cfg, turnTimeoutMs: 300 }, { store, adapter: slowReviewer(), acceptance: passAcceptance }, await store.get("a"), "w1")).toBe("blocked");
  const pending = await readFile(join(tasks, "a", "review-pending.json"), "utf8");
  const agent = hangingWorker(1, { confirm: false, text: "独立复核者" });
  const signals = manualSignals();
  const lines: string[] = [];
  const running = runCli(["retry", "--task", "a", "--review-only", "--config", configPath], { adapter: agent, acceptance: passAcceptance, signals, log: (line) => lines.push(line), err: (line) => lines.push(line) });
  await agent.started;
  signals.fire("SIGINT");
  // `runTask` answered `blocked` for an uncertain attempt: 1, and the line
  // that says it needs reconciliation, not the ordinary refusal line.
  expect(await running).toBe(1);
  expect((await store.get("a")).status).toBe("blocked");
  expect(await settledAttempt("a")).toMatchObject({ phase: "uncertain" });
  expect(lines.join("\n")).toContain("could not be confirmed and need reconciliation: a");
  expect(lines.join("\n")).not.toContain("review-only recovery refused or still unavailable");
  expect(await readFile(join(tasks, "a", "review-pending.json"), "utf8")).toBe(pending);
}, 10_000);

it("stop --now requires --tasks-dir, like stop", async () => {
  expect(await runCliQuiet(["stop", "--now"])).toBe(2);
});

it("the signal relay is installed for run and watch only, and removed when the command ends", async () => {
  const count = () => process.listenerCount("SIGINT") + process.listenerCount("SIGTERM");
  const before = count();
  await runCliQuiet(["status", "--tasks-dir", tasks]);
  expect(count()).toBe(before);
  await seedTaskFile(tasks, task("a"));
  await runCliQuiet(["run", "--config", configPath], { adapter: doneAdapter({ tasksDir: tasks, sessionId: (id) => `s-${id}` }), acceptance: passAcceptance });
  expect(count()).toBe(before);
});

it("a run that fails before it starts leaves no signal relay behind", async () => {
  // `--log` under a regular file cannot be created, so the controller's
  // telemetry throws before anything is claimed: the relay must not already
  // be on the process when it does.
  const blocking = join(root, "not-a-dir");
  await writeFile(blocking, "x", "utf8");
  const count = () => process.listenerCount("SIGINT") + process.listenerCount("SIGTERM");
  const before = count();
  expect(await runCliQuiet(["run", "--config", configPath, "--log", join(blocking, "run.log")])).toBe(1);
  expect(count()).toBe(before);
});
