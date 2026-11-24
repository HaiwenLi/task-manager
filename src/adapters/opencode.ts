import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { resolve } from "node:path";
import type { AgentAdapter, CatalogueCost, CatalogueModel, SessionReuseStatus, SessionUsageSnapshot } from "./types.js";
import { processExecution, type Execution } from "../execution.js";

/** One prompt() turn — the execution-plane call and its result. */
type PromptArgs = Parameters<AgentAdapter["prompt"]>[0];
type PromptResult = Awaited<ReturnType<AgentAdapter["prompt"]>>;

/** A parsed NDJSON event line from `opencode run --format json`. */
type RunEvent = { sessionID?: unknown; type?: unknown; text?: unknown; part?: unknown; error?: unknown };

/**
 * Backend rejections that mean "this turn never got to do work": quotas, rate
 * limits, auth and 5xx. They are retryable external failures, not evidence that
 * a session is still running.
 *
 * The list is deliberately wide. A refusal that is NOT recognised here does
 * not fail the turn — it makes the execution look uncertain, and an uncertain
 * execution blocks the task instead of rotating to the next model in the
 * chain. That is how one provider hiccup could wedge a whole board
 * (2026-11-23: `provider.no-route`, `provider.rate-limit`).
 */
const PROVIDER_REJECTION = /rate.?limit|quota|usage limit|用量上限|insufficient|unauthorized|\b401\b|\b403\b|\b429\b|\b5\d\d\b|no-route|variant unavailable|model not found|no such model|not_found|forbidden|overloaded|bad gateway|service unavailable|model_not_found/i;

/** A parsed `{"location":…,"data":…}` envelope from `opencode api`. */
type ApiEnvelope = { data?: unknown };

type JsonObject = Record<string, unknown>;

/**
 * What one answered `model.list` holds, built from named fields only: the
 * lookup behind variants and context limits, and the catalogue the budget
 * guard reads.
 */
type ModelListing = {
  /** Keyed by `providerID/id` and by `providerID/modelID`: what the variant and context lookups search. */
  lookup: Map<string, { variants: Set<string>; context?: number }>;
  /** One entry per `providerID/id`, sorted by ref. */
  catalogue: CatalogueModel[];
};

/**
 * The v0.1 agent: OpenCode, driven through its two CLI planes.
 *
 * - Execution plane: `opencode run --format json … --auto <message>` streams
 *   NDJSON event lines (text/reasoning/step_start/tool_use/step_finish/
 *   error); the process exiting marks the turn's end — exit 0 ok, non-zero a
 *   failed turn. A failed turn is a *result*, so prompt resolves
 *   `{exitCode: 1}` rather than rejecting; only a spawn failure (binary
 *   missing) rejects. A turn that dies to a signal has no exit code and is
 *   reported as -1 — non-zero either way, which is all callers test.
 * - Control plane: `opencode api <operation> --param key=value` prints one
 *   JSON object `{"location":…,"data":…}`; `session.get` gives token counts,
 *   `session.message.list` gives the model a session last ran on, and
 *   `model.list` gives per-model context limits.
 *
 * Every child is spawned as an explicit `spawn(file, args)` array with
 * `shell: false` — never a shell string — and every child's stderr is
 * drained (a verbose child would otherwise fill the pipe buffer and hang);
 * failed turns and api rejections carry a capped stderr tail as context —
 * except the two catalogue calls, whose rejections repeat nothing the
 * service printed (`modelCatalog`, `defaultModelRef`).
 * `binArgsPrefix` (used by the test double: `["node", "<script>", …]`) is
 * prepended to every invocation.
 */
export class OpenCodeAdapter implements AgentAdapter {
  private readonly bin: string;
  private readonly binArgsPrefix: string[];
  /**
   * The model listings behind variant/context lookups and the cost catalogue,
   * one per directory the service was asked in (see `modelListing`).
   */
  private readonly modelLists = new Map<string, Promise<ModelListing>>();

  constructor(opts: { bin?: string; binArgsPrefix?: string[] } = {}) {
    this.bin = opts.bin ?? "opencode";
    this.binArgsPrefix = opts.binArgsPrefix ?? [];
  }

