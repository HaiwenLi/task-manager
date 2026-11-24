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

- [ ] Write failing tests for quick/simple/complex, clear/assumptions/needs-information, invalid fallback, three-question bound, explicit overrides and classification.json.
- [ ] Run them and confirm current add lacks assessment behavior.
- [ ] Implement `parseIntakeAssessment` and extend the existing clarify prompt/output with `管理分类`, `信息充分性`, `分类理由`, `补问` while preserving criteria extraction.
- [ ] Apply the selected lane without changing risk/verify; write questions.md and keep needs-information in draft.
- [ ] Run focused tests and commit `feat(intake): classify management effort and information gaps`.

### Task 2: Answers and inspectable feedback history

**Files:** Create `src/feedback.ts`; modify `src/cli.ts`, `src/spec.ts`; test `tests/feedback.test.ts`, `tests/cli-add.test.ts`, `tests/pipeline-e2e.test.ts`

- [ ] Write failing tests for `taskctl answer --task <id> --file`, approval blocked by unresolved questions, and clarify rejection returning to draft rather than open.
- [ ] Write failing feedback tests showing reject/audit notes feed the next similar clarify while plain passes and model output do not mutate preferences.
- [ ] Implement answer append + marker clearing, deterministic feedback.jsonl recording/relevance selection, and clarify-stage re-intake.
- [ ] Run focused tests and commit `feat(intake): close the consensus feedback loop`.

### Task 3: First-pass metrics and documentation

**Files:** `src/audit.ts`, `src/cli.ts`, `README.md`, relevant metrics tests

- [ ] Add failing assertions for first-pass user acceptance, automatic worker rework and needs-information counts.
- [ ] Implement metrics without conflating human and automatic rework; document lane behavior and answer/feedback records.
- [ ] Run `npm test`, `npx tsc --noEmit`, and `git diff --check`; commit `feat(metrics): measure first-pass user acceptance`.
