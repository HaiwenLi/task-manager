import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import type { SpawnOptions } from "node:child_process";

/** Every spawn, recorded and then made for real. */
const spawns = vi.hoisted(() => [] as Array<{ file: string; options: SpawnOptions }>);

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const recorded = (file: string, args: readonly string[] = [], options: SpawnOptions = {}) => {
    spawns.push({ file, options });
    return actual.spawn(file, args, options);
  };
  return { ...actual, spawn: recorded };
});

import * as acceptance from "../src/acceptance.js";
import { insulatedSpawnOptions } from "../src/execution.js";
import { OpenCodeAdapter } from "../src/adapters/opencode.js";
import type { MemorySettings } from "../src/memory.js";
import { callTools } from "../src/mcp-client.js";
import type { StopNow } from "../src/stop.js";
import type { Task } from "../src/task-file.js";
import { TaskStore } from "../src/task-store.js";
import { runTask, type WorkerConfig } from "../src/worker.js";
import { runCli } from "../src/cli.js";
import { writeRuntime } from "../src/runtime.js";
import { buildTaskFile } from "./helpers/task-fixture.js";
import { manualStopNow } from "./helpers/stop-fixture.js";
import { markDoneTask, passAcceptance, seedTaskFile, workerConfigFixture } from "./helpers/watch-fixture.js";

let cwd: string;        // the gate's working directory
let tasks: string;      // a small board beside it; Task 6 and Task 8 add tests that need one
let work: string;       // the attempts' workspace
let store: TaskStore;
let cfg: WorkerConfig;
const fake = fileURLToPath(new URL("./adapters/fake-opencode.mjs", import.meta.url));
const gateTree = fileURLToPath(new URL("./fixtures/gate-tree.mjs", import.meta.url));
/** What insulation is on this platform: a hidden console of its own on Windows, a process group elsewhere. */
const INSULATED = process.platform === "win32" ? { windowsHide: true } : { detached: true };
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "taskctl-insulation-"));
  tasks = join(cwd, "tasks");
  work = join(cwd, "work");
  await mkdir(tasks);
  await mkdir(work);
  store = new TaskStore(tasks);
  cfg = workerConfigFixture({ tasksDir: tasks, workdir: work, lockTtlMs: 5_000, heartbeatMs: 1_000 });
  spawns.length = 0;
});
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

const mechanical = (id: string, overrides: Partial<Task> = {}): Task =>
  buildTaskFile({ id, complexity: "complex", verify: "mechanical", criteria: ["C1 ok"], acceptance: "check", ...overrides });

it("insulation is a hidden console on Windows and a process group everywhere else", () => {
  expect(insulatedSpawnOptions("win32")).toEqual({ windowsHide: true });
  expect(insulatedSpawnOptions("linux")).toEqual({ detached: true });
});

it("the gate and the agent CLI are insulated only when the controller asks", async () => {
  await acceptance.startAcceptance("echo plain-gate", cwd).result;
  expect(Boolean(spawns.at(-1)?.options.detached)).toBe(process.platform !== "win32"); // today's spawn
  // Windows-only: on POSIX a plain gate is detached too, so `INSULATED`
  // (`{ detached: true }`) is exactly what it carries; there is nothing to see.
  if (process.platform === "win32") expect(spawns.at(-1)?.options).not.toMatchObject(INSULATED);

  await acceptance.startAcceptance("echo insulated-gate", cwd, "check", { insulated: true }).result;
  expect(spawns.at(-1)?.options).toMatchObject(INSULATED);
  if (process.platform === "win32") expect(spawns.at(-1)?.options.detached).not.toBe(true);

  await new OpenCodeAdapter({ bin: process.execPath, binArgsPrefix: [fake] }).start({ text: "hi", cwd }).result;
  expect(Boolean(spawns.at(-1)?.options.detached)).toBe(process.platform !== "win32");
  // Windows-only, for the same reason as the plain gate above.
  if (process.platform === "win32") expect(spawns.at(-1)?.options).not.toMatchObject(INSULATED);

  await expect(new OpenCodeAdapter({ bin: process.execPath, binArgsPrefix: [fake], insulated: true }).start({ text: "hi", cwd }).result)
    .resolves.toEqual({ sessionId: "ses_fake123", exitCode: 0, text: "你好，任务完成。" });
  expect(spawns.at(-1)?.options).toMatchObject(INSULATED);
  if (process.platform === "win32") expect(spawns.at(-1)?.options.detached).not.toBe(true);

  // The control plane joins the rule (D6, D11): the guard's catalogue read and
  // session.interrupt are `api` children of the same adapter.
  await new OpenCodeAdapter({ bin: process.execPath, binArgsPrefix: [fake] }).modelCatalog!();
  expect(Boolean(spawns.at(-1)?.options.detached)).toBe(false); // today's spawn, on every platform
  expect(spawns.at(-1)?.options).not.toMatchObject(INSULATED);
  await new OpenCodeAdapter({ bin: process.execPath, binArgsPrefix: [fake], insulated: true }).modelCatalog!();
  expect(spawns.at(-1)?.options).toMatchObject(INSULATED);
  if (process.platform === "win32") expect(spawns.at(-1)?.options.detached).not.toBe(true);
});

