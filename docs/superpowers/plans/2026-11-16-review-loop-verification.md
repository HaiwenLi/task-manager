# 复核流水线 P1 验证记录（2026-11-16）

环境：Windows 10/11、Node v24.18.0、Vitest 5.0.4、TypeScript 7（`npx tsc --noEmit`）。
所有记录都是本机实跑输出，没有转述。

## 1. 全量离线测试

```
$ node node_modules/vitest/vitest.mjs run --reporter=dot
      Tests  230 passed | 1 skipped (231)
   Duration  17.32s
$ npx tsc --noEmit
(无输出，退出码 0)
```

1 skipped 是上游 `e2e.smoke.test.ts`：需要真实 opencode 登录并发起真实会话，本机未授权消耗额度。

## 2. CLI 端到端（确定性适配器，真实进程内链路）

`tests/pipeline-e2e.test.ts` 走完整命令链 `add → approve → run → done`，以及复核持续失败
`add → approve → run → blocked`（一轮 `run` 内连续返工直到轮次上限）：

```
✓ add → approve → run → done, with the acceptance gate, review and board
✓ a failing review spends a round and ends blocked at the limit
```

覆盖的真实代码路径：任务文件读写、澄清会话落 spec 与 criteria、draft 关卡、调度器多轮领取、
工作区独占与 git 仓库级串行、验收命令（断言被调用一次）、复核会话与 verdict 解析、返工循环、
journal、board 重写、report。

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

## 4. 真实 opencode 会话（已跑通一次）

本机 opencode 2.3.0，npm 全局安装的真实 `opencode.exe`（`.cmd` shim 不能被 `shell:false` 启动），
任务目录在临时项目里，`taskctl` 通过一个 shim 暴露给 agent。

第一次跑：agent 写出了 `hello.txt`，验收命令通过，但复核判 `unclear`，任务停在
`awaiting-human`。查 `review.json` 的 `raw` 是空字符串——真实 opencode 的 NDJSON 里文本在
`part.text`，而适配器读的是顶层 `text`（fixture 也是按旧形状写的，所以单测一直绿）。
已修适配器并让 fixture 覆盖两种形状；修复后重跑：

```
[001-hello] claimed
[001-hello] running
[001-hello] acceptance passed
[001-hello] reviewing
[001-hello] reviewed pass
[001-hello] done review passed
```

`review.json`：

```json
{
  "verdict": "pass",
  "criteria": [{ "id": "C1", "pass": true, "evidence": "验收命令检查 hello.txt 的 utf8 内容 trim 后等于 'hi'，result 为 passed 且 exitCode 为 0" }],
  "defects": [],
  "summary": "提供的验收证据表明 hello.txt 存在且内容为 hi，C1 通过。"
}
```

两件事值得记住：fail-closed 生效了（解析失败没有当通过，任务停下等人）；单测覆盖的是
fixture 的假设，不是真实 CLI 的形状。

## 5. 仍未验证

- **多后端**：DSH / Kimi / Pi 适配器尚未实现（P2）。
- **复核会话的真实取消**：`startReview` 走可取消句柄，但「OpenCode CLI 被杀 ≠ 后端会话已停」
  的限制对复核同样存在（ADR-0007）。超时按不确定处理，未做真机验证。
- **跨平台**：只在 Windows 验证；POSIX 的进程树取消路径没跑过。
- **并发压力**：`parallel` 只验证到 2 个任务；没做长时间多任务压测。
- **多任务真实并跑**：真实 opencode 只跑了单任务。
