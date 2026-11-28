# Phase 2 有界 Live 验证：在真实 opencode 后端上检查跨任务 session 复用、watch 的发现与优雅停止，
# 以及 run / watch 两个入口留下的逐任务证据是否一致。
#
#   .\scripts\live-phase2.ps1              # 只准备临时项目并做不耗额度的注册校验，不调用模型
#   .\scripts\live-phase2.ps1 -Live        # 真跑（会消耗模型额度：3 个 worker 回合，1 个共享 session + 1 个新 session）
#
# 退出码：0 全部断言通过；1 有断言失败；2 环境不满足（找不到 opencode、node 或 tsx）。
param(
  [switch]$Live,
  [string]$OpencodeExe = "",
  [string]$Model = "zhipuai-coding-plan/glm-5.3-flash"
)

$ErrorActionPreference = "Stop"
# 用 [Console]::Error 而不是 Write-Error：Stop 之下 Write-Error 是终止错误，
# 它后面那行 exit 永远不会执行，文档写明的退出码会变成 1。
$repo = Split-Path -Parent $PSScriptRoot

if (-not $OpencodeExe) {
  $candidate = Join-Path $env:APPDATA "npm\node_modules\@opencode\cli\bin\opencode.exe"
  if (Test-Path $candidate) { $OpencodeExe = $candidate }
}
if (-not (Test-Path $OpencodeExe)) {
  [Console]::Error.WriteLine("找不到 opencode 可执行文件（.cmd shim 不能被 shell:false 启动）。用 -OpencodeExe 指定真实 exe。")
  exit 2
}

