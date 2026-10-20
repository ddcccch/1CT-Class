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
      signInOutByOthers: { errcode: 0 },
      activityBoundImages: { items: [] },
      imageUploadToSignActivity: { url: 'http://ek.cuit.edu.cn/official/photo.png' },
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
  if (config.ek && config.ek.backendGallery === undefined) {
    // 单测默认开启 3CT 社区图库，以覆盖图库解码/照片路径；
    // 生产默认关闭（无 3CT 登录时必然 401），该差异由专项用例锁定。
    config.ek.backendGallery = opts.gallery === false ? false : true;
  }
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
      // 签到场景：活动必须已报名（列表 status=1）
      getActivitiesList: { List: { Items: [ekItem({ ActivityStatus: '1' })] } },
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
      getActivitiesList: { List: { Items: [ekItem({ ActivityStatus: '1' })] } },
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
      getActivitiesList: { List: { Items: [ekItem({ ActivityStatus: '1' })] } },
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

test('二课 SignWay=2（拍照）默认自动提交：图库图片上传后走 StuSaveSignIn', async () => {
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [ekItem({ ActivityStatus: '1' })] } },
      getActivityDetail: ekDetail({}, { SignWay: 2, SignWayText: '拍照' }),
      activityBoundImages: { items: [{ id: 'p1', file_url: 'https://cdn.example/p1.jpg' }] },
      imageUploadToSignActivity: { url: 'http://ek.cuit.edu.cn/official/p1.jpg' },
    },
  });
  const { engine, storage } = makeEngine({
    api,
    clock: makeClock(BJ(2026, 9, 21, 18, 5)),
    config: { ek: { keywords: ['歌手'] } },
  });
  const out = await engine.runOnce();
  const r = out.results.find((x) => x.action === 'signIn');
  assert.equal(r.status, 'success', JSON.stringify(r));
  // 拍照路径不走二维码端点
  assert.equal(api.__count('ek.signByQr'), 0);
  assert.equal(api.__count('ek.imageUploadToSignActivity'), 1);
  const up = api.__calls.find((c) => c.name === 'ek.imageUploadToSignActivity');
  assert.equal(up.payload.activityId, 'act-1');
  assert.equal(up.payload.signId, 'sign-1');
  assert.equal(up.payload.sourceUrl, 'https://cdn.example/p1.jpg');
  const call = api.__calls.find((c) => c.name === 'ek.signInOutByOthers');
  assert.equal(String(call.payload.signModel.SignWay), '2');
  assert.equal(String(call.payload.signModel.Type), '1');
  assert.equal(call.payload.signModel.Photos.Imgs.length, 1);
  assert.equal(call.payload.signModel.Photos.Imgs[0].url, 'http://ek.cuit.edu.cn/official/p1.jpg');
  // 已用图片记账（签退不得复用同一张）
  const state = JSON.parse(storage.get('auto3ct:state') || '{}');
  assert.deepEqual(state.usedImages['act-1|signIn'], ['p1']);
});

test('二课 SignWay=3（定位+拍照）用活动详情中心点坐标提交', async () => {
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [ekItem({ ActivityStatus: '1' })] } },
      getActivityDetail: ekDetail(
        {},
        { SignWay: 3, SignWayText: '定位+拍照', latitude: 30.5791, longitude: 103.9908, CoverSock: 100 },
      ),
      // 图库为空 → 空照片提交（服务端不校验证据字段）
      activityBoundImages: { items: [] },
    },
  });
  const { engine } = makeEngine({
    api,
    clock: makeClock(BJ(2026, 9, 21, 18, 5)),
    config: { ek: { keywords: ['歌手'] } },
  });
  const out = await engine.runOnce();
  const r = out.results.find((x) => x.action === 'signIn');
  assert.equal(r.status, 'success', JSON.stringify(r));
  const call = api.__calls.find((c) => c.name === 'ek.signInOutByOthers');
  assert.equal(String(call.payload.signModel.SignWay), '3');
  assert.equal(Number(call.payload.signModel.Latitude), 30.5791);
  assert.equal(Number(call.payload.signModel.Longitude), 103.9908);
  assert.equal(call.payload.signModel.Photos.Imgs.length, 0);
});

test('二课 SignWay=2/3 关闭 photoSign → 退回 need-manual-sign-way，不提交', async () => {
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [ekItem({ ActivityStatus: '1' })] } },
      getActivityDetail: ekDetail({}, { SignWay: 3, SignWayText: '定位+拍照' }),
    },
  });
  const { engine } = makeEngine({
    api,
    clock: makeClock(BJ(2026, 9, 21, 18, 5)),
    config: { ek: { keywords: ['歌手'], photoSign: false } },
  });
  const out = await engine.runOnce();
  const r = out.results.find((x) => x.action === 'signIn');
  assert.equal(r.status, 'waiting-material');
  assert.equal(r.reason, 'photo-sign-disabled');
  assert.equal(api.__count('ek.signInOutByOthers'), 0);
});

test('二课 SignWay=4（现场验证码）活动默认不报名：skip-signway-4，不 apply 不签到', async () => {
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [ekItem({ ActivityStatus: '0' })] } },
      getActivityDetail: ekDetail({}, { SignWay: 4, SignWayText: '签到码' }),
    },
  });
  const { engine } = makeEngine({
    api,
    clock: makeClock(BJ(2026, 9, 21, 18, 5)),
    config: { ek: { keywords: ['歌手'] } },
  });
  const out = await engine.runOnce();
  const skipRow = out.results.find((x) => x.activityId === 'act-1' && x.reason === 'skip-signway-4');
  assert.ok(skipRow, '应产出 skip-signway-4 诊断行: ' + JSON.stringify(out.results));
  assert.equal(skipRow.status, 'skipped');
  assert.equal(api.__count('ek.applyActivity'), 0);
  assert.equal(api.__count('ek.signByQr'), 0);
  assert.equal(api.__count('ek.signInOutByOthers'), 0);
});

