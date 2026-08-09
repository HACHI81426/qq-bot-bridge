# Codex QQ 桥接 - 托盘启动器（托盘本体是独立的 QQBotTray.exe）
$ErrorActionPreference = 'SilentlyContinue'
$bridgeDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe = Join-Path $bridgeDir 'QQBotTray.exe'
$cs = Join-Path $bridgeDir 'QQBotTray.cs'
$logDir = Join-Path $bridgeDir 'logs'

# 定位 node：优先 NODE_PATH，其次 PATH
$node = if ($env:NODE_PATH -and (Test-Path -LiteralPath $env:NODE_PATH)) { $env:NODE_PATH } else { (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $node) { $node = 'node' }

# 托盘程序编译（首次运行或源码更新时自动重编）
$needBuild = -not (Test-Path $exe)
if (-not $needBuild -and (Test-Path $cs)) {
  try {
    $csTime = (Get-Item $cs).LastWriteTime
    $exeTime = (Get-Item $exe).LastWriteTime
    if ($csTime -gt $exeTime) { $needBuild = $true }
  } catch {}
}
if ($needBuild -and (Test-Path $cs)) {
  try {
    Add-Type -AssemblyName System.Windows.Forms | Out-Null
    Add-Type -AssemblyName System.Drawing | Out-Null
    $text = [System.IO.File]::ReadAllText($cs, [System.Text.Encoding]::UTF8)
    [System.IO.File]::WriteAllText($cs, $text, (New-Object System.Text.UTF8Encoding($true)))
    Add-Type -Path $cs -OutputAssembly $exe -OutputType WindowsApplication -ReferencedAssemblies @('System.Windows.Forms.dll','System.Drawing.dll','System.dll') -ErrorAction Stop
  } catch {
    try {
      New-Item -ItemType Directory -Path $logDir -Force | Out-Null
      [System.IO.File]::WriteAllText((Join-Path $logDir 'tray-build-error.txt'), $_.Exception.ToString())
    } catch {}
  }
}

if (Test-Path $exe) {
  Start-Process -FilePath $exe -ArgumentList @($node) -WorkingDirectory $bridgeDir -WindowStyle Hidden
}
