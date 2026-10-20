# 1CT 打包与安装（packaging）

> 契约：`docs/1ct-redesign-contract.md` §6。本文档是打包链的唯一操作手册。
> 归属：packaging（`desktop/install_1ct.py`、`desktop/build_gui_launcher.py`、
> `desktop/GuiLauncher1CT.cs`、本文）。

## 0. 一句话

**从原始 `3CT/` 复制一份独立运行目录 `1CT/`，把 `app.asar` 里的
`dist/renderer/index.html` 换成 1CT 极简白入口（另注入 `dist/renderer/1ct/*`），
主程序改名 `1CT.exe` 并换成 1CT 自己的图标，再配一个无控制台的 `启动1CT.exe`。
1CT 使用**独立的 userData（`%APPDATA%\1CT`）**，因此可以和 `3CT-Auto` 同时运行。
原始 `3CT/` 与已有的 `3CT-Auto/` 都不会被修改。**

## 0.1 与 3CT / 3CT-Auto 的关系（独立化，2026-10-17 用户要求）

用户要求「1CT 与 3CT 别放一起」。落地方式：

| 维度 | 1CT | 3CT / 3CT-Auto |
|---|---|---|
| 程序目录 | `<repo>\1CT\`（自带整份 Electron，不依赖其它目录） | 各自目录 |
| userData | **`%APPDATA%\1CT`**（独立） | `%APPDATA%\3CT`（共享） |
| 单实例锁 | 自己的锁 | 自己的锁 |
| 能否同时运行 | **可以**（与 3CT / 3CT-Auto 互不干扰） | 可以 |
| 登录态 | **独立**：首次启动需重新登录（不继承 3CT 的登录态） | 共享 |
| 图标 | `desktop/1ct/assets/icon.ico`（黑底白「1」） | 厂商图标 |

**回退到共用 userData 的旧行为**（此时才会要求先退出 3CT）：

```powershell
1CT.exe --shared-user-data
# 或
$env:CT_SHARE_USER_DATA = '1'; .\启动1CT.exe
```

实现位置：`desktop/1ct/bootstrap-1ct.cjs`（`package.json` 的 `main` 指向它的
asar 副本 `dist/main/auto-bootstrap.cjs`）。它必须在 **`require('./main.js')` 之前**
调用 `app.setPath('userData', ...)`，因为原 `main.js` 顶层的 `appSettings` /
`proxyRouting` 等模块在**模块加载时**就会立即 `app.getPath('userData')` 读文件。
另外它**尊重显式 `--user-data-dir`**（打包冒烟/多开调试用的隔离 profile 不能被覆盖）。

## 1. 构建命令

```powershell
# 在仓库根目录 <repo> 执行
python desktop\install_1ct.py build                 # 生成 1CT\ + 打图标 + 编译 启动1CT.exe
python desktop\install_1ct.py build --force         # 覆盖已有 1CT\（有安全闸，见 §5）
python desktop\install_1ct.py build --no-launcher   # 只重建副本，不编译启动器
python desktop\install_1ct.py build --no-verify     # 跳过重建后自检（不建议）
```

只想刷新启动器（例如换了图标、改了提示文案）：

```powershell
python desktop\build_gui_launcher.py --brand 1ct      # 只刷 1CT（根 + 1CT\ 两处）
python desktop\build_gui_launcher.py --brand all      # 3CT 自动版 + 1CT 都刷
python desktop\build_gui_launcher.py                  # 默认行为：只刷 3CT 自动版（保持不变）
```

依赖：Python 3.11+ 标准库；Windows 自带的 .NET Framework `csc.exe`（编译启动器用，
找不到时 `install_1ct.py build` 仍会生成副本，只在 summary 里给出 `launcher_warning`）。
**不需要 npm / node / 任何第三方包。**

前置输入（由其它 teammate 产出，packaging 只读消费、绝不修改）：

| 文件 | 归属 |
|---|---|
| `desktop/1ct/index.html`、`shell.js`、`shell.css` | ui-shell |
| `desktop/1ct/members.js` | members-core |
| `desktop/1ct/ek-stats.js`、`ek-stats.css` | ek-stats |
| `desktop/jsQR.js`(vendor) | 由原包 sourcemap 自动恢复，见 §6 |

缺任何一个都会在**开始复制之前**报错并列出缺失路径，例：

```
错误: 缺少 1CT 补丁输入文件: 1ct/members.js, 1ct/shell.js
（desktop/1ct/* 由 ui-shell/members-core/ek-stats 产出，文件齐了再构建）
```

## 2. 产物

```
<repo>\
├─ 启动1CT.exe                  # 仓库根 GUI 入口（WinExe，1CT 图标，双击无控制台）
└─ 1CT\                          # 独立运行副本（整份 Electron 运行时，99 个文件）
   ├─ 1CT.exe                    # 由 3CT.exe 改名 + rcedit 换成 1CT 图标
   ├─ 启动1CT.exe                 # 副本内同名入口（在副本目录内双击也适用）
   ├─ start-1ct.cmd              # 纯 ASCII 兜底入口（排错备用）
   ├─ README-1CT.txt             # 中文使用说明（独立 userData/可同时跑/构建命令）
   ├─ HOW-TO-START-1CT.txt       # 同上，纯 ASCII+CRLF（任何控制台编码都能读）
   ├─ .1ct-install.json          # 安装标记（含 exe_sha256 / exe_icon / user_data_mode）
   └─ resources\app.asar         # 重建后的 ASAR（原包内容 + 1CT 渲染层）
```

ASAR 内注入/替换清单（与原包 347 个文件合并后共 **359** 个文件）：

| ASAR 内路径 | 动作 | 来源 |
|---|---|---|
| `dist/renderer/index.html` | **替换** | `desktop/1ct/index.html`（规范化：标题 `1CT`、favicon、CSP 兜底） |
| `dist/renderer/1ct/shell.js` | 新增 | `desktop/1ct/shell.js` |
| `dist/renderer/1ct/shell.css` | 新增 | `desktop/1ct/shell.css` |
| `dist/renderer/1ct/members.js` | 新增 | `desktop/1ct/members.js` |
| `dist/renderer/1ct/ek-stats.js` | 新增 | `desktop/1ct/ek-stats.js` |
| `dist/renderer/1ct/ek-stats.css` | 新增 | `desktop/1ct/ek-stats.css` |
| `dist/renderer/1ct/index.html` | 新增 | `desktop/1ct/index.html`（原始副本，便于排查） |
| `dist/renderer/1ct/icon.png` | 新增 | `desktop/1ct/assets/icon.png`（favicon 目标） |
| `dist/renderer/jsQR.js` | 新增 | `desktop/vendor/jsQR.js` |
| `dist/renderer/score-policy.js` | 新增 | `desktop/score-policy.js` |
| `dist/renderer/result-store.js` | 新增 | `desktop/result-store.js` |
| `dist/renderer/automation.js` | 新增 | `desktop/automation.js` |
| `dist/main/auto-bootstrap.cjs` | 新增 | **`desktop/1ct/bootstrap-1ct.cjs`**（独立 userData；不是 3CT-Auto 的 bootstrap.cjs） |
| `package.json` | **替换** | 原包 + `main` 改为 `./dist/main/auto-bootstrap.cjs` |

**不再注入**：`panel.js` / `panel.css` / `dashboard.js` / `dashboard.css`
（契约 §1：精简掉原自动化面板与看板）。`dist/renderer/index.html` 也不再加载
原版 `renderer.js` / `style.css`（React 界面整体让位给 1CT shell）。

`index.html` 实际加载清单（`verify` 会逐条断言）：

```
./1ct/shell.css, ./jsQR.js, ./score-policy.js, ./result-store.js, ./automation.js,
./1ct/members.js, ./1ct/ek-stats.js, ./1ct/shell.js, ./1ct/ek-stats.css
```

外加 favicon：`<link rel="icon" type="image/png" href="./1ct/icon.png">`。

## 3. 校验

```powershell
python desktop\install_1ct.py verify                    # 校验 1CT\ 成品
python desktop\install_1ct.py verify --require-launcher # 额外要求 启动1CT.exe 存在
python -m unittest discover -s tests -p "test_1ct*.py" -v
python -m unittest discover -s tests                    # 全量回归（含 3CT-Auto 链）
node tests\packaged-1ct-renderer.cjs                    # 打包后 renderer 离线冒烟（Edge headless）
node tests\packaged-1ct-smoke.cjs                       # 打包后真实 Electron 冒烟（临时 profile + CDP）
```

`build` 默认自带同样强度的自检（`--no-verify` 可关）。`verify` 断言：

1. **原文件零损失**：原 ASAR 的 347 个条目全部还在，除 `index.html`/`package.json`
   外逐字节一致（含 `node_modules`、`renderer.js.map` 等 20MB 大文件）；
2. **integrity 全对**：每个文件的 `sha256` + 逐块 `blocks`（blockSize=4194304）
   与重建后真实内容一致；
3. **注入内容正确**：`dist/renderer/1ct/*` 与 `desktop/1ct/*` 逐字节一致；
4. **index.html 清单**：标题是 `<title>1CT</title>`，9 个必需引用齐全，
   favicon 指向 `./1ct/icon.png`，`./panel.js` / `./panel.css` / `./dashboard.js` /
   `./dashboard.css` / `./renderer.js` 一律不得出现；
5. **图标在包里**：`dist/renderer/1ct/icon.png` 存在且是合法 PNG；
6. **package.json**：`main === "./dist/main/auto-bootstrap.cjs"`，`name` 与源一致；
7. **exe 图标**：打了图标时要求 `1CT.exe` 的图标指纹 ≠ `3CT.exe`（PE 资源目录
   RT_ICON/RT_GROUP_ICON 的 sha256）；没打图标时要求两者字节一致（防止“半套图标”）；
8. **主程序隔离**：副本内**不存在** `3CT.exe`；
9. **启动器**：`启动1CT.exe` 的 PE Optional Header `Subsystem == 2`（WINDOWS_GUI，
   双击不会闪出控制台窗口），且其图标指纹 ≠ 3CT 的；
10. **userData**：`marker.user_data_mode == "independent"`，目录为 `%APPDATA%\1CT`；
11. **原件隔离**：构建前后 `3CT/resources/app.asar` 的 SHA-256 必须完全相同。

`verify` 输出的关键字段：

```json
{
  "entries": 359,                       // 重建后文件总数（原 347 + 新增 12）
  "unchanged_verified": 345,            // 逐字节比对通过的未改动文件（347 - 2 个替换项）
  "integrity_verified": 359,
  "onect_files": ["dist/renderer/1ct/... /* 6 个 + icon.png */"],
  "index_title": "1CT",
  "index_icon_refs": ["./1ct/icon.png"],
  "icon_in_asar": "dist/renderer/1ct/icon.png",
  "main": "./dist/main/auto-bootstrap.cjs",
  "package_name": "3CT",
  "exe": {
    "sha256": "f539e078…",              // 打图标后与 3CT.exe 不同
    "source_sha256": "27de8374…",
    "icon_sha256": "10cc5faf…",         // 1CT 图标指纹
    "source_icon_sha256": "90a4e0fa…",  // 3CT 图标指纹
    "icon_differs_from_source": true,
    "icon_count": 7
  },
  "user_data": {"mode": "independent", "dir": "%APPDATA%\\1CT"}
}
```

### 打包后冒烟（真实验收，不只依赖 verify）

`verify` 只能证明**字节与清单**正确，证明不了界面真能渲染。实测踩过的坑：
1CT 首版 `index.html` 的根节点自带 `class="one-ct-app"`，而 `shell.js` 的
`mount()` 用 `.one-ct-app` 存在性做幂等守卫 → 界面**完全不渲染**且**零 JS 报错**，
`verify` 依旧全绿。因此必须有渲染冒烟：

| 脚本 | 做法 | 断言 |
|---|---|---|
| `tests/packaged-1ct-renderer.cjs` | 从 `1CT\resources\app.asar` 解出 `dist/renderer/**` 到临时目录，用本机 Edge/Chrome headless 以 `file://` 打开 | title=1CT；`#one-ct-root` 内节点 > 20；四 tab 齐备；`.one-ct-app` 唯一（无双重挂载）；body 背景 `rgb(255,255,255)`；注入 fake `ctAPI` + 3 名成员后成员页 3 行；无 pageerror/console.error；**零外部网络请求**（route 拦截非 file:/data:/blob:） |
| `tests/packaged-1ct-smoke.cjs` | 用根 `启动1CT.exe` 真起 `1CT\1CT.exe`（临时 `--user-data-dir` + `--remote-debugging-port`），经 CDP 连真实窗口 | 同上核心项 + 窗口标题 1CT + URL 来自打包 `app.asar` + `window.ctAPI` 由原 preload 注入 + 原版 panel/dashboard 全局不存在；结束时只结束临时 profile 匹配的进程树 |

两个脚本都**不读用户 profile、不启动用户副本、不 kill 用户进程、不触网**。
`artifacts/1ct-packaged-*.png` 是它们留下的截图；`artifacts/1ct-packaged-renderer-result.json`
与 `artifacts/1ct-packaged-smoke-result.json` 是结果（含每项 PASS/FAIL 明细）。

### 构建后 sha256 交叉一致性

`desktop/1ct/*` 的源文件哈希必须与 asar 内 `dist/renderer/1ct/*` 完全一致
（`build` 用快照注入并在 summary 里用 `input_drift` 报告构建期间被改动的素材）。
ui-shell 的 `artifacts/1ct-shell-result.json` 会记录它的三个文件 sha256，可直接
与 asar 内副本对照，确认“dev 版 == 打包版”。

## 4. 运行时行为

- 窗口标题：`1CT`（来自 1CT 版 `index.html` 的 `<title>`；原 `main.js` 的
  BrowserWindow 没写死 title，由页面决定）。
- **userData：`%APPDATA%\1CT`**（`bootstrap-1ct.cjs` 里 `app.setPath`，
  在 `require('./main.js')` 之前执行）。可由 `--shared-user-data` /
  `CT_SHARE_USER_DATA=1` 回退到共用 `%APPDATA%\3CT`；显式 `--user-data-dir`
  会被尊重（隔离测试用）。
- `auto-bootstrap.cjs`（= `bootstrap-1ct.cjs`）在 `dist/main/main.js` 之前执行：
  设独立 userData + 禁用自动更新（`autoUpdater.autoDownload=false`、覆盖
  `checkForUpdates/quitAndInstall/setFeedURL`、`CT_UPDATE_URL=''`）+
  `webContents.setBackgroundThrottling(false)`（最小化后自动化计时器仍按计划触发）。
- 启动器：`UseShellExecute=false` / `CreateNoWindow=true` 直接起 `1CT\1CT.exe`，
  **仅对子进程**清理 `ELECTRON_RUN_AS_NODE` / `NODE_OPTIONS` / `NODE_PATH`
  （用户环境被 `ELECTRON_RUN_AS_NODE=1` 污染时，Electron 会以 Node 模式启动并
  `bad option` 直接退出）。不修改系统环境、不调用 cmd/powershell。

## 5. `--force` 覆盖保护（绝不误删用户目录）

`--force` 只有在下面两种情况才允许删目标目录：

1. 目标就是本仓库的 `<repo>\1CT`；
2. 或者目标里有 `.1ct-install.json`，且 `generator == "desktop/install_1ct.py"`、
   `source_asar_sha256` 与当前 `3CT/resources/app.asar` 一致、`source` 路径一致。

否则报 `拒绝删除未确认的目录` / `哈希与当前原程序不一致` 并**保留原目录**。
另外，所有可能失败的步骤（缺输入、ASAR 重建）都在删除旧副本**之前**完成——
构建失败不会毁掉一个还能跑的旧副本。

## 6. jsQR（唯一的外部生成物）

`desktop/vendor/jsQR.js` 是 gitignore 的生成物，从原包
`dist/renderer/renderer.js.map` 的 `sourcesContent` 里恢复（`binarize` 校验 +
长度检查）。缺失时 `build` 会尝试自动恢复；恢复失败则报错并提示：

```powershell
python desktop\install_1ct.py extract-vendor
```

二课扫码图库路径保留 jsQR 是契约 §6 的硬要求。

## 6.1 官方成绩同步（scores-sync）对打包的影响：**没有**

`members.js` 后来又加了官方成绩同步能力（`syncOfficialScores` / `syncAllOfficialScores`，
含 Info 交叉校验、account-mismatch 拒绝、preview-blocked、并发单飞、6h 默认节流）。
对打包链来说这属于**纯渲染层内部改动**：

| 方面 | 是否变化 |
|---|---|
| ASAR 注入清单 | **不变**（仍是那 12 个新增 + 2 个替换，`entries` 仍是 359） |
| ASAR 内文件路径 | **不变**（同步 API 全在 `dist/renderer/1ct/members.js` 内部） |
| `index.html` 引用 | **不变**（不需要新增 `<script>`） |
| package.json / main | **不变** |
| 主进程 / IPC | **不变**（仍走原 `window.ctAPI` 的既有 IPC） |
| 新增第三方依赖 | **无** |

因此：**只要 `desktop/1ct/*` 定稿，`build --force` 就会自动带上新功能，打包脚本和
verify 断言都无需改动**。唯一会变的是 `dist/renderer/1ct/members.js` 的
sha256 / size，以及 `.1ct-install.json` 里记录的 `patched_asar_sha256`。

校验侧无需新增断言；`verify` 第 3 条（注入文件与 `desktop/1ct/*` 逐字节一致）
已经覆盖“打包的 members.js 就是定稿版”这件事。

> 记录：task-10 构建时（21:11:34）用的是 members.js 70,908B / shell.js 106,251B 的版本；
> 之后 scores-sync 把 members.js 改到 103,513B、ui-shell 把 shell.js 改到 125,944B。
> 最终交付前必须重新 `build --force`，否则产物里是旧渲染层。

## 7. 与 3CT-Auto / 原版 3CT 并存（重要）

**默认：完全独立，可以同时运行。**

1CT 使用自己的 userData（`%APPDATA%\1CT`）和自己的单实例锁，因此：

- ✅ 三个程序目录可以同时存在，盘上互不干扰（各有整份 Electron 运行时与 app.asar）；
- ✅ 1CT 与 3CT / 3CT-Auto **可以同时运行**（实测：3CT-Auto 在跑时 1CT 正常起窗口）；
- ✅ 1CT 自己同一时刻仍然只能开一个（自己的单实例锁）；
- ⚠️ 1CT **首次启动需要重新登录**：它不继承 3CT 的登录态（这是独立的代价和目的）。

### `启动1CT.exe` 的进程检测

| 场景 | 检测到 | 行为 |
|---|---|---|
| 默认（独立 userData） | `1CT.exe` 已运行（按 resolved 全路径匹配） | 只激活已有主窗口，不重复启动 |
| 默认（独立 userData） | `3CT.exe` / `3CT-Auto.exe` 在运行 | **忽略，正常启动**（不冲突） |
| `--shared-user-data` | `3CT.exe` / `3CT-Auto.exe` 在运行 | MessageBox 提示先完全退出，退出码 2 |
| 任意模式 | 都没有 | 清理子进程 Node 环境变量后启动 `1CT\1CT.exe` |

**启动器绝不 `taskkill` / 结束任何进程**，也不会修改任何已有 exe / asar。
`start-1ct.cmd` 兜底脚本同样只提示、不杀进程，检测到 3CT 时也只 print 一句
“那是正常的，两者可同时运行”。

### 与契约/口述的差异记录

| 项 | 契约/口述 | 实际实现 | 原因 |
|---|---|---|---|
| `productName` 改成 1CT | Lead 口述要求 | **默认不改**（`--product-name 1CT` 可显式打开） | Electron 的 `app.name` 优先取 `productName`。虽然现在改用 bootstrap 显式 `setPath`，但改 `name` 会连带影响单实例锁路径等；保持 `name=3CT` 而用 `setPath` 定向改 userData 是更小侵入的做法。契约 §6 只要求**窗口标题**是 1CT，由 index.html `<title>` 提供。`verify` 会断言 `name` 未被改动。 |
| userData | task-7 时期：与 3CT-Auto **共用** `%APPDATA%\3CT` | task-10 起：**默认独立** `%APPDATA%\1CT`，可用 `--shared-user-data` 回退 | 用户新要求「别放一起」+「两者可同时跑」。共用模式作为显式回退保留。 |
| 启动器源码 | 任务书写 `desktop/GuiLauncher.cs` 改造 | **新建 `desktop/GuiLauncher1CT.cs`**，`GuiLauncher.cs` 一字未改 | `GuiLauncher.cs` 正在为**在用的** 3CT-Auto 提供入口，原地改成 1CT 会直接打断 3CT-Auto 的启动链。 |
| 启动器进程检测 | task-7：3CT/3CT-Auto 在跑即阻止 | task-10：**默认不阻止**，只有 `--shared-user-data` 时才阻止 | 独立 userData 后不再共享单实例锁。 |
| `desktop/install.py` | 任务书允许“改造或新建” | **不改**，新建 `desktop/install_1ct.py` 并 `import` 复用其 ASAR 原语 | 3CT-Auto 的构建链保持逐字节不变。 |
| `1CT.exe` 与 `3CT.exe` 同哈希 | task-7 当时是“删改前证据” | task-10 起 **不同**：rcedit 打了 1CT 图标 | 用户要求「别用 3CT 的图标」。 |

## 7.1 图标（1CT 自己的，不用 3CT 的）

产物：

| 文件 | 说明 |
|---|---|
| `desktop/1ct/assets/icon.ico` | 10,085 B，7 个尺寸：16/24/32/48/64/128/256 |
| `desktop/1ct/assets/icon.png` | 256×256，注入 asar 作 favicon |
| `desktop/1ct/assets/tools/rcedit.exe` | v2.0.0，随仓库走，构建可复现 |

设计：黑色圆角方块 + 白色「1」，配色与极简白 UI 一致（`#111113` / `#FFFFFF`）。

应用位置：

1. **`1CT\1CT.exe` 文件/任务栏图标** —— 用 rcedit 写入（只改副本）：
   ```powershell
   desktop\1ct\assets\tools\rcedit.exe "1CT\1CT.exe" --set-icon "desktop\1ct\assets\icon.ico"
   ```
   `install_1ct.py build` 会自动执行这步，并把新的 exe SHA-256 记入
   `.1ct-install.json` 的 `exe_sha256`、`exe_icon`。
2. **`启动1CT.exe` 启动器图标** —— `csc /win32icon:desktop\1ct\assets\icon.ico`。
3. **窗口 favicon** —— `index.html` 注入
   `<link rel="icon" type="image/png" href="./1ct/icon.png">`，`icon.png` 一起进 asar。

**降级策略**（无 rcedit / 无 ico / rcedit 失败时）：不阻断构建，
`summary.exe_icon = "skipped"` + `exe_icon_reason` 说明原因；此时只剩启动器图标
+ favicon（任务栏仍是 3CT 图标，因为 exe 图标没换成）。`verify` 会区分这两种情况：
- 打了图标 → 要求 `1CT.exe` 图标指纹 ≠ `3CT.exe`；
- 没打图标 → 要求 `1CT.exe` 与 `3CT.exe` 字节一致（否则报错，避免“半套图标”）。

rcedit 下载：<https://github.com/electron/rcedit/releases>（v2.0.0，
sha256 `3E7801DB1A5EDBEC91B49A24A094AAD776CB4515488EA5A4CA2289C400EADE2A`）。

## 8. 常见问题

**Q：`build` 报 `补丁文件与补丁源不一致`？**
A：`desktop/1ct/*` 在构建过程中被其它 teammate 改写了。重新执行 `build --force`
即可（构建会先把素材快照读一次再写 ASAR，summary 里的 `input_drift` 会列出
构建后被改动的文件）。

**Q：窗口标题不是 1CT？**
A：确认 `1CT\resources\app.asar` 里的 `dist/renderer/index.html` 是 1CT 版：
`python desktop\install_1ct.py verify` 会直接报错。也可能是启动的是旧副本，重建即可。

**Q：`1CT.exe` 图标还是 3CT 的？**
A：说明 rcedit 那步降级了。看 `build` 输出的 `exe_icon` / `exe_icon_reason`；
确认 `desktop\1ct\assets\tools\rcedit.exe` 与 `icon.ico` 存在后重建。

**Q：双击 `启动1CT.exe` 提示「检测到 3CT-Auto 正在运行」？**
A：只会在 `--shared-user-data` 模式下出现。默认模式不会再拦 3CT-Auto，
两者可同时运行；去掉该开关即可。

**Q：登录态没了 / 要重新登录？**
A：这是独立 userData 的预期行为。想沿用 3CT 的登录态就用
`1CT.exe --shared-user-data`（此时不能与 3CT / 3CT-Auto 同时跑）。

**Q：改了 `desktop/1ct/*` 之后要做什么？**
A：重新 `python desktop\install_1ct.py build --force`。渲染层文件是**打包进
app.asar** 的，改磁盘上的源文件不会影响已生成的 `1CT\`。

## 9. 相关文件

| 文件 | 作用 |
|---|---|
| `desktop/install_1ct.py` | 1CT 安装/打包/校验主脚本（本链唯一入口，含 rcedit 打图标） |
| `desktop/1ct/bootstrap-1ct.cjs` | 1CT 专用 bootstrap：独立 userData + 禁更新 + 关后台节流 |
| `desktop/1ct/assets/icon.ico` / `icon.png` | 1CT 图标（7 尺寸 ico + 256 png） |
| `desktop/1ct/assets/tools/rcedit.exe` | 给副本 exe 打图标（v2.0.0） |
| `desktop/install.py` | 3CT-Auto 链（提供 ASAR 读写原语，被复用；未改动） |
| `desktop/build_gui_launcher.py` | 双品牌 GUI 启动器构建（`--brand 3ct\|1ct\|all`，按品牌选图标） |
| `desktop/GuiLauncher1CT.cs` | 1CT 启动器源码（WinExe，独立 userData 意识） |
| `desktop/GuiLauncher.cs` | 3CT-Auto 启动器源码（未改动） |
| `desktop/bootstrap.cjs` | 3CT-Auto 的早期 bootstrap（1CT 不再使用） |
| `tests/test_1ct_installer.py` | 1CT 打包链测试（81 项） |
| `tests/packaged-1ct-renderer.cjs` | 打包后 renderer 离线冒烟（45 项） |
| `tests/packaged-1ct-smoke.cjs` | 打包后真实 Electron 冒烟（22 项） |

## §7.2 Windows 任务栏图标的真正来源：AppUserModelID

改了 `1CT.exe` 的图标、也换了 `resources/assets/favicon.ico`，任务栏**仍可能**显示 3CT 图标。原因是 Windows 任务栏按钮的图标不是直接取 exe 的，而是：

    窗口 AUMID → 去开始菜单/桌面找 **AUMID 相同的快捷方式** → 用那个快捷方式的图标

原版 `app.setAppUserModelId('top.can6.3ct.app')` 恰好命中了 3CT 安装时留下的
`%APPDATA%\Microsoft\Windows\Start Menu\Programs\3CT.lnk`，所以任务栏永远显示 3CT 图标。

**修法**：构建时把 `dist/main/main.js` 里的 `"top.can6.3ct.app"` 替换为
`"top.can6.1ct.app"`（见 `MAIN_JS_TEXT_REPLACEMENTS` 的 `AppUserModelID` 项）。
换成 1CT 专属 AUMID 后，Windows 找不到对应快捷方式 → 回落到窗口图标
（`resources/assets/favicon.ico`）与 exe 图标（rcedit 打过），两者都已是 1CT。

verify 断言：新 AUMID 存在、旧 AUMID 不残留、替换后 main.js 长度不变（3ct→1ct 等长）。

**升级后如果任务栏仍是旧图标**：Windows 按 AUMID 缓存图标，重启一次程序通常就好；
顽固时重启资源管理器（`taskkill /f /im explorer.exe & start explorer`）即可。
