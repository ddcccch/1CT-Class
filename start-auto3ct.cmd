@echo off
rem auto3ct 一键启动入口（Windows）
rem 用法：
rem   start-auto3ct.cmd                    显示状态（安全，不执行）
rem   start-auto3ct.cmd validate           校验配置
rem   start-auto3ct.cmd preview            预览今日计划
rem   start-auto3ct.cmd run-once           执行一轮（默认 dry-run）
rem   start-auto3ct.cmd run-once --execute 真实执行（需配置可用 adapter）
rem   start-auto3ct.cmd watch              常驻轮询（默认 dry-run，Ctrl+C 停止）
rem   start-auto3ct.cmd watch --execute    常驻真实执行
setlocal
cd /d "%~dp0"

set "PYTHON="
where py >nul 2>nul && set "PYTHON=py -3"
if not defined PYTHON (
  where python >nul 2>nul && set "PYTHON=python"
)
if not defined PYTHON if exist "%~dp0.runtime\python.exe" set "PYTHON=%~dp0.runtime\python.exe"
if not defined PYTHON if defined DSH_PYTHON set "PYTHON=%DSH_PYTHON%"
if not defined PYTHON (
  echo 未找到 Python 3。请安装 Python 3.11+ 并加入 PATH，或在 config.local.json 同目录放置 .runtime\python.exe。
  pause
  exit /b 1
)

if "%~1"=="" (
  %PYTHON% -m auto3ct status
  echo.
  echo 提示：双击仅显示状态；按计划执行请运行  start-auto3ct.cmd watch --execute
  echo 首次使用请把 config.example.json 复制为 config.local.json 后填写。
  pause
  exit /b %ERRORLEVEL%
)

%PYTHON% -m auto3ct %*
exit /b %ERRORLEVEL%
