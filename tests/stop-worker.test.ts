import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { OpenCodeAdapter } from "../src/adapters/opencode.js";
import type { AgentAdapter, PromptResult } from "../src/adapters/types.js";
import { readExecutionState } from "../src/execution-state.js";
import type { Execution } from "../src/execution.js";
import { latestNote } from "../src/handoff.js";
import { readJournal } from "../src/journal.js";
import type { MemoryBackend, MemorySettings } from "../src/memory.js";
import { readAttempt, readRuntime, writeRuntime } from "../src/runtime.js";
import type { StopNow } from "../src/stop.js";
import type { Task } from "../src/task-file.js";
import { TaskStore } from "../src/task-store.js";
import { runTask, type WorkerConfig, type WorkerDeps, type WorkerEvent } from "../src/worker.js";
import { reserveWorkspace } from "../src/workspace.js";
import { CATALOGUE } from "./helpers/catalogue-fixture.js";
import { buildTaskFile } from "./helpers/task-fixture.js";
import { manualStopNow } from "./helpers/stop-fixture.js";
import { doneAdapter, passAcceptance, seedTaskFile, waitForCondition, waitForConditionAsync, workerConfigFixture } from "./helpers/watch-fixture.js";

let root: string;
let tasks: string;
let work: string;
let store: TaskStore;
let cfg: WorkerConfig;
let events: WorkerEvent[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "taskctl-stop-worker-"));
  tasks = join(root, "tasks");
  work = join(root, "work");
  await mkdir(tasks);
  await mkdir(work);
  store = new TaskStore(tasks);
  cfg = workerConfigFixture({ tasksDir: tasks, workdir: work, lockTtlMs: 5_000, heartbeatMs: 60_000 });
  events = [];
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

type Turn = "work" | "done" | { hang: "confirm" | "unconfirmed" };
type Scripted = AgentAdapter & { sessionIds: Array<string | undefined>; hanging: Promise<void> };

/** Turns scripted one by one: "work" answers without a completion request, "done" writes it, a hanging turn never ends until the controller cancels it. */
function scriptedTurns(script: Turn[], hooks: { beforeHang?: () => Promise<void> } = {}): Scripted {
  const worker = doneAdapter({ tasksDir: tasks, sessionId: () => "ses-a", canResumeSession: async () => "reusable" });
  const sessionIds: Array<string | undefined> = [];
  let notify!: () => void;
  const hanging = new Promise<void>((resolve) => { notify = resolve; });
  return {
    ...worker,
    sessionIds,
    hanging,
    prompt: async () => { throw new Error("every turn goes through start"); },
    start: (args): Execution<PromptResult> => {
      sessionIds.push(args.sessionId);
      const turn = script.shift() ?? { hang: "confirm" as const };
      if (typeof turn === "string") {
        // A settled answer is an exited execution: without the flip `controlled`
        // reads the turn as an unconfirmed shutdown, exactly as it would for a
        // real client that finished (`legacyExecution`) — see the RED run note.
        let state: "running" | "exited" = "running";
        const result = (turn === "done" ? worker.prompt(args) : Promise.resolve({ sessionId: "ses-a", exitCode: 0, text: "working" }))
          .finally(() => { state = "exited"; });
        return { result, inspect: () => ({ state }), cancel: async () => false, interruptible: false };
      }
      let state: "running" | "exited" = "running";
      void Promise.resolve().then(() => hooks.beforeHang?.()).then(notify, notify);
      return {
        result: new Promise<PromptResult>(() => {}),
        inspect: () => ({ state, sessionId: args.sessionId ?? "ses-cut" }),
        cancel: async () => {
          // Only a confirmed cancellation ends the execution: an end that could
          // not be confirmed leaves it running — that is what "unconfirmed" means.
          const confirmed = turn.hang === "confirm";
          if (confirmed) state = "exited";
          return confirmed;
        },
      };
    },
  };
}

const mechanical = (id: string, overrides: Partial<Task> = {}): Task =>
  buildTaskFile({ id, complexity: "complex", verify: "mechanical", criteria: ["C1 ok"], acceptance: "check", ...overrides });
