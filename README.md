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
| `model` | string | — | 兜底模型（`provider/model`）；任务 frontmatter 的 `model` 优先。未设置时，`taskctl add` 的澄清会话与 `taskctl split` 的规划器改用 `modelChain` 的链首，而不是后端默认模型；两者都由预算护栏先判定 |
| `effort` | string | — | 兜底努力档（如 `high`）；任务 frontmatter 的 `effort` 优先 |
| `contextThreshold` | number | `0.8` | 上下文用量比例达到该值即触发收尾交接 |
| `retryLimit` | number | `3` | 失败尝试（失败回合 / 收尾失败 / 验收失败）上限，达到即 `blocked` |
| `lockTtlMs` | number | `600000` | 所有权过期窗口；过期不等于旧执行已停止 |
| `heartbeatMs` | number | `60000` | 全程续期间隔，实际不大于 TTL 的三分之一 |
| `turnTimeoutMs` | number | `1800000` | 单个 agent 回合的超时 |
| `acceptanceTimeoutMs` | number | `600000` | 单次验收命令的超时 |
| `maxSessionsPerTask` | number | `20` | 一个任务全会话链的长度上限（含交接与重试） |
| `maxTurnsPerSession` | number | `40` | 单会话内工作回合数上限 |
| `parallel` | number | `2` | 同时执行的任务数；同一工作目录仍只跑一个。`watch` 不读它，严格串行 |
| `batchMaxTasks` | number | `5` | watch 自动连续批次的任务数上限；`1` = 关闭自动成批，手动 `run --batch` 仍可用 |
| `maxReviewRounds` | number | `2` | 复核失败几轮后 `blocked` |
| `reviewerModel` | string | 同 worker 链 | 复核会话单独用的模型。**不设置复核链时，复核链就是 worker 链**（`modelChain` / `model`，含任务自己的 `model`）；复核的独立性来自新会话，不来自换模型 |
| `reviewerEffort` | string | 同 `effort` | 复核会话的努力档 |
| `modelFallbacks` | string[] | `[]` | 模型被 provider 拒绝时依次换用的模型（`provider/model`）。排在任务 `model`（或配置 `model`）之后；没有主模型时整条链为空 |
| `reviewerModelFallbacks` | string[] | `[]` | 复核会话的降级链，排在 `reviewerModel` 之后；没配 `reviewerModel` 时复核链为空，于是沿用 worker 链 |
| `modelChain` | string[] | 等价于 `[model]` | 整条派发链：第一个是主模型，其后是替代。设置了就替代 `model` 作为链首，`modelFallbacks` 仍追加在末尾。被 provider 拒绝时按这条链推进（见「模型拒绝与轮次」） |
| `chainCycles` | number | `0` | 模型链走到链尾后还能回绕到链首几次；`0` = 线性链，到链尾即视为耗尽。回绕是重探此前拒绝过的模型（它的配额窗口可能已经重置），退避照常；回绕只在一轮之内发生，整个循环都被拒绝即本轮结束（见「模型拒绝与轮次」）。每一轮（也就是每次 attempt）与每个复核轮重新计圈 |
| `modelCooldownMs` | number | `60000` | 某个模型被 provider 拒绝后，在整个看板内共享的跳过窗口。期间其他 Task 和后续 run 不再向它派发；到期重探，成功清除，显式 `chainCycles` 仍可在本任务内重探。它只是窗口，不会让任务 `blocked` |
| `modelRounds` | number | `4` | 一个任务在同一次执行里连续几轮被链上所有模型拒绝之后才做判断；必须是正整数。轮次与判断规则见「模型拒绝与轮次」 |
| `failureFingerprintLimit` | number | `3` | 验收连续给出**同一失败**（归一化后的指纹相同）几次后转 `blocked` 等人工，不再自动重试 |
| `opencodeBin` | string | `opencode` | opencode 可执行文件。**Windows 下 `.cmd` shim 无法被 `shell:false` 直接启动**，应在本地配置实际 `.exe`，不要提交机器专属路径 |
| `chromeBin` | string | 自动探测 | 渲染验收用的浏览器可执行文件；也可用环境变量 `TASKCTL_CHROME`。找不到时渲染任务 `blocked`，不会当成通过 |
| `renderViewports` | string[] | `["1440x900","390x844"]` | 渲染验收要过的视口列表 |
| `artifactIgnore` | string[] | `[]` | 验收前后摘要**忽略的路径或 glob**（相对 workdir；`*` 不跨目录、`**` 跨目录、`?` 单字符，不支持字符类与取反，大小写敏感）。命中的文件——以及只装着命中文件的目录——不参与 drift 判定；见下文「验收的自生成产物」 |
| `artifacts` | object | `{"sweep": true, "scratchPatterns": ["*.log","*.tmp","_*","*.sha","*.txt"]}` | **产物卫生**（见下文「产物卫生」）：`sweep` 关闭回合后清扫；`scratchPatterns` 是算作杂物的根目录文件名 glob（与 `artifactIgnore` 同一套 glob 方言）。子字段写错直接报配置错误 |
| `allowedProviders` | string[] | 不设置 | **预算护栏**的 provider 白名单（见「已知陷阱」）。设置了它，免费模型的 provider 必须在列表里；成本未知的模型要 provider 在这里、或模型在 `allowedModels` 里。不设置时免费模型一律放行 |
| `allowedModels` | string[] | 不设置 | 预算护栏里显式点名的模型（`provider/model`，不带 `#变体` 后缀）。点名之后按量计费和成本未知的模型也放行 |
| `allowPaidModels` | boolean | 不设置（即 `false`） | 为 `true` 时按量计费的模型一律放行 |
| `maxCostPerMillion` | number | 不设置 | 按量计费模型的单价上限（每百万 token 的输入加输出，美元），不超过它的放行；`0` 是一个有效设置 |
| `workerContext` | object | 两节都开 | worker 提示词的上下文开关：`{ "spec": true, "preferences": true }`，省略的子键按 `true`。`preferences` 同时管偏好档案和人工纠正，见「worker 拿到什么」 |
| `fixedSources` | string[] | 不设置（即关闭） | 用户本人的规范文件（文字怎么写、什么不许做），每个 attempt 开工时按配置顺序读进 worker 提示词：按文件原样读入，不检索；相对路径按当前目录解析，同 `tasksDir`，不展开 `~`。文件不存在不算配置错误，只让那次尝试不带这个文件；写成 `[]` 等同不设置。见「worker 拿到什么」 |
| `memory` | object | 关闭 | 从 MemPalace 召回相关记忆的设置，子键见下表。`backend` 不是 `mempalace` 时等于关闭 |

`memory` 的子键（都可以省略）：

| 子键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `backend` | string | `"none"` | 只有 `"mempalace"` 会召回；写别的值配置直接报错 |
| `command` | string[] | `["mempalace-mcp"]` | MemPalace 的 MCP 服务怎么启动，照抄 OpenCode 配置里那一整条命令，包括 `--palace <目录>` 这样的参数（默认值里没有它）。和 `opencodeBin` 一样，Windows 下要指向真实的可执行文件 |
| `wing` | string | 不设置 | 设置后额外做一次限定到这个 wing 的检索 |
| `excludeWings` | string[] | `[]` | 不放进来的 wing |
| `rooms` | string[] | `["pitfall","pattern","decision"]` | 只保留这些 room。**不能为空**：空了等于永远召回不到东西，配置直接报错 |
| `minSimilarity` | number | `0.55` | 相似度下限，0 到 1（含两端）；0 表示不按相似度过滤 |
| `maxItems` | number | `5` | 最多注入的条数 |
| `maxChars` | number | `2000` | 记忆节的字符上限 |
| `itemChars` | number | `400` | 单条的字符上限，超出截断并加 `…` |
| `timeoutMs` | number | `20000` | 一次召回从握手到检索完成的总超时 |

**推荐配置（只用编码套餐里的模型）**：`modelChain` 按你的顺序列出套餐里的模型，`allowedProviders` 点名套餐的 provider——目录把它们报成免费、或不报成本，都放行：

```json
{
  "modelChain": [
    "zhipuai-coding-plan/glm-5.4",
    "zhipuai-coding-plan/glm-5.3",
    "zhipuai-coding-plan/glm-5.3-highspeed",
    "zhipuai-coding-plan/glm-5.3-flash"
  ],
  "allowedProviders": ["zhipuai-coding-plan"]
}
```

这样配置之后，护栏只放行这个 provider 的免费和成本未知的模型：别的 provider 的免费模型、任何按量计费的模型（包括同名的按量孪生，如 `zhipuai/glm-5.3`）、以及别的 provider 里目录不报成本、又没被 `allowedModels` 点名的模型，一律拒绝——要用套餐之外的模型，把它写进 `modelChain`，再按它的成本放行：**免费**模型只认 provider——把它的 provider 加进 `allowedProviders`（`allowedModels` 对免费模型不起作用）；**按量计费**的模型用 `allowedModels` 点名，或开 `allowPaidModels`，或把 `maxCostPerMillion` 提到不低于它的单价（`allowedProviders` 放行不了按量模型）；目录不报成本的模型，`allowedModels` 或 `allowedProviders` 点到一个就行。跑之前先用 `taskctl models` 看一遍判定。

## 任务文件

`tasks/<id>.md` = YAML frontmatter + Markdown 正文（正文即任务描述，会原样进 agent 提示词）：

