import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import { claim, heartbeat, lockLive, release, withOwnership, OwnershipLostError } from "./claim.js";
import { waitReason } from "./eligibility.js";
import { dependencySummary } from "./dependencies.js";
import { latestNote, writeNote, type HandoffNote } from "./handoff.js";
import { startAcceptance, type AcceptanceResult } from "./acceptance.js";
import { readContextSections, readFixedSources, sourcesDetail, type ContextSections } from "./context.js";
import { createMempalaceBackend, runRecall, type MemoryBackend, type MemorySettings } from "./memory.js";
import { callTools } from "./mcp-client.js";
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
import { chainPosition, readModelRotation, resetRotation, rotateModel, reviewerChain as configuredReviewerChain, taskChain, type Handover, type ModelRole } from "./models.js";
import { checkModels, noteReported, renderVerdicts, reviewerModels, workerModels, type ModelVerdict } from "./budget.js";
import { classifyDispatchFailure, quotaBackoffMs } from "./dispatch.js";
import { failureFingerprint } from "./fingerprint.js";
import { startReview, type CriterionResult, type ReviewEvidence, type ReviewResult } from "./review.js";
import { collectChangeEvidence } from "./changes.js";
import { checkRender, describeFailures, RenderUnavailableError, type RenderCheck } from "./render.js";
import { readExecutionState, recordEscalation, recordWorkerSession, type ExecutionState, type WorkerSessionFact } from "./execution-state.js";
import { clearModelCooldown, modelCooldown, nextModelCooldown, noteModelRefusal } from "./model-cooldown.js";
import { clearGuardRefusal, recordGuardRefusal } from "./guard-refusals.js";
import type { StopNow } from "./stop.js";
import {
  DEFAULT_MODEL_KEY, addRefusal, chainKeys, clearModelWait, coolingRefusals, formatDuration, mergeRefusals, modelCooldownMsOf, modelKey, modelRoundsOf,
  modelWaitHolds, processRun, readModelWait, refusalReason, servedSince, writeModelWait, modelWaitHold,
  type ModelRefusal, type ModelWaitRecord, type ModelWaitStage, type RunContext,
} from "./model-wait.js";
import { withMutex } from "./mutex.js";
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
   * The configuration file this run was started with, as the command line named
   * it. It is the controller's input, not an artifact of the work, so the
   * artifact digest leaves it out when it lies in the work directory (see
   * `digestExclusions`).
   */
  configPath?: string;
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
   * so a round ends only when the whole cycle has refused.
   */
  chainCycles?: number;
  /** Shared re-probe window for a provider/model refusal (default 60 seconds). */
  modelCooldownMs?: number;
  /**
   * Rounds of one run a task may be refused by every model before the run
   * decides between the task's own problem and an outage (default 4, see
   * `src/model-wait.ts`). A round is one pass over the chain.
   */
  modelRounds?: number;
  /** The run these attempts belong to: it counts a deferral's rounds and remembers every accepted turn. */
  run?: RunContext;
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
  /**
   * Files holding the owner's own rules (how text is to be written, what must
   * never happen), read by path for every attempt and given to the worker as
   * they stand: never searched for, never ranked. Absent or empty means off.
   * Resolved from the `fixedSources` list of `taskctl.json`.
   */
  fixedSources?: string[];
  /**
   * Memory recall for an attempt: the settings with the backend switch.
   * Absent, or a backend of `none`, means off — no recall, no record, no
   * journal line, no child process. Resolved from the `memory` block of
   * `taskctl.json`.
   */
  memory?: MemorySettings;
  /**
   * The budget guard's policy, each key optional and absent by default. With
   * all four absent only a model the backend reports as free may run, so a
   * config written before the keys existed means exactly that. What each key
   * allows is in `src/budget.ts`.
   */
  allowedProviders?: string[];
  allowedModels?: string[];
  allowPaidModels?: boolean;
  maxCostPerMillion?: number;
};
export type WorkerStore = Pick<TaskStore, "list" | "setStatus" | "appendSession" | "incRetries" | "readDoneMarker" | "clearDoneMarker" | "incReviewRounds">;
export type WorkerDeps = {
  store: WorkerStore; adapter: AgentAdapter;
  acceptance?: (command: string, cwd: string) => Promise<AcceptanceResult>;
  /** Test seam: judge the evidence without starting an agent session. */
  review?: (evidence: ReviewEvidence) => Promise<ReviewResult>;
  /** Test seam: what answers instead of the MemPalace server; production leaves it absent. */
  memory?: MemoryBackend;
  onEvent?: (evt: WorkerEvent) => void;
  /** The controller's interrupt source. Absent when nothing can stop this worker. */
  stop?: StopNow;
};
/**
 * `refused` is reported once per process for a task and the reason it was
 * refused, which is what its detail holds (the guard's verdicts): the same
 * verdicts at a later offer say nothing new, other verdicts are news.
 */
export type WorkerEventType = "claimed" | "takeover" | "running" | "handoff" | "turn-failed" | "model-fallback" | "model-deferred" | "model-wait" | "acceptance" | "acceptance-skipped" | "reviewing" | "reviewed" | "rework" | "awaiting-human" | "done" | "blocked" | "ownership-lost" | "escalated" | "controller-error" | "refused" | "outage" | "stopped" | "stop-unconfirmed" | "stop-requested";
export type WorkerEvent = { type: WorkerEventType; taskId: string; detail?: string };
/**
 * `refused`: the budget guard said no, so no model session started and no
 * attempt record was written — that is what a refusal guarantees, whichever
 * of its two paths refused. The task stays as the board has it (`open`, and
 * unclaimed once the attempt has returned), so it is neither progress nor a
 * reason to wait for a human; it needs no recovery.
 *
 * `runTask` judges twice, and only the first refusal writes nothing at all.
 * Before the claim, on the snapshot the caller passed: nothing is claimed
 * and nothing written. Right after the workspace is reserved, on the task as
 * the board then holds it: the claim's lock record and the reservation were
 * written and are released again — and the `execution-state-invalid` line
 * stays, on the rare task whose execution state could not be read.
 *
 * `stopped`: the attempt was interrupted by the operator, nothing was judged,
 * the task can run again at once. It never meets `refused`: a refusal comes
 * before anything there is to interrupt, whatever the stop.
 */
