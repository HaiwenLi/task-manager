import { claim, heartbeat, lockLive, release } from "./claim.js";
import { latestNote, writeNote, type HandoffNote } from "./handoff.js";
import { runAcceptance, type AcceptanceResult } from "./acceptance.js";
import { buildWorkerPrompt } from "./protocol.js";
import type { TaskStore } from "./task-store.js";
import type { Task } from "./task-file.js";
import type { AgentAdapter } from "./adapters/types.js";

/** Ceiling for one agent turn when `turnTimeoutMs` is not configured (30 min). */
export const TURN_TIMEOUT_MS_DEFAULT = 30 * 60_000;

/** Ceiling for one acceptance run when `acceptanceTimeoutMs` is not configured (10 min). */
export const ACCEPTANCE_TIMEOUT_MS_DEFAULT = 10 * 60_000;

/** Default ceiling on sessions in one task's chain when `maxSessionsPerTask` is unset. */
export const MAX_SESSIONS_PER_TASK_DEFAULT = 20;

/** Default ceiling on work turns within one session when `maxTurnsPerSession` is unset. */
export const MAX_TURNS_PER_SESSION_DEFAULT = 40;

/**
 * The fixed wrap-up instruction (ADR-0003): when the Context Budget nears
 * exhaustion the orchestrator sends this to the SAME session, the agent runs
 * `taskctl note` and replies HANDOFF_READY, and the loop opens a fresh
 * session with the note injected. The copy is spec-fixed — the worker
 * protocol (task 7) tells agents to expect the "上下文预算告急" signal.
 */
export const WRAP_UP_INSTRUCTION =
  "上下文预算告急。请立即运行一次 taskctl note（详尽记录进展），然后只回复 HANDOFF_READY";

/** Worker configuration (resolved from `taskctl.json` by the CLI). */
export type WorkerConfig = {
  /** Absolute tasks directory: locks, notes and markers live under it. */
  tasksDir: string;
  /** Working directory every agent session runs in. */
  workdir: string;
  /** Agent backend name (v0.1: "opencode"); the CLI picks the adapter, the loop stays adapter-agnostic. */
  agent: string;
  /** Fallback model; a task's own `model` frontmatter wins. */
  model?: string;
  /** Fallback effort variant; a task's own `effort` frontmatter wins. */
  effort?: string;
  /** `contextUsage / contextLimit` ratio at which a handoff is triggered (e.g. 0.8). */
  contextThreshold: number;
  /** Failed attempts (failed turns, failed wrap-ups, failed acceptances) before a task is blocked. */
  retryLimit: number;
  /** Lock staleness window: governs claim's takeover test and the running-task liveness check. */
  lockTtlMs: number;
  /** Reserved for a background heartbeat timer; v0.1 refreshes at turn boundaries instead. */
  heartbeatMs: number;
  /** Ceiling for one `adapter.prompt` call; a hung turn counts as a failed turn. */
  turnTimeoutMs?: number;
  /** Ceiling for one acceptance run; a hung gate counts as a failed acceptance. */
  acceptanceTimeoutMs?: number;
  /**
   * Ceiling on sessions in one task's chain (handoffs and retries included).
   * Opening another session once the chain is full counts as a failed attempt,
   * so `retryLimit` eventually blocks a task that never concludes. Default 20.
   */
  maxSessionsPerTask?: number;
  /**
   * Ceiling on work turns within one session; spending it without concluding
   * the task counts as a failed attempt and the loop opens a fresh session.
   * Default 40.
   */
  maxTurnsPerSession?: number;
};

/**
 * The TaskStore surface the worker drives. `TaskStore` satisfies it; tests
 * fake it with an in-memory Map — the worker never depends on the filesystem
 * through the store seam (locks and notes still go through their modules).
 */
export type WorkerStore = Pick<
  TaskStore,
  "list" | "setStatus" | "appendSession" | "incRetries" | "readDoneMarker" | "clearDoneMarker"
>;

