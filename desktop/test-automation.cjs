/**
 * 3CT 自动业务引擎测试（Node 内置 test runner，离线、不触网）。
 *
 * fixture 口径严格对齐 3CT 恢复源码：
 *  - 校园跑账号：localStorage `ct_unirun_accounts_v1` = { selectedId, items:[{id,phone,password,remark,updatedAt}] }
 *    （renderer/services/unirunAccounts.ts）
 *  - 校区：ctAPI.unirun.campusLocalList() 返回数组（不是 localStorage）
 *  - 二课会话：localStorage `ct_ek_session_v1` = {JSESSIONID,access_token,refresh_token,user_info}
 *  - 二课活动详情：ActivityInfo（含 SignWay 1=扫码/2=拍照/3=拍照+定位/4=验证码、
 *    IsNeedSignInText/IsNeedSignOutText='是'、ActivityQDDate/ActivityQTDate 区间串、
 *    ActivityListInfo.ActivitySignInfo.SignD/SignT='已签到'/'已签退'）+ ApplyInfo.Id(=signId)
 *  - 二课列表：{ List: { Items: [...] } }，item: Id/ActivityId、ActivityStatus 0可报名 1已报名
 *  - 俱乐部：{ code, response:{list:[...]} }，optionStatus 6=可报名 1=已报名；code 10000/1000
 *  - 校园跑上报：{ code:10000, response, msg } 严格判 10000
 *
 * 运行：<bundled node> --test desktop/test-automation.cjs
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('./automation.js');

const BJ = (y, m, d, hh = 0, mm = 0, ss = 0) => Date.UTC(y, m - 1, d, hh - 8, mm, ss);
const EK_ACCOUNT = { id: 'acc-1', phone: '13800000000', password: 'pw', remark: '主号', updatedAt: 1 };
const EK_LOGIN_NAME = '20230001';

function makeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    get: (k) => (map.has(k) ? map.get(k) : null),
    set: (k, v) => void map.set(k, v),
    remove: (k) => void map.delete(k),
    dump: () => Object.fromEntries(map),
  };
}

function makeClock(ms) {
  let now = ms;
  return { now: () => now, advance: (d) => void (now += d), set: (n) => void (now = n) };
}

/** 真实形状的初始存储 */
function baseStorage(seed = {}) {
  return makeStorage({
    ct_ek_session_v1: JSON.stringify({
      JSESSIONID: 'sid',
      access_token: 'tok',
      refresh_token: 'rtok',
      user_info: { loginName: EK_LOGIN_NAME, userName: '测试' },
    }),
    ct_unirun_accounts_v1: JSON.stringify({ selectedId: 'acc-1', items: [EK_ACCOUNT] }),
    ...seed,
  });
}

/** 记录调用；overrides[group][method] 可覆盖返回值或实现 */
function makeApi(overrides = {}) {
  const calls = [];
  const table = {
    unirun: {
      campusLocalList: [{ id: 'c1', label: '主校区', mapName: 'm1.txt', schoolSiteIndex: 1, updatedAt: 1 }],
      autoRun: { code: 10000, response: { recordId: 7 }, msg: 'ok' },
    },
    ek: {
      getActivitiesList: { List: { Items: [] } },
      getActivityDetail: {},
      applyActivity: { errcode: 0 },
      signByQr: { errcode: 0 },
      activityBoundImages: { items: [] },
    },
    club: {
      myActivityList: { code: 10000, response: { list: [] } },
      activityList: { code: 10000, response: { list: [] } },
      currentSignTask: { code: 10000, response: null },
      joinActivity: { code: 10000 },
      signInOrSignBack: { code: 10000 },
    },
    scheduler: { listTasks: { items: [] } },
  };
  Object.keys(table).forEach((group) => {
    table[group] = Object.assign({}, table[group], (overrides[group] || {}));
  });
  const api = {};
  Object.keys(table).forEach((group) => {
    api[group] = {};
    Object.keys(table[group]).forEach((name) => {
      api[group][name] = async (payload) => {
        calls.push({ name: group + '.' + name, payload });
        const v = table[group][name];
        const out = typeof v === 'function' ? await v(payload) : v;
        if (out instanceof Error) throw out;
        return out;
      };
    });
  });
  api.__calls = calls;
  api.__count = (name) => calls.filter((c) => c.name === name).length;
  return api;
}

function makeEngine(opts = {}) {
  const clock = opts.clock || makeClock(BJ(2026, 9, 21, 8, 0));
  const storage = opts.storage || baseStorage();
  const api = opts.api || makeApi();
  const logs = [];
  const config = Object.assign({ dryRun: false }, opts.config || {});
  // 测试语义：用例里出现某模块配置即视为该模块已启用（生产默认 false）。
  // 需验证「模块关闭」的用例显式传 enabled:false。
  ['ek', 'club', 'unirun'].forEach((name) => {
    if (config[name] && config[name].enabled === undefined) config[name].enabled = true;
  });
  // 二课积分策略：本文件用例聚焦既有引擎行为，显式关闭策略（生产默认 true）。
  // 策略默认启用下的行为由 desktop/test-automation-score.cjs 专项覆盖。
  if (config.ek && config.ek.scorePolicy === undefined) {
    config.ek.scorePolicy = { enabled: false };
  }
  if (config.ek && Array.isArray(config.ek.scorePolicy.moduleOptions) === false) {
    config.ek.scorePolicy = Object.assign({}, config.ek.scorePolicy, {
      moduleOptions: [
        { label: '思想政治与道德修养', value: 'M1' },
        { label: '传统文化与人文素养', value: 'M2' },
      ],
    });
  }
  const engine = A.createEngine({
    api,
    storage,
    clock,
    decodeQr: opts.decodeQr || (async () => null),
    logger: { log: (m) => logs.push(String(m)) },
    config,
  });
  return { engine, api, storage, clock, logs };
}

// ───────────────────────────── 纯函数 ─────────────────────────────

test('北京时间解析与本机时区无关', () => {
  const r = A.parseEkRange('2026-09-21 18:00:00 至 2026-09-21 18:30:00');
  assert.equal(r.start, BJ(2026, 9, 21, 18, 0));
  assert.equal(r.end, BJ(2026, 9, 21, 18, 30));
  assert.equal(A.beijingDateString(BJ(2026, 9, 21, 23, 59)), '2026-09-21');
  assert.equal(A.beijingDateString(BJ(2026, 9, 22, 0, 1)), '2026-09-22');
});

test('club 只给时刻时必须用日期来源补齐，缺日期不猜', () => {
  assert.equal(A.parseClubMoment('18:00', ['2026-09-21']), BJ(2026, 9, 21, 18, 0));
  assert.equal(A.parseClubMoment('18:00', []), null);
  assert.equal(A.parseClubMoment('2026-09-21 18:00:00', []), BJ(2026, 9, 21, 18, 0));
});

