# GUI 启动器（无控制台）QA —— task-8 独立只读验收

> 目的：验证双击入口 `启动3CT自动版.exe` 为 **WinExe 无控制台**、直启 Electron 主程序、仅对子进程清理 Electron Node 环境，并转发参数。
> 执行人：scheduler-dev（只读 QA，未改 cli-dev 代码；源码/main binary 均在 freeze 状态）。
> 结论：**21 passed / 0 failed / 1 skipped（active 实例前台激活明确未测）**，`ok=true`。

## 1. 被测对象

| 文件 | 大小/时间 | SHA256 | 说明 |
|---|---|---|---|
| `启动3CT自动版.exe`（root） | 14,848B / 2026-10-17 13:48:02 | `2FEB2B35CB776B81…` | PE Subsystem=2，图标 32×32 |
| `3CT-Auto\启动3CT自动版.exe`（副本） | 14,848B / 同上 | 同 SHA256 | 同上 |
| `desktop/GuiLauncher.cs` | 10,762B | — | 已读源码（只读），317 行 |
| `3CT-Auto\3CT-Auto.exe` | 199,107,584B | `27DE8374…` | 未改动；app.asar 仍为 `D2E3B3EB…` |

## 2. 验证方法（小 QA，不启动真实用户副本/不读用户 profile）

测试脚本：`tests/gui-launcher-smoke.ps1`（PowerShell 7 运行，UTF-8 BOM；支持 `-SkipDynamic`）。
结果：`artifacts/gui-launcher-result.json`。

1. **PE Subsystem**：解析 DOS→PE→可选头，`Subsystem` 字段 = **2 (WINDOWS_GUI)**，证明无控制台；两 exe 均验证。
2. **图标**：`[System.Drawing.Icon]::ExtractAssociatedIcon(exe)` 非空（32×32）。
3. **源码静态扫描**：`GuiLauncher.cs` 不含 cmd/powershell/pwsh/wscript/cscript/`runas`，也不通过 shell 拉起（仅 `UseShellExecute=false` 的 `Process.Start`；静态扫描已排除该属性名，只拦真正的 shell 用法 —— 这是本轮修正的测试 bug）。
4. **`--diagnose` 不启动断言**：GUI 启动器自带 `--diagnose <json>`（只解析、不启动、不弹框）；在临时目录验证 resolve/工作目录/参数转发/env 清理名单。
5. **动态 fake probe（隔离临时目录）**：临时目录复制 GUI launcher，同目录放 csc 编译的 probe 并命名为 `3CT-Auto.exe`（走真实 resolve 路径，无真实 app 风险）；父进程故意设污染 env（`ELECTRON_RUN_AS_NODE=1`、`NODE_OPTIONS`、`NODE_PATH`），断言 probe 收到：
   - `ELECTRON_RUN_AS_NODE` / `NODE_OPTIONS` / `NODE_PATH` **均为空**（由 launcher 清理，非测试手动清）；
   - **`GetConsoleWindow()` 返回 0**（子进程无控制台，直接 no-console 证据）；
   - 参数 `--probe-arg-1 --probe-arg-2` 原样透传；工作目录为临时隔离目录（非用户 profile）；
   - launcher 启动后 ~112ms 快速退出；窗口内无 cmd/pwsh/wscript/cscript 子进程被拉起。
6. **启动前动态枚举**现有 3CT/3CT-Auto 进程（只读快照，不 kill/不重启/不新开）：本次运行前快照 `none`。

## 3. 结果

| 类别 | 断言 | 结果 |
|---|---|---|
| 存在性 | 两个 GUI launcher exe 均存在 | ✅ |
| PE | root/副本 Subsystem=2（无控制台） | ✅ |
| 图标 | root/副本 图标可提取（32×32） | ✅ |
| 源码 | 无 cmd/pwsh/wscript/cscript/ShellExecute 真调用/runas | ✅ |
| 源码 | 使用 Process.Start 直启 + 显式 `UseShellExecute=false` | ✅ |
| 源码 | 显式清理 `ELECTRON_RUN_AS_NODE` | ✅ |
| 进程快照 | 启动前无现有 3CT 进程（不会误判 guard） | ✅ |
| probe | 编译/放置/被拉起（真实 resolve 路径） | ✅ |
| no-console | launcher 快速退出 + 子进程 `GetConsoleWindow()==0` | ✅ |
| env | 三个 Electron Node env 均已清空 | ✅ |
| 参数 | `--probe-arg-1 --probe-arg-2` 原样透传 | ✅ |
| cwd | 子进程 cwd = 临时隔离目录 | ✅ |
| 无 shell | 启动窗口内无 cmd/pwsh 等进程 | ✅ |
| active 实例前台激活 | **未测**（不启动真实用户副本；不影响无控制台交付结论） | SKIP |

## 4. 清理

- 临时 probe 目录 `artifacts\gui-probe-*`（launcher 副本、probe、输出 JSON）已全部删除。
- 无残留 `3CT-Auto.exe` / `3CT.exe` / `启动3CT自动版.exe` 进程；未启动真实用户副本、未读用户 profile、未触碰现有用户进程。
- 未执行 git 提交；`.gitignore` 已含 launcher exe 与副本目录（cli-dev 处理）。

## 5. 限制 / 备注

1. **active 实例激活（不新开）未测**：需要用户真实副本运行；按 lead 要求本轮不做，避免启动真实 profile。源码层面已按 resolved 全路径 + 主窗口句柄匹配，QA 未验证该交互。
2. 双击场景的 MessageBox 错误分支（缺 exe / 原版运行中）为静态+源码审阅，不做真实点击（会弹框阻塞自动化）。
3. 首次 QA 两处失败均为**测试脚本自身**问题（`ShellExecute` 属性名误拦、PS7 `Add-Type -OutputType` 不支持），已改为「只拦真 shell + csc /target:exe 编译 probe」，修正后一次全绿；launcher 源码/二进制未改。
