# Model trouble and operator control — design

Status: approved by the owner on 2026-11-25. Nothing in it is built yet. Revised the same day, after
the learning loop was merged (ADR-0011, ADR-0012, ADR-0013), so that it builds on the budget guard
instead of beside it. The revision is the author's and waits for the owner's confirmation; §17 lists
what it changed. §10 is not edited by it.

Where it changes [the adaptive execution design](2026-11-24-adaptive-execution-design.md), it
supersedes that document: §14.1 (shared provider cooldown), §16.1 (the lane is chosen by the model
at intake), the refused-review half of its §9 (§16 below), and the sentence of its §17.3 that says a
stop is never a process-tree kill (§9 below). Section 10 lists the owner's decisions; everything
marked *call* is the author's and can be overruled.

## 1. Intent

In a real run on 2026-11-24 one provider refusal turned a task `blocked` and parked the board for
fifteen minutes, and only a manual `retry` brought anything back. The owner's requirements, in his
terms:

- a refusal is answered by switching models, not by blocking;
- the window is far shorter than fifteen minutes, and nothing waits for a person to press `retry`;
- when a model stays unavailable, try three or four times, then block **that task** and move on to
  the others; what depends on it does not run, and what has no dependency on it is handled;
- usually the model being unavailable means no task can run. Then stop everything and hand the
  choice of model to the owner;
- the models to use are the ones in the owner's coding plan. Anything else (paid models such as
  DeepSeek or OpenCode) is a last resort and is used only after the owner has been told that it may
  be billed and has decided;
- he must be able to stop running work himself at any time, including a model that was switched in
  and turns out to be unsuitable; an interrupted task is simply run again;
- a status must be kept, so that he can ask at any time which tasks are stuck and why;
- the worker must learn why its work was rejected — by being pointed at a document, not by a longer
  prompt;
- the lane of a task (quick, simple, complex) is decided by the owner for now, and the tool has to
  ask him.

## 2. Goals, non-goals, anti-goals

Goals:

- G1. A provider refusal never by itself costs a task a retry or the status `blocked`.
- G2. The models of the plan are tried in order, without a person.
- G3. When they all refuse, the system stops cleanly, says why, and leaves the choice to the owner.
- G4. Trouble is contained. A task that keeps being refused while another task succeeds is held
  alone; tasks that depend on it wait; independent tasks continue.
- G5. The system never selects a model that is not in the configured chain.
- G6. One command answers "which tasks are stuck, and why".
- G7. The operator can stop running work at once, and what was interrupted can be run again.
- G8. Every rework turn is told where to read why the previous one was rejected.
- G9. The lane of a new task is declared by the owner, and every declared lane is recorded as an
  example.

Non-goals:

- No model outside the configured chain is ever chosen automatically, and no new approval flow is
  built for paid models: the owner's decision is the configuration he edits.
- No prediction of when a provider's quota resets.
- No change to how a turn that ran and failed for a reason other than a provider failure spends
  retries.
- No automatic re-run of a task that is `blocked` for its own reasons: a failed acceptance, exhausted
  retries, or a human's `reject`.
- No new lane, and no new task status: "on hold" is `blocked` with a reason.
- No classifier by model in this round. A cheap model proposing the lane from the recorded examples
  is a later step (§12).

Anti-goals — these would make it a failure even if everything above worked:

- a wait nobody can see: a run that sits for minutes with no visible reason;
- a stop that records an execution as `uncertain` although the kill was confirmed, or that leaves a
  task that cannot be run again;
- a task held as "its own problem" when the model was down, or a run stopped for an outage when the
  model was serving other tasks;
- a task that runs without the owner's signature because of how its intent was worded.

## 3. Constraints

- Markdown task files are the source of truth (ADR-0001); a reviewer is always a fresh session;
  no new runtime dependency; the CLI stays hand-rolled.
- Every runtime change follows the repository's protocol: a regression that fails first, the fix,
  directed mutations that the tests kill, documentation kept in step.
- A run against the real backend needs the owner's explicit authorization.
- The adapter's assumptions were verified against opencode 2.4.1. Another machine may run a newer
  version; before any live run there, `opencode run --format json` events, `session.get`,
  `session.message.list` and `model.list` are checked again.
