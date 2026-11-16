<#
.SYNOPSIS
    Starts the Content Agent Telegram bot with automatic restart on failure.

.DESCRIPTION
    This script runs the bot in a loop with exponential backoff retry logic.
    It loads environment variables from .env file and restarts the bot
    if it crashes unexpectedly.

.NOTES
    Requires: Node.js, npm packages installed (npm install)
    Environment: BOT_TOKEN must be set in .env file
#>

param(
    [string]$EnvFile = ".\.env",
    [int]$MaxRetries = -1,  # -1 for infinite retries
    [int]$BaseDelaySeconds = 5,
    [int]$MaxDelaySeconds = 300,
    [string]$NodeCommand = "node",
    [string]$BotScript = "src/telegram-bot.ts"
)

$ErrorActionPreference = "Stop"

function Load-EnvFile {
    param([string]$Path)
    if (Test-Path $Path) {
        Write-Host "📄 Loading environment from $Path" -ForegroundColor Cyan
        $content = Get-Content $Path -Raw
        foreach ($line in $content -split "`r?`n") {
            $line = $line.Trim()
            if ($line -and -not $line.StartsWith("#")) {
                $parts = $line.Split("=", 2)
                if ($parts.Count -eq 2) {
                    $name = $parts[0].Trim()
                    $value = $parts[1].Trim().Trim('"', "'")
                    [Environment]::SetEnvironmentVariable($name, $value, "Process")
                }
            }
        }
    } else {
        Write-Warning "⚠️  .env file not found at $Path. Using system environment variables."
    }
}

function Test-Prerequisites {
    Write-Host "🔍 Checking prerequisites..." -ForegroundColor Cyan

    # Check Node.js
    try {
        $nodeVersion = & $NodeCommand --version
        Write-Host "✅ Node.js: $nodeVersion" -ForegroundColor Green
    } catch {
        Write-Error "❌ Node.js not found. Please install Node.js."
        exit 1
    }

    # Check npm packages
    if (-not (Test-Path "node_modules")) {
        Write-Host "📦 Installing npm packages..." -ForegroundColor Yellow
        npm install
    } else {
        Write-Host "✅ npm packages found" -ForegroundColor Green
    }

    # Check OpenCode
    try {
        $opencodeVersion = & opencode --version 2>$null
        if ($opencodeVersion) {
            Write-Host "✅ OpenCode: $opencodeVersion" -ForegroundColor Green
        } else {
            Write-Warning "⚠️  OpenCode not found in PATH. Some features may not work."
        }
    } catch {
        Write-Warning "⚠️  OpenCode not found. Install with: npm i -g opencode-ai@latest"
    }

    # Check BOT_TOKEN
    if (-not $env:BOT_TOKEN) {
        Write-Error "❌ BOT_TOKEN environment variable is required. Set it in .env file."
        exit 1
    } else {
        Write-Host "✅ BOT_TOKEN is set" -ForegroundColor Green
    }
}

function Start-Bot {
    param([int]$Attempt)

    Write-Host "`n🚀 Starting bot (Attempt $Attempt)..." -ForegroundColor Cyan
    $process = Start-Process $NodeCommand -ArgumentList "--experimental-strip-types", $BotScript -NoNewWindow -PassThru -Wait
    return $process.ExitCode
}

# Main execution
Write-Host "╔══════════════════════════════════════════════════════════════╗" -ForegroundColor Magenta
Write-Host "║       Content Agent Telegram Bot - Process Manager           ║" -ForegroundColor Magenta
Write-Host "╚══════════════════════════════════════════════════════════════╝" -ForegroundColor Magenta

Load-EnvFile $EnvFile
Test-Prerequisites

$retryCount = 0
$currentDelay = $BaseDelaySeconds

while ($true) {
    $retryCount++

    if ($MaxRetries -gt 0 -and $retryCount -gt $MaxRetries) {
        Write-Error "💥 Maximum retries ($MaxRetries) exceeded. Stopping."
        exit 1
    }

    try {
        $exitCode = Start-Bot -Attempt $retryCount

        if ($exitCode -eq 0) {
            Write-Host "✅ Bot exited cleanly." -ForegroundColor Green
            break
        } else {
            Write-Warning "⚠️  Bot exited with code $exitCode"
        }
    } catch {
        Write-Error "💥 Bot process failed: $_"
    }

    if ($MaxRetries -gt 0 -and $retryCount -ge $MaxRetries) {
        break
    }

    Write-Host "⏳ Waiting $currentDelay seconds before retry..." -ForegroundColor Yellow
    Start-Sleep -Seconds $currentDelay

    # Exponential backoff with cap
    $currentDelay = [Math]::Min($currentDelay * 2, $MaxDelaySeconds)
}

Write-Host "`n🛑 Process manager stopped." -ForegroundColor Magenta