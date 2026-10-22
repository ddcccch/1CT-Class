# 3CT AutoPanel 使用与限制说明

> 适用对象：`desktop/automation.js`（业务引擎）+ `desktop/panel.js` / `panel.css`（控制面板）。
> 运行位置：3CT 升级副本的**渲染层**（由 installer 写入 `dist/renderer/`，在 `index.html` 里按
> `renderer.js → jsQR.js → automation.js → panel.js` 顺序以 `defer` 加载）。
> 引擎通过 3CT 既有 `window.ctAPI` 复用**应用内已登录会话**；不新建登录、不导出凭证。

---

## 1. 快速开始

1. 用 installer 生成独立副本（不改原 3CT）。
2. 启动副本 → 右下角出现 **AutoPanel**。
3. 首次打开：**默认关闭、默认预览（dry-run）**，三个业务模块默认都不启用。
4. 按需勾选模块（校园跑 / 俱乐部 / 二课），填写关键词与参数。
5. 先点「预览」看一轮计划（不产生任何写请求），确认无误后取消「预览」勾选，再点开关启动。
6. 启动状态会持久化：下次打开副本若上次为启用状态会自动恢复；首次不会自动开。

---

## 2. 能自动完成什么（已在引擎中实现并有测试覆盖）

| 模块 | 自动化能力 | 成功判定 |
|---|---|---|
| 校园跑 | 到点（`unirun.runAt` + 有效窗口）调用 `unirun.autoRun` 上报一次；当天去重 | 严格 `code === 10000` |
| 俱乐部·报名 | 按关键词从当日活动列表中挑 `optionStatus=6`（可报名）的活动报名，受**每日上限**约束（跨 tick 累计） | `code` 为 `10000` 或 `1000` |
| 俱乐部·签到 | 窗口 `[活动开始, 开始+club.signInWindowMinutes（默认 15）]`；坐标只取 `currentSignTask` 下发的同活动签到点，默认不回退活动列表坐标（`club.allowActivityCoords` 可开）；失败按 2 分钟/3 次重试 | 同上 |
| 俱乐部·签退 | 窗口 `[活动结束-club.signOutWindowMinutes（默认 15）, 结束]`；要求官方 `signInStatus=1` 已签到（或本地签到成功）；失败按 2 分钟/3 次重试 | 同上 |
| 二课·报名 | 关键词命中 + `ActivityStatus=0` + **`StuETime` 报名窗口内**；每日上限 | `errcode === 0` |
| 二课·签到/签退 | 仅 `SignWay=1`（扫码）；窗口取 `ActivityQDDate`/`ActivityQTDate`；二维码来自**本活动 boundImages**，本地 jsQR 解码 | `errcode === 0` 且响应文本不含「无法/无需」 |
| 二课·跨轮跟踪 | 报名成功或官方已报名的活动写入 `watchedEk`（**持久化**），之后每轮直接拉该活动详情，即使它已不在列表前几页 | — |

### 关键行为细节

- **二维码延迟 + 有限重试**：官方窗口开始后延迟 `ek.qrDelayMinutes`（默认 2 分钟）才首次拉
  boundImages；空/未识别后按 `ek.qrRetryMinutes`（默认 2 分钟）重试，每阶段每天最多
  `ek.qrMaxAttempts`（默认 3）次。**不会每 tick 无脑轮询图库**。
- **阶段判定**：优先看 `bind.remark`（含「签到/签退」），其次看码后缀 `QD`/`QT`；
  **任何元数据与后缀冲突的候选一律拒绝**；`lbUUh` 开头且无元数据/无后缀的 opaque 码，
  只有在上传时间落在**本阶段窗口内**时才接受；同一张图已用于签到后，不会用于签退。
- **每日去重**：`日期|账号|模块|活动|动作`。成功落 `done`，失败落 `failed`、结果未知落 `unknown`
  并**当日锁定不盲重试**；提交前先持久化 `inflight`，写盘失败则**不提交**（fail-closed）。
- **单飞**：重复点击 / 并发 `runOnce` 只跑一个，另一个返回 busy。
- **时间口径**：全部按**北京时间**解析，与本机时区无关。
- **安全**：结果、日志、导出均不含 token / 密码 / 完整手机号；账号只显示 ID 与备注。

---

## 3. 明确**未支持**的能力（不会静默假装成功）

以下情形引擎会明确给出 `waiting-material` / `skipped` / `expired` 等状态，**不会记为成功**：

1. **二课会话过期不自动重登**。3CT 的 token 过期后需要用户在二课页面重新登录/刷新；
   引擎当前不做自动 refresh（避免引入额外的凭证处理）。日志会提示会话不可用。
2. **二课非扫码签到方式**：`SignWay=2`（拍照）、`3`（拍照+定位）、`4`（验证码）
   以及缺照片、缺验证码、需定位拍照的场景，**必须人工完成**。
3. **二维码识别失败 / 图库中没有本活动的新码**：等待下一轮或人工确认码；不会用旧图凑。
4. **活动时间缺失**：`StuETime` / `ActivityQDDate` / `ActivityQTDate` 解析不出，或只有单值
   没有截止时间时，**不自动提交**（宁可等待）。
