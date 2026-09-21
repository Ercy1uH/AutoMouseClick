param([string]$PayloadJson)

$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

try {
  $payload = $PayloadJson | ConvertFrom-Json -ErrorAction Stop
} catch {
  # RV-14：其它失败路径都会先 Emit-Event 带明确 code，这里过去只 exit 11，前端只能看到
  # “worker 异常退出（代码 11）”，没有字段也没有原因。注意此处 Emit-Event / $runId 尚未定义
  # （脚本按顺序执行），因此直接写一行 JSON。
  try {
    [Console]::Out.WriteLine((@{ type = 'error'; code = 'WORKER_PAYLOAD_INVALID'; message = $_.Exception.Message } | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
  } catch {
    # 报告失败不能掩盖真正的解析失败
  }
  exit 11
}

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class NativeMouse {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT point);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out int processId);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr processId);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
  [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr hWnd);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int command);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint count, [In] INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public MOUSEINPUT mi; }
  public const uint LeftDown = 0x0002;
  public const uint LeftUp = 0x0004;
  public const uint RightDown = 0x0008;
  public const uint RightUp = 0x0010;
  public const uint MiddleDown = 0x0020;
  public const uint MiddleUp = 0x0040;
  public const uint InputMouse = 0;
  public static uint SendMouseClick(int action) {
    uint down = action == 1 ? RightDown : action == 2 ? MiddleDown : LeftDown;
    uint up = action == 1 ? RightUp : action == 2 ? MiddleUp : LeftUp;
    var inputs = new INPUT[2];
    inputs[0].type = InputMouse;
    inputs[0].mi = new MOUSEINPUT { dx = 0, dy = 0, mouseData = 0, dwFlags = down, time = 0, dwExtraInfo = UIntPtr.Zero };
    inputs[1].type = InputMouse;
    inputs[1].mi = new MOUSEINPUT { dx = 0, dy = 0, mouseData = 0, dwFlags = up, time = 0, dwExtraInfo = UIntPtr.Zero };
    return SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT)));
  }
} 
'@

# Keep the worker in the same physical-pixel coordinate space as Electron.
try {
  if (-not [NativeMouse]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))) { $null = [NativeMouse]::SetProcessDPIAware() }
} catch {
  $null = [NativeMouse]::SetProcessDPIAware()
}

$runId = [string]$payload.runId
$window = [IntPtr]::new([Int64]$payload.windowId)
$targetProcessId = [int]$payload.targetProcessId
$steps = @($payload.steps)
$loops = [Math]::Max(1, [int]$payload.loops)
$loopInterval = [Math]::Max(0, [int]$payload.loopInterval)
$captureWidth = [Math]::Max(1, [int]$payload.captureWidth)
$captureHeight = [Math]::Max(1, [int]$payload.captureHeight)
$jitter = [bool]$payload.jitter
# RV-08：单击次数上限由 server.js 单一下发（point-settings.js 是唯一权威），不再在这里复制常量。
$script:maxPointClicks = [int]$payload.maxPointClicks
$controlPath = [string]$payload.controlPath
$random = [Random]::new()
$script:isPaused = $false
$script:completed = [long]0
$script:position = @{}

# total 口径：Σ clickCount × loops，与 server.js 的 totalClicks 保持一致
function Get-PointClickCount {
  param($Step)
  $clicks = 0
  if (-not [int]::TryParse([string]$Step.clickCount, [ref]$clicks)) { $clicks = 1 }
  if ($clicks -lt 1) { $clicks = 1 }
  # RV-08：上限来自载荷；单独跑/单测未下发时回落到 999，保证函数可独立测试。
  $limit = if ($script:maxPointClicks -gt 0) { [int]$script:maxPointClicks } else { 999 }
  if ($clicks -gt $limit) { $clicks = $limit }
  return $clicks
}

function Get-ClickAction {
  param([string]$ClickType)
  if ($ClickType -eq '右键单击') { return 1 }
  if ($ClickType -eq '中键单击') { return 2 }
  return 0
}

function Measure-Steps {
  param($Items, [bool]$Inside = $false)
  [long]$count = 0
  foreach ($item in $Items) {
    if ($item.type -eq 'loop') {
      if ($Inside -or @($item.steps).Count -eq 0 -or $item.repeatCount -lt 1 -or $item.repeatCount -gt 100000 -or [double]$item.repeatCount -ne [long]$item.repeatCount) { throw 'Invalid loop' }
      $count += [long]$item.repeatCount * (Measure-Steps @($item.steps) $true)
    } elseif ($item.type -eq 'click') { $count += Get-PointClickCount $item }
    elseif ($item.type -ne 'delay') { throw 'Unknown step type' }
  }
  return $count
}
$totalClicks = (Measure-Steps $steps) * [long]$loops

