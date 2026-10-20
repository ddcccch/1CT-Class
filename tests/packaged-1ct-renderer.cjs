/**
 * 1CT 打包 renderer 离线冒烟（不启动 Electron，不碰用户进程/profile）。
 *
 * 做法：把打包后 app.asar 里的 dist/renderer/** 原样解到临时目录，用本机
 * Chromium（playwright-core）以 file:// 打开 index.html，注入最小 fake ctAPI，
 * 断言：
 *  - 只加载 1CT 资源（不加载 panel/dashboard/renderer.js）；
 *  - window.OneCTMembers / OneCTStats 存在，原版 auto3ct 全局不存在；
 *  - 1CT shell 渲染出四大 tab（极简白：背景 rgb(255,255,255)）；
 *  - tab 可切换、成员可增删（写入 1ct:members）、统计有数。
 *
 * 运行：node tests/packaged-1ct-renderer.cjs
 * 产出：artifacts/1ct/packaged-renderer-result.json + 截图
 */
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const PLAYWRIGHT_CORE =
  process.env.PLAYWRIGHT_CORE ||
  'C:/Users/<user>/.workbuddy/binaries/node/workspace/node_modules/playwright-core';
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'artifacts');
const RESULT_JSON = path.join(OUT, '1ct-packaged-renderer-result.json');
const ASAR = path.join(ROOT, '1CT', 'resources', 'app.asar');

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail: detail === undefined ? '' : String(detail) });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' :: ' + detail : ''}`);
}

// ---- 极简 ASAR 读取（只用 header 里 files/size/offset，不依赖第三方包） ----
function readAsarHeader(archive) {
  const fd = fs.openSync(archive, 'r');
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const magic = head.readUInt32LE(0);
    const headerSize = head.readUInt32LE(4);
    const jsonLen = head.readUInt32LE(12);
    if (magic !== 4) throw new Error('bad asar magic: ' + magic);
    const json = Buffer.alloc(jsonLen);
    fs.readSync(fd, json, 0, jsonLen, 16);
    return { header: JSON.parse(json.toString('utf8')), dataBase: 8 + headerSize };
  } finally {
    fs.closeSync(fd);
  }
}

function extractSubtree(archive, header, dataBase, outDir, prefix) {
  const fd = fs.openSync(archive, 'r');
  const written = [];
  try {
    const walk = (node, rel) => {
      for (const [name, child] of Object.entries(node.files || {})) {
        const childRel = rel + name;
        if (child.files) {
          walk(child, childRel + '/');
          continue;
        }
        if (!childRel.startsWith(prefix)) continue;
        const size = Number(child.size || 0);
        const offset = Number(child.offset || 0);
        const buf = Buffer.alloc(size);
        if (size > 0) fs.readSync(fd, buf, 0, size, dataBase + offset);
        const target = path.join(outDir, ...childRel.split('/'));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, buf);
        written.push(childRel);
      }
    };
    walk(header, '');
  } finally {
    fs.closeSync(fd);
  }
  return written;
}

// ---- 浏览器：优先 playwright 自带 chromium，缺浏览器时回落系统 Edge/Chrome ----
const SYSTEM_BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];

async function launchBrowser(playwright) {
  const attempts = [];
  try {
    return await playwright.chromium.launch({ headless: true });
  } catch (err) {
    attempts.push('bundled: ' + String(err && err.message ? err.message : err).split('\n')[0]);
  }
  for (const channel of ['msedge', 'chrome']) {
    try {
      return await playwright.chromium.launch({ headless: true, channel });
    } catch (err) {
      attempts.push(channel + ': ' + String(err && err.message ? err.message : err).split('\n')[0]);
    }
  }
  for (const exe of SYSTEM_BROWSERS) {
    if (!fs.existsSync(exe)) continue;
    try {
      return await playwright.chromium.launch({ headless: true, executablePath: exe });
    } catch (err) {
      attempts.push(exe + ': ' + String(err && err.message ? err.message : err).split('\n')[0]);
    }
  }
  throw new Error('没有可用的 Chromium/Edge 浏览器:\n  ' + attempts.join('\n  '));
}

async function main() {
  await fsp.mkdir(OUT, { recursive: true });
  if (!fs.existsSync(ASAR)) throw new Error('先构建 1CT：python desktop/install_1ct.py build');
  const playwright = require(PLAYWRIGHT_CORE);

  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), '1ct-renderer-'));
  const result = { checks, asar: ASAR, extracted: [] };
  let browser = null;
  try {
    const { header, dataBase } = readAsarHeader(ASAR);
    result.extracted = extractSubtree(ASAR, header, dataBase, tmp, 'dist/renderer/');
    check('从 app.asar 解出 renderer 资源', result.extracted.length > 0, result.extracted.length + ' files');
    for (const want of [
      'dist/renderer/index.html',
      'dist/renderer/1ct/shell.js',
      'dist/renderer/1ct/shell.css',
      'dist/renderer/1ct/members.js',
      'dist/renderer/1ct/ek-stats.js',
      'dist/renderer/1ct/ek-stats.css',
      'dist/renderer/jsQR.js',
      'dist/renderer/score-policy.js',
      'dist/renderer/result-store.js',
      'dist/renderer/automation.js',
    ]) {
      check('asar 内含 ' + want, result.extracted.includes(want));
    }
    for (const legacy of [
      'dist/renderer/panel.js',
      'dist/renderer/panel.css',
      'dist/renderer/dashboard.js',
      'dist/renderer/dashboard.css',
    ]) {
      check('asar 内不含 ' + legacy, !result.extracted.includes(legacy));
    }

    browser = await launchBrowser(playwright);
    const context = await browser.newContext();
    // 只放行 file://（本地 origin）；任何 http/https/ws 请求都记为违规并阻断。
    const external = [];
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (!url.startsWith('file:') && !url.startsWith('data:') && !url.startsWith('blob:')) {
        external.push(url);
        return route.abort();
      }
      return route.continue();
    });
    // 记录所有请求与页面错误，证明 index.html 只引 1CT 资源
    const requested = [];
    const errors = [];
    const page = await context.newPage();
    page.on('request', (req) => requested.push(req.url()));
    page.on('pageerror', (err) => errors.push(String(err && err.message ? err.message : err)));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push('console: ' + msg.text());
    });

    const indexUrl = 'file:///' + path.join(tmp, 'dist/renderer/index.html').replace(/\\/g, '/');
    await page.goto(indexUrl, { waitUntil: 'load' });

    result.requests = requested.map((u) => u.replace(/^file:\/\/\//, '').split('/').pop());
    check(
      'index.html 未请求 panel/dashboard/renderer',
      !requested.some((u) => /(panel|dashboard|renderer\.js|style\.css)/.test(u)),
      result.requests.join(',')
    );
    for (const want of ['index.html', 'shell.js', 'shell.css', 'members.js', 'ek-stats.js', 'ek-stats.css', 'jsQR.js']) {
      check('浏览器实际加载 ' + want, requested.some((u) => u.endsWith(want)));
    }

    const globals = await page.evaluate(() => ({
      members: Boolean(window.OneCTMembers),
      stats: Boolean(window.OneCTStats),
      automation: Boolean(window.Auto3CTAutomation),
      scorePolicy: Boolean(window.Auto3CTScorePolicy),
      results: Boolean(window.Auto3CTResults || window.Auto3CTResultStore),
      legacyPanel: Boolean(window.Auto3CTPanel),
      legacyDashboard: Boolean(window.Auto3CTDashboard),
    }));
    result.globals = globals;
    check('window.OneCTMembers 已加载', globals.members);
    check('window.OneCTStats 已加载', globals.stats);
    check('window.Auto3CTAutomation 已加载', globals.automation);
    check('window.Auto3CTScorePolicy 已加载', globals.scorePolicy);
    check('window.Auto3CTResults 已加载', globals.results);
    check('原版 panel/dashboard 全局不存在', !globals.legacyPanel && !globals.legacyDashboard, JSON.stringify(globals));

    const ui = await page.evaluate(() => {
      const app = document.querySelector('[data-testid="one-ct-app"]');
      const root = document.getElementById('one-ct-root');
      const tabs = [...document.querySelectorAll('[data-testid^="one-ct-tab-"]')].map((el) => ({
        id: el.getAttribute('data-testid'),
        text: String(el.textContent || '').trim(),
      }));
      const style = getComputedStyle(document.body);
      return {
        hasRoot: Boolean(app),
        rootChildren: app ? app.childElementCount : 0,
        // Lead 要求：防“DOM 空”回归（真实界面渲染后远大于 20）
        rootInnerNodes: root ? root.querySelectorAll('*').length : 0,
        appCount: document.querySelectorAll('[data-testid="one-ct-app"]').length,
        classAppCount: document.querySelectorAll('.one-ct-app').length,
        readyFlag: window.__ONE_CT_READY__ === true,
        tabs,
        bodyBg: style.backgroundColor,
        title: document.title,
        nodeCount: document.querySelectorAll('*').length,
      };
    });
    result.ui = ui;
    check('1CT shell 渲染进 DOM', ui.hasRoot && ui.rootChildren > 0, JSON.stringify(ui).slice(0, 240));
    check('页面标题是 1CT', ui.title.trim() === '1CT', ui.title);
    check('window.__ONE_CT_READY__ === true', ui.readyFlag === true, String(ui.readyFlag));
    check(
      '五个 tab 齐备（run/members/ek/records/logs）',
      ui.tabs.length === 5 &&
        ['run', 'members', 'ek', 'records', 'logs'].every((k) => ui.tabs.some((t) => t.id === 'one-ct-tab-' + k)),
      JSON.stringify(ui.tabs)
    );
    check('#one-ct-root 内节点数 > 20（防 DOM 空回归）', ui.rootInnerNodes > 20, `nodes=${ui.rootInnerNodes}`);
    check(
      'one-ct-app 唯一（无双重挂载）',
      ui.appCount === 1 && ui.classAppCount === 1,
      `data-testid=${ui.appCount}, class=${ui.classAppCount}`
    );
    check('极简白：body 背景白色', ui.bodyBg === 'rgb(255, 255, 255)', ui.bodyBg);
    await page.screenshot({ path: path.join(OUT, '1ct-packaged-01-run.png') });

    // ---- 注入 fake ctAPI 与 3 名成员（只写临时 profile 的 localStorage），
    //      断言成员页至少渲染 3 行 ----
    const seeded = await page.evaluate(() => {
      const now = Date.now();
      const members = [1, 2, 3].map((i) => ({
        id: 'm_smoke000' + i,
        name: ['张三', '李四', '王五'][i - 1],
        note: 'packaged smoke',
        enabled: i !== 3,
        ek: null,
        unirun: { id: 'u' + i, phone: '1380000000' + i, password: 'x', remark: '' },
        ekModules: null,
        createdAt: now,
        updatedAt: now,
      }));
      localStorage.setItem(
        '1ct:members',
        JSON.stringify({ version: 1, selectedId: members[0].id, items: members })
      );
      localStorage.setItem('1ct:config:global', JSON.stringify({ dryRun: true }));
      // fake ctAPI：只读桩，绝不发起真实业务请求
      const noop = () => Promise.resolve(null);
      window.ctAPI = {
        ek: {
          login: noop, logout: noop, status: noop, scores: noop, getScores: noop,
          listActivities: noop, list: noop, signIn: noop, signOut: noop,
        },
        unirun: { login: noop, sessionEnsure: noop, runOnce: noop, status: noop, plan: noop },
        club: { list: noop, join: noop, signIn: noop, signOut: noop },
        app: { getVersion: noop, onUpdate: noop },
      };
      if (window.OneCTShell && typeof window.OneCTShell.refresh === 'function') {
        window.OneCTShell.refresh();
      }
      return { count: window.OneCTMembers.load().items.length };
    });
    result.seeded = seeded;
    check('注入 3 名成员到 1ct:members', seeded.count === 3, JSON.stringify(seeded));

    await page.locator('[data-testid="one-ct-tab-members"]').click({ timeout: 8000 });
    await page.waitForTimeout(800);
    const memberRows = await page.evaluate(() => {
      const counters = [
        '[data-testid="one-ct-member-row"]',
        '[data-testid^="one-ct-member-row-"]',
        '[data-testid="one-ct-members-list"] > *',
        '.one-ct-member-row',
        '.one-ct-member-list > *',
      ];
      const counts = {};
      for (const sel of counters) counts[sel] = document.querySelectorAll(sel).length;
      const view = document.querySelector('[data-testid="one-ct-members-view"]') || document.body;
      const text = String(view.textContent || '');
      return {
        counts,
        names: ['张三', '李四', '王五'].filter((n) => text.includes(n)),
        visibleRows: Math.max(0, ...Object.values(counts)),
        viewTextLength: text.trim().length,
      };
    });
    result.memberRows = memberRows;
    check(
      '成员页至少渲染 3 行（3 名成员）',
      memberRows.visibleRows >= 3,
      JSON.stringify(memberRows).slice(0, 320)
    );
    check('成员页显示三名成员姓名', memberRows.names.length === 3, JSON.stringify(memberRows.names));
    await page.screenshot({ path: path.join(OUT, '1ct-packaged-02-members.png') });

    // 切 tab（只读）
    const visiblePanels = [];
    for (const tab of ui.tabs) {
      const ok = await page
        .locator(`[data-testid="${tab.id}"]`)
        .first()
        .click({ timeout: 6000 })
        .then(() => true)
        .catch(() => false);
      if (!ok) continue;
      await page.waitForTimeout(450);
      const snapshot = await page.evaluate(() => {
        const view = document.querySelector('[data-testid^="one-ct-"][data-testid$="-view"]');
        const visible = [...document.querySelectorAll('[data-testid^="one-ct-"][data-testid$="-view"]')]
          .filter((el) => el.getBoundingClientRect().width > 0)
          .map((el) => el.getAttribute('data-testid'));
        return {
          visible,
          viewNodes: view ? view.querySelectorAll('*').length : 0,
          hash: location.hash,
        };
      });
      visiblePanels.push({ tab: tab.text, ...snapshot });
      const slug = String(tab.text || 'tab').replace(/[^\p{L}\p{N}-]/gu, '') || 'tab';
      await page.screenshot({ path: path.join(OUT, `1ct-packaged-tab-${slug}.png`) });
    }
    result.visiblePanels = visiblePanels;
    check(
      '每个 tab 切换后都有可见面板',
      visiblePanels.length === 5 && visiblePanels.every((p) => p.visible.length > 0),
      JSON.stringify(visiblePanels)
    );
    check(
      '每个 tab 内容区非空（view 内节点 > 3）',
      visiblePanels.every((p) => p.viewNodes > 3),
      JSON.stringify(visiblePanels.map((p) => [p.tab, p.viewNodes]))
    );

    // 成员页：新增一个成员，验证 members 层与统计层串起来（只写 localStorage 测试 profile）
    const memberFlow = await page.evaluate(() => {
      if (!window.OneCTMembers) return { skipped: true };
      const before = window.OneCTMembers.load().items.length;
      let created = null;
      try {
        created = window.OneCTMembers.upsertMember({
          name: '冒烟测试成员',
          note: 'packaged-renderer 自动创建',
          enabled: true,
          ek: null,
          unirun: null,
          ekModules: null,
        });
      } catch (e) {
        return { before, error: String(e && e.message ? e.message : e) };
      }
      const after = window.OneCTMembers.load().items.length;
      const stat = window.OneCTStats && created
        ? window.OneCTStats.build({ member: window.OneCTMembers.getMember(created.id), events: [], scoreEntry: {} })
        : null;
      if (created) window.OneCTMembers.removeMember(created.id);
      return {
        before,
        after,
        createdId: created && created.id,
        statKeys: stat ? Object.keys(stat).sort() : null,
        signIn: stat ? stat.signIn : null,
      };
    });
    result.memberFlow = memberFlow;
    check('成员可新增（1ct:members 落库）', !memberFlow.error && memberFlow.after === memberFlow.before + 1, JSON.stringify(memberFlow).slice(0, 240));
    check('统计层可对成员出数', Boolean(memberFlow.statKeys && memberFlow.statKeys.includes('modules')), JSON.stringify(memberFlow.statKeys));

    check('无页面脚本错误', errors.length === 0, errors.slice(0, 3).join(' | '));
    check('无外部网络请求（只加载本地 asar 资源）', external.length === 0, external.slice(0, 3).join(' | '));
    result.errors = errors;
    result.externalRequests = external;
    result.ok = checks.every((c) => c.ok);
  } finally {
    if (browser) await browser.close().catch(() => {});
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    result.finishedAt = new Date().toISOString();
    result.passed = checks.filter((c) => c.ok).length;
    result.failed = checks.filter((c) => !c.ok).length;
    await fsp.writeFile(RESULT_JSON, JSON.stringify(result, null, 2) + '\n', 'utf8').catch(() => {});
  }
  console.log(`\n结果：${result.passed} passed / ${result.failed} failed → ${RESULT_JSON}`);
  if (result.failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('packaged renderer 冒烟异常终止：', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