test('二课 SignWay=4 且 skipSignWay4=false → 照常报名，签到阶段仍等人工', async () => {
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [ekItem({ ActivityStatus: '0' })] } },
      getActivityDetail: ekDetail({}, { SignWay: 4, SignWayText: '签到码' }),
    },
  });
  const { engine } = makeEngine({
    api,
    clock: makeClock(BJ(2026, 9, 21, 8, 0)),
    config: { ek: { keywords: ['歌手'], skipSignWay4: false } },
  });
  const out = await engine.runOnce();
  const applied = out.results.find((x) => x.action === 'apply' && x.activityId === 'act-1');
  assert.equal(applied.status, 'success', JSON.stringify(applied));
  assert.equal(api.__count('ek.applyActivity'), 1);
});
test('二课 SignWay=3：图库无图 + 有兜底图 → 上传兜底图并作为 Photos 提交', async () => {
  const FALLBACK = 'data:image/jpeg;base64,AAAA';
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [ekItem({ ActivityStatus: '1' })] } },
      getActivityDetail: ekDetail(
        {},
        { SignWay: 3, SignWayText: '定位+拍照', latitude: 30.5791, longitude: 103.9908 },
      ),
      activityBoundImages: { items: [] },
      imageUploadToSignActivity: { url: 'http://ek.cuit.edu.cn/official/fallback.jpg' },
    },
  });
  const { engine } = makeEngine({
    api,
    clock: makeClock(BJ(2026, 9, 21, 18, 5)),
    config: { ek: { keywords: ['歌手'], fallbackPhoto: FALLBACK } },
  });
  const out = await engine.runOnce();
  const r = out.results.find((x) => x.action === 'signIn');
  assert.equal(r.status, 'success', JSON.stringify(r));
  const up = api.__calls.find((c) => c.name === 'ek.imageUploadToSignActivity');
  assert.ok(up, '应调用官方上传');
  assert.equal(up.payload.sourceUrl, FALLBACK, '上传源必须是兜底 data URL');
  const call = api.__calls.find((c) => c.name === 'ek.signInOutByOthers');
  assert.equal(call.payload.signModel.Photos.Imgs.length, 1);
  assert.equal(call.payload.signModel.Photos.Imgs[0].url, 'http://ek.cuit.edu.cn/official/fallback.jpg');
  assert.equal(r.photo, 'fallback', '结果行应标注来源 fallback');
});

test('二课 SignWay=2：图库无图且兜底图上传失败 → 仍按空照片提交（不失败）', async () => {
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [ekItem({ ActivityStatus: '1' })] } },
      getActivityDetail: ekDetail({}, { SignWay: 2, SignWayText: '拍照' }),
      activityBoundImages: { items: [] },
      imageUploadToSignActivity: { url: null },
    },
  });
  const { engine } = makeEngine({
    api,
    clock: makeClock(BJ(2026, 9, 21, 18, 5)),
    config: { ek: { keywords: ['歌手'], fallbackPhoto: 'data:image/jpeg;base64,AAAA' } },
  });
  const out = await engine.runOnce();
  const r = out.results.find((x) => x.action === 'signIn');
  assert.equal(r.status, 'success', JSON.stringify(r));
  const call = api.__calls.find((c) => c.name === 'ek.signInOutByOthers');
  assert.equal(call.payload.signModel.Photos.Imgs.length, 0);
  assert.equal(r.photo, 'none');
});

test('二课 SignWay=2：图库有图时优先用图库，不用兜底图', async () => {
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [ekItem({ ActivityStatus: '1' })] } },
      getActivityDetail: ekDetail({}, { SignWay: 2, SignWayText: '拍照' }),
      activityBoundImages: { items: [{ id: 'p1', file_url: 'https://cdn.example/p1.jpg' }] },
      imageUploadToSignActivity: { url: 'http://ek.cuit.edu.cn/official/p1.jpg' },
    },
  });
  const { engine } = makeEngine({
    api,
    clock: makeClock(BJ(2026, 9, 21, 18, 5)),
    config: { ek: { keywords: ['歌手'], fallbackPhoto: 'data:image/jpeg;base64,AAAA' } },
  });
  const out = await engine.runOnce();
  const r = out.results.find((x) => x.action === 'signIn');
  assert.equal(r.photo, 'gallery');
  const up = api.__calls.find((c) => c.name === 'ek.imageUploadToSignActivity');
  assert.equal(up.payload.sourceUrl, 'https://cdn.example/p1.jpg', '有图库图时不应使用兜底图');
});

test('校园跑随机时长：默认落在 [31,39]、整数、且不是 5 的倍数', async () => {
  const seen = new Set();
  for (let i = 0; i < 40; i += 1) {
    const g = makeWindowEngine({ random: () => (i % 20) / 20 });
    const out = await g.engine.runOnce();
    const r = out.results.find((x) => x.module === 'unirun');
    assert.equal(typeof r.runTime, 'number', '结果行必须带 runTime');
    assert.equal(Number.isInteger(r.runTime), true);
    assert.ok(r.runTime >= 31 && r.runTime <= 39, '时长越界：' + r.runTime);
    assert.notEqual(r.runTime % 5, 0, '时长不得是 5 的倍数：' + r.runTime);
    seen.add(r.runTime);
  }
  assert.ok(seen.size > 2, '随机应覆盖多个值：' + [...seen].sort((a, b) => a - b).join(','));
});