function Emit-Event {
  param([hashtable]$Data)
  foreach ($key in $script:position.Keys) { if (-not $Data.ContainsKey($key)) { $Data[$key] = $script:position[$key] } }
  try {
    $json = $Data | ConvertTo-Json -Compress -Depth 5
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
  } catch {
    # Reporting must never turn a click into an unhandled worker failure.
  }
}

function Get-ControlCommand {
  if ([string]::IsNullOrWhiteSpace($controlPath)) { return '' }
  try {
    if (Test-Path -LiteralPath $controlPath -PathType Leaf) {
      return ([string](Get-Content -LiteralPath $controlPath -Raw -ErrorAction Stop)).Trim().ToLowerInvariant()
    }
  } catch {
    # The server can remove the control file as the worker exits.
  }
  return ''
}

function Test-TargetWindow {
  if (-not [NativeMouse]::IsWindow($window)) { return $false }
  [NativeMouse+RECT]$rect = New-Object NativeMouse+RECT
  if (-not [NativeMouse]::GetWindowRect($window, [ref]$rect)) { return $false }
  if ($rect.Right -le $rect.Left -or $rect.Bottom -le $rect.Top) { return $false }
  if ($targetProcessId -gt 0) {
    $ownerProcessId = 0
    [NativeMouse]::GetWindowThreadProcessId($window, [ref]$ownerProcessId) | Out-Null
    if ($ownerProcessId -ne $targetProcessId) { return $false }
  }
  return $true
}

function Fail-TargetWindow {
  Emit-Event @{ type = 'error'; runId = $runId; code = 'TARGET_WINDOW_CLOSED'; message = 'TARGET_WINDOW_CLOSED' }
  exit 10
}

function Stop-Run {
  Emit-Event @{ type = 'stopped'; runId = $runId; completed = $completed }
  exit 0
}

function Handle-Control {
  $command = Get-ControlCommand
  if ($command -eq 'stop') { Stop-Run }
  if ($command -ne 'pause') { return }
  if (-not $script:isPaused) {
    $script:isPaused = $true
    Emit-Event @{ type = 'paused'; runId = $runId; completed = $completed }
  }
  while ($script:isPaused) {
    Start-Sleep -Milliseconds 50
    if (-not (Test-TargetWindow)) { Fail-TargetWindow }
    $command = Get-ControlCommand
    if ($command -eq 'stop') { Stop-Run }
    if ($command -eq 'resume') {
      $script:isPaused = $false
      Emit-Event @{ type = 'resumed'; runId = $runId; completed = $completed }
    }
  }
}

function Wait-Responsive {
  param([int]$Milliseconds)
  $remaining = [Math]::Max(0, $Milliseconds)
  while ($remaining -gt 0) {
    if ($script:position.phase -eq 'waiting') {
      $script:position.remainingMs = $remaining
      Emit-Event @{ type = 'position'; runId = $runId; completed = $script:completed }
    }
    Handle-Control
    if (-not (Test-TargetWindow)) { Fail-TargetWindow }
    $slice = [Math]::Min(100, $remaining)
    Start-Sleep -Milliseconds $slice
    $remaining -= $slice
  }
  Handle-Control
  if (-not (Test-TargetWindow)) { Fail-TargetWindow }
}

function Get-ClickRect {
  [NativeMouse+RECT]$outer = New-Object NativeMouse+RECT
  if (-not [NativeMouse]::GetWindowRect($window, [ref]$outer)) { Fail-TargetWindow }
  $outerInfo = @{ Left = $outer.Left; Top = $outer.Top; Right = $outer.Right; Bottom = $outer.Bottom; Source = 'window' }
  [NativeMouse+RECT]$client = New-Object NativeMouse+RECT
  [NativeMouse+POINT]$origin = New-Object NativeMouse+POINT
  if ([NativeMouse]::GetClientRect($window, [ref]$client) -and [NativeMouse]::ClientToScreen($window, [ref]$origin) -and $client.Right -gt $client.Left -and $client.Bottom -gt $client.Top) {
    $clientInfo = @{ Left = $origin.X; Top = $origin.Y; Right = $origin.X + ($client.Right - $client.Left); Bottom = $origin.Y + ($client.Bottom - $client.Top); Source = 'client' }
    $outerScore = [Math]::Abs(($outerInfo.Right - $outerInfo.Left) - $captureWidth) + [Math]::Abs(($outerInfo.Bottom - $outerInfo.Top) - $captureHeight)
    $clientScore = [Math]::Abs(($clientInfo.Right - $clientInfo.Left) - $captureWidth) + [Math]::Abs(($clientInfo.Bottom - $clientInfo.Top) - $captureHeight)
    if ($clientScore -lt $outerScore) { return $clientInfo }
  }
  return $outerInfo
}

