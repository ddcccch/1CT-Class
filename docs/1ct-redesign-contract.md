# 1CT 重构契约（冻结版 · 2026-10-17 20:30）

> 所有 teammate 必须按本契约实现，不要自行改字段名/存储键/函数签名。有异议先问 Lead。

## 0. 目标

把 `3CT-Auto` 精简成 **1CT**：

- 只保留三大功能：①二课自动报名/签到/签退 ②每天定时刷校园跑 ③俱乐部自动报名/签到签退
- 主界面新增**成员管理**：一个程序跑多人的二课 + 校园跑 + 俱乐部，每人的账号、二课缺失板块各自独立
- 二课签到/签退**成功必须统计并可视化**（哪些成功、每人的八模块还差多少分）
- UI 极简白
- 程序名 1CT

## 1. 技术路线（已定，不要另起方案）

继续复用 3CT 主进程（`window.ctAPI` 由原 preload 注入，`ek`/`unirun`/`club` IPC 全部可用且已实测）。
**只替换渲染层**：

- 新 `index.html` 不再加载原版 `renderer.js`（React 界面），只加载 1CT shell
- 原 `dashboard.js` / `panel.js` / `panel.css` / `dashboard.css` **不再打包**（精简）
- 新文件放在 `desktop/1ct/`，打包时注入到 asar 的 `dist/renderer/1ct/`

## 2. 存储契约（localStorage）

| key | 形状 |
|---|---|
| `1ct:members` | `{version:1, selectedId:string\|null, items:Member[]}` |
| `1ct:config:global` | 全局默认 config（三大模块开关/参数），形状同 `Auto3CTAutomation.DEFAULTS` |
| `1ct:config:<memberId>` | 该成员覆盖 config（与全局合并），结构同上 |
| `1ct:state:<memberId>` | 该成员引擎运行态，**引擎原样格式**（`auto3ct:state` 的内容） |
| `1ct:scores:<memberId>` | 该成员二课积分快照，**引擎原样格式**（`auto3ct:scores` 的内容） |
| `1ct:results` | 全局结果历史（`Auto3CTResults` 格式），每条事件带 `memberId` |
| `1ct:ui` | `{version:1, tab:'run'\|'members'\|'ek'\|'logs', selectedMemberId:string\|null}` |

### Member

```js
{
  id: 'm_xxxxxxxx',            // 稳定唯一 id（生成后不改）
  name: '张三',                 // 展示名
  note: '',                    // 备注
  enabled: true,               // 是否参与自动运行
  ek: {                        // 二课会话（结构完全等于 3CT 的 ct_ek_session_v1）
    JSESSIONID, access_token, refresh_token, user_info
  } | null,
  ekStatus: 'ok' | 'expired' | 'none',   // 会话状态（默认 'none'；refreshEk 失败置 'expired'）
  ekCredentials: { studentId, password } | null,  // 二课学号+密码，用于会话过期自动重登（不参加任何展示/导出）
  unirun: {                    // 校园跑/俱乐部共用账号（结构等于 3CT 的 ct_unirun_accounts_v1.items[i]）
    id, phone, password, remark
  } | null,
  ekModules: null | [         // 该成员八模块现状；null 表示未配置
    { name: '思想政治与道德修养', required: 12, current: 6 }, ... 8 项
  ],
  createdAt, updatedAt
}
```

八模块固定名称与 required（来自 `score-policy.js`，不要改）：
思想政治与道德修养12 / 学术科技与创新创业8 / 艺术体验与审美修养12 / 传统文化与人文素养8 / 人际交往与沟通能力8 / 心理素质与身体素质12 / 社会实践与志愿服务12 / 社会工作与能力拓展8

## 3. 多成员与引擎的关系（关键设计）

**不改引擎内部逻辑**，用 storage 适配器做成员隔离：

`desktop/1ct/members.js` 导出：

