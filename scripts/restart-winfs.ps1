# Emergency winfs MCP server restart
#
# Use this when:
#   - winfs MCP server is unreachable (tool calls return "Tool not found")
#   - Server hangs on a 4+ minute transport stall (known v0.5 issue)
#   - You need a clean state without restarting Claude Desktop entirely
#
# How it works:
#   1. Find node processes whose command line references 'winfs' or 'winfs-mcp'
#   2. Stop them (Stop-Process -Force)
#   3. Claude Desktop / Claude.ai's MCP host will respawn the server on next tool call
#
# Limitations:
#   - Requires Claude Desktop or Claude.ai to be configured to auto-respawn MCP servers
#     (this is the default for Claude Desktop via mcpServers config)
#   - If Claude.ai web client lost the MCP connection at the websocket level, killing
#     the node process won't help - you need to refresh the browser tab or reconnect
#     MCP in Claude.ai settings
#   - On rare cases the MCP host caches the server's tool schema and won't pick up
#     code changes until full Claude restart - for those, use the in-band restart_server
#     tool (planned for v0.6) which signals the host to re-handshake

[CmdletBinding()]
param(
    [switch] $WhatIf,
    [switch] $Verbose
)

Write-Host "winfs MCP server restart utility" -ForegroundColor Cyan
Write-Host "================================`n"

# Find node processes running winfs via CIM (more reliable than Get-Process for cmdline)
$winfsProcs = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
        $_.CommandLine -and (
            $_.CommandLine -match 'winfs' -or
            $_.CommandLine -match 'winfs-mcp'
        )
    }

if (-not $winfsProcs) {
    Write-Host "No winfs node processes found." -ForegroundColor Yellow
    Write-Host "Server may already be down, or it's running under a different process name."
    Write-Host "If you expected it to be running, check:"
    Write-Host "  - Claude Desktop MCP config: %APPDATA%\Claude\claude_desktop_config.json"
    Write-Host "  - Or MSIX path: %LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude_desktop_config.json"
    exit 0
}

Write-Host "Found $($winfsProcs.Count) winfs node process(es):"
foreach ($p in $winfsProcs) {
    Write-Host "  PID $($p.ProcessId)" -ForegroundColor Gray -NoNewline
    if ($Verbose) {
        Write-Host " - $($p.CommandLine.Substring(0, [Math]::Min(120, $p.CommandLine.Length)))..."
    } else {
        Write-Host ""
    }
}

if ($WhatIf) {
    Write-Host "`n[WhatIf] Would stop the above process(es). No action taken." -ForegroundColor Yellow
    exit 0
}

Write-Host "`nStopping..."
$stopped = 0
foreach ($p in $winfsProcs) {
    try {
        Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
        $stopped++
        Write-Host "  PID $($p.ProcessId) stopped" -ForegroundColor Green
    } catch {
        Write-Host "  PID $($p.ProcessId) FAILED to stop: $($_.Exception.Message)" -ForegroundColor Red
    }
}

Write-Host "`nStopped $stopped/$($winfsProcs.Count) process(es)." -ForegroundColor Cyan

if ($stopped -gt 0) {
    Write-Host "`nNext steps:"
    Write-Host "  1. Wait 2-3 seconds for OS cleanup"
    Write-Host "  2. Issue any winfs tool call from Claude - host will respawn the server"
    Write-Host "     (if Claude Desktop is configured to auto-launch the MCP server, this is automatic)"
    Write-Host "  3. If respawn doesn't happen, check Claude Desktop's developer console / log"
    Write-Host "     for spawn errors (often MSIX node PATH issue - use absolute node.exe path)"
}

Write-Host "`nUsage:"
Write-Host "  .\restart-winfs.ps1            Stop winfs processes (default action)"
Write-Host "  .\restart-winfs.ps1 -WhatIf    Show what would be stopped without stopping"
Write-Host "  .\restart-winfs.ps1 -Verbose   Show full command lines for matched processes"