test('二课二维码校验 lbUUh 前缀 / QD、QT 后缀', () => {
  assert.equal(A.isValidEkQr('lbUUh-abc'), true);
  assert.equal(A.isValidEkQr('a|b|QD'), true);
  assert.equal(A.isValidEkQr('a|b|QT'), true);
  assert.equal(A.isValidEkQr('a|b|XX'), false);
  assert.equal(A.isValidEkQr(''), false);
});

test('去重 key = 日期|账号|模块|活动|动作', () => {
  assert.equal(
    A.dedupeKey({ date: '2026-09-21', account: '20230001', module: 'ek', activityId: '9', action: 'signIn' }),
    '2026-09-21|20230001|ek|9|signIn',
  );
});

test('二课活动列表只认 res.List.Items，结构不符不得当空成功', () => {
  assert.equal(A.ekListItems({ List: { Items: [{ Id: 1 }] } }).length, 1);
  assert.equal(A.ekListItems({ list: [] }), null);
  assert.equal(A.ekListItems(null), null);
});

// ───────────────────────────── 概览 / 预览 ─────────────────────────────

test('preview 只读：不调用任何写接口', async () => {
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [ekItem()] } },
      // 未报名：详情无 ApplyInfo；图片带窗口内上传时间
      getActivityDetail: ekDetail({}, {}, null),
      activityBoundImages: {
        items: [{ id: 'i', file_url: 'https://x/1.png', created_at: '2026-09-21 18:01:00' }],
      },
    },
  });
  const { engine } = makeEngine({
    api,
    clock: makeClock(BJ(2026, 9, 21, 18, 5)),
    decodeQr: async () => 'lbUUh-abc',
    config: { ek: { keywords: ['歌手'], apply: true } },
  });
  const plan = await engine.preview();
  assert.ok(plan.results.length > 0);
  const write = api.__calls.filter((c) => /applyActivity|signByQr|joinActivity|signInOrSignBack|autoRun/.test(c.name));
  assert.equal(write.length, 0);
  assert.ok(plan.results.some((r) => r.status === 'dry-run'));
});

test('连续 3 次 preview 不消耗 QR 尝试预算，随后真跑仍可签到', async () => {
  const storage = baseStorage();
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [ekItem()] } },
      getActivityDetail: ekDetail(),
      activityBoundImages: {
        items: [
          { id: 'qd-1', file_url: 'https://x/qd.png', created_at: '2026-09-21 18:01:00', bind: { remark: '签到' } },
        ],
      },
      signByQr: { errcode: 0 },
    },
  });
  const clock = makeClock(BJ(2026, 9, 21, 18, 5));
  const { engine } = makeEngine({
    api,
    storage,
    clock,
    decodeQr: async () => 'lbUUh-abc-QD',
    config: { ek: { keywords: ['歌手'], qrDelayMinutes: 0, qrMaxAttempts: 3 } },
  });

  // 预览 3 次（严格等于 maxAttempts，若误持久化则真跑会被 qr-attempts-exhausted 拦住）
  for (let i = 0; i < 3; i += 1) {
    const plan = await engine.preview();
    assert.ok(
      plan.results.some((r) => r.status === 'dry-run' || r.status === 'waiting-material'),
      '预览应产出计划行',
    );
  }

  // preview 不得写入真实 qrChecks 计数
  const rawState = storage.get('auto3ct:state');
  if (rawState) {
    const st = JSON.parse(rawState);
    const checks = st.qrChecks || {};
    Object.keys(checks).forEach((k) => {
      assert.equal(Number(checks[k].count) || 0, 0, 'preview 不应持久化 qrChecks 次数：' + k);
    });
  }

  // 真跑仍应能签到成功（不消耗预算）
  const real = await engine.runOnce();
  const r = real.results.find((x) => x.action === 'signIn');
  assert.equal(r.status, 'success', 'preview 不应耗尽真实 QR 尝试预算：' + JSON.stringify(r));
  assert.equal(api.__count('ek.signByQr'), 1);
});

test('preview 对真实 state 完全无副作用（done/usedImages/daily/watch/qrChecks 均不变）', async () => {
  const storage = baseStorage();
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [ekItem()] } },
      getActivityDetail: ekDetail(),
      activityBoundImages: {
        items: [
          { id: 'qd-1', file_url: 'https://x/qd.png', created_at: '2026-09-21 18:01:00', bind: { remark: '签到' } },
        ],
      },
      signByQr: { errcode: 0 },
    },
  });
  const clock = makeClock(BJ(2026, 9, 21, 18, 5));
  const { engine } = makeEngine({
    api,
    storage,
    clock,
    decodeQr: async () => 'lbUUh-abc-QD',
    config: { ek: { keywords: ['歌手'], qrDelayMinutes: 0 } },
  });

  const before = storage.get('auto3ct:state');
  const plan = await engine.preview();
  const after = storage.get('auto3ct:state');

  // 预览仍能正常产出计划（说明查询/解码没被禁写影响）
  assert.ok(plan.results.some((r) => r.action === 'signIn'), '预览应仍能产出签到计划行');
  assert.equal(api.__count('ek.signByQr'), 0, '预览不得提交');

  // 真实状态字节级不变
  assert.equal(after, before, 'preview 不得改动真实去重状态');
});

test('getProfiles 只返回账号 ID/备注与脱敏手机号，不含密码', () => {
  const { engine } = makeEngine();
  const p = engine.getProfiles();
  const dump = JSON.stringify(p);
  assert.equal(dump.includes('13800000000'), false);
  assert.equal(dump.includes('pw'), false);
  assert.equal(p.unirunPhone, '138****0000');
  assert.equal(p.unirunAccounts.length, 1);
  assert.equal(p.unirunAccounts[0].remark, '主号');
});

// ───────────────────────────── 二课 ─────────────────────────────

function ekItem(over = {}) {
  return {
    Id: 'act-1',
    ActivityId: 'act-1',
    ActivityName: '校园歌手大赛',
    ActivityStatus: '0',
    ...over,
  };
}

/** 真实详情：ActivityInfo + ApplyInfo.Id(=signId，表示已报名) */
function ekDetail(over = {}, infoOver = {}, applyInfo = { Id: 'sign-1', ActivityId: 'act-1' }) {
  return {
    ActivityInfo: {
      Id: 'act-1',
      ActivityName: '校园歌手大赛',
      ModuleCodeText: '思想政治与道德修养', // 真实字段：exact 模块中文名
      SignWay: 1, // 1=扫码
      SignWayText: '扫码',
      StuETime: '2026-09-20 09:00:00 至 2026-09-25 18:00:00',
      ActivityQDDate: '2026-09-21 18:00:00 至 2026-09-21 18:30:00',
      ActivityQTDate: '2026-09-21 20:00:00 至 2026-09-21 20:30:00',
      IsNeedSignInText: '是',
      IsNeedSignOutText: '是',
      ...infoOver,
    },
    ApplyInfo: applyInfo,
    ...over,
  };
}