```markdown
---
schema: taskctl/v1
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
| `schema` | ✓ | 注册标记，固定为 `taskctl/v1`。只有声明了它的 Markdown 才会被当作任务（见下段） |
| `id` | ✓ | 任务标识；以文件名为准（`tasks/<id>.md` 的 stem），frontmatter 里的副本不作数 |
| `title` | ✓ | 标题；同时用作 opencode 会话标题 |
| `status` | ✓ | 生命周期：`draft`（等签字）/ `open`（待领取）/ `running`（执行中）/ `review`（复核中）/ `awaiting-human`（等放行）/ `done`（完成）/ `blocked`（需人工介入） |
| `model` | | 本任务模型（`provider/model`），覆盖配置兜底 |
| `effort` | | 本任务努力档（如 `high`），覆盖配置兜底 |
| `acceptance` | | 验收命令（完整 shell 命令行，在 `workdir` 下执行）；退出码 0 且所有权/任务定义/产物一致才进入复核。缺失但有 `criteria` 时跳过命令、由复核判定（记录 `acceptance-skipped`）；两者都缺 → `blocked`（`quick` 任务转 `awaiting-human`） |
| `criteria` | | 验收标准列表，`C1 …` 编号；复核逐条判定，这是复核的唯一判据 |
| `complexity` | | `simple`（不停下等签字）或 `complex`（默认，出稿等签字）。只决定入口审批，不决定执行策略 |
| `execution` | | `continuous` 或 `iterative`；缺省时 simple → continuous、complex → iterative。continuous 先用一个 worker 回合完成，失败/变复杂才升级；iterative 在同一工作上下文中进行有界验收与复核返工 |
| `worker_self_check` | | worker 可选的有界自验/生成命令，只能经 `taskctl check` 执行；与控制器负责的 `acceptance` 分离 |
| `worker_self_check_timeout_ms` | | `worker_self_check` 的超时；未声明时取 min(20 分钟, 回合上限)。声明值不得超过回合上限——以领取时写进 `attempt.json` 的 `turnTimeoutMs` 为准；超限的声明值在解析和领取时都会被接受，直到 worker 调用 `taskctl check` 才被拒绝 |
| `risk` | | `high` 时复核通过也要人工 `accept` |
| `workdir` | | 本任务的工作目录（相对配置里的 `workdir`）；同一目录同时只跑一个任务 |
| `keep_at_root` | | 根目录文件名 glob 列表，命中者**豁免回合后清扫**（如 `run.log`）。不进 `definitionDigest`：它决定杂物停哪儿，不决定"做完"是什么 |
| `depends_on` | | 依赖的任务 id；全部 `done` 才会被领取，成环直接报错 |
| `parent_id` | | 由 `taskctl split` 生成的子任务才有。祖先里只要还有一个 `draft`，这个子任务就不会被领取——整个拆分包靠这一次签字放行。属于定义字段，进 `definitionDigest`；只支持一层，不能嵌套 |
| `human_check` | | `true` 时无论风险都要人工放行 |
| `tolerate` | | 声明**容忍的外部变更种类**：`external_cell_change`、`new_column`、`deleted_row`、`extra_file`。只写这几个值，写错直接报错（打错字不该变成"声明了但什么都没容忍"）。见下节 |
| `quick` | | `true` 表示**没出 spec、没跑澄清会话**，意图原文就是定义。`taskctl add --quick` 写入；有客观 `mechanical/render` 证据时可以收尾，若需要 human review 却没有 criteria，则转人工判断（见「车道与验收方式」） |
| `verify` | | 谁来判"做完了"：`human`（默认，独立复核判）、`mechanical`（验收命令退出码判）、`render`（无头浏览器判）。进 `definitionDigest`，中途改会作废本次尝试 |
| `render_targets` | | `verify: render` 时要打开的页面，相对 `workdir`；`verify: render` 却没有这一项会直接报错 |
| `review_rounds` | ✓ | 复核失败次数，由 worker 维护 |
| `sessions` | ✓ | 会话 id 链（按时间顺序追加），由 worker 维护 |
| `retries` | ✓ | 失败尝试计数，由 worker 维护 |

`schema: taskctl/v1` 是显式注册：`tasks/` 目录里可以放别的 Markdown（手抄的快照、草稿、导出的旧任务），只有声明了这一行的文件才会被调度。缺这行或 frontmatter 解析不了的文件不领取、不排期，`taskctl status` 会在看板后面单独列出 `ignored` 及原因；已注册但内容坏掉的任务仍然照常报错，不会被静默忽略。`taskctl add` 生成的文件自带这一行。

辅助文件：`tasks/<id>/lock.json`（所有权与心跳）、`attempt.json`（执行事实与不确定状态）、`definition.json`（领取时写下的定义快照，本次尝试的判据）、`acceptance.json`（命令、验收模式、时间、输出、身份摘要与实际使用的模型）、`acceptance-failures.json`（连续同一验收失败的指纹与次数）、`review.json`（复核判决、模型、被容忍的外部变更与实际注入的改动证据）、`render.json`（渲染验收的逐视口测量与截图路径）、`evidence/`（截图）、`models.json`（模型降级链的当前位置）、`model-wait.json`（模型窗口的推迟记录：轮次、本次执行里第一次被拒的时间、每个模型的拒绝原话、下次可领取时间）、`execution-state.json`（持久升级与最近 worker session）、`review-pending.json`（只待复核的保留现场）、`classification.json`（接入分类：实际/建议车道、是否兜底升级、信息充分性、理由）、`questions.md`（待回答的问题；存在期间不能 approve）、`split-plan.json`（拆分计划：子任务、继承字段与整合步骤）、`split-applied.json`（父任务已连接到哪份计划）、`split-plan.rejected.txt`（被拒绝的规划器原话）、`usage.jsonl`（每回合资源快照与增量）、`recall.json`（记忆召回的审计记录：查询串、命中的抽屉 id 与相似度，不复制全文）、`done.requested`（完成请求）、`logs/`（控制器逐任务日志与 worker 的 `$TASKCTL_LOG_DIR`）、`scratch/`（回合后清扫的落点，只进不出）、`sessions/0001-handoff.md`（交接笔记）、`rework.md`（返工说明：上一回合为什么被打回、要改什么；任务通过后删除，2026-11-27）。运行时记录不拥有任务状态，Markdown 仍是唯一状态源。

## 车道与验收方式

两个问题分开答：**进来的时候要不要澄清**（车道），和**出去的时候谁说了算**（`verify`）。

| 车道 | 怎么进 | 起点 | 代价 |
| --- | --- | --- | --- |
| 标准 | `add "<意图>"` | `draft`，澄清会话出 spec + criteria，等人签字 | 一次模型调用 + 一次签字 |
| 简单 | `add --simple`（意图里说「简单任务」只是模型未给分类时的缺省，不保证） | `open`，仍出 spec | 符号少一次签字 |
| 快速 | `add --quick` | `open`，**不出 spec、不跑澄清**，意图原文就是定义 | 没有写下来的判据，所以它不会自己收尾 |

### 接入分类：这件事该管多细，信息够不够

走标准道的 `taskctl add` 在**同一个澄清回合**里顺带回答两个问题，不另外花一次模型调用（`--quick` 仍然零模型调用）：

- **管理分类** `quick` / `simple` / `complex`，只决定管理强度：quick 是极轻量单步；simple 是一次 Worker 后最终 Review；complex 需要拆子任务和/或 Worker→Review→Worker 迭代。它**不能**降低 `risk`、去掉 `human_check`、放宽 `criteria` 或把人工复核改成机械验证——那些只能由你在已批准的任务定义里显式声明。
- **信息充分性** `clear` / `assumptions` / `needs-information`：只有当缺的信息会改变交付物、验收、禁区或风险时才允许 `needs-information`，并且最多一次问 3 条。能从仓库推出来的事不问。

结果写在 `tasks/<id>/classification.json`：实际车道、模型建议、是否由 taskctl 兜底升级、信息充分性、理由、模型。

保守兜底：模型没给、给错或自相矛盾时，一律按 `complex` 处理并停在 `draft`，绝不会默认变成 quick；这种兜底记为 `laneEscalated: true`，`metrics` 单独统计。`--simple` / `--quick` / `--execution` 是你的显式选择，优先于模型分类。

`needs-information` 的任务停在 `draft`，并写一份 `tasks/<id>/questions.md`（`add` 会打印它的路径，`status` / `board` 显示「待回答问题 N 条」）。**这份文件存在期间 `approve` 会被拒绝**——把没人知道的事签成"已批准"正是要避免的：

```bash
taskctl answer --task <id> --file <answers.md>   # 把回答追加进定义，清掉 questions.md
taskctl approve --task <id>                      # 修订后的定义要重新签字
```

回答原文同时追加到 `spec.md`（复核读的）和任务正文（worker 读的）。只写前者的话，执行者会被一条它从没见过的约束判定。两处都是定义文本，所以修订后的任务有新的 `definitionDigest`。

三条道都必须能被人或机器判"做完了"，判据由 `verify` 指定：

- `human`（默认）：独立复核会话逐条判 `criteria`。适合结论要读、要解释的工作。
- `mechanical`：`acceptance` 命令的退出码就是判决，通过即 `done`，不再起复核会话。适合"测试全绿/构建通过"这类工作。
- `render`：`taskctl verify`（worker 在收尾时也会自己跑）用无头浏览器打开 `render_targets` 里的每个页面，逐个视口要求：**能画出来、有可读内容、不横向溢出、没有未捕获异常**。截图留在 `tasks/<id>/evidence/`。适合"产物是给人看的"工作——复核读的是代码和 diff，看不见白屏和溢出。

`verify: render` 找不到浏览器时任务 `blocked`，并写明原因：**没跑成的检查不算通过**。

**升级只会往上走。** 一个快速/简单任务在执行中可能被证明"不是那么简单"，两条触发线都是运行期事实，不靠事前猜：

- 执行者在自己回合里写下 `ESCALATE: <理由>`；
- 会话回合用尽或上下文告满需要交接（说明这事一次没干完）。

触发后本次尝试**照样可以继续**，但不再能用自己产出的证据收尾——一律进复核。任务文件里的 `verify` 不改，`definitionDigest` 不变，所以升级本身不会让正在跑的尝试作废；理由记进 journal（`event: escalated`）；`report` 的日志尾部会显示它，`board` 不显示。这个方向是刻意的：执行者能要求"多看一道"，不能要求"少看一道"。升级事实也会写入 `execution-state.json`，后续 attempt 不会悄悄降回机械直通。

`execution` 与 `complexity`、`verify` 分工如下：

- **continuous**：先给一个完整 worker 回合（其中可有很多工具调用）。未请求完成、验收失败、Review fail、显式 `ESCALATE:` 或需要交接时才升级为 iterative；不会先空转到默认 40 回合。
- **iterative**：验收失败会把退出码、输出尾部和失败指纹写进交接笔记；同模型时续用当前 worker session 返工，provider 切换仍强制新 session。普通 Review fail 在同一 claim 内继续，不再先回 `open` 等调度器重新认领。每次返工前，控制器把「为什么被打回、要改什么」写成 `tasks/<id>/rework.md`，提示词只用一行指向这个文件，不把内容塞进提示词；换模型或上下文交接之后新开的 session 同样被指向它（2026-11-27）。
- **Reviewer 不可用**：reviewer 被 provider 拒绝不增加 worker retry，也不重放已成功的 worker/验收。任务带着保留的现场回到 `open`（`review-pending.json` 与推迟记录），窗口一到控制器自己只跑复核；连续 `modelRounds` 轮被拒后由控制器按证据规则决定（见「模型拒绝与轮次」）。reviewer **超时**则照旧以 `blocked + review-pending.json` 保留现场：换到健康 Reviewer 后执行 `taskctl retry --task <id> --review-only`，定义和产物摘要一致才只跑 Review。reviewer **崩溃**不是拒绝，判不出来转 `awaiting-human`。没有单独配复核链时复核沿用 worker 链。恢复时评审员看到的时间窗是**产出这些证据的那次尝试**的时间窗（第一次保留现场时记进 `review-pending.json`），不是恢复这次尝试的。
- **没有 criteria**：即使需要 Review，也不会让 reviewer 凭空判断；quick 等无判据任务仍转 `awaiting-human`。

## 复核流水线

一条任务从想法到可信结果的完整路径（设计见 [ADR-0008](docs/adr/0008-review-stage-and-human-attribution.md)）：

```
taskctl add "<意图>"        澄清会话出 spec + criteria，并给出管理分类；complex 停在 draft 等签字
taskctl spec --task <id>    看稿
taskctl split --task <id> [--apply]   把 draft 的复杂任务拆成子任务并整合；加 --apply 才发布
taskctl answer --task <id> --file <answers.md>   回答 questions.md（needs-information 时）
taskctl models --config taskctl.json   开跑之前看预算护栏的判定，有模型被拒就退出码 1
taskctl approve --task <id> 签字 → open
taskctl run                 并发执行 → 验收命令 → 独立复核 → done / 返工 / 等放行
taskctl run --batch C,B,A   严格按给定顺序跑连续批次；每项仍独立领取、验收、留证
taskctl watch --config taskctl.json [--resume]   常驻看板；新任务自动调度，合格任务自动成批；逐任务事件与 run 一样落 tasks/<id>/logs/run-*.log
taskctl stop --tasks-dir tasks   请求优雅收尾；当前 attempt 结算后退出，不强杀 worker
taskctl stop --tasks-dir tasks --now   # 另一个终端：立即中断——取消回合的进程树和正在跑的验收命令；任务回到 open，重新 run 即可
taskctl board               总台账（同时重写 .taskctl/board.md，可用浏览器打开）
taskctl report --task <id>  单任务证据页
taskctl accept [--note "…"] 人工放行，可附一条给下次的备注
taskctl reject --stage …    人工打回，要说明是哪个环节的问题（clarify → 退回 draft）
taskctl audit --verdict …   抽查已完成的
taskctl metrics             哪个环节在拖后腿、工作被谁退回来
taskctl recall --task <id>   预览这个任务会注入的相关记忆；配了 fixedSources 时先打印固定来源，有文件读不到就退出码 1；--query "<查询串>" 检索手写的查询串，只读不写
taskctl learn --note "…"    记一条偏好（原话 → 改法），下次澄清会读到
taskctl template --type …   看某类任务的必答/可推/补问模板
```

要点：

- **复杂度**：`--simple` 会跳过签字；意图里明说「简单任务」只在模型没有给出分类时作为缺省，模型判为 `complex` 就仍是 `draft`。其余由接入分类决定（见「接入分类」）。模型没说清、说错或没提，一律按复杂处理。简单任务同样出 spec，只是不等签字。
- **复核是独立会话**：新会话、不给执行者的对话，只给 spec、验收命令与结果、产物摘要、交接笔记、日志尾部、工作区改动清单（`git status --porcelain` 与 `git diff --stat`，各截断至 200 行、超长标注），以及本次执行的时间窗口。输出必须是 JSON；解析不了按 `unclear` 转人工，不会当成失败去重跑。实际注入的改动清单原文记在 `review.json` 的 `evidence` 字段，复盘复核误判时可以核对 reviewer 当时到底看到了什么；非 git 工作目录会显式标注「不可用」而不是中断复核。
- **容忍的外部变更**：任务可以声明 `tolerate`，告诉复核"这些差异不是我干的"。声明之外的结构变化（删列、改表头含义等）仍按原规则判 fail；本任务自己该写的内容没写全，**不能**拿外部变更当挡箭牌；涉及交付内容（该写的行、该改对的单元格）时判不出先后的，也按本任务的问题处理。被容忍的差异不做静默处理：写进 `review.json` 的 `externalChanges`、journal 记一条 `verdict external=N`、`report` 里逐条列出，`taskctl accept` 放行前也会打印一遍（人工闸门是最后一道）。为什么需要它：真跑过的表格任务里，运行期间别人加了 1 列、删了 1 行、改了 4 个单元格，复核按"零附带改动"判 fail，白跑 20 分钟一轮。
- **定义不能被被审对象自己改**：`tolerate`、`criteria`、`risk`、`verify`、`complexity` 等都属于任务定义，进 `definitionDigest`。执行回合里改了它（哪怕是 worker 自己 shell 出去改 frontmatter），本次验收直接作废、任务 `blocked` 等人工重新确认——否则"给自己放宽判定标准"就成了合法动作。判据是领取时写下的 `tasks/<id>/definition.json` 快照，事后改文件不会把旧证据重新判成合格。生命周期字段（`retries`、`sessions`、`status`）不在定义里：降重试数、记会话 id 不会作废正在进行的尝试。复核判决里记录的是**当时那份声明**，事后把 `tolerate` 收窄不会让旧判决看起来像是被允许过更多。
- **返工**：复核不过会写一条 `review-failed` 笔记和 `rework.md`，并在同一 claim 内回到 worker；同模型续用 session。超过允许的返工轮次后 `blocked`。人工 `reject` 才代表另一次调度尝试，重新打开为 `open`——除非归因是 `clarify`，见下。
- **返工说明（`rework.md`，2026-11-27）**：每次返工前控制器重写 `tasks/<id>/rework.md`，提示词在 `## 工作规则` 下固定多出一条：「- 上一回合没有通过。开始之前先读 `<路径>`：里面写了原因，以及必须改什么。」不是返工回合时没有这一行，连空行都不留。内容只来自控制器已经掌握的事实：验收命令的退出码与输出结尾（最多 4000 字符，截断时写明完整输出在 `acceptance.json`）；复核未通过的标准、复核者的依据与缺陷；渲染验收失败的页面、视口与截图位置；连续执行的任务第一个回合没有请求完成、会话回合预算用尽、或 worker 自己写了 `ESCALATE:`（附它的原因）。迭代任务的普通进度回合不写它，回合崩溃、被 provider 拒绝或超时也不写——那些不是被打回。任务通过（`done` 或 `awaiting-human`）时文件删除；`blocked` 之后 `taskctl retry` 重开时它仍在，新 attempt 的第一个回合照样被指向它。模型全部被拒而推迟时（`tasks/<id>/model-wait.json`）文件同样留着，窗口过后新 attempt 的第一个回合照样被指向它。被 `taskctl stop --now` 打断时也一样。
- **人工节点**：`risk: high`、`human_check: true`、以及复核无法判定的任务停在 `awaiting-human`，只有 `accept` 能放行。
- **归因**：`reject`/`audit` 都会记录问题出在 `clarify`（标准本身错）、`worker`（没做到）、还是 `reviewer`（漏判），`metrics` 按环节汇总。归到 `clarify` 的 `reject` 会把任务退回 `draft` 而不是 `open`：规格本身错了，再跑一遍 worker 只是在执行一份已被否定的定义。原因作为待答问题写进 `questions.md`，`taskctl answer` 之后重新 `approve` 才会再次执行；worker/reviewer 归因保持原有返工行为。

