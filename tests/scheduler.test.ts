import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "../src/task-store.js";
import { runScheduler, type SchedulerOptions } from "../src/scheduler.js";
import { MODEL_ROUNDS_DEFAULT, newRunContext, writeModelWait, type ModelWaitRecord } from "../src/model-wait.js";
import type { runTask, WorkerConfig } from "../src/worker.js";
import type { AgentAdapter } from "../src/adapters/types.js";
import { manualStopNow } from "./helpers/stop-fixture.js";
import type { StopNow, StopSource } from "../src/stop.js";

let root: string;
let tasks: string;
let cwd: string;
let store: TaskStore;
let claimed: string[];
let active: number;
let peak: number;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "taskctl-sched-"));
  tasks = join(root, "tasks");
  cwd = join(root, "work");
  await mkdir(tasks);
  await mkdir(cwd);
  store = new TaskStore(tasks);
  claimed = [];
  await mkdir(join(cwd, "a"), { recursive: true });
  await mkdir(join(cwd, "b"), { recursive: true });
  await mkdir(join(cwd, "same"), { recursive: true });
  active = 0;
  peak = 0;
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

/** A turn that holds the slot briefly so overlaps are observable. */
function adapter(): AgentAdapter {
  return {
    prompt: async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active--;
      return { sessionId: "s", text: "done", exitCode: 0 };
    },
    contextUsage: async () => 0,
    contextLimit: async () => 100,
  };
}

/**
 * A turn that waits for its peer instead of sleeping a fixed time.
 *
 * The overlap this test wants to observe is "both turns are open at once". A
 * 20 ms sleep measures that only if both tasks reach their turn within 20 ms of
 * each other, and each first has to claim, reserve a workspace and write its
 * runtime record — filesystem work whose jitter on Windows regularly exceeds
 * the window, which made this test fail about half the time under full-suite
 * load while passing alone. Waiting for the peer observes the overlap directly.
 * The timeout keeps a real regression (only one task ever running) a failure
 * instead of a hang. It is generous on purpose: a claim plus a workspace
 * reservation is real filesystem work, and under a loaded suite it regularly
 * took longer than the 250 ms this used to allow — failing for a reason that
 * had nothing to do with scheduling.
 */
function overlappingAdapter(expected: number, waitMs = 1_500): AgentAdapter {
  let release!: () => void;
  const together = new Promise<void>((resolve) => { release = resolve; });
  return {
    prompt: async () => {
      active++;
      peak = Math.max(peak, active);
      if (active >= expected) release();
      const timer = setTimeout(release, waitMs);
      timer.unref?.();
      await together;
      clearTimeout(timer);
      active--;
      return { sessionId: "s", text: "done", exitCode: 0 };
    },
    contextUsage: async () => 0,
    contextLimit: async () => 100,
  };
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
    // These tests are about which tasks run at the same time, not about what a
    // turn does. Without a completion request the worker spends the whole turn
    // budget (40 turns) before it blocks, which cost ~2 s per task and made the
    // 20 ms overlap window the only thing standing between pass and flake.
    maxTurnsPerSession: 1,
    ...overrides,
  };
}

/** Tasks block at the turn cap, so this gate is never reached; the tests below
 * only assert scheduling. Keeping it explicit documents that they end `blocked`. */
const failGate = async () => ({ passed: false, skipped: false as const, exitCode: 1, output: "no" });

