import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectChangeEvidence, MAX_DIFF_STAT_LINES, MAX_STATUS_LINES } from "../src/changes.js";
import { buildReviewPrompt, type ReviewEvidence, type ReviewResult } from "../src/review.js";
import { parseTaskFile } from "../src/task-file.js";
import { TaskStore } from "../src/task-store.js";
import { runTask, type WorkerConfig } from "../src/worker.js";
import type { AgentAdapter } from "../src/adapters/types.js";

const exec = promisify(execFile);

let root: string;
let cwd: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "taskctl-changes-"));
  cwd = join(root, "work");
  await mkdir(cwd);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function git(...args: string[]): Promise<void> {
  await exec("git", ["-C", cwd, ...args]);
}

const task = parseTaskFile("---\ntitle: 复核\nstatus: running\ncriteria:\n  - C1 ok\nsessions: []\nretries: 0\n---\n正文", "001-a");

describe("collectChangeEvidence (C3)", () => {
  it("lists modified and untracked files with a diffstat against HEAD", async () => {
    await git("init");
    await writeFile(join(cwd, "base.ts"), "one\n");
    await git("-c", "user.name=T", "-c", "user.email=t@example.invalid", "add", "base.ts");
    await git("-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-m", "init");
    await writeFile(join(cwd, "base.ts"), "one\ntwo\n");
    await writeFile(join(cwd, "new.ts"), "fresh\n");

    const evidence = await collectChangeEvidence(cwd);

    expect(evidence.status).toContain("M base.ts");
    expect(evidence.status).toContain("?? new.ts");
    expect(evidence.diffStat).toContain("base.ts |");
    expect(evidence.diffStat).toContain("1 file changed");
  });

  it("caps oversized outputs with a visible truncation marker", async () => {
    const files = MAX_STATUS_LINES + 5;
    await git("init");
    for (let i = 0; i < files; i++) {
      await writeFile(join(cwd, `f${i}.ts`), "one\n");
    }
    await git("-c", "user.name=T", "-c", "user.email=t@example.invalid", "add", ".");
    await git("-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-m", "init");
    for (let i = 0; i < files; i++) {
      await writeFile(join(cwd, `f${i}.ts`), "one\ntwo\n");
    }

    const evidence = await collectChangeEvidence(cwd);

    const statusLines = evidence.status.split("\n");
    expect(statusLines).toHaveLength(MAX_STATUS_LINES + 1);
    expect(statusLines.at(-1)).toMatch(new RegExp(`截断.*${files} 行`));
    const statLines = evidence.diffStat.split("\n");
    expect(statLines).toHaveLength(MAX_DIFF_STAT_LINES + 1);
    expect(statLines.at(-1)).toMatch(new RegExp(`截断.*${files + 1} 行`));
    // 截断后仍然是被注入的那部分真实内容，不是编造的摘要
    expect(statusLines[0]).toContain("f0.ts");
  });

  it("falls back to the index diff when HEAD is unborn", async () => {
    await git("init");
    await writeFile(join(cwd, "a.ts"), "one\n");
    await git("add", "a.ts");

    const evidence = await collectChangeEvidence(cwd);

    expect(evidence.status).toContain("A  a.ts");
    // 无 HEAD 可比对时退回对 index 的 diff；此处工作区与 index 一致，明确标「空」而非不可用
    expect(evidence.diffStat).toBe("(空)");
    expect(evidence.diffStat).not.toContain("不可用");
  });

  it("reports unavailable instead of throwing on a non-git directory", async () => {
    const evidence = await collectChangeEvidence(cwd);

    expect(evidence.status).toContain("不可用");
    expect(evidence.diffStat).toContain("不可用");
  });
});

