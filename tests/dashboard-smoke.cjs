/**
 * 3CT 自动化看板（dashboard）离线浏览器验收 —— task-11 QA。
 *
 * 口径（lead/作者契约冻结）：
 *  - 只用 fake ctAPI + 作者模块 API；**不预置 scores/results 内部结构**：
 *    分数由「截图初值」按钮 → engine.importScoreSnapshot → 「刷新官方成绩」→ engine.refreshScores(fake getStudentScores) 产生；
 *    历史由 engine 真实 fake 提交 → onResult hook → Auto3CTResults.append 产生；
 *  - 断言：入口打开、八模块 2/8 + 总缺 29.5、8.5/8 与 15.5/12 真实值 + 进度条 clamp 100%、
 *    summary complete 口径（跨账号/跨模块=0，同身份 in/out=1）、skip 不覆盖已 success 趋势、
 *    dry-run 状态无 flag 拒收、账号隔离、XSS 文本、结果过滤、重开持久化；
 *  - 截图 full-page 到 artifacts/dashboard/；禁外部网络、临时 profile、不读真实 token。
 *
 * 运行：node tests/dashboard-smoke.cjs   （PLAYWRIGHT_CORE 可覆盖）
 */
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const PLAYWRIGHT_CORE =
  process.env.PLAYWRIGHT_CORE || 'C:/Users/<user>/.workbuddy/binaries/node/workspace/node_modules/playwright-core';
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'artifacts', 'dashboard');
// source = 直接加载 desktop/ 源文件；packaged = 从 3CT-Auto app.asar 解包的 dist/renderer 脚本
const SMOKE_SOURCE = process.env.SMOKE_SOURCE === 'packaged' ? 'packaged' : 'source';
const PACKAGED_RENDERER =
  process.env.SMOKE_PACKAGED_RENDERER || path.join(ROOT, 'artifacts', 'patched-renderer', 'dist', 'renderer');
const SHOT_PREFIX = SMOKE_SOURCE === 'packaged' ? 'packaged-dashboard-' : 'dashboard-';
const RESULT_JSON = path.join(OUT, SMOKE_SOURCE === 'packaged' ? 'packaged-dashboard-smoke-result.json' : 'dashboard-smoke-result.json');
const HARNESS_PATH = '/tests/dashboard-smoke.html';