describe("runScheduler", () => {
  it("runs two tasks with disjoint workdirs at the same time", async () => {
    await seed("001-a", ["workdir: a"]);
    await seed("002-b", ["workdir: b"]);
    claimed = ["001-a", "002-b"];
    await runScheduler(config({ parallel: 2 }), { store, adapter: overlappingAdapter(2), acceptance: failGate });
    expect(peak).toBe(2);
  });

  it("serializes tasks that share a workdir", async () => {
    await seed("001-a", ["workdir: same"]);
    await seed("002-b", ["workdir: same"]);
    await runScheduler(config({ parallel: 2 }), { store, adapter: adapter(), acceptance: failGate });
    expect(peak).toBe(1);
  });

  it("skips a task whose dependency is not done", async () => {
    await seed("001-a");
    await seed("002-b", ["depends_on:", "  - 001-a"]);
    await store.setStatus("001-a", "blocked");
    await runScheduler(config({ parallel: 2 }), { store, adapter: adapter(), acceptance: failGate });
    expect((await store.get("002-b")).status).toBe("open");
  });

  it("rejects a dependency cycle before running anything", async () => {
    await seed("001-a", ["depends_on:", "  - 002-b"]);
    await seed("002-b", ["depends_on:", "  - 001-a"]);
    await expect(runScheduler(config(), { store, adapter: adapter(), acceptance: failGate })).rejects.toThrow(/cycle/);
  });

  it("rejects a dependency on a task that does not exist", async () => {
    await seed("001-a", ["depends_on:", "  - 999-ghost"]);
    await expect(runScheduler(config(), { store, adapter: adapter(), acceptance: failGate })).rejects.toThrow(/unknown task/);
  });

  /** A chain of `depth` tasks, each ready only once the one before it is done. */
  async function seedChain(depth: number): Promise<void> {
    for (let i = 0; i < depth; i++) {
      const id = `chain-${String(i).padStart(3, "0")}`;
      const previous = i === 0 ? [] : ["depends_on:", `  - chain-${String(i - 1).padStart(3, "0")}`];
      await writeFile(join(tasks, `${id}.md`), [
        "---", "schema: taskctl/v1", `title: ${id}`, "status: open", 'acceptance: "check"', "verify: mechanical",
        "criteria:", "  - C1 ok", ...previous, "sessions: []", "retries: 0", "---", "work", "",
      ].join("\n"), "utf8");
    }
  }

  /**
   * A runner that finishes each offered task on the spot. These two tests are
   * about the pass loop — readiness, the budget, the report — and a real claim
   * costs a workspace reservation and a digest per level: 55 levels of that
   * took 10-19 s and timed out under load, which proved nothing about the loop.
   * Real execution through a chain is covered by the split integration test.
   */
  const settling: NonNullable<SchedulerOptions["run"]> = async (_cfg, deps, task) => {
    await deps.store.setStatus(task.id, "done");
    return "done";
  };

  it("finishes a dependency chain deeper than the old fixed pass budget", async () => {
    // Each level becomes ready only after the one before it is done, so the
    // chain costs one pass per level. A fixed budget of 50 used to cut a
    // valid chain off and leave the rest sitting in `open` without a word.
    const depth = 60;
    await seedChain(depth);
    const result = await runScheduler(config(), { store, adapter: adapter() }, { run: settling });

    expect(result.done).toHaveLength(depth);
    expect(result.pending).toEqual([]);
    expect((await store.list()).every((task) => task.status === "done")).toBe(true);
  });

  it("reports the tasks it did not start when the pass budget runs out", async () => {
    await seedChain(3);
    // One pass: the first level finishes, and the next is still ready work.
    const result = await runScheduler(config(), { store, adapter: adapter() }, { run: settling, maxPasses: 1 });

    expect(result.done).toEqual(["chain-000"]);
    expect(result.pending).toEqual(["chain-001"]);
    expect((await store.get("chain-001")).status).toBe("open");
  });

  it("stops after one pass when the only offer was refused, instead of re-offering it", async () => {
    await seed("001-held");
    // Another live controller owns the task, so every claim is refused.
    await mkdir(join(tasks, "001-held"), { recursive: true });
    await writeFile(join(tasks, "001-held", "lock.json"), JSON.stringify({ worker: "other", heartbeat: Date.now() }), "utf8");
    let listings = 0;
    const counting = Object.create(store) as TaskStore;
    counting.list = async () => {
      listings += 1;
      return store.list();
    };

    const result = await runScheduler(config(), { store: counting, adapter: adapter(), acceptance: failGate });

    expect(result).toEqual({ done: [], blocked: [], pending: [] });
    // One pass, one scan: a refused claim changed nothing, so there is nothing to re-offer.
    expect(listings).toBe(1);
  });

  it("serializes two directories inside one git repository", async () => {
    // Workspace reservation treats a whole git common dir as one resource, so
    // the scheduler must not start a sibling directory task either.
    await mkdir(join(cwd, ".git"), { recursive: true });
    await seed("001-a", ["workdir: a"]);
    await seed("002-b", ["workdir: b"]);
    await runScheduler(config({ parallel: 2 }), { store, adapter: adapter(), acceptance: failGate });
    expect(peak).toBe(1);
  });

  it("never claims draft or awaiting-human tasks", async () => {
    await seed("001-a");
    await seed("002-b");
    await store.setStatus("001-a", "draft");
    await store.setStatus("002-b", "awaiting-human");
    await runScheduler(config({ parallel: 2 }), { store, adapter: adapter(), acceptance: failGate });
    expect(await store.get("001-a")).toMatchObject({ status: "draft" });
    expect(await store.get("002-b")).toMatchObject({ status: "awaiting-human" });
  });

  it("never schedules a Markdown file that does not declare the task schema", async () => {
    // The incident: a hand-taken snapshot dropped into `tasks/` was read as a new
    // open task and ran six times before anyone looked. Being in the directory is
    // not a declaration; `schema: taskctl/v1` in the frontmatter is.
    const snapshot = join(tasks, "013-snapshot-at-relaunch.md");
    const contents = ["---", "title: snapshot", "status: open", "sessions: []", "retries: 0", "---", "手工快照", ""].join("\n");
    await writeFile(snapshot, contents, "utf8");
    let turns = 0;
    const counting: AgentAdapter = {
      prompt: async () => {
        turns += 1;
        return { sessionId: "s", text: "done", exitCode: 0 };
      },
      contextUsage: async () => 0,
      contextLimit: async () => 100,
    };

    const result = await runScheduler(config(), { store, adapter: counting, acceptance: failGate });

    expect(turns).toBe(0);
    expect(result).toEqual({ done: [], blocked: [], pending: [] });
    expect(await readFile(snapshot, "utf8")).toBe(contents);
    expect((await store.scan()).ignored).toEqual(["013-snapshot-at-relaunch.md"]);
  });

  const START = new Date("2026-11-25T10:00:00.000Z");
  /** A deferral of `run`'s, as part 1's attempt leaves it. */
  const deferral = (run: ReturnType<typeof newRunContext>, rounds = 1): ModelWaitRecord => ({
    runId: run.id, stage: "worker", rounds, firstRefusedAt: START.toISOString(), refusals: [],
    nextAt: new Date(START.getTime() + 60_000).toISOString(), updatedAt: START.toISOString(),
  });

  it("a stop interrupts every task in flight and offers nothing afterwards", async () => {
    await seed("001-a", ["workdir: a"]);
    await seed("002-b", ["workdir: b"]);
    await seed("003-c", ["workdir: same"]); // still pending when the stop lands: the next `startAvailable` must not take it
    const stop = manualStopNow();
    const calls: string[] = [];
    let listings = 0;
    const counting = Object.create(store) as TaskStore;
    counting.list = async () => { listings += 1; return store.list(); };
    let began = 0;
    let both!: () => void;
    const inFlight = new Promise<void>((resolve) => { both = resolve; });
    const interrupted: typeof runTask = async (_cfg, runDeps, task) => {
      calls.push(task.id);
      if (++began === 2) both();
      await runDeps.stop!.observed;
      return "stopped";
    };
    const running = runScheduler(config({ parallel: 2 }), { store: counting, adapter: adapter(), acceptance: failGate, stop }, { run: interrupted });
    await inFlight;
    stop.trigger("file");
    const result = await running;
    expect([...calls].sort()).toEqual(["001-a", "002-b"]);
    expect([...result.stopped!].sort()).toEqual(["001-a", "002-b"]);
    expect(result).toMatchObject({ done: [], blocked: [], pending: [] });
    // One pass, one scan: the interrupted tasks are `open` again and must not be re-offered.
    expect(listings).toBe(1);
  });

  it("nothing is claimed once a stop was already requested", async () => {
    await seed("001-a");
    const stop = manualStopNow();
    stop.trigger("SIGINT");
    const run = vi.fn(settling);
    const result = await runScheduler(config(), { store, adapter: adapter(), acceptance: failGate, stop }, { run });
    expect(run).not.toHaveBeenCalled();
    expect(result).toEqual({ done: [], blocked: [], pending: [] });
  });

  it("a run the operator stopped declares no outage", async () => {
    await seed("001-a", ["workdir: a"]);
    await seed("002-b", ["workdir: b"]);
    const run = newRunContext(START);
    const stop = manualStopNow();
    let ranOut!: () => void;
    const ranOutAt = new Promise<void>((resolve) => { ranOut = resolve; });
    // Not awaited: the run holds b until the stop below; `result` is the run's promise.
    const result = runScheduler(config({ parallel: 2, run }), { store, adapter: adapter(), acceptance: failGate, stop }, {
      run: async (_cfg, runDeps, task) => {
        if (task.id === "001-a") {
          // a ran out of rounds and only recorded it: the controller decides once nothing is in flight (part 1).
          await writeModelWait(tasks, "001-a", deferral(run, MODEL_ROUNDS_DEFAULT));
          ranOut();
          return "open";
        }
        await ranOutAt;
        await runDeps.stop!.observed;
        return "stopped";
      },
    });
    await ranOutAt;
    stop.trigger("file");
    await expect(result).resolves.toEqual({ done: [], blocked: [], pending: [], stopped: ["002-b"] });
    // Left as no controller leaves it: `open`, its rounds spent, waiting for the owner.
    expect(await store.get("001-a")).toMatchObject({ status: "open", retries: 0 });
  });

  it("a stop ends a wait for a model window at once, and nothing is offered after it", async () => {
    await seed("001-a");
    const run = newRunContext(START);
    await writeModelWait(tasks, "001-a", deferral(run));
    const stop = manualStopNow();
    const offered: string[] = [];
    let waiting!: () => void;
    const waited = new Promise<void>((resolve) => { waiting = resolve; });
    const running = runScheduler(config({ run }), {
      store, adapter: adapter(), acceptance: failGate, stop,
      onEvent: (event) => { if (event.type === "model-wait") waiting(); },
    }, {
      run: async (cfg, deps, task, workerId) => { offered.push(task.id); return settling(cfg, deps, task, workerId); },
      now: () => START,
      sleep: () => new Promise<void>(() => {}), // a sleep that never ends: only the stop can end the wait
    });
    await waited;
    stop.trigger("file");
    expect(await running).toEqual({ done: [], blocked: [], pending: [] });
    expect(offered).toEqual([]);
  });

  it("a request the last look missed is still seen before the decision", async () => {
    await seed("001-a", ["workdir: a"]);
    const run = newRunContext(START);
    // A request on the board that no attempt's poll has seen: `isRequested()`
    // stays false, and the look that follows the drain is the first to see it.
    let arrived = false;
    let seen = false;
    let settle!: (source: StopSource) => void;
    const stop: StopNow = {
      observed: new Promise<StopSource>((resolve) => { settle = resolve; }),
      isRequested: () => seen,
      source: () => (seen ? "file" : undefined),
      check: async () => {
        if (arrived) { seen = true; settle("file"); }
        return seen;
      },
      hold: () => () => {},
    };
    const result = await runScheduler(config({ run }), { store, adapter: adapter(), acceptance: failGate, stop }, {
      run: async () => {
        // a ran out of rounds and only recorded it; the request lands after its last look.
        await writeModelWait(tasks, "001-a", deferral(run, MODEL_ROUNDS_DEFAULT));
        arrived = true;
        return "open";
      },
    });
    // The decision is not taken under a stop the drain's look saw: no outage,
    // the spent task left `open` for the owner.
    expect(result).toEqual({ done: [], blocked: [], pending: [] });
    expect(await store.get("001-a")).toMatchObject({ status: "open", retries: 0 });
  });

  it("a run waiting for a model window holds the stop, so a request on the board ends the wait at once", async () => {
    await seed("001-a");
    const run = newRunContext(START);
    await writeModelWait(tasks, "001-a", deferral(run));
    // A request that only a look sees, and looks happen only while a holder
    // holds: `hold()` asks `check()` on the microtask after the wait has begun,
    // as the real hold's poll does. Without a hold the look never happens and
    // the wait never ends.
    let holding = false;
    let seen = false;
    let released = 0;
    let settle!: (source: StopSource) => void;
    const observed = new Promise<StopSource>((resolve) => { settle = resolve; });
    const stop: StopNow = {
      observed,
      isRequested: () => seen,
      source: () => (seen ? "file" : undefined),
      check: async () => {
        if (holding) { seen = true; settle("file"); }
        return seen;
      },
      hold: () => {
        holding = true;
        void Promise.resolve().then(() => { void stop.check(); });
        return () => { holding = false; released += 1; };
      },
    };
    const offered: string[] = [];
    const running = runScheduler(config({ run }), {
      store, adapter: adapter(), acceptance: failGate, stop,
    }, {
      run: async (_cfg, _deps, task) => { offered.push(task.id); return "done"; },
      now: () => START,
      sleep: () => new Promise<void>(() => {}), // a sleep that never ends: only a look can end the wait
    });
    expect(await running).toEqual({ done: [], blocked: [], pending: [] });
    expect(offered).toEqual([]);
    expect(released).toBe(1); // the wait's hold is released exactly once, whichever way the wait ends
  });
});
