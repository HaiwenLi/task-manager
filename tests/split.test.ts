import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter } from "../src/adapters/types.js";
import { definitionDigest } from "../src/runtime.js";
import { runScheduler, ready } from "../src/scheduler.js";
import { parseTaskFile, serializeTaskFile } from "../src/task-file.js";
import { TaskStore } from "../src/task-store.js";
import { runTask, type WorkerConfig } from "../src/worker.js";
import { buildTaskFile } from "./helpers/task-fixture.js";

let root: string;
let tasks: string;
let work: string;
let store: TaskStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "taskctl-split-"));
  tasks = join(root, "tasks");
  work = join(root, "work");
  await mkdir(tasks);
  await mkdir(work);
  store = new TaskStore(tasks);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Every prompt the worker was given, in order: what ran is what was asked. */
function recordingAdapter(prompts: string[]): AgentAdapter {
  return {
    prompt: async (args) => {
      prompts.push(args.text);
      return { sessionId: `s-${prompts.length}`, text: "done", exitCode: 0 };
    },
    contextUsage: async () => 0,
    contextLimit: async () => 100,
  };
}

const failGate = async () => ({ passed: false, skipped: false as const, exitCode: 1, output: "no" });

function config(): WorkerConfig {
  return {
    tasksDir: tasks, workdir: work, agent: "fixture", contextThreshold: 0.8,
    retryLimit: 1, lockTtlMs: 20_000, heartbeatMs: 1_000, maxTurnsPerSession: 1,
  };
}

