import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter } from "../src/adapters/types.js";
import type { AcceptanceResult } from "../src/acceptance.js";
import { runCli } from "../src/cli.js";
import { McpClientError } from "../src/mcp-client.js";
import type { MemoryBackend, MemoryHit } from "../src/memory.js";
import { writeSpec } from "../src/spec.js";
import { serializeTaskFile, type Task } from "../src/task-file.js";

type PromptArgs = Parameters<AgentAdapter["prompt"]>[0];
type PromptResult = Awaited<ReturnType<AgentAdapter["prompt"]>>;

/** 记录型 fake adapter：每次 prompt 都记录，应答固定。 */
class FakeAdapter implements AgentAdapter {
  readonly calls: PromptArgs[] = [];

  async prompt(args: PromptArgs): Promise<PromptResult> {
    this.calls.push(args);
    return { sessionId: "ses-fake", exitCode: 0, text: "" };
  }

  async contextUsage(_sessionId: string): Promise<number> {
    return 0;
  }

  async contextLimit(_model: string): Promise<number> {
    return 1_000_000;
  }
}

/** 行为等同真 agent：回合结束后落 done.requested marker（模拟跑 taskctl done）。 */
class DoneMarkingAdapter extends FakeAdapter {
  constructor(private readonly markerTasksDir: string) {
    super();
  }

  async prompt(args: PromptArgs): Promise<PromptResult> {
    const result = await super.prompt(args);
    await writeFile(join(this.markerTasksDir, "a", "done.requested"), new Date().toISOString(), "utf8");
    return result;
  }
}

/** Fixture reviewer: every task passes review. */
const passReview = async () => ({
  verdict: "pass" as const,
  criteria: [{ id: "C1", pass: true, evidence: "fixture" }],
  externalChanges: [],
  defects: [],
  summary: "ok",
});

/** Fixture acceptance: every command passes. */
const passGate = async (): Promise<AcceptanceResult> => ({ passed: true, exitCode: 0, output: "", skipped: false });

/** 捕获 CLI 输出的注入 seam（status 测试另按 brief 用 console spy）。 */
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

/** Every file under `dir`, recursively, as paths relative to it: what a command did or did not write. */
async function filesUnder(dir: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(join(dir, entry.name), relative));
    else files.push(relative);
  }
  return files;
}

/** One lesson as a backend reports it. */
const hit = (drawerId: string, text: string, similarity = 0.9): MemoryHit => ({ drawerId, wing: "w", room: "pitfall", similarity, text });

/** A backend that answers `groups` whatever it is asked, and notes each call. */
function fakeBackend(groups: MemoryHit[][]) {
  const calls: Array<{ requests: readonly { query: string; wing?: string }[]; opts: { limit: number } }> = [];
  const backend: MemoryBackend = {
    name: "fake",
    searchAll: async (requests, opts) => {
      calls.push({ requests, opts });
      return groups;
    },
  };
  return { backend, calls };
}

let root: string;
let tasks: string;
/** `taskctl.json` with memory on. */
let config: string;
/** `taskctl.json` with no memory block at all. */
let configWithoutMemory: string;
/** `taskctl.json` with a memory block that leaves the backend at its default. */
let configMemoryOff: string;

/**
 * A `taskctl.json` under `root`, pointing at the tasks dir. The memory
 * block's command names a file that exists nowhere: `recall` is given its
 * backend through the seam in these tests, and one that ever built its own
 * could not reach a real server from here.
 */
