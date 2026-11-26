import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { renameWithRetry } from "./replace.js";
import { controlDir } from "./watch-lock.js";

/** A signal the operator sends the controller's process. */
export type StopSignal = "SIGINT" | "SIGTERM";

/** How an interrupt reached the controller: a request on the board, or a signal. */
export type StopSource = "file" | StopSignal;

/** The graceful drain request `taskctl stop` has always written. */
export const stopRequestPath = (tasksDir: string): string => join(controlDir(tasksDir), "stop.requested");

/** The interrupt request beside it, written by `stop --now` and by a signal. */
export const stopNowRequestPath = (tasksDir: string): string => join(controlDir(tasksDir), "stop-now.requested");

/** How often a controller holding an attempt looks at the board for an interrupt request. */
export const STOP_POLL_MS = 250;

/**
 * Write a stop request. `now` writes the graceful request first, then the
 * interrupt request — a crash between the two leaves a graceful request, never
 * an interrupt without one — and returns the interrupt request's path. A plain
 * stop writes the graceful request only, never touching an existing interrupt,
 * and returns that request's path.
 */
export async function requestStop(
  tasksDir: string,
  mode: "graceful" | "now",
  at: Date = new Date(),
): Promise<string> {
  await mkdir(controlDir(tasksDir), { recursive: true });
  const content = `${at.toISOString()}\n`;
  const path = stopRequestPath(tasksDir);
  await writeFile(path, content, "utf8");
  if (mode === "graceful") return path;
  const nowPath = stopNowRequestPath(tasksDir);
  const temporary = `${nowPath}.tmp`;
  await writeFile(temporary, content, "utf8");
  await renameWithRetry(temporary, nowPath);
  return nowPath;
}

/** Content of the interrupt request, or null when there is none. */
export async function readStopNowRequest(tasksDir: string): Promise<string | null> {
  try {
    return await readFile(stopNowRequestPath(tasksDir), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** One controller's view of the operator's interrupt. */
export type StopNow = {
  /** Settles once an interrupt has been observed. Never rejects. */
  readonly observed: Promise<StopSource>;
  isRequested(): boolean;
  source(): StopSource | undefined;
  /** One look at the board: did an interrupt arrive since this controller started, or since the last look? */
  check(): Promise<boolean>;
  /** An attempt is about to run: watch for an interrupt until the returned function is called. */
  hold(): () => void;
};

/** Where SIGINT and SIGTERM come from; tests fire one by hand. */
export type SignalSource = { subscribe(listener: (signal: StopSignal) => void): () => void };

export type StopNowOptions = {
  /** Production uses {@link processSignalSource}; tests fire a manual source. */
  signals?: SignalSource;
  /** How often `hold` polls the board; production uses {@link STOP_POLL_MS}. */
  pollMs?: number;
  /** Called for every signal, first or repeated; its promise is awaited by `close()`. */
  onSignal?: (signal: StopSignal) => Promise<void> | void;
};

/**
 * Subscribe to the real process's SIGINT and SIGTERM. One listener per signal;
 * the returned function removes both again.
 */
export function processSignalSource(): SignalSource {
  return {
    subscribe(listener) {
      process.on("SIGINT", listener);
      process.on("SIGTERM", listener);
      return () => {
        process.off("SIGINT", listener);
        process.off("SIGTERM", listener);
      };
    },
  };
}

/**
 * The interrupt source one run or watch controller holds. A request on the
 * board counts for this controller only when a file is there and its content
 * differs from what was already there when the controller started: that makes
 * a request older than the controller invisible without comparing clocks, and
 * a request `watch --resume` clears a moment after the start no request at
 * all. A signal counts at once and writes no file.
 */
export async function createStopNow(
  tasksDir: string,
  options: StopNowOptions = {},
): Promise<StopNow & { close(): Promise<void> }> {
  // The request, if any, that already existed when this controller started.
  // A read that fails here is no request either.
  const baseline = await readStopNowRequest(tasksDir).catch(() => null);
  let source: StopSource | undefined;
  let settle!: (value: StopSource) => void;
  const observed = new Promise<StopSource>((resolve) => { settle = resolve; });
  const kept: Array<Promise<unknown>> = [];
  const signal = (from: StopSource): void => {
    if (source !== undefined) return;
    source = from;
    settle(from);
  };
  // One look at the board. A read that fails counts as the baseline: it is
  // never evidence of a request. A removed request is no request — `watch
  // --resume` clears the file a moment after the controller started, and that
  // must not read as a stop.
  const look = async (): Promise<void> => {
    let content: string | null;
    try {
      content = await readStopNowRequest(tasksDir);
    } catch {
      content = baseline;
    }
    if (content !== null && content !== baseline) signal("file");
  };
  let timer: NodeJS.Timeout | undefined;
  let holders = 0;
  const tick = (): void => { void look(); };
  const hold = (): (() => void) => {
    holders += 1;
    if (holders === 1 && timer === undefined) {
      timer = setInterval(tick, options.pollMs ?? STOP_POLL_MS);
      timer.unref();
    }
    return () => {
      holders -= 1;
      if (holders === 0) {
        clearInterval(timer);
        timer = undefined;
      }
    };
  };
  const unsubscribe = options.signals?.subscribe((sig) => {
    kept.push(Promise.resolve(options.onSignal?.(sig)));
    signal(sig);
  });
  const close = async (): Promise<void> => {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
    unsubscribe?.();
    await Promise.all(kept);
  };
  return {
    observed,
    isRequested: () => source !== undefined,
    source: () => source,
    check: async () => {
      await look();
      return source !== undefined;
    },
    hold,
    close,
  };
}
