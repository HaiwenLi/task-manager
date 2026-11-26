import { callTools, McpClientError } from "./mcp-client.js";

/**
 * One thing the memory holds, as a backend reports it: where it is filed, how
 * closely it matches, and its text, verbatim.
 */
export type MemoryHit = { drawerId: string; wing: string; room: string; similarity: number; text: string; filedAt?: string };

/** Where recall searches: each request once, answered with its own group of hits. */
export type MemoryBackend = {
  readonly name: string;
  searchAll(requests: readonly { query: string; wing?: string }[], opts: { limit: number }): Promise<MemoryHit[][]>;
};

/** The memory settings, for whichever backend is on. */
export type MemoryConfig = {
  command: string[]; wing?: string; excludeWings: string[]; rooms: string[];
  minSimilarity: number; maxItems: number; maxChars: number; itemChars: number; timeoutMs: number;
};
/** What the resolved configuration holds: the backend switch plus the settings. */
export type MemorySettings = MemoryConfig & { backend: "none" | "mempalace" };
/** How a recall went: something was kept, nothing was, or the backend could not answer in time or at all. */
export type RecallOutcome = "ok" | "no-hits" | "timeout" | "error";
/** What is kept of a recall for the owner to look at: what was asked, what was kept, what was dropped; never a text. */
export type RecallRecord = {
  query: string; backend: string; at: string; outcome: RecallOutcome;
  hits: Array<{ drawerId: string; wing: string; room: string; similarity: number; chars: number }>;
  filtered: { belowThreshold: number; room: number; wing: number };
  truncated: boolean; detail?: string;
};
/** What a recall is made of: the task's own words, and when it ran. */
export type RecallInput = { title: string; description: string; spec: string | null; at: string };
/** Where a recall leaves its trace: the record file and the journal line. */
export type RecallIo = {
  write: (record: RecallRecord) => Promise<void>;
  journal: (event: string, detail: string) => Promise<void>;
};

/** The tool MemPalace searches with. */
const SEARCH_TOOL = "mempalace_search";
/** Longest recall query, in characters. */
const QUERY_MAX_CHARS = 250;
/** How much of the description, and of the spec's goal, goes into the query. */
const QUERY_PART_CHARS = 120;
/** Longest error message kept in the record and in the journal. */
const DETAIL_MAX_CHARS = 200;

/**
 * The query a recall searches with: the title whole, then the first
 * {@link QUERY_PART_CHARS} of the description, then as much of the spec's
 * `## 目标` part, each with its whitespace collapsed to single spaces; empty
 * parts are left out. What is joined with single spaces is cut to
 * {@link QUERY_MAX_CHARS}.
 */
export function buildRecallQuery(input: Pick<RecallInput, "title" | "description" | "spec">): string {
  const lead = (text: string): string => oneLine(text).slice(0, QUERY_PART_CHARS);
  const parts = [oneLine(input.title), lead(input.description), lead(goalOf(input.spec))]
    .filter((part) => part.length > 0);
  return parts.join(" ").slice(0, QUERY_MAX_CHARS);
}

/**
 * The hits that go into the prompt, best first, out of everything the
 * searches brought back. A hit is dropped when its similarity is below
 * `minSimilarity`, its room is not one of `rooms`, or its wing is in
 * `excludeWings`; each dropped hit counts once, under the first rule that
 * dropped it. What survives is reduced to one hit per drawer, the most
 * similar one, sorted by similarity and cut to `maxItems`.
 */
