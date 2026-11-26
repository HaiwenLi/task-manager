# stop --now 的排练脚本：先只准备环境（不碰后端、不花额度），再用 -Live 在真实后端上验证
# 操作员的中断确实切断了进行中的回合与验收命令，并把任务原样还回看板。
#
#   .\scripts\live-stop.ps1            # 只准备环境、校验注册，并在真实进程上走一遍 stop --now 与 watch 的拒绝；不调模型
#   .\scripts\live-stop.ps1 -Live      # 17 项断言；通过时打印 LIVE STOP PASS（约 4 个 worker 回合）
#
# 退出码：0 全部断言通过；1 有断言失败；2 环境不满足（找不到 opencode、node 或 tsx）。
param(
  [switch]$Live,
  [string]$OpencodeExe = "",
  [string]$Model = "zhipuai-coding-plan/glm-5.3-flash"
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot

if (-not $OpencodeExe) {
  $candidate = Join-Path $env:APPDATA "npm\node_modules\@opencode\cli\bin\opencode.exe"
  if (Test-Path $candidate) { $OpencodeExe = $candidate }
}
if (-not (Test-Path $OpencodeExe)) {
  Write-Error "找不到 opencode 可执行文件（.cmd shim 不能被 shell:false 启动）。用 -OpencodeExe 指定真实 exe。"
  exit 2
}
$opencodeName = Split-Path -Leaf $OpencodeExe

$root = Join-Path $env:TEMP ("taskctl-live-stop-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
$bin = Join-Path $root "bin"
$tasks = Join-Path $root "tasks"
$workdir = Join-Path $root "work"
New-Item -ItemType Directory -Force -Path $tasks, $workdir, $bin | Out-Null

# agent 要在自己的回合里调用 taskctl done，所以 PATH 上必须能找到一个 shim
$tsx = Join-Path $repo "node_modules\tsx\dist\cli.mjs"
$entry = Join-Path $repo "src\main.ts"
if (-not (Test-Path $tsx)) { Write-Error "缺少 tsx：先在仓库里 npm ci"; exit 2 }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Error "找不到 node。"; exit 2 }
Set-Content -Path (Join-Path $bin "taskctl.cmd") -Encoding ascii -Value "@echo off`r`nnode `"$tsx`" `"$entry`" %*`r`n"

# allowedModels 是窄到不能再窄的放行：护栏 (ADR-0012) 会先判每个模型，目录不报"免费"的
# 模型只有被点名才放行。这里点名 -Model，判定本身仍由目录回答，脚本不猜。
@{
  tasksDir = "tasks"
  workdir = "work"
  opencodeBin = $OpencodeExe
  model = $Model
  parallel = 1
  turnTimeoutMs = 300000
  acceptanceTimeoutMs = 180000
  retryLimit = 1
  allowedModels = @($Model)
} | ConvertTo-Json | Set-Content (Join-Path $root "taskctl.json") -Encoding utf8

function Write-StopTask([string]$Path, [string]$Id, [string]$Acceptance, [string]$Instruction) {
  $lines = @(
    "---",
    "schema: taskctl/v1",
    "title: create $Id.txt",
    "status: open",
    "verify: mechanical",
    "acceptance: $Acceptance",
    "criteria:",
    "  - C1 $Id.txt exists and its trimmed content is $Id",
    "complexity: simple",
    "sessions: []",
    "retries: 0",
    "review_rounds: 0",
    "---",
    $Instruction
  )
  Set-Content -Path $Path -Value $lines -Encoding utf8
}

# a 的回合先等 30 秒：stop --now 必须落在进行中的回合上，而不是回合之间的空隙。
$aInstruction = '先在工作目录运行 `node -e "setTimeout(()=>{},30000)"`（等待 30 秒），再创建 a.txt（只有一行：a），完成后运行 taskctl done --task a。不要创建其它文件。'
$aAcceptance = 'node -e "process.exit(require(''fs'').readFileSync(''a.txt'',''utf8'').trim()===''a''?0:1)"'
# b 的验收门等 gate.go：它可以被整条切断，之后 gate.go 一出现就立刻通过。
$bAcceptance = 'node -e "const fs=require(''fs'');const t=Date.now();(function w(){if(fs.existsSync(''gate.go''))process.exit(0);if(Date.now()-t>180000)process.exit(2);setTimeout(w,200)})()"'
Write-StopTask (Join-Path $tasks "a.md") "a" $aAcceptance $aInstruction
Write-StopTask (Join-Path $tasks "b.md") "b" $bAcceptance '在工作目录创建 b.txt，文件里只有一行：b。完成后运行 taskctl done --task b。不要创建其它文件。'

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

function Invoke-Taskctl([string]$Name, [string]$CliArgs, [int]$TimeoutMs = 0) {
  $outFile = Join-Path $root "$Name.out.log"
  $errFile = Join-Path $root "$Name.err.log"
  $process = Start-Process -FilePath "node" -ArgumentList "`"$tsx`" `"$entry`" $CliArgs" -WorkingDirectory $root -NoNewWindow -PassThru -RedirectStandardOutput $outFile -RedirectStandardError $errFile
  if ($TimeoutMs -gt 0) {
    if (-not $process.WaitForExit($TimeoutMs)) {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
      return [pscustomobject]@{ Code = -1; Out = (Read-TextFile $outFile); Err = ((Read-TextFile $errFile) + "`n[脚本等待 $TimeoutMs 毫秒后放弃]") }
    }
  } else {
    $process.WaitForExit()
  }
  return [pscustomobject]@{ Code = $process.ExitCode; Out = (Read-TextFile $outFile); Err = (Read-TextFile $errFile) }
}

Write-Host "临时项目：$root"
Write-Host "opencode：$OpencodeExe"
Write-Host "model：$Model"
Write-Host ""

# 注册守卫不耗模型额度，两种模式都跑（与 smoke.ps1 / live-phase2.ps1 相同的理由）。
$board = Invoke-Taskctl "status" "status --tasks-dir tasks"
Write-Host $board.Out
if ($board.Out -notmatch "(?m)^\s*a\s+open" -or $board.Out -notmatch "(?m)^\s*b\s+open") {
  Write-Error "任务 a / b 没有注册为 open（看板见上）。"
  exit 1
}
if ($board.Out -match "ignored \(") {
  Write-Error "看板里有被忽略的文件：$($board.Out)"
  exit 1
}

$stopFile = Join-Path $root ".taskctl\stop.requested"
$nowFile = Join-Path $root ".taskctl\stop-now.requested"

if (-not $Live) {
  # 真实的 stop --now：不启动任何控制器，只写两个请求文件。
  $stopNow = Invoke-Taskctl "stop-now" "stop --tasks-dir tasks --now" 60000
  if ($stopNow.Code -ne 0 -or -not (Test-Path $stopFile) -or -not (Test-Path $nowFile)) {
    Write-Error "stop --now 没有留下两个请求文件（exit $($stopNow.Code)）：$($stopNow.Err.Trim())"
    exit 1
  }
  # 没有 --resume 的 watch 必须在读模型目录之前拒绝：这正是这一半不连后端的原因。
  $refused = Invoke-Taskctl "watch-refusal" "watch --config taskctl.json" 120000
  if ($refused.Code -ne 1 -or $refused.Err -notmatch "watch --resume") {
    Write-Error "没有 --resume 的 watch 应被拒绝（exit 1，stderr 提到 watch --resume）：exit $($refused.Code)；stderr $($refused.Err.Trim())"
    exit 1
  }
  # 两个文件都清掉，Task 12 才能在这个项目里直接起一个普通的 watch。
  Remove-Item -Force $stopFile, $nowFile
  if ((Test-Path $stopFile) -or (Test-Path $nowFile)) {
    Write-Error "两个停止请求文件没有删掉。"
    exit 1
  }
  Write-Host ""
  Write-Host "未加 -Live：只准备了环境，并在真实进程上走了一遍 stop --now 与 watch 的拒绝。真跑："
  Write-Host "  pwsh -File scripts/live-stop.ps1 -Live"
  exit 0
}

$checks = New-Object System.Collections.Generic.List[object]
function Add-Check([string]$Name, [bool]$Ok, [string]$Detail) {
  $checks.Add([pscustomobject]@{ Check = $Name; Result = $(if ($Ok) { "PASS" } else { "FAIL" }); Detail = $Detail })
}

function Read-Json([string]$Path) {
  $text = Read-TextFile $Path
  if ($text.Trim().Length -eq 0) { return $null }
  try { return $text | ConvertFrom-Json } catch { return $null }
}

# 有界等待：条件为真立刻返回；到点返回 $false，由调用方把"等的是什么"写进断言里。
function Wait-Until([int]$TimeoutSeconds, [scriptblock]$Condition, [int]$IntervalMs = 500) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ($true) {
    if (& $Condition) { return $true }
    if ((Get-Date) -ge $deadline) { return $false }
    Start-Sleep -Milliseconds $IntervalMs
  }
}

