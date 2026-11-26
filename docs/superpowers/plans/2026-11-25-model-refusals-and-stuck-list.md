# Model Refusals, Rounds and the Stuck List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace "a refusal blocks the task" with "a refusal switches models, a fully refused round defers the task, and after `modelRounds` the run either holds that one task or stops for an outage", and give the owner one command that says which tasks are stuck and why.

**Architecture:** A new `src/model-wait.ts` owns the deferral record `tasks/<id>/model-wait.json` and a per-run context that counts rounds and remembers every accepted turn as evidence. A new `src/guard-refusals.ts` owns the board's record of a budget-guard refusal, `.taskctl/guard-refusals.json`. `src/worker.ts` replaces `blockForCooldown` / `blockForQuota` with one round logic for both stages; an attempt that runs out of rounds only records that it did, and the controller takes the decision — the task's own problem, or an outage — once no attempt is in flight. The three schedulers keep the budget guard's handling of its `refused` outcome and exclude deferred tasks beside it, and `run` waits for the nearest window. `src/cli.ts` turns an outage into a report and exit code 3, and adds `status --stuck`.

**Tech Stack:** TypeScript (NodeNext, strict), Node.js 22, Vitest; no new dependencies.

- Markdown task files are the source of truth (ADR-0001); a reviewer is always a fresh session; no new runtime dependency; the CLI stays hand-rolled.
- Every runtime change follows the repository's protocol: a regression that fails first, the fix, directed mutations that the tests kill, documentation kept in step.
- A run against the real backend needs the owner's explicit authorization.
- The adapter's assumptions were verified against opencode 2.4.1. Another machine may run a newer version; before any live run there, `opencode run --format json` events, `session.get`, `session.message.list` and `model.list` are checked again.
- `modelCooldownMs` defaults to 60 seconds; `modelRounds` defaults to 4; `modelRounds` is a positive integer.
- A round is one pass over the chain: each model is tried once, and a refusal moves to the next model at once. Every round starts at the head of the chain.
- A provider refusal never by itself costs a task a retry or the status `blocked` (G1).
- A refusal is what the adapter reports as a provider failure (`failure === "provider"`), whether or not the turn had already done work. A turn that ran and failed for any other reason keeps today's handling.
- **The budget guard's refusal is not that refusal.** The outcome `refused` (ADR-0012, `src/budget.ts`) means no session started and no model was asked. It starts no round, writes no deferral, and is evidence neither for an outage nor against one. Nothing of the guard's is replaced, and its handling stays intact in each scheduler: the `refused` set of `runScheduler`, the `refusedAt` map and the `cooling` test of `scheduleOnce` (`REFUSED_RETRY_MS`), the stop on `refused` of `runBatch`, the exit code 1 of `run`, and `taskctl models`. In each scheduler a deferral is a second exclusion beside it.
- The system never adds a model to a chain and never selects a model that is not in the configured chain (G5). It never dispatches on a model the guard has not allowed. Telling the owner that a model may be billed is the guard's verdict line, so there is no plan notice and no `modelPlan` key.
- No new task status: "on hold" is `blocked` with a reason.
- `taskctl status` and `taskctl board` keep their output.
- The deferral record is outside the definition digest (`definitionFields`, `src/runtime.ts:82-112`) and outside the acceptance drift digest. The guard's record lives in `.taskctl/`, never in a task's directory: a refusal before the claim writes nothing there, and that guarantee is what the record must keep (ADR-0012).
- Every file replace goes through `renameWithRetry` (`src/replace.ts`); `tests/replace.test.ts:234-254` fails on a bare `await rename(` in `src/*.ts`.
- `tests/protocol.test.ts` pins the worker prompt byte for byte: `buildWorkerPrompt` is not touched.
- Exit codes. `0` finished (also when tasks ended `blocked` or `awaiting-human`); `1` a runtime error, a task blocked by a controller error, or tasks the budget guard refused (ADR-0012: `tests/budget-guard.test.ts`, "run exits 1 when a task was refused"); `2` a usage error; `3` a stop for an outage (design §7). A run that stopped for an outage exits 3 whatever else happened in it — tasks the guard refused, a task `blocked` by a controller error — and the guard's lines and the controller errors are printed beside the report. `watch` still returns 0 after a guard refusal, as it does today.
- Offline gates: `npm test`, `npm run typecheck`, `npx tsc --noEmit`, `git diff --check`, the two smoke scripts in offline mode. `npm run typecheck` also checks `tests/`, so every test double a task adds must satisfy its interface.
- Do not commit `.codegraph/`. Parts 2 to 4 of the spec (§9 stop, §11 escalation feedback, §12 the lane) are out of scope.
- Line numbers in this plan are as of commit `c8e604f`. Every edit names the text it anchors on as well as its line, because earlier tasks shift the line numbers of later ones.

## Review Focus

1. **A success that a later refusal overwrote in the shared table.** `noteModelRefusal` replaces a model's entry (`src/model-cooldown.ts:52`), so with two refused tasks and one served task the table shows only refusals. Read from the table alone, the run stops for a false outage — the anti-goal "a run stopped for an outage when the model was serving other tasks". Pinned by Task 5, "a success that later refusals overwrote in the shared table is still evidence".
2. **An `open` task that carries preserved evidence going back through the worker.** After a refused review the task is `open`; if the next claim runs the worker again, every side effect of a non-idempotent task happens twice. Pinned by Task 6, "the next claim after the window resumes the review by itself, without the worker or the acceptance" and "an open task that carries preserved evidence is never sent back through the worker, whoever wrote the record".
3. **A deferred task at the head of the queue.** Watch never skips an ineligible head, and an explicit batch rejects one; a deferral would stall every later task for minutes. Pinned by Task 8, "a deferred task at the head of the queue does not hold the rest of the board" and Task 9, "refuses a selection that names a deferred task before any claim".
4. **A boolean flag missing from `BOOLEAN_FLAGS`.** `--stuck` would be read as a value flag and exit 2, as `--resume` once did. Pinned by Task 12, "runs through the real parser as a boolean flag", which calls `runCli`, not the parser's internals.
5. **A key that is parsed but missing from the allowlist.** Every command would refuse the config that carries it, as `chainCycles` once did. Pinned by Task 3, "every command still accepts a config that carries the new key", which goes through `taskctl retry --config`.
6. **The decision taken too early.** With `parallel` above one, another task's turn can be running on a chain model when one task runs out of rounds. An attempt that decided there and then would report an outage while the model was serving that other task. The decision is the controller's, taken once no attempt is in flight. Pinned by Task 5, "waits for the attempt in flight: a task served after the round that ran out is still evidence" and Task 7, "never reports an outage while another task is being served".
7. **A provider refusal confused with the guard's.** Since the merge both are called a refusal. A guard refusal counted as a round would hold a task as its own problem although no model was ever asked. pinned by Task 7, "leaves a task the budget guard refused out of the wait and the decision" and Task 11, "a task the budget guard refused is not in the waiting list of the outage report".
8. **The guard's record written into the task's directory.** It would break the guarantee a refusal is built on. Pinned by Task 11, "is written when the guard refuses a task, and nothing is written into the task's directory".
9. **A cooling pass that waits a whole window.** When every model is already cooling, the next time is the earliest expiry among the chain's windows (`ModelsCoolingError.retryAfter`), not the end of the pass plus the window: the second would keep the run idle for up to a window after every model is free again. Pinned by Task 4, "waits only until the earliest expiry when every model is already cooling".
10. **The provider's reason lost at the review stage.** `startReview` (`src/review.ts`) keeps a refused review turn's session id and a degraded verdict, not the backend's text, so the report of §7 would name every reviewer model with `review turn failed with exit 1`. Pinned by Task 6, "carries the backend's text of a provider refusal, its first line and no more than 240 characters" and "walks the reviewer chain, and a fully refused round defers with the evidence preserved", and Task 7, "names each reviewer model's reason from the record, as it names each worker model's".
11. **A `retry --review-only` that a deferral holds says nothing.** The claim path answers `skipped`, which the command prints as "refused or still unavailable": the owner cannot tell a window still open from a record gone. Pinned by Task 6, "a retry --review-only asked for inside the window is not run, and says until when".
12. **A manual `retry` that asks the models again at once, or never offers the task again.** Archiving the deferral offers the task the moment it is reopened, a moment after every model refused it; keeping its spent rounds makes a `watch` that is still running hold the task as spent for good. Pinned by Task 13, "keeps the earliest time of a deferral, starts its rounds again, and leaves the shared table alone" and "offers a task the owner retried by hand again after its recorded time, from round 0, and does not block it again at once".
13. **The owner told to wait for attempts that are not running.** After a run stopped for an outage nothing is in flight, and a spent deferral that still reads "waiting for the attempts in flight" sends the owner to wait for no one. Pinned by Task 12, "shows a deferred task's round and next time, and a spent one" and "says a spent deferral is waiting for the attempts in flight while a controller is running".

## Decisions

Where the spec is silent, or this plan deviates from the author's guidance, the decision below is what the tasks build.

- **Evidence is what the run itself recorded** (design §4, §6 step 5). The run keeps `accepted: Map<model, latest acceptance time>` in memory and asks whether any chain model was accepted after this task's first refusal. The shared table is never read for it: it holds one entry per model, the latest refusal, so a refusal by any task overwrites the entry a success had cleared. The table keeps exactly its documented role: a refused model is skipped within its window.
- **Every round starts at the head of the chain** (design §6). Today the rotation in `tasks/<id>/models.json` survives an attempt, so that a manual rerun does not retry a dead head first (`resetChainCycles`, `src/models.ts:226`). Under rounds that would leave only the tail of the chain to be tried again in rounds 2 to 4. The position is reset at the start of every round, in the worker's loop and in the review stage; within a window the shared table already keeps a just-refused model from being hit again.
- **A pass in which every model was already cooling is not a round** (design §6, step 3). The task itself was not refused, so nothing is counted; its next time is the earliest expiry among the chain's windows (`ModelsCoolingError.retryAfter`, which `nextModelCooldown` picks), never the end of the pass plus the window, so it is offered again as soon as the first model is free. Counting such passes would let a task that never got a turn be held as "its own problem".
- **Rounds are counted per run, and per stage** (design §16: the rounds of the review stage are counted anew, so a task can be deferred for `modelRounds` rounds as a worker and again as a reviewer). The record carries `runId` (the ISO start time of the run). A new `taskctl run`, `watch` or `retry` process is a new run. A caller that passes no run context shares one per process, so a task can never be deferred forever by a forgotten context.
- **"Accepted turn" means exactly what clears a model's cooldown today**: a worker turn with exit code 0 (`src/worker.ts:1131`) and a reviewer turn that is not a provider refusal (`src/worker.ts:1678-1679`). A timed-out or crashed turn is not evidence. With no chain configured the unnamed default model is one model, keyed `(default)`.
- **The decision is the controller's, not the attempt's** (design §6, step 5). An attempt whose round ran out of `modelRounds` only writes the record and returns `open`: nothing is `blocked`, nothing is declared. When a controller has no attempt in flight it calls `settleExhausted` for the tasks it just got back deferred; the evidence is read then, once per task, in the order the controller lists them, and the first outage ends the list and the run. `run` offers nothing more once one of its tasks has run out of rounds, and what is in flight settles first. `watch` and a batch are serial, so they decide as soon as the task comes back. Until then the stuck list shows the task as deferred: waiting for the attempts in flight while a controller is running, and waiting for the owner when none is (design §6, step 5; Task 12).
- **A reviewer crash does not park today.** The revised design's §16 says what the code does: only a timeout parks (`blocked` + `review-pending.json`); a crashed or unparseable reviewer turn is `verdict: unclear` and goes to `awaiting-human`. This plan changes neither path.
- **The reviewer chain is the worker chain whenever the reviewer's own chain is empty** (design §5, §16). The call is made in `reviewerChain` (`src/models.ts:111`), the one definition that the worker and the budget guard share, so the guard judges the chain the reviewer really walks. Two things follow, and the tests keep step with both: a reviewer with no chain of its own no longer runs on the backend's default, so the guard no longer judges that default for it; and the review starts on the first model of the inherited chain that is not cooling, so after the worker was refused on the head the review runs on the model that took over.
- **A manual `retry` keeps the deferral's earliest time and starts its rounds again** (design §6). `retryTask` only reopens `blocked` tasks (`src/reconcile.ts:178`), so the deferral it meets is the one the controller left when it held the task as its own problem. The record is not archived: its `nextAt` stays, and its round count and first-refusal time are cleared. A `watch` that is still running therefore offers the task after that time, from round 0, and the retry buys a fresh `modelRounds`. The shared table is not cleared either, so a model that has just refused is not hit again at once.
- **A `retry --review-only` that a deferral holds is not run, and says until when** (design §16). `retryCommand` asks what the claim path asks (`modelWaitHold`) before it calls `runTask`; while the answer is a window it prints the time and exits 1, because the recovery was asked for and not run. The design names the line and not the code: 1 is this plan's call.
- **An outage lets tasks already in flight settle** and offers nothing more. The evidence is read when nothing is in flight, so a turn that was still running when another task ran out of rounds has been counted by then.
- **`run --batch` does not wait for a window** (design §6). A task deferred in a batch stops the batch: the command prints when the task may run again and exits 0, since nothing is `blocked`. `watch` moves on to the later tasks and comes back. A task that ran out of rounds is decided in the batch at once, since nothing else is in flight there: an outage stops the batch with the report of §7 and exit 3 (design §7), a task held as its own problem stops it as `blocked`.
- **A deferral record that cannot be written ends the attempt as a controller error**, like a rotation that cannot be recorded. Swallowing it would offer the task again at once and hammer the models. A record that cannot be read is no deferral.
- **The guard's record is advisory, and is written where both judgements are reported.** `reportRefusal` (`src/worker.ts:262`) is the one place the two judgement paths of `runTask` go through, so it records every judgement with its time; the line is still said once per process. The entry leaves when both judgements let the task through, and a controller drops the entries of tasks that are no longer `open` at each of its passes. A record that cannot be written or read changes nothing, because the refusal and its line stand without it. It takes its own mutex, as the cooldown table does: only a watcher takes the watch lock (`acquireWatchLock`, `src/watch-lock.ts:27`), so two controllers can be alive on one board.
- **A refused wrap-up turn now notes the shared table.** Today that path (`src/worker.ts:1208-1213`) spends a retry and writes no entry.
- **A wait is visible.** Before `run` sleeps for a window it emits `model-wait` for the task whose window is nearest; the CLI prints it as `[<id>] model-wait waiting …`. The anti-goal is "a wait nobody can see".
- **A run that stopped for an outage exits 3, whatever else happened in it** (design §7, §17 item 3): tasks the guard refused, a task `blocked` by a controller error. The guard's lines and the controller errors are printed beside the report.
- **"A controller is running" is read off the board's locks.** `run` leaves no mark of its own; what the files hold is a live attempt, a task lock whose heartbeat is fresher than `lockTtlMs` (`lockLive`, `src/claim.ts`). So the stuck list says that a spent deferral waits for the attempts in flight while any task on the board has one, and that it waits for the owner when none does. That is exact for the two states a spent record is left in — a `run` draining its last attempts, and a run that stopped for an outage — because every controller decides as soon as nothing is in flight.
- **Wording.** The stuck list uses the Chinese labels `taskctl status` already uses (`等依赖`, `已阻塞`); the outage report is English like the `[scheduler]` and `[batch]` lines. Times are ISO strings.

## Mutation protocol (applies to every task)

Each task ends with a table of mutations: one reversed guard, the test that must fail. Perform them one at a time on the task's finished, uncommitted source.

```powershell
npx vitest run tests/<file>.ts                    # control, before: green
(Get-FileHash src/<file>).Hash                    # record: H0 (one per source file named in the table)
# apply ONE mutation with an edit; a "never" condition is the constant `if (false)`, never two clock reads compared
npx vitest run tests/<file>.ts                    # must be red on the case the table names, and on no other
# restore with the exact inverse edit
(Get-FileHash src/<file>).Hash                    # must equal H0
npx vitest run tests/<file>.ts                    # control, after: green
```

A round is void if a control run is not clean. A mutation that survives is a gap in the test: fix the test, not the threshold.

---

### Task 1: The deferral record, the run's identity and its evidence

**Files:**
- Create: `src/model-wait.ts`
- Test: `tests/model-wait.test.ts`

**Interfaces:**
- Consumes: `readRuntime`, `writeRuntime` (`src/runtime.ts:49-63`); `modelCooldown` (`src/model-cooldown.ts:22-28`).
- Produces:

```ts
export const MODEL_WAIT_FILE = "model-wait.json";
export const MODEL_ROUNDS_DEFAULT = 4;
export const MODEL_COOLDOWN_MS_DEFAULT = 60_000;
export const DEFAULT_MODEL_KEY = "(default)";

export type ModelWaitStage = "worker" | "review";
export type ModelRefusal = { model: string; at: string; reason: string; source: "turn" | "table" };
export type ModelWaitRecord = {
  runId: string;
  stage: ModelWaitStage;
  /** Rounds of this run in which this task itself was refused by every model it tried. */
  rounds: number;
  /** When this run's first refusal of this task happened; null while the task itself was never refused. */
  firstRefusedAt: string | null;
  /** The latest refusal of each model tried or skipped in the last round, in the order first tried. */
  refusals: ModelRefusal[];
  /** Earliest time at which the task may be claimed again. */
  nextAt: string;
  updatedAt: string;
};
export type ModelWaitHold = { kind: "window"; nextAt: string; rounds: number } | { kind: "exhausted"; rounds: number };
/** What one `run` / `watch` / `retry` process remembers across its tasks. */
export type RunContext = { id: string; accepted: Map<string, number> };
export type ModelWaitConfig = { tasksDir: string; run?: RunContext; modelRounds?: number };

export function newRunContext(now?: Date): RunContext;
export function processRun(): RunContext;
export const modelKey: (model: string | undefined) => string;
export function chainKeys(chain: readonly string[]): string[];
export function modelRoundsOf(cfg: { modelRounds?: number }): number;
export function modelCooldownMsOf(cfg: { modelCooldownMs?: number }): number;
export function refusalReason(result: { exitCode: number; text?: string; durationMs?: number }): string;
export function addRefusal(list: readonly ModelRefusal[], refusal: ModelRefusal): ModelRefusal[];
export function mergeRefusals(tried: readonly ModelRefusal[], cooling: readonly ModelRefusal[]): ModelRefusal[];
export function servedSince(run: RunContext, chain: readonly string[], since: number): string | null;
export function formatDuration(ms: number): string;
export async function coolingRefusals(tasksDir: string, chain: readonly string[], now?: Date): Promise<ModelRefusal[]>;
export async function readModelWait(tasksDir: string, id: string): Promise<ModelWaitRecord | null>;
export async function writeModelWait(tasksDir: string, id: string, record: ModelWaitRecord): Promise<void>;
export async function clearModelWait(tasksDir: string, id: string): Promise<void>;
export function modelWaitHold(record: ModelWaitRecord | null, runId: string, modelRounds: number, now: Date): ModelWaitHold | null;
export async function modelWaitHolds(cfg: ModelWaitConfig, ids: readonly string[], now?: Date): Promise<Map<string, ModelWaitHold>>;
```

- `modelWaitHold` answers, in this order: `exhausted` when `record.rounds >= modelRounds` and `record.runId === runId`; else `window` while `record.nextAt` is later than `now`; else `null`. `exhausted` is not a verdict: it only keeps the task from being offered between the attempt that ran out of rounds and the controller's decision (Task 5).
- `writeModelWait` creates the task directory when it is absent, then is `writeRuntime(tasksDir, id, MODEL_WAIT_FILE, record)`. `readModelWait` catches `SyntaxError` and returns `null`; it also returns `null` unless `runId`, `nextAt`, `updatedAt` are strings, `firstRefusedAt` is a string or null, `stage` is `worker` or `review`, `rounds` is a non-negative integer, and every refusal has a string `model`, `at`, `reason` and a `source` of `turn` or `table`.
- `servedSince` returns the first model of `chain` whose latest acceptance is strictly later than `since`, else `null`.

- [ ] **Step 1: Write the failing tests** in `tests/model-wait.test.ts`. Imports: `describe`, `expect`, `it` from `vitest`; `mkdir`, `mkdtemp`, `readFile`, `rm`, `writeFile` from `node:fs/promises`; `tmpdir` from `node:os`; `join` from `node:path`; `noteModelRefusal` from `../src/model-cooldown.js`; `definitionFields` from `../src/runtime.js`; `artifactDigest` from `../src/workspace.js`; `buildTaskFile` from `./helpers/task-fixture.js`; every name the interface block below exports from `../src/model-wait.js`. Shared fixture: `tasks`, `work` under a temp root, both created in `beforeEach`; `T0 = new Date("2026-11-25T10:00:00.000Z")`; `iso = (offsetMs) => new Date(T0.getTime() + offsetMs).toISOString()`; `refusal = (model: string, reason = model + " said no"): ModelRefusal => ({ model, at: iso(0), reason, source: "turn" })`; `record = (overrides: Partial<ModelWaitRecord> = {}): ModelWaitRecord => ({ runId: "run-a", stage: "worker", rounds: 1, firstRefusedAt: iso(0), refusals: [refusal("q/one")], nextAt: iso(60_000), updatedAt: iso(0), ...overrides })`.

```ts
describe("the deferral record", () => {
  it("round-trips through tasks/<id>/model-wait.json", async () => {
    await writeModelWait(tasks, "a", record());
    expect(JSON.parse(await readFile(join(tasks, "a", MODEL_WAIT_FILE), "utf8"))).toEqual(record());
    expect(await readModelWait(tasks, "a")).toEqual(record());
  });

  it("reads a missing, unparsable or malformed record as no deferral", async () => {
    expect(await readModelWait(tasks, "a")).toBeNull();
    await mkdir(join(tasks, "a"), { recursive: true });
    await writeFile(join(tasks, "a", MODEL_WAIT_FILE), "{ not json", "utf8");
    expect(await readModelWait(tasks, "a")).toBeNull();
    const malformed: unknown[] = [
      record({ rounds: -1 }), record({ nextAt: 7 as unknown as string }), { ...record(), refusals: "x" },
      { ...record(), refusals: [{ model: "q/one" }] }, record({ stage: "acceptance" as "worker" }),
      record({ firstRefusedAt: 0 as unknown as null }),
    ];
    for (const bad of malformed) {
      await writeFile(join(tasks, "a", MODEL_WAIT_FILE), JSON.stringify(bad), "utf8");
      expect(await readModelWait(tasks, "a")).toBeNull();
    }
  });

  it("is cleared without a trace, whether or not it exists", async () => {
    await writeModelWait(tasks, "a", record());
    await clearModelWait(tasks, "a");
    expect(await readModelWait(tasks, "a")).toBeNull();
    await expect(clearModelWait(tasks, "never-had-one")).resolves.toBeUndefined();
  });

  it("stays outside the definition digest and the acceptance drift digest", async () => {
    await writeFile(join(work, "deliverable.txt"), "the work", "utf8");
    const before = await artifactDigest(work, [tasks]);
    await writeModelWait(tasks, "a", record());
    expect(await artifactDigest(work, [tasks])).toBe(before);
    expect(Object.keys(definitionFields(buildTaskFile({ id: "a" }))).join(",")).not.toMatch(/wait/i);
  });
});

describe("what holds a task back", () => {
  const run = newRunContext(T0);

  it("holds nothing without a record", () => {
    expect(modelWaitHold(null, run.id, 4, T0)).toBeNull();
  });

  it("holds a task while its time lies in the future, whichever run wrote the record", () => {
    expect(modelWaitHold(record({ runId: "an-older-run" }), run.id, 4, T0))
      .toEqual({ kind: "window", nextAt: iso(60_000), rounds: 1 });
  });

  it("releases a task whose time has come", () => {
    expect(modelWaitHold(record(), run.id, 4, new Date(T0.getTime() + 60_000))).toBeNull();
  });

  it("keeps holding a task whose rounds are exhausted in the same run, time come or not", () => {
    const spent = record({ rounds: 4, runId: run.id });
    expect(modelWaitHold(spent, run.id, 4, T0)).toEqual({ kind: "exhausted", rounds: 4 });
    expect(modelWaitHold(spent, run.id, 4, new Date(T0.getTime() + 999_999))).toEqual({ kind: "exhausted", rounds: 4 });
  });

  it("lets another run start a spent deferral from round 0, after its window", () => {
    expect(modelWaitHold(record({ rounds: MODEL_ROUNDS_DEFAULT }), "another-run", 4, new Date(T0.getTime() + 60_000))).toBeNull();
    expect(modelWaitHold(record({ rounds: 4 }), "another-run", 4, T0)).toMatchObject({ kind: "window" });
  });

  it("lists the held tasks of a board, by id, and nothing else", async () => {
    await writeModelWait(tasks, "a", record());
    await writeModelWait(tasks, "b", record({ nextAt: iso(-1) }));
    await writeModelWait(tasks, "c", record({ rounds: 4, runId: run.id }));
    expect(await modelWaitHolds({ tasksDir: tasks, run, modelRounds: 4 }, ["a", "b", "c", "none"], T0)).toEqual(new Map([
      ["a", { kind: "window", nextAt: iso(60_000), rounds: 1 }],
      ["c", { kind: "exhausted", rounds: 4 }],
    ]));
  });
});

describe("the run's evidence", () => {
  it("is a new context per call, and one per process for callers that pass none", () => {
    expect(newRunContext(T0).id).toBe("2026-11-25T10:00:00.000Z");
    expect(newRunContext(T0)).not.toBe(newRunContext(T0));
    expect(processRun()).toBe(processRun());
  });

  it("names a chain model another turn was accepted on after the given time", () => {
    const run = newRunContext(T0);
    run.accepted.set("q/two", T0.getTime() + 5_000);
    expect(servedSince(run, ["q/one", "q/two"], T0.getTime())).toBe("q/two");
  });

  it("is not evidence when the acceptance came before, or on a model outside the chain", () => {
    const run = newRunContext(T0);
    run.accepted.set("q/one", T0.getTime());          // the same millisecond as the first refusal
    run.accepted.set("r/nine", T0.getTime() + 5_000); // another chain
    expect(servedSince(run, ["q/one", "q/two"], T0.getTime())).toBeNull();
  });

  it("keeps the latest acceptance of a model, so a later refusal cannot lose it", () => {
    const run = newRunContext(T0);
    run.accepted.set("q/one", T0.getTime() + 1_000);
    run.accepted.set("q/one", T0.getTime() + 9_000);
    expect(servedSince(run, ["q/one"], T0.getTime() + 5_000)).toBe("q/one");
  });

  it("reads the unnamed default model as one model", () => {
    expect(modelKey(undefined)).toBe(DEFAULT_MODEL_KEY);
    expect(chainKeys([])).toEqual([DEFAULT_MODEL_KEY]);
    expect(chainKeys(["q/one"])).toEqual(["q/one"]);
    const run = newRunContext(T0);
    run.accepted.set(DEFAULT_MODEL_KEY, T0.getTime() + 1);
    expect(servedSince(run, chainKeys([]), T0.getTime())).toBe(DEFAULT_MODEL_KEY);
  });
});

describe("the round's list of refusals", () => {
  it("keeps one refusal per model, the latest, in the order first tried", () => {
    const twice = addRefusal(addRefusal(addRefusal([], refusal("q/one", "first")), refusal("q/two")), refusal("q/one", "again"));
    expect(twice.map((entry) => [entry.model, entry.reason])).toEqual([["q/one", "again"], ["q/two", "q/two said no"]]);
  });

  it("puts what this task tried before the models that were already cooling", () => {
    const cooling: ModelRefusal = { model: "q/one", at: iso(-1), reason: "another task saw a 429", source: "table" };
    const merged = mergeRefusals([refusal("q/one")], [cooling, { ...cooling, model: "q/two" }]);
    expect(merged.map((entry) => [entry.model, entry.source])).toEqual([["q/one", "turn"], ["q/two", "table"]]);
  });

  it("reads a chain's active table entries as refusals and skips the rest", async () => {
    await noteModelRefusal(tasks, "q/one", { reason: "rate limited", cooldownMs: 60_000, now: T0 });
    await noteModelRefusal(tasks, "q/two", { reason: "long gone", cooldownMs: 1_000, now: T0 });
    // Judged two seconds later: q/two's one-second window has lapsed, q/one's has not.
    expect(await coolingRefusals(tasks, ["q/one", "q/two", "q/three"], new Date(T0.getTime() + 2_000)))
      .toEqual([{ model: "q/one", at: iso(0), reason: "rate limited", source: "table" }]);
  });

  it("says what a refused turn said, without naming the model twice", () => {
    expect(refusalReason({ exitCode: 1, text: "Error: weekly limit reached\nmore", durationMs: 240 }))
      .toBe("exit 1 in 240ms, Error: weekly limit reached");
    expect(refusalReason({ exitCode: 1, text: "  \n " })).toBe("exit 1, no output");
  });

  it("says how long a wait was, and names the defaults once", () => {
    expect(formatDuration(243_000)).toBe("4m 03s");
    expect(formatDuration(59_000)).toBe("59s");
    expect(formatDuration(0)).toBe("0s");
    expect(MODEL_ROUNDS_DEFAULT).toBe(4);
    expect(MODEL_COOLDOWN_MS_DEFAULT).toBe(60_000);
  });
});
```

- [ ] **Step 2: Run it and expect FAIL.** `npx vitest run tests/model-wait.test.ts` — every case fails at the import because `src/model-wait.ts` does not exist (vitest: `Failed to load url ../src/model-wait.js`).
- [ ] **Step 3: Implement `src/model-wait.ts`.** Signatures as above. Bodies the tests do not determine:
  - `newRunContext(now = new Date())` returns `{ id: now.toISOString(), accepted: new Map() }`. `processRun()` lazily creates one module-level context.
  - `modelRoundsOf` / `modelCooldownMsOf` return `cfg.modelRounds ?? MODEL_ROUNDS_DEFAULT` / `cfg.modelCooldownMs ?? MODEL_COOLDOWN_MS_DEFAULT`.
  - `refusalReason` is today's `refusalLine` (`src/worker.ts:874-877`) without the model prefix: the first non-empty trimmed line of `text` (or `no output`), cut to 240 characters, after `exit <code>` and, when `durationMs` is given, ` in <ms>ms`.
  - `addRefusal` replaces the same model's entry in place or appends. `mergeRefusals` is `tried` followed by every `cooling` entry whose model is not in `tried`.
  - `formatDuration`: whole seconds; below 60 `<s>s`; else `<m>m <ss>s` with the seconds padded to two.
  - `coolingRefusals` asks `modelCooldown(tasksDir, model, now)` for each model of the chain and maps an active entry to `{ model, at: entry.observedAt, reason: entry.reason, source: "table" }`.
  - `modelWaitHolds` reads each id's record with `Promise.all` and keeps the non-null holds.
- [ ] **Step 4: Run it and expect PASS.** `npx vitest run tests/model-wait.test.ts`, then `npm run typecheck`.
- [ ] **Step 5: Directed mutation check** on `src/model-wait.ts`.

| Mutation (one reversed guard) | Killed by |
| --- | --- |
| the window is ignored: the `nextAt` comparison becomes `if (false)` | holds a task while its time lies in the future… |
| a lapsed deferral still holds: `>` becomes `>=` | releases a task whose time has come |
| exhaustion is not checked: that branch becomes `if (false)` | keeps holding a task whose rounds are exhausted… |
| exhaustion forgets the run: `record.runId === runId` is dropped | lets another run start a spent deferral… |
| evidence ignores when: `accepted > since` becomes `>=` | is not evidence when the acceptance came before… |
| evidence ignores the chain: any accepted key is returned | is not evidence when the acceptance came before… |
| a malformed record is a deferral: validation returns the parsed object | reads a missing, unparsable or malformed record… |
| `addRefusal` appends instead of replacing | keeps one refusal per model… |
| `mergeRefusals` lets a cooling entry replace what the task tried | puts what this task tried before… |
| `coolingRefusals` reads expired entries from the raw table | reads a chain's active table entries… |
| `formatDuration` drops the minutes | says how long a wait was… |

- [ ] **Step 6: Commit.** `git add src/model-wait.ts tests/model-wait.test.ts` — `feat(model-wait): add the deferral record, the run's identity and its evidence`.

---

### Task 2: The reviewer chain is the worker chain when none is configured

**Files:**
- Modify: `src/models.ts` lines 105-113 (`reviewerChain`: its JSDoc and its body)
- Modify: `src/budget.ts` lines 166-169 (`reviewerModels`: its JSDoc line and its signature)
- Modify: `src/worker.ts` lines 280-281 (the first judgement, before the claim), lines 372-373 (the second, after the reservation), line 598 (`reviewerChain`)
- Modify: `README.md` lines 53 and 56 (the `reviewerModel` and `reviewerModelFallbacks` rows) and line 469 (the sentence in parentheses after `后端默认模型无法确认`)
- Test: Create `tests/reviewer-chain.test.ts`; Modify `tests/model-fallback.test.ts` (two new cases in `describe("reviewer model fallback")`; the fake reviewer tables at lines 134, 154, 187, 253, 265 and 293), `tests/budget-guard.test.ts` (one line, 370), `tests/cli-models.test.ts` (one case, lines 125-130)

**Interfaces:**
- Produces (`src/models.ts`): `reviewerChain` keeps its name and gains the worker's keys and the task:

```ts
/**
 * The chain the reviewer dispatches on: its own model, then its fallbacks,
 * when one is configured — never the task's or the worker's then. With no
 * reviewer model the chain is the worker's (`taskChain`), so a review that
 * inherits it starts at the task's own model. Review independence is a fresh
 * session, not a different model: the backend's default is never chosen on the
 * reviewer's behalf. One definition of it, for the worker and for the budget
 * guard.
 */
export function reviewerChain(
  cfg: { reviewerModel?: string; reviewerModelFallbacks?: string[]; model?: string; modelChain?: string[]; modelFallbacks?: string[] },
  task: { model?: string } = {},
): string[];
```

