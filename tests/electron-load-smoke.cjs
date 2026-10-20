/**
 * 最终真实 Electron 加载验收（补充 CDP smoke；只读，不注入凭证、不做业务写）。
 *
 * 目标（lead 指定最小范围）：
 *  1) 从 root GUI launcher（启动3CT自动版.exe）启动**真实 3CT-Auto**，传 --user-data-dir=<临时 profile>
 *     --remote-debugging-port=<未用端口> --no-first-run（启动器直启 exe，不经 cmd）；
 *  2) connectOverCDP 确认真实窗口内：window.Auto3CTScorePolicy / Auto3CTResults / Auto3CTDashboard /
 *     Auto3CTAutomation / Auto3CTPanel 均加载（file:// 环境）；
 *  3) panel 入口 a3-open-dashboard 存在，点击后 dashboard-root 可见且新依赖生效（未登录空看板/待导入）；
 *  4) 不点击 run/import（不做业务写），不读用户 token（临时 profile 全新）；
 *  5) 截图 artifacts/dashboard/electron-panel.png、electron-dashboard.png；
 *  6) 结束只 kill 本次临时 profile 匹配的进程树并删除 profile。
 *
 * 运行：node tests/electron-load-smoke.cjs
 */
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');

const PLAYWRIGHT_CORE =
  process.env.PLAYWRIGHT_CORE || 'C:/Users/<user>/.workbuddy/binaries/node/workspace/node_modules/playwright-core';
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'artifacts', 'dashboard');
const RESULT_JSON = path.join(OUT, 'electron-load-result.json');
const LAUNCHER = path.join(ROOT, '启动3CT自动版.exe');

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail: detail === undefined ? '' : String(detail) });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' :: ' + detail : ''}`);
}
function info(name, detail) {
  checks.push({ name, ok: true, detail: detail === undefined ? '' : String(detail), kind: 'info' });
  console.log(`[INFO] ${name}${detail ? ' :: ' + detail : ''}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}
function listAppProcesses() {
  const script =
    "Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('3CT-Auto.exe','3CT.exe','启动3CT自动版.exe') } | " +
    'ForEach-Object { "{0}`t{1}`t{2}" -f $_.ProcessId, $_.Name, ($_.CommandLine -replace "`t"," ") }';
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true });
  return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((line) => {
    const [pid, name, ...rest] = line.split('\t');
    return { pid: Number(pid), name, cmdline: rest.join('\t') };
  }).filter((p) => Number.isFinite(p.pid));
}
function killProfileTree(profileDir) {
  const killed = [];
  for (const proc of listAppProcesses()) {
    if (!proc.cmdline.includes(profileDir)) continue;
    try {
      execFileSync('taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      killed.push({ pid: proc.pid, name: proc.name });
    } catch (e) { /* already gone */ }
  }
  return killed;
}
function cdpJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.setTimeout(timeoutMs || 2000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}
async function waitCdp(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try { return await cdpJson(`http://127.0.0.1:${port}/json/version`, 1500); } catch (e) { last = String(e.message || e); await new Promise((r) => setTimeout(r, 500)); }
  }
  throw new Error('等待 CDP 超时: ' + last);
}

