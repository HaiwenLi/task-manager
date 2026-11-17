# 调研：EGM（Elephant-Goldfish Model）审查机制 — 可引入 task-manager 的部分

Date: 2026-11-17
Scope: 对 EGM 插件（`google/elephant-goldfish-model`，安装根 `<plugin-root>/skills/*`）做源码级机制分析，判断「它为什么能独立地挖出高质量审查结果」，以及哪些机制值得引入 task-manager 的复核管线（`src/review.ts` 及周边）。

性质：本文是本地源码阅读的结论，含作者判断与建议，**未运行任何测试、未做双盲对照**。EGM 官方也明确"review 不替代测试与人类判断"（`README.md:121`）。

---

## 0. 一句话结论

**EGM 不是靠 scale（并行多采样）挖出好结果的——恰恰相反，它有至少四条规则专门用来对抗多采样的随机性副作用。** 真正的杠杆是七个正交机制：上下文隔离、视角分区、证据强制、反谄媚约束、人格/标准分离、诚实的失败语义、收敛协议。你的直觉（"单纯 scale 做不到"）在数学上成立：N 个同构 reviewer 是同一分布的 N 次独立采样，**相关的盲区永远是盲区**，采样再多也推不出分布之外的东西。EGM 用「构造性的视角覆盖」替代「随机性的采样覆盖」。

---

## 1. EGM 对抗的四个失效模式（架构文档开宗明义）

来自 `docs/designs/architecture.md:20-36`，EGM 每个机制对应至少一个：

| # | 失效模式 | EGM 对策 |
|---|---|---|
| F1 | 幻觉级联与上下文污染（同一线程面试→写稿→写码，用自己累积的假设验证自己） | M1 上下文隔离 |
| F2 | 杂草综合症（跳过架构高度直接写码，绕过 YAGNI 与复用检查） | M2 视角分区 + zoom-out 标准 |
| F3 | 聊天倾倒（长文档灌进对话流，劣化上下文） | Artifact-First 协议 |
| F4 | 文档漂移（设计文档随代码烂掉） | drift-report 技能 |

task-manager 的对应物：F1/F3 它已经处理了（复核是独立会话、产物写文件不进对话）。F2/F4 不在 task-manager 的管辖范围（它不产出设计文档）。**真正的移植重点是 F1 的强化——EGM 把"独立"这一件事做到了 task-manager 还没到位的深度。**

---

## 2. 七个机制详解

### M1 上下文隔离 — 独立性是架构属性，不是提示词属性

**这是全部设计的地基，也是唯一的"不是 scale"的核心。**

EGM 在 `architecture.md:193-197` 的 Alternatives Considered 里，**明确拒绝了你今天的做法**：

> *Alternative*: Run review prompts sequentially within the same chat session.
> *Rejected*: Severe context degradation and confirmation bias; **the model validates its own mistakes**.

关键论证：在同上下文里写「请保持独立、批判性思考」是**无效**的——模型无法"不知道它已经知道的东西"，作者立场会持续污染注意力。因此独立性必须用**独立的 context window 从物理上保证**，而不是用措辞恳求。

更精细的不对称设计：
- **Elephant 有记忆**（写稿需要历史；CONTEST 抗辩需要历史证据）
- **Goldfish 无记忆**（发现盲点需要天真）

抗辩需要历史，挖掘需要无知——两份记忆各干各的活，不是"同一份记忆跑两遍"。

> task-manager 现状：`review.ts` 已经是独立会话（`startReview` 起新 session，`buildReviewPrompt` 不给 worker 对话），这一点已经对齐 EGM。**无需再动。**

### M2 视角分区 — 覆盖工程，不是采样

9 个 persona（`agents/*.md`），每个带一段**命名过的失效清单**（audit vectors）+ 严格输出格式 + **允许的严重级范围**：

