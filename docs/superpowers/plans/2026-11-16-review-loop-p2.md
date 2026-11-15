# P2 计划：多后端适配、拆分、以及跨机器之前的事

P1 已合入 `main`（tag `p1-review-loop`），当前能力见 README。P2 的目标只有一个：
让这套东西在**真实任务**上跑够久，直到能回答「人工时间有没有真的下降」。

## 1. 多后端适配（最高优先）

P1 只有一个 opencode 适配器。要在 DSH / Kimi / Pi 里用，需要 `src/adapters/` 下三份实现，
每个都要满足 `AgentAdapter`：`prompt`（一次性回合）、`start`（可取消句柄）、`contextUsage`、
`contextLimit`。

| 后端 | 入口 | 已知 | 需要验证 |
| --- | --- | --- | --- |
| DSH | `dsh headless "<task>"`、`--resume <session>` | 本机已装 `@deepseek-ai/dsh` | 输出形态（是否 NDJSON）、退出码语义、能否拿到 session id |
| Kimi | `kimi -p "<prompt>" --output-format stream-json`、`-S <id>` / `-c` | 本机已装 `@moonshot-ai/kimi-code` | stream-json 事件形状、取消是否等于后端停止 |
| Pi | 应为 `pi -p` | 本机已装 `pi` | **完全未验证**：`pi --help` 在沙箱里因写 `~/.pi` 被拒 |

设计要求：适配器必须声明能力（start/inspect/cancel/usage）。做不到取消的后端，超时后按
`uncertain` 阻塞，不自动重跑——这条 P1 已经在 opencode 上落实，新适配器不得放宽。

配置层面 `agent` 只接受 `opencode`，改成一个注册表；每家的二进制路径、模型名格式
（`provider/model`）不同，要在文档里写清。

## 2. 拆分（`taskctl split`）

设计 §8.3 的逻辑还没实现：拿到一个复杂意图后，产出「耦合清单 + 合并建议」三行给用户，
两轮谈不拢就强制合并。独立性判据是**写作用域有没有交集**，不是讨论出来的。

实现要点：
- 复用澄清会话，提示词里加「列出计划改动的文件/目录/数据集」；
- 交集判定用规范化路径比较，git 仓库内按仓库根归一；
- 合并建议写成一份 `## 拆分` 段落追加进 `spec.md`，用户改完再 `approve`；
- 产出子任务时写 `depends_on`，不引入 DAG。

## 3. 真实使用要回答的问题

- 一个复杂任务从 `add` 到 `done`，人工花了多少分钟？（现在只有审计记录，没有计时）
- 复核误判率：`audit --verdict fail --stage reviewer` 占比。
- 返工率：`review_rounds > 0` 的任务占比（`taskctl metrics` 已有）。
- 偏好档案加了多少条之后，澄清阶段的补问数量下降了？

## 4. 明确不做

Web UI、模型训练、自动合并/部署、跨机器调度、多于一层依赖。

## 5. 先决条件

真实 opencode 会话跑通一次（消耗额度，需要授权）。这是 P1 唯一没做的验证，
也是 P2 所有数字的前提。
