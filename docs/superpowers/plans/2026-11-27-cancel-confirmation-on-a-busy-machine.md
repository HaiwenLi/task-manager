# Cancel Confirmation on a Busy Machine

**Goal:** `cancel()` confirms a killed process tree on this machine (~1 260 processes at the time of the diagnosis) and the five cancellation test files stop failing, without weakening ADR-0007's rule that a listed pid the kill left alive is reported, never killed.

**Status:** opened 2026-11-27 at the owner's request after plan 4's closing gate; Task 1 (diagnosis) done the same night; **ruling A** taken by the owner; Task 2 implemented; Task 3's gates run and green. Product code changed in `src/execution.ts` and `src/worker.ts`; the only test changes are the bounds the measurement showed were below the new worst case (two files) and the two new regressions.

## Evidence (measured 2026-11-27, `main` at `9c03397`, then `f89bc71`–`70cfaca` for Task 1)

- `tests/execution.test.ts -t "acceptance cancellation stops descendants and settles within a bound"` with the shipped constants **fails** (7.8 s).
- The same single test with only the kill utility's internal timer raised (`src/execution.ts`, `stopTree`'s `1500` → `4000`) **passes** (6.05 s).
- An instrumented run of that test with the shipped constants printed:
  `interrupted:true, knownNull:true, utilityOk:false, rootGone:false, pipesClosed:false` —
  the process listing (3 000 ms deadline) **and** the kill utility's timer both expired, so nothing was killed and no tree evidence existed.
