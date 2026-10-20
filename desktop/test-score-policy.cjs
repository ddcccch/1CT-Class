/**
 * 二课积分缺口策略纯函数测试（Node 内置 test runner，离线、不触网）。
 *
 * 运行：<bundled node> --test desktop/test-score-policy.cjs
 *
 * 数据口径来自恢复的真实源码：
 *  - 8 模块与 required 值：reverse/sources/renderer/.../EkScoresPanel.tsx `EK_SCORE_NEED`
 *  - 官方成绩：ctAPI.ek.getStudentScores -> {Info, TypeList:[{CurriculumName, SumScore, ScoreList}]}
 *  - 活动详情：ActivityInfo.ModuleCodeText；列表 item.ModuleCode；ModuleCodeList [{Text,Value}]
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('./score-policy.js');

const MODULES = [
  { name: '思想政治与道德修养', required: 12 },
  { name: '学术科技与创新创业', required: 8 },
  { name: '艺术体验与审美修养', required: 12 },
  { name: '传统文化与人文素养', required: 8 },
  { name: '人际交往与沟通能力', required: 8 },
  { name: '心理素质与身体素质', required: 12 },
  { name: '社会实践与志愿服务', required: 12 },
  { name: '社会工作与能力拓展', required: 8 },
];

/** 用户截图初值（假数据，无 PII） */
const SCREENSHOT = [
  { name: '思想政治与道德修养', current: 6 },
  { name: '学术科技与创新创业', current: 4 },
  { name: '艺术体验与审美修养', current: 2 },
  { name: '传统文化与人文素养', current: 8.5 },
  { name: '人际交往与沟通能力', current: 4 },
  { name: '心理素质与身体素质', current: 15.5 },
  { name: '社会实践与志愿服务', current: 11 },
  { name: '社会工作与能力拓展', current: 3.5 },
];

function snapshot(over = {}) {
  return {
    accountId: 'test-student',
    source: 'manual',
    updatedAt: 1700000000000,
    modules: SCREENSHOT.map((m) => ({ ...m, required: MODULES.find((x) => x.name === m.name).required })),
    ...over,
  };
}

// ───────────────────────── 模块常量 ─────────────────────────

test('MODULES 与真实源码的 8 个模块及 required 完全一致', () => {
  assert.equal(P.MODULES.length, 8);
  MODULES.forEach((expected) => {
    const found = P.MODULES.find((m) => m.name === expected.name);
    assert.ok(found, '缺少模块：' + expected.name);
    assert.equal(found.required, expected.required, expected.name + ' required');
  });
});

test('截图初值模板不含 PII，8 模块缺口合计 29.5', () => {
  const initial = P.getScreenshotInitialModules();
  assert.equal(initial.length, 8);
  const json = JSON.stringify(initial);
  ['stuname', '学号', 'studentId', '姓名'].forEach((bad) => {
    assert.equal(json.toLowerCase().includes(bad.toLowerCase()), false, '模板不得含 PII：' + bad);
  });
  // 8 模块按截图初值（current 已知）计算总缺口
  const total = initial.reduce((sum, m) => sum + Math.max(0, Number(m.required) - Number(m.current)), 0);
  assert.equal(Number(total.toFixed(2)), 29.5);
});

// ───────────────────────── snapshot 校验 ─────────────────────────

test('buildSnapshot 要求 accountId 与合法模块数值', () => {
  const ok = P.buildSnapshot({ accountId: 'acc-1', source: 'manual', modules: snapshot().modules });
  assert.equal(ok.accountId, 'acc-1');
  assert.equal(ok.modules.length, 8);

  assert.throws(() => P.buildSnapshot({ accountId: '', source: 'manual', modules: snapshot().modules }));
  assert.throws(() =>
    P.buildSnapshot({
      accountId: 'acc-1',
      source: 'manual',
      modules: [{ name: '思想政治与道德修养', required: 12, current: -1 }],
    }),
  );
  assert.throws(() =>
    P.buildSnapshot({
      accountId: 'acc-1',
      source: 'manual',
      modules: [{ name: '思想政治与道德修养', required: 0, current: 1 }],
    }),
  );
});

