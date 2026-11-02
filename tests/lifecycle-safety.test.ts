import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "../src/task-store.js";
import { runWorker, type WorkerConfig } from "../src/worker.js";
import type { AgentAdapter } from "../src/adapters/types.js";
import { claim } from "../src/claim.js";
import type { Execution } from "../src/execution.js";
import { OpenCodeAdapter } from "../src/adapters/opencode.js";
import { fileURLToPath } from "node:url";

let root: string;
let tasks: string;
let cwd: string;
let store: TaskStore;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "taskctl-safe-"));
  tasks = join(root, "tasks"); cwd = join(root, "work");
  await mkdir(tasks); await mkdir(cwd);
  store = new TaskStore(tasks);
});
afterEach(async () => {
  delete process.env.TASKCTL_FIXTURE_MARKER; delete process.env.TASKCTL_FIXTURE_HANG;
  delete process.env.TASKCTL_FIXTURE_EXIT;
  await rm(root, { recursive: true, force: true });
});

async function seed(acceptance?: string) {
  await writeFile(join(tasks, "a.md"), `---\ntitle: Safe task\nstatus: open\nsessions: []\nretries: 0\n${acceptance === undefined ? "" : `acceptance: ${JSON.stringify(acceptance)}\n`}---\nDo work\n`);
}
function config(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return { tasksDir: tasks, workdir: cwd, agent: "fixture", contextThreshold: .8,
    retryLimit: 2, lockTtlMs: 100, heartbeatMs: 10, ...overrides };
}
function adapter(turn: () => Promise<void>): AgentAdapter {
  return { prompt: async () => { await turn(); return { sessionId: "s", text: "done", exitCode: 0 }; },
    contextUsage: async () => 0, contextLimit: async () => 100 };
}
async function done() { await mkdir(join(tasks, "a"), { recursive: true }); await writeFile(join(tasks, "a", "done.requested"), "done"); }
const pass = async () => ({ passed: true, skipped: false as const, exitCode: 0, output: "observed" });

