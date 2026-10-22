/**
 * 1CT 成员层（desktop/1ct/members.js）单元测试 —— Node 内置 test runner，离线、不触网。
 *
 * 运行：node --test desktop/test-1ct-members.cjs
 *
 * 覆盖（契约 docs/1ct-redesign-contract.md §2/§3 + 补充 v2）：
 *  - UMD：Node require 可得 createMembers；window 全局名为 OneCTMembers
 *  - 成员 CRUD：新增/更新/删除/选择；id 生成；未知字段不裁剪；损坏不崩
 *  - 存储键隔离：1ct:members / 1ct:config:global / 1ct:config:<id> /
 *    1ct:state:<id> / 1ct:scores:<id> / 1ct:results
 *  - engineStorage 映射：引擎固定 key → 成员维度；ek 会话/校园跑账号由成员合成
 *  - effectiveConfig 深合并；成员层 dryRun 被剔除且写入被拒绝
 *  - 结果历史：memberId/memberName 保留、key upsert、dry-run 不入库、90 天/2000 条有界
 *  - runAll：串行、多成员各自独立、memberId 注入、onResult 回调、单飞 busy、
 *    成员异常隔离、onlyMemberId、ek 会话自愈（refresh → 凭证重登 → 跳过 ek）
 *  - loginEk / refreshEk / verifyUnirun / setEkSession
 *  - 微信扫码登录（校园网外唯一链路）：qrLoginStart（data URI，不外链）/ qrLoginFinish
 *    （长轮询在主进程、会话校验、ekCredentials 保留）/ ekLoginErrorMessage（四类分支）/
 *    loginEk 失败把服务端原文透出到 error.detail
 *  - 官方成绩同步（task-8，取消手填八模块）：syncOfficialScores / syncAllOfficialScores
 *    · 8 模块 TypeList 解析、Info.AGetNum..JGetNum 位置交叉校验、不一致判 untrusted
 *    · 失败不覆盖旧值、并发单飞、写两处存储（member.ekModules + 1ct:scores:<id>）
 *    · 来源标记 ekModulesSource/ekModulesUpdatedAt、预览零上游请求
 *  - 安全：日志/导出/结果/异常文本不含 token、密码、完整手机号
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const MEMBERS_PATH = path.join(__dirname, '1ct', 'members.js');
const Members = require(MEMBERS_PATH);
const Automation = require('./automation.js');
const ScorePolicy = require('./score-policy.js');

const BJ = (y, m, d, hh = 0, mm = 0, ss = 0) => Date.UTC(y, m - 1, d, hh - 8, mm, ss);
const T0 = BJ(2026, 10, 17, 8, 0);
const DAY_MS = 24 * 60 * 60 * 1000;

// ───────────────────────────── 测试替身 ─────────────────────────────

function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    get(key) {
      return map.has(key) ? map.get(key) : null;
    },
    set(key, value) {
      map.set(key, String(value));
    },
    remove(key) {
      map.delete(key);
    },
    dump() {
      return Object.fromEntries(map);
    },
    raw(key) {
      return map.has(key) ? map.get(key) : null;
    },
  };
}

function makeClock(ms) {
  let now = ms;
  return {
    now: () => now,
    advance: (delta) => {
      now += delta;
    },
    set: (value) => {
      now = value;
    },
  };
}

/** 与 desktop/test-automation.cjs 同口径的 fake ctAPI（记录调用）。 */
function makeApi(overrides = {}) {
  const calls = [];
  const table = {
    unirun: {
      campusLocalList: () => [
        { id: 'campus-1', label: '主校区', mapName: 'm1.txt', schoolSiteIndex: 1, updatedAt: 1 },
      ],
      login: (payload) => ({
        token: 'unirun-token-secret',
        userId: 1,
        schoolId: 2,
        appVersion: '1',
        brand: 'x',
        mobileType: 'x',
        sysVersion: 'x',
        deviceToken: 'x',
        deviceType: 'x',
      }),
      sessionEnsure: () => ({
        userId: 1,
        schoolId: 2,
        studentId: 20230001,
        userName: '测试同学',
        schoolName: '示例大学',
      }),
      sessionClear: () => ({ ok: true }),
      autoRun: { code: 10000, response: { recordId: 7 }, msg: 'ok' },
    },
    ek: {
      login: () => ({
        JSESSIONID: 'session-secret',
        access_token: 'access-token-secret',
        refresh_token: 'refresh-token-secret',
        user_info: { loginName: '20230001', userName: '测试' },
      }),
      refreshToken: () => ({
        JSESSIONID: 'session-secret-2',
        access_token: 'access-token-secret-2',
        refresh_token: 'refresh-token-secret-2',
        user_info: { loginName: '20230001', userName: '测试' },
      }),
      getActivitiesList: { List: { Items: [] } },
      getActivityDetail: {},
      applyActivity: { errcode: 0 },
      signByQr: { errcode: 0 },
      signInOutByOthers: { errcode: 0 },
      activityBoundImages: { items: [] },
      getStudentScores: { code: 0, data: { TypeList: [] } },
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
        const value = table[group][name];
        const out = typeof value === 'function' ? await value(payload) : value;
        if (out instanceof Error) throw out;
        return out;
      };
    });
  });
  api.__calls = calls;
  api.__count = (name) => calls.filter((call) => call.name === name).length;
  api.__last = (name) => calls.filter((call) => call.name === name).pop();
  return api;
}

function makeMembers(opts = {}) {
  const storage = opts.storage || memoryStorage();
  const clock = opts.clock || makeClock(T0);
  const logs = [];
  const instance = Members.createMembers({
    storage,
    clock,
    automation: opts.automation || Automation,
  });
  return {
    members: instance,
    storage,
    clock,
    logs,
    logger: { log: (message) => logs.push(String(message)) },
  };
}

function ekSession(overrides = {}) {
  return Object.assign(
    {
      JSESSIONID: 'session-secret',
      access_token: 'access-token-secret',
      refresh_token: 'refresh-token-secret',
      user_info: { loginName: '20230001', userName: '测试' },
    },
    overrides,
  );
}

function ekCredentials(overrides = {}) {
  return Object.assign({ studentId: '20230001', password: 'secret-password' }, overrides);
}

function unirunAccount(overrides = {}) {
  return Object.assign(
    { id: 'acc-1', phone: '13800000000', password: 'run-password', remark: '主号', updatedAt: 1 },
    overrides,
  );
}

/** 一个可跑出真实结果的 config：校园跑启用、时间窗口命中、dryRun=false */
function runningConfig(overrides = {}) {
  return Object.assign(
    {
      dryRun: false,
      unirun: { enabled: true, runAt: '06:30', windowMinutes: 120 },
      ek: { enabled: false, scorePolicy: { enabled: false } },
      club: { enabled: false },
    },
    overrides,
  );
}

function addMember(members, overrides = {}) {
  return members.upsertMember(
    Object.assign(
      {
        name: '张三',
        enabled: true,
        ek: ekSession(),
        ekStatus: 'ok',
        unirun: unirunAccount(),
      },
      overrides,
    ),
  );
}

// ───────────────────────────── UMD / 导出面 ─────────────────────────────

test('UMD：Node require 得到工厂，window 全局名是 OneCTMembers', () => {
  assert.equal(typeof Members.createMembers, 'function');
  assert.equal(typeof Members.maskPhone, 'function');
  // 浏览器侧：factory 会挂 root.OneCTMembers；Node 下 globalThis 也被挂（root 存在即挂）
  assert.equal(typeof globalThis.OneCTMembers, 'object');
  assert.equal(typeof globalThis.OneCTMembers.createMembers, 'function');
});

test('工厂实例导出契约 §3 全部函数', () => {
  const { members } = makeMembers();
  [
    'load',
    'save',
    'upsertMember',
    'removeMember',
    'getMember',
    'selectMember',
    'engineStorage',
    'resultsStorage',
    'effectiveConfig',
    'setConfig',
    'saveConfig',
    'loadGlobalConfig',
    'saveGlobalConfig',
    'loginEk',
    'refreshEk',
    'verifyUnirun',
    'setEkSession',
    'runAll',
    // 补充导出
    'loadResults',
    'appendResult',
    'recordRound',
    'exportMembers',
    'toPublicMember',
    'isRunning',
  ].forEach((name) => {
    assert.equal(typeof members[name], 'function', '缺少导出：' + name);
  });
  assert.equal(members.KEYS.members, '1ct:members');
  assert.equal(members.KEYS.results, '1ct:results');
  assert.deepEqual(members.ENGINE_KEYS, {
    state: 'auto3ct:state',
    config: 'auto3ct:config',
    scores: 'auto3ct:scores',
    ekSession: 'ct_ek_session_v1',
    unirunAccounts: 'ct_unirun_accounts_v1',
  });
});

// ───────────────────────────── 成员 CRUD ─────────────────────────────

test('load 空存储返回 {version:1, selectedId:null, items:[]}', () => {
  const { members } = makeMembers();
  assert.deepEqual(members.load(), { version: 1, selectedId: null, items: [] });
});

test('upsertMember 生成 m_xxx id、补默认字段、首个成员自动选中', () => {
  const { members } = makeMembers();
  const member = members.upsertMember({ name: '张三' });
  assert.match(member.id, /^m_[0-9a-f]{8}$/);
  assert.equal(member.name, '张三');
  assert.equal(member.note, '');
  assert.equal(member.enabled, true);
  assert.equal(member.ek, null);
  assert.equal(member.ekStatus, 'none');
  assert.equal(member.ekCredentials, null);
  assert.equal(member.unirun, null);
  assert.equal(member.ekModules, null);
  assert.equal(member.createdAt, T0);
  assert.equal(member.updatedAt, T0);
  const state = members.load();
  assert.equal(state.items.length, 1);
  assert.equal(state.selectedId, member.id);
});

test('upsertMember 更新已有成员：字段合并、id/createdAt 不变、updatedAt 刷新', () => {
  const { members, clock } = makeMembers();
  const member = addMember(members);
  clock.advance(60 * 1000);
  const updated = members.upsertMember({ id: member.id, name: '李四', note: '备注' });
  assert.equal(updated.id, member.id, 'id 不可改');
  assert.equal(updated.createdAt, T0, 'createdAt 不可改');
  assert.equal(updated.updatedAt, T0 + 60 * 1000);
  assert.equal(updated.name, '李四');
  assert.equal(updated.note, '备注');
  assert.deepEqual(updated.ek, ekSession(), '未提交的字段保留');
  assert.equal(members.load().items.length, 1, '不会新增重复成员');
});

test('upsertMember 不做字段白名单裁剪：未知字段/ekCredentials 原样保留', () => {
  const { members } = makeMembers();
  const member = members.upsertMember({
    name: '张三',
    ekCredentials: ekCredentials(),
    ekModules: [{ name: '思想政治与道德修养', required: 12, current: 6 }],
    customField: { nested: ['a', 1, true] },
    futureFlag: 'keep-me',
  });
  const loaded = members.getMember(member.id);
  assert.deepEqual(loaded.ekCredentials, ekCredentials());
  assert.deepEqual(loaded.ekModules, [{ name: '思想政治与道德修养', required: 12, current: 6 }]);
  assert.deepEqual(loaded.customField, { nested: ['a', 1, true] });
  assert.equal(loaded.futureFlag, 'keep-me');
});

test('removeMember 删除成员并清理该成员的 state/scores/config，选中项回落到首个', () => {
  const { members, storage } = makeMembers();
  const first = addMember(members, { name: 'A' });
  const second = addMember(members, { name: 'B' });
  members.selectMember(second.id);
  const engineStorage = members.engineStorage(second.id);
  engineStorage.set('auto3ct:state', '{"done":{}}');
  engineStorage.set('auto3ct:scores', '{"version":1,"accounts":{}}');
  members.saveConfig(second.id, { unirun: { runDistance: 2000 } });
  assert.ok(storage.raw('1ct:state:' + second.id));

  const removed = members.removeMember(second.id);
  assert.equal(removed.id, second.id);
  assert.equal(members.getMember(second.id), null);
  assert.equal(members.load().selectedId, first.id);
  assert.equal(storage.raw('1ct:state:' + second.id), null, '成员运行态应被清理');
  assert.equal(storage.raw('1ct:scores:' + second.id), null, '成员积分应被清理');
  assert.equal(storage.raw('1ct:config:' + second.id), null, '成员 config 应被清理');
});

test('getMember/selectMember/hasMember 边界：未知 id 返回 null、选中非法 id 不生效', () => {
  const { members } = makeMembers();
  const member = addMember(members);
  assert.equal(members.getMember('m_doesnotexist'), null);
  assert.equal(members.getMember(''), null);
  assert.equal(members.hasMember(member.id), true);
  assert.equal(members.hasMember('nope'), false);
  const after = members.selectMember('m_doesnotexist');
  assert.equal(after.selectedId, member.id, '非法 id 不改变选中');
  assert.equal(members.selectMember(null).selectedId, null);
});

test('成员存储损坏：load 标记 corrupt，写操作抛 members-corrupt（不静默覆盖）', () => {
  const storage = memoryStorage({ '1ct:members': '{not json' });
  const { members } = makeMembers({ storage });
  const state = members.load();
  assert.equal(state.corrupt, true);
  assert.equal(state.error, 'members-corrupt');
  assert.deepEqual(state.items, []);
  assert.throws(() => members.upsertMember({ name: 'X' }), /members-corrupt/);
  assert.equal(storage.raw('1ct:members'), '{not json', '损坏数据不被静默覆盖');
});

