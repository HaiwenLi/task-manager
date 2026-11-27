# Rework Feedback File Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Before every rework turn the controller writes `tasks/<id>/rework.md` — why the previous turn was sent back and what has to change — and the worker prompt points at that file with one line instead of carrying the content.

**Architecture:** A new pure module `src/rework.ts` renders a `ReworkFeedback` record into the document and reads it back; `src/runtime.ts` gains `writeRuntimeText`, the text twin of `writeRuntime` (same temp file, same `renameWithRetry`). The worker keeps the pending rejection on `Run` (`r.rework`), sets it where a gate decides to send the work back (acceptance, review, render) or where a turn without a completion request changes the run, rewrites the document at the top of every loop pass while a rejection is pending, and hands the file's path to `buildWorkerPrompt` through `rework`, a new optional input beside the five the learning loop gave it (ADR-0011, ADR-0013). The document lives until the work passes; an attempt that finds one on disk treats its first turn as the rework turn.

**Tech Stack:** TypeScript (NodeNext, strict), Node 22 (`node:fs/promises`, `node:path`), Vitest 5; no new dependency.

**Spec:** docs/superpowers/specs/2026-11-25-model-trouble-and-operator-control-design.md (§11, read as it stands after the revision of 2026-11-25)

**Runs after:** `docs/superpowers/plans/2026-11-25-model-refusals-and-stuck-list.md` (part 1 of the design, 17 tasks), which the design's §14 puts first; `docs/superpowers/plans/2026-11-25-stop-now.md` (part 2, 12 tasks) is written to go second and most likely has landed. The design lets parts 2 to 4 follow part 1 in any order, so nothing below depends on part 2: where the two meet, the text says what is there if it has landed.

## Global Constraints

- G8: "Every rework turn is told where to read why the previous one was rejected."
- "The controller writes `tasks/<id>/rework.md` before each rework turn."
- It is written "from what the controller already holds: the acceptance output (bounded), the failed criteria with the reviewer's evidence and defects, a render failure, a turn that ended without a completion request, or the worker's own `ESCALATE:` reason."
- "The worker prompt gains one line, not the content." *Call.* "In the prompt's own language, Chinese, as the first bullet under `## 工作规则`: "- 上一回合没有通过。开始之前先读 `<path>`：里面写了原因，以及必须改什么。"" That is "The previous turn did not pass. Before you start, read `<path>`: it says why, and what has to change." "`<path>` is the absolute path of the file, given for that turn only. On a turn that is not a rework turn the line is absent and nothing is left, not even a blank line, so the prompt is byte-identical to the one without it. It adds no `--tasks-dir` and no brace". "The sections the learning loop added do not move, and no word of their fixed copy changes."
- "The review rework note that exists today stays, and so does the corrections section the learning loop added (`## 同类任务上人工给过的纠正`, ADR-0011): that one carries what a person corrected on other tasks; this file carries why this task's last turn was sent back."
- "*Call.* Adding the line is a change to a spec-fixed prompt. As ADR-0011 and ADR-0013 handle theirs, the task that changes `src/protocol.ts` is `risk: high` and needs the owner's signature before it is merged. The wording above is what is put to him for it." The gate is written out at the head of Task 2 and under **Reading this plan**.
- `rework.md` lives "under `tasks/<id>/`, outside the definition digest and outside the acceptance drift digest."
- "No change to how a turn that ran and failed for a reason other than a provider failure spends retries."
- "Markdown task files are the source of truth (ADR-0001); a reviewer is always a fresh session; no new runtime dependency; the CLI stays hand-rolled."
- "Every runtime change follows the repository's protocol: a regression that fails first, the fix, directed mutations that the tests kill, documentation kept in step."
- "A run against the real backend needs the owner's explicit authorization." Since the budget guard (ADR-0012) the real adapter is judged before any session starts, so a live run also needs the model allowed and `taskctl models` showing it allowed first (Task 9).
- Every file replace goes through `renameWithRetry` (`src/replace.ts`); `tests/replace.test.ts` ("replace discipline") fails on any bare `await rename(` in `src/` beyond its pinned four.
- `tests/` is type-checked by `npm run typecheck`: test doubles satisfy their interfaces, fixtures satisfy `Task`.
- The worker prompt is pinned by two files, and both stay green. `tests/protocol.test.ts` is not edited by this plan — the learning loop's rule ("`tests/protocol.test.ts` must not be edited and must stay green"): it is the proof that a prompt without the new input is byte-identical to the one pinned before the learning loop. The tests of the new line go into `tests/protocol-context.test.ts` (Task 2).
- No machine-specific path (user directory, drive-letter workspace path) in any committed file; where a command needs the repository root it is written `<repo>`. Do not commit `.codegraph/`. Do not run `taskctl run` in the repository root (it would dispatch `tasks/example.md`).

## Review Focus

Six inputs the spec implies that no existing test exercises. Each is pinned by a named test in the task that owns the code; the tests are written in that task's step 1.

1. **A continuous turn that ends without `taskctl done`** — the escalation §8.1 of the 2026-11-24 design promised to explain, and today explains to nobody (the next prompt is byte-identical). Its mirror matters as much: an iterative task's ordinary progress turn must *not* be told it "did not pass". → `tests/rework.test.ts`: "a continuous task's first turn that does not request completion is told why before the next turn", "an iterative task working turn by turn is not told it did not pass" (Task 6).
2. **The rework turn opens a new session** — a provider refusal hands the turn to the next model, or the context wraps between the rejection and the rework. → "survives a model switch: the session opened on the next model is pointed at the same document", "survives a context wrap: the new session gets the handoff note and the pointer" (Task 7).
3. **The rework is owed to a later attempt** — a review-only recovery returns `open` after a real `fail`; an attempt is blocked with a rejection pending and the owner runs `taskctl retry`. → "is handed to a later attempt by a review-only recovery that fails", "stays on disk when the attempt is blocked, so a retry is pointed at it" (Task 7).
4. **A stale document** — the work passed and a human then rejects it: the next worker must not be pointed at a rejection that no longer stands. → "is removed when the work passes, so a session opened after a human reject is not pointed at a stale rejection" (Task 7).
5. **The document itself on a real machine** — a 126k-character acceptance log, a cut that must not split a character, and a rename of `rework.md` that Windows refuses. → "keeps the tail of a long acceptance output and says where the whole of it is" and "counts code points, not UTF-16 units, when it cuts" (Task 1); "is retried while writing the rework document, and the rework turn still happens" (Task 3, `tests/replace.test.ts`).
6. **The line itself, in a spec-fixed prompt.** Two files pin the prompt byte for byte, and the line has to leave everything else exactly as it is: absent on an ordinary turn without a blank line left behind, one bullet long on a rework turn, adding no `--tasks-dir` and no brace, touching neither the sections the learning loop added nor one word of their fixed copy. → `tests/protocol-context.test.ts`: "points a rework turn at rework.md with exactly one line, and puts nothing of the document into the prompt", "leaves the prompt byte-identical when the path is absent or empty" (Task 2).

## Decisions taken where the spec is silent

The owner can overrule any of these; each is a small, local change and the test that pins it is named.