test('二课按关键词报名：ActivityStatus=0 且 errcode=0 记成功并落幂等键', async () => {
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [ekItem(), ekItem({ Id: 'x2', ActivityName: '无关活动' })] } },
      // 未报名：详情无 ApplyInfo
      getActivityDetail: ekDetail({}, {}, null),
    },
  });
  const { engine, storage } = makeEngine({
    api,
    clock: makeClock(BJ(2026, 9, 21, 8, 0)),
    config: { ek: { keywords: ['歌手'] } },
  });
  const out = await engine.runOnce();
  const r = out.results.find((x) => x.action === 'apply' && x.activityId === 'act-1');
  assert.ok(r, '应产生 act-1 报名结果');
  assert.equal(r.status, 'success');
  assert.equal(api.__count('ek.applyActivity'), 1);
  assert.equal(api.__calls.find((c) => c.name === 'ek.applyActivity').payload.act_id, 'act-1');
  const state = JSON.parse(storage.get('auto3ct:state'));
  assert.ok(state.done['2026-09-21|' + EK_LOGIN_NAME + '|ek|act-1|apply']);
});

test('二课报名 errcode 非 0 → failed 且不重试', async () => {
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [ekItem()] } },
      getActivityDetail: ekDetail({}, {}, null),
      applyActivity: { errcode: 5, errmsg: '名额已满' },
    },
  });
  const { engine } = makeEngine({ api, clock: makeClock(BJ(2026, 9, 21, 8, 0)), config: { ek: { keywords: ['歌手'] } } });
  const out = await engine.runOnce();
  assert.equal(out.results.find((x) => x.action === 'apply').status, 'failed');
  assert.equal(api.__count('ek.applyActivity'), 1);
});

test('二课已报名（ApplyInfo 存在 / ActivityStatus=1）不再报名', async () => {
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [ekItem({ ActivityStatus: '1' })] } },
      getActivityDetail: ekDetail(),
    },
  });
  const { engine } = makeEngine({ api, clock: makeClock(BJ(2026, 9, 21, 8, 0)), config: { ek: { keywords: ['歌手'] } } });
  await engine.runOnce();
  assert.equal(api.__count('ek.applyActivity'), 0);
});

test('二课 SignWay=1 且窗口内、boundImages 有有效码 → signByQr(QD)', async () => {
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [ekItem()] } },
      getActivityDetail: ekDetail(),
      activityBoundImages: {
        items: [
          { id: 'img1', file_url: 'https://x/1.png', created_at: '2026-09-21 18:01:00' },
          { id: 'img2', file_url: 'https://x/2.png', created_at: '2026-09-21 18:02:00' },
        ],
      },
      signByQr: { errcode: 0 },
    },
  });
  const { engine } = makeEngine({
    api,
    clock: makeClock(BJ(2026, 9, 21, 18, 5)),
    decodeQr: async (url) => (url.endsWith('2.png') ? 'lbUUh-abc' : null),
    config: { ek: { keywords: ['歌手'] } },
  });
  const out = await engine.runOnce();
  assert.equal(out.results.find((x) => x.action === 'signIn').status, 'success');
  const call = api.__calls.find((c) => c.name === 'ek.signByQr');
  assert.equal(call.payload.fun_type, 'QD');
  assert.equal(call.payload.qrcode, 'lbUUh-abc');
});

test('二课 SignWay 缺失 → waiting-material（明确等待签到方式，不猜）', async () => {
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [ekItem()] } },
      getActivityDetail: ekDetail({}, { SignWay: undefined, SignWayText: '' }),
    },
  });
  const { engine } = makeEngine({
    api,
    clock: makeClock(BJ(2026, 9, 21, 18, 5)),
    config: { ek: { keywords: ['歌手'] } },
  });
  const out = await engine.runOnce();
  const r = out.results.find((x) => x.action === 'signIn');
  assert.equal(r.status, 'waiting-material');
  assert.equal(r.reason, 'need-sign-way');
  assert.equal(api.__count('ek.signByQr'), 0);
});

test('二课 SignWay=2（拍照）→ waiting-material need-manual-sign-way', async () => {
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [ekItem()] } },
      getActivityDetail: ekDetail({}, { SignWay: 2, SignWayText: '拍照' }),
    },
  });
  const { engine } = makeEngine({
    api,
    clock: makeClock(BJ(2026, 9, 21, 18, 5)),
    config: { ek: { keywords: ['歌手'] } },
  });
  const out = await engine.runOnce();
  const r = out.results.find((x) => x.action === 'signIn');
  assert.equal(r.status, 'waiting-material');
  assert.equal(r.reason, 'need-manual-sign-way');
  assert.equal(api.__count('ek.signByQr'), 0);
});

test('二课无可用二维码 → waiting-material，不提交、不假成功', async () => {
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [ekItem()] } },
      getActivityDetail: ekDetail(),
      activityBoundImages: { items: [{ id: 'i', file_url: 'https://x/1.png' }] },
    },
  });
  const { engine, storage } = makeEngine({
    api,
    clock: makeClock(BJ(2026, 9, 21, 18, 5)),
    decodeQr: async () => null,
    config: { ek: { keywords: ['歌手'] } },
  });
  const out = await engine.runOnce();
  const r = out.results.find((x) => x.action === 'signIn');
  assert.equal(r.status, 'waiting-material');
  assert.equal(r.reason, 'need-qr-or-manual');
  assert.equal(api.__count('ek.signByQr'), 0);
  const state = JSON.parse(storage.get('auto3ct:state') || '{}');
  const done = state.done || {};
  assert.equal(done['2026-09-21|' + EK_LOGIN_NAME + '|ek|act-1|signIn'], undefined);
});

test('二课已签到（SignD=已签到）跳过，不重复提交', async () => {
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [ekItem()] } },
      getActivityDetail: ekDetail({}, { ActivityListInfo: { ActivitySignInfo: { SignD: '已签到' } } }),
      activityBoundImages: { items: [{ id: 'i', file_url: 'https://x/1.png' }] },
    },
  });
  const { engine } = makeEngine({
    api,
    clock: makeClock(BJ(2026, 9, 21, 18, 5)),
    decodeQr: async () => 'lbUUh-abc',
    config: { ek: { keywords: ['歌手'] } },
  });
  const out = await engine.runOnce();
  const r = out.results.find((x) => x.action === 'signIn');
  assert.equal(r.status, 'skipped');
  assert.equal(api.__count('ek.signByQr'), 0);
});

