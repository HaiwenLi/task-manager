import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { resolve } from "node:path";
import type { AgentAdapter, SessionReuseStatus, SessionUsageSnapshot } from "./types.js";
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
 * failed turns and api rejections carry a capped stderr tail as context.
 * `binArgsPrefix` (used by the test double: `["node", "<script>", …]`) is
 * prepended to every invocation.
 */
export class OpenCodeAdapter implements AgentAdapter {
  private readonly bin: string;
  private readonly binArgsPrefix: string[];
  /** Model metadata for variant/context lookups; fetched once per adapter. */
  private modelList?: Promise<Map<string, { variants: Set<string>; context?: number }>>;

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

  /** `opencode api model.list`, fetched once and kept for the process life. */
  private modelCatalogue(): Promise<Map<string, { variants: Set<string>; context?: number }>> {
    this.modelList ??= this.api("model.list").then((envelope) => {
      const catalogue = new Map<string, { variants: Set<string>; context?: number }>();
      if (Array.isArray(envelope.data)) {
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
            if (!catalogue.has(key)) catalogue.set(key, { variants: new Set(variants), ...(context === undefined ? {} : { context }) });
          }
        }
      }
      return catalogue;
    }).catch(() => new Map<string, { variants: Set<string>; context?: number }>());
    return this.modelList;
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
   */
  private api(operation: string, params: string[] = []): Promise<ApiEnvelope> {
    const argv = [
      ...this.binArgsPrefix,
      "api",
      operation,
      ...params.flatMap((param) => ["--param", param]),
    ];
    // No per-call cwd exists on the control plane; pin the process cwd so
    // every spawn still carries an explicit working directory.
    const child = spawn(this.bin, argv, { cwd: process.cwd(), shell: false });

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
          reject(new Error(`opencode api ${operation} exited with code ${code ?? "null"}${stderr()}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout()) as ApiEnvelope);
        } catch (err) {
          reject(new Error(`opencode api ${operation} printed unparsable output: ${(err as Error).message}`));
        }
      });
    });
  }
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
