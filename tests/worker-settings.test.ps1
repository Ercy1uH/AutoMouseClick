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
Add-Type 'public static class NativeMouse { public static bool SetCursorPos(int x, int y) { return true; } }'
function Handle-Control {}
function Test-TargetWindow { return $true }
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
Write-Output 'Worker settings passed: action groups, double/right click, independent waits, no final wait, pause, stop, target closed'
