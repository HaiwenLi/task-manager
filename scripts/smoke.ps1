# 真实 opencode 冒烟：一个临时任务，走完 add → run → review → done
#
#   .\scripts\smoke.ps1              # 只准备临时项目并打印命令，不调用模型
#   .\scripts\smoke.ps1 -Live        # 真跑一次（会消耗模型额度）
#
# 退出码：0 通过；1 任务没有注册或没有到 done；2 环境不满足（找不到 opencode 或 node）。
param(
  [switch]$Live,
  [string]$OpencodeExe = ""
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

$root = Join-Path $env:TEMP ("taskctl-smoke-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
$bin = Join-Path $root "bin"
New-Item -ItemType Directory -Force -Path (Join-Path $root "tasks"), (Join-Path $root "work"), $bin | Out-Null

# agent 要在自己的回合里调用 taskctl done，所以 PATH 上必须能找到一个 shim
$tsx = Join-Path $repo "node_modules\tsx\dist\cli.mjs"
$entry = Join-Path $repo "src\main.ts"
if (-not (Test-Path $tsx)) { Write-Error "缺少 tsx：先在仓库里 npm ci"; exit 2 }
@"
@echo off
node "$tsx" "$entry" %*
"@ | Set-Content (Join-Path $bin "taskctl.cmd") -Encoding ascii

@{
  tasksDir = "tasks"
  workdir = "work"
  opencodeBin = $OpencodeExe
  parallel = 1
  turnTimeoutMs = 180000
  acceptanceTimeoutMs = 60000
  maxTurnsPerSession = 3
  maxSessionsPerTask = 1
  retryLimit = 1
} | ConvertTo-Json | Set-Content (Join-Path $root "taskctl.json") -Encoding utf8

@'
---
schema: taskctl/v1
title: 写一个 hello 文件
status: open
acceptance: node -e "process.exit(require('fs').readFileSync('hello.txt','utf8').trim()==='hi'?0:1)"
criteria:
  - C1 hello.txt 存在且内容为 hi
complexity: simple
sessions: []
retries: 0
review_rounds: 0
---
在工作目录创建 hello.txt，内容为 hi。完成后运行 taskctl done --task 001-hello 请求完成。
'@ | Set-Content (Join-Path $root "tasks\001-hello.md") -Encoding utf8

# 注册守卫不耗模型额度，两种模式都跑：没有声明 schema 的任务文件会被归入 ignored，
# run 面对空看板什么也不做，后面的 done 检查只会白白失败。
$env:PATH = "$bin;$env:PATH"
Push-Location $root
$board = (taskctl status --tasks-dir tasks) -join "`n"
Pop-Location

Write-Host "临时项目：$root"
Write-Host "opencode：$OpencodeExe"
Write-Host ""
Write-Host $board
if ($board -notmatch "001-hello\s+open") {
  Write-Error "冒烟任务 001-hello 没有注册为 open（看板见上）；先修本脚本里的任务文件。"
  exit 1
}
if (-not $Live) {
  Write-Host ""
  Write-Host "未加 -Live，只准备了环境。真跑："
  Write-Host "  `$env:PATH = `"$bin;`$env:PATH`"; Push-Location '$root'; taskctl run --config taskctl.json; Pop-Location"
  exit 0
}

Push-Location $root
try {
  taskctl run --config taskctl.json
  $report = taskctl report --task 001-hello --tasks-dir (Join-Path $root "tasks")
  $status = (taskctl status --tasks-dir (Join-Path $root "tasks")) -join "`n"
  Write-Host "`n$report"
  Write-Host "`n$status"
  if ($status -match "001-hello\s+done") { Write-Host "`nSMOKE PASS"; exit 0 }
  Write-Host "`nSMOKE FAIL：任务没有到 done"
  exit 1
} finally {
  Pop-Location
}
