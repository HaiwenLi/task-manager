# Model trouble and operator control — design

Status: approved by the owner on 2026-11-25; **re-baselined on 2026-11-28 against the tree at
`82d50f7`** and reviewed that evening (EGM panel; its record is §18). Parts 1–4 of §14 are built:
the deferral record (`src/model-wait.ts`), the outage report and the stuck list (`src/stuck.ts`),
`stop --now` and the signals (`src/stop.ts`), the rework document (`src/rework.ts`), the declared
lane and its examples (`src/intake.ts`, `src/lanes.ts`), and the guard-refusal record
(`src/guard-refusals.ts`). Where this text and the tree disagree, the tree is what runs; the
disagreement is a finding, and §18 lists the ones the 2026-11-28 review found.
Revised the same day it was approved, after the learning loop was merged (ADR-0011, ADR-0012,
ADR-0013), so that it builds on the budget guard instead of beside it; §17 says what that
revision changed.

Where it changes [the adaptive execution design](2026-11-24-adaptive-execution-design.md), it
supersedes that document: §14.1 (shared provider cooldown), §16.1 (the lane is chosen by the model
at intake), the refused-review half of its §9 (§16 below), and the sentence of its §17.3 that says a
stop is never a process-tree kill (§9 below). §10 lists the owner's decisions; everything marked
*call* is the author's and the owner can overrule it.

Sibling documents: [the adaptive execution design](2026-11-24-adaptive-execution-design.md),
[the learning loop](2026-11-25-learning-loop-design.md), [the review loop](2026-11-16-review-loop-design.md).
ADRs live under [`docs/adr/`](../../adr/): 0001 (Markdown is the source of truth), 0009 (lanes and
verification), 0010 (the lane is declared by the operator), 0011 (worker context), 0012 (budget
guard), 0013 (fixed sources).

Words used here with one meaning. **Owner** is the person who decides; the document does not say
"operator" for that person, and it does not use a pronoun where the actor matters. **A run** is one
`run`, `watch` or `retry --review-only` process. **The controller** is the code in that process that
judges and writes. **An attempt** is one claim of one task, from claim to settle. **A turn** is one
agent session turn inside an attempt. **A round** is one pass over a chain inside an attempt (§6).
**The board** is the set of task files. **A deferral** is not a status: the task stays `open` and
carries `tasks/<id>/model-wait.json`. **Adapter** is the `opencode` wrapper
(`src/adapters/opencode.ts`), **backend** is the `opencode` service it drives, and **provider** is
the model vendor behind that service.

## 1. Intent

In a real run on 2026-11-24 one provider refusal turned a task `blocked` and parked the board for
fifteen minutes, and only a manual `retry` brought anything back. The owner's requirements, in the
owner's terms:

- a refusal is answered by switching models, not by blocking;
- the window is 60 000 ms (60 seconds), not fifteen minutes, and no step waits for the owner to
  press `retry`;
- when a model stays unavailable, try three or four times, then block **that task** and move on to
  the others; what depends on it does not run, and what has no dependency on it is handled;
- usually no task can run when the model is unavailable; then stop everything and hand the choice of
  model to the owner;
- the models to use are the ones in the owner's coding plan. Anything else (paid models such as
  DeepSeek or OpenCode) is a last resort and is used only after the owner has been told that it may
  be billed and has decided;
- the owner can stop running work at any time, including a model that was added to the chain and
  turns out to be unsuitable; the owner runs an interrupted task again;
- the tool keeps a status, so the owner can ask at any time which tasks are stuck and why;
- the controller points the worker at a document that says why the work was rejected, instead of
  lengthening the prompt;
- the lane of a task (quick, simple, complex) is decided by the owner for now, and the tool asks the
  owner for it.

## 2. Goals, non-goals, anti-goals

Goals:

- G1. A provider refusal never by itself costs a task a retry or the status `blocked`.
- G2. The models of the plan are tried in order, without a person.
- G3. When every model refuses, the run stops, prints the report of §7, exits 3, and leaves the
  choice of model to the owner.
- G4. A task that keeps being refused while another task succeeds is held alone; tasks that depend
  on it wait; independent tasks continue.
- G5. The system never selects a model that is not in the configured chain.
- G6. One command (`taskctl status --stuck`) answers "which tasks are stuck, and why".
- G7. The owner can stop running work at once (`taskctl stop --now`), and what was interrupted can
  be run again.
- G8. The controller tells every rework turn which file to read for the reason the previous turn was
  rejected.
- G9. The lane of a new task is declared by the owner, and every declared lane is recorded in
  `.taskctl/lanes.jsonl`.

Non-goals:

- No model outside the configured chain is ever chosen automatically, and no new approval flow is
  built for paid models: the owner's decision is the configuration the owner edits
  (`taskctl.json`).
- No prediction of when a provider's quota resets.
- No change to how a turn that ran and failed for a reason other than a provider failure spends
  retries.
- No automatic re-run of a task that is `blocked` for its own reasons: a failed acceptance, exhausted
  retries, or the owner's `reject`.
- No new lane and no new task status. "On hold" is `blocked` with a reason; a model deferral is not
  a status either — the task stays `open` and carries `tasks/<id>/model-wait.json` (§6).
- No classifier by model in this round. A cheap model proposing the lane from the recorded examples
  is a later step (§12).

Anti-goals — each of these makes the design a failure even if every goal above is met:

- a wait nobody can see: a run that sits for minutes with no visible reason;
- a stop that records an execution as `uncertain` although the kill was confirmed, or that leaves a
  task that cannot be run again;
- a task held as "its own problem" when the model was down, or a run stopped for an outage when the
  model was serving other tasks;