- Today's behaviour, which this replaces: any provider refusal writes a board-wide entry for
  `modelCooldownMs` (15 minutes); a task whose models are all cooling is `blocked` before it is
  dispatched; `stop` lets the current attempt finish; `SIGINT` and `SIGTERM` are not handled.

## 4. Approaches considered

**No model available.**

- *A. Defer the task and probe again automatically* — chosen by the owner. The task stays `open`
  with an earliest time at which it may be claimed again.
- *B. Sleep inside the running attempt* (what `quotaPause` does for a same-model re-probe). The
  smallest change, but the sleeping attempt holds the task lock, the workspace reservation and a
  parallel slot the whole time: one waiting task shuts every other task of that workspace out, a
  model down for an hour hangs the run for an hour, and no status changes while it waits.
- *C. Configuration only*: a chain, `chainCycles` and a short `modelCooldownMs`. It gives switching
  today, but a task whose models are cooling is still `blocked` at the start of an attempt, and
  nothing probes again across attempts.

**One task's trouble or an outage.** The two look the same from one task. Three ways to tell:

- by the provider's error text — refused: the same string serves both cases;
- by asking a model with a probe request — refused: it spends quota and proves little;
- by evidence the run already has — chosen: did any task get a turn accepted on any chain model
  after this task's first refusal? If so the model works and the refusal is this task's problem.
  The evidence is what the run itself saw, kept for the life of the run (§6, step 5). It is not
  read from the board's shared cooldown table, which holds one entry per model — the latest
  refusal — so a refusal by any task replaces the entry that a success had cleared.

**Stop.**

- *Graceful only* (today): the current attempt settles first. Too slow for "this model is wrong".
- *Immediate with a confirmed kill* — chosen: the turn's process tree is cancelled, the attempt ends
  as stopped by the operator, the task returns to `open`.
- *Kill without confirmation* — refused: it leaves `uncertain` executions behind.

**Escalation feedback.**

- *In the prompt* — the controller's failure text grows the prompt on every turn.
- *A document the worker is pointed at* — chosen by the owner.
- *Nothing* — today.

**The lane.**