```js
window.OneCTMembers = {
  load(): {version, selectedId, items},
  save(state),
  upsertMember(member): Member,
  removeMember(id),
  getMember(id): Member|null,
  selectMember(id),

  /** 引擎用 storage：把引擎的固定 key 映射到成员维度 */
  engineStorage(memberId): {
    get(key), set(key, value), remove(key)
  },
  // 映射规则：
  //   'auto3ct:state'  -> '1ct:state:<memberId>'
  //   'auto3ct:config' -> '1ct:config:<memberId>'
  //   'auto3ct:scores' -> '1ct:scores:<memberId>'
  //   'ct_ek_session_v1' -> 从 members 里读 member.ek（无则 null）
  //   'ct_unirun_accounts_v1' -> 由 member.unirun 合成 {selectedId:id, items:[unirun]}

  /** 结果仓库用 storage：全局共享 */
  resultsStorage(): {get(key), set(key,value), remove(key)}
  //   'auto3ct:results' -> '1ct:results'

  /** 该成员的生效 config：deepMerge(1ct:config:global, 1ct:config:<id>) */
  effectiveConfig(memberId): object,

  /**
   * 写 config（契约补充 v2，UI 必须用它落盘，禁止直接写 localStorage）
   *  - memberId = null  → 写 1ct:config:global（全局默认）
   *  - memberId = '<id>' → 写 1ct:config:<id>（成员覆盖）
   *  - 深合并后保存，返回合并后的该层配置
   *  - 预览开关只写全局：setConfig(null, {dryRun:true|false})
   *  - 成员级覆盖里不落 dryRun（写入时若 patch 含 dryRun 且 memberId 非空，返回 rejected）
   */
  setConfig(memberId, patch): object,

  /** 二课凭证登录（契约补充 v2） */
  loginEk(memberId, { student_id, password }): Promise<Member>,
  /** 会话续期 */
  refreshEk(memberId): Promise<Member>,
  /** 校园跑账号可用性校验 */
  verifyUnirun(memberId): Promise<{ ok, studentId?, schoolName?, reason? }>,

  /** 写二课会话（登录成功/刷新成功后调用） */
  setEkSession(memberId, session): Member,

  /** 串行跑所有 enabled 成员；返回 {results:[], byMember:{}} */
  runAll({ api, clock, decodeQr, logger, onResult, onlyMemberId? }): Promise
}
```

**runAll 实现口径**：
- 遍历 `items` 中 `enabled === true` 的成员（可按 `onlyMemberId` 过滤）
- 每个成员：`createEngine({api, storage: engineStorage(m.id), clock, decodeQr, logger, config: effectiveConfig(m.id)})` → `engine.runOnce()`
- engine 返回的每条 result 加 `memberId` / `memberName` 再 push 给 `onResult`（并写 `1ct:results`）
- **任一成员抛错不影响其他成员**；成员级错误记 `{status:'unknown', reason:'member-error'}`
- 串行执行（避免并发把上游打挂）
- 单飞：runAll 运行中重复调用直接返回 `{busy:true}`

**二课会话写入**：成员二课登录成功后，调用 `OneCTMembers.setEkSession(memberId, session)` 写回 `1ct:members`（成员 `ek` 字段）。

## 4. 二课统计模块

`desktop/1ct/ek-stats.js` 导出 `window.OneCTStats`：

```js
{
  /** 单成员统计 */
  build({ member, events, scoreEntry }): {
    memberId, memberName,
    signIn:  { success, failed, waiting, lastAt },
    signOut: { success, failed, waiting, lastAt },
    activities: [{ activityId, name, category, signInStatus, signOutStatus, lastAt }],
    modules: [{ name, required, current, gap, satisfied }],  // 来自 member.ekModules + scoreEntry.snapshot
    totalGap, trusted, stale, refreshedAt
  },

  /** 多成员汇总 */
  buildAll({ members, events, scoresByMember }): { members:[...], totals:{...} },

  /** 渲染到容器（极简白，自带 DOM，无框架） */
  renderInto(el, stat, opts): void,

  /** 导出 CSV 文本 */
  toCSV(stats): string
}
```

