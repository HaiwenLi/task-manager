import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { OpenCodeAdapter } from "../../src/adapters/opencode.js";

/**
 * The fake opencode CLI, driven through the preflight-ruled constructor
 * shape: spawn file is node itself, the script path rides in binArgsPrefix.
 * `process.execPath` is this process's node binary — the "node" the brief
 * prescribes, resolved without PATH lookups.
 */
const fakeScript = fileURLToPath(new URL("./fake-opencode.mjs", import.meta.url));

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "taskctl-opencode-"));
});

afterEach(async () => {
  delete process.env.FAKE_ARGV_FILE;
  delete process.env.FAKE_EXIT_CODE;
  delete process.env.FAKE_CWD_MARKER;
  delete process.env.FAKE_STDERR_TEXT;
  delete process.env.FAKE_STDERR_REPEAT;
  await rm(cwd, { recursive: true, force: true });
});

function makeAdapter(): OpenCodeAdapter {
  return new OpenCodeAdapter({ bin: process.execPath, binArgsPrefix: [fakeScript] });
}

/** Point the fake's argv dump at <cwd>/argv-<name>.json and return the path. */
function captureArgv(name: string): string {
  const file = join(cwd, `argv-${name}.json`);
  process.env.FAKE_ARGV_FILE = file;
  return file;
}

async function readArgv(file: string): Promise<string[]> {
  return JSON.parse(await readFile(file, "utf8")) as string[];
}

describe("OpenCodeAdapter.prompt", () => {
  it("returns the stream sessionId, concatenated text events and exit 0", async () => {
    // 首个含 sessionID 的行记录 id；type:"text" 的 text 字段按序拼接；
    // 无法 JSON.parse 的行被跳过；进程退出码 0 即回合成功
    const result = await makeAdapter().prompt({ text: "请完成任务A", cwd });

    expect(result).toEqual({ sessionId: "ses_fake123", exitCode: 0, text: "你好，任务完成" });
  });

  it("spawns run with the exact argv: format, session, model#effort, title, auto", async () => {
    const argvFile = captureArgv("full");

    await makeAdapter().prompt({
      sessionId: "ses_resume9",
      text: "请完成任务A",
      model: "anthropic/sonnet",
      effort: "high",
      title: "任务A",
      cwd,
    });

    // model+effort 拼成 --model provider/model#variant，且整体 argv 与约定逐项一致
    await expect(readArgv(argvFile)).resolves.toEqual([
      "run",
      "--format",
      "json",
      "--session",
      "ses_resume9",
      "--model",
      "anthropic/sonnet#high",
      "--title",
      "任务A",
      "--auto",
      "请完成任务A",
    ]);
  });

  it("omits --session/--model/--title when not given and skips #effort without effort", async () => {
    const bare = captureArgv("bare");
    await makeAdapter().prompt({ text: "hi", cwd });
    await expect(readArgv(bare)).resolves.toEqual(["run", "--format", "json", "--auto", "hi"]);

    const modeled = captureArgv("model");
    await makeAdapter().prompt({ text: "hi", model: "openai/gpt", cwd });
    await expect(readArgv(modeled)).resolves.toEqual([
      "run",
      "--format",
      "json",
      "--model",
      "openai/gpt",
      "--auto",
      "hi",
    ]);
  });

  it("resolves with exitCode 1 instead of rejecting when the turn fails", async () => {
    // Review Focus 4：退出码非 0 是回合失败，不是调用方异常
    process.env.FAKE_EXIT_CODE = "1";

    const result = await makeAdapter().prompt({ text: "会失败的回合", cwd });

    expect(result).toMatchObject({ sessionId: "ses_fake123", exitCode: 1 });
  });

  it("runs the turn with cwd as working directory", async () => {
    process.env.FAKE_CWD_MARKER = "1";

    await makeAdapter().prompt({ text: "hi", cwd });

    await expect(readFile(join(cwd, "fake-cwd-marker.txt"), "utf8")).resolves.toBe("x");
  });

  it("rejects when the binary cannot be spawned at all", async () => {
    // spawn error（如 bin 不存在）是环境故障，不是回合结果
    const broken = new OpenCodeAdapter({ bin: "taskctl-no-such-binary" });

    await expect(broken.prompt({ text: "hi", cwd })).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("drains stderr: 512KB 噪声不挂起回合，失败回合的 text 附带 stderr 摘要", async () => {
    // 真实 opencode 会在 stderr 吐 auth 告警/LSP 日志；不排干管道缓冲区
    // 会让子进程永久阻塞。此处一次写远超任何管道缓冲区的量级。
    process.env.FAKE_STDERR_TEXT = "auth warning: token expired; ";
    process.env.FAKE_STDERR_REPEAT = "16384"; // ≈512KB
    process.env.FAKE_EXIT_CODE = "1";

    const result = await makeAdapter().prompt({ text: "会失败的回合", cwd });

    expect(result.exitCode).toBe(1);
    expect(result.text).toContain("[stderr]");
    expect(result.text).toContain("auth warning: token expired;");
  });

  it("成功回合不受 stderr 噪声影响（drain 但不拼入 text）", async () => {
    process.env.FAKE_STDERR_TEXT = "LSP log noise\n";
    process.env.FAKE_STDERR_REPEAT = "16384";

    const result = await makeAdapter().prompt({ text: "正常回合", cwd });

    expect(result).toEqual({ sessionId: "ses_fake123", exitCode: 0, text: "你好，任务完成" });
  });
});

describe("OpenCodeAdapter.contextUsage", () => {
  it("sums input+output+reasoning+cache.read+cache.write from session.get", async () => {
    const argvFile = captureArgv("session-get");

    await expect(makeAdapter().contextUsage("ses_fake123")).resolves.toBe(1375);

    // 控制面调用形态：api session.get --param sessionID=<id>
    await expect(readArgv(argvFile)).resolves.toEqual([
      "api",
      "session.get",
      "--param",
      "sessionID=ses_fake123",
    ]);
  });

  it("api 面同样排干 stderr：噪声再大也不阻塞遥测调用", async () => {
    process.env.FAKE_STDERR_TEXT = "LSP log noise\n";
    process.env.FAKE_STDERR_REPEAT = "16384"; // ≈512KB

    await expect(makeAdapter().contextUsage("ses_fake123")).resolves.toBe(1375);
  });
});

describe("OpenCodeAdapter.contextLimit", () => {
  it("matches provider/model against ${providerID}/${id}", async () => {
    const argvFile = captureArgv("model-list");

    await expect(makeAdapter().contextLimit("anthropic/sonnet")).resolves.toBe(200000);

    await expect(readArgv(argvFile)).resolves.toEqual(["api", "model.list"]);
  });

  it("falls back to a bare id match when the model carries no known provider", async () => {
    // 裸 id：model 不带 provider 时按去掉 provider 后的名字匹配
    await expect(makeAdapter().contextLimit("local-model")).resolves.toBe(8192);
    // 别名前缀：provider 对不上时同样回退到裸 id
    await expect(makeAdapter().contextLimit("someone-else/local-model")).resolves.toBe(8192);
  });

  it("rejects when no listed model matches", async () => {
    // 找不到模型是配置错误：宁可失败也不要悄悄返回 0 让预算检查失效
    await expect(makeAdapter().contextLimit("nope/unknown")).rejects.toThrow(/unknown/i);
  });
});
