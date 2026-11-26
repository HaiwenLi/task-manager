/**
 * The budget guard where it sits: in `runTask`, before anything is claimed,
 * and so in everything that offers a task (`run`, a batch, `watch`), and in
 * `add` and `split`, before the clarify and the planner session.
 *
 * What the guard reported and fetched is kept per process, so every test
 * starts from a reset state.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentAdapter } from "../src/adapters/types.js";
import type { AcceptanceResult } from "../src/acceptance.js";
import { runBatch } from "../src/batch.js";
import { claim, lockLive, release } from "../src/claim.js";
import { resetGuardState } from "../src/budget.js";
import { runCli, type CliDeps } from "../src/cli.js";
import { readJournal } from "../src/journal.js";
import { runScheduler } from "../src/scheduler.js";
import { readSplitPlan } from "../src/split.js";
import { serializeTaskFile, type Task, type TaskStatus } from "../src/task-file.js";
import { TaskStore } from "../src/task-store.js";
import { runTask, type WorkerConfig, type WorkerDeps, type WorkerEvent } from "../src/worker.js";
import { REFUSED_RETRY_MS, watchQueue, type WatchFs, type WatchOptions } from "../src/watch.js";
import { CATALOGUE, adapterOf } from "./helpers/catalogue-fixture.js";
import { buildContinuousTask as task, buildTaskFile } from "./helpers/task-fixture.js";
import {
  createStopRequests, createWatchEventSeam, doneAdapter, passAcceptance, seedTaskFile, waitForCondition as waitFor,
  workerConfigFixture,
} from "./helpers/watch-fixture.js";

beforeEach(() => {
  resetGuardState();
});

/** What the guard says about the shared catalogue's paid model, exactly as `renderVerdicts` writes it. */
const PAID_LINE = "- zen/p  provider=zen  enabled=true  variants=-  拒绝：按量计费，约 $15 / 百万 token；未列入 allowedModels";

// 1. runTask, on the harness of tests/worker-context.test.ts.

type PromptArgs = Parameters<AgentAdapter["prompt"]>[0];
type PromptResult = Awaited<ReturnType<AgentAdapter["prompt"]>>;
type Script = (args: PromptArgs, fake: FakeAdapter) => PromptResult | Promise<PromptResult>;

/** 内存版 TaskStore：任务进 Map，done marker 进 Set。 */
class FakeStore {
  readonly tasks = new Map<string, Task>();
  readonly markers = new Set<string>();

  static seed(...tasks: Task[]): FakeStore {
    const store = new FakeStore();
    for (const task of tasks) {
      store.tasks.set(task.id, task);
    }
    return store;
  }

