# Lane Declared by Operator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `taskctl add` takes the lane from the operator — `--quick`, `--simple` or `--complex`, or the answer to one question on a terminal — never from the wording of the intent or from the clarify session, and every declared lane is recorded as an example that `taskctl lanes` prints grouped by lane.

**Architecture:** `addCommand` resolves the lane before it reads or writes anything (a flag, or `askOnTerminal` through a `CliDeps.askLane` seam) and derives `quick`, `complexity` and `execution` from it. The intake parser loses its lane and the clarify prompt its classification section; `classification.json` records the lane with `source: "operator"`. A new `src/lanes.ts` appends one JSON line per `add` to `.taskctl/lanes.jsonl` and renders those lines for the new `taskctl lanes` command.

**Tech Stack:** TypeScript (NodeNext, strict), Node 22 (`node:readline/promises`, `node:fs/promises`), Vitest 5; no new dependency.

**Spec:** docs/superpowers/specs/2026-11-25-model-trouble-and-operator-control-design.md

## Global Constraints

- G9: "The lane of a new task is declared by the owner, and every declared lane is recorded as an example."
- "`taskctl add` requires the lane: `--quick`, `--simple` or `--complex`." "With none given, it asks once when it is attached to a terminal, and otherwise exits with a usage error that names the three."
- "The clarify session no longer classifies. The "管理分类" section leaves its template; `parseIntakeAssessment` keeps the information-sufficiency verdict and the questions. `classification.json` records the lane with `source: "operator"`."
- "`detectComplexity`, which reads the wording of an intent for "简单任务", is removed: nothing in the wording of an intent decides whether a task runs without a signature."
- "A short ADR-0010 records this: the lane is declared by the operator, as ADR-0009 says, and classification by a model is deferred until it has evidence."
- "Recording examples: every `taskctl add` appends one line to `.taskctl/lanes.jsonl` — id, time, lane, type, title, the intent (bounded), the number of criteria." "`taskctl lanes` prints them grouped by lane. This is the material the later classifier and the three description lists are built from."
- "Process rule for an agent that adds tasks on the owner's behalf: ask him for the lane first."
- Owner's decision 9: "Quick, simple and complex are enough. For now the owner decides the lane of each task and is asked for it; later a cheap model judges from accumulated per-lane descriptions."
- "No new lane, and no new task status: "on hold" is `blocked` with a reason."
- "No classifier by model in this round. A cheap model proposing the lane from the recorded examples is a later step (§12)."
- Anti-goal: "a task that runs without the owner's signature because of how its intent was worded."
- "Markdown task files are the source of truth (ADR-0001); a reviewer is always a fresh session; no new runtime dependency; the CLI stays hand-rolled."
- "Every runtime change follows the repository's protocol: a regression that fails first, the fix, directed mutations that the tests kill, documentation kept in step."
- "A run against the real backend needs the owner's explicit authorization."
- The CLI is hand-rolled: a new command means its entry in the dispatch table and its line in the usage text; a flag that stands alone must be in `BOOLEAN_FLAGS`.
- `tests/` is type-checked by `npm run typecheck`: test doubles satisfy their interfaces, fixtures satisfy `Task`.

## Review Focus

Five inputs the spec implies that no existing test exercises. Each is pinned by a named test in the task that owns the code; the tests are written in that task's step 1.

1. **`add` run by a script or an agent** — no lane and stdin not a terminal. It must exit 2 naming the three, create nothing, call no model, and never wait for input. → `tests/lane-declared.test.ts`: "exits with a usage error naming the three when no lane is given and stdin is not a terminal, and creates nothing", "does not ask at all when stdin is not a terminal" (Task 1).
2. **A reply on the terminal that is not a lane** — a typo, an empty Enter, Ctrl-D. → `it.each(["simpl", "", "tiny", "快速"])`, "treats end of input on a terminal as no lane" (Task 1).
3. **`--complex` before the intent** — the `--resume` lesson of 2026-11-24: a boolean flag missing from `BOOLEAN_FLAGS` swallows the next token. → "accepts --complex as a flag that stands alone, wherever it is written" (Task 1).
4. **The wording of the intent says "简单任务"** — with no flag, beside `--complex`, or as a negation beside `--simple`. → `it.each` over the eight intents the old `detectComplexity` tests used, "an explicit complex lane beats wording that calls the task simple", "an explicit simple lane is not second-guessed by a negation" (Task 1).
5. **A clarify session that still writes `## 管理分类`**, or gives a sufficiency verdict that cannot be read. The declared lane stands; an unreadable verdict keeps the draft. → `tests/cli-add.test.ts`: "a lane the spec claims, usable or not, changes nothing: the declared lane stands" (Task 1); `tests/intake.test.ts`: "ignores a 管理分类 section, whatever it says, and does not count it as an assessment", "treats a verdict it cannot read as missing information" (Task 2).

## Decisions taken where the spec is silent

The owner can overrule any of these; each is small and local, and the test that pins it is named.

- **Exactly one lane flag.** Two or more are a usage error, not "the stricter wins". Until today `--quick --simple` silently meant quick. Pinned by "refuses two lane flags" (Task 1).
- **The question is asked once.** A reply that is not one of the three — a typo, an empty line, end of input — exits 2 with the usage error that names the three and quotes the reply; nothing is created. The question and the error texts are English, as every other CLI message is. Pinned by Task 1.
- **`--complex` is a new boolean flag**, alongside the two that exist. The `add` usage line shows the three as a required group.
- **`classification.json` loses `proposedLane` and `laneEscalated`.** Nothing proposes a lane any more, so a recorded proposal would be a constant. The `分类升级` row of `taskctl metrics` (`src/metrics.ts:70`) is not touched: it still counts the records written before this change, and reads `0 / n` on a board created after it. The `quick` lane writes no `classification.json`, exactly as today: it runs no clarify session, so there is no sufficiency verdict to record. Pinned by Task 1 and by `tests/metrics.test.ts`, which must stay green unchanged.
- **Only the "管理分类" section leaves the clarify template.** `## 分类理由` stays, now read as the reason for the sufficiency verdict; hard rule 6 (the lane rule) goes with the section and rules 7–8 become 6–7. The clarify session is not told the declared lane: a lane it cannot change is not its business. Pinned by Task 2.
- **The example is appended once per `add` that put a task on the board, on every exit path.** A clarify session that fails still records the declared lane, with `criteria: 0`; an `add` refused for a missing lane records nothing. A failed append is one log line and never changes the result. Field names: `at` for the time (as in `feedback.jsonl`, `audits.jsonl` and `classification.json`), `criteria` for the number, `type` for the task type. The intent is cut at 500 code points with `…`. The file is never compacted: it is the evidence, not a cache. Pinned by Task 3.
- **`taskctl lanes`** takes `[--tasks-dir <dir>] [--config <file>]`, like `metrics`. It prints the three groups in the fixed order quick, simple, complex — an empty group included, because "no examples for this lane yet" is what its reader most needs to see — oldest first inside a group, one line per example and a second, indented line when the intent says more than its first line. Pinned by Task 4.
- **The older ADRs are not edited.** ADR-0008 keeps its sentence about the "explicit statement in the user's own words"; ADR-0010 says which part of it is retired.

## Reading this plan

- Baseline: `main` at `c8e604f`, clean tree, 865 passed / 1 skipped (76 files). Line numbers refer to that commit and will move twice: parts 1 to 3 of the design land first and edit `src/cli.ts` as well, so by the time this plan runs the numbers will have shifted again. Every edit below also quotes the anchor text to search for: the anchor is what an edit is found by; the number only says roughly where. Take the test count from the run before Task 1, not from this line.
- Nothing here may start the real `opencode` backend. **Never call `add` in a test without `adapter`**: without it the command builds the real `OpenCodeAdapter` (`src/cli.ts:740`) and would spawn `opencode`. Pass `clarifier([])` or `noModel` even where exit 2 is expected.
- **Where the lane flag goes in a test's argv.** Directly after `add`, or last. Never directly before another flag: if the parser ever misreads the flag again, a swallowed path must not send a task file into the repository's own `tasks/`.
- **Mutation protocol (step 5 of every task).** Run the task's test files first — the control; if they are not fully green, stop. Copy the file to be mutated to a scratch path outside the repository and note `(Get-FileHash <file>).Hash`. Apply one mutation with a single edit — a reversed comparison, a replaced constant, or an `if (false) { … }` around a block; never `Date.now() !== Date.now()`. Run only the file named for it and confirm that the named test fails and nothing else in that file does. Restore by copying the scratch file back, confirm the hash is the original's, and run the file again — green. One mutation at a time. A mutation that survives is a hole in the test, not a pass: strengthen the named test before going on.
- Commands: one file `npx vitest run tests/<file>.ts`; `npm run typecheck`; `npx tsc --noEmit`; `git diff --check`; whole suite `npm test` (about 35 s). Do not run `npm test` after every task; run it once after Task 4 and once after Task 5.
- **Interplay with the other parts of the spec.** This plan is part 4 and runs last. Parts 1–3 change `src/cli.ts` elsewhere: `status --stuck` (§8), `stop --now` (§9), and §16's call that the clarify session of `add` and the planner of `split` use the head of `modelChain` when `model` is unset — inside `addCommand` both the guard's `sessionRefusals(cfg, adapter)` and the `adapter.prompt({ … model: cfg.model … })` call. Nothing here depends on them, but they share lines: Task 3's `try { … } finally { … }` wraps the very prompt call §16 changes, and Task 1 edits the head of `addCommand`, so whichever lands second re-applies its edit around the other, by anchor.
- **The lane comes before the budget guard.** Since the learning loop was merged, `add` asks the budget guard before it writes the task file: `if (!quick) { const disallowed = await sessionRefusals(cfg, adapter); … }` prints the verdict lines and throws `budget guard refused: …`, which ends the command with exit 1. A quick task has no session and is not asked. That is why `declaredLane` is called at the very top of `addCommand`: the declared lane decides whether the guard is asked at all. The guard's block is not moved and not changed; it reads the declared `quick`. An `add` the guard refuses puts no task on the board, so it records no lane example (Task 3 pins that).
- Tests that relied on the model or the wording choosing the lane are **rewritten, never deleted or weakened**: each one below says which old assertion became which new one.