const deps = (agent: AgentAdapter, stop: StopNow, overrides: Partial<WorkerDeps> = {}): WorkerDeps =>
  ({ store, adapter: agent, acceptance: passAcceptance, stop, onEvent: (event) => { events.push(event); }, ...overrides });
/** The attempt must end on its own once the stop is observed; a hang is reported, not waited out. */
function settles<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the attempt did not settle after the stop")), 4_000))]);
}
const lockHeld = async (id: string): Promise<boolean> => { try { await readFile(join(tasks, id, "lock.json"), "utf8"); return true; } catch { return false; } };
/** The workspace is free again exactly when a fresh reservation succeeds. */
async function workspaceFree(): Promise<boolean> { const probe = await reserveWorkspace(work, "probe"); await probe?.release(); return probe !== null; }

it("a stop during a worker turn ends the attempt as stopped by the operator: open, no retry, settled", async () => {
  await seedTaskFile(tasks, mechanical("a"));
  const stop = manualStopNow();
  const agent = scriptedTurns([{ hang: "confirm" }]);
  const running = runTask(cfg, deps(agent, stop), await store.get("a"), "w1");
  await agent.hanging;
  stop.trigger("file");
  expect(await settles(running)).toBe("stopped");
  expect(await store.get("a")).toMatchObject({ status: "open", retries: 0, reviewRounds: 0, sessions: [] });
  expect(await readAttempt(tasks, "a")).toMatchObject({ phase: "settled", operation: "agent turn", reason: "stopped by operator" });
  expect(await readJournal(tasks, "a")).toEqual(expect.arrayContaining([
    expect.objectContaining({ stage: "worker", event: "stopped", detail: expect.stringContaining("operator stop during agent turn") }),
  ]));
  expect(events).toContainEqual({ type: "stopped", taskId: "a", detail: expect.stringContaining("agent turn") });
  expect(await lockHeld("a")).toBe(false);
  expect(await workspaceFree()).toBe(true);
  // The worker was given no stop input: nothing was dispatched after the cut turn.
  expect(agent.sessionIds).toHaveLength(1);
}, 8_000);

it("the session a cut turn ran on is marked dirty, so the rerun starts a fresh one", async () => {
  await seedTaskFile(tasks, mechanical("a"));
  const stop = manualStopNow();
  const first = scriptedTurns(["work", { hang: "confirm" }]);
  const running = runTask(cfg, deps(first, stop), await store.get("a"), "w1");
  await first.hanging;
  stop.trigger("file");
  expect(await settles(running)).toBe("stopped");
  // Turn one ran on ses-a; turn two, its continuation, was cut.
  expect(first.sessionIds).toEqual([undefined, "ses-a"]);
  expect(await readExecutionState(tasks, "a")).toMatchObject({ latestWorker: { sessionId: "ses-a", clean: false } });
  expect((await store.get("a")).sessions).toEqual(["ses-a"]);
  const second = scriptedTurns(["done"]);
  expect(await runTask(cfg, deps(second, manualStopNow()), await store.get("a"), "w2")).toBe("done");
  expect(second.sessionIds).toEqual([undefined]);
}, 8_000);

it("an unconfirmed cancellation is recorded uncertain and blocks, never as a clean stop", async () => {
  await seedTaskFile(tasks, mechanical("a"));
  const stop = manualStopNow();
  const agent = scriptedTurns([{ hang: "unconfirmed" }]);
  const running = runTask(cfg, deps(agent, stop), await store.get("a"), "w1");
  await agent.hanging;
  stop.trigger("file");
  expect(await settles(running)).toBe("blocked");
  expect((await store.get("a")).status).toBe("blocked");
  expect(await readAttempt(tasks, "a")).toMatchObject({ phase: "uncertain", operation: "agent turn" });
  expect(await readJournal(tasks, "a")).toEqual(expect.arrayContaining([expect.objectContaining({ event: "stop-unconfirmed" })]));
  expect(events.map((event) => event.type)).not.toContain("stopped");
  expect(events).toContainEqual(expect.objectContaining({ type: "stop-unconfirmed", taskId: "a" }));
  // As today, an uncertain attempt keeps its workspace reservation for the operator to reconcile.
  expect(await workspaceFree()).toBe(false);
}, 8_000);

