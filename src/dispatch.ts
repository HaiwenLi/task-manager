import type { PromptResult } from "./adapters/types.js";

/**
 * Dispatch failures come in two kinds, and they need different handling.
 *
 * A provider that refuses the turn (429, auth, 5xx) is an external statement:
 * retrying on another account is progress. A provider that is *out of quota* is
 * the same statement plus a fact about time — the account will work again after
 * the window resets, and nothing about the task caused the refusal. Spending the
 * task's retry budget on it does not make the task more likely to succeed; it
 * only writes off a task that never ran. (On 2026-11-17 a weekly limit and two
 * five-hour limits turned live tasks into `blocked` and consumed their retries in
 * a single day.)
 *
 * So quota refusals back off and move down the model chain without touching
 * `retries`; a round in which the whole chain refused defers the task
 * (`src/worker.ts`).
 */

/**
 * Words a refused turn uses when it is about allowance rather than the work.
 *
 * Kept in code, not configuration: this list is a fact about provider error
 * strings, and it is the one thing the classifier must not be tuned per machine.
 */
export const QUOTA_HINTS: readonly string[] = [
  "weekly limit",
  "usage limit",
  "rate limit",
  "rate-limit",
  "ratelimit",
  "quota",
  "credit",
  "balance",
  "too many requests",
  "周限额",
  "用量上限",
  "限额",
  "额度",
  "余额",
];

/** A turn shorter than this did not reach the model's context. */
export const FAST_EXIT_MS_DEFAULT = 30_000;

/** Backoff before re-dispatch after a quota refusal: `base` doubling, capped. */
export const QUOTA_BACKOFF_BASE_MS_DEFAULT = 1_000;
export const QUOTA_BACKOFF_CAP_MS_DEFAULT = 30_000;

export type DispatchFailureKind = "quota" | "provider";

export type DispatchFailureInput = {
  /** What the adapter said the failure was, if it classified one. */
  failure?: PromptResult["failure"];
  exitCode: number;
  /** Wall time of the dispatch, measured by the caller. */
  durationMs: number;
  /** Tokens the backend reported for the turn, when it reports any. */
  tokens?: number;
  /** Turn text plus the stderr tail the adapter attached. */
  output: string;
};

/**
 * Classify a failed dispatch; `undefined` when it is not a provider refusal at
 * all (a crashed turn, a genuine task failure) and the ordinary retry path owns
 * it.
 *
 * A hint word is decisive on its own: provider error strings are the one place
 * these phrases appear, and a false positive costs a backoff and a model
 * handover, not a wrong verdict. With no hint word, the shape of the failure
 * decides — a turn that returned almost immediately having burned zero tokens
 * never got to do work, which is what an exhausted allowance looks like from the
 * outside.
 */
export function classifyDispatchFailure(
  input: DispatchFailureInput,
  options: { fastExitMs?: number } = {},
): DispatchFailureKind | undefined {
  if (input.failure !== "provider") return undefined;
  if (matchesQuotaHint(input.output)) return "quota";
  const fastExitMs = options.fastExitMs ?? FAST_EXIT_MS_DEFAULT;
  if (input.tokens === 0 && input.durationMs <= fastExitMs) return "quota";
  return "provider";
}

/** True when the text mentions an allowance, in any of the known phrasings. */
export function matchesQuotaHint(text: string): boolean {
  const haystack = text.toLowerCase();
  return QUOTA_HINTS.some((hint) => haystack.includes(hint.toLowerCase()));
}

/**
 * The wait before re-dispatching on a quota refusal, by attempt index.
 *
 * Exponential with a cap so a long window (a weekly limit) does not turn into a
 * day of sleeps: the chain moves on instead, and the operator sees the blocked
 * note rather than a process that never returns.
 */
export function quotaBackoffMs(
  attempt: number,
  base = QUOTA_BACKOFF_BASE_MS_DEFAULT,
  cap = QUOTA_BACKOFF_CAP_MS_DEFAULT,
): number {
  const index = Math.max(0, Math.min(attempt, 16));
  return Math.min(base * 2 ** index, cap);
}