| Persona | 负责的失效空间 | 硬性动作 |
|---|---|---|
| zoom_out（怀疑论架构师） | YAGNI、过早优化、重复造轮子、高度跌落 | 提出"新组件"时 **MUST code search** 验证复用 |
| comprehension（天真读者） | 未定义术语、隐含前提、理解断裂 | **先复述再挑刺**（见 M3） |
| design_critic | SPOF、扩展极限、失效恢复、权衡论证 | 逐条对照标准 |
| codebase_details | 文档 vs 真实代码 | 逐个对照路径/签名（防幻觉 API） |
| inventive_catalyst（TRIZ） | 虚假妥协、伪矛盾 | 只许报 Major\|Nit；**允许报「无矛盾」** |

关键细节：
- **组合按阶段配**：Stage5 = zoom_out + inventive（战略层）→ Stage7 = design + structural + style（spec 层）→ Stage9 = readiness + codebase + style（可实施层）。透镜与审查高度匹配，不是一把梭。
- **覆盖是构造出来的**：每个 vector 是可检查的命名项，不是"你看着办"。通用 reviewer 是**随机采样**失效空间；persona 是**划片承包**。
- **反幻觉发现**：inventive_catalyst 明文规定"如果不存在真矛盾，必须输出 No false compromise detected，不得编造"——为了交差硬找问题，是审查最大的噪声源之一，EGM 直接在提示词里封死。

> task-manager 现状：`review.ts` 只有一个通用 reviewer，无 audit vectors、无 severity 分层（defects 是平铺 string[]）。**这是 G1/G4 缺口，见第 4 节。**

### M3 证据强制 — 把 vibe 检查变成机械测试

最漂亮的是 comprehension 的 **paraphrase 协议**（`comprehension.md:37`）：reviewer 必须先用自己的话写「这份文档提议什么」+「据本文档，现有系统是什么」，**复述本身就是产物**——作者拿意图对照复述，对不上的地方就是文档病灶。把「写得清楚吗」这种无法回答的问题，换成「复述是否正确」这个可判定的测试。

其他证据强制：
- zoom_out 必须搜代码验证复用主张（不空喊"有现成的"）
- codebase_details 逐个对照文档引用与真实代码签名
- 每条 finding 强制四元组：severity + 行号 scope + 差异描述 + 理由

> task-manager 现状：`buildReviewPrompt` 要求 evidence 字段，但**不约束 evidence 必须引用具体产物/文件**，也不要求先复述判据。reviewer 可以写"检查过了，符合要求"这种无证据的通过。**这是 G2 缺口。**

### M4 反谄媚约束 — 对抗 RLHF 的礼貌默认

`egm-review/SKILL.md:43-69` 的 11 条执行约束，全部指向同一个敌人：模型被训练出来的**顺从性默认**。核心几条：

- Never agree by default / critique first / 每个提案必须附**最强反方论证**（"用户没看到什么？")
- 禁赞美形容词（brilliant/great/smart/perfect）
- 禁道歉（被指出问题时输出修正后的技术逻辑，不输出 I'm sorry）
- "同意必须挣来"——只有当想法扛过了严格的客观审视才同意

> task-manager 现状：`buildReviewPrompt` 完全没有这类约束。一个被 RLHF 训练成"礼貌顺从"的 reviewer，倾向给 pass。**这是 G3 缺口。**（这不是引入"敌意"，而是引入"默认压力测试"的立场，与 taskctl 已有"从严"精神一致。）

### M5 人格与标准分离 — 标尺是可审查的工件

persona = 谁在看；standard = 什么及格线。5 份版本化 rubric（`resources/document_standards/*.md`）按次显式配对（如 `Standards: {"egm-design":"feature-spec-standard"}`）。标尺独立存在 → 可以被评审、被复用、被测试。

副产品：EGM 每个 skill 自带 `test_scenarios.yaml` 评测基准，**审查模型本身跑 precision/recall**。"挖得好"有一部分是因为它对着评测集迭代过，而不是凭空"更聪明"。