- a task that runs without the owner's signature because the wording of its intent implied that it
  needed none.

## 3. Constraints

- Markdown task files are the source of truth (ADR-0001); a reviewer is always a fresh session;
  no new runtime dependency; the CLI stays hand-rolled.
- Every runtime change follows the repository's protocol: a failing regression test, the fix,
  directed mutations that the tests kill, and documentation kept in step.
- A run against the real backend needs the owner's explicit authorization.
- The adapter's assumptions were verified against `opencode` 2.4.1. Another machine may run a newer
  `opencode`; before any live run there, the owner re-checks the `opencode run --format json` events,
  `session.get`, `session.message.list` and `model.list`.
- Behaviour before this design, for reference: any provider refusal wrote a board-wide entry for
  `modelCooldownMs` (900 000 ms, 15 minutes); a task whose models were all cooling was `blocked`
  before it was dispatched; `stop` let the current attempt finish; `SIGINT` and `SIGTERM` were not
  handled. None of the four holds today (§6, §9). The review of 2026-11-28 found that the sentence
  here used to claim otherwise; §18.

## 4. Approaches considered

### 4.1 No model available

- *A. Defer the task and probe again automatically* — chosen by the owner (§10, decision 2). The
  task stays `open` with an earliest time at which it may be claimed again.
- *B. Sleep inside the running attempt* (what `quotaPause` does for a same-model re-probe). It is the
  smallest change of the three, but the sleeping attempt holds the task lock, the workspace
  reservation and a parallel slot for the whole wait: one waiting task excludes every other task in
  that workspace, a model down for an hour holds the run for an hour, and no status changes while it
  waits.
- *C. Configuration only*: a chain, `chainCycles` and a `modelCooldownMs` of 60 000 ms. It gives
  model switching today, but a task whose models are cooling is still `blocked` at the start of an
  attempt, and nothing probes again across attempts.

### 4.2 One task's trouble or an outage

From one task the two look the same. Three ways to tell:

- by the provider's error text — refused: the refusal text is the same in both cases;
- by asking a model with a probe request — refused: it spends quota and identifies no cause;
- by evidence the run already has — *call*, chosen: the decision uses only what this run saw, and its
  three branches are in §6, step 5. The evidence is not read from the board's shared cooldown table,
  which holds one entry per model — the latest refusal — so a refusal by any task replaces the entry
  that a success had cleared (§6).

The verdict is scoped to the task's own chain and to one controller:

- **An acceptance elsewhere proves only that the backend is alive.** It does not prove that the
  models of this task's chain work, so it never turns the task into "its own problem": the task stays
  deferred with its rounds spent and the run continues. *(Not built yet: today such an acceptance is
  read as "another task was served" and the task is blocked as its own problem; §18, finding P4.)*
- **One controller decides.** `run` does not start while a live `watch` lock is held, so no second
  process can declare an outage from its own empty evidence while the first is serving work. *(Not
  built yet: `run` takes no lock; §18, finding P2.)*

### 4.3 Stop

- *Graceful only* (before this design): the current attempt settles first, which is too slow when the
  owner stops a model that turns out to be wrong (§1).
- *Immediate with a confirmed kill* — chosen by the owner (§10, decision 6): the turn's process tree
  is cancelled, the attempt ends as stopped by the owner, the task returns to `open`.
- *Kill without confirmation* — refused: it leaves `uncertain` executions behind.

### 4.4 Escalation feedback

- *In the prompt* — the controller's failure text grows the prompt on every turn.
- *A document the worker is pointed at* — chosen by the owner (§10, decision 8, as narrowed there).
- *Nothing* — before this design.

### 4.5 The lane

