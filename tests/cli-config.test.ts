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
