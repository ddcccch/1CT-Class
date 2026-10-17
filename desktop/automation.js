/**
 * 3CT AutoPanel 业务自动化引擎（纯前端 JS，可直接在渲染层运行）。
 *
 * 安全与正确性口径（与用户/Lead 逐条确认）：
 *  1. 默认 dry-run（预览）；只有用户明确关闭预览才真正写；
 *  2. 去重 fail-closed：提交前必须成功持久化 inflight，写失败就**不提交**；
 *     状态文件损坏时不静默当空状态，而是明确报「状态损坏」，禁止自动写；
 *  3. 失败终态锁定：failed / unknown 都持久化，当日不盲重试，需人工核查；
 *  4. 单飞：runOnce 互斥，重复点击不会并发双提交；
 *  5. 日期/时区一律按北京时间；缺时间/缺方式/缺二维码 → waiting-material，绝不假成功；
 *  6. 二维码只在「官方窗口 start + 延迟」之后每 tick 有限重试地重新拉本活动 boundImages 解码，
 *     空结果不当终态；阶段由元数据/后缀判定，opaque 码需上传时间落在本窗口内；
 *  7. 结果、日志、导出一律不含 token / 密码 / 完整手机号；账号信息只给 ID 与备注。
 *
 * 关于密码：引擎在运行时会从 3CT 本地账号存储读取密码用于调用 IPC（与 3CT 自身行为一致），
 * 但**不导出、不打印、不写入结果/日志**；所有对外结构只含账号 ID 与备注。
 *
 * 依赖注入（便于 Node 测试）：
 *   { api, storage, clock, decodeQr, logger, config }
 *   api 形状 = 3CT preload 的 window.ctAPI（ek/club/unirun/scheduler）。
 */