- *The model classifies at intake* (the adaptive design's §16.1) — reverses ADR-0009, which says no
  classifier decides a lane, and a wrong downgrade is silent.
- *The owner declares it; the tool asks when it is not given* — chosen for now (§10, decision 9).
- *A cheap model proposes, from recorded examples* — later.

## 5. The model chain

- The chain is `modelChain` (then `modelFallbacks`), as before this design. The owner lists the
  models of the coding plan in the order the owner prefers; `README.md` shows the recommended
  configuration. Nothing is hard-coded for a provider.
- *Call.* When neither `reviewerModel` nor `reviewerModelFallbacks` is configured, the reviewer chain
  is the worker chain (`reviewerChain`, `src/models.ts`). Review independence is a fresh session, not
  a different model.
- No plan notice and no `modelPlan` key. That part belongs to the budget guard (ADR-0012,
  `src/budget.ts`). Before anything is claimed, the budget guard judges every model the attempt may
  run on: the worker chain of that task, the reviewer chain, and, for a role whose chain is empty,
  the backend's default model. `run`, `watch` and `retry --review-only` run that judgement first. A
  model that costs money per token, or whose cost the backend does not report, is refused unless the
  owner has allowed it in `taskctl.json` (`allowedModels`, `allowedProviders`, `allowPaidModels`,
  `maxCostPerMillion`). `taskctl models` prints every verdict before anything runs, and exits 1 when
  one is refused. A task the guard refuses is not a refusal in the sense of §6: no session starts and
  no model is asked.
- The system never adds a model to a chain, and never dispatches a task to a model the guard has not
  allowed. A paid fallback is used only when the owner has put it into the chain and allowed it in
  `taskctl.json` (§10, decision 5). The guard enforces that decision, and its verdict line tells the
  owner when a model may be billed per token.
- *Known cost of the judgement as built.* The guard judges every model the attempt may run on, and
  one unauthorized or unverifiable model therefore refuses the whole task — including a task whose
  head is allowed. An ordered effective chain (owner authorization valid without a fresh catalogue,
  verified-free models dispatchable, cost-capped ones still needing a fresh price) is not built
  (§18, P5).

## 6. A refusal

### 6.1 Definitions

- A **round** is one pass over the chain: each model is tried once, and a refusal moves to the next
  model at once. Every round starts again at the head of the chain, and rounds are one window apart
  (`modelCooldownMs`, 60 000 ms by default). A cycle wrap (`chainCycles`, default 0) re-probes
  refused models inside the same round, outside the shared window; at the default it never happens.
  The per-task rotation position in `tasks/<id>/models.json` is still written (`src/models.ts`)
  although every round starts at the head: it is dead weight and is to be removed (§18, P6).
- A **refusal** is what the adapter reports as a provider failure (`failure: "provider"`), whether or
  not the turn had already done work. *Call.* The adapter cannot tell a refusal before any work from
  a provider error after some work, and a provider error is not the task's fault either way: such a
  turn spends no retry. After work began the partial work stays in the workspace and nothing is
  judged; the next attempt is not a rework turn, because a provider failure is not a work rejection.
  A turn that ran and failed for any other reason keeps the handling it had before this design. A
  model the budget guard refused is not a refusal in this sense: no session starts and no model is
  asked (§5).

### 6.2 Behaviour

1. Inside a round, a refusal switches to the next model. It does not spend a retry.
2. If a model accepts the turn, the task proceeds as before this design. Success clears that model's
   cooldown.
3. If every model of the chain refused in the round, the attempt ends. It spends no retry and the
   task is not `blocked`. The task stays `open` and carries a **deferral** — a per-task runtime
   record, `tasks/<id>/model-wait.json`, with the stage (`worker` or `review`), the round count for
   that stage, the time of the first refusal, each model's refusal, and the earliest time at which
   the task may be claimed again, `modelCooldownMs` from now. A deferral is not a status. A pass in
   which no model refused this task, because every model was already cooling in the shared table, is
   not a round: the task waits for the earliest expiry and the scheduler offers it again then.
4. While a deferral's time lies in the future, the claim path refuses the task exactly as it refuses
   one whose dependency is not done. `run` and `watch` wait for the nearest deferral expiry when
   nothing else is runnable, then run another pass.
5. After `modelRounds` rounds without any model accepting, the run decides on its own evidence, on
   the task's own chain, when no attempt is in flight. There are three branches:
   - **A turn was accepted on this task's chain after this task's first refusal.** At least one model
     of the chain is serving turns, and the refusal belongs to this task: the task is `blocked` with
     a note naming every model and what each said. Its dependents wait (as before this design) and
     the run continues with the other tasks.
   - **A turn was accepted elsewhere, but not on this task's chain.** That proves only that the
     backend is alive. There is no verdict: the task stays deferred with its rounds spent and waits
     for the owner, and the run continues. *(Not built yet: today this case blocks the task as its
     own problem; §18, P4.)*
   - **No turn was accepted anywhere since the first refusal.** This is an outage. The controller
     leaves the task as it is — `open`, retries untouched — and the whole `run` or `watch` stops with
     the report of §7.
   - **Where the evidence comes from.** From the run, which records every turn a chain model accepted
     while it ran. "Accepted" means a worker turn that exited 0, or a reviewer turn that produced its
     own session and was not a provider refusal (`clearModelCooldown` in `loop` and `reviewStage`,
     `src/worker.ts`). It is not read from the shared cooldown table (§4.2).
   - **When the decision is taken.** Not inside the attempt that ran out of rounds. The controller
     takes the decision when no attempt is in flight. With `parallel` above one, another task's turn
     may be running on a chain model at that moment, so the controller waits for the running attempts
     and settles them before reading the evidence. A run in which another task is being served is
     never reported as a total outage. No decision is taken once the owner has asked to stop: a stop
     settles every attempt, and a run that was stopped is not judged for an outage. A controller
     counts as running when some task on the board has a live attempt.
6. The stuck list (§8) shows a deferred task from the moment it is deferred — not only after its
   rounds are spent: with its round count, its next time, and, while one is running, the attempts in
   flight. When no controller is running it shows the task as deferred with its rounds spent,
   waiting for the owner.
- *Call.* `modelCooldownMs` defaults to 60 000 ms (60 seconds; the value it replaces is 900 000 ms)
  and `modelRounds` to 4 (`src/model-wait.ts`). With four models and a 60 000 ms window, the fourth
  round starts 180 000 ms after the first refusal, before that round's own runtime. *(The count as
  built is per run, so a restart starts again at round 0; it is to be anchored to the persisted
  first-refusal time instead — §18, P3.)*
- The board-wide cooldown table keeps its role within a window: a model that refused is skipped by
  every task until its entry expires or a success clears it. It no longer causes `blocked`, and it is
  never read as evidence (§4.2).
- *Call.* `blockForQuota`, the path that blocked a task at once when the chain could not move on, is
  replaced by the round logic above: a quota refusal is a refusal. The quota-specific machinery that
  survives — the hint list, the classifier, the backoff schedule and `quotaPause` — is unreachable
  at the default `chainCycles: 0` and is to be removed (§18, P7).