/** Injection seam: the store, the agent adapter, (optionally) the acceptance gate, and (optionally) per-event logging. */
export type WorkerDeps = {
  store: WorkerStore;
  adapter: AgentAdapter;
  /** Defaults to {@link runAcceptance} when omitted. */
  acceptance?: (command: string, cwd: string) => Promise<AcceptanceResult>;
  /**
   * Per-event single-line logging (Plan Task 9: "逐事件打印 [task] 状态").
   * The CLI wires this to `console.log`; the worker never prints on its own.
   */
  onEvent?: (evt: WorkerEvent) => void;
};

/**
 * Lifecycle events one task run emits, in order. `claimed` opens a fresh
 * run; `takeover` opens one by recovering an orphaned `running` task
 * ("心跳停 → 接管"); `ownership-lost` aborts a run without touching the
 * task further (a successor took the lock over mid-run).
 */
export type WorkerEventType =
  | "claimed"
  | "takeover"
  | "running"
  | "handoff"
  | "turn-failed"
  | "acceptance"
  | "acceptance-skipped"
  | "done"
  | "blocked"
  | "ownership-lost";

/** One event: the task it belongs to and an optional single-line detail. */
export type WorkerEvent = { type: WorkerEventType; taskId: string; detail?: string };

/**
 * Terminal outcome of one task run; "skipped" means the lock is — or
 * became — someone else's (never claimed, or ownership lost mid-run: the
 * worker stops without retrying, releasing, or marking anything).
 */
export type TaskOutcome = "done" | "blocked" | "skipped";

/** Raised when a turn or an acceptance run exceeds its configured timeout. */
export class WorkerTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerTimeoutError";
  }
}

/**
 * Drain the queue: every `open` task runs through {@link runTask} in
 * filename order. A `running` task whose lock is live is being worked by
 * someone else and is skipped; one whose lock is missing or stale is an
 * orphan left by a crashed worker and is taken over (claim archives the
 * stale lock and re-owns the task — the README's automatic recovery).
 * Terminal statuses (`done`/`blocked`) are ignored. `store.list()` failing
 * loud (e.g. a corrupt `.md`) propagates — that is the agreed design, not
 * an oversight.
 */
export async function runWorker(
  cfg: WorkerConfig,
  deps: WorkerDeps,
): Promise<{ done: string[]; blocked: string[] }> {
  const workerId = `worker-${process.pid}`;
  const tasks = await deps.store.list();
  const done: string[] = [];
  const blocked: string[] = [];
  for (const task of tasks) {
    if (task.status === "running") {
      // 心跳停 → 接管（controller ruling）：锁缺席/过期 = 孤儿任务。
      // 活锁说明原 worker 仍存活 → 跳过；竞态由 runTask 内的 claim 原子裁决。
      if (await lockLive(cfg.tasksDir, task.id, cfg.lockTtlMs)) {
        continue;
      }
    } else if (task.status !== "open") {
      continue;
    }
    const outcome = await runTask(cfg, deps, task, workerId);
    if (outcome === "done") {
      done.push(task.id);
    } else if (outcome === "blocked") {
      blocked.push(task.id);
    }
  }
  return { done, blocked };
}

/**
 * The single-task execution sequence: `claim` → `setStatus running` → turn
 * loop { `buildWorkerPrompt`(inject latestNote) → `adapter.prompt` →
 * `appendSession` → done marker breaks out to acceptance; otherwise the
 * Context Budget check may trigger a wrap-up handoff to a fresh session } →
 * acceptance decides `done` vs retry vs `blocked`. Loop caps
 * (`maxTurnsPerSession`, `maxSessionsPerTask`) and every failure route
 * through `failAttempt`, so `retryLimit` bounds a task that never concludes.
 * Terminal states always `release` the lock (ownership-guarded). Losing the
 * lock mid-run is the one non-terminal exit: the worker stops immediately —
 * no retry is counted, nothing is marked or released; the task stays
 * exactly as the new owner finds it.
 */
