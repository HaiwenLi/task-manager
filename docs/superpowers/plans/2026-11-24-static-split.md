# Static Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a complex draft parent be split, by one planned and human-approved step, into linked child tasks that
run in dependency order and are integrated by the parent — without ever running a child before approval, holding a
workspace while waiting, or losing the plan to a crash.

**Architecture:** Add `parent_id` to the task definition and gate on it in one shared module that the scheduler,
the claim path and the board all consult. A split plan is one model call recorded as `split-plan.json`; applying
it is deterministic file publication with the parent linked last. Integration is ordinary execution with a bounded
summary of what each dependency produced.

**Tech Stack:** TypeScript, Node.js 22, Vitest; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-24-adaptive-execution-design.md` §12, §7.1, §15.1 item 10.

## Global Constraints

- Nothing runs before the parent is approved; the gate is enforced at claim time, not only by the scheduler.
- A parent never holds a workspace reservation while its children run.
- Classification and planning never lower `risk` or `human_check`; children inherit both.
- Applying a plan never consults the model. Re-applying the same plan is a no-op at every crash point.
- One split level only. Nested and dynamic splitting are out of scope.
- All new behavior starts with a failing test.

## Review Focus

1. A child with no dependency on its parent is still gated (Task 1 tests).
2. `runTask` itself refuses a gated or dependency-blocked task (Task 1 tests).
3. A dependency chain deeper than 50 finishes, and exhaustion is reported rather than silent (Task 2 test).
4. Crash before and after the parent link both resume without new ids or changed bytes (Task 5 tests).
5. An existing child that differs from the plan aborts publication for inspection (Task 5 tests).

### Task 1: Parent links and bundle-approval gating

**Files:** `src/task-file.ts`, `src/runtime.ts`, `src/eligibility.ts` (new), `src/scheduler.ts`, `src/worker.ts`; test `tests/split.test.ts`

- [x] Write failing tests for `parent_id` round trip and digest, self-parent refusal, draft-parent gating with and
      without a dependency, direct-claim refusal, unknown and cyclic parent links.
- [x] Implement the field, the shared gate (`draftAncestor`, `waitReason`), scheduler `ready`/`assertAcyclic`, and
      the claim-time refusal.
- [x] Run focused tests.

### Task 2: Scheduler bounds

**Files:** `src/scheduler.ts`, `src/cli.ts`; test `tests/scheduler.test.ts`

- [x] Write a failing test for a dependency chain deeper than the old fixed pass budget.
- [x] Scale the backstop with the queue, keep the existing "did anything really run" end condition (a refused
      claim no longer counts as running), and report exhaustion.

**Evidence (2026-11-24), Tasks 1–2:** `tests/split.test.ts` 9 tests and two scheduler tests; full suite 490 passed /
1 skipped; `npx tsc --noEmit` clean. Mutation check, control clean and restored clean: the scheduler's own filter,
the chain walk in `draftAncestor`, the claim-time refusal, "refused claim is not progress", the scaled budget, the
exhaustion report, the unknown-parent check, `parent_id` in the digest and the self-parent refusal were each killed
by the test named for them.

Implementation notes the plan did not fix:

- The plan said to end on "nothing changed". Not done, on purpose: the existing comment states that progress is
  "did we run anything", not "did a status string change", because a rework legitimately returns a task to the
  status it started in. A board fingerprint would have to enumerate every field a real run touches to be safe.
  The defect was narrower — a *refused* claim was counted as running — so only that was fixed.
- The first mutation run showed the scheduler filter **untested**: removing it failed nothing, because the
  claim-time gate held on its own. Two guards that cover each other are fine; a guard nobody pins is not. `ready`
  is exported and unit-tested for that reason.
- `runScheduler` gained `options.run`, a test seam replacing the per-task runner. The chain test with real
  execution took 10–19 s per run and timed out under load; it now takes about 1 s and still fails when the budget
  is fixed at 50. Real execution through a chain is asserted by the integration test in Task 6.
- `overlappingAdapter`'s wait went from 250 ms to 1.5 s. It is a pre-existing load-sensitive timing test; the
  new split tests add parallel load and made it fail once for a reason unrelated to scheduling. A real
  regression still fails, 1.5 s later.

### Task 3: Dependency summaries for integration

**Files:** `src/dependencies.ts` (new), `src/protocol.ts`, `src/review.ts`, `src/worker.ts`; test `tests/dependencies.test.ts`

- [x] Write failing tests showing a task with dependencies receives a bounded summary (id, title, verdict,
      handoff status, artifact paths, evidence location) and a task without dependencies receives none.
- [x] Implement the summary builder and inject it into the worker prompt and the review evidence.

**Evidence (2026-11-24), Task 3:** `tests/dependencies.test.ts` 8 tests; full suite 498 passed / 1 skipped;
`npx tsc --noEmit` clean. Mutation check, control and restore clean: the worker injection, the review-evidence
injection, the total bound, the missing-id guard, "status line only, not the handoff's findings", and the
no-dependency render of the verbatim protocol were each killed by the test named for them.

Implementation notes the plan did not fix:

- The protocol copy is spec-fixed and pinned verbatim by `tests/protocol.test.ts`. A first attempt put the
  conditional on its own line inside the template, which left one extra blank line for every task; the pinned
  test caught it. The expression now sits at the end of the preceding line, so a task without dependencies
  renders byte-for-byte as before.
- The summary carries a dependency's status line and file list, not its findings or next steps: those are the
  predecessor's working notes, and replaying them invites the integrator to inherit stale plans.

### Task 4: Planning

**Files:** `src/split.ts` (new), `src/review.ts`; test `tests/split.test.ts`

- [x] Write failing tests for id allocation, key-to-id mapping, and every rejection: unknown/self/cyclic
      references, missing criteria, `mechanical` without a command, `render` without targets, duplicate or
      malformed keys, dropped parent criteria, nested split, non-JSON output.
- [x] Implement the planner prompt, parser and validation; record the plan with the parent's definition digest.

### Task 5: Idempotent publication

**Files:** `src/split.ts`; test `tests/split.test.ts`

- [x] Write failing tests for publication order, gating after publication, resume after a crash before the parent
      link, byte-identical re-apply after it, and refusal on a non-draft parent, a stale digest, a differing
      existing child, or a colliding unrelated task.
- [x] Implement `applySplitPlan`.

**Evidence (2026-11-24), Tasks 4–5:** `tests/split-plan.test.ts` 36 tests (17 of them the rejection table); full
suite 534 passed / 1 skipped; `npx tsc --noEmit` clean. Mutation check, control and restore clean, 16 reversals:
stale parent digest, forgotten link record, differing child, unrelated task on a planned id, non-draft parent,
orphaned child, dropped final criterion, criteria taken from the plan instead of the parent, child cycles,
`mechanical` without a command, dependency outside the plan, lowered risk, dropped human gate, child published
without `parent_id`, nested split, and an unreadable plan read as "none" were each killed by the test named
for them.

Implementation notes the plan did not fix:

- The planner names children by a `key`; taskctl allocates ids after the board's highest number and stores them
  in the plan. An "id already taken" branch in the allocator turned out to be unreachable by construction and
  was removed rather than left as untested code; the real protection is at apply time, where an existing id can
  be told apart from a matching child.
- `validateSplitPlan` is the one judge of what a plan must satisfy, used for a fresh plan and for one read back
  from disk. Parsing is lenient on purpose, so a hand-edited plan is held to exactly the rules a model's is.
- The parent's final criteria are kept by construction at apply time: they are copied from the parent, never
  from the plan. A hand-edited plan therefore cannot drop one, however it was edited.
- Re-applying after the parent was hand-edited is a no-op, not a refusal. The link record identifies the
  plan; past that point the parent is the person's to edit before signing.
- Three write sites needed their directory created: `writeRuntime` does not, and a draft parent can be a bare
  file with no task directory yet.

### Task 6: Command, visibility, end-to-end proof, documentation

**Files:** `src/cli.ts`, `src/report.ts`, `README.md`; tests `tests/split.test.ts`, `tests/split-flow.test.ts`

- [ ] Write failing CLI tests for `taskctl split --task <id> [--apply]` (plan only, plan-and-apply, re-plan
      refusal after publication, apply of an existing plan) and for status/board wording of bundle waiting,
      dependency waiting and a stuck dependency.
- [ ] Write the integration test: nothing runs before approval; children run in order; the parent integrates
      with the summaries and its own review; all finish.
- [ ] Implement the command and wording; document the flow; run `npm test`, `npx tsc --noEmit`,
      `git diff --check`.
