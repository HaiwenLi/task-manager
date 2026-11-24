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

  it("rejects unknown fields", () => {
    expect(() => resolveConfig({ nope: 1 }, "taskctl.json")).toThrow(/unknown field/);
  });

  it("still only accepts the opencode agent", () => {
    expect(() => resolveConfig({ agent: "kimi" }, "taskctl.json")).toThrow(/unknown agent/);
  });
});
