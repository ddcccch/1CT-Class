# 3CT 自动版图形启动器（双击无 cmd 窗口）

## 交付物

| 路径 | 说明 |
|---|---|
| `启动3CT自动版.exe` | 仓库根入口，双击启动 `3CT-Auto\3CT-Auto.exe` |
| `3CT-Auto\启动3CT自动版.exe` | 副本目录内的同名入口（在副本目录内双击也适用） |
| `desktop/GuiLauncher.cs` | C# WinExe 源码（无控制台、无 cmd/powershell/VBS） |
| `desktop/build_gui_launcher.py` | 纯标准库 Python 构建脚本（调用 Windows 自带 csc.exe） |

当前产物（2026-10-17 13:48 构建）：14848 字节，PE Subsystem=2（WINDOWS_GUI，双击不弹命令行窗口），
SHA256=`2feb2b35cb776b815273955a37edfc750c142a1fcf57a1ba14122d700a4850bf`
（根与副本两份完全一致）。图标来自现有 `3CT/resources/assets/icon.ico`。
`.gitignore` 已忽略生成的两个 exe（二进制不入库，但用户工作区里现成可用）。

## 构建（长期复现步骤）

```bat
python desktop\install.py build            :: 先生成 3CT-Auto 副本（一次即可）
python desktop\build_gui_launcher.py       :: 再生成/刷新两个 GUI 启动器入口
```

构建只重新编译启动器并复制到副本目录，**不会重新打包 app.asar，也不修改主程序 `3CT-Auto.exe`**。
临时/测试构建：`python desktop\build_gui_launcher.py --out <path> --no-icon --no-sync`。

## 行为

1. 解析目标：优先同级 `3CT-Auto\3CT-Auto.exe`，其次同目录 `3CT-Auto.exe`；
   双击时用 `Process.Start` 直接启动（`UseShellExecute=false`、`CreateNoWindow=true`、
   `WorkingDirectory` 为目标 exe 所在目录），不经过 cmd/powershell/wscript。
2. 仅对**子进程**清除 `ELECTRON_RUN_AS_NODE` / `NODE_OPTIONS` / `NODE_PATH`
   （不改用户系统环境），避免 Electron 被当成 Node 运行而以 `bad option` 直接退出。
3. 副本已在运行时：按 resolved 全路径匹配（优先有主窗口的主进程，Electron 的
   renderer/GPU 子进程同路径但无窗口，不会误判），用 `ShowWindow` +
   `SetForegroundWindow` 激活已有窗口，**不启动第二份、不杀进程、不重启**。
4. 原版 3CT 正在运行时：MessageBox 提示先完全退出原版（共享 userData 与单实例锁），
   本启动器绝不结束或修改原版进程。
5. 找不到主程序：MessageBox 提示先运行上面的构建命令。
6. 参数透传：普通参数原样转发给 Electron 主程序（使用标准 Windows 引号规则），
   双击无参时行为不变。
7. 不读取用户 profile / 账号 / token，不落敏感日志；错误只用 MessageBox 展示。

## 测试与 QA 钩子

```bat
python -m unittest discover -s tests -p "test_gui_launcher.py"
python -m unittest discover -s tests
```

测试覆盖：PE Subsystem=2、源码无 shell 调用、构建不修改 asar/主 exe、
真实子进程参数转发与 env 清理（用 `/target:exe` 编译的 fake probe 放在临时
`3CT-Auto\3CT-Auto.exe` 位置，**不执行真实业务**）、工作目录、同目录解析。

只读诊断钩子（供离线验收，普通用户不会用到）：

```bat
启动3CT自动版.exe --diagnose <json路径> [要转发的参数...]
```

只解析并写 JSON（`exe` / `exeExists` / `workingDirectory` / `argsCommandLine` /
`forwardedArgs` / `originalRunning` / `copyRunning` / `envToClear`），
不启动进程、不弹框、不激活窗口。注意：在 PowerShell 通过 `Start-Process -ArgumentList`
传含空格参数时需自行加引号；用 `cmd /c` 或 Python `subprocess` 传参会保留原始 args 边界。