export async function runTask(
  cfg: WorkerConfig,
  deps: WorkerDeps,
  task: Task,
  workerId: string,
): Promise<TaskOutcome> {
  if (!(await claim(cfg.tasksDir, task.id, workerId, cfg.lockTtlMs))) {
    return "skipped";
  }
  // claim 成功即接管：open 是新领取；running 说明前任已停跳（孤儿任务恢复）
  if (task.status === "running") {
    emit(deps, "takeover", task.id, "stale or absent lock recovered");
  } else {
    emit(deps, "claimed", task.id);
  }
  await deps.store.setStatus(task.id, "running");
  emit(deps, "running", task.id);

  // `undefined` opens a fresh session; a known id continues that session.
  let sessionId: string | undefined;
  // Last id already appended to the chain — the wrap-up turn reuses the same
  // session and must not append a duplicate entry.
  let recordedSession = "";
  // Loop guards: sessions in the chain so far, work turns in this session.
  let sessionsUsed = 0;
  let turnsInSession = 0;

  for (;;) {
    const note = await latestNote(cfg.tasksDir, task.id);
    const prompt = buildWorkerPrompt(task, {
      handoff: note?.markdown,
      workdir: cfg.workdir,
      tasksDir: cfg.tasksDir,
    });
    const result = await runTurn(cfg, deps, task, workerId, { sessionId, text: prompt });
    if (result.lostOwnership) {
      return ownershipLost(deps, task);
    }

    if (result.sessionId !== "" && result.sessionId !== recordedSession) {
      await deps.store.appendSession(task.id, result.sessionId);
      recordedSession = result.sessionId;
      sessionId = result.sessionId;
      sessionsUsed += 1;
    }
    turnsInSession += 1;

    // 本回合是否以"开新 session"收场；terminal 状态直接 return。
    let opensNewSession = false;

    // 若 readDoneMarker → 跳出验收（brief 的循环序列：marker 检查紧跟 appendSession；
    // 验收关才是信任边界，失败回合留下的 marker 也交给客观命令裁决）
    if (await deps.store.readDoneMarker(task.id)) {
      // marker 已消费：重试必须重新挣得一次 taskctl done，而不是空转验收
      await deps.store.clearDoneMarker(task.id);
      const verdict = await runAcceptanceGate(cfg, deps, task, workerId);
      if (verdict === "lost") {
        return ownershipLost(deps, task);
      }
      if (verdict !== "retry") {
        return verdict;
      }
      opensNewSession = true; // 验收失败 → 重新开 session 继续
    } else if (turnsInSession >= (cfg.maxTurnsPerSession ?? MAX_TURNS_PER_SESSION_DEFAULT)) {
      // 同 session 回合预算耗尽（任务未结、无 marker）：计一次失败并换新 session
      if (await failAttempt(cfg, deps, task, workerId)) {
        return "blocked";
      }
      opensNewSession = true;
    } else if (result.exitCode !== 0) {
      // A failed turn (non-zero exit, timeout) is a *result*: it counts as one
      // failed attempt instead of rejecting the whole run.
      emit(deps, "turn-failed", task.id, result.timedOut ? "turn timed out" : `exit ${result.exitCode}`);
      if (await failAttempt(cfg, deps, task, workerId)) {
        return "blocked";
      }
      // 重试本回合：同 session 续跑（opensNewSession 保持 false）
    } else if (await overBudget(cfg, deps, task, sessionId)) {
      const seqBefore = note?.seq ?? 0;
      const wrapUp = await runTurn(cfg, deps, task, workerId, { sessionId, text: WRAP_UP_INSTRUCTION });
      if (wrapUp.lostOwnership) {
        return ownershipLost(deps, task);
      }
      const after = await latestNote(cfg.tasksDir, task.id);
      if (after !== null && after.seq > seqBefore) {
        emit(deps, "handoff", task.id, sessionId ?? "");
        opensNewSession = true; // 交接笔记已落盘 → 开新 session 继续任务
      } else {
        // 回合已结束（无论 exitCode；只有挂起超时才算未结束）却没有 note
        // → 编排器自写兜底笔记，积累的上下文不随 session 丢失
        if (!wrapUp.timedOut) {
          await writeNote(cfg.tasksDir, fallbackNote(task, seqBefore, wrapUp.text));
        }
        emit(deps, "handoff", task.id, sessionId ?? "");
        if (await failAttempt(cfg, deps, task, workerId)) {
          return "blocked";
        }
        opensNewSession = true; // 视为一次失败后仍开新 session（兜底笔记注入）
      }
    }

    if (opensNewSession) {
      if (sessionsUsed >= (cfg.maxSessionsPerTask ?? MAX_SESSIONS_PER_TASK_DEFAULT)) {
        // 链条已满还要再开：计一次失败，重试额度耗尽即 blocked
        if (await failAttempt(cfg, deps, task, workerId)) {
          return "blocked";
        }
      }
      sessionId = undefined;
      turnsInSession = 0;
    }
    // 回合结束、无 marker、预算未告急、预算未耗尽 → 同 session 下一回合
  }
}

