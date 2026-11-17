import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { claim, heartbeat, lockLive, release, withOwnership, OwnershipLostError } from "./claim.js";
import { latestNote, writeNote, type HandoffNote } from "./handoff.js";
import { startAcceptance, type AcceptanceResult } from "./acceptance.js";
import { buildWorkerPrompt } from "./protocol.js";
import type { TaskStore } from "./task-store.js";
import type { Task } from "./task-file.js";
import type { AgentAdapter, PromptResult } from "./adapters/types.js";
import type { Execution } from "./execution.js";
import { reserveWorkspace, artifactDigest, type WorkspaceReservation } from "./workspace.js";
import { definitionDigest, readAttempt, readRuntime, writeRuntime, type AttemptRecord } from "./runtime.js";
import { readSpec } from "./spec.js";
import { appendJournal, journalTail } from "./journal.js";
import { chainPosition, modelAt, modelChain, readModelRotation, rotateModel, type Handover, type ModelRole } from "./models.js";
import { startReview, type CriterionResult, type ReviewEvidence, type ReviewResult } from "./review.js";
import { checkRender, describeFailures, RenderUnavailableError, type RenderCheck } from "./render.js";

export const TURN_TIMEOUT_MS_DEFAULT = 30 * 60_000;
export const ACCEPTANCE_TIMEOUT_MS_DEFAULT = 10 * 60_000;
export const MAX_SESSIONS_PER_TASK_DEFAULT = 20;
export const MAX_TURNS_PER_SESSION_DEFAULT = 40;
export const MAX_REVIEW_ROUNDS_DEFAULT = 2;
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
  /** How many tasks the scheduler may run at once (default 2). */
  parallel?: number;
  /** Viewports a `verify: render` task must pass (default 1440x900 and 390x844). */
  renderViewports?: string[];
  /** Browser binary for render checks; auto-detected when absent. */
  chromeBin?: string;
};
export type WorkerStore = Pick<TaskStore, "list" | "setStatus" | "appendSession" | "incRetries" | "readDoneMarker" | "clearDoneMarker" | "incReviewRounds">;
export type WorkerDeps = {
  store: WorkerStore; adapter: AgentAdapter;
  acceptance?: (command: string, cwd: string) => Promise<AcceptanceResult>;
  /** Test seam: judge the evidence without starting an agent session. */
  review?: (evidence: ReviewEvidence) => Promise<ReviewResult>;
  onEvent?: (evt: WorkerEvent) => void;
};
export type WorkerEventType = "claimed" | "takeover" | "running" | "handoff" | "turn-failed" | "model-fallback" | "acceptance" | "acceptance-skipped" | "reviewing" | "reviewed" | "rework" | "awaiting-human" | "done" | "blocked" | "ownership-lost" | "escalated";
export type WorkerEvent = { type: WorkerEventType; taskId: string; detail?: string };
export type TaskOutcome = "done" | "blocked" | "skipped" | "open" | "awaiting-human";
export class WorkerTimeoutError extends Error {}
class UncertainExecutionError extends Error {}
class ReviewRequiredError extends Error {}

type Run = {
  cfg: WorkerConfig; deps: WorkerDeps; task: Task; owner: string; definition: string;
  record: AttemptRecord; lost: boolean; notifyLost: () => void; loss: Promise<void>;
  execution?: Execution<unknown>;
  /**
   * Set once the work outgrows the lane it was captured in. It never turns back
   * off for this attempt: an escalated run may not finish on its own evidence.
   */
  escalated: boolean;
};
const emit = (r: Run, type: WorkerEventType, detail?: string) => r.deps.onEvent?.({ type, taskId: r.task.id, detail });
const owned = <T>(r: Run, fn: () => Promise<T>) => withOwnership(r.cfg.tasksDir, r.task.id, r.owner, fn);

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

