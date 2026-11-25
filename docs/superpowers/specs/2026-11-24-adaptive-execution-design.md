# Adaptive execution, static subtasks, and continuous batches

Status: 已批准开发（用户 2026-11-24 指示“先做开发”）  
Date: 2026-11-24  
Applies to: `main@68a535b`  
Related evidence: `docs/reviews/2026-11-24-idtrecon-orchestration-retro.md`

## 1. Intent and why

taskctl currently gives every task nearly the same execution policy. `complexity` only controls
whether intake waits for approval; it does not control execution. `verify` controls the evidence
needed to finish, but it does not control how work is retried. As a result:

- a small task can spend many worker turns before it escalates;
- a review failure returns the task to the scheduler instead of continuing the current line of work;
- an acceptance failure starts a fresh worker session without giving that session the failure output;
- reviewer infrastructure exhaustion can replay already successful worker side effects;
- worker and controller are both encouraged to run the same expensive acceptance command;
- separately planned subtasks have no parent/linkage workflow, and several small tasks cannot reuse a
  settled worker session.

The requested change is not “less verification”. It is to spend orchestration effort in proportion
to the work while preserving the evidence and safety properties that already work. On intake, taskctl
classifies the request into a quick, simple or complex management lane; complex intake also produces
an approved static split plan. A trivial request may still be handled outside taskctl entirely, while
`quick` is the lightweight recorded path. Simple recorded work normally means Worker → final Review;
complex work uses linked subtasks and bounded Worker → Review → Worker iteration.

The IDTRecon session records support that priority. In that one workload, 13 review sessions consumed
about 377k input tokens, while 30 worker sessions consumed about 7.16M. Review was not the largest
cost. Context loss, repeated worker attempts and repeated heavy gates were the larger targets. These
numbers are evidence for this design, not a promised percentage saving for other projects.

## 2. Goals

1. Let a task declare an execution strategy independently of intake complexity and completion proof.
2. Let simple work finish in one continuous line of execution, escalating only when runtime evidence
   shows that iteration is necessary.
3. Make iterative work a real `Worker → Verify/Review → Worker` loop that preserves context and
   supplies the previous failure to the next worker turn.
4. Never replay worker side effects merely because the reviewer is unavailable.
5. Support explicit, approved static decomposition into child Markdown tasks, followed by parent
   integration and final verification.
6. Support a later continuous batch of selected small tasks that reuses a worker session without
   weakening per-task fencing or acceptance evidence.
7. Remove the highest-value repeated work: unbounded/full worker acceptance reruns, repeated model
   discovery, known-provider refusals across tasks, and useless sleeps between different providers.
8. Record enough per-turn usage to measure future changes instead of guessing.
9. Run as a durable queue: the operator starts taskctl once, then may add tasks at any time without
   manually restarting a run. Idle waiting performs no model calls and no busy polling.
10. Use explicit historical preferences and human correction records to improve intake sufficiency and
    consensus, measuring first-pass user acceptance separately from automatic worker rework.

## 3. Non-goals

- No automatic downgrade of risk or verification. Intake may classify the management lane, but an
  uncertain classification falls back to the more conservative lane.
- No dynamic/runtime DAG rewriting by an unconstrained worker.
- No model training or autonomous rewriting of the preference profile; historical learning consists of
  inspectable human feedback and deterministic records.
- No operating-system service installer or reboot persistence in this increment; `watch` is the single
  long-running manager process that an operator starts once.
- A batch is not a transactional multi-task commit and does not merge acceptance evidence.
- No new Web UI, database, agent framework, or second lifecycle authority.
- No weakening of high-risk/human gates, independent review, definition digests, workspace fencing,
  or uncertain-execution handling.
- No attempt to close every recommendation in the retrospective. Drain, one-command uncertain
  recovery, background-process reaping, budget preflight and commit-hygiene guards remain separate
  work items.

## 4. Anti-goals

- `execution: continuous` becomes a synonym for “skip review”.
- A task that was escalated later finishes through a mechanical shortcut without review.
- A provider outage causes a successful worker or acceptance gate to run again.
- A parent holds a workspace reservation while waiting for children.
- A batch makes it impossible to tell which task produced or verified which artifact.
- A crash during split publishes runnable, unapproved children or duplicates them on retry.
- A token/cost optimization silently drops evidence needed for review or recovery.
- An idle queue repeatedly invokes a model, rescans/rebuilds everything without a change, or busy-polls.
- Intake executes a task whose missing answer would change the deliverable, acceptance or risk boundary.
- A model's own self-evaluation silently becomes a new user preference.