test('save 全量写入并去重 id', () => {
  const { members } = makeMembers();
  const saved = members.save({
    selectedId: 'm_aaaa1111',
    items: [
      { id: 'm_aaaa1111', name: 'A' },
      { id: 'm_aaaa1111', name: 'A 重复' },
      { name: 'B' },
    ],
  });
  assert.equal(saved.items.length, 2, '重复 id 只保留第一个');
  assert.equal(saved.selectedId, 'm_aaaa1111');
  assert.match(saved.items[1].id, /^m_[0-9a-f]{8}$/);
});

// ───────────────────────────── 存储键 / engineStorage 映射 ─────────────────────────────

test('engineStorage 把引擎固定 key 映射到成员键，并做成员隔离', () => {
  const { members, storage } = makeMembers();
  const a = addMember(members, { name: 'A' });
  const b = addMember(members, { name: 'B' });

  const storageA = members.engineStorage(a.id);
  const storageB = members.engineStorage(b.id);

  storageA.set('auto3ct:state', '{"done":{"k":"a"}}');
  storageB.set('auto3ct:state', '{"done":{"k":"b"}}');
  storageA.set('auto3ct:scores', '{"version":1,"accounts":{"20230001":{}}}');
  storageA.set('auto3ct:config', JSON.stringify({ unirun: { runDistance: 5000 } }));

  assert.equal(storage.raw('1ct:state:' + a.id), '{"done":{"k":"a"}}');
  assert.equal(storage.raw('1ct:state:' + b.id), '{"done":{"k":"b"}}');
  assert.equal(storage.raw('1ct:scores:' + a.id), '{"version":1,"accounts":{"20230001":{}}}');
  assert.equal(storage.raw('1ct:scores:' + b.id), null);
  assert.deepEqual(JSON.parse(storage.raw('1ct:config:' + a.id)), { unirun: { runDistance: 5000 } });

  assert.equal(storageA.get('auto3ct:state'), '{"done":{"k":"a"}}');
  assert.equal(storageB.get('auto3ct:state'), '{"done":{"k":"b"}}');
  assert.equal(storageA.get('auto3ct:scores'), '{"version":1,"accounts":{"20230001":{}}}');
  assert.equal(storageB.get('auto3ct:scores'), null, 'A 的积分不会被 B 读到');
  assert.deepEqual(JSON.parse(storageA.get('auto3ct:config')), { unirun: { runDistance: 5000 } });
  assert.equal(storageB.get('auto3ct:config'), null);

  storageA.remove('auto3ct:state');
  assert.equal(storageA.get('auto3ct:state'), null);
  assert.equal(storageB.get('auto3ct:state'), '{"done":{"k":"b"}}', '删除 A 不影响 B');
});

test('engineStorage 的 ek 会话来自 member.ek；无会话返回 null', () => {
  const { members } = makeMembers();
  const withSession = addMember(members, { ek: ekSession() });
  const noSession = addMember(members, { ek: null, ekStatus: 'none' });

  assert.deepEqual(JSON.parse(members.engineStorage(withSession.id).get('ct_ek_session_v1')), ekSession());
  assert.equal(members.engineStorage(noSession.id).get('ct_ek_session_v1'), null);

  // 引擎写入会话 → 回写成员
  const next = ekSession({ access_token: 'new-access-token' });
  members.engineStorage(withSession.id).set('ct_ek_session_v1', JSON.stringify(next));
  const member = members.getMember(withSession.id);
  assert.equal(member.ek.access_token, 'new-access-token');
  assert.equal(member.ekStatus, 'ok');
  assert.equal(member.ekUpdatedAt, T0);

  // 写入空会话 → 清空
  members.engineStorage(withSession.id).set('ct_ek_session_v1', 'null');
  assert.equal(members.getMember(withSession.id).ek, null);
  assert.equal(members.getMember(withSession.id).ekStatus, 'none');
});

test('engineStorage 的 ct_unirun_accounts_v1 由 member.unirun 合成，且只含本成员账号', () => {
  const { members } = makeMembers();
  const a = addMember(members, { unirun: unirunAccount({ id: 'acc-a', phone: '13800000001' }) });
  const b = addMember(members, { unirun: unirunAccount({ id: 'acc-b', phone: '13900000002' }) });
  const noAccount = addMember(members, { unirun: null });

  const payloadA = JSON.parse(members.engineStorage(a.id).get('ct_unirun_accounts_v1'));
  assert.equal(payloadA.selectedId, 'acc-a');
  assert.equal(payloadA.items.length, 1);
  assert.equal(payloadA.items[0].phone, '13800000001');

  const payloadB = JSON.parse(members.engineStorage(b.id).get('ct_unirun_accounts_v1'));
  assert.equal(payloadB.selectedId, 'acc-b');
  assert.equal(payloadB.items[0].phone, '13900000002');

  const payloadNone = JSON.parse(members.engineStorage(noAccount.id).get('ct_unirun_accounts_v1'));
  assert.deepEqual(payloadNone, { selectedId: null, items: [] });

  // 引擎写入 → 回写成员 unirun
  members
    .engineStorage(a.id)
    .set(
      'ct_unirun_accounts_v1',
      JSON.stringify({ selectedId: 'acc-a', items: [unirunAccount({ id: 'acc-a', phone: '13700000003' })] }),
    );
  assert.equal(members.getMember(a.id).unirun.phone, '13700000003');
});

test('engineStorage 映射表外的 key 落到成员命名空间（不污染全局）', () => {
  const { members, storage } = makeMembers();
  const member = addMember(members);
  const adapter = members.engineStorage(member.id);
  adapter.set('some-other-key', 'value');
  assert.equal(adapter.get('some-other-key'), 'value');
  assert.equal(storage.raw('some-other-key'), null, '不会写到全局同名 key');
});

test('resultsStorage 映射 auto3ct:results → 1ct:results（全局共享）', () => {
  const { members, storage } = makeMembers();
  const adapter = members.resultsStorage();
  adapter.set('auto3ct:results', '{"version":1,"events":[]}');
  assert.equal(storage.raw('1ct:results'), '{"version":1,"events":[]}');
  assert.equal(adapter.get('auto3ct:results'), '{"version":1,"events":[]}');
  adapter.remove('auto3ct:results');
  assert.equal(storage.raw('1ct:results'), null);
});

test('Auto3CTResults 用 resultsStorage 可正常读写（兜底通道）', () => {
  const { members, storage } = makeMembers();
  const store = require('./result-store.js').createStore({
    storage: members.resultsStorage(),
    clock: makeClock(T0),
  });
  const ok = store.append({
    key: '2026-10-17|20230001|ek|act-1|signIn',
    at: T0,
    accountId: '20230001',
    module: 'ek',
    action: 'signIn',
    activityId: 'act-1',
    status: 'success',
  });
  assert.equal(ok, true);
  assert.ok(storage.raw('1ct:results'));
  assert.equal(store.list().length, 1);
});

// ───────────────────────────── config ─────────────────────────────

test('effectiveConfig = automation.DEFAULTS ⌄ global；未配置时 dryRun 默认 true', () => {
  const { members } = makeMembers();
  const member = addMember(members);
  const config = members.effectiveConfig(member.id);
  assert.equal(config.dryRun, true, '默认必须是 dry-run（安全底线）');
  assert.equal(config.ek.enabled, false);
  assert.equal(config.tickMs, Automation.DEFAULTS.tickMs);
  assert.deepEqual(members.effectiveConfig('m_unknown'), members.effectiveConfig(null), '未知成员等于全局');
});

test('saveGlobalConfig 深合并并落 1ct:config:global', () => {
  const { members, storage } = makeMembers();
  const merged = members.saveGlobalConfig({ dryRun: false, ek: { enabled: true } });
  assert.equal(merged.dryRun, false);
  assert.equal(merged.ek.enabled, true);
  assert.equal(merged.ek.apply, true, '未覆盖的默认值保留');
  const persisted = JSON.parse(storage.raw('1ct:config:global'));
  assert.deepEqual(persisted, { dryRun: false, ek: { enabled: true } });
  assert.equal(members.loadGlobalConfig().dryRun, false);
  assert.equal(members.loadGlobalConfig().ek.enabled, true);
});

test('saveConfig(null) 等价 saveGlobalConfig；成员层深合并且独立', () => {
  const { members, storage } = makeMembers();
  const a = addMember(members, { name: 'A' });
  const b = addMember(members, { name: 'B' });

  members.saveConfig(null, { unirun: { runDistance: 3000 } });
  members.saveConfig(a.id, { unirun: { runDistance: 5000 } });
  members.saveConfig(b.id, { club: { keywords: ['篮球'] } });

  assert.deepEqual(JSON.parse(storage.raw('1ct:config:global')), { unirun: { runDistance: 3000 } });
  assert.equal(members.effectiveConfig(a.id).unirun.runDistance, 5000);
  assert.equal(members.effectiveConfig(b.id).unirun.runDistance, 3000, '未覆盖的成员继承全局');
  assert.deepEqual(members.effectiveConfig(b.id).club.keywords, ['篮球']);
  assert.deepEqual(members.effectiveConfig(a.id).club.keywords, [], '成员覆盖互不影响');
});

test('成员层写 dryRun 被拒绝：{rejected:"dryRun-global-only"}，且不落盘', () => {
  const { members, storage } = makeMembers();
  const member = addMember(members);
  const rejected = members.saveConfig(member.id, { dryRun: false, unirun: { runDistance: 5000 } });
  assert.deepEqual(rejected, { rejected: 'dryRun-global-only' });
  assert.equal(storage.raw('1ct:config:' + member.id), null, '拒绝时整条 patch 不落盘');
  assert.equal(members.effectiveConfig(member.id).dryRun, true);
  // 别名 setConfig 同语义
  assert.deepEqual(members.setConfig(member.id, { dryRun: true }), { rejected: 'dryRun-global-only' });
  // 全局层允许
  members.saveConfig(null, { dryRun: false });
  assert.equal(members.effectiveConfig(member.id).dryRun, false);
});

test('effectiveConfig 剔除成员层历史遗留的 dryRun（防旧数据绕过预览开关）', () => {
  const { members, storage } = makeMembers();
  const member = addMember(members);
  storage.set('1ct:config:' + member.id, JSON.stringify({ dryRun: false, unirun: { runDistance: 5000 } }));
  const config = members.effectiveConfig(member.id);
  assert.equal(config.dryRun, true, '成员层 dryRun 必须被忽略');
  assert.equal(config.unirun.runDistance, 5000);
  // engineStorage 也不把 dryRun 交给引擎
  assert.equal(JSON.parse(members.engineStorage(member.id).get('auto3ct:config')).dryRun, undefined);
});

test('saveConfig 对未知成员返回 rejected:unknown-member', () => {
  const { members } = makeMembers();
  assert.deepEqual(members.saveConfig('m_nope', { club: { enabled: true } }), {
    rejected: 'unknown-member',
  });
});

// ───────────────────────────── 二课会话 / 凭证 ─────────────────────────────

test('setEkSession 写回 member.ek + ekStatus=ok；非法会话抛错且不写', () => {
  const { members } = makeMembers();
  const member = addMember(members, { ek: null, ekStatus: 'none' });
  const updated = members.setEkSession(member.id, ekSession());
  assert.deepEqual(updated.ek, ekSession());
  assert.equal(updated.ekStatus, 'ok');
  assert.equal(updated.ekUpdatedAt, T0);
  assert.throws(() => members.setEkSession(member.id, { JSESSIONID: 'x' }), /ek-session-invalid/);
  assert.throws(() => members.setEkSession('m_nope', ekSession()), /member-not-found/);
  assert.deepEqual(members.getMember(member.id).ek, ekSession(), '非法会话不覆盖已有会话');
});

test('loginEk 用学号密码登录，写回会话 + 凭证 + ekStatus，日志不含密码', async () => {
  const api = makeApi();
  const { members, logs } = makeMembers();
  const member = addMember(members, { ek: null, ekStatus: 'none' });
  const updated = await members.loginEk(
    member.id,
    { student_id: '20230001', password: 'secret-password' },
    { api },
  );
  assert.deepEqual(updated.ek, ekSession());
  assert.equal(updated.ekStatus, 'ok');
  assert.deepEqual(updated.ekCredentials, ekCredentials());
  assert.equal(api.__count('ek.login'), 1);
  assert.deepEqual(api.__last('ek.login').payload, { student_id: '20230001', password: 'secret-password' });
  const dump = JSON.stringify(logs);
  assert.equal(dump.includes('secret-password'), false, '日志不得含密码');
  assert.equal(dump.includes('access-token-secret'), false, '日志不得含 token');
});

test('loginEk 失败抛固定 code（不泄露上游原文/敏感串）', async () => {
  const api = makeApi({
    ek: {
      login: () => {
        throw new Error('login failed password=secret-password token=access-token-secret 13800000000');
      },
    },
  });
  const { members } = makeMembers();
  const member = addMember(members, { ek: null, ekStatus: 'none' });
  await assert.rejects(
    () => members.loginEk(member.id, { student_id: '20230001', password: 'secret-password' }, { api }),
    (error) => {
      assert.equal(error.code, 'ek-login-failed');
      assert.equal(String(error.message).includes('secret-password'), false);
      assert.equal(String(error.cause || '').includes('secret-password'), false);
      assert.equal(String(error.cause || '').includes('13800000000'), false, '完整手机号必须脱敏');
      return true;
    },
  );
  assert.equal(members.getMember(member.id).ekStatus, 'none', '登录失败不改会话状态');
});

