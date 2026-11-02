# Fenced execution, fail-closed recovery, evidence-bound completion

Supersedes the unsafe recovery assumptions in ADR-0001 and the absent-check pass policy in ADR-0006. Narrows ADR-0005: this increment reserves canonical resources and serializes execution; it does not implement automatic worktree creation, merge, or cleanup.

## Decision

- Use a unique ownership generation for each run. Claim, heartbeat, release and all worker mutations share a per-task filesystem mutex. A dead mutex is not stolen based on age; it requires operator reconciliation.
- Renew throughout the task, including turns, checks, telemetry and handoffs. Losing ownership cancels controlled work and prohibits stale task/session/retry/final writes.
- Persist `attempt.json` before dispatch. It records execution identity and uncertainty, **not task status**. Markdown remains the sole lifecycle authority.
- Use controlled execution handles with inspect and cancel. A timeout is retryable only after confirmed shutdown. Unsupported or unconfirmed cancellation blocks, retaining the workspace reservation. CLI termination is not proof that an OpenCode backend session stopped.
- Reserve canonical workspaces exclusively. Worktrees sharing a git common directory are conservatively serialized. No reservation is stolen on timeout.
- Publish path-range reservations in a process-shared user-temp registry before creating the stable cwd marker. Compare both cwd and Git metadata path ranges; initialization or new linked worktrees cannot bypass earlier reservations. Missing local markers do not reset registry ownership.
- Missing/blank acceptance means `blocked` for review, with no consumed retry. A completion request is not evidence.
- Record check command/output, timestamps, attempt ID, task-definition digest and artifact digests in `acceptance.json`. Completion validates generation and definition in the same guarded operation as the final state write. Changed source artifacts invalidate checks.
- Interrupted active/uncertain executions, including legacy `running` tasks without execution identity, require reconciliation instead of blind restart.

## Limits

This is a cooperative local-controller protocol, not a sandbox or human-only authorization boundary. An agent running as the user can bypass it by editing files directly. Operator edits outside the protocol are not transactional. Filesystem writes are atomic replacements, not a transactional database or a guarantee against power-loss persistence failures. Scientific validity and the quality of an acceptance command remain the task author's responsibility.

## Recovery

Stop/reconcile the original controller, process tree and backend session first. Inspect `attempt.json`, `acceptance.json`, handoff notes, and workspace changes. Preserve evidence. Only after proving no previous execution can produce further effects, archive the attempt record and matching workspace reservation (or keep a settled record), and reset the task to `open` as appropriate. A stale lock or reset status alone is not replay permission. Do not kill a process on an old PID alone; PID reuse is possible.

The workspace registry is `<user-temp>/opencode/taskctl-workspaces/reservations.json`, with stable local markers at `<cwd>/.taskctl-workspace.lock/`. Stop all controllers sharing that registry before manual registry edits; reconcile and archive only the matching reservation, not other tasks' records. Unknown/corrupt initialized registry state fails closed.

No automatic merge, deployment, live/paid pilot or expanded backend is part of this decision.
