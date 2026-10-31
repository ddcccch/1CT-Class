# Lead 集成审查记录

## 审查范围

- 离线 ASAR/source map 提取与分析。
- 纯本地 Python 配置、CLI、SQLite 调度核心。
- Electron 自动化业务引擎、统一面板、独立副本打包。

## 必须解决的正确性问题

| 问题 | 原因与验收要求 |
|---|---|
| 测试夹具与真实数据不一致 | 账号必须使用真实的 ct_unirun_accounts_v1 结构，校区来自 campusLocalList，不能为方便测试创建虚构键。 |
| 前置持久化失败仍提交 | 写入 inflight 失败必须禁止业务写；状态损坏不得当作首次运行。 |
| 每轮重复提交失败操作 | 业务拒绝和结果未知应有持久终态，不能下一轮自动重投。 |
| 每日报名上限只在内存累加 | 上限按日期、账号、业务模块跨 tick 累计，重启后仍生效。 |
| 阶段二维码混用 | 本活动绑定图、签到/签退阶段、已使用图和上传时间共同约束；明确阶段冲突必须拒绝。 |
| 图库每 tick 拉取 | 官方窗口开始后延迟触发，再按有限次数、固定间隔重试；成功或终态不继续查图。 |
| 预览消耗真实二维码预算 | 多次预览不得写入真实 qrChecks 或耗尽真实运行的重试次数；需连续预览后真实模式仍可提交的回归。 |
| 签退前置条件读错 | 二课签退判断官方 SignD 而非 SignT，俱乐部判断官方 signInStatus 或本地签到成功；无需签到的活动不得错误阻断签退。 |
| UI 停止后继续提交 | 停止要阻止后续写操作；已经发出的请求仍须记录结果，不能假装取消。 |
| 数据读取耗时跨越截止 | 真正提交前重新检查当前窗口，不能仅在读详情前判断时间。 |
| 静态发现被说成真实平台保证 | 静态代码、fake API 测试与真实业务验证分别披露，不能以单测替代平台验证。 |

## 独立副本要求

- 原始 ASAR 的 SHA-256 保持不变，全部未修改资源逐字节一致。
- 不复制登录资料到新文件，不导出密码或 token。
- 原版正在运行时仅提示退出，不强制结束用户进程。
- 打包输入缺失时不能先清除旧副本；强制重建必须校验来源标记。
- 更新 ASAR 偏移、大小、文件级完整性；实际启动仍需单独验证。
- 升级副本禁用自动下载安装，后台节流关闭，但关机与睡眠不能执行。

## 验收口径

Python 与 Node 离线测试证明状态与调用约束；浏览器 smoke 验证用户可操作面板；独立 Electron 启动验证包结构与加载。真实报名、跑步上报或签到签退是否被平台接受，只有实际业务返回与官方记录才能证明。本次不在用户现有会话上自动提交真实业务来充当测试。

具体测试数量与截图以最终测试报告为准；本文件是审查清单，不把未完成检查写成通过。

---

## 2026-10-31 本轮审查（1CT 1.2.3：校园跑从未成功 / 俱乐部签到签退从未成功）

上节「本次不在用户现有会话上自动提交真实业务来充当测试」是当时的纪律记录；本轮用户另行明确授权了一次真实校园跑对照（由 campus/version 执行，本人只读评估），两处不冲突。

### 审查范围

- `desktop/automation.js`：club 时间/日期归一、记录四元组证据、pace 契约、`redactText`、`perform` 终态锁。
- `desktop/1ct/shell.js`：校区入口（localList/cloudList/cloudPull/保存）、迁移与 `dryRun` 落盘、参数恢复入口、失败页白名单。
- `desktop/1ct/members.js`：`effectiveConfig`/`clearFailedLocks`/`unirunAccountsPayload` 合成账号。
- `desktop/repack_1ct_incremental.py`、`desktop/Updater1CT.cs`：五轴（正确性/边界/错误路径/可测性/可回滚）。
- 未审：与本轮无关的 CLI/调度旧模块。

### 已跑测试（2026-10-31，本机离线）

| 命令 | 结果 |
|---|---|
| `node --test desktop/test-automation.cjs` | 146 pass / 0 fail（B1 修复后复跑） |
| `node desktop/test-1ct-shell.cjs` | 426 pass / 0 fail（自定义 harness；用 `node --test` 跑会把整文件记成 1 fail，是误报） |
| `node --test desktop/test-1ct-members.cjs` | 118 pass / 0 fail |
| `python -m pytest tests` | 331 pass / 2 fail / 9 skip；两处失败均在 `tests/test_gui_launcher.py`（启动器构建），与本轮改动无关，未定性 |

