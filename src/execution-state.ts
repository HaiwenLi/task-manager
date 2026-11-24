import type { TaskExecution } from "./task-file.js";
import { readRuntime, writeRuntime } from "./runtime.js";

const EXECUTION_STATE_FILE = "execution-state.json";
const MAX_REASONS = 50;
const MAX_REASON_LENGTH = 500;

export type WorkerSessionFact = { sessionId: string; model?: string };

export type ExecutionState = {
  requiresReview: boolean;
  effectiveExecution: TaskExecution;
  reasons: string[];
  latestWorker?: WorkerSessionFact;
  updatedAt: string;
  /** Present when state had to be ignored conservatively. */
  diagnostic?: string;
};

/**
 * Read runtime execution facts. Missing state inherits the declared task policy;
 * malformed state always escalates and disables session reuse.
 */
export async function readExecutionState(
  tasksDir: string,
  id: string,
  fallbackExecution: TaskExecution = "iterative",
): Promise<ExecutionState> {
  const fallback: ExecutionState = {
    requiresReview: false,
    effectiveExecution: fallbackExecution,
    reasons: [],
    updatedAt: "",
  };
  let value: unknown;
  try {
    value = await readRuntime<unknown>(tasksDir, id, EXECUTION_STATE_FILE);
  } catch {
    return conservative("unreadable execution state; review required and session reuse disabled");
  }
  if (value === null) return fallback;
  if (!validState(value)) {
    return conservative("invalid execution state; review required and session reuse disabled");
  }
  const requiresReview = value.requiresReview;
  const effectiveExecution: TaskExecution = requiresReview || fallbackExecution === "iterative" || value.effectiveExecution === "iterative"
    ? "iterative"
    : "continuous";
  return {
    requiresReview,
    effectiveExecution,
    reasons: [...value.reasons],
    ...(value.latestWorker === undefined ? {} : { latestWorker: { ...value.latestWorker } }),
    updatedAt: value.updatedAt,
  };
}

/** Record an upward-only transition. Caller holds the task mutation/ownership lock. */
export async function recordEscalation(
  tasksDir: string, id: string, reason: string, fallbackExecution: TaskExecution = "iterative",
): Promise<ExecutionState> {
  const current = await readExecutionState(tasksDir, id, fallbackExecution);
  const next: ExecutionState = {
    requiresReview: true,
    effectiveExecution: "iterative",
    reasons: [...current.reasons, reason.trim().slice(0, MAX_REASON_LENGTH)].slice(-MAX_REASONS),
    ...(current.latestWorker === undefined ? {} : { latestWorker: current.latestWorker }),
    updatedAt: new Date().toISOString(),
  };
  await writeRuntime(tasksDir, id, EXECUTION_STATE_FILE, next);
  return next;
}

/** Record the latest cleanly observed worker session. Caller holds the task lock. */
export async function recordWorkerSession(
  tasksDir: string, id: string, worker: WorkerSessionFact, fallbackExecution: TaskExecution = "iterative",
): Promise<ExecutionState> {
  const current = await readExecutionState(tasksDir, id, fallbackExecution);
  const next: ExecutionState = {
    requiresReview: current.requiresReview,
    effectiveExecution: current.effectiveExecution,
    reasons: current.reasons,
    latestWorker: { ...worker },
    updatedAt: new Date().toISOString(),
  };
  await writeRuntime(tasksDir, id, EXECUTION_STATE_FILE, next);
  return next;
}

function conservative(diagnostic: string): ExecutionState {
  return { requiresReview: true, effectiveExecution: "iterative", reasons: [], updatedAt: "", diagnostic };
}

function validState(value: unknown): value is ExecutionState {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.requiresReview !== "boolean") return false;
  if (record.effectiveExecution !== "continuous" && record.effectiveExecution !== "iterative") return false;
  if (!Array.isArray(record.reasons) || record.reasons.some((reason) => typeof reason !== "string")) return false;
  if (typeof record.updatedAt !== "string") return false;
  if (record.latestWorker !== undefined) {
    if (typeof record.latestWorker !== "object" || record.latestWorker === null) return false;
    const worker = record.latestWorker as Record<string, unknown>;
    if (typeof worker.sessionId !== "string" || worker.sessionId.length === 0) return false;
    if (worker.model !== undefined && typeof worker.model !== "string") return false;
  }
  return true;
}
