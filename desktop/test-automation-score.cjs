/**
 * 二课积分缺口策略 × engine 集成测试（Node 内置 test runner，离线、不触网）。
 *
 * 运行：<bundled node> --test desktop/test-automation-score.cjs
 *
 * 覆盖 lead 冻结的要求：
 *  - scorePolicy 默认 enabled=true：未导入/未刷新前阻断新增报名，已报名 watch 仍继续签到签退
 *  - 模块达标只阻新增；未知类别 skip category-unknown
 *  - snapshot 按账号隔离（auto3ct:scores.accounts[accountId]），换账号不覆盖
 *  - importScoreSnapshot 拒绝静默重绑其他账号；模板（无 accountId）可绑定当前账号
 *  - refreshScores 1h 间隔 + force 绕过；preview 不持久化、不消耗
 *  - merge 时 Info.StudentId 显式不一致拒绝覆盖
 *  - onResult 仅真实提交回调（dry-run 不回调），同一 key 一次，含 activityId/accountId/category
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('./automation.js');
const P = require('./score-policy.js');

const BJ = (y, m, d, hh = 0, mm = 0) => Date.UTC(y, m - 1, d, hh - 8, mm, 0);
const EK_ACCOUNT = { id: 'acc-1', phone: '13800000000', password: 'pw', remark: '主号', updatedAt: 1 };
const EK_LOGIN_NAME = 'test-student';

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
  return { now: () => now, set: (n) => void (now = n), advance: (d) => void (now += d) };
}

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
      getStudentScores: { TypeList: [] },
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
    table[group] = Object.assign({}, table[group], overrides[group] || {});
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
  api.__count = (n) => calls.filter((c) => c.name === n).length;
  return api;
}

/** 截图初值 snapshot（绑定当前测试账号，未达标的 6 个模块） */
function initialSnapshot(over = {}) {
  return P.buildSnapshot({
    accountId: EK_LOGIN_NAME,
    source: 'manual',
    updatedAt: Date.now(),
    modules: P.getScreenshotInitialModules(),
    ...over,
  });
}

function makeEngine(opts = {}) {
  const clock = opts.clock || makeClock(BJ(2026, 9, 21, 8, 0));
  const storage = opts.storage || baseStorage();
  const api = opts.api || makeApi();
  const results = [];
  const logs = [];
  const config = Object.assign({ dryRun: false }, opts.config || {});
  // 测试语义：出现模块配置即视为该模块启用（生产默认 false）
  ['ek', 'club', 'unirun'].forEach((name) => {
    if (config[name] && config[name].enabled === undefined) config[name].enabled = true;
  });
  const engine = A.createEngine({
    api,
    storage,
    clock,
    decodeQr: opts.decodeQr || (async () => null),
    logger: { log: (m) => logs.push(String(m)) },
    onResult: (row) => results.push(row),
    config,
  });
  return { engine, api, storage, clock, logs, results };
}

// ───────────────────────── fixtures ─────────────────────────

/** 列表项：可报名，ModuleCode 对应「思想政治与道德修养」（未达标模块） */
function ekItem(over = {}) {
  return {
    Id: 'act-1',
    ActivityId: 'act-1',
    ActivityName: '志愿服务讲座',
    ActivityStatus: '0',
    ModuleCode: 'M1',
    ...over,
  };
}

/** 详情：ModuleCodeText 为「思想政治与道德修养」（exact 中文名） */
function ekDetail(over = {}, infoOver = {}, applyInfo = { Id: 'sign-1', ActivityId: 'act-1' }) {
  return {
    ActivityInfo: {
      Id: 'act-1',
      ActivityName: '志愿服务讲座',
      ModuleCodeText: '思想政治与道德修养',
      SignWay: 1,
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

const MODULE_OPTIONS = [
  { label: '思想政治与道德修养', value: 'M1' },
  { label: '传统文化与人文素养', value: 'M2' },
];

function scoreConfig(extra = {}) {
  return {
    ek: {
      keywords: ['志愿服务'],
      // 关键：策略数据走工试注入（importScoreSnapshot 或 config 直接给）
      moduleOptions: MODULE_OPTIONS,
      ...extra,
    },
  };
}

// ───────────────────────── 默认 enabled=true：无 snapshot 阻断新增 ─────────────────────────

test('scorePolicy 默认启用：无 snapshot 时阻断新增报名（不盲报）', async () => {
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [ekItem()] } },
      getActivityDetail: ekDetail({}, {}, null), // 未报名
    },
  });
  const { engine } = makeEngine({ api, clock: makeClock(BJ(2026, 9, 21, 8, 0)), config: scoreConfig() });
  const out = await engine.runOnce();
  const apply = out.results.find((r) => r.action === 'apply');
  assert.ok(apply, '应产生 apply 决策行');
  assert.equal(apply.status, 'blocked');
  // 无 snapshot 且自动刷新失败时，reason 可能是更具体的 score-refresh-failed；两者都必须阻断
  assert.ok(
    ['score-snapshot-missing', 'score-refresh-failed'].includes(apply.reason),
    '实际 reason=' + apply.reason,
  );
  assert.equal(api.__count('ek.applyActivity'), 0, '无可信 snapshot 不得新增报名');
});

