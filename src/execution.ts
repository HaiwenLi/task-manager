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

/**
 * Track a child spawned detached on POSIX so cancellation targets its group.
 *
 * `stopBackend`, when the backend may outlive its client, asks the service
 * behind the client to stop the session the client was driving. `true` means
 * the service acknowledged that the session is no longer executing; anything
 * else - a refusal, an unreachable service, a missing hook - leaves the
 * cancellation as uncertain as before.
 */
export function processExecution<T>(
  child: ChildProcess,
  result: Promise<T>,
  backendMaySurvive = false,
  stopBackend?: () => Promise<boolean>,
): Execution<T> {
  // A caller may inspect/cancel before awaiting. Retain the original rejection
  // for that caller without leaking an unhandled-rejection event meanwhile.
  void result.catch(() => {});
  let closed = false;
  let exited = false;
  let uncertain = false;
  // undefined = the backend has not answered yet; true = it confirmed its session
  // is no longer executing.
  let backendStopped: boolean | undefined;
  let cancellation: Promise<boolean> | undefined;
  child.once("close", () => { closed = true; });
  child.once("exit", (code, signal) => {
    exited = true;
    // An unexpectedly departed CLI cannot certify a backend session stopped,
    // even when nobody explicitly requested cancellation - unless the service
    // has confirmed by then that it did. The event may arrive before or after
    // that confirmation, so both orders are handled here and in cancel().
    if (backendMaySurvive && (code !== 0 || signal !== null) && backendStopped !== true) uncertain = true;
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
      // A hook that throws is the caller's bug, not a licence to crash the cancel.
      const backend = (backendMaySurvive ? settle(stopBackend) : Promise.resolve(true))
        .then((confirmed) => { backendStopped = confirmed; return confirmed; });
      // Windows cannot address a departed parent's descendants. Do not risk
      // taskkill targeting an unrelated process that has since reused its PID.
      if (process.platform === "win32" && exited) {
        uncertain = true;
        // Still stop the backend: the client is gone, so its session is exactly
        // the one that would otherwise outlive it. The outcome stays unconfirmed
        // (the tree cannot be verified any more), but no zombie agent keeps
        // calling the model and editing the work tree.
        cancellation = backend.then(() => false);
        return cancellation;
      }
      cancellation = (async () => {
        const interrupted = !closed;
        // Both stops run together: the request to the service must not delay
        // the kill, and the kill must not leave the service running when it
        // returns first.
        // Already gone counts as stopped: the service's stop ends the run, and
        // a client that then exits on its own leaves taskkill nothing to find
        // (it answers "process not found", which is not a failure to kill).
        const stopped = child.pid !== undefined && (await stopTree(child.pid) || exited);
        // Killing a CLI is not evidence that a remote/backend session stopped;
        // only the service's own acknowledgement is.
        const backendStopped = await backend;
        uncertain = (backendMaySurvive && interrupted && !backendStopped) || !stopped;
        const deadline = Date.now() + 500;
        while (!closed && Date.now() < deadline) await delay(20);
        if (!closed) uncertain = true;
        return !uncertain;
      })();
      return cancellation;
    },
  };
}

/** A backend stop that is absent, fails or throws is simply unconfirmed. */
function settle(stop: (() => Promise<boolean>) | undefined): Promise<boolean> {
  return stop === undefined ? Promise.resolve(false) : stop().catch(() => false);
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