test('二课未到窗口不执行；不需要签退则不安排签退', async () => {
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [ekItem()] } },
      getActivityDetail: ekDetail({}, { IsNeedSignOutText: '否' }),
    },
  });
  const { engine } = makeEngine({
    api,
    clock: makeClock(BJ(2026, 9, 21, 17, 0)),
    config: { ek: { keywords: ['歌手'] } },
  });
  const out = await engine.runOnce();
  assert.equal(out.results.some((r) => r.action === 'signIn' && r.status !== 'not-yet'), false);
  assert.equal(out.results.some((r) => r.action === 'signOut'), false);
  assert.equal(api.__count('ek.signByQr'), 0);
});

// ───────────────────────────── 俱乐部 ─────────────────────────────

function clubItem(over = {}) {
  return {
    clubActivityId: 1001,
    activityName: '篮球俱乐部',
    optionStatus: '6',
    startTime: '18:00',
    endTime: '19:00',
    nextMmdd: '2026-09-21',
    ...over,
  };
}

test('俱乐部按关键词+上限报名，已报名任务跳过', async () => {
  const api = makeApi({
    club: {
      myActivityList: {
        code: 10000,
        response: { list: [clubItem({ clubActivityId: 2001, activityName: '已报名活动', optionStatus: '1', nextMmdd: '2026-09-21' })] },
      },
      activityList: {
        code: 10000,
        response: {
          list: [
            clubItem({ clubActivityId: 3001, activityName: '篮球A' }),
            clubItem({ clubActivityId: 3002, activityName: '篮球B' }),
            clubItem({ clubActivityId: 3003, activityName: '羽毛球' }),
          ],
        },
      },
    },
  });
  const { engine } = makeEngine({ api, clock: makeClock(BJ(2026, 9, 21, 8, 0)), config: { club: { keywords: ['篮球'], joinLimit: 1 } } });
  const out = await engine.runOnce();
  const joins = out.results.filter((r) => r.action === 'join' && r.status === 'success');
  assert.equal(joins.length, 1, '上限 1 只报名 1 条');
  assert.equal(joins[0].activityId, '3001');
  assert.equal(api.__count('club.joinActivity'), 1);
});

test('俱乐部成功码 1000 与 10000 都算成功', async () => {
  const api = makeApi({
    club: {
      activityList: { code: 10000, response: { list: [clubItem({ clubActivityId: 3001 })] } },
      joinActivity: { code: 1000 },
    },
  });
  const { engine } = makeEngine({ api, config: { club: { keywords: ['篮球'], joinLimit: 1 } } });
  const out = await engine.runOnce();
  assert.equal(out.results.find((x) => x.action === 'join').status, 'success');
});

test('俱乐部签到窗口 [start,start+5min]、签退窗口 [end-5min,end]；坐标取 getSignInTf', async () => {
  const myList = { code: 10000, response: { list: [clubItem({ optionStatus: '1' })] } };
  // 签退用例前提：官方已签到
  const myListSignedIn = {
    code: 10000,
    response: { list: [clubItem({ optionStatus: '1', signInStatus: '1' })] },
  };
  const run = async (clockMs, listOverride) => {
    const api = makeApi({
      club: {
        myActivityList: listOverride || myList,
        currentSignTask: {
          code: 10000,
          response: { clubActivityId: 1001, latitude: '30.5', longitude: '104.1' },
        },
      },
    });
    const { engine } = makeEngine({ api, clock: makeClock(clockMs), config: { club: { keywords: ['篮球'] } } });
    const out = await engine.runOnce();
    return { api, out };
  };

  {
    const { api, out } = await run(BJ(2026, 9, 21, 18, 3));
    assert.equal(out.results.find((x) => x.action === 'signIn').status, 'success');
    const call = api.__calls.find((c) => c.name === 'club.signInOrSignBack');
    assert.equal(call.payload.signType, '1');
    assert.equal(call.payload.latitude, '30.5');
    assert.equal(call.payload.longitude, '104.1');
  }
  {
    const { api, out } = await run(BJ(2026, 9, 21, 18, 10)); // 已过签到窗口
    assert.equal(api.__count('club.signInOrSignBack'), 0);
    assert.equal(out.results.find((x) => x.action === 'signIn').status, 'expired');
  }
  {
    const { api, out } = await run(BJ(2026, 9, 21, 18, 57), myListSignedIn); // 签退窗口 [18:55,19:00]
    assert.equal(out.results.find((x) => x.action === 'signOut').status, 'success');
    assert.equal(api.__calls.find((c) => c.name === 'club.signInOrSignBack').payload.signType, '2');
  }
});

test('俱乐部缺坐标 → waiting-material need-coords，不提交', async () => {
  const api = makeApi({
    club: {
      myActivityList: {
        code: 10000,
        response: { list: [clubItem({ optionStatus: '1', latitude: '', longitude: '' })] },
      },
      currentSignTask: { code: 10000, response: null },
    },
  });
  const { engine } = makeEngine({ api, clock: makeClock(BJ(2026, 9, 21, 18, 3)), config: { club: { keywords: ['篮球'] } } });
  const out = await engine.runOnce();
  const r = out.results.find((x) => x.action === 'signIn');
  assert.equal(r.status, 'waiting-material');
  assert.equal(r.reason, 'need-coords');
  assert.equal(api.__count('club.signInOrSignBack'), 0);
});

// ───────────────────────────── 校园跑 ─────────────────────────────

test('校园跑到点执行一次，code=10000 记成功，当天去重', async () => {
  const api = makeApi();
  const clock = makeClock(BJ(2026, 9, 21, 6, 31));
  const { engine } = makeEngine({
    api,
    clock,
    config: { accountId: 'acc-1', unirun: { runAt: '06:30', windowMinutes: 30, runDistance: 3000, runTime: 30 } },
  });
  const first = await engine.runOnce();
  assert.equal(first.results.find((x) => x.module === 'unirun').status, 'success');
  assert.equal(api.__count('unirun.autoRun'), 1);
  const payload = api.__calls.find((c) => c.name === 'unirun.autoRun').payload;
  assert.equal(payload.phone, EK_ACCOUNT.phone);
  assert.equal(payload.runDistance, 3000);
  assert.equal(payload.schoolSiteIndex, 1);

  clock.advance(60 * 1000);
  const second = await engine.runOnce();
  assert.equal(api.__count('unirun.autoRun'), 1, '同一天不得重复上报');
  assert.equal(second.results.some((x) => x.module === 'unirun' && x.status === 'success'), false);
});

