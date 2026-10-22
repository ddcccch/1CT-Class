/**
 * 3CT-Auto 真实启动入口（root start-3ct-auto.cmd）隔离运行验收 —— task-7 独立验证。
 *
 * 目标（lead 指定）：
 *  1) 从**用户路径**发起：cmd.exe 调用仓库根 `start-3ct-auto.cmd`（不是直接跑 exe），
 *     并故意保留用户环境的 ELECTRON_RUN_AS_NODE=1（验证 launcher 只对本进程子进程清理）；
 *  2) 传入隔离参数：--user-data-dir=<临时 profile> --remote-debugging-port=<未用端口> --no-first-run
 *     （依赖 launcher 的 %* 转发）；
 *  3) Playwright connectOverCDP 确认：窗口 title 含 3CT Auto、ctAPI 可用、自动化面板已注入、
 *     默认三模块关闭、预览默认开、无任何真实账号/token（临时 profile 全新）；
 *  4) 截图 artifacts/launcher-fixed.png；证据写 artifacts/launcher-runtime-result.json；
 *  5) 测试结束只停止本次测试进程树（按临时 profile 路径匹配），不碰用户原进程；删除临时 profile。
 *
 * 运行： node tests/launcher-runtime.cjs
 * 环境变量：PLAYWRIGHT_CORE 可覆盖 playwright-core 路径。
 * 安全：不读取原应用 userData；不点击任何业务按钮；不发起真实业务请求。
 */
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const PLAYWRIGHT_CORE =
  process.env.PLAYWRIGHT_CORE || ((process.env.USERPROFILE || process.env.HOME || '.') + '/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const ROOT = path.resolve(__dirname, '..');
const ARTIFACTS = path.join(ROOT, 'artifacts');
const LAUNCHER = path.join(ROOT, 'start-3ct-auto.cmd');
const RESULT_JSON = path.join(ARTIFACTS, 'launcher-runtime-result.json');
const SCREENSHOT = path.join(ARTIFACTS, 'launcher-fixed.png');

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail: detail === undefined ? '' : String(detail) });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' :: ' + detail : ''}`);
}
function info(name, detail) {
  checks.push({ name, ok: true, detail: detail === undefined ? '' : String(detail), kind: 'info' });
  console.log(`[INFO] ${name}${detail ? ' :: ' + detail : ''}`);
}

function findEdge() {
  // 本脚本用 connectOverCDP，不启动额外浏览器；保留函数以给出环境信息
  const candidates = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ];
  return candidates.find((p) => fs.existsSync(p)) || '';
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** 用 PowerShell 查询进程（比 wmic 可靠），返回 [{pid,name,cmdline}] */
function listProcesses() {
  const script =
    "Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('3CT-Auto.exe','3CT.exe','electron.exe') } | " +
    'ForEach-Object { "{0}`t{1}`t{2}" -f $_.ProcessId, $_.Name, ($_.CommandLine -replace "`t"," ") }';
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [pid, name, ...rest] = line.split('\t');
      return { pid: Number(pid), name, cmdline: rest.join('\t') };
    })
    .filter((p) => Number.isFinite(p.pid));
}

/** 只停止“本次测试 profile”相关的进程树（不碰用户原进程） */
function killTestProcessTree(profileDir) {
  const killed = [];
  for (const proc of listProcesses()) {
    if (!proc.cmdline.includes(profileDir)) continue;
    try {
      execFileSync('taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killed.push({ pid: proc.pid, name: proc.name });
    } catch (err) {
      /* 已退出则忽略 */
    }
  }
  return killed;
}

function httpGetJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = require('node:http').get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(new Error(`CDP 返回非 JSON: ${body.slice(0, 120)}`));
        }
      });
    });
    req.setTimeout(timeoutMs || 2000, () => {
      req.destroy(new Error('CDP 请求超时'));
    });
    req.on('error', reject);
  });
}

async function waitCdpReady(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const version = await httpGetJson(`http://127.0.0.1:${port}/json/version`, 1500);
      return version;
    } catch (err) {
      lastError = String(err && err.message ? err.message : err);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`等待 CDP 就绪超时（${timeoutMs}ms）：${lastError}`);
}

/** 通过 ASCII 临时 wrapper .cmd 调用真实 root launcher（规避 Node spawn 参数二次加引号问题） */
function createLauncherWrapper(extraArgs) {
  const wrapperPath = path.join(
    ARTIFACTS,
    `launcher-invoke-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}.cmd`,
  );
  const lines = [
    '@echo off',
    'setlocal',
    `call "${LAUNCHER}" ${extraArgs.join(' ')}`,
    'endlocal',
    '',
  ];
  fs.writeFileSync(wrapperPath, lines.join('\r\n'), { encoding: 'ascii' });
  return wrapperPath;
}

