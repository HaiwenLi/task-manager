# Durable Watch and Continuous Batches Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add explicit continuous batches and a durable watch queue that reuse a safe worker session across task boundaries without weakening any per-task claim, acceptance, review, or human gate.

**Architecture:** A new `src/batch.ts` validates the whole ordered selection and drives the existing `runTask` sequentially; a batch-only option carries the previous task's cleanly settled session and the batch preamble. A new `src/watch.ts` owns one board-level lock, wakes on filesystem events plus a fallback, and delegates single tasks and eligible groups to the same execution path. Neither entry point creates a mega-task or defers acceptance.

**Tech Stack:** TypeScript, Node.js 22, Vitest; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-24-adaptive-execution-design.md` §7.2, §8.4, §13, §15.1 items 11 and 15, §17, §18 Phase 2.

## Global Constraints

- A batch is only a scheduler policy: every task keeps its own claim, fencing generation, definition snapshot, `acceptance.json`, required review, terminal state, sessions, and usage records.
- `run --batch` validates every selected id before the first claim, runs exactly the given order, and never claims an unselected task. Re-read the board and compare the definition digest and resolved workdir before **every** claim, including an `open` retry of the current task.
- A current task that review returns to `open` is retried before any later selected task. `blocked`, `awaiting-human`, `skipped`, or an exhausted `open` loop stops the batch; later ids remain unclaimed.
- Cross-task reuse requires the previous task to be `done` and settled, a clean recorded worker session, matching actual model and canonical workdir, and `canResumeSession === "reusable"`. `active` blocks for reconciliation; mismatch or `unavailable` starts fresh and journals why.
- Prepend the batch preamble at the worker call site. Do not change `buildWorkerPrompt`: non-batch protocol output must remain byte-for-byte pinned by `tests/protocol.test.ts`.
- Watch has one owner via `tasks/../.taskctl/watch.lock`. A live second watcher is refused; a stale or corrupt record is diagnosed, not stolen. Heartbeat loss stops new claims.
- Idle watch does no model calls, artifact digest, or board rewrite. Use `fs.watch` with 250 ms debounce plus a 30 s fallback; reuse the adapter, store, model catalogue, and cooldown table.
- `stop` never kills a process tree. The current `runTask` attempt settles, no later task is claimed, records are released, and `stop.requested` remains on disk. Only an explicitly resumed watch removes it, and only after acquiring the watch lock.
- Automatic grouping follows board order and never skips over an earlier ready task: take the contiguous eligible prefix from `ready()`; an ineligible head runs alone. New arrivals join only at the next scheduling boundary.
- `batchMaxTasks` is a positive integer, default `5`; `1` disables automatic grouping but not manual `run --batch`.
- Every behavior starts with a failing test. Mutation checks reverse one guard at a time, use a fresh private JSON report, and are valid only after a clean unmutated control run and a clean restore.
- Do not add `.codegraph/` or the handoff document to feature commits. Do not run `scripts/smoke.ps1 -Live`; real-backend verification needs explicit user authorization.

## Review Focus

1. A task deleted, edited, or moved to another workdir between selection and its turn must be rejected before claim, even when an earlier task already finished (Task 2 tests).
2. A previous batch session that is dirty, model-mismatched, unavailable, or still active must never be continued blindly; in particular, `active` blocks rather than starting a competing worker (Task 3 tests).
3. Sharing one backend session must not share task evidence: prompts name the current task, env points at that task's directories, and acceptance/session/usage records remain independent (Task 3 tests).
4. A stop request arriving while work is active must not kill the worker or clear itself; a second watcher, including one with `--resume`, must not clear the first watcher's stop request (Task 4 tests).
5. Automatic grouping must not let two later eligible tasks jump an earlier high-risk, human-gated, iterative, dependency-waiting, or otherwise ineligible ready task (Task 5 tests).

## File Structure

- **Create `src/batch.ts`** — static and runtime eligibility, whole-selection validation, ordered sequential execution, automatic-prefix selection, batch preamble, and the batch result type.
- **Modify `src/worker.ts`** — extend `RunTaskOptions` with batch-only preamble/resume input; leave ordinary same-task restoration and all non-batch output unchanged. Add `batchMaxTasks` to `WorkerConfig`.
- **Create `src/watch-lock.ts`** — board-level create/heartbeat/release with the same owner-generation discipline as task locks, but explicit stale/corrupt diagnosis instead of takeover.
- **Create `src/watch.ts`** — durable event loop, stop/resume handling, in-flight priority, and delegation to `runTask` or `runBatch`.
- **Modify `src/cli.ts`** — `run --batch`, `watch`, `stop`, usage text, and `batchMaxTasks` config parsing. Extract only the small controller setup needed to avoid three divergent copies.
- **Create tests** — `tests/batch.test.ts`, `tests/batch-flow.test.ts`, `tests/batch-session.test.ts`, `tests/watch.test.ts`, `tests/watch-batch.test.ts`; extend `tests/cli-config.test.ts`.

---

### Task 1: Batch eligibility and whole-selection validation

**Files:**
- Create: `src/batch.ts`
- Test: `tests/batch.test.ts`

**Interfaces:**
- Consumes: `Task`, `taskWorkdir`, `assertAcyclic`, `draftAncestor`, `readAttempt`, and `lockLive`.
- Produces:

```ts
export class BatchValidationError extends Error {
  constructor(readonly issues: string[]);
}

