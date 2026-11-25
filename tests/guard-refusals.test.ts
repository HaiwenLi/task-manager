import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter } from "../src/adapters/types.js";
import { validateBatchSelection } from "../src/batch.js";
import { resetGuardState } from "../src/budget.js";
import { clearGuardRefusal, pruneGuardRefusals, readGuardRefusals, recordGuardRefusal, type GuardRefusal } from "../src/guard-refusals.js";
import { runScheduler } from "../src/scheduler.js";
import { TaskStore } from "../src/task-store.js";
import { runTask, type WorkerConfig, type WorkerDeps, type WorkerEvent } from "../src/worker.js";
import { watchQueue } from "../src/watch.js";
import { adapterOf, CATALOGUE } from "./helpers/catalogue-fixture.js";
import { buildContinuousTask, buildTaskFile } from "./helpers/task-fixture.js";
import { createStopRequests, createWatchEventSeam, passAcceptance, seedTaskFile, waitForConditionAsync, workerConfigFixture } from "./helpers/watch-fixture.js";

const AT = "2026-11-25T10:00:00.000Z";
const LATER = "2026-11-25T10:05:00.000Z";
/** What the guard says about the shared catalogue's paid model, exactly as `renderVerdicts` writes it. */
const PAID_LINE = "- zen/p  provider=zen  enabled=true  variants=-  拒绝：按量计费，约 $15 / 百万 token；未列入 allowedModels";

let root: string;
let tasks: string;
let work: string;
let store: TaskStore;
let events: WorkerEvent[];

/** The configuration of a guarded board: no model of its own, so a task runs on the model it declares. */
const config = (overrides: Partial<WorkerConfig> = {}): WorkerConfig => ({
  tasksDir: tasks, workdir: work, agent: "opencode", contextThreshold: 0.8, retryLimit: 3, lockTtlMs: 600_000, heartbeatMs: 60_000, ...overrides,
});
/** The shared catalogue answers the guard: `plan/m` is free, `zen/p` is paid, `kimi/k` is of unknown cost. */
const guarded = (): WorkerDeps => ({ store, adapter: adapterOf(CATALOGUE, "plan/m"), onEvent: (event) => { events.push(event); } });
/** A backend no test may dispatch on. */
const idle = (): AgentAdapter => ({
  prompt: async () => { throw new Error("a seam replaced runTask; nothing may be dispatched"); },
  contextUsage: async () => 0, contextLimit: async () => 100,
});