export type TaskOutcome = "done" | "blocked" | "skipped" | "open" | "awaiting-human" | "refused" | "stopped";
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
/** A record that can anchor a review-only recovery: both digests are strings. */
const validPending = (record: ReviewPendingRecord | null): record is ReviewPendingRecord =>
  record !== null && typeof record.definitionDigest === "string" && typeof record.artifactDigest === "string";
export class WorkerTimeoutError extends Error {
  constructor(message: string, readonly partialOutput?: string) { super(message); }
}
class UncertainExecutionError extends Error {}
class ReviewRequiredError extends Error {}
class ModelsCoolingError extends Error {
  constructor(readonly retryAfter: string) { super(`every model is cooling until at least ${retryAfter}`); }
}
/** The operator's stop was observed. `inFlight` says whether something was running under the attempt when it was. */
class OperatorStoppedError extends Error {
  constructor(readonly label: string, readonly inFlight: boolean) { super(`stopped by the operator ${inFlight ? "during" : "after"} ${label}`); }
}
/** A stop whose cancellation could not be confirmed: as uncertain as any other unconfirmed shutdown. */
class UnconfirmedStopError extends UncertainExecutionError {}
/** Sentinel the stop race resolves with; carries nothing. */
class StopObserved {}

/**
 * Sentinel the render check's stop race resolves with (D4): the check is not a
 * cancellable execution, so the stop does not cancel it — it only ends the
 * wait, lets the check run to its own bounded end, and sees to it that nothing
 * it saw is judged.
 */
class StopObservedDuringRenderCheck {}
const STOP = new StopObservedDuringRenderCheck();

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
  /** The run these attempts belong to: it counts a deferral's rounds and remembers every accepted turn. */
  run: RunContext;
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

/**
 * Take the decision an attempt that ran out of rounds leaves open (spec §6,
 * step 5), for the tasks a controller just got back deferred. With another
 * task served on the chain since the task's first refusal, the task alone is
 * held; otherwise it is an outage, and the first one ends the list. Called
 * only once no attempt is in flight, so every turn that was running has been
 * counted.
 */
export async function settleExhausted(
  cfg: WorkerConfig, deps: WorkerDeps, board: readonly Task[], deferred: readonly string[], now = new Date(),
): Promise<{ held: string[]; outage?: { taskId: string } }> {
  const run = cfg.run ?? processRun();
  const holds = await modelWaitHolds({ tasksDir: cfg.tasksDir, run, modelRounds: modelRoundsOf(cfg) }, deferred, now);
  const held: string[] = [];
  for (const id of deferred) {
    const hold = holds.get(id);
    const task = board.find((candidate) => candidate.id === id);
    if (hold?.kind !== "exhausted" || task === undefined || task.status !== "open") continue;
    const record = await readModelWait(cfg.tasksDir, id);
    if (record === null) continue;
    // The run's evidence decides: did any task get a turn accepted on the
    // chain that refused, after this task's first refusal?
    const chain = chainKeys(record.stage === "review" ? configuredReviewerChain(cfg, task) : taskChain(cfg, task));
    const since = Date.parse(record.firstRefusedAt ?? record.updatedAt);
    const served = servedSince(run, chain, since);
    if (served !== null) {
      await holdForRefusal(cfg, deps, task, record, served);
      held.push(id);
      continue;
    }
    const said = record.refusals.map((refusal) => `${refusal.model}: ${refusal.reason}`).join(" | ");
    await withMutex(join(cfg.tasksDir, id, ".mutation.lock"), () => appendJournal(cfg.tasksDir, id, {
      stage: record.stage, event: "model-outage",
      detail: `rounds ${hold.rounds}/${modelRoundsOf(cfg)} over ${formatDuration(now.getTime() - since)} since ${record.firstRefusedAt}; no task served on the chain; ${said}`,
    }));
    deps.onEvent?.({
      type: "outage", taskId: id,
      detail: `every model refused in ${hold.rounds} round(s) and no task was served on the chain; the run stops — nothing is blocked, every waiting task can be run again`,
    });
    return { held, outage: { taskId: id } };
  }
  return { held };
}

/** Stop for a human: every model refused this task while another was served. The task itself is the problem. */
async function holdForRefusal(
  cfg: WorkerConfig, deps: WorkerDeps, task: Task, record: ModelWaitRecord, served: string,
): Promise<void> {
  const rounds = record.rounds;
  if (record.stage === "review") {
    // The review deferral preserved the worker's and the acceptance's evidence,
    // so the controller's half is only the journal line and the status: the
    // next claim resumes the review on it (spec 2026-11-25 §16).
    await parkReviewFromRecord(cfg, deps, task, record, `own problem: refused in ${rounds} round(s) while ${served} served another task`);
    return;
  }
  await withMutex(join(cfg.tasksDir, task.id, ".mutation.lock"), async () => {
    const seq = ((await latestNote(cfg.tasksDir, task.id))?.seq ?? 0) + 1;
    await writeNote(cfg.tasksDir, {
      task: task.id, seq, status: "blocked:needs-owner",
      done: `模型拒绝：本任务在本次执行里连续 ${rounds} 轮被链上所有模型拒绝，期间其他任务在 ${served} 上成功过——模型可用，问题在本任务自身。未消耗 retries。`,
      found: ["每个模型的拒绝原话：", ...record.refusals.map((refusal) => `- ${refusal.model}: ${refusal.reason}`)].join("\n"),
      next: "逐条看上面的拒绝原话（常见：输入过长、内容被拒、该模型不支持这份任务）；修改任务定义或为它单独指定 model 后 taskctl retry。依赖它的任务会一直等，其余任务不受影响。",
      files: [],
    });
    await appendJournal(cfg.tasksDir, task.id, {
      stage: record.stage, event: "blocked",
      detail: `refused by every model in ${rounds} round(s) while ${served} served another task; retries untouched`,
    });
    await deps.store.setStatus(task.id, "blocked");
  });
  deps.onEvent?.({
    type: "blocked", taskId: task.id,
    detail: `every model refused this task in ${rounds} round(s) while ${served} served another task; retries untouched — the task itself is the problem`,
  });
}