### 偏好档案

`.taskctl/profile.md` 是一份可读、可手改的 Markdown，前面是说明，`## 观察` 下每条一行：

```
- 2026-11-16  不要问我能从仓库推出来的事
- 2026-11-16  交付物先给结论再给证据
```

`taskctl learn --note "原话 → 改法"` 追加一条；`taskctl add` 会把它整段注入澄清提示词，worker 开工时也会拿到它（最多 2,000 字符，见「worker 拿到什么」）。它不是模型训练，是「把规则写下来，下次先按它走」；写错了直接删那一行。

### 人工反馈历史

`.taskctl/feedback.jsonl` 逐条记录**人**写下的纠正：`reject` 的原因、`audit` 的备注、`accept --note` 的备注，以及 `answer` 对澄清问题的回答——每条带任务 id、标题、归因环节、任务类型和时间。它只由这几个命令写入：模型输出永远不会修改它或偏好档案；没有任何备注的通过（普通的 `accept`、不带 `--note` 的 `audit`）不产生条目——没有纠正内容的"通过"不该变成一条偏好。

下次 `taskctl add` 时，同任务类型的条目按与新意图的**字面关键词重合度**排序（并列时新的在前），取前 8 条、总计不超过 3000 字注入澄清提示词。历史里已有同类问题的回答或纠正时，模型被要求直接采用、不再重问；只有本次意图与之冲突才提出来。不做 embedding，不额外调用模型。worker 开工时也会拿到其中和执行有关的条目（`reject --stage worker`、归因 worker 的 `audit`、带备注的 `accept`），按同样的打分取最多 5 条、1,500 字符。文件最多保留最新 200 条，每条备注最多 600 字，都可以手工删改；读写失败只打一行提示，不影响澄清或人工决定本身。

### worker 拿到什么

worker 会话的提示词按固定顺序组装。标了「新」的五节都是可选的：输入缺省或为空时整节省略，连空行都不留，所以没有这些文件的任务，提示词和加这五节之前逐字节相同。工作规则里还有一行可选的（2026-11-27）：只在返工回合出现，指向 `tasks/<id>/rework.md`；不是返工回合时整行省略，同样连空行都不留。

| 顺序 | 节 | 来源 | 上限 |
| --- | --- | --- | --- |
| 1 | 任务（标题和正文） | 任务文件 | — |
| 2 | 已批准的规格（新） | `tasks/<id>/spec.md` | 8,000 字符；超出时保留前 70% 和后 30%，中段留可见的截断标记 |
| 3 | 工作规则 | 固定文案 | 8 条，不变；返工回合时在最前面多一行指向 `tasks/<id>/rework.md`（见「返工说明」） |
| 4 | 用户本人的规范（新） | `fixedSources` 列的文件，默认关闭 | 每个文件 8,000 字符；超出时保留前 70% 和后 30%，中段留可见的截断标记，并写明文件总长 |
| 5 | 用户偏好（新） | `.taskctl/profile.md` | 2,000 字符；超出时只保留最新的部分，并写明档案总长 |
| 6 | 同类任务上人工给过的纠正（新） | `.taskctl/feedback.jsonl` | 5 条、1,500 字符 |
| 7 | 相关记忆（新） | MemPalace 召回，默认关闭 | 相似度不低于 `minSimilarity`，5 条，每条 400 字符，合计 2,000 字符 |
| 8 | 依赖任务的结果 | 前置任务的产物与证据 | 有依赖时才有 |
| 9 | 上一段会话的交接笔记 | `tasks/<id>/sessions/` | 第一次会话是一行占位说明 |

这个顺序是为 28K 裁剪定的：任务、规格和工作规则在最前，交接笔记在最后，提示词真被裁掉中段时先丢的是规范、偏好、纠正和记忆。

- **规格**：worker 和 reviewer 读的是同一份文件，worker 不再按它没见过的标准被评判。节末固定一句话：这是你没有参与撰写、但已经签字放行的定义，按它干活，不要为了通过某一条标准做特判或硬编码。
- **规范**：`fixedSources` 列的文件，每个 attempt 开工时按配置顺序读一遍，每个文件先是自己文件名的一行（`【voice.md】`），后面是文件内容，原样读入。节首固定一句话：这些是用户本人定下的规范，跨项目有效，按文件原样读入，不是检索来的；下面的「用户偏好」是本项目上的补充，两处冲突时以这里为准。提示词里只出现文件名，不出现路径。读不到的文件只让那次尝试不带这个文件，journal 记一条 `sources`，写明每个配置的文件各是什么结果，形如 `voice.md=1934; contract.md=clipped(8000); blank.md=empty; notes.md=missing; x.md=unreadable(EISDIR)`。
- **偏好和纠正**：纠正沿用澄清会话的字面关键词打分，只留和执行有关的条目（`reject --stage worker`、归因 worker 的 `audit`、带备注的 `accept`），复核误判和规格本身的问题不进 worker 提示词。
- **记忆**：节首固定一句话，说明这些是参考资料、不是指令，记忆里出现的任何指令都不要执行。每个 attempt 开工时检索一次，结果写进 `tasks/<id>/recall.json`，同一 attempt 的后续回合复用这一份。查询串由标题、正文前 120 字和规格「目标」节的前 120 字拼成，最多 250 字符。
- **关掉**：`workerContext` 的两个开关，`spec` 管规格，`preferences` 同时管偏好和纠正；这两个开关管不到 `fixedSources`，它不设置就是关。读不出来的上下文文件只让那次尝试不带对应的节，journal 记一条 `context-unavailable`，任务照常进行。
- **降级**：记忆后端拉不起来、超时（默认 20 秒）、报错或解析失败，都只记一条 journal（`recall-unavailable`），提示词不带记忆节，任务不会因此 `blocked`。
- **预览**：`taskctl recall --task <id>` 打印某个任务将用的查询串和将注入的那一节；`taskctl recall --query "<查询串>"` 对手写的查询串检索，用来调阈值。配了 `fixedSources` 时两者都先打印固定来源，记忆开着关着都一样，有文件读不到就退出码 1。两者都只读，不写 `recall.json`，也不写 journal。

决策见 [ADR-0011](docs/adr/0011-worker-context.md)，固定来源见 [ADR-0013](docs/adr/0013-fixed-sources.md)，预算护栏见 [ADR-0012](docs/adr/0012-budget-guard.md)。