---

### Task 1: The lane is required, and only the operator supplies it

**Files:**
- Modify: `src/intake.ts` (`ManagementLane`, line 5; `isLane`, lines 50–52; delete `detectComplexity`, lines 98–109)
- Modify: `src/cli.ts` (import, line 12; `CliDeps`, lines 40–54; `USAGE`, line 156; the `add` case of `dispatch`, lines 272–274; `addCommand`, lines 672–836; `BOOLEAN_FLAGS`, line 1172)
- Test: Create `tests/lane-declared.test.ts`; Modify `tests/intake.test.ts` (lines 2 and 5–19), `tests/cli-add.test.ts`, `tests/cli-profile.test.ts` (line 48), `tests/feedback.test.ts` (lines 151, 218, 248), `tests/lanes.test.ts` (line 79), `tests/pipeline-e2e.test.ts` (lines 96, 128), `tests/budget-guard.test.ts` (lines 820 and 840)

**Interfaces:**
- Consumes: `ManagementLane`, `TaskType` (`src/intake.ts:4–5`); `isLane(value): value is ManagementLane` (`src/intake.ts:50`, private to the module); `CliDeps` (`src/cli.ts:40–54`); `UsageError` (`:152`); `parseType`, `parseVerify`, `parseExecution` (`:1625–1648`); `checkFlags` (`:1662`); the exit-2 path of `runCli` (`:253–257`); the budget guard's block in `addCommand` (`:741–749`), which stays.
- Produces, `src/intake.ts`:
  - `export const LANES: readonly ManagementLane[] = ["quick", "simple", "complex"];`
  - `export function parseLane(value: string): ManagementLane | null` — one of the three, forgiving case and surrounding space; `null` for anything else, including the empty string.
  - Removed: `detectComplexity`.
- Produces, `src/cli.ts`:
  - `CliDeps.askLane?: (question: string) => Promise<string | null>` — test seam for the one question; production asks on the terminal.
  - `export const LANE_QUESTION: string` — names the three lanes and one line each on what they mean.
  - `export async function askOnTerminal(question: string, input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stderr): Promise<string | null>` — `null` at once, writing nothing, when `input` is not a terminal (`isTTY !== true`); otherwise the question once, answered with the typed line, and `null` when the input ends before a line arrives.
  - `async function declaredLane(flags: Map<string, string>, deps: CliDeps): Promise<ManagementLane>` (private) — the single lane flag given; more than one is a usage error; none asks once through `deps.askLane ?? askOnTerminal`, and no answer or an unusable answer is a usage error whose text contains `add requires a lane: pass --quick, --simple or --complex`.
  - `addCommand` calls `declaredLane` immediately after the intent check (line 681) and before anything is read or created (line 683), then derives `const quick = lane === "quick";` and `const complexity = lane === "complex" ? "complex" : "simple";`; `execution` is derived from `complexity` as today (lines 713–715). The budget guard's block (lines 741–749) is not moved and not changed: it already asks nothing for a quick task, and from now on it reads the declared lane. After the clarify session only `criteria` are patched (`store.updateFields(id, { criteria })`), and `classification.json` is `{ lane, source: "operator", sufficiency: assessment.sufficiency, reason: assessment.reason, model: cfg.model ?? "(backend-default)", type, at: new Date().toISOString() }`.
  - `--complex` is accepted by `add`: in the dispatch table's allowed flags, in `BOOLEAN_FLAGS`, and in the usage line as `taskctl add "<意图>" (--quick|--simple|--complex) …`.
  - Fixed texts: the usage error `add requires a lane: pass --quick, --simple or --complex`; for an unusable reply the same sentence followed by ` ("<reply>" is not a lane)`; for two flags `--quick, --simple and --complex are mutually exclusive: declare exactly one lane`.

