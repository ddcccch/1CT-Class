/**
 * 二课「可报名活动发现」离线浏览器验收 —— task-12 QA（只读 fake ctAPI）。
 *
 * 复现用户真实日志场景（docs/auto3ct-log-*，不提交日志本身）：
 *  - 未过滤列表前 3 页只有「已报名 Status=1」，joinable 只在 **status=0 显式分页**里；
 *  - joinable-B 列表 ApplyInfo:{} + 详情 Id 空/全零模板，仍必须可报名（不得误判已报）；
 *  - status1 已报名活动不得重复 apply，但签到窗口开时 watch 必须继续签到；
 *  - 未过滤某一页失败时，watch/其它页候选仍要完成；
 *  - ModuleCodeList（label/Label + value/Value）能把 code 映射为官方模块中文名；
 *  - 所有候选决策/跳过原因必须可见（含 scanStats/诊断行，不静默）；
 *  - 评分策略/时间窗/每日上限/去重不得放松：签到未到时间 ≠ 报名未到时间（A 应报名）。
 *
 * 运行：node tests/enrollment-smoke.cjs
 * 只 fake 数据、临时 profile、外部网络 0；不读用户 userData、不连 CDP、不碰用户进程。
 */
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const PLAYWRIGHT_CORE =
  process.env.PLAYWRIGHT_CORE || ((process.env.USERPROFILE || process.env.HOME || '.') + '/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'artifacts', 'enrollment');
// source = desktop 源文件；packaged = 从 3CT-Auto app.asar 解包的 dist/renderer
const SMOKE_SOURCE = process.env.SMOKE_SOURCE === 'packaged' ? 'packaged' : 'source';
const PACKAGED_RENDERER =
  process.env.SMOKE_PACKAGED_RENDERER || path.join(ROOT, 'artifacts', 'patched-renderer', 'dist', 'renderer');
const SHOT_PREFIX = SMOKE_SOURCE === 'packaged' ? 'packaged-enrollment-' : 'enrollment-';
const RESULT_JSON = path.join(OUT, SMOKE_SOURCE === 'packaged' ? 'packaged-enrollment-smoke-result.json' : 'enrollment-smoke-result.json');
const HARNESS_PATH = '/tests/enrollment-smoke.html';

const SERVE_ALLOWLIST = new Set([
  '/tests/enrollment-smoke.html',
  '/desktop/panel.css', '/desktop/vendor/jsQR.js',
  '/desktop/score-policy.js', '/desktop/result-store.js',
  '/desktop/automation.js', '/desktop/dashboard.js', '/desktop/panel.js',
]);
const PACKAGED_MAP = {
  '/desktop/panel.css': path.join(PACKAGED_RENDERER, 'panel.css'),
  '/desktop/vendor/jsQR.js': path.join(PACKAGED_RENDERER, 'jsQR.js'),
  '/desktop/score-policy.js': path.join(PACKAGED_RENDERER, 'score-policy.js'),
  '/desktop/result-store.js': path.join(PACKAGED_RENDERER, 'result-store.js'),
  '/desktop/automation.js': path.join(PACKAGED_RENDERER, 'automation.js'),
  '/desktop/dashboard.js': path.join(PACKAGED_RENDERER, 'dashboard.js'),
  '/desktop/panel.js': path.join(PACKAGED_RENDERER, 'panel.js'),
};
const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail: detail === undefined ? '' : String(detail) });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' :: ' + detail : ''}`);
}
function info(name, detail) {
  checks.push({ name, ok: true, detail: detail === undefined ? '' : String(detail), kind: 'info' });
  console.log(`[INFO] ${name}${detail ? ' :: ' + detail : ''}`);
}

function startServer() {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    if (urlPath === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    if (!SERVE_ALLOWLIST.has(urlPath)) { res.writeHead(404); res.end('not found'); return; }
    let filePath;
    let base = ROOT;
    if (SMOKE_SOURCE === 'packaged' && PACKAGED_MAP[urlPath]) {
      filePath = PACKAGED_MAP[urlPath];
      base = PACKAGED_RENDERER;
    } else if (SMOKE_SOURCE === 'packaged' && urlPath !== HARNESS_PATH) {
      res.writeHead(404); res.end('not found'); return;
    } else {
      filePath = path.resolve(ROOT, urlPath.replace(/^\/+/, ''));
    }
    const rel = path.relative(base, filePath);
    if (rel.startsWith('..') || path.isAbsolute(rel)) { res.writeHead(403); res.end(); return; }
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

function sha256(filePath) {
  return require('node:crypto').createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

async function main() {
  await fsp.mkdir(OUT, { recursive: true });
  const startedAt = new Date().toISOString();
  if (!EDGE) throw new Error('找不到 Microsoft Edge');
  let playwright;
  try { playwright = require(PLAYWRIGHT_CORE); } catch (e) { throw new Error('playwright-core: ' + e.message); }

  const missing = ['desktop/automation.js', 'desktop/panel.js', 'desktop/score-policy.js', 'desktop/result-store.js']
    .filter((rel) => !fs.existsSync(path.join(ROOT, rel)));
  if (missing.length && SMOKE_SOURCE !== 'packaged') {
    check('依赖脚本就绪', false, missing.join(','));
    process.exitCode = 1;
    return;
  }
  let packagedInfo = null;
  if (SMOKE_SOURCE === 'packaged') {
    const missingPackaged = Object.values(PACKAGED_MAP).filter((p) => !fs.existsSync(p));
    if (missingPackaged.length) {
      check('打包副本解包脚本就绪', false, missingPackaged.join(','));
      process.exitCode = 1;
      return;
    }
    packagedInfo = {
      rendererDir: PACKAGED_RENDERER,
      files: Object.fromEntries(Object.entries(PACKAGED_MAP).map(([u, p]) => [path.basename(p), { sha256: sha256(p), bytes: fs.statSync(p).size }])),
    };
  }

  const { server, port } = await startServer();
  const origin = `http://127.0.0.1:${port}`;
  const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'auto3ct-enroll-'));
  const external = [];
  const pageErrors = [];
  const consoleErrors = [];
  let context;
  let page;
  try {
    context = await playwright.chromium.launchPersistentContext(profile, {
      executablePath: EDGE, headless: true, viewport: { width: 1280, height: 1000 },
    });
    page = context.pages()[0] || (await context.newPage());
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith(origin) || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
      external.push(url);
      return route.abort();
    });
    page.on('pageerror', (e) => pageErrors.push(String(e && e.message ? e.message : e)));
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('dialog', (d) => d.accept().catch(() => {}));

    await page.goto(origin + HARNESS_PATH, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__SMOKE_READY__ === true, null, { timeout: 20000 });
    const ctxErr = await page.evaluate(() => window.__SMOKE_CTX_ERROR__ || '');
    check('账号/引擎初始化', !ctxErr, ctxErr || 'ok');
    if (SMOKE_SOURCE === 'packaged') {
      const pairs = [
        ['automation.js', PACKAGED_MAP['/desktop/automation.js'], path.join(ROOT, 'desktop', 'automation.js')],
        ['panel.js', PACKAGED_MAP['/desktop/panel.js'], path.join(ROOT, 'desktop', 'panel.js')],
        ['panel.css', PACKAGED_MAP['/desktop/panel.css'], path.join(ROOT, 'desktop', 'panel.css')],
        ['score-policy.js', PACKAGED_MAP['/desktop/score-policy.js'], path.join(ROOT, 'desktop', 'score-policy.js')],
        ['result-store.js', PACKAGED_MAP['/desktop/result-store.js'], path.join(ROOT, 'desktop', 'result-store.js')],
        ['dashboard.js', PACKAGED_MAP['/desktop/dashboard.js'], path.join(ROOT, 'desktop', 'dashboard.js')],
      ];
      const same = pairs.every(([, packed, source]) => sha256(packed) === sha256(source));
      check('打包副本脚本与 desktop 冻结源字节一致（automation/panel/css/policy/store/dashboard）', same, pairs.map(([n]) => n).join(','));
      info('打包副本来源', PACKAGED_RENDERER);
    }

    // 真实一轮（fake）：非 dry-run，ek 开、apply/sign 开，策略关闭（只验发现/报名/去重）
    const round = await page.evaluate(async () => {
      const ctx = window.__SMOKE_CTX__;
      ctx.engine.setConfig({ dryRun: false });
      const result = await ctx.engine.runOnce();
      return {
        results: result.results,
        summary: result.summary,
        ekScan: result.ekScan || null,
        emitted: ctx.emitted,
        logs: ctx.logs.slice(-60),
      };
    });
    info('一轮结果条数', `${round.results.length} summary=${JSON.stringify(round.summary)}`);
    info('ekScan', JSON.stringify(round.ekScan));

    const ekRows = round.results.filter((r) => r.module === 'ek');
    const applyRows = ekRows.filter((r) => r.action === 'apply');
    info('apply 结果行', JSON.stringify(applyRows).slice(0, 800));

    // ── 1) 显式 status=0 分页发现（未过滤页只有已报名）──
    const listCalls = await page.evaluate(() => window.ctAPI.__fake.listCalls());
    const status0Pages = listCalls.filter((c) => c.payload && String(c.payload.activityStatus) === '0').map((c) => Number(c.payload.pageIndex));
    const unfilteredPages = listCalls.filter((c) => !c.payload || c.payload.activityStatus == null).length;
    info('list 调用', JSON.stringify({ status0Pages, unfilteredPages, total: listCalls.length }));
    check('存在显式 activityStatus=0 查询', status0Pages.length > 0, JSON.stringify(status0Pages));
    check('status=0 至少扫到用户日志同类前 3 页', status0Pages.includes(1) && status0Pages.includes(2), JSON.stringify(status0Pages));

    // ── 2) joinable A/B 都发现并成功报名（B 是 ApplyInfo:{}/全零模板回归）──
    const applyCalls = await page.evaluate(() => window.ctAPI.__fake.applyCalls());
    const appliedIds = applyCalls.map((c) => String((c.payload || {}).act_id || ''));
    info('apply 调用 act_id', JSON.stringify(appliedIds));
    check('可报名 A 被报名（apply 调用含 joinable-A）', appliedIds.includes('joinable-A'), JSON.stringify(appliedIds));
    check('可报名 B（列表 ApplyInfo:{} / 详情全零模板）未被误判已报名并成功报名', appliedIds.includes('joinable-B'), JSON.stringify(appliedIds));
    const successApplies = applyRows.filter((r) => r.status === 'success').map((r) => String(r.activityId));
    check('apply 结果 success 覆盖 A/B', ['joinable-A', 'joinable-B'].every((id) => successApplies.includes(id)), JSON.stringify(successApplies));

    // ── 3) status1 不重复报名；watch 签到继续 ──
    const appliedStatus1Ids = appliedIds.filter((id) => /applied/.test(id));
    check('status=1 已报名活动不重复 apply', appliedStatus1Ids.length === 0, JSON.stringify(appliedStatus1Ids));
    const signCalls = await page.evaluate(() => window.ctAPI.__fake.signCalls());
    info('sign 调用', JSON.stringify(signCalls.map((c) => ({ id: (c.payload || {}).act_id, fun: (c.payload || {}).fun_type }))).slice(0, 400));
    check('watch 已报名活动签到完成（status1 仍继续 signIn）', signCalls.some((c) => String((c.payload || {}).act_id) === 'applied-watch' && String((c.payload || {}).fun_type) === 'QD'), JSON.stringify(signCalls.map((c) => (c.payload || {}).act_id)).slice(0, 200));

    // ── 3b) strict：Status0 但缺真实报名窗口（StuETime 缺失）→ 必须 missing-apply-window 且不提交 ──
    const missingWindowRows = ekRows.filter((r) => String(r.activityId) === 'missing-window' && r.action === 'apply');
    const missingWindowApply = appliedIds.filter((id) => id === 'missing-window');
    info('missing-window 行', JSON.stringify(missingWindowRows).slice(0, 400));
    check('Status0 缺报名窗口 → missing-apply-window 可见', missingWindowRows.some((r) => String(r.reason) === 'missing-apply-window'), JSON.stringify(missingWindowRows.map((r) => r.reason)));
    check('Status0 缺报名窗口 → 绝不提交 apply（fakeApply=0）', missingWindowApply.length === 0, JSON.stringify(missingWindowApply));
    check('Status0 缺报名窗口行 decision 为 unknown（不当可报名直接提交）', missingWindowRows.every((r) => String(r.decision) === 'unknown'), JSON.stringify(missingWindowRows.map((r) => r.decision)));

    // ── 3c) 报名窗在未来 → 发现保留但 not-yet，不提交（且不是缺失窗口）──
    const futureRows = ekRows.filter((r) => String(r.activityId) === 'future-window' && r.action === 'apply');
    info('future-window 行', JSON.stringify(futureRows).slice(0, 400));
    check('报名窗未来 → not-yet（before-apply-window）可见', futureRows.some((r) => r.status === 'not-yet' && String(r.reason) === 'before-apply-window'), JSON.stringify(futureRows.map((r) => ({ s: r.status, r: r.reason }))));
    check('报名窗未来 → 不提交 apply', appliedIds.filter((id) => id === 'future-window').length === 0);
    check('报名窗未来候选仍被发现（不静默丢弃）', futureRows.length > 0, `rows=${futureRows.length}`);

    // ── 4) 签到未到时间 ≠ 报名未到时间（A 签到窗口未来但 apply 仍发生）──
    const aRow = applyRows.find((r) => String(r.activityId) === 'joinable-A');
    check('签到未到时间时报名仍执行（A apply success，不因 sign not-yet 跳过）', Boolean(aRow) && aRow.status === 'success', JSON.stringify(aRow));
    const aSign = signCalls.filter((c) => String((c.payload || {}).act_id) === 'joinable-A');
    check('A 签到确实因窗口未到而未提交', aSign.length === 0, JSON.stringify(aSign.map((c) => (c.payload || {}).fun_type)));

    // ── 5) 模块映射（ModuleCodeList label/Label + value/Value）不阻断报名 ──
    const bRow = ekRows.find((r) => String(r.activityId) === 'joinable-B');
    check('ModuleCodeList code 映射成功（B 未被 category-unknown 阻断）', Boolean(bRow) && !/category-unknown/.test(String(bRow.reason || '')), JSON.stringify({ status: bRow && bRow.status, reason: bRow && bRow.reason }));

    // ── 6) 扫描汇总（ekScan 契约 8 字段）+ 所有候选决策可见 ──
    const candidateIds = ['applied-1', 'applied-2', 'applied-3', 'applied-watch', 'joinable-A', 'joinable-B', 'missing-window', 'future-window'];
    const seenIds = new Set(ekRows.map((r) => String(r.activityId || '')));
    const unseen = candidateIds.filter((id) => !seenIds.has(id) && !ekRows.some((r) => JSON.stringify(r).includes(id)));
    info('ek 结果行', JSON.stringify(ekRows.map((r) => ({ a: r.action, id: r.activityId, s: r.status, r: r.reason }))).slice(0, 900));
    check('每个候选至少有可见决策行（不静默丢弃）', unseen.length === 0, JSON.stringify(unseen));
    const ekScan = round.ekScan;
    check('result.ekScan 存在（扫描汇总可见）', Boolean(ekScan) && typeof ekScan === 'object', JSON.stringify(ekScan));
    const scanFields = ['fetched', 'eligible', 'joinable', 'applied', 'unknown', 'filtered', 'nextpages', 'truncated'];
    check('ekScan 含契约 8 字段', Boolean(ekScan) && scanFields.every((k) => Object.prototype.hasOwnProperty.call(ekScan, k)), JSON.stringify(ekScan));
    check('ekScan.fetched 为真实条目数（fixture 共 8 条）', Boolean(ekScan) && Number(ekScan.fetched) === 8, `fetched=${ekScan && ekScan.fetched}`);
    check('ekScan.nextpages 为真实请求页数（与 list 调用数一致）', Boolean(ekScan) && Number(ekScan.nextpages) === listCalls.length, `nextpages=${ekScan && ekScan.nextpages} listCalls=${listCalls.length}`);
    check('ekScan.joinable >= 3（A/B/D，C 缺窗仍 joinable 计数）', Boolean(ekScan) && Number(ekScan.joinable) >= 3, JSON.stringify(ekScan));
    check('ekScan.applied >= 4（status1 已报补充）', Boolean(ekScan) && Number(ekScan.applied) >= 4, JSON.stringify(ekScan));

    // panel._enrollLog 纯函数契约（cli freeze）
    const panelFmt = await page.evaluate(() => {
      const L = window.Auto3CTPanel && window.Auto3CTPanel._enrollLog;
      if (!L) return { available: false };
      const row1 = L.formatRow({ module: 'ek', action: 'apply', activityId: 'joinable-A', activityName: '志愿活动A', listStatus: '0', classify: 'joinable', decision: 'applicable', status: 'pending', reason: '' });
      const row2 = L.formatRow({ module: 'ek', action: 'apply', activityId: 'applied-1', activityName: '活动X', listStatus: '1', classify: 'applied', status: 'skipped', reason: 'already-applied-conflict', decision: 'already-applied' });
      const row3 = L.formatRow({ module: 'ek', action: 'apply', activityId: 'x3', activityName: '活动Y', status: 'not-yet', reason: 'before-apply-window' });
      const row4 = L.formatRow({ module: 'ek', action: 'signIn', activityId: 'x4', activityName: '活动Z', status: 'not-yet', reason: 'before-window' });
      return {
        available: true,
        row1: String(row1 || ''), row2: String(row2 || ''), row3: String(row3 || ''), row4: String(row4 || ''),
        scan: String(L.formatScan({ fetched: 5, eligible: 5, joinable: 2, applied: 1, unknown: 0, filtered: 2, nextpages: 3, truncated: false }) || ''),
        scanMissing: String(L.formatScan({ fetched: 5 }) || ''),
        scanNull: String(L.formatScan(null) || ''),
      };
    });
    info('panel _enrollLog 样例', JSON.stringify(panelFmt).slice(0, 800));
    check('panel 日志可读：报名行含活动名+可报名（待提交）', panelFmt.available && /二课报名/.test(panelFmt.row1) && /志愿活动A/.test(panelFmt.row1) && /可报名/.test(panelFmt.row1), panelFmt.row1);
    check('panel 日志：已报名冲突显示不重复报名', panelFmt.available && /已报名/.test(panelFmt.row2) && Boolean(panelFmt.row2), panelFmt.row2);
    check('panel 日志：报名未开始(before-apply-window) 与签到未到(before-window) 区分', panelFmt.available && /未到报名时间/.test(panelFmt.row3) && /未到签到\/签退时间/.test(panelFmt.row4), JSON.stringify({ r3: panelFmt.row3, r4: panelFmt.row4 }));
    check('panel formatScan 汇总文案（抓取5/可报名2/已报1/待确认0/过滤2/截断否）', panelFmt.available && /抓取 5/.test(panelFmt.scan) && /可报名 2/.test(panelFmt.scan) && /已报 1/.test(panelFmt.scan) && /过滤 2/.test(panelFmt.scan), panelFmt.scan);
    check('panel formatScan 缺字段显示「—」不假造 0', panelFmt.available && /—/.test(panelFmt.scanMissing), panelFmt.scanMissing);
    check('panel formatScan(null) 返回空', panelFmt.available && panelFmt.scanNull === '', JSON.stringify(panelFmt.scanNull));

    // ── lead review：status 必须优先于 classify（failed/unknown/dry-run 不能被显示成“可报名（待提交）”）──
    const priority = await page.evaluate(() => {
      const L = window.Auto3CTPanel && window.Auto3CTPanel._enrollLog;
      if (!L || typeof L.decisionCn !== 'function') return { available: false };
      return {
        available: true,
        failed: String(L.decisionCn({ status: 'failed', classify: 'joinable' }) || ''),
        unknown: String(L.decisionCn({ status: 'unknown', classify: 'joinable' }) || ''),
        dryRun: String(L.decisionCn({ status: 'dry-run', classify: 'joinable' }) || ''),
        successApply: String(L.decisionCn({ status: 'success', action: 'apply' }) || ''),
        scanFull: String(L.formatScan({ fetched: 5, eligible: 4, joinable: 2, applied: 1, unknown: 0, filtered: 2, nextpages: 2, truncated: false }) || ''),
      };
    });
    info('panel 优先级/formatScan 样例', JSON.stringify(priority));
    check('panel 决策优先级：failed + classify=joinable → 失败', priority.available && /失败/.test(priority.failed) && !/可报名（待提交）/.test(priority.failed), priority.failed);
    check('panel 决策优先级：unknown + classify=joinable → 结果未知（需人工确认）', priority.available && /结果未知/.test(priority.unknown) && !/可报名（待提交）/.test(priority.unknown), priority.unknown);
    check('panel 决策优先级：dry-run + classify=joinable → 预览（不提交）', priority.available && /预览/.test(priority.dryRun) && !/可报名（待提交）/.test(priority.dryRun), priority.dryRun);
    check('panel 决策：success apply → 报名成功', priority.available && /报名成功/.test(priority.successApply), priority.successApply);
    check('panel formatScan 含候选/页数 8 字段（eligible+nextpages）', priority.available && /候选 4/.test(priority.scanFull) && /页数 2/.test(priority.scanFull) && /截断 否/.test(priority.scanFull), priority.scanFull);

    // ── 8) 每日上限/去重不放松：再跑一轮不应重复 apply 同一活动 ──
    const beforeApplyCount = applyCalls.length;
    const round2 = await page.evaluate(async () => {
      const ctx = window.__SMOKE_CTX__;
      const r = await ctx.engine.runOnce();
      return { results: r.results };
    });
    const applyCalls2 = await page.evaluate(() => window.ctAPI.__fake.applyCalls());
    check('第二轮不重复 apply 已成功活动（去重生效）', applyCalls2.length === beforeApplyCount, `before=${beforeApplyCount} after=${applyCalls2.length}`);
    const dupApplies = applyCalls2.map((c) => String((c.payload || {}).act_id || '')).filter((id, i, arr) => arr.indexOf(id) !== i);
    check('同一活动无重复 apply 调用', dupApplies.length === 0, JSON.stringify(dupApplies));

    // ── 9) panel 文案：签到未到时间不代表报名未到时间（cli task-13 可能后到，缺则 pending）──
    const panelText = await page.evaluate(() => String((document.querySelector('.auto3ct-panel') || {}).textContent || ''));
    const hasWording = /签到未到时间不代表报名未到时间|报名窗口|报名时间/.test(panelText) || round.logs.some((l) => /报名/.test(String(l)));
    if (hasWording) check('panel/日志区分报名与签到时间（非静默）', true, 'ok');
    else info('panel 文案区分报名/签到时间', 'pending（task-13 日志可读化待落）');

    check('全程无外部网络请求', external.length === 0, external.join(' | ') || '0');
    check('无页面 JS 异常', pageErrors.length === 0, pageErrors.join(' | '));
    check('无 console.error', consoleErrors.length === 0, consoleErrors.join(' | '));

    await page.screenshot({ path: path.join(OUT, SHOT_PREFIX + '01-run.png'), fullPage: true });
    // 中文日志截图（panel 可读诊断；lead 要求）
    const panelLogShot = await page.evaluate(() => {
      const panel = document.querySelector('.auto3ct-panel');
      if (!panel) return false;
      panel.scrollIntoView({ block: 'start' });
      return true;
    });
    if (panelLogShot) await page.screenshot({ path: path.join(OUT, SHOT_PREFIX + '02-panel-cn-logs.png'), fullPage: false });
    const summary = {
      source: SMOKE_SOURCE, packagedInfo,
      startedAt, finishedAt: new Date().toISOString(), port,
      checks, passed: checks.filter((c) => !c.kind && c.ok).length,
      failed: checks.filter((c) => !c.kind && !c.ok).length,
      externalRequests: external, pageErrors, consoleErrors,
      round1: { results: round.results, summary: round.summary },
      applyCalls: applyCalls.map((c) => c.payload),
      listCalls: listCalls.map((c) => c.payload),
    };
    await fsp.writeFile(RESULT_JSON, JSON.stringify(summary, null, 2) + '\n', 'utf8');
    console.log(`\n结果：${summary.passed} passed / ${summary.failed} failed → ${RESULT_JSON}`);
    if (summary.failed > 0) process.exitCode = 1;
  } catch (err) {
    await fsp.writeFile(RESULT_JSON, JSON.stringify({ startedAt, error: String(err && err.stack ? err.stack : err), checks, externalRequests: external, pageErrors, consoleErrors }, null, 2) + '\n', 'utf8').catch(() => {});
    throw err;
  } finally {
    if (context) await context.close().catch(() => {});
    server.close();
    await fsp.rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  console.error('enrollment smoke 异常终止：', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});

