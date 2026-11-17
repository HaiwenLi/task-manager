---
date: 2026-11-17
source_task: 014-task-manager-hardening
kind: unset
severity: unset
---

# 配额通道死亡：5 次 retry 烧在一个非任务故障上，人工探测了三个 provider 才恢复

## 观察到什么

- run16（2026-11-17 13:55，`taskctl run --config taskctl-tm.json`）：worker 模型 `opencode-go/deepseek-v4.1-flash`，claim 成功、dispatch 后连续 5 次 `turn-failed exit 1`，转 blocked（retry limit reached）。attempt 从 13:55:29.997Z 到 13:55:41.836Z 即 settle（12 秒），没有产生任何 session。
- opencode CLI 直接探测（`run --model <m> "Reply with exactly: OK"`）：
  - `opencode-go/deepseek-v4.1-flash` → exit 1，原文：`Error: OpenCode Go weekly usage limit reached. Switch to a free model, or turn on Extra Usage on the Go page in OpenCode Console to keep going.`
  - `opencode/deepseek-v4.1-flash-free` → exit 0，输出 `OK`
  - `zhipuai-coding-plan/glm-5.3-flash` → exit 0，输出 `OK`
- 同一个模型（deepseek-v4.1-flash）在 opencode-go 通道周限额打死后，opencode 免费通道立即可用。
- 人工恢复步骤：attempt.json 改名归档（`attempt.1.opencode-go-weekly.json`）、任务文件 retries 5→0、status blocked→open、模型字段换免费通道，重跑（run17）一次通过：1 个 session、acceptance exit 0、复核 pass。
- 影响：5 次 retry 预算烧在一个**与任务内容无关的基础设施故障**上；恢复需要人肉探测三个 provider。
- 修复状态：014-C5（modelChain 配额链）已合入 main（54ef24e）；`taskctl-2dsim.json` 与 `taskctl-tm.json` 均已配置链。**链头指向死通道时的实弹演练还没做过**（现有链头是活通道）。

## 在哪里发生

- 任务：`014-task-manager-hardening`，dispatch 阶段（turn 层）
- 证据：

```text
run16.log:
[014-task-manager-hardening] turn-failed exit 1   ×5
[014-task-manager-hardening] blocked retry limit reached

attempt.1.opencode-go-weekly.json: phase=settled, 12s, 无 session

CLI 探测:
Error: OpenCode Go weekly usage limit reached. Switch to a free model, ...
```

## 复现条件

把任何任务的 model 指到一个周限额已尽的通道（opencode-go 2026-11-17 起、kimi 2026-11-17 起同理），retryLimit > 0 → 每次尝试秒退（exit 1、0 token），连烧 retryLimit 次 → blocked。每次失败之间没有退避意义上的等待，全部预算在几秒内耗尽。

## 猜测的成因

（猜测）dispatch 层把"配额耗尽"当作与"任务失败"同类的 turn 失败计入 retries；两者的正确分类（快速退出 + 0 token + stderr 命中配额词表）正是 014-C5 落地的判定条件，但 014 合入前的运行版本没有这个分类。
