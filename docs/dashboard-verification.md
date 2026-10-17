# 看板（Dashboard）与最终包浏览器验收 —— task-11 QA

> 目的：验证 score-policy/result-store/dashboard/panel 集成、二课补分与执行记录看板、以及**最终打包副本**（app.asar 内脚本）在真实浏览器（fake ctAPI）下行为正确。
> 执行人：scheduler-dev（只读 QA；安装器升级亦在本任务范围）。结论：**source 52/0、packaged 53/0（含字节一致断言）**，安装器最终包 **356 entries / 345 unchanged / 356 integrity**，全部脚本与源字节一致。

## 1. 最终产物 hash

| 文件 | SHA256 | 说明 |
|---|---|---|
| `3CT-Auto/resources/app.asar` | `420C7A3B6134B4378B993401FFD8C2A7A44D921A72C87E06F83754026149C2A6` | 最终独立副本包（55,864,494B） |
| `3CT/resources/app.asar`（原包） | `028D4695FD7EA9AD0C51A795FD4D23A4199ADEC087760260F618698F1BDD3ADF` | 未修改（前后一致） |
| `启动3CT自动版.exe`（root） | `C7DE9962D4D856D717B813E30A3E5A754C38B08EE1372C0DE1FD0D1DEF63A4E2` | rebuild 后 GUI launcher（14,848B，PE Subsystem=2） |
| `3CT-Auto\启动3CT自动版.exe`（副本） | 同上（同一 SHA256） | 同上 |

安装器 `verify`：`entries=356`、`unchanged_verified=345`、`integrity_verified=356`、`patched_files=11`（9 个新增脚本/样式 + 被 patch 的 `index.html`、`package.json`）；退出码 0。
- entries 由「原文件 347 + 补丁新增 9」计算（`len(original_files)+len(PATCH_SOURCES)`），**不再硬编码旧 352**；原包每个文件逐一保留、未改内容一致（345 个未改文件 + 2 个被 patch 的 index/package）。

包内脚本 vs `desktop/` 源（逐字节 same=true）：
`automation.js 90,838B` / `panel.js 47,725B` / `panel.css 8,523B` / `jsQR.js 266,988B` /
`score-policy.js 22,407B` / `result-store.js 27,689B` / `dashboard.js 47,520B` / `dashboard.css 9,978B` / `auto-bootstrap.cjs 2,039B`。

加载顺序（index.html 注入）：`jsQR → score-policy → result-store → automation → dashboard → panel`；CSS `panel.css + dashboard.css`；title `3CT Auto`；package.json main=`./dist/main/auto-bootstrap.cjs`、name=`3CT`、version=`1.2.5`。

## 2. 复现命令

```powershell
# source 模式（desktop 源文件）
node tests/dashboard-smoke.cjs

# packaged 模式（从最终 app.asar 解包 dist/renderer 后加载，含字节一致断言）
python reverse/asar_extract.py --archive 3CT-Auto\resources\app.asar --out artifacts\patched-renderer --only "dist/renderer/" --only "dist/main/auto-bootstrap.cjs" --only "package.json"
$env:SMOKE_SOURCE='packaged'; node tests/dashboard-smoke.cjs; Remove-Item Env:SMOKE_SOURCE

# 安装器测试 / 构建 / 校验
python -m unittest tests.test_desktop_installer -v
python desktop/install.py build --force
python desktop/install.py verify
python desktop/build_gui_launcher.py
```

结果文件：`artifacts/dashboard/dashboard-smoke-result.json`（source，52/0）、`artifacts/dashboard/packaged-dashboard-smoke-result.json`（packaged，53/0）。

## 3. 断言覆盖（断言均走真实 DOM/按钮，无 fallback、无预置内部数据）