  /**
   * The model string to dispatch: an effort is a *variant* the provider must
   * publish. `opencode api model.list` lists the variants per model, so the
   * suffix is added only when it exists — otherwise the provider refuses the
   * turn with `provider.no-route` (2026-11-23: minimax coding plan publishes
   * no variants at all, and `#high` killed the turn in half a second).
   *
   * An unknown model keeps the old behaviour (suffix appended): the provider,
   * not this lookup, is the authority on what it accepts.
   */
  async resolveModel(model: string | undefined, effort: string | undefined): Promise<string | undefined> {
    if (!model) return undefined;
    if (!effort) return model;
    const variants = await this.variantsOf(model);
    if (!variants) return `${model}#${effort}`;
    return variants.has(effort) ? `${model}#${effort}` : model;
  }

  /**
   * The variant ids a model publishes, keyed by `provider/id`. Absent entry
   * means "this model is not in the list" — the caller then keeps its old
   * behaviour instead of guessing.
   */
  private async variantsOf(model: string): Promise<Set<string> | undefined> {
    const catalogue = await this.modelCatalogue();
    const bare = model.includes("/") ? model.slice(model.indexOf("/") + 1) : model;
    for (const [key, entry] of catalogue) {
      const provider = key.includes("/") ? key.slice(0, key.indexOf("/")) : "";
      const id = key.includes("/") ? key.slice(key.indexOf("/") + 1) : key;
      if (`${provider}/${id}`.toLowerCase() === model.toLowerCase() || id.toLowerCase() === bare.toLowerCase()) {
        return entry.variants;
      }
    }
    return undefined;
  }

