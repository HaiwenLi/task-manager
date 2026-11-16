# 遗留项与已知边界

这份文件记录"**有意没做**"和"**做了但有限制**"的东西，避免下次重新讨论一遍，也避免后来的人把当前实现信得比实际更足。

它不记录已完成的工作——那些在 [真实任务复盘](reviews/2026-11-16-real-task-retro.md) 里有逐条依据（N1–N5 已闭环）和两次独立复核报告（`reviews/2026-11-17-*-review.md`）。

更新方式：每跑完一批真实任务，把新发现的问题加进来、把已经不再需要的划掉。**不做**不等于**忘了**，也不需要为了列表变短而做。

最后更新：2026-11-16（`main@d058caa` 之后）

---

## 1. 验证层面的空白（最重要）

| 项 | 状态 | 说明 |
| --- | --- | --- |
| `tsc --noEmit` 类型检查 | **从未执行过** | 本机源码被 TSD 按等级透明加密：`node`/`tsc` 读到的是密文，报 `TS1490 File appears to be binary`；`git archive` 导出到 `%TEMP%` 也不管用（写入即加密，与目录无关）。所以"类型正确"目前只有**人工读代码**这一个证据。要验必须在一台不受 TSD 覆盖的机器上跑 |
| 真实环境端到端 | **未跑过** | `modelFallbacks`（429 换模型）和 `tolerate`（运行期别人改表）这两条都是为真实场景写的，但证据全部来自 fake adapter |

这两条是"代码可信度"的天花板。在它们补上之前，`284 passed / 1 skipped` 只证明逻辑分支对，不证明类型对、也不证明在真后端下对。

## 2. 功能待办（retro N6–N9）

| 项 | 量 | 现在不做会怎样 | 什么时候值得做 |
| --- | --- | --- | --- |
| **N6 acceptance 生成器** | 1.5 天 | 表格/文档类任务全靠模型复核。真跑数据：复核 92k input vs 执行 33k，其中大半是脚本一条命令就能断言的东西（行数、表头集合、前缀缺失、回读差异） | 复核费用/延迟成为瓶颈时；或返工轮次里有"本该脚本抓出来"的失败时 |
| **N7 证据自包含** | 0.5 天 | 每回合 transcript 不落盘，回看要手工 `session export`；`review.json` 没有 `reviewerSessionId`；journal 没有逐回合 token/耗时 | 需要复盘"模型当时到底看到了什么"时——排查复核误判尤其需要 |
| **N8 进度可见** | 0.5 天 | 首个回合 20 分钟没有任何 CLI 输出，只能靠外部 telemetry 猜它还活着 | 长任务变多、盯盘成本变高时 |
| **N9 控制台编码** | 0.2 天 | Windows 控制台中文乱码，日志要重定向到文件才看得清 | 换成 Windows Terminal + UTF-8 后可能自动消失；先确认再动 |

## 3. 小尾巴（都是"卡住时少个工具"）

| 项 | 量 | 说明 |
| --- | --- | --- |
| `taskctl retry --reset-sessions` | 0.3 天 | 因**会话预算耗尽**而 blocked 的任务，`retry` 只重置计数、不重置会话链，重开后立刻再 blocked。是个死循环，但只影响这一类 blocked |
| `taskctl workspace list` / `prune` | 0.5 天 | 预留泄漏只能手工看 `%TEMP%\opencode\taskctl-workspaces\reservations.json`。曾经 3 条孤儿记录把工作目录卡死，靠人工清。`prune` 必须显式确认，不许自动抢 |
| 注册表错误分类 | 0.3 天 | 注册表损坏时 `reservationsFor()` fail closed 抛错（安全），但 `reconcile` 会把栈打给用户而不是给一个结论 |
| 预留三态 | 0.3 天 | Git 元数据读不出来时退化为纯路径比较，诊断会误报"无预留"。正确形状：`known-common` / `known-no-common` / `unknown` → `unknown` 映射到 `manual-review` |
| provider 退避 | 0.2 天 | 降级链只有"换模型"，链走完就按 `retryLimit` 计失败，没有等待重试 |
| `reviewerModel` 与 `model` 强制不同 provider | 0.2 天 | 只写进文档，没强制。同 provider 的"独立复核"独立性存疑，但强制会让人用 `--allow-same-provider` 绕过，不如讲清楚 |
| 恢复面的 ADR | 0.3 天 | `reconcile` / `retry` 的语义（什么能自动恢复、什么必须人工）还没进 `docs/adr/`，目前只在 README 和代码注释里 |
| `tolerate` 的 CLI 入口 | 0.2 天 | 现在只能改 frontmatter，和 worker 同一条通道——已被定义检查兜住（执行期改定义 → 验收作废），但人工操作也不方便 |

## 4. 已交付功能里的已知边界（别当成 bug 报）

**模型降级链**
- 只在 adapter 判定 `failure: "provider"`（429 / 配额 / 鉴权 / 5xx）时轮转；其它错误照旧计失败
- 换模型即换会话：新模型不续用别的后端创建的会话，被拒的回合也不记进 `sessions`
- 位置记在 `tasks/<id>/models.json`：读全量容错、写失败则不算换过（按普通重试计失败）
- `reviewerModelFallbacks` 只在配了 `reviewerModel` 时生效；后者不设置时用的是后端默认模型，**不继承** `model`

**外部漂移容忍（`tolerate`）**
- 词表只有四种：`external_cell_change` / `new_column` / `deleted_row` / `extra_file`，写错直接报错
- 不含：删列、加行、改名 sheet、改文件内容、格式变化——这些仍按原规则判 fail
- 时间窗口是 **per-attempt**：返工一轮后，上一轮造成的损伤会被读成"本来就有"。真正的"写入窗口"没做
- 界限：只有声明的类别可以归因为外部变更；证据说明不了先后的**交付内容**按本任务的问题处理；被容忍的差异会记录（`review.json`、journal、`report`、`accept` 打印），但"容忍"本身是声明，不是模型的自证
- 定义（`criteria` / `tolerate` / `risk` / `human_check` 等）在执行期被改 → 本次验收作废并 `blocked`，包括 worker 自己改自己的 frontmatter

**blocked 与恢复**
- 不按记录的 PID 杀进程（PID 复用无法证明归属，ADR-0007）
- 执行停止未确认（`attempt.phase ≠ settled`）的任务，`retry` 一律拒绝；把 `uncertain` 合法转成 `settled` 的受控流程仍未做
- `reconcile` 只读，`retry` 只对 `blocked` + attempt 已 settled + 无活跃锁 + 无匹配预留的任务生效

## 5. 测试套件的一个已知偶发

`tests/worker-review.test.ts` 在 285 条里有 **1 次**失败，出现在 `git checkout` 重写 90 个文件之后那一轮（TSD 重新加密 + 杀毒扫描导致 IO 变慢），单跑必过，之后连跑 7 次全量复现不出。

判断：与之前修掉的 `scheduler` 竞态同类（时间断言撞上慢 IO），但**没有修**，因为无法稳定复现。如果再出现，把断言改成等事件而不是等时间。

## 6. 顺手可清的历史垃圾

- 本地 `refs/private/taskctl-before-publication-20261102-f3bbec6`：发布前的原始备份点，**故意不推**。它保存的是脱敏前的历史，删了就没了追溯退路
- 远程 tag `p1-review-loop`：上一轮的发布标记，指向 `04be731`，与当前 `main` 无关
