import { startAcceptance, type AcceptanceResult } from "./acceptance.js";

const TIMEOUT = Symbol("self-check-timeout");

/** Run a declared worker-side generation/check with a hard time bound. */
export async function runSelfCheck(options: {
  command: string;
  cwd: string;
  timeoutMs: number;
}): Promise<AcceptanceResult> {
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("worker self-check timeout must be a positive integer");
  }
  const execution = startAcceptance(options.command, options.cwd, "generate");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      execution.result,
      new Promise<typeof TIMEOUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT), options.timeoutMs);
      }),
    ]);
    if (outcome !== TIMEOUT) return outcome;

    const stopped = await execution.cancel();
    if (!stopped) throw new Error("worker self-check timed out and shutdown could not be confirmed");
    return {
      passed: false,
      skipped: false,
      exitCode: null,
      output: [`worker self-check timed out after ${options.timeoutMs}ms`, execution.partialOutput()]
        .filter((part) => part.length > 0)
        .join("\n"),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
