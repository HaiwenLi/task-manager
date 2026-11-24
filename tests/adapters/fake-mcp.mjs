// Fake MCP server over stdio — the test double for the stdio client in
// src/mcp-client.ts.
//
// Mirrors exactly the surfaces the client uses: newline-delimited JSON-RPC
// 2.0, one message per line, requests in on stdin and responses out on
// stdout. Notifications carry no id and get no response.
//
// Test hooks, both optional and read from the environment (the client merges
// its `env` over the parent's, so a hook doubles as proof that it arrived):
//   FAKE_MCP_MODE     — how the session goes:
//                         ok          every tools/call is answered
//                         linger      every tools/call is answered too, then the
//                                     server ignores the end of stdin and stays
//                                     alive: the client has to end it
//                         hang        initialize is answered, a tools/call
//                                     never is: the server stays alive
//                         crash       exits right after answering initialize
//                         tool-error  answers each tools/call with a tool error
//   FAKE_MCP_PIDFILE  — path; `process.pid` is written there at start, so a
//                       test can ask whether the server was left behind
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const mode = process.env.FAKE_MCP_MODE;

if (process.env.FAKE_MCP_PIDFILE) {
  writeFileSync(process.env.FAKE_MCP_PIDFILE, String(process.pid), "utf8");
}

if (mode !== "ok" && mode !== "linger" && mode !== "hang" && mode !== "crash" && mode !== "tool-error") {
  process.stderr.write(`fake-mcp: unsupported FAKE_MCP_MODE ${JSON.stringify(mode)}\n`);
  process.exitCode = 2;
} else {
  if (mode === "hang" || mode === "linger") {
    // A server that has to be ended by the client: in `hang` a call is in
    // flight and never completes, in `linger` everything was answered and the
    // server just does not leave. The timer keeps it alive until then.
    setInterval(() => {}, 60_000);
  }

  /** One response line: a JSON-RPC 2.0 reply that carries `result` for request `id`. */
  const answer = (id, result, flushed) => {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`, flushed);
  };

  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    if (line.trim().length === 0) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.method === "initialize") {
      answer(
        msg.id,
        { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fake-mcp", version: "0" } },
        // The server dies between the handshake and the first call. The exit
        // waits for the answer to be on its way, as a crash after a real
        // write would.
        mode === "crash" ? () => process.exit(1) : undefined,
      );
      return;
    }
    if (msg.method !== "tools/call") return;
    // `hang` never answers a call: it is the server that has to be ended.
    if (mode === "hang") return;
    if (mode === "tool-error") {
      answer(msg.id, { isError: true, content: [{ type: "text", text: "boom" }] });
    } else {
      answer(msg.id, { content: [{ type: "text", text: JSON.stringify({ id: msg.id, echo: msg.params }) }] });
    }
  });
  lines.on("close", () => {
    // stdin is over, so the client is done talking: the server leaves. Only
    // `hang` and `linger` stay, and they are kept alive by their timer.
    process.stdin.destroy();
  });
}
