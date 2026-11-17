import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter } from "../src/adapters/types.js";
import type { AcceptanceResult } from "../src/acceptance.js";
import { failureFingerprint, normalizeFailureOutput } from "../src/fingerprint.js";
import { latestNote } from "../src/handoff.js";
import type { ReviewResult } from "../src/review.js";
import { readRuntime } from "../src/runtime.js";
import { TaskStore } from "../src/task-store.js";
import { runTask, type WorkerConfig } from "../src/worker.js";

let root: string;
let tasks: string;
let cwd: string;
let store: TaskStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "taskctl-fingerprint-"));
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
    retryLimit: 5, lockTtlMs: 5_000, heartbeatMs: 50, ...overrides,
  };
}

async function seed(): Promise<void> {
  await writeFile(join(tasks, "a.md"), [
    "---", "schema: taskctl/v1", "title: bio gate", "status: open",
    'acceptance: "check"', "criteria:", "  - C1 bio 相似度 >= 0.90",
    "sessions: []", "retries: 0", "review_rounds: 0", "---", "重建 bio 图并与基线比相似度", "",
  ].join("\n"), "utf8");
}

/** A turn that claims completion; acceptance then decides. */
function adapter(): AgentAdapter {
  return {
    prompt: async () => {
      await mkdir(join(tasks, "a"), { recursive: true });
      await writeFile(join(tasks, "a", "done.requested"), "done");
      return { sessionId: `ses-${Math.random()}`, text: "done", exitCode: 0 };
    },
    contextUsage: async () => 0,
    contextLimit: async () => 100,
  };
}

const failing = (output: string) => async (): Promise<AcceptanceResult> => ({ passed: false, exitCode: 1, output, skipped: false });
const passing = async (): Promise<AcceptanceResult> => ({ passed: true, exitCode: 0, output: "similarity 0.93", skipped: false });

const passingReview = async (): Promise<ReviewResult> => ({
  verdict: "pass", criteria: [{ id: "C1", pass: true, evidence: "ok" }],
  externalChanges: [], defects: [], summary: "ok",
});

async function run(deps: { acceptance: () => Promise<AcceptanceResult> }, overrides: Partial<WorkerConfig> = {}) {
  return runTask(config(overrides), { store, adapter: adapter(), ...deps, review: passingReview }, await store.get("a"), "w1");
}

/** What the harness prints: same failure, different clock, checkout and duration. */
const sameFailure = (attempt: number, root: string): string => [
  `[2026-11-17T0${attempt}:12:${String(10 + attempt).padStart(2, "0")}.489Z] bio-check starting`,
  `$ ${root}\\tests\\run_bio.m`,
  "FAIL bio similarity 0.41 below the 0.90 gate",
  `elapsed ${1000 * attempt + 732} ms`,
].join("\n");

const checkout = (n: number): string => `D:\\checkouts\\checkout-${n}`;

describe("normalized failure fingerprints", () => {
  it("treats the same failure at another time, checkout and duration as one failure", () => {
    const first = failureFingerprint(sameFailure(1, checkout(1)), { roots: [checkout(1)] });
    const second = failureFingerprint(sameFailure(4, checkout(4)), { roots: [checkout(4)] });
    expect(second).toBe(first);
    // The failure's own facts survive normalization: what was compared, and what
    // it measured. Only the clock, the location and the elapsed time are noise.
    const normalized = normalizeFailureOutput(sameFailure(2, checkout(1)), { roots: [checkout(1)] });
    expect(normalized).toContain("bio similarity 0.41 below the 0.90 gate");
    expect(normalized).not.toContain("2026-11-17");
    expect(normalized).not.toContain("2732");
  });

  it("treats absolute paths from different machines as the same location", () => {
    expect(failureFingerprint("C:\\a\\out\\bio.tif missing")).toBe(failureFingerprint("D:\\b\\out\\bio.tif missing"));
  });

  it("keeps genuinely different failures apart", () => {
    const a = failureFingerprint("FAIL bio similarity 0.41 below the 0.90 gate");
    const b = failureFingerprint("FAIL bio similarity 0.62 below the 0.90 gate");
    expect(a).not.toBe(b);
  });
});

describe("acceptance fingerprint circuit breaker", () => {
  it("stops after the same failure repeats to the threshold and hands it to a human", async () => {
    await seed();
    let calls = 0;
    const outcome = await run({ acceptance: async () => { calls += 1; return failing(sameFailure(calls))(); } });

    expect(outcome).toBe("blocked");
    expect(calls).toBe(3);
    expect((await store.get("a")).status).toBe("blocked");
    // Each failure still counted as a failure: the breaker decides when to stop,
    // it does not rewrite the accounting.
    expect((await store.get("a")).retries).toBe(3);
    const note = await latestNote(tasks, "a");
    expect(note?.markdown).toContain("blocked:needs-owner");
    expect(note?.markdown).toContain("连续 3 次");
    const counter = await readRuntime<{ count?: number }>(tasks, "a", "acceptance-failures.json");
    expect(counter?.count).toBe(3);
  });

  it("does not accumulate failures that differ, so real progress keeps retrying", async () => {
    await seed();
    let calls = 0;
    const outcome = await run({
      acceptance: async () => {
        calls += 1;
        return failing(`FAIL bio similarity 0.4${calls} below the 0.90 gate`)();
      },
    }, { retryLimit: 2 });

    // Blocked by the ordinary retry budget, not by the breaker.
    expect(outcome).toBe("blocked");
    expect(calls).toBe(2);
    expect((await store.get("a")).retries).toBe(2);
  });

  it("clears the streak when an acceptance passes", async () => {
    await seed();
    let calls = 0;
    const outcome = await run({
      acceptance: async () => {
        calls += 1;
        return calls === 1 ? failing(sameFailure(1))() : passing();
      },
    });
    expect(outcome).toBe("done");
    expect(await readRuntime(tasks, "a", "acceptance-failures.json")).toBeNull();

    // A later attempt starts the streak from zero: the earlier failure is not
    // carried into a run whose gate has since succeeded.
    await store.updateFields("a", { status: "open" });
    let reopenedCalls = 0;
    const reopened = await run({
      acceptance: async () => { reopenedCalls += 1; return failing(sameFailure(9))(); },
    }, { failureFingerprintLimit: 2, retryLimit: 5 });
    expect(reopened).toBe("blocked");
    expect(reopenedCalls).toBe(2);
    expect((await readRuntime<{ count?: number }>(tasks, "a", "acceptance-failures.json"))?.count).toBe(2);
  });

  it("honours a configured threshold", async () => {
    await seed();
    let calls = 0;
    const outcome = await run({
      acceptance: async () => { calls += 1; return failing(sameFailure(calls))(); },
    }, { failureFingerprintLimit: 1 });
    expect(outcome).toBe("blocked");
    expect(calls).toBe(1);
  });
});