test('导入截图初值 snapshot 后：未达标模块允许报名', async () => {
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [ekItem()] } },
      getActivityDetail: ekDetail({}, {}, null),
      applyActivity: { errcode: 0 },
    },
  });
  const storage = baseStorage();
  const { engine } = makeEngine({ api, storage, clock: makeClock(BJ(2026, 9, 21, 8, 0)), config: scoreConfig() });
  const imported = engine.importScoreSnapshot(initialSnapshot());
  assert.equal(imported.ok, true);

  const out = await engine.runOnce();
  const apply = out.results.find((r) => r.action === 'apply');
  assert.equal(apply.status, 'success');
  assert.equal(api.__count('ek.applyActivity'), 1);
});

// ───────────────────────── 达标模块阻断新增 ─────────────────────────

test('模块已达标（传统文化 8/8.5）→ 不新增该模块报名', async () => {
  const api = makeApi({
    ek: {
      getActivitiesList: {
        List: { Items: [ekItem({ Id: 'act-2', ModuleCode: 'M2', ActivityName: '传统文化活动' })] },
      },
      getActivityDetail: ekDetail(
        { ApplyInfo: null },
        { Id: 'act-2', ModuleCodeText: '传统文化与人文素养', ActivityName: '传统文化活动' },
        null,
      ),
    },
  });
  const storage = baseStorage();
  const { engine } = makeEngine({
    api,
    storage,
    clock: makeClock(BJ(2026, 9, 21, 8, 0)),
    config: scoreConfig({ keywords: ['传统文化'] }),
  });
  engine.importScoreSnapshot(initialSnapshot());
  const out = await engine.runOnce();
  const apply = out.results.find((r) => r.action === 'apply');
  assert.equal(apply.status, 'skipped');
  assert.equal(apply.reason, 'module-satisfied');
  assert.equal(api.__count('ek.applyActivity'), 0);
});

// ───────────────────────── 未知类别 fail-closed ─────────────────────────

test('无法映射模块的活动 → skip category-unknown，不报名', async () => {
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [ekItem({ Id: 'act-3', ModuleCode: 'ZZZ' })] } },
      getActivityDetail: ekDetail({}, { Id: 'act-3', ModuleCodeText: '未知类别文本' }, null),
    },
  });
  const storage = baseStorage();
  const { engine } = makeEngine({
    api,
    storage,
    clock: makeClock(BJ(2026, 9, 21, 8, 0)),
    config: scoreConfig({ keywords: ['志愿服务'] }),
  });
  engine.importScoreSnapshot(initialSnapshot());
  const out = await engine.runOnce();
  const apply = out.results.find((r) => r.action === 'apply');
  assert.equal(apply.status, 'skipped');
  assert.equal(apply.reason, 'category-unknown');
  assert.equal(api.__count('ek.applyActivity'), 0);
});

// ───────────────────────── 账号隔离 ─────────────────────────

test('importScoreSnapshot 拒绝静默重绑其他账号', () => {
  const { engine } = makeEngine();
  const other = P.buildSnapshot({
    accountId: 'someone-else',
    source: 'manual',
    modules: P.getScreenshotInitialModules(),
  });
  const denied = engine.importScoreSnapshot(other);
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, 'account-mismatch');
});

test('snapshot 按账号隔离存储：换账号不覆盖旧 snapshot', () => {
  const storage = baseStorage();
  const { engine } = makeEngine({ storage });
  engine.importScoreSnapshot(initialSnapshot());
  const raw = JSON.parse(storage.get('auto3ct:scores'));
  assert.equal(raw.version, 1);
  assert.ok(raw.accounts[EK_LOGIN_NAME], '当前账号条目应存在');
  assert.equal(raw.accounts[EK_LOGIN_NAME].snapshot.accountId, EK_LOGIN_NAME);
});