## 5. Existing decisions and constraints

1. Markdown remains the only task lifecycle authority. Runtime JSON owns execution facts and hints,
   never lifecycle state.
2. `complexity` keeps its ADR-0009 meaning: whether intake waits for a signature.
3. `verify` keeps its meaning: `human`, `mechanical`, or `render` decides what proves completion.
4. Independent reviewers remain fresh, evidence-only sessions. Worker session reuse is allowed;
   reviewer/worker session sharing is not.
5. High-risk and `human_check` tasks still stop at `awaiting-human` after the required evidence passes.
6. Definition changes happen before claim or at a settled, human-acknowledged attempt boundary.
7. Model changes are session boundaries. Same-model session reuse is permitted only after the prior
   execution is settled and the reuse probe in §8.4 returns `reusable`. An `active` backend session
   blocks further work; an unavailable probe disables reuse rather than inventing proof.
8. All work remains bounded by retry, review-round, session, turn and acceptance limits.
9. The orchestration protocol is cooperative, not a sandbox. “Worker cannot run X” means the protocol
   and provided tooling disallow it, not that OS permissions make it impossible.

## 6. Approaches considered

### A. Explicit execution policy + static split + phased continuous batches — selected

Add `execution: continuous | iterative`, preserve the separate meanings of `complexity` and `verify`,
and reuse the current DAG, fencing and evidence model. Split is approved while the parent is still a
draft. Continuous batches are built after the single-task semantics are reliable.

This is the selected approach because it addresses both meanings of “一口气走完” without creating a
second orchestrator.

### B. Use `complexity` alone to select budgets — rejected

This is smaller, but mixes intake approval, execution and verification semantics. It also provides no
clean path to approved subtasks or cross-task session reuse.

### C. Build dynamic planning first — rejected

Allowing a worker to publish children and rewrite dependencies during execution requires idempotent
multi-file publication, blocked-child propagation, crash recovery and dependency-wait reporting all at
once. Static splitting supplies most of the value with substantially less risk. Dynamic planning can
be reconsidered after real split/batch records show that it is needed.

## 7. Task schema and CLI

### 7.1 New task fields

```yaml
execution: continuous | iterative       # optional
worker_self_check: <shell command>      # optional
worker_self_check_timeout_ms: 1200000   # optional; bounded
parent_id: <parent task id>             # generated split children only
```

All four fields are definition fields and participate in `definitionDigest`.

Default execution is derived once when the task is read:

- `complexity: simple` → `continuous`;
- otherwise → `iterative`;
- an explicit `execution` always wins.

Thus `complex` controls approval even when execution is continuous, and `simple` can still request an
iterative execution policy. Existing complex tasks retain their current broad policy, while existing
simple tasks gain the new continuous behavior.

`taskctl add` accepts `--execution continuous|iterative`. Invalid combinations fail at intake/parse
time. In particular, `worker_self_check_timeout_ms` must be positive and no greater than the configured
worker turn timeout.

### 7.2 New or extended commands

```text
taskctl check --task <id> [--tasks-dir <dir>]
taskctl split --task <id> [--apply] [--tasks-dir <dir>]
taskctl retry --task <id> --review-only [--tasks-dir <dir>]
taskctl run --batch <id,id,...> [--config <file>]
taskctl watch --config <file> [--resume]
taskctl stop --tasks-dir <dir>
```

`check` is the worker-side bounded self-check entry point. `split` is valid only for a draft parent.
`retry --review-only` is valid only for a recorded review-pending outcome. `run --batch` is the phase-2
entry point; normal `run` behavior remains available.

## 8. Execution state machine

### 8.1 Continuous

```text
claim → one worker turn → controller verification
             │                    │
             │                    ├─ mechanical/render pass → done or human gate
             │                    ├─ human review pass/unclear → done/human gate
             │                    └─ failed evidence/review → escalate → iterative
             └─ no done marker → escalate → iterative
```

“One worker turn” means one `opencode run` invocation, which may contain many tool calls. It does not
mean one model token response.

