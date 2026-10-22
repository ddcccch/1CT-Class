/* 1CT 界面：极简白桌面工具，零依赖原生 DOM；手机号一律掩码，密码与登录凭据绝不进日志、导出与页面文本。 */
(function () {
  'use strict';

  var APP_VERSION = '1.2.0';
  // 本版更新公告（按版本只弹一次，用户可见文案）
  var CHANGELOG = [
    '去掉预览开关，启动即真实执行（更省心）',
    '新增微信扫码登录：不在校园网也能登录二课',
    '新增首次使用说明，第一次打开会把三步讲清楚',
    '校园跑每日执行时刻默认改为 19:00，可在「运行」页随时调整',
    '界面与提示文案重新整理，登录失败时会直接显示具体原因',
  ];

  var UI_KEY = '1ct:ui';
  var ONBOARD_KEY = '1ct:onboard:v1';
  var WHATSNEW_KEY = '1ct:whatsnew:' + APP_VERSION;
  var MAX_LOG = 300;
  var DECODE_TIMEOUT_MS = 15000;
  var MAX_IMAGE_SIDE = 4096;
  var MAX_IMAGE_PIXELS = 4096 * 4096;
  var TAB_KEYS = ['run', 'members', 'ek', 'records', 'logs'];

  var M = window.OneCTMembers || null;
  var S = window.OneCTStats || null;
  var A = window.Auto3CTAutomation || null;
  var POLICY = window.Auto3CTScorePolicy || null;

  var FALLBACK_MODULES = [
    { name: '思想政治与道德修养', required: 12 },
    { name: '学术科技与创新创业', required: 8 },
    { name: '艺术体验与审美修养', required: 12 },
    { name: '传统文化与人文素养', required: 8 },
    { name: '人际交往与沟通能力', required: 8 },
    { name: '心理素质与身体素质', required: 12 },
    { name: '社会实践与志愿服务', required: 12 },
    { name: '社会工作与能力拓展', required: 8 },
  ];

  var FALLBACK_CONFIG = {
    dryRun: false,
    accountId: '',
    campusId: '',
    tickMs: 60000,
    windowTickMs: 20000,
    // 有效窗口 / 里程默认留空：由程序每天自动随机
    unirun: { enabled: false, runAt: '19:00', windowMinutes: null, runDistance: null, runTime: null },
    club: {
      enabled: false, keywords: [], allowAll: false, join: true,
      signIn: true, signOut: true, dailyJoinLimit: 1,
    },
    ek: {
      enabled: false, keywords: [], allowAll: false, apply: true,
      signIn: true, signOut: true, dailyLimit: 1,
      qrDelayMinutes: 2, qrRetryMinutes: 2, qrMaxAttempts: 3,
      skipSignWay4: true,
      photoSign: true,
    },
  };

  var PALETTE = ['#111113', '#2563eb', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#be123c', '#4b5563'];

  var MODULE_CN = { ek: '二课', club: '俱乐部', unirun: '校园跑' };
  var ACTION_CN = {
    apply: '报名', join: '报名', signIn: '签到', 'sign-in': '签到', signOut: '签退',
    'sign-out': '签退', run: '跑步', autoRun: '跑步', list: '扫描', detail: '读取详情',
  };
  var STATUS_CN = {
    success: '成功', failed: '失败', unknown: '结果未知', blocked: '已阻断', skipped: '已跳过',
    'waiting-material': '等待材料', 'not-yet': '未到时间', 'dry-run': '预览（历史）',
    retry: '重试中', legacy: '历史记录',
  };
  var REASON_CN = {
    'before-apply-window': '未到报名时间', 'before-window': '未到签到/签退时间',
    'apply-window-passed': '报名窗口已过', 'window-passed': '签到/签退窗口已过',
    'missing-apply-window': '缺少报名窗口信息', 'already-applied': '已报名',
    'already-applied-conflict': '查询冲突按已报名处理', 'daily-limit-reached': '达到每日上限',
    'module-satisfied': '该模块积分已达标', 'category-unknown': '活动类别无法映射',
    'need-keywords': '未配置关键词', 'score-snapshot-missing': '积分快照未导入',
    'score-account-mismatch': '积分账号不匹配', 'score-untrusted': '积分数据不可信',
    'score-stale': '积分数据过期', 'score-refresh-failed': '积分刷新失败',
    'policy-disabled': '缺口策略已关闭', 'upstream-rejected': '上游拒绝',
    'submission-result-unknown': '提交结果未知（不自动重试）', 'need-sign-in-first': '需先签到',
    'need-coords': '缺少定位坐标', 'need-sign-way': '缺少签到方式',
    'need-manual-sign-way': '需人工选择签到方式', 'need-qr-or-manual': '需二维码或人工签到',
    'qr-retry-pending': '二维码重试等待中', 'qr-attempts-exhausted': '二维码尝试次数用尽',
    'already-done': '今日已完成', 'already-done-upstream': '上游显示已完成',
    'past-deadline': '已过截止时间', stopped: '已停止', 'state-corrupt': '去重状态损坏',
    'storage-error': '本地存储失败', 'previous-result-unknown': '上次结果未知已锁定',
    'locked-failed': '上次失败已锁定', 'locked-unknown': '上次结果未知已锁定',
    'no-candidate': '未发现候选活动', 'api-unavailable': '接口不可用',
    'ek-not-logged-in': '二课未登录', 'no-ek-session': '二课未登录',
    'no-unirun-account': '未配置校园跑账号', 'campus-not-found': '未找到校区',
    'apply-state-unknown': '报名状态待确认', 'apply-disabled': '自动报名已关闭',
    'unexpected-list-shape': '活动列表结构异常', 'scan-complete': '扫描完成',
    'preview-only': '预览（历史，未提交）', 'not-applied': '未报名',
    'member-error': '该成员执行异常', 'ek-session-expired': '二课会话已过期',
    'ek-login-failed': '二课重新登录失败', 'no-api': '本机服务不可用',
  };

  // ───────────────────────────── 通用工具 ─────────────────────────────

  function text(value) {
    return value === null || value === undefined ? '' : String(value);
  }

  function trim(value) {
    return text(value).trim();
  }

  function clone(value) {
    if (value === null || value === undefined || typeof value !== 'object') return value;
    return JSON.parse(JSON.stringify(value));
  }

  function isObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function hasFn(obj, name) {
    return Boolean(obj && typeof obj[name] === 'function');
  }

  function deepMerge() {
    var out = {};
    for (var i = 0; i < arguments.length; i += 1) {
      var src = arguments[i];
      if (!isObject(src)) continue;
      Object.keys(src).forEach(function (key) {
        var value = src[key];
        if (isObject(value)) out[key] = deepMerge(out[key] || {}, value);
        else if (value !== undefined) out[key] = Array.isArray(value) ? value.slice() : value;
      });
    }
    return out;
  }

  function num(value, fallback) {
    if (value === null || value === undefined || value === '') {
      return fallback === undefined ? null : fallback;
    }
    var n = Number(value);
    return Number.isFinite(n) ? n : fallback === undefined ? null : fallback;
  }

  function clampNumber(value, min, max) {
    var n = num(value);
    if (n === null) return null;
    return Math.min(max, Math.max(min, n));
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function formatDateTime(ms) {
    var at = num(ms);
    if (!at) return '';
    var d = new Date(at);
    return (
      d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds())
    );
  }

  function formatTime(ms) {
    var at = num(ms);
    if (!at) return '';
    var d = new Date(at);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  function todayStamp() {
    var d = new Date();
    return '' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate());
  }

  /** 手机号掩码 138****0000（列表/日志/导出只允许出现掩码形式） */
  function maskPhone(phone) {
    var s = text(phone).replace(/\s+/g, '');
    if (!s) return '';
    if (/^1\d{10}$/.test(s)) return s.slice(0, 3) + '****' + s.slice(-4);
    if (s.length > 6) return s.slice(0, 2) + '****' + s.slice(-2);
    return '****';
  }

  /** 稳定短 hash（FNV-1a）：用于合成校园跑账号 id，不可逆、不含明文手机号 */
  function shortHash(value) {
    var hash = 2166136261;
    var str = text(value);
    for (var i = 0; i < str.length; i += 1) {
      hash ^= str.charCodeAt(i);
      hash = (hash * 16777619) >>> 0;
    }
    return hash.toString(36);
  }

  /** 错误脱敏：绝不把 token / 密码 / 完整手机号带进 UI 文案 */
  function sanitizeError(e) {
    var raw = e && e.message ? String(e.message) : text(e);
    return raw
      .replace(/(password|passwd|access_token|refresh_token|JSESSIONID|SESSIONID|token)\s*[:=]\s*[^\s,;]+/gi, '$1=***')
      .replace(/\b1[3-9]\d{9}\b/g, '1**********')
      .replace(/\s+/g, ' ')
      .slice(0, 180);
  }

  function parseJson(raw) {
    if (raw === null || raw === undefined || raw === '') return null;
    if (typeof raw === 'object') return raw;
    try {
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  /** 二课会话 JSON 兼容三种包装：裸 session / {session} / {requestsData} / {data} */
  function normalizeEkSession(input) {
    if (!isObject(input)) return null;
    var candidates = [input];
    if (isObject(input.session)) candidates.push(input.session);
    if (isObject(input.requestsData)) candidates.push(input.requestsData);
    if (isObject(input.data)) candidates.push(input.data);
    for (var i = 0; i < candidates.length; i += 1) {
      var item = candidates[i];
      if (item && item.JSESSIONID && item.access_token && item.refresh_token && isObject(item.user_info)) {
        return {
          JSESSIONID: String(item.JSESSIONID),
          access_token: String(item.access_token),
          refresh_token: String(item.refresh_token),
          user_info: clone(item.user_info),
        };
      }
    }
    return null;
  }

  function downloadText(filename, content, mime) {
    try {
      var blob = new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () {
        URL.revokeObjectURL(url);
      }, 1500);
      return true;
    } catch (e) {
      pushLog('error', '导出失败：' + sanitizeError(e));
      return false;
    }
  }

  // ───────────────────────────── DOM 构造器 ─────────────────────────────

  function h(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var value = attrs[key];
        if (value === undefined || value === null || value === false) return;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = text(value);
        else if (key === 'style') node.setAttribute('style', value);
        else if (key === 'checked' || key === 'disabled' || key === 'selected' || key === 'value') {
          node[key] = value;
          if (key === 'disabled' && value) node.setAttribute('disabled', '');
        } else if (key.indexOf('on') === 0 && typeof value === 'function') {
          node.addEventListener(key.slice(2).toLowerCase(), value);
        } else {
          node.setAttribute(key, value === true ? '' : String(value));
        }
      });
    }
    appendChildren(node, children);
    return node;
  }

  function appendChildren(node, children) {
    (children || []).forEach(function (child) {
      if (child === null || child === undefined || child === false) return;
      node.appendChild(
        typeof child === 'string' || typeof child === 'number'
          ? document.createTextNode(String(child))
          : child,
      );
    });
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  // ───────────────────────────── 界面状态（唯一允许的 localStorage） ─────────────────────────────

  function defaultUi() {
    return {
      version: 1,
      tab: 'run',
      selectedMemberId: null,
      // 以下为界面运行态（契约 §2 的 1ct:ui 由 UI 独占；不存任何凭证）
      running: false,
      lastRunAt: 0,
      lastSummary: null,
    };
  }

  function readUi() {
    var fallback = defaultUi();
    var parsed;
    try {
      parsed = parseJson(window.localStorage.getItem(UI_KEY));
    } catch (e) {
      return fallback;
    }
    if (!isObject(parsed)) return fallback;
    return {
      version: 1,
      tab: TAB_KEYS.indexOf(parsed.tab) >= 0 ? parsed.tab : fallback.tab,
      selectedMemberId: parsed.selectedMemberId ? String(parsed.selectedMemberId) : null,
      running: parsed.running === true,
      lastRunAt: num(parsed.lastRunAt, 0) || 0,
      lastSummary: isObject(parsed.lastSummary) ? parsed.lastSummary : null,
    };
  }

  function saveUi(patch) {
    ui = deepMerge(ui, patch || {});
    try {
      window.localStorage.setItem(UI_KEY, JSON.stringify(ui));
    } catch (e) {
      /* 界面状态写失败不影响主流程 */
    }
  }

  // ───────────────────────────── 运行时状态 ─────────────────────────────

  var ui = readUi();
  var runtime = {
    enabled: false,
    busy: false,
    lastRunAt: ui.lastRunAt,
    lastSummary: ui.lastSummary,
  };
  var logs = [];
  var logRenderPending = false;
  var timer = null;
  var config = deepMerge(fallbackConfig(), {});
  var membersState = { version: 1, selectedId: null, items: [] };
  var modal = null;
  var els = {};

  function fallbackConfig() {
    var base = clone(FALLBACK_CONFIG);
    if (A && isObject(A.DEFAULTS)) {
      base = deepMerge(base, clone(A.DEFAULTS));
      // 界面口径固定为 19:00：后台默认值只兜底其它参数，不覆盖「每日执行时刻」
      base.unirun = deepMerge(isObject(base.unirun) ? base.unirun : {}, { runAt: FALLBACK_CONFIG.unirun.runAt });
    }
    return base;
  }

  // ───────────────────────────── 成员 / 配置适配 ─────────────────────────────

  function reloadMembers() {
    if (!hasFn(M, 'load')) {
      membersState = { version: 1, selectedId: null, items: [] };
      return membersState;
    }
    try {
      var loaded = M.load();
      membersState = isObject(loaded) && Array.isArray(loaded.items)
        ? loaded
        : { version: 1, selectedId: null, items: [] };
    } catch (e) {
      membersState = { version: 1, selectedId: null, items: [] };
      pushLog('error', '读取成员失败：' + sanitizeError(e));
    }
    return membersState;
  }

  function memberList() {
    return Array.isArray(membersState.items) ? membersState.items : [];
  }

  function getMember(id) {
    if (!id) return null;
    var items = memberList();
    for (var i = 0; i < items.length; i += 1) {
      if (items[i] && String(items[i].id) === String(id)) return items[i];
    }
    return null;
  }

  function reloadConfig() {
    var stored = {};
    try {
      if (hasFn(M, 'loadGlobalConfig')) stored = M.loadGlobalConfig() || {};
      else if (hasFn(M, 'effectiveConfig')) stored = M.effectiveConfig(null) || {};
    } catch (e) {
      pushLog('warn', '读取全局配置失败，使用默认值：' + sanitizeError(e));
    }
    config = deepMerge(fallbackConfig(), isObject(stored) ? stored : {});
    // 预览模式已下线：不管外部写进来什么，界面口径一律是真实执行
    config.dryRun = false;
    return config;
  }

  /** 写全局配置；返回 false 时调用方必须回滚界面并提示。 */
  function saveGlobalConfig(patch) {
    try {
      if (hasFn(M, 'saveGlobalConfig')) M.saveGlobalConfig(patch);
      else if (hasFn(M, 'saveConfig')) M.saveConfig(null, patch);
      else {
        pushLog('error', '设置没保存上：本机数据服务不可用，请重启软件再试');
        return false;
      }
      reloadConfig();
      return true;
    } catch (e) {
      pushLog('error', '配置保存失败：' + sanitizeError(e));
      return false;
    }
  }

  function cfgGet(path) {
    return path.split('.').reduce(function (acc, key) {
      return acc && acc[key] !== undefined ? acc[key] : undefined;
    }, config);
  }

  function cfgNum(path, fallback) {
    return num(cfgGet(path), fallback === undefined ? null : fallback);
  }

  function cfgText(path) {
    var value = cfgGet(path);
    return value === null || value === undefined ? '' : String(value);
  }

  function cfgBool(path) {
    return cfgGet(path) === true;
  }

  function cfgKeywords(path) {
    var value = cfgGet(path);
    if (Array.isArray(value)) return value.join(',');
    return value === null || value === undefined ? '' : String(value);
  }

  function pathPatch(path, value) {
    var parts = path.split('.');
    var patch = {};
    var cursor = patch;
    parts.forEach(function (key, index) {
      if (index === parts.length - 1) cursor[key] = value;
      else {
        cursor[key] = {};
        cursor = cursor[key];
      }
    });
    return patch;
  }

  /* 执行历史必须带成员归属，否则多人统计会静默全空。 */
  function loadResultEvents() {
    if (!hasFn(M, 'loadResults')) {
      pushLog('error', '读取执行记录失败：本机数据服务不可用，请重启软件再试');
      return [];
    }
    try {
      var list = M.loadResults();
      if (Array.isArray(list)) return list.slice();
      if (isObject(list) && Array.isArray(list.events)) return list.events.slice();
      return [];
    } catch (e) {
      pushLog('warn', '读取执行历史失败：' + sanitizeError(e));
      return [];
    }
  }

  function engineStorageFor(memberId) {
    try {
      if (hasFn(M, 'engineStorage')) return M.engineStorage(memberId);
    } catch (e) {
      /* ignore */
    }
    return null;
  }

  /** 该成员二课积分条目：{ snapshot, refreshedAt } | null */
  function scoreEntryFor(member) {
    if (!member) return null;
    var store = engineStorageFor(member.id);
    if (!store || typeof store.get !== 'function') return null;
    var parsed;
    try {
      parsed = parseJson(store.get('auto3ct:scores'));
    } catch (e) {
      return null;
    }
    var accounts = isObject(parsed) && isObject(parsed.accounts) ? parsed.accounts : {};
    var keys = Object.keys(accounts);
    if (!keys.length) return null;
    var accountKey = ekAccountOf(member);
    var entry = accountKey && accounts[accountKey] ? accounts[accountKey] : accounts[keys[0]];
    if (!isObject(entry)) return null;
    return { snapshot: entry.snapshot || null, refreshedAt: num(entry.refreshedAt) };
  }

  /* 官方同步成绩比本地旧快照新时，以官方为准。 */
  function scoreEntryForStat(member) {
    var entry = scoreEntryFor(member);
    if (!entry) return null;
    var snapshotAt = num(entry.refreshedAt, 0) || num(entry.snapshot && entry.snapshot.updatedAt, 0) || 0;
    var officialAt = memberModulesUpdatedAt(member);
    if (officialAt && snapshotAt && officialAt > snapshotAt) return null;
    return entry;
  }

  function ekAccountOf(member) {
    if (!member) return '';
    var loginName = member.ek && member.ek.user_info && member.ek.user_info.loginName;
    if (loginName) return String(loginName);
    if (member.ekCredentials && member.ekCredentials.studentId) return String(member.ekCredentials.studentId);
    var studentId = member.ek && member.ek.user_info && member.ek.user_info.studentId;
    return studentId ? String(studentId) : '';
  }

  function ekBadge(member, testid) {
    var id = member && member.id ? String(member.id) : '';
    if (!member) return h('span', { class: 'one-ct-badge', text: '未登录' });
    var status = text(member.ekStatus);
    var account = ekAccountOf(member);
    if (status === 'expired') {
      return h('span', { class: 'one-ct-badge one-ct-badge--warn', 'data-testid': testid || 'one-ct-ek-status' + (id ? '-' + id : '') }, [
        h('span', { text: '需重新登录' }),
      ]);
    }
    if (status === 'ok' || (member.ek && member.ek.JSESSIONID)) {
      return h('span', { class: 'one-ct-badge one-ct-badge--ok', 'data-testid': testid || 'one-ct-ek-status' + (id ? '-' + id : '') }, [
        h('span', { text: account ? '已登录 · ' : '已登录' }),
        account ? h('span', { class: 'one-ct-mono', text: account }) : null,
      ]);
    }
    return h('span', { class: 'one-ct-badge', 'data-testid': testid || 'one-ct-ek-status' + (id ? '-' + id : '') }, [
      h('span', { text: '未登录' }),
    ]);
  }

  // ───────────────────────────── 日志 ─────────────────────────────

  function pushLog(kind, message, meta) {
    logs.push({
      at: Date.now(),
      kind: kind || 'info',
      text: text(message).slice(0, 400),
      memberId: meta && meta.memberId ? String(meta.memberId) : '',
      memberName: meta && meta.memberName ? String(meta.memberName) : '',
    });
    if (logs.length > MAX_LOG) logs = logs.slice(-MAX_LOG);
    scheduleLogsRender();
  }

  function scheduleLogsRender() {
    if (logRenderPending) return;
    logRenderPending = true;
    var run = function () {
      logRenderPending = false;
      if (ui.tab === 'logs') renderLogsIntoCurrentView();
    };
    if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(run);
    else setTimeout(run, 20);
  }

  function reasonCn(reason) {
    var code = trim(reason);
    if (!code) return '';
    return REASON_CN[code] ? REASON_CN[code] + '(' + code + ')' : code;
  }

  function rowText(row) {
    var module = MODULE_CN[row.module] || trim(row.module) || '未知';
    var action = ACTION_CN[row.action] || trim(row.action) || '';
    var status = STATUS_CN[row.status] || trim(row.status) || '状态未知';
    var name = trim(row.activityName || row.name);
    if (name.length > 40) name = name.slice(0, 40) + '…';
    if (!name && row.activityId) name = '活动#' + trim(row.activityId).slice(0, 8);
    var parts = [module + action];
    if (name) parts.push(name);
    parts.push(status);
    var reason = reasonCn(row.reason);
    if (reason) parts.push(reason);
    return parts.join('｜');
  }

  function eventKind(event) {
    var status = trim(event && event.status);
    if (status === 'success') return 'success';
    if (status === 'failed' || status === 'unknown') return 'error';
    if (status === 'blocked' || status === 'skipped' || status === 'legacy') return 'warn';
    return 'info';
  }

  /** 把本机执行历史灌进日志页（同一事件去重，重复点击「刷新历史」不会翻倍） */
  function hydrateLogsFromHistory() {
    var events = loadResultEvents();
    if (!Array.isArray(events) || !events.length) return 0;
    var seen = Object.create(null);
    logs.forEach(function (entry) {
      seen[entry.at + '|' + entry.kind + '|' + entry.text + '|' + entry.memberId] = true;
    });
    var added = 0;
    events.forEach(function (event) {
      if (!isObject(event)) return;
      var entry = {
        at: num(event.at, 0) || 0,
        kind: eventKind(event),
        text: rowText(event),
        memberId: text(event.memberId),
        memberName: text(event.memberName),
      };
      var key = entry.at + '|' + entry.kind + '|' + entry.text + '|' + entry.memberId;
      if (seen[key]) return;
      seen[key] = true;
      logs.push(entry);
      added += 1;
    });
    if (added) {
      logs.sort(function (a, b) {
        return a.at - b.at;
      });
      if (logs.length > MAX_LOG) logs = logs.slice(-MAX_LOG);
    }
    return added;
  }

  function groupedLogs() {
    var groups = Object.create(null);
    logs.forEach(function (entry) {
      var key = entry.memberId || '_global';
      if (!groups[key]) {
        groups[key] = {
          memberId: entry.memberId || '',
          memberName: entry.memberName || (entry.memberId ? '' : '全局'),
          entries: [],
        };
      }
      if (!groups[key].memberName && entry.memberName) groups[key].memberName = entry.memberName;
      groups[key].entries.push(entry);
    });
    var list = Object.keys(groups).map(function (key) {
      var group = groups[key];
      if (!group.memberName) {
        var member = getMember(group.memberId);
        group.memberName = member ? text(member.name) || group.memberId : group.memberId || '全局';
      }
      group.entries.sort(function (a, b) {
        return b.at - a.at;
      });
      group.latestAt = group.entries.length ? group.entries[0].at : 0;
      return group;
    });
    // 全局组置顶，其余按最近时间倒序
    list.sort(function (a, b) {
      if (!a.memberId !== !b.memberId) return a.memberId ? 1 : -1;
      return b.latestAt - a.latestAt;
    });
    return list;
  }

  function memberColor(memberId) {
    if (!memberId) return '#a1a1aa';
    var items = memberList();
    for (var i = 0; i < items.length; i += 1) {
      if (String(items[i].id) === String(memberId)) return PALETTE[i % PALETTE.length];
    }
    return PALETTE[0];
  }

  // ───────────────────────────── 二维码本地解码（jsQR） ─────────────────────────────

  function decodeQrFromUrl(url) {
    return new Promise(function (resolve, reject) {
      if (typeof window.jsQR !== 'function') {
        reject(new Error('jsQR 未加载，无法本地解码二维码'));
        return;
      }
      var settled = false;
      var timer = setTimeout(function () {
        finish(new Error('二维码解码超时（15 秒）'));
      }, DECODE_TIMEOUT_MS);
      var img = new Image();

      function finish(err, value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        img.onload = null;
        img.onerror = null;
        if (err) reject(err);
        else resolve(value);
      }

      img.crossOrigin = 'Anonymous';
      img.onload = function () {
        try {
          var width = img.naturalWidth || img.width;
          var height = img.naturalHeight || img.height;
          if (!width || !height) {
            finish(new Error('图片像素为 0'));
            return;
          }
          if (width * height > MAX_IMAGE_PIXELS || width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE) {
            finish(new Error('图片像素过大（' + width + 'x' + height + '），已拒绝解码'));
            return;
          }
          var canvas = document.createElement('canvas');
          var ctx = canvas.getContext('2d');
          if (!ctx) {
            finish(new Error('Canvas 不可用'));
            return;
          }
          canvas.width = width;
          canvas.height = height;
          ctx.drawImage(img, 0, 0);
          var imageData = ctx.getImageData(0, 0, width, height);
          var code = window.jsQR(imageData.data, width, height, { inversionAttempts: 'attemptBoth' });
          finish(null, code ? code.data : null);
        } catch (e) {
          finish(e);
        }
      };
      img.onerror = function () {
        finish(new Error('图片加载失败（可能跨域或 URL 无效）'));
      };
      try {
        img.src = url;
      } catch (e) {
        finish(e);
      }
    });
  }

  // ───────────────────────────── 运行控制 ─────────────────────────────

  /* 预览模式已下线：界面上不再有开关，运行一律真实执行。 */
  function dryRunEnabled() {
    return false;
  }

  function enabledMembers() {
    return memberList().filter(function (member) {
      return member && member.enabled === true;
    });
  }

  function startBlocker() {
    var blockers = [];
    if (!hasFn(M, 'runAll')) blockers.push('本机数据服务还没准备好，请重启软件再试');
    if (!window.ctAPI) blockers.push('软件后台服务没连上，请重启软件再试');
    if (!enabledMembers().length) blockers.push('没有已启用的成员');
    if (!cfgBool('ek.enabled') && !cfgBool('unirun.enabled') && !cfgBool('club.enabled')) {
      blockers.push('没有启用任何业务模块');
    }
    return blockers.join('；');
  }

  function summarizeRows(rows) {
    var summary = { total: rows.length, success: 0, failed: 0, unknown: 0, waiting: 0, dryRun: 0, skipped: 0 };
    rows.forEach(function (row) {
      var status = trim(row && row.status);
      if (status === 'success') summary.success += 1;
      else if (status === 'failed') summary.failed += 1;
      else if (status === 'unknown') summary.unknown += 1;
      else if (status === 'dry-run') summary.dryRun += 1;
      else if (status === 'skipped' || status === 'blocked') summary.skipped += 1;
      else summary.waiting += 1;
    });
    return summary;
  }

  function summaryText(summary) {
    if (!summary) return '本轮摘要：—';
    return (
      '本轮：成功 ' + (summary.success || 0) +
      ' · 失败 ' + (summary.failed || 0) +
      ' · 未知 ' + (summary.unknown || 0) +
      ' · 等待 ' + (summary.waiting || 0) +
      (summary.dryRun ? ' · 预览（历史） ' + summary.dryRun : '') +
      (summary.skipped ? ' · 跳过 ' + summary.skipped : '')
    );
  }

  function renderStatus() {
    if (els.statusText) {
      var label;
      if (runtime.enabled && runtime.busy) label = '运行中';
      else if (runtime.busy) label = '执行中（单轮）';
      else if (runtime.enabled) label = '已启用：按间隔自动执行';
      else label = '未启动';
      els.statusText.textContent = label;
    }
    if (els.statusDot) {
      els.statusDot.classList.toggle('is-live', runtime.enabled && !runtime.busy);
      els.statusDot.classList.toggle('is-busy', runtime.busy);
    }
    if (els.startStopBtn) {
      els.startStopBtn.textContent = runtime.enabled ? '停止' : '启动';
      els.startStopBtn.classList.toggle('one-ct-btn--primary', !runtime.enabled);
      els.startStopBtn.setAttribute('data-running', runtime.enabled ? '1' : '0');
    }
    renderFooter();
    renderRunControlsIfVisible();
  }

  function renderFooter() {
    if (els.lastRun) {
      els.lastRun.textContent = runtime.lastRunAt
        ? '上次运行：' + formatDateTime(runtime.lastRunAt)
        : '上次运行：尚未运行';
    }
    if (els.summary) {
      els.summary.textContent = runtime.lastRunAt ? summaryText(runtime.lastSummary) : '本轮摘要：—';
    }
  }

  function renderRunControlsIfVisible() {
    if (ui.tab !== 'run' || !els.runView) return;
    var btn = els.runView.querySelector('[data-testid="one-ct-run-start-stop"]');
    if (btn) {
      btn.textContent = runtime.enabled ? '停止自动运行' : '启动自动运行';
      btn.classList.toggle('one-ct-btn--primary', !runtime.enabled);
    }
    var label = els.runView.querySelector('[data-testid="one-ct-run-state"]');
    if (label) {
      label.textContent = runtime.busy
        ? '正在执行本轮（请稍候）'
        : runtime.enabled
          ? '已启用：按间隔自动执行'
          : '未启动';
    }
    var count = els.runView.querySelector('[data-testid="one-ct-participant-count"]');
    if (count) count.textContent = String(enabledMembers().length);
    var once = els.runView.querySelector('[data-testid="one-ct-run-once"]');
    if (once) once.disabled = runtime.busy;
  }

  function nextIntervalMs() {
    var waiting = runtime.lastSummary ? runtime.lastSummary.waiting || 0 : 0;
    var seconds = waiting > 0 ? cfgNum('windowTickSec', 20) : cfgNum('tickSec', 60);
    return Math.max(15, num(seconds, 60)) * 1000;
  }

  function clearRunTimer() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function scheduleNext() {
    clearRunTimer();
    if (!runtime.enabled) return;
    timer = setTimeout(function () {
      timer = null;
      if (runtime.enabled) runRound(false);
    }, nextIntervalMs());
  }

  function onEngineResult(row) {
    if (!isObject(row)) return;
    var memberId = text(row.memberId);
    var member = memberId ? getMember(memberId) : null;
    pushLog(eventKind(row), rowText(row), {
      memberId: memberId,
      memberName: text(row.memberName) || (member ? text(member.name) : ''),
    });
  }

  function runRound(manual) {
    if (runtime.busy) {
      pushLog('warn', '上一轮仍在执行，已忽略本次操作（防并发）');
      return;
    }
    if (!hasFn(M, 'runAll')) {
      pushLog('error', '没法开始运行：本机数据服务不可用，请重启软件再试');
      return;
    }
    if (!window.ctAPI) {
      pushLog('error', 'window.ctAPI 不可用：请确认运行在 1CT 渲染进程内');
      return;
    }
    if (!manual) {
      var blocker = startBlocker();
      if (blocker) {
        pushLog('error', '本轮已跳过：' + blocker);
        if (runtime.enabled) {
          runtime.enabled = false;
          clearRunTimer();
          saveUi({ running: false });
          renderStatus();
        }
        return;
      }
    }
    runtime.busy = true;
    var startedAt = Date.now();
    renderStatus();
    // 运行前自动同步官方成绩（默认开；失败不阻断本轮）
    Promise.resolve()
      .then(function () {
        return maybeAutoSyncScores();
      })
      .then(function () {
        return runAllOnce(startedAt);
      })
      .catch(function (e) {
        runtime.busy = false;
        pushLog('error', '运行失败：' + sanitizeError(e));
        renderStatus();
        if (runtime.enabled) scheduleNext();
      });
  }

  /** runAll 的实际执行 + 结果汇总（与自动同步解耦，便于测试单独触发） */
  function runAllOnce(startedAt) {
    var promise;
    try {
      promise = M.runAll({
        api: window.ctAPI,
        clock: { now: function () { return Date.now(); } },
        decodeQr: decodeQrFromUrl,
        logger: {
          log: function (message, meta) {
            pushLog('engine', message, isObject(meta) ? meta : null);
          },
        },
        onResult: onEngineResult,
      });
    } catch (e) {
      runtime.busy = false;
      pushLog('error', '运行失败：' + sanitizeError(e));
      renderStatus();
      return Promise.resolve();
    }
    return Promise.resolve(promise)
      .then(function (result) {
        if (result && result.busy) {
          pushLog('warn', '上一轮还在跑，这次先跳过');
          return;
        }
        var rows = result && Array.isArray(result.results) ? result.results : [];
        runtime.lastRunAt = Date.now();
        runtime.lastSummary = summarizeRows(rows);
        saveUi({ lastRunAt: runtime.lastRunAt, lastSummary: runtime.lastSummary });
        pushLog(
          'info',
          '本轮耗时 ' + Math.max(0, Date.now() - startedAt) + ' 毫秒 · ' + summaryText(runtime.lastSummary),
        );
      })
      .catch(function (e) {
        pushLog('error', '运行异常：' + sanitizeError(e));
      })
      .then(function () {
        runtime.busy = false;
        renderStatus();
        if (runtime.enabled) scheduleNext();
      });
  }

  function startRun() {
    if (runtime.enabled) return;
    var blocker = startBlocker();
    if (blocker) {
      pushLog('error', '无法启动：' + blocker);
      if (ui.tab === 'run') renderView();
      return;
    }
    runtime.enabled = true;
    saveUi({ running: true });
    pushLog('info', '已启动（到点自动执行）');
    renderStatus();
    runRound(false);
  }

  function stopRun() {
    if (!runtime.enabled) return;
    runtime.enabled = false;
    clearRunTimer();
    saveUi({ running: false });
    pushLog('info', '已停止（已发出的请求仍会完成并记录真实结果）');
    renderStatus();
  }

  function toggleRun() {
    if (runtime.enabled) stopRun();
    else startRun();
  }

  // ───────────────────────────── 顶栏 / 骨架 ─────────────────────────────

  // ───────────────────────────── 窗口控制（无边框窗口） ─────────────────────────────
  //
  // 主进程是 BrowserWindow({frame:false})：没有系统标题栏，
  // 所以最小化/最大化/关闭必须由渲染层自己画，否则用户只能右键任务栏关闭。
  // IPC 由 preload 暴露：ctAPI.system.window.{minimize,toggleMaximize,close}。
  // 缺失时（例如浏览器里预演）不渲染按钮，也不报错。

  function windowApi() {
    var api = window.ctAPI;
    if (!api || !api.system || !api.system.window) return null;
    var w = api.system.window;
    if (typeof w.minimize !== 'function' && typeof w.toggleMaximize !== 'function' && typeof w.close !== 'function') {
      return null;
    }
    return w;
  }

  function callWindowApi(method) {
    var w = windowApi();
    if (!w || typeof w[method] !== 'function') {
      pushLog('warn', '窗口按钮暂时用不了，请重启软件再试');
      return Promise.resolve(null);
    }
    try {
      return Promise.resolve(w[method]()).catch(function (e) {
        pushLog('warn', '窗口操作失败，请稍后再试：' + sanitizeError(e));
        return null;
      });
    } catch (e) {
      pushLog('warn', '窗口操作失败，请稍后再试：' + sanitizeError(e));
      return Promise.resolve(null);
    }
  }

  /** 内联 SVG 图标（无外部资源，1px 描边，与极简白风格一致） */
  function winIcon(kind) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 10 10');
    svg.setAttribute('width', '10');
    svg.setAttribute('height', '10');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.setAttribute('class', 'one-ct-win-icon');
    function line(x1, y1, x2, y2) {
      var el = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      el.setAttribute('x1', String(x1));
      el.setAttribute('y1', String(y1));
      el.setAttribute('x2', String(x2));
      el.setAttribute('y2', String(y2));
      el.setAttribute('stroke', 'currentColor');
      el.setAttribute('stroke-width', '1');
      el.setAttribute('stroke-linecap', 'round');
      svg.appendChild(el);
    }
    if (kind === 'minimize') {
      line(1.5, 5, 8.5, 5);
    } else if (kind === 'maximize') {
      var rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', '1.5');
      rect.setAttribute('y', '1.5');
      rect.setAttribute('width', '7');
      rect.setAttribute('height', '7');
      rect.setAttribute('fill', 'none');
      rect.setAttribute('stroke', 'currentColor');
      rect.setAttribute('stroke-width', '1');
      svg.appendChild(rect);
    } else if (kind === 'restore') {
      var back = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      back.setAttribute('x', '1.5');
      back.setAttribute('y', '3');
      back.setAttribute('width', '5.5');
      back.setAttribute('height', '5.5');
      back.setAttribute('fill', 'none');
      back.setAttribute('stroke', 'currentColor');
      back.setAttribute('stroke-width', '1');
      svg.appendChild(back);
      var front = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      front.setAttribute('x', '3.5');
      front.setAttribute('y', '1');
      front.setAttribute('width', '5.5');
      front.setAttribute('height', '5.5');
      front.setAttribute('fill', 'none');
      front.setAttribute('stroke', 'currentColor');
      front.setAttribute('stroke-width', '1');
      svg.appendChild(front);
    } else {
      line(1.5, 1.5, 8.5, 8.5);
      line(8.5, 1.5, 1.5, 8.5);
    }
    return svg;
  }

  function buildWindowControls() {
    var w = windowApi();
    if (!w) return null;

    var maximizeBtn = h('button', {
      class: 'one-ct-win-btn',
      type: 'button',
      'data-testid': 'one-ct-win-maximize',
      'aria-label': '最大化',
      title: '最大化 / 还原',
      onclick: function () {
        callWindowApi('toggleMaximize').then(function (result) {
          if (result && result.maximized !== undefined) setMaximizedState(Boolean(result.maximized));
        });
      },
    }, [winIcon('maximize')]);

    var minimizeBtn = h('button', {
      class: 'one-ct-win-btn',
      type: 'button',
      'data-testid': 'one-ct-win-minimize',
      'aria-label': '最小化',
      title: '最小化',
      onclick: function () {
        callWindowApi('minimize');
      },
    }, [winIcon('minimize')]);

    /* 「退至后台」：把关闭行为一次性固定为 tray，再走关闭流程。 */
    function closeToTray() {
      var api = window.ctAPI;
      var setter = api && api.appSettings && typeof api.appSettings.set === 'function'
        ? api.appSettings.set({ closeBehavior: 'tray' })
        : Promise.resolve(null);
      return Promise.resolve(setter)
        .catch(function (e) {
          pushLog('warn', '设置关闭行为失败（不影响关闭）：' + sanitizeError(e));
          return null;
        })
        .then(function () {
          return callWindowApi('close');
        });
    }

    var closeBtn = h('button', {
      class: 'one-ct-win-btn one-ct-win-btn--close',
      type: 'button',
      'data-testid': 'one-ct-win-close',
      'aria-label': '退至后台（最小化到托盘）',
      title: '退至后台：最小化到托盘继续运行，不会退出（从托盘图标恢复；真正退出请用托盘菜单）',
      onclick: function () {
        closeToTray();
      },
    }, [winIcon('close')]);

    els.winMaximizeBtn = maximizeBtn;
    els.winMinimizeBtn = minimizeBtn;
    els.winCloseBtn = closeBtn;

    return h('div', { class: 'one-ct-win-controls', 'data-testid': 'one-ct-win-controls' }, [
      minimizeBtn,
      maximizeBtn,
      closeBtn,
    ]);
  }

  /** 最大化状态只影响图标（□ ↔ 重叠方块）；拿不到状态时保持默认 */
  function setMaximizedState(maximized) {
    if (!els.winMaximizeBtn) return;
    els.winMaximizeBtn.setAttribute('aria-label', maximized ? '还原' : '最大化');
    els.winMaximizeBtn.title = maximized ? '还原窗口' : '最大化窗口';
    while (els.winMaximizeBtn.firstChild) els.winMaximizeBtn.removeChild(els.winMaximizeBtn.firstChild);
    els.winMaximizeBtn.appendChild(winIcon(maximized ? 'restore' : 'maximize'));
  }

  function buildShell() {
    var tabs = [
      { key: 'run', label: '运行' },
      { key: 'members', label: '成员' },
      { key: 'ek', label: '二课' },
      { key: 'records', label: '记录' },
      { key: 'logs', label: '日志' },
    ];
    els.tabButtons = {};
    var tabNodes = tabs.map(function (item) {
      var btn = h('button', {
        class: 'one-ct-tab' + (ui.tab === item.key ? ' is-active' : ''),
        type: 'button',
        role: 'tab',
        'aria-selected': ui.tab === item.key ? 'true' : 'false',
        'data-testid': 'one-ct-tab-' + item.key,
        'data-tab': item.key,
        text: item.label,
        onclick: function () {
          switchTab(item.key);
        },
      });
      els.tabButtons[item.key] = btn;
      return btn;
    });


    els.statusDot = h('span', { class: 'one-ct-dot' });
    els.statusText = h('span', { class: 'one-ct-num', 'data-testid': 'one-ct-status', text: '未启动' });
    els.startStopBtn = h('button', {
      class: 'one-ct-btn one-ct-btn--primary',
      type: 'button',
      'data-testid': 'one-ct-start-stop',
      text: '启动',
      onclick: toggleRun,
    });

    var helpBtn = h('button', {
      class: 'one-ct-btn one-ct-btn--sm one-ct-btn--ghost one-ct-help-btn',
      type: 'button',
      text: '使用说明',
      title: '再看一遍三步上手说明',
      'data-testid': 'one-ct-help-open',
      onclick: openOnboarding,
    });

    var winControls = buildWindowControls();

    var topbar = h('header', {
      class: 'one-ct-topbar',
      'data-testid': 'one-ct-topbar',
      // 无边框窗口：整条顶栏可拖动，交互控件在 CSS 里 no-drag
      title: '',
    }, [
      h('div', { class: 'one-ct-brand' }, [
        h('span', { class: 'one-ct-brand-mark', text: '1' }),
        h('span', { text: '1CT' }),
        h('span', { class: 'one-ct-brand-sub', text: '二课 · 校园跑 · 俱乐部' }),
      ]),
      h('nav', { class: 'one-ct-tabs', role: 'tablist', 'aria-label': '主功能' }, tabNodes),
      h('div', { class: 'one-ct-top-actions' }, [
        h('span', { class: 'one-ct-run-indicator' }, [els.statusDot, els.statusText]),
        helpBtn,
        els.startStopBtn,
      ]),
      winControls,
    ]);

    // 双击顶栏空白处 = 最大化/还原（与 Windows 原生标题栏一致；按钮/开关上不触发）
    topbar.addEventListener('dblclick', function (event) {
      if (!windowApi()) return;
      var target = event.target;
      // 只响应「非交互元素」区域：按钮、开关、选择器、输入框都不算
      if (target && target.closest && target.closest('button, input, select, textarea, label, a, [role="tab"]')) return;
      callWindowApi('toggleMaximize').then(function (result) {
        if (result && result.maximized !== undefined) setMaximizedState(Boolean(result.maximized));
      });
    });

    els.main = h('main', { class: 'one-ct-main', 'data-testid': 'one-ct-main' });
    els.lastRun = h('span', { 'data-testid': 'one-ct-last-run', text: '上次运行：尚未运行' });
    els.summary = h('span', { 'data-testid': 'one-ct-summary', text: '本轮摘要：—' });
    var footer = h('footer', { class: 'one-ct-footer', 'data-testid': 'one-ct-footer' }, [
      h('div', { class: 'one-ct-footer-side' }, [els.lastRun]),
      h('div', { class: 'one-ct-footer-side' }, [els.summary]),
    ]);

    return h('div', { class: 'one-ct-app', 'data-testid': 'one-ct-app' }, [topbar, els.main, footer]);
  }


  function switchTab(tab) {
    if (TAB_KEYS.indexOf(tab) < 0) return;
    saveUi({ tab: tab });
    Object.keys(els.tabButtons).forEach(function (key) {
      var active = key === tab;
      els.tabButtons[key].classList.toggle('is-active', active);
      els.tabButtons[key].setAttribute('aria-selected', active ? 'true' : 'false');
    });
    renderView();
  }

  function renderView() {
    if (!els.main) return;
    clear(els.main);
    els.runView = null;
    els.logsHost = null;
    if (ui.tab === 'members') renderMembersView();
    else if (ui.tab === 'ek') renderEkView();
    else if (ui.tab === 'records') renderRecordsView();
    else if (ui.tab === 'logs') renderLogsView();
    else renderRunView();
    renderFooter();
  }

  // ───────────────────────────── 表单构件 ─────────────────────────────

  /**
   * 只读行：用于「由程序自动决定、用户不需要也不应该手填」的参数（如校园跑随机窗口/里程）。
   * 渲染成 div（不是 input），因此不会被误当成可编辑控件；保留 testid 供测试断言存在。
   */
  function readonlyRow(labelText, valueText, testid, hint) {
    var box = h('div', {
      class: 'one-ct-readonly',
      'data-testid': testid,
      text: valueText,
    });
    return field(labelText, h('div', { class: 'one-ct-field-control' }, [box]), hint);
  }

  function field(label, control, hint) {
    var children = [h('span', { class: 'one-ct-field-label', text: label }), control];
    if (hint) children.push(h('span', { class: 'one-ct-field-hint', text: hint }));
    return h('div', { class: 'one-ct-field' }, children);
  }

  function switchControl(opts) {
    var box = h('input', { type: 'checkbox', 'data-testid': opts.testid || null });
    box.checked = Boolean(opts.checked);
    if (opts.disabled) box.disabled = true;
    box.addEventListener('change', function () {
      if (opts.onChange) opts.onChange(box.checked);
    });
    var label = h('label', { class: 'one-ct-switch', title: opts.title || '' }, [
      box,
      h('span', { class: 'one-ct-switch-track' }, [h('span', { class: 'one-ct-switch-knob' })]),
      opts.label ? h('span', { class: 'one-ct-switch-label', text: opts.label }) : null,
    ]);
    return { node: label, input: box };
  }

  function configSwitchField(path, labelText, testid, hint) {
    var ctl = switchControl({
      checked: cfgBool(path),
      testid: testid,
      onChange: function (checked) {
        if (saveGlobalConfig(pathPatch(path, checked))) {
          pushLog('info', '「' + labelText + '」已' + (checked ? '打开' : '关闭'));
          if (ui.tab === 'run') renderView();
        }
      },
    });
    return field(labelText, h('div', { class: 'one-ct-field-control' }, [ctl.node]), hint);
  }

  function configNumberField(labelText, path, min, max, step, testid, hint) {
    var input = h('input', {
      class: 'one-ct-input is-num',
      type: 'number',
      min: String(min),
      max: String(max),
      step: String(step || 1),
      value: String(cfgNum(path, min)),
      'data-testid': testid,
    });
    input.addEventListener('change', function () {
      var next = clampNumber(input.value, min, max);
      if (next === null) {
        input.value = String(cfgNum(path, min));
        pushLog('warn', '「' + labelText + '」输入不是有效数字，已还原');
        return;
      }
      if (next !== Number(input.value)) pushLog('warn', '「' + labelText + '」超出范围，已修正为 ' + next);
      input.value = String(next);
      if (saveGlobalConfig(pathPatch(path, next))) pushLog('info', '「' + labelText + '」已保存：' + next);
    });
    return field(labelText, h('div', { class: 'one-ct-field-control' }, [input]), hint);
  }

  function configKeywordField(labelText, path, testid) {
    var input = h('input', {
      class: 'one-ct-input is-flex',
      type: 'text',
      value: cfgKeywords(path),
      placeholder: '如 讲座,志愿（逗号分隔；留空需开「允许全部」）',
      'data-testid': testid,
    });
    input.addEventListener('change', function () {
      var keywords = input.value
        .split(/[,，;；\s]+/)
        .map(function (item) {
          return item.trim();
        })
        .filter(Boolean);
      if (saveGlobalConfig(pathPatch(path, keywords))) {
        pushLog('info', '关键词已保存：' + (keywords.join('、') || '（空）'));
      }
    });
    return field(labelText, h('div', { class: 'one-ct-field-control' }, [input]));
  }

  function configTimeField(labelText, path, testid, hint) {
    var input = h('input', {
      class: 'one-ct-input is-num',
      type: 'text',
      inputmode: 'numeric',
      value: cfgText(path) || '19:00',
      placeholder: '如 19:00',
      'data-testid': testid,
    });
    input.addEventListener('change', function () {
      var value = input.value.trim();
      if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(value)) {
        input.value = cfgText(path) || '19:00';
        pushLog('warn', '「' + labelText + '」请按 19:00 这样的格式填写，已还原');
        return;
      }
      if (saveGlobalConfig(pathPatch(path, value))) pushLog('info', '「' + labelText + '」已保存：' + value);
    });
    return field(labelText, h('div', { class: 'one-ct-field-control' }, [input]), hint);
  }

  function moduleCard(opts) {
    return h('section', { class: 'one-ct-card one-ct-card--module', 'data-testid': opts.testid }, [
      h('div', { class: 'one-ct-card-head' }, [
        h('div', { class: 'one-ct-card-head-main' }, [
          h('div', { class: 'one-ct-card-title', text: opts.title }),
          h('div', { class: 'one-ct-card-sub', text: opts.sub }),
        ]),
        h('div', { class: 'one-ct-card-head-actions' }, [opts.switchNode]),
      ]),
      h('div', { class: 'one-ct-card-body' }, opts.rows),
    ]);
  }

  function moduleSwitch(path, testid, label, title) {
    return switchControl({
      checked: cfgBool(path),
      testid: testid,
      label: label || '启用',
      title: title || '',
      onChange: function (checked) {
        if (saveGlobalConfig(pathPatch(path, checked))) {
          pushLog('info', (title || '该模块') + '已' + (checked ? '打开' : '关闭'));
          if (ui.tab === 'run') renderView();
        }
      },
    });
  }

  // ───────────────────────────── 运行页 ─────────────────────────────

  function renderRunView() {
    reloadMembers();
    reloadConfig();

    var startBtn = h('button', {
      class: 'one-ct-btn one-ct-btn--primary',
      type: 'button',
      'data-testid': 'one-ct-run-start-stop',
      text: runtime.enabled ? '停止自动运行' : '启动自动运行',
      onclick: toggleRun,
    });
    var runOnceBtn = h('button', {
      class: 'one-ct-btn',
      type: 'button',
      text: '立即运行一轮',
      'data-testid': 'one-ct-run-once',
      onclick: function () {
        runRound(true);
      },
    });
    var statusCard = h('section', { class: 'one-ct-card', 'data-testid': 'one-ct-run-status' }, [
      h('div', { class: 'one-ct-card-head' }, [
        h('div', { class: 'one-ct-card-head-main' }, [
          h('div', { class: 'one-ct-card-title', text: '自动运行' }),
          h('div', { class: 'one-ct-card-sub', text: '按成员一个一个跑，到点自动执行；启动后就是真实提交' }),
        ]),
        h('div', { class: 'one-ct-card-head-actions' }, [startBtn, runOnceBtn]),
      ]),
      h('div', { class: 'one-ct-card-body' }, [
        h('div', { class: 'one-ct-row' }, [
          h('span', {
            class: 'one-ct-run-state' + (runtime.enabled ? ' is-live' : ''),
            'data-testid': 'one-ct-run-state',
            text: runtime.busy
              ? '正在执行本轮（请稍候）'
              : runtime.enabled
                ? '已启用：按间隔自动执行'
                : '未启动',
          }),
        ]),
        h('div', {
          class: 'one-ct-hint',
          text:
            '常规间隔 ' + Math.round(cfgNum('tickMs', 60000) / 1000) + ' 秒（窗口内 ' +
            Math.round(cfgNum('windowTickMs', 20000) / 1000) + ' 秒）· 设置只保存在本机',
        }),
      ]),
    ]);

    // ── 参与成员 ──
    var total = memberList().length;
    var participantsBody;
    if (!total) {
      participantsBody = h('div', { class: 'one-ct-empty', 'data-testid': 'one-ct-participants-empty' }, [
        h('div', { class: 'one-ct-empty-title', text: '还没有成员' }),
        h('div', { text: '先到「成员」页新增账号，运行时会按成员逐一执行。' }),
        h('div', { class: 'one-ct-empty-actions' }, [
          h('button', {
            class: 'one-ct-btn one-ct-btn--primary',
            type: 'button',
            text: '去新增成员',
            'data-testid': 'one-ct-goto-members',
            onclick: function () {
              switchTab('members');
            },
          }),
        ]),
      ]);
    } else {
      var checkItems = memberList().map(function (member) {
        var memberId = text(member.id);
        var box = h('input', { type: 'checkbox', 'data-testid': 'one-ct-participant-' + memberId });
        box.checked = member.enabled === true;
        box.addEventListener('change', function () {
          try {
            var next = clone(member);
            next.enabled = box.checked;
            next.updatedAt = Date.now();
            M.upsertMember(next);
            reloadMembers();
            pushLog('info', '成员「' + (text(member.name) || memberId) + '」已' + (box.checked ? '加入' : '移出') + '自动运行');
            renderRunControlsIfVisible();
          } catch (e) {
            box.checked = !box.checked;
            pushLog('error', '成员开关保存失败：' + sanitizeError(e));
          }
        });
        var subParts = [];
        if (member.ekStatus === 'ok') subParts.push('二课已登录');
        else if (member.ekStatus === 'expired') subParts.push('二课需重新登录');
        else subParts.push('二课未登录');
        subParts.push(member.unirun && member.unirun.phone ? '校园跑 ' + maskPhone(member.unirun.phone) : '校园跑未配置');
        return h('label', { class: 'one-ct-check-item', 'data-testid': 'one-ct-participant-item-' + memberId }, [
          box,
          h('span', { class: 'one-ct-avatar', text: (text(member.name) || memberId).slice(0, 1) }),
          h('span', { class: 'one-ct-check-item-main' }, [
            h('span', { class: 'one-ct-check-item-name', text: text(member.name) || memberId }),
            h('span', { class: 'one-ct-check-item-sub', text: subParts.join(' · ') }),
          ]),
        ]);
      });
      participantsBody = h('div', { class: 'one-ct-stack' }, [
        h('div', { class: 'one-ct-row one-ct-row--between' }, [
          h('div', { class: 'one-ct-hint' }, [
            '已选 ',
            h('strong', { class: 'one-ct-num', 'data-testid': 'one-ct-participant-count', text: String(enabledMembers().length) }),
            ' / ' + total + ' 名成员参与自动运行（勾选就等于让这位成员参加）',
          ]),
          h('button', {
            class: 'one-ct-btn one-ct-btn--sm',
            type: 'button',
            text: '全选',
            'data-testid': 'one-ct-participant-all',
            onclick: function () {
              memberList().forEach(function (member) {
                if (member.enabled === true) return;
                try {
                  var next = clone(member);
                  next.enabled = true;
                  next.updatedAt = Date.now();
                  M.upsertMember(next);
                } catch (e) {
                  /* 单个失败不阻断其余成员 */
                }
              });
              reloadMembers();
              renderView();
            },
          }),
        ]),
        h('div', { class: 'one-ct-check-list', 'data-testid': 'one-ct-participants' }, checkItems),
      ]);
    }

    var participantsCard = h('section', { class: 'one-ct-card', 'data-testid': 'one-ct-participants-card' }, [
      h('div', { class: 'one-ct-card-head' }, [
        h('div', { class: 'one-ct-card-head-main' }, [
          h('div', { class: 'one-ct-card-title', text: '参与成员' }),
          h('div', { class: 'one-ct-card-sub', text: '默认全选已启用的成员；取消勾选后这位成员本轮和以后都不跑' }),
        ]),
      ]),
      h('div', { class: 'one-ct-card-body' }, [participantsBody]),
    ]);

    // ── 三大模块 ──
    var ekCard = moduleCard({
      title: '二课',
      sub: '自动报名、签到、签退（按关键词挑活动，按积分缺口优先）',
      testid: 'one-ct-module-ek-card',
      switchNode: moduleSwitch('ek.enabled', 'one-ct-module-ek', '启用', '二课自动业务').node,
      rows: [
        configKeywordField('活动关键词', 'ek.keywords', 'one-ct-ek-keywords'),
        configSwitchField('ek.allowAll', '关键词留空时全部参加', 'one-ct-ek-allowall', '仍然受下面的每日报名上限限制'),
        configNumberField('每日报名上限', 'ek.dailyLimit', 1, 20, 1, 'one-ct-ek-dailylimit', '一天累计不超过这个数，不会越报越多'),
        configNumberField('二维码延迟（分钟）', 'ek.qrDelayMinutes', 0, 60, 1, 'one-ct-ek-qrdelay', '签到开始后等几分钟再去取二维码'),
        configNumberField('重试间隔（分钟）', 'ek.qrRetryMinutes', 0, 60, 1, 'one-ct-ek-qrretry'),
        configNumberField('每阶段最多尝试', 'ek.qrMaxAttempts', 1, 10, 1, 'one-ct-ek-qrmax'),
        readonlyRow('兜底照片', '已内置（图库没有图时自动使用）', 'one-ct-ek-fallback-status'),
        h('div', { class: 'one-ct-hint', text: '扫码、拍照、定位签到都会自动完成：照片优先用活动图库，图库没图就用内置图片。需要现场验证码的活动一律不报名。' }),
      ],
    });

    var unirunCard = moduleCard({
      title: '校园跑',
      sub: '每天到点后，按每位成员的校园跑账号提交一次跑步记录',
      testid: 'one-ct-module-unirun-card',
      switchNode: moduleSwitch('unirun.enabled', 'one-ct-module-unirun', '启用', '校园跑自动业务').node,
      rows: [
        configTimeField('每日执行时刻', 'unirun.runAt', 'one-ct-unirun-runat', '每天几点开始尝试提交，本机时区'),
        readonlyRow('有效窗口', '自动随机 39–48 分钟（当天固定，换天重新随机）', 'one-ct-unirun-window'),
        readonlyRow('里程', '自动随机约 1000 米，末位不是 0（1000、1100 会被平台作废）', 'one-ct-unirun-distance'),
        readonlyRow('时长', '自动随机 31–39 分钟（避开 5 的倍数，当天固定）', 'one-ct-unirun-time'),
        h('div', { class: 'one-ct-hint', text: '账号和校区在「成员」页按成员填写。' }),
      ],
    });

    var clubCard = moduleCard({
      title: '俱乐部',
      sub: '自动报名、签到、签退（和校园跑用同一个账号）',
      testid: 'one-ct-module-club-card',
      switchNode: moduleSwitch('club.enabled', 'one-ct-module-club', '启用', '俱乐部自动业务').node,
      rows: [
        configKeywordField('活动关键词', 'club.keywords', 'one-ct-club-keywords'),
        configSwitchField('club.allowAll', '关键词留空时全部参加', 'one-ct-club-allowall', '仍然受下面的每日报名上限限制'),
        configNumberField('每日报名上限', 'club.dailyJoinLimit', 1, 20, 1, 'one-ct-club-dailylimit'),
      ],
    });

    var advancedCard = h('section', { class: 'one-ct-card', 'data-testid': 'one-ct-run-advanced' }, [
      h('div', { class: 'one-ct-card-head' }, [
        h('div', { class: 'one-ct-card-head-main' }, [
          h('div', { class: 'one-ct-card-title', text: '检查频率与成绩同步' }),
          h('div', { class: 'one-ct-card-sub', text: '这些设置只保存在本机，不会上传' }),
        ]),
      ]),
      h('div', { class: 'one-ct-card-body' }, [
        configSwitchField(
          'ek.scorePolicy.refreshOnStart',
          '启动时自动同步成绩',
          'one-ct-sync-on-start',
          '某位成员超过 ' + Math.round(AUTO_SYNC_INTERVAL_MS / 3600000) + ' 小时没同步过，就会在下一轮开始前自动去二课官网拉一次分数',
        ),
        field('常规检查间隔（秒，不小于 15）', h('div', { class: 'one-ct-field-control' }, [tickInput()]), '平时隔多久看一次'),
        field('窗口内检查间隔（秒，不小于 15）', h('div', { class: 'one-ct-field-control' }, [windowTickInput()]), '有正在等的签到或签退时，查得更勤一点'),
      ]),
    ]);

    var view = h('div', { class: 'one-ct-view', 'data-testid': 'one-ct-run-view' }, [
      statusCard,
      participantsCard,
      h('div', { class: 'one-ct-grid' }, [ekCard, unirunCard, clubCard]),
      advancedCard,
    ]);
    els.main.appendChild(view);
    els.runView = view;
  }

  function tickInput() {
    var input = h('input', {
      class: 'one-ct-input is-num',
      type: 'number',
      min: '15',
      max: '3600',
      step: '5',
      value: String(Math.round(cfgNum('tickMs', 60000) / 1000)),
      'data-testid': 'one-ct-tick-sec',
    });
    input.addEventListener('change', function () {
      var seconds = clampNumber(input.value, 15, 3600);
      if (seconds === null) {
        input.value = String(Math.round(cfgNum('tickMs', 60000) / 1000));
        return;
      }
      input.value = String(seconds);
      if (saveGlobalConfig({ tickMs: seconds * 1000 })) pushLog('info', '轮询间隔已保存：' + seconds + ' 秒');
    });
    return input;
  }

  function windowTickInput() {
    var input = h('input', {
      class: 'one-ct-input is-num',
      type: 'number',
      min: '15',
      max: '600',
      step: '5',
      value: String(Math.round(cfgNum('windowTickMs', 20000) / 1000)),
      'data-testid': 'one-ct-window-tick-sec',
    });
    input.addEventListener('change', function () {
      var seconds = clampNumber(input.value, 15, 600);
      if (seconds === null) {
        input.value = String(Math.round(cfgNum('windowTickMs', 20000) / 1000));
        return;
      }
      input.value = String(seconds);
      if (saveGlobalConfig({ windowTickMs: seconds * 1000 })) pushLog('info', '窗口内间隔已保存：' + seconds + ' 秒');
    });
    return input;
  }

  // ───────────────────────────── 成员页 ─────────────────────────────

  function moduleGap(module) {
    var required = num(module && module.required);
    var current = num(module && module.current);
    if (required === null || current === null) return null;
    return Math.max(0, required - current);
  }

  function memberTotalGap(member) {
    var modules = member && Array.isArray(member.ekModules) ? member.ekModules : [];
    if (!modules.length) return null;
    var total = 0;
    var any = false;
    modules.forEach(function (module) {
      var gap = moduleGap(module);
      if (gap !== null) {
        total += gap;
        any = true;
      }
    });
    return any ? total : null;
  }

  function moduleDefs(member) {
    var defs = POLICY && Array.isArray(POLICY.MODULES) && POLICY.MODULES.length ? POLICY.MODULES : FALLBACK_MODULES;
    var existing = member && Array.isArray(member.ekModules) ? member.ekModules : null;
    return defs.map(function (def) {
      var found = null;
      if (existing) {
        for (var i = 0; i < existing.length; i += 1) {
          if (existing[i] && trim(existing[i].name) === trim(def.name)) {
            found = existing[i];
            break;
          }
        }
      }
      return {
        name: def.name,
        required: num(def.required, 0),
        current: found && found.current !== undefined && found.current !== null ? num(found.current) : null,
      };
    });
  }

  // ───────────────────────────── 官方成绩同步（二课缺口） ─────────────────────────────
  //
  // 用户口径（2026-10-17）：「二课缺口学校官网都能直接显示，不需要用户手填」。
  // 因此八模块 current 一律由 OneCTMembers.syncOfficialScores 从官方接口同步，
  // UI 只做只读展示 + 手动触发同步，**不提供任何手填入口**。
  //
  // 契约接口（scores-sync 交付，本文件全部做 capability 探测，方法缺失时降级为「未就绪」）：
  //   syncOfficialScores(memberId, options?) -> Promise<{ok, modules?, updatedAt?, reason?, stale?}>
  //   syncAllOfficialScores({force}?) -> Promise<{ok, results:[{memberId, ok, reason?}]}>
  //   member.ekModulesSource: 'official' | 'manual'
  //   member.ekModulesUpdatedAt: number

  /** 官方成绩自动同步阈值：默认 6 小时（每轮运行前检查，超过才同步） */
  var AUTO_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;

  /** 本次会话内「同步全部」的最近时间（界面展示用；准确值仍以 member.ekModulesUpdatedAt 为准） */
  var lastSyncAllAt = 0;
  /** 「同步全部」的最近一次结果文案（renderView 会重建 DOM，这里保留下来不丢） */
  var lastSyncAllText = '';

  var SYNC_REASON_CN = {
    'ek-not-logged-in': '二课未登录，请先在成员编辑里登录',
    'no-ek-session': '二课会话已失效，请重新登录',
    'ek-session-expired': '二课会话已过期，请重新登录',
    'ek-login-failed': '二课重新登录失败',
    'api-unavailable': 'IPC 接口不可用',
    'offline': '网络不可用',
    'timeout': '官方接口请求超时',
    'network': '网络异常',
    'response-empty': '官方接口返回为空',
    'response-shape': '官方返回结构异常',
    'member-not-found': '成员不存在',
    'unsupported': '同步功能未就绪',
    'upstream-rejected': '官方接口拒绝了本次查询',
  };

  function syncReasonCn(reason) {
    var code = trim(reason);
    if (!code) return '未知原因';
    return SYNC_REASON_CN[code] || code;
  }

  function hasSyncApi() {
    return hasFn(M, 'syncOfficialScores');
  }

  function hasSyncAllApi() {
    return hasFn(M, 'syncAllOfficialScores');
  }

  /** 该成员是否具备同步条件（有会话或凭证，且同步接口存在） */
  function canSyncMember(member) {
    if (!member || !member.id) return false;
    if (member.ekStatus === 'ok') return true;
    if (member.ek && member.ek.JSESSIONID) return true;
    return Boolean(member.ekCredentials && member.ekCredentials.studentId);
  }

  /** 缺口语义：多久没同步了 */
  function syncAgeText(updatedAt) {
    var at = num(updatedAt);
    if (!at) return '尚未同步';
    var diff = Math.max(0, Date.now() - at);
    if (diff < 60 * 1000) return '刚刚同步';
    if (diff < 60 * 60 * 1000) return Math.round(diff / 60000) + ' 分钟前同步';
    if (diff < 24 * 60 * 60 * 1000) return Math.round(diff / 3600000) + ' 小时前同步';
    return Math.round(diff / 86400000) + ' 天前同步';
  }

  function modulesSourceLabel(member) {
    if (!member || !Array.isArray(member.ekModules) || !member.ekModules.length) return '';
    return member.ekModulesSource === 'official' ? '官方' : '手工';
  }

  /** 官方成绩同步时间：契约是毫秒数（Number）；兼容历史/异常数据里的时间字符串 */
  function memberModulesUpdatedAt(member) {
    var raw = member && member.ekModulesUpdatedAt;
    if (raw === null || raw === undefined || raw === '') return 0;
    var parsed = typeof raw === 'string' ? Date.parse(raw) : Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  function memberNeedsSync(member) {
    if (!canSyncMember(member)) return false;
    var at = memberModulesUpdatedAt(member);
    if (!at) return true;
    return Date.now() - at > AUTO_SYNC_INTERVAL_MS;
  }

  function autoSyncOnStart() {
    var value = cfgGet('ek.scorePolicy.refreshOnStart');
    return value !== false;
  }

  function updateGlobalLastSyncAt(at) {
    if (!num(at)) return;
    lastSyncAllAt = Math.max(lastSyncAllAt, num(at));
  }

  /** 最近一次同步时间（跨成员取最大；含本次会话内的「同步全部」记录） */
  function latestSyncAt() {
    var latest = lastSyncAllAt;
    memberList().forEach(function (member) {
      latest = Math.max(latest, memberModulesUpdatedAt(member));
    });
    return latest;
  }

  /**
   * 同步单个成员的官方成绩。返回 {ok, reason, modules}；永不抛错（UI 侧统一处理）。
   */
  function syncMemberScores(memberId) {
    if (!hasSyncApi()) {
      return Promise.resolve({ ok: false, reason: 'unsupported' });
    }
    var task;
    try {
      task = M.syncOfficialScores(memberId);
    } catch (e) {
      return Promise.resolve({ ok: false, reason: sanitizeError(e) });
    }
    return Promise.resolve(task)
      .then(function (result) {
        var out = result && typeof result === 'object' ? result : {};
        if (out.ok !== false) {
          reloadMembers();
          updateGlobalLastSyncAt(num(out.updatedAt) || memberModulesUpdatedAt(getMember(memberId)));
        }
        return {
          ok: out.ok !== false,
          reason: out.reason ? text(out.reason) : '',
          modules: Array.isArray(out.modules) ? out.modules : null,
          updatedAt: num(out.updatedAt) || 0,
          stale: out.stale === true,
        };
      })
      .catch(function (e) {
        return { ok: false, reason: sanitizeError(e) };
      });
  }

  /**
   * 每轮运行前的自动同步：只同步「超过阈值未同步且具备会话」的已启用成员，串行。
   * 返回实际同步的成员数；任何失败都不阻断本轮运行（只在日志里提示）。
   */
  function maybeAutoSyncScores() {
    if (!autoSyncOnStart() || !hasSyncApi()) return Promise.resolve(0);
    var targets = enabledMembers().filter(memberNeedsSync);
    if (!targets.length) return Promise.resolve(0);
    pushLog('info', '开始自动同步官方成绩（' + targets.length + ' 名成员，阈值 ' + Math.round(AUTO_SYNC_INTERVAL_MS / 3600000) + ' 小时）');
    var okCount = 0;
    var chain = Promise.resolve();
    targets.forEach(function (member) {
      chain = chain.then(function () {
        return syncMemberScores(member.id).then(function (result) {
          if (result.ok) {
            okCount += 1;
            pushLog('success', '官方成绩已同步：' + (text(member.name) || member.id), {
              memberId: member.id,
              memberName: text(member.name),
            });
          } else {
            pushLog('warn', '官方成绩同步失败：' + (text(member.name) || member.id) + ' · ' + syncReasonCn(result.reason), {
              memberId: member.id,
              memberName: text(member.name),
            });
          }
        });
      });
    });
    return chain.then(function () {
      return okCount;
    });
  }

  function renderMembersView() {
    reloadMembers();
    reloadConfig();

    var addBtn = h('button', {
      class: 'one-ct-btn one-ct-btn--primary',
      type: 'button',
      text: '新增成员',
      'data-testid': 'one-ct-member-add',
      onclick: function () {
        openMemberModal(null);
      },
    });

    var items = memberList();
    var body;
    if (!items.length) {
      body = h('div', { class: 'one-ct-empty', 'data-testid': 'one-ct-members-empty' }, [
        h('div', { class: 'one-ct-empty-title', text: '还没有成员' }),
        h('div', { text: '每位成员有独立的二课会话、校园跑账号与八模块进度。' }),
        h('div', { class: 'one-ct-empty-actions' }, [
          h('button', {
            class: 'one-ct-btn one-ct-btn--primary',
            type: 'button',
            text: '新增成员',
            'data-testid': 'one-ct-members-empty-add',
            onclick: function () {
              openMemberModal(null);
            },
          }),
        ]),
      ]);
    } else {
      var rows = items.map(function (member) {
        var memberId = text(member.id);
        var gap = memberTotalGap(member);
        var enabledCtl = switchControl({
          checked: member.enabled === true,
          testid: 'one-ct-member-enabled-' + memberId,
          onChange: function (checked) {
            try {
              var next = clone(member);
              next.enabled = checked;
              next.updatedAt = Date.now();
              M.upsertMember(next);
              reloadMembers();
              pushLog('info', '成员「' + (text(member.name) || memberId) + '」已' + (checked ? '启用' : '停用'));
            } catch (e) {
              pushLog('error', '成员启用状态保存失败：' + sanitizeError(e));
              renderView();
            }
          },
        });
        var note = trim(member.note);
        return h('tr', { 'data-testid': 'one-ct-member-row', 'data-member-id': memberId }, [
          h('td', null, [
            h('div', { class: 'one-ct-cell-name' }, [
              h('span', { class: 'one-ct-avatar', text: (text(member.name) || memberId).slice(0, 1) }),
              h('div', { class: 'one-ct-cell-name-main' }, [
                h('div', {
                  class: 'one-ct-cell-name-text',
                  'data-testid': 'one-ct-member-name-' + memberId,
                  text: text(member.name) || '（未命名）',
                }),
                note ? h('div', { class: 'one-ct-cell-sub', text: note }) : null,
              ]),
            ]),
          ]),
          h('td', null, [ekBadge(member)]),
          h('td', null, [
            member.unirun && member.unirun.phone
              ? h('span', {
                  class: 'one-ct-num',
                  'data-testid': 'one-ct-member-phone-' + memberId,
                  text: maskPhone(member.unirun.phone),
                })
              : h('span', { class: 'one-ct-muted', text: '未配置' }),
          ]),
          h('td', null, [
            h('div', { class: 'one-ct-gap-cell' }, [
              h('span', {
                class: 'one-ct-num',
                'data-testid': 'one-ct-member-gap-' + memberId,
                text: gap === null ? '—' : String(gap),
              }),
              (function () {
                var label = modulesSourceLabel(member);
                if (!label) return null;
                var official = member.ekModulesSource === 'official';
                return h('span', {
                  class: 'one-ct-cell-sub' + (official ? '' : ' one-ct-muted'),
                  'data-testid': 'one-ct-member-gap-source-' + memberId,
                  title: memberModulesUpdatedAt(member)
                    ? '成绩同步于 ' + formatDateTime(memberModulesUpdatedAt(member))
                    : '来源：' + label,
                  text: label + (official && memberModulesUpdatedAt(member) ? ' · ' + syncAgeText(memberModulesUpdatedAt(member)) : ''),
                });
              })(),
            ]),
          ]),
          h('td', null, [enabledCtl.node]),
          h('td', { class: 'is-actions' }, [
            h('button', {
              class: 'one-ct-btn one-ct-btn--sm',
              type: 'button',
              text: '编辑',
              'data-testid': 'one-ct-member-edit-' + memberId,
              onclick: function () {
                openMemberModal(memberId);
              },
            }),
            h('button', {
              class: 'one-ct-btn one-ct-btn--sm one-ct-btn--danger',
              type: 'button',
              text: '删除',
              'data-testid': 'one-ct-member-delete-' + memberId,
              onclick: function () {
                deleteMember(memberId);
              },
            }),
          ]),
        ]);
      });

      body = h('div', { class: 'one-ct-table-wrap' }, [
        h('table', { class: 'one-ct-table', 'data-testid': 'one-ct-members-table' }, [
          h('thead', null, [
            h('tr', null, [
              h('th', { text: '成员' }),
              h('th', { text: '二课登录态' }),
              h('th', { text: '校园跑账号' }),
              h('th', { text: '积分缺口' }),
              h('th', { text: '启用' }),
              h('th', { class: 'is-actions', text: '操作' }),
            ]),
          ]),
          h('tbody', null, rows),
        ]),
      ]);
    }

    var view = h('div', { class: 'one-ct-view', 'data-testid': 'one-ct-members-view' }, [
      h('section', { class: 'one-ct-card' }, [
        h('div', { class: 'one-ct-card-head' }, [
          h('div', { class: 'one-ct-card-head-main' }, [
            h('div', { class: 'one-ct-card-title', text: '成员' }),
            h('div', {
              class: 'one-ct-card-sub',
              text: '每个人分开保存二课登录、校园跑账号和八个模块的进度；缺口只算已经填过的模块',
            }),
          ]),
          h('div', { class: 'one-ct-card-head-actions' }, [addBtn]),
        ]),
        h('div', { class: 'one-ct-card-body is-flush' }, [body]),
      ]),
    ]);
    els.main.appendChild(view);
  }

  function deleteMember(memberId) {
    var member = getMember(memberId);
    var name = member ? text(member.name) || memberId : memberId;
    if (!window.confirm('删除成员「' + name + '」？\n\n该成员在本机的配置、会话与运行状态会一并删除，且不可恢复。')) return;
    if (!hasFn(M, 'removeMember')) {
      pushLog('error', '删除失败：本机数据服务不可用，请重启软件再试');
      return;
    }
    try {
      M.removeMember(memberId);
      reloadMembers();
      pushLog('warn', '已删除成员：' + name);
      renderView();
    } catch (e) {
      pushLog('error', '删除成员失败：' + sanitizeError(e));
    }
  }

  // ───────────────────────────── 成员编辑弹层 ─────────────────────────────

  var CAPTURED_FIELDS = [
    'name', 'note', 'enabled', 'ek', 'ekStatus', 'ekUpdatedAt', 'ekCredentials',
    'unirun', 'ekModules', 'ekModulesSource', 'ekModulesUpdatedAt',
  ];

  function closeModal() {
    if (modal && modal.backdrop && modal.backdrop.parentNode) {
      modal.backdrop.parentNode.removeChild(modal.backdrop);
    }
    if (modal && modal.onKeydown) document.removeEventListener('keydown', modal.onKeydown);
    modal = null;
  }

  function openMemberModal(memberId) {
    closeModal();
    var member = memberId ? getMember(memberId) : null;
    var draft = member
      ? clone(member)
      : {
          id: null, name: '', note: '', enabled: true,
          ek: null, ekStatus: 'none', ekUpdatedAt: null, ekCredentials: null,
          unirun: null, ekModules: null, ekModulesSource: null, ekModulesUpdatedAt: null,
          createdAt: 0, updatedAt: 0,
        };

    // ── 基本信息 ──
    var nameInput = h('input', {
      class: 'one-ct-input is-flex',
      type: 'text',
      value: text(draft.name),
      placeholder: '如 张三',
      maxlength: '40',
      'data-testid': 'one-ct-member-name',
    });
    var noteInput = h('input', {
      class: 'one-ct-input is-flex',
      type: 'text',
      value: text(draft.note),
      placeholder: '备注（可选）',
      maxlength: '80',
      'data-testid': 'one-ct-member-note',
    });
    var enabledCtl = switchControl({
      checked: draft.enabled !== false,
      label: '参与自动运行',
      testid: 'one-ct-member-enabled',
    });

    // ── 二课 ──
    var ekBadgeHost = h('span', { 'data-testid': 'one-ct-ek-badge-host' }, [ekBadge(draft)]);
    var studentIdInput = h('input', {
      class: 'one-ct-input is-num',
      type: 'text',
      inputmode: 'numeric',
      autocomplete: 'off',
      value: draft.ekCredentials && draft.ekCredentials.studentId ? String(draft.ekCredentials.studentId) : ekAccountOf(draft),
      placeholder: '学号',
      'data-testid': 'one-ct-ek-studentid',
    });
    var ekPasswordInput = h('input', {
      class: 'one-ct-input is-flex',
      type: 'password',
      autocomplete: 'new-password',
      placeholder: draft.ekCredentials && draft.ekCredentials.password ? '已保存（留空则不修改）' : '二课密码',
      'data-testid': 'one-ct-ek-password',
    });
    var ekLoginBtn = h('button', {
      class: 'one-ct-btn',
      type: 'button',
      text: '登录并保存会话',
      'data-testid': 'one-ct-ek-login',
      onclick: function () {
        doEkLogin();
      },
    });
    var sessionArea = h('textarea', {
      class: 'one-ct-textarea is-mono is-secret',
      rows: '3',
      spellcheck: 'false',
      placeholder: '备用：把二课会话内容整段粘到这里',
      'data-testid': 'one-ct-ek-session-json',
    });
    var revealBtn = h('button', {
      class: 'one-ct-btn one-ct-btn--sm one-ct-btn--ghost',
      type: 'button',
      text: '显示',
      'data-testid': 'one-ct-ek-session-reveal',
      onclick: function () {
        var hidden = sessionArea.classList.toggle('is-secret');
        revealBtn.textContent = hidden ? '显示' : '隐藏';
      },
    });
    var importBtn = h('button', {
      class: 'one-ct-btn one-ct-btn--sm',
      type: 'button',
      text: '导入会话',
      'data-testid': 'one-ct-ek-session-import',
      onclick: function () {
        doImportSession();
      },
    });

    // ── 二课登录方式：微信扫码优先（校外唯一能用），密码登录只在校内网可用 ──
    var qrReady = !!(
      window.ctAPI && isObject(window.ctAPI.ek) &&
      hasFn(window.ctAPI.ek, 'wxLoginStart') &&
      hasFn(window.ctAPI.ek, 'wxQrImage') &&
      hasFn(window.ctAPI.ek, 'wxLoginComplete') &&
      hasFn(M, 'qrLoginStart') && hasFn(M, 'qrLoginFinish')
    );
    var loginMode = qrReady ? 'qr' : 'password';
    var qrRunId = 0;

    var qrImage = h('img', {
      class: 'one-ct-qr-image',
      alt: '微信扫码登录二维码',
      width: '200',
      height: '200',
      'data-testid': 'one-ct-ek-qr-image',
    });
    qrImage.hidden = true;
    var qrStatusHost = h('div', {
      class: 'one-ct-qr-status',
      'data-testid': 'one-ct-ek-qr-status',
      text: '点「生成二维码」，再用手机微信扫一扫',
    });
    var qrStartBtn = h('button', {
      class: 'one-ct-btn one-ct-btn--primary',
      type: 'button',
      text: '生成二维码',
      'data-testid': 'one-ct-ek-qr-start',
      onclick: function () {
        startQrLogin();
      },
    });
    var qrPanel = h('div', { class: 'one-ct-qr-panel', 'data-testid': 'one-ct-ek-qr' }, [
      qrImage,
      qrStatusHost,
      h('div', { class: 'one-ct-row' }, [qrStartBtn]),
      h('div', {
        class: 'one-ct-field-hint',
        text: '二维码大约 3 分钟有效，扫完请在手机上点「确认」。校园网外也能用，登不上时优先试这个。',
      }),
    ]);

    var passwordPanel = h('div', { class: 'one-ct-ek-pw-panel', 'data-testid': 'one-ct-ek-password-panel' }, [
      field(
        '学号',
        h('div', { class: 'one-ct-field-control' }, [studentIdInput, ekLoginBtn]),
        '校内网络可以用学号加密码，校外只能扫码；密码只保存在本机，界面不显示、也不会导出',
      ),
      field('密码', h('div', { class: 'one-ct-field-control' }, [ekPasswordInput])),
    ]);

    var modeQrBtn = h('button', {
      class: 'one-ct-segmented-btn',
      type: 'button',
      role: 'tab',
      text: '微信扫码',
      'data-testid': 'one-ct-ek-mode-qr',
      onclick: function () {
        loginMode = 'qr';
        applyLoginMode();
      },
    });
    var modePwBtn = h('button', {
      class: 'one-ct-segmented-btn',
      type: 'button',
      role: 'tab',
      text: '学号密码',
      'data-testid': 'one-ct-ek-mode-password',
      onclick: function () {
        loginMode = 'password';
        applyLoginMode();
      },
    });
    var modeSwitch = qrReady
      ? h('div', { class: 'one-ct-segmented', role: 'tablist', 'aria-label': '二课登录方式', 'data-testid': 'one-ct-ek-login-mode' }, [
        modeQrBtn,
        modePwBtn,
        h('span', { class: 'one-ct-segmented-note', text: '校园网外请用扫码' }),
      ])
      : null;

    // ── 校园跑 ──
    var unirunPhoneInput = h('input', {
      class: 'one-ct-input is-num',
      type: 'tel',
      autocomplete: 'off',
      value: draft.unirun && draft.unirun.phone ? String(draft.unirun.phone) : '',
      placeholder: '手机号',
      'data-testid': 'one-ct-unirun-phone',
    });
    var unirunPasswordInput = h('input', {
      class: 'one-ct-input is-flex',
      type: 'password',
      autocomplete: 'new-password',
      placeholder: draft.unirun && draft.unirun.password ? '已保存（留空则不修改）' : '校园跑密码',
      'data-testid': 'one-ct-unirun-password',
    });
    var unirunRemarkInput = h('input', {
      class: 'one-ct-input is-flex',
      type: 'text',
      value: draft.unirun && draft.unirun.remark ? String(draft.unirun.remark) : '',
      placeholder: '备注（可选）',
      'data-testid': 'one-ct-unirun-remark',
    });
    var unirunStatusHost = h('span', { class: 'one-ct-hint', 'data-testid': 'one-ct-unirun-status' });
    var unirunVerifyBtn = h('button', {
      class: 'one-ct-btn one-ct-btn--sm',
      type: 'button',
      text: '校验账号',
      'data-testid': 'one-ct-unirun-verify',
      onclick: function () {
        doVerifyUnirun();
      },
    });

    // ── 二课官方成绩（只读 + 一键同步；不再提供任何手填入口） ──
    var syncStatusHost = h('div', {
      class: 'one-ct-hint',
      'data-testid': 'one-ct-sync-modal-status',
    });
    var syncBtn = h('button', {
      class: 'one-ct-btn one-ct-btn--sm',
      type: 'button',
      text: '同步官方成绩',
      'data-testid': 'one-ct-sync-member',
      onclick: function () {
        doSyncScores();
      },
    });
    var syncGapHost = h('div', { class: 'one-ct-sync-gaps', 'data-testid': 'one-ct-sync-gaps' });

    function renderSyncStatus(target) {
      var m = target || draft;
      clear(syncStatusHost);
      clear(syncGapHost);
      var modules = m && Array.isArray(m.ekModules) ? m.ekModules : [];
      var updatedAt = memberModulesUpdatedAt(m);
      var source = modulesSourceLabel(m);
      var textBits = [];
      if (modules.length && updatedAt) {
        textBits.push('官方成绩 · 同步于 ' + formatDateTime(updatedAt));
        if (source && source !== '官方') textBits.push('（来源：' + source + '）');
      } else if (modules.length) {
        textBits.push('已有成绩数据（来源：' + (source || '未知') + '，尚未记录同步时间）');
      } else {
        textBits.push('尚未同步官方成绩，点右侧按钮从二课官网获取八模块分数');
      }
      syncStatusHost.textContent = textBits.join(' ');

      if (!modules.length) return;
      var total = memberTotalGap(m);
      var head = h('div', { class: 'one-ct-row one-ct-row--between' }, [
        h('span', { class: 'one-ct-hint', text: '八模块缺口（只读，来自官方成绩）' }),
        h('span', {
          class: 'one-ct-hint',
          'data-testid': 'one-ct-sync-total-gap',
          text: total === null ? '缺口合计 —' : '缺口合计 ' + total,
        }),
      ]);
      syncGapHost.appendChild(head);
      var grid = h('div', { class: 'one-ct-sync-gap-grid' });
      modules.forEach(function (module) {
        var gap = moduleGap(module);
        grid.appendChild(
          h('div', { class: 'one-ct-sync-gap-item', 'data-testid': 'one-ct-sync-gap-row' }, [
            h('span', { class: 'one-ct-sync-gap-name', text: trim(module && module.name) }),
            h('span', {
              class: 'one-ct-num one-ct-sync-gap-value',
              text:
                (num(module && module.current) === null ? '—' : num(module.current)) + ' / ' +
                (num(module && module.required) === null ? '—' : num(module.required)),
            }),
            h('span', {
              class: 'one-ct-num one-ct-sync-gap-delta' + (gap === 0 ? ' is-ok' : ''),
              text: gap === null ? '缺口 —' : '缺口 ' + gap,
            }),
          ]),
        );
      });
      syncGapHost.appendChild(grid);
    }

    function refreshSyncButtonState() {
      var ready = hasSyncApi();
      var memberId = (draft && draft.id) || null;
      var syncable = memberId ? canSyncMember(draft) : false;
      if (!ready) {
        syncBtn.disabled = true;
        syncBtn.textContent = '同步功能未就绪';
        syncBtn.title = '这次版本里暂时拿不到官方成绩，请重启软件再试';
        return;
      }
      if (!memberId) {
        syncBtn.disabled = true;
        syncBtn.textContent = '先保存成员';
        syncBtn.title = '新成员需先保存后才能同步官方成绩';
        return;
      }
      if (!syncable) {
        syncBtn.disabled = true;
        syncBtn.textContent = '先登录二课';
        syncBtn.title = '未登录二课，无法读取官方成绩';
        return;
      }
      syncBtn.disabled = false;
      syncBtn.textContent = '同步官方成绩';
      syncBtn.title = '从二课官网读取八个模块的最新分数';
    }

    var errorNode = h('div', { class: 'one-ct-hint one-ct-hint--err', 'data-testid': 'one-ct-member-error' });

    function setError(message) {
      errorNode.textContent = message || '';
    }

    function syncBadge(target) {
      clear(ekBadgeHost);
      ekBadgeHost.appendChild(ekBadge(target || draft));
    }

    function collectDraft() {
      var next = clone(draft);
      CAPTURED_FIELDS.forEach(function (key) {
        if (next[key] === undefined) next[key] = null;
      });
      next.name = nameInput.value.trim();
      next.note = noteInput.value.trim();
      next.enabled = enabledCtl.input.checked;

      var studentId = studentIdInput.value.trim();
      var password = ekPasswordInput.value;
      if (studentId || password) {
        var prevCreds = isObject(next.ekCredentials) ? next.ekCredentials : { studentId: '', password: '' };
        next.ekCredentials = {
          studentId: studentId || prevCreds.studentId || '',
          password: password ? password : prevCreds.password || '',
        };
        if (!next.ekCredentials.studentId && !next.ekCredentials.password) next.ekCredentials = null;
      } else if (!isObject(next.ekCredentials)) {
        next.ekCredentials = null;
      }

      var phone = unirunPhoneInput.value.trim();
      var unirunPassword = unirunPasswordInput.value;
      var remark = unirunRemarkInput.value.trim();
      var prevUnirun = isObject(next.unirun) ? next.unirun : null;
      if (phone || unirunPassword || remark || prevUnirun) {
        var mergedPhone = phone || (prevUnirun && prevUnirun.phone) || '';
        next.unirun = mergedPhone
          ? {
              id: (prevUnirun && prevUnirun.id) || 'u_' + shortHash(mergedPhone + '|' + (next.name || next.id || '')),
              phone: mergedPhone,
              password: unirunPassword || (prevUnirun && prevUnirun.password) || '',
              remark: remark,
            }
          : null;
      } else {
        next.unirun = null;
      }

      // 八模块 current 一律来自官方同步（member.ekModules / ekModulesSource / ekModulesUpdatedAt），
      // 保存成员时**整块删掉**这三个字段，让 members.js 保留库里的最新同步结果，
      // 避免弹层打开期间的旧快照覆盖掉刚同步的数据。
      delete next.ekModules;
      delete next.ekModulesSource;
      delete next.ekModulesUpdatedAt;
      next.updatedAt = Date.now();
      if (!next.createdAt) next.createdAt = next.updatedAt;
      return next;
    }

    /** 保存草稿（不关闭弹层），返回落盘后的成员；失败返回 null */
    function persistDraft() {
      if (!hasFn(M, 'upsertMember')) {
        setError('保存失败：本机数据服务不可用，请重启软件再试');
        return null;
      }
      var next = collectDraft();
      if (!next.name) {
        setError('请填写姓名');
        nameInput.focus();
        return null;
      }
      try {
        var saved = M.upsertMember(next);
        if (saved && saved.id) draft = clone(saved);
        else {
          draft = next;
          var loadedMember = next.id ? getMember(next.id) : null;
          if (loadedMember) draft = clone(loadedMember);
        }
        reloadMembers();
        var refreshed = draft.id ? getMember(draft.id) : null;
        if (refreshed) draft = clone(refreshed);
        draft.ekStatus = draft.ekStatus || 'none';
        syncBadge(draft);
        renderSyncStatus(draft);
        refreshSyncButtonState();
        setError('');
        return draft;
      } catch (e) {
        setError('保存失败：' + sanitizeError(e));
        pushLog('error', '成员保存失败：' + sanitizeError(e));
        return null;
      }
    }

    function setQrStatus(message, tone) {
      qrStatusHost.textContent = message || '';
      qrStatusHost.className = 'one-ct-qr-status' + (tone ? ' is-' + tone : '');
    }

    function applyLoginMode() {
      var useQr = qrReady && loginMode === 'qr';
      if (qrPanel) qrPanel.hidden = !useQr;
      if (passwordPanel) passwordPanel.hidden = useQr;
      if (modeQrBtn) {
        modeQrBtn.classList.toggle('is-active', useQr);
        modeQrBtn.setAttribute('aria-selected', useQr ? 'true' : 'false');
      }
      if (modePwBtn) {
        modePwBtn.classList.toggle('is-active', !useQr);
        modePwBtn.setAttribute('aria-selected', useQr ? 'false' : 'true');
      }
    }

    /* 登录失败 → 一句人话；needQr=true 表示只能靠扫码解决 */
    function loginErrorInfo(error) {
      if (hasFn(M, 'ekLoginErrorMessage')) {
        try {
          var info = M.ekLoginErrorMessage(error);
          if (info && info.text) return { text: String(info.text), needQr: info.needQr === true };
        } catch (e) {
          /* 落到下面的兜底 */
        }
      }
      var raw = error && error.detail ? error.detail : error && error.cause ? error.cause : error && error.message ? error.message : '';
      return { text: sanitizeError(raw || error) || '这次没登上，请稍后再试', needQr: false };
    }

    function highlightQrEntry() {
      if (!qrReady || !modeQrBtn) return;
      modeQrBtn.classList.add('is-attention');
      setTimeout(function () {
        if (modeQrBtn) modeQrBtn.classList.remove('is-attention');
      }, 6000);
    }

    function onEkLoggedIn(member, how) {
      reloadMembers();
      var fresh = member && member.id ? getMember(member.id) : null;
      if (!fresh && draft && draft.id) fresh = getMember(draft.id);
      if (fresh) draft = clone(fresh);
      draft.ekStatus = 'ok';
      syncBadge(draft);
      renderSyncStatus(draft);
      refreshSyncButtonState();
      setError('');
      pushLog('success', '二课已登录（' + how + '）：' + (text(draft.name) || draft.id || ''));
    }

    function startQrLogin() {
      if (!qrReady) return;
      var memberId = (draft && draft.id) || null;
      if (!memberId) {
        // 新成员先落盘再扫码：二维码回填需要成员记录
        if (!nameInput.value.trim()) {
          setError('先填一个姓名，再生成二维码');
          nameInput.focus();
          return;
        }
        var saved = persistDraft();
        if (!saved || !saved.id) return;
        memberId = saved.id;
      }
      qrRunId += 1;
      var runId = qrRunId;
      qrImage.hidden = true;
      qrImage.removeAttribute('src');
      qrStartBtn.disabled = true;
      qrStartBtn.textContent = '正在生成…';
      setQrStatus('正在生成二维码…');
      setError('');
      Promise.resolve()
        .then(function () {
          return M.qrLoginStart();
        })
        .then(function (res) {
          if (runId !== qrRunId) return null; // 已经换了新二维码：丢弃这一次
          qrImage.src = String(res && res.imageDataUri ? res.imageDataUri : '');
          qrImage.hidden = false;
          qrStartBtn.disabled = false;
          qrStartBtn.textContent = '刷新二维码';
          setQrStatus('请用微信扫一扫，扫完在手机上点「确认」');
          return M.qrLoginFinish(memberId, { uuid: res && res.uuid, state: res && res.state }).then(function (updated) {
            if (runId !== qrRunId) return null; // 旧会话迟到：不能覆盖新状态
            qrImage.hidden = true;
            qrStartBtn.textContent = '重新扫码';
            setQrStatus('登录成功（' + formatTime(Date.now()) + '）', 'ok');
            onEkLoggedIn(updated, '微信扫码');
            return null;
          });
        })
        .catch(function (error) {
          if (runId !== qrRunId) return;
          qrStartBtn.disabled = false;
          qrStartBtn.textContent = '刷新二维码';
          var info = loginErrorInfo(error);
          var detail = String((error && (error.detail || error.cause || error.message)) || '');
          var expired = /过期|失效|超时|cancel|取消|expired|timeout/i.test(detail + ' ' + info.text);
          if (expired) {
            qrImage.hidden = true;
            setQrStatus('二维码已过期，点「刷新二维码」重新生成', 'warn');
            pushLog('warn', '二维码已过期，需要重新生成');
            return;
          }
          setQrStatus(info.text, 'err');
          pushLog('warn', '扫码登录没成功：' + info.text);
        });
    }

    function doEkLogin() {
      var creds = { student_id: studentIdInput.value.trim(), password: ekPasswordInput.value };
      if (!creds.student_id || !creds.password) {
        setError('请填写二课学号与密码');
        return;
      }
      var saved = persistDraft();
      if (!saved || !saved.id) return;
      var memberId = saved.id;
      ekLoginBtn.disabled = true;
      ekLoginBtn.textContent = '登录中…';
      setError('');
      var task;
      try {
        // 契约补充 v2：优先 members.js 封装的 loginEk（内部调 ctAPI.ek.login 并写回会话+凭证+状态）
        if (hasFn(M, 'loginEk')) task = M.loginEk(memberId, creds);
        else if (window.ctAPI && hasFn(window.ctAPI.ek, 'login')) {
          task = window.ctAPI.ek.login(creds).then(function (session) {
            if (!hasFn(M, 'setEkSession')) throw new Error('本机数据服务不可用');
            return M.setEkSession(memberId, session);
          });
        } else {
          throw new Error('登录服务暂时不可用，请重启软件再试');
        }
      } catch (e) {
        task = Promise.reject(e);
      }
      Promise.resolve(task)
        .then(function () {
          ekPasswordInput.value = '';
          onEkLoggedIn(getMember(memberId) || draft, '学号密码');
        })
        .catch(function (e) {
          var info = loginErrorInfo(e);
          pushLog('error', '二课密码登录失败：' + info.text);
          setError(info.text);
          if (info.needQr && qrReady) {
            highlightQrEntry();
            setQrStatus('校外网络只能用微信扫码，切到「微信扫码」再试一次', 'err');
          }
        })
        .then(function () {
          ekLoginBtn.disabled = false;
          ekLoginBtn.textContent = '登录并保存会话';
        });
    }

    function doImportSession() {
      var raw = sessionArea.value.trim();
      if (!raw) {
        setError('请先把二课会话内容粘进来');
        return;
      }
      var parsed = parseJson(raw);
      if (!parsed) {
        setError('这段内容没能读懂，可能是复制时漏了一部分');
        return;
      }
      var session = normalizeEkSession(parsed);
      if (!session) {
        setError('这段内容缺少必要的登录信息，请重新完整复制一次');
        return;
      }
      // 立即清空输入框：明文会话不长期停留在 DOM
      sessionArea.value = '';
      var saved = persistDraft();
      if (!saved || !saved.id) return;
      try {
        if (!hasFn(M, 'setEkSession')) throw new Error('本机数据服务不可用');
        M.setEkSession(saved.id, session);
        reloadMembers();
        var fresh = getMember(saved.id);
        if (fresh) draft = clone(fresh);
        draft.ek = session;
        draft.ekStatus = 'ok';
        draft.ekUpdatedAt = Date.now();
        syncBadge(draft);
        refreshSyncButtonState();
        setError('');
        pushLog('info', '已导入二课会话：' + (text(draft.name) || saved.id) + ' · ' + (ekAccountOf(draft) || ''));
      } catch (e) {
        setError('导入会话失败：' + sanitizeError(e));
        pushLog('error', '导入二课会话失败：' + sanitizeError(e));
      }
    }

    /** 同步官方成绩（只读展示用；失败保留旧值，绝不清空） */
    function doSyncScores() {
      if (!hasSyncApi()) {
        setError('同步功能暂时不可用，请重启软件再试');
        return;
      }
      var memberId = (draft && draft.id) || null;
      if (!memberId) {
        setError('请先保存成员，再同步官方成绩');
        return;
      }
      syncBtn.disabled = true;
      var originalText = syncBtn.textContent;
      syncBtn.textContent = '同步中…';
      setError('');
      var previousModules = Array.isArray(draft.ekModules) ? draft.ekModules.slice() : null;
      syncMemberScores(memberId).then(function (result) {
        reloadMembers();
        var fresh = getMember(memberId);
        if (fresh) draft = clone(fresh);
        if (result.ok) {
          syncBtn.textContent = '已同步 ✓';
          var m = draft;
          var count = m && Array.isArray(m.ekModules) ? m.ekModules.length : 0;
          pushLog('success', '官方成绩已同步：' + (text(draft.name) || memberId) + ' · ' + count + ' 个模块', {
            memberId: memberId,
            memberName: text(draft.name),
          });
        } else {
          // 失败：保留旧值（draft 未被覆盖），只提示原因
          if (previousModules && !Array.isArray(draft.ekModules)) draft.ekModules = previousModules;
          syncBtn.textContent = '重试同步';
          var message = '同步失败：' + syncReasonCn(result.reason);
          setError(message);
          pushLog('warn', '官方成绩同步失败：' + (text(draft.name) || memberId) + ' · ' + syncReasonCn(result.reason), {
            memberId: memberId,
            memberName: text(draft.name),
          });
        }
        renderSyncStatus(draft);
        refreshSyncButtonState();
        setTimeout(function () {
          if (!modal) return;
          syncBtn.textContent = hasSyncApi() ? '同步官方成绩' : '同步功能未就绪';
          refreshSyncButtonState();
        }, 1800);
      });
    }

    function doVerifyUnirun() {
      var phone = unirunPhoneInput.value.trim();
      var password = unirunPasswordInput.value;
      if (!phone || !password) {
        setError('请填写校园跑手机号与密码');
        return;
      }
      var saved = persistDraft();
      if (!saved || !saved.id) return;
      unirunVerifyBtn.disabled = true;
      unirunStatusHost.textContent = '校验中…';
      unirunStatusHost.className = 'one-ct-hint';
      var task;
      try {
        if (hasFn(M, 'verifyUnirun')) task = M.verifyUnirun(saved.id);
        else if (window.ctAPI && hasFn(window.ctAPI.unirun, 'sessionEnsure')) {
          task = window.ctAPI.unirun.sessionEnsure({ phone: phone, password: password });
        } else {
          throw new Error('校验功能暂时不可用，请重启软件再试');
        }
      } catch (e) {
        task = Promise.reject(e);
      }
      Promise.resolve(task)
        .then(function (result) {
          if (result && result.ok === false) {
            unirunStatusHost.textContent = '校验失败：' + sanitizeError(result.reason || '未知原因');
            unirunStatusHost.className = 'one-ct-hint one-ct-hint--err';
            return;
          }
          var info = [];
          if (result && result.userName) info.push(String(result.userName));
          if (result && result.schoolName) info.push(String(result.schoolName));
          unirunStatusHost.textContent = '已校验' + (info.length ? ' · ' + info.join(' · ') : '');
          unirunStatusHost.className = 'one-ct-hint one-ct-hint--ok';
          unirunPasswordInput.value = '';
          pushLog('success', '校园跑账号校验通过：' + (text(draft.name) || '') + ' · ' + maskPhone(phone));
        })
        .catch(function (e) {
          unirunStatusHost.textContent = '校验失败：' + sanitizeError(e);
          unirunStatusHost.className = 'one-ct-hint one-ct-hint--err';
          pushLog('error', '校园跑账号校验失败：' + sanitizeError(e));
        })
        .then(function () {
          unirunVerifyBtn.disabled = false;
        });
    }

    var saveBtn = h('button', {
      class: 'one-ct-btn one-ct-btn--primary',
      type: 'button',
      text: '保存',
      'data-testid': 'one-ct-member-save',
      onclick: function () {
        var saved = persistDraft();
        if (!saved) return;
        closeModal();
        pushLog('success', '成员已保存：' + (text(saved.name) || saved.id));
        renderView();
      },
    });
    var cancelBtn = h('button', {
      class: 'one-ct-btn',
      type: 'button',
      text: '取消',
      'data-testid': 'one-ct-member-cancel',
      onclick: closeModal,
    });

    var foot = [errorNode, h('span', { class: 'one-ct-spacer' })];
    if (member) {
      foot.push(
        h('button', {
          class: 'one-ct-btn one-ct-btn--danger',
          type: 'button',
          text: '删除',
          'data-testid': 'one-ct-member-delete',
          onclick: function () {
            closeModal();
            deleteMember(member.id);
          },
        }),
      );
    }
    foot.push(cancelBtn, saveBtn);

    var body = h('div', { class: 'one-ct-modal-body' }, [
      h('div', { class: 'one-ct-form-section' }, [
        h('div', { class: 'one-ct-form-section-head' }, [
          h('span', { class: 'one-ct-form-section-title', text: '基本信息' }),
        ]),
        field('姓名', h('div', { class: 'one-ct-field-control' }, [nameInput])),
        field('备注', h('div', { class: 'one-ct-field-control' }, [noteInput])),
        field('参与运行', h('div', { class: 'one-ct-field-control' }, [enabledCtl.node])),
      ]),
      h('div', { class: 'one-ct-form-section', 'data-testid': 'one-ct-member-ek-login' }, [
        h('div', { class: 'one-ct-form-section-head' }, [
          h('span', { class: 'one-ct-form-section-title', text: '二课登录（推荐微信扫码，校外也能用）' }),
          ekBadgeHost,
        ]),
        h('div', { class: 'one-ct-ek-login-note', 'data-testid': 'one-ct-member-ek-login-note', text: '扫码在任何网络下都能用；学号加密码只在校内网连得上，校外请用扫码。' }),
        modeSwitch,
        qrReady ? qrPanel : null,
        passwordPanel,
        h('div', { class: 'one-ct-field' }, [
          h('span', { class: 'one-ct-field-label', text: '备用：粘贴会话' }),
          h('div', { class: 'one-ct-field-control one-ct-stack' }, [
            sessionArea,
            h('div', { class: 'one-ct-row' }, [revealBtn, importBtn]),
          ]),
          h('span', { class: 'one-ct-field-hint', text: '内容默认打码显示，导入成功后输入框会清空，也不会写进日志。' }),
        ]),
      ]),
      // 官方成绩紧跟二课登录区（用户直觉：登录 → 看/同步成绩）
      h('div', { class: 'one-ct-form-section', 'data-testid': 'one-ct-sync-section' }, [
        h('div', { class: 'one-ct-form-section-head' }, [
          h('span', { class: 'one-ct-form-section-title', text: '二课官方成绩（自动同步，无需手填）' }),
          h('span', { class: 'one-ct-spacer' }),
          syncBtn,
        ]),
        syncStatusHost,
        syncGapHost,
        h('div', {
          class: 'one-ct-hint',
          text: '八个模块的分数直接来自二课官网，缺口 = 要求分数 − 已得分数（不小于 0）。同步失败时会保留上一次的数据。',
        }),
      ]),
      h('div', { class: 'one-ct-form-section' }, [
        h('div', { class: 'one-ct-form-section-head' }, [
          h('span', { class: 'one-ct-form-section-title', text: '校园跑 / 俱乐部账号' }),
        ]),
        field('手机号', h('div', { class: 'one-ct-field-control' }, [unirunPhoneInput]), '列表里只显示 138****0000 这样的打码号码'),
        field('密码', h('div', { class: 'one-ct-field-control' }, [unirunPasswordInput])),
        field('备注', h('div', { class: 'one-ct-field-control' }, [unirunRemarkInput, unirunVerifyBtn, unirunStatusHost])),
      ]),
    ]);

    var modalNode = h('div', {
      class: 'one-ct-modal',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': member ? '编辑成员' : '新增成员',
      'data-testid': 'one-ct-member-modal',
    }, [
      h('div', { class: 'one-ct-modal-head' }, [
        h('div', { class: 'one-ct-card-head-main' }, [
          h('div', { class: 'one-ct-modal-title', text: member ? '编辑成员' : '新增成员' }),
          h('div', { class: 'one-ct-modal-sub', text: member ? '修改后点保存生效' : '保存后可在运行页勾选参与自动运行' }),
        ]),
        h('button', {
          class: 'one-ct-btn one-ct-btn--icon',
          type: 'button',
          text: '✕',
          'aria-label': '关闭',
          style: 'margin-left:auto',
          'data-testid': 'one-ct-member-close',
          onclick: closeModal,
        }),
      ]),
      body,
      h('div', { class: 'one-ct-modal-foot' }, foot),
    ]);

    var backdrop = h('div', {
      class: 'one-ct-modal-backdrop',
      'data-testid': 'one-ct-modal-backdrop',
      onclick: function (event) {
        if (event.target === backdrop) closeModal();
      },
    }, [modalNode]);

    var onKeydown = function (event) {
      if (event.key === 'Escape') closeModal();
    };
    document.addEventListener('keydown', onKeydown);
    document.body.appendChild(backdrop);
    modal = { backdrop: backdrop, node: modalNode, onKeydown: onKeydown };
    // 官方成绩区初始化：只读状态 + 同步按钮可用性
    renderSyncStatus(draft);
    refreshSyncButtonState();
    applyLoginMode();
    setTimeout(function () {
      nameInput.focus();
    }, 0);
  }

  // ───────────────────────────── 二课统计页 ─────────────────────────────

  function buildStat(member, events, scoreEntry) {
    if (S && hasFn(S, 'build')) {
      try {
        return S.build({ member: member, events: events, scoreEntry: scoreEntry });
      } catch (e) {
        pushLog('warn', '统计计算失败，使用内置兜底口径：' + sanitizeError(e));
      }
    }
    return fallbackBuildStat(member, events, scoreEntry);
  }

  function fallbackBuildStat(member, events, scoreEntry) {
    var DAY = 24 * 60 * 60 * 1000;
    var from = Date.now() - 90 * DAY;
    var stat = {
      memberId: member.id,
      memberName: text(member.name),
      signIn: { success: 0, failed: 0, waiting: 0, lastAt: 0 },
      signOut: { success: 0, failed: 0, waiting: 0, lastAt: 0 },
      activities: [],
      modules: [],
      totalGap: null,
      trusted: false,
      stale: true,
      refreshedAt: null,
    };
    var byActivity = Object.create(null);
    (events || []).forEach(function (event) {
      if (!isObject(event)) return;
      var at = num(event.at, 0) || 0;
      if (at && at < from) return;
      var action = text(event.action).toLowerCase().replace(/[_-]/g, '');
      var bucket = action === 'signin' || action === 'in' ? stat.signIn
        : action === 'signout' || action === 'out' ? stat.signOut
          : null;
      if (bucket) {
        if (event.status === 'success') bucket.success += 1;
        else if (event.status === 'failed') bucket.failed += 1;
        else if (event.status === 'waiting-material' || event.status === 'not-yet') bucket.waiting += 1;
        bucket.lastAt = Math.max(bucket.lastAt, at);
      }
      var activityId = text(event.activityId) || text(event.activityName);
      if (!activityId) return;
      if (!byActivity[activityId]) {
        byActivity[activityId] = {
          activityId: activityId,
          name: text(event.activityName) || activityId,
          category: text(event.category),
          signInStatus: '',
          signOutStatus: '',
          lastAt: 0,
        };
      }
      var activity = byActivity[activityId];
      if (action === 'signin') activity.signInStatus = text(event.status);
      if (action === 'signout') activity.signOutStatus = text(event.status);
      activity.lastAt = Math.max(activity.lastAt, at);
    });
    stat.activities = Object.keys(byActivity)
      .map(function (key) {
        return byActivity[key];
      })
      .sort(function (a, b) {
        return b.lastAt - a.lastAt;
      })
      .slice(0, 50);

    var totalGap = 0;
    var any = false;
    stat.modules = moduleDefs(member).map(function (module) {
      var gap = moduleGap(module);
      if (gap !== null) {
        totalGap += gap;
        any = true;
      }
      return { name: module.name, required: module.required, current: module.current, gap: gap, satisfied: gap === 0 };
    });
    stat.totalGap = any ? totalGap : null;
    if (scoreEntry && scoreEntry.snapshot) {
      stat.trusted = true;
      stat.stale = false;
      stat.refreshedAt = num(scoreEntry.refreshedAt);
    }
    return stat;
  }

  function fallbackCSV(stat) {
    var lines = ['成员,模块,要求,当前,缺口'];
    (stat.modules || []).forEach(function (module) {
      lines.push([text(stat.memberName), module.name, module.required, module.current, module.gap].map(csvEscape).join(','));
    });
    lines.push('');
    lines.push('活动,类别,签到,签退,最近时间');
    (stat.activities || []).forEach(function (activity) {
      lines.push(
        [activity.name || activity.activityId, activity.category, activity.signInStatus, activity.signOutStatus, activity.lastAt ? formatDateTime(activity.lastAt) : '']
          .map(csvEscape)
          .join(','),
      );
    });
    return lines.join('\n');
  }

  function csvEscape(value) {
    var str = value === null || value === undefined ? '' : String(value);
    return /[",\n\r]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
  }

  /** 安全渲染 OneCTStats 输出到容器（含 CSS 缺失时的降级排版） */
  function renderStatInto(host, stat, member) {
    if (S && hasFn(S, 'renderInto')) {
      try {
        clear(host);
        S.renderInto(host, stat, { member: member });
        if (host.childNodes.length) return;
      } catch (e) {
        pushLog('warn', '统计渲染失败，使用内置渲染：' + sanitizeError(e));
      }
    }
    renderFallbackStat(host, stat);
  }

  function renderFallbackStat(host, stat) {
    clear(host);
    var signIn = stat.signIn || {};
    var signOut = stat.signOut || {};
    host.appendChild(
      h('div', { class: 'one-ct-statgrid', 'data-testid': 'one-ct-stats-cards' }, [
        h('div', { class: 'one-ct-stat' }, [
          h('div', { class: 'one-ct-stat-value is-ok', text: String(signIn.success || 0) }),
          h('div', { class: 'one-ct-stat-label', text: '签到成功（近 90 天）' }),
        ]),
        h('div', { class: 'one-ct-stat' }, [
          h('div', { class: 'one-ct-stat-value is-ok', text: String(signOut.success || 0) }),
          h('div', { class: 'one-ct-stat-label', text: '签退成功（近 90 天）' }),
        ]),
        h('div', { class: 'one-ct-stat' }, [
          h('div', {
            class: 'one-ct-stat-value' + (signIn.failed ? ' is-warn' : ''),
            text: String(signIn.failed || 0),
          }),
          h('div', { class: 'one-ct-stat-label', text: '签到失败' }),
        ]),
        h('div', { class: 'one-ct-stat' }, [
          h('div', { class: 'one-ct-stat-value' + (stat.stale ? ' is-warn' : ''), text: stat.totalGap === null ? '—' : String(stat.totalGap) }),
          h('div', { class: 'one-ct-stat-label', text: '八模块缺口合计' }),
        ]),
      ]),
    );

    var modulesWrap = h('div', { class: 'one-ct-card-body is-flush', 'data-testid': 'one-ct-stats-modules' });
    (stat.modules || []).forEach(function (module) {
      var ratio = module.current === null || !module.required ? 0 : Math.min(1, module.current / module.required);
      var barClass = 'one-ct-bar' + (module.gap === null ? '' : module.gap === 0 ? ' is-ok' : ' is-warn');
      modulesWrap.appendChild(
        h('div', { class: 'one-ct-module-row' }, [
          h('div', { class: 'one-ct-module-row-head' }, [
            h('span', { class: 'one-ct-module-row-name', text: module.name }),
            h('span', {
              class: 'one-ct-module-row-num',
              text:
                (module.current === null ? '—' : module.current) + ' / ' +
                (module.required === null ? '—' : module.required) + '　缺口 ' +
                (module.gap === null ? '—' : module.gap),
            }),
          ]),
          h('div', { class: barClass }, [h('i', { style: 'width:' + Math.round(ratio * 100) + '%' })]),
        ]),
      );
    });

    var activitiesWrap = h('div', { class: 'one-ct-card-body is-flush', 'data-testid': 'one-ct-stats-activities' });
    var activities = stat.activities || [];
    if (!activities.length) {
      activitiesWrap.appendChild(h('div', { class: 'one-ct-empty', text: '近 90 天没有二课签到/签退记录' }));
    } else {
      activitiesWrap.appendChild(
        h('div', { class: 'one-ct-table-wrap' }, [
          h('table', { class: 'one-ct-table one-ct-activity-table' }, [
            h('thead', null, [
              h('tr', null, [
                h('th', { text: '活动' }),
                h('th', { text: '类别' }),
                h('th', { text: '签到' }),
                h('th', { text: '签退' }),
                h('th', { text: '最近时间' }),
              ]),
            ]),
            h('tbody', null, activities.map(function (activity) {
              return h('tr', null, [
                h('td', { text: activity.name || activity.activityId || '—' }),
                h('td', { text: activity.category || '—' }),
                h('td', { text: STATUS_CN[activity.signInStatus] || activity.signInStatus || '—' }),
                h('td', { text: STATUS_CN[activity.signOutStatus] || activity.signOutStatus || '—' }),
                h('td', { class: 'one-ct-muted', text: activity.lastAt ? formatDateTime(activity.lastAt) : '—' }),
              ]);
            })),
          ]),
        ]),
      );
    }

    host.appendChild(h('div', { class: 'one-ct-stack' }, [modulesWrap, activitiesWrap]));
  }

  // ───────────────────────────── 已报名的二课 ─────────────────────────────
  //
  // 用户需求：「二课板块要能看到已报名的二课」。
  // 数据 = 本地历史（loadResults: module=ek, action=apply, status=success）
  //       ∪ 官方列表（ctAPI.ek.getActivitiesList activityStatus:'1' = 已报名，
  //         只补本地没有的活动；官方失败则只显示本地记录并明确标注）。
  //
  // 官方响应是**原始响应体**（与 3CT 渲染层一致，见 reverse 里的
  // EkActivitiesPanel.tsx：res.List.Items / res.List.TotalPages）：
  //   { List:{ Items:[...], TotalPages, TotalItems }, ActivityStatusList, ... }
  // List.Items 不是顶层数组，绝不能只认 Data/DataList/list 这种旧形态，
  // 否则每次都会误判 response-shape、页面只剩本地记录（换机/更新后看起来「清零」）。
  //
  // 签到/签退状态口径（优先级：本机 success 事件 > 官方详情签名状态 > 未知「—」）：
  //  - 本机执行成功 → 「已签到/已签退」（真实执行记录）；
  //  - 本机无记录 → 逐个拉活动详情（getActivityDetail），读
  //      ActivityInfo.ActivityListInfo.ActivitySignInfo.{SignD,SignT}
  //    与 automation.js 的 signStatusOf 同口径（'已签到'/'未签到'、'已签退'/'未签退'）；
  //  - 官方详情也取不到 → 「—」（本机无记录 ≠ 官方没签到，绝不谎报未签到）。

  /** 从本地事件里挑出「已报名」的 ek 事件 */
  function localAppliedEvents(memberId) {
    var events = [];
    try {
      if (hasFn(M, 'loadResults')) {
        events = M.loadResults({ module: 'ek', action: 'apply', status: 'success' }) || [];
      }
    } catch (e) {
      pushLog('warn', '读取已报名记录失败：' + sanitizeError(e));
      events = [];
    }
    if (!Array.isArray(events)) return [];
    return events.filter(function (event) {
      return isObject(event) && String(event.memberId || '') === String(memberId);
    });
  }

  function isApplyAction(action) {
    var a = text(action).toLowerCase().replace(/[_-]/g, '');
    return a === 'apply' || a === 'join' || a === 'applyactivity';
  }

  /** 从该成员全部事件里，给每个 activityId 找签到/签退是否成功 */
  function signStatusMap(memberId) {
    var map = Object.create(null);
    var events = [];
    try {
      events = hasFn(M, 'loadResults') ? M.loadResults({ memberId: memberId, module: 'ek' }) || [] : [];
    } catch (e) {
      events = [];
    }
    if (!Array.isArray(events)) return map;
    events.forEach(function (event) {
      if (!isObject(event) || event.status !== 'success') return;
      var action = text(event.action).toLowerCase().replace(/[_-]/g, '');
      var key = text(event.activityId) || text(event.activityName);
      if (!key) return;
      var entry = map[key] || (map[key] = { signIn: false, signOut: false, signInAt: 0, signOutAt: 0 });
      var at = num(event.at, 0) || 0;
      if (action === 'signin' || action === 'in' || action === 'checkin') {
        entry.signIn = true;
        entry.signInAt = Math.max(entry.signInAt, at);
      } else if (action === 'signout' || action === 'out' || action === 'checkout') {
        entry.signOut = true;
        entry.signOutAt = Math.max(entry.signOutAt, at);
      }
    });
    return map;
  }

  /** 官方已报名列表翻页上限（防御上游 TotalPages 异常，符合「上限 20 页」约定） */
  var OFFICIAL_APPLIED_MAX_PAGES = 20;

  // 官方签到记录（GetStuActSignList，与学校官网「活动签到签退」页同源）翻页上限
  var EK_SIGN_LIST_MAX_PAGES = 20;

  // 官方签到状态缓存与并发参数。
  // 状态来源优先级：本机 success 事件 > 官方签到记录（GetStuActSignList，与官网同源，一次批量）
  //   > 官方详情 ActivitySignInfo（兜底）> 未知「—」。
  // 官方签到记录/详情都按成员缓存 5 分钟，刷新按钮强制重拉。
  var EK_SIGN_STATUS_KEY_PREFIX = '1ct:ekSignStatus:';
  var EK_SIGN_STATUS_TTL = 5 * 60 * 1000;
  var EK_SIGN_STATUS_MAX_ITEMS = 200;
  var EK_DETAIL_CONCURRENCY = 4;

  /* 读按成员的官方签名状态缓存： */
  function readEkSignStatusCache(memberId) {
    var id = trim(memberId);
    if (!id) return null;
    try {
      var parsed = parseJson(window.localStorage.getItem(EK_SIGN_STATUS_KEY_PREFIX + id));
      if (!isObject(parsed) || num(parsed.v, 0) !== 1 || !isObject(parsed.items)) return null;
      return {
        at: num(parsed.at, 0) || 0,
        items: parsed.items,
        recent: Array.isArray(parsed.recent) ? parsed.recent : null,
      };
    } catch (e) {
      return null;
    }
  }

  /** 缓存是否在有效期内（5 分钟） */
  function isEkSignStatusCacheFresh(cache) {
    var at = cache ? num(cache.at, 0) : 0;
    return Boolean(at) && Date.now() - at >= 0 && Date.now() - at < EK_SIGN_STATUS_TTL;
  }

  /** 最近活动缓存只留安全字段（最多 6 条，无任何凭据） */
  function sanitizeRecentActivitiesCache(list) {
    if (!Array.isArray(list)) return null;
    var out = [];
    for (var i = 0; i < list.length && out.length < 6; i += 1) {
      var item = list[i];
      if (!isObject(item)) continue;
      out.push({
        activityId: trim(item.activityId),
        name: trim(item.name),
        category: trim(item.category),
        signInStatus: item.signInStatus === 'success' ? 'success' : '',
        signOutStatus: item.signOutStatus === 'success' ? 'success' : '',
        lastAt: num(item.lastAt, 0) || 0,
      });
    }
    return out;
  }

  /**
   * 写缓存（只存活动 Id/名称 + 状态/时段 + 最近活动，绝不含 token/密码）。
   * 条目上限 EK_SIGN_STATUS_MAX_ITEMS：按条目时间保留最新，防 localStorage 膨胀。
   */
  function writeEkSignStatusCache(memberId, items, at, recent) {
    var id = trim(memberId);
    if (!id) return;
    try {
      var keys = Object.keys(items || {});
      if (keys.length > EK_SIGN_STATUS_MAX_ITEMS) {
        keys.sort(function (a, b) {
          return (num(items[b] && items[b].at, 0) || 0) - (num(items[a] && items[a].at, 0) || 0);
        });
        keys = keys.slice(0, EK_SIGN_STATUS_MAX_ITEMS);
      }
      var out = {};
      keys.forEach(function (key) {
        out[key] = items[key];
      });
      var payload = { v: 1, at: num(at, 0) || Date.now(), items: out };
      var safeRecent = sanitizeRecentActivitiesCache(recent);
      if (safeRecent) payload.recent = safeRecent;
      window.localStorage.setItem(EK_SIGN_STATUS_KEY_PREFIX + id, JSON.stringify(payload));
    } catch (e) {
      /* 缓存写失败不影响主流程 */
    }
  }

  /** 布尔/数字/数字字符串/中文「是/否」→ true / false / ''（未知），只认明确值 */
  function parseStatusFlag(value) {
    if (value === true || value === 1) return true;
    if (value === false || value === 0) return false;
    if (typeof value === 'string') {
      var flagText = value.trim().toLowerCase();
      if (flagText === 'true' || flagText === '1' || flagText === '是') return true;
      if (flagText === 'false' || flagText === '0' || flagText === '否') return false;
    }
    return '';
  }

  /** 状态文本（'已签到/未签到'、'已签退/未签退'、'是/否'）→ true / false / ''（未知） */
  function parseSignStatusText(value) {
    var statusText = trim(value);
    if (!statusText) return '';
    if (/^(已签到|已签退|是|true|yes|y)$/i.test(statusText)) return true;
    if (/^(未签到|未签退|否|false|no|n)$/i.test(statusText)) return false;
    return '';
  }

  /* 官方签到记录单项 → 签到、签退状态：只认明确证据，取不到就留空。 */
  function signListStatusOf(row) {
    if (!isObject(row)) return null;
    var signIn = parseStatusFlag(row.signInStatus);
    if (signIn === '') signIn = parseStatusFlag(row.SignInStatus);
    if (signIn === '') signIn = parseSignStatusText(row.SignD);
    if (signIn === '') signIn = parseSignStatusText(row.IsSignD);
    if (signIn === '' && trim(row.Inputdate)) signIn = true;
    var signOut = parseStatusFlag(row.signOutStatus);
    if (signOut === '') signOut = parseStatusFlag(row.SignOutStatus);
    if (signOut === '') signOut = parseSignStatusText(row.SignT);
    if (signOut === '') signOut = parseSignStatusText(row.IsSignOut);
    if (signOut === '' && trim(row.SignOutdate)) signOut = true;
    return { signIn: signIn, signOut: signOut };
  }

  /** 缓存条目归一化：兼容旧版存的「已签到/未签到」文本与单 src，统一成布尔 + 每列来源 + 时段 */
  function normalizeCachedSignEntry(entry) {
    if (!isObject(entry)) return null;
    var signIn = typeof entry.signIn === 'boolean' ? entry.signIn : parseSignStatusText(entry.signIn);
    var signOut = typeof entry.signOut === 'boolean' ? entry.signOut : parseSignStatusText(entry.signOut);
    var legacySrc = entry.src === 'detail' || entry.src === 'signList' || entry.src === 'applyList' ? entry.src : '';
    return {
      signIn: signIn,
      signOut: signOut,
      srcIn: entry.srcIn === 'detail' || entry.srcIn === 'signList' || entry.srcIn === 'applyList' ? entry.srcIn : legacySrc,
      srcOut: entry.srcOut === 'detail' || entry.srcOut === 'signList' || entry.srcOut === 'applyList' ? entry.srcOut : legacySrc,
      at: num(entry.at, 0) || 0,
      name: trim(entry.name),
      qd: trim(entry.qd),
      qt: trim(entry.qt),
      needIn: trim(entry.needIn),
      needOut: trim(entry.needOut),
      activityTime: trim(entry.activityTime),
      winAt: num(entry.winAt, 0) || 0,
    };
  }

  /**
   * 读有效期内缓存 → 可直接渲染的条目（items 按 Id、byName 按活动名兜底）+ 最近活动。
   * 过期/不存在时返回空（避免展示 5 分钟前的旧状态）。
   */
  function buildSignStatusFromCache(memberId) {
    var cache = readEkSignStatusCache(memberId);
    var fresh = isEkSignStatusCacheFresh(cache);
    var items = Object.create(null);
    var byName = Object.create(null);
    var rawItems = cache && isObject(cache.items) ? cache.items : Object.create(null);
    if (fresh) {
      Object.keys(rawItems).forEach(function (id) {
        var entry = normalizeCachedSignEntry(rawItems[id]);
        if (!entry) return;
        items[id] = entry;
        if (entry.name && !byName[entry.name]) byName[entry.name] = { activityId: id };
      });
    }
    return {
      items: items,
      byName: byName,
      fresh: fresh,
      at: cache ? cache.at : 0,
      rawItems: rawItems,
      recent: fresh && cache ? sanitizeRecentActivitiesCache(cache.recent) : null,
    };
  }

  /** 各类官方数据源 → 徽标 title 文案 */
  function signSourceTitle(src) {
    if (src === 'applyList') return '来自官方报名列表';
    if (src === 'signList') return '来自官方签到记录';
    if (src === 'detail') return '来自官方详情';
    return '';
  }

  /** 官方列表行 → 按 Id 建立原始项映射（后续用 Id 拉详情） */
  function indexOfficialRowsById(rows) {
    var map = Object.create(null);
    (rows || []).forEach(function (row) {
      var id = officialRowKey(row);
      if (id && !map[id]) map[id] = row;
    });
    return map;
  }

  /* 官方详情里的签到、签退口径：结构缺失按「未知」处理。 */
  function officialSignStatusOf(detail) {
    var info = isObject(detail) && isObject(detail.ActivityInfo) ? detail.ActivityInfo : null;
    var listInfo = info && isObject(info.ActivityListInfo) ? info.ActivityListInfo : null;
    var signInfo = listInfo && isObject(listInfo.ActivitySignInfo) ? listInfo.ActivitySignInfo : null;
    if (!signInfo) return null;
    return {
      signIn: parseSignStatusText(signInfo.SignD),
      signOut: parseSignStatusText(signInfo.SignT),
    };
  }

  /* 官方详情签到/签退时段口径： */
  function officialSignWindowOf(detail) {
    var info = isObject(detail) && isObject(detail.ActivityInfo) ? detail.ActivityInfo : null;
    if (!info) return null;
    return {
      qd: trim(info.ActivityQDDate),
      qt: trim(info.ActivityQTDate),
      needIn: trim(info.IsNeedSignInText),
      needOut: trim(info.IsNeedSignOutText),
      activityTime: trim(info.ActivityTime),
    };
  }

  /** 时段数据是否有内容（含「无需签到/签退」也算有：官网明确告知了规则） */
  function hasSignWindowData(windowInfo) {
    if (!isObject(windowInfo)) return false;
    return Boolean(
      trim(windowInfo.qd) || trim(windowInfo.qt) || trim(windowInfo.needIn) || trim(windowInfo.needOut),
    );
  }

  /* 批量拉官方签到/签退时段（详情兜底，仅对官方已报名行调用）。 */
  function fetchOfficialSignWindows(member, activityIds) {
    var ids = [];
    var seen = Object.create(null);
    (activityIds || []).forEach(function (rawId) {
      var id = trim(rawId);
      if (!id || seen[id]) return;
      seen[id] = true;
      ids.push(id);
    });
    var out = {
      ok: true,
      total: ids.length,
      fetched: 0,
      failed: 0,
      items: Object.create(null),
      doneIds: Object.create(null),
    };
    if (!ids.length) return Promise.resolve(out);
    var api = window.ctAPI;
    var session = member && member.ek;
    if (!api || !api.ek || typeof api.ek.getActivityDetail !== 'function') {
      out.ok = false;
      out.failed = ids.length;
      out.reason = 'api-unavailable';
      return Promise.resolve(out);
    }
    if (!session || !session.JSESSIONID) {
      out.ok = false;
      out.failed = ids.length;
      out.reason = 'ek-not-logged-in';
      return Promise.resolve(out);
    }
    var cursor = 0;
    var active = 0;
    var done = false;
    return new Promise(function (resolve) {
      function finish() {
        if (done) return;
        done = true;
        resolve(out);
      }
      function schedule(id) {
        active += 1;
        var task;
        try {
          task = api.ek.getActivityDetail({ requestsData: clone(session), id: id });
        } catch (e) {
          task = Promise.reject(e);
        }
        Promise.resolve(task)
          .then(function (detail) {
            out.doneIds[id] = true;
            var windowInfo = officialSignWindowOf(detail);
            if (!hasSignWindowData(windowInfo)) {
              out.ok = false;
              out.failed += 1;
              return;
            }
            out.items[id] = windowInfo;
            out.fetched += 1;
          })
          .catch(function () {
            out.doneIds[id] = true;
            out.ok = false;
            out.failed += 1;
          })
          .then(function () {
            active -= 1;
            pump();
          });
      }
      function pump() {
        while (active < EK_DETAIL_CONCURRENCY && cursor < ids.length) {
          schedule(ids[cursor]);
          cursor += 1;
        }
        if (cursor >= ids.length && active === 0) finish();
      }
      pump();
    });
  }

  /* 批量拉官方详情签名状态（兜底数据源，只对签到记录没覆盖到的行调用）。 */
  function fetchOfficialSignStatuses(member, activityIds, options) {
    var force = Boolean(options && options.force);
    var bypassCache = Boolean(options && options.bypassCache);
    var ids = [];
    var seen = Object.create(null);
    (activityIds || []).forEach(function (rawId) {
      var id = trim(rawId);
      if (!id || seen[id]) return;
      seen[id] = true;
      ids.push(id);
    });
    var out = {
      ok: true,
      total: ids.length,
      failed: 0,
      fetched: 0,
      fromCache: false,
      items: Object.create(null),
      // 同一次详情响应顺带取到的签到/签退时段（避免为时段重复请求详情）
      windows: Object.create(null),
      doneIds: Object.create(null),
      windowFailed: 0,
    };
    if (!ids.length) return Promise.resolve(out);
    var api = window.ctAPI;
    var session = member && member.ek;
    var memberId = text(member && member.id);
    if (!api || !api.ek || typeof api.ek.getActivityDetail !== 'function') {
      out.ok = false;
      out.failed = ids.length;
      out.reason = 'api-unavailable';
      return Promise.resolve(out);
    }
    if (!session || !session.JSESSIONID) {
      out.ok = false;
      out.failed = ids.length;
      out.reason = 'ek-not-logged-in';
      return Promise.resolve(out);
    }

    var cached = bypassCache ? null : readEkSignStatusCache(memberId);
    var fresh = isEkSignStatusCacheFresh(cached);
    var cacheItems = cached && isObject(cached.items) ? cached.items : {};
    var pending = [];
    ids.forEach(function (id) {
      // 刷新按钮 → 全部重拉；自动加载且缓存有效 → 直接用缓存跳过网络
      if (!force && !bypassCache && fresh && isObject(cacheItems[id])) {
        var cachedEntry = normalizeCachedSignEntry(cacheItems[id]);
        if (cachedEntry) {
          out.items[id] = cachedEntry;
          return;
        }
      }
      pending.push(id);
    });
    if (!pending.length) {
      out.fromCache = true;
      return Promise.resolve(out);
    }
    var fetchedItems = Object.create(null);
    var cursor = 0;
    var active = 0;
    var done = false;
    return new Promise(function (resolve) {
      function finish() {
        if (done) return;
        done = true;
        // 回写缓存：旧条目保留，本次请求到的活动覆盖，按上限裁剪
        if (!bypassCache) {
          var all = Object.create(null);
          Object.keys(cacheItems).forEach(function (id) {
            all[id] = cacheItems[id];
          });
          Object.keys(fetchedItems).forEach(function (id) {
            all[id] = fetchedItems[id];
          });
          if (out.fetched > 0) writeEkSignStatusCache(memberId, all, Date.now());
        }
        resolve(out);
      }
      function schedule(id) {
        active += 1;
        var task;
        try {
          task = api.ek.getActivityDetail({ requestsData: clone(session), id: id });
        } catch (e) {
          task = Promise.reject(e);
        }
        Promise.resolve(task)
          .then(function (detail) {
            out.doneIds[id] = true;
            // 顺带取详情里的签到/签退时段（与状态同一次请求）
            var windowInfo = officialSignWindowOf(detail);
            if (hasSignWindowData(windowInfo)) out.windows[id] = windowInfo;
            else out.windowFailed += 1;
            var status = officialSignStatusOf(detail);
            if (!status) {
              // 详情没有签名结构：记为失败，绝不伪造「未签到/未签退」
              out.ok = false;
              out.failed += 1;
              return;
            }
            fetchedItems[id] = { signIn: status.signIn, signOut: status.signOut, at: Date.now() };
            out.items[id] = fetchedItems[id];
            out.fetched += 1;
          })
          .catch(function () {
            out.doneIds[id] = true;
            out.windowFailed += 1;
            out.ok = false;
            out.failed += 1;
          })
          .then(function () {
            active -= 1;
            pump();
          });
      }
      function pump() {
        while (active < EK_DETAIL_CONCURRENCY && cursor < pending.length) {
          schedule(pending[cursor]);
          cursor += 1;
        }
        if (cursor >= pending.length && active === 0) finish();
      }
      pump();
    });
  }

  /* 官方签到记录：与学校官网「活动签到签退」页同源。 */
  function fetchOfficialSignList(member) {
    var api = window.ctAPI;
    var session = member && member.ek;
    if (!api || !api.ek || typeof api.ek.getSignList !== 'function') {
      return Promise.resolve({ ok: false, reason: 'api-unavailable' });
    }
    if (!session || !session.JSESSIONID) {
      return Promise.resolve({ ok: false, reason: 'ek-not-logged-in' });
    }
    var items = [];
    var map = Object.create(null);
    var byName = Object.create(null);
    var seen = Object.create(null);
    var pages = 0;
    var truncated = false;
    var totalPages = null;

    function fetchPage(pageIndex) {
      if (pageIndex > EK_SIGN_LIST_MAX_PAGES) {
        truncated = true;
        return Promise.resolve();
      }
      var task;
      try {
        task = api.ek.getSignList({ requestsData: clone(session), pageIndex: pageIndex });
      } catch (e) {
        return Promise.reject(e);
      }
      return Promise.resolve(task)
        .then(function (resp) {
          var rows = extractActivityRows(resp);
          // 结构不符必须显式失败，不能当成「没有签到记录」
          if (rows === null) throw new Error('response-shape');
          pages += 1;
          if (totalPages === null) totalPages = extractActivityTotalPages(resp);
          rows.forEach(function (row) {
            if (!isObject(row)) return;
            var activityId = trim(row.ActivityId || row.activityId);
            var activityName = trim(row.ActivityName || row.activityName);
            var key = activityId || activityName;
            if (!key || seen[key]) return;
            seen[key] = true;
            items.push(row);
            var status = signListStatusOf(row);
            if (!status) return;
            var entry = {
              signIn: status.signIn,
              signOut: status.signOut,
              at: parseDateish(row.Inputdate) || parseDateish(row.SignOutdate) || 0,
              src: 'signList',
              name: activityName,
              activityId: activityId,
            };
            if (activityId) map[activityId] = entry;
            if (activityName && !byName[activityName]) byName[activityName] = entry;
          });
          var more = totalPages !== null ? pageIndex < totalPages : rows.length > 0;
          if (more) return fetchPage(pageIndex + 1);
          return undefined;
        })
        .catch(function (e) {
          // 第一页失败 → 整体失败（转详情兜底）；后续页失败 → 保留已抓到的记录并标记截断
          if (pageIndex <= 1) throw e;
          truncated = true;
        });
    }

    return fetchPage(1)
      .then(function () {
        return {
          ok: true,
          rows: items,
          map: map,
          byName: byName,
          count: Object.keys(map).length,
          pages: pages,
          truncated: truncated,
        };
      })
      .catch(function (e) {
        return { ok: false, reason: sanitizeError(e) || 'unknown' };
      });
  }

  /* 官方报名列表单项状态判定：只认明确证据，不猜未签到。 */
  function applyListStatusOf(row) {
    if (!isObject(row)) return null;
    var signInText = trim(row.SignD) || trim(row.IsSignD);
    var signIn = '';
    if (signInText.indexOf('已签到') >= 0) signIn = true;
    else if (signInText.indexOf('未签到') >= 0) signIn = false;
    if (signIn === '') signIn = parseSignStatusText(signInText);
    if (signIn === '' && trim(row.Inputdate)) signIn = true;
    var signOutText = trim(row.SignT) || trim(row.IsSignOut);
    var signOut = '';
    if (signOutText.indexOf('已签退') >= 0) signOut = true;
    else if (signOutText.indexOf('未签退') >= 0) signOut = false;
    if (signOut === '') signOut = parseSignStatusText(signOutText);
    if (signOut === '' && trim(row.SignOutdate)) signOut = true;
    return { signIn: signIn, signOut: signOut };
  }

  /* 官方报名列表：按页取回、按活动建映射，失败返回原因不抛异常。 */
  function fetchOfficialApplyList(member) {
    var api = window.ctAPI;
    var session = member && member.ek;
    if (!api || !api.ek || typeof api.ek.getStuAllActApplyList !== 'function') {
      // 旧包/未打桥：回退官方签到记录/详情链路
      return Promise.resolve({ ok: false, reason: 'api-unavailable' });
    }
    if (!session || !session.JSESSIONID) {
      return Promise.resolve({ ok: false, reason: 'ek-not-logged-in' });
    }
    var items = [];
    var map = Object.create(null);
    var byName = Object.create(null);
    var seen = Object.create(null);
    var pages = 0;
    var truncated = false;
    var totalPages = null;

    function fetchPage(pageIndex) {
      if (pageIndex > OFFICIAL_APPLIED_MAX_PAGES) {
        truncated = true;
        return Promise.resolve();
      }
      var task;
      try {
        task = api.ek.getStuAllActApplyList({ requestsData: clone(session), pageIndex: pageIndex });
      } catch (e) {
        return Promise.reject(e);
      }
      return Promise.resolve(task)
        .then(function (resp) {
          var rows = extractActivityRows(resp);
          // 结构不符必须显式失败，不能当成「没有报名记录」
          if (rows === null) throw new Error('response-shape');
          pages += 1;
          if (totalPages === null) totalPages = extractActivityTotalPages(resp);
          rows.forEach(function (row) {
            if (!isObject(row)) return;
            var activityId = trim(row.ActivityId || row.activityId);
            var activityName = trim(row.ActivityName || row.activityName);
            var key = activityId || activityName;
            if (!key || seen[key]) return;
            seen[key] = true;
            items.push(row);
            var status = applyListStatusOf(row);
            if (!status) return;
            var entry = {
              signIn: status.signIn,
              signOut: status.signOut,
              at: parseDateish(row.Inputdate) || parseDateish(row.SignOutdate) || 0,
              srcIn: status.signIn === '' ? '' : 'applyList',
              srcOut: status.signOut === '' ? '' : 'applyList',
              name: activityName,
              activityId: activityId,
            };
            if (activityId) map[activityId] = entry;
            if (activityName && !byName[activityName]) byName[activityName] = entry;
          });
          var more = totalPages !== null ? pageIndex < totalPages : rows.length > 0;
          if (more) return fetchPage(pageIndex + 1);
          return undefined;
        })
        .catch(function (e) {
          // 第一页失败 → 整体失败（回退签到记录/详情）；后续页失败 → 保留已抓到的记录并标记截断
          if (pageIndex <= 1) throw e;
          truncated = true;
        });
    }

    return fetchPage(1)
      .then(function () {
        return {
          ok: true,
          rows: items,
          map: map,
          byName: byName,
          count: Object.keys(map).length,
          pages: pages,
          truncated: truncated,
        };
      })
      .catch(function (e) {
        return { ok: false, reason: sanitizeError(e) || 'unknown' };
      });
  }

  /** 失败原因是否「像二课鉴权失效」（才允许自动重登；网络/接口错误不重登） */
  function isEkAuthFailure(reason) {
    var code = text(reason).toLowerCase();
    if (!code) return false;
    return /401|403|未登录|请登录|重新登录|登录失败|登录已|ek-not-logged-in|not-logged|session|会话.*(失效|过期)|expired/.test(code);
  }

  /** 自动重登：先 refreshEk，失败再用 ekCredentials 走 loginEk（不记录/不展示密码与 token） */
  function repairEkSession(memberId) {
    var id = trim(memberId);
    if (!id || !M) return Promise.resolve({ ok: false, reason: 'members-api-unavailable' });
    function loginFallback() {
      var member = hasFn(M, 'getMember') ? M.getMember(id) : null;
      var cred = isObject(member && member.ekCredentials) ? member.ekCredentials : null;
      var studentId = trim(cred && (cred.studentId || cred.student_id));
      var password = cred && cred.password != null ? String(cred.password) : '';
      if (!studentId || !password || !hasFn(M, 'loginEk')) {
        return Promise.resolve({ ok: false, reason: 'no-credentials' });
      }
      return Promise.resolve()
        .then(function () {
          return M.loginEk(id, { student_id: studentId, password: password });
        })
        .then(function () {
          return { ok: true, via: 'login' };
        })
        .catch(function () {
          return { ok: false, reason: 'login-failed' };
        });
    }
    if (!hasFn(M, 'refreshEk')) return loginFallback();
    return Promise.resolve()
      .then(function () {
        return M.refreshEk(id);
      })
      .then(function () {
        return { ok: true, via: 'refresh' };
      })
      .catch(function () {
        return loginFallback();
      });
  }

  /** 官方行去重键：优先官方 Id（真实形态一行一个 Id），没有 Id 才退活动名 */
  function officialRowKey(raw) {
    if (!isObject(raw)) return '';
    var id = trim(raw.Id || raw.id || raw.ActivityId || raw.activityId || raw.ActId);
    if (id) return id;
    return trim(raw.ActivityName || raw.activityName || raw.Title || raw.title || raw.name);
  }

  /* 官方已报名列表（activityStatus:'1'）。 */
  function fetchOfficialApplied(member) {
    var api = window.ctAPI;
    var session = member && member.ek;
    if (!api || !api.ek || typeof api.ek.getActivitiesList !== 'function') {
      return Promise.resolve({ ok: false, reason: 'api-unavailable' });
    }
    if (!session || !session.JSESSIONID) {
      return Promise.resolve({ ok: false, reason: 'ek-not-logged-in' });
    }
    var rows = [];
    var seen = Object.create(null);
    var pages = 0;
    var truncated = false;
    var totalPages = null;

    function fetchPage(pageIndex) {
      if (pageIndex > OFFICIAL_APPLIED_MAX_PAGES) {
        // 超过上限：标记截断，不无限请求
        truncated = true;
        return Promise.resolve();
      }
      var task;
      try {
        task = api.ek.getActivitiesList({
          requestsData: clone(session),
          pageIndex: pageIndex,
          activityStatus: '1',
        });
      } catch (e) {
        return Promise.reject(e);
      }
      return Promise.resolve(task)
        .then(function (resp) {
          var items = extractActivityRows(resp);
          // 结构不符必须显式失败，绝不能当成空列表（否则官方列表会被「清零」）
          if (items === null) throw new Error('response-shape');
          pages += 1;
          if (totalPages === null) totalPages = extractActivityTotalPages(resp);
          items.forEach(function (item) {
            var key = officialRowKey(item);
            if (!key || seen[key]) return; // 按 Id 去重（跨页重复也不再渲染）
            seen[key] = true;
            rows.push(item);
          });
          // TotalPages 已知 → 按声明翻页；未知 → 本页非空就继续（下一页为空自然停止）
          var more = totalPages !== null ? pageIndex < totalPages : items.length > 0;
          if (more) return fetchPage(pageIndex + 1);
          return undefined;
        })
        .catch(function (e) {
          // 第一页失败 → 整体失败（页面降级为本地记录）；
          // 后续页失败 → 保留已抓到的行并标记截断，不把已有结果丢掉。
          if (pageIndex <= 1) throw e;
          truncated = true;
        });
    }

    return fetchPage(1)
      .then(function () {
        return { ok: true, rows: rows, pages: pages, truncated: truncated };
      })
      .catch(function (e) {
        return { ok: false, reason: sanitizeError(e) || 'unknown' };
      });
  }

  /* 官方分页响应 → 行数组；结构不符返回 null（不能当空列表）。 */
  function extractActivityRows(resp) {
    if (Array.isArray(resp)) return resp;
    if (!isObject(resp)) return null;
    // 1) 真实形态：{ List:{Items:[...]} } / { PageList:{Items:[...]} }
    var boxes = [resp.PageList, resp.pageList, resp.List, resp.list];
    for (var i = 0; i < boxes.length; i += 1) {
      var box = boxes[i];
      if (Array.isArray(box)) return box; // { List:[...] } 兼容
      if (!isObject(box)) continue;
      var boxed = [box.Items, box.items, box.rows, box.Rows, box.Data, box.data, box.records, box.Records];
      for (var j = 0; j < boxed.length; j += 1) {
        if (Array.isArray(boxed[j])) return boxed[j];
      }
    }
    // 2) 旧形态：顶层就是数组字段
    var direct = ['Data', 'data', 'DataList', 'list', 'rows', 'Rows', 'Items', 'items', 'records', 'Records'];
    for (var k = 0; k < direct.length; k += 1) {
      if (Array.isArray(resp[direct[k]])) return resp[direct[k]];
    }
    // 3) 嵌套一层：{ Data:{ List:{ Items:[...] } } } / { response:{ list:[...] } }
    var containers = ['Data', 'data', 'response', 'Response', 'result', 'Result'];
    for (var m = 0; m < containers.length; m += 1) {
      var inner = resp[containers[m]];
      if (isObject(inner)) {
        var nested = extractActivityRows(inner);
        if (nested) return nested;
      }
    }
    return null;
  }

  /**
   * 从官方分页响应里读 TotalPages（List / PageList，兼容小写与嵌套）。
   * 读不到返回 null；<=0 视为未知（由调用方按「本页非空继续」兜底）。
   */
  function extractActivityTotalPages(resp) {
    if (!isObject(resp)) return null;
    var boxes = [resp.PageList, resp.pageList, resp.List, resp.list];
    for (var i = 0; i < boxes.length; i += 1) {
      var box = boxes[i];
      if (!isObject(box)) continue;
      var raw = box.TotalPages;
      if (raw === undefined || raw === null) raw = box.totalPages;
      if (raw === undefined || raw === null) raw = box.TotalPage;
      if (raw === undefined || raw === null) raw = box.totalPage;
      var pages = num(raw);
      if (pages !== null && pages > 0) return Math.floor(pages);
    }
    var containers = ['Data', 'data', 'response', 'Response', 'result', 'Result'];
    for (var j = 0; j < containers.length; j += 1) {
      var inner = resp[containers[j]];
      if (isObject(inner)) {
        var nested = extractActivityTotalPages(inner);
        if (nested !== null) return nested;
      }
    }
    return null;
  }

  /* 官方活动行 → 统一行。 */
  function normalizeAppliedRow(raw) {
    if (!isObject(raw)) return null;
    var id = trim(raw.Id || raw.id || raw.ActivityId || raw.activityId || raw.ActId);
    var name = trim(
      raw.ActivityName || raw.activityName || raw.Title || raw.title || raw.Name || raw.name,
    );
    if (!id && !name) return null;
    var category = trim(
      raw.ModuleCodeText || raw.CategoryName || raw.ModuleName || raw.category ||
        raw.TypeName || raw.ActivityTypeName || raw.ModuleCode,
    );
    var statusName = trim(raw.StatusName || raw.statusName || raw.ActivityStatusName);
    var activityTime = trim(raw.ActivityTime || raw.activityTime);
    var applyRaw =
      raw.ApplyTime || raw.applyTime || raw.ApplyAt || raw.SignUpTime ||
      raw.CreateTime || raw.StuETime || raw.stuETime;
    var appliedAt = num(applyRaw, 0) || parseDateish(applyRaw);
    return {
      activityId: id,
      name: name || id,
      category: category,
      statusName: statusName,
      activityTime: activityTime,
      appliedAt: appliedAt || 0,
      officialOnly: true,
    };
  }

  function parseDateish(value) {
    if (value === null || value === undefined || value === '') return 0;
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    var parsed = Date.parse(String(value).replace(/-/g, '/'));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  /**
   * 合并本地 + 官方 → 已报名行列表。
   * 同一活动以 activityId 为键；本地记录优先（有真实报名时间）。
   */
  function mergeAppliedRows(localEvents, officialRows) {
    var byKey = Object.create(null);
    var order = [];
    localEvents.forEach(function (event) {
      var key = text(event.activityId) || text(event.activityName);
      if (!key) return;
      if (!byKey[key]) {
        byKey[key] = {
          activityId: text(event.activityId) || key,
          name: text(event.activityName) || key,
          category: text(event.category),
          appliedAt: num(event.at, 0) || 0,
          source: 'local',
        };
        order.push(key);
      } else {
        var entry = byKey[key];
        entry.appliedAt = Math.max(entry.appliedAt, num(event.at, 0) || 0);
        if (!entry.name || entry.name === key) entry.name = text(event.activityName) || entry.name;
        if (!entry.category) entry.category = text(event.category);
      }
    });
    (officialRows || []).forEach(function (row) {
      var normalized = normalizeAppliedRow(row);
      if (!normalized) return;
      var key = normalized.activityId || normalized.name;
      if (byKey[key]) {
        var existing = byKey[key];
        // 本地优先：只补本地缺失的信息，不覆盖本地报名时间/名称
        if (!existing.category) existing.category = normalized.category;
        if (!existing.appliedAt) existing.appliedAt = normalized.appliedAt;
        if (!existing.statusName) existing.statusName = normalized.statusName;
        if (!existing.activityTime) existing.activityTime = normalized.activityTime;
        existing.inOfficial = true;
        return;
      }
      byKey[key] = {
        activityId: normalized.activityId || key,
        name: normalized.name,
        category: normalized.category,
        appliedAt: normalized.appliedAt,
        statusName: normalized.statusName,
        activityTime: normalized.activityTime,
        source: 'official',
      };
      order.push(key);
    });
    return order.map(function (key) {
      return byKey[key];
    });
  }

  function renderEkView() {
    reloadMembers();
    reloadConfig();
    var items = memberList();
    var selected = getMember(ui.selectedMemberId) || items[0] || null;
    if (selected && String(ui.selectedMemberId || '') !== String(selected.id)) {
      saveUi({ selectedMemberId: selected.id });
    }

    var select = h('select', {
      class: 'one-ct-select is-flex',
      'data-testid': 'one-ct-ek-member-select',
      'aria-label': '选择成员',
    });
    if (!items.length) {
      select.appendChild(h('option', { value: '', text: '（暂无成员）' }));
    } else {
      items.forEach(function (member) {
        var option = h('option', { value: String(member.id), text: text(member.name) || String(member.id) });
        if (selected && String(member.id) === String(selected.id)) option.selected = true;
        select.appendChild(option);
      });
    }
    select.addEventListener('change', function () {
      saveUi({ selectedMemberId: select.value || null });
      renderView();
    });

    var stat = null;
    var host = h('div', { class: 'one-ct-stats-host', 'data-testid': 'one-ct-stats-host' });

    // ── 同步全部成员官方成绩 ──
    var syncAllStatus = h('span', { class: 'one-ct-hint', 'data-testid': 'one-ct-sync-all-status' });
    var syncAllBtn = h('button', {
      class: 'one-ct-btn',
      type: 'button',
      text: '同步全部成员成绩',
      'data-testid': 'one-ct-sync-all',
      onclick: function () {
        doSyncAll();
      },
    });

    function refreshSyncAllStatus() {
      var at = latestSyncAt();
      syncAllStatus.textContent = lastSyncAllText || (at ? '上次同步：' + formatDateTime(at) : '尚未同步官方成绩');
      if (!hasSyncAllApi() && !hasSyncApi()) {
        syncAllBtn.disabled = true;
        syncAllBtn.textContent = '同步功能未就绪';
        syncAllBtn.title = '同步功能暂时不可用，请重启软件再试';
      }
    }

    function doSyncAll() {
      if (syncAllBtn.disabled) return;
      var hadBusy = syncAllBtn.getAttribute('data-busy') === '1';
      if (hadBusy) return;
      syncAllBtn.setAttribute('data-busy', '1');
      syncAllBtn.disabled = true;
      var originalText = syncAllBtn.textContent;
      syncAllBtn.textContent = '同步中…';
      syncAllStatus.textContent = '正在从二课官网读取各成员八模块成绩…';
      var task;
      try {
        if (hasSyncAllApi()) {
          task = M.syncAllOfficialScores({ force: true });
        } else if (hasSyncApi()) {
          // 降级：逐个同步具备会话的成员（串行）
          var targets = memberList().filter(canSyncMember);
          var results = [];
          task = targets
            .reduce(function (chain, member) {
              return chain.then(function () {
                return syncMemberScores(member.id).then(function (one) {
                  results.push({ memberId: member.id, ok: one.ok, reason: one.reason });
                });
              });
            }, Promise.resolve())
            .then(function () {
              return { ok: true, results: results };
            });
        } else {
          throw new Error('同步服务暂时不可用，请重启软件再试');
        }
      } catch (e) {
        task = Promise.reject(e);
      }
      Promise.resolve(task)
        .then(function (result) {
          reloadMembers();
          lastSyncAllAt = Date.now();
          var list = result && Array.isArray(result.results) ? result.results : [];
          var okCount = list.filter(function (item) {
            return item && item.ok !== false;
          }).length;
          var failList = list.filter(function (item) {
            return item && item.ok === false;
          });
          if (result && result.ok === false && !list.length) {
            lastSyncAllText = '同步失败：' + syncReasonCn(result.reason);
            pushLog('warn', '同步官方成绩失败：' + syncReasonCn(result.reason));
          } else {
            lastSyncAllText =
              '同步完成：成功 ' + okCount + ' / ' + list.length + ' 人' +
              (failList.length ? '（失败 ' + failList.length + '）' : '') +
              ' · ' + formatDateTime(lastSyncAllAt);
            pushLog(
              failList.length ? 'warn' : 'success',
              '同步官方成绩：成功 ' + okCount + ' / ' + list.length + ' 人',
            );
          }
          renderView();
        })
        .catch(function (e) {
          lastSyncAllText = '同步失败：' + sanitizeError(e);
          syncAllStatus.textContent = lastSyncAllText;
          pushLog('error', '同步官方成绩失败：' + sanitizeError(e));
          syncAllBtn.disabled = false;
          syncAllBtn.removeAttribute('data-busy');
          syncAllBtn.textContent = originalText;
        });
    }

    var exportBtn = h('button', {
      class: 'one-ct-btn',
      type: 'button',
      text: '导出表格',
      'data-testid': 'one-ct-ek-export-csv',
      onclick: function () {
        if (!stat) {
          pushLog('warn', '暂无统计数据可导出');
          return;
        }
        // OneCTStats.toCSV 自带 UTF-8 BOM；只有内置兜底实现才需要补 BOM（不能重复加）
        var hasStatsModule = S && hasFn(S, 'toCSV');
        var csv = hasStatsModule ? S.toCSV(stat) : '\ufeff' + fallbackCSV(stat);
        var name = text(stat.memberName) || 'member';
        if (downloadText('1ct-二课统计-' + name + '-' + todayStamp() + '.csv', csv, 'text/csv;charset=utf-8')) {
          pushLog('info', '已导出二课统计表格：' + name);
        }
      },
    });

    if (selected) {
      var events = loadResultEvents().filter(function (event) {
        return isObject(event) && String(event.memberId || '') === String(selected.id);
      });
      stat = buildStat(selected, events, scoreEntryForStat(selected));
      renderStatInto(host, stat, selected);
    } else {      exportBtn.disabled = true;
      host.appendChild(h('div', { class: 'one-ct-empty', 'data-testid': 'one-ct-stats-empty' }, [
        h('div', { class: 'one-ct-empty-title', text: '还没有成员' }),
        h('div', { text: '新增成员后，这里会显示签到/签退成功统计与八模块进度。' }),
      ]));
    }

    var metaRow = h('div', { class: 'one-ct-row', 'data-testid': 'one-ct-stats-meta' }, [
      h('span', { class: 'one-ct-hint', text: '统计窗口：最近 90 天 · 成功只认上游已接受的签到/签退' }),
      (function () {
        // 八模块来源：official = 官方接口同步；否则沿用旧数据
        var source = selected && selected.ekModulesSource === 'official' ? 'official' : 'local';
        var updatedAt = selected ? memberModulesUpdatedAt(selected) : 0;
        if (source === 'official') {
          return h('span', { class: 'one-ct-badge one-ct-badge--ok', 'data-testid': 'one-ct-stats-source', text: '官方成绩' });
        }
        if (selected && Array.isArray(selected.ekModules) && selected.ekModules.length) {
          return h('span', { class: 'one-ct-badge', 'data-testid': 'one-ct-stats-source', text: '本地成绩（未同步）' });
        }
        return h('span', { class: 'one-ct-badge', 'data-testid': 'one-ct-stats-source', text: '无成绩数据' });
      })(),
      selected && memberModulesUpdatedAt(selected)
        ? h('span', { class: 'one-ct-hint', 'data-testid': 'one-ct-stats-sync-time', text: '成绩同步于 ' + formatDateTime(memberModulesUpdatedAt(selected)) })
        : null,
      stat && stat.stale ? h('span', { class: 'one-ct-badge one-ct-badge--warn', text: '数据可能过期' }) : null,
      stat && stat.refreshedAt ? h('span', { class: 'one-ct-hint', text: '快照刷新于 ' + formatDateTime(stat.refreshedAt) }) : null,
    ]);

    // 「最近活动」数据源提示（官方报名列表 / 本机执行记录回退）
    var statsSourceHint = h('div', {
      class: 'one-ct-hint one-ct-stats-source-hint',
      'data-testid': 'one-ct-stats-source-hint',
    });
    // 本机最近活动快照：官网报名列表不可用时回退展示
    var localStatActivities = stat && Array.isArray(stat.activities) ? stat.activities.slice() : [];

    // ── 已报名的二课（本地历史 ∪ 官方已报名列表） ──
    var appliedHost = h('div', { 'data-testid': 'one-ct-ek-applied-host' });
    var appliedNote = h('div', { class: 'one-ct-hint', 'data-testid': 'one-ct-ek-applied-note' });
    var appliedRefreshBtn = h('button', {
      class: 'one-ct-btn one-ct-btn--sm',
      type: 'button',
      text: '刷新',
      'data-testid': 'one-ct-ek-applied-refresh',
      onclick: function () {
        loadApplied(true);
      },
    });

    // 官方签到状态（优先级：本机 success > 官方报名列表 GetStuAllActApplyList（主数据源）
    //   > 官方签到记录 GetStuActSignList > 官方详情 > 「—」）。
    // signDetail = {
    //   items:{activityId:{signIn,signOut,srcIn,srcOut,at,name}}, byName:{活动名:{activityId}|entry},
    //   applyListLoading/Fetched/Pages/Failed, signListLoading/Fetched/Pages/Failed,
    //   loading(detail)/fetched/failed, statusFromCache, autoRepaired, sessionExpired,
    // }
    var signDetail = {
      items: Object.create(null),
      byName: Object.create(null),
      // applyList/signList 的「覆盖范围」（有记录即覆盖，哪怕 SignD/SignT 为空）
      applyListCoveredIds: Object.create(null),
      applyListCoveredNames: Object.create(null),
      signListCoveredIds: Object.create(null),
      signListCoveredNames: Object.create(null),
      applyListLoading: false,
      applyListFetched: 0,
      applyListPages: 0,
      applyListFailed: false,
      applyListTruncated: false,
      signListLoading: false,
      signListFetched: 0,
      signListPages: 0,
      signListFailed: false,
      loading: false,
      fetched: 0,
      failed: 0,
      winLoading: false,
      winFetched: 0,
      winFailed: 0,
      statusFromCache: false,
      autoRepaired: false,
      sessionExpired: false,
    };
    var appliedBaseText = '';

    /** 官方签到状态后缀（报名列表 / 签到记录 / 详情兜底 / 缓存 / 失败数在 appliedNote 里可见） */
    function appliedSignSuffix() {
      var parts = [];
      if (signDetail.autoRepaired) parts.push('已自动重新登录二课');
      if (signDetail.sessionExpired) {
        return parts.length ? ' · ' + parts.join(' · ') : '';
      }
      if (signDetail.applyListLoading) {
        parts.push('正在读取官方报名列表…');
      } else {
        if (signDetail.applyListFetched > 0) {
          parts.push(
            '官方报名列表签到状态已更新 ' + signDetail.applyListFetched + ' 条' +
              (signDetail.applyListPages > 1 ? '（共 ' + signDetail.applyListPages + ' 页）' : '') +
              (signDetail.applyListTruncated ? '（已截断）' : ''),
          );
        }
        if (signDetail.applyListFailed) parts.push('官方报名列表没读到，改用签到记录和活动详情补');
        if (signDetail.signListLoading) {
          parts.push('正在读取官方签到记录…');
        } else {
          if (signDetail.signListFetched > 0) {
            parts.push(
              '官方签到记录已更新 ' + signDetail.signListFetched + ' 条' +
                (signDetail.signListPages > 1 ? '（共 ' + signDetail.signListPages + ' 页）' : ''),
            );
          }
          if (signDetail.signListFailed) parts.push('官方签到记录读取失败（转详情兜底）');
        }
      }
      if (signDetail.loading) {
        parts.push('正在读取官方详情…');
      } else {
        if (signDetail.fetched > 0) parts.push('官方详情已更新 ' + signDetail.fetched + ' 个');
        if (signDetail.failed > 0) parts.push('活动详情：' + signDetail.failed + ' 个活动没读到状态（显示 —）');
      }
      if (signDetail.winLoading) {
        parts.push('正在读取官方签到/签退时段…');
      } else {
        if (signDetail.winFetched > 0) parts.push('官方签到/签退时段已更新 ' + signDetail.winFetched + ' 个');
        if (signDetail.winFailed > 0) parts.push('签到时段读取失败 ' + signDetail.winFailed + ' 个（显示 —）');
      }
      if (signDetail.statusFromCache) parts.push('签到状态来自缓存（5 分钟内）');
      return parts.length ? ' · ' + parts.join(' · ') : '';
    }

    function refreshAppliedNoteSuffix() {
      appliedNote.textContent = appliedBaseText + appliedSignSuffix();
    }

    /** 已报名行 → 官方签到状态（先按 Id，再用活动名兜底匹配） */
    function lookupSignStatus(row) {
      if (!row) return null;
      var id = text(row.activityId);
      if (id && signDetail.items[id]) return signDetail.items[id];
      var name = text(row.name);
      var ref = name ? signDetail.byName[name] : null;
      if (!ref) return null;
      if (ref.activityId && signDetail.items[ref.activityId]) return signDetail.items[ref.activityId];
      return ref;
    }

    /** 防串页/串成员：切页、切成员、DOM 已重建时丢弃过期结果 */
    function appliedViewStillCurrent(memberSnapshot) {
      if (modal || ui.tab !== 'ek') return false;
      if (!appliedHost.isConnected) return false;
      if (!memberSnapshot || String(ui.selectedMemberId || '') !== String(memberSnapshot.id)) return false;
      return true;
    }

    /** 生成条目：已知列带来源 src，未知列保留旧值/旧来源；时段字段原样保留 */
    function buildStatusEntry(base, incoming, src) {
      var prev = isObject(base) ? base : null;
      var entry = {
        signIn: prev ? prev.signIn : '',
        signOut: prev ? prev.signOut : '',
        srcIn: prev ? prev.srcIn : '',
        srcOut: prev ? prev.srcOut : '',
        at: (prev && prev.at) || 0,
        name: (prev && prev.name) || '',
        qd: (prev && prev.qd) || '',
        qt: (prev && prev.qt) || '',
        needIn: (prev && prev.needIn) || '',
        needOut: (prev && prev.needOut) || '',
        activityTime: (prev && prev.activityTime) || '',
        winAt: (prev && prev.winAt) || 0,
      };
      if (incoming.signIn === true || incoming.signIn === false) {
        // 高优先级数据源覆盖已知列
        entry.signIn = incoming.signIn;
        entry.srcIn = src;
      } else if (entry.signIn === '' && isObject(prev) && prev.signIn !== '') {
        entry.signIn = prev.signIn;
      }
      if (incoming.signOut === true || incoming.signOut === false) {
        entry.signOut = incoming.signOut;
        entry.srcOut = src;
      } else if (entry.signOut === '' && isObject(prev) && prev.signOut !== '') {
        entry.signOut = prev.signOut;
      }
      if (incoming.name) entry.name = incoming.name;
      if (incoming.at) entry.at = incoming.at;
      if (!entry.at) entry.at = Date.now();
      return entry;
    }

    /** 官方签到/签退时段 → signDetail（保留既有状态/来源） */
    function mergeSignWindowStatuses(windowItems) {
      Object.keys(windowItems || {}).forEach(function (id) {
        var incoming = windowItems[id];
        if (!isObject(incoming)) return;
        var entry = signDetail.items[id];
        if (!entry) {
          entry = buildStatusEntry(null, {}, 'detail');
          signDetail.items[id] = entry;
        }
        if (incoming.qd) entry.qd = incoming.qd;
        if (incoming.qt) entry.qt = incoming.qt;
        if (incoming.needIn) entry.needIn = incoming.needIn;
        if (incoming.needOut) entry.needOut = incoming.needOut;
        if (incoming.activityTime) entry.activityTime = incoming.activityTime;
        entry.winAt = Date.now();
      });
    }

    /** 官方报名列表 → signDetail（主数据源，已知列覆盖其它来源） */
    function mergeApplyListStatuses(applyResult) {
      var listMap = applyResult && isObject(applyResult.map) ? applyResult.map : {};
      Object.keys(listMap).forEach(function (id) {
        signDetail.items[id] = buildStatusEntry(signDetail.items[id], listMap[id], 'applyList');
      });
      var listByName = applyResult && isObject(applyResult.byName) ? applyResult.byName : {};
      Object.keys(listByName).forEach(function (name) {
        var incoming = listByName[name];
        if (incoming.activityId && signDetail.items[incoming.activityId]) {
          signDetail.byName[name] = { activityId: incoming.activityId };
          return;
        }
        if (!signDetail.byName[name]) signDetail.byName[name] = buildStatusEntry(null, incoming, 'applyList');
      });
    }

    /** 官方签到记录 → signDetail（只补报名列表没覆盖/未知的列） */
    function mergeSignListStatuses(listResult) {
      var listMap = listResult && isObject(listResult.map) ? listResult.map : {};
      Object.keys(listMap).forEach(function (id) {
        signDetail.items[id] = buildStatusEntry(signDetail.items[id], listMap[id], 'signList');
      });
      // 无 ActivityId 的记录按活动名兜底（不用于详情请求）
      var listByName = listResult && isObject(listResult.byName) ? listResult.byName : {};
      Object.keys(listByName).forEach(function (name) {
        if (signDetail.byName[name]) return;
        var incoming = listByName[name];
        if (incoming.activityId && signDetail.items[incoming.activityId]) {
          signDetail.byName[name] = { activityId: incoming.activityId };
          return;
        }
        signDetail.byName[name] = buildStatusEntry(null, incoming, 'signList');
      });
    }

    /** 官方详情兜底结果 → signDetail（只补未知列，src 按列标记 detail） */
    function mergeDetailStatuses(detailItems) {
      Object.keys(detailItems || {}).forEach(function (id) {
        var incoming = detailItems[id];
        if (!isObject(incoming)) return;
        signDetail.items[id] = buildStatusEntry(signDetail.items[id], incoming, 'detail');
      });
    }

    /** 回写 5 分钟缓存：保留旧条目 + 当前 signDetail 条目；recent 不传则保留旧值 */
    function persistSignStatusCache(memberId, baseItems, recent) {
      var merged = Object.create(null);
      Object.keys(baseItems || {}).forEach(function (id) {
        merged[id] = baseItems[id];
      });
      Object.keys(signDetail.items).forEach(function (id) {
        var entry = signDetail.items[id];
        if (!entry) return;
        merged[id] = {
          signIn: entry.signIn,
          signOut: entry.signOut,
          srcIn: entry.srcIn || '',
          srcOut: entry.srcOut || '',
          at: entry.at || Date.now(),
          name: entry.name || '',
          qd: entry.qd || '',
          qt: entry.qt || '',
          needIn: entry.needIn || '',
          needOut: entry.needOut || '',
          activityTime: entry.activityTime || '',
          winAt: entry.winAt || 0,
        };
      });
      var recentOut;
      if (recent !== undefined) {
        recentOut = recent;
      } else {
        var existing = readEkSignStatusCache(memberId);
        recentOut = existing && Array.isArray(existing.recent) ? existing.recent : undefined;
      }
      writeEkSignStatusCache(memberId, merged, Date.now(), recentOut);
    }

    function renderAppliedRows(rows, signMap) {
      clear(appliedHost);
      if (!rows.length) {
        appliedHost.appendChild(
          h('div', {
            class: 'one-ct-empty',
            'data-testid': 'one-ct-ek-applied-empty',
            text: '还没有已报名的二课',
          }),
        );
        return;
      }
      var localSignMap = signMap || (selected ? signStatusMap(selected.id) : Object.create(null));
      var body = rows.map(function (row) {
        var key = row.activityId || row.name;
        var sign = localSignMap[key] || {};
        var signInOk = sign.signIn === true;
        var signOutOk = sign.signOut === true;
        var official = lookupSignStatus(row);
        // 该行是否出现在官方已报名列表（含「本地+官方」合并行）：
        // 只有这种行才有官方签到记录/详情，本地-only 行沿用旧口径（未签到/未签退）。
        var hasOfficialList = row.source === 'official' || row.inOfficial === true;
        /* 状态徽标：本机执行记录优先，其次官方报名列表、签到记录、活动详情，都没有就显示「—」。 */
        function statusBadge(kind, localOk) {
          if (localOk) {
            return h('span', {
              class: 'one-ct-badge one-ct-badge--ok',
              'data-testid': 'one-ct-ek-applied-status',
              'data-status': 'success',
              title: '来自本机执行记录',
              text: '已' + kind,
            });
          }
          if (hasOfficialList) {
            var value = official ? (kind === '签到' ? official.signIn : official.signOut) : '';
            var src = official
              ? kind === '签到'
                ? official.srcIn
                : official.srcOut
              : '';
            var sourceTitle = signSourceTitle(src) || '来自官方签到记录';
            if (value === true) {
              return h('span', {
                class: 'one-ct-badge one-ct-badge--ok',
                'data-testid': 'one-ct-ek-applied-status',
                'data-status': 'success',
                title: sourceTitle,
                text: '已' + kind,
              });
            }
            if (value === false) {
              return h('span', {
                class: 'one-ct-badge',
                'data-testid': 'one-ct-ek-applied-status',
                'data-status': 'none',
                title: sourceTitle,
                text: '未' + kind,
              });
            }
            // 各官方数据源都没给出明确状态（还在读取 / 取不到）：显示「—」，不谎报未签到
            var unknownTitle;
            if (isApplyListCovered(row)) {
              // 报名列表已覆盖但没给该列状态：不再兜底，直接「—」
              unknownTitle = '本机无记录，官方报名列表未提供签到/签退状态（以官方平台为准）';
            } else if (signDetail.applyListLoading || signDetail.signListLoading || signDetail.loading) {
              unknownTitle = '本机无记录，正在读取官方报名列表/签到记录/详情';
            } else {
              unknownTitle = '本机无记录，官方报名列表/签到记录/详情未取到（以官方平台为准）';
            }
            return h('span', {
              class: 'one-ct-badge',
              'data-testid': 'one-ct-ek-applied-status',
              'data-status': 'unknown',
              title: unknownTitle,
              text: '—',
            });
          }
          // 本地-only 行：保持原有口径
          return h('span', {
            class: 'one-ct-badge',
            'data-testid': 'one-ct-ek-applied-status',
            'data-status': 'none',
            title: '来自本机执行记录',
            text: '未' + kind,
          });
        }
        // 官方签到/签退时段副行（数据源：官方详情 ActivityQDDate/ActivityQTDate；
        // 无需签到/签退显示「无需…」；取不到显示 —；本地-only 行不请求详情，也显示 —）
        // 两行展示（签到时段 / 签退时段各一行），避免窄列被单行省略号截断。
        var windowEntry = official || {};
        var winInText = windowEntry.needIn === '否' ? '无需签到' : windowEntry.qd || '—';
        var winOutText = windowEntry.needOut === '否' ? '无需签退' : windowEntry.qt || '—';
        var windowText = '签到时段：' + winInText + ' · 签退时段：' + winOutText;
        var windowTitle =
          windowText +
          '（来自官方详情' +
          (windowEntry.activityTime ? ' · 活动时间：' + windowEntry.activityTime : '') +
          '）';
        return h('tr', {
          'data-testid': 'one-ct-ek-applied-row',
          'data-activity-id': row.activityId || '',
          'data-source': row.source,
        }, [
          h('td', null, [
            h('div', { class: 'one-ct-cell-name-main', style: 'white-space:normal;word-break:break-word' }, [
              h('div', {
                class: 'one-ct-cell-name-text',
                text: row.name || row.activityId,
                title: row.activityTime ? '活动时间：' + row.activityTime : '',
              }),
              row.source === 'official'
                ? h('div', {
                    class: 'one-ct-cell-sub',
                    text: row.statusName ? '来自官方列表 · ' + row.statusName : '来自官方列表',
                  })
                : null,
              h('div', {
                class: 'one-ct-cell-sub one-ct-cell-window',
                'data-testid': 'one-ct-ek-applied-window',
                title: windowTitle,
                style:
                  'white-space:normal;overflow:visible;text-overflow:clip;line-height:1.45;max-width:none;display:block',
              }, [
                h('div', { class: 'one-ct-cell-window-line', text: '签到时段：' + winInText }),
                h('div', { class: 'one-ct-cell-window-line', text: '签退时段：' + winOutText }),
              ]),
            ]),
          ]),
          h('td', null, [h('span', { text: row.category || '—' })]),
          h('td', { class: 'one-ct-muted' }, [
            h('span', {
              class: 'one-ct-num',
              text: row.appliedAt ? formatDateTime(row.appliedAt) : '—',
            }),
          ]),
          h('td', null, [statusBadge('签到', signInOk)]),
          h('td', null, [statusBadge('签退', signOutOk)]),
        ]);
      });
      appliedHost.appendChild(
        h('div', { class: 'one-ct-table-wrap' }, [
          h('table', { class: 'one-ct-table', 'data-testid': 'one-ct-ek-applied-table' }, [
            h('thead', null, [
              h('tr', null, [
                h('th', { text: '活动' }),
                h('th', { text: '类别' }),
                h('th', { text: '报名时间' }),
                h('th', { text: '签到' }),
                h('th', { text: '签退' }),
              ]),
            ]),
            h('tbody', null, body),
          ]),
        ]),
      );
    }

    function loadApplied(manual, retryOptions) {
      if (!selected) {
        clear(appliedHost);
        appliedBaseText = '';
        appliedNote.textContent = '';
        appliedHost.appendChild(
          h('div', {
            class: 'one-ct-empty',
            'data-testid': 'one-ct-ek-applied-empty',
            text: '还没有已报名的二课',
          }),
        );
        return;
      }
      var context = {
        member: (retryOptions && retryOptions.member) || selected,
        manual: Boolean(manual),
        retried: Boolean(retryOptions && retryOptions.retried),
        repaired: Boolean(retryOptions && retryOptions.repaired),
        repairing: false,
      };
      var memberId = context.member.id;
      var localEvents = localAppliedEvents(memberId);
      var localSignMap = signStatusMap(memberId);
      signDetail.items = Object.create(null);
      signDetail.byName = Object.create(null);
      signDetail.applyListCoveredIds = Object.create(null);
      signDetail.applyListCoveredNames = Object.create(null);
      signDetail.signListCoveredIds = Object.create(null);
      signDetail.signListCoveredNames = Object.create(null);
      signDetail.applyListLoading = false;
      signDetail.applyListFetched = 0;
      signDetail.applyListPages = 0;
      signDetail.applyListFailed = false;
      signDetail.applyListTruncated = false;
      signDetail.signListLoading = false;
      signDetail.signListFetched = 0;
      signDetail.signListPages = 0;
      signDetail.signListFailed = false;
      signDetail.loading = false;
      signDetail.fetched = 0;
      signDetail.failed = 0;
      signDetail.winLoading = false;
      signDetail.winFetched = 0;
      signDetail.winFailed = 0;
      signDetail.statusFromCache = false;
      signDetail.autoRepaired = context.repaired;
      signDetail.sessionExpired = false;
      // 先渲染本地记录（不等待网络），再补官方并集
      renderAppliedRows(mergeAppliedRows(localEvents, []), localSignMap);
      appliedBaseText = '正在读取官方已报名列表…';
      refreshAppliedNoteSuffix();
      runAppliedData(context, localEvents, localSignMap);
    }

    /** 拉官方已报名数据：列表 → 官方报名列表（主） → 签到记录/详情兜底 → 签到时段 */
    function runAppliedData(context, localEvents, localSignMap) {
      var member = context.member;
      var memberId = member.id;
      fetchOfficialApplied(member).then(function (result) {
        if (!appliedViewStillCurrent(context.member)) return; // 已切页/切成员/视图已重建
        if (!result.ok) {
          // 鉴权失效（401/403/未登录/443…）→ 先自动重登再重试一次；非鉴权错误直接降级
          if (isEkAuthFailure(result.reason) && !context.retried) {
            attemptEkRepairAndRetry(context, localEvents, localSignMap);
            return;
          }
          renderAppliedRows(mergeAppliedRows(localEvents, []), localSignMap);
          renderRecentLocalFallback();
          if (isEkAuthFailure(result.reason)) {
            showSessionExpired(result.reason);
          } else {
            appliedBaseText = '官方列表读取失败，以下为本地记录' + (result.reason ? '（' + syncReasonCn(result.reason) + '）' : '');
            refreshAppliedNoteSuffix();
          }
          if (context.manual) pushLog('warn', '官方已报名列表读取失败：' + syncReasonCn(result.reason));
          return;
        }
        signDetail.sessionExpired = false;
        var officialById = indexOfficialRowsById(result.rows);
        var rows = mergeAppliedRows(localEvents, result.rows);
        var officialCount = (result.rows || []).length;
        var localCount = localEvents.length;
        // 说明文案：分别交代官方列表/本地记录/合并后的条数，便于用户判断「是不是没读到官方」
        appliedBaseText =
          '官方已报名列表共 ' + officialCount + ' 个 · 本地记录 ' + localCount + ' 个' +
          (rows.length ? ' · 合并 ' + rows.length + ' 个' : '') +
          (result.pages > 1 ? ' · 共 ' + result.pages + ' 页' : '') +
          (result.truncated ? ' · 已截断（最多 ' + OFFICIAL_APPLIED_MAX_PAGES + ' 页）' : '');
        // 官方列表行先用缓存里的官方签到状态/时段立即渲染（不阻塞网络）
        var cachedSign = buildSignStatusFromCache(memberId);
        signDetail.items = cachedSign.items;
        signDetail.byName = cachedSign.byName;
        renderAppliedRows(rows, localSignMap);
        refreshAppliedNoteSuffix();
        if (!officialCount) return; // 没有官方行：不需要报名列表/签到记录/详情
        if (!context.manual && cachedSign.fresh) {
          // 缓存有效：直接复用，本轮不联网（最近活动也用缓存里的官方列表）
          signDetail.statusFromCache = true;
          renderAppliedRows(rows, localSignMap);
          renderRecentFromCache(cachedSign.recent);
          refreshAppliedNoteSuffix();
          return;
        }
        // ── 数据源 1：官方报名列表 GetStuAllActApplyList（官网同源主数据源，SignD/SignT） ──
        signDetail.applyListLoading = true;
        refreshAppliedNoteSuffix();
        fetchOfficialApplyList(member)
          .then(function (applyResult) {
            if (!appliedViewStillCurrent(context.member)) return null;
            signDetail.applyListLoading = false;
            if (!applyResult.ok) {
              if (isEkAuthFailure(applyResult.reason) && !context.retried) {
                attemptEkRepairAndRetry(context, localEvents, localSignMap);
                return { retried: true };
              }
              // 报名列表失败不阻塞：回退签到记录/详情链路，最近活动回退本机记录
              signDetail.applyListFailed = true;
              renderAppliedRows(rows, localSignMap);
              renderRecentLocalFallback();
              refreshAppliedNoteSuffix();
              return applyResult;
            }
            signDetail.applyListFetched = num(applyResult.count, 0) || 0;
            signDetail.applyListPages = num(applyResult.pages, 0) || 0;
            signDetail.applyListTruncated = applyResult.truncated === true;
            // 记录 applyList 覆盖范围：已覆盖的行（哪怕 SignD/SignT 为空）不再为「状态」拉签到记录/详情
            signDetail.applyListCoveredIds = Object.create(null);
            signDetail.applyListCoveredNames = Object.create(null);
            Object.keys(applyResult.map || {}).forEach(function (id) {
              signDetail.applyListCoveredIds[id] = true;
            });
            Object.keys(applyResult.byName || {}).forEach(function (name) {
              signDetail.applyListCoveredNames[name] = true;
            });
            mergeApplyListStatuses(applyResult);
            // 「最近活动」改为官网报名列表里最近签到/签退成功的 6 个活动
            var recent = buildOfficialRecentActivities(applyResult, rows);
            renderOfficialRecentActivities(recent);
            persistSignStatusCache(memberId, cachedSign.rawItems, recent);
            renderAppliedRows(rows, localSignMap);
            refreshAppliedNoteSuffix();
            return applyResult;
          })
          .then(function (applyResult) {
            if (applyResult && applyResult.retried) return null; // 已转入自动重登重试
            if (applyResult === null) return null; // 已切走
            if (!appliedViewStillCurrent(context.member)) return null;
            // ── 数据源 2/3：报名列表未覆盖的行 → 签到记录 → 详情兜底 ──
            return runStatusFallbackPhase(context, rows, localSignMap, officialById, cachedSign);
          })
          .then(function (statusDetailInfo) {
            if (!appliedViewStillCurrent(context.member)) return;
            // ── 补充：官方签到/签退时段（详情接口，仅官方已报名行） ──
            runSignWindowsPhase(context, rows, officialById, localSignMap, cachedSign, statusDetailInfo);
          });
      });
    }

    /** 报名列表未覆盖的行 → 官方签到记录 → 官方详情兜底；返回详情阶段汇总（供时段阶段去重） */
    function runStatusFallbackPhase(context, rows, localSignMap, officialById, cachedSign) {
      if (!rowsNeedMoreStatus(rows, localSignMap)) return Promise.resolve(null);
      var member = context.member;
      var memberId = member.id;
      signDetail.signListLoading = true;
      refreshAppliedNoteSuffix();
      return fetchOfficialSignList(member)
        .then(function (listResult) {
          if (!appliedViewStillCurrent(context.member)) return null;
          signDetail.signListLoading = false;
          if (listResult.ok) {
            signDetail.signListFetched = num(listResult.count, 0) || 0;
            signDetail.signListPages = num(listResult.pages, 0) || 0;
            // 记录 signList 覆盖范围：已覆盖的行不再拉详情
            signDetail.signListCoveredIds = Object.create(null);
            signDetail.signListCoveredNames = Object.create(null);
            Object.keys(listResult.map || {}).forEach(function (id) {
              signDetail.signListCoveredIds[id] = true;
            });
            Object.keys(listResult.byName || {}).forEach(function (name) {
              signDetail.signListCoveredNames[name] = true;
            });
            mergeSignListStatuses(listResult);
            persistSignStatusCache(memberId, cachedSign.rawItems);
          } else {
            signDetail.signListFailed = true;
          }
          renderAppliedRows(rows, localSignMap);
          refreshAppliedNoteSuffix();
          // 签到记录失败也继续详情兜底（结构不符/无记录时详情仍可能给出状态/时段）
          var detailIds = collectDetailIds(rows, localSignMap, officialById);
          if (!detailIds.length) return null;
          signDetail.loading = true;
          refreshAppliedNoteSuffix();
          return fetchOfficialSignStatuses(member, detailIds, { force: true, bypassCache: true }).then(function (detailResult) {
            if (!appliedViewStillCurrent(context.member)) return null;
            signDetail.loading = false;
            signDetail.fetched = num(detailResult.fetched, 0) || 0;
            signDetail.failed = num(detailResult.failed, 0) || 0;
            mergeDetailStatuses(detailResult.items);
            // 同一次详情响应里的签到/签退时段直接复用（避免重复请求）
            mergeSignWindowStatuses(detailResult.windows);
            signDetail.winFetched = Object.keys(detailResult.windows || {}).length;
            signDetail.winFailed = num(detailResult.windowFailed, 0) || 0;
            persistSignStatusCache(memberId, cachedSign.rawItems);
            renderAppliedRows(rows, localSignMap);
            refreshAppliedNoteSuffix();
            return {
              doneIds: detailResult.doneIds || Object.create(null),
              windowFetched: signDetail.winFetched,
              windowFailed: signDetail.winFailed,
            };
          });
        })
        .catch(function () {
          return null;
        });
    }

    /** 官方签到/签退时段：只对官方已报名行（有 Id）请求详情，失败隔离并中性提示 */
    function runSignWindowsPhase(context, rows, officialById, localSignMap, cachedSign, statusDetailInfo) {
      var done = (statusDetailInfo && statusDetailInfo.doneIds) || Object.create(null);
      var windowIds = [];
      rows.forEach(function (row) {
        var id = text(row.activityId);
        if (!id || !officialById[id]) return;
        if (!(row.source === 'official' || row.inOfficial === true)) return;
        if (done[id]) return; // 本轮状态详情已顺带取过时段
        var entry = lookupSignStatus(row);
        // 手动刷新（force）强制重拉时段；自动加载命中缓存时跳过
        if (!context.manual && entry && (entry.qd || entry.qt || entry.needIn || entry.needOut)) return;
        windowIds.push(id);
      });
      if (!windowIds.length) return;
      signDetail.winLoading = true;
      refreshAppliedNoteSuffix();
      fetchOfficialSignWindows(context.member, windowIds).then(function (result) {
        if (!appliedViewStillCurrent(context.member)) return;
        signDetail.winLoading = false;
        signDetail.winFetched = (num(statusDetailInfo && statusDetailInfo.windowFetched, 0) || 0) + (num(result.fetched, 0) || 0);
        signDetail.winFailed = (num(statusDetailInfo && statusDetailInfo.windowFailed, 0) || 0) + (num(result.failed, 0) || 0);
        mergeSignWindowStatuses(result.items);
        persistSignStatusCache(context.member.id, cachedSign.rawItems);
        renderAppliedRows(rows, localSignMap);
        refreshAppliedNoteSuffix();
      });
    }

    /* 官方报名列表 → 「最近签到/签退成功的 6 个活动」。 */
    function buildOfficialRecentActivities(applyResult, rows) {
      var list = (applyResult && applyResult.rows) || [];
      var records = Object.create(null);
      var order = [];
      list.forEach(function (item) {
        if (!isObject(item)) return;
        var status = applyListStatusOf(item);
        if (!status) return;
        var inOk = status.signIn === true;
        var outOk = status.signOut === true;
        if (!inOk && !outOk) return;
        var lastAt = Math.max(parseDateish(item.Inputdate) || 0, parseDateish(item.SignOutdate) || 0);
        if (!lastAt) return;
        var activityId = trim(item.ActivityId || item.activityId);
        var name = trim(item.ActivityName || item.activityName);
        var key = activityId || name;
        if (!key) return;
        var record = records[key];
        if (!record) {
          record = records[key] = {
            activityId: activityId,
            name: name || activityId,
            category: trim(item.ModuleCodeText || item.ModuleCode || item.ActivityType || ''),
            signInStatus: '',
            signOutStatus: '',
            lastAt: 0,
            signInReason: '',
            signOutReason: '',
          };
          order.push(key);
        }
        if (inOk) record.signInStatus = 'success';
        if (outOk) record.signOutStatus = 'success';
        if (lastAt > record.lastAt) record.lastAt = lastAt;
        if (!record.category) {
          record.category = trim(item.ModuleCodeText || item.ModuleCode || item.ActivityType || '');
        }
      });
      // 类别优先用已报名行（applied rows）的 category
      var catById = Object.create(null);
      var catByName = Object.create(null);
      (rows || []).forEach(function (row) {
        if (!isObject(row)) return;
        if (row.activityId && row.category) catById[row.activityId] = row.category;
        if (row.name && row.category) catByName[row.name] = row.category;
      });
      var recent = order.map(function (key) {
        return records[key];
      });
      recent.forEach(function (item) {
        item.category = catById[item.activityId] || catByName[item.name] || item.category || '';
      });
      recent.sort(function (a, b) {
        return (b.lastAt || 0) - (a.lastAt || 0);
      });
      return recent.slice(0, 6);
    }

    /** 用官网报名列表的最近活动替换 stat.activities 并重渲染统计卡 */
    function renderOfficialRecentActivities(recent) {
      if (!stat) return;
      stat.activities = Array.isArray(recent) ? recent.slice() : [];
      renderStatInto(host, stat, selected);
      statsSourceHint.textContent = '最近活动：官网报名列表（最多 6 个）';
    }

    /** 缓存命中的自动加载：用缓存里的官方最近活动，没有则回退本机记录 */
    function renderRecentFromCache(recent) {
      if (!stat) return;
      if (Array.isArray(recent) && recent.length) {
        stat.activities = recent.slice();
        renderStatInto(host, stat, selected);
        statsSourceHint.textContent = '最近活动：官网报名列表（最多 6 个）';
        return;
      }
      renderRecentLocalFallback();
    }

    /** 官网报名列表不可用时：最近活动回退本机执行记录并提示来源 */
    function renderRecentLocalFallback() {
      if (!stat) return;
      stat.activities = localStatActivities.slice();
      renderStatInto(host, stat, selected);
      statsSourceHint.textContent = '最近活动：本机执行记录（官网不可用）';
    }

    /** 该行是否已被官方报名列表覆盖（有记录即覆盖；状态为空也算覆盖，不再兜底） */
    function isApplyListCovered(row) {
      if (!row) return false;
      var id = text(row.activityId);
      if (id && signDetail.applyListCoveredIds[id]) return true;
      var name = text(row.name);
      return Boolean(name && signDetail.applyListCoveredNames[name]);
    }

    /** 该行是否已被官方签到记录覆盖（有记录即覆盖，状态为空也不再拉详情） */
    function isSignListCovered(row) {
      if (!row) return false;
      var id = text(row.activityId);
      if (id && signDetail.signListCoveredIds[id]) return true;
      var name = text(row.name);
      return Boolean(name && signDetail.signListCoveredNames[name]);
    }

    /* 是否还有「需要兜底」的行（决定是否拉签到记录）。 */
    function rowsNeedMoreStatus(rows, localSignMap) {
      for (var i = 0; i < rows.length; i += 1) {
        var row = rows[i];
        if (!(row.source === 'official' || row.inOfficial === true)) continue;
        if (isApplyListCovered(row)) continue;
        var sign = localSignMap[row.activityId] || {};
        if (sign.signIn === true && sign.signOut === true) continue;
        var entry = lookupSignStatus(row);
        var inKnown = sign.signIn === true || Boolean(entry && (entry.signIn === true || entry.signIn === false));
        var outKnown = sign.signOut === true || Boolean(entry && (entry.signOut === true || entry.signOut === false));
        if (!inKnown || !outKnown) return true;
      }
      return false;
    }

    /**
     * 仍未知道状态、且有官方 Id 的已报名行 → 详情兜底 id 列表。
     * 只对 applyList、signList 都未覆盖的行请求详情（已覆盖但状态为空的行显示「—」）。
     */
    function collectDetailIds(rows, localSignMap, officialById) {
      var ids = [];
      rows.forEach(function (row) {
        var id = text(row.activityId);
        if (!id || !officialById[id]) return;
        if (!(row.source === 'official' || row.inOfficial === true)) return;
        if (isApplyListCovered(row) || isSignListCovered(row)) return;
        var sign = localSignMap[id] || {};
        if (sign.signIn === true && sign.signOut === true) return;
        var entry = lookupSignStatus(row);
        var inKnown = sign.signIn === true || Boolean(entry && (entry.signIn === true || entry.signIn === false));
        var outKnown = sign.signOut === true || Boolean(entry && (entry.signOut === true || entry.signOut === false));
        if (!inKnown || !outKnown) ids.push(id);
      });
      return ids;
    }

    /** 会话鉴权失败：自动 refreshEk → loginEk（有凭证时），成功则用新会话重试一次 */
    function attemptEkRepairAndRetry(context, localEvents, localSignMap) {
      if (context.repairing) return;
      context.repairing = true;
      appliedBaseText = '二课会话已失效，正在尝试自动重新登录…';
      refreshAppliedNoteSuffix();
      repairEkSession(context.member.id).then(function (repair) {
        if (!appliedViewStillCurrent(context.member)) return;
        if (!repair.ok) {
          renderAppliedRows(mergeAppliedRows(localEvents, []), localSignMap);
          showSessionExpired('');
          pushLog('warn', '二课会话失效，自动重新登录未成功，请到成员页重新登录');
          return;
        }
        reloadMembers();
        var freshMember = hasFn(M, 'getMember') ? M.getMember(context.member.id) : null;
        if (!freshMember) {
          showSessionExpired('');
          return;
        }
        pushLog('info', '二课会话已自动恢复（' + (repair.via === 'login' ? '重新登录' : '续期') + '），已重试读取官方数据');
        // 用续期/重登后的成员快照重试（时段详情也必须使用新会话）
        loadApplied(context.manual, { retried: true, repaired: true, member: freshMember });
      });
    }

    /** 会话失效且无法自动恢复时的明确提示（不谎报签到状态） */
    function showSessionExpired(reason) {
      signDetail.sessionExpired = true;
      signDetail.applyListLoading = false;
      signDetail.signListLoading = false;
      signDetail.loading = false;
      appliedBaseText =
        '二课会话失效，请到成员页重新登录' + (reason ? '（' + syncReasonCn(reason) + '）' : '');
      refreshAppliedNoteSuffix();
    }

    var appliedCard = h('section', { class: 'one-ct-card', 'data-testid': 'one-ct-ek-applied' }, [
      h('div', { class: 'one-ct-card-head' }, [
        h('div', { class: 'one-ct-card-head-main' }, [
          h('div', { class: 'one-ct-card-title', text: '已报名的二课' }),
          h('div', {
            class: 'one-ct-card-sub',
            text:
              '本机报名记录和官网已报名列表合在一起看；' +
              '签到、签退状态以官网数据为准，读不到时会显示「—」',
          }),
        ]),
        h('div', { class: 'one-ct-card-head-actions' }, [appliedNote, appliedRefreshBtn]),
      ]),
      h('div', { class: 'one-ct-card-body is-flush' }, [appliedHost]),
    ]);

    var view = h('div', { class: 'one-ct-view', 'data-testid': 'one-ct-ek-view' }, [
      h('section', { class: 'one-ct-card' }, [
        h('div', { class: 'one-ct-card-head' }, [
          h('div', { class: 'one-ct-card-head-main' }, [
            h('div', { class: 'one-ct-card-title', text: '二课统计' }),
            h('div', { class: 'one-ct-card-sub', text: '签到 / 签退成功数与八模块进度；八模块分数来自二课官网' }),
          ]),
          h('div', { class: 'one-ct-card-head-actions' }, [syncAllBtn, select, exportBtn]),
        ]),
        h('div', { class: 'one-ct-card-body' }, [
          metaRow,
          h('div', { class: 'one-ct-row one-ct-row--between one-ct-sync-all-row' }, [
            syncAllStatus,
          ]),
          host,
          statsSourceHint,
        ]),
      ]),
      appliedCard,
    ]);

    els.main.appendChild(view);
    refreshSyncAllStatus();
    // 已报名区块：先本地记录，再异步补官方并集
    loadApplied(false);
  }

  // ───────────────────── 旧版本设置迁移（只做一次） ─────────────────────

  var MIGRATION_UNIRUN_AUTO = 'migrations.unirunAutoV2';
  var MIGRATION_UNIRUN_RUNAT = 'migrations.unirunRunAtV1';

  var MIGRATION_PREVIEW_OFF = 'migrations.previewOffV1';

  /* 预览模式已下线：只把还留在「预览」的旧设置改成真实执行，跑过一次就记标记。 */
  function migratePreviewOff() {
    if (cfgGet(MIGRATION_PREVIEW_OFF) === true) return false;
    var stored = {};
    try {
      if (hasFn(M, 'loadGlobalConfig')) stored = M.loadGlobalConfig() || {};
    } catch (e) {
      stored = {};
    }
    var hadPreview = isObject(stored) && stored.dryRun === true;
    var patch = { migrations: { previewOffV1: true } };
    if (hadPreview) patch.dryRun = false;
    var saved = saveGlobalConfig(patch);
    if (saved && hadPreview) pushLog('info', '预览模式已下线，自动运行将真实执行');
    return saved && hadPreview;
  }

  /* 旧版「有效窗口 / 里程 / 时长」是手填项，现在改由程序每天随机：只清掉恰好等于旧默认值的项。 */
  function migrateLegacyUnirunConfig() {
    if (cfgGet(MIGRATION_UNIRUN_AUTO) === true) return false;
    var u = cfgGet('unirun') || {};
    var clear = {};
    if (Number(u.windowMinutes) === 30) clear.windowMinutes = null;
    if (Number(u.runDistance) === 3000) clear.runDistance = null;
    if (Number(u.runTime) === 30) clear.runTime = null;
    var patch = { migrations: { unirunAutoV2: true } };
    var keys = Object.keys(clear);
    if (keys.length) patch.unirun = clear;
    var saved = saveGlobalConfig(patch);
    if (saved && keys.length) {
      pushLog('info', '旧版的校园跑参数已改为每天自动随机');
    }
    return saved && keys.length > 0;
  }

  /* 每日执行时刻默认值从 06:30 改为 19:00：只改「还是旧默认值」的那部分，用户自己改过的值一律不动。 */
  function migrateUnirunRunAt() {
    if (cfgGet(MIGRATION_UNIRUN_RUNAT) === true) return false;
    var patch = { migrations: { unirunRunAtV1: true } };
    var changed = cfgText('unirun.runAt') === '06:30';
    if (changed) patch.unirun = { runAt: '19:00' };
    var saved = saveGlobalConfig(patch);
    if (saved && changed) {
      pushLog('info', '校园跑每日执行时刻已改为 19:00，可在「运行」页调整');
    }
    return saved && changed;
  }
  // ───────────────────────── 兜底照片（内置图片 → data URL） ─────────────────────────
  //
  // 冷门二课活动图库常常没人上传图片；用户要求用一张内置图兜底（照片无人复核）。
  // 图片以 data URL 内联在 dist/renderer/1ct/fallback-photo.js（window.ONE_CT_FALLBACK_PHOTO）；
  // 不 fetch 文件：打包后渲染层是 file:// 源，fetch 本地文件会被 CORS 拦。
  // 取到后存进全局配置 ek.fallbackPhoto，引擎在「图库无图」时用它走官方上传接口。
  var fallbackPhotoCache = '';

  function ensureFallbackPhoto() {
    var existing = cfgText('ek.fallbackPhoto');
    if (existing) {
      fallbackPhotoCache = existing;
      return Promise.resolve(existing);
    }
    if (fallbackPhotoCache) return Promise.resolve(fallbackPhotoCache);
    // 打包后渲染层是 file:// 源，fetch 本地文件会被 CORS 拦；所以优先用 index.html 内联的常量。
    if (typeof window !== 'undefined' && typeof window.ONE_CT_FALLBACK_PHOTO === 'string' && window.ONE_CT_FALLBACK_PHOTO) {
      fallbackPhotoCache = window.ONE_CT_FALLBACK_PHOTO;
      saveGlobalConfig({ ek: { fallbackPhoto: fallbackPhotoCache } });
      pushLog('info', '已加载内置兜底照片（图库无图时自动使用）');
      return Promise.resolve(fallbackPhotoCache);
    }
    // 没有内联常量（例如极老的构建）→ 明确返回空串，引擎退回「空照片提交」，不报错。
    return Promise.resolve('');
  }
  // ───────────────────────────── 记录页（俱乐部 / 校园跑） ─────────────────────────────
  //
  // 用户需求：「除了二课，把俱乐部报名情况和成功情况、校园跑成功的日志也都加一个页面」
  // 数据统一来自 result-store 的历史事件（OneCTMembers.loadResults()），
  // 与二课统计同源，不额外记录、不重复上报。

  function renderRecordsView() {
    reloadMembers();
    var members = M && hasFn(M, 'load') ? ((M.load() || {}).items || []) : [];
    var filter = { memberId: '' };

    var select = h('select', { class: 'one-ct-select', 'data-testid': 'one-ct-records-member' }, [
      h('option', { value: '', text: '全部成员' }),
    ].concat(members.map(function (m) {
      return h('option', { value: String(m.id), text: text(m.name) || '未命名' });
    })));
    select.addEventListener('change', function () {
      filter.memberId = text(select.value);
      renderBody();
    });

    var host = h('div', { 'data-testid': 'one-ct-records-host' });

    var view = h('div', { class: 'one-ct-view', 'data-testid': 'one-ct-records-view' }, [
      h('section', { class: 'one-ct-card' }, [
        h('div', { class: 'one-ct-card-head' }, [
          h('div', { class: 'one-ct-card-head-main' }, [
            h('div', { class: 'one-ct-card-title', text: '执行记录' }),
            h('div', { class: 'one-ct-card-sub', text: '俱乐部报名 / 签到 / 签退，校园跑成功记录（最近 90 天，与本机历史同源）' }),
          ]),
          h('div', { class: 'one-ct-card-head-actions' }, [select]),
        ]),
        h('div', { class: 'one-ct-card-body is-flush' }, [host]),
      ]),
    ]);

    function eventsOf(module) {
      var all = loadResultEvents();
      if (!Array.isArray(all)) return [];
      return all.filter(function (ev) {
        if (!isObject(ev) || String(ev.module || '') !== module) return false;
        if (filter.memberId && String(ev.memberId || '') !== filter.memberId) return false;
        return true;
      });
    }

    function actionsOf(list, names) {
      return list.filter(function (ev) {
        var a = text(ev.action).toLowerCase().replace(/[_-]/g, '');
        return names.indexOf(a) >= 0 && ev.status === 'success';
      });
    }

    function statCard(label, value, testid) {
      return h('div', { class: 'one-ct-stat', 'data-testid': testid }, [
        h('div', { class: 'one-ct-stat-label', text: label }),
        h('div', { class: 'one-ct-stat-value', text: String(value) }),
      ]);
    }

    function rowsTable(rows, headers) {
      var headTexts = headers || ['时间', '成员', '动作', '活动 / 说明'];
      return h('div', { class: 'one-ct-table-wrap' }, [
        h('table', { class: 'one-ct-table' }, [
          h('thead', null, [h('tr', null, headTexts.map(function (t) { return h('th', { text: t }); }))]),
          h('tbody', null, rows),
        ]),
      ]);
    }

    function renderBody() {
      clear(host);
      var clubEvents = eventsOf('club');
      var runEvents = eventsOf('unirun');
      var clubJoin = actionsOf(clubEvents, ['join', 'apply', 'joinactivity']);
      var clubIn = actionsOf(clubEvents, ['signin', 'in', 'checkin']);
      var clubOut = actionsOf(clubEvents, ['signout', 'out', 'checkout']);
      var runOk = runEvents.filter(function (ev) {
        var a = text(ev.action).toLowerCase().replace(/[_-]/g, '');
        return (a === 'autorun' || a === 'run') && ev.status === 'success';
      });
      var runFail = runEvents.filter(function (ev) {
        var a = text(ev.action).toLowerCase().replace(/[_-]/g, '');
        return (a === 'autorun' || a === 'run') && ev.status === 'failed';
      });

      var clubRows = clubJoin.concat(clubIn, clubOut)
        .sort(function (a, b) { return num(b.at, 0) - num(a.at, 0); })
        .slice(0, 50)
        .map(function (ev) {
          return h('tr', { 'data-testid': 'one-ct-records-club-row' }, [
            h('td', { class: 'one-ct-muted' }, [h('span', { class: 'one-ct-num', text: formatDateTime(ev.at) })]),
            h('td', null, [h('span', { text: text(ev.memberName) || text(ev.accountId) || '—' })]),
            h('td', null, [h('span', { text: ACTION_CN[ev.action] || text(ev.action) || '—' })]),
            h('td', null, [h('span', { text: text(ev.activityName) || '—' })]),
          ]);
        });

      var runRows = runOk
        .sort(function (a, b) { return num(b.at, 0) - num(a.at, 0); })
        .slice(0, 50)
        .map(function (ev) {
          var extra = [];
          if (num(ev.distanceMeters, 0)) extra.push(num(ev.distanceMeters, 0) + ' 米');
          if (num(ev.runTime, 0)) extra.push(num(ev.runTime, 0) + ' 分钟');
          return h('tr', { 'data-testid': 'one-ct-records-unirun-row' }, [
            h('td', { class: 'one-ct-muted' }, [h('span', { class: 'one-ct-num', text: formatDateTime(ev.at) })]),
            h('td', null, [h('span', { text: text(ev.memberName) || text(ev.accountId) || '—' })]),
            h('td', null, [h('span', { class: 'one-ct-num', text: extra.join(' · ') || '—' })]),
            h('td', null, [h('span', { class: 'one-ct-badge one-ct-badge--ok', text: '成功' })]),
          ]);
        });

      if (!clubRows.length && !runRows.length) {
        host.appendChild(h('div', { class: 'one-ct-empty', 'data-testid': 'one-ct-records-empty' }, [
          h('div', { class: 'one-ct-empty-title', text: '还没有执行记录' }),
          h('div', { text: '到「运行」页启动一次，跑成功的报名和跑步都会出现在这里。' }),
          h('div', { class: 'one-ct-empty-actions' }, [
            h('button', {
              class: 'one-ct-btn one-ct-btn--primary',
              type: 'button',
              text: '去运行页',
              'data-testid': 'one-ct-records-empty-goto-run',
              onclick: function () {
                switchTab('run');
              },
            }),
          ]),
        ]));
        return;
      }

      host.appendChild(h('div', { class: 'one-ct-record-block', 'data-testid': 'one-ct-records-club' }, [
        h('div', { class: 'one-ct-record-head' }, [
          h('div', { class: 'one-ct-card-title', text: '俱乐部' }),
          h('div', { class: 'one-ct-hint', text: '报名成功 ' + clubJoin.length + ' · 签到成功 ' + clubIn.length + ' · 签退成功 ' + clubOut.length }),
        ]),
        h('div', { class: 'one-ct-stat-row' }, [
          statCard('报名成功', clubJoin.length, 'one-ct-records-club-stat'),
          statCard('签到成功', clubIn.length, 'one-ct-records-club-stat'),
          statCard('签退成功', clubOut.length, 'one-ct-records-club-stat'),
        ]),
        clubRows.length ? rowsTable(clubRows) : h('div', { class: 'one-ct-empty', text: '俱乐部还没有成功记录' }),
      ]));

      host.appendChild(h('div', { class: 'one-ct-record-block', 'data-testid': 'one-ct-records-unirun' }, [
        h('div', { class: 'one-ct-record-head' }, [
          h('div', { class: 'one-ct-card-title', text: '校园跑' }),
          h('div', { class: 'one-ct-hint', text: '成功 ' + runOk.length + ' · 失败 ' + runFail.length }),
        ]),
        runRows.length
          ? rowsTable(runRows, ['时间', '成员', '里程 / 时长', '状态'])
          : h('div', { class: 'one-ct-empty', text: '校园跑还没有成功记录' }),
      ]));
    }

    els.main.appendChild(view);
    renderBody();
  }
  // ───────────────────────────── 日志页 ─────────────────────────────

  function renderLogsView() {
    reloadMembers();
    els.logsHost = h('div', { 'data-testid': 'one-ct-logs-list' });
    var view = h('div', { class: 'one-ct-view', 'data-testid': 'one-ct-logs-view' }, [
      h('section', { class: 'one-ct-card' }, [
        h('div', { class: 'one-ct-card-head' }, [
          h('div', { class: 'one-ct-card-head-main' }, [
            h('div', { class: 'one-ct-card-title', text: '运行日志' }),
            h('div', { class: 'one-ct-card-sub', text: '最近 ' + MAX_LOG + ' 条，按成员分组；不含登录凭据、密码和完整手机号' }),
          ]),
          h('div', { class: 'one-ct-card-head-actions' }, [
            h('button', {
              class: 'one-ct-btn one-ct-btn--sm',
              type: 'button',
              text: '刷新历史',
              'data-testid': 'one-ct-logs-refresh',
              onclick: function () {
                var added = hydrateLogsFromHistory();
                pushLog('info', '已从本机执行历史载入 ' + added + ' 条新记录');
                renderView();
              },
            }),
            h('button', {
              class: 'one-ct-btn one-ct-btn--sm',
              type: 'button',
              text: '导出（脱敏）',
              'data-testid': 'one-ct-logs-export',
              onclick: function () {
                var out = logs
                  .slice()
                  .sort(function (a, b) {
                    return a.at - b.at;
                  })
                  .map(function (entry) {
                    return (
                      formatDateTime(entry.at) + ' [' + entry.kind + '] ' +
                      (entry.memberName ? '[' + entry.memberName + '] ' : '') + entry.text
                    );
                  })
                  .join('\n');
                if (downloadText('1ct-日志-' + todayStamp() + '.txt', out, 'text/plain;charset=utf-8')) {
                  pushLog('info', '已导出脱敏日志');
                }
              },
            }),
            h('button', {
              class: 'one-ct-btn one-ct-btn--sm',
              type: 'button',
              text: '清空',
              'data-testid': 'one-ct-logs-clear',
              onclick: function () {
                logs = [];
                renderView();
                pushLog('info', '界面日志已清空（不影响本机执行历史）');
              },
            }),
          ]),
        ]),
        h('div', { class: 'one-ct-card-body is-flush' }, [els.logsHost]),
      ]),
    ]);
    els.main.appendChild(view);
    renderLogsIntoCurrentView();
  }

  function renderLogsIntoCurrentView() {
    if (ui.tab !== 'logs' || !els.logsHost) return;
    var host = els.logsHost;
    clear(host);
    var groups = groupedLogs();
    if (!groups.length) {
      host.appendChild(
        h('div', { class: 'one-ct-empty', 'data-testid': 'one-ct-logs-empty' }, [
          h('div', { class: 'one-ct-empty-title', text: '还没有日志' }),
          h('div', { text: '启动一次自动运行，或者点右上角「刷新历史」把本机记录读进来。' }),
          h('div', { class: 'one-ct-empty-actions' }, [
            h('button', {
              class: 'one-ct-btn one-ct-btn--primary',
              type: 'button',
              text: '去运行页',
              'data-testid': 'one-ct-logs-empty-goto-run',
              onclick: function () {
                switchTab('run');
              },
            }),
          ]),
        ]),
      );
      return;
    }
    var LOG_KIND_CN = { info: '提示', success: '成功', warn: '提醒', error: '出错', engine: '运行' };
    groups.forEach(function (group) {
      var dot = h('span', { class: 'one-ct-member-dot' });
      dot.style.background = memberColor(group.memberId);
      var rows = group.entries.map(function (entry) {
        var kindCn = LOG_KIND_CN[entry.kind] || '记录';
        return h('div', {
          class: 'one-ct-log-row one-ct-log--' + entry.kind,
          'data-testid': 'one-ct-log-row',
          'data-member-id': entry.memberId || '',
        }, [
          h('span', { class: 'one-ct-log-time', text: formatTime(entry.at) }),
          h('span', {
            class: 'one-ct-log-level one-ct-log-level--' + entry.kind,
            title: kindCn + (entry.kind ? '（' + entry.kind + '）' : ''),
            'aria-label': kindCn,
          }),
          h('span', { class: 'one-ct-log-text', text: entry.text }),
        ]);
      });
      host.appendChild(
        h('div', {
          class: 'one-ct-log-group',
          'data-testid': 'one-ct-log-group',
          'data-member-id': group.memberId || '',
        }, [
          h('div', { class: 'one-ct-log-group-head' }, [
            dot,
            h('span', { text: group.memberName || '未知成员' }),
            h('span', { class: 'one-ct-log-group-count', text: group.entries.length + ' 条' }),
          ]),
          h('div', { class: 'one-ct-log-rows' }, rows),
        ]),
      );
    });
  }

  // ───────────────────── 首次使用说明 / 本版更新 ─────────────────────

  function readLocalFlag(key) {
    try {
      return window.localStorage.getItem(key) || '';
    } catch (e) {
      return '';
    }
  }

  function writeLocalFlag(key) {
    try {
      window.localStorage.setItem(key, String(Date.now()));
    } catch (e) {
      /* 存不下不影响使用，只是下次还会再提示一次 */
    }
  }

  function openNoticeModal(opts) {
    closeModal();
    var closed = false;
    function finish() {
      if (closed) return;
      closed = true;
      closeModal();
      if (opts.onDone) opts.onDone();
    }
    var modalNode = h('div', {
      class: 'one-ct-modal one-ct-modal--notice',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': opts.title,
      'data-testid': opts.testid,
    }, [
      h('div', { class: 'one-ct-modal-head' }, [
        h('div', { class: 'one-ct-card-head-main' }, [
          h('div', { class: 'one-ct-modal-title', text: opts.title }),
          opts.sub ? h('div', { class: 'one-ct-modal-sub', text: opts.sub }) : null,
        ]),
        h('button', {
          class: 'one-ct-btn one-ct-btn--icon',
          type: 'button',
          text: '✕',
          'aria-label': '关闭',
          style: 'margin-left:auto',
          'data-testid': opts.closeTestid,
          onclick: finish,
        }),
      ]),
      h('div', { class: 'one-ct-modal-body' }, opts.body),
      h('div', { class: 'one-ct-modal-foot' }, [
        h('span', { class: 'one-ct-spacer' }),
        h('button', {
          class: 'one-ct-btn one-ct-btn--primary',
          type: 'button',
          text: opts.actionText,
          'data-testid': opts.actionTestid,
          onclick: finish,
        }),
      ]),
    ]);
    var backdrop = h('div', {
      class: 'one-ct-modal-backdrop',
      'data-testid': opts.testid + '-backdrop',
      onclick: function (event) {
        if (event.target === backdrop) finish();
      },
    }, [modalNode]);
    var onKeydown = function (event) {
      if (event.key === 'Escape') finish();
    };
    document.addEventListener('keydown', onKeydown);
    document.body.appendChild(backdrop);
    modal = { backdrop: backdrop, node: modalNode, onKeydown: onKeydown };
    return modalNode;
  }

  var ONBOARD_STEPS = [
    {
      title: '先把成员加进来',
      text: '到「成员」页填姓名和备注，然后登录二课。推荐微信扫码，不在校园网也能登；学号加密码登录只在校内网连得上。校园跑账号也在同一个弹层里填。',
    },
    {
      title: '同步一次官方成绩',
      text: '成员弹层里点「同步官方成绩」，或者到二课页右上角同步。八个模块差多少分会自动算出来，不用手填。',
    },
    {
      title: '勾好项目，点启动就行',
      text: '勾选要跑的项目，点启动后到点自动执行；二课页能看到每个活动的签到、签退时段。',
    },
  ];

  function openOnboarding() {
    openNoticeModal({
      testid: 'one-ct-onboard-modal',
      title: '欢迎使用 1CT',
      sub: '三步就能跑起来，看一遍就够',
      body: [
        h('div', { class: 'one-ct-onboard-steps' }, ONBOARD_STEPS.map(function (step, index) {
          return h('div', { class: 'one-ct-onboard-step', 'data-testid': 'one-ct-onboard-step' }, [
            h('span', { class: 'one-ct-onboard-step-index', text: String(index + 1) }),
            h('div', { class: 'one-ct-onboard-step-main' }, [
              h('div', { class: 'one-ct-onboard-step-title', text: step.title }),
              h('div', { class: 'one-ct-onboard-step-text', text: step.text }),
            ]),
          ]);
        })),
        h('div', { class: 'one-ct-hint', text: '之后在「运行」页随时可以调设置；想再看一遍，可以点右上角「使用说明」。' }),
      ],
      actionText: '开始使用',
      actionTestid: 'one-ct-onboard-start',
      closeTestid: 'one-ct-onboard-close',
      onDone: function () {
        writeLocalFlag(ONBOARD_KEY);
        setTimeout(showWhatsNewIfNeeded, 150);
      },
    });
  }

  function openWhatsNew() {
    openNoticeModal({
      testid: 'one-ct-whatsnew-modal',
      title: '本次更新',
      sub: '这一版的变化（只提示一次）',
      body: [
        h('div', { class: 'one-ct-whatsnew-list' }, CHANGELOG.map(function (line) {
          return h('div', { class: 'one-ct-whatsnew-item', 'data-testid': 'one-ct-whatsnew-item' }, [
            h('span', { class: 'one-ct-whatsnew-dot' }),
            h('span', { text: line }),
          ]);
        })),
      ],
      actionText: '知道了',
      actionTestid: 'one-ct-whatsnew-ok',
      closeTestid: 'one-ct-whatsnew-close',
      onDone: function () {
        writeLocalFlag(WHATSNEW_KEY);
      },
    });
  }

  function showWhatsNewIfNeeded() {
    if (readLocalFlag(WHATSNEW_KEY)) return false;
    openWhatsNew();
    return true;
  }

  /* 新用户先看使用说明；老用户直接看本版更新。两者都只出现一次。 */
  function showIntroIfNeeded() {
    if (!readLocalFlag(ONBOARD_KEY)) {
      openOnboarding();
      return 'onboard';
    }
    return showWhatsNewIfNeeded() ? 'whatsnew' : '';
  }

  // ───────────────────────────── 挂载 ─────────────────────────────

  function mount() {
    // 幂等守卫：优先用 data-testid（buildShell 产出的 app 节点），
    // 不再用 `.one-ct-app` 类名——它可能与 index.html 根节点的 class 撞车导致永不挂载。
    if (document.querySelector('[data-testid="one-ct-app"]')) return;
    reloadMembers();
    reloadConfig();
    // 跨版本升级：旧设置一次性对齐到新口径
    migrateLegacyUnirunConfig();
    migrateUnirunRunAt();
    migratePreviewOff();
    var root = document.getElementById('one-ct-root');
    var app = buildShell();
    if (root) {
      clear(root);
      // 兜底：根节点只做容器，不允许带 .one-ct-app（否则 flex 100vh 会叠两层）
      if (root.classList && root.classList.contains('one-ct-app')) {
        root.classList.remove('one-ct-app');
      }
      root.setAttribute('data-testid', root.getAttribute('data-testid') || 'one-ct-root');
      root.appendChild(app);
    } else {
      document.body.appendChild(app);
    }
    renderView();
    renderStatus();
    hydrateLogsFromHistory();
    // 兜底图：首次启动时把内置图片转成 data URL 存进全局配置
    ensureFallbackPhoto().catch(function () { return ''; });
    pushLog('info', '1CT 已就绪：' + memberList().length + ' 名成员');
    if (ui.tab === 'logs') renderLogsIntoCurrentView();
    // 上次是运行状态：这次接着跑
    if (ui.running) {
      pushLog('info', '上次是运行状态，这里自动接着跑');
      startRun();
    }
    window.__ONE_CT_READY__ = true;
    showIntroIfNeeded();
  }

  window.OneCTShell = {
    mount: mount,
    switchTab: switchTab,
    refresh: function () {
      reloadMembers();
      reloadConfig();
      // 顶栏（窗口按钮可用性）也可能变（例如 ctAPI 被替换），整体重挂一次更稳
      var app = document.querySelector('[data-testid="one-ct-app"]');
      if (app && app.parentNode) {
        var root = document.getElementById('one-ct-root');
        if (root) {
          clear(root);
          root.appendChild(buildShell());
        } else {
          app.parentNode.removeChild(app);
          document.body.appendChild(buildShell());
        }
      }
      renderView();
      renderStatus();
      hydrateLogsFromHistory();
    },
    getState: function () {
      return { ui: clone(ui), runtime: clone(runtime), config: clone(config), members: clone(membersState) };
    },
    getLogs: function () {
      return logs.map(function (entry) {
        return {
          at: entry.at,
          kind: entry.kind,
          text: entry.text,
          memberId: entry.memberId,
          memberName: entry.memberName,
        };
      });
    },
    /** 纯函数导出：供离线测试直接断言（无副作用、不含 PII） */
    _internals: {
      maskPhone: maskPhone,
      rowText: rowText,
      summaryText: summaryText,
      sanitizeError: sanitizeError,
      normalizeEkSession: normalizeEkSession,
      moduleGap: moduleGap,
      memberTotalGap: memberTotalGap,
    },
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();