# Phase 2 Review Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Close X-Goldfish findings A1–A7 without adding features, then repeat offline gates and the complete independent review from FixedPoint `6906383`.

**Architecture:** Keep the existing batch/watch/worker boundaries. Make batch preamble lifetime independent of cross-task resume candidates, make watch scheduling explicitly distinguish progress, waiting and stopping, and journal missing resume-probe capability before fresh-session fallback. Prove the enumerated acceptance clauses through `runCli`; retain direct API tests only where they provide focused race or guard coverage.

**Tech Stack:** TypeScript, Node.js 22+, Vitest, existing `runCli`/`watchQueue` test seams.

**Spec:** `docs/superpowers/specs/2026-11-24-adaptive-execution-design.md` §13 and §15.1 items 11/15; `docs/superpowers/plans/2026-11-24-watch-batch.md`; X-Goldfish report `~/.xg-reviews/task-manager/20261124T071920Z/code_review_report.md`.

## Global Constraints

- Do not run `scripts/smoke.ps1 -Live` or any real-backend verification without explicit user authorization.
- Do not commit `.codegraph/` or `docs/superpowers/plans/2026-11-24-handoff.md`.
- Automatic batches retain the contiguous eligible prefix of `ready()` and never skip an earlier ineligible task.
- Each A1–A4 test must fail on `d288964` for the stated reason before its production fix.
- Mutation checks use a clean control, one reversed guard at a time, and a private JSON report outside the repository. A surviving mutation requires a stronger direct assertion and a rerun.
- Offline evidence is not live-backend proof.

## Review Focus

- An `open` retry must retain the current-task/completed-task preamble while restoring only the current task's own session (Task 1).
- Stop or heartbeat loss during an awaited board read must produce zero ordinary claims (Task 3).
- An adapter without `canResumeSession` must still produce a durable skip reason before a fresh turn (Task 4).
- Idle CLI watches must make no prompt, execution, model-resolution, context, usage or resume-probe calls (Task 5).
- Real-CLI proof must include both eligible grouping and an ineligible head that is not skipped (Task 5).

---

### Task 1: A1 — retain batch preambles on retries

**Files:**
- Modify: `src/batch.ts`
- Test: `tests/batch-session.test.ts`

**Interfaces:**
- Consumes: `RunTaskOptions.batch.preamble` and optional `resumeFrom`.
- Produces: `preamble` on every batch attempt; `resumeFrom` only on a task's first attempt.

- [x] **Step 1: Extend the open-retry regression test**

In `uses the current task's own session on an open retry, not the batch candidate`, assert both `b` prompts contain `当前任务：b`, `前面已完成：a`, and `不要重做`; retain the existing session assertions `[undefined, undefined, "fresh-b"]`.

- [x] **Step 2: Verify the test fails before the fix**

Run: `npx vitest run tests/batch-session.test.ts`
Expected: FAIL because the second `b` prompt lacks the batch preamble.

- [x] **Step 3: Separate option lifetimes**

In `runBatch`, always pass `{ batch: { preamble } }`; add `resumeFrom: previousWorker` only when `attempt === 1` and a candidate exists. Do not change ordinary same-task restoration.

- [x] **Step 4: Verify and mutation-check**

Run the focused test, then temporarily restore first-attempt-only preamble behavior. Expected: the new assertion fails; restore the fix and rerun for a clean control. Record the mutation in the private JSON report.

- [x] **Step 5: Commit**

Commit only the plan, `src/batch.ts`, and `tests/batch-session.test.ts` with a `fix(batch)` message.

### Task 2: A2 — wait after an `open` watch outcome

**Files:**
- Modify: `src/watch.ts`
- Test: `tests/watch.test.ts`

**Interfaces:**
- Produces: `scheduleOnce(): Promise<"worked" | "wait" | "stopped">`; `open` and `skipped` map to `wait`, not `worked`.

- [x] **Step 1: Write the failing scheduling test**

Inject `runOne` returning `open`. After the first call, prove no second call occurs before an explicit filesystem wake; wake once, let the second call request stop, and assert exactly two bounded calls.

- [x] **Step 2: Verify the test fails before the fix**

