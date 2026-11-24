# 遗留项与已知边界

这份文件记录"**有意没做**"和"**做了但有限制**"的东西，避免下次重新讨论一遍，也避免后来的人把当前实现信得比实际更足。

它不记录已完成的工作——那些在 [真实任务复盘](reviews/2026-11-16-real-task-retro.md) 里有逐条依据（N1–N5 已闭环）和两次独立复核报告（`reviews/2026-11-17-*-review.md`）。

更新方式：每跑完一批真实任务，把新发现的问题加进来、把已经不再需要的划掉。**不做**不等于**忘了**，也不需要为了列表变短而做。

最后更新：2026-11-17（`main@a8b74fe`；车道与验收方式见 [ADR-0009](adr/0009-lanes-and-verification.md)；本轮落地 `artifactIgnore` / `TASKCTL_ACCEPTANCE_MODE` / 复核改动证据，边界见第 4 节；同日第二轮落地产物卫生——`TASKCTL_LOG_DIR` 约定 / `run --log` / 回合后清扫，边界见第 4 节）

---

## 2026-11-24 对账（只列已核实的出入）

本文件其余部分停在 2026-11-17。下表是对照当前代码与 2026-11-24 的验证，**已核实**不再成立的条目；其余条目没有逐条复核，读的时候按这个日期折算。

| 处 | 原文 | 现状（已核实） |
| --- | --- | --- |
| 第 1 节 `tsc --noEmit` | 「从未执行过」（TSD 透明加密，`tsc` 读到密文） | 2026-11-24 在本机可以运行：`npx tsc --noEmit` 退出码 0，remediation plan 的每一轮门槛都有记录。原因没有查（白名单或加密状态变了），这里只记事实 |
| 第 1 节「真实环境端到端」 | 「大部分未跑过」 | 2026-11-24 做过有界 Live 验证（`scripts/smoke.ps1 -Live`、`scripts/live-phase2.ps1 -Live` 15/15），见 README「测试」。仍未验证：真实后端的取消、中断恢复、进程信号、复核超时 |
| 第 1 节末句的用例数 | `307 passed / 1 skipped` | 已过时；当前门槛见 [phase2-review-remediation](superpowers/plans/2026-11-24-phase2-review-remediation.md) |
| 第 0 节「Simple/Complex 自动分流的分类 agent」 | 「分类器要等 `escalated` 事件积累出比例才有依据」 | 设计 §16 已经落地了模型分类（`taskctl add` 按模型给的车道决定是否等签字）。它与 ADR-0008/0009 的冲突尚未写 supersession，待所有者裁决 |
| 第 5 节「已知偶发」 | `tests/worker-review.test.ts` 1 次失败，「撞上慢 IO」，未修 | 2026-11-24 在 `tests/model-chain.test.ts` 上复现并定位了**一个**同类根因：Windows 上改名覆盖被短暂拒绝（EPERM）时，锁心跳把它当成所有权丢失。改名统一带重试、心跳写失败不再等于丢锁之后，同一循环 45 次不再失败。当时 `worker-review` 那次是否同因，无法回溯确认 |

---

## 方向（2026-11-17 定）

判断标准只有一条：**能不能改变下一次真实任务的结果**。能，就做；不能，或者做起来复杂而收益小，进这张表等触发条件。

所以本期不建新功能。已经加进来的机制——车道、`verify`、渲染检查、EGM 复核规则、返工空转判定——全部只有 fake adapter 下的证据。再加一层功能，只会让"未验证的面积"更大。下一步是拿真任务跑，看哪些机制真的触发、哪些是摆设，数据出来再决定后续。

下面每一项都写了"什么时候值得做"。到那个时刻再做，不是现在。

## 0. 车道与验收（`feat/task-lanes` 之后）

已落地：`--quick` 无 spec 车道、`verify: human|mechanical|render`、运行期向上升级（`ESCALATE:` / 会话交接），以及 `taskctl verify` 的无头浏览器渲染检查。下面这些是**没有一起做**的部分：

