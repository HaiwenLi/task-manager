import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.js";
import { TaskStore } from "../src/task-store.js";
import type { AgentAdapter } from "../src/adapters/types.js";

/**
 * End-to-end through the CLI with a scripted agent: one adapter answers the
 * clarify prompt, one writes the completion marker like a worker turn, one
 * answers the review prompt. Everything else (fencing, acceptance gate, journal,
 * board, report) is the real code path.
 */
let root: string;
let tasksDir: string;
let workdir: string;
let calls: string[];
let acceptanceCalls = 0;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "taskctl-e2e-"));
  tasksDir = join(root, "tasks");
  workdir = join(root, "work");
  await mkdir(tasksDir, { recursive: true });
  await mkdir(workdir, { recursive: true });
  calls = [];
  acceptanceCalls = 0;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function scriptedAgent(verdict: "pass" | "fail"): AgentAdapter {
  return {
    prompt: async (args) => {
      if (args.text.includes("任务澄清助手")) {
        calls.push("clarify");
        return { sessionId: "s-clarify", exitCode: 0, text: "## 目标\n完成改版\n## 验收标准\n- C1 artifact.txt 存在\n## 边界\n无" };
      }
      if (args.text.includes("独立复核者")) {
        calls.push("review");
        const result = verdict === "pass"
          ? { verdict: "pass", criteria: [{ id: "C1", pass: true, evidence: "artifact.txt 存在" }], defects: [], summary: "通过" }
          : { verdict: "fail", criteria: [{ id: "C1", pass: false, evidence: "artifact.txt 缺失" }], defects: ["没有产物"], summary: "未达标" };
        return { sessionId: "s-review", exitCode: 0, text: JSON.stringify(result) };
      }
      calls.push("worker");
      await mkdir(join(tasksDir, "001-login"), { recursive: true });
      await writeFile(join(tasksDir, "001-login", "done.requested"), "requested", "utf8");
      return { sessionId: "s-worker", exitCode: 0, text: "done" };
    },
    contextUsage: async () => 0,
    contextLimit: async () => 100_000,
  };
}

const silent = { log: () => {}, err: () => {} };

const acceptance = async () => {
  acceptanceCalls += 1;
  return { passed: true, skipped: false as const, exitCode: 0, output: "ok" };
};

async function writeConfig(): Promise<string> {
  const path = join(root, "taskctl.json");
  await writeFile(path, JSON.stringify({ tasksDir, workdir, parallel: 1, retryLimit: 1, maxReviewRounds: 1 }), "utf8");
  return path;
}

describe("pipeline end to end through the CLI", () => {
  it("add → approve → run → done, with the acceptance gate, review and board", async () => {
    const cfgPath = await writeConfig();
    const agent = scriptedAgent("pass");

    const added = await runCli(
      ["add", "复杂任务：改登录页", "--acceptance", "check", "--config", cfgPath, "--id", "001-login"],
      { ...silent, adapter: agent },
    );
    expect(added).toBe(0);
    expect((await new TaskStore(tasksDir).get("001-login")).status).toBe("draft");

    expect(await runCli(["approve", "--task", "001-login", "--tasks-dir", tasksDir], silent)).toBe(0);
    expect((await new TaskStore(tasksDir).get("001-login")).status).toBe("open");

    expect(await runCli(["run", "--config", cfgPath], { ...silent, adapter: agent, acceptance })).toBe(0);

    const finished = await new TaskStore(tasksDir).get("001-login");
    expect(finished.status).toBe("done");
    expect(finished.acceptance).toBe("check");
    expect(calls).toEqual(["clarify", "worker", "review"]);
    expect(acceptanceCalls).toBe(1);

    const journal = await readFile(join(tasksDir, "001-login", "journal.md"), "utf8");
    expect(journal).toContain("approved");
    expect(journal).toContain("verdict");

    const board = await readFile(join(root, ".taskctl", "board.md"), "utf8");
    expect(board).toContain("# taskctl");
  });

  it("a failing review spends a round and ends blocked at the limit", async () => {
    const cfgPath = await writeConfig();
    const agent = scriptedAgent("fail");
    await runCli(
      ["add", "复杂任务：改登录页", "--acceptance", "check", "--config", cfgPath, "--id", "001-login"],
      { ...silent, adapter: agent },
    );
    await runCli(["approve", "--task", "001-login", "--tasks-dir", tasksDir], silent);

    expect(await runCli(["run", "--config", cfgPath], { ...silent, adapter: agent, acceptance })).toBe(0);
    const task = await new TaskStore(tasksDir).get("001-login");
    expect(task.status).toBe("blocked");
    expect(task.reviewRounds).toBe(2);

    const report: string[] = [];
    await runCli(["report", "--task", "001-login", "--tasks-dir", tasksDir], { log: (line) => report.push(line) });
    expect(report.join("\n")).toContain("verdict  fail");
  });
});