describe("review lifecycle safety regressions", () => {
  it("unexpected OpenCode CLI death blocks instead of retrying a possibly surviving backend", async () => {
    await seed("check");
    process.env.TASKCTL_FIXTURE_MARKER = join(tasks, "a", "done.requested");
    process.env.TASKCTL_FIXTURE_EXIT = "1";
    const backend = new OpenCodeAdapter({ bin: process.execPath,
      binArgsPrefix: [fileURLToPath(new URL("./fixtures/offline-agent.mjs", import.meta.url))] });
    expect(await runWorker(config({ lockTtlMs: 5_000, heartbeatMs: 200 }), { store, adapter: backend })).toEqual({ done: [], blocked: ["a"] });
    expect(await readFile(join(cwd, "starts.txt"), "utf8")).toBe("started\n");
    expect((await store.get("a")).retries).toBe(0);
    const record = JSON.parse(await readFile(join(tasks, "a", "attempt.json"), "utf8"));
    expect(record.phase).toBe("uncertain");
    expect(record.sessionId).toBe("offline-session");
  });
  it("offline end-to-end: real adapter process, store, acceptance and bound evidence", async () => {
    await seed(`"${process.execPath}" -e "if(require('fs').readFileSync('artifact.txt','utf8')!=='fixture output')process.exit(1)"`);
    process.env.TASKCTL_FIXTURE_MARKER = join(tasks, "a", "done.requested");
    const backend = new OpenCodeAdapter({ bin: process.execPath,
      binArgsPrefix: [fileURLToPath(new URL("./fixtures/offline-agent.mjs", import.meta.url))] });
    expect(await runWorker(config({ lockTtlMs: 5_000, heartbeatMs: 200 }), { store, adapter: backend })).toEqual({ done: ["a"], blocked: [] });
    expect((await store.get("a")).sessions).toEqual(["offline-session"]);
    expect(JSON.parse(await readFile(join(tasks, "a", "attempt.json"), "utf8")).phase).toBe("settled");
  });
  it("T4: absent acceptance blocks for review instead of accepting", async () => {
    await seed();
    expect(await runWorker(config(), { store, adapter: adapter(done) })).toEqual({ done: [], blocked: ["a"] });
    expect((await store.get("a")).retries).toBe(0);
  });
  it("T3: replacement owner during acceptance prevents Done and all stale mutations", async () => {
    await seed("check");
    const acceptance = async () => {
      await writeFile(join(tasks, "a", "lock.json"), JSON.stringify({ worker: "successor", heartbeat: Date.now() }));
      return pass();
    };
    expect(await runWorker(config(), { store, adapter: adapter(done), acceptance })).toEqual({ done: [], blocked: [] });
    expect((await store.get("a")).status).toBe("running");
    expect(JSON.parse(await readFile(join(tasks, "a", "lock.json"), "utf8")).worker).toBe("successor");
  });
  it("T1: renewal continues during a turn longer than TTL", async () => {
    await seed("check");
    let duplicate = true;
    const a = adapter(async () => {
      await new Promise(r => setTimeout(r, 180));
      duplicate = await claim(tasks, "a", "contender", 100);
      await done();
    });
    expect(await runWorker(config(), { store, adapter: a, acceptance: pass })).toEqual({ done: ["a"], blocked: [] });
    expect(duplicate).toBe(false);
  });
  it("T2: an uncancellable timed-out turn is never retried, including after restart", async () => {
    await seed("check");
    let calls = 0;
    const a = adapter(async () => { calls++; await new Promise<void>(() => {}); });
    expect(await runWorker(config({ turnTimeoutMs: 20 }), { store, adapter: a })).toEqual({ done: [], blocked: ["a"] });
    expect(calls).toBe(1);
    await store.setStatus("a", "open");
    expect(await runWorker(config(), { store, adapter: a })).toEqual({ done: [], blocked: ["a"] });
    expect(calls).toBe(1);
  });
  it("definition drift during acceptance invalidates completion", async () => {
    await seed("check");
    const acceptance = async () => { const f = join(tasks, "a.md"); await writeFile(f, (await readFile(f, "utf8")).replace("Do work", "Different work")); return pass(); };
    expect(await runWorker(config(), { store, adapter: adapter(done), acceptance })).toEqual({ done: [], blocked: ["a"] });
    expect((await store.get("a")).description).toContain("Different work");
  });
  it("artifact mutation during acceptance invalidates completion", async () => {
    await seed("check");
    const acceptance = async () => { await writeFile(join(cwd, "changed.txt"), "new"); return pass(); };
    expect(await runWorker(config(), { store, adapter: adapter(done), acceptance })).toEqual({ done: [], blocked: ["a"] });
  });
  it("persists successful check evidence bound to an attempt and artifact", async () => {
    await seed("check");
    expect(await runWorker(config(), { store, adapter: adapter(done), acceptance: pass })).toEqual({ done: ["a"], blocked: [] });
    const evidence = JSON.parse(await readFile(join(tasks, "a", "acceptance.json"), "utf8"));
    expect(evidence).toMatchObject({ command: "check", passed: true, output: "observed" });
    expect(evidence.attemptId).toBeTruthy();
    expect(evidence.definitionDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.artifactBefore).toBe(evidence.artifactAfter);
  });
  it("confirmed cancellation finishes the old turn before retrying", async () => {
    await seed("check");
    let active = 0, calls = 0, maxActive = 0;
    const a: AgentAdapter = {
      ...adapter(async () => {}),
      start(): Execution<{ sessionId: string; exitCode: number; text: string }> {
        calls++; active++; maxActive = Math.max(maxActive, active);
        let state: "running" | "exited" = "running";
        let finish!: (value: { sessionId: string; exitCode: number; text: string }) => void;
        const result = new Promise<{ sessionId: string; exitCode: number; text: string }>(resolve => { finish = resolve; });
        if (calls === 2) {
          void done().then(() => { state = "exited"; active--; finish({ sessionId: "second", exitCode: 0, text: "done" }); });
        }
        return { result, inspect: () => ({ state }), cancel: async () => {
          state = "exited"; active--; finish({ sessionId: "first", exitCode: -1, text: "stopped" }); return true;
        } };
      },
    };
    expect(await runWorker(config({ turnTimeoutMs: 40 }), { store, adapter: a, acceptance: pass })).toEqual({ done: ["a"], blocked: [] });
    expect(calls).toBe(2); expect(maxActive).toBe(1); expect(active).toBe(0);
    expect((await store.get("a")).retries).toBe(1);
  });
  it("an active journal prevents replay even if task status was reset to open", async () => {
    await seed("check"); await mkdir(join(tasks, "a"));
    await writeFile(join(tasks, "a", "attempt.json"), JSON.stringify({ attemptId: "interrupted", phase: "active", operation: "agent turn", workspace: cwd, backend: "fixture" }));
    let calls = 0;
    expect(await runWorker(config(), { store, adapter: adapter(async () => { calls++; }) })).toEqual({ done: [], blocked: ["a"] });
    expect(calls).toBe(0);
  });
  it("lease loss cancels an active turn and prevents session/retry/final writes", async () => {
    await seed("check");
    let cancelled = false;
    const a: AgentAdapter = {
      ...adapter(async () => {}),
      start() {
        let state: "running" | "exited" = "running";
        let finish!: (value: { sessionId: string; exitCode: number; text: string }) => void;
        const result = new Promise<{ sessionId: string; exitCode: number; text: string }>(resolve => { finish = resolve; });
        // Simulate takeover while execution is still pending, not just after a result.
        void writeFile(join(tasks, "a", "lock.json"), JSON.stringify({ worker: "successor", heartbeat: Date.now() }));
        return { result, inspect: () => ({ state }), cancel: async () => {
          cancelled = true; state = "exited"; finish({ sessionId: "stale", exitCode: -1, text: "stopped" }); return true;
        } };
      },
    };
    expect(await runWorker(config(), { store, adapter: a, acceptance: pass })).toEqual({ done: [], blocked: [] });
    expect(cancelled).toBe(true);
    expect(await store.get("a")).toMatchObject({ status: "running", sessions: [], retries: 0 });
    expect(JSON.parse(await readFile(join(tasks, "a", "lock.json"), "utf8")).worker).toBe("successor");
  });
});
