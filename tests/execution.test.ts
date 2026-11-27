import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  CANCEL_BUDGET_MS,
  descendantsOf,
  parseProcessTable,
  platformTreeControl,
  processExecution,
  stopTree,
  TREE_KILL_DEADLINE_MS,
  TREE_LIST_DEADLINE_MS,
  TREE_SETTLE_MS,
  type KillRunner,
  type TreeControl,
} from "../src/execution.js";
import { CANCEL_DEADLINE_MS } from "../src/worker.js";
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

const gateTree = fileURLToPath(new URL("./fixtures/gate-tree.mjs", import.meta.url));

async function treePids(): Promise<{ root: number; child: number; leaf: number }> {
  for (let i = 0; i < 100; i++) {
    try { return JSON.parse(await readFile(join(cwd, "tree-pids.json"), "utf8")); } catch { /* not yet */ }
    await delay(30);
  }
  throw new Error("the gate tree did not start");
}

/** A child whose `exit` and `close` arrive when the test says so, under a pid nobody owns. */
function scriptedChild(timing: { exitAfterMs?: number; closeAfterMs?: number }): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess;
  Object.defineProperty(child, "pid", { value: 4_000_000 });
  if (timing.exitAfterMs !== undefined) setTimeout(() => child.emit("exit", 1, null), timing.exitAfterMs);
  if (timing.closeAfterMs !== undefined) setTimeout(() => child.emit("close", 1), timing.closeAfterMs);
  return child;
}
const never = new Promise<never>(() => {});
const noTree: TreeControl = { descendants: async () => [], killTree: async () => true };

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
    // a real cancel now lists the process table first (PowerShell) before it kills
    expect(Date.now() - started).toBeLessThan(7000);
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
}, 30000);

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

it("the output pipes are waited for to the end of the cancel budget, not for 500 ms", async () => {
  const execution = processExecution(scriptedChild({ exitAfterMs: 0, closeAfterMs: 1_500 }), never, false, undefined, noTree);
  const started = Date.now();
  await expect(execution.cancel()).resolves.toBe(true);
  expect(Date.now() - started).toBeGreaterThanOrEqual(1_400);
  expect(execution.inspect().state).toBe("exited");
}, 10_000);

it("a descendant the tree kill leaves alive keeps the cancellation unconfirmed", async () => {
  const bystander = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd, stdio: "ignore" });
  try {
    const execution = acceptance.startAcceptance(`"${process.execPath}" "${gateTree}"`, cwd, "check", {
      trees: { ...platformTreeControl, descendants: async () => [bystander.pid!] },
    });
    try {
      await treePids();
      // `cancel()` is memoized: the `finally` below answers with this same
      // promise if the tree never started, so the gate is always cancelled.
      await expect(execution.cancel()).resolves.toBe(false);
      expect(execution.inspect().state).toBe("uncertain");
    } finally {
      await execution.cancel();
    }
  } finally {
    bystander.kill();
    // it is going down either way; wait so the directory can be removed
    await Promise.race([
      new Promise<void>((resolve) => bystander.once("exit", () => resolve())),
      delay(500),
    ]);
  }
}, 15_000);

it("the kill utility's report is not needed once the tree is known to be gone", async () => {
  const calls: string[] = [];
  let known: number[] = [];
  const execution = acceptance.startAcceptance(`"${process.execPath}" "${gateTree}"`, cwd, "check", {
    trees: {
      descendants: async () => { calls.push("list"); return known; },
      killTree: async (root) => {
        calls.push("kill");
        for (const pid of [root, ...known]) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
        return false; // the utility timed out, as far as this execution knows
      },
    },
  });
  try {
    const tree = await treePids();
    // the listing is of the whole live tree — a node it does not hold would
    // still inherit the output pipes and keep the close from ever arriving
    known = [tree.root, tree.child, tree.leaf];
    // Memoized: the `finally`'s call is this same one when the tree started.
    await expect(execution.cancel()).resolves.toBe(true);
    expect(calls).toEqual(["list", "kill"]);
    expect(execution.inspect().state).toBe("exited");
    for (const pid of known) expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    // When the fixture never recorded the tree, `known` stays empty and the
    // `killTree` above ends only the root: the real tree is ended first, then
    // the cancel settles the execution. A root that has already exited names
    // no tree — its output pipes have closed, so no descendant that inherited
    // them survives, and its pid may belong to another process by now.
    if (known.length === 0 && execution.inspect().state !== "exited") await platformTreeControl.killTree(execution.inspect().pid!);
    await execution.cancel();
  }
}, 15_000);

it("a root whose exit was never observed is not confirmed", async () => {
  const execution = processExecution(scriptedChild({ closeAfterMs: 0 }), never, false, undefined, noTree);
  await expect(execution.cancel()).resolves.toBe(false);
});