- **"A turn that ended without a completion request" means the events that change the run**, not every turn of an iterative task: the continuous lane gives way (`escalate(r, "continuous turn ended without a completion request")`, `src/worker.ts:1196`), the session's turn budget runs out (`:1200`), or the worker escalates in a turn that did not request completion. An iterative task that is simply working through its turns gets no document and an unchanged prompt. The spec's list mirrors the escalation triggers of §8.1 of the 2026-11-24 design; telling a worker mid-task that it "did not pass" would be false. Pinned by "an iterative task working turn by turn is not told it did not pass" (Task 6).
- **The prompt line is Chinese, verbatim from the spec** (§11; the author's call 5 of §17), as the first bullet under `## 工作规则`: "- 上一回合没有通过。开始之前先读 `<path>`：里面写了原因，以及必须改什么。" It is pinned verbatim by `tests/protocol-context.test.ts` (Task 2); `tests/protocol.test.ts` is not edited. An empty path counts as no path — the rule `buildWorkerPrompt` keeps for every optional input, absent or empty — so no turn is ever told to read an empty path. The wording is the owner's to sign (Task 2's gate); if he changes it, every place that quotes it is findable by the wording: the template, the `line` of the test that pins it, the `pointer` of Task 3's harness, the README text of Task 8, the needle of Task 9's evidence.
- **Two things are called feedback, and this plan keeps them apart.** The prompt's `feedback` is the corrections section (`## 同类任务上人工给过的纠正`: the entries `src/context.ts` picks from `.taskctl/feedback.jsonl`) — what a person corrected on other tasks. This plan's `ReworkFeedback` is why this task's last turn was sent back. The second never enters the prompt — only the path of the file rendered from it does — and nothing here reads, writes or moves the first.
- **Bounds.** The acceptance output keeps its last 4 000 code points (the size of today's `acceptance-failed` note, `src/worker.ts:1444`) and says where the whole of it is; each piece of reviewer evidence and each defect is cut at 1 000 code points with `…` (the size of `reason` in `src/intake.ts:41`).
- **A document exists exactly while a rework is owed.** It is removed when the work passes (`done` or `awaiting-human`). `awaiting-human` is also where a review that could not decide leaves a task; the document goes on that outcome as well, so a human never `reject`s work that still carries one. It stays through a block, through part 1's deferral (an attempt that ends `open` with `tasks/<id>/model-wait.json`) and through part 2's interruption (an attempt that ends `stopped`, before the line that settles it is ever reached), and `taskctl retry` does not archive it: the rejection it describes is still the latest fact about the work. Pinned by Task 7.
- **A failed turn is not a rejection.** A crash, a timeout, a provider refusal (under part 1: a handover to the next model, or a deferral) and an operator's stop (part 2) write nothing; the rejection already pending stays, and the next turn — in the same attempt or in the first turn of the next one — is pointed at the same document.
- **The worker's `ESCALATE:` reason travels with every document of the attempt in which it was given** and no further.
- **The acceptance-failed handoff note stays** beside `rework.md`, exactly as the review note does. The spec names only the review note; removing the other would take the reason away before anyone asked.
- **`taskctl retry` archives what it archived yesterday.** `ATTEMPT_EVIDENCE` (`src/reconcile.ts:125`) is not extended — here, and not by part 1 either (its Task 13 says the same of `model-wait.json`).

## Reading this plan

- Baseline: `main` at `0eb2d74`, a tree clean except for documents, 865 passed / 1 skipped (76 test files passed, 1 skipped). **Line numbers are those of that commit and are orientation only.** Parts 1 and 2 edit `src/worker.ts` before this plan does, and this plan's own tasks move them too. Every edit below also names the anchor text to search for, and each anchor is a line or a sentence that the two earlier plans do not touch (checked against their Files and their Step 3). The count to compare against is the whole suite's before this plan's first commit — 865 at `0eb2d74`, plus whatever parts 1 and 2 added before this plan ran — and what is added on top is this plan's tests. No number in this plan is a target on its own.
- **Branch and commits.** The work is done on one branch of its own, `feat/rework-feedback`, cut from `main` once part 1 has landed (and part 2, if it went second). No task of this plan commits to `main`. Commit identity is the repository-local `taskctl <taskctl@local>`: after every commit `git log -1 --format='%an <%ae> | %cn <%ce>'` must print exactly that. Never `git push --force` and never merge history from before the 2026-11-25 rewrite.
- **The gate on the prompt (design §11; ADR-0011, ADR-0013).** Task 2 is `risk: high`: it changes a spec-fixed prompt. The owner is shown the exact line and signs it, and until his signature is recorded under **Signature** at the end of this plan, the change to `src/protocol.ts` is not merged to `main` and not pushed there. Every commit after Task 2 is built on that change, so the same holds for the whole branch, and for a push of the branch itself. What may go on before the signature: Tasks 1 to 8, built and committed on the branch in their order. What waits: the merge into `main`, any push, and Task 9, which shows a real worker the line and so runs with the wording he signed. It is how the learning-loop plan handled its own prompt change — built on `feat/learning-loop`, never committed to or pushed to `main` from the plan's tasks, `tests/protocol.test.ts` unedited; that branch was merged afterwards (`e38eecc`). Task 2 has the details.
- Nothing here may start the real `opencode` backend. Every `runTask` call injects `adapter`, `acceptance` and `review`; the only `runCli` call is `reject`, which calls no model.
- **Mutation protocol (step 5 of every task).** Run the task's test file first — the control; if it is not fully green, stop. Copy the file to be mutated to a scratch path outside the repository and note `(Get-FileHash <file>).Hash`. Apply one mutation with a single edit — a reversed comparison, a replaced constant, or an `if (false) { … }` around a block; never `Date.now() !== Date.now()`. Run only the file named for it and confirm that the named test fails and nothing else in that file does. Restore by copying the scratch file back, confirm the hash is the original's, and run the file again — green. One mutation at a time. A mutation that survives is a hole in the test, not a pass: strengthen the named test before going on.
- Commands: one file `npx vitest run tests/<file>.ts`; `npm run typecheck`; `npx tsc --noEmit`; `git diff --check`; whole suite `npm test` (about 35 s at `0eb2d74`; longer once parts 1 and 2 have landed). Do not run `npm test` after every task; run it once before Task 1 (and note the count it prints), once before Task 8 and once after it.

**Where this plan meets parts 1 and 2.** Both plans were read task by task. Neither touches `src/protocol.ts` or `src/runtime.ts`; part 1 changes `retryTask` (its Task 13: a deferral keeps its time and starts its rounds again), not in a way this plan meets; neither touches a test file this plan creates or edits, with one exception: part 2 adds a test to `tests/render-escalation.test.ts`, which this plan only runs. Part 1 goes first. Part 2 may have landed or may land after: nothing this plan builds depends on it, and each of its edits in `src/worker.ts` sits beside one of this plan's, never on the same line. What they leave where this plan edits:

| `src/worker.ts` at `0eb2d74` | This plan puts there | What the earlier plans leave |
| --- | --- | --- |
| the `./runtime.js` import, line 21 | `writeRuntimeText`; a new `./rework.js` import under it | part 1 edits line 24; part 2 adds lines among 1–33; neither names this one |
| `Run`, lines 204–236; its literal, 290–292 | `rework`, then `workerEscalation`, after `heartbeatWriteFailureNoted` | part 1 drops `dispatchFailures` and adds `run`; neither touches the `heartbeatWriteFailureNoted` member |
| `runTask`, line 345 | `carriedRework`, directly above `const previous = await readAttempt(cfg.tasksDir, task.id);` | part 1 puts its deferral gate and its automatic review resumption after line 336, so `r.reviewOnly` is already decided when this line runs |
| `runTask`, lines 400–402 | `settleRework`, between the outcome line and the settled checkpoint | neither touches these lines; part 2's stop leaves through the `catch` block (404–431) and never reaches them |
| `escalate`, lines 469–477 | `unanswered`, under it | neither |
| `loop`, lines 1087–1097 | the write after `const note = …`; the `rework` member after the `context.memory` spread | part 2 puts `assertNotStopped(r);` directly under `for (;;) {` (1086); part 1 edits 1076–1079 and 1102–1105, on either side |
| `loop`, lines 1136–1137 and 1193–1221 | the ESCALATE marker; the branch chain becomes one `else` | part 1 replaces 1155–1183 and the wrap-up turn's provider branch inside the over-budget branch (1208–1213): that branch is taken as found |
| `resumeReviewOnly`, lines 1316–1319 | the write inside `if (outcome === "retry") {` | part 2 makes `assertNotStopped(r)` the function's first statement |
| `accept`, lines 1448–1456 | `r.rework = …` before `return "retry";` | part 2 edits the gate call (1376–1377) and adds a stop check after `artifactAfter` (1385) |
| `acceptRender`, lines 1543–1544 | `r.rework = …` between the `fail(r)` line and `return "retry";` | part 2 adds its stop check above, before `render.json` (1522) |
| `judge`, line 1820 | `r.rework = …` above the `seq` line | neither touches `judge` |

What that means for the behaviour this plan builds:

- **A rework turn that a model refuses (part 1).** `rework.md` was written before that turn, at the top of the loop pass. The refusal writes nothing. Inside a round part 1 hands the turn to the next model and reaches the top of the loop again, where this plan's write runs once more and the next model's fresh session is pointed at the same document ("survives a model switch", Task 7). When every model of the round has refused, the attempt ends `open` with `tasks/<id>/model-wait.json` and no retry spent; the document stays as it was written, and when the window reopens the next attempt's first turn is pointed at it through `carriedRework` (Task 7). A turn that was refused is not a rejection.
- **A rework turn, or the gate before it, that the owner interrupts (part 2).** The attempt settles as stopped and leaves `runTask` through its `catch` block, so the line where Task 7 settles the document is never reached. A gate that was cut is not judged, so `accept`, `judge` and `acceptRender` never reach the assignments of Tasks 3–5. Nothing is written and nothing removed: the task returns to `open`, and the rerun's first turn is pointed at the document that is already there. A turn that was interrupted is not a rejection.
- **The review-only path (part 1).** A refused reviewer no longer parks a task (`blocked` with `review-pending.json`); it defers it — `open`, the record kept — and the next claim resumes the review by itself through `resumeReviewOnly` and its digest gate. A reviewer that timed out keeps the park, and `retry --review-only` still recovers that. Task 7's test is written for the first shape and says what it relies on.

---

### Task 1: The document — its record, its renderer, and a text writer

**Files:**
- Create: `src/rework.ts`
- Modify: `src/runtime.ts` (lines 58–63, `writeRuntime`)
- Test: Create `tests/rework.test.ts`

**Interfaces:**
- Consumes: `CriterionResult` (`src/review.ts:8`); `renameWithRetry` (`src/replace.ts:38`) through `writeRuntimeText`; `artifactDigest` (`src/workspace.ts:353`).
- Produces, `src/runtime.ts`:
  - `export async function writeRuntimeText(tasksDir: string, id: string, name: string, text: string): Promise<void>` — the landing `writeRuntime` has today (`<file>.<uuid>.tmp`, then `renameWithRetry`), with the text written verbatim; `writeRuntime(tasksDir, id, name, record)` becomes `writeRuntimeText(tasksDir, id, name, JSON.stringify(record, null, 2))`.
- Produces, `src/rework.ts`:
  - `export const REWORK_FILE = "rework.md";`
  - `export const REWORK_OUTPUT_CHARS = 4_000;`
  - `export const REWORK_LINE_CHARS = 1_000;`
  - `export type ReworkFeedback = { kind: "acceptance"; command: string; exitCode: number | null; output: string } | { kind: "review"; round: number; summary: string; failed: CriterionResult[]; defects: string[] } | { kind: "render"; failures: string[] } | { kind: "no-completion"; why: string; previous: ReworkFeedback | null } | { kind: "carried"; markdown: string };`
  - `export function reworkPathOf(tasksDir: string, id: string): string` — `join(tasksDir, id, REWORK_FILE)`.
  - `export function renderRwork(args: { task: { id: string; title: string }; tasksDir: string; at: string; feedback: ReworkFeedback; escalation?: string }): string` — pure.
  - `export async function readRwork(tasksDir: string, id: string): Promise<string | null>` — a missing file reads as null; any other error propagates (the contract of `readRuntime`, `src/runtime.ts:49–56`).

- [ ] **1. Write the failing tests.** Create `tests/rework.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactDigest } from "../src/workspace.js";
import { writeRuntime, writeRuntimeText } from "../src/runtime.js";
import { REWORK_FILE, REWORK_OUTPUT_CHARS, readRwork, renderRwork, reworkPathOf, type ReworkFeedback } from "../src/rework.js";

let root: string;
let tasks: string;
let work: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "taskctl-rework-"));
  tasks = join(root, "tasks");
  work = join(root, "work");
  await mkdir(tasks);
  await mkdir(work);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("renderRwork", () => {
  const base = { task: { id: "a", title: "任务 A" }, tasksDir: "T", at: "2026-11-25T10:00:00.000Z" };
  const text = (...lines: string[]) => `${lines.join("\n")}\n`;
  const header = ["# 返工说明：任务 A（a）", "", "写于 2026-11-25T10:00:00.000Z。上一回合没有通过：先读完这份说明，再动手。", ""];
  const done = '- 改完后请求完成：taskctl done --task a --tasks-dir "T"';
  const acceptance: ReworkFeedback = { kind: "acceptance", command: "npm test", exitCode: 1, output: "断言失败： expected 2, got 1" };

  it("tells an acceptance failure from the exit code, the command and the output, and says what to do", () => {
    expect(renderRwork({ ...base, feedback: acceptance })).toBe(text(
      ...header,
      "## 上一回合为什么没有通过",
      "",
      "控制器的验收命令失败了（exit 1）。验收命令退出 0，任务才能进入下一步。",
      "",
      "验收命令：npm test",
      "",
      "验收输出：",
      "",
      "断言失败： expected 2, got 1",
      "",
      "## 需要改变什么",
      "",
      "- 按上面的验收输出修复；输出被截断时，先读完整的验收记录再判断。",
      "- 先做有界的定向自验（任务声明了 worker_self_check 就用 taskctl check），不要反复重跑全量验收。",
      done,
    ));
  });

  it("says a gate that could not start as exit null, and a silent one as silent", () => {
    const doc = renderRwork({ ...base, feedback: { kind: "acceptance", command: "npm test", exitCode: null, output: "" } });
    expect(doc).toContain("控制器的验收命令失败了（exit null）。");
    expect(doc).toContain("验收命令没有留下任何输出。");
    expect(doc).not.toContain("验收输出：");
  });

  it("keeps the tail of a long acceptance output and says where the whole of it is", () => {
    const output = `${"头".repeat(5_000)}${"尾".repeat(1_500)}`;
    const doc = renderRwork({ ...base, feedback: { kind: "acceptance", command: "npm test", exitCode: 1, output } });
    expect(doc).toContain("尾".repeat(1_500));
    expect(doc).not.toContain("头".repeat(2_501));
    expect(doc).toContain(
      `验收输出（只保留结尾 ${REWORK_OUTPUT_CHARS} 个字符，前面省略 2500 个字符；`
      + `完整输出在 ${join("T", "a", "acceptance.json")} 的 output 字段，被 taskctl retry 归档后在 ${join("T", "a", "archive")} 下）：`,
    );
  });

  it("counts code points, not UTF-16 units, when it cuts", () => {
    const output = `x${"😀".repeat(REWORK_OUTPUT_CHARS + 1)}`;
    const doc = renderRwork({ ...base, feedback: { kind: "acceptance", command: "npm test", exitCode: 1, output } });
    expect(doc).toContain("😀".repeat(REWORK_OUTPUT_CHARS));
    expect(doc).toContain("前面省略 2 个字符");
    expect(doc).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  it("turns CRLF and CR into LF and changes nothing else in the output", () => {
    const doc = renderRwork({ ...base, feedback: { kind: "acceptance", command: "npm test", exitCode: 1, output: "a\r\nb\rc  two  spaces" } });
    expect(doc).toContain("\n\na\nb\nc  two  spaces\n\n");
  });

  it("lists each failed criterion with the reviewer's evidence, then the defects to fix", () => {
    const feedback: ReworkFeedback = {
      kind: "review", round: 2, summary: "未达 C1",
      failed: [{ id: "C1", pass: false, evidence: "读了 src/a.ts，看到宽度写死" }],
      defects: ["🔴 宽度改为自适应", "🟡 文案不一致"],
    };
    expect(renderRwork({ ...base, feedback })).toBe(text(
      ...header,
      "## 上一回合为什么没有通过",
      "",
      "独立复核没有通过（第 2 轮）：未达 C1",
      "",
      "没有通过的验收标准，以及复核者看到的依据：",
      "",
      "- C1：读了 src/a.ts，看到宽度写死",
      "",
      "## 需要改变什么",
      "",
      "- 🔴 宽度改为自适应",
      "- 🟡 文案不一致",
      done,
    ));
  });

  it("says so when the reviewer gave no summary, no evidence or no defects", () => {
    const doc = renderRwork({ ...base, feedback: { kind: "review", round: 1, summary: "", failed: [{ id: "C2", pass: false, evidence: "" }], defects: [] } });
    expect(doc).toContain("独立复核没有通过（第 1 轮）：复核未通过");
    expect(doc).toContain("- C2：（复核者没有给出依据）");
    expect(doc).toContain("- 按上面没有通过的验收标准返工。");
  });

  it("cuts one piece of reviewer evidence or one defect at a thousand characters", () => {
    const doc = renderRwork({
      ...base,
      feedback: { kind: "review", round: 1, summary: "s", failed: [{ id: "C1", pass: false, evidence: "证".repeat(1_200) }], defects: ["缺".repeat(1_200)] },
    });
    expect(doc).toContain(`- C1：${"证".repeat(1_000)}…`);
    expect(doc).toContain(`- ${"缺".repeat(1_000)}…`);
    expect(doc).not.toContain("证".repeat(1_001));
  });

  it("names each view that failed the render check and where its screenshot is", () => {
    const failures = ["W\\index.html @ 390x844: 横向溢出：页面比视口宽，内容被裁掉或需要横向滚动"];
    expect(renderRwork({ ...base, feedback: { kind: "render", failures } })).toBe(text(
      ...header,
      "## 上一回合为什么没有通过",
      "",
      "渲染验收失败：下面的页面在下面的视口上，没有同时做到画得出来、有可读内容、不横向溢出、没有未捕获异常。",
      "",
      "- W\\index.html @ 390x844: 横向溢出：页面比视口宽，内容被裁掉或需要横向滚动",
      "",
      "## 需要改变什么",
      "",
      `- 修到每个目标页面在每个视口上都满足上面四条。失败那一屏的截图在 ${join("T", "a", "evidence")}，先看它。`,
      done,
    ));
  });

  it("tells a turn that did not ask to be judged why that matters and what to do, and keeps the reasons it was already sent back for", () => {
    const why = "上一回合正常结束，但没有请求完成（没有运行 taskctl done）。连续执行的任务本应在一个回合内做完并请求验收；没有做到，任务已升级为迭代执行（iterative）。控制器没有可以验收的成果。";
    expect(renderRwork({ ...base, feedback: { kind: "no-completion", why, previous: null } })).toBe(text(
      ...header,
      "## 上一回合为什么没有通过",
      "",
      why,
      "",
      "## 需要改变什么",
      "",
      `- 已经做完：请求完成，taskctl done --task a --tasks-dir "T"`,
      "- 还没做完：继续做，并用 taskctl note 记下现状、卡点和下一步。",
      "- 任务比声明的更大：单独输出一行 ESCALATE: <原因>。",
    ));
    const carried = renderRwork({ ...base, feedback: { kind: "no-completion", why, previous: acceptance } });
    expect(carried).toContain("## 仍然适用的上一轮否决\n\n## 上一回合为什么没有通过\n\n控制器的验收命令失败了（exit 1）。");
    expect(carried.match(/^# /gm)).toHaveLength(1);
    expect(carried.match(/## 仍然适用的上一轮否决/g)).toHaveLength(1);
  });

  it("carries a document written by an earlier attempt under one heading", () => {
    const earlier = renderRwork({ ...base, at: "2026-11-25T09:00:00.000Z", feedback: acceptance });
    expect(renderRwork({ ...base, feedback: { kind: "carried", markdown: earlier } }))
      .toBe(earlier.replace("写于 2026-11-25T09:00:00.000Z", "写于 2026-11-25T10:00:00.000Z"));
  });

  it("adds the worker's own ESCALATE reason when it gave one, after everything else", () => {
    const doc = renderRwork({
      ...base, feedback: { kind: "no-completion", why: "没有请求完成。", previous: null }, escalation: "产物从一张表变成了三张",
    });
    expect(doc.endsWith(
      "## 需要改变什么\n\n- 已经做完：请求完成，taskctl done --task a --tasks-dir \"T\"\n"
      + "- 还没做完：继续做，并用 taskctl note 记下现状、卡点和下一步。\n"
      + "- 任务比声明的更大：单独输出一行 ESCALATE: <原因>。\n\n"
      + "## 你在上一回合提出的升级\n\nESCALATE: 产物从一张表变成了三张\n\n"
      + "本任务因此升级为迭代执行：此后必须经过独立复核，不能再用自己的证据收尾。\n",
    )).toBe(true);
  });
});

describe("rework.md on disk", () => {
  it("writeRuntimeText writes text verbatim, replaces what was there, and leaves no temp file", async () => {
    await mkdir(join(tasks, "a"));
    await writeRuntimeText(tasks, "a", REWORK_FILE, "# 一\n\nbody\r\n");
    expect(await readFile(reworkPathOf(tasks, "a"), "utf8")).toBe("# 一\n\nbody\r\n");
    await writeRuntimeText(tasks, "a", REWORK_FILE, "# 二\n");
    expect(await readRwork(tasks, "a")).toBe("# 二\n");
    expect(await readRwork(tasks, "nobody")).toBeNull();
    expect(await readdir(join(tasks, "a"))).toEqual([REWORK_FILE]);
  });

  it("writeRuntime lands the same way", async () => {
    await mkdir(join(tasks, "a"));
    await writeRuntime(tasks, "a", "x.json", { b: [1] });
    expect(JSON.parse(await readFile(join(tasks, "a", "x.json"), "utf8"))).toEqual({ b: [1] });
    expect(await readdir(join(tasks, "a"))).toEqual(["x.json"]);
  });

  it("sits outside the artifact digest", async () => {
    // The tasks directory inside the workspace is excluded from the digest the
    // acceptance gate compares; the document must not be able to invalidate evidence.
    const inside = join(work, "tasks");
    await mkdir(join(inside, "a"), { recursive: true });
    await writeFile(join(work, "src.txt"), "source", "utf8");
    const before = await artifactDigest(work, [inside]);
    await writeRuntimeText(inside, "a", REWORK_FILE, "# 返工说明\n");
    expect(await artifactDigest(work, [inside])).toBe(before);
    // Control: the file is real, and would count from anywhere else in the tree.
    expect(await artifactDigest(work)).not.toBe(before);
  });
});
```

- [ ] **2. Run it and expect FAIL.** `npx vitest run tests/rework.test.ts` — the file cannot load: `Failed to load url ../src/rework.js` (the module does not exist), and `writeRuntimeText` is not an export of `src/runtime.ts`.
- [ ] **3. Implement.**
  - `src/runtime.ts`: replace the body of `writeRuntime` (anchor `export async function writeRuntime(tasksDir: string, id: string, name: string, record: unknown): Promise<void> {`) with a call to a new `writeRuntimeText` declared directly below it, which holds the four lines `writeRuntime` has today (`const file = join(tasksDir, id, name);`, the `tmp` name, `writeFile(tmp, text, "utf8")`, `renameWithRetry(tmp, file)`). No new `await rename(` anywhere.
  - Create `src/rework.ts` with the signatures above. The document is `[title line, "", written line, "", body]` joined by `\n`, then the escalation block when `escalation` is given, then a final `\n`:
    - title line `# 返工说明：${title}（${id}）`; written line `写于 ${at}。上一回合没有通过：先读完这份说明，再动手。`
    - `body` of each kind is the text the tests pin verbatim: `## 上一回合为什么没有通过`, `## 需要改变什么`, and for `no-completion` with a `previous` also `## 仍然适用的上一轮否决` followed by `body(previous)` once. `carried` reproduces its markdown from the first line that starts with `## ` on.
    - every `需要改变什么` list carries the way to ask to be judged: the three gates end with `- 改完后请求完成：taskctl done --task <id> --tasks-dir "<tasksDir>"` (the form the protocol uses); a turn that did not ask begins with that same command in its first bullet.
    - the acceptance output has `\r\n` and `\r` turned into `\n`; when it is longer than `REWORK_OUTPUT_CHARS` code points only the last `REWORK_OUTPUT_CHARS` are kept and the `验收输出：` line becomes the `验收输出（只保留结尾 … ）：` line of the test. Each piece of evidence and each defect is cut at `REWORK_LINE_CHARS` code points with `…`; the summary is used as the reviewer wrote it.
    - escalation block: `## 你在上一回合提出的升级`, `ESCALATE: ${escalation}`, `本任务因此升级为迭代执行：此后必须经过独立复核，不能再用自己的证据收尾。` as three paragraphs.
  - `readRwork` reads `reworkPathOf(tasksDir, id)` and returns null only for `ENOENT`.
- [ ] **4. Run it and expect PASS.** `npx vitest run tests/rework.test.ts`; then the control for the replace discipline: `npx vitest run tests/replace.test.ts` — "replaces a file only through the retrying rename" still lists exactly the same four lines. `npm run typecheck`, `npx tsc --noEmit`, `git diff --check` clean.
- [ ] **5. Directed mutation check.** Control: `npx vitest run tests/rework.test.ts tests/replace.test.ts` green.
  - M1 *head instead of tail* — `src/rework.ts`: keep `slice(0, REWORK_OUTPUT_CHARS)` instead of the last `REWORK_OUTPUT_CHARS`. Must fail: "keeps the tail of a long acceptance output and says where the whole of it is" and "counts code points, not UTF-16 units, when it cuts" (the head it keeps holds one emoji fewer than that test asks for).
  - M2 *the cut is not announced* — always print `验收输出：`. Must fail: the same test.
  - M3 *UTF-16 units* — cut with `text.slice(-REWORK_OUTPUT_CHARS)` on the string instead of on `Array.from(text)`. Must fail: "counts code points, not UTF-16 units, when it cuts".
  - M4 *unbounded evidence* — do not apply `REWORK_LINE_CHARS`. Must fail: "cuts one piece of reviewer evidence or one defect at a thousand characters".
  - M5 *two headings* — `carried` reproduces the whole markdown including its `# ` line. Must fail: "carries a document written by an earlier attempt under one heading".
  - M6 *the earlier rejection dropped* — omit the `## 仍然适用的上一轮否决` part. Must fail: "tells a turn that did not ask to be judged why that matters …".
  - M7 *no escalation block* — ignore `escalation`. Must fail: "adds the worker's own ESCALATE reason when it gave one, after everything else".
  - M8 *no final newline* — Must fail: every `toBe(text(…))` test.
  - M9 *bare rename* — `src/runtime.ts`: `rename(tmp, file)` instead of `renameWithRetry(tmp, file)`. Must fail: `tests/replace.test.ts` "replaces a file only through the retrying rename".
  - Restore check after each: hash equal to the scratch copy's; control green again.
- [ ] **6. Commit.** `git add src/rework.ts src/runtime.ts tests/rework.test.ts` — `feat(rework): render the rework document and write runtime text through the retrying rename`.

---

### Task 2: The prompt gains one line — a governed change

**Risk: high. The owner's signature is the gate (design §11).** This is the only task that touches `src/protocol.ts`, whose copy is spec-fixed: every worker shares one protocol, so changing it is a spec change, not a refactor. ADR-0011 and ADR-0013 handle theirs as `risk: high`, signed by the owner before the merge, and the learning-loop plan kept `tests/protocol.test.ts` unedited as the proof that nothing else moved. This plan does the same.

- **The line the owner is shown**, exactly as the worker reads it, with `<path>` standing for the absolute path of `tasks/<id>/rework.md`:

  ```text
  - 上一回合没有通过。开始之前先读 `<path>`：里面写了原因，以及必须改什么。
  ```

  That is the design's wording (§11; Chinese, like every fixed line of the prompt — the author's call 5 of §17). The signature covers the line and where it stands: the first bullet under `## 工作规则`, present on rework turns only, and leaving the prompt byte-identical without it.
- **Before the signature: ask.** **Settled on 2026-11-25: the owner left the line to the session that carries out this plan, and that session kept it as designed (see **Signature** at the end); nothing is put to him again for this line.** The rule this task states is the one any later change to the prompt follows. At the head of the task, before any code is written, the implementer puts the line to the owner — the line above, the English sentence it stands for, and the fact that it is the first bullet of the work rules on rework turns only. He may take it as it is or change it. While he reads, the branch is built: Tasks 1 to 8 are committed on `feat/rework-feedback` in their order, this task included.
- **Until the signature is recorded:** nothing of this plan is merged to `main` or pushed there. Every commit after this one is built on this change, so that holds for the whole branch, and for a push of the branch itself.
- **After the signature:** record it under **Signature** at the end of this plan — the date, the line as signed, and where the owner said it. If he changed the wording, the places that quote it are found by the wording (Decisions, second bullet); they are edited, and the gates of this task and of Task 8 are run again. A change to the line after that is a new governed change and goes back to him.
- **No ADR is written here:** design §11 asks for the signature and names none.

**Files:**
- Modify: `src/protocol.ts` (`WorkerPromptContext`, lines 8–39; the template, lines 95–96)
- Test: Modify `tests/protocol-context.test.ts`
- Not edited: `tests/protocol.test.ts`, which must stay green unchanged

**Interfaces:**
- Consumes: `WorkerPromptContext` (`src/protocol.ts:8`); `buildWorkerPrompt(task: Task, ctx: WorkerPromptContext): string` (`src/protocol.ts:89`).
- Produces: `WorkerPromptContext.rework?: string` — after `memory?: string;` (line 38), the last member: the absolute path of `tasks/<id>/rework.md` on a rework turn, never the document's content; absent, or empty, on every other turn. The output for every context without it is byte-identical to today's.
- Not touched: `handoff`, `workdir`, `tasksDir`, `taskDir`, `logDir`, `dependencies`, the five inputs the learning loop added (`spec`, `fixedSources`, `profile`, `feedback`, `memory`), the fixed notes `SPEC_NOTE`, `FIXED_SOURCES_NOTE` and `MEMORY_NOTE`, `section`, and the order of the template's lines.

**What changes in the tests and what must not.** Two files pin the protocol byte for byte. *Changes:* one new `describe` at the end of `tests/protocol-context.test.ts`, with three tests; the first holds a verbatim render built from the prompt without the new input. *Must not change:* `tests/protocol.test.ts` — `FIRST_SESSION_PROMPT` (lines 40–56) and the expectation of every test in it, among them "renders the fixed protocol verbatim on the first session (no handoff)", the four-way split on `--tasks-dir "<tasksDir>"` and the brace check — and every existing test of `tests/protocol-context.test.ts`, among them "is byte-identical when no section is supplied" and "adds no protocol token of its own".

- [ ] **1. Write the failing tests.** Append to `tests/protocol-context.test.ts`, after its `describe` — the file's `task()`, `ctx` and `base` are module-level and are used as they are:

```ts
describe("buildWorkerPrompt — the rework line", () => {
  const reworkPath = resolve(ctx.taskDir, "rework.md");
  /** The line as the worker reads it on a rework turn, ending in its own line break. */
  const line = `- 上一回合没有通过。开始之前先读 \`${reworkPath}\`：里面写了原因，以及必须改什么。\n`;

  it("points a rework turn at rework.md with exactly one line, and puts nothing of the document into the prompt", () => {
    const plain = buildWorkerPrompt(task(), base);
    const prompt = buildWorkerPrompt(task(), { ...base, rework: reworkPath });

    // The only difference from the prompt without it is that one line.
    expect(prompt).toBe(plain.replace("## 工作规则\n", `## 工作规则\n${line}`));
    // The first bullet of the work rules: `- 工作目录` stays the second.
    expect(prompt).toContain(`## 工作规则\n${line}- 工作目录：${ctx.workdir}；只在此目录内改动`);
    // One line more than the prompt without it, and still three taskctl
    // invocations and no brace: the pointer is a path, not a command and not
    // the document.
    expect(prompt.split("\n")).toHaveLength(plain.split("\n").length + 1);
    expect(prompt.match(/--tasks-dir/g)).toHaveLength(3);
    expect(prompt).not.toMatch(/[{}]/);
  });

  it("leaves the prompt byte-identical when the path is absent or empty", () => {
    expect(buildWorkerPrompt(task(), { ...base, rework: undefined })).toBe(buildWorkerPrompt(task(), base));
    expect(buildWorkerPrompt(task(), { ...base, rework: "" })).toBe(buildWorkerPrompt(task(), base));
    // With every other section supplied as well: nothing is left where the line would stand.
    const sections = { ...base, spec: "S", profile: "P", feedback: "F", memory: "M", fixedSources: "X" };
    expect(buildWorkerPrompt(task(), { ...sections, rework: "" })).toBe(buildWorkerPrompt(task(), sections));
  });

  it("carries no pointer when no rework is pending, whatever the handoff says", () => {
    for (const handoff of [undefined, "上一段完成了协议模板的中文标点校验。"]) {
      const prompt = buildWorkerPrompt(task(), { ...base, handoff });
      expect(prompt).not.toContain("rework.md");
      expect(prompt).not.toContain("上一回合没有通过");
    }
  });
});
```

- [ ] **2. Run it and expect FAIL.** `npx vitest run tests/protocol-context.test.ts` — "points a rework turn …" fails with `expected '…' to be '…'`: the rendered prompt lacks the line under `## 工作规则`. (`npm run typecheck` also rejects `rework` as an unknown property; that is the second half of the failure.) The other two tests pass before and after: they are the controls that an ordinary prompt is not touched.
- [ ] **3. Implement** in `src/protocol.ts`:
  - `WorkerPromptContext`: after `memory?: string;` (line 38) add the last member, with its doc comment:

    ```ts
      /**
       * Absolute path of `tasks/<id>/rework.md` on a rework turn: the document
       * that says why the previous turn was sent back and what has to change.
       * The prompt carries the path, never the content. Absent or empty: no line.
       */
      rework?: string;
    ```

  - In the template, directly after the line `## 工作规则` (line 95) and before `- 工作目录：${ctx.workdir}；只在此目录内改动` (line 96), insert one template line and nothing else:

    ```ts
    ## 工作规则
    ${ctx.rework === undefined || ctx.rework === "" ? "" : `- 上一回合没有通过。开始之前先读 \`${ctx.rework}\`：里面写了原因，以及必须改什么。\n`}
    - 工作目录：${ctx.workdir}；只在此目录内改动
    ```

  - In `buildWorkerPrompt`'s doc comment (lines 72–88), after `70/30 clip keeps the task, the spec and the handoff, and gives up the` / `middle first.` and before the closing ` */`, add one paragraph: "One optional line sits in the work rules themselves. On a rework turn the first bullet points the worker at `rework.md` (`ctx.rework`, the file's absolute path); the document itself is never put into the prompt. Absent or empty, it leaves nothing, not even a line break."
- [ ] **4. Run it and expect PASS.** `npx vitest run tests/protocol.test.ts tests/protocol-context.test.ts tests/dependencies.test.ts tests/worker-context.test.ts` (the last two build the prompt, or a worker's first turn, without the new field and must stay green); `git diff --stat tests/protocol.test.ts` prints nothing; `npm run typecheck`, `npx tsc --noEmit`, `git diff --check` clean.
- [ ] **5. Directed mutation check** on `src/protocol.ts`. Control: `npx vitest run tests/protocol.test.ts tests/protocol-context.test.ts` green.
  - M1 *the guard reversed* — emit the line when `rework` is absent or empty and nothing otherwise. Must fail: `tests/protocol.test.ts` "renders the fixed protocol verbatim on the first session (no handoff)", and in `tests/protocol-context.test.ts` exactly the three tests of the new `describe`.
  - M2 *the line at the end of the rules* — move it after the `HANDOFF_READY` bullet. Must fail: "points a rework turn …" (`toBe`, and the `- 工作目录` expectation).
  - M3 *no line break after it* — drop the trailing `\n`. Must fail: "points a rework turn …" (`split("\n")` length and `toBe`).
  - M4 *a blank line before it*. Must fail: "points a rework turn …" (`+ 1`).
  - M5 *the path in double quotes instead of backticks*. Must fail: "points a rework turn …" (`toBe`).
  - M6 *the field made required* (`rework: string`). Must fail: `npm run typecheck` (`tests/dependencies.test.ts:101` passes a context without it).
  - M7 *an empty path is printed* — the guard tests `undefined` alone. Must fail: "leaves the prompt byte-identical when the path is absent or empty".
  - Restore check: hash equal to the scratch copy's; control green again.
- [ ] **6. Commit** on the branch. `git add src/protocol.ts tests/protocol-context.test.ts` — `feat(protocol): point a rework turn at rework.md with one line`, with a body that says `risk: high: a spec-fixed prompt; not for main until the owner signs the line (design §11)`.

---

### Task 3: An acceptance failure is written before the rework turn

**Files:**
- Modify: `src/worker.ts` (the imports, lines 11 and 21; `Run`, lines 204–236 and the literal at 290–292; new `writeRwork` directly above `loop`; `loop` top, lines 1087–1097; `accept`, lines 1440–1456; the comment at 1191–1192)
- Test: Modify `tests/rework.test.ts` (harness and a new `describe`), Modify `tests/replace.test.ts` (one test in "a file replace the OS refused", lines 111–191)

**Interfaces:**
- Consumes: `Run` (`src/worker.ts:204`); `owned` (`src/worker.ts:238`, the module's guard over `withOwnership` of `src/claim.ts:104`); `accept(r): Promise<"done" | "blocked" | "retry" | "open" | "awaiting-human">` (`src/worker.ts:1325`); `renderRwork`, `reworkPathOf`, `ReworkFeedback`, `REWORK_FILE` (Task 1); `writeRuntimeText` (Task 1); `WorkerPromptContext.rework` (Task 2).
- Produces, `src/worker.ts`:
  - `Run.rework: ReworkFeedback | null` — why the worker was sent back; null until something does.
  - `async function writeRwork(r: Run): Promise<void>` (module-private) — `writeRuntimeText(r.cfg.tasksDir, r.task.id, REWORK_FILE, renderRwork({ task: { id: r.task.id, title: r.task.title }, tasksDir: r.cfg.tasksDir, at: new Date().toISOString(), feedback: r.rework }))`. The caller holds the task lock: `await owned(r, () => writeRwork(r))`.
  - The loop writes the document at the top of every pass while `r.rework !== null`, and passes `rework: reworkPathOf(r.cfg.tasksDir, r.task.id)` to `buildWorkerPrompt` in the same condition.
  - `accept()` sets `r.rework = { kind: "acceptance", command, exitCode: result.exitCode, output: result.output ?? "" }` immediately before its `return "retry";` (anchor: the journal entry whose detail line reads ``detail: `acceptance failed (exit ${result.exitCode ?? "null"}); the worker resumes with the failure output` ``).

- [ ] **1. Write the failing tests.**
  - In `tests/rework.test.ts`, replace the import block and the two hooks with the harness below. Imports marked T5 and T7 are unused until that task; the header is written once. Every later task adds only `describe` blocks to this file.

```ts
vi.mock("../src/render.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/render.js")>();
  return { ...actual, checkRender: vi.fn() };
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "../src/task-store.js";
import { runTask, WRAP_UP_INSTRUCTION, type WorkerConfig } from "../src/worker.js"; // WRAP_UP_INSTRUCTION: T7
import type { AgentAdapter } from "../src/adapters/types.js";
import type { AcceptanceResult } from "../src/acceptance.js";
import type { ReviewResult } from "../src/review.js";
import { latestNote, writeNote } from "../src/handoff.js"; // writeNote: T7
import { readJournal } from "../src/journal.js";
import { serializeTaskFile } from "../src/task-file.js";
import type { Task } from "../src/task-file.js";
import { buildTaskFile } from "./helpers/task-fixture.js";
import { PROBLEM_TEXT, checkRender } from "../src/render.js"; // T5
import {
  REWORK_FILE, REWORK_OUTPUT_CHARS, readRwork, renderRwork, reworkPathOf, type ReworkFeedback,
} from "../src/rework.js";
import { artifactDigest } from "../src/workspace.js";
import { writeRuntime, writeRuntimeText } from "../src/runtime.js";
import { runCli } from "../src/cli.js"; // T7
import { retryTask } from "../src/reconcile.js"; // T7

