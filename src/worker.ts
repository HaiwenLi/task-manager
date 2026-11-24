import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { claim, heartbeat, lockLive, release, withOwnership, OwnershipLostError } from "./claim.js";
import { waitReason } from "./eligibility.js";
import { dependencySummary } from "./dependencies.js";
import { latestNote, writeNote, type HandoffNote } from "./handoff.js";
import { startAcceptance, type AcceptanceResult } from "./acceptance.js";
import { readContextSections, type ContextSections } from "./context.js";
import { buildWorkerPrompt } from "./protocol.js";
import type { TaskStore } from "./task-store.js";
import type { Task, TaskExecution } from "./task-file.js";
import type { AgentAdapter, PromptResult } from "./adapters/types.js";
import type { Execution } from "./execution.js";
import { reserveWorkspace, artifactDigest, type WorkspaceReservation } from "./workspace.js";
import {
  artifactsOrDefault, logDirOf, scratchDirOf, snapshotRoot, sweepRoot, taskDirOf,
  LOG_DIR_ENV, TASK_DIR_ENV, type ArtifactsConfig, type SweepOutcome,
} from "./artifacts.js";
import { definitionDigest, readAttempt, readDefinitionSnapshot, readRuntime, writeDefinitionSnapshot, writeRuntime, type AttemptRecord } from "./runtime.js";
import { readSpec } from "./spec.js";
import { appendJournal, journalTail } from "./journal.js";
import { chainPosition, configChain, modelChain, readModelRotation, resetChainCycles, rotateModel, type Handover, type ModelRole } from "./models.js";
import { classifyDispatchFailure, quotaBackoffMs } from "./dispatch.js";
import { failureFingerprint } from "./fingerprint.js";
import { startReview, type CriterionResult, type ReviewEvidence, type ReviewResult } from "./review.js";
import { collectChangeEvidence } from "./changes.js";
import { checkRender, describeFailures, RenderUnavailableError, type RenderCheck } from "./render.js";
import { readExecutionState, recordEscalation, recordWorkerSession, type ExecutionState, type WorkerSessionFact } from "./execution-state.js";
import { clearModelCooldown, modelCooldown, nextModelCooldown, noteModelRefusal } from "./model-cooldown.js";
import { recordUsage, type UsageRole } from "./usage.js";

export const TURN_TIMEOUT_MS_DEFAULT = 30 * 60_000;
export const ACCEPTANCE_TIMEOUT_MS_DEFAULT = 10 * 60_000;
export const MAX_SESSIONS_PER_TASK_DEFAULT = 20;
export const MAX_TURNS_PER_SESSION_DEFAULT = 40;
/**
 * How long a cancellation may take before the turn counts as "shutdown
 * unconfirmed". A real cancellation is bounded well inside it: the stop of
 * the backend session (4s cap) runs beside the process-tree kill (1.5s cap),
 * then the exit confirmation (0.5s cap).
 */
export const CANCEL_DEADLINE_MS = 8_000;
export const MAX_REVIEW_ROUNDS_DEFAULT = 2;
/** Consecutive identical acceptance failures before the task waits for a human. */
export const FAILURE_FINGERPRINT_LIMIT_DEFAULT = 3;
export const WRAP_UP_INSTRUCTION = "上下文预算告急。请立即运行一次 taskctl note（详尽记录进展），然后只回复 HANDOFF_READY";

/**
 * A worker may append `ESCALATE: <reason>` to a turn to say the work is bigger
 * than the task it was given. See {@link escalate}: it can only raise the bar.
 */
const ESCALATE_MARKER = /(?:^|\n)\s*ESCALATE:\s*(.+)/;

export type WorkerConfig = {
  tasksDir: string; workdir: string; agent: string; model?: string; effort?: string;
  contextThreshold: number; retryLimit: number; lockTtlMs: number; heartbeatMs: number;
  turnTimeoutMs?: number; acceptanceTimeoutMs?: number;
  maxSessionsPerTask?: number; maxTurnsPerSession?: number;
  /** Failed review rounds allowed before a task blocks. */
  maxReviewRounds?: number;
  /** Optional separate model/effort for the reviewer session. */
  reviewerModel?: string; reviewerEffort?: string;
  /** Models to try, in order, when a provider rejects the worker's model. */
  modelFallbacks?: string[];
  /** Models to try, in order, when a provider rejects the reviewer's model. */
  reviewerModelFallbacks?: string[];
  /**
   * Workspace-relative paths or globs excluded from the acceptance drift
   * digest — the paths a task's own acceptance command is expected to write.
   */
  artifactIgnore?: string[];
  /**
   * The whole dispatch chain when set: head first, alternatives after. Defaults
   * to `[model]`, so a config without it keeps meaning what it always did.
   */
  modelChain?: string[];
  /**
   * Identical acceptance failures tolerated in a row before the task stops for a
   * human (default 3). See {@link recordAcceptanceFailure}.
   */
  failureFingerprintLimit?: number;
  /** Backoff schedule after a quota refusal, by step; the last entry repeats. */
  quotaBackoffMs?: number[];
  /**
   * How many times the model chain may wrap back to its head once the tail is
   * reached (default 0 = a linear chain, spent at the tail). A wrap re-probes
   * models that refused earlier — quota windows reset while the chain walks —
   * so a task parks for a human only when the whole cycle is out of allowance.
   */
  chainCycles?: number;
  /** Shared re-probe window for a provider/model refusal (default 15 minutes). */
  modelCooldownMs?: number;
  /** How many tasks the scheduler may run at once (default 2). */
  parallel?: number;
  /** Maximum automatic watch batch size (default 5); 1 disables grouping. */
  batchMaxTasks?: number;
  /** Viewports a `verify: render` task must pass (default 1440x900 and 390x844). */
  renderViewports?: string[];
  /** Browser binary for render checks; auto-detected when absent. */
  chromeBin?: string;
  /**
   * Artifact hygiene: post-turn sweep of the workspace root. Absent means the
   * defaults (sweep on, `DEFAULT_SCRATCH_PATTERNS`); resolved from the
   * `artifacts` block of `taskctl.json`.
   */
  artifacts?: ArtifactsConfig;
  /**
   * Which context a worker session is given beside the task: the approved
   * spec, and the owner's preferences with the relevant corrections. Absent
   * means both. Resolved from the `workerContext` block of `taskctl.json`.
   */
  workerContext?: { spec: boolean; preferences: boolean };
};
export type WorkerStore = Pick<TaskStore, "list" | "setStatus" | "appendSession" | "incRetries" | "readDoneMarker" | "clearDoneMarker" | "incReviewRounds">;
export type WorkerDeps = {
  store: WorkerStore; adapter: AgentAdapter;
  acceptance?: (command: string, cwd: string) => Promise<AcceptanceResult>;
  /** Test seam: judge the evidence without starting an agent session. */
  review?: (evidence: ReviewEvidence) => Promise<ReviewResult>;
  onEvent?: (evt: WorkerEvent) => void;
};
export type WorkerEventType = "claimed" | "takeover" | "running" | "handoff" | "turn-failed" | "model-fallback" | "acceptance" | "acceptance-skipped" | "reviewing" | "reviewed" | "rework" | "awaiting-human" | "done" | "blocked" | "ownership-lost" | "escalated" | "controller-error";
export type WorkerEvent = { type: WorkerEventType; taskId: string; detail?: string };
export type TaskOutcome = "done" | "blocked" | "skipped" | "open" | "awaiting-human";
export type RunTaskOptions = {
  reviewOnly?: boolean;
  /** Batch-only input; ordinary runs keep the task-local restore behavior. */
  batch?: {
    preamble: string;
    resumeFrom?: WorkerSessionFact;
  };
};
type ReviewPendingRecord = {
  definitionDigest: string;
  artifactDigest: string;
  createdAt: string;
  updatedAt: string;
  refusals: Array<{ model: string; reason: string }>;
  /**
   * When the attempt that produced the preserved evidence ran. A review-only
   * recovery is another, later attempt; the reviewer must still judge the work
   * against the window it happened in, so the first park records it and every
   * later park keeps it.
   */
  window?: { startedAt: string; finishedAt: string };
};
export class WorkerTimeoutError extends Error {
  constructor(message: string, readonly partialOutput?: string) { super(message); }
}
class UncertainExecutionError extends Error {}
class ReviewRequiredError extends Error {}
class ModelsCoolingError extends Error {
  constructor(readonly retryAfter: string) { super(`every model is cooling until at least ${retryAfter}`); }
}

type Run = {
  cfg: WorkerConfig; deps: WorkerDeps; task: Task; owner: string;
  /** Digest of the definition snapshot persisted at claim; the attempt's bar. */
  definition: string;
  record: AttemptRecord; lost: boolean; notifyLost: () => void; loss: Promise<void>;
  execution?: Execution<unknown>;
  /**
   * Set once the work outgrows the lane it was captured in. It never turns back
   * off for this attempt: an escalated run may not finish on its own evidence.
   */
  escalated: boolean;
  /** Durable execution policy and same-model session facts for this task. */
  executionState?: ExecutionState;
  reviewOnly: boolean;
  batch: RunTaskOptions["batch"];
  /** The attempt replaced by this claim had already settled cleanly. */
  previousSettled: boolean;
  /**
   * The inert-sweep reason (e.g. non-Git workdir) is journaled once per
   * attempt, not once per turn — every turn would only repeat the same line.
   */
  sweepSkipNoted: boolean;
  /** Why each model on the dispatch chain refused this attempt, in order. */
  dispatchFailures: Map<string, string>;
  /** What each dependency produced; computed once per attempt (see `dependenciesOf`). */
  dependencies?: string | null;
  /** The context sections this attempt was given; read once per attempt (see `contextOf`). */
  context?: WorkerContext;
  /** The context budget was already reported as unreadable for this attempt. */
  budgetUnavailableNoted: boolean;
  /** The lock heartbeat's first write failure was already journaled for this attempt. */
  heartbeatWriteFailureNoted: boolean;
};
const emit = (r: Run, type: WorkerEventType, detail?: string) => r.deps.onEvent?.({ type, taskId: r.task.id, detail });
const owned = <T>(r: Run, fn: () => Promise<T>) => withOwnership(r.cfg.tasksDir, r.task.id, r.owner, fn);
const declaredExecution = (task: Task): TaskExecution => task.execution ?? (task.complexity === "simple" ? "continuous" : "iterative");
const effectiveExecution = (r: Run): TaskExecution => r.executionState?.effectiveExecution ?? declaredExecution(r.task);

export async function runWorker(cfg: WorkerConfig, deps: WorkerDeps): Promise<{ done: string[]; blocked: string[] }> {
  const result = { done: [] as string[], blocked: [] as string[] };
  for (const task of await deps.store.list()) {
    if (task.status !== "open" && task.status !== "running") continue;
    if (task.status === "running" && await lockLive(cfg.tasksDir, task.id, cfg.lockTtlMs)) continue;
    const outcome = await runTask(cfg, deps, task, `worker-${process.pid}-${randomUUID()}`);
    if (outcome === "done") result.done.push(task.id);
    if (outcome === "blocked") result.blocked.push(task.id);
  }
  return result;
}

