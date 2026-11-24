# IDTRecon 编排实战复盘 — taskctl 遇到的问题、已做修改与改进建议

Date: 2026-11-24
Window: 2026-11-23 10:00 – 2026-11-24 09:30 (local time)
Workload: one real project end to end — porting an IDT MATLAB algorithm layer to a dual-backend
(CUDA / FFTW) C++ DLL. 17 tasks (16 planned + 1 added mid-run), 14 `taskctl run` invocations,
14 tasks done, then the remaining 3 were moved out of taskctl to be finished in a single session.
Code baseline: every commit cited here is a **local, unpushed** commit on `main` (6 ahead of
`origin/main`). Evidence: per-task `journal.md`, `attempt.json`, `acceptance.json`, `review.json`,
the run logs, the project ledger (rulings R1–R16) and the opencode service's session records.
This document deliberately carries no machine paths, account names or host names.

Environment that exposed the problems: Windows, opencode v2.2.7 used as a client of its
background service, coding-plan models only (quota-limited, they answer 429), one work tree used
strictly serially, a heavy acceptance suite (one test process takes 5–9 GB and the GPU), long
tasks (1–3 h each), and red-line tasks that need a human sign-off.

---

## 0. Summary

| # | Problem | Severity | Status | Commit |
|---|---|---|---|---|
| P01 | Model chain copied from an old project ran 6 tasks on pay-per-token models | high | found by hand; no guard yet | — |
| P02 | Effort suffix invented for a model that publishes no variants (turn died in 0.5 s) | high | fixed | 4645f93 |
| P03 | Provider refusals classified as "uncertain" → whole board parked, fallback unreachable | high | fixed | 4645f93 |
| P04 | Linear chain parks at its tail even after the head recovers | medium | fixed (cyclic chain) | e38b0b2 |
| P05 | New config key parsed but missing from the allowlist → every CLI call dead | medium | fixed | 38edd68 |
| P06 | Review prompt carried a 45 KB log in argv → spawn ENAMETOOLONG | high | fixed by clipping | 80b2091 |
| P07 | Clipped evidence made the reviewer return `unclear` on 4 of 5 criteria | medium | mitigated | 7daa9db |
| P08 | Turn timeout → client killed only → "shutdown unconfirmed" → parked + zombie agent | high | fixed for agent turns | 40c39d2 |
| P09 | Manual kill of the orchestrator left a zombie agent for 5 h | high | tools + rules; no command yet | — |
| P10 | ADR-0007 recovery is an 8-step manual procedure (done 8 times, 14 task-recoveries) | high | not fixed | — |
| P11 | Acceptance timeout treated as an uncertain execution → parked (3× in a row) | high | config workaround | — |
| P12 | Output captured before an acceptance timeout is discarded | medium | not fixed | — |
| P13 | Identical-failure counter survives `retry` → immediate re-park | medium | not fixed | — |
| P14 | One uncertain execution collaterally blocks its resource siblings | low–med | not fixed | — |
| P15 | Every new task starts at the chain head and eats a known refusal first | medium | not fixed | — |
| P16 | Scheduler has no hold / "resume in-flight first" primitive | medium | worked around via draft/approve | — |
| P17 | Worker self-ran the full gate that the controller runs anyway → hit the turn limit | medium | template changed; not structural | — |
| P18 | `unclear` review = failed review for normal tasks → wasted rework turns | medium | not fixed | — |
| P19 | An unparsable task file is dropped silently; a run continues on a smaller board | medium | not fixed | — |
| P20 | Production and tests share one workspace registry; a hand edit broke 83 tests | medium | not fixed | — |
| P21 | No preflight: no way to validate config / models / board before a run | medium | not fixed | — |
| P22 | `taskctl note` takes its four long fields only on the command line | low | not fixed | — |
| P23 | No graceful stop (drain); stopping a run means killing it | medium | not fixed | — |
| P24 | Shells left behind by an interrupted session cannot be reaped | medium | not fixed | — |
| P25 | A retry loses the whole session context | medium | not fixed | — |
| P26 | No token / quota visibility per model | low | not fixed | — |
| P27 | Agent commits use the global git identity; no commit hygiene guard | medium | project-side scan only | — |
| P28 | 3 pre-existing `tsc` errors mask new ones | low | not fixed | — |