- [ ] **1. Write the failing tests.**
  - Create `tests/lane-declared.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { LANE_QUESTION, askOnTerminal, runCli } from "../src/cli.js";
import { parseLane } from "../src/intake.js";
import { TaskStore } from "../src/task-store.js";
import type { AgentAdapter } from "../src/adapters/types.js";

const SPEC = "## 目标\n改好\n## 验收标准\n- C1 可验证\n## 信息充分性\nclear\n## 分类理由\n依据明确\n## 补问\n无";

/** A clarify session that answers `text`; every model turn is counted. */
function clarifier(calls: string[], text = SPEC): AgentAdapter {
  return {
    prompt: async () => { calls.push("model"); return { sessionId: "s-1", exitCode: 0, text }; },
    contextUsage: async () => 0, contextLimit: async () => 0,
  };
}

/** What production answers when stdin is not a terminal: no question was asked, no lane was given. */
const noTerminal = { askLane: async (): Promise<string | null> => null };
const silent = { log: (): void => {}, err: (): void => {} };

let root: string;
let dir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "taskctl-lane-declared-"));
  dir = join(root, "tasks");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe("taskctl add requires the lane", () => {
  it("exits with a usage error naming the three when no lane is given and stdin is not a terminal, and creates nothing", async () => {
    const errors: string[] = [];
    const calls: string[] = [];
    const code = await runCli(["add", "重构登录模块", "--tasks-dir", dir, "--id", "001-a"], {
      ...noTerminal, ...silent, adapter: clarifier(calls), err: (line) => errors.push(line),
    });

    expect(code).toBe(2);
    expect(errors[0]).toContain("add requires a lane: pass --quick, --simple or --complex");
    expect(await readdir(root)).toEqual([]);
    expect(calls).toEqual([]);
  });

  // The eight intents the removed `detectComplexity` tests used, kept verbatim.
  it.each([
    "这是个简单任务：修一下 README 的错字", "这是一个简单任务", "simple: fix typo", "简单任务：改个错字",
    "重构登录模块", "不太复杂，改个文案", "这不是简单任务，要重构登录模块", "上次那个简单任务又出问题了",
  ])("does not read %j for a lane: with no flag it exits 2", async (intent) => {
    const errors: string[] = [];
    const calls: string[] = [];
    const code = await runCli(["add", intent, "--tasks-dir", dir], {
      ...noTerminal, ...silent, adapter: clarifier(calls), err: (line) => errors.push(line),
    });
    expect(code).toBe(2);
    expect(errors[0]).toContain("--quick, --simple or --complex");
    expect(await readdir(root)).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("an explicit complex lane beats wording that calls the task simple", async () => {
    const code = await runCli(["add", "这是个简单任务：修一下 README 的错字", "--tasks-dir", dir, "--id", "001-a", "--complex"], {
      ...noTerminal, ...silent, adapter: clarifier([]),
    });
    expect(code).toBe(0);
    expect(await new TaskStore(dir).get("001-a")).toMatchObject({ status: "draft", complexity: "complex", execution: "iterative" });
  });

  it("an explicit simple lane is not second-guessed by a negation", async () => {
    const code = await runCli(["add", "这不是简单任务，要重构登录模块", "--tasks-dir", dir, "--id", "001-a", "--simple"], {
      ...noTerminal, ...silent, adapter: clarifier([]),
    });
    expect(code).toBe(0);
    expect(await new TaskStore(dir).get("001-a")).toMatchObject({ status: "open", complexity: "simple", execution: "continuous" });
  });

  it("asks once on a terminal and takes the answer as the lane", async () => {
    const questions: string[] = [];
    const askLane = vi.fn(async (question: string) => { questions.push(question); return " Simple "; });
    const code = await runCli(["add", "修 README 错字", "--tasks-dir", dir, "--id", "002-b"], { askLane, ...silent, adapter: clarifier([]) });

    expect(code).toBe(0);
    expect(askLane).toHaveBeenCalledTimes(1);
    for (const lane of ["quick", "simple", "complex"]) expect(questions[0]).toContain(lane);
    expect(await new TaskStore(dir).get("002-b")).toMatchObject({ status: "open", complexity: "simple", quick: false });
  });

  it("does not ask when a lane flag is given", async () => {
    const askLane = vi.fn(async () => "complex");
    expect(await runCli(["add", "把这个表格的两列合并", "--tasks-dir", dir, "--id", "001-merge", "--quick"], { askLane, ...silent, adapter: clarifier([]) })).toBe(0);
    expect(askLane).not.toHaveBeenCalled();
  });

  it.each(["simpl", "", "tiny", "快速"])("exits with the usage error for the reply %j, and calls no model", async (reply) => {
    const errors: string[] = [];
    const calls: string[] = [];
    const code = await runCli(["add", "重构登录模块", "--tasks-dir", dir, "--id", "001-a"], {
      askLane: async () => reply, ...silent, adapter: clarifier(calls), err: (line) => errors.push(line),
    });
    expect(code).toBe(2);
    expect(errors[0]).toMatch(/add requires a lane: pass --quick, --simple or --complex/);
    expect(calls).toEqual([]);
    expect(await readdir(root)).toEqual([]);
  });

  it("refuses two lane flags", async () => {
    const errors: string[] = [];
    const code = await runCli(["add", "x", "--tasks-dir", dir, "--quick", "--simple"], { ...noTerminal, ...silent, adapter: clarifier([]), err: (line) => errors.push(line) });
    expect(code).toBe(2);
    expect(errors[0]).toContain("--quick, --simple and --complex are mutually exclusive");
    expect(await readdir(root)).toEqual([]);
  });

  it("accepts --complex as a flag that stands alone, wherever it is written", async () => {
    // `--resume` was once missing from the parser's boolean flags and swallowed
    // the next token (2026-11-24). A lane flag goes through the real parser.
    const calls: string[] = [];
    expect(await runCli(["add", "--complex", "重构登录模块", "--tasks-dir", dir, "--id", "003-c"], { ...noTerminal, ...silent, adapter: clarifier(calls) })).toBe(0);
    expect(await new TaskStore(dir).get("003-c")).toMatchObject({ status: "draft", description: "重构登录模块" });
    expect(await runCli(["add", "改 README 错字", "--tasks-dir", dir, "--id", "004-d", "--complex"], { ...noTerminal, ...silent, adapter: clarifier(calls) })).toBe(0);
    expect(await new TaskStore(dir).get("004-d")).toMatchObject({ status: "draft", complexity: "complex" });
  });

  it("names the three lanes and the new flag in its usage line", async () => {
    const errors: string[] = [];
    await runCli([], { log: () => {}, err: (line) => errors.push(line) });
    expect(errors.join("\n")).toMatch(/taskctl add ".*" \(--quick\|--simple\|--complex\)/);
  });
});

describe("parseLane", () => {
  it("accepts one of the three lanes, forgiving case and surrounding space, and nothing else", () => {
    expect(parseLane(" Simple ")).toBe("simple");
    expect(parseLane("QUICK")).toBe("quick");
    for (const reply of ["simpl", "", "tiny", "快速", "simple task"]) expect(parseLane(reply)).toBeNull();
  });
});

describe("askOnTerminal", () => {
  const terminal = (): PassThrough & { isTTY: boolean } => Object.assign(new PassThrough(), { isTTY: true });

  it("asks once on a terminal and answers the typed line", async () => {
    const input = terminal();
    const output = new PassThrough();
    const said: string[] = [];
    output.on("data", (chunk) => said.push(String(chunk)));
    const answer = askOnTerminal(LANE_QUESTION, input, output);
    input.end("simple\n");
    expect(await answer).toBe("simple");
    // The question reaches the terminal exactly once.
    expect(said.join("").split(LANE_QUESTION)).toHaveLength(2);
  });

  it("does not ask at all when stdin is not a terminal", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const said: string[] = [];
    output.on("data", (chunk) => said.push(String(chunk)));
    const answer = askOnTerminal(LANE_QUESTION, input, output);
    input.end();
    expect(await answer).toBeNull();
    expect(said.join("")).toBe("");
  });

  it("treats end of input on a terminal as no lane", async () => {
    const input = terminal();
    const output = new PassThrough();
    output.resume();
    const answer = askOnTerminal(LANE_QUESTION, input, output);
    input.end();
    expect(await answer).toBeNull();
  });
});
```

  - `tests/intake.test.ts`: drop `detectComplexity` from the import on line 2 and delete `describe("detectComplexity")` (lines 5–19). Nothing is lost: its eight input strings are the `it.each` of the new file, where each now exits 2 instead of being read.
  - `tests/cli-add.test.ts`:
    - Append the lane flag at the end of the argv of: "puts a complex intent in draft with spec and criteria" (`"--complex"`), "a spec without numbered criteria keeps the task in draft and logs the failure" (`"--complex"`), "a failed clarify session leaves the task in draft and returns 1" (`"--complex"`), "records an acceptance command given on the command line" (`"--complex"`), "keeps needs-information in draft and writes bounded questions" (`"--simple"` — the verdict keeps a *simple* task in draft, which is the property the test names), "assigns the next numeric id when none is given" (both calls, `"--complex"`). Their assertions do not change.
    - Rewrite four tests. Old assertion → new assertion:
      1. "sends an explicitly simple intent straight to open but still keeps a spec" → "sends an explicitly simple lane straight to open but still keeps a spec": argv `["add", "这是个简单任务：修 README 错字", "--tasks-dir", dir, "--id", "002-typo", "--simple"]`. The assertions (`status: "open"`, `complexity: "simple"`, a spec exists) are the old ones; the old behaviour — the wording alone opening the task — is now the `it.each` exit-2 case of the new file.
      2. "uses model classification to select a simple continuous lane" → "the declared simple lane selects a continuous lane; the spec's own claim of a lane changes nothing": adapter `fakeAdapter(assessedSpec("complex"))` (it used to answer `simple`), argv `["add", "重构登录模块", "--tasks-dir", dir, "--id", "classified-simple", "--simple"]`. The task assertion is the old one; the record assertion becomes `.toMatchObject({ lane: "simple", source: "operator", sufficiency: "clear" })` plus `expect(record).not.toHaveProperty("proposedLane")` and `not.toHaveProperty("laneEscalated")`.
      3. "records an unusable model lane as taskctl's own escalation" → "a lane the spec claims, usable or not, changes nothing: the declared lane stands": adapter `assessedSpec("tiny")` as before, argv `["add", "修 README 错字", "--tasks-dir", dir, "--id", "bad-lane", "--complex"]`. The task assertion `{ status: "draft", complexity: "complex", execution: "iterative" }` is the old one; the record assertion becomes `.toMatchObject({ lane: "complex", source: "operator" })` plus the two `not.toHaveProperty`.
      4. "lets an explicit operator lane override model classification" keeps its name, adapter and task assertion; its record assertion `.toMatchObject({ lane: "simple", proposedLane: "complex" })` becomes `.toMatchObject({ lane: "simple", source: "operator" })` plus `not.toHaveProperty("proposedLane")`.
  - Append the lane flag at the end of the argv in: `tests/cli-profile.test.ts` line 48 (`"--complex"`); `tests/feedback.test.ts` line 151 (`"--simple"`; the test is "… then resumes the simple lane"), line 218 (`"--simple"`), line 248 (`"--complex"`); `tests/lanes.test.ts` line 79 (`"--complex"`); `tests/pipeline-e2e.test.ts` lines 96 and 128 (`"--complex"`); `tests/budget-guard.test.ts` line 820, "add refuses before it writes anything", and line 840, "add with an allowed model goes on to clarify" (`"--complex"`). Those two came with the learning loop: without a lane they would now leave with the usage error before the guard is ever asked, and the one on line 840 expects exit 0. No assertion changes. After this, every call of `add` in a test file that existed before this plan carries a lane flag: 28 call sites in 6 files at `c8e604f`. Parts 1 to 3 may have added calls of their own; the run in step 2 shows them, and each gains a flag the same way.
- [ ] **2. Run it and expect FAIL.** `npx vitest run tests/lane-declared.test.ts tests/cli-add.test.ts tests/intake.test.ts`.
  - `tests/lane-declared.test.ts` fails to give a lane: `LANE_QUESTION`, `askOnTerminal` and `parseLane` are not exports (`askOnTerminal is not a function`; `parseLane is not a function`), and every `add` that expects exit 2 gets `0` — today the intent is clarified and the command succeeds (`expected 0 to be 2`), leaving a `tasks` directory behind (`expected [ 'tasks' ] to equal []`).
  - `tests/cli-add.test.ts` and `tests/budget-guard.test.ts`: every argv with `--complex` answers `taskctl: unknown option --complex for command add` — `expected 2 to be 0`, or `expected 2 to be 1` in the guard test that expects a refusal.
  - Two tests of the new file pass before the change and are the controls that nothing else moved: "an explicit simple lane is not second-guessed by a negation" (`--simple` already wins today) and "does not ask when a lane flag is given" (nothing asks today).
- [ ] **3. Implement.**
  - `src/intake.ts`: add `LANES` beside `ManagementLane`; add `parseLane` directly below `isLane`, returning `isLane(word) ? word : null` for `word = value.trim().toLowerCase()`; delete `detectComplexity` with its comment (lines 98–109).
  - `src/cli.ts`:
    - `import * as readline from "node:readline/promises";` and change line 12 to `import { LANES, buildClarifyPrompt, detectType, nextTaskId, parseLane, parseIntakeAssessment, TEMPLATES, type ManagementLane, type TaskType } from "./intake.js";`.
    - `CliDeps`: add `askLane` with a doc comment that names it a test seam.
    - `USAGE` line 156: replace `[--simple] [--quick]` with the required group `(--quick|--simple|--complex)` directly after `"<意图>"`.
    - `dispatch`: add `"complex"` to the `add` case's allowed flags (line 273: `checkFlags(command, flags, ["type", "simple", "quick", "verify", "execution", "target", "id", "config", "risk", "workdir", "tasks-dir", "acceptance"], []);`).
    - `BOOLEAN_FLAGS` (line 1172): add `"complex"`.
    - Declare `LANE_QUESTION`, the two error texts, `askOnTerminal` and `declaredLane` directly after `configFor` (`src/cli.ts:199–203`), the small resolver that follows `tasksDirFor` (`:191–197`), so that the two resolvers stay together. `LANE_QUESTION` is these five lines joined by `\n`:

    ```text
    taskctl add needs the lane of this task:
      quick    no spec and no signature: the intent is the whole definition
      simple   a spec, no signature: worker, then one review
      complex  a spec that waits for your signature
    lane (quick/simple/complex):
    ```

    `declaredLane` is: the flags present among `LANES`; more than one throws; exactly one is returned; none asks once, and `null` or `parseLane(reply) === null` throws — the bare sentence for `null`, the sentence with ` ("<reply>" is not a lane)` for a reply.
    - `addCommand`: `const lane = await declaredLane(flags, deps);` directly after `if (intent.length === 0) { throw new UsageError("add requires the intent as an argument"); }` and before `const configPath = …`. Line 691 becomes `const quick = lane === "quick";`. The budget guard's block (lines 741–749) stays as it is. Replace lines 709–712 (the comment "Quick means …" and `const complexity = quick || flags.has("simple") ? "simple" : detectComplexity(intent);`) with `const complexity = lane === "complex" ? "complex" : "simple";`. Replace lines 801–807 (`const assessment = parseIntakeAssessment(specText, complexity);`, the `const lane = quick ? "quick" : …` line, which goes, and the rest through the `updateFields` with `selectedComplexity` / `selectedExecution`) with `const assessment = parseIntakeAssessment(specText, complexity);` and `await store.updateFields(id, { criteria });`, and lines 808–812 with the record of the Interfaces section. `selectedComplexity` no longer exists: the `open` transition (line 826) and the log line (line 834) read `complexity`. The `needs-information` block, the journal line and the log line stay otherwise as they are (`lane=${lane}` now names the declared lane).
