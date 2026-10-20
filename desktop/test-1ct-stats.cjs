/**
 * 1CT 二课统计模块测试（node:test，零外部依赖）。
 *
 * 运行：node --test desktop/test-1ct-stats.cjs
 *
 * 覆盖（对应 docs/1ct-redesign-contract.md §4 与 task-5 验收项）：
 *  1) 成功口径：status==='success' 且 action 为 signIn/signOut；module 必须是 ek；
 *     preview/dryRun/legacy 不计；memberId 隔离；
 *  2) gap 口径：gap=max(0,required-current)；current 缺失 -> gap=null 且不计入 totalGap；
 *  3) 90 天窗口：北京日期边界（含 cutoff 当天、排除前一天）；
 *  4) CSV：BOM、逗号/引号/换行转义、null 导出空单元格、手机号掩码、公式注入防护；
 *  5) renderInto：最小 DOM stub 验证节点数/文本/属性（无 jsdom，不改 package.json）；
 *  6) 凭证红线：ekCredentials / token / password 不渲染、不导出；
 *  7) 会话状态：ekStatus('ok'|'expired'|'none') 展示，expired 显示需重新登录；
 *  8) UMD：Node require 可用 + 浏览器 window.OneCTStats（vm 沙箱模拟）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const Stats = require('./1ct/ek-stats.js');
const ScorePolicy = require('./score-policy.js');

const DAY_MS = 24 * 60 * 60 * 1000;
/** 固定「现在」：2026-10-17 12:00 北京（UTC 04:00），与契约冻结日一致。 */
const NOW = Date.parse('2026-10-17T12:00:00+08:00');
/** result-store 口径的 90 天 cutoff 北京日期。 */
const CUTOFF_DAY = '2026-07-19';

// ───────────────────────── 夹具 ─────────────────────────

function ekEvent(overrides) {
  const base = {
    key: 'k-' + Math.random().toString(36).slice(2, 10),
    module: 'ek',
    action: 'signIn',
    activityId: 'act-1',
    activityName: '活动一',
    category: '思想政治与道德修养',
    status: 'success',
    at: NOW - 60 * 60 * 1000,
    day: null,
  };
  const event = Object.assign(base, overrides || {});
  if (!event.day) event.day = new Date(event.at + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return event;
}

function member(overrides) {
  return Object.assign(
    {
      id: 'm_001',
      name: '张三',
      enabled: true,
      ekStatus: 'ok',
      ekUpdatedAt: null,
      ekModules: null,
      ekCredentials: null,
      ek: null,
    },
    overrides || {}
  );
}

function eightModules(currentOverrides) {
  const overrides = currentOverrides || {};
  return ScorePolicy.MODULES.map((m) => ({ name: m.name, required: m.required, current: overrides[m.name] }));
}

// ───────────────────────── 最小 DOM stub ─────────────────────────

function createDocumentStub() {
  const doc = {
    createElement(tagName) {
      return new StubNode(doc, tagName);
    },
  };
  return doc;
}

class StubNode {
  constructor(doc, tagName) {
    this.ownerDocument = doc;
    this.tagName = String(tagName).toUpperCase();
    this.childNodes = [];
    this.attributes = {};
    this.className = '';
    this._ownText = '';
  }

  get firstChild() {
    return this.childNodes.length > 0 ? this.childNodes[0] : null;
  }

  get textContent() {
    if (this.childNodes.length === 0) return this._ownText;
    return this.childNodes.map((child) => child.textContent).join('');
  }

  set textContent(value) {
    this.childNodes.length = 0;
    this._ownText = value === null || value === undefined ? '' : String(value);
  }

  appendChild(child) {
    this.childNodes.push(child);
    child.parentNode = this;
    this._ownText = '';
    return child;
  }

  removeChild(child) {
    const index = this.childNodes.indexOf(child);
    if (index >= 0) this.childNodes.splice(index, 1);
    return child;
  }

  replaceChildren(...nodes) {
    this.childNodes.length = 0;
    this._ownText = '';
    nodes.forEach((node) => this.appendChild(node));
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
  }
}

function childrenByTag(node, tagName) {
  const out = [];
  const tag = String(tagName).toUpperCase();
  (node.childNodes || []).forEach((child) => {
    if (child.tagName === tag) out.push(child);
    out.push(...childrenByTag(child, tagName));
  });
  return out;
}

function childrenByClass(node, className) {
  const out = [];
  const wanted = String(className).split(/\s+/).filter(Boolean);
  (node.childNodes || []).forEach((child) => {
    const classes = String(child.className || '').split(/\s+/).filter(Boolean);
    if (wanted.every((name) => classes.includes(name))) out.push(child);
    out.push(...childrenByClass(child, className));
  });
  return out;
}

function childrenByAttr(node, attr, value) {
  const out = [];
  (node.childNodes || []).forEach((child) => {
    if (child.getAttribute && child.getAttribute(attr) === String(value)) out.push(child);
    out.push(...childrenByAttr(child, attr, value));
  });
  return out;
}

/** 渲染到 stub 容器并返回容器。 */
function renderStub(stat, opts) {
  const doc = createDocumentStub();
  const container = new StubNode(doc, 'div');
  Stats.renderInto(container, stat, opts);
  return container;
}

/** 极简 RFC4180 解析（仅测试用）。 */
function parseCsv(textValue) {
  const text = textValue.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\r') {
      // 忽略，\n 结束行
    } else if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

// ═══════════════════════ 1) 模块加载 / UMD ═══════════════════════

test('UMD：Node require 导出完整接口', () => {
  assert.strictEqual(typeof Stats.build, 'function');
  assert.strictEqual(typeof Stats.buildAll, 'function');
  assert.strictEqual(typeof Stats.renderInto, 'function');
  assert.strictEqual(typeof Stats.toCSV, 'function');
  assert.strictEqual(Stats.WINDOW_DAYS, 90);
});

test('UMD：浏览器沙箱下挂载 window.OneCTStats 且可独立 build', () => {
  const code = fs.readFileSync(path.join(__dirname, '1ct', 'ek-stats.js'), 'utf8');
  const sandbox = { Auto3CTScorePolicy: ScorePolicy };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'ek-stats.js' });

  assert.ok(sandbox.OneCTStats, '应挂载 window.OneCTStats');
  assert.strictEqual(typeof sandbox.OneCTStats.build, 'function');
  const stat = sandbox.OneCTStats.build({
    member: member(),
    events: [ekEvent({ memberId: 'm_001' })],
    scoreEntry: null,
    now: NOW,
  });
  assert.strictEqual(stat.signIn.success, 1);
  assert.strictEqual(stat.memberName, '张三');
});

