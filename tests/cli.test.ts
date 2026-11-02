import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "../src/cli.js";
import { latestNote } from "../src/handoff.js";
import { parseTaskFile } from "../src/task-file.js";
import { TaskStore } from "../src/task-store.js";
import type { AgentAdapter } from "../src/adapters/types.js";

type PromptArgs = Parameters<AgentAdapter["prompt"]>[0];
type PromptResult = Awaited<ReturnType<AgentAdapter["prompt"]>>;

/** 记录型 fake adapter：空队列不应触发任何调用。 */
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
    await writeFile(
      join(this.markerTasksDir, "t1", "done.requested"),
      new Date().toISOString(),
      "utf8",
    );
    return result;
  }
}

let dir: string;
let tasksDir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "taskctl-cli-"));
  tasksDir = join(dir, "tasks");
  await mkdir(tasksDir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

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

/** 手写一个合法任务文件（不依赖 serializeTaskFile 的具体排版）。 */
async function seedTask(
  id: string,
  fields: { status?: string; sessions?: string[]; retries?: number } = {},
): Promise<void> {
  const { status = "open", sessions = [], retries = 0 } = fields;
  const fm = [
    `id: ${id}`,
    `title: 任务${id}`,
    `status: ${status}`,
    `sessions: [${sessions.join(", ")}]`,
    `retries: ${retries}`,
  ].join("\n");
  await writeFile(join(tasksDir, `${id}.md`), `---\n${fm}\n---\n正文\n`, "utf8");
}

async function writeConfig(config: unknown, name = "taskctl.json"): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, typeof config === "string" ? config : JSON.stringify(config), "utf8");
  return path;
}

describe("taskctl done", () => {
  it("写 tasks/<id>/done.requested（内容 = ISO 时间）并打印路径", async () => {
    const cap = capture();
    const code = await runCli(["done", "--task", "a", "--tasks-dir", tasksDir], cap.deps);

    expect(code).toBe(0);
    const marker = join(tasksDir, "a", "done.requested");
    const raw = await readFile(marker, "utf8");
    expect(raw).toBe(new Date(raw).toISOString()); // 合法 ISO，无多余字符
    expect(cap.lines[0]).toBe(marker);
    await expect(new TaskStore(tasksDir).readDoneMarker("a")).resolves.toBe(true);
  });

  it("缺 --task → 用法错误 exit 2，不写任何文件", async () => {
    const cap = capture();
    const code = await runCli(["done", "--tasks-dir", tasksDir], cap.deps);

    expect(code).toBe(2);
    expect(cap.errors.join("\n")).toContain("--task");
  });
});

describe("taskctl note", () => {
  it("Review Focus 5：换行/引号/中文逐字写入 note 文件", async () => {
    const status = "进行中——含中文标点";
    const done = "完成 'done' 子命令";
    const found = '发现 "引用" 与\n换行';
    const next = '修复\n缓存"引用"问题';
    const cap = capture();
    const code = await runCli(
      [
        "note",
        "--task",
        "a",
        "--status",
        status,
        "--done",
        done,
        "--found",
        found,
        "--next",
        next,
        "--tasks-dir",
        tasksDir,
      ],
      cap.deps,
    );

    expect(code).toBe(0);
    const path = join(tasksDir, "a", "sessions", "0001-handoff.md");
    const raw = await readFile(path, "utf8");
    expect(raw).toContain(`## Status\n${status}`);
    expect(raw).toContain(`## Done\n${done}`);
    expect(raw).toContain(`## Found\n${found}`);
    expect(raw).toContain(`## Next\n${next}`);
    expect(cap.lines[0]).toBe(path);
    expect((await latestNote(tasksDir, "a"))!.markdown).toContain(`## Next\n${next}`);
  });

  it("seq = latestNote.seq + 1：连续两条 note 编号递增", async () => {
    const base = ["--task", "a", "--status", "s", "--done", "d", "--found", "f", "--next", "n", "--tasks-dir", tasksDir];
    const cap = capture();
    await runCli(["note", ...base], cap.deps);
    const code = await runCli(["note", ...base], cap.deps);

    expect(code).toBe(0);
    await expect(readFile(join(tasksDir, "a", "sessions", "0001-handoff.md"), "utf8")).resolves.toContain("seq: 1");
    await expect(readFile(join(tasksDir, "a", "sessions", "0002-handoff.md"), "utf8")).resolves.toContain("seq: 2");
    expect((await latestNote(tasksDir, "a"))!.seq).toBe(2);
    expect(cap.lines.at(-1)).toBe(join(tasksDir, "a", "sessions", "0002-handoff.md"));
  });

  it("--files 逗号分隔渲染为无序列表；缺省为空", async () => {
    const cap = capture();
    await runCli(
      [
        "note",
        "--task",
        "a",
        "--status",
        "s",
        "--done",
        "d",
        "--found",
        "f",
        "--next",
        "n",
        "--files",
        "src/a.ts, src/b.ts",
        "--tasks-dir",
        tasksDir,
      ],
      cap.deps,
    );

    const raw = await readFile(cap.lines[0]!, "utf8");
    expect(raw).toContain("## Files\n- src/a.ts\n- src/b.ts");
  });

  it("缺必需 flag（--next）→ 用法错误 exit 2", async () => {
    const cap = capture();
    const code = await runCli(
      ["note", "--task", "a", "--status", "s", "--done", "d", "--found", "f", "--tasks-dir", tasksDir],
      cap.deps,
    );

    expect(code).toBe(2);
    expect(cap.errors.join("\n")).toContain("--next");
  });
});

