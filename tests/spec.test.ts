import { describe, expect, it } from "vitest";
import { extractCriteria, readSpec, writeSpec } from "../src/spec.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("extractCriteria", () => {
  it("extracts numbered criteria from the acceptance section in order", () => {
    const spec = "## 目标\n好\n## 验收标准\n- C1 npm test 全绿\n- C2 401 时文案正确\n## 边界\n无";
    expect(extractCriteria(spec)).toEqual(["C1 npm test 全绿", "C2 401 时文案正确"]);
  });

  it("accepts asterisk bullets and a heading at end of file", () => {
    expect(extractCriteria("## 验收标准\n* C1 甲\n* C2 乙")).toEqual(["C1 甲", "C2 乙"]);
  });

  it("throws when the acceptance section has no numbered item", () => {
    expect(() => extractCriteria("## 目标\n好\n## 验收标准\n大概能用就行")).toThrow(/至少一条/);
  });

  it("throws when the acceptance section is missing entirely", () => {
    expect(() => extractCriteria("## 目标\n好")).toThrow(/至少一条/);
  });
});

describe("spec files", () => {
  it("write then read round-trips, and a missing spec reads as null", async () => {
    const dir = await mkdtemp(join(tmpdir(), "taskctl-spec-"));
    await writeSpec(dir, "001-a", "## 目标\n好");
    expect(await readSpec(dir, "001-a")).toContain("## 目标");
    expect(await readSpec(dir, "002-b")).toBeNull();
  });
});
