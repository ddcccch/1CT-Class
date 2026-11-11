/**
 * 二课可报名发现与报名状态诊断（task-12）。
 *
 * 背景（真实日志 docs/auto3ct-log-1792219408620.txt + 用户截图）：
 *  - 日志 201 行只有 signIn/signOut before-window，0 条 apply、0 条 category-unknown、0 条 score-*；
 *  - 截图：原页面筛选「可报名 + 思想政治」，1/1 页显示 2 个可报名活动（10/22、10/30）；
 *  - 旧实现默认 activityStatus='' 仅扫前 3 页，可能漏候选；且模板 ApplyInfo 可能把「可报名」误判为已报名。
 *
 * 修复口径（lead 授权）：
 *  1. 发现显式 `activityStatus:'0'` 分页（有界 maxPages 默认 20，跟 TotalPages 停，超 cap 记 truncated）；
 *     另保留 `activityStatus:'1'` 只读补充发现（不丢用户手动已报名）；
 *  2. 状态优先级：list 官方 status `'0'` → joinable（可报名），**不被模板 ApplyInfo 覆盖**；
 *     status `'1'` → applied；列表缺失/unknown 时才 fallback 到 detail.ApplyInfo，
 *     且要求「非全零 Id 且 ActivityId 可信」，空对象 {} 绝不判 applied；不要求必须是 GUID（numeric 也接受）；
 *  3. watch 跟踪独立：new discovery 失败也继续对 watched id 拉 detail（保留既有签退能力）；
 *  4. 所有候选决策产出 safe 诊断行（action/activityName/category/listStatus/classify/报名窗/score gate），
 *     不含 requestsData / token / 用户个人信息；
 *  5. 扫描 summary：fetched/eligible/joinable/applied/unknown/filtered/nextpages/truncated；
 *  6. 真正 apply 仍走旧 gate（keywords/score/time/dailyLimit/去重），不降低安全。
 *
 * 运行：<bundled node> --test desktop/test-enrollment-diagnostics.cjs
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('./automation.js');

const BJ = (y, m, d, hh = 0, mm = 0) => Date.UTC(y, m - 1, d, hh - 8, mm, 0);
const EK_LOGIN_NAME = 'test-student';
const ZERO_GUID = '00000000-0000-0000-0000-000000000000';

// ───────────────────────── fixtures ─────────────────────────

function makeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    get: (k) => (map.has(k) ? map.get(k) : null),
    set: (k, v) => void map.set(k, v),
    remove: (k) => void map.delete(k),
    dump: () => Object.fromEntries(map),
  };
}

function baseStorage(seed = {}) {
  return makeStorage({
    ct_ek_session_v1: JSON.stringify({
      JSESSIONID: 'sid',
      access_token: 'tok',
      refresh_token: 'rtok',
      user_info: { loginName: EK_LOGIN_NAME },
    }),
    ct_unirun_accounts_v1: JSON.stringify({
      selectedId: 'acc-1',
      items: [{ id: 'acc-1', phone: '13800000000', password: 'pw', remark: '主号', updatedAt: 1 }],
    }),
    ...seed,
  });
}

function makeClock(ms) {
  let now = ms;
  return { now: () => now, set: (n) => void (now = n), advance: (d) => void (now += d) };
}

function makeApi(overrides = {}) {
  const calls = [];
  const table = {
    ek: {
      getActivitiesList: { List: { Items: [], TotalPages: 1 } },
      getActivityDetail: {},
      applyActivity: { errcode: 0 },
      signByQr: { errcode: 0 },
      activityBoundImages: { items: [] },
      getStudentScores: { TypeList: [] },
    },
    unirun: { campusLocalList: [] },
    club: {
      myActivityList: { code: 10000, response: { list: [] } },
      activityList: { code: 10000, response: { list: [] } },
      currentSignTask: { code: 10000, response: null },
    },
  };
  Object.keys(table).forEach((g) => Object.assign(table[g], overrides[g] || {}));
  const api = {};
  Object.keys(table).forEach((g) => {
    api[g] = {};
    Object.keys(table[g]).forEach((name) => {
      api[g][name] = async (payload) => {
        calls.push({ name: g + '.' + name, payload });
        const v = table[g][name];
        const out = typeof v === 'function' ? await v(payload) : v;
        if (out instanceof Error) throw out;
        return out;
      };
    });
  });
  api.__calls = calls;
  api.__count = (n) => calls.filter((c) => c.name === n).length;
  api.__callsNamed = (n) => calls.filter((c) => c.name === n);
  return api;
}

function makeEngine(opts = {}) {
  const storage = opts.storage || baseStorage();
  const api = opts.api || makeApi();
  const clock = opts.clock || makeClock(BJ(2026, 10, 20, 9, 0));
  const config = Object.assign(
    {
      dryRun: false,
      ek: {
        enabled: true,
        allowAll: true,
        keywords: [],
        apply: true,
        signIn: true,
        signOut: true,
        dailyLimit: 10,
        qrDelayMinutes: 0,
        scorePolicy: { enabled: false, moduleOptions: [] },
      },
    },
    opts.config || {},
  );
  const engine = A.createEngine({
    api,
    storage,
    clock,
    decodeQr: async () => null,
    logger: { log: () => {} },
    config,
  });
  return { engine, api, storage, clock };
}

/** 列表项：默认可报名（ActivityStatus='0'） */
function listItem(over = {}) {
  return {
    Id: 'act-1',
    ActivityId: 'act-1',
    ActivityName: '志愿活动A',
    ActivityStatus: '0',
    ModuleCode: 'M1',
    ...over,
  };
}

