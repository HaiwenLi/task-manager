import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export interface ExecutionInfo {
  pid?: number;
  sessionId?: string;
  state: "running" | "exited" | "uncertain";
}

export interface Execution<T> {
  result: Promise<T>;
  inspect(): ExecutionInfo;
  cancel(): Promise<boolean>;
}

/** Track a child spawned detached on POSIX so cancellation targets its group. */
export function processExecution<T>(
  child: ChildProcess,
  result: Promise<T>,
  backendMaySurvive = false,
): Execution<T> {
  // A caller may inspect/cancel before awaiting. Retain the original rejection
  // for that caller without leaking an unhandled-rejection event meanwhile.
  void result.catch(() => {});
  let closed = false;
  let exited = false;
  let uncertain = false;
  let cancellation: Promise<boolean> | undefined;
  child.once("close", () => { closed = true; });
  child.once("exit", (code, signal) => {
    exited = true;
    // An unexpectedly departed CLI cannot certify a backend session stopped,
    // even when nobody explicitly requested cancellation.
    if (backendMaySurvive && (code !== 0 || signal !== null)) uncertain = true;
  });
  child.once("error", () => { if (child.pid === undefined) closed = true; });

  return {
    result,
    inspect: () => ({
      ...(child.pid === undefined ? {} : { pid: child.pid }),
      state: uncertain ? "uncertain" : closed ? "exited" : "running",
    }),
    cancel() {
      if (cancellation) return cancellation;
      if (child.pid === undefined && closed) return Promise.resolve(true);
      // Windows cannot address a departed parent's descendants. Do not risk
      // taskkill targeting an unrelated process that has since reused its PID.
      if (process.platform === "win32" && exited) {
        uncertain = true;
        return Promise.resolve(false);
      }
      cancellation = (async () => {
        const interrupted = !closed;
        const stopped = child.pid !== undefined && await stopTree(child.pid);
        // Killing a CLI is not evidence that a remote/backend session stopped.
        uncertain = (backendMaySurvive && interrupted) || !stopped;
        const deadline = Date.now() + 500;
        while (!closed && Date.now() < deadline) await delay(20);
        if (!closed) uncertain = true;
        return !uncertain;
      })();
      return cancellation;
    },
  };
}

/** Both the kill utility and exit confirmation have finite deadlines. */
async function stopTree(pid: number): Promise<boolean> {
  if (process.platform === "win32") {
    return new Promise<boolean>((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      });
      const timer = setTimeout(() => {
        killer.kill();
        resolve(false);
      }, 1500);
      killer.once("error", () => { clearTimeout(timer); resolve(false); });
      killer.once("close", (code) => { clearTimeout(timer); resolve(code === 0); });
    });
  }

  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
  const deadline = Date.now() + 1500;
  do {
    try { process.kill(-pid, 0); } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
    await delay(20);
  } while (Date.now() < deadline);
  return false;
}
