import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../src/render.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/render.js")>();
  return { ...actual, checkRender: vi.fn() };
});

vi.mock("../src/runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/runtime.js")>();
  return {
    ...actual,
    writeRuntime: async (tasksDir: string, id: string, name: string, record: unknown) => {
      const written = await actual.writeRuntime(tasksDir, id, name, record);
      // The one pass-through seam this suite needs: a stop that lands after the
      // render check returned and before its judgement has no adapter seam to
      // fire from, so the record's own write asks for it.
      if (name === "render.json") stopWhenRenderRecorded?.();
      return written;
    },
  };
});

let stopWhenRenderRecorded: (() => void) | undefined;

import { checkRender, type RenderCheck } from "../src/render.js";
import { readAttempt, readRuntime } from "../src/runtime.js";
import { readJournal } from "../src/journal.js";
import { latestNote } from "../src/handoff.js";
import { runTask, type WorkerConfig, type WorkerEvent } from "../src/worker.js";
import { TaskStore } from "../src/task-store.js";
import { serializeTaskFile } from "../src/task-file.js";
import { buildTaskFile } from "./helpers/task-fixture.js";
import { manualStopNow } from "./helpers/stop-fixture.js";
import { markDoneTask } from "./helpers/watch-fixture.js";

let root: string;
let tasks: string;
let work: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "taskctl-render-escalation-"));
  tasks = join(root, "tasks");
  work = join(root, "work");
  await mkdir(tasks);
  await mkdir(work);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe("escalated render verification", () => {
  it("enters independent review instead of stranding the task in running", async () => {
    const task = buildTaskFile({
      id: "a", status: "open", verify: "render", renderTargets: ["index.html"],
      criteria: ["C1 page works"], execution: "continuous", complexity: "simple",
    });
    await writeFile(join(tasks, "a.md"), serializeTaskFile(task), "utf8");
    await writeFile(join(work, "index.html"), "<h1>ok</h1>", "utf8");
    vi.mocked(checkRender).mockResolvedValue({
      ok: true, browser: "fake", at: new Date().toISOString(),
      views: [{ target: join(work, "index.html"), viewport: "1440x900", ok: true, problems: [], screenshot: "shot.png", measurements: { scrollWidth: 100, clientWidth: 100, textLength: 2, images: 0, brokenImages: 0 } }],
    });
    const store = new TaskStore(tasks);
    const review = vi.fn(async () => ({
      verdict: "pass" as const,
      criteria: [{ id: "C1", pass: true, evidence: "render evidence exists" }],
      externalChanges: [], defects: [], summary: "ok",
    }));
    const cfg: WorkerConfig = {
      tasksDir: tasks, workdir: work, agent: "fixture", contextThreshold: 0.8,
      retryLimit: 1, lockTtlMs: 5_000, heartbeatMs: 50,
    };

    const outcome = await runTask(cfg, {
      store,
      adapter: {
        prompt: async () => {
          await mkdir(join(tasks, "a"), { recursive: true });
          await writeFile(join(tasks, "a", "done.requested"), "done");
          return { sessionId: "s", exitCode: 0, text: "ESCALATE: visual evidence is not enough" };
        },
        contextUsage: async () => 0,
        contextLimit: async () => 100,
      },
      review,
    }, task, "w1");

    expect(outcome).toBe("done");
    expect(review).toHaveBeenCalledTimes(1);
    expect((await store.get("a")).status).toBe("done");
  });
});

