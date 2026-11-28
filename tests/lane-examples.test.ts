import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLaneExample, lanesPath, readLaneExamples, renderLanes, type LaneExample } from "../src/lanes.js";
import { runCli } from "../src/cli.js";
import { TaskStore } from "../src/task-store.js";
import type { AgentAdapter } from "../src/adapters/types.js";
import { CATALOGUE, adapterOf } from "./helpers/catalogue-fixture.js";

let root: string;
let dir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "taskctl-lane-examples-"));
  dir = join(root, "tasks");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const example = (overrides: Partial<LaneExample> = {}): LaneExample => ({
  id: "002-typo", at: "2026-11-25T02:00:00.000Z", lane: "simple", type: "code",
  title: "修 README 错字", intent: "修 README 错字", criteria: 1, ...overrides,
});

/** Fails loudly if a lane other than `--quick` tried to reach a model. */
const noModel: AgentAdapter = {
  prompt: async () => { throw new Error("no model call expected"); },
  contextUsage: async () => 0, contextLimit: async () => 0,
};

/** A clarify session whose spec carries `count` numbered criteria. */
function clarifier(count: number): AgentAdapter {
  const text = ["## 目标", "改好", "## 验收标准", ...Array.from({ length: count }, (_, index) => `- C${index + 1} 可验证`), ""].join("\n");
  return { prompt: async () => ({ sessionId: "s", exitCode: 0, text }), contextUsage: async () => 0, contextLimit: async () => 0 };
}

describe("lane examples on disk", () => {
  it("live at <root>/.taskctl/lanes.jsonl, one JSON line each, oldest first", async () => {
    expect(lanesPath(dir)).toBe(join(root, ".taskctl", "lanes.jsonl"));
    await appendLaneExample(dir, example({ id: "first", lane: "quick", intent: "合并两列" }));
    await appendLaneExample(dir, example({ id: "second" }));
    expect((await readFile(lanesPath(dir), "utf8")).trimEnd().split("\n")).toHaveLength(2);
    expect(await readLaneExamples(dir)).toEqual([
      { id: "first", at: "2026-11-25T02:00:00.000Z", lane: "quick", type: "code", title: "修 README 错字", intent: "合并两列", criteria: 1 },
      example({ id: "second" }),
    ]);
  });

  it("read as no examples when the file does not exist", async () => {
    expect(await readLaneExamples(dir)).toEqual([]);
  });

  it("a line that does not parse, names no lane, or names an unknown type, is skipped", async () => {
    await mkdir(join(root, ".taskctl"), { recursive: true });
    await writeFile(lanesPath(dir), [
      JSON.stringify(example()), "{ torn write",
      JSON.stringify({ id: "x", at: "2026-11-25T02:00:00.000Z", lane: "tiny", type: "code", title: "x", intent: "x", criteria: 0 }),
      JSON.stringify({ id: "proto", at: "2026-11-25T02:00:00.000Z", lane: "simple", type: "constructor", title: "x", intent: "x", criteria: 0 }), "",
    ].join("\n"), "utf8");
    expect((await readLaneExamples(dir)).map((record) => record.id)).toEqual(["002-typo"]);
  });

  it("the intent is bounded at 500 characters and the cut is marked", async () => {
    await appendLaneExample(dir, example({ intent: "意".repeat(600) }));
    const [record] = await readLaneExamples(dir);
    expect(Array.from(record!.intent)).toHaveLength(501);
    expect(record!.intent.endsWith("…")).toBe(true);
  });

  it("a multi-line intent stays on one line of the file", async () => {
    await appendLaneExample(dir, example({ intent: "第一行\n第二行\r\n第三行" }));
    expect((await readFile(lanesPath(dir), "utf8")).trimEnd().split("\n")).toHaveLength(1);
    expect((await readLaneExamples(dir))[0]!.intent).toBe("第一行\n第二行\r\n第三行");
  });

  it("nothing is ever compacted away", async () => {
    for (let index = 0; index < 205; index++) await appendLaneExample(dir, example({ id: `t${index}` }));
    expect(await readLaneExamples(dir)).toHaveLength(205);
  });
});

