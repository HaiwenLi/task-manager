import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { AgentAdapter } from "./types.js";
import { processExecution, type Execution } from "../execution.js";

/** One prompt() turn — the execution-plane call and its result. */
type PromptArgs = Parameters<AgentAdapter["prompt"]>[0];
type PromptResult = Awaited<ReturnType<AgentAdapter["prompt"]>>;

/** A parsed NDJSON event line from `opencode run --format json`. */
type RunEvent = { sessionID?: unknown; type?: unknown; text?: unknown };

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

  constructor(opts: { bin?: string; binArgsPrefix?: string[] } = {}) {
    this.bin = opts.bin ?? "opencode";
    this.binArgsPrefix = opts.binArgsPrefix ?? [];
  }

  /** Run one agent turn and collect the session id, final text and exit code. */
  prompt(args: PromptArgs): Promise<PromptResult> {
    return this.start(args).result;
  }

  start(args: PromptArgs): Execution<PromptResult> {
    const model = args.model ? `${args.model}${args.effort ? `#${args.effort}` : ""}` : undefined;
    const argv = [
      "run",
      "--format",
      "json",
      ...(args.sessionId ? ["--session", args.sessionId] : []),
      ...(model ? ["--model", model] : []),
      ...(args.title ? ["--title", args.title] : []),
      "--auto",
      args.text,
    ];
    const child = spawn(this.bin, [...this.binArgsPrefix, ...argv], {
      cwd: args.cwd, shell: false, detached: process.platform !== "win32",
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
        if (event.type === "text" && typeof event.text === "string") {
          text += event.text;
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
        resolve({ sessionId, exitCode: code ?? -1, text: code === 0 ? text : withStderr(text, stderr) });
      });
    });
    const execution = processExecution(child, result, true);
    return { ...execution, inspect: () => ({ ...execution.inspect(), ...(sessionId ? { sessionId } : {}) }) };
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

  /**
   * `limit.context` of a model from `api model.list`: an entry matches when
   * `${providerID}/${id}` equals the model, or — falling back — when its
   * bare `id` equals the model stripped of any `provider/` prefix. No match
   * is a configuration error and rejects rather than returning a limit of 0
   * that would silently disable the Context Budget check.
   */
  async contextLimit(model: string): Promise<number> {
    const envelope = await this.api("model.list");
    if (!Array.isArray(envelope.data)) {
      throw new Error("opencode api model.list returned no model list");
    }
    const bare = model.includes("/") ? model.slice(model.indexOf("/") + 1) : model;
    const entries = envelope.data.flatMap((entry) => {
      const object = asObject(entry);
      const id = object?.id;
      return typeof id === "string" ? [{ id, providerID: object?.providerID, limit: object?.limit }] : [];
    });
    const matched =
      entries.find((entry) => typeof entry.providerID === "string" && `${entry.providerID}/${entry.id}` === model) ??
      entries.find((entry) => entry.id === bare);
    const context = asObject(matched?.limit)?.context;
    if (typeof context !== "number" || !Number.isFinite(context)) {
      throw new Error(`unknown model "${model}" — no matching entry in opencode api model.list`);
    }
    return context;
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

/** Narrow `unknown` to a plain object, else undefined. */
function asObject(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null ? (value as JsonObject) : undefined;
}
