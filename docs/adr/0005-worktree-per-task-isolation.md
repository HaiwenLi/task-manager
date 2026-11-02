# 每 Task 一个 git worktree，done 后合回

> This remains a future direction, not an implemented guarantee. [ADR-0007](0007-fenced-execution-and-evidence.md) uses canonical exclusive workspace reservations with conservative serialization. No automatic merge is currently performed.

默认并发 2 个 Worker 同时执行，同一目录会被互踩。目标目录是 git repo 时，认领即自动创建以 Task ID 命名的 worktree，验收通过后合回主分支再清理；非 git 目录的任务自动降级为共享目录 + 串行。
_否决_：共享目录 + 默认并发 1（放弃已定的并发能力）；纯 `workdir:` 声明制（把踩踏风险留给发布者，易翻车）。

## Consequences

- done 的语义含一次 merge（不同 Task 不同 worktree，冲突罕见但需处理策略）
- 需要孤儿 worktree 的清理机制（blocked/接管场景）
