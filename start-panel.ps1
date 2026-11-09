# Codex QQ 桥接 - 桌面快捷方式启动器
# 没在跑就拉起托盘（qq-bot-tray.ps1），起来后打开聊天面板；已经在跑则直接打开面板。
$ErrorActionPreference = 'SilentlyContinue'
$bridgeDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$trayScript = Join-Path $bridgeDir 'qq-bot-tray.ps1'
$logFile = Join-Path $bridgeDir 'logs\bridge.log'
$panelUrl = 'http://127.0.0.1:17890'
$panelTitleKey = 'QQ Bot Bridge'

Add-Type -AssemblyName System.Windows.Forms | Out-Null

function Test-BridgeUp {
  try {
    $r = Invoke-WebRequest -Uri "$panelUrl/api/bots" -TimeoutSec 3 -UseBasicParsing
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

# 打开面板：跟托盘双击同一套——面板已开着就置前，否则用 Edge 的 app 窗口打开
# （普通 Start-Process <url> 在本机只会起一个没有窗口的 Edge 后台进程，实测打不开面板）
function Show-Panel {
  $open = Get-Process msedge -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like "*$panelTitleKey*" } |
    Select-Object -First 1
  if ($open) {
    (New-Object -ComObject WScript.Shell).AppActivate($open.Id) | Out-Null
    return
  }
  $edge = @(
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe')
  ) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if ($edge) {
    Start-Process -FilePath $edge -ArgumentList "--app=$panelUrl", '--window-size=420,720'
  } else {
    Start-Process $panelUrl
  }
}

if (-not (Test-BridgeUp)) {
  if (-not (Test-Path -LiteralPath $trayScript)) {
    [System.Windows.Forms.MessageBox]::Show("找不到托盘启动脚本：`n$trayScript", 'Codex QQ 桥接', 'OK', 'Error') | Out-Null
    exit 1
  }
  Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', "`"$trayScript`"") -WindowStyle Hidden
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 800
    if (Test-BridgeUp) { break }
  }
}

if (Test-BridgeUp) {
  Show-Panel
} else {
  [System.Windows.Forms.MessageBox]::Show("桥接没起来。`n请看日志：$logFile", 'Codex QQ 桥接', 'OK', 'Warning') | Out-Null
}