test('校园跑随机时长当天固定（持久化复用），显式配置优先', async () => {
  const clock = makeClock(BJ(2026, 9, 21, 6, 31));
  const storage = baseStorage();
  const g = makeWindowEngine({ clock, storage, random: () => 0.1 });
  const first = (await g.engine.runOnce()).results.find((x) => x.module === 'unirun');
  const state = JSON.parse(storage.dump()['auto3ct:state']);
  assert.equal(state.unirunTime['2026-09-21|acc-1'], first.runTime);

  // 换 random 重启引擎：仍复用当天已持久化的时长
  const seeded = JSON.parse(storage.dump()['auto3ct:state']);
  seeded.done = {};
  const storage2 = baseStorage({ 'auto3ct:state': JSON.stringify(seeded) });
  const g2 = makeWindowEngine({ clock, storage: storage2, random: () => 0.99 });
  const again = (await g2.engine.runOnce()).results.find((x) => x.module === 'unirun');
  assert.equal(again.runTime, first.runTime);

  const explicit = makeWindowEngine({
    config: { dryRun: false, unirun: { enabled: true, runTime: 25 } },
    random: () => 0.99,
  });
  const r = (await explicit.engine.runOnce()).results.find((x) => x.module === 'unirun');
  assert.equal(r.runTime, 25, '显式配置必须优先');
});
test('默认不请求 3CT 社区图库（生产默认关闭）：不调 activityBoundImages，直接用兜底/无码路径', async () => {
  // 扫码：默认关闭图库 → 走无码直签，且不请求第三方后端
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [ekItem({ ActivityStatus: '1' })] } },
      getActivityDetail: ekDetail(),
      activityBoundImages: { items: [{ id: 'i', file_url: 'https://x/1.png' }] },
    },
  });
  const { engine } = makeEngine({
    api,
    clock: makeClock(BJ(2026, 9, 21, 18, 5)),
    config: { ek: { keywords: ['歌手'], backendGallery: false } },
    decodeQr: async () => 'lbUUh-demo',
    gallery: false,
  });
  const out = await engine.runOnce();
  const r = out.results.find((x) => x.action === 'signIn');
  assert.equal(r.status, 'success', JSON.stringify(r));
  assert.equal(api.__count('ek.activityBoundImages'), 0, '默认不得请求 3CT 社区图库');
  assert.equal(api.__count('ek.signByQr'), 0);
  assert.equal(api.__count('ek.signInOutByOthers'), 1, '应走无码直签');
});

test('拍照签到：默认关闭图库时用内置兜底图（photo=fallback）', async () => {
  const FALLBACK = 'data:image/jpeg;base64,AAAA';
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [ekItem({ ActivityStatus: '1' })] } },
      getActivityDetail: ekDetail({}, { SignWay: 2, SignWayText: '拍照' }),
      activityBoundImages: { items: [{ id: 'p1', file_url: 'https://cdn.example/p1.jpg' }] },
      imageUploadToSignActivity: { url: 'http://ek.cuit.edu.cn/official/fallback.jpg' },
    },
  });
  const { engine } = makeEngine({
    api,
    clock: makeClock(BJ(2026, 9, 21, 18, 5)),
    config: { ek: { keywords: ['歌手'], fallbackPhoto: FALLBACK, backendGallery: false } },
    gallery: false,
  });
  const out = await engine.runOnce();
  const r = out.results.find((x) => x.action === 'signIn');
  assert.equal(r.status, 'success', JSON.stringify(r));
  assert.equal(api.__count('ek.activityBoundImages'), 0);
  assert.equal(r.photo, 'fallback');
  const up = api.__calls.find((c) => c.name === 'ek.imageUploadToSignActivity');
  assert.equal(up.payload.sourceUrl, FALLBACK);
});
test('二课 SignWay=2 图片上传失败 → 退回空照片仍提交（不假成功、不重试爆量）', async () => {
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [ekItem({ ActivityStatus: '1' })] } },
      getActivityDetail: ekDetail({}, { SignWay: 2, SignWayText: '拍照' }),
      activityBoundImages: { items: [{ id: 'p1', file_url: 'https://cdn.example/p1.jpg' }] },
      imageUploadToSignActivity: { url: null },
    },
  });
  const { engine } = makeEngine({
    api,
    clock: makeClock(BJ(2026, 9, 21, 18, 5)),
    config: { ek: { keywords: ['歌手'] } },
  });
  const out = await engine.runOnce();
  const r = out.results.find((x) => x.action === 'signIn');
  assert.equal(r.status, 'success', JSON.stringify(r));
  const call = api.__calls.find((c) => c.name === 'ek.signInOutByOthers');
  assert.equal(call.payload.signModel.Photos.Imgs.length, 0, '上传失败时应按空照片提交');
});

test('二课 SignWay=3：图片按阶段标注择优（签到不用「签退」图）', async () => {
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [ekItem({ ActivityStatus: '1' })] } },
      getActivityDetail: ekDetail(
        {},
        { SignWay: 3, SignWayText: '定位+拍照', latitude: 30.5791, longitude: 103.9908 },
      ),
      activityBoundImages: {
        items: [
          { id: 'p2', file_url: 'https://cdn.example/p2.jpg', bind: { remark: '签退' } },
          { id: 'p1', file_url: 'https://cdn.example/p1.jpg', bind: { remark: '签到' } },
        ],
      },
    },
  });
  const { engine, storage } = makeEngine({
    api,
    clock: makeClock(BJ(2026, 9, 21, 18, 5)),
    config: { ek: { keywords: ['歌手'] } },
  });
  await engine.runOnce();
  const call = api.__calls.find((c) => c.name === 'ek.signInOutByOthers');
  assert.equal(String(call.payload.signModel.Type), '1');
  assert.equal(call.payload.signModel.Photos.Imgs.length, 1);
  assert.ok(
    !String(call.payload.signModel.Photos.Imgs[0].url).includes('p2'),
    '签到不得使用标注为「签退」的图片',
  );
  const state = JSON.parse(storage.get('auto3ct:state') || '{}');
  assert.deepEqual(state.usedImages['act-1|signIn'], ['p1']);
});

test('二课无可用二维码（noQrFallback=false）→ waiting-material，不提交、不假成功', async () => {
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [ekItem({ ActivityStatus: '1' })] } },
      getActivityDetail: ekDetail(),
      activityBoundImages: { items: [{ id: 'i', file_url: 'https://x/1.png' }] },
    },
  });
  const { engine, storage } = makeEngine({
    api,
    clock: makeClock(BJ(2026, 9, 21, 18, 5)),
    decodeQr: async () => null,
    config: { ek: { keywords: ['歌手'], noQrFallback: false } },
  });
  const out = await engine.runOnce();
  const r = out.results.find((x) => x.action === 'signIn');
  assert.equal(r.status, 'waiting-material');
  assert.equal(r.reason, 'need-qr-or-manual');
  assert.equal(api.__count('ek.signByQr'), 0);
  assert.equal(api.__count('ek.signInOutByOthers'), 0);
  const state = JSON.parse(storage.get('auto3ct:state') || '{}');
  const done = state.done || {};
  assert.equal(done['2026-09-21|' + EK_LOGIN_NAME + '|ek|act-1|signIn'], undefined);
});

