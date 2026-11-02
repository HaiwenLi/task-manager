import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claim, type Lock } from "../src/claim.js";
import { latestNote, writeNote } from "../src/handoff.js";
import { TaskStore } from "../src/task-store.js";
import { TaskFileError } from "../src/task-file.js";
import type { Task, TaskStatus } from "../src/task-file.js";
import type { AgentAdapter } from "../src/adapters/types.js";
import type { AcceptanceResult } from "../src/acceptance.js";
import { runWorker, WRAP_UP_INSTRUCTION, type WorkerConfig, type WorkerEvent } from "../src/worker.js";

/** 收尾指令固定文案（ruling 3）——测试里逐字钉死，不用实现侧常量。 */
const WRAP_UP = "上下文预算告急。请立即运行一次 taskctl note（详尽记录进展），然后只回复 HANDOFF_READY";

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
  usage: Record<string, number> = {};
  limit = 1_000_000;

  constructor(
    private readonly script: (args: PromptArgs, fake: FakeAdapter) => PromptResult | Promise<PromptResult>,
  ) {}

  async prompt(args: PromptArgs): Promise<PromptResult> {
    this.calls.push(args);
    return this.script(args, this);
  }

  async contextUsage(sessionId: string): Promise<number> {
    return this.usage[sessionId] ?? 0;
  }

  async contextLimit(_model: string): Promise<number> {
    return this.limit;
  }
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "a",
    title: "任务A",
    description: "A 的正文",
    status: "open",
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

let tasksDir: string;

beforeEach(async () => {
  tasksDir = await mkdtemp(join(tmpdir(), "taskctl-worker-"));
  await mkdir(join(tasksDir, "workspace"));
});

afterEach(async () => {
  await rm(tasksDir, { recursive: true, force: true });
});

/** tasks/<id>/lock.json 是否还在（terminal 状态应已 release）。 */
async function lockHeld(id: string): Promise<boolean> {
  try {
    await readFile(join(tasksDir, id, "lock.json"), "utf8");
    return true;
  } catch {
    return false;
  }
}

/** 绕过 API 直接伪造一把锁（心跳时间自定），模拟崩溃 worker 留下的现场。 */
async function forgeLock(id: string, worker: string, heartbeatAt: number): Promise<void> {
  await mkdir(join(tasksDir, id), { recursive: true });
  await writeFile(join(tasksDir, id, "lock.json"), JSON.stringify({ worker, heartbeat: heartbeatAt }), "utf8");
}

/** 读取当前锁内容。 */
async function readLock(id: string): Promise<Lock> {
  return JSON.parse(await readFile(join(tasksDir, id, "lock.json"), "utf8")) as Lock;
}

/** 收集 onEvent 事件的 seam。 */
function eventSink(): { events: WorkerEvent[]; onEvent: (evt: WorkerEvent) => void } {
  const events: WorkerEvent[] = [];
  return { events, onEvent: (evt) => events.push(evt) };
}

