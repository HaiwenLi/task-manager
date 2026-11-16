# Drift tolerance review — `b23e24d`

Date: 2026-11-17
Target: `the repository`, branch `fix/real-task-findings`, review commit `b23e24d` (`feat(review): tolerate declared external drift instead of failing the round`), against `550f9fe`.
Design intent under test: `docs/reviews/2026-11-16-real-task-retro.md` §「N4 共享表在任务运行期被人工编辑是常态」 and §「第三轮补充（N4 落地）」. The prose is treated as intent, not as a writing sample. Where the doc and the code disagree, the code is the fact and the doc is the claim being tested.
Protocol: EGM Goldfish review, single-pass direct dispatch.

## Method and limits

- The protocol wants fresh-context reviewer personas. This review runs as an already-delegated depth-1 subagent with no nesting budget, so I used the documented fallback (direct dispatch) instead of the synthesizer. Fresh context, no conversation history, but **one reader, not a persona fan-out**. The Stage 6 comprehension test in a truly fresh context was not possible; I substituted a self-containment read of the prompt. This is a real limit on independence and it is recorded rather than hidden.
- `npx tsc --noEmit` cannot run here (TSD transparent encryption, TS1490), so this review asserts no type-level finding. The one type change worth noting is that `ReviewResult.externalChanges` is required (`src/review.ts:25`), which breaks any out-of-tree `WorkerDeps.review` implementation; inside the repo all fixtures were updated.
- Verification I ran: `npx vitest run` → **278 passed / 1 skipped, 31 files passed / 1 skipped, 40.34 s**. That matches the commit message exactly.
- I ran two throwaway probes (`tests/_probe-drift.test.ts`, `tests/_probe-launder.test.ts`) to test the digest-fence claim by execution rather than by reading, then deleted both. `git status` was clean before and after; no source file, commit, or index was touched.
- Files read in full or in the relevant regions: `src/worker.ts`, `src/review.ts`, `src/task-file.ts`, `src/runtime.ts`, `src/report.ts`, `src/task-store.ts`, `src/workspace.ts`, `src/reconcile.ts`, `src/cli.ts` (add/accept/report paths), `tests/drift-tolerance.test.ts`, `tests/review.test.ts`, `vitest.config.ts`, README diff, retro §N4 and the third-round note.

## Verdict

**Ship with fixes.** The mechanism is additive, defaults to no tolerance, and the recording half works: a tolerated change lands in `review.json`, gets a journal line, and shows up in `taskctl report` (verified by the new tests and by reading the write path). Existing tasks are unaffected because `tolerate` defaults to `[]`.

What is not sound is the containment story the commit tells. The commit says the declaration "is part of `definitionDigest`, so widening it mid-run invalidates the acceptance instead of quietly excusing more". On the path the motivating spreadsheet task actually took — criteria, no acceptance command — **there is no digest comparison at all**, so a worker can write its own declaration, and I made that happen end to end. Separately, the two halves of the feature (the tolerance list and the time window) are not connected to each other by any rule, and the tolerance hint contradicts prompt rule 5 on the one thing the real incident involved (a changed header). Three fixes, all local; after them this ships.

---

## Blocking defects

### B1. The review-only path never compares the definition digest, so the worker can write its own tolerance — and I ran it

`accept()` has two exits. The command path ends by re-reading the task from disk and comparing the digest (`src/worker.ts:416-421`):

```ts
const definitionMatches = !!current && current.status === "running" && definitionDigest(current) === r.definition;
...
if (!definitionMatches || artifactBefore !== artifactAfter || result.skipped) throw new ReviewRequiredError(...)
```

The no-command path returns before any of that (`src/worker.ts:386-399`): it writes `acceptance.json` with `skipped: true`, `definitionMatches` absent, and calls `reviewStage(r)`. `definitionDigest` is compared in exactly one place in the whole source tree (`src/worker.ts:417`; grep confirms). So on the review-only path — the path of an office or spreadsheet task, which cannot produce a shell command that means "done" (retro §N6 says exactly this) — nothing checks the task file that the worker can edit over its own shell.

