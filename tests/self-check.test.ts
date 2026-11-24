import { afterEach, assert, beforeEach, describe, expect, it } from "vitest";
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
    assert(!result.skipped); // the check ran, so there is output to inspect
    expect(result.output).toContain("self-check-ok");
  });

  it("retains partial output after a bounded timeout and confirmed stop", async () => {
    const result = await runSelfCheck({ command: nodePrintAndHang("before-self-check-timeout"), cwd: work, timeoutMs: 25 });
    expect(result.passed).toBe(false);
    assert(!result.skipped); // timed out rather than skipped: exit code and output exist
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

  it("runs in the attempt's workspace under the attempt's turn bound, whatever the caller's cwd", async () => {
    // worker 在任务自己的 workdir 里执行 taskctl check：它看不到控制器的 --config，
    // 也不负责解析任务的子路径。这两样都是控制器在领取时写进 attempt.json 的事实。
    const sub = join(work, "sub");
    await mkdir(sub, { recursive: true });
    const task = buildTaskFile({
      id: "a", status: "running", workdir: "sub",
      workerSelfCheck: `"${process.execPath}" -e "process.stdout.write(process.cwd())"`,
    });
    await writeFile(join(tasks, "a.md"), serializeTaskFile(task), "utf8");
    await mkdir(join(tasks, "a"), { recursive: true });
    await writeRuntime(tasks, "a", "attempt.json", {
      attemptId: "active-a", backend: "fixture", workspace: sub, turnTimeoutMs: 60_000,
      startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      phase: "active", operation: "agent turn",
    });

    const code = await runCli(["check", "--task", "a", "--tasks-dir", tasks], { log: () => {} });

    expect(code).toBe(0);
    const record = await readRuntime<{ result: { output?: string } }>(tasks, "a", "self-check.json");
    expect(record?.result.output).toBe(sub);
  });

  it("judges a declared self-check timeout against the attempt's turn bound, not a default", async () => {
    // 控制器以 45 分钟的回合上限启动、未在 worker 的 cwd 下留 taskctl.json：
    // 一次 40 分钟的自检是合法的，不能被 30 分钟的缺省上界拒掉。
    const task = buildTaskFile({
      id: "a", status: "running", workerSelfCheck: nodePrint("within-the-turn-bound"),
      workerSelfCheckTimeoutMs: 2_400_000,
    });
    await writeFile(join(tasks, "a.md"), serializeTaskFile(task), "utf8");
    await mkdir(join(tasks, "a"), { recursive: true });
    await writeRuntime(tasks, "a", "attempt.json", {
      attemptId: "active-a", backend: "fixture", workspace: work, turnTimeoutMs: 2_700_000,
      startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      phase: "active", operation: "agent turn",
    });

    const code = await runCli(["check", "--task", "a", "--tasks-dir", tasks], { log: () => {} });

    expect(code).toBe(0);
    expect(await readRuntime(tasks, "a", "self-check.json")).toMatchObject({ result: { passed: true } });
  });

  it("refuses a declared self-check timeout above the attempt's turn bound", async () => {
    const task = buildTaskFile({
      id: "a", status: "running", workerSelfCheck: nodePrint("too-long"),
      workerSelfCheckTimeoutMs: 20_000,
    });
    await writeFile(join(tasks, "a.md"), serializeTaskFile(task), "utf8");
    await mkdir(join(tasks, "a"), { recursive: true });
    await writeRuntime(tasks, "a", "attempt.json", {
      attemptId: "active-a", backend: "fixture", workspace: work, turnTimeoutMs: 10_000,
      startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      phase: "active", operation: "agent turn",
    });
    const errors: string[] = [];

    const code = await runCli(["check", "--task", "a", "--tasks-dir", tasks], { log: () => {}, err: (line) => { errors.push(line); } });

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("exceeds turnTimeoutMs 10000");
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
