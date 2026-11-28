import { describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.js";
import { TaskStore } from "../src/task-store.js";
import { readSpec } from "../src/spec.js";
import { journalTail } from "../src/journal.js";
import { parseTaskFile, serializeTaskFile, TaskFileError } from "../src/task-file.js";
import type { Task, TaskStatus } from "../src/task-file.js";
import type { AgentAdapter } from "../src/adapters/types.js";
import type { AcceptanceResult } from "../src/acceptance.js";
import { runTask, type WorkerConfig } from "../src/worker.js";
import { checkRender, describeFailures, parseViewport, RenderUnavailableError } from "../src/render.js";

const silent = { log: () => {} };

/** An adapter that fails loudly: a lane that should not call a model must not. */
function noModel(): AgentAdapter {
  return {
    prompt: async () => { throw new Error("no model call expected on this lane"); },
    contextUsage: async () => 0,
    contextLimit: async () => 0,
  };
}

const frontmatter = (extra: string): string => `---\ntitle: t\nstatus: open\nsessions: []\nretries: 0\n${extra}---\n正文`;

describe("task file — lane fields", () => {
  it("defaults to verify human and not quick", () => {
    const task = parseTaskFile(frontmatter(""), "001");
    expect(task.verify).toBe("human");
    expect(task.quick).toBe(false);
    expect(task.renderTargets).toEqual([]);
  });

  it("round-trips the quick flag and the render declaration", () => {
    const task = parseTaskFile(frontmatter("quick: true\nverify: render\nrender_targets:\n  - dist/index.html\n"), "002");
    expect(task.quick).toBe(true);
    expect(task.verify).toBe("render");
    expect(task.renderTargets).toEqual(["dist/index.html"]);
    const again = parseTaskFile(serializeTaskFile(task), "002");
    expect(again).toEqual(task);
  });

  it("refuses a render check with nothing to render", () => {
    expect(() => parseTaskFile(frontmatter("verify: render\n"), "003")).toThrow(TaskFileError);
  });

  it("refuses an unknown verify kind instead of defaulting", () => {
    expect(() => parseTaskFile(frontmatter("verify: vibes\n"), "004")).toThrow(/verify/);
  });
});

describe("taskctl add — quick lane", () => {
  it("opens without a model call and without a spec", async () => {
    const dir = await mkdtemp(join(tmpdir(), "taskctl-quick-"));
    const adapter = noModel();
    const code = await runCli(["add", "把这个表格的两列合并", "--quick", "--tasks-dir", dir, "--id", "001-merge"], { ...silent, adapter });

    expect(code).toBe(0);
    const task = await new TaskStore(dir).get("001-merge");
    expect(task.status).toBe("open");
    expect(task.quick).toBe(true);
    expect(task.complexity).toBe("simple");
    expect(task.criteria).toEqual([]);
    expect(await readSpec(dir, "001-merge")).toBeNull();
    expect(existsSync(join(dir, "001-merge", "classification.json"))).toBe(false);
    expect((await journalTail(dir, "001-merge", 5)).join("\n")).toMatch(/quick-lane/);
  });

  it("keeps the quick flag out of a spec'd task", async () => {
    const dir = await mkdtemp(join(tmpdir(), "taskctl-quick-"));
    const adapter: AgentAdapter = {
      prompt: async () => ({ sessionId: "s", exitCode: 0, text: "## 目标\n好\n## 验收标准\n- C1 好\n" }),
      contextUsage: async () => 0,
      contextLimit: async () => 0,
    };
    await runCli(["add", "改登录页", "--tasks-dir", dir, "--id", "002-login", "--complex"], { ...silent, adapter });
    expect((await new TaskStore(dir).get("002-login")).quick).toBe(false);
  });

  it("refuses quick work that claims to be high risk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "taskctl-quick-"));
    const errors: string[] = [];
    const code = await runCli(["add", "删掉线上那张表", "--quick", "--risk", "high", "--tasks-dir", dir], {
      log: () => {}, err: (line) => errors.push(line), adapter: noModel(),
    });
    expect(code).toBe(2);
    expect(errors.join("\n")).toMatch(/quick cannot be combined/);
  });
});