/** The `# 任务：` line of a worker prompt, i.e. which task it was for. */
function asked(prompts: string[]): string[] {
  return prompts.map((text) => /^# 任务：(.*)$/m.exec(text)?.[1] ?? "?");
}

async function seedTask(id: string, status: string, extra: string[] = []): Promise<void> {
  await writeFile(join(tasks, `${id}.md`), [
    "---", "schema: taskctl/v1", `title: ${id}`, `status: ${status}`, 'acceptance: "check"',
    "criteria:", "  - C1 ok", ...extra, "sessions: []", "retries: 0", "---", "work", "",
  ].join("\n"), "utf8");
}

describe("parent links", () => {
  const child = (parent: string): string => [
    "---", "schema: taskctl/v1", "title: child", "status: open", "criteria: []", "sessions: []", "retries: 0",
    `parent_id: ${parent}`, "---", "body", "",
  ].join("\n");

  it("round-trips parent_id and makes it part of the definition", () => {
    const task = parseTaskFile(child("003-feature"), "004-feature-api");
    expect(task.parentId).toBe("003-feature");
    expect(serializeTaskFile(task)).toContain("parent_id: 003-feature");
    expect(definitionDigest(task)).not.toBe(definitionDigest(parseTaskFile(child("009-other"), "004-feature-api")));
    expect(parseTaskFile(child("003-feature").replace("parent_id: 003-feature\n", ""), "004-feature-api").parentId).toBeUndefined();
  });

  it("refuses a task that names itself as parent", () => {
    expect(() => parseTaskFile(child("004-feature-api"), "004-feature-api")).toThrow(/parent_id/);
  });
});

describe("bundle-approval gating", () => {
  it("keeps a child out of the scheduler's ready set, so it is never even offered", () => {
    // The claim path refuses a gated child too. That is a second line, not a
    // reason to leave the scheduler's own filter unpinned.
    // Linked as a real split parent is: it waits for the child it integrates.
    const parent = buildTaskFile({ id: "003-feature", status: "draft", dependsOn: ["004-feature-api"] });
    const child = buildTaskFile({ id: "004-feature-api", status: "open", parentId: "003-feature" });
    const loose = buildTaskFile({ id: "005-loose", status: "open" });
    const waiting = buildTaskFile({ id: "006-later", status: "open", dependsOn: ["004-feature-api"] });
    const board = [parent, child, loose, waiting];

    expect(ready(board, new Set()).map((task) => task.id)).toEqual(["005-loose"]);

    parent.status = "open";
    // Approved: the child is released, the parent still waits on it.
    expect(ready(board, new Set()).map((task) => task.id)).toEqual(["004-feature-api", "005-loose"]);
    // Child done: the parent may integrate, and so may anything that waited on the child.
    expect(ready(board, new Set(["004-feature-api"])).map((task) => task.id))
      .toEqual(["003-feature", "004-feature-api", "005-loose", "006-later"]);
  });

  it("does not start an open child while its parent is a draft, even without a dependency on it", async () => {
    await seedTask("003-feature", "draft", ["depends_on:", "  - 004-feature-api"]);
    await seedTask("004-feature-api", "open", ["parent_id: 003-feature"]);
    const prompts: string[] = [];
    await runScheduler(config(), { store, adapter: recordingAdapter(prompts), acceptance: failGate });

    expect(prompts).toEqual([]);
    expect((await store.get("004-feature-api")).status).toBe("open");
  });

  it("starts the child once the parent is approved, and only then the parent", async () => {
    await seedTask("003-feature", "open", ["depends_on:", "  - 004-feature-api"]);
    await seedTask("004-feature-api", "open", ["parent_id: 003-feature"]);
    const prompts: string[] = [];
    await runScheduler(config(), { store, adapter: recordingAdapter(prompts), acceptance: failGate });

    // The child ran (and blocked at the one-turn cap); the parent is still waiting on it.
    expect(asked(prompts)).toEqual(["004-feature-api"]);
    expect((await store.get("003-feature")).status).toBe("open");
  });

  it("gates on the nearest draft ancestor, not only the direct parent", async () => {
    await seedTask("001-root", "draft");
    await seedTask("002-middle", "open", ["parent_id: 001-root"]);
    await seedTask("003-leaf", "open", ["parent_id: 002-middle"]);
    const prompts: string[] = [];
    await runScheduler(config(), { store, adapter: recordingAdapter(prompts), acceptance: failGate });
    expect(prompts).toEqual([]);
  });

  it("refuses to claim a gated child even when called directly, and leaves no attempt behind", async () => {
    await seedTask("003-feature", "draft");
    await seedTask("004-feature-api", "open", ["parent_id: 003-feature"]);
    const prompts: string[] = [];
    const outcome = await runTask(config(), { store, adapter: recordingAdapter(prompts), acceptance: failGate }, await store.get("004-feature-api"), "w1");

    expect(outcome).toBe("skipped");
    expect(prompts).toEqual([]);
    await expect(readFile(join(tasks, "004-feature-api", "attempt.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect((await store.get("004-feature-api")).status).toBe("open");
  });

  it("refuses to claim directly a task whose dependency is not done, and claims it once it is", async () => {
    await seedTask("001-first", "blocked");
    await seedTask("002-second", "open", ["depends_on:", "  - 001-first"]);
    const prompts: string[] = [];
    const deps = { store, adapter: recordingAdapter(prompts), acceptance: failGate };

    expect(await runTask(config(), deps, await store.get("002-second"), "w1")).toBe("skipped");
    expect(prompts).toEqual([]);

    // Marking the dependency done by hand is the operator's call; taskctl then runs.
    await store.setStatus("001-first", "done");
    await store.setStatus("002-second", "open");
    expect(await runTask(config(), deps, await store.get("002-second"), "w2")).toBe("blocked");
    expect(asked(prompts)).toEqual(["002-second"]);
  });

  it("rejects an unknown or cyclic parent link before running anything", async () => {
    const prompts: string[] = [];
    const deps = { store, adapter: recordingAdapter(prompts), acceptance: failGate };

    await seedTask("004-orphan", "open", ["parent_id: 999-ghost"]);
    await expect(runScheduler(config(), deps)).rejects.toThrow(/parent_id/);

    await writeFile(join(tasks, "004-orphan.md"), (await readFile(join(tasks, "004-orphan.md"), "utf8")).replace("999-ghost", "005-peer"), "utf8");
    await seedTask("005-peer", "open", ["parent_id: 004-orphan"]);
    await expect(runScheduler(config(), deps)).rejects.toThrow(/cycle/);
    expect(prompts).toEqual([]);
  });
});
