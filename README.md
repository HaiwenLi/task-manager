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
| `parallel` | number | `2` | 同时执行的任务数；同一工作目录仍只跑一个 |
| `maxReviewRounds` | number | `2` | 复核失败几轮后 `blocked` |
| `reviewerModel` | string | 后端默认 | 复核会话单独用的模型；**不设置时用 opencode 自己的默认模型**，不会继承 `model` |
| `reviewerEffort` | string | 同 `effort` | 复核会话的努力档 |
| `modelFallbacks` | string[] | `[]` | 模型被 provider 拒绝时依次换用的模型（`provider/model`）。排在任务 `model`（或配置 `model`）之后；没有主模型时整条链为空 |
| `reviewerModelFallbacks` | string[] | `[]` | 复核会话的降级链，排在 `reviewerModel` 之后；没配 `reviewerModel` 时整条链为空 |
| `opencodeBin` | string | `opencode` | opencode 可执行文件。**Windows 下 `.cmd` shim 无法被 `shell:false` 直接启动**，应在本地配置实际 `.exe`，不要提交机器专属路径 |
| `chromeBin` | string | 自动探测 | 渲染验收用的浏览器可执行文件；也可用环境变量 `TASKCTL_CHROME`。找不到时渲染任务 `blocked`，不会当成通过 |
| `renderViewports` | string[] | `["1440x900","390x844"]` | 渲染验收要过的视口列表 |
| `artifactIgnore` | string[] | `[]` | 验收前后摘要**忽略的路径或 glob**（相对 workdir；`*` 不跨目录、`**` 跨目录、`?` 单字符，不支持字符类与取反，大小写敏感）。命中的文件——以及只装着命中文件的目录——不参与 drift 判定；见下文「验收的自生成产物」 |

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
| `status` | ✓ | 生命周期：`draft`（等签字）/ `open`（待领取）/ `running`（执行中）/ `review`（复核中）/ `awaiting-human`（等放行）/ `done`（完成）/ `blocked`（需人工介入） |
| `model` | | 本任务模型（`provider/model`），覆盖配置兜底 |
| `effort` | | 本任务努力档（如 `high`），覆盖配置兜底 |
| `acceptance` | | 验收命令（完整 shell 命令行，在 `workdir` 下执行）；退出码 0 且所有权/任务定义/产物一致才进入复核。缺失但有 `criteria` 时跳过命令、由复核判定（记录 `acceptance-skipped`）；两者都缺 → `blocked` |
| `criteria` | | 验收标准列表，`C1 …` 编号；复核逐条判定，这是复核的唯一判据 |
| `complexity` | | `simple`（不停下等签字）或 `complex`（默认，出稿等签字） |
| `risk` | | `high` 时复核通过也要人工 `accept` |
| `workdir` | | 本任务的工作目录（相对配置里的 `workdir`）；同一目录同时只跑一个任务 |
| `depends_on` | | 依赖的任务 id；全部 `done` 才会被领取，成环直接报错 |
| `human_check` | | `true` 时无论风险都要人工放行 |
| `tolerate` | | 声明**容忍的外部变更种类**：`external_cell_change`、`new_column`、`deleted_row`、`extra_file`。只写这几个值，写错直接报错（打错字不该变成"声明了但什么都没容忍"）。见下节 |
| `quick` | | `true` 表示**没出 spec、没跑澄清会话**，意图原文就是定义。`taskctl add --quick` 写入；因为没写下任何可核对的判据，这种任务不会自己收尾（见「车道与验收方式」） |
| `verify` | | 谁来判"做完了"：`human`（默认，独立复核判）、`mechanical`（验收命令退出码判）、`render`（无头浏览器判）。进 `definitionDigest`，中途改会作废本次尝试 |
| `render_targets` | | `verify: render` 时要打开的页面，相对 `workdir`；`verify: render` 却没有这一项会直接报错 |
| `review_rounds` | ✓ | 复核失败次数，由 worker 维护 |
| `sessions` | ✓ | 会话 id 链（按时间顺序追加），由 worker 维护 |
| `retries` | ✓ | 失败尝试计数，由 worker 维护 |

