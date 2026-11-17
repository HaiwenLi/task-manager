import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Task, TaskStatus } from "../src/task-file.js";
import type { AgentAdapter } from "../src/adapters/types.js";
import type { AcceptanceResult } from "../src/acceptance.js";
import { runTask, type WorkerConfig } from "../src/worker.js";

const exec = promisify(execFile);

type PromptArgs = Parameters<AgentAdapter["prompt"]>[0];
type PromptResult = Awaited<ReturnType<AgentAdapter["prompt"]>>;

class FakeStore {
  readonly tasks = new Map<string, Task>();
  readonly markers = new Set<string>();

  static seed(task: Task): FakeStore {
    const store = new FakeStore();
    store.tasks.set(task.id, task);
    return store;
  }

  async list(): Promise<Task[]> {
    return [...this.tasks.values()];
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
  async readDoneMarker(id: string): Promise<boolean> {
    return this.markers.has(id);
  }
  async clearDoneMarker(id: string): Promise<void> {
    this.markers.delete(id);
  }
  async incReviewRounds(id: string): Promise<number> {
    return ++this.tasks.get(id)!.reviewRounds;
  }
  task(id: string): Task {
    return this.tasks.get(id)!;
  }
}

/** Scripted adapter: one turn per script entry, all calls recorded. */
class FakeAdapter implements AgentAdapter {
  readonly calls: PromptArgs[] = [];

  constructor(private readonly script: (args: PromptArgs, fake: FakeAdapter) => Promise<PromptResult> | PromptResult) {}

  async prompt(args: PromptArgs): Promise<PromptResult> {
    this.calls.push(args);
    return this.script(args, this);
  }
  async contextUsage(): Promise<number> {
    return 0;
  }
  async contextLimit(): Promise<number> {
    return 1_000_000;
  }
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "a",
    title: "任务A",
    description: "A 的正文",
    status: "open",
    criteria: ["C1 fixture"],
    complexity: "complex",
    risk: "normal",
    dependsOn: [],
    humanCheck: false,
    tolerate: [],
    quick: false,
    verify: "mechanical",
    renderTargets: [],
    keepAtRoot: [],
    reviewRounds: 0,
    sessions: [],
    retries: 0,
    acceptance: "fixture check",
    ...overrides,
  };
}

const passGate = async (): Promise<AcceptanceResult> => ({ passed: true, exitCode: 0, output: "", skipped: false });

let root: string;
let tasksDir: string;
let workdir: string;

/** Workdir that is a real Git repository with one committed deliverable. */
async function gitWorkdir(): Promise<void> {
  workdir = join(root, "ws");
  await mkdir(workdir, { recursive: true });
  const git = (args: string[]) => exec("git", ["-c", "user.email=t@taskctl", "-c", "user.name=taskctl", ...args], { cwd: workdir });
  await git(["init"]);
  await writeFile(join(workdir, "deliverable.txt"), "tracked", "utf8");
  await git(["add", "deliverable.txt"]);
  await git(["commit", "-m", "init"]);
}

function cfg(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    tasksDir,
    workdir,
    agent: "opencode",
    contextThreshold: 0.8,
    retryLimit: 3,
    lockTtlMs: 600_000,
    heartbeatMs: 60_000,
    ...overrides,
  };
}

/** One-turn script: run `act`, then request done so the attempt settles fast. */
const turnActing = (store: FakeStore, act: () => Promise<void> | void) =>
  async (): Promise<PromptResult> => {
    await act();
    store.markers.add("a");
    return { sessionId: "ses-1", exitCode: 0, text: "done" };
  };

async function journal(): Promise<string> {
  try {
    return await readFile(join(tasksDir, "a", "journal.md"), "utf8");
  } catch {
    return "";
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "taskctl-hygiene-"));
  tasksDir = join(root, "tasks");
  await mkdir(tasksDir);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("C1: TASKCTL_TASK_DIR / TASKCTL_LOG_DIR injection", () => {
  it("exposes both variables to the worker process and creates the log dir", async () => {
    await gitWorkdir();
    const store = FakeStore.seed(task());
    const adapter = new FakeAdapter(turnActing(store, () => {}));

    const outcome = await runTask(cfg(), { store, adapter, acceptance: passGate }, store.task("a"), "w1");

    expect(outcome).toBe("done");
    expect(adapter.calls.length).toBeGreaterThanOrEqual(1);
    const env = adapter.calls[0]!.env;
    expect(env?.TASKCTL_TASK_DIR).toBe(join(tasksDir, "a"));
    expect(env?.TASKCTL_LOG_DIR).toBe(join(tasksDir, "a", "logs"));
    await expect(stat(join(tasksDir, "a", "logs"))).resolves.toBeTruthy();
  });

  it("spells the same paths into the protocol copy the turn carries", async () => {
    await gitWorkdir();
    const store = FakeStore.seed(task());
    const adapter = new FakeAdapter(turnActing(store, () => {}));

    await runTask(cfg(), { store, adapter, acceptance: passGate }, store.task("a"), "w1");

    expect(adapter.calls[0]!.text).toContain(`临时文件与日志一律写 ${join(tasksDir, "a", "logs")}（环境变量 $TASKCTL_LOG_DIR）`);
  });
});

