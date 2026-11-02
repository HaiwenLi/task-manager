# taskctl

多 agent 任务编排器：以 Markdown 任务文件为唯一事实源，把任务派发给真实的 [OpenCode](https://opencode.ai) agent 会话，靠客观验收命令（而非 agent 自述）裁决完成。

- **任务即文件**：`tasks/<id>.md`（YAML frontmatter + 正文描述），状态机 `open → running → done / blocked`
- **会话链**：上下文预算告急时收尾交接（`taskctl note` 落编号笔记 → 开新会话注入），长任务不因上下文耗尽而断
- **验收门**：agent 只能"请求完成"（`taskctl done`），真正的 `done` 由 `acceptance:` 命令的退出码决定
- **协作式并发保护**：唯一所有权代次 + 周期心跳 + 串行化状态更新；工作目录独占，不确定执行不自动重跑（不是 OS 安全隔离）

## 安装

要求：

- Node.js ≥ 22
- 本机已安装并登录 [opencode](https://opencode.ai) CLI（`opencode` 可用、模型已配置）

```bash
git clone <repository-url>
cd task-manager
npm ci
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
| `lockTtlMs` | number | `600000` | 所有权过期窗口；过期不等于旧执行已停止 |
| `heartbeatMs` | number | `60000` | 全程续期间隔，实际不大于 TTL 的三分之一 |
| `turnTimeoutMs` | number | `1800000` | 单个 agent 回合的超时 |
| `acceptanceTimeoutMs` | number | `600000` | 单次验收命令的超时 |
| `maxSessionsPerTask` | number | `20` | 一个任务全会话链的长度上限（含交接与重试） |
| `maxTurnsPerSession` | number | `40` | 单会话内工作回合数上限 |
| `opencodeBin` | string | `opencode` | opencode 可执行文件。**Windows 下 `.cmd` shim 无法被 `shell:false` 直接启动**，应在本地配置实际 `.exe`，不要提交机器专属路径 |

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
| `acceptance` | | 验收命令（完整 shell 命令行，在 `workdir` 下执行）；退出码 0 且所有权/任务定义/产物一致才可 `done`。缺失或空白 → `blocked` 待审，不消耗重试 |
| `sessions` | ✓ | 会话 id 链（按时间顺序追加），由 worker 维护 |
| `retries` | ✓ | 失败尝试计数，由 worker 维护 |

辅助文件：`tasks/<id>/lock.json`（所有权与心跳）、`attempt.json`（执行事实与不确定状态）、`acceptance.json`（命令、时间、输出与身份摘要）、`done.requested`（完成请求）、`sessions/0001-handoff.md`（交接笔记）。运行时记录不拥有任务状态，Markdown 仍是唯一状态源。

## 运行

### taskctl run — 派发

```bash
npx tsx src/main.ts run [--config taskctl.json]
```

按文件名顺序处理 `open` 任务：领锁 → 独占工作目录 → 持久化执行身份 → `running` → 会话/交接 → 完成请求 → 验收。全过程打印 `[<id>] <状态> [详情]`。缺少验收时输出 `acceptance-skipped` 并阻塞待审。`running` 孤儿任务只有已确认上一执行结束才能恢复；活跃/不确定记录或缺少执行身份的旧任务会阻塞，不盲目重跑。

同一实际工作目录（含路径别名）不可并行执行；共享 Git common directory 的 worktree 暂按串行处理。当前不自动创建/合并 worktree。验收前后对源码产物做摘要；验收命令改变产物会要求复核，不会把旧检查套到新版本。摘要排除 Git 内部、依赖目录及任务运行时目录；详见 `src/workspace.ts`。

工作目录预留同时保存在 `<workdir>/.taskctl-workspace.lock/` 和用户临时目录 `opencode/taskctl-workspaces/reservations.json`。注册表检查父子目录及 Git 元数据路径的重叠，即使运行期间执行 `git init` / 新建 linked worktree 也不能绕过既有预留。只删本地锁不会清除不确定执行的预留。

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

**任务变 blocked** —— 原因包括重试耗尽、缺少验收、任务/产物变化、工作目录被占用和执行停止未确认。先看事件日志、`attempt.json`、`acceptance.json` 与交接笔记。只有普通、已停止的失败才可修复后重开；不确定执行不能只改状态绕过。

**worker 崩溃 / 不确定执行** —— 先核实原控制器、子进程树与后端会话均已停止，再检查产物。保留证据后，人工归档旧 `attempt.json` 和对应工作目录预留，再按需重开任务。不能仅按旧 PID 杀进程、删任务锁或改 `status` 后自动重跑。互斥目录 `.mutation.lock` 若因崩溃遗留也必须先确认原操作已停止，不能按时间强抢。

人工修改共享预留注册表之前，先停止所有使用该注册表的 taskctl 控制器；仅处理已核对身份的那条预留及其本地标记，不清空其他任务的记录。当前没有自动“强制恢复”命令。缺少验收造成的普通待审则补上验收并重开任务即可，不需要清理已正常释放的预留。

**回合 / 验收超时** —— 单回合默认 30 分钟、验收 10 分钟。请求停止并确认停止后才允许计失败重试；无法确认则阻塞并保留工作目录预留。OpenCode CLI 被杀不代表其独立后端会话已停，因此 OpenCode 回合被中断按不确定处理，须人工核实。未做真实后端取消验证。

**Windows 下 spawn opencode 失败** —— npm 全局安装的 `opencode` 是 `.cmd` shim，`shell:false` 无法启动。在 `taskctl.json` 里把 `opencodeBin` 指向真实 exe（见上文表格）。

## 测试

```bash
npm test                # 全部单元/集成测试（不碰真实 opencode）
npx tsc --noEmit         # TypeScript 检查
TASKCTL_E2E=1 npx vitest run tests/e2e.smoke.test.ts   # E2E 冒烟（真实 opencode）
```

E2E 前置：本机 opencode 已安装并登录；Windows 下测试会自动解析 npm 全局 opencode 背后的真实 `.exe`（也可用环境变量 `TASKCTL_OPENCODE_BIN` 覆盖）。它会在临时目录里发起真实 agent 会话并消耗模型额度。

## 凭据与隐私

- 通过 agent CLI 在本地配置模型凭据；不要把 API key、访问令牌或认证头写进任务、示例或仓库配置。
- 示例使用相对路径；机器专属可执行文件路径仅保存在本地，不提交到 Git。
- `.env`、密钥文件、私人记忆和实际任务运行数据默认忽略；`tasks/example.md` 是公开示例，不含真实任务记录。
- `attempt.json`、`acceptance.json`、交接笔记和模型输出可能含任务内容、运行路径或敏感数据；提交附件或共享日志前另行检查。`.gitignore` 不会清除已经提交的历史。
- 当前验证为离线测试，不代表真实后端取消、科学有效性或生产部署已经验证；中断恢复见 [ADR-0007](docs/adr/0007-fenced-execution-and-evidence.md)。

## 设计文档

见 `docs/adr/`（任务存储与文件锁、独立编排器、会话链交接、TypeScript 薄编排器、验收门等决策记录）。