test('getModules 从 score-policy 读取八模块（不复制常量）', () => {
  const modules = Stats.getModules();
  assert.strictEqual(modules.length, 8);
  assert.deepStrictEqual(
    modules.map((m) => m.name),
    ScorePolicy.MODULES.map((m) => m.name)
  );
  assert.deepStrictEqual(
    modules.map((m) => m.required),
    ScorePolicy.MODULES.map((m) => m.required)
  );
});

// ═══════════════════════ 2) 成功计数口径 ═══════════════════════

test('成功口径：仅 status=success 且 action 为 signIn/signOut 计入', () => {
  const events = [
    ekEvent({ memberId: 'm_001', action: 'signIn', status: 'success', at: NOW - 1 * 3600e3 }),
    ekEvent({ memberId: 'm_001', action: 'signOut', status: 'success', at: NOW - 2 * 3600e3 }),
    // 以下都不算成功
    ekEvent({ memberId: 'm_001', action: 'signIn', status: 'failed', at: NOW - 3 * 3600e3 }),
    ekEvent({ memberId: 'm_001', action: 'signOut', status: 'waiting-material', at: NOW - 4 * 3600e3 }),
    ekEvent({ memberId: 'm_001', action: 'signIn', status: 'not-yet', at: NOW - 5 * 3600e3 }),
    ekEvent({ memberId: 'm_001', action: 'signIn', status: 'skipped', at: NOW - 6 * 3600e3 }),
    ekEvent({ memberId: 'm_001', action: 'signIn', status: 'blocked', at: NOW - 7 * 3600e3 }),
    // 其他 action 不算签到/签退成功
    ekEvent({ memberId: 'm_001', action: 'apply', status: 'success', at: NOW - 8 * 3600e3 }),
    ekEvent({ memberId: 'm_001', action: 'detail', status: 'success', at: NOW - 9 * 3600e3 }),
  ];
  const stat = Stats.build({ member: member(), events, scoreEntry: null, now: NOW });

  assert.strictEqual(stat.signIn.success, 1);
  assert.strictEqual(stat.signIn.failed, 1);
  assert.strictEqual(stat.signIn.waiting, 1, 'not-yet 计入签到等待');
  assert.strictEqual(stat.signIn.skipped, 1);
  assert.strictEqual(stat.signIn.blocked, 1);
  assert.strictEqual(stat.signOut.success, 1);
  assert.strictEqual(stat.signOut.failed, 0);
  assert.strictEqual(stat.signOut.waiting, 1, 'waiting-material 计入签退等待');
});

test('成功口径：非 ek 模块（club/unirun）与 legacy/preview/dryRun 事件不计', () => {
  const events = [
    ekEvent({ memberId: 'm_001', action: 'signIn', status: 'success' }),
    ekEvent({ memberId: 'm_001', module: 'club', action: 'signIn', status: 'success' }),
    ekEvent({ memberId: 'm_001', module: 'unirun', action: 'signIn', status: 'success' }),
    ekEvent({ memberId: 'm_001', action: 'signIn', status: 'success', legacy: true }),
    ekEvent({ memberId: 'm_001', action: 'signIn', status: 'success', preview: true }),
    ekEvent({ memberId: 'm_001', action: 'signIn', status: 'success', dryRun: true }),
  ];
  const stat = Stats.build({ member: member(), events, scoreEntry: null, now: NOW });
  assert.strictEqual(stat.signIn.success, 1);
  assert.strictEqual(stat.meta.eventCount, 1);
});

test('成员隔离：默认只统计同 memberId 事件，无归属历史事件不串号', () => {
  const events = [
    ekEvent({ memberId: 'm_001', action: 'signIn', status: 'success' }),
    ekEvent({ memberId: 'm_002', action: 'signIn', status: 'success' }),
    ekEvent({ memberId: 'm_002', action: 'signOut', status: 'success' }),
    ekEvent({ memberId: '', action: 'signIn', status: 'success' }), // 无归属
  ];
  const statA = Stats.build({ member: member({ id: 'm_001' }), events, scoreEntry: null, now: NOW });
  assert.strictEqual(statA.signIn.success, 1);
  assert.strictEqual(statA.signOut.success, 0);

  const statB = Stats.build({ member: member({ id: 'm_002', name: '李四' }), events, scoreEntry: null, now: NOW });
  assert.strictEqual(statB.signIn.success, 1);
  assert.strictEqual(statB.signOut.success, 1);

  // 显式允许无归属事件时才纳入（兼容历史数据）
  const statUnscoped = Stats.build({
    member: member({ id: 'm_001' }),
    events,
    scoreEntry: null,
    now: NOW,
    includeUnscoped: true,
  });
  assert.strictEqual(statUnscoped.signIn.success, 2);
});

test('lastAt：签到/签退各自取最近一次动作时间', () => {
  const events = [
    ekEvent({ memberId: 'm_001', action: 'signIn', status: 'success', at: NOW - 5 * 3600e3 }),
    ekEvent({ memberId: 'm_001', action: 'signIn', status: 'failed', at: NOW - 1 * 3600e3 }),
    ekEvent({ memberId: 'm_001', action: 'signOut', status: 'success', at: NOW - 3 * 3600e3 }),
  ];
  const stat = Stats.build({ member: member(), events, scoreEntry: null, now: NOW });
  assert.strictEqual(stat.signIn.lastAt, NOW - 1 * 3600e3);
  assert.strictEqual(stat.signIn.lastSuccessAt, NOW - 5 * 3600e3);
  assert.strictEqual(stat.signOut.lastAt, NOW - 3 * 3600e3);
});

// ═══════════════════════ 3) 活动维度 ═══════════════════════

test('活动维度：签到/签退状态合并，成功不被后续失败降级', () => {
  const events = [
    ekEvent({
      memberId: 'm_001',
      activityId: 'act-A',
      activityName: '志愿活动',
      category: '社会实践与志愿服务',
      action: 'signIn',
      status: 'success',
      at: NOW - 6 * 3600e3,
    }),
    ekEvent({
      memberId: 'm_001',
      activityId: 'act-A',
      activityName: '志愿活动',
      category: '社会实践与志愿服务',
      action: 'signIn',
      status: 'failed',
      at: NOW - 2 * 3600e3,
    }),
    ekEvent({
      memberId: 'm_001',
      activityId: 'act-A',
      activityName: '志愿活动',
      category: '社会实践与志愿服务',
      action: 'signOut',
      status: 'waiting-material',
      at: NOW - 1 * 3600e3,
    }),
    // 只有 apply 的活动不进入活动表
    ekEvent({ memberId: 'm_001', activityId: 'act-B', action: 'apply', status: 'success' }),
  ];
  const stat = Stats.build({ member: member(), events, scoreEntry: null, now: NOW });
  assert.strictEqual(stat.activities.length, 1, '只有签到/签退动作的活动才入表');
  const activity = stat.activities[0];
  assert.strictEqual(activity.activityId, 'act-A');
  assert.strictEqual(activity.name, '志愿活动');
  assert.strictEqual(activity.category, '社会实践与志愿服务');
  assert.strictEqual(activity.signInStatus, 'success', '已成功不被后续 failed 降级');
  assert.strictEqual(activity.signOutStatus, 'waiting-material');
  assert.strictEqual(activity.lastAt, NOW - 1 * 3600e3);
});

