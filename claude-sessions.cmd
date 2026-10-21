@echo off
chcp 65001 >nul
title Claude Sessions
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js was not found in PATH.
  echo   Install it from https://nodejs.org and run this file again.
  echo.
  pause
  exit /b 1
)

node "%~dp0claude-sessions.js" %*

echo.
echo   Server stopped.
pause