describe("taskctl add records the declared lane", () => {
  const silent = { log: (): void => {}, err: (): void => {} };
  const lines = async (): Promise<Array<Record<string, unknown>>> =>
    (await readFile(lanesPath(dir), "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);

  it("appends one line per add with the lane, the type, the title, the intent and the number of criteria", async () => {
    expect(await runCli(["add", "把这个表格的两列合并", "--tasks-dir", dir, "--id", "001-merge", "--quick"], { ...silent, adapter: noModel })).toBe(0);
    expect(await runCli(["add", "改 README 错字", "--type", "office", "--tasks-dir", dir, "--id", "002-typo", "--simple"], { ...silent, adapter: clarifier(2) })).toBe(0);
    expect(await runCli(["add", "重构登录模块\n先看现有接口", "--tasks-dir", dir, "--id", "003-login", "--complex"], { ...silent, adapter: clarifier(3) })).toBe(0);

    expect(await lines()).toEqual([
      { id: "001-merge", at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/), lane: "quick", type: "office", title: "把这个表格的两列合并", intent: "把这个表格的两列合并", criteria: 0 },
      { id: "002-typo", at: expect.any(String), lane: "simple", type: "office", title: "改 README 错字", intent: "改 README 错字", criteria: 2 },
      { id: "003-login", at: expect.any(String), lane: "complex", type: "code", title: "重构登录模块", intent: "重构登录模块\n先看现有接口", criteria: 3 },
    ]);
  });

  it("a clarify session that fails still records the declared lane, with no criteria", async () => {
    const failing: AgentAdapter = { prompt: async () => ({ sessionId: "s", exitCode: 1, text: "" }), contextUsage: async () => 0, contextLimit: async () => 0 };
    expect(await runCli(["add", "重构登录模块", "--tasks-dir", dir, "--id", "004-y", "--complex"], { ...silent, adapter: failing })).toBe(1);
    expect(await lines()).toEqual([{
      id: "004-y", at: expect.any(String), lane: "complex", type: "code", title: "重构登录模块", intent: "重构登录模块", criteria: 0,
    }]);
  });

  it("an add that is refused records nothing", async () => {
    const errors: string[] = [];
    const code = await runCli(["add", "重构登录模块", "--tasks-dir", dir, "--id", "005-z"], { ...silent, adapter: clarifier(1), askLane: async () => null, err: (line) => errors.push(line) });
    expect(code).toBe(2);
    expect(await readdir(root)).toEqual([]);
  });

  it("an add the budget guard refuses records nothing: no task reached the board", async () => {
    // The clarify model as the shared catalogue prices it per token, and no allowance for it:
    // the guard refuses before the task file is written and the command exits 1.
    const config = join(root, "taskctl.json");
    await writeFile(config, JSON.stringify({ tasksDir: dir, model: "zen/p" }), "utf8");
    const errors: string[] = [];
    const guarded: AgentAdapter = { ...clarifier(1), ...adapterOf(CATALOGUE) };
    const code = await runCli(["add", "重构登录模块", "--complex", "--tasks-dir", dir, "--id", "007-guard", "--config", config], { ...silent, err: (line) => errors.push(line), adapter: guarded });
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("budget guard refused: zen/p");
    expect(await readLaneExamples(dir)).toEqual([]);
  });

  it("a failed append is reported and does not change the result", async () => {
    // A directory where the file should be: the append cannot land.
    await mkdir(lanesPath(dir), { recursive: true });
    const said: string[] = [];
    const code = await runCli(["add", "把这个表格的两列合并", "--tasks-dir", dir, "--id", "006-q", "--quick"], { log: (line) => said.push(line), err: () => {}, adapter: noModel });
    expect(code).toBe(0);
    expect(said.join("\n")).toMatch(/006-q\s+open\s+quick/);
    expect(said.join("\n")).toMatch(/006-q\s+lane example not recorded/);
    expect((await new TaskStore(dir).get("006-q")).status).toBe("open");
  });
});

describe("renderLanes", () => {
  it("groups by lane in the fixed order, oldest first inside a group, and prints the intent when it says more than the title", () => {
    expect(renderLanes([
      example({ id: "002-typo", intent: "修 README 错字\r\n不要动别的文件\r再检查一遍" }),
      example({ id: "001-merge", at: "2026-11-25T01:00:00.000Z", lane: "quick", type: "office", title: "合并两列", intent: "合并两列", criteria: 0 }),
      example({ id: "003-login", at: "2026-11-25T02:30:00.000Z", title: "重构登录模块", intent: "重构登录模块", criteria: 3 }),
    ])).toEqual([
      "lane quick (1)",
      "  2026-11-25  001-merge  office  criteria=0  合并两列",
      "lane simple (2)",
      "  2026-11-25  002-typo  code  criteria=1  修 README 错字",
      "      修 README 错字 / 不要动别的文件 / 再检查一遍",
      "  2026-11-25  003-login  code  criteria=3  重构登录模块",
      "lane complex (0)",
      "  (none)",
    ]);
  });
});

describe("taskctl lanes", () => {
  it("prints what was declared, through the real command", async () => {
    await appendLaneExample(dir, example());
    await appendLaneExample(dir, example({ id: "001-merge", lane: "quick", type: "office", title: "合并两列", intent: "合并两列", criteria: 0 }));
    const printed: string[] = [];
    expect(await runCli(["lanes", "--tasks-dir", dir], { log: (line) => printed.push(line) })).toBe(0);
    expect(printed).toEqual([
      "lane quick (1)",
      "  2026-11-25  001-merge  office  criteria=0  合并两列",
      "lane simple (1)",
      "  2026-11-25  002-typo  code  criteria=1  修 README 错字",
      "lane complex (0)",
      "  (none)",
    ]);
  });

  it("prints three empty groups when nothing was ever declared", async () => {
    const printed: string[] = [];
    expect(await runCli(["lanes", "--tasks-dir", dir], { log: (line) => printed.push(line) })).toBe(0);
    expect(printed).toEqual(["lane quick (0)", "  (none)", "lane simple (0)", "  (none)", "lane complex (0)", "  (none)"]);
  });

  it("is listed in the usage text", async () => {
    const errors: string[] = [];
    await runCli([], { log: () => {}, err: (line) => errors.push(line) });
    expect(errors.join("\n")).toContain("taskctl lanes [--tasks-dir <dir>]");
  });
});