test('活动维度：同名活动按 activityId 归并，按最近时间倒序', () => {
  const events = [
    ekEvent({ memberId: 'm_001', activityId: 'act-1', activityName: '活动一', action: 'signIn', at: NOW - 3 * 3600e3 }),
    ekEvent({ memberId: 'm_001', activityId: 'act-2', activityName: '活动一', action: 'signIn', at: NOW - 1 * 3600e3 }),
  ];
  const stat = Stats.build({ member: member(), events, scoreEntry: null, now: NOW });
  assert.strictEqual(stat.activities.length, 2, '同名的不同活动不能合并');
  assert.strictEqual(stat.activities[0].activityId, 'act-2');
});

// ═══════════════════════ 4) 90 天窗口 ═══════════════════════

test('90 天窗口：北京日期 cutoff 当天计入、前一天排除', () => {
  assert.strictEqual(Stats.beijingDay(NOW - 90 * DAY_MS), CUTOFF_DAY, '夹具前提：cutoff 应为 ' + CUTOFF_DAY);
  const events = [
    ekEvent({ memberId: 'm_001', action: 'signIn', status: 'success', at: NOW }),
    // 恰好 90 天前（北京 2026-07-19）-> 计入
    ekEvent({ memberId: 'm_001', action: 'signIn', status: 'success', at: Date.parse('2026-07-19T23:30:00+08:00') }),
    // 91 天前（北京 2026-07-18）-> 排除
    ekEvent({ memberId: 'm_001', action: 'signIn', status: 'success', at: Date.parse('2026-07-18T23:30:00+08:00') }),
    // 半年以前 -> 排除
    ekEvent({ memberId: 'm_001', action: 'signIn', status: 'success', at: Date.parse('2026-01-05T09:00:00+08:00') }),
  ];
  const stat = Stats.build({ member: member(), events, scoreEntry: null, now: NOW });
  assert.strictEqual(stat.signIn.success, 2);
  assert.strictEqual(stat.meta.eventCount, 2);
});

test('90 天窗口：显式 event.day 优先（与 result-store prune 同口径）', () => {
  const events = [
    // at 是新的，但 day 声明为很早：result-store 按 day 淘汰，这里也必须排除
    ekEvent({ memberId: 'm_001', action: 'signIn', status: 'success', at: NOW, day: '2026-01-01' }),
    ekEvent({ memberId: 'm_001', action: 'signIn', status: 'success', at: NOW }),
  ];
  const stat = Stats.build({ member: member(), events, scoreEntry: null, now: NOW });
  assert.strictEqual(stat.signIn.success, 1);
});

// ═══════════════════════ 5) 八模块 gap 口径 ═══════════════════════

test('gap：current 缺失 -> gap=null 且不计入 totalGap（绝不当 0）', () => {
  const modules = [
    { name: '思想政治与道德修养', required: 12, current: 6 }, // gap 6
    { name: '学术科技与创新创业', required: 8, current: null }, // gap null，不计
    { name: '艺术体验与审美修养', required: 12, current: 20 }, // 超额 -> gap 0
  ];
  const stat = Stats.build({ member: member({ ekModules: modules }), events: [], scoreEntry: null, now: NOW });
  const byName = Object.fromEntries(stat.modules.map((m) => [m.name, m]));

  assert.strictEqual(byName['思想政治与道德修养'].gap, 6);
  assert.strictEqual(byName['学术科技与创新创业'].gap, null, '缺失不能当 0');
  assert.strictEqual(byName['学术科技与创新创业'].trusted, false);
  assert.strictEqual(byName['艺术体验与审美修养'].gap, 0);
  assert.strictEqual(byName['艺术体验与审美修养'].satisfied, true);
  assert.strictEqual(stat.totalGap, 6, 'totalGap 只累加非 null gap');
  assert.strictEqual(stat.trusted, false, '有未知模块时整体不可信');
});

test('gap：八模块全部已知时 totalGap 求和且 trusted=true', () => {
  const modules = eightModules({
    思想政治与道德修养: 6, // 12-6=6
    学术科技与创新创业: 8, // 8-8=0
    艺术体验与审美修养: 2, // 12-2=10
    传统文化与人文素养: 8.5, // 0
    人际交往与沟通能力: 4, // 4
    心理素质与身体素质: 15.5, // 0
    社会实践与志愿服务: 11, // 1
    社会工作与能力拓展: 3.5, // 4.5
  });
  const stat = Stats.build({ member: member({ ekModules: modules }), events: [], scoreEntry: null, now: NOW });
  assert.strictEqual(stat.modules.length, 8);
  assert.strictEqual(stat.totalGap, 25.5);
  assert.strictEqual(stat.trusted, true);
  assert.strictEqual(stat.meta.satisfiedCount, 3);
});

test('快照优先于成员手填值；snapshot 缺模块时回落手填（不当 0）', () => {
  const memberModules = eightModules({ 思想政治与道德修养: 1, 艺术体验与审美修养: 3 });
  const snapshot = {
    accountId: 'stu-1',
    source: 'official',
    updatedAt: NOW - 3600e3,
    modules: [
      { name: '思想政治与道德修养', required: 12, current: 9, trusted: true },
      { name: '学术科技与创新创业', required: 8, current: 8, trusted: true },
    ],
  };
  const stat = Stats.build({
    member: member({ ekModules: memberModules }),
    events: [],
    scoreEntry: { snapshot, refreshedAt: NOW - 3600e3 },
    now: NOW,
  });
  const byName = Object.fromEntries(stat.modules.map((m) => [m.name, m]));
  assert.strictEqual(byName['思想政治与道德修养'].current, 9, '官方快照优先');
  assert.strictEqual(byName['学术科技与创新创业'].current, 8);
  assert.strictEqual(byName['艺术体验与审美修养'].current, 3, '快照缺失回落手填');
  assert.strictEqual(byName['传统文化与人文素养'].current, null, '两边都没有仍为 null，不当 0');
  assert.strictEqual(stat.refreshedAt, NOW - 3600e3);
  assert.strictEqual(stat.meta.hasSnapshot, true);
});