export async function runTask(
  cfg: WorkerConfig, deps: WorkerDeps, task: Task, workerId: string, options: RunTaskOptions = {},
): Promise<TaskOutcome> {
  // Even callers reusing a worker label get a distinct fencing generation.
  const owner = `${workerId}:${randomUUID()}`;
  if (!await claim(cfg.tasksDir, task.id, owner, cfg.lockTtlMs)) return "skipped";
  let notifyLost!: () => void;
  const loss = new Promise<void>(resolve => { notifyLost = resolve; });
  const now = new Date().toISOString();
  const r: Run = { cfg, deps, task, owner, definition: definitionDigest(task), lost: false, notifyLost, loss, escalated: false, reviewOnly: options.reviewOnly === true, batch: options.batch, previousSettled: false, sweepSkipNoted: false, budgetUnavailableNoted: false, heartbeatWriteFailureNoted: false,
    dispatchFailures: new Map(),
    record: { attemptId: owner, backend: cfg.agent, workspace: cfg.workdir, startedAt: now, updatedAt: now, phase: "active", operation: "preparing", turnTimeoutMs: cfg.turnTimeoutMs ?? TURN_TIMEOUT_MS_DEFAULT } };
  let reservation: WorkspaceReservation | null = null;
  let reviewPending: ReviewPendingRecord | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let renewal: Promise<void> | undefined;
  let stopping = false;
  const tick = () => {
    timer = setTimeout(() => {
      renewal = (async () => {
        try {
          if (!await heartbeat(cfg.tasksDir, task.id, owner)) throw new OwnershipLostError();
          const active = r.execution;
          if (active) await owned(r, async () => {
            if (r.execution !== active) return;
            const info = active.inspect();
            r.record.pid = info.pid;
            if (info.sessionId !== undefined) r.record.sessionId = info.sessionId;
            await writeRuntime(cfg.tasksDir, task.id, "attempt.json", r.record);
          });
        }
        catch (err) {
          // Only a lock that is no longer ours ends the attempt; anything else
          // here is a write that did not land (see noteHeartbeatWriteFailure).
          if (err instanceof OwnershipLostError) {
            r.lost = true; notifyLost();
          } else {
            await noteHeartbeatWriteFailure(r, err);
          }
        }
        if (!stopping && !r.lost) tick();
      })();
    }, Math.max(1, Math.min(cfg.heartbeatMs, cfg.lockTtlMs / 3)));
  };
  try {
    // Re-read after claim: a queued snapshot is not authority to reopen a terminal task.
    const board = await owned(r, async () => deps.store.list());
    const current = board.find(t => t.id === task.id);
    if (!current || (r.reviewOnly
      ? current.status !== "blocked"
      : current.status !== "open" && current.status !== "running")) return "skipped";
    // The scheduler already filtered on this, but against a snapshot taken
    // earlier. Asked again here, of the board as it is now, so no caller can
    // claim a split child before its bundle is approved, nor a task before its
    // dependencies are done.
    if (!r.reviewOnly && current.status === "open" && waitReason(current, board) !== null) return "skipped";
    r.task = structuredClone(current); r.definition = definitionDigest(current);
    r.executionState = await readExecutionState(cfg.tasksDir, task.id, declaredExecution(current));
    r.escalated = r.executionState.requiresReview;
    if (r.executionState.diagnostic) {
      await owned(r, () => appendJournal(cfg.tasksDir, task.id, {
        stage: "worker", event: "execution-state-invalid", detail: r.executionState!.diagnostic!,
      }));
    }
    const previous = await readAttempt(cfg.tasksDir, task.id);
    r.previousSettled = previous?.phase === "settled";
    if (r.reviewOnly) {
      if (!previous || previous.phase !== "settled") {
        return await block(r, "review-only recovery requires a settled previous attempt");
      }
      reviewPending = await readRuntime<ReviewPendingRecord>(cfg.tasksDir, task.id, "review-pending.json");
      if (!reviewPending || typeof reviewPending.definitionDigest !== "string" || typeof reviewPending.artifactDigest !== "string") {
        return await block(r, "review-only recovery requires a valid review-pending record");
      }
    } else if ((previous && previous.phase !== "settled") || (!previous && current.status === "running")) {
      return await block(r, "interrupted execution requires operator reconciliation; not replayed");
    }
    reservation = await reserveWorkspace(cfg.workdir, owner);
    if (!reservation) return await block(r, "workspace reserved by another or uncertain execution; reconcile before retry");
    r.record.workspace = reservation.cwd;
    r.cfg = { ...cfg, workdir: reservation.cwd };
    emit(r, task.status === "running" ? "takeover" : "claimed");
    await owned(r, async () => {
      await writeRuntime(cfg.tasksDir, task.id, "attempt.json", r.record);
      // The definition this attempt is judged by is written down here, beside the
      // attempt record: a later check — acceptance, review, or a takeover after a
      // crash — compares against what the work actually ran by, not against
      // whatever the file says when the evidence is looked at.
      r.definition = (await writeDefinitionSnapshot(cfg.tasksDir, r.task)).digest;
      await deps.store.clearDoneMarker(task.id); // do not consume a predecessor's completion request
      await deps.store.setStatus(task.id, "running");
      await appendJournal(cfg.tasksDir, task.id, { stage: "worker", event: "claimed", detail: reservation?.cwd ?? cfg.workdir });
    });
    tick(); emit(r, "running");
    const outcome = r.reviewOnly ? await resumeReviewOnly(r, reviewPending!) : await loop(r);
    // The entire run stays active between operations, including telemetry/handoffs.
    await checkpoint(r, "settled", "finished");
    return outcome;
  } catch (err) {
    if (err instanceof OwnershipLostError || r.lost) {
      emit(r, "ownership-lost", "ownership generation changed; execution reconciles before replay");
      return "skipped";
    }
    if (err instanceof UncertainExecutionError) {
      await checkpoint(r, "uncertain", r.record.operation, err.message);
      return await block(r, err.message);
    }
    if (err instanceof ReviewRequiredError) {
      await checkpoint(r, "settled", "review-required", err.message);
      return await block(r, err.message);
    }
    // `controlled` clears the in-flight execution before anything reaches here,
    // and an unconfirmed shutdown arrives as UncertainExecutionError above. So
    // an unexpected error leaves no operation running: nothing is uncertain,
    // the workspace is free, and one task's controller bug must neither abort
    // the other tasks nor park the board behind a reservation nobody holds.
    const message = err instanceof Error ? err.message : String(err);
    try {
      await checkpoint(r, "settled", "controller-error", message).catch(() => {});
      await owned(r, () => appendJournal(cfg.tasksDir, task.id, { stage: "worker", event: "controller-error", detail: message }))
        .catch(() => {});
      emit(r, "controller-error", message);
      return await block(r, `unexpected controller error: ${message}`);
    } catch {
      throw err;
    }
  } finally {
    stopping = true; if (timer) clearTimeout(timer); await renewal;
    if (reservation && r.record.phase === "settled") await reservation.release();
    // An uncertain reservation/record survives even though the task lock is released.
    await release(cfg.tasksDir, task.id, owner);
  }
}

async function checkpoint(r: Run, phase: AttemptRecord["phase"], operation: string, reason?: string): Promise<void> {
  await owned(r, async () => {
    const next = { ...r.record, phase, operation, reason, updatedAt: new Date().toISOString() };
    await writeRuntime(r.cfg.tasksDir, r.task.id, "attempt.json", next);
    r.record = next;
  });
}
async function block(r: Run, reason: string): Promise<"blocked"> {
  await owned(r, () => r.deps.store.setStatus(r.task.id, "blocked"));
  emit(r, "blocked", reason); return "blocked";
}
async function fail(r: Run): Promise<boolean> {
  return owned(r, async () => {
    const retries = await r.deps.store.incRetries(r.task.id);
    if (retries < r.cfg.retryLimit) return false;
    await r.deps.store.setStatus(r.task.id, "blocked");
    emit(r, "blocked", "retry limit reached"); return true;
  });
}

/**
 * Record that the work outgrew the lane it was captured in.
 *
 * Nothing in the task file changes: `verify` is still what the operator chose and
 * the definition digest is untouched. What changes is the bar for finishing this
 * attempt — from here it has to survive the reviewer, whatever evidence the task
 * normally accepts. Escalation only ever moves up, and only once per attempt, so
 * a worker cannot use it as a lever to shorten its own run.
 */
async function escalate(r: Run, reason: string): Promise<void> {
  if (r.escalated) return;
  r.escalated = true;
  await owned(r, async () => {
    r.executionState = await recordEscalation(r.cfg.tasksDir, r.task.id, reason, declaredExecution(r.task));
    await appendJournal(r.cfg.tasksDir, r.task.id, { stage: "worker", event: "escalated", detail: reason });
  });
  emit(r, "escalated", reason);
}

/** A cooperative legacy adapter can complete normally, but cannot prove cancellation. */
function legacyExecution<T>(fn: () => Promise<T>): Execution<T> {
  let state: "running" | "exited" = "running";
  const result = Promise.resolve().then(fn).finally(() => { state = "exited"; });
  return { result, inspect: () => ({ state }), cancel: async () => false };
}

/**
 * Record, once per attempt, that the lock heartbeat could not be written. That
 * is not a lost lock: `heartbeat` answers the ownership question with `false`
 * before it writes anything, and every guarded write checks ownership again for
 * itself. Reading a refused write as a lost lock cancelled the running turn
 * over a file-system hiccup and left the attempt active above a reservation it
 * no longer used.
 */
async function noteHeartbeatWriteFailure(r: Run, err: unknown): Promise<void> {
  if (r.heartbeatWriteFailureNoted) return;
  r.heartbeatWriteFailureNoted = true;
  const detail = err instanceof Error ? err.message : String(err);
  await appendJournal(r.cfg.tasksDir, r.task.id, {
    stage: "worker", event: "heartbeat-write-failed",
    detail: `${detail}; the lock is still held, the next heartbeat retries`,
  }).catch(() => {});
}

/**
 * Run one controlled turn. `acceptSettled` marks results that are themselves a
 * complete, retryable outcome (a provider rejection): those need no
 * cancellation proof, because the backend refused the turn before doing work.
 */