let root: string;
let tasks: string;
let work: string;
let store: TaskStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "taskctl-rework-"));
  tasks = join(root, "tasks");
  work = join(root, "work");
  await mkdir(tasks);
  await mkdir(work);
  store = new TaskStore(tasks);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

const reworkPath = (): string => reworkPathOf(tasks, "a");
/** How the rework line names the file: 先读, then the absolute path in backticks. */
const pointer = (): string => `先读 \`${reworkPath()}\``;

function config(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return { tasksDir: tasks, workdir: work, agent: "fixture", contextThreshold: 0.8, retryLimit: 3, lockTtlMs: 5_000, heartbeatMs: 50, ...overrides };
}

async function seed(overrides: Partial<Task> = {}): Promise<void> {
  await writeFile(join(tasks, "a.md"), serializeTaskFile(buildTaskFile({
    id: "a", title: "任务 A", status: "open", acceptance: "npm test", criteria: ["C1 ok", "C2 fine"], ...overrides,
  })), "utf8");
}

const failed: AcceptanceResult = { passed: false, exitCode: 1, output: "断言失败： expected 2, got 1", skipped: false };
const passed: AcceptanceResult = { passed: true, exitCode: 0, output: "ok", skipped: false };
const passVerdict: ReviewResult = {
  verdict: "pass", criteria: [{ id: "C1", pass: true, evidence: "ok" }, { id: "C2", pass: true, evidence: "ok" }],
  externalChanges: [], defects: [], summary: "ok",
};
const failVerdict: ReviewResult = {
  verdict: "fail", criteria: [{ id: "C1", pass: false, evidence: "读了 src/a.ts，看到宽度写死" }, { id: "C2", pass: true, evidence: "ok" }],
  externalChanges: [], defects: ["🔴 宽度改为自适应"], summary: "未达 C1",
};