- **The budget guard's refusal is kept apart.** The learning loop added a second thing called a
  refusal: the outcome `refused`, for a task the budget guard judged before any session (ADR-0012).
  It is not a provider refusal. It starts no round, writes no deferral, and is evidence neither for
  an outage nor against one. Nothing in the guard's handling is replaced:
  - `run` offers such a task once, leaves it out of the rest of the run, prints the guard's line and
    exits 1 (`runScheduler` in `src/scheduler.ts`; `runCommand` in `src/cli.ts`);
  - `watch` keeps it out of its candidates for `REFUSED_RETRY_MS` (300 000 ms, five minutes;
    `src/watch.ts`) and judges it again at the first wake after that;
  - a batch stops at it (`runBatch` in `src/batch.ts`), and `taskctl models` shows the verdicts
    before anything runs.
  *Call.* One thing is added to the guard's refusal path. The controller records the refusal once
  for the board, outside the task's directory, so the guarantee that nothing is written there holds.
  The record is `.taskctl/guard-refusals.json` (beside the tasks directory) and holds the task, the
  time and the guard's line. The stuck list reads that record (§8). The entry is removed when the
  task is next offered and not refused, or when it leaves `open`. *(The watch queue keeps the same
  fact a second time in its own memory; the record is to become the one store — §18, P8.)*
- The deferral replaces the other path: the functions that `block` a task because its models refused
  or are cooling (`blockForQuota`, `blockForCooldown`) and the schedulers' treatment of the task they
  blocked. In each scheduler a deferral is a second exclusion, beside the guard's: neither counts as
  progress, and the scheduler leaves each out until its time has come. The two waits are not the
  same. A deferral makes `run` wait and pass again, because a provider's refusal passes. A guard
  refusal never makes `run` wait or offer the task again: waiting changes nothing, since a catalogue
  that was read is kept for the life of the process (ADR-0012). *(A pass whose every dispatch was a
  deferral still counts toward the pass budget as built; it should not — §18, P9.)*
- *Call.* A manual `taskctl retry` of a deferred task keeps the earliest time already recorded — a
  retry does not justify asking a model that refused a moment ago again — and starts its rounds
  again: the count and the time of the first refusal are cleared, so the retry buys a fresh
  `modelRounds`.
- *Call.* `run --batch` does not wait for a window. A task that is deferred in a batch stops the
  batch: the command prints the next time the task may run and exits 0, since nothing is `blocked`.
  An outage stops the batch with the report of §7 and exit 3. *(Exit 0 meaning both "finished" and
  "deferred" is a defect: a distinct code is an open decision — §18, P10.)*

## 7. Stopping for an outage

The report, printed by `run` and `watch` before they exit:

- each model of the chain and the provider's reason for refusing it, one line each;
- how many rounds were tried, and the elapsed time in seconds;
- the tasks that are waiting and still runnable. A deferral's remaining window is honoured when the
  run starts again: editing the chain does not clear it, so the first pass can wait up to one window
  per task (§18, P11);
- the decision the owner has to make: to use another model, put it into `modelChain` in
  `taskctl.json`, allow it — `allowedModels` when the backend's catalogue does not report it as free
  (ADR-0012) — check it with `taskctl models`, and run again. Models outside the coding plan may be
  billed per token. For a review-stage outage the same instruction names the reviewer's keys: the
  effective reviewer chain, `reviewerModel` and `reviewerModelFallbacks` when they are configured,
  and `modelChain` and `modelFallbacks` when review inherits the worker chain.

*Call.* `run` and `watch` exit with code 3 for this stop. The other codes stay as they are: `0` when
the run finished, including when tasks ended `blocked` or `awaiting-human`. `1` for a runtime error,
for a task blocked by a controller error, and for tasks the budget guard refused (ADR-0012). `2` for
a usage error. Nothing is `blocked` by an outage, so after the configuration is changed a plain
`taskctl run`, or `taskctl watch`, resumes every waiting task without a `retry` per task. A task the
budget guard refused is not part of this report: it keeps the guard's own line. *Call.* A run that
stopped for an outage exits 3, whatever else happened in it, including a task the budget guard
refused or a task `blocked` by a controller error. The exit code names why the run stopped; the
guard's lines and the controller errors are printed beside the report. When several of these events
fall in one run, §9 fixes the precedence.

## 8. The stuck list

*Call.* `taskctl status --stuck` prints only the tasks that are `blocked` or waiting, one line per
task:

| Group | Line says |
| --- | --- |
| `blocked` | the reason (from its note or its last block event), since when, and for a model refusal every model and what it said |
| waiting on a dependency that will not finish on its own | which task it waits for, and the reason that task is held |
| deferred for a model window | round `n` of `modelRounds`, and the next time in the `modelCooldownMs` window |
| refused by the budget guard | the guard's line and the time of that judgement; `taskctl models` shows the current verdict |
| needs a person | `awaiting-human`, a `draft` awaiting signature, open questions |

The statuses named here are the task file's own (`status`): `open`, `draft`, `running`, `review`,
`blocked`, `awaiting-human`, `done`. A deferral is not among them — the task stays `open` and carries
`tasks/<id>/model-wait.json` (§6).

*Call.* A task the budget guard refused is read from the board's record of that refusal (§6) instead
of asking the guard, so the command still reads files only and answers at once.

`taskctl status` and `taskctl board` keep their output. When the owner asks which tasks are stuck, the
answer is the output of `taskctl status --stuck`.

## 9. Stop

- **What it stops.** `taskctl stop` takes no task argument: the request is for the board. `taskctl
  stop` keeps its meaning — no new claim, the current attempt settles, and the owner restarts the
  queue with `watch --resume`. With `parallel` above one, `stop --now` cancels every attempt in
  flight, not only the task whose model the owner distrusts; a worker turn can run to a 30-minute
  budget. *(A task-scoped `stop --now --task <id>` is the scope the motivation in §1 implies and is
  not built — §18, P12.)*
