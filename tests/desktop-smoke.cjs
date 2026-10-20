/**
 * 3CT AutoPanel 最终离线浏览器回归（Playwright-core + 本机 Edge，独立临时 profile）。
 *
 * 覆盖 cli-dev/lead 指定的 7 类断言：
 *  1) 三模块 checkbox 存在且默认未勾选；
 *  2) 账号/校区下拉初始为「请选择」占位，不自动选第一项；
 *  3) 取消预览 confirm 被接受后，真实执行 fake 写调用计数 >0（抓“UI 真实但引擎预览”的假成功）；
 *     取消 confirm 则仍是预览模式；
 *  4) 未选账号/校区时真实启动被阻断，无 runOnce 提交；
 *  5) busy 期间重复点击只产生一轮调用；停止后已发出请求的结果仍写日志、按钮恢复可用；
 *  6) 面板宽度 480px / 窄屏不超视口，label 不被挤成三列（近景截图）；
 *  7) 模块开关 + 账号/校区下拉 + 配置持久化/重开自动恢复。
 *
 * 运行： node tests/desktop-smoke.cjs   （可用 PLAYWRIGHT_CORE 覆盖 playwright-core 路径）
 * 仅使用 fake ctAPI、独立临时 profile；无外部网络、不含任何真实账号/token。
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
const ARTIFACTS = path.join(ROOT, 'artifacts');
// desktop = 直接加载 desktop/ 源文件；packaged = 加载从 3CT-Auto app.asar 解包出的 dist/renderer 脚本
const SMOKE_SOURCE = process.env.SMOKE_SOURCE === 'packaged' ? 'packaged' : 'desktop';
const PACKAGED_RENDERER =
  process.env.SMOKE_PACKAGED_RENDERER || path.join(ARTIFACTS, 'patched-renderer', 'dist', 'renderer');
const SHOT_PREFIX = SMOKE_SOURCE === 'packaged' ? 'packaged-smoke-' : 'desktop-smoke-';
const RESULT_JSON = path.join(
  ARTIFACTS,
  SMOKE_SOURCE === 'packaged' ? 'desktop-smoke-result-packaged.json' : 'desktop-smoke-result.json',
);
const FAILURE_JSON = path.join(
  ARTIFACTS,
  SMOKE_SOURCE === 'packaged' ? 'desktop-smoke-failure-packaged.json' : 'desktop-smoke-failure.json',
);
const HARNESS_PATH = '/tests/desktop-smoke.html';

/** 打包模式：/desktop/* 允许列表映射到解包的 renderer 目录 */
const PACKAGED_MAP = {
  '/desktop/automation.js': path.join(PACKAGED_RENDERER, 'automation.js'),
  '/desktop/panel.js': path.join(PACKAGED_RENDERER, 'panel.js'),
  '/desktop/panel.css': path.join(PACKAGED_RENDERER, 'panel.css'),
  '/desktop/vendor/jsQR.js': path.join(PACKAGED_RENDERER, 'jsQR.js'),
};

const SERVE_ALLOWLIST = new Set([
  '/tests/desktop-smoke.html',
  '/desktop/automation.js',
  '/desktop/panel.js',
  '/desktop/panel.css',
  '/desktop/vendor/jsQR.js',
]);

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
};

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail: detail === undefined ? '' : String(detail), kind: 'assert' });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' :: ' + detail : ''}`);
}
function info(name, detail) {
  checks.push({ name, ok: true, detail: detail === undefined ? '' : String(detail), kind: 'info' });
  console.log(`[INFO] ${name}${detail ? ' :: ' + detail : ''}`);
}

async function clipShot(page, panel, name) {
  const box = await panel.boundingBox();
  if (!box) throw new Error('面板不可见，无法截图');
  const viewport = page.viewportSize() || { width: 1200, height: 1000 };
  const margin = 16;
  const x = Math.max(0, Math.round(box.x) - margin);
  const y = Math.max(0, Math.round(box.y) - margin);
  const clip = {
    x,
    y,
    width: Math.min(viewport.width - x, Math.ceil(box.width) + margin * 2),
    height: Math.min(viewport.height - y, Math.ceil(box.height) + margin * 2),
  };
  const fileName = name.replace(/^desktop-smoke-/, SHOT_PREFIX);
  await page.screenshot({ path: path.join(ARTIFACTS, fileName), clip });
}

/** 读取文件 sha256（用于校验打包副本脚本与冻结源文件一致） */
function sha256(filePath) {
  return require('node:crypto').createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function resolveServeFile(urlPath) {
  if (SMOKE_SOURCE === 'packaged' && PACKAGED_MAP[urlPath]) {
    return { filePath: PACKAGED_MAP[urlPath], base: PACKAGED_RENDERER };
  }
  return { filePath: path.resolve(ROOT, urlPath.replace(/^\/+/, '')), base: ROOT };
}

function findEdge() {
  for (const candidate of EDGE_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function startStaticServer() {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    if (urlPath === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (!SERVE_ALLOWLIST.has(urlPath)) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const { filePath, base } = resolveServeFile(urlPath);
    const relativeToBase = path.relative(base, filePath);
    if (relativeToBase.startsWith('..') || path.isAbsolute(relativeToBase)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, origin: `http://127.0.0.1:${port}` });
    });
  });
}