/** An acceptance gate: the first run answers `results[0]`, the second `results[1]`, every later one the last. */
function gate(...results: AcceptanceResult[]): (command: string, cwd: string) => Promise<AcceptanceResult> {
  let runs = 0;
  return async () => results[Math.min(runs++, results.length - 1)]!;
}

type PromptArgs = Parameters<AgentAdapter["prompt"]>[0];
type PromptResult = Awaited<ReturnType<AgentAdapter["prompt"]>>;
type Turn = { text: string; sessionId: string | undefined; model: string | undefined; rework: string | null };

/**
 * A worker that records, at the start of every turn, what it was given — the
 * prompt, the session, the model, and whether `rework.md` was on disk — and
 * then requests completion. `script` may answer a turn differently, `usage`
 * is what the context probe reports for a session, `text` is the default reply.
 */
function recorder(
  script: (turn: number, args: PromptArgs) => PromptResult | undefined | Promise<PromptResult | undefined> = () => undefined,
  usage: (sessionId: string) => number = () => 0,
  text = "done",
): { turns: Turn[]; adapter: AgentAdapter } {
  const turns: Turn[] = [];
  const adapter: AgentAdapter = {
    prompt: async (args) => {
      const turn = turns.push({
        text: args.text, sessionId: args.sessionId, model: args.model,
        rework: await readFile(reworkPath(), "utf8").catch(() => null),
      });
      const answer = await script(turn, args);
      if (answer !== undefined) return answer;
      await mkdir(join(tasks, "a"), { recursive: true });
      await writeFile(join(tasks, "a", "done.requested"), "done");
      return { sessionId: "s", text, exitCode: 0 };
    },
    contextUsage: async (sessionId) => usage(sessionId),
    contextLimit: async () => 100,
  };
  return { turns, adapter };
}
```

  Append the task's block:

```ts
describe("an acceptance failure", () => {
  it("is written to rework.md before the rework turn, and that turn — not the first — is pointed at it", async () => {
    await seed();
    const { turns, adapter } = recorder();

    expect(await runTask(config(), { store, adapter, acceptance: gate(failed, passed), review: async () => passVerdict }, await store.get("a"), "w1")).toBe("done");

    expect(turns.map((turn) => turn.sessionId)).toEqual([undefined, "s"]);
    expect(turns[0]!.rework).toBeNull();
    expect(turns[0]!.text).not.toContain("rework.md");
    expect(turns[1]!.text).toContain(pointer());
    // One line pointing at the file: the document itself is not in the prompt.
    expect(turns[1]!.text).not.toContain("返工说明");
    expect(turns[1]!.text).not.toContain("## 需要改变什么");
    expect(turns[1]!.rework).toContain("# 返工说明：任务 A（a）");
    expect(turns[1]!.rework).toContain("控制器的验收命令失败了（exit 1）。");
    expect(turns[1]!.rework).toContain("验收命令：npm test");
    expect(turns[1]!.rework).toContain("断言失败： expected 2, got 1");
    expect(turns[1]!.rework).toContain(`taskctl done --task a --tasks-dir "${tasks}"`);
  });

  it("still writes the acceptance-failed handoff note it wrote before", async () => {
    await seed();
    const { adapter } = recorder();
    await runTask(config(), { store, adapter, acceptance: gate(failed, passed), review: async () => passVerdict }, await store.get("a"), "w1");
    const note = await latestNote(tasks, "a");
    expect(note?.markdown).toContain("## Status\nacceptance-failed");
    expect(note?.markdown).toContain("断言失败： expected 2, got 1");
  });

  it("is written for a continuous task as well, after its escalation", async () => {
    await seed({ complexity: "simple", execution: "continuous" });
    const { turns, adapter } = recorder();
    expect(await runTask(config(), { store, adapter, acceptance: gate(failed, passed), review: async () => passVerdict }, await store.get("a"), "w1")).toBe("done");
    expect(turns[1]!.rework).toContain("验收命令：npm test");
    expect(turns[1]!.text).toContain(pointer());
    expect((await readJournal(tasks, "a")).some((line) => line.event === "escalated")).toBe(true);
  });

  it("is written again before a turn that follows a crashed rework turn", async () => {
    // The rework turn dies (exit 1) and the document is lost with it. Nothing
    // new was rejected, so the turn after it is pointed at the same document.
    await seed();
    const { turns, adapter } = recorder(async (turn) => {
      if (turn !== 2) return undefined;
      await rm(reworkPath(), { force: true });
      return { sessionId: "s", text: "进程崩了", exitCode: 1 };
    });
    expect(await runTask(config(), { store, adapter, acceptance: gate(failed, passed), review: async () => passVerdict }, await store.get("a"), "w1")).toBe("done");
    expect(turns).toHaveLength(3);
    expect(turns[2]!.rework).toContain("控制器的验收命令失败了（exit 1）。");
    expect(turns[2]!.text).toContain(pointer());
  });
});
```

  - In `tests/replace.test.ts`, add inside `describe("a file replace the OS refused", …)`:

```ts
  it("is retried while writing the rework document, and the rework turn still happens", async () => {
    // rework.md is what a rework turn is told to read. A rename of it that
    // Windows refuses must not cost the turn it was written for.
    refuse("rework.md", "EPERM");
    const prompts: string[] = [];
    const reworking: AgentAdapter = {
      prompt: async (args) => {
        prompts.push(args.text);
        await writeFile(join(tasks, "a", "done.requested"), "done");
        return { sessionId: "ses-a", exitCode: 0, text: "done" };
      },
      contextUsage: async () => 0, contextLimit: async () => 100,
    };
    const acceptance = vi.fn()
      .mockResolvedValueOnce({ passed: false, exitCode: 1, output: "boom", skipped: false })
      .mockResolvedValueOnce(accepted());
    const review = async () => ({ verdict: "pass" as const, criteria: [{ id: "C1", pass: true, evidence: "ok" }], externalChanges: [], defects: [], summary: "ok" });

    expect(await runTask({ ...config(), retryLimit: 2 }, { store, adapter: reworking, acceptance, review }, await store.get("a"), "a-run")).toBe("done");
    expect(state.refusals.get("rework.md")).toEqual([]);
    expect(state.attempts.get("rework.md")).toBeGreaterThanOrEqual(2);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain(`先读 \`${join(tasks, "a", "rework.md")}\``);
  });