- *New.* `taskctl stop --now` also interrupts: the turn's process tree is cancelled. A cancellation
  the backend confirms ends the attempt as stopped by the owner: the task returns to `open`, no
  retry is spent, the journal records the stop, and `run` or `watch` exits. If the kill cannot be
  confirmed within the cancel budget of 9 500 ms (`CANCEL_BUDGET_MS`, `src/execution.ts`), the attempt
  is recorded `uncertain` and needs reconciliation, as before this design. The tool never presents it
  as clean.
  - **The invariant, and the 2026-11-27 amendment as an instance of it.** Every operation that can
    outlive a stop request is either bounded — the stop is observed when it ends — or cancellable
    with a kill the backend confirms. Nothing interrupted is judged. A step whose result was already
    recorded keeps that outcome: the stop can land while that result is written, so the attempt may
    spend a retry or a review round, and an attempt whose render acceptance had just passed
    completes as `done`. *(Not fully built: the render check and the acceptance gate are outside the
    contract today — §18, P14.)*
- *New.* `SIGINT` on `run` and `watch` does what `stop --now` does. On Windows the controller also
  subscribes `SIGBREAK` (Ctrl-Break); `SIGTERM` is subscribed too, but a Windows `SIGTERM` handler
  does not fire, so it is a no-op there. *(SIGBREAK is not subscribed yet — §18, P13.)* Closing the
  terminal window and `taskkill` deliver no signal at all: the attempt record stays `active`, the task
  stays `running` until the lock TTL (10 minutes, `src/claim.ts`) and the next takeover blocks it
  as "interrupted execution requires operator reconciliation". That path is not a stop, and §13
  does not test it.
- A batch turn (several tasks in one session) is interrupted the same way.
- *Call.* Two short waits are not interrupted: the budget guard's read of the model catalogue and the
  memory recall. Neither is work on a task. The catalogue read is bounded at 30 000 ms
  (`CATALOGUE_TIMEOUT_MS`, `src/budget.ts`) and the memory recall at 20 000 ms (the memory
  configuration's `timeoutMs`, `src/memory.ts`). A stop that lands in either wait is observed the
  moment that wait ends. A task the guard refused is not an interrupted attempt: no session had
  started.
- What the interrupted task had already written stays in the workspace; nothing is rolled back. The
  owner has accepted running it again.
- *Owner's decision (§10, decision 10).* The acceptance command is interrupted as well. A stop that
  waited for a gate would not be a stop. The gate runs through the same process-tree execution as a
  turn (`src/acceptance.ts`), and its cancellation is confirmed by the tree, not by its output pipes:
  the descendants are listed before the kill, the tree is killed, and every listed pid must be gone
  (`src/execution.ts`). A grandchild that holds the pipes open is what the listing is for; the pipes
  are never evidence on their own. This was fixed on 2026-11-25 (`d8679d9`) and completed on a busy
  machine on 2026-11-27 (`e637b29`), and the live check interrupted a real gate with it. A gate that
  was cut is not judged: the task returns to `open` and the gate runs again with the task. The render
  check is not a cancellable execution: a stop ends the wait, not the check (`src/worker.ts`).
- The worker gets no stop input of its own.
- *Call.* When several of the events of §6, §7 and this section fall in one run, the most serious
  decides the exit code: an unconfirmed stop (1: an execution is `uncertain` and needs reconciliation),
  then an outage stop (3), then a controller error or a guard refusal (1), then exit code 130
  (`SIGINT`) or 143 (`SIGTERM`) for a stop by a signal, then 0.

## 10. The owner's decisions

Each decision, and the section that implements it:

1. Models: the coding plan's, in an order the owner gives. The four the plan offers today are
   `glm-5.4`, `glm-5.3`, `glm-5.3-highspeed` and `glm-5.3-flash` (§5).
2. Three or four tries that do not work: block that task, put it on hold, and go on with the others
   (§6, step 5, first branch; `modelRounds`).
3. A task that is stuck holds everything that depends on it; tasks without that dependency are
   handled (§6, step 5; §7).
4. When the model is unavailable every task is unavailable: stop all of them and hand the choice of
   model to the owner (§6, step 5, third branch; §7).
5. Paid fallback models only as a last resort, and only after the owner has been told about the
   billing risk and has decided (§5).
6. Every task can be stopped by the owner; an interrupted task is run again (§9).
7. The tool keeps a status of which tasks are stuck and why (§8).
8. Escalation feedback reaches the worker as a document it is told to read (§11).
9. The three lanes `quick`, `simple` and `complex` are enough. For now the owner decides the lane of
   each task, and the tool asks the owner for it; later a cheap model judges from accumulated
   per-lane descriptions (§12).
10. `stop --now` interrupts the acceptance command as well, on the author's recommendation (§9).

## 11. Escalation feedback

- *Call.* The controller writes `tasks/<id>/rework.md` before each rework turn. It says what was
  rejected and what has to change, from what the controller already holds: the acceptance output
  (truncated to 4 000 characters; `REWORK_OUTPUT_CHARS` in `src/rework.ts`), the failed criteria with
  the reviewer's evidence and defects, a render failure, a turn that ended without a completion
  request, or the worker's own `ESCALATE:` reason. An attempt that settles before that turn writes the
  document when it settles. A `blocked` attempt leaves it on disk for a `taskctl retry`, refreshed with
  the verdict that blocked it (a stalled review, a render or acceptance check that spent the last
  retry). A stop writes the verdict it judged before the stop, and writes nothing for the step it
  interrupted. The controller never rewrites a document inherited from an earlier attempt
  (`carried`); the file keeps the time of that earlier attempt. A lifecycle verdict — rounds
  exhausted, a model outage — is not work feedback and is never written here: it belongs to the block
  note and to the stuck list.
- The worker prompt gains one line, not the content. *Call.* As the first bullet under
  `## 工作规则`, in the prompt's own language (Chinese): "- 上一回合没有通过。开始之前先读 `<path>`：里面写了原因，以及必须改什么。"
  That is "The previous turn did not pass. Before you start, read `<path>`: it says why, and what has
  to change." The line is one more optional input of `buildWorkerPrompt` (`src/protocol.ts`), beside
  the five optional inputs the learning loop added (ADR-0011, ADR-0013). `<path>` is the absolute path
  of the file, given for that turn only. On a turn that is not a rework turn the line is absent and
  nothing is left, not even a blank line, so the prompt is byte-identical to the one without it. It
  adds no `--tasks-dir` option and no template placeholder, which `tests/protocol.test.ts` and
  `tests/protocol-context.test.ts` pin. It sits in the head of the prompt, together with the task, the
  spec and the work rules — the part the 28,000-character clip keeps (ADR-0011). The sections the
  learning loop added do not move, and no word of their fixed copy changes. The owner signs this
  wording before the change is merged.
- The file lives in the task directory, so the tool points a new session — after a model switch or a
  context wrap — at the same file. The review's rework note keeps its place on the board, and so does
  the corrections section the learning loop added (`## 同类任务上人工给过的纠正`, ADR-0011): that one
  carries what a person corrected on other tasks; this file carries why this task's last turn was
  sent back. The worker is not handed the same verdict twice: the reasons reach it through the
  document, and the note keeps its status line for the board. *(As built, the note still carries the
  full verdict beside the document — §18, P15.)*
- *Call.* Adding the line is a change to a spec-fixed prompt. As ADR-0011 and ADR-0013 handle theirs,
  the task that changes `src/protocol.ts` is `risk: high` and needs the owner's signature before it
  is merged. The wording above is what the owner signs.

## 12. The lane is declared

- `taskctl add` requires the lane: `--quick`, `--simple` or `--complex`. *Call.* `taskctl add` asks
  once when stdin is a terminal; otherwise it exits with a usage error that names the three lanes.
- **A lane given without a terminal may only be `complex`**, the lane that waits for the owner's
  signature. `--quick` and `--simple` from a non-interactive caller are refused unless the owner
  passes an explicit opt-in. The reason is the anti-goal in §2: an agent that adds tasks on the
  owner's behalf would otherwise put unsigned work on the board with one flag. *(Not built: any lane
  flag is accepted from any caller today — §18, P16.)*