async function waitReady(page) {
  await page.waitForFunction(() => window.__SMOKE_READY__ === true && !!window.Auto3CTPanel, null, {
    timeout: 15000,
  });
  await page.locator('[data-testid="a3-panel"]').waitFor({ state: 'visible', timeout: 10000 });
}

async function statusText(page) {
  return String((await page.locator('#a3-status').textContent()) || '').trim();
}

async function waitStatusContains(page, needle, timeout) {
  await page.waitForFunction(
    (expected) => {
      const node = document.getElementById('a3-status');
      return node && node.textContent.includes(expected);
    },
    needle,
    { timeout: timeout || 15000 },
  );
}

async function getLogs(page) {
  return page.evaluate(() => window.Auto3CTPanel.getLogs().map((l) => l.text));
}

async function readConfig(page) {
  const raw = await page.evaluate(() => window.localStorage.getItem('auto3ct:config'));
  try {
    return JSON.parse(raw || '{}') || {};
  } catch (err) {
    return {};
  }
}

async function countCalls(page, name) {
  return page.evaluate((callName) => window.ctAPI.__fake.calls.filter((c) => c.name === callName).length, name);
}

async function countWrites(page) {
  return page.evaluate(() => window.ctAPI.__fake.writeCount());
}

async function roundsLogged(page) {
  const logs = await getLogs(page);
  return logs.filter((line) => line.includes('本轮：')).length;
}

