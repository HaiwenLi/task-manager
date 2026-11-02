# 编排器是独立驱动层，Agent 只经 Adapter 接入

编排器是独立于任何 Agent 的 CLI 守护进程，与每家 Agent（OpenCode、Kimi Code……）的唯一集成缝是一个薄 Adapter 接口：会话生命周期操作（建/续/问/用量/fork/压缩/中断）。模型与 effort 三层覆盖配置（全局 → Agent 条目 → Task frontmatter）。
_Avoid_（被否）: OpenCode plugin 做编排（plugin 活在 agent 进程内，无跨 Session 调度原语，且锁死单家）；纯 CLI 字符串拼接（无事件流、无 Context Budget 读数）。选型细节（自建 vs fork rove）见后续 ADR。

## Consequences

- Kimi 的 effort 无 CLI flag、只能走 API/SDK —— Adapter 接口成为必然，这validated此决策
- 新 Agent 接入 = 写一个 Adapter + 一条 agents.yaml 条目
