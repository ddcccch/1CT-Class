/**
 * 1CT 校园跑「校区库」迁移实测（真实 Electron + 真实 userData，可重复运行）
 *
 * 背景：`desktop/1ct/bootstrap-1ct.cjs` 的 1b 段会在独立 userData 首次启动时
 * 把 `%APPDATA%\3CT\unirun`（校区库 + maps）复制到 `%APPDATA%\1CT\unirun`。
 * 不迁移 → `campusLocalList()` 恒为空 → 引擎 `no-campus` → 校园跑一次都提交不出去。
 *
 * 这个脚本验证的就是「真实装出来的 1CT 到底能不能读到校区」：
 *   1) 用真实 userData 启动打包好的 1CT（不传 --user-data-dir，走 independent 分支）；
 *   2) 通过 CDP 在渲染层调 `ctAPI.unirun.campusLocalList()` 与 `generateTrack()`，
 *      这才是引擎真正走的路径；
 *   3) 断言返回的校区、地图文件名与 `%APPDATA%\3CT\unirun` 一致；
 *   4) 额外做一次「删掉目标再启动」的重演：证明迁移可重复触发，且地图能真被读出。
 *
 * 注意：Electron 在 Windows 上用 SHGetKnownFolderPath 取 appData，**不看 APPDATA 环境变量**，
 * 所以这里不能用临时 APPDATA 隔离 —— 用备份/恢复来保证可回滚。
 *
 * 运行：node tests/1ct-migration-smoke.cjs [--target dist/1CT-1.2.3]
 */
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');

const PLAYWRIGHT_CORE =
  process.env.PLAYWRIGHT_CORE ||
  [
    path.join(__dirname, '..', 'node_modules', 'playwright-core'),
    path.join(os.homedir(), '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules', 'playwright-core'),
  ].find((p) => { try { return fs.existsSync(p); } catch (e) { return false; } }) ||
  'playwright-core';

const ROOT = path.resolve(__dirname, '..');
function parseTarget(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--target') return path.resolve(argv[i + 1]);
    if (argv[i].startsWith('--target=')) return path.resolve(argv[i].slice(9));
  }
  return path.join(ROOT, 'dist', '1CT-1.2.3');
}
const TARGET_DIR = parseTarget(process.argv.slice(2));
const LAUNCHER = path.join(TARGET_DIR, '启动1CT.exe');
const OUT = path.join(ROOT, 'artifacts');
const RESULT_JSON = path.join(OUT, '1ct-migration-smoke-result.json');

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail: detail === undefined ? '' : String(detail) });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' :: ' + detail : ''}`);
}
function info(name, detail) {
  checks.push({ name, ok: true, detail: detail === undefined ? '' : String(detail), kind: 'info' });
  console.log(`[INFO] ${name}${detail ? ' :: ' + detail : ''}`);
}

const APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const SRC_ROOT = path.join(APPDATA, '3CT', 'unirun');
const DST_ROOT = path.join(APPDATA, '1CT', 'unirun');

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
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
    "Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('1CT.exe','启动1CT.exe') } | " +
    'ForEach-Object { "{0}`t{1}`t{2}" -f $_.ProcessId, $_.Name, ($_.CommandLine -replace "`t"," ") }';
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [pid, name, ...rest] = line.split('\t');
      return { pid: Number(pid), name, cmdline: rest.join('\t') };
    })
    .filter((p) => Number.isFinite(p.pid));
}