- The clarify session no longer classifies. The "管理分类" section drops its template;
  `parseIntakeAssessment` keeps the information-sufficiency verdict and the questions.
  `classification.json` records the lane with its source: `terminal` when the owner answered the
  question, `flag` when a flag was given, `script` when neither. *(As built the field is always
  `"operator"` — §18, P16.)*
- `detectComplexity`, which reads the wording of an intent for "简单任务", is removed: no wording of
  an intent decides whether a task runs without a signature.
- *Call.* A short ADR-0010 records this: the lane is declared by the operator, as ADR-0009 says, and
  classification by a model is deferred until recorded per-lane examples exist (§10, decision 9).
- Recording examples: every `taskctl add` appends one line to `.taskctl/lanes.jsonl` — id, time,
  lane, type, title, the intent (truncated to 500 characters; `LANE_INTENT_LIMIT` in
  `src/lanes.ts`), the number of criteria. This is the material the later classifier and the
  per-lane description lists are built from. *(The lane examples are the only store: `taskctl lanes`
  serves the deferred classifier and is to be removed — §18, P17.)*
- **A split child inherits its parent's declared lane.** The planner's `execution` choice stays an
  execution choice and does not set the lane; the owner may redeclare lanes at bundle approval.
  *(Not built: `childTaskFromPlan` derives the lane from the planner's `execution`, and the split
  path records no example — §18, P18.)*
- Process rule: an agent that adds tasks on the owner's behalf must ask the owner for the lane before
  it adds the task.

## 13. Verification

Each part of §14 begins with a failing regression test, and each part adds directed mutations, one
reversed guard at a time, each killed by the test written for it.

Behaviour regressions, one per part of §14:

- part 1: a refusal rotates the chain and spends no retry; a fully refused round defers the task and
  leaves it `open`; a second controller's empty evidence cannot declare an outage; the stuck list
  shows a deferral from its first round.
- part 2: a confirmed cancel settles the attempt as stopped and leaves the task runnable; an
  unconfirmed one is `uncertain`; every operation outside the stop contract is bounded.
- part 3: a rework turn is pointed at `rework.md` and the document carries the verdict; a carried
  document keeps its time; a lifecycle verdict writes no document.
- part 4: a lane without a terminal cannot be `quick` or `simple`; the recorded source is true; a
  split child inherits the parent's lane.

Gates and live checks:

- Offline gates: `npm test`, `npm run typecheck` (type-checks `tsconfig.test.json`), `npx tsc
  --noEmit` (type-checks `tsconfig.json`), `git diff --check`, and `scripts/smoke.ps1`,
  `scripts/live-stop.ps1` and `scripts/live-phase2.ps1` in their offline modes.
- Live, each under the owner's authorization: a real cancellation through `stop --now` and through
  Ctrl-C; a real worker reading `rework.md`; a real refusal, which no test has ever produced on the
  real backend — an invalid model costs no quota. Since the budget guard was added, an invalid model
  has an unknown cost: the guard refuses the task before any session starts, and the provider is
  never asked. For this check the owner names the invalid model in `allowedModels`, or its provider
  in `allowedProviders`, and `taskctl models` shows the model allowed before the live check runs
  (ADR-0012).

## 14. Order of work

1. Refusals, rounds, deferral, outage stop (§5–§7), the stuck list (§8), and the review stage's share
   of the same machinery (§16, first decision).
   1b. The guard's judgement of the `taskctl add` clarify session and the `taskctl split` planner
   (§16, second decision).
