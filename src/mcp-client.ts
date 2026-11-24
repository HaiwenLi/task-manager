import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

/** How to reach an MCP server: its command line, and one deadline for the whole session. */
export type McpServerOptions = { command: string[]; timeoutMs: number; env?: Record<string, string> };
/** One tool call: the tool's name and the arguments object it is given. */
export type McpToolCall = { name: string; arguments: Record<string, unknown> };
/** What one tool call came back with: the server's text, and whether the tool itself reported an error. */
export type McpToolReply = { text: string; isError: boolean };
/** Why a session ended without an answer for every call. */
export type McpClientErrorCode = "spawn" | "timeout" | "protocol";

/** A session that failed; `code` says whether the server never started, was too slow, or left the protocol. */
export class McpClientError extends Error {
  constructor(message: string, readonly code: McpClientErrorCode) {
    super(message);
    this.name = "McpClientError";
  }
}

/** The protocol version this client asks for in the handshake. */
const PROTOCOL_VERSION = "2024-11-05";
/** What the handshake tells the server about its client, as the protocol defines it: informational only. */
const CLIENT_INFO = { name: "taskctl", version: "0.1.0" };
/** The request id of the handshake; the calls take the ones after it, in order. */
const HANDSHAKE_ID = 1;
/**
 * How long a child gets to leave by itself once stdin is over, and then, once
 * it has been killed, for its exit to show; in milliseconds. The deadline's
 * path gives it no time to leave by itself.
 */
const EXIT_WAIT_MS = 2_000;

/**
 * Start an MCP server over stdio and call tools on it, once: the handshake,
 * then one `tools/call` per entry, in order. One deadline (`timeoutMs`)
 * covers the whole conversation.
 *
 * Every path out ends the same way: stdin is ended, and the child is gone
 * before this settles. A server that leaves on its own once stdin is over is
 * given {@link EXIT_WAIT_MS} for it, then killed and given as long again for
 * its exit to show. When the deadline passes the child is killed at once.
 * From then on this can no longer fail: the teardown has its own bounds, so
 * no call takes longer than the deadline, or the last reply, plus 4 seconds.
 *
 * Rejects with an {@link McpClientError}: `spawn` when the command could not
 * be started, `timeout` when the deadline passed, and `protocol` when the
 * child left before it had answered everything, or answered with a JSON-RPC
 * error. A tool that reports an error is not a failure: it comes back as a
 * reply with `isError`.
 */
