# 进展报告 — 2026-11-28 凌晨

> 写给零上下文的下一次会话，也写给所有者本人。当前代码状态、五份计划各自的结果、最近一轮的修法，以及**还没做完的事**（分成「等你定」和「缓期小项」两组）。恢复入口在第 6 节。

## 1. 仓库状态

- `main` = `origin/main` = **`b9885fd`**，工作区干净。
- 本地只剩 `main` 一个分支：9 个已合并分支已逐个用 `git branch -d` 删除（每个删除前都确认过 `unique=0`）。
- 远端仍有三个分支：`origin/main`、`origin/feat/findings`、`origin/feat/learning-loop`（**没有动**，删不删等你定）。

## 2. 五份计划

| # | 计划（`docs/superpowers/plans/`） | 任务 | 状态 | 合并提交 |
|---|---|---|---|---|
| 1 | `2026-11-25-model-refusals-and-stuck-list.md` | 17 | 完成，含两次真实后端检查 | `04d8a0e` |
| 2 | `2026-11-25-stop-now.md` | 12 | 完成，含真实后端检查 | `ab5e81d` |
| 3 | `2026-11-25-rework-feedback-file.md` | 9 | 完成；任务 9 实跑两次（第二跑复核通过、任务 `done`） | `bcdf337` |
| 4 | `2026-11-25-lane-declared-by-operator.md` | 5 | 完成（一次修正轮） | `9c03397` |
| 5 | `2026-11-27-cancel-confirmation-on-a-busy-machine.md` | 3 | 完成（先诊断、再按裁定 A 实现） | `e637b29` |

每个计划的运行记录在 `.superpowers/sdd/<计划名>/progress.md`（不入库）；计划文件里有逐任务数字、Evidence 和「Found while carrying out」。

| 计划 | 变异 | 收尾时 `main` 的全量 |
|---|---|---|
| 3 | 七张表 47 行，顶端全杀 | 1148 passed / 1 skipped |
| 4 | 35 行，顶端全杀 | 1174 passed / **13 failed** / 1 skipped（那 13 条是环境问题，见第 3 节） |
| 5 | 5 行，顶端全杀 | **1189 passed / 0 failed / 1 skipped** |

## 3. 最近一轮：忙机器上的取消确认（第五份计划）

**真因**（推翻了先前的判断）：这台机器上 `taskkill` 启动只要 70 ms，但它**自己枚举进程表要 ~1.7 秒**；代码给它的计时器是 1 500 ms，于是每次取消都在效用器完成前把它杀掉，根进程从未被杀。进程表列表本身要 3.2–3.5 秒，而期限是 3 000 ms。先前「第一条失败留下幸存进程、后续跟着失败」的级联判断，来自一台还残留 57 个夹具进程的机器。

**改动**（`6e4fde1`）：

| 常量 | 原 | 现 |
|---|---|---|
| `TREE_LIST_DEADLINE_MS` | 3 000 | 4 500 |
| `TREE_KILL_DEADLINE_MS`（新） | 藏在 `stopTree` 里的 1 500 | 3 500 |
| `CANCEL_BUDGET_MS` | 7 500 | 9 500 |
| `CANCEL_DEADLINE_MS`（`src/worker.ts`） | 8 000 | 10 000 |

`stopTree` 的期限改为参数，并加了导出的 `KillRunner` 接缝（`spawnTaskkill` 为默认实现），期限语义可以用假计时器测、不依赖机器快慢。没有把 kill 夹在剩余预算里——实测那样只剩 2.0 秒给一个要 1.7–2.0 秒的效用器；改为抬高预算，不变式测试写的是真实的和（4 500 + 3 500 + 3 × 500 = 9 500 ≤ 9 500 < 10 000）。

**门槛**：五个取消文件 99/99、零残留夹具；全量 1189 / 0 / 1（两遍同结果），收尾 0 个残留进程；类型门、`diff --check`、三个离线脚本全 0；推送前扫描 22 条规则 0 处、硬自检 PASS。

**代价**：本机典型一次停止 ~5.2 秒（列表 3.2 + `taskkill` 1.9）；一台真正无响应的机器上，最多等 10 秒才报「未确认」（原 8 秒）。

## 4. 本地分支清理（2026-11-28 凌晨）

删除的 9 个（都确认 `main..<分支>` 无独有提交）：

`feat/acceptance-artifact-ignore`、`feat/artifact-hygiene`、`feat/findings`、`feat/lane-declared-by-operator`、`feat/model-refusals`、`feat/rework-feedback`、`feat/stop-now`、`findings-sync`、`fix/cancel-confirmation`。

被删分支上的提交全部仍可从 `main` 到达（`git log 6e4fde1`、`git log e637b29` 均可查）。**远端分支没有动**。

## 5. 没做完的事

> **2026-11-28 下午已关掉 7 条**（合并提交 `629f801`），见 5.4；下面的清单里已把它们划掉或改写。只动了注释、文档与测试覆盖，没有改任何行为。

### 5.1 已定（2026-11-28 晚，所有者逐条裁定）

1. **阻塞之后的重试要被告知上次否决** —— 要。判决一出来就记在本次尝试上；尝试以 `blocked` 结算时（`settleRework`）把它写盘，`taskctl retry` 的首回合因此看到的是**最后那一次**否决：复核轮次用尽与复核停滞、渲染与验收耗尽重试预算，都算。
2. **停止落在「判决之后、下一回合写文件之前」** —— 判决时先写：`stopAttempt` 结算时把本次尝试已判、还没写的否决写盘；没判过的（被取消的回合、被打断的门）照旧不写。沿用前一个 attempt 的 `carried` 说明不重写，保留它自己的时间。
3. **远端两个分支** —— 删。`origin/feat/findings`、`origin/feat/learning-loop` 相对 `origin/main` 各 0 个独有提交，已删。
4. **10 秒的取消期限** —— 接受 A，不改代码；代价与依据见第 3 节。