辅助文件：`tasks/<id>/lock.json`（所有权与心跳）、`attempt.json`（执行事实与不确定状态）、`acceptance.json`（命令、验收模式、时间、输出、身份摘要与实际使用的模型）、`review.json`（复核判决、模型、被容忍的外部变更与实际注入的改动证据）、`render.json`（渲染验收的逐视口测量与截图路径）、`evidence/`（截图）、`models.json`（模型降级链的当前位置）、`done.requested`（完成请求）、`sessions/0001-handoff.md`（交接笔记）。运行时记录不拥有任务状态，Markdown 仍是唯一状态源。

## 车道与验收方式

两个问题分开答：**进来的时候要不要澄清**（车道），和**出去的时候谁说了算**（`verify`）。

| 车道 | 怎么进 | 起点 | 代价 |
| --- | --- | --- | --- |
| 标准 | `add "<意图>"` | `draft`，澄清会话出 spec + criteria，等人签字 | 一次模型调用 + 一次签字 |
| 简单 | `add --simple` 或意图里说「简单任务」 | `open`，仍出 spec | 符号少一次签字 |
| 快速 | `add --quick` | `open`，**不出 spec、不跑澄清**，意图原文就是定义 | 没有写下来的判据，所以它不会自己收尾 |

三条道都必须能被人或机器判"做完了"，判据由 `verify` 指定：

- `human`（默认）：独立复核会话逐条判 `criteria`。适合结论要读、要解释的工作。
- `mechanical`：`acceptance` 命令的退出码就是判决，通过即 `done`，不再起复核会话。适合"测试全绿/构建通过"这类工作。
- `render`：`taskctl verify`（worker 在收尾时也会自己跑）用无头浏览器打开 `render_targets` 里的每个页面，逐个视口要求：**能画出来、有可读内容、不横向溢出、没有未捕获异常**。截图留在 `tasks/<id>/evidence/`。适合"产物是给人看的"工作——复核读的是代码和 diff，看不见白屏和溢出。

`verify: render` 找不到浏览器时任务 `blocked`，并写明原因：**没跑成的检查不算通过**。

**升级只会往上走。** 一个快速/简单任务在执行中可能被证明"不是那么简单"，两条触发线都是运行期事实，不靠事前猜：

- 执行者在自己回合里写下 `ESCALATE: <理由>`；
- 会话回合用尽或上下文告满需要交接（说明这事一次没干完）。

触发后本次尝试**照样可以继续**，但不再能用自己产出的证据收尾——一律进复核。任务文件里的 `verify` 不改，`definitionDigest` 不变，所以升级本身不会让正在跑的尝试作废；理由记进 journal（`event: escalated`），`board`/`report` 可查。这个方向是刻意的：执行者能要求"多看一道"，不能要求"少看一道"。

## 复核流水线

一条任务从想法到可信结果的完整路径（设计见 [ADR-0008](docs/adr/0008-review-stage-and-human-attribution.md)）：

```
taskctl add "<意图>"        澄清会话出 spec + criteria；complex 停在 draft 等签字
taskctl spec --task <id>    看稿
taskctl approve --task <id> 签字 → open
taskctl run                 并发执行 → 验收命令 → 独立复核 → done / 返工 / 等放行
taskctl board               总台账（同时重写 .taskctl/board.md，可用浏览器打开）
taskctl report --task <id>  单任务证据页
taskctl accept|reject       人工放行或打回（reject 要说明是哪个环节的问题）
taskctl audit --verdict …   抽查已完成的
taskctl metrics             哪个环节在拖后腿
taskctl learn --note "…"    记一条偏好（原话 → 改法），下次澄清会读到
taskctl template --type …   看某类任务的必答/可推/补问模板
```

要点：