  async list(): Promise<Task[]> {
    return [...this.tasks.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  async setStatus(id: string, status: TaskStatus): Promise<void> {
    this.tasks.get(id)!.status = status;
  }

  async appendSession(id: string, sessionId: string): Promise<void> {
    this.tasks.get(id)!.sessions.push(sessionId);
  }

  async incRetries(id: string): Promise<number> {
    return ++this.tasks.get(id)!.retries;
  }

  async incReviewRounds(id: string): Promise<number> {
    return ++this.tasks.get(id)!.reviewRounds;
  }

  async readDoneMarker(id: string): Promise<boolean> {
    return this.markers.has(id);
  }

  async clearDoneMarker(id: string): Promise<void> {
    this.markers.delete(id);
  }

  /** 测试助手：模拟 agent 运行 taskctl done。 */
  requestDone(id: string): void {
    this.markers.add(id);
  }

  task(id: string): Task {
    return this.tasks.get(id)!;
  }
}

/** 脚本化 adapter：每次 prompt 由 script 应答，调用全量记录。 */
class FakeAdapter implements AgentAdapter {
  readonly calls: PromptArgs[] = [];

  constructor(
    private readonly script: (args: PromptArgs, fake: FakeAdapter) => PromptResult | Promise<PromptResult>,
  ) {}

  async prompt(args: PromptArgs): Promise<PromptResult> {
    this.calls.push(args);
    return this.script(args, this);
  }

  async contextUsage(_sessionId: string): Promise<number> {
    return 0;
  }

  async contextLimit(_model: string): Promise<number> {
    return 1_000_000;
  }
}

/** A worker turn that asks to be done, so an attempt that is allowed to run finishes. */
const asksForDone =
  (store: FakeStore): Script =>
  (_args, fake) => {
    if (fake.calls.length >= 1) store.requestDone("a");
    return { sessionId: "ses-a1", exitCode: 0, text: "完成了" };
  };

/** A worker turn nobody should ever see: what it answers does not matter. */
const noTurn: Script = () => ({ sessionId: "ses-a1", exitCode: 0, text: "完成了" });

/** Fixture reviewer: every task passes review. */
const passReview = async () => ({
  verdict: "pass" as const,
  criteria: [{ id: "C1", pass: true, evidence: "fixture" }],
  externalChanges: [],
  defects: [],
  summary: "ok",
});

const passGate = async (): Promise<AcceptanceResult> => ({ passed: true, exitCode: 0, output: "", skipped: false });

describe("runTask: the guard before the claim", () => {
  let root: string;
  let tasksDir: string;
  let events: WorkerEvent[];

  /** Task `a`, open and iterative, as tests/worker-context.test.ts defines it. */
  function unit(): Task {
    return {
      id: "a",
      title: "任务A",
      description: "A 的正文",
      status: "open",
      criteria: ["C1 fixture"],
      complexity: "complex",
      execution: "iterative",
      risk: "normal",
      dependsOn: [],
      humanCheck: false,
      tolerate: [],
      quick: false,
      verify: "human",
      renderTargets: [],
      keepAtRoot: [],
      reviewRounds: 0,
      sessions: [],
      retries: 0,
      acceptance: "fixture check",
    };
  }

  function cfg(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
    return {
      tasksDir,
      // Beside the tasks dir, not inside it: what is in the tasks dir is exactly what the task files put there.
      workdir: join(root, "workspace"),
      agent: "opencode",
      model: "test/default",
      contextThreshold: 0.8,
      retryLimit: 3,
      lockTtlMs: 600_000,
      heartbeatMs: 60_000,
      ...overrides,
    };
  }

  /** Task `a` on disk as well as in the harness's store, so a refusal can be checked against the file. */
  async function seeded(): Promise<FakeStore> {
    await writeFile(join(tasksDir, "a.md"), serializeTaskFile(unit()), "utf8");
    return FakeStore.seed(unit());
  }

  /** The scripted adapter with the two methods the guard reads: the shared catalogue, and `defaultRef` as the backend's default. */
  function guarded(script: Script, defaultRef = "plan/m"): FakeAdapter {
    return Object.assign(new FakeAdapter(script), adapterOf(CATALOGUE, defaultRef));
  }

  function watched(store: FakeStore, adapter: AgentAdapter): WorkerDeps {
    return { store, adapter, acceptance: passGate, review: passReview, onEvent: (event) => { events.push(event); } };
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "taskctl-budget-guard-"));
    tasksDir = join(root, "tasks");
    await mkdir(tasksDir);
    await mkdir(join(root, "workspace"));
    events = [];
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("refuses before the claim and leaves the task open", async () => {
    // cfg.model = "zen/p" (paid in the catalogue)
    const store = await seeded();
    const adapter = guarded(noTurn);
    const config = cfg({ model: "zen/p" });

    expect(await runTask(config, watched(store, adapter), unit(), "w")).toBe("refused");

    expect((await new TaskStore(config.tasksDir).get("a")).status).toBe("open");
    expect(store.task("a").status).toBe("open");
    expect(adapter.calls).toHaveLength(0);
    expect(events.filter((e) => e.type === "refused")).toHaveLength(1);
    expect(await readdir(join(config.tasksDir, "a")).catch(() => [])).toEqual([]);   // nothing claimed, nothing written
    // Stronger than an empty task directory: the directory itself was never created.
    expect(await readdir(config.tasksDir)).toEqual(["a.md"]);
    // What is reported is the guard's verdict for the model that was refused, and nothing else.
    expect(events).toEqual([{ type: "refused", taskId: "a", detail: PAID_LINE }]);
  });

  it("reports the same refusal once per process", async () => {
    const store = await seeded();
    const config = cfg({ model: "zen/p" });
    await runTask(config, watched(store, guarded(noTurn)), unit(), "w");
    await runTask(config, watched(store, guarded(noTurn)), unit(), "w");
    expect(events.filter((e) => e.type === "refused")).toHaveLength(1);
    // Not reporting it again is not letting it through: the third offer is refused like the first two.
    expect(await runTask(config, watched(store, guarded(noTurn)), unit(), "w")).toBe("refused");
    expect(events.filter((e) => e.type === "refused")).toHaveLength(1);
  });

  it("reports a refusal again when the models refused are not the same", async () => {
    const store = await seeded();
    await runTask(cfg({ model: "zen/p" }), watched(store, guarded(noTurn)), unit(), "w");
    // Once per process for a task and its refused models: the same task refused for another model is news.
    await runTask(cfg({ model: "kimi/k" }), watched(store, guarded(noTurn)), unit(), "w");
    await runTask(cfg({ model: "kimi/k" }), watched(store, guarded(noTurn)), unit(), "w");
    expect(events.map((e) => e.detail)).toEqual([PAID_LINE, expect.stringContaining("- kimi/k  provider=kimi")]);
  });

  it("lets an explicitly allowed model through", async () => {
    // cfg.allowedModels = ["zen/p"]
    const store = await seeded();
    const config = cfg({ model: "zen/p", allowedModels: ["zen/p"] });
    expect(await runTask(config, watched(store, guarded(asksForDone(store))), unit(), "w")).toBe("done");
    expect(events.some((e) => e.type === "refused")).toBe(false);
  });

  it("judges the backend default when no model is configured", async () => {
    // cfg without model or reviewerModel; the adapter's defaultModelRef answers "zen/p"
    const store = await seeded();
    const adapter = guarded(noTurn, "zen/p");
    const config = cfg({ model: undefined });
    expect(await runTask(config, watched(store, adapter), unit(), "w")).toBe("refused");
    expect(events.find((e) => e.type === "refused")?.detail).toContain("zen/p");
    expect(adapter.calls).toHaveLength(0);
  });

  it("lets a backend default that may run through", async () => {
    const store = await seeded();
    const adapter = guarded(asksForDone(store), "plan/m");
    expect(await runTask(cfg({ model: undefined }), watched(store, adapter), unit(), "w")).toBe("done");
  });

  it("checks only the reviewer side of a review-only recovery", async () => {
    // cfg.reviewerModel = "kimi/k" (unknown). The worker's own model is paid, which is exactly what must not be judged here.
    const store = await seeded();
    const adapter = guarded(noTurn);
    const config = cfg({ reviewerModel: "kimi/k", model: "zen/p" });
    expect(await runTask(config, watched(store, adapter), unit(), "w", { reviewOnly: true })).toBe("refused");
    const detail = events.find((e) => e.type === "refused")?.detail ?? "";
    expect(detail).toContain("- kimi/k  provider=kimi");
    expect(detail).not.toContain("zen/p");
  });

  it("does not refuse a review-only recovery for the model its worker ran on", async () => {
    // The other half of the one above: the reviewer's model may run, and the worker's paid model is no reason to stop a recovery.
    const store = FakeStore.seed({ ...unit(), status: "blocked" });
    const adapter = guarded(noTurn);
    const config = cfg({ reviewerModel: "plan/m", model: "zen/p" });
    // Past the guard. What stops this one is the missing parked record, not the budget: the attempt never started (`claimed` is not even reported).
    expect(await runTask(config, watched(store, adapter), store.task("a"), "w", { reviewOnly: true })).toBe("blocked");
    expect(events).toEqual([{ type: "blocked", taskId: "a", detail: "review-only recovery requires a settled previous attempt" }]);
    expect(adapter.calls).toHaveLength(0);
  });

  it("refuses, instead of running, when the catalogue cannot be read", async () => {
    // the adapter's modelCatalog throws new Error("service unreachable")
    const store = await seeded();
    const adapter = Object.assign(new FakeAdapter(noTurn), adapterOf(CATALOGUE, "plan/m"), {
      modelCatalog: async () => { throw new Error("service unreachable"); },
    });
    const config = cfg({ model: "zen/p" });
    expect(await runTask(config, watched(store, adapter), unit(), "w")).toBe("refused");
    expect(adapter.calls).toHaveLength(0);
    expect(events.find((e) => e.type === "refused")?.detail).toContain("模型目录读不到");
    expect((await new TaskStore(config.tasksDir).get("a")).status).toBe("open");
    expect(await readdir(config.tasksDir)).toEqual(["a.md"]);
  });

  it("judges the task the attempt really runs, not only the snapshot the caller passed", async () => {
    // The caller's snapshot names the free plan/m; the board holds the same task with the paid zen/p, edited onto
    // it after the caller read it. The first guard passes; the second, on the task as the board holds it, refuses.
    const store = await seeded();
    store.tasks.set("a", { ...unit(), model: "zen/p" });
    const adapter = guarded(noTurn);
    const config = cfg({ model: "plan/m" });

    expect(await runTask(config, watched(store, adapter), { ...unit(), model: "plan/m" }, "w")).toBe("refused");

    expect(adapter.calls).toHaveLength(0);
    expect(store.task("a").status).toBe("open");
    expect(events).toEqual([{ type: "refused", taskId: "a", detail: PAID_LINE }]);
    // Nothing of the attempt was written: the claim created the task's directory, and nothing else is in it.
    expect(await readdir(join(config.tasksDir, "a"))).toEqual([]);
    // The claim's lock is free again, for a later claim...
    expect(await lockLive(config.tasksDir, "a", config.lockTtlMs)).toBe(false);
    expect(await claim(config.tasksDir, "a", "later", config.lockTtlMs)).toBe(true);
    await release(config.tasksDir, "a", "later");
    // ...and so is the workspace: the task runs once its model is allowed, with no human in between.
    events.length = 0;
    const allowed = cfg({ model: "plan/m", allowedModels: ["zen/p"] });
    expect(await runTask(allowed, watched(store, guarded(asksForDone(store))), { ...unit(), model: "plan/m" }, "w")).toBe("done");
    expect(events.some((e) => e.type === "refused")).toBe(false);
  });

  it("reports a refusal again when its reason changes, for the same models", async () => {
    const store = await seeded();
    // First the catalogue cannot be read at all; then it can, and the model turns out to be paid.
    let readable = false;
    // The backend's default is the same paid model, so both refusals name the same refs: an unreadable catalogue
    // refuses every model it was asked about, the default included.
    const adapter = Object.assign(new FakeAdapter(noTurn), adapterOf(CATALOGUE, "zen/p"), {
      modelCatalog: async () => { if (!readable) throw new Error("service unreachable"); return CATALOGUE; },
    });
    const config = cfg({ model: "zen/p" });
    const run = () => runTask(config, watched(store, adapter), unit(), "w");
    expect(await run()).toBe("refused");
    readable = true;
    expect(await run()).toBe("refused");
    // The same task and the same model, refused for another reason: news, so it is reported.
    expect(events.map((e) => e.type)).toEqual(["refused", "refused"]);
    expect(events[0]!.detail).toContain("模型目录读不到");
    expect(events[1]!.detail).toBe(PAID_LINE);
    // The same reason again is still said once.
    expect(await run()).toBe("refused");
    expect(events).toHaveLength(2);
  });

  it("asks for the catalogue in the directory the session runs in", async () => {
    const store = await seeded();
    const catalogueDirs: Array<string | undefined> = [];
    const defaultDirs: Array<string | undefined> = [];
    const adapter = Object.assign(new FakeAdapter(asksForDone(store)), {
      modelCatalog: async (cwd?: string) => { catalogueDirs.push(cwd); return CATALOGUE; },
      defaultModelRef: async (cwd?: string) => { defaultDirs.push(cwd); return "plan/m"; },
    });
    const config = cfg({ model: undefined });
    expect(await runTask(config, watched(store, adapter), unit(), "w")).toBe("done");

    // The session runs in the reserved workspace, and every read of the catalogue and of the default was asked
    // there: in that directory, or in the configured workdir that names it.
    const sessionDir = adapter.calls[0]!.cwd;
    expect(new Set(catalogueDirs)).toEqual(new Set([config.workdir, sessionDir]));
    expect(new Set(defaultDirs)).toEqual(new Set([config.workdir, sessionDir]));
    // Once per directory, not once per guard.
    expect(catalogueDirs).toHaveLength(sessionDir === config.workdir ? 1 : 2);
  });

  it("does not guard an adapter that cannot list models", async () => {
    // The fakes every other suite runs on have no `modelCatalog`: nothing is known about them, so nothing is refused.
    const store = await seeded();
    const adapter = new FakeAdapter(asksForDone(store));
    expect(await runTask(cfg({ model: "zen/p" }), watched(store, adapter), unit(), "w")).toBe("done");
  });
});

// 2. runScheduler, on the board of tests/fault-isolation.test.ts.

describe("runScheduler: a refusal is offered once and is not progress", () => {
  let root: string;
  let tasks: string;
  let work: string;
  let store: TaskStore;
  let cfg: WorkerConfig;
  let events: WorkerEvent[];

  /** The shared fake worker turn, able to list the catalogue the guard judges by: `plan/m` is free, `zen/p` is paid. */
  function adapter(): AgentAdapter {
    return { ...doneAdapter({ tasksDir: tasks, sessionId: (id) => `s-${id}` }), ...adapterOf(CATALOGUE, "plan/m") };
  }

  function deps(agent: AgentAdapter, overrides: Partial<WorkerDeps> = {}): WorkerDeps {
    return { store, adapter: agent, acceptance: passAcceptance, onEvent: (event) => { events.push(event); }, ...overrides };
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "taskctl-budget-guard-run-"));
    tasks = join(root, "tasks");
    work = join(root, "work");
    await mkdir(tasks);
    await mkdir(work);
    store = new TaskStore(tasks);
    // cfg without model: a task without one of its own runs on the backend's default.
    cfg = { ...workerConfigFixture({ tasksDir: tasks, workdir: work, lockTtlMs: 5_000, heartbeatMs: 1_000 }), model: undefined };
    events = [];
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("run offers a refused task but does not count it as progress", async () => {
    // task a has model "zen/p", task b has model "plan/m"; the run seam counts how often each task is offered
    await seedTaskFile(tasks, task("a", { model: "zen/p" }), task("b", { model: "plan/m" }));
    const offered: string[] = [];
    const run = async (...args: Parameters<typeof runTask>) => { offered.push(args[2].id); return runTask(...args); };

    const result = await runScheduler(cfg, deps(adapter()), { run });

    expect(result).toEqual({ done: ["b"], blocked: [], pending: [], refused: ["a"] });
    expect(offered.filter((id) => id === "a")).toHaveLength(1);
    expect((await store.get("a")).status).toBe("open");
    expect(events.filter((event) => event.type === "refused")).toHaveLength(1);

    // The other half of "not progress": a pass in which only a refusal happened is the last pass. The board is
    // read once, not once more per pass, and the task is not offered again in this run.
    let reads = 0;
    const counting = Object.create(store) as TaskStore;
    counting.list = async () => { reads += 1; return store.list(); };
    offered.length = 0;
    expect(await runScheduler(cfg, deps(adapter(), { store: counting }), { run })).toEqual({ done: [], blocked: [], pending: [], refused: ["a"] });
    expect(offered).toEqual(["a"]);
    expect(reads).toBe(1);
  });

  it("leaves a refused task out of the pending report at the pass budget", async () => {
    // a is refused, b may run, c waits for b. One pass is allowed, so c is left unstarted.
    await seedTaskFile(tasks, task("a", { model: "zen/p" }), task("b", { model: "plan/m" }), task("c", { model: "plan/m", dependsOn: ["b"] }));
    const result = await runScheduler(cfg, deps(adapter()), { maxPasses: 1 });
    // Another run will not start a either, so it is not reported as work left for that run.
    expect(result).toEqual({ done: ["b"], blocked: [], pending: ["c"], refused: ["a"] });
  });

  it("adds nothing to the result when nothing was refused", async () => {
    await seedTaskFile(tasks, task("a", { model: "plan/m" }), task("b", { model: undefined }));
    expect(await runScheduler(cfg, deps(adapter()))).toEqual({ done: ["a", "b"], blocked: [], pending: [] });
    // Present only when something was refused: callers and tests that compare the whole object see what they always did.
    expect(await runScheduler(cfg, deps(adapter()))).toStrictEqual({ done: [], blocked: [], pending: [] });
  });
});