export function selectHits(
  groups: readonly MemoryHit[][],
  cfg: Pick<MemoryConfig, "minSimilarity" | "rooms" | "excludeWings" | "maxItems">,
): { kept: MemoryHit[]; filtered: RecallRecord["filtered"] } {
  const filtered = { belowThreshold: 0, room: 0, wing: 0 };
  const rooms = new Set(cfg.rooms);
  const excludeWings = new Set(cfg.excludeWings);
  const best = new Map<string, MemoryHit>();
  for (const hit of groups.flat()) {
    if (!(hit.similarity >= cfg.minSimilarity)) {
      filtered.belowThreshold += 1;
      continue;
    }
    if (!rooms.has(hit.room)) {
      filtered.room += 1;
      continue;
    }
    if (excludeWings.has(hit.wing)) {
      filtered.wing += 1;
      continue;
    }
    const seen = best.get(hit.drawerId);
    if (seen === undefined || hit.similarity > seen.similarity) best.set(hit.drawerId, hit);
  }
  const kept = [...best.values()].sort((a, b) => b.similarity - a.similarity).slice(0, cfg.maxItems);
  return { kept, filtered };
}

/**
 * The hits as the lines the prompt shows: `- [wing/room · date] text`, one
 * per hit, the date being the day of `filedAt` or `-`. A text is put on one
 * line first, whatever line breaks the drawer holds, and is then cut to
 * `itemChars` and marked with `…` when it is longer. Lines are added while
 * the whole stays within `maxChars`; `truncated` says a hit was left out or
 * cut.
 */
export function renderMemory(hits: readonly MemoryHit[], cfg: Pick<MemoryConfig, "maxChars" | "itemChars">): { text: string; truncated: boolean } {
  const lines: string[] = [];
  let total = 0;
  let truncated = false;
  for (const hit of hits) {
    // Measured as the prompt shows it, so the cut lands on what is seen and a
    // line break can never pass for the start of another hit.
    const text = oneLine(hit.text);
    const cut = text.length > cfg.itemChars;
    const line = `- [${hit.wing}/${hit.room} · ${hit.filedAt === undefined ? "-" : hit.filedAt.slice(0, 10)}] ${cut ? `${text.slice(0, cfg.itemChars)}…` : text}`;
    const withLine = total + (lines.length === 0 ? 0 : 1) + line.length;
    if (withLine > cfg.maxChars) {
      truncated = true;
      break;
    }
    lines.push(line);
    total = withLine;
    if (cut) truncated = true;
  }
  return { text: lines.join("\n"), truncated };
}

/**
 * MemPalace through its MCP server: one session for all the searches, each a
 * `mempalace_search` call. `max_distance` is the server-side cut-off for the
 * similarity floor; a `wing` narrows a search to that wing.
 *
 * `call` is the stdio client, and a test can put its own in its place.
 * `insulated` starts the server out of the controller's console (D6): a hidden
 * console of its own on Windows, a process group of its own elsewhere. It
 * defaults to false — `taskctl recall` keeps today's spawn, and only an
 * attempt that has a stop source asks for it.
 */
export function createMempalaceBackend(cfg: MemoryConfig, call: typeof callTools = callTools, insulated = false): MemoryBackend {
  const maxDistance = Number((1 - cfg.minSimilarity).toFixed(6));
  return {
    name: "mempalace",
    async searchAll(requests, opts) {
      const replies = await call(
        { command: cfg.command, timeoutMs: cfg.timeoutMs, ...(insulated ? { insulated: true } : {}) },
        requests.map((request) => ({
          name: SEARCH_TOOL,
          arguments: { query: request.query, limit: opts.limit, max_distance: maxDistance, ...(request.wing === undefined ? {} : { wing: request.wing }) },
        })),
      );
      return requests.map((request, index) => hitsOf(replies[index], request));
    },
  };
}

/**
 * Recall once for a task and say what the prompt should show for it: the
 * rendered lines when something was kept, `null` in every other case. With
 * the configuration or the backend missing, memory is off: `null`, and no
 * record and no journal line.
 *
 * A search that fails is recorded and costs the task nothing: this never
 * throws, not even when the record or the journal line cannot be written.
 */