export function batchEligibility(
  task: Task,
  board: Task[],
  earlier: ReadonlySet<string>,
): string | null;

export async function validateBatchSelection(
  cfg: WorkerConfig,
  ids: string[],
  board: Task[],
): Promise<Task[]>;
```

`validateBatchSelection` returns tasks in exactly `ids` order or throws one error containing **all** issues. Static rejection covers empty/duplicate/unknown ids, non-`open` status, non-continuous execution (using the same `simple` derivation as the worker), `verify: human`, high risk, `humanCheck`, a draft ancestor, mixed resolved workdirs, and dependencies that are neither `done` nor earlier in the selection. Runtime rejection covers a live task lock and any previous attempt whose phase is not `settled`; a first attempt with no previous record is allowed. Different models are allowed.

- [x] **Step 1: Write the failing validation tests**

Use `buildTaskFile` for the pure table and a temporary `TaskStore` for attempt/lock cases. Include one valid two-task selection where `b.dependsOn = ["a"]`, plus a rejection for a dependency that appears later. Include two different models in the valid case.

- [x] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run tests/batch.test.ts`
Expected: FAIL because `src/batch.ts` does not exist.

- [x] **Step 3: Implement validation**

Call `assertAcyclic(board)` before evaluating the selection. Collect issues in selection order; do not throw on the first bad task. `validateBatchSelection` performs no claim and no adapter call.

- [x] **Step 4: Run tests and mutation-check the gates**

Run: `npx vitest run tests/batch.test.ts tests/cli-config.test.ts`
Expected: PASS. Reverse, one at a time, the workdir comparison, dependency-order check, human/risk weakening guard, and unsettled-attempt rejection; each named test must fail, with a clean control first and the source restored afterwards.

- [x] **Step 5: Commit**

```bash
git add src/batch.ts tests/batch.test.ts
git commit -m "feat(batch): validate a continuous selection before claiming it"
```

### Task 2: Sequential batch execution and `run --batch`

**Files:**
- Modify: `src/batch.ts`, `src/cli.ts`
- Test: `tests/batch.test.ts`, `tests/batch-flow.test.ts`

**Interfaces:**
- Consumes: Task 1 validation and the existing `runTask`, `passBudget`, `definitionDigest`, and `WorkerDeps`.
- Produces:

```ts
export type BatchResult = {
  done: string[];
  stoppedAt?: string;
  outcome?: TaskOutcome | "stop-requested";
  pending: string[];
};

export type BatchRunOptions = {
  run?: typeof runTask;
  shouldStop?: () => Promise<boolean>;
};

export async function runBatch(
  cfg: WorkerConfig,
  deps: WorkerDeps,
  ids: string[],
  options?: BatchRunOptions,
): Promise<BatchResult>;
```

`runBatch` itself performs the initial fresh-board validation so no caller can bypass it. Before each `runTask`, it re-reads the board and requires the selected id, original definition digest, and original resolved workdir. A mismatch throws `BatchValidationError` before that claim. Only an `open` outcome is retried, on the same task, bounded by `passBudget(1, cfg)`; `shouldStop` is checked before every new attempt.

