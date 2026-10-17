/**
 * 3CT AutoPanel —— 渲染层注入式控制面板。
 *
 * 设计：
 *  - 纯 JS + 原生 DOM，零依赖，直接由 index.html 的 <script> 引入；
 *  - 引擎（automation.js）通过 window.Auto3CTAutomation 注入依赖后运行；
 *  - API 走 3CT 既有 window.ctAPI（复用应用内已登录会话）；
 *  - 二维码解码使用 vendor/jsQR.js 提供的 window.jsQR；
 *  - 配置与运行状态走 localStorage（与 3CT 自身偏好同一存储），
 *    **不导出、不打印任何密码/token**；账号只显示 ID 与备注。
 *
 * 可用性/正确性约束（与 Lead 逐条确认）：
 *  1. 三个业务模块各有显式 enabled 开关，首次默认 false（引擎 DEFAULTS 也是 false）；
 *  2. 校园跑账号、校区必须由用户显式选择，不静默使用列表第一项；
 *     未选择时禁止“真实执行”，只允许预览；
 *  3. 二课/俱乐部都有显式 allowAll 开关（关键词为空时才会全部匹配，每日上限仍生效）；
 *  4. 引擎 storage.get 直接调用 localStorage.getItem，读取异常会向上抛出（fail-closed），
 *     不再用吞异常的 safeGet；
 *  5. 二维码图片解码：15 秒超时 + 像素上限/缩放，避免大图卡死渲染进程；
 *  6. 预览/立即运行/启动/停止都可操作；busy 时禁止重复提交；停止会保留已发出请求的真实结果；
 *  7. 字段布局：label 至少 130px、hint 独占一行；面板 480px、窄屏自适应；
 *  8. 关闭“预览”开关时二次确认，明确告知会真实提交；
 *  9. 数字字段做 finite + min/max 校验；
 * 10. 关键控件带 data-testid，供离线 Playwright smoke 使用。
 */
