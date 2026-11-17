# Lanes, verification kinds, and escalating up only

Adds a capture lane that writes no spec, a declaration of *what proves the work is
finished*, and a way for a run to ask for more scrutiny. Written after a real task
— turning an online multi-table into a local HTML archive — where every existing
gate would have passed a page that could not be opened.

## Context

Three things were true at once on that task:

- It was small (one source, one artifact, no irreversible write), so spending a
  clarify session and a signature on it was absurd. The operator said "this is a
  simple task" and the whole run happened outside taskctl — which is the worst
  outcome, because nothing was recorded.
- Its correctness was not readable. A script threw before first paint and the page
  was blank; a later build stuck 40px out of a phone viewport. Both read as clean
  code. The reviewer sees text, diffs and digests, and would have passed both.
- Its shape changed while it ran — a drawer, a deep link, a filter panel, none of
  them in the original intent, all of them decided by the executor.

## Decision

**Capture lane.** `taskctl add --quick` writes no spec and calls no model: the
intent is the definition. Quick implies `complexity: simple` (one field, one
meaning: "do not wait for a signature"). The price is explicit: a quick task with
no criteria parks at `awaiting-human` instead of blocking, because nothing was
written down for a reviewer to judge it against.

**Verification kind.** `verify` says what has to agree the work is done:

- `human` — the reviewer's verdict on `criteria` (unchanged default);
- `mechanical` — the `acceptance` command's exit code, and no reviewer is started;
- `render` — a headless browser opens each `render_targets` page at each viewport
  and requires: content is drawn, no horizontal overflow, no uncaught exception.
  Screenshots are kept under `tasks/<id>/evidence/`.

`verify` and `renderTargets` are part of `definitionDigest`: switching the bar for
"done" mid-attempt invalidates the attempt instead of being judged under it. A
render check that cannot run (no browser) blocks the task — a check that never
happened is not a pass.

**Escalation moves up only.** A run can escalate itself, never de-escalate:

- the executor writes `ESCALATE: <reason>` in a turn; or
- the run needs a session handover (turn budget or context exhausted).

Escalated work keeps running but loses the mechanical/render shortcut and goes to
the reviewer. Nothing in the task file changes, so the digest is untouched and the
running attempt is not invalidated; the reason lands in the journal as
`event: escalated` and on the event stream.

## Consequences

- Cheap work can now be recorded instead of happening outside the tool, which is
  the only way the "do small tasks need the manager" question ever gets data.
- `mechanical` and `render` move the finish line from a model's judgement to
  evidence the orchestrator produces itself. That trades judgement for
  reproducibility on purpose: an exit code and a measured layout can be re-run, a
  reviewer's opinion cannot.
- The render check costs a browser launch (~1–3s per target), and needs a Chrome
  or Chromium binary on the machine. Missing browser blocks rather than degrades.
- Escalation is recorded but not yet reflected in `complexity` on disk, so
  `board` still shows the lane a task was captured in. That is deliberate for now:
  the file records the operator's declaration, the journal records what happened.
- No classifier decides a lane. Classification in advance needs the understanding
  that doing the task produces, and a wrong downgrade is silent. The lane is
  chosen by a person or explicit flag, and escalation catches the times that
  choice was wrong.
