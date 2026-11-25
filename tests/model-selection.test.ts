import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearModelCooldown, noteModelRefusal } from "../src/model-cooldown.js";
import { readRuntime } from "../src/runtime.js";
import { serializeTaskFile } from "../src/task-file.js";
import { runTask, type WorkerConfig } from "../src/worker.js";
import type { AgentAdapter } from "../src/adapters/types.js";
import { TaskStore } from "../src/task-store.js";
import { buildTaskFile } from "./helpers/task-fixture.js";

let root: string;
let tasks: string;
let work: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "taskctl-model-selection-"));
  tasks = join(root, "tasks");
  work = join(root, "work");
  await mkdir(tasks, { recursive: true });
  await mkdir(work, { recursive: true });
  await writeFile(join(tasks, "a.md"), serializeTaskFile(buildTaskFile({
    id: "a", execution: "continuous", acceptance: "check", criteria: ["C1 ok"],
  })), "utf8");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const refuse = { sessionId: "", exitCode: 1, text: "weekly limit reached", failure: "provider" as const, tokens: 0 };
const reviewed = {
  verdict: "pass" as const, criteria: [{ id: "C1", pass: true, evidence: "ok" }],
  externalChanges: [], defects: [], summary: "ok",
};
const accepted = async () => ({ passed: true, skipped: false as const, exitCode: 0, output: "ok" });

function config(...chain: string[]): WorkerConfig {
  return {
    tasksDir: tasks, workdir: work, agent: "fixture", model: chain[0], modelChain: chain,
    modelCooldownMs: 900_000, quotaBackoffMs: [0], contextThreshold: 0.8,
    retryLimit: 1, lockTtlMs: 5_000, heartbeatMs: 50,
  };
}

async function run(store: TaskStore, cfg: WorkerConfig, adapter: AgentAdapter): Promise<string> {
  return runTask(cfg, { store, adapter, acceptance: accepted, review: async () => reviewed }, await store.get("a"), "a-run");
}

/**
 * Which model a role dispatches is answered from two records: the per-task
 * rotation (an index into the full chain) and the board-level cooldown table.
 * The index describes the full chain, so it must be read on the full chain.
 */
describe("model selection beside the shared cooldown", () => {
  it("stays on the rotated model when an earlier model becomes dispatchable again", async () => {
    const dispatches: Array<[string, string | undefined]> = [];
    let turns = 0;
    const adapter: AgentAdapter = {
      prompt: async (args) => {
        dispatches.push([args.model ?? "(default)", args.sessionId]);
        if (args.model !== "q/three") return refuse;
        if (turns++ === 0) {
          // Another task's successful dispatch clears the head model's refusal
          // while q/two is still cooling: the board offers q/one again.
          await clearModelCooldown(tasks, "q/one");
          return { sessionId: "ses-three", exitCode: 0, text: "still working" };
        }
        await writeFile(join(tasks, "a", "done.requested"), "done");
        return { sessionId: "ses-three", exitCode: 0, text: "done" };
      },
      contextUsage: async () => 0, contextLimit: async () => 100,
    };
    const store = new TaskStore(tasks);

    expect(await run(store, config("q/one", "q/two", "q/three"), adapter)).toBe("done");
    expect(dispatches).toEqual([
      ["q/one", undefined], ["q/two", undefined], ["q/three", undefined], ["q/three", "ses-three"],
    ]);
    expect(await readRuntime(tasks, "a", "acceptance.json")).toMatchObject({ model: "q/three" });
  });

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

  it("labels the work with the model that ran the turn, not with whichever model is available at acceptance", async () => {
    // Between the end of a successful turn and the acceptance gate the controller
    // reads the done marker once. That is where the board changes underneath it:
    // another task is refused on the producing model, and a third one succeeds
    // on the model this task was refused on.
    class BoardChangesStore extends TaskStore {
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
    const adapter: AgentAdapter = {
      prompt: async (args) => {
        if (args.model === "q/one") return refuse;
        await writeFile(join(tasks, "a", "done.requested"), "done");
        return { sessionId: "ses-two", exitCode: 0, text: "done" };
      },
      contextUsage: async () => 0, contextLimit: async () => 100,
    };
    const store = new BoardChangesStore(tasks);

    expect(await run(store, config("q/one", "q/two"), adapter)).toBe("done");
    expect(await readRuntime(tasks, "a", "acceptance.json")).toMatchObject({ model: "q/two" });
  });
});
