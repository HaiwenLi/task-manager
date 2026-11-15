# Review stage and human attribution

Supersedes the "absent acceptance blocks" outcome of ADR-0006 for tasks that carry
`criteria`, and adds the pipeline stages ADR-0007 left out: a draft gate, an
independent review stage, a human sign-off state and per-stage attribution.

## Decision

- A task file gains `criteria`, `complexity`, `risk`, `workdir`, `depends_on`,
  `human_check` and `review_rounds`. Markdown stays the only lifecycle authority.
- `draft` and `awaiting-human` are human gates: no orchestrator path writes into
  them or out of them. Only `approve` and `accept`/`reject` cross them.
- The clarify session drafts a spec (`tasks/<id>/spec.md`) with numbered criteria.
  `complex` tasks wait for `approve`; `simple` tasks open immediately but keep
  the spec and its assumptions. Downgrading requires an explicit statement in the
  user's own words (`简单任务`, `simple:`) or `--simple`; the tool never downgrades
  on its own, because a wrong downgrade is the expensive kind.
- The review stage runs in a **fresh session** and sees only written evidence:
  spec, acceptance command and result, artifact digests, handoff note, journal
  tail. It never sees the worker's conversation. Its verdict is JSON; anything
  that cannot be parsed, omits a criterion, or contradicts itself becomes
  `unclear`, which parks the task for a human instead of spending a retry.
- A `fail` verdict writes a `review-failed` handoff note, increments
  `review_rounds`, and returns the task to `open`; after `maxReviewRounds` it
  blocks. `pass` ends at `done` only when the task is neither `risk: high` nor
  `human_check`; otherwise it stops at `awaiting-human`.
- Absent acceptance command: with `criteria` present the review is the gate and
  `acceptance.json` records `skipped: true`; with neither, the task blocks. The
  safety property of ADR-0006 is kept (nothing passes without an independent
  gate) without forcing a shell command onto office, design or research work.
- Every human decision writes `.taskctl/audits.jsonl` with the stage blamed
  (`clarify` / `worker` / `reviewer`) and, on acceptance, `highlight: true`.
  `taskctl metrics` aggregates this; it is the input for improving the pipeline,
  not a claim of model training.
- The board is a generated `.taskctl/board.md`, rewritten atomically on every
  state change. Nothing reads state back out of it, and it lives outside
  `tasks/` because `TaskStore` treats every `tasks/*.md` as a task.

## Why not a web UI

Rendering is someone else's job: a browser or editor watching a regenerated
Markdown file needs no server, no session, and no second data model. A generated
file also stays diffable and survives a host change.

## Limits

Cooperative local protocol, not a sandbox: a worker with the same filesystem
permissions can bypass it. The reviewer shares the agent's permissions and can be
wrong; `review_rounds`, audit attribution and spot checks are how that shows up.
`unclear` is not a verdict about quality, only about evidence. No live-provider
pilot was run for this increment; the end-to-end evidence is offline
(`tests/pipeline-e2e.test.ts`).