/** 详情：ModuleCodeText 精确模块名；默认不需要签到（聚焦报名判定） */
function detail(over = {}, infoOver = {}, applyInfo = null) {
  return {
    ActivityInfo: {
      Id: 'act-1',
      ActivityName: '志愿活动A',
      ModuleCodeText: '思想政治与道德修养',
      SignWay: 1,
      StuETime: '2026-10-20 09:00:00 至 2026-10-31 18:00:00',
      ActivityQDDate: '2026-10-22 18:00:00 至 2026-10-22 18:30:00',
      ActivityQTDate: '2026-10-22 20:00:00 至 2026-10-22 20:30:00',
      IsNeedSignInText: '否',
      IsNeedSignOutText: '否',
      ...infoOver,
    },
    ApplyInfo: applyInfo,
    ...over,
  };
}

async function run(opts = {}) {
  const { engine, api, storage, clock } = makeEngine(opts);
  const out = await engine.runOnce();
  return { out, api, storage, clock };
}

function applyRows(out) {
  return out.results.filter((r) => r.action === 'apply');
}

// ───────────────────────── 1. 状态优先级（新行为） ─────────────────────────

test('列表 status=0 可报名：即使 detail.ApplyInfo 是模板（全零 GUID/非空 Id）也必须 joinable 并真正报名', async () => {
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [listItem()], TotalPages: 1 } },
      getActivityDetail: detail({}, {}, { Id: ZERO_GUID, ActivityId: ZERO_GUID }),
      applyActivity: { errcode: 0 },
    },
  });
  const { out } = await run({ api, clock: makeClock(BJ(2026, 10, 20, 9, 0)) });

  const apply = applyRows(out)[0];
  assert.ok(apply, '列表 status=0 必须产生 apply 决策行');
  assert.equal(apply.status, 'success', '官方 status=0 应优先 joinable，不被模板 ApplyInfo 覆盖');
  assert.equal(api.__count('ek.applyActivity'), 1);
});

test('列表 status=0 + item.ApplyInfo={} → 仍是 joinable（空对象绝不当已报名）', async () => {
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [listItem({ ApplyInfo: {} })], TotalPages: 1 } },
      getActivityDetail: detail({}, {}, null),
      applyActivity: { errcode: 0 },
    },
  });
  const { out } = await run({ api });
  const apply = applyRows(out)[0];
  assert.ok(apply);
  assert.equal(apply.status, 'success');
  assert.equal(api.__count('ek.applyActivity'), 1);
});

test('列表 status=1 已报名 → applied，不新增报名（但保留 watch 跟踪）', async () => {
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [listItem({ ActivityStatus: '1' })], TotalPages: 1 } },
      getActivityDetail: detail({}, {}, { Id: 'sign-1', ActivityId: 'act-1' }),
    },
  });
  const { out, storage } = await run({ api });
  assert.equal(applyRows(out).length, 1, '应有 apply 决策行（记录跳过原因）');
  assert.equal(applyRows(out)[0].status, 'skipped');
  assert.equal(applyRows(out)[0].reason, 'already-applied');
  assert.equal(api.__count('ek.applyActivity'), 0);
  const state = JSON.parse(storage.get('auto3ct:state') || '{}');
  assert.ok(Object.keys((state.watchedEk && state.watchedEk[EK_LOGIN_NAME]) || {}).includes('act-1'), '已报名必须进 watch');
});

