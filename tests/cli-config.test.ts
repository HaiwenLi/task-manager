import { describe, expect, it } from "vitest";
import { CONFIG_KEYS, resolveConfig } from "../src/cli.js";

describe("resolveConfig", () => {
  it("resolves only fields it also accepts (the allowlist and the parser never drift apart)", () => {
    // A key that is parsed but missing from the allowlist makes every command
    // refuse the config that carries it, which is how `chainCycles` first
    // shipped: 406 tests green, and `taskctl retry --config` dead on arrival.
    const resolved = Object.keys(resolveConfig({}, "taskctl.json"));
    expect(resolved.filter((key) => !CONFIG_KEYS.has(key))).toEqual([]);
  });

  it("accepts a positive shared model cooldown", () => {
    expect(resolveConfig({ modelCooldownMs: 900_000 }, "taskctl.json").modelCooldownMs).toBe(900_000);
    expect(resolveConfig({}, "taskctl.json").modelCooldownMs).toBeUndefined();
    expect(() => resolveConfig({ modelCooldownMs: 0 }, "taskctl.json")).toThrow(/positive/);
  });

  it("accepts a wrap budget for the model chain, zero included", () => {
    expect(resolveConfig({ chainCycles: 2 }, "taskctl.json").chainCycles).toBe(2);
    // 0 is the documented "linear chain" setting, not a missing value.
    expect(resolveConfig({ chainCycles: 0 }, "taskctl.json").chainCycles).toBe(0);
    expect(resolveConfig({}, "taskctl.json").chainCycles).toBeUndefined();
  });

  it("rejects a wrap budget that is negative or not an integer", () => {
    expect(() => resolveConfig({ chainCycles: -1 }, "taskctl.json")).toThrow(/non-negative integer/);
    expect(() => resolveConfig({ chainCycles: 1.5 }, "taskctl.json")).toThrow(/non-negative integer/);
    expect(() => resolveConfig({ chainCycles: "2" }, "taskctl.json")).toThrow(/non-negative integer/);
  });
  it("accepts the pipeline keys", () => {
    const cfg = resolveConfig({ parallel: 3, maxReviewRounds: 1, reviewerModel: "x/y", reviewerEffort: "high" }, "taskctl.json");
    expect(cfg.parallel).toBe(3);
    expect(cfg.maxReviewRounds).toBe(1);
    expect(cfg.reviewerModel).toBe("x/y");
    expect(cfg.reviewerEffort).toBe("high");
  });

  it("leaves the pipeline keys undefined so worker defaults apply", () => {
    const cfg = resolveConfig({}, "taskctl.json");
    expect(cfg.parallel).toBeUndefined();
    expect(cfg.maxReviewRounds).toBeUndefined();
  });

  it("accepts a model fallback chain for each role", () => {
    const cfg = resolveConfig({
      model: "a/one",
      modelFallbacks: ["b/two", "c/three"],
      reviewerModel: "r/one",
      reviewerModelFallbacks: ["r/two"],
    }, "taskctl.json");
    expect(cfg.modelFallbacks).toEqual(["b/two", "c/three"]);
    expect(cfg.reviewerModelFallbacks).toEqual(["r/two"]);
  });

  it("accepts an artifactIgnore pattern list and leaves it undefined when absent", () => {
    const cfg = resolveConfig({ artifactIgnore: ["reports/*.json", "timing/**"] }, "taskctl.json");
    expect(cfg.artifactIgnore).toEqual(["reports/*.json", "timing/**"]);
    expect(resolveConfig({}, "taskctl.json").artifactIgnore).toBeUndefined();
  });

  it("rejects artifactIgnore entries that are not non-empty strings", () => {
    expect(() => resolveConfig({ artifactIgnore: "reports" }, "taskctl.json")).toThrow(/array of non-empty strings/);
    expect(() => resolveConfig({ artifactIgnore: [""] }, "taskctl.json")).toThrow(/array of non-empty strings/);
  });

  it("rejects fallback lists that are not non-empty strings", () => {
    expect(() => resolveConfig({ modelFallbacks: "b/two" }, "taskctl.json")).toThrow(/array of non-empty strings/);
    expect(() => resolveConfig({ modelFallbacks: [""] }, "taskctl.json")).toThrow(/array of non-empty strings/);
    expect(() => resolveConfig({ reviewerModelFallbacks: [1] }, "taskctl.json")).toThrow(/array of non-empty strings/);
  });

  it("accepts a dispatch chain and a failure-fingerprint limit", () => {
    const cfg = resolveConfig({
      model: "a/one",
      modelChain: ["a/one", "b/two", "c/three"],
      failureFingerprintLimit: 2,
    }, "taskctl.json");
    expect(cfg.modelChain).toEqual(["a/one", "b/two", "c/three"]);
    expect(cfg.failureFingerprintLimit).toBe(2);
    // Absent stays absent: the worker's own default (3) then applies.
    expect(resolveConfig({}, "taskctl.json").failureFingerprintLimit).toBeUndefined();
  });

  it("rejects a malformed dispatch chain", () => {
    expect(() => resolveConfig({ modelChain: "a/one" }, "taskctl.json")).toThrow(/array of non-empty strings/);
    expect(() => resolveConfig({ modelChain: ["a/one", ""] }, "taskctl.json")).toThrow(/array of non-empty strings/);
  });

  it("rejects a non-positive parallel count", () => {
    expect(() => resolveConfig({ parallel: 0 }, "taskctl.json")).toThrow(/positive/);
  });

  it("resolves the artifacts block with the confirmed defaults", () => {
    expect(resolveConfig({}, "taskctl.json").artifacts).toEqual({
      sweep: true,
      scratchPatterns: ["*.log", "*.tmp", "_*", "*.sha", "*.txt"],
    });
    expect(resolveConfig({ artifacts: { sweep: false } }, "taskctl.json").artifacts).toEqual({
      sweep: false,
      scratchPatterns: ["*.log", "*.tmp", "_*", "*.sha", "*.txt"],
    });
    expect(resolveConfig({ artifacts: { scratchPatterns: ["*.csv"] } }, "taskctl.json").artifacts).toEqual({
      sweep: true,
      scratchPatterns: ["*.csv"],
    });
  });

  it("rejects malformed artifacts blocks", () => {
    expect(() => resolveConfig({ artifacts: "nope" }, "taskctl.json")).toThrow(/artifacts/);
    expect(() => resolveConfig({ artifacts: { sweep: "false" } }, "taskctl.json")).toThrow(/sweep.*boolean/);
    expect(() => resolveConfig({ artifacts: { scratchPatterns: "x" } }, "taskctl.json")).toThrow(/scratchPatterns/);
    expect(() => resolveConfig({ artifacts: { unknown: true } }, "taskctl.json")).toThrow(/unknown artifacts field/);
  });

  it("resolves batchMaxTasks with a default of five and one as the grouping opt-out", () => {
    expect(resolveConfig({}, "taskctl.json").batchMaxTasks).toBe(5);
    expect(resolveConfig({ batchMaxTasks: 1 }, "taskctl.json").batchMaxTasks).toBe(1);
    expect(resolveConfig({ batchMaxTasks: 2 }, "taskctl.json").batchMaxTasks).toBe(2);
    expect(() => resolveConfig({ batchMaxTasks: 0 }, "taskctl.json")).toThrow(/positive/);
    expect(() => resolveConfig({ batchMaxTasks: 1.5 }, "taskctl.json")).toThrow(/integer/);
    expect(() => resolveConfig({ batchMaxTasks: "2" }, "taskctl.json")).toThrow(/positive/);
  });

  it("rejects unknown fields", () => {
    expect(() => resolveConfig({ nope: 1 }, "taskctl.json")).toThrow(/unknown field/);
  });

  it("still only accepts the opencode agent", () => {
    expect(() => resolveConfig({ agent: "kimi" }, "taskctl.json")).toThrow(/unknown agent/);
  });

  it("accepts workerContext switches and fills the absent ones", () => {
    // Absent stays absent: the worker's own default (both on) then applies.
    expect(resolveConfig({}, "taskctl.json").workerContext).toBeUndefined();
    expect(resolveConfig({ workerContext: {} }, "taskctl.json").workerContext).toEqual({ spec: true, preferences: true });
    expect(resolveConfig({ workerContext: { spec: false } }, "taskctl.json").workerContext).toEqual({ spec: false, preferences: true });
    expect(resolveConfig({ workerContext: { preferences: false } }, "taskctl.json").workerContext).toEqual({ spec: true, preferences: false });
    expect(resolveConfig({ workerContext: { spec: false, preferences: false } }, "taskctl.json").workerContext).toEqual({ spec: false, preferences: false });
  });

  it("rejects a workerContext that is not an object of booleans", () => {
    expect(() => resolveConfig({ workerContext: "no" }, "taskctl.json")).toThrow(/workerContext/);
    expect(() => resolveConfig({ workerContext: null }, "taskctl.json")).toThrow(/workerContext/);
    expect(() => resolveConfig({ workerContext: [] }, "taskctl.json")).toThrow(/workerContext/);
    expect(() => resolveConfig({ workerContext: { spec: "yes" } }, "taskctl.json")).toThrow(/workerContext/);
    expect(() => resolveConfig({ workerContext: { spec: null } }, "taskctl.json")).toThrow(/workerContext/);
    expect(() => resolveConfig({ workerContext: { other: true } }, "taskctl.json")).toThrow(/workerContext/);
  });

  it("memory is off until a backend is named, and the settings have defaults", () => {
    // Absent stays absent: no memory block, nothing to resolve.
    expect(resolveConfig({}, "taskctl.json").memory).toBeUndefined();
    // A block that names no backend is off, and still has every setting.
    expect(resolveConfig({ memory: {} }, "taskctl.json").memory).toMatchObject({ backend: "none" });
    expect(resolveConfig({ memory: {} }, "taskctl.json").memory).toEqual({
      backend: "none", command: ["mempalace-mcp"], excludeWings: [], rooms: ["pitfall", "pattern", "decision"],
      minSimilarity: 0.55, maxItems: 5, maxChars: 2000, itemChars: 400, timeoutMs: 20000,
    });
    expect(resolveConfig({ memory: { backend: "mempalace" } }, "taskctl.json").memory).toEqual({
      backend: "mempalace", command: ["mempalace-mcp"], excludeWings: [], rooms: ["pitfall", "pattern", "decision"],
      minSimilarity: 0.55, maxItems: 5, maxChars: 2000, itemChars: 400, timeoutMs: 20000,
    });
    expect(resolveConfig({ memory: { minSimilarity: 0, wing: "IDT" } }, "taskctl.json").memory).toMatchObject({ minSimilarity: 0, wing: "IDT" });
  });

  it("keeps each memory setting as written, and a wing only when one is named", () => {
    // 0 and 1 are both ends of the similarity range, so both are settings rather than omissions.
    expect(resolveConfig({ memory: { backend: "mempalace", minSimilarity: 1 } }, "taskctl.json").memory).toMatchObject({ minSimilarity: 1 });
    expect(resolveConfig({ memory: { minSimilarity: 0 } }, "taskctl.json").memory).not.toHaveProperty("wing");
    expect(resolveConfig({
      memory: {
        backend: "mempalace", command: ["node", "server.mjs"], wing: "IDT", excludeWings: ["dify_deploy"], rooms: ["pitfall"],
        minSimilarity: 0.6, maxItems: 3, maxChars: 1500, itemChars: 200, timeoutMs: 5000,
      },
    }, "taskctl.json").memory).toEqual({
      backend: "mempalace", command: ["node", "server.mjs"], wing: "IDT", excludeWings: ["dify_deploy"], rooms: ["pitfall"],
      minSimilarity: 0.6, maxItems: 3, maxChars: 1500, itemChars: 200, timeoutMs: 5000,
    });
  });

  it("rejects a memory block it cannot honour", () => {
    expect(() => resolveConfig({ memory: { backend: "not-a-backend" } }, "taskctl.json")).toThrow(/memory/);
    expect(() => resolveConfig({ memory: { other: true } }, "taskctl.json")).toThrow(/memory/);
    expect(() => resolveConfig({ memory: { minSimilarity: 1.5 } }, "taskctl.json")).toThrow(/memory/);
    expect(() => resolveConfig({ memory: { maxItems: 0 } }, "taskctl.json")).toThrow(/memory/);
    expect(() => resolveConfig({ memory: { command: [] } }, "taskctl.json")).toThrow(/memory/);
    // No room allowed means every hit is filtered out: recall would answer "no hits" forever without saying why.
    expect(() => resolveConfig({ memory: { rooms: [] } }, "taskctl.json")).toThrow(/memory/);
  });

  it("rejects every other malformed memory block, naming the setting each time", () => {
    const bad = (memory: unknown) => () => resolveConfig({ memory }, "taskctl.json");
    expect(bad("no")).toThrow(/field "memory" must be an object/);
    expect(bad(null)).toThrow(/field "memory" must be an object/);
    expect(bad([])).toThrow(/field "memory" must be an object/);
    expect(bad({ backend: 1 })).toThrow(/memory\.backend/);
    expect(bad({ command: "mempalace-mcp" })).toThrow(/memory\.command/);
    expect(bad({ command: [""] })).toThrow(/memory\.command/);
    expect(bad({ command: [1] })).toThrow(/memory\.command/);
    expect(bad({ wing: "" })).toThrow(/memory\.wing/);
    expect(bad({ wing: 7 })).toThrow(/memory\.wing/);
    expect(bad({ excludeWings: "dify_deploy" })).toThrow(/memory\.excludeWings/);
    expect(bad({ excludeWings: [""] })).toThrow(/memory\.excludeWings/);
    expect(bad({ rooms: "pitfall" })).toThrow(/memory\.rooms/);
    expect(bad({ rooms: ["pitfall", ""] })).toThrow(/memory\.rooms/);
    expect(bad({ minSimilarity: -0.1 })).toThrow(/memory\.minSimilarity/);
    expect(bad({ minSimilarity: "0.6" })).toThrow(/memory\.minSimilarity/);
    expect(bad({ maxItems: 2.5 })).toThrow(/memory\.maxItems/);
    expect(bad({ maxChars: 0 })).toThrow(/memory\.maxChars/);
    expect(bad({ itemChars: 0 })).toThrow(/memory\.itemChars/);
    expect(bad({ timeoutMs: 0 })).toThrow(/memory\.timeoutMs/);
    expect(bad({ timeoutMs: -1 })).toThrow(/memory\.timeoutMs/);
    expect(bad({ other: true })).toThrow(/unknown memory field "other"/);
  });
});