### M6 诚实的失败语义 — 一条规则杀掉 scale 最危险的模式

合成层（`synthesizer.md:31,41`）的规则：**失败的 reviewer 记 `not run`，永远不许记成「零发现」**；每份报告必须带 Reviewer Status 表；必要时每个 persona 跑 A/B 两个实例补召回。

没有这条规则，scale 方案里死掉的 reviewer 看起来就是"全部通过"——这是并行审查最隐蔽的坑。

> task-manager 现状：`review.ts` 的 `degraded()` 把退化成 unclear 转人（不是当 pass），方向一致，但**没有"多 reviewer 各自成功/失败分别记录"的概念**（因为它只有单个 reviewer）。引入多透镜后这条必须跟进来。

### M7 收敛协议 — 管理隔离带来的方差（深水区）

新鲜采样意味着**每轮发现的东西都不同——这是特性不是 bug**。所以 EGM 不用"某轮零发现=通过"，而是（`review-loop/SKILL.md:157-187`）：

```
settled（平息）  ：contested 或 accepted-risk 的发现永久平息，
                   同 scope 同问题再提不重开（抑制噪声复现）
fixed（不复息）  ：修复 ≠ 平息。同问题修复后再现 = 修复失败，重开
clean round     ：无未平息的 Blocker/Major 且无 not-run reviewer，
                   且在应用本轮修复【之前】判定
converged       ：连续两轮 clean（"一轮不够，下一个新鲜 reviewer
                   可能在同一段文本找到不同缺口"）
cap 5 轮 + churn：新发现恰好落在刚修复的 scope、回退修复即解 → 停，交人
```

外加 turn-taking：轮与轮之间必须有人类闸门，循环不许自转。

**「两轮 clean 才收敛」这一条是统计学**：独立采样有方差，置信度要求重复的独立通过。这是 pure-scale 方案最容易忽略、也最容易假通过的环节。

> task-manager 现状：`maxReviewRounds=2` **纯按次数**判定，无 settled/fixed 状态、无 clean-round 语义、无 churn 检测。后果：两轮因不同理由不通过 → blocked，真问题与采样噪声不可区分；或两轮"碰巧都过" → 假通过。**这是 G5 缺口，也是移植价值最高但成本最高的一块。**

---

## 3. 裁决引擎（resolve）— 发现被审判，而不是被聚合

EGM 的 `egm-resolve` 对每条 finding 四分类（`resolve/SKILL.md:56-82`）：

- **PROPOSE FIX**：批判有效，给精确替换串
- **CONTEST**：批判无效或误读，**必须引用 reviewer 能读到的证据**（"This was intentional" 不是证据）
- **ESCALATE**：批判无效但只有零上下文 reviewer 缺的知识能反驳 → 交给用户，不私下抗辩
- **DECLINE**：Nit，记录不修

硬规则里最值得抄的三条：
1. **理解缺口不可抗辩**——fresh reader 读不懂 = 文档缺上下文，"你不懂"不能当抗辩理由。
2. **不许改 severity，只能 contest**——你觉得 Blocker 是 Nit，走 contest 说理由，不是偷偷降级。
3. **"你写了被审文档，想抗辩的愿望不是证据"**——这条直接把作者 bias 钉死。

> task-manager 现状：没有"审判"环节。reviewer 判 fail → 直接回 open 返工，worker（或人）没有机会 contest「这条标准其实判错了」。结合 taskctl 已有的 `reject` 归因（clarify/worker/reviewer 三段），**contest/ESCALATE 正是把 reviewer 判错的场景结构化出来的机制**，值得有。

---

## 4. task-manager 的缺口清单（按移植价值排序）

先给 credit——task-manager 有几样东西**比 EGM 还硬**：