(function (root, factory) {
  'use strict';
  var mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  if (root) root.Auto3CTAutomation = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var STATE_KEY = 'auto3ct:state';
  var CONFIG_KEY = 'auto3ct:config';

  var EK_KEY = 'ct_ek_session_v1';
  /** 校园跑/俱乐部账号真实键（renderer/services/unirunAccounts.ts） */
  var UNIRUN_ACCOUNTS_KEY = 'ct_unirun_accounts_v1';

  var CLUB_SIGNIN_WINDOW_MIN = 5;
  var CLUB_SIGNOUT_WINDOW_MIN = 5;

  var DEFAULTS = {
    dryRun: true,
    accountId: '',
    campusId: '',
    tickMs: 60000, // 默认 60s 一次；窗口内面板可调至 >=15s
    windowTickMs: 20000,
    unirun: {
      enabled: false, // 模块开关：首次默认关，由用户勾选
      runAt: '06:30',
      windowMinutes: 30,
      runDistance: 3000,
      runTime: 30,
    },
    club: {
      enabled: false,
      keywords: [],
      allowAll: false,
      join: true,
      signIn: true,
      signOut: true,
      dailyJoinLimit: 1,
    },
    ek: {
      enabled: false,
      keywords: [],
      allowAll: false,
      apply: true,
      signIn: true,
      signOut: true,
      dailyLimit: 1,
      /** 二维码延迟触发：官方窗口开始后延迟 N 分钟才首次拉图库 */
      qrDelayMinutes: 2,
      /** 空/未识别后，下次尝试的间隔（分钟） */
      qrRetryMinutes: 2,
      /** 每阶段每天最多拉几次图库（总上限） */
      qrMaxAttempts: 3,
    },
  };

  var EK_SIGN_WAY_LABEL = { 1: '扫码', 2: '拍照', 3: '拍照+定位', 4: '验证码' };

  // ─────────────────────────── 错误类型 ───────────────────────────

  function StorageError(key, kind, cause) {
    var err = new Error('storage-' + kind + ':' + key);
    err.name = 'StorageError';
    err.key = key;
    err.kind = kind;
    err.cause = cause || null;
    return err;
  }

  // ─────────────────────────── 时间（北京时间） ───────────────────────────

  var BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function beijingParts(ms) {
    var d = new Date(Number(ms) + BEIJING_OFFSET_MS);
    return {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes(),
      second: d.getUTCSeconds(),
    };
  }

  function beijingDateString(ms) {
    var p = beijingParts(ms);
    return p.year + '-' + pad2(p.month) + '-' + pad2(p.day);
  }

  function beijingMinuteOfDay(ms) {
    var p = beijingParts(ms);
    return p.hour * 60 + p.minute;
  }

  function beijingToMs(y, mo, d, hh, mi, ss) {
    return Date.UTC(y, mo - 1, d, (hh || 0) - 8, mi || 0, ss || 0);
  }

  function parseHhmm(text) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(text == null ? '' : text).trim());
    if (!m) return null;
    var h = Number(m[1]);
    var mi = Number(m[2]);
    if (h > 23 || mi > 59) return null;
    return h * 60 + mi;
  }

  function parseMoment(value, dateSources) {
    var raw = String(value == null ? '' : value).trim();
    if (!raw) return null;
    var full = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(raw);
    if (full) {
      return beijingToMs(
        Number(full[1]),
        Number(full[2]),
        Number(full[3]),
        Number(full[4]),
        Number(full[5]),
        Number(full[6] || 0),
      );
    }
    var clock = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(raw);
    if (!clock) return null;
    var dateText = null;
    for (var i = 0; i < (dateSources || []).length; i += 1) {
      var src = String(dateSources[i] == null ? '' : dateSources[i]).trim();
      if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(src)) {
        dateText = src;
        break;
      }
    }
    if (!dateText) return null;
    var dm = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(dateText);
    if (!dm) return null;
    return beijingToMs(
      Number(dm[1]),
      Number(dm[2]),
      Number(dm[3]),
      Number(clock[1]),
      Number(clock[2]),
      Number(clock[3] || 0),
    );
  }

  function parseEkRange(value) {
    var raw = String(value == null ? '' : value).trim();
    if (!raw) return { start: null, end: null };
    var parts = raw.split(/\s*至\s*/);
    return {
      start: parseMoment(parts[0], []),
      end: parts[1] ? parseMoment(parts[1], []) : null,
    };
  }

  function parseClubMoment(value, dateSources) {
    return parseMoment(value, dateSources || []);
  }

  // ─────────────────────────── 业务判定 ───────────────────────────

  var EK_QR_REGEX = /^(lbUUh.*|.*(QD|QT))$/;

  function isValidEkQr(value) {
    var s = String(value == null ? '' : value).trim();
    return s ? EK_QR_REGEX.test(s) : false;
  }

  function dedupeKey(parts) {
    return [parts.date, parts.account, parts.module, parts.activityId, parts.action].join('|');
  }

  function isClubSuccess(res) {
    var code = Number(res && res.code);
    return code === 10000 || code === 1000;
  }

  function isUnirunSuccess(res) {
    return Number(res && res.code) === 10000;
  }

  /** 二课写操作：errcode===0 且响应不含「无法/无需」才算成功；缺 errcode → unknown */
  function classifyEkWrite(res) {
    if (!res || typeof res !== 'object') return 'unknown';
    var inner = res.data && typeof res.data === 'object' ? res.data : null;
    var errcode =
      typeof res.errcode === 'number'
        ? res.errcode
        : inner && typeof inner.errcode === 'number'
          ? inner.errcode
          : null;
    if (errcode === null) return 'unknown';
    if (errcode !== 0) return 'failed';
    var text = '';
    try {
      text = JSON.stringify(res);
    } catch (e) {
      text = '';
    }
    if (text.indexOf('无法') >= 0 || text.indexOf('无需') >= 0) return 'failed';
    return 'success';
  }

  function ekListItems(res) {
    var list = res && res.List;
    if (!list || !Array.isArray(list.Items)) return null; // 不把结构不符当空列表
    return list.Items;
  }

  function ekActivityId(item) {
    var candidates = [item && item.Id, item && item.id, item && item.ActivityId];
    for (var i = 0; i < candidates.length; i += 1) {
      var v = candidates[i];
      if (v !== undefined && v !== null && String(v).trim() !== '') return String(v);
    }
    return '';
  }

  function ekActivityStatus(item) {
    var candidates = [item && item.Status, item && item.status, item && item.ActivityStatus];
    for (var i = 0; i < candidates.length; i += 1) {
      var v = candidates[i];
      if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
    }
    return '';
  }

  function ekApplied(item) {
    if (ekActivityStatus(item) === '1') return true;
    return Boolean(item && item.ApplyInfo);
  }

  function signStatusOf(info, key) {
    var listInfo = info && info.ActivityListInfo;
    if (!listInfo || typeof listInfo !== 'object') return '';
    var signInfo = listInfo.ActivitySignInfo;
    if (!signInfo || typeof signInfo !== 'object') return '';
    return String(signInfo[key] == null ? '' : signInfo[key]).trim();
  }

  /**
   * 报名状态判定：
   *  - 列表 ActivityStatus=1 → 已报名；
   *  - 详情 ApplyInfo.Id 非空 → 已报名（3CT 自身用 ApplyInfo.Id 作为签到表单的 signId，
   *    真实详情里「已报名」就是带 Id 的 ApplyInfo）；
   *  - 列表 ActivityStatus=0 且无有效 ApplyInfo → 可报名；
   *  - 其余（结构异常）→ unknown，不猜、不自动报名/签到。
   */
  function ekApplyState(item, detail) {
    if (ekApplied(item)) return 'applied';
    var applyInfo = detail && detail.ApplyInfo;
    if (applyInfo && typeof applyInfo === 'object') {
      var idText = applyInfo.Id != null ? String(applyInfo.Id).trim() : '';
      if (idText) return 'applied';
      if (Object.keys(applyInfo).length > 0) return 'unknown'; // 有字段但无 Id：不猜
    }
    if (ekActivityStatus(item) === '0') return 'joinable';
    return 'unknown';
  }

  function clubActivityId(item) {
    var candidates = [
      item && item.clubActivityId,
      item && item.activityId,
      item && item.configurationId,
      item && item.id,
    ];
    for (var i = 0; i < candidates.length; i += 1) {
      var v = Number(candidates[i]);
      if (Number.isFinite(v) && v > 0) return v;
    }
    return 0;
  }

  function clubUnlimited(item) {
    var raw = item && item.maxStudent != null ? item.maxStudent : item && item.studentNum;
    if (raw === undefined || raw === null || String(raw).trim() === '') return false;
    var total = Number(raw);
    return Number.isFinite(total) && total <= 0;
  }

  function clubEffectiveStatus(item) {
    var status = String((item && item.optionStatus) == null ? '' : item.optionStatus).trim();
    if (status === '7' && clubUnlimited(item)) return '6';
    return status;
  }

  /** 官方签到/签退状态字段 → '1' 视为已完成（宽松：1/true/已完成 都算） */
  function clubSignDone(value) {
    var s = String(value == null ? '' : value).trim().toLowerCase();
    return s === '1' || s === 'true' || s === '已完成' || s === '已签到' || s === '已签退';
  }

  function extractList(res) {
    if (!res || typeof res !== 'object') return null;
    var body = res.response && typeof res.response === 'object' ? res.response : res;
    if (Array.isArray(body)) return body;
    var keys = ['list', 'items', 'rows', 'records', 'data'];
    for (var i = 0; i < keys.length; i += 1) {
      if (Array.isArray(body[keys[i]])) return body[keys[i]];
    }
    return null;
  }

  function extractBoundImageItems(res) {
    if (!res || typeof res !== 'object') return [];
    if (Array.isArray(res.items)) return res.items;
    if (res.data && Array.isArray(res.data.items)) return res.data.items;
    if (Array.isArray(res)) return res;
    return [];
  }

  function keywordMatch(item, keywords) {
    if (!keywords || keywords.length === 0) return true;
    var haystack = [
      item && item.activityName,
      item && item.ActivityName,
      item && item.itemName,
      item && item.teacherName,
      item && item.address,
      item && item.clubIntroduction,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    for (var i = 0; i < keywords.length; i += 1) {
      var kw = String(keywords[i] || '').trim().toLowerCase();
      if (kw && haystack.indexOf(kw) >= 0) return true;
    }
    return false;
  }

  /** 关键词门禁：空关键词默认不匹配任何活动（除非显式 allowAll，仍需 limit 收敛） */
  function passesKeyword(item, cfg) {
    var keywords = (cfg && cfg.keywords) || [];
    if (keywords.length > 0) return keywordMatch(item, keywords);
    return Boolean(cfg && cfg.allowAll);
  }

  function row(module, action, activityId, status, reason, extra) {
    var out = {
      module: module,
      action: action,
      activityId: activityId == null ? '' : String(activityId),
      status: status,
      reason: reason ? String(reason).slice(0, 160) : '',
      at: 0,
    };
    if (extra) {
      Object.keys(extra).forEach(function (k) {
        out[k] = extra[k];
      });
    }
    return out;
  }

  function sanitizeError(e) {
    var text = e && e.message ? String(e.message) : String(e == null ? '' : e);
    return text
      .replace(/(password|access_token|refresh_token|JSESSIONID|token)\s*[:=]\s*[^\s,;]+/gi, '$1=***')
      .replace(/\b1[3-9]\d{9}\b/g, '1**********')
      .replace(/\s+/g, ' ')
      .slice(0, 140);
  }

  // ─────────────────────────── mergeConfig ───────────────────────────

  function mergeConfig() {
    var out = {};
    for (var i = 0; i < arguments.length; i += 1) {
      var src = arguments[i];
      if (!src || typeof src !== 'object') continue;
      Object.keys(src).forEach(function (key) {
        var value = src[key];
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          out[key] = mergeConfig(out[key] || {}, value);
        } else if (value !== undefined) {
          out[key] = Array.isArray(value) ? value.slice() : value;
        }
      });
    }
    return out;
  }

  // ─────────────────────────── 引擎 ───────────────────────────

  function createEngine(options) {
    var opts = options || {};
    var api = opts.api || {};
    var storage = opts.storage;
    var clock = opts.clock || { now: function () { return Date.now(); } };
    var decodeQr = opts.decodeQr || function () { return Promise.resolve(null); };
    var logger = opts.logger || { log: function () {} };
    var runtimeConfig = mergeConfig(DEFAULTS, opts.config || {});
    var stopped = false;
    var running = false;
    /**
     * 预览模式标记：true 时 saveState 一律不落盘。
     * 目的：预览可以看到「将要做什么」，但绝不能消耗真实预算
     * （qrChecks 次数 / usedImages / daily 计数 / watchedEk / done / failed / inflight）。
     */
    var previewMode = false;

    if (!storage) throw new Error('createEngine 需要 storage');

    function now() {
      return Number(clock.now());
    }

    function readJson(key) {
      var raw;
      try {
        raw = storage.get(key);
      } catch (e) {
        throw StorageError(key, 'read', e);
      }
      if (raw === null || raw === undefined || raw === '') return null;
      var parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        throw StorageError(key, 'corrupt', e);
      }
      if (!parsed || typeof parsed !== 'object') throw StorageError(key, 'corrupt', null);
      return parsed;
    }

    function writeJson(key, value) {
      try {
        storage.set(key, JSON.stringify(value));
      } catch (e) {
        throw StorageError(key, 'write', e);
      }
    }

    /** 读取状态；损坏直接抛（禁止静默空态） */
    function loadState() {
      var s = readJson(STATE_KEY);
      if (!s) {
        return { done: {}, inflight: {}, failed: {}, usedImages: {}, daily: {}, qrChecks: {}, watchedEk: {} };
      }
      if (
        typeof s.done !== 'object' || s.done === null ||
        typeof s.inflight !== 'object' || s.inflight === null
      ) {
        throw StorageError(STATE_KEY, 'corrupt', null);
      }
      return {
        done: s.done,
        inflight: s.inflight,
        failed: s.failed && typeof s.failed === 'object' ? s.failed : {},
        usedImages: s.usedImages && typeof s.usedImages === 'object' ? s.usedImages : {},
        daily: s.daily && typeof s.daily === 'object' ? s.daily : {},
        qrChecks: s.qrChecks && typeof s.qrChecks === 'object' ? s.qrChecks : {},
        // 关注中的二课活动（跨 tick / 跨进程持久）：{ [account]: { [activityId]: {name, addedAt} } }
        watchedEk: s.watchedEk && typeof s.watchedEk === 'object' ? s.watchedEk : {},
      };
    }

    function saveState(state) {
      // 预览模式不落盘：内存里的计数变化对下一轮 preview 无影响，更不会污染真实状态
      if (previewMode) return;
      writeJson(STATE_KEY, {
        done: state.done,
        inflight: state.inflight,
        failed: state.failed || {},
        usedImages: state.usedImages || {},
        daily: state.daily || {},
        qrChecks: state.qrChecks || {},
        watchedEk: state.watchedEk || {},
      });
    }

    function getConfig() {
      var persisted = null;
      try {
        persisted = readJson(CONFIG_KEY);
      } catch (e) {
        persisted = null; // 配置损坏不阻断（不影响去重安全），但要告警
        logger.log('配置损坏，使用默认值：' + sanitizeError(e));
      }
      return mergeConfig(runtimeConfig, persisted || {});
    }

    /**
     * 保存配置：内存态先更新（本次会话可用），但**写盘失败要向调用方抛错**，
     * 让 UI 明确显示「未保存」，而不是伪称已保存。
     */
    function setConfig(patch) {
      var next = mergeConfig(getConfig(), patch || {});
      runtimeConfig = next;
      writeJson(CONFIG_KEY, next);
      return next;
    }

    function ekSession() {
      var s = null;
      try {
        s = readJson(EK_KEY);
      } catch (e) {
        return null;
      }
      if (!s || !s.JSESSIONID || !s.access_token) return null;
      return s;
    }

    function accountsState() {
      var s = null;
      try {
        s = readJson(UNIRUN_ACCOUNTS_KEY);
      } catch (e) {
        return { selectedId: null, items: [] };
      }
      if (!s || !Array.isArray(s.items)) return { selectedId: null, items: [] };
      var items = [];
      s.items.forEach(function (it) {
        var id = String((it && it.id) || '').trim();
        if (!id) return; // 与 3CT 一致：只要求 id 非空，phone 可为空（提示重新登录）
        items.push({
          id: id,
          phone: String((it && it.phone) || '').trim(),
          password: String((it && it.password) || ''),
          remark: String((it && it.remark) || '').trim(),
          updatedAt: Number((it && it.updatedAt) || 0),
        });
      });
      return { selectedId: s.selectedId ? String(s.selectedId) : null, items: items };
    }

    function resolveAccount(config) {
      var state = accountsState();
      if (config.accountId) {
        for (var i = 0; i < state.items.length; i += 1) {
          if (String(state.items[i].id) === String(config.accountId)) return state.items[i];
        }
      }
      if (state.selectedId) {
        for (var j = 0; j < state.items.length; j += 1) {
          if (String(state.items[j].id) === state.selectedId) return state.items[j];
        }
      }
      return state.items.length > 0 ? state.items[0] : null;
    }

    /** 模块级账号标识（仅用于去重键）：二课用学号，校园跑/俱乐部用选中的账号 id */
    function accountFor(config, moduleName) {
      if (moduleName === 'ek') {
        var ek = ekSession();
        var loginName = ek && ek.user_info && ek.user_info.loginName;
        if (loginName) return String(loginName);
      }
      var acc = resolveAccount(config);
      return acc ? String(acc.id) : 'local';
    }

    /** 校区来自 ctAPI.unirun.campusLocalList()（不是 localStorage） */
    function listCampuses() {
      return Promise.resolve()
        .then(function () {
          if (!api.unirun || typeof api.unirun.campusLocalList !== 'function') return [];
          return api.unirun.campusLocalList();
        })
        .then(function (res) {
          var arr = Array.isArray(res) ? res : Array.isArray(res && res.items) ? res.items : [];
          return arr.filter(function (c) {
            return c && String(c.id || '') !== '';
          });
        })
        .catch(function () {
          return [];
        });
    }

    /**
     * 选择校区：显式 campusId 必须命中；未配置时才取首项。
     * 显式配置但不存在 → 返回 { missing: true }，由调用方明确 waiting，不静默回落首项。
     */
    function pickCampus(list, config) {
      if (!list || list.length === 0) return { campus: null, missing: false };
      if (config.campusId) {
        for (var i = 0; i < list.length; i += 1) {
          if (String(list[i].id) === String(config.campusId)) return { campus: list[i], missing: false };
        }
        return { campus: null, missing: true };
      }
      return { campus: list[0], missing: false };
    }

    /** 当日「startMin + windowMin」的绝对毫秒（北京时间当天） */
    function dayWindowEndMs(startMin, windowMin) {
      var p = beijingParts(now());
      return beijingToMs(p.year, p.month, p.day, 0, 0, 0) + (startMin + windowMin) * 60000;
    }

    /** 数值配置校验：必须 finite 且落在范围内，否则返回 null（不悄悄用默认值掩盖错误） */
    function numInRange(value, min, max) {
      var n = Number(value);
      if (!Number.isFinite(n)) return null;
      if (n < min || n > max) return null;
      return n;
    }

    // ── 每日计数（跨 tick 累计，避免每轮清零导致越报越多） ──

    function dailyKey(date, account, moduleName, action) {
      return [date, account, moduleName, action].join('|');
    }

    function dailyCount(state, key) {
      return Number((state.daily && state.daily[key]) || 0);
    }

    function dailyAdd(state, key) {
      state.daily = state.daily || {};
      state.daily[key] = dailyCount(state, key) + 1;
    }

    /**
     * 单动作执行（安全核心）。
     *  - state 损坏 / inflight / failed 终态 → 直接阻塞，不提交；
     *  - dry-run → 只出预览行；
     *  - 提交前先持久化 inflight，**写失败则不提交**（fail-closed）；
     *  - 成功落 done；业务失败落 failed 终态；异常保留 inflight 并落 unknown 终态；
     *  - 落盘失败一律告警，且内存态仍保留，避免同进程重复提交。
     */
    function perform(state, meta, submit, classify) {
      var key = meta.key;
      var config = meta.config;

      if (state.done[key]) {
        return Promise.resolve(row(meta.module, meta.action, meta.activityId, 'skipped', 'already-done', { key: key }));
      }
      var locked = state.failed[key];
      if (locked) {
        return Promise.resolve(
          row(meta.module, meta.action, meta.activityId, 'blocked', 'locked-' + String(locked.status || 'failed'), { key: key }),
        );
      }
      if (state.inflight[key]) {
        return Promise.resolve(row(meta.module, meta.action, meta.activityId, 'blocked', 'previous-result-unknown', { key: key }));
      }
      if (config.dryRun) {
        return Promise.resolve(row(meta.module, meta.action, meta.activityId, 'dry-run', 'preview-only', { key: key }));
      }
      if (stopped) {
        return Promise.resolve(row(meta.module, meta.action, meta.activityId, 'skipped', 'stopped', { key: key }));
      }

      // fail-closed：inflight 必须先落盘成功
      state.inflight[key] = now();
      try {
        saveState(state);
      } catch (e) {
        delete state.inflight[key];
        logger.log('[storage] inflight 写入失败，已阻止提交：' + sanitizeError(e));
        return Promise.resolve(
          row(meta.module, meta.action, meta.activityId, 'blocked', 'storage-error', { key: key }),
        );
      }

      // 落盘后、真正提交前再校验：已停止 / 已过截止 → 撤回 inflight 不提交
      if (stopped) {
        delete state.inflight[key];
        try {
          saveState(state);
        } catch (e) {
          /* 已尽力 */
        }
        return Promise.resolve(row(meta.module, meta.action, meta.activityId, 'skipped', 'stopped', { key: key }));
      }
      if (typeof meta.deadlineMs === 'number' && now() > meta.deadlineMs) {
        delete state.inflight[key];
        try {
          saveState(state);
        } catch (e) {
          /* 已尽力 */
        }
        return Promise.resolve(row(meta.module, meta.action, meta.activityId, 'skipped', 'past-deadline', { key: key }));
      }

      return Promise.resolve()
        .then(submit)
        .then(function (res) {
          var verdict = classify(res);
          delete state.inflight[key];
          if (verdict === 'success') {
            state.done[key] = now();
            if (meta.dailyKey) dailyAdd(state, meta.dailyKey);
          } else if (verdict === 'failed') {
            state.failed[key] = { status: 'failed', at: now() };
          } else {
            // unknown：保留终态锁定，避免下一 tick 盲重试
            state.failed[key] = { status: 'unknown', at: now() };
          }
          var persistFailed = false;
          try {
            saveState(state);
          } catch (e) {
            persistFailed = true;
            logger.log('[storage] 结果落盘失败（内存态仍生效，需人工核查）：' + sanitizeError(e));
          }
          logger.log('[' + meta.module + '] ' + meta.action + ' ' + String(meta.activityId) + ' → ' + verdict);
          var status = verdict;
          var reason = '';
          if (persistFailed) {
            status = verdict === 'success' ? 'unknown' : verdict;
            reason = 'persist-after-result-failed';
          } else if (verdict !== 'success') {
            reason = 'upstream-rejected';
          }
          return row(meta.module, meta.action, meta.activityId, status, reason, { key: key });
        })
        .catch(function (e) {
          delete state.inflight[key];
          state.failed[key] = { status: 'unknown', at: now() };
          try {
            saveState(state);
          } catch (err) {
            logger.log('[storage] unknown 状态落盘失败：' + sanitizeError(err));
          }
          logger.log('[' + meta.module + '] ' + meta.action + ' ' + String(meta.activityId) + ' → unknown');
          return row(meta.module, meta.action, meta.activityId, 'unknown', sanitizeError(e), { key: key });
        });
    }

    // ── 校园跑 ──────────────────────────────────────────────

    function planUnirun(state, config, results) {
      if (!config.unirun.enabled) return Promise.resolve();
      var u = resolveAccount(config);
      if (!u) {
        results.push(row('unirun', 'autoRun', '', 'waiting-material', 'no-unirun-account'));
        return Promise.resolve();
      }
      var minute = beijingMinuteOfDay(now());
      var startMin = parseHhmm(config.unirun.runAt);
      if (startMin === null) {
        results.push(row('unirun', 'autoRun', '', 'failed', 'invalid-run-at'));
        return Promise.resolve();
      }
      var windowMin = numInRange(config.unirun.windowMinutes, 1, 720);
      if (windowMin === null) {
        results.push(row('unirun', 'autoRun', '', 'failed', 'invalid-window'));
        return Promise.resolve();
      }
      // 数值参数严格校验：非法配置明确失败，不用默认值掩盖
      var runDistance = numInRange(config.unirun.runDistance, 1000, 10000);
      var runTime = numInRange(config.unirun.runTime, 5, 300);
      if (runDistance === null || runTime === null) {
        results.push(row('unirun', 'autoRun', '', 'failed', 'invalid-run-params'));
        return Promise.resolve();
      }
      if (minute < startMin) {
        results.push(row('unirun', 'autoRun', '', 'not-yet', 'before-run-time'));
        return Promise.resolve();
      }
      if (minute > startMin + windowMin) {
        results.push(row('unirun', 'autoRun', '', 'expired', 'run-window-passed'));
        return Promise.resolve();
      }
      var account = accountFor(config, 'unirun');
      var key = dedupeKey({
        date: beijingDateString(now()),
        account: account,
        module: 'unirun',
        activityId: 'daily',
        action: 'run',
      });
      return listCampuses().then(function (list) {
        var picked = pickCampus(list, config);
        var campus = picked.campus;
        if (picked.missing) {
          results.push(row('unirun', 'autoRun', '', 'waiting-material', 'campus-not-found'));
          return null;
        }
        if (!campus) {
          // 先看是否已有终态，避免「没校区」掩盖已锁定
          if (state.done[key] || state.failed[key] || state.inflight[key] || config.dryRun) {
            return perform(state, { key: key, module: 'unirun', action: 'autoRun', activityId: 'daily', config: config }, function () {
              return null;
            }, function () {
              return 'unknown';
            }).then(function (r) {
              results.push(r);
            });
          }
          results.push(row('unirun', 'autoRun', '', 'waiting-material', 'no-campus'));
          return null;
        }
        if (!u.phone || !u.password) {
          results.push(row('unirun', 'autoRun', '', 'waiting-material', 'account-missing-credential'));
          return null;
        }
        return perform(
          state,
          {
            key: key,
            module: 'unirun',
            action: 'autoRun',
            activityId: 'daily',
            config: config,
            // 当天执行窗口结束前才允许真正提交
            deadlineMs: dayWindowEndMs(startMin, windowMin),
          },
          function () {
            return api.unirun.autoRun({
              phone: u.phone,
              password: u.password,
              runDistance: runDistance,
              runTime: runTime,
              schoolSiteIndex: Number(campus.schoolSiteIndex) || 0,
              mapName: String(campus.mapName || ''),
            });
          },
          function (res) {
            if (!res || typeof res !== 'object') return 'unknown';
            return isUnirunSuccess(res) ? 'success' : 'failed';
          },
        ).then(function (r) {
          results.push(r);
        });
      });
    }

    // ── 俱乐部 ──────────────────────────────────────────────

    function planClub(state, config, results) {
      if (!config.club.enabled) return Promise.resolve();
      var u = resolveAccount(config);
      if (!u) {
        results.push(row('club', 'list', '', 'waiting-material', 'no-unirun-account'));
        return Promise.resolve();
      }
      if (!passesKeyword({}, config.club) && (config.club.keywords || []).length === 0) {
        results.push(row('club', 'list', '', 'waiting-material', 'need-keywords'));
        return Promise.resolve();
      }
      var account = accountFor(config, 'club');
      var cred = { phone: u.phone, password: u.password };
      var today = beijingDateString(now());
      var myTasks = [];
      var activityById = {};

      return Promise.resolve(api.club.myActivityList(Object.assign({ pageNo: 1, pageSize: 50 }, cred)))
        .then(function (res) {
          var list = extractList(res);
          if (list) myTasks = list;
        })
        .catch(function (e) {
          results.push(row('club', 'myActivityList', '', 'unknown', sanitizeError(e)));
        })
        .then(function () {
          var dates = [today];
          myTasks.forEach(function (item) {
            [item && item.nextMmdd, item && item.yymmdd].forEach(function (d) {
              var text = String(d == null ? '' : d).trim();
              if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(text)) {
                var norm = text.replace(/\//g, '-');
                if (dates.indexOf(norm) < 0) dates.push(norm);
              }
            });
          });
          var chain = Promise.resolve();
          dates.forEach(function (date) {
            chain = chain.then(function () {
              return Promise.resolve(api.club.activityList(Object.assign({ queryDate: date, pageNo: 1, pageSize: 50 }, cred)))
                .then(function (res) {
                  var list = extractList(res);
                  if (!list) return;
                  list.forEach(function (item) {
                    var id = clubActivityId(item);
                    if (id && !activityById[id]) activityById[id] = Object.assign({ __queryDate: date }, item);
                  });
                })
                .catch(function (e) {
                  results.push(row('club', 'activityList', date, 'unknown', sanitizeError(e)));
                });
            });
          });
          return chain;
        })
        .then(function () {
          var myIds = {};
          myTasks.forEach(function (item) {
            var id = clubActivityId(item);
            if (id) myIds[id] = true;
          });

          var ops = [];

          // 1) 报名：可报名(6)、关键词通过、每日成功数受 dailyJoinLimit 限制
          if (config.club.join) {
            var limit = Math.max(0, Number(config.club.dailyJoinLimit) || 0);
            var countKey = dailyKey(today, account, 'club', 'join');
            var joinedToday = dailyCount(state, countKey);
            Object.keys(activityById).forEach(function (idText) {
              var item = activityById[idText];
              var id = Number(idText);
              if (myIds[id]) return;
              if (clubEffectiveStatus(item) !== '6') return;
              if (!passesKeyword(item, config.club)) return;
              if (limit > 0 && joinedToday >= limit) return;
              joinedToday += 1;
              var key = dedupeKey({
                date: today,
                account: account,
                module: 'club',
                activityId: id,
                action: 'join',
              });
              ops.push(
                perform(
                  state,
                  {
                    key: key,
                    module: 'club',
                    action: 'join',
                    activityId: id,
                    config: config,
                    dailyKey: countKey,
                  },
                  function () {
                    return api.club.joinActivity(Object.assign({ activityId: id }, cred));
                  },
                  function (res) {
                    return !res || typeof res !== 'object' ? 'unknown' : isClubSuccess(res) ? 'success' : 'failed';
                  },
                ).then(function (r) {
                  results.push(r);
                }),
              );
            });
          }

          // 2) 签到 / 签退
          if (config.club.signIn || config.club.signOut) {
            ops.push(
              Promise.resolve(api.club.currentSignTask(cred))
                .then(function (res) {
                  return res && res.response && typeof res.response === 'object' ? res.response : null;
                })
                .catch(function () {
                  return null;
                })
                .then(function (currentTask) {
                  var inner = [];
                  myTasks.forEach(function (taskItem) {
                    var id = clubActivityId(taskItem);
                    if (!id) return;
                    var status = clubEffectiveStatus(taskItem);
                    if (status !== '1' && status !== '2') return;
                    var listed = activityById[id] || null;
                    var base = listed || taskItem;

                    // 日期来源：nextMmdd → yymmdd → 同 id 的「今天活动列表」查询日期；
                    // 不无条件用 today，避免把过期任务当成今天。
                    var dateSources = [taskItem.nextMmdd, taskItem.yymmdd];
                    if (listed && listed.__queryDate) dateSources.push(listed.__queryDate);

                    var startMs = parseClubMoment(base.startTime || taskItem.startTime, dateSources);
                    var endMs = parseClubMoment(base.endTime || taskItem.endTime, dateSources);

                    var coord = null;
                    if (currentTask && clubActivityId(currentTask) === id) {
                      coord = { lat: currentTask.latitude, lng: currentTask.longitude };
                    } else if (base.latitude != null && base.longitude != null && String(base.latitude) !== '') {
                      coord = { lat: base.latitude, lng: base.longitude };
                    }

                    var officialIn = clubSignDone(base.signInStatus || taskItem.signInStatus);
                    var officialOut = clubSignDone(base.signBackStatus || taskItem.signBackStatus);

                    if (config.club.signIn) {
                      if (startMs === null) {
                        inner.push(Promise.resolve(results.push(row('club', 'signIn', id, 'waiting-material', 'missing-date'))));
                      } else if (officialIn) {
                        results.push(row('club', 'signIn', id, 'skipped', 'already-signed-in-upstream'));
                      } else {
                        inner.push(
                          planClubSign(state, config, account, results, cred, id, 'signIn', '1', startMs, startMs + CLUB_SIGNIN_WINDOW_MIN * 60000, coord,
                            function () {
                              return true; // 签到无前置依赖
                            }),
                        );
                      }
                    }
                    if (config.club.signOut) {
                      if (endMs === null) {
                        results.push(row('club', 'signOut', id, 'waiting-material', 'missing-date'));
                      } else if (officialOut) {
                        results.push(row('club', 'signOut', id, 'skipped', 'already-signed-out-upstream'));
                      } else {
                        var inKey = dedupeKey({ date: today, account: account, module: 'club', activityId: id, action: 'signIn' });
                        inner.push(
                          planClubSign(
                            state, config, account, results, cred, id, 'signOut', '2',
                            endMs - CLUB_SIGNOUT_WINDOW_MIN * 60000, endMs, coord,
                            function () {
                              // 签退依赖：本地签到成功 或 官方已签到
                              return Boolean(state.done[inKey]) || officialIn;
                            },
                          ),
                        );
                      }
                    }
                  });
                  return Promise.all(inner);
                }),
            );
          }

          return Promise.all(ops);
        })
        .catch(function (e) {
          results.push(row('club', 'plan', '', 'unknown', sanitizeError(e)));
        });
    }

    function planClubSign(state, config, account, results, cred, id, action, signType, windowStart, windowEnd, coord, canRun) {
      var t = now();
      if (t < windowStart) {
        results.push(row('club', action, id, 'not-yet', 'before-window'));
        return Promise.resolve();
      }
      if (t > windowEnd) {
        results.push(row('club', action, id, 'expired', 'window-passed'));
        return Promise.resolve();
      }
      if (typeof canRun === 'function' && !canRun()) {
        results.push(row('club', action, id, 'waiting-material', 'need-sign-in-first'));
        return Promise.resolve();
      }
      var lat = coord && String(coord.lat == null ? '' : coord.lat).trim();
      var lng = coord && String(coord.lng == null ? '' : coord.lng).trim();
      if (!lat || !lng || Number(lat) === 0 || Number(lng) === 0) {
        results.push(row('club', action, id, 'waiting-material', 'need-coords'));
        return Promise.resolve();
      }
      var today = beijingDateString(t);
      var key = dedupeKey({ date: today, account: account, module: 'club', activityId: id, action: action });
      return perform(
        state,
        {
          key: key,
          module: 'club',
          action: action,
          activityId: id,
          config: config,
          // 真正提交前的截止校验：过了签到/签退窗口就不再提交
          deadlineMs: windowEnd,
        },
        function () {
          return api.club.signInOrSignBack({
            phone: cred.phone,
            password: cred.password,
            activityId: id,
            latitude: lat,
            longitude: lng,
            signType: signType,
          });
        },
        function (res) {
          return !res || typeof res !== 'object' ? 'unknown' : isClubSuccess(res) ? 'success' : 'failed';
        },
      ).then(function (r) {
        results.push(r);
      });
    }

    // ── 二课 ────────────────────────────────────────────────

    function planEk(state, config, results) {
      if (!config.ek.enabled) return Promise.resolve();
      var session = ekSession();
      if (!session) {
        results.push(row('ek', 'list', '', 'waiting-material', 'no-ek-session'));
        return Promise.resolve();
      }
      if (!api.ek || typeof api.ek.getActivitiesList !== 'function') {
        results.push(row('ek', 'list', '', 'failed', 'api-unavailable'));
        return Promise.resolve();
      }
      if ((config.ek.keywords || []).length === 0 && !config.ek.allowAll) {
        results.push(row('ek', 'list', '', 'waiting-material', 'need-keywords'));
        return Promise.resolve();
      }
      var account = accountFor(config, 'ek');
      var today = beijingDateString(now());
      var watched = (state.watchedEk && state.watchedEk[account]) || {};
      var candidates = {}; // id -> { item?, watched?: true }

      // 1) 列表发现（最多 5 页，避免只依赖 page1）：只收关键词命中且状态可用的
      var pages = [];
      var maxPages = Math.max(1, Math.min(5, Number(config.ek.maxPages) || 3));
      var chain = Promise.resolve();
      for (var p = 1; p <= maxPages; p += 1) {
        (function (pageIndex) {
          chain = chain.then(function () {
            return Promise.resolve(api.ek.getActivitiesList({ requestsData: session, pageIndex: pageIndex }))
              .then(function (res) {
                var items = ekListItems(res);
                if (items === null) {
                  if (pageIndex === 1) pages = null; // 首页结构不符：明确 unknown，不当空
                  return;
                }
                pages.push(items);
                items.forEach(function (item) {
                  var id = ekActivityId(item);
                  if (!id) return;
                  if (!passesKeyword(item, config.ek)) return;
                  var status = ekActivityStatus(item);
                  if (status !== '0' && status !== '1') return;
                  if (!candidates[id]) candidates[id] = {};
                  candidates[id].item = item;
                });
              })
              .catch(function (e) {
                if (pageIndex === 1) pages = null;
                results.push(row('ek', 'list', 'p' + pageIndex, 'unknown', sanitizeError(e)));
              });
          });
        })(p);
      }

      return chain
        .then(function () {
          if (pages === null) {
            results.push(row('ek', 'list', '', 'unknown', 'unexpected-list-shape'));
            return null;
          }
          // 2) 关注集合：本地 watch 的活动必须每 tick 拉详情，即使已不在列表前几页
          Object.keys(watched).forEach(function (id) {
            candidates[id] = candidates[id] || {};
            candidates[id].watched = true;
          });
          if (Object.keys(candidates).length === 0) {
            results.push(row('ek', 'list', '', 'ok', 'no-candidate'));
            return null;
          }
          // 3) 逐个处理
          var run = Promise.resolve();
          Object.keys(candidates).forEach(function (id) {
            run = run.then(function () {
              if (stopped) return null;
              return handleEkActivity(state, config, session, account, results, id, candidates[id], watched, today);
            });
          });
          return run;
        })
        .then(function () {
          // 4) 清理：已过期且两阶段都完成的 watch 项
          pruneWatchedEk(state, watched);
        })
        .catch(function (e) {
          results.push(row('ek', 'list', '', 'unknown', sanitizeError(e)));
        });
    }

    /** 单个二课活动：拉详情 → 报名（可选）→ 签到/签退 → 维护 watch */
    function handleEkActivity(state, config, session, account, results, id, candidate, watched, today) {
      return Promise.resolve(api.ek.getActivityDetail({ requestsData: session, id: id }))
        .then(function (detail) {
          var info = detail && detail.ActivityInfo && typeof detail.ActivityInfo === 'object' ? detail.ActivityInfo : null;
          if (!info) {
            results.push(row('ek', 'detail', id, 'unknown', 'missing-activity-info'));
            return null;
          }
          var applyState = ekApplyState(candidate.item || {}, detail);
          // 官方已报名 / 列表已报名 → 记入 watch，保证后续 tick 继续跟踪
          if (applyState === 'applied') {
            state.watchedEk = state.watchedEk || {};
            state.watchedEk[account] = state.watchedEk[account] || {};
            if (!state.watchedEk[account][id]) {
              state.watchedEk[account][id] = {
                name: String(info.ActivityName || ''),
                addedAt: now(),
              };
              try {
                saveState(state);
              } catch (e) {
                logger.log('[storage] watch 记录失败：' + sanitizeError(e));
              }
            }
          }
          var steps = Promise.resolve();

          // a) 报名（必须已报名窗口 StuETime 内；窗口缺失/不在窗等待，不提交）
          if (config.ek.apply && applyState === 'joinable') {
            steps = steps.then(function () {
              if (stopped) return null;
              var applyRange = parseEkRange(info.StuETime);
              if (applyRange.start === null) {
                results.push(row('ek', 'apply', id, 'waiting-material', 'missing-apply-window'));
                return null;
              }
              var nowMs = now();
              if (nowMs < applyRange.start) {
                results.push(row('ek', 'apply', id, 'not-yet', 'before-apply-window'));
                return null;
              }
              if (applyRange.end !== null && nowMs > applyRange.end) {
                results.push(row('ek', 'apply', id, 'expired', 'apply-window-passed'));
                return null;
              }
              var limit = Math.max(0, Number(config.ek.dailyLimit) || 0);
              var countKey = dailyKey(today, account, 'ek', 'apply');
              if (limit > 0 && dailyCount(state, countKey) >= limit) {
                results.push(row('ek', 'apply', id, 'skipped', 'daily-limit-reached'));
                return null;
              }
              var key = dedupeKey({ date: today, account: account, module: 'ek', activityId: id, action: 'apply' });
              return perform(
                state,
                {
                  key: key,
                  module: 'ek',
                  action: 'apply',
                  activityId: id,
                  config: config,
                  dailyKey: countKey,
                  deadlineMs: applyRange.end,
                },
                function () {
                  return api.ek.applyActivity({ requestsData: session, act_id: id });
                },
                classifyEkWrite,
              ).then(function (r) {
                results.push(r);
                if (r.status === 'success') {
                  // 报名成功立即纳入 watch（下一 tick 即使列表移页也能跟踪）
                  state.watchedEk = state.watchedEk || {};
                  state.watchedEk[account] = state.watchedEk[account] || {};
                  state.watchedEk[account][id] = { name: String(info.ActivityName || ''), addedAt: now() };
                  try {
                    saveState(state);
                  } catch (e) {
                    logger.log('[storage] watch 记录失败：' + sanitizeError(e));
                  }
                }
              });
            });
          }

          // b) 签到 / 签退
          steps = steps.then(function () {
            if (stopped) return null;
            if (!config.ek.signIn && !config.ek.signOut) return null;
            var needIn = String(info.IsNeedSignInText == null ? '' : info.IsNeedSignInText).trim() === '是';
            var needOut = String(info.IsNeedSignOutText == null ? '' : info.IsNeedSignOutText).trim() === '是';
            var signWay = info.SignWay;
            var signInDoneText = signStatusOf(info, 'SignD');
            var signOutDoneText = signStatusOf(info, 'SignT');
            var tasks = [];
            if (config.ek.signIn && needIn) {
              tasks.push({
                action: 'signIn',
                funType: 'QD',
                signWay: signWay,
                range: parseEkRange(info.ActivityQDDate),
                doneText: signInDoneText,
                signInDoneText: signInDoneText,
              });
            }
            if (config.ek.signOut && needOut) {
              tasks.push({
                action: 'signOut',
                funType: 'QT',
                signWay: signWay,
                range: parseEkRange(info.ActivityQTDate),
                doneText: signOutDoneText,
                // 签退依赖：官方 SignD，或本地签到 done；活动本身不需要签到则放行
                signInDoneText: signInDoneText,
                signInRequired: needIn,
              });
            }
            var inner = Promise.resolve();
            tasks.forEach(function (task) {
              inner = inner.then(function () {
                return planEkSign(state, config, account, results, session, id, task, applyState);
              });
            });
            return inner;
          });

          return steps;
        })
        .catch(function (e) {
          results.push(row('ek', 'detail', id, 'unknown', sanitizeError(e)));
          return null;
        });
    }

    /** 清理 watch：已过最后一阶段结束时间且都已完成的条目（避免无限增长） */
    function pruneWatchedEk(state, watched) {
      var accountIds = Object.keys(watched || {});
      if (accountIds.length === 0) return;
      var t = now();
      accountIds.forEach(function (id) {
        var entry = watched[id];
        var expireAt = Number(entry && entry.expireAt);
        if (Number.isFinite(expireAt) && expireAt > 0 && t > expireAt + 6 * 60 * 60 * 1000) {
          delete watched[id];
        }
      });
    }

    /**
     * 二课签到/签退单阶段执行。
     *
     * 关键口径：
     *  - 已完成（本地 done / 官方 SignD|SignT）→ 先短路，不消耗图库次数；
     *  - 二维码必须在「官方窗口 start + 延迟」之后才拉，且必须有明确截止（range.end），
     *    单值时间（无截止）不自动提交；
     *  - 阶段判定冲突一律拒绝；opaque 码需上传时间落在本窗口内；
     *  - 签退依赖官方 SignD 或本地签到成功；活动不需要签到则放行。
     */
    function planEkSign(state, config, account, results, session, id, task, applyState) {
      var range = task.range || { start: null, end: null };
      var today = beijingDateString(now());
      var key = dedupeKey({ date: today, account: account, module: 'ek', activityId: id, action: task.action });

      // 0) 已完成/已锁定 → 直接短路（不拉详情之外的任何接口）
      if (state.done[key]) {
        results.push(row('ek', task.action, id, 'skipped', 'already-done', { key: key }));
        return Promise.resolve();
      }
      if (state.failed[key]) {
        results.push(row('ek', task.action, id, 'blocked', 'locked-' + String(state.failed[key].status || 'failed'), { key: key }));
        return Promise.resolve();
      }
      if (range.start === null) {
        results.push(row('ek', task.action, id, 'waiting-material', 'missing-time-window'));
        return Promise.resolve();
      }
      if (range.end === null) {
        // 未声明截止：不自动提交（避免无限期自动签到）
        results.push(row('ek', task.action, id, 'waiting-material', 'missing-time-window'));
        return Promise.resolve();
      }
      var t = now();
      if (t < range.start) {
        results.push(row('ek', task.action, id, 'not-yet', 'before-window'));
        return Promise.resolve();
      }
      if (t > range.end) {
        results.push(row('ek', task.action, id, 'expired', 'window-passed'));
        return Promise.resolve();
      }
      if (applyState !== 'applied') {
        results.push(row('ek', task.action, id, 'waiting-material', 'not-applied'));
        return Promise.resolve();
      }
      var doneMark = task.action === 'signIn' ? '已签到' : '已签退';
      if (task.doneText === doneMark) {
        results.push(row('ek', task.action, id, 'skipped', 'already-done-upstream'));
        return Promise.resolve();
      }
      // 签退依赖：官方 SignD 或本地 signIn 已成功；活动不需要签到则放行
      if (task.action === 'signOut' && task.signInRequired !== false) {
        var inDone = task.signInDoneText === '已签到';
        var inKey = dedupeKey({ date: today, account: account, module: 'ek', activityId: id, action: 'signIn' });
        if (!inDone && !state.done[inKey]) {
          results.push(row('ek', 'signOut', id, 'waiting-material', 'need-sign-in-first'));
          return Promise.resolve();
        }
      }
      if (task.signWay === undefined || task.signWay === null || String(task.signWay).trim() === '') {
        results.push(row('ek', task.action, id, 'waiting-material', 'need-sign-way'));
        return Promise.resolve();
      }
      if (Number(task.signWay) !== 1) {
        results.push(row('ek', task.action, id, 'waiting-material', 'need-manual-sign-way'));
        return Promise.resolve();
      }

      // ── 延迟触发 + 有限重试（不再每 tick 拉图库） ──
      var delayMin = Math.max(0, Number(config.ek.qrDelayMinutes) || 0);
      var gateMs = range.start + delayMin * 60000;
      if (gateMs > range.end) {
        results.push(row('ek', task.action, id, 'waiting-material', 'delay-exceeds-window'));
        gateMs = range.start + Math.min(delayMin * 60000, Math.max(0, range.end - range.start - 15000));
      }
      if (t < gateMs) {
        results.push(row('ek', task.action, id, 'not-yet', 'before-qr-gate'));
        return Promise.resolve();
      }

      var usedKey = id + '|' + task.action;
      var usedImages = (state.usedImages && state.usedImages[usedKey]) || [];
      var otherKey = id + '|' + (task.action === 'signIn' ? 'signOut' : 'signIn');
      var otherUsed = (state.usedImages && state.usedImages[otherKey]) || [];
      var checksKey = dedupeKey({
        date: beijingDateString(now()),
        account: account,
        module: 'ek',
        activityId: id,
        action: 'qrChecks-' + task.funType,
      });
      state.qrChecks = state.qrChecks && typeof state.qrChecks === 'object' ? state.qrChecks : {};
      var check = state.qrChecks[checksKey] || { count: 0, lastAt: 0, imageIds: [] };
      var maxAttempts = Math.max(1, Number(config.ek.qrMaxAttempts) || 3);
      var retryMs = Math.max(0, Number(config.ek.qrRetryMinutes) || 0) * 60000;

      if (check.count >= maxAttempts) {
        results.push(row('ek', task.action, id, 'waiting-material', 'qr-attempts-exhausted'));
        return Promise.resolve();
      }
      if (check.lastAt && retryMs > 0 && t < check.lastAt + retryMs) {
        results.push(row('ek', task.action, id, 'waiting-material', 'qr-retry-pending'));
        return Promise.resolve();
      }

      // 记录本次尝试（持久化，无 token；只存次数/时间/已见 imageId）
      check.count += 1;
      check.lastAt = t;
      state.qrChecks[checksKey] = check;
      try {
        saveState(state);
      } catch (e) {
        logger.log('[storage] qrChecks 写入失败，已阻止拉取：' + sanitizeError(e));
        results.push(row('ek', task.action, id, 'blocked', 'storage-error'));
        return Promise.resolve();
      }

      return listBoundImages(id).then(function (images) {
        return pickQrCandidate(images, task, usedImages, otherUsed, range, check).then(function (picked) {
          // 把本次见到的图片 id 记入 checks（便于人工核查）
          images.forEach(function (img) {
            var iid = img && img.id != null ? String(img.id) : '';
            if (iid && check.imageIds.indexOf(iid) < 0) check.imageIds.push(iid);
          });
          try {
            saveState(state);
          } catch (e) {
            logger.log('[storage] qrChecks 更新失败：' + sanitizeError(e));
          }
          if (!picked) {
            var reason = check.count >= maxAttempts ? 'qr-attempts-exhausted' : 'need-qr-or-manual';
            results.push(row('ek', task.action, id, 'waiting-material', reason));
            return null;
          }
          var key = dedupeKey({
            date: beijingDateString(now()),
            account: account,
            module: 'ek',
            activityId: id,
            action: task.action,
          });
          return perform(
            state,
            {
              key: key,
              module: 'ek',
              action: task.action,
              activityId: id,
              config: config,
              // 真正提交前的截止校验：过了官方窗口结束就不再提交
              deadlineMs: range.end,
            },
            function () {
              return api.ek.signByQr({
                requestsData: session,
                act_id: id,
                fun_type: task.funType,
                qrcode: picked.value,
              });
            },
            classifyEkWrite,
          ).then(function (r) {
            if (r.status === 'success' && picked.imageId) {
              state.usedImages = state.usedImages || {};
              var list = state.usedImages[usedKey] || [];
              if (list.indexOf(String(picked.imageId)) < 0) list.push(String(picked.imageId));
              state.usedImages[usedKey] = list;
              try {
                saveState(state);
              } catch (e) {
                logger.log('[storage] 已用图片记录失败：' + sanitizeError(e));
              }
            }
            results.push(r);
          });
        });
      });
    }

    function listBoundImages(id) {
      if (!api.ek || typeof api.ek.activityBoundImages !== 'function') return Promise.resolve([]);
      return Promise.resolve(api.ek.activityBoundImages({ key: id }))
        .then(extractBoundImageItems)
        .catch(function () {
          return [];
        });
    }

    function imageStage(img) {
      var texts = [img && img.bind && img.bind.remark, img && img.remark, img && img.file_name]
        .filter(Boolean)
        .join(' ');
      if (/签退/.test(texts)) return 'signOut';
      if (/签到/.test(texts)) return 'signIn';
      return '';
    }

    /**
     * 图片时间解析：无时区的字符串一律按**北京时间**（+08:00）解释，
     * 不用 Date.parse 的本机时区行为。
     */
    function imageTime(img) {
      var candidates = [img && img.created_at, img && img.bind && img.bind.created_at, img && img.updated_at];
      for (var i = 0; i < candidates.length; i += 1) {
        var v = candidates[i];
        if (v === undefined || v === null || v === '') continue;
        if (typeof v === 'number') {
          if (Number.isFinite(v)) return v;
          continue;
        }
        var text = String(v).trim();
        if (/^\d{13}$/.test(text)) return Number(text);
        if (/^\d{10}$/.test(text)) return Number(text) * 1000;
        var m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(text);
        if (m) {
          var ms = beijingToMs(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0));
          if (Number.isFinite(ms)) return ms;
        }
      }
      return 0;
    }

    /**
     * 选择可用二维码候选。
     *
     * 严格口径：
     *  - metadata 与 suffix 只要指向不同阶段即冲突 → 丢弃（任何一侧冲突都算）；
     *  - 本阶段已用图、以及**另一阶段已用图**都排除（防止签到图被用于签退）；
     *  - 阶段未确认的 opaque 码（`lbUUh` 且无 metadata/后缀）只在「上传时间落在本阶段官方窗口内」
     *    时接受，避免误用旧图；无上传时间可判定 → 不作候选；
     *  - 同分优先取上传时间更新的。
     */
    function pickQrCandidate(images, task, usedImages, otherUsed, range, check) {
      var best = null;
      var chain = Promise.resolve();
      var windowStart = range && range.start != null ? range.start : 0;
      var windowEnd = range && range.end != null ? range.end : Number.MAX_SAFE_INTEGER;
      var seen = (check && check.imageIds) || [];

      images.forEach(function (img) {
        chain = chain.then(function () {
          var imageId = img && img.id != null ? String(img.id) : '';
          if (imageId && usedImages.indexOf(imageId) >= 0) return null;
          if (imageId && otherUsed && otherUsed.indexOf(imageId) >= 0) return null;
          var stage = imageStage(img);
          var url = img && (img.file_url || img.thumb_url);
          if (!url) return null;
          var uploadedAt = imageTime(img);
          return Promise.resolve()
            .then(function () {
              return decodeQr(url);
            })
            .then(function (text) {
              var value = String(text == null ? '' : text).trim();
              if (!isValidEkQr(value)) return null;
              var hasQd = /QD$/.test(value);
              var hasQt = /QT$/.test(value);
              var suffixStage = hasQd ? 'signIn' : hasQt ? 'signOut' : '';

              // 任何冲突都拒绝（metadata 与 suffix 互相矛盾，或指向其他阶段）
              if (stage && suffixStage && stage !== suffixStage) return null;
              if (stage && stage !== task.action) return null;
              if (!stage && suffixStage && suffixStage !== task.action) return null;

              var confirmed = Boolean(stage || suffixStage);
              if (!confirmed) {
                // opaque 码：必须有可判定、且落在本阶段窗口内的上传时间
                if (!uploadedAt) return null;
                if (uploadedAt < windowStart || uploadedAt > windowEnd) return null;
              }

              var score = 0;
              if (stage === task.action) score += 6;
              if (suffixStage === task.action) score += 4;
              if (!confirmed) score += 1;
              if (imageId && seen.indexOf(imageId) < 0) score += 1; // 优先没见过的图
              var candidate = { value: value, imageId: imageId, score: score, time: uploadedAt };
              if (!best || candidate.score > best.score || (candidate.score === best.score && candidate.time > best.time)) {
                best = candidate;
              }
              return null;
            })
            .catch(function () {
              return null;
            });
        });
      });
      return chain.then(function () {
        return best;
      });
    }

    // ── 对外 ────────────────────────────────────────────────

    function runInternal(preview) {
      // 单飞：并发调用直接返回 busy，绝不两个 state 同时提交
      if (running) {
        return Promise.resolve({
          busy: true,
          results: [row('engine', 'run', '', 'blocked', 'already-running')],
          summary: { total: 1, success: 0, failed: 0, unknown: 0, waiting: 1, dryRun: 0, skipped: 0 },
          dryRun: true,
          at: now(),
        });
      }
      running = true;
      stopped = false;
      previewMode = Boolean(preview);
      var config = getConfig();
      if (preview) config = mergeConfig(config, { dryRun: true });
      var results = [];
      var state = null;

      var start;
      try {
        state = loadState();
        start = Promise.resolve();
      } catch (e) {
        previewMode = false;
        results.push(row('state', 'load', '', 'blocked', 'state-corrupt'));
        logger.log('[state] 去重状态损坏，已禁止自动写，请核查：' + sanitizeError(e));
        running = false;
        return Promise.resolve({
          results: results,
          summary: { total: 1, success: 0, failed: 0, unknown: 0, waiting: 1, dryRun: 0, skipped: 0 },
          dryRun: Boolean(config.dryRun),
          stateCorrupt: true,
          at: now(),
        });
      }

      return start
        .then(function () {
          return planUnirun(state, config, results);
        })
        .then(function () {
          if (stopped) return null;
          return planClub(state, config, results);
        })
        .then(function () {
          if (stopped) return null;
          return planEk(state, config, results);
        })
        .catch(function (e) {
          results.push(row('engine', 'run', '', 'unknown', sanitizeError(e)));
        })
        .then(function () {
          var summary = { total: results.length, success: 0, failed: 0, unknown: 0, waiting: 0, dryRun: 0, skipped: 0 };
          results.forEach(function (r) {
            if (r.status === 'success') summary.success += 1;
            else if (r.status === 'failed') summary.failed += 1;
            else if (r.status === 'unknown') summary.unknown += 1;
            else if (r.status === 'waiting-material' || r.status === 'blocked') summary.waiting += 1;
            else if (r.status === 'dry-run') summary.dryRun += 1;
            else summary.skipped += 1;
          });
          var stamped = results.slice().sort(function (a, b) {
            return String(a.module + a.activityId + a.action).localeCompare(String(b.module + b.activityId + b.action));
          });
          stamped.forEach(function (r) {
            r.at = now();
          });
          running = false;
          previewMode = false;
          return { results: stamped, summary: summary, dryRun: Boolean(config.dryRun), at: now() };
        });
    }

    return {
      preview: function () {
        return runInternal(true);
      },
      runOnce: function () {
        return runInternal(false);
      },
      stop: function () {
        stopped = true;
      },
      isRunning: function () {
        return running;
      },
      getConfig: getConfig,
      setConfig: setConfig,
      getProfiles: function () {
        var ek = ekSession();
        var u = resolveAccount(getConfig());
        var accounts = accountsState();
        return {
          ekAccount: ek && ek.user_info && ek.user_info.loginName ? String(ek.user_info.loginName) : '',
          unirunPhone: u ? String(u.phone).replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2') : '',
          unirunAccounts: accounts.items.map(function (a) {
            return { id: a.id, remark: a.remark, selected: a.id === (u && u.id) };
          }),
        };
      },
      resetState: function () {
        saveState({ done: {}, inflight: {}, failed: {}, usedImages: {}, daily: {}, qrChecks: {}, watchedEk: {} });
      },
    };
  }

  return {
    DEFAULTS: DEFAULTS,
    STATE_KEY: STATE_KEY,
    CONFIG_KEY: CONFIG_KEY,
    KEYS: { ekSession: EK_KEY, unirunAccounts: UNIRUN_ACCOUNTS_KEY },
    EK_SIGN_WAY_LABEL: EK_SIGN_WAY_LABEL,
    CLUB_SIGNIN_WINDOW_MIN: CLUB_SIGNIN_WINDOW_MIN,
    CLUB_SIGNOUT_WINDOW_MIN: CLUB_SIGNOUT_WINDOW_MIN,
    StorageError: StorageError,
    createEngine: createEngine,
    mergeConfig: mergeConfig,
    beijingParts: beijingParts,
    beijingDateString: beijingDateString,
    beijingMinuteOfDay: beijingMinuteOfDay,
    parseHhmm: parseHhmm,
    parseMoment: parseMoment,
    parseEkRange: parseEkRange,
    parseClubMoment: parseClubMoment,
    isValidEkQr: isValidEkQr,
    dedupeKey: dedupeKey,
    isClubSuccess: isClubSuccess,
    isUnirunSuccess: isUnirunSuccess,
    classifyEkWrite: classifyEkWrite,
    ekListItems: ekListItems,
    ekActivityId: ekActivityId,
    ekActivityStatus: ekActivityStatus,
    ekApplied: ekApplied,
    ekApplyState: ekApplyState,
    signStatusOf: signStatusOf,
    clubActivityId: clubActivityId,
    clubEffectiveStatus: clubEffectiveStatus,
    clubSignDone: clubSignDone,
    extractList: extractList,
    extractBoundImageItems: extractBoundImageItems,
    keywordMatch: keywordMatch,
    passesKeyword: passesKeyword,
  };
});
