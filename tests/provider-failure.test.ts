import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter } from "../src/adapters/types.js";
import { TaskStore } from "../src/task-store.js";
import { serializeTaskFile } from "../src/task-file.js";
import { runTask, type WorkerConfig, type WorkerEvent } from "../src/worker.js";
import { buildTaskFile } from "./helpers/task-fixture.js";

let root: string;
let tasksDir: string;
let workdir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "taskctl-provider-"));
  tasksDir = join(root, "tasks");
  workdir = join(root, "work");
  await mkdir(tasksDir, { recursive: true });
  await mkdir(workdir, { recursive: true });
  await writeFile(
    join(tasksDir, "t1.md"),
    serializeTaskFile(buildTaskFile({ id: "t1", title: "t1", status: "open", acceptance: "node -e \"process.exit(0)\"" })),
    "utf8",
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const cfg = (): WorkerConfig => ({
  tasksDir,
  workdir,
  agent: "opencode",
  contextThreshold: 0.8,
  retryLimit: 1,
  lockTtlMs: 60_000,
  heartbeatMs: 50,
});

/** A turn that exits non-zero and reports `state: "uncertain"`, like opencode. */
function failingAdapter(failure: "provider" | undefined): { adapter: AgentAdapter; calls: { turns: number; cancel: number } } {
  const calls = { turns: 0, cancel: 0 };
  const adapter: AgentAdapter = {
    async prompt(): Promise<never> {
      throw new Error("the worker must use start()");
    },
    start() {
      calls.turns += 1;
      return {
        result: Promise.resolve({
          sessionId: "ses-test",
          exitCode: 1,
          text: "",
          ...(failure === undefined ? {} : { failure }),
        }),
        inspect: () => ({ state: "uncertain" as const }),
        cancel: async () => {
          calls.cancel += 1;
          return false;
        },
      };
    },
    async contextUsage() {
      return 0;
    },
    async contextLimit() {
      return 100_000;
    },
  };
  return { adapter, calls };
}

async function run(adapter: AgentAdapter, events: WorkerEvent[]) {
  return runTask(cfg(), {
    store: new TaskStore(tasksDir),
    adapter,
    acceptance: async () => ({ passed: true, exitCode: 0, output: "", skipped: false }),
    onEvent: (event) => events.push(event),
  }, await new TaskStore(tasksDir).get("t1"), "worker-test");
}

describe("provider rejection", () => {
  it("ends a rejected turn as a deferral instead of calling it an uncertain interruption", async () => {
    const { adapter, calls } = failingAdapter("provider");
    const events: WorkerEvent[] = [];
    const outcome = await run(adapter, events);

    expect(outcome).toBe("open");
    expect((await new TaskStore(tasksDir).get("t1")).retries).toBe(0);
    expect(events.some((event) => event.type === "blocked")).toBe(false);
    expect(events.find((event) => event.type === "model-deferred")?.detail).toContain("retries untouched");
    expect(events.some((event) => /shutdown/.test(event.detail ?? ""))).toBe(false);
    expect(calls.cancel).toBe(0);
  });

  it("still treats a plain crashed turn as an uncertain interruption", async () => {
    const { adapter, calls } = failingAdapter(undefined);
    const events: WorkerEvent[] = [];
    const outcome = await run(adapter, events);

    expect(outcome).toBe("blocked");
    const blocked = events.find((event) => event.type === "blocked");
    expect(blocked?.detail).toContain("shutdown unconfirmed");
    expect(calls.cancel).toBeGreaterThan(0);
  });
});