test('快照 trusted:false 的模块 gap 保持 null', () => {
  const snapshot = {
    accountId: 'stu-1',
    source: 'official',
    updatedAt: NOW - 1000,
    modules: [{ name: '思想政治与道德修养', required: 12, current: 6, trusted: false }],
  };
  const stat = Stats.build({
    member: member(),
    events: [],
    scoreEntry: { snapshot, refreshedAt: NOW - 1000 },
    now: NOW,
  });
  const target = stat.modules.find((m) => m.name === '思想政治与道德修养');
  assert.strictEqual(target.gap, null);
  assert.strictEqual(target.trusted, false);
  assert.strictEqual(stat.totalGap, 0);
});

test('scoreEntry 兼容引擎原样存储 {version, accounts}（按账号取 snapshot）', () => {
  const snapshot = {
    accountId: 'stu-1',
    source: 'official',
    updatedAt: NOW - 1000,
    modules: [{ name: '思想政治与道德修养', required: 12, current: 10, trusted: true }],
  };
  const engineStore = {
    version: 1,
    accounts: {
      'stu-1': { snapshot, refreshedAt: NOW - 1000, lastAttemptAt: NOW - 1000, lastRefreshError: null },
    },
  };
  const stat = Stats.build({
    member: member({ ek: { user_info: { loginName: 'stu-1' } } }),
    events: [],
    scoreEntry: engineStore,
    now: NOW,
  });
  const target = stat.modules.find((m) => m.name === '思想政治与道德修养');
  assert.strictEqual(target.current, 10);
  assert.strictEqual(stat.refreshedAt, NOW - 1000);
  assert.strictEqual(target.gap, 2);
});

test('stale：快照超过 24h 标记过期；纯手填不算过期；刷新失败原因透出', () => {
  const snapshot = {
    accountId: 'stu-1',
    source: 'official',
    updatedAt: NOW - 3 * DAY_MS,
    modules: [{ name: '思想政治与道德修养', required: 12, current: 6, trusted: true }],
  };
  const staleStat = Stats.build({
    member: member(),
    events: [],
    scoreEntry: { snapshot, refreshedAt: NOW - 3 * DAY_MS },
    now: NOW,
  });
  assert.strictEqual(staleStat.stale, true);

  const manualStat = Stats.build({
    member: member({ ekModules: eightModules({}) }),
    events: [],
    scoreEntry: null,
    now: NOW,
  });
  assert.strictEqual(manualStat.stale, false, '手填数据没有刷新时间戳，不应判过期');

  const errorStat = Stats.build({
    member: member(),
    events: [],
    scoreEntry: { snapshot, refreshedAt: NOW - 3 * DAY_MS, lastRefreshError: 'official-untrusted' },
    now: NOW,
  });
  assert.strictEqual(errorStat.meta.refreshError, 'official-untrusted');
});

// ═══════════════════════ 6) buildAll 多成员汇总 ═══════════════════════

test('buildAll：按成员分别统计并汇总 totals', () => {
  const members = [
    member({ id: 'm_001', name: '张三' }),
    member({ id: 'm_002', name: '李四', ekStatus: 'expired' }),
  ];
  const events = [
    ekEvent({ memberId: 'm_001', action: 'signIn', status: 'success' }),
    ekEvent({ memberId: 'm_001', action: 'signOut', status: 'success' }),
    ekEvent({ memberId: 'm_001', action: 'signIn', status: 'failed' }),
    ekEvent({ memberId: 'm_002', action: 'signIn', status: 'success', activityId: 'act-9' }),
    ekEvent({ memberId: 'm_002', action: 'signOut', status: 'waiting-material' }),
  ];
  const scoresByMember = {
    m_001: { snapshot: { accountId: 'a1', modules: eightModules({ 思想政治与道德修养: 10 }) }, refreshedAt: NOW - 1000 },
    m_002: null,
  };
  const result = Stats.buildAll({ members, events, scoresByMember, now: NOW });

  assert.strictEqual(result.members.length, 2);
  assert.strictEqual(result.members[0].signIn.success, 1);
  assert.strictEqual(result.members[1].signIn.success, 1);
  assert.strictEqual(result.totals.signInSuccess, 2);
  assert.strictEqual(result.totals.signOutSuccess, 1);
  assert.strictEqual(result.totals.signInFailed, 1);
  assert.strictEqual(result.totals.signOutWaiting, 1);
  assert.strictEqual(result.totals.ekExpiredMembers, 1);
  assert.strictEqual(typeof result.totals.totalGap, 'number');
  assert.strictEqual(result.totals.lastAt, NOW - 60 * 60 * 1000);
});

test('buildAll：空成员列表返回零值 totals 且不崩', () => {
  const result = Stats.buildAll({ members: [], events: [], scoresByMember: {}, now: NOW });
  assert.deepStrictEqual(result.members, []);
  assert.strictEqual(result.totals.members, 0);
  assert.strictEqual(result.totals.signInSuccess, 0);
  assert.strictEqual(result.totals.lastAt, null);
});

test('events 入参兼容 OneCTMembers.loadResults() 返回的裸数组', () => {
  // members.js 的 loadResults() 直接返回事件数组（不是 {version, events}）
  const loadResultsReturn = [
    ekEvent({ memberId: 'm_001', action: 'signIn', status: 'success' }),
    ekEvent({ memberId: 'm_001', action: 'signOut', status: 'success' }),
    ekEvent({ memberId: 'm_002', action: 'signIn', status: 'success' }),
  ];
  const stat = Stats.build({ member: member(), events: loadResultsReturn, scoreEntry: null, now: NOW });
  assert.strictEqual(stat.signIn.success, 1, '只统计本成员');
  assert.strictEqual(stat.signOut.success, 1);
});

test('events 入参也兼容 {version, events} 包装形状', () => {
  const wrapped = {
    version: 1,
    events: [
      ekEvent({ memberId: 'm_001', action: 'signIn', status: 'success' }),
      ekEvent({ memberId: 'm_002', action: 'signIn', status: 'success' }),
    ],
  };
  const stat = Stats.build({ member: member(), events: wrapped, scoreEntry: null, now: NOW });
  assert.strictEqual(stat.signIn.success, 1);
});

