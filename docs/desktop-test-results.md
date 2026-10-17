# 3CT AutoPanel 离线浏览器验收 + scheduler 验证结果

> 任务：task-6（离线浏览器验收自动化面板并交叉审查）。范围：`tests/desktop-smoke.cjs`、`tests/desktop-smoke.html`、`docs/desktop-test-results.md`、`artifacts/`。
> 结论（**最终版**）：**UI fake-ctAPI 回归 desktop 模式 54/54、打包副本模式 55/55 全部通过**；engine 51/51（作者范围 freeze 版）；scheduler CAS 修复后 45/45；全量 Python 164 通过、reverse 7 通过。未启动真实 Electron，未读取任何真实账号/token。
>
> **最终包状态：已最终验证通过。** `3CT-Auto/resources/app.asar`（sha256 `d2e3b3eb…`，55,730,028B，确定性 rebuild）经 `desktop/install.py verify`（entries=352 / unchanged_verified=345 / integrity_verified=352 / patched_files=7，退出码 0）与解包逐字节对拍确认：包内 `automation.js/panel.js/panel.css/jsQR.js/auto-bootstrap.cjs` 与 `desktop/` 冻结源**字节一致**，`packaged` 模式 smoke 55/55 通过。

### 最终 hash（2026-10-17 13:0x 最终包）

| 文件 | SHA256 | 字节数 |
|---|---|---|
| `3CT-Auto/resources/app.asar` | `D2E3B3EBFBC56875E0BDF32EC121CA4E51BF006A0E1562BB70190F91DA7462AB` | 55,730,028 |
| 原 3CT 包（未修改） | `028D4695FD7EA9AD0C51A795FD4D23A4199ADEC087760260F618698F1BDD3ADF` | — |
| 包内/源 `automation.js` | `C421D4BD4E2956FEFA5BDDE81FA69FD024E86B942941AE68008CF9037F255C5A` | 70,306 |
| 包内/源 `panel.js` | `774A63A4E67A3F18C27E5EAF17E281F0E5807F49D5004921792E7EF837C04DCB` | 42,867 |
| 包内/源 `panel.css` | `8017D1DB12394CCD110A3A24CE26DF815142E26EABB609D0C267D1AA8034682F` | 8,269 |
| 包内/源 `jsQR.js` | `3AE24EF919A523BA…` | 266,988 |
| 包内/源 `auto-bootstrap.cjs`（源 `bootstrap.cjs`） | `3407B4E8F4201317…` | 2,039 |

> index.html 标记齐全（`./jsQR.js`、`./automation.js`、`./panel.js`、`./panel.css`、`<title>3CT Auto</title>`）；`package.json` main=`./dist/main/auto-bootstrap.cjs`、name=`3CT`、version=`1.2.5`。
> 注：`artifacts/patched-renderer/` 是解包生成物，不入 git（lead 已加 ignore）。

## 1. 环境与安全声明

| 项 | 值 |
|---|---|
| 浏览器 | Microsoft Edge（本机，`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`），Playwright-core `1.58.2` 驱动 |
| Node / Python | Node `v24.19.0`（脚本内可用 `PLAYWRIGHT_CORE` 覆盖 playwright-core 路径）/ Python `3.12.14` |
| 被测脚本 | `desktop/panel.js` + `desktop/panel.css` + `desktop/automation.js` + `desktop/vendor/jsQR.js`（本次为 cli-dev freeze 版） |
| 数据来源 | `tests/desktop-smoke.html` 内置 **fake ctAPI** + fake 账号（`13800000000/fake-pw/acc-fake-1`），无真实凭证 |
| 浏览器 profile | 每次运行新建临时目录（`launchPersistentContext`，运行后删除），不接触原 3CT userData |
| 网络 | 静态 server 仅放行 5 个文件（详见 §3），其余 404；Playwright 拦截并中止所有非 localhost 请求 → **全程外部请求 0** |
| 截图 | 只含 fake 账号；状态页已断言不含完整手机号/密码/token |

## 2. 复现命令