describe("runWorker — 队列与生命周期", () => {
  it("正常路径：第 1 回合 done marker → acceptance passed → done", async () => {
    const store = FakeStore.seed(task({ acceptance: "npm test", model: "kimi/k2", effort: "high" }));
    const adapter = new FakeAdapter(() => {
      store.requestDone("a");
      return { sessionId: "ses-a1", exitCode: 0, text: "完成了" };
    });
    const acceptance = vi.fn(passGate);
    const c = cfg(tasksDir);

    const result = await runWorker(c, { store, adapter, acceptance });

    expect(result).toEqual({ done: ["a"], blocked: [] });
    expect(store.task("a").status).toBe("done");
    expect(store.task("a").sessions).toEqual(["ses-a1"]);
    expect(store.task("a").retries).toBe(0);
    expect(acceptance).toHaveBeenCalledOnce();
    expect(acceptance).toHaveBeenCalledWith("npm test", c.workdir);
    // marker 被消费、锁被释放
    expect(store.markers.size).toBe(0);
    await expect(lockHeld("a")).resolves.toBe(false);
    // prompt 集成：任务标题 + 首会话占位 + cwd/model/effort 透传
    expect(adapter.calls[0].text).toContain("# 任务：任务A");
    expect(adapter.calls[0].text).toContain("（这是本任务第一个会话，无前序笔记）");
    expect(adapter.calls[0].cwd).toBe(c.workdir);
    expect(adapter.calls[0].model).toBe("kimi/k2");
    expect(adapter.calls[0].effort).toBe("high");
    expect(adapter.calls[0].title).toBe("任务A");
  });

  it("Review Focus 2：回合结束无 marker → 不落 done，发下一回合（第 2 回合才置 marker）", async () => {
    const store = FakeStore.seed(task());
    const adapter = new FakeAdapter(() => {
      if (adapter.calls.length === 1) {
        return { sessionId: "ses-a1", exitCode: 0, text: "第一回合还没做完" };
      }
      store.requestDone("a");
      return { sessionId: "ses-a1", exitCode: 0, text: "第二回合完成" };
    });

    const result = await runWorker(cfg(tasksDir), { store, adapter, acceptance: passGate });

    expect(result).toEqual({ done: ["a"], blocked: [] });
    expect(store.task("a").status).toBe("done");
    expect(adapter.calls).toHaveLength(2);
    // 无 marker 的回合之后同 session 继续，且不重复 appendSession
    expect(adapter.calls[1].sessionId).toBe("ses-a1");
    expect(store.task("a").sessions).toEqual(["ses-a1"]);
  });

  it("队列：2 个 open 任务顺序完成，返回 {done:[a,b]}；非 open 任务不动", async () => {
    const store = FakeStore.seed(
      task({ id: "a", title: "前端改造" }),
      task({ id: "b", title: "后端接口" }),
      task({ id: "c", title: "已完成的", status: "done", sessions: ["ses-old"] }),
    );
    const adapter = new FakeAdapter((args) => {
      const id = args.text.includes("前端改造") ? "a" : "b";
      store.requestDone(id);
      return { sessionId: `ses-${id}`, exitCode: 0, text: "ok" };
    });

    const result = await runWorker(cfg(tasksDir), { store, adapter, acceptance: passGate });

    expect(result).toEqual({ done: ["a", "b"], blocked: [] });
    expect(store.task("a").status).toBe("done");
    expect(store.task("b").status).toBe("done");
    expect(store.task("c").status).toBe("done");
    expect(store.task("c").sessions).toEqual(["ses-old"]);
  });

  it("他人在持的活锁 → 跳过任务，不动状态、不释放别人的锁", async () => {
    const store = FakeStore.seed(task());
    expect(await claim(tasksDir, "a", "other-worker")).toBe(true);
    const adapter = new FakeAdapter(() => {
      throw new Error("must not prompt");
    });

    const result = await runWorker(cfg(tasksDir), { store, adapter, acceptance: passGate });

    expect(result).toEqual({ done: [], blocked: [] });
    expect(store.task("a").status).toBe("open");
    const lock = JSON.parse(await readFile(join(tasksDir, "a", "lock.json"), "utf8")) as Lock;
    expect(lock.worker).toBe("other-worker");
  });

  it("损坏的任务文件 → list() 的 TaskFileError 直接上抛（fail loud）", async () => {
    // 缺 title：YAML 合法但字段校验失败
    await writeFile(join(tasksDir, "broken.md"), "---\nstatus: open\nsessions: []\nretries: 0\n---\n正文", "utf8");
    const store = new TaskStore(tasksDir);
    const adapter = new FakeAdapter(() => ({ sessionId: "s", exitCode: 0, text: "" }));

    await expect(runWorker(cfg(tasksDir), { store, adapter })).rejects.toBeInstanceOf(TaskFileError);
  });

  it("ruling 1：每次 prompt 前刷新锁心跳（回合边界续期）", async () => {
    const store = FakeStore.seed(task());
    const locks: Lock[] = [];
    const adapter = new FakeAdapter(async () => {
      // prompt 时刻读到的锁必须是刚续期过的
      locks.push(JSON.parse(readFileSync(join(tasksDir, "a", "lock.json"), "utf8")) as Lock);
      if (adapter.calls.length === 1) {
        await new Promise((resolve) => setTimeout(resolve, 15));
        return { sessionId: "ses-a1", exitCode: 0, text: "第一回合还没做完" };
      }
      store.requestDone("a");
      return { sessionId: "ses-a1", exitCode: 0, text: "ok" };
    });

    await runWorker(cfg(tasksDir), { store, adapter, acceptance: passGate });

    expect(locks).toHaveLength(2);
    expect(locks[0].worker).toMatch(new RegExp(`^worker-${process.pid}-`));
    expect(locks[1].worker).toBe(locks[0].worker);
    // 第 2 回合前的心跳晚于第 1 回合前的心跳 → 确实刷新了
    expect(locks[1].heartbeat).toBeGreaterThan(locks[0].heartbeat);
  });
});