test('loginEk 参数缺失 / 无 api / 无成员 分别抛固定 code', async () => {
  const { members } = makeMembers();
  const member = addMember(members, { ek: null });
  await assert.rejects(() => members.loginEk(member.id, {}, { api: makeApi() }), /ek-credentials-required/);
  await assert.rejects(
    () => members.loginEk(member.id, { student_id: '1', password: '2' }, { api: {} }),
    /ek-login-unavailable/,
  );
  await assert.rejects(
    () => members.loginEk('m_nope', { student_id: '1', password: '2' }, { api: makeApi() }),
    /member-not-found/,
  );
});

test('refreshEk 续期成功写回新会话并保持 ekStatus=ok', async () => {
  const api = makeApi();
  const { members } = makeMembers();
  const member = addMember(members, { ek: ekSession({ access_token: 'old-access-token' }) });
  const updated = await members.refreshEk(member.id, { api });
  assert.equal(updated.ek.access_token, 'access-token-secret-2');
  assert.equal(updated.ekStatus, 'ok');
  assert.equal(updated.ekUpdatedAt, T0);
  assert.deepEqual(api.__last('ek.refreshToken').payload, {
    requestsData: ekSession({ access_token: 'old-access-token' }),
  });
});

test('refreshEk 失败把 ekStatus 置 expired，并抛固定 code', async () => {
  const api = makeApi({
    ek: {
      refreshToken: () => {
        throw new Error('EK_FORCE_LOGOUT:REFRESH_CHECK_FAILED user 13800000000');
      },
    },
  });
  const { members } = makeMembers();
  const member = addMember(members);
  await assert.rejects(() => members.refreshEk(member.id, { api }), (error) => {
    assert.equal(error.code, 'ek-refresh-failed');
    assert.equal(String(error.cause || '').includes('13800000000'), false);
    return true;
  });
  assert.equal(members.getMember(member.id).ekStatus, 'expired');
});

test('refreshEk 无会话时置 expired 并抛 ek-session-missing', async () => {
  const { members } = makeMembers();
  const member = addMember(members, { ek: null, ekStatus: 'none' });
  await assert.rejects(() => members.refreshEk(member.id, { api: makeApi() }), /ek-session-missing/);
  assert.equal(members.getMember(member.id).ekStatus, 'expired');
});

test('verifyUnirun：优先 sessionEnsure（不回传 token），只返回 studentId/schoolName', async () => {
  const api = makeApi();
  const { members } = makeMembers();
  const member = addMember(members);
  const result = await members.verifyUnirun(member.id, { api });
  assert.deepEqual(result, {
    ok: true,
    studentId: '20230001',
    schoolName: '示例大学',
    userName: '测试同学',
  });
  assert.equal(api.__count('unirun.login'), 0, 'sessionEnsure 可用时不调 login');
  assert.equal(JSON.stringify(result).includes('unirun-token-secret'), false);
});

test('verifyUnirun：无 sessionEnsure 时退回 login，且丢弃 token 不返回', async () => {
  const api = makeApi();
  delete api.unirun.sessionEnsure;
  const { members, storage } = makeMembers();
  const member = addMember(members);
  const result = await members.verifyUnirun(member.id, { api });
  assert.equal(result.ok, true);
  assert.equal(api.__count('unirun.login'), 1);
  assert.equal(JSON.stringify(result).includes('unirun-token-secret'), false);
  assert.equal(JSON.stringify(storage.dump()).includes('unirun-token-secret'), false, 'token 不落盘');
});

test('verifyUnirun：无账号/无 api/登录失败/无成员 都返回 ok:false + reason', async () => {
  const { members } = makeMembers();
  const noAccount = addMember(members, { unirun: null });
  assert.deepEqual(await members.verifyUnirun(noAccount.id, { api: makeApi() }), {
    ok: false,
    reason: 'no-unirun-account',
  });
  const member = addMember(members);
  assert.deepEqual(await members.verifyUnirun(member.id, { api: {} }), {
    ok: false,
    reason: 'unirun-unavailable',
  });
  assert.deepEqual(await members.verifyUnirun('m_nope', { api: makeApi() }), {
    ok: false,
    reason: 'member-not-found',
  });
  const failing = makeApi({
    unirun: {
      sessionEnsure: () => {
        throw new Error('密码错误 password=run-password');
      },
    },
  });
  const failed = await members.verifyUnirun(member.id, { api: failing });
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'unirun-login-failed');
  assert.equal(JSON.stringify(failed).includes('run-password'), false);
});

// ─────────────────── 微信扫码登录（校园网外唯一链路） ───────────────────

/** 主进程 wxLoginStart 的返回形状（client.ts:EkWxLoginStartResponse） */
function ekWxStart(overrides = {}) {
  return Object.assign(
    {
      appid: 'wx-appid',
      state: 'wx-state-1',
      uuid: 'wx-uuid-1',
      qrUrl: 'https://open.weixin.qq.com/connect/confirm?uuid=wx-uuid-1',
      qrImgUrl: 'https://open.weixin.qq.com/connect/qrcode/wx-uuid-1',
    },
    overrides,
  );
}

const QR_DATA_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
const OUTSIDE_CAMPUS_MSG =
  '登录失败(在校园网外的地方不支持账号密码登录，请使用微信扫码登录！)';

/** 带扫码 API 的 fake：wxLoginStart 返回参数，wxQrImage 返回 data URI */
function qrApi(overrides = {}) {
  return makeApi({
    ek: Object.assign(
      {
        wxLoginStart: () => ekWxStart(),
        wxQrImage: () => QR_DATA_URI,
        wxLoginComplete: () => ekSession(),
      },
      overrides,
    ),
  });
}

test('qrLoginStart 返回 {uuid,state,imageDataUri}，图片走 wxQrImage 的 data URI（不用外链）', async () => {
  const api = qrApi();
  const { members } = makeMembers();
  const out = await members.qrLoginStart({ api });
  assert.deepEqual(out, { uuid: 'wx-uuid-1', state: 'wx-state-1', imageDataUri: QR_DATA_URI });
  assert.equal(api.__count('ek.wxLoginStart'), 1);
  assert.deepEqual(api.__last('ek.wxQrImage').payload, { uuid: 'wx-uuid-1' });
  // CSP 只放行 data:/blob:/self：绝不能把 open.weixin.qq.com 外链透出去
  assert.equal(JSON.stringify(out).includes('open.weixin.qq.com'), false);
});

test('qrLoginStart 缺 wxLoginStart / wxQrImage 抛 ek-qr-unavailable（UI 据此隐藏扫码入口）', async () => {
  const { members } = makeMembers();
  await assert.rejects(() => members.qrLoginStart({ api: makeApi() }), /ek-qr-unavailable/);
  await assert.rejects(() => members.qrLoginStart({ api: {} }), /ek-qr-unavailable/);
  const noImage = qrApi();
  delete noImage.ek.wxQrImage;
  await assert.rejects(() => members.qrLoginStart({ api: noImage }), /ek-qr-unavailable/);
});

test('qrLoginStart 图片不是 data URI → ek-qr-image-invalid', async () => {
  const { members } = makeMembers();
  const external = qrApi({ wxQrImage: () => 'https://open.weixin.qq.com/connect/qrcode/wx-uuid-1' });
  await assert.rejects(() => members.qrLoginStart({ api: external }), /ek-qr-image-invalid/);
  const empty = qrApi({ wxQrImage: () => '' });
  await assert.rejects(() => members.qrLoginStart({ api: empty }), /ek-qr-image-invalid/);
});

test('qrLoginStart 扫码参数缺失 / 上游异常 → ek-qr-start-failed 且原文脱敏', async () => {
  const { members } = makeMembers();
  await assert.rejects(
    () => members.qrLoginStart({ api: qrApi({ wxLoginStart: () => ekWxStart({ uuid: '' }) }) }),
    /ek-qr-start-failed/,
  );
  await assert.rejects(
    () => members.qrLoginStart({ api: qrApi({ wxLoginStart: () => ekWxStart({ state: '' }) }) }),
    /ek-qr-start-failed/,
  );
  const broken = qrApi({
    wxQrImage: () => {
      throw new Error('拉取二维码图片失败：HTTP 500 JSESSIONID=session-secret 13800000000');
    },
  });
  await assert.rejects(
    () => members.qrLoginStart({ api: broken }),
    (error) => {
      assert.equal(error.code, 'ek-qr-start-failed');
      assert.equal(String(error.detail).includes('session-secret'), false, 'JSESSIONID 必须脱敏');
      assert.equal(String(error.detail).includes('13800000000'), false, '手机号必须脱敏');
      return true;
    },
  );
});

test('qrLoginFinish 成功写会话 + ekStatus=ok + ekUpdatedAt，ekCredentials 原样保留', async () => {
  const api = qrApi();
  const { members } = makeMembers();
  const member = addMember(members, { ek: null, ekStatus: 'none', ekCredentials: ekCredentials() });
  const updated = await members.qrLoginFinish(member.id, { uuid: 'wx-uuid-1', state: 'wx-state-1' }, { api });
  assert.deepEqual(api.__last('ek.wxLoginComplete').payload, { uuid: 'wx-uuid-1', state: 'wx-state-1' });
  assert.deepEqual(updated.ek, ekSession());
  assert.equal(updated.ekStatus, 'ok');
  assert.equal(updated.ekUpdatedAt, T0);
  assert.deepEqual(updated.ekCredentials, ekCredentials());
  assert.deepEqual(members.getMember(member.id).ek, ekSession(), '已落盘');
});

test('qrLoginFinish 会话形状非法 → ek-qr-login-failed，且不覆盖已有会话', async () => {
  const { members } = makeMembers();
  const member = addMember(members, { ek: null, ekStatus: 'none' });
  const invalid = qrApi({ wxLoginComplete: () => ({ JSESSIONID: 'only-cookie' }) });
  await assert.rejects(
    () => members.qrLoginFinish(member.id, { uuid: 'wx-uuid-1', state: 'wx-state-1' }, { api: invalid }),
    (error) => {
      assert.equal(error.code, 'ek-qr-login-failed');
      return true;
    },
  );
  const after = members.getMember(member.id);
  assert.equal(after.ek, null);
  assert.equal(after.ekStatus, 'none');
});

test('qrLoginFinish 底层报错 → ek-qr-login-failed，detail 保留原文并脱敏', async () => {
  const { members } = makeMembers();
  const member = addMember(members, { ek: null, ekStatus: 'none' });
  const broken = qrApi({
    wxLoginComplete: () => {
      throw new Error('二维码已过期，请重新获取 JSESSIONID=session-secret access_token=access-token-secret');
    },
  });
  await assert.rejects(
    () => members.qrLoginFinish(member.id, { uuid: 'wx-uuid-1', state: 'wx-state-1' }, { api: broken }),
    (error) => {
      assert.equal(error.code, 'ek-qr-login-failed');
      assert.equal(String(error.detail).includes('二维码已过期'), true, '原文要能指导用户重扫');
      assert.equal(String(error.detail).includes('session-secret'), false);
      assert.equal(String(error.detail).includes('access-token-secret'), false);
      return true;
    },
  );
});

test('qrLoginFinish 参数缺失 / 无成员 / 无扫码 API 分别抛固定 code', async () => {
  const { members } = makeMembers();
  const member = addMember(members, { ek: null, ekStatus: 'none' });
  await assert.rejects(() => members.qrLoginFinish(member.id, {}, { api: qrApi() }), /ek-qr-params-required/);
  await assert.rejects(
    () => members.qrLoginFinish(member.id, { uuid: 'u' }, { api: qrApi() }),
    /ek-qr-params-required/,
  );
  await assert.rejects(
    () => members.qrLoginFinish('m_nope', { uuid: 'u', state: 's' }, { api: qrApi() }),
    /member-not-found/,
  );
  await assert.rejects(
    () => members.qrLoginFinish(member.id, { uuid: 'u', state: 's' }, { api: makeApi() }),
    /ek-qr-unavailable/,
  );
});

test('ekLoginErrorMessage：校外限制返回服务端原文 + needQr=true', () => {
  const { members } = makeMembers();
  assert.deepEqual(members.ekLoginErrorMessage({ code: 'ek-login-failed', detail: OUTSIDE_CAMPUS_MSG }), {
    text: OUTSIDE_CAMPUS_MSG,
    needQr: true,
  });
  // 只给 message 也认（IPC 抛错没有 detail）
  assert.deepEqual(members.ekLoginErrorMessage(new Error(OUTSIDE_CAMPUS_MSG)), {
    text: OUTSIDE_CAMPUS_MSG,
    needQr: true,
  });
});