| 项 | 说明 | 什么时候值得做 |
| --- | --- | --- |
| Simple/Complex 自动分流的分类 agent | 现在车道由人或显式 flag 选，升级在运行期兜。分类器要等 `escalated` 事件积累出比例才有依据 | 跑够真实任务、能统计"快速车道里被升级的比例"之后 |
| 升级写回 `complexity` | 升级只进 journal 和事件流，任务文件不改（避免动 `definitionDigest`），所以 `board` 看到的仍是开单时的车道 | 需要按"实际复杂度"统计工作量时 |
| 渲染检查的覆盖面 | 只看横向溢出、空白、未捕获异常、坏图。纵向遮挡、对比度、字体缺失都不在判据里 | 出现"渲染通过了但人一看就是坏的"时 |
| `verify: render` 的浏览器依赖 | 机器上没有 Chrome/Chromium 时任务 `blocked`（而不是退化成复核）。这是刻意的，但意味着渲染任务不能跑在无浏览器的 CI 上 | 要在 CI 里跑渲染验收时，先加一个 headless 浏览器镜像 |
| 快速车道的归档 | 现在 `--quick` 的任务和别人一样留在 `tasks/` 里，没有自动清理。跑多了会堆积 | 快速任务占比高到看板被淹时（届时做二级存储 + `prune`） |

## 1. 验证层面的空白（最重要）

| 项 | 状态 | 说明 |
| --- | --- | --- |
| `tsc --noEmit` 类型检查 | **从未执行过** | 本机源码被 TSD 按进程白名单透明加密，同一份文件不同进程看到的字节不同：`node`/`tsx`/`vitest` 在名单里，读到明文（所以测试跑的是真代码）；`tsc` 不在名单里，读到密文，报 `TS1490 File appears to be binary`。`git archive` 导出到 `%TEMP%` 也不管用（写入即加密，与目录无关）。所以"类型正确"目前只有**人工读代码**这一个证据。要验必须在一台不受 TSD 覆盖的机器上跑 |
| 加密范围不止 `.ts` | 已确认（2026-11-16） | `tests/fixtures/process-tree.mjs`、`tests/adapters/fake-opencode.mjs` 同样是密文存放：本仓的 `read` 工具判定 `binary file`，`graphify update` 报 `not valid UTF-8; read it as latin-1`，而 vitest 照常执行。**看到这类警告不要"另存为 UTF-8"**——那一步会把明文写进磁盘，正好破坏当前的加密状态。代价只是这些文件在知识图谱里没有符号 |
| 真实环境端到端 | **大部分未跑过** | `modelFallbacks`、`tolerate`，以及 2026-11-16/17 新增的车道、`verify`、渲染检查、EGM 复核规则、空转判定，证据全部来自 fake adapter。逐条见 §1.1 |

这两条是"代码可信度"的天花板。在它们补上之前，`307 passed / 1 skipped` 只证明逻辑分支对，不证明类型对、也不证明在真后端下对。

## 1.1 新机制的真实反馈缺口（2026-11-17）

每条都只有 fake adapter 或自制产物下的证据。真跑第一批任务时，就盯这张表：

| 机制 | 不知道的事 | 去哪里看 |
| --- | --- | --- |
| `ESCALATE:` 升级 | 真实 worker 会不会写、会不会滥用（每次都说"比预想大"就等于没有信号） | journal 的 `escalated` 条数 / 任务总数 |
| `verify: render` | 只在自制页面上验过；真实产物会不会误报（管理后台类页面的横向滚动容器）或漏报 | `render.json` 与人工看一眼的差异 |
| EGM P1 提示词 | 真实 reviewer 是否真按"引具体产物""带严重级""先复述"执行 | `review.json` 的 `criteria[].evidence` 是否像引用，`defects` 有没有 🔴/🟡/🟢 |
| 返工空转判定 | 真实 reviewer 两轮给同一批 fail 很常见，"worker 没动"与"判据本身写死"在信号上无法区分 | `blocked ... stalled` 出现在哪类任务上 |
| 快速车道 | 没有 criteria 的快速任务会不会大量停在 `awaiting-human`（等于白跑） | `awaiting-human` 里快速任务的比例 |

顺带一个容易误判的点：`tsc` 读不到源码 ≠ 源码有问题。同一棵树里 `node` 能读到明文、测试 300 条全绿，说明差别在"哪个进程被放行"，不在文件本身。任何工具报"文件损坏/非 UTF-8"时，先确认它是否在 TSD 白名单里，再决定要不要动文件。

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
| README 的复核章节与提示词同步 | 0.1 天 | README 的「复核流水线」还是旧的几条规则，没写 2026-11-17 加的压力测试立场、证据强制、严重级前缀、复述要求。不算错（没写≠写错），但读 README 的人会以为复核还是老样子 |

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

