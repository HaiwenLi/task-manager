# 完成协议：taskctl 上报，验收关落锤

> The absent-check pass policy below is superseded by [ADR-0007](0007-fenced-execution-and-evidence.md). Missing/blank acceptance now blocks for review; it never certifies Done.

Worker Session 收到的任务协议里注入 `taskctl` CLI 用法；Agent 完成时调 `taskctl done <task-id>`（顺带落 Handoff Note、请求交接），但 `done` 状态只能由编排器执行验收关（默认 `acceptance:` shell 命令 exit 0，无字段则告警放行）后写入——自报只触发验证，不是验证本身。人工审核为可选高门槛开关。
_否决_：Agent 直接改 Task frontmatter（不可信写方 + 解析脆弱）；编排器信任自报（Agent 会谎报完成，ordewell/NEEDLE 皆以工具上报+关卡为界）。

## Consequences

- `taskctl` 必须对派出的 Worker 进程可达（PATH 注入或绝对路径）
- 上报/交接/笔记三个动作共用一个 CLI 出口，协议简单
