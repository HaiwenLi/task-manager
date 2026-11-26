import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { OpenCodeAdapter } from "../../src/adapters/opencode.js";
import type { CatalogueModel } from "../../src/adapters/types.js";
import { classify } from "../../src/budget.js";

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
  delete process.env.FAKE_API_LOG;
  delete process.env.FAKE_SESSION_STATUS;
  delete process.env.FAKE_SESSION_PROVIDER;
  delete process.env.FAKE_SESSION_MODEL;
  delete process.env.FAKE_SESSION_CWD;
  delete process.env.FAKE_SESSION_MODELS;
  delete process.env.FAKE_MESSAGES_OLDEST_FIRST;
  delete process.env.FAKE_SESSION_MODEL_IN_GET;
  delete process.env.FAKE_MESSAGE_LIST_FAILS;
  delete process.env.FAKE_PROVIDER_NOROUTE;
  delete process.env.FAKE_PROVIDER_RETRY;
  delete process.env.FAKE_PROVIDER_UNAVAILABLE;
  delete process.env.FAKE_ERROR_UNTYPED;
  delete process.env.FAKE_ERROR_EVENTS;
  delete process.env.FAKE_MODEL_LIST_FAILS_ONCE;
  delete process.env.FAKE_MODEL_LIST_EMPTY_ONCE;
  delete process.env.FAKE_MODEL_DEFAULT_FAILS_ONCE;
  delete process.env.FAKE_MODEL_DEFAULT_NONE;
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
    // 首个含 sessionID 的行记录 id；text 事件按序拼接（含 opencode >= 2.2 的
    // part.text 形状）；无法 JSON.parse 的行被跳过；进程退出码 0 即回合成功
    const result = await makeAdapter().prompt({ text: "请完成任务A", cwd });

    expect(result).toEqual({ sessionId: "ses_fake123", exitCode: 0, text: "你好，任务完成。" });
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

  it("merges args.env over the inherited environment of the worker process", async () => {
    // C1：worker 进程里要能看到 TASKCTL_TASK_DIR / TASKCTL_LOG_DIR。
    // 用 node -e 当假后端：把收到的环境变量落盘，证明 env 真的进了子进程。
    const dump = join(cwd, "env-dump.json");
    const script = `require('fs').writeFileSync(${JSON.stringify(dump)}, JSON.stringify({ taskDir: process.env.TASKCTL_TASK_DIR ?? '(unset)', logDir: process.env.TASKCTL_LOG_DIR ?? '(unset)' }))`;
    const adapter = new OpenCodeAdapter({ bin: process.execPath, binArgsPrefix: ["-e", script] });

    const result = await adapter.prompt({
      text: "hi",
      cwd,
      env: { TASKCTL_TASK_DIR: join(cwd, "task-a"), TASKCTL_LOG_DIR: join(cwd, "task-a", "logs") },
    });

    expect(result.exitCode).toBe(0);
    await expect(readFile(dump, "utf8")).resolves.toEqual(
      JSON.stringify({ taskDir: join(cwd, "task-a"), logDir: join(cwd, "task-a", "logs") }),
    );
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

    expect(result).toEqual({ sessionId: "ses_fake123", exitCode: 0, text: "你好，任务完成。" });
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

  it("does not keep a failed model.list for the life of the adapter", async () => {
    // 常驻的 watch 里 adapter 与进程同寿：一次失败的控制面调用若被缓存成空目录，
    // context budget 与变体解析会在整个生命周期内静默失效。失败只影响看到它的那一次调用。
    const log = join(cwd, "api-calls.log");
    process.env.FAKE_API_LOG = log;
    process.env.FAKE_MODEL_LIST_FAILS_ONCE = join(cwd, "model-list-failed.once");
    const adapter = makeAdapter();

    await expect(adapter.contextLimit("anthropic/sonnet")).rejects.toThrow(/unknown/i);
    await expect(adapter.contextLimit("anthropic/sonnet")).resolves.toBe(200000);

    expect((await readFile(log, "utf8")).trim().split(/\r?\n/)).toEqual(["api model.list", "api model.list"]);
  });

  it("rejects when no listed model matches", async () => {
    // 找不到模型是配置错误：宁可失败也不要悄悄返回 0 让预算检查失效
    await expect(makeAdapter().contextLimit("nope/unknown")).rejects.toThrow(/unknown/i);
  });

  it("shares one model.list catalogue across variants and context limits", async () => {
    const log = join(cwd, "api-calls.log");
    process.env.FAKE_API_LOG = log;
    const adapter = makeAdapter();

    await adapter.resolveModel("openai/gpt", "high");
    await expect(adapter.contextLimit("openai/gpt")).resolves.toBe(128000);
    await adapter.resolveModel("anthropic/sonnet", "high");
    await expect(adapter.contextLimit("anthropic/sonnet")).resolves.toBe(200000);

    const calls = (await readFile(log, "utf8")).trim().split(/\r?\n/);
    expect(calls.filter((line) => line === "api model.list")).toHaveLength(1);
  });
});

