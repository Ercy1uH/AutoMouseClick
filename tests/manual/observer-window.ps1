# 外部观测窗口：一个无破坏性的 WinForms 窗口，把真实收到的鼠标/键盘消息逐条写进日志。
# 用于手验：不依赖应用自己的进度条，也不把业务回调当输入计数。
# 用法：powershell -File tests/manual/observer-window.ps1 -LogPath <file> -HandlePath <file> [-Title ...]
param(
  [Parameter(Mandatory = $true)][string]$LogPath,
  [Parameter(Mandatory = $true)][string]$HandlePath,
  [string]$Title = 'MouseClik Observer',
  [int]$Width = 900,
  [int]$Height = 700
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Windows.Forms;

public class MouseClikObserver : Form {
  public static string LogPath;
  public static void Log(string line) {
    lock (typeof(MouseClikObserver)) { File.AppendAllText(LogPath, line + Environment.NewLine); }
  }
  protected override void WndProc(ref Message m) {
    switch (m.Msg) {
      case 0x0200: // WM_MOUSEMOVE
      case 0x0201: // WM_LBUTTONDOWN
      case 0x0202: // WM_LBUTTONUP
      case 0x0203: // WM_LBUTTONDBLCLK
      case 0x0204: // WM_RBUTTONDOWN
      case 0x0205: // WM_RBUTTONUP
      case 0x0206: // WM_RBUTTONDBLCLK
      case 0x0207: // WM_MBUTTONDOWN
      case 0x0208: // WM_MBUTTONUP
      case 0x0209: // WM_MBUTTONDBLCLK
      case 0x0100: // WM_KEYDOWN
      case 0x0101: // WM_KEYUP
        long value = m.LParam.ToInt64();
        int x = (short)(value & 0xFFFF);
        int y = (short)((value >> 16) & 0xFFFF);
        string extra = (m.Msg == 0x0100 || m.Msg == 0x0101) ? (" key=" + m.WParam.ToInt64()) : "";
        Log(DateTime.UtcNow.ToString("o") + " msg=0x" + m.Msg.ToString("X4") + " x=" + x + " y=" + y + extra);
        break;
    }
    base.WndProc(ref m);
  }
}
'@ -ReferencedAssemblies 'System.Windows.Forms', 'System.Drawing'

[MouseClikObserver]::LogPath = $LogPath
if (Test-Path $LogPath) { Remove-Item $LogPath -Force }

$form = New-Object MouseClikObserver
$form.Text = $Title
$form.Width = $Width
$form.Height = $Height
$form.StartPosition = 'Manual'
$form.Left = 80
$form.Top = 80
$form.TopMost = $false

$form.add_Shown({
  Set-Content -LiteralPath $HandlePath -Value $form.Handle.ToInt64() -Encoding ASCII
  [MouseClikObserver]::Log((Get-Date).ToUniversalTime().ToString('o') + ' observer=ready handle=' + $form.Handle.ToInt64() + ' client=' + $form.ClientSize.Width + 'x' + $form.ClientSize.Height)
})

[System.Windows.Forms.Application]::Run($form)
