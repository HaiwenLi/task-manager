import { describe, expect, it } from "vitest";
import { createCoalescedRefresh } from "../src/board.js";

describe("coalesced board refresh", () => {
  it("collapses a burst into the in-flight render and one trailing latest render", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const states: number[] = [];
    let state = 0;
    const refresh = createCoalescedRefresh(async () => {
      states.push(state);
      if (states.length === 1) await gate;
    });

    for (let i = 0; i < 20; i++) {
      state = i + 1;
      refresh.request();
    }
    expect(states).toEqual([1]);
    release();
    await refresh.flush();

    expect(states).toEqual([1, 20]);
  });
});