test('二课无可用二维码 → 默认走 StuSaveSignIn 无码直签兜底并成功', async () => {
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [ekItem({ ActivityStatus: '1' })] } },
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
  assert.equal(r.status, 'success');
  // 不再依赖志愿者二维码：不调 signByQr，改用 StuSaveSignIn
  assert.equal(api.__count('ek.signByQr'), 0);
  assert.equal(api.__count('ek.signInOutByOthers'), 1);
  const call = api.__calls.find((c) => c.name === 'ek.signInOutByOthers');
  assert.equal(String(call.payload.signModel.ActivityId), 'act-1');
  assert.equal(String(call.payload.signModel.Id), 'sign-1');
  assert.equal(String(call.payload.signModel.SignWay), '1');
  assert.equal(String(call.payload.signModel.Type), '1');
  const state = JSON.parse(storage.get('auto3ct:state') || '{}');
  assert.ok(state.done['2026-09-21|' + EK_LOGIN_NAME + '|ek|act-1|signIn']);
});

test('二课已签到（SignD=已签到）跳过，不重复提交', async () => {
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [ekItem({ ActivityStatus: '1' })] } },
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
      getActivitiesList: { List: { Items: [ekItem({ ActivityStatus: '1' })] } },
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

/**
 * 校园跑随机有效窗口（39~48 分钟）专用 harness。
 * 与 makeEngine 的差别：透传 opts.random，并把 unirun 默认启用。
 */
function makeWindowEngine(opts = {}) {
  const clock = opts.clock || makeClock(BJ(2026, 9, 21, 6, 31));
  const storage = opts.storage || baseStorage();
  const api = opts.api || makeApi();
  const logs = [];
  const config = Object.assign({ dryRun: false, unirun: { enabled: true } }, opts.config || {});
  const engine = A.createEngine({
    api,
    storage,
    clock,
    logger: { log: (m) => logs.push(String(m)) },
    config,
    random: opts.random,
  });
  return { engine, api, storage, clock, logs };
}

test('校园跑默认窗口：未配置 windowMinutes 时随机落在 [39,48] 且为整数', async () => {
  const seen = new Set();
  for (let i = 0; i < 40; i += 1) {
    // 覆盖 [0,1) 全域的确定性随机源
    const g = makeWindowEngine({ random: () => (i % 20) / 20 });
    const out = await g.engine.runOnce();
    const r = out.results.find((x) => x.module === 'unirun');
    assert.equal(typeof r.windowMinutes, 'number', '结果行必须带 windowMinutes');
    assert.equal(Number.isInteger(r.windowMinutes), true, '窗口必须是整数：' + r.windowMinutes);
    assert.ok(r.windowMinutes >= 39 && r.windowMinutes <= 48, '窗口越界：' + r.windowMinutes);
    seen.add(r.windowMinutes);
  }
  assert.ok(seen.size > 3, '随机应覆盖多个不同值，实际：' + [...seen].sort((a, b) => a - b).join(','));
  // 边界：random=0 → 下界 39；random→1 → 上界 48
  {
    const g = makeWindowEngine({ random: () => 0 });
    const r = (await g.engine.runOnce()).results.find((x) => x.module === 'unirun');
    assert.equal(r.windowMinutes, 39, 'random=0 应取下界 39');
  }
  {
    const g = makeWindowEngine({ random: () => 0.9999999 });
    const r = (await g.engine.runOnce()).results.find((x) => x.module === 'unirun');
    assert.equal(r.windowMinutes, 48, 'random→1 应取上界 48');
  }
});

test('校园跑随机窗口当天固定：跨 tick / 换引擎实例都不变', async () => {
  const clock = makeClock(BJ(2026, 9, 21, 6, 31));
  const storage = baseStorage();
  const first = makeWindowEngine({ clock, storage, random: () => 0.1 });
  const w1 = (await first.engine.runOnce()).results.find((x) => x.module === 'unirun').windowMinutes;
  assert.equal(typeof w1, 'number');

  // 同一个 storage、不同 random、不同引擎实例、时间推进 → 复用持久值
  clock.set(BJ(2026, 9, 21, 6, 45));
  const second = makeWindowEngine({ clock, storage, random: () => 0.99 });
  const w2 = (await second.engine.runOnce()).results.find((x) => x.module === 'unirun').windowMinutes;
  assert.equal(w2, w1, '同一天必须固定，实际 ' + w1 + ' vs ' + w2);

  // 随机值确实落到了 state.unirunWindow（引擎原样 state 格式）
  const state = JSON.parse(storage.dump()['auto3ct:state']);
  assert.ok(state.unirunWindow && typeof state.unirunWindow === 'object', 'state 必须有 unirunWindow');
  assert.equal(state.unirunWindow['2026-09-21|acc-1'], w1, JSON.stringify(state.unirunWindow));
});

test('校园跑随机窗口跨天重新随机', async () => {
  const clock = makeClock(BJ(2026, 9, 21, 6, 31));
  const storage = baseStorage();
  // 每天三次随机：先窗口、再里程、再时长。这里按调用顺序回放固定序列。
  const seq = [0, 0.5, 0.5, 0.9999, 0.5, 0.5];
  let i = 0;
  const g = makeWindowEngine({ clock, storage, random: () => seq[i++ % seq.length] });

  const day1 = (await g.engine.runOnce()).results.find((x) => x.module === 'unirun').windowMinutes;
  assert.equal(day1, 39, '第一天随机取下界');

  clock.set(BJ(2026, 9, 22, 6, 31)); // 跨天
  const day2 = (await g.engine.runOnce()).results.find((x) => x.module === 'unirun').windowMinutes;
  assert.equal(day2, 48, '跨天必须重新随机（取上界）');
  assert.notEqual(day2, day1, '跨天窗口应不同');

  const state = JSON.parse(storage.dump()['auto3ct:state']);
  assert.equal(state.unirunWindow['2026-09-21|acc-1'], 39);
  assert.equal(state.unirunWindow['2026-09-22|acc-1'], 48);
});

