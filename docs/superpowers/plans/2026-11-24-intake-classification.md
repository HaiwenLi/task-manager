# Intake Classification and Consensus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Classify intake into quick/simple/complex management lanes, block only outcome-changing information gaps, and reuse explicit historical human feedback to improve first-pass acceptance.

**Architecture:** Extend the existing clarify interaction with a small assessment section and conservative parser; keep risk/verify immutable by classification. Store deterministic human feedback beside the board, require answers only for genuine gaps, and measure user-driven versus automatic rework separately.

**Tech Stack:** TypeScript, Node.js 22, Vitest; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-24-adaptive-execution-design.md` §16 and §15.

## Global Constraints

- Classification changes management effort only; it never lowers risk, human gates or verification.
- Missing/invalid classification falls back to complex + draft unless the operator explicitly chose simple/quick.
- Questions are limited to three and only when an answer changes deliverable, acceptance, scope or risk.
- No model-generated preference writes and no hidden training.
- All new behavior starts with a failing test.

## Review Focus

1. Explicit operator lane/execution overrides beat model classification (Task 1 tests).
2. Needs-information stays draft even when simple (Task 1 tests).
3. Clarify-attributed rejection cannot reopen the worker (Task 2 tests).
4. Historical feedback is bounded and human-authored (Task 2 tests).
5. Missing assessment sections remain backward compatible with existing clarify fixtures (Task 1 tests).

### Task 1: Assessment parsing and lane-aware add

**Files:** `src/intake.ts`, `src/cli.ts`, `tests/intake.test.ts`, `tests/cli-add.test.ts`

- [x] Write failing tests for quick/simple/complex, clear/assumptions/needs-information, invalid fallback, three-question bound, explicit overrides and classification.json.
- [x] Run them and confirm current add lacks assessment behavior.
- [x] Implement `parseIntakeAssessment` and extend the existing clarify prompt/output with `管理分类`, `信息充分性`, `分类理由`, `补问` while preserving criteria extraction.
- [x] Apply the selected lane without changing risk/verify; write questions.md and keep needs-information in draft.
- [x] Run focused tests and commit `feat(intake): classify management effort and information gaps`.

### Task 2: Answers and inspectable feedback history

**Files:** Create `src/feedback.ts`; modify `src/cli.ts`, `src/spec.ts`; test `tests/feedback.test.ts`, `tests/cli-add.test.ts`, `tests/pipeline-e2e.test.ts`

- [x] Write failing tests for `taskctl answer --task <id> --file`, approval blocked by unresolved questions, and clarify rejection returning to draft rather than open.
- [x] Write failing feedback tests showing reject/audit notes feed the next similar clarify while plain passes and model output do not mutate preferences.
- [x] Implement answer append + marker clearing, deterministic feedback.jsonl recording/relevance selection, and clarify-stage re-intake.
- [x] Run focused tests and commit `feat(intake): close the consensus feedback loop`.

**Evidence (2026-11-24):** `tests/feedback.test.ts` 11 tests; full suite 469 passed / 1 skipped; `npx tsc --noEmit` clean.
Mutation check (one guard reversed at a time, control run clean, file restored): approve-block, clarify→draft,
feedback injection, answer-into-task-body, marker clearing, empty-note skip, task-type filter, history bound,
packet budget and answer-as-feedback were each killed by the test named for that guard.

Implementation notes the plan did not fix:

- `answer` appends to `spec.md` **and** the task body. The worker's brief is the body, not `spec.md`, so an
  answer written only to the spec would be a constraint the worker never saw but the reviewer judges by.
  Both are definition text, so the revised task has a new digest.
- A clarify-attributed `reject` writes the reason as an open question (`questions.md`), so the same
  `answer` → `approve` loop serves both model-raised and human-raised questions.
- `accept --note` was added: the design lists human accept reasons as a feedback source, and `accept` had no
  way to carry one. A plain accept still records nothing.
- Answers are recorded as feedback (`action: answer`), which is how §16.2's "do not re-ask an answered
  question" is honoured without scanning old specs.

### Task 3: First-pass metrics and documentation

**Files:** `src/audit.ts`, `src/cli.ts`, `README.md`, relevant metrics tests

- [x] Add failing assertions for first-pass user acceptance, automatic worker rework and needs-information counts.
- [x] Implement metrics without conflating human and automatic rework; document lane behavior and answer/feedback records.
- [x] Run `npm test`, `npx tsc --noEmit`, and `git diff --check`; commit `feat(metrics): measure first-pass user acceptance`.

**Evidence (2026-11-24):** `tests/metrics.test.ts` 8 tests plus one CLI assertion each in `cli-add`, `review-pending`;
full suite 478 passed / 1 skipped; `npx tsc --noEmit` clean (it caught one real error the test run did not: an
under-typed `readFlow` parameter). Mutation check, control clean and restored clean: the `worker rework` event,
the `review review-only` event, first-pass excluding human rejections, counting the resume decision rather than
acceptance outcomes, the `-` for an empty denominator, the classified-only intake denominator, and both parser
guards (`laneEscalated`, unusable lane → complex) were each killed by the test named for them.

Implementation notes the plan did not fix:

- Rounds are counted from explicit journal events. `accept()` wrote no event when it decided to resume the
  worker after a failed gate, and a review-only claim looked identical to an ordinary review round, so both
  now record one (`worker rework`, `review review-only`). Counters such as `review_rounds` are reset by
  `retry` and cannot serve as history.
- The old `返工率` line was removed from `summarizeAudits`. It divided tasks with `review_rounds > 0` by *all*
  tasks, including ones that never ran, and next to the new lines would have shown two contradictory
  "rework" numbers. `summarizeAudits` now takes the audit records only.
- `classification.json` gained `laneEscalated` and records `proposedLane: null` when the model's lane was
  unusable, so "the model said complex" and "taskctl had to choose complex" are distinguishable.
- A task with a torn `classification.json` is excluded from intake denominators rather than guessed at.