| task-manager 已有 | EGM 对应物 | 谁更强 |
|---|---|---|
| 复核独立会话，不给 worker 对话 | Goldfish 隔离 | 打平 |
| `definitionDigest`：被审者改判据 = 本轮作废 | **EGM 没有**（靠人守纪律） | task-manager 更强 |
| 单向升级：只能多看，不能少看 | EGM 无此不变量 | task-manager 更强 |
| 解析失败 → unclear 转人，不烧重试 | not-run 诚实语义 | 打平 |
| 归因三段 clarify/worker/reviewer | EGM 无系统化归因 | task-manager 更强 |

**真正的缺口**：

| # | 缺口 | 现状 | 后果 |
|---|---|---|---|
| G1 | 单一通用 reviewer，无 audit vectors | `buildReviewPrompt` 一个通用角色 | 盲区相关，发现质量靠运气 |
| G2 | 无证据强制 | evidence 字段无格式约束，不要求引用具体产物 | "看着还行"式通过 |
| G3 | 无反谄媚条款 | 无 | reviewer 客气=摆设 |
| G4 | defects 无 severity | `string[]` 平铺 | 挑剔与致命混在一起，无法"nit 不阻塞" |
| G5 | 无收敛语义 | `maxReviewRounds=2` 纯计数 | 真问题与采样噪声不可区分 |

---

## 5. 引入路线（三层，成本递增）

### P1 提示词层（只改 `buildReviewPrompt` + verdict schema，半天级）

- 反谄媚条款 + 证据强制（evidence **必须引用具体产物路径 + 检查了什么**，引不出 → 该条判 unclear）
- paraphrase 步骤：先复述"你理解的任务和判据"，复述错 = 判据问题，天然喂给归因 clarify
- defects 分 blocker/nit，nit 不 fail

### P2 收敛层（动 review.json / journal / worker，周级）

- findings 稳定 id + settled 状态；第 2 轮注入 settled 清单
- blocked 判定改语义：churn 或连续非 clean → blocked，替代纯计数
- 引入 contest/ESCALATE（对齐现有 reject 归因）

### P3 透镜层（risk 分级 × 多 lens，量力而行）

- `verify:human` + `risk:high` → 2-3 个透镜 reviewer（理解复述 / 产物对照 / 漂移检查）+ 去重合成
- mechanical / render 车道不加（客观门不需要透镜，避免过度工程）
- persona 文件挂在现有 `template --type` 体系上；标准 = 按类型的审计向量清单

### 不建议抄的

- **五阶段全拓扑**：那是设计文档审查的结构（Zoom Out→Comprehension→Critic→…），taskctl 审的是"产物 vs criteria"，硬搬成仪式会变成五轮空转。
- **TRIZ lens**：对产物审查是噪声；真要挂，挂在 clarify 出 spec 的环节。
- **synthesizer 子代理层**：扁平派发够用，EGM 自己也允许 direct dispatch。

---

## 6. 关于"另一个 AI 的调研"的判断框架

那份材料不在此仓库可检索的文件系统里（session 正文存储位置未定位到含 EGM 内容；可能属于另一个 agent 引擎或未落盘）。**建议用下面这个框架核查任何一份 EGM 调研，判断它对不对：**

**对的说法，通常包含且自洽于以下事实**（这些是本源码阅读确认的）：
1. 核心是「隔离上下文」而非「并行」；parallel 只出现在 review swarm 一处，且有 not-run 语义兜底。
2. 反谄媚 + 证据强制是明确的、可读到的硬约束，不是氛围。
3. 收敛用「连续两轮 clean」，且明确写「一轮不够」。
4. 裁决引擎有 contest/ESCALATE 且抗辩必须引 reviewer 可读证据。

**常见的错（看到就打问号）**：
1. "EGM = 多个 agent 并行审查 + 投票" —— 把 scale 当本质，漏掉全部正交机制。
2. "EGM 的设计是模型能力差异" —— 它不要求 reviewer 用更强模型，杠杆全在协议层。
3. "审查结果是客观真理" —— EGM 自己声明不替代测试与人类判断。
4. "直接照搬五阶段流程就能提高 taskctl" —— 审查对象不同（设计文档 vs 产物），流程不可移植，机制可移植。