test('ekLoginErrorMessage：账号不存在 / 密码 / 网络 / 兜底 四类分支', () => {
  const { members } = makeMembers();
  assert.deepEqual(members.ekLoginErrorMessage(new Error('账号不存在')), {
    text: '学号不存在，请检查',
    needQr: false,
  });
  assert.deepEqual(members.ekLoginErrorMessage(new Error('用户名或密码错误')), {
    text: '密码错误',
    needQr: false,
  });
  ['网络连接失败', '请求超时', 'connect ETIMEDOUT 1.2.3.4:443'].forEach((message) => {
    assert.deepEqual(members.ekLoginErrorMessage(new Error(message)), {
      text: '网络异常，请稍后重试',
      needQr: false,
    });
  });
  assert.deepEqual(members.ekLoginErrorMessage(new Error('遇到未知的服务端错误')), {
    text: '遇到未知的服务端错误',
    needQr: false,
  });
  // 没有任何可展示原文时给中文兜底，不把 ek-xxx 抛给用户
  assert.deepEqual(members.ekLoginErrorMessage({ code: 'ek-login-unavailable' }), {
    text: '二课登录接口不可用，请重启应用后重试',
    needQr: false,
  });
  assert.deepEqual(members.ekLoginErrorMessage(null), { text: '二课登录失败', needQr: false });
});

test('ekLoginErrorMessage：文案不泄露密码 / token / 完整手机号', () => {
  const { members } = makeMembers();
  const out = members.ekLoginErrorMessage(
    new Error('login failed password=secret-password access_token=access-token-secret 13800000000'),
  );
  const dump = JSON.stringify(out);
  assert.equal(dump.includes('secret-password'), false);
  assert.equal(dump.includes('access-token-secret'), false);
  assert.equal(dump.includes('13800000000'), false);
});

test('loginEk 失败把服务端原文放进 error.detail（校外提示 UI 可见并引导扫码）', async () => {
  const api = makeApi({
    ek: {
      login: () => {
        throw new Error(OUTSIDE_CAMPUS_MSG);
      },
    },
  });
  const { members } = makeMembers();
  const member = addMember(members, { ek: null, ekStatus: 'none' });
  await assert.rejects(
    () => members.loginEk(member.id, { student_id: '20230001', password: 'secret-password' }, { api }),
    (error) => {
      assert.equal(error.code, 'ek-login-failed');
      assert.equal(error.detail.includes('校园网外'), true, '服务端原文必须透出到 detail');
      assert.equal(error.detail.includes('secret-password'), false);
      const shown = members.ekLoginErrorMessage(error);
      assert.equal(shown.needQr, true);
      assert.equal(shown.text, OUTSIDE_CAMPUS_MSG);
      return true;
    },
  );
  assert.equal(members.getMember(member.id).ekStatus, 'none', '失败不改会话状态');
});

test('扫码 API 同时挂到 window.OneCTMembers 单例', () => {
  ['qrLoginStart', 'qrLoginFinish', 'ekLoginErrorMessage'].forEach((name) => {
    assert.equal(typeof globalThis.OneCTMembers[name], 'function', '单例缺少：' + name);
  });
});

// ───────────────────────────── 结果历史 ─────────────────────────────

test('recordRound 保留 memberId/memberName，按 key upsert 不重复', () => {
  const { members } = makeMembers();
  const row = {
    key: '2026-10-17|20230001|ek|act-1|signIn',
    at: T0,
    accountId: '20230001',
    module: 'ek',
    action: 'signIn',
    activityId: 'act-1',
    activityName: '讲座',
    status: 'success',
  };
  const first = members.recordRound({ memberId: 'm_1', memberName: '张三', results: [row], at: T0 });
  assert.equal(first.recorded, 1);
  assert.equal(first.inserted, 1);
  const second = members.recordRound({ memberId: 'm_1', memberName: '张三', results: [row], at: T0 + 1000 });
  assert.equal(second.recorded, 1);
  assert.equal(second.updated, 1);
  const events = members.loadResults();
  assert.equal(events.length, 1);
  assert.equal(events[0].memberId, 'm_1');
  assert.equal(events[0].memberName, '张三');
});

test('recordRound dry-run 轮整轮不入库', () => {
  const { members, storage } = makeMembers();
  const result = members.recordRound({
    memberId: 'm_1',
    results: [{ key: 'k', status: 'dry-run', module: 'ek', action: 'signIn', at: T0 }],
    dryRun: true,
  });
  assert.equal(result.preview, true);
  assert.equal(result.recorded, 0);
  assert.equal(storage.raw('1ct:results'), null);
});

test('appendResult：成功不被 skipped 降级；reason 不落自由文本', () => {
  const { members } = makeMembers();
  const base = {
    key: 'k-1',
    at: T0,
    memberId: 'm_1',
    memberName: '张三',
    module: 'ek',
    action: 'signIn',
    status: 'success',
  };
  members.appendResult(base);
  members.appendResult(Object.assign({}, base, { status: 'skipped', reason: 'already-done' }));
  let events = members.loadResults();
  assert.equal(events.length, 1);
  assert.equal(events[0].status, 'success', 'success 不被降级');

  members.appendResult(
    Object.assign({}, base, {
      key: 'k-2',
      status: 'failed',
      reason: '密码是 secret-password 手机 13800000000',
    }),
  );
  events = members.loadResults();
  const failed = events.find((event) => event.key === 'k-2');
  assert.equal(failed.reason, 'suppressed-untrusted-reason');
  assert.equal(JSON.stringify(events).includes('secret-password'), false);
  assert.equal(JSON.stringify(events).includes('13800000000'), false);
});

test('结果历史有界：超出 2000 条时裁掉最旧', () => {
  const storage = memoryStorage();
  const clock = makeClock(T0);
  const members = Members.createMembers({ storage, clock, automation: Automation });
  const events = [];
  for (let i = 0; i < 2005; i += 1) {
    events.push({
      key: 'k-' + i,
      at: T0 + i * 1000,
      day: '2026-10-17',
      module: 'ek',
      action: 'signIn',
      status: 'success',
      memberId: 'm_1',
      memberName: '张三',
    });
  }
  storage.set('1ct:results', JSON.stringify({ version: 1, events }));
  const loaded = members.loadResults();
  assert.equal(loaded.length, 2000);
  assert.equal(loaded[0].key, 'k-2004', '新的在前');
});

test('结果历史保留窗口：超过 90 天的事件被剔除', () => {
  const storage = memoryStorage();
  const clock = makeClock(T0);
  const members = Members.createMembers({ storage, clock, automation: Automation });
  storage.set(
    '1ct:results',
    JSON.stringify({
      version: 1,
      events: [
        { key: 'old', at: T0 - 120 * DAY_MS, day: '2026-06-19', module: 'ek', action: 'signIn', status: 'success' },
        { key: 'new', at: T0 - 1 * DAY_MS, day: '2026-10-16', module: 'ek', action: 'signIn', status: 'success' },
      ],
    }),
  );
  const loaded = members.loadResults();
  assert.deepEqual(loaded.map((event) => event.key), ['new']);
});

test('结果事件里的手机号账号被脱敏（key 与 accountId 都不落完整号）', () => {
  const { members } = makeMembers();
  members.appendResult({
    key: '2026-10-17|13800000000|unirun|daily|run',
    at: T0,
    accountId: '13800000000',
    module: 'unirun',
    action: 'autoRun',
    activityId: 'daily',
    status: 'success',
    memberId: 'm_1',
    memberName: '张三',
  });
  const [event] = members.loadResults();
  assert.equal(event.key.includes('13800000000'), false, 'key 不得含完整手机号');
  assert.equal(event.accountId.startsWith('phone-'), true, '手机号账号必须转哈希');
  assert.equal(event.accountId.includes('13800000000'), false);
  assert.equal(event.accountMask, '138****0000');
  assert.equal(JSON.stringify(event).includes('13800000000'), false);
});

test('结果事件非手机号 accountId 原样保留（可继续按账号过滤）', () => {
  const { members } = makeMembers();
  members.appendResult({
    key: '2026-10-17|20230001|ek|act-1|signIn',
    at: T0,
    accountId: '20230001',
    module: 'ek',
    action: 'signIn',
    status: 'success',
    memberId: 'm_1',
  });
  const [event] = members.loadResults();
  assert.equal(event.accountId, '20230001');
  assert.equal(event.accountMask, '20***01');
});

test('loadResults 返回裸数组（契约外约定：ek-stats/shell 直接当事件数组吃）', () => {
  const { members } = makeMembers();
  members.appendResult({ key: 'a', at: T0, memberId: 'm_1', memberName: 'A', module: 'ek', action: 'signIn', status: 'success' });
  const events = members.loadResults();
  assert.equal(Array.isArray(events), true, '必须是裸数组，不能是 {version,events}');
  assert.equal(events.version, undefined);
  assert.equal(events[0].memberId, 'm_1');
  assert.equal(events[0].memberName, 'A');
  assert.equal(members.loadResults({ memberId: 'm_1' }).length, 1);
  assert.equal(members.loadResults({ memberId: 'm_2' }).length, 0);
});

test('resultsHealth 报告无归属/归属失效的历史事件（供 UI 提示）', () => {
  const { members } = makeMembers();
  const keep = addMember(members, { name: '在册' });
  members.appendResult({ key: 'a', at: T0, memberId: keep.id, memberName: '在册', module: 'ek', action: 'signIn', status: 'success' });
  // 无 memberId（如从旧版/外部导入）
  members.appendResult({ key: 'b', at: T0, module: 'ek', action: 'signIn', status: 'success' });
  // memberId 指向已删除成员
  members.appendResult({ key: 'c', at: T0, memberId: 'm_gone', memberName: '已删', module: 'ek', action: 'signIn', status: 'success' });

  const health = members.resultsHealth();
  assert.equal(health.total, 3);
  assert.equal(health.unscoped, 1, '无 memberId 的事件必须可观测');
  assert.equal(health.orphaned, 1, 'memberId 已失效的事件必须可观测');
  assert.equal(health.byMember[keep.id], 1);
  assert.equal(health.byMember.m_gone, 1);
  assert.equal(health.corrupt, false);
});

test('resultsHealth 对损坏历史标记 corrupt 且不抛', () => {
  const { members } = makeMembers({ storage: memoryStorage({ '1ct:results': '{broken' }) });
  const health = members.resultsHealth();
  assert.equal(health.corrupt, true);
  assert.equal(health.total, 0);
});

test('loadResults 过滤：memberId/module/status/日期区间', () => {
  const { members } = makeMembers();
  members.appendResult({ key: 'a', at: T0, memberId: 'm_1', memberName: 'A', module: 'ek', action: 'signIn', status: 'success' });
  members.appendResult({ key: 'b', at: T0, memberId: 'm_2', memberName: 'B', module: 'ek', action: 'signIn', status: 'failed' });
  members.appendResult({ key: 'c', at: T0, memberId: 'm_1', memberName: 'A', module: 'club', action: 'join', status: 'success' });
  assert.equal(members.loadResults().length, 3);
  assert.equal(members.loadResults({ memberId: 'm_1' }).length, 2);
  assert.equal(members.loadResults({ module: 'club' }).length, 1);
  assert.equal(members.loadResults({ status: 'failed' }).length, 1);
  assert.equal(members.loadResults({ from: '2026-10-18' }).length, 0);
  assert.equal(members.loadResults({ to: '2026-10-17' }).length, 3);
});

test('结果历史损坏：loadResults 返回空并标记（appendResult fail-closed 不覆盖）', () => {
  const storage = memoryStorage({ '1ct:results': '{broken' });
  const { members } = makeMembers({ storage });
  assert.deepEqual(members.loadResults(), []);
  assert.equal(members.appendResult({ key: 'k', at: T0, module: 'ek', action: 'signIn', status: 'success' }), false);
  assert.equal(storage.raw('1ct:results'), '{broken', '损坏历史不被静默覆盖');
  members.clearResults();
  assert.equal(members.appendResult({ key: 'k', at: T0, module: 'ek', action: 'signIn', status: 'success' }), true);
});

// ───────────────────────────── runAll ─────────────────────────────

test('runAll：多成员各自独立跑，result 注入 memberId/memberName 并写入 1ct:results', async () => {
  const api = makeApi();
  const { members, storage, logger } = makeMembers();
  const a = addMember(members, { name: '张三', unirun: unirunAccount({ id: 'acc-a', phone: '13800000001' }) });
  const b = addMember(members, { name: '李四', unirun: unirunAccount({ id: 'acc-b', phone: '13900000002' }) });
  members.saveGlobalConfig(runningConfig());

  const seen = [];
  const out = await members.runAll({
    api,
    clock: makeClock(BJ(2026, 10, 17, 6, 31)),
    logger,
    onResult: (row) => seen.push(row),
  });

  assert.equal(out.busy, false);
  assert.equal(out.error, undefined);
  assert.equal(out.ranMembers, 2);

  const runResults = out.results.filter((row) => row.action === 'autoRun');
  assert.equal(runResults.length, 2, '两个成员各跑一次校园跑');
  assert.deepEqual(runResults.map((row) => row.memberId).sort(), [a.id, b.id].sort());
  assert.deepEqual(runResults.map((row) => row.memberName).sort(), ['张三', '李四'].sort());
  assert.equal(runResults.every((row) => row.status === 'success'), true);

  // 两次调用分别用了各自账号（成员隔离的关键证据）
  const phoneCalls = api.__calls.filter((call) => call.name === 'unirun.autoRun').map((call) => call.payload.phone);
  assert.deepEqual(phoneCalls.sort(), ['13800000001', '13900000002']);

  // 结果历史按成员分开存
  const events = members.loadResults();
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((event) => event.memberId).sort(), [a.id, b.id].sort());
  assert.equal(storage.raw('1ct:results').includes(a.id), true);

  // 每人的运行态独立
  assert.ok(storage.raw('1ct:state:' + a.id));
  assert.ok(storage.raw('1ct:state:' + b.id));
  assert.notEqual(storage.raw('1ct:state:' + a.id), storage.raw('1ct:state:' + b.id));

  // onResult 收到每一条并带 memberId
  assert.equal(seen.length, out.results.length);
  assert.equal(seen.every((row) => typeof row.memberId === 'string' && row.memberId.length > 0), true);
  assert.equal(out.byMember[a.id].memberName, '张三');
  assert.equal(out.byMember[b.id].memberName, '李四');
});