export async function runTask(cfg: WorkerConfig, deps: WorkerDeps, task: Task, workerId: string): Promise<TaskOutcome> {
  // Even callers reusing a worker label get a distinct fencing generation.
  const owner = `${workerId}:${randomUUID()}`;
  if (!await claim(cfg.tasksDir, task.id, owner, cfg.lockTtlMs)) return "skipped";
  let notifyLost!: () => void;
  const loss = new Promise<void>(resolve => { notifyLost = resolve; });
  const now = new Date().toISOString();
  const r: Run = { cfg, deps, task, owner, definition: definitionDigest(task), lost: false, notifyLost, loss, escalated: false,
    record: { attemptId: owner, backend: cfg.agent, workspace: cfg.workdir, startedAt: now, updatedAt: now, phase: "active", operation: "preparing" } };
  let reservation: WorkspaceReservation | null = null;
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
            r.record.pid = info.pid; r.record.sessionId = info.sessionId;
            await writeRuntime(cfg.tasksDir, task.id, "attempt.json", r.record);
          });
        }
        catch { r.lost = true; notifyLost(); }
        if (!stopping && !r.lost) tick();
      })();
    }, Math.max(1, Math.min(cfg.heartbeatMs, cfg.lockTtlMs / 3)));
  };
  try {
    // Re-read after claim: a queued snapshot is not authority to reopen a terminal task.
    const current = await owned(r, async () => (await deps.store.list()).find(t => t.id === task.id));
    if (!current || (current.status !== "open" && current.status !== "running")) return "skipped";
    r.task = structuredClone(current); r.definition = definitionDigest(current);
    const previous = await readAttempt(cfg.tasksDir, task.id);
    if ((previous && previous.phase !== "settled") || (!previous && current.status === "running")) {
      return await block(r, "interrupted execution requires operator reconciliation; not replayed");
    }
    reservation = await reserveWorkspace(cfg.workdir, owner);
    if (!reservation) return await block(r, "workspace reserved by another or uncertain execution; reconcile before retry");
    r.record.workspace = reservation.cwd;
    r.cfg = { ...cfg, workdir: reservation.cwd };
    emit(r, task.status === "running" ? "takeover" : "claimed");
    await owned(r, async () => {
      await writeRuntime(cfg.tasksDir, task.id, "attempt.json", r.record);
      await deps.store.clearDoneMarker(task.id); // do not consume a predecessor's completion request
      await deps.store.setStatus(task.id, "running");
      await appendJournal(cfg.tasksDir, task.id, { stage: "worker", event: "claimed", detail: reservation?.cwd ?? cfg.workdir });
    });
    tick(); emit(r, "running");
    const outcome = await loop(r);
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
    // Unexpected errors can occur after dispatch. Preserve active record/reservation.
    if (reservation) await checkpoint(r, "uncertain", r.record.operation, String(err)).catch(() => {});
    throw err;
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
  await owned(r, () => appendJournal(r.cfg.tasksDir, r.task.id, { stage: "worker", event: "escalated", detail: reason }));
  emit(r, "escalated", reason);
}

/** A cooperative legacy adapter can complete normally, but cannot prove cancellation. */
function legacyExecution<T>(fn: () => Promise<T>): Execution<T> {
  let state: "running" | "exited" = "running";
  const result = Promise.resolve().then(fn).finally(() => { state = "exited"; });
  return { result, inspect: () => ({ state }), cancel: async () => false };
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
  if (!await heartbeat(r.cfg.tasksDir, r.task.id, r.owner)) throw new OwnershipLostError();
  await checkpoint(r, "active", label);
  let execution: Execution<T> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Generation cannot be taken over between the ownership check and dispatch.
    await owned(r, async () => {
      execution = start();
      r.execution = execution;
      execution.result.catch(() => {});
      r.record.pid = execution.inspect().pid;
      r.record.sessionId = execution.inspect().sessionId;
      await writeRuntime(r.cfg.tasksDir, r.task.id, "attempt.json", r.record);
    });
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new WorkerTimeoutError(`${label} timed out after ${ms}ms`)), ms);
    });
    const lost = r.loss.then(() => { throw new OwnershipLostError(); });
    let settled = false;
    const tracked = execution!.result.then(
      (value) => { settled = true; return value; },
      (error) => { throw error; },
    );
    const value = await Promise.race([tracked, timeout, lost]);
    if (settled && acceptSettled?.(value) === true) return value;
    if (execution!.inspect().state !== "exited") throw new UncertainExecutionError(`${label}: execution termination is uncertain`);
    return value;
  } catch (err) {
    if (!execution) throw err;
    r.record.sessionId = execution.inspect().sessionId;
    if (!(err instanceof WorkerTimeoutError) && !(err instanceof OwnershipLostError) && !r.lost && execution.inspect().state === "exited") throw err;
    // Never wait indefinitely for a broken cancellation implementation.
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    try {
      stopped = await Promise.race([execution.cancel(), new Promise<false>(resolve => { stopTimer = setTimeout(() => resolve(false), 2_000); })]);
      stopped = stopped && execution.inspect().state === "exited";
    } catch { /* failed cancellation is uncertain */ }
    finally { if (stopTimer) clearTimeout(stopTimer); }
    if (err instanceof OwnershipLostError || r.lost) throw new OwnershipLostError();
    if (!stopped) throw new UncertainExecutionError(`${label}: shutdown unconfirmed; automatic retry prohibited`);
    throw err;
  } finally { r.execution = undefined; if (timer) clearTimeout(timer); }
}

