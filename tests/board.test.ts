import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderBoardMarkdown, renderBoardTable, writeBoard } from "../src/board.js";
import { buildReport } from "../src/report.js";
import { serializeTaskFile } from "../src/task-file.js";
import { buildTaskFile } from "./helpers/task-fixture.js";
import { runCli } from "../src/cli.js";

const now = new Date("2026-11-16T02:50:00Z");

function task(overrides: Partial<Parameters<typeof buildTaskFile>[0]> = {}) {
  return buildTaskFile({ id: "001", title: "任务", ...overrides });
}

describe("renderBoardMarkdown", () => {
  it("groups unfinished tasks, hides done, and marks the file as generated", () => {
    const tasks = [
      task({ id: "001", status: "draft" }),
      task({ id: "002", status: "awaiting-human" }),
      task({ id: "003", status: "review" }),
      task({ id: "004", status: "blocked" }),
      task({ id: "005", status: "done" }),
    ];
    const md = renderBoardMarkdown(tasks, {
      all: false,
      notes: new Map([["004", "复核 2 轮未过"]]),
      highlighted: new Set(["002"]),
      now,
    });
    expect(md).toContain("## 待我确认 1");
    expect(md).toContain("## 待我放行 1");
    expect(md).toContain("## 进行中 1");
    expect(md).toContain("## 卡住 1");
    expect(md).toContain("复核 2 轮未过");
    expect(md).toContain("- ★ 002");
    expect(md).not.toContain("005");
    expect(md).not.toContain("## 已完成");
    expect(md).toContain("生成物");
  });

  it("appends the done group with --all", () => {
    const md = renderBoardMarkdown([task({ id: "005", status: "done" })], {
      all: true,
      notes: new Map(),
      highlighted: new Set(),
      now,
    });
    expect(md).toContain("## 已完成 1");
  });

  it("omits empty groups", () => {
    const md = renderBoardMarkdown([task({ id: "001", status: "blocked" })], {
      all: false,
      notes: new Map(),
      highlighted: new Set(),
      now,
    });
    expect(md).not.toContain("## 待我确认");
    expect(md).toContain("## 卡住 1");
  });
});

describe("renderBoardTable", () => {
  it("prints the same groups as plain lines", () => {
    const lines = renderBoardTable([task({ id: "001", status: "draft" })], {
      all: false,
      notes: new Map([["001", "spec 3/5 条待定"]]),
      highlighted: new Set(),
      now,
    });
    expect(lines.join("\n")).toContain("待我确认 1");
    expect(lines.join("\n")).toContain("spec 3/5 条待定");
  });
});

describe("writeBoard", () => {
  it("writes .taskctl/board.md atomically and leaves no tmp behind", async () => {
    const root = await mkdtemp(join(tmpdir(), "taskctl-board-"));
    const tasksDir = join(root, "tasks");
    await mkdir(tasksDir, { recursive: true });
    const path = await writeBoard(tasksDir, "# board\n");
    expect(path).toBe(join(root, ".taskctl", "board.md"));
    expect(await readFile(path, "utf8")).toBe("# board\n");
    const names = await readdir(join(root, ".taskctl"));
    expect(names.filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("two concurrent writers both succeed and leave no tmp behind", async () => {
    const root = await mkdtemp(join(tmpdir(), "taskctl-board-race-"));
    const tasksDir = join(root, "tasks");
    await mkdir(tasksDir, { recursive: true });
    await Promise.all([writeBoard(tasksDir, "# one\n"), writeBoard(tasksDir, "# two\n")]);
    const names = await readdir(join(root, ".taskctl"));
    expect(names.filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(["# one\n", "# two\n"]).toContain(await readFile(join(root, ".taskctl", "board.md"), "utf8"));
  });
});

describe("taskctl board CLI", () => {
  it("rewrites the file, prints the table, and --json skips the file", async () => {
    const root = await mkdtemp(join(tmpdir(), "taskctl-board-cli-"));
    const tasksDir = join(root, "tasks");
    await mkdir(join(tasksDir, "001-a"), { recursive: true });
    await writeFile(join(tasksDir, "001-a.md"), serializeTaskFile(task({ id: "001-a", status: "draft" })), "utf8");

    const printed: string[] = [];
    expect(await runCli(["board", "--tasks-dir", tasksDir], { log: (line) => printed.push(line) })).toBe(0);
    expect(printed.join("\n")).toContain("待我确认 1");
    expect(await readFile(join(root, ".taskctl", "board.md"), "utf8")).toContain("## 待我确认 1");

    const json: string[] = [];
    expect(await runCli(["board", "--json", "--tasks-dir", tasksDir], { log: (line) => json.push(line) })).toBe(0);
    expect(JSON.parse(json.join("\n"))).toMatchObject([{ id: "001-a", status: "draft" }]);
  });
});

describe("buildReport", () => {
  it("shows acceptance, review, journal and audit sections", async () => {
    const dir = await mkdtemp(join(tmpdir(), "taskctl-report-"));
    await writeFile(
      join(dir, "001-a.md"),
      serializeTaskFile(task({ id: "001-a", status: "done", criteria: ["C1 ok"] })),
      "utf8",
    );
    await mkdir(join(dir, "001-a"), { recursive: true });
    const { writeRuntime } = await import("../src/runtime.js");
    const { appendJournal } = await import("../src/journal.js");
    await writeRuntime(dir, "001-a", "acceptance.json", { command: "npm test", passed: true, exitCode: 0, artifactBefore: "a", artifactAfter: "a", output: "ok" });
    await writeRuntime(dir, "001-a", "review.json", {
      verdict: "pass",
      criteria: [{ id: "C1", pass: true, evidence: "ok" }],
      defects: [],
      summary: "ok",
    });
    await appendJournal(dir, "001-a", { stage: "review", event: "verdict", detail: "pass" });

    const text = (await buildReport(dir, "001-a")).join("\n");
    expect(text).toContain("## acceptance");
    expect(text).toContain("## review");
    expect(text).toContain("verdict  pass");
    expect(text).toContain("## journal");
    expect(text).toContain("## human audits");
  });
});