2. Stop (§9), including making the cancellation of the acceptance gate — and of the render check,
   which is not cancellable today — confirmable.
3. Escalation feedback (§11).
4. The lane (§12).

Parts 2 to 4 do not depend on part 1 or on each other; their order is the builder's. Part 1 is built
first, because it carries the pain that motivated the work.

## 15. Left to the builder

- The exact path of the rework document under `tasks/<id>/`, outside the definition digest and
  outside the acceptance drift digest; §11 delegates it. The same holds for the deferral record
  `tasks/<id>/model-wait.json`, which §6 already places there.
- The wording of the line `run --batch` prints when a deferral stops it; what it says is fixed in §6,
  and the exit codes in §7.
- Where the run keeps its record of accepted turns (§6, step 5), across a batch session in which
  several tasks share one session. The rule the record serves is fixed; only its storage is the
  builder's. *Call.* As built the record is in memory for the life of the run, and a run keeps none
  from an earlier process; §6 has to say so.
- Wording of the outage report (§7) and of every message this design names without wording (the
  deferral line of `run --batch`, the stop line, the usage error of `taskctl add`). Any string the
  design quotes — `review could not decide` (§16) — is content and is not reworded.
- §8's row 2 fixes what each line says about the task it waits for. Two things are the builder's:
  whether the line names only the immediate blocker or the chain up to its root, and how the walk
  stops on a cycle.

## 16. Added after the builder's check

A reviewer with no part in the conversation read this document as the person who has to plan from
it. Two questions were the author's to settle; the owner decided a third (§10, decision 10). They
are answered where they belong: the review stage's machinery in this section, the guard's coverage
in §5, and the stop in §9. What follows is the review stage's share of §14 part 1.

**The review stage.** A reviewer refusal takes the same path as a worker refusal. The chain is
walked. A fully refused round defers the task, and no turn is run again: the worker's work and the
acceptance evidence are preserved, as the park preserves them. A **park** is a task `blocked` with
`tasks/<id>/review-pending.json`, the record that lets a review resume without the worker.

Every review deferral writes `tasks/<id>/review-pending.json` at once, while the task stays `open`:
the record keeps the definition digest, the artifact digest and the original attempt window that the
review-only path requires. A later review deferral refreshes its refusal metadata and does not replace
that window.

When the window reopens, the controller resumes the review on the preserved evidence by itself,
through the review-only path and its digest gate. A `retry --review-only` asked for while the
deferral's time is still in the future does not run; the command prints that time and exits 1. It is
never a silent `skipped`.

The rounds of the review stage are counted anew, so a task can spend its `modelRounds` as a worker and
again as a reviewer; the review stage's count lives in `tasks/<id>/model-wait.json` beside the
worker's.

After `modelRounds` the evidence rule of §6, step 5 decides. If a turn was accepted on the reviewer
chain, the task is parked for the owner. Otherwise the run stops for an outage, and the task keeps its
preserved evidence for the rerun. An accepted reviewer turn is evidence that the model works only when
that turn produced its own session (`src/worker.ts`).

The provider's reason for refusing a reviewer model is kept for the report of §7: the review result
carries the backend's text of a provider refusal (`ReviewResult.refusalText`, `src/review.ts`), as it
carries the reviewer session id.

A reviewer that timed out is not a refusal and keeps the park. The attempt settles. The journal
records `review-timed-out`. The task is `blocked` with `review-pending.json`, and
`retry --review-only` runs the review again.

A reviewer that crashed is not a refusal either, and keeps the handling it had before this design,
which is not the park. The reviewer's verdict is `unclear`. The controller removes any earlier
`review-pending.json`. The task becomes `awaiting-human` ("review could not decide").

A timed-out reviewer whose shutdown cannot be confirmed is `uncertain`, as any turn is (§9). This
supersedes the part of §9 of `2026-11-24-adaptive-execution-design.md` that leaves a refused review to
a person's `retry --review-only`. The park of a review that timed out is not touched.

**Every model the tool can dispatch.** The budget guard covers both chains and also `model` where it
is used directly. The clarify session of `taskctl add` and the planner of `taskctl split` are judged
on the one model their session runs on before it starts: `add` before it writes the task file, `split`
before it calls the planner. `add --quick` calls no model and is not judged (ADR-0012,
`sessionRefusals` in `src/cli.ts`). *Call.* When `model` is unset, those two use the head of
`modelChain`. When `model` and `modelChain` are both unset, they keep the backend's default model;
`modelFallbacks` never supplies their model. The guard judges that backend default before dispatch.

**`stop --now` also interrupts the acceptance command** — the owner's decision (§9; §10, decision
10). The controller's own bound on a gate is `acceptanceTimeoutMs`, 600 000 ms by default
(`src/worker.ts`), so a stop will land inside one. The gate's cancellation is confirmed by the process
tree: the descendants are listed before the kill, and every listed pid must be gone (`src/execution.ts`).
Output-pipe closure is never evidence on its own. The render check is not a cancellable execution: a
stop ends the wait, not the check (`src/worker.ts`).

## 17. Revision notes (2026-11-25)

The learning loop was merged after this design was approved (preamble). Its budget guard (ADR-0012)
already does, by refusing, what §5 set out to do by a notice, and it added a second kind of refusal,
which this design keeps apart from a provider's (§6). The design was revised on the same day so that it
builds on that code. The revision is the author's. The owner chose not to read it himself and asked
for a review in the owner's place (2026-11-25), which found nothing to overrule; the record is the
section "九个判断的评审" of `docs/superpowers/plans/2026-11-24-handoff.md` §0. §10 is not changed.

What the merged code and its ADRs required:

- §5: the `modelPlan` key and its notice are dropped. The budget guard refuses a model that costs
  money per token, or whose cost the backend does not report, unless the owner has allowed it in
  `taskctl.json`, before any session starts; its verdict line tells the owner.
- §6: a refusal by the budget guard is not a refusal in the sense of this design. It starts no round
  and is no evidence. The deferral replaces the paths that `block` a task because its models refused
  or are cooling; nothing in the guard's handling is replaced.
- §4, §6: the evidence for "every model refused" is what the run itself saw (§6, step 5); the shared
  cooldown table is never read as evidence.
- §16: only a reviewer that timed out keeps the park. One that crashed goes to `awaiting-human`, as
  before.
- §7: the guard's allow-list is part of what the owner decides after an outage.
- §13: a live refusal check passes the guard first.
- §16: the clarify and planner sessions are judged by the guard, not by a notice.
- §11: the prompt line is placed where the prompt is built now. Changing the prompt is `risk: high`
  and needs the owner's signature before the change is merged — the rule ADR-0011 and ADR-0013 apply
  to their prompt changes.

What the author decided while revising. Each is a *call*:

1. (§6) Every round starts again at the head of the chain, so that each round tries the whole chain.
2. (§4, §6, §16) The evidence counts a turn that was accepted after the task's first refusal, and not
   one accepted earlier in the run: an acceptance an hour old must not hide an outage that began
   since.
3. (§7) A run that stops for an outage exits 3 — unless an interrupted attempt could not be
   confirmed, which is 1 and outranks the outage (§9).
4. (§8) A task the guard refused is in the stuck list, read from a record rather than by asking the
   guard.
5. (§11) The prompt line is Chinese, like every fixed line of the prompt.
6. (§6) A pass in which no model refused the task, because every model was already cooling, is not a
   round.
7. (§11) §11 closes the item the learning-loop design put off, and that design says so.
8. (§6) A manual `retry` of a deferred task keeps its earliest time and starts its rounds again.
9. (§16) The review stage counts its rounds anew.
10. (§6) `run --batch` does not wait for a window.
11. (§16) A `retry --review-only` that a deferral holds prints the time.
12. (§9) A stop does not interrupt the budget guard's read of the catalogue or the memory recall.
13. (§6) A run that was stopped is not judged for an outage.
14. (§9) Among exit codes the most serious wins.

## 18. The review of 2026-11-28, and what is still to build

The owner asked an EGM panel (eight reviewer lenses, three models) to review this document against the
tree at `82d50f7`, and to fix every finding. The panel's reports are in
`.superpowers/egm-2026-11-28/` (not committed: the directory is ignored). The document was re-baselined
and corrected; the findings that are code work are listed here, each with the paragraph that now
records the rule. None of them is a reason to distrust the rest of this text: the design's elements
hold, and what the review removed was claims it could not carry.

| # | What is still to build | Where the rule is written |
|---|---|---|
| P2 | `run` does not start beside a live `watch` lock, so no second process declares an outage from its own empty evidence. | §4.2 |
| P3 | The round count is anchored to the persisted first-refusal time instead of the run id, so a restart does not reset "three or four tries" to round 0. | §6, step 5, and `modelRounds` |
| P4 | An acceptance on another chain proves only that the backend is alive; the task stays deferred with its rounds spent instead of being blocked as its own problem. | §4.2, §6, step 5 |
| P5 | An ordered effective dispatch chain: owner authorization stays valid without a fresh catalogue; an unauthorized tail does not refuse a safe head. | §5 |
| P6 | Remove the per-task rotation position in `tasks/<id>/models.json`; every round already starts at the head. | §6.1 |
| P7 | Remove the unreachable quota branch: the hint list, the classifier, `quotaBackoffMs` and `quotaPause`. | §6 |
| P8 | The guard-refusal fact has one store: `.taskctl/guard-refusals.json`, not that record and the watch queue's memory. | §6 |
| P9 | A pass whose every dispatch was a deferral does not count toward the scheduler's pass budget. | §6 |
| P10 | A deferred `run --batch` does not exit 0 as if it had finished; the distinct code is an open decision. | §6 |
| P11 | Editing the chain clears the deferral windows of the tasks whose chain changed. | §7 |
| P12 | `stop --now --task <id>`: the motivation is per-task, the control is board-wide. | §9 |
| P13 | Subscribe `SIGBREAK` on win32; state that window close and `taskkill` fall to the lock-TTL reconcile path. | §9 |
| P14 | Bring the render check inside the stop contract (the two bounded waits already are). | §9 |
| P15 | One channel to the worker: the rework note keeps its status line and stops carrying the verdict beside `rework.md`. | §11 |
| P16 | A lane flag without a terminal may only be `complex`; `classification.json` records `terminal`, `flag` or `script`. | §12 |
| P17 | Remove `taskctl lanes` until the deferred classifier exists. | §12 |
| P18 | A split child inherits its parent's declared lane, and the split path records an example. | §12 |

Two corrections this review settled by reading the tree, rather than by deciding anything:

- §9's and §16's acceptance-gate paragraphs said the gate's cancellation was confirmed by its output
  pipes and that making it confirmable was still to be built. The tree had already moved (`d8679d9`,
  `e637b29`): the gate is confirmed by the process tree, and the live check interrupted a real one.
  Both paragraphs now say so. The panel repeated the document's own stale claim back at it — which is
  the defect this section exists to stop: the text, not the reviewers, was wrong.
- The acceptance gate's duration has a bound: `acceptanceTimeoutMs`, 600 000 ms by default
  (`src/worker.ts`); §16 now names it, where the earlier text said "tens of minutes". §17's
  "exits 3 whatever else happened" contradicted §9's precedence; it now yields to an unconfirmed
  interruption, which is 1.