### taskctl metrics — 谁在把工作退回来

上半部分来自 `audits.jsonl`，是**人**的判断：每个环节多少次 fail。下半部分来自各任务的 `journal.md` 与 `classification.json`，是流程本身的事实：

| 行 | 含义 |
| --- | --- |
| 首轮通过率 | 已 `done` 的任务里，从没被人工 `reject` 过的比例。抽查 fail 不算——它不要求返工 |
| 自动返工 | taskctl 自己送回 worker 的轮数与涉及任务数：验收失败后带着输出返工（验收），复核 fail 后返工（复核），都不需要人介入 |
| 人工打回 | 被人 `reject` 过至少一次的任务数 |
| 接入信息 | 有分类记录的任务里 `needs-information`（及 `assumptions`）各多少 |
| 分类升级 | 模型没给出可用车道、由 taskctl 兜底到 `complex`，或实际车道比模型建议更保守的任务数 |
| 复核保留 / 只复核恢复 | reviewer 不可用而保留现场的次数，以及随后只跑复核恢复的次数 |

要看的趋势是**首轮通过率上升、人工打回减少**，而不是复核调用变少。两种返工必须分开：一个是工具按设计在自助（便宜、预期内），一个是人不得不介入（这正是要消除的重复；人给出判断的那些不算，见下文「人工触点」）。轮数由 journal 里记录"决定返工"的事件（`worker rework`、`review rework`）统计，不用会被 `retry` 重置的计数器，也不从相邻行推断；分母为 0 时显示 `-` 而不是 `0%`。

旧的 `返工率` 行已移除：它把复核过的任务数除以全部任务（含从未执行的），和这里的口径并排会给出两个互相矛盾的"返工"数字。

报表末尾还有两块，同样来自各任务的 journal：

- **人工触点**：每个任务被人动过几次、分别是哪一类（签字、回答、放行、打回、抽查、重试，以及应用了一份拆分计划），以及等人了多久。次数还按两种分开计：**审批型**是签字放行（`approved`、`accepted`、`retry`、`applied`），该往下压；**裁决型**是给出判断（`answered`、`rejected`、`audited`），判断从这里来，不压；两边都不算的记为未归类。每个任务一行 `共 N 次  审批 S  裁决 A`，有未归类时多一段 `未归类 n`；至少一个任务被动过时，最后还有一行合计。等人时长是每次人把停住的任务重新推动时，这条事件和它前面一条之间的间隔，按任务求和；它是墙钟时间，夜里和周末都算在内，只是近似值。
- **按模型的首轮复核通过**：按模型数已完成的任务里，第一次复核就通过的有几个、没经过复核的有几个。模型取 `acceptance.json` 记录的实际使用模型，渲染验收的任务取 `render.json`，都没有的记为 `(unknown)`。

### 拆分复杂任务（taskctl split）

一个 complex 任务往往不是一个 worker 回合能做完的事。`taskctl split` 在它**还是 `draft`** 的时候把它拆成若干可以独立验收的子任务，并写清父任务最后怎么整合：

```bash
taskctl split --task 003-feature            # 只出计划：tasks/003-feature/split-plan.json，看板不变
taskctl split --task 003-feature --apply    # 发布拆分包；计划已存在就按原样发布，不再调用模型
taskctl approve --task 003-feature          # 签字 = 放行整个拆分包
taskctl run
```

流程与保证：

- **一次模型调用，写下来的就是全部。** 规划器只提出计划（每个子任务的标题、说明、验收标准、验收方式、执行策略，以及子任务之间的先后），并用短 `key` 指代它们；taskctl 按看板编号分配真正的 id 存进计划。之后发布不再咨询模型——同一份计划文件重放多少次结果都一样，手工编辑过的计划也按编辑后的原样发布。已有计划时再跑 `split` 只是把计划显示出来，不会悄悄买一份新的。
- **校验不过就什么都不写。** 子任务太少、依赖了不存在的兄弟或成环、没有可判定的验收标准、`mechanical` 没给命令、`render` 没给目标、改写或丢掉了父任务的最终验收标准、嵌套拆分……都会被拒绝；原因进日志和终端，规划器的原话留在 `tasks/<id>/split-plan.rejected.txt`。还有未回答的问题（`questions.md`）时也拒绝出计划——计划是对着 spec 做的。
- **批准前一个回合都不会跑。** 子任务以 `open` 发布，但只要祖先还是 `draft` 就不会被领取；调度器和领取处各自独立判断，谁都不只依赖对方的过滤。`approve` 父任务的那一刻整个包一起放行，并写明放行了几个子任务。
- **先子后父，崩溃可续。** 发布顺序：全部拒绝条件判定完 → 写子任务文件 → 重新扫描实际文件校验依赖 → 最后才把父任务连上（`depends_on` 追加子任务、正文加一节「拆分与整合」、补上整合才需要的验收标准；原有意图与最终验收标准原样保留）。崩溃在连接之前，子任务被仍是 `draft` 的父任务挡着，重跑 `--apply` 用同一批 id 接着做完；崩溃在之后，重跑不改任何字节。
- **与已有文件不一致就停下。** 同 id 的任务已存在，却不是本父任务的子任务，或内容与计划不同（被人改过，或来自另一份计划）：发布中止、什么都不写，留给人判断。
- **子任务继承父任务的 `risk`、`human_check`、`tolerate`、`keep_at_root`、`workdir`、`model`**，规划不能降低它们。要让某个子任务更宽松，只能在签字前直接改它的任务文件——那是你的显式声明。子任务共用父任务的工作目录，所以按依赖顺序串行执行。
- **父任务等待期间不占工作区。** 子任务全部 `done` 之前，父任务根本不会被领取。轮到它时，worker 和 reviewer 各收到一份有界摘要：每个子任务的 id、标题、最终状态、最新交接的状态行、产物路径、验收记录与复核结论的出处——只给结论与出处，不重放它们的会话。
- **等什么，看得见。** `status` / `board` 会把 `open` 任务说清楚：`等父任务批准（… 仍是 draft）`、`等依赖：…`、`依赖受阻：…（已阻塞 / 等放行）`；`report` 显示任务所属的父任务，或父任务在等哪些子任务。依赖链再深也不会被固定的 pass 预算截断；预算真的耗尽时，`run` 会列出没启动的任务。

重新规划：删除 `tasks/<id>/split-plan.json`，再跑一次 `taskctl split --task <id>`。已经发布的子任务不会被悄悄替换。出计划之后父任务定义被改过，`--apply` 会拒绝并说明；已经连接过的包，之后你再手改父任务，`--apply` 是空操作而不是报错——那时父任务是你的，签字前随你改。

只支持一层拆分，也不支持执行中动态改计划：那需要多文件原子发布、阻塞传播和依赖等待报告同时到位，等真实的拆分记录证明有必要再说。

## 运行

### taskctl run — 派发

```bash
npx tsx src/main.ts run [--log <file>] [--config taskctl.json]
```

按文件名顺序处理 `open` 任务：领锁 → 独占工作目录 → 持久化执行身份 → `running` → 会话/交接 → 完成请求 → 验收。全过程打印 `[<id>] <状态> [详情]`。缺少验收时输出 `acceptance-skipped` 并阻塞待审。`running` 孤儿任务只有已确认上一执行结束才能恢复；活跃/不确定记录或缺少执行身份的旧任务会阻塞，不盲目重跑。

**故障隔离**：控制器内部错误只影响所在任务——该尝试结算、工作区释放、任务 `blocked` 并发出 `controller-error` 事件，其余任务照常排空；此时 `run` 仍排空看板，但退出码为 1。任务被预算护栏拒绝时同样是排空看板、退出码 1，见「已知陷阱」。预期内的情况不算内部错误：复核超时（已确认停止）只保留待复核的现场（`review-pending.json`，用 `taskctl retry --review-only` 恢复），验收时模型进入冷却不影响已完成的回合。

**退出码**：`0` 跑完（包括有任务以 `blocked` 或 `awaiting-human` 结束）；`1` 运行错误，或有任务因控制器内部错误而 `blocked`，或有任务被预算护栏拒绝；`2` 用法错误；`3` 因模型不可用停下——每个模型的原因、几轮、多久、还在等的任务都会打印出来，没有任何任务被 `blocked`，改好 `modelChain`（需要的话补上 `allowedModels`，先用 `taskctl models` 看判定）后直接再跑一次即可（见「模型拒绝与轮次」）。因模型不可用停下时一律是 `3`：同一次执行里有任务被护栏拒绝、或有任务因控制器内部错误而 `blocked` 也一样，护栏那几行和控制器错误照常打印在报告旁边。`run` 等模型窗口时先打印一行 `[<id>] model-wait waiting …`。

同一实际工作目录（含路径别名）不可并行执行；共享 Git common directory 的 worktree 暂按串行处理。当前不自动创建/合并 worktree。验收前后对源码产物做摘要；验收命令改变产物会要求复核，不会把旧检查套到新版本。摘要排除 Git 内部、依赖目录、任务运行时目录，以及本次运行的配置文件本身——`taskctl.json` 放在工作目录里时，改它不算产物变化（另可用 `artifactIgnore` 忽略任务自产物的路径，见下节）；详见 `src/workspace.ts`。

**控制器日志（`--log`）**：`--log <file>` 把每个 `[<id>] …` 事件行连时间戳 tee 进指定文件（stdout 照常输出；文件目录不存在会自动创建）。不指定时，每个任务的事件行缺省写进它自己的 `tasks/<id>/logs/run-<ISO>.log`（ISO 是本次 run 的启动时刻，`:` 换成 `-` 以便 Windows 文件名）。这取代了以前"外部 `Tee-Object` 到仓库根目录"的做法——控制器日志从此落在任务目录里，不再污染工作区。日志写失败只忽略，不会拖垮 run。

### 模型拒绝与轮次

provider 拒绝（429 / 配额 / 鉴权 / 5xx / `no-route` 等，即 adapter 标出的 `failure: "provider"`）说的是账号或模型，不是任务。adapter 先看后端给错误标的类型：标成 `provider.*` 的一律算拒绝，不看措辞；没有类型的，按错误文字和标准错误里的关键词认。无论被拒的回合是否已经干了活，它都**不花 `retries`**，也**不会让任务 `blocked`**：

- **一轮**是把派发链（`modelChain` → `modelFallbacks`）从头走一遍，每个模型试一次；被拒就立刻换下一个。每一轮都从链首开始；`chainCycles` 与配额退避只在一轮之内生效。
- 一轮里每个模型都拒绝（或都还在共享冷却窗口内），这次 attempt 结束：任务回到 `open`，带一份**推迟记录** `tasks/<id>/model-wait.json`——轮次、本次执行里第一次被拒的时间、每个模型的拒绝原话、下次可领取时间（`modelCooldownMs`，默认 60 秒）。时间没到之前，调度器和领取处都不会碰它，和依赖没完成时一样。
- `run` 在没有别的任务可跑时，等到最近的下一次时间再来一轮（等之前打印一行 `[<id>] model-wait waiting …`）；`watch` 每 30 秒醒一次，同样只靠领取处的这道门。看板级共享冷却表 `.taskctl/model-cooldowns.json` 只负责「窗口内别再撞同一个模型」，不再造成 `blocked`，也**不当作证据**。只有任务自己被拒的那一轮才计数；整个链都因为别的任务的拒绝而在冷却、于是什么都没派发的那一次不计数，它的下次时间是这些窗口里最早到期的那个。
- 连续 `modelRounds` 轮（默认 4，约 4–5 分钟）没有任何模型接受之后，attempt 自己**不做判断**，只把轮次记下。控制器等到没有任何尝试在跑时才看这次执行自己的证据：**期间有没有别的任务在链上某个模型上成功过一个回合。** 另一个任务的回合正在跑时就先等它结算——它可能就是证据。
  - 有：模型是好的，问题在这个任务自己。只把它 `blocked`，交接笔记逐个写出每个模型和它的拒绝原话；依赖它的任务照常等，其余任务继续。
  - 没有：这是模型不可用。任务原样留在 `open`、`retries` 不动，整次 `run` 或 `watch` 停下并打印报告（每个模型的原因——后端自己的原话，几轮、多久、还在等的任务），退出码 **3**。改好 `modelChain`（需要的话补上 `allowedModels`，先用 `taskctl models` 看判定）后直接再跑一次 `taskctl run`（或 `taskctl watch`），所有等待的任务自动继续，不需要逐个 `retry`。
