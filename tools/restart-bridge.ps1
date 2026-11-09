# Restart the QQ bot bridge (tray + node) safely.
#
# Why: bridge.mjs changes only take effect after a restart, and the bridge is the
# parent of every running codex.exe child (each QQ message = one codex.exe).
# Killing the bridge while a task runs loses that task's reply, so this script
# waits until the bridge has no codex.exe children (i.e. the last turn finished
# and its reply was delivered) before restarting.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\restart-bridge.ps1
#   ... -NoWait      skip the idle wait
#   ... -GraceSec 30 extra seconds after going idle (default 15)
#   ... -MaxWaitSec 3600  give up waiting after this long (then restart anyway)

param(
  [switch]$NoWait,
  [int]$GraceSec = 15,
  [int]$MaxWaitSec = 3600
)

$ErrorActionPreference = 'Stop'
$bridgeDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$logFile = Join-Path $bridgeDir 'logs\restart.log'

function Write-Log($message) {
  $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message
  try { Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8 } catch {}
}

function Get-BridgeNode {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object {
      $_.CommandLine -like "*$bridgeDir*" -or $_.CommandLine -like '*\bridge.mjs*'
    }
}

function Get-BridgeCodexChildren($nodePid) {
  Get-CimInstance Win32_Process -Filter "Name='codex.exe'" |
    Where-Object { $_.ParentProcessId -eq $nodePid }
}

Write-Log 'restart requested'
$node = Get-BridgeNode
if (-not $node) {
  Write-Log 'no bridge node process found (will just start the tray)'
} else {
  $nodePid = $node.ProcessId
  Write-Log ("bridge node pid = {0}" -f $nodePid)
  if (-not $NoWait) {
    $deadline = (Get-Date).AddSeconds($MaxWaitSec)
    $idle = $false
    while ((Get-Date) -lt $deadline) {
      $busy = Get-BridgeCodexChildren $nodePid
      if (-not $busy) {
        Start-Sleep -Seconds $GraceSec
        $busy = Get-BridgeCodexChildren $nodePid
        if (-not $busy) { $idle = $true; break }
        Write-Log 'a new codex task started during the grace period, waiting again'
      }
      Start-Sleep -Seconds 5
    }
    Write-Log ("idle = {0}" -f $idle)
  }
  Get-Process -Name 'QQBotTray' -ErrorAction SilentlyContinue | ForEach-Object {
    try { $_.Kill(); Write-Log ("tray killed pid {0}" -f $_.Id) } catch { Write-Log ("tray kill failed: {0}" -f $_.Exception.Message) }
  }
  Start-Sleep -Milliseconds 500
  try { Stop-Process -Id $nodePid -Force; Write-Log ("node killed pid {0}" -f $nodePid) }
  catch { Write-Log ("node kill failed: {0}" -f $_.Exception.Message) }
}

Start-Sleep -Seconds 2
$trayScript = Join-Path $bridgeDir 'qq-bot-tray.ps1'
if (Test-Path -LiteralPath $trayScript) {
  Start-Process -FilePath 'powershell.exe' -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
    '-File', ('"' + $trayScript + '"')
  ) -WindowStyle Hidden
  Write-Log 'tray launched'
} else {
  Write-Log ("tray script missing: {0}" -f $trayScript)
}

$up = $false
for ($i = 0; $i -lt 45; $i++) {
  Start-Sleep -Seconds 1
  try {
    $null = Invoke-RestMethod 'http://127.0.0.1:17890/api/bots' -TimeoutSec 3
    $up = $true
    break
  } catch {}
}
Write-Log ("panel reachable after restart = {0}" -f $up)
