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

### Live validation (2026-11-24, authorized by the owner)

- `scripts/smoke.ps1 -Live`: **PASS** in 61 s on opencode 2.4.1 — claimed → acceptance passed → reviewing → reviewed pass → done, with worker and reviewer usage records. The smoke task had not declared `schema: taskctl/v1` since registration was introduced, so `-Live` would have run an empty board and then failed; fixed by `7be83f2`, which also made the offline mode check registration at no quota cost (removing the schema line exits 1).
- The first live run exposed that opencode 2.4.1 no longer reports a session's model on `session.get`. The reuse probe compared `undefined` with the expected model and answered `unavailable` for every session, so cross-task reuse and interrupted-session restore had never happened on the real backend, and usage was attributed to `(unknown)`. Fixed by `36c1333`: the model is read from the newest assistant message of `session.message.list` (shape verified live). Four regressions carrying the real payload failed before the fix; the reversed guard was killed.
- `scripts/live-phase2.ps1 -Live` (`277c60f`, hardened by `d0d5fe3` and `b423feb`): **15/15 checks PASS** in 146 s on opencode 2.4.1 with `opencode-go/hungerg-free`, after `05f9e96` and `dbb9127`. Verified on the real backend:
  - a two-task batch shares one session, with no `session-reuse-skipped` line;
  - usage is captured per task in that session (a 77,837 tokens, b 67,694);
  - `run` writes `tasks/<id>/logs/run-*.log` for both tasks;
  - `watch` takes the lock, discovers a task added while it is running through the filesystem event (claimed within about half a second), drains it, and exits 0 through `stop` with the lock released and the same per-task log;
  - the real `watch --resume` restarts a stopped queue, clears the stop request, and drains to exit 0.
- The same batch evidence was observed on `zhipuai-coding-plan/glm-5.3-flash`: one shared session, a at input 14,472 / cacheRead 27,584 and b at input 771 / cacheRead 44,288.
- Observed, not asserted: reuse trades input tokens for cache-read tokens, so its saving depends on cache pricing, and the backend reports `cost: 0` for both plan models, so `usage.jsonl` cannot show the saving in currency. A running session reports only `time.busy`; a finished one stamps `time.idle` (probed live at no model cost).
- Still not verified live: backend cancellation and interrupted-execution recovery, process signals, and a reviewer timeout on a real backend.

### EGM review (2026-11-24)

The owner asked for an Elephant-Goldfish review of the current implementation: the design document and the watch-batch plan, with the README and the source checked against both, through the five review stages with no checkpoint pauses. The reports live outside the repository, in the review's run directory under the session temp folder (private): `consolidated_review_report.md`, one report per stage, and the reviewers' output verbatim. Recorded here is the outcome and its evidence.

- **190 raw findings from 11 completed dispatches over 8 reviewer roles.** Two first dispatches returned an account rate limit and were retried once. Stage 8 was dispatched twice: the first could not open the earlier stage reports, so its re-verification table was empty; the retry, given copies inside the working directory, completed it. The findings consolidate into 38 action items: 12 fixed in code, 1 corrected in documentation, 13 that need an owner decision, 12 of engineering backlog. The mapping was checked by script — every id in the raw reports belongs to at least one action item.
- **Reviewers read; they did not run.** Every failure trace in a raw report is derived by reading. Each finding below that led to a change was reproduced first.
- Stages 5, 6, 7 and 9 read the code at `7be83f2`–`d0d5fe3`; fixes were fast-forwarded into `main` between 21:04 and 21:37 while the last reviewers were finishing. Stage 8 read `d3b6172` and re-verified the Stage 5 findings against it: of their 19 Blockers and Majors, 2 resolved, 6 partially resolved, 11 still open, 9 of those owner decisions.

**Fixed from Stages 5, 7 and 9** — each with a regression that failed before it and directed mutations that its tests kill:

