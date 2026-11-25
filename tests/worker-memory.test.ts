import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter } from "../src/adapters/types.js";
import type { AcceptanceResult } from "../src/acceptance.js";
import { readJournal } from "../src/journal.js";
import type { MemoryBackend, MemoryHit, MemorySettings } from "../src/memory.js";
import { MEMORY_NOTE } from "../src/protocol.js";
import { writeSpec } from "../src/spec.js";
import type { Task, TaskStatus } from "../src/task-file.js";
import { runTask, type WorkerConfig, type WorkerDeps } from "../src/worker.js";

type PromptArgs = Parameters<AgentAdapter["prompt"]>[0];
type PromptResult = Awaited<ReturnType<AgentAdapter["prompt"]>>;

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

/** Fixture reviewer: every task passes review unless a test overrides it. */
const passReview = async () => ({
  verdict: "pass" as const,
  criteria: [{ id: "C1", pass: true, evidence: "fixture" }],
  externalChanges: [],
  defects: [],
  summary: "ok",
});

function task(): Task {
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

function cfg(tasksDir: string, overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    tasksDir,
    workdir: join(tasksDir, "workspace"),
    agent: "opencode",
    model: "test/default",
    contextThreshold: 0.8,
    retryLimit: 3,
    lockTtlMs: 600_000,
    heartbeatMs: 60_000,
    ...overrides,
  };
}

const passGate = async (): Promise<AcceptanceResult> => ({ passed: true, exitCode: 0, output: "", skipped: false });

/**
 * The `memory` block as `resolveConfig` fills it in once a backend is named:
 * every setting present. The command names a file that exists nowhere under
 * `dir`, so an attempt that built its own backend instead of taking the seam
 * asks a question that fails to start; it can never reach a real server.
 */
function memoryOn(dir: string): MemorySettings {
  return {
    backend: "mempalace",
    command: [join(dir, "no-such-memory-server", "mempalace-mcp.exe")],
    excludeWings: [],
    rooms: ["pitfall", "pattern", "decision"],
    minSimilarity: 0.55,
    maxItems: 5,
    maxChars: 2_000,
    itemChars: 400,
    timeoutMs: 20_000,
  };
}

/** One lesson as a backend reports it. */
const hit = (drawerId: string, text: string, similarity = 0.9): MemoryHit => ({ drawerId, wing: "w", room: "pitfall", similarity, text });

/**
 * A backend that answers `groups` whatever it is asked, and notes each call,
 * so a test can say how often and with what it was asked.
 */
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
let tasksDir: string;