test('校园跑 code!=10000 → failed（严格判 10000）', async () => {
  const api = makeApi({ unirun: { autoRun: { code: 10001, msg: 'not_login' } } });
  const { engine } = makeEngine({
    api,
    clock: makeClock(BJ(2026, 9, 21, 6, 31)),
    config: { unirun: { runAt: '06:30' } },
  });
  const out = await engine.runOnce();
  assert.equal(out.results.find((x) => x.module === 'unirun').status, 'failed');
});

test('校园跑未到时刻不执行；超过窗口记 expired', async () => {
  {
    const api = makeApi();
    const { engine } = makeEngine({ api, clock: makeClock(BJ(2026, 9, 21, 6, 0)), config: { unirun: { runAt: '06:30' } } });
    const out = await engine.runOnce();
    assert.equal(api.__count('unirun.autoRun'), 0);
    assert.equal(out.results.find((x) => x.module === 'unirun').status, 'not-yet');
  }
  {
    const api = makeApi();
    const { engine } = makeEngine({ api, clock: makeClock(BJ(2026, 9, 21, 8, 0)), config: { unirun: { runAt: '06:30', windowMinutes: 30 } } });
    const out = await engine.runOnce();
    assert.equal(api.__count('unirun.autoRun'), 0);
    assert.equal(out.results.find((x) => x.module === 'unirun').status, 'expired');
  }
});

test('二课 SignWay=1：延迟 gate 前不拉图库，到 gate 才拉一次', async () => {
  let boundCalls = 0;
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [ekItem()] } },
      getActivityDetail: ekDetail(),
      activityBoundImages: () => {
        boundCalls += 1;
        return { items: [{ id: 'img1', file_url: 'https://x/1.png', created_at: '2026-09-21 18:01:00' }] };
      },
      signByQr: { errcode: 0 },
    },
  });
  const clock = makeClock(BJ(2026, 9, 21, 18, 0)); // 窗口开始
  const { engine } = makeEngine({
    api,
    clock,
    decodeQr: async () => 'lbUUh-abc',
    config: { ek: { keywords: ['歌手'], qrDelayMinutes: 2 } },
  });

  const first = await engine.runOnce(); // 18:00 → gate=18:02，尚未到
  assert.equal(boundCalls, 0, 'gate 前不得拉图库');
  assert.equal(first.results.find((r) => r.action === 'signIn').status, 'not-yet');

  clock.advance(60 * 1000); // 18:01
  await engine.runOnce();
  assert.equal(boundCalls, 0);

  clock.advance(60 * 1000); // 18:02 → 到 gate
  const third = await engine.runOnce();
  assert.equal(boundCalls, 1, '到 gate 才拉一次');
  assert.equal(third.results.find((r) => r.action === 'signIn').status, 'success');
});

test('二课图库为空后按 retry 间隔重试，最多 maxAttempts 次', async () => {
  let boundCalls = 0;
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [ekItem()] } },
      getActivityDetail: ekDetail(),
      activityBoundImages: () => {
        boundCalls += 1;
        return { items: [] };
      },
    },
  });
  const clock = makeClock(BJ(2026, 9, 21, 18, 5));
  const { engine } = makeEngine({
    api,
    clock,
    config: { ek: { keywords: ['歌手'], qrDelayMinutes: 0, qrRetryMinutes: 2, qrMaxAttempts: 3 } },
  });

  await engine.runOnce(); // 第 1 次
  assert.equal(boundCalls, 1);
  clock.advance(30 * 1000); // 30s，未到 retry
  await engine.runOnce();
  assert.equal(boundCalls, 1, 'retry 间隔内不重复拉');

  clock.advance(90 * 1000); // 累计 2min
  await engine.runOnce();
  assert.equal(boundCalls, 2);

  clock.advance(2 * 60 * 1000);
  const out = await engine.runOnce();
  assert.equal(boundCalls, 3);
  assert.equal(out.results.find((r) => r.action === 'signIn').reason, 'qr-attempts-exhausted');

  clock.advance(10 * 60 * 1000);
  await engine.runOnce();
  assert.equal(boundCalls, 3, '超过 maxAttempts 不再拉');
});

test('二维码延迟超过官方窗口 → 明确提示 delay-exceeds-window，不静默永不触发', async () => {
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [ekItem()] } },
      getActivityDetail: ekDetail({}, { ActivityQDDate: '2026-09-21 18:00:00 至 2026-09-21 18:01:00' }),
      activityBoundImages: { items: [] },
    },
  });
  const { engine } = makeEngine({
    api,
    clock: makeClock(BJ(2026, 9, 21, 18, 0)),
    config: { ek: { keywords: ['歌手'], qrDelayMinutes: 5 } },
  });
  const out = await engine.runOnce();
  const r = out.results.find((x) => x.action === 'signIn');
  assert.equal(r.reason, 'delay-exceeds-window');
});

test('metadata=签到 但 suffix=QT → 冲突拒绝（不得当签到码使用）', async () => {
  let signCalled = 0;
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [ekItem()] } },
      getActivityDetail: ekDetail(),
      activityBoundImages: {
        items: [
          {
            id: 'conflict-1',
            file_url: 'https://x/c1.png',
            created_at: '2026-09-21 18:01:00',
            bind: { remark: '签到' },
          },
        ],
      },
      signByQr: () => {
        signCalled += 1;
        return { errcode: 0 };
      },
    },
  });
  const { engine } = makeEngine({
    api,
    clock: makeClock(BJ(2026, 9, 21, 18, 5)),
    decodeQr: async () => 'lbUUh-abc-QT', // 实为签退码
    config: { ek: { keywords: ['歌手'], qrDelayMinutes: 0 } },
  });
  const out = await engine.runOnce();
  assert.equal(signCalled, 0);
  assert.equal(out.results.find((r) => r.action === 'signIn').status, 'waiting-material');
});

test('签退不得复用签到已用图片（跨阶段排除）', async () => {
  const storage = baseStorage();
  const shared = {
    id: 'img-shared',
    file_url: 'https://x/s.png',
    created_at: '2026-09-21 18:01:00',
    bind: { remark: '签到' },
  };
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [ekItem()] } },
      getActivityDetail: ekDetail(),
      activityBoundImages: { items: [shared] },
      signByQr: { errcode: 0 },
    },
  });
  const clock = makeClock(BJ(2026, 9, 21, 18, 5));
  const { engine } = makeEngine({
    api,
    storage,
    clock,
    decodeQr: async () => 'lbUUh-abc-QD',
    config: { ek: { keywords: ['歌手'], qrDelayMinutes: 0, qrRetryMinutes: 1, qrMaxAttempts: 5 } },
  });
  const first = await engine.runOnce();
  assert.equal(first.results.find((r) => r.action === 'signIn').status, 'success');

  // 晚上签退窗口：同一张「签到」图不得被用于签退
  clock.set(BJ(2026, 9, 21, 20, 5));
  const second = await engine.runOnce();
  const out = second.results.find((r) => r.action === 'signOut');
  assert.equal(out.status, 'waiting-material');
  assert.equal(api.__count('ek.signByQr'), 1, '只应有一次签到提交');
});

