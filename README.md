# taskctl

多 agent 任务编排器：以 Markdown 任务文件为唯一事实源，把任务派发给真实的 [OpenCode](https://opencode.ai) agent 会话，靠客观验收命令（而非 agent 自述）裁决完成。

- **任务即文件**：`tasks/<id>.md`（YAML frontmatter + 正文描述），状态机 `open → running → done / blocked`
- **会话链**：上下文预算告急时收尾交接（`taskctl note` 落编号笔记 → 开新会话注入），长任务不因上下文耗尽而断
- **验收门**：agent 只能"请求完成"（`taskctl done`），真正的 `done` 由 `acceptance:` 命令的退出码决定
- **并发安全**：文件锁（创建即声明）+ 心跳 + 过期接管，多个 worker 可以安全共跑一个任务目录

## 安装

要求：

- Node.js ≥ 22
- 本机已安装并登录 [opencode](https://opencode.ai) CLI（`opencode` 可用、模型已配置）

```bash
git clone <本仓库> && cd task-manager
npm install
```

v0.1 从源码运行，CLI 入口是：

```bash
npx tsx src/main.ts <子命令> [参数]
```

下文为可读性一律写作 `taskctl <子命令>`。**注意**：协议要求 agent 在会话里运行 `taskctl done/note`，因此 agent 的 PATH 上必须能找到 `taskctl`。源码运行时请自建 shim 指向 `npx tsx <仓库路径>/src/main.ts`（参考 `tests/e2e.smoke.test.ts` 中 `writeShimDir` 的做法：cmd / PowerShell / sh 三种形式各一份）。

## taskctl.json

`taskctl run` 的配置文件（`--config` 指定，默认 `taskctl.json`）。所有字段可省略：

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `tasksDir` | string | `tasks` | 任务目录（绝对或相对当前目录） |
| `workdir` | string | 当前目录 | agent 会话的工作目录，任务的改动都发生在这里 |
| `agent` | string | `opencode` | v0.1 仅支持 `opencode` |
| `model` | string | — | 兜底模型（`provider/model`）；任务 frontmatter 的 `model` 优先 |
| `effort` | string | — | 兜底努力档（如 `high`）；任务 frontmatter 的 `effort` 优先 |
| `contextThreshold` | number | `0.8` | 上下文用量比例达到该值即触发收尾交接 |
| `retryLimit` | number | `3` | 失败尝试（失败回合 / 收尾失败 / 验收失败）上限，达到即 `blocked` |
| `lockTtlMs` | number | `600000` | 锁过期窗口（v0.1 预留字段） |
| `heartbeatMs` | number | `60000` | 心跳间隔（v0.1 在回合边界续期，预留字段） |
| `turnTimeoutMs` | number | `1800000` | 单个 agent 回合的超时 |
| `acceptanceTimeoutMs` | number | `600000` | 单次验收命令的超时 |
| `maxSessionsPerTask` | number | `20` | 一个任务全会话链的长度上限（含交接与重试） |
| `maxTurnsPerSession` | number | `40` | 单会话内工作回合数上限 |
| `opencodeBin` | string | `opencode` | opencode 可执行文件。**Windows 下 npm 全局装的是 `.cmd` shim，无法被 `shell:false` 直接 spawn**，需指向真实 `.exe`（填本机实际的 .exe 路径，不要提交） |

## 任务文件

`tasks/<id>.md` = YAML frontmatter + Markdown 正文（正文即任务描述，会原样进 agent 提示词）：

```markdown
---
id: hello
title: 创建 hello.txt
status: open
acceptance: node -e "process.exit(require('fs').existsSync('hello.txt')?0:1)"
sessions: []
retries: 0
---

在工作目录创建 `hello.txt`，内容为 `hi`。
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | ✓ | 任务标识；以文件名为准（`tasks/<id>.md` 的 stem），frontmatter 里的副本不作数 |
| `title` | ✓ | 标题；同时用作 opencode 会话标题 |
| `status` | ✓ | 生命周期：`open`（待领取）/ `running`（有 worker 持锁执行中）/ `done`（验收通过）/ `blocked`（重试耗尽，需人工介入） |
| `model` | | 本任务模型（`provider/model`），覆盖配置兜底 |
| `effort` | | 本任务努力档（如 `high`），覆盖配置兜底 |
| `acceptance` | | 验收命令（完整 shell 命令行，在 `workdir` 下执行）；退出码 0 → `done`，否则计一次失败。缺省则验收直通 |
| `sessions` | ✓ | 会话 id 链（按时间顺序追加），由 worker 维护 |
| `retries` | ✓ | 失败尝试计数，由 worker 维护 |

辅助文件（都在 `tasks/<id>/` 目录下，由工具维护）：`lock.json`（锁与心跳）、`done.requested`（完成请求标记）、`sessions/0001-handoff.md`（编号交接笔记）。

## 运行

### taskctl run — 派发

```bash
npx tsx src/main.ts run [--config taskctl.json]
```

按文件名顺序处理所有 `open` 任务：领锁 → `running` → 组装协议提示词（任务 + 工作规则 + 最新交接笔记）→ `opencode run` 真实会话 → 回合结束轮询 `done.requested` → 验收裁决。全过程逐事件打印单行日志 `[<id>] <状态> [详情]`（`claimed`、`running`、`turn-failed`、`handoff`、`acceptance`、`acceptance-skipped`、`done`、`blocked`、`takeover`、`ownership-lost`），事件发生即输出。任务缺少 `acceptance` 字段时以 `acceptance-skipped` 告警放行（ADR-0006）；崩溃 worker 留在 `running` 的任务在锁过期（或缺锁）后由下一个 `taskctl run` 以 `takeover` 自动接管。

### taskctl done — 请求完成（agent 侧）

```bash
taskctl done --task <id> [--tasks-dir <dir>]
```

写 `tasks/<id>/done.requested` 标记；worker 在回合边界消费它并跑验收。**它不会直接把任务变成 `done`**。

### taskctl note — 交接笔记（agent 侧）

```bash
taskctl note --task <id> --status <一句话状态> --done <已完成> --found <关键发现> --next <下一步> [--files <逗号分隔文件>] [--tasks-dir <dir>]
```

追加下一条编号笔记到 `tasks/<id>/sessions/`（`0001-handoff.md`、`0002-handoff.md` …）。阶段进展随时可写；收到"上下文预算告急"收尾指令时必须详尽地写一次，然后只回复 `HANDOFF_READY`。

### taskctl status — 看板

```bash
npx tsx src/main.ts status [--tasks-dir <dir>]
```

每任务一行：id、status、retries、sessions 数、最新笔记的 Status 行。

## ⚠️ 已知陷阱

- **仓库根目录自带一个 open 任务**：`tasks/example.md`（`status: open`）。在仓库根目录直接 `taskctl run` 会真的派发它 —— 真实 agent 会在当前目录创建 `hello.txt` 并消耗模型额度。请换到自己的工作目录运行，或先删掉 / 关掉该示例任务。
- **`--config` 路径写错不报错**：配置文件读不到（ENOENT）时按"全默认"处理（`tasksDir=tasks`、`workdir=当前目录`）。路径拼错不会失败，只会让任务跑在非预期的目录。请核对拼写与相对路径基准（当前目录，不是仓库根）。

## 排障

**任务变 blocked** —— 失败尝试累计到 `retryLimit`（默认 3）。失败来源：agent 回合非零退出、收尾（写 note）失败、验收命令不通过、会话链 / 回合预算耗尽后仍需再开会话。看 `tasks/<id>/sessions/` 里最新的交接笔记与 `tasks/<id>.md` 的 `retries` 定位；修复任务或环境后，把 `status` 改回 `open`、`retries` 归零再跑。

**worker 崩溃后任务卡在 running（stale 接管）** —— 崩溃的 worker 会留下 `tasks/<id>/lock.json`。锁心跳超过 TTL（默认 10 分钟）即被视为过期，下一个 `taskctl run` 的 worker 会自动接管：旧锁归档为 `lock.json.stale-<时间戳>` 并新建锁。一般无需手工处理；若想立即接管，确认无 worker 存活后直接删除 `lock.json`。

**回合 / 验收超时** —— 单回合默认上限 30 分钟（`turnTimeoutMs`），验收 10 分钟（`acceptanceTimeoutMs`）。挂起的回合按失败回合计、挂起的验收按失败验收计，都会消耗 `retryLimit`。注意：v0.1 无法取消底层进程，超时后原进程可能仍在后台跑；重复出现时先排查 agent 为什么挂起（模型卡死、工具等待输入等），再考虑调大上限。

**Windows 下 spawn opencode 失败** —— npm 全局安装的 `opencode` 是 `.cmd` shim，`shell:false` 无法启动。在 `taskctl.json` 里把 `opencodeBin` 指向真实 exe（见上文表格）。

## 测试

```bash
npm test                # 全部单元/集成测试（不碰真实 opencode）
TASKCTL_E2E=1 npx vitest run tests/e2e.smoke.test.ts   # E2E 冒烟（真实 opencode）
```

E2E 前置：本机 opencode 已安装并登录；Windows 下测试会自动解析 npm 全局 opencode 背后的真实 `.exe`（也可用环境变量 `TASKCTL_OPENCODE_BIN` 覆盖）。它会在临时目录里发起真实 agent 会话并消耗模型额度。

## 设计文档

见 `docs/adr/`（任务存储与文件锁、独立编排器、会话链交接、TypeScript 薄编排器、验收门等决策记录）。
