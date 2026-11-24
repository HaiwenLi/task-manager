import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearModelCooldown, modelCooldown, noteModelRefusal } from "../src/model-cooldown.js";
import { retryTask } from "../src/reconcile.js";
import { writeRuntime } from "../src/runtime.js";
import { runTask, type WorkerConfig } from "../src/worker.js";
import type { AgentAdapter } from "../src/adapters/types.js";
import { TaskStore } from "../src/task-store.js";

let root: string;
let tasks: string;
let work: string;
let store: TaskStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "taskctl-model-cooldown-"));
  tasks = join(root, "tasks");
  work = join(root, "work");
  await mkdir(tasks);
  await mkdir(work);
  store = new TaskStore(tasks);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function seed(id: string): Promise<void> {
  await writeFile(join(tasks, `${id}.md`), [
    "---", "schema: taskctl/v1", `title: ${id}`, "status: open",
    'acceptance: "check"', "criteria:", "  - C1 ok",
    "sessions: []", "retries: 0", "review_rounds: 0", "---", "Work", "",
  ].join("\n"), "utf8");
}

describe("shared model cooldown", () => {
  it("expires on the injected clock, survives manual retry, and clears on success", async () => {
    const now = new Date("2026-11-24T00:00:00.000Z");
    await noteModelRefusal(tasks, "q/one", {
      reason: "weekly limit", category: "quota", cooldownMs: 900_000, now,
    });
    expect(await modelCooldown(tasks, "q/one", new Date("2026-11-24T00:14:59.000Z"))).toMatchObject({ reason: "weekly limit" });
    expect(await modelCooldown(tasks, "q/one", new Date("2026-11-24T00:15:00.000Z"))).toBeNull();

    await noteModelRefusal(tasks, "q/one", { reason: "weekly limit", cooldownMs: 900_000, now });
    await seed("a");
    await mkdir(join(tasks, "a"), { recursive: true });
    await store.setStatus("a", "blocked");
    await writeRuntime(tasks, "a", "attempt.json", {
      attemptId: "old", backend: "fixture", workspace: work,
      startedAt: now.toISOString(), updatedAt: now.toISOString(), phase: "settled", operation: "finished",
    });
    expect((await retryTask(tasks, "a", { baseWorkdir: work, registryDir: join(root, "registry") })).ok).toBe(true);
    expect(await modelCooldown(tasks, "q/one", new Date("2026-11-24T00:01:00.000Z"))).not.toBeNull();

    await clearModelCooldown(tasks, "q/one");
    expect(await modelCooldown(tasks, "q/one", new Date("2026-11-24T00:01:00.000Z"))).toBeNull();
  });

  it("skips a model another task already refused instead of dispatching it again", async () => {
    await seed("a");
    await seed("b");
    const cfg: WorkerConfig = {
      tasksDir: tasks, workdir: work, agent: "fixture", model: "q/one", modelChain: ["q/one", "q/two"],
      modelCooldownMs: 900_000, quotaBackoffMs: [0], contextThreshold: 0.8,
      retryLimit: 1, lockTtlMs: 5_000, heartbeatMs: 50,
    };
    const review = async () => ({ verdict: "pass" as const, criteria: [{ id: "C1", pass: true, evidence: "ok" }], externalChanges: [], defects: [], summary: "ok" });
    const acceptance = async () => ({ passed: true, skipped: false as const, exitCode: 0, output: "ok" });
    const first: AgentAdapter = {
      prompt: async (args) => {
        if (args.model === "q/one") return { sessionId: "", exitCode: 1, text: "weekly limit reached", failure: "provider", tokens: 0 };
        await writeFile(join(tasks, "a", "done.requested"), "done");
        return { sessionId: "ses-two", exitCode: 0, text: "done" };
      },
      contextUsage: async () => 0, contextLimit: async () => 100,
    };
    expect(await runTask(cfg, { store, adapter: first, acceptance, review }, await store.get("a"), "a-run")).toBe("done");
    expect(await modelCooldown(tasks, "q/one")).not.toBeNull();

    const seen: string[] = [];
    const second: AgentAdapter = {
      prompt: async (args) => {
        seen.push(args.model ?? "(default)");
        if (args.model === "q/one") throw new Error("cooldown model was dispatched again");
        await writeFile(join(tasks, "b", "done.requested"), "done");
        return { sessionId: "ses-b", exitCode: 0, text: "done" };
      },
      contextUsage: async () => 0, contextLimit: async () => 100,
    };
    expect(await runTask(cfg, { store, adapter: second, acceptance, review }, await store.get("b"), "b-run")).toBe("done");
    expect(seen).toEqual(["q/two"]);
  });
});
