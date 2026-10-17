/**
 * Auto3CTResults 结果仓库的单元测试（Node 内置 test runner）。
 *
 * 运行：node --test desktop/test-result-store.cjs
 *
 * 覆盖：
 * - UMD 全局名（浏览器 window.Auto3CTResults / 别名 Auto3CTResultStore）+ Node require
 * - append/recordRound upsert 去重（相同 key 不重复计数；更丰富字段合并保留）
 * - preview/dry-run 不记录、不计成功
 * - 成功只认上游已接受（status==='success'）
 * - 有界保留：最多 2000 条、最少 90 天窗口；统计只按窗口内
 * - list 过滤：日期区间/模块/状态/账号
 * - summary：按模块/账号/日期/动作统计；签到签退不混算“活动完成数”
 * - importLegacy 旧 state.done：只显示旧动作（无明细/距离），不重复计完成
 * - 不存 payload/token/密码/完整手机号；账号手机号做掩码
 * - 存储损坏不抛错、不丢崩溃（返回空并标记 corrupt）
 * - 导出 JSON 只含脱敏字段；XSS 文本原样保存（渲染层用 textContent）
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const STORE_PATH = path.join(__dirname, 'result-store.js');
const Results = require(STORE_PATH);

const DAY_MS = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 17, 0, 0, 0); // 2026-10-17T08:00+08:00 === 2026-10-17 北京日

function memoryStorage(initial) {
  const data = new Map(Object.entries(initial || {}));
  return {
    data,
    get(key) {
      return data.has(key) ? data.get(key) : null;
    },
    set(key, value) {
      data.set(key, String(value));
    },
    remove(key) {
      data.delete(key);
    },
  };
}

function makeStore(opts) {
  const storage = (opts && opts.storage) || memoryStorage();
  let nowValue = (opts && opts.now) || T0;
  const store = Results.createStore({
    storage,
    clock: { now: () => nowValue },
  });
  return {
    store,
    storage,
    setNow(value) {
      nowValue = value;
    },
    now() {
      return nowValue;
    },
  };
}

function event(overrides) {
  return Object.assign(
    {
      key: 'k-1',
      at: T0,
      accountId: 'ek-account-1',
      module: 'ek',
      action: 'signIn',
      activityId: 'act-1',
      activityName: '讲座活动',
      category: '思想政治与道德修养',
      status: 'success',
      reason: '',
    },
    overrides || {},
  );
}

test('模块导出与 UMD 全局名', () => {
  assert.equal(typeof Results.createStore, 'function');
  assert.equal(typeof Results.KEY, 'string');
  assert.equal(Results.KEY, 'auto3ct:results');
  // UMD：Node require 与浏览器全局指向同一实现
  assert.equal(typeof globalThis.Auto3CTResults, 'object');
  assert.equal(globalThis.Auto3CTResults, Results);
  assert.equal(globalThis.Auto3CTResultStore, Results);
});

test('append 写入并按 key 去重（重复同 key 不重复计数）', () => {
  const { store, storage } = makeStore();
  assert.equal(store.append(event()), true);
  assert.equal(store.append(event()), true);
  const events = store.list();
  assert.equal(events.length, 1);
  assert.equal(events[0].key, 'k-1');
  const raw = JSON.parse(storage.get(Results.KEY));
  assert.equal(raw.version, 1);
  assert.equal(raw.events.length, 1);
});

test('重复同 key 成功：首次 success 名称/时间稳定，仅补缺更丰富字段', () => {
  const { store } = makeStore();
  store.append(event({ activityName: '首次名称' }));
  const firstAt = store.list()[0].at;
  store.append(
    event({
      at: firstAt + 60 * 60 * 1000,
      activityName: '后续名称',
      distanceMeters: 3000,
      stage: 'run-record',
    }),
  );
  const [saved] = store.list();
  // 首次 success 的时间/名称保持稳定（不被后续 tick 改写）
  assert.equal(saved.activityName, '首次名称');
  assert.equal(saved.at, firstAt);
  // 缺失的距离/stage 允许补全
  assert.equal(saved.distanceMeters, 3000);
  assert.equal(saved.stage, 'run-record');
  assert.equal(store.list().length, 1);
});

test('已 done 的 success 不会被 skipped 覆盖', () => {
  const { store } = makeStore();
  store.append(event({ key: 'k-2' }));
  store.append(event({ key: 'k-2', status: 'skipped', reason: 'already-done' }));
  const [saved] = store.list();
  assert.equal(saved.status, 'success');
});

test('preview/dry-run 轮次不落库、不计成功', () => {
  const { store } = makeStore();
  assert.equal(store.recordRound({ dryRun: true, results: [event({ key: 'p-1' })] }).recorded, 0);
  assert.equal(store.recordRound({ preview: true, results: [event({ key: 'p-2' })] }).recorded, 0);
  assert.equal(store.list().length, 0);
  assert.equal(store.summary().success, 0);
  // 单条 append 带 dryRun 也拒绝
  assert.equal(store.append(event({ key: 'p-3', dryRun: true })), false);
  assert.equal(store.append(event({ key: 'p-4', preview: true })), false);
});

test('recordRound 只记录真实提交轮次并统计成功', () => {
  const { store } = makeStore();
  const result = store.recordRound({
    dryRun: false,
    results: [
      event({ key: 'r-1', status: 'success' }),
      event({ key: 'r-2', status: 'failed', reason: 'network' }),
      event({ key: 'r-3', status: 'unknown', reason: 'no-receipt' }),
      event({ key: 'r-4', status: 'waiting-material', reason: 'need-qr' }),
      event({ key: 'r-5', status: 'blocked', reason: 'module-satisfied' }),
    ],
  });
  assert.equal(result.recorded, 5);
  const summary = store.summary();
  assert.equal(summary.total, 5);
  assert.equal(summary.success, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.unknown, 1);
  assert.equal(summary.waiting, 1);
  assert.equal(summary.blocked, 1);
});

test('相同 key/status 每 tick 重复记录会 upsert 不刷爆', () => {
  const { store } = makeStore();
  for (let i = 0; i < 50; i += 1) {
    store.append(event({ key: 'tick-1', status: 'waiting-material', reason: 'need-qr' }));
    store.append(event({ key: 'tick-2', status: 'success' }));
  }
  assert.equal(store.list().length, 2);
});

test('list 过滤：日期区间/模块/状态/账号（北京日）', () => {
  const { store } = makeStore();
  store.append(event({ key: 'd1', at: T0, accountId: 'ek-a', module: 'ek', status: 'success' }));
  store.append(
    event({ key: 'd2', at: T0 + DAY_MS, accountId: 'club-a', module: 'club', status: 'failed' }),
  );
  store.append(
    event({ key: 'd3', at: T0 + 2 * DAY_MS, accountId: 'run-a', module: 'unirun', status: 'success' }),
  );

  assert.equal(store.list({ from: '2026-10-18', to: '2026-10-19' }).length, 2);
  assert.equal(store.list({ module: 'club' }).length, 1);
  assert.equal(store.list({ status: 'success' }).length, 2);
  assert.equal(store.list({ accountId: 'run-a' }).length, 1);
  assert.equal(store.list({ from: '2026-10-01', to: '2026-10-16' }).length, 0);
});

test('summary 按模块/账号/日期/动作统计；活动完成需 in+out（apply/单独签到不算）', () => {
  const { store } = makeStore();
  store.append(event({ key: 'a1', action: 'signIn', activityId: 'act-9', status: 'success' }));
  store.append(event({ key: 'a2', action: 'signOut', activityId: 'act-9', status: 'success' }));
  store.append(event({ key: 'a3', action: 'apply', activityId: 'act-8', status: 'success' }));
  store.append(event({ key: 'a4', action: 'run', activityId: 'run-1', status: 'success' }));
  store.append(event({ key: 'a5', action: 'signIn', activityId: 'act-7', status: 'success' })); // 只有 in
  store.append(event({ key: 'a6', action: 'checkOut', activityId: 'act-6', status: 'success' })); // 只有 out

  const summary = store.summary();
  assert.equal(summary.success, 6);
  assert.equal(summary.byModule.ek, 6);
  assert.equal(summary.byAction.signIn, 2);
  assert.equal(summary.byAction.signOut, 1);
  assert.equal(summary.byAction.apply, 1);
  assert.equal(summary.byAction.run, 1);
  // 只有 in+out 的 act-9 算完成；act-7 仅 in、act-6 仅 out、act-8 仅 apply 都不算
  assert.equal(summary.activities, 1);
  assert.equal(summary.byDay['2026-10-17'], 6);
});

test('summary 支持按账号过滤（ek/tanma 历史隔离，不混筛成空）', () => {
  const { store } = makeStore();
  store.append(event({ key: 'ek-1', accountId: 'ek-a', module: 'ek' }));
  store.append(event({ key: 'tm-1', accountId: 'tanma-a', module: 'unirun' }));
  assert.equal(store.summary({ accountId: 'ek-a' }).total, 1);
  assert.equal(store.summary({ accountId: 'tanma-a' }).total, 1);
  assert.equal(store.summary({ accountId: 'ek-a' }).byModule.ek, 1);
  assert.equal(store.summary({ accountId: 'tanma-a' }).byModule.unirun, 1);
});

test('有界保留：最多 2000 条，超出后保留最新', () => {
  const { store } = makeStore();
  for (let i = 0; i < 2100; i += 1) {
    store.append(event({ key: 'e-' + i, at: T0 + i * 1000 }));
  }
  const events = store.list();
  assert.equal(events.length, 2000);
  assert.equal(events[0].key, 'e-2099'); // 最新在前
  assert.equal(events[events.length - 1].key, 'e-100');
  assert.equal(store.retentionInfo().count, 2000);
});

test('有界保留：仅保留最近 90 天记录（写入窗口截断 + 统计窗口过滤）', () => {
  const { store, setNow } = makeStore({ now: T0 + 100 * DAY_MS });
  // 写入时 now=T0+100d，cutoff=T0+10d：更早的不会写入（直接用 append 的 event 时间评估）
  store.append(event({ key: 'old', at: T0 }));
  store.append(event({ key: 'recent', at: T0 + 95 * DAY_MS }));
  // 写入时已按窗口裁剪，old 不会落库；recent 在窗口内
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].key, 'recent');
  // 时间推进到 T0+200d：recent(day=T0+95d) 也超出 now-90d 窗口，读取时过滤为空
  setNow(T0 + 200 * DAY_MS);
  assert.equal(store.list().length, 0);
});

test('importLegacy：旧 state.done 只显示旧动作，不伪造明细/距离，不重复计完成', () => {
  const { store } = makeStore();
  const legacy = {
    '2026-10-16::task_a': 1,
    '2026-10-16|acc-1|ek|apply|act-7': 2,
    '2026-10-17::task_b': 1,
  };
  const count = store.importLegacy(legacy);
  assert.ok(count >= 1);
  const events = store.list();
  assert.ok(events.length >= 1);
  for (const item of events) {
    assert.equal(item.status, 'legacy');
    assert.equal(item.legacy, true);
    assert.equal(item.preview, false);
    assert.equal(item.activityName, undefined);
    assert.equal(item.distanceMeters, undefined);
  }
  // 旧 done 不参与成功数/活动完成数
  assert.equal(store.summary().success, 0);
  assert.equal(store.summary().activities, 0);
  // 重复导入不重复
  const before = store.list().length;
  store.importLegacy(legacy);
  assert.equal(store.list().length, before);
});

test('不存 payload/token/密码/完整手机号；手机号账号做掩码', () => {
  const { store, storage } = makeStore();
  store.append(
    event({
      key: 's-1',
      accountId: '13800001111',
      payload: { password: 'secret' },
      token: 'tok-value',
      password: 'p',
      phone: '13800001111',
    }),
  );
  const raw = storage.get(Results.KEY);
  assert.ok(!raw.includes('secret'), 'raw storage 不应含 payload/password');
  assert.ok(!raw.includes('tok-value'), 'raw storage 不应含 token');
  assert.ok(!raw.includes('13800001111'), 'raw storage 不应含完整手机号');
  const [saved] = store.list();
  assert.equal(saved.payload, undefined);
  assert.equal(saved.token, undefined);
  assert.equal(saved.password, undefined);
  assert.equal(saved.phone, undefined);
  assert.equal(saved.accountMask, '138****1111');
});

test('存储损坏：不抛错、返回空并标记 corrupt；不静默覆盖，需显式 clear 后恢复', () => {
  const storage = memoryStorage({ [Results.KEY]: '{broken json' });
  const store = Results.createStore({ storage, clock: { now: () => T0 } });
  assert.deepEqual(store.list(), []);
  assert.equal(store.retentionInfo().corrupt, true);
  // 不静默覆盖用户数据：append 拒绝并暴露 persistenceError
  assert.equal(store.append(event({ key: 'fix-1' })), false);
  assert.equal(store.retentionInfo().persistenceError, 'storage-corrupt');
  // 显式 clear 之后才允许重新写入
  store.clear();
  assert.equal(store.append(event({ key: 'fix-2' })), true);
  assert.equal(store.list().length, 1);
});

test('clear 清空历史但保留保留策略元信息', () => {
  const { store } = makeStore();
  store.append(event({ key: 'c-1' }));
  store.clear();
  assert.equal(store.list().length, 0);
  assert.equal(store.retentionInfo().count, 0);
  assert.equal(store.retentionInfo().maxEvents, 2000);
});

test('exportJSON 只导出脱敏允许字段，且对 XSS 文本保持原文（渲染层用 textContent）', () => {
  const { store } = makeStore();
  const malicious = '<img src=x onerror=alert(1)>';
  store.append(event({ key: 'x-1', activityName: malicious }));
  const exported = store.exportJSON();
  const parsed = JSON.parse(exported);
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.events[0].activityName, malicious); // 数据原样，渲染层负责 textContent
  assert.equal(parsed.events[0].token, undefined);
  assert.equal(parsed.events[0].payload, undefined);
  assert.ok(!exported.includes('secret'));
});

test('重载保持：同一 storage 新建 store 能读到历史', () => {
  const storage = memoryStorage();
  const first = Results.createStore({ storage, clock: { now: () => T0 } });
  first.append(event({ key: 'persist-1' }));
  const second = Results.createStore({ storage, clock: { now: () => T0 } });
  assert.equal(second.list().length, 1);
  assert.equal(second.list()[0].key, 'persist-1');
});

test('仅 status 为 dry-run/preview 的事件被拒绝（不靠 dryRun 标志）', () => {
  const { store, storage } = makeStore();
  assert.equal(store.append({ key: 'sdr-1', status: 'dry-run', accountId: 'a', module: 'ek', action: 'apply' }), false);
  assert.equal(store.append({ key: 'sdr-2', status: 'dry_run', accountId: 'a', module: 'ek', action: 'apply' }), false);
  assert.equal(store.append({ key: 'sdr-3', status: 'preview', accountId: 'a', module: 'ek', action: 'apply' }), false);
  assert.equal(store.list().length, 0);
  const raw = storage.get('auto3ct:results');
  assert.ok(!raw || raw.indexOf('sdr-1') < 0, 'status-only preview 不得入库');

  const round = store.recordRound({ dryRun: false, results: [{ key: 'sdr-4', status: 'dry-run', module: 'ek', action: 'apply' }] });
  assert.equal(round.recorded, 0);
  assert.equal(store.list().length, 0);
});

test('skip 跨天/下一 tick 不改写已 success 的日期、时间、reason 与距离', () => {
  const { store } = makeStore();
  store.append(event({ key: 'stable-1', at: T0, status: 'success', reason: 'ok' }));
  const first = store.list()[0];
  store.append(
    event({
      key: 'stable-1',
      at: T0 + 3 * DAY_MS,
      status: 'skipped',
      reason: 'already-done',
      distanceMeters: 9999,
    }),
  );
  const [after] = store.list();
  assert.equal(after.status, 'success');
  assert.equal(after.at, first.at);
  assert.equal(after.day, first.day);
  assert.equal(after.reason, 'ok');
  assert.notEqual(after.distanceMeters, 9999);
  assert.equal(store.summary().byDay[first.day], 1);
  assert.equal(store.summary().byDay['2026-10-20'], undefined);
});

test('key/reason 泄露 token/password/手机号会被脱敏且不入库', () => {
  const { store, storage } = makeStore();
  store.append(
    event({
      key: 'k-13800001111-token=abcsecret',
      reason: 'password=supersecret cookie=session123',
      activityName: '正常活动',
    }),
  );
  const raw = storage.get('auto3ct:results');
  assert.ok(raw.indexOf('13800001111') < 0, 'key 不得含完整手机号');
  assert.ok(raw.indexOf('supersecret') < 0, 'reason 不得含密码');
  assert.ok(raw.indexOf('session123') < 0, 'reason 不得含 cookie');
  const [saved] = store.list();
  assert.ok(saved.key.indexOf('13800001111') < 0);
  assert.equal(saved.reason, 'suppressed-untrusted-reason');
});

test('手机号账号身份 hash，不用 mask 做过滤键（避免同头尾 collide）', () => {
  const { store } = makeStore();
  store.append(event({ key: 'p1', accountId: '13800001111' }));
  store.append(event({ key: 'p2', accountId: '13899991111' }));
  const events = store.list();
  assert.equal(events.length, 2);
  assert.ok(events[0].accountId.indexOf('phone-') === 0);
  assert.notEqual(events[0].accountId, events[1].accountId);
  // 仍保留可展示的掩码
  assert.match(events[0].accountMask, /^138\*{4}1111$/);
  assert.equal(store.list({ accountId: events[0].accountId }).length, 1);
});

test('活动完成身份含 module+account+activity+日期：A 签到 + B 签退不算假完成', () => {
  const { store } = makeStore();
  store.append(event({ key: 'x1', accountId: 'acc-A', module: 'ek', activityId: 'act-X', action: 'signIn', status: 'success' }));
  store.append(event({ key: 'x2', accountId: 'acc-B', module: 'ek', activityId: 'act-X', action: 'signOut', status: 'success' }));
  store.append(event({ key: 'x3', accountId: 'acc-A', module: 'club', activityId: 'act-X', action: 'signOut', status: 'success' }));
  assert.equal(store.summary().activities, 0);
  // 同账号同模块同活动同一天 in+out 才算
  store.append(event({ key: 'x4', accountId: 'acc-A', module: 'ek', activityId: 'act-X', action: 'signOut', status: 'success' }));
  assert.equal(store.summary().activities, 1);
});

test('byDaySuccess 只统计 success；byDay 保留全状态（趋势标题需区分）', () => {
  const { store } = makeStore();
  store.append(event({ key: 'bd1', status: 'success' }));
  store.append(event({ key: 'bd2', status: 'failed' }));
  store.append(event({ key: 'bd3', status: 'waiting-material' }));
  const summary = store.summary();
  assert.equal(summary.byDay['2026-10-17'], 3);
  assert.equal(summary.byDaySuccess['2026-10-17'], 1);
});

test('runDistanceMeters 只累计 unirun 成功且正数距离', () => {
  const { store } = makeStore();
  store.append(event({ key: 'r1', module: 'unirun', action: 'run', status: 'success', distanceMeters: 3000 }));
  store.append(event({ key: 'r2', module: 'unirun', action: 'run', status: 'success', distanceMeters: 1200.5 }));
  store.append(event({ key: 'r3', module: 'unirun', action: 'run', status: 'failed', distanceMeters: 5000 }));
  store.append(event({ key: 'r4', module: 'ek', status: 'success', distanceMeters: 8000 }));
  store.append(event({ key: 'r5', module: 'unirun', action: 'run', status: 'success', distanceMeters: -1 }));
  assert.equal(store.summary().runDistanceMeters, 4200.5);
});

test('save 失败返回 false 并暴露 persistenceError（不伪已保存）', () => {
  const data = new Map();
  let failWrites = false;
  const storage = {
    get: (k) => (data.has(k) ? data.get(k) : null),
    set: (k, v) => {
      if (failWrites) throw new Error('disk-full');
      data.set(k, String(v));
    },
    remove: (k) => data.delete(k),
  };
  const store = Results.createStore({ storage, clock: { now: () => T0 } });
  assert.equal(store.append(event({ key: 'pf-1' })), true);
  failWrites = true;
  assert.equal(store.append(event({ key: 'pf-2' })), false);
  assert.equal(store.retentionInfo().persistenceError, 'storage-write-failed');
});

test('历史损坏时不静默覆盖：append 返回 false 并保留原始字节，需显式 clear 才重置', () => {
  const broken = '{broken-history-bytes';
  const storage = memoryStorage({ [Results.KEY]: broken });
  const store = Results.createStore({ storage, clock: { now: () => T0 } });
  assert.equal(store.retentionInfo().corrupt, true);
  assert.equal(store.append(event({ key: 'corrupt-1' })), false);
  assert.equal(storage.get(Results.KEY), broken, '不得静默用空历史覆盖用户数据');
  store.clear();
  assert.equal(store.append(event({ key: 'corrupt-2' })), true);
});


test('list 支持 accountIds 联合筛选（ek + tanma 各自默认账号）', () => {
  const { store } = makeStore();
  store.append(event({ key: 'u1', accountId: 'ek-a', module: 'ek' }));
  store.append(event({ key: 'u2', accountId: 'tanma-a', module: 'unirun' }));
  store.append(event({ key: 'u3', accountId: 'other', module: 'club' }));
  assert.equal(store.list({ accountIds: ['ek-a', 'tanma-a'] }).length, 2);
  assert.equal(store.list({ accountIds: [] }).length, 3);
  assert.equal(store.list({ accountId: 'ek-a' }).length, 1);
});

test('byModuleAction 逐模块成功动作细分（校园跑次数/俱乐部报名签到签退/二课）', () => {
  const { store } = makeStore();
  store.append(event({ key: 's1', module: 'unirun', action: 'run', status: 'success' }));
  store.append(event({ key: 's2', module: 'unirun', action: 'run', status: 'success' }));
  store.append(event({ key: 's3', module: 'club', action: 'join', status: 'success' }));
  store.append(event({ key: 's4', module: 'club', action: 'signIn', status: 'success' }));
  store.append(event({ key: 's5', module: 'club', action: 'signOut', status: 'success' }));
  store.append(event({ key: 's6', module: 'ek', action: 'join', status: 'success' }));
  store.append(event({ key: 's7', module: 'ek', action: 'signIn', status: 'failed' }));
  const summary = store.summary();
  assert.equal(summary.byModuleAction['unirun.run'], 2);
  assert.equal(summary.byModuleAction['club.join'], 1);
  assert.equal(summary.byModuleAction['club.signIn'], 1);
  assert.equal(summary.byModuleAction['club.signOut'], 1);
  assert.equal(summary.byModuleAction['ek.join'], 1);
  assert.equal(summary.byModuleAction['ek.signIn'], undefined); // failed 不计
});

test('byModuleAction 兼容官方实际 action 名（ek.apply→ek.join、unirun.autoRun→unirun.run）', () => {
  const { store } = makeStore();
  store.append(event({ key: 'al1', module: 'ek', action: 'apply', status: 'success' }));
  store.append(event({ key: 'al2', module: 'unirun', action: 'autoRun', status: 'success', distanceMeters: 2000 }));
  const summary = store.summary();
  assert.equal(summary.byModuleAction['ek.apply'], 1);
  assert.equal(summary.byModuleAction['ek.join'], 1);
  assert.equal(summary.byModuleAction['unirun.autoRun'], 1);
  assert.equal(summary.byModuleAction['unirun.run'], 1);
  assert.equal(summary.runDistanceMeters, 2000);
});
test('有界天数可配置且不低于 90 天', () => {
  const { store } = makeStore();
  const info = Results.createStore({ storage: memoryStorage(), clock: { now: () => T0 } }).retentionInfo();
  assert.ok(info.retainDays >= 90);
  assert.equal(info.maxEvents, 2000);
  assert.equal(store.retentionInfo().retainDays, info.retainDays);
});
