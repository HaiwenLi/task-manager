# 任务管理器（多 Agent 任务编排器）

批量发布任务，多个 Coding Agent 自动认领并执行；每个 Task 持有一条自己维护的会话链，上下文耗尽前自动交接延续，直到任务完成。

## Language

**任务（Task）**:
一条可独立执行的工作单元，携带验收标准与会话链记录，由 Markdown 文件承载。
_Avoid_: 工单、issue、todo

**会话（Session）**:
一个 Agent 处理一个 Task 期间的一段连续对话上下文；Context Budget 耗尽即终结。
_Avoid_: 对话、聊天、上下文（上下文另有所指）

**会话链（Session Chain）**:
一个 Task 先后消耗的全部 Session 的有序序列，由 Task 自己维护记录。
_Avoid_: session 列表、历史

**交接笔记（Handoff Note）**:
旧 Session 终结前写下的结构化笔记，是新 Session 恢复工作记忆的唯一粮食，同时供人审查进度。
_Avoid_: 中间记录文档、进度文档、日志

**上下文预算（Context Budget）**:
一个 Session 可用的 context window 余量；"空间不够""快满了"一律指此概念。
_Avoid_: 空间、容量、token 上限

**编排器（Orchestrator）**:
独立于任何 Agent 的驱动层：发布、认领、监控 Context Budget、触发交接、验证完成。Agent 无关。
_Avoid_: 调度器（另有所指）、主控、平台

**工人（Worker）**:
编排器派出的一个 Agent 进程实例，同一时刻只持有一个 Task。"派 Coding Agent"即指此动作。
_Avoid_: agent（泛指时另有所指）、执行器、runner

**Agent**:
可被编排器驱动的编码代理 CLI（OpenCode、Kimi Code 等），经 Adapter 接入。
_Avoid_: 模型、助手、bot

**适配器（Adapter）**:
编排器与某家 Agent 之间的唯一集成缝，收窄为会话生命周期操作。
_Avoid_: 插件、驱动、connector

**认领（Claim）**:
Worker 以原子方式取得 Task 所有权的行为；未被认领的 Task 对其他 Worker 可见。
_Avoid_: 锁定、领取、抢占（过期接管另有所指）

**心跳（Heartbeat）**:
Worker 持有 Task 期间的周期性存活信号；心跳停止即允许过期接管。
_Avoid_: ping、保活

**接管（Takeover）**:
原 Worker 心跳过期后，另一 Worker 重新认领该 Task 的行为。
_Avoid_: 抢占、偷任务

**验收标准（Acceptance Criteria）**:
Task 自带的机器可判定的完成条件；通过它才允许标记 done。
_Avoid_: 测试（另有所指）、DoD

**阻塞（Blocked）**:
Task 重试耗尽后进入的、等待人工介入的终态。
_Avoid_: 失败、卡死、暂停

**召回（Recall）**:
Worker 开工那一刻，按任务自身的文字向记忆库（MemPalace）做的一次语义检索；命中的内容作为参考资料进提示词，不是指令。默认关闭，出错即降级为没有这一节。
_Avoid_: 记忆注入、RAG、检索（泛指时另有所指）

**固定来源（Fixed Source）**:
`fixedSources` 列出的一个文件，装着用户本人的规范（怎么写、什么不许做）；每次尝试开工时按文件原样读进 worker 提示词，不检索、不按相似度过滤；读不到只记一条 journal，不拦任务。
_Avoid_: 偏好档案（那是本项目自己的 `profile.md`）、记忆注入、instructions

**预算护栏（Budget Guard）**:
领取之前，按后端模型目录报告的成本判定这次尝试会用到的每个模型；按量计费和成本未知的模型默认不放行，被拒的任务结局是拒绝（Refused）。
_Avoid_: 限额、配额、风控

**人工触点（Human Touch）**:
一个任务被人实际操作一次：签字、回答、放行、打回、抽查、重试，或应用了一份拆分计划。`taskctl metrics` 按任务和事件计数，再分成审批型和裁决型两类。
_Avoid_: 人工干预（泛指时另有所指）、审批

**审批型触点（Sign-off）**:
人工触点里签字放行的一类：`approved`、`accepted`、`retry`，和应用了一份拆分计划（`applied`）。它是该往下压的成本，越少越好。
_Avoid_: 放行（只是 `accepted` 一个事件）、人工干预（泛指时另有所指）

**裁决型触点（Adjudicated Touch）**:
人工触点里给出判断的一类：`answered`、`rejected`、`audited`。判断从这里来，不该去压它；打回带着理由，所以算在这一类。
_Avoid_: 成本（那是审批型）、人工打回（`rejected` 只是其中一类事件）

**拒绝（Refused）**:
预算护栏不放行时一次调度的结局：没有模型会话被启动，任务保持 open，不算进展，也不需要人工恢复。
_Avoid_: 失败、阻塞；不要与 provider 拒绝（模型拒绝一个回合）或人工打回（`taskctl reject`）混用
