/**
 * `taskctl models`: every model this configuration can run a task on, each
 * with the budget guard's verdict, before anything is offered.
 *
 * The command is read-only: it asks the backend only for its catalogue and
 * its default model, and a line is built from the verdict's own fields,
 * because a catalogue entry carries credentials.
 *
 * What the guard fetched is kept per process, so every test starts from a
 * reset state.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter, CatalogueModel } from "../src/adapters/types.js";
import { resetGuardState } from "../src/budget.js";
import { runCli } from "../src/cli.js";
import { CATALOGUE, adapterOf, entry } from "./helpers/catalogue-fixture.js";
import { buildTaskFile } from "./helpers/task-fixture.js";
import { seedTaskFile } from "./helpers/watch-fixture.js";

/** 记录型 fake adapter：没有模型目录方法，护栏对它不生效。 */
class FakeAdapter implements AgentAdapter {
  readonly calls: string[] = [];

  async prompt(args: Parameters<AgentAdapter["prompt"]>[0]) {
    this.calls.push(args.text);
    return { sessionId: "ses-fake", exitCode: 0, text: "" };
  }

  async contextUsage(_sessionId: string): Promise<number> {
    return 0;
  }

  async contextLimit(_model: string): Promise<number> {
    return 1_000_000;
  }
}

beforeEach(() => {
  resetGuardState();
});

/** 捕获 CLI 输出的注入 seam。 */
function capture(): {
  lines: string[];
  errors: string[];
  deps: { log: (line: string) => void; err: (line: string) => void };
} {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    deps: {
      log: (line) => lines.push(line),
      err: (line) => errors.push(line),
    },
  };
}