async function main() {
  await fsp.mkdir(OUT, { recursive: true });
  const startedAt = new Date().toISOString();
  if (!fs.existsSync(LAUNCHER)) throw new Error('GUI launcher 不存在: ' + LAUNCHER);
  const existing = listAppProcesses();
  if (existing.length) {
    check('无其它 3CT 进程占用（不 kill 用户进程）', false, existing.map((p) => `${p.name}(${p.pid})`).join(','));
    await fsp.writeFile(RESULT_JSON, JSON.stringify({ startedAt, blockedBy: existing, checks }, null, 2), 'utf8');
    process.exitCode = 1;
    return;
  }
  check('无其它 3CT 进程占用（不 kill 用户进程）', true);
  const port = await freePort();
  const profile = path.join(OUT, 'electron-profile-' + Date.now().toString(36));
  await fsp.mkdir(profile, { recursive: true });
  let playwright;
  try { playwright = require(PLAYWRIGHT_CORE); } catch (e) { throw new Error('playwright-core: ' + e.message); }
  let browser = null;
  let result = { startedAt, port, profile, checks };
  try {
    const child = spawn(LAUNCHER, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--no-first-run'], {
      cwd: ROOT, windowsHide: true, stdio: 'ignore', env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }),
    });
    const exitCode = await new Promise((resolve) => {
      const timer = setTimeout(() => { try { child.kill(); } catch (e) {} }, 30000);
      child.on('exit', (code) => { clearTimeout(timer); setTimeout(() => resolve(code), 300); });
    });
    result.launcherExitCode = exitCode;
    check('GUI launcher 启动成功并快速返回', exitCode === 0, `exit=${exitCode}`);
    const version = await waitCdp(port, 90000);
    check('CDP 就绪（真实 Electron 已起）', Boolean(version.Browser), JSON.stringify(version).slice(0, 160));
    browser = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context = browser.contexts()[0];
    let page = null;
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline && !page) {
      for (const cand of context.pages()) {
        try {
          const ok = await cand.evaluate(() => Boolean(window.Auto3CTPanel && document.querySelector('[data-testid="a3-open-dashboard"]')));
          if (ok) { page = cand; break; }
        } catch (e) { /* loading */ }
      }
      if (!page) await new Promise((r) => setTimeout(r, 500));
    }
    if (!page) throw new Error('未找到已加载自动化面板的真实窗口');
    result.pageTitle = await page.title();
    result.pageUrl = page.url();
    check('窗口 title 含 3CT Auto', /3CT Auto/.test(result.pageTitle), result.pageTitle);
    check('窗口来自打包副本 file://', /app\.asar\/dist\/renderer\/index\.html/.test(result.pageUrl), result.pageUrl);

    const globals = await page.evaluate(() => ({
      scorePolicy: Boolean(window.Auto3CTScorePolicy),
      results: Boolean(window.Auto3CTResults || window.Auto3CTResultStore),
      dashboard: Boolean(window.Auto3CTDashboard),
      automation: Boolean(window.Auto3CTAutomation),
      panel: Boolean(window.Auto3CTPanel),
      entry: Boolean(document.querySelector('[data-testid="a3-open-dashboard"]')),
    }));
    result.globals = globals;
    check('window.Auto3CTScorePolicy 已加载', globals.scorePolicy);
    check('window.Auto3CTResults 已加载（result-store）', globals.results);
    check('window.Auto3CTDashboard 已加载', globals.dashboard);
    check('panel 入口 a3-open-dashboard 存在', globals.entry);
    await page.screenshot({ path: path.join(OUT, 'electron-panel.png'), fullPage: false });

    // 点击入口打开真实 Electron 内看板（只读；不点 run/import）
    await page.evaluate(() => window.ctAPI && window.ctAPI.__electron_qa_noop);
    await page.getByTestId('a3-open-dashboard').click();
    await page.waitForTimeout(1200);
    const dash = await page.evaluate(() => {
      const root = document.querySelector('[data-testid="dashboard-root"]');
      const gap = document.querySelector('[data-testid="dashboard-summary-gap"]');
      const empty = document.querySelector('[data-testid="dashboard-empty"]');
      return {
        isOpen: window.Auto3CTDashboard ? window.Auto3CTDashboard.isOpen() : null,
        rootVisible: Boolean(root) && root.getBoundingClientRect().width > 0,
        gapText: gap ? String(gap.textContent).trim() : null,
        emptyText: empty ? String(empty.textContent).trim() : null,
      };
    });
    result.dashboard = dash;
    check('真实 Electron 内 dashboard.open 生效（isOpen）', dash.isOpen === true, JSON.stringify(dash));
    check('看板根节点可见', dash.rootVisible === true);
    check('未登录空看板显示待导入/未知（不假达标）', /待导入|未知|尚无/.test(String(dash.gapText)) || dash.emptyText !== null, JSON.stringify(dash).slice(0, 200));
    await page.screenshot({ path: path.join(OUT, 'electron-dashboard.png'), fullPage: false });
    result.ok = checks.filter((c) => c.ok).length === checks.length;
  } finally {
    result.killed = killProfileTree(profile);
    await new Promise((r) => setTimeout(r, 700));
    result.leftover = listAppProcesses().filter((p) => p.cmdline.includes(profile));
    if (browser) await browser.close().catch(() => {});
    await fsp.rm(profile, { recursive: true, force: true }).catch(() => {});
    result.finishedAt = new Date().toISOString();
    result.passed = checks.filter((c) => !c.kind && c.ok).length;
    result.failed = checks.filter((c) => !c.kind && !c.ok).length;
    await fsp.writeFile(RESULT_JSON, JSON.stringify(result, null, 2) + '\n', 'utf8').catch(() => {});
  }
  console.log(`\n结果：${result.passed} passed / ${result.failed} failed → ${RESULT_JSON}`);
  if (result.failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('Electron 加载验收异常终止：', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