it("a stop during the render check waits for the check, judges nothing, and returns the task to open", async () => {
  const task = buildTaskFile({ id: "a", status: "open", verify: "render", renderTargets: ["index.html"], criteria: ["C1 page works"], execution: "continuous", complexity: "simple" });
  await writeFile(join(tasks, "a.md"), serializeTaskFile(task), "utf8");
  let finish!: (check: RenderCheck) => void;
  let checkEnded = false;
  vi.mocked(checkRender).mockReturnValue(new Promise<RenderCheck>((resolve) => {
    finish = (check) => { checkEnded = true; resolve(check); };
  }));
  const store = new TaskStore(tasks);
  const cfg: WorkerConfig = { tasksDir: tasks, workdir: work, agent: "fixture", contextThreshold: 0.8, retryLimit: 1, lockTtlMs: 5_000, heartbeatMs: 50 };
  const stop = manualStopNow();
  const events: WorkerEvent[] = [];
  const outcome = runTask(cfg, {
    store, stop, onEvent: (event) => events.push(event),
    adapter: { prompt: async (args) => { await markDoneTask(args.text, tasks); return { sessionId: "s", exitCode: 0, text: "done" }; }, contextUsage: async () => 0, contextLimit: async () => 100 },
  }, await store.get("a"), "w1");
  try {
    await vi.waitFor(() => expect(checkRender).toHaveBeenCalledOnce());
    stop.trigger("file");
    // The wait is visible at once …
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: "stop-requested", taskId: "a" })));
    // … and the check is not abandoned: the attempt is still open until the check ends.
    expect(await Promise.race([outcome.then(() => "settled"), new Promise((resolve) => setTimeout(() => resolve("still running"), 150))])).toBe("still running");
  } finally {
    // The attempt only settles once the check ends, so end it here too: a
    // failure above would otherwise leave the attempt (and its heartbeat)
    // running over a directory the afterEach is about to remove.
    finish?.({ ok: false, browser: "fake", at: new Date().toISOString(),
      views: [{ target: join(work, "index.html"), viewport: "1440x900", ok: false, problems: ["blank"], screenshot: "shot.png", measurements: { scrollWidth: 100, clientWidth: 100, textLength: 0, images: 0, brokenImages: 0 } }] });
    expect(checkEnded).toBe(true);
    await Promise.race([outcome.catch(() => {}), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  }
  expect(await outcome).toBe("stopped");
  expect(await store.get("a")).toMatchObject({ status: "open", retries: 0 });
  expect(await readRuntime(tasks, "a", "render.json")).toBeNull();
  expect(await readAttempt(tasks, "a")).toMatchObject({ phase: "settled", operation: "render check", reason: "stopped by operator" });
}, 10_000);

it("a stop after the render check returned judges nothing: no retry is spent on the verdict", async () => {
  const task = buildTaskFile({ id: "a", status: "open", verify: "render", renderTargets: ["index.html"], criteria: ["C1 page works"], execution: "continuous", complexity: "simple" });
  await writeFile(join(tasks, "a.md"), serializeTaskFile(task), "utf8");
  vi.mocked(checkRender).mockResolvedValue({ ok: false, browser: "fake", at: new Date().toISOString(),
    views: [{ target: join(work, "index.html"), viewport: "1440x900", ok: false, problems: ["blank"], screenshot: "shot.png", measurements: { scrollWidth: 100, clientWidth: 100, textLength: 0, images: 0, brokenImages: 0 } }] });
  const store = new TaskStore(tasks);
  const cfg: WorkerConfig = { tasksDir: tasks, workdir: work, agent: "fixture", contextThreshold: 0.8, retryLimit: 1, lockTtlMs: 5_000, heartbeatMs: 50 };
  const stop = manualStopNow();
  // The guard under test sits between the record's write and the judgement,
  // where no adapter seam fires: the record's own write asks for the stop.
  stopWhenRenderRecorded = () => stop.trigger("file");
  const outcome = runTask(cfg, {
    store, stop,
    adapter: { prompt: async (args) => { await markDoneTask(args.text, tasks); return { sessionId: "s", exitCode: 0, text: "done" }; }, contextUsage: async () => 0, contextLimit: async () => 100 },
  }, await store.get("a"), "w1");
  expect(await outcome).toBe("stopped");
  expect(await store.get("a")).toMatchObject({ status: "open", retries: 0, reviewRounds: 0 });
  // The check's own record stands; nothing was judged on it: no retry spent on
  // the failed verdict, no rework note, no review round.
  expect(await readRuntime(tasks, "a", "render.json")).toMatchObject({ ok: false });
  expect(await readAttempt(tasks, "a")).toMatchObject({ phase: "settled", operation: "render check", reason: "stopped by operator" });
  expect((await readJournal(tasks, "a")).map((line) => line.event)).not.toContain("rework");
  expect(await latestNote(tasks, "a")).toBeNull();
}, 10_000);