it("nothing is claimed once a stop was already requested", async () => {
  await seedTaskFile(tasks, mechanical("a"));
  const stop = manualStopNow();
  stop.trigger("SIGINT");
  const agent = scriptedTurns(["done"]);
  expect(await runTask(cfg, deps(agent, stop), await store.get("a"), "w1")).toBe("skipped");
  expect(agent.sessionIds).toEqual([]);
  expect(await store.get("a")).toMatchObject({ status: "open" });
  expect(await readAttempt(tasks, "a")).toBeNull();
  expect(await lockHeld("a")).toBe(false);
});

it("a pending stop asks the guard nothing, and a refusal is not a stop", async () => {
  await seedTaskFile(tasks, mechanical("a", { model: "zen/p" }));
  // Nothing is started for a task once an interrupt is pending: not the guard's read of the catalogue.
  let asked = 0;
  const base = scriptedTurns(["done"]);
  const guarded: AgentAdapter = {
    ...base, modelCatalog: async () => { asked += 1; return CATALOGUE; }, defaultModelRef: async () => null,
  };
  const stop = manualStopNow();
  stop.trigger("SIGINT");
  const allowed = { ...cfg, reviewerModel: "zen/p" };
  expect(await runTask({ ...allowed, allowedModels: ["zen/p"] }, deps(guarded, stop), await store.get("a"), "w1")).toBe("skipped");
  expect(asked).toBe(0);

  // The stop lands while the guard judges, and the guard refuses: no session started, so nothing was interrupted.
  let finishJudging!: () => void;
  const judging = new Promise<void>((resolve) => { finishJudging = resolve; });
  const lateGuarded: AgentAdapter = {
    ...base, modelCatalog: async () => { await judging; return CATALOGUE; }, defaultModelRef: async () => null,
  };
  const lateStop = manualStopNow();
  const running = runTask(allowed, deps(lateGuarded, lateStop), await store.get("a"), "w2");
  await new Promise((resolve) => setImmediate(resolve));
  lateStop.trigger("file");
  finishJudging();
  expect(await running).toBe("refused");
  expect(await readAttempt(tasks, "a")).toBeNull();
  expect(base.sessionIds).toEqual([]);
  expect(events.filter((event) => event.type === "refused")).toHaveLength(1);
  expect(events.map((event) => event.type)).not.toContain("stopped");
});

it("a stop that lands while the guard judges is seen before the claim", async () => {
  await seedTaskFile(tasks, mechanical("a"));
  let finishJudging!: () => void;
  const judging = new Promise<void>((resolve) => { finishJudging = resolve; });
  const base = scriptedTurns(["done"]);
  const guarded: AgentAdapter = {
    ...base, modelCatalog: async () => { await judging; return CATALOGUE; }, defaultModelRef: async () => null,
  };
  const stop = manualStopNow();
  const running = runTask({ ...cfg, allowedModels: ["w/one"], reviewerModel: "w/one" }, deps(guarded, stop), await store.get("a"), "w1");
  await new Promise((resolve) => setImmediate(resolve));
  stop.trigger("file");
  finishJudging();
  expect(await running).toBe("skipped");
  expect(base.sessionIds).toEqual([]);
  expect(await readAttempt(tasks, "a")).toBeNull();
  expect(await lockHeld("a")).toBe(false);
  expect(events).toEqual([]);
});

it("an orphaned running task that is stopped returns to open", async () => {
  await seedTaskFile(tasks, mechanical("a", { status: "running" }));
  const now = new Date().toISOString();
  await mkdir(join(tasks, "a"), { recursive: true }); // writeRuntime does not create the directory (RED: ENOENT)
  await writeRuntime(tasks, "a", "attempt.json", { attemptId: "old", backend: "fixture", workspace: work, startedAt: now, updatedAt: now, phase: "settled", operation: "finished" });
  const stop = manualStopNow();
  const agent = scriptedTurns([{ hang: "confirm" }]);
  const running = runTask(cfg, deps(agent, stop), await store.get("a"), "w2");
  await agent.hanging;
  stop.trigger("file");
  expect(await settles(running)).toBe("stopped");
  expect((await store.get("a")).status).toBe("open");
}, 8_000);