---

## 7. 结论

- **EGM 挖得好的本质**：用上下文隔离制造独立性（架构级），用视角分区制造覆盖（而非采样），用证据强制和反谄媚约束制造"不能敷衍"，用收敛协议管理隔离带来的方差。
- **对 task-manager 的最高价值移植**是 P1（提示词层）——便宜、立刻改变复核质量，且不动状态机。P2/P3 涉及状态机，需单独设计。
- **下一动作建议**：P1 先行，输出一个 `buildReviewPrompt` v2 + 对照测试（现有 `tests/` 里 review 相关用例跑绿），再决定是否进 P2。

---

## 8. 独立复核脚注（2026-11-17 二次核查）

对第 2–7 节结论做一次独立复核，标注"结论对但需加脚注"的四处，以及"原分析缺、需补"的三点。

### 四处需加脚注

1. **"M1 上下文隔离是全部地基"——对，但对 task-manager 是已达成项。**
   taskctl 的复核已经是独立会话（`review.ts` 的 `startReview` 起新 session，`buildReviewPrompt` 不给 worker 对话）。移植重点是 M2/M3/M4，不是 M1。把精力花在 M1 上是重复建设。

2. **"task-manager 有几样比 EGM 还硬"的表——漏了一条更硬的。**
   taskctl 有 `verify: mechanical`（客观退出码）与 `verify: render`（无头浏览器逐视口裁决）两种**非模型裁决**方式。这是 EGM 完全没有的第三种裁决通道（EGM 只有人 + Goldfish）。客观门不靠模型判断，天然免疫谄媚/盲区/幻觉，是 taskctl 相对 EGM 的结构性优势，应写进对照表。

3. **"P1 半天级"——大体对，但藏着一个兼容性成本。**
   改 verdict schema（defects 加 severity）会牵动 `parseVerdict`。现存 `review.json` 的 `defects` 是纯 `string[]`，新字段必须向后兼容（旧值当哪种 severity？缺省策略要定），否则历史任务重读会坏。成本不在提示词，在 schema 迁移。

4. **"不建议抄 TRIZ"——对，但理由要说硬。**
   TRIZ 是**发明学**（解决矛盾、求 IFR），审的是"设计是否屈服于伪妥协"。taskctl 审的是"产物是否符合**既有判据**"——判据是给的，不存在"发明"空间。所以 TRIZ 在 taskctl 语境不是"噪声"，是**错配**：它需要一个可被推翻的"设计意图"，而 taskctl 复核只有"判据 vs 产物"的对拍。

### 三点需补

**A. EGM 有一个未显式点出的先验：审查对象是"会迭代的文档"。**
   EGM 全程假设"改稿→再审"闭环（`concepts_brief` → `design_draft` → review → resolve → re-review）。taskctl 的产物多数是**一次性执行结果**（跑完→审→过/不过），没有"改文档再跑一遍 zoom-out"的迭代。后果：**M7 收敛协议只能部分移植**——`settled`/`fixed` 状态有意义（返工后再审、避免同一问题反复纠缠），但"连续两轮 clean 才收敛"在 taskctl 里对应的是"返工后复审"，不是"同一文档多轮抽样"。P2 里的 clean round/churn 要按 taskctl 的**返工循环**重新定义，不能照抄 EGM 的"文档迭代抽样"。

**B. `disable-model-invocation: true` 值得单列。**
   7 个 egm skill 的 frontmatter 全带此字段——意思是"这些是编排器读的操作手册，模型不该自动调用"。这是 EGM 防止"审查流程被模型自动触发、自己审自己"的闸门。taskctl 目前复核由 worker 显式触发，没有对应概念；但若 P3 把透镜做成 skill，这条闸门必须一并落地，否则会引入"模型自动触发多轮审查"的失控面。

