# Cancel Confirmation on a Busy Machine

**Goal:** `cancel()` confirms a killed process tree on this machine (~1 170 processes) and the five cancellation test files stop cascading failures, without weakening ADR-0007's rule that a listed pid the kill left alive is reported, never killed.

**Status:** opened 2026-11-27 at the owner's request after plan 4's closing gate. **Task 1 (diagnosis) is done**; the A/B/C decision is with the owner. No product code was changed — every measurement below patched `src/execution.ts` and restored it (`git status` clean after each run).

## Evidence (measured 2026-11-27, `main` at `9c03397`)

- `tests/execution.test.ts -t "acceptance cancellation stops descendants and settles within a bound"` with the shipped constants **fails** (7.8 s).
- The same single test with only the kill utility's internal timer raised (`src/execution.ts`, `stopTree`'s `1500` → `4000`) **passes** (6.05 s).
- An instrumented run of that test with the shipped constants printed:
  `interrupted:true, knownNull:true, utilityOk:false, rootGone:false, pipesClosed:false` —
  the process listing (3 000 ms deadline) **and** the kill utility's timer both expired, so nothing was killed and no tree evidence existed.
- The five files together — `execution`, `stop-worker`, `self-check`, `worker`, `spawn-insulation` — fail **13 tests** with the shipped constants. The first runs of the day also failed with the kill timer at 4 000, with both the listing deadline (4 500) and the kill timer (4 000) raised, and with `--maxWorkers=1`; that was **contaminated**: every failed run leaves fixture processes (`tests/fixtures/process-tree.mjs`, `gate-tree.mjs`) behind, and by 22:47 there were 57 of them. After clearing them the picture is the table in “Task 1 findings”, and raising the two sub-deadlines turns the five files green.
- The listing is not the only cost: **`taskkill` itself takes ~1.7 s on this machine** (see Task 1 findings), so the kill utility's own 1 500 ms timer expires before it can finish. That is why `utilityOk` is `false` and the root survives — not only a listing problem.
- Cost of one listing at this moment (1 171 processes, 695 of them the owner's browser): CIM through Windows PowerShell 3.2–3.5 s; `wmic` 2.4 s; `tasklist /FO CSV` 3.1 s (no parent column); PowerShell `Get-Process` 2.0 s (no parent column).

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

## Tasks

### Task 1: Diagnose the first survivor in each file — **done**

**Files:** none committed; `src/execution.ts` patched with instrumentation and restored (tree clean).

- [x] Ran each of the five files alone with the shipped constants, from a cleaned machine; recorded the first failing test and the four fields the code actually has (`knownNull`, `utilityOk`, `rootGone`, `pipesClosed`); `lineageGone` is `undefined` whenever `known` is null.
- [x] Found no single survivor to describe: **the kill never happens at all** with the shipped constants (`taskkill` needs ~1.7 s and its timer is 1 500 ms), so the whole tree survives and holds the pipes. Recorded the mechanism in “Task 1 findings”.
- [ ] Decide A, B or C and write the ruling here. *(Owner's call; recommendation A.)*

### Task 2: Fix, with a failing regression first

**Files:** `src/execution.ts`, `tests/execution.test.ts`, `tests/stop-worker.test.ts` (the widened bounds), `src/worker.ts` only if the budget moves.

- [ ] Write a regression that fails on the shipped code and passes after: inject a `TreeControl` whose `killTree` resolves `true` after a delay longer than the old timer (the `processExecution` seam already accepts `trees`), and assert the cancel confirms within the new budget. Also pin the real constant, not a literal, in the invariant at `tests/execution.test.ts:339` — today it adds a hard-coded `1_500` that a raised timer would silently invalidate.
- [ ] Implement the chosen decision: the two sub-deadlines, the kill bounded by the remaining budget (so `CANCEL_BUDGET_MS < CANCEL_DEADLINE_MS` stays true by construction), and only the test bounds that the measurements show are too tight.
- [ ] Directed mutations: shorten the kill timer back to 1 500 ms, drop the listing deadline back to 3 000 ms, remove the remaining-budget clamp, invert the success condition; each must be killed by the named test.

### Task 3: Gates and the record

- [ ] The five files alone and together green on this machine; whole suite count recorded (the 13 should disappear).
- [ ] `npm run typecheck`, `npx tsc --noEmit`, `git diff --check`, the two offline scripts.
- [ ] One note on ADR-0007's Consequences if the budget or the evidence rule changes; no README change is expected.

## Closing gates

Whole suite green on this machine (the point of the plan), with **zero fixture processes left behind** after the run; typecheck, tsc, diff --check and both offline scripts clean; the mutation table at the tip all killed.
