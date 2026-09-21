$ErrorActionPreference = 'Stop'
$worker = Join-Path $PSScriptRoot '..\src\worker\native-click-worker.ps1'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($worker, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
function Import-WorkerFunction($name) {
  $node = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
  return [scriptblock]::Create($node.Extent.Text)
}
. (Import-WorkerFunction 'Get-PointClickCount')
. (Import-WorkerFunction 'Get-ClickAction')
Add-Type 'public static class NativeMouse {
  public static bool SetCursorPos(int x, int y) { return true; }
  public static System.IntPtr foreground = System.IntPtr.Zero;
  public static bool activateWorks = false;
  public static System.IntPtr GetForegroundWindow() { return foreground; }
  public static uint GetCurrentThreadId() { return 1; }
  public static uint GetWindowThreadProcessId(System.IntPtr h, System.IntPtr p) { return 1; }
  public static bool BringWindowToTop(System.IntPtr h) { return true; }
  public static bool SetForegroundWindow(System.IntPtr h) { if (activateWorks) { foreground = h; } return activateWorks; }
  public static System.IntPtr SetFocus(System.IntPtr h) { return System.IntPtr.Zero; }
  public static bool AttachThreadInput(uint a, uint b, bool c) { return true; }
  [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  public static System.IntPtr hitWindow = System.IntPtr.Zero;
  public static System.IntPtr hitRoot = System.IntPtr.Zero;
  public static System.IntPtr WindowFromPoint(POINT p) { return hitWindow; }
  public static System.IntPtr GetAncestor(System.IntPtr h, uint flags) { return hitRoot; }
}'
function Handle-Control {}
function Test-TargetWindow { return $true }
function Ensure-TargetForeground { return $true }
function Test-PointOwnership { return $true }
function Get-ClickRect { return @{ Left=0; Top=0; Right=1000; Bottom=1000 } }
function Wait-Responsive([int]$Milliseconds) { $script:waits.Add($Milliseconds) }
function Send-MouseClick([int]$Action) { $script:clicks.Add($Action) }
function Emit-Event([hashtable]$Data) { if ($Data.type -eq 'progress') { $script:progress.Add($Data) } }
$loopNode = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.ForStatementAst] -and $node.Initializer.Extent.Text -eq '$loop = 0' }, $true)
if (-not $loopNode) { throw 'Worker execution loop not found' }
$execute = [scriptblock]::Create($loopNode.Extent.Text)
$steps = @(@{type='delay';ms=400}, @{type='click';x=10;y=20;clickCount=3;clickType='左键单击'}, @{type='delay';ms=200}, @{type='delay';ms=300}, @{type='click';x=30;y=40;clickCount=1;clickType='右键单击'})
$loops=2; $loopInterval=800; $captureWidth=1000; $captureHeight=1000; $jitter=$false
$script:waits = [Collections.Generic.List[int]]::new()
$script:clicks = [Collections.Generic.List[int]]::new()
$script:progress = [Collections.Generic.List[object]]::new()
$completed=0; $totalClicks=8
function Invoke-StepList($items) {
  foreach ($step in $items) {
    if ($step.type -eq 'delay') { Wait-Responsive ([int]$step.ms); continue }
    for ($i = 0; $i -lt [int]$step.clickCount; $i++) {
      $script:clicks.Add((Get-ClickAction ([string]$step.clickType)))
      if ([string]$step.clickType -eq '双击') { $script:clicks.Add((Get-ClickAction ([string]$step.clickType))) }
      $script:completed++
      $script:progress.Add(@{ pointClickIndex = $i + 1 })
      if ($i -lt ([int]$step.clickCount - 1)) { Wait-Responsive 50 }
    }
  }
}
. $execute
$expected = '400,50,50,200,300,800,400,50,50,200,300'
if (($script:waits -join ',') -ne $expected) { throw "Wrong wait sequence: $($script:waits -join ',')" }
if ($script:clicks.Count -ne 8 -or $completed -ne 8) { throw 'Wrong click total' }
if (($script:progress.pointClickIndex -join ',') -ne '1,2,3,1,1,2,3,1') { throw 'Wrong point progress' }
if ((Get-ClickAction '中键单击') -ne 2 -or (Get-ClickAction '右键单击') -ne 1 -or (Get-ClickAction '双击') -ne 0) { throw 'Click action mapping failed' }
if (($script:clicks -join ',') -ne '0,0,0,1,0,0,0,1') { throw "Per-step click action lost: $($script:clicks -join ',') / raw=$($steps[4].clickType) mapped=$(Get-ClickAction ([string]($steps[4].clickType)))" }
$steps = @(@{type='click';x=10;y=20;clickCount=3;clickType='双击'})
$loops=1; $script:waits.Clear(); $script:clicks.Clear(); $script:progress.Clear(); $completed=0; $totalClicks=3
. $execute
if ($script:clicks.Count -ne 6 -or $completed -ne 3) { throw 'Double click expansion failed' }
# Exercise the actual responsive wait with controlled time and control signals.
. (Import-WorkerFunction 'Wait-Responsive')
. (Import-WorkerFunction 'Handle-Control')
function Start-Sleep([int]$Milliseconds) { $script:slept += $Milliseconds }
function Stop-Run { throw 'STOPPED' }
function Fail-TargetWindow { throw 'TARGET_CLOSED' }
function Emit-Event([hashtable]$Data) {}
$script:commands = [Collections.Generic.Queue[string]]::new()
function Get-ControlCommand { if ($script:commands.Count) { return $script:commands.Dequeue() }; return '' }
$script:slept=0; $script:isPaused=$false
foreach ($command in @('pause','pause','resume')) { $script:commands.Enqueue($command) }
Wait-Responsive 320
if ($script:slept -ne 420 -or $script:isPaused) { throw 'Pause did not preserve remaining wait' }
$script:slept=0; $script:commands.Enqueue('stop')
try { Wait-Responsive 600000; throw 'Stop ignored' } catch { if ($_.Exception.Message -ne 'STOPPED') { throw } }
if ($script:slept -ne 0) { throw 'Stop was delayed' }
function Test-TargetWindow { return $false }
try { Wait-Responsive 600000; throw 'Closed target ignored' } catch { if ($_.Exception.Message -ne 'TARGET_CLOSED') { throw } }