async function writeConfig(name: string, memory: Record<string, unknown> | undefined): Promise<string> {
  const path = join(root, name);
  const config: Record<string, unknown> = { tasksDir: tasks, workdir: join(root, "workspace") };
  if (memory !== undefined) config.memory = { command: [join(root, "no-such-memory-server", "mempalace-mcp.exe")], ...memory };
  await writeFile(path, JSON.stringify(config), "utf8");
  return path;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "taskctl-cli-recall-"));
  tasks = join(root, "tasks");
  await mkdir(tasks, { recursive: true });
  await mkdir(join(root, "workspace"), { recursive: true });
  // Task "a" with a spec: a query is built from the task's own words and from the spec's goal.
  const task: Task = {
    id: "a",
    title: "整理表格",
    description: "把三份报表合成一张表",
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
  await writeFile(join(tasks, "a.md"), serializeTaskFile(task), "utf8");
  await writeSpec(tasks, "a", "## 目标\nGOAL LINE\n\n## 非目标\nNOT IN THE QUERY\n");
  config = await writeConfig("on.json", { backend: "mempalace" });
  configMemoryOff = await writeConfig("off.json", { wing: "IDT" });
  configWithoutMemory = await writeConfig("none.json", undefined);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** The files under `root` that a recall must never leave behind. */
const recallFiles = async () => (await filesUnder(root)).filter((file) => file.endsWith("recall.json"));

describe("taskctl recall", () => {
  it("recall --query prints the hits and the section without writing anything", async () => {
    const cap = capture();
    const { backend, calls } = fakeBackend([[hit("d1", "RECALLED LESSON")]]);
    const before = await filesUnder(root);

    const code = await runCli(["recall", "--query", "ark key 401", "--config", config], { memory: backend, ...cap.deps });

    expect(code).toBe(0);
    // The query, what came of it, then the hits as the worker prompt shows them.
    expect(cap.lines).toEqual([
      "query: ark key 401",
      "backend: fake, outcome: ok, hits: 1, below=0 room=0 wing=0",
      "- [w/pitfall · -] RECALLED LESSON",
    ]);
    expect(cap.errors).toEqual([]);
    // The query as written is what was searched with, once, under the resolved settings.
    expect(calls).toEqual([{ requests: [{ query: "ark key 401" }], opts: { limit: 20 } }]);
    // Nothing on disk moved: no recall.json, no journal, nothing else.
    expect(await filesUnder(root)).toEqual(before);
  });

  it("recall --task builds the query from the task and its spec", async () => {
    const cap = capture();
    const { backend, calls } = fakeBackend([[hit("d1", "RECALLED LESSON")]]);
    const before = await filesUnder(root);

    const code = await runCli(["recall", "--task", "a", "--config", config], { memory: backend, ...cap.deps });

    expect(code).toBe(0);
    // The title, the body, then the spec's goal; nothing from under the next heading.
    expect(cap.lines[0]).toBe("query: 整理表格 把三份报表合成一张表 GOAL LINE");
    expect(calls).toEqual([{ requests: [{ query: "整理表格 把三份报表合成一张表 GOAL LINE" }], opts: { limit: 20 } }]);
    expect(await recallFiles()).toEqual([]);
    expect(await filesUnder(root)).toEqual(before);
  });

  it("recall counts what it dropped and says when it truncated", async () => {
    const cap = capture();
    // One hit too long to show whole, and one below the cut-off.
    const { backend } = fakeBackend([[hit("d1", "x".repeat(450)), hit("d2", "TOO FAR", 0.3)]]);

    const code = await runCli(["recall", "--query", "q", "--config", config], { memory: backend, ...cap.deps });

    expect(code).toBe(0);
    expect(cap.lines).toEqual([
      "query: q",
      "backend: fake, outcome: ok, hits: 1, below=1 room=0 wing=0, truncated",
      `- [w/pitfall · -] ${"x".repeat(400)}…`,
    ]);
  });

  it("recall exits 0 when nothing was kept", async () => {
    const cap = capture();
    const { backend } = fakeBackend([[hit("d1", "TOO FAR", 0.3)]]);

    const code = await runCli(["recall", "--query", "q", "--config", config], { memory: backend, ...cap.deps });

    expect(code).toBe(0);
    expect(cap.lines).toEqual(["query: q", "backend: fake, outcome: no-hits, hits: 0, below=1 room=0 wing=0"]);
    expect(cap.errors).toEqual([]);
  });

  it("recall exits 1 when the backend fails", async () => {
    const cap = capture();
    const failing: MemoryBackend = { name: "fake", searchAll: async () => { throw new Error("palace offline"); } };

    const code = await runCli(["recall", "--query", "q", "--config", config], { memory: failing, ...cap.deps });

    expect(code).toBe(1);
    expect(cap.lines).toEqual(["query: q", "backend: fake, outcome: error, hits: 0, below=0 room=0 wing=0"]);
    expect(cap.errors).toEqual(["recall unavailable: error: palace offline"]);
    expect(await recallFiles()).toEqual([]);
  });

  it("recall exits 1 when the backend timed out", async () => {
    const cap = capture();
    const slow: MemoryBackend = { name: "fake", searchAll: async () => { throw new McpClientError("mcp: timed out after 20000 ms", "timeout"); } };

    const code = await runCli(["recall", "--query", "q", "--config", config], { memory: slow, ...cap.deps });

    expect(code).toBe(1);
    expect(cap.lines).toEqual(["query: q", "backend: fake, outcome: timeout, hits: 0, below=0 room=0 wing=0"]);
    expect(cap.errors).toEqual(["recall unavailable: timeout: mcp: timed out after 20000 ms"]);
  });

  it("recall says so and exits 0 when memory is off, with no memory block", async () => {
    const cap = capture();
    // A backend is on the seam anyway: memory being off is what keeps it from being asked.
    const { backend, calls } = fakeBackend([[hit("d1", "RECALLED LESSON")]]);

    const code = await runCli(["recall", "--query", "q", "--config", configWithoutMemory], { memory: backend, ...cap.deps });

    expect(code).toBe(0);
    expect(cap.lines).toEqual(['memory backend is "none"; nothing to recall']);
    expect(cap.errors).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("recall says so and exits 0 when memory is off, with a block that names no backend", async () => {
    const cap = capture();
    const { backend, calls } = fakeBackend([[hit("d1", "RECALLED LESSON")]]);

    const code = await runCli(["recall", "--query", "q", "--config", configMemoryOff], { memory: backend, ...cap.deps });

    expect(code).toBe(0);
    expect(cap.lines).toEqual(['memory backend is "none"; nothing to recall']);
    expect(cap.errors).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("recall needs exactly one of --task and --query", async () => {
    const neither = capture();

    expect(await runCli(["recall", "--config", config], neither.deps)).toBe(2);

    const both = capture();
    const { backend, calls } = fakeBackend([[hit("d1", "RECALLED LESSON")]]);

    expect(await runCli(["recall", "--task", "a", "--query", "q", "--config", config], { memory: backend, ...both.deps })).toBe(2);

    for (const cap of [neither, both]) {
      expect(cap.lines).toEqual([]);
      expect(cap.errors[0]).toMatch(/^taskctl: recall .*--task.*--query/);
      // A usage error prints the usage, which says how the command is spelled.
      expect(cap.errors.join("\n")).toContain("taskctl recall (--task <id> | --query <text>) [--config taskctl.json]");
    }
    // A usage error is answered before anything is asked or written.
    expect(calls).toHaveLength(0);
    expect(await recallFiles()).toEqual([]);
  });

  it("recall takes no --tasks-dir: the tasks dir comes from the config", async () => {
    const cap = capture();

    expect(await runCli(["recall", "--query", "q", "--tasks-dir", tasks, "--config", config], cap.deps)).toBe(2);

    expect(cap.lines).toEqual([]);
    expect(cap.errors.join("\n")).toContain("unknown option --tasks-dir for command recall");
  });

  it("recall refuses a --query with no text in it", async () => {
    const cap = capture();
    const { backend, calls } = fakeBackend([[hit("d1", "RECALLED LESSON")]]);

    expect(await runCli(["recall", "--query", "  ", "--config", config], { memory: backend, ...cap.deps })).toBe(2);

    expect(calls).toHaveLength(0);
    expect(cap.errors[0]).toBe("taskctl: recall needs text after --query");
    expect(await recallFiles()).toEqual([]);
  });

  it("run hands the worker the backend it was given, so the prompt carries the lesson", async () => {
    // `run` shares the seam with `recall`: what the CLI is given is what the worker attempt asks.
    const cap = capture();
    const adapter = new DoneMarkingAdapter(tasks);
    const { backend, calls } = fakeBackend([[hit("d1", "RECALLED LESSON")]]);

    const code = await runCli(["run", "--config", config], {
      adapter, acceptance: passGate, review: passReview, memory: backend, ...cap.deps,
    });

    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(adapter.calls[0]?.text).toContain("## 相关记忆");
    expect(adapter.calls[0]?.text).toContain("RECALLED LESSON");
    expect(JSON.parse(await readFile(join(tasks, "a", "recall.json"), "utf8"))).toMatchObject({
      backend: "fake", outcome: "ok", hits: [{ drawerId: "d1" }],
    });
  });
});
