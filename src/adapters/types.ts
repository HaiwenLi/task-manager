import type { Execution } from "../execution.js";

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
  }): Promise<{ sessionId: string; exitCode: number; text: string }>;
  /** Preferred lifecycle boundary. Legacy prompt-only backends cannot prove
   * cancellation and are blocked, not retried, after an interrupted turn. */
  start?(args: Parameters<AgentAdapter["prompt"]>[0]): Execution<Awaited<ReturnType<AgentAdapter["prompt"]>>>;
  /** tokens 总量 */
  contextUsage(sessionId: string): Promise<number>;
  /** limit.context */
  contextLimit(model: string): Promise<number>;
}
