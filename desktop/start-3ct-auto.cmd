@echo off
rem 3CT-Auto 一键启动（双击即可）。
rem 本脚本同时适用于两种位置：
rem   - 仓库根目录：使用 3CT-Auto\3CT-Auto.exe
rem   - 副本目录内：使用同目录的 3CT-Auto.exe
rem 与原版共享 userData 与单实例锁：原版/副本已在运行时不会重复启动。
rem 绝不结束、修改或删除原版 3CT。
setlocal
cd /d "%~dp0"

set "APP="
if exist "%~dp03CT-Auto.exe" set "APP=%~dp03CT-Auto.exe"
if not defined APP if exist "%~dp03CT-Auto\3CT-Auto.exe" set "APP=%~dp03CT-Auto\3CT-Auto.exe"
if not defined APP (
  echo 未找到 3CT-Auto.exe。
  echo 请先在仓库根目录运行: python desktop\install.py build
  echo 生成后再双击本脚本。
  pause
  exit /b 1
)

tasklist /FI "IMAGENAME eq 3CT-Auto.exe" 2>nul | find /I "3CT-Auto.exe" >nul
if not errorlevel 1 (
  echo 3CT-Auto 已在运行，不会重复启动。
  echo 如需重启，请先在托盘退出 3CT-Auto。
  exit /b 0
)

tasklist /FI "IMAGENAME eq 3CT.exe" 2>nul | find /I "3CT.exe" >nul
if not errorlevel 1 (
  echo.
  echo 检测到原版 3CT 正在运行。
  echo 3CT-Auto 与原版共享同一用户数据和单实例锁，无法同时运行。
  echo 请先完全退出原版 3CT（含托盘图标右键退出），再重新运行本脚本。
  echo 本脚本不会结束或修改原版 3CT。
  echo.
  pause
  exit /b 1
)

echo 正在启动 3CT-Auto...
echo 提示：每日自动化需要应用保持打开且电脑处于唤醒状态；请勿在副本中安装官方更新。
start "" "%APP%"
exit /b 0