describe("runWorker — R4 会话链交接", () => {
  it("R4：contextUsage 超阈值 → 发收尾指令、appendSession 两次、第 2 回合注入笔记", async () => {
    const store = FakeStore.seed(task());
    const adapter = new FakeAdapter(async (args) => {
      if (args.text === WRAP_UP) {
        // agent 按指令写 note 再回 HANDOFF_READY
        await writeNote(tasksDir, {
          task: "a",
          seq: 1,
          status: "进行中；预算告急",
          done: "第一段：实现了数据解析",
          found: "锁需要回合边界心跳续期",
          next: "第二段继续写 worker 主循环",
          files: ["src/worker.ts"],
        });
        return { sessionId: args.sessionId!, exitCode: 0, text: "HANDOFF_READY" };
      }
      if (adapter.calls.length === 1) {
        adapter.usage["ses-A"] = 900_000; // 0.9 ≥ 0.8 阈值
        return { sessionId: "ses-A", exitCode: 0, text: "第一回合输出" };
      }
      store.requestDone("a");
      return { sessionId: "ses-B", exitCode: 0, text: "第二回合完成" };
    });

    const result = await runWorker(cfg(tasksDir), { store, adapter, acceptance: passGate });

    expect(result).toEqual({ done: ["a"], blocked: [] });
    // 收尾指令：固定文案、发给同一个 session
    expect(adapter.calls[1].text).toBe(WRAP_UP);
    expect(adapter.calls[1].sessionId).toBe("ses-A");
    // appendSession 恰好两次（wrap-up 回合不重复记）
    expect(store.task("a").sessions).toEqual(["ses-A", "ses-B"]);
    // 第 2 回合开新 session，且 prompt 含第 1 回合写的 note
    expect(adapter.calls[2].sessionId).toBeUndefined();
    expect(adapter.calls[2].text).toContain("第一段：实现了数据解析");
    expect(adapter.calls[2].text).toContain("## Next\n第二段继续写 worker 主循环");
  });

  it("导出的收尾文案与固定文案逐字一致（ruling 3）", () => {
    expect(WRAP_UP_INSTRUCTION).toBe(WRAP_UP);
  });

  it("收尾回合没写 note → 编排器写兜底 note 并计一次失败后继续（Step 3 注记）", async () => {
    const store = FakeStore.seed(task({ title: "修复登录" }));
    const adapter = new FakeAdapter(() => {
      if (adapter.calls.length === 1) {
        adapter.usage["ses-A"] = 950_000;
        return { sessionId: "ses-A", exitCode: 0, text: "第一回合" };
      }
      if (adapter.calls.length === 2) {
        // 收尾回合正常结束，但没有写 note
        return { sessionId: "ses-A", exitCode: 0, text: "W".repeat(600) };
      }
      store.requestDone("a");
      return { sessionId: "ses-B", exitCode: 0, text: "续接完成" };
    });

    const result = await runWorker(cfg(tasksDir), { store, adapter, acceptance: passGate });

    expect(result).toEqual({ done: ["a"], blocked: [] });
    expect(store.task("a").retries).toBe(1); // 视为一次失败
    // 兜底 note 落盘：status、任务与回合输出首 500 字
    const note = await latestNote(tasksDir, "a");
    expect(note).not.toBeNull();
    expect(note!.seq).toBe(1);
    expect(note!.markdown).toContain("## Status\norchestrator-fallback");
    expect(note!.markdown).toContain("任务 a（修复登录）");
    const doneSection = /## Done\n(.*)\n\n## Found/.exec(note!.markdown)![1];
    const nextSection = /## Next\n(.*)\n\n## Files/.exec(note!.markdown)![1];
    expect(doneSection.length).toBe(500); // 截到首 500 字
    expect(nextSection.length).toBe(500);
    expect(doneSection).toMatch(/^任务 a（修复登录）/);
    // 新 session 注入了兜底 note
    expect(adapter.calls[2].sessionId).toBeUndefined();
    expect(adapter.calls[2].text).toContain("orchestrator-fallback");
  });

  it("收尾缺 note 且重试额度耗尽 → blocked（兜底 note 仍落盘）", async () => {
    const store = FakeStore.seed(task());
    const adapter = new FakeAdapter(() => {
      if (adapter.calls.length === 1) {
        adapter.usage["ses-A"] = 950_000;
        return { sessionId: "ses-A", exitCode: 0, text: "第一回合" };
      }
      return { sessionId: "ses-A", exitCode: 0, text: "没写 note 的收尾" };
    });

    const result = await runWorker(cfg(tasksDir, { retryLimit: 1 }), { store, adapter, acceptance: passGate });

    expect(result).toEqual({ done: [], blocked: ["a"] });
    expect(store.task("a").status).toBe("blocked");
    const note = await latestNote(tasksDir, "a");
    expect(note!.markdown).toContain("orchestrator-fallback");
    await expect(lockHeld("a")).resolves.toBe(false);
  });

  it("收尾回合 exitCode 1（回合已结束）且未写 note → 兜底 note 仍写入", async () => {
    const store = FakeStore.seed(task({ title: "修复登录" }));
    const adapter = new FakeAdapter(() => {
      if (adapter.calls.length === 1) {
        adapter.usage["ses-A"] = 950_000;
        return { sessionId: "ses-A", exitCode: 0, text: "第一回合" };
      }
      if (adapter.calls.length === 2) {
        // 收尾回合结束了（exitCode 1）但没写 note，输出里带着进展
        return { sessionId: "ses-A", exitCode: 1, text: "收尾回合失败但输出了一些进展" };
      }
      store.requestDone("a");
      return { sessionId: "ses-B", exitCode: 0, text: "续接完成" };
    });

    const result = await runWorker(cfg(tasksDir), { store, adapter, acceptance: passGate });

    expect(result).toEqual({ done: ["a"], blocked: [] });
    expect(store.task("a").retries).toBe(1); // 仍计一次失败
    // 已结束的收尾回合 → 兜底 note 落盘，积累的上下文不丢
    const note = await latestNote(tasksDir, "a");
    expect(note).not.toBeNull();
    expect(note!.markdown).toContain("## Status\norchestrator-fallback");
    expect(note!.markdown).toContain("收尾回合失败但输出了一些进展");
    // 新 session 注入了兜底 note
    expect(adapter.calls[2].sessionId).toBeUndefined();
    expect(adapter.calls[2].text).toContain("orchestrator-fallback");
  });
});

