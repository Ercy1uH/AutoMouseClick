# 手验驱动：把真实运行打到外部观测窗口上，按"目标实收"判定，不看进度条也不看业务回调。
#
# 覆盖：S1 基线（左键+右键，精确坐标）/ S2 双击中途暂停（两下必须相邻同坐标）/
#       S3 暂停中抢走前台（恢复前台点对，或明确失败，不得错点）。
# 未覆盖：DPI 缩放矩阵（需要人工切换系统缩放）、最小化/最大化/无边框矩阵 —— 见 releases/archive/BUILD_RECORD-1.4.2.md。
param(
  [string]$Root = '',
  [int]$Port = 28391,
  [string]$Token = [guid]::NewGuid().ToString('N')
)

$ErrorActionPreference = 'Stop'
if (-not $Root) { $Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path }
$here = $PSScriptRoot

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WinProbe {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  public static int[] ClientSize(long handle) { RECT r; GetClientRect(new IntPtr(handle), out r); return new int[] { r.Right - r.Left, r.Bottom - r.Top }; }
}
'@

$results = New-Object System.Collections.ArrayList
function Record([string]$case, [bool]$ok, [string]$detail) {
  [void]$results.Add([pscustomobject]@{ Case = $case; Pass = $ok; Detail = $detail })
  $mark = 'FAIL'
  if ($ok) { $mark = 'PASS' }
  Write-Output ('[' + $mark + '] ' + $case + ' :: ' + $detail)
}

$work = Join-Path $env:TEMP ('mouseclik-manual-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $work | Out-Null
$dataDir = Join-Path $work 'data'
New-Item -ItemType Directory -Path $dataDir | Out-Null

function Start-Observer([string]$title, [string]$slug) {
  $log = Join-Path $work ($slug + '.log')
  $handleFile = Join-Path $work ($slug + '.handle')
  $observerArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $here 'observer-window.ps1'), '-LogPath', $log, '-HandlePath', $handleFile, '-Title', $title)
  # Start-Process 不给数组元素自动加引号，含空格的参数会被拆开 —— 标题一律不带空格；
  # 顺带把子进程 stderr 落到文件，不就绪时能直接说清原因。
  $errFile = Join-Path $work ($slug + '.err.txt')
  # 不能以最小化启动：服务端的窗口枚举会跳过 IsIconic 的窗口，目标会"找不到"
  $process = Start-Process -FilePath 'powershell.exe' -ArgumentList $observerArgs -PassThru -WindowStyle Normal -RedirectStandardError $errFile
  for ($i = 0; $i -lt 150 -and -not (Test-Path $handleFile); $i++) { Start-Sleep -Milliseconds 100 }
  if (-not (Test-Path $handleFile)) {
    $why = 'no stderr'
    if (Test-Path $errFile) { $why = (Get-Content $errFile -Raw) }
    throw ('observer not ready: ' + $title + ' :: ' + $why)
  }
  return [pscustomobject]@{ Process = $process; Log = $log; Handle = (Get-Content $handleFile -Raw).Trim() }
}

$serverProcess = $null
function Start-Server {
  $env:PORT = [string]$Port
  $env:MOUSECLIK_DATA = $dataDir
  $env:MOUSECLIK_SERVER_TOKEN = $Token
  $script:serverProcess = Start-Process -FilePath 'node' -ArgumentList @((Join-Path $Root 'src\main\server.js')) -PassThru -WindowStyle Hidden -WorkingDirectory $Root
  for ($i = 0; $i -lt 120; $i++) {
    try {
      $health = Invoke-RestMethod ('http://127.0.0.1:' + $Port + '/api/health') -Headers @{ 'X-MouseClik-Token' = $Token } -TimeoutSec 1
      if ($health.app -eq 'mouseclik') { return }
    } catch { }
    Start-Sleep -Milliseconds 100
  }
  throw 'server did not become healthy'
}
function Stop-Server { if ($script:serverProcess -and -not $script:serverProcess.HasExited) { Stop-Process -Id $script:serverProcess.Id -Force -ErrorAction SilentlyContinue } }

