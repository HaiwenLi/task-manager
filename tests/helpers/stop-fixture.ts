import type { SignalSource, StopNow, StopSignal, StopSource } from "../../src/stop.js";

/** An interrupt source a test fires by hand: no file, no clock, no signal. */
export function manualStopNow(): StopNow & { trigger(source?: StopSource): void } {
  let source: StopSource | undefined;
  let settle!: (value: StopSource) => void;
  const observed = new Promise<StopSource>((resolve) => { settle = resolve; });
  return {
    observed,
    isRequested: () => source !== undefined,
    source: () => source,
    check: async () => source !== undefined,
    hold: () => () => {},
    trigger: (from = "file") => {
      if (source !== undefined) return;
      source = from;
      settle(from);
    },
  };
}

/** Stands in for the process's SIGINT/SIGTERM: firing it never touches the real process. */
export function manualSignals(): SignalSource & { fire(signal: StopSignal): void } {
  const listeners = new Set<(signal: StopSignal) => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    fire(signal) {
      for (const listener of [...listeners]) listener(signal);
    },
  };
}
