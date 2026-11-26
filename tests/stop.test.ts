import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createStopNow,
  processSignalSource,
  readStopNowRequest,
  requestStop,
  stopNowRequestPath,
  stopRequestPath,
} from "../src/stop.js";
import { manualSignals } from "./helpers/stop-fixture.js";

let root: string;
let tasks: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "taskctl-stop-"));
  tasks = join(root, "tasks");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it("stop --now writes the graceful request and then the interrupt request", async () => {
  const at = new Date("2026-11-25T10:00:00.000Z");
  expect(await requestStop(tasks, "now", at)).toBe(stopNowRequestPath(tasks));
  expect(await readFile(stopRequestPath(tasks), "utf8")).toBe(`${at.toISOString()}\n`);
  expect(await readFile(stopNowRequestPath(tasks), "utf8")).toBe(`${at.toISOString()}\n`);
  expect(await readStopNowRequest(tasks)).toBe(`${at.toISOString()}\n`);
});

it("a plain stop writes only the graceful request and never touches an existing interrupt", async () => {
  expect(await requestStop(tasks, "graceful", new Date("2026-11-25T10:00:00.000Z"))).toBe(stopRequestPath(tasks));
  expect(await readStopNowRequest(tasks)).toBeNull();
  await requestStop(tasks, "now", new Date("2026-11-25T10:00:01.000Z"));
  await requestStop(tasks, "graceful", new Date("2026-11-25T10:00:05.000Z"));
  expect(await readFile(stopNowRequestPath(tasks), "utf8")).toBe("2026-11-25T10:00:01.000Z\n");
});

it("an interrupt written while an attempt is held is observed from the file", async () => {
  const stop = await createStopNow(tasks, { pollMs: 10 });
  try {
    const release = stop.hold();
    await requestStop(tasks, "now");
    expect(await stop.observed).toBe("file");
    expect(stop.isRequested()).toBe(true);
    release();
  } finally { await stop.close(); }
});

it("an interrupt older than the controller is ignored; a newer one is seen", async () => {
  await requestStop(tasks, "now", new Date("2026-11-25T10:00:00.000Z"));
  const stop = await createStopNow(tasks, { pollMs: 10 });
  try {
    const release = stop.hold();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(stop.isRequested()).toBe(false);
    expect(await stop.check()).toBe(false);
    await requestStop(tasks, "now", new Date("2026-11-25T10:00:01.000Z"));
    expect(await stop.check()).toBe(true);
    expect(await stop.observed).toBe("file");
    release();
  } finally { await stop.close(); }
});

it("a request removed after the controller started is not a stop", async () => {
  await requestStop(tasks, "now", new Date("2026-11-25T10:00:00.000Z"));
  const stop = await createStopNow(tasks, { pollMs: 10 });
  try {
    const release = stop.hold();
    await rm(stopNowRequestPath(tasks), { force: true }); // what watch --resume does
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(stop.isRequested()).toBe(false);
    expect(await stop.check()).toBe(false);
    release();
  } finally { await stop.close(); }
});

it("a signal is observed at once and writes no file", async () => {
  const signals = manualSignals();
  const stop = await createStopNow(tasks, { signals });
  try {
    signals.fire("SIGINT");
    expect(await stop.observed).toBe("SIGINT");
    expect(stop.source()).toBe("SIGINT");
    await expect(readFile(stopNowRequestPath(tasks), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await stop.close(); }
});

it("the first source is kept; a later one does not replace it", async () => {
  const signals = manualSignals();
  const stop = await createStopNow(tasks, { signals, pollMs: 10 });
  try {
    const release = stop.hold();
    signals.fire("SIGTERM");
    await requestStop(tasks, "now");
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(stop.source()).toBe("SIGTERM");
    release();
  } finally { await stop.close(); }
});

it("nothing is polled while no attempt is held; a scheduling boundary still sees it", async () => {
  const stop = await createStopNow(tasks, { pollMs: 10 });
  try {
    const release = stop.hold();
    release();
    await requestStop(tasks, "now");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(stop.isRequested()).toBe(false);
    expect(await stop.check()).toBe(true);
  } finally { await stop.close(); }
});

it("close unsubscribes from signals and awaits what a signal started", async () => {
  const signals = manualSignals();
  let calls = 0;
  let written = false;
  const stop = await createStopNow(tasks, {
    signals,
    onSignal: async () => { calls += 1; await new Promise((resolve) => setTimeout(resolve, 30)); written = true; },
  });
  signals.fire("SIGINT");
  await stop.close();
  expect(written).toBe(true);
  signals.fire("SIGTERM");
  // No signal reaches the controller after close(): the subscription is gone,
  // so the handler is not called again and the source cannot move.
  expect(calls).toBe(1);
  expect(stop.source()).toBe("SIGINT");
});

it("processSignalSource subscribes to SIGINT and SIGTERM on the process and unsubscribes again", () => {
  const source = processSignalSource();
  const count = () => process.listenerCount("SIGINT") + process.listenerCount("SIGTERM");
  const before = count();
  const unsubscribe = source.subscribe(() => {});
  expect(count()).toBe(before + 2);
  unsubscribe();
  expect(count()).toBe(before);
});

it("readStopNowRequest answers null when nothing was written", async () => {
  expect(await readStopNowRequest(tasks)).toBeNull();
});