// 3. runBatch and watchQueue, on the setup of tests/watch.test.ts.

describe("a batch and the watch queue", () => {
  let root: string;
  let tasks: string;
  let work: string;
  let store: TaskStore;
  let cfg: WorkerConfig;
  let listeners: Map<string, () => void>;
  let watchFs: WatchFs;
  let stop: ReturnType<typeof createStopRequests>;

  /** The shared fake worker turn, able to list the catalogue the guard judges by. */
  function adapter(): AgentAdapter {
    return { ...doneAdapter({ tasksDir: tasks, sessionId: (id) => `s-${id}` }), ...adapterOf(CATALOGUE, "plan/m") };
  }

  function deps(): WorkerDeps {
    return { store, adapter: adapter(), acceptance: passAcceptance };
  }

  const requestStop = (): Promise<void> => stop.request();

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "taskctl-budget-guard-watch-"));
    tasks = join(root, "tasks");
    work = join(root, "work");
    await mkdir(tasks);
    await mkdir(work);
    store = new TaskStore(tasks);
    ({ listeners, watchFs } = createWatchEventSeam());
    stop = createStopRequests(tasks, listeners);
    cfg = workerConfigFixture({ tasksDir: tasks, workdir: work, lockTtlMs: 5_000, heartbeatMs: 20 });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /**
   * Runs the queue, and ends it by force if it is still going after `ms`, so a queue that never stops fails instead of
   * hanging. A scheduling error the queue survives is reported here as the failure it is, not a silent pause.
   */
  async function queue(options: WatchOptions, ms = 3_000): Promise<void> {
    const deadline = setTimeout(() => { void requestStop().catch(() => {}); }, ms);
    try {
      await watchQueue(cfg, deps(), {
        onError: (message) => { throw new Error(`the queue paused on a scheduling error: ${message}`); },
        ...options,
      });
    } finally {
      clearTimeout(deadline);
    }
  }

  it("a batch stops with outcome refused and leaves the rest unclaimed", async () => {
    // a has model "zen/p", b has model "plan/m"; a valid two-task batch as in tests/batch.test.ts
    await seedTaskFile(tasks, task("a", { model: "zen/p" }), task("b", { model: "plan/m" }));
    const prompts: PromptArgs[] = [];
    const adapter: AgentAdapter = {
      ...adapterOf(CATALOGUE, "plan/m"),
      prompt: async (args) => { prompts.push(args); throw new Error("no model session may start"); },
      contextUsage: async () => 0,
      contextLimit: async () => 100,
    };

    const result = await runBatch(cfg, { ...deps(), adapter }, ["a", "b"], { shouldStop: async () => false });

    expect(result).toEqual({ done: [], stoppedAt: "a", outcome: "refused", pending: ["b"] });
    expect(prompts).toHaveLength(0);
    expect((await store.get("b")).status).toBe("open");
    expect(await readdir(join(tasks, "b")).catch(() => [])).toEqual([]);
  });

  it("watch runs the task behind a refused one instead of offering it forever", async () => {
    // a and b open, neither fit for a batch, so each is offered on its own
    await seedTaskFile(tasks, buildTaskFile({ id: "a", title: "a" }), buildTaskFile({ id: "b", title: "b" }));
    const offered: string[] = [];
    await queue({
      watchFs, fallbackMs: 20, debounceMs: 5,
      runOne: async (_c, _d, offeredTask) => {
        offered.push(offeredTask.id);
        // The end of the test, and a bound on a queue that offers a forever.
        if (offeredTask.id === "b" || offered.length >= 6) await requestStop();
        return offeredTask.id === "a" ? "refused" : "done";
      },
    });
    expect(offered).toEqual(["a", "b"]);
  });

  it("watch does not spin on a refused task, and judges it again later", async () => {
    // a open
    await seedTaskFile(tasks, task("a"));
    const at: number[] = [];
    await queue({
      watchFs, fallbackMs: 10, debounceMs: 5, refusedRetryMs: 60,
      runOne: async () => {
        at.push(Date.now());
        // Judged a third time: enough to see the interval twice, and the end of the test.
        if (at.length === 3) await requestStop();
        return "refused";
      },
    });
    expect(at.length).toBeGreaterThanOrEqual(2);   // tried again after the retry interval
    expect(at.length).toBeLessThan(6);             // never the dozens a pass-per-wake loop would make
    // ...and not before the interval: the fallback scan wakes the queue every 10 ms, and none of those wakes re-offered a.
    expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(50);
    expect(at[2]! - at[1]!).toBeGreaterThanOrEqual(50);
  });

  it("a refused batch makes the queue wait, and the next pass leaves that task out", async () => {
    // a, b and c open and all eligible for one batch
    await seedTaskFile(tasks, task("a"), task("b"), task("c"));
    const batches: string[][] = [];
    // How long the queue waited between the end of one batch and the start of the next.
    const gaps: number[] = [];
    let previousEnded: number | undefined;
    await queue({
      watchFs, fallbackMs: 120, debounceMs: 5,
      runBatch: async (_c, _d, ids) => {
        if (previousEnded !== undefined) gaps.push(Date.now() - previousEnded);
        batches.push(ids);
        if (batches.length === 2) await requestStop();
        previousEnded = Date.now();
        return { done: [], stoppedAt: "a", outcome: "refused", pending: ids.slice(1) };
      },
      runOne: async () => { await requestStop(); return "done"; },
    });
    expect(batches[0]).toEqual(["a", "b", "c"]);
    expect(batches[1]).toEqual(["b", "c"]);
    // It waits: the next pass began only after the fallback interval, not at once as a worked cycle would.
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toBeGreaterThanOrEqual(100);
  });

  it("a refused batch that got work done makes the queue rescan at once, and the next pass still leaves that task out", async () => {
    // a, b and c open and all eligible for one batch; b is finished before c is refused
    await seedTaskFile(tasks, task("a"), task("b"), task("c"));
    const batches: string[][] = [];
    // How long the queue waited between the end of one batch and the start of the next.
    const gaps: number[] = [];
    let previousEnded: number | undefined;
    await queue({
      // No wake comes. The fallback is longer than the harness's 3 s deadline, so a queue that waits for it
      // is stopped before it fires, and never reaches a second batch.
      watchFs, fallbackMs: 5_000, debounceMs: 5,
      runBatch: async (_c, _d, ids) => {
        if (previousEnded !== undefined) gaps.push(Date.now() - previousEnded);
        batches.push(ids);
        if (batches.length === 2) await requestStop();
        previousEnded = Date.now();
        return { done: ["b"], stoppedAt: "c", outcome: "refused", pending: ids.filter((id) => id !== "b") };
      },
      runOne: async () => { await requestStop(); return "done"; },
    });
    // What was finished may have made other tasks eligible, so the pass after the batch is not worth waiting for...
    expect(batches).toEqual([["a", "b", "c"], ["a", "b"]]);
    // ...and it began at once: no wake was sent before the second batch asked for the stop itself.
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toBeLessThan(1_000);
  });

  it("leaves a refused task out of its candidates for five minutes by default", () => {
    expect(REFUSED_RETRY_MS).toBe(300_000);
  });

  it("offers a task with a dead lock first, but leaves it out while it cools and runs the rest of the board", async () => {
    // a is `running` on the board, but its lock stopped heartbeating a minute ago; b is open behind it.
    await seedTaskFile(tasks, task("a", { status: "running" }), buildTaskFile({ id: "b", title: "b" }));
    await mkdir(join(tasks, "a"), { recursive: true });
    await writeFile(join(tasks, "a", "lock.json"), JSON.stringify({ worker: "dead-worker", heartbeat: Date.now() - 60_000 }), "utf8");
    const offered: string[] = [];
    const at: number[] = [];
    const refusedRetryMs = 300;
    await queue({
      watchFs, fallbackMs: 20, debounceMs: 5, refusedRetryMs,
      runOne: async (_c, _d, offeredTask) => {
        offered.push(offeredTask.id);
        at.push(Date.now());
        // Judged a second time: the end of the test.
        if (offered.filter((id) => id === "a").length === 2) await requestStop();
        return "refused";
      },
    });
    // A dead lock is still taken over first, whatever the guard says about it. But a refusal cools it like any
    // other task, so the task behind it runs instead of the same task being offered at every wake...
    expect(offered).toEqual(["a", "b", "a"]);
    // ...and it is offered again only after the retry interval.
    expect(at[2]! - at[0]!).toBeGreaterThanOrEqual(refusedRetryMs - 20);
  });
});