describe("taskctl add — verify declaration", () => {
  it("refuses mechanical verification without a command", async () => {
    const dir = await mkdtemp(join(tmpdir(), "taskctl-verify-"));
    const errors: string[] = [];
    const code = await runCli(["add", "跑测试", "--quick", "--verify", "mechanical", "--tasks-dir", dir], {
      log: () => {}, err: (line) => errors.push(line), adapter: noModel(),
    });
    expect(code).toBe(2);
    expect(errors.join("\n")).toMatch(/needs --acceptance/);
  });

  it("refuses a render check with no target", async () => {
    const dir = await mkdtemp(join(tmpdir(), "taskctl-verify-"));
    const errors: string[] = [];
    const code = await runCli(["add", "做个页面", "--quick", "--verify", "render", "--tasks-dir", dir], {
      log: () => {}, err: (line) => errors.push(line), adapter: noModel(),
    });
    expect(code).toBe(2);
    expect(errors.join("\n")).toMatch(/needs at least one --target/);
  });

  it("records targets given as a comma separated list", async () => {
    const dir = await mkdtemp(join(tmpdir(), "taskctl-verify-"));
    const code = await runCli([
      "add", "做个页面", "--quick", "--verify", "render",
      "--target", "dist/index.html, dist/report.html", "--tasks-dir", dir, "--id", "001-page",
    ], { ...silent, adapter: noModel() });
    expect(code).toBe(0);
    const task = await new TaskStore(dir).get("001-page");
    expect(task.verify).toBe("render");
    expect(task.renderTargets).toEqual(["dist/index.html", "dist/report.html"]);
  });
});

/* ---------- worker ---------- */

class FakeStore {
  readonly markers = new Set<string>();
  constructor(readonly tasks: Map<string, Task>) {}
  async list(): Promise<Task[]> { return [...this.tasks.values()]; }
  async setStatus(id: string, status: TaskStatus): Promise<void> { this.tasks.get(id)!.status = status; }
  async appendSession(id: string, sessionId: string): Promise<void> { this.tasks.get(id)!.sessions.push(sessionId); }
  async incRetries(id: string): Promise<number> { return ++this.tasks.get(id)!.retries; }
  async incReviewRounds(id: string): Promise<number> { return ++this.tasks.get(id)!.reviewRounds; }
  async readDoneMarker(id: string): Promise<boolean> { return this.markers.has(id); }
  async clearDoneMarker(id: string): Promise<void> { this.markers.delete(id); }
}

function buildTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    title: overrides.id,
    description: "正文",
    status: "open",
    criteria: ["C1 fixture"],
    complexity: "simple",
    execution: "continuous",
    risk: "normal",
    dependsOn: [],
    humanCheck: false,
    tolerate: [],
    quick: false,
    verify: "human",
    renderTargets: [],
    keepAtRoot: [],
    reviewRounds: 0,
    sessions: [],
    retries: 0,
    ...overrides,
    id: overrides.id,
  };
}

async function workspace(): Promise<{ dir: string; cfg: WorkerConfig }> {
  const dir = await mkdtemp(join(tmpdir(), "taskctl-lane-"));
  await mkdir(join(dir, "workspace"), { recursive: true });
  return {
    dir,
    cfg: {
      tasksDir: dir, workdir: join(dir, "workspace"), agent: "fake", contextThreshold: 0.8,
      retryLimit: 3, lockTtlMs: 30_000, heartbeatMs: 60_000,
    },
  };
}

const passedGate = async (): Promise<AcceptanceResult> => ({ passed: true, skipped: false, exitCode: 0, output: "ok" });

