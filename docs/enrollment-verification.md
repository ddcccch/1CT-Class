# 二课「可报名活动发现」离线验收（enrollment QA）

> 范围：仅验证**报名候选发现 / 状态识别 / 积分筛选 / 诊断可见性 / 离线假数据**；不涉及也不修改定位、出勤、签到签退伪造逻辑；**不真实报名、不调用真实平台、不读写用户 userData/profile、不连真实 CDP**。
> 结论：source **40/0**；最终包（当前已 build 的 `app.asar 7CD499C9…`）**packaged 41/0**（含脚本字节一致断言）。用户真实根因仍缺原始响应，需其提供页面「可报名」与列表原始响应再定；本次仅离线复现并修复两个可复现 bug。

## 1. 背景（用户真实日志，只读，不入库）

用户日志 `docs/auto3ct-log-*.txt`（**被忽略，不提交**）显示：14:38:59 已切换真实执行，后续约6个活动反复出现 `signIn/signOut → not-yet(before-window)`，**没有任何 apply**，而用户页面截图存在「可报名 + 思想政治 1/1」活动。日志没有包含这些活动的列表状态，不能断言它们真实为status=1或已报名；下面的status=1分布是用于复现的模拟夹具。可离线复现的两个 bug：
1. 旧引擎只扫**未过滤**列表（前几页只有已报名），可报名候选（官方 `activityStatus='0'`）根本未进入候选池；
2. `ApplyInfo:{}` / 详情空 Id / 全零 GUID 模板会被误判为「已报名」，导致可报名活动被跳过。

## 2. 验收方法（fake ctAPI + 临时 profile，禁外网）

- fake 场景严格复现日志：未过滤前 3 页只有 6 个 `Status=1`；`activityStatus='0'` 分页里放 4 个候选：
  - **A**：报名窗 `StuETime` 已开、签到窗在未来 → 应报名成功、签到不提交；
  - **B**：列表 `ApplyInfo:{}` + 详情 `Id=''`/全零模板 → 必须仍可报名（回归 bug 2）；
  - **C（strict）**：`Status=0` 但**缺真实报名窗**（无 StuETime）→ 必须 `missing-apply-window` + `decision=unknown` + **绝不提交**（不放松；活动时间/签到时间不能当报名窗）；
  - **D**：报名窗在未来 → `not-yet(before-apply-window)` 不提交但候选保留。
- `status=1` 补充：已报名活动不重复 apply，其签到窗口开时 watch 继续签到（回归对照，fake，不代表真实平台行为）。
- 真实引擎代码 + 浏览器（Edge/Playwright-core）+ fake ctAPI；`result.ekScan` 8 字段；panel `_enrollLog` 纯函数断言。
- **packaged 模式**：`SMOKE_SOURCE=packaged`，静态服务把 `/desktop/*` 映射到从当前 `3CT-Auto/resources/app.asar` 解出的 `artifacts/patched-renderer/dist/renderer/`，并断言与 `desktop/` 冻结源字节一致。

复现命令：

```powershell
# source
node tests/enrollment-smoke.cjs
# packaged（当前已 build 的包）
python reverse/asar_extract.py --archive 3CT-Auto\resources\app.asar --out artifacts\patched-renderer --only "dist/renderer/"
$env:SMOKE_SOURCE='packaged'; node tests/enrollment-smoke.cjs; Remove-Item Env:SMOKE_SOURCE
```

## 3. 结果

| 模式 | 结果 | 结果文件 |
|---|---|---|
| source（desktop 源） | **40 passed / 0 failed** | `artifacts/enrollment/enrollment-smoke-result.json` |
| **packaged（当前包 7CD499C9…）** | **41 passed / 0 failed**（多 1 条字节一致） | `artifacts/enrollment/packaged-enrollment-smoke-result.json` |

关键断言（均 PASS）：
- 显式 `activityStatus='0'` 分页（跟随 TotalPages、有界 maxPages），候选 A/B/C/D 全部进入候选池；`ekScan` 真实统计：`fetched=8 eligible=8 joinable=4 applied=4 unknown=0 filtered=0 nextpages=6 truncated=false`；
- A/B **normal apply 成功**（fake `applyActivity` → errcode 0）；B 未被 `ApplyInfo:{}`/全零模板误判；类别经官方 `ModuleCodeList`（`label/Label + value/Value`）映射成功；
- **strict**：C 缺 `StuETime` → `waiting-material/missing-apply-window`、`decision=unknown`、`fakeApply=0`；D 报名窗未来 → `not-yet(before-apply-window)` 不提交；
- `status=1` 不重复 apply；watch 已报名活动 fake 签到完成（回归对照，非真实平台）；
- 第二轮去重：无重复 apply；每个候选都有可见决策行（activityName/category/listStatus/classify/decision/scoreGate/applyWindowStart/End），无静默丢弃；
- panel `_enrollLog`：`二课报名｜活动名｜可报名（待提交）`、`失败`/`结果未知（需人工确认）`/`预览（不提交）` 优先于 classify、`未到报名时间(before-apply-window)` 与 `未到签到/签退时间(before-window)` 区分、`formatScan`「抓取/候选/可报名/已报/待确认/过滤/页数/截断」8 项、缺字段「—」不假造 0；
- 无外部网络请求、无 pageerror、无 console.error；临时 profile 自动删除；未读用户 profile。

## 4. 最终包 / 指纹

| 文件 | SHA256 | 说明 |
|---|---|---|
| `3CT-Auto/resources/app.asar` | `7CD499C91DB632833A5ED297BD3E5F5D5D64B72C74FF37BB7921112BFDAD5F02` | 本轮已 build 的包（55,883,203B） |
| `3CT/resources/app.asar`（原包） | `028D4695FD7EA9AD0C51A795FD4D23A4199ADEC087760260F618698F1BDD3ADF` | 未修改 |
| `启动3CT自动版.exe`（root/副本） | `AF3B66314F8D844CCA4DB620AFDB1D32B2586466F0FE4445014E950D7683EB91` | 两入口同 hash |

包内脚本与 `desktop/` 冻结源逐字节一致：`automation.js 103,368B` / `panel.js 53,904B` / `panel.css 8,523B` / `jsQR.js 266,988B` / `score-policy.js 22,407B` / `result-store.js 27,689B` / `dashboard.js 47,520B`。本轮**未重 build**（byte check 一致，无需重建）。

## 5. 截图

- `artifacts/enrollment/enrollment-01-run.png`（source 一轮）
- `artifacts/enrollment/packaged-enrollment-01-run.png`、`packaged-enrollment-02-panel-cn-logs.png`（最终包 + 中文日志）

## 6. 限制与说明

1. 全部为 fake ctAPI 离线数据；**normal apply 仅验证本地决策/调用路径，不代表真实平台结果**，也不声称“积分自动到账”。
2. fake watch 签到/签退对照仅为回归保护，不代表真实平台行为，不修改定位/出勤逻辑。
3. 用户真实根因仍需原始响应：请用户在页面确认「可报名」后提供该活动的**列表/详情原始响应**（脱敏即可），以核对真实字段（如报名时间字段、ModuleCodeList 形态、ApplyInfo 模板）。
4. 未运行真实报名、未启动真实 Electron 业务、未读写用户 profile、未 git 提交（用户日志保持 untracked）。