Continuous does not itself suppress review. `verify: human` still gets one independent review;
`mechanical` and `render` remain the explicit no-review paths.

The existing quick-lane exception remains: when human review is mandatory but no criteria exist,
taskctl does not invoke a reviewer and does not invent criteria. It records the missing review input
and enters `awaiting-human`, including after escalation. Sticky `requiresReview` therefore means
“do not use a mechanical/render shortcut”, not “manufacture evidence that was never declared”.

A continuous task escalates when any of these facts occurs:

- the worker writes `ESCALATE: <reason>`;
- the first turn ends without `done.requested`;
- controller acceptance/render evidence fails and a retry is permitted;
- human review returns `fail`;
- context or turn/session handoff is required.

Escalation is recorded as `requiresReview: true` and `effectiveExecution: "iterative"` in the runtime
execution state. The next worker turn resumes the same session when the model is unchanged and receives
the concrete reason. It does not start a blind scheduler retry. Once escalated, later attempts in the
same task cannot return to a mechanical/render no-review shortcut, including after a review rework.

### 8.2 Iterative

Iterative keeps the current bounded worker loop, but acceptance and review rework stay inside the
current `runTask` attempt whenever the prior execution is settled:

```text
worker turn(s) → acceptance/render → independent review when declared
       ↑              │                       │
       │              └─ failure feedback ─────┤
       └───────────────────────────────────────┘
```

Changes from current behavior:

1. Every failed acceptance writes a bounded rework note containing exit code, normalized output tail,
   failure fingerprint and the next required action. This happens on every retry, not only when the
   fingerprint breaker trips.
2. Acceptance failure and review `fail` resume the same worker session if the selected model is the
   same. The prompt includes the new failure note. A model handover still starts fresh.
3. These paths no longer return to `open` merely to make the scheduler rediscover the work. Retry and
   review-round accounting, stall detection and terminal `blocked` outcomes remain enforced.
4. Human `reject` still returns a settled task to `open`; the next attempt may resume the last session
   only through the persisted same-model session rule below.
5. `unclear` remains `awaiting-human`; it is not a worker failure and does not consume a rework round.

### 8.3 Persisted execution state

`tasks/<id>/execution-state.json` stores facts such as:

```json
{
  "requiresReview": true,
  "effectiveExecution": "iterative",
  "reasons": ["acceptance failed", "review failed"],
  "latestWorker": { "sessionId": "ses_…", "model": "provider/model" },
  "updatedAt": "…"
}
```

It is not a status file. It survives automatic attempts and evidence archiving so escalation does not
get lost and a same-model retry can resume. A changed model never reuses the recorded session. Invalid
or unreadable state fails safe: no session reuse and review required; it must not silently de-escalate.
Terminal task history may retain this file for reporting.

### 8.4 Session reuse probe

A clean CLI exit and a settled attempt are necessary but are not, by themselves, proof that a persisted
or cross-task backend session is reusable. The adapter gains a bounded, read-only reuse probe with a
three-way result:

- `reusable`: the recorded session exists, is idle, and its actual model and directory match the next
  dispatch. The previous attempt is settled and its last worker CLI exited cleanly. Provider rejection,
  timeout, cancellation and uncertain outcomes never qualify.
- `active`: the backend reports that the session is still busy or executing. This contradicts the local
  settled record, so taskctl blocks for reconciliation and does not start a competing worker.
- `unavailable`: the session is absent, the adapter lacks a status capability, the reply is inconclusive,
  or the control-plane probe fails. Taskctl journals why reuse was skipped and starts a fresh session
  only where the already-settled attempt independently permits that ordinary fresh attempt.

The OpenCode implementation uses its service-side session status. The probe creates no model turn and
has a short control-plane timeout. Adapters without this capability may continue in-process same-model
continuation after a clean turn, but must report `unavailable` for persisted or cross-task reuse.
Thus live-backend verification covers the OpenCode probe while other adapters degrade to fresh sessions
without changing task semantics.

## 9. Reviewer unavailability: preserve work and resume review only

> **2026-11-25 — partly superseded by [the model-trouble design](2026-11-25-model-trouble-and-operator-control-design.md) §16.** Steps 1–3 still hold for a refused reviewer, but step 4 no longer parks a refused review: the task stays `open` with the preserved evidence, and the controller resumes the review by itself when the model window reopens. The park of steps 4–5, recovered by `retry --review-only`, remains for a reviewer that timed out and for a review refused in `modelRounds` rounds while another task was served.