function Send-MouseClick {
  param([int]$Action)
  $sent = [NativeMouse]::SendMouseClick($Action)
  if ($sent -ne 2) {
    Emit-Event @{ type = 'error'; runId = $runId; code = 'NATIVE_INPUT_FAILED'; message = "SendInput failed ($sent)" }
    exit 13
  }
}

function Activate-TargetWindow {
  $foreground = [NativeMouse]::GetForegroundWindow()
  $currentThread = [NativeMouse]::GetCurrentThreadId()
  $foregroundThread = if ($foreground -ne [IntPtr]::Zero) { [NativeMouse]::GetWindowThreadProcessId($foreground, [IntPtr]::Zero) } else { 0 }
  $targetThread = [NativeMouse]::GetWindowThreadProcessId($window, [IntPtr]::Zero)
  $attachedTarget = $false
  $attachedForeground = $false
  try {
    if ($currentThread -and $targetThread -and $currentThread -ne $targetThread) { $attachedTarget = [NativeMouse]::AttachThreadInput($currentThread, $targetThread, $true) }
    if ($foregroundThread -and $targetThread -and $foregroundThread -ne $targetThread) { $attachedForeground = [NativeMouse]::AttachThreadInput($foregroundThread, $targetThread, $true) }
    [NativeMouse]::BringWindowToTop($window) | Out-Null
    [NativeMouse]::SetForegroundWindow($window) | Out-Null
    [NativeMouse]::SetFocus($window) | Out-Null
  } finally {
    if ($attachedForeground) { [NativeMouse]::AttachThreadInput($foregroundThread, $targetThread, $false) | Out-Null }
    if ($attachedTarget) { [NativeMouse]::AttachThreadInput($currentThread, $targetThread, $false) | Out-Null }
  }
  Start-Sleep -Milliseconds 50
  return ([NativeMouse]::GetForegroundWindow() -eq $window)
}

# SetCursorPos + SendInput 是往系统输入流里注入，并不绑定到某个窗口：
# 目标不在前台时"调用成功"只说明事件发出去了，不代表它收到了点击。
# 所以每次点击前都确认一次；必要时安全恢复前台；恢复不了就明确失败，不让进度掩盖错点。
function Ensure-TargetForeground {
  if ([NativeMouse]::GetForegroundWindow() -eq $window) { return $true }
  if (Activate-TargetWindow) { return $true }
  return ([NativeMouse]::GetForegroundWindow() -eq $window)
}

# 前台相等 ≠ 点击会落到目标上：目标是非置顶窗口且保持前台时，一个置顶但不激活的窗口
# 盖在点击位置上，GetForegroundWindow() 仍然等于目标 —— 这是 Z-order 规则。
# 所以还要按"那个坐标点上实际是谁的窗口"判归属：命中窗口的根祖先必须是目标窗口。
function Test-PointOwnership {
  param([int]$X, [int]$Y)
  [NativeMouse+POINT]$point = New-Object NativeMouse+POINT
  $point.X = $X
  $point.Y = $Y
  $hit = [NativeMouse]::WindowFromPoint($point)
  if ($hit -eq [IntPtr]::Zero) { return $false }
  $root = [NativeMouse]::GetAncestor($hit, 2)   # GA_ROOT：取顶层窗口
  if ($root -eq [IntPtr]::Zero) { $root = $hit }
  return ($root -eq $window)
}

function Fail-PointOccluded {
  Emit-Event @{ type = 'error'; runId = $runId; code = 'TARGET_POINT_OCCLUDED'; message = 'TARGET_POINT_OCCLUDED' }
  exit 15
}