**验收的自生成产物（`artifactIgnore` / `TASKCTL_ACCEPTANCE_MODE`）**
- glob 方言是手写的最小集：`*`（不跨目录）、`**`（跨目录）、`?`（单字符）；没有 `[abc]` 字符类、没有 `!` 取反、大小写敏感、只认相对 workdir 的模式（绝对路径写进来会静默不命中任何东西）。引入新依赖前不打算扩
- digest 格式从 v1 升到 v2：目录行移到子项之后、纯忽略目录整体不注册（连带**空目录**也不再注册——建空目录不再算 drift；与 git 一样看不见空目录）。v1/v2 摘要不可比，但摘要只在单次验收内前后比，无存量影响
- taskctl 不验证命令在 check 模式下真的没写文件：写了又不在 `artifactIgnore` 里，按 drift 拦下（fail closed）。check 合规是命令作者的责任，文档只给了推荐写法
- 复核的改动清单只有 `git status --porcelain` + `git diff --stat`，各截断至 200 行；非 git 工作目录显式「不可用」。二进制产物的变更只有状态行没有内容视图；review.json 的 `evidence` 记的是注入原文（复盘用），不是全集

**产物卫生（`TASKCTL_LOG_DIR` / `--log` / 回合后清扫，2026-11-17）**
- 清扫只看**根目录、非递归、常规文件**：子目录里的杂物（哪怕同名命中 patterns）不扫；目录本身永不移动。要深扫先攒真实痛点再扩
- 未跟踪判定靠 `git status --porcelain -z --ignored=traditional`（`??`/`!!` 都算）。**非 git 工作目录整体惰化**（journal 记一次 `artifact-sweep-skipped`，之后静默）——宁可不清也不猜
- 缺省 patterns 含 `*.txt`：交付物本身就是根目录 `.txt`/`.log` 的任务必须写 `keep_at_root` 或收紧 patterns，否则交付物会被挪进 scratch（journal 有落点，可找回，但验收会先失败一轮）
- `keepAtRoot` **不进 `definitionDigest`**：worker 理论上可以改自己的豁免列表来保住杂物——被挪走的只是杂物本身（scratch 可找回），不改变"做完"的判据，所以没按定义漂移处理
- 清扫在 worker 回合后、验收前发生；落点 `tasks/<id>/scratch/` 在 digest 的排除路径内，不影响 drift 判定。复核的 `git status` 里 scratch 路径若未被仓库忽略会显示为新增未跟踪文件（本仓 `/tasks/*` 已忽略，无此问题）
- `taskctl gc`（清旧 run 日志、scratch、过期 reservation/lock）**有意未做**，另立任务

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

## 7. EGM 落地之后：明确不做与遗留（2026-11-17）

调研与取舍的完整推理在 [review mechanisms 调研](research/2026-11-17-egm-review-mechanisms.md)。这里只留结论，避免两处口径不一致。

| 项 | 结论 | 触发条件 |
| --- | --- | --- |
| 结构化 severity（枚举 + 迁移历史 `review.json`） | **不做**。提示词软约束够用，准入仍是 pass/fail/unclear 三元；nit 误判由下一轮或人工放行兜底 | 出现"只有挑剔项却 fail、白花一轮"的实际案例 |
| 独立 `restated` 字段喂归因 | **不做**。判据是给定的（`acceptance` 命令 / `criteria`），不是让 reviewer 理解一份文档；`summary` 里先复述已拿到大部分收益 | `reject` 的 clarify 归因真正开始被使用时 |
| EGM 的"连续两轮 clean 才收敛" | **不做**，语义错配：taskctl 每轮审的是不同的产物状态，不是同一文档多次抽样 | 永久不做 |
| P3 透镜层（`verify:human` + `risk:high` 多 lens + 去重合成） | **暂不做**。要先有 disable-model-invocation 闸门，也要有真实返工数据支撑"何时值得多 lens" | 上面两个前提都成立 |
| 更细的收敛判决（churn、逼近速度、新问题落在刚修好的 scope） | **等数据**。现在只有"空转/逼近"二元 | 攒到足够的真实返工记录（`review_rounds > 0` 的任务样本） |

同一原则在 §0 的分类器上已经用过一次：先跑数据、再设计，不靠猜。