# 每次点击前的前台保证：目标在前台放行；不在前台时尝试恢复；恢复不了必须拒绝。
$window = [System.IntPtr]::new(4242)
. (Import-WorkerFunction 'Activate-TargetWindow')
. (Import-WorkerFunction 'Ensure-TargetForeground')
[NativeMouse]::foreground = $window
if (-not (Ensure-TargetForeground)) { throw 'Foreground target was rejected' }
[NativeMouse]::foreground = [System.IntPtr]::Zero; [NativeMouse]::activateWorks = $true
if (-not (Ensure-TargetForeground)) { throw 'Recoverable foreground loss was not restored' }
[NativeMouse]::foreground = [System.IntPtr]::Zero; [NativeMouse]::activateWorks = $false
if (Ensure-TargetForeground) { throw 'Unrecoverable foreground loss must be refused' }

# 落点归属：前台相等不足以证明点击会落到目标上（置顶但不激活的覆盖窗口是 Z-order 规则）。
. (Import-WorkerFunction 'Test-PointOwnership')
[NativeMouse]::hitWindow = [System.IntPtr]::new(777); [NativeMouse]::hitRoot = $window
if (-not (Test-PointOwnership 10 20)) { throw 'Point inside target must pass' }
[NativeMouse]::hitRoot = [System.IntPtr]::new(999)
if (Test-PointOwnership 10 20) { throw 'Point covered by another window must be refused' }
[NativeMouse]::hitWindow = [System.IntPtr]::Zero
if (Test-PointOwnership 10 20) { throw 'Point with no window must be refused' }

# 双击的两下必须紧邻：分支里不能有可暂停的等待，且第二次点击前要重新定位光标。
$source = Get-Content $worker -Raw
$marker = "if ([string]`$step.clickType -eq '双击') {"
$start = $source.IndexOf($marker)
if ($start -lt 0) { throw 'Double click branch not found' }
# 只取该分支自身的花括号内容，别把后面动作组之间的合法等待也算进来
$bodyStart = $start + $marker.Length
$depth = 1; $index = $bodyStart
while ($index -lt $source.Length -and $depth -gt 0) {
  $char = $source[$index]
  if ($char -eq '{') { $depth++ } elseif ($char -eq '}') { $depth-- }
  $index++
}
# 双击序列 = 分支之前那次 Send-MouseClick + 分支内这次；整段里都不得有可暂停的等待
$sequenceStart = $source.LastIndexOf('Send-MouseClick', $start)
if ($sequenceStart -lt 0) { throw 'Double click sequence start not found' }
$sequence = $source.Substring($sequenceStart, $index - $sequenceStart)
$sequenceCode = ($sequence -split "`n" | Where-Object { $_ -notmatch '^\s*#' }) -join "`n"
if ($sequenceCode -match 'Wait-Responsive') { throw 'Double click must not contain a pauseable wait' }
if ($sequenceCode -notmatch 'Start-Sleep') { throw 'Double click must use a non-pauseable short gap' }
$firstClick = $sequenceCode.IndexOf('Send-MouseClick')
$secondClick = $sequenceCode.IndexOf('Send-MouseClick', $firstClick + 1)
if ($secondClick -lt 0) { throw 'Double click sequence must send two clicks' }
if ($sequenceCode.Substring($firstClick, $secondClick - $firstClick) -notmatch 'SetCursorPos') { throw 'Second click must re-locate the cursor' }
# 紧邻 ≠ 不检查：原来的 Wait-Responsive 会在等待中和结束时调 Test-TargetWindow，
# 换成裸 Start-Sleep 会让"第一击把目标关掉、第二击打到别人"变成成功。
if ($sequenceCode.Substring($firstClick, $secondClick - $firstClick) -notmatch 'Test-TargetWindow') { throw 'Second click must re-check the target window' }
if ($sequenceCode.Substring($firstClick, $secondClick - $firstClick) -notmatch 'Test-PointOwnership') { throw 'Second click must re-check point ownership' }

Write-Output 'Worker settings passed: action groups, double/right click, independent waits, no final wait, pause, stop, target closed, foreground guarantee, point ownership, atomic double click with checks'