function runLauncherCmd(extraArgs, envPatch) {
  const wrapperPath = createLauncherWrapper(extraArgs);
  const command = `call "${LAUNCHER}" ${extraArgs.join(' ')}`;
  return new Promise((resolve, reject) => {
    const child = spawn('cmd.exe', ['/d', '/c', wrapperPath], {
      cwd: ROOT,
      env: Object.assign({}, process.env, envPatch || {}),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let text = '';
    child.stdout.on('data', (chunk) => {
      text += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      text += chunk.toString();
    });
    child.on('error', reject);
    // 用 'exit' 而不是 'close'：GUI 场景下 exe 会继承 cmd 的 stdout 管道，
    // cmd 已退出但管道未关，'close' 可能永远不来。'exit' 在 cmd 结束时立刻触发。
    const timer = setTimeout(() => {
      // cmd 自身卡住时的有界兜底：只结束这个 cmd（不碰已拉起的 exe/profile 树）
      try {
        child.kill();
      } catch (err) {
        /* ignore */
      }
    }, 30000);
    child.on('exit', (exitCode) => {
      clearTimeout(timer);
      // 给 stdout/stderr 一点时间把剩余内容冲出来，但不无限等 close
      setTimeout(() => resolve({ exitCode, text, command, wrapperPath }), 300);
    });
  });
}

async function main() {
  await fsp.mkdir(ARTIFACTS, { recursive: true });
  const startedAt = new Date().toISOString();
  const result = {
    startedAt,
    launcher: LAUNCHER,
    edgeForInfo: findEdge(),
    pollutedEnv: { ELECTRON_RUN_AS_NODE: '1' },
    checks,
  };

  if (!fs.existsSync(LAUNCHER)) throw new Error(`launcher 不存在: ${LAUNCHER}`);
  if (!fs.existsSync(path.join(ROOT, '3CT-Auto', '3CT-Auto.exe'))) {
    throw new Error('3CT-Auto.exe 不存在，请先构建副本');
  }

  // 预检：已有 3CT/3CT-Auto 在跑会让 launcher 拒绝启动（不碰用户进程，直接中止并报告）
  const existing = listProcesses();
  if (existing.length > 0) {
    const details = existing.map((p) => `${p.name}(${p.pid})`).join(', ');
    check('预检：没有其它 3CT/3CT-Auto 进程占用单实例', false, details);
    result.blockedByExistingProcesses = existing;
    await fsp.writeFile(RESULT_JSON, JSON.stringify(result, null, 2) + '\n', 'utf8');
    throw new Error(`已有 3CT 相关进程在运行，launcher 会拒绝启动；请先让用户退出：${details}`);
  }
  check('预检：没有其它 3CT/3CT-Auto 进程占用单实例', true);

  const port = await getFreePort();
  // 临时 profile 放在 artifacts 下（全 ASCII 路径，避免非 ASCII 路径影响 cmd/Electron 参数）
  const profileDir = path.join(
    ARTIFACTS,
    `launcher-profile-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`,
  );
  await fsp.mkdir(profileDir, { recursive: true });
  result.port = port;
  result.profileDir = profileDir;
  info('隔离参数', `--user-data-dir=${profileDir} --remote-debugging-port=${port} --no-first-run`);

  let playwright;
  try {
    playwright = require(PLAYWRIGHT_CORE);
  } catch (err) {
    throw new Error(`无法加载 playwright-core（${PLAYWRIGHT_CORE}）: ${err.message}`);
  }

  let launcherOutput = '';
  let browser = null;
  let allPassed = false;
  let dryRunResult = null;
  try {
    // ── Phase 1：污染 env 下 dry-run，验证 launcher 自己清理子进程环境（不启动 GUI）──
    // 关键：我们不手动清 ELECTRON_RUN_AS_NODE，只把它设为 1 传进去，由 launcher 的 setlocal 清理。
    // 通过临时 ASCII wrapper .cmd 调用，避免 Node spawn 对含空格参数的二次加引号问题。
    const dryOutput = await runLauncherCmd([], {
      ELECTRON_RUN_AS_NODE: '1',
      NODE_OPTIONS: '--trace-warnings',
      AUTO3CT_LAUNCHER_DRY_RUN: '1',
    });
    dryRunResult = { exitCode: dryOutput.exitCode, output: dryOutput.text.slice(0, 3000), command: dryOutput.command };
    result.dryRun = dryRunResult;
    check('dry-run：无 3CT 进程时正常退出 0', dryOutput.exitCode === 0, `exit=${dryOutput.exitCode}`);
    check(
      'dry-run：输出 dry-run 标记（没被 if 块解析 bug 带偏）',
      dryOutput.text.includes('[dry-run]') && dryOutput.text.includes('APP='),
      dryOutput.text.split(/\r?\n/).filter(Boolean).slice(-4).join(' | '),
    );
    check(
      'launcher 自身清理 ELECTRON_RUN_AS_NODE（输出为空）',
      /ELECTRON_RUN_AS_NODE=\[\]/.test(dryOutput.text),
      dryOutput.text.split(/\r?\n/).find((l) => l.includes('ELECTRON_RUN_AS_NODE')) || '(未出现)',
    );

    // ── Phase 2：真实 GUI 启动（同一污染 env；从 user 路径 cmd 入口）──
    const launchArgs = [
      `--user-data-dir="${profileDir}"`,
      `--remote-debugging-port=${port}`,
      '--no-first-run',
    ];
    const launchWrapper = createLauncherWrapper(launchArgs);
    result.launcherWrapper = launchWrapper;
    result.launcherCommand = `call "${LAUNCHER}" ${launchArgs.join(' ')}（经 wrapper ${launchWrapper} 调用）`;
    const child = spawn('cmd.exe', ['/d', '/c', launchWrapper], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => {
      launcherOutput += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      launcherOutput += chunk.toString();
    });
    // 同样用 'exit' 而不是 'close'：launcher 用 start 拉起 exe 后，exe 继承 stdout 管道，
    // cmd 已退出但 'close' 可能一直不来；'exit' 在 cmd 结束时立即触发，之后继续等 CDP。
    const exitCode = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch (err) {
          /* ignore */
        }
      }, 30000);
      child.on('exit', (code) => {
        clearTimeout(timer);
        setTimeout(() => resolve(code), 300);
      });
    });
    result.launcherSpawnExitCode = exitCode;
    result.launcherOutput = launcherOutput.slice(0, 4000);
    check('launcher 进程正常退出（start 后立即返回 0）', exitCode === 0, `exit=${exitCode}`);

    // 等待 CDP 就绪（launcher 用 start 异步拉起，故 cmd 已退出后继续等）
    const cdpVersion = await waitCdpReady(port, 90000);
    result.cdpVersion = cdpVersion;
    check('CDP 已就绪（真实 3CT-Auto.exe 进程被拉起）', Boolean(cdpVersion.Browser), JSON.stringify(cdpVersion));

    browser = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const contexts = browser.contexts();
    check('connectOverCDP 拿到 1 个 context', contexts.length >= 1, `contexts=${contexts.length}`);
    const context = contexts[0];

    // 找到真实窗口页面并等待自动化面板注入
    let page = null;
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      const pages = context.pages();
      for (const candidate of pages) {
        try {
          const title = await candidate.title();
          const hasPanel = await candidate.evaluate(
            () => Boolean(window.ctAPI) && Boolean(document.querySelector('[data-testid="a3-panel"]')),
          );
          if (hasPanel) {
            page = candidate;
            info('窗口页面', `title=${title} url=${candidate.url()}`);
            break;
          }
        } catch (err) {
          /* 页面可能还在加载 */
        }
      }
      if (page) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!page) throw new Error('未找到已注入自动化面板的 3CT-Auto 窗口');
    result.pageUrl = page.url();

    const pageTitle = await page.title();
    result.pageTitle = pageTitle;
    check('窗口 title 含「3CT Auto」', /3CT Auto/.test(pageTitle), pageTitle);

    const ctApiInfo = await page.evaluate(() => ({
      hasCtAPI: Boolean(window.ctAPI),
      groups: window.ctAPI ? Object.keys(window.ctAPI).sort() : [],
      hasPanelModule: Boolean(window.Auto3CTPanel),
      hasAutomationModule: Boolean(window.Auto3CTAutomation),
    }));
    result.ctApiInfo = ctApiInfo;
    check('window.ctAPI 已桥接', ctApiInfo.hasCtAPI, JSON.stringify(ctApiInfo.groups));
    check('自动化 panel/engine 脚本已加载', ctApiInfo.hasPanelModule && ctApiInfo.hasAutomationModule);

    const panelState = await page.evaluate(() => {
      const panel = document.querySelector('[data-testid="a3-panel"]');
      let panelVisible = false;
      if (panel) {
        // 面板是 position:fixed，offsetParent 恒为 null；按 rect + computed style 判定可见
        const rect = panel.getBoundingClientRect();
        const style = getComputedStyle(panel);
        panelVisible =
          rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      }
      const modules = ['a3-module-unirun', 'a3-module-club', 'a3-module-ek'].map((id) => {
        const box = document.querySelector(`[data-testid="${id}"]`);
        return { id, exists: Boolean(box), checked: box ? box.checked : null };
      });
      const dry = document.querySelector('[data-testid="a3-dry-run"]');
      let config = null;
      try {
        config = JSON.parse(window.localStorage.getItem('auto3ct:config') || 'null');
      } catch (err) {
        config = 'parse-error';
      }
      return {
        panelVisible,
        modules,
        dryRunChecked: dry ? dry.checked : null,
        statusText: (document.getElementById('a3-status') || {}).textContent || '',
        config,
        hasEkSession: Boolean(window.localStorage.getItem('ct_ek_session_v1')),
        hasUnirunAccounts: Boolean(window.localStorage.getItem('ct_unirun_accounts_v1')),
      };
    });
    result.panelState = panelState;

    check('自动化面板在真实窗口中可见', panelState.panelVisible);
    check('三个业务模块开关存在', panelState.modules.every((m) => m.exists), JSON.stringify(panelState.modules));
    check('默认三模块关闭', panelState.modules.every((m) => m.checked === false), JSON.stringify(panelState.modules));
    check('默认预览模式开启', panelState.dryRunChecked === true, String(panelState.dryRunChecked));
    check('默认状态「未启动」', String(panelState.statusText).trim() === '未启动', panelState.statusText);
    check('临时 profile 中无二课真实会话', panelState.hasEkSession === false);
    check('临时 profile 中无校园跑真实账号', panelState.hasUnirunAccounts === false);

    const externalWrite = await page
      .evaluate(() => {
        // 仅观察，不触发任何按钮；确认页面没有打开业务写接口的迹象
        return { ctApiReady: Boolean(window.ctAPI && window.ctAPI.ek && window.ctAPI.club && window.ctAPI.unirun) };
      })
      .catch(() => ({ ctApiReady: false }));
    check('ctAPI 三业务组均已桥接（未调用）', externalWrite.ctApiReady, JSON.stringify(externalWrite));

    await page.screenshot({ path: SCREENSHOT, fullPage: false });
    check('截图已生成 artifacts/launcher-fixed.png', fs.existsSync(SCREENSHOT) && fs.statSync(SCREENSHOT).size > 10000, `${fs.existsSync(SCREENSHOT) ? fs.statSync(SCREENSHOT).size : 0}B`);
    allPassed = checks.every((c) => c.ok);
  } finally {
    // 只停止本测试进程树（按临时 profile 匹配），再断 CDP、删临时 profile
    result.killedProcesses = killTestProcessTree(profileDir);
    await new Promise((r) => setTimeout(r, 800));
    const leftover = listProcesses().filter((p) => p.cmdline.includes(profileDir));
    if (leftover.length > 0) {
      result.leftoverProcesses = leftover;
      // 二次强杀（可能为刚 spawn 的 helper）
      killTestProcessTree(profileDir);
    }
    if (browser) await browser.close().catch(() => {});
    await fsp.rm(profileDir, { recursive: true, force: true }).catch(() => {});
    // 清理本次临时 wrapper .cmd（只清 launcher-invoke-*）
    for (const name of fs.readdirSync(ARTIFACTS)) {
      if (/^launcher-invoke-.*\.cmd$/.test(name)) {
        fs.rmSync(path.join(ARTIFACTS, name), { force: true });
      }
    }
    result.finishedAt = new Date().toISOString();
    result.passed = checks.filter((c) => c.ok).length;
    result.failed = checks.filter((c) => !c.ok).length;
    result.screenshot = SCREENSHOT;
    result.ok = result.failed === 0 && Boolean(allPassed);
    await fsp.writeFile(RESULT_JSON, JSON.stringify(result, null, 2) + '\n', 'utf8').catch(() => {});
  }

  console.log(`\n结果：${result.passed} passed / ${result.failed} failed → ${RESULT_JSON}`);
  console.log(`截图：${SCREENSHOT}`);
  console.log(`清理：killed=${JSON.stringify(result.killedProcesses)}；临时 profile 已删除`);
  if (result.failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('launcher 运行验收异常终止：', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});

