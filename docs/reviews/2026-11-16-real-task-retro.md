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

**实现进度：已修（第二轮）**。做法不是放宽 `cancel()`，而是把"后端拒绝了这一回合"从"进程死了"里分出来：

1. adapter 契约新增 `PromptResult.failure?: "provider"`；OpenCode adapter 从 NDJSON 的 error 事件与 stderr 识别 429/配额/鉴权/5xx
2. `controlled()` 新增 `acceptSettled` 判定：结果已结算且被判定为 provider 拒绝时，直接返回该结果，**不进入**"状态是否 exited → 取消 → 确认停止"那条链
3. worker 回合：与普通失败一样计 `retryLimit`，不再落成 uncertain
4. 复核阶段：`ReviewResult.failure` 透传，复核被拒时计一次重试并回到 `open`，而不是转 `awaiting-human`

测试 `tests/provider-failure.test.ts` 用同一个 fake adapter 跑了对照组：带 `failure: "provider"` 时 blocked 原因是 `retry limit`、`cancel` 零调用；不带时仍是 `shutdown unconfirmed` 且 `cancel` 被调用——两条路径不会互相污染。

**后续**：模型降级链在 N5 落地（见下），provider 拒绝不再只是"重试同一个模型"；仍未做的是退避等待（现在靠换模型绕过，链走完就按 `retryLimit` 计失败）。

### N3 `blocked` 是死胡同

**症状**：本次 3 次 `blocked` 全部由人工改文件恢复（归档 `attempt.json`、清注册表、改 frontmatter 状态）。README 里写的就是手工流程，但没有任何命令支撑。

**方案**：把手工流程里"可安全自动化"的部分产品化，两个命令（写 journal）：

- `taskctl reconcile <id>`：只读诊断——锁、attempt 阶段、归属路径、匹配预留、pid 存活，给出 `retry-allowed` / `manual-review` / `already-terminal`
- `taskctl retry <id>`：仅当 `blocked`、attempt 已 `settled`、无活跃锁、归属路径确定且无匹配预留时，归档 `attempt/acceptance/review` 到 `archive/<ts>/`、重置计数、状态回 `open`

**明确不做 `cancel`（原方案里的第三条）**：评审查明它会按记录的 PID 直接 `taskkill /T /F`，而这正是 ADR-0007 明令禁止的（PID 会被复用，无法证明仍属该次执行）；并且它对"父进程已消失"会返回"已停止"，与 `execution.ts` 的保守语义相反，可能让人据此归档并重放一个仍在跑的子树。同时 `cancel` 若把 attempt 标成 `uncertain`，`retry` 就永久拒绝，形成死路。故本轮撤回，留作带前置条件的设计：记录 `pidStartedAt` + 校验镜像名 + 显式 `--pid` 确认，并且先补齐"人工确认后把 uncertain 合法转成 settled"的受控转移。

**状态**：`reconcile` / `retry` 已实现（`src/reconcile.ts` + CLI + `tests/reconcile.test.ts`，9 条测试）。守卫逐条有测试：非 `blocked`、attempt 未 `settled`、活跃锁、归属路径被预留、归属路径不可知。`retry` 只改 Markdown 状态与归档证据，不绕过验收；检查与写入都在 `.mutation.lock` 内并二次复核。

**遗留边界**：注册表损坏时 `reservationsFor()` fail closed（抛错），这是对的，但 `reconcile` 会直接抛栈而不是把"注册表损坏"作为结论展示；下一步把注册表错误分类后交给诊断命令输出。另外 `retry` 只重置计数，不重置会话链——因会话预算耗尽而 blocked 的任务会再次 blocked，需要 `--reset-sessions` 或文档说明。

