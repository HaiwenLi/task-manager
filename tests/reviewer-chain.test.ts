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