- [x] **Step 1: Write failing order, stop, and mid-batch drift tests**

Cover: input `["a","b"]` runs `a,b` even when board order is `b,a`; an unselected ready `c` is never offered; any initial rejection means zero runner calls; `blocked`, `awaiting-human`, and `skipped` leave later ids pending; `open` then `done` finishes `a` before `b`; and deleting `b` or changing its workdir after `a` finishes prevents `b`'s claim.

- [x] **Step 2: Write the failing real-CLI two-task test**

In `tests/batch-flow.test.ts`, run `runCli(["run","--batch","a,b","--config",...])` with a fake adapter that obtains the id from the prompt's `taskctl done --task <id>` command and writes that task's `done.requested`. Assert two prompts in order, two independent `tasks/<id>/acceptance.json` files, and no review for simple mechanical continuous tasks.

- [x] **Step 3: Run the new tests and confirm they fail**

Run: `npx vitest run tests/batch.test.ts tests/batch-flow.test.ts`
Expected: FAIL on missing `runBatch` and on `run` rejecting `--batch`.

- [x] **Step 4: Implement the runner and command**

Add `batch` to the existing `run` flags. Keep normal `run` on `runScheduler`; the batch branch uses the same adapter/store/event logging/board refresh and returns a nonzero exit for validation failure. Log a stopped batch with its unclaimed ids rather than printing an all-done summary.

- [x] **Step 5: Run focused tests and mutation-check**

Run: `npx vitest run tests/batch.test.ts tests/batch-flow.test.ts tests/scheduler.test.ts tests/protocol.test.ts`
Expected: PASS. Mutation targets: no fresh-board re-read, no digest/workdir comparison, continuing after a non-`done` outcome, retrying a later task instead of the current `open` one, and the CLI falling through to `runScheduler`.

- [x] **Step 6: Commit**

```bash
git add src/batch.ts src/cli.ts tests/batch.test.ts tests/batch-flow.test.ts
git commit -m "feat(batch): run an explicit selection in order"
```

### Task 3: Safe cross-task session continuation and per-task evidence

**Files:**
- Modify: `src/worker.ts`, `src/batch.ts`
- Test: `tests/batch-session.test.ts`, `tests/session-resume.test.ts`, `tests/protocol.test.ts`

**Interfaces:**
- Consumes: `WorkerSessionFact`, `readExecutionState`, the adapter reuse probe, and Task 2's sequential runner.
- Produces:

```ts
export type RunTaskOptions = {
  reviewOnly?: boolean;
  batch?: {
    preamble: string;
    resumeFrom?: WorkerSessionFact;
  };
};
```

`runBatch` builds a preamble naming the current task and previously completed selected tasks and warning not to redo them or edit their definitions. After a `done` outcome it reads that task's `latestWorker`; a clean fact with a model becomes the **next task's first-attempt only** `resumeFrom`. `open` retries use ordinary same-task restoration.

- [x] **Step 1: Write the failing one-session/two-evidence test**

Use two simple mechanical tasks with model `w/one`. The fake adapter returns `ses-shared`, probes `reusable`, and records prompt args and cumulative `sessionUsage` snapshots. Assert prompt session ids are `[undefined, "ses-shared"]`, both task `sessions` contain the id only when used, two acceptance records exist, and the second usage delta is the second snapshot minus the first.

- [x] **Step 2: Write failing unsafe-reuse and identity tests**

Cover: actual model mismatch starts fresh and journals `session-reuse-skipped` with the two models; `unavailable` starts fresh and journals; `active` makes the next task `blocked` with no worker prompt and stops later ids; a dirty previous fact is not offered. Assert each turn's `TASKCTL_TASK_DIR`/`TASKCTL_LOG_DIR` and `taskctl done --task` id belong to the current task, and the preamble names the current and completed tasks.

- [x] **Step 3: Run the tests and confirm they fail**

Run: `npx vitest run tests/batch-session.test.ts`
Expected: FAIL because batch options are absent and the second prompt starts fresh.

- [x] **Step 4: Implement batch restoration and preamble injection**

