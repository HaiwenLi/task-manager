import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactDigest } from "../src/workspace.js";
import { writeRuntime, writeRuntimeText } from "../src/runtime.js";
import { REWORK_FILE, REWORK_OUTPUT_CHARS, readRwork, renderRwork, reworkPathOf, type ReworkFeedback } from "../src/rework.js";

let root: string;
let tasks: string;
let work: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "taskctl-rework-"));
  tasks = join(root, "tasks");
  work = join(root, "work");
  await mkdir(tasks);
  await mkdir(work);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("renderRwork", () => {
  const base = { task: { id: "a", title: "任务 A" }, tasksDir: "T", at: "2026-11-25T10:00:00.000Z" };
  const text = (...lines: string[]) => `${lines.join("\n")}\n`;
  const header = ["# 返工说明：任务 A（a）", "", "写于 2026-11-25T10:00:00.000Z。上一回合没有通过：先读完这份说明，再动手。", ""];
  const done = '- 改完后请求完成：taskctl done --task a --tasks-dir "T"';
  const acceptance: ReworkFeedback = { kind: "acceptance", command: "npm test", exitCode: 1, output: "断言失败： expected 2, got 1" };

  it("tells an acceptance failure from the exit code, the command and the output, and says what to do", () => {
    expect(renderRwork({ ...base, feedback: acceptance })).toBe(text(
      ...header,
      "## 上一回合为什么没有通过",
      "",
      "控制器的验收命令失败了（exit 1）。验收命令退出 0，任务才能进入下一步。",
      "",
      "验收命令：npm test",
      "",
      "验收输出：",
      "",
      "断言失败： expected 2, got 1",
      "",
      "## 需要改变什么",
      "",
      "- 按上面的验收输出修复；输出被截断时，先读完整的验收记录再判断。",
      "- 先做有界的定向自验（任务声明了 worker_self_check 就用 taskctl check），不要反复重跑全量验收。",
      done,
    ));
  });

  it("says a gate that could not start as exit null, and a silent one as silent", () => {
    const doc = renderRwork({ ...base, feedback: { kind: "acceptance", command: "npm test", exitCode: null, output: "" } });
    expect(doc).toContain("控制器的验收命令失败了（exit null）。");
    expect(doc).toContain("验收命令没有留下任何输出。");
    expect(doc).not.toContain("验收输出：");
  });

  it("keeps the tail of a long acceptance output and says where the whole of it is", () => {
    const output = `${"头".repeat(5_000)}${"尾".repeat(1_500)}`;
    const doc = renderRwork({ ...base, feedback: { kind: "acceptance", command: "npm test", exitCode: 1, output } });
    expect(doc).toContain("尾".repeat(1_500));
    expect(doc).not.toContain("头".repeat(2_501));
    expect(doc).toContain(
      `验收输出（只保留结尾 ${REWORK_OUTPUT_CHARS} 个字符，前面省略 2500 个字符；`
      + `完整输出在 ${join("T", "a", "acceptance.json")} 的 output 字段，被 taskctl retry 归档后在 ${join("T", "a", "archive")} 下）：`,
    );
  });

  it("counts code points, not UTF-16 units, when it cuts", () => {
    const output = `x${"😀".repeat(REWORK_OUTPUT_CHARS + 1)}`;
    const doc = renderRwork({ ...base, feedback: { kind: "acceptance", command: "npm test", exitCode: 1, output } });
    expect(doc).toContain("😀".repeat(REWORK_OUTPUT_CHARS));
    expect(doc).toContain("前面省略 2 个字符");
    expect(doc).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  it("turns CRLF and CR into LF and changes nothing else in the output", () => {
    const doc = renderRwork({ ...base, feedback: { kind: "acceptance", command: "npm test", exitCode: 1, output: "a\r\nb\rc  two  spaces" } });
    expect(doc).toContain("\n\na\nb\nc  two  spaces\n\n");
  });

  it("lists each failed criterion with the reviewer's evidence, then the defects to fix", () => {
    const feedback: ReworkFeedback = {
      kind: "review", round: 2, summary: "未达 C1",
      failed: [{ id: "C1", pass: false, evidence: "读了 src/a.ts，看到宽度写死" }],
      defects: ["🔴 宽度改为自适应", "🟡 文案不一致"],
    };
    expect(renderRwork({ ...base, feedback })).toBe(text(
      ...header,
      "## 上一回合为什么没有通过",
      "",
      "独立复核没有通过（第 2 轮）：未达 C1",
      "",
      "没有通过的验收标准，以及复核者看到的依据：",
      "",
      "- C1：读了 src/a.ts，看到宽度写死",
      "",
      "## 需要改变什么",
      "",
      "- 🔴 宽度改为自适应",
      "- 🟡 文案不一致",
      done,
    ));
  });

  it("says so when the reviewer gave no summary, no evidence or no defects", () => {
    const doc = renderRwork({ ...base, feedback: { kind: "review", round: 1, summary: "", failed: [{ id: "C2", pass: false, evidence: "" }], defects: [] } });
    expect(doc).toContain("独立复核没有通过（第 1 轮）：复核未通过");
    expect(doc).toContain("- C2：（复核者没有给出依据）");
    expect(doc).toContain("- 按上面没有通过的验收标准返工。");
  });

  it("cuts one piece of reviewer evidence or one defect at a thousand characters", () => {
    const doc = renderRwork({
      ...base,
      feedback: { kind: "review", round: 1, summary: "s", failed: [{ id: "C1", pass: false, evidence: "证".repeat(1_200) }], defects: ["缺".repeat(1_200)] },
    });
    expect(doc).toContain(`- C1：${"证".repeat(1_000)}…`);
    expect(doc).toContain(`- ${"缺".repeat(1_000)}…`);
    expect(doc).not.toContain("证".repeat(1_001));
  });

  it("names each view that failed the render check and where its screenshot is", () => {
    const failures = ["W\\index.html @ 390x844: 横向溢出：页面比视口宽，内容被裁掉或需要横向滚动"];
    expect(renderRwork({ ...base, feedback: { kind: "render", failures } })).toBe(text(
      ...header,
      "## 上一回合为什么没有通过",
      "",
      "渲染验收失败：下面的页面在下面的视口上，没有同时做到画得出来、有可读内容、不横向溢出、没有未捕获异常。",
      "",
      "- W\\index.html @ 390x844: 横向溢出：页面比视口宽，内容被裁掉或需要横向滚动",
      "",
      "## 需要改变什么",
      "",
      `- 修到每个目标页面在每个视口上都满足上面四条。失败那一屏的截图在 ${join("T", "a", "evidence")}，先看它。`,
      done,
    ));
  });

  it("tells a turn that did not ask to be judged why that matters and what to do, and keeps the reasons it was already sent back for", () => {
    const why = "上一回合正常结束，但没有请求完成（没有运行 taskctl done）。连续执行的任务本应在一个回合内做完并请求验收；没有做到，任务已升级为迭代执行（iterative）。控制器没有可以验收的成果。";
    expect(renderRwork({ ...base, feedback: { kind: "no-completion", why, previous: null } })).toBe(text(
      ...header,
      "## 上一回合为什么没有通过",
      "",
      why,
      "",
      "## 需要改变什么",
      "",
      `- 已经做完：请求完成，taskctl done --task a --tasks-dir "T"`,
      "- 还没做完：继续做，并用 taskctl note 记下现状、卡点和下一步。",
      "- 任务比声明的更大：单独输出一行 ESCALATE: <原因>。",
    ));
    const carried = renderRwork({ ...base, feedback: { kind: "no-completion", why, previous: acceptance } });
    expect(carried).toContain("## 仍然适用的上一轮否决\n\n## 上一回合为什么没有通过\n\n控制器的验收命令失败了（exit 1）。");
    expect(carried.match(/^# /gm)).toHaveLength(1);
    expect(carried.match(/## 仍然适用的上一轮否决/g)).toHaveLength(1);
  });

  it("carries a document written by an earlier attempt under one heading", () => {
    const earlier = renderRwork({ ...base, at: "2026-11-25T09:00:00.000Z", feedback: acceptance });
    expect(renderRwork({ ...base, feedback: { kind: "carried", markdown: earlier } }))
      .toBe(earlier.replace("写于 2026-11-25T09:00:00.000Z", "写于 2026-11-25T10:00:00.000Z"));
  });

  it("adds the worker's own ESCALATE reason when it gave one, after everything else", () => {
    const doc = renderRwork({
      ...base, feedback: { kind: "no-completion", why: "没有请求完成。", previous: null }, escalation: "产物从一张表变成了三张",
    });
    expect(doc.endsWith(
      "## 需要改变什么\n\n- 已经做完：请求完成，taskctl done --task a --tasks-dir \"T\"\n"
      + "- 还没做完：继续做，并用 taskctl note 记下现状、卡点和下一步。\n"
      + "- 任务比声明的更大：单独输出一行 ESCALATE: <原因>。\n\n"
      + "## 你在上一回合提出的升级\n\nESCALATE: 产物从一张表变成了三张\n\n"
      + "本任务因此升级为迭代执行：此后必须经过独立复核，不能再用自己的证据收尾。\n",
    )).toBe(true);
  });
});

describe("rework.md on disk", () => {
  it("writeRuntimeText writes text verbatim, replaces what was there, and leaves no temp file", async () => {
    await mkdir(join(tasks, "a"));
    await writeRuntimeText(tasks, "a", REWORK_FILE, "# 一\n\nbody\r\n");
    expect(await readFile(reworkPathOf(tasks, "a"), "utf8")).toBe("# 一\n\nbody\r\n");
    await writeRuntimeText(tasks, "a", REWORK_FILE, "# 二\n");
    expect(await readRwork(tasks, "a")).toBe("# 二\n");
    expect(await readRwork(tasks, "nobody")).toBeNull();
    expect(await readdir(join(tasks, "a"))).toEqual([REWORK_FILE]);
  });

  it("writeRuntime lands the same way", async () => {
    await mkdir(join(tasks, "a"));
    await writeRuntime(tasks, "a", "x.json", { b: [1] });
    expect(JSON.parse(await readFile(join(tasks, "a", "x.json"), "utf8"))).toEqual({ b: [1] });
    expect(await readdir(join(tasks, "a"))).toEqual(["x.json"]);
  });

  it("sits outside the artifact digest", async () => {
    // The tasks directory inside the workspace is excluded from the digest the
    // acceptance gate compares; the document must not be able to invalidate evidence.
    const inside = join(work, "tasks");
    await mkdir(join(inside, "a"), { recursive: true });
    await writeFile(join(work, "src.txt"), "source", "utf8");
    const before = await artifactDigest(work, [inside]);
    await writeRuntimeText(inside, "a", REWORK_FILE, "# 返工说明\n");
    expect(await artifactDigest(work, [inside])).toBe(before);
    // Control: the file is real, and would count from anywhere else in the tree.
    expect(await artifactDigest(work)).not.toBe(before);
  });
});