- [ ] **4. Run it and expect PASS.** `npx vitest run tests/lane-declared.test.ts tests/cli-add.test.ts tests/intake.test.ts tests/cli-profile.test.ts tests/feedback.test.ts tests/lanes.test.ts tests/pipeline-e2e.test.ts tests/metrics.test.ts tests/budget-guard.test.ts` (`tests/metrics.test.ts` is the control that the untouched `分类升级` row still reads old records; `tests/budget-guard.test.ts` is the control that the guard still refuses and still lets an allowed model through, now with a lane declared first), `npm run typecheck`, `npx tsc --noEmit`, `git diff --check`.
- [ ] **5. Directed mutation check** on `src/cli.ts` (M3 on `src/intake.ts`). Control: `npx vitest run tests/lane-declared.test.ts tests/cli-add.test.ts` green.
  - M1 *a missing lane falls back to complex* — in `declaredLane`, `if (lane === null) return "complex";` instead of the throw. Must fail: "exits with a usage error naming the three …" and the `it.each` of eight intents.
  - M2 *asks without a terminal* — in `askOnTerminal`, wrap the `isTTY` return in `if (false) { … }`. Must fail: "does not ask at all when stdin is not a terminal".
  - M3 *any reply is a lane* — `parseLane` returns `word as ManagementLane`. Must fail: the `it.each` of four replies and "accepts one of the three lanes, forgiving case and surrounding space, and nothing else".
  - M4 *asks although a flag was given* — `if (given.length > 0) return given[0]!;` becomes `> 1`. Must fail: "does not ask when a lane flag is given".
  - M5 *end of input waits for ever* — remove the `close` race in `askOnTerminal`. Must fail: "treats end of input on a terminal as no lane" (by timeout).
  - M6 *two flags allowed* — the mutual-exclusion comparison `> 1` becomes `> 2`. Must fail: "refuses two lane flags".
  - M7 *quick is not simple* — `const quick = lane === "quick";` becomes `!==`. Must fail: `tests/lanes.test.ts` "opens without a model call and without a spec" (a clarify session would be attempted and its adapter throws).
  - M8 *complex is simple* — `lane === "complex"` becomes `lane !== "complex"`. Must fail: "an explicit complex lane beats wording that calls the task simple" and "an explicit simple lane is not second-guessed by a negation".
  - M9 *the lane is asked for after the task directory is made* — move the `declaredLane` call below `await mkdir(tasksDir, { recursive: true });`. Must fail: "exits with a usage error naming the three …" (`expected [ 'tasks' ] to equal []`).
  - M10 *the record says the model chose* — `source: "operator"` becomes `source: "model"`. Must fail: `tests/cli-add.test.ts` "the declared simple lane selects a continuous lane; the spec's own claim of a lane changes nothing".
  - M11 *needs-information opens on a simple lane* — `=== "needs-information"` becomes `!==`. Must fail: `tests/cli-add.test.ts` "keeps needs-information in draft and writes bounded questions" and "accepts --simple written before the intent".
  - M12 *`--complex` needs a value* — remove `"complex"` from `BOOLEAN_FLAGS`. Must fail: "accepts --complex as a flag that stands alone, wherever it is written".
  - M13 *the usage line* — restore `[--simple] [--quick]`. Must fail: "names the three lanes and the new flag in its usage line".
  - M14 *the question names no lane* — `LANE_QUESTION` without the three words. Must fail: "asks once on a terminal and takes the answer as the lane".
  - Restore check after each: hash equal to the scratch copy's; control green again.
- [ ] **6. Commit.** `git add src/intake.ts src/cli.ts tests/lane-declared.test.ts tests/intake.test.ts tests/cli-add.test.ts tests/cli-profile.test.ts tests/feedback.test.ts tests/lanes.test.ts tests/pipeline-e2e.test.ts tests/budget-guard.test.ts` — `feat(cli): require the operator to declare the lane on taskctl add`.

---

### Task 2: The clarify session no longer classifies

**Files:**
- Modify: `src/intake.ts` (`IntakeAssessment`, lines 7–14; `parseIntakeAssessment`, lines 17–44; `buildClarifyPrompt`, lines 147–203)
- Modify: `src/cli.ts` (the call `parseIntakeAssessment(specText, complexity)`)
- Test: Modify `tests/intake.test.ts` (lines 40–68 and lines 70–97), `tests/cli-add.test.ts` (one comment)

**Interfaces:**
- Consumes: `InformationSufficiency` (`src/intake.ts:6`); `isSufficiency`, `section` (`:54–65`).
- Produces, `src/intake.ts`:
  - `export type IntakeAssessment = { sufficiency: InformationSufficiency; reason: string; questions: string[] };`
  - `export function parseIntakeAssessment(markdown: string): IntakeAssessment` — no fallback parameter. A spec with no `## 信息充分性` section is `clear` (a spec written before the section existed was never judged). A section whose first word is not `clear` / `assumptions` / `needs-information` is `needs-information`. A `## 管理分类` section is not read at all and does not count as an assessment. `reason` and `questions` as today.
  - `buildClarifyPrompt`: hard rule 6 is removed and rules 7–8 become 6–7; `## 管理分类` and its `quick、simple、complex 三选一` line leave the output format. `## 分类理由` stays.
- Produces, `src/cli.ts`: `const assessment = parseIntakeAssessment(specText);`.

**What changes in `tests/intake.test.ts`.** Old assertion → new assertion, nothing deleted:
- "parses the management lane and information outcome independently" (`lane: "quick"`, `sufficiency: "clear"`, `reason`) → "keeps the information verdict and the reason, and has no lane to give" (the whole result is `{ sufficiency, reason, questions }`).
- "falls back conservatively on missing or contradictory assessments": its old-format half (`"## 目标\n旧格式"` keeps the lane it was added with) → "ignores a 管理分类 section …": the old format reads `clear`; its unusable-verdict half (`spec("simple", "perhaps")` → `needs-information`) → "treats a verdict it cannot read as missing information". Its "unusable lane becomes complex, `laneEscalated: true`" half has no counterpart in the parser, which no longer reads lanes; the property it protected — a model cannot move a task out of the lane the operator declared — is "a lane the spec claims, usable or not, changes nothing" in `tests/cli-add.test.ts` (Task 1).
- "keeps only three outcome-changing questions" → unchanged.
- `buildClarifyPrompt` "carries the template, the intent and the hard rules": `toContain("## 管理分类")` and `toContain("quick、simple、complex")` → `not.toContain` of those and of `管理分类只能是`, plus `toContain("clear、assumptions、needs-information")`. A new test pins that the rules are numbered without a gap.

- [ ] **1. Write the failing tests.** In `tests/intake.test.ts` replace `describe("parseIntakeAssessment", …)` with:

```ts
describe("parseIntakeAssessment", () => {
  const spec = (claimedLane: string | null, sufficiency: string, questions = "") => [
    "## 目标", "交付", "## 验收标准", "- C1 可验证",
    ...(claimedLane === null ? [] : ["## 管理分类", claimedLane]),
    "## 信息充分性", sufficiency,
    "## 分类理由", "依据明确", "## 补问", questions,
  ].join("\n");

  it("keeps the information verdict and the reason, and has no lane to give", () => {
    expect(parseIntakeAssessment(spec("quick", "clear"))).toEqual({ sufficiency: "clear", reason: "依据明确", questions: [] });
    expect(parseIntakeAssessment(spec("simple", "assumptions"))).toMatchObject({ sufficiency: "assumptions" });
    expect(parseIntakeAssessment(spec("complex", "needs-information"))).toMatchObject({ sufficiency: "needs-information" });
  });

  it("ignores a 管理分类 section, whatever it says, and does not count it as an assessment", () => {
    expect(parseIntakeAssessment(spec("tiny", "clear")).sufficiency).toBe("clear");
    // A spec from before the sufficiency section existed was never judged: it reads as clear.
    expect(parseIntakeAssessment("## 目标\n旧格式")).toEqual({ sufficiency: "clear", reason: "", questions: [] });
    expect(parseIntakeAssessment("## 目标\n交付\n## 管理分类\nsimple")).toEqual({ sufficiency: "clear", reason: "", questions: [] });
  });

  it("treats a verdict it cannot read as missing information", () => {
    expect(parseIntakeAssessment(spec("simple", "perhaps")).sufficiency).toBe("needs-information");
    expect(parseIntakeAssessment(spec(null, "perhaps")).sufficiency).toBe("needs-information");
  });

  it("keeps only three outcome-changing questions", () => {
    expect(parseIntakeAssessment(spec("simple", "needs-information", "- Q1\n- Q2\n- Q3\n- Q4")).questions).toEqual(["Q1", "Q2", "Q3"]);
  });
});
```

  In `describe("buildClarifyPrompt")`, replace the two assertions `expect(prompt).toContain("## 管理分类");` (line 83) and `expect(prompt).toContain("quick、simple、complex");` (line 85) with:

```ts
    expect(prompt).toContain("clear、assumptions、needs-information");
    expect(prompt).not.toContain("## 管理分类");
    expect(prompt).not.toContain("管理分类只能是");
    expect(prompt).not.toContain("quick、simple、complex");
```

  (`expect(prompt).toContain("## 信息充分性");` on line 84 stays between them.)

  and add after that test:

```ts
  it("numbers its rules without a gap", () => {
    const task = parseTaskFile("---\ntitle: x\nstatus: draft\nsessions: []\nretries: 0\n---\n正文", "001-a");
    const prompt = buildClarifyPrompt({ task, type: "code", profile: null });
    expect([...prompt.matchAll(/^(\d+)\. /gm)].map((match) => Number(match[1])).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
```

  In `tests/cli-add.test.ts` add this comment above `assessedSpec` (line 21): `/** A spec as a model may still write it: the 管理分类 section is ignored since 2026-11-25 — the lane is the operator's — and is kept here to prove it. */`
- [ ] **2. Run it and expect FAIL.** `npx vitest run tests/intake.test.ts` — the parser tests fail on the result shape (`expected { lane: 'quick', … } to equal { sufficiency: 'clear', … }`), the prompt test on `expected '…' not to contain '## 管理分类'`, and the numbering test on `[1, 2, 3, 4, 5, 6, 7, 8]`. `npm run typecheck` rejects the one-argument calls.
- [ ] **3. Implement.**
  - `src/intake.ts`: `IntakeAssessment` and `parseIntakeAssessment(markdown)` as in the Interfaces, with `const assessed = sufficiencyText !== "";` and `sufficiency = isSufficiency(sufficiencyText) ? sufficiencyText : assessed ? "needs-information" : "clear"`. In `buildClarifyPrompt` delete the rule-6 line (anchor `"6. 管理分类只能是 quick、simple、complex：…`) and renumber the next two to `6.` and `7.`; delete the two template lines `"## 管理分类",` and `"quick、simple、complex 三选一",`.
  - `src/cli.ts`: `parseIntakeAssessment(specText)`.
- [ ] **4. Run it and expect PASS.** `npx vitest run tests/intake.test.ts tests/cli-add.test.ts tests/cli-profile.test.ts tests/feedback.test.ts tests/pipeline-e2e.test.ts` (the last four carry specs with and without a `## 管理分类` section and must all stay green), `npm run typecheck`, `npx tsc --noEmit`, `git diff --check`.
- [ ] **5. Directed mutation check** on `src/intake.ts`. Control: `npx vitest run tests/intake.test.ts` green.
  - M1 *a lane section counts as an assessment* — `const assessed = laneText !== "" || sufficiencyText !== "";` (with `laneText` read again). Must fail: "ignores a 管理分类 section, whatever it says, and does not count it as an assessment".
  - M2 *an unreadable verdict is clear* — `assessed ? "needs-information" : "clear"` becomes `assessed ? "clear" : "needs-information"`. Must fail: "treats a verdict it cannot read as missing information" and "ignores a 管理分类 section …".
  - M3 *the reason is dropped* — `reason: ""`. Must fail: "keeps the information verdict and the reason, and has no lane to give".
  - M4 *a fourth question* — `.slice(0, 3)` becomes `.slice(0, 4)`. Must fail: "keeps only three outcome-changing questions".
  - M5 *the template keeps the section* — restore `"## 管理分类",` and its line. Must fail: "carries the template, the intent and the hard rules" and "numbers its rules without a gap".
  - M6 *the template keeps the lane rule* — restore rule 6 unnumbered as `6. 管理分类只能是 …` and shift the others back. Must fail: "carries the template, the intent and the hard rules" (`管理分类只能是`).
  - Restore check after each: hash equal to the scratch copy's; control green again.
- [ ] **6. Commit.** `git add src/intake.ts src/cli.ts tests/intake.test.ts tests/cli-add.test.ts` — `feat(intake): stop the clarify session from classifying the lane`.

---

### Task 3: Every declared lane is recorded in `.taskctl/lanes.jsonl`

**Files:**
- Create: `src/lanes.ts`
- Modify: `src/cli.ts` (import; `addCommand`, the body after the task file is written — lines 750–835)
- Test: Create `tests/lane-examples.test.ts`

**Interfaces:**
- Consumes: `ManagementLane`, `TaskType`, `TEMPLATES` (`src/intake.ts:4–5, 75`); the layout of `feedbackPath` / `auditFile` (`join(tasksDir, "..", ".taskctl", …)`, `src/feedback.ts:52–54`, `src/audit.ts:19–21`).
- Produces, `src/lanes.ts`:
  - `export type LaneExample = { id: string; at: string; lane: ManagementLane; type: TaskType; title: string; intent: string; criteria: number };`
  - `export const LANE_INTENT_LIMIT = 500;`
  - `export function lanesPath(tasksDir: string): string`
  - `export async function appendLaneExample(tasksDir: string, example: LaneExample): Promise<void>` — creates `.taskctl` on first use, trims the intent and cuts it at `LANE_INTENT_LIMIT` code points with a trailing `…`, appends `JSON.stringify(example)` and `\n`. Never compacts.
  - `export async function readLaneExamples(tasksDir: string): Promise<LaneExample[]>` — a missing file is `[]`; a line is kept only when it parses and `id`, `at`, `title`, `intent` are strings, `criteria` is a number, `lane` is one of `LANES` and `type` is one of `TEMPLATES`' keys; any other line is skipped.
- Produces, `src/cli.ts`: `addCommand` appends exactly one example per `add` that has written its task file — `{ id, at: new Date().toISOString(), lane, type, title: task.title, intent, criteria: criteriaCount }` where `criteriaCount` is 0 until `extractCriteria` succeeded, then `criteria.length`. An `add` that ends before the task file is written appends nothing: no lane given, a usage error, or a refusal by the budget guard, which comes between the adapter and the write (`src/cli.ts:741–749`).

- [ ] **1. Write the failing tests.** Create `tests/lane-examples.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLaneExample, lanesPath, readLaneExamples, type LaneExample } from "../src/lanes.js";
import { runCli } from "../src/cli.js";
import { TaskStore } from "../src/task-store.js";
import type { AgentAdapter } from "../src/adapters/types.js";
import { CATALOGUE, adapterOf } from "./helpers/catalogue-fixture.js";

let root: string;
let dir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "taskctl-lane-examples-"));
  dir = join(root, "tasks");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const example = (overrides: Partial<LaneExample> = {}): LaneExample => ({
  id: "002-typo", at: "2026-11-25T02:00:00.000Z", lane: "simple", type: "code",
  title: "修 README 错字", intent: "修 README 错字", criteria: 1, ...overrides,
});

/** Fails loudly if a lane other than `--quick` tried to reach a model. */
const noModel: AgentAdapter = {
  prompt: async () => { throw new Error("no model call expected"); },
  contextUsage: async () => 0, contextLimit: async () => 0,
};

/** A clarify session whose spec carries `count` numbered criteria. */
function clarifier(count: number): AgentAdapter {
  const text = ["## 目标", "改好", "## 验收标准", ...Array.from({ length: count }, (_, index) => `- C${index + 1} 可验证`), ""].join("\n");
  return { prompt: async () => ({ sessionId: "s", exitCode: 0, text }), contextUsage: async () => 0, contextLimit: async () => 0 };
}

describe("lane examples on disk", () => {
  it("live at <root>/.taskctl/lanes.jsonl, one JSON line each, oldest first", async () => {
    expect(lanesPath(dir)).toBe(join(root, ".taskctl", "lanes.jsonl"));
    await appendLaneExample(dir, example({ id: "first", lane: "quick", intent: "合并两列" }));
    await appendLaneExample(dir, example({ id: "second" }));
    expect((await readFile(lanesPath(dir), "utf8")).trimEnd().split("\n")).toHaveLength(2);
    expect(await readLaneExamples(dir)).toEqual([
      { id: "first", at: "2026-11-25T02:00:00.000Z", lane: "quick", type: "code", title: "修 README 错字", intent: "合并两列", criteria: 1 },
      example({ id: "second" }),
    ]);
  });

  it("read as no examples when the file does not exist", async () => {
    expect(await readLaneExamples(dir)).toEqual([]);
  });

  it("a line that does not parse, or names no lane, is skipped", async () => {
    await mkdir(join(root, ".taskctl"), { recursive: true });
    await writeFile(lanesPath(dir), [
      JSON.stringify(example()), "{ torn write",
      JSON.stringify({ id: "x", at: "2026-11-25T02:00:00.000Z", lane: "tiny", type: "code", title: "x", intent: "x", criteria: 0 }), "",
    ].join("\n"), "utf8");
    expect((await readLaneExamples(dir)).map((record) => record.id)).toEqual(["002-typo"]);
  });

  it("the intent is bounded at 500 characters and the cut is marked", async () => {
    await appendLaneExample(dir, example({ intent: "意".repeat(600) }));
    const [record] = await readLaneExamples(dir);
    expect(Array.from(record!.intent)).toHaveLength(501);
    expect(record!.intent.endsWith("…")).toBe(true);
  });

  it("a multi-line intent stays on one line of the file", async () => {
    await appendLaneExample(dir, example({ intent: "第一行\n第二行\r\n第三行" }));
    expect((await readFile(lanesPath(dir), "utf8")).trimEnd().split("\n")).toHaveLength(1);
    expect((await readLaneExamples(dir))[0]!.intent).toBe("第一行\n第二行\r\n第三行");
  });

  it("nothing is ever compacted away", async () => {
    for (let index = 0; index < 205; index++) await appendLaneExample(dir, example({ id: `t${index}` }));
    expect(await readLaneExamples(dir)).toHaveLength(205);
  });
});

describe("taskctl add records the declared lane", () => {
  const silent = { log: (): void => {}, err: (): void => {} };
  const lines = async (): Promise<Array<Record<string, unknown>>> =>
    (await readFile(lanesPath(dir), "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);

  it("appends one line per add with the lane, the type, the title, the intent and the number of criteria", async () => {
    expect(await runCli(["add", "把这个表格的两列合并", "--tasks-dir", dir, "--id", "001-merge", "--quick"], { ...silent, adapter: noModel })).toBe(0);
    expect(await runCli(["add", "改 README 错字", "--type", "office", "--tasks-dir", dir, "--id", "002-typo", "--simple"], { ...silent, adapter: clarifier(2) })).toBe(0);
    expect(await runCli(["add", "重构登录模块\n先看现有接口", "--tasks-dir", dir, "--id", "003-login", "--complex"], { ...silent, adapter: clarifier(3) })).toBe(0);

    expect(await lines()).toEqual([
      { id: "001-merge", at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/), lane: "quick", type: "office", title: "把这个表格的两列合并", intent: "把这个表格的两列合并", criteria: 0 },
      { id: "002-typo", at: expect.any(String), lane: "simple", type: "office", title: "改 README 错字", intent: "改 README 错字", criteria: 2 },
      { id: "003-login", at: expect.any(String), lane: "complex", type: "code", title: "重构登录模块", intent: "重构登录模块\n先看现有接口", criteria: 3 },
    ]);
  });

  it("a clarify session that fails still records the declared lane, with no criteria", async () => {
    const failing: AgentAdapter = { prompt: async () => ({ sessionId: "s", exitCode: 1, text: "" }), contextUsage: async () => 0, contextLimit: async () => 0 };
    expect(await runCli(["add", "重构登录模块", "--tasks-dir", dir, "--id", "004-y", "--complex"], { ...silent, adapter: failing })).toBe(1);
    expect(await lines()).toEqual([{
      id: "004-y", at: expect.any(String), lane: "complex", type: "code", title: "重构登录模块", intent: "重构登录模块", criteria: 0,
    }]);
  });

  it("an add that is refused records nothing", async () => {
    const errors: string[] = [];
    const code = await runCli(["add", "重构登录模块", "--tasks-dir", dir, "--id", "005-z"], { ...silent, adapter: clarifier(1), askLane: async () => null, err: (line) => errors.push(line) });
    expect(code).toBe(2);
    expect(await readdir(root)).toEqual([]);
  });

  it("an add the budget guard refuses records nothing: no task reached the board", async () => {
    // The clarify model as the shared catalogue prices it per token, and no allowance for it:
    // the guard refuses before the task file is written and the command exits 1.
    const config = join(root, "taskctl.json");
    await writeFile(config, JSON.stringify({ tasksDir: dir, model: "zen/p" }), "utf8");
    const errors: string[] = [];
    const guarded: AgentAdapter = { ...clarifier(1), ...adapterOf(CATALOGUE) };
    const code = await runCli(["add", "重构登录模块", "--complex", "--tasks-dir", dir, "--id", "007-guard", "--config", config], { ...silent, err: (line) => errors.push(line), adapter: guarded });
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("budget guard refused: zen/p");
    expect(await readLaneExamples(dir)).toEqual([]);
  });

  it("a failed append is reported and does not change the result", async () => {
    // A directory where the file should be: the append cannot land.
    await mkdir(lanesPath(dir), { recursive: true });
    const said: string[] = [];
    const code = await runCli(["add", "把这个表格的两列合并", "--tasks-dir", dir, "--id", "006-q", "--quick"], { log: (line) => said.push(line), err: () => {}, adapter: noModel });
    expect(code).toBe(0);
    expect(said.join("\n")).toMatch(/006-q\s+open\s+quick/);
    expect(said.join("\n")).toMatch(/006-q\s+lane example not recorded/);
    expect((await new TaskStore(dir).get("006-q")).status).toBe("open");
  });
});
```