describe("runWorker — 失败核算", () => {
  it("Review Focus 3：acceptance 连败 3 次（retryLimit=3）→ blocked", async () => {
    const store = FakeStore.seed(task({ acceptance: "npm test" }));
    const adapter = new FakeAdapter(() => {
      store.requestDone("a");
      return { sessionId: `ses-${adapter.calls.length}`, exitCode: 0, text: "声称完成" };
    });
    const acceptance = vi.fn(async (): Promise<AcceptanceResult> => ({
      passed: false,
      exitCode: 1,
      output: "断言失败",
      skipped: false,
    }));
    const c = cfg(tasksDir, { retryLimit: 3 });

    const result = await runWorker(c, { store, adapter, acceptance });

    expect(result).toEqual({ done: [], blocked: ["a"] });
    expect(store.task("a").status).toBe("blocked");
    expect(store.task("a").retries).toBe(3);
    expect(acceptance).toHaveBeenCalledTimes(3);
    expect(acceptance).toHaveBeenNthCalledWith(1, "npm test", c.workdir);
    // 每次重试都重新开 session 干活，而不是空转验收
    expect(adapter.calls).toHaveLength(3);
    expect(store.task("a").sessions).toEqual(["ses-1", "ses-2", "ses-3"]);
    await expect(lockHeld("a")).resolves.toBe(false);
  });

  it("Review Focus 4：prompt exitCode 1 计为失败重试，不 reject", async () => {
    const store = FakeStore.seed(task());
    const adapter = new FakeAdapter(() => {
      if (adapter.calls.length === 1) {
        return { sessionId: "ses-a1", exitCode: 1, text: "进程崩了" };
      }
      store.requestDone("a");
      return { sessionId: "ses-a1", exitCode: 0, text: "恢复后完成" };
    });

    const result = await runWorker(cfg(tasksDir), { store, adapter, acceptance: passGate });

    expect(result).toEqual({ done: ["a"], blocked: [] });
    expect(store.task("a").retries).toBe(1);
    expect(adapter.calls).toHaveLength(2);
    // 失败回合在同 session 内恢复
    expect(adapter.calls[1].sessionId).toBe("ses-a1");
  });

  it("ruling 2：agent 回合挂起 → turnTimeoutMs 后按失败回合处理", async () => {
    const store = FakeStore.seed(task());
    const adapter = new FakeAdapter(() => new Promise<PromptResult>(() => {})); // 永不返回

    const result = await runWorker(cfg(tasksDir, { retryLimit: 1, turnTimeoutMs: 25 }), {
      store,
      adapter,
      acceptance: passGate,
    });

    expect(result).toEqual({ done: [], blocked: ["a"] });
    expect(store.task("a").status).toBe("blocked");
    expect(store.task("a").retries).toBe(0); // uncertain shutdown is not a retryable failure
    expect(store.task("a").sessions).toEqual([]);
    await expect(lockHeld("a")).resolves.toBe(false);
  });

  it("ruling 2：acceptance 挂起 → acceptanceTimeoutMs 后按验收失败处理", async () => {
    const store = FakeStore.seed(task());
    const adapter = new FakeAdapter(() => {
      store.requestDone("a");
      return { sessionId: "ses-a1", exitCode: 0, text: "完成了" };
    });
    const acceptance = vi.fn(() => new Promise<AcceptanceResult>(() => {})); // 挂起

    const result = await runWorker(cfg(tasksDir, { retryLimit: 1, acceptanceTimeoutMs: 25 }), {
      store,
      adapter,
      acceptance,
    });

    expect(result).toEqual({ done: [], blocked: ["a"] });
    expect(store.task("a").retries).toBe(0); // injected legacy gate cannot prove shutdown
    await expect(lockHeld("a")).resolves.toBe(false);
  });
});

