import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAcceptance } from "../src/acceptance.js";

/** Tests must run on both cmd (win32) and sh (everything else). */
const isWin = process.platform === "win32";

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "taskctl-acceptance-"));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe("runAcceptance", () => {
  it("passes when the command exits 0, capturing its output", async () => {
    const result = await runAcceptance("echo gate-ok", cwd);

    expect(result).toMatchObject({ passed: true, exitCode: 0, skipped: false });
    expect(result.output).toContain("gate-ok");
  });

  it("fails when the command exits non-zero", async () => {
    const result = await runAcceptance("exit 1", cwd);

    expect(result).toMatchObject({ passed: false, exitCode: 1, skipped: false });
  });

  it("includes stderr in the output of a failing command", async () => {
    // stdout 与 stderr 合并进 output，验收失败时能看到命令报了什么
    const command = isWin ? "echo boom 1>&2 & exit 1" : "echo boom >&2; exit 1";

    const result = await runAcceptance(command, cwd);

    expect(result.passed).toBe(false);
    expect(result.output).toContain("boom");
  });

  it("runs the command with cwd as working directory", async () => {
    await runAcceptance("echo hi > cwd-marker.txt", cwd);

    await expect(readFile(join(cwd, "cwd-marker.txt"), "utf8")).resolves.toContain("hi");
  });

  it("skips without passing when no acceptance command is configured", async () => {
    // 无 acceptance 字段 → 调用方传空串；告警日志是调用方的职责（ADR-0006）
    await expect(runAcceptance("", cwd)).resolves.toEqual({ passed: false, skipped: true });
  });

  it("does not execute whitespace-only acceptance commands", async () => {
    await expect(runAcceptance(" \t\r\n ", cwd)).resolves.toEqual({ passed: false, skipped: true });
  });

  it("reports a spawn failure as not passed with a null exit code", async () => {
    // 例如 cwd 不存在：进程根本没有起来，不存在退出码
    const result = await runAcceptance("echo hi", join(cwd, "does-not-exist"));

    expect(result).toMatchObject({ passed: false, exitCode: null, skipped: false });
  });
});
