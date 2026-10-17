# 启动器闪退修复记录（start-3ct-auto.cmd）

## 症状

用户双击 `D:\1111\2class\start-3ct-auto.cmd`，窗口一闪即退，应用没有启动。

## 真实复现（不启动真实用户 profile）

在临时目录复制启动器后用真实 cmd 运行（保留用户污染环境变量、stdin 重定向）：

```bat
cmd /d /s /c call "D:\1111\2class\start-3ct-auto.cmd" < nul
```

修复前输出（stderr/stdout 混合，乱码为 cmd 按 GBK 解析 UTF-8 的残片）：

```
'PP' is not recognized as an internal or external command
'��实例锁，无法同时运行。' is not recognized ...
'it' is not recognized ...
'且电脑处于唤醒状态；请勿在副本中安装官方更新。' is not recognized ...
```

没有正确执行启动逻辑，窗口随脚本结束瞬间关闭。

隔离 profile 对照（`--user-data-dir=<temp> --scheduler-run-task __none__ --headless`，不跑真实业务）：

| 环境 | 结果 |
|---|---|
| 继承 `ELECTRON_RUN_AS_NODE=1` | exit=9，`3CT-Auto.exe: bad option: --scheduler-run-task` |
| 子进程清除该变量 | exit=1（预期：headless 任务不存在），输出 `headless 启动/结束 … 定时任务不存在` |

## 根因

1. **编码/换行（直接根因）**：启动器原为 UTF-8（无 BOM）+ LF 行尾，而 cmd 默认代码页 936（GBK）。
   UTF-8 中文按 GBK 两字节配对解码时会吞掉换行/引号等 ASCII 字节，导致
   `if (...)` 块被破坏、中文整行被当作命令执行，脚本迅速走完成功/错误分支 → 双击闪退。
2. **Electron Node 模式（第二隐患）**：用户环境存在 `ELECTRON_RUN_AS_NODE=1`
   （还可能有 `NODE_OPTIONS`/`NODE_PATH`），被启动的 exe 继承后 Electron 以 Node 模式
   运行，直接以 `bad option` 退出，不会出现应用窗口。
3. **括号 IF 块内的未转义括号（潜伏 blocker）**：`echo ... (including its tray icon),`
   中的 `)` 会提前闭合 `if not errorlevel 1 (...)` 块，使后续 `echo/pause` 无条件执行；
   即使原版 3CT 未运行也会走到“请先退出原版”的 pause 分支。

## 修复（仅启动器，未改 app.asar / 业务代码）

三个启动器完全一致：
`start-3ct-auto.cmd`、`desktop/start-3ct-auto.cmd`、`3CT-Auto/start-3ct-auto.cmd`

- 全部改为**纯 ASCII 英文提示 + CRLF 行尾、无 BOM**（任何代码页下 cmd 都能逐行正确解析）；
- `setlocal` 内清除 **仅子进程** 的 `ELECTRON_RUN_AS_NODE` / `NODE_OPTIONS` / `NODE_PATH`，
  不修改用户系统环境；启动的 exe 因此能正常以 Electron 模式运行；
- IF 块内 echo 文本不再包含未转义 `(` `)`；
- 缺少 `3CT-Auto.exe` 时打印可读错误 + `pause`，不再闪退；
- 原版 3CT 正在运行 → 提示先退出（共享 userData 与单实例锁），**绝不 taskkill / Stop-Process**；
- 副本已在运行 → 不重复启动；
- `start "" "%APP%" %*` 支持转发普通参数（例如隔离验证用的
  `--user-data-dir=<临时目录> --remote-debugging-port=<端口> --no-first-run`）；
- 新增仅测试用的 `AUTO3CT_LAUNCHER_DRY_RUN=1` 钩子：在**所有真实检查之后**只打印
  解析出的 APP 路径与清理后的 env，不启动应用、不绕过缺失 exe/进程检查。

`.gitattributes` 固定两个受控启动器路径 `eol=crlf`，避免未来 checkout 恢复为 LF：

```
start-3ct-auto.cmd text eol=crlf
desktop/start-3ct-auto.cmd text eol=crlf
```

## 验证

- `python -m unittest discover -s tests -p "test_launcher.py"`：18 项通过，覆盖
  ASCII/CRLF/BOM、env 清理位置、括号风险、真实 cmd 解析（无 `is not recognized`）、
  dry-run 路径/env、缺 app 可读报错、原版运行分支、副本已在运行分支、`%*` 转发、
  三份一致、以及“删掉 env 清理的临时副本会被测试抓住”的 mutation 回归。
- 真实 cmd 三分支手工验证（临时目录，未启动真实 profile）：
  - dry-run（污染 env 未手动清理）：exit 0，`ELECTRON_RUN_AS_NODE=[]`，无 pause；
  - 缺 exe：exit 1，可读英文错误 + pause；
  - 原版运行（fake findstr fixture）：exit 1，提示退出原版，无 `is not recognized`。
- 真实 GUI 启动验证由 Lead/QA 使用隔离临时 profile 执行（本文件不记录用户数据）。

## 手动排错

若仍闪退，在 cmd 中执行以下命令查看真实输出（会显示 pause，窗口不再一闪而过）：

```bat
cd /d D:\1111\2class
start-3ct-auto.cmd
```

也可以直接运行副本 exe 看主进程报错：

```bat
D:\1111\2class\3CT-Auto\3CT-Auto.exe
```

常见原因：

- 环境里 `ELECTRON_RUN_AS_NODE=1`：新启动器已在子进程内清除；若用户自己写其他脚本启动，
  需自行 `set "ELECTRON_RUN_AS_NODE="`；
- 原版 3CT 未退出：托盘图标右键退出后重试（两者共享单实例锁）；
- `3CT-Auto\3CT-Auto.exe` 不存在：先运行 `python desktop\install.py build`。