describe("OpenCodeAdapter session status and usage", () => {
  it("maps idle, active and unavailable sessions to reuse decisions", async () => {
    const adapter = makeAdapter();
    process.env.FAKE_SESSION_STATUS = "idle";
    process.env.FAKE_SESSION_CWD = cwd;
    await expect(adapter.canResumeSession("ses_fake123", { model: "anthropic/sonnet", cwd })).resolves.toBe("reusable");

    process.env.FAKE_SESSION_STATUS = "active";
    await expect(adapter.canResumeSession("ses_fake123", { model: "anthropic/sonnet", cwd })).resolves.toBe("active");

    process.env.FAKE_SESSION_STATUS = "missing";
    await expect(adapter.canResumeSession("ses_fake123", { model: "anthropic/sonnet", cwd })).resolves.toBe("unavailable");
  });

  it("returns a structured usage snapshot rather than only a token sum", async () => {
    await expect(makeAdapter().sessionUsage("ses_fake123")).resolves.toMatchObject({
      input: 1000, output: 200, reasoning: 100,
      cacheRead: 50, cacheWrite: 25, cost: 0.25,
      model: "anthropic/sonnet",
    });
  });

  // 真实服务 v2.4.1（2026-11-24 Live 核实）：session.get 只回
  // id/projectID/cost/tokens/outcome/time/title/location，没有 model；
  // 模型只在 assistant 消息上。只读 session.get 的探测在真实后端上恒为 unavailable。
  it("derives the model from the newest assistant message when session.get omits it", async () => {
    const log = join(cwd, "api-calls.log");
    process.env.FAKE_API_LOG = log;
    const argvFile = captureArgv("message-list");
    process.env.FAKE_SESSION_STATUS = "idle";
    process.env.FAKE_SESSION_CWD = cwd;

    await expect(makeAdapter().canResumeSession("ses_fake123", { model: "anthropic/sonnet", cwd })).resolves.toBe("reusable");

    expect((await readFile(log, "utf8")).trim().split(/\r?\n/)).toEqual(["api session.get", "api session.message.list"]);
    await expect(readArgv(argvFile)).resolves.toEqual([
      "api", "session.message.list", "--param", "sessionID=ses_fake123", "--param", "limit=8",
    ]);
  });

  it("refuses reuse when the newest assistant message names another model", async () => {
    process.env.FAKE_SESSION_STATUS = "idle";
    process.env.FAKE_SESSION_CWD = cwd;
    process.env.FAKE_SESSION_MODEL = "opus";

    await expect(makeAdapter().canResumeSession("ses_fake123", { model: "anthropic/sonnet", cwd })).resolves.toBe("unavailable");
  });

  it("lets the newest assistant message decide after a mid-session model switch, whatever the listing order", async () => {
    process.env.FAKE_SESSION_STATUS = "idle";
    process.env.FAKE_SESSION_CWD = cwd;
    process.env.FAKE_SESSION_MODELS = JSON.stringify(["openai/gpt", "anthropic/sonnet"]);
    const adapter = makeAdapter();

    await expect(adapter.canResumeSession("ses_fake123", { model: "anthropic/sonnet", cwd })).resolves.toBe("reusable");
    await expect(adapter.canResumeSession("ses_fake123", { model: "openai/gpt", cwd })).resolves.toBe("unavailable");

    process.env.FAKE_MESSAGES_OLDEST_FIRST = "1";
    await expect(adapter.canResumeSession("ses_fake123", { model: "anthropic/sonnet", cwd })).resolves.toBe("reusable");
  });

  it("leaves a session without an assistant turn unavailable and its usage without a model", async () => {
    process.env.FAKE_SESSION_STATUS = "idle";
    process.env.FAKE_SESSION_CWD = cwd;
    process.env.FAKE_SESSION_MODELS = "[]";
    const adapter = makeAdapter();

    await expect(adapter.canResumeSession("ses_fake123", { model: "anthropic/sonnet", cwd })).resolves.toBe("unavailable");
    const usage = await adapter.sessionUsage("ses_fake123");
    expect(usage).toMatchObject({ input: 1000, output: 200 });
    expect("model" in usage).toBe(false);
  });

  it("refuses reuse when the reply proves neither a busy nor an idle session", async () => {
    // 真实服务 v2.4.1（2026-11-24 Live 核实）：运行中的 session 只有 time.busy，
    // 结束后盖 time.idle。两者都没有的回复是「不确定」，而探测的职责恰恰是
    // 挡住第二个 worker——不能因为认不出形态就放行。
    process.env.FAKE_SESSION_STATUS = "unknown";
    process.env.FAKE_SESSION_CWD = cwd;

    await expect(makeAdapter().canResumeSession("ses_fake123", { model: "anthropic/sonnet", cwd })).resolves.toBe("unavailable");
  });

  it("still reads a session.get that carries the model, as services before 2.4 did", async () => {
    const log = join(cwd, "api-calls.log");
    process.env.FAKE_API_LOG = log;
    process.env.FAKE_SESSION_MODEL_IN_GET = "1";
    process.env.FAKE_SESSION_STATUS = "idle";
    process.env.FAKE_SESSION_CWD = cwd;

    await expect(makeAdapter().canResumeSession("ses_fake123", { model: "anthropic/sonnet", cwd })).resolves.toBe("reusable");

    expect((await readFile(log, "utf8")).trim().split(/\r?\n/)).toEqual(["api session.get"]);
  });

  it("keeps token usage and refuses reuse when the service cannot list messages", async () => {
    process.env.FAKE_MESSAGE_LIST_FAILS = "1";
    process.env.FAKE_SESSION_STATUS = "idle";
    process.env.FAKE_SESSION_CWD = cwd;
    const adapter = makeAdapter();

    await expect(adapter.sessionUsage("ses_fake123")).resolves.toMatchObject({ input: 1000, output: 200 });
    await expect(adapter.canResumeSession("ses_fake123", { model: "anthropic/sonnet", cwd })).resolves.toBe("unavailable");
  });
});