5. **验证码、滑块、短信等风控交互**：完全不处理。
6. **自动取消报名**、批量代报名他人账号：不做。
7. **签名/加密逆向之外的私有协议**：本工具只调用 3CT 已经在用的同一批 `ctAPI`。
8. **多窗口并发**：引擎自身有单飞锁；若打开多个副本窗口，仍可能各自 tick（不保证跨进程互斥）。
9. **俱乐部窗口**是否被上游接受：`[开始, 开始+15min]` / `[结束-15min, 结束]` 是可配置的默认口径（`club.signInWindowMinutes` / `club.signOutWindowMinutes`），
   上游若在窗口外才开放签到，会先被拒绝、再按 2 分钟/3 次重试，用尽才记为 failed（不会锁死当天）。

---

## 4. 参数说明（面板 / 配置文件）

| 配置项 | 默认 | 说明 |
|---|---|---|
| `dryRun` | `true` | 预览模式：只产出计划行，不发写请求 |
| `unirun.enabled` | `false` | 模块开关（三个模块首次都关） |
| `unirun.runAt` | `06:30` | 每日执行时刻（北京时间） |
| `unirun.windowMinutes` | `30` | 到点后允许执行的时间窗 |
| `unirun.runDistance` / `runTime` | `3000` / `30` | 里程（米）/ 时长（分钟），有合法区间校验 |
| `campusId` | 空 | 校区 ID；显式配置但不存在时明确等待，**不回落首项** |
| `club.enabled` / `ek.enabled` | `false` | 模块开关 |
| `club.keywords` / `ek.keywords` | `[]` | 关键词；为空时需打开 `allowAll` 才会处理（仍受每日上限约束） |
| `club.dailyJoinLimit` | `1` | 俱乐部每日成功报名上限（跨轮累计） |
| `ek.dailyLimit` | `1` | 二课每日成功报名上限 |
| `ek.qrDelayMinutes` | `2` | 二维码首次拉取延迟 |
| `ek.qrRetryMinutes` | `2` | 二维码重试间隔 |
| `ek.qrMaxAttempts` | `3` | 每阶段每天最多拉图库次数 |
| `tickMs` / `windowTickMs` | `60000` / `20000` | 常规 / 窗口内轮询间隔（毫秒，面板按秒展示，≥15s） |

持久化位置（localStorage，均在副本自己的渲染层存储中）：

- `auto3ct:config` — 引擎配置
- `auto3ct:state` — 去重状态：`done` / `inflight` / `failed` / `daily` / `qrChecks` / `usedImages` / `watchedEk`
- `auto3ct:panel` — 面板开关与间隔
- `auto3ct:ui` — 面板 UI 状态（折叠、当前 Tab）

> `auto3ct:state` 损坏时引擎会明确报「状态损坏」并**禁止自动写**；面板提供「查看状态 / 重置状态」。
> 重置会清空当日去重记录，可能导致重复提交，需谨慎。

---

## 5. 结果状态含义

| status | 含义 | 是否会重试 |
|---|---|---|
| `success` | 上游明确成功 | 当日不再重复 |
| `failed` | 上游业务拒绝 | **当日锁定**，需人工核查 |
| `unknown` | 请求异常/响应不可解析，结果未知 | **当日锁定**，不盲重试 |
| `waiting-material` | 缺二维码/缺时间/缺坐标/缺签到方式等 | 下一轮（受 QR 次数与间隔约束） |
| `not-yet` | 未到时间窗/未到二维码 gate | 下一轮 |
| `expired` | 时间窗已过 | 不再尝试 |
| `skipped` | 已完成 / 已停止 / 受上限约束 | 视原因 |
| `blocked` | 并发 busy / 状态损坏 / 存储写失败 / 上次结果未知 | 需人工核查或下一日 |
| `dry-run` | 预览计划行，未真实提交 | 不适用 |

---

## 6. 测试与验证

```powershell
# 语法
<node> --check desktop/automation.js
<node> --check desktop/test-automation.cjs

# 全量单测（离线，不触网）
<node> --test desktop/test-automation.cjs
```

当前覆盖 **49 个用例**，包含：北京时间解析、二维码合法性/阶段冲突、fail-closed 去重、
failed/unknown 终态锁定、并发单飞、每日上限跨轮累计、token/密码不外泄、watchedEk 跨进程
重启后仍跟踪列表移页活动、StuETime 报名窗口、校区缺失不回退、解码越过截止不提交等。

---

## 7. 隐私与风险声明

- 引擎只在**用户自己开启**且**用户自己账号**下操作；账号密码从 3CT 本地账号存储读取用于调用
  既有 IPC（与 3CT 自身行为一致），**不导出、不打印、不写入结果/日志**。
- 默认预览，任何真实提交都需要用户显式关闭预览。
- 虚拟定位/代跑/自动签到可能违反学校或平台规定，是否使用及后果由用户自行判断与承担。