| Commit | What was wrong |
| --- | --- |
| `4083375` | A controller error inside one task (a reviewer timeout with a confirmed shutdown, a cooldown beginning at acceptance, a backend that cannot be spawned) aborted `run`/`watch` and left a false `uncertain` record with the workspace reservation leaked. It is now confined to the task; `run` drains the board and exits 1. |
| `dbb9127` | `resume` was missing from `BOOLEAN_FLAGS`, so the documented `watch --resume` exited 2. The production `fs.watch` had no `error` listener. |
| `05f9e96` | The reuse probe failed open on an unrecognised reply, and a failed `model.list` was cached for the life of the process. |
| `d118b76` | An unreadable context budget was reported as a silent `false`. |
| `a031a48` | A timed-out turn left the session recorded as clean; the cooldown note and the parked reviewer model were untruthful; the self-check default could exceed the turn bound. |
| `9f1e51a` | `taskctl check` read the workspace and the bound from the caller's cwd; review-only recovery ignored the task's `workdir` and wrote no per-task log. |
| `ab2d015` | A malformed task file, a mid-flight validation error or a lost race ended the watcher. |
| `d3b6172` | README and plans corrected against the code. |

**Fixed from Stage 8:**

| Commit | What was wrong | How it was known |
| --- | --- | --- |
| `fd6507e` | `modelFor` removed the cooling models from the chain and then indexed what was left with an index into the full chain. With three or more models, a partially expired cooldown sent the task back to a model it had been refused on, and the next refusal blocked it as quota-exhausted while a model was healthy. | Derived by reading in the review, then confirmed by regressions that ended `blocked` before the fix. No existing test could see it. |
| `4dc22c8` | Review-only recovery showed the reviewer the recovery attempt's window, so all of the work read as older than the execution. | Regressions red before the fix. |
| `2a52084` | Ten file replaces used a bare rename, and both heartbeat loops read a failed write as ownership loss: a refused rename cancelled the running turn and spent a retry, or blocked the task as quota-exhausted. | Not only read. Observed on this machine — `EPERM` on `lock.json.tmp -> lock.json` — with one test file failing 3 of 45 runs; 0 of 45 after the fix. |
| `ca8760e` | The cooldown note written by `a031a48` claimed an exhausted retry budget on every path, none of which exhausts it. | Caught by the Stage 8 retry; the pinning test's own numbers were the counter-example. |

**Twice a mutation survived its first run** (`4dc22c8`, `2a52084`). Both times the fault was in the new regression — one could not say which of the two heartbeat sites had been refused, one did not pin that a lost lock still ends the attempt — and it was rewritten until each mutation is killed by the test written for it. The 42 mutation records for the fixes of this review are kept in the private file beside those of the earlier rounds.

**Gates at `ca8760e`:** `npm test` **657 passed / 1 skipped** over 67 files; `npx tsc --noEmit` exit 0; `git diff --check` clean; `scripts/smoke.ps1` and `scripts/live-phase2.ps1` in offline mode passing. `tests/` is outside the `tsconfig` include, so `tsc` does not type-check the tests.

**Live rerun on the merged code** (the same two scripts, the same free model, no quota): `scripts/smoke.ps1 -Live` PASS in 40 s; `scripts/live-phase2.ps1 -Live` 15/15 PASS in 171 s. The Stage 8 fixes change paths that every dispatch takes, which is why the matrix was rerun. Not covered live: any refusal or cooldown path, so `fd6507e` rests on offline evidence.

**Left for the owner, in order** (options and detail: the consolidated report, section 5; the current list: `2026-11-24-handoff.md`):

1. The shared cooldown policy — the review's one Blocker that is not a defect: any provider refusal parks the task after one failed turn and the board for 15 minutes.
2. Escalation and render feedback never reach the worker.
3. §16 lane classification reverses ADR-0008/0009 with no supersession.
4. Blocked tasks are never revisited by watch.
5. `stop` granularity and process signals.
6. The batch `active` probe.
7. The worker never sees the spec or the criteria.
8. The context budget before a restored or shared dispatch.
9. A cooldown switching the model mid-session.
10. Automatic grouping on by default without evidence of a saving.
11. Where the self-check bound is enforced.
12. `reject` under watch.
13. The design document.

**Corrections this round made to its own record:** two count errors in the Stage 9 report, a false sentence in a note written by an earlier fix (`ca8760e`), and the claim in `docs/backlog.md` that `tsc` never ran here.

### Test loop (2026-11-25)

A round on the test loop itself. One dispatch path changed: a file replace whose destination is a directory now fails at once.

