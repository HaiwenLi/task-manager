# 复核流水线 P1 验证记录（2026-11-16）

环境：Windows 10/11、Node v24.18.0、Vitest 5.0.4、TypeScript 7（`npx tsc --noEmit`）。
所有记录都是本机实跑输出，没有转述。

## 1. 全量离线测试

```
$ node node_modules/vitest/vitest.mjs run --reporter=dot
      Tests  223 passed | 1 skipped (224)
   Duration  14.95s
$ npx tsc --noEmit
(无输出，退出码 0)
```

1 skipped 是上游 `e2e.smoke.test.ts`：需要真实 opencode 登录并发起真实会话，本机未授权消耗额度。

## 2. CLI 端到端（确定性适配器，真实进程内链路）

`tests/pipeline-e2e.test.ts` 走完整命令链 `add → approve → run → done`，以及复核失败
`add → approve → run → blocked`：

```
✓ add → approve → run → done, with the board updated at each step
✓ a failing review sends the task back to open instead of done
```

覆盖的真实代码路径：任务文件读写、澄清会话落 spec 与 criteria、draft 关卡、调度器领任务、
工作区独占、验收命令、复核会话与 verdict 解析、journal、board 重写、report。

适配器是脚本化的（按提示词内容判断是澄清/执行/复核），不是真实模型。

## 3. 台账与指标（真实 CLI）

在一个临时项目里放三种状态的任务，跑真实 `taskctl`：

```
$ npx tsx src/main.ts board --tasks-dir <demo>/tasks
待我确认 1
  001-login 登录页改版 · complex · 等签字
待我放行 1
  002-pay 支付回调修复 · complex · 等放行
卡住 1
  003-mig 数据迁移 · complex · 已阻塞

<demo>/.taskctl/board.md

$ npx tsx src/main.ts metrics --tasks-dir <demo>/tasks
audits  0
clarify  0 fail / 0
worker  0 fail / 0
reviewer  0 fail / 0
none  0 fail / 0
highlight  0
返工率  67%  (2/3)

$ npx tsx src/main.ts status --tasks-dir <demo>/tasks
id         status          retries  sessions  note
001-login  draft           0        0         -
002-pay    awaiting-human  0        0         -
003-mig    blocked         3        0         -
```

生成的 `board.md`：

```markdown
# taskctl · 2026-11-16 03:06

> 生成物，手改会被下一次重写覆盖。来源：tasks/*.md

## 待我确认 1
- 001-login 登录页改版 · complex · 等签字

## 待我放行 1
- 002-pay 支付回调修复 · complex · 等放行

## 卡住 1
- 003-mig 数据迁移 · complex · 已阻塞
```

## 4. 未验证的部分

- **真实 opencode 会话**：`run` 走真实模型、真实工具调用、真实中途交接，没有跑过。
  这会消耗额度，需要单独授权。
- **多后端**：DSH / Kimi / Pi 适配器属于 P2，本增量只有 opencode 适配器。
- **复核会话的真实取消**：`runReview` 走 `start` 句柄，但“OpenCode CLI 被杀 ≠ 后端会话已停”
  的限制对复核会话同样存在（ADR-0007）。超时按不确定处理，未做真机验证。
- **跨平台**：只在 Windows 验证；POSIX 的进程树取消路径没跑过。
- **并发压力**：`parallel` 的验证是 2 个任务、串行/并行各一次，没有做长时间多任务压测。