test('opaque lbUUh 无元数据/无上传时间 → 不接受（不假定阶段）', async () => {
  let signCalled = 0;
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [ekItem()] } },
      getActivityDetail: ekDetail(),
      activityBoundImages: { items: [{ id: 'opaque-1', file_url: 'https://x/o.png' }] },
      signByQr: () => {
        signCalled += 1;
        return { errcode: 0 };
      },
    },
  });
  const { engine } = makeEngine({
    api,
    clock: makeClock(BJ(2026, 9, 21, 18, 5)),
    decodeQr: async () => 'lbUUh-abc',
    config: { ek: { keywords: ['歌手'], qrDelayMinutes: 0 } },
  });
  const out = await engine.runOnce();
  assert.equal(signCalled, 0);
  assert.equal(out.results.find((r) => r.action === 'signIn').status, 'waiting-material');
});

test('opaque lbUUh 但上传时间在窗口内 → 可接受（延迟上传场景）', async () => {
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [ekItem()] } },
      getActivityDetail: ekDetail(),
      activityBoundImages: {
        items: [{ id: 'new-1', file_url: 'https://x/n.png', created_at: '2026-09-21 18:03:00' }],
      },
      signByQr: { errcode: 0 },
    },
  });
  const { engine } = makeEngine({
    api,
    clock: makeClock(BJ(2026, 9, 21, 18, 5)),
    decodeQr: async () => 'lbUUh-abc',
    config: { ek: { keywords: ['歌手'], qrDelayMinutes: 0 } },
  });
  const out = await engine.runOnce();
  assert.equal(out.results.find((r) => r.action === 'signIn').status, 'success');
});

test('watchedEk：报名后活动移出列表页，仍按关注 id 拉详情并签到/签退', async () => {
  const storage = baseStorage();
  let round = 0;
  const api = makeApi({
    ek: {
      // tick1 活动在第 1 页；tick2 起列表为空（活动被翻页/隐藏）
      getActivitiesList: () => (round === 0 ? { List: { Items: [ekItem()] } } : { List: { Items: [] } }),
      getActivityDetail: () => (round === 0 ? ekDetail({}, {}, null) : ekDetail()),
      applyActivity: { errcode: 0 },
      activityBoundImages: {
        items: [{ id: 'qd-1', file_url: 'https://x/qd.png', created_at: '2026-09-21 18:01:00', bind: { remark: '签到' } }],
      },
      signByQr: { errcode: 0 },
    },
  });
  const clock = makeClock(BJ(2026, 9, 21, 8, 0));
  const { engine } = makeEngine({
    api,
    storage,
    clock,
    decodeQr: async () => 'lbUUh-abc-QD',
    config: { ek: { keywords: ['歌手'], qrDelayMinutes: 0 } },
  });

  // tick1：报名成功（详情 ApplyInfo 为空 → joinable）
  const apiApply = makeApi;
  const first = await engine.runOnce();
  round = 1;
  assert.equal(first.results.find((r) => r.action === 'apply').status, 'success');
  // 报名成功写入 watch
  let st = JSON.parse(storage.get('auto3ct:state'));
  const watchedIds = Object.keys((st.watchedEk && st.watchedEk['20230001']) || {});
  assert.ok(watchedIds.includes('act-1'), '报名成功后必须写入 watchedEk');

  // tick2（晚 18:05，列表已空）：**用同一 storage 新建 engine**（模拟进程重启），
  // 必须仍从持久化的 watchedEk 读到 detail 并签到
  clock.set(BJ(2026, 9, 21, 18, 5));
  const restarted = makeEngine({
    api,
    storage, // 复用同一份持久化存储
    clock,
    decodeQr: async () => 'lbUUh-abc-QD',
    config: { ek: { keywords: ['歌手'], qrDelayMinutes: 0 } },
  });
  const second = await restarted.engine.runOnce();
  const signIn = second.results.find((r) => r.action === 'signIn');
  assert.ok(signIn, '列表为空 + 进程重启后仍应通过持久化 watchedEk 处理签到');
  assert.equal(signIn.status, 'success', 'watch 跟踪应能完成签到');
});

test('二课报名严格受 StuETime 约束：窗外不提交，缺失等待', async () => {
  // 报名窗口在明天 → 今天不可报名
  const future = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [ekItem()] } },
      getActivityDetail: ekDetail({}, { StuETime: '2026-09-25 09:00:00 至 2026-09-26 18:00:00' }, null),
    },
  });
  const clock = makeClock(BJ(2026, 9, 21, 8, 0));
  const a = makeEngine({ api: future, clock, config: { ek: { keywords: ['歌手'] } } });
  const out1 = await a.engine.runOnce();
  assert.equal(out1.results.find((r) => r.action === 'apply').status, 'not-yet');
  assert.equal(future.__count('ek.applyActivity'), 0);

  // 报名窗口缺失 → waiting-material，不提交
  const missing = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [ekItem()] } },
      getActivityDetail: ekDetail({}, { StuETime: '' }, null),
    },
  });
  const b = makeEngine({ api: missing, clock: makeClock(BJ(2026, 9, 21, 8, 0)), config: { ek: { keywords: ['歌手'] } } });
  const out2 = await b.engine.runOnce();
  assert.equal(out2.results.find((r) => r.action === 'apply').status, 'waiting-material');
  assert.equal(missing.__count('ek.applyActivity'), 0);
});

test('校区 id 显式配置但不存在 → waiting campus-not-found，不回落首项', async () => {
  const api = makeApi();
  const { engine } = makeEngine({
    api,
    clock: makeClock(BJ(2026, 9, 21, 6, 31)),
    config: { campusId: 'not-exist', unirun: { runAt: '06:30' } },
  });
  const out = await engine.runOnce();
  const r = out.results.find((x) => x.module === 'unirun');
  assert.equal(r.status, 'waiting-material');
  assert.equal(r.reason, 'campus-not-found');
  assert.equal(api.__count('unirun.autoRun'), 0);
});

test('数值配置非法 → failed invalid-run-params，不用默认值掩盖', async () => {
  const api = makeApi();
  const { engine } = makeEngine({
    api,
    clock: makeClock(BJ(2026, 9, 21, 6, 31)),
    config: { unirun: { runAt: '06:30', runDistance: -5, runTime: 30 } },
  });
  const out = await engine.runOnce();
  assert.equal(out.results.find((x) => x.module === 'unirun').reason, 'invalid-run-params');
  assert.equal(api.__count('unirun.autoRun'), 0);
});