test('validateSnapshot 区分 ok / missing-account / empty-modules / 未知模块', () => {
  assert.equal(P.validateSnapshot(snapshot()).ok, true);
  assert.equal(P.validateSnapshot(null).ok, false);
  assert.equal(P.validateSnapshot({ modules: snapshot().modules }).reason, 'missing-account');
  assert.equal(P.validateSnapshot({ accountId: 'a', modules: [] }).reason, 'empty-modules');
  // 未知模块名不被当作可信（避免映射错位）
  const unknown = P.validateSnapshot(snapshot({ modules: [{ name: '不存在的模块', required: 5, current: 1 }] }));
  assert.equal(unknown.ok, false);
  assert.equal(unknown.reason, 'unknown-module');
});

// ───────────────────────── 缺口计算 ─────────────────────────

test('computeGaps 按模块计算缺口，达标模块标记 satisfied', () => {
  const snap = snapshot();
  const out = P.computeGaps(snap);
  const map = Object.fromEntries(out.modules.map((m) => [m.name, m]));
  assert.equal(map['思想政治与道德修养'].gap, 6);
  assert.equal(map['传统文化与人文素养'].gap, 0);
  assert.equal(map['传统文化与人文素养'].satisfied, true);
  assert.equal(map['心理素质与身体素质'].gap, 0);
  assert.equal(map['心理素质与身体素质'].satisfied, true);
  assert.equal(Number(out.totalGap.toFixed(2)), 29.5);
  assert.deepEqual(out.satisfiedModules.sort(), ['传统文化与人文素养', '心理素质与身体素质'].sort());
});

test('current 缺失的模块不可信，绝不当 0 参与排序/放行', () => {
  const snap = snapshot({
    modules: [{ name: '思想政治与道德修养', required: 12 }],
  });
  const out = P.computeGaps(snap);
  const m = out.modules.find((x) => x.name === '思想政治与道德修养');
  assert.equal(m.trusted, false, '缺 current 必须标记不可信');
  assert.equal(m.current, null);
  assert.equal(m.gap, null);
  assert.equal(out.trusted, false);
});

// ───────────────────────── 官方成绩解析 ─────────────────────────

test('parseOfficialScores 从 TypeList.CurriculumName/SumScore 解析，保留未知项', () => {
  const resp = {
    Info: { StudentId: 'x', SumGetNum: 40 },
    TypeList: [
      { CurriculumName: '思想政治与道德修养', SumScore: '6', ScoreList: [] },
      { CurriculumName: '学术科技与创新创业', SumScore: 4.5, ScoreList: [] },
      { CurriculumName: '新增未知模块', SumScore: 3, ScoreList: [] },
    ],
  };
  const parsed = P.parseOfficialScores(resp);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.modules.length, 2);
  assert.equal(parsed.modules.find((m) => m.name === '思想政治与道德修养').current, 6);
  assert.equal(parsed.modules.find((m) => m.name === '学术科技与创新创业').current, 4.5);
  assert.equal(parsed.unknown.length, 1);
  assert.equal(parsed.unknown[0].name, '新增未知模块');
});

test('parseOfficialScores 空/结构异常 -> ok:false（不把缺失当 0）', () => {
  [{}, null, { TypeList: [] }, { TypeList: 'x' }, { TypeList: [{ CurriculumName: '', SumScore: 5 }] }].forEach((bad) => {
    const parsed = P.parseOfficialScores(bad);
    assert.equal(parsed.ok, false, 'should reject: ' + JSON.stringify(bad));
  });
});

test('官方部分字段缺失 -> 该模块不可信而不是 0', () => {
  const parsed = P.parseOfficialScores({
    TypeList: [
      { CurriculumName: '思想政治与道德修养', SumScore: '6' },
      { CurriculumName: '学术科技与创新创业' }, // 缺 SumScore
    ],
  });
  assert.equal(parsed.ok, true);
  const bad = parsed.modules.find((m) => m.name === '学术科技与创新创业');
  assert.equal(bad.trusted, false);
  assert.equal(bad.current, null);
});