- 「成功过一个回合」指 worker 回合退出码为 0，或 reviewer 的回合不是 provider 拒绝且有自己的会话（哪怕它崩了、没给出判决）；超时的复核回合（照旧 park）和退出码非 0 的 worker 回合不算。证据按模型记在这一次执行里，不落盘，也从不读共享冷却表——那张表每个模型只有一条，会被最近一次拒绝覆盖。
- 同一次执行里轮次用尽的任务不会再被提供；新的一次 `run` / `watch` 从第 0 轮算起。手工 `taskctl retry` 不归档推迟记录：它保留已经记下的最早可领取时间，把轮次和第一次被拒的时间清零——这次 `retry` 买到全新的一轮 `modelRounds`；共享冷却表照旧不清，刚拒绝过的模型不会被立刻再撞。
- **预算护栏的拒绝不是这里的拒绝。** 护栏判定的是「这个模型要不要花钱」，被拒的任务没有会话启动、没有模型被问，所以不开始一轮、不写推迟记录、也不算证据。`run` 对它只提供一次，照常打印护栏原话并以退出码 1 结束；`watch` 五分钟内不再拿它，批次在它那里停下。被拒的任务记在 `.taskctl/guard-refusals.json`，`taskctl status --stuck` 据此列出它。推迟在调度器里是护栏之外的**第二重**排除：两者都不算进展，都等到各自的时间为止。两种等待并不一样——推迟会让 `run` 等一等再试，因为 provider 的拒绝会过去；护栏的拒绝不会，因为读到的目录在进程存活期间不会变。
- 复核阶段同理：reviewer 被拒不花任何额度，也不重放 worker 的工作和验收。窗口一到，控制器自己对保留下来的证据只跑复核（`review-pending.json` 与它的摘要门）；`modelRounds` 轮之后由控制器按同一条证据规则决定——留给人（`blocked` + `review-pending.json`），或按模型不可用停下并保留证据。reviewer **超时不是拒绝**，保持今天的 park（`blocked` + `review-pending.json`，`taskctl retry --review-only` 恢复）；**崩溃也不是拒绝**，保持今天的处理：判不出来转 `awaiting-human`。复核阶段的轮次单独计数，所以一个任务可以先作为 worker、再作为被复核的任务，各被推迟 `modelRounds` 轮。窗口还没到时执行 `taskctl retry --review-only`，命令不会跑，而是打印等到几点再来。复核没有单独配链时沿用 worker 链；worker 的链首刚拒绝过，复核就从接手的那个模型开始。

随时可以问「哪些任务卡住了、为什么」：`taskctl status --stuck`。

### taskctl run --batch — 连续批次

```bash
npx tsx src/main.ts run --batch C,B,A [--log <file>] [--config taskctl.json]
```

批次只是调度策略，不是把多项任务合成一个“大任务”。它严格按命令行给出的 `C,B,A` 顺序执行，先整选校验，再从普通 `run` 队列之外**只领取这些任务**。每项都必须：`execution: continuous`（或从 `simple` 推导）、同一解析后的 workdir、`verify: mechanical` / `render`、普通风险、无 `human_check`、依赖已 `done` 或排在所选顺序的前面，并且没有活跃或未结算的旧执行。高风险、人工门禁、跨 workdir、显式 iterative 会被拒绝，不会静默放宽。

每个任务仍然单独领锁、保存定义快照、跑自己的验收和必要的复核，写自己的 `acceptance.json`、session 与 usage 增量；验收**不会**推迟到批次末尾。每次领取前还会重读看板并比较原定义和 workdir，中途改动在被改任务领取前拒绝。复核 `fail` 在当前领取内返工，不会把任务退回 `open`；批次对 `open` 结果的重试是为将来的调度器结果保留的防御分支，目前只有测试接缝能到达。`blocked` / `awaiting-human` / `skipped`（领取被拒、任务已不在 `open`/`running`、依赖未就绪、所有权丢失）会停止批次，后续任务不被领取。被操作员中断的任务（`stop --now`、Ctrl-C）同样停止批次。当前任务被推迟（等模型窗口）时批次停下并打印下次可领取时间，退出码 `0`——到点再跑一次即可，批次自己不等待。`--batch` 显式选中的任务若还在推迟窗口内，整批在领取前就被拒绝并说明时间。批次里出现模型不可用时同样打印报告并以退出码 `3` 退出。

上一任务干净结算后，只有实际 model 与 canonical workdir 都一致、worker session 标记 clean、后端探测返回 `reusable` 时，下一任务才续用该 session。model 不匹配或探测 `unavailable` 会记 journal 后新开；`active` 会阻塞待 reconcile，不会启动竞争 worker。

### taskctl watch / stop — 常驻队列与优雅停止

```bash
npx tsx src/main.ts watch --config taskctl.json          # 常驻调度
npx tsx src/main.ts watch --config taskctl.json --resume # 明确清除上次 stop 请求后启动
npx tsx src/main.ts stop --tasks-dir tasks              # 另一个终端：请求优雅收尾
npx tsx src/main.ts stop --tasks-dir tasks --now        # 另一个终端：立即中断正在运行的工作
```

watch 用文件事件（250ms 去抖）和 30 秒兜底扫描发现新任务；空转不做模型调用、完整产物摘要或看板重写。未完成的非活跃 `running` 任务优先，随后按看板顺序处理就绪任务；`draft`、`awaiting-human`、`blocked` 仍留在看板上，但不会绕过门禁执行。

至少两个连续合格任务时自动成批，上限是 `batchMaxTasks`（默认 5）。自动成批只取 `ready()` 队首的**连续合格前缀**，不会让后面的任务越过更早的高风险、人工门禁或其它不合格任务；单个任务直接普通执行，`batchMaxTasks: 1` 关闭自动成批。批次进行中新到的任务等下一个调度边界，不会插进当前选择。被预算护栏拒绝的任务五分钟内不在候选里，之后重新判一次；这期间后面的任务照常调度。被推迟（等模型窗口）的任务不参与选择，排在它后面的任务照常调度；它的窗口一到，最晚 30 秒后自动再试。出现模型不可用时 watch 打印与 `run` 相同的报告并以退出码 `3` 退出；不会写下 stop 文件，所以下一次 `taskctl watch` 不需要 `--resume`。

一个看板只有一个 watch 所有者，记录在 `.taskctl/watch.lock`，带完整 owner generation 和 heartbeat。第二个活跃 watcher 会直接拒绝；stale / 损坏记录只诊断，不自动接管，确认旧进程已消失后需人工清理。

`stop` 只写 `.taskctl/stop.requested`，不发送进程树终止信号。watch 不再领取新任务，让当前 worker attempt 安全结算并释放记录后退出；stop 文件保留，因此下次启动必须显式 `watch --resume`。恢复清 stop 的动作发生在取得 watch 锁之后，第二个 watcher 不能清掉正在运行者的停止请求。停止的粒度是整个 attempt（可能含多个回合），不是单个回合。

`stop --now` 在此之上**立即中断**：它多写一个 `.taskctl/stop-now.requested`，正在运行的 `run` / `watch` 在下一个调度边界看到它，正在执行的 attempt 则最多 250 毫秒内看到它（只在有 attempt 运行时轮询这一个文件，等模型窗口的 `run` 也轮询，所以另一个终端的 `stop --now` 会立刻结束那次等待），于是取消当前回合的进程树（同时请 opencode 服务停掉该会话）以及正在执行的验收命令。确认成功后，这次 attempt 记为「被操作员停止」：任务回到 `open`，被切断的验收、渲染检查和复核一律不判定，journal 记一条 `stopped`，`attempt.json` 是 `settled` + `stopped by operator`，任务锁和工作区预留都已释放——直接再跑 `taskctl run`（或 `watch --resume`）即可。被中断的 worker 会话标为不可续用，重跑会新开会话；它已经写进工作区的东西原样保留（不回滚，也不做回合后清扫）；worker 不会收到任何「请收尾」的指示，它只是被取消。`retries` 通常也不动。例外是 stop 落下时某一步已经跑完、正在记账：那一步按自己的结果记下（可能计一次重试或一轮复核），这次 attempt 随后才结算为停止；渲染验收恰好判完的情形则直接以 `done` 结束。两种情形下被中断的东西都没有被判——停止行（journal 与事件行）说的就是这一点：`no interrupted step was judged`；重试数以看板为准。领取之前的预算护栏判定不会被 stop 打断：stop 已经在等时护栏根本不会被问（没有会话启动，也没有目录读取）；护栏正在判的时候落下的 stop，会在判定结束、领取之前被看到。护栏拒绝的任务不是被中断的尝试——结局仍是护栏的 `refused`。

在 `run` / `watch` 上按 **Ctrl-C**（SIGINT）或收到 SIGTERM 与 `stop --now` 完全相同：同样中断、同样留下两个 stop 文件（所以下一次 `watch` 需要 `--resume`），只复位 `retry --review-only` 的任务会被放回 `blocked` 并保留 `review-pending.json`（自动续跑的推迟复核是从 `open` 领取的，停止后回到 `open`，保留的证据和推迟记录都原样留着）。`stop --now` 落在批次上时中断的是批次当前任务的回合，批次随即停止，后面的任务不被领取，下一批不会续用被切断的会话。被操作员停下的 `run` / `watch` 不会判定为模型不可用：不打印那份报告，也不以 3 退出；正在等模型窗口的 `run` 收到 stop 立即结束等待。比控制器更早发出的 stop 请求对新的 `run` 不起作用；超过取消上限（8 秒）仍无法确认时——例如 opencode 服务不应答 `session.interrupt`、或进程树里有它够不着的进程——这次 attempt 记为 `uncertain`、任务 `blocked`、退出码 1，和超时后的处理一样需要人工对账，绝不会伪装成干净的停止。

