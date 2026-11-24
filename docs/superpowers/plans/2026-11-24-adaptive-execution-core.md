# Adaptive Execution Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add continuous/iterative task execution, preserve worker context across rework, prevent reviewer outages from replaying work, and remove the largest repeated resource costs.

**Architecture:** Keep Markdown lifecycle and the existing claim/fencing/evidence model. Add an explicit execution policy plus runtime-only sticky escalation/session facts; move automatic acceptance/review retry into the claimed worker loop and add a digest-checked review-only recovery path.

**Tech Stack:** TypeScript, Node.js 22, Vitest, existing OpenCode CLI adapter; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-24-adaptive-execution-design.md` (§§7–11, 14–15). Intake classification, static split and watch/batch are separate plans.

## Global Constraints

- `complexity` controls intake approval; `verify` controls proof; `execution` controls execution strategy.
- Continuous does not itself skip human review; quick/no-criteria still goes to `awaiting-human`.
- High-risk, human gates, independent reviewers and uncertain-execution rules remain unchanged.
- Model changes always start a fresh session; same-model reuse requires settled work and the reuse rules in the spec.
- Runtime JSON never becomes lifecycle authority. Definition fields join `definitionDigest`.
- All retries/handovers remain bounded. No provider/model calls are added to idle paths.
- Every behavior change starts with a failing test. Run the focused test before and after implementation.
- Do not claim live-backend verification from fake-adapter tests.

## Review Focus

1. Continuous + quick + no criteria must wait for a human rather than invoking a criterion-less reviewer (Task 3 test).
2. Review-pending recovery must reject definition or artifact drift instead of reviewing stale evidence (Task 4 tests).
3. Provider handover must still discard the old backend session even though ordinary rework now resumes (Task 3 tests).
4. Escalated render must call review and cannot remain `running` (Task 3 test).
5. Missing/corrupt execution state must disable session reuse and require review, never silently de-escalate (Task 2 tests).

---

### Task 1: Task policy schema and protocol vocabulary

**Files:**
- Modify: `src/task-file.ts`
- Modify: `src/runtime.ts`
- Modify: `src/protocol.ts`
- Modify: `src/cli.ts` (add/config flags only)
- Test: `tests/task-file.test.ts`, `tests/definition-digest.test.ts`, `tests/protocol.test.ts`, `tests/cli-config.test.ts`

**Interfaces:**
- Produces: `type TaskExecution = "continuous" | "iterative"`; `Task.execution`, `Task.workerSelfCheck?`, `Task.workerSelfCheckTimeoutMs?`.
- Produces: config key `modelCooldownMs`, consumed by Task 6.

- [x] **Step 1: Write failing schema/protocol tests.** Assert absent execution derives `simple → continuous` and `complex → iterative`; explicit values win; invalid execution/timeout values throw; self-check fields round-trip; both execution and self-check fields alter the digest. Assert the protocol names controller-owned acceptance, `taskctl check`, targeted checks and `ESCALATE:`.
- [x] **Step 2: Run focused tests and confirm the new assertions fail.**
- [x] **Step 3: Implement parsing, serialization, digest fields, `--execution`, and the protocol copy.** Default self-check timeout is 20 minutes; positive values only, with the configured turn bound checked when a run starts.
- [x] **Step 4: Run focused tests and the real-config structural allowlist test.** Expected: PASS, including every new config key accepted by `resolveConfig`.
- [x] **Step 5: Commit `feat(task): declare execution and bounded self-check policy`.**

### Task 2: Durable escalation and execution facts

**Files:**
- Create: `src/execution-state.ts`
- Modify: `src/worker.ts`, `src/reconcile.ts`
- Test: `tests/execution-state.test.ts`

**Interfaces:**
- Produces: `readExecutionState(tasksDir, id)`, `recordEscalation(tasksDir, id, reason)`, `recordWorkerSession(tasksDir, id, {sessionId, model})`.
- Runtime shape: `{requiresReview: boolean, effectiveExecution: "continuous"|"iterative", reasons: string[], latestWorker?: {sessionId: string, model?: string}, updatedAt: string}`.

- [x] **Step 1: Write failing tests for absent state, append-only reasons, latest-session replacement, and corrupt state.** Corrupt state must produce `requiresReview: true`, no reusable session and a diagnostic, not throw into a worker retry or return continuous.
- [x] **Step 2: Run the test and confirm the module/behavior is absent.**
- [x] **Step 3: Implement atomic runtime writes and conservative reads.** Ordinary `retryTask` must not archive/reset this file; terminal history retains it.
- [x] **Step 4: Run the focused test.** Expected: PASS.
- [x] **Step 5: Commit `feat(runtime): persist escalation and worker session facts`.**

### Task 3: Continuous lane and same-session iterative rework

**Files:**
- Modify: `src/worker.ts`, `src/review.ts` only if result typing requires it
- Test: `tests/lanes.test.ts`, `tests/worker.test.ts`, `tests/worker-review.test.ts`, `tests/model-fallback.test.ts`

**Interfaces:**
- Consumes: Task 1 policy and Task 2 execution facts.
- Produces: internal acceptance/review outcome `"retry"` means continue the claimed loop with the current session; `"open"` is reserved for a later scheduler attempt.

- [x] **Step 1: Add failing continuous tests.** Cover one-turn mechanical success, no-done escalation before the 40-turn budget, human final review, no-criteria quick human gate, and continuous review-fail escalation.
- [x] **Step 2: Add failing iterative tests.** Acceptance retry reuses the same-model session and its next prompt contains bounded exit/output/fingerprint feedback; review fail does the same; provider handover starts fresh; sticky escalation survives a later attempt.
- [x] **Step 3: Add the failing escalated-render test.** It must invoke review and reach a valid outcome rather than returning an unmatched string.
- [x] **Step 4: Run focused tests and record the current failures.**
- [x] **Step 5: Implement the smallest worker-loop change.** Load sticky state at claim; escalate continuous on missing done/failed evidence; write acceptance-failure notes before every permitted retry; resume unchanged-model sessions; keep review failure inside the claim; call `reviewStage` for escalated render. Preserve retry, stall, session and review-round bounds.
- [x] **Step 6: Run focused tests, then `npm test`.** Expected: all non-skipped PASS; no legacy assertion is preserved merely because it used to require a fresh session.
- [x] **Step 7: Commit `feat(worker): make execution adaptive and preserve rework context`.**

### Task 4: Review-pending and review-only recovery

**Files:**
- Modify: `src/worker.ts`, `src/reconcile.ts`, `src/cli.ts`
- Test: `tests/review-pending.test.ts`, `tests/reconcile.test.ts`, `tests/cli.test.ts`

**Interfaces:**
- Produces: `runTask(cfg, deps, task, workerId, {reviewOnly?: boolean})` (backward-compatible optional final argument).
- Runtime: `review-pending.json` records definition digest, artifact digest, evidence timestamps and bounded provider refusal facts.

- [x] **Step 1: Write failing reviewer-exhaustion tests.** After successful worker/acceptance, all reviewer providers refuse; assert blocked review-pending, no retry increment, and no second worker/acceptance call.
- [x] **Step 2: Write failing recovery tests.** `retry --review-only` runs only review after a settled claim; pass/unclear/fail follow normal gates; changed definition or artifact digest rejects without a reviewer; missing marker and uncertain attempt refuse.
- [x] **Step 3: Run focused tests and confirm current code reopens the worker.**
- [x] **Step 4: Implement review-pending writes and the optional review-only claimed path.** Reuse normal ownership/workspace reservation and validate digests before review. Clear the marker on an actual verdict; retain/update it while providers remain unavailable. Ordinary full retry archives the marker.
- [x] **Step 5: Run focused tests and full suite.** Expected: PASS; scheduler never interprets review-pending as permission to run a worker.
- [x] **Step 6: Commit `fix(review): preserve successful work through reviewer outages`.**

### Task 5: Enforced worker self-check command

**Files:**
- Create: `src/self-check.ts`
- Modify: `src/acceptance.ts`, `src/cli.ts`, `src/protocol.ts`
- Test: `tests/self-check.test.ts`, `tests/acceptance.test.ts`, `tests/protocol.test.ts`

**Interfaces:**
- Produces: `runSelfCheck({command, cwd, timeoutMs}): Promise<AcceptanceResult>` using generate mode.
- CLI: `taskctl check --task <id> [--tasks-dir <dir>]`, valid only for running task + active attempt + declared self-check.

- [x] **Step 1: Write failing CLI and timeout tests.** Cover wrong task state, missing declaration, generate environment, output record, and partial output retained on timeout.
- [x] **Step 2: Run focused tests and confirm the command/path is absent.**
- [x] **Step 3: Implement bounded self-check and partial-output capture.** Write `self-check.json`; never change task lifecycle or substitute for controller acceptance.
- [x] **Step 4: Run focused tests and acceptance cancellation regressions.** Expected: PASS.
- [x] **Step 5: Commit `feat(check): separate bounded worker checks from acceptance`.**

### Task 6: Shared cooldown and adapter reuse controls

**Files:**
- Create: `src/model-cooldown.ts`
- Modify: `src/worker.ts`, `src/models.ts`, `src/adapters/types.ts`, `src/adapters/opencode.ts`
- Test: `tests/model-cooldown.test.ts`, `tests/adapters/opencode.test.ts`, `tests/provider-variant.test.ts`, `tests/model-chain.test.ts`

**Interfaces:**
- Produces: `modelFor` skips unexpired shared refusals; `modelCooldownMs` defaults to 900000.
- Adapter additions: `sessionUsage?(sessionId)`, `canResumeSession?(sessionId, {model, cwd}): Promise<"reusable"|"active"|"unavailable">`.
- Catalogue entries contain both variants and context limit.

- [x] **Step 1: Write failing two-task cooldown tests.** A refused head is skipped by task B and by manual retry; expiry permits one probe; success clears it; all-cooling reports the next probe time without sleeping.
- [x] **Step 2: Write failing adapter and persisted-resume tests.** Repeated variant/context lookups spawn one `model.list`; reviewer resolution is variant-aware; different-model handover has no quota pause; idle/busy/not-found session statuses map to reusable/active/unavailable. A later settled attempt resumes only a matching reusable session; active blocks and unavailable starts fresh.
- [x] **Step 3: Run focused tests and confirm current repeated calls/pause/rotation behavior.**
- [x] **Step 4: Implement the atomic board-level cooldown store and adapter changes.** Unsupported reuse probes return unavailable; active blocks reconciliation, unavailable only disables reuse. Use cached catalogue data for `contextLimit`. Wire the probe into initial worker-loop session restoration from Task 2's `latestWorker` fact.
- [x] **Step 5: Run focused tests and model/review suites.** Expected: PASS, with fake API call counts as evidence.
- [x] **Step 6: Commit `perf(models): share refusal cooldown and discovery results`.**

### Task 7: Usage evidence and low-value I/O

**Files:**
- Create: `src/usage.ts`
- Modify: `src/worker.ts`, `src/review.ts`, `src/report.ts`, `src/artifacts.ts`, `src/cli.ts`, `src/workspace.ts`, `README.md`
- Test: `tests/usage.test.ts`, `tests/pipeline-e2e.test.ts`, `tests/artifacts.test.ts`, `tests/workspace.test.ts`

**Interfaces:**
- Produces: append-only `usage.jsonl` snapshots/deltas and reviewer session ID in `review.json`.
- Produces: coalesced board refresh with one trailing write and no-candidate sweep without Git.

- [x] **Step 1: Write failing usage/report tests.** Cover worker/reviewer roles, per-model totals, non-monotonic/unavailable snapshots and reviewer session ID.
- [x] **Step 2: Write failing I/O tests.** No new root candidate means no Git invocation; queued board events coalesce without losing the final state.
- [x] **Step 3: Run focused tests and confirm current behavior.**
- [x] **Step 4: Implement best-effort usage recording, report summaries, candidate-first sweep and board coalescing.** Fix the two `workspace.ts` nullable identity accesses without changing release identity checks. Update README semantics and self-check examples.
- [x] **Step 5: Run focused tests, `npm test`, and `npx tsc --noEmit`.** Expected: all non-skipped tests PASS and zero TypeScript errors.
- [x] **Step 6: Run `git diff --check` and `scripts/smoke.ps1` without `-Live`; record any unverified real-backend paths.** Commit `perf(runtime): record usage and remove repeated idle work`.

## Completion Evidence

- Focused red/green evidence for every task above.
- Full `npm test` and zero-error `npx tsc --noEmit` output.
- Structural counts proving: continuous avoids extra turns/review when declared, ordinary rework reuses sessions, reviewer outage creates no worker rerun, and cooldown/catalogue suppress duplicate provider/control-plane calls.
- X-Goldfish whole-change review after all planned phases, with findings challenged by its falsifier round.