test('解码耗时越过窗口截止 → 不提交（deadline 实际生效）', async () => {
  const clock = makeClock(BJ(2026, 9, 21, 18, 29)); // 窗口 18:00-18:30，剩 1 分钟
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [ekItem()] } },
      getActivityDetail: ekDetail({}, { ActivityQDDate: '2026-09-21 18:00:00 至 2026-09-21 18:30:00' }),
      activityBoundImages: {
        items: [{ id: 'qd-late', file_url: 'https://x/qd.png', created_at: '2026-09-21 18:01:00' }],
      },
      signByQr: { errcode: 0 },
    },
  });
  const { engine } = makeEngine({
    api,
    clock,
    decodeQr: async () => {
      clock.advance(5 * 60 * 1000); // 解码期间越过 18:30 截止
      return 'lbUUh-abc-QD';
    },
    config: { ek: { keywords: ['歌手'], qrDelayMinutes: 0 } },
  });
  const out = await engine.runOnce();
  assert.equal(api.__count('ek.signByQr'), 0, '越过截止时间不得提交');
  const r = out.results.find((x) => x.action === 'signIn');
  assert.ok(['skipped', 'expired', 'waiting-material'].includes(r.status));
});

test('模块默认关闭：未启用任何模块时 runOnce 不产生业务调用', async () => {
  const api = makeApi({
    ek: { getActivitiesList: { List: { Items: [ekItem()] } }, getActivityDetail: ekDetail() },
    club: { activityList: { code: 10000, response: { list: [clubItem()] } } },
  });
  const storage = baseStorage();
  const { engine } = makeEngine({ api, storage, clock: makeClock(BJ(2026, 9, 21, 6, 31)) });
  const out = await engine.runOnce();
  assert.equal(out.results.length, 0, '三模块默认关闭时不应产生任何动作行');
  assert.equal(
    api.__calls.filter((c) => /applyActivity|signByQr|joinActivity|signInOrSignBack|autoRun|getActivitiesList|activityList/.test(c.name)).length,
    0,
  );
});

// ───────────────────────────── 失败语义 / 安全 ─────────────────────────────

test('提交前持久化 inflight；异常记 unknown 且下一轮不盲重试', async () => {
  const storage = baseStorage();
  let inflightSeen = null;
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [ekItem()] } },
      getActivityDetail: ekDetail({}, {}, null),
      applyActivity: async () => {
        const st = JSON.parse(storage.get('auto3ct:state') || '{}');
        inflightSeen = Object.keys(st.inflight || {});
        throw new Error('network reset');
      },
    },
  });
  const { engine } = makeEngine({ api, storage, clock: makeClock(BJ(2026, 9, 21, 8, 0)), config: { ek: { keywords: ['歌手'] } } });
  const out = await engine.runOnce();
  assert.equal(out.results.find((x) => x.action === 'apply').status, 'unknown');
  assert.ok(inflightSeen.some((k) => k.endsWith('|apply')), '提交前应已写入 inflight');
  assert.equal(api.__count('ek.applyActivity'), 1);

  const again = await engine.runOnce();
  assert.equal(api.__count('ek.applyActivity'), 1, '未知结果不盲重试');
  assert.equal(again.results.find((x) => x.action === 'apply').status, 'blocked');
});

test('dry-run 不产生写调用，且状态为 dry-run', async () => {
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [ekItem()] } },
      getActivityDetail: ekDetail({}, {}, null),
      activityBoundImages: {
        items: [{ id: 'i', file_url: 'https://x/1.png', created_at: '2026-09-21 18:01:00' }],
      },
    },
  });
  const { engine } = makeEngine({
    api,
    clock: makeClock(BJ(2026, 9, 21, 18, 5)),
    decodeQr: async () => 'lbUUh-abc',
    config: { dryRun: true, ek: { keywords: ['歌手'], apply: true } },
  });
  const out = await engine.runOnce();
  assert.ok(out.results.some((x) => x.status === 'dry-run'));
  const write = api.__calls.filter((c) => /applyActivity|signByQr|joinActivity|signInOrSignBack|autoRun/.test(c.name));
  assert.equal(write.length, 0);
});

test('结果与日志不含 token / 密码', async () => {
  const api = makeApi({
    ek: { getActivitiesList: { List: { Items: [ekItem()] } }, getActivityDetail: ekDetail() },
  });
  const { engine, logs } = makeEngine({ api, clock: makeClock(BJ(2026, 9, 21, 18, 5)), config: { ek: { keywords: ['歌手'] } } });
  const out = await engine.runOnce();
  const dump = JSON.stringify(out) + JSON.stringify(logs);
  assert.equal(dump.includes('tok'), false);
  assert.equal(dump.includes('rtok'), false);
  assert.equal(dump.includes('"pw"'), false);
  assert.equal(dump.includes(EK_ACCOUNT.phone), false, '日志/结果不出现完整手机号');
});

test('storage.set 抛异常 → 写接口 call=0 且 blocked storage-error（fail-closed）', async () => {
  const inner = baseStorage();
  let stateWrites = 0;
  const storage = {
    get: (k) => inner.get(k),
    set: (k, v) => {
      if (k === 'auto3ct:state') {
        stateWrites += 1;
        throw new Error('quota exceeded');
      }
      inner.set(k, v);
    },
    remove: (k) => inner.remove(k),
  };
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [ekItem()] } },
      getActivityDetail: ekDetail({}, {}, null),
    },
  });
  const { engine } = makeEngine({
    api,
    storage,
    clock: makeClock(BJ(2026, 9, 21, 8, 0)),
    config: { ek: { keywords: ['歌手'] } },
  });
  const out = await engine.runOnce();
  assert.equal(api.__count('ek.applyActivity'), 0, 'inflight 落盘失败时绝不能提交');
  const r = out.results.find((x) => x.action === 'apply');
  assert.equal(r.status, 'blocked');
  assert.equal(r.reason, 'storage-error');
  assert.ok(stateWrites >= 1);
});

test('去重状态损坏 → 禁止自动写并明确 state-corrupt', async () => {
  const storage = baseStorage({ 'auto3ct:state': '{not-json' });
  const api = makeApi({
    ek: { getActivitiesList: { List: { Items: [ekItem()] } }, getActivityDetail: ekDetail() },
  });
  const { engine } = makeEngine({
    api,
    storage,
    clock: makeClock(BJ(2026, 9, 21, 8, 0)),
    config: { ek: { keywords: ['歌手'] } },
  });
  const out = await engine.runOnce();
  assert.equal(out.stateCorrupt, true);
  assert.ok(out.results.some((r) => r.reason === 'state-corrupt'));
  assert.equal(
    api.__calls.filter((c) => /applyActivity|signByQr|joinActivity|signInOrSignBack|autoRun/.test(c.name)).length,
    0,
  );
});

