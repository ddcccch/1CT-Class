/**
 * 1CT 打包后 renderer 冒烟验收（只读，不碰用户 profile、不做业务写）。
 *
 * 目标：证明 `1CT\resources\app.asar` 里的 1CT 渲染层**真的能加载**：
 *  1) 用 root GUI launcher（启动1CT.exe）启动 1CT\1CT.exe，传
 *     --user-data-dir=<临时 profile> --remote-debugging-port=<未用端口> --no-first-run
 *     （启动器直启 exe，不经 cmd；顺带验证它清理子进程 ELECTRON 环境变量）；
 *  2) connectOverCDP 打开真实窗口，断言标题 1CT、URL 来自打包后的 app.asar；
 *  3) 断言 window.OneCTMembers / OneCTStats / Auto3CTAutomation / Auto3CTScorePolicy /
 *     Auto3CTResults 均已加载，原版 panel/dashboard 全局**不存在**；
 *  4) 断言页面只有 1CT 的 4 个 tab、DOM 由 shell.js 渲染出来（data-testid one-ct-*）；
 *  5) 截图 artifacts/1ct/packaged-*.png；
 *  6) 只结束本次临时 profile 匹配的进程树并删除 profile（绝不动用户进程）。
 *
 * 运行：node tests/packaged-1ct-smoke.cjs
 */
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');

const PLAYWRIGHT_CORE =
  process.env.PLAYWRIGHT_CORE ||
  'C:/Users/<user>/.workbuddy/binaries/node/workspace/node_modules/playwright-core';
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'artifacts');
const RESULT_JSON = path.join(OUT, '1ct-packaged-smoke-result.json');
const LAUNCHER = path.join(ROOT, '启动1CT.exe');

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
    "Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('1CT.exe','3CT-Auto.exe','3CT.exe','启动1CT.exe') } | " +
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