- Produces (`src/budget.ts`): `reviewerModels(cfg: WorkerConfig, task: Pick<Task, "model"> = { model: undefined })`, returning `unique(reviewerChain(cfg, task))`. The task is optional so `taskctl models` (`src/cli.ts:574`) goes on calling it with the configuration alone: a task's own model is listed there on its own.
- `src/worker.ts`: `reviewerModels(cfg, task)` at line 280 and `reviewerModels(cfg, task)` at line 281; `reviewerModels(r.cfg, r.task)` at lines 372 and 373; `const reviewerChain = (r: Run): string[] => configuredReviewerChain(r.cfg, r.task);` at line 598. `taskChain` (`src/models.ts:96-103`) is already the worker's chain, so nothing moves.

- [ ] **Step 1: Write the failing tests.**

`tests/reviewer-chain.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetGuardState } from "../src/budget.js";
import { reviewerChain, taskChain } from "../src/models.js";
import { runTask, type WorkerConfig, type WorkerDeps, type WorkerEvent } from "../src/worker.js";
import { adapterOf, CATALOGUE } from "./helpers/catalogue-fixture.js";
import { buildTaskFile } from "./helpers/task-fixture.js";

beforeEach(() => {
  resetGuardState();
});

describe("the reviewer's chain", () => {
  it("is the worker's chain when no reviewer model is configured", () => {
    expect(reviewerChain({ model: "w/one", modelFallbacks: ["w/two"] })).toEqual(["w/one", "w/two"]);
    expect(reviewerChain({ modelChain: ["c/one", "c/two"] })).toEqual(["c/one", "c/two"]);
    expect(reviewerChain({})).toEqual([]);
  });

  it("is the reviewer's own chain whenever one is configured", () => {
    expect(reviewerChain({ model: "w/one", reviewerModel: "r/one", reviewerModelFallbacks: ["r/two"] })).toEqual(["r/one", "r/two"]);
    // Fallbacks without a primary form no chain, so the worker's chain is used.
    expect(reviewerChain({ model: "w/one", reviewerModelFallbacks: ["r/two"] })).toEqual(["w/one"]);
  });

  it("starts at a task's own model when the reviewer inherits the worker's chain", () => {
    expect(taskChain({ model: "w/one", modelFallbacks: ["w/two"] }, { model: "t/special" })).toEqual(["t/special", "w/two"]);
    expect(reviewerChain({ model: "w/one", modelFallbacks: ["w/two"] }, { model: "t/special" })).toEqual(["t/special", "w/two"]);
  });
});

describe("the reviewer's chain and the budget guard", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "taskctl-reviewer-chain-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("is judged for a review-only recovery with the task's own model at its head", async () => {
    // The recovery runs the reviewer alone, on the chain the reviewer walks: here the task's paid model.
    const cfg: WorkerConfig = {
      tasksDir: join(root, "tasks"), workdir: root, agent: "opencode",
      contextThreshold: 0.8, retryLimit: 1, lockTtlMs: 5_000, heartbeatMs: 50,
    };
    const events: WorkerEvent[] = [];

    const outcome = await runTask(cfg, {
      store: { list: async () => { throw new Error("nothing is claimed on this path"); } } as unknown as WorkerDeps["store"],
      adapter: adapterOf(CATALOGUE, "plan/m"),
      onEvent: (event) => { events.push(event); },
    }, buildTaskFile({ id: "a", status: "blocked", model: "zen/p" }), "w", { reviewOnly: true });

    expect(outcome).toBe("refused");
    expect(events.find((event) => event.type === "refused")?.detail).toContain("- zen/p  provider=zen");
  });
});
```

In `tests/model-fallback.test.ts`, in `describe("reviewer model fallback")`, before the case "resolves reviewer variants before dispatch instead of appending effort blindly":

```ts
  it("runs the review on the worker chain when no reviewer model is configured", async () => {
    await seed();
    const models: string[] = [];
    const agent = adapter({ turns: { "w/one": "done" }, reviews: { "w/one": PASS_VERDICT } }, models);

    expect(await run(agent, [])).toBe("done");
    expect(models).toEqual(["w/one", "review:w/one"]);
  });

  it("reviews on the model that took over when the worker was refused on the head", async () => {
    await seed();
    const models: string[] = [];
    const agent = adapter({ turns: { "w/one": rejected("w/one"), "w/two": "done" }, reviews: { "w/two": PASS_VERDICT } }, models);

    expect(await run(agent, [], { modelFallbacks: ["w/two"] })).toBe("done");
    // w/one is cooling on the worker's own refusal, so the inherited chain is walked past it.
    expect(models.filter((model) => model.startsWith("review:"))).toEqual(["review:w/two"]);
  });

```

Then the fake reviewer tables of that file. The review no longer runs on `"(default)"`, but on the first model of the worker's chain that is not cooling when the review starts:

- lines 134 and 154 ("hands a rejected turn to the next model without spending a retry", "starts a new session for the model that takes over"): `reviews: { "(default)": PASS_VERDICT }` becomes `reviews: { "w/two": PASS_VERDICT }`. The worker was refused on `w/one` there, which puts `w/one` in the shared table, so the review runs on the model that took over.
- lines 187, 253, 265 and 293: it becomes `reviews: { "w/one": PASS_VERDICT }`. The worker runs on `w/one` and nothing is cooling.
- line 302 (`seed(null)`, no configured model) stays on `"(default)"`.

`tests/budget-guard.test.ts`, one line, in "asks for the catalogue in the directory the session runs in": line 370, `const config = cfg({ model: "plan/m" });`, becomes `const config = cfg({ model: undefined });`. The case asks the backend's default; today it is asked for a reviewer with no chain of its own, and after this task there is no such reviewer. With no model configured both roles run on the default, and the case says what it always said: each read is asked in the directory the session runs in. Every other case of the file is untouched.

`tests/cli-models.test.ts`, lines 125-130, renamed: a reviewer with no chain of its own no longer runs on the paid default, so it is nobody's model here and the command exits 0.

```ts
  it("lists no backend default for a reviewer that runs on the worker's chain", async () => {
    // The worker's chain is set and the reviewer has none of its own, so the review runs on that chain:
    // the paid "zen/p", the backend's default, is nobody's model here and is not listed.
    config = await writeConfig({ model: "plan/m" });
    expect(await models(adapterOf(CATALOGUE, "zen/p"))).toBe(0);
    expect(refs()).toEqual(["plan/m"]);
  });
```

In the same file, line 145, the comment of "leaves out a finished task's model, and a model that already has a line" described the old rule and is corrected with the case, which itself does not change: `// The reviewer's chain is empty too: its default is "plan/m", already listed.` becomes `// The reviewer's chain is the worker's chain here: "plan/m", already listed.`

- [ ] **Step 2: Run them and expect FAIL.** `npx vitest run tests/reviewer-chain.test.ts tests/model-fallback.test.ts` — in the new file the first case receives `[]` where it expects the worker's chain, and the guard case fails with `nothing is claimed on this path` (the guard let the recovery through, so the attempt went looking for the board); in `model-fallback.test.ts` the two new cases and the six whose tables were changed end `"blocked"` with a `controller-error` that says `unexpected review model (default)`. The two files that must stay green do not run yet: their two cases above are fixed in step 3 together with the code.
- [ ] **Step 3: Implement.** The two functions as under Interfaces, the four call expressions in `src/worker.ts`, and the two test edits named above. In `README.md` replace the two rows with:

```
| `reviewerModel` | string | 同 worker 链 | 复核会话单独用的模型。**不设置复核链时，复核链就是 worker 链**（`modelChain` / `model`，含任务自己的 `model`）；复核的独立性来自新会话，不来自换模型 |
```

```
| `reviewerModelFallbacks` | string[] | `[]` | 复核会话的降级链，排在 `reviewerModel` 之后；没配 `reviewerModel` 时复核链为空，于是沿用 worker 链 |
```

and in line 469 replace `（配置里一个模型都没写，或者只写了 `model` 没写 `reviewerModel`，都会落到这里）` with `（配置里一个模型都没写时会落到这里；只写了 `model` 没写 `reviewerModel` 时复核沿用 worker 链，不判后端默认模型）`.