When every reviewer model is unavailable because of provider/quota failures:

1. Do not increment worker retries or review rounds.
2. Preserve `acceptance.json`, artifact digests, definition snapshot, review evidence and the worker
   session record.
3. Write `tasks/<id>/review-pending.json` with the evidence digests, refusal details and timestamp.
4. Settle the attempt, release the workspace and mark the task `blocked` with a clear “review pending;
   worker/acceptance preserved” reason.

`taskctl retry --task <id> --review-only` then:

1. Uses the normal claim, ownership and workspace-reservation path.
2. Requires the previous attempt to be settled and `review-pending.json` to exist.
3. Recomputes the task definition digest and the artifact digest. Any mismatch rejects review-only
   recovery because the old evidence is stale; it never blesses changed work.
4. Runs only the reviewer against the preserved evidence. It does not invoke the worker or rerun the
   acceptance command.
5. On `pass`, applies the normal done/human-gate rules. On `unclear`, enters `awaiting-human`. On
   `fail`, writes the review-failed note and opens the normal iterative worker path.

Ordinary `taskctl retry` remains the explicit full-retry operation and cannot be accidentally replaced
by this path.

## 10. Worker self-check versus controller acceptance

The worker protocol will state plainly:

- `acceptance` is controller-owned and runs after `taskctl done`;
- a worker must not invoke the full acceptance command merely to decide whether to hand off;
- cheap, targeted checks are encouraged;
- if the task needs a bounded generation/self-check step, the worker uses `taskctl check`.

`taskctl check`:

- requires a running task with an active matching attempt and a declared `worker_self_check`;
- executes that command with `TASKCTL_ACCEPTANCE_MODE=generate` and the declared timeout;
- captures partial output on timeout and writes `tasks/<id>/self-check.json` containing command, mode,
  timing, exit result and bounded output;
- never marks the task done and never substitutes for controller acceptance.

This retains the useful generate/check separation for tasks whose deliverables must be generated before
the controller’s read-only `check` gate. It removes the default incentive to run the same full suite
twice. README examples will use `worker_self_check` plus `taskctl check`, rather than telling every
worker to rerun `acceptance`.

## 11. Escalation correctness fixes

Two existing defects are prerequisites, not optional extras:

1. Escalated render verification currently returns an unmatched `"review"` outcome and can leave a
   task stranded in `running`. It must enter the same review stage as other escalated evidence, with a
   regression test that proves a reviewer is invoked and the task reaches a terminal/next valid state.
2. Escalation is currently attempt-local. The persisted `requiresReview` fact in §8.3 makes it sticky
   across review rework and automatic/manual retries.

The known `workspace.ts` nullable-identity type errors will also be corrected without changing its
fail-closed behavior. Completion requires `npx tsc --noEmit` to run cleanly so new type errors cannot
hide behind the current baseline.

## 12. Static split while the parent is draft

### 12.1 Planning and approval

`taskctl split --task <id>` uses the configured intake/planner adapter to read the parent intent and
spec, then writes a deterministic `tasks/<id>/split-plan.json` and prints a readable plan. Without
`--apply`, no task definition changes.

The plan contains:

- parent definition digest and plan schema version;
- stable child IDs allocated from the board’s ID sequence;
- each child’s title, body, criteria, acceptance/verify, execution, risk and dependencies;
- the parent integration step and its final criteria;
- explicit inherited fields, so applying the plan does not consult the model again.

`--apply` requires the parent to remain `draft` and its definition digest to match the plan. The human
then reviews the generated child files and the modified parent. The existing `taskctl approve` on the
parent approves the entire visible split bundle; separate child approval commands are not required.

### 12.2 Publication and gating

Children are written as `open` files with `parent_id`, but the scheduler treats an open child with a
`draft` ancestor as **waiting for bundle approval**, not ready. The parent remains `draft` throughout
publication and is linked to the children last. Approving the parent opens the integration parent and
makes the already-open children eligible subject to their own dependencies.

This rule prevents partially published children from running before approval without introducing a
second approval store or a multi-file status transaction.

Publication order:

1. Validate the complete plan, all IDs, fields and the dependency graph in memory.
2. Write child Markdown files and runtime plan records idempotently. Existing children must match the
   planned content exactly; otherwise abort for human inspection.
3. Re-scan the actual files and validate unknown dependencies and cycles.
4. Update the parent last, adding the child IDs to `depends_on` and an integration-only section to its
   body. Keep the original intent and final criteria.
5. Leave the parent `draft` until explicit `approve`.

A crash before step 4 leaves children gated by the draft parent and allows the same plan to be resumed
without allocating new IDs. A crash after step 4 is also idempotent. No execution reservation is held
at any point.

### 12.3 Execution and integration

Children use the existing scheduler and may be continuous or iterative as declared. The parent waits
for all children to be `done`; it never keeps a workspace reservation while waiting. Once ready, the
parent performs integration and its own final acceptance/review.

The parent worker prompt receives bounded dependency summaries: child ID/title, final verdict, latest
handoff, acceptance location and relevant artifact paths. It does not replay child sessions. Board and
status output distinguish dependency waiting, parent approval waiting and a blocked dependency instead
of showing an unexplained open task.

Only one static split level is required in this increment. Nested split and dynamic split remain out of
scope. Scheduler pass limits and no-progress reporting will be adjusted so a valid deep dependency
chain cannot silently exhaust the current fixed 50-pass budget.

## 13. Phase 2: continuous batches

### 13.1 Meaning

A continuous batch is a scheduler policy, not a new mega-task and not a transactional group. Selected
tasks still get individual claims, definition snapshots, acceptance records, reviews when required,
terminal states and reports. The batch reuses the last settled worker session across task boundaries
when it is safe to do so.

This preserves per-task evidence while removing repeated session startup and repository rediscovery.
It intentionally does not defer all acceptance commands to the end: doing so would make artifact
attribution ambiguous when several tasks share a workdir.

### 13.2 Eligibility

The first version requires every selected task to have:

- `execution: continuous` (explicit or derived from `simple`);
- the same resolved workdir;
- `verify: mechanical` or `verify: render`;
- normal risk and no `human_check`;
- dependencies that are already done or appear earlier in the selected order;
- no uncertain/active previous execution.

A task that escalates may finish iteratively with review before the batch proceeds. High-risk,
human-gated, cross-workdir and explicitly iterative tasks are rejected from the initial batch command
rather than silently weakened.

### 13.3 Execution

`taskctl run --batch C,B,A` validates the entire selection, then runs exactly that order and claims no
unselected tasks from the same scheduler. For each task:

1. Claim and verify it normally.
2. Revalidate the selected definition before every claim. A workdir change after initial validation
   aborts the batch before that task is claimed; mixed-workdir execution is never accepted. Resume the
   previous batch session only if the actual selected model and workdir match, the reuse probe returns
   `reusable`, and the prior execution settled successfully. An actual model mismatch starts a fresh
   session and records why; an `active` probe blocks for reconciliation.
3. Prepend a batch preamble identifying the current task and warning the worker not to redo earlier
   completed tasks or change their definitions.
4. Run that task’s own controller acceptance and any review required by escalation before starting the
   next task.
5. Append the session ID to each task that actually used it and record usage deltas per task.

If a task blocks or enters `awaiting-human`, the batch stops and later tasks are not claimed. Model
handover creates a new session; the batch itself does not fail merely because session reuse is no
longer safe. Other controllers may still compete for the workspace between individual claims; the
existing fencing rules decide that race. The batch scheduler never interleaves its own unselected work.

## 14. Resource reductions and measurement

### 14.1 Shared provider cooldown

> **2026-11-25 — superseded by [the model-trouble design](2026-11-25-model-trouble-and-operator-control-design.md) §6.** A cooling model is still skipped within its window, but "the task stops with the next probe time" no longer holds: a task whose chain is fully refused or cooling is deferred (`open`, with `tasks/<id>/model-wait.json`) and offered again when the window expires, and after `modelRounds` the controller decides between the task's own problem and an outage stop. `modelCooldownMs` defaults to 60 seconds. Of "The existing per-task chain position and `chainCycles` remain" only `chainCycles` holds: the position is reset at the start of every round.

Add a board-level `.taskctl/model-cooldowns.json` in the existing derived-runtime area, not in a task’s
attempt archive. Entries contain exact model ID, observed refusal time, `retryAfter`, category and a
bounded reason. Writes are atomic and serialized with the existing mutation discipline.