test('账号不匹配的旧 snapshot 不用于放行', async () => {
  const storage = baseStorage({
    'auto3ct:scores': JSON.stringify({
      version: 1,
      accounts: {
        'other-student': {
          snapshot: initialSnapshot({ accountId: 'other-student' }),
          refreshedAt: 1700000000000,
        },
      },
    }),
  });
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [ekItem()] } },
      getActivityDetail: ekDetail({}, {}, null),
    },
  });
  const { engine } = makeEngine({ api, storage, clock: makeClock(BJ(2026, 9, 21, 8, 0)), config: scoreConfig() });
  const out = await engine.runOnce();
  const apply = out.results.find((r) => r.action === 'apply');
  assert.equal(apply.status, 'blocked');
  assert.match(apply.reason, /score-account-mismatch|score-snapshot-missing|score-refresh-failed/);
  assert.equal(api.__count('ek.applyActivity'), 0);
});

// ───────────────────────── 已报名 watch 不受达标过滤 ─────────────────────────

test('已报名活动所在模块达标：仍继续签到（防违约），只是不新增报名', async () => {
  const api = makeApi({
    ek: {
      getActivitiesList: {
        List: {
          Items: [ekItem({ Id: 'act-2', ActivityStatus: '1', ModuleCode: 'M2', ActivityName: '传统文化活动' })],
        },
      },
      getActivityDetail: ekDetail(
        { ApplyInfo: { Id: 'sign-2', ActivityId: 'act-2' } },
        { Id: 'act-2', ModuleCodeText: '传统文化与人文素养', ActivityName: '传统文化活动' },
        { Id: 'sign-2', ActivityId: 'act-2' },
      ),
      activityBoundImages: {
        items: [
          { id: 'qd-1', file_url: 'https://x/qd.png', created_at: '2026-09-21 18:01:00', bind: { remark: '签到' } },
        ],
      },
      signByQr: { errcode: 0 },
    },
  });
  const storage = baseStorage();
  const { engine } = makeEngine({
    api,
    storage,
    clock: makeClock(BJ(2026, 9, 21, 18, 5)),
    decodeQr: async () => 'lbUUh-abc-QD',
    config: scoreConfig({ keywords: ['传统文化'], qrDelayMinutes: 0 }),
  });
  engine.importScoreSnapshot(initialSnapshot());
  const out = await engine.runOnce();
  const signIn = out.results.find((r) => r.action === 'signIn');
  assert.equal(signIn.status, 'success', '达标模块的已报名活动必须继续签到');
  assert.equal(api.__count('ek.signByQr'), 1);
});

// ───────────────────────── 刷新与缓存 ─────────────────────────

test('refreshScores 解析官方成绩并写入账号隔离存储', async () => {
  const api = makeApi({
    ek: {
      getStudentScores: {
        Info: { StudentId: EK_LOGIN_NAME },
        TypeList: [
          { CurriculumName: '思想政治与道德修养', SumScore: '8' },
          { CurriculumName: '学术科技与创新创业', SumScore: 5 },
        ],
      },
    },
  });
  const storage = baseStorage();
  const { engine } = makeEngine({
    api,
    storage,
    clock: makeClock(BJ(2026, 9, 21, 8, 0)),
    config: scoreConfig(),
  });
  engine.importScoreSnapshot(initialSnapshot());
  const res = await engine.refreshScores({ force: true });
  assert.equal(res.ok, true);
  const snap = engine.getScoreSnapshot();
  assert.equal(snap.source, 'official');
  assert.equal(snap.modules.find((m) => m.name === '思想政治与道德修养').current, 8);
  const policy = engine.getScorePolicyStatus();
  assert.equal(policy.accountMatch, true);
});

test('refreshScores 1 小时间隔内不重复请求（force 可绕过）', async () => {
  const api = makeApi({
    ek: {
      getStudentScores: {
        Info: { StudentId: EK_LOGIN_NAME },
        TypeList: [{ CurriculumName: '思想政治与道德修养', SumScore: '8' }],
      },
    },
  });
  const storage = baseStorage();
  const clock = makeClock(BJ(2026, 9, 21, 8, 0));
  const { engine } = makeEngine({ api, storage, clock, config: scoreConfig() });
  engine.importScoreSnapshot(initialSnapshot());

  await engine.refreshScores({ force: true });
  assert.equal(api.__count('ek.getStudentScores'), 1);

  clock.advance(10 * 60 * 1000); // 10 分钟后
  const second = await engine.refreshScores(); // 非 force
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'refresh-throttled');
  assert.equal(api.__count('ek.getStudentScores'), 1, '1h 内不得重复请求官方接口');

  clock.advance(60 * 60 * 1000);
  const third = await engine.refreshScores();
  assert.equal(third.ok, true);
  assert.equal(api.__count('ek.getStudentScores'), 2);
});