```

- [ ] **2. Run it and expect FAIL.** `npx vitest run tests/rework.test.ts tests/replace.test.ts`. In `tests/rework.test.ts` three of the four new tests fail on `turns[1]!.text` / `turns[1]!.rework`: no document exists before the second turn (`rework` is `null`) and the prompt does not contain the pointer, `` 先读 `<…>\tasks\a\rework.md` ``. "still writes the acceptance-failed handoff note it wrote before" passes before and after: it is the control that the note stays. In `tests/replace.test.ts` the new test fails on `expect(state.refusals.get("rework.md")).toEqual([])`: the refusal is still queued because nothing ever renamed onto `rework.md`.
- [ ] **3. Implement** in `src/worker.ts`:
  - Imports: `buildWorkerPrompt` stays (line 11). The `./runtime.js` import (line 21), which ends `writeRuntime, type AttemptRecord } from "./runtime.js";`, gains `writeRuntimeText`: `…, writeRuntime, writeRuntimeText, type AttemptRecord } from "./runtime.js";`. Directly under it add `import { renderRwork, reworkPathOf, type ReworkFeedback } from "./rework.js";`.
  - `Run`: after `heartbeatWriteFailureNoted: boolean;` (line 235) add `rework: ReworkFeedback | null;` with a doc comment. In the literal, at the end of the line that ends `heartbeatWriteFailureNoted: false,` (line 290), add `rework: null,`.
  - Add `writeRwork` directly above `async function loop(r: Run): Promise<"done" | "blocked" | "open" | "awaiting-human"> {` (line 1066; `noteContext` ends just above it), with the signature above.
  - `accept()`: before `return "retry";` (line 1456; the anchor above) add the assignment above.
  - `loop()`: between `const note = await latestNote(r.cfg.tasksDir, r.task.id);` (line 1087) and `const protocol = buildWorkerPrompt(r.task, {` (line 1088) insert `if (r.rework !== null) await owned(r, () => writeRwork(r));`, and add `...(r.rework === null ? {} : { rework: reworkPathOf(r.cfg.tasksDir, r.task.id) }),` as the last member of the context object: directly after `...(context.memory === undefined ? {} : { memory: context.memory }),` (line 1096) and before the `});` that closes it (line 1097). The `dependencies` spread (line 1091) is no longer the last member — the five spreads the learning loop added follow it, and this one follows them.
  - Replace the comment `// The controller just wrote concrete failure feedback. Resume this` / `// same-model session instead of opening a fresh session that cannot see it.` (lines 1191–1192) with `// The controller wrote rework.md and the next turn is pointed at it. Resume this` / `// same-model session, which also sees the handoff note.`
- [ ] **4. Run it and expect PASS.** `npx vitest run tests/rework.test.ts tests/replace.test.ts tests/worker.test.ts tests/acceptance-fingerprint.test.ts` (the last two own the acceptance-failure paths that must not change), `npm run typecheck`, `npx tsc --noEmit`, `git diff --check`.
- [ ] **5. Directed mutation check** on `src/worker.ts`. Control: `npx vitest run tests/rework.test.ts tests/replace.test.ts` green.
  - M1 *the failure is not remembered* — remove the assignment in `accept()`. Must fail: the three tests of `tests/rework.test.ts` that expect the document after a failed gate — "is written to rework.md before the rework turn …", "is written for a continuous task as well, after its escalation" and "is written again before a turn that follows a crashed rework turn" — and `tests/replace.test.ts` "is retried while writing the rework document …" (nothing is renamed onto `rework.md`).
  - M2 *written once, not before every turn* — delete the loop-top write. Must fail: the same four tests as M1 — with no write at the top of the loop no document ever reaches the disk.
  - M3 *the prompt carries no path* — remove the `rework` member from the context. Must fail: the three tests that expect the pointer in a prompt that continues a session — "is written to rework.md before the rework turn …", "is written for a continuous task as well, after its escalation" and "is written again before a turn that follows a crashed rework turn" — and `tests/replace.test.ts` "is retried while writing the rework document …".
  - M4 *the prompt carries the document* — pass `renderRwork(…)`'s result instead of the path as `rework`. Must fail: the same three tests of `tests/rework.test.ts` as M3 — the document stands in the prompt where each expects ``先读 `<path>` `` — and `tests/replace.test.ts` "is retried while writing the rework document …".
  - M5 *the note removed* — remove the `writeNote` of the `acceptance-failed` note (lines 1441–1447; anchor `status: "acceptance-failed",`). Must fail: "still writes the acceptance-failed handoff note it wrote before" and `tests/worker.test.ts` "acceptance retry resumes the same session with the controller failure feedback".
  - M6 *a retry is spent differently* — not applicable: no retry accounting is touched; the control run of `tests/worker.test.ts` is the proof.
  - Restore check after each: `git diff --stat` shows only the task's files; hash equal to the scratch copy's; control green again.
- [ ] **6. Commit.** `git add src/worker.ts tests/rework.test.ts tests/replace.test.ts` — `feat(worker): write rework.md before a rework turn after an acceptance failure`.

---

### Task 4: A failed review is written, with the reviewer's evidence

**Files:**
- Modify: `src/worker.ts` (`judge`, lines 1762–1834)
- Test: Modify `tests/rework.test.ts`

**Interfaces:**
- Consumes: `ReviewResult`, `CriterionResult` (`src/review.ts:8–31`); `reviewNote(task, seq, result)` (`src/worker.ts:1875`), which stays as it is.
- Produces: `judge()` sets `r.rework = { kind: "review", round: rounds, summary: result.summary, failed: result.criteria.filter((criterion) => !criterion.pass), defects: [...result.defects] }` immediately before `const seq = ((await latestNote(r.cfg.tasksDir, id))?.seq ?? 0) + 1;` (line 1820; that exact sentence stands nowhere else in the file, but four lines almost like it — `r.task.id` where this has `id` — stand at 856, 891, 1421 and 1440, the first two in the block functions part 1 deletes; so place the assignment as the first line after the block that ends ``emit(r, "blocked", `review rounds exhausted (${rounds}/${limit})`);`` / `return "blocked";`) — after the rounds-exhausted block, so a verdict that blocks the task writes nothing.

- [ ] **1. Write the failing tests.** Add the helper below `gate`, then the block:

```ts
/** A reviewer: the first turn answers `verdicts[0]`, the second `verdicts[1]`, every later one the last. */
function judge(...verdicts: ReviewResult[]): () => Promise<ReviewResult> {
  let rounds = 0;
  return async () => verdicts[Math.min(rounds++, verdicts.length - 1)]!;
}
```

```ts
describe("a failed review", () => {
  it("is written to rework.md with each failed criterion, the reviewer's evidence and the defects, and the review note stays", async () => {
    await seed();
    const { turns, adapter } = recorder();

    expect(await runTask(config(), { store, adapter, acceptance: gate(passed), review: judge(failVerdict, passVerdict) }, await store.get("a"), "w1")).toBe("done");

    expect(turns[1]!.rework).toContain("独立复核没有通过（第 1 轮）：未达 C1");
    expect(turns[1]!.rework).toContain("- C1：读了 src/a.ts，看到宽度写死");
    expect(turns[1]!.rework).not.toContain("C2：");
    expect(turns[1]!.rework).toContain("- 🔴 宽度改为自适应");
    expect(turns[1]!.rework).toContain(`taskctl done --task a --tasks-dir "${tasks}"`);
    expect(turns[1]!.text).toContain(pointer());
    const note = await latestNote(tasks, "a");
    expect(note?.markdown).toContain("## Status\nreview-failed");
    expect(note?.markdown).toContain("🔴 宽度改为自适应");
  });

  it("writes nothing for a verdict that blocks the task instead of sending it back", async () => {
    await seed();
    const { turns, adapter } = recorder();
    expect(await runTask(config({ maxReviewRounds: 0 }), { store, adapter, acceptance: gate(passed), review: judge(failVerdict) }, await store.get("a"), "w1")).toBe("blocked");
    expect(turns).toHaveLength(1);
    expect(await readRwork(tasks, "a")).toBeNull();
  });
});
```

- [ ] **2. Run it and expect FAIL.** `npx vitest run tests/rework.test.ts` — "is written to rework.md with each failed criterion, …" fails on `turns[1]!.text` (`expected '…' to contain '先读 …'`): after a review failure the next prompt is byte-identical to the first. "writes nothing for a verdict that blocks …" passes before and after; it is the control that the document is tied to the rework, not to the verdict.
- [ ] **3. Implement.** `src/worker.ts`: the one assignment in `judge()` at the place above.
- [ ] **4. Run it and expect PASS.** `npx vitest run tests/rework.test.ts tests/worker-review.test.ts tests/lanes.test.ts`, `npm run typecheck`, `npx tsc --noEmit`, `git diff --check`.
- [ ] **5. Directed mutation check** on `src/worker.ts`. Control: `npx vitest run tests/rework.test.ts` green.
  - M1 *the verdict is not remembered* — remove the assignment. Must fail: "is written to rework.md with each failed criterion, …".
  - M2 *every criterion listed* — `failed: result.criteria`. Must fail: the same test (`not.toContain("C2：")`).
  - M3 *no defects* — `defects: []`. Must fail: the same test.
  - M4 *the round off by one* — `round: rounds - 1`. Must fail: the same test (`第 1 轮`).
  - M5 *the review note removed* — remove `await writeNote(r.cfg.tasksDir, reviewNote(r.task, seq, result));`. Must fail: the same test and `tests/worker-review.test.ts` "a failing review resumes the same worker session with a note and a round".
  - Restore check: hash equal to the scratch copy's; control green again.
- [ ] **6. Commit.** `git add src/worker.ts tests/rework.test.ts` — `feat(worker): put the reviewer's failed criteria and defects into rework.md`.

---

### Task 5: A failed render check is written

**Files:**
- Modify: `src/worker.ts` (`acceptRender`, lines 1492–1545; its last three lines, 1543–1545)
- Test: Modify `tests/rework.test.ts`

**Interfaces:**
- Consumes: `describeFailures(check): string[]` (`src/render.ts:291`); `RenderCheck` (`src/render.ts:33`).
- Produces: `acceptRender()` sets `r.rework = { kind: "render", failures }` between `if (await fail(r)) return "blocked";` and `return "retry";` (anchor: those two lines, 1543–1544, followed by the closing brace of `acceptRender`). If part 2 has landed, its stop check stands further up, before `render.json` is written; it is not moved.

- [ ] **1. Write the failing tests.**

```ts
describe("a failed render check", () => {
  const view = (viewport: string, problems: string[]) => ({
    target: join(work, "index.html"), viewport, ok: problems.length === 0, problems,
    screenshot: join(tasks, "a", "evidence", `index-${viewport}.png`),
    measurements: { scrollWidth: 900, clientWidth: 390, textLength: 20, images: 0, brokenImages: 0 },
  });

  it("is written to rework.md — the only feedback a render failure has ever left — and the turn is pointed at it", async () => {
    await writeFile(join(tasks, "a.md"), serializeTaskFile(buildTaskFile({ id: "a", title: "任务 A", status: "open", verify: "render", renderTargets: ["index.html"] })), "utf8");
    vi.mocked(checkRender).mockReset()
      .mockResolvedValueOnce({ ok: false, browser: "fake", at: "2026-11-25T10:00:00.000Z", views: [view("390x844", ["overflow"]), view("1440x900", ["script-error"])] })
      .mockResolvedValue({ ok: true, browser: "fake", at: "2026-11-25T10:00:01.000Z", views: [view("1440x900", [])] });
    const { turns, adapter } = recorder();

    expect(await runTask(config(), { store, adapter }, await store.get("a"), "w1")).toBe("done");

    expect(turns[1]!.rework).toContain("渲染验收失败");
    expect(turns[1]!.rework).toContain(`${join(work, "index.html")} @ 390x844: ${PROBLEM_TEXT.overflow}`);
    expect(turns[1]!.rework).toContain(`${join(work, "index.html")} @ 1440x900: ${PROBLEM_TEXT["script-error"]}`);
    expect(turns[1]!.rework).toContain(join(tasks, "a", "evidence"));
    expect(turns[1]!.text).toContain(pointer());
    expect(await latestNote(tasks, "a")).toBeNull();
  });

  it("writes nothing when the retry budget, not the worker, ends the attempt", async () => {
    // The document is tied to the rework turn that follows, not to the verdict.
    await writeFile(join(tasks, "a.md"), serializeTaskFile(buildTaskFile({ id: "a", title: "任务 A", status: "open", verify: "render", renderTargets: ["index.html"] })), "utf8");
    vi.mocked(checkRender).mockReset().mockResolvedValue({ ok: false, browser: "fake", at: "2026-11-25T10:00:00.000Z", views: [view("390x844", ["overflow"])] });
    const { turns, adapter } = recorder();
    expect(await runTask(config({ retryLimit: 1 }), { store, adapter }, await store.get("a"), "w1")).toBe("blocked");
    expect(turns).toHaveLength(1);
    expect(await readRwork(tasks, "a")).toBeNull();
  });
});
```

- [ ] **2. Run it and expect FAIL.** `npx vitest run tests/rework.test.ts` — "is written to rework.md — the only feedback …" fails on `turns[1]!.rework`: `expected null to contain '渲染验收失败'`. No handoff note has ever been written for a render failure, so today the second turn is told nothing at all. "writes nothing when the retry budget …" passes before and after: it is the control that a block writes no document.
- [ ] **3. Implement.** `src/worker.ts`: the one assignment in `acceptRender()` at the place above.
- [ ] **4. Run it and expect PASS.** `npx vitest run tests/rework.test.ts tests/render-escalation.test.ts tests/lanes.test.ts`, `npm run typecheck`, `npx tsc --noEmit`, `git diff --check`.
- [ ] **5. Directed mutation check** on `src/worker.ts`. Control: `npx vitest run tests/rework.test.ts` green.
  - M1 *the failure is not remembered* — remove the assignment. Must fail: "is written to rework.md — the only feedback …".
  - M2 *one view only* — `failures.slice(0, 1)`. Must fail: the same test (the 1440x900 line).
  - M3 *no screenshots named* — `src/rework.ts`: drop `失败那一屏的截图在 … evidence，先看它。` from the bullet. Must fail: the same test and `tests/rework.test.ts` "names each view that failed the render check and where its screenshot is".
  - Restore check: hash equal to the scratch copy's; control green again.
- [ ] **6. Commit.** `git add src/worker.ts tests/rework.test.ts` — `feat(worker): put a failed render check into rework.md`.

---

### Task 6: A turn that did not request completion, and the worker's own ESCALATE

**Files:**
- Modify: `src/worker.ts` (`Run`, lines 204–236; `escalate`, lines 469–477; the loop's ESCALATE marker, lines 1136–1137; the branch chain, lines 1193–1221)
- Test: Modify `tests/rework.test.ts`

**Interfaces:**
- Consumes: `ESCALATE_MARKER` (`src/worker.ts:55`); `escalate(r, reason)` (`:469`); `effectiveExecution(r)` (`:240`); `MAX_TURNS_PER_SESSION_DEFAULT` (`:38`).
- Produces, `src/worker.ts`:
  - `Run.workerEscalation?: string` — the worker's own `ESCALATE:` reason in this attempt.
  - `function unanswered(previous: ReworkFeedback | null, why: string): ReworkFeedback` (module-private) — `{ kind: "no-completion", why, previous: previous?.kind === "no-completion" ? previous.previous : previous }`.
  - Three places set a `no-completion` feedback, each only when the turn ended well without a completion request and something changed with it:
    - continuous lane (before `escalate(r, "continuous turn ended without a completion request")`): `why` = `上一回合正常结束，但没有请求完成（没有运行 taskctl done）。连续执行的任务本应在一个回合内做完并请求验收；没有做到，任务已升级为迭代执行（iterative）。控制器没有可以验收的成果。`
    - turn budget (before `escalate(r, "session turn budget exhausted")`): `why` = `` `本会话的 ${max} 个回合已用完，仍没有请求完成（没有运行 taskctl done）。任务保持迭代执行，并换一个新会话接着做。` `` with `max` the same bound the branch compares against.
    - the worker escalated in this very turn and the two branches above did not apply: `why` = `上一回合正常结束，但没有请求完成（没有运行 taskctl done）；你在这一回合里把任务升级了（见下文）。控制器没有可以验收的成果。`
  - An iterative task's ordinary progress turn — no completion request, budget left, no escalation — sets nothing.

- [ ] **1. Write the failing tests.**

```ts
describe("a turn that ends without a completion request", () => {
  const noCompletion = { sessionId: "s", text: "还在做", exitCode: 0 };

  it("a continuous task's first turn that does not request completion is told why before the next turn", async () => {
    await seed({ complexity: "simple", execution: "continuous" });
    const { turns, adapter } = recorder((turn) => (turn === 1 ? noCompletion : undefined));

    expect(await runTask(config(), { store, adapter, acceptance: gate(passed), review: async () => passVerdict }, await store.get("a"), "w1")).toBe("done");

    expect(turns).toHaveLength(2);
    expect(turns[0]!.rework).toBeNull();
    expect(turns[1]!.rework).toContain("没有请求完成（没有运行 taskctl done）");
    expect(turns[1]!.rework).toContain("升级为迭代执行（iterative）");
    expect(turns[1]!.text).toContain(pointer());
    expect((await readJournal(tasks, "a")).some((line) => line.event === "escalated")).toBe(true);
  });

  it("an iterative task working turn by turn is not told it did not pass", async () => {
    await seed();
    const { turns, adapter } = recorder((turn) => (turn === 1 ? noCompletion : undefined));

    expect(await runTask(config(), { store, adapter, acceptance: gate(passed), review: async () => passVerdict }, await store.get("a"), "w1")).toBe("done");

    expect(turns).toHaveLength(2);
    expect(turns[1]!.rework).toBeNull();
    expect(turns[1]!.text).not.toContain("rework.md");
    expect(turns[1]!.text).not.toContain("上一回合没有通过");
  });

  it("a session whose turn budget runs out is told so in the session that replaces it", async () => {
    await seed();
    const { turns, adapter } = recorder((turn) => (turn <= 2 ? noCompletion : undefined));

    expect(await runTask(config({ maxTurnsPerSession: 2 }), { store, adapter, acceptance: gate(passed), review: async () => passVerdict }, await store.get("a"), "w1")).toBe("done");

    expect(turns.map((turn) => turn.sessionId)).toEqual([undefined, "s", undefined]);
    expect(turns[1]!.rework).toBeNull();
    expect(turns[2]!.rework).toContain("本会话的 2 个回合已用完，仍没有请求完成（没有运行 taskctl done）");
    expect(turns[2]!.text).toContain(pointer());
  });

  it("keeps the reasons of a rejection the session was already working on", async () => {
    await seed();
    const { turns, adapter } = recorder((turn) => (turn === 2 || turn === 3 ? noCompletion : undefined));

    expect(await runTask(config({ maxTurnsPerSession: 2 }), { store, adapter, acceptance: gate(failed, passed), review: async () => passVerdict }, await store.get("a"), "w1")).toBe("done");

    // Turn 1 fails the gate (a document); turn 2 exhausts the budget on top of it.
    expect(turns[2]!.rework).toContain("本会话的 2 个回合已用完");
    expect(turns[2]!.rework).toContain("## 仍然适用的上一轮否决");
    expect(turns[2]!.rework).toContain("断言失败： expected 2, got 1");
    // Turn 3 is ordinary progress again: the same document, not a third layer.
    expect(turns[3]!.rework!.match(/## 仍然适用的上一轮否决/g)).toHaveLength(1);
    expect(turns[3]!.rework).toContain("本会话的 2 个回合已用完");
  });
});

describe("the worker's own ESCALATE reason", () => {
  it("is written into the document when the worker escalates in a turn that does not request completion", async () => {
    await seed();
    const { turns, adapter } = recorder((turn) => (turn === 1 ? { sessionId: "s", text: "范围比预想大\nESCALATE: 产物从一张表变成了三张", exitCode: 0 } : undefined));

    expect(await runTask(config(), { store, adapter, acceptance: gate(passed), review: async () => passVerdict }, await store.get("a"), "w1")).toBe("done");

    expect(turns[1]!.rework).toContain("没有请求完成（没有运行 taskctl done）；你在这一回合里把任务升级了");
    expect(turns[1]!.rework).toContain("## 你在上一回合提出的升级");
    expect(turns[1]!.rework).toContain("ESCALATE: 产物从一张表变成了三张");
    expect(turns[1]!.rework).toContain("此后必须经过独立复核");
    expect(turns[1]!.text).toContain(pointer());
  });

  it("travels with a later rejection in the same attempt", async () => {
    // Turn 1 escalates and asks to be judged; the gate fails. The document
    // says why the gate failed and repeats the worker's own reason.
    await seed();
    const { turns, adapter } = recorder(undefined, undefined, "ESCALATE: 产物从一张表变成了三张");

    expect(await runTask(config(), { store, adapter, acceptance: gate(failed, passed), review: async () => passVerdict }, await store.get("a"), "w1")).toBe("done");

    expect(turns[1]!.rework).toContain("验收命令：npm test");
    expect(turns[1]!.rework).toContain("## 你在上一回合提出的升级");
    expect(turns[1]!.rework).toContain("ESCALATE: 产物从一张表变成了三张");
  });

  it("writes nothing by itself when the worker escalates and passes", async () => {
    await seed({ complexity: "simple", execution: "continuous" });
    const { turns, adapter } = recorder(undefined, undefined, "ESCALATE: 产物从一张表变成了三张");
    expect(await runTask(config(), { store, adapter, acceptance: gate(passed), review: async () => passVerdict }, await store.get("a"), "w1")).toBe("done");
    expect(turns).toHaveLength(1);
    expect(await readRwork(tasks, "a")).toBeNull();
  });
});
```

- [ ] **2. Run it and expect FAIL.** `npx vitest run tests/rework.test.ts` — the continuous, turn-budget, "keeps the reasons" and both ESCALATE tests fail on `turns[n]!.rework`: `expected null to contain '…'`. "an iterative task working turn by turn …" and "writes nothing by itself …" pass before and after: they are the controls that nothing is written where nothing changed.
- [ ] **3. Implement** in `src/worker.ts`:
  - `Run`: add `workerEscalation?: string` after `rework`.
  - Add `unanswered` next to `escalate`.
  - Replace lines 1136–1137 (`const marker = ESCALATE_MARKER.exec(result.text ?? "");` / `if (marker) await escalate(r, marker[1]!.trim());`) with:
    ```ts
    const marker = ESCALATE_MARKER.exec(result.text ?? "");
    const workerEscalatedThisTurn = marker !== null;
    if (marker) {
      // The worker's own words about why the task outgrew its lane travel with
      // every document written for the rest of this attempt.
      r.workerEscalation = marker[1]!.trim();
      await escalate(r, r.workerEscalation);
    }
    ```
  - The three branches that begin at line 1193 (`} else if (effectiveExecution(r) === "continuous") {`) and end at line 1221 (the closing brace of the over-budget branch) become one `} else { … }` whose body is:
    ```ts
    // The turn ended without asking to be judged. That is a fact for the
    // worker only when something changed with it: the continuous lane gave
    // way, the session's turn budget ran out, or the worker escalated. Plain
    // progress through an iterative task is not a rejection and says nothing.
    if (effectiveExecution(r) === "continuous") {
      r.rework = unanswered(r.rework, "…continuous why…");
      await escalate(r, "continuous turn ended without a completion request");
    } else if (turns >= (r.cfg.maxTurnsPerSession ?? MAX_TURNS_PER_SESSION_DEFAULT)) {
      r.rework = unanswered(r.rework, `…turn-budget why…`);
      await escalate(r, "session turn budget exhausted");
      if (await fail(r)) return "blocked";
      fresh = true;
    } else if (await overBudget(r, sessionId, model)) {
      …the existing body of that branch, unchanged — taken as it stands when you get there…
    } else if (workerEscalatedThisTurn) {
      r.rework = unanswered(r.rework, "…worker-escalated why…");
    }
    ```
    with the three `why` strings of the Interfaces section, and the existing comments kept with their branches. Part 1 lands first and rewrites the wrap-up turn's provider branch inside the over-budget branch (lines 1208–1213 at `0eb2d74`); that block is part 1's and is taken as it stands.
  - `writeRwork`: add `...(r.workerEscalation === undefined ? {} : { escalation: r.workerEscalation })` to the arguments of `renderRwork`, so every document of the attempt carries the worker's reason.
- [ ] **4. Run it and expect PASS.** `npx vitest run tests/rework.test.ts tests/worker.test.ts tests/lanes.test.ts tests/execution-state.test.ts`, `npm run typecheck`, `npx tsc --noEmit`, `git diff --check`.
- [ ] **5. Directed mutation check** on `src/worker.ts`. Control: `npx vitest run tests/rework.test.ts` green.
  - M1 *the continuous turn says nothing* — remove the assignment in the continuous branch. Must fail: "a continuous task's first turn that does not request completion is told why before the next turn".
  - M2 *the budget says nothing* — remove the assignment in the budget branch. Must fail: "a session whose turn budget runs out is told so in the session that replaces it" and "keeps the reasons of a rejection the session was already working on".
  - M3 *every turn is a rejection* — set `r.rework = unanswered(r.rework, "…")` at the top of the `else` body, before the `if`. Must fail: "an iterative task working turn by turn is not told it did not pass".
  - M4 *the worker's escalation is not an event* — delete the `else if (workerEscalatedThisTurn)` branch. Must fail: "is written into the document when the worker escalates in a turn that does not request completion".
  - M5 *the earlier rejection dropped* — `unanswered` returns `previous: null`. Must fail: "keeps the reasons of a rejection the session was already working on".
  - M6 *the reason is not kept* — do not assign `r.workerEscalation`. Must fail: both tests of "the worker's own ESCALATE reason" that expect a document.
  - M7 *the reason is not rendered* — `writeRwork` no longer passes `escalation`. Must fail: the same two tests.
  - Restore check: hash equal to the scratch copy's; control green again.
- [ ] **6. Commit.** `git add src/worker.ts tests/rework.test.ts` — `feat(worker): tell the worker when a turn without a completion request changes the run`.

---

### Task 7: Owed across sessions and attempts, removed on a pass

**Files:**
- Modify: `src/worker.ts` (`runTask`, lines 344–345 and 400–402; new `settleRework`; `resumeReviewOnly`, lines 1316–1319; the loop-top write from Task 3)
- Modify: `src/rework.ts` (one function)
- Test: Modify `tests/rework.test.ts`

**Interfaces:**
- Produces, `src/rework.ts`: `export async function carriedRework(tasksDir: string, id: string): Promise<ReworkFeedback | null>` — `{ kind: "carried", markdown }` for what `readRwork` finds, null when there is nothing.
- Produces, `src/worker.ts`: `async function settleRework(r: Run, outcome: TaskOutcome): Promise<void>` — for `done` and `awaiting-human`: set `r.rework = null` and `rm(reworkPathOf(r.cfg.tasksDir, r.task.id), { force: true })`; a removal that throws is journaled (`stage: "worker", event: "rework-clear-failed"`) and never propagates — it must not turn a finished task into a controller error. For every other outcome: nothing — `open` (a review-only recovery that opens rework, and part 1's deferral), `blocked`, `skipped`, `refused`, and `stopped` if part 2 has landed (which never reaches this line anyway).
- Consumes: `retryTask` (`src/reconcile.ts:135`), `reject` (`rejectCommand`, `src/cli.ts:1294`) — unchanged by this plan, called by the tests.

- [ ] **1. Write the failing tests.**

```ts
describe("a rework owed beyond the turn that follows", () => {
  const providerRefusal: ReviewResult = { verdict: "unclear", criteria: [], externalChanges: [], defects: [], summary: "provider quota refused", failure: "provider" };
  const refusal: PromptResult = { sessionId: "", exitCode: 1, text: "weekly limit reached", failure: "provider", tokens: 0 };

  it("survives a model switch: the session opened on the next model is pointed at the same document", async () => {
    await seed();
    const { turns, adapter } = recorder((turn, args) => (turn === 2 && args.model === "w/one" ? refusal : undefined));
    const cfg = config({ model: "w/one", modelFallbacks: ["q/two"], quotaBackoffMs: [0] });

    expect(await runTask(cfg, { store, adapter, acceptance: gate(failed, passed), review: async () => passVerdict }, await store.get("a"), "w1")).toBe("done");

    expect(turns.map((turn) => turn.model)).toEqual(["w/one", "w/one", "q/two"]);
    expect(turns.map((turn) => turn.sessionId)).toEqual([undefined, "s", undefined]);
    expect(turns[2]!.rework).toContain("断言失败： expected 2, got 1");
    expect(turns[2]!.text).toContain(pointer());
  });

  it("survives a context wrap: the new session gets the handoff note and the pointer", async () => {
    await seed();
    // A model is named: `overBudget` answers false without asking when the
    // turn ran on none.
    let work = 0;
    const { turns, adapter } = recorder(async (turn, args) => {
      if (args.text === WRAP_UP_INSTRUCTION) {
        await writeNote(tasks, { task: "a", seq: 2, status: "进行中；预算告急", done: "修了一半", found: "断言在第 3 行", next: "继续修", files: [] });
        return { sessionId: args.sessionId!, text: "HANDOFF_READY", exitCode: 0 };
      }
      work += 1;
      return work === 2 ? { sessionId: "s", text: "还在修", exitCode: 0 } : undefined;
    }, (sessionId) => (sessionId === "s" && work >= 2 ? 900_000 : 0));

    expect(await runTask(config({ model: "w/one" }), { store, adapter, acceptance: gate(failed, passed), review: async () => passVerdict }, await store.get("a"), "w1")).toBe("done");

    // The recorder notes every prompt, the wrap-up turn included: turn 1
    // fails the gate, turn 2 is ordinary progress on the rejection, turn 3
    // wraps the session up, turn 4 opens the new one.
    expect(turns.map((turn) => turn.sessionId)).toEqual([undefined, "s", "s", undefined]);
    expect(turns[2]!.text).toBe(WRAP_UP_INSTRUCTION);
    // Turn 2 was ordinary progress on the rejection; the wrap that followed it
    // did not turn it into a new one.
    expect(turns[3]!.rework).toContain("控制器的验收命令失败了（exit 1）。");
    expect(turns[3]!.rework).not.toContain("没有请求完成");
    expect(turns[3]!.text).toContain(pointer());
    expect(turns[3]!.text).toContain("修了一半");
  });

  it("is handed to a later attempt by a review-only recovery that fails", async () => {
    // Written for part 1 as its plan builds it (its Task 6): a refused review
    // defers the task — `open`, its evidence kept — instead of parking it,
    // and the next claim resumes the review by itself. `modelCooldownMs: 0`
    // lets that claim through at once, and lets the refused model be asked again.
    // 1. The worker finishes, the gate passes, the reviewer refuses: deferred.
    const first = recorder();
    const deferred = config({ reviewerModel: "r/two", modelCooldownMs: 0 });
    expect(await runTask(deferred, { store, adapter: first.adapter, acceptance: gate(passed), review: async () => providerRefusal }, await store.get("a"), "w1")).toBe("open");
    expect(await readRwork(tasks, "a")).toBeNull();

    // 2. The next claim resumes the review on the preserved evidence and
    //    reaches a real fail verdict. It runs no worker, so the rework turn
    //    belongs to a later attempt.
    expect(await runTask(deferred, { store, adapter: first.adapter, acceptance: gate(passed), review: judge(failVerdict) }, await store.get("a"), "w2")).toBe("open");
    expect(await readRwork(tasks, "a")).toContain("独立复核没有通过（第 1 轮）：未达 C1");

    // 3. That attempt's first turn is the rework turn.
    const second = recorder();
    expect(await runTask(config({ reviewerModel: "r/two" }), { store, adapter: second.adapter, acceptance: gate(passed), review: judge(passVerdict) }, await store.get("a"), "w3")).toBe("done");
    expect(second.turns[0]!.text).toContain(pointer());
    expect(second.turns[0]!.rework).toContain("独立复核没有通过（第 1 轮）：未达 C1");
    expect(await readRwork(tasks, "a")).toBeNull();
  });

  it("stays on disk when the attempt is blocked, so a retry is pointed at it", async () => {
    await seed();
    const first = recorder();
    expect(await runTask(config({ retryLimit: 2 }), { store, adapter: first.adapter, acceptance: gate(failed) }, await store.get("a"), "w1")).toBe("blocked");
    expect(await readRwork(tasks, "a")).toContain("断言失败： expected 2, got 1");

    expect(await retryTask(tasks, "a", { baseWorkdir: work })).toMatchObject({ ok: true });
    const second = recorder();
    expect(await runTask(config({ retryLimit: 2 }), { store, adapter: second.adapter, acceptance: gate(passed), review: async () => passVerdict }, await store.get("a"), "w2")).toBe("done");
    expect(second.turns[0]!.text).toContain(pointer());
    expect(second.turns[0]!.rework).toContain("断言失败： expected 2, got 1");
    expect(await readRwork(tasks, "a")).toBeNull();
  });

  it("is removed when the work passes, so a session opened after a human reject is not pointed at a stale rejection", async () => {
    await seed({ risk: "high" });
    const first = recorder();
    expect(await runTask(config(), { store, adapter: first.adapter, acceptance: gate(passed), review: judge(failVerdict, passVerdict) }, await store.get("a"), "w1")).toBe("awaiting-human");
    expect(first.turns[1]!.rework).toContain("独立复核没有通过（第 1 轮）");
    expect(await readRwork(tasks, "a")).toBeNull();

    const rejected: string[] = [];
    expect(await runCli(["reject", "--task", "a", "--reason", "按钮没对齐", "--tasks-dir", tasks], { log: (line) => rejected.push(line) })).toBe(0);
    const second = recorder();
    expect(await runTask(config(), { store, adapter: second.adapter, acceptance: gate(passed), review: judge(passVerdict) }, await store.get("a"), "w2")).toBe("awaiting-human");

    expect(second.turns[0]!.text).not.toContain("rework.md");
    expect(second.turns[0]!.rework).toBeNull();
    // What the worker is told is the human's reason, through the note reject wrote.
    expect(second.turns[0]!.text).toContain("按钮没对齐");
  });

  it("a document that cannot be removed is journaled, and the task still finishes", async () => {
    await seed();
    // The worker has read the document in turn 2; before the pass is settled a
    // directory sits where the file was. Node refuses `rm` on a directory that
    // is not removed recursively (`ERR_FS_EISDIR`), on every platform.
    const { turns, adapter } = recorder(async (turn) => {
      if (turn !== 2) return undefined;
      await rm(reworkPath(), { force: true });
      await mkdir(reworkPath());
    });

    expect(await runTask(config(), { store, adapter, acceptance: gate(failed, passed), review: async () => passVerdict }, await store.get("a"), "w1")).toBe("done");

    expect(turns[1]!.rework).toContain("控制器的验收命令失败了（exit 1）。");
    expect((await readJournal(tasks, "a")).some((line) => line.event === "rework-clear-failed")).toBe(true);
  });
});
```

- [ ] **2. Run it and expect FAIL.** `npx vitest run tests/rework.test.ts`:
  - "is handed to a later attempt …" fails at step 2 on `expect(await readRwork(tasks, "a")).toContain(…)`: `expected null to contain '…'` — a review-only claim writes no document.
  - "stays on disk when the attempt is blocked …" fails on `second.turns[0]!.text`: a new attempt does not know that a rework is owed to it.
  - "is removed when the work passes …" fails on `expect(await readRwork(tasks, "a")).toBeNull()` after the first run: the document outlived the pass.
  - "a document that cannot be removed …" fails on the journal line: nothing is ever removed, so nothing is ever journaled.
  - "survives a model switch …" and "survives a context wrap …" pass already with the code of Tasks 3–6. They are the Review Focus regressions that prove the property across a session boundary, and they are what the mutations below must break.
- [ ] **3. Implement.**
  - `src/rework.ts`: add `carriedRework`.
  - `src/worker.ts`, `runTask`: after the `execution-state-invalid` journal block (the `if` that writes it closes with `}` on line 344; the call's own `});` is the line above) and before `const previous = await readAttempt(cfg.tasksDir, task.id);` (line 345), add `if (!r.reviewOnly) r.rework = await carriedRework(cfg.tasksDir, task.id);` with a comment: a document left by an earlier attempt means that attempt sent the work back and no turn has answered yet. It reads `r.reviewOnly` where part 1 has already set it: its automatic review resumption stands after line 336, above this line.
  - `runTask`: between `const outcome = r.reviewOnly ? await resumeReviewOnly(r, reviewPending!) : await loop(r);` (line 400) and `await checkpoint(r, "settled", "finished");` (line 402) add `await settleRework(r, outcome);`, and declare `settleRework` with the signature above (next to `writeRwork`).
  - `loop`: the write's condition becomes `r.rework !== null && r.rework.kind !== "carried"` — a carried document is already on disk and keeps the time it was written.
  - `resumeReviewOnly`: inside `if (outcome === "retry") {` (line 1316), before `await owned(r, () => r.deps.store.setStatus(r.task.id, "open"));` (line 1319), add `await owned(r, () => writeRwork(r));`, and extend the comment: "… and the document the next attempt's worker will be pointed at." If part 2 has landed, `assertNotStopped(r);` is the function's first statement; it stays.
- [ ] **4. Run it and expect PASS.** `npx vitest run tests/rework.test.ts tests/review-pending.test.ts tests/reconcile.test.ts`, `npm run typecheck`, `npx tsc --noEmit`, `git diff --check`. Then the whole suite once, before the documentation task: `npm test` — all green; the count is the one noted before Task 1 plus this plan's tests (1 skipped, `tests/e2e.smoke.test.ts`, which needs `TASKCTL_E2E=1` and a real backend, as before).
- [ ] **5. Directed mutation check** on `src/worker.ts`. Control: `npx vitest run tests/rework.test.ts` green.
  - M1 *the recovery does not hand it on* — remove the write in `resumeReviewOnly`. Must fail: "is handed to a later attempt by a review-only recovery that fails".
  - M2 *a new attempt forgets what is owed* — remove the `carriedRework` line. Must fail: "is handed to a later attempt …" and "stays on disk when the attempt is blocked, so a retry is pointed at it".
  - M3 *a pass leaves it* — make `settleRework` return before removing (`if (false) { rm … }`). Must fail: "is removed when the work passes …" and the last expectation of "is handed to a later attempt …" and of "stays on disk when the attempt is blocked, so a retry is pointed at it" (each ends on a pass).
  - M4 *a block removes it* — delete the `done` / `awaiting-human` guard so every outcome removes. Must fail: "stays on disk when the attempt is blocked, so a retry is pointed at it".
  - M5 *a failed removal fails the task* — remove the `try`/`catch` around the `rm`, so the error escapes `settleRework`. Must fail: "a document that cannot be removed is journaled, and the task still finishes" (the task comes back `blocked` instead of `done`).
  - M6 *a fresh session is not pointed at it* — add `&& sessionId !== undefined` to the condition of the `rework` member in the prompt context. Must fail: every rework turn that opens a session — "survives a model switch …", "survives a context wrap …", the first turn of the later attempt in "is handed to a later attempt …" and in "stays on disk when the attempt is blocked …" (all Task 7), and "a session whose turn budget runs out is told so in the session that replaces it" (Task 6).
  - M7 *the recovery's document is not kept for the next attempt* — make `carriedRework` answer `null` when the file is there. Must fail: "is handed to a later attempt …" (step 3) and "stays on disk when the attempt is blocked …".
  - Restore check: hash equal to the scratch copy's; control green again.
- [ ] **6. Commit.** `git add src/worker.ts src/rework.ts tests/rework.test.ts` — `feat(worker): keep rework.md owed across sessions and attempts, and clear it on a pass`.

---

### Task 8: Documentation

**Files:**
- Modify: `README.md` (five places: the list of auxiliary files, line 137 at `0eb2d74`; the **iterative** bullet, line 187; the **返工** bullet, line 223; the paragraph and the table row of 「worker 拿到什么」, lines 246 and 252)

No runtime change: there is no failing test to write and no guard to reverse. The check is that every sentence names a flag, a file or a command that exists. Parts 1 and 2 have moved these lines by now; part 1 also adds `model-wait.json` to the same list of auxiliary files (after `models.json`) and replaces the **Reviewer 不可用** bullet right under the **iterative** one, and part 2 edits other lines of the README. None of them touches the text anchored on below. The README text quotes the line of Task 2: it is written with the wording the owner signed.

- [ ] **1. Edit `README.md`.**
  - The list of auxiliary files (line 137): directly after `` `sessions/0001-handoff.md`（交接笔记） `` and before `` 。运行时记录不拥有任务状态 `` insert this text:

    ```text
    、`rework.md`（返工说明：上一回合为什么被打回、要改什么；任务通过后删除，2026-11-25）
    ```
  - The **iterative** bullet (line 187): append this sentence at the end of the bullet:

    ```text
    每次返工前，控制器把「为什么被打回、要改什么」写成 `tasks/<id>/rework.md`，提示词只用一行指向这个文件，不把内容塞进提示词；换模型或上下文交接之后新开的 session 同样被指向它（2026-11-25）。
    ```

  - The **返工** bullet (line 223): replace `` 复核不过会写一条 `review-failed` 笔记， `` with `` 复核不过会写一条 `review-failed` 笔记和 `rework.md`， ``; then add this bullet directly after it:

    ```text
    - **返工说明（`rework.md`，2026-11-25）**：每次返工前控制器重写 `tasks/<id>/rework.md`，提示词在 `## 工作规则` 下固定多出一条：「- 上一回合没有通过。开始之前先读 `<路径>`：里面写了原因，以及必须改什么。」不是返工回合时没有这一行，连空行都不留。内容只来自控制器已经掌握的事实：验收命令的退出码与输出结尾（最多 4000 字符，截断时写明完整输出在 `acceptance.json`）；复核未通过的标准、复核者的依据与缺陷；渲染验收失败的页面、视口与截图位置；连续执行的任务第一个回合没有请求完成、会话回合预算用尽、或 worker 自己写了 `ESCALATE:`（附它的原因）。迭代任务的普通进度回合不写它，回合崩溃、被 provider 拒绝或超时也不写——那些不是被打回。任务通过（`done` 或 `awaiting-human`）时文件删除；`blocked` 之后 `taskctl retry` 重开时它仍在，新 attempt 的第一个回合照样被指向它。
    ```

    Part 1 has landed, so the same bullet goes on: 「模型全部被拒而推迟时（`tasks/<id>/model-wait.json`）文件同样留着，窗口过后新 attempt 的第一个回合照样被指向它。」 If part 2 has landed as well: 「被 `taskctl stop --now` 打断时也一样。」
  - 「worker 拿到什么」: at the end of the paragraph that ends `` 所以没有这些文件的任务，提示词和加这五节之前逐字节相同。 `` (line 246) add this sentence:

    ```text
    工作规则里还有一行可选的（2026-11-25）：只在返工回合出现，指向 `tasks/<id>/rework.md`；不是返工回合时整行省略，同样连空行都不留。
    ```

    and in the table under it replace `` | 3 | 工作规则 | 固定文案 | 8 条，不变 | `` (line 252) with:

    ```text
    | 3 | 工作规则 | 固定文案 | 8 条，不变；返工回合时在最前面多一行指向 `tasks/<id>/rework.md`（见「返工说明」） |
    ```
- [ ] **2. Check each statement against the code.** `grep -n "rework.md" src/protocol.ts src/worker.ts src/rework.ts README.md` shows the README statements beside their source; `grep -n "REWORK_OUTPUT_CHARS = " src/rework.ts` shows `4_000`; `grep -n "settleRework" src/worker.ts` shows the removal on `done` / `awaiting-human`; `Select-String -Path README.md -Pattern 'Before you start, read'` prints nothing — the README carries the line as signed, in Chinese.
- [ ] **3. Gates.** `npm test`, `npm run typecheck`, `npx tsc --noEmit`, `git diff --check`; `.\scripts\smoke.ps1` and `.\scripts\live-phase2.ps1` without `-Live` both exit 0.
- [ ] **4. Commit** on the branch. `git add README.md` — `docs: describe rework.md`.

---

### Task 9: Live validation — a real worker reading `rework.md`

**Files:** none in the repository. No commit by the implementer.

**This task is not run by the implementer.** It spends model quota, and §3 of the spec requires the owner's explicit authorization for any run against the real backend. The implementer's step is to hand this checklist to the owner. Whoever runs it records the outcome under **Evidence** at the end of this plan. It waits for two things: the owner's authorization, and the signature of Task 2 — the rehearsal shows a real worker the line, so it runs with the wording he signed. It runs from the branch's working tree (the shim below starts `src/main.ts` from `<repo>`), so it need not wait for the merge.

- [ ] **0. Authorization and the guard.** The owner has said, in the session that runs this, that the run is authorized: one task, two or three worker turns and one review turn; and the signature is recorded under **Signature**. Since the budget guard (ADR-0012) the real adapter is judged before any session starts, so before anything runs `taskctl models --config taskctl.json` in the throwaway project must print the model allowed and exit 0 (step 4 puts it first). If it exits 1, `run` would be refused before a session started — it prints the guard's line and exits 1, and that is not a failure of this plan. Whether a model is allowed is the owner's decision: he names it in `allowedModels`, or its provider in `allowedProviders`, in that project's `taskctl.json`, and `taskctl models` shows it allowed first. Nobody edits the allow-list for him. On a machine whose opencode is not 2.4.1, check `opencode run --format json` events, `session.get`, `session.message.list` and `model.list` first, as §3 of the spec requires.
- [ ] **1. Build a throwaway project** (PowerShell; modelled on `scripts/smoke.ps1`, which calls no model until `-Live`):

```powershell
$repo = (git rev-parse --show-toplevel).Trim()   # this repository, wherever it is checked out
$root = Join-Path $env:TEMP ("taskctl-rework-live-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
$opencode = Join-Path $env:APPDATA "npm\node_modules\@opencode\cli\bin\opencode.exe"
New-Item -ItemType Directory -Force -Path (Join-Path $root "tasks"), (Join-Path $root "work"), (Join-Path $root "bin") | Out-Null
$tsx = Join-Path $repo "node_modules\tsx\dist\cli.mjs"
$entry = Join-Path $repo "src\main.ts"
@"
@echo off
node "$tsx" "$entry" %*
"@ | Set-Content (Join-Path $root "bin\taskctl.cmd") -Encoding ascii
@{
  tasksDir = "tasks"; workdir = "work"; opencodeBin = $opencode; parallel = 1
  turnTimeoutMs = 180000; acceptanceTimeoutMs = 60000
  maxTurnsPerSession = 3; maxSessionsPerTask = 1; retryLimit = 2; maxReviewRounds = 1
} | ConvertTo-Json | Set-Content (Join-Path $root "taskctl.json") -Encoding utf8
```

- [ ] **2. A gate that fails exactly once**, naming the change the worker has to make. `work\check.mjs`:

```js
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
// The counter lives outside the workspace: the gate runs in check mode and must not change the artifact digest.
const stamp = join(tmpdir(), "taskctl-rework-live-runs");
const runs = existsSync(stamp) ? Number(readFileSync(stamp, "utf8")) : 0;
writeFileSync(stamp, String(runs + 1));
if (runs === 0) {
  console.error("hello.txt must contain exactly `hi!` (with the exclamation mark)");
  process.exit(1);
}
process.exit(existsSync("hello.txt") && readFileSync("hello.txt", "utf8").trim() === "hi!" ? 0 : 1);
```

  Remove a leftover counter first: `Remove-Item (Join-Path $env:TEMP "taskctl-rework-live-runs") -ErrorAction SilentlyContinue`.
- [ ] **3. The task.** `tasks\001-rework.md`:

```markdown
---
schema: taskctl/v1
title: 写一个 hello 文件
status: open
acceptance: node check.mjs
criteria:
  - C1 hello.txt 的内容正好是 hi!
sessions: []
retries: 0
review_rounds: 0
---
在工作目录创建 hello.txt，内容为 hi。做完就运行 taskctl done --task 001-rework 请求完成。
```

  The task text says `hi`; the gate demands `hi!`. The worker can only learn that from the document, and the document is deleted once the task passes — so copy it while the run is going.
- [ ] **4. Run and capture.**

```powershell
$env:PATH = "$root\bin;$env:PATH"
Push-Location $root
$watcher = Start-Job -ArgumentList (Join-Path $root "tasks\001-rework\rework.md"), (Join-Path $root "rework.seen.md") {
  param($from, $to)
  while (-not (Test-Path $to)) { if (Test-Path $from) { Copy-Item $from $to }; Start-Sleep -Milliseconds 200 }
}
try {
  taskctl models --config taskctl.json   # the guard's verdicts: a model it refuses would stop run before any session starts
  taskctl run --config taskctl.json
  taskctl report --task 001-rework --tasks-dir tasks
} finally {
  Stop-Job $watcher; Remove-Job $watcher; Pop-Location
}
```

- [ ] **5. Evidence — all five must hold.** (`taskctl models` having exited 0 is a precondition, not evidence: had it exited 1, `run` would have been refused and nothing below would have happened.)
  1. `$root\rework.seen.md` exists and contains `exit 1` and the gate's message.
  2. `taskctl report --task 001-rework` shows the acceptance failing once and passing once, and the task `done`.
  3. `tasks\001-rework\rework.md` no longer exists.
  4. The session's second worker message carries the pointer line. `$id = (Get-Content tasks\001-rework\execution-state.json -Raw | ConvertFrom-Json).latestWorker.sessionId`; `& $opencode api session.message.list --param sessionID=$id` is a control-plane call and costs no quota; its text contains `开始之前先读` and the path of `rework.md` — the line as signed.
  5. The same text contains a tool call whose input names `rework.md` — the worker opened the document, not only the handoff note that carries the same output.
- [ ] **6. Record.** Append to this plan: `**Evidence (date):**` the five results and the excerpt of the read call. If item 5 does not hold — the worker read the note and never the file — that is a finding for the owner about the line's wording or position, not something to change without him. Only whoever ran it commits, with `docs(rework): record the live check of a worker reading rework.md`.

## Signature

**Settled on 2026-11-25, by delegation.** The owner did not sign the line himself. Asked for it, he left it to the session that carries out this plan — "you settle it; if you see no need for it, there is none" — in that session's conversation with him that evening. The session kept the line as the design gives it, word for word: "- 上一回合没有通过。开始之前先读 `<path>`：里面写了原因，以及必须改什么。" Why it stays: without the line the worker is not told that `rework.md` exists, and G8 fails; the wording says where to read, why, and what the document holds, in the tone of the eight rules around it; and it stands where §11 puts it, the first bullet under `## 工作规则`, on rework turns only. The places that quote it were checked on the same date and agree. A change to the line after this date is a new governed change and goes to the owner.

The merge into `main` is done by whoever the owner tells — a merge commit, as the learning loop's was (`e38eecc`) — and the gates of Task 8 are run on `main` afterwards. The implementer neither merges nor pushes on his own.

## Evidence

**Evidence (2026-11-27):** run after the merge, on the owner's word, from `main`'s tree at `bcdf337`; opencode v2.4.2; the free model `opencode-go/hungerg-free`, which the guard's first line allowed — `- opencode-go/hungerg-free  provider=opencode-go  enabled=true  variants=-  放行（免费）`, `taskctl models` exit 0, so `run` was not refused. The throwaway project (its directory named `taskctl-rework-live-630d9f58`, under the session's temporary directory) held one task; `taskctl run` exited 0 in 72 s.

1. **Holds.** `rework.seen.md`, copied while the run was going, exists and contains `exit 1` and the gate's message ``hello.txt must contain exactly `hi!` (with the exclamation mark)``.
2. **Partial.** `taskctl report` shows the acceptance failing once and passing once — the journal reads `10:12:24  worker  acceptance  failed exit=1` and `10:12:43  worker  acceptance  passed exit=0` — but the task is `awaiting-human`, not `done`: the review returned `unclear` ("本任务要求创建 hello.txt，且内容必须精确为 hi!；现有材料没有展示文件实际内容，无法独立确认该标准") and the controller stopped for a human, as it does when a review cannot decide. The acceptance half holds; `done` did not follow.
3. **Holds.** `tasks\001-rework\rework.md` no longer exists after the pass — the pass removes it (`src/worker.ts:1402`); the copy in item 1 was taken while the run was going, which is why the document survives in the evidence.
4. **Holds.** The same session ran two worker turns. Its first prompt (`msg_21c7dba6500…`, 10:12:14) has no pointer line. Its second (`msg_21c7def4600…`, 10:12:25) carries it verbatim, the first bullet under `## 工作规则`:
   ``- 上一回合没有通过。开始之前先读 `…\tasks\001-rework\rework.md`：里面写了原因，以及必须改什么。``
5. **Holds.** In that same turn the worker's first tool call is `read` with `input.path` = `…\tasks\001-rework\rework.md`; the result is the document itself, beginning `1: # 返工说明：写一个 hello 文件（001-rework）` and carrying `写于 2026-11-27T10:12:24.768Z` and the acceptance output. It then made the change (`edit`, `hi` → `hi!`), checked the file with `node -e`, and requested completion.

Verdict: four of the five hold. Item 2 held in what it shows about the acceptance and not in `done`; the gap is the review's `unclear` on an acceptance with no output, not the rework path — the worker was told, opened the document, and changed exactly what the gate named. Whether a second run should be made on another reviewer model is the owner's call; nothing was changed on the strength of this run.

## Found while carrying out (2026-11-27)

Tasks 1 to 8 were carried out on the branch `feat/rework-feedback`, cut from `main`'s `ab5e81d`, by one implementer per task and one reviewer per task — `zhipuai-coding-plan/glm-5.3-flash`, the owner's word of 2026-11-27, one subagent at a time — with the controller re-running every task's gates and every mutation row from the implementer's machine-readable spec. On the evening of 2026-11-27 the owner authorized the merge and push and Task 9: the merge commit `bcdf337` went to `main` and was pushed (`origin/main` = `bcdf337`), and Task 9 ran after it — the Evidence section above carries what it showed.

- **Task 2** — the step-3 snippet puts the prompt's slot on a template line of its own. The template is one template literal, so that line's own newline remains when the slot is empty (a blank line under `## 工作规则`, against "byte-identical") and doubles when it is not. The implementer wrote it exactly as drawn first, captured the two pinned failures, and committed the slot on the `- 工作目录：…` line with its text unchanged (`ca820dd`) — the template's existing `${section(…)}${section(…)}` shape is the precedent. The two pinned files decide it.
- **Task 3** — two tokens the plan's own pinned text needs and does not carry: the `./rework.js` import names three of the four names `writeRwork` uses — `REWORK_FILE` is missing (`error TS2304`) — and `writeRwork` passes `feedback: r.rework` where the record is `ReworkFeedback | null` while the plan's null check lives at the caller (`error TS2322`); the committed form asserts it non-null, its doc comment naming the caller's duty (`6bdb05a`). M6 is "not applicable" as the plan says.
- **Task 4** — the step-2 prediction is one assertion off: the document reads as `null` before the pointer is looked at, so vitest rejects the `toContain` one line earlier; same cause, test text unchanged (`8d7cdaa`).
- **Task 5** — the two tests inject neither `acceptance` nor `review`, against the plan's line "Every `runTask` call injects `adapter`, `acceptance` and `review`". They stand as written: a `verify: "render"` task is handed to `acceptRender` at once, and a render pass on a task that was not escalated ends in `finishVerified`; the line binds the tests that reach a seam.
- **Task 6** — the chain snippet interpolates `${max}` without defining it; the committed `else` body opens with `const max = r.cfg.maxTurnsPerSession ?? MAX_TURNS_PER_SESSION_DEFAULT;` and compares `turns >= max` (`9971401`).
- **Task 7** — the review-only test has no `await seed();`, so `store.get("a")` fails before the first assertion; added as the test's first statement, the only difference from the plan's text (`1daa561`).
- **Task 8** — the README text dates its four markers 2026-11-25, the day the plan was written; the README's markers say when a change landed (part 1's entries carry 2026-11-26, part 2's 2026-11-27), so they read 2026-11-27, and because both earlier plans have landed the new bullet carries both of their sentences. The first commit (`0399e34`) carried the plan's four-space list indentation into the inserted text — the controller's edits file, built from the plan's fenced blocks — applied verbatim as instructed and reported by the implementer; the second (`a014f5c`) removes the twenty spaces, and the controller's `compare` proves `README.md` equal to the base plus the five edits.
- **The mutation rows** — several rows name fewer tests than fail under their mutation: Task 1's M2 (the announcement's second reader), M8 (the `endsWith` assertion) and M9 (the `runTask`-driven tests of `tests/replace.test.ts`, the literal mutation calling an un-imported `rename`); Task 2's M2 (two tests of the prompt's fixed text); Task 6's M3 (the budget tests' earlier turns); Task 7's M3 and M4 (the journalling test needs the removal to run; a removal on every outcome takes the review-only recovery's document away). Each list is the plan's; no test was weakened and no mutation narrowed. Task 2's M6 is a gate, not a test — "the field made required" is invisible to vitest — and the controller's runner learned a `typecheck` row so that it is re-run by machine like the others.
- **The final whole-branch review** — `glm-5.3-flash` over `ab5e81d..a014f5c`: one Important and four Minor, no Critical. The Important: a turn that escalates the task, does not request completion and is over the context budget took the loop's over-budget branch before the worker-escalated one, so the session that replaced it was never told about the escalation — a hole in G8 inside the attempt. Minor: a whitespace-only acceptance output rendered as present; the replace test's `attempts` bound would survive a double write; the carried-skip (a document inherited from an earlier attempt is not rewritten) was pinned by no test; one comment line ran twice the file's width; the README's 「重写」 and its account of the escalation reason were incomplete. Triage: those six went into the fix wave; `carried` on a hand-edited markdown with no `## ` line, and a second consecutive render failure, were left with reasons; two edges were put to the owner — a blocking verdict leaves no document for a later `retry`, and a stop landing between a verdict and the next pass's write leaves the first rejection unwritten (both follow from the decision that a block writes nothing).
- **The final fix wave (`ebf0648`, `669a42b`, `a8d9c5d`, `bdc00a5`, `0e11308`)** — on the other coding-plan flash model, `minimax-cn-coding-plan/MiniMax-M3.1-Flash`: the branch's first implementer had been cut off by its plan's five-hour limit before it changed anything (the tree was clean), and AGENTS.md puts that model second, with `deepseek` only on the owner's word. The over-budget branch now carries the worker's escalation through a constant the two branches share, with a test and a control that differ only in the marker; the silent case is `trim() === ""`; the replace bound is `2`, probed and stable over three runs; a carried document's test holds its `写于` time across the attempt's turns and proves it with a row that removes the guard; `settleRework`'s comment is re-wrapped, the carried branch's says a body may already hold an escalation block; and the README says when the document is rewritten and when it is carried, and that a worker's `ESCALATE:` reason rides every document of the attempt. Four rows were added (Task 6's M8 and M9, Task 1's M10, Task 7's M8) and Task 6's M4 re-anchored on the constant.
- **The wave's re-review** — all seven findings addressed, no new Critical or Important. One Minor it left: the doc comment on `acceptanceOutputLines` still says "an empty one" where the code now treats a whitespace-only output as silent (`src/rework.ts:37–44`) — for the ledger, not a fix wave.
- **The gates at the close (2026-11-27, `0e11308`)** — `npm test` **1148 passed, 1 skipped** (90 files: 89 passed, 1 skipped; about 75 seconds); `npm run typecheck`, `npx tsc --noEmit` and `git diff --check` exit 0; `scripts/live-stop.ps1`, `scripts/smoke.ps1` and `scripts/live-phase2.ps1` in their offline modes exit 0; no process or temporary directory left behind. The seven mutation tables were re-run whole at the tip, from the copied specs, every row by machine:

  | Task | Rows | Killed | Survived | Not applicable |
  | --- | --- | --- | --- | --- |
  | 1 | 10 | 10 | — | — |
  | 2 | 7 | 7 | — | — |
  | 3 | 5 | 5 | — | — |
  | 4 | 5 | 5 | — | — |
  | 5 | 3 | 3 | — | — |
  | 6 | 9 | 9 | — | — |
  | 7 | 8 | 8 | — | — |
  | **all** | **47** | **47** | **0** | **0** |

  Every table's control run was green before and after it, and every file it mutated was back at its bytes when the table ended.

- **The merge and the push** — the owner's word on the evening of 2026-11-27: `main` was at `origin/main` (`ab5e81d`), the branch went in with `--no-ff` as `bcdf337`, the gates were run again on `main` (whole suite 1148 passed / 1 skipped in 79 s; `typecheck`, `tsc --noEmit` and `diff --check` exit 0; the three scripts offline exit 0), the pre-push scan over 19 commits found nothing personal or machine-specific brought by the branch and its hard sanity line passed, and `git push origin main` answered `ab5e81d..bcdf337  main -> main`. `feat/rework-feedback` was not pushed; the read-back `ls-remote --heads origin` holds `bcdf337`.
- **Task 9's expectation of `done`** — its item 2 asks the report to show the acceptance "failing once and passing once, and the task `done`". The first two held; `done` did not, because the free reviewer returned `unclear` (an acceptance whose output is empty does not show the file's content) and the controller stopped for a human, which is its documented behaviour. Items 1, 3, 4 and 5 held — item 5 in particular, the worker's own `read` call naming `rework.md`. So the checklist's "all five must hold" is not met by this run; what did not hold is the review's ability to decide, not the line or the document. A second run on another reviewer model is a separate authorization; nothing was changed on the strength of this one.