test('防御：传 Auto3CTResults store 实例时显式抛错（不静默丢 memberId）', () => {
  // result-store 的字段白名单不含 memberId/memberName，经它读会丢失成员归属，
  // 表现为「按成员分组全空但界面不报错」。必须显式失败。
  const fakeStore = {
    snapshot() {
      return {
        version: 1,
        events: [
          {
            key: 'a',
            module: 'ek',
            action: 'signIn',
            status: 'success',
            at: NOW - 1000,
            day: '2026-10-17',
            // 注意：被 sanitize 后没有 memberId/memberName
          },
        ],
      };
    },
    list() {
      return this.snapshot().events;
    },
  };
  assert.throws(
    () => Stats.build({ member: member(), events: fakeStore, scoreEntry: null, now: NOW }),
    /不要传 Auto3CTResults store 实例/
  );
  assert.throws(
    () => Stats.buildAll({ members: [member()], events: fakeStore, scoresByMember: {}, now: NOW }),
    /不要传 Auto3CTResults store 实例/
  );
});

test('防御：loadResults() 返回的事件即使缺 memberName 也能按 memberId 归属', () => {
  // members.loadResults() 保证带 memberId；memberName 可能因为成员被删除而为空，
  // 此时应回落到 member.name，不影响分组
  const stat = Stats.build({
    member: member({ id: 'm_001', name: '张三' }),
    events: [
      ekEvent({ memberId: 'm_001', memberName: '', action: 'signIn', status: 'success' }),
      ekEvent({ memberId: 'm_002', memberName: '李四', action: 'signIn', status: 'success' }),
    ],
    scoreEntry: null,
    now: NOW,
  });
  assert.strictEqual(stat.signIn.success, 1);
  assert.strictEqual(stat.memberName, '张三');
});

test('build：容错空入参/坏事件（不抛错）', () => {
  const stat = Stats.build({ member: null, events: [null, undefined, 42, 'x', {}], scoreEntry: null, now: NOW });
  assert.strictEqual(stat.signIn.success, 0);
  assert.strictEqual(stat.activities.length, 0);
  assert.strictEqual(stat.modules.length, 8, '仍按 score-policy 输出八模块');
  assert.strictEqual(typeof Stats.build(), 'object');
});

// ═══════════════════════ 6.5) 归属可观测（口径同 OneCTMembers.resultsHealth） ═══════════════════════

test('build：meta 输出 eventsTotal / unscopedEventCount（无归属事件不进任何成员统计）', () => {
  const events = [
    ekEvent({ memberId: 'm_001', action: 'signIn', status: 'success' }),
    ekEvent({ memberId: '', action: 'signIn', status: 'success' }), // 无归属
    ekEvent({ memberId: undefined, action: 'signOut', status: 'success' }), // 无归属
    ekEvent({ memberId: 'm_002', action: 'signIn', status: 'success' }), // 别人的
    ekEvent({ memberId: '', module: 'club', action: 'signIn', status: 'success' }), // 无归属且非 ek
  ];
  const stat = Stats.build({ member: member(), events, scoreEntry: null, now: NOW });
  assert.strictEqual(stat.signIn.success, 1, '无归属事件不能混入本成员');
  assert.strictEqual(stat.meta.eventsTotal, 5, 'eventsTotal 统计窗口内全部模块事件');
  assert.strictEqual(stat.meta.unscopedEventCount, 3, '三条无 memberId');
});

test('build：90 天窗口外的无归属事件不计入 unscopedEventCount', () => {
  const events = [
    ekEvent({ memberId: '', action: 'signIn', status: 'success', at: NOW - 1 * 3600e3 }),
    ekEvent({ memberId: '', action: 'signIn', status: 'success', at: Date.parse('2026-01-01T09:00:00+08:00') }),
  ];
  const stat = Stats.build({ member: member(), events, scoreEntry: null, now: NOW });
  assert.strictEqual(stat.meta.unscopedEventCount, 1, '窗口外的无归属事件不算');
});

test('buildAll：totals 输出 unscopedEventCount 与 orphanedEventCount', () => {
  const members = [member({ id: 'm_001', name: '张三' }), member({ id: 'm_002', name: '李四' })];
  const events = [
    ekEvent({ memberId: 'm_001', action: 'signIn', status: 'success' }),
    ekEvent({ memberId: 'm_002', action: 'signIn', status: 'success' }),
    ekEvent({ memberId: '', action: 'signIn', status: 'success' }), // 无归属
    ekEvent({ memberId: 'm_deleted', action: 'signIn', status: 'success' }), // 已删除成员
    ekEvent({ memberId: 'm_deleted', action: 'signOut', status: 'success' }),
    ekEvent({ memberId: 'm_deleted', module: 'club', action: 'signIn', status: 'success' }),
  ];
  const result = Stats.buildAll({ members, events, scoresByMember: {}, now: NOW });
  assert.strictEqual(result.totals.eventsTotal, 6);
  assert.strictEqual(result.totals.unscopedEventCount, 1);
  assert.strictEqual(result.totals.orphanedEventCount, 3, '指向已删除成员的三条');
  assert.strictEqual(result.totals.signInSuccess, 2, '孤儿/无归属都不计入成员成功数');
});

test('buildAll：成员与事件完全对齐时两个异常计数均为 0', () => {
  const members = [member({ id: 'm_001' }), member({ id: 'm_002' })];
  const events = [
    ekEvent({ memberId: 'm_001', action: 'signIn', status: 'success' }),
    ekEvent({ memberId: 'm_002', action: 'signOut', status: 'success' }),
  ];
  const result = Stats.buildAll({ members, events, scoresByMember: {}, now: NOW });
  assert.strictEqual(result.totals.unscopedEventCount, 0);
  assert.strictEqual(result.totals.orphanedEventCount, 0);
  assert.strictEqual(result.totals.eventsTotal, 2);
});

test('renderInto：有归属异常时显示提示条，正常时不显示', () => {
  const dirty = Stats.build({
    member: member(),
    events: [
      ekEvent({ memberId: 'm_001', action: 'signIn', status: 'success' }),
      ekEvent({ memberId: '', action: 'signIn', status: 'success' }),
      ekEvent({ memberId: '', action: 'signOut', status: 'success' }),
    ],
    scoreEntry: null,
    now: NOW,
  });
  const dirtyContainer = renderStub(dirty);
  const notice = childrenByAttr(dirtyContainer, 'data-one-ct', 'attribution-notice');
  assert.strictEqual(notice.length, 1, '应显示归属异常提示');
  assert.ok(notice[0].textContent.includes('2 条历史事件无成员归属'));

  const clean = Stats.build({
    member: member(),
    events: [ekEvent({ memberId: 'm_001', action: 'signIn', status: 'success' })],
    scoreEntry: null,
    now: NOW,
  });
  const cleanContainer = renderStub(clean);
  assert.strictEqual(
    childrenByAttr(cleanContainer, 'data-one-ct', 'attribution-notice').length,
    0,
    '无异常时不应出现提示条'
  );
});