async function main() {
  await fsp.mkdir(ARTIFACTS, { recursive: true });
  const startedAt = new Date().toISOString();

  let packagedInfo = null;
  if (SMOKE_SOURCE === 'packaged') {
    for (const filePath of Object.values(PACKAGED_MAP)) {
      if (!fs.existsSync(filePath)) {
        throw new Error(
          `打包副本脚本缺失：${filePath}\n请先执行：python reverse/asar_extract.py --archive 3CT-Auto\\resources\\app.asar --out artifacts/patched-renderer --only "dist/renderer/"`,
        );
      }
    }
    packagedInfo = {
      rendererDir: PACKAGED_RENDERER,
      files: Object.fromEntries(
        Object.entries(PACKAGED_MAP).map(([urlPath, filePath]) => [
          path.basename(filePath),
          { sha256: sha256(filePath), bytes: fs.statSync(filePath).size },
        ]),
      ),
    };
  }

  const edge = findEdge();
  if (!edge) throw new Error('找不到 Microsoft Edge，无法执行浏览器烟测');
  let playwright;
  try {
    playwright = require(PLAYWRIGHT_CORE);
  } catch (err) {
    throw new Error(`无法加载 playwright-core（${PLAYWRIGHT_CORE}）: ${err.message}`);
  }

  const { server, origin } = await startStaticServer();
  const userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'auto3ct-smoke-profile-'));
  const externalRequests = [];
  const pageErrors = [];
  const consoleErrors = [];
  let dialogMode = 'accept';

  let context;
  let page;
  try {
    context = await playwright.chromium.launchPersistentContext(userDataDir, {
      executablePath: edge,
      headless: true,
      viewport: { width: 1200, height: 1000 },
      deviceScaleFactor: 1,
      args: ['--no-first-run', '--no-default-browser-check', '--disable-extensions'],
    });
    page = context.pages()[0] || (await context.newPage());

    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith(origin) || url.startsWith('data:') || url.startsWith('blob:')) {
        return route.continue();
      }
      externalRequests.push(url);
      return route.abort();
    });
    page.on('pageerror', (err) => pageErrors.push(String(err && err.message ? err.message : err)));
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('dialog', async (dialog) => {
      if (dialogMode === 'dismiss') {
        dialogMode = 'accept';
        await dialog.dismiss().catch(() => {});
      } else {
        await dialog.accept().catch(() => {});
      }
    });

    await page.goto(origin + HARNESS_PATH, { waitUntil: 'load' });
    await waitReady(page);
    const panel = page.locator('[data-testid="a3-panel"]');
    const toggle = page.getByTestId('a3-start-stop');
    const dryRun = page.getByTestId('a3-dry-run');

    if (SMOKE_SOURCE === 'packaged') {
      // 打包副本必须与冻结的 desktop 源脚本字节一致，避免测到旧包
      const pairs = [
        ['automation.js', Object.values(PACKAGED_MAP)[0], path.join(ROOT, 'desktop', 'automation.js')],
        ['panel.js', Object.values(PACKAGED_MAP)[1], path.join(ROOT, 'desktop', 'panel.js')],
        ['panel.css', Object.values(PACKAGED_MAP)[2], path.join(ROOT, 'desktop', 'panel.css')],
      ];
      const same = pairs.every(([, packaged, source]) => sha256(packaged) === sha256(source));
      check('打包副本脚本与 desktop 冻结源文件字节一致', same, packagedInfo ? Object.keys(packagedInfo.files).join(',') : '');
      info('打包副本来源', PACKAGED_RENDERER);
    }

    check('面板已挂载（data-testid=a3-panel）', await panel.isVisible());
    check('标题为「3CT 自动业务」', String(await page.locator('.a3-title').first().textContent()).includes('3CT 自动业务'));
    check('初始状态为「未启动」', (await statusText(page)) === '未启动', await statusText(page));
    check('预览开关默认勾选', await dryRun.isChecked());

    // ── 1) 三模块 checkbox 存在且默认未勾选 ──
    const moduleIds = ['a3-module-unirun', 'a3-module-club', 'a3-module-ek'];
    const moduleStates = {};
    for (const id of moduleIds) {
      moduleStates[id] = await page.getByTestId(id).isChecked().catch(() => null);
    }
    check('三模块 checkbox 存在', Object.values(moduleStates).every((v) => v !== null), JSON.stringify(moduleStates));
    check('三模块默认未勾选', Object.values(moduleStates).every((v) => v === false), JSON.stringify(moduleStates));

    // ── 2) 账号/校区下拉初始为「请选择」占位 ──
    await page.waitForFunction(
      () => {
        const a = document.querySelector('[data-testid="a3-account"]');
        const c = document.querySelector('[data-testid="a3-campus"]');
        return a && c && a.options.length >= 1 && c.options.length >= 1;
      },
      null,
      { timeout: 10000 },
    );
    const accountValue0 = await page.getByTestId('a3-account').inputValue();
    const campusValue0 = await page.getByTestId('a3-campus').inputValue();
    check('账号下拉初始为占位（未自动选择）', accountValue0 === '', `value=${accountValue0}`);
    check('校区下拉初始为占位（未自动选择）', campusValue0 === '', `value=${campusValue0}`);
    await clipShot(page, panel, 'desktop-smoke-01-initial.png');

    // ── 3a) 取消 confirm：仍是预览模式 ──
    dialogMode = 'dismiss';
    await dryRun.click();
    await page.waitForTimeout(300);
    check('取消 confirm 后仍是预览模式', await dryRun.isChecked(), `checked=${await dryRun.isChecked()}`);
    const configAfterCancel = await readConfig(page);
    check('取消 confirm 后引擎配置仍 dryRun=true', configAfterCancel.dryRun === true, JSON.stringify(configAfterCancel.dryRun));

    // ── 3b) 接受 confirm：切真实执行 ──
    await dryRun.click();
    await page.waitForTimeout(400);
    check('接受 confirm 后预览开关关闭', (await dryRun.isChecked()) === false);
    const configReal = await readConfig(page);
    check('真实模式已同步进引擎配置（dryRun=false）', configReal.dryRun === false, JSON.stringify(configReal.dryRun));

    // ── 4) 真实模式阻断矩阵：模块/账号/校区逐项缺失都应阻断且 writes=0 ──
    // 4a) 未启用任何模块 → 阻断「没有启用任何业务模块」
    await toggle.click();
    await page.waitForTimeout(600);
    const logsNoModule = (await getLogs(page)).join('\n');
    check('未启用模块时真实启动被阻断（状态未启动）', (await statusText(page)) === '未启动', await statusText(page));
    check('未启用模块：writes=0', (await countWrites(page)) === 0, `writes=${await countWrites(page)}`);
    check('未启用模块：日志含阻断原因', /没有启用任何业务模块/.test(logsNoModule), logsNoModule.split('\n').slice(-2).join(' | '));

    // 4b) 只启用 unirun、账号/校区仍空 → 阻断「未选择账号」
    await page.getByTestId('a3-module-unirun').check();
    await page.waitForTimeout(400);
    await toggle.click();
    await page.waitForTimeout(600);
    const logsNoAccount = (await getLogs(page)).join('\n');
    check('启用 unirun 但未选账号：真实启动被阻断', (await statusText(page)) === '未启动', await statusText(page));
    check('启用 unirun 但未选账号：writes=0', (await countWrites(page)) === 0, `writes=${await countWrites(page)}`);
    check(
      '未选账号：日志含 need account 原因',
      /未选择校园跑\/俱乐部账号|未选择校园跑\/俱乐部账号/.test(logsNoAccount),
      logsNoAccount.split('\n').slice(-3).join(' | '),
    );

    // 4c) 只选账号、校区仍空 → 阻断「未选择校区」
    const accountOnly = await page.getByTestId('a3-account').evaluate((node) => {
      const opt = Array.from(node.options).find((o) => o.value);
      return opt ? opt.value : '';
    });
    check('4c 前置：账号下拉有可选项', Boolean(accountOnly), `account=${accountOnly}`);
    await page.getByTestId('a3-account').selectOption(accountOnly);
    await page.waitForTimeout(400);
    await toggle.click();
    await page.waitForTimeout(600);
    const logsNoCampus = (await getLogs(page)).join('\n');
    check('只选账号未选校区：真实启动被阻断', (await statusText(page)) === '未启动', await statusText(page));
    check('只选账号未选校区：writes=0', (await countWrites(page)) === 0, `writes=${await countWrites(page)}`);
    check(
      '未选校区：日志含 need campus 原因',
      /未选择校区/.test(logsNoCampus),
      logsNoCampus.split('\n').slice(-3).join(' | '),
    );
    await clipShot(page, panel, 'desktop-smoke-02-real-blocked.png');

    // ── 7a) 补齐模块/账号/校区（按钮驱动），真实执行前置条件满足 ──
    for (const id of moduleIds) await page.getByTestId(id).check();
    await page.waitForTimeout(400);
    const configModules = await readConfig(page);
    check(
      '三模块 enable 已写入配置',
      Boolean(configModules.unirun && configModules.unirun.enabled) &&
        Boolean(configModules.club && configModules.club.enabled) &&
        Boolean(configModules.ek && configModules.ek.enabled),
      JSON.stringify({ u: configModules.unirun && configModules.unirun.enabled, c: configModules.club && configModules.club.enabled, e: configModules.ek && configModules.ek.enabled }),
    );
    await page.getByTestId('a3-refresh-account').click().catch(() => {});
    await page.getByTestId('a3-refresh-campus').click().catch(() => {});
    await page.waitForFunction(
      () => {
        const a = document.querySelector('[data-testid="a3-account"]');
        const c = document.querySelector('[data-testid="a3-campus"]');
        const okA = a && Array.from(a.options).some((o) => o.value);
        const okC = c && Array.from(c.options).some((o) => o.value);
        return okA && okC;
      },
      null,
      { timeout: 10000 },
    );
    const accountValue = await page.getByTestId('a3-account').evaluate((node) => Array.from(node.options).find((o) => o.value).value);
    const campusValue = await page.getByTestId('a3-campus').evaluate((node) => Array.from(node.options).find((o) => o.value).value);
    await page.getByTestId('a3-account').selectOption(accountValue);
    await page.getByTestId('a3-campus').selectOption(campusValue);
    await page.waitForTimeout(300);
    const configSelected = await readConfig(page);
    check('账号下拉选择已落盘', configSelected.accountId === accountValue, `accountId=${configSelected.accountId}`);
    check('校区下拉选择已落盘', configSelected.campusId === campusValue, `campusId=${configSelected.campusId}`);
    check(
      '真实执行前置条件已满足（无阻断）',
      /已满足/.test(String(await page.locator('#a3-prereq').textContent())),
      await page.locator('#a3-prereq').textContent(),
    );
    await clipShot(page, panel, 'desktop-smoke-03-modules-selected.png');

    // ── 3c) 真实执行：fake 写调用 > 0（关键防假成功）─
    const writesBeforeReal = await countWrites(page);
    await toggle.click();
    await page.waitForFunction(
      () => window.ctAPI.__fake.calls.some((c) => c.name === 'unirun.autoRun'),
      null,
      { timeout: 20000 },
    );
    await page.waitForTimeout(500);
    const writesAfterReal = await countWrites(page);
    check('真实执行 fake 写调用 > 0（非假成功）', writesAfterReal > writesBeforeReal, `before=${writesBeforeReal} after=${writesAfterReal}`);
    check('真实执行状态为「运行中（真实提交）」', /真实提交/.test(await statusText(page)), await statusText(page));
    const stateAfterReal = await page.evaluate(() => window.localStorage.getItem('auto3ct:state'));
    check('真实执行写入去重状态 auto3ct:state', /"done"/.test(String(stateAfterReal || '')), String(stateAfterReal).slice(0, 160));
    await clipShot(page, panel, 'desktop-smoke-04-real-run-fake.png');
    await toggle.click();
    await page.waitForTimeout(300);

    // ── 5a) 同日去重：再次真实启动不重复写 ──
    const autoRunBefore = await countCalls(page, 'unirun.autoRun');
    await toggle.click();
    await page.waitForTimeout(1500);
    const autoRunAfter = await countCalls(page, 'unirun.autoRun');
    check('同日去重：再次真实启动不重复 unirun.autoRun', autoRunBefore === autoRunAfter, `before=${autoRunBefore} after=${autoRunAfter}`);
    await toggle.click();
    await page.waitForTimeout(300);

    // ── 7b) 切回预览模式 ──
    await dryRun.check();
    await page.waitForTimeout(300);
    const configPreview = await readConfig(page);
    check('切回预览模式并同步引擎配置', configPreview.dryRun === true, JSON.stringify(configPreview.dryRun));

    // ── 5b) busy 防重：运行中按钮 disabled，第二次点击不再发起一轮 ──
    const roundsBefore = await roundsLogged(page);
    await page.getByTestId('a3-preview').click();
    const busyDisabled = await page
      .waitForFunction(() => document.querySelector('[data-testid="a3-preview"]').disabled, null, { timeout: 3000 })
      .then(() => true)
      .catch(() => false);
    check('运行中「立即预览」按钮被禁用（busy 状态可见）', busyDisabled);
    await page.getByTestId('a3-preview').evaluate((el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await page.waitForTimeout(1200);
    const roundsAfter = await roundsLogged(page);
    check('busy 期间重复点击只产生一轮调用', roundsAfter === roundsBefore + 1, `rounds ${roundsBefore}→${roundsAfter}`);
    const previewWrites = await countWrites(page);
    check('预览连点期间无写调用', previewWrites === writesAfterReal, `writes=${previewWrites}`);

    // ── 5c) 停止后：已发出请求结果仍记录，按钮恢复可用 ──
    const roundsBeforeStop = await roundsLogged(page);
    await toggle.click(); // 启动预览循环
    await page.waitForTimeout(120);
    await toggle.click(); // 立刻停止
    await page.waitForTimeout(1500);
    const roundsAfterStop = await roundsLogged(page);
    const logsAfterStop = (await getLogs(page)).join('\n');
    check('停止后飞行中的结果仍写入日志', roundsAfterStop > roundsBeforeStop, `rounds ${roundsBeforeStop}→${roundsAfterStop}`);
    check('停止日志存在', /已停止/.test(logsAfterStop), logsAfterStop.split('\n').slice(-2).join(' | '));
    check('停止后按钮恢复可用', (await page.getByTestId('a3-preview').isEnabled()) === true);
    check('停止后状态为未启动', (await statusText(page)) === '未启动', await statusText(page));

    // ── 7c) 配置保存：二课关键词 ──
    await page.getByTestId('a3-ek-keywords').fill('歌手,讲座');
    await page.getByTestId('a3-ek-keywords').dispatchEvent('change');
    await page.waitForTimeout(300);
    const configKeywords = await readConfig(page);
    check(
      'UI 保存二课关键词落盘',
      Array.isArray(configKeywords.ek && configKeywords.ek.keywords) && configKeywords.ek.keywords.includes('讲座'),
      JSON.stringify(configKeywords.ek || {}),
    );
    await clipShot(page, panel, 'desktop-smoke-05-config-saved.png');

    // ── 空关键词 + allowAll ──
    await page.getByTestId('a3-club-keywords').fill('');
    await page.getByTestId('a3-club-keywords').dispatchEvent('change');
    await page.getByTestId('a3-club-allow-all').check();
    await page.waitForTimeout(300);
    const configAllowAll = await readConfig(page);
    check(
      '空关键词 + allowAll 落盘',
      Array.isArray(configAllowAll.club && configAllowAll.club.keywords) &&
        configAllowAll.club.keywords.length === 0 &&
        configAllowAll.club.allowAll === true,
      JSON.stringify(configAllowAll.club || {}),
    );
    await clipShot(page, panel, 'desktop-smoke-06-allowall.png');

    // ── 6a) 面板宽度 480 与 label 可读性（近景截图人工复核）─
    const boxWide = await panel.boundingBox();
    check('面板宽度 480px（近景可读）', Math.abs(boxWide.width - 480) <= 2, `width=${boxWide.width}`);
    const labelMetrics = await page.locator('.a3-field-label').first().evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return { width: rect.width, height: rect.height, writingMode: getComputedStyle(node).writingMode };
    });
    check(
      'label 未被挤成三列（宽度充足、横向排版）',
      labelMetrics.width >= 60 && labelMetrics.height <= 80 && labelMetrics.writingMode === 'horizontal-tb',
      JSON.stringify(labelMetrics),
    );

    // ── 6b) 滚动到底：二维码延迟/重试/次数参数 ──
    const body = page.locator('.auto3ct-panel .a3-body');
    await body.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await page.waitForTimeout(300);
    const qrVisible = {};
    for (const text of ['二维码延迟（分钟）', '重试间隔（分钟）', '最多尝试次数']) {
      const loc = page.locator('.a3-field-label', { hasText: text }).first();
      qrVisible[text] = (await loc.count()) > 0 && (await loc.isVisible());
    }
    check('滚动后二维码参数可见（延迟/重试/次数）', Object.values(qrVisible).every(Boolean), JSON.stringify(qrVisible));
    await clipShot(page, panel, 'desktop-smoke-07-qr-params.png');
    await body.evaluate((node) => {
      node.scrollTop = 0;
    });

    // ── 6c) 窄屏：面板完整落在视口内（CSS 媒体查询实际用 100vw-16px 侧边距）─
    await page.setViewportSize({ width: 420, height: 900 });
    await page.waitForTimeout(300);
    const boxNarrow = await panel.boundingBox();
    const narrowFits = boxNarrow.x >= 0 && boxNarrow.x + boxNarrow.width <= 420 + 0.5;
    check(
      '窄屏下不超出视口',
      narrowFits,
      `x=${Math.round(boxNarrow.x)} width=${Math.round(boxNarrow.width)} viewport=420`,
    );
    info('窄屏面板宽度规格', `width=${Math.round(boxNarrow.width)}（CSS calc(100vw - 16px) 媒体查询）`);
    await clipShot(page, panel, 'desktop-smoke-08-narrow.png');
    await page.setViewportSize({ width: 1200, height: 1000 });
    await page.waitForTimeout(300);

    // ── 7d) 重开恢复：启动→reload 自动恢复运行；停止→reload 保持停止 ──
    await toggle.click();
    await waitStatusContains(page, '预览');
    await page.reload({ waitUntil: 'load' });
    await waitReady(page);
    const statusResumed = await statusText(page);
    check('重开恢复：上次启用则自动恢复运行', /预览|运行/.test(statusResumed), statusResumed);
    check('重开恢复：开关显示为已开启', String(await page.getByTestId('a3-start-stop').getAttribute('class')).includes('on'));
    await clipShot(page, panel, 'desktop-smoke-09-reopened-running.png');
    await toggle.click();
    await page.waitForFunction(
      () => document.getElementById('a3-status') && document.getElementById('a3-status').textContent.trim() === '未启动',
      null,
      { timeout: 10000 },
    );
    await page.reload({ waitUntil: 'load' });
    await waitReady(page);
    check('停止后重开保持「未启动」', (await statusText(page)) === '未启动', await statusText(page));
    await clipShot(page, panel, 'desktop-smoke-10-reopened-stopped.png');

    // ── 配置持久化（重开后仍保留）─
    const configReloaded = await readConfig(page);
    check(
      '重开后配置与模块开关保留',
      Array.isArray(configReloaded.ek && configReloaded.ek.keywords) &&
        configReloaded.ek.keywords.includes('讲座') &&
        configReloaded.unirun.enabled === true &&
        configReloaded.accountId === accountValue,
      JSON.stringify({ ek: configReloaded.ek && configReloaded.ek.keywords, accountId: configReloaded.accountId }),
    );

    // ── 脱敏：状态页只显示脱敏账号 ──
    await page.locator('.a3-tab', { hasText: '状态' }).click();
    await page.waitForTimeout(400);
    const stateText = await page.locator('.a3-pre').first().textContent();
    const stateHtml = await panel.innerHTML();
    check('状态页显示脱敏手机号', String(stateText || '').includes('138****0000'), stateText);
    check('页面不含完整手机号', !String(stateHtml || '').includes('13800000000'));
    check('页面不含密码/token 明文', !String(stateHtml || '').includes('fake-pw') && !String(stateHtml || '').includes('fake-access-token'));
    await clipShot(page, panel, 'desktop-smoke-11-state-masked.png');

    check('全程无外部网络请求', externalRequests.length === 0, externalRequests.join(' | ') || '0 external requests');
    check('全程无页面 JS 异常', pageErrors.length === 0, pageErrors.join(' | '));
    check('页面无 console.error', consoleErrors.length === 0, consoleErrors.join(' | '));

    const summary = {
      startedAt,
      finishedAt: new Date().toISOString(),
      source: SMOKE_SOURCE,
      packagedInfo,
      edge,
      userDataDir,
      harness: origin + HARNESS_PATH,
      checks,
      passed: checks.filter((c) => c.kind === 'assert' && c.ok).length,
      failed: checks.filter((c) => c.kind === 'assert' && !c.ok).length,
      externalRequests,
      pageErrors,
      consoleErrors,
      screenshots: fs
        .readdirSync(ARTIFACTS)
        .filter((name) => name.startsWith(SHOT_PREFIX) && name.endsWith('.png'))
        .sort(),
    };
    await fsp.writeFile(RESULT_JSON, JSON.stringify(summary, null, 2) + '\n', 'utf8');
    console.log(`\n结果：${summary.passed} passed / ${summary.failed} failed → ${RESULT_JSON}`);
    if (summary.failed > 0) process.exitCode = 1;
  } catch (err) {
    const failure = {
      at: new Date().toISOString(),
      error: String(err && err.stack ? err.stack : err),
      url: page ? page.url() : '',
      pageErrors,
      consoleErrors,
      checks,
    };
    await fsp.writeFile(FAILURE_JSON, JSON.stringify(failure, null, 2) + '\n', 'utf8').catch(() => {});
    throw err;
  } finally {
    if (context) await context.close().catch(() => {});
    server.close();
    await fsp.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  console.error('烟测异常终止：', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