describe("worker — mechanical verification", () => {
  it("finishes on the exit code without asking a reviewer", async () => {
    const { cfg } = await workspace();
    const task = buildTask({ id: "a", verify: "mechanical", acceptance: "npm test" });
    const store = new FakeStore(new Map([[task.id, task]]));
    const review = vi.fn();

    const outcome = await runTask(cfg, {
      store, review,
      adapter: { prompt: async (args) => { await store.clearDoneMarker("a"); store.markers.add("a"); return { sessionId: "s1", exitCode: 0, text: "做完" }; }, contextUsage: async () => 0, contextLimit: async () => 0 },
      acceptance: passedGate,
    }, task, "w1");

    expect(outcome).toBe("done");
    expect(review).not.toHaveBeenCalled();
    expect(store.tasks.get("a")!.status).toBe("done");
  });

  it("escalates a continuous turn without done immediately and resumes the same session", async () => {
    const { cfg } = await workspace();
    const task = buildTask({ id: "a", verify: "mechanical", acceptance: "npm test" });
    const store = new FakeStore(new Map([[task.id, task]]));
    const sessions: (string | undefined)[] = [];
    const review = vi.fn(async () => ({ verdict: "pass" as const, criteria: [{ id: "C1", pass: true, evidence: "ok" }], defects: [], summary: "ok", externalChanges: [] }));
    const adapter: AgentAdapter = {
      prompt: async (args) => {
        sessions.push(args.sessionId);
        if (sessions.length === 1) return { sessionId: "s1", exitCode: 0, text: "还没完成" };
        store.markers.add("a");
        return { sessionId: "s1", exitCode: 0, text: "完成" };
      },
      contextUsage: async () => 0,
      contextLimit: async () => 100,
    };

    const outcome = await runTask(cfg, { store, adapter, acceptance: passedGate, review }, task, "w-continuous");

    expect(outcome).toBe("done");
    expect(sessions).toEqual([undefined, "s1"]);
    expect(review).toHaveBeenCalledTimes(1);
    expect(store.tasks.get("a")!.sessions).toEqual(["s1"]);
  });

  it("still waits for a human when the task is high risk", async () => {
    const { cfg } = await workspace();
    const task = buildTask({ id: "d", verify: "mechanical", acceptance: "npm test", risk: "high" });
    const store = new FakeStore(new Map([[task.id, task]]));
    const review = vi.fn();

    const outcome = await runTask(cfg, {
      store, review,
      adapter: { prompt: async () => { store.markers.add("d"); return { sessionId: "s1", exitCode: 0, text: "做完" }; }, contextUsage: async () => 0, contextLimit: async () => 0 },
      acceptance: passedGate,
    }, task, "w4");

    // A machine verdict is weaker than a reviewer's, not stronger: an exit code
    // does not stand in for the human gate a high-risk task declares.
    expect(outcome).toBe("awaiting-human");
    expect(store.tasks.get("d")!.status).toBe("awaiting-human");
  });

  it("still goes to the reviewer once the worker escalates", async () => {
    const { cfg } = await workspace();
    const task = buildTask({ id: "b", verify: "mechanical", acceptance: "npm test" });
    const store = new FakeStore(new Map([[task.id, task]]));
    const review = vi.fn(async () => ({ verdict: "pass" as const, criteria: [], defects: [], summary: "ok", externalChanges: [], raw: "" }));

    const outcome = await runTask(cfg, {
      store, review,
      adapter: {
        prompt: async () => {
          store.markers.add("b");
          return { sessionId: "s1", exitCode: 0, text: "范围比预想大\nESCALATE: 产物从一张表变成了三张" };
        },
        contextUsage: async () => 0, contextLimit: async () => 0,
      },
      acceptance: passedGate,
    }, task, "w2");

    expect(outcome).toBe("done");
    expect(review).toHaveBeenCalledTimes(1);
    expect(store.tasks.get("b")!.status).toBe("done");
  });

  it("keeps the review requirement across a later settled attempt", async () => {
    const { cfg } = await workspace();
    const task = buildTask({ id: "sticky", verify: "mechanical", acceptance: "npm test" });
    const store = new FakeStore(new Map([[task.id, task]]));
    const review = vi.fn()
      .mockResolvedValueOnce({ verdict: "fail" as const, criteria: [{ id: "C1", pass: false, evidence: "not yet" }], defects: ["fix"], summary: "no", externalChanges: [] })
      .mockResolvedValueOnce({ verdict: "pass" as const, criteria: [{ id: "C1", pass: true, evidence: "ok" }], defects: [], summary: "ok", externalChanges: [] });
    let workerTurns = 0;
    const adapter: AgentAdapter = {
      prompt: async () => {
        workerTurns++;
        store.markers.add("sticky");
        return { sessionId: "s-sticky", exitCode: 0, text: workerTurns === 1 ? "ESCALATE: needs another pass" : "done" };
      },
      contextUsage: async () => 0,
      contextLimit: async () => 100,
    };
    const deps = { store, adapter, acceptance: passedGate, review, };

    expect(await runTask({ ...cfg, maxReviewRounds: 0 }, deps, task, "w-first")).toBe("blocked");
    await store.setStatus("sticky", "open");
    expect(await runTask(cfg, deps, task, "w-second")).toBe("done");
    expect(review).toHaveBeenCalledTimes(2);
  });
});