Run: `npx vitest run tests/watch.test.ts`
Expected: FAIL because the second call happens without the explicit wake.

- [x] **Step 3: Implement explicit scheduling results**

Change the boolean result to the union above. Only `worked` immediately refreshes the snapshot; `wait` awaits an event/fallback. Task 3 owns the `stopped` branch.

- [x] **Step 4: Verify and mutation-check**

Run the focused test. Reverse only the `open` mapping to `worked`; expect the new test to fail, then restore and rerun.

- [x] **Step 5: Commit**

Commit `src/watch.ts` and `tests/watch.test.ts` with a `fix(watch)` message.

### Task 3: A3 — recheck stop/ownership before ordinary claims

**Files:**
- Modify: `src/watch.ts`
- Test: `tests/watch.test.ts`

**Interfaces:**
- Consumes: `stopOrLost()` and Task 2's `scheduleOnce` union.
- Produces: a `stopped` result before ordinary `runOne` when stop/ownership loss appears during selection.

- [x] **Step 1: Write two failing race tests**

Block the first `store.list()` with a deferred. Inject stop in one test and watch-lock loss/heartbeat diagnosis in the other, then release the board read. Assert the injected ordinary `runOne` call count is zero; stop exits gracefully and ownership loss rejects with `ownership`.

- [x] **Step 2: Verify both tests fail before the fix**

Run: `npx vitest run tests/watch.test.ts`
Expected: FAIL because each race reaches the ordinary runner once.

- [x] **Step 3: Add the immediate pre-claim check**

Immediately before ordinary `runOne`, await `shouldStop()` and return `stopped` when true. In the outer loop, return gracefully for stop and throw the saved ownership error for loss; do not cancel an active attempt.

- [x] **Step 4: Verify and mutation-check**

Run the focused tests. Remove only the immediate pre-claim check; expect both race tests to fail, then restore and rerun.

- [x] **Step 5: Commit**

Commit `src/watch.ts` and `tests/watch.test.ts` with a `fix(watch)` message.

### Task 4: A4 — journal unavailable resume probes

**Files:**
- Modify: `src/worker.ts`
- Test: `tests/batch-session.test.ts`

**Interfaces:**
- Consumes: a clean, model-bearing persisted or `batch.resumeFrom` candidate.
- Produces: `session-reuse-skipped` with an unavailable-probe reason before fresh dispatch when `canResumeSession` is absent.

- [x] **Step 1: Write the missing-capability regression**

Run a two-task batch with an adapter that omits `canResumeSession`. Assert both turns start without a session, no probe is possible, and task `b` has one `session-reuse-skipped` journal entry naming `ses-shared` and the unavailable capability.

- [x] **Step 2: Verify the test fails before the fix**

Run: `npx vitest run tests/batch-session.test.ts`
Expected: FAIL because the journal entry is absent.

- [x] **Step 3: Reorder candidate validation and capability handling**

Keep dirty/model-less and non-settled ordinary candidates ineligible. Preserve known cross-task model-mismatch journaling, then journal missing probe capability as unavailable before returning `undefined`; leave `active` and `reusable` handling unchanged.

- [x] **Step 4: Verify and mutation-check**

Run the focused tests. Restore the early return only for missing probe capability; expect the journal assertion to fail, then restore and rerun.

- [x] **Step 5: Commit**

Commit `src/worker.ts` and `tests/batch-session.test.ts` with a `fix(worker)` message.

### Task 5: A5/A6/A7 — complete CLI evidence and deduplicate fixtures

**Files:**
- Modify: `src/cli.ts` only if a watch-store observation seam is needed for real-CLI scan counts
- Test: `tests/batch-session.test.ts`, `tests/batch-flow.test.ts`, `tests/watch.test.ts`, `tests/watch-batch.test.ts`
- Modify: `tests/helpers/task-fixture.ts`

**Interfaces:**
- Produces: `buildContinuousTask(id: string, overrides?: Partial<Task>): Task` from the existing fixture helper.
- Real-CLI watch tests may inject a `TaskStore` through `CliDeps` solely to count scheduling scans; production still constructs `TaskStore` when absent.

- [x] **Step 1: Route item 11 clauses through `runCli`**

