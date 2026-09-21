# 把指定窗口带到前台，并打印实际的前台窗口句柄（用于制造"暂停期间前台被抢走"）。
param([Parameter(Mandatory = $true)][long]$Handle)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Fg {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
}
'@
$target = [IntPtr]::new($Handle)
[void][Fg]::ShowWindow($target, 9)   # SW_RESTORE：最小化状态下也能被带到前台
[void][Fg]::SetForegroundWindow($target)
Start-Sleep -Milliseconds 250
Write-Output ([Fg]::GetForegroundWindow().ToInt64())