- [ ] **2. Run it and expect FAIL.** `npx vitest run tests/lane-examples.test.ts` — the file cannot load: `Failed to load url ../src/lanes.js` (the module does not exist). Even without it, no `add` of today writes anything under `.taskctl` for a lane.
- [ ] **3. Implement.**
  - Create `src/lanes.ts` with the signatures above (`mkdir` the parent on first use, then `appendFile` — the landing `appendAudit` uses, `src/audit.ts:24–28`).
  - `src/cli.ts`: import `appendLaneExample`; declare `let criteriaCount = 0;` directly after the task file is written (line 750; anchor `await writeFile(join(tasksDir, \`${id}.md\`), serializeTaskFile(task), { encoding: "utf8", flag: "wx" });`), wrap everything from `if (quick) {` (line 752) to the final `return 0;` of `addCommand` (line 835) in `try { … } finally { … }`, with the `try` opened after the write and not before the budget guard's block, so that an `add` the guard refuses never reaches the `finally`; set `criteriaCount = criteria.length;` directly after `criteria = extractCriteria(specText);` (line 791), and make the `finally` the one append of the Interfaces section, written as `await appendLaneExample(tasksDir, { … }).catch((error: unknown) => log(\`${id}  lane example not recorded: ${error instanceof Error ? error.message : String(error)}\`));`.
- [ ] **4. Run it and expect PASS.** `npx vitest run tests/lane-examples.test.ts tests/lane-declared.test.ts tests/cli-add.test.ts tests/feedback.test.ts`, `npm run typecheck`, `npx tsc --noEmit`, `git diff --check`.
- [ ] **5. Directed mutation check** on `src/lanes.ts` (M1, M2, M5, M6, M7) and `src/cli.ts` (M3, M4, M8, M9, M10). Control: `npx vitest run tests/lane-examples.test.ts` green.
  - M1 *unbounded intent* — store `example.intent`. Must fail: "the intent is bounded at 500 characters and the cut is marked".
  - M2 *a different bound* — `LANE_INTENT_LIMIT = 499`. Must fail: the same test (it expects `501`, a literal, not the constant).
  - M3 *the criteria count lost* — `criteria: 0` in the append. Must fail: "appends one line per add with the lane, the type, the title, the intent and the number of criteria".
  - M4 *only a successful clarify records* — move the append out of the `finally` to just before the last `return 0;`. Must fail: "a clarify session that fails still records the declared lane, with no criteria" and "appends one line per add with the lane, the type, the title, the intent and the number of criteria" (the quick add returns before the append).
  - M5 *a corrupt line is fatal* — remove the `try`/`catch` around `JSON.parse`. Must fail: "a line that does not parse, or names no lane, is skipped".
  - M6 *a foreign lane is kept* — drop the `lane` check. Must fail: the same test.
  - M7 *compacted like the feedback history* — keep only the newest 200 lines. Must fail: "nothing is ever compacted away".
  - M8 *a failed append is fatal* — remove the `.catch(…)` in the `finally`. Must fail: "a failed append is reported and does not change the result".
  - M9 *the intent is recorded as its first line* — `intent: task.title` in the append. Must fail: "appends one line per add with the lane, the type, the title, the intent and the number of criteria" (the third add has a two-line intent).
  - M10 *a guard refusal records a lane* — move the opening `try {` up, so that it stands before `const adapter = deps.adapter ?? new OpenCodeAdapter({ bin: cfg.opencodeBin });` and the `finally` runs after the guard has thrown. Must fail: "an add the budget guard refuses records nothing: no task reached the board".
  - Restore check after each: hash equal to the scratch copy's; control green again.
- [ ] **6. Commit.** `git add src/lanes.ts src/cli.ts tests/lane-examples.test.ts` — `feat(lanes): record every declared lane in .taskctl/lanes.jsonl`.

---

### Task 4: `taskctl lanes` prints them grouped by lane

**Files:**
- Modify: `src/lanes.ts` (one function)
- Modify: `src/cli.ts` (`USAGE`, after the `metrics` line, 174; the `lanes` case of `dispatch`, after the `metrics` case, lines 332–334; `lanesCommand` after `metricsCommand`, lines 1372–1539, before the doc comment of `reconcileCommand`)
- Test: Modify `tests/lane-examples.test.ts`

**Interfaces:**
- Consumes: `LaneExample`, `LANES` (`src/lanes.ts`, `src/intake.ts`); `tasksDirFor(flags)` (`src/cli.ts:191`).
- Produces, `src/lanes.ts`: `export function renderLanes(examples: LaneExample[]): string[]` — pure. For each lane of `LANES` in order: `lane <lane> (<count>)`, then one line per example of that lane in file order, `  <first ten characters of at>  <id>  <type>  criteria=<n>  <title>`, and — only when the intent is not the title — `      <intent with every line break replaced by " / ">`. An empty group prints `  (none)`.
- Produces, `src/cli.ts`: `taskctl lanes [--tasks-dir <dir>]` — `lanesCommand(flags, log)` prints `renderLanes(await readLaneExamples(await tasksDirFor(flags)))` and returns 0; allowed flags `["tasks-dir", "config"]`, as `metrics` has.

- [ ] **1. Write the failing tests.** In `tests/lane-examples.test.ts` add `renderLanes` to the import, then:

```ts
describe("renderLanes", () => {
  it("groups by lane in the fixed order, oldest first inside a group, and prints the intent when it says more than the title", () => {
    expect(renderLanes([
      example({ id: "002-typo", intent: "修 README 错字\n不要动别的文件" }),
      example({ id: "001-merge", at: "2026-11-25T01:00:00.000Z", lane: "quick", type: "office", title: "合并两列", intent: "合并两列", criteria: 0 }),
      example({ id: "003-login", at: "2026-11-25T02:30:00.000Z", title: "重构登录模块", intent: "重构登录模块", criteria: 3 }),
    ])).toEqual([
      "lane quick (1)",
      "  2026-11-25  001-merge  office  criteria=0  合并两列",
      "lane simple (2)",
      "  2026-11-25  002-typo  code  criteria=1  修 README 错字",
      "      修 README 错字 / 不要动别的文件",
      "  2026-11-25  003-login  code  criteria=3  重构登录模块",
      "lane complex (0)",
      "  (none)",
    ]);
  });
});

describe("taskctl lanes", () => {
  it("prints what was declared, through the real command", async () => {
    await appendLaneExample(dir, example());
    await appendLaneExample(dir, example({ id: "001-merge", lane: "quick", type: "office", title: "合并两列", intent: "合并两列", criteria: 0 }));
    const printed: string[] = [];
    expect(await runCli(["lanes", "--tasks-dir", dir], { log: (line) => printed.push(line) })).toBe(0);
    expect(printed).toEqual([
      "lane quick (1)",
      "  2026-11-25  001-merge  office  criteria=0  合并两列",
      "lane simple (1)",
      "  2026-11-25  002-typo  code  criteria=1  修 README 错字",
      "lane complex (0)",
      "  (none)",
    ]);
  });

  it("prints three empty groups when nothing was ever declared", async () => {
    const printed: string[] = [];
    expect(await runCli(["lanes", "--tasks-dir", dir], { log: (line) => printed.push(line) })).toBe(0);
    expect(printed).toEqual(["lane quick (0)", "  (none)", "lane simple (0)", "  (none)", "lane complex (0)", "  (none)"]);
  });

  it("is listed in the usage text", async () => {
    const errors: string[] = [];
    await runCli([], { log: () => {}, err: (line) => errors.push(line) });
    expect(errors.join("\n")).toContain("taskctl lanes [--tasks-dir <dir>]");
  });
});
```