- *The model classifies at intake* (today's §16.1) — reverses ADR-0009, which says no classifier
  decides a lane, and a wrong downgrade is silent.
- *The owner declares it; the tool asks when it is not given* — chosen for now.
- *A cheap model proposes, from recorded examples* — later.

## 5. The model chain

- The chain is `modelChain` (then `modelFallbacks`), as today. The owner lists the models of his
  plan in his preferred order; the README shows the recommended configuration. Nothing is hard-coded
  for a provider.
- *Call.* When neither `reviewerModel` nor `reviewerModelFallbacks` is configured, the reviewer chain
  is the worker chain. Today the reviewer then uses the backend's default model, which is not one
  the owner chose. Review independence is a fresh session, not a different model.
- No plan notice and no `modelPlan` key. That part is the budget guard's (ADR-0012, `src/budget.ts`).
  Before anything is claimed, `run`, `watch` and `retry --review-only` judge every model the attempt
  may run on: the worker's chain of that task, the reviewer's chain, and, for a role whose chain is
  empty, the backend's default model, which is what that role then runs on. A model that costs money
  per token, or whose cost the backend does not report, is refused unless the owner has allowed it
  in `taskctl.json` (`allowedModels`, `allowedProviders`, `allowPaidModels`, `maxCostPerMillion`).
  `taskctl models` prints every verdict before anything runs, and exits 1 when one is refused. A task
  the guard refuses is not a refusal in the sense of §6: no session started and no model was asked.
- The system never adds a model to a chain, and never dispatches on one the guard has not allowed. A
  paid fallback is used when, and only when, the owner has put it into the chain and allowed it in
  the configuration himself, which is his decision (§10, decision 5). The guard is how that decision
  is enforced, and its verdict line is how he is told that a model may be billed per use.

## 6. A refusal

Definitions:

- A **round** is one pass over the chain: each model is tried once, and a refusal moves to the next
  model at once. Every round starts again at the head of the chain, and rounds are one window apart
  (`modelCooldownMs`, 60 seconds by default). Today the model a task was last dispatched on is kept
  for it, in `tasks/<id>/models.json`, so that a rerun does not try a refused head first
  (`resetChainCycles` in `src/models.ts`); under rounds that would leave only the tail of the chain
  to be tried again, so the position is reset at the start of every round. Inside a window the
  shared table keeps a model that has just refused from being tried again.
- A refusal is what the adapter reports as a provider failure (today's `failure === "provider"`),
  whether or not the turn had already done work. *Call.* The adapter cannot tell a refusal before
  any work from a provider error after some work, and a provider error is not the task's fault
  either way: such a turn spends no retry. A turn that ran and failed for any other reason keeps
  today's handling. A model the budget guard refused is not a refusal in this sense: no session
  started and no model was asked (§5).

Behaviour:

1. Inside a round, a refusal switches to the next model. It does not spend a retry.
2. If a model accepts the turn, the task proceeds as today. Success clears that model's cooldown.
3. If every model of the chain refused in the round, the attempt ends. It spends no retry and the
   task is not `blocked`. The task stays `open` and carries a **deferral** — a per-task runtime
   record, `tasks/<id>/model-wait.json`, with the round count, the time of the first refusal, each
   model's refusal, and the earliest time at which the task may be claimed again, `modelCooldownMs`
   from now. A pass in which no model refused this task, because every model was already cooling in
   the shared table, is not a round: the task waits for the earliest expiry and is offered again then.
4. While a deferral's time lies in the future, the claim path refuses the task exactly as it refuses
   one whose dependency is not done. `run` and `watch` wait for the nearest such time when nothing
   else is runnable, then run another pass.
5. After `modelRounds` rounds without any model accepting, the run looks at its evidence:
   - **Another task got a turn accepted on a chain model after this task's first refusal.** The
     model works; the refusal is this task's own problem. The task is `blocked` with a note naming
     every model and what each said. Its dependents wait (today's behaviour) and the others continue.
   - **No task did.** This is an outage. The task is left as it is — `open`, retries untouched — and
     the whole `run` or `watch` stops with the report of §7.
   - **Where the evidence comes from.** From the run, which records every turn a chain model
     accepted while it ran. "Accepted" is what makes today's code clear a model's cooldown: a worker
     turn that exits 0, or a reviewer turn that is not a provider refusal (`clearModelCooldown`, in
     `loop` and in `reviewStage` of `src/worker.ts`). It is not read from the shared cooldown table.
     That table holds one entry per model, the latest refusal, so with two refused tasks and one
     served task it shows only refusals, and a run that read it would stop for a false outage.
   - **When the decision is taken.** Not inside the attempt that ran out of rounds. The controller
     takes it when no attempt is in flight: with `parallel` above one, another task's turn may be
     running on a chain model at that moment, so the attempts still running are waited for and
     settled before the evidence is read. A run in which another task is being served is never
     reported as a total outage. Until then the task is shown in the stuck list (§8) as deferred and
      waiting for the attempts in flight; when no controller is running, as deferred with its rounds
      spent and waiting for the owner.
   A task with a deferral is shown in the stuck list (§8) with its round count and next time.
- *Call.* `modelCooldownMs` defaults to 60 seconds (today 900 000) and `modelRounds` to 4. With
  four models that is four to five minutes before a task is held or a run stops.
- The board-wide cooldown table keeps its role within a window: a model that refused is skipped by
  every task until its entry expires or a success clears it. It no longer causes `blocked`, and it
  is never read as evidence: it holds one entry per model, the latest refusal, and a later refusal
  replaces the entry that a success had cleared (`noteModelRefusal`, `src/model-cooldown.ts`).
- *Call.* `blockForQuota`, the path that blocks a task at once when the chain cannot move on, is
  replaced by the round logic above: a quota refusal is a refusal.
- `chainCycles` keeps its meaning inside a round.
- **The budget guard's refusal is kept apart.** The learning loop added a second thing called a
  refusal: the outcome `refused`, for a task the budget guard judged before any session (ADR-0012).
  It is not a provider refusal. It starts no round, writes no deferral, and is evidence neither for
  an outage nor against one. Nothing of it is replaced:
  - `run` offers such a task once, leaves it out of the rest of the run, prints the guard's line and
    exits 1 (`runScheduler` in `src/scheduler.ts`; `runCommand` in `src/cli.ts`);
  - `watch` keeps it out of its candidates for `REFUSED_RETRY_MS`, five minutes, in the queue's own
    memory, and judges it again at the first wake after that (`scheduleOnce` in `src/watch.ts`);
  - a batch stops at it (`runBatch` in `src/batch.ts`), and `taskctl models` shows the verdicts
    before anything runs.
  *Call.* One thing is added to it. The refusal is recorded once for the board, outside the task's
  directory — so the guarantee that nothing is written there holds — in `.taskctl/guard-refusals.json`:
  the task, the time and the guard's line. The stuck list reads that record (§8). The entry is
  removed when the task is next offered and not refused, or when it leaves `open`.
  What the deferral replaces is the other path: the functions that `block` a task because its models
  refused or are cooling (`blockForQuota`, `blockForCooldown`) and the schedulers' treatment of the
  task they blocked. In each scheduler a deferral is a second exclusion, beside the guard's: neither
  counts as progress, and each is left out until its time has come. The two waits are not the same.
  A deferral makes `run` wait and pass again, because a provider's refusal passes. A guard refusal
  never makes `run` wait or offer the task again: waiting changes nothing, since a catalogue that was
  read is kept for the life of the process (ADR-0012).
- *Call.* A manual `taskctl retry` of a deferred task keeps the earliest time already recorded — a retry
  is not a reason to ask again a model that refused a moment ago — and starts its rounds again: the
  count and the time of the first refusal are cleared, so the retry buys a fresh `modelRounds`.
- *Call.* `run --batch` does not wait for a window. A task that is deferred in a batch stops the batch:
  the command prints when the task may run again and exits 0, since nothing is `blocked`. An outage
  stops the batch with the report of §7 and exit 3.

## 7. Stopping for an outage

The report, printed by `run` and `watch` before they exit:

- each model of the chain and the provider's reason for refusing it, one line each;
- how many rounds were tried and over how long;
- the tasks that are waiting, all of them still runnable;
- the decision that is the owner's: to use another model, put it into `modelChain` in `taskctl.json`,
  allow it — `allowedModels` when the backend's catalogue does not report it as free (ADR-0012) —
  check it with `taskctl models`, and run again. Models outside the plan may be billed per use.

*Call.* `run` and `watch` exit with code 3 for this stop. The other codes stay as they are: `0` when
the run finished, also when tasks ended `blocked` or `awaiting-human`; `1` for a runtime error, for a
task blocked by a controller error, and for tasks the budget guard refused (ADR-0012); `2` for a usage
error. Nothing is `blocked` by an outage, so after the configuration is changed a plain `taskctl run`,
or `taskctl watch`, resumes every waiting task without a `retry` per task. A task the budget guard
refused is not part of this report: it keeps the guard's own line. *Call.* A run that stopped for an
outage exits 3 whatever else happened in it — tasks the guard refused, a task `blocked` by a
controller error: the code names why the run stopped, and the guard's lines and the controller errors
are printed beside the report.

## 8. The stuck list

*Call.* `taskctl status --stuck` prints only what is held or waiting, one line per task:

| Group | Line says |
| --- | --- |
| `blocked` | the reason (from its note or its last block event), since when, and for a model refusal every model and what it said |
| waiting on a dependency that will not finish on its own | which task, and why that one is held |
| deferred for a model window | round `n` of `modelRounds`, next time |
| refused by the budget guard | the guard's line and when it was judged — as judged then; `taskctl models` shows the verdict now |
| needs a person | `awaiting-human`, a `draft` awaiting signature, open questions |

*Call.* A task the budget guard refused is read from the board's record of that refusal (§6), not by
asking the guard, so the command still reads files only and answers at once.

`taskctl status` and `taskctl board` keep their output. When the owner asks which tasks are stuck,
the answer is this command's output.

## 9. Stop

- `taskctl stop` keeps today's meaning: no new claim, the current attempt settles, and the queue
  restarts with `watch --resume`.
- *New.* `taskctl stop --now` also interrupts: the turn's process tree is cancelled. A cancellation
  the backend confirms ends the attempt as stopped by the operator: the task returns to `open`, no
  retry is spent, the journal says so, and `run` or `watch` exits. If the kill cannot be confirmed
  within the existing cancel deadline, the attempt is recorded `uncertain` and needs reconciliation,
  as today — it is never presented as clean.
- *New.* `SIGINT` and `SIGTERM` on `run` and `watch` do what `stop --now` does. Ctrl-C is how the
  owner will use it.
- A batch turn (several tasks in one session) is interrupted the same way.
- What the interrupted task had already written stays in the workspace; nothing is rolled back. The
  owner has accepted running it again.
- *Owner's decision.* The acceptance command is interrupted as well: the owner's gates run for tens
  of minutes, and a stop that waits for one is not a stop. Its cancellation must become confirmable
  before this holds — today it is confirmed by the closure of its output pipes, which a grandchild
  process can hold open — and making it so is part of this work. A gate that was cut is not judged:
  the task returns to `open` and the gate runs again with the task.
- The worker gets no stop input of its own.

## 10. The owner's decisions

1. Models: the coding plan's, in an order he gives. The four his plan offers today are `glm-5.4`,
   `glm-5.3`, `glm-5.3-highspeed` and `glm-5.3-flash`.
2. Three or four tries that do not work: block that task, put it on hold, and go on with the others.
3. A task that is stuck holds everything that depends on it; tasks without that dependency are
   handled.
4. When the model is unavailable every task is unavailable: stop all of them and hand the choice of
   model to the owner.
5. Paid fallback models only as a last resort, and only after the owner has been told about the
   billing risk and has decided.
6. Every task can be stopped by the owner; an interrupted task is run again.
7. A status is kept of which tasks are stuck and why.
8. Escalation feedback reaches the worker as a document it is told to read, or as a short message.
9. Quick, simple and complex are enough. For now the owner decides the lane of each task and is asked
   for it; later a cheap model judges from accumulated per-lane descriptions.
10. `stop --now` interrupts the acceptance command as well, on the author's recommendation.

## 11. Escalation feedback

- *Call.* The controller writes `tasks/<id>/rework.md` before each rework turn. It says what was
  rejected and what has to change, from what the controller already holds: the acceptance output
  (bounded), the failed criteria with the reviewer's evidence and defects, a render failure, a turn
  that ended without a completion request, or the worker's own `ESCALATE:` reason.
- The worker prompt gains one line, not the content. *Call.* In the prompt's own language, Chinese,
  as the first bullet under `## 工作规则`: "- 上一回合没有通过。开始之前先读 `<path>`：里面写了原因，以及必须改什么。"
  That is "The previous turn did not pass. Before you start, read `<path>`: it says why, and what has
  to change." The line is one more optional input of `buildWorkerPrompt` (`src/protocol.ts`), beside
  the five the learning loop added (ADR-0011, ADR-0013). `<path>` is the absolute path of the file,
  given for that turn only. On a turn that is not a rework turn the line is absent and nothing is
  left, not even a blank line, so the prompt is byte-identical to the one without it. It adds no
  `--tasks-dir` and no brace, which `tests/protocol.test.ts` and `tests/protocol-context.test.ts`
  pin. It sits in the head of the prompt, with the task, the spec and the work rules, which is the
  part the 28,000-character clip keeps (ADR-0011). The sections the learning loop added do not move,
  and no word of their fixed copy changes. The owner signs the wording with the change (below).
- The file lives in the task directory, so a new session — after a model switch or a context wrap —
  is pointed at it as well. The review rework note that exists today stays, and so does the
  corrections section the learning loop added (`## 同类任务上人工给过的纠正`, ADR-0011): that one
  carries what a person corrected on other tasks; this file carries why this task's last turn was
  sent back.
- *Call.* Adding the line is a change to a spec-fixed prompt. As ADR-0011 and ADR-0013 handle
  theirs, the task that changes `src/protocol.ts` is `risk: high` and needs the owner's signature
  before it is merged. The wording above is what is put to him for it.
- This is the change to the worker prompt that the learning-loop design put its deferred item off
  until (§10 of that design): telling the worker why work was sent back is closed by this section, by
  a document rather than by prompt text, which is decision 8 in §10 here.

## 12. The lane is declared

- `taskctl add` requires the lane: `--quick`, `--simple` or `--complex`. *Call.* With none given, it
  asks once when it is attached to a terminal, and otherwise exits with a usage error that names the
  three.
- The clarify session no longer classifies. The "管理分类" section leaves its template;
  `parseIntakeAssessment` keeps the information-sufficiency verdict and the questions.
  `classification.json` records the lane with `source: "operator"`.
- `detectComplexity`, which reads the wording of an intent for "简单任务", is removed: nothing in the
  wording of an intent decides whether a task runs without a signature.
- *Call.* A short ADR-0010 records this: the lane is declared by the operator, as ADR-0009 says, and
  classification by a model is deferred until it has evidence.
- Recording examples: every `taskctl add` appends one line to `.taskctl/lanes.jsonl` — id, time,
  lane, type, title, the intent (bounded), the number of criteria. *Call.* `taskctl lanes` prints
  them grouped by lane. This is the material the later classifier and the three description lists
  are built from.
- Process rule for an agent that adds tasks on the owner's behalf: ask him for the lane first.

## 13. Verification

- Each part begins with a regression that fails against today's code.
- Directed mutations, one reversed guard at a time, killed by the test written for them.
- Offline gates: `npm test`, `npm run typecheck`, `npx tsc --noEmit`, `git diff --check`, the two
  smoke scripts in offline mode.
- Live, each under the owner's authorization: a real cancellation through `stop --now` and through
  Ctrl-C; a real worker reading `rework.md`; a real refusal, which no test has ever produced on the
  real backend — an invalid model costs no quota. Since the budget guard, an invalid model is of
  unknown cost: the guard refuses the task before any session starts, and the provider is never
  asked. For this check the owner names the invalid model in `allowedModels`, or its provider in
  `allowedProviders`, and `taskctl models` shows it allowed first (ADR-0012).

## 14. Order of work

1. Refusals, rounds, deferral, outage stop (§5–§7) and the stuck list (§8).
2. Stop (§9).
3. Escalation feedback (§11).
4. The lane (§12).

Parts 2 to 4 do not depend on part 1 and may be built in any order after it.

## 15. Left to the builder

- Where `rework.md` lives under `tasks/<id>/`, outside the definition digest and outside the
  acceptance drift digest. The deferral record is `tasks/<id>/model-wait.json`, likewise outside
  both.
- The wording of the line `run --batch` prints when a deferral stops it; what it says is fixed in §6, and the exit codes in §7.
- Where the run keeps its record of accepted turns (§6, step 5), across a batch session, where
  several tasks share one session. The rule the record answers is fixed; its storage is not.
- Wording of the outage report and of the other messages the controller prints.
- How the stuck list walks a chain of dependencies.

## 16. Added after the builder's check

A reviewer with no part in the conversation read this document as the person who has to plan from
it, and asked four questions. Three are settled here by the author; the fourth was the owner's, and
he has decided it.

**The review stage.** A reviewer refusal takes the same path as a worker refusal: the chain is
walked, a fully refused round defers the task, and nothing is replayed — the worker's work and the
acceptance evidence are preserved, as today's park preserves them. When the window reopens, the
controller resumes the review on the preserved evidence by itself, through today's review-only path
and its digest gate; a `retry --review-only` that is asked for while the deferral's time lies in the
future is not run and says so, with that time, never as a silent `skipped`. The rounds of the review
stage are counted anew, so a task can be deferred for `modelRounds` rounds as a worker and again as a
reviewer. After `modelRounds` the same evidence rule decides: if another task got a turn
accepted, the task is parked as today, `blocked` with `review-pending.json`, for the owner;
otherwise it is an outage stop, and the task keeps its preserved evidence for the rerun. An accepted
reviewer turn is evidence that the model works. The provider's reason for refusing a reviewer model
is kept for the report of §7: the review adapter carries the backend's text of a provider refusal in
its result, as it carries the session id. A reviewer that timed out is not a refusal and keeps
today's park: the attempt settles, the journal gets `review-timed-out`, and the task is `blocked`
with `review-pending.json`, for `retry --review-only`. A reviewer that crashed is not a refusal
either, and keeps today's handling, which is not the park: its verdict is `unclear`, any earlier
`review-pending.json` is removed, and the task goes to `awaiting-human` ("review could not decide").
A timed-out reviewer whose shutdown cannot be confirmed is `uncertain`, as any turn is (§9). This
supersedes the part of §9 of the 11-24 design that leaves a refused review to a person's
`retry --review-only`; the park of a review that timed out is not touched.

**Every model the tool can dispatch with.** The budget guard covers both chains and also `model`
where it is used directly: the clarify session of `taskctl add` and the planner of `taskctl split`
are judged on the one model their session runs on before it starts — `add` before it writes the task
file, `split` before it calls the planner. `add --quick` calls no model and is not judged (ADR-0012,
`sessionRefusals` in `src/cli.ts`). *Call.* When `model` is unset, those two use the head of
`modelChain` instead of the backend's default model.

**`stop --now` also interrupts the acceptance command** — the owner's decision, on the author's
recommendation. The owner's acceptance gates run for tens of minutes, so a stop will often land
inside one; a stop that waited for the gate to end would not be a stop. The gate's cancellation has
to become confirmable first. Today it is confirmed by the closure of its output pipes, which a
grandchild process can hold open, so a cut gate would often end `uncertain` and need reconciliation
by hand — the anti-goal. Making it confirmable is part of this work. The render check is not a
cancellable execution today.

## 17. Revision notes (2026-11-25)

The learning loop was merged after this design was approved. Its budget guard (ADR-0012) already
does, by refusing, what §5 set out to do by a notice, and it added a second kind of refusal, which
has to be kept apart from a provider's. The design was revised on the same day so that it builds on
that code. The revision is the author's and waits for the owner's confirmation. §10 is not changed.

What the merged code and its ADRs required:

- §5: the `modelPlan` key and its notice are dropped. The budget guard refuses a model that may be
  billed unless the owner has allowed it, before any session starts, and its verdict line is how he
  is told.
- §6: a refusal by the budget guard is not a refusal in the sense of this design. It starts no round
  and is no evidence. The deferral replaces the paths that `block` a task because its models refused
  or are cooling; nothing of the guard's is replaced.
- §4, §6: the evidence for "every model refused" is what the run itself saw. The shared cooldown
  table holds one entry per model, the latest refusal, so a run that read it would stop for an outage
  while a model was serving other tasks.
- §16: only a reviewer that timed out keeps today's park. One that crashed goes to `awaiting-human`,
  as today.
- §7, §13, §16: the guard's allow-list is part of what the owner decides after an outage; a live
  refusal check has to pass the guard first; the clarify and planner sessions are judged by the
  guard and not by a notice.
- §11: the prompt line is placed where the prompt is built now, and changing the prompt is
  `risk: high` and signed by the owner before it is merged, as ADR-0011 and ADR-0013 handle theirs.

What the author decided while revising. Each is a *call*:

1. Every round starts again at the head of the chain, so that each round tries the whole chain.
2. The evidence counts a turn that was accepted after the task's first refusal, as §4, §6 and §16
   already said, and not one accepted earlier in the run: an acceptance an hour old must not hide an
   outage that began since.
3. A run that stops for an outage exits 3, whatever else happened in it.
4. A task the guard refused is in the stuck list, read from a record rather than by asking the guard.
5. The prompt line is Chinese, like every fixed line of the prompt.
6. A pass in which no model refused the task, because every model was already cooling, is not a
   round.
7. §11 closes the item the learning-loop design put off, and that design says so.
8. A manual `retry` of a deferred task keeps its earliest time and starts its rounds again; the review
   stage counts its rounds anew; `run --batch` does not wait for a window; a `retry --review-only`
   that a deferral holds says so, with the time.