function killProfileTree(profileDir) {
  const killed = [];
  for (const proc of listAppProcesses()) {
    if (!proc.cmdline.includes(profileDir)) continue;
    try {
      execFileSync('taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killed.push({ pid: proc.pid, name: proc.name });
    } catch (e) {
      /* already gone */
    }
  }
  return killed;
}

function cdpJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => {
        body += c;
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
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

async function main() {
  await fsp.mkdir(OUT, { recursive: true });
  const startedAt = new Date().toISOString();
  if (!fs.existsSync(LAUNCHER)) throw new Error('GUI launcher 不存在（先 build）: ' + LAUNCHER);

  const existing = listAppProcesses();
  const blocking = existing.filter((p) => /^(1CT|3CT|3CT-Auto)\.exe$/.test(p.name));
  if (blocking.length) {
    check(
      '无其它 1CT/3CT 进程占用（不 kill 用户进程）',
      false,
      blocking.map((p) => `${p.name}(${p.pid})`).join(',')
    );
    await fsp.writeFile(
      RESULT_JSON,
      JSON.stringify({ startedAt, blockedBy: blocking, checks }, null, 2),
      'utf8'
    );
    process.exitCode = 1;
    return;
  }
  check('无其它 1CT/3CT 进程占用（不 kill 用户进程）', true);

  const port = await freePort();
  const profile = path.join(OUT, 'profile-' + Date.now().toString(36));
  await fsp.mkdir(profile, { recursive: true });
  let playwright;
  try {
    playwright = require(PLAYWRIGHT_CORE);
  } catch (e) {
    throw new Error('playwright-core: ' + e.message);
  }

  let browser = null;
  const result = { startedAt, port, profile, checks };
  try {
    const child = spawn(LAUNCHER, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--no-first-run'], {
      cwd: ROOT,
      windowsHide: true,
      stdio: 'ignore',
      // 故意污染父进程环境：验证 GUI 启动器只清理子进程的 Node 模式变量。
      env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }),
    });
    const exitCode = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch (e) {}
      }, 30000);
      child.on('exit', (code) => {
        clearTimeout(timer);
        setTimeout(() => resolve(code), 300);
      });
    });
    result.launcherExitCode = exitCode;
    check('GUI 启动器成功拉起 1CT 并快速返回', exitCode === 0, `exit=${exitCode}`);

    const version = await waitCdp(port, 90000);
    check('CDP 就绪（真实 Electron 已起）', Boolean(version.Browser), JSON.stringify(version).slice(0, 160));
    info('Electron', String(version.Browser || ''));

    browser = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context = browser.contexts()[0];
    let page = null;
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline && !page) {
      for (const cand of context.pages()) {
        try {
          const ok = await cand.evaluate(
            () => Boolean(window.OneCTMembers && document.querySelector('[data-testid="one-ct-app"]'))
          );
          if (ok) {
            page = cand;
            break;
          }
        } catch (e) {
          /* still loading */
        }
      }
      if (!page) await new Promise((r) => setTimeout(r, 500));
    }
    if (!page) throw new Error('未找到加载了 1CT shell 的窗口');

    result.pageTitle = await page.title();
    result.pageUrl = page.url();
    check('窗口标题是 1CT', /^1CT$/.test(result.pageTitle.trim()), result.pageTitle);
    check(
      '页面来自打包后的 app.asar',
      /app\.asar\/dist\/renderer\/index\.html/.test(result.pageUrl),
      result.pageUrl
    );

    const globals = await page.evaluate(() => ({
      members: Boolean(window.OneCTMembers),
      stats: Boolean(window.OneCTStats),
      automation: Boolean(window.Auto3CTAutomation),
      scorePolicy: Boolean(window.Auto3CTScorePolicy),
      results: Boolean(window.Auto3CTResults || window.Auto3CTResultStore),
      legacyPanel: Boolean(window.Auto3CTPanel),
      legacyDashboard: Boolean(window.Auto3CTDashboard),
      ctAPI: Boolean(window.ctAPI),
      // 1CT 新增桥方法：官网「报名/完成列表」（真正带 SignD/SignT 签到/签退状态）。
      // 它由 install_1ct.py 在打包时给 dist/main/preload.js 追加，必须随包可用。
      getStuAllActApplyList: typeof (((window.ctAPI || {}).ek) || {}).getStuAllActApplyList,
      // scores-sync 新 API：打包产物必须带上（否则 UI 显示「同步功能未就绪」）
      syncOfficialScores: typeof (window.OneCTMembers || {}).syncOfficialScores,
      syncAllOfficialScores: typeof (window.OneCTMembers || {}).syncAllOfficialScores,
    }));
    result.globals = globals;
    check('window.OneCTMembers 已加载', globals.members);
    check('window.OneCTStats 已加载', globals.stats);
    check('window.Auto3CTAutomation 已加载', globals.automation);
    check('window.Auto3CTScorePolicy 已加载', globals.scorePolicy);
    check('window.Auto3CTResults 已加载', globals.results);
    check('原版 panel/dashboard 全局不存在', !globals.legacyPanel && !globals.legacyDashboard, JSON.stringify(globals).slice(0, 220));
    check('window.ctAPI 由原 preload 注入', globals.ctAPI);
    // ---- 1CT 新增：官网报名/完成列表桥（GetStuAllActApplyList）----
    check(
      'ctAPI.ek.getStuAllActApplyList 是函数（报名/完成列表桥已打包）',
      globals.getStuAllActApplyList === 'function',
      String(globals.getStuAllActApplyList)
    );
    // ---- scores-sync 打包后可用性（Lead 新增验收点）----
    check(
      'OneCTMembers.syncOfficialScores 是函数（同步功能已打包）',
      globals.syncOfficialScores === 'function',
      String(globals.syncOfficialScores)
    );
    check(
      'OneCTMembers.syncAllOfficialScores 是函数',
      globals.syncAllOfficialScores === 'function',
      String(globals.syncAllOfficialScores)
    );

    // userData 隔离（Node 侧）：本次显式传了 --user-data-dir=<临时 profile>，
    // 真实 %APPDATA%\1CT 不应被这次冒烟污染，临时 profile 里应有数据落盘。
    const profileFiles = (() => {
      try {
        const walk = (dir) => {
          let count = 0;
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) count += walk(path.join(dir, entry.name));
            else count += 1;
          }
          return count;
        };
        return fs.existsSync(profile) ? walk(profile) : 0;
      } catch (e) {
        return -1;
      }
    })();
    result.profileFiles = profileFiles;
    check(
      '临时 profile 已写入数据（--user-data-dir 生效）',
      profileFiles > 0,
      `files=${profileFiles}`
    );

    const ui = await page.evaluate(() => {
      const tabs = [...document.querySelectorAll('[data-testid^="one-ct-tab-"]')].map((el) => ({
        id: el.getAttribute('data-testid'),
        text: String(el.textContent || '').trim(),
      }));
      const style = getComputedStyle(document.body);
      return {
        tabs,
        bodyBg: style.backgroundColor,
        bodyColor: style.color,
        hasRoot: Boolean(document.querySelector('[data-testid="one-ct-app"]')),
        rootChildren: (document.querySelector('[data-testid="one-ct-app"]') || {}).childElementCount || 0,
        docTitle: document.title,
      };
    });
    result.ui = ui;
    check('1CT shell 已渲染进 DOM', ui.hasRoot && ui.rootChildren > 0, JSON.stringify(ui).slice(0, 200));
    check('五个 tab 齐备', ui.tabs.length === 5, JSON.stringify(ui.tabs));
    check('极简白：body 背景为白色', ui.bodyBg === 'rgb(255, 255, 255)', ui.bodyBg);
    await page.screenshot({ path: path.join(OUT, '1ct-packaged-electron-01.png'), fullPage: false });

    // 逐个 tab 切换（只读：不点启动、不改配置）
    for (const tab of ui.tabs) {
      const testId = tab.id;
      const clicked = await page
        .locator(`[data-testid="${testId}"]`)
        .first()
        .click({ timeout: 8000 })
        .then(() => true)
        .catch(() => false);
      if (!clicked) continue;
      await page.waitForTimeout(450);
      const slug = String(tab.text || testId).replace(/[^\w\u4e00-\u9fa5-]/g, '') || 'tab';
      await page.screenshot({ path: path.join(OUT, `1ct-packaged-electron-tab-${slug}.png`), fullPage: false });
    }
    const afterTabs = await page.evaluate(() => ({
      visible: [...document.querySelectorAll('[data-testid^="one-ct-"][data-testid$="-view"]')]
        .filter((el) => el.getBoundingClientRect().width > 0)
        .map((el) => el.getAttribute('data-testid')),
      rootNodes: (document.getElementById('one-ct-root') || { querySelectorAll: () => [] }).querySelectorAll('*').length,
      readyFlag: window.__ONE_CT_READY__ === true,
    }));
    result.afterTabs = afterTabs;
    check('tab 切换后有可见面板', afterTabs.visible.length > 0, JSON.stringify(afterTabs));
    // 防“DOM 空”回归：真实 Electron 窗口里根节点内必须有 > 20 个节点
    check('#one-ct-root 内节点数 > 20', afterTabs.rootNodes > 20, `nodes=${afterTabs.rootNodes}`);
    check('window.__ONE_CT_READY__ === true', afterTabs.readyFlag === true, String(afterTabs.readyFlag));

    // ---- 真实 Electron 内注入 3 名成员（临时 profile，不触网）并断言成员页 3 行 ----
    const seeded = await page.evaluate(() => {
      const now = Date.now();
      const members = [1, 2, 3].map((i) => ({
        id: 'm_elec000' + i,
        name: ['张三', '李四', '王五'][i - 1],
        note: 'electron packaged smoke',
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
      if (window.OneCTShell && window.OneCTShell.refresh) window.OneCTShell.refresh();
      return { count: window.OneCTMembers.load().items.length };
    });
    result.seeded = seeded;
    check('真实 Electron 内注入 3 名成员', seeded.count === 3, JSON.stringify(seeded));

    await page.locator('[data-testid="one-ct-tab-members"]').click({ timeout: 8000 });
    await page.waitForTimeout(700);
    const memberRows = await page.evaluate(() => {
      const view = document.querySelector('[data-testid="one-ct-members-view"]') || document.body;
      const text = String(view.textContent || '');
      return {
        rows: document.querySelectorAll('[data-testid="one-ct-member-row"]').length,
        names: ['张三', '李四', '王五'].filter((n) => text.includes(n)),
        viewNodes: view.querySelectorAll('*').length,
      };
    });
    result.memberRows = memberRows;
    check('成员页至少渲染 3 行', memberRows.rows >= 3, JSON.stringify(memberRows));
    check('成员页显示三名成员姓名', memberRows.names.length === 3, JSON.stringify(memberRows.names));
    await page.screenshot({ path: path.join(OUT, '1ct-packaged-electron-members.png'), fullPage: false });

    // ---- 同步入口 + 弹层断言（Lead 新增验收点）----
    // one-ct-sync-all 在「二课」页；one-ct-sync-member 在「成员编辑弹层」内。
    // 先断言成员页不再有手填八模块输入（手填已删除）。
    const memberPageUi = await page.evaluate(() => ({
      moduleCurrentInputs: document.querySelectorAll('[data-testid^="one-ct-module-current-"]').length,
      manualModuleInputs: document.querySelectorAll(
        '[data-testid^="one-ct-module-current-"], [data-testid="one-ct-module-editor"]'
      ).length,
      syncMemberOnMemberPage: Boolean(document.querySelector('[data-testid="one-ct-sync-member"]')),
    }));
    result.memberPageUi = memberPageUi;
    check(
      '手填八模块输入已删除（one-ct-module-current-* 数量为 0）',
      memberPageUi.moduleCurrentInputs === 0,
      `count=${memberPageUi.moduleCurrentInputs}`
    );

    // 二课页：one-ct-sync-all 必须存在且可用（不是「同步功能未就绪」）
    await page.locator('[data-testid="one-ct-tab-ek"]').click({ timeout: 8000 });
    await page.waitForTimeout(800);
    const ekUi = await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="one-ct-sync-all"]');
      return {
        syncAll: Boolean(btn),
        syncAllText: btn ? String(btn.textContent || '').trim() : null,
        syncAllDisabled: btn ? Boolean(btn.disabled) : null,
        moduleCurrentInputs: document.querySelectorAll('[data-testid^="one-ct-module-current-"]').length,
        hasStatsHost: Boolean(document.querySelector('[data-testid="one-ct-stats-host"]')),
      };
    });
    result.ekUi = ekUi;
    check('二课页存在 同步全部成员成绩 按钮（one-ct-sync-all）', ekUi.syncAll, JSON.stringify(ekUi));
    check(
      '同步全部按钮可用（未显示「同步功能未就绪」）',
      ekUi.syncAll && !ekUi.syncAllDisabled && !/未就绪/.test(String(ekUi.syncAllText || '')),
      `text=${ekUi.syncAllText} disabled=${ekUi.syncAllDisabled}`
    );
    check('二课页无手填八模块输入', ekUi.moduleCurrentInputs === 0, `count=${ekUi.moduleCurrentInputs}`);
    await page.screenshot({ path: path.join(OUT, '1ct-packaged-electron-ek.png'), fullPage: false });

    // 成员弹层：one-ct-sync-member 必须存在，且弹层内无手填输入
    await page.locator('[data-testid="one-ct-tab-members"]').click({ timeout: 8000 });
    await page.waitForTimeout(600);
    let modalInfo = null;
    try {
      const modalOpeners = [
        '[data-testid^="one-ct-member-edit-"]',
        '[data-testid="one-ct-member-edit"]',
      ];
      let opened = false;
      for (const sel of modalOpeners) {
        const loc = page.locator(sel).first();
        if (await loc.count()) {
          await loc.click({ timeout: 5000 }).catch(() => {});
          await page.waitForTimeout(700);
          const openNow = await page.evaluate(
            () =>
              Boolean(
                document.querySelector('[data-testid="one-ct-sync-member"]') ||
                document.querySelector('[data-testid="one-ct-member-modal"]') ||
                document.querySelector('[data-testid^="one-ct-member-modal"]')
              )
          );
          if (openNow) {
            opened = true;
            break;
          }
        }
      }
      modalInfo = await page.evaluate(() => {
        const btn = document.querySelector('[data-testid="one-ct-sync-member"]');
        const modal = document.querySelector('[data-testid="one-ct-member-modal"]');
        return {
          syncMember: Boolean(btn),
          syncMemberText: btn ? String(btn.textContent || '').trim() : null,
          modalDetected: Boolean(modal),
          moduleCurrentInputsInModal: modal
            ? modal.querySelectorAll('[data-testid^="one-ct-module-current-"]').length
            : -1,
          moduleCurrentInputsTotal: document.querySelectorAll('[data-testid^="one-ct-module-current-"]').length,
          syncSection: Boolean(document.querySelector('[data-testid="one-ct-sync-section"]')),
        };
      });
      modalInfo.opened = opened;
      result.modalInfo = modalInfo;
      check('成员编辑弹层可打开', opened, JSON.stringify(modalInfo).slice(0, 300));
      check('弹层内存在 同步官方成绩 按钮（one-ct-sync-member）', modalInfo.syncMember, JSON.stringify(modalInfo).slice(0, 300));
      check(
        '弹层内无手填八模块输入',
        modalInfo.moduleCurrentInputsInModal === 0,
        JSON.stringify(modalInfo).slice(0, 300)
      );
      await page.screenshot({
        path: path.join(OUT, '1ct-packaged-electron-modal.png'),
        fullPage: false,
      });
    } catch (err) {
      result.modalInfo = { error: String(err && err.message ? err.message : err) };
      check('成员编辑弹层可打开', false, String(result.modalInfo.error));
    }

    result.ok = checks.filter((c) => !c.kind && c.ok).length === checks.filter((c) => !c.kind).length;
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
  console.error('1CT 打包冒烟异常终止：', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
