# Re-register qwen-server task with cmd.exe wrapper.

$ErrorActionPreference = 'Stop'

# Clean prior registration
$existing = Get-ScheduledTask -TaskName 'qwen-server' -ErrorAction SilentlyContinue
if ($existing) {
    Stop-ScheduledTask -TaskName 'qwen-server' -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName 'qwen-server' -Confirm:$false
}
Get-Process llama-server -ErrorAction SilentlyContinue | Stop-Process -Force

$action = New-ScheduledTaskAction `
    -Execute 'cmd.exe' `
    -Argument '/c D:\llama\launch-llama.cmd' `
    -WorkingDirectory 'D:\llama'

$trigger = New-ScheduledTaskTrigger -AtStartup

$principal = New-ScheduledTaskPrincipal `
    -UserId 'NT AUTHORITY\SYSTEM' `
    -RunLevel Highest `
    -LogonType ServiceAccount

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Days 0) `
    -RestartCount 5 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable

Register-ScheduledTask `
    -TaskName 'qwen-server' `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description 'Qwen3.6-35B-A3B llama-server (Vulkan) - autostart on boot' | Out-Null

"task registered (SYSTEM/AtStartup)"
Start-ScheduledTask -TaskName 'qwen-server'
"task started"