it("what the cut turn wrote stays where it wrote it: no sweep, no rollback", async () => {
  execFileSync("git", ["init", "-q"], { cwd: work }); // only in a Git workdir would the sweep move anything
  await seedTaskFile(tasks, mechanical("a"));
  const stop = manualStopNow();
  const agent = scriptedTurns([{ hang: "confirm" }], { beforeHang: async () => {
    await writeFile(join(work, "partial.txt"), "half done");
    await writeFile(join(work, "debug.log"), "litter that the post-turn sweep would move");
  } });
  const running = runTask(cfg, deps(agent, stop), await store.get("a"), "w1");
  await agent.hanging;
  stop.trigger("file");
  expect(await settles(running)).toBe("stopped");
  expect(await readFile(join(work, "partial.txt"), "utf8")).toBe("half done");
  expect(await readFile(join(work, "debug.log"), "utf8")).toContain("litter");
  await expect(readdir(join(tasks, "a", "scratch"))).rejects.toMatchObject({ code: "ENOENT" });
}, 8_000);

it("a completion request written during the cut turn is not left behind", async () => {
  await seedTaskFile(tasks, mechanical("a"));
  const stop = manualStopNow();
  const agent = scriptedTurns([{ hang: "confirm" }], { beforeHang: async () => {
    await mkdir(join(tasks, "a"), { recursive: true });
    await writeFile(join(tasks, "a", "done.requested"), "done");
  } });
  const running = runTask(cfg, deps(agent, stop), await store.get("a"), "w1");
  await agent.hanging;
  stop.trigger("file");
  expect(await settles(running)).toBe("stopped");
  expect(await store.readDoneMarker("a")).toBe(false);
}, 8_000);

