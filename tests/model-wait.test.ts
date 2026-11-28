import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noteModelRefusal } from "../src/model-cooldown.js";
import { definitionFields } from "../src/runtime.js";
import { artifactDigest } from "../src/workspace.js";
import { buildTaskFile } from "./helpers/task-fixture.js";
import {
  DEFAULT_MODEL_KEY,
  MODEL_COOLDOWN_MS_DEFAULT,
  MODEL_ROUNDS_DEFAULT,
  MODEL_WAIT_FILE,
  addRefusal,
  chainKeys,
  clearModelWait,
  coolingRefusals,
  formatDuration,
  mergeRefusals,
  modelCooldownMsOf,
  modelKey,
  modelRoundsOf,
  modelWaitHold,
  modelWaitHolds,
  newRunContext,
  processRun,
  readModelWait,
  refusalReason,
  servedAnywhere,
  servedSince,
  writeModelWait,
  type ModelRefusal,
  type ModelWaitConfig,
  type ModelWaitHold,
  type ModelWaitRecord,
  type ModelWaitStage,
  type RunContext,
} from "../src/model-wait.js";

let root: string;
let tasks: string;
let work: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "taskctl-model-wait-"));
  tasks = join(root, "tasks");
  work = join(root, "work");
  await mkdir(tasks);
  await mkdir(work);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const T0 = new Date("2026-11-25T10:00:00.000Z");
const iso = (offsetMs: number): string => new Date(T0.getTime() + offsetMs).toISOString();
const refusal = (model: string, reason = model + " said no"): ModelRefusal => ({ model, at: iso(0), reason, source: "turn" });
const record = (overrides: Partial<ModelWaitRecord> = {}): ModelWaitRecord => ({
  runId: "run-a", stage: "worker", rounds: 1, firstRefusedAt: iso(0), refusals: [refusal("q/one")],
  nextAt: iso(60_000), updatedAt: iso(0), ...overrides,
});

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

  it("names an acceptance anywhere, including a model outside the chain", () => {
    const run = newRunContext(T0);
    run.accepted.set("q/one", T0.getTime() + 5_000);
    run.accepted.set("r/nine", T0.getTime() + 6_000);
    expect(servedAnywhere(run, T0.getTime())).toBe("q/one");
    expect(servedAnywhere(run, T0.getTime() + 5_000)).toBe("r/nine");
    expect(servedAnywhere(run, T0.getTime() + 6_000)).toBeNull();
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