退出码：`run`、`watch` 和 `retry --review-only` 一样——`stop --now` 确认成功 → 0；SIGINT → 130；SIGTERM → 143；只要有一次中断未能确认 → 1（优先于前两者），并打印一行点名需要人工对账的 attempt。同一次执行里还有任务被护栏拒绝、或有任务因控制器错误而 `blocked` 时，`run` 仍退出 1（停止报告照常打印）；只有一次干净的 `stop --now`、而且没有别的要报告时才是 0。最终修正之后，`retry --review-only` 在收到停止请求时同样如此：领取之前被 stop 检查挡下的 `skipped` 答 stop 自己的码；因别的原因（丢了领取、所有权变了）被跳过的，先打印 stop 的报告，再打印 `review-only recovery refused or still unavailable: skipped`，退出 1；中断无法确认的 `blocked` 带对账行退出 1；控制器自己的原因造成的 `blocked` 先打印 stop 的报告、再打印普通那一行，退出 1。130/143 是入口进程自己的退出码，而且普通退出会被 `npx` 原样转发：另一个终端发出的 `stop --now`、以及让进程自己收尾的 SIGTERM，shell 看到的仍是上面写的 0 / 1 / 130 / 143。在控制台里按 Ctrl-C 的情况已于 2026-11-27 实测（opencode v2.4.2；在一个自有控制台里经控制台的 API 发送真实的 Ctrl-C 事件，不是真人在可见窗口里按键。这些格子多数用的是把 SIGINT 按 taskctl 的方式处理的替身入口——没有后端、不耗额度——只有真 taskctl 在真后端上跑了三次 Ctrl-C）：直接经 tsx 的 CLI 启动、输出直接进控制台时，pwsh 7.6.10 上（真 taskctl）停止照常完成，shell 一直等到入口进程结束才交回提示符——按键后约 2.5 秒——`$LASTEXITCODE` 是 130；同一启动方式在 Windows PowerShell 5.1 和 cmd 上（替身入口，cmd 那一次输出写到文件）退出码同为 130（cmd 里读的是 `%ERRORLEVEL%`），提示符何时回来没有计时。经 `taskctl` 的 `.cmd` shim 启动、输出直接进控制台时，pwsh 7.6.10 和 Windows PowerShell 5.1 上（替身入口）提示符在入口结束后回来、退出码 130；cmd 下经 `.cmd` shim 没有量。经 `npx tsx …` 启动时停止同样完成，但 npx 自己的包装进程随按键结束，pwsh 7.6.10 上提示符约 0.4 秒就回来，`$LASTEXITCODE` 是 1（npx 的码，不是 taskctl 的）；经 `npx` 启动这一种只在 pwsh 7.6.10 上量过。把输出接进 PowerShell 的管道或重定向会破坏停止，见「排障」。还没有实测：对真实进程发送 SIGTERM（143 仍只有离线测试为据）、cmd 下经 `.cmd` shim 的启动（交互式 cmd 停止后是否会问 `Terminate batch job (Y/N)?` 也在其中）、Git Bash 等其它 shell，以及可见终端窗口里的真人按键。第二次 Ctrl-C 不会强杀控制器，只提示 `still stopping`，整个过程有上限（实测连按两次也只有一行 `received`、一行 `still stopping`，记录与退出码 130 和按一次相同）。`add` / `split` / `verify` / `check` / `models` / `recall` 不装信号处理，Ctrl-C 的行为和以前一样。

渲染检查（无头浏览器）今天不是可取消的执行：`--now` 落在它身上时会打印一行 `stop-requested`，等它自己结束（每一步有 30 秒上限），然后同样不判定、任务回到 `open`。记忆召回（`memory.backend` 为 `mempalace` 时，每个 attempt 第一个回合之前的一次查询）也不是可取消的执行：同样先打印一行 `stop-requested`，等它自己结束（上限是 `memory.timeoutMs`，默认 20 秒），然后不派发任何回合、任务回到 `open`。

Windows 上，取消时会用系统自带的 Windows PowerShell 列一次进程表，核对根进程之下是否还有活着的进程，再等输出管道关闭；列不出来（PowerShell 不可用）时，`taskkill` 的报告只顶替「后代是否都已消失」这一步，输出管道仍要关闭。父进程在取消开始前就已退出的「孤儿」进程无法归属（见 ADR-0007：不按旧 PID 杀进程），仍按 `uncertain` 处理。非 Windows 平台按进程组终止，不做进程表核对。为了让 Ctrl-C 只到达控制器，`run` / `watch` 把 `opencode run`、验收命令的 shell、`opencode api` 调用（护栏读取模型目录、遥测、取消时的 `session.interrupt`）、记忆召回的 MCP 服务器，以及控制器等待的每一个 `git` 子进程（回合后清扫读未跟踪文件、复核读改动清单、领取时读工作区的 Git 公共目录），都启动在控制器的按键到不了的地方：Windows 上各自开一个隐藏的控制台，其它平台各自一个进程组；Windows 上没有改用不带控制台的独立进程，是因为它们启动的程序会因此拿不回输出。

watch 严格串行，不读 `parallel`。调度边界出错——某个已注册任务文件写坏、依赖成环、选中的任务被别的控制器先领走——不会让 watch 退出：它报出原因并等下一次事件，看板修好后自动恢复，期间 `stop` 仍然有效。

### 产物卫生：LOG_DIR 约定与回合后清扫

真实任务跑完后，工作目录根上常堆着 `_accept_*.log`、`_diag_*.m` 之类的杂物——协议只说"只在此目录内改动"，没说临时文件写哪里。三层解法（`gc` 子命令另立任务）：

1. **约定 + 环境变量**：每个 worker 回合注入 `TASKCTL_TASK_DIR`（= `tasks/<id>`）与 `TASKCTL_LOG_DIR`（= `tasks/<id>/logs`，控制器保证回合前已创建）。工作规则里写死一条：**临时文件与日志一律写 `$TASKCTL_LOG_DIR`；工作目录根目录只放交付物**。worker 会话及其子进程（验收命令、脚本）都能读到这两个变量。
2. **控制器日志**：见上文 `--log`；缺省逐任务落 `tasks/<id>/logs/`。
3. **回合后清扫**：每个 worker 回合前后，taskctl 对工作目录**根目录**（非递归）做快照，回合结束后把同时满足以下条件的文件**移动**（只移动，永不删除）到 `tasks/<id>/scratch/`，并在 journal 记 `artifact-swept <from> -> <to>`：

   - 本回合**新增**（回合前快照里没有）；
   - **未跟踪**（`git status` 报 `??` 或 `!!`——被 `.gitignore` 忽略的也算未跟踪，本机制不依赖 .gitignore）；
   - 文件名命中 `artifacts.scratchPatterns`；
   - 不命中任务级 `keep_at_root` 豁免。

   已跟踪文件、回合前就存在的文件、目录一律不碰。scratch 里重名不覆盖（自动加 `-N` 后缀）；跨盘移动退化为复制+删除，仍是移动。清扫失败（含 git 不可用——非 git 工作目录整体惰化）只记 journal（`artifact-sweep-failed` / `artifact-sweep-skipped`），不阻断任务。`artifacts.sweep: false` 整体关闭。

   **注意**：`*.txt` 在缺省 patterns 里——如果任务的交付物本身就是根目录下的 `.txt`/`.log`，要么把文件名写进任务的 `keep_at_root`，要么收紧 `scratchPatterns`，否则交付物会被挪进 scratch（可从 journal 找到落点找回）。

#### 验收的自生成产物：`artifactIgnore` 与 `TASKCTL_ACCEPTANCE_MODE`

有些任务的验收命令会**按 spec 生成产物**——`report.json`、`timing.json`、`perf.json` 之类。这类命令一旦在验收门里重新生成文件，就被自己的写入判成 drift（`acceptance evidence invalidated by … artifact drift`）。两条互补的解法：

