import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactDigest } from "../src/workspace.js";
import { TaskStore } from "../src/task-store.js";
import { runTask, type WorkerConfig } from "../src/worker.js";
import type { AgentAdapter } from "../src/adapters/types.js";
import type { ReviewEvidence, ReviewResult } from "../src/review.js";

let root: string;
let cwd: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "taskctl-ignore-"));
  cwd = join(root, "work");
  await mkdir(cwd);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("artifactDigest ignore patterns (C1)", () => {
  it("a plain path excludes its file and its subtree; everything else still counts", async () => {
    await writeFile(join(cwd, "keep.ts"), "one");
    await mkdir(join(cwd, "out"));
    await writeFile(join(cwd, "out", "gen.json"), "1");
    const before = await artifactDigest(cwd, [], ["out"]);
    // 验收命令重写被忽略路径 → 不判 drift
    await writeFile(join(cwd, "out", "gen.json"), "2");
    expect(await artifactDigest(cwd, [], ["out"])).toBe(before);
    // 重写未忽略路径 → 仍判 drift
    await writeFile(join(cwd, "keep.ts"), "two");
    expect(await artifactDigest(cwd, [], ["out"])).not.toBe(before);
  });

  it("globs match files at the root, inside one directory, and across depths", async () => {
    await writeFile(join(cwd, "keep.ts"), "kept");
    await writeFile(join(cwd, "skip.json"), "{}");
    await mkdir(join(cwd, "reports", "deep"), { recursive: true });
    await writeFile(join(cwd, "reports", "r1.json"), "1");
    await writeFile(join(cwd, "reports", "r2.txt"), "2");
    await writeFile(join(cwd, "reports", "deep", "r3.json"), "3");
    const patterns = ["*.json", "reports/**/*.json"];
    const before = await artifactDigest(cwd, [], patterns);
    // 验收命令重写被忽略路径（根、一层、深层）→ 不判 drift
    for (const file of [join(cwd, "skip.json"), join(cwd, "reports", "r1.json"), join(cwd, "reports", "deep", "r3.json")]) {
      await writeFile(file, "rewritten");
      expect(await artifactDigest(cwd, [], patterns)).toBe(before);
    }
    // 重写未忽略路径 → 仍判 drift
    for (const file of [join(cwd, "keep.ts"), join(cwd, "reports", "r2.txt")]) {
      await writeFile(file, "rewritten");
      expect(await artifactDigest(cwd, [], patterns)).not.toBe(before);
      await writeFile(file, file.endsWith(".ts") ? "kept" : "2");
    }
  });

  it("** crosses directories in both directions and ? matches one segment character", async () => {
    await mkdir(join(cwd, "a", "b"), { recursive: true });
    await mkdir(join(cwd, "c"), { recursive: true });
    await writeFile(join(cwd, "a", "b", "t1.log"), "1");
    await writeFile(join(cwd, "a", "tX.log"), "1");
    await writeFile(join(cwd, "c", "t9.log"), "9");
    await writeFile(join(cwd, "keep.ts"), "kept");
    const patterns = ["**/*.log", "**/temp?.txt"];
    const before = await artifactDigest(cwd, [], patterns);
    for (const file of [join(cwd, "a", "b", "t1.log"), join(cwd, "a", "tX.log"), join(cwd, "c", "t9.log")]) {
      await writeFile(file, "2");
      expect(await artifactDigest(cwd, [], patterns)).toBe(before);
    }
    // **/ 前缀可以匹配零层目录：根上的 temp1.txt 同样命中 temp?.txt
    await writeFile(join(cwd, "temp1.txt"), "x");
    expect(await artifactDigest(cwd, [], patterns)).toBe(before);
    // ? 只吃一个字符：temp12.txt（两个字符）不被 temp?.txt 命中 → 判 drift
    await writeFile(join(cwd, "temp12.txt"), "x");
    expect(await artifactDigest(cwd, [], patterns)).not.toBe(before);
  });

  it("backslash separators in patterns behave like forward slashes", async () => {
    await mkdir(join(cwd, "out"));
    await writeFile(join(cwd, "out", "gen.json"), "1");
    const before = await artifactDigest(cwd, [], ["out/*.json"]);
    await writeFile(join(cwd, "out", "gen.json"), "2");
    expect(await artifactDigest(cwd, [], ["out\\*.json"])).toBe(before);
  });

  it("a directory whose every entry is ignored leaves the manifest entirely", async () => {
    await writeFile(join(cwd, "keep.ts"), "kept");
    const patterns = ["out/**/*.json"];
    const before = await artifactDigest(cwd, [], patterns);
    // 验收命令新建目录并只写入被忽略的文件 → 目录行也不出现
    await mkdir(join(cwd, "out"), { recursive: true });
    await writeFile(join(cwd, "out", "gen.json"), "1");
    expect(await artifactDigest(cwd, [], patterns)).toBe(before);
    // 深层的只含被忽略文件的子目录同样不注册
    await mkdir(join(cwd, "out", "nested"), { recursive: true });
    await writeFile(join(cwd, "out", "nested", "gen.json"), "1");
    expect(await artifactDigest(cwd, [], patterns)).toBe(before);
    // 目录里出现一个未忽略的文件 → 整棵子树重新计入
    await writeFile(join(cwd, "out", "keep.ts"), "kept");
    expect(await artifactDigest(cwd, [], patterns)).not.toBe(before);
  });

  it("rejects a pattern that would ignore the whole workspace", async () => {
    await writeFile(join(cwd, "keep.ts"), "kept");
    await expect(artifactDigest(cwd, [], ["**"])).rejects.toThrow(/whole workspace/);
    await expect(artifactDigest(cwd, [], [""])).rejects.toThrow(/whole workspace/);
  });
});