export async function callTools(options: McpServerOptions, calls: readonly McpToolCall[]): Promise<McpToolReply[]> {
  // Every line is put on the wire's terms before anything is started: an
  // argument that cannot be serialised fails here, with no child to end.
  const line = (message: unknown): string => `${JSON.stringify(message)}\n`;
  const handshake = line({
    jsonrpc: "2.0", id: HANDSHAKE_ID, method: "initialize",
    params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
  });
  const ready = line({ jsonrpc: "2.0", method: "notifications/initialized" });
  const requests = calls.map((call, index) => ({
    id: HANDSHAKE_ID + 1 + index,
    line: line({ jsonrpc: "2.0", id: HANDSHAKE_ID + 1 + index, method: "tools/call", params: { name: call.name, arguments: call.arguments } }),
  }));

  const [file, ...args] = options.command;
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(file, args, { shell: false, windowsHide: true, env: { ...process.env, ...options.env } });
  } catch (err) {
    throw new McpClientError(`mcp: cannot spawn ${file}: ${(err as Error).message}`, "spawn");
  }

  return new Promise<McpToolReply[]>((resolve, reject) => {
    const replies: McpToolReply[] = [];
    /** The request ids sent and not yet answered. */
    const open = new Set<number>();
    let sent = 0;
    let received = 0;
    /** The session's one timer: the deadline, then the waits on the way out. */
    let timer: ReturnType<typeof setTimeout> | undefined;
    /** The child has left and its pipes are closed: nothing more can come off it. */
    let gone = false;
    let spawned = false;
    let leaving = false;
    let settled = false;
    let inputEnded = false;

    // The first listener, before any write. A write to a child that has
    // already left fails with EPIPE, and an `error` event with no listener is
    // thrown. Its exit is what ends the call; the write's failure adds nothing.
    child.stdin.on("error", () => {
      // Nothing to do: `close` is on its way.
    });
    // stderr is drained, or a talkative server would fill the pipe and block.
    // It is collected and never printed: a server may well log its settings.
    const stderr: Uint8Array[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

    let childIsGone!: () => void;
    const childGone = new Promise<void>((resolveGone) => { childIsGone = resolveGone; });

    const settle = (error: McpClientError | undefined): void => {
      if (settled) return;
      settled = true;
      if (error === undefined) resolve(replies);
      else reject(error);
    };

    /** Wait for the child to be gone, for at most `ms`. */
    const hold = async (ms: number): Promise<void> => {
      try {
        await Promise.race([childGone, new Promise<void>((done) => { timer = setTimeout(done, ms); })]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
      }
    };

    const endInput = (): void => {
      if (inputEnded) return;
      inputEnded = true;
      child.stdin.end();
    };

    /**
     * The way out, and the only one, so every path clears the deadline, ends
     * stdin, waits for the child and settles exactly once. `error` is what the
     * call rejects with; `killAtOnce` is the deadline's path.
     */
    const exit = async (error: McpClientError | undefined, killAtOnce: boolean): Promise<void> => {
      if (leaving) return;
      leaving = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      try {
        endInput();
        if (!gone) {
          if (!killAtOnce) await hold(EXIT_WAIT_MS);
          if (!gone) {
            child.kill();
            await hold(EXIT_WAIT_MS);
          }
        }
      } finally {
        settle(error);
      }
    };

    /** Ask for the next call, or leave when every reply is in. */
    const sendNext = (): void => {
      if (received === requests.length) {
        void exit(undefined, false);
        return;
      }
      const request = requests[sent]!;
      sent += 1;
      open.add(request.id);
      child.stdin.write(request.line);
    };

    const receive = (text: string): void => {
      if (text.replace(/\r$/, "").length === 0) return;
      let message: unknown;
      try {
        message = JSON.parse(text);
      } catch {
        return; // Not JSON: noise on stdout, ignored.
      }
      const object = asObject(message);
      const id = object?.id;
      // A notification from the server, or an answer nobody is waiting for any more.
      if (object === undefined || typeof id !== "number" || !open.delete(id)) return;
      if (object.error !== undefined && object.error !== null) {
        // The server's own words stay out of the message: this text reaches the
        // journal, and an error can carry anything, a provider's refusal of a
        // key included. The code is the server's, and says what kind of failure.
        const method = id === HANDSHAKE_ID ? "initialize" : "tools/call";
        const code = asObject(object.error)?.code;
        void exit(new McpClientError(`mcp: ${method} answered with an error${typeof code === "number" ? ` (code ${code})` : ""}`, "protocol"), false);
        return;
      }
      if (id === HANDSHAKE_ID) {
        child.stdin.write(ready);
      } else {
        replies[id - HANDSHAKE_ID - 1] = toReply(object.result);
        received += 1;
      }
      sendNext();
    };

    // Line by line over a byte buffer: the StringDecoder keeps a multi-byte
    // character whole across two reads, and the remainder is a line that has
    // not ended yet.
    const decoder = new StringDecoder("utf8");
    let buffered = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffered += decoder.write(chunk);
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const text of lines) receive(text);
    });

    child.on("spawn", () => {
      spawned = true;
    });

    child.once("close", () => {
      // The pipes are closed, so this is all the child ever wrote: a last line
      // that never got its newline still counts.
      buffered += decoder.end();
      if (buffered.length > 0) {
        receive(buffered);
        buffered = "";
      }
      gone = true;
      childIsGone();
      // Every reply may have been in that last line; only a call still short of one ends here.
      if (!leaving) {
        const missing = requests.length - received;
        void exit(new McpClientError(
          `mcp: the server left before answering${missing > 0 ? ` ${missing} of its ${requests.length} calls` : " the handshake"}`,
          "protocol",
        ), false);
      }
    });

    child.on("error", (err) => {
      // Past the spawn, an error is a kill that could not be delivered; the
      // wait for the exit covers it.
      if (spawned) return;
      // The child never started: there is nothing to wait for.
      gone = true;
      childIsGone();
      void exit(new McpClientError(`mcp: cannot spawn ${file}: ${err.message}`, "spawn"), false);
    });

    timer = setTimeout(() => {
      void exit(new McpClientError(`mcp: timed out after ${options.timeoutMs} ms`, "timeout"), true);
    }, options.timeoutMs);

    open.add(HANDSHAKE_ID);
    child.stdin.write(handshake);
  });
}

/** A `tools/call` result as one reply: its text blocks joined, and the tool's own error flag. */
function toReply(result: unknown): McpToolReply {
  const content = asObject(result)?.content;
  const text = Array.isArray(content)
    ? content.flatMap((block: unknown) => {
      const item = asObject(block);
      return item?.type === "text" && typeof item.text === "string" ? [item.text] : [];
    }).join("\n")
    : "";
  return { text, isError: asObject(result)?.isError === true };
}

/** Narrow `unknown` to a plain object, else undefined. */
function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}