test('列表缺 status（unknown）才 fallback detail：非全零 Id + 可信 ActivityId → applied', async () => {
  const api = makeApi({
    ek: {
      // 按请求的 activityStatus 返回：只有 status=0 查询给出「缺状态」条目
      getActivitiesList: (p) =>
        p.activityStatus === '0'
          ? { List: { Items: [listItem({ ActivityStatus: undefined, Status: undefined, status: undefined })], TotalPages: 1 } }
          : { List: { Items: [], TotalPages: 1 } },
      getActivityDetail: detail({}, {}, { Id: 'sign-77', ActivityId: 'act-1' }),
    },
  });
  const { out } = await run({ api });
  const apply = applyRows(out)[0];
  assert.ok(apply);
  assert.equal(apply.status, 'skipped');
  assert.equal(apply.reason, 'already-applied');
  assert.equal(api.__count('ek.applyActivity'), 0);
});

test('列表缺 status + detail 只有全零占位 Id（无可信 ActivityId）→ 不判已报名，仍可报名', async () => {
  const api = makeApi({
    ek: {
      getActivitiesList: (p) =>
        p.activityStatus === '0'
          ? { List: { Items: [listItem({ ActivityStatus: undefined, Status: undefined, status: undefined })], TotalPages: 1 } }
          : { List: { Items: [], TotalPages: 1 } },
      getActivityDetail: detail({}, {}, { Id: ZERO_GUID, ActivityId: ZERO_GUID }),
      applyActivity: { errcode: 0 },
    },
  });
  const { out } = await run({ api });
  const apply = applyRows(out)[0];
  assert.ok(apply);
  assert.equal(apply.classify, 'unknown', '占位 Id 不得判 applied');
  assert.equal(apply.status, 'skipped');
  assert.equal(apply.reason, 'apply-state-unknown', '列表无状态 + 占位 Id => 明确 unknown，不报也不盲报');
  assert.equal(api.__count('ek.applyActivity'), 0);
});

test('列表缺 status + numeric Id（非 GUID）也应支持 → applied', async () => {
  const api = makeApi({
    ek: {
      getActivitiesList: (p) =>
        p.activityStatus === '0'
          ? { List: { Items: [listItem({ ActivityStatus: undefined, Status: undefined, status: undefined })], TotalPages: 1 } }
          : { List: { Items: [], TotalPages: 1 } },
      getActivityDetail: detail({}, {}, { Id: '123456', ActivityId: 'act-1' }),
    },
  });
  const { out } = await run({ api });
  assert.equal(applyRows(out)[0].reason, 'already-applied');
  assert.equal(api.__count('ek.applyActivity'), 0);
});

// ───────────────────────── 2. 发现：显式 query + 分页 + 有界 ─────────────────────────

test('发现显式使用 activityStatus="0" 查询（可报名）', async () => {
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [listItem()], TotalPages: 1 } },
      getActivityDetail: detail({}, {}, null),
      applyActivity: { errcode: 0 },
    },
  });
  await run({ api });
  const listCalls = api.__callsNamed('ek.getActivitiesList');
  assert.ok(listCalls.length >= 1);
  assert.equal(listCalls[0].payload.activityStatus, '0', '必须显式查可报名');
});

test('分页跟随 TotalPages（不止固定 3 页），并能在后续页发现候选', async () => {
  const page1 = { List: { Items: [listItem({ Id: 'a1', ActivityId: 'a1', ActivityName: '活动1' })], TotalPages: 4 } };
  const empty = { List: { Items: [], TotalPages: 4 } };
  const page4 = { List: { Items: [listItem({ Id: 'a9', ActivityId: 'a9', ActivityName: '活动9' })], TotalPages: 4 } };
  let n = 0;
  const api = makeApi({
    ek: {
      getActivitiesList: () => {
        n += 1;
        if (n === 1) return page1;
        if (n === 4) return page4;
        return empty;
      },
      getActivityDetail: (p) => detail({ ApplyInfo: null }, { Id: p.id, ActivityName: p.id === 'a9' ? '活动9' : '活动1' }, null),
      applyActivity: { errcode: 0 },
    },
  });
  const { out } = await run({ api });
  const listCalls = api.__callsNamed('ek.getActivitiesList');
  assert.ok(listCalls.length >= 4, '应翻到第 4 页，实际 ' + listCalls.length);
  const ids = applyRows(out).map((r) => r.activityId);
  assert.ok(ids.includes('a9'), '第 4 页的候选必须被发现：' + JSON.stringify(ids));
});

