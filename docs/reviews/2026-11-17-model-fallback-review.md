# Model fallback review — `e29a536`

Date: 2026-11-17
Target: `the repository`, branch `fix/real-task-findings`, review commit `e29a536` (`feat(worker): fall back to the next model when a provider rejects a turn`), against `3bd3a93`.
Design intent under test: `docs/reviews/2026-11-16-real-task-retro.md` N2 / N5 and "第二轮补充" (lines 40–108, 191–199). The prose is treated as intent, not as a writing sample.
Protocol: EGM Goldfish review, single-pass direct dispatch.

## Method and limits

- The protocol wants fresh-context reviewer personas. This review runs as an already-delegated depth-1 subagent with no nesting budget, so I used the protocol's documented fallback (direct dispatch) instead of the synthesizer. Same fresh context, no conversation history, no persona fan-out.
- `npx tsc --noEmit` cannot run here (TSD transparent encryption, TS1490). The type-safety finding below is by inspection only and is labelled as such.
- Verification I did run: `npx vitest run` → **265 passed / 1 skipped, 30 files passed / 1 skipped, 45.02 s**. That matches the commit message, so the test claim in the commit is accurate.
- I read the code, not just the diff: `models.ts`, `worker.ts`, `claim.ts`, `scheduler.ts`, `reconcile.ts`, `review.ts`, `runtime.ts`, `journal.ts`, `report.ts`, `cli.ts`, `task-file.ts`, `adapters/types.ts`, `adapters/opencode.ts`, `tsconfig.json`, the tests, README, and the retro.

## Verdict

**Ship with fixes.** The design is sound: a per-role finite chain, the position persisted outside the attempt record, a rotation that is fenced by the task lock, and a file explicitly declared advisory. The tests that matter do fail if the feature is reverted. None of that is the problem.

The problems are containment and cost. Four defects should be fixed before merge:

1. the worker turn's return type makes `result.failure` a compile error by inspection;
2. the advisory file's I/O errors are not contained, and turn a settled turn into `uncertain`;
3. a reviewer handover returns `open`, so the next scheduler pass re-executes the **whole task**, not the review;
4. a worker handover keeps the old OpenCode session while switching provider, and the failure mode of that switch burns retries.

Fix 1 and 2 are a handful of lines. Fix 3 and 4 are small and local (both live in `fallBack` and `reviewStage`).

---

## Blocking defects

### B1. `result.failure` does not type-check (build break, by inspection)

**Evidence.** `turn()` has two return statements with different shapes:

- `src/worker.ts:276-278` returns `{ ...await controlled(...), timedOut: false }`, i.e. `PromptResult & { timedOut: boolean }`, where `failure?: "provider"` is optional;
- `src/worker.ts:283` returns `{ sessionId: "", text: "", exitCode: -1, timedOut: true }` — **no `failure` property at all**.

`src/worker.ts:307` then reads `result.failure === "provider"` on the inferred union. TypeScript requires a property to exist on *every* constituent before it permits a union property access, optional or not. The timeout branch has no declaration for `failure`, so under `strict: true` (`tsconfig.json:9`) this is `TS2339: Property 'failure' does not exist on type '{ sessionId: string; text: string; exitCode: number; timedOut: boolean; }'`.

I could not run the compiler here (TSD encryption, TS1490), so this is a reading-level finding, not an executed one. It is the one item in this report that the author can confirm or refute in ten seconds with `npx tsc --noEmit` in a clean checkout. The repository has no `build` script and no CI (`.github/workflows` does not exist), so vitest passing says nothing about it; the `bin` entry points at `dist/main.js`, which is produced by `tsc`.

**Failure scenario.** A clean checkout cannot be type-checked or built, so the release artifact is stale or absent. Nothing catches it in this repo's test loop.

**Fix.** Annotate the function: `async function turn(...): Promise<PromptResult & { timedOut: boolean }>` (or add `failure: undefined` to the timeout branch). Both branches then satisfy the type, and `result.failure` is legal.

### B2. Advisory `models.json` I/O errors escape into the attempt state machine

The design says: "`models.json` 是提示性状态不是证据：文件损坏按'从链首开始'处理，不阻塞任务" (retro line 105, README line 198). That holds for *damaged JSON* only. It does not hold for an unreadable or unwritable file.

