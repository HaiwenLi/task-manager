# Safe execution lifecycle

Approved in chat on 2026-11-02. Scope: review findings T1–T4, not the reference repositories.

## Authority and synchronization

Markdown remains the only task-status authority. Each run gets a UUID ownership generation, encoded in its worker identity. Claim, renewal, release, and owner-guarded mutations share a per-task filesystem mutex. Mutexes are never stolen on age alone: a stranded mutex fails closed and requires operator reconciliation. This is cooperative local-process safety, not protection against a worker with arbitrary filesystem permissions.

Periodic renewal runs throughout the task. Every orchestrator mutation, including session/retry writes and final acceptance, checks the exact generation while holding the same mutex as takeover. A fresh task-definition digest is compared at completion. A changed definition invalidates the run.

## Execution and recovery

Execution handles expose result, inspection and cancellation. Process-tree cancellation is bounded; an unsupported backend or unconfirmed stop is uncertain, never a retry permission. OpenCode CLI termination does not prove a separate backend session stopped: interrupted OpenCode work remains uncertain. Acceptance commands use process-tree cancellation too.

Before side effects, persist a runtime attempt record (attempt identity, timestamps, backend, workspace, operation, process identity when available). It owns execution facts, not task status. An interrupted active/uncertain record blocks replay on restart. A workspace reservation survives uncertainty. No PID-only automatic killing on restart.

Canonical workspace reservations prevent conflicting execution, including path aliases. Git worktrees in one repository are conservatively serialized. This increment does not create or merge worktrees automatically.

## Acceptance

Missing/blank acceptance blocks for review, without consuming retry budget. Only an observed successful check can permit Done. Evidence includes attempt ID, task-definition digest, workspace artifact digest before/after checks, command, timestamps, result and output. Artifact or task-definition drift blocks completion. Ownership checking and final task update are one guarded operation. Direct human filesystem edits are not a transactional or security boundary.

## Validation

Deterministic fixtures cover long-turn renewal, stale-generation writes, concurrent claims, timeout shutdown, uncertain retry suppression, restart suppression, workspace alias conflicts, missing checks, definition/artifact drift, and persisted evidence. Existing Markdown continues to load. No live provider, production merge or paid pilot is authorized.