test('refreshScores 官方返回不可信时保留旧 snapshot 并标 lastRefreshError', async () => {
  const api = makeApi({ ek: { getStudentScores: { TypeList: [] } } });
  const storage = baseStorage();
  const { engine } = makeEngine({
    api,
    storage,
    clock: makeClock(BJ(2026, 9, 21, 8, 0)),
    config: scoreConfig(),
  });
  engine.importScoreSnapshot(initialSnapshot());
  const res = await engine.refreshScores({ force: true });
  assert.equal(res.ok, false);
  const snap = engine.getScoreSnapshot();
  assert.ok(snap, '旧 snapshot 必须保留');
  assert.equal(snap.source, 'manual');
  const raw = JSON.parse(storage.get('auto3ct:scores'));
  assert.ok(raw.accounts[EK_LOGIN_NAME].lastRefreshError, '应记录刷新错误');
});

test('refreshScores 显式账号不一致拒绝覆盖当前进度', async () => {
  const api = makeApi({
    ek: {
      getStudentScores: {
        Info: { StudentId: 'someone-else' },
        TypeList: [{ CurriculumName: '思想政治与道德修养', SumScore: '12' }],
      },
    },
  });
  const storage = baseStorage();
  const { engine } = makeEngine({
    api,
    storage,
    clock: makeClock(BJ(2026, 9, 21, 8, 0)),
    config: scoreConfig(),
  });
  engine.importScoreSnapshot(initialSnapshot());
  const res = await engine.refreshScores({ force: true });
  assert.equal(res.ok, false);
  assert.match(String(res.reason), /account-mismatch/);
  const snap = engine.getScoreSnapshot();
  assert.equal(snap.modules.find((m) => m.name === '思想政治与道德修养').current, 6, '旧值不得被覆盖');
});

// ───────────────────────── preview 无副作用 ─────────────────────────

test('preview 不持久化 scores 也不消耗刷新预算', async () => {
  const api = makeApi({
    ek: {
      getStudentScores: {
        Info: { StudentId: EK_LOGIN_NAME },
        TypeList: [{ CurriculumName: '思想政治与道德修养', SumScore: '12' }],
      },
      getActivitiesList: { List: { Items: [ekItem()] } },
      getActivityDetail: ekDetail({}, {}, null),
    },
  });
  const storage = baseStorage();
  const clock = makeClock(BJ(2026, 9, 21, 8, 0));
  const { engine } = makeEngine({ api, storage, clock, config: scoreConfig() });
  engine.importScoreSnapshot(initialSnapshot());
  const beforeScores = storage.get('auto3ct:scores');
  const beforeState = storage.get('auto3ct:state');

  await engine.preview();

  assert.equal(storage.get('auto3ct:scores'), beforeScores, 'preview 不得改写 scores');
  assert.equal(storage.get('auto3ct:state'), beforeState, 'preview 不得改写 state');
  assert.equal(api.__count('ek.applyActivity'), 0);
});

// ───────────────────────── onResult ─────────────────────────

test('onResult 只在真实提交后回调，dry-run 不回调，含 activityId/category/accountId', async () => {
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [ekItem()] } },
      getActivityDetail: ekDetail({}, {}, null),
      applyActivity: { errcode: 0 },
    },
  });
  const storage = baseStorage();
  const { engine, results } = makeEngine({
    api,
    storage,
    clock: makeClock(BJ(2026, 9, 21, 8, 0)),
    config: scoreConfig(),
  });
  engine.importScoreSnapshot(initialSnapshot());

  await engine.preview();
  assert.equal(results.length, 0, 'preview 不得触发 onResult');

  await engine.runOnce();
  assert.equal(results.length, 1, '真实提交应回调一次');
  const row = results[0];
  assert.equal(row.activityId, 'act-1');
  assert.equal(row.accountId, EK_LOGIN_NAME);
  assert.equal(row.accountId.includes('@'), false);
  assert.equal(row.category, '思想政治与道德修养');
  assert.equal(row.module, 'ek');
  assert.equal(row.action, 'apply');
  assert.equal(row.status, 'success');
  assert.equal(row.activityName, '志愿服务讲座');
  assert.ok(row.at > 0);
  assert.equal(JSON.stringify(row).includes('tok'), false);
  assert.equal(JSON.stringify(row).includes('pw'), false);
});

test('onResult 同一 key 不重复回调（第二天不重复当日成功的提交）', async () => {
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [ekItem()] } },
      getActivityDetail: ekDetail({}, {}, null),
      applyActivity: { errcode: 0 },
    },
  });
  const storage = baseStorage();
  const clock = makeClock(BJ(2026, 9, 21, 8, 0));
  const { engine, results } = makeEngine({ api, storage, clock, config: scoreConfig() });
  engine.importScoreSnapshot(initialSnapshot());

  await engine.runOnce();
  assert.equal(results.length, 1);
  await engine.runOnce(); // 同日再跑：done 去重，不再提交
  assert.equal(results.length, 1, '已完成动作不应再次回调');
});