function Invoke-StepList {
  param($Items, $Block = $null, [int]$Iteration = 0)
  for ($stepIndex = 0; $stepIndex -lt $Items.Count; $stepIndex++) {
      $step = $Items[$stepIndex]
      Handle-Control
      if ($step.type -eq 'loop') {
        for ($repeat = 1; $repeat -le [int]$step.repeatCount; $repeat++) {
          Handle-Control
          Invoke-StepList @($step.steps) $step $repeat
        }
        $script:position = @{ loop = $loop + 1; loopId = ''; loopLabel = ''; iteration = 0; repeatCount = 0; phase = 'loop-exit'; stepId = [string]$step.id }
        Emit-Event @{ type = 'position'; runId = $runId; completed = $script:completed }
        continue
      }
      if ($step.type -ne 'click' -and $step.type -ne 'delay') { throw 'Unknown step type' }
      $script:position = @{ loop = $loop + 1; loopId = [string]$Block.id; loopLabel = [string]$Block.label; iteration = $Iteration; repeatCount = $Block.repeatCount; stepId = [string]$step.id; stepLabel = [string]$step.label; pointClickIndex = 0; pointClickCount = $step.clickCount; phase = 'click'; remainingMs = 0 }
      if ($step.type -eq 'delay') { $script:position.phase = 'waiting'; $script:position.remainingMs = [int]$step.ms }
      Emit-Event @{ type = 'position'; runId = $runId; completed = $script:completed }
      if ($step.type -eq 'delay') { Wait-Responsive ([int]$step.ms); continue }
      Invoke-ClickStep $step $stepIndex
  }
}

function Invoke-ClickStep {
  param($step, [int]$stepIndex)
      $clickCount = Get-PointClickCount $step
      $clickAction = Get-ClickAction ([string]($step.clickType))

      for ($clickIndex = 0; $clickIndex -lt $clickCount; $clickIndex++) {
        Handle-Control
        if (-not (Test-TargetWindow)) { Fail-TargetWindow }
        if (-not (Ensure-TargetForeground)) { throw 'TARGET_NOT_FOREGROUND' }
        $clickRect = Get-ClickRect
        $offsetX = [int]$step.x
        $offsetY = [int]$step.y
        if ($jitter) { $offsetX += $random.Next(-3, 4); $offsetY += $random.Next(-3, 4) }
        $x = [Math]::Max($clickRect.Left + 1, [Math]::Min($clickRect.Right - 2, $clickRect.Left + [int][Math]::Round($offsetX * ($clickRect.Right - $clickRect.Left) / $captureWidth)))
        $y = [Math]::Max($clickRect.Top + 1, [Math]::Min($clickRect.Bottom - 2, $clickRect.Top + [int][Math]::Round($offsetY * ($clickRect.Bottom - $clickRect.Top) / $captureHeight)))
        if (-not (Test-PointOwnership $x $y)) { Fail-PointOccluded }
        if (-not [NativeMouse]::SetCursorPos($x, $y)) { throw 'NATIVE_INPUT_FAILED' }
        Send-MouseClick $clickAction
        if ([string]$step.clickType -eq '双击') {
          Start-Sleep -Milliseconds 50
          if (-not (Test-TargetWindow)) { Fail-TargetWindow }
          if (-not (Ensure-TargetForeground)) { throw 'TARGET_NOT_FOREGROUND' }
          if (-not (Test-PointOwnership $x $y)) { Fail-PointOccluded }
          if (-not [NativeMouse]::SetCursorPos($x, $y)) { throw 'NATIVE_INPUT_FAILED' }
          Send-MouseClick $clickAction
        }
        $script:completed++
        $script:position.pointClickIndex = $clickIndex + 1
        Emit-Event @{ type = 'progress'; runId = $runId; completed = $script:completed; total = $totalClicks; stepIndex = $stepIndex; pointIndex = $stepIndex }
        if ($clickIndex -lt ($clickCount - 1)) { Wait-Responsive 50 }
      }
}

try {
  if ($steps.Count -lt 1 -or -not (Test-TargetWindow)) { Fail-TargetWindow }

  Emit-Event @{ type = 'started'; runId = $runId; total = $totalClicks }
  Handle-Control
  # Restore only a minimized window. SW_RESTORE would unmaximize a maximized
  # target, which changes the user's layout as soon as the run starts.
  if ([NativeMouse]::IsIconic($window)) { [NativeMouse]::ShowWindowAsync($window, 9) | Out-Null }
  if (-not (Activate-TargetWindow)) {
    Emit-Event @{ type = 'error'; runId = $runId; code = 'TARGET_WINDOW_UNAVAILABLE'; message = 'TARGET_WINDOW_UNAVAILABLE' }
    exit 12
  }
  Wait-Responsive 100

  for ($loop = 0; $loop -lt $loops; $loop++) {
    Invoke-StepList $steps
    if ($loop -lt ($loops - 1) -and $loopInterval -gt 0) { Wait-Responsive $loopInterval }
  }

  Emit-Event @{ type = 'completed'; runId = $runId; completed = $completed; total = $totalClicks }
  exit 0
} catch {
  Emit-Event @{ type = 'error'; runId = $runId; code = 'WORKER_EXCEPTION'; message = $_.Exception.Message }
  exit 11
}