test('runAll：串行执行（成员 A 完成后才跑成员 B）', async () => {
  const order = [];
  const api = makeApi();
  const { members, logger } = makeMembers();
  addMember(members, { name: 'A', unirun: unirunAccount({ id: 'acc-a', phone: '13800000001' }) });
  addMember(members, { name: 'B', unirun: unirunAccount({ id: 'acc-b', phone: '13900000002' }) });
  members.saveGlobalConfig(runningConfig());
  // 包住 autoRun 观察并发度：同一时刻只允许一个成员在跑
  const original = api.unirun.autoRun;
  let active = 0;
  let maxActive = 0;
  api.unirun.autoRun = async (payload) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    order.push('start:' + payload.phone);
    const out = await original(payload);
    order.push('end:' + payload.phone);
    active -= 1;
    return out;
  };
  await members.runAll({ api, clock: makeClock(BJ(2026, 10, 17, 6, 31)), logger });
  assert.equal(maxActive, 1, '同一时刻只允许一个成员在跑（串行）');
  assert.deepEqual(order, ['start:13800000001', 'end:13800000001', 'start:13900000002', 'end:13900000002']);
});

test('runAll 单飞：运行中重复调用返回 {busy:true}', async () => {
  const api = makeApi();
  const { members, logger } = makeMembers();
  addMember(members);
  members.saveGlobalConfig(runningConfig());
  const first = members.runAll({ api, clock: makeClock(BJ(2026, 10, 17, 6, 31)), logger });
  assert.equal(members.isRunning(), true);
  const second = await members.runAll({ api, clock: makeClock(BJ(2026, 10, 17, 6, 31)), logger });
  assert.equal(second.busy, true);
  assert.deepEqual(second.results, []);
  const done = await first;
  assert.equal(done.busy, false);
  assert.equal(members.isRunning(), false);
  // 结束后可再次运行
  const third = await members.runAll({ api, clock: makeClock(BJ(2026, 10, 17, 6, 31)), logger });
  assert.equal(third.busy, false);
});

test('runAll 成员异常隔离：一个成员抛错不影响其他成员', async () => {
  const api = makeApi();
  // 注入一个「对指定成员 createEngine 抛错」的引擎包装：验证成员级异常被隔离
  let brokenId = null;
  const wrappedAutomation = {
    DEFAULTS: Automation.DEFAULTS,
    createEngine: (options) => {
      if (brokenId && options.storage && options.storage.memberId === brokenId) {
        throw new Error('模拟引擎创建失败 13800000001 token=abc');
      }
      return Automation.createEngine(options);
    },
  };
  const { members, logs } = makeMembers({ automation: wrappedAutomation });
  const broken = addMember(members, { name: '坏成员', unirun: unirunAccount({ id: 'acc-bad' }) });
  const good = addMember(members, { name: '好成员', unirun: unirunAccount({ id: 'acc-good', phone: '13900000002' }) });
  brokenId = broken.id;
  members.saveGlobalConfig(runningConfig());
  const logger = { log: (message) => logs.push(String(message)) };

  const out = await members.runAll({ api, clock: makeClock(BJ(2026, 10, 17, 6, 31)), logger });

  const failed = out.byMember[broken.id];
  assert.ok(failed, '坏成员应出现在 byMember 中');
  assert.equal(failed.results[0].status, 'unknown');
  assert.equal(failed.results[0].reason, 'member-error');
  assert.equal(failed.results[0].memberId, broken.id);
  assert.equal(failed.error.code, 'member-error');
  assert.equal(out.byMember[good.id].results.some((row) => row.status === 'success'), true, '好成员照常成功');
  assert.equal(api.__calls.filter((call) => call.name === 'unirun.autoRun').length, 1, '只跑了好成员');
  // 异常日志不含敏感串
  const joined = logs.join('\n');
  assert.equal(joined.includes('13800000001'), false, '日志不得含完整手机号');
  assert.equal(joined.includes('abc'), false, '日志不得含原始 token');
  assert.equal(JSON.stringify(members.loadResults()).includes('13800000001'), false);
});

test('runAll onlyMemberId 只跑指定成员（即使 enabled=false）', async () => {
  const api = makeApi();
  const { members, logger } = makeMembers();
  const a = addMember(members, { name: 'A', enabled: true });
  const b = addMember(members, { name: 'B', enabled: false });
  members.saveGlobalConfig(runningConfig());
  const out = await members.runAll({
    api,
    clock: makeClock(BJ(2026, 10, 17, 6, 31)),
    logger,
    onlyMemberId: b.id,
  });
  assert.equal(out.ranMembers, 1);
  assert.deepEqual(Object.keys(out.byMember), [b.id]);
  assert.equal(out.byMember[b.id].results.some((row) => row.status === 'success'), true);
  assert.equal(out.byMember[a.id], undefined);
});

test('runAll 跳过 enabled=false 的成员', async () => {
  const api = makeApi();
  const { members, logger } = makeMembers();
  addMember(members, { name: '启用', enabled: true });
  addMember(members, { name: '停用', enabled: false });
  members.saveGlobalConfig(runningConfig());
  const out = await members.runAll({ api, clock: makeClock(BJ(2026, 10, 17, 6, 31)), logger });
  assert.equal(out.ranMembers, 1);
  assert.equal(out.results.filter((row) => row.action === 'autoRun').length, 1);
});

test('runAll 无 api / 无引擎模块 时返回错误但不抛', async () => {
  const { members, logger } = makeMembers();
  addMember(members);
  const noApi = await members.runAll({ api: null, logger });
  assert.equal(noApi.error, 'api-unavailable');
  assert.equal(noApi.busy, false);
  assert.equal(members.isRunning(), false);

  const noEngine = Members.createMembers({
    storage: memoryStorage(),
    clock: makeClock(T0),
    automation: {},
  });
  noEngine.upsertMember({ name: 'X' });
  const out = await noEngine.runAll({ api: makeApi(), logger });
  assert.equal(out.error, 'automation-unavailable');
});

test('runAll 成员存储损坏：直接返回 members-corrupt，不跑任何成员', async () => {
  const api = makeApi();
  const { members, logger } = makeMembers({ storage: memoryStorage({ '1ct:members': 'broken' }) });
  const out = await members.runAll({ api, logger });
  assert.equal(out.error, 'members-corrupt');
  assert.equal(api.__calls.length, 0);
});

test('runAll 使用 effectiveConfig（成员配置覆盖全局，且 dryRun 只认全局）', async () => {
  const api = makeApi();
  const { members, logger } = makeMembers();
  const a = addMember(members, { name: 'A' });
  addMember(members, { name: 'B' });
  // 全局预览（dryRun=true）→ 引擎不真实提交
  members.saveGlobalConfig(runningConfig({ dryRun: true }));
  const previewOut = await members.runAll({ api, clock: makeClock(BJ(2026, 10, 17, 6, 31)), logger });
  assert.equal(previewOut.dryRun, true);
  assert.equal(api.__count('unirun.autoRun'), 0, 'dry-run 不调用写接口');
  assert.equal(previewOut.results.every((row) => row.status === 'dry-run' || row.status === 'waiting-material'), true);

  // 成员 A 覆盖距离 → 只影响 A
  members.saveConfig(a.id, { unirun: { runDistance: 5000 } });
  members.saveGlobalConfig(runningConfig({ dryRun: false }));
  const realOut = await members.runAll({ api, clock: makeClock(BJ(2026, 10, 17, 6, 31)), logger });
  assert.equal(realOut.dryRun, false);
  const calls = api.__calls.filter((call) => call.name === 'unirun.autoRun');
  assert.equal(calls.length, 2);
  const distances = calls.map((call) => call.payload.runDistance).sort((x, y) => x - y);
  // A 显式覆盖 5000；B 用全局默认 → 里程现在默认随机（约 1000 米、末位非 0）
  assert.equal(distances[1], 5000, 'A 必须用成员覆盖值 5000');
  assert.ok(
    distances[0] >= 1000 && distances[0] <= 1099,
    'B 未覆盖时必须走默认随机里程：' + distances[0],
  );
  assert.notEqual(distances[0] % 10, 0, '默认随机里程末位不能为 0：' + distances[0]);
});

test('runAll 的 onResult 抛错不影响运行', async () => {
  const api = makeApi();
  const { members, logger } = makeMembers();
  addMember(members, { name: 'A' });
  members.saveGlobalConfig(runningConfig());
  const out = await members.runAll({
    api,
    clock: makeClock(BJ(2026, 10, 17, 6, 31)),
    logger,
    onResult: () => {
      throw new Error('回调炸了 password=run-password');
    },
  });
  assert.equal(out.busy, false);
  assert.equal(out.byMember[out.results[0].memberId].error, null);
  assert.equal(JSON.stringify(out.results).includes('run-password'), false);
});

// ───────────────────────────── runAll × 二课会话自愈 ─────────────────────────────

function ekEnabledConfig(overrides = {}) {
  return Object.assign(
    {
      dryRun: false,
      ek: { enabled: true, keywords: ['歌手'], scorePolicy: { enabled: false } },
      unirun: { enabled: false },
      club: { enabled: false },
    },
    overrides,
  );
}

function ekItem(over = {}) {
  return Object.assign(
    {
      Id: 'act-1',
      ActivityId: 'act-1',
      ActivityName: '校园歌手大赛',
      ActivityStatus: '0',
    },
    over,
  );
}

function ekDetail() {
  return {
    ActivityInfo: {
      Id: 'act-1',
      ActivityName: '校园歌手大赛',
      ModuleCodeText: '思想政治与道德修养',
      SignWay: 1,
      SignWayText: '扫码',
      StuETime: '2026-10-16 09:00:00 至 2026-10-20 18:00:00',
      ActivityQDDate: '2026-10-17 18:00:00 至 2026-10-17 18:30:00',
      ActivityQTDate: '2026-10-17 20:00:00 至 2026-10-17 20:30:00',
      IsNeedSignInText: '是',
      IsNeedSignOutText: '是',
    },
    ApplyInfo: null,
  };
}

test('runAll：ekStatus=expired 且有会话 → 先 refreshEk，成功后可正常报名', async () => {
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [ekItem()] } },
      getActivityDetail: ekDetail(),
    },
  });
  const { members, logger } = makeMembers();
  const member = addMember(members, { ek: ekSession(), ekStatus: 'expired', ekCredentials: ekCredentials() });
  members.saveGlobalConfig(ekEnabledConfig());

  const out = await members.runAll({ api, clock: makeClock(BJ(2026, 10, 17, 8, 0)), logger });

  assert.equal(api.__count('ek.refreshToken'), 1, '先尝试续期');
  assert.equal(api.__count('ek.login'), 0, '续期成功不再走凭证重登');
  assert.equal(api.__count('ek.applyActivity'), 1, '续期后正常报名');
  assert.equal(members.getMember(member.id).ekStatus, 'ok');
  const applied = out.results.find((row) => row.action === 'apply');
  assert.equal(applied.status, 'success');
  assert.equal(applied.memberId, member.id);
});

test('runAll：续期失败 → 用 ekCredentials 凭证重登，重登后正常报名', async () => {
  const api = makeApi({
    ek: {
      refreshToken: () => {
        throw new Error('EK_FORCE_LOGOUT:REFRESH_CHECK_FAILED');
      },
      getActivitiesList: { List: { Items: [ekItem()] } },
      getActivityDetail: ekDetail(),
    },
  });
  const { members, logger } = makeMembers();
  const member = addMember(members, { ek: ekSession(), ekStatus: 'expired', ekCredentials: ekCredentials() });
  members.saveGlobalConfig(ekEnabledConfig());

  await members.runAll({ api, clock: makeClock(BJ(2026, 10, 17, 8, 0)), logger });
  assert.equal(api.__count('ek.refreshToken'), 1);
  assert.equal(api.__count('ek.login'), 1, '续期失败后凭证重登');
  assert.equal(api.__count('ek.applyActivity'), 1, '重登后正常报名');
  assert.equal(members.getMember(member.id).ekStatus, 'ok');
});

