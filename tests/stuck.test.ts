import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter } from "../src/adapters/types.js";
import { runCli } from "../src/cli.js";
import { claim } from "../src/claim.js";
import { recordGuardRefusal } from "../src/guard-refusals.js";
import { writeModelWait } from "../src/model-wait.js";
import { writeQuestions } from "../src/questions.js";
import { writeRuntime } from "../src/runtime.js";
import { TaskStore } from "../src/task-store.js";
import { buildTaskFile } from "./helpers/task-fixture.js";
import { seedTaskFile } from "./helpers/watch-fixture.js";

let root: string;
let tasks: string;
let store: TaskStore;
let lines: string[];
let errors: string[];
const stuck = () => runCli(["status", "--stuck", "--tasks-dir", tasks], { log: (line) => { lines.push(line); }, err: (line) => { errors.push(line); } });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "taskctl-stuck-"));
  tasks = join(root, "tasks");
  await mkdir(tasks);
  store = new TaskStore(tasks);
  lines = [];
  errors = [];
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const AT = "2026-11-25T10:00:00.000Z";

describe("taskctl status --stuck", () => {
  it("runs through the real parser as a boolean flag", async () => {
    expect(await stuck()).toBe(0);
    expect(lines).toEqual(["没有受阻或等待的任务"]);
    expect(errors).toEqual([]);
  });

  it("lists nothing that is ready, running or done, and leaves `status` as it was", async () => {
    await seedTaskFile(tasks, buildTaskFile({ id: "001-open" }), buildTaskFile({ id: "002-running", status: "running" }), buildTaskFile({ id: "003-done", status: "done" }));

    expect(await stuck()).toBe(0);
    expect(lines).toEqual(["没有受阻或等待的任务"]);
    const plain: string[] = [];
    await runCli(["status", "--tasks-dir", tasks], { log: (line) => { plain.push(line); }, err: () => {} });
    expect(plain[0]).toMatch(/^id\s+status\s+retries\s+sessions\s+note/);
    expect(plain.join("\n")).toContain("001-open");
    expect(plain.join("\n")).not.toContain("已阻塞");
  });

  it("says why a task is blocked and since when", async () => {
    await seedTaskFile(tasks, buildTaskFile({ id: "001-blocked", status: "blocked" }));
    await mkdir(join(tasks, "001-blocked"), { recursive: true });
    await writeFile(join(tasks, "001-blocked", "journal.md"), `${AT}  worker  blocked  retry limit reached\n`, "utf8");

    await stuck();

    expect(lines).toEqual(["001-blocked  已阻塞  retry limit reached；自 " + AT]);
  });

  it("for a model refusal, names every model and what it said", async () => {
    await seedTaskFile(tasks, buildTaskFile({ id: "001-own", status: "blocked" }));
    await writeModelWait(tasks, "001-own", {
      runId: "run", stage: "worker", rounds: 4, firstRefusedAt: AT, nextAt: AT, updatedAt: AT,
      refusals: [
        { model: "q/one", at: AT, reason: "exit 1 in 240ms, Error: input too long", source: "turn" },
        { model: "q/two", at: AT, reason: "exit 1 in 100ms, Error: refused", source: "turn" },
      ],
    });
    await mkdir(join(tasks, "001-own"), { recursive: true });
    await writeFile(join(tasks, "001-own", "journal.md"), `${AT}  worker  blocked  refused by every model in 4 round(s) while q/two served another task; retries untouched\n`, "utf8");

    await stuck();

    expect(lines).toEqual(["001-own  已阻塞  refused by every model in 4 round(s) while q/two served another task; retries untouched；自 " + AT
      + "；模型：q/one：exit 1 in 240ms, Error: input too long | q/two：exit 1 in 100ms, Error: refused"]);
  });

  it("says when only the review is missing", async () => {
    await seedTaskFile(tasks, buildTaskFile({ id: "001-park", status: "blocked" }));
    await mkdir(join(tasks, "001-park"), { recursive: true });
    await writeRuntime(tasks, "001-park", "review-pending.json", {
      definitionDigest: "d", artifactDigest: "a", createdAt: AT, updatedAt: AT,
      refusals: [{ model: "r/one", reason: "review timed out after 300ms" }],
    });

    await stuck();

    expect(lines).toEqual(["001-park  已阻塞  只差复核：r/one：review timed out after 300ms；自 " + AT]);
  });

  it("says which dependency will not finish, directly and through a chain", async () => {
    await seedTaskFile(tasks,
      buildTaskFile({ id: "001-root", status: "blocked" }),
      buildTaskFile({ id: "002-mid", dependsOn: ["001-root"] }),
      buildTaskFile({ id: "003-leaf", dependsOn: ["002-mid"] }),
      buildTaskFile({ id: "004-free" }));
    await mkdir(join(tasks, "001-root"), { recursive: true });
    await writeFile(join(tasks, "001-root", "journal.md"), `${AT}  worker  blocked  retry limit reached\n`, "utf8");

    await stuck();

    expect(lines).toEqual([
      "001-root  已阻塞  retry limit reached；自 " + AT,
      "002-mid  等受阻依赖  001-root：已阻塞：retry limit reached",
      "003-leaf  等受阻依赖  001-root（经 002-mid）：已阻塞：retry limit reached",
    ]);
  });

  it("shows a deferred task's round and next time, and a spent one", async () => {
    await seedTaskFile(tasks, buildTaskFile({ id: "001-wait" }), buildTaskFile({ id: "002-spent" }));
    const base = { runId: "run", stage: "worker" as const, firstRefusedAt: AT, refusals: [], updatedAt: AT };
    await writeModelWait(tasks, "001-wait", { ...base, rounds: 2, nextAt: "2026-11-25T10:01:00.000Z" });
    await writeModelWait(tasks, "002-spent", { ...base, rounds: 4, nextAt: AT });

    await stuck();

    // No attempt is in flight: the run that spent these rounds has stopped, as one does for an outage.
    expect(lines).toEqual([
      "001-wait  等模型窗口  第 2/4 轮，下次 2026-11-25T10:01:00.000Z",
      "002-spent  等模型窗口  第 4/4 轮已用尽，等所有者处理：改好配置后新的 taskctl run 从第 0 轮开始",
    ]);
  });

  it("says a spent deferral is waiting for the attempts in flight while a controller is running", async () => {
    await seedTaskFile(tasks, buildTaskFile({ id: "001-spent" }), buildTaskFile({ id: "002-running", status: "running" }));
    await writeModelWait(tasks, "001-spent", { runId: "run", stage: "worker", rounds: 4, firstRefusedAt: AT, nextAt: AT, refusals: [], updatedAt: AT });
    // What a live attempt leaves: the lock `claim` wrote is still beating.
    expect(await claim(tasks, "002-running", "w", 600_000)).toBe(true);

    await stuck();

    expect(lines).toEqual(["001-spent  等模型窗口  第 4/4 轮已用尽，等在跑的尝试结算后判断"]);
  });

  it("lists what needs a person", async () => {
    await seedTaskFile(tasks,
      buildTaskFile({ id: "001-human", status: "awaiting-human" }),
      buildTaskFile({ id: "002-draft", status: "draft" }),
      buildTaskFile({ id: "003-parent", status: "draft" }),
      buildTaskFile({ id: "004-child", status: "open", parentId: "003-parent" }),
      buildTaskFile({ id: "005-asked", status: "draft" }));
    await runCli(["note", "--task", "001-human", "--status", "等老板确认", "--done", "d", "--found", "f", "--next", "n", "--tasks-dir", tasks], { log: () => {}, err: () => {} });
    await writeQuestions(tasks, "005-asked", ["多大？", "何时？"], "intake");

    await stuck();

    expect(lines).toEqual([
      "001-human  等放行  等老板确认",
      "002-draft  等签字",
      "003-parent  等签字（拆分包：1 个子任务随之放行）",
      "005-asked  等签字；待回答问题 2 条（" + join(tasks, "005-asked", "questions.md") + "）",
    ]);
  });

  it("lists a task the budget guard refused from the board's record, and asks no backend", async () => {
    const paid = "- zen/p  provider=zen  enabled=true  variants=-  拒绝：按量计费，约 $15 / 百万 token；未列入 allowedModels";
    const unknown = "- kimi/k  provider=kimi  enabled=true  variants=-  拒绝：成本未知（目录里没有它，或它不报成本）；未列入 allowedModels，provider 也不在 allowedProviders 里";
    await seedTaskFile(tasks, buildTaskFile({ id: "001-refused" }), buildTaskFile({ id: "002-free" }));
    await recordGuardRefusal(tasks, "001-refused", `${paid}\n${unknown}`, new Date(AT));
    // What was judged then, from the record. Asking the guard would read the backend's catalogue.
    const asking: AgentAdapter = {
      modelCatalog: async () => { throw new Error("the stuck list must not ask the guard"); },
      prompt: async () => { throw new Error("the stuck list must not start a session"); },
      contextUsage: async () => 0, contextLimit: async () => 0,
    };

    expect(await runCli(["status", "--stuck", "--tasks-dir", tasks], { adapter: asking, log: (line) => { lines.push(line); }, err: (line) => { errors.push(line); } })).toBe(0);

    expect(lines).toEqual([`001-refused  等护栏放行  ${paid} | ${unknown}；判定于 ${AT}，现在的判定以 taskctl models 为准`]);
    expect(errors).toEqual([]);
  });

  it("no longer lists a guard refusal once the task has left open", async () => {
    await seedTaskFile(tasks, buildTaskFile({ id: "001-refused", status: "blocked" }));
    await recordGuardRefusal(tasks, "001-refused", "- zen/p  provider=zen  enabled=true  variants=-  拒绝：按量计费，约 $15 / 百万 token；未列入 allowedModels", new Date(AT));
    await mkdir(join(tasks, "001-refused"), { recursive: true });
    await writeFile(join(tasks, "001-refused", "journal.md"), `${AT}  worker  blocked  retry limit reached\n`, "utf8");

    await stuck();

    expect(lines).toEqual(["001-refused  已阻塞  retry limit reached；自 " + AT]);
  });
});