Store the batch option on the internal `Run`. When `resumeFrom` is present, its settled/clean provenance comes from the previous completed batch task, not the current task's `previousSettled`; probe with the current model and `r.cfg.workdir`. A known model mismatch skips the probe, journals the reason, and starts fresh. `active` throws `UncertainExecutionError` through the existing path. Prepend the preamble to the string returned by `buildWorkerPrompt`, not inside the protocol template.

- [x] **Step 5: Run regression tests and mutation-check**

Run: `npx vitest run tests/batch-session.test.ts tests/session-resume.test.ts tests/usage.test.ts tests/protocol.test.ts tests/batch-flow.test.ts`
Expected: PASS, including byte-identical non-batch protocol output. Mutation targets: dropping the clean/settled requirement, ignoring actual model, treating `active` as fresh, reusing the batch candidate on every `open` retry, and sharing the first task's env with the second.

- [x] **Step 6: Commit**

```bash
git add src/worker.ts src/batch.ts tests/batch-session.test.ts
git commit -m "feat(batch): continue a safe worker session across tasks"
```

### Task 4: Durable watch ownership, wakeups, and graceful stop

**Files:**
- Create: `src/watch-lock.ts`, `src/watch.ts`
- Modify: `src/cli.ts`
- Test: `tests/watch.test.ts`

**Interfaces:**
- Consumes: `withMutex`, `runTask`, `ready`, `lockLive`, and the board-level `.taskctl` convention.
- Produces:

```ts
export type WatchOptions = {
  resume?: boolean;
  debounceMs?: number;   // default 250
  fallbackMs?: number;   // default 30_000
  runOne?: typeof runTask;
  runBatch?: typeof runBatch;
};

export async function watchQueue(
  cfg: WorkerConfig,
  deps: WorkerDeps,
  options?: WatchOptions,
): Promise<void>;
```

The watch owner is `watch-<pid>:<randomUUID>`. `watch-lock.ts` exports acquire/heartbeat/release functions taking `tasksDir`, owner, and TTL. Acquire uses create-exclusive under a mutex; it returns a held/stale/corrupt diagnosis and never archives or steals a stale record. Release and heartbeat require the same complete owner string, including the random generation.

- [x] **Step 1: Write failing lock and idle tests**

Cover: one acquisition succeeds and a live second fails; heartbeat refreshes only the same generation; release cannot remove a successor's lock; stale and corrupt records produce a diagnostic and remain untouched. Start an empty watch with short test fallback intervals, observe multiple idle wakeups, and assert zero adapter calls before requesting stop.

- [x] **Step 2: Write failing discovery, burst, second-watcher, and stop/resume tests**

Cover: adding an open task while watch is running executes it without another `run`; a burst of file writes is debounced rather than dispatched once per event; a second live watcher exits nonzero without dispatch; an existing stop file refuses plain `watch`; `watch --resume` clears it only after lock acquisition; and stop during an active fake turn lets that turn settle but leaves a second open task unclaimed. Assert the stop file remains after graceful exit.

- [x] **Step 3: Run the tests and confirm they fail**

Run: `npx vitest run tests/watch.test.ts`
Expected: FAIL because watch/lock modules and CLI commands do not exist.

- [x] **Step 4: Implement the lock, event loop, and commands**

Watch both `cfg.tasksDir` and the sibling `.taskctl` directory so stop does not wait for the 30 s fallback. Close watchers and clear debounce/fallback/heartbeat timers in `finally`. Check stop before scheduling and through `runBatch.shouldStop`; never cancel an active `runTask`. Heartbeat failure forbids further claims and surfaces after the current attempt. Add `watch --config <file> [--resume]` (config required) and `stop --tasks-dir <dir>` (tasks-dir required).

- [x] **Step 5: Run focused tests and mutation-check**

Run: `npx vitest run tests/watch.test.ts tests/claim.test.ts tests/claim-race.test.ts`
Expected: PASS. Mutation targets: accepting a live second owner, stealing a stale record, releasing without the full generation, clearing stop without `resume`, clearing it before lock acquisition, scheduling once more after stop, and removing the fallback wakeup.

- [x] **Step 6: Commit**