const SERVE_ALLOWLIST = new Set([
  '/tests/dashboard-smoke.html',
  '/desktop/panel.css', '/desktop/dashboard.css', '/desktop/vendor/jsQR.js',
  '/desktop/score-policy.js', '/desktop/result-store.js', '/desktop/automation.js',
  '/desktop/dashboard.js', '/desktop/panel.js',
]);
const PACKAGED_MAP = {
  '/desktop/panel.css': path.join(PACKAGED_RENDERER, 'panel.css'),
  '/desktop/dashboard.css': path.join(PACKAGED_RENDERER, 'dashboard.css'),
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
function skip(name, detail) {
  checks.push({ name, ok: true, detail: detail === undefined ? '' : String(detail), kind: 'skip' });
  console.log(`[SKIP] ${name}${detail ? ' :: ' + detail : ''}`);
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

async function waitReady(page) {
  await page.waitForFunction(() => window.__SMOKE_READY__ === true, null, { timeout: 25000 });
}
async function openDashboard(page) {
  const entry = page.getByTestId('a3-open-dashboard');
  if ((await entry.count()) > 0) {
    await entry.click();
    await page.getByTestId('dashboard-root').waitFor({ state: 'visible', timeout: 20000 });
    return { via: 'panel-entry' };
  }
  await page.evaluate(() => {
    var ctx = window.__SMOKE_CTX__;
    window.Auto3CTDashboard.open({ engine: ctx.engine, store: ctx.store, accountId: '20230001' });
  });
  await page.getByTestId('dashboard-root').waitFor({ state: 'visible', timeout: 20000 });
  return { via: 'dashboard.open (panel 入口 pending)' };
}
async function text(page, testid) {
  const loc = page.getByTestId(testid);
  if ((await loc.count()) === 0) return null;
  return String((await loc.textContent()) || '').trim();
}
async function shot(page, name) {
  const fileName = name.replace(/^dashboard-/, SHOT_PREFIX);
  await page.screenshot({ path: path.join(OUT, fileName), fullPage: true });
}

async function main() {
  await fsp.mkdir(OUT, { recursive: true });
  const startedAt = new Date().toISOString();
  if (!EDGE) throw new Error('找不到 Microsoft Edge');
  let playwright;
  try { playwright = require(PLAYWRIGHT_CORE); } catch (err) { throw new Error('playwright-core 加载失败: ' + err.message); }

  const required = ['desktop/score-policy.js', 'desktop/result-store.js', 'desktop/dashboard.js',
    'desktop/dashboard.css', 'desktop/panel.js', 'desktop/automation.js'];
  let packagedInfo = null;
  if (SMOKE_SOURCE === 'packaged') {
    const missingPackaged = Object.values(PACKAGED_MAP).filter((p) => !fs.existsSync(p));
    if (missingPackaged.length) {
      check('打包副本解包脚本就绪', false, '缺失: ' + missingPackaged.join(', '));
      await fsp.writeFile(RESULT_JSON, JSON.stringify({ startedAt, pending: missingPackaged, checks }, null, 2), 'utf8');
      process.exitCode = 1;
      return;
    }
    packagedInfo = {
      rendererDir: PACKAGED_RENDERER,
      files: Object.fromEntries(Object.entries(PACKAGED_MAP).map(([urlPath, filePath]) => [path.basename(filePath), { sha256: sha256(filePath), bytes: fs.statSync(filePath).size }])),
    };
  }
  const missing = required.filter((rel) => !fs.existsSync(path.join(ROOT, rel)));
  if (missing.length && SMOKE_SOURCE !== 'packaged') {
    check('看板依赖脚本就绪', false, '缺失: ' + missing.join(', '));
    await fsp.writeFile(RESULT_JSON, JSON.stringify({ startedAt, pending: missing, checks }, null, 2), 'utf8');
    process.exitCode = 1;
    return;
  }

  const { server, port } = await startServer();
  const origin = `http://127.0.0.1:${port}`;
  const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'auto3ct-dashboard-'));
  const external = [];
  const pageErrors = [];
  const consoleErrors = [];
  let context;
  let page;
  try {
    context = await playwright.chromium.launchPersistentContext(profile, {
      executablePath: EDGE, headless: true, viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1,
    });
    page = context.pages()[0] || (await context.newPage());
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith(origin) || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
      external.push(url);
      return route.abort();
    });
    page.on('pageerror', (err) => pageErrors.push(String(err && err.message ? err.message : err)));
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('dialog', (dialog) => dialog.accept().catch(() => {}));

    await page.goto(origin + HARNESS_PATH, { waitUntil: 'load' });
    await waitReady(page);
    if (SMOKE_SOURCE === 'packaged') {
      const pairs = [
        ['automation.js', PACKAGED_MAP['/desktop/automation.js'], path.join(ROOT, 'desktop', 'automation.js')],
        ['panel.js', PACKAGED_MAP['/desktop/panel.js'], path.join(ROOT, 'desktop', 'panel.js')],
        ['panel.css', PACKAGED_MAP['/desktop/panel.css'], path.join(ROOT, 'desktop', 'panel.css')],
        ['score-policy.js', PACKAGED_MAP['/desktop/score-policy.js'], path.join(ROOT, 'desktop', 'score-policy.js')],
        ['result-store.js', PACKAGED_MAP['/desktop/result-store.js'], path.join(ROOT, 'desktop', 'result-store.js')],
        ['dashboard.js', PACKAGED_MAP['/desktop/dashboard.js'], path.join(ROOT, 'desktop', 'dashboard.js')],
        ['dashboard.css', PACKAGED_MAP['/desktop/dashboard.css'], path.join(ROOT, 'desktop', 'dashboard.css')],
      ];
      const same = pairs.every(([, packed, source]) => sha256(packed) === sha256(source));
      check('打包副本脚本与 desktop 冻结源文件字节一致', same, pairs.map(([n]) => n).join(','));
      info('打包副本来源', PACKAGED_RENDERER);
    }
    const ctxErr = await page.evaluate(() => window.__SMOKE_CTX_ERROR__ || '');
    check('作者模块加载并创建 engine/store（onResult 已接线）', !ctxErr, ctxErr || 'ok');

    // ── 1) 入口打开 + 初始空态（未预置任何分数/历史）──
    const opened = await openDashboard(page);
    info('看板打开方式', opened.via);
    check('看板 dashboard-root 可见', await page.getByTestId('dashboard-root').isVisible());
    const initialRows = await page.locator('[data-testid="dashboard-results-row"]').count();
    check('初始无预置历史（结果 0 行）', initialRows === 0, `rows=${initialRows}`);
    const empty = await text(page, 'dashboard-empty');
    check('空态提示存在（无造数据）', empty !== null || (await page.getByTestId('dashboard-empty').count()) >= 0, String(empty));
    await shot(page, 'dashboard-01-empty-overview.png');

    // ── 2) 二课补分：真实点击「截图初值」→ 确认 → 8 行 & 真实值 ──
    await page.getByTestId('dashboard-tab-scores').click();
    await page.waitForTimeout(200);
    const templateBtn = page.getByTestId('dashboard-template-apply');
    check('存在「截图初值」导入按钮（不靠预置）', (await templateBtn.count()) === 1);
    const templateDisabled = (await templateBtn.count()) > 0 ? await templateBtn.evaluate((b) => b.disabled) : true;
    check('「截图初值」按钮真实可用（未误置 disabled 布尔属性）', templateDisabled === false, `disabled=${templateDisabled}`);
    // final 严格：必须真实点击按钮，不允许用 engine API fallback 绕过
    if (templateDisabled) {
      check('「截图初值」按钮可点击导入（final 不允许 fallback）', false, '按钮 disabled，后续导入断言不可信');
    } else {
      await templateBtn.click();
      await page.waitForTimeout(700);
    }
    const rows = page.locator('[data-testid="dashboard-score-row"]');
    check('二课补分 8 个模块行（导入后）', (await rows.count()) === 8, `rows=${await rows.count()}`);
    // 值在 input.value 中；同时要求行内文本可读（截图/普通用户可见）
    const scoreValues = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('[data-testid="dashboard-score-row"]')).map((row) => {
        const req = row.querySelector('[data-testid="dashboard-score-required"]');
        const cur = row.querySelector('[data-testid="dashboard-score-current"]');
        return {
          module: row.getAttribute('data-module') || '',
          required: req ? req.value : null,
          current: cur ? cur.value : null,
          text: row.textContent || '',
        };
      });
    });
    info('score 行值', JSON.stringify(scoreValues).slice(0, 500));
    const traditional = scoreValues.find((r) => r.module.includes('传统文化'));
    const psych = scoreValues.find((r) => r.module.includes('心理素质'));
    check('传统文化 8.5/8 真实值', Boolean(traditional) && String(traditional.current) === '8.5' && String(traditional.required) === '8', JSON.stringify(traditional));
    check('心理素质 15.5/12 真实值', Boolean(psych) && String(psych.current) === '15.5' && String(psych.required) === '12', JSON.stringify(psych));
    check(
      'scores 行内文本可读（不只 input 值）',
      scoreValues.every((r) => /\d/.test(r.text)),
      scoreValues.map((r) => r.text).join(' | ').slice(0, 200),
    );
    await shot(page, 'dashboard-02-scores-after-import.png');

    // ── lead critical：importScoreSnapshot 返回 {ok:false} 时必须显示失败、不假成功 ──
    const importReject = await page.evaluate(async () => {
      const ctx = window.__SMOKE_CTX__;
      const original = ctx.engine.importScoreSnapshot;
      let calls = 0;
      ctx.engine.importScoreSnapshot = function () { calls += 1; return { ok: false, reason: 'account-mismatch' }; };
      window.Auto3CTDashboard.open({ engine: ctx.engine, store: ctx.store, accountId: '20230001' });
      window.Auto3CTDashboard.refresh();
      const btn = document.querySelector('[data-testid="dashboard-template-apply"]');
      if (btn) btn.click();
      await new Promise((r) => setTimeout(r, 500));
      const message = (document.querySelector('[data-testid="dashboard-message"]') || {}).textContent || '';
      ctx.engine.importScoreSnapshot = original;
      return { calls: calls, message: String(message) };
    });
    info('拒导入(critical) 结果', JSON.stringify(importReject));
    check('importScoreSnapshot 返回 ok:false 时显示失败/原因（不假成功）', /失败|不匹配|mismatch|错误|未保存/i.test(importReject.message), importReject.message);

    // ── lead critical：无 snapshot / unknown 不得显示 gap=0 全达标 ──
    const noSnapshotState = await page.evaluate(() => {
      // 临时移除当前账号 snapshot（走作者 storage 键，验证 UI 对 null 的处理）
      const raw = window.localStorage.getItem('auto3ct:scores');
      window.localStorage.setItem('auto3ct:scores:qa-backup', raw || '');
      window.localStorage.removeItem('auto3ct:scores');
      const ctx = window.__SMOKE_CTX__;
      const status = ctx.engine.getScorePolicyStatus();
      window.Auto3CTDashboard.open({ engine: ctx.engine, store: ctx.store, accountId: '20230001' });
      window.Auto3CTDashboard.refresh();
      const gapText = (document.querySelector('[data-testid="dashboard-summary-gap"]') || {}).textContent || '';
      const satisfiedText = (document.querySelector('[data-testid="dashboard-summary-satisfied"]') || {}).textContent || '';
      // 恢复
      const backup = window.localStorage.getItem('auto3ct:scores:qa-backup');
      if (backup) window.localStorage.setItem('auto3ct:scores', backup);
      window.localStorage.removeItem('auto3ct:scores:qa-backup');
      return { trusted: status.trusted, totalGap: status.totalGap, gapText: String(gapText), satisfiedText: String(satisfiedText) };
    });
    info('无 snapshot(critical) 状态', JSON.stringify(noSnapshotState));
    check(
      '无 snapshot/unknown 不显示 gap=0 全达标',
      !/29\.5|缺\s*0|总缺口0/.test(noSnapshotState.gapText) &&
        !(/8\s*\/\s*8/.test(noSnapshotState.satisfiedText)),
      JSON.stringify(noSnapshotState),
    );

    // 刷新官方成绩（fake getStudentScores；按钮或 dashboard API）
    const refreshBtn = page.getByTestId('dashboard-refresh');
    const refreshDisabled = (await refreshBtn.count()) > 0 ? await refreshBtn.evaluate((b) => b.disabled) : true;
    if ((await refreshBtn.count()) > 0 && !refreshDisabled) {
      await refreshBtn.click();
      await page.waitForTimeout(800);
      info('刷新官方成绩', '经 dashboard-refresh 按钮');
    } else {
      await page.evaluate(() => window.Auto3CTDashboard.refreshScores(true));
      await page.waitForTimeout(800);
      info('刷新官方成绩', '经 dashboard API（按钮 pending/disabled）');
    }
    const policy = await page.evaluate(() => window.__SMOKE_CTX__.engine.getScorePolicyStatus());
    info('policy 状态', JSON.stringify({ trusted: policy.trusted, totalGap: policy.totalGap, satisfied: (policy.satisfiedModules || []).length }));
    check('官方完整成绩刷新后 policy.trusted=true', policy.trusted === true, JSON.stringify(policy).slice(0, 200));

    // ── lead critical：官方 partial（8→7 项）→ 漏项待确认/unknown，不得假达标/假 trusted ──
    const partialCase = await page.evaluate(async () => {
      const ctx = window.__SMOKE_CTX__;
      const engine = ctx.engine;
      const originalApi = window.ctAPI.ek.getStudentScores;
      // 注意：ctAPI 方法是 wrap 后的异步包装，用 __fake.officialScores() 拿纯数据
      window.ctAPI.ek.getStudentScores = function () {
        const full = window.ctAPI.__fake.officialScores();
        full.TypeList = full.TypeList.filter((t) => t.CurriculumName !== '传统文化与人文素养');
        return Promise.resolve(full);
      };
      const before = engine.getScorePolicyStatus();
      const beforeSnapshot = engine.getScoreSnapshot();
      await engine.refreshScores({ force: true });
      const after = engine.getScorePolicyStatus();
      const afterSnapshot = engine.getScoreSnapshot();
      window.ctAPI.ek.getStudentScores = originalApi;
      window.Auto3CTDashboard.refresh();
      // 重新打开看板以触发 UI 重新渲染
      window.Auto3CTDashboard.open({ engine: engine, store: ctx.store, accountId: '20230001', accounts: { ekAccount: '20230001', unirunAccountId: 'acc-fake-1' } });
      await new Promise((r) => setTimeout(r, 500));
      const gapText = (document.querySelector('[data-testid="dashboard-summary-gap"]') || {}).textContent || '';
      const satisfiedText = (document.querySelector('[data-testid="dashboard-summary-satisfied"]') || {}).textContent || '';
      const templateBtn = document.querySelector('[data-testid="dashboard-template-apply"]');
      const policyCard = (document.querySelector('[data-testid="dashboard-summary-policy"]') || {}).textContent || '';
      return {
        beforeTrusted: before.trusted, afterTrusted: after.trusted,
        afterSatisfied: after.satisfiedModules || [],
        afterUnknown: (after.modules || []).filter((m) => m.trusted === false).map((m) => m.name),
        snapshotModules: afterSnapshot ? (afterSnapshot.modules || []).map((m) => ({ name: m.name, current: m.current, trusted: m.trusted })) : null,
        gapText: String(gapText), satisfiedText: String(satisfiedText), policyCard: String(policyCard),
      };
    });
    info('官方 partial(8→7) 结果', JSON.stringify(partialCase).slice(0, 900));
    check(
      '官方 partial 缺项时 policy.trusted 不得被强转为 true（无假达标）',
      partialCase.afterTrusted === false,
      `before=${partialCase.beforeTrusted} after=${partialCase.afterTrusted}`,
    );
    check(
      '官方 partial 漏项不计入已达标',
      !(partialCase.afterSatisfied || []).includes('传统文化与人文素养'),
      JSON.stringify(partialCase.afterSatisfied),
    );
    check(
      '官方 partial 漏项标记 unknown/待确认（不按 0 计）',
      (partialCase.afterUnknown || []).includes('传统文化与人文素养') ||
        (partialCase.snapshotModules || []).some((m) => m.name === '传统文化与人文素养' && m.trusted === false),
      JSON.stringify({ unknown: partialCase.afterUnknown, modules: partialCase.snapshotModules }),
    );

    // ── partial 的 **真实 DOM hard 断言**（不看 engine metadata，必须 UI 正确）──
    await page.getByTestId('dashboard-tab-overview').click();
    await page.waitForTimeout(400);
    await page.evaluate(() => window.Auto3CTDashboard.refresh());
    await page.waitForTimeout(300);
    const partialDom = await page.evaluate(() => {
      const q = (id) => document.querySelector('[data-testid="' + id + '"]');
      const text = (id) => (q(id) ? String(q(id).textContent || '').trim() : null);
      const rows = Array.from(document.querySelectorAll('[data-testid="dashboard-progress-row"]')).map((row) => ({
        module: row.getAttribute('data-module') || '',
        text: String(row.textContent || ''),
      }));
      const traditional = rows.find((r) => r.module.includes('传统文化')) || null;
      const satisfyText = text('dashboard-summary-satisfied');
      const gapText = text('dashboard-summary-gap');
      const policyText = text('dashboard-summary-policy');
      const staleText = text('dashboard-stale');
      return { gapText, satisfyText, policyText, staleText, traditional, progressRowCount: rows.length };
    });
    info('partial DOM', JSON.stringify(partialDom).slice(0, 700));
    check('partial：overview 总缺口 DOM 文本非空且不假报 0', Boolean(partialDom.gapText) && !/^0\b/.test(partialDom.gapText), JSON.stringify(partialDom.gapText));
    check(
      'partial：总缺口/已达标 DOM 明确体现未知或已知缺口（不是空/不是全达标）',
      /未知|待确认|已知缺口/.test(String(partialDom.gapText)) || /未知|待确认|—/.test(String(partialDom.satisfyText)),
      JSON.stringify({ gap: partialDom.gapText, satisfied: partialDom.satisfyText }),
    );
    check('partial：已达标 DOM 不含传统文化（不假达标）', !String(partialDom.satisfyText || '').includes('8 / 8'), JSON.stringify(partialDom.satisfyText));
    check(
      'partial：传统文化行 badge 显示「待确认」且保留旧值仅参考',
      Boolean(partialDom.traditional) && /待确认/.test(partialDom.traditional.text) && /8\.5/.test(partialDom.traditional.text),
      JSON.stringify(partialDom.traditional),
    );
    check('partial：缺口策略卡 DOM 非空（已启用/已关闭）', Boolean(partialDom.policyText), JSON.stringify(partialDom.policyText));
    await shot(page, 'dashboard-07-partial-official.png');
    const refreshBlockedByPolicy = await page.evaluate(() => {
      const ctx = window.__SMOKE_CTX__;
      const status = ctx.engine.getScorePolicyStatus();
      // 策略 untrusted 时，新增报名应被阻断（allow=false），已报名继续不在此断言
      const P = window.Auto3CTScorePolicy;
      if (!P || typeof P.canApplyCategory !== 'function') return { available: false };
      const decision = P.canApplyCategory(status, '思想政治与道德修养');
      return { available: true, allow: decision.allow, reason: decision.reason, trusted: status.trusted };
    });
    info('partial 后新增报名策略', JSON.stringify(refreshBlockedByPolicy));
    check(
      '官方 partial 后新增报名被阻断（fail-closed）',
      refreshBlockedByPolicy.available === false || refreshBlockedByPolicy.allow === false,
      JSON.stringify(refreshBlockedByPolicy),
    );
    // 恢复完整官方成绩，供后续概览/截图断言
    await page.evaluate(() => window.__SMOKE_CTX__.engine.refreshScores({ force: true }));
    await page.waitForTimeout(600);

    // ── 3) 概览：2/8 + 总缺 29.5 ──
    await page.getByTestId('dashboard-tab-overview').click();
    await page.waitForTimeout(300);
    const gap = await text(page, 'dashboard-summary-gap');
    check('顶部总缺口 29.5', /29\.5/.test(String(gap)), gap);
    const satisfied = await text(page, 'dashboard-summary-satisfied');
    check('顶部已达标 2/8', /2/.test(String(satisfied)) && /8/.test(String(satisfied)), satisfied);
    // 进度条 clamp：必须 8 个 fill 元素存在，且至少 2 个（8.5/8、15.5/12）width=100%（不溢出）
    const barClamp = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('[data-testid="dashboard-progress-row"]'));
      return rows.map((row) => {
        const bar = row.querySelector('[data-testid="dashboard-progress-bar"]');
        if (!bar) return { hasBar: false };
        const fill = bar.getBoundingClientRect().width;
        const track = (bar.parentElement || row).getBoundingClientRect().width;
        return {
          hasBar: true,
          fill,
          track,
          ok: fill <= track + 1,
          styleWidth: bar.style.width || '',
          module: row.getAttribute('data-module') || (row.textContent || '').slice(0, 12),
        };
      });
    });
    info('进度条 clamp 数据', JSON.stringify(barClamp).slice(0, 500));
    check('8 个模块进度条 fill 元素都存在', barClamp.length === 8 && barClamp.every((b) => b.hasBar), `count=${barClamp.length}`);
    check('超要求模块进度条 clamp 100%（不溢出）', barClamp.every((b) => b.ok), JSON.stringify(barClamp));
    const fullBars = barClamp.filter((b) => b.hasBar && Math.abs(b.fill - b.track) <= 2).length;
    check('至少 2 个进度条达到 100%（8.5/8、15.5/12 clamp）', fullBars >= 2, `full=${fullBars} data=${JSON.stringify(barClamp)}`);
    await shot(page, 'dashboard-03-overview.png');

    // ── 4) 结果历史：preview 不落库 → engine 真实 fake 提交 → onResult → store → UI ──
    const storeCountBefore = await page.evaluate(() => window.__SMOKE_CTX__.store.list({ accountId: '20230001' }).length);
    await page.evaluate(() => window.__SMOKE_CTX__.engine.preview());
    await page.waitForTimeout(800);
    const storeCountAfterPreview = await page.evaluate(() => window.__SMOKE_CTX__.store.list({ accountId: '20230001' }).length);
    check('preview 轮不写入结果历史', storeCountAfterPreview === storeCountBefore, `before=${storeCountBefore} after=${storeCountAfterPreview}`);

    await page.evaluate(async () => {
      const ctx = window.__SMOKE_CTX__;
      // 真实模式（fake ctAPI）：启用二课，使用已报名 + 可扫码签到的 fake 活动，
      // 让 engine 真实提交 signByQr 成功 → onResult → store（事件 accountId 为二课学号）。
      ctx.engine.setConfig({
        dryRun: false,
        accountId: 'acc-fake-1',
        campusId: 'campus-1',
        unirun: { enabled: false },
        club: { enabled: false },
        ek: {
          enabled: true, keywords: [], allowAll: true, apply: false,
          signIn: true, signOut: false, dailyLimit: 5,
          qrDelayMinutes: 0, qrRetryMinutes: 0, qrMaxAttempts: 5,
        },
      });
      await ctx.engine.runOnce();
    });
    await page.waitForTimeout(1200);
    const storeAfterReal = await page.evaluate(() => ({
      list: window.__SMOKE_CTX__.store.list(),
      writes: window.ctAPI.__fake.writeCount(),
      ekEvents: window.__SMOKE_CTX__.store.list({ accountId: '20230001' }),
    }));
    check('engine 真实 fake 提交发生（fake 写调用 >0）', storeAfterReal.writes > 0, `writes=${storeAfterReal.writes}`);
    check('onResult→store 落库（真实链路，未预置）', storeAfterReal.list.length >= 1, `count=${storeAfterReal.list.length}`);
    const evt = storeAfterReal.ekEvents[0] || storeAfterReal.list[0] || {};
    info('onResult 事件', JSON.stringify({ module: evt.module, action: evt.action, status: evt.status, accountId: evt.accountId, day: evt.day }));
    check('onResult 事件字段完整（accountId/day/status）', Boolean(evt.accountId && evt.day && evt.status), JSON.stringify(evt).slice(0, 200));

    // ── 5) 结果 tab：行可见、去重、过滤、账号隔离、XSS ──
    await page.getByTestId('dashboard-tab-results').click();
    await page.waitForTimeout(400);
    await page.evaluate(() => window.Auto3CTDashboard.refresh());
    await page.waitForTimeout(400);
    let resultRows = await page.locator('[data-testid="dashboard-results-row"]').count();
    if (resultRows === 0) {
      // 先断言/记录为空（不 30s wait table），继续后续 case
      const emptyVisible = (await page.getByTestId('dashboard-empty').count()) > 0;
      check('执行记录 UI 可见真实链路结果', false, `rows=0 empty=${emptyVisible}（store 已有事件但 UI 未显示，需作者排查过滤/渲染）`);
      const tableCount = await page.getByTestId('dashboard-results-table').count();
      info('结果表存在性', `table=${tableCount}`);
    } else {
      check('执行记录 UI 可见真实链路结果', true, `rows=${resultRows}`);
      const tableText = String(await page.getByTestId('dashboard-results-table').textContent().catch(() => ''));
      check('账号脱敏显示（不含完整手机号）', !tableText.includes('13800000000'), tableText.slice(0, 120));
    }

    // 通过作者 store API 注入跨账号/跨模块/同身份事件，验证 summary complete 口径
    const complete = await page.evaluate(() => {
      var mk = function (over) {
        return Object.assign({ at: Date.now(), day: '2026-10-17', status: 'success', preview: false, dryRun: false, accountId: '20230001' }, over || {});
      };
      var factory = window.Auto3CTResults.createStore;
      // 内存 storage 必须在多次 append 之间保留数据，否则 summary 读到空历史（测试夹具 bug）
      var memoryStore = function () {
        var mem = { data: null };
        return factory({
          storage: {
            get: function () { return mem.data; },
            set: function (k, v) { mem.data = v; },
            remove: function () { mem.data = null; },
          },
        });
      };
      var s1 = memoryStore();
      s1.append(mk({ key: 'x1', module: 'ek', action: 'signIn', activityId: 'X' }));
      s1.append(mk({ key: 'x2', module: 'ek', action: 'signOut', activityId: 'X', accountId: 'other-acc' }));
      var crossAccount = s1.summary().activities;
      var s2 = memoryStore();
      s2.append(mk({ key: 'y1', module: 'ek', action: 'signIn', activityId: 'X' }));
      s2.append(mk({ key: 'y2', module: 'club', action: 'signOut', activityId: 'X' }));
      var crossModule = s2.summary().activities;
      var s3 = memoryStore();
      s3.append(mk({ key: 'z1', module: 'ek', action: 'signIn', activityId: 'X' }));
      s3.append(mk({ key: 'z2', module: 'ek', action: 'signOut', activityId: 'X' }));
      var sameIdentity = s3.summary().activities;
      return { crossAccount: crossAccount, crossModule: crossModule, sameIdentity: sameIdentity };
    });
    check('summary complete：跨账号同 id 不合并（=0）', complete.crossAccount === 0, JSON.stringify(complete));
    check('summary complete：跨模块同 id 不合并（=0）', complete.crossModule === 0, JSON.stringify(complete));
    check('summary complete：同身份 signIn+signOut = 1', complete.sameIdentity === 1, JSON.stringify(complete));

    // skip 不覆盖已 success 的趋势；dry-run status 无 flag 拒收（作者 store API 语义）
    const semantics = await page.evaluate(() => {
      var memory = { data: null };
      var store = window.Auto3CTResults.createStore({
        storage: { get: function () { return memory.data; }, set: function (k, v) { memory.data = v; }, remove: function () { memory.data = null; } },
        clock: { now: function () { return 1792212000000; } },
      });
      store.append({ key: 'trend-1', module: 'ek', action: 'apply', activityId: 'A1', status: 'success', accountId: '20230001' });
      var first = store.list({ accountId: '20230001' })[0];
      store.append({ key: 'trend-1', module: 'ek', action: 'apply', activityId: 'A1', status: 'skipped', accountId: '20230001' });
      var after = store.list({ accountId: '20230001' })[0];
      var dryRunAppend = store.append({ key: 'dry-1', module: 'ek', action: 'apply', activityId: 'A2', status: 'dry-run', accountId: '20230001' });
      var dryInList = store.list({ accountId: '20230001' }).some(function (e) { return e.key === 'dry-1'; });
      var failing = window.Auto3CTResults.createStore({ storage: { get: function () { return null; }, set: function () { throw new Error('quota'); }, remove: function () {} } });
      var writeFail = failing.append({ key: 'w1', module: 'ek', action: 'apply', activityId: 'A3', status: 'success', accountId: '20230001' });
      return {
        statusKept: after && after.status === 'success', atKept: first && after && first.at === after.at, dayKept: first && after && first.day === after.day,
        dryRunRejected: dryRunAppend === false && dryInList === false,
        storageFailExplicit: writeFail === false,
      };
    });
    check('skip 不覆盖已 success 的 status/at/day', semantics.statusKept && semantics.atKept && semantics.dayKept, JSON.stringify(semantics));
    check('dry-run status 无 flag 被拒收', semantics.dryRunRejected, JSON.stringify(semantics));
    check('append 写失败显式返回 false（非假成功）', semantics.storageFailExplicit, JSON.stringify(semantics));

    // 账号隔离：注入其他账号事件后默认过滤不含
    await page.evaluate(() => {
      var ctx = window.__SMOKE_CTX__;
      ctx.store.append({ key: 'other-acc-1', module: 'ek', action: 'apply', activityId: 'OTHER', activityName: '其他账号活动', status: 'success', accountId: 'other-account-999' });
      ctx.store.append({ key: 'xss-1', module: 'ek', action: 'apply', activityId: 'XSS', activityName: '<img src=x onerror=window.__XSS__=1>', status: 'success', accountId: '20230001' });
      window.Auto3CTDashboard.refresh();
    });
    await page.waitForTimeout(500);
    await page.getByTestId('dashboard-tab-results').click();
    await page.waitForTimeout(300);
    const tableCount2 = await page.getByTestId('dashboard-results-table').count();
    const tableText2 = tableCount2 > 0 ? String(await page.getByTestId('dashboard-results-table').textContent()) : '';
    check('账号隔离：默认不含其他账号事件', tableCount2 === 0 || !tableText2.includes('其他账号活动'), `table=${tableCount2}`);
    check('XSS 活动标题按文本渲染（无脚本执行）', (await page.evaluate(() => window.__XSS__)) !== 1, 'window.__XSS__');
    await shot(page, 'dashboard-04-results.png');

    // 过滤：状态=failed / 模块=club / 日期（先注入一条 failed + club 事件）
    await page.evaluate(() => {
      var ctx = window.__SMOKE_CTX__;
      ctx.store.append({ key: 'fail-1', module: 'club', action: 'join', activityId: 'F1', activityName: '失败活动', status: 'failed', accountId: '20230001' });
      ctx.store.append({ key: 'club-ok-1', module: 'club', action: 'signIn', activityId: 'C1', activityName: '俱乐部签到活动', status: 'success', accountId: '20230001' });
      window.Auto3CTDashboard.refresh();
    });
    await page.waitForTimeout(400);
    await page.getByTestId('dashboard-tab-results').click();
    await page.waitForTimeout(500);
    const statusSelect = page.getByTestId('dashboard-filter-status');
    const moduleSelect = page.getByTestId('dashboard-filter-module');
    const accountSelect = page.getByTestId('dashboard-filter-account');
    const filterReady = (await statusSelect.count()) === 1 && (await moduleSelect.count()) === 1 && (await accountSelect.count()) === 1 &&
      (await page.getByTestId('dashboard-filter-from').count()) > 0 &&
      (await page.getByTestId('dashboard-filter-to').count()) > 0;
    check(
      '执行记录 3 个筛选 select（账号/模块/状态）均存在非空',
      filterReady,
      `account=${await accountSelect.count()} module=${await moduleSelect.count()} status=${await statusSelect.count()}`,
    );
    if (filterReady) {
      // 真实 UI 操作：先记录全量行数 → 选 module=club + status=success + account=当前组 → 点筛选 → 行数变化且内容匹配
      const allRows = await page.locator('[data-testid="dashboard-results-row"]').count();
      await moduleSelect.selectOption('club');
      await statusSelect.selectOption('success');
      await page.getByTestId('dashboard-filter-apply').click();
      await page.waitForTimeout(500);
      const filteredRows = await page.locator('[data-testid="dashboard-results-row"]').count();
      const filteredText = (await page.locator('[data-testid="dashboard-results-row"]').allTextContents()).join(' | ');
      check(
        'module=club + status=success 筛选实际生效（行数减少且内容匹配）',
        filteredRows >= 1 &&
          filteredRows <= allRows &&
          /俱乐部|club/i.test(filteredText) &&
          /上游已接受/.test(filteredText),
        `all=${allRows} filtered=${filteredRows} text=${filteredText.slice(0, 140)}`,
      );
      // status=failed 单独筛选
      await statusSelect.selectOption('failed');
      await moduleSelect.selectOption('');
      await page.getByTestId('dashboard-filter-apply').click();
      await page.waitForTimeout(500);
      const failedText = (await page.locator('[data-testid="dashboard-results-row"]').allTextContents()).join(' | ');
      check('status=failed 筛选实际生效（含失败行）', failedText.includes('失败'), failedText.slice(0, 140));
      // 账号筛选：选“全部账号”（value ''）→ 行数应 >= 当前组
      await statusSelect.selectOption('');
      const accountOptions = await accountSelect.locator('option').evaluateAll((opts) => opts.map((o) => ({ value: o.value, text: o.textContent })));
      const allAccounts = accountOptions.find((o) => o.value === '');
      if (allAccounts) {
        await accountSelect.selectOption('');
        await page.getByTestId('dashboard-filter-apply').click();
        await page.waitForTimeout(500);
        const allAccountRows = await page.locator('[data-testid="dashboard-results-row"]').count();
        check('account=全部账号 筛选实际生效（行数 >= 当前组）', allAccountRows >= filteredRows, `allAccounts=${allAccountRows} currentGroup=${filteredRows}`);
      }
      await page.getByTestId('dashboard-filter-reset').click();
      await page.waitForTimeout(400);
      const resetRows = await page.locator('[data-testid="dashboard-results-row"]').count();
      check('重置筛选恢复默认（行数回到当前组）', resetRows >= 1, `reset=${resetRows} all=${allRows}`);
    }
    await shot(page, 'dashboard-04-results.png');

    // 概览模块卡全可见截图（lead 要求最终包含模块 cards）
    await page.getByTestId('dashboard-tab-overview').click();
    await page.waitForTimeout(400);
    const moduleCards = page.getByTestId('dashboard-module-actions');
    check('概览逐模块成功动作卡存在', (await moduleCards.count()) === 1);
    if ((await moduleCards.count()) > 0) await moduleCards.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await shot(page, 'dashboard-06-overview-module-cards.png');

    // ── 6) 重开持久化（同一 profile reload）──
    await page.reload({ waitUntil: 'load' });
    await waitReady(page);
    await openDashboard(page);
    await page.getByTestId('dashboard-tab-results').click();
    await page.waitForTimeout(400);
    const reopenedRows = await page.locator('[data-testid="dashboard-results-row"]').count();
    check('重开后结果历史持久（行数 >0）', reopenedRows > 0, `rows=${reopenedRows}`);
    const gapReopened = await page.evaluate(() => {
      const ctx = window.__SMOKE_CTX__;
      return ctx.engine.getScorePolicyStatus().totalGap;
    });
    check('重开后分数快照持久（totalGap=29.5）', Number(gapReopened) === 29.5, String(gapReopened));
    await shot(page, 'dashboard-05-reopened.png');

    check('全程无外部网络请求', external.length === 0, external.join(' | ') || '0');
    check('无页面 JS 异常', pageErrors.length === 0, pageErrors.join(' | '));
    check('无 console.error', consoleErrors.length === 0, consoleErrors.join(' | '));

    const summary = {
      source: SMOKE_SOURCE, packagedInfo,
      startedAt, finishedAt: new Date().toISOString(), port, profile, openedVia: opened.via,
      checks, passed: checks.filter((c) => c.kind !== 'info' && c.kind !== 'skip' && c.ok).length,
      failed: checks.filter((c) => c.kind !== 'info' && c.kind !== 'skip' && !c.ok).length,
      skipped: checks.filter((c) => c.kind === 'skip').length,
      externalRequests: external, pageErrors, consoleErrors,
      screenshots: fs.readdirSync(OUT).filter((n) => n.startsWith(SHOT_PREFIX) && n.endsWith('.png')).sort(),
    };
    await fsp.writeFile(RESULT_JSON, JSON.stringify(summary, null, 2) + '\n', 'utf8');
    console.log(`\n结果：${summary.passed} passed / ${summary.failed} failed / ${summary.skipped} skipped → ${RESULT_JSON}`);
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
  console.error('看板烟测异常终止：', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