it("a tree whose output pipes never close is not confirmed", async () => {
  const execution = processExecution(scriptedChild({ exitAfterMs: 0 }), never, false, undefined, noTree);
  const started = Date.now();
  await expect(execution.cancel()).resolves.toBe(false);
  expect(Date.now() - started).toBeLessThan(CANCEL_DEADLINE_MS + 2_000);
}, 12_000);

it("a platform that cannot list processes falls back to the utility's report", async () => {
  const cannotList: TreeControl = { descendants: async () => null, killTree: async () => true };
  const gone = processExecution(scriptedChild({ exitAfterMs: 0, closeAfterMs: 0 }), never, false, undefined, cannotList);
  await expect(gone.cancel()).resolves.toBe(true);
  const alive = processExecution(scriptedChild({ exitAfterMs: 0, closeAfterMs: 0 }), never, false, undefined, { ...cannotList, killTree: async () => false });
  await expect(alive.cancel()).resolves.toBe(false);
});

it("a listing that never answers does not hang the cancel", async () => {
  const hung: TreeControl = { descendants: () => never, killTree: async () => true };
  const execution = processExecution(scriptedChild({ exitAfterMs: 0, closeAfterMs: 0 }), never, false, undefined, hung);
  const started = Date.now();
  await expect(execution.cancel()).resolves.toBe(true);
  expect(Date.now() - started).toBeLessThan(TREE_LIST_DEADLINE_MS + 2_000);
}, 10_000);

it("the Windows listing finds the live descendants of a real tree", async () => {
  const execution = acceptance.startAcceptance(`"${process.execPath}" "${gateTree}"`, cwd);
  try {
    const tree = await treePids();
    const found = await platformTreeControl.descendants(execution.inspect().pid!);
    if (process.platform !== "win32") { expect(found).toBeNull(); return; }
    expect(found).toEqual(expect.arrayContaining([tree.root, tree.child, tree.leaf]));
    expect(found).not.toContain(process.pid);
  } finally { await execution.cancel(); }
}, 15_000);

it("lineage follows live parents only: a child created before its putative parent is not its child", () => {
  const table = parseProcessTable([
    "100,1,20261125090000", "200,100,20261125090001", "300,200,20261125090002",
    "400,100,20261125080000", "500,999,20261125090005",   // 400 names pid 100, but 100 was born later: a reused pid
  ].join("\n"));
  expect(table).not.toBeNull();
  expect(descendantsOf(table!, 100)).toEqual([200, 300]);
  expect(descendantsOf(table!, 999)).toEqual([]);
});

it("a listing the platform did not answer cleanly parses to null", () => {
  expect(parseProcessTable("")).toBeNull();
  expect(parseProcessTable("Get-CimInstance : Access denied.")).toBeNull();
  expect(parseProcessTable("100,1,2026112509000")).toBeNull();
});

it("a kill the utility answers after the old 1 500 ms cap is still confirmed", async () => {
  // The reproduction of the 2026-11-27 failures: on a machine with ~1 260
  // processes taskkill needs ~1.7 s to do its own enumeration, so a 1 500 ms
  // cap kills the utility mid-flight and reports an unconfirmed stop.
  if (process.platform !== "win32") return;
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  try {
    await delay(500); // let the process be created before it is killed
    await expect(platformTreeControl.killTree(child.pid!)).resolves.toBe(true);
  } finally {
    try { child.kill(); } catch { /* already gone */ }
  }
}, 20_000);

it("the kill deadline believes a 2 s utility and abandons one that never answers", async () => {
  // 2 s is what taskkill costs on the machine this plan was opened for; the
  // default deadline (not one the test chooses) must outlast it. Pinned with
  // fake timers on purpose: the point is the deadline, not this host's speed.
  if (process.platform !== "win32") return;
  const late: KillRunner = (_pid, done) => {
    const timer = setTimeout(() => done(true), 2_000);
    return { kill: () => clearTimeout(timer) };
  };
  let abandoned = false;
  const silent: KillRunner = () => ({ kill: () => { abandoned = true; } });
  vi.useFakeTimers();
  try {
    const believed = stopTree(4_000_001, undefined, late);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(believed).resolves.toBe(true);

    const hung = stopTree(4_000_002, undefined, silent);
    await vi.advanceTimersByTimeAsync(TREE_KILL_DEADLINE_MS - 1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(hung).resolves.toBe(false);
    expect(abandoned).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

it("the cancel budget stays inside the attempt's cancel deadline", () => {
  // Listing, kill, the two settle waits, and the pipe wait's own floor: the
  // worst case a cancel can reach before it answers, which the budget must hold.
  expect(TREE_LIST_DEADLINE_MS + TREE_KILL_DEADLINE_MS + 3 * TREE_SETTLE_MS).toBeLessThanOrEqual(CANCEL_BUDGET_MS);
  expect(CANCEL_BUDGET_MS).toBeLessThan(CANCEL_DEADLINE_MS);
});
