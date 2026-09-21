# 复验：在真实的 Windows PowerShell 5.1 下加载 worker 脚本，检查三种 clickType 的映射。
# 脚本自身带 UTF-8 BOM —— 否则这个复验脚本本身也会被按 ANSI 解码，跟着一起错。
$ErrorActionPreference = 'Stop'
$worker = Join-Path $PSScriptRoot '..\..\src\worker\native-click-worker.ps1'

$bytes = [IO.File]::ReadAllBytes($worker)
$hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
Write-Output ('worker 前三字节: {0:X2} {1:X2} {2:X2}  BOM={3}' -f $bytes[0], $bytes[1], $bytes[2], $hasBom)
if (-not $hasBom) { throw 'worker 脚本缺少 UTF-8 BOM：5.1 会按 ANSI 解码，中文常量必然失配' }

$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($worker, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$node = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Get-ClickAction' }, $true)
. ([scriptblock]::Create($node.Extent.Text))

$cases = @(
  @{ Type = '左键单击'; Expect = 0 },
  @{ Type = '右键单击'; Expect = 1 },
  @{ Type = '中键单击'; Expect = 2 },
  @{ Type = '双击';     Expect = 0 }
)
$failed = 0
foreach ($case in $cases) {
  $actual = Get-ClickAction $case.Type
  $ok = ($actual -eq $case.Expect)
  if (-not $ok) { $failed++ }
  $mark = 'FAIL'
  if ($ok) { $mark = 'OK' }
  Write-Output ('[{0}] {1} => {2}（期望 {3}）' -f $mark, $case.Type, $actual, $case.Expect)
}
Write-Output ('PowerShell 版本: ' + $PSVersionTable.PSVersion.ToString())
if ($failed) { throw ('clickType 映射有 ' + $failed + ' 项不符') }
Write-Output 'clickType 映射复验通过（真实 PowerShell 5.1）'
