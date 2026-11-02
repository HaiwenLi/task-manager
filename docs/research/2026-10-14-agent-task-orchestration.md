# 调研：多 Agent 任务编排器（2026-10-14）

两路调研的持久化记录：GitHub 开源全景 + OpenCode/Kimi 本地源码验证。
用途：为"任务管理器"选型与自建提供事实依据。

## 一、需求基线（R1-R6）

| # | 需求 | 来源 |
|---|------|------|
| R1 | 批量发布任务 | 用户 |
| R2 | 多 Agent（OpenCode/Kimi Code/派出的 Coding Agent）自动读取并认领任务 | 用户 |
| R3 | 每任务预先配置 model + effort/thinking | 用户 |
| R4 | **每 Task = 独立 Session；context 快满时 Task 自己开新 Session 延续（session 链由 Task 维护）**，关联多个 session + 中间记录文档 | 用户 |
| R5 | 完成标记 done；agent 自动找下一个未完成任务，直到全部完成 | 用户 |
| R6 | Windows 本机运行 | 环境 |

## 二、GitHub 开源全景结论

**没有项目完整覆盖 R1-R6，缺口集中在 R4（session 链自维护）——业界只用 skill/约定解决，无编排器内建。**

### 候选矩阵（已克隆至 `repos/`）

| 项目 | 匹配度 | 核心价值 | 关键缺口 |
|---|---|---|---|
| Sma1lboy/rove | 75 | Windows 原生、任意 CLI 引擎（含 OpenCode/Kimi）、task↔worktree↔持久 session、`rove api` 供 agent 自驱动 | 无每 task model/effort；无自动认领循环；无 session 链 |
| ordewell/ordewell | 70 | 每任务 runner/model/effort/mode；done 必须由 agent 调工具上报（不信自评）；多仓 worktree 隔离 | 无 session 链；TUI 需 WSL |
| jedarden/NEEDLE | 55 | SQLite 原子认领、确定性优先级、YAML 接任意 CLI、每 outcome 显式 handler | 无 session 链；预编译仅 Linux（tmux/bash），Windows 不可用，当参考实现读 |
| sortie-ai/sortie | 60 | tracker 状态机认领、重试、CI/review 回灌、SQLite、单二进制 | 模型按 workflow 而非 task 配；无链；Windows 未声明 |
| umputun/ralphex | 55 | fresh-session-per-task（R4 反向解法）、`model:effort` 语法、5-agent review 管线 | 无认领；无 Windows 二进制 |
| eyaltoledano/claude-task-master | 30 | planner 不是 orchestrator | 只解决 R1 |
| MrLesk/Backlog.md | 40 | markdown 任务存储格式可借鉴 | 无锁无编排 |
| OpenHands | 45 | Docker/K8s 重量级平台 | 模型不同（conversation 非队列） |
| shinpr/sub-agents-skills | 40(积木) | markdown frontmatter 路由 model/effort 到 Codex/Claude/Kimi/GLM/OpenCode | — |
| softaworks/agent-toolkit | 积木 | session-handoff 文档模板 | — |

### 两条可行路线
1. **自建薄编排器**（≈1-2 周）：NEEDLE 认领模式 + ordewell 数据模型 + rove 引擎抽象。
2. **fork rove 补三缺口**：自动认领循环 + 每 task model/effort + session-chain policy。

## 三、OpenCode V2 集成能力（本机 v2.0.29 源码验证）

### Session 存储
- 单 SQLite（WAL）：`~/.local/share/opencode/opencode.db`；表 `session_v2`（含 parent_id/fork_session_id/tokens_*/cost）、`session_message`
- 枚举：`opencode session list --format json` / `GET /api/session`
- **外部可自定义 session ID**：`opencode run --session ses_xxx`（不存在则以该 ID 新建）→ task id 可直接映射 session id
- Fork：`opencode run --fork --session <id>`（可带 `before` messageId）；`opencode session export/import`

### 无头驱动
- `opencode run --session <id> --model provider/model#variant --agent <a> --format json --auto [--thinking]`
- JSON 每行带 `sessionID`；退出码：0 成功 / 1 失败 / 130 SIGINT
- 非交互无 `--auto` 时权限自动拒绝并回喂（不挂死）
- SDK：`@opencode/sdk`（进程内嵌 host）、`@opencode/client`（HTTP）；`opencode serve` 139 端点（OpenAPI: packages/protocol/openapi.json）

### 上下文监控与 compaction（R4 关键）
- 自动 compaction 默认开启（`auto: true, keep: 15000`）；每 Step 前估算 ≥ ceiling 即 compact
- **compaction 摘要模板即交接文档**："summarize … for another agent to resume the work"，含 Objective/Work State/Next Move/Relevant Files
- 用量算法：最后一条带 usage 的 assistant 消息 `(input+output+reasoning+cache.read+cache.write) ÷ model.limit.context`
- 数据源：`GET /api/session/{id}/context`、`GET /api/session/{id}/message`、SQLite tokens_* 列、`session.usage.updated` 事件

### 并发契约
- 共享后台 service：同 session 串行、不同 session 并行（SessionRunCoordinator）
- 多 standalone 进程共用 DB 在 WAL+busy_timeout 下安全，但**同一 session 只能归一个驱动进程**

### 插件系统
- `Plugin.define({ setup(ctx) })`，域：agent/session/tool/permission/skill/...
- 本机已装：evolver.ts、rtk.ts（无任务管理类插件）
- **定位：plugin 适合做"任务协议注入"（给 worker session 注入 bootstrap），不适合做编排**（无跨 session 调度原语）

## 四、Kimi Code 集成能力（v2.1.1 源码验证）

- CLI：`kimi -p "<prompt>" --output-format stream-json --session <id>|-r <id>|-c`；stdout 尾部 `session.resume_hint` 可捕获 session id
- **无 effort/thinking CLI flag**：走 config.toml `thinking` / API body / SDK `setThinking()`
- 服务器模式 `kimi web`：REST+WS，**`GET /api/v1/sessions/{id}/status` 直接返回 `context_usage(0-1)`**（比 OpenCode 更直接）
- SDK：`@moonshot-ai/kimi-code-sdk`（createKimiHarness → create/resume/fork session、compact、getUsage）
- hooks：config.toml `[[hooks]]`（SessionStart/Stop/PreCompact...，exit 2 阻断）
- 多实例：每实例独立注册，端口自增；session 绑定工作目录（跨目录 resume 拒绝）

## 五、推荐集成架构（两路调研共同结论）

**任务管理器作为"驱动层"，抽象薄 adapter 接口，通过各家官方 HTTP API/SDK 控制 agent：**

```
adapter 接口: createSession / prompt / subscribeEvents / contextUsage / fork / compact / interrupt
├── OpenCodeAdapter  (@opencode/client → 后台 service SSE + REST)
└── KimiAdapter      (kimi web REST/WS 或 SDK)
```

- CLI (`opencode run` / `kimi -p`) 做兜底/首集成层：零依赖、进程隔离、退出码可判
- OpenCode plugin 用于给 worker session 注入任务协议（类似 superpowers bootstrap）
- R4 换 session 最优路径：旧 session 末尾触发 compact（摘要即 handoff）→ fork/新建 → 注入摘要继续

## 附：克隆清单（repos/）

rove · ordewell · NEEDLE · sortie · ralphex · sub-agents-skills · agent-toolkit · awesome-agent-orchestrators
（superpowers 可作为独立的工作流参考；无需依赖本地固定目录。）
