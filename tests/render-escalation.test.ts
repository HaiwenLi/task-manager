import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../src/render.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/render.js")>();
  return { ...actual, checkRender: vi.fn() };
});

import { checkRender } from "../src/render.js";
import { runTask, type WorkerConfig } from "../src/worker.js";
import { TaskStore } from "../src/task-store.js";
import { serializeTaskFile } from "../src/task-file.js";
import { buildTaskFile } from "./helpers/task-fixture.js";

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