describe("runWorker — 循环上限（binding ruling）", () => {
  it("会话链达到 maxSessionsPerTask → failAttempt → 最终 blocked", async () => {
    const store = FakeStore.seed(task());
    let workTurn = 0; // 第几个"工作回合"（wrap-up 不计）
    const adapter = new FakeAdapter(async (args) => {
      if (args.text === WRAP_UP) {
        // 每段 session 都规范交接 → 每段都触发开新 session 的分叉
        await writeNote(tasksDir, {
          task: "a",
          seq: workTurn,
          status: "进行中",
          done: `第 ${workTurn} 段会话交接`,
          found: "",
          next: "继续",
          files: [],
        });
        return { sessionId: args.sessionId!, exitCode: 0, text: "HANDOFF_READY" };
      }
      workTurn += 1;
      const sessionId = `ses-${workTurn}`;
      adapter.usage[sessionId] = 900_000; // 每段 session 首回合即超阈值
      return { sessionId, exitCode: 0, text: "干活" };
    });

    const result = await runWorker(cfg(tasksDir, { maxSessionsPerTask: 2, retryLimit: 3 }), {
      store,
      adapter,
      acceptance: passGate,
    });

    expect(result).toEqual({ done: [], blocked: ["a"] });
    expect(store.task("a").status).toBe("blocked");
    expect(store.task("a").retries).toBe(3); // 每次越限开 session 计一次失败
    // 上限内的 2 段 + 失败核算放行的 2 段（第 3 次越限即 blocked）
    expect(store.task("a").sessions).toEqual(["ses-1", "ses-2", "ses-3", "ses-4"]);
    await expect(lockHeld("a")).resolves.toBe(false);
  });

  it("同 session 回合数达到 maxTurnsPerSession → failAttempt（换 session 重置计数）", async () => {
    const store = FakeStore.seed(task());
    // 永不写 marker、永不超预算：每 3 个回合耗尽一个 session 的回合预算
    const adapter = new FakeAdapter(() => ({
      sessionId: `ses-${Math.ceil(adapter.calls.length / 3)}`,
      exitCode: 0,
      text: "还在做",
    }));

    const result = await runWorker(cfg(tasksDir, { maxTurnsPerSession: 3, retryLimit: 3 }), {
      store,
      adapter,
      acceptance: passGate,
    });

    expect(result).toEqual({ done: [], blocked: ["a"] });
    expect(store.task("a").status).toBe("blocked");
    expect(store.task("a").retries).toBe(3);
    // 3 个 session × 各 3 个回合；计数随换 session 重置
    expect(adapter.calls).toHaveLength(9);
    expect(store.task("a").sessions).toEqual(["ses-1", "ses-2", "ses-3"]);
    await expect(lockHeld("a")).resolves.toBe(false);
  });
});

