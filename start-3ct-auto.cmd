@echo off
title 3CT-Auto Launcher
rem 3CT-Auto one-click launcher (double-click friendly).
rem Works from repo root (uses 3CT-Auto\3CT-Auto.exe) and from the copy dir
rem (uses the same-directory 3CT-Auto.exe).
rem
rem This file MUST stay pure ASCII with CRLF line endings: cmd.exe on a GBK/936
rem console mis-decodes UTF-8 Chinese and LF-only line endings, which used to
rem merge lines and run text fragments as commands (window flashed and closed).
rem
rem IMPORTANT: inside parenthesized IF blocks never put unescaped ( or ) inside
rem echo text: cmd closes the block early. Keep those lines free of parentheses.
rem
rem The original 3CT is never killed or modified. Both apps share userData and
rem the single-instance lock, so if the original is running we only ask the user
rem to exit it first.
rem
rem Clear Electron Node-mode variables for this process and its children only;
rem setlocal restores the user environment on exit. If the user environment has
rem ELECTRON_RUN_AS_NODE=1, the packaged exe would start as Node and exit with
rem "bad option" instead of launching the app.
setlocal
set "ELECTRON_RUN_AS_NODE="
set "NODE_OPTIONS="
set "NODE_PATH="
cd /d "%~dp0"

set "APP="
if exist "%~dp03CT-Auto.exe" set "APP=%~dp03CT-Auto.exe"
if not defined APP if exist "%~dp03CT-Auto\3CT-Auto.exe" set "APP=%~dp03CT-Auto\3CT-Auto.exe"
if not defined APP (
  echo [3CT-Auto] Cannot find 3CT-Auto.exe.
  echo [3CT-Auto] Build the copy first, from the repo root:
  echo [3CT-Auto]     python desktop\install.py build
  echo [3CT-Auto] Then run this script again.
  pause
  exit /b 1
)

tasklist /FI "IMAGENAME eq 3CT-Auto.exe" 2>nul | findstr /I /C:"3CT-Auto.exe" >nul
if not errorlevel 1 (
  echo [3CT-Auto] 3CT-Auto is already running. Not starting another instance.
  echo [3CT-Auto] To restart, quit it from the tray icon first.
  pause
  exit /b 0
)

tasklist /FI "IMAGENAME eq 3CT.exe" 2>nul | findstr /I /C:"3CT.exe" >nul
if not errorlevel 1 (
  echo.
  echo [3CT-Auto] The original 3CT is running.
  echo [3CT-Auto] 3CT-Auto shares the same user data and single-instance lock.
  echo [3CT-Auto] They cannot run at the same time.
  echo [3CT-Auto] Please exit the original 3CT completely, including its tray icon,
  echo [3CT-Auto] then run this script again.
  echo [3CT-Auto] This script never kills or modifies the original 3CT.
  echo.
  pause
  exit /b 1
)

rem Test hook: after all real checks, print resolved paths and sanitized env only.
rem It never starts the app and never bypasses the missing-exe / process checks.
if defined AUTO3CT_LAUNCHER_DRY_RUN (
  echo [3CT-Auto][dry-run] APP=%APP%
  echo [3CT-Auto][dry-run] ELECTRON_RUN_AS_NODE=[%ELECTRON_RUN_AS_NODE%]
  echo [3CT-Auto][dry-run] NODE_OPTIONS=[%NODE_OPTIONS%]
  echo [3CT-Auto][dry-run] NODE_PATH=[%NODE_PATH%]
  exit /b 0
)

echo [3CT-Auto] Starting...
echo [3CT-Auto] Keep the app open and the PC awake for daily automation.
echo [3CT-Auto] Do not install official updates inside the copy.
rem Forward extra arguments (e.g. --user-data-dir/--remote-debugging-port) for
rem isolated verification; plain double-click passes no arguments.
start "" "%APP%" %*
if errorlevel 1 (
  echo [3CT-Auto] Failed to start 3CT-Auto.exe.
  echo [3CT-Auto] Run the exe directly to see the error, or see docs\launcher-fix.md
  pause
  exit /b 1
)
exit /b 0