function Start-Run([string]$handle, $steps) {
  $client = [WinProbe]::ClientSize([int64]$handle)
  $body = @{ windowId = $handle; profileName = 'manual'; steps = $steps; loops = 1; captureWidth = $client[0]; captureHeight = $client[1] } | ConvertTo-Json -Depth 8
  return Invoke-RestMethod ('http://127.0.0.1:' + $Port + '/api/run') -Method Post -Headers @{ 'X-MouseClik-Token' = $Token } -ContentType 'application/json' -Body $body
}
function Get-Status([string]$runId) { return Invoke-RestMethod ('http://127.0.0.1:' + $Port + '/api/run/' + $runId + '/status') -Headers @{ 'X-MouseClik-Token' = $Token } }
function Send-Control([string]$runId, [string]$action) {
  $body = @{ action = $action } | ConvertTo-Json
  Invoke-RestMethod ('http://127.0.0.1:' + $Port + '/api/run/' + $runId + '/control') -Method Post -Headers @{ 'X-MouseClik-Token' = $Token } -ContentType 'application/json' -Body $body | Out-Null
}
function Wait-Status([string]$runId, [string[]]$wanted, [int]$timeoutMs = 15000) {
  $deadline = (Get-Date).AddMilliseconds($timeoutMs)
  $status = $null
  while ((Get-Date) -lt $deadline) {
    $status = Get-Status $runId
    if ($wanted -contains $status.status) { return $status }
    Start-Sleep -Milliseconds 50
  }
  return $status
}
function Read-Events([string]$log) {
  if (-not (Test-Path $log)) { return @() }
  $items = New-Object System.Collections.ArrayList
  foreach ($line in (Get-Content $log)) {
    if ($line -notmatch 'msg=0x') { continue }
    $parts = $line -split ' '
    [void]$items.Add([pscustomobject]@{
      Time = [datetime]::Parse($parts[0]).ToUniversalTime()
      Msg = $parts[1].Substring(4)
      X = [int]$parts[2].Substring(2)
      Y = [int]$parts[3].Substring(2)
    })
  }
  return $items
}
function Click-Down($events) { return @($events | Where-Object { $_.Msg -eq '0x0201' }) }
function Right-Down($events) { return @($events | Where-Object { $_.Msg -eq '0x0204' }) }