/**
 * An adapter whose `api <operation>` answers one fixed envelope, for shapes
 * the shared fake does not have. Like the fake, it is `node` itself with the
 * script riding in `binArgsPrefix` (`node -e <script> api <operation>`).
 */
function answering(operation: string, data: string): OpenCodeAdapter {
  const script = `if (process.argv.includes(${JSON.stringify(operation)})) process.stdout.write(JSON.stringify({ location: { directory: "." }, data: ${data} })); else process.exitCode = 2;`;
  return new OpenCodeAdapter({ bin: process.execPath, binArgsPrefix: ["-e", script] });
}

describe("OpenCodeAdapter.modelCatalog", () => {
  it("tells an empty cost list from a zero cost", async () => {
    const adapter = makeAdapter();
    const catalogue = await adapter.modelCatalog!();
    expect(catalogue.find((m) => m.ref === "anthropic/sonnet")).toMatchObject({ cost: [{ input: 0, output: 0 }], enabled: true, variants: [] });
    expect(catalogue.find((m) => m.ref === "anthropic/opus")).toMatchObject({ cost: [{ input: 15, output: 75 }] });
    expect(catalogue.find((m) => m.ref === "ollama/local-model")?.cost).toEqual([]);
    expect(catalogue.find((m) => m.ref === "openai/gpt")?.variants).toEqual(["low", "high"]);
  });

  it("keys the catalogue by provider and id and keeps the modelID", async () => {
    const adapter = makeAdapter();
    const ofP = (await adapter.modelCatalog!()).filter((m) => m.providerID === "p");
    expect(ofP).toHaveLength(1);
    expect(ofP[0]).toMatchObject({ ref: "p/k", id: "k", modelID: "k-alias" });
  });

  it("never exposes credentials from the catalogue", async () => {
    const adapter = makeAdapter();
    const text = JSON.stringify(await adapter.modelCatalog!());
    expect(text).not.toMatch(/apiKey|headers|sk-/);
  });

  it("rejects when the fetch fails, remembers nothing, and recovers", async () => {
    // FAKE_MODEL_LIST_FAILS_ONCE naming a fresh marker file, as the failed-fetch test above does
    process.env.FAKE_MODEL_LIST_FAILS_ONCE = join(cwd, "model-list-failed.once");
    const adapter = makeAdapter();
    const failure = await adapter.modelCatalog!().catch((error: unknown) => error);
    // The operation and the exit code, and not one word of what the service printed: its stderr can quote
    // configuration, and the budget guard puts the start of this message into its reason, the journal and the log.
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("opencode api model.list failed: exit 1");
    expect((failure as Error).message).not.toContain("service unreachable");
    // The original is kept as the cause, for whoever reads the failure up close.
    expect((failure as Error).cause).toBeInstanceOf(Error);
    expect(((failure as Error).cause as Error).message).toContain("service unreachable");
    expect((await adapter.modelCatalog!()).length).toBeGreaterThan(0);
  });

  it("treats an answer with no models as a failure and asks again", async () => {
    // FAKE_MODEL_LIST_EMPTY_ONCE naming a fresh marker file
    process.env.FAKE_MODEL_LIST_EMPTY_ONCE = join(cwd, "model-list-empty.once");
    const adapter = makeAdapter();
    await expect(adapter.modelCatalog!()).rejects.toThrow(/no models/);
    expect((await adapter.modelCatalog!()).length).toBeGreaterThan(0);
  });

  // Beyond the plan's five catalogue tests: shapes it states for the two
  // methods that the shared fake cannot show by itself.

  it("answers one entry per provider and id, sorted by ref, built from the named fields only", async () => {
    const catalogue = await makeAdapter().modelCatalog!();
    expect(catalogue.map((m) => m.ref)).toEqual(["anthropic/opus", "anthropic/sonnet", "ollama/local-model", "openai/gpt", "p/k"]);
    // local-model names no modelID, no enabled and no variants: modelID is its id (as for most models), enabled is true, variants and cost are empty.
    expect(catalogue.find((m) => m.ref === "ollama/local-model")).toStrictEqual({
      ref: "ollama/local-model", providerID: "ollama", id: "local-model", modelID: "local-model", variants: [], cost: [], enabled: true,
    });
    for (const model of catalogue) {
      expect(Object.keys(model).sort()).toEqual(["cost", "enabled", "id", "modelID", "providerID", "ref", "variants"]);
    }
  });

  it("reads the same memoised model.list as the context and variant lookups", async () => {
    const log = join(cwd, "api-calls.log");
    process.env.FAKE_API_LOG = log;
    const adapter = makeAdapter();

    await expect(adapter.contextLimit("openai/gpt")).resolves.toBe(128000);
    await adapter.resolveModel("anthropic/sonnet", "high");
    expect((await adapter.modelCatalog!()).length).toBeGreaterThan(0);
    expect((await adapter.modelCatalog!()).length).toBeGreaterThan(0);

    const calls = (await readFile(log, "utf8")).trim().split(/\r?\n/);
    expect(calls.filter((line) => line === "api model.list")).toHaveLength(1);
  });

  it("rejects when model.list answers something that is not a list of models", async () => {
    await expect(answering("model.list", JSON.stringify({ id: "x" })).modelCatalog!()).rejects.toThrow(/no models/);
    await expect(answering("model.list", "null").modelCatalog!()).rejects.toThrow(/no models/);
  });

  it("keeps a disabled model disabled, and answers no cost at all when any cost row is not two finite numbers", async () => {
    const listed = async (cost: unknown): Promise<CatalogueModel[]> => answering("model.list", JSON.stringify([{
      id: "x", providerID: "p", enabled: false,
      settings: { apiKey: "sk-FAKE-not-a-real-key" }, headers: { authorization: "Bearer FAKE-not-a-real-token" },
      cost,
    }])).modelCatalog!();
    const entry = { ref: "p/x", providerID: "p", id: "x", modelID: "x", variants: [], enabled: false };
    // A cache object on a cost row is ignored (the real service has it).
    expect(await listed([{ input: 1, output: 2, cache: { read: 0.1 } }])).toStrictEqual([{ ...entry, cost: [{ input: 1, output: 2 }] }]);
    // A row without two finite prices is no row, and an entry that loses a row says nothing about what it costs.
    // The first of these was read as free: the row that stayed said 0, and the row that said the price was dropped.
    for (const cost of [[{ input: 0, output: 0 }, { input: 3 }], [{ input: 1, output: 2, cache: { read: 0.1 } }, { input: "1", output: 2 }, { input: 3 }, null]]) {
      const catalogue = await listed(cost);
      expect(catalogue).toStrictEqual([{ ...entry, cost: [] }]);
      // Which is what the budget guard classifies as unknown: never free, and not allowed unless named.
      expect(classify("p/x", catalogue, {})).toMatchObject({ costClass: "unknown", dollarsPerMillion: null, allowed: false });
    }
  });

  it("answers an empty map to a lookup that saw an empty answer, and asks again", async () => {
    // The private lookup keeps what it does for a failed fetch: the call that
    // saw the empty answer finds nothing, and the next one asks the service
    // again instead of keeping the empty answer for the life of the adapter.
    const log = join(cwd, "api-calls.log");
    process.env.FAKE_API_LOG = log;
    process.env.FAKE_MODEL_LIST_EMPTY_ONCE = join(cwd, "model-list-empty.once");
    const adapter = makeAdapter();

    await expect(adapter.contextLimit("anthropic/sonnet")).rejects.toThrow(/unknown/i);
    await expect(adapter.contextLimit("anthropic/sonnet")).resolves.toBe(200000);

    expect((await readFile(log, "utf8")).trim().split(/\r?\n/)).toEqual(["api model.list", "api model.list"]);
  });
});

