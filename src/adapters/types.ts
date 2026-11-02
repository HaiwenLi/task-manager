/**
 * The agent control surface taskctl drives (v0.1: OpenCode only). The
 * execution plane is `prompt` — one full agent turn; the control plane is
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
  /** tokens 总量 */
  contextUsage(sessionId: string): Promise<number>;
  /** limit.context */
  contextLimit(model: string): Promise<number>;
}