beforeEach(async () => {
  // The profile and the corrections live in `.taskctl` next to the tasks dir,
  // so the tasks dir gets a root of its own: nothing is written outside it.
  root = await mkdtemp(join(tmpdir(), "taskctl-worker-memory-"));
  tasksDir = join(root, "tasks");
  await mkdir(join(tasksDir, "workspace"), { recursive: true });
  // The query takes the spec's goal, so the spec says what the title and the body do not.
  await writeSpec(tasksDir, "a", "## 目标\nQUERY GOAL LINE\n\n## 非目标\nNOT IN THE QUERY\n");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/**
 * One attempt on task `a`, in two worker turns unless a test says otherwise.
 * `memory` is the backend the attempt is given through its seam; left out, the
 * attempt has to build one from its configuration.
 */
async function attempt(config: WorkerConfig, memory: MemoryBackend | undefined, turnsUntilDone = 2) {
  const store = FakeStore.seed(task());
  const adapter = new FakeAdapter(() => {
    if (adapter.calls.length >= turnsUntilDone) store.requestDone("a");
    return { sessionId: "ses-a1", exitCode: 0, text: "完成了" };
  });
  const deps: WorkerDeps = { store, adapter, acceptance: passGate, review: passReview, ...(memory === undefined ? {} : { memory }) };
  const outcome = await runTask(config, deps, task(), "w");
  // No turn at all reads as an empty prompt, so that it is the outcome a failed test reports.
  return { outcome, text: adapter.calls[0]?.text ?? "", turns: adapter.calls.length };
}

/** `tasks/a/recall.json`, parsed. */
const recallRecord = async () => JSON.parse(await readFile(join(tasksDir, "a", "recall.json"), "utf8"));

/** The journal lines of task `a` that are about recall, and only those. */
async function recallLines(): Promise<{ stage: string; event: string; detail: string }[]> {
  return (await readJournal(tasksDir, "a")).filter((line) => line.event.startsWith("recall"));
}

describe("runTask — memory recall", () => {
  it("puts recalled lessons in the prompt and writes recall.json once per attempt", async () => {
    // Memory is on; the seam answers one hit, "RECALLED LESSON"; the attempt takes two turns.
    const { backend, calls } = fakeBackend([[hit("d1", "RECALLED LESSON")]]);

    const { outcome, text, turns } = await attempt(cfg(tasksDir, { memory: memoryOn(root) }), backend);

    expect(outcome).toBe("done");
    expect(turns).toBe(2);
    expect(text).toContain("## 相关记忆");
    expect(text).toContain(MEMORY_NOTE);
    // The hit as the memory layer renders it, in a section of its own: after the work rules, before the handoff.
    expect(text).toContain("] RECALLED LESSON\n");
    expect(text.indexOf("## 相关记忆")).toBeGreaterThan(text.indexOf("## 工作规则"));
    expect(text.indexOf("## 相关记忆")).toBeLessThan(text.indexOf("## 上一段会话的交接笔记"));
    // Asked once, although the attempt took two turns: with the task's own words and its spec's goal, and
    // under the settings the configuration resolved (no wing, so one search; the limit never below 20).
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ requests: [{ query: "任务A A 的正文 QUERY GOAL LINE" }], opts: { limit: 20 } });
    // One record for the attempt, saying what was asked and what was kept.
    expect(await recallRecord()).toMatchObject({
      backend: "fake", outcome: "ok", query: "任务A A 的正文 QUERY GOAL LINE",
      hits: [{ drawerId: "d1", wing: "w", room: "pitfall", similarity: 0.9, chars: 15 }],
      filtered: { belowThreshold: 0, room: 0, wing: 0 }, truncated: false,
    });
    // One journal line for the attempt, in the memory layer's format.
    const journaled = await recallLines();
    expect(journaled).toHaveLength(1);
    expect(journaled[0]).toMatchObject({
      stage: "worker", event: "recall", detail: "outcome=ok hits=1 below=0 room=0 wing=0 truncated=false backend=fake",
    });
  });

  it("never asks the backend when memory is off, with no memory block", async () => {
    // A backend is on the seam anyway: it is the switch that must keep it from being asked.
    const { backend, calls } = fakeBackend([[hit("d1", "RECALLED LESSON")]]);

    const { outcome, text } = await attempt(cfg(tasksDir), backend);

    expect(outcome).toBe("done");
    expect(calls).toHaveLength(0);
    expect(text).not.toContain("## 相关记忆");
    await expect(readFile(join(tasksDir, "a", "recall.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await recallLines()).toEqual([]);
  });

  it("never asks the backend when memory is off, with a block whose backend is none", async () => {
    // The block `resolveConfig({ memory: {} })` gives: every setting present, the backend left at its default.
    const { backend, calls } = fakeBackend([[hit("d1", "RECALLED LESSON")]]);

    const { outcome, text } = await attempt(cfg(tasksDir, { memory: { ...memoryOn(root), backend: "none" } }), backend);

    expect(outcome).toBe("done");
    expect(calls).toHaveLength(0);
    expect(text).not.toContain("## 相关记忆");
    await expect(readFile(join(tasksDir, "a", "recall.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await recallLines()).toEqual([]);
  });

  it("leaves the section out when nothing was kept, and says so", async () => {
    // Every hit the backend answers is below the similarity the configuration insists on.
    const { backend, calls } = fakeBackend([[hit("d1", "TOO FAR", 0.3)]]);

    const { outcome, text, turns } = await attempt(cfg(tasksDir, { memory: memoryOn(root) }), backend);

    expect(outcome).toBe("done");
    expect(turns).toBe(2);
    expect(calls).toHaveLength(1);
    expect(text).not.toContain("## 相关记忆");
    expect(text).not.toContain("TOO FAR");
    expect(await recallRecord()).toMatchObject({ outcome: "no-hits", hits: [], filtered: { belowThreshold: 1, room: 0, wing: 0 } });
    const journaled = await recallLines();
    expect(journaled).toHaveLength(1);
    expect(journaled[0]).toMatchObject({
      stage: "worker", event: "recall", detail: "outcome=no-hits hits=0 below=1 room=0 wing=0 truncated=false backend=fake",
    });
  });

  it("finishes the task when recall throws", async () => {
    // The seam answers nothing: it throws "palace offline".
    let asked = 0;
    const backend: MemoryBackend = { name: "fake", searchAll: async () => { asked += 1; throw new Error("palace offline"); } };

    const { outcome, text, turns } = await attempt(cfg(tasksDir, { memory: memoryOn(root) }), backend);

    expect(outcome).toBe("done");
    expect(turns).toBe(2);
    expect(asked).toBe(1);
    expect(text).not.toContain("## 相关记忆");
    // It is the recall that was unavailable, not the task's context: the rest of the prompt is as it was.
    expect(text).toContain("## 已批准的规格");
    expect((await readJournal(tasksDir, "a")).map((line) => line.event)).not.toContain("context-unavailable");
    expect(await recallRecord()).toMatchObject({ backend: "fake", outcome: "error", hits: [], detail: "palace offline" });
    const journaled = await recallLines();
    expect(journaled).toHaveLength(1);
    expect(journaled[0]).toMatchObject({
      stage: "worker", event: "recall-unavailable",
      detail: "outcome=error hits=0 below=0 room=0 wing=0 truncated=false backend=fake error=palace offline",
    });
  });

  it("asks the configured server when no backend is on the seam, and finishes when it cannot be started", async () => {
    // No seam: the attempt builds the backend from its configuration, whose command exists nowhere.
    const { outcome, text, turns } = await attempt(cfg(tasksDir, { memory: memoryOn(root) }), undefined);

    expect(outcome).toBe("done");
    expect(turns).toBe(2);
    expect(text).not.toContain("## 相关记忆");
    // The record names the configured backend and why it could not answer.
    expect(await recallRecord()).toMatchObject({ backend: "mempalace", outcome: "error", detail: expect.stringContaining("cannot spawn") });
    const journaled = await recallLines();
    expect(journaled).toHaveLength(1);
    expect(journaled[0]).toMatchObject({
      stage: "worker", event: "recall-unavailable",
      detail: expect.stringMatching(/^outcome=error hits=0 below=0 room=0 wing=0 truncated=false backend=mempalace error=mcp: cannot spawn .*mempalace-mcp\.exe/),
    });
  });
});
