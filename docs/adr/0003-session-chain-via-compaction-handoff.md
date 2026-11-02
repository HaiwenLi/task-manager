# 会话链交接 = 末尾压缩 → 分叉/新开 → 注入摘要

Context Budget 逼近阈值时：编排器让旧 Session 收尾（写 Handoff Note）→ fork 或新开 Session → 注入笔记 + Task 描述 + 文件清单继续。Handoff Note 按 `tasks/<task-id>/sessions/NNNN-handoff.md` 编号存档。OpenCode 的 compaction 摘要模板本身即为"交给下一个 agent 续做"设计（含 Objective/Work State/Next Move/Relevant Files），是 Handoff Note 的格式蓝本。
_否决_（被否）: 全文对话摘要注入（信息全但易超新预算）；固定轮次强制换（浪费预算且不敏感）。检测以编排器客观测量为主（`session.get` tokens 汇总 ÷ `model.list` limit.context；Kimi 读 context_usage），Agent 自报作提前量兜底。

## Consequences

- Session ID 不自定义，改为从 `opencode run` NDJSON 输出捕获真实 ID 追加入链（不赌 id 格式校验）
- v0.1 走"新开 + 注入笔记"路径；fork-继承 + compact 减脂留 v0.2（Adapter 接口保留 compact 位）
- 换 Session 质量依赖 Handoff Note 质量；Kimi 侧用 `/compact` + hooks 对齐