```powershell
cd D:\1111\2class
# UI smoke（Edge + fake ctAPI，约 25s，产出截图与 result JSON）
& 'C:\Program Files\nodejs\node.exe' tests\desktop-smoke.cjs

# 打包副本模式：先从 3CT-Auto app.asar 解出 renderer，再跑同一套断言
& 'C:\Users\兑\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe' reverse\asar_extract.py `
    --archive 3CT-Auto\resources\app.asar --out artifacts\patched-renderer --only "dist/renderer/"
$env:SMOKE_SOURCE='packaged'; & 'C:\Program Files\nodejs\node.exe' tests\desktop-smoke.cjs; Remove-Item Env:SMOKE_SOURCE

# scheduler（含 CAS 竞态测试）
& 'C:\Users\兑\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe' -m unittest tests.test_scheduler -v

# 全量（含 CLI/config/installer 等）
& 'C:\Users\兑\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe' -m unittest discover -s tests
```

结果文件：`artifacts/desktop-smoke-result.json`（源文件模式）、`artifacts/desktop-smoke-result-packaged.json`（打包副本模式），各自含逐条断言、externalRequests、pageErrors、consoleErrors、截图清单。

## 3. 烟测结构（安全设计）

- `tests/desktop-smoke.html`：本地页面，先注入 fake `window.ctAPI`（ek/club/unirun 三组接口 + `__fake` 调用记录面），再按真实顺序加载 `vendor/jsQR.js → automation.js → panel.js`；fixture 只写 fake localStorage（账号/会话/配置），**不预置模块 enabled**（必须由 UI 勾选）。
- `tests/desktop-smoke.cjs`：
  - 内置静态 HTTP server，**只放行** `/tests/desktop-smoke.html`、`/desktop/automation.js`、`/desktop/panel.js`、`/desktop/panel.css`、`/desktop/vendor/jsQR.js`（`path.relative` 防穿越），其余 404；
  - 用 `chromium.launchPersistentContext(临时 profile, executablePath=Edge, headless=true)`；
  - 路由拦截所有非 `127.0.0.1` 请求；监听 `pageerror` / `console.error` / dialog（confirm 按 case 接受或取消）；
  - 截图 `clip` 到面板近景（480 宽 + 周边），逐张人工核对可读性。

## 4. UI 验收断言（54 项全部通过，desktop 源文件快照）

覆盖 lead/cli-dev 指定的关键点：

| 类别 | 断言要点 | 结果 |
|---|---|---|
| 面板打开 | `[data-testid=a3-panel]` 可见、标题「3CT 自动业务」、初始「未启动」、预览默认勾选 | ✅ |
| 三模块开关 | `a3-module-unirun/club/ek` 存在且**默认未勾选**；勾选后 `config.*.enabled=true` 落盘 | ✅ |
| 账号/校区下拉 | `a3-account`/`a3-campus` 初始为「请选择」占位、**不自动选第一项**；手动选择后 `accountId/campusId` 落盘 | ✅ |
| 取消/接受 confirm | 取消后仍是预览（`dryRun=true`）；接受后 `dryRun=false` 同步进引擎配置 | ✅ |
| **真实执行非假成功（critical）** | 模块+账号+校区齐备后真实启动，fake `unirun.autoRun` 写调用 `0→1`，状态「运行中（真实提交）」 | ✅ |
| 阻断矩阵 | ①未启用任何模块→阻断「没有启用任何业务模块」；②仅开 unirun、账号空→阻断；③只选账号、校区空→阻断；每个 case `writes=0` 且状态仍「未启动」 | ✅ |
| 同日去重 | 再次真实启动不重复 `unirun.autoRun`（`done` key 生效） | ✅ |
| busy 防重 | 运行中「立即预览」按钮 disabled；运行中再次派发 click 只产生一轮（rounds+1） | ✅ |
| 停止语义 | 停止后已发出的请求结果仍写入日志（rounds 增加）、有「已停止」、按钮恢复可用、状态「未启动」 | ✅ |
| 预览不写 | 预览/连点期间 fake 写调用为 0 | ✅ |
| 模块/下拉/配置持久化 | 改二课关键词、清空俱乐部关键词+开 allowAll、重开程序后配置与模块开关保留 | ✅ |
| 重开恢复 | 启动中 reload→自动恢复运行（开关 on）；停止后 reload→保持「未启动」 | ✅ |
| 可读性 | 面板宽 480px；label 宽 130px/单行横向（未挤成三列）；滚动到底可见二维码延迟/重试/最多尝试次数 | ✅ |
| 窄屏 | 420px 视口下面板 406px 完整落在视口内（CSS 媒体查询为 `100vw-16px`） | ✅ |
| 脱敏/网络/异常 | 状态页仅 `138****0000` 脱敏；页面不含完整手机号/密码/token；external requests = 0；pageerror = 0；console.error = 0 | ✅ |

> 说明：曾检出并复验修复的 critical —— 取消预览只改 `state.dryRun` 而未同步 `engine.setConfig({dryRun:false})`，会导致「UI 显示真实、引擎仍按 preview 假成功」。cli-dev 修复后本 smoke 以「真实执行 fake 写调用 >0」硬断言守住该回归。

## 5. 截图（artifacts/，只保留关键近景，其余断言见 result JSON）

| 文件 | 内容 |
|---|---|
| `desktop-smoke-01-initial.png` | 首次打开：三模块未勾选、账号/校区占位、预览勾选、480 宽 label 可读 |
| `desktop-smoke-04-real-run-fake.png` | 真实执行（fake 写调用发生、状态「运行中（真实提交）」） |
| `desktop-smoke-07-qr-params.png` | 滚动到底：二维码延迟/重试间隔/最多尝试次数 |
| `desktop-smoke-11-state-masked.png` | 状态页账号脱敏（无完整手机号/密码） |
| `packaged-smoke-01-initial.png` / `packaged-smoke-04-real-run-fake.png` | 打包副本模式（旧 asar 快照）下同一套页面 |

> 为避免重复大文件，阻断矩阵/窄屏/重开恢复等场景只保留断言记录（`artifacts/desktop-smoke-result*.json`），不重复存图。

## 6. scheduler 验证（my task-2 收尾）

### 6.1 CAS 竞态修复（lead 审查发现）

- `_write_terminal`：改为 **CAS**（`WHERE run_key=? AND status=? AND claim_token=?`），stale lease 的 in-flight 不再可能覆盖其它进程已 finalize 的 `success`；CAS 失败回读最新状态（`_result_from_row`），绝不覆盖。
- `_record_window_expired` / `_record_dependency_gate`：写入后检查 `rowcount`，未命中即回读最新状态返回，不覆盖别进程结果。
- `handler` 异常不再把异常原文（可能含 payload/token）落盘，统一固定文案「handler 异常（结果未知，请核查）」。
- 新增 3 个竞态模拟测试（stale in-flight → success、dependency gate、窗口过期）验证 CAS 保护。

### 6.2 结果

```text
python -m unittest tests.test_scheduler -v   → Ran 45 tests ... OK
python -m unittest discover -s tests         → Ran 164 tests ... OK
python -m unittest discover -s reverse -p "test_*.py" → Ran 7 tests ... OK
node --test desktop/test-automation.cjs（engine，作者范围 freeze 版）→ tests 51 / pass 51 / fail 0
```

### 6.3 变异测试（mutation，验证测试有效性）

在**干净 copy**（临时目录，非共享文件）上：

1. 复制 `auto3ct/`、`tests/` 到临时目录；
2. 变异 `scheduler.py`：`if not task.enabled: continue` → `if task.enabled: continue`（反转 disabled gate）；
3. `python -m unittest tests.test_scheduler.RunDueTests.test_disabled_task_is_skipped -v` → **FAILED (failures=1)**（测试成功捕获变异）；
4. 还原原文件后同命令 → **OK**；临时目录已删除。原工作区文件未被变异影响。

## 7. engine 交叉审查（只读，已发作者 + lead）

未改作者文件。已反馈的问题按优先级（部分已由作者修复）：

- **P0 并发**：`running` 只防同实例；多窗口/重载残留共享 localStorage 各自 read-modify-write 可能互相覆盖并双提交 → 建议 `navigator.locks` 或 owner+lease CAS。inflight 残留需要 UI 的「人工核查/标记处理」入口。
- **P0 fail-closed**：`storage.get` 包装若 catch 返回 null，会把「读取失败」误当首次运行 → 应直接 `localStorage.getItem` 抛错（引擎已按此方向 fail-closed）。
- **P1 真实字段**：`ekApplyState` 以任意非空 `ApplyInfo` 判 applied 需实测确认（mock 无条件带）；俱乐部 myTask 过滤建议用 `activityStatus`（optionStatus 口径不同，已确认 myTask 优先同 id 的列表时间来源）；列表分页只取第一页；账号读取只按 id（phone 可空）；俱乐部窗口已由 lead 确认以 startTime/endTime 为准（不做改动）。
- **P2 轮询/配额**：每 tick 对列表每个活动拉详情偏高频 → 建议关键词/状态收敛后拉详情并当日缓存；`done` 后仍会拉 QR（应入口短路）；`qrChecks/daily` 键只增不删需按日修剪。
- 已反馈的其它点：`decodeQr` 图片加载无超时/像素上限（会永久挂起 run）；inflight 阶段提交前需复检时间窗；结果 reason 建议固定文案而非异常原文。

## 8. 打包副本载入（最终包，已通过）

- 最终包 `3CT-Auto/resources/app.asar` sha256 `d2e3b3eb…`（55,730,028B，确定性 rebuild 结果一致）。
- byte check：`python desktop/install.py verify` → entries=352 / unchanged_verified=345 / integrity_verified=352 / patched_files=7，退出码 0；原 3CT 包 sha256 未变。
- 解包对拍（`reverse/asar_extract.py --only "dist/renderer/" --only "dist/main/auto-bootstrap.cjs" --only "package.json"`）：
  - `automation.js` 70,306B / `panel.js` 42,867B / `panel.css` 8,269B / `jsQR.js` 266,988B / `auto-bootstrap.cjs` 2,039B，均与 `desktop/` 源**字节一致**（SHA256 相同，打包脚本内 `打包副本脚本与 desktop 冻结源文件字节一致` 断言通过）；
  - `index.html` 含 `./jsQR.js`、`./automation.js`、`./panel.js`、`./panel.css` 与 `<title>3CT Auto</title>`；
  - `package.json` main=`./dist/main/auto-bootstrap.cjs`、name=`3CT`、version=`1.2.5`。
- `SMOKE_SOURCE=packaged` 模式（静态 server 映射到解包 renderer，同一 fake ctAPI harness）**55/55 通过**，结果：`artifacts/desktop-smoke-result-packaged.json`（source=packaged, failed=0, externalRequests=[]，含字节一致断言）。
- 说明：加载的是“打包副本里的脚本 + fake ctAPI harness”，不是启动真实 Electron；真实 exe 运行按 lead 安排由 cli-dev 初版验证。

### 8.1 复跑命令（包若再变）

```powershell
Remove-Item -Recurse -Force artifacts\patched-renderer
& 'C:\Users\兑\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe' reverse\asar_extract.py `
    --archive 3CT-Auto\resources\app.asar --out artifacts\patched-renderer --only "dist/renderer/"
$env:SMOKE_SOURCE='packaged'; & 'C:\Program Files\nodejs\node.exe' tests\desktop-smoke.cjs; Remove-Item Env:SMOKE_SOURCE
Get-FileHash '3CT-Auto\resources\app.asar','desktop\automation.js','desktop\panel.js','desktop\panel.css' -Algorithm SHA256
```

## 9. 已知限制 / 后续建议

1. **真实 Electron**：本任务未启动真实 exe；按 lead 安排由 cli-dev 初版验证。若后续运行需 `--user-data-dir` 临时 profile，避免单实例锁与原 userData。
2. **跨窗口单飞**：建议作者用渲染层 `navigator.locks` 补强（当前 smoke 只覆盖单页面 busy 防重）。
3. 截图只保留关键近景（6 张）；其余场景以 `artifacts/desktop-smoke-result*.json` 断言为准。
4. 说明：本报告结论对应上面表格列出的最终 hash；若日后任何冻结脚本/包再变，需按 §8.1 复跑并更新 hash。
