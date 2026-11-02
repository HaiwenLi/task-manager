import { randomUUID } from "node:crypto";
import { claim, heartbeat, lockLive, release, withOwnership, OwnershipLostError } from "./claim.js";
import { latestNote, writeNote, type HandoffNote } from "./handoff.js";
import { startAcceptance, type AcceptanceResult } from "./acceptance.js";
import { buildWorkerPrompt } from "./protocol.js";
import type { TaskStore } from "./task-store.js";
import type { Task } from "./task-file.js";
import type { AgentAdapter } from "./adapters/types.js";
import type { Execution } from "./execution.js";
import { reserveWorkspace, artifactDigest, type WorkspaceReservation } from "./workspace.js";
import { definitionDigest, readAttempt, writeRuntime, type AttemptRecord } from "./runtime.js";

export const TURN_TIMEOUT_MS_DEFAULT = 30 * 60_000;
export const ACCEPTANCE_TIMEOUT_MS_DEFAULT = 10 * 60_000;
export const MAX_SESSIONS_PER_TASK_DEFAULT = 20;
export const MAX_TURNS_PER_SESSION_DEFAULT = 40;
export const WRAP_UP_INSTRUCTION = "上下文预算告急。请立即运行一次 taskctl note（详尽记录进展），然后只回复 HANDOFF_READY";

export type WorkerConfig = {
  tasksDir: string; workdir: string; agent: string; model?: string; effort?: string;
  contextThreshold: number; retryLimit: number; lockTtlMs: number; heartbeatMs: number;
  turnTimeoutMs?: number; acceptanceTimeoutMs?: number;
  maxSessionsPerTask?: number; maxTurnsPerSession?: number;
};
export type WorkerStore = Pick<TaskStore, "list" | "setStatus" | "appendSession" | "incRetries" | "readDoneMarker" | "clearDoneMarker">;
export type WorkerDeps = {
  store: WorkerStore; adapter: AgentAdapter;
  acceptance?: (command: string, cwd: string) => Promise<AcceptanceResult>;
  onEvent?: (evt: WorkerEvent) => void;
};
export type WorkerEventType = "claimed" | "takeover" | "running" | "handoff" | "turn-failed" | "acceptance" | "acceptance-skipped" | "done" | "blocked" | "ownership-lost";
export type WorkerEvent = { type: WorkerEventType; taskId: string; detail?: string };
export type TaskOutcome = "done" | "blocked" | "skipped";
export class WorkerTimeoutError extends Error {}
class UncertainExecutionError extends Error {}
class ReviewRequiredError extends Error {}