describe("buildReviewPrompt × change evidence (C3)", () => {
  const base = {
    task,
    spec: "",
    acceptanceMarkdown: "",
    handoff: null,
    journal: [],
    window: { startedAt: "2026-11-16T00:00:00.000Z", finishedAt: "2026-11-16T00:20:00.000Z" },
  };

  it("injects the change list and the diffstat as their own sections", () => {
    const prompt = buildReviewPrompt({
      ...base,
      changes: { status: " M base.ts\n?? new.ts", diffStat: " base.ts | 2 +-\n 1 file changed" },
    });
    expect(prompt).toContain("## 工作区改动清单（git status --porcelain）");
    expect(prompt).toContain("M base.ts");
    expect(prompt).toContain("?? new.ts");
    expect(prompt).toContain("## 改动统计（git diff --stat）");
    expect(prompt).toContain("base.ts | 2 +-");
    expect(prompt).toContain("1 file changed");
  });

  it("says so when no change evidence was collected", () => {
    const prompt = buildReviewPrompt({ ...base });
    expect(prompt).toContain("(未收集)");
    expect(prompt).not.toContain("## 工作区改动清单（git status --porcelain）\n\n");
  });

  it("keeps the unavailable note visible instead of dropping the section", () => {
    const prompt = buildReviewPrompt({
      ...base,
      changes: { status: "(不可用：git status 无法运行——不是 git 工作目录，或 git 不在 PATH 上)", diffStat: "(不可用：同上)" },
    });
    expect(prompt).toContain("(不可用：git status 无法运行");
  });
});

describe("review.json records what the reviewer saw (C3, worker level)", () => {
  it("writes the injected change list and diffstat next to the verdict", async () => {
    await git("init");
    await writeFile(join(cwd, "base.ts"), "one\n");
    await git("-c", "user.name=T", "-c", "user.email=t@example.invalid", "add", "base.ts");
    await git("-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-m", "init");
    await writeFile(join(cwd, "base.ts"), "one\ntwo\n");

    const tasksDir = join(root, "tasks");
    await mkdir(tasksDir, { recursive: true });
    await writeFile(join(tasksDir, "a.md"), [
      "---",
      "title: Review evidence task",
      "status: open",
      'acceptance: "check"',
      "criteria:",
      "  - C1 ok",
      "review_rounds: 0",
      "sessions: []",
      "retries: 0",
      "---",
      "Do work",
      "",
    ].join("\n"), "utf8");
    const store = new TaskStore(tasksDir);
    const adapter: AgentAdapter = {
      prompt: async () => {
        await mkdir(join(tasksDir, "a"), { recursive: true });
        await writeFile(join(tasksDir, "a", "done.requested"), "done");
        return { sessionId: "s", text: "done", exitCode: 0 };
      },
      contextUsage: async () => 0,
      contextLimit: async () => 100,
    };
    const pass = async () => ({ passed: true, skipped: false as const, exitCode: 0, output: "observed" });
    const seen: ReviewEvidence[] = [];
    const review = async (evidence: ReviewEvidence): Promise<ReviewResult> => {
      seen.push(evidence);
      return { verdict: "pass", criteria: [{ id: "C1", pass: true, evidence: "fixture" }], externalChanges: [], defects: [], summary: "ok" };
    };
    const config: WorkerConfig = {
      tasksDir, workdir: cwd, agent: "fixture", contextThreshold: 0.8,
      retryLimit: 2, lockTtlMs: 5_000, heartbeatMs: 50,
    };

    await runTask(config, { store, adapter, acceptance: pass, review }, await store.get("a"), "w1");

    expect((await store.get("a")).status).toBe("done");
    expect(seen[0]!.changes?.status).toContain("M base.ts");
    const record = JSON.parse(await readFile(join(tasksDir, "a", "review.json"), "utf8"));
    // 记录的是实际注入的内容本身，便于复盘 reviewer 到底看到了什么
    expect(record.evidence.gitStatus).toBe(seen[0]!.changes?.status);
    expect(record.evidence.gitDiffStat).toBe(seen[0]!.changes?.diffStat);
    expect(record.evidence.gitStatus).toContain("M base.ts");
    expect(record.evidence.gitDiffStat).toContain("base.ts |");
  });
});
