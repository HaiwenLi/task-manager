import { afterEach, beforeEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter, PromptResult } from "../src/adapters/types.js";
import { readExecutionState } from "../src/execution-state.js";
import type { Execution } from "../src/execution.js";
import { readJournal } from "../src/journal.js";
import { readAttempt, writeRuntime } from "../src/runtime.js";
import type { StopNow } from "../src/stop.js";
import type { Task } from "../src/task-file.js";
import { TaskStore } from "../src/task-store.js";
import { runTask, type WorkerConfig, type WorkerDeps, type WorkerEvent } from "../src/worker.js";
import { reserveWorkspace } from "../src/workspace.js";
import { CATALOGUE } from "./helpers/catalogue-fixture.js";
import { buildTaskFile } from "./helpers/task-fixture.js";
import { manualStopNow } from "./helpers/stop-fixture.js";
import { doneAdapter, passAcceptance, seedTaskFile, workerConfigFixture } from "./helpers/watch-fixture.js";

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