- The five files together — `execution`, `stop-worker`, `self-check`, `worker`, `spawn-insulation` — fail **13 tests** with the shipped constants. The first runs of the day also failed with the kill timer at 4 000, with both the listing deadline (4 500) and the kill timer (4 000) raised, and with `--maxWorkers=1`; that was **contaminated**: every failed run leaves fixture processes (`tests/fixtures/process-tree.mjs`, `gate-tree.mjs`) behind, and by 22:47 there were 57 of them. After clearing them the picture is the table in “Task 1 findings”, and raising the two sub-deadlines turns the five files green.
- The listing is not the only cost: **`taskkill` itself takes ~1.7 s on this machine** (see Task 1 findings), so the kill utility's own 1 500 ms timer expires before it can finish. That is why `utilityOk` is `false` and the root survives — not only a listing problem.
- Cost of one listing at this moment (1 171 processes, 695 of them the owner's browser): CIM through Windows PowerShell 3.2–3.5 s; `wmic` 2.4 s; `tasklist /FO CSV` 3.1 s (no parent column); PowerShell `Get-Process` 2.0 s (no parent column).
- After the fix (working tree on `70cfaca`): the five files **99/99** in 77 s with no leaked fixtures; the whole suite **1189 passed / 1 skipped / 0 failed** in 92 s, **0 processes of the repo left**; a stop with a real tree here spends ~3.2 s listing and ~1.9 s in the utility.

## Constraints

- `CANCEL_BUDGET_MS = 7_500` (`src/execution.ts`) and `CANCEL_DEADLINE_MS = 8_000` (`src/worker.ts`) bound a cancel; several tests assert a cancel settles in under 6–7 s.
- ADR-0007: the listing is evidence, never a reason to kill; a listed pid still alive is reported `uncertain`. The kill itself is `taskkill /PID <pid> /T /F`.
- No new runtime dependency; Windows-only code stays behind `process.platform === "win32"`.

## Task 1 findings (measured 2026-11-27 night, `main` at `f89bc71`, machine at ~1 256 processes)

Each file was run alone, from a cleaned machine (no fixture processes left), with the shipped constants and one `console.error` line after `treeGone`. Every cancel printed the same signature; the first failure in each file is given in file order.

| File | Tests | Failing | First failure | Cancel fields there |
|---|---|---|---|---|
| `tests/execution.test.ts` | 22 | 7 | acceptance cancellation stops descendants and settles within a bound | `knownNull:true, utilityOk:false, rootGone:false, pipesClosed:false` |
| `tests/stop-worker.test.ts` | 28 | 3 | a stop during the acceptance command kills the gate and judges nothing | same |
| `tests/self-check.test.ts` | 7 | 1 | retains partial output after a bounded timeout and confirmed stop | same |
| `tests/worker.test.ts` | 30 | 1 | acceptance timeout evidence keeps output captured before cancellation | same |
| `tests/spawn-insulation.test.ts` | 10 | 1 | an insulated gate is still cancelled as a tree | same |

Mechanism, measured directly:

| Probe | Time |
|---|---|
| `taskkill /?` (startup only) | 65–73 ms |
| `taskkill /PID <live node> /F` | 1 684 ms (exit 0 — it *worked*, slowly) |
| `taskkill /PID <live node> /T /F` | 1 939 ms (exit 128 on the tree it was given) |
| `taskkill /PID <no such pid> /T /F` | 1 716 / 2 041 ms |
| shipped listing (CIM through Windows PowerShell) | 3 204–3 249 ms |
| `wmic process get …` | 2 178 ms |
| `tasklist /FO CSV /NH` (no parent column) | 2 979 ms |
| PowerShell `Get-Process` (no parent column) | ~1 000 ms |

So `taskkill` starts in 70 ms and then spends ~1.7 s of its own enumerating the process table — the 1 500 ms timer kills it mid-flight every time on this machine, which is why the root is never killed. There is no “first survivor” to find: with the shipped constants **the kill never happens**, and the survivor is the whole tree. No leftover-fixture cascade is needed to explain the 13 failures; the cascade in the earlier notes was real but was *caused by* the leaked trees of the previous failed run.

Outcomes of the two candidate changes, five files together, from a cleaned machine:

| Change | Result |
|---|---|
| listing 4 500 ms + kill timer 4 000 ms | 3 failed / 94 passed, **0 leaked**; the 3 are test-level bounds (`settles()` 4 000 ms; one test whose 15 000 ms budget holds four cancels) |
| the same, plus `settles()` → 9 000 ms and that test → 30 000 ms | **97/97 passed, 0 leaked, 77 s** |
| listing function 4 500 ms, cancel waits at most 1 500 ms for it, kill timer 3 000 ms, no test edited | 1 failed / 96 passed, 0 leaked, 59 s; the failure is the same 4 000 ms `settles()` bound |

Left unmeasured: whether A leaves the 7 500/8 000 budget pair honest. The invariant test at `tests/execution.test.ts:339` still adds a hard-coded `1_500`; with a 4 000 ms kill timer the real worst case is 4 500 + 4 000 + 2 × 500 = 9 500 ms, which is above `CANCEL_BUDGET_MS`. A must either bound the kill by the remaining budget or raise the pair and the tests that encode it.

## Decision (for the owner, after Task 1)

- **A. Raise the two sub-deadlines and keep the evidence rule** — listing 3 000 → 4 500 ms, kill timer 1 500 → 3 000–4 000 ms, the kill bounded by what remains of the budget so 7 500/8 000 stays true; widen the three test-level bounds (`settles()` 4 000 → 9 000 ms, the four-cancel test 15 000 → 30 000 ms, and check the rest of the duration assertions). **Measured: 97/97, 0 leaked fixtures.** Cost: a stop on this machine answers in ~5.5 s instead of ~2 s, and a stop on an unreachable machine may take the kill timer before it answers “unconfirmed”.
- **B. Stop waiting for the listing once it is slow** — the cancel waits at most ~1.5 s for the descendants, then kills; a late listing is treated as none, and the verdict rests on the utility's report plus the output pipes. Kill timer still raised (it must be), listing function still given 4 500 ms for the direct-listing test. **Measured: 96/97 with no test edited (the one failure is the 4 000 ms `settles()` bound in “a stop during a real adapter turn”, over by a few hundred ms), 0 leaked, 59 s.** Cost: on a machine this slow the pid-level evidence is *always* missing, so a kill that reports success but leaves a descendant is no longer caught by a listing — only by a pipe that stays open.
- **C. Make the listing cheaper** and keep the current budget. **Not viable as stated**: every mechanism available without a new dependency costs ≥ 2 s at this process count, and the kill utility alone costs ~1.7 s, so “keep the current budget” cannot be met; a genuinely cheap listing needs the Win32 toolhelp API, i.e. a native addon, which is out of scope.

**Recommendation: A**, because it keeps ADR-0007's evidence rule intact in the environment the owner actually uses, and the price is a stop that is already waiting ~2 s for `taskkill` taking ~3.5 s longer. B is the fallback if stop latency matters more than the pid-level evidence; it is the smaller change (no budget/invariant work).

**Ruling (owner, 2026-11-27 night): A.** What was built:

| Constant | Was | Now |
|---|---|---|
| `TREE_LIST_DEADLINE_MS` | 3 000 | 4 500 |
| `TREE_KILL_DEADLINE_MS` (new) | — (a literal 1 500 inside `stopTree`) | 3 500 |
| `CANCEL_BUDGET_MS` | 7 500 | 9 500 |
| `CANCEL_DEADLINE_MS` (`src/worker.ts`) | 8 000 | 10 000 |

One deliberate deviation from the sketch: the kill is **not** clamped to what remains of the budget. With 4 500 ms for the listing and two 500 ms settles, a 7 500 ms budget leaves 2 000 ms for a kill measured at 1.7–2.0 s — no margin. The pair was raised instead, and the invariant test now states the real sum (`4 500 + 3 500 + 3 × 500 = 9 500 ≤ 9 500 < 10 000`). The kill deadline became a parameter of `stopTree` with an exported `KillRunner` seam, so the deadline can be tested without depending on this machine's speed.

## Tasks

### Task 1: Diagnose the first survivor in each file — **done**

**Files:** none committed; `src/execution.ts` patched with instrumentation and restored (tree clean).

- [x] Ran each of the five files alone with the shipped constants, from a cleaned machine; recorded the first failing test and the four fields the code actually has (`knownNull`, `utilityOk`, `rootGone`, `pipesClosed`); `lineageGone` is `undefined` whenever `known` is null.
- [x] Found no single survivor to describe: **the kill never happens at all** with the shipped constants (`taskkill` needs ~1.7 s and its timer is 1 500 ms), so the whole tree survives and holds the pipes. Recorded the mechanism in “Task 1 findings”.
- [x] Decide A, B or C and write the ruling here. **A** (owner, 2026-11-27 night).

### Task 2: Fix, with a failing regression first — **done**

**Files:** `src/execution.ts`, `src/worker.ts`, `tests/execution.test.ts`, `tests/stop-worker.test.ts`.

- [x] Regression written and seen failing on the shipped code: `platformTreeControl.killTree` against a real node process resolves **false** here (the utility needs ~1.7 s, the cap was 1 500 ms). The plan's suggested shape — a `TreeControl` whose `killTree` resolves late — was wrong: that seam replaces the whole utility, so it cannot fail on the shipped code (recorded below).
- [x] Implemented: the two sub-deadlines, the kill deadline as a parameter of `stopTree` behind an exported `KillRunner` seam, the budget/deadline pair, and the exact test bounds the measurements showed were too tight (`settles()` 4 000 → 10 000 ms; the four-cancel test 15 000 → 30 000 ms; the invariant at `tests/execution.test.ts` now sums the real constants).
- [x] Directed mutations, all killed at the tip:

| # | Mutation | Killed by |
|---|---|---|
| M1 | kill deadline back to 1 500 ms | the real-utility test (and the OpenCode-cancellation tests) |
| M2 | listing deadline back to 3 000 ms | “the Windows listing finds the live descendants of a real tree” |
| M3 | budget back to 7 500 ms | “the cancel budget stays inside the attempt's cancel deadline” |
| M4 | the utility abandoned at the deadline is not killed | “the kill deadline believes a 2 s utility…” |
| M5 | attempt deadline back to 8 000 ms | “the cancel budget stays inside the attempt's cancel deadline” |

### Task 3: Gates and the record — **done**

- [x] `tests/execution.test.ts` alone: **24/24** (74 s). The five files together: **99/99** (77 s), **0 fixture processes left**.
- [x] Whole suite: **1189 passed / 1 skipped / 0 failed** (92 s), **0 processes of the repo left**; before the fix it was 1174 passed / 13 failed / 1 skipped. Measured with the fix applied on top of `70cfaca`.
- [x] `npm run typecheck` 0, `npx tsc --noEmit` 0, `git diff --check` 0; `live-stop.ps1`, `smoke.ps1`, `live-phase2.ps1` all exit 0.
- [x] ADR note: **none was needed**. ADR-0007 has a *Limits* section and no Consequences, and neither it, nor the design document, nor the README states the cancel budget (`grep` for `7500`/`8000` finds nothing but the historical retro). The numbers live in the constants' comments, which were updated; `README` needs no change, as the plan expected.

## Found while carrying out

- **The diagnosis in the first draft of this plan was wrong about the mechanism.** It said a first survivor "cascades". In fact, with a 1 500 ms cap the kill never runs at all: the utility needs ~1.7 s on this machine. Evidence from a machine still dirty with a previous run's fixtures (57 processes) pointed the wrong way; the numbers only made sense after clearing them and re-running.
- **Task 1's third premise — "find the first survivor in each file" — had no object.** There is no first survivor; the survivor is the whole tree. The task was still worth doing: it produced the fields and the timing table that selected A.
- **The regression this plan proposed could not fail on the shipped code.** A `TreeControl` whose `killTree` resolves late replaces the entire utility, timer included, so `processExecution` never consults the 1 500 ms. The real regression is (a) the real utility against a real process on this machine and (b) a `KillRunner` seam with fake timers that pins the deadline's behaviour.
- **Task 3's "ADR-0007's Consequences" does not exist**; the ADR's sections are Decision, Limits, Recovery, and none carries timings. Nothing was invented to satisfy the checkbox.
- **A mutation that shortens the kill timer necessarily leaks trees.** The 6 fixture processes counted after the first green suite came from M1's run, not from the suite; the clean rerun left 0. Leftovers must be counted after the last mutation is restored, or cleared before measuring.
- **The kill's cost is the machine's, not `taskkill`'s startup:** `taskkill /?` answers in 70 ms while killing a live node takes 1.7 s. The raised deadline is sized to the measured cost, and the tests that pin it say so in their comments.

## Closing gates

Whole suite green on this machine (the point of the plan), with **zero fixture processes left behind** after the run; typecheck, tsc, diff --check and both offline scripts clean; the mutation table at the tip all killed.