async function controlled<T>(
  r: Run,
  label: string,
  ms: number,
  start: () => Execution<T>,
  acceptSettled?: (value: T) => boolean,
): Promise<T> {
  // `false` is the lock no longer being ours. A throw is the write that follows
  // a successful check: it says nothing about ownership, and the guarded
  // dispatch below checks that again for itself.
  const fresh = await heartbeat(r.cfg.tasksDir, r.task.id, r.owner).catch(async (err: unknown) => {
    await noteHeartbeatWriteFailure(r, err);
    return true;
  });
  if (!fresh) throw new OwnershipLostError();
  await checkpoint(r, "active", label);
  let execution: Execution<T> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Declared out here: the catch block reads it, and a `let` inside `try` is
  // not visible there.
  let settledOutput: string | undefined;
  try {
    // Generation cannot be taken over between the ownership check and dispatch.
    await owned(r, async () => {
      execution = start();
      r.execution = execution;
      execution.result.catch(() => {});
      r.record.pid = execution.inspect().pid;
      const observedSessionId = execution.inspect().sessionId;
      if (observedSessionId !== undefined) r.record.sessionId = observedSessionId;
      await writeRuntime(r.cfg.tasksDir, r.task.id, "attempt.json", r.record);
    });
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new WorkerTimeoutError(`${label} timed out after ${ms}ms`)), ms);
    });
    const lost = r.loss.then(() => { throw new OwnershipLostError(); });
    let settled = false;
    const tracked = execution!.result.then(
      (value) => {
        settled = true;
        // Keep the turn's last output: a turn that dies without a classifiable
        // error must still leave a trace, or the next incident is guesswork.
        const text = (value as { text?: unknown }).text;
        settledOutput = typeof text === "string" ? text : undefined;
        return value;
      },
      (error) => { throw error; },
    );
    const value = await Promise.race([tracked, timeout, lost]);
    if (settled && acceptSettled?.(value) === true) return value;
    if (execution!.inspect().state !== "exited") throw new UncertainExecutionError(`${label}: execution termination is uncertain`);
    return value;
  } catch (err) {
    if (!execution) throw err;
    const observedSessionId = execution.inspect().sessionId;
      if (observedSessionId !== undefined) r.record.sessionId = observedSessionId;
    if (!(err instanceof WorkerTimeoutError) && !(err instanceof OwnershipLostError) && !r.lost && execution.inspect().state === "exited") throw err;
    // Never wait indefinitely for a broken cancellation implementation. The
    // bound fits a real one: the backend stop (4s cap) runs beside the tree
    // kill (1.5s cap) and the exit confirmation (0.5s cap). It was 2s until
    // 2026-11-23, which left no room for asking the service to stop its
    // session - so every timed-out turn was "unconfirmed" and parked the task.
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    try {
      stopped = await Promise.race([execution.cancel(), new Promise<false>(resolve => { stopTimer = setTimeout(() => resolve(false), CANCEL_DEADLINE_MS); })]);
      stopped = stopped && execution.inspect().state === "exited";
    } catch { /* failed cancellation is uncertain */ }
    finally { if (stopTimer) clearTimeout(stopTimer); }
    if (err instanceof OwnershipLostError || r.lost) throw new OwnershipLostError();
    if (!stopped) {
      // The turn's own last words (stderr included) are the only evidence of
      // why the CLI went away — carry them, or the incident is unreadable.
      const tail = settledOutput
        ? ` — last output: ${settledOutput.replace(/\s+/g, " ").trim().slice(-400)}`
        : "";
      throw new UncertainExecutionError(`${label}: shutdown unconfirmed; automatic retry prohibited${tail}`);
    }
    if (err instanceof WorkerTimeoutError) {
      const partial = (execution as Execution<T> & { partialOutput?: () => string }).partialOutput;
      throw new WorkerTimeoutError(err.message, typeof partial === "function" ? partial.call(execution) : err.partialOutput);
    }
    throw err;
  } finally { r.execution = undefined; if (timer) clearTimeout(timer); }
}

/** The worker's chain: the task's own model (else the configured chain), then fallbacks. */
const workerChain = (r: Run): string[] => r.task.model === undefined
  ? configChain(r.cfg.model, r.cfg.modelChain, r.cfg.modelFallbacks)
  : modelChain(r.task.model, [...(r.cfg.modelChain ?? []), ...(r.cfg.modelFallbacks ?? [])]);
/** The reviewer's chain: its own model, then its fallbacks — never the task's silently. */
const reviewerChain = (r: Run): string[] => modelChain(r.cfg.reviewerModel, r.cfg.reviewerModelFallbacks);

/**
 * The model a role should use now, per the rotation recorded for this task.
 *
 * The rotation is an index into the full chain, so it is resolved on the full
 * chain. The chain is then walked from that position: a cooling model is
 * skipped, the first dispatchable model after it is used, and only when nothing
 * from there to the end is dispatchable does the walk continue from the head.
 * Indexing the cooldown-filtered chain instead read a partially expired table
 * as a stale position and sent the task back to a model it had already been
 * refused on, carrying the session of the model that was still healthy.
 */
async function modelFor(r: Run, role: ModelRole): Promise<string | undefined> {
  const chain = role === "worker" ? workerChain(r) : reviewerChain(r);
  const rotation = await readModelRotation(r.cfg.tasksDir, r.task.id);
  const explicitCycleProbe = (rotation.cycles?.[role] ?? 0) > 0;
  const available = new Set<string>();
  for (const model of chain) {
    if (explicitCycleProbe || await modelCooldown(r.cfg.tasksDir, model) === null) available.add(model);
  }
  if (chain.length > 0 && available.size === 0) {
    const next = await nextModelCooldown(r.cfg.tasksDir, chain);
    throw new ModelsCoolingError(next?.retryAfter ?? new Date(Date.now() + (r.cfg.modelCooldownMs ?? 900_000)).toISOString());
  }
  const position = chainPosition(chain, rotation[role]);
  const walk = [...chain.slice(position), ...chain.slice(0, position)];
  return walk.find((model) => available.has(model));
}

/**
 * The model that produced the work, for evidence only: the model recorded with
 * the latest worker session, which is the one the last turn ran on. It is not
 * whichever model the chain would dispatch to now — a refusal on another task,
 * or a lapsed window, between the turn and the gate says nothing about who did
 * the work. The chain is asked only when no turn recorded a model, and unlike
 * `modelFor` the lookup never aborts a finished turn: when the whole worker
 * chain is cooling by then, there is simply no label to give.
 */
async function producedModel(r: Run): Promise<string | undefined> {
  const recorded = r.executionState?.latestWorker?.model;
  if (recorded !== undefined) return recorded;
  try {
    return await modelFor(r, "worker");
  } catch (error) {
    if (error instanceof ModelsCoolingError) return undefined;
    throw error;
  }
}

/**
 * Hand a role to the next model in its chain after a provider rejection.
 *
 * Returns whether the work moved. A handover does not spend a retry: the
 * attempt never reached the work, and the alternative is spending the whole
 * budget on the one model that is provably unavailable. The chain is finite, so
 * this stays bounded; running out of models spends retries as before.
 *
 * A handover that cannot be recorded is not a handover: the position is what
 * survives into the retry, and claiming success without it would send the next
 * turn straight back to the model that just refused. It reports `false`
 * instead, so the ordinary retry budget and its `blocked` outcome apply — never
 * an exception out of a task that had already settled its turn.
 */