```bash
git add src/watch-lock.ts src/watch.ts src/cli.ts tests/watch.test.ts
git commit -m "feat(watch): own a durable queue and drain on stop"
```

### Task 5: Automatic eligible batches and `batchMaxTasks`

**Files:**
- Modify: `src/batch.ts`, `src/watch.ts`, `src/worker.ts`, `src/cli.ts`
- Test: `tests/watch-batch.test.ts`, `tests/cli-config.test.ts`

**Interfaces:**
- Consumes: Task 1 eligibility, Task 2 `runBatch`, Task 4 watch loop.
- Produces:

```ts
export async function selectAutomaticBatch(
  cfg: WorkerConfig,
  board: Task[],
): Promise<string[]>;
```

The selector computes `ready()` in board order and returns the contiguous statically and runtime-eligible prefix, capped by `cfg.batchMaxTasks ?? 5`. An ineligible first ready task returns an empty prefix. Watch runs an unfinished non-live `running` task first, then a selected prefix of length at least two as a batch, and a singleton or ineligible head through ordinary `runTask`. With `batchMaxTasks: 1`, every task uses the ordinary path.

- [x] **Step 1: Write failing config tests**

Assert absent `batchMaxTasks` resolves to `5`, `1` and `2` are accepted, and `0`, a fraction, a string, and an unknown nearby key are rejected. Exercise at least one value through real `runCli` config parsing, not only the pure resolver.

- [x] **Step 2: Write failing grouping and boundary tests**

Cover: two eligible tasks form one batch; the cap is honored; `1` disables grouping; an earlier high-risk/human-gated/iterative/ineligible task runs alone and is never skipped; an ineligible task between two eligible ones prevents grouping across it; a non-live unfinished `running` task has priority; and a task file created during a batch is not inserted into that batch. For the arrival test, request stop while the last selected task settles and assert the arrival remains open.

- [x] **Step 3: Run the tests and confirm they fail**

Run: `npx vitest run tests/watch-batch.test.ts tests/cli-config.test.ts`
Expected: FAIL on missing config and automatic grouping.

- [x] **Step 4: Implement config and scheduling**

Add `batchMaxTasks` to `WorkerConfig`, `CONFIG_KEYS`, and `resolveConfig` using `integer(...) ?? 5`. Do not change normal `runScheduler`. After any worked cycle, take a fresh snapshot before choosing more work; otherwise wait for the next event/fallback rather than spinning on an exhausted `open` result.

- [x] **Step 5: Run focused tests and mutation-check**

Run: `npx vitest run tests/watch-batch.test.ts tests/watch.test.ts tests/batch-session.test.ts tests/cli-config.test.ts`
Expected: PASS. Mutation targets: removing the cap, treating `1` as a batch size that still shares sessions, filtering ineligible tasks out of the middle of the queue, ignoring an unfinished in-flight task, and adding new arrivals to the active selection.

- [x] **Step 6: Commit**

```bash
git add src/batch.ts src/watch.ts src/worker.ts src/cli.ts tests/watch-batch.test.ts tests/cli-config.test.ts
git commit -m "feat(watch): group eligible ready tasks into bounded batches"
```

**Evidence (2026-11-24), Tasks 1–5:**

- Task 1, `f208bc0`: 33 focused tests passed; tsc clean. Workdir, dependency order, `human_check`, high-risk, and unsettled-attempt reversals were each killed; restored control 33/33.
- Task 2, `117e3b0`: 50 focused tests passed; tsc clean. Re-read, workdir, non-`done` stop, `open` retry, and CLI-dispatch reversals were each killed; restored control 50/50. The real CLI test exposed a missing `finally` for board/log flushing on validation failure; implementation now settles both on every exit.
- Task 3, `d5c2597`: 24 focused tests passed; tsc clean. Clean-candidate, model, `active`, first-attempt-only, session-append, and per-task-env reversals were each killed. The first clean-candidate mutation survived because the worker has a second clean guard; a direct `options.batch.resumeFrom` test was added and the rerun killed it.
- Task 4, `96ed39b`: 35 focused tests passed. Live/stale ownership, release generation, explicit resume, fallback, stop, and debounce reversals were each killed. The debounce test was strengthened from synchronous events to spaced events after the synchronous version proved unable to distinguish a missing debounce.
- Task 5, `7c8cf09`: 48 focused tests passed; tsc clean. Cap, `batchMaxTasks: 1`, eligibility-prefix, running-priority, and batch-stop reversals were each killed. The `1` test additionally pins the absence of the batch preamble after the session assertion alone could not distinguish the mutated path.

