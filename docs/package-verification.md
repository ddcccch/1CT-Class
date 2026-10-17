# 3CT-Auto 独立副本打包验证记录

> 本文只记录**可复现的本地验证**，不包含账号、token、cookie 或任何用户数据。
> 原始 `3CT/` 目录与原始 `app.asar` 在全部验证前后未被修改（SHA256 一致）。

## 1. 交付物

| 路径 | 说明 |
|---|---|
| `desktop/install.py` | 纯标准库 ASAR 读取/重建/补丁/校验 + 副本生成 CLI |
| `desktop/bootstrap.cjs` | 早期 bootstrap（禁用自动更新、关闭后台节流），`package.json main` 指向它，在 require 原 `main.js` 之前执行 |
| `desktop/vendor/jsQR.js` | 从原包 `renderer.js.map` 的 `sourcesContent` 恢复的 jsQR UMD（挂 `window.jsQR`），附 `jsQR.LICENSE.txt` |
| `desktop/{automation.js,panel.js,panel.css}` | 渲染层自动化引擎/面板/样式（由 reverse-engineer 提供，installer 原样写入 ASAR） |
| `desktop/start-3ct-auto.cmd`、根 `start-3ct-auto.cmd` | 一键启动（检测原版/副本实例，不杀进程；installer 会把启动脚本复制进副本目录） |
| `3CT-Auto/`（生成物，gitignore） | 独立副本：`3CT-Auto.exe` + 打补丁的 `resources/app.asar` + README + 启动脚本 + marker |

构建命令：

```powershell
python desktop/install.py build           # 生成 3CT-Auto（已存在则拒绝，需 --force）
python desktop/install.py verify          # 重新校验已生成副本
python desktop/install.py extract-vendor  # 需要时从原包恢复 desktop/vendor/jsQR.js
```

## 2. 静态/离线验证（已通过）

- **ASAR 全量 roundtrip**：原包 415 个条目（347 个文件 + 目录）完整解析。
  `rebuild_asar` 后重新解析，347 个文件内容逐字节一致；原包 SHA256 前后不变。
- **补丁重建**：新增 5 个文件（`dist/main/auto-bootstrap.cjs`、
  `dist/renderer/{jsQR,automation,panel}.js`、`dist/renderer/panel.css`），
  替换 `dist/renderer/index.html` 与 `package.json`；重建后 352 个文件。
- **integrity**：352 个文件的 `integrity.hash` 与 `blocks`（4MB/块 SHA256）
  全部与重建后真实内容一致；新增脚本字节与 `desktop/` 补丁源逐字节一致。
- **未改动文件**：345 个原文件内容与 integrity 均保持原样。
- **原程序保护**：构建前后原 `app.asar` SHA256 均为
  `028d4695fd7ea9ad0c51a795fd4d23a4199adec087760260f618698f1bdd3adf`；
  原 `3CT/` 目录未新增/删除任何文件；副本不复制卸载器，主程序 exe 改名
  `3CT-Auto.exe`（`package.json` 的 `name`/`version` 保持 `3CT`/`1.2.5`，
  以继续共享原 userData 与登录态）。
- **最终包（engine/panel QA freeze 后重建）**：`3CT-Auto/resources/app.asar`
  SHA256 = `d2e3b3ebfbc56875e0bdf32ec121ca4e51bf006a0e1562bb70190f91da7462ab`，
  大小 55,730,028 字节；marker 中 `patched_asar_sha256` 与之一致；7 个补丁文件
  （bootstrap/jsQR/automation/panel.js/panel.css/index.html/package.json）与
  `desktop/` 源逐字节一致（automation.js 70,306B、panel.js 42,867B、
  panel.css 8,269B、jsQR.js 266,988B、bootstrap.cjs 2,039B）。
- **目录安全**：`--force` 只允许删除本 workspace 的 `3CT-Auto/`，或带
  `.3ct-auto-install.json` marker 且源 ASAR 哈希匹配的旧副本；缺补丁输入时
  先构建后清理，失败不会毁掉已有可运行副本。
- 本仓库测试：`python -m unittest discover -s tests`（含 installer 34 项）全绿。

## 3. 运行验证（真实 Electron，隔离临时 profile）

> 仅在 `--user-data-dir=<临时目录>` 下启动；未读取原账号数据、未停止原进程，
> 结束后测试实例已全部退出并清理。原版 3CT 进程全程存活（4 个进程未受影响）。

1. **headless 加载探针**（无需窗口）：
   `3CT-Auto.exe --scheduler-run-task __none__ --headless --user-data-dir=<temp>`
   → 正常进入原程序 headless 分支，输出「定时任务不存在：__none__」并以 1 退出
   （该退出码是“任务不存在”的预期语义，不是打包失败）。
   证明：补丁后的 ASAR 能被 Electron 35 正常加载，无 ASAR 完整性 fuse 拦截，
   `bootstrap.cjs` 在 `main.js` 之前执行。
2. **隔离 GUI 启动 + CDP 检查**：
   `--user-data-dir=artifacts/test-profile --remote-debugging-port=9223
   --disable-background-networking --no-first-run`
   - `/json/version`：`Electron/35.0.2`，UA 含 `3CT/1.2.5`（名称/版本未改）。
   - `/json/list`：页面 `title = 3CT Auto`，
     `url = file:///D:/1111/2class/3CT-Auto/resources/app.asar/dist/renderer/index.html`
     （即加载的是补丁后的 index.html）。
   - 渲染层求值：`window.jsQR`=function、`window.Auto3CTAutomation`=object、
     `window.Auto3CTPanel`=object、面板节点已挂载 DOM、`window.ctAPI`=object
     （复用原 preload 桥，登录相关 IPC 能力可用）。
   - 主进程日志：`checkForUpdates failed: Error: 3CT-Auto 已禁用自动更新`
     （栈中含 `auto-bootstrap.cjs` 与 `setupAutoUpdate`），说明自动更新已被拦截，
     不会下载/安装官方更新覆盖原程序。
   - 单实例锁：共享默认 userData 时与原版互斥（预期行为，未改锁）；
     `--user-data-dir` 隔离 profile 可独立启动。
3. **未验证 / 边界**：
   - 未对真实学校/第三方业务接口做任何写入调用（无真实上游测试）；
   - 面板真实点击、一键启动/停止、重开恢复等 UI 交互由独立 Playwright smoke
     （fake `window.ctAPI`）覆盖，见 `docs/desktop-test-results.md`；
   - 每日自动执行依赖“应用保持打开 + 电脑唤醒”，关机/睡眠期间不会补跑。

## 4. 已知注意事项

- 原版正在运行时不要启动副本（共享单实例锁）；启动脚本会提示先退出原版，绝不杀进程。
- 不要在副本里安装官方更新；bootstrap 已禁用自动更新（含手动安装入口）。
- 副本与原版共享 userData，切换运行时请先退出另一个实例。
