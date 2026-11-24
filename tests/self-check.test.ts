import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSelfCheck } from "../src/self-check.js";
import { runCli } from "../src/cli.js";
import { readRuntime, writeRuntime } from "../src/runtime.js";
import { serializeTaskFile } from "../src/task-file.js";
import { TaskStore } from "../src/task-store.js";
import { buildTaskFile } from "./helpers/task-fixture.js";

let root: string;
let tasks: string;
let work: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "taskctl-self-check-"));
  tasks = join(root, "tasks");
  work = join(root, "work");
  await mkdir(tasks);
  await mkdir(work);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const nodePrint = (text: string) => `"${process.execPath}" -e "console.log('${text}')"`;
const nodePrintAndHang = (text: string) => `"${process.execPath}" -e "console.log('${text}'); setInterval(() => {}, 1000)"`;

describe("worker self-check", () => {
  it("runs in generate mode and captures the result", async () => {
    const result = await runSelfCheck({ command: nodePrint("self-check-ok"), cwd: work, timeoutMs: 2_000 });
    expect(result).toMatchObject({ passed: true, exitCode: 0, skipped: false });
    expect(result.output).toContain("self-check-ok");
  });

  it("retains partial output after a bounded timeout and confirmed stop", async () => {
    const result = await runSelfCheck({ command: nodePrintAndHang("before-self-check-timeout"), cwd: work, timeoutMs: 25 });
    expect(result.passed).toBe(false);
    expect(result.exitCode).toBeNull();
    expect(result.output).toContain("timed out");
    expect(result.output).toContain("before-self-check-timeout");
  }, 10_000);

  it("taskctl check validates the active attempt and writes self-check.json", async () => {
    const task = buildTaskFile({
      id: "a", status: "running", workerSelfCheck: nodePrint("cli-self-check"),
      workerSelfCheckTimeoutMs: 2_000,
    });
    await writeFile(join(tasks, "a.md"), serializeTaskFile(task), "utf8");
    await mkdir(join(tasks, "a"), { recursive: true });
    await writeRuntime(tasks, "a", "attempt.json", {
      attemptId: "active-a", backend: "fixture", workspace: work,
      startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      phase: "active", operation: "agent turn",
    });
    const configPath = join(root, "taskctl.json");
    await writeFile(configPath, JSON.stringify({ tasksDir: tasks, workdir: work, turnTimeoutMs: 10_000 }), "utf8");

    const code = await runCli(["check", "--task", "a", "--config", configPath], { log: () => {} });

    expect(code).toBe(0);
    const record = await readRuntime<Record<string, unknown>>(tasks, "a", "self-check.json");
    expect(record).toMatchObject({ command: task.workerSelfCheck, mode: "generate", result: { passed: true, exitCode: 0 } });
    expect(String(record?.result && (record.result as Record<string, unknown>).output)).toContain("cli-self-check");
    expect((await new TaskStore(tasks).get("a")).status).toBe("running");
  });

  it("refuses a task that is not running or has no declared self-check", async () => {
    const task = buildTaskFile({ id: "a", status: "open" });
    await writeFile(join(tasks, "a.md"), serializeTaskFile(task), "utf8");
    const configPath = join(root, "taskctl.json");
    await writeFile(configPath, JSON.stringify({ tasksDir: tasks, workdir: work }), "utf8");

    expect(await runCli(["check", "--task", "a", "--config", configPath], { log: () => {}, err: () => {} })).toBe(1);
    expect(await readRuntime(tasks, "a", "self-check.json")).toBeNull();
  });
});
