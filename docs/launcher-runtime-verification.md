# Launcher 真实入口运行验收（task-7 独立验证）

> 目的：验证用户真实入口 `start-3ct-auto.cmd`（双击路径）在**被污染环境**下能正常拉起 3CT-Auto 并加载自动化面板。
> 执行人：scheduler-dev（独立验收，未改 cli-dev launcher/tests）。结论：**21/21 通过，ok=true**。

## 1. 被测对象

- 入口：仓库根 `start-3ct-auto.cmd`（与 `desktop/`、`3CT-Auto/` 三份一致：3410B、纯 ASCII、CRLF×84、无 BOM、mtime 2026-10-17 13:21:50）
- 拉起目标：`3CT-Auto\3CT-Auto.exe`（最终包，app.asar sha256 `D2E3B3EB…`，55,730,028B；见 `docs/desktop-test-results.md`）
- 脚本：`tests/launcher-runtime.cjs`（新增独立验收脚本，不改 launcher）

## 2. 验收方法（按 lead 指定，模拟用户路径而非绕开）

1. **保留污染环境**：从 cmd 入口启动，env 带 `ELECTRON_RUN_AS_NODE=1`（**不手动清**，必须由 launcher 的 `setlocal` 自行清理）。
2. **Phase 1 - dry-run**（不启动 GUI）：`AUTO3CT_LAUNCHER_DRY_RUN=1` 经 cmd 调 root launcher，断言 exit=0、输出 `APP=…` 与 `ELECTRON_RUN_AS_NODE=[]` / `NODE_OPTIONS=[]` / `NODE_PATH=[]`。
3. **Phase 2 - 真实 GUI**：同一 cmd 入口 + 污染 env，带隔离参数
   `--user-data-dir=artifacts\launcher-profile-<临时> --remote-debugging-port=<未用端口> --no-first-run`（经 launcher `%*` 透传）。
4. **Playwright `connectOverCDP`** 连接该实例，断言窗口/面板/默认状态/无真实凭证。
5. **清理**：只按临时 profile 路径匹配杀掉本次测试进程树（`taskkill /T`），删除临时 profile 与临时 wrapper；不碰用户原进程。
6. 说明：Node 经 cmd 传参存在双层引号问题，脚本用**临时 ASCII CRLF wrapper.cmd**（内容 `call "<root launcher>" <args>`）作为 cmd 输入；`child 'exit'` 事件（而非 `close`）等待 cmd 结束，避免 exe 继承管道导致死等。

## 3. 结果（21/21 PASS，ok=true）

| 断言 | 结果 |
|---|---|
| 预检：无其它 3CT/3CT-Auto 进程占用单实例 | ✅ |
| dry-run：无 3CT 进程时 exit=0 | ✅ |
| dry-run：输出 dry-run 标记（APP 等） | ✅ |
| launcher 自身清理 ELECTRON_RUN_AS_NODE（输出 `[]`） | ✅ |
| launcher 进程 start 后立即返回 0 | ✅ |
| CDP 已就绪（真实 3CT-Auto.exe 被拉起；Electron/35.0.2, Chrome/134） | ✅ |
| connectOverCDP 拿到 1 个 context | ✅ |
| 窗口 title = **3CT Auto** | ✅ |
| `window.ctAPI` 已桥接（含 ek/club/unirun/scheduler 等 25 组） | ✅ |
| 自动化面板/引擎脚本已加载（Auto3CTPanel / Auto3CTAutomation） | ✅ |
| 自动化面板在真实窗口中可见（fixed 定位按 rect+computed 判定） | ✅ |
| 三个业务模块开关存在且默认全部关闭 | ✅ |
| 默认预览模式开启 | ✅ |
| 默认状态「未启动」 | ✅ |
| 临时 profile 中无二课真实会话 / 无校园跑真实账号 | ✅ |
| ctAPI 三业务组桥接（仅观察，未调用任何业务写接口） | ✅ |
| 截图 `artifacts/launcher-fixed.png` 已生成（258KB，真实 3CT 主页+AutoPanel） | ✅ |

- 实例详情：窗口 URL `file:///D:/1111/2class/3CT-Auto/resources/app.asar/dist/renderer/index.html`；测试端口 55272。
- 结果 JSON：`artifacts/launcher-runtime-result.json`（`ok=true, passed=21, failed=0`，含 dry-run 输出、ctAPI 组列表、面板状态、清理记录）。

## 4. 清理确认

- 测试实例进程树：仅按临时 profile 匹配杀死（`killed=[{pid:11224, name:"3CT-Auto.exe"}]`，`/T` 连带子进程）；运行后复查**无任何残留 3CT-Auto.exe / 3CT.exe 进程**。
- 临时 profile `artifacts\launcher-profile-*`：已删除（`deleted=True`，复查无残留）。
- 临时 wrapper `artifacts\launcher-invoke-*.cmd`：已删除（复查无残留）。
- 用户原进程/原 userData：未触碰；测试使用全新临时 profile，未读取任何真实 token。

## 5. 备注

- 13:26/13:27 两次失败均为**测试脚本自身问题**（Node→cmd 参数双层引号、`await child.close` 死等），不是 launcher 缺陷；修正测试启动路径后一次通过（launcher 未再改动）。
- 本次为最终验收证据；后续如 launcher/包再变，需重跑本脚本。