describe("runWorker — 崩溃恢复（心跳停 → 接管，controller ruling）", () => {
  it("running + stale legacy lock without execution identity blocks rather than replaying", async () => {
    // README 承诺的自动恢复：崩溃 worker 留下 status=running + stale lock，
    // 下一个 taskctl run 必须接管而不是默默跳过
    const store = FakeStore.seed(
      task({ status: "running", sessions: ["ses-old"], acceptance: "npm test" }),
    );
    await forgeLock("a", "crashed-worker", Date.now() - 605_000); // TTL 600s 已过
    const adapter = new FakeAdapter(() => {
      store.requestDone("a");
      return { sessionId: "ses-new", exitCode: 0, text: "恢复后完成" };
    });
    const sink = eventSink();

    const result = await runWorker(cfg(tasksDir), { store, adapter, acceptance: passGate, ...sink });

    expect(result).toEqual({ done: [], blocked: ["a"] });
    expect(store.task("a").status).toBe("blocked");
    // running 的账本不回退：旧 session 链保留，新 session 追加
    expect(store.task("a").sessions).toEqual(["ses-old"]);
    // 走的是接管路径：takeover 事件在最前
    expect(sink.events[0]).toMatchObject({ type: "blocked", taskId: "a" });
    expect(adapter.calls).toHaveLength(0);
    // 旧锁被归档为 lock.json.stale-<ts>，终态后新锁已释放
    const aux = await readdir(join(tasksDir, "a"));
    expect(aux.some((f) => /^lock\.json\.stale-\d+$/.test(f))).toBe(true);
    await expect(lockHeld("a")).resolves.toBe(false);
  });

  it("running + missing lock also requires reconciliation when execution is unknown", async () => {
    const store = FakeStore.seed(task({ status: "running", acceptance: "npm test" }));
    const adapter = new FakeAdapter(() => {
      store.requestDone("a");
      return { sessionId: "ses-new", exitCode: 0, text: "完成" };
    });
    const sink = eventSink();

    const result = await runWorker(cfg(tasksDir), { store, adapter, acceptance: passGate, ...sink });

    expect(result).toEqual({ done: [], blocked: ["a"] });
    expect(store.task("a").status).toBe("blocked");
    expect(sink.events.map((e) => e.type)).toContain("blocked");
    expect(adapter.calls).toHaveLength(0);
    await expect(lockHeld("a")).resolves.toBe(false);
  });

  it("running + 活锁（他人持有、心跳新鲜）→ 跳过：不 prompt、状态不动、锁不被破坏", async () => {
    const store = FakeStore.seed(task({ status: "running", sessions: ["ses-old"] }));
    await forgeLock("a", "other-worker", Date.now());
    const adapter = new FakeAdapter(() => {
      throw new Error("must not prompt");
    });
    const sink = eventSink();

    const result = await runWorker(cfg(tasksDir), { store, adapter, acceptance: passGate, ...sink });

    expect(result).toEqual({ done: [], blocked: [] });
    expect(adapter.calls).toHaveLength(0);
    expect(store.task("a").status).toBe("running");
    expect(store.task("a").sessions).toEqual(["ses-old"]);
    expect(await readLock("a")).toMatchObject({ worker: "other-worker" });
    expect(sink.events).toHaveLength(0);
  });

  it("接管判定跟随配置的 lockTtlMs：TTL 内的旧心跳不算过期，TTL 外才算", async () => {
    // 5 秒前的心跳：lockTtlMs=600s 视为存活 → 跳过，不 prompt、不动锁
    const store = FakeStore.seed(task({ status: "running" }));
    await forgeLock("a", "slow-worker", Date.now() - 5_000);
    const adapter = new FakeAdapter(() => {
      throw new Error("must not prompt");
    });

    const skipped = await runWorker(cfg(tasksDir), { store, adapter, acceptance: passGate });

    expect(skipped).toEqual({ done: [], blocked: [] });
    expect(adapter.calls).toHaveLength(0);
    expect(await readLock("a")).toMatchObject({ worker: "slow-worker" });

    // 同样 5 秒前的心跳：lockTtlMs=1s 即过期 → 接管续跑到 done
    const store2 = FakeStore.seed(task({ status: "running", acceptance: "npm test" }));
    await forgeLock("a", "slow-worker", Date.now() - 5_000);
    const adapter2 = new FakeAdapter(() => {
      store2.requestDone("a");
      return { sessionId: "ses-new", exitCode: 0, text: "完成" };
    });

    const taken = await runWorker(cfg(tasksDir, { lockTtlMs: 1_000 }), {
      store: store2,
      adapter: adapter2,
      acceptance: passGate,
    });

    expect(taken).toEqual({ done: [], blocked: ["a"] });
    expect(store2.task("a").status).toBe("blocked");
    expect(adapter2.calls).toHaveLength(0);
    await expect(lockHeld("a")).resolves.toBe(false);
  });
});

