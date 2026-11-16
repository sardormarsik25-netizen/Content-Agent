@echo off
REM Content Agent Telegram Bot - Quick Start Batch File
REM Usage: start-bot.bat

chcp 65001 >nul
title Content Agent Bot

echo ╔══════════════════════════════════════════════════════════════╗
echo ║       Content Agent Telegram Bot - Quick Start               ║
echo ╚══════════════════════════════════════════════════════════════╝

REM Check if .env exists
if not exist .env (
    echo.
    echo ⚠️  .env file not found!
    echo Please copy .env.example to .env and fill in your BOT_TOKEN
    echo.
    pause
    exit /b 1
)

REM Load environment variables from .env
for /f "usebackq delims=" %%a in (`.env`) do (
    set "%%a"
)

REM Check BOT_TOKEN
if "%BOT_TOKEN%"=="" (
    echo.
    echo ❌ BOT_TOKEN not set in .env file!
    echo.
    pause
    exit /b 1
)

echo ✅ BOT_TOKEN is set
echo ✅ Starting bot with auto-retry...

REM Run the bot with Node.js (using --experimental-strip-types for TypeScript)
node --experimental-strip-types src/telegram-bot.ts

REM If we reach here, the bot exited
echo.
echo Bot stopped with exit code %ERRORLEVEL%
pause