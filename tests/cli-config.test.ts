import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/cli.js";

describe("resolveConfig", () => {
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

  it("rejects unknown fields", () => {
    expect(() => resolveConfig({ nope: 1 }, "taskctl.json")).toThrow(/unknown field/);
  });

  it("still only accepts the opencode agent", () => {
    expect(() => resolveConfig({ agent: "kimi" }, "taskctl.json")).toThrow(/unknown agent/);
  });
});