- **`artifactIgnore`（路径级忽略）**：`taskctl.json` 里声明验收命令**自己会写**的路径。命中的文件不参与验收前后哈希，重写它们不算 drift；未命中的路径照常判定。适合「产物本来就是任务交付物、每次运行都会重写」的场景。

  ```json
  { "artifactIgnore": ["reports/*.json", "timing/**"] }
  ```

  语义：相对 workdir 的路径或 glob（`*` 不跨目录、`**` 跨目录、`?` 单字符；`\` 与 `/` 等价；不支持 `[abc]` 字符类和 `!` 取反；大小写敏感）。一个只装着被忽略文件的目录整体不注册——验收命令新建 `timing/` 并写入被忽略的 JSON，摘要不变。能匹配整个工作区的模式（如 `**`）在配置处直接报错，不让 drift 检查被无声架空。**不要把源码路径放进来**：这个开关绕过的是「验收命令自己写自己」的判定，不是「任务该改的没改」的判定。

- **`TASKCTL_ACCEPTANCE_MODE=generate|check`（生成/检查分离）**：taskctl 给命令注入这个环境变量。**控制器验收门注入 `check`**——命令只读不写，`artifactBefore == artifactAfter` 自然成立；**worker 声明的 `worker_self_check` 经 `taskctl check` 执行时注入 `generate`**——命令可以生成/刷新产物，写入发生在尝试窗口内，不进摘要比较。worker 不再默认重复运行完整 `acceptance`。

  推荐写法：验收命令开头判断模式——

  ```bash
  #!/bin/sh
  if [ "$TASKCTL_ACCEPTANCE_MODE" != "check" ]; then
    node scripts/build-report.js   # generate：产出 report.json / timing.json
  fi
  node scripts/verify-report.js    # check：只回读校验，退出码即判决
  ```

  推荐流程：确实需要先生成产物时，在任务里声明 `worker_self_check`（必要时与 acceptance 同脚本），worker 执行 `taskctl check --task <id> --tasks-dir <dir>`，以 generate 和有界超时产出报告，再 `taskctl done`；控制器随后以 check 跑 `acceptance`，零写入、按退出码判决。自验结果与取消前输出写入 `self-check.json`，门侧结果写入 `acceptance.json`（`mode: "check"`）。普通定向测试不需要声明全量验收；产物路径也可使用 `artifactIgnore`。

  边界：taskctl 不验证命令在 check 模式下**真的**没写文件——写了又没进 `artifactIgnore`，照样判 drift 拦下（fail closed）。check 模式的合规是命令作者的责任。

工作目录预留同时保存在 `<workdir>/.taskctl-workspace.lock/` 和用户临时目录 `opencode/taskctl-workspaces/reservations.json`。注册表检查父子目录及 Git 元数据路径的重叠，即使运行期间执行 `git init` / 新建 linked worktree 也不能绕过既有预留。只删本地锁不会清除不确定执行的预留。

### taskctl findings — 把一次真实任务的摩擦抽成草稿

```bash
taskctl findings --task <id> [--out docs/findings/2026-11-17-<slug>.md] [--tasks-dir <dir>]
```

从 `journal.md`、`review.json`、`render.json`、`acceptance.json`、`attempt.json` 里抽机器可查的事实（升级、阻塞、返工、交接、降级、验收失败、复核未过的标准、渲染失败……），拼成一条按模板排好的草稿；**只抽事实，不写结论**，`复现条件` 和`猜测的成因` 留空给人填。

默认打印，`--out` 才落盘。用途是多机之间传递真实摩擦：`tasks/` 不在 git 里，换台机器这些证据就没了。约定、命名、以及"从 finding 到改进任务"的两条硬规则见 [docs/findings/README.md](docs/findings/README.md)。

### taskctl done — 请求完成（agent 侧）

```bash
taskctl done --task <id> [--tasks-dir <dir>]
```

写 `tasks/<id>/done.requested` 标记；worker 在回合边界消费它并跑验收。**它不会直接把任务变成 `done`**。

### taskctl check — 有界 worker 自验（agent 侧）

```bash
taskctl check --task <id> [--tasks-dir <dir>]
```

只允许在任务 `running` 且 attempt 活跃时执行声明过的 `worker_self_check`，以 generate 模式和任务级超时运行，结果写 `self-check.json`。它不会改变任务状态，也不能代替控制器的 `acceptance`。超时且确认停止后，取消前输出也会保留。

它在本次尝试的工作目录里运行，超时上界也取自领取时写下的 `attempt.json`（`workspace` / `turnTimeoutMs`），所以从任务的子目录调用、或控制器用别处的 `--config` 启动，结果都一样。

### taskctl note — 交接笔记（agent 侧）

```bash
taskctl note --task <id> --status <一句话状态> --done <已完成> --found <关键发现> --next <下一步> [--files <逗号分隔文件>] [--tasks-dir <dir>]
```

追加下一条编号笔记到 `tasks/<id>/sessions/`（`0001-handoff.md`、`0002-handoff.md` …）。阶段进展随时可写；收到"上下文预算告急"收尾指令时必须详尽地写一次，然后只回复 `HANDOFF_READY`。

### taskctl status — 看板

```bash
npx tsx src/main.ts status [--stuck] [--tasks-dir <dir>]
```

每任务一行：id、status、retries、sessions 数、最新笔记的 Status 行。没有 `schema: taskctl/v1` 的 Markdown（或 frontmatter 解析不了的文件）单独列为 `ignored`，不参与调度。

`taskctl status --stuck` 只列出受阻或等待的任务，每个一行，只读文件、不问后端：

| 行 | 说明 |
| --- | --- |
| `已阻塞` | 原因（来自交接笔记或最近一条 blocked 日志）、起始时间；因模型拒绝而阻塞的逐个列出模型和拒绝原话；只差复核的写 `只差复核：<模型>：<原因>` |
| `等受阻依赖` | 等的是哪个任务（隔了一层时写 `A（经 B）`），以及那个任务为什么受阻 |
| `等模型窗口` | 第 n/`modelRounds` 轮、下次可领取时间；轮次用尽的：有尝试在跑时写明等它们结算后判断，没有时写明等所有者处理，新的 `taskctl run` 从第 0 轮开始 |
| `等护栏放行` | 被预算护栏拒绝的任务：护栏当时的原话和判定时间（来自 `.taskctl/guard-refusals.json`）；现在的判定以 `taskctl models` 为准 |
| `等放行` / `等签字` / `待回答问题` | `awaiting-human`、等签字的 `draft`（含待回答的问题） |

没有这样的任务时只打印一行「没有受阻或等待的任务」。当你问「哪些任务卡住了」，答案就是这个命令的输出。

所有「写临时文件、再改名覆盖」的落盘——任务文件、`attempt.json` 等运行记录、任务锁与 watch 锁的心跳、模型轮转、共享冷却表、usage、看板——都走同一个带重试的改名（`src/replace.ts`）：Windows 上杀软/索引器偶尔会短暂占用目标文件（EPERM/EBUSY/EACCES），重试耗尽才报错。心跳写失败**不等于**所有权丢失：只有锁记录不再属于自己（`heartbeat` 返回 false，或受保护写入前的所有权检查失败）才结束尝试或 watcher；写不进去不会被当成丢锁：任务尝试记一条 `heartbeat-write-failed` 日志（每个尝试一条），watch 报告一次（每次 watch 一条），下一个心跳周期重试。看板文件 `.taskctl/board.md` 是每次 `status` 重新生成的派生视图，重试耗尽也只影响这一次看板刷新。运行中的事件刷新会合并突发写入，只保留正在写的一次和最后一次最新状态。

`taskctl report --task <id>` 的 `usage` 节按 worker/reviewer 和模型汇总 `usage.jsonl` 的增量。基线保存在看板级 `.taskctl/usage-sessions.json`，因此多个 Task 共享 session 时不会重复计算前一段消耗；计数器重置或后端未提供数据会显示 unknown，而不是伪报零成本。`review.json` 同时记录 `reviewerSessionId`。

## ⚠️ 已知陷阱

- **仓库根目录自带一个 open 任务**：`tasks/example.md`（`status: open`）。在仓库根目录直接 `taskctl run` 会真的派发它 —— 真实 agent 会在当前目录创建 `hello.txt` 并消耗模型额度。请换到自己的工作目录运行，或先删掉 / 关掉该示例任务。
- **`--config` 路径写错不报错**：配置文件读不到（ENOENT）时按"全默认"处理（`tasksDir=tasks`、`workdir=当前目录`）。路径拼错不会失败，只会让任务跑在非预期的目录。请核对拼写与相对路径基准（当前目录，不是仓库根）。
- **预算护栏会拒绝现有配置**：按量计费和成本未知的模型默认不放行，升级后第一次 `taskctl run` 会拒绝这样的任务，直到补上 `allowedProviders` 和 `allowedModels`。先跑 `taskctl models`：它只读模型目录、不启动任何会话，把每个模型的判定列出来，有被拒的就退出码 1。
- **升级后，旧版本保留的复核会被摘要挡下一次**：2026-11-26 起产物摘要不再计入配置文件。在那之前的版本写下 `review-pending.json`、工作目录里又放着 `taskctl.json` 的任务，升级后第一次恢复会 `blocked`，报 `artifacts changed after the preserved worker/acceptance evidence`——其实什么都没变，变的是摘要的算法；`taskctl retry --review-only` 同样被挡。对这样的任务做一次完整的 `taskctl retry`，再 `run`（worker、验收、复核都会重跑）。配置文件在工作目录外的任务不受影响，照常自己恢复。
- **目录和默认模型按会话所在的目录读**：后端按目录回答 `model.list` 和 `model.default`，项目里放一份 `opencode.json` 就会改变两者。`taskctl models` 判的是配置里的 `workdir`：从任务的目录运行它，或者把 `workdir` 指过去，否则看到的不是任务真正会用的那份目录。
- **模型目录的条目带凭据**：条目里有 `settings.apiKey` 和 `headers`，任何路径都不打印、不记录它。`opencode api` 调用失败时，拒绝理由里只有操作名和一个代码（如 `opencode api model.list failed: exit 1`），不引用服务的输出。
- **被护栏拒绝是什么样子**：任务保持 `open`，没有模型会话被启动，不需要人工恢复。领取之前的那次拒绝什么都不写。领取之后、会话启动之前还会按重读到的任务再判一次，调度器的快照和领取之间被改过 `model` 的任务就在这里被拦；那条路上锁和工作目录预留已经写下、又都释放了（执行状态读不出来时 journal 里会留一条 `execution-state-invalid`）。同一个任务、同一条理由在一个进程里只报一次，理由变了会再报。被拒的任务记在看板级的 `.taskctl/guard-refusals.json`（任务、判定时间、护栏原话），`taskctl status --stuck` 据此列出它；任务下一次被提供且未被拒绝、或者离开 `open` 时，这条记录随之删除。`taskctl run` 打印 `[scheduler] N task(s) refused by the budget guard; no model session was started for them` 并以退出码 1 结束；`watch` 五分钟内不再拿出这个任务，之后重新判。
- **目录读不到、或读回来是空的，一律按拒绝处理**：这样的答案不会被记住，下一次会再读，后端恢复后重跑 `run` 就能过。后端报不出默认模型时，链为空的那个角色被拒，理由是 `后端默认模型无法确认`（配置里一个模型都没写时会落到这里；只写了 `model` 没写 `reviewerModel` 时复核沿用 worker 链，不判后端默认模型）。`opencode` 还是 npm 的 `.cmd` shim 时，理由是 `opencode api model.list failed: ENOENT`，原因和下面「Windows 下 spawn opencode 失败」相同：把 `opencodeBin` 指向真实的 exe。
- **记忆召回默认关闭**：`memory.backend` 不是 `mempalace` 时没有召回、没有 `recall.json`、没有子进程。开着时后端出任何问题都只降级，任务不会因此 `blocked`。`memory.rooms` 不能为空。召回拉起的子进程在 Windows 上总会被结束；POSIX 上一个忽略 SIGTERM 的服务可以在两秒等待之后继续活着。
- **固定来源读不到不拦任务**：`fixedSources` 里的文件找不到或读不出来，那次尝试照样跑，只是不带这个文件，journal 留一条 `sources`。文件挪了位置不会在当时报出来，所以挪完跑一次 `taskctl recall`：有文件读不到它就退出码 1。
- **固定来源只带文件名，文件内容原样进提示词**：taskctl 不把规范文件的路径写进提示词、journal 和输出，只带文件名；但文件内容原样进提示词，文件里自己写了路径，那条路径就到了 worker 手里。

## 排障

**任务变 blocked** —— 原因包括重试耗尽、缺少验收、任务/产物变化、工作目录被占用、执行停止未确认、验收连续同一失败。模型拒绝**不再**让任务 `blocked`：它只会推迟任务，最多在连续 `modelRounds` 轮、且期间另有任务被服务之后，才以「本任务自身的问题」阻塞。先看事件日志、`attempt.json`、`acceptance.json`、`acceptance-failures.json` 与交接笔记。只有普通、已停止的失败才可修复后重开；不确定执行不能只改状态绕过。

**同一条验收失败反复出现** —— 验收连续给出同一个失败（归一化后的指纹相同；时间、绝对路径、耗时的差异不算不同）达到 `failureFingerprintLimit`（默认 3）次，任务 `blocked` 等人工，不再自动重跑。计数写在 `tasks/<id>/acceptance-failures.json`，所以跨尝试仍然有效（每轮都是新尝试，内存计数永远归 1）；任何一次验收通过就清掉。重复同一条失败重跑不会再给新信息：先决定是改判据、修门，还是承认证据不足。

**`task definition changed during the attempt`** —— 执行期间 `tasks/<id>.md` 的定义字段（`criteria` / `tolerate` / `risk` / `human_check` / `depends_on` / `acceptance` / `model` / `effort` / `complexity` / `verify` / `render_targets` / `title` / 正文）被改过，本次验收作废。判据是领取时写下的 `definition.json` 快照，不是验收那一刻磁盘上的文件——「工作按哪份定义跑的」和「证据被看时文件写了什么」是两件事。这是有意的：定义是人工批准的，执行者不能一边干活一边给自己换判据。核对是谁改的、改成什么，确认新定义可以接受后，用 `taskctl retry --task <id>`（它只对已 settled 的 attempt 生效）重开——这一步就是人工对新定义的确认。

### blocked 之后的恢复路径

```bash
taskctl reconcile --task <id>   # 只读诊断：lock / attempt 阶段 / 归属路径 / 匹配预留 / 结论
taskctl retry --task <id>       # 归档旧证据后重开；仅在 attempt 已 settled、无活跃锁、无匹配预留时执行
```

`reconcile` 只报告不改状态，结论是 `retry-allowed` / `manual-review` / `already-terminal` 之一；归属路径无法确定时一律 `manual-review`。`retry` 会拒绝任何"还可能有执行在跑"或"归属路径不确定"的情况，并把 `attempt.json`、`acceptance.json`、`review.json`、`models.json`、`review-pending.json` 移入 `tasks/<id>/archive/<时间戳>/`、重置 `retries` 与 `review_rounds`、写一条 `human retry` 日志。推迟记录 `model-wait.json` 不归档：`retry` 保留它已经记下的最早可领取时间，把轮次和第一次被拒的时间清零——这次 `retry` 买到的是全新的一轮 `modelRounds`，而刚拒绝过的模型不会被立刻再撞。

若任务因 Reviewer provider 全部不可用而阻塞，且存在 `review-pending.json`，`reconcile` 会建议 `taskctl retry --task <id> --review-only`。这条路径不调用 worker、不重跑验收，只在定义与产物摘要未变时恢复 Review（配置文件不算产物：改完 `taskctl.json` 再恢复，不会被摘要门拒绝）；共享冷却仍然生效，所以通常应等窗口结束或换健康 Reviewer。普通 `retry` 仍是明确的全量重试。从 2026-11-26 之前的版本升级时留意：那时保留的复核，在工作目录里放着 `taskctl.json` 的任务上会被挡下一次，`retry --review-only` 清不掉，要一次完整的 `retry`（见「已知陷阱」）。

**taskctl 不按记录的 PID 杀进程。** PID 会被复用，`attempt.json` 里的 pid 不能证明它仍属于那次执行（ADR-0007）。需要停止执行时，由人核实进程身份后自行处理；正在运行的控制器可以用 `stop --now` 或 Ctrl-C 请它取消自己仍握着句柄的子进程树（见「常驻队列与优雅停止」）；执行停止未确认（`attempt.phase` 不是 `settled`）的任务，`retry` 一律拒绝，仍需按下面的手工流程归档证据。

**worker 崩溃 / 不确定执行** —— 先核实原控制器、子进程树与后端会话均已停止，再检查产物。保留证据后，人工归档旧 `attempt.json` 和对应工作目录预留，再按需重开任务。不能仅按旧 PID 杀进程、删任务锁或改 `status` 后自动重跑。互斥目录 `.mutation.lock` 若因崩溃遗留也必须先确认原操作已停止，不能按时间强抢。

**stop --now 之后任务仍是 blocked** —— 看 `attempt.json`：`phase` 是 `uncertain` 说明取消没能在 8 秒内确认（服务不应答、进程树里有够不着的进程），按上面的「worker 崩溃 / 不确定执行」处理；`phase` 是 `settled` 且 `reason` 是 `stopped by operator` 才是干净的中断，此时任务已是 `open`，不需要 `retry`（例外：干净中断的若是 `retry --review-only` 的恢复，任务回到 `blocked`，`review-pending.json` 原样保留，仍可再用 `retry --review-only` 恢复）。

**在 PowerShell 里按 Ctrl-C 之前，别把控制器的输出接进管道或重定向** —— 用 `| Tee-Object`、`> log`、`*> file` 接住 `run` / `watch` 的输出时，按键被处理（控制器照常打出 `SIGINT received`）之后，PowerShell 随即把这条原生命令当作自己管道的一员杀掉（2026-11-27 实测，pwsh 7.6.10 与 Windows PowerShell 5.1）：pwsh 7.6.10 上真 taskctl 的提示符 0.37 秒就回来、`$LASTEXITCODE` 是 `-1`（同一格换上替身入口是 0.38 秒，Windows PowerShell 5.1 上的替身入口是 0.47 秒，退出码同样是 `-1`），停止请求文件没写，`attempt.json` 停在 `active`，任务停在 `running`，`watch.lock` 残留，回合的 worker 进程也留在那里。同一个假入口被杀得一模一样，所以这是 PowerShell 的行为，不是 taskctl 的；但它留下的是一个未结算的尝试——按上文「worker 崩溃 / 不确定执行」处理，`retry` 会拒绝，不会被当成干净的停止。要留输出，就别把命令接进管道或重定向：`run` 有 `--log <file>`；`watch` 和 `retry --review-only` 没有这个选项（`watch --log` 被当作未知选项拒绝、退出 2），它们每个任务的事件行照旧写进 `tasks/<id>/logs/run-<时间>.log`，而控制器自己的行——例如 `[watch] stopped by the operator: a; run again to continue`——只打到控制台、不在任何文件里。

人工修改共享预留注册表之前，先停止所有使用该注册表的 taskctl 控制器；仅处理已核对身份的那条预留及其本地标记，不清空其他任务的记录。当前没有自动“强制恢复”命令。缺少验收造成的普通待审则补上验收并重开任务即可，不需要清理已正常释放的预留。

**回合 / 验收超时** —— 单回合默认 30 分钟、验收 10 分钟。请求停止并确认停止后才允许计失败重试；无法确认则阻塞并保留工作目录预留。OpenCode CLI 被杀不代表其独立后端会话已停，因此 OpenCode 回合被中断按不确定处理，须人工核实。真实后端的取消已于 2026-11-27 在 opencode v2.4.2 上验证：由控制器发起的停止会让服务确认被切断的会话已经 idle，确认不了时才记 `uncertain`（`scripts/live-stop.ps1 -Live`，17 项 PASS）。

**provider 拒绝（429 / 鉴权 / 5xx / 配额耗尽）** —— adapter 把它标成 `failure: "provider"`。这类失败说的是账号或模型，不是任务：不花 `retries`，不 `blocked`，立刻换链上的下一个模型；一整轮都被拒就把任务推迟到下一个窗口（`modelCooldownMs`，默认 60 秒）。连续 `modelRounds` 轮之后才由控制器做判断，规则与报告见「模型拒绝与轮次」。想立刻知道哪些任务在等：`taskctl status --stuck`。

**模型降级链** —— 配了 `modelChain` / `modelFallbacks` / `reviewerModelFallbacks` 时，被 provider 拒绝的那一次不会去花重试额度，而是把这一回合交给链上的下一个模型。换模型同时是**会话边界**：上一个后端创建的会话不会交给下一个模型续，被拒的回合也不记进 `sessions`（它没干活）。复核被拒时在复核阶段内部换模型重试，不会把任务退回 worker 重跑——非幂等任务（写表、移文件）不能为了重试一次复核而被执行两遍。

一轮之内当前选中的模型记在 `tasks/<id>/models.json`；每一轮从链首开始——一轮就是把链走一遍，窗口内刚拒绝过的模型由共享冷却表挡住，不会再撞。`taskctl retry` 会把它和旧证据一起归档。

`models.json` 是提示性状态不是证据：**读**不到、读坏了、或者记的位置属于另一个模型（比如主模型被改过），一律按"从链首开始"；**写**不进去则不算换成了——本轮到此结束（推迟），并记一条 `model-fallback-failed` 日志。显式 `chainCycles` 在一轮之内的重探仍按原语义执行。

看板级 `.taskctl/model-cooldowns.json` 还会跨 Task、跨 run 记录模型拒绝与下一可探测时间。冷却期间不再发起已知拒绝，换到不同健康模型时不做无意义退避；到期才重探，成功清除。手工 retry 不清这张表，显式 `chainCycles` 在本任务内的重探仍按原语义执行。

**Windows 下 spawn opencode 失败** —— npm 全局安装的 `opencode` 是 `.cmd` shim，`shell:false` 无法启动。在 `taskctl.json` 里把 `opencodeBin` 指向真实 exe（见上文表格）。

## 测试

```bash
npm test                # 全部单元/集成测试（不碰真实 opencode）
npm run typecheck       # TypeScript 检查：src、tests、scripts 和 vitest.config.ts
TASKCTL_E2E=1 npx vitest run tests/e2e.smoke.test.ts   # E2E 冒烟（真实 opencode）
```

E2E 前置：本机 opencode 已安装并登录；Windows 下测试会自动解析 npm 全局 opencode 背后的真实 `.exe`（也可用环境变量 `TASKCTL_OPENCODE_BIN` 覆盖）。它会在临时目录里发起真实 agent 会话并消耗模型额度。

整条流水线的真实冒烟（临时项目、自带 taskctl shim、跑完打印 report）：

```powershell
.\scripts\smoke.ps1          # 只准备环境并校验任务已注册，不调模型
.\scripts\smoke.ps1 -Live    # 真跑一次，通过时打印 SMOKE PASS
```

它会验证：agent 在真实会话里干活 → 验收命令 → 独立复核 → `done`。2026-11-24 在本机 opencode 2.4.1 上跑通。不带 `-Live` 时它仍然检查冒烟任务被 `taskctl` 认作 `open`——任务文件少了 `schema: taskctl/v1` 就会被归入 `ignored`，`-Live` 会对着空看板跑完再报失败。

Phase 2 的有界真实验证（两任务批次共用一个 session、逐任务 usage、watch 发现运行期间新增的任务并经 `stop` 收尾、`watch --resume` 重启；共 3 个 worker 回合，可用 `-Model` 指定模型）：

```powershell
.\scripts\live-phase2.ps1           # 只准备环境并校验注册，不调模型
.\scripts\live-phase2.ps1 -Live     # 15 项断言，通过时打印 LIVE PHASE 2 PASS
```

```powershell
.\scripts\live-stop.ps1           # 只准备环境、校验注册，并在真实进程上走一遍 stop --now 与 watch 的拒绝；不调模型
.\scripts\live-stop.ps1 -Live     # 17 项断言：护栏放行、stop --now 打断回合、打断验收命令、重跑与 --resume；通过时打印 LIVE STOP PASS
```

它会消耗约 4 个 worker 回合。控制器一侧的 Ctrl-C 已于 2026-11-27 经控制台自己的 Ctrl-C 事件实测，结果见上文「taskctl watch / stop」的退出码段落与「排障」；没有实测的是真人在可见窗口里按键，步骤见 `docs/superpowers/plans/2026-11-25-stop-now.md` 的 Task 12。

## 凭据与隐私

- 通过 agent CLI 在本地配置模型凭据；不要把 API key、访问令牌或认证头写进任务、示例或仓库配置。
- 示例使用相对路径；机器专属可执行文件路径仅保存在本地，不提交到 Git。
- `.env`、密钥文件、私人记忆和实际任务运行数据默认忽略；`tasks/example.md` 是公开示例，不含真实任务记录。
- `attempt.json`、`acceptance.json`、交接笔记和模型输出可能含任务内容、运行路径或敏感数据；提交附件或共享日志前另行检查。`.gitignore` 不会清除已经提交的历史。
- 2026-11-24 做过有界 Live 验证（`scripts/smoke.ps1 -Live` 与 `scripts/live-phase2.ps1 -Live`）：真实后端上的领取、验收、复核、跨任务 session 复用、usage、watch 发现与 `stop`/`--resume` 均已跑通。真实后端的取消与中断恢复已于 2026-11-27 在 opencode v2.4.2 上验证（走 [ADR-0007](docs/adr/0007-fenced-execution-and-evidence.md) 的路径：控制器取消自己仍握着句柄的子进程树）：`scripts/live-stop.ps1 -Live` 在编码套餐的 flash 模型上 **LIVE STOP PASS（17 项）**（四个 worker 回合）——`stop --now` 打断回合和验收命令，服务确认被切断的会话已 idle，任务回到 `open`、`retries` 不动，`watch` 退出 0，重跑用新会话，没有进程残留。控制台里按 Ctrl-C 的实测同日记录在上文「taskctl watch / stop」的退出码段落与「排障」。其余结论仍以离线测试为据。2026-11-26 在 opencode 2.4.2 上用编码套餐的模型验证了模型拒绝这条线（真实拒绝、整体故障停止与退出码 3、改好配置后不靠 `retry` 恢复、被拒的复核自己恢复）；同一天 `scripts/smoke.ps1 -Live` 因后端默认模型不可用而失败（脚本不指定模型），`scripts/live-phase2.ps1 -Live` 还没有在 2.4.2 上重跑。

## 设计文档

见 `docs/adr/`（任务存储与文件锁、独立编排器、会话链交接、TypeScript 薄编排器、验收门、车道与验收方式、worker 上下文与记忆召回、预算护栏等决策记录）。

**有意没做的事、以及已交付功能的边界**单独记在 [docs/backlog.md](docs/backlog.md)：`tolerate` 词表缺哪些、降级链没有退避、`retry` 的会话死循环等。那份文件其余部分停在 2026-11-17，开头有一节 2026-11-24 的对账，列出已核实不再成立的条目。做新功能前先看那份——避免把"没做"当成"忘了"，也避免把当前实现信得比实际更足。