beforeEach(async () => {
  resetGuardState();
  root = await mkdtemp(join(tmpdir(), "taskctl-guard-refusals-"));
  tasks = join(root, "tasks");
  work = join(root, "work");
  await mkdir(tasks);
  await mkdir(work);
  store = new TaskStore(tasks);
  events = [];
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("the board's record of a budget-guard refusal", () => {
  it("keeps one entry per task, with the time it was judged and the guard's line", async () => {
    const twoLines = `${PAID_LINE}\n- kimi/k  provider=kimi  enabled=true  variants=-  拒绝：成本未知（目录里没有它，或它不报成本）；未列入 allowedModels，provider 也不在 allowedProviders 里`;
    await recordGuardRefusal(tasks, "003-paid", PAID_LINE, new Date(AT));
    await recordGuardRefusal(tasks, "004-gone", PAID_LINE, new Date(AT));
    await recordGuardRefusal(tasks, "003-paid", twoLines, new Date(LATER));

    expect(await readGuardRefusals(tasks)).toEqual([
      { taskId: "003-paid", at: LATER, line: twoLines },
      { taskId: "004-gone", at: AT, line: PAID_LINE },
    ]);
    // Outside every task's directory: the guarantee a refusal is built on.
    expect(await readdir(tasks)).toEqual([]);
    expect(await readdir(join(root, ".taskctl"))).toEqual(["guard-refusals.json"]);
  });

  it("reads a missing, unparsable or malformed record as empty", async () => {
    expect(await readGuardRefusals(tasks)).toEqual([]);
    // Reading is not writing: no record, no `.taskctl`.
    expect(existsSync(join(root, ".taskctl"))).toBe(false);
    await mkdir(join(root, ".taskctl"), { recursive: true });
    const file = join(root, ".taskctl", "guard-refusals.json");
    await writeFile(file, "{ not json", "utf8");
    expect(await readGuardRefusals(tasks)).toEqual([]);
    const malformed: unknown[] = [
      { version: 1, refusals: { "003-paid": { taskId: "003-paid", at: 7, line: "x" } } },
      { version: 1, refusals: { "003-paid": { taskId: "another", at: AT, line: "x" } } },
      { version: 1, refusals: ["003-paid"] },
    ];
    for (const bad of malformed) {
      await writeFile(file, JSON.stringify(bad), "utf8");
      expect(await readGuardRefusals(tasks)).toEqual([]);
    }
  });

  it("removes one task's entry, and writes nothing while the board has no record", async () => {
    await clearGuardRefusal(tasks, "003-paid");
    await pruneGuardRefusals(tasks, [{ id: "003-paid", status: "blocked" }]);
    expect(existsSync(join(root, ".taskctl"))).toBe(false);

    await recordGuardRefusal(tasks, "003-paid", PAID_LINE, new Date(AT));
    await recordGuardRefusal(tasks, "004-gone", PAID_LINE, new Date(AT));
    await clearGuardRefusal(tasks, "003-paid");
    expect(await readGuardRefusals(tasks)).toEqual([{ taskId: "004-gone", at: AT, line: PAID_LINE }]);
    // An entry that is already gone costs no rewrite.
    const file = join(root, ".taskctl", "guard-refusals.json");
    const before = await readFile(file, "utf8");
    await clearGuardRefusal(tasks, "003-paid");
    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("drops the entries of tasks that are no longer open, and only those", async () => {
    await recordGuardRefusal(tasks, "003-paid", PAID_LINE, new Date(AT));
    await recordGuardRefusal(tasks, "004-gone", PAID_LINE, new Date(AT));
    await recordGuardRefusal(tasks, "005-removed", PAID_LINE, new Date(AT));

    await pruneGuardRefusals(tasks, [{ id: "003-paid", status: "open" }, { id: "004-gone", status: "blocked" }]);

    expect(await readGuardRefusals(tasks)).toEqual([{ taskId: "003-paid", at: AT, line: PAID_LINE }]);
  });

  it("never throws: a record that cannot be written or read changes nothing", async () => {
    await mkdir(join(root, ".taskctl", "guard-refusals.json"), { recursive: true }); // a directory where the file should be

    await expect(recordGuardRefusal(tasks, "003-paid", PAID_LINE)).resolves.toBeUndefined();
    await expect(clearGuardRefusal(tasks, "003-paid")).resolves.toBeUndefined();
    await expect(pruneGuardRefusals(tasks, [{ id: "003-paid", status: "open" }])).resolves.toBeUndefined();
    expect(await readGuardRefusals(tasks)).toEqual([]);
    // The temporary file of the write that failed is not left behind.
    expect((await readdir(join(root, ".taskctl"))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

describe("where the record is written and cleared", () => {
  it("is written when the guard refuses a task, and nothing is written into the task's directory", async () => {
    await seedTaskFile(tasks, buildTaskFile({ id: "003-paid", title: "paid", model: "zen/p" }));

    expect(await runTask(config(), guarded(), await store.get("003-paid"), "w")).toBe("refused");

    expect(await readGuardRefusals(tasks)).toEqual([{ taskId: "003-paid", at: expect.any(String), line: PAID_LINE }]);
    expect(events.filter((event) => event.type === "refused")).toHaveLength(1);
    expect(await readdir(tasks)).toEqual(["003-paid.md"]);
  });

  it("is written at the second judgement too, the one after the reservation", async () => {
    // The caller's snapshot names the free plan/m; the board holds the paid zen/p, edited onto it after the caller read it.
    await seedTaskFile(tasks, buildTaskFile({ id: "003-edited", title: "edited", model: "zen/p" }));
    const snapshot = { ...(await store.get("003-edited")), model: "plan/m" };

    expect(await runTask(config(), guarded(), snapshot, "w")).toBe("refused");

    expect((await readGuardRefusals(tasks)).map((entry) => entry.taskId)).toEqual(["003-edited"]);
  });

  it("is recorded at every judgement, with the later time, while the line is said once", async () => {
    await seedTaskFile(tasks, buildTaskFile({ id: "003-paid", title: "paid", model: "zen/p" }));

    await runTask(config(), guarded(), await store.get("003-paid"), "w");
    await recordGuardRefusal(tasks, "003-paid", PAID_LINE, new Date(AT)); // as an earlier process left it
    await runTask(config(), guarded(), await store.get("003-paid"), "w");

    expect(events.filter((event) => event.type === "refused")).toHaveLength(1);
    expect((await readGuardRefusals(tasks))[0]?.at).not.toBe(AT);
  });

  it("leaves when the task is next offered and not refused, before any turn runs", async () => {
    await seedTaskFile(tasks, buildTaskFile({ id: "003-paid", title: "paid", model: "zen/p" }));
    await runTask(config(), guarded(), await store.get("003-paid"), "w");
    expect(await readGuardRefusals(tasks)).toHaveLength(1);

    let atTheTurn: GuardRefusal[] | undefined;
    const asking: AgentAdapter = {
      ...adapterOf(CATALOGUE, "plan/m"),
      prompt: async () => { atTheTurn = await readGuardRefusals(tasks); throw new Error("no turn is needed for this test"); },
    };
    const outcome = await runTask(config({ allowedModels: ["zen/p"] }), { store, adapter: asking }, await store.get("003-paid"), "w");

    expect(outcome).toBe("blocked"); // the turn above failed; what matters is what the record said when it started
    expect(atTheTurn).toEqual([]);
    expect(await readGuardRefusals(tasks)).toEqual([]);
  });
});

describe("a controller settles the record against its board", () => {
  const cfg = (): WorkerConfig => workerConfigFixture({ tasksDir: tasks, workdir: work, lockTtlMs: 5_000, heartbeatMs: 20 });

  it("on every pass of `run`", async () => {
    await seedTaskFile(tasks, buildTaskFile({ id: "003-refused", title: "refused" }));
    await recordGuardRefusal(tasks, "003-refused", PAID_LINE, new Date(AT));

    // Still `open`: the entry stays.
    await runScheduler(cfg(), { store, adapter: idle(), acceptance: passAcceptance }, { run: async () => "refused" });
    expect((await readGuardRefusals(tasks)).map((entry) => entry.taskId)).toEqual(["003-refused"]);

    await store.setStatus("003-refused", "blocked");
    await runScheduler(cfg(), { store, adapter: idle(), acceptance: passAcceptance }, { run: async () => "refused" });

    expect(await readGuardRefusals(tasks)).toEqual([]);
  });

  it("at every scheduling boundary of `watch`", async () => {
    await seedTaskFile(tasks, buildTaskFile({ id: "003-refused", title: "refused", status: "blocked" }));
    await recordGuardRefusal(tasks, "003-refused", PAID_LINE, new Date(AT));
    const { listeners, watchFs } = createWatchEventSeam();
    const stop = createStopRequests(tasks, listeners);
    const running = watchQueue(cfg(), { store, adapter: idle(), acceptance: passAcceptance }, { watchFs, fallbackMs: 10, debounceMs: 5 });

    await waitForConditionAsync(async () => (await readGuardRefusals(tasks)).length === 0);
    await stop.request();

    expect(await running).toEqual({ reason: "stop" });
  });

  it("before an explicit batch is claimed", async () => {
    await seedTaskFile(tasks, buildContinuousTask("a"), buildContinuousTask("b"));
    await recordGuardRefusal(tasks, "a", PAID_LINE, new Date(AT));
    await recordGuardRefusal(tasks, "003-gone", PAID_LINE, new Date(AT));
    const batch = { ...config(), lockTtlMs: 5_000, heartbeatMs: 50 };

    expect((await validateBatchSelection(batch, ["a", "b"], await store.list())).map((task) => task.id)).toEqual(["a", "b"]);

    expect((await readGuardRefusals(tasks)).map((entry) => entry.taskId)).toEqual(["a"]);
  });
});