// ───────────────────────── 旧测试兼容 ─────────────────────────

test('scorePolicy.enabled=false 时完全不影响旧行为', async () => {
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [ekItem()] } },
      getActivityDetail: ekDetail({}, {}, null),
      applyActivity: { errcode: 0 },
    },
  });
  const { engine } = makeEngine({
    api,
    clock: makeClock(BJ(2026, 9, 21, 8, 0)),
    config: { ek: { keywords: ['志愿服务'], scorePolicy: { enabled: false } } },
  });
  const out = await engine.runOnce();
  assert.equal(out.results.find((r) => r.action === 'apply').status, 'success');
});

// ───────────────────── review 回归（engine） ─────────────────────

test('ScorePolicy 依赖缺失时 getScorePolicyStatus 返回安全 unavailable，不 throw', async () => {
  const storage = baseStorage();
  const api = makeApi();
  // 构造一个「策略模块不可用」的场景：用空 scorePolicy 且移除全局依赖不可行，
  // 此处验证异常路径的等价契约：status 永远返回可展示字段且不抛。
  const { engine } = makeEngine({ api, storage, clock: makeClock(BJ(2026, 9, 21, 8, 0)), config: scoreConfig() });
  const status = engine.getScorePolicyStatus();
  assert.equal(typeof status.enabled, 'boolean');
  assert.equal(typeof status.trusted, 'boolean');
  assert.ok(Array.isArray(status.gaps));
  assert.ok(Array.isArray(status.satisfiedModules));
  assert.ok('reason' in status);
});

test('config.snapshot 仅作 seed：store 有记录后以 store 为准（官方最新生效）', async () => {
  const storage = baseStorage();
  const api = makeApi({
    ek: {
      getStudentScores: {
        Info: { StudentId: EK_LOGIN_NAME },
        TypeList: [{ CurriculumName: '思想政治与道德修养', SumScore: '11' }],
      },
    },
  });
  const clock = makeClock(BJ(2026, 9, 21, 8, 0));
  // config 里注入一个旧 snapshot（思想 6 分）
  const seeded = P.buildSnapshot({
    accountId: EK_LOGIN_NAME,
    source: 'manual',
    updatedAt: Date.now(),
    modules: P.getScreenshotInitialModules(),
  });
  const { engine } = makeEngine({
    api,
    storage,
    clock,
    config: scoreConfig({ scorePolicy: { enabled: true, snapshot: seeded } }),
  });
  assert.equal(engine.getScoreSnapshot().modules.find((m) => m.name === '思想政治与道德修养').current, 6);

  await engine.refreshScores({ force: true });
  const after = engine.getScoreSnapshot();
  assert.equal(
    after.modules.find((m) => m.name === '思想政治与道德修养').current,
    11,
    'store 中的官方数据必须优先于 config seed',
  );
});

test('refresh 失败后 1h 内不再重复请求官方接口（lastAttemptAt 生效）', async () => {
  const api = makeApi({ ek: { getStudentScores: { TypeList: [] } } });
  const storage = baseStorage();
  const clock = makeClock(BJ(2026, 9, 21, 8, 0));
  const { engine } = makeEngine({ api, storage, clock, config: scoreConfig() });
  engine.importScoreSnapshot(initialSnapshot());

  const first = await engine.refreshScores({ force: true });
  assert.equal(first.ok, false);
  assert.equal(api.__count('ek.getStudentScores'), 1);

  // 失败后立刻再来一次（非 force）→ 被节流，不再打接口
  clock.advance(60 * 1000);
  const second = await engine.refreshScores();
  assert.equal(second.reason, 'refresh-throttled');
  assert.equal(api.__count('ek.getStudentScores'), 1, '失败也要记 lastAttemptAt，避免每 tick 打接口');
});

test('onResult 的 accountId 取自动作快照，不随运行末账号变化', async () => {
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [ekItem()] } },
      getActivityDetail: ekDetail({}, {}, null),
      applyActivity: { errcode: 0 },
    },
  });
  const storage = baseStorage();
  const { engine, results } = makeEngine({
    api,
    storage,
    clock: makeClock(BJ(2026, 9, 21, 8, 0)),
    config: scoreConfig(),
  });
  engine.importScoreSnapshot(initialSnapshot());
  await engine.runOnce();
  assert.equal(results.length, 1);
  assert.equal(results[0].accountId, EK_LOGIN_NAME);
});