describe("OpenCodeAdapter.defaultModelRef", () => {
  it("reports the backend default model", async () => {
    expect(await makeAdapter().defaultModelRef!()).toBe("anthropic/sonnet");
  });

  it("answers null when the backend has no default model", async () => {
    process.env.FAKE_MODEL_DEFAULT_NONE = "1";
    await expect(makeAdapter().defaultModelRef!()).resolves.toBeNull();
  });

  it("rejects when the default cannot be read, remembers nothing, and recovers", async () => {
    const log = join(cwd, "api-calls.log");
    process.env.FAKE_API_LOG = log;
    process.env.FAKE_MODEL_DEFAULT_FAILS_ONCE = join(cwd, "model-default-failed.once");
    const adapter = makeAdapter();

    const failure = await adapter.defaultModelRef!().catch((error: unknown) => error);
    // The rule for the list holds for the default too: what went wrong, by code, and none of the service's stderr.
    expect((failure as Error).message).toBe("opencode api model.default failed: exit 1");
    expect((failure as Error).message).not.toContain("service unreachable");
    expect(((failure as Error).cause as Error).message).toContain("service unreachable");
    await expect(adapter.defaultModelRef!()).resolves.toBe("anthropic/sonnet");

    // Asked twice: the failure was not remembered.
    expect((await readFile(log, "utf8")).trim().split(/\r?\n/)).toEqual(["api model.default", "api model.default"]);
  });

  it("rejects, without quoting the answer, when the default is not a model record", async () => {
    for (const data of ['{ "settings": { "apiKey": "sk-FAKE-not-a-real-key" } }', '"sonnet"', "undefined"]) {
      const error = await answering("model.default", data).defaultModelRef!().catch((err: unknown) => err);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/model\.default/);
      // A record carries credentials like a list entry, so the rejection never quotes it.
      expect((error as Error).message).not.toMatch(/apiKey|sk-/);
    }
  });
});