- [ ] **2. Run it and expect FAIL.** `npx vitest run tests/lane-examples.test.ts` — "is listed in the usage text" and the two command tests fail: `runCli(["lanes", …])` answers `taskctl: unknown command "lanes"` and returns 2 (`expected 2 to be 0`); `renderLanes` is not an export.
- [ ] **3. Implement.**
  - `src/lanes.ts`: `renderLanes` as in the Interfaces.
  - `src/cli.ts`: `USAGE` gains `"  taskctl lanes [--tasks-dir <dir>]",` directly after the `metrics` line; `dispatch` gains `case "lanes": checkFlags(command, flags, ["tasks-dir", "config"], []); return lanesCommand(flags, log);` directly after the `metrics` case; `lanesCommand` as in the Interfaces, with a doc comment in the form of the others (`/** \`taskctl lanes\` — every declared lane, grouped. */`).
- [ ] **4. Run it and expect PASS.** `npx vitest run tests/lane-examples.test.ts tests/cli.test.ts`, `npm run typecheck`, `npx tsc --noEmit`, `git diff --check`. Then the whole suite once: `npm test` — all green; the count is the one from before Task 1 plus the tests of this plan (865 at `c8e604f`; 1 skipped, the real-browser test, as before).
- [ ] **5. Directed mutation check** on `src/lanes.ts` (M3, M4 on `src/cli.ts`). Control: `npx vitest run tests/lane-examples.test.ts` green.
  - M1 *alphabetical order* — iterate `[...LANES].sort()`. Must fail: "groups by lane in the fixed order …" and "prints what was declared, through the real command".
  - M2 *empty groups left out* — `continue` when a group has no examples. Must fail: "prints three empty groups when nothing was ever declared".
  - M3 *no command* — remove the `case "lanes"`. Must fail: "prints what was declared, through the real command".
  - M4 *no usage line*. Must fail: "is listed in the usage text".
  - M5 *the intent line always printed*. Must fail: "groups by lane in the fixed order …" (`toEqual`).
  - Restore check after each: hash equal to the scratch copy's; control green again.
- [ ] **6. Commit.** `git add src/lanes.ts src/cli.ts tests/lane-examples.test.ts` — `feat(cli): add taskctl lanes`.

---

### Task 5: ADR-0010, README, and the dated note on §16.1

**Files:**
- Create: `docs/adr/0010-lane-declared-by-operator.md`
- Modify: `README.md` (lines 145–147; after line 147; lines 151, 153, 156, 158; line 196; after line 211; line 219; before line 272; line 282. At `c8e604f`; find each by the text quoted, since parts 1 to 3 edit the README too)
- Modify: `docs/superpowers/specs/2026-11-24-adaptive-execution-design.md` (after line 551, the heading of §16.1)

No runtime change: there is no failing test to write and no guard to reverse. The check is that every sentence names a flag, a file or a command that exists.

- [ ] **1. Create ADR-0010** with this text (the shape of ADR-0008 and ADR-0009: title, what it supersedes, `## Context`, `## Decision`, `## Consequences`, `## Limits`; English, as they are):

```markdown
# The lane is declared by the operator

Restates ADR-0009's "no classifier decides a lane" after the intake
classification of §16.1 of the 2026-11-24 adaptive execution design had
reversed it, and retires the "explicit statement in the user's own words"
path of ADR-0008: nothing in the wording of an intent decides whether a
task runs without a signature. Design: [Model trouble and operator
control](../superpowers/specs/2026-11-25-model-trouble-and-operator-control-design.md),
§12.

## Context

- From 2026-11-24 the clarify session proposed the management lane
  (`quick` / `simple` / `complex`) from the intent. A `simple` verdict opens
  the task at once, without a signature. A wrong downgrade is silent: the
  task runs before anyone reads the spec.
- Separately, `taskctl add` read the intent for "简单任务" and opened the task
  when it found the words. A sentence in the intent — written by the
  operator, or by an agent on his behalf — stood in for his decision.
- Both decided, from words, the one thing ADR-0008 calls expensive to get
  wrong, and neither left a record that could later show how often it was
  right: `classification.json` held a proposal, not a judged example.

## Decision

- `taskctl add` requires the lane: `--quick`, `--simple` or `--complex`.
  With none given it asks once on a terminal, and otherwise exits with a
  usage error that names the three. It never chooses a lane by itself.
- The clarify session no longer classifies. It still returns the
  information-sufficiency verdict and at most three questions; a
  `needs-information` verdict keeps the task in `draft` whatever the lane.
- `classification.json` records the declared lane with
  `source: "operator"`. There is no proposed lane, and nothing to count as
  an escalation.
- Every `taskctl add` appends one line to `.taskctl/lanes.jsonl`: id, time,
  lane, task type, title, the intent (bounded) and the number of criteria.
  `taskctl lanes` prints them grouped by lane.
- `detectComplexity` is removed.

## Consequences

- A task cannot run without the owner's signature because of how its
  intent was worded. The lane is the operator's statement — a flag, or a
  typed answer — and nothing else.
- An agent that adds tasks on the owner's behalf has to ask him for the
  lane first. A script that calls `add` without a lane fails loudly instead
  of guessing.
- The `分类升级` row of `taskctl metrics` can only ever count records
  written before this decision. It is kept so that history still reads.
- `.taskctl/lanes.jsonl` is the evidence a classifier needs: declared lanes
  beside the intents they were declared for. Once there are enough of them,
  a cheap model may propose a lane from these examples — as a proposal the
  operator confirms, never as the decision.

## Limits

The operator can still declare the wrong lane; escalation during the run
(ADR-0009) is what catches that, as before. Examples accumulate only where
`add` is used: tasks written by hand or published by `split` record none.
```

- [ ] **2. Edit `README.md`.**
  - Lines 145–147 (the lane table), first two rows — replace them with:

    ```text
    | 标准 | `add --complex "<意图>"` | `draft`，澄清会话出 spec + criteria，等人签字 | 一次模型调用 + 一次签字 |
    | 简单 | `add --simple "<意图>"` | `open`，仍出 spec | 少一次签字 |
    ```

  - Directly after the table (line 147), separated from it by a blank line, insert:

    ```text
    **车道必须由你声明（2026-11-25）。** 三者选一是 `add` 的必填项。一个都没给时，`add` 在终端上问一次——只问这一次；stdin 不是终端（脚本、管道、agent 代跑）时直接以用法错误退出，点名这三个，什么都不创建。意图里写「简单任务」不再起任何作用：措辞不能替你决定一个任务要不要签字。**代你加任务的 agent：先问你要车道。** 每次声明都记一条示例（见「车道示例」），日后据此评估是否让模型给建议。
    ```

  - Line 151: replace the whole line with:

    ```text
    走 `--simple` / `--complex` 的 `taskctl add` 在**同一个澄清回合**里顺带判断信息是否充分，不另外花一次模型调用（`--quick` 仍然零模型调用）。车道与它分开，由你声明：
    ```

  - Line 153: replace the whole bullet with (the limits are the old sentence, verbatim):

    ```text
    - **车道** `quick` / `simple` / `complex`：由你声明（见上表）。它只决定管理强度：quick 是极轻量单步；simple 是一次 Worker 后最终 Review；complex 需要拆子任务和/或 Worker→Review→Worker 迭代。它**不能**降低 `risk`、去掉 `human_check`、放宽 `criteria` 或把人工复核改成机械验证——那些只能由你在已批准的任务定义里显式声明。
    ```

  - Line 156: replace the whole line with:

    ```text
    结果写在 `tasks/<id>/classification.json`：声明的车道、`source: "operator"`、信息充分性、理由、模型。
    ```

  - Line 158: replace the whole line with:

    ```text
    信息充分性判错或自相矛盾时，按 `needs-information` 处理并停在 `draft`。`--execution` 是你对执行策略的显式选择，与车道独立。
    ```

  - Line 196 (inside the pipeline code block): replace the whole line with:

    ```text
    taskctl add --complex "<意图>"   澄清会话出 spec + criteria；complex 停在 draft 等签字（车道必填：--quick / --simple / --complex）
    ```

  - After line 211 (`taskctl metrics             哪个环节在拖后腿、工作被谁退回来`; the learning loop added a `taskctl recall` line after it), insert:

    ```text
    taskctl lanes             按车道列出每次声明的示例（.taskctl/lanes.jsonl）
    ```
  - Line 219: replace the whole bullet with:

    ```text
    - **车道**：由你用 `--quick` / `--simple` / `--complex` 声明，意图的措辞不起作用；`--simple` 跳过签字但照常出 spec，`--complex` 停在 `draft`。判为 `needs-information` 的任务无论哪条道都停在 `draft`（见「接入分类」）。
    ```

  - Before line 272 (`### taskctl metrics — 谁在把工作退回来`), insert:

    ```text
    ### 车道示例

    `.taskctl/lanes.jsonl` 每次 `taskctl add` 追加一行：id、时间、声明的车道、任务类型、标题、意图（最多 500 字符，超出以 `…` 标记）、验收标准条数。澄清会话失败的那次也记（标准数为 0）；没给车道而被拒绝的 `add` 不记。它只追加、不压缩，坏行在读取时跳过。`taskctl lanes` 按车道分组打印——quick、simple、complex 的固定顺序，空组也显示。这是日后让模型给车道建议、以及三条车道说明清单的材料。它是证据不是状态：手工删改不影响任何任务的执行。
    ```

  - Line 282 (the `分类升级` row of the metrics table): replace the whole line with:

    ```text
    | 分类升级 | 模型没给出可用车道、由 taskctl 兜底到 `complex`，或实际车道比模型建议更保守的任务数（2026-11-25 起车道由所有者声明，新记录不再计入；此行只反映之前的 `classification.json`） |
    ```