/** One agent turn as seen by the loop (a timed-out turn normalizes to this shape). */
type TurnResult = { sessionId: string; exitCode: number; text: string; timedOut: boolean; lostOwnership?: true };

/**
 * Heartbeat (ruling 1: refresh immediately before every prompt — no
 * background timer in v0.1) followed by `adapter.prompt` under the turn
 * timeout. A heartbeat that comes back false means the lock was taken over
 * (turn outlived the lock TTL); the turn never starts and the caller must
 * abort the task without touching it further. A timed-out turn is a failed
 * turn (`timedOut: true`, exitCode -1); the adapter interface cannot cancel
 * the underlying process, so it may still be running — v0.1 accepts that
 * risk. A non-timeout rejection (spawn failure) propagates: fail loud.
 */
async function runTurn(
  cfg: WorkerConfig,
  deps: WorkerDeps,
  task: Task,
  workerId: string,
  args: { sessionId?: string; text: string },
): Promise<TurnResult> {
  if (!(await heartbeat(cfg.tasksDir, task.id, workerId))) {
    return { sessionId: "", exitCode: -1, text: "", timedOut: false, lostOwnership: true };
  }
  const prompt = deps.adapter.prompt({
    sessionId: args.sessionId,
    text: args.text,
    model: task.model ?? cfg.model,
    effort: task.effort ?? cfg.effort,
    title: task.title,
    cwd: cfg.workdir,
  });
  try {
    return { ...(await withTimeout(prompt, cfg.turnTimeoutMs ?? TURN_TIMEOUT_MS_DEFAULT, "agent turn")), timedOut: false };
  } catch (err) {
    if (err instanceof WorkerTimeoutError) {
      return { sessionId: "", exitCode: -1, text: "", timedOut: true };
    }
    throw err;
  }
}

/**
 * The acceptance gate (ADR-0006). The heartbeat first keeps the lock alive
 * across a gate that may itself run as long as the lock TTL — and proves
 * the worker still owns it (a false heartbeat aborts with "lost" before
 * anything is judged or released). A passed gate marks the task done; a
 * failed one burns a retry — under the limit the loop reopens a session,
 * at the limit the task is blocked. Either way the lock is released on
 * the terminal states (ownership-guarded, so a successor's lock survives).
 */