/** 任务文件种子：worker 级测试共用。 */
async function seedTask(tasksDir: string, acceptance: string | undefined): Promise<void> {
  const lines = [
    "---",
    "title: Gate task",
    "status: open",
    ...(acceptance === undefined ? [] : [`acceptance: ${JSON.stringify(acceptance)}`]),
    "criteria:",
    "  - C1 ok",
    "review_rounds: 0",
    "sessions: []",
    "retries: 0",
    "---",
    "Do work",
    "",
  ];
  await mkdir(tasksDir, { recursive: true });
  await writeFile(join(tasksDir, "a.md"), lines.join("\n"), "utf8");
}

function config(tasksDir: string, overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    tasksDir,
    workdir: cwd,
    agent: "fixture",
    contextThreshold: 0.8,
    retryLimit: 2,
    lockTtlMs: 5_000,
    heartbeatMs: 50,
    ...overrides,
  };
}

/** A turn that requests completion; the worker then polls `done.requested`. */
function adapter(): AgentAdapter {
  return {
    prompt: async () => {
      const tasksDir = join(root, "tasks");
      await mkdir(join(tasksDir, "a"), { recursive: true });
      await writeFile(join(tasksDir, "a", "done.requested"), "done");
      return { sessionId: "s", text: "done", exitCode: 0 };
    },
    contextUsage: async () => 0,
    contextLimit: async () => 100,
  };
}

const passGate = async () => ({ passed: true, skipped: false as const, exitCode: 0, output: "observed" });

const okReview = async () => ({
  verdict: "pass" as const,
  criteria: [{ id: "C1", pass: true, evidence: "fixture" }],
  externalChanges: [],
  defects: [],
  summary: "ok",
});

describe("acceptance gate × artifactIgnore (C1, worker level)", () => {
  it("a gate writing only ignored paths passes without drift", async () => {
    const tasksDir = join(root, "tasks");
    await seedTask(tasksDir, "check");
    const store = new TaskStore(tasksDir);
    const acceptance = async () => {
      await mkdir(join(cwd, "out"), { recursive: true });
      await writeFile(join(cwd, "out", "gen.json"), "generated");
      return passGate();
    };
    await runTask(config(tasksDir, { artifactIgnore: ["out", "*.json"] }), { store, adapter: adapter(), acceptance, review: okReview }, await store.get("a"), "w1");
    expect((await store.get("a")).status).toBe("done");
    const evidence = JSON.parse(await readFile(join(tasksDir, "a", "acceptance.json"), "utf8"));
    expect(evidence.passed).toBe(true);
    expect(evidence.artifactBefore).toBe(evidence.artifactAfter);
  });

  it("a gate writing a non-ignored path still invalidates the evidence", async () => {
    const tasksDir = join(root, "tasks");
    await seedTask(tasksDir, "check");
    const store = new TaskStore(tasksDir);
    const acceptance = async () => {
      await writeFile(join(cwd, "source_gen.ts"), "generated");
      return passGate();
    };
    await runTask(config(tasksDir, { artifactIgnore: ["out"] }), { store, adapter: adapter(), acceptance, review: okReview }, await store.get("a"), "w1");
    const task = await store.get("a");
    expect(task.status).toBe("blocked");
    expect(task.retries).toBe(0); // invalidation blocks directly, not through retries
    const evidence = JSON.parse(await readFile(join(tasksDir, "a", "acceptance.json"), "utf8"));
    expect(evidence.artifactBefore).not.toBe(evidence.artifactAfter);
  });
});

describe("acceptance gate × TASKCTL_ACCEPTANCE_MODE (C2, worker level)", () => {
  // A command that only generates its artifact outside check mode: exactly the
  // shape 001/002's spec-driven acceptance commands had.
  const generator = `"${process.execPath}" -e "if(process.env.TASKCTL_ACCEPTANCE_MODE!=='check')require('fs').writeFileSync('report.json','generated')"`;

  it("the gate runs check mode: no file written, digests equal, mode recorded", async () => {
    const tasksDir = join(root, "tasks");
    await seedTask(tasksDir, generator);
    const store = new TaskStore(tasksDir);
    // 不注入 acceptance seam：走真实 startAcceptance，验证 env 注入。
    await runTask(config(tasksDir), { store, adapter: adapter(), review: okReview }, await store.get("a"), "w1");
    expect((await store.get("a")).status).toBe("done");
    const evidence = JSON.parse(await readFile(join(tasksDir, "a", "acceptance.json"), "utf8"));
    expect(evidence.mode).toBe("check");
    expect(evidence.passed).toBe(true);
    expect(evidence.artifactBefore).toBe(evidence.artifactAfter);
    await expect(readFile(join(cwd, "report.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("the same command run by hand (generate default) does write its artifact", async () => {
    await writeFile(join(cwd, "seed.txt"), "workspace baseline");
    const before = await artifactDigest(cwd);
    const { runAcceptance } = await import("../src/acceptance.js");
    const result = await runAcceptance(generator, cwd);
    expect(result.passed).toBe(true);
    await expect(readFile(join(cwd, "report.json"), "utf8")).resolves.toBe("generated");
    expect(await artifactDigest(cwd)).not.toBe(before);
  });

  it("hands the collected evidence to the reviewer", async () => {
    const tasksDir = join(root, "tasks");
    await seedTask(tasksDir, generator);
    const store = new TaskStore(tasksDir);
    const seen: ReviewEvidence[] = [];
    const review = async (evidence: ReviewEvidence): Promise<ReviewResult> => {
      seen.push(evidence);
      return okReview();
    };
    await runTask(config(tasksDir), { store, adapter: adapter(), review }, await store.get("a"), "w1");
    expect((await store.get("a")).status).toBe("done");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.acceptanceMarkdown).toContain("mode: check");
  });
});
