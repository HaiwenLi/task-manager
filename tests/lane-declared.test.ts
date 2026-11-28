import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { LANE_QUESTION, askOnTerminal, runCli } from "../src/cli.js";
import { parseLane } from "../src/intake.js";
import { TaskStore } from "../src/task-store.js";
import type { AgentAdapter } from "../src/adapters/types.js";

const SPEC = "## 目标\n改好\n## 验收标准\n- C1 可验证\n## 信息充分性\nclear\n## 分类理由\n依据明确\n## 补问\n无";

/** A clarify session that answers `text`; every model turn is counted. */
function clarifier(calls: string[], text = SPEC): AgentAdapter {
  return {
    prompt: async () => { calls.push("model"); return { sessionId: "s-1", exitCode: 0, text }; },
    contextUsage: async () => 0, contextLimit: async () => 0,
  };
}

/** What production answers when stdin is not a terminal: no question was asked, no lane was given. */
const noTerminal = { askLane: async (): Promise<string | null> => null };
const silent = { log: (): void => {}, err: (): void => {} };

let root: string;
let dir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "taskctl-lane-declared-"));
  dir = join(root, "tasks");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe("taskctl add requires the lane", () => {
  it("exits with a usage error naming the three when no lane is given and stdin is not a terminal, and creates nothing", async () => {
    const errors: string[] = [];
    const calls: string[] = [];
    const code = await runCli(["add", "重构登录模块", "--tasks-dir", dir, "--id", "001-a"], {
      ...noTerminal, ...silent, adapter: clarifier(calls), err: (line) => errors.push(line),
    });

    expect(code).toBe(2);
    expect(errors[0]).toContain("add requires a lane: pass --quick, --simple or --complex");
    expect(await readdir(root)).toEqual([]);
    expect(calls).toEqual([]);
  });

  // The eight intents the removed `detectComplexity` tests used, kept verbatim.
  it.each([
    "这是个简单任务：修一下 README 的错字", "这是一个简单任务", "simple: fix typo", "简单任务：改个错字",
    "重构登录模块", "不太复杂，改个文案", "这不是简单任务，要重构登录模块", "上次那个简单任务又出问题了",
  ])("does not read %j for a lane: with no flag it exits 2", async (intent) => {
    const errors: string[] = [];
    const calls: string[] = [];
    const code = await runCli(["add", intent, "--tasks-dir", dir], {
      ...noTerminal, ...silent, adapter: clarifier(calls), err: (line) => errors.push(line),
    });
    expect(code).toBe(2);
    expect(errors[0]).toContain("--quick, --simple or --complex");
    expect(await readdir(root)).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("an explicit complex lane beats wording that calls the task simple", async () => {
    const code = await runCli(["add", "这是个简单任务：修一下 README 的错字", "--tasks-dir", dir, "--id", "001-a", "--complex"], {
      ...noTerminal, ...silent, adapter: clarifier([]),
    });
    expect(code).toBe(0);
    expect(await new TaskStore(dir).get("001-a")).toMatchObject({ status: "draft", complexity: "complex", execution: "iterative" });
  });

  it("an explicit simple lane is not second-guessed by a negation", async () => {
    const code = await runCli(["add", "这不是简单任务，要重构登录模块", "--tasks-dir", dir, "--id", "001-a", "--simple"], {
      ...noTerminal, ...silent, adapter: clarifier([]),
    });
    expect(code).toBe(0);
    expect(await new TaskStore(dir).get("001-a")).toMatchObject({ status: "open", complexity: "simple", execution: "continuous" });
  });

  it("asks once through the terminal seam and takes the answer as the lane", async () => {
    const questions: string[] = [];
    const askLane = vi.fn(async (question: string) => { questions.push(question); return " Simple "; });
    const code = await runCli(["add", "修 README 错字", "--tasks-dir", dir, "--id", "002-b"], { askLane, ...silent, adapter: clarifier([]) });

    expect(code).toBe(0);
    expect(askLane).toHaveBeenCalledTimes(1);
    for (const lane of ["quick", "simple", "complex"]) expect(questions[0]).toContain(lane);
    expect(await new TaskStore(dir).get("002-b")).toMatchObject({ status: "open", complexity: "simple", quick: false });
  });

  it("does not ask when a lane flag is given", async () => {
    const askLane = vi.fn(async () => "complex");
    expect(await runCli(["add", "把这个表格的两列合并", "--tasks-dir", dir, "--id", "001-merge", "--quick"], { askLane, ...silent, adapter: clarifier([]) })).toBe(0);
    expect(askLane).not.toHaveBeenCalled();
  });

  it.each(["simpl", "", "tiny", "快速"])("exits with the usage error for the reply %j, and calls no model", async (reply) => {
    const errors: string[] = [];
    const calls: string[] = [];
    const code = await runCli(["add", "重构登录模块", "--tasks-dir", dir, "--id", "001-a"], {
      askLane: async () => reply, ...silent, adapter: clarifier(calls), err: (line) => errors.push(line),
    });
    expect(code).toBe(2);
    expect(errors[0]).toMatch(/add requires a lane: pass --quick, --simple or --complex/);
    expect(errors[0]).toContain(`("${reply}" is not a lane)`);
    expect(calls).toEqual([]);
    expect(await readdir(root)).toEqual([]);
  });

  it("refuses two lane flags", async () => {
    const errors: string[] = [];
    const code = await runCli(["add", "x", "--tasks-dir", dir, "--quick", "--simple"], { ...noTerminal, ...silent, adapter: clarifier([]), err: (line) => errors.push(line) });
    expect(code).toBe(2);
    expect(errors[0]).toContain("--quick, --simple and --complex are mutually exclusive");
    expect(await readdir(root)).toEqual([]);
  });

  it("accepts --complex as a flag that stands alone, wherever it is written", async () => {
    // `--resume` was once missing from the parser's boolean flags and swallowed
    // the next token (2026-11-24). A lane flag goes through the real parser.
    const calls: string[] = [];
    expect(await runCli(["add", "--complex", "重构登录模块", "--tasks-dir", dir, "--id", "003-c"], { ...noTerminal, ...silent, adapter: clarifier(calls) })).toBe(0);
    expect(await new TaskStore(dir).get("003-c")).toMatchObject({ status: "draft", description: "重构登录模块" });
    expect(await runCli(["add", "改 README 错字", "--tasks-dir", dir, "--id", "004-d", "--complex"], { ...noTerminal, ...silent, adapter: clarifier(calls) })).toBe(0);
    expect(await new TaskStore(dir).get("004-d")).toMatchObject({ status: "draft", complexity: "complex" });
  });

  it("names the three lanes and the new flag in its usage line", async () => {
    const errors: string[] = [];
    await runCli([], { log: () => {}, err: (line) => errors.push(line) });
    expect(errors.join("\n")).toMatch(/taskctl add ".*" \(--quick\|--simple\|--complex\)/);
  });
});

describe("parseLane", () => {
  it("accepts one of the three lanes, forgiving case and surrounding space, and nothing else", () => {
    expect(parseLane(" Simple ")).toBe("simple");
    expect(parseLane("QUICK")).toBe("quick");
    for (const reply of ["simpl", "", "tiny", "快速", "simple task"]) expect(parseLane(reply)).toBeNull();
  });
});

describe("askOnTerminal", () => {
  const terminal = (): PassThrough & { isTTY: boolean } => Object.assign(new PassThrough(), { isTTY: true });

  it("asks once on a terminal and answers the typed line", async () => {
    const input = terminal();
    const output = new PassThrough();
    const said: string[] = [];
    output.on("data", (chunk) => said.push(String(chunk)));
    const answer = askOnTerminal(LANE_QUESTION, input, output);
    input.end("simple\n");
    expect(await answer).toBe("simple");
    // The question reaches the terminal exactly once.
    expect(said.join("").split(LANE_QUESTION)).toHaveLength(2);
  });

  it("does not ask at all when stdin is not a terminal", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const said: string[] = [];
    output.on("data", (chunk) => said.push(String(chunk)));
    const answer = askOnTerminal(LANE_QUESTION, input, output);
    input.end();
    expect(await answer).toBeNull();
    expect(said.join("")).toBe("");
  });

  it("treats end of input on a terminal as no lane", async () => {
    const input = terminal();
    const output = new PassThrough();
    output.resume();
    const answer = askOnTerminal(LANE_QUESTION, input, output);
    input.end();
    expect(await answer).toBeNull();
  });
});