describe("runWorker — 所有权丢失（heartbeat 布尔化，turn > TTL 场景）", () => {
  it("回合后被新 owner 接管 → 下一次心跳失败即停手：不计失败、不落终态、不动新锁", async () => {
    const store = FakeStore.seed(task({ acceptance: "npm test" }));
    const adapter = new FakeAdapter(async () => {
      // 回合进行期间锁被接管（turnTimeoutMs 30min > lockTtlMs 10min 的现实场景）
      await forgeLock("a", "worker-new", Date.now());
      return { sessionId: "ses-a1", exitCode: 0, text: "回合输出" };
    });
    const acceptance = vi.fn(passGate);
    const sink = eventSink();

    const result = await runWorker(cfg(tasksDir), { store, adapter, acceptance, ...sink });

    // 特殊非重试退出：不计入 done/blocked
    expect(result).toEqual({ done: [], blocked: [] });
    // 不再触碰任务：状态停在 running、不计失败、不跑验收
    expect(store.task("a").status).toBe("running");
    expect(store.task("a").retries).toBe(0);
    expect(acceptance).not.toHaveBeenCalled();
    // 新 owner 的锁原样保留，绝不释放别人的锁
    expect(await readLock("a")).toMatchObject({ worker: "worker-new" });
    expect(sink.events.map((e) => e.type)).toContain("ownership-lost");
    // Stale generations cannot append a session, either.
    expect(store.task("a").sessions).toEqual([]);
    expect(adapter.calls).toHaveLength(1);
  });

  it("验收前心跳发现被接管 → 不跑验收、不动状态、直接停手", async () => {
    const store = FakeStore.seed(task({ acceptance: "npm test" }));
    const adapter = new FakeAdapter(async () => {
      store.requestDone("a");
      // marker 已落、锁被抢：验收关口的心跳必须拦下
      await forgeLock("a", "worker-new", Date.now());
      return { sessionId: "ses-a1", exitCode: 0, text: "完成" };
    });
    const acceptance = vi.fn(passGate);
    const sink = eventSink();

    const result = await runWorker(cfg(tasksDir), { store, adapter, acceptance, ...sink });

    expect(result).toEqual({ done: [], blocked: [] });
    expect(acceptance).not.toHaveBeenCalled();
    expect(store.task("a").status).toBe("running");
    expect(store.task("a").retries).toBe(0);
    expect(await readLock("a")).toMatchObject({ worker: "worker-new" });
    expect(sink.events.map((e) => e.type)).toContain("ownership-lost");
  });
});