it("a stop during the acceptance command kills the gate and judges nothing", async () => {
  const gate = `"${process.execPath}" -e "require('fs').writeFileSync('gate.pid',String(process.pid));setInterval(()=>{},1000)"`;
  await seedTaskFile(tasks, mechanical("a", { acceptance: gate }));
  const stop = manualStopNow();
  const agent = scriptedTurns(["done"]);
  // No acceptance seam: the real gate runs, as it does in production.
  const running = runTask(cfg, deps(agent, stop, { acceptance: undefined }), await store.get("a"), "w1");
  let gatePid = 0;
  try {
    for (let i = 0; i < 300 && gatePid === 0; i++) {
      try { gatePid = Number(await readFile(join(work, "gate.pid"), "utf8")); } catch { await new Promise((resolve) => setTimeout(resolve, 30)); }
    }
    expect(gatePid).toBeGreaterThan(0);
  } finally {
    // Nothing is left behind, even when the assertion above failed midway or
    // the fixture never started: the attempt settles here, and the confirmed
    // cancel takes the gate's process tree with it.
    stop.trigger("file");
    expect(await settles(running)).toBe("stopped");
  }
  expect(() => process.kill(gatePid, 0)).toThrow();
  expect(await store.get("a")).toMatchObject({ status: "open", retries: 0 });
  expect(await readAttempt(tasks, "a")).toMatchObject({ phase: "settled", operation: "acceptance", reason: "stopped by operator" });
  await expect(readFile(join(tasks, "a", "acceptance.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(join(tasks, "a", "acceptance-failures.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  expect((await readJournal(tasks, "a")).map((line) => line.event)).not.toContain("rework");
}, 15_000);

it.each(["passed", "failed"] as const)("a gate that ended as the stop was observed is not judged (%s)", async (verdict) => {
  await seedTaskFile(tasks, mechanical("a"));
  const stop = manualStopNow();
  const result = verdict === "passed" ? await passAcceptance() : { passed: false, skipped: false as const, exitCode: 1, output: "boom" };
  const acceptance = vi.fn(async () => { stop.trigger("file"); return result; });
  expect(await runTask(cfg, deps(scriptedTurns(["done"]), stop, { acceptance }), await store.get("a"), "w1")).toBe("stopped");
  expect(await store.get("a")).toMatchObject({ status: "open", retries: 0, reviewRounds: 0 });
  await expect(readFile(join(tasks, "a", "acceptance.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(join(tasks, "a", "acceptance-failures.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  expect(await latestNote(tasks, "a")).toBeNull();
});

it("a stop during the review turn returns the task to open and writes no verdict", async () => {
  await seedTaskFile(tasks, mechanical("a", { verify: "human" }));
  const stop = manualStopNow();
  const agent = scriptedTurns(["done"]); // after the worker turn every start hangs: the reviewer's
  const running = runTask(cfg, deps(agent, stop), await store.get("a"), "w1");
  await agent.hanging;
  expect((await store.get("a")).status).toBe("review");
  stop.trigger("file");
  expect(await settles(running)).toBe("stopped");
  expect(await store.get("a")).toMatchObject({ status: "open", retries: 0, reviewRounds: 0 });
  expect(await readRuntime(tasks, "a", "review.json")).toBeNull();
  expect(await readRuntime(tasks, "a", "review-pending.json")).toBeNull();
  expect(await readAttempt(tasks, "a")).toMatchObject({ phase: "settled", operation: "review", reason: "stopped by operator" });
}, 8_000);

/** A reviewer that never ends on its own but stops when asked: the shape of one that hits the turn timeout with a confirmed shutdown. */
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

it("a stop during review-only recovery puts the parked task back with its evidence", async () => {
  await seedTaskFile(tasks, mechanical("a", { verify: "human" }));
  // Park it the way a reviewer that timed out does. That is the park which part 1 keeps:
  // a refused reviewer no longer parks, it defers the task and leaves it `open`.
  expect(await runTask({ ...cfg, turnTimeoutMs: 300 }, { store, adapter: slowReviewer(), acceptance: passAcceptance }, await store.get("a"), "w1")).toBe("blocked");
  const pending = await readFile(join(tasks, "a", "review-pending.json"), "utf8");
  const stop = manualStopNow();
  const agent = scriptedTurns([]);
  const running = runTask(cfg, deps(agent, stop), await store.get("a"), "w2", { reviewOnly: true });
  await agent.hanging;
  stop.trigger("file");
  expect(await settles(running)).toBe("stopped");
  expect((await store.get("a")).status).toBe("blocked");
  expect(await readFile(join(tasks, "a", "review-pending.json"), "utf8")).toBe(pending);
  expect(await readAttempt(tasks, "a")).toMatchObject({ phase: "settled", reason: "stopped by operator" });
}, 8_000);

it("a stop during an automatic review resumption returns the task to open, where it was claimed from", async () => {
  await seedTaskFile(tasks, mechanical("a", { verify: "human" }));
  // Part 1 resumes a deferred review from `open`, on its own: the task carries the preserved evidence and is not `blocked`.
  expect(await runTask({ ...cfg, turnTimeoutMs: 300 }, { store, adapter: slowReviewer(), acceptance: passAcceptance }, await store.get("a"), "w1")).toBe("blocked");
  const pending = await readFile(join(tasks, "a", "review-pending.json"), "utf8");
  await store.setStatus("a", "open");
  const stop = manualStopNow();
  const agent = scriptedTurns([]);
  const running = runTask(cfg, deps(agent, stop), await store.get("a"), "w2");
  await agent.hanging;
  stop.trigger("file");
  expect(await settles(running)).toBe("stopped");
  expect((await store.get("a")).status).toBe("open");
  expect(await readFile(join(tasks, "a", "review-pending.json"), "utf8")).toBe(pending);
  expect(await readRuntime(tasks, "a", "review.json")).toBeNull();
}, 8_000);

it("a stop observed during telemetry is not an uncertain stop and is not recorded as unavailable", async () => {
  await seedTaskFile(tasks, mechanical("a"));
  const stop = manualStopNow();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let told = false;
  const scripted = scriptedTurns(["done"]);
  const agent: AgentAdapter = {
    ...scripted,
    resolveModel: vi.fn(async (model) => model),
    sessionUsage: async () => {
      if (!told) { told = true; stop.trigger("file"); await held; }
      return { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
    },
  };
  const running = runTask({ ...cfg, effort: "high" }, deps(agent, stop), await store.get("a"), "w1");
  await waitForCondition(() => told);
  release();
  expect(await settles(running)).toBe("stopped");
  expect(await readAttempt(tasks, "a")).toMatchObject({ phase: "settled" });
  expect((await readJournal(tasks, "a")).map((line) => line.event)).not.toContain("usage-unavailable");
  // No new turn was prepared after the stop: the model was resolved for the one turn only.
  expect(vi.mocked(agent.resolveModel!)).toHaveBeenCalledTimes(1);
}, 8_000);

it("a stop observed during telemetry spends nothing: a failed turn is not accounted", async () => {
  await seedTaskFile(tasks, mechanical("a"));
  const stop = manualStopNow();
  let asked!: () => void;
  const asking = new Promise<void>((resolve) => { asked = resolve; });
  let answer!: () => void;
  const answered = new Promise<void>((resolve) => { answer = resolve; });
  let first = true;
  const base = scriptedTurns(["work"]);
  const agent: AgentAdapter = {
    ...base,
    start: (args) => {
      const execution = base.start!(args);
      return { ...execution, result: execution.result.then((result) => ({ ...result, exitCode: 1 })) }; // the turn fails
    },
    sessionUsage: async () => {
      if (!first) return { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
      first = false;
      asked();
      await answered;
      return { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
    },
  };
  const running = runTask(cfg, deps(agent, stop), await store.get("a"), "w1");
  await asking;
  stop.trigger("file");
  answer();
  expect(await settles(running)).toBe("stopped");
  expect(await store.get("a")).toMatchObject({ status: "open", retries: 0 });
  expect((await readJournal(tasks, "a")).map((line) => line.event)).not.toContain("turn-failed");
}, 8_000);

it("a stop observed during the reviewer's telemetry writes no verdict", async () => {
  await seedTaskFile(tasks, mechanical("a", { verify: "human" }));
  const stop = manualStopNow();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const scripted = scriptedTurns(["done", "work"]); // the worker's turn, then the reviewer's, which answers no verdict
  const agent: AgentAdapter = {
    ...scripted,
    sessionUsage: async () => {
      if (++calls === 2) { stop.trigger("file"); await held; }
      return { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
    },
  };
  const running = runTask(cfg, deps(agent, stop), await store.get("a"), "w1");
  await waitForCondition(() => calls === 2);
  release();
  expect(await settles(running)).toBe("stopped");
  expect(await readRuntime(tasks, "a", "review.json")).toBeNull();
  expect(await store.get("a")).toMatchObject({ status: "open", retries: 0 });
}, 8_000);

const fake = fileURLToPath(new URL("./adapters/fake-opencode.mjs", import.meta.url));

it("a stop during a real adapter turn asks the service to stop the observed session and confirms", async () => {
  await seedTaskFile(tasks, mechanical("a"));
  const interrupted = join(root, "interrupted.txt");
  process.env.FAKE_RUN_HANG = "1";
  process.env.FAKE_INTERRUPT_FILE = interrupted;
  const stop = manualStopNow();
  const running = runTask({ ...cfg, heartbeatMs: 50, allowedModels: ["w/one"] }, deps(new OpenCodeAdapter({ bin: process.execPath, binArgsPrefix: [fake], insulated: true }), stop), await store.get("a"), "w1");
  try {
    await waitForConditionAsync(async () => (await readAttempt(tasks, "a"))?.sessionId === "ses_fake123");
    stop.trigger("file");
    expect(await settles(running)).toBe("stopped");
    expect(await readFile(interrupted, "utf8")).toBe("ses_fake123\n");
    expect(await readAttempt(tasks, "a")).toMatchObject({ phase: "settled", sessionId: "ses_fake123", reason: "stopped by operator" });
    expect(await readExecutionState(tasks, "a")).toMatchObject({ latestWorker: { sessionId: "ses_fake123", clean: false } });
    expect((await store.get("a")).sessions).toEqual([]);
    expect(await workspaceFree()).toBe(true);
  } finally {
    // No client process is left behind, even when an assertion above failed
    // midway or the session never appeared: the attempt settles here, and the
    // cancel takes the turn's process tree with it.
    stop.trigger("file");
    await Promise.race([running.catch(() => {}), new Promise((resolve) => setTimeout(resolve, 8_500))]);
    delete process.env.FAKE_RUN_HANG;
    delete process.env.FAKE_INTERRUPT_FILE;
  }
}, 15_000);

it("a stop the real service does not acknowledge is recorded uncertain", async () => {
  await seedTaskFile(tasks, mechanical("a"));
  process.env.FAKE_RUN_HANG = "1";
  process.env.FAKE_INTERRUPT_UNAVAILABLE = "1";
  const stop = manualStopNow();
  const running = runTask({ ...cfg, heartbeatMs: 50, allowedModels: ["w/one"] }, deps(new OpenCodeAdapter({ bin: process.execPath, binArgsPrefix: [fake], insulated: true }), stop), await store.get("a"), "w1");
  try {
    await waitForConditionAsync(async () => (await readAttempt(tasks, "a"))?.sessionId === "ses_fake123");
    stop.trigger("file");
    expect(await settles(running)).toBe("blocked");
    expect(await readAttempt(tasks, "a")).toMatchObject({ phase: "uncertain" });
    expect((await readJournal(tasks, "a")).map((line) => line.event)).toContain("stop-unconfirmed");
  } finally {
    // Same as above: settle the attempt so nothing is left behind on a failure.
    stop.trigger("file");
    await Promise.race([running.catch(() => {}), new Promise((resolve) => setTimeout(resolve, 8_500))]);
    delete process.env.FAKE_RUN_HANG;
    delete process.env.FAKE_INTERRUPT_UNAVAILABLE;
  }
}, 15_000);

/** The `memory` block as `resolveConfig` fills it in once a backend is named; the command names a file that exists nowhere, so an attempt that built its own backend could never reach a real server. */
const memoryOn = (): MemorySettings => ({
  backend: "mempalace", command: [join(root, "no-such-memory-server", "mempalace-mcp.exe")], excludeWings: [],
  rooms: ["pitfall", "pattern", "decision"], minSimilarity: 0.55, maxItems: 5, maxChars: 2_000, itemChars: 400, timeoutMs: 20_000,
});

it("a stop during the memory recall waits for the recall, dispatches no turn and judges nothing", async () => {
  await seedTaskFile(tasks, mechanical("a"));
  const stop = manualStopNow();
  let asked!: () => void;
  const asking = new Promise<void>((resolve) => { asked = resolve; });
  let answer!: () => void;
  const answered = new Promise<void>((resolve) => { answer = resolve; });
  const memory: MemoryBackend = { name: "fake", searchAll: async () => { asked(); await answered; return []; } };
  const agent = scriptedTurns(["done"]);
  const running = runTask({ ...cfg, memory: memoryOn() }, deps(agent, stop, { memory }), await store.get("a"), "w1");
  try {
    await asking;
    stop.trigger("file");
    // The wait is visible at once …
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: "stop-requested", taskId: "a" })));
  } finally {
    // … and the recall is not abandoned: it ends, and its record is its own.
    // The attempt settles either way, so a failure above leaves nothing running.
    answer();
    expect(await settles(running)).toBe("stopped");
  }
  expect(await readRuntime(tasks, "a", "recall.json")).toMatchObject({ outcome: "no-hits" });
  expect(agent.sessionIds).toEqual([]);
  expect(await store.get("a")).toMatchObject({ status: "open", retries: 0 });
  await expect(readFile(join(tasks, "a", "acceptance.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
}, 8_000);
