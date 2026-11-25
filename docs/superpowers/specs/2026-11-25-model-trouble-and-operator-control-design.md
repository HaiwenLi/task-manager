# Model trouble and operator control — design

Status: approved by the owner on 2026-11-25. Nothing in it is built yet.

Where it changes [the adaptive execution design](2026-11-24-adaptive-execution-design.md), it
supersedes that document: §14.1 (shared provider cooldown) and §16.1 (the lane is chosen by the model
at intake). Section 10 lists the owner's decisions; everything marked *call* is the author's and can
be overruled.

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
- *Call.* A new optional key `modelPlan`: prefixes (a provider, or `provider/model`) that the owner's
  subscription covers, for example `zhipuai-coding-plan/`. At the start of `run`, `watch` and `retry`,
  every model of both chains that no prefix covers is named in one notice: "not covered by the plan;
  may be billed per use". The notice is also journaled. With no chain configured, the notice says
  that the backend's default model will be used.
- The system never adds a model to a chain. A paid fallback is used when, and only when, the owner
  has put it into the configuration himself, which is his decision; the notice above is how he is
  told about the billing risk.

## 6. A refusal

Definitions:

- A **round** is one pass over the chain: each model is tried once, and a refusal moves to the next
  model at once.
- A refusal is what the adapter reports as a provider failure (today's `failure === "provider"`),
  whether or not the turn had already done work. *Call.* The adapter cannot tell a refusal before
  any work from a provider error after some work, and a provider error is not the task's fault
  either way: such a turn spends no retry. A turn that ran and failed for any other reason keeps
  today's handling.

Behaviour:

1. Inside a round, a refusal switches to the next model. It does not spend a retry.
2. If a model accepts the turn, the task proceeds as today. Success clears that model's cooldown.
3. If every model of the chain refused in the round, the attempt ends. It spends no retry and the
   task is not `blocked`. The task stays `open` and carries a **deferral** — a per-task runtime
   record with the round count, the time of the first refusal, each model's refusal, and the
   earliest time at which the task may be claimed again, `modelCooldownMs` from now.
4. While a deferral's time lies in the future, the claim path refuses the task exactly as it refuses
   one whose dependency is not done. `run` and `watch` wait for the nearest such time when nothing
   else is runnable, then run another pass.
5. After `modelRounds` rounds without any model accepting, the run looks at its evidence:
   - **Another task got a turn accepted on a chain model after this task's first refusal.** The
     model works; the refusal is this task's own problem. The task is `blocked` with a note naming
     every model and what each said. Its dependents wait (today's behaviour) and the others continue.
   - **No task did.** This is an outage. The task is left as it is — `open`, retries untouched — and
     the whole `run` or `watch` stops with the report of §7.
   A task with a deferral is shown in the stuck list (§8) with its round count and next time.
- *Call.* `modelCooldownMs` defaults to 60 seconds (today 900 000) and `modelRounds` to 4. With
  four models that is four to five minutes before a task is held or a run stops.
- The board-wide cooldown table keeps its role within a window: a model that refused is skipped by
  every task until its entry expires or a success clears it. It no longer causes `blocked`.
- *Call.* `blockForQuota`, the path that blocks a task at once when the chain cannot move on, is
  replaced by the round logic above: a quota refusal is a refusal.
- `chainCycles` keeps its meaning inside a round.

## 7. Stopping for an outage

The report, printed by `run` and `watch` before they exit:

- each model of the chain and the provider's reason for refusing it, one line each;
- how many rounds were tried and over how long;
- the tasks that are waiting, all of them still runnable;
- the decision that is the owner's: to use another model, put it into `modelChain` in `taskctl.json`
  and run again. Models outside the plan may be billed per use.

*Call.* The exit code is a documented value distinct from "tasks were blocked" and from success.
Nothing is `blocked` by an outage, so after the configuration is changed a plain `taskctl run`, or
`taskctl watch`, resumes every waiting task without a `retry` per task.

## 8. The stuck list

*Call.* `taskctl status --stuck` prints only what is held or waiting, one line per task:

| Group | Line says |
| --- | --- |
| `blocked` | the reason (from its note or its last block event), since when, and for a model refusal every model and what it said |
| waiting on a dependency that will not finish on its own | which task, and why that one is held |
| deferred for a model window | round `n` of `modelRounds`, next time |
| needs a person | `awaiting-human`, a `draft` awaiting signature, open questions |

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
- The worker prompt gains one line, not the content: "The previous turn did not pass. Before you
  start, read `<path>`: it says why, and what has to change."
- The file lives in the task directory, so a new session — after a model switch or a context wrap —
  is pointed at it as well. The review rework note that exists today stays.

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
  real backend — an invalid model costs no quota.

## 14. Order of work

1. Refusals, rounds, deferral, outage stop (§5–§7) and the stuck list (§8).
2. Stop (§9).
3. Escalation feedback (§11).
4. The lane (§12).

Parts 2 to 4 do not depend on part 1 and may be built in any order after it.

## 15. Left to the builder

- Names and locations of the deferral record and of `rework.md`, under `tasks/<id>/`, outside the
  definition digest and outside the acceptance drift digest.
- The exact exit codes, and how `run --batch` reports an outage.
- How the run-level evidence of accepted turns is kept across a batch session, where several tasks
  share one session.
- Wording of the notices and of the outage report.
- How the stuck list walks a chain of dependencies.
- Whether the deferral survives a manual `taskctl retry` (it should: a retry is not a reason to
  hammer a model that has just refused).

## 16. Added after the builder's check

A reviewer with no part in the conversation read this document as the person who has to plan from
it, and asked four questions. Three are settled here by the author; the fourth was the owner's, and
he has decided it.

**The review stage.** A reviewer refusal takes the same path as a worker refusal: the chain is
walked, a fully refused round defers the task, and nothing is replayed — the worker's work and the
acceptance evidence are preserved, as today's park preserves them. When the window reopens, the
controller resumes the review on the preserved evidence by itself, through today's review-only path
and its digest gate. After `modelRounds` the same evidence rule decides: if another task got a turn
accepted, the task is parked as today, `blocked` with `review-pending.json`, for the owner;
otherwise it is an outage stop, and the task keeps its preserved evidence for the rerun. An accepted
reviewer turn is evidence that the model works. A reviewer that crashed or timed out is not a
refusal and keeps today's park. This supersedes the part of §9 of the 11-24 design that leaves a
refused review to a person's `retry --review-only`.

**Every model the tool can dispatch with.** The notice of §5 covers both chains and also `model`
where it is used directly: the clarify session of `taskctl add` and the planner of `taskctl split`.
*Call.* When `model` is unset, those two use the head of `modelChain` instead of the backend's
default model.

**`stop --now` also interrupts the acceptance command** — the owner's decision, on the author's
recommendation. The owner's acceptance gates run for tens of minutes, so a stop will often land
inside one; a stop that waited for the gate to end would not be a stop. The gate's cancellation has
to become confirmable first. Today it is confirmed by the closure of its output pipes, which a
grandchild process can hold open, so a cut gate would often end `uncertain` and need reconciliation
by hand — the anti-goal. Making it confirmable is part of this work. The render check is not a
cancellable execution today.
