import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export interface ExecutionInfo {
  pid?: number;
  sessionId?: string;
  state: "running" | "exited" | "uncertain";
}

/** `false` marks an execution that cannot be interrupted and only finishes on its own (cooperative test seams, telemetry). */
export interface Execution<T> {
  result: Promise<T>;
  inspect(): ExecutionInfo;
  cancel(): Promise<boolean>;
  readonly interruptible?: false;
}

/** What a platform can tell about, and do to, a process tree. Injected so the rule can be tested without a real tree. */
export type TreeControl = {
  /** The live lineal descendants of `root` (root excluded), or `null` when the platform cannot list processes in time. */
  descendants(root: number): Promise<readonly number[] | null>;
  /** Kill the root and its tree. `true` is the kill utility's own report, nothing more. */
  killTree(pid: number): Promise<boolean>;
};

export const TREE_LIST_DEADLINE_MS = 3_000; // the listing
export const TREE_SETTLE_MS = 500;          // the root's exit and the descendants' exit after the kill
export const CANCEL_BUDGET_MS = 7_500;      // the whole cancel; must stay under CANCEL_DEADLINE_MS (8_000, src/worker.ts)

export type ProcessEntry = { pid: number; parentPid: number; created: string }; // created: "yyyymmddHHMMSS"
export type ProcessTable = ReadonlyMap<number, ProcessEntry>;

/** `pid,parentPid,yyyymmddHHMMSS` lines → a table; anything else → null. */
export function parseProcessTable(output: string): ProcessTable | null {
  const trimmed = output.trim();
  if (trimmed.length === 0) return null;
  const table = new Map<number, ProcessEntry>();
  for (const line of trimmed.split(/\r?\n/)) {
    const match = /^(\d+),(\d+),(\d{14})$/.exec(line);
    if (match === null) return null;
    table.set(Number(match[1]), { pid: Number(match[1]), parentPid: Number(match[2]), created: match[3] });
  }
  return table;
}

/**
 * Descendants of `root` by parent lineage; a link counts only when the child
 * was created no earlier than its parent. The lineage is followed only through
 * entries the table holds: a child whose parent has no entry is nobody's
 * descendant - it cannot be attributed to any root - and a chain that is
 * broken anywhere between `root` and a pid does not make that pid a
 * descendant (a process whose parent died before the cancel began stays
 * `uncertain`).
 */
export function descendantsOf(table: ProcessTable, root: number): number[] {
  const childrenOf = new Map<number, ProcessEntry[]>();
  for (const entry of table.values()) {
    const siblings = childrenOf.get(entry.parentPid);
    if (siblings === undefined) childrenOf.set(entry.parentPid, [entry]);
    else siblings.push(entry);
  }
  const rootEntry = table.get(root);
  if (rootEntry === undefined) return []; // no entry, no creation time: the first link cannot be verified
  const descendants: number[] = [];
  const seen = new Set<number>([root]);
  let frontier: ProcessEntry[] = [rootEntry];
  while (frontier.length > 0) {
    const next: ProcessEntry[] = [];
    for (const parent of frontier) {
      for (const child of childrenOf.get(parent.pid) ?? []) {
        if (seen.has(child.pid) || child.created < parent.created) continue;
        seen.add(child.pid);
        descendants.push(child.pid);
        next.push(child);
      }
    }
    frontier = next;
  }
  return descendants;
}

/**
 * Track a child spawned detached on POSIX so cancellation targets its group.
 *
 * `stopBackend`, when the backend may outlive its client, asks the service
 * behind the client to stop the session the client was driving. `true` means
 * the service acknowledged that the session is no longer executing; anything
 * else - a refusal, an unreachable service, a missing hook - leaves the
 * cancellation as uncertain as before.
 *
 * `trees` is what confirms the kill. A cancellation is clean only when the
 * whole tree is gone: on Windows the live descendants are listed (before
 * anything is killed - who is under the root is known only while the root
 * lives) and each must be gone after it; on a platform that cannot list, the
 * kill utility's own report stands in. The output pipes close last: a
 * grandchild holding them is exactly what the listing is for, so they are
 * waited for to the end of the cancel budget, never presented as evidence
 * on their own.
 */