async function fallBack(r: Run, role: ModelRole, reason: string): Promise<boolean> {
  const chain = role === "worker" ? workerChain(r) : reviewerChain(r);
  let handover: Handover | null = null;
  try {
    const maxRotations = Math.max(1, chain.length * (1 + (r.cfg.chainCycles ?? 0)));
    for (let step = 0; step < maxRotations; step++) {
      const candidate = await owned(r, () => rotateModel(r.cfg.tasksDir, r.task.id, role, chain, reason, r.cfg.chainCycles ?? 0));
      if (candidate === null) break;
      const rotated = await readModelRotation(r.cfg.tasksDir, r.task.id);
      const explicitCycleProbe = (rotated.cycles?.[role] ?? 0) > 0;
      if (explicitCycleProbe || await modelCooldown(r.cfg.tasksDir, candidate.to) === null) {
        handover = candidate;
        break;
      }
      // Another task already proved this candidate unavailable. Rotation is
      // advisory, so advance past it without spawning another provider turn.
    }
  } catch (error) {
    // A lost lease is not a rotation problem: let the run skip, and do not
    // report a write failure for a task this controller no longer owns.
    if (error instanceof OwnershipLostError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    await owned(r, () => appendJournal(r.cfg.tasksDir, r.task.id, {
      stage: role === "worker" ? "worker" : "review",
      event: "model-fallback-failed",
      detail: `could not record the rotation: ${message}`,
    })).catch(() => {});
    emit(r, "model-fallback", `${role}: ${reason} (rotation not recorded: ${message})`);
    return false;
  }
  if (handover === null) return false;
  const detail = `${handover.from || "(default)"} -> ${handover.to}`;
  emit(r, "model-fallback", `${role}: ${detail}`);
  await owned(r, () => appendJournal(r.cfg.tasksDir, r.task.id, {
    stage: role === "worker" ? "worker" : "review",
    event: "model-fallback",
    detail: `${detail} (${reason})`,
  }));
  return true;
}

async function captureUsage(
  r: Run, role: UsageRole, sessionId: string, model: string | undefined, durationMs: number,
): Promise<void> {
  if (!sessionId || !r.deps.adapter.sessionUsage) return;
  try {
    const snapshot = await controlled(r, "usage telemetry", 10_000,
      () => legacyExecution(() => r.deps.adapter.sessionUsage!(sessionId)));
    await recordUsage({
      tasksDir: r.cfg.tasksDir, id: r.task.id, role, sessionId,
      ...(model === undefined ? {} : { model }), durationMs, snapshot,
    });
  } catch (error) {
    if (error instanceof OwnershipLostError) throw error;
    await owned(r, () => appendJournal(r.cfg.tasksDir, r.task.id, {
      stage: role === "worker" ? "worker" : "review", event: "usage-unavailable",
      detail: error instanceof Error ? error.message : String(error),
    })).catch(() => {});
  }
}

/**
 * One agent turn. The declared return type is the union of "the backend
 * answered" and "we timed out", which is why `failure` has to be part of it:
 * both branches reach the caller's provider check. `durationMs` and `tokens` are
 * what the quota classifier reads: a refusal that returned in a second having
 * spent nothing is an allowance problem, not a task problem.
 */
async function turn(r: Run, text: string, model: string | undefined, sessionId?: string): Promise<PromptResult & { timedOut: boolean; durationMs: number }> {
  const taskDir = taskDirOf(r.cfg.tasksDir, r.task.id);
  const logDir = logDirOf(r.cfg.tasksDir, r.task.id);
  // The convention the protocol copy promises: $TASKCTL_LOG_DIR exists before
  // the worker is asked to write into it, every turn (also after handoffs).
  await mkdir(logDir, { recursive: true });
  const startedAt = Date.now();
  // An effort is a provider variant (`model#high`); only ask for one the
  // model actually publishes — a model without that variant refuses the turn
  // (`provider.no-route`) before any work happens.
  const effort = r.task.effort ?? r.cfg.effort;
  const resolved = await r.deps.adapter.resolveModel?.(model, effort);
  const args = {
    sessionId, text,
    model: resolved ?? model,
    effort: resolved === undefined ? effort : undefined,
    title: r.task.title, cwd: r.cfg.workdir,
    env: { [TASK_DIR_ENV]: taskDir, [LOG_DIR_ENV]: logDir },
  };
  try {
    return { ...await controlled(r, "agent turn", r.cfg.turnTimeoutMs ?? TURN_TIMEOUT_MS_DEFAULT,
      () => r.deps.adapter.start ? r.deps.adapter.start(args) : legacyExecution(() => r.deps.adapter.prompt(args)),
      (result) => result.failure === "provider"), timedOut: false, durationMs: Date.now() - startedAt };
  } catch (err) {
    if (!(err instanceof WorkerTimeoutError)) throw err;
    // Only reached if cancellation was positively confirmed.
    await owned(r, () => r.deps.store.clearDoneMarker(r.task.id));
    return { sessionId: "", text: "", exitCode: -1, timedOut: true, durationMs: Date.now() - startedAt };
  }
}

/**
 * One worker turn bracketed by the artifact sweep: snapshot the workspace root
 * before dispatch, move this turn's new litter into `<taskDir>/scratch/`
 * after. The snapshot/sweep pair is what "本轮新增" means — pre-existing and
 * tracked files can never qualify, whatever they match.
 */
async function workedTurn(r: Run, text: string, model: string | undefined, sessionId?: string): Promise<PromptResult & { timedOut: boolean; durationMs: number }> {
  const sweepOn = artifactsOrDefault(r.cfg.artifacts).sweep;
  const before = sweepOn ? await snapshotRoot(r.cfg.workdir) : null;
  const result = await turn(r, text, model, sessionId);
  if (before !== null) await sweepAfterTurn(r, before);
  return result;
}

/**
 * Park this turn's litter and journal what happened. Sweep problems are facts
 * about hygiene, not about the task: every failure is journaled and the run
 * continues (the files simply stay where they are — nothing is ever deleted).
 */
async function sweepAfterTurn(r: Run, before: ReadonlySet<string>): Promise<void> {
  let outcome: SweepOutcome;
  try {
    const cfg = artifactsOrDefault(r.cfg.artifacts);
    outcome = await sweepRoot({
      workdir: r.cfg.workdir,
      scratchDir: scratchDirOf(r.cfg.tasksDir, r.task.id),
      before,
      patterns: cfg.scratchPatterns,
      keepAtRoot: r.task.keepAtRoot,
    });
  } catch (error) {
    await journalSweep(r, "artifact-sweep-failed", error instanceof Error ? error.message : String(error));
    return;
  }
  if (outcome.skipped !== undefined) {
    // The inert reason (e.g. a non-Git workdir) is the same every turn:
    // journal it once per attempt, then stay quiet.
    if (!r.sweepSkipNoted) {
      r.sweepSkipNoted = true;
      await journalSweep(r, "artifact-sweep-skipped", outcome.skipped);
    }
    return;
  }
  for (const move of outcome.moved) {
    await journalSweep(r, "artifact-swept", `${move.from} -> ${move.to}`);
  }
  for (const failure of outcome.failures) {
    await journalSweep(r, "artifact-sweep-failed", `${failure.file}: ${failure.error}`);
  }
}

/** Journal one sweep fact; a journaling failure must not fail the task. */
async function journalSweep(r: Run, event: string, detail: string): Promise<void> {
  try {
    await owned(r, () => appendJournal(r.cfg.tasksDir, r.task.id, { stage: "worker", event, detail }));
  } catch { /* journal unavailable; the sweep itself already happened */ }
}

/** Wait out a quota backoff step; a configured empty schedule waits not at all. */
async function quotaPause(r: Run, step: number): Promise<void> {
  const schedule = r.cfg.quotaBackoffMs;
  const ms = schedule === undefined
    ? quotaBackoffMs(step)
    : (schedule[Math.min(step, Math.max(0, schedule.length - 1))] ?? 0);
  if (ms > 0) await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function noteRefusal(
  r: Run, model: string | undefined, result: PromptResult & { durationMs?: number }, category: "quota" | "provider",
): Promise<void> {
  if (model === undefined) return;
  await noteModelRefusal(r.cfg.tasksDir, model, {
    reason: (result.text ?? "provider rejected the turn").slice(0, 1_000),
    category,
    cooldownMs: r.cfg.modelCooldownMs ?? 900_000,
  });
}

/**
 * Park a task because every model on its chain is cooling. `dispatchedTurns` is
 * how many turns this attempt already dispatched. A task blocked before its
 * first dispatch spent nothing. Whether a dispatched turn spent a retry depends
 * on why it failed — a refused provider turn spends none — and an exhausted
 * budget returns `blocked` before the loop ever gets here, so the note states
 * the count and points at the task file instead of guessing.
 */
async function blockForCooldown(r: Run, role: ModelRole, retryAfter: string, dispatchedTurns = 0): Promise<"blocked"> {
  if (role === "reviewer") {
    // Name the models that are cooling, so the parked record says who refused.
    return await parkReviewPending(r, reviewerChain(r).join(", ") || undefined, `every reviewer model is cooling until ${retryAfter}`);
  }
  const spent = dispatchedTurns === 0
    ? "本任务未派发，也未消耗 retries。"
    : `本尝试已派发 ${dispatchedTurns} 个回合，之后所有候选模型都进入了冷却；已消耗的重试次数以任务文件为准。`;
  await owned(r, async () => {
    const seq = ((await latestNote(r.cfg.tasksDir, r.task.id))?.seq ?? 0) + 1;
    await writeNote(r.cfg.tasksDir, {
      task: r.task.id, seq, status: "blocked:needs-owner",
      done: `所有候选模型都处于共享冷却窗口；${spent}`,
      found: `下一次可探测时间：${retryAfter}`,
      next: "等待窗口结束、调整模型链，或由所有者明确恢复；不要反复启动 run 撞同一批失效模型。",
      files: [],
    });
    await r.deps.store.setStatus(r.task.id, "blocked");
    await appendJournal(r.cfg.tasksDir, r.task.id, {
      stage: "worker", event: "model-cooldown", detail: `every model cooling; next probe ${retryAfter}; turns spent ${dispatchedTurns}`,
    });
  });
  emit(r, "blocked", `every model is cooling; next probe ${retryAfter}; ${dispatchedTurns === 0 ? "retries untouched" : `${dispatchedTurns} turn(s) already spent`}`);
  return "blocked";
}

/** One line saying why a model refused the turn, for the blocked note. */
function refusalLine(model: string, result: PromptResult & { durationMs: number }): string {
  const first = (result.text ?? "").split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? "no output";
  return `${model}: exit ${result.exitCode} in ${result.durationMs}ms, ${first.slice(0, 240)}`;
}

/**
 * Stop for a human when the whole chain is out of allowance.
 *
 * `blocked` rather than a retry: the task never ran, nothing about it failed, and
 * spending its retry budget would only convert a provider's billing window into
 * a task verdict. The note names every model that refused, because the operator's
 * next move (add a funded model, or wait for the window) depends on which.
 */
async function blockForQuota(r: Run, current: string, result: PromptResult & { durationMs: number }): Promise<"blocked"> {
  r.dispatchFailures.set(current, refusalLine(current, result));
  const tried = [...r.dispatchFailures.entries()];
  await owned(r, async () => {
    const seq = ((await latestNote(r.cfg.tasksDir, r.task.id))?.seq ?? 0) + 1;
    await writeNote(r.cfg.tasksDir, {
      task: r.task.id, seq, status: "blocked:needs-owner",
      done: `派发失败：配额耗尽，链上 ${tried.length} 个模型都拒绝执行本任务；未消耗 retries（任务本身没跑过）。`,
      found: tried.map(([model, reason]) => `- ${reason}`).join("\n"),
      next: "换一个有额度的模型（配置 modelChain）、等窗口重置后 taskctl retry，或由所有者决策升级到付费档/其他供应商（不要把它当作任务失败去改判据）。",
      files: [],
    });
    await r.deps.store.setStatus(r.task.id, "blocked");
    await appendJournal(r.cfg.tasksDir, r.task.id, {
      stage: "worker",
      event: "blocked",
      detail: `quota exhausted on every model: ${tried.map(([model]) => model).join(" -> ")}${r.cfg.chainCycles ? ` (chainCycles=${r.cfg.chainCycles} wrap(s) included)` : ""}`,
    });
  });
  emit(r, "blocked", `quota exhausted on every model in the chain (${tried.map(([model]) => model).join(" -> ")}${r.cfg.chainCycles ? `, ${r.cfg.chainCycles} wrap(s)` : ""}); retries untouched — owner decision required (fund a model / wait for the window / escalate tiers by hand)`);
  return "blocked";
}

async function restoreWorkerSession(r: Run, model: string | undefined): Promise<string | undefined> {
  const batchPrevious = r.batch?.resumeFrom;
  const previous = batchPrevious ?? r.executionState?.latestWorker;
  if (!previous?.clean || !previous.model) return undefined;
  if (previous.model !== model) {
    // A cross-task candidate that names another actual model must not fall back
    // to some older task-local session: the batch explicitly starts fresh.
    if (batchPrevious !== undefined) {
      await owned(r, () => appendJournal(r.cfg.tasksDir, r.task.id, {
        stage: "worker", event: "session-reuse-skipped",
        detail: `${previous.sessionId}: actual model ${previous.model} -> ${model ?? "(default)"} does not match; starting fresh`,
      }));
    }
    return undefined;
  }
  // runBatch supplies a candidate only after the previous task settled done.
  // The ordinary task-local path still requires this task's own settled attempt.
  if (batchPrevious === undefined && !r.previousSettled) return undefined;
  if (!r.deps.adapter.canResumeSession) {
    // A missing capability is still a durable reuse decision: without the
    // journal, fresh dispatch looks identical to "there was never a candidate".
    await owned(r, () => appendJournal(r.cfg.tasksDir, r.task.id, {
      stage: "worker", event: "session-reuse-skipped",
      detail: `${previous.sessionId}: session status probe unavailable; starting fresh`,
    }));
    return undefined;
  }
  const status = await r.deps.adapter.canResumeSession(previous.sessionId, { model, cwd: r.cfg.workdir });
  if (status === "active") {
    throw new UncertainExecutionError(`recorded worker session ${previous.sessionId} is still active; reconcile before starting another worker`);
  }
  if (status === "reusable") return previous.sessionId;
  await owned(r, () => appendJournal(r.cfg.tasksDir, r.task.id, {
    stage: "worker", event: "session-reuse-skipped",
    detail: `${previous.sessionId}: backend did not confirm an idle matching session; starting fresh`,
  }));
  return undefined;
}

/**
 * Bounded facts about what each dependency produced, for whoever integrates
 * them. The worker's prompt and the reviewer's evidence share one copy: it is
 * read once per attempt, because a dependency is `done` before the claim and
 * cannot change under it.
 */
async function dependenciesOf(r: Run): Promise<string | null> {
  if (r.dependencies === undefined) {
    const board = await owned(r, async () => r.deps.store.list());
    r.dependencies = await dependencySummary(r.cfg.tasksDir, r.task, board);
  }
  return r.dependencies;
}

/** The context sections one attempt was given; see `readContextSections`. */
export type WorkerContext = ContextSections;

/**
 * The context sections of this attempt, read once for the whole attempt: a
 * session of many turns does not read three files on every one of them, and
 * the journal says `profile-truncated` once, not once per turn.
 */
async function contextOf(r: Run): Promise<WorkerContext> {
  if (r.context === undefined) r.context = await readSections(r);
  return r.context;
}

/**
 * Read the context sections, and the one place that read is guarded.
 *
 * The spec, the profile and the corrections are context, not state: a file
 * that cannot be read says nothing about the work. So anything but a lost
 * lock is journaled once and the attempt goes on with whatever sections were
 * read — none, when the read throws as a whole. Without the guard the error
 * lands in the attempt's error handling and the task is `blocked` over a file
 * that is only context.
 */
async function readSections(r: Run): Promise<WorkerContext> {
  const flags = r.cfg.workerContext ?? { spec: true, preferences: true };
  // What was read before an error survives it. That is nothing when the read
  // itself is what threw: the three files are read in one go.
  let sections: WorkerContext = { profileTruncatedChars: 0 };
  try {
    sections = await readContextSections(r.cfg.tasksDir, r.task, flags);
    if (sections.profileTruncatedChars > 0) {
      // The section is the line that says it was cut, then the part that was kept.
      const kept = sections.profile!.length - sections.profile!.indexOf("\n") - 1;
      await noteContext(r, "profile-truncated", `profile cut; kept the newest ${kept} characters`);
    }
  } catch (err) {
    if (err instanceof OwnershipLostError) throw err;
    await noteContext(r, "context-unavailable", err instanceof Error ? err.message : String(err));
  }
  return sections;
}

/**
 * Journal one fact about the context. The journal is a record, not state: a
 * line that cannot be written is lost and the attempt goes on — unless the
 * write failed because the lock is no longer this attempt's.
 */
async function noteContext(r: Run, event: string, detail: string): Promise<void> {
  await owned(r, () => appendJournal(r.cfg.tasksDir, r.task.id, { stage: "worker", event, detail }))
    .catch((err: unknown) => {
      if (err instanceof OwnershipLostError) throw err;
    });
}

async function loop(r: Run): Promise<"done" | "blocked" | "open" | "awaiting-human"> {
  let sessionId: string | undefined;
  let recordedSession = "", sessionsUsed = r.task.sessions.length, turns = 0;
  // A handover is progress only if the recording sticks. On a cached or syncing
  // filesystem the position can read back stale, and then every turn looks like
  // a successful handover with no retry ever spent. The chain bounds how many
  // legitimate handovers exist — one traversal plus every wrap the cycle budget
  // allows — so the loop is bounded by it too.
  const chainCycles = r.cfg.chainCycles ?? 0;
  const maxHandovers = workerChain(r).length * (1 + chainCycles);
  let handovers = 0;
  // A new attempt gets a fresh wrap budget: the position still points past the
  // models that refused, but the chain may wrap around to them again.
  await resetChainCycles(r.cfg.tasksDir, r.task.id, "worker");
  let restoreSession = true;
  // Dependencies are done before the claim and cannot change under it, so
  // their summary is read once for the whole attempt, not once per turn.
  const dependencies = await dependenciesOf(r);
  // The same holds for the context sections: read once, not once per turn.
  const context = await contextOf(r);
  for (;;) {
    const note = await latestNote(r.cfg.tasksDir, r.task.id);
    const protocol = buildWorkerPrompt(r.task, {
      handoff: note?.markdown, workdir: r.cfg.workdir, tasksDir: r.cfg.tasksDir,
      taskDir: taskDirOf(r.cfg.tasksDir, r.task.id), logDir: logDirOf(r.cfg.tasksDir, r.task.id),
      ...(dependencies === null ? {} : { dependencies }),
      ...(context.spec === undefined ? {} : { spec: context.spec }),
      ...(context.profile === undefined ? {} : { profile: context.profile }),
      ...(context.feedback === undefined ? {} : { feedback: context.feedback }),
    });
    const prompt = r.batch === undefined ? protocol : `${r.batch.preamble}${protocol}`;
    let model: string | undefined;
    try {
      model = await modelFor(r, "worker");
    } catch (error) {
      if (error instanceof ModelsCoolingError) return await blockForCooldown(r, "worker", error.retryAfter, turns);
      throw error;
    }
    if (restoreSession) {
      sessionId = await restoreWorkerSession(r, model);
      // A cross-task restore is not yet in this task's session list. Leaving
      // recordedSession empty in that case makes the first turn append it;
      // ordinary same-task restores are already recorded and stay deduplicated.
      recordedSession = sessionId !== undefined && r.task.sessions.includes(sessionId) ? sessionId : "";
      restoreSession = false;
    }
    const result = await workedTurn(r, prompt, model, sessionId);
    await captureUsage(r, "worker", result.sessionId, model, result.durationMs);
    await owned(r, async () => {
      // A rejected turn did no work, and its session belongs to the backend that
      // refused it: recording it would both spend a session and hand the next
      // provider a transcript it never wrote.
      if (result.sessionId && result.failure !== "provider") {
        if (result.sessionId !== recordedSession) {
          await r.deps.store.appendSession(r.task.id, result.sessionId);
          recordedSession = result.sessionId; sessionsUsed++;
        }
        sessionId = result.sessionId;
        r.executionState = await recordWorkerSession(r.cfg.tasksDir, r.task.id, {
          sessionId: result.sessionId, clean: result.exitCode === 0, ...(model === undefined ? {} : { model }),
        }, declaredExecution(r.task));
      }
    });
    if (result.exitCode === 0 && model !== undefined) await clearModelCooldown(r.cfg.tasksDir, model);
    turns++;
    // The worker is allowed to report that the work is bigger than the task it
    // was given. That claim is not taken on trust for anything except the bar it
    // raises: it can only add a review, never remove one.
    const marker = ESCALATE_MARKER.exec(result.text ?? "");
    if (marker) await escalate(r, marker[1]!.trim());
    let fresh = false;
    // A failed/aborted turn cannot submit successful completion even if it wrote a marker.
    if (result.exitCode !== 0) {
      await owned(r, () => r.deps.store.clearDoneMarker(r.task.id));
      // A turn that was cut off leaves its session mid-thought, maybe inside a
      // tool call. The recording block above is skipped for it (a confirmed
      // timeout reports no session id), so without this the session would keep
      // the `clean` fact of its last successful turn and be resumed later.
      if (result.timedOut && sessionId !== undefined) {
        const interrupted = sessionId;
        await owned(r, async () => {
          r.executionState = await recordWorkerSession(r.cfg.tasksDir, r.task.id, {
            sessionId: interrupted, clean: false, ...(model === undefined ? {} : { model }),
          }, declaredExecution(r.task));
        });
      }
      emit(r, "turn-failed", result.timedOut ? "turn timed out; shutdown confirmed" : `exit ${result.exitCode}`);
      // Allowance refusals are classified before the retry accounting: the task
      // never ran, so this must not cost it a retry (see blockForQuota).
      const kind = classifyDispatchFailure({ failure: result.failure, exitCode: result.exitCode,
        durationMs: result.durationMs, tokens: result.tokens, output: result.text ?? "" });
      const modelName = model ?? "(default)";
      if (result.failure === "provider") await noteRefusal(r, model, result, kind === "quota" ? "quota" : "provider");
      if (kind === "quota") {
        r.dispatchFailures.set(modelName, refusalLine(modelName, result));
        emit(r, "model-fallback", `quota on ${modelName}; not spending a retry`);
        const advanced = handovers < maxHandovers
          && await fallBack(r, "worker", `quota exhausted on ${modelName}`);
        if (advanced) {
          handovers++;
          // Waiting after choosing a *different* healthy provider cools down
          // nothing. Pause only for a same-model cyclic re-probe.
          if (await modelFor(r, "worker") === modelName) await quotaPause(r, handovers - 1);
          // The next model must not continue a session the refusing backend owns.
          fresh = true;
        } else {
          return await blockForQuota(r, modelName, result);
        }
      } else {
        const handedOver = handovers < maxHandovers && result.failure === "provider"
          && await fallBack(r, "worker", `turn rejected by ${model ?? "(default)"}`);
        // The next model must not be asked to continue a session created by
        // another backend. A handover is a session boundary.
        if (handedOver) { handovers++; fresh = true; }
        if (!handedOver && await fail(r)) return "blocked";
      }
    } else if (await owned(r, () => r.deps.store.readDoneMarker(r.task.id))) {
      await owned(r, () => r.deps.store.clearDoneMarker(r.task.id));
      const verdict = await accept(r);
      if (verdict !== "retry") return verdict;
      if (effectiveExecution(r) === "continuous") {
        await escalate(r, "continuous verification failed; iterative rework is required");
      }
      // The controller just wrote concrete failure feedback. Resume this
      // same-model session instead of opening a fresh session that cannot see it.
    } else if (effectiveExecution(r) === "continuous") {
      // One agent turn may contain many tool calls, but a continuous task does
      // not spend dozens of turns discovering whether it needs iteration.
      await escalate(r, "continuous turn ended without a completion request");
    } else if (turns >= (r.cfg.maxTurnsPerSession ?? MAX_TURNS_PER_SESSION_DEFAULT)) {
      // Running out of turns is evidence about the task, not just about the
      // session: whatever this was, it did not fit in one go.
      await escalate(r, "session turn budget exhausted");
      if (await fail(r)) return "blocked";
      fresh = true;
    } else if (await overBudget(r, sessionId, model)) {
      await escalate(r, "context budget exhausted; a session handoff was needed");
      const wrap = await workedTurn(r, WRAP_UP_INSTRUCTION, model, sessionId);
      const after = await latestNote(r.cfg.tasksDir, r.task.id);
      if (!after || after.seq <= (note?.seq ?? 0)) {
        if (wrap.failure === "provider") {
          // The wrap-up turn never ran, so there is no text to build a note from.
          const handedOver = handovers < maxHandovers
            && await fallBack(r, "worker", `wrap-up rejected by ${model ?? "(default)"}`);
          if (handedOver) handovers++;
          if (!handedOver && await fail(r)) return "blocked";
        } else {
          if (!wrap.timedOut) await owned(r, () => writeNote(r.cfg.tasksDir, fallbackNote(r.task, note?.seq ?? 0, wrap.text)));
          emit(r, "handoff", sessionId);
          if (await fail(r)) return "blocked";
        }
      } else emit(r, "handoff", sessionId);
      fresh = true;
    }
    if (fresh) {
      if (sessionsUsed >= (r.cfg.maxSessionsPerTask ?? MAX_SESSIONS_PER_TASK_DEFAULT) && await fail(r)) return "blocked";
      sessionId = undefined; turns = 0;
    }
  }
}

/**
 * The digest the attempt is judged against: the claim-time snapshot, which is
 * the authority, falling back to this process's copy only when no snapshot was
 * ever written (a run that died before the claim block finished).
 */
async function attemptDefinition(r: Run): Promise<string> {
  const snapshot = await readDefinitionSnapshot(r.cfg.tasksDir, r.task.id);
  return snapshot?.digest ?? r.definition;
}

/**
 * True while the task still carries the definition this attempt started under.
 *
 * The status is part of the question: a human moving the task out from under a
 * running attempt is the same kind of change as an edit to its criteria, and it
 * must not be judged under rules the attempt never ran by. Lifecycle fields
 * (retries, sessions) are not part of the definition at all — see
 * {@link definitionFields} — so lowering a retry count mid-run is not drift.
 */
async function definitionIntact(r: Run, statuses: readonly Task["status"][]): Promise<boolean> {
  const definition = await attemptDefinition(r);
  const current = await owned(r, async () => (await r.deps.store.list()).find((task) => task.id === r.task.id));
  return !!current && statuses.includes(current.status) && definitionDigest(current) === definition;
}

/** Refuse to act on work whose task definition moved under it. */
async function requireUnchangedDefinition(r: Run, statuses: readonly Task["status"][], detail: string): Promise<void> {
  if (await definitionIntact(r, statuses)) return;
  await owned(r, () => appendJournal(r.cfg.tasksDir, r.task.id, {
    stage: "review",
    event: "definition-drift",
    detail,
  }));
  throw new ReviewRequiredError(
    "task definition changed during the attempt (criteria/tolerate/risk); re-approve before reviewing",
  );
}

/**
 * The consecutive-identical-acceptance-failure counter, beside `attempt.json`.
 *
 * It survives the attempt on purpose: the loop that burns a gate five times is
 * usually a *new* attempt per round, so an in-memory counter would restart at 1
 * every time and never trip. A pass deletes it — the failure it counted is gone.
 */
const ACCEPTANCE_FAILURES_FILE = "acceptance-failures.json";

type AcceptanceFailureRecord = { fingerprint: string; count: number; updatedAt: string };

/**
 * Count this failure against the streak of identical ones and return the streak.
 *
 * Identity is the *normalized* output (see {@link failureFingerprint}): the same
 * failure printed at a different clock time, from a different absolute path, or
 * after a different elapsed time is the same failure. A different fingerprint
 * starts the streak over at 1, because a gate that fails differently each round
 * is making progress somewhere, even if not enough.
 */
async function recordAcceptanceFailure(r: Run, output: string): Promise<{ fingerprint: string; count: number }> {
  const fingerprint = failureFingerprint(output, { roots: [r.cfg.workdir, r.cfg.tasksDir] });
  const previous = await readRuntime<AcceptanceFailureRecord>(r.cfg.tasksDir, r.task.id, ACCEPTANCE_FAILURES_FILE);
  const count = previous?.fingerprint === fingerprint ? (Number(previous.count) || 0) + 1 : 1;
  await writeRuntime(r.cfg.tasksDir, r.task.id, ACCEPTANCE_FAILURES_FILE, {
    fingerprint, count, updatedAt: new Date().toISOString(),
  } satisfies AcceptanceFailureRecord);
  return { fingerprint, count };
}

/** A passing acceptance clears the streak: whatever repeated, no longer is. */
async function clearAcceptanceFailures(r: Run): Promise<void> {
  await rm(join(r.cfg.tasksDir, r.task.id, ACCEPTANCE_FAILURES_FILE), { force: true });
}

async function resumeReviewOnly(r: Run, pending: ReviewPendingRecord): Promise<"done" | "blocked" | "open" | "awaiting-human"> {
  if (pending.definitionDigest !== await attemptDefinition(r)) {
    throw new ReviewRequiredError("review-only recovery refused: the task definition changed; old evidence is stale");
  }
  const artifactNow = await artifactDigest(r.cfg.workdir, [r.cfg.tasksDir], r.cfg.artifactIgnore ?? []);
  if (pending.artifactDigest !== artifactNow) {
    throw new ReviewRequiredError("review-only recovery refused: artifacts changed after the preserved worker/acceptance evidence");
  }
  // Only the review runs from here. Recorded as its own event so a later
  // reader can tell a review-only recovery from an ordinary review round.
  await owned(r, () => appendJournal(r.cfg.tasksDir, r.task.id, {
    stage: "review", event: "review-only", detail: "resuming review on the preserved worker/acceptance evidence",
  }));
  const outcome = await reviewStage(r, preservedWindow(pending));
  if (outcome === "retry") {
    // A real fail verdict needs worker side effects, which a review-only claim
    // deliberately cannot perform. The judge already wrote the feedback note.
    await owned(r, () => r.deps.store.setStatus(r.task.id, "open"));
    return "open";
  }
  return outcome;
}

async function accept(r: Run): Promise<"done" | "blocked" | "retry" | "open" | "awaiting-human"> {
  // Which model produced the work is part of the evidence: after a handover it
  // is no longer the model the operator configured. The lookup only labels
  // evidence, so a cooldown that began while the worker was running must not
  // abort a turn that already finished.
  const model = await producedModel(r);
  if (r.task.verify === "render") return await acceptRender(r, model);
  const command = r.task.acceptance?.trim();
  if (!command) {
    // No command and no criteria: nothing can judge this task, so it waits for
    // a human. With criteria, the reviewer is the gate — office, design and
    // research tasks rarely have a shell command that means "done".
    if (r.task.criteria.length === 0) {
      // A quick task never wrote criteria down in the first place, so there is
      // nothing for a reviewer to judge it against. Waiting for a human is its
      // terminus, not a failure of the run.
      if (r.task.quick) {
        await owned(r, () => r.deps.store.setStatus(r.task.id, "awaiting-human"));
        emit(r, "awaiting-human", "quick task has no criteria; a human decides");
        return "awaiting-human";
      }
      emit(r, "acceptance-skipped", "missing acceptance requires review");
      throw new ReviewRequiredError("missing acceptance criteria; review required");
    }
    // The command path has always compared the definition digest; this path did
    // not, so a worker could rewrite its own task file during its turn — widen
    // `tolerate`, soften `criteria` — and the reviewer would judge it against
    // the self-written definition. A definition is the operator's, and a change
    // to it invalidates the attempt rather than being reviewed under the new
    // rules.
    await requireUnchangedDefinition(r, ["running"], "the task definition changed before the review; refusing to review it");
    emit(r, "acceptance-skipped", "no command; review-only");
    await owned(r, () => writeRuntime(r.cfg.tasksDir, r.task.id, "acceptance.json", {
      command: "(none)", passed: false, skipped: true, exitCode: null, model,
      // The review-only path has no command window, so the attempt window is the
      // only time evidence the reviewer will have. Without it every "was this
      // there before the task started?" question is unanswerable, and a declared
      // tolerance would have to be refused to stay safe.
      startedAt: r.record.startedAt, finishedAt: new Date().toISOString(),
      note: "no acceptance command; review decides", at: new Date().toISOString(),
    }));
    return await reviewStage(r);
  }
  const artifactBefore = await artifactDigest(r.cfg.workdir, [r.cfg.tasksDir], r.cfg.artifactIgnore ?? []);
  const startedAt = new Date().toISOString();
  let result: AcceptanceResult;
  try {
    // The gate always runs the command in `check` mode: it must verify, not
    // (re)generate, because the digest comparison below spans the run. The
    // worker-side invocations default to `generate` and land inside the
    // attempt window instead (see TASKCTL_ACCEPTANCE_MODE in the README).
    result = await controlled(r, "acceptance", r.cfg.acceptanceTimeoutMs ?? ACCEPTANCE_TIMEOUT_MS_DEFAULT,
      () => r.deps.acceptance ? legacyExecution(() => r.deps.acceptance!(command, r.cfg.workdir)) : startAcceptance(command, r.cfg.workdir, "check"));
  } catch (err) {
    if (!(err instanceof WorkerTimeoutError)) throw err;
    result = {
      passed: false, skipped: false, exitCode: null,
      output: [err.message, err.partialOutput].filter((part) => part !== undefined && part.length > 0).join("\n"),
    };
  }
  const artifactAfter = await artifactDigest(r.cfg.workdir, [r.cfg.tasksDir], r.cfg.artifactIgnore ?? []);
  // All controller writers use the same mutex as takeover for final validation/write.
  // The review runs outside this guard: it takes the same mutex for its own
  // writes, and nesting would deadlock the task against itself.
  const outcome = await owned(r, async (): Promise<"review" | "blocked" | "retry" | "done" | "awaiting-human"> => {
    const current = (await r.deps.store.list()).find(t => t.id === r.task.id);
    const definition = await attemptDefinition(r);
    const definitionMatches = !!current && current.status === "running" && definitionDigest(current) === definition;
    const evidence = { attemptId: r.owner, definitionDigest: definition, artifactBefore, artifactAfter, command,
      mode: "check" as const, startedAt, finishedAt: new Date().toISOString(), ...result, model, definitionMatches };
    await writeRuntime(r.cfg.tasksDir, r.task.id, "acceptance.json", evidence);
    if (!definitionMatches || artifactBefore !== artifactAfter || result.skipped) throw new ReviewRequiredError("acceptance evidence invalidated by definition/artifact drift or skipped check");
    emit(r, "acceptance", result.passed ? "passed" : `failed (exit ${result.exitCode ?? "null"})`);
    await appendJournal(r.cfg.tasksDir, r.task.id, {
      stage: "worker",
      event: "acceptance",
      detail: `${result.passed ? "passed" : "failed"} exit=${result.exitCode ?? "null"}`,
    });
    if (result.passed) {
      await clearAcceptanceFailures(r);
      // The operator asked for the exit code to be the verdict, and it is: there is
      // nothing left for a reviewer to add. An escalated run loses this shortcut,
      // because escalation means the evidence stopped describing the work.
      if (r.task.verify === "mechanical" && !r.escalated) {
        return await finishVerified(r, "acceptance passed; verify=mechanical");
      }
      return "review";
    }
    const retries = await r.deps.store.incRetries(r.task.id);
    // The same failure, over and over, is not a retry problem: re-running it
    // rebuilds the same evidence for minutes and learns nothing. (A bio
    // similarity gate that had been deliberately superseded burned five
    // acceptance runs before a human noticed.) Stop while a person can still act.
    const streak = await recordAcceptanceFailure(r, result.output ?? "");
    const limit = r.cfg.failureFingerprintLimit ?? FAILURE_FINGERPRINT_LIMIT_DEFAULT;
    if (streak.count >= limit) {
      const seq = ((await latestNote(r.cfg.tasksDir, r.task.id))?.seq ?? 0) + 1;
      await writeNote(r.cfg.tasksDir, {
        task: r.task.id, seq, status: "blocked:needs-owner",
        done: `验收连续 ${streak.count} 次给出同一失败（指纹 ${streak.fingerprint}）；已停止自动重试，等人工判断。`,
        found: `acceptance: ${command}\nstreak: ${streak.count}/${limit}\noutput: ${(result.output ?? "").slice(0, 800)}`,
        next: "同一条失败重跑不会再给新信息：先决定是改判据/修门，还是承认证据不足；改完再 taskctl retry。",
        files: [],
      });
      await appendJournal(r.cfg.tasksDir, r.task.id, {
        stage: "worker", event: "blocked",
        detail: `same acceptance failure ${streak.count}x (fingerprint ${streak.fingerprint}); needs owner`,
      });
      await r.deps.store.setStatus(r.task.id, "blocked");
      emit(r, "blocked", `the same acceptance failure repeated ${streak.count} time(s); needs owner`);
      return "blocked";
    }
    if (retries >= r.cfg.retryLimit) {
      await r.deps.store.setStatus(r.task.id, "blocked"); emit(r, "blocked", "retry limit reached"); return "blocked";
    }
    const seq = ((await latestNote(r.cfg.tasksDir, r.task.id))?.seq ?? 0) + 1;
    await writeNote(r.cfg.tasksDir, {
      task: r.task.id, seq, status: "acceptance-failed",
      done: `控制器验收失败（exit ${result.exitCode ?? "null"}），将带着本次证据返工。`,
      found: `fingerprint: ${streak.fingerprint} (${streak.count}/${limit})\n${(result.output ?? "").slice(-4_000)}`,
      next: "根据上面的控制器验收输出修复；先做有界定向自验，不要无意义重复全量验收。",
      files: [],
    });
    // The explicit record of an automatic rework round. The metrics that keep
    // "the controller sent it back" apart from "a person sent it back" count
    // these events; they never infer a round from the lines around it.
    await appendJournal(r.cfg.tasksDir, r.task.id, {
      stage: "worker",
      event: "rework",
      detail: `acceptance failed (exit ${result.exitCode ?? "null"}); the worker resumes with the failure output`,
    });
    return "retry";
  });
  if (outcome === "review") {
    return await reviewStage(r);
  }
  return outcome;
}

/**
 * Finish a task whose own evidence passed.
 *
 * The human gates are not relaxed by choosing a machine verdict: `risk: high` and
 * `human_check` mean a person looks at it, and an exit code is a weaker claim than
 * a reviewer's, not a stronger one.
 */
async function finishVerified(r: Run, detail: string): Promise<"done" | "awaiting-human"> {
  if (r.task.risk === "high" || r.task.humanCheck) {
    await r.deps.store.setStatus(r.task.id, "awaiting-human");
    emit(r, "awaiting-human", `${detail}; human sign-off required`);
    return "awaiting-human";
  }
  await r.deps.store.setStatus(r.task.id, "done");
  await appendJournal(r.cfg.tasksDir, r.task.id, { stage: "worker", event: "done", detail });
  emit(r, "done", detail);
  return "done";
}

/**
 * The render gate: open every declared target in a headless browser at every
 * viewport and require that it draws, has something to read, and fits.
 *
 * It exists because a reviewer sees text. On the task that motivated this, the
 * first build was blank (a script threw before first paint) and the second stuck
 * 40px out of a phone viewport; both read as clean code and both were only ever
 * caught by looking at the render.
 */
async function acceptRender(
  r: Run,
  model: string | undefined,
): Promise<"done" | "blocked" | "retry" | "open" | "awaiting-human"> {
  const id = r.task.id;
  await requireUnchangedDefinition(r, ["running"], "the task definition changed before the render check; refusing to check it");
  const evidenceDir = join(r.cfg.tasksDir, id, "evidence");
  await mkdir(evidenceDir, { recursive: true });
  let check: RenderCheck;
  try {
    check = await checkRender({
      targets: r.task.renderTargets.map((target) => join(r.cfg.workdir, target)),
      ...(r.cfg.renderViewports === undefined ? {} : { viewports: r.cfg.renderViewports }),
      evidenceDir,
      ...(r.cfg.chromeBin === undefined ? {} : { chromeBin: r.cfg.chromeBin }),
    });
  } catch (err) {
    if (err instanceof RenderUnavailableError) {
      await owned(r, () => appendJournal(r.cfg.tasksDir, id, {
        stage: "worker",
        event: "render-unavailable",
        detail: err.message,
      }));
      // A check that could not run is not a pass, and the reviewer cannot see the
      // page either. Park it for an operator instead of letting it through.
      throw new ReviewRequiredError(`render check could not run: ${err.message}`);
    }
    throw err;
  }
  const evidenceDigest = await attemptDefinition(r);
  await owned(r, () => writeRuntime(r.cfg.tasksDir, id, "render.json", {
    ...check, model, definitionDigest: evidenceDigest, escalated: r.escalated,
  }));
  if (check.ok) {
    emit(r, "acceptance", `render ok (${check.views.length} view(s))`);
    await owned(r, () => appendJournal(r.cfg.tasksDir, id, {
      stage: "worker",
      event: "acceptance",
      detail: `render ok views=${check.views.length}`,
    }));
    if (r.escalated) return await reviewStage(r);
    const finished = await owned(r, () => finishVerified(r, "render check passed"));
    return finished;
  }
  const failures = describeFailures(check);
  emit(r, "acceptance", `render failed: ${failures[0] ?? "unknown"}`);
  await owned(r, () => appendJournal(r.cfg.tasksDir, id, {
    stage: "worker",
    event: "acceptance",
    detail: `render failed: ${failures.join(" | ")}`,
  }));
  if (await fail(r)) return "blocked";
  return "retry";
}

/**
 * The independent review gate. It runs in its own session, sees only written
 * evidence, and can never mark work done on its own when the task has no
 * criteria, is high risk, or asks for a human sign-off.
 *
 * `preserved` is the window of the attempt that produced the evidence, passed
 * by a review-only recovery. Without it the window is the current attempt's:
 * the reviewer is told when this execution ran, and every "was this there
 * before the task started?" judgement rests on it.
 */
async function reviewStage(
  r: Run,
  preserved?: { startedAt: string; finishedAt: string },
): Promise<"done" | "blocked" | "retry" | "open" | "awaiting-human"> {
  const id = r.task.id;
  if (r.task.criteria.length === 0) {
    await owned(r, () => r.deps.store.setStatus(id, "awaiting-human"));
    emit(r, "awaiting-human", "no acceptance criteria to review");
    return "awaiting-human";
  }
  const acceptance = await readRuntime<Record<string, unknown>>(r.cfg.tasksDir, id, "acceptance.json");
  // The reviewer judges text, so the workspace's own footprint — what the
  // worker (and anyone else) changed — is collected as text too. Never throws:
  // a non-Git workdir yields explicit unavailable notes instead of blocking
  // the review.
  const changes = await collectChangeEvidence(r.cfg.workdir);
  const dependencies = await dependenciesOf(r);
  const evidence: ReviewEvidence = {
    task: r.task,
    spec: (await readSpec(r.cfg.tasksDir, id)) ?? "",
    ...(dependencies === null ? {} : { dependencies }),
    acceptanceMarkdown: acceptance === null ? "" : renderAcceptance(acceptance),
    handoff: (await latestNote(r.cfg.tasksDir, id))?.markdown ?? null,
    journal: await journalTail(r.cfg.tasksDir, id, 30),
    changes,
    window: preserved ?? { startedAt: r.record.startedAt, finishedAt: new Date().toISOString() },
    acceptanceLogPath: join(taskDirOf(r.cfg.tasksDir, id), "acceptance.json"),
  };
  emit(r, "reviewing");
  await owned(r, async () => {
    await r.deps.store.setStatus(id, "review");
    await appendJournal(r.cfg.tasksDir, id, { stage: "review", event: "started", detail: `criteria=${r.task.criteria.length}` });
  });

  // The previous review's criterion outcomes, if any, are read before the next
  // verdict overwrites review.json below. They anchor the stall check: a
  // reviewer can only be asked "did anything change since last time" if the
  // last round's per-criterion facts are still in scope.
  const prevCriteria = (await readRuntime<{ criteria?: CriterionResult[] }>(r.cfg.tasksDir, id, "review.json"))?.criteria ?? null;

  // A provider rejection is not a verdict: the reviewer never got to judge. The
  // review is retried in place — with the next model when the chain has one —
  // and the task does not go back through the worker, because re-executing the
  // work to retry a review duplicates every side effect of a task that is not
  // idempotent (a spreadsheet write, a file move). The chain is a cycle under
  // the same wrap budget as the worker's, and the loop is bounded by it
  // explicitly rather than by trusting the read-back: a position that keeps
  // coming back stale would otherwise spin forever with no retry spent.
  const chainCycles = r.cfg.chainCycles ?? 0;
  const maxHandovers = reviewerChain(r).length * (1 + chainCycles);
  let handovers = 0;
  // A fresh review round gets a fresh wrap budget, like a fresh attempt.
  await resetChainCycles(r.cfg.tasksDir, id, "reviewer");
  for (;;) {
    let reviewerModel: string | undefined;
    try {
      reviewerModel = await modelFor(r, "reviewer");
    } catch (error) {
      if (error instanceof ModelsCoolingError) return await blockForCooldown(r, "reviewer", error.retryAfter);
      throw error;
    }
    const resolvedReviewer = await r.deps.adapter.resolveModel?.(reviewerModel, r.cfg.reviewerEffort);
    const reviewStarted = Date.now();
    let result: ReviewResult;
    try {
      result = await controlled(r, "review", r.cfg.turnTimeoutMs ?? TURN_TIMEOUT_MS_DEFAULT, () =>
        r.deps.review
          ? legacyExecution(() => r.deps.review!(evidence))
          : startReview({
            adapter: r.deps.adapter,
            cwd: r.cfg.workdir,
            model: resolvedReviewer ?? reviewerModel,
            effort: resolvedReviewer === undefined ? r.cfg.reviewerEffort : undefined,
            title: r.task.title,
          }, evidence),
        (review) => review.failure === "provider",
      );
    } catch (err) {
      // Only reached once the reviewer's shutdown was positively confirmed
      // (anything else propagates). The judge never answered, which is the
      // reviewer-unavailable case of §9: the work and its acceptance stand,
      // so only the missing review is parked, for `retry --review-only`.
      if (!(err instanceof WorkerTimeoutError)) throw err;
      await owned(r, () => appendJournal(r.cfg.tasksDir, id, { stage: "review", event: "review-timed-out", detail: err.message }))
        .catch(() => {});
      return await parkReviewPending(r, reviewerModel, err.message);
    }
    if (result.reviewerSessionId) {
      await captureUsage(r, "reviewer", result.reviewerSessionId, reviewerModel, Date.now() - reviewStarted);
    }
    await owned(r, async () => {
      // Which model judged is part of the evidence: work passed by a fallback is
      // not the same claim as work passed by the model the operator chose. So is
      // the declaration that authorised any excused drift — a narrowed field
      // must not read as if the reviewer had been allowed what it now says.
      const definition = await attemptDefinition(r);
      await writeRuntime(r.cfg.tasksDir, id, "review.json", {
        ...result,
        model: reviewerModel,
        tolerate: r.task.tolerate,
        definitionDigest: definition,
        // What the reviewer actually saw, for post-mortems: the exact
        // (already-truncated) change list and diffstat injected into the
        // prompt, not a re-collection that may since have changed.
        evidence: { gitStatus: changes.status, gitDiffStat: changes.diffStat },
        at: new Date().toISOString(),
      });
      await appendJournal(r.cfg.tasksDir, id, {
        stage: "review",
        event: "verdict",
        // Tolerated drift is recorded, never silent: the count is in the journal
        // and the changes themselves are in review.json.
        detail: result.externalChanges.length > 0
          ? `${result.verdict} external=${result.externalChanges.length}`
          : result.verdict,
      });
    });
    emit(r, "reviewed", result.externalChanges.length > 0
      ? `${result.verdict} (${result.externalChanges.length} external change(s) tolerated)`
      : result.verdict);

    if (result.failure !== "provider") {
      if (reviewerModel !== undefined) await clearModelCooldown(r.cfg.tasksDir, reviewerModel);
      // Checked again here: the pre-review check ran before this turn, and a task
      // file edited while the reviewer was reading would otherwise be completed —
      // or reopened for rework — under a definition the reviewer never saw.
      await requireUnchangedDefinition(r, ["review"], "the task definition changed during the review; refusing to act on the verdict");
      await rm(join(r.cfg.tasksDir, id, "review-pending.json"), { force: true });
      return await judge(r, result, prevCriteria);
    }
    if (reviewerModel !== undefined) {
      await noteModelRefusal(r.cfg.tasksDir, reviewerModel, {
        reason: result.summary || "review provider rejected the turn",
        category: "provider", cooldownMs: r.cfg.modelCooldownMs ?? 900_000,
      });
    }
    await owned(r, () => appendJournal(r.cfg.tasksDir, id, {
      stage: "review",
      event: "provider-failed",
      detail: result.summary,
    }));
    const handedOver = handovers < maxHandovers
      && await fallBack(r, "reviewer", `review rejected by ${reviewerModel ?? "(default)"}`);
    if (handedOver) {
      handovers++;
      emit(r, "rework", "reviewer provider failure; retrying with the next model");
      continue;
    }
    // No reviewer is available, but the worker and acceptance already produced
    // valid evidence. Park only the missing review instead of replaying those
    // side effects on a later scheduler pass.
    return await parkReviewPending(r, reviewerModel, result.summary || "review provider rejected the turn");
  }
}

/** The window a parked record carries, when it is shaped like one. */
function preservedWindow(
  pending: ReviewPendingRecord | null,
): { startedAt: string; finishedAt: string } | undefined {
  const window = pending?.window;
  return typeof window?.startedAt === "string" && typeof window.finishedAt === "string" ? window : undefined;
}

/**
 * Park only the missing review: the worker and acceptance already produced
 * valid evidence, and replaying those side effects on a later scheduler pass
 * is what this avoids. `reason` is why no verdict exists — a refused provider
 * or a reviewer that ran out of time.
 */
async function parkReviewPending(
  r: Run, reviewerModel: string | undefined, reason: string,
): Promise<"blocked"> {
  const acceptance = await readRuntime<Record<string, unknown>>(r.cfg.tasksDir, r.task.id, "acceptance.json");
  const previous = await readRuntime<ReviewPendingRecord>(r.cfg.tasksDir, r.task.id, "review-pending.json");
  const artifactDigestAfter = typeof acceptance?.artifactAfter === "string"
    ? acceptance.artifactAfter
    : await artifactDigest(r.cfg.workdir, [r.cfg.tasksDir], r.cfg.artifactIgnore ?? []);
  const now = new Date().toISOString();
  const refusal = {
    model: reviewerModel ?? "(default)",
    reason: (reason || "review provider rejected the turn").slice(0, 1_000),
  };
  const pending: ReviewPendingRecord = {
    definitionDigest: await attemptDefinition(r),
    artifactDigest: artifactDigestAfter,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    refusals: [...(previous?.refusals ?? []), refusal].slice(-20),
    // The window of the attempt whose evidence is preserved. A recovery that is
    // parked again is a later attempt that produced nothing: it keeps the first.
    window: preservedWindow(previous) ?? { startedAt: r.record.startedAt, finishedAt: now },
  };
  await owned(r, async () => {
    await writeRuntime(r.cfg.tasksDir, r.task.id, "review-pending.json", pending);
    await r.deps.store.setStatus(r.task.id, "blocked");
    await appendJournal(r.cfg.tasksDir, r.task.id, {
      stage: "review", event: "review-pending",
      detail: `${refusal.model}: ${refusal.reason}; worker/acceptance preserved`,
    });
  });
  emit(r, "blocked", "review pending: reviewer providers unavailable; worker and acceptance preserved; retry with --review-only");
  return "blocked";
}

/** Act on a verdict that actually judged the work. */
async function judge(
  r: Run,
  result: ReviewResult,
  prevCriteria: CriterionResult[] | null,
): Promise<"done" | "blocked" | "retry" | "open" | "awaiting-human"> {
  const id = r.task.id;
  if (result.verdict === "unclear") {
    await owned(r, () => r.deps.store.setStatus(id, "awaiting-human"));
    emit(r, "awaiting-human", "review could not decide");
    return "awaiting-human";
  }
  if (result.verdict === "pass") {
    if (r.task.risk === "high" || r.task.humanCheck) {
      await owned(r, () => r.deps.store.setStatus(id, "awaiting-human"));
      emit(r, "awaiting-human", "review passed; human sign-off required");
      return "awaiting-human";
    }
    await owned(r, async () => {
      await r.deps.store.setStatus(id, "done");
      await appendJournal(r.cfg.tasksDir, id, { stage: "review", event: "done", detail: "passed" });
    });
    emit(r, "done", "review passed");
    return "done";
  }

  // Verdict is `fail`. Before spending another rework round, ask whether the
  // worker is moving or spinning in place. The only stable signal across
  // rounds is the per-criterion pass/fail edge: criterion ids are locked by the
  // definition digest, so "the same criterion failed both times" is a fact,
  // not a paraphrase. A worker that changed nothing (no criterion flipped, no
  // new failure appeared) is stalled — one more rework round would replay the
  // same result — so it stops early instead of burning every allotted round.
  if (prevCriteria !== null && stalled(prevCriteria, result.criteria)) {
    const rounds = r.task.reviewRounds; // not yet incremented: the stall is its own outcome
    await owned(r, async () => {
      await r.deps.store.setStatus(id, "blocked");
      await appendJournal(r.cfg.tasksDir, id, {
        stage: "review",
        event: "blocked",
        detail: `stalled: the failing criteria are unchanged from round ${rounds} (${result.criteria.filter((c) => !c.pass).map((c) => c.id).join(", ")})`,
      });
    });
    emit(r, "blocked", `rework stalled after ${rounds} round(s): no criterion changed`);
    return "blocked";
  }

  // The worker moved (a criterion flipped, or a new one failed): spend a
  // rework round, or block once rounds are exhausted.
  const rounds = await owned(r, () => r.deps.store.incReviewRounds(id));
  const limit = r.cfg.maxReviewRounds ?? MAX_REVIEW_ROUNDS_DEFAULT;
  if (rounds > limit) {
    await owned(r, async () => {
      await r.deps.store.setStatus(id, "blocked");
      await appendJournal(r.cfg.tasksDir, id, { stage: "review", event: "blocked", detail: `${rounds}/${limit}` });
    });
    emit(r, "blocked", `review rounds exhausted (${rounds}/${limit})`);
    return "blocked";
  }
  const seq = ((await latestNote(r.cfg.tasksDir, id))?.seq ?? 0) + 1;
  await owned(r, async () => {
    await writeNote(r.cfg.tasksDir, reviewNote(r.task, seq, result));
    // Ordinary review rework continues inside this claim and resumes the same
    // worker session. `open` is reserved for an actual later scheduler attempt.
    await r.deps.store.setStatus(id, "running");
    await appendJournal(r.cfg.tasksDir, id, {
      stage: "review",
      event: "rework",
      detail: `round ${rounds}: ${result.defects.join("; ") || result.summary}`,
    });
  });
  emit(r, "rework", `round ${rounds}: ${result.defects.join("; ") || result.summary}`);
  return "retry";
}

/**
 * A rework round is stalled when nothing moved since the previous review: no
 * previously-failing criterion passed, and no new criterion failed. Set
 * identity ignores ids that are absent from one side (the criteria list is
 * locked, so a mismatch means drift, not progress — and drift is handled
 * upstream by requireUnchangedDefinition).
 */
function stalled(prev: CriterionResult[], curr: CriterionResult[]): boolean {
  const prevFail = new Set(prev.filter((c) => !c.pass).map((c) => c.id));
  const currFail = new Set(curr.filter((c) => !c.pass).map((c) => c.id));
  // Same failing set ⇒ nothing flipped either direction.
  if (prevFail.size !== currFail.size) return false;
  for (const id of prevFail) if (!currFail.has(id)) return false;
  return true;
}

/** One line per acceptance fact the reviewer may rely on. */
function renderAcceptance(record: Record<string, unknown>): string {
  const value = (key: string) => (record[key] === undefined || record[key] === null ? "-" : String(record[key]));
  const outcome = record.skipped === true
    ? "skipped (no acceptance command; review decides)"
    : record.passed === true ? "passed" : "failed";
  return [
    `command: ${value("command")}`,
    `result: ${outcome}`,
    `exitCode: ${value("exitCode")}`,
    `mode: ${value("mode")}`,
    // The acceptance window is the narrowest slice the reviewer can trust: a
    // workspace that changed outside it changed while someone else had it open.
    `windows: startedAt ${value("startedAt")} finishedAt ${value("finishedAt")}`,
    `artifactBefore: ${value("artifactBefore")}`,
    `artifactAfter: ${value("artifactAfter")}`,
    `model: ${value("model")}`,
    ...(record.note === undefined ? [] : [`note: ${value("note")}`]),
    `output: ${value("output")}`,
  ].join("\n");
}

/** The rework note: what failed, and exactly what has to change. */
function reviewNote(task: Task, seq: number, result: ReviewResult): HandoffNote {
  return {
    task: task.id,
    seq,
    status: "review-failed",
    done: result.summary || "复核未通过",
    found: result.criteria.filter((criterion) => !criterion.pass).map((criterion) => `${criterion.id}: ${criterion.evidence}`).join("; ") || "未报告逐条依据",
    next: result.defects.length > 0 ? result.defects.join("; ") : "按未通过的验收标准返工",
    files: [],
  };
}

async function overBudget(r: Run, sessionId: string | undefined, model: string | undefined): Promise<boolean> {
  if (!sessionId || !model) return false;
  // Telemetry is not allowed to hang indefinitely outside the lease/cancel boundary.
  try {
    const usage = await controlled(r, "context telemetry", 10_000, () => legacyExecution(async () => {
      const [used, limit] = await Promise.all([
        r.deps.adapter.contextUsage(sessionId),
        r.deps.adapter.contextLimit(model),
      ]);
      return limit > 0 && used / limit >= r.cfg.contextThreshold;
    }));
    return usage;
  } catch (err) {
    if (err instanceof OwnershipLostError || err instanceof UncertainExecutionError) throw err;
    // A silent "not over budget" reads as a measured answer. Say once that the
    // check could not run, so a control plane that stopped answering is visible.
    if (!r.budgetUnavailableNoted) {
      r.budgetUnavailableNoted = true;
      await owned(r, () => appendJournal(r.cfg.tasksDir, r.task.id, {
        stage: "worker", event: "context-budget-unavailable",
        detail: err instanceof Error ? err.message : String(err),
      })).catch(() => {});
    }
    return false;
  }
}
function fallbackNote(task: Task, seq: number, text: string): HandoffNote {
  const summary = `任务 ${task.id}（${task.title}）上回合输出：${text}`.slice(0, 500);
  return { task: task.id, seq: seq + 1, status: "orchestrator-fallback", done: summary,
    found: "agent 未按收尾指令写 note；本笔记由编排器兜底生成", next: summary, files: [] };
}
