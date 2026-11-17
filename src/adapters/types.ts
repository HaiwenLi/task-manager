import type { Execution } from "../execution.js";

/**
 * One finished turn. `failure: "provider"` means the backend rejected the turn
 * itself (quota, rate limit, auth, 5xx) before it could do work: that is a
 * retryable external failure, not evidence that a session may still be running.
 */
export type PromptResult = {
  sessionId: string;
  exitCode: number;
  text: string;
  failure?: "provider";
  /**
   * Tokens the backend reported for this turn, when it reports any. Absent means
   * "not measured", not "zero" — a refusal that burned no tokens is exactly the
   * signal the quota classifier reads, so the two must not be conflated.
   */
  tokens?: number;
};

/**
 * The agent control surface taskctl drives (v0.1: OpenCode only). The
 * execution plane is `start` (or legacy `prompt`) — one full agent turn; the control plane is
 * the context telemetry the Context Budget check (ADR-0003) consumes.
 */
export interface AgentAdapter {
  prompt(args: {
    sessionId?: string;
    text: string;
    model?: string;
    effort?: string;
    title?: string;
    cwd: string;
  }): Promise<PromptResult>;
  /** Preferred lifecycle boundary. Legacy prompt-only backends cannot prove
   * cancellation and are blocked, not retried, after an interrupted turn. */
  start?(args: Parameters<AgentAdapter["prompt"]>[0]): Execution<Awaited<ReturnType<AgentAdapter["prompt"]>>>;
  /** tokens 总量 */
  contextUsage(sessionId: string): Promise<number>;
  /** limit.context */
  contextLimit(model: string): Promise<number>;
}