独立副本 mutation（临时目录里的独立副本，基线 144，当时用例数）：去掉日历回读校验 → RED 5；允许非零小数秒 → RED 5；歧义记录取首条 → RED 3；去掉记录日期比对 → RED 9；`signStatus=0` 视为已签到 → RED 5；缺日期猜今天 → RED 5。**日期与记录四元组条件被真实守护，不能放宽。**

### 真实一次对照（campus/version 执行，本人只读评估）

- 旧 1.2.2 空库：`no-campus`，0 POST。
- 隔离 profile 只补航空港地图：该次 `autoRun` 返回 `code 10000`。
- 但同一场次的 `runRecords`：`runStatus=9`、`validDistance/validTime` 为空、`speed=0`；历史有效记录为 `runStatus=1` 且字段完整。
- 结论：**`code 10000` 不能作为「跑成功」的证据**；配速也不得断言为唯一原因（记录里没有文字 reason）。

### 阻塞项：无（B1 已修复并复验）

**B1 脱敏漏值（曾阻塞，已修）** — 原实现实测 `{"Authorization":"Bearer eyJ.a b"}` → `{"authorization=*** b"}`，尾部片段 ` b` 泄漏。根因：`Authorization+Bearer` 规则先跑并吃掉**前引号**，使「带引号值」规则无法配对（只保留前引号、再由 `["']?` 吃掉后引号同样无效）。
作者修法：把「带引号值」规则前移到所有 Bearer 规则之前（`automation.js` `redactText` 现规则 2）。
复验（当前工作区，独立临时脚本，退出码 0）：`{"Authorization":"Bearer eyJ.a b"}`、双尾 `…b c`、等号形式、冒号后空格、`{"password":"p a s s"}`、`{"JSESSIONID":"XY Z789"}`、单引号 `password='p a s s'`、`{"secret":"s3 c r3t"}` 全部收敛为 `***`，无残留片段；`node --test desktop/test-automation.cjs` 146/146 全绿。
其余此前报告过的 12 类泄漏（带空格/逗号/花括号/单引号值、`Bearer`、Windows 与 POSIX 含空格用户名路径、栈截断）实测均已修好；诊断语义保留（`ENOENT` + 文件名、手机号、中文错误文案、`a/b c/d` 不误伤）。

### 非阻塞建议

- 裸 `key=value` 会额外吞掉 3 个 token，损失诊断文字（`token=abc invalid_grant 会话已过期` → `invalid_grant` 消失；`password=abc ECONNREFUSED 127.0.0.1:443` → 只剩 `:443`）。`reason` 码用原文分类，不受影响。
- 上游已把文本截断成「无尾引号」时仍可能留短尾：`{"password":"a b` → `{"password=*** b`（裸值规则只吞 ≥3 字符的后续 token）。低优先；若要收，放宽到 `{1,3}` 会把 `ok`/`no` 这类短英文词一并吞掉，需权衡。
- 显式 pace 拦截 + 卡片「恢复自动合法参数」按最终裁决保留；迁移只清旧默认 3000/30，不清存量 1100/35，用户依赖该按钮（已验证：清成 null、写盘失败有中文错误提示）。建议在失败页把「手填值仍在生效」说得更直白。
- 俱乐部记录歧义 `hits.length !== 1` 一律不授权（fail-closed，已裁决保留）。
- `locked-unknown` 当天不再重试（防重复提交，合理），建议失败页用中文说明。
- 失败页 waiting 白名单已含 `no-campus` / `no-unirun-account` / `need-sign-in-first`。

### 未验证 / 未知（不写成通过）

- 俱乐部窗口内 `getSignInTf` 的真实形态；`currentSignTask.activityId` 与 `myActivityList.clubActivityId` 是否同一 id 空间（窗口外全为 null）→ 坐标 `sign-task` 分支未在真实数据上验证。
- 俱乐部签到/签退的真实上游接受性：本轮没有窗口内真实提交。
- 运行时刻早于配置 `runAt`（10:46:28 成功 vs effective 10:48）：代码上 `minute < startMin` 必为 `not-yet`，且 `minute` 在 plan 开始即取值，长轮次只会更严格 → 只可能是当时生效配置 ≤10:46；写入顺序/历史值无法回溯，标为未知，不扩修。
- `tests/test_gui_launcher.py` 两个失败未定性。

### 结论

代码侧无阻塞：B1 已修复并复验（独立临时校验脚本退出码 0、146/146 全绿），其余为建议级。真实平台接受性仍以官方记录（`runStatus` / `signStatus`）为准，不以 `code 10000` 或单测替代；俱乐部窗口内签到/签退仍未在真实数据上验证。