- [ ] **Step 4: Run them and expect PASS.** `npx vitest run tests/reviewer-chain.test.ts tests/model-fallback.test.ts tests/budget-guard.test.ts tests/cli-models.test.ts`, then `npx vitest run tests/budget.test.ts tests/model-chain.test.ts tests/model-cooldown.test.ts tests/model-selection.test.ts` (the guard's own unit tests and the chain beside the shared table, none of them changed), then `npm run typecheck`.
- [ ] **Step 5: Directed mutation check** on `src/models.ts` and `src/worker.ts`.

| Mutation (file) | Killed by |
| --- | --- |
| the reviewer's chain stays empty when unconfigured: `return own.length > 0 ? own : …` becomes `return own;` (`src/models.ts`) | is the worker's chain when no reviewer model is configured; runs the review on the worker chain when no reviewer model is configured |
| the inherited chain ignores the task's own model: `taskChain(cfg)` is called without `task` (`src/models.ts`) | starts at a task's own model when the reviewer inherits the worker's chain |
| fallbacks without a primary count as a reviewer chain: `own.length > 0` becomes `if (true)` (`src/models.ts`) | is the reviewer's own chain whenever one is configured |
| the guard judges the reviewer without the task: `reviewerModels(cfg, task)` at line 280 loses `, task` (`src/worker.ts`) | is judged for a review-only recovery with the task's own model at its head |

- [ ] **Step 6: Commit.** `git add src/models.ts src/budget.ts src/worker.ts tests/reviewer-chain.test.ts tests/model-fallback.test.ts tests/budget-guard.test.ts tests/cli-models.test.ts README.md` — `feat(models): let the reviewer inherit the worker chain when none is configured`.

---

### Task 3: `modelRounds`, and a sixty-second window

**Files:**
- Modify: `src/cli.ts` lines 1699-1736 (`CONFIG_KEYS`: a key after `"modelCooldownMs",` at line 1714), lines 1739-1788 (`resolveConfig`: a line after `modelCooldownMs: number(raw, "modelCooldownMs", path),` at line 1764)
- Modify: `src/worker.ts` lines 57-140 (`WorkerConfig`: a member after `modelCooldownMs?: number;` at line 95), line 94 (the JSDoc "default 15 minutes"), and the three `?? 900_000`: line 621 (`modelFor`), line 835 (`noteRefusal`), line 1690 (`reviewStage`)
- Modify: `README.md` line 59 and a new row after it
- Test: `tests/cli-config.test.ts` (two cases), `tests/model-cooldown.test.ts` (one case)

**Interfaces:**
- Produces: `CONFIG_KEYS` contains `"modelRounds"`; `resolveConfig` returns `modelRounds: integer(raw, "modelRounds", path)` (undefined when absent, so the worker's own default applies, as for `modelCooldownMs`).
- `WorkerConfig` gains, after `modelCooldownMs`:

```ts
  /**
   * Rounds of one run a task may be refused by every model before the run
   * decides between the task's own problem and an outage (default 4, see
   * `src/model-wait.ts`). A round is one pass over the chain.
   */
  modelRounds?: number;
```

- `src/worker.ts` uses `modelCooldownMsOf(r.cfg)` at the three sites instead of `r.cfg.modelCooldownMs ?? 900_000`.

- [ ] **Step 1: Write the failing tests.**

In `tests/cli-config.test.ts` (import `runCli`; `mkdtemp`, `rm`, `writeFile` from `node:fs/promises`; `tmpdir` from `node:os`; `join` from `node:path`):

```ts
  it("accepts a round budget as a positive integer and leaves it undefined when absent", () => {
    expect(resolveConfig({ modelRounds: 2 }, "taskctl.json").modelRounds).toBe(2);
    expect(resolveConfig({}, "taskctl.json").modelRounds).toBeUndefined();
    expect(() => resolveConfig({ modelRounds: 0 }, "taskctl.json")).toThrow(/positive/);
    expect(() => resolveConfig({ modelRounds: 1.5 }, "taskctl.json")).toThrow(/integer/);
    expect(() => resolveConfig({ modelRounds: "2" }, "taskctl.json")).toThrow(/positive/);
  });

  it("every command still accepts a config that carries the new key", async () => {
    // A key that is parsed but missing from the allowlist makes every command
    // refuse the config that carries it: `taskctl retry --config` dead on arrival.
    const dir = await mkdtemp(join(tmpdir(), "taskctl-config-keys-"));
    const path = join(dir, "taskctl.json");
    await writeFile(path, JSON.stringify({ tasksDir: dir, modelRounds: 3, modelCooldownMs: 30_000 }), "utf8");
    const errors: string[] = [];

    const code = await runCli(["retry", "--task", "nope", "--config", path], { log: () => {}, err: (line) => errors.push(line) });

    await rm(dir, { recursive: true, force: true });
    expect(code).toBe(1); // the task does not exist; the config was accepted
    expect(errors.join("\n")).not.toContain("unknown field");
  });
```

In `tests/model-cooldown.test.ts`, in `describe("shared model cooldown")`:

```ts
  it("skips a refused model for sixty seconds when no window is configured", async () => {
    await seed("a");
    const cfg: WorkerConfig = {
      tasksDir: tasks, workdir: work, agent: "fixture", model: "q/one",
      contextThreshold: 0.8, retryLimit: 1, lockTtlMs: 5_000, heartbeatMs: 50,
    };
    const refusing: AgentAdapter = {
      prompt: async () => ({ sessionId: "", exitCode: 1, text: "weekly limit reached", failure: "provider", tokens: 0 }),
      contextUsage: async () => 0, contextLimit: async () => 100,
    };

    await runTask(cfg, { store, adapter: refusing }, await store.get("a"), "a-run");

    const table = JSON.parse(await readFile(join(root, ".taskctl", "model-cooldowns.json"), "utf8")) as {
      models: Record<string, { observedAt: string; retryAfter: string }>;
    };
    const entry = table.models["q/one"]!;
    expect(Date.parse(entry.retryAfter) - Date.parse(entry.observedAt)).toBe(60_000);
  });
```

- [ ] **Step 2: Run them and expect FAIL.** `npx vitest run tests/cli-config.test.ts tests/model-cooldown.test.ts` — the config cases throw `config taskctl.json: unknown field "modelRounds"`; the window case receives `900000`.
- [ ] **Step 3: Implement** as under Interfaces. In `README.md` replace line 59 and add one row after it:

```
| `modelCooldownMs` | number | `60000` | 某个模型被 provider 拒绝后，在整个看板内共享的跳过窗口。期间其他 Task 和后续 run 不再向它派发；到期重探，成功清除，显式 `chainCycles` 仍可在本任务内重探。它只是窗口，不会让任务 `blocked` |
```

```
| `modelRounds` | number | `4` | 一个任务在同一次执行里连续几轮被链上所有模型拒绝之后才做判断；必须是正整数。轮次与判断规则见「模型拒绝与轮次」 |
```

- [ ] **Step 4: Run them and expect PASS.** The same two files, then `npm run typecheck`.
- [ ] **Step 5: Directed mutation check.**

| Mutation (file) | Killed by |
| --- | --- |
| `modelRounds` is parsed but removed from `CONFIG_KEYS` (`src/cli.ts`) | every command still accepts a config that carries the new key |
| `modelRounds` accepts zero: `integer` becomes `nonNegativeInteger` (`src/cli.ts`) | accepts a round budget as a positive integer and leaves it undefined when absent |
| the window is fifteen minutes again: the constant is `900_000` (`src/model-wait.ts`) | skips a refused model for sixty seconds when no window is configured |

- [ ] **Step 6: Commit.** `git add src/cli.ts src/worker.ts tests/cli-config.test.ts tests/model-cooldown.test.ts README.md` — `feat(config): accept modelRounds and default the window to sixty seconds`.

---

### Task 4: A round in which every model refused defers the task

**Files:**
- Modify: `src/models.ts` lines 219-235 (`resetChainCycles` becomes `resetRotation`), lines 14-17 (the module comment on where the rotation lives), lines 175-176 (the end of `rotateModel`'s JSDoc)
- Modify: `src/worker.ts` — line 24 (the import from `./models.js`), lines 57-140 (`WorkerConfig`: add `run?: RunContext`), lines 87-93 (the JSDoc of `chainCycles`), line 156 (`WorkerEventType`), lines 204-236 (`Run`: `dispatchFailures` goes, `run` comes), line 291 (the `Run` literal), line 336 (the dependency gate, after which the deferral gate goes), lines 648-661 (`fallBack`'s JSDoc), lines 873-908 (delete `refusalLine` and `blockForQuota`), lines 1066-1227 (`loop`: lines 1076-1079, lines 1102-1105, line 1131, lines 1155-1183, lines 1208-1213)
- Modify: `src/dispatch.ts` lines 15-16 (the header comment)
- Modify: `README.md` line 507
- Test: Create `tests/model-rounds.test.ts`; Modify `tests/provider-failure.test.ts` (line 85), `tests/model-chain.test.ts` (lines 169, 193, 266, 290), `tests/model-fallback.test.ts` (lines 165, 178, 271, and 286-297, which is replaced), `tests/model-selection.test.ts` (lines 85-103 and 105-121), `tests/fault-isolation.test.ts` (line 239). Two of them need an import they do not have: `readModelWait` from `../src/model-wait.js`, in `tests/model-chain.test.ts` and `tests/fault-isolation.test.ts`.

**Interfaces:**
- Consumes: Task 1 (`model-wait.ts`).
- Produces (`src/models.ts`):

```ts
/**
 * Put a role back at the head of its chain with a fresh wrap budget: every
 * round is one pass over the chain, from its head. Advisory, like the rotation
 * itself.
 */
export async function resetRotation(tasksDir: string, id: string, role: ModelRole): Promise<void>;
```

- Produces (`src/worker.ts`):

```ts
export type WorkerEventType = /* existing */ | "model-deferred";
// WorkerConfig:
/** The run these attempts belong to: it counts a deferral's rounds and remembers every accepted turn. */
run?: RunContext;
// Run: `dispatchFailures` is removed; `run: RunContext` is added.

/** Note one refused turn — the shared table and this round's list — and say whether it was about allowance. */
async function noteTurnRefusal(
  r: Run, refusals: readonly ModelRefusal[], model: string | undefined, result: PromptResult & { durationMs: number },
): Promise<{ refusals: ModelRefusal[]; quota: boolean }>;

/**
 * The round ended without one model accepting: end the attempt here with a
 * deferral. `refused` says whether this task itself was refused in the round.
 * `earliest` is the `retryAfter` of the `ModelsCoolingError` when it was not:
 * the earliest expiry among the chain's windows, and then the next time.
 * The attempt never decides between the task's own problem and an outage. A
 * task whose rounds are spent is only recorded; the controller decides once
 * nothing is in flight (Task 5).
 */
async function refusedRound(
  r: Run, stage: ModelWaitStage, refusals: readonly ModelRefusal[], refused: boolean, earliest?: string,
): Promise<"open">;
```

A refused round keeps its own next time, the end of the round plus the window (design §6, step 3). A pass in which the task itself was not refused waits only for `earliest`, which `nextModelCooldown` (`src/model-cooldown.ts:31`) picks as the earliest active window of the chain.

`TaskOutcome` (`src/worker.ts:172`) is not touched: its `"refused"` is the budget guard's outcome and keeps its meaning.

- [ ] **Step 1: Write the failing tests** in `tests/model-rounds.test.ts`. Fixture: `root`, `tasks`, `work`, `store = new TaskStore(tasks)`; task `a` is `serializeTaskFile(buildTaskFile({ id: "a", title: "a", acceptance: "check", criteria: ["C1 ok"] }))`; `CHAIN = ["q/one", "q/two", "q/three", "q/four"]`.

Imports: `afterEach`, `beforeEach`, `describe`, `expect`, `it` from `vitest`; `mkdir`, `mkdtemp`, `readFile`, `rm`, `writeFile` from `node:fs/promises`; `tmpdir` from `node:os`; `join` from `node:path`; type `AgentAdapter`, `PromptResult` from `../src/adapters/types.js`; `latestNote` from `../src/handoff.js`; `readJournal` from `../src/journal.js`; `clearModelCooldown`, `noteModelRefusal` from `../src/model-cooldown.js`; `readAttempt` from `../src/runtime.js`; `serializeTaskFile` from `../src/task-file.js`; `TaskStore` from `../src/task-store.js`; `runTask`, `WRAP_UP_INSTRUCTION`, type `TaskOutcome`, type `WorkerConfig`, type `WorkerDeps`, type `WorkerEvent` from `../src/worker.js`; `DEFAULT_MODEL_KEY`, `MODEL_ROUNDS_DEFAULT`, `newRunContext`, `readModelWait`, `writeModelWait` from `../src/model-wait.js`; `buildTaskFile` from `./helpers/task-fixture.js`.

```ts
type Behaviour = PromptResult | "done";
/** A backend keyed by (role, model). "done" requests completion of the task the prompt names. */
function backend(tables: { turns?: Record<string, Behaviour>; reviews?: Record<string, Behaviour> }): { adapter: AgentAdapter; seen: string[] } {
  const seen: string[] = [];
  const answer = async (args: Parameters<AgentAdapter["prompt"]>[0]): Promise<PromptResult> => {
    const model = args.model ?? DEFAULT_MODEL_KEY;
    const review = args.title?.startsWith("review:") === true;
    seen.push(`${review ? "review:" : ""}${model}`);
    const behaviour = (review ? tables.reviews : tables.turns)?.[model];
    if (behaviour === undefined) throw new Error(`unexpected ${review ? "review" : "turn"} model ${model}`);
    if (behaviour !== "done") return behaviour;
    await markDoneTask(args.text, tasks);
    return { sessionId: `ses-${model}`, text: "done", exitCode: 0 };
  };
  return {
    seen,
    adapter: {
      prompt: answer,
      start: (args) => ({ result: answer(args), inspect: () => ({ state: "exited" as const }), cancel: async () => true }),
      contextUsage: async () => 0, contextLimit: async () => 100,
    },
  };
}
const refusal = (text: string): PromptResult => ({ sessionId: "", exitCode: 1, text, failure: "provider", tokens: 0 });
const passing = async () => ({ passed: true, skipped: false as const, exitCode: 0, output: "ok" });
const passingReview: WorkerDeps["review"] = async () => ({
  verdict: "pass", criteria: [{ id: "C1", pass: true, evidence: "ok" }], externalChanges: [], defects: [], summary: "ok",
});

function config(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    tasksDir: tasks, workdir: work, agent: "fixture", model: CHAIN[0], modelChain: CHAIN,
    contextThreshold: 0.8, retryLimit: 1, lockTtlMs: 5_000, heartbeatMs: 50, quotaBackoffMs: [0],
    // Rounds run back to back in these tests; the window is asserted on its own.
    modelCooldownMs: 0, ...overrides,
  };
}

/** One attempt of `id`. The review passes through a seam unless a case passes `{ review: undefined }`. */
async function run(
  adapter: AgentAdapter, events: WorkerEvent[] = [], overrides: Partial<WorkerConfig> = {},
  gates: Partial<Pick<WorkerDeps, "acceptance" | "review">> = {}, id = "a",
): Promise<TaskOutcome> {
  return runTask(config(overrides), {
    store, adapter, acceptance: passing, review: passingReview, ...gates,
    onEvent: (event) => { events.push(event); },
  }, await store.get(id), `w-${id}`);
}
const allRefuse = () => backend(Object.fromEntries(CHAIN.map((model) => [model, refusal(`Error: 503 on ${model}`)])));
const journal = async () => (await readJournal(tasks, "a")).map((line) => `${line.stage} ${line.event} ${line.detail}`).join("\n");
const table = async () => JSON.parse(await readFile(join(root, ".taskctl", "model-cooldowns.json"), "utf8")) as { models: Record<string, unknown> };
```

`markDoneTask`, `doneTaskId`, `seedTaskFile` come from `./helpers/watch-fixture.js`.

```ts
describe("a fully refused round", () => {
  it("moves to the next model at once and defers the task without spending a retry", async () => {
    const { adapter, seen } = allRefuse();
    const events: WorkerEvent[] = [];

    expect(await run(adapter, events)).toBe("open");

    expect(seen).toEqual(CHAIN);
    expect(await store.get("a")).toMatchObject({ status: "open", retries: 0 });
    expect(await latestNote(tasks, "a")).toBeNull();
    expect(events.some((event) => event.type === "blocked")).toBe(false);
    expect(events.find((event) => event.type === "model-deferred")?.detail)
      .toMatch(/^every model refused or cooling; round 1\/4; next \S+; retries untouched$/);
    expect(await readModelWait(tasks, "a")).toMatchObject({
      runId: expect.any(String), stage: "worker", rounds: 1,
      refusals: CHAIN.map((model) => ({ model, source: "turn", reason: expect.stringContaining(`Error: 503 on ${model}`) })),
    });
    expect(await journal()).toMatch(/worker model-deferred round 1\/4; next \S+; q\/one: exit 1 in \d+ms, Error: 503 on q\/one \| q\/two:/);
    expect((await readAttempt(tasks, "a"))?.phase).toBe("settled");
  });

  it("spends no retry on a refusal that came after the turn had done work", async () => {
    const { adapter, seen } = backend({ "q/one": { sessionId: "s", exitCode: 1, text: "model overloaded", failure: "provider", tokens: 5_000 } });

    expect(await run(adapter, [], { model: "q/one", modelChain: ["q/one"] })).toBe("open");

    expect(seen).toEqual(["q/one"]);
    expect(await store.get("a")).toMatchObject({ status: "open", retries: 0 });
  });

  it("sets the next time modelCooldownMs from the end of the round, sixty seconds by default", async () => {
    const { adapter } = allRefuse();
    const cfg = config();
    delete cfg.modelCooldownMs;

    await runTask(cfg, { store, adapter, acceptance: passing, review: passingReview }, await store.get("a"), "w-a");

    const record = (await readModelWait(tasks, "a"))!;
    expect(Date.parse(record.nextAt) - Date.parse(record.updatedAt)).toBe(60_000);
  });

  it("is refused by the claim path while its time lies in the future, like an unfinished dependency", async () => {
    expect(await run(allRefuse().adapter, [], { modelCooldownMs: 60_000 })).toBe("open");
    const again = allRefuse();

    expect(await run(again.adapter, [], { modelCooldownMs: 60_000 })).toBe("skipped");

    expect(again.seen).toEqual([]);
    const lapsed = (await readModelWait(tasks, "a"))!;
    await writeModelWait(tasks, "a", { ...lapsed, nextAt: new Date(Date.now() - 1_000).toISOString() });
    for (const model of CHAIN) await clearModelCooldown(tasks, model); // the shared window has lapsed too

    expect(await run(again.adapter, [], { modelCooldownMs: 60_000 })).toBe("open");

    expect(again.seen).toHaveLength(4);
    expect(await readModelWait(tasks, "a")).toMatchObject({ rounds: 2 });
  });

  it("waits only until the earliest expiry when every model is already cooling", async () => {
    // Another task was refused on q/three half a window ago, and on the other models just now.
    const now = Date.now();
    for (const model of CHAIN) await noteModelRefusal(tasks, model, {
      reason: `429 on ${model}`, cooldownMs: 60_000, now: new Date(now - (model === "q/three" ? 30_000 : 0)),
    });
    const { adapter, seen } = allRefuse();

    expect(await run(adapter)).toBe("open");

    expect(seen).toEqual([]);
    expect(await readModelWait(tasks, "a")).toMatchObject({ rounds: 0, nextAt: new Date(now + 30_000).toISOString() });
  });

  it("ends the deferral once a model accepts the turn", async () => {
    expect(await run(allRefuse().adapter)).toBe("open");
    const served = backend({ "q/one": "done" }); // every round starts at the head of the chain

    expect(await run(served.adapter)).toBe("done");

    expect(served.seen).toEqual(["q/one"]);
    expect(await readModelWait(tasks, "a")).toBeNull();
  });

  it("waits for the window when every model is already cooling, and such a pass is not a round", async () => {
    for (const model of CHAIN) await noteModelRefusal(tasks, model, { reason: `429 on ${model}`, cooldownMs: 60_000 });
    const { adapter, seen } = allRefuse();
    const events: WorkerEvent[] = [];

    expect(await run(adapter, events)).toBe("open");
    expect(await run(allRefuse().adapter)).toBe("skipped"); // the record's time is the table's earliest expiry, still ahead

    expect(seen).toEqual([]);
    expect(await store.get("a")).toMatchObject({ status: "open", retries: 0 });
    expect(await readModelWait(tasks, "a")).toMatchObject({
      rounds: 0, firstRefusedAt: null,
      refusals: CHAIN.map((model) => ({ model, source: "table", reason: `429 on ${model}` })),
    });
    expect(events.some((event) => event.type === "blocked")).toBe(false);
    expect(await journal()).toMatch(/model-deferred round 0\/4; next /);
  });

  it("counts rounds within one run, and starts another run from round 0", async () => {
    const first = newRunContext();
    for (let round = 1; round <= 3; round++) expect(await run(allRefuse().adapter, [], { run: first })).toBe("open");
    expect(await readModelWait(tasks, "a")).toMatchObject({ runId: first.id, rounds: 3 });

    const second = newRunContext();
    expect(await run(allRefuse().adapter, [], { run: second })).toBe("open");

    expect(await readModelWait(tasks, "a")).toMatchObject({ runId: second.id, rounds: 1 });
  });

  it("is not offered again in this run once its rounds are spent, and nothing is decided in the attempt", async () => {
    const context = newRunContext();
    for (let i = 0; i < MODEL_ROUNDS_DEFAULT; i++) expect(await run(allRefuse().adapter, [], { run: context })).toBe("open");
    const again = allRefuse();

    expect(await run(again.adapter, [], { run: context })).toBe("skipped");
    expect(again.seen).toEqual([]);

    // The attempt that ran out of rounds only recorded it. The decision is the controller's (Task 5).
    expect(await store.get("a")).toMatchObject({ status: "open", retries: 0 });
    expect(await latestNote(tasks, "a")).toBeNull();
    expect(await journal()).not.toMatch(/model-outage/);

    expect(await run(allRefuse().adapter, [], { run: newRunContext() })).toBe("open");
    expect(await readModelWait(tasks, "a")).toMatchObject({ rounds: 1 });
  });

  it("treats a refused wrap-up turn as a refusal too, and notes the table for it", async () => {
    const overBudget: AgentAdapter = {
      prompt: async (args) => args.text === WRAP_UP_INSTRUCTION
        ? refusal("Error: 429 during wrap-up")
        : { sessionId: "s-a", exitCode: 0, text: "still working" },
      contextUsage: async () => 90, contextLimit: async () => 100,
    };

    expect(await run(overBudget, [], { model: "q/one", modelChain: ["q/one"] })).toBe("open");

    expect(await store.get("a")).toMatchObject({ status: "open", retries: 0 });
    expect(await readModelWait(tasks, "a")).toMatchObject({
      rounds: 1, refusals: [{ model: "q/one", source: "turn", reason: expect.stringContaining("429 during wrap-up") }],
    });
    expect((await table()).models["q/one"]).toBeDefined();
  });

  it("records a refusal of the unnamed default model when no chain is configured", async () => {
    const { adapter, seen } = backend({ [DEFAULT_MODEL_KEY]: refusal("Error: no route") });
    const cfg = config();
    delete cfg.model;
    delete cfg.modelChain;

    expect(await runTask(cfg, { store, adapter, acceptance: passing, review: passingReview }, await store.get("a"), "w-a")).toBe("open");

    expect(seen).toEqual([DEFAULT_MODEL_KEY]);
    expect(await readModelWait(tasks, "a")).toMatchObject({ rounds: 1, refusals: [{ model: DEFAULT_MODEL_KEY, source: "turn" }] });
  });
});
```

Rewrite the tests that pin the replaced behaviour:

- `tests/provider-failure.test.ts:85`, renamed "ends a rejected turn as a deferral instead of calling it an uncertain interruption":

```ts
    expect(outcome).toBe("open");
    expect((await new TaskStore(tasksDir).get("t1")).retries).toBe(0);
    expect(events.some((event) => event.type === "blocked")).toBe(false);
    expect(events.find((event) => event.type === "model-deferred")?.detail).toContain("retries untouched");
    expect(events.some((event) => /shutdown/.test(event.detail ?? ""))).toBe(false);
    expect(calls.cancel).toBe(0);
```

- `tests/model-chain.test.ts:169`, renamed "defers instead of blocking when the chain is spent, retries untouched": keep `expect(seen).toEqual(chain)`; replace the rest by `expect(outcome).toBe("open")`, `task.status` `"open"`, `task.retries` `0`, `events.some((event) => event.type === "blocked")` `false`, `expect(await latestNote(tasks, "a")).toBeNull()`, `expect(await readModelWait(tasks, "a")).toMatchObject({ stage: "worker", rounds: 1 })`, the record's `refusals.map((refusal) => refusal.model)` equals `chain`, and the journal contains `model-deferred`.
- `tests/model-chain.test.ts:193`, renamed "spends no retry on a provider failure that is not about quota": `expect(outcome).toBe("open")`, `seen` `["q/one"]`, `retries` `0`, `latestNote` null.
- `tests/model-chain.test.ts:266`, renamed "defers only after the whole cycle refused, retries untouched": keep `allDown.seen`; then `outcome` `"open"`, `status` `"open"`, `retries` `0`, no `blocked` event, the record's refusal models equal `chain`, `latestNote` null.
- `tests/model-chain.test.ts:290`, renamed "starts every round at the head of the chain, with a fresh wrap budget". The first run stays as it is. The recovered backend answers per step, so the head is refused once and accepts after the wrap:

```ts
    const recovered = scripted({
      "q/one": [quotaRefusal(), "done"],
      "q/two": [quotaRefusal()],
      "q/three": [quotaRefusal()],
    });
    const outcome = await run(recovered.adapter, [], { model: "q/one", modelChain: chain, chainCycles: 1, modelCooldownMs: 0 });

    expect(outcome).toBe("done");
    expect(recovered.seen).toEqual([...chain, "q/one"]);
    expect((await store.get("a")).retries).toBe(0);
```

- `tests/model-fallback.test.ts:165`, renamed "defers once the chain is spent, keeping the last model chosen": `outcome` `"open"`, `models` as before, `retries` `0`, the rotation as before.
- `tests/model-fallback.test.ts:178`, renamed "starts every round at the head of the chain": the first run now ends `"open"`; the two `store` calls stay; the final assertion becomes `expect(models.filter((model) => !model.startsWith("review:"))).toEqual(["w/one", "w/two", "w/one"])`.
- `tests/model-fallback.test.ts:271`, renamed "ends as a deferral instead of throwing when a rotation cannot be recorded": `outcome` `"open"`, the journal still contains `model-fallback-failed`.
- `tests/model-selection.test.ts:85` ("wraps to an earlier model only when nothing from the recorded position is available") and `:105` ("skips forward past a cooling model before it wraps"). Both begin by writing `tasks/a/models.json` with the position an earlier attempt would have left, and the second expects the walk to start there (`["q/four"]`). That is the contract this task reverses: `resetRotation` puts every round back at the head, so the second case would dispatch `q/one` and the first would pass for the wrong reason. `modelFor`'s walk (forward from the position, then around) is unchanged and still matters inside a round, so both cases are rewritten to reach the position inside the round, by a refusal of the task's own:

```ts
  it("wraps to a model the round refused earlier only when nothing from its position is available", async () => {
    // The round is refused on q/one and moves to q/two. Between two of its turns
    // another task is refused on q/two, and a third one succeeds on q/one: the
    // walk wraps around to q/one. The controller reads the done marker once
    // after every turn that exited 0, which is where the board changes here.
    class BetweenTurnsStore extends TaskStore {
      changed = false;
      async readDoneMarker(id: string): Promise<boolean> {
        if (!this.changed) {
          this.changed = true;
          await noteModelRefusal(tasks, "q/two", { reason: "rate limited", cooldownMs: 900_000 });
          await clearModelCooldown(tasks, "q/one");
        }
        return super.readDoneMarker(id);
      }
    }
    const seen: string[] = [];
    let turns = 0;
    const adapter: AgentAdapter = {
      prompt: async (args) => {
        seen.push(args.model ?? "(default)");
        if (turns++ === 0) return refuse;
        if (turns === 2) return { sessionId: "ses-two", exitCode: 0, text: "still working" };
        await writeFile(join(tasks, "a", "done.requested"), "done");
        return { sessionId: "ses-one", exitCode: 0, text: "done" };
      },
      contextUsage: async () => 0, contextLimit: async () => 100,
    };

    expect(await run(new BetweenTurnsStore(tasks), config("q/one", "q/two"), adapter)).toBe("done");
    expect(seen).toEqual(["q/one", "q/two", "q/one"]);
  });

  it("skips forward past a cooling model before it wraps around", async () => {
    // The same board change, in a chain with a model after the position: that
    // one is taken before the walk goes around to q/one.
    class BetweenTurnsStore extends TaskStore {
      changed = false;
      async readDoneMarker(id: string): Promise<boolean> {
        if (!this.changed) {
          this.changed = true;
          await noteModelRefusal(tasks, "q/two", { reason: "rate limited", cooldownMs: 900_000 });
          await clearModelCooldown(tasks, "q/one");
        }
        return super.readDoneMarker(id);
      }
    }
    const seen: string[] = [];
    let turns = 0;
    const adapter: AgentAdapter = {
      prompt: async (args) => {
        seen.push(args.model ?? "(default)");
        if (turns++ === 0) return refuse;
        if (turns === 2) return { sessionId: "ses-two", exitCode: 0, text: "still working" };
        await writeFile(join(tasks, "a", "done.requested"), "done");
        return { sessionId: "ses-three", exitCode: 0, text: "done" };
      },
      contextUsage: async () => 0, contextLimit: async () => 100,
    };

    expect(await run(new BetweenTurnsStore(tasks), config("q/one", "q/two", "q/three"), adapter)).toBe("done");
    expect(seen).toEqual(["q/one", "q/two", "q/three"]);
  });
```

- `tests/model-fallback.test.ts:286`, "re-anchors when the recorded position belongs to a different model", is replaced. It wrote a position by hand and expected the walk to re-anchor at the head; `resetRotation` now removes the position before `modelFor` reads it, so the case passed without reaching anything. What took its place is pinned instead — a chain changed between two rounds is walked from its new head, in `describe("rotation is advisory")`:

```ts
  it("walks a chain changed between two rounds from its new head", async () => {
    await seed(null);
    const models: string[] = [];
    // The first round is refused on both models and leaves the position on the second.
    await run(adapter({ turns: { "w/one": rejected("w/one"), "w/two": rejected("w/two") } }, models), [], { model: "w/one", modelFallbacks: ["w/two"], modelCooldownMs: 0 });
    expect((await readModelRotation(tasks, "a")).worker).toEqual({ index: 1, model: "w/two" });
    // Between the rounds the owner puts another model at the head. The recorded position still names
    // w/two, and w/two is still the second model: only the reset brings the round to the new head.
    const agent = adapter({ turns: { "w/three": "done" }, reviews: { "w/three": PASS_VERDICT } }, models);

    expect(await run(agent, [], { model: "w/three", modelFallbacks: ["w/two"], modelCooldownMs: 0 })).toBe("done");
    expect(models).toEqual(["w/one", "w/two", "w/three", "review:w/three"]);
  });
```

- `tests/fault-isolation.test.ts:239`, renamed "a refused turn spends no retry and defers the task":

```ts
    expect(outcome).toBe("open");
    expect(await store.get("a")).toMatchObject({ status: "open", retries: 0 });
    expect(await latestNote(tasks, "a")).toBeNull();
    expect(await readModelWait(tasks, "a")).toMatchObject({ stage: "worker", rounds: 1 });
    expect((await readJournal(tasks, "a")).some((line) => line.event === "model-deferred")).toBe(true);
```

- [ ] **Step 2: Run them and expect FAIL.** `npx vitest run tests/model-rounds.test.ts tests/provider-failure.test.ts tests/model-chain.test.ts tests/model-fallback.test.ts tests/model-selection.test.ts tests/fault-isolation.test.ts` — every new or rewritten case receives `"blocked"` where it expects `"open"` or `"done"`, `retries: 1` where it expects `0`, or a missing `model-wait.json`; `model-selection.test.ts` is the exception: its two rewritten cases pass today, because the position they rely on is created inside the round, and they are what keeps `modelFor`'s walk pinned while the reset is built.
- [ ] **Step 3: Implement.**
  1. `src/models.ts`: `resetRotation` replaces `resetChainCycles`. It reads the rotation; when the role has no position and no cycles it returns; otherwise it writes the rotation back with the role's position removed and its cycles at 0, and it never throws. The same is done for the reviewer's role by Task 6.
  2. `src/worker.ts`: `WorkerEventType`, `WorkerConfig.run`, `Run.run` as under Interfaces; the `Run` literal at lines 290-292 gets `run: cfg.run ?? processRun()` and loses `dispatchFailures: new Map(),` (line 291); line 24 imports `resetRotation` instead of `resetChainCycles`.
  3. Claim-time gate, inserted directly after line 336 (`if (!r.reviewOnly && current.status === "open" && waitReason(current, board) !== null) return "skipped";`):

```ts
    // A deferral holds the task exactly as an unfinished dependency does, and
    // a task whose rounds this run already spent waits for the controller's decision.
    const hold = modelWaitHold(await readModelWait(cfg.tasksDir, task.id), r.run.id, modelRoundsOf(cfg), new Date());
    if (hold !== null) return "skipped";
```

  4. In `loop`: line 1079 (`await resetChainCycles(r.cfg.tasksDir, r.task.id, "worker");`) becomes `await resetRotation(r.cfg.tasksDir, r.task.id, "worker");` and the comment above it (lines 1077-1078, `// A new attempt gets a fresh wrap budget: the position still points past the` / `// models that refused, but the chain may wrap around to them again.`) becomes `// Every round is one pass over the chain: it starts at the head, with a fresh wrap budget.`; after `let handovers = 0;` (line 1076) add `let refusals: ModelRefusal[] = [];`. The `catch` at lines 1102-1105 (`if (error instanceof ModelsCoolingError) return await blockForCooldown(r, "worker", error.retryAfter, turns);`) becomes:

```ts
      if (!(error instanceof ModelsCoolingError)) throw error;
      // Nothing could be tried: every model is cooling on a refusal. The task
      // waits for the earliest window; only a round in which it was refused itself counts.
      const cooling = await coolingRefusals(r.cfg.tasksDir, workerChain(r));
      return await refusedRound(r, "worker", mergeRefusals(refusals, cooling), refusals.length > 0, error.retryAfter);
```

  5. Line 1131 (`if (result.exitCode === 0 && model !== undefined) await clearModelCooldown(r.cfg.tasksDir, model);`) becomes:

```ts
    if (result.exitCode === 0) {
      // An accepted turn is the run's evidence that this model works, and it ends any deferral.
      r.run.accepted.set(modelKey(model), Date.now());
      await clearModelWait(r.cfg.tasksDir, r.task.id);
      if (model !== undefined) await clearModelCooldown(r.cfg.tasksDir, model);
    }
```

  6. Lines 1155-1183 (from the comment `// Allowance refusals are classified before the retry accounting` to the end of the `else`) become:

```ts
      if (result.failure === "provider") {
        // A refusal — quota or not, before or after work — is never the task's
        // fault: it moves to the next model, and a round with no model left to
        // try ends the attempt without spending a retry.
        const noted = await noteTurnRefusal(r, refusals, model, result);
        refusals = noted.refusals;
        if (noted.quota) emit(r, "model-fallback", `quota on ${modelKey(model)}; not spending a retry`);
        const advanced = handovers < maxHandovers
          && await fallBack(r, "worker", `${noted.quota ? "quota exhausted" : "turn rejected"} on ${modelKey(model)}`);
        if (!advanced) return await refusedRound(r, "worker", refusals, true);
        handovers++;
        // Waiting after choosing a *different* healthy provider cools down
        // nothing. Pause only for a same-model cyclic re-probe.
        if (noted.quota && await modelFor(r, "worker") === model) await quotaPause(r, handovers - 1);
        // The next model must not continue a session the refusing backend owns.
        fresh = true;
      } else {
        if (await fail(r)) return "blocked";
      }
```

  7. Lines 1208-1213 (the `wrap.failure === "provider"` branch) become, keeping the surrounding `else`:

```ts
          // The wrap-up turn was refused like any other: same table entry, same round.
          const noted = await noteTurnRefusal(r, refusals, model, wrap);
          refusals = noted.refusals;
          const handedOver = handovers < maxHandovers
            && await fallBack(r, "worker", `wrap-up rejected by ${modelKey(model)}`);
          if (handedOver) handovers++;
          else return await refusedRound(r, "worker", refusals, true);
```

  8. Add the two functions. `noteTurnRefusal` classifies with `classifyDispatchFailure` exactly as lines 1157-1158 do today, calls the existing `noteRefusal(r, model, result, kind === "quota" ? "quota" : "provider")` (lines 1160 and 828-837), and returns `addRefusal(refusals, { model: modelKey(model), at: new Date().toISOString(), reason: refusalReason(result), source: "turn" })` with `quota: kind === "quota"`. `refusedRound`:

```ts
  const now = new Date();
  const previous = await readModelWait(r.cfg.tasksDir, r.task.id);
  // Rounds are counted within one run and one stage. A pass in which this task
  // itself was refused is a round; one where every model was already cooling is not.
  const earlier = previous !== null && previous.runId === r.run.id && previous.stage === stage ? previous : null;
  const rounds = (earlier?.rounds ?? 0) + (refused ? 1 : 0);
  const firstRefusedAt = earlier?.firstRefusedAt ?? (refused ? refusals[0]?.at ?? now.toISOString() : null);
  const record: ModelWaitRecord = {
    runId: r.run.id, stage, rounds, firstRefusedAt, refusals: [...refusals],
    nextAt: refused || earliest === undefined ? new Date(now.getTime() + modelCooldownMsOf(r.cfg)).toISOString() : earliest,
    updatedAt: now.toISOString(),
  };
  const said = refusals.map((refusal) => `${refusal.model}: ${refusal.reason}`).join(" | ");
  await owned(r, async () => {
    await writeModelWait(r.cfg.tasksDir, r.task.id, record);
    await r.deps.store.setStatus(r.task.id, "open");
    await appendJournal(r.cfg.tasksDir, r.task.id, {
      stage, event: "model-deferred", detail: `round ${rounds}/${modelRoundsOf(r.cfg)}; next ${record.nextAt}; ${said}`,
    });
  });
  emit(r, "model-deferred", `every model refused or cooling; round ${rounds}/${modelRoundsOf(r.cfg)}; next ${record.nextAt}; retries untouched`);
  return "open";
```

  9. Delete `refusalLine` (lines 873-877) and `blockForQuota` (lines 879-908). `blockForCooldown` (lines 839-871) stays until Task 6: `reviewStage` still calls it at line 1615.
  10. Comments that described the replaced path, so that the code does not say one thing and do another. Each is replaced by the sentence after its arrow.
      - `src/models.ts:14-17`, from `The rotation lives in `tasks/<id>/models.json` rather than `attempt.json`,` to `the model that just refused.` → "The rotation lives in `tasks/<id>/models.json` rather than `attempt.json`, so that it is shared by every turn of one round, the worker's and the reviewer's alike. It does not outlive the round: every round starts again at the head of the chain (`resetRotation`), and inside a round it says how far the walk has got."
      - `src/models.ts:175-176`, `Only then is the chain truly "spent" and the caller parks the task for a` / `human instead of retrying.` → "Only then is the round over: the caller ends it with a deferral (`refusedRound` in `./worker.js`) instead of spending a retry."
      - `src/worker.ts:91`, `so a task parks for a human only when the whole cycle is out of allowance.` → "so a round ends only when the whole cycle has refused."
      - `src/worker.ts:654`, `this stays bounded; running out of models spends retries as before.` → "this stays bounded; running out of models ends the round with a deferral."
      - `src/worker.ts:659-660`, `instead, so the ordinary retry budget and its `blocked` outcome apply — never` / `an exception out of a task that had already settled its turn.` → "instead, so the round ends with a deferral — never an exception out of a task that had already settled its turn."
      - `src/dispatch.ts:15-16`, `So quota refusals back off and move down the model chain without touching` / `` `retries`, and a spent chain blocks with a note naming every model it tried.`` → "So quota refusals back off and move down the model chain without touching `retries`; a round in which the whole chain refused defers the task (`src/worker.ts`)."
  11. `README.md` line 507 (the paragraph that begins `当前选中的模型记在 `tasks/<id>/models.json`，所以重试时不会又先撞那个已经打满的模型`) becomes:

```
一轮之内当前选中的模型记在 `tasks/<id>/models.json`；每一轮从链首开始——一轮就是把链走一遍，窗口内刚拒绝过的模型由共享冷却表挡住，不会再撞。`taskctl retry` 会把它和旧证据一起归档。
```

- [ ] **Step 4: Run them and expect PASS.** The six files from step 2, then `npx vitest run tests/model-cooldown.test.ts tests/replace.test.ts tests/reconcile.test.ts`, then `npm run typecheck`.
- [ ] **Step 5: Directed mutation check** on `src/worker.ts` and `src/models.ts`.

| Mutation | Killed by |
| --- | --- |
| a refusal still spends a retry: the provider branch falls through to `fail(r)` (`src/worker.ts`) | moves to the next model at once and defers the task without spending a retry |
| the deferral leaves the task `running`: `setStatus(…, "open")` becomes `if (false)` (`src/worker.ts`) | moves to the next model at once and defers the task without spending a retry |
| the claim-time gate is ignored: `if (hold !== null)` becomes `if (false)` (`src/worker.ts`) | is refused by the claim path while its time lies in the future, like an unfinished dependency; is not offered again in this run once its rounds are spent… |
| the next time is not the window: `modelCooldownMsOf(r.cfg)` becomes `0` (`src/worker.ts`) | sets the next time modelCooldownMs from the end of the round, sixty seconds by default |
| an accepted turn keeps the deferral: `clearModelWait` is not called (`src/worker.ts`) | ends the deferral once a model accepts the turn |
| a refusal after work is an ordinary failure: the condition gains `&& result.tokens === 0` (`src/worker.ts`) | spends no retry on a refusal that came after the turn had done work |
| a cooling pass counts as a round: the `catch` passes `true` for `refused` (`src/worker.ts`) | waits for the window when every model is already cooling, and such a pass is not a round |
| rounds ignore the run: `previous.runId === r.run.id` is dropped (`src/worker.ts`) | counts rounds within one run, and starts another run from round 0 |
| rounds are not persisted: `rounds` in the record is the constant `1` (`src/worker.ts`) | counts rounds within one run, and starts another run from round 0 |
| a refused wrap-up turn spends a retry: its branch calls `fail(r)` (`src/worker.ts`) | treats a refused wrap-up turn as a refusal too, and notes the table for it |
| the default model is not recorded: `modelKey(model)` becomes `model!` in `noteTurnRefusal` (`src/worker.ts`) | records a refusal of the unnamed default model when no chain is configured |
| a round keeps the previous position: `resetRotation` returns at once (`src/models.ts`) | starts every round at the head of the chain (`tests/model-fallback.test.ts`); starts every round at the head of the chain, with a fresh wrap budget (`tests/model-chain.test.ts`); walks a chain changed between two rounds from its new head (`tests/model-fallback.test.ts`) |
| a cooling pass waits a whole window: `earliest` is ignored and `nextAt` is always now plus the window (`src/worker.ts`) | waits only until the earliest expiry when every model is already cooling; waits for the window when every model is already cooling… (its second attempt is no longer held) |
| the reset keeps the wrap budget: the role's cycles are written back as they were (`src/models.ts`) | starts every round at the head of the chain, with a fresh wrap budget (`tests/model-chain.test.ts`: the head accepts only on its second visit, after the wrap) |

- [ ] **Step 6: Commit.** `git add src/models.ts src/worker.ts src/dispatch.ts tests/model-rounds.test.ts tests/provider-failure.test.ts tests/model-chain.test.ts tests/model-fallback.test.ts tests/model-selection.test.ts tests/fault-isolation.test.ts README.md` — `feat(worker): defer a task whose round every model refused instead of blocking it`.

---

### Task 5: After `modelRounds` — the controller decides: the task's own problem, or an outage

**Files:**
- Modify: `src/worker.ts` — `WorkerEventType` (line 156 at `c8e604f`; after Task 4 it ends `"refused" | "model-deferred"`): add `"outage"`; a new exported `settleExhausted`, placed after `runWorker`; a new `holdForRefusal` under it. `refusedRound` (Task 4) is not touched.
- Test: `tests/model-rounds.test.ts` (new `describe`)

**Interfaces:**
- Produces (`src/worker.ts`):

```ts
export type WorkerEventType = /* existing */ | "outage";
/**
 * Take the decision an attempt that ran out of rounds leaves open (spec §6,
 * step 5), for the tasks a controller just got back deferred. With another
 * task served on the chain since the task's first refusal, the task alone is
 * held; otherwise it is an outage, and the first one ends the list. Called
 * only once no attempt is in flight, so every turn that was running has been
 * counted.
 */
export async function settleExhausted(
  cfg: WorkerConfig, deps: WorkerDeps, board: readonly Task[], deferred: readonly string[], now?: Date,
): Promise<{ held: string[]; outage?: { taskId: string } }>;
/** Stop for a human: every model refused this task while another was served. The task itself is the problem. */
async function holdForRefusal(
  cfg: WorkerConfig, deps: WorkerDeps, task: Task, record: ModelWaitRecord, served: string,
): Promise<void>;
```

- `outage` is present in the result only when an outage was declared.
- No attempt ever decides. `TaskOutcome` has no `"outage"`: `runTask` returns `"open"` for a task that ran out of rounds, exactly as for any other deferral, and the record's `rounds` is what tells the controller. `settleExhausted` asks `modelWaitHolds({ tasksDir: cfg.tasksDir, run: cfg.run ?? processRun(), modelRounds: modelRoundsOf(cfg) }, deferred, now)` and walks `deferred` in the order given. An id that is not on the board as `open`, whose hold is not `exhausted`, or whose record cannot be read is skipped. For the rest the chain is the one that refused — `chainKeys(configuredReviewerChain(cfg, task))` for a review record, else `chainKeys(taskChain(cfg, task))` — and the evidence is `servedSince(run, chain, Date.parse(record.firstRefusedAt ?? record.updatedAt))`.
- A served chain model: `holdForRefusal`, and the id goes to `held`. None: the journal gets `model-outage`, the event `"outage"` is emitted through `deps.onEvent`, and `{ held, outage: { taskId } }` is returned at once.
- Both writes go under the task's mutation mutex, `withMutex(join(cfg.tasksDir, id, ".mutation.lock"), …)`, the way `retryTask` changes a task no attempt owns (`src/reconcile.ts:148`). No retry is spent on either branch.

- [ ] **Step 1: Write the failing tests** in `tests/model-rounds.test.ts`. Add `type RunContext` to the import from `../src/model-wait.js`, `settleExhausted` to the import from `../src/worker.js`; import `type Task` as a type from `../src/task-file.js`.

```ts
describe("after modelRounds rounds", () => {
  const round = (adapter: AgentAdapter, context: RunContext, overrides: Partial<WorkerConfig> = {}) => run(adapter, [], { run: context, ...overrides });
  const seed = (id: string, overrides: Partial<Task> = {}) => seedTaskFile(tasks, buildTaskFile({ id, title: id, acceptance: "check", criteria: ["C1 ok"], ...overrides }));
  /** What a controller does once nothing is in flight, for the tasks it got back deferred. */
  const settle = async (cfg: WorkerConfig, deferred: string[]) => {
    const events: WorkerEvent[] = [];
    const outcome = await settleExhausted(cfg, {
      store, adapter: allRefuse().adapter, acceptance: passing, review: passingReview, onEvent: (event) => { events.push(event); },
    }, await store.list(), deferred);
    return { outcome, events };
  };

  it("with no task served, the task is left open, retries untouched, and the run is told to stop", async () => {
    const context = newRunContext();
    const outcomes: TaskOutcome[] = [];
    for (let i = 0; i < MODEL_ROUNDS_DEFAULT; i++) outcomes.push(await round(allRefuse().adapter, context));
    // Four rounds by default, and not one of them decided anything.
    expect(outcomes).toEqual(["open", "open", "open", "open"]);

    const { outcome, events } = await settle(config({ run: context }), ["a"]);

    expect(outcome).toEqual({ held: [], outage: { taskId: "a" } });
    expect(await store.get("a")).toMatchObject({ status: "open", retries: 0 });
    expect(await readModelWait(tasks, "a")).toMatchObject({ runId: context.id, rounds: 4 });
    expect(await latestNote(tasks, "a")).toBeNull();
    expect(events.some((event) => event.type === "blocked")).toBe(false);
    expect(events.find((event) => event.type === "outage")?.detail).toContain("nothing is blocked, every waiting task can be run again");
    expect(await journal()).toMatch(/worker model-outage rounds 4\/4 over \S+ since \S+; no task served on the chain; q\/one:/);
  });

  it("honours a configured round budget", async () => {
    const context = newRunContext();
    expect(await round(allRefuse().adapter, context, { modelRounds: 2 })).toBe("open");

    // One round of two is not spent: there is nothing to decide.
    expect((await settle(config({ run: context, modelRounds: 2 }), ["a"])).outcome).toEqual({ held: [] });

    expect(await round(allRefuse().adapter, context, { modelRounds: 2 })).toBe("open");
    expect((await settle(config({ run: context, modelRounds: 2 }), ["a"])).outcome).toEqual({ held: [], outage: { taskId: "a" } });
  });

  it("with another task served on a chain model, only this task is blocked, and the note names every model", async () => {
    await seed("b");
    const context = newRunContext();
    for (let i = 0; i < MODEL_ROUNDS_DEFAULT; i++) expect(await round(allRefuse().adapter, context)).toBe("open");
    const serving = backend({ "q/one": refusal("Error: 503 on the way"), "q/two": "done" });
    expect(await run(serving.adapter, [], { run: context }, {}, "b")).toBe("done");

    const { outcome, events } = await settle(config({ run: context }), ["a"]);

    expect(outcome).toEqual({ held: ["a"] });
    expect(await store.get("a")).toMatchObject({ status: "blocked", retries: 0 });
    const note = (await latestNote(tasks, "a"))!.markdown;
    expect(note).toContain("blocked:needs-owner");
    for (const model of CHAIN) expect(note).toContain(model);
    expect(note).toContain("未消耗 retries");
    expect(events.find((event) => event.type === "blocked")?.detail).toContain("the task itself is the problem");
    expect(await journal()).toContain("refused by every model in 4 round(s) while q/two served another task");
    expect(await readModelWait(tasks, "a")).toMatchObject({ rounds: 4 });
    expect(await store.get("b")).toMatchObject({ status: "done" });
  });

  it("a success that later refusals overwrote in the shared table is still evidence", async () => {
    await seed("b");
    await seed("c");
    const context = newRunContext();
    for (const id of ["a", "c"]) for (let i = 0; i < MODEL_ROUNDS_DEFAULT - 1; i++) {
      expect(await run(allRefuse().adapter, [], { run: context }, {}, id)).toBe("open");
    }
    // b is served on q/two only; c is refused on every model.
    const serveBRefuseC: AgentAdapter = {
      prompt: async (args) => {
        if (doneTaskId(args.text) === "b" && args.model === "q/two") {
          await markDoneTask(args.text, tasks);
          return { sessionId: "ses-b", exitCode: 0, text: "done" };
        }
        return refusal("Error: this model will not serve this task");
      },
      contextUsage: async () => 0, contextLimit: async () => 100,
    };

    expect(await run(serveBRefuseC, [], { run: context }, {}, "b")).toBe("done");
    // a's and c's fourth rounds are refused right after b's success and write q/two's entry again.
    expect(await run(allRefuse().adapter, [], { run: context })).toBe("open");
    expect(await run(serveBRefuseC, [], { run: context }, {}, "c")).toBe("open");
    expect((await table()).models["q/two"]).toBeDefined(); // the shared table alone says "refusing"

    const { outcome } = await settle(config({ run: context }), ["a", "c"]);

    expect(outcome).toEqual({ held: ["a", "c"] });
    expect(await store.get("a")).toMatchObject({ status: "blocked" });
    expect(await store.get("b")).toMatchObject({ status: "done" });
  });

  it("does not count a turn accepted before the task's first refusal", async () => {
    await seed("b");
    const context = newRunContext();
    expect(await run(backend({ "q/one": refusal("Error: 503 on the way"), "q/two": "done" }).adapter, [], { run: context }, {}, "b")).toBe("done");
    for (let i = 0; i < MODEL_ROUNDS_DEFAULT; i++) expect(await round(allRefuse().adapter, context)).toBe("open");

    expect((await settle(config({ run: context }), ["a"])).outcome).toEqual({ held: [], outage: { taskId: "a" } });
  });

  it("waits for the attempt in flight: a task served after the round that ran out is still evidence", async () => {
    await seed("b");
    const context = newRunContext();
    for (let i = 0; i < MODEL_ROUNDS_DEFAULT; i++) expect(await round(allRefuse().adapter, context)).toBe("open");
    // Nothing was decided while b's turn was still to come.
    expect((await readJournal(tasks, "a")).some((line) => line.event === "model-outage")).toBe(false);
    expect(await store.get("a")).toMatchObject({ status: "open" });

    const serving = backend({ "q/one": refusal("Error: 503 on the way"), "q/two": "done" });
    expect(await run(serving.adapter, [], { run: context }, {}, "b")).toBe("done");

    expect((await settle(config({ run: context }), ["a"])).outcome).toEqual({ held: ["a"] });
    expect(await store.get("a")).toMatchObject({ status: "blocked" });
  });

  it("decides nothing for a task that is no longer open", async () => {
    const context = newRunContext();
    for (let i = 0; i < MODEL_ROUNDS_DEFAULT; i++) expect(await round(allRefuse().adapter, context)).toBe("open");
    await store.setStatus("a", "blocked"); // by hand, while no controller was running

    expect((await settle(config({ run: context }), ["a"])).outcome).toEqual({ held: [] });
    expect((await readJournal(tasks, "a")).some((line) => line.event === "model-outage")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and expect FAIL.** `npx vitest run tests/model-rounds.test.ts` — every new case fails at `settleExhausted`: `TypeError: settleExhausted is not a function`.
- [ ] **Step 3: Implement.**

```ts
export async function settleExhausted(
  cfg: WorkerConfig, deps: WorkerDeps, board: readonly Task[], deferred: readonly string[], now = new Date(),
): Promise<{ held: string[]; outage?: { taskId: string } }> {
  const run = cfg.run ?? processRun();
  const holds = await modelWaitHolds({ tasksDir: cfg.tasksDir, run, modelRounds: modelRoundsOf(cfg) }, deferred, now);
  const held: string[] = [];
  for (const id of deferred) {
    const hold = holds.get(id);
    const task = board.find((candidate) => candidate.id === id);
    if (hold?.kind !== "exhausted" || task === undefined || task.status !== "open") continue;
    const record = await readModelWait(cfg.tasksDir, id);
    if (record === null) continue;
    // The run's evidence decides: did any task get a turn accepted on the
    // chain that refused, after this task's first refusal?
    const chain = chainKeys(record.stage === "review" ? configuredReviewerChain(cfg, task) : taskChain(cfg, task));
    const since = Date.parse(record.firstRefusedAt ?? record.updatedAt);
    const served = servedSince(run, chain, since);
    if (served !== null) {
      await holdForRefusal(cfg, deps, task, record, served);
      held.push(id);
      continue;
    }
    const said = record.refusals.map((refusal) => `${refusal.model}: ${refusal.reason}`).join(" | ");
    await withMutex(join(cfg.tasksDir, id, ".mutation.lock"), () => appendJournal(cfg.tasksDir, id, {
      stage: record.stage, event: "model-outage",
      detail: `rounds ${hold.rounds}/${modelRoundsOf(cfg)} over ${formatDuration(now.getTime() - since)} since ${record.firstRefusedAt}; no task served on the chain; ${said}`,
    }));
    deps.onEvent?.({
      type: "outage", taskId: id,
      detail: `every model refused in ${hold.rounds} round(s) and no task was served on the chain; the run stops — nothing is blocked, every waiting task can be run again`,
    });
    return { held, outage: { taskId: id } };
  }
  return { held };
}
```

`holdForRefusal` writes, in one block under the same mutex, the note, the journal line `{ stage: record.stage, event: "blocked", detail: `refused by every model in ${rounds} round(s) while ${served} served another task; retries untouched` }` with `rounds = record.rounds`, and `deps.store.setStatus(task.id, "blocked")`; then it emits `{ type: "blocked", taskId: task.id, detail: `every model refused this task in ${rounds} round(s) while ${served} served another task; retries untouched — the task itself is the problem` }`. The note's `seq` is one past `latestNote`'s. Task 6 adds the review branch in front of the note. The note:

```ts
{
  task: task.id, seq, status: "blocked:needs-owner",
  done: `模型拒绝：本任务在本次执行里连续 ${rounds} 轮被链上所有模型拒绝，期间其他任务在 ${served} 上成功过——模型可用，问题在本任务自身。未消耗 retries。`,
  found: ["每个模型的拒绝原话：", ...record.refusals.map((refusal) => `- ${refusal.model}: ${refusal.reason}`)].join("\n"),
  next: "逐条看上面的拒绝原话（常见：输入过长、内容被拒、该模型不支持这份任务）；修改任务定义或为它单独指定 model 后 taskctl retry。依赖它的任务会一直等，其余任务不受影响。",
  files: [],
}
```

New imports in `src/worker.ts`: `withMutex` from `./mutex.js`; `chainKeys`, `formatDuration`, `modelRoundsOf`, `processRun`, `servedSince`, `readModelWait`, `modelWaitHolds`, `type ModelWaitRecord` join the import from `./model-wait.js` Task 4 opened.

- [ ] **Step 4: Run it and expect PASS.** `npx vitest run tests/model-rounds.test.ts`, then `npm run typecheck`.
- [ ] **Step 5: Directed mutation check** on `src/worker.ts`.

| Mutation | Killed by |
| --- | --- |
| a task decides before its rounds are spent: the `hold?.kind !== "exhausted"` guard is removed | honours a configured round budget |
| evidence is never consulted: `servedSince(…)` is replaced by `null` | with another task served on a chain model, only this task is blocked… |
| any acceptance is evidence, whatever its time: `since` is the constant `0` | does not count a turn accepted before the task's first refusal |
| the run forgets an acceptance after each round: `r.run.accepted.clear()` is called in `refusedRound` | a success that later refusals overwrote in the shared table is still evidence |
| the held task is left `open`: `setStatus(…, "blocked")` in `holdForRefusal` becomes `if (false)` | with another task served on a chain model, only this task is blocked… |
| the outage holds the task too: the outage branch calls `holdForRefusal` first | with no task served, the task is left open… |
| the outage is not reported: the `deps.onEvent?.({ type: "outage", … })` call becomes `if (false)` | with no task served, the task is left open… |
| the board is ignored: `task.status !== "open"` is dropped from the guard | decides nothing for a task that is no longer open |

- [ ] **Step 6: Commit.** `git add src/worker.ts tests/model-rounds.test.ts` — `feat(worker): the controller decides between the task's own problem and an outage after modelRounds`.

---

### Task 6: The review stage — a refused review defers and resumes by itself

**Files:**
- Modify: `src/worker.ts` — line 336 (the dependency gate: the automatic resumption goes after the deferral gate Task 4 put there), lines 347-354 (the review-only checks), lines 1557-1710 (`reviewStage`: line 1609, after line 1607, lines 1614-1617, lines 1678-1697 (`clearModelCooldown`, the shared table entry and the journal line `provider-failed`), lines 1698-1708), lines 1726-1759 (`parkReviewPending`), lines 839-871 (delete `blockForCooldown`), `holdForRefusal` (Task 5)
- Modify: `src/review.ts` — lines 27-30 (the fields `ReviewResult` carries after `raw`), lines 263-267 (the `finish` of a failed turn in `startReview`)
- Modify: `src/cli.ts` — `retryCommand` (lines 1565-1599): the `--review-only` branch, a check before `runTask` is called
- Test: `tests/model-rounds.test.ts` (new `describe`); Modify `tests/review.test.ts` (one `describe`), `tests/review-pending.test.ts` (lines 47-52, 77, 112, 144, 157, 172, 188, 207, 228, and one new case) and `tests/model-fallback.test.ts` (line 234)

**Interfaces:**
- Produces (`src/worker.ts`):

```ts
/** The record `review-pending.json` carries, keeping the first window and the first refusal time. */
async function reviewPendingRecord(r: Run, round: readonly { model: string; reason: string }[]): Promise<ReviewPendingRecord>;
const validPending = (record: ReviewPendingRecord | null): record is ReviewPendingRecord;
/**
 * The controller's half of the park (Task 5's `holdForRefusal`, review stage):
 * the preserved evidence was written at the deferral, so only the journal
 * line and the status are written here.
 */
async function parkReviewFromRecord(
  cfg: WorkerConfig, deps: WorkerDeps, task: Task, record: ModelWaitRecord, verdict: string,
): Promise<"blocked">;
```

- Produces (`src/review.ts`): `ReviewResult` gains one field, after `reviewerSessionId` (line 28):

```ts
  /**
   * The backend's own text of a provider refusal: the first non-empty line of
   * the turn's output, or `no output`, cut to 240 characters — bounded the way
   * the worker bounds a refused turn's. Present only with `failure: "provider"`.
   */
  refusalText?: string;
```

- Rounds are counted anew for the review stage (design §16): `refusedRound` counts within one run and one stage, so a task can be deferred for `modelRounds` rounds as a worker and again as a reviewer.
- `runTask`: after the deferral gate, an `open` task that carries a valid `review-pending.json` is claimed as review-only (`r.reviewOnly = true`) — the controller resumes the review on the preserved evidence by itself, through today's review-only path and its digest gate.
- `reviewStage` starts each round at the head of the reviewer chain: line 1609 calls `resetRotation(r.cfg.tasksDir, id, "reviewer")`.
- `refusedRound`, stage `review`: writes `review-pending.json` beside the deferral record, in both the deferral and — through Task 5's settle — the outage. An outage leaves the task `open` with its evidence for the rerun.
- `holdForRefusal`, stage `review`: `parkReviewFromRecord(cfg, deps, task, record, `own problem: refused in ${rounds} round(s) while ${served} served another task`)`, and no note.
- `parkReviewPending` (lines 1726-1759) is not changed: it stays the park of a reviewer that timed out.
- The provider's reason for refusing a reviewer model is kept (design §16). `startReview` carries the backend's text in `refusalText`; `reviewStage` writes it — `said = result.refusalText ?? result.summary ?? "review provider rejected the turn"` — into the shared table, the journal line `provider-failed` and the deferral record, so the report of §7 names each reviewer model's reason as it names each worker model's. A `review` seam that answers without the field reads as before.
- `retryCommand` (`src/cli.ts`), `--review-only`: asked for while a deferral's time lies in the future, the recovery is not run. Before `runTask` is called the command asks what the claim path asks, `modelWaitHold(await readModelWait(tasksDir, id), newRunContext().id, modelRoundsOf(cfg), new Date())` — a fresh run id, so only a window can answer — and on `window` it prints `review-only recovery is held by a model window until <nextAt>; ask again then` and returns 1. The claim path's `skipped` is no longer what the owner reads for a closed window, whatever the task's status (design §16).

- [ ] **Step 1: Write the failing tests.** In `tests/review.test.ts` (import `runReview` from `../src/review.js`; type `AgentAdapter`, `PromptResult` from `../src/adapters/types.js`; `buildTaskFile` from `./helpers/task-fixture.js`), one `describe` at the end:

```ts
describe("a refused review turn", () => {
  const task = buildTaskFile({ id: "001-a", title: "登录改版", status: "review", criteria: ["C1 npm test 全绿"] });
  const evidence = { task, spec: "", acceptanceMarkdown: "exit 0", handoff: null, journal: [], window: { startedAt: "2026-11-16T00:00:00.000Z", finishedAt: "2026-11-16T00:20:00.000Z" } };
  const answering = (result: PromptResult): AgentAdapter => ({ prompt: async () => result, contextUsage: async () => 0, contextLimit: async () => 100 });
  const review = (result: PromptResult) => runReview({ adapter: answering(result), cwd: "." }, evidence);
  const refusedBy = (text: string) => review({ sessionId: "s", exitCode: 1, text, failure: "provider" });

  it("carries the backend's text of a provider refusal, its first line and no more than 240 characters", async () => {
    expect((await refusedBy("  Error: weekly limit reached")).refusalText).toBe("Error: weekly limit reached");
    expect((await refusedBy("")).refusalText).toBe("no output");
    expect((await refusedBy("x".repeat(300))).refusalText).toHaveLength(240);
    // The first line only, as the worker keeps it.
    expect((await review({ sessionId: "s", exitCode: 1, text: `Error: 429 too many requests
and a second line`, failure: "provider" })).refusalText).toBe("Error: 429 too many requests");
  });

  it("carries none for a turn that crashed or was judged", async () => {
    const crashed = await review({ sessionId: "s", exitCode: 1, text: "Error: boom" });
    expect(crashed.failure).toBeUndefined();
    expect(crashed).not.toHaveProperty("refusalText");
    expect(await review({ sessionId: "s", exitCode: 0, text: '{"verdict":"unclear"}' })).not.toHaveProperty("refusalText");
  });
});
```

In `tests/model-rounds.test.ts` (add `vi` to the vitest import; `readRuntime` from `../src/runtime.js`; `runCli` from `../src/cli.js`):

```ts
const PASS: PromptResult = { sessionId: "s-review", exitCode: 0, text: '{"verdict":"pass","criteria":[{"id":"C1","pass":true,"evidence":"ok"}],"externalChanges":[],"defects":[],"summary":"ok"}' };
const FAIL: PromptResult = { sessionId: "s-review", exitCode: 0, text: '{"verdict":"fail","criteria":[{"id":"C1","pass":false,"evidence":"wrong"}],"externalChanges":[],"defects":["fix it"],"summary":"not good"}' };
const REVIEW = { modelChain: ["w/one"], reviewerModel: "r/one", reviewerModelFallbacks: ["r/two"] };
const refused = () => backend({
  turns: { "w/one": "done" },
  reviews: { "r/one": refusal("Error: 429 too many requests"), "r/two": refusal("Error: weekly limit reached") },
});
const pending = () => readRuntime<{ definitionDigest: string; refusals: Array<{ model: string }>; window?: unknown }>(tasks, "a", "review-pending.json");
/** What a controller does once nothing is in flight, for the tasks it got back deferred. */
const settleReview = async (cfg: WorkerConfig, deferred: string[]) => settleExhausted(cfg, {
  store, adapter: refused().adapter, acceptance: passing,
}, await store.list(), deferred);

describe("a refused review", () => {
  it("walks the reviewer chain, and a fully refused round defers with the evidence preserved", async () => {
    const { adapter, seen } = refused();
    const events: WorkerEvent[] = [];

    expect(await run(adapter, events, REVIEW, { review: undefined })).toBe("open");

    expect(seen).toEqual(["w/one", "review:r/one", "review:r/two"]);
    expect(await store.get("a")).toMatchObject({ status: "open", retries: 0, reviewRounds: 0 });
    expect(await pending()).toMatchObject({ definitionDigest: expect.any(String), refusals: [{ model: "r/one" }, { model: "r/two" }] });
    expect(await readModelWait(tasks, "a")).toMatchObject({
      stage: "review", rounds: 1,
      refusals: [{ model: "r/one", reason: "Error: 429 too many requests" }, { model: "r/two", reason: "Error: weekly limit reached" }],
    });
    expect(events.some((event) => event.type === "blocked")).toBe(false);
  });

  it("the next claim after the window resumes the review by itself, without the worker or the acceptance", async () => {
    expect(await run(refused().adapter, [], REVIEW, { review: undefined })).toBe("open");
    const acceptance = vi.fn(passing);
    const { adapter, seen } = backend({ turns: { "w/one": "done" }, reviews: { "r/one": PASS } });

    expect(await run(adapter, [], REVIEW, { review: undefined, acceptance })).toBe("done");

    expect(seen).toEqual(["review:r/one"]);
    expect(acceptance).toHaveBeenCalledTimes(0); // this attempt ran no gate; the first one ran it once
    expect((await readJournal(tasks, "a")).some((line) => line.stage === "review" && line.event === "review-only")).toBe(true);
    expect(await pending()).toBeNull();
    expect(await readModelWait(tasks, "a")).toBeNull();
    expect(await store.get("a")).toMatchObject({ status: "done" });
  });

  it("a fail verdict after that resumption opens rework without invoking the worker", async () => {
    expect(await run(refused().adapter, [], REVIEW, { review: undefined })).toBe("open");
    const { adapter, seen } = backend({ turns: { "w/one": "done" }, reviews: { "r/one": FAIL } });

    expect(await run(adapter, [], REVIEW, { review: undefined })).toBe("open");

    expect(seen).toEqual(["review:r/one"]);
    expect(await store.get("a")).toMatchObject({ status: "open" });
    expect((await latestNote(tasks, "a"))?.markdown).toContain("review-failed");
    expect(await pending()).toBeNull();
  });

  it("after modelRounds rounds with no task served, keeps the evidence and tells the run to stop", async () => {
    const context = newRunContext();
    const one = () => run(refused().adapter, [], { ...REVIEW, run: context }, { review: undefined });
    expect(await one()).toBe("open");
    const first = (await pending())?.window;
    for (let i = 1; i < MODEL_ROUNDS_DEFAULT; i++) expect(await one()).toBe("open");

    expect(await settleReview(config({ ...REVIEW, run: context }), ["a"])).toEqual({ held: [], outage: { taskId: "a" } });

    expect(await store.get("a")).toMatchObject({ status: "open", retries: 0 });
    expect((await pending())?.window).toEqual(first);
    expect(await readModelWait(tasks, "a")).toMatchObject({ stage: "review", rounds: 4 });
  });

  it("after modelRounds rounds with another task served on a chain model, parks the task as today", async () => {
    await seedTaskFile(tasks, buildTaskFile({ id: "b", title: "b", acceptance: "check", criteria: ["C1 ok"] }));
    const context = newRunContext();
    for (let i = 0; i < MODEL_ROUNDS_DEFAULT; i++) expect(await run(refused().adapter, [], { ...REVIEW, run: context }, { review: undefined })).toBe("open");
    const serving = backend({ turns: { "w/one": "done" }, reviews: { "r/one": PASS } });
    expect(await run(serving.adapter, [], { ...REVIEW, run: context }, { review: undefined }, "b")).toBe("done");

    expect(await settleReview(config({ ...REVIEW, run: context }), ["a"])).toEqual({ held: ["a"] });

    expect(await store.get("a")).toMatchObject({ status: "blocked", retries: 0 });
    expect(await pending()).not.toBeNull();
    expect(await journal()).toMatch(/review review-pending .*own problem: refused in 4 round\(s\) while r\/one served another task/);
  });

  it("asks about the chain that refused, not about the worker's chain", async () => {
    await seedTaskFile(tasks, buildTaskFile({ id: "b", title: "b", acceptance: "check", criteria: ["C1 ok"], verify: "mechanical" }));
    const context = newRunContext();
    const reviewerOnly = { ...REVIEW, reviewerModelFallbacks: [] };
    for (let i = 0; i < MODEL_ROUNDS_DEFAULT; i++) expect(await run(refused().adapter, [], { ...reviewerOnly, run: context }, { review: undefined })).toBe("open");
    // b's worker is served on w/one and needs no review: not evidence for r/one.
    expect(await run(backend({ turns: { "w/one": "done" } }).adapter, [], { ...reviewerOnly, run: context }, { review: undefined }, "b")).toBe("done");

    expect(await settleReview(config({ ...reviewerOnly, run: context }), ["a"])).toEqual({ held: [], outage: { taskId: "a" } });
  });

  it("an open task that carries preserved evidence is never sent back through the worker, whoever wrote the record", async () => {
    expect(await run(refused().adapter, [], REVIEW, { review: undefined })).toBe("open");
    await clearModelWait(tasks, "a"); // the deferral is gone; the preserved evidence is what counts
    const { adapter, seen } = backend({ turns: { "w/one": "done" }, reviews: { "r/one": PASS } });

    expect(await run(adapter, [], REVIEW, { review: undefined })).toBe("done");

    expect(seen).toEqual(["review:r/one"]);
  });

  it("the digest gate still refuses an automatic resumption on changed artifacts", async () => {
    expect(await run(refused().adapter, [], REVIEW, { review: undefined })).toBe("open");
    await writeFile(join(work, "changed-after-the-work.txt"), "drift", "utf8");
    const { adapter, seen } = backend({ turns: { "w/one": "done" }, reviews: { "r/one": PASS } });
    const events: WorkerEvent[] = [];

    expect(await run(adapter, events, REVIEW, { review: undefined })).toBe("blocked");

    expect(seen).toEqual([]);
    expect(events.find((event) => event.type === "blocked")?.detail).toContain("review-only recovery refused");
    expect(await pending()).not.toBeNull();
  });

  it("a retry --review-only asked for inside the window is not run, and says until when", async () => {
    // Deferred for a real window, and blocked as the controller blocks it once its rounds are spent.
    expect(await run(refused().adapter, [], { ...REVIEW, modelCooldownMs: 60_000 }, { review: undefined })).toBe("open");
    await store.setStatus("a", "blocked");
    const nextAt = (await readModelWait(tasks, "a"))!.nextAt;
    const { adapter, seen } = backend({ turns: { "w/one": "done" }, reviews: { "r/one": PASS } });
    const configPath = join(root, "taskctl.json");
    await writeFile(configPath, JSON.stringify({ tasksDir: tasks, workdir: work, ...REVIEW }), "utf8");
    const lines: string[] = [];

    const code = await runCli(["retry", "--task", "a", "--review-only", "--config", configPath], { adapter, log: (line) => { lines.push(line); } });

    expect(code).toBe(1);
    expect(lines).toEqual([`review-only recovery is held by a model window until ${nextAt}; ask again then`]);
    expect(seen).toEqual([]); // no claim, no session
  });
});
```

Update `tests/review-pending.test.ts`: add `modelCooldownMs: 0` to `config()` (lines 47-52), so a direct second `runTask` is not held by the window. In the tests at lines 157, 172, 188, 207 and 228 the second `runTask` call **drops its fifth argument `{ reviewOnly: true }`**: the resumption is decided by the preserved record, and an explicit review-only claim still requires `blocked`. Then:

- line 77, renamed "preserves work through provider exhaustion and recovers by itself through `taskctl run`": `parked.outcome` is `"open"`; the `review-pending.json` assertion stays; replace the `runCli(["retry", …, "--review-only", …])` call by `runCli(["run", "--config", configPath], { adapter: workerAdapter(calls), acceptance, review, log: () => {} })` with the config `{ tasksDir, workdir, reviewerModel: "r/two" }` (as today: a config file refuses `modelCooldownMs: 0` — `resolveConfig` wants a positive number — and the first attempt's zero window has lapsed); `code` `0`, `review` called once, `calls` `["worker"]`, `acceptance` once, status `done`, `review-pending.json` null; the metrics assertions become `/复核保留\s+0/` and `/只复核恢复\s+1/` (`src/metrics.ts:79-80` count the journal events `review-pending` and `review-only`: a refused review no longer parks, so nothing is preserved by a park), the other two unchanged.
- line 112: `parked` is `"open"`; the recovery is `runCli(["run", "--config", configPath], { adapter: workerAdapter(calls), acceptance: pass, review, log: () => {}, err: (line) => { errors.push(line); } })` with `{ tasksDir, workdir: work, reviewerModel: "r/two" }`; the other assertions stay.
- line 144, renamed "names the cooling reviewer model in the preserved record": `outcome` `"open"`; `review-pending.json`'s `refusals` is `[{ model: "r/one" }]`; `readModelWait(tasks, "a")` matches `{ stage: "review", rounds: 0 }`.
- line 207 and line 228 (the latter renamed "keeps the first window when a recovery is deferred again"): `park` and the second attempt resolve `"open"` instead of `"blocked"`; `again.refusals` has length 2.
- one new case, so the manual path stays covered: "a parked review is still recovered by `taskctl retry --review-only`". Copy `slowReviewer` from `tests/fault-isolation.test.ts:65-82` (it needs `Execution` from `../src/execution.js`, `PromptResult` from `../src/adapters/types.js`, and `doneAdapter` from `./helpers/watch-fixture.js`, which it builds its worker turns on). `runTask({ ...config(), turnTimeoutMs: 300 }, { store, adapter: slowReviewer(), acceptance: pass }, await store.get("a"), "w1")` resolves `"blocked"`, leaves `review-pending.json`, and its journal line `review-pending` says `timed out`. Then `runCli(["retry", "--task", "a", "--review-only", "--config", configPath], { adapter: workerAdapter(calls), acceptance: pass, review, log: () => {} })` with `configPath` naming `{ tasksDir, workdir: work, reviewerModel: "r/two" }` and `review` returning `passVerdict` exits `0`, and the task is `done`.

Update `tests/model-fallback.test.ts:234`, renamed "defers the review without rerunning successful work when no reviewer model is left": `outcome` `"open"`, status `"open"`, `retries` `0`, the two `models` assertions unchanged, `readModelWait(tasks, "a")` matches `{ stage: "review", rounds: 1 }` (import `readModelWait` from `../src/model-wait.js`).

- [ ] **Step 2: Run them and expect FAIL.** `npx vitest run tests/review.test.ts tests/model-rounds.test.ts tests/review-pending.test.ts tests/model-fallback.test.ts` — the new cases receive `"blocked"` where they expect `"open"`, `"done"` or a decision; the automatic resumption dispatches a worker turn (`seen` begins with `"w/one"`); `refusalText` is `undefined`, and the record names the degraded summary where it expects the backend's text; the held recovery runs into the claim path and prints `review-only recovery refused or still unavailable: skipped`.
- [ ] **Step 3: Implement** in `src/worker.ts`:
  1. `runTask`, directly after the deferral gate (which follows line 336 at `c8e604f`):

```ts
    // A task that carries preserved worker/acceptance evidence never goes back
    // through the worker: the claim resumes its review (spec 2026-11-25 §16).
    if (!r.reviewOnly && current.status === "open" && validPending(await readRuntime<ReviewPendingRecord>(cfg.tasksDir, task.id, "review-pending.json"))) {
      r.reviewOnly = true;
    }
```

  `validPending` is the check that line 352 makes today (`if (!reviewPending || typeof reviewPending.definitionDigest !== "string" || typeof reviewPending.artifactDigest !== "string") {`); use it there too.
  2. `reviewStage`: line 1609 (`await resetChainCycles(r.cfg.tasksDir, id, "reviewer");`) becomes `await resetRotation(r.cfg.tasksDir, id, "reviewer");`; after `let handovers = 0;` (line 1607) add `let refusals: ModelRefusal[] = [];`. The `catch` at lines 1614-1617 takes the `ModelsCoolingError` branch of `loop` with `"reviewer"`, `"review"` and `reviewerChain(r)`: `if (!(error instanceof ModelsCoolingError)) throw error;`, then `const cooling = await coolingRefusals(r.cfg.tasksDir, reviewerChain(r));` and `return await refusedRound(r, "review", mergeRefusals(refusals, cooling), refusals.length > 0, error.retryAfter);`. Line 1679 (`if (reviewerModel !== undefined) await clearModelCooldown(r.cfg.tasksDir, reviewerModel);`) becomes `r.run.accepted.set(modelKey(reviewerModel), Date.now()); await clearModelWait(r.cfg.tasksDir, id); if (reviewerModel !== undefined) await clearModelCooldown(r.cfg.tasksDir, reviewerModel);`. Lines 1687-1697, the shared table entry and the journal line `provider-failed`, stay where they are and read the backend's text (design §16): `const said = result.refusalText ?? result.summary ?? "review provider rejected the turn";` is placed first, line 1689 (`reason: result.summary || "review provider rejected the turn",`) becomes `reason: said,` and line 1696 (`detail: result.summary,`) becomes `detail: said,`. Replace lines 1698-1708 (from `const handedOver = handovers < maxHandovers` to `return await parkReviewPending(r, reviewerModel, result.summary || "review provider rejected the turn");`) by the block below:

```ts
    refusals = addRefusal(refusals, {
      model: modelKey(reviewerModel), at: new Date().toISOString(),
      reason: said, source: "turn",
    });
    const handedOver = handovers < maxHandovers
      && await fallBack(r, "reviewer", `review rejected by ${reviewerModel ?? DEFAULT_MODEL_KEY}`);
    if (handedOver) {
      handovers++;
      emit(r, "rework", "reviewer provider failure; retrying with the next model");
      continue;
    }
    // No reviewer is left: the worker and acceptance already produced valid
    // evidence, so the round ends with a deferral and nothing is replayed.
    return await refusedRound(r, "review", refusals, true);
```

  3. Extract `reviewPendingRecord` from `parkReviewPending` (lines 1729-1748): it reads `acceptance.json` and the previous record and returns the `ReviewPendingRecord` with `refusals: [...(previous?.refusals ?? []), ...round].slice(-20)`; `parkReviewPending` calls it with `[{ model: reviewerModel ?? "(default)", reason: reason.slice(0, 1_000) }]` and keeps the rest as it is.
  4. `refusedRound`: before its `owned` block, `const preserved = stage === "review" ? await reviewPendingRecord(r, refusals.map(({ model, reason }) => ({ model, reason }))) : null;`; the block writes `review-pending.json` first when `preserved` is not null.
  5. `holdForRefusal`: when `record.stage === "review"`, it returns `parkReviewFromRecord(cfg, deps, task, record, `own problem: refused in ${rounds} round(s) while ${served} served another task`)` before the note. `parkReviewFromRecord` writes, under the task's mutation mutex, the journal line `{ stage: "review", event: "review-pending", detail: `${last.model}: ${last.reason}; worker/acceptance preserved; ${verdict}` }` with `last = record.refusals.at(-1) ?? { model: DEFAULT_MODEL_KEY, reason: "review provider rejected the turn" }`, then `deps.store.setStatus(task.id, "blocked")`, and emits `blocked` with the detail `parkReviewPending` uses (`review pending: reviewer providers unavailable; worker and acceptance preserved; retry with --review-only`, line 1757).
  6. Delete `blockForCooldown` (lines 839-871), whose last caller was line 1615.
  7. `src/review.ts`: `ReviewResult` gains `refusalText?: string` under Interfaces, after `reviewerSessionId` (line 28). In `startReview` (lines 263-267) the provider branch of `finish` gains `refusalText: refusalText(result.text)`; the branch for a turn that crashed gains nothing. `refusalText` is a local helper with the expression `refusalReason` keeps (`src/model-wait.ts`, Task 1): the first non-empty trimmed line of the text, or `no output`, cut to 240 characters.
  8. `src/cli.ts` `retryCommand`, the `--review-only` branch, after the adapter is made (line 1572) and before anything is created for the attempt (line 1576):

```ts
    // Asked for inside a model window, the recovery is not run: the claim path
    // would hold it, and a `skipped` would say nothing. It says until when.
    const wait = modelWaitHold(await readModelWait(tasksDir, id), newRunContext().id, modelRoundsOf(cfg), new Date());
    if (wait?.kind === "window") {
      log(`review-only recovery is held by a model window until ${wait.nextAt}; ask again then`);
      return 1;
    }
```

  New imports in `src/cli.ts`: `modelRoundsOf`, `modelWaitHold`, `newRunContext`, `readModelWait` from `./model-wait.js`.
- [ ] **Step 4: Run them and expect PASS.** The four files from step 2, then `npx vitest run tests/fault-isolation.test.ts tests/worker-review.test.ts tests/metrics.test.ts`, then `npm run typecheck`.
- [ ] **Step 5: Directed mutation check** on `src/worker.ts`, `src/review.ts` and `src/cli.ts`.

| Mutation | Killed by |
| --- | --- |
| the refused review parks again: the review deferral does not reopen the task | walks the reviewer chain, and a fully refused round defers with the evidence preserved |
| an open task with preserved evidence is claimed as an ordinary attempt: the `r.reviewOnly = true` line becomes `if (false)` | the next claim after the window resumes the review by itself…; an open task that carries preserved evidence… |
| the review deferral does not preserve `review-pending.json`: its write becomes `if (false)` | walks the reviewer chain…; the digest gate still refuses… |
| the reviewer's acceptance is not evidence: line 1679 does not record it | after modelRounds rounds with another task served on a chain model, parks the task as today |
| evidence is asked about the worker's chain: `configuredReviewerChain(cfg, task)` is replaced by `taskChain(cfg, task)` in `settleExhausted` | asks about the chain that refused, not about the worker's chain |
| an outage parks the review: `parkReviewFromRecord` is called before the `model-outage` line | after modelRounds rounds with no task served, keeps the evidence and tells the run to stop |
| the review round keeps the previous position: `resetRotation` is not called in `reviewStage` | the next claim after the window resumes the review by itself… (`seen` would be `review:r/two`) |
| the digest gate is bypassed for an automatic resumption | the digest gate still refuses an automatic resumption on changed artifacts |
| the backend's text is dropped again: the provider branch of `finish` leaves `refusalText` out (`src/review.ts`) | carries the backend's text of a provider refusal…; walks the reviewer chain… (the record's reasons) |
| the text is not bounded: `slice(0, 240)` is dropped from the helper (`src/review.ts`) | carries the backend's text of a provider refusal… (240 characters) |
| the record keeps the degraded summary: `said` reads `result.summary` first (`src/worker.ts`) | walks the reviewer chain, and a fully refused round defers with the evidence preserved |
| a held recovery runs anyway: `if (wait?.kind === "window")` becomes `if (false)` (`src/cli.ts`) | a retry --review-only asked for inside the window is not run, and says until when |
| a held recovery is reported as run: the branch returns `0` (`src/cli.ts`) | a retry --review-only asked for inside the window is not run… |

- [ ] **Step 6: Commit.** `git add src/worker.ts src/review.ts src/cli.ts tests/model-rounds.test.ts tests/review.test.ts tests/review-pending.test.ts tests/model-fallback.test.ts` — `feat(worker): defer a refused review and resume it by itself on the preserved evidence`.

---

### Task 7: `run` waits for windows, stops on an outage, and reports it

**Files:**
- Create: `src/stuck.ts`
- Modify: `src/scheduler.ts` lines 98-107 (`SchedulerOptions`), lines 109-129 (`runScheduler`'s JSDoc, result type and signature), lines 132-134 (the result and the `refused` set), lines 136-143 (the head of the pass), line 146 (`let ranThisPass = 0;`), lines 148-150 (the guard of `startAvailable`), lines 156-166 (the runner), lines 176-180 (the drain loop), lines 182-185 (the `ranThisPass === 0` break), lines 186-195 (the pass budget)
- Modify: `src/worker.ts` line 156 (`WorkerEventType` gains `"model-wait"`)
- Modify: `src/cli.ts` lines 362-426 (`runCommand`: line 364, an insert after line 399, lines 402-425), lines 429-446 (`watchCommand`: lines 430, 436 and 445); export `EXIT_OUTAGE`
- Modify: `src/findings.ts` lines 19-31 (`INTERESTING`)
- Modify: `README.md` (exit codes, after line 330)
- Test: Create `tests/outage.test.ts`; Modify `tests/findings.test.ts` (one case)

**Interfaces:**
- Produces (`src/scheduler.ts`):

```ts
export type SchedulerResult = {
  done: string[]; blocked: string[]; pending: string[]; refused?: string[]; outage?: { taskId: string };
};
export type SchedulerOptions = {
  maxPasses?: number;
  run?: typeof runTask;
  /** Test seams for the wait; production passes neither. */
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
};
export async function runScheduler(cfg: WorkerConfig, deps: WorkerDeps, options?: SchedulerOptions): Promise<SchedulerResult>;
```

`outage` is present only when an outage was declared; `refused` only when something was refused, as today.
- Produces (`src/stuck.ts`):

```ts
export const OUTAGE_PREFIX = "[model-outage]";
export type OutageReport = {
  taskId: string; stage: ModelWaitStage; rounds: number; modelRounds: number;
  firstRefusedAt: string; stoppedAt: string;
  models: Array<{ model: string; reason?: string; source?: "turn" | "table"; at?: string }>;
  waiting: string[];
};
export async function outageReport(cfg: WorkerConfig, board: readonly Task[], taskId: string, now?: Date): Promise<OutageReport>;
export function renderOutageReport(report: OutageReport): string[];
```

- Produces (`src/cli.ts`): `export const EXIT_OUTAGE = 3;`

**What stays as it is.** The budget guard's handling in `runScheduler` is not replaced: line 163 (`if (outcome !== "skipped" && outcome !== "refused") ranThisPass += 1;`), line 166 (`if (outcome === "refused") refused.add(id);`), the filter at line 142 (`ready(snapshot, doneIds).filter((task) => !refused.has(task.id))`) and the one at line 193 stay, a refusal is never a hold and never a deferral, and a pass still reads the board exactly once: `tests/budget-guard.test.ts`, "run offers a refused task but does not count it as progress", counts the listings. The holds, the decision and the wait all use the pass's own `snapshot`. `runWorker` (`src/worker.ts:242-252`) is not changed: only its own tests call it.

- [ ] **Step 1: Write the failing tests** in `tests/outage.test.ts`. Copy the fixture of `tests/scheduler.test.ts` into it: `root`, `tasks`, `cwd`, `store` and their `beforeEach` / `afterEach` (the variables at lines 10-16, `beforeEach` at lines 18-31, `afterEach` at lines 33-35), `seed` (lines 37-54), `config` (lines 106-122), `failGate` (line 126). Imports: `runScheduler`, `type SchedulerOptions` from `../src/scheduler.js`; `EXIT_OUTAGE`, `runCli` from `../src/cli.js`; `resetGuardState` from `../src/budget.js`; `TaskStore` from `../src/task-store.js`; type `AgentAdapter` from `../src/adapters/types.js`; type `WorkerEvent` from `../src/worker.js`; `MODEL_ROUNDS_DEFAULT`, `type ModelWaitRecord`, `type RunContext`, `newRunContext`, `writeModelWait` from `../src/model-wait.js`; `outageReport`, `renderOutageReport` from `../src/stuck.js`; `adapterOf`, `CATALOGUE` from `./helpers/catalogue-fixture.js`; `buildContinuousTask`, `buildTaskFile` from `./helpers/task-fixture.js`; `doneTaskId`, `markDoneTask`, `passAcceptance`, `seedTaskFile` from `./helpers/watch-fixture.js`. The file's `beforeEach` also calls `resetGuardState()`.

```ts
const START = new Date("2026-11-25T10:00:00.000Z");
const idle = (): AgentAdapter => ({
  prompt: async () => { throw new Error("a seam replaced runTask; nothing may be dispatched"); },
  contextUsage: async () => 0, contextLimit: async () => 100,
});
const deferral = (run: RunContext, overrides: Partial<ModelWaitRecord> = {}): ModelWaitRecord => ({
  runId: run.id, stage: "worker", rounds: 1, firstRefusedAt: START.toISOString(), refusals: [],
  nextAt: new Date(START.getTime() + 60_000).toISOString(), updatedAt: START.toISOString(), ...overrides,
});
/** A task that has run out of rounds in `run`, as the attempt leaves it. */
const spent = (run: RunContext): ModelWaitRecord => deferral(run, {
  rounds: MODEL_ROUNDS_DEFAULT,
  refusals: [{ model: "q/one", at: START.toISOString(), reason: "exit 1 in 240ms, Error: 503 service unavailable", source: "turn" }],
});
const settle: NonNullable<SchedulerOptions["run"]> = async (_cfg, deps, task) => {
  await deps.store.setStatus(task.id, "done");
  return "done";
};
const refusing = (): AgentAdapter => ({
  prompt: async () => ({ sessionId: "", exitCode: 1, text: "Error: 503 service unavailable", failure: "provider" as const, tokens: 0 }),
  contextUsage: async () => 0, contextLimit: async () => 100,
});

describe("runScheduler and a deferral", () => {
  it("waits for the nearest time, says so, and runs another pass when nothing else is runnable", async () => {
    await seed("001-a");
    const run = newRunContext(START);
    await writeModelWait(tasks, "001-a", deferral(run));
    let now = START;
    const slept: number[] = [];
    const offered: string[] = [];
    const events: WorkerEvent[] = [];

    const result = await runScheduler(config({ run }), {
      store, adapter: idle(), acceptance: failGate, onEvent: (event) => { events.push(event); },
    }, {
      run: async (cfg, deps, task) => { offered.push(task.id); return settle(cfg, deps, task); },
      now: () => now,
      sleep: async (ms) => { slept.push(ms); now = new Date(now.getTime() + ms); },
    });

    expect(result).toEqual({ done: ["001-a"], blocked: [], pending: [] });
    expect(slept).toEqual([60_000]);
    expect(offered).toEqual(["001-a"]); // not before the wait
    // A wait nobody can see is the anti-goal: one line names the task and the time.
    expect(events.filter((event) => event.type === "model-wait")).toEqual([{
      type: "model-wait", taskId: "001-a",
      detail: "waiting 1m 00s for the next model window (round 1/4; next 2026-11-25T10:01:00.000Z)",
    }]);
  });

  it("a pass that only waited does not count against the pass budget", async () => {
    await seed("001-a");
    const run = newRunContext(START);
    await writeModelWait(tasks, "001-a", deferral(run));
    let now = START;

    const result = await runScheduler(config({ run }), { store, adapter: idle(), acceptance: failGate }, {
      run: settle, now: () => now, sleep: async (ms) => { now = new Date(now.getTime() + ms); }, maxPasses: 1,
    });

    expect(result).toEqual({ done: ["001-a"], blocked: [], pending: [] });
  });

  it("a lapsed deferral whose claim is refused ends the run instead of spinning", async () => {
    await seed("001-a");
    await writeModelWait(tasks, "001-a", deferral(newRunContext(), { nextAt: new Date(Date.now() - 1_000).toISOString() }));
    const slept: number[] = [];
    let offers = 0;

    const result = await runScheduler(config(), { store, adapter: idle(), acceptance: failGate }, {
      run: async () => { offers++; return "skipped"; }, sleep: async (ms) => { slept.push(ms); },
    });

    expect(result).toEqual({ done: [], blocked: [], pending: [] });
    expect(offers).toBe(1);
    expect(slept).toEqual([]);
  });

  it("a deferred task at the head of the queue does not stop the rest of the board", async () => {
    await seed("001-a", ["workdir: a"]);
    await seed("002-b", ["workdir: b"]);
    const run = newRunContext(START);
    await writeModelWait(tasks, "001-a", deferral(run));
    let now = START;
    const offered: string[] = [];

    const result = await runScheduler(config({ parallel: 1, run }), { store, adapter: idle(), acceptance: failGate }, {
      run: async (cfg, deps, task) => { offered.push(task.id); return settle(cfg, deps, task); },
      now: () => now, sleep: async (ms) => { now = new Date(now.getTime() + ms); },
    });

    expect(offered).toEqual(["002-b", "001-a"]); // b first; a once its window has opened
    expect(result).toEqual({ done: ["002-b", "001-a"], blocked: [], pending: [] });
  });

  it("leaves a task the budget guard refused out of the wait and the decision", async () => {
    // The guard's `refused` and a deferral are two exclusions. A guard refusal makes no hold and no
    // round, so the run waits for the deferred task alone and never decides the refused one.
    await seed("001-refused", ["workdir: a"]);
    await seed("002-wait", ["workdir: b"]);
    const run = newRunContext(START);
    await writeModelWait(tasks, "002-wait", deferral(run));
    let now = START;
    const offered: string[] = [];

    const result = await runScheduler(config({ parallel: 1, run }), { store, adapter: idle(), acceptance: failGate }, {
      run: async (cfg, deps, task) => {
        offered.push(task.id);
        return task.id === "001-refused" ? "refused" : settle(cfg, deps, task);
      },
      now: () => now, sleep: async (ms) => { now = new Date(now.getTime() + ms); },
    });

    expect(offered).toEqual(["001-refused", "002-wait"]); // the refused task once, the deferred one after the wait
    expect(result).toEqual({ done: ["002-wait"], blocked: [], pending: [], refused: ["001-refused"] });
  });
});

describe("runScheduler and a task that ran out of rounds", () => {
  it("offers nothing more once a task has run out of rounds, and names that task", async () => {
    await seed("001-a", ["workdir: a"]);
    await seed("002-b", ["workdir: b"]);
    const run = newRunContext(START);
    const offered: string[] = [];

    const result = await runScheduler(config({ parallel: 1, run }), { store, adapter: idle(), acceptance: failGate }, {
      run: async (cfg, deps, task) => {
        offered.push(task.id);
        if (task.id === "001-a") { await writeModelWait(tasks, "001-a", spent(run)); return "open"; }
        return settle(cfg, deps, task);
      },
    });

    // b is next in the queue and is not started: the decision comes first.
    expect(offered).toEqual(["001-a"]);
    expect(result).toEqual({ done: [], blocked: [], pending: [], outage: { taskId: "001-a" } });
  });

  it("leaves a task already in flight to settle", async () => {
    await seed("001-a", ["workdir: a"]);
    await seed("002-b", ["workdir: b"]);
    const run = newRunContext(START);
    let ranOut!: () => void;
    const ranOutAt = new Promise<void>((resolve) => { ranOut = resolve; });

    const result = await runScheduler(config({ parallel: 2, run }), { store, adapter: idle(), acceptance: failGate }, {
      run: async (cfg, deps, task) => {
        if (task.id === "001-a") { await writeModelWait(tasks, "001-a", spent(run)); ranOut(); return "open"; }
        await ranOutAt; // b's work finishes only after a ran out of rounds
        return settle(cfg, deps, task);
      },
    });

    expect(result).toEqual({ done: ["002-b"], blocked: [], pending: [], outage: { taskId: "001-a" } });
  });

  it("never reports an outage while another task is being served", async () => {
    await seed("001-a", ["workdir: a", "model: q/one"]);
    await seed("002-b", ["workdir: b"]);
    const run = newRunContext(START);
    let ranOut!: () => void;
    const ranOutAt = new Promise<void>((resolve) => { ranOut = resolve; });

    const result = await runScheduler(config({ parallel: 2, run }), { store, adapter: idle(), acceptance: failGate }, {
      run: async (cfg, deps, task) => {
        if (task.id === "001-a") { await writeModelWait(tasks, "001-a", spent(run)); ranOut(); return "open"; }
        await ranOutAt; // b's turn is still running when a runs out of rounds…
        run.accepted.set("q/one", START.getTime() + 30_000); // …and is accepted after it, on a model of a's chain: evidence the attempt could not have seen
        return settle(cfg, deps, task);
      },
    });

    expect(result).toEqual({ done: ["002-b"], blocked: ["001-a"], pending: [] });
  });

  it("a run without an outage returns no outage field", async () => {
    await seed("001-a");
    const result = await runScheduler(config(), { store, adapter: idle(), acceptance: failGate }, { run: settle });
    expect(Object.keys(result)).toEqual(["done", "blocked", "pending"]);
  });
});

describe("the outage report", () => {
  it("says what each model said, how long it tried, what is waiting, and whose decision it is", () => {
    expect(renderOutageReport({
      taskId: "003-report", stage: "worker", rounds: 4, modelRounds: 4,
      firstRefusedAt: "2026-11-25T10:00:00.000Z", stoppedAt: "2026-11-25T10:04:03.000Z",
      models: [
        { model: "q/one", reason: "exit 1 in 240ms, Error: weekly limit reached", source: "turn", at: "2026-11-25T10:04:00.000Z" },
        { model: "q/two", reason: "rate limited", source: "table", at: "2026-11-25T10:03:00.000Z" },
        { model: "q/three" },
      ],
      waiting: ["003-report", "004-later"],
    })).toEqual([
      "[model-outage] 003-report: every model refused; stopping here. Nothing is blocked, and every waiting task can simply be run again.",
      "[model-outage]   q/one  exit 1 in 240ms, Error: weekly limit reached",
      "[model-outage]   q/two  not tried in the last round: cooling from another task's refusal at 2026-11-25T10:03:00.000Z — rate limited",
      "[model-outage]   q/three  not tried in the last round",
      "[model-outage]   rounds 4 of 4, over 4m 03s, since 2026-11-25T10:00:00.000Z",
      "[model-outage]   waiting, all still runnable: 003-report, 004-later",
      "[model-outage]   your decision: to use another model, put it into modelChain in taskctl.json, allow it (allowedModels when the backend's catalogue does not report it as free), check it with taskctl models, and run again (taskctl run, or taskctl watch). Models outside the plan may be billed per use.",
    ]);
  });

  it("names each reviewer model's reason from the record, as it names each worker model's", async () => {
    await seedTaskFile(tasks, buildContinuousTask("001-review", { model: "w/one" }));
    await writeModelWait(tasks, "001-review", deferral(newRunContext(START), {
      stage: "review", rounds: MODEL_ROUNDS_DEFAULT,
      refusals: [{ model: "r/one", at: START.toISOString(), reason: "Error: 429 too many requests", source: "turn" }],
    }));

    const report = await outageReport({ ...config(), reviewerModel: "r/one" }, await store.list(), "001-review", new Date("2026-11-25T10:04:03.000Z"));

    expect(report.models).toMatchObject([{ model: "r/one", reason: "Error: 429 too many requests" }]);
    expect(renderOutageReport(report)[1]).toBe("[model-outage]   r/one  Error: 429 too many requests");
  });
});

describe("taskctl run", () => {
  const writeConfig = async (settings: Record<string, unknown>): Promise<string> => {
    const path = join(root, "taskctl.json");
    await writeFile(path, JSON.stringify({ tasksDir: tasks, workdir: cwd, lockTtlMs: 5_000, heartbeatMs: 20, ...settings }), "utf8");
    return path;
  };

  it("prints the report and exits 3 on an outage, leaving every waiting task runnable", async () => {
    await seedTaskFile(tasks, buildContinuousTask("001-a", { model: "q/one" }), buildContinuousTask("002-held"));
    await store.setStatus("002-held", "blocked"); // blocked before the run: it is not "waiting"
    const configPath = await writeConfig({ modelChain: ["q/one"], modelRounds: 1 });
    const lines: string[] = [];

    const code = await runCli(["run", "--config", configPath], { adapter: refusing(), acceptance: passAcceptance, log: (line) => { lines.push(line); }, err: (line) => { lines.push(line); } });

    expect(code).toBe(EXIT_OUTAGE);
    expect(code).toBe(3);
    expect(await store.get("001-a")).toMatchObject({ status: "open", retries: 0 });
    expect(lines.some((line) => line.startsWith("[001-a] outage "))).toBe(true);
    const report = lines.filter((line) => line.startsWith("[model-outage]"));
    expect(report).toHaveLength(5);
    expect(report[0]).toBe("[model-outage] 001-a: every model refused; stopping here. Nothing is blocked, and every waiting task can simply be run again.");
    expect(report[1]).toMatch(/^\[model-outage\]   q\/one  exit 1 in \d+ms, Error: 503 service unavailable$/);
    expect(report[2]).toMatch(/^\[model-outage\]   rounds 1 of 1, over \d+s, since 2026-/);
    expect(report[3]).toBe("[model-outage]   waiting, all still runnable: 001-a");
  });

  it("keeps exit code 0 when a task ends blocked", async () => {
    // The exit code for "tasks were blocked" is 0 today and must not move.
    await seedTaskFile(tasks, buildTaskFile({ id: "001-a", title: "a", acceptance: 'node -e "process.exit(1)"', criteria: ["C1 ok"], model: "q/one", verify: "mechanical" }));
    const configPath = await writeConfig({ modelChain: ["q/one"], retryLimit: 1 });
    const doneMarking: AgentAdapter = {
      prompt: async (args) => { await markDoneTask(args.text, tasks); return { sessionId: "s", exitCode: 0, text: "done" }; },
      contextUsage: async () => 0, contextLimit: async () => 100,
    };

    expect(await runCli(["run", "--config", configPath], {
      adapter: doneMarking, acceptance: async () => ({ passed: false, skipped: false as const, exitCode: 1, output: "no" }), log: () => {}, err: () => {},
    })).toBe(0);
    expect(await store.get("001-a")).toMatchObject({ status: "blocked" });
  });

  it("exits 3, not 1, when a task also hit a controller error", async () => {
    // The code names why the run stopped (design §7); the controller error is still said beside the report.
    await seedTaskFile(tasks, buildContinuousTask("001-b"), buildContinuousTask("002-a", { model: "q/one" }));
    const configPath = await writeConfig({ modelChain: ["q/one"], modelRounds: 1 });
    const flaky = Object.create(store) as TaskStore;
    let failNext = true;
    flaky.appendSession = async (...args: Parameters<TaskStore["appendSession"]>) => {
      if (failNext) { failNext = false; throw new Error("disk full"); }
      return store.appendSession(...args);
    };
    const mixed: AgentAdapter = {
      prompt: async (args) => {
        if (doneTaskId(args.text) === "001-b") { await markDoneTask(args.text, tasks); return { sessionId: "s-b", exitCode: 0, text: "done" }; }
        return { sessionId: "", exitCode: 1, text: "Error: 503", failure: "provider" as const, tokens: 0 };
      },
      contextUsage: async () => 0, contextLimit: async () => 100,
    };
    const lines: string[] = [];

    const code = await runCli(["run", "--config", configPath], { adapter: mixed, acceptance: passAcceptance, store: flaky, log: (line) => { lines.push(line); }, err: (line) => { lines.push(line); } });

    expect(code).toBe(EXIT_OUTAGE);
    expect(lines.some((line) => line.startsWith("[001-b] controller-error "))).toBe(true);
    expect(lines).toContain("[scheduler] 1 task(s) blocked by a controller error; see the controller-error line(s) above");
    expect(lines.some((line) => line.startsWith("[model-outage] 002-a:"))).toBe(true);
    expect(await store.get("001-b")).toMatchObject({ status: "blocked" });
    expect(await store.get("002-a")).toMatchObject({ status: "open" });
  });

  it("exits 3, not 1, when tasks were also refused by the budget guard", async () => {
    // 001-paid runs on a paid model the guard refuses; 002-a runs on a free one the provider refuses.
    // They share one workdir, so they are offered in board order: the refused one first, because a task
    // that has run out of rounds ends the offering and nothing after it would be offered, refused or not.
    await seedTaskFile(tasks, buildContinuousTask("001-paid", { model: "zen/p" }), buildContinuousTask("002-a", { model: "plan/m" }));
    const configPath = await writeConfig({ modelChain: ["plan/m"], modelRounds: 1 });
    const lines: string[] = [];

    const code = await runCli(["run", "--config", configPath], {
      adapter: { ...refusing(), ...adapterOf(CATALOGUE, "plan/m") }, acceptance: passAcceptance,
      log: (line) => { lines.push(line); }, err: (line) => { lines.push(line); },
    });

    expect(code).toBe(EXIT_OUTAGE);
    expect(lines.filter((line) => line.startsWith("[001-paid] refused "))).toHaveLength(1);
    expect(lines).toContain("[scheduler] 1 task(s) refused by the budget guard; no model session was started for them");
    expect(lines.filter((line) => line.startsWith("[model-outage]"))).toHaveLength(5);
    expect(await store.get("001-paid")).toMatchObject({ status: "open", retries: 0 });
  });
});
```

In `tests/findings.test.ts`, one case: a journal line `2026-11-25T10:04:00.000Z  worker  model-outage  rounds 4/4 over 4m 03s since 2026-11-25T10:00:00.000Z; no task served on the chain` yields a signal whose label starts with `模型不可用，整次运行停止` and keeps the raw line in the evidence block.

- [ ] **Step 2: Run them and expect FAIL.** `npx vitest run tests/outage.test.ts tests/findings.test.ts` — the new file fails at the import (`Failed to load url ../src/stuck.js`); the findings case receives no such signal.
- [ ] **Step 3: Implement.**
  - `src/scheduler.ts`. The JSDoc of `runScheduler` (lines 109-124) gains a paragraph: a deferred task is left out until its time has come and the run waits for the nearest time when nothing else is runnable; a task that ran out of rounds ends the offering, and once nothing is in flight the controller decides and the result carries `outage` only then.
    - Head of the pass (lines 140-143): after `refused`, `const eligible = ready(snapshot, doneIds).filter((task) => !refused.has(task.id));`, then `const holds = await holdsOf(eligible.map((task) => task.id));` and `const pending = new Map(eligible.filter((task) => !holds.has(task.id)).map((task) => [task.id, task]));`. `holdsOf` is `modelWaitHolds({ tasksDir: cfg.tasksDir, run: cfg.run ?? processRun(), modelRounds: modelRoundsOf(cfg) }, ids, now())`, built on `options.now ?? (() => new Date())`. With line 146 add `const deferred: string[] = [];` and `let spent = false;`.
    - `startAvailable` (line 150): `if (inflight.size >= limit || spent) return;`.
    - The runner (lines 163-166): after `if (outcome === "refused") refused.add(id);` add

```ts
            if (outcome === "open") {
              deferred.push(id);
              // A task that ran out of rounds ends the offering: what is in
              // flight settles, then the controller decides (spec §6, step 5).
              if (!spent && (await holdsOf([id])).get(id)?.kind === "exhausted") spent = true;
            }
```

    - After the drain loop (lines 176-180), in place of the break at lines 182-185:

```ts
    // The decision an attempt could not take (spec §6, step 5): nothing is in flight now.
    if (deferred.length > 0) {
      const settled = await settleExhausted(cfg, deps, snapshot, deferred, now());
      for (const id of settled.held) if (!result.blocked.includes(id)) result.blocked.push(id);
      if (settled.outage !== undefined) { outage = settled.outage; break; }
    }
    // Nothing ran: no eligible task left, so another pass would change nothing.
    // Progress is "did we run anything", not "did a status string change" — a
    // rework legitimately returns a task to the status it started in.
    if (ranThisPass === 0) {
      // …unless a deferral's time is still ahead: the run waits for the
      // nearest one, and says so, because a wait nobody can see is the anti-goal.
      const next = [...holds]
        .filter((entry): entry is [string, Extract<ModelWaitHold, { kind: "window" }>] => entry[1].kind === "window")
        .sort((a, b) => Date.parse(a[1].nextAt) - Date.parse(b[1].nextAt))[0];
      if (next === undefined) break;
      const ms = Date.parse(next[1].nextAt) - now().getTime();
      if (ms > 0) {
        deps.onEvent?.({
          type: "model-wait", taskId: next[0],
          detail: `waiting ${formatDuration(ms)} for the next model window (round ${next[1].rounds}/${modelRoundsOf(cfg)}; next ${next[1].nextAt})`,
        });
        const before = now().getTime();
        await sleep(ms);
        // A sleep that did not move the clock would wait for ever.
        if (now().getTime() <= before) break;
      }
      continue; // a pass that only waited is not counted
    }
    ran += 1;
    // The backstop is not a statement about how long legitimate work takes. A
    // dependency chain costs one pass per level, so a fixed count used to cut
    // a valid deep chain off and leave the rest in `open` without a word.
    if (ran >= (options.maxPasses ?? passBudget(snapshot.length, cfg))) {
      const after = await deps.store.list();
      const doneNow = new Set(after.filter((task) => task.status === "done").map((task) => task.id));
      // A refused task is not work left for another `run`: that run would refuse it too.
      result.pending = ready(after, doneNow).filter((task) => !refused.has(task.id)).map((task) => task.id);
      break;
    }
```

    `sleep` is `options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))`; `let ran = 0;` and `let outage: { taskId: string } | undefined;` stand beside the `refused` set; the loop is `for (;;)`. Before the return, `if (outage !== undefined) result.outage = outage;` — present only when declared, like `refused` (lines 197-198). New imports in `src/scheduler.ts`: `settleExhausted` from `./worker.js`; `formatDuration`, `modelRoundsOf`, `modelWaitHolds`, `processRun` and `type ModelWaitHold` from `./model-wait.js`.
  - `src/stuck.ts`: `outageReport` reads the task's record (`readModelWait`); its chain is `reviewerChain(cfg, task)` for a review record, else `taskChain(cfg, task)`, or `[DEFAULT_MODEL_KEY]` when empty; `models` lists each chain model with the record's latest refusal when it has one; `firstRefusedAt` is the record's, else its `updatedAt`; `waiting` is every `open` task whose `waitReason` (`src/eligibility.ts:47-60`) is null, in board order. `renderOutageReport` prints the lines pinned above: a model without a refusal says `not tried in the last round`, one from the table says `not tried in the last round: cooling from another task's refusal at <at> — <reason>`.
  - `src/worker.ts`: `WorkerEventType` gains `"model-wait"`.
  - `src/cli.ts` `runCommand`:
    - line 364, `const cfg = resolveConfig(await readConfig(configPath), configPath);`, becomes `const cfg = { ...resolveConfig(await readConfig(configPath), configPath), run: newRunContext() };`
    - after line 399 (the end of the `[scheduler] stopped at the pass budget` message):

```ts
  const outageTaskId = batch === undefined
    ? ("outage" in result ? result.outage?.taskId : undefined)
    : "stoppedAt" in result && result.stoppedAt !== undefined && result.outcome === "outage" ? result.stoppedAt : undefined;
  if (outageTaskId !== undefined) {
    for (const line of renderOutageReport(await outageReport(cfg, await store.list(), outageTaskId))) log(line);
  }
```

    - lines 402-425: the two `log(…)` lines and the `refused` const (lines 409-418) stay as they are; `let failed = false;`, the two `failed = true;` and `return failed ? 1 : 0;` go, and three returns follow the `[scheduler] … refused by the budget guard` line, the outage first, because the code names why the run stopped (design §7): `if (outageTaskId !== undefined) return EXIT_OUTAGE;`, `if (controllerErrors > 0) return 1;`, `return refused.length > 0 ? 1 : 0;`.
    - `BatchResult.outcome` (`src/batch.ts:166`) must admit `"outage"` for the second line to type; Task 8 widens it. Until then write the batch branch of `outageTaskId` in Task 9 and keep here `const outageTaskId = "outage" in result ? result.outage?.taskId : undefined;`.
  - `src/findings.ts`: `INTERESTING` gains `"model-deferred": "等模型窗口（被推迟）"` and `"model-outage": "模型不可用，整次运行停止"`.
  - `README.md`, after the 故障隔离 paragraph of `taskctl run` (line 330, which ends `验收时模型进入冷却不影响已完成的回合。`):

```
**退出码**：`0` 跑完（包括有任务以 `blocked` 或 `awaiting-human` 结束）；`1` 运行错误，或有任务因控制器内部错误而 `blocked`，或有任务被预算护栏拒绝；`2` 用法错误；`3` 因模型不可用停下——每个模型的原因、几轮、多久、还在等的任务都会打印出来，没有任何任务被 `blocked`，改好 `modelChain`（需要的话补上 `allowedModels`，先用 `taskctl models` 看判定）后直接再跑一次即可（见「模型拒绝与轮次」）。因模型不可用停下时一律是 `3`：同一次执行里有任务被护栏拒绝、或有任务因控制器内部错误而 `blocked` 也一样，护栏那几行和控制器错误照常打印在报告旁边。`run` 等模型窗口时先打印一行 `[<id>] model-wait waiting …`。
```

- [ ] **Step 4: Run them and expect PASS.** `npx vitest run tests/outage.test.ts tests/findings.test.ts`, then `npx vitest run tests/scheduler.test.ts tests/budget-guard.test.ts tests/split-flow.test.ts tests/split.test.ts tests/fault-isolation.test.ts tests/cli.test.ts tests/worker.test.ts`, then `npm run typecheck`.
- [ ] **Step 5: Directed mutation check.**

| Mutation (file) | Killed by |
| --- | --- |
| a deferred task is offered anyway: the hold filter becomes `if (false)` (`src/scheduler.ts`) | waits for the nearest time…; a deferred task at the head of the queue… |
| the run does not wait: the `ranThisPass === 0` branch breaks at once (`src/scheduler.ts`) | waits for the nearest time… |
| the run waits without end: `sleep(0)` replaces `sleep(ms)` (`src/scheduler.ts`) | waits for the nearest time… (the clock does not move, so the run must end instead) |
| a waiting pass counts: `ran += 1` is moved above the `ranThisPass === 0` branch (`src/scheduler.ts`) | a pass that only waited does not count against the pass budget |
| the run keeps offering after a task ran out of rounds: `\|\| spent` is dropped from the guard of `startAvailable` (`src/scheduler.ts`) | offers nothing more once a task has run out of rounds, and names that task |
| an in-flight task is abandoned: the loop breaks before draining (`src/scheduler.ts`) | leaves a task already in flight to settle |
| the decision is skipped: the `settleExhausted` call becomes `if (false)` (`src/scheduler.ts`) | offers nothing more once a task has run out of rounds…; never reports an outage while another task is being served |
| the guard's refusal counts as progress again: `&& outcome !== "refused"` is dropped at line 163 (`src/scheduler.ts`) | `tests/budget-guard.test.ts`, "run offers a refused task but does not count it as progress" |
| the wait is silent: the `model-wait` event is not emitted (`src/scheduler.ts`) | waits for the nearest time, says so… |
| the report drops the models that were not tried (`src/stuck.ts`) | says what each model said… |
| the waiting list names blocked tasks too: the `status === "open"` filter in `outageReport` becomes `if (false)` (`src/stuck.ts`) | prints the report and exits 3 on an outage… (`002-held` must stay out of the waiting list) |
| the exit code is 1: `return EXIT_OUTAGE` becomes `return 1` (`src/cli.ts`) | prints the report and exits 3 on an outage… |
| the outage hides behind the guard's refusals: the `refused.length > 0` return is placed above the `EXIT_OUTAGE` one (`src/cli.ts`) | exits 3, not 1, when tasks were also refused by the budget guard |
| a controller error outranks the outage: the `controllerErrors > 0` return is placed above the `EXIT_OUTAGE` one (`src/cli.ts`) | exits 3, not 1, when a task also hit a controller error |
| a controller error is swallowed: the `controllerErrors > 0` return is removed (`src/cli.ts`) | `tests/fault-isolation.test.ts`, "drains the rest of the board and exits 1 when a task hit a controller error" |
| the report drops the reason of a reviewer model: the chain of a review record is read as the worker's (`src/stuck.ts`) | names each reviewer model's reason from the record, as it names each worker model's |

- [ ] **Step 6: Commit.** `git add src/stuck.ts src/scheduler.ts src/worker.ts src/cli.ts src/findings.ts tests/outage.test.ts tests/findings.test.ts README.md` — `feat(scheduler): wait for model windows and stop the run on an outage`.

---

### Task 8: `watch` skips deferred tasks and exits on an outage

**Files:**
- Modify: `src/batch.ts` lines 141-161 (`selectAutomaticBatch`), line 166 (`BatchResult.outcome` admits `"outage"`)
- Modify: `src/watch.ts` lines 70-74 (`watchQueue` signature), line 163 and lines 180-183 (the two `return;`), lines 198-269 (`scheduleOnce`: line 216, line 255, lines 261-268)
- Modify: `src/cli.ts` lines 429-446 (`watchCommand`)
- Modify: `README.md` line 358
- Test: `tests/outage.test.ts` (new describes and fixture); `tests/watch-heartbeat.test.ts` (line 96)

**Interfaces:**
- Produces (`src/watch.ts`):

```ts
export type WatchEnd = { reason: "stop" } | { reason: "outage"; taskId: string };
export async function watchQueue(cfg: WorkerConfig, deps: WorkerDeps, options?: WatchOptions): Promise<WatchEnd>;
```

- `scheduleOnce` returns `"worked" | "wait" | "stopped" | { outage: string }`. It computes `held = await modelWaitHolds(cfg, openIds)` for the `open` tasks of the board, and its ordinary head is `readyTasks(board).find((task) => !cooling(task.id) && !held.has(task.id))`.
- `selectAutomaticBatch(cfg, board)` removes the held tasks from `readyTasks(board)` before walking the contiguous prefix.
- `BatchResult.outcome` (`src/batch.ts:166`) admits `"outage"` from this task on, as Task 9 states it: `scheduleOnce` reads `result.outcome === "outage"` and a test passes that outcome, and both are type-checked in step 4. `runBatch` itself returns that outcome only from Task 9.
- After `runOne` returns `"open"`, `scheduleOnce` calls `settleExhausted(cfg, deps, board, [candidate.id])`; an outage returns `{ outage: taskId }` at once. `watch` is strictly serial, so nothing is in flight at that moment.

**What stays as it is.** The guard's handling beside the deferral: `REFUSED_RETRY_MS` (line 21), the `refusedAt` map (lines 95-97) and the `cooling` test (lines 209-214), the batch branch that notes a refused batch and returns `"worked"` or `"wait"` (lines 237-246), and line 267 (`if (outcome === "refused") refusedAt.set(candidate.id, Date.now());`). A refused task gets no hold and no deferral, so `held` never names it and the two exclusions do their work side by side.

- [ ] **Step 1: Write the failing tests** in `tests/outage.test.ts`. Add to its fixture: `cfg = workerConfigFixture({ tasksDir: tasks, workdir: cwd, lockTtlMs: 5_000, heartbeatMs: 20 })`; `{ listeners, watchFs } = createWatchEventSeam()`; `stop = createStopRequests(tasks, listeners)`; `deps = { store, adapter: idle(), acceptance: passAcceptance }`. The file's `cwd` is the workdir wherever a config is written. Add `processRun` and `readModelWait` to the import from `../src/model-wait.js`, `watchLockPath` from `../src/watch-lock.js`; `stopRequestPath`, `watchQueue` from `../src/watch.js`; `selectAutomaticBatch` from `../src/batch.js`; `createStopRequests`, `createWatchEventSeam`, `workerConfigFixture` from `./helpers/watch-fixture.js`.

The cases that drive the queue through the `runOne` seam seed their tasks with `buildTaskFile`, which is iterative and so is never batched; two continuous tasks would be handed to a batch instead.

```ts
describe("watch", () => {
  it("a deferred task at the head of the queue does not hold the rest of the board", async () => {
    await seedTaskFile(tasks, buildContinuousTask("001-a"), buildContinuousTask("002-b"));
    await writeModelWait(tasks, "001-a", deferral(processRun(), { nextAt: new Date(Date.now() + 60_000).toISOString() }));
    const offered: string[] = [];

    expect(await watchQueue(cfg, deps, {
      watchFs, fallbackMs: 1_000, debounceMs: 5,
      runOne: async (_cfg, _deps, task) => {
        offered.push(task.id);
        if (task.id === "002-b") await stop.request();
        return "done";
      },
    })).toEqual({ reason: "stop" });

    expect(offered).toEqual(["002-b"]);
    expect(await store.get("001-a")).toMatchObject({ status: "open" });
  });

  it("keeps the guard's own handling of a refused task beside the deferral", async () => {
    // 001-a is refused by the guard, 002-b comes back deferred: neither is offered again at once,
    // and 003-c behind them runs. A guard refusal leaves no deferral behind.
    await seedTaskFile(tasks, buildTaskFile({ id: "001-a", title: "a" }), buildTaskFile({ id: "002-b", title: "b" }), buildTaskFile({ id: "003-c", title: "c" }));
    const offered: string[] = [];

    expect(await watchQueue(cfg, deps, {
      // Longer than the fallback scan: a shorter interval re-offers the refused task at every wake.
      watchFs, fallbackMs: 1_000, debounceMs: 5, refusedRetryMs: 10_000,
      runOne: async (_cfg, _deps, task) => {
        offered.push(task.id);
        if (task.id === "002-b") await writeModelWait(tasks, "002-b", deferral(processRun()));
        if (task.id === "003-c") await stop.request();
        return task.id === "001-a" ? "refused" : task.id === "002-b" ? "open" : "done";
      },
    })).toEqual({ reason: "stop" });

    expect(offered).toEqual(["001-a", "002-b", "003-c"]);
    expect(await readModelWait(tasks, "001-a")).toBeNull();
  });

  it("exits on an outage without offering another task, releases its lock, and writes no stop request", async () => {
    await seedTaskFile(tasks, buildTaskFile({ id: "001-a", title: "a" }), buildTaskFile({ id: "002-b", title: "b" }));
    const offered: string[] = [];

    expect(await watchQueue(cfg, deps, {
      watchFs, fallbackMs: 1_000, debounceMs: 5,
      runOne: async (_cfg, _deps, task) => {
        offered.push(task.id);
        await writeModelWait(tasks, task.id, spent(processRun()));
        return "open";
      },
    })).toEqual({ reason: "outage", taskId: "001-a" });

    expect(offered).toEqual(["001-a"]);
    await expect(readFile(watchLockPath(tasks), "utf8")).rejects.toThrow("ENOENT");
    await expect(readFile(stopRequestPath(tasks), "utf8")).rejects.toThrow("ENOENT");
  });

  it("a batch that met an outage ends the queue too", async () => {
    await seedTaskFile(tasks, buildContinuousTask("001-a"), buildContinuousTask("002-b"));

    expect(await watchQueue(cfg, deps, {
      watchFs, fallbackMs: 1_000, debounceMs: 5,
      runBatch: async () => ({ done: [], stoppedAt: "001-a", outcome: "outage", pending: ["002-b"] }),
    })).toEqual({ reason: "outage", taskId: "001-a" });
  });

  it("selectAutomaticBatch leaves a deferred head out and groups what follows", async () => {
    const board = [buildContinuousTask("001-a"), buildContinuousTask("002-b"), buildContinuousTask("003-c")];
    await writeModelWait(tasks, "001-a", deferral(processRun(), { nextAt: new Date(Date.now() + 60_000).toISOString() }));

    expect(await selectAutomaticBatch(cfg, board)).toEqual(["002-b", "003-c"]);
  });
});

describe("taskctl watch", () => {
  it("prints the report and exits 3 on an outage", async () => {
    await seedTaskFile(tasks, buildContinuousTask("001-a", { model: "q/one" }));
    const configPath = join(root, "taskctl.json");
    await writeFile(configPath, JSON.stringify({
      tasksDir: tasks, workdir: cwd, modelChain: ["q/one"], modelRounds: 1, lockTtlMs: 5_000, heartbeatMs: 20,
    }), "utf8");
    const lines: string[] = [];

    const code = await runCli(["watch", "--config", configPath], {
      adapter: refusing(), acceptance: passAcceptance,
      watch: { watchFs, fallbackMs: 1_000, debounceMs: 5 },
      log: (line) => { lines.push(line); }, err: (line) => { lines.push(line); },
    });

    expect(code).toBe(EXIT_OUTAGE);
    expect(lines.filter((line) => line.startsWith("[model-outage]"))).toHaveLength(5);
    await expect(readFile(stopRequestPath(tasks), "utf8")).rejects.toThrow("ENOENT"); // the next watch needs no --resume
    expect(await store.get("001-a")).toMatchObject({ status: "open", retries: 0 });
  });
});
```

`readModelWait` joins the import from `../src/model-wait.js`.

One existing test reads what `watchQueue` resolves to: `tests/watch-heartbeat.test.ts:96`, in "keeps owning the board when one heartbeat cannot be written", has `await expect(queue).resolves.toBeUndefined();`. It becomes `await expect(queue).resolves.toEqual({ reason: "stop" });`. No other test in the repository looks at that value.

- [ ] **Step 2: Run it and expect FAIL.** `npx vitest run tests/outage.test.ts tests/watch-heartbeat.test.ts` — the selection case returns `["001-a", "002-b", "003-c"]`; the first watch case resolves `undefined` after the real batch ran on both tasks (the idle adapter makes `001-a` a controller error, then the seam is called for `002-b`); the other three watch cases and the CLI case never return, and time out: nothing holds a deferred task, and nothing ends a queue whose task keeps coming back `open`; `tests/watch-heartbeat.test.ts` still receives `undefined`.
- [ ] **Step 3: Implement** as under Interfaces. In `watchQueue`: line 163 (`if (await stopRequested(cfg.tasksDir)) return;`) returns `{ reason: "stop" }`; before the `"stopped"` check at lines 180-183, `if (typeof scheduled === "object") return { reason: "outage", taskId: scheduled.outage };`; that check returns `{ reason: "stop" }`. In `scheduleOnce`:
  - after line 216 (`assertAcyclic(board);`), `const held = await modelWaitHolds(cfg, board.filter((task) => task.status === "open").map((task) => task.id));`
  - in the batch branch, after the `refused` block (lines 237-246): `if (result.stoppedAt !== undefined && result.outcome === "outage") return { outage: result.stoppedAt };`
  - line 255: `candidate = selected.length === 1 ? board.find((task) => task.id === selected[0]) : readyTasks(board).find((task) => !cooling(task.id) && !held.has(task.id));`
  - lines 261-268: after `if (outcome === "refused") refusedAt.set(candidate.id, Date.now());` add `if (outcome === "open") { const settled = await settleExhausted(cfg, deps, board, [candidate.id]); if (settled.outage !== undefined) return { outage: settled.outage.taskId }; }`.

  In `src/cli.ts` `watchCommand`: line 430 (`const cfg = await configFor(flags);`) becomes `const cfg = { ...(await configFor(flags)), run: newRunContext() };`; `const end = await watchQueue(…)` inside the `try` replaces the bare call at line 436; after the `finally`, when `end.reason === "outage"`, print the report as `runCommand` does (`for (const line of renderOutageReport(await outageReport(cfg, await store.list(), end.taskId))) log(line);`) and return `EXIT_OUTAGE`; line 445 still returns `0` otherwise. A guard refusal changes nothing here: `watch` returns 0 after one, as it does today.

  In `README.md` append to the paragraph at line 358 (the one that ends `这期间后面的任务照常调度。`):

```
被推迟（等模型窗口）的任务不参与选择，排在它后面的任务照常调度；它的窗口一到，最晚 30 秒后自动再试。出现模型不可用时 watch 打印与 `run` 相同的报告并以退出码 `3` 退出；不会写下 stop 文件，所以下一次 `taskctl watch` 不需要 `--resume`。
```

- [ ] **Step 4: Run it and expect PASS.** `npx vitest run tests/outage.test.ts`, then `npx vitest run tests/watch.test.ts tests/watch-batch.test.ts tests/watch-heartbeat.test.ts tests/batch.test.ts tests/budget-guard.test.ts`, then `npm run typecheck`.
- [ ] **Step 5: Directed mutation check.**

| Mutation (file) | Killed by |
| --- | --- |
| the ordinary head ignores the deferral: `!held.has(task.id)` becomes `if (true)` (`src/watch.ts`) | a deferred task at the head of the queue does not hold… |
| the automatic batch keeps a deferred head (`src/batch.ts`) | selectAutomaticBatch leaves a deferred head out… |
| the outage is read as work: `typeof scheduled === "object"` becomes `if (false)` (`src/watch.ts`) | exits on an outage without offering another task… |
| a batch outage is read as a wait (`src/watch.ts`) | a batch that met an outage ends the queue too |
| the decision is not taken after a deferral: the `settleExhausted` call becomes `if (false)` (`src/watch.ts`) | exits on an outage without offering another task… |
| the guard's `cooling` test is dropped: `!cooling(task.id)` becomes `if (true)` (`src/watch.ts`) | keeps the guard's own handling of a refused task beside the deferral; `tests/budget-guard.test.ts`, "watch runs the task behind a refused one instead of offering it forever" |
| the CLI exits 0 on an outage (`src/cli.ts`) | prints the report and exits 3 on an outage |

- [ ] **Step 6: Commit.** `git add src/batch.ts src/watch.ts src/cli.ts tests/outage.test.ts tests/watch-heartbeat.test.ts README.md` — `feat(watch): skip deferred tasks and exit on an outage`.

---

### Task 9: Batches — refuse a deferred selection, stop on a deferral, stop on an outage

**Files:**
- Modify: `src/batch.ts` lines 54-60 (`probeBatchTask`), lines 88-128 (`validateBatchSelection`), lines 163-169 (`BatchResult`), lines 250-257 (`runBatch`: the deferral stop goes after them)
- Modify: `src/cli.ts` `runCommand` (the `[batch] stopped at` line at `c8e604f:392`, and the batch branch of `outageTaskId`)
- Modify: `README.md` line 344
- Test: `tests/batch.test.ts` (three cases), `tests/outage.test.ts` (one describe)

**Interfaces:**
- A batch does not wait for a window (design §6): a task deferred in a batch stops the batch, the command prints when the task may run again and it exits 0, since nothing is `blocked`; an outage stops the batch with the report of §7 and exit 3 (design §7).
- Produces (`src/batch.ts`): `BatchResult.outcome` is `TaskOutcome | "stop-requested" | "outage"` (its `"outage"` member since Task 8), and `BatchResult.deferredUntil?: string` — present only when the batch stopped on a task deferred for a window. `validateBatchSelection` rejects a selection naming a held task with the issue `task <id>: deferred until <nextAt> (round <n>)`, or `task <id>: its model rounds are spent for the running controller`.
- A batch is serial, so a task that comes back from `runOne` with `"open"` is decided at once, there where nothing else is in flight: `settleExhausted(cfg, deps, board, [selectedTask.id])`. An outage stops the batch with the outcome `"outage"`; a task held as its own problem stops it with `"blocked"`, as any other blocked current task does.

**What stays as it is.** The guard's stop on `refused`: `if (outcome !== "open") { … }` at lines 250-257 returns `outcome` unchanged for `"refused"`, with the rest unclaimed, and `tests/budget-guard.test.ts`, "a batch stops with outcome refused and leaves the rest unclaimed" and "run --batch exits 1 when the batch stops on a refusal", pin it.

- [ ] **Step 1: Write the failing tests.** In `tests/batch.test.ts` (import `newRunContext`, `processRun`, `writeModelWait` from `../src/model-wait.js`). In `describe("validateBatchSelection")`:

```ts
  it("refuses a selection that names a deferred task before any claim", async () => {
    const run = newRunContext();
    cfg.run = run;
    const nextAt = new Date(Date.now() + 60_000).toISOString();
    await mkdir(join(tasksDir, "a"), { recursive: true });
    await writeModelWait(tasksDir, "a", {
      runId: run.id, stage: "worker", rounds: 1, firstRefusedAt: new Date().toISOString(), refusals: [],
      nextAt, updatedAt: new Date().toISOString(),
    });
    const a = eligible("a");
    const b = eligible("b");

    const error = await validateBatchSelection(cfg, ["a", "b"], [a, b]).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BatchValidationError);
    expect((error as BatchValidationError).issues.join("\n")).toBe(`task a: deferred until ${nextAt} (round 1)`);
  });

  it("refuses a selection that names a task whose rounds this run has spent", async () => {
    const run = newRunContext();
    cfg.run = run;
    const now = new Date().toISOString();
    await mkdir(join(tasksDir, "a"), { recursive: true });
    await writeModelWait(tasksDir, "a", {
      runId: run.id, stage: "worker", rounds: 4, firstRefusedAt: now, refusals: [], nextAt: now, updatedAt: now,
    });

    const error = await validateBatchSelection(cfg, ["a"], [eligible("a")]).catch((caught: unknown) => caught);

    expect((error as BatchValidationError).issues.join("\n")).toBe("task a: its model rounds are spent for the running controller");
  });
```

In `describe("runBatch")`:

```ts
  it("stops on a deferred current task and says when it may run again", async () => {
    board = [eligible("a"), eligible("b")];
    const calls: string[] = [];
    const nextAt = new Date(Date.now() + 60_000).toISOString();

    const result = await runBatch(cfg, deps, ["a", "b"], {
      run: async (_cfg, _deps, task) => {
        calls.push(task.id);
        if (task.id === "a") {
          const now = new Date().toISOString();
          await mkdir(join(tasksDir, "a"), { recursive: true });
          await writeModelWait(tasksDir, "a", {
            runId: processRun().id, stage: "worker", rounds: 1, firstRefusedAt: null, refusals: [],
            nextAt, updatedAt: now,
          });
          return "open";
        }
        return "done";
      },
    });

    expect(calls).toEqual(["a"]);
    expect(result).toEqual({ done: [], stoppedAt: "a", outcome: "open", pending: ["a", "b"], deferredUntil: nextAt });
  });

  it("stops on an outage with that outcome and leaves the rest unclaimed", async () => {
    board = [eligible("a"), eligible("b"), eligible("c")];
    const calls: string[] = [];
    const run = newRunContext();
    cfg.run = run;

    const result = await runBatch(cfg, deps, ["a", "b", "c"], {
      run: async (_cfg, _deps, task) => {
        calls.push(task.id);
        if (task.id === "a") {
          const now = new Date().toISOString();
          await mkdir(join(tasksDir, "a"), { recursive: true });
          await writeModelWait(tasksDir, "a", {
            runId: run.id, stage: "worker", rounds: 4, firstRefusedAt: now, refusals: [], nextAt: now, updatedAt: now,
          });
          return "open"; // the attempt that ran out of rounds decides nothing
        }
        return "done";
      },
    });

    expect(calls).toEqual(["a"]);
    expect(result).toEqual({ done: [], stoppedAt: "a", outcome: "outage", pending: ["b", "c"] });
  });
```

In `tests/outage.test.ts`:

```ts
describe("taskctl run --batch", () => {
  it("reports an outage and exits 3", async () => {
    await seedTaskFile(tasks, buildContinuousTask("001-a", { model: "q/one" }), buildContinuousTask("002-b", { model: "q/one" }));
    const configPath = join(root, "taskctl.json");
    await writeFile(configPath, JSON.stringify({
      tasksDir: tasks, workdir: cwd, modelChain: ["q/one"], modelRounds: 1, lockTtlMs: 5_000, heartbeatMs: 20,
    }), "utf8");
    const lines: string[] = [];

    const code = await runCli(["run", "--batch", "001-a,002-b", "--config", configPath], {
      adapter: refusing(), acceptance: passAcceptance, log: (line) => { lines.push(line); }, err: (line) => { lines.push(line); },
    });

    expect(code).toBe(EXIT_OUTAGE);
    expect(lines).toContain("[batch] stopped at 001-a (outage); unclaimed: 002-b");
    expect(lines.filter((line) => line.startsWith("[model-outage]"))).toHaveLength(5);
    expect(await store.get("002-b")).toMatchObject({ status: "open" });
  });

  it("says when a deferred task may run again, and exits 0", async () => {
    await seedTaskFile(tasks, buildContinuousTask("001-a", { model: "q/one" }), buildContinuousTask("002-b", { model: "q/one" }));
    const configPath = join(root, "taskctl.json");
    await writeFile(configPath, JSON.stringify({
      tasksDir: tasks, workdir: cwd, modelChain: ["q/one"], modelRounds: 2, modelCooldownMs: 30_000, lockTtlMs: 5_000, heartbeatMs: 20,
    }), "utf8");
    const lines: string[] = [];

    const code = await runCli(["run", "--batch", "001-a,002-b", "--config", configPath], {
      adapter: refusing(), acceptance: passAcceptance, log: (line) => { lines.push(line); }, err: (line) => { lines.push(line); },
    });

    expect(code).toBe(0);
    expect(lines.some((line) => /^\[batch\] stopped at 001-a \(open\); deferred until \S+, run again then; unclaimed: 001-a, 002-b$/.test(line))).toBe(true);
  });
});
```

- [ ] **Step 2: Run them and expect FAIL.** `npx vitest run tests/batch.test.ts tests/outage.test.ts` — both selections are accepted; in `runBatch` the deferred task and the task that ran out of rounds are offered again until the open budget is spent (`stoppedAt: "a"`, `outcome: "open"`, the rest pending) and no `deferredUntil` is reported; the CLI batch line lacks `deferred until`, and the outage case stops on `001-a` as `skipped`, because the claim-time gate of Task 4 holds the spent task and nothing decides it, so it exits `0`.
- [ ] **Step 3: Implement.** `probeBatchTask` takes `holds: ReadonlyMap<string, ModelWaitHold>` and adds, after the live-lock check at lines 67-69, the issue under Interfaces when the task is held (`hold.kind === "window"` gives `task ${task.id}: deferred until ${hold.nextAt} (round ${hold.rounds})`, otherwise the spent line); `validateBatchSelection` computes `holds` once, for every `open` task on the board (`modelWaitHolds(cfg, board.filter((task) => task.status === "open").map((task) => task.id))`), and passes it to each `probeBatchTask` call (line 119); `selectAutomaticBatch` passes its own (line 154); the held tasks are already filtered out there since Task 8, so it never produces the issue. In `runBatch`, after the `if (outcome !== "open") { … }` block (lines 250-257) and before `if (attempt >= passBudget(1, cfg)) {` (line 258):

```ts
      // A batch is serial, so nothing else is in flight: a task that ran out
      // of rounds is decided here, and a deferral ends the batch, which does
      // not wait inside itself.
      const settled = await settleExhausted(cfg, deps, board, [selectedTask.id]);
      const rest = selected.slice(index + 1).map((task) => task.id);
      if (settled.outage !== undefined) return { done, stoppedAt: settled.outage.taskId, outcome: "outage", pending: rest };
      if (settled.held.includes(selectedTask.id)) return { done, stoppedAt: selectedTask.id, outcome: "blocked", pending: rest };
      const hold = (await modelWaitHolds(cfg, [selectedTask.id])).get(selectedTask.id);
      if (hold !== undefined) {
        return {
          done, stoppedAt: selectedTask.id, outcome,
          pending: selected.slice(index).map((task) => task.id),
          ...(hold.kind === "window" ? { deferredUntil: hold.nextAt } : {}),
        };
      }
```

  In `src/cli.ts` the batch line (line 392 at `c8e604f`) becomes `` `[batch] stopped at ${result.stoppedAt} (${result.outcome})${result.deferredUntil === undefined ? "" : `; deferred until ${result.deferredUntil}, run again then`}; unclaimed: ${result.pending.join(", ") || "none"}` ``, and `outageTaskId`'s scheduler-only line from Task 7 becomes the two-branch form given there. In `README.md` append to the paragraph at line 344 (the one that ends `会停止批次，后续任务不被领取。`):

```
当前任务被推迟（等模型窗口）时批次停下并打印下次可领取时间，退出码 `0`——到点再跑一次即可，批次自己不等待。`--batch` 显式选中的任务若还在推迟窗口内，整批在领取前就被拒绝并说明时间。批次里出现模型不可用时同样打印报告并以退出码 `3` 退出。
```

- [ ] **Step 4: Run them and expect PASS.** `npx vitest run tests/batch.test.ts tests/outage.test.ts`, then `npx vitest run tests/batch-flow.test.ts tests/batch-session.test.ts tests/watch-batch.test.ts tests/budget-guard.test.ts`, then `npm run typecheck`.
- [ ] **Step 5: Directed mutation check.**

| Mutation (file) | Killed by |
| --- | --- |
| a deferred task passes validation: the hold issue becomes `if (false)` (`src/batch.ts`) | refuses a selection that names a deferred task before any claim |
| the deferral stop is dropped: `if (hold !== undefined)` becomes `if (false)` (`src/batch.ts`) | stops on a deferred current task and says when it may run again |
| the deferral stop claims the task is done: `pending` is `slice(index + 1)` (`src/batch.ts`) | stops on a deferred current task… (`pending: ["a", "b"]`) |
| the decision is not taken in the batch: the `settleExhausted` call becomes `if (false)` (`src/batch.ts`) | stops on an outage with that outcome and leaves the rest unclaimed |
| the batch line omits the deferral (`src/cli.ts`) | says when a deferred task may run again, and exits 0 |
| the batch exits 0 on an outage (`src/cli.ts`) | reports an outage and exits 3 |

- [ ] **Step 6: Commit.** `git add src/batch.ts src/cli.ts tests/batch.test.ts tests/outage.test.ts README.md` — `feat(batch): refuse a deferred selection, stop on a deferral and stop on an outage`.

---

### Task 10: The head of the chain for `add` and `split`

The budget guard already judges the clarify session of `taskctl add` and the planner of `taskctl split` (`sessionRefusals`, `src/cli.ts:665-669`): `add` before it writes the task file (line 744), `split` before it calls the planner (line 1015). Since the guard refuses a model that may be billed, there is no plan notice and no `modelPlan` key (design §5). What this task adds is the design's *call* (§16): when `model` is unset, those two use the head of `modelChain` instead of the backend's default model.

**Files:**
- Modify: `src/models.ts`: a new `directModel` before `chainPosition` (after line 113, the end of `reviewerChain`)
- Modify: `src/cli.ts` — line 36 area (a new import from `./models.js` after line 35), lines 660-669 (`sessionRefusals`: its JSDoc, and its body), line 773 (the clarify session's `model`), line 811 (`classification.json`'s `model`), line 1029 (the planner's `model`), line 1040 (the plan's `model`)
- Modify: `README.md` line 40 (the `model` row)
- Test: Create `tests/direct-model.test.ts`

**Interfaces:**
- Produces (`src/models.ts`):

```ts
/** The one model a session that runs on a single model uses: `model`, else the head of `modelChain`; the backend's default when neither is set. */
export function directModel(cfg: { model?: string; modelChain?: string[] }): string | undefined;
```

- `sessionRefusals` judges `directModel(cfg)` — an empty list, so the backend's default, when it is undefined — in place of `cfg.model ? [cfg.model] : []` (line 667). The clarify session and the planner are asked for `directModel(cfg)`; `classification.json` and the split plan record `directModel(cfg) ?? "(backend-default)"`.
- `taskctl models` is not changed: a task's own `model` is listed there on its own (`src/cli.ts:575`).

- [ ] **Step 1: Write the failing tests** in `tests/direct-model.test.ts`.

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter } from "../src/adapters/types.js";
import { resetGuardState } from "../src/budget.js";
import { runCli } from "../src/cli.js";
import { readJournal } from "../src/journal.js";
import { directModel } from "../src/models.js";
import { readRuntime } from "../src/runtime.js";
import { serializeTaskFile } from "../src/task-file.js";
import { TaskStore } from "../src/task-store.js";
import { adapterOf, CATALOGUE } from "./helpers/catalogue-fixture.js";
import { buildTaskFile } from "./helpers/task-fixture.js";

/** A spec with one criterion and a classification, as a clarify session answers. */
const CLARIFIED = "## 目标\n改好\n## 验收标准\n- C1 可验证\n## 管理分类\ncomplex\n## 信息充分性\nclear\n";
/** The guard's line for the shared catalogue's paid model, as `renderVerdicts` writes it. */
const PAID = "- zen/p  provider=zen  enabled=true  variants=-  拒绝：按量计费，约 $15 / 百万 token；未列入 allowedModels";

let root: string;
let tasks: string;
let work: string;
let configPath: string;

/** An adapter that answers every session with `text` and notes the model it was asked for. */
function answering(text: string): { adapter: AgentAdapter; asked: Array<string | undefined> } {
  const asked: Array<string | undefined> = [];
  return {
    asked,
    adapter: {
      prompt: async (args) => { asked.push(args.model); return { sessionId: "s", exitCode: 0, text }; },
      contextUsage: async () => 0, contextLimit: async () => 0,
    },
  };
}

beforeEach(async () => {
  resetGuardState();
  root = await mkdtemp(join(tmpdir(), "taskctl-direct-model-"));
  tasks = join(root, "tasks");
  work = join(root, "work");
  await mkdir(tasks);
  await mkdir(work);
  configPath = join(root, "taskctl.json");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("the model a session that runs on one model uses", () => {
  it("is `model`, else the head of `modelChain`, else the backend's default", () => {
    expect(directModel({ model: "a/one", modelChain: ["c/one"] })).toBe("a/one");
    expect(directModel({ modelChain: ["c/one", "c/two"] })).toBe("c/one");
    expect(directModel({})).toBeUndefined();
  });
});

describe("the clarify session of add and the planner of split", () => {
  it("run on the head of `modelChain` when `model` is unset, and their records say so", async () => {
    await writeFile(configPath, JSON.stringify({ tasksDir: tasks, workdir: work, modelChain: ["plan/a"] }), "utf8");
    const { adapter, asked } = answering(CLARIFIED);

    expect(await runCli(["add", "整理登录模块并补测试", "--config", configPath, "--id", "001-big"], { log: () => {}, adapter })).toBe(0);
    expect(await new TaskStore(tasks).get("001-big")).toMatchObject({ status: "draft" });
    // The answer is not a plan, so `split` rejects it — after asking the planner.
    expect(await runCli(["split", "--task", "001-big", "--config", configPath], { log: () => {}, adapter })).toBe(1);

    expect(asked).toEqual(["plan/a", "plan/a"]);
    expect(await readRuntime<{ model: string }>(tasks, "001-big", "classification.json")).toMatchObject({ model: "plan/a" });
  });

  it("fall back to the backend's default model when neither is set, and the record says so", async () => {
    const { adapter, asked } = answering("## 目标\n改好\n## 验收标准\n- C1 可验证\n");

    expect(await runCli(["add", "一个很小的任务", "--simple", "--tasks-dir", tasks, "--id", "002-tiny"], { log: () => {}, adapter })).toBe(0);

    expect(asked).toEqual([undefined]);
    expect(await readRuntime<{ model: string }>(tasks, "002-tiny", "classification.json")).toMatchObject({ model: "(backend-default)" });
  });

  it("are judged by the budget guard on that model before either starts", async () => {
    // The chain's head is paid and not allowed: no clarify session, no task file.
    await writeFile(configPath, JSON.stringify({ tasksDir: tasks, workdir: work, modelChain: ["zen/p"] }), "utf8");
    const errors: string[] = [];
    const asked: Array<string | undefined> = [];
    const guarded: AgentAdapter = {
      ...adapterOf(CATALOGUE, "plan/m"),
      prompt: async (args) => { asked.push(args.model); return { sessionId: "s", exitCode: 0, text: CLARIFIED }; },
      contextUsage: async () => 0, contextLimit: async () => 0,
    };

    expect(await runCli(["add", "整理表格", "--config", configPath, "--id", "003-paid"], { log: () => {}, err: (line) => { errors.push(line); }, adapter: guarded })).toBe(1);

    expect(errors.join("\n")).toContain(PAID);
    expect(asked).toEqual([]);
    expect(await readdir(tasks)).toEqual([]);
  });

  it("run on the head of `modelChain` when the guard allows it", async () => {
    await writeFile(configPath, JSON.stringify({ tasksDir: tasks, workdir: work, modelChain: ["zen/p"], allowedModels: ["zen/p"] }), "utf8");
    const asked: Array<string | undefined> = [];
    const guarded: AgentAdapter = {
      ...adapterOf(CATALOGUE, "plan/m"),
      prompt: async (args) => { asked.push(args.model); return { sessionId: "s", exitCode: 0, text: CLARIFIED }; },
      contextUsage: async () => 0, contextLimit: async () => 0,
    };

    expect(await runCli(["add", "整理表格", "--config", configPath, "--id", "004-allowed"], { log: () => {}, adapter: guarded })).toBe(0);

    expect(asked).toEqual(["zen/p"]);
    expect(await readRuntime<{ model: string }>(tasks, "004-allowed", "classification.json")).toMatchObject({ model: "zen/p" });
  });

  it("the planner is refused the same way, and that is journaled", async () => {
    await writeFile(join(tasks, "a.md"), serializeTaskFile(buildTaskFile({
      id: "a", title: "导出功能", status: "draft", description: "给产品加导出功能", criteria: ["C1 导出的表格含表头"],
    })), "utf8");
    await mkdir(join(tasks, "a"), { recursive: true });
    await writeFile(join(tasks, "a", "spec.md"), "## 目标\n导出\n\n## 验收标准\n- C1 导出的表格含表头\n", "utf8");
    await writeFile(configPath, JSON.stringify({ tasksDir: tasks, workdir: work, modelChain: ["zen/p"] }), "utf8");
    const errors: string[] = [];
    const asked: Array<string | undefined> = [];
    const guarded: AgentAdapter = {
      ...adapterOf(CATALOGUE, "plan/m"),
      prompt: async (args) => { asked.push(args.model); return { sessionId: "s", exitCode: 0, text: "{}" }; },
      contextUsage: async () => 0, contextLimit: async () => 0,
    };

    expect(await runCli(["split", "--task", "a", "--config", configPath], { log: () => {}, err: (line) => { errors.push(line); }, adapter: guarded })).toBe(1);

    expect(errors).toEqual([PAID]);
    expect(asked).toEqual([]);
    expect((await readJournal(tasks, "a")).find((line) => line.stage === "split" && line.event === "budget-refused")?.detail).toBe("zen/p");
  });
});
```

- [ ] **Step 2: Run it and expect FAIL.** `npx vitest run tests/direct-model.test.ts` — the file fails at the import (`does not provide an export named 'directModel'`). With the function in place and `src/cli.ts` unchanged, the first case would receive `[undefined, undefined]` where it expects the chain's head, the guard cases would pass for the wrong reason (`zen/p` is the backend's default in the catalogue fixture, so the guard refused the default), and the allowed case would ask the session for `undefined`.
- [ ] **Step 3: Implement.** `directModel` is `cfg.model ?? cfg.modelChain?.find((model) => model.trim().length > 0)?.trim()`. In `src/cli.ts` import it from `./models.js`; in `sessionRefusals` (lines 665-669) judge `directModel(cfg) === undefined ? [] : [directModel(cfg)]`; and the JSDoc of `sessionRefusals` (lines 660-664), whose first sentence still says that the session runs on "the configured one or else the backend's default", becomes:

```ts
 * The budget guard for a session that runs on one model — `model`, else the
 * head of `modelChain`, else the backend's default: the clarify session of
 * `add`, the planner session of `split`. The verdicts that were not allowed;
 * empty when the session may start. An adapter that cannot list models is not
 * guarded.
``` line 773 (`model: cfg.model,` in the clarify session's arguments) and line 1029 (the planner's) become `model: directModel(cfg),`; line 811 and line 1040 become `model: directModel(cfg) ?? "(backend-default)",`. In `README.md` replace line 40 with:

```
| `model` | string | — | 兜底模型（`provider/model`）；任务 frontmatter 的 `model` 优先。未设置时，`taskctl add` 的澄清会话与 `taskctl split` 的规划器改用 `modelChain` 的链首，而不是后端默认模型；两者都由预算护栏先判定 |
```

- [ ] **Step 4: Run it and expect PASS.** `npx vitest run tests/direct-model.test.ts`, then `npx vitest run tests/cli-add.test.ts tests/split.test.ts tests/split-flow.test.ts tests/split-plan.test.ts tests/budget-guard.test.ts tests/cli-profile.test.ts tests/feedback.test.ts tests/lanes.test.ts`, then `npm run typecheck`.
- [ ] **Step 5: Directed mutation check.**

| Mutation (file) | Killed by |
| --- | --- |
| the chain's head is ignored: `directModel` returns `cfg.model` (`src/models.ts`) | run on the head of `modelChain` when `model` is unset… |
| the guard judges the configured model only: `sessionRefusals` is back to `cfg.model ? [cfg.model] : []` (`src/cli.ts`) | are judged by the budget guard on that model before either starts; the planner is refused the same way… |
| the session is asked for the configured model again: line 773 is `cfg.model` again (`src/cli.ts`) | run on the head of `modelChain` when the guard allows it (`asked` would be `[undefined]`) |

- [ ] **Step 6: Commit.** `git add src/models.ts src/cli.ts tests/direct-model.test.ts README.md` — `feat(models): add and split run on the head of modelChain when model is unset`.

---

### Task 11: The board's record of a budget-guard refusal

A task the guard refuses is `open`, writes nothing into its own directory, and is not offered again in the same `run`. So nothing on the board says that it is waiting. The design (§6, §8) has the refusal recorded once for the board, outside the task's directory, and `taskctl status --stuck` read that record: asking the guard would read the backend's catalogue, which can take 30 seconds (`CATALOGUE_TIMEOUT_MS`, `src/budget.ts:53`), where the command reads files only today.

**Files:**
- Create: `src/guard-refusals.ts`
- Modify: `src/worker.ts` — lines 254-265 (`reportRefusal`), line 283 and line 375 (its two callers), lines 388-398 (the claim block: the entry leaves here)
- Modify: `src/scheduler.ts` line 138 (`assertAcyclic(snapshot);`), `src/watch.ts` line 216 (`assertAcyclic(board);`), `src/batch.ts` line 93 (`assertAcyclic(board);` in `validateBatchSelection`): one call after each
- Modify: `src/stuck.ts` `outageReport` (Task 7): the waiting list leaves out what the guard refused
- Modify: `README.md` line 468 (the 已知陷阱 bullet `被护栏拒绝是什么样子`)
- Test: Create `tests/guard-refusals.test.ts`; Modify `tests/outage.test.ts` (one case)

**Interfaces:**
- Produces (`src/guard-refusals.ts`):

```ts
/** One refusal of one task, as the guard judged it then: the task, the time, the guard's line. */
export type GuardRefusal = { taskId: string; at: string; line: string };
/** Record or replace the refusal of one task. Never throws. */
export async function recordGuardRefusal(tasksDir: string, taskId: string, line: string, now?: Date): Promise<void>;
/** Remove the entry of one task; nothing is written when it has none. Never throws. */
export async function clearGuardRefusal(tasksDir: string, taskId: string): Promise<void>;
/** Remove the entries of tasks that are no longer `open` on the board. Never throws. */
export async function pruneGuardRefusals(tasksDir: string, board: readonly Pick<Task, "id" | "status">[]): Promise<void>;
/** Every entry, by task id. A missing or unreadable record reads as empty. */
export async function readGuardRefusals(tasksDir: string): Promise<GuardRefusal[]>;
```

- The file is `.taskctl/guard-refusals.json`, `{ version: 1, refusals: Record<taskId, GuardRefusal> }`, in the directory `controlDir` names (`src/watch-lock.ts:8`), beside `model-cooldowns.json`. It is written the way that table is (`mutate`, `src/model-cooldown.ts:72-81`): `mkdir` of the directory, `withMutex` on a lock file of its own (`guard-refusals.lock`), a temporary file beside the target, then `renameWithRetry`. A write that fails removes its temporary file. The record takes a mutex of its own because only a watcher takes the watch lock (`acquireWatchLock`, `src/watch-lock.ts:27`): a `run` and a `watch`, or two `run`s, can be alive on one board.
- Every function swallows its own errors. The record is advisory: a refusal and its line stand without it, and a stale entry must never block a task or end a queue.
- Nothing is created on a board with no record: reading, clearing an absent entry and pruning an empty or absent record neither create `.taskctl` nor take the lock (as `clearModelCooldown` writes nothing when there is no refusal to clear, `src/model-cooldown.ts:64-70`).
- The entries are read back validated: an entry counts only when its `taskId` is its key and `at` and `line` are strings.

- [ ] **Step 1: Write the failing tests** in `tests/guard-refusals.test.ts`.

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter } from "../src/adapters/types.js";
import { validateBatchSelection } from "../src/batch.js";
import { resetGuardState } from "../src/budget.js";
import { clearGuardRefusal, pruneGuardRefusals, readGuardRefusals, recordGuardRefusal, type GuardRefusal } from "../src/guard-refusals.js";
import { runScheduler } from "../src/scheduler.js";
import { TaskStore } from "../src/task-store.js";
import { runTask, type WorkerConfig, type WorkerDeps, type WorkerEvent } from "../src/worker.js";
import { watchQueue } from "../src/watch.js";
import { adapterOf, CATALOGUE } from "./helpers/catalogue-fixture.js";
import { buildContinuousTask, buildTaskFile } from "./helpers/task-fixture.js";
import { createStopRequests, createWatchEventSeam, passAcceptance, seedTaskFile, waitForConditionAsync, workerConfigFixture } from "./helpers/watch-fixture.js";

const AT = "2026-11-25T10:00:00.000Z";
const LATER = "2026-11-25T10:05:00.000Z";
/** What the guard says about the shared catalogue's paid model, exactly as `renderVerdicts` writes it. */
const PAID_LINE = "- zen/p  provider=zen  enabled=true  variants=-  拒绝：按量计费，约 $15 / 百万 token；未列入 allowedModels";

let root: string;
let tasks: string;
let work: string;
let store: TaskStore;
let events: WorkerEvent[];

/** The configuration of a guarded board: no model of its own, so a task runs on the model it declares. */
const config = (overrides: Partial<WorkerConfig> = {}): WorkerConfig => ({
  tasksDir: tasks, workdir: work, agent: "opencode", contextThreshold: 0.8, retryLimit: 3, lockTtlMs: 600_000, heartbeatMs: 60_000, ...overrides,
});
/** The shared catalogue answers the guard: `plan/m` is free, `zen/p` is paid, `kimi/k` is of unknown cost. */
const guarded = (): WorkerDeps => ({ store, adapter: adapterOf(CATALOGUE, "plan/m"), onEvent: (event) => { events.push(event); } });
/** A backend no test may dispatch on. */
const idle = (): AgentAdapter => ({
  prompt: async () => { throw new Error("a seam replaced runTask; nothing may be dispatched"); },
  contextUsage: async () => 0, contextLimit: async () => 100,
});

beforeEach(async () => {
  resetGuardState();
  root = await mkdtemp(join(tmpdir(), "taskctl-guard-refusals-"));
  tasks = join(root, "tasks");
  work = join(root, "work");
  await mkdir(tasks);
  await mkdir(work);
  store = new TaskStore(tasks);
  events = [];
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("the board's record of a budget-guard refusal", () => {
  it("keeps one entry per task, with the time it was judged and the guard's line", async () => {
    const twoLines = `${PAID_LINE}\n- kimi/k  provider=kimi  enabled=true  variants=-  拒绝：成本未知（目录里没有它，或它不报成本）；未列入 allowedModels，provider 也不在 allowedProviders 里`;
    await recordGuardRefusal(tasks, "003-paid", PAID_LINE, new Date(AT));
    await recordGuardRefusal(tasks, "004-gone", PAID_LINE, new Date(AT));
    await recordGuardRefusal(tasks, "003-paid", twoLines, new Date(LATER));

    expect(await readGuardRefusals(tasks)).toEqual([
      { taskId: "003-paid", at: LATER, line: twoLines },
      { taskId: "004-gone", at: AT, line: PAID_LINE },
    ]);
    // Outside every task's directory: the guarantee a refusal is built on.
    expect(await readdir(tasks)).toEqual([]);
    expect(await readdir(join(root, ".taskctl"))).toEqual(["guard-refusals.json"]);
  });

  it("reads a missing, unparsable or malformed record as empty", async () => {
    expect(await readGuardRefusals(tasks)).toEqual([]);
    // Reading is not writing: no record, no `.taskctl`.
    expect(existsSync(join(root, ".taskctl"))).toBe(false);
    await mkdir(join(root, ".taskctl"), { recursive: true });
    const file = join(root, ".taskctl", "guard-refusals.json");
    await writeFile(file, "{ not json", "utf8");
    expect(await readGuardRefusals(tasks)).toEqual([]);
    const malformed: unknown[] = [
      { version: 1, refusals: { "003-paid": { taskId: "003-paid", at: 7, line: "x" } } },
      { version: 1, refusals: { "003-paid": { taskId: "another", at: AT, line: "x" } } },
      { version: 1, refusals: ["003-paid"] },
    ];
    for (const bad of malformed) {
      await writeFile(file, JSON.stringify(bad), "utf8");
      expect(await readGuardRefusals(tasks)).toEqual([]);
    }
  });

  it("removes one task's entry, and writes nothing while the board has no record", async () => {
    await clearGuardRefusal(tasks, "003-paid");
    await pruneGuardRefusals(tasks, [{ id: "003-paid", status: "blocked" }]);
    expect(existsSync(join(root, ".taskctl"))).toBe(false);

    await recordGuardRefusal(tasks, "003-paid", PAID_LINE, new Date(AT));
    await recordGuardRefusal(tasks, "004-gone", PAID_LINE, new Date(AT));
    await clearGuardRefusal(tasks, "003-paid");
    expect(await readGuardRefusals(tasks)).toEqual([{ taskId: "004-gone", at: AT, line: PAID_LINE }]);
    // An entry that is already gone costs no rewrite.
    const file = join(root, ".taskctl", "guard-refusals.json");
    const before = await readFile(file, "utf8");
    await clearGuardRefusal(tasks, "003-paid");
    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("drops the entries of tasks that are no longer open, and only those", async () => {
    await recordGuardRefusal(tasks, "003-paid", PAID_LINE, new Date(AT));
    await recordGuardRefusal(tasks, "004-gone", PAID_LINE, new Date(AT));
    await recordGuardRefusal(tasks, "005-removed", PAID_LINE, new Date(AT));

    await pruneGuardRefusals(tasks, [{ id: "003-paid", status: "open" }, { id: "004-gone", status: "blocked" }]);

    expect(await readGuardRefusals(tasks)).toEqual([{ taskId: "003-paid", at: AT, line: PAID_LINE }]);
  });

  it("never throws: a record that cannot be written or read changes nothing", async () => {
    await mkdir(join(root, ".taskctl", "guard-refusals.json"), { recursive: true }); // a directory where the file should be

    await expect(recordGuardRefusal(tasks, "003-paid", PAID_LINE)).resolves.toBeUndefined();
    await expect(clearGuardRefusal(tasks, "003-paid")).resolves.toBeUndefined();
    await expect(pruneGuardRefusals(tasks, [{ id: "003-paid", status: "open" }])).resolves.toBeUndefined();
    expect(await readGuardRefusals(tasks)).toEqual([]);
    // The temporary file of the write that failed is not left behind.
    expect((await readdir(join(root, ".taskctl"))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

describe("where the record is written and cleared", () => {
  it("is written when the guard refuses a task, and nothing is written into the task's directory", async () => {
    await seedTaskFile(tasks, buildTaskFile({ id: "003-paid", title: "paid", model: "zen/p" }));

    expect(await runTask(config(), guarded(), await store.get("003-paid"), "w")).toBe("refused");

    expect(await readGuardRefusals(tasks)).toEqual([{ taskId: "003-paid", at: expect.any(String), line: PAID_LINE }]);
    expect(events.filter((event) => event.type === "refused")).toHaveLength(1);
    expect(await readdir(tasks)).toEqual(["003-paid.md"]);
  });

  it("is written at the second judgement too, the one after the reservation", async () => {
    // The caller's snapshot names the free plan/m; the board holds the paid zen/p, edited onto it after the caller read it.
    await seedTaskFile(tasks, buildTaskFile({ id: "003-edited", title: "edited", model: "zen/p" }));
    const snapshot = { ...(await store.get("003-edited")), model: "plan/m" };

    expect(await runTask(config(), guarded(), snapshot, "w")).toBe("refused");

    expect((await readGuardRefusals(tasks)).map((entry) => entry.taskId)).toEqual(["003-edited"]);
  });

  it("is recorded at every judgement, with the later time, while the line is said once", async () => {
    await seedTaskFile(tasks, buildTaskFile({ id: "003-paid", title: "paid", model: "zen/p" }));

    await runTask(config(), guarded(), await store.get("003-paid"), "w");
    await recordGuardRefusal(tasks, "003-paid", PAID_LINE, new Date(AT)); // as an earlier process left it
    await runTask(config(), guarded(), await store.get("003-paid"), "w");

    expect(events.filter((event) => event.type === "refused")).toHaveLength(1);
    expect((await readGuardRefusals(tasks))[0]?.at).not.toBe(AT);
  });

  it("leaves when the task is next offered and not refused, before any turn runs", async () => {
    await seedTaskFile(tasks, buildTaskFile({ id: "003-paid", title: "paid", model: "zen/p" }));
    await runTask(config(), guarded(), await store.get("003-paid"), "w");
    expect(await readGuardRefusals(tasks)).toHaveLength(1);

    let atTheTurn: GuardRefusal[] | undefined;
    const asking: AgentAdapter = {
      ...adapterOf(CATALOGUE, "plan/m"),
      prompt: async () => { atTheTurn = await readGuardRefusals(tasks); throw new Error("no turn is needed for this test"); },
    };
    const outcome = await runTask(config({ allowedModels: ["zen/p"] }), { store, adapter: asking }, await store.get("003-paid"), "w");

    expect(outcome).toBe("blocked"); // the turn above failed; what matters is what the record said when it started
    expect(atTheTurn).toEqual([]);
    expect(await readGuardRefusals(tasks)).toEqual([]);
  });
});

describe("a controller settles the record against its board", () => {
  const cfg = (): WorkerConfig => workerConfigFixture({ tasksDir: tasks, workdir: work, lockTtlMs: 5_000, heartbeatMs: 20 });

  it("on every pass of `run`", async () => {
    await seedTaskFile(tasks, buildTaskFile({ id: "003-refused", title: "refused" }));
    await recordGuardRefusal(tasks, "003-refused", PAID_LINE, new Date(AT));

    // Still `open`: the entry stays.
    await runScheduler(cfg(), { store, adapter: idle(), acceptance: passAcceptance }, { run: async () => "refused" });
    expect((await readGuardRefusals(tasks)).map((entry) => entry.taskId)).toEqual(["003-refused"]);

    await store.setStatus("003-refused", "blocked");
    await runScheduler(cfg(), { store, adapter: idle(), acceptance: passAcceptance }, { run: async () => "refused" });

    expect(await readGuardRefusals(tasks)).toEqual([]);
  });

  it("at every scheduling boundary of `watch`", async () => {
    await seedTaskFile(tasks, buildTaskFile({ id: "003-refused", title: "refused", status: "blocked" }));
    await recordGuardRefusal(tasks, "003-refused", PAID_LINE, new Date(AT));
    const { listeners, watchFs } = createWatchEventSeam();
    const stop = createStopRequests(tasks, listeners);
    const running = watchQueue(cfg(), { store, adapter: idle(), acceptance: passAcceptance }, { watchFs, fallbackMs: 10, debounceMs: 5 });

    await waitForConditionAsync(async () => (await readGuardRefusals(tasks)).length === 0);
    await stop.request();

    expect(await running).toEqual({ reason: "stop" });
  });

  it("before an explicit batch is claimed", async () => {
    await seedTaskFile(tasks, buildContinuousTask("a"), buildContinuousTask("b"));
    await recordGuardRefusal(tasks, "a", PAID_LINE, new Date(AT));
    await recordGuardRefusal(tasks, "003-gone", PAID_LINE, new Date(AT));
    const batch = { ...config(), lockTtlMs: 5_000, heartbeatMs: 50 };

    expect((await validateBatchSelection(batch, ["a", "b"], await store.list())).map((task) => task.id)).toEqual(["a", "b"]);

    expect((await readGuardRefusals(tasks)).map((entry) => entry.taskId)).toEqual(["a"]);
  });
});
```

In `tests/outage.test.ts`, in `describe("the outage report")` (import `readGuardRefusals`, `recordGuardRefusal` from `../src/guard-refusals.js`; `outageReport` is already imported):

```ts
  it("a task the budget guard refused is not in the waiting list of the outage report", async () => {
    await seedTaskFile(tasks, buildContinuousTask("001-spent"), buildContinuousTask("004-refused"), buildContinuousTask("005-waiting"));
    await writeModelWait(tasks, "001-spent", spent(newRunContext(START)));
    await recordGuardRefusal(tasks, "004-refused", "- zen/p  provider=zen  enabled=true  variants=-  拒绝：按量计费，约 $15 / 百万 token；未列入 allowedModels", new Date(START));

    const report = await outageReport(config(), await store.list(), "001-spent", new Date("2026-11-25T10:04:03.000Z"));

    // It keeps the guard's own line, which the run printed; it is not "still runnable" work of this report's.
    expect(report.waiting).toEqual(["001-spent", "005-waiting"]);
  });
```

- [ ] **Step 2: Run them and expect FAIL.** `npx vitest run tests/guard-refusals.test.ts tests/outage.test.ts` — the new file fails at the import (`Failed to load url ../src/guard-refusals.js`); the report case receives `["001-spent", "004-refused", "005-waiting"]`.
- [ ] **Step 3: Implement.**
  1. `src/guard-refusals.ts` as under Interfaces.
  2. `src/worker.ts`. `reportRefusal` (lines 254-265) becomes `async function reportRefusal(tasksDir: string, deps: WorkerDeps, taskId: string, refused: readonly ModelVerdict[]): Promise<void>`; after `const detail = renderVerdicts(refused);` (line 263) it calls `await recordGuardRefusal(tasksDir, taskId, detail);`, and the once-per-process test and the event (line 264) stay as they are. Its JSDoc gains: the record is written at every judgement, with its time; only the line is said once. Line 283, `reportRefusal(deps, task.id, refused);`, becomes `await reportRefusal(cfg.tasksDir, deps, task.id, refused);`; line 375, `reportRefusal(deps, r.task.id, refusedHere);`, becomes `await reportRefusal(cfg.tasksDir, deps, r.task.id, refusedHere);`. In the claim block (lines 388-398), first inside the `owned` callback and before line 389 (`await writeRuntime(cfg.tasksDir, task.id, "attempt.json", r.record);`): `await clearGuardRefusal(cfg.tasksDir, task.id); // offered again and judged allowed at both judgements: the entry leaves`. The guarantee of ADR-0012 holds on both paths: the record is in `.taskctl`, and the first path still writes nothing into the task's directory.
  3. The three controllers, each right after its `assertAcyclic` call: `await pruneGuardRefusals(cfg.tasksDir, snapshot);` in `runScheduler`, `await pruneGuardRefusals(cfg.tasksDir, board);` in `scheduleOnce` and in `validateBatchSelection`. They pass the board the pass already listed, so no pass reads the board again.
  4. `src/stuck.ts` `outageReport`: `const refused = new Set((await readGuardRefusals(cfg.tasksDir)).map((entry) => entry.taskId));`, and `waiting` leaves out every task in that set. A task the guard refused is not part of the report (design §7): it keeps the guard's own line.
  5. `README.md` line 468 (the bullet that begins `- **被护栏拒绝是什么样子**：`), append before its final sentence: `被拒的任务记在看板级的 `.taskctl/guard-refusals.json`（任务、判定时间、护栏原话），`taskctl status --stuck` 据此列出它；任务下一次被提供且未被拒绝、或者离开 `open` 时，这条记录随之删除。`
- [ ] **Step 4: Run them and expect PASS.** `npx vitest run tests/guard-refusals.test.ts tests/outage.test.ts`, then `npx vitest run tests/budget-guard.test.ts tests/cli-models.test.ts tests/scheduler.test.ts tests/watch.test.ts tests/batch.test.ts`, then `npm run typecheck`.
- [ ] **Step 5: Directed mutation check.**

| Mutation (file) | Killed by |
| --- | --- |
| the refusal is not recorded: `recordGuardRefusal(…)` becomes `if (false)` (`src/worker.ts`) | is written when the guard refuses a task… |
| the entry is not cleared when the task is allowed through: `clearGuardRefusal(…)` becomes `if (false)` (`src/worker.ts`) | leaves when the task is next offered and not refused… |
| the record is read without validation: an entry is kept whatever its fields (`src/guard-refusals.ts`) | reads a missing, unparsable or malformed record as empty |
| an absent entry is rewritten: the early return in `clearGuardRefusal` is removed (`src/guard-refusals.ts`) | removes one task's entry, and writes nothing while the board has no record |
| pruning keeps a task that left `open`: the `status === "open"` test becomes `if (true)` (`src/guard-refusals.ts`) | drops the entries of tasks that are no longer open… |
| a failed write is not contained: `rm(tmp, …)` is removed from the failure path (`src/guard-refusals.ts`) | never throws: a record that cannot be written or read changes nothing |
| the controllers do not settle the record: the three `pruneGuardRefusals` calls become `if (false)` (`src/scheduler.ts`, `src/watch.ts`, `src/batch.ts`) | on every pass of `run`; at every scheduling boundary of `watch`; before an explicit batch is claimed |
| the outage report lists what the guard refused: the `refused` filter in `outageReport` becomes `if (false)` (`src/stuck.ts`) | a task the budget guard refused is not in the waiting list of the outage report |

- [ ] **Step 6: Commit.** `git add src/guard-refusals.ts src/worker.ts src/scheduler.ts src/watch.ts src/batch.ts src/stuck.ts tests/guard-refusals.test.ts tests/outage.test.ts README.md` — `feat(guard-refusals): record a budget-guard refusal once for the board`.

---

### Task 12: `taskctl status --stuck`

**Files:**
- Modify: `src/stuck.ts` (add `stuckLines` and `statusLineFromNote`; `stuckLines` reads the board's task locks)
- Modify: `src/cli.ts` — line 168 (usage), line 315 (`checkFlags` for `status`), lines 1141-1166 (`statusCommand`), line 1172 (`BOOLEAN_FLAGS`), lines 1977-1993 (`statusLineFromNote` moves to `stuck.ts`)
- Modify: `README.md` line 452 (the usage line) and line 455 (the paragraph after which the new text goes)
- Test: Create `tests/stuck.test.ts`

**Interfaces:**
- Consumes: `waitReason` (`src/eligibility.ts:47-60`), `latestNote`, `readJournal`, `readQuestions`, `readAttempt`, `readRuntime`, `readModelWait`, `readGuardRefusals` (`src/guard-refusals.ts`), `lockLive` and `LOCK_TTL_MS_DEFAULT` (`src/claim.ts`). No adapter and no backend: the command reads files only, and asks the guard for nothing.
- Produces (`src/stuck.ts`):

```ts
/** The first non-empty line of a note's `## Status` section, or `-`. */
export function statusLineFromNote(markdown: string): string;
/** One line per task that is held or waiting, in board order; a single line when there is none. */
export async function stuckLines(tasksDir: string, board: readonly Task[], cfg: { modelRounds?: number; lockTtlMs?: number }): Promise<string[]>;
```

- Line formats, columns joined by two spaces:
  - `blocked`: `<id>  已阻塞  <reason>；自 <since>[；模型：<model>：<reason> | …]`. `reason` is the latest note's `## Status` line, else the last journal `blocked` detail, else `只差复核：<model>：<reason>` from the last entry of `review-pending.json`'s `refusals`, else `attempt.json`'s `reason`, else `-`. `since` is that journal line's time, else `review-pending.json`'s `updatedAt`, else `attempt.json`'s `updatedAt`, else `-`. The models come from `model-wait.json`'s `refusals`, else from `review-pending.json`'s.
  - `open` with a deferral record: `<id>  等模型窗口  第 <rounds>/<modelRounds> 轮，下次 <nextAt>`; when `rounds >= modelRounds` the task's rounds are spent and it waits for the controller's decision, which is taken once no attempt is in flight (design §6, step 5) — while a controller is running, `<id>  等模型窗口  第 <n>/<n> 轮已用尽，等在跑的尝试结算后判断`; when none is, `<id>  等模型窗口  第 <n>/<n> 轮已用尽，等所有者处理：改好配置后新的 taskctl run 从第 0 轮开始`. A controller counts as running when a task on the board has a live attempt, the test the queue makes before a takeover: `lockLive(tasksDir, task.id, cfg.lockTtlMs ?? LOCK_TTL_MS_DEFAULT)` for some task of the board.
  - `open` and named in `.taskctl/guard-refusals.json` (Task 11): `<id>  等护栏放行  <the guard's line, its verdict lines joined by " | ">；判定于 <at>，现在的判定以 taskctl models 为准`. The list prints what was judged then, from the record.
  - `open`, held through a dependency: `<id>  等受阻依赖  <root>：<why>` where `<root>` is the first dependency that is held directly or through a chain of `open` tasks, written `<root>（经 <direct>）` when the direct dependency differs, and `<why>` is that task's own `已阻塞：<reason>`, `等放行：<note>`, `等签字` or `不在看板上`.
  - `awaiting-human`: `<id>  等放行  <note status line or ->`.
  - `draft`: `<id>  等签字[（拆分包：N 个子任务随之放行）]`, with `；待回答问题 N 条（<path>）` appended when `questions.md` exists; any other status with `questions.md`: `<id>  待回答问题 N 条（<path>）`.
  - Nothing held: `没有受阻或等待的任务`

- [ ] **Step 1: Write the failing tests** in `tests/stuck.test.ts`. Imports: `afterEach`, `beforeEach`, `describe`, `expect`, `it` from `vitest`; `mkdir`, `mkdtemp`, `rm`, `writeFile` from `node:fs/promises`; `tmpdir` from `node:os`; `join` from `node:path`; type `AgentAdapter` from `../src/adapters/types.js`; `runCli` from `../src/cli.js`; `claim` from `../src/claim.js`; `recordGuardRefusal` from `../src/guard-refusals.js`; `writeModelWait` from `../src/model-wait.js`; `writeQuestions` from `../src/questions.js`; `writeRuntime` from `../src/runtime.js`; `TaskStore` from `../src/task-store.js`; `buildTaskFile` from `./helpers/task-fixture.js`; `seedTaskFile` from `./helpers/watch-fixture.js`. Fixture: `root`, `tasks`, `store`; `lines`, `errors`; `stuck = () => runCli(["status", "--stuck", "--tasks-dir", tasks], { log: (line) => { lines.push(line); }, err: (line) => { errors.push(line); } })`.

```ts
const AT = "2026-11-25T10:00:00.000Z";

describe("taskctl status --stuck", () => {
  it("runs through the real parser as a boolean flag", async () => {
    expect(await stuck()).toBe(0);
    expect(lines).toEqual(["没有受阻或等待的任务"]);
    expect(errors).toEqual([]);
  });

  it("lists nothing that is ready, running or done, and leaves `status` as it was", async () => {
    await seedTaskFile(tasks, buildTaskFile({ id: "001-open" }), buildTaskFile({ id: "002-running", status: "running" }), buildTaskFile({ id: "003-done", status: "done" }));

    expect(await stuck()).toBe(0);
    expect(lines).toEqual(["没有受阻或等待的任务"]);
    const plain: string[] = [];
    await runCli(["status", "--tasks-dir", tasks], { log: (line) => { plain.push(line); }, err: () => {} });
    expect(plain[0]).toMatch(/^id\s+status\s+retries\s+sessions\s+note/);
    expect(plain.join("\n")).toContain("001-open");
    expect(plain.join("\n")).not.toContain("已阻塞");
  });

  it("says why a task is blocked and since when", async () => {
    await seedTaskFile(tasks, buildTaskFile({ id: "001-blocked", status: "blocked" }));
    await mkdir(join(tasks, "001-blocked"), { recursive: true });
    await writeFile(join(tasks, "001-blocked", "journal.md"), `${AT}  worker  blocked  retry limit reached\n`, "utf8");

    await stuck();

    expect(lines).toEqual(["001-blocked  已阻塞  retry limit reached；自 " + AT]);
  });

  it("for a model refusal, names every model and what it said", async () => {
    await seedTaskFile(tasks, buildTaskFile({ id: "001-own", status: "blocked" }));
    await writeModelWait(tasks, "001-own", {
      runId: "run", stage: "worker", rounds: 4, firstRefusedAt: AT, nextAt: AT, updatedAt: AT,
      refusals: [
        { model: "q/one", at: AT, reason: "exit 1 in 240ms, Error: input too long", source: "turn" },
        { model: "q/two", at: AT, reason: "exit 1 in 100ms, Error: refused", source: "turn" },
      ],
    });
    await mkdir(join(tasks, "001-own"), { recursive: true });
    await writeFile(join(tasks, "001-own", "journal.md"), `${AT}  worker  blocked  refused by every model in 4 round(s) while q/two served another task; retries untouched\n`, "utf8");

    await stuck();

    expect(lines).toEqual(["001-own  已阻塞  refused by every model in 4 round(s) while q/two served another task; retries untouched；自 " + AT
      + "；模型：q/one：exit 1 in 240ms, Error: input too long | q/two：exit 1 in 100ms, Error: refused"]);
  });

  it("says when only the review is missing", async () => {
    await seedTaskFile(tasks, buildTaskFile({ id: "001-park", status: "blocked" }));
    await writeRuntime(tasks, "001-park", "review-pending.json", {
      definitionDigest: "d", artifactDigest: "a", createdAt: AT, updatedAt: AT,
      refusals: [{ model: "r/one", reason: "review timed out after 300ms" }],
    });

    await stuck();

    expect(lines).toEqual(["001-park  已阻塞  只差复核：r/one：review timed out after 300ms；自 " + AT]);
  });

  it("says which dependency will not finish, directly and through a chain", async () => {
    await seedTaskFile(tasks,
      buildTaskFile({ id: "001-root", status: "blocked" }),
      buildTaskFile({ id: "002-mid", dependsOn: ["001-root"] }),
      buildTaskFile({ id: "003-leaf", dependsOn: ["002-mid"] }),
      buildTaskFile({ id: "004-free" }));
    await mkdir(join(tasks, "001-root"), { recursive: true });
    await writeFile(join(tasks, "001-root", "journal.md"), `${AT}  worker  blocked  retry limit reached\n`, "utf8");

    await stuck();

    expect(lines).toEqual([
      "001-root  已阻塞  retry limit reached；自 " + AT,
      "002-mid  等受阻依赖  001-root：已阻塞：retry limit reached",
      "003-leaf  等受阻依赖  001-root（经 002-mid）：已阻塞：retry limit reached",
    ]);
  });

  it("shows a deferred task's round and next time, and a spent one", async () => {
    await seedTaskFile(tasks, buildTaskFile({ id: "001-wait" }), buildTaskFile({ id: "002-spent" }));
    const base = { runId: "run", stage: "worker" as const, firstRefusedAt: AT, refusals: [], updatedAt: AT };
    await writeModelWait(tasks, "001-wait", { ...base, rounds: 2, nextAt: "2026-11-25T10:01:00.000Z" });
    await writeModelWait(tasks, "002-spent", { ...base, rounds: 4, nextAt: AT });

    await stuck();

    // No attempt is in flight: the run that spent these rounds has stopped, as one does for an outage.
    expect(lines).toEqual([
      "001-wait  等模型窗口  第 2/4 轮，下次 2026-11-25T10:01:00.000Z",
      "002-spent  等模型窗口  第 4/4 轮已用尽，等所有者处理：改好配置后新的 taskctl run 从第 0 轮开始",
    ]);
  });

  it("says a spent deferral is waiting for the attempts in flight while a controller is running", async () => {
    await seedTaskFile(tasks, buildTaskFile({ id: "001-spent" }), buildTaskFile({ id: "002-running", status: "running" }));
    await writeModelWait(tasks, "001-spent", { runId: "run", stage: "worker", rounds: 4, firstRefusedAt: AT, nextAt: AT, refusals: [], updatedAt: AT });
    // What a live attempt leaves: the lock `claim` wrote is still beating.
    expect(await claim(tasks, "002-running", "w", 600_000)).toBe(true);

    await stuck();

    expect(lines).toEqual(["001-spent  等模型窗口  第 4/4 轮已用尽，等在跑的尝试结算后判断"]);
  });

  it("lists what needs a person", async () => {
    await seedTaskFile(tasks,
      buildTaskFile({ id: "001-human", status: "awaiting-human" }),
      buildTaskFile({ id: "002-draft", status: "draft" }),
      buildTaskFile({ id: "003-parent", status: "draft" }),
      buildTaskFile({ id: "004-child", status: "open", parentId: "003-parent" }),
      buildTaskFile({ id: "005-asked", status: "draft" }));
    await runCli(["note", "--task", "001-human", "--status", "等老板确认", "--done", "d", "--found", "f", "--next", "n", "--tasks-dir", tasks], { log: () => {}, err: () => {} });
    await writeQuestions(tasks, "005-asked", ["多大？", "何时？"], "intake");

    await stuck();

    expect(lines).toEqual([
      "001-human  等放行  等老板确认",
      "002-draft  等签字",
      "003-parent  等签字（拆分包：1 个子任务随之放行）",
      "005-asked  等签字；待回答问题 2 条（" + join(tasks, "005-asked", "questions.md") + "）",
    ]);
  });

  it("lists a task the budget guard refused from the board's record, and asks no backend", async () => {
    const paid = "- zen/p  provider=zen  enabled=true  variants=-  拒绝：按量计费，约 $15 / 百万 token；未列入 allowedModels";
    const unknown = "- kimi/k  provider=kimi  enabled=true  variants=-  拒绝：成本未知（目录里没有它，或它不报成本）；未列入 allowedModels，provider 也不在 allowedProviders 里";
    await seedTaskFile(tasks, buildTaskFile({ id: "001-refused" }), buildTaskFile({ id: "002-free" }));
    await recordGuardRefusal(tasks, "001-refused", `${paid}\n${unknown}`, new Date(AT));
    // What was judged then, from the record. Asking the guard would read the backend's catalogue.
    const asking: AgentAdapter = {
      modelCatalog: async () => { throw new Error("the stuck list must not ask the guard"); },
      prompt: async () => { throw new Error("the stuck list must not start a session"); },
      contextUsage: async () => 0, contextLimit: async () => 0,
    };

    expect(await runCli(["status", "--stuck", "--tasks-dir", tasks], { adapter: asking, log: (line) => { lines.push(line); }, err: (line) => { errors.push(line); } })).toBe(0);

    expect(lines).toEqual([`001-refused  等护栏放行  ${paid} | ${unknown}；判定于 ${AT}，现在的判定以 taskctl models 为准`]);
    expect(errors).toEqual([]);
  });

  it("no longer lists a guard refusal once the task has left open", async () => {
    await seedTaskFile(tasks, buildTaskFile({ id: "001-refused", status: "blocked" }));
    await recordGuardRefusal(tasks, "001-refused", "- zen/p  provider=zen  enabled=true  variants=-  拒绝：按量计费，约 $15 / 百万 token；未列入 allowedModels", new Date(AT));
    await mkdir(join(tasks, "001-refused"), { recursive: true });
    await writeFile(join(tasks, "001-refused", "journal.md"), `${AT}  worker  blocked  retry limit reached\n`, "utf8");

    await stuck();

    expect(lines).toEqual(["001-refused  已阻塞  retry limit reached；自 " + AT]);
  });
});
```

`004-child` (an `open` split child behind a draft parent) is covered by its parent's line and is not listed on its own.

- [ ] **Step 2: Run it and expect FAIL.** `npx vitest run tests/stuck.test.ts` — every case exits `2`: `taskctl: unexpected argument "<tasks dir>"`, because `--stuck` is read as a value flag and takes `--tasks-dir` as its value, which leaves the tasks directory as a stray positional.
- [ ] **Step 3: Implement.** `src/cli.ts`: usage line 168 (`"  taskctl status [--tasks-dir <dir>]",`) becomes `"  taskctl status [--stuck] [--tasks-dir <dir>]",`; line 315 (`checkFlags(command, flags, ["tasks-dir", "config"], [])` under `case "status":`) becomes `checkFlags(command, flags, ["tasks-dir", "config", "stuck"], [])`; `"stuck"` is added to `BOOLEAN_FLAGS` (line 1172); `statusCommand` resolves `const cfg = await configFor(flags)` when `flags.has("stuck")`, lists the board with `store.list()`, and prints `stuckLines(tasksDir, board, cfg)` instead of the table; it returns 0 and prints nothing about ignored files. `statusLineFromNote` moves to `src/stuck.ts`; `cli.ts` imports it (`waitingOn`, line 1210, uses it). `stuckLines` walks the board in order and applies the rules under Interfaces; the dependency walk keeps a `Set` of visited ids and stops at 64 levels. A controller counts as running when `lockLive(tasksDir, task.id, cfg.lockTtlMs ?? LOCK_TTL_MS_DEFAULT)` is true for a task of the board. In `README.md` line 452 (`npx tsx src/main.ts status [--tasks-dir <dir>]`) becomes `npx tsx src/main.ts status [--stuck] [--tasks-dir <dir>]`, and after the paragraph at line 455 (which ends `不参与调度。`):

```markdown
`taskctl status --stuck` 只列出受阻或等待的任务，每个一行，只读文件、不问后端：

| 行 | 说明 |
| --- | --- |
| `已阻塞` | 原因（来自交接笔记或最近一条 blocked 日志）、起始时间；因模型拒绝而阻塞的逐个列出模型和拒绝原话；只差复核的写 `只差复核：<模型>：<原因>` |
| `等受阻依赖` | 等的是哪个任务（隔了一层时写 `A（经 B）`），以及那个任务为什么受阻 |
| `等模型窗口` | 第 n/`modelRounds` 轮、下次可领取时间；轮次用尽的：有尝试在跑时写明等它们结算后判断，没有时写明等所有者处理，新的 `taskctl run` 从第 0 轮开始 |
| `等护栏放行` | 被预算护栏拒绝的任务：护栏当时的原话和判定时间（来自 `.taskctl/guard-refusals.json`）；现在的判定以 `taskctl models` 为准 |
| `等放行` / `等签字` / `待回答问题` | `awaiting-human`、等签字的 `draft`（含待回答的问题） |

没有这样的任务时只打印一行「没有受阻或等待的任务」。当你问「哪些任务卡住了」，答案就是这个命令的输出。
```

- [ ] **Step 4: Run it and expect PASS.** `npx vitest run tests/stuck.test.ts`, then `npx vitest run tests/cli.test.ts tests/board.test.ts tests/dependencies.test.ts tests/outage.test.ts`, then `npm run typecheck`.
- [ ] **Step 5: Directed mutation check.**

| Mutation (file) | Killed by |
| --- | --- |
| `--stuck` is left out of `BOOLEAN_FLAGS` (`src/cli.ts`) | runs through the real parser as a boolean flag |
| `--stuck` is not allowed by `checkFlags` (`src/cli.ts`) | runs through the real parser as a boolean flag |
| a ready task is listed (`src/stuck.ts`) | lists nothing that is ready, running or done, and leaves `status` as it was |
| the dependency walk stops at the direct dependency | says which dependency will not finish, directly and through a chain |
| the models of a refusal are not shown | for a model refusal, names every model and what it said |
| a spent deferral reads like a live one | shows a deferred task's round and next time, and a spent one |
| a spent deferral waits for attempts that are not running: the liveness test becomes `if (true)` (`src/stuck.ts`) | shows a deferred task's round and next time, and a spent one; says a spent deferral is waiting for the attempts in flight while a controller is running |
| a spent deferral waits for the owner while attempts are running: the liveness test becomes `if (false)` (`src/stuck.ts`) | says a spent deferral is waiting for the attempts in flight while a controller is running |
| an empty list prints nothing | runs through the real parser as a boolean flag |
| the guard's record is ignored (`src/stuck.ts`) | lists a task the budget guard refused from the board's record… |
| a guard refusal is still listed after the task left `open` (`src/stuck.ts`) | no longer lists a guard refusal once the task has left open |

- [ ] **Step 6: Commit.** `git add src/stuck.ts src/cli.ts tests/stuck.test.ts README.md` — `feat(status): add status --stuck`.

---

### Task 13: A manual `retry` keeps the deferral's time and starts its rounds again

**Files:**
- Modify: `src/reconcile.ts` — `retryTask` (lines 161-164: after the task is reopened). `ATTEMPT_EVIDENCE` (line 125) is not touched.
- Modify: `README.md` line 489 (the paragraph that lists what `retry` moves)
- Test: `tests/reconcile.test.ts` (one case in `describe("retry")`); `tests/outage.test.ts` (one case in `describe("watch")`)

**Interfaces:**
- Produces: a manual `retry` of a task that carries `model-wait.json` rewrites the record with `rounds: 0`, `firstRefusedAt: null` and `updatedAt` set to the retry's time; `nextAt` is kept, and so are `runId`, `stage` and `refusals`. `ATTEMPT_EVIDENCE` stays `["attempt.json", "acceptance.json", "review.json", "models.json", "review-pending.json"]`, as it is today. This is the design's call (§6): the earliest time already recorded is kept — a retry is not a reason to ask again a model that refused a moment ago — and the count and the time of the first refusal are cleared, so the retry buys a fresh `modelRounds`.

- [ ] **Step 1: Write the failing tests** in `tests/reconcile.test.ts` (import `modelCooldown`, `noteModelRefusal` from `../src/model-cooldown.js`; `readModelWait`, `writeModelWait` from `../src/model-wait.js`):

```ts
  it("keeps the earliest time of a deferral, starts its rounds again, and leaves the shared table alone", async () => {
    await writeTask("blocked", { retries: 2 });
    await writeAttempt("settled");
    const nextAt = new Date(Date.now() + 60_000).toISOString();
    await writeModelWait(tasksDir, "t1", {
      runId: "run", stage: "worker", rounds: 4, firstRefusedAt: new Date(Date.now() - 60_000).toISOString(),
      refusals: [], nextAt, updatedAt: new Date().toISOString(),
    });
    await noteModelRefusal(tasksDir, "q/one", { reason: "rate limited", cooldownMs: 600_000 });

    const outcome = await retryTask(tasksDir, "t1", { registryDir, now: new Date("2026-11-25T08:00:00.000Z") });

    expect(outcome.ok).toBe(true);
    expect(await readdir(join(tasksDir, "t1", "archive", "2026-11-25T08-00-00-000Z"))).not.toContain("model-wait.json");
    expect(await readModelWait(tasksDir, "t1")).toMatchObject({ rounds: 0, firstRefusedAt: null, nextAt });
    expect(await modelCooldown(tasksDir, "q/one")).not.toBeNull();
  });
```

And one case in `tests/outage.test.ts`, in `describe("watch")` (import `retryTask` from `../src/reconcile.js`; `type ModelWaitRecord` is already imported):

```ts
  it("offers a task the owner retried by hand again after its recorded time, from round 0, and does not block it again at once", async () => {
    await seedTaskFile(tasks, buildTaskFile({ id: "001-a", title: "a" }));
    // As a run leaves a task it held as its own problem: blocked, its rounds spent, its next time still ahead.
    const nextAt = new Date(Date.now() + 400).toISOString();
    await writeModelWait(tasks, "001-a", deferral(processRun(), { rounds: MODEL_ROUNDS_DEFAULT, nextAt }));
    await store.setStatus("001-a", "blocked");
    const offered: Array<{ at: number; record: ModelWaitRecord | null }> = [];
    // A bound on a queue that never offers the task: the case then fails on `offered`, not on time.
    const safety = setTimeout(() => { void stop.request(); }, 5_000);

    const running = watchQueue(cfg, deps, {
      watchFs, fallbackMs: 50, debounceMs: 5,
      runOne: async (_cfg, _deps, task) => {
        offered.push({ at: Date.now(), record: await readModelWait(tasks, task.id) });
        // Refused again: a first round, not a fifth.
        await writeModelWait(tasks, task.id, deferral(processRun(), { rounds: 1, nextAt: new Date(Date.now() + 60_000).toISOString() }));
        await stop.request();
        return "open";
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 100)); // the queue is running, and leaves the blocked task alone
    expect(await retryTask(tasks, "001-a", { baseWorkdir: cwd, registryDir: join(root, "registry") })).toMatchObject({ ok: true });

    expect(await running).toEqual({ reason: "stop" });
    clearTimeout(safety);
    expect(offered).toHaveLength(1);
    expect(offered[0]!.at).toBeGreaterThanOrEqual(Date.parse(nextAt)); // not before the recorded time
    expect(offered[0]!.record).toMatchObject({ rounds: 0, firstRefusedAt: null, nextAt });
    expect(await store.get("001-a")).toMatchObject({ status: "open" }); // not held as its own problem on the first new round
  });
```

- [ ] **Step 2: Run them and expect FAIL.** `npx vitest run tests/reconcile.test.ts tests/outage.test.ts` — the record is as it was, `rounds: 4` and the time of the first refusal kept; the watch offers the retried task at its next wake, before the recorded time, with no record left.
- [ ] **Step 3: Implement.** In `src/reconcile.ts` `retryTask`, inside the mutex after `await store.setStatus(id, "open");` (line 163):

```ts
    // The deferral stays (design §6): a retry is not a reason to ask again a
    // model that refused a moment ago. Its earliest time is kept; its rounds
    // start again, so the retry buys a fresh `modelRounds`.
    const wait = await readModelWait(tasksDir, id);
    if (wait !== null) {
      await writeModelWait(tasksDir, id, { ...wait, rounds: 0, firstRefusedAt: null, updatedAt: now.toISOString() });
    }
```

  (`readModelWait`, `writeModelWait` from `./model-wait.js`; a write that fails fails the retry like the journal line beside it.) In `README.md` line 489, the list of what `retry` moves (today `` `attempt.json`、`acceptance.json`、`review.json`、`models.json` ``) becomes `` `attempt.json`、`acceptance.json`、`review.json`、`models.json`、`review-pending.json` ``, and after ``写一条 `human retry` 日志。`` the paragraph adds ``推迟记录 `model-wait.json` 不归档：`retry` 保留它已经记下的最早可领取时间，把轮次和第一次被拒的时间清零——这次 `retry` 买到的是全新的一轮 `modelRounds`，而刚拒绝过的模型不会被立刻再撞。``
- [ ] **Step 4: Run them and expect PASS.** `npx vitest run tests/reconcile.test.ts tests/outage.test.ts`, then `npm run typecheck`.
- [ ] **Step 5: Directed mutation check.**

| Mutation (file) | Killed by |
| --- | --- |
| the retry archives the deferral again: `"model-wait.json"` is added to `ATTEMPT_EVIDENCE` (`src/reconcile.ts`) | keeps the earliest time of a deferral…; offers a task the owner retried by hand again after its recorded time, from round 0… (offered before the recorded time) |
| the retry keeps the spent rounds: `rounds: 0` is dropped from the rewrite (`src/reconcile.ts`) | keeps the earliest time of a deferral…; offers a task the owner retried by hand… (the watch never offers it) |
| the retry moves the recorded time: `nextAt` is replaced by a time already past (`src/reconcile.ts`) | keeps the earliest time of a deferral…; offers a task the owner retried by hand again after its recorded time, from round 0… (offered before the recorded time) |
| the retry clears the shared table: `retryTask` calls `clearModelCooldown` for the task's chain (`src/reconcile.ts`) | keeps the earliest time of a deferral… (`modelCooldown` would be null) |

- [ ] **Step 6: Commit.** `git add src/reconcile.ts tests/reconcile.test.ts tests/outage.test.ts README.md` — `fix(reconcile): keep a deferral's time and start its rounds again on a manual retry`.

---

### Task 14: Documentation kept in step

**Files:**
- Modify: `README.md` — lines 57-58 (`modelChain`, `chainCycles` rows), line 137 (辅助文件), line 188 (the `Reviewer 不可用` bullet), line 476 (the first paragraph of 排障), lines 501, 503, 505 and 509 (排障: the paragraphs at 501, 505 and 509 are replaced, the one at 503 is deleted); a new subsection before `### taskctl run --batch — 连续批次` (the heading at line 336); the recommended configuration after the `memory` sub-table of the `taskctl.json` section (after line 87; `## 任务文件` follows at line 89)
- Modify: `docs/superpowers/specs/2026-11-24-adaptive-execution-design.md` — before the first paragraph of §14.1 (line 442) and of §9 (line 270)
- Modify: `GLOSSARY.md` (two entries, and one sentence in `拒绝（Refused）`)

**Interfaces:** none (documentation only).

- [ ] **Step 1: No failing test.** This task changes no runtime behaviour; its check is the gate in step 4.
- [ ] **Step 2: —**
- [ ] **Step 3: Make the edits.**

`README.md`:

- Line 57, the `modelChain` row: replace `配额耗尽时按这条链推进（见「派发失败」）` with `被 provider 拒绝时按这条链推进（见「模型拒绝与轮次」）`.
- Line 58, the `chainCycles` row: replace `回绕是重探此前拒绝过的模型（它的配额窗口可能已经重置），退避照常；整个循环都耗尽才 \`blocked\` 等所有者决策。新一轮 attempt / 复核轮重新计圈，轮换位置保留` with `回绕是重探此前拒绝过的模型（它的配额窗口可能已经重置），退避照常；回绕只在一轮之内发生，整个循环都被拒绝即本轮结束（见「模型拒绝与轮次」）。每一轮（也就是每次 attempt）与每个复核轮重新计圈`.
- After the `memory` sub-table of the `taskctl.json` section (after line 87; `## 任务文件` follows at line 89), the recommended configuration the design asks the README to show (§5): the four models of the owner's plan, in his order, as `modelChain`, with `allowedProviders` naming the plan's provider. Nothing is hard-coded for a provider — it is a configuration, spelled as the repository's documents spell the ids; Task 16 checks it against the catalogue:

````markdown
**推荐配置（只用编码套餐里的模型）**：`modelChain` 按你的顺序列出套餐里的模型，`allowedProviders` 点名套餐的 provider——目录把它们报成免费、或不报成本，都放行：

```json
{
  "modelChain": [
    "zhipuai-coding-plan/glm-5.4",
    "zhipuai-coding-plan/glm-5.3",
    "zhipuai-coding-plan/glm-5.3-highspeed",
    "zhipuai-coding-plan/glm-5.3-flash"
  ],
  "allowedProviders": ["zhipuai-coding-plan"]
}
```

这样配置之后，护栏只放行这个 provider 的模型：别的 provider 的免费模型、任何按量计费的模型（包括同名的按量孪生，如 `zhipuai/glm-5.3`）、以及目录里不报成本又没被点名的模型，一律拒绝——要用套餐之外的模型，把它写进 `modelChain` 并用 `allowedModels` 点名，那是你的决定。跑之前先用 `taskctl models` 看一遍判定。
````
- Line 137: after `\`models.json\`（模型降级链的当前位置）` add `、\`model-wait.json\`（模型窗口的推迟记录：轮次、本次执行里第一次被拒的时间、每个模型的拒绝原话、下次可领取时间）`.
- Line 188, replace the bullet by:

```
- **Reviewer 不可用**：reviewer 被 provider 拒绝不增加 worker retry，也不重放已成功的 worker/验收。任务带着保留的现场回到 `open`（`review-pending.json` 与推迟记录），窗口一到控制器自己只跑复核；连续 `modelRounds` 轮被拒后由控制器按证据规则决定（见「模型拒绝与轮次」）。reviewer **超时**则照旧以 `blocked + review-pending.json` 保留现场：换到健康 Reviewer 后执行 `taskctl retry --task <id> --review-only`，定义和产物摘要一致才只跑 Review。reviewer **崩溃**不是拒绝，判不出来转 `awaiting-human`。没有单独配复核链时复核沿用 worker 链。恢复时评审员看到的时间窗是**产出这些证据的那次尝试**的时间窗（第一次保留现场时记进 `review-pending.json`），不是恢复这次尝试的。
```

- New subsection, inserted before `### taskctl run --batch — 连续批次`:

````markdown
### 模型拒绝与轮次

provider 拒绝（429 / 配额 / 鉴权 / 5xx / `no-route`，即 adapter 标出的 `failure: "provider"`）说的是账号或模型，不是任务。无论被拒的回合是否已经干了活，它都**不花 `retries`**，也**不会让任务 `blocked`**：

- **一轮**是把派发链（`modelChain` → `modelFallbacks`）从头走一遍，每个模型试一次；被拒就立刻换下一个。每一轮都从链首开始；`chainCycles` 与配额退避只在一轮之内生效。
- 一轮里每个模型都拒绝（或都还在共享冷却窗口内），这次 attempt 结束：任务回到 `open`，带一份**推迟记录** `tasks/<id>/model-wait.json`——轮次、本次执行里第一次被拒的时间、每个模型的拒绝原话、下次可领取时间（`modelCooldownMs`，默认 60 秒）。时间没到之前，调度器和领取处都不会碰它，和依赖没完成时一样。
- `run` 在没有别的任务可跑时，等到最近的下一次时间再来一轮（等之前打印一行 `[<id>] model-wait waiting …`）；`watch` 每 30 秒醒一次，同样只靠领取处的这道门。看板级共享冷却表 `.taskctl/model-cooldowns.json` 只负责「窗口内别再撞同一个模型」，不再造成 `blocked`，也**不当作证据**。只有任务自己被拒的那一轮才计数；整个链都因为别的任务的拒绝而在冷却、于是什么都没派发的那一次不计数，它的下次时间是这些窗口里最早到期的那个。
- 连续 `modelRounds` 轮（默认 4，约 4–5 分钟）没有任何模型接受之后，attempt 自己**不做判断**，只把轮次记下。控制器等到没有任何尝试在跑时才看这次执行自己的证据：**期间有没有别的任务在链上某个模型上成功过一个回合。** 另一个任务的回合正在跑时就先等它结算——它可能就是证据。
  - 有：模型是好的，问题在这个任务自己。只把它 `blocked`，交接笔记逐个写出每个模型和它的拒绝原话；依赖它的任务照常等，其余任务继续。
  - 没有：这是模型不可用。任务原样留在 `open`、`retries` 不动，整次 `run` 或 `watch` 停下并打印报告（每个模型的原因、几轮、多久、还在等的任务），退出码 **3**。改好 `modelChain`（需要的话补上 `allowedModels`，先用 `taskctl models` 看判定）后直接再跑一次 `taskctl run`（或 `taskctl watch`），所有等待的任务自动继续，不需要逐个 `retry`。
- 「成功过一个回合」指 worker 回合退出码为 0，或 reviewer 给出了判决；超时或崩溃的回合不算。证据按模型记在这一次执行里，不落盘，也从不读共享冷却表——那张表每个模型只有一条，会被最近一次拒绝覆盖。
- 同一次执行里轮次用尽的任务不会再被提供；新的一次 `run` / `watch` 从第 0 轮算起。手工 `taskctl retry` 不归档推迟记录：它保留已经记下的最早可领取时间，把轮次和第一次被拒的时间清零——这次 `retry` 买到全新的一轮 `modelRounds`；共享冷却表照旧不清，刚拒绝过的模型不会被立刻再撞。
- **预算护栏的拒绝不是这里的拒绝。** 护栏判定的是「这个模型要不要花钱」，被拒的任务没有会话启动、没有模型被问，所以不开始一轮、不写推迟记录、也不算证据。`run` 对它只提供一次，照常打印护栏原话并以退出码 1 结束；`watch` 五分钟内不再拿它，批次在它那里停下。被拒的任务记在 `.taskctl/guard-refusals.json`，`taskctl status --stuck` 据此列出它。推迟在调度器里是护栏之外的**第二重**排除：两者都不算进展，都等到各自的时间为止。两种等待并不一样——推迟会让 `run` 等一等再试，因为 provider 的拒绝会过去；护栏的拒绝不会，因为读到的目录在进程存活期间不会变。
- 复核阶段同理：reviewer 被拒不花任何额度，也不重放 worker 的工作和验收。窗口一到，控制器自己对保留下来的证据只跑复核（`review-pending.json` 与它的摘要门）；`modelRounds` 轮之后由控制器按同一条证据规则决定——留给人（`blocked` + `review-pending.json`），或按模型不可用停下并保留证据。reviewer **超时不是拒绝**，保持今天的 park（`blocked` + `review-pending.json`，`taskctl retry --review-only` 恢复）；**崩溃也不是拒绝**，保持今天的处理：判不出来转 `awaiting-human`。复核阶段的轮次单独计数，所以一个任务可以先作为 worker、再作为被复核的任务，各被推迟 `modelRounds` 轮。窗口还没到时执行 `taskctl retry --review-only`，命令不会跑，而是打印等到几点再来。复核没有单独配链时沿用 worker 链；worker 的链首刚拒绝过，复核就从接手的那个模型开始。

随时可以问「哪些任务卡住了、为什么」：`taskctl status --stuck`。
````

- Line 476: replace `，以及派发链上所有模型都配额耗尽。` with `。模型拒绝**不再**让任务 `blocked`：它只会推迟任务，最多在连续 `modelRounds` 轮、且期间另有任务被服务之后，才以「本任务自身的问题」阻塞。`
- Line 501 becomes:

```
**provider 拒绝（429 / 鉴权 / 5xx / 配额耗尽）** —— adapter 把它标成 `failure: "provider"`。这类失败说的是账号或模型，不是任务：不花 `retries`，不 `blocked`，立刻换链上的下一个模型；一整轮都被拒就把任务推迟到下一个窗口（`modelCooldownMs`，默认 60 秒）。连续 `modelRounds` 轮之后才由控制器做判断，规则与报告见「模型拒绝与轮次」。想立刻知道哪些任务在等：`taskctl status --stuck`。
```

- Line 503 (the old `**配额耗尽…**` paragraph) is deleted: the paragraph above and the new subsection say all of it.
- Line 505 becomes:

```
**模型降级链** —— 配了 `modelChain` / `modelFallbacks` / `reviewerModelFallbacks` 时，被 provider 拒绝的那一次不会去花重试额度，而是把这一回合交给链上的下一个模型。换模型同时是**会话边界**：上一个后端创建的会话不会交给下一个模型续，被拒的回合也不记进 `sessions`（它没干活）。复核被拒时在复核阶段内部换模型重试，不会把任务退回 worker 重跑——非幂等任务（写表、移文件）不能为了重试一次复核而被执行两遍。
```

- Line 507 keeps the paragraph Task 4 wrote. Line 509 becomes:

```
`models.json` 是提示性状态不是证据：**读**不到、读坏了、或者记的位置属于另一个模型（比如主模型被改过），一律按"从链首开始"；**写**不进去则不算换成了——本轮到此结束（推迟），并记一条 `model-fallback-failed` 日志。显式 `chainCycles` 在一轮之内的重探仍按原语义执行。
```

- Line 511 is unchanged.

`docs/superpowers/specs/2026-11-24-adaptive-execution-design.md`, inserted before the first paragraph of each named section:

§14.1:

```markdown
> **2026-11-25 — superseded by [the model-trouble design](2026-11-25-model-trouble-and-operator-control-design.md) §6.** A cooling model is still skipped within its window, but "the task stops with the next probe time" no longer holds: a task whose chain is fully refused or cooling is deferred (`open`, with `tasks/<id>/model-wait.json`) and offered again when the window expires, and after `modelRounds` the controller decides between the task's own problem and an outage stop. `modelCooldownMs` defaults to 60 seconds. Of "The existing per-task chain position and `chainCycles` remain" only `chainCycles` holds: the position is reset at the start of every round.
```

§9:

```markdown
> **2026-11-25 — partly superseded by [the model-trouble design](2026-11-25-model-trouble-and-operator-control-design.md) §16.** Steps 1–3 still hold for a refused reviewer, but step 4 no longer parks a refused review: the task stays `open` with the preserved evidence, and the controller resumes the review by itself when the model window reopens. The park of steps 4–5, recovered by `retry --review-only`, remains for a reviewer that timed out and for a review refused in `modelRounds` rounds while another task was served.
```

`GLOSSARY.md`, two entries after `阻塞（Blocked）`, and one sentence at the end of the body of `拒绝（Refused）`:

```markdown
**轮（Round）**:
把一条派发链从头到尾走一遍、每个模型试一次，每一轮从链首开始；全部被拒则本次 attempt 结束，任务带着推迟记录等待下一个窗口。轮次只在一次 run 内累计，worker 与复核两个阶段各算各的。

**推迟（Deferral）**:
任务因链上所有模型都拒绝或仍在冷却窗口而回到 `open` 时携带的运行时记录（`tasks/<id>/model-wait.json`）；时间没到之前不会被领取。它不是任务状态。
_Avoid_: 阻塞、挂起、暂停、park、拒绝（Refused，那是预算护栏的结局，不写推迟记录）
```

In `拒绝（Refused）`, after `也不需要人工恢复。` add `` 被拒的任务记在看板级的 `.taskctl/guard-refusals.json`，`taskctl status --stuck` 据此列出它。 ``

- [ ] **Step 4: Run the gates.** `npm test`, `npm run typecheck`, `npx tsc --noEmit`, `git diff --check` — all clean. Then read the README once from the configuration table to 排障 and check that no sentence still says a refusal blocks a task or that the rotation survives a round: `Select-String -Path README.md -Pattern '15 分钟|用光才 blocked|才 `blocked`|整条链都拒绝时|不会又先撞'` must print nothing.
- [ ] **Step 5: No mutation** (no runtime change).
- [ ] **Step 6: Commit.** `git add README.md GLOSSARY.md docs/superpowers/specs/2026-11-24-adaptive-execution-design.md` — `docs: describe rounds, deferrals, the outage stop, the guard's record and the stuck list`.

---

### Task 15: Final gates and the handoff note

**Files:**
- Modify: `docs/superpowers/plans/2026-11-24-handoff.md` — §1 (the gate bullet at line 13 and the "仍未在真实后端验证" bullet at line 15), §2 (the commit table, lines 21-41), §3 (items 1 and 4, lines 52 and 55)

**Interfaces:** none.

- [ ] **Step 1: No failing test.**
- [ ] **Step 2: —**
- [ ] **Step 3: Update the handoff.**
  - §1, line 13: replace the counts and the commit with those the gate run prints (`<N> passed / <M> skipped`, `<k>` files, the seconds, the commit hash of Task 14).
  - §1, line 15: append `；推迟、轮次与模型不可用停止（2026-11-25 的设计，目前只有离线证据）` to the list of what is still unverified on the real backend, which already names every refusal and cooldown path.
  - §2: one row per commit of this plan, in the table's format (`<hash>` | what it changes | `2026-11-25 计划`).
  - §3, item 1: append `。**已决定并实现（2026-11-25）**：拒绝不再 `blocked`，改为按轮推迟；`modelCooldownMs` 默认 60 秒、`modelRounds` 默认 4；连续 `modelRounds` 轮后由控制器按「期间是否有别的任务在链上模型上成功过」只阻塞本任务，或整次停下（退出码 3）。预算护栏的拒绝不算在内，它保持自己的结局和退出码 1。见 `docs/superpowers/specs/2026-11-25-model-trouble-and-operator-control-design.md`。`
  - §3, item 4: append `。**2026-11-25**：冷却这一半已解决——被推迟的任务窗口一到会自动再被提供；「只启动一次」对模型拒绝不再成立。待复核的 park（超时）仍需 `retry --review-only`。`
- [ ] **Step 4: Run the gates.** `npm test` (about 35 s), `npm run typecheck`, `npx tsc --noEmit`, `git diff --check`; then the two smoke scripts in offline mode: `.\scripts\smoke.ps1` and `.\scripts\live-phase2.ps1` (each exits 0 and calls no model).
- [ ] **Step 5: No mutation.**
- [ ] **Step 6: Commit.** `git add docs/superpowers/plans/2026-11-24-handoff.md` — `docs: record the refusal rounds in the handoff`.

---

### Task 16: Live — a real refusal and the outage stop (needs the owner's explicit authorization)

The implementer does not run this task until the owner says so, in writing, for this run. Step 5 costs no model quota: an unknown model is refused by the provider before any work — but only once the budget guard has let the task through (design §13).

**Files:** none in the repository, except `README.md` if the catalogue spells a model of the plan differently from the README's recommended configuration (step 3). Everything else happens in a scratch directory outside any repository.

- [ ] **Step 1: Preconditions.** `opencode --version` is 2.4.1. If it is newer, check `opencode run --format json` events, `session.get`, `session.message.list` and `model.list` against what `src/adapters/opencode.ts` reads, and stop on any difference: that is a finding for the owner, not something to patch in a live run.
- [ ] **Step 2: Setup.** In the scratch directory write `taskctl.json`:

```json
{
  "tasksDir": "tasks",
  "workdir": ".",
  "modelChain": ["zhipuai-coding-plan/no-such-model-taskctl-outage-check"],
  "allowedModels": ["zhipuai-coding-plan/no-such-model-taskctl-outage-check"],
  "modelCooldownMs": 5000,
  "modelRounds": 2
}
```

An invalid model is of unknown cost, so the budget guard refuses a task that would run on it before any session starts, and the provider is never asked (ADR-0012). For this check the owner allows it by name (`allowedModels`; naming its provider in `allowedProviders` would do as well). Write `tasks/001-probe.md` with `schema: taskctl/v1`, `title: outage probe` (`title` is the one other required field: without it the file does not parse), `status: open`, `acceptance: node -e "process.exit(0)"`, `verify: mechanical`, `complexity: simple`, `execution: continuous`, `sessions: []`, `retries: 0`.
- [ ] **Step 3: The guard allows the plan's models, and then the invalid one.** First the recommended configuration the README shows (Task 14): copy it as it stands into a `taskctl.json` of its own — the four models of the plan as `modelChain`, `allowedProviders` naming the plan's provider — and run `npx tsx <repo>/src/main.ts models --config <that file>`. It must print four verdict lines, one per model of the plan, each `enabled=true` and reading `放行`. That is the check that the README spells the ids as the catalogue does. The verdict alone would not do: `allowedProviders` lets every id of the plan's provider through, known or not (`decide` in `src/budget.ts`), and only `enabled=-` shows an id the catalogue does not list. For such a line, look the model up in the backend's own list (`opencode api model.list`, the call `taskctl models` reads; it starts no session), correct `modelChain` in the README's recommended configuration to the catalogue's spelling, and say so in the report. A line that reads `拒绝` names a model the owner has to allow or mend before anything runs: stop and report. Then the probe's own configuration: `npx tsx <repo>/src/main.ts models --config taskctl.json`. The line of the invalid model must read `放行（成本未知）`. If it reads `拒绝`, stop and report: the run in step 5 would end with the guard's line and exit code 1, and would say nothing about a provider refusal.
- [ ] **Step 4: Run and record.** `npx tsx <repo>/src/main.ts run --config taskctl.json`; then `npx tsx <repo>/src/main.ts status --stuck --tasks-dir tasks`. Record, verbatim: the exit code (expected `3`), the `[001-probe] model-deferred` lines (expected two, `round 1/2` and `round 2/2`), the `[001-probe] outage` line, the `[model-outage]` block, the stuck line (expected `001-probe  等模型窗口  第 2/2 轮已用尽，等所有者处理：改好配置后新的 taskctl run 从第 0 轮开始` — no attempt is in flight once the run has exited), and the provider's reason exactly as the report prints it.
- [ ] **Step 5: What must be true.** The exit code is `3`; `tasks/001-probe.md` is still `open` with `retries: 0`; the reason line shows the backend's own error for an unknown model and the attempt was classed as a refusal. If the attempt instead ended `blocked` with `shutdown unconfirmed` or `uncertain`, the backend's error text is not recognised by `PROVIDER_REJECTION` (`src/adapters/opencode.ts:25`): stop, keep the output, and report it. Do not widen the regular expression under a live run.
- [ ] **Step 6: Recover without `retry`.** Put a model of the plan first in `modelChain`, run the same command again, and record that `001-probe` runs and ends `done` with no `taskctl retry` in between.
- [ ] **Step 7: Report to the owner**, verbatim output included, and the correction made to the README's recommended configuration, if the catalogue spelled a model differently. No commit.

---

### Task 17: Live — a refused review resumes by itself (needs the owner's explicit authorization)

This costs one real worker turn and, at step 5, one real review turn. Same rule as Task 16: not run until the owner authorizes it.

**Files:** none in the repository.

- [ ] **Step 1: Preconditions.** Those of Task 16, step 1.
- [ ] **Step 2: Setup.** A scratch board with one task `verify: human` and one criterion, and a `taskctl.json` whose worker chain is a model of the plan and whose `reviewerModel` is `zhipuai-coding-plan/no-such-model-taskctl-review-check`, with `modelCooldownMs: 5000`, `modelRounds: 2`. The invalid reviewer model is of unknown cost, so `allowedModels` names it (design §13).
- [ ] **Step 3: The guard allows every model first.** `npx tsx <repo>/src/main.ts models --config taskctl.json`: every line must read `放行`. A line that reads `拒绝` names a model the owner has to allow in `taskctl.json` before the run means anything.
- [ ] **Step 4: Run and record.** `npx tsx <repo>/src/main.ts run --config taskctl.json`: the worker turn is real; the review is refused twice; record the exit code (expected `3`) and the report, whose line for the reviewer model carries the backend's own reason (Task 6).
- [ ] **Step 5: What must be true.** `status --stuck` shows `等模型窗口  第 2/2 轮已用尽，等所有者处理：改好配置后新的 taskctl run 从第 0 轮开始` and the task is `open`; `tasks/<id>/review-pending.json` exists; `tasks/<id>/acceptance.json` is from the first attempt.
- [ ] **Step 6: Recover.** Set `reviewerModel` to a model of the plan, run the same command again, and record that the journal shows one `review-only` line, no second worker turn and no second acceptance, and that the task ends `done` or `awaiting-human`.
- [ ] **Step 7: Report to the owner**, verbatim output included. No commit.

---

## Found while carrying out (2026-11-26)

Tasks 1 to 14 were carried out on `feat/model-refusals`, one implementer and one reviewer per task, each on a fresh context, with the controller re-running every gate and every mutation table; the gates of Task 15 were run, and its handoff note is written after the final review. What execution found in this plan is recorded here, so that a reader knows where the text above and the code disagree. The tasks above are left as they were written; the code and the tests stand as built.

- **Task 4** — the brief's `backend` helper indexes `tables.turns`, while every call site the task gives passes a flat table. The helper accepts both forms; the call sites are verbatim.
- **Tasks 5, 6, 7, 8 and 10** — the import lists omit names the briefs' own test code calls (`seedTaskFile`, `doneTaskId`, `readJournal`, `readModelWait`, `WorkerConfig`, `Task`, `TaskOutcome`, `WorkerDeps` and others). They were added.
- **Task 6** — two edits were made otherwise than written, because the brief's letter fails its own tests. A refused review turn is not written to `review.json` as a degraded verdict: it was read back as the previous verdict and made the next real `fail` look stalled. And a reviewer turn is evidence for the run only when it has its own session, since the `review` seam dispatches no turn.
- **Task 7** — the test "a pass that only waited does not count against the pass budget" could not tell its own mutation from the real code: with one task and a budget of one pass the budget check never runs. It now seeds a dependent second task under a budget of two passes. The `settle` seam is typed at its own three-argument arity, because `runTask` takes four.
- **Task 8** — one watch test wrote a deferral whose window had lapsed, which is no hold by design; it now writes a future `nextAt`. The first mutation row is killed by "keeps the guard's own handling of a refused task beside the deferral", not by the test the row names: in that test `selectAutomaticBatch` removes the deferred head, so the ordinary head's guard is never evaluated.
- **Task 9** — the Files line says `tests/batch.test.ts` gains three cases; its code gives four.
- **Task 12** — five behaviours the brief leaves unpinned were decided and reviewed: "since when" is taken from the reason's own source; the models clause is left out when the reason already names the model; "any other status with open questions" means a task that would otherwise not be listed; a guard entry is printed before a deferral record for an `open` task that carries both; and one mutation row's spec names only the test that can fail under it. The final review found one more: "since when" for a `blocked` task whose reason comes from its note is now taken from the journal's `blocked` line when there is one, instead of `-`.
- **Task 13** — the record's `updatedAt` is set to the time of the retry; the brief's test does not assert it.
- **Task 14** — the brief's sentence on unknown-cost models was false against `decide` in `src/budget.ts`: such a model is allowed when it is in `allowedModels` **or** its provider is in `allowedProviders`. The README says so now, and says that a reviewer's verdict is evidence only when the turn has its own session. The final review found the brief's recipe for a model outside the plan false for a free model of another provider and incomplete for a paid one; the README now says what `decide` does.
- **Decisions** — the plan's Decisions say "a timed-out or crashed turn is not evidence"; the design defines an accepted reviewer turn as one that is not a provider refusal, and the code follows the design — a reviewer turn that has its own session counts even when it crashed. The README says so.
- **Mutation tables** — "red on the case the table names, and on no other" holds exactly for most rows. Where a row's mutation removes a guard that several of the task's tests assert, those tests fail too; each such row is recorded in the task's report. Every row was killed, and every row was also re-run by the controller from a machine-readable spec, restored byte for byte.
- **Mutation tables, re-run at the tip (2026-11-26)** — each table above was run on its own task's commit. Run again, whole, on the branch tip by an independent runner: 111 of 112 rows apply, 110 are killed by the very test the row names, and one survived — Task 4's M5. Task 6 had given `reviewStage` a `clearModelWait` of its own, and the case written for the worker turn's passes through a review, which cleared the record for it. Fixed by a sibling case that ends at `verify: mechanical` (`4aa5782`). After the last fix wave of a plan, every table is to be run again on the tip. Run a second time once the live fixes were in and a third after the last change to a test, with the live fix wave's twelve rows (124 in all): 123 apply and 123 are killed, none survives — Task 4's M5 by the sibling case. The one row that does not apply as written, Task 7's M11, had its text rewritten by `fa3c5a2`; applied in its semantic form it was killed by the test its row names.
- **Tasks 16 and 17 (live, 2026-11-26, opencode 2.4.2)** — the precondition names 2.4.1; on 2.4.2 nothing the adapter depends on has moved. Steps 16.3, 16.4 and 16.6 held as written — exit 3, the rounds, the rerun that continues every waiting task without a `retry` — and so did 17.3 and 17.5; 17.6 held once the configuration sat outside the work directory. Step 17.4 held in its exit code and its two refusals; the reason its report carried did not (B). Three items did not, and are fixed on the branch by the owner's ruling, each through a failing regression and a targeted mutation:
  - **A.** `PROVIDER_REJECTION` did not know `provider.invalid-request` / "Upstream request failed: Model is unavailable." — the answer of the backend's default model that morning — so such a turn spent a retry instead of deferring. An `error` or `retry` event the backend typed `provider.*` is a refusal whatever its words (`85c7b1c`).
  - **B.** The reason line read `no output`, not the backend's words — in the report of Task 16 (step 16.5) and in that of Task 17 (step 17.4): an unknown model is refused with one `error` event and an empty stderr, and the adapter read the event for its classification only. A failed turn now opens with its last error event's type and message (`85c7b1c`).
  - **C.** Step 17.6 held with the configuration outside the work directory and was refused by the digest gate with the configuration inside it — the layout this task's setup has, `workdir: "."`. `artifactDigest` counted `taskctl.json`, and the report's own advice is to edit that file and run again. The configuration file is now left out of every artifact digest when it lies in the work directory (`013d02c`). The worker stage was never affected. One cost, once, for a board in flight across the change — run with the old code against the new, not only read (`upgrade-cost.md`, in the ledger): a review preserved before it, on a board whose configuration lies in the work directory, is refused the first time it is recovered after it — `blocked`, "artifacts changed after the preserved worker/acceptance evidence", which names the wrong cause — whether or not the configuration was edited, and `retry --review-only` is refused the same way. A full `taskctl retry` reopens the task and the next `run` does the work again. A configuration outside the work directory recovers by itself. The README says so; a gate that also accepts the earlier digest was not built.
  - Verbatim: `task-16-17-live.md` and `live-fix-mutations.json` (12 rows), in the ledger. `scripts/smoke.ps1 -Live` failed the same morning because the backend's default model is unavailable; the attempt was recorded `uncertain`, and that was accurate.