test('校园跑随机里程：默认落在 [1000,1099] 且末位非 0（带个位数）', async () => {
  const seen = new Set();
  for (let i = 0; i < 40; i += 1) {
    const g = makeWindowEngine({ random: () => (i % 20) / 20 });
    const out = await g.engine.runOnce();
    const r = out.results.find((x) => x.module === 'unirun');
    assert.equal(typeof r.distanceMeters, 'number', '结果行必须带 distanceMeters');
    assert.equal(Number.isInteger(r.distanceMeters), true, '里程必须是整数：' + r.distanceMeters);
    assert.ok(r.distanceMeters >= 1000 && r.distanceMeters <= 1099, '里程越界：' + r.distanceMeters);
    assert.notEqual(r.distanceMeters % 10, 0, '末位不得为 0（1000/1100 会被上游作废）：' + r.distanceMeters);
    seen.add(r.distanceMeters);
  }
  assert.ok(seen.size > 3, '随机应覆盖多个不同值，实际：' + [...seen].sort((a, b) => a - b).join(','));
});

test('校园跑随机里程当天固定：已持久化的值被复用（重启引擎也不变）', async () => {
  const clock = makeClock(BJ(2026, 9, 21, 6, 31));
  const storage = baseStorage();
  const g1 = makeWindowEngine({ clock, storage, random: () => 0.37 });
  const d1 = (await g1.engine.runOnce()).results.find((x) => x.module === 'unirun').distanceMeters;
  assert.equal(typeof d1, 'number');
  assert.equal(d1 % 10 === 0, false, '末位必须非 0：' + d1);

  // 1) 落盘确认
  const state = JSON.parse(storage.dump()['auto3ct:state']);
  assert.equal(state.unirunDistance['2026-09-21|acc-1'], d1, '当天里程必须持久化');

  // 2) 同一天第二次 tick 已经 done（不会再产生新的 unirun 行），但要确认没有重算出别的值：
  //    直接把 done 清空模拟「同一份 state、新进程」，随机源换成完全不同值，
  //    期望仍然复用当天已持久化的里程而不是重新随机。
  const seeded = JSON.parse(storage.dump()['auto3ct:state']);
  seeded.done = {};
  const storage2 = baseStorage({ 'auto3ct:state': JSON.stringify(seeded) });
  const g2 = makeWindowEngine({ clock, storage: storage2, random: () => 0.99 });
  const r2 = (await g2.engine.runOnce()).results.find((x) => x.module === 'unirun');
  assert.equal(r2.distanceMeters, d1, '重启引擎后仍必须复用当天已持久化的里程');
});

test('校园跑显式配置 runDistance 优先（兼容旧配置/手填）', async () => {
  const g = makeWindowEngine({
    config: { dryRun: false, unirun: { enabled: true, runDistance: 3000 } },
    random: () => 0.9999,
  });
  const r = (await g.engine.runOnce()).results.find((x) => x.module === 'unirun');
  assert.equal(r.distanceMeters, 3000, '显式配置必须优先');
  assert.equal(g.api.__calls.find((c) => c.name === 'unirun.autoRun').payload.runDistance, 3000);
});

test('校园跑随机里程范围非法（min>max）→ failed invalid-run-params，不提交', async () => {
  const g = makeWindowEngine({
    config: { dryRun: false, unirun: { enabled: true, runDistanceMin: 1100, runDistanceMax: 1000 } },
  });
  const out = await g.engine.runOnce();
  const r = out.results.find((x) => x.module === 'unirun');
  assert.equal(r.status, 'failed');
  assert.equal(r.reason, 'invalid-run-params');
  assert.equal(g.api.__count('unirun.autoRun'), 0);
});

test('校园跑显式配置 windowMinutes 优先（兼容旧配置/手填）', async () => {
  const g = makeWindowEngine({
    config: { dryRun: false, unirun: { enabled: true, windowMinutes: 30 } },
    random: () => 0.9999, // 若误用随机会是 48
  });
  const r = (await g.engine.runOnce()).results.find((x) => x.module === 'unirun');
  assert.equal(r.windowMinutes, 30, '显式配置必须优先');
  // 显式确定性值不写 state.unirunWindow
  const raw = g.storage.dump()['auto3ct:state'];
  if (raw) {
    const state = JSON.parse(raw);
    assert.ok(
      !state.unirunWindow || Object.keys(state.unirunWindow).length === 0,
      '显式配置不应写随机窗口缓存：' + JSON.stringify(state.unirunWindow),
    );
  }
});

test('校园跑随机范围非法（min>max）→ failed invalid-window，不提交', async () => {
  const g = makeWindowEngine({ config: { dryRun: false, unirun: { enabled: true, windowMinutesMin: 50, windowMinutesMax: 40 } } });
  const out = await g.engine.runOnce();
  const r = out.results.find((x) => x.module === 'unirun');
  assert.equal(r.status, 'failed');
  assert.equal(r.reason, 'invalid-window');
  assert.equal(g.api.__count('unirun.autoRun'), 0, '非法窗口不得提交');
});

test('校园跑随机范围非法（min/max 非数字或越界）→ failed invalid-window', async () => {
  for (const bad of [
    { windowMinutesMin: 'abc', windowMinutesMax: 48 },
    { windowMinutesMin: 39, windowMinutesMax: 9999 },
    { windowMinutesMin: 0, windowMinutesMax: 48 },
  ]) {
    const g = makeWindowEngine({ config: { dryRun: false, unirun: Object.assign({ enabled: true }, bad) } });
    const r = (await g.engine.runOnce()).results.find((x) => x.module === 'unirun');
    assert.equal(r.status, 'failed', JSON.stringify(bad));
    assert.equal(r.reason, 'invalid-window', JSON.stringify(bad));
    assert.equal(g.api.__count('unirun.autoRun'), 0);
  }
});