/**
 * The controller's half of the park (`holdForRefusal`, review stage): the
 * preserved evidence was written at the deferral, so only the journal line and
 * the status are written here. No note and no record rewrite — the preserved
 * `review-pending.json` is what the next claim reads.
 */
async function parkReviewFromRecord(
  cfg: WorkerConfig, deps: WorkerDeps, task: Task, record: ModelWaitRecord, verdict: string,
): Promise<"blocked"> {
  const last = record.refusals.at(-1) ?? { model: DEFAULT_MODEL_KEY, reason: "review provider rejected the turn" };
  await withMutex(join(cfg.tasksDir, task.id, ".mutation.lock"), () => appendJournal(cfg.tasksDir, task.id, {
    stage: "review", event: "review-pending",
    detail: `${last.model}: ${last.reason}; worker/acceptance preserved; ${verdict}`,
  }));
  await deps.store.setStatus(task.id, "blocked");
  deps.onEvent?.({
    type: "blocked", taskId: task.id,
    detail: "review pending: reviewer providers unavailable; worker and acceptance preserved; retry with --review-only",
  });
  return "blocked";
}

/**
 * Report a refusal, once per process for a task and the reason it was refused.
 *
 * The key is the guard's verdict lines, not only the models they name: a task
 * first refused because the catalogue could not be read is reported again when
 * the same models are later refused as paid, while the same verdicts at every
 * wake of a queue are said once.
 *
 * The board-level record is written at every judgement, with its time; only
 * the line is said once.
 */
async function reportRefusal(tasksDir: string, deps: WorkerDeps, taskId: string, refused: readonly ModelVerdict[]): Promise<void> {
  const detail = renderVerdicts(refused);
  await recordGuardRefusal(tasksDir, taskId, detail);
  if (noteReported(taskId, [detail])) deps.onEvent?.({ type: "refused", taskId, detail });
}