- **Type-checking the tests (`5487df1`).** `tsconfig.json` includes only `src`, so nothing under `tests/` had ever been type-checked. `tsconfig.test.json` extends it to `tests/`, `scripts/` and `vitest.config.ts`, and `npm run typecheck` runs it. It reported 46 errors in ten test files, all on the test side: a store double without the `incReviewRounds` its interface requires, fixtures and doubles without fields their types require, union members read before narrowing. The fixes were made by a subagent under written constraints (tests only; no assertion removed or weakened; no value passed to production code changed; no cast or suppression; report anything that would need `src/`) and checked independently: the check was re-run, the removed assertion lines were counted per file (0), the test inventory was compared before and after (only the two intended additions), and the diff was read.
- **Two waits a test no longer sits through.** The stale-mutex test waited out the production wait of five seconds; `reserveWorkspace` takes an optional wait and the test passes sixty milliseconds (`ed3d391`), 5051 ms to 143 ms. The rotation test puts a directory where `models.json` belongs; Windows refuses that rename with the same `EPERM` as a busy destination, so the helper retried it for the whole 3.9 s budget. It now gives up at once when the destination is a directory (`aed2cb2`), 4091 ms to 138 ms. The regression was red before the fix with six attempts. A destination that does not exist yet is still retried; a second regression pins that.
- **Mutation checks.** Mutex wait: five, all killed. Replace: nine, all killed. One result had to be redone: the mutant meant to never give up was written as `Date.now() !== Date.now()`, which is two calls and true whenever the clock ticks between them, so it looked as if it had survived; written as a constant it is killed by the stale-mutex test. The bounded-retries test had to change how it waits, because the lookup between two waits is real I/O the faked clock cannot deliver. Its assertions are unchanged, and it kills one retry more, one fewer and an unbounded schedule.
- **Workers (`a04d19d`).** Two, three and four workers each ran the suite five times without a failure, alternating, at a median of 61 s, 43 s and 33 s. Four is committed. The evidence is five runs on one machine.
- **Gates at `a04d19d`:** `npm test` **659 passed / 1 skipped** in 32 s; `npm run typecheck` exit 0; `npx tsc --noEmit` exit 0; `git diff --check` clean; `scripts/smoke.ps1` and `scripts/live-phase2.ps1` in offline mode exit 0. Not run live again: the round changed no dispatch path, and the offline modes only prepare the environment and check registration.
- **Left as it was.** `tests/board-stress.test.ts` keeps its 50 rounds: it exists for a failure that showed in 2 of 10 runs, and fewer rounds is a looser net. In `tests/acceptance-fingerprint.test.ts` four breaker cases call `sameFailure` without a root, so their output contains the literal `undefined\tests\run_bio.m`; harmless, noted.

### The `2a52084` leftovers (2026-11-25), first piece

Of the two items that share a root with `2a52084`, one half is done.

- **The cooldown table is not rewritten for nothing (`b687d57`).** Every successful dispatch calls `clearModelCooldown` for the model that just worked, and it always created the directory, took the lock, read the table and wrote it back, nearly always unchanged. It now looks first and returns when the model has no entry: one read instead of a lock and a rewrite on an ordinary successful turn. The regression was red before the fix (the directory was created). A mutation then survived: nothing pinned that clearing one model leaves every other refusal in place, although the function's comment says "only". A second regression closes that gap; five mutations are killed.
- **Gates at `b687d57`:** `npm test` **661 passed / 1 skipped** in 32 s; `npm run typecheck` exit 0; `npx tsc --noEmit` exit 0; `git diff --check` clean. The offline smoke scripts were not re-run after `a04d19d`; the change since is the one above.
- **Still open, both confirmed by reading only.** (1) The other half of the cooldown item: the review filed that a failed write of the table voids a turn that had already finished. The writes at `noteRefusal` and at the two `clearModelCooldown` calls in `src/worker.ts` carry no guard of their own; what encloses them has not been traced. (2) Fault isolation is one level deep. In the `catch` of `runTask` all three branches end in `block()`, and a failure inside it escapes `runTask`; and in the controller-error branch a failed `checkpoint` leaves the record `active`, so `finally` does not release the workspace reservation although the branch's own comment says the workspace is free. Each needs a failing regression before any change.
