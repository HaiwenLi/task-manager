import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter } from "../src/adapters/types.js";
import type { ReviewResult } from "../src/review.js";
import { definitionDigest, readDefinitionSnapshot, readRuntime, writeDefinitionSnapshot } from "../src/runtime.js";
import { TaskStore } from "../src/task-store.js";
import { parseTaskFile } from "../src/task-file.js";
import { runTask, type WorkerConfig } from "../src/worker.js";
import { buildTaskFile } from "./helpers/task-fixture.js";

let root: string;
let tasks: string;
let cwd: string;
let store: TaskStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "taskctl-definition-"));
  tasks = join(root, "tasks");
  cwd = join(root, "work");
  await mkdir(tasks);
  await mkdir(cwd);
  store = new TaskStore(tasks);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function config(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    tasksDir: tasks, workdir: cwd, agent: "fixture", contextThreshold: 0.8,
    retryLimit: 2, lockTtlMs: 5_000, heartbeatMs: 50, ...overrides,
  };
}

/** The task the incidents were about: a command acceptance, criteria, running mid-flight. */
async function seed(overrides: Partial<Parameters<typeof buildTaskFile>[0]> = {}): Promise<void> {
  const task = buildTaskFile({
    id: "a", title: "填表", status: "open", acceptance: "check",
    criteria: ["C1 32 行全部填好"], retries: 5, ...overrides,
  });
  await writeFile(join(tasks, "a.md"), [
    "---", "schema: taskctl/v1", `title: ${task.title}`, "status: open",
    `acceptance: ${JSON.stringify(task.acceptance)}`,
    "criteria:", ...task.criteria.map((line) => `  - ${line}`),
    `retries: ${task.retries}`,
    "sessions: []", "review_rounds: 0", "---", "把 32 行填进共享表", "",
  ].join("\n"), "utf8");
}

/** A turn that reports completion; the worker then runs acceptance. */
function adapter(): AgentAdapter {
  return {
    prompt: async () => {
      await mkdir(join(tasks, "a"), { recursive: true });
      await writeFile(join(tasks, "a", "done.requested"), "done");
      return { sessionId: "s", text: "done", exitCode: 0 };
    },
    contextUsage: async () => 0,
    contextLimit: async () => 100,
  };
}

const pass = async () => ({ passed: true, skipped: false as const, exitCode: 0, output: "32 行已写入" });
const passingReview = async (): Promise<ReviewResult> => ({
  verdict: "pass", criteria: [{ id: "C1", pass: true, evidence: "32 行都在" }],
  externalChanges: [], defects: [], summary: "ok",
});

describe("definitionDigest covers intent, not lifecycle", () => {
  const base = () => parseTaskFile("---\ntitle: t\nstatus: open\ncriteria:\n  - C1 ok\nsessions: []\nretries: 0\n---\nbody", "001-a");

  it("does not change when an operator edits retries, status, sessions or review rounds mid-run", () => {
    const before = definitionDigest(base());
    for (const edit of [
      { retries: 0 },
      { status: "running" as const },
      { sessions: ["ses-1", "ses-2"] },
      { reviewRounds: 3 },
    ]) {
      expect(definitionDigest({ ...base(), ...edit })).toBe(before);
    }
  });

  it("changes when a definitional field changes", () => {
    const before = definitionDigest(base());
    for (const edit of [
      { acceptance: "npm test" },
      { criteria: ["C1 ok", "C2 also"] },
      { complexity: "simple" as const },
      { risk: "high" as const },
      { description: "different body" },
      { verify: "mechanical" as const },
      { renderTargets: ["index.html"] },
      { execution: "continuous" as const },
      { workerSelfCheck: "node scripts/generate.js" },
      { workerSelfCheckTimeoutMs: 1_200_000 },
    ]) {
      expect(definitionDigest({ ...base(), ...edit })).not.toBe(before);
    }
  });
});

describe("the claim-time snapshot is what evidence is judged against", () => {
  it("writes the definition beside attempt.json and accepts evidence after retries changed mid-run", async () => {
    await seed({ retries: 5 });
    const accepted = await runTask(config(), {
      store,
      adapter: adapter(),
      // The operator's legitimate move during the run: avoid burning the budget.
      acceptance: async () => {
        await store.updateFields("a", { retries: 0 });
        return pass();
      },
      review: passingReview,
    }, await store.get("a"), "w1");

    expect(accepted).toBe("done");
    const record = await readRuntime<{ definitionMatches?: boolean; definitionDigest?: string }>(tasks, "a", "acceptance.json");
    expect(record?.definitionMatches).toBe(true);
    // The snapshot, not a re-read of the live file, is the reference.
    const snapshot = await readDefinitionSnapshot(tasks, "a");
    expect(snapshot?.digest).toBe(record?.definitionDigest);
    expect(snapshot?.fields["criteria"]).toEqual(["C1 32 行全部填好"]);
  });

  it("still blocks when the criteria really were rewritten during acceptance", async () => {
    await seed();
    const outcome = await runTask(config(), {
      store,
      adapter: adapter(),
      acceptance: async () => {
        const file = join(tasks, "a.md");
        const current = await readFile(file, "utf8");
        await writeFile(file, current.replace("C1 32 行全部填好", "C1 大致填一下"), "utf8");
        return pass();
      },
      review: passingReview,
    }, await store.get("a"), "w1");

    expect(outcome).toBe("blocked");
    const record = await readRuntime<{ definitionMatches?: boolean }>(tasks, "a", "acceptance.json");
    expect(record?.definitionMatches).toBe(false);
  });

  it("compares against the snapshot even when the in-memory digest would disagree", async () => {
    await seed();
    await mkdir(join(tasks, "a"), { recursive: true });
    const task = await store.get("a");
    const snapshot = await writeDefinitionSnapshot(tasks, task);
    expect(snapshot.digest).toBe(definitionDigest(task));
    // A second claim over the same definition reuses the same digest: the file is
    // a record of intent, not a counter that advances per attempt.
    const again = await writeDefinitionSnapshot(tasks, task);
    expect(again.digest).toBe(snapshot.digest);
    expect((await readDefinitionSnapshot(tasks, "a"))?.digest).toBe(snapshot.digest);
  });
});
