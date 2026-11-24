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
export type SessionUsageSnapshot = {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cost?: number;
  model?: string;
};

export type SessionReuseStatus = "reusable" | "active" | "unavailable";

/** What a backend reports for a model's price, per million tokens. */
export type CatalogueCost = { input: number; output: number };

/**
 * One model of the backend's model catalogue (`opencode api model.list`),
 * rebuilt from named fields only: a list entry also carries credentials
 * (`settings.apiKey`, `headers`), so nothing else of it is kept or passed on.
 *
 * - `ref` is `providerID/id`; `modelID` is the upstream name, the same as `id`
 *   for most models.
 * - `cost` holds only the rows that report two finite numbers. Empty means
 *   "this model does not say what it costs"; all-zero means free.
 * - `enabled` is what the backend says, and `true` when it says nothing.
 */
export type CatalogueModel = { ref: string; providerID: string; id: string; modelID: string; variants: string[]; cost: CatalogueCost[]; enabled: boolean };

export interface AgentAdapter {
  prompt(args: {
    sessionId?: string;
    text: string;
    model?: string;
    effort?: string;
    title?: string;
    cwd: string;
    /**
     * Extra environment for the spawned worker process (e.g. TASKCTL_TASK_DIR /
     * TASKCTL_LOG_DIR). Merged over the orchestrator's own environment; absent
     * means inherit unchanged.
     */
    env?: Record<string, string>;
  }): Promise<PromptResult>;
  /** Preferred lifecycle boundary. Legacy prompt-only backends cannot prove
   * cancellation and are blocked, not retried, after an interrupted turn. */
  start?(args: Parameters<AgentAdapter["prompt"]>[0]): Execution<Awaited<ReturnType<AgentAdapter["prompt"]>>>;
  /**
   * The exact model string to dispatch. An effort is a *variant* of a model
   * (`provider/model#high`), and a provider only publishes the variants it
   * lists: appending one to a model without it is rejected by the provider
   * (`provider.no-route: Variant unavailable for …`), which cost a whole
   * worker turn on 2026-11-23 (minimax coding plan publishes no variants at
   * all). Optional: a backend that cannot tell keeps the plain model.
   */
  resolveModel?(model: string | undefined, effort: string | undefined): Promise<string | undefined>;
  /** tokens 总量 */
  contextUsage(sessionId: string): Promise<number>;
  /** limit.context */
  contextLimit(model: string): Promise<number>;
  /** Structured cumulative usage for reports; absent means unmeasured. */
  sessionUsage?(sessionId: string): Promise<SessionUsageSnapshot>;
  /** Best-effort proof that a persisted session is idle and safe to continue. */
  canResumeSession?(sessionId: string, expected: { model: string; cwd: string }): Promise<SessionReuseStatus>;
  /**
   * Every model the backend lists with the cost it reports: one entry per
   * `providerID/id`, sorted by ref. Rejects when the call fails and when the
   * answer holds no models — neither is a truth about the backend — and
   * remembers neither. Optional: an adapter without it is not budget-guarded,
   * so the fakes that never list models stay as they are.
   */
  modelCatalog?(): Promise<CatalogueModel[]>;
  /**
   * The backend's default model as `providerID/id`, `null` when it has none.
   * Rejects when the answer cannot be read, and remembers nothing.
   */
  defaultModelRef?(): Promise<string | null>;
}