- **复杂度**：意图里明说「简单任务」或加 `--simple` 才会跳过签字；不说就按复杂处理。简单任务同样出 spec，只是不等签字。
- **复核是独立会话**：新会话、不给执行者的对话，只给 spec、验收命令与结果、产物摘要、交接笔记、日志尾部、工作区改动清单（`git status --porcelain` 与 `git diff --stat`，各截断至 200 行、超长标注），以及本次执行的时间窗口。输出必须是 JSON；解析不了按 `unclear` 转人工，不会当成失败去重跑。实际注入的改动清单原文记在 `review.json` 的 `evidence` 字段，复盘复核误判时可以核对 reviewer 当时到底看到了什么；非 git 工作目录会显式标注「不可用」而不是中断复核。
- **容忍的外部变更**：任务可以声明 `tolerate`，告诉复核"这些差异不是我干的"。声明之外的结构变化（删列、改表头含义等）仍按原规则判 fail；本任务自己该写的内容没写全，**不能**拿外部变更当挡箭牌；涉及交付内容（该写的行、该改对的单元格）时判不出先后的，也按本任务的问题处理。被容忍的差异不做静默处理：写进 `review.json` 的 `externalChanges`、journal 记一条 `verdict external=N`、`report` 里逐条列出，`taskctl accept` 放行前也会打印一遍（人工闸门是最后一道）。为什么需要它：真跑过的表格任务里，运行期间别人加了 1 列、删了 1 行、改了 4 个单元格，复核按"零附带改动"判 fail，白跑 20 分钟一轮。
- **定义不能被被审对象自己改**：`tolerate`、`criteria`、`risk` 等都属于任务定义，进 `definitionDigest`。执行回合里改了它（哪怕是 worker 自己 shell 出去改 frontmatter），本次验收直接作废、任务 `blocked` 等人工重新确认——否则"给自己放宽判定标准"就成了合法动作。复核判决里记录的是**当时那份声明**，事后把 `tolerate` 收窄不会让旧判决看起来像是被允许过更多。
- **返工**：复核不过会写一条 `review-failed` 笔记并回到 `open`；连续 `maxReviewRounds` 轮（默认 2）后 `blocked`。
- **人工节点**：`risk: high`、`human_check: true`、以及复核无法判定的任务停在 `awaiting-human`，只有 `accept` 能放行。
- **归因**：`reject`/`audit` 都会记录问题出在 `clarify`（标准本身错）、`worker`（没做到）、还是 `reviewer`（漏判），`metrics` 按环节汇总。

### 偏好档案

`.taskctl/profile.md` 是一份可读、可手改的 Markdown，前面是说明，`## 观察` 下每条一行：

```
- 2026-11-16  不要问我能从仓库推出来的事
- 2026-11-16  交付物先给结论再给证据
```

`taskctl learn --note "原话 → 改法"` 追加一条；`taskctl add` 会把它整段注入澄清提示词。它不是模型训练，是「把规则写下来，下次先按它走」；写错了直接删那一行。

## 运行

### taskctl run — 派发

```bash
npx tsx src/main.ts run [--config taskctl.json]
```

按文件名顺序处理 `open` 任务：领锁 → 独占工作目录 → 持久化执行身份 → `running` → 会话/交接 → 完成请求 → 验收。全过程打印 `[<id>] <状态> [详情]`。缺少验收时输出 `acceptance-skipped` 并阻塞待审。`running` 孤儿任务只有已确认上一执行结束才能恢复；活跃/不确定记录或缺少执行身份的旧任务会阻塞，不盲目重跑。

同一实际工作目录（含路径别名）不可并行执行；共享 Git common directory 的 worktree 暂按串行处理。当前不自动创建/合并 worktree。验收前后对源码产物做摘要；验收命令改变产物会要求复核，不会把旧检查套到新版本。摘要排除 Git 内部、依赖目录及任务运行时目录（另可用 `artifactIgnore` 忽略任务自产物的路径，见下节）；详见 `src/workspace.ts`。

#### 验收的自生成产物：`artifactIgnore` 与 `TASKCTL_ACCEPTANCE_MODE`

有些任务的验收命令会**按 spec 生成产物**——`report.json`、`timing.json`、`perf.json` 之类。这类命令一旦在验收门里重新生成文件，就被自己的写入判成 drift（`acceptance evidence invalidated by … artifact drift`）。两条互补的解法：