**另一个已记录的 fail-open**：`reservationsFor()` 在 Git 元数据读不出来时（缺 git、safe.directory、不可读）退化为纯路径比较，可能漏掉同一仓库其他 worktree 的预留。安全上不致命——同样的失败会让 `reserveWorkspace()` 直接抛错，不会造成并发执行——但诊断会误报"无预留"。正确形状是复用它已经用过的三态：`known-common` / `known-no-common` / `unknown`，`unknown` 映射到 `manual-review`。

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

**实现进度：降级链已做，provider 强制分离未做。**

1. `taskctl.json` 新增 `modelFallbacks` / `reviewerModelFallbacks`（`string[]`）；链条 = 主模型（任务 frontmatter 的 `model` 优先）+ 备用列表，去重去空。没有主模型时链条为空——备用列表只是追加，不会替人"选"一个没人配的模型
2. 只有在 adapter 判定 `failure: "provider"` 时才轮转，并且**不消耗重试额度**：这一回合根本没干活，把额度花在必然不可用的模型上才是浪费。链条有限，走完照旧按 `retryLimit` 计失败
3. 当前位置写 `tasks/<id>/models.json`（不是 `attempt.json`——它要活过自己触发的重试）；位置里存的是**选中的模型名**而不只是下标，主模型被改动后旧下标不会悄悄指向另一个备用模型。`taskctl retry` 把它和旧证据一起归档，回到链首
4. `models.json` 是提示性状态不是证据，读写两半分开对待：**读**全量容错（缺失、损坏、越界、模型对不上 → 从链首开始），绝不因为缓存文件把已结算的回合推成 `uncertain`；**写**失败则不认为换成了（返回 false，走普通重试并 journal 记 `model-fallback-failed`），因为位置正是"下次别再撞同一堵墙"的唯一凭据
5. 换模型同时是**会话边界**：被拒的回合不记进 `sessions`，下一个模型也不续用别的后端创建的会话——否则一个外来会话被新 provider 拒绝会产生非 429 的普通失败，把 `retryLimit` 原地烧光，正好是这功能要避免的结局
6. 复核被拒在**复核阶段内部**换模型重试，不把任务退回 `open` 重跑：非幂等任务（写共享表、移文件）不能为了重试一次复核被执行两遍。没有备用模型时才回到"计一次失败 + 重开"
7. 事件与 journal 都记 `model-fallback`（`from -> to` + 原因）；`acceptance.json` / `review.json` 记下实际使用的模型，被备用模型判定通过的工作与主模型判定通过不是同一个声明
8. `tests/model-fallback.test.ts` 13 条覆盖：不花额度（`retryLimit=1` 下仍能跑完）、会话边界、链耗尽才 blocked、跨 attempt 保持位置、复核原地重试（只跑一次 worker）、无备用时重开、损坏/不可读/不可写三种文件状态、主模型变更后重新定位、无主模型时忽略备用列表

**未做**：`reviewerModel` 与 `model` 强制不同 provider（担心把 `--allow-same-provider` 做成一个人人都会加的参数，不如在文档里写清"同 provider 的复核独立性存疑"）；退避等待。

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
| P0 | N2 退出语义三分 | 1 天 | ✅ 已实现（provider 拒绝标 `failure: "provider"`，不升级成 uncertain） |
| P0 | N3 reconcile/retry | 1 天 | ✅ 已实现（cancel 已撤回） |
| P1 | N4 外部漂移容忍 | 1.5 天 | 待做 |
| P1 | N5 reviewer 降级链 | 0.5 天 | ✅ 降级链已实现；同 provider 强制分离未做 |
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