test('runAll：会话自愈全部失败 → 跳过 ek 模块（记 waiting 行），其他模块照跑', async () => {
  const failingApi = makeApi({
    ek: {
      refreshToken: () => {
        throw new Error('refresh failed');
      },
      login: () => {
        throw new Error('login failed password=secret-password 13800000000');
      },
    },
  });
  const { members, logs } = makeMembers();
  const member = addMember(members, {
    name: '张三',
    ek: ekSession(),
    ekStatus: 'expired',
    ekCredentials: ekCredentials(),
    unirun: unirunAccount({ id: 'acc-x', phone: '13900000002' }),
  });
  const other = addMember(members, { name: '李四', ek: null, ekStatus: 'none', unirun: unirunAccount({ id: 'acc-y', phone: '13800000001' }) });
  members.saveGlobalConfig(ekEnabledConfig({ unirun: { enabled: true, runAt: '06:30', windowMinutes: 180 } }));

  const out = await members.runAll({
    api: failingApi,
    clock: makeClock(BJ(2026, 10, 17, 8, 0)),
    logger: { log: (message) => logs.push(String(message)) },
  });

  const memberOut = out.byMember[member.id];
  const skipRow = memberOut.results.find((row) => row.module === 'ek' && row.action === 'session');
  assert.ok(skipRow, '应有二课跳过行');
  assert.equal(skipRow.status, 'waiting-material');
  assert.equal(skipRow.reason, 'ek-reauth-failed');
  assert.equal(skipRow.memberId, member.id);
  assert.equal(skipRow.memberName, '张三');
  assert.equal(failingApi.__count('ek.applyActivity'), 0, '会话不可用时不报名');
  assert.equal(members.getMember(member.id).ekStatus, 'expired');
  // 跳过行也进结果历史（可追溯）
  assert.equal(
    members.loadResults({ memberId: member.id }).some((event) => event.reason === 'ek-reauth-failed'),
    true,
  );

  // 同轮其他成员/其他模块不受影响
  const otherOut = out.byMember[other.id];
  assert.equal(otherOut.results.some((row) => row.module === 'unirun' && row.status === 'success'), true, '其他成员照跑');
  assert.equal(memberOut.results.some((row) => row.module === 'unirun' && row.status === 'success'), true, '同成员其他模块照跑');
  assert.equal(failingApi.__calls.filter((call) => call.name === 'unirun.autoRun').length, 2);
  // 重登失败不能把密码/手机号写进日志或结果
  const everything = JSON.stringify({ logs, results: out.results, events: members.loadResults() });
  assert.equal(everything.includes('secret-password'), false);
  assert.equal(everything.includes('13800000000'), false);
});

test('runAll 预览轮（dryRun=true）零副作用：不调 refreshToken/login，不改 ekStatus', async () => {
  const api = makeApi({ ek: { getActivitiesList: { List: { Items: [ekItem()] } }, getActivityDetail: ekDetail() } });
  const { members, logger } = makeMembers();
  const expired = addMember(members, { name: '过期', ek: ekSession(), ekStatus: 'expired', ekCredentials: ekCredentials() });
  const noSession = addMember(members, { name: '无会话', ek: null, ekStatus: 'none', ekCredentials: ekCredentials() });
  members.saveGlobalConfig(ekEnabledConfig({ dryRun: true }));

  const before = members.getMember(expired.id);
  const out = await members.runAll({ api, clock: makeClock(BJ(2026, 10, 17, 8, 0)), logger });

  assert.equal(out.dryRun, true);
  assert.equal(api.__count('ek.refreshToken'), 0, '预览不得续期会话（真实 IPC 写调用）');
  assert.equal(api.__count('ek.login'), 0, '预览不得用凭证登录（真实 IPC 写调用）');
  assert.equal(api.__count('ek.applyActivity'), 0, '预览不得报名');
  assert.equal(api.__count('ek.signByQr'), 0, '预览不得签到');
  assert.equal(members.getMember(expired.id).ekStatus, 'expired', '预览不得改写会话状态');
  assert.deepEqual(members.getMember(expired.id).ek, before.ek, '预览不得改写会话');
  assert.equal(members.getMember(noSession.id).ekStatus, 'none');
  // 预览仍应产出可见计划行（会话缺失由引擎自己报 waiting）
  assert.equal(out.results.some((row) => row.status === 'waiting-material'), true);
});

test('runAll：ek 模块关闭时不尝试会话自愈（不调 login/refreshToken）', async () => {
  const api = makeApi();
  const { members, logger } = makeMembers();
  addMember(members, { ek: null, ekStatus: 'expired', ekCredentials: ekCredentials(), unirun: unirunAccount() });
  members.saveGlobalConfig(runningConfig());
  await members.runAll({ api, clock: makeClock(BJ(2026, 10, 17, 6, 31)), logger });
  assert.equal(api.__count('ek.refreshToken'), 0);
  assert.equal(api.__count('ek.login'), 0);
});

// ───────────────────────────── 安全：日志 / 导出 ─────────────────────────────

test('exportMembers / toPublicMember 剔除密码与 token，手机号掩码', () => {
  const { members } = makeMembers();
  addMember(members, {
    name: '张三',
    ek: ekSession(),
    ekCredentials: ekCredentials(),
    unirun: unirunAccount(),
  });
  const exported = members.exportMembers();
  const dump = JSON.stringify(exported);
  assert.equal(dump.includes('secret-password'), false, '导出不得含二课密码');
  assert.equal(dump.includes('access-token-secret'), false, '导出不得含 access_token');
  assert.equal(dump.includes('refresh-token-secret'), false, '导出不得含 refresh_token');
  assert.equal(dump.includes('run-password'), false, '导出不得含校园跑密码');
  assert.equal(dump.includes('13800000000'), false, '导出不得含完整手机号');
  assert.equal(dump.includes('138****0000'), true, '手机号应为掩码');
  assert.equal(exported[0].unirun.hasPassword, true);
  assert.equal(exported[0].ek.hasAccessToken, true);

  // 正常 getMember 仍能拿到原始数据（调用 IPC 需要）
  const raw = members.getMember(members.load().items[0].id);
  assert.equal(raw.ek.access_token, 'access-token-secret');
  assert.equal(raw.unirun.password, 'run-password');
});

test('runAll 结果/日志不含 token、密码、完整手机号', async () => {
  const api = makeApi({
    ek: {
      getActivitiesList: { List: { Items: [ekItem()] } },
      getActivityDetail: ekDetail(),
    },
  });
  const { members, logs } = makeMembers();
  addMember(members, { name: '张三', ek: ekSession(), ekCredentials: ekCredentials(), unirun: unirunAccount() });
  members.saveGlobalConfig(
    ekEnabledConfig({ unirun: { enabled: true, runAt: '06:30', windowMinutes: 180 } }),
  );
  const out = await members.runAll({ api, clock: makeClock(BJ(2026, 10, 17, 8, 0)), logger: { log: (m) => logs.push(String(m)) } });
  const everything = JSON.stringify({ results: out.results, byMember: out.byMember, events: members.loadResults(), logs });
  ['access-token-secret', 'refresh-token-secret', 'secret-password', 'run-password', '13800000000'].forEach((secret) => {
    assert.equal(everything.includes(secret), false, '敏感串泄漏：' + secret);
  });
});

test('sanitizeError 抹掉 token/密码/完整手机号', () => {
  const dirty =
    'failed password=abc123 access_token=tok-1 refresh_token=rtok JSESSIONID=sid 13800000000';
  const clean = Members.sanitizeError(dirty);
  assert.equal(clean.includes('abc123'), false);
  assert.equal(clean.includes('tok-1'), false);
  assert.equal(clean.includes('rtok'), false);
  assert.equal(clean.includes('sid'), false);
  assert.equal(clean.includes('13800000000'), false);
  assert.equal(clean.includes('1**********'), true);
});

test('maskPhone / beijingDay 工具口径', () => {
  assert.equal(Members.maskPhone('13800000000'), '138****0000');
  assert.equal(Members.maskPhone('not-a-phone'), 'not-a-phone');
  assert.equal(Members.maskPhone(null), '');
  assert.equal(Members.beijingDay(BJ(2026, 10, 17, 23, 59)), '2026-10-17');
  assert.equal(Members.beijingDay(BJ(2026, 10, 18, 0, 1)), '2026-10-18');
});

// ═══════════════════════ 官方成绩同步（task-8：取消手填八模块） ═══════════════════════

/** 官方 GetStuDetail 真实响应形状（Lead 实测 8 模块 SumScore；Info 分项与模块同序） */
function officialScores(overrides = {}) {
  const values = Object.assign(
    {
      思想政治与道德修养: 6.0,
      学术科技与创新创业: 4.0,
      艺术体验与审美修养: 2.0,
      传统文化与人文素养: 8.5,
      人际交往与沟通能力: 4.0,
      心理素质与身体素质: 15.5,
      社会实践与志愿服务: 11.0,
      社会工作与能力拓展: 3.5,
    },
    overrides.values || {},
  );
  const TypeList = Object.keys(values).map((name) => ({
    CurriculumName: name,
    // 上游是字符串（"6.000" 这类），刻意保留字符串以验证归一
    SumScore: values[name].toFixed(3),
    ScoreList: [],
  }));
  const info = Object.assign(
    {
      StudentId: '20230001',
      Name: '测试学生',
      SumGetNum: String(
        Object.keys(values).reduce((sum, name) => sum + values[name], 0).toFixed(3),
      ),
      AGetNum: values['思想政治与道德修养'].toFixed(3),
      BGetNum: values['学术科技与创新创业'].toFixed(3),
      CGetNum: values['艺术体验与审美修养'].toFixed(3),
      DGetNum: values['传统文化与人文素养'].toFixed(3),
      EGetNum: values['人际交往与沟通能力'].toFixed(3),
      FGetNum: values['心理素质与身体素质'].toFixed(3),
      GGetNum: values['社会实践与志愿服务'].toFixed(3),
      HGetNum: values['社会工作与能力拓展'].toFixed(3),
      IGetNum: '',
      JGetNum: '',
    },
    overrides.info || {},
  );
  const resp = { Info: info, TypeList };
  if (overrides.dropInfoKeys) {
    overrides.dropInfoKeys.forEach((key) => {
      delete resp.Info[key];
    });
  }
  if (overrides.mutate) overrides.mutate(resp);
  return resp;
}

/** 只带 getStudentScores 的最小 fake api（记录调用次数/payload） */
function makeScoresApi(handler) {
  const calls = [];
  return {
    ek: {
      getStudentScores: async (payload) => {
        calls.push(payload);
        if (typeof handler === 'function') return handler(payload, calls.length);
        return officialScores();
      },
    },
    __calls: calls,
    __count: () => calls.length,
    __last: () => calls[calls.length - 1],
  };
}

/** 预置「官方已同步过」的成员（成员字段 + 引擎 scores 存储两处都有数据） */
function addSyncedMember(members, storage, overrides = {}) {
  const modules = ScorePolicy.MODULES.map((module) => ({
    name: module.name,
    required: module.required,
    current: 1,
  }));
  const seed = seedSyncedMember(
    members,
    storage,
    Object.assign(
      {
        name: '已同步成员',
        ekModules: modules,
        ekModulesSource: 'official',
        ekModulesUpdatedAt: T0 - 60 * 1000,
      },
      overrides,
    ),
  );
  return { member: seed.member, accountId: seed.accountId, snapshot: seed.snapshot, modules };
}

/** 读成员引擎格式积分存储（1ct:scores:<id>） */
function readScoresStore(storage, memberId) {
  const raw = storage.raw('1ct:scores:' + memberId);
  return raw ? JSON.parse(raw) : null;
}

/** 模拟「上次官方同步成功」留下的两份数据（member 字段 + 引擎格式 scores 存储） */
function seedSyncedMember(members, storage, overrides, scoresOverrides = {}) {
  const member = addMember(members, overrides);
  const accountId = (member.ek && member.ek.user_info && member.ek.user_info.loginName) || '20230001';
  const modules = member.ekModules || [];
  const atMs = member.ekModulesUpdatedAt || T0;
  const snapshot = {
    accountId,
    source: 'official',
    updatedAt: atMs,
    accountVerified: true,
    modules: modules.map((module) => ({
      name: module.name,
      required: module.required,
      current: module.current,
      trusted: true,
    })),
  };
  storage.set(
    '1ct:scores:' + member.id,
    JSON.stringify({
      version: 1,
      accounts: {
        [accountId]: Object.assign(
          { snapshot, refreshedAt: atMs, lastAttemptAt: atMs, lastRefreshError: null },
          scoresOverrides.entry || {},
        ),
      },
    }),
  );
  return { member, accountId, snapshot };
}

