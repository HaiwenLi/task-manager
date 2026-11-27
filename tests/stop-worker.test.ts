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
import { runTask, type WorkerConfig, type WorkerDeps, type WorkerEvent, type WorkerStore } from "../src/worker.js";
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

type Turn = "work" | "done" | { hang: "confirm" | "unconfirmed" } | { stopWhenSettled: true };
type Scripted = AgentAdapter & { sessionIds: Array<string | undefined>; hanging: Promise<void>; announced: Promise<void> };

/** Turns scripted one by one: "work" answers without a completion request, "done" writes it, a hanging turn never ends until the controller cancels it, and a `stopWhenSettled` turn asks for the operator's stop the first time `controlled` looks at it after it settled. */
function scriptedTurns(script: Turn[], hooks: { beforeHang?: () => Promise<void>; hangAnnouncesSession?: boolean; stopWhenSettled?: () => void } = {}): Scripted {
  const worker = doneAdapter({ tasksDir: tasks, sessionId: () => "ses-a", canResumeSession: async () => "reusable" });
  const sessionIds: Array<string | undefined> = [];
  let notify!: () => void;
  const hanging = new Promise<void>((resolve) => { notify = resolve; });
  let announce!: () => void;
  const announced = new Promise<void>((resolve) => { announce = resolve; });
  return {
    ...worker,
    sessionIds,
    hanging,
    announced: hooks.hangAnnouncesSession === true ? announced : Promise.resolve(),
    prompt: async () => { throw new Error("every turn goes through start"); },
    start: (args): Execution<PromptResult> => {
      sessionIds.push(args.sessionId);
      const turn = script.shift() ?? { hang: "confirm" as const };
      if (typeof turn === "string" || (typeof turn === "object" && "stopWhenSettled" in turn)) {
        // A settled answer is an exited execution: without the flip `controlled`
        // reads the turn as an unconfirmed shutdown, exactly as it would for a
        // real client that finished (`legacyExecution`) — see the RED run note.
        let state: "running" | "exited" = "running";
        const result = (typeof turn === "string" && turn === "done" ? worker.prompt(args) : Promise.resolve({ sessionId: "ses-a", exitCode: 0, text: "working" }))
          .finally(() => { state = "exited"; });
        const asksStopWhenSettled = typeof turn === "object" && "stopWhenSettled" in turn;
        let asked = false;
        return {
          result,
          inspect: () => {
            // The first look after the turn settled is `controlled`'s own check
            // before it returns the value: a stop asked there is pending before
            // the caller goes on — the window the telemetry catches guard.
            if (asksStopWhenSettled && state === "exited" && !asked) { asked = true; hooks.stopWhenSettled?.(); }
            return { state };
          },
          cancel: async () => false, interruptible: false,
        };
      }
      let state: "running" | "exited" = "running";
      let announcedSession = false;
      void Promise.resolve().then(() => hooks.beforeHang?.()).then(notify, notify);
      // With `hangAnnouncesSession` the hang models a backend whose session id
      // only becomes known mid-flight: the fake announces it once the turn is
      // running, and the announced id is a live client's knowledge — `inspect`
      // reports it while the turn runs, and a cancelled client reports nothing
      // about its session any more.
      const announcesSession = hooks.hangAnnouncesSession === true;
      if (announcesSession) void Promise.resolve().then(() => { announcedSession = true; announce(); });
      return {
        result: new Promise<PromptResult>(() => {}),
        inspect: () => ({
          state,
          ...(announcesSession
            ? (state === "running" && announcedSession ? { sessionId: args.sessionId ?? "ses-cut" } : {})
            : { sessionId: args.sessionId ?? "ses-cut" }),
        }),
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
  expect(await readJournal(tasks, "a")).toContainEqual(
    expect.objectContaining({
      stage: "worker", event: "stopped",
      detail: "operator stop during agent turn; cancellation confirmed; task returned to open; no interrupted step was judged",
    }),
  );
  expect(events).toContainEqual({
    type: "stopped", taskId: "a",
    detail: "agent turn; cancellation confirmed; task returned to open; no interrupted step was judged",
  });
  expect(await lockHeld("a")).toBe(false);
  expect(await workspaceFree()).toBe(true);
  // The worker was given no stop input: nothing was dispatched after the cut turn.
  expect(agent.sessionIds).toHaveLength(1);
}, 8_000);

it("a stop's journal line that cannot be written still settles the attempt as stopped", async () => {
  await seedTaskFile(tasks, mechanical("a"));
  const stop = manualStopNow();
  const agent = scriptedTurns([{ hang: "confirm" }], { beforeHang: async () => {
    // The journal is a record, not state: a directory named `journal.md`
    // makes the stop's own line unwritable after the claim that wrote it.
    await rm(join(tasks, "a", "journal.md"));
    await mkdir(join(tasks, "a", "journal.md"));
  } });
  const running = runTask(cfg, deps(agent, stop), await store.get("a"), "w1");
  await agent.hanging;
  stop.trigger("file");
  expect(await settles(running)).toBe("stopped");
  expect(await store.get("a")).toMatchObject({ status: "open", retries: 0 });
  expect(await readAttempt(tasks, "a")).toMatchObject({ phase: "settled", operation: "agent turn", reason: "stopped by operator" });
  expect(events).toContainEqual(expect.objectContaining({ type: "stopped", taskId: "a" }));
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

it("a stop records the session id the cut turn announced, before any heartbeat could carry it", async () => {
  await seedTaskFile(tasks, mechanical("a"));
  const stop = manualStopNow();
  // The tick interval is `min(heartbeatMs, lockTtlMs / 3)`: with the fixture's
  // 5 s lock the 60 s heartbeat would still tick about every 1.7 s. A tick is
  // the other writer of the session id, so the lock is raised with it and the
  // first tick is a minute away.
  const agent = scriptedTurns([{ hang: "confirm" }], { hangAnnouncesSession: true });
  const running = runTask({ ...cfg, lockTtlMs: 180_000 }, deps(agent, stop), await store.get("a"), "w1");
  await agent.hanging;
  await agent.announced;
  // The id is live on the execution, but no record carries it yet: the dispatch
  // checkpoint saw none, and no heartbeat tick has fired.
  expect((await readAttempt(tasks, "a"))?.sessionId).toBeUndefined();
  stop.trigger("file");
  expect(await settles(running)).toBe("stopped");
  // The stop branch copies the live execution's session id before it settles,
  // and the session the attempt recorded is the one that was cut.
  expect(await readAttempt(tasks, "a")).toMatchObject({ phase: "settled", operation: "agent turn", sessionId: "ses-cut", reason: "stopped by operator" });
  expect(await readExecutionState(tasks, "a")).toMatchObject({ latestWorker: { sessionId: "ses-cut", clean: false } });
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

it("runTask says why an attempt that never started was skipped", async () => {
  await seedTaskFile(tasks, mechanical("a"));
  // A stop already requested: nothing is claimed.
  const caused: Array<"stop" | "claim"> = [];
  const stopped = manualStopNow();
  stopped.trigger("file");
  const agent = scriptedTurns(["done"]);
  expect(await runTask(cfg, deps(agent, stopped), await store.get("a"), "w1", { onSkipped: (cause) => caused.push(cause) })).toBe("skipped");
  expect(caused).toEqual(["stop"]);
  expect(await readAttempt(tasks, "a")).toBeNull();
  expect(await lockHeld("a")).toBe(false);
  // A live owner that is not this attempt holds the lock: the claim fails.
  const claimed: Array<"stop" | "claim"> = [];
  await mkdir(join(tasks, "a"), { recursive: true });
  await writeFile(join(tasks, "a", "lock.json"), JSON.stringify({ worker: "someone-else", heartbeat: Date.now() }), "utf8");
  expect(await runTask(cfg, deps(agent, manualStopNow()), await store.get("a"), "w2", { onSkipped: (cause) => claimed.push(cause) })).toBe("skipped");
  expect(claimed).toEqual(["claim"]);
  expect(agent.sessionIds).toEqual([]);
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
  const timedOut = Symbol("the attempt did not settle");
  let settled: unknown;
  try {
    for (let i = 0; i < 100 && gatePid === 0; i++) {
      try { gatePid = Number(await readFile(join(work, "gate.pid"), "utf8")); } catch { await new Promise((resolve) => setTimeout(resolve, 30)); }
    }
    expect(gatePid).toBeGreaterThan(0);
  } finally {
    // Nothing is left behind, even when the assertion above failed midway or
    // the fixture never started: the attempt settles here, and the confirmed
    // cancel takes the gate's process tree with it. A real cancel may run to
    // the 8 s cancel deadline, so the wait is the 8.5 s wrapper the real-adapter
    // tests use, not `settles`' 4 s. `running` is awaited without a catch: its
    // rejection is this test's failure, and the sentinel only bounds the wait.
    stop.trigger("file");
    settled = await Promise.race([running, new Promise((resolve) => setTimeout(() => resolve(timedOut), 8_500))]);
  }
  expect(settled).toBe("stopped");
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

it("a stop during a review turn that cannot prove cancellation finishes it and judges nothing", async () => {
  await seedTaskFile(tasks, mechanical("a", { verify: "human" }));
  const stop = manualStopNow();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let asked = false;
  const worker = doneAdapter({ tasksDir: tasks, sessionId: () => "s-a" });
  // A prompt-only adapter (no `start`): `startReview` cannot prove cancellation,
  // so the review finishes on its own and the stop surfaces at the next
  // `controlled` — never as a race against an execution that cannot be cancelled.
  const agent: AgentAdapter = {
    ...worker,
    prompt: async (args) => {
      if (args.text.includes("独立复核者")) {
        asked = true;
        stop.trigger("file"); // the stop lands while the review turn is in flight
        await held;
        return { sessionId: "s-review", exitCode: 0, text: "done" };
      }
      return worker.prompt(args);
    },
  };
  const running = runTask(cfg, deps(agent, stop), await store.get("a"), "w1");
  await waitForCondition(() => asked);
  // The stop is observed while the review turn is in flight: under a racing
  // review execution the attempt is already recorded uncertain before the
  // reviewer answers. Under the fix nothing consumes the stop until the
  // release below, so the bounded wait runs out first.
  await Promise.race([
    waitForConditionAsync(async () => (await readAttempt(tasks, "a"))?.phase === "uncertain", 3_000),
    new Promise((resolve) => setTimeout(resolve, 750)),
  ]);
  release(); // the review finishes on its own
  expect(await settles(running)).toBe("stopped");
  expect(await store.get("a")).toMatchObject({ status: "open", retries: 0, reviewRounds: 0 });
  expect(await readRuntime(tasks, "a", "review.json")).toBeNull();
  expect(await readAttempt(tasks, "a")).toMatchObject({ phase: "settled", operation: "review", reason: "stopped by operator" });
  expect((await readJournal(tasks, "a")).map((line) => line.event)).not.toContain("stop-unconfirmed");
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

it("a stop already pending when the telemetry dispatches is not journaled as unavailable", async () => {
  await seedTaskFile(tasks, mechanical("a"));
  const stop = manualStopNow();
  const scripted = scriptedTurns([{ stopWhenSettled: true }], { stopWhenSettled: () => stop.trigger("file") });
  const agent: AgentAdapter = { ...scripted, sessionUsage: async () => ({ input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 }) };
  // The turn wins the race, then asks for the stop as `controlled` looks at the
  // execution once more: the stop is already pending when `captureUsage`
  // dispatches — `loop` goes straight from the turn to the telemetry call, with
  // no stop check between them, so the catch's rethrow is what keeps the stop
  // out of the journal.
  const running = runTask(cfg, deps(agent, stop), await store.get("a"), "w1");
  expect(await settles(running)).toBe("stopped");
  expect(await store.get("a")).toMatchObject({ status: "open", retries: 0 });
  expect(await readAttempt(tasks, "a")).toMatchObject({ phase: "settled", operation: "agent turn", reason: "stopped by operator" });
  const journaled = (await readJournal(tasks, "a")).map((line) => line.event);
  expect(journaled).not.toContain("usage-unavailable");
  expect(journaled).not.toContain("turn-failed");
}, 8_000);

it("a stop pending when the context telemetry dispatches is not journaled as unavailable either", async () => {
  await seedTaskFile(tasks, mechanical("a"));
  const stop = manualStopNow();
  const agent = scriptedTurns(["work"]);
  // The stop lands in the ownership-guarded session recording, after the loop's
  // post-telemetry check has passed: `overBudget` is reached with the stop
  // already pending, and its telemetry dispatch must not journal it either.
  const stoppingStore: WorkerStore = {
    list: () => store.list(),
    setStatus: (id, status) => store.setStatus(id, status),
    appendSession: async (id, sessionId) => { await store.appendSession(id, sessionId); stop.trigger("file"); },
    incRetries: (id) => store.incRetries(id),
    readDoneMarker: (id) => store.readDoneMarker(id),
    clearDoneMarker: (id) => store.clearDoneMarker(id),
    incReviewRounds: (id) => store.incReviewRounds(id),
  };
  const running = runTask(cfg, deps(agent, stop, { store: stoppingStore }), await store.get("a"), "w1");
  expect(await settles(running)).toBe("stopped");
  expect(await store.get("a")).toMatchObject({ status: "open", retries: 0 });
  expect((await readJournal(tasks, "a")).map((line) => line.event)).not.toContain("context-budget-unavailable");
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

it("a recall that failed does not announce itself at a later stop", async () => {
  await seedTaskFile(tasks, mechanical("a"));
  const stop = manualStopNow();
  // `runRecall` never throws, so the way out that leaves the flag set is the
  // spec read just before it: a directory where the spec file would be. The
  // context switches keep `readContextSections` from reading it first, so the
  // failing read is the recall's own, with the flag already up.
  await mkdir(join(tasks, "a"), { recursive: true });
  await mkdir(join(tasks, "a", "spec.md"));
  const memory: MemoryBackend = { name: "fake", searchAll: async () => { throw new Error("memory down"); } };
  const agent = scriptedTurns(["done"]);
  expect(await runTask({ ...cfg, memory: memoryOn(), workerContext: { spec: false, preferences: false } }, deps(agent, stop, { memory }), await store.get("a"), "w1")).toBe("done");
  // The attempt is over; a stop on the same controller's source is the next
  // attempt's news, never this task's recall still running.
  stop.trigger("file");
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(events.filter((event) => event.type === "stop-requested" && event.detail?.startsWith("memory recall in progress"))).toEqual([]);
}, 8_000);