test('分页超过 maxPages 上限 → 停止并汇总 truncated=true', async () => {
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [listItem()], TotalPages: 99 } },
      getActivityDetail: detail({}, {}, null),
      applyActivity: { errcode: 0 },
    },
  });
  const { out } = await run({ api, config: { ek: { enabled: true, allowAll: true, dailyLimit: 10, apply: true, maxPages: 3, scorePolicy: { enabled: false } } } });
  const listCalls = api.__callsNamed('ek.getActivitiesList');
  // maxPages 是「每个状态查询」的上限；本用例查 status0 与 status1 两轮
  assert.ok(listCalls.length <= 3 * 2, '每个状态查询不得超过 maxPages：' + listCalls.length);
  assert.equal(out.ekScan && out.ekScan.truncated, true, 'summary 必须标记 truncated');
});

test('保留 activityStatus="1" 只读补充发现（不丢用户手动已报名）', async () => {
  const api = makeApi({
    ek: {
      getActivitiesList: (p) => {
        if (p.activityStatus === '1') {
          return { List: { Items: [listItem({ Id: 'my-1', ActivityId: 'my-1', ActivityStatus: '1' })], TotalPages: 1 } };
        }
        return { List: { Items: [], TotalPages: 1 } };
      },
      getActivityDetail: detail({}, {}, { Id: 'sign-1', ActivityId: 'my-1' }),
    },
  });
  const { storage } = await run({ api });
  const statuses = api.__callsNamed('ek.getActivitiesList').map((c) => c.payload.activityStatus);
  assert.ok(statuses.includes('0'), '必须查 status=0');
  assert.ok(statuses.includes('1'), '必须保留 status=1 补充发现');
  const state = JSON.parse(storage.get('auto3ct:state') || '{}');
  assert.ok(Object.keys((state.watchedEk && state.watchedEk[EK_LOGIN_NAME]) || {}).includes('my-1'), '手动已报名必须进 watch');
});

// ───────────────────────── 3. watch 独立性 ─────────────────────────

test('discovery 全部失败时，已 watch 的活动仍继续拉 detail（不阻断跟踪/签退）', async () => {
  const storage = baseStorage({
    'auto3ct:state': JSON.stringify({
      done: {},
      inflight: {},
      failed: {},
      usedImages: {},
      daily: {},
      qrChecks: {},
      watchedEk: { [EK_LOGIN_NAME]: { 'watched-1': { name: '已报名活动', addedAt: 1 } } },
    }),
  });
  let detailCalls = 0;
  const api = makeApi({
    ek: {
      getActivitiesList: () => {
        throw new Error('network down');
      },
      getActivityDetail: () => {
        detailCalls += 1;
        return detail(
          {},
          {
            Id: 'watched-1',
            ActivityName: '已报名活动',
            IsNeedSignInText: '是',
            IsNeedSignOutText: '是',
          },
          { Id: 'sign-9', ActivityId: 'watched-1' },
        );
      },
    },
  });
  const { out } = await run({
    api,
    storage,
    clock: makeClock(BJ(2026, 10, 22, 18, 5)),
  });
  assert.ok(detailCalls >= 1, 'discovery 失败也必须继续对 watched 拉 detail');
  assert.ok(
    out.results.some((r) => r.activityId === 'watched-1' && (r.action === 'signIn' || r.action === 'signOut' || r.action === 'apply')),
    'watch 活动必须出现在本轮处理结果中',
  );
});

// ───────────────────────── 4. 诊断可见性 ─────────────────────────

test('可报名但不满足关键词 → 有 apply 决策行（skipped/keyword），不再静默消失', async () => {
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [listItem({ ActivityName: '无关活动' })], TotalPages: 1 } },
      getActivityDetail: detail({}, { ActivityName: '无关活动' }, null),
    },
  });
  const { out } = await run({
    api,
    config: { ek: { enabled: true, allowAll: false, keywords: ['志愿'], dailyLimit: 10, apply: true, maxScorePages: 1, scorePolicy: { enabled: false } } },
  });
  // 关键词不匹配时不应进入候选（属 filtered），但 summary 必须有计数
  assert.ok(out.ekScan, '必须提供 ekScan 汇总');
  assert.ok(out.ekScan.fetched >= 1);
  assert.ok(out.ekScan.filtered >= 1, '被关键词过滤的要有计数');
});