- `src/workspace.ts`：`reserveWorkspace` 失败路径先清理本次创建的 marker/锁目录（校验 dev/ino），再回滚注册表记录；新增只读 `reservationsFor()`，与预留判定一致地把 Git common dir 纳入路径区间比较
- `src/reconcile.ts`：新增 `reconcileTask` / `retryTask`（不含 kill 语义）
- `src/cli.ts`：新增 `reconcile` / `retry` 两个子命令
- `src/task-store.ts`：`TaskFieldsPatch` 增加 `retries` / `reviewRounds`，供 retry 重置计数
- `tests/workspace.test.ts`：回归测试「stale 锁目录 → 预留失败 → 注册表必须为空 → 清理后可预留」
- `tests/reconcile.test.ts`：9 条测试覆盖诊断结论（含已 settled 但 pid 存活的复用情形、归属路径不可知）与 retry 的四类守卫 + 归档/重开
- 验证：`npx vitest run` **253 passed / 1 skipped**，连续两轮全绿；此前偶发的 `workspace`/`pipeline-e2e` 失败已定位为 `withRegistryMutex` 在 Windows 并发 `mkdir` 下的 `EPERM`（只在全量并行时出现、单文件必过），已改为在截止时间内重试并保留原始错误码。`tsc --noEmit` 在本机受 TSD 透明加密影响仍不可用（`TS1490`），需在未加密环境复验

### 评审后的修正（同一轮内）

- 撤回 `taskctl cancel`：按记录的 PID 杀进程违反 ADR-0007，且与 `execution.ts` 的保守语义冲突
- 撤回 `controlled()` 的 `settledByResult`：评审证明它惰性且跳过了一处校验
- `reconcile` 不再把"已 settled 但 pid 存活"判成待停止（那是 PID 复用），只在 attempt 未 settled 时提示
- `retry` 的预留检查补上"attempt 没有 workspace 时用配置 workdir 解析"的兜底；两者都不可知时拒绝
- `retry` 的检查与写入放进 `.mutation.lock` 并二次复核，避免守卫与写状态之间的时间窗

### 第二轮补充（N2 / N5 落地）

- `src/adapters/types.ts` + `src/adapters/opencode.ts`：`PromptResult.failure?: "provider"`，从 NDJSON error 事件与 stderr 识别 429 / 配额 / 鉴权 / 5xx
- `src/worker.ts`：`controlled(..., acceptSettled)` 让"已结算的 provider 拒绝"跳过取消确认；`reviewStage` 透传 `ReviewResult.failure` 并在原地重试复核；新增模型降级（`modelFor` / `fallBack`），`turn` 与复核都按链取模型；换模型即换会话
- `src/models.ts`：新增模型链与轮转状态（`modelChain` / `chainPosition` / `readModelRotation` / `rotateModel`）——`tasks/<id>/models.json`，读全量容错、写失败不外抛
- `src/cli.ts`：`modelFallbacks` / `reviewerModelFallbacks` 两个 `string[]` 字段的校验
- `src/reconcile.ts`：`retry` 把 `models.json` 一并归档（手动重开 = 回到链首）
- `tests/model-fallback.test.ts`：13 条；`tests/provider-failure.test.ts`：2 条对照；`tests/reconcile.test.ts` / `tests/cli-config.test.ts` 各补一条
- 独立复核（`docs/reviews/2026-11-17-model-fallback-review.md`）判为 ship with fixes，四条阻断项已按上表修正：`turn` 返回类型补 `PromptResult`、`models.json` 读全量容错且写失败不外抛、复核原地重试、换模型即换会话
- 复核的复检（同文件 "Re-check" 节）判为 ship，并指出三条值得修的：两个换模型循环的终止都依赖"读回刚写的位置"，在缓存/同步文件系统上可能读到旧位置而无限循环且不花重试额度 → 改为按链长显式设上限；`fallBack` 把 `OwnershipLostError` 当写失败吞掉 → 改为透传，租约丢失按 skip 处理而不是记成 I/O 问题；`tests/scheduler.test.ts` 的并发断言靠 20ms 睡眠窗口，而它的 fake adapter 从不提交完成请求，每个任务实际空转满 40 个回合（4 次全量跑 2 红 2 绿）→ 改为"等对端进入"的屏障 + `maxTurnsPerSession: 1`，该文件从 11s 降到 2.7s
- 验证：`npx vitest run` **270 passed / 1 skipped**，连续三次全绿