// 4. runCli, with a temporary --config and the captured output of tests/cli.test.ts.

/** 捕获 CLI 输出的注入 seam。 */
function capture(): {
  lines: string[];
  errors: string[];
  deps: { log: (line: string) => void; err: (line: string) => void };
} {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    deps: {
      log: (line) => lines.push(line),
      err: (line) => errors.push(line),
    },
  };
}

describe("run, add and split through the CLI", () => {
  /** The spec a clarify session answers with, as in tests/cli-add.test.ts: a draft with two criteria. */
  const SPEC = "## 目标\n改好\n## 验收标准\n- C1 npm test 全绿\n- C2 文案正确\n";

  let root: string;
  let tasks: string;
  let work: string;
  let config: string;
  let lines: string[];
  let errors: string[];
  let catalogueCalls: number;
  /** The directory each read of the catalogue was asked in. */
  let catalogueDirs: Array<string | undefined>;
  let promptCalls: number;
  let adapter: AgentAdapter;
  let listeners: Map<string, () => void>;
  let watchFs: WatchFs;
  let stop: ReturnType<typeof createStopRequests>;

  /** `runCli`'s deps: the adapter that can be asked, and the captured output; a test adds its own seams. */
  function cli(extra: CliDeps = {}): CliDeps {
    return { adapter, log: (line) => lines.push(line), err: (line) => errors.push(line), ...extra };
  }

  async function writeConfig(settings: Record<string, unknown>): Promise<string> {
    const path = join(root, "taskctl.json");
    await writeFile(path, JSON.stringify(settings), "utf8");
    return path;
  }

  /** A parent that is ready to plan, the way tests/split-flow.test.ts seeds one: a draft with a spec and its criteria. */
  async function seedParent(): Promise<void> {
    await writeFile(join(tasks, "a.md"), serializeTaskFile(buildTaskFile({
      id: "a", title: "导出功能", status: "draft", description: "给产品加导出功能", criteria: ["C1 导出的表格含表头", "C2 旧路由仍可用"],
    })), "utf8");
    await mkdir(join(tasks, "a"), { recursive: true });
    await writeFile(join(tasks, "a", "spec.md"), "## 目标\n导出\n\n## 验收标准\n- C1 导出的表格含表头\n- C2 旧路由仍可用\n", "utf8");
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "taskctl-budget-guard-cli-"));
    tasks = join(root, "tasks");
    work = join(root, "work");
    await mkdir(tasks);
    await mkdir(work);
    // config = { tasksDir: tasks, workdir: work, model: "zen/p" }
    config = await writeConfig({ tasksDir: tasks, workdir: work, model: "zen/p" });
    lines = [];
    errors = [];
    catalogueCalls = 0;
    catalogueDirs = [];
    promptCalls = 0;
    // Answers the guard from the shared catalogue, and a clarify or planner session with a spec.
    adapter = {
      modelCatalog: async (cwd?: string) => { catalogueCalls += 1; catalogueDirs.push(cwd); return CATALOGUE; },
      defaultModelRef: async () => "plan/m",
      prompt: async () => { promptCalls += 1; return { sessionId: "s-1", exitCode: 0, text: SPEC }; },
      contextUsage: async () => 0,
      contextLimit: async () => 0,
    };
    ({ listeners, watchFs } = createWatchEventSeam());
    stop = createStopRequests(tasks, listeners);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("an empty run neither asks the catalogue nor prints anything", async () => {
    expect(await runCli(["run", "--config", config], cli())).toBe(0);
    expect(catalogueCalls).toBe(0);
    expect(lines).toEqual([]);
  });

  it("run exits 1 when a task was refused", async () => {
    // a is open with no model of its own, so it runs on the configured one: "zen/p".
    await seedTaskFile(tasks, buildTaskFile({ id: "a", title: "a" }));
    expect(await runCli(["run", "--config", config], cli())).toBe(1);
    expect(lines.join("\n")).toContain("[scheduler] 1 task(s) refused by the budget guard; no model session was started for them");
  });

  it("run counts the refusals off the result, never off the events", async () => {
    await seedTaskFile(tasks, buildTaskFile({ id: "a", title: "a" }), buildTaskFile({ id: "b", title: "b" }));
    // The verdict lines of the event, each task once.
    expect(await runCli(["run", "--config", config], cli())).toBe(1);
    expect(lines.filter((line) => line === `[a] refused ${PAID_LINE}`)).toHaveLength(1);
    expect(lines.filter((line) => line === `[b] refused ${PAID_LINE}`)).toHaveLength(1);
    expect(lines.join("\n")).toContain("[scheduler] 2 task(s) refused by the budget guard; no model session was started for them");
    // The events were reported already in this process, so this run says nothing new about them, and still exits 1.
    lines.length = 0;
    expect(await runCli(["run", "--config", config], cli())).toBe(1);
    expect(lines.filter((line) => line.includes("] refused"))).toHaveLength(0);
    expect(lines.join("\n")).toContain("[scheduler] 2 task(s) refused by the budget guard; no model session was started for them");
  });

  it("a refused run writes nothing into the task's directory, not even its log line", async () => {
    await seedTaskFile(tasks, buildTaskFile({ id: "a", title: "a" }));
    await runCli(["run", "--config", config], cli());
    expect(lines[0]).toBe(`[a] refused ${PAID_LINE}`);
    expect(await readdir(tasks)).toEqual(["a.md"]);
  });

  it("run --batch exits 1 when the batch stops on a refusal", async () => {
    await seedTaskFile(tasks, task("a", { model: undefined }), task("b", { model: "plan/m" }));
    expect(await runCli(["run", "--batch", "a,b", "--config", config], cli())).toBe(1);
    const text = lines.join("\n");
    expect(text).toContain("[batch] stopped at a (refused); unclaimed: b");
    expect(text).toContain("[scheduler] 1 task(s) refused by the budget guard; no model session was started for them");
    expect(promptCalls).toBe(0);
  });

  it("run prints the refusals beside the controller errors, and exits 1 for either", async () => {
    // a has no model of its own, so it runs on the configured "zen/p" and is refused.
    // b may run, and its store's next session append fails the way a full disk does (as in tests/fault-isolation.test.ts).
    await seedTaskFile(tasks, buildTaskFile({ id: "a", title: "a" }), task("b", { model: "plan/m" }));
    const real = new TaskStore(tasks);
    const flaky = Object.create(real) as TaskStore;
    let failNext = true;
    flaky.appendSession = async (...args: Parameters<TaskStore["appendSession"]>) => {
      if (failNext) {
        failNext = false;
        throw new Error("disk full");
      }
      return real.appendSession(...args);
    };

    expect(await runCli(["run", "--config", config], cli({
      store: flaky,
      adapter: { ...doneAdapter({ tasksDir: tasks, sessionId: (id) => `s-${id}` }), ...adapterOf(CATALOGUE, "plan/m") },
      acceptance: passAcceptance,
    }))).toBe(1);

    const controller = lines.indexOf("[scheduler] 1 task(s) blocked by a controller error; see the controller-error line(s) above");
    const refusal = lines.indexOf("[scheduler] 1 task(s) refused by the budget guard; no model session was started for them");
    // Each line for its own count, the controller errors first: neither hides the other.
    expect(controller).toBeGreaterThanOrEqual(0);
    expect(refusal).toBeGreaterThanOrEqual(0);
    expect(controller).toBeLessThan(refusal);
    expect((await real.get("b")).status).toBe("blocked");
    expect((await real.get("a")).status).toBe("open");
  });

  it("add refuses before it writes anything", async () => {
    expect(await runCli(["add", "整理表格", "--config", config], cli())).toBe(1);
    expect(promptCalls).toBe(0);
    expect(errors.join("\n")).toContain("budget guard refused:");
    expect(errors.join("\n")).toContain("zen/p");
    expect(await readdir(tasks)).toEqual([]);
    // The verdict lines, then the error the command died of.
    expect(errors).toEqual([PAID_LINE, "taskctl: budget guard refused: zen/p"]);
    // Asked in the directory the clarify session would have started in: the backend answers by it.
    expect(catalogueDirs).toEqual([work]);
  });

  it("add --quick is not checked", async () => {
    expect(await runCli(["add", "整理表格", "--quick", "--config", config], cli())).toBe(0);
    expect(catalogueCalls).toBe(0);
    expect(promptCalls).toBe(0);
  });

  it("add with an allowed model goes on to clarify", async () => {
    // config with allowedModels: ["zen/p"]
    config = await writeConfig({ tasksDir: tasks, workdir: work, model: "zen/p", allowedModels: ["zen/p"] });
    expect(await runCli(["add", "整理表格", "--config", config], cli())).toBe(0);
    expect(promptCalls).toBe(1);
    expect(errors).toEqual([]);
  });

  it("split refuses, journals it and writes no plan", async () => {
    await seedParent();
    expect(await runCli(["split", "--task", "a", "--config", config], cli())).toBe(1);
    expect(promptCalls).toBe(0);
    const refusal = (await readJournal(tasks, "a")).find((line) => line.stage === "split" && line.event === "budget-refused");
    expect(refusal?.detail).toBe("zen/p");
    expect(await readSplitPlan(tasks, "a")).toBeNull();
    expect(errors).toEqual([PAID_LINE]);
    // The planner session's directory, as for the clarify session.
    expect(catalogueDirs).toEqual([work]);
  });

  it("watch logs the refusal once and writes nothing into the task's directory", async () => {
    await seedTaskFile(tasks, buildTaskFile({ id: "a", title: "a" }));
    const running = runCli(["watch", "--config", config], cli({ watch: { watchFs, fallbackMs: 10, debounceMs: 5 } }));
    let code: number;
    try {
      await waitFor(() => lines.some((line) => line === `[a] refused ${PAID_LINE}`));
      // The queue keeps waking in between (every fallback scan) and does not offer a again: nothing is reported twice.
      await delay(40);
    } finally {
      await stop.request();
      code = await running;
    }
    expect(code).toBe(0);
    expect(lines).toEqual([`[a] refused ${PAID_LINE}`]);
    // The queue woke several times in between and did not offer a again: nothing was reported twice.
    expect(await readdir(tasks)).toEqual(["a.md"]);
  });
});