Use `run --batch a,b,... --config <file>` for safe shared session, independent acceptance, blocked/awaiting-human stop, and model-mismatch tests. Retain direct `runBatch` only for run-seam-specific retry/dirty-fact tests. Existing `batch-flow` tests must continue proving initial and mid-batch workdir rejection before claim.

- [x] **Step 2: Route item 15 clauses through `runCli`**

Cover the matrix with `watch --config` plus deterministic `CliDeps.watch`: discovery, idle, burst, second watcher, active-turn graceful drain, eligible grouping, ineligible-head ordering, and arrival at a boundary. Use real `stop --tasks-dir` where the clause is graceful drain.

- [x] **Step 3: Assert complete idle adapter silence**

For the real-CLI idle test, instrument `prompt`, `start`, `resolveModel`, `contextUsage`, `contextLimit`, `sessionUsage`, and `canResumeSession`. Observe at least two scans/fallback wakeups and assert the complete call log is empty before and after stop.

- [x] **Step 4: Extract the continuous-task fixture**

Replace all four local identical `task` factories with `buildContinuousTask`; leave test-specific overrides unchanged.

- [x] **Step 5: Verify the evidence suites**

Run: `npx vitest run tests/batch-session.test.ts tests/batch-flow.test.ts tests/watch.test.ts tests/watch-batch.test.ts`
Expected: PASS with no direct-API-only gaps in the item 11/15 matrix and an empty full idle adapter log.

- [x] **Step 6: Commit**

Commit the evidence/fixture changes with a `test(phase2)` message. Include the clause-to-test matrix in the commit evidence, not as a claim of live verification.

### Task 6: Final offline gates and independent re-review

**Files:**
- Modify: this plan with exact evidence and any remaining limitations

- [x] **Step 1: Run all offline gates**

Run `npm test`, `npx tsc --noEmit`, `git diff --check`, and `scripts/smoke.ps1` without `-Live`. Confirm `.codegraph/` and the handoff remain uncommitted.

- [x] **Step 2: Run the complete X-Goldfish workflow**

Use FixedPoint `6906383`, the new HEAD, the same spec sources, and `README.md + docs/adr/*.md` as standards. Run fresh standards and spec reviewers, then drop-only falsification; write all reports under a new `~/.xg-reviews/task-manager/<utc>/` directory.

- [x] **Step 3: Close or report findings**

Any surviving runtime/evidence finding returns to the owning task. Only an offline-clean review may be called offline acceptance; real OpenCode reuse/probe/usage remains explicitly unverified until separately authorized.

- [x] **Step 4: Record the verified outcome**

Update this plan with test counts, gate results, review verdict and report path. File the durable outcome in MemPalace and read it back. Ask separately before any bounded Live run, push, handoff commit or `.gitignore` decision.

## Evidence (2026-11-24, offline only)

- Commits: `3ded6c7` A1; `a984e99` A2; `b070a58` A3; `635303f` A4; `80050da` A5/A6/A7.
- A1–A4 mutation checks were each run against one reversed guard and killed; the clean controls were rerun after restore. Private report: `<local temp>/opencode/phase2-review-remediation-mutations.json`.
- Real-CLI matrix status: §15.1 item 11 is covered through `run --batch --config` for safe sharing, independent acceptance, blocked and awaiting-human stop, model mismatch, initial mixed-workdir rejection, and mid-batch workdir rejection. §15.1 item 15 is covered through `watch --config` and/or real `stop --tasks-dir` for discovery, idle silence, burst coalescing, second-watcher refusal, graceful active-turn drain, eligible grouping with an ineligible head, and boundary arrival.
- The real-CLI idle test records `prompt`, `start`, `resolveModel`, `contextUsage`, `contextLimit`, `sessionUsage`, and `canResumeSession`, observes multiple scheduling scans, and asserts the entire adapter call log is empty.
- Final pre-review offline gates: `npm test` 615 passed / 1 skipped across 63 files; `npx tsc --noEmit` clean; `git diff --check` clean; `scripts/smoke.ps1` without `-Live` passed.
- No live backend, provider, or `-Live` verification was run. This evidence is offline only.

### First re-review and Nit closure