/** An adapter whose `api <operation>` prints `text` as it is, envelope or not. */
function printing(operation: string, text: string): OpenCodeAdapter {
  const script = `if (process.argv.includes(${JSON.stringify(operation)})) process.stdout.write(${JSON.stringify(text)}); else process.exitCode = 2;`;
  return new OpenCodeAdapter({ bin: process.execPath, binArgsPrefix: ["-e", script] });
}

describe("what a failed catalogue call says", () => {
  it("names an answer it cannot parse, and a binary it cannot spawn, by code alone", async () => {
    // What the service printed can quote configuration, on stdout as on stderr: none of it is repeated.
    const text = "ConfigError: apiKey sk-FAKE-not-a-real-key was rejected\n";
    const unparsableList = await printing("model.list", text).modelCatalog!().catch((error: unknown) => error);
    const unparsableDefault = await printing("model.default", text).defaultModelRef!().catch((error: unknown) => error);
    expect((unparsableList as Error).message).toBe("opencode api model.list failed: printed unparsable output");
    expect((unparsableDefault as Error).message).toBe("opencode api model.default failed: printed unparsable output");

    // A binary that cannot be spawned at all: Node's own error, of which only the code is quoted.
    const missing = new OpenCodeAdapter({ bin: "taskctl-no-such-binary" });
    const noList = await missing.modelCatalog!().catch((error: unknown) => error);
    const noDefault = await missing.defaultModelRef!().catch((error: unknown) => error);
    expect((noList as Error).message).toBe("opencode api model.list failed: ENOENT");
    expect((noDefault as Error).message).toBe("opencode api model.default failed: ENOENT");

    for (const failure of [unparsableList, unparsableDefault, noList, noDefault]) {
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).not.toMatch(/apiKey|sk-|ConfigError|service unreachable/);
      // The original is the cause.
      expect((failure as Error).cause).toBeInstanceOf(Error);
    }
  });
});

