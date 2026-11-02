import { spawn } from "node:child_process";
import { processExecution, type Execution } from "./execution.js";

/**
 * Outcome of the acceptance gate. `exitCode` is null when the command could
 * not be spawned at all (e.g. `cwd` missing) or died to a signal; `skipped`
 * is true when the task has no acceptance command and the gate was a no-op.
 */
export type AcceptanceResult =
  | { passed: boolean; exitCode: number | null; output: string; skipped: false }
  | { passed: false; skipped: true };

/**
 * Run a task's `acceptance:` shell command in `cwd`: exit 0 passes, anything
 * else fails. This is the trust boundary of ADR-0006 — an agent's self-report
 * only triggers this check; it never flips status by itself. Deciding what a
 * failure means (retry vs blocked) belongs to the caller.
 *
 * The command is a full shell command line, so it runs through the platform
 * shell as an explicit `spawn(file, args)` with `shell: false`. An empty
 * command (task has no `acceptance` field) skips the gate with
 * `{passed: false, skipped: true}`; logging the warning is the caller's job.
 */
export async function runAcceptance(command: string, cwd: string): Promise<AcceptanceResult> {
  return startAcceptance(command, cwd).result;
}

/** Start the gate immediately and expose its process lifecycle to the worker. */
export function startAcceptance(command: string, cwd: string): Execution<AcceptanceResult> {
  if (command.trim().length === 0) {
    return {
      result: Promise.resolve({ passed: false, skipped: true }),
      inspect: () => ({ state: "exited" }),
      cancel: async () => true,
    };
  }
  const isWindows = process.platform === "win32";
  const child = spawn(isWindows ? "cmd" : "sh", isWindows ? ["/d", "/s", "/c", `"${command}"`] : ["-c", command], {
    cwd,
    shell: false,
    detached: !isWindows,
    windowsVerbatimArguments: isWindows,
  });

  const result = new Promise<AcceptanceResult>((resolve) => {
    // The command line is the whole program; never let it block on stdin.
    child.stdin?.end();

    // stdout and stderr are merged so a failure carries the command's own
    // diagnostics. Buffers are decoded once at the end to keep multi-byte
    // characters intact across chunk boundaries.
    const chunks: Uint8Array[] = [];
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk));
    const output = (): string => Buffer.concat(chunks).toString("utf8");

    // The shell itself could not start: no exit code exists, the gate fails.
    child.on("error", () => {
      resolve({ passed: false, exitCode: null, output: output(), skipped: false });
    });
    child.on("close", (code) => {
      resolve({ passed: code === 0, exitCode: code, output: output(), skipped: false });
    });
  });
  return processExecution(child, result);
}
