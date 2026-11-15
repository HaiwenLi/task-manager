# taskctl 复核流水线实现计划（P1）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 taskctl 支持「澄清 → 确认 → 执行 → 独立复核 → 返工/放行 → 抽查归因」的完整 CLI 闭环，并且能多任务并行。

**Architecture:** 在现有 Markdown 权威、fencing、工作区独占之上加阶段：`draft`（等签字）与 `awaiting-human`（等放行）是人工节点，`review` 是编排器内部短阶段。spec 与 criteria 落在任务文件与 `tasks/<id>/spec.md`，复核会话拿证据而不是 worker 对话；人工判定写入 `.taskctl/audits.jsonl` 并归因到环节。

**Tech Stack:** TypeScript 7、Node 22+、Vitest 5、现有 `jsonl` 风格运行记录；不新增运行时依赖。

**Spec:** `docs/superpowers/specs/2026-11-16-review-loop-design.md`

## Global Constraints

- Markdown 是任务状态的唯一权威；运行记录（`attempt.json`/`acceptance.json`/`review.json`/`journal.md`）只拥有事实。
- 保持 ADR-0007 语义：所有权代次、心跳全程、工作区独占、不确定执行不重跑、缺验收 fail-closed。
- 不新增运行时依赖；CLI 用现有的手写参数解析。
- 退出码：`0` 成功、`1` 运行错误、`2` 用法错误。
- 任务文件写入必须走 `<file>.tmp` + rename（`TaskStore` 已有）；`.taskctl/board.md` 同样，浏览器不能读到半个文件。
- `.taskctl/board.md` 是可再生生成物，不承载状态；任何命令都不得从它读回状态。
- 所有新命令在 `taskctl.json` 缺省时使用默认值，不得要求用户先写配置。
- 中文字符串必须按 UTF-8 原样落盘；日志按行截断时不得切断多字节字符。

## Review Focus

1. 意图里没有任何可验收信息、也没标简单：澄清会话可能编出看似可判定的 criteria。必须停在 `draft` 等人签字，不得自动 `open`。
2. `spec.md` 被手工改坏、或 criteria 与 frontmatter 不一致：复核只能按 frontmatter 的 criteria 判，解析不出就报错，不得猜测或跳过。
3. 复核模型没有输出干净 JSON（前面加解释、用 ```json 包起来、或干脆写散文）：解析失败一律按 `unclear` 转人工，不得当 `fail` 触发重跑。
4. 两个任务共用同一个 workdir 且都已批准：调度只能让一个进 `running`，另一个等待；不得两个同时跑。
5. `depends_on` 指向不存在、指向自己、或形成环：解析时报错，不得静默跳过导致永不执行。
6. 任务处于 `draft` 或 `awaiting-human` 时被 `run` 扫到：不得领取，也不得改写状态。

---

### Task 1: 任务模型扩展

**Files:**
- Modify: `src/task-file.ts`
- Test: `tests/task-file.test.ts`

**Interfaces:**
- Produces: `TaskStatus = "draft" | "open" | "running" | "review" | "awaiting-human" | "done" | "blocked"`；`Task` 新增
  `complexity: "simple" | "complex"`、`risk: "normal" | "high"`、`criteria: string[]`、
  `workdir?: string`、`dependsOn: string[]`、`humanCheck: boolean`、`reviewRounds: number`。

- [ ] **Step 1: 写失败的测试**

```ts
test("round-trips the new fields", () => {
  const task = parseTaskFile(`---
title: 登录页改版
status: draft
complexity: complex
risk: high
criteria:
  - 登录接口 401 时前端提示文案正确
  - npm test 全绿
workdir: packages/web
depends_on:
  - 003-api
human_check: true
sessions: []
retries: 0
review_rounds: 2
---
正文`, "005-login");
  expect(task.criteria).toHaveLength(2);
  expect(task.dependsOn).toEqual(["003-api"]);
  expect(task.reviewRounds).toBe(2);
  expect(parseTaskFile(serializeTaskFile(task), task.id)).toEqual(task);
});

test("defaults when optional fields are absent", () => {
  const task = parseTaskFile(`---\ntitle: x\nstatus: open\nsessions: []\nretries: 0\n---\n`, "001-x");
  expect(task.complexity).toBe("complex");
  expect(task.risk).toBe("normal");
  expect(task.criteria).toEqual([]);
  expect(task.dependsOn).toEqual([]);
  expect(task.humanCheck).toBe(false);
  expect(task.reviewRounds).toBe(0);
});

