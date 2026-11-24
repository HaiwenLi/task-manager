import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "../src/task-store.js";
import { runScheduler, type SchedulerOptions } from "../src/scheduler.js";
import type { WorkerConfig } from "../src/worker.js";
import type { AgentAdapter } from "../src/adapters/types.js";

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
});