describe("runWorker — 逐事件日志（Plan Task 9 / ADR-0006 告警）", () => {
  it("正常路径事件序列：claimed → running → acceptance(passed) → done", async () => {
    const store = FakeStore.seed(task({ acceptance: "npm test" }));
    const adapter = new FakeAdapter(() => {
      store.requestDone("a");
      return { sessionId: "ses-a1", exitCode: 0, text: "完成" };
    });
    const sink = eventSink();

    await runWorker(cfg(tasksDir), { store, adapter, acceptance: passGate, ...sink });

    expect(sink.events.map((e) => e.type)).toEqual(["claimed", "running", "acceptance", "done"]);
    expect(sink.events[0]).toMatchObject({ type: "claimed", taskId: "a" });
    expect(sink.events[2]).toMatchObject({ type: "acceptance", taskId: "a", detail: "passed" });
    expect(sink.events[3]).toMatchObject({ type: "done", taskId: "a" });
  });

  it("missing acceptance requires review instead of silently reaching Done", async () => {
    const store = FakeStore.seed(task({ acceptance: undefined }));
    const adapter = new FakeAdapter(() => {
      store.requestDone("a");
      return { sessionId: "ses-a1", exitCode: 0, text: "完成" };
    });
    const sink = eventSink();

    // 不注入 acceptance seam：走真 runAcceptance，空命令返回 skipped:true
    const result = await runWorker(cfg(tasksDir), { store, adapter, ...sink });

    expect(result).toEqual({ done: [], blocked: ["a"] });
    expect(store.task("a").status).toBe("blocked");
    expect(sink.events.map((e) => e.type)).toEqual(["claimed", "running", "acceptance-skipped", "blocked"]);
    expect(sink.events[2]!.detail).toBeTruthy(); // 告警带说明
  });

  it("失败回合 → turn-failed 事件（带 exit 详情），恢复后仍 done", async () => {
    const store = FakeStore.seed(task({ acceptance: "npm test" }));
    const adapter = new FakeAdapter(() => {
      if (adapter.calls.length === 1) {
        return { sessionId: "ses-a1", exitCode: 1, text: "进程崩了" };
      }
      store.requestDone("a");
      return { sessionId: "ses-a1", exitCode: 0, text: "恢复" };
    });
    const sink = eventSink();

    const result = await runWorker(cfg(tasksDir), { store, adapter, acceptance: passGate, ...sink });

    expect(result).toEqual({ done: ["a"], blocked: [] });
    expect(sink.events.map((e) => e.type)).toEqual([
      "claimed",
      "running",
      "turn-failed",
      "acceptance",
      "done",
    ]);
    expect(sink.events[2]).toMatchObject({ type: "turn-failed", detail: "exit 1" });
  });

  it("R4 交接：wrap-up note 落盘 → handoff 事件（detail = 被交接的 session）", async () => {
    const store = FakeStore.seed(task({ acceptance: "npm test" }));
    const adapter = new FakeAdapter(async (args) => {
      if (args.text === WRAP_UP) {
        await writeNote(tasksDir, {
          task: "a",
          seq: 1,
          status: "进行中",
          done: "第一段",
          found: "",
          next: "第二段继续",
          files: [],
        });
        return { sessionId: args.sessionId!, exitCode: 0, text: "HANDOFF_READY" };
      }
      if (adapter.calls.length === 1) {
        adapter.usage["ses-A"] = 900_000;
        return { sessionId: "ses-A", exitCode: 0, text: "第一回合" };
      }
      store.requestDone("a");
      return { sessionId: "ses-B", exitCode: 0, text: "第二回合完成" };
    });
    const sink = eventSink();

    const result = await runWorker(cfg(tasksDir), { store, adapter, acceptance: passGate, ...sink });

    expect(result).toEqual({ done: ["a"], blocked: [] });
    expect(sink.events.map((e) => e.type)).toEqual(["claimed", "running", "handoff", "acceptance", "done"]);
    expect(sink.events[2]).toMatchObject({ type: "handoff", taskId: "a", detail: "ses-A" });
  });

  it("重试额度耗尽 → blocked 事件（带详情）", async () => {
    const store = FakeStore.seed(task({ acceptance: "npm test" }));
    const adapter = new FakeAdapter(() => {
      store.requestDone("a");
      return { sessionId: `ses-${adapter.calls.length}`, exitCode: 0, text: "声称完成" };
    });
    const acceptance = async (): Promise<AcceptanceResult> => ({
      passed: false,
      exitCode: 1,
      output: "断言失败",
      skipped: false,
    });
    const sink = eventSink();

    const result = await runWorker(cfg(tasksDir, { retryLimit: 1 }), { store, adapter, acceptance, ...sink });

    expect(result).toEqual({ done: [], blocked: ["a"] });
    expect(sink.events.map((e) => e.type)).toEqual(["claimed", "running", "acceptance", "blocked"]);
    expect(sink.events[2]).toMatchObject({ type: "acceptance", detail: "failed (exit 1)" });
    expect(sink.events[3]).toMatchObject({ type: "blocked", taskId: "a" });
    expect(sink.events[3]!.detail).toBeTruthy();
  });
});