# Windows 上控制器的工作进程各自跑在隐藏控制台里，Get-CimInstance 仍按命令行列出它们。
function Get-Processes([string]$Name) {
  return @(Get-CimInstance Win32_Process -Filter "Name='$Name'" | Select-Object ProcessId, ParentProcessId, Name, CommandLine)
}
function Find-Processes([string]$Name, [string]$Text) {
  return @(Get-Processes $Name | Where-Object { $null -ne $_.CommandLine -and $_.CommandLine.Contains($Text) })
}

# 一个 watch 连同它的整棵进程树都停掉（最后手段；正常路径由控制器自己的取消完成）。
function Stop-ProcessTree([int]$RootProcessId) {
  $all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)
  $byParent = @{}
  foreach ($row in $all) {
    $parentKey = [int]$row.ParentProcessId
    if (-not $byParent.ContainsKey($parentKey)) { $byParent[$parentKey] = New-Object System.Collections.Generic.List[int] }
    $byParent[$parentKey].Add([int]$row.ProcessId)
  }
  $ordered = New-Object System.Collections.Generic.List[int]
  $queue = New-Object System.Collections.Generic.Queue[int]
  $queue.Enqueue($RootProcessId)
  while ($queue.Count -gt 0) {
    $current = $queue.Dequeue()
    $children = $byParent[$current]
    if ($null -eq $children) { continue }
    foreach ($child in $children) { $ordered.Add($child); $queue.Enqueue($child) }
  }
  for ($i = $ordered.Count - 1; $i -ge 0; $i--) { Stop-Process -Id $ordered[$i] -Force -ErrorAction SilentlyContinue }
  Stop-Process -Id $RootProcessId -Force -ErrorAction SilentlyContinue
}