$observer = $null
$intruder = $null
try {
  Start-Server
  $observer = Start-Observer 'MouseClikObserver' 'observer'
  Start-Sleep -Milliseconds 700

  # ---------- S1 基线 ----------
  $p1 = @{ x = 120; y = 140 }
  $p2 = @{ x = 300; y = 220 }
  $steps1 = @(
    @{ type = 'click'; x = $p1.x; y = $p1.y; label = 'p1'; labelAuto = $false; clickType = '左键单击'; clickCount = 1 },
    @{ type = 'delay'; ms = 150 },
    @{ type = 'click'; x = $p2.x; y = $p2.y; label = 'p2'; labelAuto = $false; clickType = '右键单击'; clickCount = 1 }
  )
  $run1 = Start-Run $observer.Handle $steps1
  $final1 = Wait-Status $run1.runId @('completed', 'error', 'stopped')
  Start-Sleep -Milliseconds 400
  $events1 = Read-Events $observer.Log
  $left1 = Click-Down $events1
  $right1 = Right-Down $events1
  $leftOk = ($left1.Count -eq 1) -and ($left1[0].X -eq $p1.x) -and ($left1[0].Y -eq $p1.y)
  $rightOk = ($right1.Count -eq 1) -and ($right1[0].X -eq $p2.x) -and ($right1[0].Y -eq $p2.y)
  $detail1 = 'status=' + $final1.status + ' left=' + $left1.Count + ' right=' + $right1.Count
  if ($left1.Count -gt 0) { $detail1 += ' leftAt=' + $left1[0].X + ',' + $left1[0].Y + ' 期望=' + $p1.x + ',' + $p1.y }
  if ($right1.Count -gt 0) { $detail1 += ' rightAt=' + $right1[0].X + ',' + $right1[0].Y + ' 期望=' + $p2.x + ',' + $p2.y }
  Record 'S1 基线（左键+右键，精确坐标）' (($final1.status -eq 'completed') -and $leftOk -and $rightOk) $detail1

  # ---------- S2 双击中途暂停 ----------
  $beforeCount = (Read-Events $observer.Log).Count
  $dbl = @{ x = 420; y = 320 }
  $steps2 = @(@{ type = 'click'; x = $dbl.x; y = $dbl.y; label = 'dbl'; labelAuto = $false; clickType = '双击'; clickCount = 1 })
  $run2 = Start-Run $observer.Handle $steps2
  Send-Control $run2.runId 'pause'
  Start-Sleep -Milliseconds 120
  $paused2 = Wait-Status $run2.runId @('paused', 'completed', 'error')
  if ($paused2.status -eq 'paused') { Start-Sleep -Milliseconds 900; Send-Control $run2.runId 'resume' }
  $final2 = Wait-Status $run2.runId @('completed', 'error', 'stopped')
  Start-Sleep -Milliseconds 300
  $events2 = @(Read-Events $observer.Log | Select-Object -Skip $beforeCount)
  $clicks2 = Click-Down $events2
  $gaps = @()
  for ($i = 1; $i -lt $clicks2.Count; $i++) { $gaps += [math]::Round(($clicks2[$i].Time - $clicks2[$i - 1].Time).TotalMilliseconds) }
  $onSpot = @($clicks2 | Where-Object { $_.X -eq $dbl.x -and $_.Y -eq $dbl.y }).Count
  $s2ok = ($paused2.status -eq 'paused') -and ($clicks2.Count -eq 2) -and ($onSpot -eq 2) -and ($gaps.Count -eq 1) -and ($gaps[0] -le 500)
  Record 'S2 双击中途暂停（两下必须相邻同坐标）' $s2ok ('paused=' + $paused2.status + ' clicks=' + $clicks2.Count + ' 同坐标=' + $onSpot + ' 间隔ms=' + ($gaps -join ',') + ' 总状态=' + $final2.status)

  # ---------- S3 暂停中抢走前台 ----------
  $intruder = Start-Observer 'MouseClikIntruder' 'intruder'
  $p3 = @{ x = 200; y = 200 }
  $p4 = @{ x = 200; y = 260 }
  $before3 = (Read-Events $observer.Log).Count
  $steps3 = @(
    @{ type = 'click'; x = $p3.x; y = $p3.y; label = 'p3'; labelAuto = $false; clickType = '左键单击'; clickCount = 1 },
    @{ type = 'delay'; ms = 700 },
    @{ type = 'click'; x = $p4.x; y = $p4.y; label = 'p4'; labelAuto = $false; clickType = '左键单击'; clickCount = 1 }
  )
  $run3 = Start-Run $observer.Handle $steps3
  Start-Sleep -Milliseconds 200
  Send-Control $run3.runId 'pause'
  $paused3 = Wait-Status $run3.runId @('paused', 'completed', 'error')
  $foreground = 'n/a'
  if ($paused3.status -eq 'paused') {
    $foreground = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $here 'steal-foreground.ps1') -Handle ([int64]$intruder.Handle)
    Send-Control $run3.runId 'resume'
  }
  $final3 = Wait-Status $run3.runId @('completed', 'error', 'stopped')
  Start-Sleep -Milliseconds 400
  $events3 = @(Read-Events $observer.Log | Select-Object -Skip $before3)
  $clicks3 = Click-Down $events3
  $onExpected = @($clicks3 | Where-Object { ($_.X -eq $p3.x -and $_.Y -eq $p3.y) -or ($_.X -eq $p4.x -and $_.Y -eq $p4.y) }).Count
  $recovered = ($final3.status -eq 'completed') -and ($onExpected -eq 2)
  $refused = ($final3.status -eq 'error') -and ($final3.errorCode -eq 'TARGET_NOT_FOREGROUND') -and ($clicks3.Count -eq 0)
  $detail3 = '前台被切到=' + $foreground + ' status=' + $final3.status + ' errorCode=' + $final3.errorCode + ' 目标实收=' + $clicks3.Count + ' 落在选定点=' + $onExpected
  Record 'S3 暂停后抢走前台（恢复前台点对，或明确失败）' ($recovered -or $refused) $detail3
}
finally {
  Stop-Server
  foreach ($item in @($observer, $intruder)) { if ($item -and -not $item.Process.HasExited) { Stop-Process -Id $item.Process.Id -Force -ErrorAction SilentlyContinue } }
  Write-Output ('工作目录：' + $work)
  $failed = @($results | Where-Object { -not $_.Pass })
  Write-Output ('手动验证小结：' + ($results.Count - $failed.Count) + '/' + $results.Count + ' 通过')
  if ($failed.Count) { exit 1 }
}
