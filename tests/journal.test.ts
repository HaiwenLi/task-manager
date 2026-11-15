import { describe, expect, it } from "vitest";
import { appendJournal, journalTail } from "../src/journal.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("journal", () => {
  it("appends one line per event and tails the last n", async () => {
    const dir = await mkdtemp(join(tmpdir(), "taskctl-journal-"));
    await appendJournal(dir, "001-a", { stage: "clarify", event: "spec-drafted", detail: "criteria=2" });
    await appendJournal(dir, "001-a", { stage: "review", event: "verdict", detail: "fail" });
    const tail = await journalTail(dir, "001-a", 1);
    expect(tail).toHaveLength(1);
    expect(tail[0]).toMatch(/review\s+verdict\s+fail$/);
    expect(await journalTail(dir, "002-missing", 5)).toEqual([]);
  });

  it("keeps UTF-8 detail intact and never lets a newline break the line format", async () => {
    const dir = await mkdtemp(join(tmpdir(), "taskctl-journal-"));
    await appendJournal(dir, "001-a", { stage: "worker", event: "note", detail: "导出按钮宽度写死\n第二行" });
    const [line] = await journalTail(dir, "001-a", 1);
    expect(line).toContain("导出按钮宽度写死");
    expect(line).not.toContain("\n");
  });
});