type Run = {
  cfg: WorkerConfig; deps: WorkerDeps; task: Task; owner: string; definition: string;
  record: AttemptRecord; lost: boolean; notifyLost: () => void; loss: Promise<void>;
  execution?: Execution<unknown>;
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
  const r: Run = { cfg, deps, task, owner, definition: definitionDigest(task), lost: false, notifyLost, loss,
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

/** A cooperative legacy adapter can complete normally, but cannot prove cancellation. */
function legacyExecution<T>(fn: () => Promise<T>): Execution<T> {
  let state: "running" | "exited" = "running";
  const result = Promise.resolve().then(fn).finally(() => { state = "exited"; });
  return { result, inspect: () => ({ state }), cancel: async () => false };
}

async function controlled<T>(r: Run, label: string, ms: number, start: () => Execution<T>): Promise<T> {
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
    const value = await Promise.race([execution!.result, timeout, lost]);
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

async function turn(r: Run, text: string, sessionId?: string) {
  const args = { sessionId, text, model: r.task.model ?? r.cfg.model, effort: r.task.effort ?? r.cfg.effort, title: r.task.title, cwd: r.cfg.workdir };
  try {
    return { ...await controlled(r, "agent turn", r.cfg.turnTimeoutMs ?? TURN_TIMEOUT_MS_DEFAULT,
      () => r.deps.adapter.start ? r.deps.adapter.start(args) : legacyExecution(() => r.deps.adapter.prompt(args))), timedOut: false };
  } catch (err) {
    if (!(err instanceof WorkerTimeoutError)) throw err;
    // Only reached if cancellation was positively confirmed.
    await owned(r, () => r.deps.store.clearDoneMarker(r.task.id));
    return { sessionId: "", text: "", exitCode: -1, timedOut: true };
  }
}

async function loop(r: Run): Promise<"done" | "blocked"> {
  let sessionId: string | undefined;
  let recordedSession = "", sessionsUsed = r.task.sessions.length, turns = 0;
  for (;;) {
    const note = await latestNote(r.cfg.tasksDir, r.task.id);
    const prompt = buildWorkerPrompt(r.task, { handoff: note?.markdown, workdir: r.cfg.workdir, tasksDir: r.cfg.tasksDir });
    const result = await turn(r, prompt, sessionId);
    await owned(r, async () => {
      if (result.sessionId && result.sessionId !== recordedSession) {
        await r.deps.store.appendSession(r.task.id, result.sessionId);
        recordedSession = sessionId = result.sessionId; sessionsUsed++;
      }
    });
    turns++;
    let fresh = false;
    // A failed/aborted turn cannot submit successful completion even if it wrote a marker.
    if (result.exitCode !== 0) {
      await owned(r, () => r.deps.store.clearDoneMarker(r.task.id));
      emit(r, "turn-failed", result.timedOut ? "turn timed out; shutdown confirmed" : `exit ${result.exitCode}`);
      if (await fail(r)) return "blocked";
    } else if (await owned(r, () => r.deps.store.readDoneMarker(r.task.id))) {
      await owned(r, () => r.deps.store.clearDoneMarker(r.task.id));
      const verdict = await accept(r);
      if (verdict !== "retry") return verdict;
      fresh = true;
    } else if (turns >= (r.cfg.maxTurnsPerSession ?? MAX_TURNS_PER_SESSION_DEFAULT)) {
      if (await fail(r)) return "blocked";
      fresh = true;
    } else if (await overBudget(r, sessionId)) {
      const wrap = await turn(r, WRAP_UP_INSTRUCTION, sessionId);
      const after = await latestNote(r.cfg.tasksDir, r.task.id);
      if (!after || after.seq <= (note?.seq ?? 0)) {
        if (!wrap.timedOut) await owned(r, () => writeNote(r.cfg.tasksDir, fallbackNote(r.task, note?.seq ?? 0, wrap.text)));
        emit(r, "handoff", sessionId);
        if (await fail(r)) return "blocked";
      } else emit(r, "handoff", sessionId);
      fresh = true;
    }
    if (fresh) {
      if (sessionsUsed >= (r.cfg.maxSessionsPerTask ?? MAX_SESSIONS_PER_TASK_DEFAULT) && await fail(r)) return "blocked";
      sessionId = undefined; turns = 0;
    }
  }
}

async function accept(r: Run): Promise<"done" | "blocked" | "retry"> {
  const command = r.task.acceptance?.trim();
  if (!command) { emit(r, "acceptance-skipped", "missing acceptance requires review"); throw new ReviewRequiredError("missing acceptance criteria; review required"); }
  const artifactBefore = await artifactDigest(r.cfg.workdir, [r.cfg.tasksDir]);
  const startedAt = new Date().toISOString();
  let result: AcceptanceResult;
  try {
    result = await controlled(r, "acceptance", r.cfg.acceptanceTimeoutMs ?? ACCEPTANCE_TIMEOUT_MS_DEFAULT,
      () => r.deps.acceptance ? legacyExecution(() => r.deps.acceptance!(command, r.cfg.workdir)) : startAcceptance(command, r.cfg.workdir));
  } catch (err) {
    if (!(err instanceof WorkerTimeoutError)) throw err;
    result = { passed: false, skipped: false, exitCode: null, output: err.message };
  }
  const artifactAfter = await artifactDigest(r.cfg.workdir, [r.cfg.tasksDir]);
  // All controller writers use the same mutex as takeover for final validation/write.
  return owned(r, async () => {
    const current = (await r.deps.store.list()).find(t => t.id === r.task.id);
    const definitionMatches = !!current && current.status === "running" && definitionDigest(current) === r.definition;
    const evidence = { attemptId: r.owner, definitionDigest: r.definition, artifactBefore, artifactAfter, command,
      startedAt, finishedAt: new Date().toISOString(), ...result, definitionMatches };
    await writeRuntime(r.cfg.tasksDir, r.task.id, "acceptance.json", evidence);
    if (!definitionMatches || artifactBefore !== artifactAfter || result.skipped) throw new ReviewRequiredError("acceptance evidence invalidated by definition/artifact drift or skipped check");
    emit(r, "acceptance", result.passed ? "passed" : `failed (exit ${result.exitCode ?? "null"})`);
    if (result.passed) {
      await r.deps.store.setStatus(r.task.id, "done"); emit(r, "done"); return "done";
    }
    const retries = await r.deps.store.incRetries(r.task.id);
    if (retries >= r.cfg.retryLimit) {
      await r.deps.store.setStatus(r.task.id, "blocked"); emit(r, "blocked", "retry limit reached"); return "blocked";
    }
    return "retry";
  });
}

async function overBudget(r: Run, sessionId?: string): Promise<boolean> {
  const model = r.task.model ?? r.cfg.model;
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