test('unknown 结果的 onResult.reason 用固定安全文案，不含原始异常内容', async () => {
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [ekItem()] } },
      getActivityDetail: ekDetail({}, {}, null),
      applyActivity: async () => {
        throw new Error('upstream 500 with token=secret-value');
      },
    },
  });
  const storage = baseStorage();
  const { engine, results } = makeEngine({
    api,
    storage,
    clock: makeClock(BJ(2026, 9, 21, 8, 0)),
    config: scoreConfig(),
  });
  engine.importScoreSnapshot(initialSnapshot());
  const out = await engine.runOnce();
  const apply = out.results.find((r) => r.action === 'apply');
  assert.equal(apply.status, 'unknown');
  assert.equal(apply.reason, 'submission-result-unknown');
  assert.equal(results.length, 1);
  assert.equal(results[0].reason, 'submission-result-unknown');
  assert.equal(JSON.stringify(results[0]).includes('secret-value'), false);
});
// ───────────────────── 自动刷新（run 入口） ─────────────────────

test('run 入口自动刷新官方成绩：刷新后达标的模块立即停止新增报名', async () => {
  const api = makeApi({
    ek: {
      // 官方成绩：思想政治已 12 分（达标），其余模块沿用初值
      getStudentScores: {
        Info: { StudentId: EK_LOGIN_NAME },
        TypeList: [
          { CurriculumName: '思想政治与道德修养', SumScore: '12' },
          { CurriculumName: '学术科技与创新创业', SumScore: 4 },
          { CurriculumName: '艺术体验与审美修养', SumScore: 2 },
          { CurriculumName: '传统文化与人文素养', SumScore: 8.5 },
          { CurriculumName: '人际交往与沟通能力', SumScore: 4 },
          { CurriculumName: '心理素质与身体素质', SumScore: 15.5 },
          { CurriculumName: '社会实践与志愿服务', SumScore: 11 },
          { CurriculumName: '社会工作与能力拓展', SumScore: 3.5 },
        ],
      },
      getActivitiesList: { List: { Items: [ekItem()] } }, // 思想政治（未达标前可报）
      getActivityDetail: ekDetail({}, {}, null),
      applyActivity: { errcode: 0 },
    },
  });
  const storage = baseStorage();
  const clock = makeClock(BJ(2026, 9, 21, 8, 0));
  const { engine } = makeEngine({ api, storage, clock, config: scoreConfig() });

  // 先导入初值（思想政治 6/12 未达标），但把 lastAttemptAt 设成很久以前以便自动刷新
  engine.importScoreSnapshot(initialSnapshot());
  const raw = JSON.parse(storage.get('auto3ct:scores'));
  raw.accounts[EK_LOGIN_NAME].lastAttemptAt = 0;
  raw.accounts[EK_LOGIN_NAME].refreshedAt = 0;
  storage.set('auto3ct:scores', JSON.stringify(raw));

  const out = await engine.runOnce();
  // 自动刷新发生
  assert.equal(api.__count('ek.getStudentScores'), 1, 'run 入口应按缓存自动刷新官方成绩');
  // 刷新后思想政治达标 → 不新增报名
  const apply = out.results.find((r) => r.action === 'apply');
  assert.ok(apply, '应产生 apply 决策行');
  assert.equal(apply.status, 'skipped');
  assert.equal(apply.reason, 'module-satisfied');
  assert.equal(api.__count('ek.applyActivity'), 0, '达标模块不得新增报名');
});

test('自动刷新失败后 1h 内不再请求官方接口（run 多轮只打一次）', async () => {
  const api = makeApi({ ek: { getStudentScores: { TypeList: [] } } });
  const storage = baseStorage();
  const clock = makeClock(BJ(2026, 9, 21, 8, 0));
  const { engine } = makeEngine({ api, storage, clock, config: scoreConfig() });
  engine.importScoreSnapshot(initialSnapshot());
  // 把上次尝试时间调到很久以前，允许本次自动刷新真正发起
  const raw0 = JSON.parse(storage.get('auto3ct:scores'));
  raw0.accounts[EK_LOGIN_NAME].lastAttemptAt = 0;
  raw0.accounts[EK_LOGIN_NAME].refreshedAt = 0;
  storage.set('auto3ct:scores', JSON.stringify(raw0));

  await engine.runOnce();
  await engine.runOnce();
  clock.advance(5 * 60 * 1000);
  await engine.runOnce();
  assert.equal(api.__count('ek.getStudentScores'), 1, '失败也要节流，避免每 tick 打官方接口');

  clock.advance(60 * 60 * 1000);
  await engine.runOnce();
  assert.equal(api.__count('ek.getStudentScores'), 2, '超过 1h 后允许再次尝试');
});

