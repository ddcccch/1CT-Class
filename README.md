# 1CT：二课 / 校园跑 / 俱乐部自动化（多成员）

1CT 是本机 **3CT 1.2.5** 的独立增强副本：复用原程序的 Electron 资源与 `window.ctAPI`，
生成一个可以替多个成员刷二课 / 校园跑 / 俱乐部的桌面程序。安装来源 `3CT/` **只读**，
构建前后 SHA-256 必须一致；原程序的登录态、图标、`app.asar` 一个字节都不改。

仓库只维护 **1CT 一条链**：早期那条 3CT-Auto（AutoPanel + 看板 + Python 调度）的代码、
文档与测试已整体移除，构建脚本、打包脚本、测试全部指向 1CT。

## 交付入口

| 入口 | 说明 |
|---|---|
| `启动1CT.exe`（仓库根，构建产物，不随仓库分发） | WinExe，双击无控制台窗口，带 1CT 图标；启动 `1CT\1CT.exe` |
| `1CT\1CT.exe` | Electron 本体（由源 `3CT.exe` 改名 + rcedit 换图标）；**不要**直接双击 |
| `1CT\start-1ct.cmd` | 纯 ASCII 兜底入口，仅在 GUI 启动器出问题时排错用 |
| `1CT\README-1CT.txt`、`VERSION-1CT.txt` | 副本内使用说明与版本/哈希信息 |

**1CT 与原版 3CT 完全独立**：1CT 用 `%APPDATA%\1CT` 自己的用户数据目录与独立单实例锁，
因此两者**可以同时运行**（代价是首次启动要在 1CT 里重新登录）。需要回退到共用
`%APPDATA%\3CT` 时加 `--shared-user-data` 或设 `CT_SHARE_USER_DATA=1`。

窗口按钮齐全（最小化 / 最大化 / 退至后台），托盘有提示与退出菜单，图标全部是 1CT 自己的。

## 功能（1.2.3）

- **多成员**：一台电脑上多人共用一份程序，各自账号、各自二课/校园跑/俱乐部参数、
  各自执行历史；成员可单独指定校区，也可跟随全局默认。
- **二课登录**：优先「微信扫码登录」（学校自 2026-04 起，校园网外只允许扫码），
  校内网仍可用学号 + 密码；失败时直接显示学校返回的原因，不再统一显示「登录失败」。
- **二课八模块缺口**：自动从学校官方接口同步当前积分与最低要求，逐模块算缺口；
  已达标模块停止新增报名，已报名活动继续签到/签退。支持「刷新分数」与截图初值手工参考。
- **二课报名/完成状态**：直连官网 `GetStuAllActApplyList`（1CT 新增的主进程桥
  `ek:getStuAllActApplyList` + preload 同名方法），回显 `SignD`（已签到）/ `SignT`（已签退），
  自动分页；每个已报名活动展示官方签到/签退**时段**（两行完整显示），并列出最近
  **6 条**官方签到/签退成功记录。
- **二课签到**：优先用志愿者图库里的有效二维码；没有可用二维码时默认走官方
  `StuSaveSignIn` 无码直签兜底（`SignWay=1`、空照片/定位，不需要二维码）。会话过期自动重登。
- **校园跑**：每日执行时刻默认 **19:00**（运行页可改），窗口与里程每天自动随机；
  校区库原先为空（独立 userData 不继承 3CT 的 `unirun\localdb.v1.json`），
  现在可「从云端获取校区列表」→ 选校区 →「下载并保存」地图。
  官方要求 4~10 km/h，里程/时长组合越界会被拦成 `waiting-material / pace-out-of-range`
  并给出建议值，**不会偷偷改用户填的数**；界面提供「恢复自动合法参数」。
- **俱乐部**：按关键词筛当天活动，在每日报名上限内自动报名，再于活动时间窗内签到、签退
  （签到窗口默认 15 分钟）；坐标只用学校下发的签到点，拿不到时显示
  `waiting-material / need-coords` 而不是拿活动地点硬签。签到/完成证据按
  **「完整活动名称（含校区）+ 完整日期 + 开始时刻 + 结束时刻」四元组**匹配官方记录。
- **失败处理**：签到被拒会**有界重试**（默认 2 分钟一次、最多 3 次）；结果不确定
  （超时/断网）立即锁定以防重复提交；失败原因进日志与记录，可「清除今日失败锁定」后重试。
- **首次启动引导 + 按版本只弹一次的更新公告**；执行记录可筛选、可 CSV 导出。

## 构建与分发

```powershell
# 生成 / 覆盖重建 1CT\ 并编译 启动1CT.exe（Windows 自带 .NET Framework csc 即可，无需 npm）
python desktop\install_1ct.py build --force

# 只刷新启动器（换了图标或改了提示文案时）
python desktop\build_gui_launcher.py

# 校验成品：注入清单 / 哈希 / 图标 / 启动器 / 原包未被改动
python desktop\install_1ct.py verify --require-launcher

# 增量重打包（只替换变化条目，不重打整包）
python desktop\repack_1ct_incremental.py --help

# 给别人的单文件升级器（自带新版 app.asar；payload 的 sha256 与实际字节不一致直接拒绝）
python desktop\build_updater_1ct.py --source dist\1CT-1.2.3\1CT --out dist\1CT升级包-1.2.3 --force --version-line "1CT 1.2.3 校园跑校区/节奏修复 · 2026-10-31"
```