export async function runRecall(cfg: MemoryConfig | undefined, backend: MemoryBackend | undefined, input: RecallInput, io: RecallIo): Promise<string | null> {
  if (cfg === undefined || backend === undefined) return null;

  const query = buildRecallQuery(input);
  const record: RecallRecord = {
    query, backend: backend.name, at: input.at, outcome: "no-hits",
    hits: [], filtered: { belowThreshold: 0, room: 0, wing: 0 }, truncated: false,
  };
  let text: string | null = null;
  try {
    // A wing adds a second search, narrowed to it; the global one stays.
    const wing = cfg.wing === undefined || cfg.wing === "" ? undefined : cfg.wing;
    const groups = await backend.searchAll(
      [{ query }, ...(wing === undefined ? [] : [{ query, wing }])],
      { limit: Math.max(20, cfg.maxItems * 4) },
    );
    const { kept, filtered } = selectHits(groups, cfg);
    const rendered = renderMemory(kept, cfg);
    record.filtered = filtered;
    record.truncated = rendered.truncated;
    record.hits = kept.map((hit) => ({
      drawerId: hit.drawerId, wing: hit.wing, room: hit.room, similarity: hit.similarity, chars: hit.text.length,
    }));
    record.outcome = kept.length > 0 ? "ok" : "no-hits";
    text = kept.length > 0 ? rendered.text : null;
  } catch (err) {
    record.outcome = err instanceof McpClientError && err.code === "timeout" ? "timeout" : "error";
    record.detail = (err instanceof Error ? err.message : String(err)).slice(0, DETAIL_MAX_CHARS);
  }

  const detail = `outcome=${record.outcome} hits=${record.hits.length} below=${record.filtered.belowThreshold}`
    + ` room=${record.filtered.room} wing=${record.filtered.wing} truncated=${record.truncated} backend=${record.backend}`;
  const event = record.outcome === "ok" || record.outcome === "no-hits" ? "recall" : "recall-unavailable";
  try {
    await io.write(record);
  } catch {
    // The record is lost; the recall itself stands.
  }
  try {
    await io.journal(event, record.detail === undefined ? detail : `${detail} error=${record.detail}`);
  } catch {
    // The journal is lost too; there is nowhere left to say so.
  }
  return text;
}

/** The text under the spec's `## 目标` heading, up to the next heading; empty when the spec has none. */
function goalOf(spec: string | null): string {
  if (spec === null) return "";
  const lines = spec.split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s*目标\s*$/.test(line.trim()));
  if (start === -1) return "";
  const end = lines.findIndex((line, index) => index > start && line.trimStart().startsWith("##"));
  return lines.slice(start + 1, end === -1 ? undefined : end).join("\n");
}

/** A text on one line: every run of whitespace a single space, nothing at either end. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * The hits in one `mempalace_search` reply. An entry without a drawer id or
 * a text, or without a finite similarity, is not a hit. A reply that is an
 * error, or not JSON, throws.
 *
 * What the server wrote stays out of the messages: they reach the journal,
 * and a tool's error text can carry anything, a provider's refusal of a key
 * included.
 */
function hitsOf(reply: { text: string; isError: boolean } | undefined, request: { query: string; wing?: string }): MemoryHit[] {
  if (reply === undefined) throw new Error(`${SEARCH_TOOL} gave no answer${request.wing === undefined ? "" : ` for wing ${request.wing}`}`);
  if (reply.isError) throw new Error(`${SEARCH_TOOL} reported a tool error`);
  let results: unknown;
  try {
    results = (JSON.parse(reply.text) as { results?: unknown } | null)?.results;
  } catch {
    throw new Error(`${SEARCH_TOOL} answered with text that is not JSON`);
  }
  if (!Array.isArray(results)) throw new Error(`${SEARCH_TOOL} answered without a results list`);
  const hits: MemoryHit[] = [];
  for (const entry of results) {
    if (typeof entry !== "object" || entry === null) continue;
    const { drawer_id: drawerId, text, similarity, wing, room, filed_at: filedAt } = entry as Record<string, unknown>;
    if (typeof drawerId !== "string" || typeof text !== "string" || typeof similarity !== "number" || !Number.isFinite(similarity)) continue;
    hits.push({
      drawerId, text, similarity,
      wing: typeof wing === "string" ? wing : "",
      room: typeof room === "string" ? room : "",
      ...(typeof filedAt === "string" ? { filedAt } : {}),
    });
  }
  return hits;
}
