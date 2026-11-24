import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentAdapter } from "../../src/adapters/types.js";
import type { AcceptanceResult } from "../../src/acceptance.js";
import { runCli, type CliDeps } from "../../src/cli.js";
import { serializeTaskFile, type Task } from "../../src/task-file.js";
import { controlDir } from "../../src/watch-lock.js";
import { stopRequestPath, type WatchFs, type WatchOptions } from "../../src/watch.js";
import type { WorkerConfig, WorkerDeps } from "../../src/worker.js";

/** The shared fake worker turn: same protocol, done marker, result shape and context stubs. */
export type DoneAdapterOptions = {
  tasksDir: string;
  /** Session identity is intentionally suite-specific (reuse vs fresh). */
  sessionId: (id: string, args: Parameters<AgentAdapter["prompt"]>[0]) => string;
  /** Suite-specific observation/hooks before the shared successful result resolves. */
  beforeResult?: (args: Parameters<AgentAdapter["prompt"]>[0], id: string) => Promise<void>;
  canResumeSession?: NonNullable<AgentAdapter["canResumeSession"]>;
  sessionUsage?: NonNullable<AgentAdapter["sessionUsage"]>;
};

export function doneAdapter({
  tasksDir, sessionId, beforeResult, canResumeSession, sessionUsage,
}: DoneAdapterOptions): AgentAdapter {
  return {
    ...(canResumeSession === undefined ? {} : { canResumeSession }),
    prompt: async (args) => {
      const id = await markDoneTask(args.text, tasksDir);
      await beforeResult?.(args, id);
      return { sessionId: sessionId(id, args), exitCode: 0, text: "done" };
    },
    ...(sessionUsage === undefined ? {} : { sessionUsage }),
    contextUsage: async () => 0,
    contextLimit: async () => 100,
  };
}

/** The WorkerConfig shape shared by batch/watch tests; timing remains explicit. */
export function workerConfigFixture({
  tasksDir, workdir, lockTtlMs = 20_000, heartbeatMs = 1_000,
}: { tasksDir: string; workdir: string; lockTtlMs?: number; heartbeatMs?: number }): WorkerConfig {
  return {
    tasksDir,
    workdir,
    agent: "fixture",
    model: "w/one",
    contextThreshold: 0.8,
    retryLimit: 1,
    lockTtlMs,
    heartbeatMs,
  };
}

/** The taskctl.json shape shared by real-CLI batch/watch tests. */
export async function writeBatchConfig(
  root: string,
  { tasksDir, workdir, lockTtlMs = 20_000, heartbeatMs = 1_000, batchMaxTasks }: {
    tasksDir: string; workdir: string; lockTtlMs?: number; heartbeatMs?: number; batchMaxTasks?: number;
  },
): Promise<string> {
  const configPath = join(root, "taskctl.json");
  await writeFile(configPath, JSON.stringify({
    tasksDir,
    workdir,
    model: "w/one",
    lockTtlMs,
    heartbeatMs,
    ...(batchMaxTasks === undefined ? {} : { batchMaxTasks }),
  }), "utf8");
  return configPath;
}

/** Seed task definition files the way every board-using suite does. */
export async function seedTaskFile(tasksDir: string, ...definitions: Task[]): Promise<void> {
  for (const definition of definitions) {
    await writeFile(join(tasksDir, `${definition.id}.md`), serializeTaskFile(definition), "utf8");
  }
}

/** Deterministic filesystem-event seam shared by the watch suites. */
export function createWatchEventSeam(): { listeners: Map<string, () => void>; watchFs: WatchFs } {
  const listeners = new Map<string, () => void>();
  const watchFs: WatchFs = (path, listener) => {
    listeners.set(path, listener);
    return { close: () => { listeners.delete(path); } };
  };
  return { listeners, watchFs };
}

/** The worker protocol's one terminal marker; suites need only the task id. */
export function doneTaskId(promptText: string): string {
  return /taskctl done --task (\S+) --tasks-dir/.exec(promptText)![1]!;
}

/** Write the same done marker every fake worker turn is expected to produce. */
export async function markDoneTask(promptText: string, tasksDir: string): Promise<string> {
  const id = doneTaskId(promptText);
  await mkdir(join(tasksDir, id), { recursive: true });
  await writeFile(join(tasksDir, id, "done.requested"), "done");
  return id;
}

export async function waitForCondition(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("condition did not become true before timeout");
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
}

export async function waitForConditionAsync(check: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error("async condition did not become true before timeout");
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
}

/** Durable stop request plus the deterministic control-directory wakeup. */
export async function requestStopThroughFile(tasksDir: string, wakeControl?: () => void): Promise<void> {
  await mkdir(controlDir(tasksDir), { recursive: true });
  await writeFile(stopRequestPath(tasksDir), new Date().toISOString(), "utf8");
  wakeControl?.();
}

/** The real stop CLI, plus the deterministic wakeup the fake event seam needs. */
export async function requestStopThroughCli(tasksDir: string, wakeControl?: () => void): Promise<void> {
  const code = await runCli(["stop", "--tasks-dir", tasksDir], { log: () => {}, err: () => {} });
  if (code !== 0) throw new Error(`stop CLI exited ${code}`);
  wakeControl?.();
}

/** Both durable stop flavors, pre-bound to the seam's control-directory wakeup. */
export function createStopRequests(tasksDir: string, listeners: Map<string, () => void>): {
  request: () => Promise<void>;
  throughCli: () => Promise<void>;
} {
  const wakeControl = () => listeners.get(controlDir(tasksDir))?.();
  return {
    request: () => requestStopThroughFile(tasksDir, wakeControl),
    throughCli: () => requestStopThroughCli(tasksDir, wakeControl),
  };
}

export type WatchCliFixture = {
  root: string;
  tasksDir: string;
  workdir: string;
  agent: AgentAdapter;
  acceptance: NonNullable<CliDeps["acceptance"]>;
  watch: WatchOptions;
  review?: WorkerDeps["review"];
  store?: CliDeps["store"];
  log?: (line: string) => void;
  err?: (line: string) => void;
};

/** Run `watch --config` with the fixture config every CLI watch test uses. */
export async function runWatchCli({
  root, tasksDir, workdir, agent, acceptance, watch, review, store, log, err,
}: WatchCliFixture): Promise<number> {
  const configPath = await writeBatchConfig(root, {
    tasksDir, workdir, lockTtlMs: 5_000, heartbeatMs: 20,
  });
  return runCli(["watch", "--config", configPath], {
    adapter: agent,
    acceptance,
    ...(review === undefined ? {} : { review }),
    log: log ?? (() => {}),
    err: err ?? (() => {}),
    ...(store === undefined ? {} : { store }),
    watch,
  });
}

export const passAcceptance = async (): Promise<AcceptanceResult> =>
  ({ passed: true, skipped: false as const, exitCode: 0, output: "ok" });