// ═══════════════════════ 7) renderInto（最小 DOM stub） ═══════════════════════

function sampleStat(overrides) {
  const events = [
    ekEvent({
      memberId: 'm_001',
      activityId: 'act-1',
      activityName: '思政讲座',
      category: '思想政治与道德修养',
      action: 'signIn',
      status: 'success',
      at: NOW - 2 * 3600e3,
    }),
    ekEvent({
      memberId: 'm_001',
      activityId: 'act-1',
      activityName: '思政讲座',
      category: '思想政治与道德修养',
      action: 'signOut',
      status: 'success',
      at: NOW - 1 * 3600e3,
    }),
    ekEvent({
      memberId: 'm_001',
      activityId: 'act-2',
      activityName: '艺术展',
      category: '艺术体验与审美修养',
      action: 'signIn',
      status: 'failed',
      at: NOW - 30 * 60e3,
    }),
  ];
  return Stats.build({
    member: member({
      ekStatus: 'ok',
      ekModules: eightModules({
        思想政治与道德修养: 6,
        学术科技与创新创业: null,
        艺术体验与审美修养: 20,
        传统文化与人文素养: 2,
        人际交往与沟通能力: 4,
        心理素质与身体素质: 8,
        社会实践与志愿服务: 12,
        社会工作与能力拓展: 8,
      }),
    }),
    events,
    scoreEntry: null,
    now: NOW,
    ...(overrides || {}),
  });
}

test('renderInto：根节点/统计卡/八模块/活动表节点数与文本正确', () => {
  const stat = sampleStat();
  const container = renderStub(stat);

  const roots = childrenByAttr(container, 'data-one-ct', 'stats');
  assert.strictEqual(roots.length, 1, '渲染出唯一 stats 根节点');
  const root = roots[0];
  assert.ok(String(root.className).startsWith('one-ct-stats-root'));

  // 两张统计卡
  const cards = childrenByAttr(root, 'data-one-ct', 'cards')[0];
  assert.strictEqual(cards.childNodes.length, 2, '签到/签退两张卡');
  const signInCard = childrenByAttr(root, 'data-one-ct', 'card-signIn')[0];
  const signOutCard = childrenByAttr(root, 'data-one-ct', 'card-signOut')[0];
  assert.strictEqual(childrenByAttr(signInCard, 'data-one-ct', 'stat-signIn-success')[0].textContent, '1');
  assert.strictEqual(childrenByAttr(signOutCard, 'data-one-ct', 'stat-signOut-success')[0].textContent, '1');
  assert.ok(signInCard.textContent.includes('签到成功'));
  assert.ok(signOutCard.textContent.includes('签退成功'));

  // 八模块进度条
  const moduleSection = childrenByAttr(root, 'data-one-ct', 'modules')[0];
  const moduleRows = childrenByAttr(moduleSection, 'data-one-ct', 'module');
  assert.strictEqual(moduleRows.length, 8, '八个模块各一行');
  const bars = childrenByClass(moduleSection, 'one-ct-stats-bar');
  assert.strictEqual(bars.length, 8, '八个进度条');
  const fills = childrenByClass(moduleSection, 'one-ct-stats-bar-fill');
  assert.strictEqual(fills.length, 8, '八个进度条填充');
  assert.match(fills[0].getAttribute('style'), /^width:\d+(\.\d+)?%$/, '进度条宽度为百分比');
  assert.strictEqual(moduleSection.textContent.includes('未填'), true, 'null current 显示未填');

  // 活动表
  const activitySection = childrenByAttr(root, 'data-one-ct', 'activities')[0];
  const rows = childrenByAttr(activitySection, 'data-one-ct', 'activity-row');
  assert.strictEqual(rows.length, 2, '两个活动');
  assert.ok(activitySection.textContent.includes('思政讲座'));
  assert.ok(activitySection.textContent.includes('艺术展'));
  const badges = childrenByClass(activitySection, 'one-ct-stats-badge');
  assert.ok(badges.length >= 4, '每个签到/签退状态一个徽标');
  assert.ok(activitySection.textContent.includes('成功'));
  assert.ok(activitySection.textContent.includes('失败'));
  // 缺口数值在模块区（十二分模块当前 6 -> 差 6 分）
  const moduleText = moduleSection.textContent;
  assert.ok(moduleText.includes('差 6 分'), '模块缺口应显示数值：' + moduleText);
  assert.ok(moduleText.includes('已达标'), '超额完成的模块显示已达标');
  // 6 + 6 + 4 + 4 = 20（学术科技 current 缺失不计入）；未填 1 项单独提示
  assert.ok(moduleText.includes('缺口合计 20 分'), '缺口合计应为 20：' + moduleText);
  assert.ok(moduleText.includes('1 项未填'), '缺失模块单独提示：' + moduleText);
});

test('renderInto：ekStatus 徽标区分 ok / expired / none', () => {
  const expiredStat = Stats.build({
    member: member({ ekStatus: 'expired' }),
    events: [],
    scoreEntry: null,
    now: NOW,
  });
  const expiredContainer = renderStub(expiredStat);
  const expiredBadge = childrenByAttr(expiredContainer, 'data-one-ct', 'ek-status')[0];
  assert.strictEqual(expiredBadge.getAttribute('data-ek-status'), 'expired');
  assert.ok(expiredBadge.textContent.includes('需重新登录'));

  const okContainer = renderStub(Stats.build({ member: member({ ekStatus: 'ok' }), events: [], scoreEntry: null, now: NOW }));
  assert.strictEqual(childrenByAttr(okContainer, 'data-one-ct', 'ek-status')[0].getAttribute('data-ek-status'), 'ok');

  const noneContainer = renderStub(Stats.build({ member: member({ ekStatus: undefined }), events: [], scoreEntry: null, now: NOW }));
  assert.strictEqual(childrenByAttr(noneContainer, 'data-one-ct', 'ek-status')[0].getAttribute('data-ek-status'), 'none');
});

test('renderInto：空数据渲染空状态（不崩、有提示文案）', () => {
  const emptyStat = Stats.build({ member: member({ ekStatus: 'none' }), events: [], scoreEntry: null, now: NOW });
  const container = renderStub(emptyStat);
  const text = container.textContent;
  assert.ok(text.includes('最近 90 天暂无记录'));
  assert.ok(text.includes('最近 90 天没有二课签到/签退记录'));
  // 八模块来自 score-policy（固定 8 项），无 current 时逐项显示「未填」而非 0
  assert.strictEqual(childrenByAttr(container, 'data-one-ct', 'module').length, 8);
  assert.ok(text.includes('未填'));
  assert.ok(text.includes('缺口未知'));
});