**Read path.** `src/models.ts:57-64` returns `{}` only for `ENOENT`; every other error is rethrown. `modelFor` (`src/worker.ts:245-249`) calls that read **unconditionally, for every task, on every turn and every review**, including for users who never configure a fallback chain. If it throws:

- inside `loop()` (`src/worker.ts:293`), the throw leaves `runTask` through the generic catch at `src/worker.ts:144-146`, which writes `attempt.phase = "uncertain"` — a phase that is supposed to mean "we could not confirm the stop" (ADR-0007). Here the previous turn was settled and nothing is running. The record is now a lie.
- because the phase is no longer `settled`, `src/worker.ts:149` does not release the workspace reservation. The registry record then covers the path, so the next attempt blocks with `workspace reserved by another or uncertain execution` — the N1 self-locking loop the retro fixed.
- `reconcile` returns `manual-review` for a non-settled attempt (`src/reconcile.ts:95-97`) and `retry` refuses anything non-blocked or non-settled (`src/reconcile.ts:178,181-183`). The task now needs the hand-edited `attempt.json` workflow that N3 was built to eliminate.
- the throw is not caught by the scheduler either: `src/scheduler.ts:101-111` has `try/finally` with no `catch`, so the rejection propagates through `Promise.race` at `src/scheduler.ts:118` and out of `runScheduler`. **One task's advisory file aborts the whole `taskctl run`**, and queued tasks never run.

Concrete trigger on this project's platform: `tasks/<id>/models.json` opened by an editor or held by an antivirus/backup agent (Windows `EPERM`/`EBUSY` on `readFile`), or a directory sitting at that path (`EISDIR`).

**Write path.** `src/worker.ts:261` calls `rotateModel` inside `owned()`; `src/models.ts:84-85` does `writeFile` + `rename`. On `ENOSPC`, a read-only directory, or the Windows "destination is open" `EPERM` on rename-over-existing, that throws out of `fallBack`, and the same generic catch converts an already-settled provider rejection into `uncertain` plus a leaked reservation. The turn had finished; marking it uncertain is factually wrong and blocks the task.

The retro's rationale — "写失败才抛错（写失败说明目录不可写，那是真问题）" — is right that a read-only directory is a real problem. It is wrong about the destination: a real problem should end in `block()` (status change, attempt stays settled, `retry` still works), not in `checkpoint("uncertain")` (unrecoverable without hand-editing JSON).

**Fix.** Contain both paths. In `models.ts`: return `{}` for any read error (log nothing or journal it), and make the write best-effort at the call site — `fallBack` catches, then either returns `false` (so `fail()` handles it normally) or calls `block(r, "model rotation state is not writable")`. Either is one `try/catch` in `fallBack` (`src/worker.ts:259-271`). Never let this file reach `runTask`'s generic catch.

**Test gap.** No test writes an unreadable or unwritable `models.json`. The advisory test at `tests/model-fallback.test.ts:199-208` covers damaged JSON only, and would pass even without the feature (see "Test quality").

### B3. A reviewer handover re-executes the whole task, not the review

**Evidence.** `src/worker.ts:446-450`: after a reviewer handover the code sets the status to `open` and returns `"open"`. `reviewStage` is only reachable through `accept()` after a successful worker turn, so "open" means the *entire* pipeline runs again: worker turn → acceptance command → review. The scheduler does this automatically, in the same `taskctl run`: `src/scheduler.ts:82-125` snapshots, runs ready tasks, and loops while `ranThisPass > 0` (`src/scheduler.ts:124`), and a task set to `open` is ready again.

**Failure scenario.** Reviewer quota is exhausted. With `reviewerModelFallbacks: ["b", "c"]` and the default `retryLimit: 3` (`src/cli.ts:706`), one outage produces up to **2 + 3 = 5 full task executions**: re-sending the worker prompt (up to the 30-minute turn timeout, `src/worker.ts:17`), re-running the acceptance command (up to 10 minutes, `src/worker.ts:18`), rewriting `acceptance.json`, and consuming a new session each time (`sessionId` starts undefined in `loop()`). Every one of those is reported as "a handover does not spend a retry".

