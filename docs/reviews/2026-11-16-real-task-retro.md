# 真实任务复盘：taskctl 在「共享目录整理 → 在线表格」上的表现

Date: 2026-11-16
Scope: 两个真实任务（`docs-table`、`trim-prefix`）的完整运行记录与日志。
结论先行：**核心假设成立**——agent 真能干活、独立复核真能抓错、验收可追溯；但**运维面缺口在真实共享环境里立刻暴露**，且大部分是"跑一次才会知道"的问题。

## 1. 这次跑了什么

| 任务 | 内容 | 结果 | 复核 |
| --- | --- | --- | --- |
| `docs-table` | 23 个待整理目录 → 在线表格 32 行 | done | 第 1 轮 fail（17≠23 行、缺快照、版本冲突）→ 返工 → pass |
| `trim-prefix` | 表格「下载路径」列去 UNC 前缀 | done | 两次 `blocked`（模型 429、预留泄漏）→ 人工对账 → pass |

## 2. 量化

- 墙钟：13:50 → 16:03，约 2 小时 13 分
- 人工干预：3 次（归档 uncertain attempt、清泄漏预留、改状态+换模型），**全部因基础设施缺口，无一次因内容返工**
- worker 会话：33k–178k input / 6.8k–12.5k output
- reviewer 会话：92k–172k input / 8.8k–20.4k output（约为执行侧的 2–3 倍输入）
- cost：0（各家 coding plan 套餐内）

## 3. 之前没有意识到的问题

### N1 工作区预留失败会泄漏注册表记录（已修复）

**症状**：任务 `blocked` 后重开，立刻再次 `blocked: workspace reserved by another or uncertain execution`，重试几次都一样。

**证据**：注册表里同一 `cwd` 出现了 3 条记录（`21056dc4` / `8472f815` / `1c87920d`），而持有者进程早已不存在；目录里还留着一个空的 `.taskctl-workspace.lock`。

**根因**：`reserveWorkspace()` 先 `writeRegistry([...records, record])`，再 `mkdir(lock)`；`mkdir` 命中 `EEXIST` 时直接 `return null`，**已写出的记录没有回滚**。孤儿记录没有 owner，`release()` 永远不会覆盖它 → 该路径范围被永久占死。每失败一次多一条，形成"越重试越锁死"的正反馈。

**方案**：

1. 失败路径回滚注册表（本次已实现，带回归测试）
2. 增加 `taskctl workspace list`（只读：列出记录、cwd 是否还存在、marker 是否存在、PID 是否存活）与 `taskctl workspace prune`（仅清理"记录存在但本地 marker 缺失且无存活进程"的孤儿，需显式确认）
3. 注册表记录增加 `createdAt` / `holderPid`，便于诊断

**怎么证明修好了**：单测覆盖"stale lock 目录 → 尝试预留 → 注册表必须回到空"；再加一条 e2e：连续两次失败预留后仍能成功预留。

### N2 「已经退出」被当作「停止未确认」

**症状**：reviewer 撞上 provider 429（`Token Plan 用量上限`），会话 `outcome: failed` 正常结束，任务却 `blocked: review: shutdown unconfirmed; automatic retry prohibited`。

**根因**：`execution.cancel()` 在 Windows 分支里，进程一旦 `exited` 就直接 `uncertain = true; return false`（本意是避免 `taskkill` 误杀复用 PID 的无关进程）；`controlled()` 把 `false` 一律当作"停止未确认"，于是**一个已经明确失败退出的回合被升级成不可重试的不确定执行**。

**方案**：把结局分成三类，而不是二元：

1. 已知退出码（成功/失败）→ 可重试，记录 `exitCode`
2. 超时但已确认停止 → 可重试，记录 `timeout`
3. 无法确认停止 → `uncertain`，才需要人工对账

同时把 provider 的 `429/5xx/rate_limit` 识别为 `external-transient`：不消耗 `retryLimit`、不退化成 `uncertain`，走带退避的重试并允许切换模型。

**实现进度**：已先落一步——`controlled()` 现在记录"结果是否由执行本身结算"（`settledByResult`），结算过就直接把错误原样抛出，不再走取消判定。这一步不改变 `cancel()` 的安全语义，因此不破坏既有测试"父进程先消失时不得声称已确认停止"。**剩余部分（429 归类、三分语义）本轮未改**，原因如下。