test('parseOfficialScores 记录 Info.StudentId 作为账号校验线索', () => {
  const parsed = P.parseOfficialScores({
    Info: { StudentId: 'test-student', SumGetNum: 10 },
    TypeList: [{ CurriculumName: '思想政治与道德修养', SumScore: '6' }],
  });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.accountHint, 'test-student');
});

test('mergeOfficialSnapshot：Info.StudentId 与当前账号显式不一致 -> 拒绝覆盖', () => {
  const parsed = P.parseOfficialScores({
    Info: { StudentId: 'someone-else' },
    TypeList: [{ CurriculumName: '思想政治与道德修养', SumScore: 9 }],
  });
  assert.throws(
    () => P.mergeOfficialSnapshot(snapshot(), parsed, 'test-student', 1700000005000),
    /account-mismatch/,
  );
});

test('mergeOfficialSnapshot：Info.StudentId 缺失时来自当前已认证调用 -> 允许并记 verified:false', () => {
  const parsed = P.parseOfficialScores({
    TypeList: [{ CurriculumName: '思想政治与道德修养', SumScore: 9 }],
  });
  const merged = P.mergeOfficialSnapshot(snapshot(), parsed, 'test-student', 1700000005000);
  assert.equal(merged.accountId, 'test-student');
  assert.equal(merged.accountVerified, false, '缺 StudentId 时来源可信但未交叉校验');
});

test('normalizeModuleOptions 不吃 Text（真实源码只认 label/Label + value/Value）', () => {
  // 真实 normalizeOptions：label|Label + value|Value；Text 不是被认可的字段
  const out = P.normalizeModuleOptions([{ Text: '思想政治与道德修养', Value: 'A' }]);
  assert.equal(out.length, 0, 'Text/Value 不属于真实字段口径，不应被当作选项');
});

// ───────────────────────── 模块选项与活动归类 ─────────────────────────


test('normalizeModuleOptions 认 label|Label + value|Value（真实源码口径）', () => {
  const a = P.normalizeModuleOptions([
    { label: '思想政治与道德修养', value: 'A' },
    { Label: '学术科技与创新创业', Value: 'B' },
    { label: '', value: 'C' },
    { label: '缺 value' },
  ]);
  assert.equal(a.length, 2);
  assert.deepEqual(a[0], { label: '思想政治与道德修养', value: 'A' });
  assert.deepEqual(a[1], { label: '学术科技与创新创业', value: 'B' });
});
test('resolveActivityCategory 优先 exact ModuleCodeText', () => {
  const out = P.resolveActivityCategory({
    detailInfo: { ModuleCodeText: '思想政治与道德修养' },
    listItem: { ModuleCode: 'A' },
    moduleOptions: [{ label: '思想政治与道德修养', value: 'A' }],
  });
  assert.equal(out.category, '思想政治与道德修养');
  assert.equal(out.via, 'text');
});

test('resolveActivityCategory 用官方 code 映射（不凭标题猜）', () => {
  const out = P.resolveActivityCategory({
    detailInfo: {},
    listItem: { ModuleCode: 'B', ActivityName: '思想政治讲座' }, // 标题像但不猜
    moduleOptions: [{ label: '学术科技与创新创业', value: 'B' }],
  });
  assert.equal(out.category, '学术科技与创新创业');
  assert.equal(out.via, 'code');
});

test('resolveActivityCategory 无法映射 -> category-unknown，绝不猜', () => {
  const out = P.resolveActivityCategory({
    detailInfo: { ModuleCodeText: '未知类别' },
    listItem: { ModuleCode: 'Z', ActivityName: '思想政治与道德修养 讲座' },
    moduleOptions: [{ label: '思想政治与道德修养', value: 'A' }],
  });
  assert.equal(out.category, null);
  assert.equal(out.reason, 'category-unknown');
});

// ───────────────────────── 策略判定 ─────────────────────────