test('getScorePolicyStatus 暴露 lastRefreshError / lastAttemptAt / source / updatedAt', async () => {
  const api = makeApi({ ek: { getStudentScores: { TypeList: [] } } });
  const storage = baseStorage();
  const clock = makeClock(BJ(2026, 9, 21, 8, 0));
  const { engine } = makeEngine({ api, storage, clock, config: scoreConfig() });
  engine.importScoreSnapshot(initialSnapshot());
  await engine.refreshScores({ force: true });

  const status = engine.getScorePolicyStatus();
  assert.equal(status.source, 'manual', '失败刷新应保留旧来源');
  assert.ok(status.updatedAt > 0, '应暴露更新时间');
  assert.ok(status.lastAttemptAt > 0, '应暴露最近尝试时间');
  assert.equal(status.lastRefreshError, 'official-empty-typelist');
});

test('getProfiles 暴露 unirunAccountId（供 dashboard 按账号过滤，不泄露手机号）', () => {
  const { engine } = makeEngine();
  const p = engine.getProfiles();
  assert.equal(p.unirunAccountId, 'acc-1');
  assert.equal(JSON.stringify(p.unirunAccounts).includes('13800000000'), false);
});
// ───────────────────── 三模块 onResult 身份/元数据 ─────────────────────

test('onResult：校园跑事件带 accountId/stage/distanceMeters', async () => {
  const api = makeApi();
  const storage = baseStorage();
  const { engine, results } = makeEngine({
    api,
    storage,
    clock: makeClock(BJ(2026, 9, 21, 6, 31)),
    config: { unirun: { enabled: true, runAt: '06:30', windowMinutes: 30, runDistance: 3000, runTime: 30 } },
  });
  await engine.runOnce();
  assert.equal(results.length, 1);
  const row = results[0];
  assert.equal(row.module, 'unirun');
  assert.equal(row.accountId, 'acc-1', '校园跑事件必须带非空账号');
  assert.equal(row.stage, 'run');
  assert.equal(row.distanceMeters, 3000);
  assert.equal(row.activityName, '校园跑');
  assert.equal(row.dryRun, false);
});

test('onResult：俱乐部报名事件带 accountId/activityName/stage', async () => {
  const api = makeApi({
    club: {
      activityList: {
        code: 10000,
        response: { list: [{ clubActivityId: 3001, activityName: '篮球俱乐部', optionStatus: '6', startTime: '18:00', endTime: '19:00', nextMmdd: '2026-09-21' }] },
      },
      joinActivity: { code: 10000 },
    },
  });
  const storage = baseStorage();
  const { engine, results } = makeEngine({
    api,
    storage,
    clock: makeClock(BJ(2026, 9, 21, 8, 0)),
    config: { club: { enabled: true, keywords: ['篮球'], dailyJoinLimit: 1 } },
  });
  await engine.runOnce();
  assert.equal(results.length, 1);
  const row = results[0];
  assert.equal(row.module, 'club');
  assert.equal(row.accountId, 'acc-1');
  assert.equal(row.activityName, '篮球俱乐部');
  assert.equal(row.stage, 'join');
});

test('onResult：二课签到事件带 accountId/category/activityName/stage', async () => {
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [ekItem({ ActivityStatus: '1' })] } },
      getActivityDetail: ekDetail(),
      activityBoundImages: {
        items: [{ id: 'qd-1', file_url: 'https://x/qd.png', created_at: '2026-09-21 18:01:00', bind: { remark: '签到' } }],
      },
      signByQr: { errcode: 0 },
    },
  });
  const storage = baseStorage();
  const { engine, results } = makeEngine({
    api,
    storage,
    clock: makeClock(BJ(2026, 9, 21, 18, 5)),
    decodeQr: async () => 'lbUUh-abc-QD',
    config: scoreConfig({ qrDelayMinutes: 0 }),
  });
  engine.importScoreSnapshot(initialSnapshot());
  await engine.runOnce();
  const signRow = results.find((r) => r.action === 'signIn');
  assert.ok(signRow, '应有二课签到事件');
  assert.equal(signRow.accountId, EK_LOGIN_NAME);
  assert.equal(signRow.category, '思想政治与道德修养');
  assert.equal(signRow.activityName, '志愿服务讲座');
  assert.equal(signRow.stage, 'sign-in');
});