- **`artifactIgnore`（路径级忽略）**：`taskctl.json` 里声明验收命令**自己会写**的路径。命中的文件不参与验收前后哈希，重写它们不算 drift；未命中的路径照常判定。适合「产物本来就是任务交付物、每次运行都会重写」的场景。

  ```json
  { "artifactIgnore": ["reports/*.json", "timing/**"] }
  ```

  语义：相对 workdir 的路径或 glob（`*` 不跨目录、`**` 跨目录、`?` 单字符；`\` 与 `/` 等价；不支持 `[abc]` 字符类和 `!` 取反；大小写敏感）。一个只装着被忽略文件的目录整体不注册——验收命令新建 `timing/` 并写入被忽略的 JSON，摘要不变。能匹配整个工作区的模式（如 `**`）在配置处直接报错，不让 drift 检查被无声架空。**不要把源码路径放进来**：这个开关绕过的是「验收命令自己写自己」的判定，不是「任务该改的没改」的判定。

- **`TASKCTL_ACCEPTANCE_MODE=generate|check`（生成/检查分离）**：taskctl 给验收命令注入这个环境变量。**门（taskctl 跑的验收）注入 `check`**——命令只读不写，`artifactBefore == artifactAfter` 自然成立；**worker（agent 干活时自跑验收命令）不注入或注入 `generate`**（默认值）——命令可以生成/刷新产物，写入发生在尝试窗口内，不进摘要比较。

  推荐写法：验收命令开头判断模式——

  ```bash
  #!/bin/sh
  if [ "$TASKCTL_ACCEPTANCE_MODE" != "check" ]; then
    node scripts/build-report.js   # generate：产出 report.json / timing.json
  fi
  node scripts/verify-report.js    # check：只回读校验，退出码即判决
  ```

  推荐流程：worker 在会话里以 generate 自跑一次验收命令产出报告（或把产物路径进 `artifactIgnore`），再 `taskctl done`；门以 check 重放同一命令，零写入、按退出码判决。两条路子可以单独用也可以叠加：`artifactIgnore` 管「写不写都行」，`check` 管「门内不许写」。门侧的 mode 会记进 `acceptance.json`（`mode: "check"`）。

  边界：taskctl 不验证命令在 check 模式下**真的**没写文件——写了又没进 `artifactIgnore`，照样判 drift 拦下（fail closed）。check 模式的合规是命令作者的责任。

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

**`task definition changed during the attempt`** —— 执行期间 `tasks/<id>.md` 的定义字段（`criteria` / `tolerate` / `risk` / `human_check` / `depends_on` / `acceptance` / `model` / `workdir`）被改过，本次验收作废。这是有意的：定义是人工批准的，执行者不能一边干活一边给自己换判据。核对是谁改的、改成什么，确认新定义可以接受后，用 `taskctl retry --task <id>`（它只对已 settled 的 attempt 生效）重开——这一步就是人工对新定义的确认。

### blocked 之后的恢复路径

```bash
taskctl reconcile --task <id>   # 只读诊断：lock / attempt 阶段 / 归属路径 / 匹配预留 / 结论
taskctl retry --task <id>       # 归档旧证据后重开；仅在 attempt 已 settled、无活跃锁、无匹配预留时执行
```

`reconcile` 只报告不改状态，结论是 `retry-allowed` / `manual-review` / `already-terminal` 之一；归属路径无法确定时一律 `manual-review`。`retry` 会拒绝任何"还可能有执行在跑"或"归属路径不确定"的情况，并把 `attempt.json`、`acceptance.json`、`review.json`、`models.json` 移入 `tasks/<id>/archive/<时间戳>/`、重置 `retries` 与 `review_rounds`、写一条 `human retry` 日志。

**taskctl 不按记录的 PID 杀进程。** PID 会被复用，`attempt.json` 里的 pid 不能证明它仍属于那次执行（ADR-0007）。需要停止执行时，由人核实进程身份后自行处理；执行停止未确认（`attempt.phase` 不是 `settled`）的任务，`retry` 一律拒绝，仍需按下面的手工流程归档证据。

**worker 崩溃 / 不确定执行** —— 先核实原控制器、子进程树与后端会话均已停止，再检查产物。保留证据后，人工归档旧 `attempt.json` 和对应工作目录预留，再按需重开任务。不能仅按旧 PID 杀进程、删任务锁或改 `status` 后自动重跑。互斥目录 `.mutation.lock` 若因崩溃遗留也必须先确认原操作已停止，不能按时间强抢。

人工修改共享预留注册表之前，先停止所有使用该注册表的 taskctl 控制器；仅处理已核对身份的那条预留及其本地标记，不清空其他任务的记录。当前没有自动“强制恢复”命令。缺少验收造成的普通待审则补上验收并重开任务即可，不需要清理已正常释放的预留。

**回合 / 验收超时** —— 单回合默认 30 分钟、验收 10 分钟。请求停止并确认停止后才允许计失败重试；无法确认则阻塞并保留工作目录预留。OpenCode CLI 被杀不代表其独立后端会话已停，因此 OpenCode 回合被中断按不确定处理，须人工核实。未做真实后端取消验证。

**provider 拒绝（429 / 配额 / 鉴权 / 5xx）** —— 这类失败说明回合根本没开始干活，adapter 会把它标成 `failure: "provider"`：没有配降级链时 worker 计一次可重试失败并继续（达到 `retryLimit` 才 blocked），复核阶段同样按失败重试而不是转人工。它与"执行停止未确认"是两回事，不会把任务卡进需要人工对账的状态。

**模型降级链** —— 配了 `modelFallbacks` / `reviewerModelFallbacks` 时，被 provider 拒绝的那一次不会去花重试额度，而是把这一回合交给链上的下一个模型：换个账号就能继续，不必等到 `retryLimit` 用光才 blocked。换模型同时是**会话边界**：上一个后端创建的会话不会交给下一个模型续，被拒的回合也不记进 `sessions`（它没干活）。复核被拒时在复核阶段内部换模型重试，不会把任务退回 worker 重跑——非幂等任务（写表、移文件）不能为了重试一次复核而被执行两遍。

当前选中的模型记在 `tasks/<id>/models.json`，所以重试时不会又先撞那个已经打满的模型；`taskctl retry` 会把它和旧证据一起归档，回到链首（配额恢复后手动重开就从主模型重来）。链走完才算失败，链的长度由配置决定，因此仍然是有限的。

`models.json` 是提示性状态不是证据：**读**不到、读坏了、或者记的位置属于另一个模型（比如主模型被改过），一律按"从链首开始"，绝不因为一个缓存文件把已结算的回合改成不确定；**写**不进去则不算换成了，按普通重试计失败——位置本身是"下次别再撞同一堵墙"的唯一凭据，没记下来就不能假装已经换过。

**Windows 下 spawn opencode 失败** —— npm 全局安装的 `opencode` 是 `.cmd` shim，`shell:false` 无法启动。在 `taskctl.json` 里把 `opencodeBin` 指向真实 exe（见上文表格）。

## 测试

```bash
npm test                # 全部单元/集成测试（不碰真实 opencode）
npx tsc --noEmit         # TypeScript 检查
TASKCTL_E2E=1 npx vitest run tests/e2e.smoke.test.ts   # E2E 冒烟（真实 opencode）
```

E2E 前置：本机 opencode 已安装并登录；Windows 下测试会自动解析 npm 全局 opencode 背后的真实 `.exe`（也可用环境变量 `TASKCTL_OPENCODE_BIN` 覆盖）。它会在临时目录里发起真实 agent 会话并消耗模型额度。

整条流水线的真实冒烟（临时项目、自带 taskctl shim、跑完打印 report）：

```powershell
.\scripts\smoke.ps1          # 只准备环境，不调模型
.\scripts\smoke.ps1 -Live    # 真跑一次，通过时打印 SMOKE PASS
```

它会验证：agent 在真实会话里干活 → 验收命令 → 独立复核 → `done`。2026-11-16 在本机 opencode 2.3.0 上跑通。

## 凭据与隐私

- 通过 agent CLI 在本地配置模型凭据；不要把 API key、访问令牌或认证头写进任务、示例或仓库配置。
- 示例使用相对路径；机器专属可执行文件路径仅保存在本地，不提交到 Git。
- `.env`、密钥文件、私人记忆和实际任务运行数据默认忽略；`tasks/example.md` 是公开示例，不含真实任务记录。
- `attempt.json`、`acceptance.json`、交接笔记和模型输出可能含任务内容、运行路径或敏感数据；提交附件或共享日志前另行检查。`.gitignore` 不会清除已经提交的历史。
- 当前验证为离线测试，不代表真实后端取消、科学有效性或生产部署已经验证；中断恢复见 [ADR-0007](docs/adr/0007-fenced-execution-and-evidence.md)。

## 设计文档

见 `docs/adr/`（任务存储与文件锁、独立编排器、会话链交接、TypeScript 薄编排器、验收门、车道与验收方式等决策记录）。

**有意没做的事、以及已交付功能的边界**单独记在 [docs/backlog.md](docs/backlog.md)：`tsc` 在本机为何跑不了、`tolerate` 词表缺哪些、降级链没有退避、`retry` 的会话死循环等。做新功能前先看那份——避免把"没做"当成"忘了"，也避免把当前实现信得比实际更足。