function Start-Watch([string]$Name, [string]$ExtraArgs) {
  $outFile = Join-Path $root "$Name.out.log"
  $errFile = Join-Path $root "$Name.err.log"
  $process = Start-Process -FilePath "node" -ArgumentList "`"$tsx`" `"$entry`" watch --config taskctl.json $ExtraArgs" -WorkingDirectory $root -NoNewWindow -PassThru -RedirectStandardOutput $outFile -RedirectStandardError $errFile
  $null = $process.Handle
  return [pscustomobject]@{ Name = $Name; Process = $process; Out = $outFile; Err = $errFile }
}

# 有界等待 watch 退出；返回退出码，超时返回 $null 并把进程留给 finally。
function Wait-ForWatch($Watch, [int]$TimeoutMs) {
  if ($Watch.Process.WaitForExit($TimeoutMs)) { return $Watch.Process.ExitCode }
  return $null
}

$watches = New-Object System.Collections.Generic.List[object]
$currentWatch = $null
$aborted = ""
try {
  # --- 行 0：护栏放行排练用的模型（只读目录，不启动会话） ---
  $models = Invoke-Taskctl "models" "models --config taskctl.json" 120000
  $modelLine = @(([string]$models.Out) -split "`r?`n" | Where-Object { $_ -match [regex]::Escape($Model) } | Select-Object -First 1)
  $modelAllowed = ($models.Code -eq 0) -and ($modelLine.Count -gt 0 -and $modelLine[0] -match "放行")
  Add-Check "row 0: the guard allows the rehearsal's model" $modelAllowed "exit $($models.Code); $($modelLine -join ' ')"
  if (-not $modelAllowed) {
    throw "护栏不放行 $Model（看行 0）：什么也没跑，先看 taskctl models 的判定。"
  }

  # --- 行 1：a 的回合在进行中时 stop --now ---
  $currentWatch = Start-Watch "watch-a" ""
  $watches.Add($currentWatch)
  $waitState = @{ detail = "" }
  $inFlight = Wait-Until 180 {
    $found = @(Find-Processes "node.exe" 'setTimeout(()=>{},30000)')
    $waitState.detail = "命令行含 setTimeout(()=>{},30000) 的 node.exe：$($found.Count) 个"
    return $found.Count -gt 0
  } 1000
  if (-not $inFlight) {
    Add-Check "row 1: stop --now exits 0 while a's turn is in flight" $false "等了 180 秒，a 的回合没有进入等待（$($waitState.detail)）"
    throw "等了 180 秒，a 的回合仍未进入那 30 秒的等待；无法在回合中途验证 stop --now。"
  }
  $stopA = Invoke-Taskctl "stop-now-a" "stop --tasks-dir tasks --now" 60000
  Add-Check "row 1: stop --now exits 0 while a's turn is in flight" ($stopA.Code -eq 0) "$($waitState.detail)；stop exit $($stopA.Code)；stderr: $($stopA.Err.Trim())"

  # --- 行 2：中断被确认，watch 干净退出 ---
  $watchExitA = Wait-ForWatch $currentWatch 240000
  Add-Check "row 2: watch exits 0 after the confirmed stop" ($watchExitA -eq 0) "exit $watchExitA"
  if ($null -eq $watchExitA) { throw "stop --now 之后 240 秒内 watch 没有退出。" }
  $currentWatch = $null

  # --- 行 3 与行 8：a 回到 open 且不花 retry；b 没被领取 ---
  $statusA = Invoke-Taskctl "status-after-stop" "status --tasks-dir tasks"
  $aOpen = [bool](([string]$statusA.Out) -match "(?m)^\s*a\s+open\s+0(\s|$)")
  Add-Check "row 3: a is open with retries 0" $aOpen ($statusA.Out.Trim())

  # --- 行 4：这次尝试结算为"被操作员停止" ---
  $attemptA = Read-Json (Join-Path $tasks "a\attempt.json")
  $settled = ($null -ne $attemptA) -and ([string]$attemptA.phase -eq "settled") -and ([string]$attemptA.reason -eq "stopped by operator")
  Add-Check "row 4: a's attempt settled as stopped by operator" $settled "phase=$($attemptA.phase) operation=$($attemptA.operation) reason=$($attemptA.reason)"

  # --- 行 5：日志说这次是 stopped ---
  $journalA = Read-TextFile (Join-Path $tasks "a\journal.md")
  Add-Check "row 5: a's journal records worker stopped" ([bool]($journalA -match "worker  stopped")) (($journalA -split "`r?`n" | Where-Object { $_ -match "worker  stopped" }) -join " | ")

  # --- 行 6：被切断的会话记为不干净 ---
  $stateA = Read-Json (Join-Path $tasks "a\execution-state.json")
  $clean = $null
  if ($null -ne $stateA -and $null -ne $stateA.latestWorker) { $clean = $stateA.latestWorker.clean }
  Add-Check "row 6: latestWorker.clean is false" (($null -ne $clean) -and ($clean -eq $false)) "latestWorker.clean=$clean session=$($stateA.latestWorker.sessionId)"

  # --- 行 7：锁与工作区预留都已释放 ---
  $taskLock = Join-Path $tasks "a\lock.json"
  $workspaceLock = Join-Path $workdir ".taskctl-workspace.lock"
  Add-Check "row 7: the task lock and the workspace reservation are gone" ((-not (Test-Path $taskLock)) -and (-not (Test-Path $workspaceLock))) "lock.json: $(Test-Path $taskLock)；workspace lock: $(Test-Path $workspaceLock)"

  # --- 行 8：批次没有继续到 b ---
  $attemptB1 = Join-Path $tasks "b\attempt.json"
  $bIdle = [bool](([string]$statusA.Out) -match "(?m)^\s*b\s+open\s+0(\s|$)") -and -not (Test-Path $attemptB1)
  Add-Check "row 8: b is open and has no attempt record" $bIdle "b attempt.json: $(Test-Path $attemptB1)；$($statusA.Out.Trim())"

  # --- 行 9：被切断的回合没有留下进程 ---
  $tailState = @{ detail = "" }
  $noTail = Wait-Until 20 {
    $clients = @(Find-Processes $opencodeName " run ")
    $waits = @(Find-Processes "node.exe" 'setTimeout(()=>{},30000)')
    $tailState.detail = "$opencodeName run：$($clients.Count) 个；node.exe 等 30 秒：$($waits.Count) 个"
    return ($clients.Count -eq 0 -and $waits.Count -eq 0)
  } 1000
  Add-Check "row 9: no process of the cut turn is left" $noTail $tailState.detail

  # --- 行 10：被切断的会话在服务端已经是空闲的 ---
  $cutSession = ""
  if ($null -ne $stateA -and $null -ne $stateA.latestWorker) { $cutSession = [string]$stateA.latestWorker.sessionId }
  if ($cutSession.Length -eq 0 -and $null -ne $attemptA) { $cutSession = [string]$attemptA.sessionId }
  $idleValue = $null
  $apiExit = $null
  if ($cutSession.Length -gt 0) {
    $apiOut = Join-Path $root "session-get.out.log"
    $apiErr = Join-Path $root "session-get.err.log"
    $api = Start-Process -FilePath $OpencodeExe -ArgumentList "api session.get --param sessionID=$cutSession" -WorkingDirectory $root -NoNewWindow -PassThru -RedirectStandardOutput $apiOut -RedirectStandardError $apiErr
    if ($api.WaitForExit(30000)) {
      $apiExit = $api.ExitCode
      $envelope = $null
      try { $envelope = (Read-TextFile $apiOut) | ConvertFrom-Json } catch { $envelope = $null }
      if ($null -ne $envelope -and $null -ne $envelope.data -and $null -ne $envelope.data.time) { $idleValue = $envelope.data.time.idle }
    } else {
      Stop-Process -Id $api.Id -Force -ErrorAction SilentlyContinue
    }
  }
  $idleNumeric = ($null -ne $idleValue) -and ($idleValue -is [int] -or $idleValue -is [long] -or $idleValue -is [double] -or $idleValue -is [decimal])
  Add-Check "row 10: the cut session is idle at the service" (($apiExit -eq 0) -and $idleNumeric) "session $cutSession；api exit $apiExit；data.time.idle=$idleValue"

  # --- 行 11：没有 --resume 的 watch 拒绝启动 ---
  $refused = Invoke-Taskctl "watch-refusal" "watch --config taskctl.json" 120000
  Add-Check "row 11: watch without --resume is refused" (($refused.Code -eq 1) -and ([bool]($refused.Err -match "watch --resume"))) "exit $($refused.Code)；stderr: $($refused.Err.Trim())"

  # --- 行 12：--resume 重跑 a，换一个会话并完成 ---
  $currentWatch = Start-Watch "watch-resume" "--resume"
  $watches.Add($currentWatch)
  $resumeState = @{ detail = "" }
  $doneA = Wait-Until 300 {
    Start-Sleep -Milliseconds 1500
    $snapshot = Invoke-Taskctl "status-resume" "status --tasks-dir tasks"
    $resumeState.detail = $snapshot.Out
    return [bool](([string]$snapshot.Out) -match "(?m)^\s*a\s+done\b")
  } 500
  $stateA2 = Read-Json (Join-Path $tasks "a\execution-state.json")
  $sessionA2 = ""
  if ($null -ne $stateA2 -and $null -ne $stateA2.latestWorker) { $sessionA2 = [string]$stateA2.latestWorker.sessionId }
  Add-Check "row 12: a is done on a fresh session after --resume" ($doneA -and $sessionA2.Length -gt 0 -and $sessionA2 -ne $cutSession) "a done: $doneA；session $sessionA2；cut session $cutSession"
  if (-not $doneA) { throw "watch --resume 之后 300 秒内 a 没有完成（最后看板见行 12）。" }

  # --- 行 13：b 的验收命令在跑时 stop --now ---
  $gateState = @{ detail = "" }
  $inGate = Wait-Until 300 {
    $attemptB = Read-Json (Join-Path $tasks "b\attempt.json")
    $gateState.detail = $(if ($null -eq $attemptB) { "b 还没有 attempt.json" } else { "phase=$($attemptB.phase) operation=$($attemptB.operation)" })
    return ($null -ne $attemptB -and [string]$attemptB.operation -eq "acceptance" -and [string]$attemptB.phase -eq "active")
  } 1000
  if (-not $inGate) {
    Add-Check "row 13: stop --now cuts the acceptance command and watch exits 0" $false "等了 300 秒，b 的验收命令没有在跑（$($gateState.detail)）"
    throw "等了 300 秒，b 的验收命令仍未进入执行；无法验证切断验收命令。"
  }
  $stopB = Invoke-Taskctl "stop-now-b" "stop --tasks-dir tasks --now" 60000
  $watchExitB = Wait-ForWatch $currentWatch 240000
  Add-Check "row 13: stop --now cuts the acceptance command and watch exits 0" (($stopB.Code -eq 0) -and ($watchExitB -eq 0)) "$($gateState.detail)；stop exit $($stopB.Code)；watch exit $watchExitB"
  if ($null -eq $watchExitB) { throw "切断验收命令之后 240 秒内 watch 没有退出。" }
  $currentWatch = $null

  # --- 行 14：b 原样回到 open，验收证据一个也没写 ---
  $statusB = Invoke-Taskctl "status-after-gate" "status --tasks-dir tasks"
  $bOpen = [bool](([string]$statusB.Out) -match "(?m)^\s*b\s+open\s+0(\s|$)")
  $acceptanceFile = Join-Path $tasks "b\acceptance.json"
  $failuresFile = Join-Path $tasks "b\acceptance-failures.json"
  Add-Check "row 14: b is open with retries 0 and no acceptance evidence" ($bOpen -and (-not (Test-Path $acceptanceFile)) -and (-not (Test-Path $failuresFile))) "acceptance.json: $(Test-Path $acceptanceFile)；acceptance-failures.json: $(Test-Path $failuresFile)；$($statusB.Out.Trim())"

  # --- 行 15：被切断的验收命令没有留下进程 ---
  $gateTail = @{ detail = "" }
  $noGate = Wait-Until 20 {
    $found = @(Find-Processes "node.exe" "gate.go")
    $gateTail.detail = "命令行含 gate.go 的 node.exe：$($found.Count) 个"
    return $found.Count -eq 0
  } 1000
  Add-Check "row 15: no process of the cut acceptance command is left" $noGate $gateTail.detail

  # --- 行 16：门等到了 gate.go，--resume 让 b 一次跑完 ---
  Set-Content -Path (Join-Path $workdir "gate.go") -Encoding ascii -Value "package main`r`n"
  $currentWatch = Start-Watch "watch-gate" "--resume"
  $watches.Add($currentWatch)
  $finalState = @{ detail = "" }
  $doneB = Wait-Until 300 {
    Start-Sleep -Milliseconds 1500
    $snapshot = Invoke-Taskctl "status-gate" "status --tasks-dir tasks"
    $finalState.detail = $snapshot.Out
    return [bool](([string]$snapshot.Out) -match "(?m)^\s*b\s+done\b")
  } 500
  Add-Check "row 16: b is done once gate.go exists" $doneB $finalState.detail
} catch {
  $aborted = $_.Exception.Message
} finally {
  # 无论中途出了什么错，都不能留下一个常驻的 watch 或它切断一半的回合。
  if ($null -ne $currentWatch -and -not $currentWatch.Process.HasExited) {
    $null = Invoke-Taskctl "cleanup-stop" "stop --tasks-dir tasks" 60000
    if (-not $currentWatch.Process.WaitForExit(60000)) {
      $null = Invoke-Taskctl "cleanup-stop-now" "stop --tasks-dir tasks --now" 60000
      if (-not $currentWatch.Process.WaitForExit(30000)) { Stop-ProcessTree $currentWatch.Process.Id }
    }
  }
  foreach ($marker in @('setTimeout(()=>{},30000)', 'gate.go')) {
    foreach ($found in @(Find-Processes "node.exe" $marker)) {
      Stop-Process -Id $found.ProcessId -Force -ErrorAction SilentlyContinue
    }
  }
}

Write-Host ""
$checks | Format-Table -AutoSize -Wrap | Out-String -Width 200 | Write-Host
foreach ($watch in $watches) {
  $outText = Read-TextFile $watch.Out
  if ($outText.Trim().Length -gt 0) { Write-Host "$($watch.Name) stdout:"; Write-Host $outText }
  $errText = Read-TextFile $watch.Err
  if ($errText.Trim().Length -gt 0) { Write-Host "$($watch.Name) stderr:"; Write-Host $errText }
}

$failed = @($checks | Where-Object { $_.Result -eq "FAIL" }).Count
if ($failed -eq 0 -and $aborted.Length -eq 0 -and $checks.Count -eq 17) {
  Write-Host "LIVE STOP PASS ($($checks.Count) checks)"
  exit 0
}
Write-Host "LIVE STOP FAIL：$failed 项断言失败"
if ($aborted.Length -gt 0) { Write-Host "  排练中途停下：$aborted" }
if ($checks.Count -ne 17) { Write-Host "  只跑了 $($checks.Count) 项断言（应为 17 项）" }
exit 1