(function () {
  'use strict';

  var A = window.Auto3CTAutomation;
  if (!A) {
    window.addEventListener('DOMContentLoaded', function () {
      console.error('[Auto3CT] automation.js 未加载，面板不可用');
    });
    return;
  }

  var PANEL_KEY = 'auto3ct:panel';
  var UI_KEY = 'auto3ct:ui';
  var MAX_LOG = 300;
  var DECODE_TIMEOUT_MS = 15000;
  var MAX_IMAGE_SIDE = 4096;
  var MAX_IMAGE_PIXELS = 4096 * 4096;

  // ───────────────────────── 本地存储 ─────────────────────────
  //
  // 注意：引擎侧的 storage.get 必须把底层异常暴露出去（fail-closed），
  // 因此这里只允许“非引擎”的 UI 状态读取使用 try/catch。
  // 引擎拿到的 get 是直接 localStorage.getItem。

  function readUiJson(key, fallback) {
    try {
      var raw = window.localStorage.getItem(key);
      if (!raw) return fallback;
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function writeUiJson(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      return false;
    }
  }

  // 引擎最小 storage 接口：get 直接调用且不捕获（写失败/读失败都抛，触发引擎 fail-closed）
  var engineStorage = {
    get: function (k) {
      return window.localStorage.getItem(k);
    },
    set: function (k, v) {
      window.localStorage.setItem(k, v);
    },
    remove: function (k) {
      window.localStorage.removeItem(k);
    },
  };

  // ───────────────────────── 扫码解码（jsQR） ─────────────────────────

  function decodeQrFromUrl(url) {
    return new Promise(function (resolve, reject) {
      if (typeof window.jsQR !== 'function') {
        reject(new Error('jsQR 未加载，无法本地解码二维码（需 vendor/jsQR.js）'));
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
            finish(
              new Error(
                '图片像素过大（' + width + 'x' + height + '），已拒绝解码以避免卡顿',
              ),
            );
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
          var code = window.jsQR(imageData.data, width, height, {
            inversionAttempts: 'attemptBoth',
          });
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

  // ───────────────────────── 引擎实例 ─────────────────────────

  function buildApi() {
    return window.ctAPI || null;
  }

  var engine = null;

  function ensureEngine() {
    if (engine) return engine;
    var api = buildApi();
    if (!api) throw new Error('window.ctAPI 不可用：请确认运行在 3CT 渲染层内');
    engine = A.createEngine({
      api: api,
      storage: engineStorage,
      clock: { now: function () { return Date.now(); } },
      decodeQr: decodeQrFromUrl,
      logger: {
        log: function (message) {
          pushLog('engine', String(message));
        },
      },
    });
    return engine;
  }

  // ───────────────────────── 面板状态 ─────────────────────────

  var logs = [];
  var timer = null;
  var busy = false;
  var busyOwner = null;
  var runSeq = 0;

  var state = {
    enabled: false,
    dryRun: true,
    running: false,
    intervalSec: 60,
    windowIntervalSec: 20,
    lastRunAt: 0,
    lastSummary: null,
  };

  function loadState() {
    var persisted = readUiJson(PANEL_KEY, {});
    state.enabled = Boolean(persisted.enabled);
    state.dryRun = persisted.dryRun === undefined ? true : Boolean(persisted.dryRun);
    state.intervalSec = Number(persisted.intervalSec) >= 15 ? Number(persisted.intervalSec) : 60;
    state.windowIntervalSec =
      Number(persisted.windowIntervalSec) >= 15 ? Number(persisted.windowIntervalSec) : 20;
  }

  function persistState() {
    writeUiJson(PANEL_KEY, {
      enabled: state.enabled,
      dryRun: state.dryRun,
      intervalSec: state.intervalSec,
      windowIntervalSec: state.windowIntervalSec,
    });
  }

  function loadUi() {
    return readUiJson(UI_KEY, { collapsed: false, tab: 'run' });
  }

  function saveUi(patch) {
    writeUiJson(UI_KEY, Object.assign({}, loadUi(), patch));
  }

  function pushLog(kind, text) {
    logs.push({ at: Date.now(), kind: kind, text: String(text).slice(0, 400) });
    if (logs.length > MAX_LOG) logs = logs.slice(-MAX_LOG);
    renderLogs();
  }

  function formatTime(ms) {
    var d = new Date(ms);
    var p = function (n) {
      return String(n).padStart(2, '0');
    };
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  // ───────────────────────── 配置读写 ─────────────────────────

  var KEYWORD_TEXT_PATHS = { 'club.keywordsText': 'club.keywords', 'ek.keywordsText': 'ek.keywords' };
  var INTERVAL_TEXT_PATHS = { tickSec: 'tickMs', windowTickSec: 'windowTickMs' };

  function getCfgValue(path) {
    try {
      var cfg = ensureEngine().getConfig();
      if (path === 'club.keywordsText') return (cfg.club.keywords || []).join(',');
      if (path === 'ek.keywordsText') return (cfg.ek.keywords || []).join(',');
      if (path === 'tickSec') return Math.round((Number(cfg.tickMs) || 60000) / 1000);
      if (path === 'windowTickSec') return Math.round((Number(cfg.windowTickMs) || 20000) / 1000);
      var parts = path.split('.');
      return parts.reduce(function (acc, k) {
        return acc && acc[k] !== undefined ? acc[k] : '';
      }, cfg);
    } catch (e) {
      return '';
    }
  }

  function setCfgValue(path, value) {
    try {
      var inst = ensureEngine();
      if (KEYWORD_TEXT_PATHS[path]) {
        var keywords = String(value || '')
          .split(/[,，;；\s]+/)
          .map(function (s) {
            return s.trim();
          })
          .filter(Boolean);
        return setCfgValue(KEYWORD_TEXT_PATHS[path], keywords);
      }
      if (INTERVAL_TEXT_PATHS[path]) {
        var seconds = Math.max(15, Math.round(Number(value) || 0));
        if (!Number.isFinite(seconds)) return;
        if (path === 'tickSec') state.intervalSec = seconds;
        else state.windowIntervalSec = seconds;
        persistState();
        return setCfgValue(INTERVAL_TEXT_PATHS[path], seconds * 1000);
      }
      var parts = path.split('.');
      var patch = {};
      var cursor = patch;
      parts.forEach(function (k, i) {
        if (i === parts.length - 1) cursor[k] = value;
        else {
          cursor[k] = {};
          cursor = cursor[k];
        }
      });
      inst.setConfig(patch);
      pushLog('info', '配置已保存：' + path + ' = ' + String(value));
    } catch (e) {
      pushLog('error', '配置保存失败：' + (e && e.message ? e.message : String(e)));
    }
  }

  // ───────────────────────── 账号 / 校区下拉 ─────────────────────────

  var accountOptions = [];
  var campusOptions = [];
  var accountError = '';
  var campusError = '';

  function refreshAccountOptions() {
    accountOptions = [];
    accountError = '';
    try {
      var profiles = ensureEngine().getProfiles();
      accountOptions = (profiles.unirunAccounts || []).slice();
      if (!accountOptions.length) accountError = '未找到校园跑账号，请先在「校园跑」页登录/添加账号';
    } catch (e) {
      accountError = '读取账号失败：' + (e && e.message ? e.message : String(e));
    }
    renderAccountSelect();
    refreshPrereqHint();
  }

  function refreshCampusOptions() {
    var api = buildApi();
    campusOptions = [];
    campusError = '';
    if (!api || !api.unirun || typeof api.unirun.campusLocalList !== 'function') {
      campusError = 'window.ctAPI.unirun.campusLocalList 不可用';
      renderCampusSelect();
      refreshPrereqHint();
      return;
    }
    Promise.resolve(api.unirun.campusLocalList())
      .then(function (list) {
        campusOptions = (Array.isArray(list) ? list : []).filter(function (item) {
          return item && item.id;
        });
        if (!campusOptions.length) campusError = '本地没有校区数据，请先在「校园跑」页导入/同步校区';
      })
      .catch(function (e) {
        campusError = '读取校区失败：' + (e && e.message ? e.message : String(e));
      })
      .then(function () {
        renderCampusSelect();
        refreshPrereqHint();
      });
  }

  function buildSelect(testid, onChange) {
    var select = h('select', { class: 'a3-input a3-select', 'data-testid': testid });
    select.addEventListener('change', function () {
      onChange(select.value);
    });
    return select;
  }

  function fillSelect(select, options, currentValue, placeholder, emptyHint) {
    if (!select) return;
    select.innerHTML = '';
    var placeholderOption = document.createElement('option');
    placeholderOption.value = '';
    placeholderOption.textContent = placeholder;
    select.appendChild(placeholderOption);
    var matched = false;
    options.forEach(function (item) {
      var option = document.createElement('option');
      option.value = String(item.id);
      option.textContent = String(item.text || item.id);
      if (option.value === String(currentValue || '')) matched = true;
      select.appendChild(option);
    });
    if (currentValue && !matched) {
      var stale = document.createElement('option');
      stale.value = String(currentValue);
      stale.textContent = '（已失效：' + String(currentValue) + '，请重新选择）';
      select.appendChild(stale);
    }
    select.value = matched ? String(currentValue) : '';
    if (!options.length && emptyHint) select.title = emptyHint;
  }

  function renderAccountSelect() {
    var select = document.querySelector('[data-testid="a3-account"]');
    if (!select) return;
    var options = accountOptions.map(function (item) {
      var label = String(item.id);
      if (item.remark) label += '（' + String(item.remark) + '）';
      return { id: item.id, text: label };
    });
    fillSelect(
      select,
      options,
      getCfgValue('accountId'),
      accountOptions.length ? '请选择校园跑账号' : '（暂无账号）',
      accountError,
    );
  }

  function renderCampusSelect() {
    var select = document.querySelector('[data-testid="a3-campus"]');
    if (!select) return;
    var options = campusOptions.map(function (item) {
      var label = String(item.label || item.mapName || item.id);
      if (item.mapName && item.label && item.mapName !== item.label) label += ' / ' + item.mapName;
      return { id: item.id, text: label };
    });
    fillSelect(
      select,
      options,
      getCfgValue('campusId'),
      campusOptions.length ? '请选择校区' : '（暂无校区）',
      campusError,
    );
  }

  /** 真实执行前的必填校验；返回错误信息或空字符串。 */
  function realRunBlocker() {
    var blockers = [];
    var cfg = null;
    try {
      cfg = ensureEngine().getConfig();
    } catch (e) {
      return '引擎不可用：' + (e && e.message ? e.message : String(e));
    }
    var unirunOn = Boolean(cfg.unirun.enabled);
    var clubOn = Boolean(cfg.club.enabled);
    var ekOn = Boolean(cfg.ek.enabled);
    if (!unirunOn && !clubOn && !ekOn) {
      blockers.push('没有启用任何业务模块');
    }
    // 校园跑/俱乐部共用 tanmasports 账号；二课单独登录，不需要该账号。
    if (unirunOn || clubOn) {
      var accountId = String(cfg.accountId || '');
      if (!accountId) blockers.push('未选择校园跑/俱乐部账号');
      else if (
        accountOptions.length &&
        !accountOptions.some(function (a) {
          return String(a.id) === accountId;
        })
      )
        blockers.push('所选账号已不存在，请重新选择');
    }
    if (unirunOn) {
      var campusId = String(cfg.campusId || '');
      if (!campusId) blockers.push('校园跑已启用但未选择校区');
      else if (
        campusOptions.length &&
        !campusOptions.some(function (c) {
          return String(c.id) === campusId;
        })
      )
        blockers.push('所选校区已不存在，请重新选择');
    }
    return blockers.join('；');
  }

  function refreshPrereqHint() {
    var node = document.getElementById('a3-prereq');
    if (!node) return;
    if (state.dryRun) {
      node.textContent = '预览模式：只读取与比较，不向平台提交（账号/校区可稍后选择）。';
      return;
    }
    var blocker = realRunBlocker();
    node.textContent = blocker ? '真实执行前置条件未满足：' + blocker : '真实执行前置条件已满足（真实提交！）';
  }

  // ───────────────────────── 运行循环 ─────────────────────────

  function nextIntervalMs(result) {
    var hasWindow = false;
    if (result && result.results) {
      result.results.forEach(function (r) {
        if (r.status === 'not-yet' || r.status === 'waiting-material') hasWindow = true;
      });
    }
    var sec = hasWindow ? state.windowIntervalSec : state.intervalSec;
    return Math.max(15, sec) * 1000;
  }

  function scheduleNext(result) {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!state.enabled) return;
    timer = setTimeout(function () {
      tick();
    }, nextIntervalMs(result));
  }

  function applyResultToLogs(result) {
    if (!result || !result.results) {
      pushLog('warn', '本轮无结果');
      return;
    }
    if (result.busy) {
      pushLog('warn', '上一轮仍在执行，本次跳过（防并发）');
      return;
    }
    if (result.stateCorrupt) {
      pushLog('error', '去重状态损坏：已禁止自动写入，请到「状态」页核查后重置');
      return;
    }
    result.results.forEach(function (r) {
      var line =
        '[' + r.module + '] ' + r.action + (r.activityId ? ' ' + r.activityId : '') + ' → ' + r.status;
      if (r.reason) line += '（' + r.reason + '）';
      pushLog(
        r.status === 'success' ? 'success' : r.status === 'failed' || r.status === 'unknown' ? 'error' : 'info',
        line,
      );
    });
    var s = result.summary || {};
    pushLog(
      'info',
      '本轮：成功 ' + (s.success || 0) + ' / 失败 ' + (s.failed || 0) + ' / 未知 ' + (s.unknown || 0) +
        ' / 等待 ' + (s.waiting || 0) + ' / 预览 ' + (s.dryRun || 0) + ' / 跳过 ' + (s.skipped || 0),
    );
  }

  /**
   * 把 UI 的预览/真实模式同步进引擎配置。
   *
   * 关键：engine 的 config.dryRun 默认 true，且 setConfig 会持久化；
   * 如果这里不同步，UI 显示“真实执行”但 runOnce 内部仍按 preview 走（假成功）。
   * preview 按钮走 inst.preview()（内部强制 dryRun=true，不落盘），不调用本函数。
   */
  function syncEngineMode() {
    try {
      ensureEngine().setConfig({ dryRun: Boolean(state.dryRun) });
      return true;
    } catch (e) {
      pushLog('error', '同步预览/真实模式失败：' + (e && e.message ? e.message : String(e)));
      return false;
    }
  }

  /**
   * 执行一轮。manual=true 表示“立即”按钮触发（不进入循环调度）。
   * previewOnly=true 表示“立即预览”按钮：无论 UI 是否真实模式都只做预览。
   * busyOwner 用于区分“本次执行”与“已被停止的旧执行”：停止后旧执行的结果仍会记录，
   * 但不会覆盖新执行的 busy 状态，也不会重新调度。
   */
  function executeRound(manual, previewOnly) {
    if (busy) {
      pushLog('warn', '上一轮仍在执行，已忽略重复操作');
      return;
    }
    var inst;
    try {
      inst = ensureEngine();
    } catch (e) {
      pushLog('error', e.message);
      return;
    }
    var usePreview = Boolean(previewOnly) || Boolean(state.dryRun);
    if (!usePreview) {
      var blocker = realRunBlocker();
      if (blocker) {
        pushLog('error', '真实执行已阻止：' + blocker);
        if (!manual) stop();
        return;
      }
      // 真实执行前必须把 dryRun=false 同步进引擎，否则引擎仍会按预览处理。
      if (!syncEngineMode()) return;
    }
    runSeq += 1;
    var seq = runSeq;
    busyOwner = seq;
    busy = true;
    state.running = true;
    renderStatus();
    var p = usePreview ? inst.preview() : inst.runOnce();
    Promise.resolve(p)
      .then(function (result) {
        state.lastRunAt = Date.now();
        state.lastSummary = result.summary || null;
        applyResultToLogs(result);
        renderSummary();
        return result;
      })
      .catch(function (e) {
        pushLog('error', '运行异常：' + (e && e.message ? e.message : String(e)));
        return null;
      })
      .then(function (result) {
        if (busyOwner !== seq) return; // 已被停止/重启：只保留结果，不碰当前控制状态
        busy = false;
        busyOwner = null;
        state.running = false;
        renderStatus();
        if (!manual) scheduleNext(result);
      });
  }

  function tick() {
    if (!state.enabled) return;
    executeRound(false);
  }

  function start() {
    if (state.enabled) return;
    if (!state.dryRun) {
      var blocker = realRunBlocker();
      if (blocker) {
        pushLog('error', '无法启动真实执行：' + blocker);
        refreshPrereqHint();
        return;
      }
    }
    state.enabled = true;
    persistState();
    pushLog('info', state.dryRun ? '已启动（预览模式，不会真实提交）' : '已启动（真实执行）');
    renderStatus();
    tick();
  }

  function stop() {
    if (!state.enabled) return;
    state.enabled = false;
    persistState();
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (engine) engine.stop();
    // 停止后立即恢复按钮可用；已发出的请求仍会完成并记录真实结果（旧执行 seq 不再生效）
    busy = false;
    busyOwner = null;
    state.running = false;
    pushLog('info', '已停止（已发出的请求仍会完成，并记录真实结果）');
    renderStatus();
  }

  // ───────────────────────── UI 基础 ─────────────────────────

  var el = {};

  function h(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k === 'value') node.value = attrs[k];
        else if (k.indexOf('on') === 0 && typeof attrs[k] === 'function') {
          node.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
        } else if (attrs[k] !== undefined && attrs[k] !== null) node.setAttribute(k, attrs[k]);
      });
    }
    (children || []).forEach(function (c) {
      if (c === null || c === undefined) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  function field(label, inputNode, hint) {
    return h('label', { class: 'a3-field' }, [
      h('span', { class: 'a3-field-label', text: label }),
      inputNode,
      hint ? h('span', { class: 'a3-field-hint', text: hint }) : null,
    ]);
  }

  function clampNumber(value, min, max) {
    var number = Number(value);
    if (!Number.isFinite(number)) return null;
    return Math.min(max, Math.max(min, number));
  }

  function numberInput(key, min, max, step) {
    var current = Number(getCfgValue(key));
    var input = h('input', {
      class: 'a3-input',
      type: 'number',
      min: String(min),
      max: String(max),
      step: String(step || 1),
      value: String(Number.isFinite(current) ? current : min),
    });
    input.addEventListener('change', function () {
      var next = clampNumber(input.value, min, max);
      if (next === null) {
        input.value = String(Number.isFinite(current) ? current : min);
        pushLog('warn', '「' + key + '」输入不是有效数字，已还原');
        return;
      }
      if (next !== Number(input.value)) pushLog('warn', '「' + key + '」超出范围，已修正为 ' + next);
      input.value = String(next);
      current = next;
      setCfgValue(key, next);
    });
    return input;
  }

  function textInput(key, placeholder) {
    var input = h('input', {
      class: 'a3-input',
      type: 'text',
      value: String(getCfgValue(key) || ''),
      placeholder: placeholder || '',
    });
    input.addEventListener('change', function () {
      setCfgValue(key, input.value.trim());
      refreshPrereqHint();
    });
    return input;
  }

  function checkbox(labelText, checked, onChange, testid) {
    var box = h('input', { type: 'checkbox' });
    if (testid) box.setAttribute('data-testid', testid);
    box.checked = Boolean(checked);
    box.addEventListener('change', function () {
      onChange(box.checked);
    });
    return h('label', { class: 'a3-check' }, [box, h('span', { text: labelText })]);
  }

  // ───────────────────────── 运行页 ─────────────────────────

  function buildToggleRow() {
    var toggle = h('button', {
      class: 'a3-toggle' + (state.enabled ? ' on' : ''),
      type: 'button',
      title: state.enabled ? '停止' : '启动',
      'data-testid': 'a3-start-stop',
      'aria-label': state.enabled ? '停止自动化' : '启动自动化',
      onclick: function () {
        if (state.enabled) stop();
        else start();
      },
    }, [h('span', { class: 'a3-toggle-knob' })]);

    var dryCheckbox = h('input', { type: 'checkbox', 'data-testid': 'a3-dry-run' });
    dryCheckbox.checked = state.dryRun;
    dryCheckbox.addEventListener('change', function () {
      if (!dryCheckbox.checked && state.dryRun) {
        var ok = window.confirm(
          '关闭预览后将向学校/平台真实提交（报名、签到、签退、跑步上报等），可能产生不可撤销的记录。\n\n确定改为真实执行吗？',
        );
        if (!ok) {
          dryCheckbox.checked = true;
          return;
        }
      }
      state.dryRun = dryCheckbox.checked;
      persistState();
      syncEngineMode();
      pushLog('info', state.dryRun ? '已切换为预览模式（不会真实提交）' : '已切换为真实执行（会真实提交）');
      renderStatus();
      refreshPrereqHint();
    });
    var dryLabel = h('label', { class: 'a3-check' }, [dryCheckbox, h('span', { text: '预览（不真实提交）' })]);

    var previewBtn = h('button', {
      class: 'a3-btn',
      type: 'button',
      text: '立即预览',
      'data-testid': 'a3-preview',
      onclick: function () {
        executeRound(true, true);
      },
    });
    var runBtn = h('button', {
      class: 'a3-btn',
      type: 'button',
      text: state.dryRun ? '立即运行（预览模式）' : '立即运行（真实提交）',
      'data-testid': 'a3-run-once',
      onclick: function () {
        executeRound(true, false);
      },
    });

    el.dryCheckbox = dryCheckbox;
    el.previewBtn = previewBtn;
    el.runBtn = runBtn;

    return h('div', { class: 'a3-toggle-block' }, [
      h('div', { class: 'a3-row' }, [
        h('div', { class: 'a3-row-main' }, [
          h('div', { class: 'a3-title', text: '3CT 自动业务' }),
          h('div', { class: 'a3-sub', id: 'a3-status', text: '未启动' }),
        ]),
        h('div', { class: 'a3-row-actions' }, [dryLabel, toggle]),
      ]),
      h('div', { class: 'a3-inline-btns' }, [previewBtn, runBtn]),
      h('div', { class: 'a3-hint a3-prereq', id: 'a3-prereq' }),
    ]);
  }

  function moduleGroup(title, testid, configKey) {
    return h('div', { class: 'a3-group' }, [
      h('div', { class: 'a3-group-head' }, [
        h('div', { class: 'a3-group-title', text: title }),
        checkbox('启用', Boolean(getCfgValue(configKey)), function (checked) {
          setCfgValue(configKey, checked);
          refreshPrereqHint();
        }, testid),
      ]),
    ]);
  }

  function keywordField(configKey, testid, placeholder) {
    var input = h('input', {
      class: 'a3-input',
      type: 'text',
      value: String(getCfgValue(configKey) || ''),
      placeholder: placeholder || '',
      'data-testid': testid,
    });
    input.addEventListener('change', function () {
      setCfgValue(configKey, input.value.trim());
    });
    return h('div', { class: 'a3-field a3-field-wrap' }, [
      h('span', { class: 'a3-field-label', text: '关键词（逗号分隔）' }),
      input,
    ]);
  }

  function buildRunTab() {
    var unirunGroup = moduleGroup('校园跑', 'a3-module-unirun', 'unirun.enabled');
    unirunGroup.appendChild(
      field(
        '校园跑账号',
        buildSelect('a3-account', function (value) {
          setCfgValue('accountId', value);
          refreshPrereqHint();
        }),
        '来自「校园跑」页已登录的账号；真实执行必须显式选择',
      ),
    );
    unirunGroup.appendChild(
      field(
        '校区',
        buildSelect('a3-campus', function (value) {
          setCfgValue('campusId', value);
          refreshPrereqHint();
        }),
        '来自 ctAPI.unirun.campusLocalList()；真实执行必须显式选择',
      ),
    );
    unirunGroup.appendChild(
      h('div', { class: 'a3-inline-btns' }, [
        h('button', {
          class: 'a3-btn',
          type: 'button',
          text: '刷新账号',
          'data-testid': 'a3-refresh-account',
          onclick: refreshAccountOptions,
        }),
        h('button', {
          class: 'a3-btn',
          type: 'button',
          text: '刷新校区',
          'data-testid': 'a3-refresh-campus',
          onclick: refreshCampusOptions,
        }),
      ]),
    );
    unirunGroup.appendChild(field('每日执行时刻（HH:mm）', textInput('unirun.runAt', '06:30')));
    unirunGroup.appendChild(field('有效窗口（分钟）', numberInput('unirun.windowMinutes', 1, 720, 5)));
    unirunGroup.appendChild(field('里程（米）', numberInput('unirun.runDistance', 1000, 10000, 100)));
    unirunGroup.appendChild(field('时长（分钟）', numberInput('unirun.runTime', 5, 300, 5)));
    unirunGroup.appendChild(
      h('div', { class: 'a3-hint', text: '成功判定严格 code=10000；账号/校区仅在本机使用，不上传。' }),
    );

    var clubGroup = moduleGroup('俱乐部', 'a3-module-club', 'club.enabled');
    clubGroup.appendChild(keywordField('club.keywordsText', 'a3-club-keywords', '如 篮球,志愿'));
    clubGroup.appendChild(
      checkbox('关键词为空时允许全部（仍受每日上限约束）', Boolean(getCfgValue('club.allowAll')), function (checked) {
        setCfgValue('club.allowAll', checked);
      }, 'a3-club-allow-all'),
    );
    clubGroup.appendChild(field('每日报名上限', numberInput('club.dailyJoinLimit', 1, 20, 1), '跨 tick 累计，避免越报越多'));
    clubGroup.appendChild(
      h('div', { class: 'a3-hint', text: '关键词非空时按关键词匹配；allowAll 仅在关键词为空时生效。' }),
    );

    var ekGroup = moduleGroup('二课', 'a3-module-ek', 'ek.enabled');
    ekGroup.appendChild(keywordField('ek.keywordsText', 'a3-ek-keywords', '如 讲座,志愿'));
    ekGroup.appendChild(
      checkbox('关键词为空时允许全部（每日上限仍生效）', Boolean(getCfgValue('ek.allowAll')), function (checked) {
        setCfgValue('ek.allowAll', checked);
      }, 'a3-ek-allow-all'),
    );
    ekGroup.appendChild(field('每日报名上限', numberInput('ek.dailyLimit', 1, 20, 1)));
    ekGroup.appendChild(field('二维码延迟（分钟）', numberInput('ek.qrDelayMinutes', 0, 60, 1), '官方窗口开始后延迟拉图库'));
    ekGroup.appendChild(field('重试间隔（分钟）', numberInput('ek.qrRetryMinutes', 0, 60, 1)));
    ekGroup.appendChild(field('最多尝试次数', numberInput('ek.qrMaxAttempts', 1, 10, 1)));
    ekGroup.appendChild(
      h('div', { class: 'a3-hint', text: '仅扫码方式(SignWay=1)可自动；拍照/定位/验证码需人工，缺材料时只等待不假成功。' }),
    );

    return h('div', { class: 'a3-tab-body' }, [
      h('div', { class: 'a3-group' }, [
        h('div', { class: 'a3-group-title', text: '运行参数' }),
        field('常规轮询间隔（秒，≥15）', numberInput('tickSec', 15, 3600, 5), '非窗口期检查频率'),
        field('窗口内间隔（秒，≥15）', numberInput('windowTickSec', 15, 600, 5), '有等待项时加快尝试'),
        h('div', { class: 'a3-hint', text: '参数保存在本机 localStorage，不会上传。' }),
      ]),
      unirunGroup,
      clubGroup,
      ekGroup,
    ]);
  }

  // ───────────────────────── 状态页 / 日志页 ─────────────────────────

  function buildStateTab() {
    var profilesInfo = h('pre', { class: 'a3-pre', text: '读取中…' });
    setTimeout(function () {
      try {
        var inst = ensureEngine();
        var p = inst.getProfiles();
        profilesInfo.textContent = [
          '二课账号：' + (p.ekAccount || '（未登录）'),
          '校园跑账号：' + (p.unirunPhone || '（未配置）'),
          '账号列表：' +
            (p.unirunAccounts.length
              ? p.unirunAccounts
                  .map(function (a) {
                    return (a.selected ? '● ' : '○ ') + a.id + (a.remark ? '（' + a.remark + '）' : '');
                  })
                  .join('，')
              : '（无）'),
        ].join('\n');
      } catch (e) {
        profilesInfo.textContent = '无法读取账号信息：' + (e && e.message ? e.message : String(e));
      }
    }, 0);

    return h('div', { class: 'a3-tab-body' }, [
      h('div', { class: 'a3-group' }, [
        h('div', { class: 'a3-group-title', text: '当前账号（仅显示 ID/备注，不含密码）' }),
        profilesInfo,
      ]),
      h('div', { class: 'a3-group' }, [
        h('div', { class: 'a3-group-title', text: '去重状态' }),
        h('div', { class: 'a3-hint', text: '记录每日已成功/已失败的 key；状态损坏时引擎会拒绝提交并提示。' }),
        h('div', { class: 'a3-row' }, [
          h('button', {
            class: 'a3-btn',
            text: '查看状态文件',
            onclick: function () {
              var raw = window.localStorage.getItem('auto3ct:state');
              if (!raw) {
                pushLog('info', '状态文件为空（尚未运行或已重置）');
                return;
              }
              try {
                var parsed = JSON.parse(raw);
                var summary = {
                  done: Object.keys(parsed.done || {}).length,
                  failed: Object.keys(parsed.failed || {}).length,
                  inflight: Object.keys(parsed.inflight || {}).length,
                  qrChecks: Object.keys(parsed.qrChecks || {}).length,
                };
                pushLog('info', '状态统计：' + JSON.stringify(summary));
              } catch (e) {
                pushLog('error', '状态文件损坏或为空，请重置后再运行');
              }
            },
          }),
          h('button', {
            class: 'a3-btn danger',
            text: '重置状态（慎用）',
            onclick: function () {
              if (!window.confirm('重置会清除今日去重记录，可能导致重复提交。确定继续？')) return;
              try {
                ensureEngine().resetState();
                pushLog('warn', '去重状态已重置');
              } catch (e) {
                pushLog('error', '重置失败：' + (e && e.message ? e.message : String(e)));
              }
            },
          }),
        ]),
      ]),
    ]);
  }

  function buildLogTab() {
    el.logList = h('div', { class: 'a3-log-list', 'data-testid': 'a3-logs' });
    return h('div', { class: 'a3-tab-body' }, [
      h('div', { class: 'a3-row' }, [
        h('button', {
          class: 'a3-btn',
          text: '清空日志',
          onclick: function () {
            logs = [];
            renderLogs();
          },
        }),
        h('button', {
          class: 'a3-btn',
          text: '导出本次结果（脱敏）',
          onclick: function () {
            var text = logs
              .map(function (l) {
                return formatTime(l.at) + ' [' + l.kind + '] ' + l.text;
              })
              .join('\n');
            var blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
            var a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'auto3ct-log-' + Date.now() + '.txt';
            a.click();
            setTimeout(function () {
              URL.revokeObjectURL(a.href);
            }, 1000);
          },
        }),
      ]),
      el.logList,
    ]);
  }

  // ───────────────────────── 面板外壳 ─────────────────────────

  function buildPanel() {
    var tab = loadUi().tab || 'run';
    el.tabs = {
      run: h('button', {
        class: 'a3-tab' + (tab === 'run' ? ' active' : ''),
        text: '运行',
        onclick: function () { switchTab('run'); },
      }),
      state: h('button', {
        class: 'a3-tab' + (tab === 'state' ? ' active' : ''),
        text: '状态',
        onclick: function () { switchTab('state'); },
      }),
      logs: h('button', {
        class: 'a3-tab' + (tab === 'logs' ? ' active' : ''),
        text: '日志',
        onclick: function () { switchTab('logs'); },
      }),
    };
    el.body = h('div', { class: 'a3-body' });
    el.summary = h('div', { class: 'a3-summary', text: '尚无运行记录' });

    var collapseBtn = h('button', {
      class: 'a3-icon-btn',
      title: '收起/展开',
      html: '▾',
      onclick: function () {
        var ui = loadUi();
        var collapsed = !ui.collapsed;
        saveUi({ collapsed: collapsed });
        root.classList.toggle('collapsed', collapsed);
      },
    });

    var head = h('div', { class: 'a3-head' }, [
      h('div', { class: 'a3-brand' }, [h('span', { class: 'a3-dot' }), h('span', { text: 'AutoPanel' })]),
      h('div', { class: 'a3-head-actions' }, [collapseBtn]),
    ]);

    var root = h(
      'div',
      {
        class: 'auto3ct-panel' + (loadUi().collapsed ? ' collapsed' : ''),
        'data-testid': 'a3-panel',
      },
      [
        head,
        h('div', { class: 'a3-main' }, [
          buildToggleRow(),
          el.summary,
          h('div', { class: 'a3-tabs' }, [el.tabs.run, el.tabs.state, el.tabs.logs]),
          el.body,
        ]),
      ],
    );
    el.root = root;
    return root;
  }

  function switchTab(name) {
    saveUi({ tab: name });
    Object.keys(el.tabs).forEach(function (k) {
      el.tabs[k].classList.toggle('active', k === name);
    });
    renderTab(name);
  }

  function renderTab(name) {
    el.body.innerHTML = '';
    if (name === 'run') {
      el.body.appendChild(buildRunTab());
      refreshAccountOptions();
      refreshCampusOptions();
      refreshPrereqHint();
    } else if (name === 'state') {
      el.body.appendChild(buildStateTab());
    } else {
      el.body.appendChild(buildLogTab());
    }
    renderLogs();
  }

  function renderStatus() {
    var node = document.getElementById('a3-status');
    if (node) {
      if (state.enabled && state.running) node.textContent = state.dryRun ? '运行中（预览）' : '运行中（真实提交）';
      else if (state.enabled) node.textContent = state.dryRun ? '已启用（预览）· 等待下一轮' : '已启用（真实提交）· 等待下一轮';
      else node.textContent = '未启动';
    }
    var toggle = document.querySelector('[data-testid="a3-start-stop"]');
    if (toggle) {
      toggle.classList.toggle('on', state.enabled);
      toggle.title = state.enabled ? '停止' : '启动';
      toggle.setAttribute('aria-label', state.enabled ? '停止自动化' : '启动自动化');
    }
    if (el.previewBtn) {
      el.previewBtn.disabled = busy;
      el.previewBtn.title = busy ? '上一轮仍在执行' : '立即执行一轮预览';
    }
    if (el.runBtn) {
      el.runBtn.disabled = busy;
      el.runBtn.title = busy ? '上一轮仍在执行' : '立即执行一轮（使用当前预览/真实模式）';
      el.runBtn.textContent = state.dryRun ? '立即运行（预览模式）' : '立即运行（真实提交）';
    }
    if (state.enabled && state.dryRun) refreshPrereqHintSafe();
  }

  function refreshPrereqHintSafe() {
    try {
      refreshPrereqHint();
    } catch (e) {
      /* 提示失败不影响主流程 */
    }
  }

  function renderSummary() {
    if (!el.summary) return;
    if (!state.lastRunAt) {
      el.summary.textContent = '尚无运行记录';
      return;
    }
    var s = state.lastSummary || {};
    el.summary.textContent =
      '最近 ' + formatTime(state.lastRunAt) + ' · 成功 ' + (s.success || 0) +
      ' 失败 ' + (s.failed || 0) + ' 未知 ' + (s.unknown || 0) +
      ' 等待 ' + (s.waiting || 0) + (state.dryRun ? '（预览）' : '');
  }

  function renderLogs() {
    if (!el.logList) return;
    var frag = document.createDocumentFragment();
    logs
      .slice()
      .reverse()
      .slice(0, MAX_LOG)
      .forEach(function (item) {
        frag.appendChild(
          h('div', { class: 'a3-log a3-log-' + item.kind }, [
            h('span', { class: 'a3-log-time', text: formatTime(item.at) }),
            h('span', { class: 'a3-log-text', text: item.text }),
          ]),
        );
      });
    el.logList.innerHTML = '';
    el.logList.appendChild(frag);
  }

  // ───────────────────────── 挂载 ─────────────────────────

  function mount() {
    if (document.querySelector('.auto3ct-panel')) return;
    loadState();
    var panel = buildPanel();
    document.body.appendChild(panel);
    renderTab(loadUi().tab || 'run');
    renderStatus();
    // 重启恢复：把持久化的预览/真实模式同步进引擎配置，避免 UI 与引擎状态不一致。
    if (buildApi()) syncEngineMode();

    // 恢复上次的启动状态（仅用户主动开启过才会持久为 true）
    if (state.enabled) {
      pushLog('info', '检测到上次为启用状态，自动恢复运行');
      tick();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }

  window.Auto3CTPanel = {
    mount: mount,
    start: start,
    stop: stop,
    getLogs: function () {
      return logs.slice();
    },
  };
})();
