import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.js";
import { TaskStore } from "../src/task-store.js";
import { buildFinding } from "../src/findings.js";
import { buildTaskFile } from "./helpers/task-fixture.js";

const silent = { log: () => {} };

/** A task directory with the artifacts a finding is drawn from. */
async function seed(extra: {
  journal?: string;
  review?: unknown;
  render?: unknown;
  acceptance?: unknown;
  attempt?: unknown;
} = {}): Promise<{ dir: string; id: string }> {
  const dir = await mkdtemp(join(tmpdir(), "taskctl-findings-"));
  const id = "002-unc";
  await writeFile(join(dir, `${id}.md`), [
    "---",
    "title: strip the UNC prefix from the path column",
    "status: blocked",
    `complexity: simple`,
    "sessions:",
    "  - s1",
    "retries: 2",
    "review_rounds: 1",
    "---",
    "正文",
  ].join("\n"), "utf8");
  const taskDir = join(dir, id);
  await mkdir(taskDir, { recursive: true });
  if (extra.journal !== undefined) await writeFile(join(taskDir, "journal.md"), extra.journal, "utf8");
  for (const [name, value] of [
    ["review.json", extra.review],
    ["render.json", extra.render],
    ["acceptance.json", extra.acceptance],
    ["attempt.json", extra.attempt],
  ] as const) {
    if (value !== undefined) await writeFile(join(taskDir, name), JSON.stringify(value, null, 2), "utf8");
  }
  return { dir, id };
}

describe("findings — 从产物里抽事实", () => {
  it("抽到升级、阻塞、复核未过与渲染失败，并保留原始行", async () => {
    const { dir, id } = await seed({
      journal: [
        "2026-11-17T01:00:00.000Z  worker  escalated  产物从一张表变成三张",
        "2026-11-17T01:10:00.000Z  review  started  criteria=2",
        "2026-11-17T01:12:00.000Z  review  blocked  stalled: the failing criteria are unchanged from round 1 (C2)",
        "2026-11-17T01:12:00.000Z  worker  acceptance  failed exit=1",
      ].join("\n") + "\n",
      review: {
        verdict: "fail",
        model: "fake/reviewer",
        criteria: [
          { id: "C1", pass: true, evidence: "读了 dist/index.html，看到 3 个区块" },
          { id: "C2", pass: false, evidence: "读了 dist/index.html，未看到页脚" },
        ],
        defects: ["🔴 页脚缺失"],
      },
      render: { ok: false, views: [{ target: "dist/index.html", viewport: "390x844", problems: ["overflow"] }] },
      attempt: { phase: "settled" },
    });

    const task = await new TaskStore(dir).get(id);
    const draft = await buildFinding(dir, task, new Date("2026-11-17T02:00:00Z"));

    expect(draft.slug.startsWith("2026-11-17-strip-the-unc-prefix")).toBe(true);
    expect(draft.slug.length).toBeLessThanOrEqual(51);
    expect(draft.signals).toBeGreaterThanOrEqual(6);
    for (const expected of ["升级", "阻塞", "未过 C2", "页脚缺失", "渲染失败", "验收命令失败"]) {
      expect(draft.markdown).toContain(expected);
    }
    // 证据是摘录原文，不是指针：别的机器上没有这个任务目录。
    expect(draft.markdown).toContain("2026-11-17T01:00:00.000Z  worker  escalated");
    expect(draft.markdown).toContain("## 复现条件");
    expect(draft.markdown).toContain("（待填");
  });

  it("没有信号的安静任务也出一份草稿，并说明没抽到东西", async () => {
    // 一件真的一路顺风的任务：没有返工、没有交接、没有失败产物。
    const dir = await mkdtemp(join(tmpdir(), "taskctl-findings-"));
    const task = buildTaskFile({ id: "quiet", title: "quiet run" });
    const draft = await buildFinding(dir, task);

    expect(draft.signals).toBe(0);
    expect(draft.markdown).toContain("没有从产物里抽到机器可查的信号");
    expect(draft.markdown).toContain("（无原始行）");
  });

  it("全中文标题退到任务 id 做 slug，而不是抽出一个孤立英文词", async () => {
    const dir = await mkdtemp(join(tmpdir(), "taskctl-findings-"));
    await writeFile(join(dir, "007-x.md"), "---\ntitle: 把这张表的 UNC 列去掉\nstatus: done\nsessions: []\nretries: 0\n---\n正文", "utf8");
    const task = await new TaskStore(dir).get("007-x");
    const draft = await buildFinding(dir, task, new Date("2026-11-17T00:00:00Z"));
    expect(draft.slug).toBe("2026-11-17-007-x");
  });
});

describe("taskctl findings", () => {
  it("默认打印，不落文件", async () => {
    const { dir, id } = await seed({});
    const lines: string[] = [];
    const code = await runCli(["findings", "--task", id, "--tasks-dir", dir], { log: (line) => lines.push(line) });

    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("## 观察到什么");
    await expect(readFile(join(dir, "2026-11-17-x.md"), "utf8")).rejects.toThrow();
  });

  it("--out 落盘并打印路径与信号数", async () => {
    const { dir, id } = await seed({ journal: "2026-11-17T01:00:00.000Z  worker  escalated  大了\n" });
    const out = join(dir, "docs", "findings", "2026-11-17-002-unc.md");
    const lines: string[] = [];
    const code = await runCli(["findings", "--task", id, "--tasks-dir", dir, "--out", out], { log: (line) => lines.push(line) });

    expect(code).toBe(0);
    expect(lines.join("\n")).toMatch(/signals=\d+/);
    expect(await readFile(out, "utf8")).toContain("运行期判断这件事比开单时更大");
  });

  it("找不到任务时返回 1 并说明", async () => {
    const dir = await mkdtemp(join(tmpdir(), "taskctl-findings-"));
    const lines: string[] = [];
    const code = await runCli(["findings", "--task", "nope", "--tasks-dir", dir], { log: (line) => lines.push(line) });
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("not found");
  });
});

describe("findings — 与其他入口不打架", () => {
  it("task 文件里的 verify/quick 也写进计数行", async () => {
    const dir = await mkdtemp(join(tmpdir(), "taskctl-findings-"));
    const task = buildTaskFile({ id: "010", title: "page", quick: true, verify: "render", renderTargets: ["a.html"] });
    const draft = await buildFinding(dir, task);
    expect(draft.markdown).toContain("verify=render（快速车道）");
  });
});