export function processExecution<T>(
  child: ChildProcess,
  result: Promise<T>,
  backendMaySurvive = false,
  stopBackend?: () => Promise<boolean>,
  trees: TreeControl = platformTreeControl,
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
        const deadline = Date.now() + CANCEL_BUDGET_MS;
        // The listing happens before anything is killed, or it answers for the
        // wrong tree. It is never a reason to kill: a listed pid the kill
        // leaves alive is only ever reported (unconfirmed), never killed
        // (ADR-0007) - a reused pid must cost a false "uncertain", not a
        // wrong kill.
        const known = interrupted && child.pid !== undefined
          ? await within(trees.descendants(child.pid), TREE_LIST_DEADLINE_MS, null)
          : null;
        // "Process not found" is not a failure to kill: a client the backend
        // stop already ended leaves the utility nothing to find.
        const utilityOk = child.pid !== undefined && (await trees.killTree(child.pid) || exited);
        const rootGone = await until(() => exited, TREE_SETTLE_MS);
        const lineageGone = known === null
          ? undefined
          : await until(() => known.every((pid) => !alive(pid)), TREE_SETTLE_MS);
        // Killing a CLI is not evidence that a remote/backend session stopped;
        // only the service's own acknowledgement is.
        const backendStoppedNow = await backend;
        // Today's grace is the minimum, the budget the maximum.
        const pipesClosed = closed || await until(() => closed, Math.max(TREE_SETTLE_MS, deadline - Date.now()));
        const treeGone = rootGone && pipesClosed && (lineageGone ?? utilityOk);
        uncertain = (backendMaySurvive && interrupted && !backendStoppedNow) || !treeGone;
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

/** The whole table, once, as `pid,parentPid,yyyymmddHHMMSS` lines. */
const PROCESS_LISTING =
  "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate | " +
  "ForEach-Object { '{0},{1},{2}' -f $_.ProcessId, $_.ParentProcessId, " +
  "$_.CimInstanceProperties['CreationDate'].Value.ToString('yyyyMMddHHmmss', [CultureInfo]::InvariantCulture) }";

/**
 * One Windows PowerShell listing of the whole process table, or null when it
 * fails or outlives its deadline. The CreationDate is stamped by the
 * listing's own clock, the same offset for every line of one listing - all
 * the lineage rule needs.
 */
function windowsProcessTable(): Promise<ProcessTable | null> {
  const systemRoot = process.env.SystemRoot;
  if (systemRoot === undefined) return Promise.resolve(null);
  return new Promise((resolve) => {
    const child = spawn(
      join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        Buffer.from(PROCESS_LISTING, "utf16le").toString("base64"),
      ],
      { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    child.stderr?.resume(); // never parsed; drained so a verbose failure cannot block the child
    let timer: NodeJS.Timeout | undefined;
    const finish = (table: ProcessTable | null) => {
      if (timer === undefined) return;
      clearTimeout(timer);
      timer = undefined;
      resolve(table);
    };
    timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, TREE_LIST_DEADLINE_MS);
    child.once("error", () => finish(null));
    child.once("close", (code) => finish(code === 0 ? parseProcessTable(output) : null));
  });
}

/** The live lineal descendants of `root` from one listing of the whole table. */
async function windowsDescendants(root: number): Promise<readonly number[] | null> {
  const table = await windowsProcessTable();
  return table === null ? null : descendantsOf(table, root);
}

/**
 * win32 lists the table through Windows PowerShell and kills through
 * `taskkill`; every other platform cannot list in time and keeps the kill
 * utility's own report as the only tree evidence.
 */
export const platformTreeControl: TreeControl = {
  descendants: process.platform === "win32" ? windowsDescendants : async () => null,
  killTree: (pid) => stopTree(pid),
};

/** A pid the platform still schedules answers a presence probe; anything else does not. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Poll every 20 ms until `predicate` holds or `ms` have passed; the last value is the answer. */
async function until(predicate: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  let value = predicate();
  while (!value && Date.now() < deadline) {
    await delay(20);
    value = predicate();
  }
  return value;
}

/** Race `promise` against a timer: the fallback answers when the promise is late. */
async function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}