`--source` / `--out` 必须显式写：默认 `--source 1CT` 指向本机现装的旧 `app.asar`，
不写就会把旧包重新打成新版本号发出去。打包细节见 [打包说明](desktop/1ct/packaging.md)，
分发与升级步骤见 [1CT 分发与升级指南](docs/1ct-update-guide.md)。

## 目录

| 路径 | 作用 |
|---|---|
| `desktop/1ct/` | 1CT 渲染层：`index.html`、`shell.js`（界面）、`members.js`（成员/扫码/成绩同步）、`ek-stats.js`（二课统计）、`bootstrap-1ct.cjs`（独立 userData + 禁更新 + IPC 桥）、`assets/`（图标与 rcedit） |
| `desktop/automation.js` | 业务引擎（三模块调度、窗口判断、重试与锁定、结果落盘）；渲染层与测试共同使用 |
| `desktop/score-policy.js` | 八模块缺口策略 |
| `desktop/result-store.js` | 执行记录存储（2000 条 / 90 天上限，按账号组隔离） |
| `desktop/asar_lib.py` | ASAR 读写与校验原语（中性库） |
| `desktop/install_1ct.py` | 1CT 安装 / 打包 / 校验主脚本 |
| `desktop/repack_1ct_incremental.py` | 增量重打包 |
| `desktop/build_updater_1ct.py`、`desktop/Updater1CT.cs` | 单文件升级器 |
| `desktop/build_gui_launcher.py`、`desktop/GuiLauncher1CT.cs` | C# WinExe 图形启动器 |
| `tests/` | 打包链、升级器、增量重打包的 Python 测试 + 打包后冒烟 |
| `docs/` | 使用说明、升级指南、设计契约、俱乐部/校园跑已确证事实 |

## 测试

本仓库当前实测（2026-11-11，本次清理后）：

| 套件 | 命令 | 结果 |
|---|---|---|
| 打包链 / 升级器 / 增量重打包 | `python -m unittest discover -s tests` | 150 passed / 0 failed（6 skipped：需要本机 `3CT/resources/app.asar` 或 Windows 专属工具） |
| 业务引擎 | `node --test desktop\test-automation.cjs` | 163 passed / 0 failed |
| 1CT 界面 | `node desktop\test-1ct-shell.cjs` | 426 passed / 0 failed（浏览器真实断言，零外部网络请求） |
| 成员 / 扫码 / 成绩同步 | `node --test desktop\test-1ct-members.cjs` | 118 passed |
| 二课统计 | `node --test desktop\test-1ct-stats.cjs` | 46 passed |
| 执行记录存储 | `node --test desktop\test-result-store.cjs` | 35 passed |
| 积分策略 | `node --test desktop\test-score-policy.cjs` | 30 passed |
| 报名诊断 | `node --test desktop\test-enrollment-diagnostics.cjs` | 21 passed |
| 迁移冒烟 | `node tests\1ct-migration-smoke.cjs` | 13 passed |
| 打包后 renderer 冒烟 | `node tests\packaged-1ct-renderer.cjs` | 41 passed / 0 failed（Edge headless 打开 asar 内渲染层） |
| 打包后真实 Electron 冒烟 | `node tests\packaged-1ct-smoke.cjs` | 32 passed / 0 failed（临时 profile + CDP，不碰用户数据） |

界面与打包冒烟的证据（截图、结果 JSON）只写在本机 `artifacts/`，不随仓库分发。

## 已知边界

- **有效二维码依赖上传者**；但本版不再强依赖：没有可用二维码时走官方无码直签兜底
  （可用 `ek.noQrFallback=false` 关闭）。二课拍照、定位＋拍照及验证码签到仍未必具备
  自动提交所需材料，界面不会把「需人工」显示成已完成。
- **俱乐部链路仍未在真实活动窗口内完成端到端验收**：活动条目日期字段是 `mmdd` /
  `nextMmdd`（没有 `yymmdd`），四元组匹配与「上游没下发签到点」的处理有离线与只读实测，
  但真实活动当天的签到/签退没有跑过一遍完整闭环。
- **上游可能变化**：学校或平台改字段、改时间窗、改登录要求时，需重新核对文案与锚点；
  构建脚本对这种漂移是**硬失败**（宁可不出包，也不产出错包）。
- **离线测试通过不等同于真实平台已接受操作**：提交结果未知时立即停止自动重投，
  先到原平台核查，避免重复报名或打卡。
- **必须应用常驻 + 电脑唤醒**才会执行；睡眠/关机/程序完全退出时不会补跑，
  不宣称后台云运行。
- 使用须符合学校和平台规定；账号由程序内部正常使用，不导出、不打印密码或 token。

## 文档

- [1CT 使用说明](docs/1ct-usage.md)：安装、登录、成员、三模块日常操作与排错
- [1CT 分发与升级指南](docs/1ct-update-guide.md)：便携版分发、覆盖升级、回滚
- [1CT 重构契约](docs/1ct-redesign-contract.md)：设计口径与实现边界（冻结文档）
- [打包说明](desktop/1ct/packaging.md)：注入清单、verify 断言、图标与 AUMID
- [俱乐部与校园跑已确证事实](docs/club-campus-sign-diagnosis.md)：只记录可指认的证据与验证边界