Implementation notes the plan did not fix:

- `watchFs` and `CliDeps.watch` are small test seams for deterministic filesystem events and timing; production defaults remain `fs.watch`, 250 ms and 30 s.
- Cross-task restoration originally missed appending the shared session to the second task because the worker assumed a restored session was already in that task's `sessions`. Recording now checks the current task's actual list; ordinary same-task restoration is unchanged.
- Automatic grouping implements board order as a contiguous eligible prefix. It never filters an ineligible task out of the middle merely to make a batch.
- `batchEligibility` initially accepted a base workdir that only the whole-selection validator used. The redundant parameter was removed during final cleanup.

### Task 6: End-to-end proof, documentation, and final gates

**Files:**
- Modify: `README.md`, this plan; tests `tests/batch-flow.test.ts`, `tests/watch-batch.test.ts` only if a final proof gap remains

- [x] **Step 1: Complete the acceptance proofs**

Confirm the real-CLI tests demonstrate every clause of §15.1 items 11 and 15: one safe shared session; two independent acceptance records; blocked and awaiting-human stop; fresh session after actual model mismatch; initial and mid-batch workdir rejection before claim; watch discovery without another run; zero idle model calls; burst coalescing; second-watcher refusal; graceful drain; eligible-only grouping; and arrival at a boundary.

- [x] **Step 2: Document the operator flow**

README must cover batch eligibility and exact-order/stop semantics, `taskctl watch --config <file> [--resume]`, `taskctl stop --tasks-dir <dir>`, stale-lock diagnosis, `batchMaxTasks` default/`1`, and the fact that per-task acceptance is not deferred. Do not describe live-provider behavior as verified.

- [x] **Step 3: Run the final offline gates**

```bash
npm test
npx tsc --noEmit
git diff --check
```

Run `scripts/smoke.ps1` without `-Live`; expected environment-preparation success. Also run the targeted CLI config tests. Record test counts and any skipped test in this plan's evidence section.

- [x] **Step 4: Run the consolidated mutation control**

Delete old private reports first, then run the unmutated control with `--reporter=json --outputFile=<private-path>` for each new test file. Repeat only the guard reversals named above that were not already recorded per task; every reversal must fail its intended test, and the restored control must pass. Do not read the repository's stale default `.vitest/json/output.json` when a CLI reporter is supplied.

- [x] **Step 5: Commit documentation and evidence**

```bash
git add README.md docs/superpowers/plans/2026-11-24-watch-batch.md
git commit -m "docs(batch): document watch and record offline acceptance"
```

Report explicitly that no real-backend run was made unless the user separately authorizes one. Phase 2 is then ready for the separately requested X-Goldfish independent review; that review is not claimed by this plan.

**Final evidence (2026-11-24, gate at `d288964`):** `npm test` **609 passed / 1 skipped**; `npx tsc --noEmit` exit 0; `git diff --check` clean; `scripts/smoke.ps1` without `-Live` prepared the environment successfully. Targeted real-CLI config parsing accepted `batchMaxTasks`. The “208 test files” figure originally recorded here was not a reproducible Vitest file count and is superseded by the remediation evidence (63 files) in `2026-11-24-phase2-review-remediation.md`. No live-provider run was made, so the real OpenCode reuse probe and actual backend cross-task continuation remain unverified.

Final proof additions and fixture findings:

- A real worker path through a `quick` task with no acceptance command or criteria produced `awaiting-human`; the batch stopped and left the later task unclaimed.
- The real `runCli watch` path discovered a newly added task and the real `runCli stop` path drained it, using `CliDeps.watch` only to make filesystem delivery deterministic.
- One full-suite run failed with Windows `EPERM` when a test polled `c.md` during `TaskStore.update`'s atomic rename. It reproduced alone. The fixture now waits for in-memory worker `done` events and reads task files only after watch exits; the corrected full suite passed. This was a test-induced sharing race, not a production scheduling failure.
