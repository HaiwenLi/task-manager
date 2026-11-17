# findings：真实任务的摩擦记录

这里放**观察到的事实**，不放判断。一条 finding 是一次真实任务里确实发生过的事：哪一步慢了、哪一步判错了、哪个机制没被触发、哪次白跑了一轮。

判断（要不要做、什么时候做、值不值得）在 [../backlog.md](../backlog.md)。两者分工：

- **findings = 事实层。** 一条 finding 可以没有结论，也可以永远不产生行动。
- **backlog = 判断层。** 一条 backlog 项必须能指回至少一条 finding，或者一次真实事故。

## 为什么有这个东西

任务是在**好几台机器**上分别跑的，push/pull 传的是代码，不是证据。每台机器的 `tasks/<id>/journal.md`、`review.json`、`render.json` 都不在 git 里，换台机器就看不见了。摩擦只活在当时的对话里，pull 一次就没。

所以：**换机器之前，把摩擦抽成一条 finding 落进仓库。**

## 三条约束（不是风格偏好，是能不能用的前提）

1. **自包含。** 别的机器上没有 `tasks/<id>/`，写"见 003-foo/journal.md"等于死链。证据要摘录原文贴在文件里。
2. **只写事实，不写结论。** 观察到什么、在什么条件下复现，写到能被人复核为止。结论留给 triage——机器把猜测写成事实，就是下一轮误判的源头。
3. **一 finding 一文件，追加式。** 两台机器同时 pull 时，合并不同文件名不冲突，合并一个大表格必冲突。**不要重命名已合入的文件**（历史里那个名字就是它的身份）。

## 命名

```
docs/findings/YYYY-MM-DD-<slug>.md
```

`slug` 用任务标题的 ASCII 部分；标题全是中文时用任务 id。同一天同一个 slug 再加一条，用 `-2`、`-3` 后缀。

## 怎么产生

```powershell
# 打印草稿，人工补「复现条件」和「猜测的成因」后另存
taskctl findings --task 002-unc

# 直接落盘（目录不存在会建）
taskctl findings --task 002-unc --out docs/findings/2026-11-17-002-unc.md
```

命令只做**抽取**，抽取的信号：

| 来源 | 抽什么 |
| --- | --- |
| `journal.md` | `escalated`、`blocked`、`rework`、`handoff`、`turn-failed`、`model-fallback(-failed)`、`render-unavailable`、`definition-drift`、`spec-invalid`、`clarify-failed`、`acceptance failed` |
| `review.json` | 判定、未过的 criterion 及其 evidence、defects |
| `render.json` | 失败的视口与原因 |
| `acceptance.json` | 命令失败与退出码 |
| `attempt.json` | phase 不是 `settled`（执行停止未确认） |
| 任务文件 | `status` / `retries` / `review_rounds` / `sessions` / `complexity` / `verify` |

`复现条件` 和 `猜测的成因` **故意留空**，由人填。机器能抽出来的只有事实，判不出来就写「不确定」。

## L0：从一条 finding 到一条改进任务

现在就能做，不需要任何新代码：

1. 从 findings 里挑一条**已知会再发生**的（不是"只发生过一次且无法复现"的）。
2. 建成任务，判据按事实选：
   - 有可自动判定的结果（测试、构建、脚本断言）→ `--verify mechanical --acceptance "<命令>"`，机器判，不烧复核。
   - 产物是给人看的 → `--verify render --target <页面>`。
   - 判据只能读文字 → 默认 `human`，让它进独立复核。
3. 碰状态机、`definitionDigest`、验收分流的改动 → 加 `--risk high`，机器过了也必须人签。

**两条硬规则：**

- **每条改进任务必须在正文里引用 findings 文件名。** 没有事实来源的改进任务不建——那是"模型觉得该改"，不是"真出过事"。
- **改动 `review.ts` 的提示词、`definitionDigest`、或验收分流本身的任务，一律 `risk: high`。** 这类改动由旧机制审、新机制用，一次坏改会自我强化。

## 这一版的边界（别当成 bug）

- 只按**单个任务**抽，不做跨任务聚合（聚合是 triage 的事）。
- 不写 `kind` / `severity`（`unset`），不判断值不值得做。
- 不自动建任务、不自动改 backlog。
- `taskctl verify` 是预览，不落 `render.json`；所以**手动**跑渲染检查发现的问题不会自动进 finding。要么跑一次真任务，要么手工贴证据。
- `taskctl findings` 只读不写，除非显式给 `--out`。

## triage（还没做）

想把 N 条 finding 变成 M 条建议时再写：按 `kind`/`severity` 归档、合并重复、只出 3 条带触发条件的结论。现在样本太少，先手写几条看看格式顺不顺。