async function runAcceptanceGate(
  cfg: WorkerConfig,
  deps: WorkerDeps,
  task: Task,
  workerId: string,
): Promise<"done" | "blocked" | "retry" | "lost"> {
  if (!(await heartbeat(cfg.tasksDir, task.id, workerId))) {
    return "lost";
  }
  const gate = deps.acceptance ?? runAcceptance;
  let result: AcceptanceResult;
  try {
    result = await withTimeout(
      gate(task.acceptance ?? "", cfg.workdir),
      cfg.acceptanceTimeoutMs ?? ACCEPTANCE_TIMEOUT_MS_DEFAULT,
      "acceptance",
    );
  } catch (err) {
    if (!(err instanceof WorkerTimeoutError)) {
      throw err;
    }
    result = { passed: false, exitCode: null, output: err.message, skipped: false };
  }
  if (result.skipped) {
    // ADR-0006：无 acceptance 字段 → 告警放行（告警是调用方的职责）
    emit(deps, "acceptance-skipped", task.id, "no acceptance field — passed with warning (ADR-0006)");
  } else {
    emit(deps, "acceptance", task.id, result.passed ? "passed" : `failed (exit ${result.exitCode ?? "null"})`);
  }
  if (result.passed) {
    await deps.store.setStatus(task.id, "done");
    emit(deps, "done", task.id);
    await release(cfg.tasksDir, task.id, workerId);
    return "done";
  }
  if (await failAttempt(cfg, deps, task, workerId)) {
    return "blocked";
  }
  return "retry";
}

/**
 * Context Budget check (ADR-0003): objective telemetry only. Needs a live
 * session and a resolvable model; an unknown model or control-plane hiccup
 * rejects inside the adapter and simply disables the check for this turn —
 * the loop must keep working when telemetry is unavailable.
 */
async function overBudget(cfg: WorkerConfig, deps: WorkerDeps, task: Task, sessionId: string | undefined): Promise<boolean> {
  const model = task.model ?? cfg.model;
  if (sessionId === undefined || model === undefined) {
    return false;
  }
  try {
    const usage = await deps.adapter.contextUsage(sessionId);
    const limit = await deps.adapter.contextLimit(model);
    return limit > 0 && usage / limit >= cfg.contextThreshold;
  } catch {
    return false;
  }
}

/**
 * Count one failed attempt. Returns true when the task just hit the retry
 * limit and was moved to `blocked` (with the lock released, ownership-
 * guarded so a mid-run successor's lock is never deleted).
 */
async function failAttempt(cfg: WorkerConfig, deps: WorkerDeps, task: Task, workerId: string): Promise<boolean> {
  const retries = await deps.store.incRetries(task.id);
  if (retries < cfg.retryLimit) {
    return false;
  }
  await deps.store.setStatus(task.id, "blocked");
  emit(deps, "blocked", task.id, "retry limit reached");
  await release(cfg.tasksDir, task.id, workerId);
  return true;
}

/**
 * The ownership-lost exit: a successor took the lock over mid-run. Emit the
 * event and bow out with "skipped" — no retry counted, nothing terminal
 * marked, nothing released; the task is left exactly as its new owner
 * finds it.
 */
function ownershipLost(deps: WorkerDeps, task: Task): TaskOutcome {
  emit(deps, "ownership-lost", task.id, "lock taken over by another worker");
  return "skipped";
}

/** Emit a lifecycle event when the caller wired the seam. */
function emit(deps: WorkerDeps, type: WorkerEventType, taskId: string, detail?: string): void {
  deps.onEvent?.({ type, taskId, detail });
}

/**
 * The orchestrator-written fallback note (Step 3 note of the brief): when the
 * wrap-up turn ENDED — any exit code; only a hang (timeout) hasn't ended —
 * but no note appeared, the next session still needs something to inherit.
 * `done`/`next` quote the task and the first 500 characters of the wrap-up
 * turn's output.
 */
function fallbackNote(task: Task, seqBefore: number, turnText: string): HandoffNote {
  const summary = truncate(`任务 ${task.id}（${task.title}）上回合输出：${turnText}`, 500);
  return {
    task: task.id,
    seq: seqBefore + 1,
    status: "orchestrator-fallback",
    done: summary,
    found: "agent 未按收尾指令写 note；本笔记由编排器兜底生成",
    next: summary,
    files: [],
  };
}

/** First `max` characters — no ellipsis, so the 500-character cap is exact. */
function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

/**
 * Race `work` against a timer. On timeout the underlying work keeps running
 * (nothing here can cancel it) but the caller sees a
 * {@link WorkerTimeoutError}; a late settlement is swallowed by the race.
 */
function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new WorkerTimeoutError(`${label} timed out after ${ms}ms`)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