**C. 反谄媚（M4）taskctl 已有隐式优势：信息剥夺。**
   taskctl 的 reviewer **看不到 worker 对话**，也就看不到 worker 的"卖力解释"——这本身削弱了谄媚触发源。EGM 靠提示词压谄媚，taskctl 靠**信息剥夺**压谄媚，两种解法。移植 M4 不必全抄 11 条，补"立场约束（默认压力测试）+ 每个 fail 附最强反方论证"两条即可，信息剥夺已做了大半。

### 复核裁决

第 2–7 节结论**方向正确、可执行，无硬伤需推翻**。修正后的迁移优先级：
- **P1** 无争议，立即做（改 `buildReviewPrompt` + verdict schema 向后兼容）。
- **P2** 须按脚注 4 与补注 A 重定义收敛语义（对齐 taskctl 返工循环，非文档迭代）。
- **P3** 须同时落地补注 B 的 disable-model-invocation 闸门，否则不做。

---

## 9. 落地记录（`feature/egm-review-p1` 分支，2026-11-17）

### 已做：P1（提示词层，`8392a19` 之前的 `5c53308`）

`buildReviewPrompt` 加四条，零 schema 迁移、零 consumer 改动：
- 压力测试立场（默认先找做不到/说不通/缺证据）
- 证据强制（evidence 引具体产物 + 观察；空 evidence → 该条 unclear）
- defects 用 🔴/🟡/🟢 前缀标 severity，nit-only 不得 fail（保持 `string[]` 契约）
- summary 先复述任务+判据再给结论，复述对不上 → unclear（喂 clarify 归因）

### 已做：收敛语义 = 「返工价值判定」（`8392a19`）

采纳第 8 节复核的方向修正——**不是照搬 EGM 的「两轮 clean 才收敛」，而是 taskctl 的「worker 是否在动」**：

- 判定信号用**criteria 的 pass/fail 翻转**（criterion id 被 definitionDigest 锁死，跨轮稳定），**不比较 defects 自由文本**。
- **空转**：fail 的 criterion 集合与上一轮完全相同 → 提前 `blocked`，journal 写清未变的 criterion，不再烧满 `maxReviewRounds`。
- **逼近**：至少一个 criterion flip（fail→pass 或新 fail）→ 照常消耗一轮 rework。

对应 EGM 的映射：settled/fixed 的「同 scope 同问题」在 taskctl 里就是「同一 criterion 连续 fail」；EGM 的「clean round」在 taskctl 里无对应物（返工后产物变了，不是抽样），所以**不做**「连续两轮 clean 才过」。

### 明确不做 + 理由（避免未来误读为「欠着」）

| 项 | 理由 |
|---|---|
| 结构化 severity（枚举 + 迁移 history review.json） | 提示词软约束已够，"机器识别 nit"是兼容债；准入二元（pass/fail/unclear），nit 误判由下一轮/人工放行兜底 |
| 独立 `restated` 字段喂归因 | 判据是**给定的**（acceptance 命令 / criteria），不是 reviewer 要"理解一段文档"；复述的边际价值远小于 EGM 对设计文档的价值，P1 的 summary 软约束已拿 80% 收益 |
| EGM 的「两轮 clean 收敛」 | taskctl 返工循环审查的是**每次不同的产物状态**，不是同一文档多轮抽样，语义错配 |
| P3 透镜层 | 需先落地 disable-model-invocation 闸门 + 真实返工数据支撑"何时值得多 lens"，否则不做 |

### 遗留（真正值得等数据再做的）

「返工价值判定」目前只有空转/逼近二元。更细的判决（例如：逼近但逼近速度太慢要不要提前停、churn 检测"新问题落在刚修好的 scope"）需要**真实任务的返工分布数据**。这与本仓 backlog 里"分类器等 escalated 事件积累出比例"是同一个「先跑数据再设计」原则。