test("rejects an unknown status", () => {
  expect(() => parseTaskFile(`---\ntitle: x\nstatus: shipped\nsessions: []\nretries: 0\n---\n`, "001-x"))
    .toThrow(/unknown status/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run tests/task-file.test.ts`
Expected: FAIL —— `criteria` 为 undefined、`draft` 状态被拒。

- [ ] **Step 3: 实现**

`STATUSES` 加 `draft`、`review`、`awaiting-human`。新增解析函数 `parseCriteria`（数组，元素非空字符串）、`parseDependsOn`（数组，元素非空且不等于自身 id，否则 `TaskFileError`）、`parseComplexity`、`parseRisk`、`parseHumanCheck`、`parseReviewRounds`。`serializeTaskFile` 的 frontmatter 键名用下划线：`depends_on`、`human_check`、`review_rounds`；`complexity` 与 `review_rounds` 总是写，`risk` 仅 `high` 时写，`workdir` 仅存在时写，`criteria`/`depends_on` 仅非空时写。

循环检测不在解析层做（需要全量任务视图），放在 Task 9 调度器里。

- [ ] **Step 4: 跑测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run tests/task-file.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/task-file.ts tests/task-file.test.ts
git commit -m "feat(task-file): add draft/review/awaiting-human statuses and pipeline fields"
```

---

### Task 2: 任务库写入原语

**Files:**
- Modify: `src/task-store.ts`
- Test: `tests/task-store.test.ts`

**Interfaces:**
- Produces: `TaskStore.incReviewRounds(id): Promise<number>`；`TaskStore.updateFields(id, patch: Partial<Pick<Task, "status" | "criteria" | "workdir" | "complexity" | "risk" | "humanCheck" | "dependsOn">>): Promise<T>`

- [ ] **Step 1: 写失败的测试**

```ts
test("incReviewRounds increments and persists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tc-"));
  await writeFile(join(dir, "001-a.md"), `---\ntitle: a\nstatus: review\nsessions: []\nretries: 0\nreview_rounds: 1\n---\n`);
  const store = new TaskStore(dir);
  expect(await store.incReviewRounds("001-a")).toBe(2);
  expect((await store.get("001-a")).reviewRounds).toBe(2);
});

test("updateFields patches only listed keys and keeps criteria order", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tc-"));
  await writeFile(join(dir, "001-a.md"), `---\ntitle: a\nstatus: draft\nsessions: []\nretries: 0\n---\n`);
  const store = new TaskStore(dir);
  await store.updateFields("001-a", { status: "open", criteria: ["C1 甲", "C2 乙"] });
  const task = await store.get("001-a");
  expect(task.status).toBe("open");
  expect(task.criteria).toEqual(["C1 甲", "C2 乙"]);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run tests/task-store.test.ts`
Expected: FAIL —— `incReviewRounds is not a function`。

- [ ] **Step 3: 实现**

两个方法都走已有的私有 `update`（tmp + rename）。`incReviewRounds` 返回新值；`updateFields` 只赋值 patch 里出现的键，返回更新后的任务。

- [ ] **Step 4: 跑测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run tests/task-store.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/task-store.ts tests/task-store.test.ts
git commit -m "feat(store): add review-round and field patch primitives"
```

---

### Task 3: 运行日志

**Files:**
- Create: `src/journal.ts`
- Test: `tests/journal.test.ts`

**Interfaces:**
- Produces: `appendJournal(tasksDir: string, id: string, entry: { stage: string; event: string; detail?: string }): Promise<void>`；
  `journalTail(tasksDir: string, id: string, n: number): Promise<string[]>`

- [ ] **Step 1: 写失败的测试**

```ts
test("appends one line per event and tails the last n", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tc-"));
  await appendJournal(dir, "001-a", { stage: "clarify", event: "spec-drafted", detail: "criteria=2" });
  await appendJournal(dir, "001-a", { stage: "review", event: "verdict", detail: "fail" });
  const tail = await journalTail(dir, "001-a", 1);
  expect(tail).toHaveLength(1);
  expect(tail[0]).toMatch(/review\s+verdict\s+fail$/);
  expect((await journalTail(dir, "002-missing", 5))).toEqual([]);
});

test("keeps UTF-8 detail intact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tc-"));
  await appendJournal(dir, "001-a", { stage: "worker", event: "note", detail: "导出按钮宽度写死" });
  expect((await journalTail(dir, "001-a", 1))[0]).toContain("导出按钮宽度写死");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run tests/journal.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

行格式 `${ISO 时间}  ${stage}  ${event}${detail ? "  " + detail : ""}`，`detail` 里的换行替换成 `⏎`，单行上限 500 字符（按码点截断，用 `Array.from` 后切片，避免切断代理对）。文件 `tasks/<id>/journal.md`，`appendFile` 追加。

- [ ] **Step 4: 跑测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run tests/journal.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/journal.ts tests/journal.test.ts
git commit -m "feat(journal): append-only per-task run log"
```

---

### Task 4: 澄清模板与复杂度判定

**Files:**
- Create: `src/intake.ts`
- Test: `tests/intake.test.ts`

**Interfaces:**
- Produces: `type TaskType = "code" | "office" | "research" | "design"`；
  `TEMPLATES: Record<TaskType, { required: string[]; infer: string[]; ask: string[] }>`；
  `detectComplexity(intent: string): "simple" | "complex"`；
  `detectType(intent: string): TaskType`；
  `buildClarifyPrompt(args: { task: Task; type: TaskType; profile: string | null }): string`

- [ ] **Step 1: 写失败的测试**

```ts
test("only an explicit statement downgrades to simple", () => {
  expect(detectComplexity("这是个简单任务：修一下 README 的错字")).toBe("simple");
  expect(detectComplexity("simple: fix typo")).toBe("simple");
  expect(detectComplexity("重构登录模块")).toBe("complex");
  expect(detectComplexity("不太复杂，改个文案")).toBe("complex");
});

test("clarify prompt carries the template, the intent and forbids inventing criteria", () => {
  const task = parseTaskFile(`---\ntitle: 登录改版\nstatus: draft\nsessions: []\nretries: 0\n---\n这是个简单任务：改登录页`, "001-a");
  const prompt = buildClarifyPrompt({ task, type: "code", profile: null });
  expect(prompt).toContain("改动后是什么样");
  expect(prompt).toContain("不许把无法判定的东西写成可判定");
  expect(prompt).toContain("最多 3 条");
  expect(prompt).toContain("## 目标");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run tests/intake.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

`detectComplexity` 只认显式声明：`/简单任务|这是个简单任务|simple:/i`；「不复杂」「不太复杂」不算。`detectType` 关键词命中：调研/研究/分析 → `research`；设计/视觉/排版/PPT → `design`；文档/表格/报告/邮件 → `office`；其余 `code`。`buildClarifyPrompt` 拼出：角色、必答/可推/补问三段、spec 的六个二级标题（目标/非目标/验收标准/边界/假设/模糊表述）、硬规则（可推的不问；最多补问 3 条；不能把无法判定的写成可判定；criteria 每条以 `C1` 起编号）、以及 `profile` 存在时整段注入。

- [ ] **Step 4: 跑测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run tests/intake.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/intake.ts tests/intake.test.ts
git commit -m "feat(intake): templates, complexity and type detection, clarify prompt"
```

---

### Task 5: spec 落盘与 criteria 提取

**Files:**
- Create: `src/spec.ts`
- Test: `tests/spec.test.ts`

**Interfaces:**
- Produces: `writeSpec(tasksDir, id, markdown): Promise<string>`（返回绝对路径）；
  `readSpec(tasksDir, id): Promise<string | null>`；
  `extractCriteria(specMarkdown: string): string[]`（从 `## 验收标准` 段的 `C1`/`C2` 行提取，保留编号前缀，至少 1 条否则抛 `SpecError`）

- [ ] **Step 1: 写失败的测试**

```ts
test("extracts numbered criteria from the acceptance section", () => {
  const spec = `## 目标\n好\n## 验收标准\n- C1 npm test 全绿\n- C2 401 时文案正确\n## 边界\n无`;
  expect(extractCriteria(spec)).toEqual(["C1 npm test 全绿", "C2 401 时文案正确"]);
});

test("throws when the acceptance section has no numbered item", () => {
  expect(() => extractCriteria(`## 目标\n好\n## 验收标准\n大概能用就行`)).toThrow(/至少一条/);
});

test("writeSpec then readSpec round-trips", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tc-"));
  await writeSpec(dir, "001-a", "## 目标\n好");
  expect(await readSpec(dir, "001-a")).toContain("## 目标");
  expect(await readSpec(dir, "002-b")).toBeNull();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run tests/spec.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

`extractCriteria` 找到 `## 验收标准` 起始行与下一个 `##` 之间的文本，逐行匹配 `/^\s*[-*]\s*(C\d+)\s+(.+)$/`，输出 `${id} ${text}`；无匹配抛 `SpecError("验收标准至少一条，且需以 C1、C2 编号")`。`writeSpec` 写 `tasks/<id>/spec.md`（先建目录），`readSpec` 缺失返回 `null`。

- [ ] **Step 4: 跑测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run tests/spec.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/spec.ts tests/spec.test.ts
git commit -m "feat(spec): persist spec.md and extract numbered criteria"
```

---

### Task 6: `taskctl add` —— 意图落盘并起草 spec

**Files:**
- Modify: `src/cli.ts`、`src/intake.ts`（新增 `nextTaskId`）
- Test: `tests/cli-add.test.ts`

**Interfaces:**
- Consumes: `buildClarifyPrompt`、`detectComplexity`、`detectType`、`writeSpec`、`extractCriteria`、`TaskStore.updateFields`
- Produces: `nextTaskId(tasksDir: string, title: string): Promise<string>`；
  CLI `taskctl add "<意图>" [--type <t>] [--simple] [--id <id>] [--tasks-dir <dir>] [--config <path>]`
- 行为：写任务文件（`status: draft`、`description` 为原话、`complexity` 按 `--simple` 或 `detectComplexity`）→ 跑一次澄清会话（新会话，`adapter.prompt`）→ 取输出里的 markdown 写 `spec.md` → 提取 criteria 写入 frontmatter → `simple` 时置 `open`，否则留 `draft` → 全程写 journal。

- [ ] **Step 1: 写失败的测试**

```ts
test("complex intent lands in draft with spec and criteria", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tc-"));
  const adapter = fakeAdapter(`## 目标\n改好\n## 验收标准\n- C1 npm test 全绿\n- C2 文案正确\n`);
  const code = await runCli(["add", "重构登录模块", "--tasks-dir", dir, "--id", "001-login"],
    { adapter, log: () => {} });
  expect(code).toBe(0);
  const task = await new TaskStore(dir).get("001-login");
  expect(task.status).toBe("draft");
  expect(task.complexity).toBe("complex");
  expect(task.criteria).toEqual(["C1 npm test 全绿", "C2 文案正确"]);
  expect(await readSpec(dir, "001-login")).toContain("## 目标");
});

test("explicit simple intent goes straight to open but still keeps a spec", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tc-"));
  const adapter = fakeAdapter(`## 目标\n修好\n## 验收标准\n- C1 错字为零\n`);
  await runCli(["add", "这是个简单任务：修 README 错字", "--tasks-dir", dir, "--id", "002-typo"],
    { adapter, log: () => {} });
  const task = await new TaskStore(dir).get("002-typo");
  expect(task.status).toBe("open");
  expect(await readSpec(dir, "002-typo")).not.toBeNull();
});