$root = Join-Path $env:TEMP ("taskctl-live-phase2-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
$bin = Join-Path $root "bin"
$tasks = Join-Path $root "tasks"
$pending = Join-Path $root "pending"
New-Item -ItemType Directory -Force -Path $tasks, (Join-Path $root "work"), $bin, $pending | Out-Null

# agent 要在自己的回合里调用 taskctl done，所以 PATH 上必须能找到一个 shim
$tsx = Join-Path $repo "node_modules\tsx\dist\cli.mjs"
$entry = Join-Path $repo "src\main.ts"
if (-not (Test-Path $tsx)) { [Console]::Error.WriteLine("缺少 tsx：先在仓库里 npm ci"); exit 2 }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { [Console]::Error.WriteLine("找不到 node。"); exit 2 }
Set-Content -Path (Join-Path $bin "taskctl.cmd") -Encoding ascii -Value "@echo off`r`nnode `"$tsx`" `"$entry`" %*`r`n"

# 跨任务复用要求候选带有实际模型：不配置 model 时 worker 不记录它，批次会一律新开 session。
@{
  tasksDir = "tasks"
  workdir = "work"
  opencodeBin = $OpencodeExe
  model = $Model
  parallel = 1
  turnTimeoutMs = 180000
  acceptanceTimeoutMs = 60000
  maxTurnsPerSession = 3
  maxSessionsPerTask = 1
  retryLimit = 1
} | ConvertTo-Json | Set-Content (Join-Path $root "taskctl.json") -Encoding utf8

function Write-SimpleTask([string]$Path, [string]$Id) {
  $file = "${Id}.txt"
  $lines = @(
    "---",
    "schema: taskctl/v1",
    "title: create $file",
    "status: open",
    "verify: mechanical",
    "acceptance: node -e `"process.exit(require('fs').readFileSync('$file','utf8').trim()==='$Id'?0:1)`"",
    "criteria:",
    "  - C1 $file exists and its trimmed content is $Id",
    "complexity: simple",
    "sessions: []",
    "retries: 0",
    "review_rounds: 0",
    "---",
    "在工作目录创建 $file，文件里只有一行：$Id。不要创建其它文件。完成后运行 taskctl done --task $Id 请求完成。"
  )
  Set-Content -Path $Path -Value $lines -Encoding utf8
}

Write-SimpleTask (Join-Path $tasks "a.md") "a"
Write-SimpleTask (Join-Path $tasks "b.md") "b"
# c 不在初始看板上：watch 运行起来之后才落盘，用来验证真实文件系统事件的发现路径。
Write-SimpleTask (Join-Path $pending "c.md") "c"

$env:PATH = "$bin;$env:PATH"

function Read-TextFile([string]$Path) {
  # 空文件、不存在的文件、以及正被另一个进程写入的文件，都读成字符串：
  # Get-Content -Raw 读 0 字节文件时不产生任何对象（后续的 .Trim() 会撞上 $null），
  # ReadAllText 读不了仍被重定向打开的日志。共享读写方式打开对三者都成立。
  if (-not (Test-Path -PathType Leaf $Path)) { return "" }
  $text = $null
  try {
    $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
      $reader = New-Object System.IO.StreamReader($stream)
      $text = $reader.ReadToEnd()
      $reader.Close()
    } finally { $stream.Close() }
  } catch { return "" }
  if ($null -eq $text) { return "" }
  return $text
}

function Invoke-Taskctl([string]$Name, [string]$CliArgs) {
  $outFile = Join-Path $root "$Name.out.log"
  $errFile = Join-Path $root "$Name.err.log"
  $process = Start-Process -FilePath "node" -ArgumentList "`"$tsx`" `"$entry`" $CliArgs" -WorkingDirectory $root -NoNewWindow -PassThru -RedirectStandardOutput $outFile -RedirectStandardError $errFile
  $process.WaitForExit()
  return [pscustomobject]@{ Code = $process.ExitCode; Out = (Read-TextFile $outFile); Err = (Read-TextFile $errFile) }
}

# 注册守卫不耗模型额度，两种模式都跑（与 smoke.ps1 相同的理由）。
$board = Invoke-Taskctl "status" "status --tasks-dir tasks"
Write-Host "临时项目：$root"
Write-Host "opencode：$OpencodeExe"
Write-Host "model：$Model"
Write-Host ""
Write-Host $board.Out
if ($board.Out -notmatch "(?m)^\s*a\s+open" -or $board.Out -notmatch "(?m)^\s*b\s+open") {
  [Console]::Error.WriteLine("任务 a / b 没有注册为 open（看板见上）。")
  exit 1
}
if ($board.Out -match "ignored \(") {
  [Console]::Error.WriteLine("看板里有被忽略的文件：$($board.Out)")
  exit 1
}
if (-not $Live) {
  Write-Host ""
  Write-Host "未加 -Live，只准备了环境并校验了注册。真跑："
  Write-Host "  pwsh -File scripts/live-phase2.ps1 -Live"
  exit 0
}

$checks = New-Object System.Collections.Generic.List[object]
function Add-Check([string]$Name, [bool]$Ok, [string]$Detail) {
  $checks.Add([pscustomobject]@{ Check = $Name; Result = $(if ($Ok) { "PASS" } else { "FAIL" }); Detail = $Detail })
}
function Read-State([string]$Id) {
  $path = Join-Path $tasks "$Id\execution-state.json"
  if (Test-Path $path) { return Get-Content $path -Raw | ConvertFrom-Json }
  return $null
}
function Read-Usage([string]$Id) {
  $path = Join-Path $tasks "$Id\usage.jsonl"
  if (-not (Test-Path $path)) { return @() }
  return @((Read-TextFile $path) -split "`r?`n" | Where-Object { $_.Trim().Length -gt 0 } | ForEach-Object { $_ | ConvertFrom-Json })
}
function Read-RunLog([string]$Id) {
  $dir = Join-Path $tasks "$Id\logs"
  if (-not (Test-Path $dir)) { return "" }
  $files = @(Get-ChildItem $dir -Filter "run-*.log" -File)
  return [string](($files | ForEach-Object { Read-TextFile $_.FullName }) -join "`n")
}

# --- 1. run --batch a,b：跨任务 session 复用与 run 入口的逐任务证据 ---
$batch = Invoke-Taskctl "batch" "run --batch a,b --config taskctl.json"
$afterBatch = Invoke-Taskctl "status-batch" "status --tasks-dir tasks"
Add-Check "run --batch a,b exits 0" ($batch.Code -eq 0) "exit $($batch.Code); stderr: $($batch.Err.Trim())"
Add-Check "a and b reach done" ($afterBatch.Out -match "(?m)^\s*a\s+done" -and $afterBatch.Out -match "(?m)^\s*b\s+done") ($afterBatch.Out.Trim())

$stateA = Read-State "a"
$stateB = Read-State "b"
$sessionA = [string]$stateA.latestWorker.sessionId
$sessionB = [string]$stateB.latestWorker.sessionId
Add-Check "b reuses a's session (one session for the batch)" ($sessionA.Length -gt 0 -and $sessionA -eq $sessionB) "a=$sessionA b=$sessionB"
$journalB = Read-TextFile (Join-Path $tasks "b\journal.md")
$skipped = @($journalB -split "`r?`n" | Where-Object { $_ -match "session-reuse-skipped" })
Add-Check "b records no session-reuse-skipped" ($skipped.Count -eq 0) ([string]($skipped -join " | "))

$usageA = Read-Usage "a"
$usageB = Read-Usage "b"
$tokensA = 0
foreach ($record in $usageA) { if ($record.delta) { $tokensA += $record.delta.input + $record.delta.output + $record.delta.reasoning + $record.delta.cacheRead + $record.delta.cacheWrite } }
$tokensB = 0
foreach ($record in $usageB) { if ($record.delta) { $tokensB += $record.delta.input + $record.delta.output + $record.delta.reasoning + $record.delta.cacheRead + $record.delta.cacheWrite } }
$usageOk = $usageA.Count -ge 1 -and $usageB.Count -ge 1 -and $tokensA -gt 0 -and $tokensB -gt 0 -and [string]$usageB[0].sessionId -eq [string]$usageA[0].sessionId
Add-Check "usage captured for a and b in the shared session" $usageOk "a: $($usageA.Count) record(s), $tokensA tokens; b: $($usageB.Count) record(s), $tokensB tokens; sessions $($usageA[0].sessionId) / $($usageB[0].sessionId); model $($usageB[0].model)"

$logA = Read-RunLog "a"
$logB = Read-RunLog "b"
Add-Check "run writes per-task run-*.log for a and b" ($logA -match "\[a\] claimed" -and $logA -match "\[a\] done" -and $logB -match "\[b\] claimed" -and $logB -match "\[b\] done") "a log lines: $(@($logA -split "`n").Count); b log lines: $(@($logB -split "`n").Count)"

# --- 2. watch：真实文件系统事件发现新任务，stop 优雅收尾，watch 入口留下相同的逐任务证据 ---
$watchOut = Join-Path $root "watch.out.log"
$watchErr = Join-Path $root "watch.err.log"
$watch = Start-Process -FilePath "node" -ArgumentList "`"$tsx`" `"$entry`" watch --config taskctl.json" -WorkingDirectory $root -NoNewWindow -PassThru -RedirectStandardOutput $watchOut -RedirectStandardError $watchErr
$null = $watch.Handle
$lock = Join-Path $root ".taskctl\watch.lock"
$status = $null
$latency = -1
try {
  $lockDeadline = (Get-Date).AddSeconds(60)
  while (-not (Test-Path $lock) -and (Get-Date) -lt $lockDeadline -and -not $watch.HasExited) { Start-Sleep -Milliseconds 500 }
  Add-Check "watch takes ownership of the board" (Test-Path $lock) "lock present: $(Test-Path $lock)"

  $movedAt = Get-Date
  Move-Item (Join-Path $pending "c.md") (Join-Path $tasks "c.md")
  $doneDeadline = (Get-Date).AddSeconds(300)
  do {
    Start-Sleep -Seconds 3
    $status = Invoke-Taskctl "status" "status --tasks-dir tasks"
  } until ([string]$status.Out -match "(?m)^\s*c\s+done" -or $watch.HasExited -or (Get-Date) -gt $doneDeadline)
  $latency = [int]((Get-Date) - $movedAt).TotalSeconds
} finally {
  # 无论中途出了什么错，都不能留下一个常驻的 watch 进程。
  $stop = Invoke-Taskctl "stop" "stop --tasks-dir tasks"
  if ($watch.WaitForExit(240000)) { $watchExit = $watch.ExitCode } else { Stop-Process -Id $watch.Id -Force; $watchExit = "killed" }
}
Add-Check "watch discovers the newly added task and drains it" ([string]$status.Out -match "(?m)^\s*c\s+done") "status after $latency s:`n$(([string]$status.Out).Trim())"
Add-Check "stop exits 0 and watch drains to exit 0" ($stop.Code -eq 0 -and $watchExit -eq 0) "stop exit $($stop.Code); watch exit $watchExit"
Add-Check "watch releases its lock" (-not (Test-Path $lock)) "lock present after exit: $(Test-Path $lock)"

$logC = Read-RunLog "c"
Add-Check "watch leaves the same per-task run-*.log evidence" ($logC -match "\[c\] claimed" -and $logC -match "\[c\] done") "c log lines: $(@($logC -split "`n").Count)"
$usageC = Read-Usage "c"
Add-Check "watch captures usage for c" ($usageC.Count -ge 1) "c: $($usageC.Count) usage record(s)"
$stateC = Read-State "c"
$sessionC = [string]$stateC.latestWorker.sessionId
Add-Check "c runs in its own fresh session" ($sessionC.Length -gt 0 -and $sessionC -ne $sessionA) "a/b=$sessionA c=$sessionC"

# --- 3. 重启路径（不耗额度）：stop 之后文档写的重启命令是 watch --resume；看板上已无待办，不会触发模型回合 ---
$stopFile = Join-Path $root ".taskctl\stop.requested"
$again = Invoke-Taskctl "stop-again" "stop --tasks-dir tasks"
$restartOut = Join-Path $root "watch-restart.out.log"
$restartErr = Join-Path $root "watch-restart.err.log"
$restarted = Start-Process -FilePath "node" -ArgumentList "`"$tsx`" `"$entry`" watch --config taskctl.json --resume" -WorkingDirectory $root -NoNewWindow -PassThru -RedirectStandardOutput $restartOut -RedirectStandardError $restartErr
$null = $restarted.Handle
try {
  $restartDeadline = (Get-Date).AddSeconds(60)
  while (-not (Test-Path $lock) -and (Get-Date) -lt $restartDeadline -and -not $restarted.HasExited) { Start-Sleep -Milliseconds 500 }
  Start-Sleep -Milliseconds 300
  Add-Check "watch --resume restarts a stopped queue and clears the stop request" ((Test-Path $lock) -and -not (Test-Path $stopFile)) "lock: $(Test-Path $lock); stop request still present: $(Test-Path $stopFile); stderr: $((Read-TextFile $restartErr).Trim())"
} finally {
  # 同样不能留下常驻进程。
  $restartStop = Invoke-Taskctl "stop-restart" "stop --tasks-dir tasks"
  if ($restarted.WaitForExit(240000)) { $restartExit = $restarted.ExitCode } else { Stop-Process -Id $restarted.Id -Force; $restartExit = "killed" }
}
Add-Check "the restarted watch drains to exit 0 through stop" ($restartStop.Code -eq 0 -and $restartExit -eq 0) "stop exit $($restartStop.Code); watch exit $restartExit"

Write-Host ""
$checks | Format-Table -AutoSize -Wrap | Out-String -Width 200 | Write-Host
Write-Host "watch stdout:"
Write-Host (Read-TextFile $watchOut)
$watchErrText = Read-TextFile $watchErr
if ($watchErrText.Trim().Length -gt 0) { Write-Host "watch stderr:"; Write-Host $watchErrText }
Write-Host "b journal:"
Write-Host $journalB

$failed = @($checks | Where-Object { $_.Result -eq "FAIL" }).Count
if ($failed -eq 0) { Write-Host "LIVE PHASE 2 PASS ($($checks.Count) checks)"; exit 0 }
Write-Host "LIVE PHASE 2 FAIL：$failed 项断言失败"
exit 1