it("an insulated gate's output comes back through the pipes", async () => {
  const execution = acceptance.startAcceptance(`"${process.execPath}" -e "console.log('insulated-gate-output')"`, cwd, "check", { insulated: true });
  try {
    const result = await execution.result;
    expect(result.skipped).toBe(false);
    if (!result.skipped) expect(result.output).toContain("insulated-gate-output");
  } finally {
    await execution.cancel();
  }
});

it("a memory server is in its own group only when the caller asks", async () => {
  const server = fileURLToPath(new URL("./adapters/fake-mcp.mjs", import.meta.url));
  const call = [{ name: "a", arguments: {} }];
  await callTools({ command: [process.execPath, server], timeoutMs: 10_000, env: { FAKE_MCP_MODE: "ok" } }, call);
  expect(spawns.at(-1)?.options.detached).toBeUndefined(); // today's spawn: taskctl recall keeps it
  await callTools({ command: [process.execPath, server], timeoutMs: 10_000, env: { FAKE_MCP_MODE: "ok" }, insulated: true }, call);
  expect(spawns.at(-1)?.options).toMatchObject(INSULATED);
  if (process.platform === "win32") expect(spawns.at(-1)?.options.detached).not.toBe(true);
});

it("an insulated gate is still cancelled as a tree", async () => {
  const execution = acceptance.startAcceptance(`"${process.execPath}" "${gateTree}"`, cwd, "check", { insulated: true });
  let tree: { root: number; child: number; leaf: number };
  for (let i = 0; i < 300; i++) {
    try { tree = JSON.parse(await readFile(join(cwd, "tree-pids.json"), "utf8")); break; } catch { await delay(30); }
  }
  await expect(execution.cancel()).resolves.toBe(true);
  for (const pid of Object.values(tree!)) expect(() => process.kill(pid, 0)).toThrow();
}, 15_000);

it("retry --review-only constructs an insulated adapter: every child of it is in its own group", async () => {
  const configPath = join(cwd, "taskctl.json");
  // node stands in for opencode: it cannot answer `api model.list`, so the
  // guard refuses before any turn — the adapter's catalogue read is the child
  // this run starts.
  await writeFile(configPath, JSON.stringify({ tasksDir: tasks, workdir: work, opencodeBin: process.execPath, retryLimit: 1 }), "utf8");
  // A task parked the way a reviewer that timed out parks it, staged without a
  // process: a settled attempt and a valid review-pending record.
  await seedTaskFile(tasks, buildTaskFile({ id: "a", title: "a", status: "blocked", complexity: "simple", verify: "human", criteria: ["C1 ok"] }));
  const now = new Date().toISOString();
  await mkdir(join(tasks, "a"), { recursive: true });
  await writeRuntime(tasks, "a", "attempt.json", { attemptId: "old", backend: "fixture", workspace: work, startedAt: now, updatedAt: now, phase: "settled", operation: "finished" });
  await writeRuntime(tasks, "a", "review-pending.json", { definitionDigest: "d", artifactDigest: "d", createdAt: now, updatedAt: now, refusals: [] });
  spawns.length = 0;
  const lines: string[] = [];
  expect(await runCli(["retry", "--task", "a", "--review-only", "--config", configPath], { log: (line) => lines.push(line), err: (line) => lines.push(line) })).toBe(1);
  expect(lines.join("\n")).toContain("review-only recovery refused or still unavailable: refused");
  const children = spawns.filter((spawn) => spawn.file === process.execPath);
  expect(children.length).toBeGreaterThan(0);
  for (const child of children) {
    expect(child.options).toMatchObject(INSULATED);
    if (process.platform === "win32") expect(child.options.detached).not.toBe(true);
  }
});