test('apply 决策行含 safe 诊断字段（activityName/category/listStatus/classify），不含会话或用户隐私', async () => {
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [listItem()], TotalPages: 1 } },
      getActivityDetail: detail({}, {}, null),
      applyActivity: { errcode: 0 },
    },
  });
  const { out } = await run({ api });
  const apply = applyRows(out)[0];
  assert.ok(apply);
  assert.equal(apply.activityName, '志愿活动A');
  assert.equal(apply.category, '思想政治与道德修养');
  assert.equal(apply.listStatus, '0');
  assert.equal(apply.classify, 'joinable');
  assert.ok('applyWindowStart' in apply || 'applyWindow' in apply, '应带报名时间窗诊断');
  const dump = JSON.stringify(out);
  assert.equal(dump.includes('tok'), false);
  assert.equal(dump.includes('JSESSIONID'), false);
  assert.equal(dump.includes('13800000000'), false);
});

test('ekScan 汇总字段完整：fetched/eligible/joinable/applied/unknown/filtered/nextpages/truncated', async () => {
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [listItem(), listItem({ Id: 'b2', ActivityId: 'b2', ActivityStatus: '1' })], TotalPages: 1 } },
      getActivityDetail: (p) =>
        detail(
          {},
          { Id: p.id, ActivityName: p.id === 'b2' ? '活动B' : '志愿活动A' },
          p.id === 'b2' ? { Id: 'sign-b2', ActivityId: 'b2' } : null,
        ),
      applyActivity: { errcode: 0 },
    },
  });
  const { out } = await run({ api });
  const s = out.ekScan;
  ['fetched', 'eligible', 'joinable', 'applied', 'unknown', 'filtered', 'nextpages', 'truncated'].forEach((k) => {
    assert.ok(k in s, 'ekScan 缺少字段：' + k);
  });
  assert.equal(s.fetched >= 2, true);
  assert.equal(s.joinable >= 1, true);
  assert.equal(s.applied >= 1, true);
});

// ───────────────────────── 5. 安全 gate 未被削弱 ─────────────────────────

test('每日上限仍生效：超额的可报名活动不提交', async () => {
  const items = [
    listItem({ Id: 'c1', ActivityId: 'c1' }),
    listItem({ Id: 'c2', ActivityId: 'c2' }),
    listItem({ Id: 'c3', ActivityId: 'c3' }),
  ];
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: items, TotalPages: 1 } },
      getActivityDetail: (p) => detail({}, { Id: p.id, ActivityName: p.id }, null),
      applyActivity: { errcode: 0 },
    },
  });
  const { out } = await run({
    api,
    config: { ek: { enabled: true, allowAll: true, dailyLimit: 1, apply: true, scorePolicy: { enabled: false } } },
  });
  assert.equal(api.__count('ek.applyActivity'), 1, 'dailyLimit=1 只能提交 1 次');
  assert.ok(out.results.some((r) => r.action === 'apply' && r.reason === 'daily-limit-reached'));
});

test('积分策略启用且无可信 snapshot 时仍阻断新增报名（安全不变）', async () => {
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [listItem()], TotalPages: 1 } },
      getActivityDetail: detail({}, {}, null),
      applyActivity: { errcode: 0 },
    },
  });
  const { out } = await run({
    api,
    config: { ek: { enabled: true, allowAll: true, dailyLimit: 10, apply: true, scorePolicy: { enabled: true } } },
  });
  assert.equal(api.__count('ek.applyActivity'), 0);
  const apply = applyRows(out)[0];
  assert.equal(apply.status, 'blocked');
  assert.match(apply.reason, /score-/);
});

test('报到时间窗仍生效：窗外不提交（not-yet/expired）', async () => {
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [listItem()], TotalPages: 1 } },
      getActivityDetail: detail({}, { StuETime: '2026-11-01 09:00:00 至 2026-11-02 18:00:00' }, null),
      applyActivity: { errcode: 0 },
    },
  });
  const { out } = await run({ api, clock: makeClock(BJ(2026, 10, 20, 9, 0)) });
  const apply = applyRows(out)[0];
  assert.equal(apply.status, 'not-yet');
  assert.equal(apply.reason, 'before-apply-window');
  assert.equal(api.__count('ek.applyActivity'), 0);
});

// ───────────────────────── 6. 同 id 双列表状态冲突（防双报） ─────────────────────────