Worker and reviewer model selection both consult it:

- a model inside cooldown is skipped without spawning a provider turn;
- success clears the entry;
- expiry permits one new probe;
- manual task retry does not clear the table;
- if every candidate is cooling, the task stops with the next probe time instead of sleeping for hours
  or spinning through the chain.

A configurable `modelCooldownMs` defaults to 15 minutes. It is a re-probe window, not a claim to know a
provider’s actual billing/quota reset. The existing per-task chain position and `chainCycles` remain;
shared cooldown prevents known failures from being repeated across tasks and separate runs.

### 14.2 Remove useless handover sleep and repeated discovery

- When fallback selects a different model, dispatch it immediately. Backoff is reserved for re-probing
  the same model or an explicit cooldown, not applied after a successful switch to another provider.
- `contextLimit()` reads the same cached model catalogue used by `resolveModel()`. Repeated model and
  context-limit lookups in one adapter process produce one `model.list` invocation. Usage and cached
  limit lookup need not run sequentially.
- Review model resolution uses the same variant-aware resolver as worker dispatch.

### 14.3 Avoid low-value I/O

- Artifact sweeping first checks whether any new root-level candidate matches the scratch/keep rules;
  only then does it invoke Git. A no-candidate turn does not spawn `git status`.
- Board refreshes are coalesced: multiple events while one refresh is pending produce one follow-up
  refresh with the latest state, plus the existing final flush. Correctness does not depend on writing
  every intermediate board.
- Full artifact hashing remains around controller acceptance only. No incremental-hashing rewrite is
  justified until duration records show it is a real bottleneck.

### 14.4 Usage records

Extend the adapter with a best-effort session usage snapshot containing input, output, reasoning,
cache read/write, cost and model. Worker and reviewer turns append records to
`tasks/<id>/usage.jsonl` with role, session ID, model, duration and cumulative snapshot/delta. A reset
or unavailable counter is recorded as unknown, never converted into a misleading zero-cost claim.

`review.json` gains the reviewer session ID. `report` and run summaries show per-task and per-model
usage totals where available, plus counts of worker sessions, acceptance gates, reviews, fallbacks and
review-only recoveries. Telemetry failure is journaled but does not invalidate otherwise good work.

The optimization acceptance criteria use structural counts first—sessions created, provider calls,
acceptance invocations and review-only recovery—not an unproven promise of a universal token saving.

## 15. Verification and acceptance

### 15.1 Offline regression coverage

New tests must prove at least:

1. Simple + mechanical continuous work performs one worker turn, one acceptance gate and no review.
2. A continuous turn without `done` escalates promptly and resumes the same session rather than
   spinning through the default turn budget.
3. Continuous + human gets one review on first-pass success; review failure escalates and resumes the
   worker with feedback. Mechanical/render shortcuts cannot return after escalation.
4. Iterative acceptance failure reuses the same-model session and injects bounded failure output; a
   model change starts fresh.
5. Exhausted reviewer-provider fallback never invokes the worker or acceptance again. Review-only
   retry works, and definition/artifact drift rejects it.
6. Escalated render reaches review and cannot remain stranded in `running`.
7. `taskctl check` enforces the declared command/timeout and records partial timeout output; worker
   protocol and README no longer encourage an unconditional full acceptance rerun.
8. Two tasks sharing a refused model demonstrate shared cooldown, expiry re-probe and persistence
   across manual retry. A different-model handover has no artificial pause.
9. Repeated model/context lookups produce one `model.list` call; reviewer variant resolution is
   covered.
10. Static split cannot run children before parent approval, is idempotent across simulated crashes,
    rejects cycles/unknown IDs, runs dependencies in order and finishes with parent integration.
11. A two-task continuous batch uses one worker session when safe, retains two independent acceptance
    records, stops on a blocked/awaiting-human task, starts fresh after an actual model mismatch, and
    rejects an initial or mid-batch workdir mismatch before claiming the mismatched task.
12. Usage deltas and review session IDs are reported; unavailable usage does not fail the task.
13. Existing fencing, cancellation, uncertain-execution, review and artifact tests remain green.
14. Intake classification is conservative on invalid output, cannot weaken risk/verify, asks only
    outcome-changing questions, and reopens clarify-attributed work as draft. Feedback history is
    bounded, human-authored and never silently rewritten by a model.
