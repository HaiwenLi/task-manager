import { beforeEach, describe, expect, it, vi } from "vitest";
import { callTools, McpClientError } from "../src/mcp-client.js";
import {
  buildRecallQuery,
  createMempalaceBackend,
  renderMemory,
  runRecall,
  selectHits,
  type MemoryBackend,
  type MemoryConfig,
  type MemoryHit,
} from "../src/memory.js";

const cfg: MemoryConfig = { command: ["x"], excludeWings: ["dify_deploy"], rooms: ["pitfall", "pattern", "decision"], minSimilarity: 0.55, maxItems: 5, maxChars: 2_000, itemChars: 400, timeoutMs: 20_000 };
const hit = (drawerId: string, similarity: number, wing = "w", room = "pitfall", text = "t") => ({ drawerId, similarity, wing, room, text });
const input = { title: "t", description: "d", spec: null, at: "2026-11-25T00:00:00.000Z" };
const fakeBackend = (groups: MemoryHit[][]): MemoryBackend => ({ name: "fake", searchAll: async () => groups });
let io: { write: ReturnType<typeof vi.fn>; journal: ReturnType<typeof vi.fn> };
beforeEach(() => { io = { write: vi.fn(), journal: vi.fn() }; });

describe("memory layer", () => {
  it("keeps a hit at the threshold and drops one below it", () => {
    const { kept, filtered } = selectHits([[hit("a", 0.55), hit("b", 0.5499)]], cfg);
    expect(kept.map((h) => h.drawerId)).toEqual(["a"]);
    expect(filtered.belowThreshold).toBe(1);
  });

  it("drops other rooms and excluded wings", () => {
    const { kept, filtered } = selectHits([[hit("a", 0.9, "w", "diary"), hit("b", 0.9, "dify_deploy"), hit("c", 0.6, "w", "decision")]], cfg);
    expect(kept.map((h) => h.drawerId)).toEqual(["c"]);
    expect(filtered).toEqual({ belowThreshold: 0, room: 1, wing: 1 });
  });

  it("dedupes across the global and wing searches and sorts by similarity", () => {
    const { kept } = selectHits([[hit("a", 0.6), hit("b", 0.7)], [hit("a", 0.65), hit("c", 0.9)]], cfg);
    expect(kept.map((h) => [h.drawerId, h.similarity])).toEqual([["c", 0.9], ["b", 0.7], ["a", 0.65]]);
  });

  it("renders one sourced line per hit within the limits", () => {
    const { text, truncated } = renderMemory([hit("a", 0.9, "w", "pitfall", "x".repeat(500))], cfg);
    expect(text.split("\n")).toHaveLength(1);
    expect(text).toMatch(/^- \[w\/pitfall · -\] x{400}…$/);
    expect(truncated).toBe(true);
    const many = renderMemory(Array.from({ length: 5 }, (_, i) => hit(String(i), 0.9, "w", "pitfall", "y".repeat(400))), cfg);
    expect(many.text.length).toBeLessThanOrEqual(2_010);
    expect(many.text.split("\n").length).toBeLessThan(5);
  });

  it("builds a whitespace-normalised query of at most 250 characters", () => {
    const query = buildRecallQuery({ title: "T", description: "d".repeat(300), spec: "## 目标\n" + "g".repeat(300) + "\n## 非目标\nx" });
    expect(query.length).toBe(243);   // 1 + 1 + 120 + 1 + 120: under the cut, nothing to trim
    expect(buildRecallQuery({ title: "t".repeat(300), description: "", spec: null })).toHaveLength(250);
    expect(query.startsWith("T ddd")).toBe(true);
    expect(buildRecallQuery({ title: "a\n\nb", description: "", spec: null })).toBe("a b");
  });

  it("passes the distance cut-off and the wing to the server in one session", async () => {
    const seen: unknown[] = [];
    const reply = (results: unknown[]) => ({ text: JSON.stringify({ results }), isError: false });
    const call: typeof callTools = async (options, calls) => { seen.push({ options, calls }); return calls.map(() => reply([{ drawer_id: "d1", wing: "w", room: "pitfall", similarity: 0.6, text: "hello", filed_at: "2026-11-11T00:00:00" }])); };
    const backend = createMempalaceBackend({ ...cfg, wing: "IDT" }, call);
    const groups = await backend.searchAll([{ query: "q" }, { query: "q", wing: "IDT" }], { limit: 20 });
    expect((seen[0] as { calls: unknown[] }).calls).toEqual([
      { name: "mempalace_search", arguments: { query: "q", limit: 20, max_distance: 0.45 } },
      { name: "mempalace_search", arguments: { query: "q", limit: 20, max_distance: 0.45, wing: "IDT" } },
    ]);
    expect(groups[0][0]).toEqual({ drawerId: "d1", wing: "w", room: "pitfall", similarity: 0.6, text: "hello", filedAt: "2026-11-11T00:00:00" });
  });

  it("returns null and touches nothing when memory is off", async () => {
    const io = { write: vi.fn(), journal: vi.fn() };
    expect(await runRecall(undefined, fakeBackend([]), input, io)).toBeNull();
    expect(await runRecall(cfg, undefined, input, io)).toBeNull();
    expect(io.write).not.toHaveBeenCalled();
    expect(io.journal).not.toHaveBeenCalled();
  });

  it("writes the record and the journal line, and returns the section", async () => {
    const backend = fakeBackend([[hit("a", 0.6, "w", "pitfall", "LESSON TEXT")]]);
    const text = await runRecall(cfg, backend, input, io);
    expect(text).toContain("LESSON TEXT");
    expect(io.write).toHaveBeenCalledWith(expect.objectContaining({ outcome: "ok", hits: [expect.objectContaining({ drawerId: "a", chars: 11 })], backend: "fake" }));
    expect(io.journal).toHaveBeenCalledWith("recall", expect.stringMatching(/^outcome=ok hits=1 /));
  });

  it("returns null and records the outcome when the result is not JSON", async () => {
    const call: typeof callTools = async () => [{ text: "<not json>", isError: false }];
    const text = await runRecall(cfg, createMempalaceBackend(cfg, call), input, io);
    expect(text).toBeNull();
    expect(io.write).toHaveBeenCalledWith(expect.objectContaining({ outcome: "error" }));
    expect(io.journal).toHaveBeenCalledWith("recall-unavailable", expect.stringMatching(/^outcome=error /));
  });

  it("records a timeout without throwing", async () => {
    const backend: MemoryBackend = { name: "fake", searchAll: async () => { throw new McpClientError("mcp: timed out", "timeout"); } };
    expect(await runRecall(cfg, backend, input, io)).toBeNull();
    expect(io.journal).toHaveBeenCalledWith("recall-unavailable", expect.stringMatching(/^outcome=timeout /));
  });

  it("survives a journal that cannot be written", async () => {
    const text = await runRecall(cfg, fakeBackend([[hit("a", 0.6, "w", "pitfall", "KEPT")]]), input, { write: async () => {}, journal: async () => { throw new Error("disk full"); } });
    expect(text).toContain("KEPT");
  });
});