describe("C3: post-turn root sweep", () => {
  it("moves this turn's new untracked litter into scratch and journals the move", async () => {
    await gitWorkdir();
    const store = FakeStore.seed(task());
    const adapter = new FakeAdapter(turnActing(store, async () => {
      await writeFile(join(workdir, "_accept_run.log"), "litter", "utf8");
      await writeFile(join(workdir, "deliverable.txt"), "tracked + edited", "utf8");
    }));

    const outcome = await runTask(cfg(), { store, adapter, acceptance: passGate }, store.task("a"), "w1");

    expect(outcome).toBe("done");
    await expect(readFile(join(tasksDir, "a", "scratch", "_accept_run.log"), "utf8")).resolves.toBe("litter");
    // 已跟踪文件不动：被修改的交付物仍在原地，内容是本回合写入的
    await expect(readFile(join(workdir, "deliverable.txt"), "utf8")).resolves.toBe("tracked + edited");
    const log = await journal();
    expect(log).toContain("artifact-swept");
    expect(log).toContain(join(workdir, "_accept_run.log"));
    expect(log).toContain(join(tasksDir, "a", "scratch", "_accept_run.log"));
  });

  it("keeps keepAtRoot files at the workspace root", async () => {
    await gitWorkdir();
    const store = FakeStore.seed(task({ keepAtRoot: ["run.log"] }));
    const adapter = new FakeAdapter(turnActing(store, async () => {
      await writeFile(join(workdir, "run.log"), "must stay", "utf8");
      await writeFile(join(workdir, "swept.log"), "must go", "utf8");
    }));

    await runTask(cfg(), { store, adapter, acceptance: passGate }, store.task("a"), "w1");

    await expect(readFile(join(workdir, "run.log"), "utf8")).resolves.toBe("must stay");
    await expect(readFile(join(tasksDir, "a", "scratch", "swept.log"), "utf8")).resolves.toBe("must go");
  });

  it("does nothing when artifacts.sweep is false", async () => {
    await gitWorkdir();
    const store = FakeStore.seed(task());
    const adapter = new FakeAdapter(turnActing(store, async () => {
      await writeFile(join(workdir, "junk.log"), "stays", "utf8");
    }));

    await runTask(cfg({ artifacts: { sweep: false, scratchPatterns: ["*.log"] } }),
      { store, adapter, acceptance: passGate }, store.task("a"), "w1");

    await expect(readFile(join(workdir, "junk.log"), "utf8")).resolves.toBe("stays");
    expect(await journal()).not.toContain("artifact-swept");
  });

  it("journals the inert reason once when the workdir is not a Git repository", async () => {
    workdir = join(root, "plain-ws");
    await mkdir(workdir);
    const store = FakeStore.seed(task());
    const adapter = new FakeAdapter(turnActing(store, async () => {
      await writeFile(join(workdir, "junk.log"), "stays", "utf8");
    }));

    await runTask(cfg(), { store, adapter, acceptance: passGate }, store.task("a"), "w1");

    await expect(readFile(join(workdir, "junk.log"), "utf8")).resolves.toBe("stays");
    const log = await journal();
    expect(log).toContain("artifact-sweep-skipped");
    expect(log.match(/artifact-sweep-skipped/g)).toHaveLength(1);
  });

  it("does not let the scratch dir or swept files break the acceptance digest", async () => {
    await gitWorkdir();
    const store = FakeStore.seed(task());
    const adapter = new FakeAdapter(turnActing(store, async () => {
      await writeFile(join(workdir, "litter.tmp"), "x", "utf8");
    }));

    const outcome = await runTask(cfg(), { store, adapter, acceptance: passGate }, store.task("a"), "w1");

    // 落点在 tasksDir 内（digest 已排除），验收照常通过
    expect(outcome).toBe("done");
    const entries = await readdir(join(tasksDir, "a", "scratch"));
    expect(entries).toContain("litter.tmp");
  });
});
