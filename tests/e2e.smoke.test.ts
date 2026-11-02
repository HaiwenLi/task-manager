import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseTaskFile } from "../src/task-file.js";

/**
 * E2E 冒烟：跑完整链路 —— `taskctl run`（真实 CLI 进程）→ OpenCodeAdapter
 * spawn 真实 opencode → agent 在工作目录建 hello.txt、写 note、请求 done →
 * worker 轮询 marker → 验收命令裁决 → 任务落 done。
 *
 * 需要可直接 spawn 的 opencode 与真实 API 凭据，因此不进常规测试运行：
 * 只有 `TASKCTL_E2E=1 npx vitest run tests/e2e.smoke.test.ts` 才执行（绑定约束）。
 */
describe.skipIf(!process.env.TASKCTL_E2E)("E2E 冒烟（真实 opencode）", () => {
  /** 单次真实 agent 回合可达数分钟；验收与 CLI 编排另需余量。 */
  const TEST_TIMEOUT_MS = 600_000;

  let root: string;
  let tasksDir: string;
  let shimsDir: string;
  let configPath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "taskctl-e2e-"));
    tasksDir = join(root, "tasks");
    shimsDir = join(root, "shims");
    await mkdir(tasksDir, { recursive: true });
    configPath = join(root, "taskctl.json");
  });

  afterEach(async () => {
    // 真实 opencode 会留下后台服务进程（持有临时目录的 cwd 句柄），删除可能
    // 暂时 EBUSY：重试几次后放弃即可 —— 目录在系统 temp 下，不影响断言与卫生。
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await rm(root, { recursive: true, force: true });
        return;
      } catch (err) {
        if (!["EBUSY", "EPERM", "ENOTEMPTY"].includes((err as NodeJS.ErrnoException).code ?? "")) {
          throw err;
        }
        await new Promise((sleep) => setTimeout(sleep, 1_000));
      }
    }
  });

  it(
    "hello 任务走通全链路：hello.txt 落盘、status=done、sessions≥1、0001-handoff.md 存在",
    async () => {
      await seedHelloTask();
      await writeShimDir();
      await writeConfig();

      const { exitCode, output } = await runTaskctl(["run", "--config", configPath]);

      expect(output).toContain("[hello] done");
      expect(exitCode).toBe(0);

      // 工件：hello.txt 内容就是任务要求本身
      const hello = join(root, "hello.txt");
      expect(existsSync(hello), `hello.txt 未创建；CLI 输出：\n${output}`).toBe(true);
      expect((await readFile(hello, "utf8")).trim()).toBe("hi");

      // 任务文件：验收通过后由 worker 落 done，session 链至少记下真实会话
      const task = parseTaskFile(await readFile(join(tasksDir, "hello.md"), "utf8"), "hello");
      expect(task.status).toBe("done");
      expect(task.sessions.length).toBeGreaterThanOrEqual(1);

      // 交接笔记：agent 收尾前必须写下的 0001 号 note
      expect(existsSync(join(tasksDir, "hello", "sessions", "0001-handoff.md"))).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  /** 造任务文件：title=创建 hello.txt，acceptance 用客观 existsSync 检查。 */
  async function seedHelloTask(): Promise<void> {
    const fm = [
      "id: hello",
      "title: 创建 hello.txt",
      "status: open",
      `acceptance: node -e "process.exit(require('fs').existsSync('hello.txt')?0:1)"`,
      "sessions: []",
      "retries: 0",
    ].join("\n");
    const description = [
      "在工作目录创建 `hello.txt`，内容为 `hi`。",
      "",
      "收尾时按顺序执行：",
      "1. 运行一次 taskctl note 记录一句话状态（--status/--done/--found/--next 内容自拟）",
      "2. 确认 hello.txt 已创建后，运行 taskctl done",
      "",
    ].join("\n");
    await writeFile(join(tasksDir, "hello.md"), `---\n${fm}\n---\n${description}`, "utf8");
  }

  /** 写 taskctl.json：指向本临时目录与可 spawn 的 opencode 二进制。 */
  async function writeConfig(): Promise<void> {
    const config = {
      tasksDir,
      workdir: root,
      agent: "opencode",
      opencodeBin: resolveOpencodeBin(),
    };
    await writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
  }

  /**
   * 往 PATH 前部注入一个 `taskctl` shim 目录：协议文案要求 agent 运行
   * `taskctl done/note`，本仓库未发布到全局，shim 把命令转发到仓库内的
   * `src/main.ts`（经仓库自带 tsx）。三种形式覆盖 agent 可能用到的
   * shell（cmd / PowerShell / sh）。
   */
  async function writeShimDir(): Promise<void> {
    const repoRoot = fileURLToPath(new URL("..", import.meta.url));
    const tsxCli = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
    const mainTs = join(repoRoot, "src", "main.ts");
    for (const path of [tsxCli, mainTs]) {
      if (!existsSync(path)) {
        throw new Error(`E2E 前置检查失败：${path} 不存在`);
      }
    }
    const posix = (p: string): string => p.replaceAll("\\", "/");
    await mkdir(shimsDir, { recursive: true });
    await writeFile(
      join(shimsDir, "taskctl"),
      `#!/bin/sh\nexec node "${posix(tsxCli)}" "${posix(mainTs)}" "$@"\n`,
      "utf8",
    );
    if (process.platform === "win32") {
      await writeFile(join(shimsDir, "taskctl.cmd"), `@node "${tsxCli}" "${mainTs}" %*\n`, "utf8");
      await writeFile(
        join(shimsDir, "taskctl.ps1"),
        `& node '${posix(tsxCli)}' '${posix(mainTs)}' @args\nexit $LASTEXITCODE\n`,
        "utf8",
      );
    }
  }

  /**
   * 以独立进程跑真实 CLI（`node tsx src/main.ts …`），PATH 带上 shim 目录
   * —— worker spawn 的 opencode 及其 shell 工具继承这份环境，`taskctl`
   * 才可解析。env 里的大小写 Path 变体先清掉，避免子进程看到两个 PATH。
   */
  async function runTaskctl(args: string[]): Promise<{ exitCode: number | null; output: string }> {
    const repoRoot = fileURLToPath(new URL("..", import.meta.url));
    const tsxCli = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === "path") {
        delete env[key];
      }
    }
    env.PATH = `${shimsDir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`;

    const child = spawn(process.execPath, [tsxCli, join(repoRoot, "src", "main.ts"), ...args], {
      cwd: root,
      env,
      shell: false,
    });
    child.stdin?.end();
    const chunks: Uint8Array[] = [];
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk));
    const output = (): string => Buffer.concat(chunks).toString("utf8");
    return new Promise((resolveExit) => {
      child.on("error", (err) => {
        throw new Error(`CLI 进程启动失败：${err.message}；已有输出：\n${output()}`);
      });
      child.on("close", (code) => resolveExit({ exitCode: code, output: output() }));
    });
  }
});

/**
 * 可直接 spawn（shell:false）的 opencode 二进制。npm 全局安装的
 * `opencode` 是 .cmd shim，Windows 下无法以 shell:false 启动（EINVAL），
 * 因此绕到 shim 背后的真实 exe；其它平台直接用 PATH 上的 `opencode`。
 * 任意平台都可用 TASKCTL_OPENCODE_BIN 覆盖。
 */
function resolveOpencodeBin(): string {
  const override = process.env.TASKCTL_OPENCODE_BIN;
  if (override) {
    return override;
  }
  if (process.platform !== "win32") {
    return "opencode";
  }
  const exe = resolve(process.env.APPDATA ?? "", "npm", "node_modules", "@opencode", "cli", "bin", "opencode.exe");
  if (!existsSync(exe)) {
    throw new Error(
      `未找到可 spawn 的 opencode（${exe} 不存在）。npm .cmd shim 不能以 shell:false 启动；` +
        "请设置 TASKCTL_OPENCODE_BIN 指向真实二进制后再跑 E2E。",
    );
  }
  return exe;
}