test('evaluatePolicy：可信且账号匹配 -> 未达标模块可报名、达标模块阻断', () => {
  const policy = P.evaluatePolicy({ snapshot: snapshot(), accountId: 'test-student', now: 1700000000000 + 1000 });
  assert.equal(policy.trusted, true);
  assert.equal(policy.accountMatch, true);
  assert.equal(P.canApplyCategory(policy, '思想政治与道德修养').allow, true);
  assert.equal(P.canApplyCategory(policy, '传统文化与人文素养').allow, false);
  assert.equal(P.canApplyCategory(policy, '传统文化与人文素养').reason, 'module-satisfied');
});

test('evaluatePolicy：无 snapshot / 账号不匹配 -> 阻断新增，watch 不受影响', () => {
  const none = P.evaluatePolicy({ snapshot: null, accountId: 'test-student', now: 1700000000000 });
  assert.equal(none.trusted, false);
  assert.equal(P.canApplyCategory(none, '思想政治与道德修养').allow, false);
  assert.equal(P.canApplyCategory(none, '思想政治与道德修养').reason, 'score-snapshot-missing');

  const mismatch = P.evaluatePolicy({ snapshot: snapshot(), accountId: 'other-student', now: 1700000000000 });
  assert.equal(mismatch.accountMatch, false);
  assert.equal(P.canApplyCategory(mismatch, '思想政治与道德修养').reason, 'score-account-mismatch');
});

test('evaluatePolicy：snapshot 过期标 stale（仍阻断新增，不用于放行）', () => {
  const staleMs = 24 * 60 * 60 * 1000;
  const policy = P.evaluatePolicy({
    snapshot: snapshot({ updatedAt: 1700000000000 }),
    accountId: 'test-student',
    now: 1700000000000 + staleMs + 1,
    staleMs,
  });
  assert.equal(policy.stale, true);
  assert.equal(P.canApplyCategory(policy, '思想政治与道德修养').allow, false);
  assert.equal(P.canApplyCategory(policy, '思想政治与道德修养').reason, 'score-stale');
});

test('evaluatePolicy：未知类别一律不允许', () => {
  const policy = P.evaluatePolicy({ snapshot: snapshot(), accountId: 'test-student', now: 1700000000000 + 1 });
  assert.equal(P.canApplyCategory(policy, null).allow, false);
  assert.equal(P.canApplyCategory(policy, '').reason, 'category-unknown');
  assert.equal(P.canApplyCategory(policy, '不存在的模块').reason, 'category-unknown');
});

// ───────────────────────── 官方 → snapshot ─────────────────────────

test('mergeOfficialSnapshot 保留 required，用官方 current 覆盖，缺字段保留旧值并标不可信', () => {
  const old = snapshot();
  const parsed = P.parseOfficialScores({
    TypeList: [
      { CurriculumName: '思想政治与道德修养', SumScore: 8 },
      { CurriculumName: '学术科技与创新创业' }, // 缺分
    ],
  });
  const merged = P.mergeOfficialSnapshot(old, parsed, 'test-student', 1700000009999);
  assert.equal(merged.accountId, 'test-student');
  assert.equal(merged.source, 'official');
  assert.equal(merged.updatedAt, 1700000009999);
  const m1 = merged.modules.find((m) => m.name === '思想政治与道德修养');
  assert.equal(m1.current, 8);
  assert.equal(m1.required, 12);
  const m2 = merged.modules.find((m) => m.name === '学术科技与创新创业');
  assert.equal(m2.trusted, false);
});

test('mergeOfficialSnapshot 在 parsed 不可信时拒绝合并', () => {
  assert.throws(() => P.mergeOfficialSnapshot(snapshot(), { ok: false, reason: 'empty' }, 'test-student', 1));
});

// ───────────────────── review 回归：严格校验 ─────────────────────