test('renderInto：opts 控制活动条数与区块隐藏', () => {
  const stat = sampleStat();
  const container = renderStub(stat, { maxActivities: 1 });
  const activitySection = childrenByAttr(container, 'data-one-ct', 'activities')[0];
  assert.strictEqual(childrenByAttr(activitySection, 'data-one-ct', 'activity-row').length, 1);

  const bare = renderStub(stat, { showModules: false, showActivities: false, showFoot: false });
  assert.strictEqual(childrenByAttr(bare, 'data-one-ct', 'modules').length, 0);
  assert.strictEqual(childrenByAttr(bare, 'data-one-ct', 'activities').length, 0);
  assert.strictEqual(childrenByAttr(bare, 'data-one-ct', 'foot').length, 0);

  const titled = renderStub(stat, { title: '自定义标题' });
  assert.ok(titled.textContent.includes('自定义标题'));
});

test('renderInto：重复渲染前清空旧内容', () => {
  const stat = sampleStat();
  const doc = createDocumentStub();
  const container = new StubNode(doc, 'div');
  Stats.renderInto(container, stat);
  const firstCount = container.childNodes.length;
  Stats.renderInto(container, stat);
  assert.strictEqual(container.childNodes.length, firstCount, '不会累积重复节点');
  assert.strictEqual(childrenByAttr(container, 'data-one-ct', 'stats').length, 1);
});

test('renderInto：非法容器抛 TypeError，无 document 环境抛错', () => {
  assert.throws(() => Stats.renderInto(null, {}), /el 必须是可 appendChild 的容器元素/);
  assert.throws(() => Stats.renderInto({}, {}), /el 必须是可 appendChild 的容器元素/);

  const doc = createDocumentStub();
  const container = new StubNode(doc, 'div');
  const originalDocument = global.document;
  try {
    // 容器无 ownerDocument 时退化为全局 document；此处未定义应抛错
    const orphan = { appendChild() {} };
    delete global.document;
    assert.throws(() => Stats.renderInto(orphan, {}), /缺少 DOM 环境/);
  } finally {
    if (originalDocument !== undefined) global.document = originalDocument;
  }
});

test('renderInto：手机号在渲染文本中掩码', () => {
  const stat = Stats.build({
    member: member({ name: '张三' }),
    events: [
      ekEvent({
        memberId: 'm_001',
        activityName: '联系 13800001234 的活动',
        action: 'signIn',
        status: 'success',
      }),
    ],
    scoreEntry: null,
    now: NOW,
  });
  const text = renderStub(stat).textContent;
  assert.ok(text.includes('138****1234'), '手机号应掩码');
  assert.ok(!text.includes('13800001234'), '不得出现完整手机号');
});

// ═══════════════════════ 8) CSV 导出 ═══════════════════════

test('toCSV：默认带 UTF-8 BOM，两段表结构正确', () => {
  const pairs = [sampleStat()];
  const csv = Stats.toCSV(pairs);
  assert.ok(csv.startsWith('\uFEFF'), '默认带 BOM');
  assert.strictEqual(Stats.toCSV(pairs, { bom: false }).startsWith('\uFEFF'), false);

  const rows = parseCsv(csv);
  assert.deepStrictEqual(rows[0], ['成员', '模块', '要求', '当前', '缺口']);
  // 8 个模块行
  for (let i = 1; i <= 8; i += 1) {
    assert.strictEqual(rows[i].length, 5);
    assert.strictEqual(rows[i][0], '张三');
  }
  // 空行分隔 + 活动明细表头
  const activityHeaderIndex = rows.findIndex((row) => row[0] === '成员' && row[1] === '活动ID');
  assert.ok(activityHeaderIndex > 8, '第二段表存在');
  assert.deepStrictEqual(rows[activityHeaderIndex], ['成员', '活动ID', '活动', '类别', '签到', '签退', '最近时间']);
  // 活动按最近时间倒序：艺术展(NOW-30min) 在 思政讲座(NOW-1h) 之前
  assert.strictEqual(rows[activityHeaderIndex + 1][2], '艺术展');
  assert.strictEqual(rows[activityHeaderIndex + 1][4], '失败');
  assert.strictEqual(rows[activityHeaderIndex + 2][2], '思政讲座');
  assert.strictEqual(rows[activityHeaderIndex + 2][4], '成功');
  assert.strictEqual(rows[activityHeaderIndex + 2][5], '成功');
});

test('toCSV：current 缺失导出空单元格（绝不写 0）', () => {
  const stat = sampleStat();
  const rows = parseCsv(Stats.toCSV(stat));
  const unknownRow = rows.find((row) => row[1] === '学术科技与创新创业');
  assert.ok(unknownRow, '应有该模块行');
  assert.strictEqual(unknownRow[3], '', 'current 缺失 -> 空');
  assert.strictEqual(unknownRow[4], '', 'gap 缺失 -> 空');
  const knownRow = rows.find((row) => row[1] === '思想政治与道德修养');
  assert.strictEqual(knownRow[2], '12');
  assert.strictEqual(knownRow[3], '6');
  assert.strictEqual(knownRow[4], '6');
});

test('toCSV：逗号/引号/换行转义可往返', () => {
  const trickyName = '活动"含"引号,逗号\n换行';
  const stat = Stats.build({
    member: member({ name: '张,三' }),
    events: [
      ekEvent({
        memberId: 'm_001',
        activityId: 'act-"1",2',
        activityName: trickyName,
        category: '艺术体验与审美修养',
        action: 'signIn',
        status: 'success',
      }),
    ],
    scoreEntry: null,
    now: NOW,
  });
  const csv = Stats.toCSV(stat, { bom: false });
  assert.ok(csv.includes('"活动""含""引号,逗号'), '引号加倍且整体加引号');
  const rows = parseCsv(csv);
  const activityRow = rows.find((row) => row[4] === '成功' && row.length === 7 && row[1] !== '活动ID');
  assert.ok(activityRow, '活动行应完整解析回来');
  assert.strictEqual(activityRow[2], trickyName, '换行内容必须能往返');
  assert.strictEqual(activityRow[0], '张,三', '成员名逗号必须能往返');
  assert.strictEqual(activityRow[1], 'act-"1",2', '引号内容必须能往返');
});