test('校园跑显式 windowMinutes 非法（0/超范围/非数字）→ failed invalid-window，不静默回落随机', async () => {
  for (const bad of [0, -5, 9999, 'abc']) {
    const g = makeWindowEngine({ config: { dryRun: false, unirun: { enabled: true, windowMinutes: bad } } });
    const r = (await g.engine.runOnce()).results.find((x) => x.module === 'unirun');
    assert.equal(r.status, 'failed', String(bad));
    assert.equal(r.reason, 'invalid-window', String(bad));
    assert.equal(g.api.__count('unirun.autoRun'), 0);
  }
});

test('校园跑随机窗口落盘失败 → failed storage-error，本轮不提交', async () => {
  const storage = baseStorage();
  const inner = storage.set;
  // 只在「把随机窗口写进 state」这一次写入上抛错（其它 state 写入照常）
  storage.set = (key, value) => {
    const text = String(value);
    if (key === 'auto3ct:state' && /"unirunWindow":\{"/.test(text)) {
      throw new Error('disk full');
    }
    inner(key, value);
  };
  const g = makeWindowEngine({ storage, random: () => 0.5 });
  const out = await g.engine.runOnce();
  const r = out.results.find((x) => x.module === 'unirun');
  assert.equal(r.status, 'failed');
  assert.equal(r.reason, 'storage-error');
  assert.equal(g.api.__count('unirun.autoRun'), 0, '随机窗口未能落盘时绝不能提交（fail-closed）');
  assert.equal(storage.dump()['auto3ct:state'], undefined, 'state 不应被写入');
});

test('校园跑预览：随机窗口可见但不落盘', async () => {
  const g = makeWindowEngine({ config: { dryRun: true, unirun: { enabled: true } }, random: () => 0.5 });
  const out = await g.engine.preview();
  const r = out.results.find((x) => x.module === 'unirun');
  assert.equal(r.status, 'dry-run');
  assert.ok(r.windowMinutes >= 39 && r.windowMinutes <= 48, '预览行也应带窗口值：' + r.windowMinutes);
  assert.equal(g.storage.dump()['auto3ct:state'], undefined, '预览绝不落盘');
});

test('校园跑随机源异常（NaN/返回 1）不会崩，窗口仍合法', async () => {
  for (const badRandom of [() => NaN, () => 1, () => -1, () => 2]) {
    const g = makeWindowEngine({ random: badRandom });
    const r = (await g.engine.runOnce()).results.find((x) => x.module === 'unirun');
    assert.ok(Number.isInteger(r.windowMinutes), '窗口必须仍是整数：' + r.windowMinutes);
    assert.ok(r.windowMinutes >= 39 && r.windowMinutes <= 48, '窗口仍须在范围内：' + r.windowMinutes);
  }
});

test('校园跑窗口参与 expired 判定：随机窗口比 30 更宽，07:15 仍可执行', async () => {
  // 39~48 分钟的窗口下，07:15（runAt 06:30 + 45min）应当仍在窗口内
  const clock = makeClock(BJ(2026, 9, 21, 7, 15));
  const g = makeWindowEngine({ clock, random: () => 0.9999 }); // → 48 分钟
  const out = await g.engine.runOnce();
  const r = out.results.find((x) => x.module === 'unirun');
  assert.equal(r.windowMinutes, 48);
  assert.equal(r.status, 'success', '48 分钟窗口下 07:15 应可执行');
  assert.equal(g.api.__count('unirun.autoRun'), 1);
});

test('校园跑窗口随机值体现在 deadline：超出当天随机窗口后记 expired', async () => {
  // random=0 → 39 分钟窗口 → 06:30+39 = 07:09；07:10 应 expired
  const clock = makeClock(BJ(2026, 9, 21, 7, 10));
  const g = makeWindowEngine({ clock, random: () => 0 }); // → 39
  const out = await g.engine.runOnce();
  const r = out.results.find((x) => x.module === 'unirun');
  assert.equal(r.windowMinutes, 39);
  assert.equal(r.status, 'expired');
  assert.equal(r.reason, 'run-window-passed');
  assert.equal(g.api.__count('unirun.autoRun'), 0, '过期窗口不得提交');
});

test('校园跑窗口按账号隔离：不同账号各自一个当天随机值', async () => {
  const storage = baseStorage({
    ct_unirun_accounts_v1: JSON.stringify({
      selectedId: 'acc-1',
      items: [
        { id: 'acc-1', phone: '13800000000', password: 'pw', remark: 'A', updatedAt: 1 },
        { id: 'acc-2', phone: '13900000001', password: 'pw2', remark: 'B', updatedAt: 1 },
      ],
    }),
  });
  const clock = makeClock(BJ(2026, 9, 21, 6, 31));
  // acc-1 → 39
  const g1 = makeWindowEngine({ storage, clock, config: { dryRun: false, accountId: 'acc-1', unirun: { enabled: true } }, random: () => 0 });
  const w1 = (await g1.engine.runOnce()).results.find((x) => x.module === 'unirun').windowMinutes;
  // acc-2 → 48（同一天同一 storage，但账号不同 → 独立随机）
  const g2 = makeWindowEngine({ storage, clock, config: { dryRun: false, accountId: 'acc-2', unirun: { enabled: true } }, random: () => 0.9999 });
  const w2 = (await g2.engine.runOnce()).results.find((x) => x.module === 'unirun').windowMinutes;
  assert.equal(w1, 39);
  assert.equal(w2, 48, '不同账号应各自随机');
  const state = JSON.parse(storage.dump()['auto3ct:state']);
  assert.equal(state.unirunWindow['2026-09-21|acc-1'], 39);
  assert.equal(state.unirunWindow['2026-09-21|acc-2'], 48);
});

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
      getActivitiesList: { List: { Items: [ekItem({ ActivityStatus: '1' })] } },
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
      getActivitiesList: { List: { Items: [ekItem({ ActivityStatus: '1' })] } },
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
    config: { ek: { keywords: ['歌手'], qrDelayMinutes: 0, qrRetryMinutes: 2, qrMaxAttempts: 3, noQrFallback: false } },
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
      getActivitiesList: { List: { Items: [ekItem({ ActivityStatus: '1' })] } },
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
      getActivitiesList: { List: { Items: [ekItem({ ActivityStatus: '1' })] } },
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
    config: { ek: { keywords: ['歌手'], qrDelayMinutes: 0, noQrFallback: false } },
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
      getActivitiesList: { List: { Items: [ekItem({ ActivityStatus: '1' })] } },
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
    config: { ek: { keywords: ['歌手'], qrDelayMinutes: 0, qrRetryMinutes: 1, qrMaxAttempts: 5, noQrFallback: false } },
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
      getActivitiesList: { List: { Items: [ekItem({ ActivityStatus: '1' })] } },
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
    config: { ek: { keywords: ['歌手'], qrDelayMinutes: 0, noQrFallback: false } },
  });
  const out = await engine.runOnce();
  assert.equal(signCalled, 0);
  assert.equal(out.results.find((r) => r.action === 'signIn').status, 'waiting-material');
});