15. Watch picks up a newly added open task without another run, performs zero model calls while idle,
    coalesces filesystem bursts, refuses a second live watcher, drains on stop, and automatically
    forms only eligible batches. A task arriving during a batch waits for the next scheduling boundary.

Mutation checks should remove or reverse each key guard once to demonstrate that the corresponding
test fails for the intended reason.

### 15.2 Baseline and final gates

Baseline on this design’s starting commit:

- `npm test`: 416 passed, 1 skipped;
- `npx tsc --noEmit`: the three retrospective errors in `worker.ts` and `workspace.ts`.

Final required gates:

- `npm test` — all non-skipped tests pass;
- `npx tsc --noEmit` — zero errors;
- `scripts/smoke.ps1` without `-Live` — environment preparation passes;
- targeted CLI integration tests exercise real config parsing for every new key.

A live-provider smoke should be a separate, explicitly bounded run because it consumes model quota.
If it is not run, the completion report must say exactly which real-backend paths remain unverified;
offline green must not be presented as live-provider proof.

## 16. Intake classification, sufficiency and historical feedback

### 16.1 Three management lanes

The normal `taskctl add` intake produces the spec and the management classification in the same model
interaction; it does not spend a separate classifier turn. The result is stored in
`tasks/<id>/classification.json` with the model, lane, short rationale and information-sufficiency
outcome.

| Lane | Task fields | Approval | Execution and finish |
| --- | --- | --- | --- |
| Quick | `quick: true`, `complexity: simple`, normally `execution: continuous` | No clarify/signature; explicit `--quick` still makes no model call | One lightweight recorded attempt; objective evidence may finish, while missing human criteria still waits for a person. A trivial request may instead be handled outside taskctl. |
| Simple | `complexity: simple`, normally `execution: continuous` | Spec and assumptions are written, but no signature wait | Normally Worker → one final independent Review. Mechanical/render skips review only when explicitly declared. Failure escalates automatically instead of asking the user to drive rework. |
| Complex | `complexity: complex`, normally `execution: iterative` | Parent/spec/split bundle waits in `draft` | Approved static children plus parent integration; Worker → Review → Worker continues within the bounded automatic loop. |

The classification chooses management effort only. It cannot lower `risk`, remove `human_check`, weaken
criteria or turn human verification into mechanical verification. Those require an explicit declaration
in the approved task definition. An invalid, contradictory or uncertain classification becomes complex
and remains `draft`; it never becomes quick by default.

The operator can override the proposed lane with the existing quick/simple flags or `--execution`.
Changing the approved definition later follows the normal settled-attempt and digest rules.

### 16.2 Information sufficiency and consensus

Intake returns one of three outcomes:

- `clear`: required deliverable, boundaries and completion evidence are written; the task may enter its
  lane's normal approval path.
- `assumptions`: non-critical gaps are recorded explicitly in the spec. Simple/quick work may proceed,
  and final review checks those assumptions; complex work still waits for bundle approval.
- `needs-information`: an unanswered question would change the deliverable, acceptance, forbidden scope
  or risk. The task remains `draft` with a short `questions.md`; watch does not execute it.

At most three questions are asked, in one batch. A question is allowed only when its answer can change
one of those outcomes; facts derivable from the repository are never delegated back to the user. The
question record explains which decision each answer unblocks. Answers are appended to the spec before
approval, and the revised definition receives a new digest.

This is a consensus gate, not a demand for ritual confirmation. Clear simple tasks do not wait for a
“确认一下吗”, and historical feedback is used to avoid asking questions already answered in previous
similar tasks.

### 16.3 Inspectable historical feedback

Two existing/explicit sources are used; no training or hidden self-modification is introduced:

- `.taskctl/profile.md` remains the human-editable preference file.
- `.taskctl/feedback.jsonl` deterministically records human `accept`, `reject` and `audit` reasons,
  attributed stage, task type, task ID and timestamp. A plain pass without human feedback adds no new
  preference. Model-generated suggestions never modify either source automatically.

Intake receives a bounded packet containing the profile and relevant prior human corrections, selected
by task type and literal keyword overlap, newest first. It does not read entire historical transcripts
or spend an embedding/model call to find them.