function killByMarker(marker) {
  const killed = [];
  for (const proc of listAppProcesses()) {
    if (!proc.cmdline.includes(marker)) continue;
    try {
      execFileSync('taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      killed.push(proc.pid);
    } catch (e) { /* gone */ }
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
    try {
      return await cdpJson(`http://127.0.0.1:${port}/json/version`, 1500);
    } catch (e) {
      last = String(e.message || e);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error('等待 CDP 超时: ' + last);
}

/** 启动打包后的 1CT（真实 userData），返回渲染层探针结果。 */
async function probeRunningApp() {
  const port = await freePort();
  const marker = '--remote-debugging-port=' + port;
  const child = spawn(LAUNCHER, [marker, '--no-first-run'], {
    cwd: TARGET_DIR,
    windowsHide: true,
    stdio: 'ignore',
    env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '' }),
  });
  let browser = null;
  try {
    await waitCdp(port, 45000);
    const { chromium } = require(PLAYWRIGHT_CORE);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const ctx = browser.contexts()[0];
    let page = ctx.pages().find((p) => !p.url().startsWith('devtools://'));
    if (!page) page = await ctx.waitForEvent('page', { timeout: 20000 });
    await page.waitForFunction(() => window.__ONE_CT_READY__ === true, { timeout: 30000 });

    const raw = await page.evaluate(async () => {
      const u = window.ctAPI && window.ctAPI.unirun;
      const out = {
        apis: ['campusLocalList', 'campusCloudList', 'campusCloudPull', 'autoRun', 'generateTrack']
          .reduce((acc, k) => { acc[k] = typeof (u && u[k]) === 'function'; return acc; }, {}),
        error: null,
        campuses: null,
        track: null,
      };
      try {
        const list = await u.campusLocalList();
        out.campuses = Array.isArray(list) ? list.map((c) => ({ id: c.id, label: c.label, mapName: c.mapName, schoolSiteIndex: c.schoolSiteIndex })) : list;
      } catch (e) { out.error = 'campusLocalList: ' + ((e && e.message) || e); }
      return out;
    });

    // 真跑一次轨迹生成：这是 autoRun 提交前主进程必做的步骤，mapName 无效就会抛错。
    if (raw.campuses && raw.campuses.length) {
      const first = raw.campuses[0];
      raw.track = await page.evaluate(async (payload) => {
        try {
          const t = await window.ctAPI.unirun.generateTrack({
            mapName: payload.mapName,
            distanceMeters: 1100,
            runTime: 16,
          });
          const text = typeof t === 'string' ? t : JSON.stringify(t);
          return { ok: true, length: text.length, head: text.slice(0, 60) };
        } catch (e) {
          return { ok: false, error: String((e && e.message) || e) };
        }
      }, { mapName: first.mapName });
    }
    return raw;
  } finally {
    try { if (browser) await browser.close(); } catch (e) { /* ignore */ }
    killByMarker(marker);
    try { child.kill(); } catch (e) { /* ignore */ }
  }
}

async function main() {
  await fsp.mkdir(OUT, { recursive: true });
  if (!fs.existsSync(LAUNCHER)) throw new Error('启动器不存在: ' + LAUNCHER);
  if (!fs.existsSync(SRC_ROOT)) throw new Error('本机没有 3CT 校区库，无法验证迁移: ' + SRC_ROOT);

  const srcDb = path.join(SRC_ROOT, 'localdb.v1.json');
  const srcMapDir = path.join(SRC_ROOT, 'maps');
  const srcMaps = fs.existsSync(srcMapDir) ? fs.readdirSync(srcMapDir) : [];
  info('源校区库', `${srcDb} (${fs.statSync(srcDb).size} B, sha ${sha256File(srcDb).slice(0, 16)})`);
  info('源地图', srcMaps.join(',') || '(空)');

  const existing = listAppProcesses();
  check('无 1CT 进程占用（不 kill 用户进程）', existing.length === 0, existing.map((p) => `${p.name}(${p.pid})`).join(','));

  // ── 第一轮：迁移已经发生过的真实状态 ──
  const run1 = await probeRunningApp();
  check('渲染层 unirun 接口齐全', Object.values(run1.apis || {}).every(Boolean), JSON.stringify(run1.apis));
  check('campusLocalList 在真实进程里能读出校区', Array.isArray(run1.campuses) && run1.campuses.length > 0, JSON.stringify(run1.campuses));
  const dstDb = path.join(DST_ROOT, 'localdb.v1.json');
  check('1CT\\unirun\\localdb.v1.json 已迁移', fs.existsSync(dstDb), dstDb);
  if (fs.existsSync(dstDb)) {
    check('校区库与 3CT 源字节一致', sha256File(srcDb) === sha256File(dstDb), sha256File(dstDb).slice(0, 16));
  }
  const dstMaps = path.join(DST_ROOT, 'maps');
  check('maps 全部已复制', srcMaps.length > 0 && srcMaps.every((n) => fs.existsSync(path.join(dstMaps, n))), srcMaps.join(','));
  check('generateTrack 用迁移来的地图能真跑出轨迹', Boolean(run1.track && run1.track.ok), JSON.stringify(run1.track));

  // ── 第二轮：模拟「新装机器」——把目标挪走，重启后应重新迁移 ──
  const backup = DST_ROOT + '.bak-smoke-' + Date.now().toString(36);
  let replay = null;
  try {
    await fsp.rename(DST_ROOT, backup);
    check('已把 1CT\\unirun 临时移走（模拟首次启动）', !fs.existsSync(DST_ROOT), backup);
    replay = await probeRunningApp();
    check('首次启动后自动迁移回来了', fs.existsSync(dstDb), dstDb);
    if (fs.existsSync(dstDb)) {
      check('重演的校区库字节一致', sha256File(srcDb) === sha256File(dstDb), sha256File(dstDb).slice(0, 16));
    }
    check('重演后 campusLocalList 非空', Array.isArray(replay.campuses) && replay.campuses.length > 0, JSON.stringify(replay.campuses));
  } finally {
    if (fs.existsSync(backup)) {
      try { await fsp.rm(DST_ROOT, { recursive: true, force: true }); } catch (e) { /* ignore */ }
      await fsp.rename(backup, DST_ROOT);
    }
  }

  const result = {
    startedAt: new Date().toISOString(),
    target: TARGET_DIR,
    src: { db: srcDb, size: fs.statSync(srcDb).size, maps: srcMaps },
    dst: { db: dstDb, exists: fs.existsSync(dstDb) },
    run1,
    replay,
    checks,
    passed: checks.filter((c) => c.ok).length,
    failed: checks.filter((c) => !c.ok).length,
  };
  await fsp.writeFile(RESULT_JSON, JSON.stringify(result, null, 2), 'utf8');
  console.log(`\n结果：${result.passed} passed / ${result.failed} failed → ${RESULT_JSON}`);
  if (result.failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('FAILED', (e && e.stack) || e);
  process.exitCode = 1;
});