口径：
- 成功 = 事件 `status === 'success'` 且 `action` 为 `signIn`/`signOut`
- `gap = max(0, required - current)`；current 缺失时 `gap = null`（**不当 0**）
- `totalGap` = 所有非 null gap 之和
- 统计范围：最近 90 天（与 result-store 一致）

## 5. UI 契约（极简白）

`desktop/1ct/index.html` + `shell.js` + `shell.css`：

### 页面结构

```
┌─ 顶栏：1CT  [运行] [成员] [二课] [日志]          开关：预览模式 / 启动
├─ 内容区（按 tab 切换）
└─ 底栏：上次运行时间 / 本轮摘要
```

- **运行**：总开关、预览开关、参与成员多选（默认全选 enabled）、三大模块卡片（每模块：开关 + 关键参数）
- **成员**：列表（姓名/二课状态/校园跑账号/积分缺口合计/启用）+ 新增/编辑/删除；编辑弹层里可填二课会话 JSON（粘贴）、校园跑手机号密码、八模块现状
- **二课**：成员选择器 + 签到成功统计卡（签到/签退成功数、最近活动表）+ 八模块进度条 + 缺口合计 + 导出 CSV
- **日志**：最近 300 条，按成员着色

### 视觉（极简白，硬要求）

```
--bg: #ffffff;  --bg-subtle: #fafafa;  --border: #e8e8ea;
--text: #111113;  --text-2: #6b7280;  --accent: #111113;  --ok: #16a34a;  --warn: #d97706;  --err: #dc2626;
圆角 10px，边框 1px，无阴影（或 0 1px 2px rgba(0,0,0,.04)）；
字体 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif；
按钮：白底黑字 + 1px 边框，主按钮黑底白字；不用渐变、不用深色、不用彩色大色块。
```

### 数据流

- 一切通过 `window.ctAPI`（引擎）+ `OneCTMembers` + `OneCTStats` + `window.Auto3CTResults`
- 绝不打印/导出 token、密码、完整手机号（手机号 `138****0000` 掩码）

## 6. 打包契约（packaging）

- 输出目录：`<repo>\1CT\`（新）
- 启动器：`启动1CT.exe`（GUI，无控制台）
- 窗口标题：`1CT`
- asar 注入：`dist/renderer/index.html` 替换为 1CT 版本，仅加载
  ```
  ./1ct/shell.css, ./1ct/shell.js, ./1ct/members.js, ./1ct/ek-stats.js, ./1ct/ek-stats.css
  ./jsQR.js, ./score-policy.js, ./result-store.js, ./automation.js
  ```
  （`jsQR` 仍需要：二课扫码图库路径保留；`panel.js/dashboard.js` 不注入）
- 保留 `auto-bootstrap.cjs`（禁更新 + 关后台节流）

## 7. 文件归属（防冲突）

| 文件 | 归属 |
|---|---|
| `desktop/1ct/members.js` | members-core |
| `desktop/1ct/ek-stats.js`, `desktop/1ct/ek-stats.css` | ek-stats |
| `desktop/1ct/index.html`, `desktop/1ct/shell.js`, `desktop/1ct/shell.css` | ui-shell |
| `desktop/install.py`, `desktop/build_gui_launcher.py`, `desktop/GuiLauncher.cs`, `desktop/1ct/packaging.md` | packaging |
| `desktop/automation.js`, `desktop/test-automation*.cjs` | 不动（如需小改先问 Lead） |
| `desktop/test-1ct-*.cjs` | 各自写各自的 |

## 8. 验收

- `node --test desktop/test-1ct-*.cjs` 全绿
- 现有全部测试不回归：`node --test desktop/test-automation*.cjs`、`python -m unittest discover -s tests`
- 打包后 `1CT/resources/app.asar` 内含全部 1ct 文件，`index.html` 只引 1CT 脚本
- 用 Playwright 打开打包后的 renderer，四大页面可切换、成员可增删、统计有数（fake ctAPI）