describe("the directory the catalogue is asked in", () => {
  it("asks in the directory it is given, and keeps one listing per directory", async () => {
    // The real service answers by the directory it is asked in: a directory with its own `opencode.json` got another
    // default model and another list (2026-11-25). The fake marks such a directory with a file named `paid-default`.
    const log = join(cwd, "api-calls.log");
    process.env.FAKE_API_LOG = log;
    const plain = join(cwd, "plain");
    const paid = join(cwd, "paid");
    await mkdir(plain);
    await mkdir(paid);
    await writeFile(join(paid, "paid-default"), "", "utf8");
    const adapter = makeAdapter();
    const calls = async (operation: string): Promise<string[]> =>
      (await readFile(log, "utf8")).trim().split(/\r?\n/).filter((line) => line === `api ${operation}`);

    expect(await adapter.defaultModelRef!(plain)).toBe("anthropic/sonnet");
    expect(await adapter.defaultModelRef!(paid)).toBe("anthropic/opus");
    // No directory is the process's own, as it always was.
    expect(await adapter.defaultModelRef!()).toBe("anthropic/sonnet");

    const refs = async (directory?: string): Promise<string[]> => (await adapter.modelCatalog!(directory)).map((model) => model.ref);
    expect(await refs(paid)).toContain("anthropic/only-in-paid");
    expect(await refs(plain)).not.toContain("anthropic/only-in-paid");

    // One listing per directory, however often it is asked...
    await adapter.modelCatalog!(paid);
    await adapter.modelCatalog!(paid);
    await adapter.modelCatalog!(plain);
    expect(await calls("model.list")).toHaveLength(2);
    // ...and the variant and context lookups share the listing of the directory they run in.
    await adapter.resolveModel("anthropic/sonnet", "high");
    await expect(adapter.contextLimit("openai/gpt")).resolves.toBe(128000);
    expect((await adapter.modelCatalog!()).length).toBeGreaterThan(0);
    expect(await calls("model.list")).toHaveLength(3);

    // The default is asked every time: it is never remembered.
    expect(await calls("model.default")).toHaveLength(3);
  });
});