/** The worker's chain: the task's own model (else the config default), then fallbacks. */
const workerChain = (r: Run): string[] => modelChain(r.task.model ?? r.cfg.model, r.cfg.modelFallbacks);
/** The reviewer's chain: its own model, then its fallbacks — never the task's silently. */
const reviewerChain = (r: Run): string[] => modelChain(r.cfg.reviewerModel, r.cfg.reviewerModelFallbacks);

/** The model a role should use now, per the rotation recorded for this task. */
async function modelFor(r: Run, role: ModelRole): Promise<string | undefined> {
  const chain = role === "worker" ? workerChain(r) : reviewerChain(r);
  const rotation = await readModelRotation(r.cfg.tasksDir, r.task.id);
  return modelAt(chain, chainPosition(chain, rotation[role]));
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
  let handover: Handover | null;
  try {
    handover = await owned(r, () => rotateModel(r.cfg.tasksDir, r.task.id, role, chain, reason));
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

/**
 * One agent turn. The declared return type is the union of "the backend
 * answered" and "we timed out", which is why `failure` has to be part of it:
 * both branches reach the caller's provider check.
 */
async function turn(r: Run, text: string, model: string | undefined, sessionId?: string): Promise<PromptResult & { timedOut: boolean }> {
  const args = { sessionId, text, model, effort: r.task.effort ?? r.cfg.effort, title: r.task.title, cwd: r.cfg.workdir };
  try {
    return { ...await controlled(r, "agent turn", r.cfg.turnTimeoutMs ?? TURN_TIMEOUT_MS_DEFAULT,
      () => r.deps.adapter.start ? r.deps.adapter.start(args) : legacyExecution(() => r.deps.adapter.prompt(args)),
      (result) => result.failure === "provider"), timedOut: false };
  } catch (err) {
    if (!(err instanceof WorkerTimeoutError)) throw err;
    // Only reached if cancellation was positively confirmed.
    await owned(r, () => r.deps.store.clearDoneMarker(r.task.id));
    return { sessionId: "", text: "", exitCode: -1, timedOut: true };
  }
}

async function loop(r: Run): Promise<"done" | "blocked" | "open" | "awaiting-human"> {
  let sessionId: string | undefined;
  let recordedSession = "", sessionsUsed = r.task.sessions.length, turns = 0;
  // A handover is progress only if the recording sticks. On a cached or syncing
  // filesystem the position can read back stale, and then every turn looks like
  // a successful handover with no retry ever spent. The chain bounds how many
  // legitimate handovers exist, so the loop is bounded by it too.
  const maxHandovers = workerChain(r).length;
  let handovers = 0;
  for (;;) {
    const note = await latestNote(r.cfg.tasksDir, r.task.id);
    const prompt = buildWorkerPrompt(r.task, { handoff: note?.markdown, workdir: r.cfg.workdir, tasksDir: r.cfg.tasksDir });
    const model = await modelFor(r, "worker");
    const result = await turn(r, prompt, model, sessionId);
    await owned(r, async () => {
      // A rejected turn did no work, and its session belongs to the backend that
      // refused it: recording it would both spend a session and hand the next
      // provider a transcript it never wrote.
      if (result.sessionId && result.failure !== "provider" && result.sessionId !== recordedSession) {
        await r.deps.store.appendSession(r.task.id, result.sessionId);
        recordedSession = sessionId = result.sessionId; sessionsUsed++;
      }
    });
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
      emit(r, "turn-failed", result.timedOut ? "turn timed out; shutdown confirmed" : `exit ${result.exitCode}`);
      const handedOver = handovers < maxHandovers && result.failure === "provider"
        && await fallBack(r, "worker", `turn rejected by ${model ?? "(default)"}`);
      // The next model must not be asked to continue a session created by
      // another backend. A handover is a session boundary.
      if (handedOver) { handovers++; fresh = true; }
      if (!handedOver && await fail(r)) return "blocked";
    } else if (await owned(r, () => r.deps.store.readDoneMarker(r.task.id))) {
      await owned(r, () => r.deps.store.clearDoneMarker(r.task.id));
      const verdict = await accept(r);
      if (verdict !== "retry") return verdict;
      fresh = true;
    } else if (turns >= (r.cfg.maxTurnsPerSession ?? MAX_TURNS_PER_SESSION_DEFAULT)) {
      // Running out of turns is evidence about the task, not just about the
      // session: whatever this was, it did not fit in one go.
      await escalate(r, "session turn budget exhausted");
      if (await fail(r)) return "blocked";
      fresh = true;
    } else if (await overBudget(r, sessionId, model)) {
      await escalate(r, "context budget exhausted; a session handoff was needed");
      const wrap = await turn(r, WRAP_UP_INSTRUCTION, model, sessionId);
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
 * True while the task still carries the definition this attempt started under.
 *
 * The status is part of the question: a human moving the task out from under a
 * running attempt is the same kind of change as an edit to its criteria, and it
 * must not be judged under rules the attempt never ran by.
 */
async function definitionIntact(r: Run, statuses: readonly Task["status"][]): Promise<boolean> {
  const current = await owned(r, async () => (await r.deps.store.list()).find((task) => task.id === r.task.id));
  return !!current && statuses.includes(current.status) && definitionDigest(current) === r.definition;
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

async function accept(r: Run): Promise<"done" | "blocked" | "retry" | "open" | "awaiting-human"> {
  // Which model produced the work is part of the evidence: after a handover it
  // is no longer the model the operator configured.
  const model = await modelFor(r, "worker");
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
    result = await controlled(r, "acceptance", r.cfg.acceptanceTimeoutMs ?? ACCEPTANCE_TIMEOUT_MS_DEFAULT,
      () => r.deps.acceptance ? legacyExecution(() => r.deps.acceptance!(command, r.cfg.workdir)) : startAcceptance(command, r.cfg.workdir));
  } catch (err) {
    if (!(err instanceof WorkerTimeoutError)) throw err;
    result = { passed: false, skipped: false, exitCode: null, output: err.message };
  }
  const artifactAfter = await artifactDigest(r.cfg.workdir, [r.cfg.tasksDir], r.cfg.artifactIgnore ?? []);
  // All controller writers use the same mutex as takeover for final validation/write.
  // The review runs outside this guard: it takes the same mutex for its own
  // writes, and nesting would deadlock the task against itself.
  const outcome = await owned(r, async (): Promise<"review" | "blocked" | "retry" | "done" | "awaiting-human"> => {
    const current = (await r.deps.store.list()).find(t => t.id === r.task.id);
    const definitionMatches = !!current && current.status === "running" && definitionDigest(current) === r.definition;
    const evidence = { attemptId: r.owner, definitionDigest: r.definition, artifactBefore, artifactAfter, command,
      startedAt, finishedAt: new Date().toISOString(), ...result, model, definitionMatches };
    await writeRuntime(r.cfg.tasksDir, r.task.id, "acceptance.json", evidence);
    if (!definitionMatches || artifactBefore !== artifactAfter || result.skipped) throw new ReviewRequiredError("acceptance evidence invalidated by definition/artifact drift or skipped check");
    emit(r, "acceptance", result.passed ? "passed" : `failed (exit ${result.exitCode ?? "null"})`);
    await appendJournal(r.cfg.tasksDir, r.task.id, {
      stage: "worker",
      event: "acceptance",
      detail: `${result.passed ? "passed" : "failed"} exit=${result.exitCode ?? "null"}`,
    });
    if (result.passed) {
      // The operator asked for the exit code to be the verdict, and it is: there is
      // nothing left for a reviewer to add. An escalated run loses this shortcut,
      // because escalation means the evidence stopped describing the work.
      if (r.task.verify === "mechanical" && !r.escalated) {
        return await finishVerified(r, "acceptance passed; verify=mechanical");
      }
      return "review";
    }
    const retries = await r.deps.store.incRetries(r.task.id);
    if (retries >= r.cfg.retryLimit) {
      await r.deps.store.setStatus(r.task.id, "blocked"); emit(r, "blocked", "retry limit reached"); return "blocked";
    }
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
  await owned(r, () => writeRuntime(r.cfg.tasksDir, id, "render.json", {
    ...check, model, definitionDigest: r.definition, escalated: r.escalated,
  }));
  if (check.ok) {
    emit(r, "acceptance", `render ok (${check.views.length} view(s))`);
    await owned(r, () => appendJournal(r.cfg.tasksDir, id, {
      stage: "worker",
      event: "acceptance",
      detail: `render ok views=${check.views.length}`,
    }));
    if (r.escalated) return "review";
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
 */
async function reviewStage(r: Run): Promise<"done" | "blocked" | "open" | "awaiting-human"> {
  const id = r.task.id;
  if (r.task.criteria.length === 0) {
    await owned(r, () => r.deps.store.setStatus(id, "awaiting-human"));
    emit(r, "awaiting-human", "no acceptance criteria to review");
    return "awaiting-human";
  }
  const acceptance = await readRuntime<Record<string, unknown>>(r.cfg.tasksDir, id, "acceptance.json");
  const evidence: ReviewEvidence = {
    task: r.task,
    spec: (await readSpec(r.cfg.tasksDir, id)) ?? "",
    acceptanceMarkdown: acceptance === null ? "" : renderAcceptance(acceptance),
    handoff: (await latestNote(r.cfg.tasksDir, id))?.markdown ?? null,
    journal: await journalTail(r.cfg.tasksDir, id, 30),
    window: { startedAt: r.record.startedAt, finishedAt: new Date().toISOString() },
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
  // idempotent (a spreadsheet write, a file move). The chain is finite, and the
  // loop is bounded by it explicitly rather than by trusting the read-back: a
  // position that keeps coming back stale would otherwise spin forever with no
  // retry spent.
  const maxHandovers = reviewerChain(r).length;
  let handovers = 0;
  for (;;) {
    const reviewerModel = await modelFor(r, "reviewer");
    const result = await controlled(r, "review", r.cfg.turnTimeoutMs ?? TURN_TIMEOUT_MS_DEFAULT, () =>
      r.deps.review
        ? legacyExecution(() => r.deps.review!(evidence))
        : startReview({
            adapter: r.deps.adapter,
            cwd: r.cfg.workdir,
            model: reviewerModel,
            effort: r.cfg.reviewerEffort,
            title: r.task.title,
          }, evidence),
      (review) => review.failure === "provider",
    );
    await owned(r, async () => {
      // Which model judged is part of the evidence: work passed by a fallback is
      // not the same claim as work passed by the model the operator chose. So is
      // the declaration that authorised any excused drift — a narrowed field
      // must not read as if the reviewer had been allowed what it now says.
      await writeRuntime(r.cfg.tasksDir, id, "review.json", {
        ...result,
        model: reviewerModel,
        tolerate: r.task.tolerate,
        definitionDigest: r.definition,
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
      // Checked again here: the pre-review check ran before this turn, and a task
      // file edited while the reviewer was reading would otherwise be completed —
      // or reopened for rework — under a definition the reviewer never saw.
      await requireUnchangedDefinition(r, ["review"], "the task definition changed during the review; refusing to act on the verdict");
      return await judge(r, result, prevCriteria);
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
    // No model left: spend an attempt and reopen. A full rerun is the only
    // remaining option, and the operator can raise the quota and call `retry`.
    if (await fail(r)) return "blocked";
    await owned(r, () => r.deps.store.setStatus(id, "open"));
    emit(r, "rework", "reviewer provider failure; retrying");
    return "open";
  }
}

/** Act on a verdict that actually judged the work. */
async function judge(
  r: Run,
  result: ReviewResult,
  prevCriteria: CriterionResult[] | null,
): Promise<"done" | "blocked" | "open" | "awaiting-human"> {
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
    await r.deps.store.setStatus(id, "open");
    await appendJournal(r.cfg.tasksDir, id, {
      stage: "review",
      event: "rework",
      detail: `round ${rounds}: ${result.defects.join("; ") || result.summary}`,
    });
  });
  emit(r, "rework", `round ${rounds}: ${result.defects.join("; ") || result.summary}`);
  return "open";
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
      const used = await r.deps.adapter.contextUsage(sessionId);
      const limit = await r.deps.adapter.contextLimit(model);
      return limit > 0 && used / limit >= r.cfg.contextThreshold;
    }));
    return usage;
  } catch (err) {
    if (err instanceof OwnershipLostError || err instanceof UncertainExecutionError) throw err;
    return false;
  }
}
function fallbackNote(task: Task, seq: number, text: string): HandoffNote {
  const summary = `任务 ${task.id}（${task.title}）上回合输出：${text}`.slice(0, 500);
  return { task: task.id, seq: seq + 1, status: "orchestrator-fallback", done: summary,
    found: "agent 未按收尾指令写 note；本笔记由编排器兜底生成", next: summary, files: [] };
}
