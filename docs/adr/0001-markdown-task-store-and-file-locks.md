# Markdown 为任务真相源，文件锁认领

> Recovery and concurrency protocol superseded by [ADR-0007](0007-fenced-execution-and-evidence.md): stale ownership alone does not permit replay of uncertain execution.

Task 以 Markdown + YAML frontmatter 存于 `tasks/` 目录，是唯一真相源；认领通过原子文件锁（含 Worker 标识 + Heartbeat 时间戳）实现，失败重试有上限，耗尽转 Blocked。
_Avoid_（被否）: SQLite 事务原子认领（NEEDLE 模式）——调研推荐项，但引入第二存储与锁库依赖，且文件对人和 Agent 都直接可读写、git 天然版本化，Session Chain 直接追加在 Task 文件里。并发规模在百级任务内文件锁足够。

## Consequences

- 原子性靠"创建即拥有"的文件操作而非事务，跨平台原子性需谨慎选原语
- 任务量大（千级以上）或需要复杂查询时，可能未来加索引层（Markdown 仍为真相源）