What worked well is in section 5; what is still unverified is in section 6.

---

## 1. Problems, one by one

Format: what happened → evidence → root cause → what was changed → what is still advisable.

### A. Model chain and dispatch

#### P01 — No budget guard (billing incident)
- **What happened.** The first board reused a model chain copied from an older project's config: a
  pay-per-token GLM endpoint as worker and a pay-per-token DeepSeek as reviewer. Six tasks ran that
  way before anyone looked, while every coding-plan model on the same machine was available at
  zero cost.
- **Root cause.** Nothing validates a config against the current price list, and the cost of a
  model is not shown anywhere at launch. Copying a config is the natural thing to do.
- **Changed.** Nothing in task-manager. The project switched its config by hand and recorded the
  rule "verify the current model list and its cost fields before every launch".
- **Advisable.** A hard guard: `allowedProviders` and/or `maxCostPerMillion` in the config; at
  `taskctl run` start, resolve every chain model through `model.list`, print its cost and variant
  availability, and refuse to start on a violation. Plus a cumulative token/cost line in
  `status` and `report` (see P26).

#### P02 — Effort variant invented
- **What happened.** One task died 0.5 s after being claimed:
  `provider.no-route: Variant unavailable for …/MiniMax-M3.1-Flash: high`.
- **Root cause.** The adapter appended `#<effort>` unconditionally. An effort is a *provider
  variant*; it exists only when the provider publishes it, and that model publishes none.
- **Changed (4645f93).** `resolveModel()` reads the published variants from `model.list` and asks
  only for one that exists; an unknown model keeps the old behaviour.
- **Advisable.** Resolve the whole chain once at run start and cache it (today every turn spawns a
  `model.list` call); show each chain model's availability in `status`; make it part of
  `taskctl doctor` (P21).

#### P03 — Provider refusal classified as "uncertain"
- **What happened.** Three worker turns in a row ended as
  `shutdown unconfirmed; automatic retry prohibited`. The board was parked. The model-chain
  fallback existed but was never reached, not once.
- **Root cause.** `execution.ts` turned *any* non-zero exit into `uncertain`, and `controlled()`
  then refused to retry. Unrecognised refusal shapes — no-route, variant unavailable, model not
  found, 403, overloaded, and the rate-limit that a provider reports inside its own `retry` event —
  all fell into that path. The model was only rate-limiting.
- **Changed (4645f93).** `PROVIDER_REJECTION` widened; `retry` events count as refusal signals;
  an uncertain turn now carries the CLI's last output including stderr. Four regression tests.
  Proven in the field afterwards: a 5-hour quota refusal rotated the turn to the next model and
  two tasks completed that way.
- **Advisable.** Make exit-cause classification explicit and configurable: an enum
  (`provider-refusal`, `model-error`, `tool-or-environment`, `timeout`, `unknown`), a rule table
  keyed on event type, stderr pattern and exit code, and the classification plus its evidence
  recorded in `attempt.json`. Give `model-error` and `tool-or-environment` their own retry policies
  instead of one budget for everything.

#### P04 — Linear chain
- **What happened.** `rotateModel` returned `null` at the tail, the task parked, and a recovered
  head was never tried again; a rerun started from the tail.
- **Changed (e38b0b2).** `chainCycles`: the chain wraps to its head up to N times; a new attempt
  keeps its position but gets a fresh wrap budget; the park note names every model's refusal and
  says an owner decision is required.
- **Advisable.** A board-level cooldown table (P15) is the better half of this fix. Note: the
  cyclic path never fired in a real run during this project — only its unit tests cover it.

#### P05 — Config key missing from the allowlist
- **What happened.** `taskctl: config …: unknown field "chainCycles"` on the first real command
  that loaded the new config. A run launched with it would have died before claiming anything.
- **Root cause.** `resolveConfig` has a hand-maintained allowlist (`CONFIG_KEYS`) next to the
  parser; the feature added the parse line and not the allowlist entry. 406 unit tests were green
  because the new tests hand a `WorkerConfig` to `runTask` and never pass through `resolveConfig`.
  A second bug sat beside it: `integer()` insists on a positive value, so the documented setting
  `chainCycles: 0` was rejected too.