**改不动的原因（重要）**：曾尝试让 `cancel()` 对"已退出"的进程直接返回 `true`，结果 `tests/execution.test.ts` 里那条既有测试立刻失败——它守的是一条真实安全性质：父进程在请求取消前就消失时，Windows 无法再定位其子进程树，此时若声称"已确认停止"，就可能把仍在跑的后端会话当成已停。所以正确做法不是放宽 `cancel()`，而是让 **adapter 明确报告"这次是 provider 侧失败"**（例如在 `PromptResult` 上带 `failure: "provider"`），让 `controlled()` 在不调用 `cancel()` 的前提下计一次可重试失败。这条要改 adapter 契约，需单独评审。

### N3 `blocked` 是死胡同

**症状**：本次 3 次 `blocked` 全部由人工改文件恢复（归档 `attempt.json`、清注册表、改 frontmatter 状态）。README 里写的就是手工流程，但没有任何命令支撑。

**方案**：把手工流程产品化，三个命令（全部写 journal，全部幂等）：

- `taskctl reconcile <id>`：只读诊断——lock/attempt/acceptance/预留/进程存活，给出"可 retry / 必须先停进程"的结论
- `taskctl cancel <id>`：按 `attempt.pid` 停进程树 → 标 `uncertain` → 提示 reconcile
- `taskctl retry <id>`：仅当 `phase=settled`、无活跃锁、无匹配预留时，归档 `attempt.json`/`acceptance.json` 到 `archive/<ts>/`，状态回 `open`

**状态：已实现**（`src/reconcile.ts` + CLI + `tests/reconcile.test.ts`，9 条测试）。守卫：非 `blocked` 拒绝、`attempt` 未 `settled` 拒绝、活跃锁拒绝、工作目录仍被预留拒绝；`retry` 只改 Markdown 状态与归档证据，不绕过验收。

**遗留边界**：`reservationsFor()` 在注册表损坏时 fail closed（抛错），这是对的；但 `reconcile` 现在会直接抛栈而不是把"注册表损坏"作为结论展示。下一步把注册表错误分类后交给诊断命令输出。

### N4 共享表在任务运行期被人工编辑是常态

**症状**：任务运行中，人加了 1 列、删了 1 行、改了 4 个单元格；复核因此判 fail（"列数/表头/零附带改动"不成立），白跑一轮 20 分钟。

**根因**：基线是"任务开始那一刻的整表快照"，而现实是多人同时编辑。当前 spec 只能要求"结构不变"，做不到就只能 fail。

**方案**：

1. spec 增加声明式容忍：`tolerate: [external_cell_change, new_column, deleted_row]`
2. 复核改用**分段基线**：只对"写入窗口（before-write → after-readback）"断言零附带改动；窗口之外的差异一律归因为外部变更，逐条列出而不是判失败
3. 基线记录 `takenAt` + 每张表的 `sha256`，复核时按时间切片比对

### N5 reviewer 是单点

**症状**：一个 provider 的配额耗尽 → 整个任务阻塞 9 分钟并 `blocked`。

**方案**：`reviewerModels: ["…", "…"]` 顺序降级；429 时等待并切换下一个 provider；`reviewerModel` 与 `model` 强制不同 provider（可用 `--allow-same-provider` 覆盖），否则"独立复核"名存实亡。本次救急时两者被迫都用了 `deepseek-v4.1-flash`。

### N6 没有 acceptance 就全靠模型复核

**数据**：reviewer 92k input vs worker 33k——复核比执行贵 2–3 倍，而其中大半是"本来一个脚本就能断言"的检查（行数、列头、前缀命中数）。

**方案**：office/表格类任务内置 acceptance 生成器：`row-count`、`header-set`、`prefix-absent`、`readback-diff` 四类断言模板；先跑脚本，脚本失败直接 retry，不进复核。脚本通过再交给 reviewer 只判"语义/质量"。

### N7 证据链不自包含

**症状**：`review.json` 不记 reviewer 的 session id，transcript 要手工 `session export`；journal 只有 9 条事件，没有每回合的 token/耗时。

**方案**：每回合结束自动导出 transcript 到 `tasks/<id>/sessions/<n>-<role>.json`；`review.json` 增加 `reviewerSessionId`；journal 记 `turn`/`tokens`/`durationMs`。