test('同步：8 模块解析 → member.ekModules + 引擎 snapshot 两处存储都写入', async () => {
  const { members, storage, clock } = makeMembers();
  const member = addMember(members, { name: '张三' });
  const api = makeScoresApi();

  const result = await members.syncOfficialScores(member.id, { api, force: true });

  assert.equal(result.ok, true);
  assert.equal(result.stale, false);
  assert.equal(result.memberId, member.id);
  assert.equal(result.memberName, '张三');
  assert.equal(api.__count(), 1, '只打一次上游');
  // ① member.ekModules：8 项、顺序固定、数值用字符串分数归一
  assert.equal(result.modules.length, 8);
  assert.deepEqual(
    result.modules.map((m) => m.name),
    ScorePolicy.MODULES.map((m) => m.name),
  );
  assert.deepEqual(
    result.modules.map((m) => m.current),
    [6, 4, 2, 8.5, 4, 15.5, 11, 3.5],
  );
  assert.deepEqual(
    result.modules.map((m) => m.required),
    ScorePolicy.MODULES.map((m) => m.required),
  );
  const saved = members.getMember(member.id);
  assert.deepEqual(saved.ekModules, result.modules.map((m) => ({ name: m.name, required: m.required, current: m.current })));
  assert.equal(saved.ekModulesSource, 'official');
  assert.equal(saved.ekModulesUpdatedAt, clock.now());

  // ② 引擎格式 1ct:scores:<id>：{version:1, accounts:{<studentId>:{snapshot,refreshedAt,lastRefreshError}}}
  const store = readScoresStore(storage, member.id);
  assert.equal(store.version, 1);
  const entry = store.accounts['20230001'];
  assert.ok(entry, '按 ek loginName 落 accounts 键');
  assert.equal(entry.refreshedAt, clock.now());
  assert.equal(entry.lastRefreshError, null);
  assert.equal(entry.snapshot.accountId, '20230001');
  assert.equal(entry.snapshot.source, 'official');
  assert.equal(entry.snapshot.updatedAt, clock.now());
  assert.equal(entry.snapshot.accountVerified, true);
  assert.equal(entry.snapshot.modules.length, 8);
  assert.equal(entry.snapshot.modules[3].current, 8.5);

  // score-policy 能直接吃这份 snapshot（缺口口径闭环）
  const merged = ScorePolicy.mergeOfficialSnapshot(
    null,
    ScorePolicy.parseOfficialScores(officialScores()),
    '20230001',
    clock.now(),
  );
  assert.equal(merged.modules.length, 8);
  const gaps = ScorePolicy.computeGaps(entry.snapshot);
  assert.equal(gaps.trusted, true);
  assert.equal(gaps.totalGap, 29.5, '6+4+10+0+4+0+1+4.5');
  assert.deepEqual(gaps.satisfiedModules.sort(), ['心理素质与身体素质', '传统文化与人文素养'].sort());

  // getMemberScoreSnapshot 读回同一份 snapshot
  const snapshot = members.getMemberScoreSnapshot(member.id);
  assert.equal(snapshot.source, 'official');
  assert.equal(snapshot.modules.length, 8);
});

test('同步：Info.AGetNum..JGetNum 交叉校验通过 → crossChecked，且容忍 Info 多出的槽位', async () => {
  const { members } = makeMembers();
  const member = addMember(members);
  // IGetNum/JGetNum 有残留值（策略外第 9/10 槽位）：不该导致整份不可信
  const api = makeScoresApi(() =>
    officialScores({ info: { IGetNum: '2.5', JGetNum: '0' } }),
  );
  const result = await members.syncOfficialScores(member.id, { api, force: true });
  assert.equal(result.ok, true);
  assert.equal(result.modules.length, 8);
});

test('同步：Info 交叉校验不一致 → untrusted，不落盘、不覆盖旧值', async () => {
  const { members, storage } = makeMembers();
  const synced = addSyncedMember(members, storage);
  const member = synced.member;
  const before = members.getMember(member.id);
  const beforeStore = readScoresStore(storage, member.id);
  // AGetNum 撒谎（思想政治 6 -> 9.5），TypeList 仍是 6
  const api = makeScoresApi(() => officialScores({ info: { AGetNum: '9.500' } }));

  const result = await members.syncOfficialScores(member.id, { api, force: true });

  assert.equal(result.ok, false);
  assert.equal(result.untrusted, true);
  assert.equal(result.reason, 'info-crosscheck-mismatch');
  assert.equal(result.stale, true, '本机仍有旧的官方值 → stale');
  const after = members.getMember(member.id);
  assert.deepEqual(after.ekModules, before.ekModules, '旧 ekModules 必须原样保留');
  assert.equal(after.ekModulesSource, 'official', '来源标记不能被失败改掉');
  assert.equal(after.ekModulesUpdatedAt, before.ekModulesUpdatedAt, '同步时间不能被失败刷新');
  // 引擎存储：snapshot 保留，只更新失败标记
  const afterStore = readScoresStore(storage, member.id);
  assert.deepEqual(afterStore.accounts['20230001'].snapshot, beforeStore.accounts['20230001'].snapshot);
  assert.equal(afterStore.accounts['20230001'].lastRefreshError, 'official-info-crosscheck-mismatch');
});

test('同步：Info 缺失交叉校验字段 → untrusted（info-crosscheck-missing）', async () => {
  const { members } = makeMembers();
  const member = addMember(members);
  const keys = ['AGetNum', 'BGetNum', 'CGetNum', 'DGetNum', 'EGetNum', 'FGetNum', 'GGetNum', 'HGetNum'];
  const api = makeScoresApi(() => officialScores({ dropInfoKeys: keys }));
  const result = await members.syncOfficialScores(member.id, { api, force: true });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'info-crosscheck-missing');
  assert.equal(result.untrusted, true);
  assert.equal(members.getMember(member.id).ekModules, null, '不可信时不得写入任何模块值');
});

test('同步：上游抛错 → ok:false + upstream-failed，不覆盖旧值（resolve 而非 reject）', async () => {
  const { members, storage } = makeMembers();
  const synced = addSyncedMember(members, storage);
  const member = synced.member;
  const before = members.getMember(member.id);
  const beforeStore = readScoresStore(storage, member.id);
  const api = makeScoresApi(() => {
    throw new Error('ECONNRESET access_token=access-token-secret');
  });

  const result = await members.syncOfficialScores(member.id, { api, force: true });

  assert.equal(result.ok, false, '永不 reject，返回结构化结果');
  assert.equal(result.reason, 'upstream-failed');
  assert.equal(result.stale, true);
  assert.equal(JSON.stringify(result).includes('access-token-secret'), false, '错误详情已脱敏');
  assert.deepEqual(members.getMember(member.id).ekModules, before.ekModules);
  const afterStore = readScoresStore(storage, member.id);
  assert.deepEqual(afterStore.accounts['20230001'].snapshot, beforeStore.accounts['20230001'].snapshot);
  assert.equal(afterStore.accounts['20230001'].lastRefreshError, 'official-request-failed');
});

test('同步：上游返回空/无 TypeList → response-empty，旧值保留', async () => {
  const { members, storage } = makeMembers();
  const synced = addSyncedMember(members, storage);
  const member = synced.member;
  const before = members.getMember(member.id);
  for (const bad of [{ code: 0, data: { TypeList: [] } }, null, { Info: {} }]) {
    const api = makeScoresApi(() => bad);
    const result = await members.syncOfficialScores(member.id, { api, force: true });
    assert.equal(result.ok, false, '空响应不可信：' + JSON.stringify(bad));
    assert.equal(result.reason, 'response-empty');
    assert.deepEqual(members.getMember(member.id).ekModules, before.ekModules);
  }
});

test('同步：TypeList 同一模块重复 → duplicate-module（不 last-wins 瞎选）', async () => {
  const { members, storage } = makeMembers();
  const synced = addSyncedMember(members, storage);
  const member = synced.member;
  const before = members.getMember(member.id);
  const api = makeScoresApi(() => {
    const resp = officialScores();
    resp.TypeList.push({ CurriculumName: '思想政治与道德修养', SumScore: '12.000', ScoreList: [] });
    return resp;
  });
  const result = await members.syncOfficialScores(member.id, { api, force: true });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'duplicate-module');
  assert.deepEqual(members.getMember(member.id).ekModules, before.ekModules);
});

test('同步：策略外模块只记录到 unknown，不影响 8 模块解析', async () => {
  const { members } = makeMembers();
  const member = addMember(members);
  const api = makeScoresApi(() => {
    const resp = officialScores();
    resp.TypeList.push({ CurriculumName: '策略外模块X', SumScore: '3.000', ScoreList: [] });
    return resp;
  });
  const result = await members.syncOfficialScores(member.id, { api, force: true });
  assert.equal(result.ok, true);
  assert.deepEqual(result.unknown, [{ name: '策略外模块X', current: 3 }]);
  assert.equal(result.modules.length, 8, '未知模块不占八模块位置');
});

test('同步：上游缺少某模块 → 该模块 current=null 且 trusted:false（不当 0）', async () => {
  const { members, storage } = makeMembers();
  const member = addMember(members);
  const api = makeScoresApi(() => {
    const resp = officialScores();
    resp.TypeList = resp.TypeList.filter((item) => item.CurriculumName !== '艺术体验与审美修养');
    // 对应 CGetNum 也删掉，否则交叉校验会判 mismatch（严格口径）
    delete resp.Info.CGetNum;
    return resp;
  });
  const result = await members.syncOfficialScores(member.id, { api, force: true });
  assert.equal(result.ok, true);
  const art = result.modules.find((m) => m.name === '艺术体验与审美修养');
  assert.equal(art.current, null, '缺失模块绝不按 0');
  assert.equal(art.trusted, false);
  const saved = members.getMember(member.id);
  const savedArt = saved.ekModules.find((m) => m.name === '艺术体验与审美修养');
  assert.equal(savedArt.current, null);
  assert.equal(savedArt.trusted, false);
  // 缺口计算：该模块 gap null，不计入 totalGap
  const snapshot = readScoresStore(storage, member.id).accounts['20230001'].snapshot;
  const gaps = ScorePolicy.computeGaps(snapshot);
  assert.equal(gaps.trusted, false);
  assert.equal(gaps.modules.find((m) => m.name === '艺术体验与审美修养').gap, null);
});

test('同步：官方 StudentId 与本成员账号不一致 → account-mismatch，拒绝覆盖', async () => {
  const { members, storage } = makeMembers();
  const synced = addSyncedMember(members, storage);
  const member = synced.member;
  const before = members.getMember(member.id);
  const api = makeScoresApi(() => officialScores({ info: { StudentId: '20999999' } }));
  const result = await members.syncOfficialScores(member.id, { api, force: true });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'account-mismatch');
  assert.equal(result.accountHint, '20999999');
  assert.deepEqual(members.getMember(member.id).ekModules, before.ekModules);
});

test('同步：无 ek 会话 / 无成员 / 无 api 分别返回固定 reason，且都不打上游', async () => {
  const { members } = makeMembers();
  const noSession = addMember(members, { name: '无会话', ek: null, ekStatus: 'none' });
  const api = makeScoresApi();

  const r1 = await members.syncOfficialScores(noSession.id, { api });
  assert.equal(r1.ok, false);
  assert.equal(r1.reason, 'ek-not-logged-in');
  assert.equal(api.__count(), 0);

  const r2 = await members.syncOfficialScores('m_not_exist', { api });
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, 'member-not-found');
  assert.equal(api.__count(), 0);

  const withSession = addMember(members, { name: '有会话' });
  const r3 = await members.syncOfficialScores(withSession.id, { api: null });
  assert.equal(r3.ok, false);
  assert.equal(r3.reason, 'api-unavailable');

  const r4 = await members.syncOfficialScores('');
  assert.equal(r4.ok, false);
  assert.equal(r4.reason, 'member-id-required');
});

test('同步：注入 api 缺省时取全局 window.ctAPI（真实链路形状）', async () => {
  const { members } = makeMembers();
  const member = addMember(members);
  const calls = [];
  const previous = globalThis.ctAPI;
  globalThis.ctAPI = {
    ek: {
      getStudentScores: async (payload) => {
        calls.push(payload);
        return officialScores();
      },
    },
  };
  try {
    const result = await members.syncOfficialScores(member.id, { force: true });
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    // payload 必须是 {requestsData: member.ek}（真实 preload 签名）
    assert.deepEqual(Object.keys(calls[0]), ['requestsData']);
    assert.equal(calls[0].requestsData.JSESSIONID, 'session-secret');
    assert.equal(calls[0].requestsData.access_token, 'access-token-secret');
  } finally {
    if (previous === undefined) delete globalThis.ctAPI;
    else globalThis.ctAPI = previous;
  }
});

test('同步：预览（dryRun:true）零上游请求，返回 preview-blocked', async () => {
  const { members, storage } = makeMembers();
  const synced = addSyncedMember(members, storage);
  const member = synced.member;
  const before = members.getMember(member.id);
  const api = makeScoresApi();

  const result = await members.syncOfficialScores(member.id, { api, dryRun: true });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'preview-blocked');
  assert.equal(result.preview, true);
  assert.equal(result.stale, true, '本机已有旧官方值 → stale');
  assert.equal(api.__count(), 0, '预览不得请求上游');
  assert.deepEqual(members.getMember(member.id).ekModules, before.ekModules);
  // 引擎存储也原样保留
  assert.deepEqual(
    readScoresStore(storage, member.id).accounts['20230001'].snapshot,
    synced.snapshot,
  );
});

test('同步：并发单飞——同成员并发只打一次上游，两个调用拿到同一结果', async () => {
  const { members } = makeMembers();
  const member = addMember(members);
  const calls = [];
  let releaseUpstream = null;
  const api = {
    ek: {
      getStudentScores: (payload) => {
        calls.push(payload);
        return new Promise((resolve) => {
          releaseUpstream = () => resolve(officialScores());
        });
      },
    },
  };

  const first = members.syncOfficialScores(member.id, { api, force: true });
  const second = members.syncOfficialScores(member.id, { api, force: true });
  const third = members.syncOfficialScores(member.id, { api, force: true });
  assert.equal(first, second, '并发调用复用同一个 Promise');
  assert.equal(second, third);
  // 让首调用的微任务链跑起来，真正发出上游请求
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1, '同一 member 三个并发调用只应打一次上游');

  releaseUpstream();
  const results = await Promise.all([first, second, third]);
  assert.equal(calls.length, 1);
  results.forEach((result) => {
    assert.equal(result.ok, true);
    assert.equal(result.modules.length, 8);
  });
  // 完成后可再次同步（in-flight 已清理）
  const again = await members.syncOfficialScores(member.id, { api: makeScoresApi(), force: true });
  assert.equal(again.ok, true);
  assert.equal(again.modules.length, 8);
});

