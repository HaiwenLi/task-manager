import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.js";
import { TaskStore } from "../src/task-store.js";
import { writeSpec } from "../src/spec.js";

const silent = { log: () => {}, err: () => {} };

async function seed(tasksDir: string, id: string, frontmatter: string): Promise<void> {
  await writeFile(join(tasksDir, `${id}.md`), `---\n${frontmatter}\nsessions: []\nretries: 0\n---\n正文`, "utf8");
}

describe("taskctl approve", () => {
  it("moves a draft with criteria to open, and refuses the second time", async () => {
    const dir = await mkdtemp(join(tmpdir(), "taskctl-approve-"));
    await seed(dir, "001-a", "title: a\nstatus: draft\ncriteria:\n  - C1 好");
    expect(await runCli(["approve", "--task", "001-a", "--tasks-dir", dir], silent)).toBe(0);
    expect((await new TaskStore(dir).get("001-a")).status).toBe("open");
    expect(await runCli(["approve", "--task", "001-a", "--tasks-dir", dir], silent)).toBe(1);
  });

  it("refuses a draft with no criteria and leaves it in draft", async () => {
    const dir = await mkdtemp(join(tmpdir(), "taskctl-approve-"));
    await seed(dir, "002-b", "title: b\nstatus: draft");
    expect(await runCli(["approve", "--task", "002-b", "--tasks-dir", dir], silent)).toBe(1);
    expect((await new TaskStore(dir).get("002-b")).status).toBe("draft");
  });

  it("imports criteria from spec.md when the frontmatter has none", async () => {
    const dir = await mkdtemp(join(tmpdir(), "taskctl-approve-"));
    await seed(dir, "004-d", "title: d\nstatus: draft");
    await writeSpec(dir, "004-d", "## 目标\n好\n## 验收标准\n- C1 命令绿\n- C2 文案对\n");
    expect(await runCli(["approve", "--task", "004-d", "--tasks-dir", dir], silent)).toBe(0);
    const task = await new TaskStore(dir).get("004-d");
    expect(task.status).toBe("open");
    expect(task.criteria).toEqual(["C1 命令绿", "C2 文案对"]);
  });
});

describe("taskctl spec", () => {
  it("prints the spec, and says so when there is none", async () => {
    const dir = await mkdtemp(join(tmpdir(), "taskctl-spec-"));
    await seed(dir, "003-c", "title: c\nstatus: draft\ncriteria:\n  - C1 好");
    const printed: string[] = [];
    expect(await runCli(["spec", "--task", "003-c", "--tasks-dir", dir], { log: (line) => printed.push(line) })).toBe(0);
    expect(printed.join("\n")).toBe("(no spec)");

    await writeSpec(dir, "003-c", "## 目标\n好\n## 验收标准\n- C1 好\n");
    const again: string[] = [];
    await runCli(["spec", "--task", "003-c", "--tasks-dir", dir], { log: (line) => again.push(line) });
    expect(again.join("\n")).toContain("## 目标");
  });
});