The worker can edit it. Its turns run `taskctl` from the repository, `tasksDir` is excluded from the artifact digest on purpose (`src/worker.ts:401`, `artifactDigest(r.cfg.workdir, [r.cfg.tasksDir])`), and `tolerate` is plain frontmatter with no writer but a raw file edit (`src/task-store.ts:10-12` `TaskFieldsPatch` does not include it; `src/cli.ts:242` hard-codes `tolerate: []` on creation).

**Executed evidence.** Probe 1, review-only task (`criteria`, no `acceptance`) whose adapter rewrites `tasks/a.md` during its own turn to add `tolerate: [external_cell_change]`, then requests completion:

- review-only path: `{ outcome: "done", status: "done", reviewerSaw: [], onDisk: ["external_cell_change"] }`
- command path, same edit: `{ outcome: "blocked", status: "blocked", reviewerSaw: [], onDisk: ["external_cell_change"] }`

Probe 2, two rounds on the review-only path: round 1 reviewer sees `[]` and fails the work (wrong rows); the worker's edit already widened the file; round 2 is a new attempt, so its reviewer sees `["external_cell_change"]`, passes, and records `externalChanges: ["4 个单元格被别人改过"]`. Final `{ first: "open", second: "done", status: "done", reviewRounds: 1 }`.

That is the incident from the retro, replayed as a success: the round that was supposed to be rework becomes a pass under an excuse the worker wrote itself, and no artifact says who wrote it. `taskctl retry` does not help as a reset either — it archives evidence and resets counters (`src/reconcile.ts:153-163`) but leaves `tolerate` in the markdown, so one worker edit survives the operator's own recovery step and becomes indistinguishable from an operator declaration.

**Why it is blocking.** `src/task-file.ts:24-26` states the property explicitly: "The declaration is the operator's, not the model's." The commit message makes it a guarantee. It is false on the path this feature exists for. Invariant 3 (the definition digest fences intent) is the fence, and it is not installed on that road.

**Fix.** Put the digest comparison in front of *both* exits: compute `definitionDigest(current)` and compare before `reviewStage(r)` is called on the no-command path, and write `definitionMatches` into that `acceptance.json` too (it currently leaves `report` printing `definitionMatch ?`, `src/report.ts:45`). If the no-command path should not block for unrelated metadata reasons, then compare the digest of the *authorising* fields only (`criteria`, `risk`, `human_check`, `tolerate`, `acceptance`) — but compare something. Add the probe above as a test: the review-only path must not reach `done` after the task file was edited mid-run.

### B2. The declaration the reviewer was shown is recorded nowhere

The commit's headline is "recorded, never silent". The *output* is recorded; the *permission* is not. `review.json` gets `{ ...result, model, at }` (`src/worker.ts:497`) — verdict, criteria, defects, summary, `externalChanges`, model. It does not get the `tolerate` list that authorised the excuses, nor the definition digest the reviewer's evidence was built from. `acceptance.json` carries `definitionDigest` on the command path only, and a hash does not reconstruct a list.

Meanwhile `report` prints `tolerate` from **today's** task file (`src/report.ts:24,35`) and `tolerated` from an **older** review (`src/report.ts:59-62`), on the same page, with nothing marking that they may be different declarations. The task file is explicitly a document humans edit; the moment it changes, the audit question "was this pass justified under the rules in force?" has no answer in any artifact.

**Failure scenario.** A task passes with `tolerate: [deleted_row]`. Two days later the operator narrows it to `[]` while tidying the backlog. `taskctl report` now shows `tolerate` absent and a `tolerated:` list of excused changes under a pass — which reads as a reviewer excusing drift it was not allowed to excuse. The opposite edit hides the same problem in reverse.