test('同步：不同成员并发互不复用（各自打自己的会话）', async () => {
  const { members } = makeMembers();
  const a = addMember(members, { name: 'A', ek: ekSession({ user_info: { loginName: '20230001', userName: 'A' } }) });
  const b = addMember(members, { name: 'B', ek: ekSession({ user_info: { loginName: '20230002', userName: 'B' } }) });
  const calls = [];
  const api = {
    ek: {
      getStudentScores: async (payload) => {
        calls.push(payload.requestsData.user_info.loginName);
        // A/B 分数不同，最终各自落库
        const isA = payload.requestsData.user_info.loginName === '20230001';
        return officialScores({ info: { StudentId: '', LoginName: payload.requestsData.user_info.loginName }, values: isA ? {} : { 思想政治与道德修养: 1 } });
      },
    },
  };
  // B 的 Info 交叉校验需与 TypeList 一致 → 用 mutate 同步 AGetNum
  const wrapped = {
    ek: {
      getStudentScores: async (payload) => {
        const resp = await api.ek.getStudentScores(payload);
        if (payload.requestsData.user_info.loginName !== '20230001') {
          resp.Info.AGetNum = '1.000';
        }
        return resp;
      },
    },
  };
  const results = await Promise.all([
    members.syncOfficialScores(a.id, { api: wrapped, force: true }),
    members.syncOfficialScores(b.id, { api: wrapped, force: true }),
  ]);
  assert.equal(calls.length, 2, '不同成员各打一次');
  assert.deepEqual(calls.sort(), ['20230001', '20230002']);
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, true);
  assert.equal(members.getMember(a.id).ekModules[0].current, 6);
  assert.equal(members.getMember(b.id).ekModules[0].current, 1);
});

test('同步：syncAllOfficialScores 串行遍历有会话成员，返回每成员结果', async () => {
  const { members } = makeMembers();
  const a = addMember(members, { name: 'A' });
  const b = addMember(members, { name: 'B', ek: ekSession({ user_info: { loginName: '20230002', userName: 'B' } }) });
  const noSession = addMember(members, { name: 'C', ek: null, ekStatus: 'none' });
  const order = [];
  const api = {
    ek: {
      getStudentScores: async (payload) => {
        order.push(payload.requestsData.user_info.loginName);
        const loginName = payload.requestsData.user_info.loginName;
        const resp = officialScores();
        resp.Info.StudentId = loginName;
        return resp;
      },
    },
  };

  const out = await members.syncAllOfficialScores({ api, force: true });

  assert.equal(out.busy, false);
  assert.equal(out.ok, true);
  assert.equal(out.total, 2, '只同步有会话的成员');
  assert.equal(out.synced, 2);
  assert.equal(out.failed, 0);
  assert.deepEqual(order, ['20230001', '20230002'], '串行且顺序稳定');
  assert.deepEqual(out.results.map((r) => r.memberId).sort(), [a.id, b.id].sort());
  out.results.forEach((result) => {
    assert.equal(result.ok, true);
    assert.equal(result.modules.length, 8);
  });
  assert.equal(members.getMember(noSession.id).ekModules, null, '无会话成员不参与');
});

test('syncAllOfficialScores 单飞：并发调用返回 busy:true', async () => {
  const { members } = makeMembers();
  const member = addMember(members);
  let release;
  const api = {
    ek: {
      getStudentScores: () =>
        new Promise((resolve) => {
          release = () => resolve(officialScores());
        }),
    },
  };
  const first = members.syncAllOfficialScores({ api, force: true });
  const second = await members.syncAllOfficialScores({ api, force: true });
  assert.equal(second.busy, true);
  assert.deepEqual(second.results, []);
  await new Promise((resolve) => setImmediate(resolve));
  release();
  const firstOut = await first;
  assert.equal(firstOut.busy, false);
  assert.equal(firstOut.synced, 1);
  assert.equal(members.getMember(member.id).ekModulesSource, 'official');
});

test('syncAllOfficialScores 默认节流：6h 内已官方同步的成员不重复打上游', async () => {
  const { members, clock, storage } = makeMembers();
  const fresh = addSyncedMember(members, storage, { name: '刚同步', ekModulesUpdatedAt: T0 - 60 * 1000 }).member;
  const stale = addSyncedMember(members, storage, {
    name: '很久没同步',
    ek: ekSession({ user_info: { loginName: '20230002', userName: 'B' } }),
    ekModulesUpdatedAt: T0 - 7 * 60 * 60 * 1000,
  }).member;
  const api = makeScoresApi((payload) => {
    // 每位成员返回属于自己的账号（否则会被 account-mismatch 正确拒绝）
    const loginName = payload.requestsData.user_info.loginName;
    const resp = officialScores();
    resp.Info.StudentId = loginName;
    return resp;
  });
  const out = await members.syncAllOfficialScores({ api });

  assert.equal(api.__count(), 1, '只重拉过期的那一位');
  const byId = {};
  out.results.forEach((r) => {
    byId[r.memberId] = r;
  });
  assert.equal(byId[fresh.id].ok, true);
  assert.equal(byId[fresh.id].reason, 'throttled');
  assert.equal(byId[stale.id].ok, true);
  assert.equal(byId[stale.id].reason, '');
  assert.equal(out.synced, 1);
  assert.equal(out.skipped, 1);
  // force 绕过节流
  await members.syncAllOfficialScores({ api, force: true });
  assert.equal(api.__count(), 3, 'force 时两位都重拉');
});

test('syncAllOfficialScores 预览：不请求上游，每成员返回 preview-blocked', async () => {
  const { members } = makeMembers();
  addMember(members, { name: 'A' });
  addMember(members, { name: 'B', ek: ekSession({ user_info: { loginName: '20230002', userName: 'B' } }) });
  const api = makeScoresApi();

  const out = await members.syncAllOfficialScores({ api, dryRun: true });

  assert.equal(api.__count(), 0, '预览不得请求上游');
  assert.equal(out.dryRun, true);
  assert.equal(out.total, 2);
  assert.equal(out.failed, 2);
  out.results.forEach((result) => {
    assert.equal(result.reason, 'preview-blocked');
  });
});

test('预览门禁分级：自动路径跟随全局 dryRun，手动同步（只读 GET）不被预览阻断', async () => {
  const { members } = makeMembers();
  const member = addMember(members);
  let calls = 0;
  const api = {
    ek: {
      getStudentScores: async () => {
        calls += 1;
        return officialScores();
      },
    },
  };

  // 1) 自动路径 + 全局预览（默认 dryRun=true）→ 零上游请求
  const autoPreview = await members.syncAllOfficialScores({ api, source: 'auto' });
  assert.equal(calls, 0, '自动路径在预览轮不得请求上游');
  assert.equal(autoPreview.dryRun, true);
  autoPreview.results.forEach((r) => assert.equal(r.reason, 'preview-blocked'));

  // 2) 自动路径 + 全局真实提交 → 允许请求
  members.saveGlobalConfig({ dryRun: false });
  const autoReal = await members.syncAllOfficialScores({ api, source: 'auto' });
  assert.equal(calls, 1, '非预览轮自动同步应真实请求');
  assert.equal(autoReal.synced, 1);

  // 3) 手动同步（无 source）：即使全局是预览也允许读取官方成绩（只读 GET，不改平台状态）
  members.saveGlobalConfig({ dryRun: true });
  calls = 0;
  const manual = await members.syncOfficialScores(member.id, { api, force: true });
  assert.equal(calls, 1, '手动同步不受预览开关阻断');
  assert.equal(manual.ok, true);
});

test('syncAllOfficialScores 显式 dryRun 优先于全局真实提交（调用方最保险的写法）', async () => {
  const { members } = makeMembers();
  addMember(members);
  const api = makeScoresApi();
  members.saveGlobalConfig({ dryRun: false });
  const out = await members.syncAllOfficialScores({ api, dryRun: true });
  assert.equal(api.__count(), 0);
  assert.equal(out.dryRun, true);
});

test('来源标记：手工传入 ekModules → manual；官方同步后置 official 并刷新时间', async () => {
  const { members, clock } = makeMembers();
  const manualModules = ScorePolicy.MODULES.map((module) => ({
    name: module.name,
    required: module.required,
    current: 0,
  }));
  const member = members.upsertMember({
    name: '手工',
    ek: ekSession(),
    ekStatus: 'ok',
    ekModules: manualModules,
  });
  assert.equal(member.ekModulesSource, 'manual', '有模块但无来源 → manual（不冒充官方）');
  assert.equal(member.ekModulesUpdatedAt, null);

  clock.advance(5000);
  const api = makeScoresApi();
  const result = await members.syncOfficialScores(member.id, { api, force: true });
  assert.equal(result.ok, true);
  const saved = members.getMember(member.id);
  assert.equal(saved.ekModulesSource, 'official');
  assert.equal(saved.ekModulesUpdatedAt, T0 + 5000);
  assert.equal(saved.ekModules[0].current, 6);

  // 再手工传一次 ekModules（UI 兼容路径）→ 来源回到 manual（诚实标记，不冒充官方）
  const patched = members.upsertMember({ id: member.id, ekModules: manualModules });
  assert.equal(patched.ekModulesSource, 'manual');
});

test('upsertMember 保留语义：patch 不含 ekModules 时不清空已同步数据', async () => {
  const { members } = makeMembers();
  const member = addMember(members);
  await members.syncOfficialScores(member.id, { api: makeScoresApi(), force: true });
  const synced = members.getMember(member.id);
  assert.equal(synced.ekModules.length, 8);

  // UI 保存成员时会 delete 掉 ekModules/ekModulesSource/ekModulesUpdatedAt（避免旧快照覆盖）
  const patched = members.upsertMember({ id: member.id, name: '改名了', note: '改备注' });
  assert.equal(patched.name, '改名了');
  assert.deepEqual(patched.ekModules, synced.ekModules, '未提供 ekModules → 保留已同步值');
  assert.equal(patched.ekModulesSource, 'official');
  assert.equal(patched.ekModulesUpdatedAt, synced.ekModulesUpdatedAt);
});

test('同步：写入两处存储后，engineStorage 读到的是同一份 snapshot', async () => {
  const { members } = makeMembers();
  const member = addMember(members);
  await members.syncOfficialScores(member.id, { api: makeScoresApi(), force: true });

  const engineStorage = members.engineStorage(member.id);
  const raw = engineStorage.get('auto3ct:scores');
  assert.ok(raw, '引擎 storage 能读到 auto3ct:scores');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.accounts['20230001'].snapshot.source, 'official');
  // 引擎 score-policy 直接可用：evaluatePolicy 判定 trusted
  const policy = ScorePolicy.evaluatePolicy({
    snapshot: parsed.accounts['20230001'].snapshot,
    accountId: '20230001',
    now: T0,
    staleMs: 24 * 60 * 60 * 1000,
  });
  assert.equal(policy.trusted, true);
  assert.equal(policy.accountMatch, true);
  assert.equal(policy.totalGap, 29.5);
  assert.equal(policy.reason, 'ok');
});

test('同步：返回值与日志不含 token 或密码（存储本身按契约保留会话）', async () => {
  const { members, storage, logs } = makeMembers();
  const member = addMember(members, { ekCredentials: ekCredentials() });
  const result = await members.syncOfficialScores(member.id, { api: makeScoresApi(), force: true });
  assert.equal(result.ok, true);
  const exposed = JSON.stringify({ result, logs });
  ['access-token-secret', 'refresh-token-secret', 'secret-password', 'session-secret'].forEach((secret) => {
    assert.equal(exposed.includes(secret), false, '返回值/日志泄漏：' + secret);
  });
  // 引擎积分存储只放分数快照，不含任何凭证
  const scoresRaw = storage.raw('1ct:scores:' + member.id);
  ['access-token-secret', 'refresh-token-secret', 'secret-password', 'session-secret', 'JSESSIONID'].forEach(
    (secret) => {
      assert.equal(scoresRaw.includes(secret), false, '积分存储泄漏：' + secret);
    },
  );
  // 导出视图（UI 用）同样不含凭证
  const exported = JSON.stringify(members.exportMembers());
  ['access-token-secret', 'secret-password'].forEach((secret) => {
    assert.equal(exported.includes(secret), false, '导出泄漏：' + secret);
  });
});

test('parseOfficialScoreResponse 纯函数可独立复用（UI/统计侧免重复实现）', () => {
  const parsed = Members.parseOfficialScoreResponse(officialScores());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.accountHint, '20230001');
  assert.equal(parsed.modules.length, 8);
  assert.deepEqual(
    parsed.modules.map((m) => m.current),
    [6, 4, 2, 8.5, 4, 15.5, 11, 3.5],
  );
  // 模块定义与 score-policy 完全一致（口径唯一来源）
  assert.deepEqual(
    Members.SCORE_MODULES.map((m) => ({ name: m.name, required: m.required })),
    ScorePolicy.MODULES.map((m) => ({ name: m.name, required: m.required })),
  );
  // 非对象/空对象
  assert.equal(Members.parseOfficialScoreResponse(null).ok, false);
  assert.equal(Members.parseOfficialScoreResponse({}).reason, 'response-empty');
});

