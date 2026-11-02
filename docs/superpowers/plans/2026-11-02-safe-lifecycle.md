# Safe lifecycle implementation plan

**Goal:** Fix T1–T4 without replacing Markdown storage.
**Spec:** `docs/superpowers/specs/2026-11-02-safe-lifecycle-design.md` (approved chat design).
**Architecture:** Serialized filesystem ownership plus fail-closed attempt recovery, controlled process handles, exclusive canonical workspace reservations, revision-bound check evidence.
**Tech stack:** TypeScript, Node >=22, Vitest; no new runtime dependencies.

## Global constraints

- Markdown remains authoritative for task status.
- No live/paid agents, automatic merging, new backends or external publishing.
- Unknown shutdown/recovery fails closed, never silently retries.
- Preserve the user-authored reference review.

## Task 1: Controlled execution (independent worktree)

Files: `src/execution.ts`, adapters/types.ts, adapters/opencode.ts, acceptance.ts; process fixture tests.

Interfaces: `Execution<T> { result: Promise<T>; inspect(): ExecutionInfo; cancel(): Promise<boolean> }`, `ExecutionInfo { pid?: number; state: 'running'|'exited'|'uncertain' }`; adapter `start?(args: PromptArgs): Execution<PromptResult>`; `startAcceptance(command,cwd): Execution<AcceptanceResult>`. Keep existing prompt/runAcceptance APIs. OpenCode cancellation must return false unless backend shutdown can be proven.

- [x] Add failing local-process tests for cancellation/inspection and empty checks.
- [x] Run targeted tests red, implement process-tree lifetime control, run green.
- [x] Commit only owned files and return evidence.

## Task 2: Workspace identity and artifacts (independent worktree)

Files: `src/workspace.ts`, `tests/workspace.test.ts`.

Interfaces: `reserveWorkspace(cwd,attemptId): Promise<WorkspaceReservation|null>`; reservation `{ cwd:string; release():Promise<void> }`; `artifactDigest(cwd):Promise<string>`. Canonical paths; shared git common directory reservation; no age-based stealing. Digest tracks source bytes, including untracked files, excluding git internals and taskctl lock metadata; rejects symlink escape or changing/unreadable files rather than claiming a valid snapshot.

- [x] Add failing tests for exclusivity, aliases, ownership-safe release, artifact changes.
- [x] Run red, implement, run green, commit only owned files.

## Task 3: Ownership and worker integration (main session)

Files: claim.ts, worker.ts, runtime.ts, task-store.ts and lifecycle tests.

- [x] Add regression tests that currently allow stale acceptance and absent-check Done; run red.
- [x] Serialize all claim mutations and guarded callbacks, UUID run identities, bounded mutex acquisition with no unsafe stale-steal.
- [x] Integrate periodic renewal and guarded writes, execution cancellation, runtime records before execution, conservative recovery and workspace reservations.
- [x] Bind final acceptance evidence to definition and artifact identity; block missing checks and drift.
- [x] Run targeted tests green; update obsolete expectations for intentionally changed recovery/policy behavior.

## Task 4: Documentation and verification

- [x] Update README and superseding ADR, and annotate findings with resolution/test mapping.
- [x] Run full offline suite and TypeScript check; review diff for unsafe retries and check-then-write races.
- [x] Record remaining real-backend cancellation limits; do not claim live-provider validation.

## Safety review follow-up

Independent review reproduced unexpected OpenCode CLI death permitting retries, a reservation identity change after `git init`, and overlapping non-Git workspace acquisition. These required regression fixes before final verification. The CLI-death regression was observed red (two dispatches) and green (one dispatch, persisted uncertain state).

All review findings resolved, including a follow-up pre-init reservation versus newly linked worktree case (red acquired both; green rejects metadata path overlap). Regression work also exposed gray-matter caching mutable session arrays across identical Markdown files; parsing now copies the array, verified red/green. Narrow final source re-review found no unresolved important issues.

Final local verification: `node node_modules/vitest/vitest.mjs run --reporter=dot` with `TASKCTL_E2E` unset: **158 passed, 1 skipped** (live-provider smoke deliberately skipped). `npx tsc --noEmit` and `git diff --check` passed. Windows execution-tree fixtures ran; POSIX cancellation was not exercised on this machine. Source fingerprints cover bytes and link targets, not permission modes or external dependency integrity; snapshots are not filesystem transactions.
