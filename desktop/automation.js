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

  /**
   * 积分策略模块依赖：
   *  - 浏览器：先加载 score-policy.js（window.Auto3CTScorePolicy）
   *  - Node：require('./score-policy.js')
   * 缺失时引擎不崩溃：策略视为不可信（只阻断新增报名，不影响已报名签到签退）。
   */
  var ScorePolicy = (function () {
    try {
      if (typeof require === 'function') {
        var m = require('./score-policy.js');
        if (m && m.MODULES) return m;
      }
    } catch (e) {
      /* 浏览器环境无 require */
    }
    var g = typeof globalThis !== 'undefined' ? globalThis : null;
    if (g && g.Auto3CTScorePolicy) return g.Auto3CTScorePolicy;
    return null;
  })();

  var STATE_KEY = 'auto3ct:state';
  var CONFIG_KEY = 'auto3ct:config';
  /** 积分进度独立存储（按账号隔离）：{version:1, accounts:{[accountId]:{snapshot,refreshedAt,lastRefreshError}}} */
  var SCORES_KEY = 'auto3ct:scores';

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
      /**
       * 有效窗口（分钟）。
       *  - 显式配置（有效数字）→ 用它（向后兼容旧配置/旧测试/手填）；
       *  - 未配置（null/''/undefined）→ 每天从 [windowMinutesMin, windowMinutesMax] 随机取一个，
       *    默认 39~48 分钟；当天固定（持久化在 state.unirunWindow），跨天重新随机。
       */
      windowMinutes: null,
      windowMinutesMin: 39,
      windowMinutesMax: 48,
      /**
       * 里程（米）。
       *  - 显式配置（有效数字）→ 用它（向后兼容旧配置/旧测试/手填）；
       *  - 未配置（null/''/undefined）→ 每天从 [runDistanceMin, runDistanceMax] 随机取一个整数，
       *    默认 1000~1099，且**末位不得为 0**（1000/1100 这类整数会被上游判为异常直接作废）；
       *    当天固定（持久化在 state.unirunDistance），跨天重新随机。
       */
      runDistance: null,
      runDistanceMin: 1000,
      runDistanceMax: 1099,
      /**
       * 时长（分钟）。
       *  - 显式配置（有效数字）→ 用它（向后兼容旧配置/旧测试/手填）；
       *  - 未配置（null/''/undefined）→ 每天从 [runTimeMin, runTimeMax] 随机取整数，
       *    默认 31~39，且**不能是 5 的倍数**（30/35/40 这类整 5 会被上游判为异常）；
       *    当天固定（持久化在 state.unirunTime），跨天重新随机。
       */
      runTime: null,
      runTimeMin: 31,
      runTimeMax: 39,
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
      /**
       * 拍照 / 定位+拍照签到自动提交（默认开）。
       *  - true  ：SignWay=2/3 走 `StuSaveSignIn`，照片取图库（非官方域名先上传），
       *            坐标取活动详情中心点；图库无图时按空照片提交。
       *  - false ：退回 `need-manual-sign-way`，只等人手工签到。
       * 服务端在该端点不校验照片/坐标（与 SignWay=1 无码直签同一口径）。
       */
      photoSign: true,
      /**
       * 是否向 3CT 社区后端图库（api.3ct.f.can6.top/api/ek/...）拉图。
       *  - 默认 false：该接口需要 3CT 账号 token（无 token 401），而 1CT 不接 3CT 登录；
       *    签到本身不依赖它（扫码走无码直签、拍照/定位走内置兜底图），关掉可避免无谓的第三方请求。
       *  - true：若将来接回 3CT 账号，可恢复社区图库（二维码 / 现场图）。
       */
      backendGallery: false,
      /**
       * 签到码活动（SignWay=4 = 现场验证码/签到码，极少使用）**不报名**（默认开）。
       * 用户明确要求：遇到这种二课活动直接跳过，不要报名。
       * false 时恢复旧行为（照常报名，签到阶段等人工）。
       */
      skipSignWay4: true,
      /**
       * 积分缺口策略（默认启用）：
       *  - 未导入/未刷新出可信 snapshot 前，阻断「新增报名」（已报名 watch 仍继续签到签退）
       *  - 模块达标后不再新增该模块报名
       *  - 未知类别 fail-closed
       */
      scorePolicy: {
        enabled: true,
        snapshot: null,
        staleMs: 24 * 60 * 60 * 1000,
        refreshIntervalMs: 60 * 60 * 1000,
        refreshOnStart: true,
        moduleOptions: [],
      },
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

  /** 二课签到/签退窗口的「最后截止时间」：QD/QT 两个官方窗口 end 的最大值；都没有 → 0 */
  function ekSignExpireAt(info) {
    var qd = parseEkRange(info && info.ActivityQDDate);
    var qt = parseEkRange(info && info.ActivityQTDate);
    var ends = [];
    if (qd.end !== null) ends.push(qd.end);
    if (qt.end !== null) ends.push(qt.end);
    if (ends.length === 0) return 0;
    return Math.max.apply(null, ends);
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

  /**
   * 列表层面的「已报名」判定：只认官方 ActivityStatus==='1'。
   * 注意：不再把 item.ApplyInfo 的存在当作已报名 —— 模板 ApplyInfo 会被误判（task-12）。
   * 需 detail 证据时用 ekApplyState()。
   */
  function ekApplied(item) {
    return ekActivityStatus(item) === '1';
  }

  function signStatusOf(info, key) {
    var listInfo = info && info.ActivityListInfo;
    if (!listInfo || typeof listInfo !== 'object') return '';
    var signInfo = listInfo.ActivitySignInfo;
    if (!signInfo || typeof signInfo !== 'object') return '';
    return String(signInfo[key] == null ? '' : signInfo[key]).trim();
  }

  /**
   * 报名状态判定（task-12 修正，状态优先级）：
   *  1. 列表官方 `ActivityStatus==='1'` → applied（最高优先）
   *  2. 列表官方 `ActivityStatus==='0'` → joinable（**可报名优先，绝不被模板 ApplyInfo 覆盖**）
   *  3. 列表状态缺失/unknown 时才 fallback 到 detail.ApplyInfo，且要求可信证据：
   *     - `Id` 非空、非全零 GUID 占位、非全零数字
   *     - 且 `ActivityId` 可信（非空、非占位、且等于当前活动 id）
   *     - 空对象 `{}` / 模板默认字段绝不当作已报名
   *  4. 其余 → unknown（不猜、不自动报名/签到）
   *
   * 不要求 Id 必须是 GUID（旧数据里 numeric id 也合法）。
   */
  function ekApplyState(item, detail, activityId) {
    var listStatus = ekActivityStatus(item);
    if (listStatus === '1') return 'applied';
    if (listStatus === '0') return 'joinable';

    // 列表状态缺失：才需要 detail 证据
    var applyInfo = detail && detail.ApplyInfo;
    if (applyInfo && typeof applyInfo === 'object') {
      var idText = applyInfo.Id != null ? String(applyInfo.Id).trim() : '';
      var actText = applyInfo.ActivityId != null ? String(applyInfo.ActivityId).trim() : '';
      var expectedId = activityId != null ? String(activityId).trim() : '';

      var idUsable = isTrustedIdentifier(idText);
      var actMatches = isTrustedIdentifier(actText) ? (!expectedId || actText === expectedId) : false;

      if (idUsable && actMatches) return 'applied';
      if (idText || actText) return 'unknown'; // 有字段但证据不可信：不猜
      if (Object.keys(applyInfo).length > 0) return 'unknown'; // 模板字段但无 Id：不猜
      // 完全空对象 {}：不是已报名证据
    }
    return 'unknown';
  }

  /** 全零 GUID / 全零数字等占位符不算可信标识 */
  function isTrustedIdentifier(value) {
    var v = String(value == null ? '' : value).trim();
    if (!v) return false;
    if (/^0+$/.test(v)) return false;
    if (/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(v)) return false;
    if (/^[0-]+$/.test(v)) return false;
    return true;
  }

  /** detail.ApplyInfo 是否含「非占位 Id」——用于诊断字段 hasApplyId */
  function hasUsableApplyId(applyInfo) {
    if (!applyInfo || typeof applyInfo !== 'object') return false;
    return isTrustedIdentifier(applyInfo.Id);
  }

  /** detail.ApplyInfo 是否只是模板/占位（无有效报名证据） */
  function isPlaceholderApplyInfo(applyInfo) {
    if (!applyInfo || typeof applyInfo !== 'object') return false;
    var idText = applyInfo.Id != null ? String(applyInfo.Id).trim() : '';
    var actText = applyInfo.ActivityId != null ? String(applyInfo.ActivityId).trim() : '';
    return !isTrustedIdentifier(idText) && !isTrustedIdentifier(actText);
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
    /**
     * 随机源（可注入，便于测试边界与稳定性）：
     *  - 默认 Math.random；
     *  - 注入非函数 → 回落 Math.random（不让错误注入把引擎打挂）；
     *  - 返回非有限数/越界 → resolveUnirunWindow 内部做区间兜底裁剪。
     */
    var random = typeof opts.random === 'function' ? opts.random : Math.random;
    opts.random = random;
    var runtimeConfig = mergeConfig(DEFAULTS, opts.config || {});
    var stopped = false;
    var running = false;
    /** 最近一次二课扫描汇总（safe 字段，供日志/看板展示为什么没报名） */
    var lastEkScan = null;
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
        return {
          done: {},
          inflight: {},
          failed: {},
          usedImages: {},
          daily: {},
          qrChecks: {},
          photoChecks: {},
          watchedEk: {},
          // 已结束的二课活动归档（跨 tick / 跨进程持久）：{ [account]: { [activityId]: {at, expireAt} } }
          ekFinished: {},
          unirunWindow: {},
          unirunDistance: {},
          unirunTime: {},
        };
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
        // 拍照/定位签到尝试计数（与二维码分开记账）：{ [key]: {count,lastAt} }
        photoChecks: s.photoChecks && typeof s.photoChecks === 'object' ? s.photoChecks : {},
        // 关注中的二课活动（跨 tick / 跨进程持久）：{ [account]: { [activityId]: {name, addedAt, expireAt?} } }
        watchedEk: s.watchedEk && typeof s.watchedEk === 'object' ? s.watchedEk : {},
        // 已结束的二课活动归档（各签到/签退窗口都已结束）：{ [account]: { [activityId]: {at, expireAt} } }
        ekFinished: s.ekFinished && typeof s.ekFinished === 'object' ? s.ekFinished : {},
        // 校园跑当天随机窗口（跨 tick 固定）：{ '<date>|<account>': minutes }
        unirunWindow: s.unirunWindow && typeof s.unirunWindow === 'object' ? s.unirunWindow : {},
        // 校园跑当天随机里程（跨 tick 固定）：{ '<date>|<account>': meters }
        unirunDistance: s.unirunDistance && typeof s.unirunDistance === 'object' ? s.unirunDistance : {},
        // 校园跑当天随机时长（跨 tick 固定）：{ '<date>|<account>': minutes }
        unirunTime: s.unirunTime && typeof s.unirunTime === 'object' ? s.unirunTime : {},
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
        photoChecks: state.photoChecks || {},
        watchedEk: state.watchedEk || {},
        // 已结束活动归档：随 state 一起持久化（预览模式被 previewMode 拦住，不落盘）
        ekFinished: state.ekFinished || {},
        unirunWindow: state.unirunWindow || {},
        unirunDistance: state.unirunDistance || {},
        unirunTime: state.unirunTime || {},
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

    // ── 积分缺口策略（二课） ────────────────────────────────

    /** 读积分存储：{version:1, accounts:{[accountId]:{snapshot, refreshedAt, lastRefreshError}}} */
    function loadScores() {
      var raw = null;
      try {
        raw = readJson(SCORES_KEY);
      } catch (e) {
        // 损坏不阻断签到签退，但不得用于放行新增报名
        return { version: 1, accounts: {}, corrupt: true };
      }
      if (!raw || typeof raw !== 'object' || !raw.accounts || typeof raw.accounts !== 'object') {
        return { version: 1, accounts: {} };
      }
      return { version: 1, accounts: raw.accounts };
    }

    function saveScores(scores) {
      if (previewMode) return;
      writeJson(SCORES_KEY, { version: 1, accounts: scores.accounts || {} });
    }

    function currentEkAccount() {
      var ek = ekSession();
      var loginName = ek && ek.user_info && ek.user_info.loginName;
      return loginName ? String(loginName) : '';
    }

    /** 取当前账号的 snapshot 记录 */
    function scoreEntry(scores, accountId) {
      if (!accountId) return null;
      var entry = scores.accounts[accountId];
      if (!entry || typeof entry !== 'object') return null;
      return entry;
    }

    /**
     * 当前生效 snapshot：只认 store（按账号隔离）。
     * config.ek.scorePolicy.snapshot 仅作为「store 尚无记录时的一次性 seed」，
     * 一旦 store 有记录（手动导入/官方刷新），一切以 store 为准，避免旧注入挡住最新数据。
     */
    function effectiveSnapshot(config) {
      var account = currentEkAccount();
      var scores = loadScores();
      var entry = scoreEntry(scores, account);
      if (entry && entry.snapshot) return entry.snapshot;
      var seed = config.ek && config.ek.scorePolicy && config.ek.scorePolicy.snapshot;
      return seed || null;
    }

    /**
     * 计算当前策略（含 stale/accountMatch 元数据）。
     * 依赖缺失或异常时返回安全的 unavailable 元数据，绝不 throw（暴露给 UI 的状态接口必须安全）。
     */
    function buildPolicy(config) {
      var cfg = (config.ek && config.ek.scorePolicy) || DEFAULTS.ek.scorePolicy;
      var account = currentEkAccount();
      var snapshot = null;
      try {
        snapshot = effectiveSnapshot(config);
      } catch (e) {
        snapshot = null;
      }
      if (!ScorePolicy) {
        return {
          enabled: cfg.enabled !== false,
          trusted: false,
          accountMatch: false,
          stale: true,
          reason: 'score-policy-unavailable',
          accountId: account,
          source: 'unknown',
          refreshedAt: null,
          totalGap: null,
          gaps: [],
          satisfiedModules: [],
        };
      }
      var policy;
      try {
        policy = ScorePolicy.evaluatePolicy({
          snapshot: snapshot,
          accountId: account,
          now: now(),
          staleMs: cfg.staleMs,
          enabled: cfg.enabled !== false,
        });
      } catch (e) {
        return {
          enabled: cfg.enabled !== false,
          trusted: false,
          accountMatch: false,
          stale: true,
          reason: 'score-policy-error',
          accountId: account,
          source: 'unknown',
          refreshedAt: null,
          totalGap: null,
          gaps: [],
          satisfiedModules: [],
        };
      }
      policy.accountId = account;
      policy.refreshedAt = snapshot && Number(snapshot.updatedAt) ? Number(snapshot.updatedAt) : null;

      /**
       * 官方刷新失败（最近一次尝试失败）：即使旧 snapshot 的 updatedAt 仍在 24h 内，
       * 也不得视为可信 —— 否则「刷新失败却继续放新报名」违背 fail-closed 口径。
       * 手动重新导入 / 下一次成功刷新会清掉 lastRefreshError 自动恢复。
       * 注意：只影响「新增报名」判定；已报名活动的 watch 签到/签退不受影响。
       */
      try {
        var entry = scoreEntry(loadScores(), account) || {};
        if (entry.lastRefreshError) {
          policy.trusted = false;
          policy.stale = true;
          policy.reason = 'score-refresh-failed';
        }
      } catch (e) {
        policy.trusted = false;
        policy.stale = true;
        policy.reason = 'score-refresh-failed';
      }

      return policy;
    }

    /**
     * 活动类别解析（严格）：detail.ModuleCodeText 精确优先；
     * 否则用列表 ModuleCode 在官方 ModuleCodeList（per-run 捕获，其次 config）里 value→label 精确映射。
     * 绝不凭标题/字母猜。
     */
    function resolveCategory(config, detailInfo, listItem, runModuleOptions) {
      if (!ScorePolicy) return { category: null, reason: 'policy-unavailable', via: null };
      var cfg = (config.ek && config.ek.scorePolicy) || DEFAULTS.ek.scorePolicy;
      var options = Array.isArray(runModuleOptions) && runModuleOptions.length > 0
        ? runModuleOptions
        : Array.isArray(cfg.moduleOptions)
          ? cfg.moduleOptions
          : [];
      // 官方 ModuleCodeList 也可能出现在详情里（兼容两种来源，仍要求 label/value 精确）
      if (options.length === 0 && detailInfo && Array.isArray(detailInfo.ModuleCodeList)) {
        options = detailInfo.ModuleCodeList.map(function (it) {
          var label = String(it && (it.label != null ? it.label : it.Label != null ? it.Label : '')).trim();
          var value = String(it && (it.value != null ? it.value : it.Value != null ? it.Value : '')).trim();
          return { label: label, value: value };
        }).filter(function (o) { return o.label && o.value; });
      }
      return ScorePolicy.resolveActivityCategory({
        detailInfo: detailInfo,
        listItem: listItem,
        moduleOptions: options,
      });
    }

    /** 针对某个模块类别的报名闸门 */
    function scoreGateForCategory(config, category) {
      if (!ScorePolicy) return { allow: false, reason: 'score-policy-unavailable' };
      var cfg = (config.ek && config.ek.scorePolicy) || DEFAULTS.ek.scorePolicy;
      if (cfg.enabled === false) return { allow: true, reason: 'policy-disabled' };
      var policy = buildPolicy(config);
      return ScorePolicy.canApplyCategory(policy, category);
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
      /**
       * 所有结果行（含 skipped/dry-run/blocked 等提前返回）都带上本次窗口值，
       * 便于日志/看板排查「为什么今天 08:10 就 expired 了」——
       * 窗口是随机的，不显示窗口值就无法解释 deadline/expired 判定。
       */
      var baseExtra = { key: key };
      if (meta.windowMinutes !== undefined) baseExtra.windowMinutes = meta.windowMinutes;

      if (state.done[key]) {
        return Promise.resolve(row(meta.module, meta.action, meta.activityId, 'skipped', 'already-done', baseExtra));
      }
      var locked = state.failed[key];
      if (locked) {
        return Promise.resolve(
          row(meta.module, meta.action, meta.activityId, 'blocked', 'locked-' + String(locked.status || 'failed'), baseExtra),
        );
      }
      if (state.inflight[key]) {
        return Promise.resolve(row(meta.module, meta.action, meta.activityId, 'blocked', 'previous-result-unknown', baseExtra));
      }
      if (config.dryRun) {
        return Promise.resolve(row(meta.module, meta.action, meta.activityId, 'dry-run', 'preview-only', baseExtra));
      }
      if (stopped) {
        return Promise.resolve(row(meta.module, meta.action, meta.activityId, 'skipped', 'stopped', baseExtra));
      }
      // 二次策略闸门（仅真实提交前；preview 已在上面返回）
      if (typeof meta.preSubmitGate === 'function') {
        var gateReason = null;
        try {
          gateReason = meta.preSubmitGate();
        } catch (e) {
          gateReason = 'score-policy-error';
        }
        if (gateReason) {
          return Promise.resolve(row(meta.module, meta.action, meta.activityId, 'blocked', gateReason, baseExtra));
        }
      }

      // fail-closed：inflight 必须先落盘成功
      state.inflight[key] = now();
      try {
        saveState(state);
      } catch (e) {
        delete state.inflight[key];
        logger.log('[storage] inflight 写入失败，已阻止提交：' + sanitizeError(e));
        return Promise.resolve(
          row(meta.module, meta.action, meta.activityId, 'blocked', 'storage-error', baseExtra),
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
        return Promise.resolve(row(meta.module, meta.action, meta.activityId, 'skipped', 'stopped', baseExtra));
      }
      if (typeof meta.deadlineMs === 'number' && now() > meta.deadlineMs) {
        delete state.inflight[key];
        try {
          saveState(state);
        } catch (e) {
          /* 已尽力 */
        }
        return Promise.resolve(row(meta.module, meta.action, meta.activityId, 'skipped', 'past-deadline', baseExtra));
      }

      return Promise.resolve()
        .then(submit)
        .then(function (res) {
          var verdict = classify(res);
          delete state.inflight[key];
          /**
           * 可重试失败（meta.retryableFailed）：
           * 签到码是**会滚动**的二维码，图库里那一张可能已经过期，服务端会拒绝。
           * 这种「码不对」不是终态，不应永久锁死当天任务，否则换到新码也签不上。
           * 重试次数由各自的 checks 计数器（qrChecks/photoChecks）收敛，
           * 不会无限重试爆量；unknown（结果不确定）仍然锁死，避免重复提交。
           */
          if (verdict === 'success') {
            state.done[key] = now();
            if (meta.dailyKey) dailyAdd(state, meta.dailyKey);
          } else if (verdict === 'failed' && meta.retryableFailed) {
            // 不写 state.failed：下一 tick 允许用新码/新图重试
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
          emitResult(meta, status, reason);
          // 合并 meta 中的安全诊断字段，便于日志定位
          var diagExtra = { key: key };
          ['accountId', 'activityName', 'category', 'listStatus', 'classify', 'decision', 'scoreGate', 'applyWindowStart', 'applyWindowEnd', 'stage', 'distanceMeters', 'windowMinutes', 'runTime', 'signWay', 'photo', 'captchaFrom'].forEach(function (k) {
            if (meta[k] !== undefined) diagExtra[k] = meta[k];
          });
          if (status === 'success') diagExtra.decision = 'applicable';
          return row(meta.module, meta.action, meta.activityId, status, reason, diagExtra);
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
          // 固定文案：不把原始异常拼进结果/历史（避免潜在敏感内容外泄）
          emitResult(meta, 'unknown', 'submission-result-unknown');
          return row(meta.module, meta.action, meta.activityId, 'unknown', 'submission-result-unknown', { key: key });
        });
    }

    /**
     * 结果事件回调（供 result-store 做历史/看板）。
     * 只在**真实提交定论**后触发：dry-run / skipped / blocked / waiting 都不触发。
     * 行内绝不含 payload / token / 密码 / 完整手机号。
     */
    function emitResult(meta, status, reason) {
      if (typeof opts.onResult !== 'function') return;
      try {
        var event = {
          key: meta.key,
          // 账号取 meta 快照（避免运行期间切换账号导致结果挂错账号）
          accountId: String(meta.accountId || ''),
          activityId: meta.activityId == null ? '' : String(meta.activityId),
          activityName: String(meta.activityName || ''),
          category: String(meta.category || ''),
          module: meta.module,
          action: meta.action,
          status: status,
          reason: reason || '',
          at: now(),
          dryRun: false,
        };
        if (meta.stage) event.stage = String(meta.stage);
        if (typeof meta.distanceMeters === 'number') event.distanceMeters = meta.distanceMeters;
        opts.onResult(event);
      } catch (e) {
        // 回调异常绝不影响业务结果
        logger.log('[onResult] 回调失败');
      }
    }

    // ── 校园跑 ──────────────────────────────────────────────

    /**
     * 当天「有效窗口」随机值的 state 键：`<date>|<account>`。
     * 用账号隔离，避免多账号共用同一随机窗口；日期变化即天然失效（跨天重新随机）。
     */
    function unirunWindowStateKey(dateStr, account) {
      return String(dateStr) + '|' + String(account || 'local');
    }

    /**
     * 解析本次运行应使用的有效窗口（分钟）。
     *
     * 优先级与口径：
     *  1. `config.unirun.windowMinutes` 显式为有效数字 → 直接用它（向后兼容手填/旧配置/旧测试）。
     *     显式配置不落 state：它是确定值，且用户改配置应立即生效。
     *  2. 否则用 `[windowMinutesMin, windowMinutesMax]`（默认 39~48）随机取一个整数：
     *     - **当天固定**：随机值持久化到 `state.unirunWindow[<date>|<account>]`，
     *       同一天同一账号重复 tick 复用同一个值（否则每 tick 重随机会让「已过期窗口」变回有效，
     *       或让原本有效的窗口提前失效，去重/截止判断都会失真）；
     *     - 跨天用新日期键 → 自然重新随机。
     *  3. 随机值**必须在提交前落盘成功**：这是「当天固定」的唯一保证，
     *     写失败按现有 fail-closed 口径处理（不提交，返回 storage-error）。
     *
     * @returns {{ok:boolean, windowMinutes?:number, reason?:string, persisted?:boolean}}
     *   ok:false + reason：'invalid-window'（配置非法）/ 'storage-error'（随机值落盘失败）
     */
    function resolveUnirunWindow(state, config, account) {
      var u = config.unirun || {};

      // 1) 显式配置优先（有效数字才认；'' / null / undefined 视为未配置）
      var explicitRaw = u.windowMinutes;
      var explicit = null;
      if (explicitRaw !== null && explicitRaw !== undefined && String(explicitRaw).trim() !== '') {
        explicit = numInRange(explicitRaw, 1, 720);
        if (explicit === null) {
          // 显式给了但非法：明确失败，不悄悄回落到随机（否则用户以为设了 0 却照跑）
          return { ok: false, reason: 'invalid-window' };
        }
        return { ok: true, windowMinutes: explicit, persisted: false };
      }

      // 2) 随机范围校验（只校验真正要用到的路径）
      var minRaw = u.windowMinutesMin === undefined || u.windowMinutesMin === null
        ? DEFAULTS.unirun.windowMinutesMin
        : u.windowMinutesMin;
      var maxRaw = u.windowMinutesMax === undefined || u.windowMinutesMax === null
        ? DEFAULTS.unirun.windowMinutesMax
        : u.windowMinutesMax;
      var minMinute = numInRange(minRaw, 1, 720);
      var maxMinute = numInRange(maxRaw, 1, 720);
      if (minMinute === null || maxMinute === null || minMinute > maxMinute) {
        return { ok: false, reason: 'invalid-window' };
      }
      minMinute = Math.round(minMinute);
      maxMinute = Math.round(maxMinute);
      if (minMinute > maxMinute) return { ok: false, reason: 'invalid-window' };

      // 3) 当天固定：已有持久值直接复用
      var dateStr = beijingDateString(now());
      var stateKey = unirunWindowStateKey(dateStr, account);
      state.unirunWindow = state.unirunWindow && typeof state.unirunWindow === 'object' ? state.unirunWindow : {};
      var cached = numInRange(state.unirunWindow[stateKey], 1, 720);
      if (cached !== null) {
        return { ok: true, windowMinutes: Math.round(cached), persisted: false };
      }

      // 4) 首次随机：整数落在 [min, max] 闭区间
      var span = maxMinute - minMinute + 1;
      var rand = typeof opts.random === 'function' ? opts.random() : Math.random();
      var unit = Number(rand);
      if (!Number.isFinite(unit) || unit < 0) unit = 0;
      if (unit >= 1) unit = 0.9999999999; // random() 返回 1 的极端实现也不越界
      var picked = minMinute + Math.floor(unit * span);
      if (picked < minMinute) picked = minMinute;
      if (picked > maxMinute) picked = maxMinute;

      // 5) fail-closed：随机值必须先落盘成功，才能作为「当天固定值」使用
      state.unirunWindow[stateKey] = picked;
      if (previewMode) {
        // 预览不落盘（与 saveState 一致）：用本次随机值做预览展示，不污染真实 state
        return { ok: true, windowMinutes: picked, persisted: false, preview: true };
      }
      try {
        saveState(state);
      } catch (e) {
        // 回滚内存态，避免「内存有值、磁盘没值」导致同进程内后续 tick 与重启后行为不一致
        delete state.unirunWindow[stateKey];
        logger.log('[storage] 校园跑随机窗口落盘失败，已阻止本轮提交：' + sanitizeError(e));
        return { ok: false, reason: 'storage-error' };
      }
      logger.log('[unirun] 今日有效窗口随机为 ' + picked + ' 分钟（' + minMinute + '~' + maxMinute + '）');
      return { ok: true, windowMinutes: picked, persisted: true };
    }

    /**
     * 当天「里程（米）」随机值的 state 键：`<date>|<account>`（与窗口同一口径，账号隔离）。
     */
    function unirunDistanceStateKey(dateStr, account) {
      return String(dateStr) + '|' + String(account || 'local');
    }

    /**
     * 末位数不能为 0：上游会把 1000/1100 这类整数里程判为异常直接作废，
     * 所以随机值必须"带个位数"（如 1043 / 987 / 1096）。
     * 在 [min,max] 闭区间内随机，若刚好落在 10 的倍数上则平移 1 米修正（仍在区间内）。
     */
    function pickDistanceWithOnesDigit(minM, maxM) {
      var span = maxM - minM + 1;
      var rand = typeof opts.random === 'function' ? opts.random() : Math.random();
      var unit = Number(rand);
      if (!Number.isFinite(unit) || unit < 0) unit = 0;
      if (unit >= 1) unit = 0.9999999999;
      var picked = minM + Math.floor(unit * span);
      if (picked < minM) picked = minM;
      if (picked > maxM) picked = maxM;
      if (picked % 10 === 0) {
        // 优先 +1（区间内），否则 -1；两端都被占满时说明区间退化，直接用原值
        if (picked + 1 <= maxM) picked += 1;
        else if (picked - 1 >= minM) picked -= 1;
      }
      return picked;
    }

    /**
     * 解析本次运行应使用的里程（米）。
     *
     * 优先级与口径：
     *  1. `config.unirun.runDistance` 显式为有效数字 → 直接用它（向后兼容手填/旧配置/旧测试）。
     *  2. 否则用 `[runDistanceMin, runDistanceMax]`（默认 1000~1099）随机取整数：
     *     - **末位不得为 0**：上游把 1000/1100 这类整数里程判为异常直接作废；随机到 10 的倍数会平移 1 米；
     *     - **当天固定**：持久化到 `state.unirunDistance[<date>|<account>]`，同一天同一账号重复 tick 复用；
     *     - 跨天用新日期键 → 自然重新随机；
     *     - 随机值**必须在提交前落盘成功**（fail-closed，写失败不提交）。
     *
     * @returns {{ok:boolean, runDistance?:number, reason?:string, persisted?:boolean}}
     */
    function resolveUnirunDistance(state, config, account) {
      var u = config.unirun || {};

      // 1) 显式配置优先（有效数字才认；'' / null / undefined 视为未配置）
      var explicitRaw = u.runDistance;
      var explicit = null;
      if (explicitRaw !== null && explicitRaw !== undefined && String(explicitRaw).trim() !== '') {
        explicit = numInRange(explicitRaw, 1000, 10000);
        if (explicit === null) {
          return { ok: false, reason: 'invalid-run-params' };
        }
        return { ok: true, runDistance: Math.round(explicit), persisted: false };
      }

      // 2) 随机范围校验
      var minRaw = u.runDistanceMin === undefined || u.runDistanceMin === null
        ? DEFAULTS.unirun.runDistanceMin
        : u.runDistanceMin;
      var maxRaw = u.runDistanceMax === undefined || u.runDistanceMax === null
        ? DEFAULTS.unirun.runDistanceMax
        : u.runDistanceMax;
      var minM = numInRange(minRaw, 1000, 10000);
      var maxM = numInRange(maxRaw, 1000, 10000);
      if (minM === null || maxM === null || minM > maxM) {
        return { ok: false, reason: 'invalid-run-params' };
      }
      minM = Math.round(minM);
      maxM = Math.round(maxM);
      if (minM > maxM) return { ok: false, reason: 'invalid-run-params' };

      // 3) 当天固定：已有持久值直接复用（同样拒绝末位 0 的历史脏值）
      var dateStr = beijingDateString(now());
      var stateKey = unirunDistanceStateKey(dateStr, account);
      state.unirunDistance = state.unirunDistance && typeof state.unirunDistance === 'object' ? state.unirunDistance : {};
      var cached = numInRange(state.unirunDistance[stateKey], 1000, 10000);
      if (cached !== null && Math.round(cached) % 10 !== 0) {
        return { ok: true, runDistance: Math.round(cached), persisted: false };
      }

      // 4) 首次随机（末位非 0）
      var picked = pickDistanceWithOnesDigit(minM, maxM);

      // 5) fail-closed：先落盘成功才作为「当天固定值」使用
      state.unirunDistance[stateKey] = picked;
      if (previewMode) {
        return { ok: true, runDistance: picked, persisted: false, preview: true };
      }
      try {
        saveState(state);
      } catch (e) {
        delete state.unirunDistance[stateKey];
        logger.log('[storage] 校园跑随机里程落盘失败，已阻止本轮提交：' + sanitizeError(e));
        return { ok: false, reason: 'storage-error' };
      }
      logger.log('[unirun] 今日随机里程为 ' + picked + ' 米（' + minM + '~' + maxM + '，末位非 0）');
      return { ok: true, runDistance: picked, persisted: true };
    }

    /**
     * 当天「时长（分钟）」随机值：与里程同一套模式，额外保证**不是 5 的倍数**。
     * 30/35/40 这类整 5 的时长更像脚本默认值，用户明确要求避开。
     */
    function unirunTimeStateKey(dateStr, account) {
      return String(dateStr) + '|' + String(account || 'local');
    }

    function pickMinutesNotMultipleOf5(minM, maxM) {
      var span = maxM - minM + 1;
      var rand = typeof opts.random === 'function' ? opts.random() : Math.random();
      var unit = Number(rand);
      if (!Number.isFinite(unit) || unit < 0) unit = 0;
      if (unit >= 1) unit = 0.9999999999;
      var picked = minM + Math.floor(unit * span);
      if (picked < minM) picked = minM;
      if (picked > maxM) picked = maxM;
      if (picked % 5 === 0) {
        // 优先 +1（区间内），否则 -1；保证永远不是 5 的倍数
        if (picked + 1 <= maxM) picked += 1;
        else if (picked - 1 >= minM) picked -= 1;
      }
      return picked;
    }

    /**
     * 解析本次运行应使用的时长（分钟）。
     *
     * 优先级与口径与里程完全同构：
     *  1. 显式配置优先（向后兼容）；
     *  2. 否则 `[runTimeMin, runTimeMax]`（默认 31~39）随机，**排除 5 的倍数**；
     *  3. 当天固定（`state.unirunTime`），跨天重随机；
     *  4. fail-closed：落盘失败不提交。
     */
    function resolveUnirunTime(state, config, account) {
      var u = config.unirun || {};

      var explicitRaw = u.runTime;
      var explicit = null;
      if (explicitRaw !== null && explicitRaw !== undefined && String(explicitRaw).trim() !== '') {
        explicit = numInRange(explicitRaw, 5, 300);
        if (explicit === null) {
          return { ok: false, reason: 'invalid-run-params' };
        }
        return { ok: true, runTime: Math.round(explicit), persisted: false };
      }

      var minRaw = u.runTimeMin === undefined || u.runTimeMin === null
        ? DEFAULTS.unirun.runTimeMin
        : u.runTimeMin;
      var maxRaw = u.runTimeMax === undefined || u.runTimeMax === null
        ? DEFAULTS.unirun.runTimeMax
        : u.runTimeMax;
      var minMin = numInRange(minRaw, 5, 300);
      var maxMin = numInRange(maxRaw, 5, 300);
      if (minMin === null || maxMin === null || minMin > maxMin) {
        return { ok: false, reason: 'invalid-run-params' };
      }
      minMin = Math.round(minMin);
      maxMin = Math.round(maxMin);
      if (minMin > maxMin) return { ok: false, reason: 'invalid-run-params' };

      var dateStr = beijingDateString(now());
      var stateKey = unirunTimeStateKey(dateStr, account);
      state.unirunTime = state.unirunTime && typeof state.unirunTime === 'object' ? state.unirunTime : {};
      var cached = numInRange(state.unirunTime[stateKey], 5, 300);
      if (cached !== null && Math.round(cached) % 5 !== 0) {
        return { ok: true, runTime: Math.round(cached), persisted: false };
      }

      var picked = pickMinutesNotMultipleOf5(minMin, maxMin);
      state.unirunTime[stateKey] = picked;
      if (previewMode) {
        return { ok: true, runTime: picked, persisted: false, preview: true };
      }
      try {
        saveState(state);
      } catch (e) {
        delete state.unirunTime[stateKey];
        logger.log('[storage] 校园跑随机时长落盘失败，已阻止本轮提交：' + sanitizeError(e));
        return { ok: false, reason: 'storage-error' };
      }
      logger.log('[unirun] 今日随机时长为 ' + picked + ' 分钟（' + minMin + '~' + maxMin + '，非 5 的倍数）');
      return { ok: true, runTime: picked, persisted: true };
    }

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
      var account = accountFor(config, 'unirun');
      var window = resolveUnirunWindow(state, config, account);
      if (!window.ok) {
        results.push(row('unirun', 'autoRun', '', 'failed', window.reason || 'invalid-window'));
        return Promise.resolve();
      }
      var windowMin = window.windowMinutes;
      // 里程：显式配置优先，否则当天随机且末位非 0（1000/1100 这类整数会被上游作废）
      var distance = resolveUnirunDistance(state, config, account);
      if (!distance.ok) {
        results.push(row('unirun', 'autoRun', '', 'failed', distance.reason || 'invalid-run-params'));
        return Promise.resolve();
      }
      var runDistance = distance.runDistance;
      // 时长：显式配置优先，否则当天随机 31~39 且不是 5 的倍数
      var duration = resolveUnirunTime(state, config, account);
      if (!duration.ok) {
        results.push(row('unirun', 'autoRun', '', 'failed', duration.reason || 'invalid-run-params'));
        return Promise.resolve();
      }
      var runTime = duration.runTime;
      if (runDistance === null || runTime === null) {
        results.push(row('unirun', 'autoRun', '', 'failed', 'invalid-run-params'));
        return Promise.resolve();
      }
      if (minute < startMin) {
        results.push(row('unirun', 'autoRun', '', 'not-yet', 'before-run-time', { windowMinutes: windowMin }));
        return Promise.resolve();
      }
      if (minute > startMin + windowMin) {
        results.push(
          row('unirun', 'autoRun', '', 'expired', 'run-window-passed', { windowMinutes: windowMin }),
        );
        return Promise.resolve();
      }
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
            accountId: accountFor(config, 'unirun'),
            activityName: '校园跑',
            category: '',
            stage: 'run',
            distanceMeters: runDistance,
            // 本次实际使用的时长（随机或显式），结果行会透出便于排查
            runTime: runTime,
            // 本次实际使用的有效窗口（随机或显式），结果行会透出便于排查
            windowMinutes: windowMin,
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
                    accountId: account,
                    activityName: String(item.activityName || ''),
                    category: '',
                    stage: 'join',
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
                          planClubSign(state, config, account, results, cred, id, 'signIn', '1', startMs, startMs + CLUB_SIGNIN_WINDOW_MIN * 60000, coord, activityNameOf(taskItem, base),
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
                            activityNameOf(taskItem, base),
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

    /** 俱乐部活动名（任务/列表两个来源取先有值的） */
    function activityNameOf() {
      for (var i = 0; i < arguments.length; i += 1) {
        var src = arguments[i];
        var name = src && (src.activityName || src.ActivityName);
        if (name) return String(name);
      }
      return '';
    }

    function planClubSign(state, config, account, results, cred, id, action, signType, windowStart, windowEnd, coord, canRun, activityName) {
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
          accountId: account,
          activityName: String(activityName || ''),
          category: '',
          stage: action === 'signIn' ? 'sign-in' : 'sign-out',
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
      // 空关键词且未开 allowAll：不得新增报名（安全闸门不变），但也**不能整轮早退**——
      // 官方 status=1（已报名）活动仍需签到/签退：新机/升级后本地无历史时，
      // 用户此前报名（含官网手动报名）的活动只能靠 status=1 列表发现。
      var keywordGateOff = (config.ek.keywords || []).length === 0 && !config.ek.allowAll;
      if (keywordGateOff) {
        results.push(row('ek', 'list', '', 'waiting-material', 'need-keywords'));
      }
      var account = accountFor(config, 'ek');
      var today = beijingDateString(now());
      var watched = (state.watchedEk && state.watchedEk[account]) || {};
      var candidates = {}; // id -> { item?, watched?, status1?: bool, conflict?: bool }

      /**
       * 已结束归档缓存（按账号）：
       *  - 详情确认所有签到/签退窗口都已结束 → 归档；后续 tick 不再为该 id 拉详情
       *    （历史已报名活动会一直在 status=1 列表里，不缓存会每轮放大请求量）；
       *  - 7 天内视为有效缓存（逾期重新确认，避免字段/时间被上游修正后永久误跳过）；
       *  - 超过 30 天清理，防止无界增长。
       */
      var FINISHED_HIT_MS = 7 * 24 * 60 * 60 * 1000;
      var FINISHED_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
      state.ekFinished = state.ekFinished && typeof state.ekFinished === 'object' ? state.ekFinished : {};
      var finished = state.ekFinished[account] && typeof state.ekFinished[account] === 'object' ? state.ekFinished[account] : {};
      function finishedHit(id) {
        var entry = finished[id];
        if (!entry || typeof entry !== 'object') return false;
        var at = Number(entry.at) || 0;
        return at > 0 && now() - at <= FINISHED_HIT_MS;
      }
      // 顺带清理 30 天前的归档（有清理才写盘一次，避免每轮无谓写）
      var finishedPruned = false;
      Object.keys(finished).forEach(function (id) {
        var at = Number(finished[id] && finished[id].at) || 0;
        if (!(at > 0) || now() - at > FINISHED_KEEP_MS) {
          delete finished[id];
          finishedPruned = true;
        }
      });
      if (finishedPruned) {
        if (Object.keys(finished).length === 0) delete state.ekFinished[account];
        else state.ekFinished[account] = finished;
        try {
          saveState(state);
        } catch (e) {
          logger.log('[storage] ekFinished 清理落盘失败：' + sanitizeError(e));
        }
      }

      /**
       * 扫描汇总（安全字段，供日志/看板展示「为什么没报名」）
       */
      var scan = {
        fetched: 0,
        eligible: 0,
        joinable: 0,
        applied: 0,
        unknown: 0,
        filtered: 0,
        finished: 0,
        nextpages: 0,
        truncated: false,
      };
      lastEkScan = scan;
      /** per-run 模块选项映射（来自官方 ModuleCodeList；不写配置、不全局缓存） */
      var moduleOptions = [];
      function captureModuleOptions(res) {
        if (!res || typeof res !== 'object') return;
        var list = res.ModuleCodeList;
        if (!Array.isArray(list)) return;
        list.forEach(function (it) {
          if (!it || typeof it !== 'object') return;
          var label = String(it.label != null ? it.label : it.Label != null ? it.Label : '').trim();
          var value = String(it.value != null ? it.value : it.Value != null ? it.Value : '').trim();
          if (!label || !value) return;
          for (var i = 0; i < moduleOptions.length; i += 1) {
            if (moduleOptions[i].value === value) return;
          }
          moduleOptions.push({ label: label, value: value });
        });
      }

      var maxPages = Math.max(1, Math.min(20, Number(config.ek.maxPages) || 20));

      /**
       * 分页拉取某一个 activityStatus 的活动列表：
       *  - 跟随 TotalPages 停止（不固定 3 页）
       *  - 受 maxPages 上限约束，超限记 truncated
       *  - 捕获 ModuleCodeList 到 per-run 映射
       */
      function fetchStatusPages(activityStatus) {
        var pageIndex = 1;
        var collected = [];
        var firstFailed = false;
        var pagesThisQuery = 0;
        var declaredTotalPages = null;
        function step() {
          // 用户停止后不再继续抓后续页
          if (stopped) {
            return Promise.resolve(collected);
          }
          if (pagesThisQuery >= maxPages) {
            var morePending =
              declaredTotalPages === null || Number.isFinite(declaredTotalPages)
                ? declaredTotalPages === null || pageIndex <= declaredTotalPages
                : false;
            if (morePending) scan.truncated = true;
            results.push(
              row('ek', 'list', 'status' + activityStatus + '-truncated', 'skipped', 'page-cap-reached', {
                activityName: '二课列表翻页',
                listStatus: String(activityStatus),
                pageIndex: pageIndex,
                nextpages: pagesThisQuery,
                totalPages: declaredTotalPages,
                truncated: true,
              }),
            );
            return Promise.resolve(collected);
          }
          pagesThisQuery += 1;
          scan.nextpages += 1;
          return Promise.resolve(
            api.ek.getActivitiesList({
              requestsData: session,
              pageIndex: pageIndex,
              activityStatus: activityStatus,
            }),
          )
            .then(function (res) {
              captureModuleOptions(res);
              var items = ekListItems(res);
              if (items === null) {
                // 结构不符：明确诊断（不被 no-candidate 掩盖），不进候选
                if (pageIndex === 1) firstFailed = true;
                results.push(
                  row('ek', 'list', 'status' + activityStatus + '-p' + pageIndex, 'unknown', 'unexpected-list-shape', {
                    activityName: '二课列表返回异常',
                    listStatus: String(activityStatus),
                    pageIndex: pageIndex,
                  }),
                );
                return collected;
              }
              items.forEach(function (it) {
                collected.push(it);
              });
              var totalPagesRaw = res && res.List ? res.List.TotalPages : undefined;
              var totalPages = Number(totalPagesRaw);
              if (Number.isFinite(totalPages)) declaredTotalPages = totalPages;
              var more = Number.isFinite(totalPages) ? pageIndex < totalPages : items.length > 0;
              pageIndex += 1;
              if (!more) return collected;
              return step();
            })
            .catch(function (e) {
              if (pageIndex === 1) firstFailed = true;
              results.push(
                row('ek', 'list', 'status' + activityStatus + '-p' + pageIndex, 'unknown', sanitizeError(e), {
                  listStatus: String(activityStatus),
                  pageIndex: pageIndex,
                }),
              );
              return collected;
            });
        }
        return step().then(function (items) {
          return { items: items, failed: firstFailed && items.length === 0, totalPages: declaredTotalPages };
        });
      }

      /**
       * 合并发现结果：status=1 更可靠（已报名），与 status=0 冲突时按已报名处理，
       * 防止两次查询快照竞态导致重复报名。
       *
       * 关键词闸门只约束「新增报名」：官方已报名（status=1）的活动是用户已有的权益，
       * 必须无条件跟踪签到/签退 —— 不能因为活动名不命中关键词/未开 allowAll 就丢弃，
       * 否则新机/升级后（无本地 watch 历史）这些活动永远无人签到。
       */
      function mergeDiscovered(items, sourceStatus) {
        items.forEach(function (item) {
          var id = ekActivityId(item);
          if (!id) return;
          scan.fetched += 1;
          // 已结束归档命中：不进候选（不拉详情），只计数便于诊断
          if (finishedHit(id)) {
            scan.finished += 1;
            return;
          }
          var status = ekActivityStatus(item) || sourceStatus;
          if (status !== '1' && !passesKeyword(item, config.ek)) {
            scan.filtered += 1;
            return;
          }
          var entry = candidates[id] || (candidates[id] = {});
          if (status === '1') {
            // 已报名最可靠：覆盖此前的 status=0；这是「补充发现」的正常现象，不算冲突
            entry.item = item;
            entry.status1 = true;
            if (entry.status0) entry.status0Seen = true;
          } else if (status === '0') {
            if (entry.status1) {
              // 同一轮内 status=1 已确认已报名，后来的 status=0 视为快照竞态 → 冲突
              entry.conflict = true;
            } else {
              entry.item = item;
              entry.status0 = true;
            }
          } else {
            if (!entry.item) entry.item = item;
          }
          scan.eligible += 1;
        });
      }

      // 1) 显式查「可报名」(status=0)，再只读补充「已报名」(status=1) —— 不丢用户手动已报名
      return Promise.resolve()
        .then(function () {
          // 空关键词且未开 allowAll：仅跳过 status=0 扫描（绝不新增报名），
          // 但仍必须扫 status=1 才能对已报名活动签到/签退。
          if (keywordGateOff) return { items: [], failed: false, totalPages: null };
          return fetchStatusPages('0');
        })
        .then(function (joinableResult) {
          mergeDiscovered(joinableResult.items, '0');
          // watch 独立性：即使可报名查询失败，也不影响后续对 watch 活动拉详情
          return fetchStatusPages('1').then(function (appliedResult) {
            mergeDiscovered(appliedResult.items, '1');
            return {
              joinableFailed: joinableResult.failed,
              appliedFailed: appliedResult.failed,
            };
          });
        })
        .then(function (scanInfo) {
          // 2) 关注集合：watch 活动必须每 tick 拉详情（与 new discovery 独立）
          //    已结束归档命中的 watch 项不再进候选（详情已确认窗口全部结束，无需再拉）
          Object.keys(watched).forEach(function (id) {
            if (finishedHit(id)) return;
            candidates[id] = candidates[id] || {};
            candidates[id].watched = true;
          });
          if (Object.keys(candidates).length === 0) {
            results.push(row('ek', 'list', '', 'ok', 'no-candidate'));
            return null;
          }
          // 3) 逐个处理（顺序执行，便于诊断与限流）
          var run = Promise.resolve();
          Object.keys(candidates).forEach(function (id) {
            run = run.then(function () {
              if (stopped) return null;
              return handleEkActivity(state, config, session, account, results, id, candidates[id], watched, today, moduleOptions, scan);
            });
          });
          return run.then(function () {
            return scanInfo;
          });
        })
        .then(function () {
          // 4) 清理：已过期且两阶段都完成的 watch 项（有清理才写盘一次，避免每轮无谓写入）
          if (pruneWatchedEk(state, watched)) {
            try {
              saveState(state);
            } catch (e) {
              logger.log('[storage] watch 清理落盘失败：' + sanitizeError(e));
            }
          }
          // 5) 扫描汇总行：让「为什么没报名」在日志里可见（safe 字段，无 payload/token）
          results.push(
            row('ek', 'scan', '', 'ok', 'scan-complete', {
              activityName: '二课扫描汇总',
              fetched: scan.fetched,
              eligible: scan.eligible,
              joinable: scan.joinable,
              applied: scan.applied,
              unknown: scan.unknown,
              filtered: scan.filtered,
              finished: scan.finished,
              nextpages: scan.nextpages,
              truncated: scan.truncated,
            }),
          );
        })
        .catch(function (e) {
          results.push(row('ek', 'list', '', 'unknown', sanitizeError(e)));
        });
    }

    /** 单个二课活动：拉详情 → 报名（可选）→ 签到/签退 → 维护 watch */
    function handleEkActivity(state, config, session, account, results, id, candidate, watched, today, moduleOptions, scan) {
      var scanRef = scan || { fetched: 0, eligible: 0, joinable: 0, applied: 0, unknown: 0, filtered: 0, finished: 0, nextpages: 0, truncated: false };
      return Promise.resolve(api.ek.getActivityDetail({ requestsData: session, id: id }))
        .then(function (detail) {
          var info = detail && detail.ActivityInfo && typeof detail.ActivityInfo === 'object' ? detail.ActivityInfo : null;
          if (!info) {
            results.push(row('ek', 'detail', id, 'unknown', 'missing-activity-info'));
            return null;
          }
          // 用户要求：SignWay=4（签到码 = 现场验证码，极少活动使用）的活动**不报名**。
          // 没有可取来源、无法自动签到，报了也会占名额且签不上，所以整条跳过（不 apply、不 watch、不签到）。
          if ((config.ek && config.ek.skipSignWay4 !== false) && Number(info.SignWay) === 4) {
            results.push(row('ek', 'detail', id, 'skipped', 'skip-signway-4', {
              activityName: String(info.ActivityName || ''),
              signWay: info.SignWay,
            }));
            return Promise.resolve(null);
          }
          var applyState = ekApplyState(candidate.item || {}, detail, id);
          // 同 id 两次查询状态冲突：status=1 更可靠，禁止重复报名（记录诊断）
          if (candidate.conflict && applyState === 'joinable') applyState = 'applied';
          if (applyState === 'joinable') scanRef.joinable += 1;
          else if (applyState === 'applied') scanRef.applied += 1;
          else scanRef.unknown += 1;
          // 最后一阶段（签到/签退）截止时间：watch 过期清理与「已结束归档」共用同一口径
          var watchExpireAt = ekSignExpireAt(info);
          // 官方已报名 / 列表已报名 → 记入 watch，保证后续 tick 继续跟踪
          if (applyState === 'applied') {
            state.watchedEk = state.watchedEk || {};
            state.watchedEk[account] = state.watchedEk[account] || {};
            var watchedEntry = state.watchedEk[account][id];
            if (!watchedEntry) {
              var newWatch = {
                name: String(info.ActivityName || ''),
                addedAt: now(),
              };
              // 记录官方窗口最后截止时间：pruneWatchedEk 据此在结束后清理（无窗口不加）
              if (watchExpireAt > 0) newWatch.expireAt = watchExpireAt;
              state.watchedEk[account][id] = newWatch;
              try {
                saveState(state);
              } catch (e) {
                logger.log('[storage] watch 记录失败：' + sanitizeError(e));
              }
            } else if (watchExpireAt > 0 && Number(watchedEntry.expireAt) !== watchExpireAt) {
              // 已有 watch 项每轮刷新 expireAt（详情字段可能后续补齐/修正），值不变不写盘
              watchedEntry.expireAt = watchExpireAt;
              try {
                saveState(state);
              } catch (e) {
                logger.log('[storage] watch expireAt 刷新失败：' + sanitizeError(e));
              }
            }
          }
          var steps = Promise.resolve();

          // 活动类别（严格：ModuleCodeText 优先，其次官方 code 映射；不猜）
          var categoryInfo = resolveCategory(config, info, candidate.item || {}, moduleOptions);
          var category = categoryInfo.category || '';
          if (!category) {
            results.push(row('ek', 'detail', id, 'skipped', 'category-unknown'));
          }

          // a) 报名决策：所有候选都产出可见诊断行（不再静默消失）
          var applyWindow = parseEkRange(info.StuETime);
          var listStatus = ekActivityStatus(candidate.item || {});
          if (!listStatus && candidate.status0) listStatus = '0';
          function diagRow(status, reason, decision, extra) {
            var base = {
              activityName: String(info.ActivityName || ''),
              category: category,
              listStatus: listStatus,
              classify: applyState,
              decision: decision,
              scoreGate: applyState === 'joinable' ? '' : '',
              applyWindowStart: applyWindow.start,
              applyWindowEnd: applyWindow.end,
            };
            if (extra) Object.keys(extra).forEach(function (k) { base[k] = extra[k]; });
            return row('ek', 'apply', id, status, reason, base);
          }
          if (!config.ek.apply) {
            results.push(diagRow('skipped', 'apply-disabled', 'skipped'));
          } else if (applyState === 'applied') {
            results.push(
              diagRow(
                'skipped',
                candidate.conflict ? 'already-applied-conflict' : 'already-applied',
                'already-applied',
              ),
            );
          } else if (applyState !== 'joinable') {
            results.push(diagRow('skipped', 'apply-state-unknown', 'unknown'));
          } else {
            steps = steps.then(function () {
              if (stopped) return null;
              // 积分策略：无可信/账号匹配 snapshot、达标模块、未知类别 → 一律不新增
              if (!category) {
                results.push(diagRow('skipped', 'category-unknown', 'category-unknown', { scoreGate: 'category-unknown' }));
                return null;
              }
              var gate = scoreGateForCategory(config, category);
              if (!gate.allow) {
                var blockedStatus = String(gate.reason || '').indexOf('score-') === 0 ? 'blocked' : 'skipped';
                var decision = gate.reason === 'module-satisfied' ? 'module-satisfied' : 'score-blocked';
                results.push(diagRow(blockedStatus, gate.reason, decision, { scoreGate: gate.reason }));
                return null;
              }
              // 严格时间窗（安全 gate，不得因 list status=0 放宽）：
              // 缺报名时间字段 -> 明确 waiting-material，并输出诊断供核查字段结构
              if (applyWindow.start === null) {
                results.push(
                  diagRow('waiting-material', 'missing-apply-window', 'unknown', {
                    scoreGate: 'ok',
                    detailHasStuETime: info.StuETime != null && String(info.StuETime).trim() !== '',
                  }),
                );
                return null;
              }
              var nowMs = now();
              if (nowMs < applyWindow.start) {
                results.push(diagRow('not-yet', 'before-apply-window', 'window-waiting', { scoreGate: 'ok' }));
                return null;
              }
              if (applyWindow.end !== null && nowMs > applyWindow.end) {
                results.push(diagRow('expired', 'apply-window-passed', 'window-expired', { scoreGate: 'ok' }));
                return null;
              }
              var limit = Math.max(0, Number(config.ek.dailyLimit) || 0);
              var countKey = dailyKey(today, account, 'ek', 'apply');
              if (limit > 0 && dailyCount(state, countKey) >= limit) {
                results.push(diagRow('skipped', 'daily-limit-reached', 'daily-limit', { scoreGate: 'ok' }));
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
                  accountId: account,
                  activityName: String(info.ActivityName || ''),
                  category: category,
                  listStatus: ekActivityStatus(candidate.item || {}) || '0',
                  classify: 'joinable',
                  decision: 'applicable',
                  scoreGate: 'ok',
                  applyWindowStart: applyWindow.start,
                  applyWindowEnd: applyWindow.end,
                  config: config,
                  dailyKey: countKey,
                  deadlineMs: applyWindow.end,
                  // 二次闸门：真正提交前再判一次（防止本轮内策略变化）
                  preSubmitGate: function () {
                    var again = scoreGateForCategory(config, category);
                    return again.allow ? null : again.reason;
                  },
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
                  var appliedWatch = { name: String(info.ActivityName || ''), addedAt: now() };
                  // 与「已报名」路径同一口径：watch 带官方窗口最后截止时间，供 pruneWatchedEk 清理
                  if (watchExpireAt > 0) appliedWatch.expireAt = watchExpireAt;
                  state.watchedEk[account][id] = appliedWatch;
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
            // 官方签到记录 Id（StuSaveSignIn 的 SignInModel.Id），志愿者未上传二维码时用于无码直签兜底
            var ekSignId = String(
              (detail && detail.ApplyInfo && detail.ApplyInfo.Id) || '',
            );
            var tasks = [];
            if (config.ek.signIn && needIn) {
              tasks.push({
                action: 'signIn',
                funType: 'QD',
                signWay: signWay,
                signId: ekSignId,
                latitude: info.latitude,
                longitude: info.longitude,
                activityName: String(info.ActivityName || ''),
                category: category,
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
                signId: ekSignId,
                latitude: info.latitude,
                longitude: info.longitude,
                activityName: String(info.ActivityName || ''),
                category: category,
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

          // c) 已结束归档：详情确认签到/签退窗口**全部**结束（expireAt 取两者 end 最大值）后，
          //    记入 state.ekFinished，后续 tick 不再为它拉详情（避免历史已报名活动重复请求）。
          //    注意：不改变 done/failed/安全口径；本轮仍先走完报名/签到流程再归档。
          steps = steps.then(function () {
            if (stopped) return null;
            if (!(watchExpireAt > 0) || now() <= watchExpireAt) return null;
            state.ekFinished = state.ekFinished && typeof state.ekFinished === 'object' ? state.ekFinished : {};
            state.ekFinished[account] = state.ekFinished[account] && typeof state.ekFinished[account] === 'object'
              ? state.ekFinished[account]
              : {};
            state.ekFinished[account][id] = { at: now(), expireAt: watchExpireAt };
            results.push(row('ek', 'detail', id, 'skipped', 'finished-archived', {
              activityName: String(info.ActivityName || ''),
              expireAt: watchExpireAt,
            }));
            try {
              saveState(state);
            } catch (e) {
              logger.log('[storage] ekFinished 记录失败：' + sanitizeError(e));
            }
            return null;
          });

          return steps;
        })
        .catch(function (e) {
          results.push(row('ek', 'detail', id, 'unknown', sanitizeError(e)));
          return null;
        });
    }

    /** 清理 watch：已过最后一阶段结束时间（expireAt+6h）的条目，避免无限增长；返回是否有删除 */
    function pruneWatchedEk(state, watched) {
      var accountIds = Object.keys(watched || {});
      if (accountIds.length === 0) return false;
      var t = now();
      var changed = false;
      accountIds.forEach(function (id) {
        var entry = watched[id];
        var expireAt = Number(entry && entry.expireAt);
        if (Number.isFinite(expireAt) && expireAt > 0 && t > expireAt + 6 * 60 * 60 * 1000) {
          delete watched[id];
          changed = true;
        }
      });
      return changed;
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
      var signWayNum = Number(task.signWay);
      // SignWay=2（拍照）/ 3（定位+拍照）：同样走 StuSaveSignIn，带图库图片 + 活动中心坐标。
      // 服务端对该端点的证据字段（照片/坐标/验证码）不做校验；照片取自图库，
      // 无图时按「空照片」提交，与 SignWay=1 无码直签同一口径。
      if (signWayNum === 2 || signWayNum === 3) {
        return planEkPhotoSign(state, config, account, results, session, id, task, range);
      }
      // SignWay=4（签到码 = 现场验证码，极少活动使用）：没有可取来源，不自动提交。
      // 这类活动在报名阶段就被跳过（skipSignWay4），这里只是兜底：万一已报名仍等人工。
      if (signWayNum !== 1) {
        results.push(row('ek', task.action, id, 'waiting-material', 'need-manual-sign-way', { signWay: task.signWay }));
        return Promise.resolve();
      }

      // 无码直签兜底（默认开启）：志愿者未上传二维码时，用官方 StuSaveSignIn
      // 以 SignWay=1 + 空照片/定位/验证码完成签到/签退。服务端信任客户端传入的
      // SignWay，扫码校验只存在于 StuSaveQrCode 端点，因此该路径可绕过二维码
      // （2026-10-17 对 ywtb.cuit.edu.cn 实测：签到/签退均 errcode=0 且官方记录已更新）。
      // 需要保留旧行为（只认二维码）时在配置里显式设置 ek.noQrFallback=false。
      var noQrFallback = !(config.ek && config.ek.noQrFallback === false);

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

      // 3CT 社区图库默认不接（需要后端账号 token，且对签到无增益）：关掉时直接按「无码」处理
      var qrImagesTask = config.ek && config.ek.backendGallery === true ? listBoundImages(id) : Promise.resolve([]);
      return qrImagesTask.then(function (images) {
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
            // 志愿者未上传二维码 → 官方 StuSaveSignIn 无码直签兜底（默认开启）
            if (
              noQrFallback &&
              task.signId &&
              api.ek &&
              typeof api.ek.signInOutByOthers === 'function'
            ) {
              var fallbackKey = dedupeKey({
                date: beijingDateString(now()),
                account: account,
                module: 'ek',
                activityId: id,
                action: task.action,
              });
              return perform(
                state,
                {
                  key: fallbackKey,
                  module: 'ek',
                  action: task.action,
                  activityId: id,
                  accountId: account,
                  activityName: String(task.activityName || ''),
                  category: String(task.category || ''),
                  stage: task.action === 'signIn' ? 'sign-in' : 'sign-out',
                  config: config,
                  deadlineMs: range.end,
                  noQrFallback: true,
                },
                function () {
                  return api.ek.signInOutByOthers({
                    requestsData: session,
                    signModel: {
                      Id: task.signId,
                      ActivityId: id,
                      SignWay: 1,
                      Type: task.action === 'signIn' ? 1 : 2,
                      Latitude: 0,
                      Longitude: 0,
                      LocationData: '',
                      Captcha: '',
                      Photos: { Imgs: [], Files: [] },
                      SystemId: '00000000-0000-0000-0000-000000000000',
                    },
                  });
                },
                classifyEkWrite,
              ).then(function (r) {
                results.push(r);
                return null;
              });
            }
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
              accountId: account,
              activityName: String(task.activityName || ''),
              category: String(task.category || ''),
              stage: task.action === 'signIn' ? 'sign-in' : 'sign-out',
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

    /**
     * 拍照 / 定位+拍照签到（SignWay=2 / 3）自动提交。
     *
     * 与 SignWay=1 无码直签同一原理：服务端在 `StuSaveSignIn` 端点**不校验证据字段**，
     * `SignWay` 只是客户端声明。所以：
     *   - 照片：取该活动图库里已绑定的一张未用过的图；非 ek 域名先上传到官方 UpFilePath
     *           （`imageUploadToSignActivity`），拿官方 URL 再提交。图库没有图时按空照片提交。
     *   - 坐标：SignWay=3 用活动详情里的中心点（`ActivityInfo.latitude/longitude`），
     *           误差 0 米必然在覆盖范围内；缺字段时按 0 提交（服务端不校验）。
     *   - 验证码：SignWay=2/3 不需要。
     *
     * 失败口径与其他写操作一致：`perform` 负责去重/锁定/截止校验，失败不重试爆量
     * （独立计数 `photoChecks`，默认与二维码共用 `qrMaxAttempts` / `qrRetryMinutes`）。
     * 关闭入口：`ek.photoSign=false` → 退回 `need-manual-sign-way`。
     */
    function planEkPhotoSign(state, config, account, results, session, id, task, range) {
      var cfg = config.ek || {};
      if (cfg.photoSign === false) {
        results.push(row('ek', task.action, id, 'waiting-material', 'photo-sign-disabled', { signWay: task.signWay }));
        return Promise.resolve();
      }
      var signId = String(task.signId || '').trim();
      if (!signId) {
        results.push(row('ek', task.action, id, 'waiting-material', 'need-sign-id', { signWay: task.signWay }));
        return Promise.resolve();
      }
      if (!api.ek || typeof api.ek.signInOutByOthers !== 'function') {
        results.push(row('ek', task.action, id, 'blocked', 'api-unavailable', { signWay: task.signWay }));
        return Promise.resolve();
      }

      var signWay = Number(task.signWay);
      var t = now();
      var maxAttempts = Math.max(1, Number(cfg.qrMaxAttempts) || 3);
      var retryMs = Math.max(0, Number(cfg.qrRetryMinutes) || 0) * 60000;
      var checksKey = dedupeKey({
        date: beijingDateString(now()),
        account: account,
        module: 'ek',
        activityId: id,
        action: 'photoChecks-' + task.funType,
      });
      state.photoChecks = state.photoChecks && typeof state.photoChecks === 'object' ? state.photoChecks : {};
      var check = state.photoChecks[checksKey] || { count: 0, lastAt: 0 };
      if (check.count >= maxAttempts) {
        results.push(row('ek', task.action, id, 'waiting-material', 'photo-attempts-exhausted', { signWay: signWay }));
        return Promise.resolve();
      }
      if (check.lastAt && retryMs > 0 && t < check.lastAt + retryMs) {
        results.push(row('ek', task.action, id, 'waiting-material', 'photo-retry-pending', { signWay: signWay }));
        return Promise.resolve();
      }
      check.count += 1;
      check.lastAt = t;
      state.photoChecks[checksKey] = check;
      try {
        saveState(state);
      } catch (e) {
        logger.log('[storage] photoChecks 写入失败，已阻止提交：' + sanitizeError(e));
        results.push(row('ek', task.action, id, 'blocked', 'storage-error', { signWay: signWay }));
        return Promise.resolve();
      }

      // 已用图片：同阶段不复用；签退也不复用签到用过的图
      var usedKey = id + '|' + task.action;
      var usedImages = (state.usedImages && state.usedImages[usedKey]) || [];
      var otherKey = id + '|' + (task.action === 'signIn' ? 'signOut' : 'signIn');
      var otherUsed = (state.usedImages && state.usedImages[otherKey]) || [];

      // 3CT 社区图库默认不接：关掉时直接走内置兜底图
      var photoImagesTask = cfg.backendGallery === true ? listBoundImages(id) : Promise.resolve([]);
      return photoImagesTask.then(function (images) {
        var picked = null;
        images.forEach(function (img) {
          if (picked) return;
          var imageId = img && img.id != null ? String(img.id) : '';
          if (imageId && usedImages.indexOf(imageId) >= 0) return;
          if (imageId && otherUsed.indexOf(imageId) >= 0) return;
          var stage = imageStage(img);
          if (stage && stage !== task.action) return;
          var url = img && (img.file_url || img.thumb_url);
          if (!url) return;
          picked = { imageId: imageId, url: String(url) };
        });

        // 照片来源：图库优先；图库没有可用图时用内置兜底图（ek.fallbackPhoto，data URL）。
        // 两者都要先落到二课官方域名（UpFilePath 上传）才能作为 Photos.Imgs[].url 提交。
        var fallbackPhoto = typeof cfg.fallbackPhoto === 'string' ? cfg.fallbackPhoto.trim() : '';
        var sourceUrl = '';
        var photoOrigin = 'none';
        if (picked) {
          var isOfficial = /^https?:\/\/ek\.cuit\.edu\.cn/i.test(picked.url);
          sourceUrl = isOfficial ? picked.url : picked.url;
          photoOrigin = 'gallery';
        } else if (fallbackPhoto) {
          sourceUrl = fallbackPhoto;
          photoOrigin = 'fallback';
        }
        var uploadTask = Promise.resolve('');
        if (sourceUrl && /^https?:\/\/ek\.cuit\.edu\.cn/i.test(sourceUrl)) {
          // 已经是官方域名：不需要再上传
          uploadTask = Promise.resolve(sourceUrl);
        } else if (sourceUrl) {
          if (api.ek && typeof api.ek.imageUploadToSignActivity === 'function') {
            uploadTask = Promise.resolve(
              api.ek.imageUploadToSignActivity({
                requestsData: session,
                activityId: id,
                signId: signId,
                sourceUrl: sourceUrl,
              }),
            )
              .then(function (res) {
                var url = res && typeof res.url === 'string' ? res.url.trim() : '';
                return url;
              })
              .catch(function () {
                return '';
              });
          }
        }

        return uploadTask.then(function (officialUrl) {
          var photoUrl = officialUrl || '';
          var lat = signWay === 3 ? Number(task.latitude) : 0;
          var lng = signWay === 3 ? Number(task.longitude) : 0;
          if (!Number.isFinite(lat)) lat = 0;
          if (!Number.isFinite(lng)) lng = 0;
          var signModel = {
            Id: signId,
            ActivityId: id,
            SignWay: signWay,
            Type: task.action === 'signIn' ? 1 : 2,
            Latitude: lat,
            Longitude: lng,
            LocationData: '',
            Captcha: '',
            Photos: { Imgs: photoUrl ? [{ url: photoUrl, AddressName: '' }] : [], Files: [] },
            SystemId: '00000000-0000-0000-0000-000000000000',
          };
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
              accountId: account,
              activityName: String(task.activityName || ''),
              category: String(task.category || ''),
              stage: task.action === 'signIn' ? 'sign-in' : 'sign-out',
              config: config,
              deadlineMs: range.end,
              signWay: signWay,
              photo: photoUrl ? photoOrigin : 'none',
            },
            function () {
              return api.ek.signInOutByOthers({ requestsData: session, signModel: signModel });
            },
            classifyEkWrite,
          ).then(function (r) {
            if (r.status === 'success' && picked && picked.imageId) {
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

    // ── 官方成绩刷新（内部实现，供 run 自动调用与手动 refresh 共用） ──

    /**
     * 刷新官方成绩。
     *  - 按 lastAttemptAt 做 1h 节流（失败也记时间，避免每 tick 打接口）
     *  - 成功后写 store（写前 re-read 最新 accounts，避免并发覆盖其他账号/手动导入）
     *  - 失败保留旧 snapshot，仅更新 lastRefreshError / lastAttemptAt
     *  - preview 模式不落盘
     */
    function refreshScoresCore(options) {
      if (!ScorePolicy) return Promise.resolve({ ok: false, reason: 'score-policy-unavailable' });
      var config = getConfig();
      var cfg = (config.ek && config.ek.scorePolicy) || DEFAULTS.ek.scorePolicy;
      var account = currentEkAccount();
      if (!account) return Promise.resolve({ ok: false, reason: 'ek-not-logged-in' });
      var session = ekSession();
      if (!session) return Promise.resolve({ ok: false, reason: 'ek-not-logged-in' });
      if (!api.ek || typeof api.ek.getStudentScores !== 'function') {
        return Promise.resolve({ ok: false, reason: 'api-unavailable' });
      }

      var force = Boolean(options && options.force);
      var entry = scoreEntry(loadScores(), account) || {};
      var lastAttempt = Number(entry.lastAttemptAt) || Number(entry.refreshedAt) || 0;
      var interval = Math.max(0, Number(cfg.refreshIntervalMs) || DEFAULTS.ek.scorePolicy.refreshIntervalMs);
      if (!force && lastAttempt > 0 && now() - lastAttempt < interval) {
        return Promise.resolve({ ok: false, reason: 'refresh-throttled', refreshedAt: entry.refreshedAt || 0 });
      }

      var attemptAt = now();

      /**
       * 写 store 的唯一入口：re-read 最新 accounts 再合并本账号条目，
       * 防止异步刷新期间其他账号/手动导入被覆盖。
       */
      function persistEntry(patch) {
        var latest = loadScores();
        var prev = scoreEntry(latest, account) || {};
        latest.accounts[account] = {
          snapshot: patch.snapshot !== undefined ? patch.snapshot : prev.snapshot || null,
          refreshedAt: patch.refreshedAt !== undefined ? patch.refreshedAt : prev.refreshedAt || 0,
          lastAttemptAt: attemptAt,
          lastRefreshError: patch.lastRefreshError === undefined ? prev.lastRefreshError || null : patch.lastRefreshError,
        };
        saveScores(latest);
      }

      return Promise.resolve(api.ek.getStudentScores({ requestsData: session }))
        .then(function (resp) {
          var parsed = ScorePolicy.parseOfficialScores(resp);
          if (!parsed.ok) {
            persistEntry({ lastRefreshError: 'official-' + String(parsed.reason || 'untrusted') });
            return { ok: false, reason: 'official-untrusted', detail: parsed.reason };
          }
          var oldSnapshot = (scoreEntry(loadScores(), account) || {}).snapshot || null;
          var merged;
          try {
            merged = ScorePolicy.mergeOfficialSnapshot(oldSnapshot, parsed, account, now());
          } catch (e) {
            var reason = String(e && e.message ? e.message : e);
            var fixed = reason.indexOf('account-mismatch') >= 0 ? 'official-account-mismatch' : 'official-merge-failed';
            persistEntry({ lastRefreshError: fixed });
            return { ok: false, reason: fixed, stale: Boolean(oldSnapshot) };
          }
          persistEntry({ snapshot: merged, refreshedAt: now(), lastRefreshError: null });
          var policy = buildPolicy(getConfig());
          return {
            ok: true,
            snapshot: JSON.parse(JSON.stringify(merged)),
            stale: Boolean(policy.stale),
            unknown: parsed.unknown || [],
          };
        })
        .catch(function (e) {
          persistEntry({ lastRefreshError: 'official-request-failed' });
          logger.log('[score] 官方成绩刷新失败');
          return { ok: false, reason: 'official-request-failed' };
        });
    }

    /**
     * run 入口的自动刷新：仅当策略启用 + refreshOnStart 时按 1h 缓存尝试一次。
     * preview 也允许读（不落盘、不消耗真实预算）；失败静默（旧 snapshot 保留）。
     */
    function maybeAutoRefresh(config) {
      var cfg = (config.ek && config.ek.scorePolicy) || DEFAULTS.ek.scorePolicy;
      if (cfg.enabled === false) return Promise.resolve(null);
      if (cfg.refreshOnStart === false) return Promise.resolve(null);
      if (!api.ek || typeof api.ek.getStudentScores !== 'function') return Promise.resolve(null);
      if (!currentEkAccount()) return Promise.resolve(null);
      return refreshScoresCore({ force: false }).catch(function () {
        return null;
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
      // 每轮重置扫描汇总，避免 ek 关闭时仍展示上一轮统计
      lastEkScan = null;
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
          // 自动刷新官方成绩：仅策略启用时按 1h 缓存尝试；失败保留旧 snapshot（不阻断）
          if (stopped) return null;
          return maybeAutoRefresh(config);
        })
        .then(function () {
          if (stopped) return null;
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
          return {
            results: stamped,
            summary: summary,
            ekScan: lastEkScan ? JSON.parse(JSON.stringify(lastEkScan)) : null,
            dryRun: Boolean(config.dryRun),
            at: now(),
          };
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
          // 当前选中的 Tanma 账号 id（供 dashboard 按 module-specific 账号过滤，不暴露手机号）
          unirunAccountId: u ? String(u.id) : '',
          unirunAccounts: accounts.items.map(function (a) {
            return { id: a.id, remark: a.remark, selected: a.id === (u && u.id) };
          }),
        };
      },
      resetState: function () {
        saveState({
          done: {},
          inflight: {},
          failed: {},
          usedImages: {},
          daily: {},
          qrChecks: {},
          photoChecks: {},
          watchedEk: {},
          ekFinished: {},
          // 重置即清空当天随机窗口：下次运行会重新随机（符合「重置=回到初始」语义）
          unirunWindow: {},
        });
      },

      // ── 积分缺口策略 API ──────────────────────────────────

      /** 当前账号的 snapshot（不含 stale/accountMatch 元数据；元数据见 getScorePolicyStatus） */
      getScoreSnapshot: function () {
        var config = getConfig();
        var snapshot = effectiveSnapshot(config);
        return snapshot ? JSON.parse(JSON.stringify(snapshot)) : null;
      },

      /** 策略元数据：enabled/trusted/accountMatch/stale/reason/gaps/satisfiedModules/refreshedAt/source */
      getScorePolicyStatus: function () {
        var config = getConfig();
        var policy = buildPolicy(config);
        var account = currentEkAccount();
        var entry = scoreEntry(loadScores(), account) || {};
        return {
          enabled: policy.enabled,
          trusted: policy.trusted,
          accountMatch: policy.accountMatch,
          stale: policy.stale,
          reason: policy.reason,
          accountId: policy.accountId || '',
          source: policy.source || 'unknown',
          refreshedAt: policy.refreshedAt,
          updatedAt: policy.refreshedAt,
          lastAttemptAt: Number(entry.lastAttemptAt) || null,
          lastRefreshError: entry.lastRefreshError ? String(entry.lastRefreshError) : null,
          totalGap: policy.totalGap === undefined ? null : policy.totalGap,
          gaps: policy.gaps || [],
          satisfiedModules: policy.satisfiedModules || [],
        };
      },

      /** 截图初值模板（未绑定账号；UI 需再调 importScoreSnapshot 绑定当前账号） */
      getScreenshotInitialSnapshot: function () {
        if (!ScorePolicy) return null;
        return {
          accountId: '',
          source: 'manual',
          updatedAt: now(),
          modules: ScorePolicy.getScreenshotInitialModules(),
        };
      },

      /**
       * 导入 snapshot 并绑定当前二课账号。
       *  - 模板（accountId 为空）：允许绑定当前账号
       *  - 已绑定其他账号：拒绝（不静默重绑）
       */
      importScoreSnapshot: function (snapshot) {
        if (!ScorePolicy) return { ok: false, reason: 'score-policy-unavailable' };
        var account = currentEkAccount();
        if (!account) return { ok: false, reason: 'ek-not-logged-in' };

        var incomingAccount = snapshot && snapshot.accountId ? String(snapshot.accountId) : '';
        if (incomingAccount && incomingAccount !== account) {
          return { ok: false, reason: 'account-mismatch' };
        }

        var built;
        try {
          built = ScorePolicy.buildSnapshot({
            accountId: account,
            source: (snapshot && snapshot.source) || 'manual',
            updatedAt: (snapshot && snapshot.updatedAt) || now(),
            accountVerified: Boolean(snapshot && snapshot.accountVerified),
            modules: (snapshot && snapshot.modules) || [],
          });
        } catch (e) {
          return { ok: false, reason: sanitizeError(e) };
        }

        var scores = loadScores();
        scores.accounts[account] = {
          snapshot: built,
          refreshedAt: built.updatedAt,
          lastRefreshError: null,
        };
        try {
          saveScores(scores);
        } catch (e) {
          return { ok: false, reason: 'storage-error' };
        }
        logger.log('[score] snapshot 已绑定账号并保存');
        return { ok: true, snapshot: JSON.parse(JSON.stringify(built)) };
      },

      /**
       * 刷新官方成绩（每小时最多一次；force 绕过）。实现见内部 refreshScoresCore。
       */
      refreshScores: function (options) {
        return refreshScoresCore(options);
      },
    };
  }

  return {
    DEFAULTS: DEFAULTS,
    STATE_KEY: STATE_KEY,
    CONFIG_KEY: CONFIG_KEY,
    SCORES_KEY: SCORES_KEY,
    KEYS: { ekSession: EK_KEY, unirunAccounts: UNIRUN_ACCOUNTS_KEY, scores: SCORES_KEY },
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
    ekSignExpireAt: ekSignExpireAt,
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
