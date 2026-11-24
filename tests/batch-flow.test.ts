import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter } from "../src/adapters/types.js";
import { runCli } from "../src/cli.js";
import { readRuntime } from "../src/runtime.js";
import { serializeTaskFile, type Task } from "../src/task-file.js";
import { TaskStore } from "../src/task-store.js";
import { buildContinuousTask as task } from "./helpers/task-fixture.js";

let root: string;
let tasks: string;
let work: string;
let store: TaskStore;
let configPath: string;
let turns: string[];
let errors: string[];

async function seed(definition: Task): Promise<void> {
  await writeFile(join(tasks, `${definition.id}.md`), serializeTaskFile(definition), "utf8");
}

function adapter(onTurn?: (id: string) => Promise<void>): AgentAdapter {
  return {
    prompt: async (args) => {
      const id = /taskctl done --task (\S+) --tasks-dir/.exec(args.text)![1]!;
      turns.push(id);
      await mkdir(join(tasks, id), { recursive: true });
      await writeFile(join(tasks, id, "done.requested"), "done");
      await onTurn?.(id);
      return { sessionId: `s-${id}`, exitCode: 0, text: "done" };
    },
    contextUsage: async () => 0,
    contextLimit: async () => 100,
  };
}

const acceptance = async () => ({ passed: true, skipped: false as const, exitCode: 0, output: "ok" });

async function cli(args: string[], agent: AgentAdapter): Promise<number> {
  return runCli(args, {
    adapter: agent,
    acceptance,
    log: () => {},
    err: (line) => { errors.push(line); },
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "taskctl-batch-flow-"));
  tasks = join(root, "tasks");
  work = join(root, "work");
  await mkdir(tasks);
  await mkdir(work);
  store = new TaskStore(tasks);
  configPath = join(root, "taskctl.json");
  await writeFile(configPath, JSON.stringify({
    tasksDir: tasks,
    workdir: work,
    model: "w/one",
    retryLimit: 1,
    lockTtlMs: 20_000,
    heartbeatMs: 1_000,
  }), "utf8");
  turns = [];
  errors = [];
  await seed(task("a"));
  await seed(task("b"));
  await seed(task("c"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("taskctl run --batch", () => {
  it("runs two tasks with independent acceptance records and leaves an unselected task open", async () => {
    const code = await cli(["run", "--batch", "a,b", "--config", configPath], adapter());

    expect(code).toBe(0);
    expect(turns).toEqual(["a", "b"]);
    expect((await store.get("a")).status).toBe("done");
    expect((await store.get("b")).status).toBe("done");
    expect((await store.get("c")).status).toBe("open");
    expect(await readRuntime(tasks, "a", "acceptance.json")).not.toBeNull();
    expect(await readRuntime(tasks, "b", "acceptance.json")).not.toBeNull();
    expect(await readRuntime(tasks, "c", "acceptance.json")).toBeNull();
  });

  it("rejects the whole selection before spending a worker turn", async () => {
    await seed(task("b", { execution: "iterative" }));

    const code = await cli(["run", "--batch", "a,b", "--config", configPath], adapter());

    expect(code).toBe(1);
    expect(turns).toEqual([]);
    expect(errors.join("\n")).toContain("continuous");
    expect((await store.get("a")).status).toBe("open");
    expect((await store.get("b")).status).toBe("open");
  });

  it("rejects an initially mixed-workdir selection before spending a worker turn", async () => {
    await seed(task("b", { workdir: "elsewhere" }));

    const code = await cli(["run", "--batch", "a,b", "--config", configPath], adapter());

    expect(code).toBe(1);
    expect(turns).toEqual([]);
    expect(errors.join("\n")).toContain("workdir");
    expect((await store.get("a")).status).toBe("open");
    expect((await store.get("b")).status).toBe("open");
  });

  it("rejects a mid-batch workdir change before claiming the mismatched task", async () => {
    const agent = adapter(async (id) => {
      if (id !== "a") return;
      await seed(task("b", { workdir: "elsewhere" }));
    });

    const code = await cli(["run", "--batch", "a,b,c", "--config", configPath], agent);

    expect(code).toBe(1);
    expect(turns).toEqual(["a"]);
    expect(errors.join("\n")).toContain("workdir");
    expect((await store.get("a")).status).toBe("done");
    expect((await store.get("b")).status).toBe("open");
    expect((await store.get("c")).status).toBe("open");
    expect(await readRuntime(tasks, "b", "acceptance.json")).toBeNull();
  });

  it("does not fall through to the ordinary scheduler after the selection finishes", async () => {
    const code = await cli(["run", "--batch", "a", "--config", configPath], adapter());

    expect(code).toBe(0);
    expect(turns).toEqual(["a"]);
    expect((await store.get("a")).status).toBe("done");
    expect((await store.get("b")).status).toBe("open");
    expect((await store.get("c")).status).toBe("open");
  });
});