describe("taskctl status", () => {
  it("表格输出每任务：id、status、retries、sessions 数、最新 note 的 Status 行（捕获 console）", async () => {
    await seedTask("alpha", { status: "running", sessions: ["s1", "s2"], retries: 1 });
    await seedTask("beta");
    await runCli(
      [
        "note",
        "--task",
        "alpha",
        "--status",
        "锁与心跳已续期",
        "--done",
        "d",
        "--found",
        "f",
        "--next",
        "n",
        "--tasks-dir",
        tasksDir,
      ],
      { log: () => {}, err: () => {} },
    );

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await runCli(["status", "--tasks-dir", tasksDir]);

    expect(code).toBe(0);
    const out = spy.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(out).toContain("id");
    expect(out).toContain("status");
    expect(out).toContain("retries");
    expect(out).toContain("sessions");
    expect(out).toContain("note");
    expect(out).toContain("alpha");
    expect(out).toContain("running");
    expect(out).toContain("锁与心跳已续期");
    expect(out).toContain("beta");
    expect(out).toContain("-"); // beta 无 note
  });

  it("tasks 目录不存在 → exit 1", async () => {
    const cap = capture();
    const code = await runCli(["status", "--tasks-dir", join(dir, "nope")], cap.deps);

    expect(code).toBe(1);
    expect(cap.errors.length).toBeGreaterThan(0);
  });
});

describe("taskctl run", () => {
  it("空队列返回 0，不触发 adapter", async () => {
    const config = await writeConfig({ tasksDir });
    const adapter = new FakeAdapter();
    const cap = capture();

    const code = await runCli(["run", "--config", config], { adapter, ...cap.deps });

    expect(code).toBe(0);
    expect(adapter.calls).toHaveLength(0);
    expect(cap.lines).toHaveLength(0);
  });

  it("real store + completion request without checks blocks for review", async () => {
    await seedTask("t1");
    const config = await writeConfig({ tasksDir, workdir: dir });
    const adapter = new DoneMarkingAdapter(tasksDir);
    const cap = capture();

    const code = await runCli(["run", "--config", config], { adapter, ...cap.deps });

    expect(code).toBe(0);
    // 逐事件日志（Plan Task 9）：claimed → running → … → done 依次单行打印
    expect(cap.lines).toContain("[t1] claimed");
    expect(cap.lines).toContain("[t1] running");
    // t1 无 acceptance 字段 → ADR-0006 告警放行
    expect(cap.lines.some((line) => line.startsWith("[t1] acceptance-skipped "))).toBe(true);
    expect(cap.lines.some(line => line.startsWith("[t1] blocked "))).toBe(true);
    expect(cap.lines).not.toContain("[t1] done");
    const task = parseTaskFile(await readFile(join(tasksDir, "t1.md"), "utf8"), "t1");
    expect(task.status).toBe("blocked");
    expect(task.sessions.length).toBeGreaterThanOrEqual(1);
  });

  it("非法 JSON 配置 → exit 1", async () => {
    const config = await writeConfig("{", "broken.json");
    const cap = capture();

    const code = await runCli(["run", "--config", config], cap.deps);

    expect(code).toBe(1);
    expect(cap.errors.join("\n")).toContain("invalid JSON");
  });

  it("未知 agent → exit 1（v0.1 只有 opencode）", async () => {
    const config = await writeConfig({ tasksDir, agent: "kimi" });
    const cap = capture();

    const code = await runCli(["run", "--config", config], cap.deps);

    expect(code).toBe(1);
    expect(cap.errors.join("\n")).toContain("agent");
  });

  it("未知子命令 / 未知 flag → exit 2", async () => {
    const cap = capture();
    await expect(runCli(["frobnicate"], cap.deps)).resolves.toBe(2);
    await expect(runCli(["status", "--wat", "x", "--tasks-dir", tasksDir], cap.deps)).resolves.toBe(2);
    expect(cap.errors.join("\n")).toContain("frobnicate");
  });
});

describe("样例文件", () => {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));

  it("taskctl.json 可解析且字段类型合法", async () => {
    const raw: unknown = JSON.parse(await readFile(join(repoRoot, "taskctl.json"), "utf8"));
    expect(typeof raw).toBe("object");
    const config = raw as Record<string, unknown>;
    expect(config.agent).toBe("opencode");
    expect(config.contextThreshold).toBeTypeOf("number");
    expect(config.retryLimit).toBeTypeOf("number");
    expect(config.lockTtlMs).toBeTypeOf("number");
    expect(config.heartbeatMs).toBeTypeOf("number");
  });

  it("tasks/example.md 可被 parseTaskFile 解析", async () => {
    const task = parseTaskFile(await readFile(join(repoRoot, "tasks", "example.md"), "utf8"), "example");
    expect(task.id).toBe("example");
    expect(task.status).toBe("open");
    expect(task.title.length).toBeGreaterThan(0);
    expect(task.retries).toBe(0);
  });
});