describe("worker — quick lane terminus", () => {
  it("parks a quick task with no criteria for a human instead of blocking it", async () => {
    const { cfg } = await workspace();
    const task = buildTask({ id: "c", quick: true, criteria: [], acceptance: undefined });
    const store = new FakeStore(new Map([[task.id, task]]));

    const outcome = await runTask(cfg, {
      store,
      adapter: { prompt: async () => { store.markers.add("c"); return { sessionId: "s1", exitCode: 0, text: "做完" }; }, contextUsage: async () => 0, contextLimit: async () => 0 },
    }, task, "w3");

    expect(outcome).toBe("awaiting-human");
    expect(store.tasks.get("c")!.status).toBe("awaiting-human");
  });
});

/* ---------- render ---------- */

const chrome = ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"].find((path) => existsSync(path));

describe("render check — parsing", () => {
  it("reads WIDTHxHEIGHT and rejects anything else", () => {
    expect(parseViewport("1440x900")).toEqual({ width: 1440, height: 900 });
    expect(() => parseViewport("wide")).toThrow(RenderUnavailableError);
  });

  it("says what is wrong in words, not codes", () => {
    const text = describeFailures({
      ok: false, browser: "x", at: "",
      views: [{ target: "a.html", viewport: "390x844", ok: false, problems: ["overflow"], screenshot: "", measurements: { scrollWidth: 0, clientWidth: 0, textLength: 0, images: 0, brokenImages: 0 } }],
    });
    expect(text.join(" ")).toMatch(/横向溢出/);
  });
});

describe.skipIf(!chrome)("render check — real browser", () => {
  it("passes a page that draws and fits, fails one that overflows or dies", async () => {
    const dir = await mkdtemp(join(tmpdir(), "taskctl-render-test-"));
    const good = join(dir, "good.html");
    const wide = join(dir, "wide.html");
    const dead = join(dir, "dead.html");
    await writeFile(good, "<!doctype html><meta charset=utf-8><h1>标题</h1><p>正文</p>", "utf8");
    await writeFile(wide, '<!doctype html><meta charset=utf-8><div style="width:900px">宽</div>', "utf8");
    await writeFile(dead, '<!doctype html><meta charset=utf-8><body><script>throw new Error("boom")</script></body>', "utf8");

    const check = await checkRender({
      targets: [good, wide, dead], viewports: ["390x844"], evidenceDir: join(dir, "evidence"), timeoutMs: 60_000,
    });

    expect(check.ok).toBe(false);
    const byTarget = new Map(check.views.map((view) => [view.target, view]));
    expect(byTarget.get(good)!.problems).toEqual([]);
    expect(byTarget.get(wide)!.problems).toContain("overflow");
    expect(byTarget.get(dead)!.problems).toContain("script-error");
  }, 120_000);
});