A human rejection attributed to `clarify` returns the task to `draft` with the unresolved question,
instead of reopening the worker against a known-wrong specification. Worker/reviewer attribution keeps
the existing rework behavior. Metrics distinguish:

- **first-pass user acceptance**: completed without a human clarify rejection or user-requested rework;
- **automatic worker rework**: acceptance/review rounds handled by taskctl without user intervention;
- intake information rate, classification escalation rate and review-only recovery counts.

The desired trend is fewer user-driven repetitions, not merely fewer recorded review calls.

## 17. Durable watch queue and automatic batches

### 17.1 Watch lifecycle

`taskctl watch --config <file>` starts one long-lived manager for a board. Once started, the operator
can add tasks at any time; watch discovers them, performs scheduling in board order, prioritizes an
unfinished in-flight task, and claims ready work without another manual `run`. Draft,
awaiting-human and blocked tasks remain visible but are not executed around their gates.

The board allows one watch owner at a time through `.taskctl/watch.lock` with the same generation and
heartbeat discipline as task ownership. A second watcher does not duplicate polling or dispatch. A
stale record is diagnosed rather than blindly stolen because a PID alone does not prove ownership.

Idle discovery uses `fs.watch` on the task directory with a 250 ms debounce and a 30-second fallback
check. Idle iterations do no model calls, no full artifact digest and no board rewrite unless observed
state changed. The adapter, model catalogue and cooldown table are reused across wakeups.

### 17.2 Automatic grouping

Whenever watch finds at least two tasks eligible under §13.2, it forms a continuous batch in board
order, up to `batchMaxTasks` (default 5), and applies §13.3. A single eligible task runs normally rather
than waiting for companions. New arrivals never interrupt the current task/batch and are considered at
the next scheduling boundary.

`batchMaxTasks: 1` disables automatic grouping. Manual `run --batch` remains available for an explicit
selection; watch does not require the user to select batches by hand.

### 17.3 Graceful stop

`taskctl stop --tasks-dir <dir>` writes `.taskctl/stop.requested`. Watch stops claiming new tasks,
finishes the current controlled operation or a safe handoff, settles/releases its records and exits.
It never converts stop into a process-tree kill or an uncertain replay. Starting watch clears the stop
request only through an explicit `watch --resume` decision, so a stale stop file cannot unexpectedly
launch new work.

A hard crash still follows ADR-0007 reconciliation. Drain support does not claim to reap arbitrary
background shells; that remains the separately tracked recovery limitation.

## 18. Delivery order

### Phase 1A — single-task adaptive execution and waste removal

- schema/CLI execution policy;
- continuous escalation and iterative same-session rework;
- sticky review requirement and render fix;
- review-pending/review-only recovery;
- worker self-check separation;
- shared cooldown, model catalogue reuse and handover-sleep removal;
- usage records, low-value I/O reductions and typecheck cleanup.

### Phase 1B — intake classification and consensus feedback

- one-call lane classification with conservative fallback and operator overrides;
- information-sufficiency outcomes and bounded questions;
- deterministic human-feedback history, clarify-stage re-intake and first-pass metrics.

### Phase 1C — approved static split

- complex-intake split plans plus deterministic manual re-planning;
- idempotent publication, parent-approval gating and dependency visibility;
- parent integration evidence and scheduler bounds.

### Phase 2 — durable watch and continuous batches

- event-driven idle queue, single-watch ownership and graceful drain;
- automatic eligibility grouping plus whole-selection validation for manual batches;
- sequential per-task fencing and acceptance;
- safe same-model session continuation and per-task usage;
- batch stop/resume reporting and two-task integration proof.

Each phase must leave the full offline suite green before the next begins. Phase 2 does not delay the
single-task savings, and static split does not depend on batch machinery.

## 19. Decisions left to the builder

These are implementation details that do not change the approved behavior:

- exact internal TypeScript interfaces and helper names;
- whether review-only recovery reuses `runTask` with a mode or a small dedicated claimed entry point;
- precise JSON formatting and backward-compatible report layout;
- the smallest safe refactor that keeps worker, review and scheduler logic readable;
- test fixture organization and fake-adapter call-log mechanics.

The builder may not change the public semantics in §§7–14 to simplify implementation. If one of those
semantics proves unworkable, implementation stops and returns to this design rather than silently
substituting a different policy.
