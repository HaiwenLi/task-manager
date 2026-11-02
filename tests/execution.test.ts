import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { spawn } from "node:child_process";
import { processExecution } from "../src/execution.js";
import * as acceptance from "../src/acceptance.js";
import { OpenCodeAdapter } from "../src/adapters/opencode.js";

let cwd: string;
const fixture = fileURLToPath(new URL("./fixtures/process-tree.mjs", import.meta.url));
beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), "taskctl-lifecycle-")); });
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

async function descendant(): Promise<number> {
  for (let i = 0; i < 100; i++) {
    try { return Number(await readFile(join(cwd, "descendant.pid"), "utf8")); } catch {}
    await delay(30);
  }
  throw new Error("fixture did not start");
}

it("acceptance exposes a PID and transitions to exited after its result", async () => {
  const execution = acceptance.startAcceptance("echo lifecycle-ok", cwd);
  expect(execution.inspect()).toMatchObject({ state: "running", pid: expect.any(Number) });
  await expect(execution.result).resolves.toMatchObject({ passed: true, output: expect.stringContaining("lifecycle-ok") });
  expect(execution.inspect().state).toBe("exited");
  // An exited Windows parent no longer provides a verifiable tree to taskkill.
  await expect(execution.cancel()).resolves.toBe(process.platform !== "win32");
});

it("acceptance cancellation stops descendants and settles within a bound", async () => {
  const execution = acceptance.startAcceptance(`"${process.execPath}" "${fixture}"`, cwd);
  try {
    const pid = await descendant();
    const started = Date.now();
    await expect(execution.cancel()).resolves.toBe(true);
    expect(Date.now() - started).toBeLessThan(4000);
    expect(() => process.kill(pid, 0)).toThrow();
    await expect(execution.result).resolves.toMatchObject({ passed: false });
    expect(execution.inspect().state).toBe("exited");
  } finally { await execution.cancel(); }
}, 10000);

it("missing acceptance has no PID and never passes", async () => {
  const execution = acceptance.startAcceptance("  ", cwd);
  expect(execution.inspect()).toEqual({ state: "exited" });
  await expect(execution.result).resolves.toEqual({ passed: false, skipped: true });
});

it("OpenCode cancellation kills the local tree but cannot confirm backend termination", async () => {
  const adapter = new OpenCodeAdapter({ bin: process.execPath, binArgsPrefix: [fixture] });
  const execution = adapter.start({ text: "offline fixture", cwd });
  try {
    expect(execution.inspect()).toMatchObject({ state: "running", pid: expect.any(Number) });
    const pid = await descendant();
    await expect(execution.cancel()).resolves.toBe(false);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(execution.inspect().state).toBe("uncertain");
    expect((await execution.result).exitCode).not.toBe(0);
    await expect(execution.cancel()).resolves.toBe(false);
  } finally { await execution.cancel(); }
}, 10000);

it("OpenCode start preserves successful prompt results", async () => {
  const fixture = fileURLToPath(new URL("./adapters/fake-opencode.mjs", import.meta.url));
  const execution = new OpenCodeAdapter({ bin: process.execPath, binArgsPrefix: [fixture] }).start({ text: "hi", cwd });
  await expect(execution.result).resolves.toEqual({ sessionId: "ses_fake123", exitCode: 0, text: "你好，任务完成" });
  expect(execution.inspect().state).toBe("exited");
  await expect(execution.cancel()).resolves.toBe(process.platform !== "win32");
});

it("spawn failure remains observable without an unhandled rejection while unawaited", async () => {
  const execution = new OpenCodeAdapter({ bin: "taskctl-no-such-binary" }).start({ text: "hi", cwd });
  await delay(50);
  await expect(execution.result).rejects.toMatchObject({ code: "ENOENT" });
  expect(execution.inspect().state).toBe("exited");
});

it("does not report confirmed shutdown when the parent vanished before tree cancellation", async () => {
  // On Windows taskkill cannot reconstruct an already reparented process tree.
  // POSIX still owns a group and may confirm termination; either way cancel is bounded.
  const child = spawn(process.execPath, [fixture, "exit-parent"], {
    cwd, detached: process.platform !== "win32",
  });
  child.stdin.end();
  child.stdout.resume();
  child.stderr.resume();
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const result = new Promise<number | null>((resolve) => child.once("close", resolve));
  const execution = processExecution(child, result);
  let pid: number | undefined;
  try {
    pid = await descendant();
    await exited;
    const started = Date.now();
    const confirmed = await execution.cancel();
    expect(Date.now() - started).toBeLessThan(4000);
    if (process.platform === "win32") {
      expect(confirmed).toBe(false);
      expect(execution.inspect().state).toBe("uncertain");
    }
  } finally {
    if (pid !== undefined) {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
    await result;
  }
}, 10000);