test('opaque lbUUh 但上传时间在窗口内 → 可接受（延迟上传场景）', async () => {
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [ekItem({ ActivityStatus: '1' })] } },
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

test('stop 后不再提交后续动作（deferred read pending → stop → resolve → apply 0）', async () => {
  let releaseDetail = null;
  const api = makeApi({
    ek: {
      // 报名场景：列表可报名 + 详情未报名
      getActivitiesList: { List: { Items: [ekItem({ ActivityStatus: '0' })], TotalPages: 1 } },
      // 详情读取挂起：模拟网络在途时用户点停止
      getActivityDetail: () =>
        new Promise((resolve) => {
          releaseDetail = () => resolve(ekDetail({}, {}, null));
        }),
      applyActivity: { errcode: 0 },
    },
  });
  const { engine } = makeEngine({
    api,
    clock: makeClock(BJ(2026, 9, 21, 8, 0)),
    config: { ek: { keywords: ['歌手'] } },
  });
  const running = engine.runOnce();
  // 等详情请求真正挂起
  for (let i = 0; i < 50 && !releaseDetail; i += 1) {
    await new Promise((r) => setTimeout(r, 1));
  }
  assert.equal(typeof releaseDetail, 'function', '应已挂起在详情读取');
  engine.stop();
  releaseDetail();
  await running;
  assert.equal(api.__count('ek.applyActivity'), 0, '停止后本轮不得继续提交');
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

// ───────────── 二课「官方已报名」无条件跟踪（新机/升级回归） ─────────────

test('新机全新 state：仅官方 status=1 且活动名不匹配关键词 → 仍签到成功并写入 watchedEk', async () => {
  const storage = baseStorage(); // 空 state：无 watchedEk、无任何历史
  const api = makeApi({
    ek: {
      // 真实接口：activityStatus=1 返回「已报名」列表；activityStatus=0 是可报名列表
      getActivitiesList: (p) => ({
        List: {
          Items: p.activityStatus === '1' ? [ekItem({ ActivityStatus: '1', ActivityName: '无关活动' })] : [],
          TotalPages: 1,
        },
      }),
      getActivityDetail: ekDetail({}, { ActivityName: '无关活动' }),
      activityBoundImages: { items: [] },
    },
  });
  const { engine } = makeEngine({
    api,
    storage,
    clock: makeClock(BJ(2026, 9, 21, 18, 5)),
    // 关键词只约束「新增报名」：已报名活动不匹配关键词也必须照常签到/签退
    config: { ek: { keywords: ['歌手'], qrDelayMinutes: 0 } },
  });
  const out = await engine.runOnce();
  const signIn = out.results.find((r) => r.action === 'signIn' && r.activityId === 'act-1');
  assert.ok(signIn, '官方已报名活动必须进入签到流程');
  assert.equal(signIn.status, 'success', JSON.stringify(signIn));
  assert.equal(api.__count('ek.applyActivity'), 0, '已报名活动不得重复报名');

  const st = JSON.parse(storage.get('auto3ct:state'));
  const entry = ((st.watchedEk || {})[EK_LOGIN_NAME] || {})['act-1'];
  assert.ok(entry, '已报名活动必须写入 watchedEk（新机无历史时靠它后续跟踪）');
  assert.equal(entry.expireAt, BJ(2026, 9, 21, 20, 30), 'watch 必须记录签到/签退窗口最后截止时间');
});

test('同轮 status=1 与 status=0：已报名不被关键词过滤，未报名仍被关键词闸门过滤', async () => {
  const api = makeApi({
    ek: {
      getActivitiesList: (p) => ({
        List: {
          Items:
            p.activityStatus === '1'
              ? [ekItem({ Id: 'applied-1', ActivityId: 'applied-1', ActivityStatus: '1', ActivityName: '不匹配的已报名活动' })]
              : [ekItem({ Id: 'joinable-1', ActivityId: 'joinable-1', ActivityStatus: '0', ActivityName: '不匹配的可报名活动' })],
          TotalPages: 1,
        },
      }),
      getActivityDetail: (p) => ekDetail({}, { Id: p.id, ActivityName: '活动' + p.id }),
      activityBoundImages: { items: [] },
    },
  });
  const { engine } = makeEngine({
    api,
    clock: makeClock(BJ(2026, 9, 21, 18, 5)),
    config: { ek: { keywords: ['歌手'], qrDelayMinutes: 0 } },
  });
  const out = await engine.runOnce();
  const detailIds = api.__calls.filter((c) => c.name === 'ek.getActivityDetail').map((c) => c.payload.id);
  assert.deepEqual(detailIds, ['applied-1'], '只处理官方已报名的活动，status=0 不匹配关键词不得拉详情');
  assert.equal(api.__count('ek.applyActivity'), 0, '不匹配关键词的可报名活动不得报名');
  const scanRow = out.results.find((r) => r.reason === 'scan-complete');
  assert.ok(scanRow, '必须有二课扫描汇总');
  assert.equal(scanRow.filtered, 1, 'status=0 不匹配关键词应计入 filtered');
  const signIn = out.results.find((r) => r.action === 'signIn');
  assert.ok(signIn);
  assert.equal(signIn.status, 'success', 'status=1 活动必须签到成功：' + JSON.stringify(signIn));
});

test('已结束活动：详情确认签到/签退窗口全部结束 → 写 ekFinished，下一轮不再拉详情', async () => {
  const storage = baseStorage();
  const started = BJ(2026, 9, 21, 8, 0);
  const ended = ekDetail(
    {},
    {
      ActivityQDDate: '2026-09-20 18:00:00 至 2026-09-20 18:30:00',
      ActivityQTDate: '2026-09-20 20:00:00 至 2026-09-20 20:30:00',
    },
  );
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [ekItem({ ActivityStatus: '1' })], TotalPages: 1 } },
      getActivityDetail: ended,
    },
  });
  const { engine } = makeEngine({
    api,
    storage,
    clock: makeClock(started),
    config: { ek: { keywords: ['歌手'], qrDelayMinutes: 0 } },
  });
  await engine.runOnce();
  assert.equal(api.__count('ek.getActivityDetail'), 1);
  const st = JSON.parse(storage.get('auto3ct:state'));
  const archived = ((st.ekFinished || {})[EK_LOGIN_NAME] || {})['act-1'];
  assert.ok(archived, '窗口全部结束必须写入 ekFinished');
  assert.equal(archived.expireAt, BJ(2026, 9, 20, 20, 30), 'expireAt 取 QD/QT end 最大值');
  assert.equal(archived.at, started, 'at 取归档时刻');

  const second = await engine.runOnce();
  assert.equal(api.__count('ek.getActivityDetail'), 1, '第二轮命中 ekFinished 缓存，不得再拉详情');
  assert.ok(second.ekScan && second.ekScan.finished >= 1, '扫描汇总应体现已结束归档命中');
  assert.equal(second.results.some((r) => r.action === 'signIn'), false, '已归档活动不再进入签到流程');
});