it("the worker's gate is insulated: the controller cancels it itself", async () => {
  await seedTaskFile(tasks, mechanical("a", { acceptance: "echo worker-gate" }));
  expect(await runTask(cfg, { store, adapter: { prompt: async (args) => { await markDoneTask(args.text, tasks); return { sessionId: "s", exitCode: 0, text: "done" }; }, contextUsage: async () => 0, contextLimit: async () => 100 } }, await store.get("a"), "w1")).toBe("done");
  expect(spawns.at(-1)?.file).toBe(process.platform === "win32" ? "cmd" : "sh");
  expect(spawns.at(-1)?.options).toMatchObject(INSULATED);
  if (process.platform === "win32") expect(spawns.at(-1)?.options.detached).not.toBe(true);
});

it("an attempt's memory server is in its own group exactly when the attempt can be stopped", async () => {
  // No `memory` seam: the attempt builds its own backend, so the real spawn is the one observed.
  process.env.FAKE_MCP_MODE = "ok";
  const server = fileURLToPath(new URL("./adapters/fake-mcp.mjs", import.meta.url));
  const memory: MemorySettings = {
    backend: "mempalace", command: [process.execPath, server], excludeWings: [], rooms: ["pitfall"],
    minSimilarity: 0.55, maxItems: 5, maxChars: 2_000, itemChars: 400, timeoutMs: 10_000,
  };
  const attempt = async (id: string, stop?: StopNow) => {
    await seedTaskFile(tasks, mechanical(id, { acceptance: "echo gate" }));
    spawns.length = 0;
    await runTask({ ...cfg, memory }, {
      store, ...(stop === undefined ? {} : { stop }),
      adapter: { prompt: async (args) => { await markDoneTask(args.text, tasks); return { sessionId: "s", exitCode: 0, text: "done" }; }, contextUsage: async () => 0, contextLimit: async () => 100 },
    }, await store.get(id), "w1");
    return spawns.filter((spawn) => spawn.file === process.execPath); // the server: the gate is the shell, the turn is a seam
  };
  try {
    const plain = await attempt("a");
    expect(plain).toHaveLength(1);
    expect(plain[0]?.options.detached).toBeUndefined(); // no stop source: today's spawn, as taskctl recall
    const insulated = await attempt("b", manualStopNow());
    expect(insulated).toHaveLength(1);
    expect(insulated[0]?.options).toMatchObject(INSULATED);
    if (process.platform === "win32") expect(insulated[0]?.options.detached).not.toBe(true);
  } finally { delete process.env.FAKE_MCP_MODE; }
}, 10_000);

it("run constructs an insulated agent CLI: every child of the adapter it builds is in its own group", async () => {
  const configPath = join(cwd, "taskctl.json");
  await writeFile(configPath, JSON.stringify({ tasksDir: tasks, workdir: work, opencodeBin: process.execPath, retryLimit: 1 }), "utf8");
  // node standing in for opencode cannot answer `api model.list`, so the budget guard refuses the
  // task before any turn: the catalogue reads are the only children this run starts.
  await seedTaskFile(tasks, buildTaskFile({ id: "a", title: "a", status: "open", complexity: "simple", verify: "mechanical", acceptance: "echo gate", criteria: ["C1 ok"] }));
  const lines: string[] = [];
  expect(await runCli(["run", "--config", configPath], { log: (line) => lines.push(line), err: (line) => lines.push(line) })).toBe(1);
  expect(lines.join("\n")).toContain("refused by the budget guard");
  const children = spawns.filter((spawn) => spawn.file === process.execPath);
  expect(children.length).toBeGreaterThan(0);
  for (const child of children) {
    expect(child.options).toMatchObject(INSULATED);
    if (process.platform === "win32") expect(child.options.detached).not.toBe(true);
  }
});
