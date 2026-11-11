# 俱乐部（Tanma `clubactivity`）与校园跑链路：已确证事实与验证边界

> 本文只记录**在代码或只读实测里能指认**的事实；没有验证过的因果推断一律不写。
> 所有标识（`schoolId`、`clubActivityId`、日期、坐标、计数）都是合成 fixture，真实账户证据不入库。

## 1. 上游字段形状（只读抓包确认）

- `queryActivityList` 字段全集：`activityItemId, activityName, addressDetail, cancelSign, clubActivityId,
  clubIntroduction, endTime, fullActivity, maxStudent, optionStatus, signInStudent, signStatus, startTime,
  teacherName, yearSemester` —— 其中**没有** `latitude`/`longitude`（至少在本机观察到的响应里没有）。
- `queryMyActivityList` 的日期字段是 `mmdd` / `nextMmdd`，**没有 `yymmdd`**；本机观察 `nextMmdd` 为 `null`。
- `getSignInTf` 在没有进行中任务时返回 `code=10000` + `response` 字段齐全但**全 null**。
  所以「看 `code` 就以为有任务」会误判，必须看 `response` 内容。
- `countValidSignUp` 形状是 `{"joinNum":<报名数>,"validNum":<有效签到数>}`，两者不等价。
- 同一天列表里可能同时出现多个校区的场次，只能用 `activityName` / `addressDetail` 区分。

## 2. 客户端已实现的守卫（代码位置）

| 机制 | 位置 | 行为 |
|---|---|---|
| 成功码门禁 | `desktop/automation.js` | 上游 `code` 不是成功码就记失败，不把 `msg` 当成功 |
| 记录四元组匹配 | `desktop/automation.js` `clubRecordSignState` | 记录条目只有 `configurationId`，与 myTask 的 `clubActivityId`/`configurationTimeId` **不是同一 id 空间**，所以绝不按 id 对号；必须「完整活动名称（含校区）+ 完整日期 + 开始时刻 + 结束时刻」四元组全等且候选唯一才采用其 `signStatus`。非零小数秒（`18:00:30.5`）不得截断成 `18:00:30` 而误合并场次 |
| 日志脱敏 | `desktop/automation.js` | `Bearer`/`password`/`JSESSIONID`/`secret` 等片段收敛为 `***`，含空格与引号变体 |
| 校园跑账号缺失 | `automation.js:1971` | `waiting-material / no-unirun-account` |
| 校园跑校区 | `automation.js:2049`、`:2063` | 本地校区列表为空 → `no-campus`；显式选中的校区 id 不在列表里 → `campus-not-found`（上游取列表失败走 catch，不产出这两个 reason） |
| 配速拦截 | `automation.js:1899`、`:2010` | 显式里程/时长超出官方 4~10 km/h → `waiting-material / pace-out-of-range`，**不改写用户填的值** |
| 俱乐部账号缺失 | `automation.js:2116` | `waiting-material / no-unirun-account` |
| 俱乐部坐标来源 | `automation.js:2466-2476`、`:2522` | 只有 `club.allowActivityCoords === true` 时才用**本活动自己**的 `latitude`/`longitude`；拿不到就返回 `null`，调用方产出 `waiting-material / need-coords`，**绝不用别的活动的坐标硬提交** |

## 3. 只读实测结论

- **校园跑 `no-campus`**：1CT 用独立 userData（`%APPDATA%\1CT`），其中没有 3CT 的 `unirun\localdb.v1.json`，
  所以校区库初始为空 → `campusLocalList()` 返回空 → 每轮停在「未选择跑步校区」、零提交。
  这是独立数据目录带来的产品级缺口，不是抓包/复现环境问题（真实 profile 与副本一致）。
- **`code=10000` 不等于成绩有效**：本机一次 1100 米 / 35 分钟的提交返回了 `code=10000`，
  但只读 `runRecords` 里该记录 `runStatus=9`、有效距离/时长为空、速度为 0；历史有效记录是 `runStatus=1` 且字段完整。
  所以「提交被受理」与「成绩有效」必须分开判断。
- **俱乐部 `need-coords`**：本机活动条目未带坐标、配置里也没有兜底坐标时，结果是 `waiting-material / need-coords`，
  不会用空坐标或别的活动的坐标提交。

## 4. 验证边界（未确证，不要当结论）

- 学校**在真实签到窗口内**是否下发签到位坐标：未验证。本机只观察到窗口外全 null。
- 跨校区报名的失败发生在报名阶段还是签到阶段：未区分，只观察到失败。
- 俱乐部链路（报名 → 签到 → 签退）**未在真实活动窗口端到端验收**。
- 列表 `queryMyActivityList.signStatus='1'` **不等于完成**；记录接口 `getStudentClubRecord.signStatus` 实测语义是 `0`=未签到、`3`=已签到未签退、`1`=已完成；其余取值语义未穷举。

## 5. 复现命令与测试边界

```bash
node --test desktop/test-automation.cjs     # 146 例（引擎/计划分支，含上面这些守卫）
node --test desktop/test-1ct-members.cjs    # 118 例（成员与配置合并）
node desktop/test-1ct-shell.cjs             # 426 条（渲染层；自定义 harness，不要用 node --test）
python -m unittest discover -s tests        # 全量里有 2 个已知失败，见下
```

那 2 个已知失败固定是 `tests/test_gui_launcher.py::GuiLauncherBuildTests`：它需要
`3CT/resources/assets/icon.ico`，本机没有 3CT 目录，`desktop/build_gui_launcher.py:150` 抛
`BuildError: 图标文件不存在`。与 1CT 构建、俱乐部链路都无关。

抓包复现只调 `queryActivityList` / `queryMyActivityList` / `getSignInTf` / `getStudentClubRecord` /
`countValidSignUp` 这些查询接口，**不要**调 `joinClubActivity` / `signInOrSignBack`；
真实响应只落本机临时目录，不进仓库。

## 6. 说明

- 本文 id / 日期 / 坐标 / 计数均为合成 fixture；复现请用你自己的账号与本校真实点位。
- 代码行号对应本轮修复时的源码；上游字段语义变化时以实测为准。
- 账号、密码、token、`studentId`、真实签到点坐标一律不写进仓库文档。