This is not a hypothetical cost for this project's own use case. The retro's tasks edit a shared spreadsheet: the worker turn is not idempotent, so re-running it can write the rows twice, and the acceptance command re-runs its side effects too. The feature's promise is "cheap retry on an unavailable account"; what it delivers for the review role is repeated execution of the work.

The `status: "open"` behaviour itself predates this commit (it came with `3bd3a93`), but this change multiplies it from once per retry-limit to once per fallback plus once per retry-limit, and it labels the result "retrying with the next model" (`src/worker.ts:449`), which reads as if only the review was retried.

**Fix.** Loop inside `reviewStage`: on a handover, rebuild the evidence (`readRuntime`/`journalTail` are cheap) and run `controlled(..., "review", ...)` again with the new model, instead of returning `"open"`. The chain length bounds the loop, the status never leaves `review`, the worker turn and acceptance never re-run, and a rejected review no longer costs a full extra worker cycle (this also answers the caller's question about `open` vs `review` — that extra worker turn is not acceptable and the change should have removed it, not amplified it).

**Test gap.** `tests/model-fallback.test.ts:178-195` hides the cost: it filters `models` to review entries only (`:194`), so the fact that `w/one` ran twice never appears in an assertion. Asserting the full `models` array would have made this visible.

### B4. A worker handover resumes the old session under a new provider's model

**Evidence.** `loop()` keeps `sessionId` across a handover: the rejected turn's session is adopted at `src/worker.ts:295-300` and is only cleared in the `fresh` branches (`src/worker.ts:328-331`). `src/adapters/opencode.ts:66-67` then passes `--session <old>` and `--model <new>` in the same invocation. Nothing resets the session, and nothing verifies that a session created under provider A can be continued under provider B.

**Failure scenario.** Provider A is out of quota, so the turn is rejected and the loop hands over to B while resuming A's session. If opencode or B refuses that combination — a session pinned to a provider, or a transcript containing A's reasoning/tool-call blocks, which other vendors do not accept — the resulting error is not a 429/quota/auth/5xx, so `PROVIDER_REJECTION` (`src/adapters/opencode.ts:18,146`) does not classify it. `result.failure` stays undefined, the loop takes the ordinary-failure branch, `fail()` spends a retry (`src/worker.ts:309`), and the next iteration **reuses the same unusable session**, so every retry fails the same way until the task blocks. The feature's own mitigation path ends in the block it was introduced to prevent.

There is no test for this: the fake adapter keys only on model name and never inspects `args.sessionId` (`tests/model-fallback.test.ts:76-96`). The real-backend E2E was not run (excluded by the task).

The reviewer role does not have this problem: `startReview` passes no `sessionId` (`src/review.ts:139-145`), so every review is a fresh session.

**Fix.** Treat a handover as a session boundary: set `sessionId = undefined; turns = 0` after a successful `fallBack` in `loop()`. The worker prompt already rebuilds the handoff note from disk (`src/worker.ts:291-292`), so the new model starts with the written state, which is the project's designed handoff mechanism. The alternative — keep the session, but recognise a non-provider failure on the first fallback turn as a session failure and retry once on a fresh session — is more code for less certainty. Either way, add a test that asserts the session id sent with the fallback turn, and document the choice.

---

## Non-blocking findings

### M1. The evidence trail does not record which model ran or judged

`acceptance.json` (`src/worker.ts:349,371`) and `review.json` (`src/worker.ts:433`) contain no model field. The only trace of a handover is the journal line at `src/worker.ts:265-269`, and `taskctl report` (`src/report.ts:49-58`) does not show it beside the verdict. For a project whose rule is "runtime JSON is evidence" (ADR-0007; N7 wants the evidence self-contained), work executed and judged by a *fallback* model is indistinguishable from work on the primary. Add `model` to both records; it costs one field.

Related, smaller: a rejected review writes `review.json` with `verdict: "unclear"` plus `failure: "provider"` (`src/review.ts:148-154`, `src/worker.ts:433`), and `report` renders "verdict unclear <summary>" (`src/report.ts:53`), which reads as "the reviewer could not decide" when the reviewer never ran. Show `failure` in the report, or do not write a verdict for a turn that produced none.

### M2. The rotation is positional and is never re-anchored to a changed chain

`models.ts:94-107` stores a bare index, and `worker.ts:240-242` rebuilds the chain from the current config every time. Two consequences:

- An operator who changes the primary model — the documented cure for a bad model — edits `taskctl.json` `model` or the task's frontmatter `model` and expects the new primary to run. The chain becomes `[new, ...fallbacks]` but the index stays, so the task silently runs `chain[2]`. The journal shows it, but nothing warns.
- If the fallback list is shortened so the stored index is out of range, `modelAt` (`models.ts:48-51`) silently returns the head, and `rotateModel` (`models.ts:105`) then refuses to advance, so the remaining fallbacks are never tried and the task spends retries on the head model.

Fix: store the head model name alongside the index and treat a mismatch as "start at head"; when the index is out of range, rewrite it to 0 instead of clamping on read only.

### M3. Reviewer fallbacks only exist if `reviewerModel` is set, and the README says otherwise

`reviewerChain` is built from `cfg.reviewerModel` alone (`src/worker.ts:242`), and `resolveConfig` leaves it `undefined` when absent (`src/cli.ts:714`). The README table says the default is "同 `model`" (`README.md:52`), but the reviewer then gets `model: undefined`, so the adapter omits `--model` and opencode's own default is used — not the worker's model. A user who reads line 52 and configures only `reviewerModelFallbacks` therefore gets an empty reviewer chain: the N5 feature does not exist for them, and a rejected review still spends a retry. Either default `reviewerModel` to the resolved worker model, or state plainly that the reviewer chain requires an explicit `reviewerModel`.

### M4. The wrap-up turn ignores the new policy

`src/worker.ts:318-326`: the over-budget wrap-up turn is checked only for `timedOut`. If it is a provider rejection, no handover is attempted, `fail()` spends a retry (`:324`), and because `wrap.timedOut` is false the code writes a fallback note built from `wrap.text` (`:322`) — which for a provider failure is empty or a stderr tail. The result is a bogus handoff note in `sessions/` ("agent 未按收尾指令写 note") that claims a turn output, plus a retry spent on a model that is provably down. Apply the same `failure === "provider"` handover check here, and skip the note when the turn exited non-zero.

### M5. `modelFor` can strand the task in a status nothing picks up

`src/worker.ts:415-419` flips the status to `review` and *then* calls `modelFor`, which reads the filesystem (see B2). Even without B2, `startReview` can throw. If anything throws between the flip and the recovery write, the task sits in `review`, which:

- `runWorker` and the scheduler never pick up (both select `open`/`running`: `src/worker.ts:66`, `src/scheduler.ts:87`);
- `reconcile` reports as `already-terminal` (`src/reconcile.ts:91-92`);
- `retry` refuses, because it only reopens `blocked` (`src/reconcile.ts:178`).

The only recovery is editing frontmatter by hand. This trap predates the commit, but the new read is a new way to fall into it, placed exactly in the danger window. Move `modelFor` above the status flip and the window shrinks to `startReview` only.

### M6. Documentation drifted in two places

`README.md:93` lists the files under `tasks/<id>/` and does not mention `models.json`. `README.md:186` says `retry` moves `attempt.json`, `acceptance.json` and `review.json` into the archive; it now also moves `models.json` (`src/reconcile.ts:125`). `README.md:198` says a damaged `models.json` never blocks a task, which is true for JSON damage and false for I/O errors (B2).

### M7. Dead code

`resetModelRotation` (`src/models.ts:111-113`) has no caller in `src/` or `tests/`; the retry path renames the file instead (`src/reconcile.ts:156-160`). `Handover.index` (`src/models.ts:24`, set at `:107`) is never read. Either wire `resetModelRotation` into the retry path — which would stop `retry` from depending on the archive rename — or delete both.

### Nits

- `stringArray` returns values untrimmed (`src/cli.ts:743`) while `modelChain` trims (`src/models.ts:41-42`); two places decide what a valid name is. A whitespace-padded entry is accepted by one and normalised by the other.
- If `writeModelRotation` fails after `writeFile`, the `models.json.<uuid>.tmp` is orphaned (`src/models.ts:83-85`). The same pattern exists in `writeRuntime`, so this is consistent rather than new.
- A task with `model: ""` is accepted by the parser (`src/task-file.ts:153-162`) and produces an empty chain via `??` (empty string is not nullish), so configured fallbacks are silently ignored for that task. Marginal, but the empty-string path is not covered.

---

## Direct answers to the specific attacks

**Is "handover does not spend a retry" bounded?** Yes, and I could not construct a loop that spends no retry while looping. The index is monotonic while the chain lasts, persisted across attempts, and `rotateModel` refuses past the end (`src/models.ts:105`), after which `fail()` runs exactly as before (`src/worker.ts:309`). `turns` keeps incrementing across handovers, so `maxTurnsPerSession` closes the remaining path. The bound on *free turns* is the chain length; the bound on *cost* is not — each free worker turn can run 30 minutes, and each free reviewer turn costs a whole task execution (B3). One caveat: a `models.json` that is damaged again after every write resets the index to the head and re-grants one free handover per corruption; that needs an actively hostile writer, so I treat it as a nit, not a hole.

**Session reuse across a provider switch.** Not safe as written (B4), and the reviewer path is safe only by accident (fresh session each time).

**`models.json` as advisory.** True for `JSON.parse` and for a non-object payload (`src/models.ts:65-76` handles `null`, arrays, numbers, strings, booleans). False for read/write errors (B2). And it can lead to silently running a model the operator did not choose (M2, M3).

**Is the rotation write under the task mutex?** Verified, not taken on trust. `owned()` (`src/worker.ts:61`) → `withOwnership` (`src/claim.ts:103-108`) → `withMutex(".mutation.lock")` plus a generation check against `lock.json`. So the read-modify-write at `src/worker.ts:261` is serialised and fenced: a controller that lost its lease throws `OwnershipLostError` inside `withOwnership` *before* `rotateModel` runs, so the loser cannot write. Two controllers cannot lose an update; a mid-rotation lease loss aborts the old controller rather than corrupting the file. Two real but minor caveats: the *read* used to pick the model (`src/worker.ts:247`) is outside the lock, which can at worst make a controller re-send a turn on a model another controller already rotated away from (that controller needs the lease, so it cannot happen while this one holds it); and `fallBack` takes the mutex twice (`src/worker.ts:261` then `:265`), so a lease lost between the two leaves the rotation written with no journal line.

**Review rejection leaving status `open`.** A defect, and the change made it worse rather than fixing it (B3). A full extra worker turn — plus the acceptance command and its side effects — for a failure that says nothing about the work.

**`retryLimit` accounting.** Coherent across the main paths: worker handover spends no retry, review handover spends no retry, chain exhaustion spends retries, `taskctl retry` archives `models.json` and resets both counters (`src/reconcile.ts:156-163`). Two incoherences: the wrap-up turn is exempt from the policy (M4), and "no retry spent" hides a full task execution on the reviewer path (B3). Also note that `fail()`'s meaning has drifted: it now means "retries spent", not "attempts spent", and the number of *executions* is no longer derivable from `retries` alone. That is worth one sentence in the README's fallback paragraph.

---

## Test quality

Eight new tests (`tests/model-fallback.test.ts`), plus one in `cli-config` and an extended `reconcile` case. The suite passes at 265/1.

| Test | Would it fail if the feature were reverted? | What it does not prove |
| --- | --- | --- |
| "hands a rejected turn to the next model without spending a retry" (`:129-147`) | Yes — without the change `retries=1` blocks at `retryLimit=1`, and only `w/one` is called. This is the load-bearing test. | Nothing about the session used, nor how many worker turns ran. |
| "blocks once the chain is spent" (`:149-160`) | Yes — without the change only `w/one` appears. | That no second handover was attempted; journal not asserted. |
| "keeps the rotation across attempts" (`:162-176`) | Yes — the second run would use `w/one`. | That the rotation survives a *new* attempt (it does), only that the file was not reset. |
| "reviews with the next model" (`:178-195`) | Yes — without the change the first run returns `blocked`, not `open`. | The number of worker turns (filter at `:194` hides the duplicate `w/one`). |
| "starts at the head when models.json is damaged" (`:199-208`) | **No.** Passes with the feature removed. | Any fallback behaviour after damage; only "no crash, head first". |
| "ignores a fallback list when no primary" (`:210-218`) | **No.** Passes with the feature removed. | Only that the chain stays empty. |
| `modelChain` / `modelAt` units (`:114-127`) | n/a (unit-level). | Nothing integration-level. |
| CLI validation (`tests/cli-config.test.ts:19-35`) | **No.** Validates the parser, not the wiring; but the wiring is real (`src/scheduler.ts:103` spreads the whole config into `runTask`, and `src/cli.ts:185` passes the resolved config into the scheduler). | — |
| `retry` archives `models.json` (`tests/reconcile.test.ts:131-148`) | Yes. | Good, and it also asserts the file is gone from the task dir. |

Missing cases, in the order I would add them:

1. unreadable `models.json` (`EACCES`/`EISDIR`) → currently an `uncertain` attempt and an aborted scheduler run (B2);
2. unwritable `models.json` (read-only dir) during a handover → same (B2);
3. the session id sent with the fallback turn, and what happens when the new model cannot continue the session (B4);
4. the cost of a reviewer handover: assert the full `models` array and `attempt` count, proving the worker is not re-executed (B3 — the assertion should be added together with the fix);
5. `overBudget` querying the session's model: no test asserts which model reaches `contextLimit` (the fake ignores it, `tests/worker.test.ts:87-89`), so the commit message's "overBudget now measures the model the session actually used" is unproven and a revert would pass;
6. provider rejection on the wrap-up turn (M4);
7. that a rejected review does not increment `review_rounds` (true by inspection — the provider branch returns at `src/worker.ts:450`, before `incReviewRounds` at `:473` — but untested).

---

## Invariant map

| # | Invariant | Effect of this change |
| --- | --- | --- |
| 1 | Never replay a possibly-running execution | Holds. `acceptSettled` is only consulted after the result promise settles (`src/worker.ts:218`), and both in-tree adapters resolve only after process exit (`src/adapters/opencode.ts:140-153`, `src/worker.ts:176-180`). A handover dispatches the next turn only after the previous execution has exited. **But** B2 creates false `uncertain` records for executions that were settled, and B4's failure mode is "retry a turn that cannot run", not replay. |
| 2 | Markdown is the sole authority for status | Holds: `models.json` carries no status, and `retry` resets it with the counters. Worth noting that it is nonetheless behaviour-affecting runtime state keyed to a position, not to a name (M2), which is why it can silently choose a model nobody asked for. |
| 3 | Acceptance evidence cannot be bypassed | Holds: every re-execution recomputes acceptance bound to a fresh attempt id and digests (`src/worker.ts:366-387`). B3 means acceptance runs far more often than before, which is a cost and side-effect problem, not a bypass. |
| 4 | Ownership is fenced | Holds for the rotation write (verified above). The unlocked read and the two-step journal append are the only soft spots. |
| 5 | Provider rejections are retryable, not evidence of a running execution | Holds and is extended. Two inconsistencies: the wrap-up turn (M4) and the review status flip (B3/M5). |

---

## Minimum change set to ship

1. `src/worker.ts:273` — give `turn` an explicit return type (`PromptResult & { timedOut: boolean }`), or add `failure: undefined` to `:283`.
2. `src/models.ts:57-86` + `src/worker.ts:259-271` — contain I/O errors: read failure → `{}`; write failure → no throw into `runTask` (block, or skip the handover and let `fail()` run). Add tests 1 and 2.
3. `src/worker.ts:440-451` — on a reviewer handover, re-run the review inside `reviewStage` instead of setting `open` and returning; add a test that asserts the worker turn count.
4. `src/worker.ts:307-309` — after a worker handover, start a fresh session (`sessionId = undefined; turns = 0`); add a test that asserts the session id on the fallback turn.
5. `src/worker.ts:415-419` — move `modelFor` above `setStatus(id, "review")`.
6. Non-blocking but cheap: record `model` in `review.json`/`acceptance.json` (M1); re-anchor the rotation when the chain head changes (M2); fix `README.md:52,93,186` (M3, M6); handle the wrap-up rejection (M4); delete or wire `resetModelRotation` (M7).

After 1–4, this ships. Item 3 is the one I would not defer: the reviewer path currently pays for a whole extra task execution per fallback, and that is the opposite of what the fallback chain is for.
