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

it("OpenCode cancellation kills the local tree; an unacknowledged backend leaves it uncertain", async () => {
  // The process-tree fixture is not a service: it does not answer the stop
  // request, so nothing proves the backend session ended. The kill still
  // happens and is still not confirmation.
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

it("OpenCode cancellation stops the service-side session before confirming", async () => {
  // opencode run is a client of a background service: the agent loop lives
  // there and outlives a killed client (2026-11-23). The stop request goes to
  // the session observed in the stream, and its acknowledgement is what turns
  // the cancellation from "unconfirmed" into a confirmed shutdown.
  const fake = fileURLToPath(new URL("./adapters/fake-opencode.mjs", import.meta.url));
  const interrupted = join(cwd, "interrupted.txt");
  process.env.FAKE_RUN_HANG = "1";
  process.env.FAKE_INTERRUPT_FILE = interrupted;
  try {
    const execution = new OpenCodeAdapter({ bin: process.execPath, binArgsPrefix: [fake] }).start({ text: "hi", cwd });
    for (let i = 0; i < 200 && execution.inspect().sessionId === undefined; i++) await delay(25);
    expect(execution.inspect()).toMatchObject({ state: "running", sessionId: "ses_fake123" });
    const started = Date.now();
    await expect(execution.cancel()).resolves.toBe(true);
    expect(Date.now() - started).toBeLessThan(6000);
    expect(await readFile(interrupted, "utf8")).toBe("ses_fake123\n");
    expect(execution.inspect().state).toBe("exited");
  } finally {
    delete process.env.FAKE_RUN_HANG;
    delete process.env.FAKE_INTERRUPT_FILE;
  }
}, 15000);

it("an older service without the stop operation leaves OpenCode cancellation uncertain", async () => {
  const fake = fileURLToPath(new URL("./adapters/fake-opencode.mjs", import.meta.url));
  process.env.FAKE_RUN_HANG = "1";
  process.env.FAKE_INTERRUPT_UNAVAILABLE = "1";
  try {
    const execution = new OpenCodeAdapter({ bin: process.execPath, binArgsPrefix: [fake] }).start({ text: "hi", cwd });
    for (let i = 0; i < 200 && execution.inspect().sessionId === undefined; i++) await delay(25);
    await expect(execution.cancel()).resolves.toBe(false);
    expect(execution.inspect().state).toBe("uncertain");
  } finally {
    delete process.env.FAKE_RUN_HANG;
    delete process.env.FAKE_INTERRUPT_UNAVAILABLE;
  }
}, 15000);

it("a backend stop that confirms keeps a cancel out of uncertain; one that fails does not", async () => {
  const hang = (): Promise<boolean> => Promise.resolve(false);
  const live = (stop?: () => Promise<boolean>) => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd, stdio: "ignore" });
    const result = new Promise<number | null>((resolve) => child.once("close", resolve));
    return processExecution(child, result, true, stop);
  };
  const confirmed = live(async () => true);
  await expect(confirmed.cancel()).resolves.toBe(true);
  expect(confirmed.inspect().state).toBe("exited");
  for (const stop of [undefined, hang, async () => { throw new Error("service down"); }]) {
    const execution = live(stop);
    await expect(execution.cancel()).resolves.toBe(false);
    expect(execution.inspect().state).toBe("uncertain");
  }
}, 15000);

it("a client that exits by itself once the service stops the session counts as stopped", async () => {
  // The real shape of a cancelled turn: the service's interrupt ends the run,
  // the client leaves, and taskkill then reports nothing to kill. Verified
  // against the real CLI on 2026-11-23; the unit double had hidden it.
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd, stdio: "ignore" });
  const result = new Promise<number | null>((resolve) => child.once("close", resolve));
  const execution = processExecution(child, result, true, async () => { child.kill(); return true; });
  await expect(execution.cancel()).resolves.toBe(true);
  expect(execution.inspect().state).toBe("exited");
}, 15000);

it("OpenCode start preserves successful prompt results", async () => {
  const fixture = fileURLToPath(new URL("./adapters/fake-opencode.mjs", import.meta.url));
  const execution = new OpenCodeAdapter({ bin: process.execPath, binArgsPrefix: [fixture] }).start({ text: "hi", cwd });
  await expect(execution.result).resolves.toEqual({ sessionId: "ses_fake123", exitCode: 0, text: "你好，任务完成。" });
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
