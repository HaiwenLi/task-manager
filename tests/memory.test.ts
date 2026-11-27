import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { callTools, McpClientError, type McpServerOptions } from "../src/mcp-client.js";
import {
  buildRecallQuery,
  createMempalaceBackend,
  renderMemory,
  runRecall,
  selectHits,
  type MemoryBackend,
  type MemoryConfig,
  type MemoryHit,
  type RecallIo,
} from "../src/memory.js";

const cfg: MemoryConfig = { command: ["x"], excludeWings: ["dify_deploy"], rooms: ["pitfall", "pattern", "decision"], minSimilarity: 0.55, maxItems: 5, maxChars: 2_000, itemChars: 400, timeoutMs: 20_000 };
const hit = (drawerId: string, similarity: number, wing = "w", room = "pitfall", text = "t") => ({ drawerId, similarity, wing, room, text });
const input = { title: "t", description: "d", spec: null, at: "2026-11-25T00:00:00.000Z" };
const fakeBackend = (groups: MemoryHit[][]): MemoryBackend => ({ name: "fake", searchAll: async () => groups });
let io: { write: Mock<RecallIo["write"]>; journal: Mock<RecallIo["journal"]> };
beforeEach(() => { io = { write: vi.fn<RecallIo["write"]>(), journal: vi.fn<RecallIo["journal"]>() }; });

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

  it("renders a hit with line breaks on one line", () => {
    expect(renderMemory([hit("a", 0.9, "w", "pitfall", "line one\nline two")], cfg).text).toBe("- [w/pitfall · -] line one line two");
  });

  it("cuts a hit to itemChars only after its line breaks were collapsed", () => {
    // 900 characters as written, 899 once each line break is a space: the cut measures the latter.
    const { text, truncated } = renderMemory([hit("a", 0.9, "w", "pitfall", "ab\n".repeat(300))], cfg);
    expect(text).toBe(`- [w/pitfall · -] ${"ab ".repeat(133)}a…`);
    expect(truncated).toBe(true);
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

  it("a recall backend is insulated only when its caller asks for it", async () => {
    const seen: McpServerOptions[] = [];
    const call: typeof callTools = async (options) => { seen.push(options); return [{ text: "{\"results\":[]}", isError: false }]; };
    // Without the third argument — what `taskctl recall` builds — today's spawn: the server options name no insulation.
    await createMempalaceBackend(cfg, call).searchAll([{ query: "q" }], { limit: 20 });
    expect(seen[0]?.insulated).toBeUndefined();
    // An attempt with a stop source (Task 6) asks through the third argument.
    await createMempalaceBackend(cfg, call, true).searchAll([{ query: "q" }], { limit: 20 });
    expect(seen[1]?.insulated).toBe(true);
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

  it("asks the backend once, with the request list and the limit the plan names", async () => {
    const searchAll = vi.fn(async () => [[hit("a", 0.6, "w", "pitfall", "LESSON TEXT")]]);

    // A wing adds a second search, narrowed to it, in the same session; the limit is four per item at least.
    expect(await runRecall({ ...cfg, wing: "IDT", maxItems: 7 }, { name: "fake", searchAll }, input, io)).toContain("LESSON TEXT");
    expect(searchAll).toHaveBeenCalledTimes(1);
    expect(searchAll).toHaveBeenCalledWith([{ query: "t d" }, { query: "t d", wing: "IDT" }], { limit: 28 });
    // Without a wing there is the one search, and the limit never drops below 20.
    searchAll.mockClear();
    await runRecall(cfg, { name: "fake", searchAll }, input, io);
    expect(searchAll).toHaveBeenCalledTimes(1);
    expect(searchAll).toHaveBeenCalledWith([{ query: "t d" }], { limit: 20 });
  });

  it("writes the record and the journal line in the plan's format", async () => {
    await runRecall({ ...cfg, wing: "IDT", maxItems: 7 }, fakeBackend([[hit("a", 0.6, "w", "pitfall", "LESSON TEXT")]]), input, io);

    // What the owner can look at afterwards: what was asked, when, what was kept and what was dropped; never a text.
    expect(io.write).toHaveBeenCalledTimes(1);
    expect(io.write).toHaveBeenCalledWith({
      query: "t d", backend: "fake", at: input.at, outcome: "ok",
      hits: [{ drawerId: "a", wing: "w", room: "pitfall", similarity: 0.6, chars: 11 }],
      filtered: { belowThreshold: 0, room: 0, wing: 0 }, truncated: false,
    });
    expect(io.journal).toHaveBeenCalledTimes(1);
    expect(io.journal).toHaveBeenCalledWith("recall", "outcome=ok hits=1 below=0 room=0 wing=0 truncated=false backend=fake");
  });

  it("keeps the first 200 characters of a failure's message in the record and in the journal", async () => {
    const message = "0123456789".repeat(30);
    const backend: MemoryBackend = { name: "fake", searchAll: async () => { throw new Error(message); } };

    expect(await runRecall(cfg, backend, input, io)).toBeNull();
    const kept = "0123456789".repeat(20);
    expect(io.write).toHaveBeenCalledTimes(1);
    expect(io.write).toHaveBeenCalledWith({
      query: "t d", backend: "fake", at: input.at, outcome: "error",
      hits: [], filtered: { belowThreshold: 0, room: 0, wing: 0 }, truncated: false, detail: kept,
    });
    expect(io.journal).toHaveBeenCalledTimes(1);
    // The same line as for a recall that worked, then the reason, cut to the same 200 characters.
    expect(io.journal).toHaveBeenCalledWith(
      "recall-unavailable",
      "outcome=error hits=0 below=0 room=0 wing=0 truncated=false backend=fake error=" + kept,
    );
  });

  it("counts a hit's characters as it was written, line breaks included", async () => {
    // The prompt shows the hit on one line; the record says how long the drawer's text really is.
    const text = await runRecall(cfg, fakeBackend([[hit("a", 0.6, "w", "pitfall", "line one\nline two")]]), input, io);
    expect(text).toBe("- [w/pitfall · -] line one line two");
    expect(io.write).toHaveBeenCalledWith(expect.objectContaining({ hits: [{ drawerId: "a", wing: "w", room: "pitfall", similarity: 0.6, chars: 17 }] }));
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