### N8 长回合不可观测

**症状**：首个回合 20 分钟没有任何 CLI 输出，只能靠外部 telemetry 采样确认它还活着。

**方案**：`--verbose` 转发 opencode NDJSON 的 `step_start`/`tool` 事件；默认每 60s 向 journal 写一行 progress。

### N9 Windows 控制台中文乱码

**症状**：`taskctl status` 的中文 note 在 GBK 控制台显示为乱码（文件本身正常）。

**方案**：输出统一 UTF-8（或提供 `--json`）；不要把编码问题留给用户猜。

## 4. 被这次运行证实的既有缺口

- 没有 `cancel`/`retry`/`reconcile`（见 N3）
- 没有 `--watch` 常驻队列：任务落地后要手工再起一次
- 打包与 shim 仍靠手工：agent 会话里必须能找到 `taskctl`
- 中途改规则无通道：运行中改 spec 会触发 `definition drift`，只能等这一轮结束

## 5. 做对了的地方（不要动）

- **独立复核真的在把关**：抓出"17 行 ≠ 23 个目录"这种只有真比对才会发现的问题，并给出单元格级证据
- **服务端历史做归因**：v217 是本任务写入点，v218 之后的外部改动可逐条区分——这是共享表格场景的关键能力
- **快照 + 逐格断言**：可复核、可回放、可写进报告
- **工作目录独占 + 会话链**：长任务没有因上下文耗尽中断
- **事件流与 journal**：出问题能还原时间线

## 6. 优先级

| 优先级 | 项 | 工作量 | 状态 |
| --- | --- | --- | --- |
| P0 | N1 预留回滚 + workspace 诊断 | 0.5 天 | ✅ 回滚已修；list/prune 待做 |
| P0 | N2 退出语义三分 | 1 天 | 🟡 仅 `settledByResult` 一步；provider 失败分类待做 |
| P0 | N3 reconcile/cancel/retry | 1.5 天 | ✅ 已实现（9 条测试） |
| P1 | N4 外部漂移容忍 | 1.5 天 | 待做 |
| P1 | N5 reviewer 降级链 | 0.5 天 | 待做 |
| P1 | N6 acceptance 生成器 | 1.5 天 | 待做 |
| P2 | N7 证据自包含 | 0.5 天 | 待做 |
| P2 | N8 进度可见 | 0.5 天 | 待做 |
| P2 | N9 编码 | 0.2 天 | 待做 |

## 7. 验收标准（每条怎么证明修好）

- N1：单测（已加）+ 手工造 stale lock 目录，连续两次失败后仍可预留
- N2：fake adapter 注入 429，断言进入 `external-transient` 重试而不是 `blocked`
- N3：e2e `blocked → reconcile → retry → done`
- N4：运行中改表（加列/删行），断言 pass 且差异归属 `external`
- N5：把 reviewerModel 指向已知会 429 的 provider，断言自动切到备用
- N6：表格类任务的 acceptance 脚本失败时，断言不进复核
- N7：断言 `tasks/<id>/sessions/` 下出现两个角色的 transcript，`review.json` 有 `reviewerSessionId`

## 附录 A：本次代码改动

- `src/workspace.ts`：`reserveWorkspace` 失败路径回滚注册表记录，并清理本次创建的 marker/锁目录；新增只读的 `reservationsFor()` 供诊断使用
- `src/reconcile.ts`：新增 `reconcileTask` / `retryTask` / `cancelTask`
- `src/cli.ts`：新增 `reconcile` / `retry` / `cancel` 三个子命令
- `src/worker.ts`：`controlled()` 记录 `settledByResult`，结果已结算时不再走取消判定
- `src/task-store.ts`：`TaskFieldsPatch` 增加 `retries` / `reviewRounds`，供 retry 重置计数
- `tests/workspace.test.ts`：回归测试「stale 锁目录 → 预留失败 → 注册表必须为空 → 清理后可预留」
- `tests/reconcile.test.ts`：9 条测试覆盖诊断结论、四类 retry 守卫、cancel 的两种结局
- 验证：`npx vitest run` **249 passed / 1 skipped**；`tsc --noEmit` 在本机受 TSD 透明加密影响不可用（`TS1490: File appears to be binary`），需在未加密环境复验