- **Changed (38edd68).** Allowlist entry; a non-negative integer parser; a structural test that
  every key `resolveConfig` returns is a key it accepts (verified by mutation: removing the entry
  fails it with the production cause spelled out).
- **Advisable.** One source of truth for the config schema (derive the allowlist from the parser,
  or adopt a schema library); a smoke test that runs the real CLI against a real config file;
  print the effective config at `run` start.

### B. Cancellation, timeouts, zombie agents

#### P08 — Killing the client does not stop the agent
- **What happened.** Two turns were cut at *exactly* the 2 h turn limit (10:04:32 → 12:04:33 and
  12:45:18 → 14:45:19). Both ended `shutdown unconfirmed` and parked the task. Afterwards the
  opencode service still showed those sessions executing tools.
- **Root cause.** `opencode run` is a client of a background service and the agent loop lives on
  the service. The adapter's cancel only ran `taskkill /T /F` on the client; it never asked the
  service to stop the session. The comment in `execution.ts` was right ("killing a CLI is not
  evidence that a backend session stopped") and nothing closed the gap, so every timeout became an
  incident.
- **Changed (40c39d2).** On cancel the adapter sends `session.interrupt` to the session it observed
  in the event stream, in parallel with the tree kill. The service's acknowledgement
  (`{"interrupted":true|false}`, sent bare, without the envelope the other calls use) is the only
  thing that counts as confirmation; without it the cancel stays uncertain as before. A client
  that exits by itself once its session is interrupted leaves `taskkill` nothing to kill, which
  now counts as stopped. The exit handler no longer overrides a confirmed backend whichever event
  arrives first. The worker's cancel race grew from 2 s to 8 s. When the client is already gone
  the interrupt is still attempted for its side effect. A confirmed timeout now takes the existing
  "shutdown confirmed → failed turn → retry" path instead of parking.
- **Found only by running it for real.** The unit double wrapped the interrupt reply in an
  envelope the real service never sends, and no unit test produced the shape "client leaves by
  itself". Both are covered now; the path was verified against the real service before commit.
- **Advisable.** See R1, R2, R4, R5 below. The acceptance path (P11) still has the old semantics.

#### P09 — A manual kill left a zombie for five hours
- **What happened.** To swap the model chain, the operator killed the orchestrator's process tree
  at 17:56 and considered the board stopped. The worker session kept running on the service until
  22:10: 88 tool calls, among them 3 file edits and 8 writes between 18:44 and 18:50, while another
  live session was editing the same work tree. The "gate ran twice", "two test runs in parallel"
  and "handoff notes out of order" oddities of that evening are all this one zombie.
- **Root cause.** P08 plus a manual procedure with no tool behind it.
- **Changed.** Outside task-manager: the recovery script now interrupts first; the rule is in the
  project's ledger and in the global memory file.
- **Advisable.** `taskctl stop` / `taskctl recover` (R1) and a sweep at `run` start (R2).

#### P10 — Recovery is an 8-step manual procedure
- **What happened.** ADR-0007 says an uncertain execution is never retried automatically. That
  principle is right — it is what keeps a half-finished side effect from being replayed — but the
  only way back was by hand: read `attempt.json` for the session id and interrupt it; archive
  `attempt.json` and `lock.json`; edit the shared registry file to release the reservation; delete
  the marker directory; kill leftover test/build/shell processes; `taskctl retry`; write a takeover
  note; restart the run. Eight times, fourteen task-recoveries.
- **`reconcile` is diagnosis only.** It tells you a reservation is held; `retry` refuses while the
  attempt is not settled. Nothing releases a reservation for you.
- **Hand-recovery is itself error-prone.** Two operator mistakes happened inside this procedure:
  a `ConvertTo-Json -AsArray` double-wrapped the registry array (`Invalid workspace registry
  record`, 83 tests red for about six minutes), and a bulk edit of task files corrupted six of
  them. Both were fixed, and both would not have existed if the procedure were one command.
- **Advisable.** R1.

#### P11 — Acceptance timeout treated as an uncertain execution
- **What happened.** One task's acceptance gate hit `acceptanceTimeoutMs` (30 min) three times in
  a row: `acceptance failed (exit null)` twice, then
  `blocked acceptance: shutdown unconfirmed; automatic retry prohibited`.
- **Root cause, layer 1.** The suite had grown past 30 min (20 min two tasks earlier; 30–50 min
  now). The timeout was never revisited as the project grew.
- **Root cause, layer 2 (inferred, not captured live).** The acceptance process is spawned as
  `cmd → pwsh → MSBuild/Test.exe`; its result resolves on `close`, i.e. when the stdio pipes close,
  and the cancel confirmation requires `closed` within 500 ms. Grandchildren that inherited the
  handles keep the pipes open, so whether a timed-out gate counts as "failed" or "unconfirmed"
  depends on timing.
- **Changed.** Config only: the timeout went to 90 min and the gate passed at about 42 min.
- **Advisable.** R5; and a timeout message that says what to do ("the gate needs longer than X;
  last successful run took Y") instead of parking.

#### P12 — Captured output thrown away on timeout
- **What happened.** After a 30-minute timeout the acceptance record's `output` was 36 characters:
  `acceptance timed out after 1800000ms`. Nothing showed how far the gate had got.
- **Root cause.** `acceptance.ts` decodes its buffers only when `close` fires; on a cancel that
  never happens.
- **Advisable.** Resolve with the partial output on cancellation.

#### P13 — Identical-failure counter survives `retry`
- **What happened.** The failure fingerprint that parks a task after N identical acceptance
  failures is kept across `retry` by design. Sound against "retry until it passes"; a trap when
  the failure was infrastructure and has been fixed: the next identical failure parks immediately.
  The worker on that task predicted this in its own handoff note.
- **Advisable.** `taskctl retry --reset-failures`, or reset automatically when the recorded failure
  was a timeout/infrastructure class.

#### P14 — Collateral blocking
- **What happened.** While the uncertain acceptance held the work tree's reservation, the next
  task was parked with `workspace reserved by another or uncertain execution; reconcile before
  retry` and needed its own recovery.
- **Advisable.** Reopen collateral tasks automatically when the owner is recovered, or leave them
  `open` and simply not runnable until the resource frees.

#### P17 — The worker ran the gate the controller runs anyway
- **What happened.** Task books said "run the acceptance script when done". Workers did — one of
  them under a debugger, several in parallel — and the controller then ran the same gate. That is
  where the 2 h turn limit came from (P08). One worker measured its Debug gate at over an hour;
  the controller's Release gate took 20 minutes.
- **Changed.** Task template: state what self-verification is allowed (targeted subsets, a bound
  per command) and that the controller owns the full gate.
- **Advisable.** Make it structural: separate template fields for "worker self-check command" and
  "acceptance command"; a per-command time bound through the agent's own configuration; and an
  early hand-off before the turn budget runs out (R4).

#### P23 — No graceful stop
- **What happened.** There is no way to stop a run without killing it, and killing it is P09.
- **Advisable.** A drain mode: stop claiming, let the running turn reach a safe point, ask the
  worker for a hand-off note, exit.

#### P24 — Leftover shells
- **What happened.** After an interrupt the session's running tool kept going: a 9 GB test process,
  and a 55-minute `Wait-Process` loop. They hang off the service's pty daemon, not off the client,
  so no tree kill reaches them.
- **Advisable.** Reap a session's background tasks through the service's own API after an
  interrupt, or constrain the worker's whole tree with a Windows Job Object.

#### P25 — Retry loses the context
- **What happened.** Every manual retry started a session from zero; one task lost about an hour of
  reading twice. The periodic hand-off notes are hand-written by the worker.
- **Advisable.** Resume the previous session with `--session` when the same model continues; and
  the early hand-off of R4.

### C. Evidence and review

#### P06 — Review prompt in argv
- **What happened.** A review spawn died with ENAMETOOLONG after the work had already succeeded:
  a 45 KB acceptance log was passed in argv, over Windows' 32 K command-line limit.
- **Changed (80b2091).** Head-and-tail clipping (18 K acceptance, 8 K hand-off, 4 K journal) with a
  visible marker, plus a 28 K backstop in the adapter.
- **Advisable.** Stop passing long text in argv at all (R6).

#### P07 — Clipped evidence → `unclear`
- **What happened.** A red-line task's acceptance output was 126,074 characters; the prompt carried
  18 K; 108 K went missing in the middle, and with them the evidence for four of five criteria.
  The reviewer returned `unclear` — correctly, under its own rules ("judge only on the material
  in front of you", "when evidence is insufficient return unclear", "do not ask for extra
  material"). Nobody had told it where the rest was.
- **Changed (7daa9db).** When the clipped view actually lost something the prompt gives the path
  of the complete acceptance record and authorises reading it; rule 13 makes clear that reading
  the named file is not asking for extra material; a short log gets no pointer. Verified against
  the real service: an agent session whose cwd is the repository read the record that lives in the
  task directory outside it, and found a test name that exists only in the omitted middle.
- **Advisable.** R6 (structural) and R11 (what an `unclear` should do).

#### P18 — `unclear` is a failed review for a normal task
- **What happened.** On red-line tasks an `unclear` reaches a human, who settles it. On a
  normal-risk task it counts as a failed review and spends a worker rework turn for a problem in
  the evidence, not in the work. Two early tasks were saved from that only by the operator
  overruling the verdict.
- **Advisable.** R11.

### D. Scheduling and board management

#### P15 — Every task starts at the chain head
- **What happened.** The rotation is per task (`models.json` in the task directory). The chain
  head was known to be refusing (a 5-hour quota), and each new task still started there and spent
  about 90 seconds on the refusal before rotating — three tasks in a row.
- **Advisable.** R7.

#### P16 — No hold primitive
- **What happened.** `ready()` takes every open task whose dependencies are done, in filename
  order. While one task sat half-done with a dirty work tree, three others were ready; the only
  way to keep them from being claimed first was to set them to `draft` and `approve` them later —
  a command meant for something else.
- **Advisable.** R8.

#### P19 — An unparsable task file disappears silently
- **What happened.** After the bulk-edit accident six task files began with a stray line.
  `scan()` treats a file whose frontmatter does not declare the schema as "not a task" and lists
  it once at the end of `status`. The board went from 17 to 12 rows.
- **What would have happened next (read from the scheduler code, not observed).** `run` calls the
  same `list()` and would have continued on the smaller board: tasks depending on the missing ones
  would never become ready and the run would have ended quietly.
- **Advisable.** `run` should fail fast when a file that looks like a task does not parse; `status`
  should put ignored files first, not last.

#### P21 — No preflight
- **What happened.** P02, P05 and P01 are all "this run could never have worked" errors, each
  discovered after a launch.
- **Advisable.** R9.

### E. Operations and hygiene

#### P20 — One registry for production and tests
- **What happened.** The workspace reservation registry lives in the system temp directory and is
  shared by production and by part of the test suite. A hand edit that broke its shape failed 83
  tests.
- **Advisable.** Force test isolation (an assertion that tests never touch the default registry);
  provide `taskctl workspace release` so nobody edits the file by hand.

#### P22 — `taskctl note` on the command line only
- **What happened.** The four long text fields can only be passed as arguments. The agent shell
  this operator runs in refuses long inline commands, so every note was written to a script file
  first.
- **Advisable.** `taskctl note --file <path>` with one Markdown section per field.

#### P26 — No token or quota visibility
- **What happened.** The coding plans have 5-hour and weekly limits. The only sign was a refusal;
  which model had how much headroom was unknown.
- **Advisable.** Sum tokens per model per run (`session.get` already reports them) in `status` and
  `report`; warn as a limit nears.

#### P27 — Identity and commit hygiene
- **What happened.** Agent commits take the global git identity — here an empty user name with a
  personal e-mail address. This repository's own public history had to be rewritten on 2026-11-17
  to scrub such an address, and a local identity (`taskctl <taskctl@local>`) was set afterwards.
  In the ported project the user then set a standing rule: no machine-absolute paths, no computer
  information, no API keys in commit messages or tracked files; machine paths belong in an
  untracked local config. A project-side scanner was written for it and made part of the
  delivery gate.
- **Advisable.** Build the guard in: a `gitIdentity` config applied to worker commits, and a
  commit guard (secrets + machine info) run before each commit or as an acceptance step.

#### P28 — Pre-existing type errors
- **What happened.** `npx tsc --noEmit` reports three old errors (`worker.ts`: a `review` return
  not in the result union; `workspace.ts`: a possibly-null identity, twice). Every change today had
  to be checked against them by eye to prove it added none.
- **Advisable.** Clear them and make `tsc` part of the test run.

---

## 2. Changes that landed

| Commit | What | Tests |
|---|---|---|
| 80b2091 | Clip oversized review evidence and argv prompts (18 K / 8 K / 4 K head+tail, 28 K adapter backstop) | 399/400 |
| 4645f93 | Variant-aware `resolveModel`; wider `PROVIDER_REJECTION`; `retry` events count; stderr tail on uncertain turns | 403/403 |
| e38b0b2 | `chainCycles`: cyclic model chain with a wrap budget; owner-decision park note | 406/406 |
| 38edd68 | `chainCycles` accepted by the config allowlist, zero included; structural allowlist test | 409/410 |
| 40c39d2 | `session.interrupt` on cancel; acknowledgement as confirmation; taskkill "not found" is a stop; exit-handler race; cancel race 2 s → 8 s | 413/414 |
| 7daa9db | Review prompt points at the complete acceptance log when the clipped view lost something; rule 13 | 416/417 |

Pattern worth keeping: every fix that touches an integration path was run against the real
service or the real config before commit, and each time that found something the unit tests had
not (the envelope the double invented, the client that leaves by itself, the missing allowlist
entry).

---

## 3. Recommendations, by priority

**P0 — stops the class of incident**

- **R1 One-command recovery.** `taskctl recover <id> [--retry]`: interrupt the session named in
  `attempt.json`; archive `attempt.json`, `lock.json`, `acceptance.json`, `review.json`; release
  the reservation and the marker through the API, never by editing the registry; list leftover
  processes that belong to the attempt. `reconcile` should print exactly this command. Closes P09,
  P10. Acceptance: a blocked task with a live server-side session is recovered with one command
  and the session is no longer executing afterwards.
- **R2 Sweep at run start.** Before claiming, look for attempt records left by earlier runs and
  interrupt any session still executing; report leftover test/build processes; validate the
  registry. Closes the "previous run was killed" case. Acceptance: a killed run leaves nothing
  running after the next `taskctl run` starts.
- **R3 Budget guard and model preflight.** `allowedProviders` / `maxCostPerMillion`; at start,
  resolve every chain model, print cost and variant availability, refuse on a violation. Closes
  P01 and the launch-time half of P02.
- **R4 Early hand-off.** At 85–90 % of `turnTimeoutMs` give the worker a wind-down turn that
  writes a hand-off note, the way the context budget already does. A timeout becomes a planned
  session change, not an incident. Closes the remaining half of P08/P17/P25.
- **R5 One cancellation semantics for every execution.** The acceptance path still confirms a
  kill by waiting for stdio `close`; confirm on process exit plus the kill result instead, keep the
  partial output, and record a timeout as a failed gate with guidance rather than as an uncertain
  execution. Closes P11, P12.

**P1 — removes a recurring cost**

- **R6 Prompts through files, evidence structured.** Write the review prompt to a file and hand
  the CLI a path; replace the raw acceptance log by a per-case summary (name, PASS/FAIL, the
  tolerance lines) next to the path of the full log. Closes P06 and P07 structurally.
- **R7 Board-level model cooldown.** Model → refusal time and reason, shared across tasks;
  `modelFor` skips a model inside its cooldown and re-probes it when the window ends. Closes P15
  and completes P04.
- **R8 Hold / release and in-flight priority.** `taskctl hold <id>`, `taskctl release <id>` (or
  `--only` / `--exclude` on `run`); a task with an unfinished attempt is claimed first. Closes P16.
- **R9 `taskctl doctor`.** Config schema, chain resolution, acceptance command present, board
  parses and is acyclic, registry healthy, no leftover sessions or processes, timeout settings
  against the last measured gate duration. Closes P21.
- **R10 Schema single source, real-config smoke test, tsc clean.** Closes P05 for good and P28.
- **R17 Template split.** "Worker self-check" and "acceptance" as separate template fields; the
  prompt states the bound. Closes P17 structurally.

**P2 — quality of life**

- **R11 `unclear` is not a failed review.** Second opinion from another reviewer model, then a
  question to the operator; never a worker rework turn on a normal-risk task. Closes P07's tail
  and P18.
- **R12 `taskctl note --file`.** Closes P22.
- **R13 `taskctl workspace release`.** Closes the operational half of P20.
- **R14 Reset the failure counter on request** (`retry --reset-failures`, or automatically for a
  timeout class). Closes P13.
- **R15 Auto-reopen collateral tasks** when their resource owner is recovered. Closes P14.
- **R16 Fail fast on an unparsable task file at `run` start.** Closes P19.
- **R18 Drain mode.** Closes P23.
- **R19 Reap a session's background tasks after an interrupt.** Closes P24.
- **R20 Resume the session on a same-model retry.** Closes P25 (with R4).
- **R21 Token and cost summary per model per run.** Closes P26.
- **R22 Git identity and a commit guard built in.** Closes P27.
- **R23 Test isolation for the shared registry.** Closes P20.

---

## 4. Timeline of the incidents

| When (local) | Run | What |
|---|---|---|
| 11-23 morning | 1–3 | Six tasks on pay-per-token models (P01); found by hand, run 3 stopped |
| 11-23 afternoon | 3–6 | Three turns "shutdown unconfirmed" (P03); review spawn ENAMETOOLONG (P06) |
| 11-23 14:44 / 14:01 | — | 4645f93 and 80b2091 |
| 11-23 afternoon | 7 | A task dies 0.5 s after claim (P02); board reset by hand |
| 11-23 evening | 8 | First field proof of the fallback: quota refusal → next model, task done |
| 11-23 16:43 / 18:03 | — | e38b0b2, then 38edd68 after the first real CLI call failed (P05) |
| 11-23 17:56 | 8 | Orchestrator killed by hand; a zombie runs until 22:10 (P09) |
| 11-23 20:04 | 9 | Turn cut at exactly 2 h (P08) |
| 11-23 23:07 | — | 40c39d2, verified against the real service |
| 11-24 00:12 → 05:06 | 12 | Acceptance gate times out three times (P11); sibling parked (P14) |
| 11-24 08:19 | — | 014 reviewed `unclear` on clipped evidence (P07); 7daa9db at 08:24 |
| 11-24 09:20 | — | Remaining tasks moved to a single session; taskctl no longer drives the project |

---

## 5. What worked

- **ADR-0007's caution is right.** Not replaying an uncertain execution is what stands between a
  crash and a duplicated side effect. The fix was to make executions confirmable, not to retry
  more.
- **The evidence trail is complete.** Every root cause above was proven from records the tool
  already keeps — `journal.md`, `attempt.json` with the session id and the last output,
  `acceptance.json`, `review.json` with per-criterion evidence, the run log. Keep that property.
- **The red-line gate and tolerated external changes.** `risk: high` → awaiting-human, and the
  reviewer's `externalChanges` list, are what let a human settle three `unclear` verdicts in
  minutes with a named reason.
- **Markdown is the task.** No separate registry: hand repair of the board is a text edit.
- **The fallback works.** After 4645f93 a quota refusal cost one turn and nothing else.

---

## 6. Not verified, or inferred

- The cyclic chain (`chainCycles`) never fired in a real run; only unit tests cover it.
- 40c39d2 was verified on the real service for the cancel itself; no real run has gone through a
  full 2 h timeout with it yet.
- P11's "confirmation depends on pipes held by grandchildren" is read from the code; no live
  handle snapshot was taken.
- P19's "a run continues on a smaller board" is read from the scheduler code; it was not observed.
- That a reviewer session may read files outside the repository was verified only under this
  machine's default permission configuration.
- All of today's commits are local and unpushed.
