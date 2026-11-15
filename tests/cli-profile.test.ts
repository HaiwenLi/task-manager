import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.js";
import { readProfile } from "../src/profile.js";
import type { AgentAdapter } from "../src/adapters/types.js";

const silent = { log: () => {}, err: () => {} };

function capturingAdapter(text: string, seen: string[]): AgentAdapter {
  return {
    prompt: async (args) => {
      seen.push(args.text);
      return { sessionId: "s", exitCode: 0, text };
    },
    contextUsage: async () => 0,
    contextLimit: async () => 100,
  };
}

async function setup(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "taskctl-cli-profile-"));
  const tasksDir = join(root, "tasks");
  await mkdir(tasksDir, { recursive: true });
  return tasksDir;
}

describe("taskctl learn", () => {
  it("appends the observation to the profile", async () => {
    const tasksDir = await setup();
    expect(await runCli(["learn", "--note", "不要问我能从仓库推出来的事", "--tasks-dir", tasksDir], silent)).toBe(0);
    expect(await readProfile(tasksDir)).toContain("不要问我能从仓库推出来的事");
  });

  it("requires --note", async () => {
    const tasksDir = await setup();
    expect(await runCli(["learn", "--tasks-dir", tasksDir], silent)).toBe(2);
  });
});

describe("taskctl add uses the profile", () => {
  it("injects recorded preferences into the clarify prompt", async () => {
    const tasksDir = await setup();
    await runCli(["learn", "--note", "交付物先给结论再给证据", "--tasks-dir", tasksDir], silent);
    const seen: string[] = [];
    const adapter = capturingAdapter("## 目标\n好\n## 验收标准\n- C1 好\n", seen);
    await runCli(["add", "改登录页", "--tasks-dir", tasksDir, "--id", "001-login"], { ...silent, adapter });
    expect(seen[0]).toContain("交付物先给结论再给证据");
    expect(seen[0]).toContain("用户偏好档案");
  });
});

describe("taskctl template", () => {
  it("prints the three buckets for a type", async () => {
    const tasksDir = await setup();
    const printed: string[] = [];
    expect(await runCli(["template", "--type", "research", "--tasks-dir", tasksDir], { log: (line) => printed.push(line) })).toBe(0);
    const text = printed.join("\n");
    expect(text).toContain("必答");
    expect(text).toContain("可推");
    expect(text).toContain("补问");
    expect(text).toContain("要回答的问题");
  });

  it("defaults to the code template and rejects an unknown type", async () => {
    const tasksDir = await setup();
    const printed: string[] = [];
    await runCli(["template", "--tasks-dir", tasksDir], { log: (line) => printed.push(line) });
    expect(printed.join("\n")).toContain("改动后是什么样");

    expect(await runCli(["template", "--type", "nope", "--tasks-dir", tasksDir], silent)).toBe(2);
  });
});