test('validateSnapshot 严格：重复模块 / required<=0 / 负 current / future / 非法 source 一律拒绝', () => {
  const base = snapshot();
  const dup = { ...base, modules: [base.modules[0], base.modules[0]] };
  assert.equal(P.validateSnapshot(dup).ok, false);
  assert.equal(P.validateSnapshot(dup).reason, 'duplicate-module');

  const badRequired = { ...base, modules: [{ name: '思想政治与道德修养', required: 0, current: 1 }] };
  assert.equal(P.validateSnapshot(badRequired).ok, false);

  const negCurrent = { ...base, modules: [{ name: '思想政治与道德修养', required: 12, current: -3 }] };
  assert.equal(P.validateSnapshot(negCurrent).ok, false);
  assert.equal(P.validateSnapshot(negCurrent).reason, 'invalid-current');

  const future = { ...base, updatedAt: Date.now() + 10 * 60 * 1000 };
  assert.equal(P.validateSnapshot(future).ok, false);
  assert.equal(P.validateSnapshot(future).reason, 'future-timestamp');

  const badSource = { ...base, source: 'guess' };
  assert.equal(P.validateSnapshot(badSource).ok, false);
  assert.equal(P.validateSnapshot(badSource).reason, 'invalid-source');

  assert.equal(P.validateSnapshot({ ...base, accountId: '' }).reason, 'missing-account');
  assert.equal(P.validateSnapshot({ ...base, updatedAt: 0 }).ok, false);
});

test('buildSnapshot 拒绝 NaN required（不悄悄回默认），current 非法则拒', () => {
  assert.throws(() =>
    P.buildSnapshot({
      accountId: 'a',
      source: 'manual',
      modules: [{ name: '思想政治与道德修养', required: NaN, current: 1 }],
    }),
  );
  assert.throws(() =>
    P.buildSnapshot({
      accountId: 'a',
      source: 'manual',
      modules: [{ name: '思想政治与道德修养', required: 12, current: 'abc' }],
    }),
  );
});

test('computeGaps 不对未 trusted / 负数计入伪缺口', () => {
  const snap = snapshot({
    modules: [
      { name: '思想政治与道德修养', required: 12, current: null, trusted: false },
      { name: '学术科技与创新创业', required: 8, current: 4, trusted: true },
    ],
  });
  const gaps = P.computeGaps(snap);
  const untrusted = gaps.modules.find((m) => m.name === '思想政治与道德修养');
  assert.equal(untrusted.gap, null, '不可信模块不得产生缺口数值');
  assert.equal(untrusted.trusted, false);
  assert.equal(gaps.totalGap, 4, 'totalGap 只累计可信缺口（8-4=4）');
  assert.equal(gaps.trusted, false);
});

test('mergeOfficialSnapshot 保留用户编辑的合法 required（refresh 不覆盖）', () => {
  const old = P.buildSnapshot({
    accountId: 'a',
    source: 'manual',
    modules: [{ name: '思想政治与道德修养', required: 15, current: 6 }],
  });
  const parsed = P.parseOfficialScores({
    TypeList: [{ CurriculumName: '思想政治与道德修养', SumScore: 8 }],
  });
  const merged = P.mergeOfficialSnapshot(old, parsed, 'a', 1700000001000);
  const m = merged.modules.find((x) => x.name === '思想政治与道德修养');
  assert.equal(m.required, 15, '用户编辑的 required 必须保留');
  assert.equal(m.current, 8);
});

test('parseOfficialScores 重复模块 -> ok:false（不 last-wins）', () => {
  const parsed = P.parseOfficialScores({
    TypeList: [
      { CurriculumName: '思想政治与道德修养', SumScore: 6 },
      { CurriculumName: '思想政治与道德修养', SumScore: 9 },
    ],
  });
  assert.equal(parsed.ok, false);
  assert.equal(parsed.reason, 'duplicate-module');
});

test('parseOfficialScores Info.StudentId 为数字时也要参与身份校验', () => {
  const parsed = P.parseOfficialScores({
    Info: { StudentId: 20230001 },
    TypeList: [{ CurriculumName: '思想政治与道德修养', SumScore: 6 }],
  });
  assert.equal(parsed.accountHint, '20230001');
  assert.throws(
    () => P.mergeOfficialSnapshot(snapshot(), parsed, 'other-account', 1700000001000),
    /account-mismatch/,
  );
});

test('evaluatePolicy accountId 为空视为不匹配，不放行', () => {
  const policy = P.evaluatePolicy({ snapshot: snapshot(), accountId: '', now: 1700000000000 + 1 });
  assert.equal(policy.accountMatch, false);
  assert.equal(P.canApplyCategory(policy, '思想政治与道德修养').allow, false);
});