test('同一 id 同时出现在 status=0 与 status=1 结果中 → 视为已报名，不重复报名并记 conflict', async () => {
  const conflictId = 'dup-1';
  const api = makeApi({
    ek: {
      getActivitiesList: (p) => {
        if (p.activityStatus === '1') {
          return {
            List: {
              Items: [listItem({ Id: conflictId, ActivityId: conflictId, ActivityStatus: '1' })],
              TotalPages: 1,
            },
          };
        }
        return {
          List: {
            Items: [listItem({ Id: conflictId, ActivityId: conflictId, ActivityStatus: '0' })],
            TotalPages: 1,
          },
        };
      },
      getActivityDetail: detail({}, { Id: conflictId, ActivityName: '冲突活动' }, { Id: 'sign-dup', ActivityId: conflictId }),
      applyActivity: { errcode: 0 },
    },
  });
  const { out } = await run({ api });

  assert.equal(api.__count('ek.applyActivity'), 0, '同一 id 冲突时禁止重复报名（status=1 更可靠）');
  const rowForId = out.results.find((r) => r.action === 'apply' && r.activityId === conflictId);
  assert.ok(rowForId, '应产生该 id 的 apply 决策行');
  assert.ok(
    rowForId.status === 'skipped' || rowForId.status === 'blocked',
    '冲突行应为 skipped/blocked，实际 ' + rowForId.status,
  );
  assert.match(String(rowForId.reason), /conflict|already-applied/);
  assert.equal(rowForId.classify, 'applied');
});

test('冲突时不因 status=0 查询结果而把 status=1 的活动改回可报名', async () => {
  const conflictId = 'dup-2';
  const api = makeApi({
    ek: {
      getActivitiesList: (p) => ({
        List: {
          Items: [listItem({ Id: conflictId, ActivityId: conflictId, ActivityStatus: p.activityStatus === '1' ? '1' : '0' })],
          TotalPages: 1,
        },
      }),
      getActivityDetail: detail({}, { Id: conflictId }, null),
      applyActivity: { errcode: 0 },
    },
  });
  const { out } = await run({ api });
  assert.equal(api.__count('ek.applyActivity'), 0);
  const rowForId = out.results.find((r) => r.action === 'apply' && r.activityId === conflictId);
  assert.equal(rowForId.classify, 'applied');
});
// ───────────────────────── 7. strict 时间窗（不得被 list status=0 绕过） ─────────────────────────

test('strict：list status=0 但 detail 缺 StuETime → waiting-material/missing-apply-window，绝不提交', async () => {
  const api = makeApi({
    ek: {
      getActivitiesList: (p) =>
        p.activityStatus === '0'
          ? { List: { Items: [listItem({ ActivityStatus: '0' })], TotalPages: 1 } }
          : { List: { Items: [], TotalPages: 1 } },
      // 详情没有报名时间字段（只有签到窗口）
      getActivityDetail: detail({}, { StuETime: undefined, StuETimeText: undefined }, null),
      applyActivity: { errcode: 0 },
    },
  });
  const { out } = await run({ api });
  const apply = applyRows(out)[0];
  assert.ok(apply);
  assert.equal(apply.status, 'waiting-material');
  assert.equal(apply.reason, 'missing-apply-window');
  assert.equal(apply.decision, 'unknown');
  assert.equal(apply.detailHasStuETime, false, '诊断应标明详情是否带 StuETime');
  assert.equal(api.__count('ek.applyActivity'), 0, '列表可报名不得绕过缺报名时间窗');
});

test('strict：报名窗在未来 → not-yet，不提交但候选可见', async () => {
  const api = makeApi({
    ek: {
      getActivitiesList: (p) =>
        p.activityStatus === '0'
          ? { List: { Items: [listItem({ ActivityStatus: '0' })], TotalPages: 1 } }
          : { List: { Items: [], TotalPages: 1 } },
      getActivityDetail: detail({}, { StuETime: '2026-11-01 09:00:00 至 2026-11-02 18:00:00' }, null),
      applyActivity: { errcode: 0 },
    },
  });
  const { out } = await run({ api, clock: makeClock(BJ(2026, 10, 20, 9, 0)) });
  const apply = applyRows(out)[0];
  assert.equal(apply.status, 'not-yet');
  assert.equal(apply.reason, 'before-apply-window');
  assert.equal(apply.decision, 'window-waiting');
  assert.equal(api.__count('ek.applyActivity'), 0);
});