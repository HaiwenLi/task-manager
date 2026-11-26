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
import { callTools } from "../src/mcp-client.js";

let cwd: string;        // the gate's working directory
let tasks: string;      // a small board beside it; Task 6 and Task 8 add tests that need one
const fake = fileURLToPath(new URL("./adapters/fake-opencode.mjs", import.meta.url));
const gateTree = fileURLToPath(new URL("./fixtures/gate-tree.mjs", import.meta.url));
beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), "taskctl-insulation-")); tasks = join(cwd, "tasks"); await mkdir(tasks); spawns.length = 0; });
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

it("insulation puts a work process in its own group on every platform", () => {
  expect(insulatedSpawnOptions("win32")).toEqual({ detached: true, windowsHide: true });
  expect(insulatedSpawnOptions("linux")).toEqual({ detached: true, windowsHide: false });
});

it("the gate and the agent CLI are insulated only when the controller asks", async () => {
  await acceptance.startAcceptance("echo plain-gate", cwd).result;
  expect(Boolean(spawns.at(-1)?.options.detached)).toBe(process.platform !== "win32"); // today's spawn

  await acceptance.startAcceptance("echo insulated-gate", cwd, "check", { insulated: true }).result;
  expect(spawns.at(-1)?.options).toMatchObject({ detached: true, windowsHide: process.platform === "win32" });

  await new OpenCodeAdapter({ bin: process.execPath, binArgsPrefix: [fake] }).start({ text: "hi", cwd }).result;
  expect(Boolean(spawns.at(-1)?.options.detached)).toBe(process.platform !== "win32");

  await expect(new OpenCodeAdapter({ bin: process.execPath, binArgsPrefix: [fake], insulated: true }).start({ text: "hi", cwd }).result)
    .resolves.toEqual({ sessionId: "ses_fake123", exitCode: 0, text: "你好，任务完成。" });
  expect(spawns.at(-1)?.options).toMatchObject({ detached: true, windowsHide: process.platform === "win32" });

  // The control plane joins the rule (D6, D11): the guard's catalogue read and
  // session.interrupt are `api` children of the same adapter.
  await new OpenCodeAdapter({ bin: process.execPath, binArgsPrefix: [fake] }).modelCatalog!();
  expect(Boolean(spawns.at(-1)?.options.detached)).toBe(false); // today's spawn, on every platform
  await new OpenCodeAdapter({ bin: process.execPath, binArgsPrefix: [fake], insulated: true }).modelCatalog!();
  expect(spawns.at(-1)?.options).toMatchObject({ detached: true, windowsHide: process.platform === "win32" });
});

it("a memory server is in its own group only when the caller asks", async () => {
  const server = fileURLToPath(new URL("./adapters/fake-mcp.mjs", import.meta.url));
  const call = [{ name: "a", arguments: {} }];
  await callTools({ command: [process.execPath, server], timeoutMs: 10_000, env: { FAKE_MCP_MODE: "ok" } }, call);
  expect(spawns.at(-1)?.options.detached).toBeUndefined(); // today's spawn: taskctl recall keeps it
  await callTools({ command: [process.execPath, server], timeoutMs: 10_000, env: { FAKE_MCP_MODE: "ok" }, insulated: true }, call);
  expect(spawns.at(-1)?.options.detached).toBe(true);
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