- First remediation re-review (`6906383...09e5f7d`): **CHANGES REQUESTED**, 0 Blockers, 0 Majors, 3 Nits. Report: `~/.xg-reviews/task-manager/20261124T091401Z/code_review_report.md`.
- Its A1/A2 duplicates were closed by `83c7442` and `25d970e`; its A3 evidence contradiction was closed by `4fec2a4`.
- Post-Nit offline gates at `4fec2a4`: 70 focused batch/watch tests passed; `npm test` 615 passed / 1 skipped across 63 files; `npx tsc --noEmit` clean; `git diff --check` clean; `scripts/smoke.ps1` without `-Live` passed. No live backend was run.

### Final review closure and accepted stopping rule

- The third re-review found a real Major: automatic batches re-entered after an exhausted `open` result. Fixed by `984f90f`; regression `waits after an exhausted open batch` failed before the fix, the reversed mapping was killed, and the restored control passed.
- Its companion readiness duplication and the fourth review's fixture duplication were closed by `984f90f` and `4675495`.
- Fifth review (`6906383...4675495`): Spec lens passed with zero findings across 23 traced requirements. Standards lens returned two Nit-only test-organization findings, both survived falsification.
- Owner stopping rule recorded 2026-11-24: Blockers and Majors gate offline acceptance; Nit-only standards findings are accepted quality debt and do not force another review round. Protocol verdict remains **CHANGES REQUESTED**, offline acceptance under the amended gate is **accepted**.
- Final review report: `~/.xg-reviews/task-manager/20261124T095854Z/code_review_report.md`.
- Final offline gates at `4675495`: 71 focused batch/watch tests passed; `npm test` 616 passed / 1 skipped across 63 files; `npx tsc --noEmit` clean; `git diff --check` clean; `scripts/smoke.ps1` without `-Live` passed. Real OpenCode reuse/probe/usage remains unverified.

### Sixth and seventh review rounds: evidence parity, decision record, seam wiring

- Sixth review (`755260a...2fcc2e0`, 22 commits; `755260a` is the rewritten-history equivalent of `6906383`): 0 Blockers, 0 Majors, 2 Standards Nits survived. Report: `~/.xg-reviews/task-manager/20261124T101349Z/code_review_report.md`.
- **Owner decision (2026-11-24, sixth review S2 promotion):** task-manager is the foundation module for autonomous agent judgment, so every entry point must leave the same machine-readable evidence for the same task. `watch` therefore writes the same per-task controller event log as `run`: each worker event line lands in `tasks/<id>/logs/run-<ISO>.log` (one file per controller session) unless `--log` redirects the tee. This decision supersedes the watch-batch plan's narrower "extract only the small controller setup" scope for this behavior; the README `watch` row documents it.
- Sixth S2 was implemented by `6e889a4`: shared controller telemetry (`createControllerTelemetry`/`createWorkerDeps`), watch per-task `run-*.log` parity, review-seam forwarding for watch.
- Seventh review (`2fcc2e0...5dc5b42`): 0 Blockers, 2 Majors, 1 Nit survived falsification (0 dropped). Report: `~/.xg-reviews/task-manager/20261124T113002Z/code_review_report.md`.
  - P1 (scope-creep: the watch log behavior had no spec source) is closed by recording the owner decision in this section plus the README watch-row documentation; the code behavior is unchanged from `6e889a4`.
  - P2 + S1 were closed by `5d8c87a`: `createWorkerDeps` forwards `CliDeps.review` whenever defined, matching `retry --review-only`, and a human-verified task through the real `run` CLI asserts `reviews === 1`. Failing regression confirmed pre-fix (the human task crashed on the default review path with the seam unforwarded); the reversed-guard mutation was killed and the restored control passed.
- The sixth review's S1 (test scaffolding duplication) was closed by `5dc5b42`: shared `seedTaskFile`, `createStopRequests`, wait aliases, and a `batchMaxTasks`-aware `writeBatchConfig`.
- Post-seventh-round offline gates at `5d8c87a`: `npm test` 617 passed / 1 skipped across 63 files; `npx tsc --noEmit` clean; `git diff --check` clean. No live backend, provider, or `-Live` verification was run.