| 类别 | 断言 | 结果 |
|---|---|---|
| 入口 | panel `a3-open-dashboard` 真实点击打开 dashboard-root；初始空态「尚无记录」；未预置 tests/结果数据 | ✅ |
| 分数导入 | 真实点击「使用截图初值」+ confirm → 8 行；`8.5/8`、`15.5/12` 真实值（input value + 可见文本 `dashboard-score-value`） | ✅ |
| 进度条 | 8 个 `dashboard-progress-bar` 全存在；2 个（8.5/8、15.5/12）width=100%；全部不溢出（clamp） | ✅ |
| 顶部汇总 | 总缺口 29.5、已达标 2/8；官方刷新后 policy trusted/accountMatch 正确 | ✅ |
| 导入拒绝 | fake engine 返回 `{ok:false, reason:'account-mismatch'}` → UI 显示「绑定截图初值失败：account-mismatch」，不显示成功 | ✅ |
| 无 snapshot | 不显示 gap=0/全达标，显示「待导入/刷新」+ 新增报名暂停提示 | ✅ |
| **官方 partial（8→7）** | `trusted=false` 未被 UI 强转；DOM：总缺口「已知缺口 29.5 · 1 项未知」、已达标「1 / 8」、传统文化行「待确认 8.5/8（旧值待确认，不计达标/缺口）」、策略卡「已启用」非空；`canApplyCategory` allow=false(score-untrusted) | ✅ |
| 真实链路 | engine 真实 fake 提交 `ek.signIn` success → `onResult` → store 落库 1 条 → 结果 tab 可见（module/action/账号 mask/上游已接受）；preview 轮 0 条 | ✅ |
| 筛选（真实 UI） | 账号/模块/状态 3 个 select 存在；module=club+status=success 行数 4→1 且内容匹配；status=failed 生效；account=全部账号行数增加；reset 回默认 | ✅ |
| 账号隔离 | 其他账号事件默认（当前账号组）不显示；账号脱敏 `20***01`，无完整手机号 | ✅ |
| 活动完成口径 | 跨账号同 activityId complete=0；跨模块 complete=0；同身份 signIn+signOut complete=1 | ✅ |
| 事件语义 | skip 不覆盖已 success 的 status/at/day；dry-run status 无 flag 被拒收；append 写失败显式返回 false | ✅ |
| XSS | 恶意活动标题按 textContent 渲染，`window.__XSS__` 未触发 | ✅ |
| 重开持久化 | reload 后结果历史仍在、totalGap=29.5、看板可再打开 | ✅ |
| 环境 | 外部网络请求 0、pageerror 0、console.error 0；临时 profile，无真实 token | ✅ |
| 安装器 | 新 4 资源纳入 PATCH_SOURCES、加载顺序、原包无损、verify 356/345/356、--force rebuild 后补 GUI launcher | ✅（36 tests） |

## 4. 截图（artifacts/dashboard/，source 与 packaged 各一套）

| 文件（packaged 前缀 `packaged-dashboard-*`） | 内容 |
|---|---|
| `*-01-empty-overview.png` | 首次打开空态（无造数据）+ 概览 |
| `*-02-scores-after-import.png` | 截图初值导入后 8 行补分（含 8.5/8、15.5/12 可见文本） |
| `*-03-overview.png` | 概览 2/8 + 缺 29.5 + 进度条 clamp |
| `*-04-results.png` | 执行记录（真实 onResult 行 + 筛选 UI + 中文模块/动作 + 完整日期） |
| `*-05-reopened.png` | 重开持久化 |
| `*-06-overview-module-cards.png` | 逐模块成功动作卡 |
| `*-07-partial-official.png` | 官方 partial 8→7：待确认行/已知缺口/已达标 1/8 |

## 5. 已知限制 / 备注

1. 本 QA 全程 fake ctAPI + fake 账号（无 PII、无真实姓名/学号/token），不调用真实平台、不读取用户 profile。
2. 真实 Electron 已在最后补做最小加载验收（见 §6：临时独立 profile + CDP，12/0，file:// 渲染层依赖全部加载）；完整 exe 启动交互验证见 `docs/launcher-runtime-verification.md`。
3. 真实成功 ≠ 官方记分：看板仅展示“上游已接受动作数/本地导入或官方成绩快照”，不将提交成功计入官方分数。
4. build 前已确认无用户 3CT/3CT-Auto 进程；未 kill/替换任何用户进程；build --force 后立即重建 GUI launcher（两入口同 hash）。

## 6. 真实 Electron 加载（file:// 补充验收）

目的：补做“真实打包副本 + file:// 渲染层”加载检查，防止仅浏览器 http harness 通过但真实 Electron 环境依赖未加载的问题。

- 方式：root GUI launcher（`启动3CT自动版.exe`）直启真实 `3CT-Auto.exe`，参数 `--user-data-dir=<临时独立 profile> --remote-debugging-port=<未用端口> --no-first-run`；Node spawn **stdio=ignore**、CDP 直接连接（不等 pipe close）。父进程保留 `ELECTRON_RUN_AS_NODE=1` 污染验证 GUI 启动器清理。
- 结果：**12 passed / 0 failed**（`artifacts/dashboard/electron-load-result.json`）
  - 窗口 title `3CT Auto`，URL `file:///.../3CT-Auto/resources/app.asar/dist/renderer/index.html`
  - `window.Auto3CTScorePolicy` / `Auto3CTResults` / `Auto3CTDashboard` / `Auto3CTAutomation` / `Auto3CTPanel` 均加载
  - panel 入口 `a3-open-dashboard` 存在；点击后 `dashboard-root` 可见、`isOpen=true`
  - 未登录空看板：总缺口「待导入/刷新…新增报名暂停」、结果「尚无记录」——**不假达标**
  - 未点击 run/import、无业务写、无真实凭证（临时 profile 全新）
- 截图：`artifacts/dashboard/electron-panel.png`、`artifacts/dashboard/electron-dashboard.png`
- 清理：只按该临时 profile 匹配 kill 测试进程树（1 个），profile 已删除；无残留进程；未触碰用户进程。