describe("taskctl models", () => {
  let root: string;
  let tasks: string;
  let work: string;
  let config: string;
  let cap: ReturnType<typeof capture>;

  /** A `taskctl.json` under `root` that points at the tasks dir. */
  async function writeConfig(settings: Record<string, unknown>): Promise<string> {
    const path = join(root, "taskctl.json");
    await writeFile(path, JSON.stringify({ tasksDir: tasks, workdir: work, ...settings }), "utf8");
    return path;
  }

  /** The model of every line, as a script reads it: what follows `- `. The header is nobody's line. */
  function refs(): string[] {
    return cap.lines.flatMap((line) => { const m = /^- (\S+)\s/.exec(line); return m === null ? [] : [m[1]]; });
  }

  function models(adapter: AgentAdapter, ...more: string[]): Promise<number> {
    return runCli(["models", "--config", config, ...more], { adapter, ...cap.deps });
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "taskctl-cli-models-"));
    tasks = join(root, "tasks");
    work = join(root, "work");
    await mkdir(tasks);
    await mkdir(work);
    // No model and no reviewerModel until a test sets them.
    config = await writeConfig({});
    cap = capture();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("lists every model the configuration can use with a verdict", async () => {
    config = await writeConfig({ model: "zen/p", reviewerModel: "plan/m" });
    expect(await models(adapterOf(CATALOGUE))).toBe(1);
    const text = cap.lines.join("\n");
    expect(text).toContain("zen/p");
    expect(text).toContain("拒绝");
    expect(text).toContain("plan/m");
    expect(text).toContain("放行（免费）");
    // The whole of it: the header first, which is no model's line, then the worker's chain and the reviewer's.
    expect(cap.lines).toEqual([
      "模型与护栏判定：",
      "- zen/p  provider=zen  enabled=true  variants=-  拒绝：按量计费，约 $15 / 百万 token；未列入 allowedModels",
      "- plan/m  provider=plan  enabled=true  variants=high  放行（免费）",
    ]);
    expect(cap.errors).toEqual([]);
  });

  it("lists the model of an unfinished task and the backend default of an empty chain", async () => {
    // No model and no reviewerModel in the configuration; an open task "a" with a model of its own.
    await seedTaskFile(tasks, buildTaskFile({ id: "a", title: "a", model: "kimi/k" }));
    await models(adapterOf(CATALOGUE, "zen/p"));
    expect(refs()).toEqual(["zen/p", "kimi/k"]);   // the default first (both chains are empty, so it is listed once), then the task's own model
  });

  it("lists the backend default in the place of a chain that is empty", async () => {
    // The worker's chain is set; the reviewer's is not, so a review runs on the backend's default, the paid "zen/p".
    config = await writeConfig({ model: "plan/m" });
    expect(await models(adapterOf(CATALOGUE, "zen/p"))).toBe(1);
    expect(refs()).toEqual(["plan/m", "zen/p"]);
  });

  it("leaves out a finished task's model, and a model that already has a line", async () => {
    // The worker's chain is "plan/m". a is done: its paid model is nobody's next session.
    config = await writeConfig({ model: "plan/m" });
    await seedTaskFile(
      tasks,
      buildTaskFile({ id: "a", title: "a", status: "done", model: "zen/p" }),
      // b names the chain's model again.
      buildTaskFile({ id: "b", title: "b", model: "plan/m" }),
      // c is the only model not listed yet, and it is refused: the catalogue has it, but with no cost.
      buildTaskFile({ id: "c", title: "c", model: "kimi/k" }),
      // d has no model of its own: it runs on the chain, which is already listed.
      buildTaskFile({ id: "d", title: "d" }),
    );
    // The reviewer's chain is empty too: its default is "plan/m", already listed.
    expect(await models(adapterOf(CATALOGUE, "plan/m"))).toBe(1);
    expect(refs()).toEqual(["plan/m", "kimi/k"]);
  });

  it("exits 0 when every line is allowed, and starts no model session", async () => {
    config = await writeConfig({ model: "plan/m", reviewerModel: "plan/m", allowedModels: ["kimi/k"] });
    await seedTaskFile(tasks, buildTaskFile({ id: "a", title: "a", model: "kimi/k" }));
    const adapter = Object.assign(new FakeAdapter(), adapterOf(CATALOGUE, "plan/m"));
    expect(await models(adapter)).toBe(0);
    expect(refs()).toEqual(["plan/m", "kimi/k"]);
    expect(adapter.calls).toEqual([]);
    expect(cap.errors).toEqual([]);
  });

  it("prints nothing a catalogue entry carries", async () => {
    // One entry more than the shared catalogue, carrying what the backend's own records carry.
    const leaky = {
      ...entry("leak/l", [{ input: 1, output: 2 }]),
      settings: { apiKey: "sk-test-secret" },
      headers: { Authorization: "Bearer x" },
    } as CatalogueModel;
    // The configuration runs on that entry, so it is a model the command has to describe.
    config = await writeConfig({ model: "leak/l" });
    expect(await models(adapterOf([...CATALOGUE, leaky]))).toBe(1);
    // Described from its own fields...
    expect(cap.lines.join("\n")).toContain("- leak/l  provider=leak");
    // ...and nothing else of it.
    expect(cap.lines.join("\n") + cap.errors.join("\n")).not.toMatch(/apiKey|headers|sk-|Bearer/);
  });

  it("says so when the adapter cannot list models", async () => {
    // The configured model is the paid one: with no catalogue to judge by, nothing is refused.
    config = await writeConfig({ model: "zen/p" });
    const adapter = new FakeAdapter();
    expect(await models(adapter)).toBe(0);
    expect(cap.lines).toEqual(["此适配器不提供模型目录，护栏不生效"]);
    expect(adapter.calls).toEqual([]);
  });

  it("refuses every line when the catalogue cannot be read, and says why on each", async () => {
    config = await writeConfig({ model: "plan/m" });
    const unreachable: AgentAdapter = {
      ...adapterOf(CATALOGUE, "plan/m"),
      modelCatalog: async () => { throw new Error("service unreachable"); },
    };
    expect(await models(unreachable)).toBe(1);
    expect(cap.lines).toHaveLength(2);
    expect(cap.lines[0]).toBe("模型与护栏判定：");
    expect(cap.lines[1]).toContain("- plan/m");
    expect(cap.lines[1]).toContain("模型目录读不到");
    expect(cap.errors).toEqual([]);
  });

  it("takes no --tasks-dir: the board is the one the configuration names", async () => {
    config = await writeConfig({ model: "plan/m" });
    expect(await models(adapterOf(CATALOGUE), "--tasks-dir", tasks)).toBe(2);
    expect(cap.errors.join("\n")).toContain("unknown option --tasks-dir for command models");
    expect(cap.lines).toEqual([]);
  });
});