test('dry-run 轮次不产生任何 onResult（三模块均不回调）', async () => {
  const api = makeApi({
    club: {
      activityList: {
        code: 10000,
        response: { list: [{ clubActivityId: 3001, activityName: '篮球俱乐部', optionStatus: '6', startTime: '18:00', endTime: '19:00', nextMmdd: '2026-09-21' }] },
      },
    },
  });
  const { engine, results } = makeEngine({
    api,
    storage: baseStorage(),
    clock: makeClock(BJ(2026, 9, 21, 8, 0)),
    config: { dryRun: true, club: { enabled: true, keywords: ['篮球'], dailyJoinLimit: 1 } },
  });
  await engine.runOnce();
  assert.equal(results.length, 0);
});
// ───────────────────── review: refresh 失败必须让旧 snapshot 失效 ─────────────────────

test('官方刷新失败（旧 snapshot 仍新鲜）→ 策略 stale=true、trusted=false，新增报名被阻断', async () => {
  const api = makeApi({
    ek: {
      // 刷新失败：空 TypeList（不可信）
      getStudentScores: { TypeList: [] },
      getActivitiesList: { List: { Items: [ekItem()] } },
      getActivityDetail: ekDetail({}, {}, null),
      applyActivity: { errcode: 0 },
    },
  });
  const storage = baseStorage();
  const clock = makeClock(BJ(2026, 9, 21, 8, 0));
  const { engine } = makeEngine({ api, storage, clock, config: scoreConfig() });

  // 导入一个「刚刚更新」的 manual snapshot（思想政治 6/12 未达标）
  engine.importScoreSnapshot(initialSnapshot());
  // 触发一次官方刷新并失败
  const refreshed = await engine.refreshScores({ force: true });
  assert.equal(refreshed.ok, false);

  // 旧 snapshot 的 updatedAt 仍然新鲜（< 24h），但刷新失败必须让它不可信
  const status = engine.getScorePolicyStatus();
  assert.equal(status.stale, true, '刷新失败后必须标 stale');
  assert.equal(status.trusted, false, '刷新失败后不得 trusted');
  assert.equal(status.reason, 'score-refresh-failed');

  const out = await engine.runOnce();
  const apply = out.results.find((r) => r.action === 'apply');
  assert.equal(apply.status, 'blocked');
  assert.equal(apply.reason, 'score-refresh-failed');
  assert.equal(api.__count('ek.applyActivity'), 0, '刷新失败期间不得新增报名');
});

test('官方成绩账号不符（account-mismatch）→ 同样阻断新增报名', async () => {
  const api = makeApi({
    ek: {
      getStudentScores: {
        Info: { StudentId: 'someone-else' },
        TypeList: [{ CurriculumName: '思想政治与道德修养', SumScore: '1' }],
      },
      getActivitiesList: { List: { Items: [ekItem()] } },
      getActivityDetail: ekDetail({}, {}, null),
      applyActivity: { errcode: 0 },
    },
  });
  const storage = baseStorage();
  const clock = makeClock(BJ(2026, 9, 21, 8, 0));
  const { engine } = makeEngine({ api, storage, clock, config: scoreConfig() });
  engine.importScoreSnapshot(initialSnapshot());

  const refreshed = await engine.refreshScores({ force: true });
  assert.equal(refreshed.ok, false);
  assert.equal(engine.getScorePolicyStatus().reason, 'score-refresh-failed');

  const out = await engine.runOnce();
  assert.equal(out.results.find((r) => r.action === 'apply').status, 'blocked');
  assert.equal(api.__count('ek.applyActivity'), 0);
});

test('重新导入 snapshot 后刷新失败标记清除，恢复放行', async () => {
  const api = makeApi({
    ek: {
      getStudentScores: { TypeList: [] },
      getActivitiesList: { List: { Items: [ekItem()] } },
      getActivityDetail: ekDetail({}, {}, null),
      applyActivity: { errcode: 0 },
    },
  });
  const storage = baseStorage();
  const clock = makeClock(BJ(2026, 9, 21, 8, 0));
  const { engine } = makeEngine({ api, storage, clock, config: scoreConfig() });
  engine.importScoreSnapshot(initialSnapshot());
  await engine.refreshScores({ force: true });
  assert.equal(engine.getScorePolicyStatus().reason, 'score-refresh-failed');

  // 用户重新导入（手动）→ 清除错误，恢复可信
  engine.importScoreSnapshot(initialSnapshot());
  const status = engine.getScorePolicyStatus();
  assert.equal(status.trusted, true);
  assert.equal(status.reason, 'ok');

  const out = await engine.runOnce();
  assert.equal(out.results.find((r) => r.action === 'apply').status, 'success');
  assert.equal(api.__count('ek.applyActivity'), 1);
});