test('toCSV：公式注入前缀转义', () => {
  const stat = Stats.build({
    member: member({ name: '=SUM(A1:A9)' }),
    events: [],
    scoreEntry: null,
    now: NOW,
  });
  const rows = parseCsv(Stats.toCSV(stat, { bom: false }));
  assert.strictEqual(rows[1][0], "'=SUM(A1:A9)", '以 = 开头的单元格加引号前缀');
});

test('toCSV：手机号掩码，不导出完整号码', () => {
  const stat = Stats.build({
    member: member({ name: '张三 13800001234' }),
    events: [],
    scoreEntry: null,
    now: NOW,
  });
  const csv = Stats.toCSV(stat);
  assert.ok(csv.includes('138****1234'));
  assert.ok(!csv.includes('13800001234'));
});

test('toCSV：成员名为空用占位，非统计入参返回仅表头', () => {
  const stat = Stats.build({ member: { id: 'm_x' }, events: [], scoreEntry: null, now: NOW });
  const rows = parseCsv(Stats.toCSV(stat, { bom: false }));
  assert.strictEqual(rows[1][0], '（未命名成员）');

  const emptyRows = parseCsv(Stats.toCSV(null, { bom: false }));
  assert.deepStrictEqual(emptyRows[0], ['成员', '模块', '要求', '当前', '缺口']);
  assert.strictEqual(emptyRows.filter((row) => row[1] === '活动ID').length, 1);
});

// ═══════════════════════ 9) 凭证红线 ═══════════════════════

test('凭证红线：ekCredentials / token / password 不出现在渲染与 CSV', () => {
  const SECRET = 'PWD_SECRET_XYZ_123';
  const STUDENT = 'STUDENT_ID_SECRET_456';
  const TOKEN = 'ACCESS_TOKEN_SECRET_789';
  const secretMember = member({
    name: '张三',
    ek: { JSESSIONID: 'JSESSION_SECRET_000', access_token: TOKEN, user_info: { loginName: 'stu-1' } },
    ekCredentials: { studentId: STUDENT, password: SECRET },
  });
  const stat = Stats.build({
    member: secretMember,
    events: [ekEvent({ memberId: 'm_001', action: 'signIn', status: 'success', reason: 'ok' })],
    scoreEntry: {
      snapshot: { accountId: 'stu-1', modules: eightModules({ 思想政治与道德修养: 6 }) },
      refreshedAt: NOW - 1000,
      lastRefreshError: null,
    },
    now: NOW,
  });
  const rendered = renderStub(stat).textContent;
  const csv = Stats.toCSV(stat);
  const json = JSON.stringify(stat);

  [SECRET, STUDENT, TOKEN, 'JSESSION_SECRET_000'].forEach((needle) => {
    assert.ok(!rendered.includes(needle), '渲染不得包含凭证：' + needle);
    assert.ok(!csv.includes(needle), 'CSV 不得包含凭证：' + needle);
    assert.ok(!json.includes(needle), 'build 结果不得包含凭证：' + needle);
  });
});

test('凭证红线：stat 字段集合不含任何凭证键', () => {
  const stat = Stats.build({
    member: member({ ekCredentials: { studentId: 'x', password: 'y' }, ek: { JSESSIONID: 'z', access_token: 'a' } }),
    events: [],
    scoreEntry: null,
    now: NOW,
  });
  const allowed = new Set([
    'memberId',
    'memberName',
    'ekStatus',
    'ekUpdatedAt',
    // v3：积分来源标注（official=学校二课官方同步 / manual=成员页手填），纯元信息、不含凭证
    'ekModulesSource',
    'ekModulesUpdatedAt',
    'signIn',
    'signOut',
    'activities',
    'modules',
    'totalGap',
    'trusted',
    'stale',
    'refreshedAt',
    'meta',
  ]);
  Object.keys(stat).forEach((key) => assert.ok(allowed.has(key), '出现契约外字段：' + key));
  const serialized = JSON.stringify(stat).toLowerCase();
  ['password', 'token', 'jsessionid', 'credential'].forEach((needle) => {
    assert.ok(!serialized.includes(needle), 'stat 序列化后不得含 ' + needle);
  });
});

// ═══════════════════════ 10) 样式文件契约 ═══════════════════════

test('ek-stats.css：类名前缀统一、无全局选择器、极简白配色', () => {
  const cssPath = path.join(__dirname, '1ct', 'ek-stats.css');
  const raw = fs.readFileSync(cssPath, 'utf8');
  const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');

  // 所有选择器都必须以 .one-ct-stats 开头（不污染其他页面）
  const selectors = [];
  css.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed.endsWith('{')) return;
    const selector = trimmed.slice(0, -1).trim();
    if (!selector || selector.startsWith('@')) return;
    selector.split(',').forEach((part) => selectors.push(part.trim()));
  });
  assert.ok(selectors.length > 20, '应有足量样式规则');
  selectors.forEach((selector) => {
    assert.ok(
      selector.startsWith('.one-ct-stats-'),
      '选择器必须以 .one-ct-stats- 开头（作用域隔离）：' + selector
    );
  });

  // 极简白配色与排版
  assert.ok(raw.includes('#ffffff'), '白底');
  assert.ok(raw.includes('#fafafa'), '浅底');
  assert.ok(raw.includes('#e8e8ea'), '1px 边框色');
  assert.ok(raw.includes('#111113'), '主文字色');
  assert.ok(raw.includes('#16a34a'), '成功绿');
  assert.ok(raw.includes('tabular-nums'), '数字等宽');
  assert.ok(raw.includes('border-radius'), '圆角');

  // 禁止项：渐变 / 深色底 / 重阴影
  assert.ok(!/gradient/i.test(raw), '不得使用渐变');
  assert.ok(!/box-shadow:\s*(?!none)/i.test(raw) || !/box-shadow/i.test(raw), '不使用阴影');
  assert.ok(!/#000(?!0)/i.test(raw), '不使用近黑色块');
});

test('ek-stats.css：定义的类名与渲染输出一致（无孤儿契约类）', () => {
  const css = fs.readFileSync(path.join(__dirname, '1ct', 'ek-stats.css'), 'utf8');
  const stat = sampleStat();
  const container = renderStub(stat);
  const usedClasses = new Set();
  (function walk(node) {
    String(node.className || '')
      .split(/\s+/)
      .filter(Boolean)
      .forEach((name) => usedClasses.add(name));
    (node.childNodes || []).forEach(walk);
  })(container);

  const missing = [];
  usedClasses.forEach((name) => {
    if (!name.startsWith('one-ct-stats')) return;
    if (!css.includes('.' + name)) missing.push(name);
  });
  assert.deepStrictEqual(missing, [], '渲染使用的类名必须在 CSS 中定义');
});