- [ ] **3. Add the dated note** to `docs/superpowers/specs/2026-11-24-adaptive-execution-design.md`, directly under the heading `### 16.1 Three management lanes` (line 551):

    ```text
    > **2026-11-25 更新**：本节的模型分类已被 [Model trouble and operator control](2026-11-25-model-trouble-and-operator-control-design.md) §12 取代，决策记录见 [ADR-0010](../../adr/0010-lane-declared-by-operator.md)。车道由所有者声明（`--quick` / `--simple` / `--complex`，未给时在终端上问一次）；澄清会话只回答信息充分性与补问，`classification.json` 记 `source: "operator"`。下文保留为当时的决策记录；表格中「Approval」「Execution and finish」两列仍然有效。
    ```

- [ ] **4. Check each statement against the code.** `grep -n "source: \"operator\"" src/cli.ts`; `grep -n '"complex"' src/cli.ts` (the dispatch table and `BOOLEAN_FLAGS`); `grep -n "taskctl lanes" src/cli.ts README.md`; `grep -n "LANE_INTENT_LIMIT = " src/lanes.ts` shows `500`; `grep -rn "detectComplexity" src tests` prints nothing; `grep -n "管理分类" src/intake.ts` prints nothing unless a comment explains the section's removal.
- [ ] **5. Gates.** `npm test`, `npm run typecheck`, `npx tsc --noEmit`, `git diff --check`; `.\scripts\smoke.ps1` and `.\scripts\live-phase2.ps1` without `-Live` both exit 0 (neither script calls `add`; they write their task files directly).
- [ ] **6. Commit.** `git add docs/adr/0010-lane-declared-by-operator.md README.md docs/superpowers/specs/2026-11-24-adaptive-execution-design.md` — `docs: record that the lane is declared by the operator`.

---

## Closing gates

After Task 5: `npm test` (the count from before Task 1 plus this plan's tests; 865 at `c8e604f`; 1 skipped), `npm run typecheck`, `npx tsc --noEmit`, `git diff --check`, and the two smoke scripts in offline mode — all clean.

No live run belongs to this plan. The clarify prompt changed, and the first real `taskctl add --simple` after it is the owner's to try; the parser tolerates a model that still writes `## 管理分类`, which Task 2's tests pin.

## Evidence

**Evidence (2026-11-27):** branch `feat/lane-declared-by-operator`, cut from `main`'s `eaee031`; six commits, code tip `539d726` (the five task commits plus one final fix wave). Each task was implemented and reviewed by one fresh subagent (`deepseek/deepseek-flash`, the owner's approval of 2026-11-27), one at a time; the controller re-ran every task's checks and every mutation row from the implementer's machine-readable spec.

| Task | What it left | Its own run |
| --- | --- | --- |
| 1 | `src/intake.ts`, `src/cli.ts`, new `tests/lane-declared.test.ts`, eight edited test files | 10 files, **145/145** |
| 2 | `src/intake.ts`, `src/cli.ts`, `tests/intake.test.ts`, `tests/cli-add.test.ts` | 5 files, **41/41** |
| 3 | new `src/lanes.ts`, `src/cli.ts`, new `tests/lane-examples.test.ts` | 4 files, **60/60** (the new file 11) |
| 4 | `src/lanes.ts`, `src/cli.ts`, `tests/lane-examples.test.ts` | 2 files, **34/34** (the lane file 15) |
| 5 | `docs/adr/0010-lane-declared-by-operator.md`, `README.md`, the dated note on §16.1 | docs only; typecheck/tsc/diff clean; both offline scripts exit 0 |

**Whole suite at the tip: 1174 passed / 13 failed / 1 skipped (1188 tests, 92 files).** The 13 are the process-cancellation tests (`execution` 7, `stop-worker` 3, `self-check` 1, `worker` 1, `spawn-insulation` 1). They fail on `EBUSY: rmdir …\work` and on `cancel()` returning false, because the Windows process listing takes **3.2–3.5 s** against the code's fixed 3000 ms `TREE_LIST_DEADLINE_MS` on this machine (1171 processes, 695 of them the owner's browser). The same single test fails at `eaee031` on `main` checked out in the same shell, and no commit of this plan touches `src/execution.ts`, `src/self-check.ts` or the stop code. At `eaee031` the suite is 1148 passed / 1 skipped; this plan adds 39 tests. **This is the one closing gate that is not green; it is environmental, not the branch, and it is reported to the owner.** Everything else is clean: `npm run typecheck`, `npx tsc --noEmit`, `git diff --check` exit 0; `scripts/smoke.ps1` and `scripts/live-phase2.ps1` in their offline modes exit 0; no process left by those scripts.

**Mutations at the tip** (the four copied specs, every row by machine): 35 rows — Task 1: 14, Task 2: 6, Task 3: 10, Task 4: 5 — **35 applied, 35 killed, 0 survived**, every named killer failed, every control run green before and after its table, every mutated file back at its bytes. Two process artifacts needed re-anchoring after the fix wave (Task 3's M6 `from`, and three `mustFail` titles naming the renamed terminal-seam test); the run above is the final one.

## Found while carrying out (2026-11-27)

- **Task 1 — the call-site count is stale.** The brief says "28 call sites in 6 files at c8e604f"; `tests/direct-model.test.ts` also calls `add` and is not in its file list. The implementer added the lane flags there (test-only, no assertion changed), which the controller accepted.
- **Task 1 — the record's `model` field.** The brief's literal `cfg.model ?? "(backend-default)"` would regress §16 (parts 1–3 make `add` run on the head of `modelChain`); the committed form keeps `directModel(cfg)`, pinned by `tests/direct-model.test.ts`. Accepted.
- **Task 2 — two brief defects.** The rule-numbering test's code misses a closing paren; it was implemented in its intended form. M5 does not kill the numbering test as predicted (restoring the template lines adds no numbered rule) — M6 does, and the spec records the observed set rather than the predicted one.
- **Task 4 — an insertion point read literally.** The brief says "add `lanesCommand` … before the doc comment of `reconcileCommand`"; the implementer inserted it *inside* that comment, so `lanesCommand` carried reconcile's documentation and the text was duplicated. The task review caught it as Important; one fix round removed the three stray lines.
- **Task 5 — the grep cannot be empty.** `grep -rn detectComplexity src tests` finds Task 1's own comment in `tests/lane-declared.test.ts`; there is no code occurrence, and the brief did not anticipate its own earlier text. The implementer also edited README line 154, where the helper-file list still described the removed `classification.json` fields — an omission from the brief's list, accepted.
- **The mutation artifacts.** Task 3's `mustFail` were strings (one with a parenthetical annotation), and the fix wave's test rename staled three titles and one `from` anchor. The controller normalised and re-anchored them; the final 35/35 run is the evidence, and the artifacts live in the plan's git-ignored workspace.
- **The baseline is three plans old.** "Reading this plan" (865 tests at `c8e604f`) predates plans 1–3; the tree at `eaee031` has 1148 tests, and the count before Task 1 was the one from the run, not the line.
- **The whole-suite gate.** See Evidence: 13 environmental process-cancellation failures, reproduced on `main`, caused by the WMI listing exceeding its 3000 ms deadline on a 1171-process machine. Not papered over; reported.

Parked findings (task and whole-branch reviews; none Critical or Important remains; the owner can overrule any):

1. Task 1: the quoted-reply suffix `("<reply>" is not a lane)` is not asserted — message text only.
2. Task 1: the `deps.askLane ?? askOnTerminal` join is not exercised through `add` (both halves are tested separately).
3. Task 1: no test asserts that the quick lane writes no `classification.json` (behaviour unchanged by this plan).
4. Task 2: a present-but-empty `## 信息充分性` section reads `clear` (presence is text-based; pre-existing).
5. Task 2: one assertion in the ignore test is vacuous for its line's claim (M1 is still killed by the next line).
6. Task 2: the rule-numbering regex scans the whole prompt, not the `## 硬规则` block.
7. Task 3: `readLaneExamples` keeps its own two-line lane predicate rather than importing `isLane`; the plan makes `isLane` private to `intake.ts` on purpose.
8. Task 3: `task-3-mutations.json` encodes `mustFail` as strings (process artifact, not shipped; the controller's normalised re-run is the evidence).
9. Task 5: the `分类升级` row's "new records no longer counted" overstates — only the numerator is frozen; the denominator still counts every `classification.json`, so a new board prints `0 / N` with N growing.
10. Whole-branch re-review: the ADR Limits' `criteria: 0` sentence omits the quick lane (no clarify, no criteria) and an empty-spec clarify — both produce 0 without a failure. Suggested: "…means the quick lane, a failed or empty clarify session, or failed extraction".
11. Whole-branch re-review: the skip test's name still says "names no lane" though it now also covers an unknown type.
12. The lane file is best-effort evidence, not a census: a crash between the task write and the append, or a failed append, loses one example (now stated in the ADR Limits, with the hand-written/`split` sentence).