**Fix.** Store what the reviewer was authorised with, in the same record as the verdict: `tolerate: evidence.task.tolerate` and `definitionDigest: r.definition` in the `review.json` write at `src/worker.ts:497`. Have `report` print *that* field when it exists, falling back to the task file only when it does not. One field each, and the evidence becomes self-contained (which is N7's whole complaint).

### B3. The prompt contradicts itself, and the window is attached to no rule

The feature's entire enforcement is prompt text. That text has a direct conflict on the exact thing the incident involved.

- `src/task-file.ts:33` — the hint for `new_column`: `"表里多出一列（表头/列序变了）"`. A changed header and a reordered set of columns are declared tolerable.
- `src/review.ts:85` — rule 5: `"清单外的结构变化（删列、改表头含义等）仍按原规则判 fail"`. A changed header meaning must fail.

The same prompt tells the reviewer both things. A reviewer that reads the hint excuses a header rewrite; a reviewer that reads the rule fails it. There is no tie-breaker, and the whole reason a declaration exists is to remove that coin flip. `new_column` also silently covers reordered and reformatted columns, which are not "a new column" and are much easier to produce by accident while writing rows.

The second half is worse. `## 时间窗口` is printed (`src/review.ts:73-76`) with two timestamps, and **no rule mentions the window**. Rules 5-7 (`src/review.ts:85-87`) constrain the *kind* of change, never its *time*. So nothing stops the reviewer from excusing, under `external_cell_change`, cells that were already wrong before `window.startedAt` — the "was never done" case the commit says the window exists to separate. The commit's claim that the window "is what separates 'changed while the task ran' from 'was never done'" describes an inference the prompt never asks for and the code never checks. Given the reviewer is told at `src/review.ts:52` to judge only from the materials below and at `:83` not to evaluate what it did not see, it has no way to place a change in time at all unless it goes looking in the workspace, which the prompt discourages.

**Failure scenario.** A task is asked to fill 32 rows. It fills 10 and leaves 22 blank from before the run (a resumed task, or a retry, see M3). The reviewer sees `external_cell_change` declared, sees blank cells it cannot timestamp, attributes them to "someone deleted them", passes, and files 22 blanks under `externalChanges`. Rule 7 says missing work must fail; nothing in the prompt or the code makes the reviewer check the window before deciding the blanks are someone else's.

**Fix.** Three lines: put the time bound into the rules — "只有落在「时间窗口」内的差异才可以归因为外部变更；窗口之前就存在的缺失按欠缺处理" — and remove the header/column-order claim from the `new_column` hint so the hint and rule 5 cannot disagree (`new_column: "表里多了一段本任务没写的列"`). Also state what the reviewer may inspect: either it may read workspace timestamps (then say so), or it may not (then the window section is decoration and should be removed rather than shipped as if it were evidence).

---

## Non-blocking findings

### M1. `extra_file` is too broad to be safe, and it is the one kind with no natural bound

`extra_file` (`src/task-file.ts:28,35`) excuses any new file in the workspace as someone else's. "Added" is the one drift shape that is mechanically distinguishable from "modified", so a blanket addition excuse buys little and costs a lot: a task that drops a `postinstall` script, a `.env`, a build artifact, or a credential file into the repository is covered by the same word, with no time bound (B3) and no criterion link. A task that is supposed to fill a spreadsheet has no legitimate need to create files at all, so declaring `extra_file` for the motivating scenario is over-broad by construction. I would drop it from the vocabulary until there is a rule that names what was added and ties it to a criterion, or restrict it to paths the task declared it would ignore.

### M2. The human gate does not show what was tolerated

`taskctl accept` prints one line: `` `${id}  done  accepted` `` (`src/cli.ts:456`). It does not print the report, and the report is the only place `externalChanges` reaches a human (`src/report.ts:59-62`). For `risk: high` and `human_check` tasks the reviewer's `pass` parks at `awaiting-human` (`src/worker.ts:542-547`), so the human is the last gate — and at that gate they see nothing about the changes the reviewer decided not to blame the task for. The sign-off command should print the `tolerated` block (or the whole report) before recording the accept.

### M3. The window is per-attempt, not per-task, and the plan's actual window was never built

`window.startedAt` is `r.record.startedAt`, set at the top of `runTask` (`src/worker.ts:81-83`), so it is the start of *this attempt*. After a failed review round, or after `retry`, the next attempt gets a later `startedAt` while the workspace still holds the previous attempt's edits. Damage from round 1 therefore predates round 2's window and reads as pre-existing — which, under the tolerance rules as written, is a candidate for "external". The retro's own plan (line 91) was a much narrower window: "只对『写入窗口（before-write → after-readback）』断言零附带改动". The shipped window is the whole attempt, which *contains* the writing, so it cannot mark the task's own edits as outside it. The only mechanical drift check in the system, `artifactBefore !== artifactAfter` (`src/worker.ts:421`), covers the acceptance command's few seconds, not the work.

### M4. There is no way to declare tolerance except by hand-editing the file the worker can also edit

`TaskFieldsPatch` (`src/task-store.ts:10-12`) excludes `tolerate`; `taskctl add` hard-codes `[]` (`src/cli.ts:242`). The only writer is a raw frontmatter edit, which is exactly what a shell-capable worker can do. A `--tolerate` flag would at least make the operator's declaration a journaled orchestrator action, distinguishable from a model's edit, and would give B1's fix something clean to compare against. This also contradicts README's framing of the field as an operator decision.

### M5. `definitionDigest` is order-sensitive for `tolerate`

`JSON.stringify(... tolerate: task.tolerate ...)` (`src/runtime.ts:57-58`) hashes array order. Reordering `[new_column, deleted_row]` to `[deleted_row, new_column]` mid-run — a semantically identical edit — invalidates the acceptance and blocks the task (command path) for no reason. Normalise the list (sort) before hashing, or state that order is significant.

### M6. Report grows without a cap, journal records only a count

Each `externalChanges` entry is truncated to its first non-empty line and 120 characters (`src/report.ts:79-81`), but the list itself is unbounded. A reviewer that returns 200 entries turns the one-page spot-check into a wall; the criteria list and defects list have no bound either, so this is a new surface on an existing pattern rather than a new bug. The journal keeps only `external=N` (`src/worker.ts:503-505`), which is the right size for a log; the count and the list can disagree if `review.json` is later edited by hand, which is acceptable.

### M7. The vocabulary misses real drift and over-excuses two kinds

Covered kinds: other cells changed, a column added (plus headers and column order, see B3), a row deleted, an extra file. Missing: a **column deleted** (more destructive than a row — it can erase the column the task wrote), a row added, a sheet renamed, a file modified by someone else (there is no file-modification kind at all, even though the feature is used for repository tasks as well as spreadsheets), and formatting/recalculation. `external_cell_change` and `deleted_row` are defined relationally — "not the ones this task wrote" (`src/task-file.ts:32,34`) — which asks the reviewer to classify exactly the fact it cannot establish: the reviewer's only record of what the task wrote is prose in the acceptance output and the handoff note. Fixing B2 (recording what was authorised) helps the audit, not the classification; a real fix is an acceptance command or a read-back that names the cells the task touched (N6).

### M8. `externalChanges` is not tied to a criterion, so rule 6's requirement is unenforceable

Rule 6 asks the model to "说明它影响了哪条验收标准" (`src/review.ts:86`), but the JSON shape (`src/review.ts:90`) has no field for that: it is free text inside the string. Nothing checks that an entry names a criterion, that the criterion is not simultaneously `pass: true`, or that the entry's kind is one of the declared ones. A model can return `externalChanges: ["整个文件被重写了"]` with `verdict: "pass"` on a task that declared nothing, and the report will list it under "tolerated (attributed to someone else, not this task)". The parse path (`src/review.ts:130-135`) filters only for non-empty strings.

### Nits

- `degraded()` sets `externalChanges: []` (`src/review.ts:200-208`), which is right, but the `missing || verdict === "unclear"` branch keeps any `externalChanges` the model produced (`src/review.ts:139-141`). A model that emits `unclear` plus a long excuse list puts unverified accusations of third parties into `review.json` and the report under the "tolerated" heading, attached to no verdict. Drop them on `unclear`, or label them "unconfirmed".
- The `emit` detail is English inside a Chinese log line: `` `${result.verdict} (${result.externalChanges.length} external change(s) tolerated)` `` (`src/worker.ts:508-510`).
- `ReviewResult.externalChanges` is a required field, so this is a breaking type change for any out-of-tree adapter or `WorkerDeps.review` implementation. Fine inside the repo (all fixtures updated), worth a line in the README.
- `report`'s `~ ` prefix is unexplained; "tolerated (attributed to someone else, not this task):" above it does the work.

---

## Direct answers to the specific attacks

**Is this an acceptance bypass?** Not a mechanical one: invariant 1 still holds because the command must pass or an independent reviewer must say the criteria hold, and the reviewer still judges. It is a widening of the reviewer's discretion with no mechanical check on how the widening is used. The line between "excused external change" and "unfinished work" is drawn entirely in prompt text (rules 5-7), and the text is contradictory (B3). The cost when the model is wrong or lazy is exactly the incident's cost, inverted: instead of a wasted 20-minute rework round, a wrong artifact passes and the excuse is a sentence nobody can audit (B2, M8).

**Can the worker widen its own tolerance?** Yes, and I demonstrated it. Before acceptance: on the command path the digest mismatch blocks the task (`src/worker.ts:421`); on the review-only path it is invisible and the task can reach `done` (B1). Between acceptance and review: same — no re-read happens on that path, the reviewer uses the run-start snapshot (`src/worker.ts:456-457`), so the current round is not helped, but the file is now permanently widened. After the reviewer has started: the run's snapshot is already fixed, so that round is unaffected; the next attempt picks up the widened list, and `taskctl retry` does not reset it (`src/reconcile.ts:162-163`). The reviewer's copy of the task *can* differ from disk — `evidence.task` is the run-start clone, not a fresh read — and that matters less than it looks: it protects the current round and does nothing about persistence, which is where the damage is.

**Window semantics.** `startedAt` is the attempt start on every path, including a model handover inside one attempt (the record is written once at `src/worker.ts:81-83` and only ever updated with `updatedAt`). It is the work start for handovers; it is *not* the work start across a rework round or a `retry` (M3). A stale or reused record cannot make it lie into the future, because an unsettled previous attempt blocks at `src/worker.ts:112-114` before any work; the lie is in the other direction — the window starts *after* damage that an earlier attempt did, so the damage looks pre-existing. `finishedAt` is when evidence was assembled, before the reviewer turn; time the reviewer spends inspecting the workspace is outside both windows.

**Does `externalChanges` reach a human?** Verdict JSON → `parseVerdict` (`src/review.ts:130-135`) → `review.json` (`src/worker.ts:497`) → journal count (`:503-505`) → `report` list (`src/report.ts:59-62`). It reaches a human only if they run `taskctl report`; the accept command prints nothing (M2). Label sizes: each entry is cut at the first non-empty line and 120 characters; a long list is listed in full and uncapped; an empty list produces no lines at all. The gap is not truncation, it is that the human gate does not display it.

**Is the vocabulary right?** See B3 and M7. In short: it conflates added column / changed header / reordered columns into one kind that the rules simultaneously forbid, it has no file-modification kind for a feature that also runs on repositories, and its two relational kinds ask the reviewer to know which cells the task wrote — the one thing it cannot know. `extra_file` is not safe to tolerate as written: it is a blanket permission to add anything, bound by no time and no criterion.

**Test honesty.** The seven tests prove the parser, the serializer, the digest input, the wiring to `review.json`, the journal line, and the report line. All seven pass if prompt rules 5-7 are deleted, because every runtime test injects a `ReviewResult` instead of parsing a reviewer's text; one of them proves nothing about the feature at all (details in the table below). The one claim in the commit message with no test and no code behind it is the load-bearing one: "widening it mid-run invalidates the acceptance instead of quietly excusing more". The test that appears to cover it (`tests/drift-tolerance.test.ts:120`) only asserts that two digests differ, and the code path it describes does not exist on the review-only path (B1).

## Test quality

| Test | Would it fail if the feature were half-reverted? | What it does not prove |
| --- | --- | --- |
| `parses known kinds, drops duplicates, and defaults to none` (`:89`) | Yes — remove `parseTolerate` and the field is missing. | Nothing about runtime behaviour. |
| `rejects an unknown kind instead of excusing nothing` (`:100`) | Yes. | That the error reaches the operator as a readable message (it does, via `TaskFileError`). |
| `round-trips through the task file` (`:111`) | Yes. | Nothing about YAML edge cases (`tolerate: []`, a non-string entry). |
| `is part of the task definition…` (`:120`) | Yes, for the digest input. | **That acceptance is invalidated.** It compares two digests; it never runs a worker, and the review-only path has no comparison (B1). |
| `passes, but records what was excused` (`:131`) | **Partly.** The `review.json`/journal/report assertions fail if the recording is reverted; the pass itself comes from a stub reviewer that ignores the prompt, so it passes with rules 5-7 removed. | That a real reviewer would produce `externalChanges`, or that the tolerated kinds influenced the verdict. Note the seed always sets `acceptance: "check"` (`:38`), so this never exercises the no-command path. |
| `does not turn a failing verdict into a pass` (`:146`) | **No.** It passes with the feature fully reverted; the stub returns `fail` and the pre-existing `judge()` does the rest. It is a regression guard for a behaviour that already existed. | Anything about tolerance. |
| `keeps the reviewer's window and the acceptance facts in the prompt` (`:161`) | Partly: the `windows:`/`model:` assertions fail if `renderAcceptance` is reverted. | That the window is *used*. Its first assertion compares two `new Date().toISOString()` values for inequality, which is a millisecond-resolution race under load. |
| `states the tolerated drift and the window…` (`tests/review.test.ts:88`) | Yes for the sections. | Rules 5-7 are never asserted; only the presence of the word `externalChanges` in the shape line. |

Missing cases, in the order I would add them:

1. the review-only path with a mid-run `tolerate` edit must not reach `done` (B1 — the probe is the test);
2. `parseVerdict` with an `externalChanges` field from raw text, including non-strings, blanks, and duplicates (the whole parse path at `src/review.ts:130-135` is untested; replacing it with `[]` keeps all seven tests green);
3. `review.json` records the declaration the reviewer saw (B2);
4. `taskctl accept` output contains the tolerated list for an `awaiting-human` task (M2);
5. reordering `tolerate` does not invalidate acceptance (M5);
6. a second round after a failed review sees only the declaration that was in force at *that* attempt's start, with the round-1 edit recorded (B1/M3).

## Invariant map

| # | Invariant | Effect of this change |
| --- | --- | --- |
| 1 | Acceptance evidence cannot be bypassed | Holds formally: `judge()` still requires a command pass or a reviewer `pass`, and `risk: high` / `human_check` still park for a human (`src/worker.ts:542-547`). The reviewer's discretion is wider and the widening's use is unaudited (B2), and the human gate does not display it (M2). |
| 2 | Never replay a possibly-running execution | Holds. Nothing in the diff touches the replay guards; an unsettled attempt still blocks before any work (`src/worker.ts:112-114`). |
| 3 | The definition digest fences intent | **Broken on the review-only path** (B1). It fences `tolerate` only where an acceptance command exists; the path the feature targets has no comparison, and I made a worker's self-written declaration survive into a `done` round. |
| 4 | Ownership writes are fenced by the task mutex | Holds. The new writes (`review.json`, journal, `acceptance.json`) are unchanged in fencing; `store.setStatus` re-reads from disk under the same update path (`src/task-store.ts:115-123`), so a mid-run frontmatter edit is preserved rather than clobbered — which is required, and also the mechanism B1 exploits. |

## Protocol staging and traceability

The five Goldfish stages were condensed into one pass because the target is a code change, not a document; each stage is represented as follows.

- **Initial zoom out** — system fit: the change is additive, defaults safe, and sits in the already-existing evidence pipeline (`accept` → `reviewStage` → `judge`). No new state, no new file, no lifecycle change. Findings B1, M3 come from this altitude: the feature's guarantee is about a path its enforcement does not cover.
- **Comprehension** — self-containment: a fresh reviewer reading only this commit message would believe the digest fence holds, the window separates in-time from never-done, and tolerated drift always reaches a record. All three are overstated (B1, B3, B2). The retro's third-round note repeats the overstatement.
- **Critique** — the design attack: the line between excused drift and unfinished work is prompt text; the prompt contradicts itself; the vocabulary delegates the one classification the reviewer cannot make (B3, M7, M8).
- **Intermediate zoom out** — after critique: the recording half is sound and worth keeping; the enforcement half needs the digest check, the authorization record, and three prompt sentences. Fixes are local, no migration, no API break beyond the required field.
- **Implementation readiness** — the code is ready to accept the fixes: `accept()` already has the digest computation to reuse, `review.json` is written in one place, and `report` already has the rendering.

| Attack from the brief | Finding | Evidence |
| --- | --- | --- |
| Is this an acceptance bypass? | B3, M8 | `src/review.ts:85-90`; `src/review.ts:130-135`; `src/worker.ts:542-553` |
| Can the worker widen its own tolerance? | B1, M4, M5 | `src/worker.ts:386-399,416-421`; `src/task-store.ts:10-12`; `src/reconcile.ts:162-163`; probe output above |
| Window semantics | M3, B3 | `src/worker.ts:81-83,402,421,462`; retro line 91 |
| Does `externalChanges` reach a human? | B2, M2, M6 | `src/report.ts:24,35,59-62,79-81`; `src/cli.ts:456`; `src/worker.ts:497` |
| Is the vocabulary right? | B3, M7, M1 | `src/task-file.ts:28-36` |
| Test honesty | table above | `tests/drift-tolerance.test.ts:38,120,146,161`; `tests/review.test.ts:88` |

## Minimum change set to ship

1. `src/worker.ts:386-399` — compute `definitionDigest(current)` before the no-command path calls `reviewStage`, block on mismatch, and write `definitionMatches` into that `acceptance.json`. Add the probe as a test (B1).
2. `src/worker.ts:497` — record the authorisation in `review.json`: `tolerate` and `definitionDigest`. Make `report` prefer the recorded declaration over the current file (B2).
3. `src/review.ts:85-87` — add the time bound to the rules, and fix the `new_column` hint at `src/task-file.ts:33` so it cannot contradict rule 5 (B3).
4. Cheap and worth doing in the same pass: print the tolerated list in `taskctl accept` (M2); drop or narrow `extra_file` (M1); sort `tolerate` before hashing (M5); add a `parseVerdict` test for `externalChanges` and a review-only-path test (test gaps 1-2); add `--tolerate` to `taskctl add` so an operator declaration is a journaled action (M4).

After 1-3 this ships. Item 1 is the one I would not defer: without it the commit's stated containment does not exist on the path the real incident took, and I have the run that shows it.