test("a spec without numbered criteria keeps the task in draft and logs the failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tc-"));
  const adapter = fakeAdapter(`## 目标\n改好\n## 验收标准\n差不多就行\n`);
  const code = await runCli(["add", "重构登录模块", "--tasks-dir", dir, "--id", "003-x"],
    { adapter, log: () => {} });
  expect(code).toBe(1);
  expect((await new TaskStore(dir).get("003-x")).status).toBe("draft");
  expect((await journalTail(dir, "003-x", 5)).join("\n")).toMatch(/spec-invalid/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run tests/cli-add.test.ts`
Expected: FAIL —— `unknown command "add"`。

- [ ] **Step 3: 实现**

`nextTaskId`：扫 `tasks/*.md` 取数字前缀最大值 + 1，补三位；slug 由 title 取 ASCII 字母数字与 `-`，中文标题回退 `task`。`add` 需要适配器：`deps.adapter ?? new OpenCodeAdapter({ bin: cfg.opencodeBin })`；会话用新 session（不传 sessionId），`model/effort` 取配置。P1 的 `profile` 参数固定传 `null`（读 `.taskctl/profile.md` 是 P2）。adapter 失败或 `extractCriteria` 抛 `SpecError` 时：任务留 `draft`、journal 写 `spec-invalid` 或 `clarify-failed`、返回 1（不删任务文件，便于人工修）。

- [ ] **Step 4: 跑测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run tests/cli-add.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/cli.ts src/intake.ts tests/cli-add.test.ts
git commit -m "feat(cli): add command drafts spec and criteria from an intent"
```

---

### Task 7: `spec` 与 `approve`

**Files:**
- Modify: `src/cli.ts`
- Test: `tests/cli-approve.test.ts`

**Interfaces:**
- Produces: `taskctl spec <id>`（打印 spec.md 或 `(no spec)`，退出 0）；
  `taskctl approve <id>`（`draft` → `open`，写 journal `approved`）

- [ ] **Step 1: 写失败的测试**

```ts
test("approve moves draft to open and refuses other states", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tc-"));
  await writeTask(dir, "001-a", { status: "draft", criteria: ["C1 x"] });
  expect(await runCli(["approve", "--task", "001-a", "--tasks-dir", dir], { log: () => {} })).toBe(0);
  expect((await new TaskStore(dir).get("001-a")).status).toBe("open");
  expect(await runCli(["approve", "--task", "001-a", "--tasks-dir", dir], { log: () => {} })).toBe(1);
});

test("approve refuses a draft with no criteria", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tc-"));
  await writeTask(dir, "002-b", { status: "draft", criteria: [] });
  expect(await runCli(["approve", "--task", "002-b", "--tasks-dir", dir], { log: () => {} })).toBe(1);
  expect((await new TaskStore(dir).get("002-b")).status).toBe("draft");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run tests/cli-approve.test.ts`
Expected: FAIL —— `unknown command "approve"`。

- [ ] **Step 3: 实现**

两个命令都要求 `--task`；`approve` 只接受 `draft`（其他状态报「task is <status>, expected draft」返回 1），且 `criteria.length > 0`（否则提示先补验收标准）。

- [ ] **Step 4: 跑测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run tests/cli-approve.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/cli.ts tests/cli-approve.test.ts
git commit -m "feat(cli): spec and approve commands gate the draft state"
```

---

### Task 8: 复核判定与证据提示词

**Files:**
- Create: `src/review.ts`
- Test: `tests/review.test.ts`

**Interfaces:**
- Produces: `type Verdict = "pass" | "fail" | "unclear"`；
  `type ReviewResult = { verdict: Verdict; criteria: Array<{ id: string; pass: boolean; evidence: string }>; defects: string[]; summary: string }`；
  `parseVerdict(text: string, criteria: string[]): ReviewResult`；
  `buildReviewPrompt(evidence: { task: Task; spec: string; acceptanceMarkdown: string; handoff: string | null; journal: string[] }): string`；
  `runReview(deps: { adapter: AgentAdapter; cwd: string; tasksDir: string; model?: string; effort?: string }, evidence: Parameters<typeof buildReviewPrompt>[0]): Promise<ReviewResult>`

- [ ] **Step 1: 写失败的测试**

```ts
const criteria = ["C1 npm test 全绿", "C2 401 时文案正确"];

test("parses a bare JSON verdict", () => {
  const r = parseVerdict(`{"verdict":"pass","criteria":[{"id":"C1","pass":true,"evidence":"exit 0"}],"defects":[],"summary":"ok"}`, criteria);
  expect(r.verdict).toBe("pass");
  expect(r.criteria).toHaveLength(1);
});

test("parses a fenced JSON verdict surrounded by prose", () => {
  const text = `我先看了下。\n\`\`\`json\n{"verdict":"fail","criteria":[{"id":"C1","pass":false,"evidence":"exit 1"}],"defects":["宽度仍写死"],"summary":"未达 C1"}\n\`\`\`\n请返工。`;
  expect(parseVerdict(text, criteria).defects).toEqual(["宽度仍写死"]);
});

test("unparsable output becomes unclear, never fail", () => {
  expect(parseVerdict("我觉得还行，但说不好。", criteria).verdict).toBe("unclear");
  expect(parseVerdict(`{"verdict":"maybe"}`, criteria).verdict).toBe("unclear");
});

test("a criterion the reviewer omitted counts as not passed", () => {
  const r = parseVerdict(`{"verdict":"pass","criteria":[{"id":"C1","pass":true,"evidence":"ok"}],"defects":[],"summary":"ok"}`, criteria);
  expect(r.verdict).toBe("unclear");
  expect(r.criteria.find((c) => c.id === "C2")?.pass).toBe(false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run tests/review.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

`parseVerdict` 先扫 ```json 代码块，再扫第一个 `{` 到最后一个 `}`，`JSON.parse`；字段校验：`verdict` 必须在三个值内，`criteria` 必须是数组且元素 `id` 为字符串。criterion 的 id 取 `criteria` 数组里每条的首个空格前 token（`"C1 npm test 全绿"` → `"C1"`），用它与 reviewer 返回的 `id` 对齐。缺任何 criterion 时补 `{pass:false, evidence:"reviewer did not report this criterion"}`，并把 `verdict` 降为 `unclear`。`verdict` 为 `fail` 但所有 criteria 都 pass 时，同样降为 `unclear`（自相矛盾不当作可行动结论）。

`buildReviewPrompt` 只拼证据：spec 全文、acceptance 内容、交接笔记、journal 尾部 30 行、以及「你只能依据这些材料；发现证据不足就判 unclear；必须输出单个 JSON 对象」。

- [ ] **Step 4: 跑测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run tests/review.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/review.ts tests/review.test.ts
git commit -m "feat(review): evidence prompt and fail-safe verdict parsing"
```

---

### Task 9: 复核阶段接入 worker

**Files:**
- Modify: `src/worker.ts`
- Test: `tests/worker-review.test.ts`

**Interfaces:**
- Consumes: `runReview`、`parseVerdict`、`TaskStore.incReviewRounds`、`TaskStore.updateFields`
- Produces: 新事件类型 `reviewing`、`reviewed`、`rework`、`awaiting-human`；`WorkerConfig` 新增
  `maxReviewRounds?: number`（默认 2）、`reviewerModel?: string`、`reviewerEffort?: string`；
  `WorkerDeps` 新增 `review?: (evidence) => Promise<ReviewResult>`（测试注入，默认用适配器）

- [ ] **Step 1: 写失败的测试**

```ts
test("passing review finishes the task", async () => {
  const { cfg, deps, dir } = await harness({ criteria: ["C1 ok"], acceptance: "true" });
  deps.review = async () => ({ verdict: "pass", criteria: [{ id: "C1", pass: true, evidence: "ok" }], defects: [], summary: "ok" });
  await runTask(cfg, deps, await deps.store.get("001-a"), "w1");
  expect((await deps.store.get("001-a")).status).toBe("done");
});

test("failing review sends the task back to open with a note and a round", async () => {
  const { cfg, deps } = await harness({ criteria: ["C1 ok"], acceptance: "true" });
  deps.review = async () => ({ verdict: "fail", criteria: [{ id: "C1", pass: false, evidence: "exit 1" }], defects: ["宽度仍写死"], summary: "未达" });
  await runTask(cfg, deps, await deps.store.get("001-a"), "w1");
  const task = await deps.store.get("001-a");
  expect(task.status).toBe("open");
  expect(task.reviewRounds).toBe(1);
  expect((await latestNote(cfg.tasksDir, "001-a"))?.markdown).toContain("review-failed");
});

test("a task without criteria never reaches done on its own", async () => {
  const { cfg, deps } = await harness({ criteria: [], acceptance: "true" });
  await runTask(cfg, deps, await deps.store.get("001-a"), "w1");
  expect((await deps.store.get("001-a")).status).toBe("awaiting-human");
});

test("passing review on a high-risk task stops at awaiting-human", async () => {
  const { cfg, deps } = await harness({ criteria: ["C1 ok"], acceptance: "true", risk: "high" });
  deps.review = async () => ({ verdict: "pass", criteria: [{ id: "C1", pass: true, evidence: "ok" }], defects: [], summary: "ok" });
  await runTask(cfg, deps, await deps.store.get("001-a"), "w1");
  expect((await deps.store.get("001-a")).status).toBe("awaiting-human");
});

test("unclear verdict goes to awaiting-human instead of retrying", async () => {
  const { cfg, deps } = await harness({ criteria: ["C1 ok"], acceptance: "true" });
  deps.review = async () => ({ verdict: "unclear", criteria: [], defects: [], summary: "证据不足" });
  await runTask(cfg, deps, await deps.store.get("001-a"), "w1");
  expect((await deps.store.get("001-a")).status).toBe("awaiting-human");
});

test("exceeding maxReviewRounds blocks the task", async () => {
  const { cfg, deps } = await harness({ criteria: ["C1 ok"], acceptance: "true", reviewRounds: 2 });
  deps.review = async () => ({ verdict: "fail", criteria: [{ id: "C1", pass: false, evidence: "x" }], defects: [], summary: "未达" });
  await runTask(cfg, deps, await deps.store.get("001-a"), "w1");
  expect((await deps.store.get("001-a")).status).toBe("blocked");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run tests/worker-review.test.ts`
Expected: FAIL —— 复核后直接 `done`，没有 review 阶段。

- [ ] **Step 3: 实现**

在 `accept()` 验收通过后、写 `done` 之前插入 `reviewStage(r)`：读 spec 与 acceptance.json，拼证据，调 `deps.review ?? runReview(...)`（走 `controlled(r, "review", turnTimeout)`，可取消、受所有权保护）；把结果写 `tasks/<id>/review.json`（经 `owned`）。路由：`pass` 且非高风险 → `done`；`pass` 且 `risk==="high"` 或 `humanCheck` → `awaiting-human`；`fail` → `incReviewRounds`，`>= maxReviewRounds` 则 `blocked` 否则 `open` + 写反馈笔记（`status: review-failed`，`next` 放 defects 列表）；`unclear` → `awaiting-human`。无 criteria 时不进复核，直接 `awaiting-human`（fail-closed）。

- [ ] **Step 4: 跑测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run tests/worker-review.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/worker.ts tests/worker-review.test.ts
git commit -m "feat(worker): independent review stage with rework routing"
```

---

### Task 10: 并行调度与依赖

**Files:**
- Create: `src/scheduler.ts`
- Modify: `src/worker.ts`（暴露 `runTask`，不改语义）
- Test: `tests/scheduler.test.ts`

**Interfaces:**
- Produces: `runScheduler(cfg: WorkerConfig, deps: WorkerDeps): Promise<{ done: string[]; blocked: string[] }>`；
  `WorkerConfig` 新增 `parallel?: number`（默认 2）；`candidates(tasks: Task[], busy: Set<string>, parallel: number): Task[]`（纯函数，便于测试）

- [ ] **Step 1: 写失败的测试**

```ts
test("runs two tasks with disjoint workdirs at the same time", async () => {
  const { cfg, deps, dir } = await harness2({
    tasks: [
      { id: "001-a", status: "open", workdir: "a" },
      { id: "002-b", status: "open", workdir: "b" },
    ],
    parallel: 2,
  });
  await runScheduler(cfg, deps);
  expect(deps.peakConcurrency).toBe(2);
});

test("serializes tasks that share a workdir", async () => {
  const { cfg, deps } = await harness2({
    tasks: [{ id: "001-a", status: "open", workdir: "same" }, { id: "002-b", status: "open", workdir: "same" }],
    parallel: 2,
  });
  await runScheduler(cfg, deps);
  expect(deps.peakConcurrency).toBe(1);
});

test("skips a task whose dependency is not done", async () => {
  const { cfg, deps } = await harness2({
    tasks: [
      { id: "001-a", status: "blocked" },
      { id: "002-b", status: "open", dependsOn: ["001-a"] },
    ],
    parallel: 2,
  });
  await runScheduler(cfg, deps);
  expect((await deps.store.get("002-b")).status).toBe("open");
});

test("rejects a dependency cycle before running anything", async () => {
  const { cfg, deps } = await harness2({
    tasks: [
      { id: "001-a", status: "open", dependsOn: ["002-b"] },
      { id: "002-b", status: "open", dependsOn: ["001-a"] },
    ],
  });
  await expect(runScheduler(cfg, deps)).rejects.toThrow(/cycle/);
});

test("never claims draft or awaiting-human tasks", async () => {
  const { cfg, deps } = await harness2({
    tasks: [{ id: "001-a", status: "draft" }, { id: "002-b", status: "awaiting-human" }],
    parallel: 2,
  });
  await runScheduler(cfg, deps);
  expect(deps.claimed).toEqual([]);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run tests/scheduler.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

调度前做环检测（DFS，节点不存在或成环都抛错）。候选 = `status === "open"` 且 `dependsOn` 全部 `done` 且 workdir 不在 `busy` 中；按文件名顺序取到 `parallel` 个。每个候选用 `runTask` 并发跑，`finally` 释放 workdir 并唤醒等待者。`draft`/`awaiting-human`/`review` 不领取。

- [ ] **Step 4: 跑测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run tests/scheduler.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/scheduler.ts src/worker.ts tests/scheduler.test.ts
git commit -m "feat(scheduler): parallel slots, dependency and workdir guards"
```

---

### Task 11: 台账（Markdown 文件）与单任务报告

**Files:**
- Create: `src/board.ts`、`src/report.ts`
- Modify: `src/cli.ts`
- Test: `tests/board.test.ts`、`tests/report.test.ts`

**Interfaces:**
- Produces: `renderBoardMarkdown(tasks: Task[], opts: { all: boolean; notes: Map<string, string>; highlighted: Set<string>; now: Date }): string`；
  `writeBoard(tasksDir: string, markdown: string): Promise<string>`（写 `.taskctl/board.md`，tmp + rename）；
  `renderBoardTable(tasks, opts): string[]`（终端简表）；
  `buildReport(tasksDir, id): Promise<string[]>`；CLI `board [--all] [--json]`、`report --task <id>`

- [ ] **Step 1: 写失败的测试**

```ts
test("board markdown groups unfinished tasks, hides done, and marks generated", () => {
  const tasks = [task({ id: "001", status: "draft" }), task({ id: "002", status: "awaiting-human" }),
    task({ id: "003", status: "review" }), task({ id: "004", status: "blocked" }), task({ id: "005", status: "done" })];
  const md = renderBoardMarkdown(tasks, {
    all: false, notes: new Map([["004", "复核 2 轮未过"]]), highlighted: new Set(["002"]), now: new Date("2026-11-16T02:50:00Z"),
  });
  expect(md).toContain("## 待我确认 1");
  expect(md).toContain("## 待我放行 1");
  expect(md).toContain("## 进行中 1");
  expect(md).toContain("## 卡住 1");
  expect(md).toContain("复核 2 轮未过");
  expect(md).toContain("- ★ 002");
  expect(md).not.toContain("005");
  expect(md).not.toContain("## 已完成");
});

test("--all appends the done group", () => {
  const md = renderBoardMarkdown([task({ id: "005", status: "done" })], { all: true, notes: new Map(), highlighted: new Set(), now: new Date() });
  expect(md).toContain("## 已完成 1");
});

test("writeBoard writes atomically and leaves no tmp behind", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tc-"));
  const path = await writeBoard(dir, "# board\n");
  expect(await readFile(path, "utf8")).toBe("# board\n");
  await expect(readFile(`${path}.tmp`, "utf8")).rejects.toThrow();
});

test("report shows acceptance, review and journal sections", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tc-"));
  await writeTask(dir, "001-a", { status: "done", criteria: ["C1 ok"] });
  await writeRuntime(dir, "001-a", "review.json", { verdict: "pass", criteria: [{ id: "C1", pass: true, evidence: "ok" }], defects: [], summary: "ok" });
  await appendJournal(dir, "001-a", { stage: "review", event: "verdict", detail: "pass" });
  const text = (await buildReport(dir, "001-a")).join("\n");
  expect(text).toContain("## acceptance");
  expect(text).toContain("## review");
  expect(text).toContain("verdict  pass");
  expect(text).toContain("## journal");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run tests/board.test.ts tests/report.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

`renderBoardMarkdown`：一级标题 `# taskctl · <YYYY-MM-DD HH:mm>`，第二行注明「生成物，手改会被覆盖」；四组固定顺序（`draft` / `awaiting-human` / `open|running|review` / `blocked`），组标题 `## 名称 N`，条目 `- [★ ]<id> <title> · <complexity> · <note>`；`all` 时追加已完成组；空组不打印。`writeBoard` 加载 `src/journal.ts` 同款 tmp + rename 写法，路径 `.taskctl/board.md`（`mkdir` 兜底）。`board` 命令同时写文件并打印终端简表；`--json` 只打印 JSON 不写文件。

`buildReport` 输出 spec 标题、状态行、验收命令与结果、复核 verdict 与逐条 criteria、journal 尾部 15 行。

- [ ] **Step 4: 跑测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run tests/board.test.ts tests/report.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/board.ts src/report.ts src/cli.ts tests/board.test.ts tests/report.test.ts
git commit -m "feat(cli): regenerated markdown board and per-task report"
```

---

### Task 12: 人工放行与抽查归因

**Files:**
- Create: `src/audit.ts`
- Modify: `src/cli.ts`
- Test: `tests/audit.test.ts`、`tests/cli-human.test.ts`

**Interfaces:**
- Produces: `type AuditRecord = { task: string; at: string; verdict: "pass" | "fail"; stage: "clarify" | "worker" | "reviewer" | "none"; note?: string; highlight?: boolean }`；
  `appendAudit(tasksDir, record): Promise<void>`；`readAudits(tasksDir): Promise<AuditRecord[]>`；
  `summarizeAudits(records: AuditRecord[], tasks: Task[]): string[]`；
  CLI `accept --task <id>`、`reject --task <id> --reason "…" [--stage <s>]`、`audit --task <id> --verdict pass|fail [--stage <s>] [--note "…"]`、`metrics`

- [ ] **Step 1: 写失败的测试**

```ts
test("accept only works from awaiting-human and records a highlighted audit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tc-"));
  await writeTask(dir, "001-a", { status: "awaiting-human" });
  expect(await runCli(["accept", "--task", "001-a", "--tasks-dir", dir], { log: () => {} })).toBe(0);
  expect((await new TaskStore(dir).get("001-a")).status).toBe("done");
  const audits = await readAudits(dir);
  expect(audits[0]).toMatchObject({ task: "001-a", verdict: "pass", highlight: true });
});

test("reject returns the task to open with the reason and the failing stage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tc-"));
  await writeTask(dir, "002-b", { status: "awaiting-human" });
  expect(await runCli(["reject", "--task", "002-b", "--reason", "导出按钮宽度仍写死", "--stage", "worker", "--tasks-dir", dir], { log: () => {} })).toBe(0);
  const task = await new TaskStore(dir).get("002-b");
  expect(task.status).toBe("open");
  expect((await readAudits(dir))[0]).toMatchObject({ verdict: "fail", stage: "worker" });
});

test("metrics reports per-stage failure counts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tc-"));
  await writeTask(dir, "001-a", { status: "done" });
  await appendAudit(dir, { task: "001-a", at: new Date().toISOString(), verdict: "fail", stage: "reviewer" });
  await appendAudit(dir, { task: "001-a", at: new Date().toISOString(), verdict: "pass", stage: "none", highlight: true });
  const lines = summarizeAudits(await readAudits(dir), [await new TaskStore(dir).get("001-a")]);
  expect(lines.join("\n")).toMatch(/reviewer\s+1/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run tests/audit.test.ts tests/cli-human.test.ts`
Expected: FAIL —— 模块与命令都不存在。

- [ ] **Step 3: 实现**

审计文件 `.taskctl/audits.jsonl`，一行一条 JSON。`accept`：只接受 `awaiting-human`，写 `done` + `journal` + audit（`pass`、`highlight: true`、`stage: "none"`）。`reject`：只接受 `awaiting-human`，写反馈笔记（`status: "rejected"`）、置 `open`、audit（`fail`、default `stage: "reviewer"`）。`audit`：只接受 `done`，只记审计不改状态。`metrics`：按 stage 统计 fail 次数与占比、`highlight` 通过数、返工率（`reviewRounds > 0` 的任务占比）。

- [ ] **Step 4: 跑测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run tests/audit.test.ts tests/cli-human.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/audit.ts src/cli.ts tests/audit.test.ts tests/cli-human.test.ts
git commit -m "feat(cli): human accept/reject/audit with stage attribution"
```

---

### Task 13: 配置、文档与整链验证

**Files:**
- Modify: `src/cli.ts`（`CONFIG_KEYS` 与校验）、`README.md`
- Create: `docs/adr/0008-review-stage-and-human-attribution.md`
- Test: `tests/cli.test.ts`

**Interfaces:**
- 新增配置键：`parallel`（整数 ≥1，默认 2）、`maxReviewRounds`（整数 ≥1，默认 2）、`reviewerModel`、`reviewerEffort`；`agent` 仍只接受 `opencode`（P2 才加后端）

- [ ] **Step 1: 写失败的测试**

```ts
test("accepts the new config keys and rejects bad values", () => {
  expect(() => resolveConfigForTest({ parallel: 3, maxReviewRounds: 1, reviewerModel: "x/y" })).not.toThrow();
  expect(() => resolveConfigForTest({ parallel: 0 })).toThrow(/positive/);
  expect(() => resolveConfigForTest({ nope: 1 })).toThrow(/unknown field/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run tests/cli.test.ts`
Expected: FAIL —— `unknown field "parallel"`。

- [ ] **Step 3: 实现**

`CONFIG_KEYS` 加四个键，`resolveConfig` 校验类型；README 增「流水线」「board」「report」「audit」四节（照 spec 的 CLI 面写，不写实现细节）；ADR-0008 记：为什么复核是独立会话、为什么缺 criteria 转人工而不是放行、为什么审计归因分三段。

- [ ] **Step 4: 跑全量测试与类型检查**

Run: `node node_modules/vitest/vitest.mjs run --reporter=dot` 然后 `npx tsc --noEmit`
Expected: 全部 PASS（原 158 条 + 新增），`tsc` 无输出

- [ ] **Step 5: 端到端手工验证（真实适配器，用 opencode）**

在一个临时仓库执行：`add` 一个复杂意图 → `spec` 看稿 → 改 `spec.md` 补一条 criteria → `approve` → `run --parallel 2` → 看 `board` 是否显示 review 中 → 复核失败时确认回到 open 且 notes 里有返工项 → 再次 `run` 直到 `awaiting-human` → `report` 看证据 → `accept` → `audit --verdict pass` → `metrics`。

把命令与输出贴进 `docs/superpowers/plans/2026-11-16-review-loop-verification.md`。

- [ ] **Step 6: 提交**

```bash
git add src/cli.ts README.md docs/adr/0008-review-stage-and-human-attribution.md docs/superpowers/plans/2026-11-16-review-loop-verification.md tests/cli.test.ts
git commit -m "feat: review pipeline config, docs and end-to-end verification"
```
