# Budget guard: pay-per-token and unknown-cost models do not run by default

Refuses a task before any model session starts when a model it would run on
costs money per token or does not say what it costs. Grown from appendix D of
the design (`docs/superpowers/specs/2026-11-25-learning-loop-design.md`) once
the branch was built and reviewed.

## Context

- Retro P01: a model chain copied from an older project ran six tasks on
  pay-per-token models while the same machine's subscription models cost
  nothing. Nothing checked this before work started.
- The backend's model catalogue already carried a price for every model. The
  adapter read the list for variants and context limits and left the cost out.
- A provider rejection says nothing about the work, so a task walks a chain of
  models and may fall back to any of them. The guard has to judge the whole
  chain, not the model at its head.

## Decision

- Before anything is claimed, `runTask` judges every model the attempt may run
  on: the worker's chain (`taskChain(cfg, task)` — a task with its own `model`
  never runs the configured one, so that is not judged), the reviewer's chain
  (`reviewerChain(cfg)`), and, for a role whose chain is empty, the backend's
  default model, which is what that role then runs on. A review-only recovery
  judges the reviewer's side alone. `add` (not `--quick`) and `split` judge the
  one model their session runs on before it starts: `add` before it writes the
  task file, `split` before it calls the planner.
- A model is **free** when the sum of the prices it reports is 0, **paid** when
  that sum is not 0, and **unknown** when the catalogue has no entry for it or
  the entry reports no price. Free runs unless `allowedProviders` is set and
  leaves the provider out. Paid needs `allowedModels` to name it,
  `allowPaidModels`, or a `maxCostPerMillion` it does not exceed. Unknown needs
  `allowedModels` to name it or `allowedProviders` to name its provider.
  Allowing is always explicit: a subscription whose models report no cost has
  to be named (design §9.2).
- A model the backend has disabled is never allowed.
- **Fail closed.** A catalogue that cannot be read, times out or comes back
  empty refuses every model the call was asked about (`模型目录读不到…`,
  `模型目录是空的…`). None of that is a stable truth about a backend that can
  run anything: on 2026-11-25 one probe of the real service saw no models where
  three later probes saw 124 each. Such an answer is not remembered, so the
  next call asks again. When the backend names no default model for an empty
  chain, the verdict is `后端默认模型无法确认`.
- **Read per directory, kept per process.** The service answers `model.list`
  and `model.default` by the directory it is asked in — a project-level
  `opencode.json` changes both — and a session starts in the task's workdir.
  So the catalogue and the default are read in that directory, and one answer
  is kept per adapter and directory for the life of the process. Both reads go
  out together.
- **Optional on the adapter.** An adapter without `modelCatalog` is not guarded
  at all, and `taskctl models` says so.

## Consequences

- A refused task is a `refused` outcome: no model session started and no
  attempt record was written. It stays `open`, is not `blocked`, needs no human
  recovery and is not progress. `runScheduler` offers it once in a run and
  leaves it out of `pending`; `watch` keeps it out of its candidates for five
  minutes (`REFUSED_RETRY_MS`) and judges it again after that, so a catalogue
  that was unreadable is asked for again while the rest of the board runs.
- **There are two refusal paths, with the same guarantee.** The first judgement
  is before the claim and writes nothing at all. The task is judged again right
  after the workspace reservation, on the task as the board holds it once it
  was re-read after the claim: a `model:` edited onto the task between the
  caller's snapshot and the claim must not run unjudged. On that path the
  claim's lock record and the reservation were written and are released again,
  and an `execution-state-invalid` line stays when the execution state could
  not be read. No session and no attempt record, on both.
- A refusal is reported once per process for a task and its reason — the
  rendered verdicts, not only the models — so the same verdicts at every wake
  of a queue are said once, and a refusal for another reason is news. The line
  is printed, and goes to the `--log` file when there is one, but never into
  the task's own directory. `taskctl run` exits 1 and prints
  `[scheduler] N task(s) refused by the budget guard; no model session was
  started for them`, after the controller-error line, each for its own count.
- An existing configuration is refused on its first `run` after the upgrade,
  until the allow-lists are filled in. That is intended: P01 came from a copied
  configuration. `taskctl models` shows every verdict before anything runs and
  exits 1 when any is refused. It starts no session, takes no `--tasks-dir`,
  and judges the configured `workdir`, so it has to be run from — or pointed
  at — the directory the tasks run in.
- A catalogue entry carries credentials (`settings.apiKey`, `headers`). A
  verdict holds only the fields it was built from, and a failed `opencode api`
  call is never quoted: its rejection is the operation and a code, with the
  original error as `cause`, because the service's stderr can quote
  configuration and the first 200 characters of a message reach the reason,
  the journal and the log.
- The guard cannot see inside a subscription. `opencode-go` lists four free
  models and prices the rest (design §9.2), and the catalogue does not say
  which of them the subscription covers: those need `allowedModels`.
- Not superseded: the model fallback chain, the shared cooldown and the quota
  backoff are unchanged. The guard acts before a session starts and does not
  touch the rotation of a running attempt.
- Not covered: a catalogue that was read is kept for the life of the process,
  so a long-lived `watch` works from prices that grow stale; and the commands
  that call no model are outside the guard.