test('业务失败跨两轮：call 只 1 次，第二轮 locked-failed', async () => {
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [ekItem()] } },
      getActivityDetail: ekDetail({}, {}, null),
      applyActivity: { errcode: 7, errmsg: '不满足报名条件' },
    },
  });
  const { engine } = makeEngine({
    api,
    clock: makeClock(BJ(2026, 9, 21, 8, 0)),
    config: { ek: { keywords: ['歌手'] } },
  });
  const first = await engine.runOnce();
  assert.equal(first.results.find((r) => r.action === 'apply').status, 'failed');
  const second = await engine.runOnce();
  const r2 = second.results.find((x) => x.action === 'apply');
  assert.equal(r2.status, 'blocked');
  assert.equal(r2.reason, 'locked-failed');
  assert.equal(api.__count('ek.applyActivity'), 1, '失败终态当日不盲重试');
});

test('malformed 响应 → unknown，跨两轮 call 只 1 次', async () => {
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [ekItem()] } },
      getActivityDetail: ekDetail({}, {}, null),
      applyActivity: { ok: true }, // 无 errcode → unknown
    },
  });
  const { engine } = makeEngine({
    api,
    clock: makeClock(BJ(2026, 9, 21, 8, 0)),
    config: { ek: { keywords: ['歌手'] } },
  });
  const first = await engine.runOnce();
  assert.equal(first.results.find((r) => r.action === 'apply').status, 'unknown');
  const second = await engine.runOnce();
  assert.equal(second.results.find((r) => r.action === 'apply').reason, 'locked-unknown');
  assert.equal(api.__count('ek.applyActivity'), 1);
});

test('stop 后不再提交后续动作', async () => {
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [ekItem()] } },
      getActivityDetail: ekDetail(),
      applyActivity: { errcode: 0 },
    },
  });
  const { engine } = makeEngine({
    api,
    clock: makeClock(BJ(2026, 9, 21, 8, 0)),
    config: { ek: { keywords: ['歌手'] } },
  });
  engine.stop();
  await engine.runOnce();
  assert.equal(api.__count('ek.applyActivity'), 0);
});

test('并发 runOnce：第二个返回 busy，不重复提交', async () => {
  let resolveApply;
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [ekItem()] } },
      getActivityDetail: ekDetail({}, {}, null),
      applyActivity: () =>
        new Promise((resolve) => {
          resolveApply = () => resolve({ errcode: 0 });
        }),
    },
  });
  const { engine } = makeEngine({
    api,
    clock: makeClock(BJ(2026, 9, 21, 8, 0)),
    config: { ek: { keywords: ['歌手'] } },
  });
  const running = engine.runOnce();
  // 等第一个 run 推进到 applyActivity 挂起（有限次微任务让路）
  for (let i = 0; i < 50 && !resolveApply; i += 1) {
    await new Promise((r) => setTimeout(r, 1));
  }
  assert.equal(typeof resolveApply, 'function', '第一个 run 应已挂起在 applyActivity');
  const second = await engine.runOnce();
  assert.equal(second.busy, true);
  resolveApply();
  await running;
  assert.equal(api.__count('ek.applyActivity'), 1);
});

test('俱乐部每日报名上限跨 tick 累计（不会越报越多）', async () => {
  const api = makeApi({
    club: {
      activityList: {
        code: 10000,
        response: {
          list: [
            clubItem({ clubActivityId: 3001, activityName: '篮球A' }),
            clubItem({ clubActivityId: 3002, activityName: '篮球B' }),
            clubItem({ clubActivityId: 3003, activityName: '篮球C' }),
          ],
        },
      },
    },
  });
  const clock = makeClock(BJ(2026, 9, 21, 8, 0));
  const { engine } = makeEngine({
    api,
    clock,
    config: { club: { keywords: ['篮球'], dailyJoinLimit: 1 } },
  });
  const first = await engine.runOnce();
  assert.equal(first.results.filter((r) => r.action === 'join' && r.status === 'success').length, 1);
  clock.advance(5 * 60 * 1000);
  const second = await engine.runOnce();
  assert.equal(second.results.filter((r) => r.action === 'join' && r.status === 'success').length, 0);
  assert.equal(api.__count('club.joinActivity'), 1, '跨 tick 仍受每日上限约束');
});

test('校园跑与俱乐部的账号必须同一个选中账号', async () => {
  const storage = baseStorage({
    ct_unirun_accounts_v1: JSON.stringify({
      selectedId: 'acc-2',
      items: [
        { id: 'acc-1', phone: '13800000001', password: 'pw1', remark: 'A', updatedAt: 1 },
        { id: 'acc-2', phone: '13900000002', password: 'pw2', remark: 'B', updatedAt: 2 },
      ],
    }),
  });
  const api = makeApi();
  const { engine } = makeEngine({
    api,
    storage,
    clock: makeClock(BJ(2026, 9, 21, 6, 31)),
    config: { unirun: { runAt: '06:30' } },
  });
  await engine.runOnce();
  const payload = api.__calls.find((c) => c.name === 'unirun.autoRun').payload;
  assert.equal(payload.phone, '13900000002', '应使用 selectedId 指向的账号');
});

test('未配置二课会话/校园跑账号时明确 waiting-material，不抛错', async () => {
  const api = makeApi();
  const storage = makeStorage({});
  const { engine } = makeEngine({
    api,
    storage,
    config: { ek: { enabled: true }, club: { enabled: true }, unirun: { enabled: true } },
  });
  const out = await engine.runOnce();
  assert.ok(out.results.some((r) => r.status === 'waiting-material'));
  assert.equal(api.__calls.filter((c) => /applyActivity|signByQr|autoRun|joinActivity/.test(c.name)).length, 0);
});

test('空关键词且未开启 allowAll → waiting need-keywords，不报名全校活动', async () => {
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [ekItem()] } },
      getActivityDetail: ekDetail(),
    },
    club: {
      activityList: { code: 10000, response: { list: [clubItem()] } },
    },
  });
  const { engine } = makeEngine({
    api,
    clock: makeClock(BJ(2026, 9, 21, 8, 0)),
    config: { ek: { enabled: true }, club: { enabled: true } },
  });
  const out = await engine.runOnce();
  assert.ok(out.results.some((r) => r.reason === 'need-keywords'));
  assert.equal(api.__count('ek.applyActivity'), 0);
  assert.equal(api.__count('club.joinActivity'), 0);
});