  /**
   * `opencode api model.list`, asked in `cwd` — the process's own directory
   * when none is given — and kept per directory while it holds an answer: the
   * service finds its configuration from the directory it runs in and answers
   * by it, so one listing does not stand for every directory (2026-11-25: a
   * directory with its own `opencode.json` was answered another default model
   * and another list). A failed fetch, and one that holds no models, is not
   * kept: the `catch` below clears the memo, so the next call asks the service
   * again. A long-lived watcher must neither lose its variant and context
   * lookups for the life of the process nor keep an empty catalogue: on
   * 2026-11-25 one probe of the real service saw no entries where three later
   * probes saw 124 each.
   *
   * Only named fields are read out of an entry. The service's entries carry
   * credentials (`settings.apiKey`, `headers`), so nothing else is kept and
   * nothing else reaches a caller; nor is the text of a failed call, whose
   * stderr can quote the same configuration.
   */
  private modelListing(cwd?: string): Promise<ModelListing> {
    const directory = cwd ?? process.cwd();
    const kept = this.modelLists.get(directory);
    if (kept !== undefined) return kept;
    const fetched = this.catalogueCall("model.list", directory).then((envelope): ModelListing => {
      if (!Array.isArray(envelope?.data) || envelope.data.length === 0) {
        throw new Error("opencode api model.list answered no models");
      }
      const lookup = new Map<string, { variants: Set<string>; context?: number }>();
      const entries = new Map<string, CatalogueModel>();
      for (const entry of envelope.data) {
        const object = asObject(entry);
        const providerID = object?.providerID;
        const id = object?.id;
        const modelID = object?.modelID;
        const variants = Array.isArray(object?.variants)
          ? object.variants.flatMap((variant) => {
              const name = asObject(variant)?.id;
              return typeof name === "string" ? [name] : [];
            })
          : [];
        const rawContext = asObject(object?.limit)?.context;
        const context = typeof rawContext === "number" && Number.isFinite(rawContext) ? rawContext : undefined;
        const names = [id, modelID].filter((name): name is string => typeof name === "string");
        for (const name of names) {
          const key = typeof providerID === "string" ? `${providerID}/${name}` : name;
          if (!lookup.has(key)) lookup.set(key, { variants: new Set(variants), ...(context === undefined ? {} : { context }) });
        }
        // One entry per `providerID/id`: a model the list also names by its
        // upstream name stays one entry, and that name is its `modelID`.
        if (typeof providerID === "string" && typeof id === "string" && !entries.has(`${providerID}/${id}`)) {
          entries.set(`${providerID}/${id}`, {
            ref: `${providerID}/${id}`,
            providerID,
            id,
            modelID: typeof modelID === "string" ? modelID : id,
            variants,
            // Every row must carry two finite numbers, or the entry says nothing about what it costs.
            cost: Array.isArray(object?.cost) ? costOf(object.cost) : [],
            enabled: object?.enabled !== false,
          });
        }
      }
      return { lookup, catalogue: [...entries.values()].sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0)) };
    });
    this.modelLists.set(directory, fetched);
    // Only its own entry: a later fetch for the directory must not be undone by this one settling late.
    void fetched.catch(() => {
      if (this.modelLists.get(directory) === fetched) this.modelLists.delete(directory);
    });
    return fetched;
  }

  /**
   * The lookup behind variant and context limits. A failed fetch — and an
   * empty answer, which the fetch treats as one — answers "nothing known" to
   * the call that saw it, so an unknown model is still an error there; the
   * next call asks the service again.
   */
  private modelCatalogue(): Promise<Map<string, { variants: Set<string>; context?: number }>> {
    return this.modelListing().then(
      (listing) => listing.lookup,
      () => new Map<string, { variants: Set<string>; context?: number }>(),
    );
  }

  /**
   * Every model the backend lists, as `providerID/id` with the cost it
   * reports, asked in `cwd`. Unlike the private lookup this rejects when the
   * call fails and when the answer holds no models: the budget guard must not
   * take either for truth, and neither is remembered. The rejection names what
   * went wrong by code and repeats nothing the service printed.
   */
  modelCatalog(cwd?: string): Promise<CatalogueModel[]> {
    return this.modelListing(cwd).then((listing) => listing.catalogue);
  }

  /**
   * One control-plane call for the catalogue, rejecting without a word of what
   * the service printed (`unquoted`): its stderr can quote configuration, and
   * the budget guard puts the start of a message into its reason, the journal
   * and the log.
   */
  private catalogueCall(operation: "model.list" | "model.default", cwd?: string): Promise<ApiEnvelope> {
    return this.api(operation, [], cwd).catch((cause: unknown) => { throw unquoted(operation, cause); });
  }

  /**
   * The backend's default model as `providerID/id`, from one `opencode api
   * model.default` call in `cwd`: `null` when the backend has none. Anything
   * else rejects — a failed call, or an answer that is not a model record — and
   * is not remembered. The record carries the same credentials as a list entry
   * and a failed call's stderr can quote configuration, so the rejection quotes
   * neither.
   */
  async defaultModelRef(cwd?: string): Promise<string | null> {
    const data = asObject(await this.catalogueCall("model.default", cwd))?.data;
    if (data === null) return null;
    const record = asObject(data);
    const providerID = record?.providerID;
    const id = record?.id;
    if (typeof providerID !== "string" || providerID.length === 0 || typeof id !== "string" || id.length === 0) {
      throw new Error("opencode api model.default answered no providerID/id");
    }
    return `${providerID}/${id}`;
  }

  /** Run one agent turn and collect the session id, final text and exit code. */
  prompt(args: PromptArgs): Promise<PromptResult> {
    return this.start(args).result;
  }

  start(args: PromptArgs): Execution<PromptResult> {
    const model = args.model ? `${args.model}${args.effort ? `#${args.effort}` : ""}` : undefined;
    // Windows caps the spawn command line near 32k characters; a prompt that
    // size must be clipped here with a visible marker instead of dying as
    // spawn ENAMETOOLONG after the work already happened (2026-11-23: a
    // review turn carrying a 45k acceptance log). Keep in sync with the
    // clip() in src/review.ts — duplicated locally to keep the adapter
    // layer free of review-layer imports.
    const MAX_ARGV_TEXT = 28_000;
    const clipArgvText = (text: string): string => {
      if (text.length <= MAX_ARGV_TEXT) return text;
      const head = Math.floor(MAX_ARGV_TEXT * 0.7);
      const tail = MAX_ARGV_TEXT - head;
      return `${text.slice(0, head)}\n\n[…taskctl 截断：prompt 原文 ${text.length} 字符超出命令行上限，此处省略 ${text.length - MAX_ARGV_TEXT} 字符（保留开头与结尾）…]\n\n${text.slice(text.length - tail)}`;
    };
    const text = clipArgvText(args.text);
    const argv = [
      "run",
      "--format",
      "json",
      ...(args.sessionId ? ["--session", args.sessionId] : []),
      ...(model ? ["--model", model] : []),
      ...(args.title ? ["--title", args.title] : []),
      "--auto",
      text,
    ];
    const child = spawn(this.bin, [...this.binArgsPrefix, ...argv], {
      cwd: args.cwd, shell: false, detached: process.platform !== "win32",
      ...(args.env === undefined ? {} : { env: { ...process.env, ...args.env } }),
    });

    let sessionId = args.sessionId ?? "";
    const result = new Promise<PromptResult>((resolve, reject) => {
      // The whole message rides in argv; never let the agent block on stdin.
      child.stdin?.end();

      // Line-by-line NDJSON over a byte buffer: the StringDecoder keeps
      // multi-byte characters intact across chunk boundaries, the remainder
      // carries a line split across reads, and the final flush in `close`
      // picks up a last line without a trailing newline.
      let sawSessionId = false;
      let text = "";
      const decoder = new StringDecoder("utf8");
      let buffered = "";
      let providerFailure = false;
      // Token counts reported by step_finish events, summed. Kept separate from
      // "0": a refusal that reports nothing must not look like a turn that ran
      // and spent nothing.
      let tokens = 0;
      let tokensReported = false;

      // stderr MUST be drained: a verbose child (auth warnings, LSP logs)
      // fills the pipe buffer and blocks forever otherwise. Captured so a
      // failed turn can carry a snippet of the diagnostics.
      const stderrChunks: Uint8Array[] = [];

      const consume = (line: string): void => {
        const trimmed = line.replace(/\r$/, "");
        if (trimmed.length === 0) {
          return;
        }
        let event: RunEvent;
        try {
          event = JSON.parse(trimmed) as RunEvent;
        } catch {
          return; // 非 JSON 行（进度噪声、撕裂写）直接跳过
        }
        if (!sawSessionId && typeof event.sessionID === "string") {
          // 首个含 sessionID 的行记录 id；流里的 id 优先于传入的续接 id
          sessionId = event.sessionID;
          sawSessionId = true;
        }
        if (event.type === "error") {
          // opencode reports a rejected turn as an error event (provider quota,
          // auth, 5xx). Remember it so the caller can retry instead of treating
          // the turn as an unverifiable interruption.
          if (PROVIDER_REJECTION.test(JSON.stringify(event))) providerFailure = true;
          return;
        }
        if (event.type === "retry") {
          // opencode's own retry loop: the provider refused this attempt
          // (`provider.rate-limit` on the zhipuai coding plan, 2026-11-23).
          // The turn may still succeed after a retry, so this only matters when
          // the CLI gives up and exits non-zero.
          if (PROVIDER_REJECTION.test(JSON.stringify(event))) providerFailure = true;
          return;
        }
        if (event.type === "text") {
          // opencode >= 2.2 nests the payload under `part`; older builds put
          // `text` at the top level. Accept both, prefer the nested one.
          const part = asObject(event.part);
          const piece = typeof part?.text === "string" ? part.text : event.text;
          if (typeof piece === "string") {
            text += piece;
          }
          return;
        }
        if (event.type === "step_finish") {
          // The step's usage is what tells an exhausted allowance apart from work
          // that failed: a rejected turn ends with a step that spent nothing.
          const part = asObject(event.part);
          const usage = asObject(part?.tokens) ?? asObject((event as RunEvent & { tokens?: unknown }).tokens);
          if (usage !== undefined) {
            const cache = asObject(usage.cache);
            tokens += count(usage.input) + count(usage.output) + count(usage.reasoning) + count(cache?.read) + count(cache?.write);
            tokensReported = true;
          }
        }
      };

      child.stdout?.on("data", (chunk: Buffer) => {
        buffered += decoder.write(chunk);
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines) {
          consume(line);
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
      child.on("error", reject);
      child.on("close", (code) => {
        buffered += decoder.end();
        if (buffered.length > 0) {
          consume(buffered);
        }
        const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
        const rejected = code !== 0 && (providerFailure || PROVIDER_REJECTION.test(stderr));
        resolve({
          sessionId,
          exitCode: code ?? -1,
          text: code === 0 ? text : withStderr(text, stderr),
          ...(tokensReported ? { tokens } : {}),
          ...(rejected ? { failure: "provider" as const } : {}),
        });
      });
    });
    const execution = processExecution(child, result, true, () => this.interruptSession(sessionId));
    return { ...execution, inspect: () => ({ ...execution.inspect(), ...(sessionId ? { sessionId } : {}) }) };
  }

  /**
   * Stop the session on the opencode service. `opencode run` is a client of a
   * background service and the agent loop lives on that service: killing the
   * client leaves the loop running - still calling the model, still running
   * tools in the work tree (2026-11-23: three sessions outlived their clients,
   * one for five hours, two of them editing a tree another session was also
   * editing). `session.interrupt` is the service's stop operation; its reply
   * says whether anything was running, and either way the session is not
   * executing once it has arrived.
   */
  private async interruptSession(sessionId: string): Promise<boolean> {
    if (!sessionId) return false;
    try {
      const envelope = await within(this.api("session.interrupt", [`sessionID=${sessionId}`]), 4000);
      // This operation answers bare - `{"interrupted":true|false}` - unlike
      // the enveloped telemetry calls (verified against the real service,
      // 2026-11-23). Accept either shape; only a boolean counts as an answer.
      const reply = asObject(envelope.data) ?? asObject(envelope);
      return typeof reply?.interrupted === "boolean";
    } catch {
      // No service reachable, or an older service without the operation:
      // unconfirmed, which is what the caller already assumes.
      return false;
    }
  }

  /**
   * Total tokens a session holds: `input+output+reasoning+cache.read+
   * cache.write` from `api session.get`. Token fields the session does not
   * report yet count as 0.
   */
  async contextUsage(sessionId: string): Promise<number> {
    const data = asObject((await this.api("session.get", [`sessionID=${sessionId}`])).data);
    const tokens = asObject(data?.tokens);
    const cache = asObject(tokens?.cache);
    return (
      count(tokens?.input) +
      count(tokens?.output) +
      count(tokens?.reasoning) +
      count(cache?.read) +
      count(cache?.write)
    );
  }

  async sessionUsage(sessionId: string): Promise<SessionUsageSnapshot> {
    const data = asObject((await this.api("session.get", [`sessionID=${sessionId}`])).data);
    const tokens = asObject(data?.tokens);
    const cache = asObject(tokens?.cache);
    const model = await this.sessionModel(sessionId, data?.model);
    return {
      input: count(tokens?.input),
      output: count(tokens?.output),
      reasoning: count(tokens?.reasoning),
      cacheRead: count(cache?.read),
      cacheWrite: count(cache?.write),
      ...(typeof data?.cost === "number" && Number.isFinite(data.cost) ? { cost: data.cost } : {}),
      ...(model === undefined ? {} : { model }),
    };
  }

  async canResumeSession(
    sessionId: string,
    expected: { model: string; cwd: string },
  ): Promise<SessionReuseStatus> {
    try {
      const envelope = await within(this.api("session.get", [`sessionID=${sessionId}`]), 4_000);
      const data = asObject(envelope.data);
      if (!data) return "unavailable";
      const time = asObject(data.time);
      if (typeof time?.busy === "number" && time.idle === undefined && (data.outcome === undefined || data.outcome === null)) return "active";
      // Idleness has to be proven, not inferred from the absence of one busy
      // marker: this answer is what lets a second worker onto the session, so
      // an unrecognised reply must refuse. v2.4.1 stamps time.idle once a
      // turn ends and leaves only time.busy while it runs (verified live,
      // 2026-11-24).
      if (typeof time?.idle !== "number") return "unavailable";
      const directory = asObject(data.location)?.directory;
      const actualModel = await this.sessionModel(sessionId, data.model);
      const expectedModel = expected.model.replace(/#.*$/, "");
      const normalize = (path: string) => {
        const value = resolve(path);
        return process.platform === "win32" ? value.toLowerCase() : value;
      };
      if (actualModel !== expectedModel || typeof directory !== "string" || normalize(directory) !== normalize(expected.cwd)) {
        return "unavailable";
      }
      return "reusable";
    } catch {
      return "unavailable";
    }
  }

  /**
   * The model a session last ran on, as `providerID/id`. `session.get`
   * carried it until opencode 2.4; the current service (v2.4.1, verified
   * 2026-11-24) reports it only on the assistant messages, newest first, so
   * one small page is read when the session record has none. A lookup that
   * fails or times out answers "unknown" — never a guess.
   */
  private async sessionModel(sessionId: string, reported: unknown): Promise<string | undefined> {
    const inline = modelId(asObject(reported));
    if (inline !== undefined) return inline;
    let messages: unknown[];
    try {
      const envelope = await within(this.api("session.message.list", [`sessionID=${sessionId}`, "limit=8"]), 4_000);
      messages = Array.isArray(envelope.data) ? envelope.data : [];
    } catch {
      return undefined;
    }
    // The newest assistant turn is what a resume would continue. Pick it by
    // its own time so neither listing order nor interleaved user/idle
    // entries can decide.
    let newest: JsonObject | undefined;
    let newestAt = Number.NEGATIVE_INFINITY;
    for (const message of messages) {
      const entry = asObject(message);
      if (entry?.type !== "assistant") continue;
      const created = asObject(entry.time)?.created;
      const at = typeof created === "number" ? created : Number.NEGATIVE_INFINITY;
      if (newest === undefined || at > newestAt) {
        newest = entry;
        newestAt = at;
      }
    }
    return modelId(asObject(newest?.model));
  }

  /**
   * `limit.context` of a model from `api model.list`: an entry matches when
   * `${providerID}/${id}` equals the model, or — falling back — when its
   * bare `id` equals the model stripped of any `provider/` prefix. No match
   * is a configuration error and rejects rather than returning a limit of 0
   * that would silently disable the Context Budget check.
   */
  async contextLimit(model: string): Promise<number> {
    const catalogue = await this.modelCatalogue();
    const bare = model.includes("/") ? model.slice(model.indexOf("/") + 1) : model;
    const matched = catalogue.get(model) ?? [...catalogue.entries()].find(([key]) => {
      const id = key.includes("/") ? key.slice(key.indexOf("/") + 1) : key;
      return id === bare;
    })?.[1];
    if (matched?.context === undefined) {
      throw new Error(`unknown model "${model}" — no matching entry in opencode api model.list`);
    }
    return matched.context;
  }

  /**
   * Control plane: run `opencode api <operation>` and return its parsed
   * `{"location":…,"data":…}` envelope. stdout is one JSON object, parsed
   * whole; a non-zero exit or unparsable output rejects — the caller's
   * budget math must never run on silently empty telemetry.
   *
   * `cwd` is the directory the call runs in. Only the catalogue calls pass
   * one: the directory a session would start in, since the service finds its
   * configuration from there and answers by it. Every other call has none and
   * runs where the process runs.
   */
  private api(operation: string, params: string[] = [], cwd: string = process.cwd()): Promise<ApiEnvelope> {
    const argv = [
      ...this.binArgsPrefix,
      "api",
      operation,
      ...params.flatMap((param) => ["--param", param]),
    ];
    // Every spawn carries an explicit working directory.
    const child = spawn(this.bin, argv, { cwd, shell: false });

    return new Promise<ApiEnvelope>((resolve, reject) => {
      child.stdin?.end();
      const chunks: Uint8Array[] = [];
      child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
      // stderr is drained (a full pipe would hang the control-plane call);
      // on failure its tail rides along in the rejection message.
      const stderrChunks: Uint8Array[] = [];
      child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
      const stdout = (): string => Buffer.concat(chunks).toString("utf8");
      const stderr = (): string => {
        const text = Buffer.concat(stderrChunks).toString("utf8").trim();
        return text.length === 0 ? "" : `: ${stderrSnippet(text)}`;
      };

      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) {
          reject(new ApiCallError(`opencode api ${operation} exited with code ${code ?? "null"}${stderr()}`, `exit ${code ?? "null"}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout()) as ApiEnvelope);
        } catch (err) {
          reject(new ApiCallError(`opencode api ${operation} printed unparsable output: ${(err as Error).message}`, "printed unparsable output"));
        }
      });
    });
  }
}

/**
 * A control-plane call that did not answer. The message may carry a tail of
 * the service's stderr, which is worth reading for a failed turn; `outcome` is
 * the same failure in the adapter's own words — an exit code, or that the
 * output was not JSON — and carries nothing the service printed.
 */
class ApiCallError extends Error {
  constructor(message: string, readonly outcome: string) {
    super(message);
  }
}

/**
 * The failure of `opencode api <operation>` as a new error whose message is
 * the operation and what went wrong by code, and nothing the service printed:
 * its stderr can quote configuration, and the budget guard puts the first 200
 * characters of a message into its reason, the journal and the log. The
 * original error is the `cause`.
 */
function unquoted(operation: string, cause: unknown): Error {
  const outcome = cause instanceof ApiCallError
    ? cause.outcome
    // A spawn failure is Node's own error; its `code` says what went wrong (`ENOENT`: no such binary).
    : typeof (cause as { code?: unknown } | null)?.code === "string"
      ? (cause as { code: string }).code
      : "unknown error";
  return new Error(`opencode api ${operation} failed: ${outcome}`, { cause });
}

/** Cap for stderr snippets attached to failed turns and api rejections. */
const STDERR_SNIPPET_MAX = 2_000;

/** A failed turn's text plus a bounded stderr tail (empty stderr adds nothing). */
function withStderr(text: string, stderr: string): string {
  return stderr.length === 0 ? text : `${text}\n[stderr] ${stderrSnippet(stderr)}`;
}

/** The informative tail of a stderr stream, capped to {@link STDERR_SNIPPET_MAX}. */
function stderrSnippet(stderr: string): string {
  return stderr.length <= STDERR_SNIPPET_MAX ? stderr : `…${stderr.slice(-STDERR_SNIPPET_MAX)}`;
}

/**
 * What an entry's cost rows say, or nothing. A row counts only when it carries
 * two finite numbers (a `cache` object on it is not a price), and an entry
 * with any other row says nothing about what it costs: an empty `cost`, which
 * the budget guard reads as unknown. Dropping the row alone read
 * `[{ input: 0, output: 0 }, { input: 3 }]` as a free model.
 */
function costOf(rows: readonly unknown[]): CatalogueCost[] {
  const prices = rows.map(priceOf);
  return prices.every((price) => price !== undefined) ? (prices as CatalogueCost[]) : [];
}

/** The price a cost row reports, or `undefined` for a row without two finite numbers. */
function priceOf(row: unknown): CatalogueCost | undefined {
  const input = asObject(row)?.input;
  const output = asObject(row)?.output;
  return typeof input === "number" && Number.isFinite(input) && typeof output === "number" && Number.isFinite(output)
    ? { input, output }
    : undefined;
}

/** A finite number counts; anything missing or exotic is 0 tokens. */
function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** `providerID/id` of a model record that names both; anything else is unknown. */
function modelId(model: JsonObject | undefined): string | undefined {
  return typeof model?.providerID === "string" && typeof model.id === "string"
    ? `${model.providerID}/${model.id}`
    : undefined;
}

/** Narrow `unknown` to a plain object, else undefined. */
function asObject(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null ? (value as JsonObject) : undefined;
}

/** A control-plane call that must not hang the cancellation path. */
function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no reply within ${ms}ms`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}
