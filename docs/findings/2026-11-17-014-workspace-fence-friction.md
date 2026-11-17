---
date: 2026-11-17
source_task: 014-task-manager-hardening
kind: unset
severity: unset
---

# 工作空间栅栏：一条无时间戳的泄漏预约挡住新运行 25 分钟，且无法从数据判断它是否安全可删

## 观察到什么

- run15（2026-11-17 13:41，任务 014，worktree `<task-worktree>`，基点 efced96）在 claim 阶段被挡：`blocked workspace reserved by another or uncertain execution; reconcile before retry`。
- 预约注册表（user-temp，每台机器一份：`%TEMP%\opencode\taskctl-workspaces\reservations.json`）当时含一条 `cwd: <main-tree>, gitCommonDir: <main-tree>/.git` 的预约。它来自 theory 板**已完成**的任务 004（任务文件里 `workdir: <main-tree>`）。注册表条目**没有时间戳、没有 PID**。
- 冲突规则（`src/workspace.ts` reserveWorkspace）：requested = `[canonical, gitCommonDir]`，对每条记录 held = `[cwd, gitCommonDir]`，判定 `within(a,b) || within(b,a)`。worktree 与主树共享 common dir，精确撞车。
- ~13:54，该泄漏条目在**无人手工干预**下消失（theory 编排器侧自行释放/GC）。随后注册表里出现一条**活的** `cwd: <workdir-root>, gitCommonDir: null`——theory 板正在运行的 example attempt（其 workdir 继承自配置）。按 within() 双向包含，**任何位于 `<workdir-root>` 之下的工作空间都会被它挡住**（不止 git 仓库）。
- 恢复方式：后台脚本每 30 秒轮询注册表，13:54:58 条目清空后重启 run16 前身 → claim 成功。全程 0 次 retries 损耗（栅栏是 fail-closed 的，这点是对的）。
- 影响：约 25 分钟墙钟延迟；恢复决策需要"这条预约是否安全可删"的判断，而注册表数据**不足以支持这个判断**（无时间戳、无 PID、无心跳字段）。
- 修复状态：未修。对应 backlog 里已列的 deferred 项（`taskctl unblock` / `taskctl gc` / 租约化）。014 范围内只做了纪律约束（C6 隔离），没有动预约机制。

## 在哪里发生

- 任务：`014-task-manager-hardening`，claim 阶段（scheduler/workspace 层）
- 证据：

```text
run15.log:
[014-task-manager-hardening] blocked workspace reserved by another or uncertain execution; reconcile before retry

注册表条目（泄漏时）:
{"token":"1c739d81-...","cwd":"D:\\workspace\\task-manager","gitCommonDir":"D:\\workspace\\task-manager\\.git"}

watcher 输出:
RESERVATION-CLEAR at 13:54:58 - workspace fence is free, safe to relaunch 014
```

## 复现条件

（1）一个 attempt 以非干净路径结束（崩溃/外部杀死）后其注册表条目残留；（2）之后任何运行的工作空间与该条目共享 git common dir、或位于其 held 路径之下 → claim 被拒，直到条目被其属主进程释放、或人工删改注册表 JSON。

## 猜测的成因

（猜测）release() 只在受控路径上运行，非受控结束（进程被杀）不会走 release，于是条目泄漏；而注册表缺少时间戳/心跳，使"陈旧"不可判定——不敢删活条目、删不掉死条目，两台机器各持一份本地注册表还使跨机协调失效。与仓库内 `.taskctl-workspace.lock` 已有的心跳/TTL 机制不同步，是同一语义在两处的实现分叉。
