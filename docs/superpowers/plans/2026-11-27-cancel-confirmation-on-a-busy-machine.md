# Cancel Confirmation on a Busy Machine

**Goal:** `cancel()` confirms a killed process tree on this machine (~1 170 processes) and the five cancellation test files stop cascading failures, without weakening ADR-0007's rule that a listed pid the kill left alive is reported, never killed.

**Status:** proposal, opened 2026-11-27 at the owner's request after plan 4's closing gate. Not started; Task 1 is a diagnosis, and the decision below is taken after it.

## Evidence (measured 2026-11-27, `main` at `9c03397`)

- `tests/execution.test.ts -t "acceptance cancellation stops descendants and settles within a bound"` with the shipped constants **fails** (7.8 s).
- The same single test with only the kill utility's internal timer raised (`src/execution.ts`, `stopTree`'s `1500` → `4000`) **passes** (6.05 s).
- An instrumented run of that test with the shipped constants printed:
  `interrupted:true, knownNull:true, utilityOk:false, rootGone:false, pipesClosed:false` —
  the process listing (3 000 ms deadline) **and** the kill utility's timer both expired, so nothing was killed and no tree evidence existed.
- The five files together — `execution`, `stop-worker`, `self-check`, `worker`, `spawn-insulation` — fail **13 tests** with the shipped constants, with only the kill timer at 4 000, with both the listing deadline (4 500) and the kill timer (4 000) raised, and with `--maxWorkers=1`. The single isolated test passes with the kill timer raised, so the per-file failures **cascade**: a first survivor (its child keeps the output pipe open, so `pipesClosed` stays false) makes every later cancel in that file fail.
- Cost of one listing at this moment (1 171 processes, 695 of them the owner's browser): CIM through Windows PowerShell 3.2–3.5 s; `wmic` 2.4 s; `tasklist /FO CSV` 3.1 s (no parent column); PowerShell `Get-Process` 2.0 s (no parent column).

## Constraints

- `CANCEL_BUDGET_MS = 7_500` (`src/execution.ts`) and `CANCEL_DEADLINE_MS = 8_000` (`src/worker.ts`) bound a cancel; several tests assert a cancel settles in under 6–7 s.
- ADR-0007: the listing is evidence, never a reason to kill; a listed pid still alive is reported `uncertain`. The kill itself is `taskkill /PID <pid> /T /F`.
- No new runtime dependency; Windows-only code stays behind `process.platform === "win32"`.

## Decision (for the owner, after Task 1)

- **A. Raise the kill utility's timer and the budget** (3 000/1 500 → e.g. 3 000/4 000, budget 7 500 → 9 000, tests' bounds adjusted). Smallest change; the isolated test proves the timer is the binding constraint. Cost: a cancel on a dead machine can take longer before it answers.
- **B. Treat a late listing as no listing** (skip the wait once the kill is under way) and rely on the kill utility plus the pipes, with a longer timer. Keeps the cancel shorter but gives up the descendant evidence exactly when the machine is slow.
- **C. Make the listing cheaper** (a different mechanism than `Get-CimInstance` through PowerShell) and keep the current budget. Needs a mechanism that carries `ParentProcessId`; `wmic` is deprecated, `tasklist` has no parent column.

The recommendation is **A**, after Task 1 confirms which test is the first survivor in each file and whether the cascade disappears once that one is fixed.

## Tasks

### Task 1: Diagnose the first survivor in each file

**Files:** none committed; a scratch copy of `src/execution.ts` with the instrumentation.

- [ ] Run each of the five files alone with the shipped constants, recording the first failing test and, for each cancel, the five fields (`knownNull`, `utilityOk`, `rootGone`, `pipesClosed`, `lineageGone`).
- [ ] For the first failure of each file, record the survivor's command line, its parent chain and which pipe it holds.
- [ ] Fill the table at the top of this plan; decide A, B or C and write the ruling here.

### Task 2: Fix, with a failing regression first

**Files:** `src/execution.ts`, its constants in `src/worker.ts` if the budget moves, `tests/execution.test.ts` or a new file.

- [ ] Write a regression that fails on the shipped code and passes after: inject a `TreeControl` whose `killTree` resolves `true` after a delay longer than the old timer (the `processExecution` seam already accepts `trees`), and assert the cancel confirms within the new budget.
- [ ] Implement the chosen decision with one edit; no other behaviour changes.
- [ ] Directed mutations: shorten the timer back, drop the budget adjustment, invert the success condition; each must be killed by the named test.

### Task 3: Gates and the record

- [ ] The five files alone and together green on this machine; whole suite count recorded (the 13 should disappear).
- [ ] `npm run typecheck`, `npx tsc --noEmit`, `git diff --check`, the two offline scripts.
- [ ] One note on ADR-0007's Consequences if the budget or the evidence rule changes; no README change is expected.

## Closing gates

Whole suite green on this machine (the point of the plan), typecheck, tsc, diff --check and both offline scripts clean; the mutation table at the tip all killed.