test('watch 记录写入 expireAt；窗口结束后 pruneWatchedEk 清理过期条目', async () => {
  const storage = baseStorage();
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [ekItem({ ActivityStatus: '1' })], TotalPages: 1 } },
      getActivityDetail: ekDetail(),
      activityBoundImages: { items: [] },
    },
  });
  const clock = makeClock(BJ(2026, 9, 21, 18, 5));
  const { engine } = makeEngine({
    api,
    storage,
    clock,
    config: { ek: { keywords: ['歌手'], qrDelayMinutes: 0 } },
  });

  await engine.runOnce(); // 签到窗口内：签到成功并写入 watch
  let st = JSON.parse(storage.get('auto3ct:state'));
  const written = ((st.watchedEk || {})[EK_LOGIN_NAME] || {})['act-1'];
  assert.ok(written, '已报名活动应写入 watch');
  assert.equal(written.expireAt, BJ(2026, 9, 21, 20, 30), 'watch 必须带 expireAt（QD/QT end 最大值）');

  // 官方窗口结束 + 6h 之后：pruneWatchedEk 应清理该 watch 项，同时详情确认后归档
  clock.set(BJ(2026, 9, 22, 8, 0));
  await engine.runOnce();
  st = JSON.parse(storage.get('auto3ct:state'));
  assert.equal('act-1' in ((st.watchedEk || {})[EK_LOGIN_NAME] || {}), false, '过期 watch 必须被清理，避免无限增长');
  assert.ok((((st.ekFinished || {})[EK_LOGIN_NAME] || {})['act-1']), '结束后应记入 ekFinished');
});

test('watch：详情无签到/签退窗口时不写 expireAt（不伪造过期时间）', async () => {
  const storage = baseStorage();
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [ekItem({ ActivityStatus: '1' })], TotalPages: 1 } },
      getActivityDetail: ekDetail({}, { ActivityQDDate: '', ActivityQTDate: '' }),
    },
  });
  const { engine } = makeEngine({
    api,
    storage,
    clock: makeClock(BJ(2026, 9, 21, 18, 5)),
    config: { ek: { keywords: ['歌手'], qrDelayMinutes: 0 } },
  });
  await engine.runOnce();
  const st = JSON.parse(storage.get('auto3ct:state'));
  const entry = ((st.watchedEk || {})[EK_LOGIN_NAME] || {})['act-1'];
  assert.ok(entry, '已报名活动应写入 watch');
  assert.equal('expireAt' in entry, false, '无窗口不得伪造 expireAt');
  assert.deepEqual(Object.keys(st.ekFinished || {}), [], '无窗口不得提前归档');
});

test('空关键词且未开 allowAll：不扫描 status=0，但仍扫描 status=1 并签到', async () => {
  const api = makeApi({
    ek: {
      getActivitiesList: (p) => ({
        List: { Items: p.activityStatus === '1' ? [ekItem({ ActivityStatus: '1' })] : [], TotalPages: 1 },
      }),
      getActivityDetail: ekDetail(),
      activityBoundImages: { items: [] },
    },
  });
  const { engine } = makeEngine({
    api,
    storage: baseStorage(),
    clock: makeClock(BJ(2026, 9, 21, 18, 5)),
    config: { ek: { enabled: true, qrDelayMinutes: 0 } },
  });
  const out = await engine.runOnce();
  const queriedStatuses = api.__calls
    .filter((c) => c.name === 'ek.getActivitiesList')
    .map((c) => c.payload.activityStatus);
  assert.deepEqual(queriedStatuses, ['1'], '空关键词时只允许扫描已报名列表（不得扫描可报名列表）');
  assert.ok(out.results.some((r) => r.reason === 'need-keywords'), '必须保留 need-keywords 提示');
  assert.equal(api.__count('ek.applyActivity'), 0, '空关键词且未开 allowAll 绝不新增报名');
  const signIn = out.results.find((r) => r.action === 'signIn');
  assert.ok(signIn, '官方已报名活动仍必须进入签到流程');
  assert.equal(signIn.status, 'success', JSON.stringify(signIn));
});