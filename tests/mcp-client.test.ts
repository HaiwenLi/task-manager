import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { callTools } from "../src/mcp-client.js";

/**
 * The fake MCP server, started the way a real one is: node itself runs the
 * script, and the mode reaches it through the environment the client passes.
 */
const fake = fileURLToPath(new URL("./adapters/fake-mcp.mjs", import.meta.url));
const server = (mode: string, extra: Record<string, string> = {}) =>
  ({ command: [process.execPath, fake, mode], timeoutMs: 10_000, env: { FAKE_MCP_MODE: mode, ...extra } });

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "taskctl-mcp-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("callTools", () => {
  it("handshakes once and answers each call in order", async () => {
    const replies = await callTools(server("ok"), [{ name: "a", arguments: { q: 1 } }, { name: "b", arguments: { wing: "w" } }]);
    expect(replies.map((r) => r.isError)).toEqual([false, false]);
    expect(JSON.parse(replies[0].text).echo).toEqual({ name: "a", arguments: { q: 1 } });
    expect(JSON.parse(replies[1].text).id).toBeGreaterThan(JSON.parse(replies[0].text).id);
  });

  it("gives up on a server that never answers and leaves no child", async () => {
    const pidFile = join(root, "pid");
    const started = Date.now();
    const attempt = callTools({ ...server("hang", { FAKE_MCP_PIDFILE: pidFile }), timeoutMs: 300 }, [{ name: "a", arguments: {} }]);
    await expect(attempt).rejects.toMatchObject({ code: "timeout" });
    expect(Date.now() - started).toBeLessThan(4_000);
    const pid = Number(await readFile(pidFile, "utf8"));
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    await expect.poll(() => !alive(), { timeout: 3_000 }).toBe(true);
  });

  it("kills a server that answers and then lingers, and still returns the replies", async () => {
    const pidFile = join(root, "pid");
    const started = Date.now();
    const replies = await callTools(
      { ...server("linger", { FAKE_MCP_PIDFILE: pidFile }), timeoutMs: 10_000 },
      [{ name: "a", arguments: { q: 1 } }, { name: "b", arguments: { wing: "w" } }],
    );
    // Every answer is in, and the server was only killed after it had been
    // given time to leave by itself: bounded, and far inside the deadline.
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(replies.map((r) => r.isError)).toEqual([false, false]);
    expect(JSON.parse(replies[0].text).echo).toEqual({ name: "a", arguments: { q: 1 } });
    expect(JSON.parse(replies[1].text).id).toBeGreaterThan(JSON.parse(replies[0].text).id);
    const pid = Number(await readFile(pidFile, "utf8"));
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    await expect.poll(() => !alive(), { timeout: 3_000 }).toBe(true);
  });

  it("reports a server that dies after the handshake", async () => {
    await expect(callTools(server("crash"), [{ name: "a", arguments: {} }])).rejects.toMatchObject({ code: "protocol" });
  });

  it("returns a tool error instead of throwing", async () => {
    expect(await callTools(server("tool-error"), [{ name: "a", arguments: {} }])).toEqual([{ text: "boom", isError: true }]);
  });

  it("reports a command that cannot be spawned", async () => {
    await expect(callTools({ command: [join(root, "missing.exe")], timeoutMs: 1_000 }, [{ name: "a", arguments: {} }]))
      .rejects.toMatchObject({ code: "spawn" });
  });
});
