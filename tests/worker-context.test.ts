import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter } from "../src/adapters/types.js";
import type { AcceptanceResult } from "../src/acceptance.js";
import { recordFeedback, type FeedbackRecord } from "../src/feedback.js";
import { readJournal } from "../src/journal.js";
import { buildWorkerPrompt, SPEC_NOTE } from "../src/protocol.js";
import { profilePath } from "../src/profile.js";
import { writeSpec } from "../src/spec.js";
import type { Task, TaskStatus } from "../src/task-file.js";
import { runTask, type WorkerConfig } from "../src/worker.js";

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

/** Fixture reviewer: every task passes review unless a test overrides it. */
const passReview = async () => ({
  verdict: "pass" as const,
  criteria: [{ id: "C1", pass: true, evidence: "fixture" }],
  externalChanges: [],
  defects: [],
  summary: "ok",
});

function task(overrides: Partial<Task> = {}): Task {
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
    ...overrides,
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

let root: string;
let tasksDir: string;

beforeEach(async () => {
  // The profile and the corrections live in `.taskctl` next to the tasks dir,
  // so the tasks dir gets a root of its own: nothing is written outside it.
  root = await mkdtemp(join(tmpdir(), "taskctl-worker-context-"));
  tasksDir = join(root, "tasks");
  await mkdir(join(tasksDir, "workspace"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A correction a human left on earlier work, as `taskctl reject` records it. */
function correction(note: string, stage: FeedbackRecord["stage"]): FeedbackRecord {
  return {
    task: "old",
    title: "任务A",
    action: "reject",
    verdict: "fail",
    stage,
    note,
    at: new Date(2026, 0, 1).toISOString(),
  };
}

/** What a task has beside it once intake, the owner and a reviewer have all left their mark. */
async function writeContext(profile = "- 2026-11-25  PREFERENCE LINE\n"): Promise<void> {
  await writeSpec(tasksDir, "a", "## 目标\nSPEC GOAL LINE\n");
  await mkdir(join(profilePath(tasksDir), ".."), { recursive: true });
  await writeFile(profilePath(tasksDir), profile, "utf8");
  await recordFeedback(tasksDir, correction("WORKER CORRECTION", "worker"));
  await recordFeedback(tasksDir, correction("REVIEWER CORRECTION", "reviewer"));
}

/**
 * The protocol as it was before the context sections existed: the four paths
 * `loop` resolves for a first session without dependencies.
 */
function legacyProtocol(cfg: WorkerConfig, task: Task): string {
  return buildWorkerPrompt(task, {
    handoff: undefined,
    workdir: cfg.workdir,
    tasksDir: cfg.tasksDir,
    taskDir: join(cfg.tasksDir, "a"),
    logDir: join(cfg.tasksDir, "a", "logs"),
  });
}

/**
 * One attempt on task `a`. `turnsUntilDone` is how many worker turns it takes
 * to ask for `done`; `text` is the prompt of the first turn.
 */
async function attempt(cfg: WorkerConfig, turnsUntilDone = 1) {
  const store = FakeStore.seed(task());
  const adapter = new FakeAdapter(() => {
    if (adapter.calls.length >= turnsUntilDone) store.requestDone("a");
    return { sessionId: "ses-a1", exitCode: 0, text: "完成了" };
  });
  const deps = { store, adapter, acceptance: passGate, review: passReview };
  const outcome = await runTask(cfg, deps, task(), "w");
  // No turn at all reads as an empty prompt, so that it is the outcome a failed test reports.
  return { outcome, text: adapter.calls[0]?.text ?? "", turns: adapter.calls.length };
}

describe("runTask — worker context", () => {
  it("gives the worker the approved spec, the profile and the relevant corrections", async () => {
    // tasks/a.md open with a passing acceptance; tasks/a/spec.md containing "SPEC GOAL LINE";
    // .taskctl/profile.md with "PREFERENCE LINE"; .taskctl/feedback.jsonl: one reject/worker
    // note "WORKER CORRECTION" and one reject/reviewer note "REVIEWER CORRECTION".
    await writeContext();
    const { outcome, text } = await attempt(cfg(tasksDir));

    expect(outcome).toBe("done");
    expect(text).toContain("## 已批准的规格");
    expect(text).toContain("SPEC GOAL LINE");
    expect(text).toContain("## 用户偏好");
    expect(text).toContain("PREFERENCE LINE");
    expect(text).toContain("WORKER CORRECTION");
    expect(text).not.toContain("REVIEWER CORRECTION");
  });

  it("carries the fixed spec note once", async () => {
    await writeContext();
    const { text } = await attempt(cfg(tasksDir));
    // The prompt writes the note that closes the spec section; the section read from disk leaves it to the prompt.
    expect(text.split(SPEC_NOTE)).toHaveLength(2);
  });

  it("leaves the prompt unchanged when both switches are off", async () => {
    // same files; cfg.workerContext = { spec: false, preferences: false }
    await writeContext();
    const config = cfg(tasksDir, { workerContext: { spec: false, preferences: false } });
    const { outcome, text } = await attempt(config);

    expect(outcome).toBe("done");
    expect(text).not.toContain("## 已批准的规格");
    expect(text).not.toContain("## 用户偏好");
    expect(text).not.toContain("## 同类任务上人工给过的纠正");
    // Unchanged means unchanged: with the files in place, the prompt is the protocol that had no sections.
    expect(text).toBe(legacyProtocol(config, task()));
  });

  it("sends the unchanged protocol when no context file exists", async () => {
    // no .taskctl directory, no spec.md
    const config = cfg(tasksDir);
    const { outcome, text } = await attempt(config);

    expect(outcome).toBe("done");
    expect(text).toBe(legacyProtocol(config, task()));
  });

  it("journals once when the profile was cut", async () => {
    // A profile past 2,000 characters, and an attempt that needs two turns to finish.
    await writeContext(Array.from({ length: 150 }, (_, i) => `- 2026-11-25  rule ${i}\n`).join(""));
    const { text, turns } = await attempt(cfg(tasksDir), 2);

    expect(turns).toBe(2);
    expect(text).toContain("这里只保留最新的部分");
    expect((await readJournal(tasksDir, "a")).filter((line) => line.event === "profile-truncated")).toHaveLength(1);
  });

  it("finishes the attempt when a context file cannot be read", async () => {
    // .taskctl/profile.md is a directory, so reading it fails
    await mkdir(profilePath(tasksDir), { recursive: true });
    const { outcome, text } = await attempt(cfg(tasksDir));

    expect(outcome).toBe("done");
    expect((await readJournal(tasksDir, "a")).filter((line) => line.event === "context-unavailable")).toHaveLength(1);
    expect(text).not.toContain("## 用户偏好");
  });
});