实现、变异与门槛数字：`.superpowers/sdd/2026-11-28-verdict-on-disk/progress.md`。

### 5.2 缓期的小项（都没有动）

**第二份计划（7 条）**

- `tests/execution.test.ts` 的 7000 毫秒断言：简报自己定下的数字。
- 只在失败时留下临时目录的 stop-worker 与 watch 测试：绿跑不留，失败时留。
- `scripts/live-phase2.ps1` 里不可达的 `exit 2`：**看起来是死代码，其实不是**——脚本开头把 `Write-Error` 设成终止错误后，删掉这行会让退出码从 2 变成 1，属行为改动，因此保留。
- `ControllerStop.report` 只有两个标签，恢复的报告因此打在 `[scheduler]` 下：仅是面貌问题。**已关（2026-11-28 晚）**：标签加了 `recovery`，`retry --review-only` 的两处报告改用它；测试钉住 `[recovery] …` 且恢复的命令不出现 `[scheduler]`。
- 三秒的夹具等待靠同族测试的先例和正常的绿跑，不靠探针本身。
- 无法删除的探针会话：opencode 2.4.2 没有 `session.delete`，它留在所有者的存储里。
- `scripts/live-stop.ps1` 每跑一次会在临时目录留下它自己建的替身项目（约 2 KB）。

**第三份计划（2 条，均已关）**

- `carried` 遇到没有 `## ` 行的文档只保留最后一行（只可能出现在手改的文件上）——已改为整篇保留（合并 `cd6287f`）。
- 没有测试覆盖连续两次渲染失败——已补（合并 `c16d078` 里的 `3561b90`）。

**第四份计划（7 条）**

- 全在计划末尾「Found while carrying out」：quick 车道的 `criteria: 0` 说明（已关）、跳过测试的名字没提未知 type（已关）、`分类升级` 只冻结分子（已关）、`isLane` 在 `lanes.ts` 重复一份、`mustFail` 工件是字符串、两条测试覆盖缺口（已关）等。

**第五份计划**：没有代码遗留；唯一代价见 5.1 第 4 条。

### 5.3 验证与运维遗留

- ~~`scripts/smoke.ps1 -Live` 不指定模型，后端默认模型不可用的那天就失败~~ —— **已关（2026-11-28 晚）**：加了 `-Model`（不给仍是后端默认，`taskctl.json` 与从前逐字形相同）；给了就把 `model` 与 `allowedModels` 一起写进去，并先打印预算护栏的判定（只读目录，不花额度，不拦路）。当晚用 `-Model zhipuai-coding-plan/glm-5.3-flash` 真跑一次通过（`done`，worker + reviewer 都是它）。
- `scripts/live-phase2.ps1 -Live` 还没有在 opencode 2.4.2 上重跑。
- ~~`errorWords` 遇到按语言分开的 `data.message` 只取第一种语言~~ —— **已关（2026-11-28 晚）**：现在按后端自己的顺序引用它给出的**每一种**语言，用 ` | ` 连接；只有一种语言时输出与从前逐字节相同，空的语言连同分隔符一起丢掉。

### 5.4 2026-11-28 下午关掉的（合并提交 `629f801`）

只改注释、文档与测试覆盖，不改行为；全量 1189 passed / 0 failed、零残留进程、三个离线脚本 0。

| 来源 | 条目 | 改法 |
|---|---|---|
| 第四份 #10 | ADR-0010 的 `criteria: 0` 说明漏了 quick 车道与空澄清 | 现在写明 quick 车道（不跑澄清、没有标准）、失败或空的澄清、抽取失败 |
| 第四份 #9 | README 的 `分类升级` 行说「新记录不再计入」 | 改为只冻结分子，分母仍计每一份 `classification.json`，新看板显示 `0 / N` |
| 第四份 #1 | 用法错误里引述的答复没有断言 | `lane-declared.test.ts` 断言 `("…" is not a lane)` |
| 第四份 #3 | 没有测试断言 quick 车道不写 `classification.json` | `lanes.test.ts` 加断言 |
| 第四份 #11 | 跳过测试的名字没提未知 type | 改名为「不解析、没有车道、或 type 未知的行走跳过」 |
| 第三份 | `acceptanceOutputLines` 的注释仍说「空输出」 | 改为「空或只有空白」 |
| 第二份 | `providerFailedFollows` 的注释描述已不存在的写日志形状 | 说明「判决 + provider-failed 成对」是旧 journal 的形状 |

## 6. 恢复入口

1. `docs/superpowers/plans/2026-11-24-handoff.md` — 项目总交接页（第 0 节起读；顶部有到本报告这次合并为止的更新行）。
2. `.superpowers/sdd/2026-11-28-verdict-on-disk/progress.md` — 第 5.1 节四条裁定的实现账本（阻塞/停止时落盘否决的说明，变异 6/6，门槛与推送）。
3. `.superpowers/sdd/2026-11-27-cancel-confirmation-on-a-busy-machine/progress.md` — 第五份计划的完整账本（诊断、裁定、变异、合并与推送）。
4. `.superpowers/sdd/2026-11-25-lane-declared-by-operator/progress.md` — 第四份计划的账本（含 12 条缓期小项的上下文）。
5. `.superpowers/sdd/2026-11-25-rework-feedback-file/progress.md` — 第三份计划的账本（含两个设计问题）。
6. 四、五两份计划文件末尾分别有「Found while carrying out」与「Task 1 findings」，是当时的一手数字。