export async function runTask(
  cfg: WorkerConfig, deps: WorkerDeps, task: Task, workerId: string, options: RunTaskOptions = {},
): Promise<TaskOutcome> {
  // Even callers reusing a worker label get a distinct fencing generation.
  const owner = `${workerId}:${randomUUID()}`;
  // Once an interrupt is pending nothing is started for the task, the guard's
  // read of the catalogue included (D11).
  if (deps.stop !== undefined && (deps.stop.isRequested() || await deps.stop.check())) return "skipped";
  // The budget guard, before anything is claimed: every model this attempt
  // may run on is judged first, and a refusal here leaves the task `open`,
  // with nothing written into its directory and no session started. A
  // review-only recovery runs the reviewer alone, so the worker's models are
  // not judged. This is the snapshot the caller passed; the task is judged
  // again below, as the board holds it once the claim has been made, where a
  // refusal comes after the claim was written and releases it.
  const refused = await checkModels(cfg, deps.adapter, options.reviewOnly
    ? { reviewer: reviewerModels(cfg, task) }
    : { worker: workerModels(cfg, task), reviewer: reviewerModels(cfg, task) });
  if (refused.length > 0) {
    await reportRefusal(cfg.tasksDir, deps, task.id, refused);
    return "refused";
  }
  // An interrupt that arrived while the guard judged is seen here, and nothing
  // is claimed.
  if (deps.stop !== undefined && (deps.stop.isRequested() || await deps.stop.check())) return "skipped";
  if (!await claim(cfg.tasksDir, task.id, owner, cfg.lockTtlMs)) return "skipped";
  let notifyLost!: () => void;
  const loss = new Promise<void>(resolve => { notifyLost = resolve; });
  const now = new Date().toISOString();
  const r: Run = { cfg, deps, task, owner, definition: definitionDigest(task), lost: false, notifyLost, loss, escalated: false, reviewOnly: options.reviewOnly === true, batch: options.batch, previousSettled: false, sweepSkipNoted: false, budgetUnavailableNoted: false, heartbeatWriteFailureNoted: false,
    run: cfg.run ?? processRun(),
    record: { attemptId: owner, backend: cfg.agent, workspace: cfg.workdir, startedAt: now, updatedAt: now, phase: "active", operation: "preparing", turnTimeoutMs: cfg.turnTimeoutMs ?? TURN_TIMEOUT_MS_DEFAULT } };
  let reservation: WorkspaceReservation | null = null;
  let releaseStop: (() => void) | undefined;
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
    // A deferral holds the task exactly as an unfinished dependency does, and
    // a task whose rounds this run already spent waits for the controller's decision.
    const hold = modelWaitHold(await readModelWait(cfg.tasksDir, task.id), r.run.id, modelRoundsOf(cfg), new Date());
    if (hold !== null) return "skipped";
    // A task that carries preserved worker/acceptance evidence never goes back
    // through the worker: the claim resumes its review (spec 2026-11-25 §16).
    if (!r.reviewOnly && current.status === "open" && validPending(await readRuntime<ReviewPendingRecord>(cfg.tasksDir, task.id, "review-pending.json"))) {
      r.reviewOnly = true;
    }
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
      if (!validPending(reviewPending)) {
        return await block(r, "review-only recovery requires a valid review-pending record");
      }
    } else if ((previous && previous.phase !== "settled") || (!previous && current.status === "running")) {
      return await block(r, "interrupted execution requires operator reconciliation; not replayed");
    }
    reservation = await reserveWorkspace(cfg.workdir, owner);
    if (!reservation) return await block(r, "workspace reserved by another or uncertain execution; reconcile before retry");
    r.record.workspace = reservation.cwd;
    r.cfg = { ...cfg, workdir: reservation.cwd };
    // Judged again, on what this attempt will really run. The first guard took
    // the snapshot the caller passed, and the task was re-read after the claim
    // (`r.task`): a `model:` edited onto it in between must not run unjudged.
    // The catalogue is remembered, so wherever the first guard could read it
    // this is a second judgement, not a second call; and it is read in the
    // directory the session starts in. No session has started and no attempt
    // record exists yet: so far this attempt has written the claim's lock
    // record and the workspace reservation, and nothing more unless the
    // execution state could not be read above.
    const refusedHere = await checkModels(r.cfg, deps.adapter, r.reviewOnly
      ? { reviewer: reviewerModels(r.cfg, r.task) }
      : { worker: workerModels(r.cfg, r.task), reviewer: reviewerModels(r.cfg, r.task) });
    if (refusedHere.length > 0) {
      await reportRefusal(cfg.tasksDir, deps, r.task.id, refusedHere);
      // On this path the claim's lock record was written (`claim`, above) and
      // is released again by the `finally`. The workspace reservation is given
      // back here: the `finally` releases only the reservation of a record
      // that settled, and no record was written for this attempt. The task is
      // left exactly as the board holds it. Unlike a refusal before the claim,
      // this one is not "nothing was written": the two above were written and
      // released again, and the `execution-state-invalid` line stays when the
      // execution state could not be read. No session started.
      await reservation.release();
      return "refused";
    }
    emit(r, task.status === "running" ? "takeover" : "claimed");
    await owned(r, async () => {
      await clearGuardRefusal(cfg.tasksDir, task.id); // offered again and judged allowed at both judgements: the entry leaves
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
    // While the attempt runs, this controller watches the board for an interrupt.
    releaseStop = deps.stop?.hold();
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
    if (err instanceof UnconfirmedStopError) {
      await checkpoint(r, "uncertain", r.record.operation, err.message);
      await owned(r, () => appendJournal(cfg.tasksDir, task.id, {
        stage: "worker", event: "stop-unconfirmed",
        detail: `${r.record.operation}; cancellation not confirmed; attempt uncertain; reconcile before retry`,
      })).catch(() => {});
      emit(r, "stop-unconfirmed", `${r.record.operation}; cancellation unconfirmed; attempt uncertain; reconcile before retry`);
      return await block(r, err.message);
    }
    if (err instanceof OperatorStoppedError) {
      return await stopAttempt(r, err.label, err.inFlight);
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
    releaseStop?.();
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

/**
 * Settle an attempt the operator stopped: nothing was judged, no retry is
 * spent, and the task can run again at once. The session a cut turn ran on is
 * marked dirty (D9), a completion request from the cut turn is cleared, and
 * what the turn had already written stays where it wrote it.
 */
async function stopAttempt(r: Run, label: string, inFlight: boolean): Promise<"stopped"> {
  // Settled first: a crash after this line leaves the ordinary "settled,
  // status still running" case, which a takeover handles.
  await checkpoint(r, "settled", label, "stopped by operator");
  // The status the attempt was claimed from (`r.task` is the copy taken before
  // the claim set the task `running`): `blocked` only for an explicit
  // `retry --review-only` recovery, `open` for everything else (D3).
  const back = r.task.status === "blocked" ? "blocked" : "open";
  await owned(r, async () => {
    // The session the attempt recorded is the one that was cut (the stop branch
    // in `controlled` copies the live execution's session id into `r.record`
    // first); the model it ran on is kept. `r.record.sessionId` can in one case
    // name the attempt's previous session: a fresh session whose id the backend
    // had not announced yet when it was cut. Dirtying that one is the
    // conservative direction — it had already been left behind by a handoff,
    // and the session that was cut must not be resumed either.
    if (label === "agent turn" && inFlight && r.record.sessionId !== undefined) {
      const model = r.executionState?.latestWorker?.model;
      r.executionState = await recordWorkerSession(r.cfg.tasksDir, r.task.id, {
        sessionId: r.record.sessionId, clean: false, ...(model === undefined ? {} : { model }),
      }, declaredExecution(r.task));
    }
    await r.deps.store.clearDoneMarker(r.task.id);
    await r.deps.store.setStatus(r.task.id, back);
    await appendJournal(r.cfg.tasksDir, r.task.id, {
      stage: "worker", event: "stopped",
      detail: `operator stop ${inFlight ? "during" : "after"} ${label}; ${inFlight ? "cancellation confirmed; " : "nothing was interrupted; "}task returned to ${back}; retries untouched`,
    });
  });
  emit(r, "stopped", `${label}; ${inFlight ? "cancellation confirmed" : "nothing was interrupted"}; task returned to ${back}; retries untouched`);
  return "stopped";
}

/** Nothing new is dispatched once a stop was observed: the next step settles the attempt instead. */
function assertNotStopped(r: Run): void {
  if (r.deps.stop?.isRequested()) throw new OperatorStoppedError(r.record.operation, false);
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
  return { result, inspect: () => ({ state }), cancel: async () => false, interruptible: false };
}

/**
 * Cancel an execution and wait for its exit, bounded by the cancel deadline.
 * `true` only when the execution itself reports that it has exited: an end
 * nobody can confirm is `false`.
 */
async function confirmedCancel(execution: Execution<unknown>): Promise<boolean> {
  let stopTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  try {
    stopped = await Promise.race([execution.cancel(), new Promise<false>(resolve => { stopTimer = setTimeout(() => resolve(false), CANCEL_DEADLINE_MS); })]);
    stopped = stopped && execution.inspect().state === "exited";
  } catch { /* failed cancellation is uncertain */ }
  finally { if (stopTimer) clearTimeout(stopTimer); }
  return stopped;
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
  // Nothing new is dispatched after a stop: the attempt settles instead.
  assertNotStopped(r);
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
    // A cooperative execution is never raced against the stop: it finishes on
    // its own, and the next `controlled` throws. Only an interruptible one
    // watches the source.
    const stopRace = execution!.interruptible === false || r.deps.stop === undefined
      ? new Promise<never>(() => {})
      : r.deps.stop.observed.then(() => new StopObserved());
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
    const value = await Promise.race([tracked, timeout, lost, stopRace]);
    if (value instanceof StopObserved) {
      // It ended by itself in the same tick: nothing is running and nothing has to be cancelled.
      if (execution!.inspect().state === "exited") throw new OperatorStoppedError(label, false);
      const sessionId = execution!.inspect().sessionId;
      if (sessionId !== undefined) r.record.sessionId = sessionId;
      const stopped = await confirmedCancel(execution!);
      if (r.lost) throw new OwnershipLostError();
      if (!stopped) throw new UnconfirmedStopError(`${label}: stopped by the operator, but its end could not be confirmed; automatic retry prohibited`);
      throw new OperatorStoppedError(label, true);
    }
    if (settled && acceptSettled?.(value) === true) return value;
    if (execution!.inspect().state !== "exited") throw new UncertainExecutionError(`${label}: execution termination is uncertain`);
    return value;
  } catch (err) {
    if (!execution) throw err;
    const observedSessionId = execution.inspect().sessionId;
      if (observedSessionId !== undefined) r.record.sessionId = observedSessionId;
    // The stop branch already cancelled: rethrow, or this catch would run its
    // bounded cancel a second time and replace the error with a fresh
    // UncertainExecutionError, so `runTask`'s stop branch is never reached.
    if (err instanceof UnconfirmedStopError) throw err;
    if (!(err instanceof WorkerTimeoutError) && !(err instanceof OwnershipLostError) && !r.lost && execution.inspect().state === "exited") throw err;
    // Never wait indefinitely for a broken cancellation implementation. The
    // bound fits a real one: the backend stop (4s cap) runs beside the tree
    // kill (1.5s cap) and the exit confirmation (0.5s cap). It was 2s until
    // 2026-11-23, which left no room for asking the service to stop its
    // session - so every timed-out turn was "unconfirmed" and parked the task.
    const stopped = await confirmedCancel(execution);
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

/** The worker's chain, the one definition of it: the task's own model (else the configured chain), then fallbacks. See `taskChain`. */
const workerChain = (r: Run): string[] => taskChain(r.cfg, r.task);
/** The reviewer's chain for this attempt: the one definition of it (`reviewerChain` in `./models.ts`), which the budget guard judges too. */
const reviewerChain = (r: Run): string[] => configuredReviewerChain(r.cfg, r.task);

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
    throw new ModelsCoolingError(next?.retryAfter ?? new Date(Date.now() + modelCooldownMsOf(r.cfg)).toISOString());
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
 * this stays bounded; running out of models ends the round with a deferral.
 *
 * A handover that cannot be recorded is not a handover: the position is what
 * survives into the retry, and claiming success without it would send the next
 * turn straight back to the model that just refused. It reports `false`
 * instead, so the round ends with a deferral — never an exception out of a task
 * that had already settled its turn.
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
    // A stop must not be journaled as an unavailable telemetry call.
    if (error instanceof OperatorStoppedError) throw error;
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
    cooldownMs: modelCooldownMsOf(r.cfg),
  });
}

/** Note one refused turn — the shared table and this round's list — and say whether it was about allowance. */
async function noteTurnRefusal(
  r: Run, refusals: readonly ModelRefusal[], model: string | undefined, result: PromptResult & { durationMs: number },
): Promise<{ refusals: ModelRefusal[]; quota: boolean }> {
  const kind = classifyDispatchFailure({ failure: result.failure, exitCode: result.exitCode,
    durationMs: result.durationMs, tokens: result.tokens, output: result.text ?? "" });
  await noteRefusal(r, model, result, kind === "quota" ? "quota" : "provider");
  return {
    refusals: addRefusal(refusals, {
      model: modelKey(model), at: new Date().toISOString(), reason: refusalReason(result), source: "turn",
    }),
    quota: kind === "quota",
  };
}

/**
 * The round ended without one model accepting: end the attempt here with a
 * deferral. `refused` says whether this task itself was refused in the round.
 * `earliest` is the `retryAfter` of the `ModelsCoolingError` when it was not:
 * the earliest expiry among the chain's windows, and then the next time.
 * The attempt never decides between the task's own problem and an outage. A
 * task whose rounds are spent is only recorded; the controller decides once
 * nothing is in flight (Task 5).
 */
async function refusedRound(
  r: Run, stage: ModelWaitStage, refusals: readonly ModelRefusal[], refused: boolean, earliest?: string,
): Promise<"open"> {
  const now = new Date();
  const previous = await readModelWait(r.cfg.tasksDir, r.task.id);
  // Rounds are counted within one run and one stage. A pass in which this task
  // itself was refused is a round; one where every model was already cooling is not.
  const earlier = previous !== null && previous.runId === r.run.id && previous.stage === stage ? previous : null;
  const rounds = (earlier?.rounds ?? 0) + (refused ? 1 : 0);
  // The round's earliest refusal, not the first-tried model's latest one: a wrap can
  // refuse a model twice, and `addRefusal` replaces its entry in place, so the head
  // of the list can carry a later time than an earlier refusal of the same round.
  const firstRefusedAt = earlier?.firstRefusedAt ?? (refused
    ? refusals.map((entry) => entry.at).reduce((a, b) => (a < b ? a : b), refusals[0]?.at ?? now.toISOString())
    : null);
  const record: ModelWaitRecord = {
    runId: r.run.id, stage, rounds, firstRefusedAt, refusals: [...refusals],
    nextAt: refused || earliest === undefined ? new Date(now.getTime() + modelCooldownMsOf(r.cfg)).toISOString() : earliest,
    updatedAt: now.toISOString(),
  };
  const said = refusals.map((refusal) => `${refusal.model}: ${refusal.reason}`).join(" | ");
  // A refused review round preserves the worker's and the acceptance's evidence
  // beside the deferral record, so the next claim can resume only the review.
  const preserved = stage === "review" ? await reviewPendingRecord(r, refusals.map(({ model, reason }) => ({ model, reason }))) : null;
  await owned(r, async () => {
    if (preserved !== null) await writeRuntime(r.cfg.tasksDir, r.task.id, "review-pending.json", preserved);
    await writeModelWait(r.cfg.tasksDir, r.task.id, record);
    await r.deps.store.setStatus(r.task.id, "open");
    await appendJournal(r.cfg.tasksDir, r.task.id, {
      stage, event: "model-deferred", detail: `round ${rounds}/${modelRoundsOf(r.cfg)}; next ${record.nextAt}; ${said}`,
    });
  });
  emit(r, "model-deferred", `every model refused or cooling; round ${rounds}/${modelRoundsOf(r.cfg)}; next ${record.nextAt}; retries untouched`);
  return "open";
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

/**
 * The context sections one attempt was given: what `readContextSections`
 * reads from disk, the fixed sources read by file, and — when memory is on —
 * what recall found, as the lines the prompt shows. An absent `memory` is no
 * memory section, and an absent `fixedSources` is no fixed-sources section.
 */
export type WorkerContext = ContextSections & { fixedSources?: string; memory?: string };

/**
 * The context sections of this attempt, read once for the whole attempt: a
 * session of many turns does not read three files, or ask the memory backend,
 * on every one of them, and the journal says `profile-truncated` once, not
 * once per turn.
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
 *
 * Memory recall is the last of these steps, and only when a backend is named.
 * It is not a `controlled` step: `runRecall` bounds itself by its own
 * deadline, ends its own child and never throws, so nothing here can park the
 * task. A memory that cannot be reached costs the attempt its memory section
 * — never `blocked` — and leaves its reason in the record and the journal.
 *
 * The fixed sources sit between the two, and only when some are named. They
 * are read by file, whatever the `workerContext` switches say: they are the
 * owner's own rules, not this task's context. `readFixedSources` never
 * throws — a file that is missing or cannot be read is a state, not an error
 * — so the one line this adds to the journal is always written, all files
 * missing included: a rule the owner counts on not reaching the worker is
 * worth a record.
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
    if (r.cfg.fixedSources !== undefined && r.cfg.fixedSources.length > 0) {
      const { text, files } = await readFixedSources(r.cfg.fixedSources);
      await noteContext(r, "sources", sourcesDetail(files));
      // Nothing was read, not even a clipped file: then there is no section to give.
      if (text !== undefined) sections.fixedSources = text;
    }
    // Recall is off until a backend is named. What it finds is the last
    // section, and what was read before it is already in hand: the step sits
    // inside this guard like the reads above it.
    if (r.cfg.memory?.backend === "mempalace") {
      // The recall is not interrupted (D12), only announced while it lasts:
      // it bounds itself, ends its own server, and the loop's first check
      // settles the attempt once it has ended.
      let recalling = true;
      void r.deps.stop?.observed.then(() => {
        if (recalling) emit(r, "stop-requested", "memory recall in progress; it ends before anything else is asked of the worker (bounded by memory.timeoutMs)");
      });
      const memory = await runRecall(
        r.cfg.memory,
        // The server is kept out of the console's Ctrl-C only for an attempt
        // that can be stopped (D6); `taskctl recall` keeps today's spawn.
        r.deps.memory ?? createMempalaceBackend(r.cfg.memory, callTools, r.deps.stop !== undefined),
        {
          title: r.task.title, description: r.task.description,
          // Read again, and whole: the query wants the spec's goal, which the
          // clipped section may have lost with the middle.
          spec: (await readSpec(r.cfg.tasksDir, r.task.id)) ?? null,
          at: new Date().toISOString(),
        },
        {
          // Through the ownership guard, like every other write of the attempt.
          write: (record) => owned(r, () => writeRuntime(r.cfg.tasksDir, r.task.id, "recall.json", record)),
          journal: (event, detail) => owned(r, () => appendJournal(r.cfg.tasksDir, r.task.id, { stage: "worker", event, detail })),
        },
      );
      // The wait is over: a stop observed from here on is the loop's own news.
      recalling = false;
      // `null` is every other outcome: nothing kept, or the backend could not answer.
      if (memory !== null) sections.memory = memory;
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
  let refusals: ModelRefusal[] = [];
  // Every round is one pass over the chain: it starts at the head, with a fresh wrap budget.
  await resetRotation(r.cfg.tasksDir, r.task.id, "worker");
  let restoreSession = true;
  // Dependencies are done before the claim and cannot change under it, so
  // their summary is read once for the whole attempt, not once per turn.
  const dependencies = await dependenciesOf(r);
  // The same holds for the context sections: read once, not once per turn.
  const context = await contextOf(r);
  for (;;) {
    // Nothing new is dispatched once a stop was observed: the attempt settles instead.
    assertNotStopped(r);
    const note = await latestNote(r.cfg.tasksDir, r.task.id);
    const protocol = buildWorkerPrompt(r.task, {
      handoff: note?.markdown, workdir: r.cfg.workdir, tasksDir: r.cfg.tasksDir,
      taskDir: taskDirOf(r.cfg.tasksDir, r.task.id), logDir: logDirOf(r.cfg.tasksDir, r.task.id),
      ...(dependencies === null ? {} : { dependencies }),
      ...(context.spec === undefined ? {} : { spec: context.spec }),
      ...(context.profile === undefined ? {} : { profile: context.profile }),
      ...(context.feedback === undefined ? {} : { feedback: context.feedback }),
      ...(context.fixedSources === undefined ? {} : { fixedSources: context.fixedSources }),
      ...(context.memory === undefined ? {} : { memory: context.memory }),
    });
    const prompt = r.batch === undefined ? protocol : `${r.batch.preamble}${protocol}`;
    let model: string | undefined;
    try {
      model = await modelFor(r, "worker");
    } catch (error) {
      if (!(error instanceof ModelsCoolingError)) throw error;
      // Nothing could be tried: every model is cooling on a refusal. The task
      // waits for the earliest window; only a round in which it was refused itself counts.
      const cooling = await coolingRefusals(r.cfg.tasksDir, workerChain(r));
      return await refusedRound(r, "worker", mergeRefusals(refusals, cooling), refusals.length > 0, error.retryAfter);
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
    // A stop observed during the telemetry call costs no retry, no escalation
    // and no `turn-failed` line: the session is not recorded, the turn is not
    // accounted, and the attempt settles instead.
    assertNotStopped(r);
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
    if (result.exitCode === 0) {
      // An accepted turn is the run's evidence that this model works, and it ends any deferral.
      r.run.accepted.set(modelKey(model), Date.now());
      await clearModelWait(r.cfg.tasksDir, r.task.id);
      if (model !== undefined) await clearModelCooldown(r.cfg.tasksDir, model);
    }
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
      if (result.failure === "provider") {
        // A refusal — quota or not, before or after work — is never the task's
        // fault: it moves to the next model, and a round with no model left to
        // try ends the attempt without spending a retry.
        const noted = await noteTurnRefusal(r, refusals, model, result);
        refusals = noted.refusals;
        if (noted.quota) emit(r, "model-fallback", `quota on ${modelKey(model)}; not spending a retry`);
        const advanced = handovers < maxHandovers
          && await fallBack(r, "worker", `${noted.quota ? "quota exhausted" : "turn rejected"} on ${modelKey(model)}`);
        if (!advanced) return await refusedRound(r, "worker", refusals, true);
        handovers++;
        // Waiting after choosing a *different* healthy provider cools down
        // nothing. Pause only for a same-model cyclic re-probe.
        if (noted.quota && await modelFor(r, "worker") === model) await quotaPause(r, handovers - 1);
        // The next model must not continue a session the refusing backend owns.
        fresh = true;
      } else {
        if (await fail(r)) return "blocked";
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
          // The wrap-up turn was refused like any other: same table entry, same round.
          const noted = await noteTurnRefusal(r, refusals, model, wrap);
          refusals = noted.refusals;
          const handedOver = handovers < maxHandovers
            && await fallBack(r, "worker", `wrap-up rejected by ${modelKey(model)}`);
          if (handedOver) handovers++;
          else return await refusedRound(r, "worker", refusals, true);
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

/**
 * What the artifact digest leaves out of the work directory besides
 * `artifactIgnore`: the tasks directory, and the configuration file this run
 * was started with. The configuration is the controller's input, not an
 * artifact of the work — and the outage report's advice is to edit exactly that
 * file and run again (found live, 2026-11-26: with `taskctl.json` in the work
 * directory, that edit made the review-only recovery refuse every deferred
 * review as "artifacts changed"). A file outside the work directory excludes
 * nothing; `artifactDigest` drops what does not lie inside.
 */
function digestExclusions(cfg: Pick<WorkerConfig, "tasksDir" | "configPath">): string[] {
  return [cfg.tasksDir, ...(cfg.configPath === undefined ? [] : [resolvePath(cfg.configPath)])];
}

async function resumeReviewOnly(r: Run, pending: ReviewPendingRecord): Promise<"done" | "blocked" | "open" | "awaiting-human"> {
  // Nothing is dispatched once a stop was observed: the parked task keeps its
  // evidence and the attempt settles instead (the status it returns to is the
  // one it was claimed from, `stopAttempt`).
  assertNotStopped(r);
  if (pending.definitionDigest !== await attemptDefinition(r)) {
    throw new ReviewRequiredError("review-only recovery refused: the task definition changed; old evidence is stale");
  }
  const artifactNow = await artifactDigest(r.cfg.workdir, digestExclusions(r.cfg), r.cfg.artifactIgnore ?? []);
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
  const artifactBefore = await artifactDigest(r.cfg.workdir, digestExclusions(r.cfg), r.cfg.artifactIgnore ?? []);
  const startedAt = new Date().toISOString();
  let result: AcceptanceResult;
  try {
    // The gate always runs the command in `check` mode: it must verify, not
    // (re)generate, because the digest comparison below spans the run. The
    // worker-side invocations default to `generate` and land inside the
    // attempt window instead (see TASKCTL_ACCEPTANCE_MODE in the README).
    // The gate's shell is spawned in its own process group (D4): a Ctrl-C that
    // lands on the attempt reaches this controller alone, and the confirmed
    // cancel of the cut gate is the controller's own.
    result = await controlled(r, "acceptance", r.cfg.acceptanceTimeoutMs ?? ACCEPTANCE_TIMEOUT_MS_DEFAULT,
      () => r.deps.acceptance ? legacyExecution(() => r.deps.acceptance!(command, r.cfg.workdir)) : startAcceptance(command, r.cfg.workdir, "check", { insulated: true }));
  } catch (err) {
    if (!(err instanceof WorkerTimeoutError)) throw err;
    result = {
      passed: false, skipped: false, exitCode: null,
      output: [err.message, err.partialOutput].filter((part) => part !== undefined && part.length > 0).join("\n"),
    };
  }
  const artifactAfter = await artifactDigest(r.cfg.workdir, digestExclusions(r.cfg), r.cfg.artifactIgnore ?? []);
  // A gate that ended as the stop was observed is not judged: nothing below
  // writes evidence or spends a retry, and the attempt settles instead.
  assertNotStopped(r);
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
    const running = checkRender({
      targets: r.task.renderTargets.map((target) => join(r.cfg.workdir, target)),
      ...(r.cfg.renderViewports === undefined ? {} : { viewports: r.cfg.renderViewports }),
      evidenceDir,
      ...(r.cfg.chromeBin === undefined ? {} : { chromeBin: r.cfg.chromeBin }),
    });
    // The stop ends the wait, never the check (D4): the check still runs to
    // its own end — each of its steps is bounded at 30 s — and its `finally`
    // closes the browser.
    const first = r.deps.stop === undefined
      ? await running
      : await Promise.race([running, r.deps.stop.observed.then(() => STOP)]);
    if (first instanceof StopObservedDuringRenderCheck) {
      emit(r, "stop-requested", "render check in progress; it ends before anything is judged (each step is bounded at 30 s)");
      await running.catch(() => {});
      throw new OperatorStoppedError("render check", false);
    }
    check = first;
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
  // A stop observed while the check ran: the verdict it returned is not judged.
  if (r.deps.stop?.isRequested()) throw new OperatorStoppedError("render check", false);
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
  // Checked once more at the judgement itself: a stop that landed between the
  // record above and this retry spends nothing.
  if (r.deps.stop?.isRequested()) throw new OperatorStoppedError("render check", false);
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
  let refusals: ModelRefusal[] = [];
  // Every review round starts at the head of its chain, with a fresh wrap budget.
  await resetRotation(r.cfg.tasksDir, id, "reviewer");
  for (;;) {
    let reviewerModel: string | undefined;
    try {
      reviewerModel = await modelFor(r, "reviewer");
    } catch (error) {
      if (!(error instanceof ModelsCoolingError)) throw error;
      // Nothing could be tried: every reviewer model is cooling on a refusal.
      // The review waits for the earliest window; only a round in which this
      // review itself was refused counts.
      const cooling = await coolingRefusals(r.cfg.tasksDir, reviewerChain(r));
      return await refusedRound(r, "review", mergeRefusals(refusals, cooling), refusals.length > 0, error.retryAfter);
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
    // A stop observed during the reviewer's telemetry: the verdict is not
    // judged — `review.json` keeps what it had, and the attempt settles.
    assertNotStopped(r);
    if (result.failure !== "provider") {
      // A provider rejection is not a verdict, so nothing is recorded as one:
      // review.json keeps the last real verdict, and a later real verdict is
      // not read as "unchanged since last time" against criteria no reviewer
      // ever judged.
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
      // A reviewer turn that actually ran is the run's evidence that this
      // reviewer model works, and it ends any deferral — exactly as a worker
      // turn with exit code 0 is (`loop`). The mark of a turn that ran is its
      // session: a verdict the `review` seam answered dispatched no turn, and
      // no model served anything for it.
      if (result.reviewerSessionId !== undefined) r.run.accepted.set(modelKey(reviewerModel), Date.now());
      await clearModelWait(r.cfg.tasksDir, id);
      if (reviewerModel !== undefined) await clearModelCooldown(r.cfg.tasksDir, reviewerModel);
      // Checked again here: the pre-review check ran before this turn, and a task
      // file edited while the reviewer was reading would otherwise be completed —
      // or reopened for rework — under a definition the reviewer never saw.
      await requireUnchangedDefinition(r, ["review"], "the task definition changed during the review; refusing to act on the verdict");
      await rm(join(r.cfg.tasksDir, id, "review-pending.json"), { force: true });
      return await judge(r, result, prevCriteria);
    }
    const said = result.refusalText ?? result.summary ?? "review provider rejected the turn";
    if (reviewerModel !== undefined) {
      await noteModelRefusal(r.cfg.tasksDir, reviewerModel, {
        reason: said,
        category: "provider", cooldownMs: modelCooldownMsOf(r.cfg),
      });
    }
    await owned(r, () => appendJournal(r.cfg.tasksDir, id, {
      stage: "review",
      event: "provider-failed",
      detail: said,
    }));
    refusals = addRefusal(refusals, {
      model: modelKey(reviewerModel), at: new Date().toISOString(),
      reason: said, source: "turn",
    });
    const handedOver = handovers < maxHandovers
      && await fallBack(r, "reviewer", `review rejected by ${reviewerModel ?? DEFAULT_MODEL_KEY}`);
    if (handedOver) {
      handovers++;
      emit(r, "rework", "reviewer provider failure; retrying with the next model");
      continue;
    }
    // No reviewer is left: the worker and acceptance already produced valid
    // evidence, so the round ends with a deferral and nothing is replayed.
    return await refusedRound(r, "review", refusals, true);
  }
}

/** The window a parked record carries, when it is shaped like one. */
function preservedWindow(
  pending: ReviewPendingRecord | null,
): { startedAt: string; finishedAt: string } | undefined {
  const window = pending?.window;
  return typeof window?.startedAt === "string" && typeof window.finishedAt === "string" ? window : undefined;
}

/** The record `review-pending.json` carries, keeping the first window and the first refusal time. */
async function reviewPendingRecord(r: Run, round: readonly { model: string; reason: string }[]): Promise<ReviewPendingRecord> {
  const acceptance = await readRuntime<Record<string, unknown>>(r.cfg.tasksDir, r.task.id, "acceptance.json");
  const previous = await readRuntime<ReviewPendingRecord>(r.cfg.tasksDir, r.task.id, "review-pending.json");
  const artifactDigestAfter = typeof acceptance?.artifactAfter === "string"
    ? acceptance.artifactAfter
    : await artifactDigest(r.cfg.workdir, digestExclusions(r.cfg), r.cfg.artifactIgnore ?? []);
  const now = new Date().toISOString();
  return {
    definitionDigest: await attemptDefinition(r),
    artifactDigest: artifactDigestAfter,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    refusals: [...(previous?.refusals ?? []), ...round].slice(-20),
    // The window of the attempt whose evidence is preserved. A recovery that is
    // parked again is a later attempt that produced nothing: it keeps the first.
    window: preservedWindow(previous) ?? { startedAt: r.record.startedAt, finishedAt: now },
  };
}

/**
 * Park only the missing review: the worker and acceptance already produced
 * valid evidence, and replaying those side effects on a later scheduler pass
 * is what this avoids. `reason` is why no verdict exists — a reviewer that
 * ran out of time (a refused provider round defers instead, `refusedRound`).
 */
async function parkReviewPending(
  r: Run, reviewerModel: string | undefined, reason: string,
): Promise<"blocked"> {
  const refusal = { model: reviewerModel ?? "(default)", reason: reason.slice(0, 1_000) };
  const pending = await reviewPendingRecord(r, [refusal]);
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
    // A stop must not be journaled as an unavailable telemetry call.
    if (err instanceof OperatorStoppedError) throw err;
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
