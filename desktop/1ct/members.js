/**
 * OneCTMembers —— 1CT 多成员层（UMD，零依赖）。
 *
 * 职责（契约 docs/1ct-redesign-contract.md §2/§3）：
 *  1. 成员 CRUD（`1ct:members`）：不做字段白名单裁剪，未知字段原样保留，
 *     这样 `ekCredentials` / `ekStatus` / 未来扩展字段都不会被吃掉；
 *  2. 引擎 storage 适配：把引擎固定的 `auto3ct:state|config|scores` 与
 *     `ct_ek_session_v1` / `ct_unirun_accounts_v1` 映射到成员维度，
 *     引擎内部逻辑一行不改，成员之间状态/积分/会话完全隔离；
 *  3. 生效 config：`deepMerge(1ct:config:global, 1ct:config:<id>)`；
 *     成员层永远不落 `dryRun`（预览开关只属于全局，防止成员覆盖把真实写打开）；
 *  4. 二课凭证：`loginEk`（学号+密码 → 会话）/ `refreshEk`（续期）/ `setEkSession`；
 *  5. 校园跑账号可用性：`verifyUnirun`（只验证，不落盘 token）；
 *  6. runAll：串行、单飞、成员级异常隔离，每条 result 注入 memberId/memberName，
 *     并写全局结果历史 `1ct:results`；
 *  7. 官方成绩同步（取消「手填八模块」）：`syncOfficialScores` / `syncAllOfficialScores`
 *     用成员自己的 ek 会话拉官方 `getStudentScores`，TypeList 定值、Info.AGetNum..JGetNum
 *     交叉校验；成功后同时写 `member.ekModules`（+ ekModulesSource / ekModulesUpdatedAt）
 *     与引擎格式 `1ct:scores:<id>`；失败只更新 lastRefreshError，绝不覆盖旧值。
 *
 * 安全口径（硬要求）：
 *  - 成员里必须存密码（调用 IPC 需要），但**日志 / 结果 / 导出**一律剔除：
 *    logger 只输出固定 code 与成员 id/name，结果白名单不含任何凭证字段，
 *    `exportMembers()` / `toPublicMember()` 去掉 ekCredentials、ek token，
 *    校园跑手机号一律 `138****0000` 掩码；
 *  - 错误文本统一 `sanitizeError`（抹 password/token/JSESSIONID/完整手机号）；
 *  - 结果事件 key 中若混入手机号会被哈希替换，不落完整号。
 *
 * 用法：
 *   Node:    const M = require('./1ct/members.js');
 *            const members = M.createMembers({storage, clock, automation});
 *   Browser: <script src="members.js"></script> → window.OneCTMembers（默认单例）
 *            单例方法直接作用于 localStorage。
 *
 * 结果仓库说明：`Auto3CTResults` 的事件白名单不含 memberId（result-store.js 冻结不改），
 * 所以本模块自带一个口径一致的结果写入器（2000 条上限 / 90 天 / 同 key upsert /
 * success 不被 skipped 降级），白名单 = result-store 白名单 + memberId/memberName。
 * UI/统计请用 `loadResults()` 读（保留 memberId）；`resultsStorage()` 仍按契约提供，
 * 供 Auto3CTResults 做兜底读写。
 */
(function (root, factory) {
  'use strict';
  var mod = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = mod;
  if (root) root.OneCTMembers = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  // ─────────────────────────── 存储键（契约 §2，冻结） ───────────────────────────

  var MEMBERS_KEY = '1ct:members';
  var GLOBAL_CONFIG_KEY = '1ct:config:global';
  var CONFIG_PREFIX = '1ct:config:';
  var STATE_PREFIX = '1ct:state:';
  var SCORES_PREFIX = '1ct:scores:';
  var RESULTS_KEY = '1ct:results';

  /** 引擎固定 key（automation.js: STATE_KEY/CONFIG_KEY/SCORES_KEY/EK_KEY/UNIRUN_ACCOUNTS_KEY） */
  var ENGINE_KEYS = {
    state: 'auto3ct:state',
    config: 'auto3ct:config',
    scores: 'auto3ct:scores',
    ekSession: 'ct_ek_session_v1',
    unirunAccounts: 'ct_unirun_accounts_v1',
  };
  var ENGINE_FALLBACK_PREFIX = '1ct:engine:';
  var RESULTS_FALLBACK_PREFIX = '1ct:results-k:';

  var MEMBERS_VERSION = 1;
  var RESULTS_VERSION = 1;
  var MAX_RESULTS_EVENTS = 2000;
  var RESULT_RETAIN_DAYS = 90;
  var DAY_MS = 24 * 60 * 60 * 1000;
  var BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
  var PHONE_RE = /^1\d{10}$/;

  /** automation.DEFAULTS 不可用时的最小默认（dryRun 默认 true 是安全底线） */
  var FALLBACK_DEFAULTS = { dryRun: true };

  /** upsert 时整块替换而不是合并的字段（会话必须整体覆盖，避免旧 token 残留） */
  var REPLACE_FIELDS = { ek: true };

  /** Member 已知字段（仅用于默认值归一，不做白名单裁剪） */
  var MEMBER_DEFAULTS = {
    name: '',
    note: '',
    enabled: true,
    ek: null,
    ekStatus: 'none',
    ekCredentials: null,
    unirun: null,
    ekModules: null,
    ekModulesSource: null,
    ekModulesUpdatedAt: null,
  };

  // ─────────────────── 官方二课成绩（八模块，口径同 score-policy.js MODULES） ───────────────────
  //
  // 数据来源：`window.ctAPI.ek.getStudentScores({requestsData: member.ek})`
  //   -> { Info:{SumGetNum, AGetNum..JGetNum, StudentId...},
  //        TypeList:[{CurriculumName, SumScore, ScoreList}] }
  // 解析口径：
  //   - TypeList 的 CurriculumName 与下面 8 个模块名精确匹配（与 score-policy.MODULES 完全一致）；
  //   - Info 的 AGetNum..JGetNum 作为**交叉校验**：每个模块 SumScore 必须能在 Info 里找到同值字段
  //     （多重集 + 容差匹配，绝不「取其中一个凑数」）；SumGetNum 与 Info 各字段之和/模块总分对账。
  //   - 校验不一致 -> 整份不可信（untrusted），**不写入任何一处存储**，保留旧值。
  /** 八模块固定名称与 required（与 desktop/score-policy.js MODULES 逐字一致，不随上游变化） */
  var SCORE_MODULES = [
    { name: '思想政治与道德修养', required: 12 },
    { name: '学术科技与创新创业', required: 8 },
    { name: '艺术体验与审美修养', required: 12 },
    { name: '传统文化与人文素养', required: 8 },
    { name: '人际交往与沟通能力', required: 8 },
    { name: '心理素质与身体素质', required: 12 },
    { name: '社会实践与志愿服务', required: 12 },
    { name: '社会工作与能力拓展', required: 8 },
  ];
  var SCORE_MODULE_SET = SCORE_MODULES.reduce(function (acc, module) {
    acc[module.name] = true;
    return acc;
  }, {});
  /** 官方 Info 里参与交叉校验的分项字段（A..J 共 10 个；未用到的字母通常为 0/空串） */
  var INFO_SCORE_KEYS = [
    'AGetNum',
    'BGetNum',
    'CGetNum',
    'DGetNum',
    'EGetNum',
    'FGetNum',
    'GGetNum',
    'HGetNum',
    'IGetNum',
    'JGetNum',
  ];
  /** 上游分数是 "6.000" 这类字符串：比较时给 0.01 容差，避免浮点表示差异误判不可信 */
  var SCORE_DIFF_TOLERANCE = 0.01;
  /** syncAllOfficialScores 默认节流：6 小时内已由官方同步过的成员不再重复请求 */
  var SCORE_SYNC_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;
  /** 官方成绩失败原因固定码（UI 只展示映射后的中文，不透传上游原文） */
  var SCORE_SYNC_PREVIEW_REASON = 'preview-blocked';

  // ─────────────────────────── 基础工具 ───────────────────────────

  function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function clone(value) {
    if (value === null || value === undefined) return value;
    return JSON.parse(JSON.stringify(value));
  }

  function text(value, maxLen) {
    if (value === null || value === undefined) return '';
    var str = String(value).trim();
    if (maxLen && str.length > maxLen) str = str.slice(0, maxLen);
    return str;
  }

  function finiteOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    var number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function deepMerge() {
    var out = {};
    for (var i = 0; i < arguments.length; i += 1) {
      var src = arguments[i];
      if (!isPlainObject(src)) continue;
      Object.keys(src).forEach(function (key) {
        var value = src[key];
        if (value === undefined) return;
        if (isPlainObject(value)) out[key] = deepMerge(out[key] || {}, value);
        else if (Array.isArray(value)) out[key] = value.slice();
        else out[key] = value;
      });
    }
    return out;
  }

  /** 去掉顶层 dryRun：成员覆盖层 / 引擎持久配置都不允许携带预览开关。 */
  function stripDryRun(config) {
    if (!isPlainObject(config)) return {};
    var out = {};
    Object.keys(config).forEach(function (key) {
      if (key !== 'dryRun') out[key] = config[key];
    });
    return out;
  }

  function hasOwn(obj, key) {
    return isPlainObject(obj) && Object.prototype.hasOwnProperty.call(obj, key);
  }

  function beijingDay(atMs) {
    var value = Number(atMs);
    if (!Number.isFinite(value)) value = 0;
    return new Date(value + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
  }

  function maskPhone(phone) {
    var value = text(phone);
    if (!PHONE_RE.test(value)) return value;
    return value.replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2');
  }

  /** 手机号/敏感串不可逆哈希（结果 key 去敏用，与 result-store 同算法）。 */
  function hashToken(value) {
    var str = text(value);
    var hash = 2166136261;
    for (var i = 0; i < str.length; i += 1) {
      hash ^= str.charCodeAt(i);
      hash = (hash * 16777619) >>> 0;
    }
    return 'h' + hash.toString(36);
  }

  /** 错误文本脱敏：绝不把 token/密码/完整手机号带进日志或返回值。 */
  function sanitizeError(error) {
    var message = error && error.message ? String(error.message) : String(error == null ? '' : error);
    return message
      .replace(/(password|passwd|access_token|refresh_token|JSESSIONID|token|student_id)\s*[:=]\s*[^\s,;]+/gi, '$1=***')
      .replace(/\b1[3-9]\d{9}\b/g, '1**********')
      .replace(/\s+/g, ' ')
      .slice(0, 140);
  }

  /** 固定 code 的错误（不把上游原文透出，原文只挂在 cause 且已脱敏）。 */
  function fixedError(code, cause) {
    var err = new Error(code);
    err.code = code;
    if (cause !== undefined) err.cause = sanitizeError(cause);
    return err;
  }

  function normalizeLogger(logger) {
    if (logger && typeof logger.log === 'function') {
      return {
        log: function (message) {
          try {
            logger.log(String(message));
          } catch (e) {
            /* 日志回调异常不影响业务 */
          }
        },
      };
    }
    if (typeof logger === 'function') {
      return {
        log: function (message) {
          try {
            logger(String(message));
          } catch (e) {
            /* ignore */
          }
        },
      };
    }
    return { log: function () {} };
  }

  function newId() {
    var hex = '';
    for (var i = 0; i < 8; i += 1) hex += Math.floor(Math.random() * 16).toString(16);
    return 'm_' + hex;
  }

  /** 安全读时钟：注入 clock 抛错/返回非数字时退回 Date.now()（runAll 不能因时钟崩）。 */
  function safeNow(clock) {
    try {
      var value = Number(clock && typeof clock.now === 'function' ? clock.now() : Date.now());
      return Number.isFinite(value) ? value : Date.now();
    } catch (e) {
      return Date.now();
    }
  }

  // ─────────────────────────── 引擎依赖解析 ───────────────────────────

  /** 严格解析注入的引擎模块：显式注入但形状不对 → null（不静默回落全局，便于测试/多实例）。 */
  function resolveInjectedAutomation(candidate) {
    if (!candidate) return null;
    if (typeof candidate.createEngine === 'function') return candidate;
    if (typeof candidate === 'function') return { createEngine: candidate };
    if (candidate.automation && typeof candidate.automation.createEngine === 'function') {
      return candidate.automation;
    }
    return null;
  }

  function resolveAutomation(preferred) {
    var injected = resolveInjectedAutomation(preferred);
    if (injected) return injected;
    if (root && root.Auto3CTAutomation && typeof root.Auto3CTAutomation.createEngine === 'function') {
      return root.Auto3CTAutomation;
    }
    try {
      /* Node：members.js 位于 desktop/1ct/，引擎在 desktop/automation.js */
      if (typeof require === 'function') {
        var loaded = require('../automation.js');
        if (loaded && typeof loaded.createEngine === 'function') return loaded;
      }
    } catch (e) {
      /* 浏览器环境无 require */
    }
    return null;
  }

  function resolveCtApi(preferred) {
    if (preferred) return preferred;
    if (root && root.ctAPI) return root.ctAPI;
    return null;
  }

  function defaultClock() {
    return {
      now: function () {
        return Date.now();
      },
    };
  }

  function localStorageAdapter() {
    var ls = null;
    try {
      if (typeof localStorage !== 'undefined' && localStorage) ls = localStorage;
    } catch (e) {
      ls = null;
    }
    if (!ls) {
      throw new Error('OneCTMembers 需要 storage（浏览器需 localStorage）');
    }
    return {
      get: function (key) {
        return ls.getItem(key);
      },
      set: function (key, value) {
        ls.setItem(key, String(value));
      },
      remove: function (key) {
        ls.removeItem(key);
      },
    };
  }

  // ─────────────────────────── 成员模型 ───────────────────────────

  function normalizeEkStatus(value, session) {
    var hasSession = Boolean(session);
    if (value === 'ok') return hasSession ? 'ok' : 'expired';
    if (value === 'expired') return 'expired';
    if (value === 'none') return 'none';
    // 未显式给状态：有会话即视为可用，否则 none
    return hasSession ? 'ok' : 'none';
  }

  /**
   * 归一化 Member：补齐契约字段默认值，**其余字段原样保留**（不裁剪）。
   * 注意：这里会给缺失的 id 生成新 id，正式写入必须走 upsertMember。
   */
  function normalizeMember(raw, nowMs) {
    if (!isPlainObject(raw)) return null;
    var member = clone(raw);
    member.id = text(member.id) || newId();
    member.name = member.name === undefined || member.name === null ? MEMBER_DEFAULTS.name : String(member.name);
    member.note = member.note === undefined || member.note === null ? MEMBER_DEFAULTS.note : String(member.note);
    member.enabled = member.enabled === undefined ? MEMBER_DEFAULTS.enabled : Boolean(member.enabled);
    member.ek = isPlainObject(member.ek) ? member.ek : null;
    member.ekCredentials = isPlainObject(member.ekCredentials) ? member.ekCredentials : null;
    member.unirun = isPlainObject(member.unirun) ? member.unirun : null;
    member.ekModules = Array.isArray(member.ekModules) ? member.ekModules : null;
    member.ekModulesSource = normalizeModulesSource(member.ekModulesSource, member.ekModules);
    member.ekModulesUpdatedAt = finiteOrNull(member.ekModulesUpdatedAt);
    member.ekStatus = normalizeEkStatus(member.ekStatus, member.ek);
    var createdAt = finiteOrNull(member.createdAt);
    var updatedAt = finiteOrNull(member.updatedAt);
    member.createdAt = createdAt === null ? nowMs : createdAt;
    member.updatedAt = updatedAt === null ? member.createdAt : updatedAt;
    member.ekUpdatedAt = finiteOrNull(member.ekUpdatedAt);
    return member;
  }

  /**
   * 八模块数据来源：'official'（官方接口同步）| 'manual'（手工/导入）| null（无数据）。
   * 口径：
   *  - 有 ekModules 但来源未知（历史数据）→ 'manual'（不能冒充官方数据）；
   *  - 无 ekModules → null（来源标记无意义，不伪造）。
   */
  function normalizeModulesSource(value, modules) {
    var hasModules = Array.isArray(modules) && modules.length > 0;
    if (!hasModules) return null;
    if (value === 'official') return 'official';
    return 'manual';
  }

  function memberSession(member) {
    if (!member || !isPlainObject(member.ek)) return null;
    var session = member.ek;
    if (!text(session.JSESSIONID) || !text(session.access_token)) return null;
    return session;
  }

  function memberCredentials(member) {
    if (!member || !isPlainObject(member.ekCredentials)) return null;
    var studentId = text(member.ekCredentials.studentId || member.ekCredentials.student_id);
    var password = member.ekCredentials.password == null ? '' : String(member.ekCredentials.password);
    if (!studentId || !password) return null;
    return { studentId: studentId, password: password };
  }

  /** 校园跑/俱乐部账号 → 引擎期望的 `ct_unirun_accounts_v1` 形状 */
  function unirunAccountsPayload(member) {
    var account = member && isPlainObject(member.unirun) ? member.unirun : null;
    if (!account) return { selectedId: null, items: [] };
    var id = text(account.id) || 'member-' + text(member.id);
    return {
      selectedId: id,
      items: [
        {
          id: id,
          phone: text(account.phone),
          password: account.password == null ? '' : String(account.password),
          remark: text(account.remark),
          updatedAt: finiteOrNull(account.updatedAt) || 0,
        },
      ],
    };
  }

  // ─────────────────── 官方二课成绩：解析 + 交叉校验 ───────────────────
  //
  // 上游响应（真实链路：GetStuList → 逐学年 GetStuDetail → 主进程 mergeScores 合并）：
  //   { Info:{StudentId, SumGetNum, AGetNum..JGetNum, ...},
  //     TypeList:[{CurriculumName, SumScore, ScoreList:[...]}] }
  // 关键口径（fail-closed，绝不「取一个」）：
  //  - 8 个模块名必须与 SCORE_MODULES 精确匹配（上游多出/缺失都记录，不擅自归 0）；
  //  - TypeList 里同一模块重复出现 → untrusted；
  //  - Info 的 AGetNum..JGetNum 与 TypeList 的 8 个 SumScore 做**多重集匹配**（容差 0.01）：
  //    每个模块分都能找到一个「未被占用且数值相同」的 Info 字段才算校验通过；
  //    任何一项对不上 → untrusted（不静默取一个）；
  //  - 交叉校验没提供（Info 缺失/全空）同样按 untrusted 处理，不假装通过。

  /** 数值归一：null/undefined/'' -> null；其余能转有限数的转数字（缺失绝不当 0） */
  function scoreNumberOrNull(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string' && value.trim() === '') return null;
    var number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  /** 两位小数归一（上游是 "6.000" 这类字符串，落盘前统一成 6） */
  function roundScore(number) {
    return Math.round(number * 100) / 100;
  }

  function scoreEqual(left, right) {
    return Math.abs(left - right) <= SCORE_DIFF_TOLERANCE;
  }

  /**
   * Info → 参与交叉校验的分项分数数组。
   * 只收 AGetNum..JGetNum 中能解析成有限数的项；全空返回空数组（= 没给交叉校验）。
   */
  function infoCrossCheckValues(info) {
    var values = [];
    if (!isPlainObject(info)) return values;
    for (var i = 0; i < INFO_SCORE_KEYS.length; i += 1) {
      var key = INFO_SCORE_KEYS[i];
      var number = scoreNumberOrNull(info[key]);
      if (number !== null) values.push(number);
    }
    return values;
  }

  /**
   * 多重集匹配：每个待校验分值都必须找到一个未被占用的 Info 字段与之相等（容差 0.01）。
   *
   * 口径说明（刻意区分「致命」与「诊断」）：
   *  - 致命：某个模块的 SumScore 在 Info 里找不到同值字段 → 两份数据互相矛盾，整份不可信；
   *  - 非致命：Info 里**多出**未被匹配的分项值。官方 Info 有 10 个分项槽（A..J），
   *    而策略只关心 8 个模块，结构性差异会出现多余槽位，因此多出来的值只记录为诊断，
   *    绝不因为「多出」就判不可信（否则所有真实账号都会被误判）。
   * @returns {{ok:boolean, reason?:string, unmatched?:Array<number>}}
   */
  function crossCheckAgainstInfo(scores, infoValues) {
    if (!infoValues || infoValues.length === 0) return { ok: false, reason: 'info-crosscheck-missing' };
    var used = [];
    for (var i = 0; i < infoValues.length; i += 1) used.push(false);
    for (var s = 0; s < scores.length; s += 1) {
      var matched = false;
      for (var j = 0; j < infoValues.length; j += 1) {
        if (used[j]) continue;
        if (scoreEqual(scores[s], infoValues[j])) {
          used[j] = true;
          matched = true;
          break;
        }
      }
      if (!matched) return { ok: false, reason: 'info-crosscheck-mismatch' };
    }
    var unmatched = [];
    for (var k = 0; k < infoValues.length; k += 1) {
      if (!used[k]) unmatched.push(infoValues[k]);
    }
    return { ok: true, unmatched: unmatched };
  }

  /**
   * 位置交叉校验（主口径）：Info 的 AGetNum..HGetNum 与 SCORE_MODULES 的 8 个模块
   * **按数组顺序一一对应**（A→思想政治…H→社会工作），数值必须一致（容差 0.01）。
   * 这是任务口径「H=A..J 对应 8 个模块，SumScore 必须与对应 GetNum 一致」的直接实现。
   * IGetNum / JGetNum 是第 9/10 个槽位（策略外），不参与模块校验。
   * @returns {{ok:boolean, compared:number, missing:Array<string>, mismatch?:{name,expected,got}}}
   */
  function positionalCrossCheck(byName) {
    var compared = 0;
    var missing = [];
    for (var i = 0; i < SCORE_MODULES.length; i += 1) {
      var key = INFO_SCORE_KEYS[i];
      var defined = SCORE_MODULES[i];
      var expected = infoValue(byName.info, key);
      if (expected === null) {
        missing.push(defined.name);
        continue;
      }
      var got = scoreNumberOrNull(byName.values[defined.name]);
      if (got === null) continue; // 上游没给该模块分：无可比对，不算不匹配
      compared += 1;
      if (!scoreEqual(got, expected)) {
        return {
          ok: false,
          compared: compared,
          missing: missing,
          mismatch: { name: defined.name, expected: expected, got: got },
        };
      }
    }
    return { ok: missing.length === 0, compared: compared, missing: missing };
  }

  function infoValue(info, key) {
    if (!isPlainObject(info)) return null;
    return scoreNumberOrNull(info[key]);
  }

  /**
   * 解析官方成绩响应。
   * @returns {{ok:boolean, reason?:string, modules?:Array, unknown?:Array, accountHint?:string}}
   *  ok:true 时 modules 是 8 项 {name, required, current}（顺序固定 = SCORE_MODULES），
   *  current 为 null 表示上游未给出该模块（不可信，但保留缺口不按 0 算）。
   */
  function parseOfficialScoreResponse(resp) {
    if (!isPlainObject(resp)) return { ok: false, reason: 'response-empty' };
    var typeList = Array.isArray(resp.TypeList) ? resp.TypeList : null;
    if (!typeList || typeList.length === 0) return { ok: false, reason: 'response-empty' };

    var byName = {};
    var unknown = [];
    var duplicates = [];
    var recognizedCount = 0;
    for (var i = 0; i < typeList.length; i += 1) {
      var item = typeList[i];
      if (!isPlainObject(item)) continue;
      var name = text(item.CurriculumName);
      if (!name) continue;
      var current = scoreNumberOrNull(item.SumScore);
      if (!SCORE_MODULE_SET[name]) {
        // 官方出现了策略外模块：记录但不参与（更不按 0 均摊）
        if (current !== null) unknown.push({ name: name, current: roundScore(current) });
        continue;
      }
      if (hasOwn(byName, name)) {
        duplicates.push(name);
        continue;
      }
      recognizedCount += 1;
      byName[name] = current === null ? null : roundScore(current);
    }
    if (duplicates.length > 0) return { ok: false, reason: 'duplicate-module' };
    if (recognizedCount === 0) return { ok: false, reason: 'no-recognized-module' };

    // Info 交叉校验：TypeList 里**实际给出**的 8 模块分值 vs Info.AGetNum..JGetNum
    var providedScores = [];
    for (var m = 0; m < SCORE_MODULES.length; m += 1) {
      var found = byName[SCORE_MODULES[m].name];
      if (found === null || found === undefined) continue;
      providedScores.push(found);
    }
    if (providedScores.length === 0) return { ok: false, reason: 'no-recognized-module' };
    var infoValues = infoCrossCheckValues(resp.Info);
    var crossCheck = crossCheckAgainstInfo(providedScores, infoValues);
    if (!crossCheck.ok) return { ok: false, reason: crossCheck.reason, unknown: unknown };

    // 模块清单：固定顺序，上游缺失的模块 current = null（gap 未知，不按 0）
    var modules = SCORE_MODULES.map(function (defined) {
      var current = hasOwn(byName, defined.name) ? byName[defined.name] : null;
      var out = { name: defined.name, required: defined.required, current: current };
      if (current === null) out.trusted = false;
      return out;
    });

    var info = isPlainObject(resp.Info) ? resp.Info : {};
    var accountHint = text(info.StudentId) || text(info.LoginName) || text(info.StudentNo);
    return {
      ok: true,
      modules: modules,
      unknown: unknown,
      accountHint: accountHint,
      crossChecked: true,
    };
  }

  /**
   * 官方成绩 → 引擎 score-policy snapshot（写进 `1ct:scores:<id>` 的 accounts[accountId]）。
   * 口径与 score-policy.buildSnapshot 兼容：{accountId, source:'official', updatedAt, accountVerified, modules}。
   * modules 里带 trusted 标记（current 缺失 → trusted:false）。
   */
  function buildOfficialSnapshot(accountId, parsed, updatedAt) {
    var modules = (parsed.modules || []).map(function (module) {
      return {
        name: module.name,
        required: module.required,
        current: module.current,
        trusted: module.current !== null,
      };
    });
    return {
      accountId: text(accountId),
      source: 'official',
      updatedAt: updatedAt,
      accountVerified: Boolean(text(parsed.accountHint)),
      modules: modules,
    };
  }

  /** 成员 ekModules（8 项 {name, required, current}）← 官方解析结果 */
  function modulesFromParsed(parsed) {
    return (parsed.modules || []).map(function (module) {
      var out = { name: module.name, required: module.required, current: module.current };
      // 上游缺失该模块：显式标不可信，让统计侧按「未知」处理而不是 0
      if (module.current === null) out.trusted = false;
      return out;
    });
  }

  // ─────────────────────────── 结果事件（口径同 result-store） ───────────────────────────

  var RESULT_STATUSES = {
    success: true,
    failed: true,
    unknown: true,
    'waiting-material': true,
    'not-yet': true,
    blocked: true,
    skipped: true,
    retry: true,
    legacy: true,
  };

  /** 白名单 = result-store ALLOWED_FIELDS + memberId/memberName（契约 §2 要求）。 */
  var RESULT_ALLOWED_FIELDS = [
    'key',
    'at',
    'day',
    'accountId',
    'accountMask',
    'module',
    'action',
    'activityId',
    'activityName',
    'category',
    'status',
    'reason',
    'stage',
    'distanceMeters',
    'attempt',
    'preview',
    'dryRun',
    'legacy',
    'source',
    'memberId',
    'memberName',
  ];

  var REASON_CODE_RE = /^[a-z][a-z0-9-]{0,63}$/;

  /** 账号身份脱敏：完整手机号不可落库（与 result-store 同口径：opaque id 保留，手机号转哈希）。 */
  function normalizeAccountId(raw) {
    var id = text(raw);
    if (!id) return '';
    if (PHONE_RE.test(id)) return 'phone-' + hashToken(id);
    return id;
  }

  function maskAccount(raw) {
    var id = text(raw);
    if (!id) return '';
    if (PHONE_RE.test(id)) return maskPhone(id);
    if (id.length <= 4) return id.charAt(0) + '***';
    return id.slice(0, 2) + '***' + id.slice(-2);
  }

  function sanitizeReason(raw) {
    var reason = text(raw, 300);
    if (!reason) return '';
    if (REASON_CODE_RE.test(reason)) return reason;
    return 'suppressed-untrusted-reason';
  }

  function sanitizeResultKey(rawKey) {
    var key = text(rawKey, 240);
    if (!key) return '';
    key = key.replace(/\b1\d{10}\b/g, function (phone) {
      return 'phone-' + hashToken(phone);
    });
    if (/token|password|passwd|cookie|secret/i.test(key)) {
      key = key.replace(/(token|password|passwd|cookie|secret)[^|:;\s]*/gi, function (matched) {
        return matched.split(/[=:]/)[0] + '=redacted';
      });
    }
    return key;
  }

  function normalizeResultStatus(raw) {
    var status = text(raw).toLowerCase().replace(/_/g, '-');
    if (status === 'dry-run' || status === 'preview') return null; // 预览绝不入库
    if (status === 'already-done') return 'skipped';
    if (!status) return 'unknown';
    if (RESULT_STATUSES[status]) return status;
    return 'unknown';
  }

  function sanitizeResult(event) {
    var out = {};
    for (var i = 0; i < RESULT_ALLOWED_FIELDS.length; i += 1) {
      var field = RESULT_ALLOWED_FIELDS[i];
      var value = event[field];
      if (value !== undefined && value !== null && value !== '') out[field] = value;
    }
    out.preview = false;
    out.dryRun = false;
    if (!out.day) out.day = beijingDay(out.at);
    return out;
  }

  /** 任意输入 → 可持久化事件；返回 null 表示拒绝（预览/无效/无身份）。 */
  function normalizeResult(raw, defaults) {
    if (!isPlainObject(raw)) return null;
    var base = defaults || {};
    if (raw.preview === true || raw.dryRun === true) return null;
    if (base.preview === true || base.dryRun === true) return null;
    var rawStatus = text(raw.status).toLowerCase().replace(/_/g, '-');
    if (rawStatus === 'dry-run' || rawStatus === 'dry_run' || rawStatus === 'preview') return null;

    var key = sanitizeResultKey(raw.key || raw.dedupeKey || base.key);
    var memberId = text(raw.memberId || base.memberId);
    if (!key) {
      var synthAccount = text(raw.accountId || base.accountId);
      var synthModule = text(raw.module || base.module).toLowerCase();
      var synthAction = text(raw.action || base.action);
      if (synthAccount && synthModule && synthAction) {
        var synthAt = finiteOrNull(raw.at);
        var synthDay = beijingDay(synthAt === null ? 0 : synthAt);
        var synthActivity = text(raw.activityId || raw.activityName);
        key = sanitizeResultKey(
          ['auto', synthDay, synthAccount, synthModule, synthAction, synthActivity].join('|'),
        );
      }
    }
    if (!key) return null;

    var at = finiteOrNull(raw.at);
    if (at === null) at = finiteOrNull(base.at);
    if (at === null) at = finiteOrNull(base.now);

    var status = normalizeResultStatus(raw.status);
    if (status === null) return null;

    var rawAccount = text(raw.accountId || base.accountId);
    var event = {
      key: key,
      at: at === null ? 0 : at,
      day: /^\d{4}-\d{2}-\d{2}$/.test(text(raw.day)) ? text(raw.day).slice(0, 10) : null,
      accountId: normalizeAccountId(rawAccount),
      accountMask: text(raw.accountMask) || maskAccount(rawAccount),
      module: text(raw.module || base.module || 'unknown').toLowerCase(),
      action: text(raw.action || base.action || 'unknown'),
      activityId: text(raw.activityId),
      activityName: text(raw.activityName, 200),
      category: text(raw.category),
      status: status,
      reason: sanitizeReason(raw.reason),
      stage: text(raw.stage),
      distanceMeters: finiteOrNull(raw.distanceMeters),
      attempt: finiteOrNull(raw.attempt),
      preview: false,
      dryRun: false,
      legacy: raw.legacy === true,
      source: text(raw.source) || (raw.legacy === true ? 'legacy' : 'auto'),
      memberId: memberId,
      memberName: text(raw.memberName || base.memberName, 120),
    };
    if (!event.day) event.day = beijingDay(event.at);
    if (event.attempt !== null) event.attempt = Math.max(0, Math.round(event.attempt));
    if (event.distanceMeters !== null && event.distanceMeters < 0) event.distanceMeters = null;
    if (event.legacy) {
      event.activityName = '';
      event.distanceMeters = null;
      event.stage = '';
    }
    return sanitizeResult(event);
  }

  function resultIdentity(event) {
    return text(event.memberId) + '\u0001' + text(event.key);
  }

  /** 同 key 合并：保留首次信息，更丰富的字段补缺；success 不被 skipped/legacy 降级。 */
  function mergeResult(existing, incoming) {
    var merged = {};
    for (var i = 0; i < RESULT_ALLOWED_FIELDS.length; i += 1) {
      var field = RESULT_ALLOWED_FIELDS[i];
      if (existing[field] !== undefined) merged[field] = existing[field];
    }
    var existingSuccess = existing.status === 'success';
    if (existingSuccess) {
      merged.status = 'success';
      if (!merged.activityName && incoming.activityName) merged.activityName = incoming.activityName;
      if (!merged.activityId && incoming.activityId) merged.activityId = incoming.activityId;
      if (!merged.category && incoming.category) merged.category = incoming.category;
      if (merged.distanceMeters === undefined && incoming.distanceMeters !== undefined) {
        merged.distanceMeters = incoming.distanceMeters;
      }
      if (!merged.stage && incoming.stage) merged.stage = incoming.stage;
      if (incoming.legacy) merged.legacy = false;
      return sanitizeResult(merged);
    }
    for (var j = 0; j < RESULT_ALLOWED_FIELDS.length; j += 1) {
      var name = RESULT_ALLOWED_FIELDS[j];
      var next = incoming[name];
      if (next === undefined || next === null || next === '') continue;
      var prev = merged[name];
      if (prev === undefined || prev === null || prev === '') {
        merged[name] = next;
      } else if (name === 'at') {
        merged.at = Math.max(Number(prev) || 0, Number(next) || 0);
      } else if (name === 'distanceMeters' || name === 'attempt') {
        merged[name] = next;
      } else if (name === 'status') {
        merged.status = next;
      } else if (name === 'activityName' || name === 'stage' || name === 'reason') {
        merged[name] = next;
      } else {
        merged[name] = prev;
      }
    }
    if (incoming.status === 'success') merged.status = 'success';
    return sanitizeResult(merged);
  }

  // ─────────────────────────── 工厂 ───────────────────────────

  function createMembers(options) {
    var opts = options || {};
    var storage = opts.storage || localStorageAdapter();
    if (!storage || typeof storage.get !== 'function' || typeof storage.set !== 'function') {
      throw new Error('createMembers 需要 storage {get,set,remove}');
    }
    var clock = opts.clock && typeof opts.clock.now === 'function' ? opts.clock : defaultClock();
    var hasInjectedAutomation = opts.automation !== undefined;
    var injectedAutomation = opts.automation;
    var maxResultsEvents =
      Number(opts.maxResultsEvents) > 0 ? Math.floor(Number(opts.maxResultsEvents)) : MAX_RESULTS_EVENTS;
    var resultRetainDays =
      Number(opts.retainDays) >= RESULT_RETAIN_DAYS ? Math.floor(Number(opts.retainDays)) : RESULT_RETAIN_DAYS;
    var runState = { running: false };
    var automationCache = null;
    /** 官方成绩单飞：memberId → in-flight Promise（并发调用复用同一个上游请求） */
    var syncInFlight = {};
    /** syncAllOfficialScores 单飞 */
    var syncAllInFlight = null;

    function now() {
      return safeNow(clock);
    }

    function automation() {
      if (automationCache) return automationCache;
      var resolved = hasInjectedAutomation
        ? resolveInjectedAutomation(injectedAutomation)
        : resolveAutomation(null);
      // 只缓存解析成功的结果：members.js 可能先于 automation.js 加载（脚本顺序），
      // 此时不能把 null 永久缓存，否则之后 runAll 永远报 automation-unavailable。
      if (resolved) automationCache = resolved;
      return resolved;
    }

    function automationDefaults() {
      var engineModule = automation();
      if (engineModule && isPlainObject(engineModule.DEFAULTS)) {
        return deepMerge({}, engineModule.DEFAULTS);
      }
      return deepMerge({}, FALLBACK_DEFAULTS);
    }

    // ── 成员存储 ──────────────────────────────────────

    function readMembersState() {
      var raw;
      try {
        raw = storage.get(MEMBERS_KEY);
      } catch (e) {
        return { version: MEMBERS_VERSION, selectedId: null, items: [], corrupt: true };
      }
      if (raw === null || raw === undefined || raw === '') {
        return { version: MEMBERS_VERSION, selectedId: null, items: [] };
      }
      var parsed;
      try {
        parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch (e) {
        return { version: MEMBERS_VERSION, selectedId: null, items: [], corrupt: true };
      }
      if (!isPlainObject(parsed) || !Array.isArray(parsed.items)) {
        return { version: MEMBERS_VERSION, selectedId: null, items: [], corrupt: true };
      }
      var items = [];
      var seen = {};
      for (var i = 0; i < parsed.items.length; i += 1) {
        var member = normalizeMember(parsed.items[i], now());
        if (!member) continue;
        if (seen[member.id]) continue;
        seen[member.id] = true;
        items.push(member);
      }
      var selectedId = text(parsed.selectedId);
      if (selectedId && !seen[selectedId]) selectedId = '';
      return { version: MEMBERS_VERSION, selectedId: selectedId || null, items: items };
    }

    function writeMembersState(state) {
      var payload = {
        version: MEMBERS_VERSION,
        selectedId: text(state.selectedId) || null,
        items: Array.isArray(state.items) ? state.items : [],
      };
      storage.set(MEMBERS_KEY, JSON.stringify(payload));
      return payload;
    }

    function indexOfMember(items, id) {
      var wanted = text(id);
      if (!wanted) return -1;
      for (var i = 0; i < items.length; i += 1) {
        if (text(items[i].id) === wanted) return i;
      }
      return -1;
    }

    /** 局部更新：已知对象字段深合并，会话/账号类整块替换；id 不可改。 */
    function applyPatch(base, patch, nowMs) {
      var out = clone(base);
      Object.keys(patch || {}).forEach(function (key) {
        var value = patch[key];
        if (value === undefined) return;
        if (key === 'id') return; // id 生成后不改
        if (REPLACE_FIELDS[key]) {
          out[key] = value === null ? null : clone(value);
        } else if (isPlainObject(value) && isPlainObject(out[key])) {
          out[key] = deepMerge(out[key], value);
        } else if (isPlainObject(value) || Array.isArray(value)) {
          out[key] = clone(value);
        } else {
          out[key] = value;
        }
      });
      out.updatedAt = nowMs;
      return out;
    }

    function requireReadableState() {
      var state = readMembersState();
      if (state.corrupt) {
        throw fixedError('members-corrupt');
      }
      return state;
    }

    function updateMember(id, patch) {
      var state = requireReadableState();
      var index = indexOfMember(state.items, id);
      if (index < 0) return null;
      var nowMs = now();
      var next = applyPatch(state.items[index], patch || {}, nowMs);
      next = normalizeMember(next, nowMs);
      state.items[index] = next;
      writeMembersState(state);
      return clone(next);
    }

    // ── 对外：成员 CRUD ───────────────────────────────

    function load() {
      var state = readMembersState();
      var out = {
        version: MEMBERS_VERSION,
        selectedId: state.selectedId,
        items: clone(state.items),
      };
      if (state.corrupt) {
        out.corrupt = true;
        out.error = 'members-corrupt';
      }
      return out;
    }

    function save(nextState) {
      var input = nextState || {};
      if (!Array.isArray(input.items)) {
        throw fixedError('invalid-members-state');
      }
      var items = [];
      var seen = {};
      for (var i = 0; i < input.items.length; i += 1) {
        var member = normalizeMember(input.items[i], now());
        if (!member) continue;
        if (seen[member.id]) continue;
        seen[member.id] = true;
        items.push(member);
      }
      var selectedId = text(input.selectedId);
      if (selectedId && !seen[selectedId]) selectedId = '';
      return clone(writeMembersState({ version: MEMBERS_VERSION, selectedId: selectedId || null, items: items }));
    }

    function upsertMember(rawMember) {
      if (!isPlainObject(rawMember)) throw fixedError('invalid-member');
      var state = requireReadableState();
      var incoming = clone(rawMember);
      var nowMs = now();
      // 调用方显式传了 ekModules（手工/导入），但没声明来源 → 诚实标 'manual'。
      // 刻意**不**在这里刷 ekModulesUpdatedAt：该时间戳的含义是「官方成绩同步时间」，
      // 手工数据盖上它会让启动时自动同步被误判为「刚同步过」而跳过（6h 节流）。
      // 注意：UI 保存成员时会主动删掉 ekModules/ekModulesSource/ekModulesUpdatedAt
      // （未提供 = 保留），所以这里只在「真的提供了模块数组」时改写来源。
      if (hasOwn(incoming, 'ekModules') && Array.isArray(incoming.ekModules)) {
        if (!hasOwn(incoming, 'ekModulesSource')) incoming.ekModulesSource = 'manual';
      } else if (hasOwn(incoming, 'ekModules') && incoming.ekModules === null) {
        // 显式清空模块 → 来源/时间一并清空，避免残留
        incoming.ekModulesSource = null;
        incoming.ekModulesUpdatedAt = null;
      }
      var index = indexOfMember(state.items, incoming.id);
      var member;
      if (index >= 0) {
        member = applyPatch(state.items[index], incoming, nowMs);
        member = normalizeMember(member, nowMs);
        state.items[index] = member;
      } else {
        member = normalizeMember(incoming, nowMs);
        state.items.push(member);
      }
      if (!state.selectedId) state.selectedId = member.id;
      writeMembersState(state);
      return clone(member);
    }

    function removeMember(id) {
      var state = requireReadableState();
      var index = indexOfMember(state.items, id);
      if (index < 0) return null;
      var removed = state.items.splice(index, 1)[0];
      if (state.selectedId === removed.id) {
        state.selectedId = state.items.length > 0 ? state.items[0].id : null;
      }
      writeMembersState(state);
      // 删除成员时一并清理该成员维度的运行态/积分/配置，避免残留敏感与脏数据
      [CONFIG_PREFIX + removed.id, STATE_PREFIX + removed.id, SCORES_PREFIX + removed.id].forEach(function (key) {
        try {
          if (typeof storage.remove === 'function') storage.remove(key);
        } catch (e) {
          /* 清理失败不影响删除结果 */
        }
      });
      return clone(removed);
    }

    function getMember(id) {
      var wanted = text(id);
      if (!wanted) return null;
      var state = readMembersState();
      var index = indexOfMember(state.items, wanted);
      return index < 0 ? null : clone(state.items[index]);
    }

    function hasMember(id) {
      return Boolean(getMember(id));
    }

    function selectMember(id) {
      var state = readMembersState();
      var wanted = text(id);
      if (wanted) {
        if (indexOfMember(state.items, wanted) < 0) {
          return clone({ version: MEMBERS_VERSION, selectedId: state.selectedId, items: state.items });
        }
        state.selectedId = wanted;
      } else {
        state.selectedId = null;
      }
      var written = writeMembersState(state);
      return clone({ version: MEMBERS_VERSION, selectedId: written.selectedId, items: written.items });
    }

    /** 清空成员（仅在 members 数据损坏需要重建时显式调用）。 */
    function clearMembers() {
      try {
        if (typeof storage.remove === 'function') storage.remove(MEMBERS_KEY);
        else storage.set(MEMBERS_KEY, JSON.stringify({ version: MEMBERS_VERSION, selectedId: null, items: [] }));
      } catch (e) {
        throw fixedError('members-clear-failed', e);
      }
      return { version: MEMBERS_VERSION, selectedId: null, items: [] };
    }

    // ── 对外：二课会话 / 凭证 ─────────────────────────

    function setEkSession(memberId, session) {
      var id = text(memberId);
      if (!id) throw fixedError('member-id-required');
      var valid = memberSession({ ek: session });
      if (!valid) throw fixedError('ek-session-invalid');
      var updated = updateMember(id, {
        ek: clone(session),
        ekStatus: 'ok',
        ekUpdatedAt: now(),
      });
      if (!updated) throw fixedError('member-not-found');
      return updated;
    }

    function clearEkSession(memberId) {
      return updateMember(text(memberId), { ek: null, ekStatus: 'none', ekUpdatedAt: now() });
    }

    function loginEk(memberId, payload, loginOptions) {
      var id = text(memberId);
      return Promise.resolve()
        .then(function () {
          var member = getMember(id);
          if (!member) throw fixedError('member-not-found');
          var body = payload || {};
          var studentId = text(body.student_id || body.studentId);
          var password = body.password == null ? '' : String(body.password);
          if (!studentId || !password) throw fixedError('ek-credentials-required');
          var api = resolveCtApi(loginOptions && loginOptions.api);
          if (!api || !api.ek || typeof api.ek.login !== 'function') {
            throw fixedError('ek-login-unavailable');
          }
          return Promise.resolve(api.ek.login({ student_id: studentId, password: password })).then(function (session) {
            if (!memberSession({ ek: session })) throw fixedError('ek-login-failed');
            var updated = updateMember(id, {
              ek: clone(session),
              ekStatus: 'ok',
              ekUpdatedAt: now(),
              ekCredentials: { studentId: studentId, password: password },
            });
            if (!updated) throw fixedError('member-not-found');
            return updated;
          });
        })
        .catch(function (error) {
          if (error && error.code) throw error;
          throw fixedError('ek-login-failed', error);
        });
    }

    function refreshEk(memberId, refreshOptions) {
      var id = text(memberId);
      return Promise.resolve()
        .then(function () {
          var member = getMember(id);
          if (!member) throw fixedError('member-not-found');
          var current = memberSession(member);
          if (!current) {
            updateMember(id, { ekStatus: 'expired', ekUpdatedAt: now() });
            throw fixedError('ek-session-missing');
          }
          var api = resolveCtApi(refreshOptions && refreshOptions.api);
          if (!api || !api.ek || typeof api.ek.refreshToken !== 'function') {
            throw fixedError('ek-refresh-unavailable');
          }
          return Promise.resolve(api.ek.refreshToken({ requestsData: clone(current) })).then(function (session) {
            if (!memberSession({ ek: session })) throw fixedError('ek-refresh-failed');
            var updated = updateMember(id, {
              ek: clone(session),
              ekStatus: 'ok',
              ekUpdatedAt: now(),
            });
            if (!updated) throw fixedError('member-not-found');
            return updated;
          });
        })
        .catch(function (error) {
          if (error && error.code === 'ek-session-missing') throw error;
          // 续期失败：标记会话失效（保留 ek 供用户查看/粘贴，但不再被当成可用会话）
          try {
            updateMember(id, { ekStatus: 'expired', ekUpdatedAt: now() });
          } catch (e) {
            /* ignore */
          }
          if (error && error.code) throw error;
          throw fixedError('ek-refresh-failed', error);
        });
    }

    function verifyUnirun(memberId, verifyOptions) {
      var id = text(memberId);
      return Promise.resolve()
        .then(function () {
          var member = getMember(id);
          if (!member) return { ok: false, reason: 'member-not-found' };
          var account = isPlainObject(member.unirun) ? member.unirun : null;
          var phone = text(account && account.phone);
          var password = account && account.password != null ? String(account.password) : '';
          if (!phone || !password) return { ok: false, reason: 'no-unirun-account' };
          var api = resolveCtApi(verifyOptions && verifyOptions.api);
          if (!api || !api.unirun) return { ok: false, reason: 'unirun-unavailable' };
          var credentials = { phone: phone, password: password };
          // sessionEnsure 返回 studentId/schoolName 且不把 token 给渲染层，优先用它；
          // 老版本只有 login 时退回 login，并立即丢弃返回的 token（不落盘、不返回）。
          if (typeof api.unirun.sessionEnsure === 'function') {
            return Promise.resolve(api.unirun.sessionEnsure(credentials)).then(function (info) {
              if (!info || typeof info !== 'object') return { ok: false, reason: 'unirun-login-failed' };
              return {
                ok: true,
                studentId: text(info.studentId || info.studentNo),
                schoolName: text(info.schoolName),
                userName: text(info.userName),
              };
            });
          }
          if (typeof api.unirun.login === 'function') {
            return Promise.resolve(api.unirun.login(credentials)).then(function (session) {
              if (!session || typeof session !== 'object') return { ok: false, reason: 'unirun-login-failed' };
              return { ok: true, studentId: text(session.studentId), schoolName: '' };
            });
          }
          return { ok: false, reason: 'unirun-unavailable' };
        })
        .catch(function (error) {
          return { ok: false, reason: 'unirun-login-failed', detail: sanitizeError(error) };
        });
    }

    // ── 对外：官方成绩同步（取消「手填八模块」） ─────────
    //
    // 语义总览：
    //   syncOfficialScores(memberId, {api?, force?, dryRun?, clock?}) -> Promise<SyncResult>
    //   syncAllOfficialScores({api?, force?, dryRun?}) -> Promise<{ok, results:[SyncResult], ...}>
    //
    // SyncResult = {
    //   ok: boolean,
    //   memberId, memberName,
    //   reason?: string,        // 固定码：member-not-found / ek-not-logged-in / api-unavailable /
    //                           //   preview-blocked / response-empty / duplicate-module /
    //                           //   no-recognized-module / info-crosscheck-missing /
    //                           //   info-crosscheck-mismatch / account-mismatch /
    //                           //   upstream-failed / throttled / storage-write-failed
    //   stale?: boolean,        // 失败时：本机仍有旧的（可展示但不可信的）值
    //   modules?: Array,        // 成功时：8 项 {name, required, current}
    //   updatedAt?: number,     // 成功时的同步时间戳（= member.ekModulesUpdatedAt）
    //   unknown?: Array,        // 上游多出的策略外模块（仅诊断）
    //   untrusted?: boolean,    // 交叉校验/结构异常导致的不可信（整份不落盘）
    // }
    //
    // 硬口径：
    //  - 只用该成员自己的 ek 会话；没有会话绝不借用别的成员/全局会话；
    //  - 失败（含不可信）**不覆盖任何旧值**（member.ekModules / 1ct:scores:<id> 都保持原样）；
    //  - 单飞：同成员并发调用只打一次上游，共享同一个 Promise；
    //  - 预览（dryRun 或全局 config.dryRun !== false）不请求上游，直接返回 preview-blocked；
    //  - 日志/返回值不含 token、密码。

    /** 该成员二课账号 id（引擎 scores.accounts 的键，也是 score-policy 的 accountId 口径） */
    function memberEkAccount(member) {
      if (!member || !isPlainObject(member.ek)) return '';
      var userInfo = isPlainObject(member.ek.user_info) ? member.ek.user_info : {};
      return text(userInfo.loginName) || text(userInfo.LoginName) || text(userInfo.studentId) || '';
    }

    /** 读该成员的引擎格式积分存储（1ct:scores:<id>）→ {version:1, accounts:{}} */
    function readMemberScores(memberId) {
      var raw;
      try {
        raw = storage.get(SCORES_PREFIX + memberId);
      } catch (e) {
        return { version: 1, accounts: {}, corrupt: true };
      }
      if (raw === null || raw === undefined || raw === '') return { version: 1, accounts: {} };
      var parsed;
      try {
        parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch (e) {
        return { version: 1, accounts: {}, corrupt: true };
      }
      if (!isPlainObject(parsed) || !isPlainObject(parsed.accounts)) {
        return { version: 1, accounts: {}, corrupt: true };
      }
      return { version: 1, accounts: parsed.accounts };
    }

    /**
     * 写该成员的引擎格式积分存储（只动本账号条目，保留同成员其他账号的历史条目）。
     * 结构严格对齐 automation.js 的 `auto3ct:scores`：
     *   {version:1, accounts:{<loginName>:{snapshot, refreshedAt, lastAttemptAt, lastRefreshError}}}
     */
    function writeMemberScores(memberId, accountId, entry) {
      var store = readMemberScores(memberId);
      var accounts = isPlainObject(store.accounts) ? store.accounts : {};
      var key = text(accountId);
      if (!key) throw fixedError('account-missing');
      var prev = isPlainObject(accounts[key]) ? accounts[key] : {};
      accounts[key] = {
        snapshot: entry.snapshot !== undefined ? entry.snapshot : prev.snapshot || null,
        refreshedAt: entry.refreshedAt !== undefined ? entry.refreshedAt : prev.refreshedAt || 0,
        lastAttemptAt: entry.lastAttemptAt !== undefined ? entry.lastAttemptAt : prev.lastAttemptAt || 0,
        lastRefreshError:
          entry.lastRefreshError === undefined ? prev.lastRefreshError || null : entry.lastRefreshError,
      };
      storage.set(SCORES_PREFIX + memberId, JSON.stringify({ version: 1, accounts: accounts }));
      return accounts[key];
    }

    /** 仅更新失败标记（成功路径外的唯一写入口，永不覆盖 snapshot/refreshedAt） */
    function markScoresRefreshError(memberId, accountId, errorCode, attemptedAt) {
      if (!text(accountId)) return null;
      try {
        return writeMemberScores(memberId, accountId, {
          lastAttemptAt: attemptedAt,
          lastRefreshError: errorCode || null,
        });
      } catch (e) {
        return null;
      }
    }

    /**
     * 预览判定。两档语义，区分「手动触发」与「自动运行轮」：
     *
     * 1) 显式 options.dryRun === true / options.preview === true
     *    → 预览：零上游请求，直接返回 {ok:false, reason:'preview-blocked'}。
     *    调用方（运行循环/自动同步）在预览轮必须传这个标记。
     *
     * 2) options.source === 'auto'（自动同步路径）且未显式 dryRun
     *    → 按全局 config.dryRun 判定：全局预览开着就一律不请求上游。
     *    这样即使调用方忘了传 dryRun，自动路径也不会污染「预览零副作用」。
     *
     * 3) 其余（用户点「同步官方成绩」的手动动作，无 options）
     *    → 允许请求。理由：getStudentScores 是**只读 GET**，不改平台任何状态；
     *      引擎既有口径同样允许预览下读官方成绩（automation.js maybeAutoRefresh
     *      在 preview 只跳过落盘，不跳过读取）。若这里跟随全局默认 dryRun=true，
     *      1CT 默认即预览模式 → 同步按钮会被永久拒绝，功能直接不可用。
     */
    function isPreviewSync(syncOptions) {
      var opts = syncOptions || {};
      if (opts.dryRun === true || opts.preview === true) return true;
      if (opts.dryRun === false) return false;
      if (opts.source !== 'auto') return false;
      // 自动路径：跟随全局预览开关（缺省沿用引擎默认 dryRun=true → 视为预览）
      try {
        var globalConfig = readJsonObject(GLOBAL_CONFIG_KEY);
        if (globalConfig.dryRun === undefined) {
          var defaults = automationDefaults();
          return defaults.dryRun !== false;
        }
        return globalConfig.dryRun !== false;
      } catch (e) {
        return true; // 判定不了就当预览：自动路径绝不误发真实请求
      }
    }

    /** syncAll 的 force：显式 force 优先，否则看 options.force */
    function syncForceFlag(syncOptions) {
      return Boolean(syncOptions && syncOptions.force === true);
    }

    /**
     * 单成员官方成绩同步。永不抛错（统一返回 {ok:false, reason}）。
     */
    function syncOfficialScores(memberId, syncOptions) {
      var id = text(memberId);
      var options = isPlainObject(syncOptions) ? syncOptions : {};

      // 单飞：同成员已有 in-flight 请求 → 直接复用（不重复打上游）
      if (id && syncInFlight[id]) return syncInFlight[id];

      var task = Promise.resolve()
        .then(function () {
          if (!id) return { ok: false, reason: 'member-id-required', memberId: '', memberName: '' };
          var member = getMember(id);
          if (!member) return { ok: false, reason: 'member-not-found', memberId: id, memberName: '' };
          var memberName = text(member.name);

          // 预览：零上游请求（与 runAll 预览零副作用口径一致）
          if (isPreviewSync(options)) {
            return {
              ok: false,
              reason: SCORE_SYNC_PREVIEW_REASON,
              memberId: id,
              memberName: memberName,
              stale: hasOfficialModules(member),
              preview: true,
            };
          }

          var session = memberSession(member);
          if (!session) {
            return {
              ok: false,
              reason: 'ek-not-logged-in',
              memberId: id,
              memberName: memberName,
              stale: hasOfficialModules(member),
            };
          }
          var api = resolveCtApi(options.api);
          if (!api || !api.ek || typeof api.ek.getStudentScores !== 'function') {
            return {
              ok: false,
              reason: 'api-unavailable',
              memberId: id,
              memberName: memberName,
              stale: hasOfficialModules(member),
            };
          }

          var accountId = memberEkAccount(member);
          var attemptedAt = now();
          var force = syncForceFlag(options);

          // 节流：非 force 且该成员 6h 内刚成功同步过 → 不重复打上游（syncAll 的默认行为）
          if (!force && wasRecentlySynced(member, attemptedAt, options)) {
            return {
              ok: true,
              memberId: id,
              memberName: memberName,
              reason: 'throttled',
              throttled: true,
              modules: Array.isArray(member.ekModules) ? clone(member.ekModules) : null,
              updatedAt: finiteOrNull(member.ekModulesUpdatedAt) || 0,
            };
          }

          return Promise.resolve(api.ek.getStudentScores({ requestsData: clone(session) }))
            .then(function (resp) {
              var parsed = parseOfficialScoreResponse(resp);
              if (!parsed.ok) {
                var failReason = parsed.reason || 'upstream-failed';
                markScoresRefreshError(id, accountId, 'official-' + failReason, attemptedAt);
                return {
                  ok: false,
                  reason: failReason,
                  untrusted: true,
                  memberId: id,
                  memberName: memberName,
                  stale: hasOfficialModules(member),
                  unknown: parsed.unknown || [],
                };
              }
              // 账号比对：官方 StudentId 与本成员 ek 账号显式不一致 → 拒绝覆盖（不静默重绑）
              var hint = text(parsed.accountHint);
              if (hint && accountId && hint !== accountId) {
                markScoresRefreshError(id, accountId, 'official-account-mismatch', attemptedAt);
                return {
                  ok: false,
                  reason: 'account-mismatch',
                  accountHint: hint,
                  memberId: id,
                  memberName: memberName,
                  stale: hasOfficialModules(member),
                };
              }
              var modules = modulesFromParsed(parsed);
              var updatedAt = safeNow(clock);
              var snapshot = buildOfficialSnapshot(accountId || hint, parsed, updatedAt);
              var scoresKey = accountId || hint;

              // 先写引擎存储（score-policy/引擎直接可用），再写成员字段；
              // 两步都成功才算 ok，落盘失败时回滚不写成员字段（保持两处一致）。
              var scoresWritten = false;
              try {
                writeMemberScores(id, scoresKey, {
                  snapshot: snapshot,
                  refreshedAt: updatedAt,
                  lastAttemptAt: attemptedAt,
                  lastRefreshError: null,
                });
                scoresWritten = true;
              } catch (e) {
                scoresWritten = false;
              }
              if (!scoresWritten) {
                return {
                  ok: false,
                  reason: 'storage-write-failed',
                  memberId: id,
                  memberName: memberName,
                  stale: hasOfficialModules(member),
                };
              }
              var updatedMember = updateMember(id, {
                ekModules: modules,
                ekModulesSource: 'official',
                ekModulesUpdatedAt: updatedAt,
              });
              if (!updatedMember) {
                return {
                  ok: false,
                  reason: 'member-not-found',
                  memberId: id,
                  memberName: memberName,
                  stale: hasOfficialModules(member),
                };
              }
              return {
                ok: true,
                memberId: id,
                memberName: memberName,
                reason: '',
                modules: clone(modules),
                updatedAt: updatedAt,
                stale: false,
                unknown: parsed.unknown || [],
                accountId: scoresKey,
              };
            })
            .catch(function (error) {
              markScoresRefreshError(id, accountId, 'official-request-failed', attemptedAt);
              return {
                ok: false,
                reason: 'upstream-failed',
                detail: sanitizeError(error),
                memberId: id,
                memberName: memberName,
                stale: hasOfficialModules(member),
              };
            });
        })
        .catch(function (error) {
          // 兜底：任何未预期异常都转成结构化结果，绝不把异常抛给 UI
          return {
            ok: false,
            reason: 'upstream-failed',
            detail: sanitizeError(error),
            memberId: id,
            memberName: '',
          };
        });

      if (id) {
        var tracked = task.then(function (result) {
          delete syncInFlight[id];
          return result;
        });
        syncInFlight[id] = tracked;
        return tracked;
      }
      return task;
    }

    /** 该成员是否已有官方来源的模块数据（失败时用于判断 stale） */
    function hasOfficialModules(member) {
      if (!member || member.ekModulesSource !== 'official') return false;
      return Array.isArray(member.ekModules) && member.ekModules.length > 0;
    }

    /**
     * 是否跳过上游（节流）：
     *  - 仅在 options.throttle === true（syncAll 默认传）时生效；
     *  - ekModulesSource='official' 且 ekModulesUpdatedAt 在 SCORE_SYNC_MIN_INTERVAL_MS 内。
     */
    function wasRecentlySynced(member, atMs, syncOptions) {
      if (!syncOptions || syncOptions.throttle !== true) return false;
      var interval = Number(syncOptions.minIntervalMs);
      if (!Number.isFinite(interval) || interval < 0) interval = SCORE_SYNC_MIN_INTERVAL_MS;
      if (interval === 0) return false;
      if (!hasOfficialModules(member)) return false;
      var updatedAt = finiteOrNull(member.ekModulesUpdatedAt);
      if (updatedAt === null || updatedAt <= 0) return false;
      return atMs - updatedAt < interval && atMs - updatedAt >= 0;
    }

    /**
     * 同步所有「有二课会话」的成员（串行，避免并发把上游打挂）。
     * @param {{api?, force?, dryRun?, throttle?, minIntervalMs?}} allOptions
     * @returns {Promise<{ok, results:Array, synced:number, failed:number, skipped:number, at:number, busy?:true}>}
     *  ok = 至少一个成员成功（全部失败/全部跳过 → false）。
     *  单飞：并发调用直接返回 {busy:true}。
     */
    function syncAllOfficialScores(allOptions) {
      var options = isPlainObject(allOptions) ? allOptions : {};
      if (syncAllInFlight) return Promise.resolve({ busy: true, ok: false, results: [], at: now() });
      var targets;
      try {
        var state = requireReadableState();
        targets = state.items.filter(function (member) {
          return Boolean(memberSession(member));
        });
      } catch (e) {
        return Promise.resolve({ busy: false, ok: false, results: [], error: 'members-corrupt', at: now() });
      }
      // 预览不请求上游：直接逐成员返回 preview-blocked（UI 可据 reason 提示）
      var dryRun = isPreviewSync(options);
      var results = [];
      var synced = 0;
      var failed = 0;
      var skipped = 0;
      var chain = Promise.resolve();
      targets.forEach(function (member) {
        chain = chain.then(function () {
          // syncAll 默认开节流（避免每次点「同步全部」把所有人的成绩都重拉一遍）；
          // 显式构造 options（不用 deepMerge，避免把注入的 api 对象深拷贝成普通对象），
          // 并**透传 source**：自动路径（source:'auto'）的预览门禁必须延续到每个成员调用。
          var perMember = {
            api: options.api,
            dryRun: options.dryRun,
            preview: options.preview,
            source: options.source,
            force: options.force === true,
            throttle: options.throttle !== false,
            minIntervalMs: options.minIntervalMs,
          };
          return syncOfficialScores(member.id, perMember).then(function (one) {
            results.push(one);
            if (one && one.ok && one.throttled !== true) synced += 1;
            else if (one && one.ok) skipped += 1;
            else failed += 1;
          });
        });
      });
      var task = chain
        .then(function () {
          return {
            busy: false,
            ok: synced > 0 || (results.length > 0 && failed === 0 && skipped === results.length),
            dryRun: dryRun,
            results: results,
            synced: synced,
            failed: failed,
            skipped: skipped,
            total: results.length,
            at: safeNow(clock),
          };
        })
        .catch(function (error) {
          return {
            busy: false,
            ok: false,
            results: results,
            error: 'sync-all-failed',
            detail: sanitizeError(error),
            at: safeNow(clock),
          };
        })
        .then(function (out) {
          syncAllInFlight = null;
          return out;
        });
      syncAllInFlight = task;
      return task;
    }

    /** 该成员引擎积分存储里的当前 snapshot（供 UI/统计直接读；无则 null） */
    function getMemberScoreSnapshot(memberId, snapshotOptions) {
      var id = text(memberId);
      if (!id) return null;
      var member = getMember(id);
      var store = readMemberScores(id);
      var accountId = memberEkAccount(member || {}) || text(snapshotOptions && snapshotOptions.accountId);
      var entry = accountId && isPlainObject(store.accounts[accountId]) ? store.accounts[accountId] : null;
      if (!entry && isPlainObject(store.accounts)) {
        // 账号未知（例如会话被清掉）：只有一个账号时直接用它，多账号不猜
        var keys = Object.keys(store.accounts);
        if (keys.length === 1) entry = store.accounts[keys[0]];
      }
      if (!entry || !isPlainObject(entry.snapshot)) return null;
      return clone(entry.snapshot);
    }

    // ── 对外：config ─────────────────────────────────

    function readJsonObject(key) {
      var raw;
      try {
        raw = storage.get(key);
      } catch (e) {
        return {};
      }
      if (raw === null || raw === undefined || raw === '') return {};
      var parsed;
      try {
        parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch (e) {
        return {};
      }
      return isPlainObject(parsed) ? parsed : {};
    }

    function writeJsonObject(key, value) {
      storage.set(key, JSON.stringify(value));
      return value;
    }

    /** 全局默认 config（automation.DEFAULTS 打底 + 1ct:config:global）。 */
    function loadGlobalConfig() {
      return deepMerge(automationDefaults(), readJsonObject(GLOBAL_CONFIG_KEY));
    }

    function saveGlobalConfig(patch) {
      var merged = deepMerge(readJsonObject(GLOBAL_CONFIG_KEY), isPlainObject(patch) ? patch : {});
      writeJsonObject(GLOBAL_CONFIG_KEY, merged);
      return deepMerge(automationDefaults(), merged);
    }

    /**
     * 写 config 层（契约补充 v2）：
     *  - memberId = null → 全局（等价 saveGlobalConfig）
     *  - memberId = '<id>' → 成员覆盖层；patch 含 dryRun 一律拒绝
     * 返回该层合并结果（全局层带 automation.DEFAULTS 打底，方便 UI 直接展示）。
     */
    function saveConfig(memberId, patch) {
      if (memberId === null || memberId === undefined || memberId === '') {
        return saveGlobalConfig(patch);
      }
      var id = text(memberId);
      if (!isPlainObject(patch)) return { rejected: 'invalid-patch' };
      if (hasOwn(patch, 'dryRun')) {
        // 预览开关全局唯一：成员层写 dryRun 会让「全局预览」被静默绕过，直接拒绝
        return { rejected: 'dryRun-global-only' };
      }
      if (!hasMember(id)) return { rejected: 'unknown-member' };
      var merged = deepMerge(readJsonObject(CONFIG_PREFIX + id), patch);
      writeJsonObject(CONFIG_PREFIX + id, merged);
      return merged;
    }

    /** 别名：契约早期叫 setConfig，保留同名导出，语义与 saveConfig 相同。 */
    function setConfig(memberId, patch) {
      return saveConfig(memberId, patch);
    }

    /** 该成员生效 config：全局（含默认）深合并成员覆盖层；成员层 dryRun 永远剔除。 */
    function effectiveConfig(memberId) {
      var id = text(memberId);
      var global = readJsonObject(GLOBAL_CONFIG_KEY);
      var override = id ? stripDryRun(readJsonObject(CONFIG_PREFIX + id)) : {};
      return deepMerge(automationDefaults(), global, override);
    }

    // ── 对外：引擎 storage 适配 ───────────────────────

    /**
     * 引擎 storage：把引擎固定 key 映射到成员维度。
     * 额外暴露 `memberId`（便于诊断/测试），引擎会忽略该属性。
     */
    function engineStorage(memberId) {
      var id = text(memberId);
      if (!id) throw fixedError('member-id-required');

      function readMemberOrNull() {
        return getMember(id);
      }

      function get(key) {
        var name = text(key);
        if (name === ENGINE_KEYS.state) return storage.get(STATE_PREFIX + id);
        if (name === ENGINE_KEYS.scores) return storage.get(SCORES_PREFIX + id);
        if (name === ENGINE_KEYS.config) {
          // 只给引擎干净的成员覆盖层：dryRun 一律不出现（预览开关全局独有）
          var override = stripDryRun(readJsonObject(CONFIG_PREFIX + id));
          return Object.keys(override).length > 0 ? JSON.stringify(override) : null;
        }
        if (name === ENGINE_KEYS.ekSession) {
          var member = readMemberOrNull();
          var session = member && memberSession(member);
          return session ? JSON.stringify(session) : null;
        }
        if (name === ENGINE_KEYS.unirunAccounts) {
          var accountMember = readMemberOrNull();
          return JSON.stringify(unirunAccountsPayload(accountMember));
        }
        return storage.get(ENGINE_FALLBACK_PREFIX + id + ':' + name);
      }

      function set(key, value) {
        var name = text(key);
        if (name === ENGINE_KEYS.state) {
          storage.set(STATE_PREFIX + id, String(value));
          return;
        }
        if (name === ENGINE_KEYS.scores) {
          storage.set(SCORES_PREFIX + id, String(value));
          return;
        }
        if (name === ENGINE_KEYS.config) {
          var parsedOverride = {};
          try {
            parsedOverride = JSON.parse(String(value));
          } catch (e) {
            throw fixedError('config-write-invalid');
          }
          var cleaned = stripDryRun(parsedOverride);
          storage.set(CONFIG_PREFIX + id, JSON.stringify(cleaned));
          return;
        }
        if (name === ENGINE_KEYS.ekSession) {
          var session = null;
          try {
            session = JSON.parse(String(value));
          } catch (e) {
            session = null;
          }
          if (memberSession({ ek: session })) setEkSession(id, session);
          else clearEkSession(id);
          return;
        }
        if (name === ENGINE_KEYS.unirunAccounts) {
          var payload = null;
          try {
            payload = JSON.parse(String(value));
          } catch (e) {
            payload = null;
          }
          var account = payload && Array.isArray(payload.items) && isPlainObject(payload.items[0])
            ? payload.items[0]
            : null;
          updateMember(id, {
            unirun: account
              ? {
                  id: text(account.id),
                  phone: text(account.phone),
                  password: account.password == null ? '' : String(account.password),
                  remark: text(account.remark),
                  updatedAt: finiteOrNull(account.updatedAt) || now(),
                }
              : null,
          });
          return;
        }
        storage.set(ENGINE_FALLBACK_PREFIX + id + ':' + name, String(value));
      }

      function remove(key) {
        var name = text(key);
        if (name === ENGINE_KEYS.state) return void storage.remove(STATE_PREFIX + id);
        if (name === ENGINE_KEYS.scores) return void storage.remove(SCORES_PREFIX + id);
        if (name === ENGINE_KEYS.config) return void storage.remove(CONFIG_PREFIX + id);
        if (name === ENGINE_KEYS.ekSession) return void clearEkSession(id);
        if (name === ENGINE_KEYS.unirunAccounts) return void updateMember(id, { unirun: null });
        return void storage.remove(ENGINE_FALLBACK_PREFIX + id + ':' + name);
      }

      return { memberId: id, get: get, set: set, remove: remove };
    }

    /** 结果仓库 storage：全局共享，'auto3ct:results' → '1ct:results'。 */
    function resultsStorage() {
      return {
        get: function (key) {
          var name = text(key);
          if (name === 'auto3ct:results') return storage.get(RESULTS_KEY);
          return storage.get(RESULTS_FALLBACK_PREFIX + name);
        },
        set: function (key, value) {
          var name = text(key);
          if (name === 'auto3ct:results') return void storage.set(RESULTS_KEY, String(value));
          storage.set(RESULTS_FALLBACK_PREFIX + name, String(value));
        },
        remove: function (key) {
          var name = text(key);
          if (name === 'auto3ct:results') return void storage.remove(RESULTS_KEY);
          storage.remove(RESULTS_FALLBACK_PREFIX + name);
        },
      };
    }

    // ── 结果历史写入器（口径同 result-store，白名单含 memberId） ──

    function readResultsState() {
      var raw;
      try {
        raw = storage.get(RESULTS_KEY);
      } catch (e) {
        return { version: RESULTS_VERSION, events: [], corrupt: true };
      }
      if (raw === null || raw === undefined || raw === '') {
        return { version: RESULTS_VERSION, events: [] };
      }
      var parsed;
      try {
        parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch (e) {
        return { version: RESULTS_VERSION, events: [], corrupt: true };
      }
      if (!isPlainObject(parsed) || !Array.isArray(parsed.events)) {
        return { version: RESULTS_VERSION, events: [], corrupt: true };
      }
      var events = [];
      for (var i = 0; i < parsed.events.length; i += 1) {
        var item = parsed.events[i];
        if (isPlainObject(item) && typeof item.key === 'string') events.push(sanitizeResult(item));
      }
      return { version: RESULTS_VERSION, events: events };
    }

    function pruneResults(events) {
      var cutoff = beijingDay(now() - resultRetainDays * DAY_MS);
      var kept = [];
      for (var i = 0; i < events.length; i += 1) {
        var item = events[i];
        var day = item.day || beijingDay(item.at);
        if (day >= cutoff) kept.push(item);
      }
      kept.sort(function (a, b) {
        if (b.at !== a.at) return b.at - a.at;
        var left = resultIdentity(a);
        var right = resultIdentity(b);
        return left < right ? -1 : left > right ? 1 : 0;
      });
      if (kept.length > maxResultsEvents) kept = kept.slice(0, maxResultsEvents);
      return kept;
    }

    function writeResults(events) {
      try {
        storage.set(RESULTS_KEY, JSON.stringify({ version: RESULTS_VERSION, events: events }));
        return true;
      } catch (e) {
        return false;
      }
    }

    /** 追加一条结果事件（幂等 upsert；预览/dry-run 一律拒绝）。 */
    function appendResult(rawEvent) {
      var event = normalizeResult(rawEvent, { now: now() });
      if (!event) return false;
      var store = readResultsState();
      if (store.corrupt) return false; // fail-closed：损坏需 clearResults() 后恢复
      var events = store.events;
      var identity = resultIdentity(event);
      var index = -1;
      for (var i = 0; i < events.length; i += 1) {
        if (resultIdentity(events[i]) === identity) {
          index = i;
          break;
        }
      }
      var next = events.slice();
      if (index >= 0) next[index] = mergeResult(events[index], event);
      else next.push(event);
      return writeResults(pruneResults(next));
    }

    /**
     * 记录一轮引擎结果（成员维度的批量 append）。
     * dry-run/preview 轮整轮不入库（与 result-store.recordRound 同口径）。
     */
    function recordRound(round) {
      var result = { recorded: 0, inserted: 0, updated: 0, skipped: 0, preview: false };
      if (!isPlainObject(round)) return result;
      if (round.dryRun === true || round.preview === true) {
        result.preview = true;
        return result;
      }
      var rows = Array.isArray(round.results) ? round.results : [];
      var baseAt = finiteOrNull(round.at);
      if (baseAt === null) baseAt = now();
      var memberId = text(round.memberId);
      var memberName = text(round.memberName, 120);
      var before = readResultsState();
      var beforeIdentities = {};
      for (var b = 0; b < before.events.length; b += 1) {
        beforeIdentities[resultIdentity(before.events[b])] = true;
      }
      // 单轮只读写一次：先按顺序合并到内存，再落盘一次
      var store = before;
      if (store.corrupt) {
        result.persistenceError = 'results-corrupt';
        result.skipped = rows.length;
        return result;
      }
      var events = store.events.slice();
      for (var i = 0; i < rows.length; i += 1) {
        var rawRow = rows[i];
        if (!isPlainObject(rawRow)) {
          result.skipped += 1;
          continue;
        }
        var rowStatus = text(rawRow.status).toLowerCase().replace(/_/g, '-');
        if (rowStatus === 'dry-run' || rowStatus === 'preview') {
          result.skipped += 1;
          continue;
        }
        var event = normalizeResult(
          {
            key: rawRow.key,
            at: finiteOrNull(rawRow.at) === null ? baseAt : rawRow.at,
            accountId: rawRow.accountId,
            module: rawRow.module,
            action: rawRow.action,
            activityId: rawRow.activityId,
            activityName: rawRow.activityName,
            category: rawRow.category,
            status: rawRow.status,
            reason: rawRow.reason,
            stage: rawRow.stage,
            distanceMeters: rawRow.distanceMeters,
            attempt: rawRow.attempt,
            source: rawRow.source,
            memberId: text(rawRow.memberId) || memberId,
            memberName: text(rawRow.memberName) || memberName,
          },
          { now: baseAt },
        );
        if (!event) {
          result.skipped += 1;
          continue;
        }
        var identity = resultIdentity(event);
        var index = -1;
        for (var j = 0; j < events.length; j += 1) {
          if (resultIdentity(events[j]) === identity) {
            index = j;
            break;
          }
        }
        if (index >= 0) events[index] = mergeResult(events[index], event);
        else events.push(event);
        result.recorded += 1;
        if (beforeIdentities[identity]) result.updated += 1;
        else result.inserted += 1;
        beforeIdentities[identity] = true;
      }
      if (!writeResults(pruneResults(events))) {
        result.persistenceError = 'storage-write-failed';
        result.recorded = 0;
        result.inserted = 0;
        result.updated = 0;
      }
      return result;
    }

    /**
     * 读结果历史（保留 memberId/memberName）。
     * filter: { memberId, module, status, action, accountId, from, to }（from/to 支持 day 或毫秒）
     */
    function loadResults(filter) {
      var f = isPlainObject(filter) ? filter : {};
      var fromDay = toDay(f.from);
      var toDayValue = toDay(f.to);
      var memberId = text(f.memberId);
      var module = text(f.module).toLowerCase();
      var status = text(f.status).toLowerCase();
      var action = text(f.action);
      var accountId = text(f.accountId);
      var events = pruneResults(readResultsState().events);
      var out = [];
      for (var i = 0; i < events.length; i += 1) {
        var item = events[i];
        if (fromDay && item.day < fromDay) continue;
        if (toDayValue && item.day > toDayValue) continue;
        if (memberId && item.memberId !== memberId) continue;
        if (module && item.module !== module) continue;
        if (status && item.status !== status) continue;
        if (action && item.action !== action) continue;
        if (accountId && item.accountId !== accountId) continue;
        out.push(clone(item));
      }
      return out;
    }

    /**
     * 历史健康度：UI 可据此提示「有 N 条历史无成员归属，统计里看不到」。
     * 口径：无 memberId 或 memberId 已不在当前成员列表 → 归属失效。
     */
    function resultsHealth() {
      var store = readResultsState();
      var events = pruneResults(store.events);
      var ids = {};
      var items = readMembersState().items;
      for (var m = 0; m < items.length; m += 1) ids[items[m].id] = true;
      var unscoped = 0;
      var orphaned = 0;
      var byMember = {};
      for (var i = 0; i < events.length; i += 1) {
        var id = text(events[i].memberId);
        if (!id) {
          unscoped += 1;
          continue;
        }
        byMember[id] = (byMember[id] || 0) + 1;
        if (!ids[id]) orphaned += 1;
      }
      return {
        total: events.length,
        unscoped: unscoped,
        orphaned: orphaned,
        byMember: byMember,
        corrupt: Boolean(store.corrupt),
        maxEvents: maxResultsEvents,
        retainDays: resultRetainDays,
      };
    }

    function clearResults() {
      try {
        if (typeof storage.remove === 'function') storage.remove(RESULTS_KEY);
        else storage.set(RESULTS_KEY, JSON.stringify({ version: RESULTS_VERSION, events: [] }));
      } catch (e) {
        /* ignore */
      }
      return true;
    }

    function toDay(value) {
      if (value === null || value === undefined || value === '') return null;
      if (typeof value === 'number' && Number.isFinite(value)) return beijingDay(value);
      var str = text(value);
      if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.slice(0, 10);
      var parsed = Date.parse(str);
      return Number.isFinite(parsed) ? beijingDay(parsed) : null;
    }

    // ── 对外：导出（脱敏） ───────────────────────────

    /** 单个成员的安全视图：剔除密码/token，手机号掩码。 */
    function toPublicMember(member) {
      if (!isPlainObject(member)) return null;
      var out = clone(member);
      delete out.ekCredentials;
      if (out.unirun) {
        var account = out.unirun;
        out.unirun = {
          id: text(account.id),
          phone: maskPhone(account.phone),
          remark: text(account.remark),
          hasPassword: Boolean(account.password),
          updatedAt: finiteOrNull(account.updatedAt),
        };
      }
      if (out.ek) {
        var session = out.ek;
        var userInfo = isPlainObject(session.user_info) ? session.user_info : {};
        out.ek = {
          loginName: text(userInfo.loginName),
          userName: text(userInfo.userName || userInfo.realName),
          hasAccessToken: Boolean(session.access_token),
          hasRefreshToken: Boolean(session.refresh_token),
        };
      }
      return out;
    }

    function exportMembers() {
      return load().items.map(toPublicMember);
    }

    // ── 对外：runAll ─────────────────────────────────

    function summarizeRows(rows) {
      var summary = { total: rows.length, success: 0, failed: 0, unknown: 0, waiting: 0, dryRun: 0, skipped: 0 };
      for (var i = 0; i < rows.length; i += 1) {
        var status = text(rows[i] && rows[i].status).toLowerCase();
        if (status === 'success') summary.success += 1;
        else if (status === 'failed') summary.failed += 1;
        else if (status === 'unknown') summary.unknown += 1;
        else if (status === 'dry-run') summary.dryRun += 1;
        else if (status === 'waiting-material' || status === 'not-yet' || status === 'blocked' || status === 'expired') {
          summary.waiting += 1;
        } else summary.skipped += 1;
      }
      return summary;
    }

    /**
     * 成员二课会话自愈：只有 ek 模块启用 + 非预览轮才尝试，且永远不抛错。
     *  - 有会话 → refreshEk；失败再 loginEk（需 ekCredentials）
     *  - 无会话 → loginEk（需 ekCredentials）
     * 返回 { member, ekSkipped, reason }
     *
     * 预览模式（dryRun !== false）绝不触碰登录/续期：它们是真实 IPC 写调用，
     * 预览必须零副作用（否则「先看要做什么」会悄悄改会话状态）。
     * 预览下会话缺失由引擎自己产出 no-ek-session waiting 行。
     */
    function repairEkSession(member, api, effectiveCfg) {
      var ekConfig = effectiveCfg && effectiveCfg.ek;
      if (!ekConfig || ekConfig.enabled !== true) {
        return Promise.resolve({ member: member, ekSkipped: false, reason: '', attempted: false });
      }
      if (effectiveCfg.dryRun !== false) {
        return Promise.resolve({ member: member, ekSkipped: false, reason: '', attempted: false, preview: true });
      }
      var session = memberSession(member);
      if (session && member.ekStatus === 'ok') {
        return Promise.resolve({ member: member, ekSkipped: false, reason: '', attempted: false });
      }
      if (!api || !api.ek) {
        return Promise.resolve({ member: member, ekSkipped: true, reason: 'ek-api-unavailable', attempted: false });
      }
      var credentials = memberCredentials(member);
      var attempt = function () {
        if (credentials) {
          return loginEk(member.id, { student_id: credentials.studentId, password: credentials.password }, { api: api })
            .then(function () {
              return { ok: true };
            })
            .catch(function (error) {
              return { ok: false, error: error };
            });
        }
        return Promise.resolve({ ok: false, error: fixedError('ek-session-missing') });
      };
      var chain = Promise.resolve({ ok: false });
      if (session && typeof api.ek.refreshToken === 'function') {
        chain = refreshEk(member.id, { api: api })
          .then(function () {
            return { ok: true };
          })
          .catch(function () {
            return { ok: false };
          });
      }
      return chain
        .then(function (refreshed) {
          if (refreshed.ok) return { ok: true };
          return attempt();
        })
        .then(function (repaired) {
          var next = getMember(member.id) || member;
          if (repaired.ok) {
            return { member: next, ekSkipped: false, reason: '', attempted: true };
          }
          return { member: next, ekSkipped: true, reason: 'ek-reauth-failed', attempted: true };
        })
        .catch(function () {
          return { member: getMember(member.id) || member, ekSkipped: true, reason: 'ek-reauth-failed', attempted: true };
        });
    }

    function runOneMember(member, context) {
      var memberId = member.id;
      var memberName = member.name;
      var baseConfig = effectiveConfig(memberId);

      function at() {
        try {
          var value = Number(context.clock.now());
          return Number.isFinite(value) ? value : Date.now();
        } catch (e) {
          return Date.now();
        }
      }

      return repairEkSession(member, context.api, baseConfig).then(function (repair) {
        var config = baseConfig;
        var pendingRows = [];
        if (repair.ekSkipped) {
          config = deepMerge(baseConfig, { ek: { enabled: false } });
          pendingRows.push({
            // 稳定幂等键：同日同成员只留一条「二课会话不可用」，不刷爆历史
            key: 'session|' + beijingDay(at()) + '|' + memberId + '|ek.session',
            module: 'ek',
            action: 'session',
            activityId: '',
            status: 'waiting-material',
            reason: repair.reason || 'ek-reauth-failed',
            at: at(),
            memberId: memberId,
            memberName: memberName,
          });
          context.logger.log(
            '[member] ' + memberName + ' 二课会话不可用（' + (repair.reason || 'ek-reauth-failed') + '），本轮跳过二课模块',
          );
        }
        var storageAdapter = engineStorage(memberId);
        var engine;
        try {
          engine = context.automation.createEngine({
            api: context.api,
            storage: storageAdapter,
            clock: context.clock,
            decodeQr: context.decodeQr,
            logger: context.logger,
            config: config,
          });
        } catch (error) {
          throw fixedError('member-error', error);
        }
        return Promise.resolve(engine.runOnce()).then(function (round) {
          var out = isPlainObject(round) ? round : {};
          var rows = [];
          if (out.busy === true) {
            rows.push({
              module: 'engine',
              action: 'run',
              activityId: '',
              status: 'blocked',
              reason: 'already-running',
              at: at(),
            });
          }
          var engineRows = Array.isArray(out.results) ? out.results : [];
          for (var i = 0; i < engineRows.length; i += 1) {
            if (!isPlainObject(engineRows[i])) continue;
            var row = clone(engineRows[i]);
            row.memberId = memberId;
            row.memberName = memberName;
            rows.push(row);
          }
          // 结果入库：引擎行 + 会话跳过行合并成一轮（dry-run 轮整轮不落库）
          var roundRows = engineRows.slice();
          for (var p = 0; p < pendingRows.length; p += 1) roundRows.push(pendingRows[p]);
          context.record({
            memberId: memberId,
            memberName: memberName,
            results: roundRows,
            at: finiteOrNull(out.at) === null ? at() : out.at,
            dryRun: Boolean(out.dryRun),
          });
          return {
            memberId: memberId,
            memberName: memberName,
            results: pendingRows.concat(rows),
            summary: out.summary || null,
            dryRun: Boolean(out.dryRun),
            ekScan: out.ekScan || null,
            error: null,
          };
        });
      });
    }

    /**
     * 串行跑所有 enabled 成员（可按 onlyMemberId 过滤）。
     * 返回 { results, byMember, summary, startedAt, finishedAt, busy:false }；
     * 运行中重复调用返回 { busy:true }。
     */
    function runAll(runOptions) {
      var options = isPlainObject(runOptions) ? runOptions : {};
      if (runState.running) {
        return Promise.resolve({ busy: true, results: [], byMember: {}, at: now() });
      }
      runState.running = true;
      var startedAt = now();
      var api = resolveCtApi(options.api);
      var logger = normalizeLogger(options.logger);
      var onResult = typeof options.onResult === 'function' ? options.onResult : null;
      var decodeQr = typeof options.decodeQr === 'function'
        ? options.decodeQr
        : function () {
            return Promise.resolve(null);
          };
      var clock = options.clock && typeof options.clock.now === 'function' ? options.clock : defaultClock();
      // 显式注入但形状不对 → 视为不可用（不静默回落全局引擎，避免测试/多实例行为漂移）
      var engineModule = options.automation !== undefined
        ? resolveInjectedAutomation(options.automation)
        : automation();
      var onlyMemberId = text(options.onlyMemberId);

      var context = {
        api: api,
        logger: logger,
        clock: clock,
        decodeQr: decodeQr,
        automation: engineModule,
        record: function (round) {
          try {
            return recordRound(round);
          } catch (e) {
            return null;
          }
        },
      };

      var finish = function (out) {
        runState.running = false;
        return out;
      };

      if (!api) {
        return finish({ busy: false, error: 'api-unavailable', results: [], byMember: {}, at: now() });
      }
      if (!engineModule || typeof engineModule.createEngine !== 'function') {
        return finish({ busy: false, error: 'automation-unavailable', results: [], byMember: {}, at: now() });
      }

      var state;
      try {
        state = readMembersState();
      } catch (e) {
        return finish({ busy: false, error: 'members-corrupt', results: [], byMember: {} });
      }
      if (state.corrupt) {
        return finish({ busy: false, error: 'members-corrupt', results: [], byMember: {} });
      }

      var targets = state.items.filter(function (member) {
        if (onlyMemberId) return text(member.id) === onlyMemberId;
        return member.enabled === true;
      });

      var results = [];
      var byMember = {};
      var chain = Promise.resolve();
      targets.forEach(function (member, index) {
        chain = chain.then(function () {
          return runOneMember(member, context)
            .then(function (memberOut) {
              for (var i = 0; i < memberOut.results.length; i += 1) {
                var row = memberOut.results[i];
                results.push(row);
                if (onResult) {
                  try {
                    onResult(clone(row));
                  } catch (e) {
                    logger.log('[member] onResult 回调失败（member=' + memberOut.memberName + '）');
                  }
                }
              }
              byMember[memberOut.memberId] = memberOut;
              logger.log(
                '[member] ' +
                  memberOut.memberName +
                  ' 第 ' +
                  (index + 1) +
                  '/' +
                  targets.length +
                  ' 位完成：' +
                  memberOut.results.length +
                  ' 条结果',
              );
            })
            .catch(function (error) {
              var failureRow = {
                module: 'member',
                action: 'run',
                activityId: '',
                status: 'unknown',
                reason: 'member-error',
                at: safeNow(clock),
                memberId: member.id,
                memberName: member.name,
              };
              results.push(failureRow);
              if (onResult) {
                try {
                  onResult(clone(failureRow));
                } catch (e) {
                  /* ignore */
                }
              }
              try {
                recordRound({
                  memberId: member.id,
                  memberName: member.name,
                  results: [failureRow],
                  at: failureRow.at,
                  dryRun: false,
                });
              } catch (e) {
                /* ignore */
              }
              byMember[member.id] = {
                memberId: member.id,
                memberName: member.name,
                results: [failureRow],
                summary: null,
                dryRun: null,
                ekScan: null,
                error: {
                  code: (error && error.code) || 'member-error',
                  message: sanitizeError(error),
                },
              };
              logger.log('[member] ' + member.name + ' 运行异常（已隔离）：' + sanitizeError(error));
            });
        });
      });

      return chain
        .then(function () {
          var finishedAt = safeNow(clock);
          var globalDryRun = effectiveConfig(null).dryRun !== false;
          return finish({
            busy: false,
            results: results,
            byMember: byMember,
            summary: summarizeRows(results),
            startedAt: startedAt,
            finishedAt: finishedAt,
            at: finishedAt,
            dryRun: globalDryRun,
            onlyMemberId: onlyMemberId || null,
            ranMembers: targets.length,
          });
        })
        .catch(function (error) {
          return finish({
            busy: false,
            error: 'run-failed',
            detail: sanitizeError(error),
            results: results,
            byMember: byMember,
            at: safeNow(clock),
          });
        });
    }

    function isRunning() {
      return runState.running;
    }

    return {
      // 常量（UI/统计可直接用，无需硬编码 key）
      KEYS: {
        members: MEMBERS_KEY,
        globalConfig: GLOBAL_CONFIG_KEY,
        configPrefix: CONFIG_PREFIX,
        statePrefix: STATE_PREFIX,
        scoresPrefix: SCORES_PREFIX,
        results: RESULTS_KEY,
      },
      ENGINE_KEYS: ENGINE_KEYS,
      MEMBER_DEFAULTS: MEMBER_DEFAULTS,

      // 成员 CRUD
      load: load,
      save: save,
      upsertMember: upsertMember,
      removeMember: removeMember,
      getMember: getMember,
      hasMember: hasMember,
      selectMember: selectMember,
      clearMembers: clearMembers,

      // 二课会话 / 凭证
      setEkSession: setEkSession,
      clearEkSession: clearEkSession,
      loginEk: loginEk,
      refreshEk: refreshEk,
      verifyUnirun: verifyUnirun,

      // 官方成绩同步（八模块缺口，取消手填）
      syncOfficialScores: syncOfficialScores,
      syncAllOfficialScores: syncAllOfficialScores,
      getMemberScoreSnapshot: getMemberScoreSnapshot,
      SCORE_MODULES: SCORE_MODULES,

      // config
      loadGlobalConfig: loadGlobalConfig,
      saveGlobalConfig: saveGlobalConfig,
      saveConfig: saveConfig,
      setConfig: setConfig,
      effectiveConfig: effectiveConfig,

      // storage 适配
      engineStorage: engineStorage,
      resultsStorage: resultsStorage,

      // 结果历史（保留 memberId）
      appendResult: appendResult,
      recordRound: recordRound,
      loadResults: loadResults,
      resultsHealth: resultsHealth,
      clearResults: clearResults,

      // 导出（脱敏）
      toPublicMember: toPublicMember,
      exportMembers: exportMembers,

      // 运行
      runAll: runAll,
      isRunning: isRunning,
    };
  }

  // ─────────────────────────── 默认单例（浏览器 localStorage） ───────────────────────────

  var singleton = null;
  function instance() {
    if (!singleton) singleton = createMembers({});
    return singleton;
  }

  var exported = {
    /** 工厂：注入 storage/clock/automation，便于 Node 测试与多实例 */
    createMembers: createMembers,
    /** 纯工具（UI/测试可直接复用） */
    deepMerge: deepMerge,
    stripDryRun: stripDryRun,
    maskPhone: maskPhone,
    sanitizeError: sanitizeError,
    beijingDay: beijingDay,
    normalizeMember: normalizeMember,
    /** 官方成绩口径（UI/测试可直接复用，避免各自硬编码模块名） */
    SCORE_MODULES: SCORE_MODULES,
    parseOfficialScoreResponse: parseOfficialScoreResponse,
    INFO_SCORE_KEYS: INFO_SCORE_KEYS,
  };

  // 单例方法：与工厂实例同签名，作用域为浏览器 localStorage
  var SINGLETON_METHODS = [
    'load',
    'save',
    'upsertMember',
    'removeMember',
    'getMember',
    'hasMember',
    'selectMember',
    'clearMembers',
    'setEkSession',
    'clearEkSession',
    'loginEk',
    'refreshEk',
    'verifyUnirun',
    'syncOfficialScores',
    'syncAllOfficialScores',
    'getMemberScoreSnapshot',
    'loadGlobalConfig',
    'saveGlobalConfig',
    'saveConfig',
    'setConfig',
    'effectiveConfig',
    'engineStorage',
    'resultsStorage',
    'appendResult',
    'recordRound',
    'loadResults',
    'resultsHealth',
    'clearResults',
    'toPublicMember',
    'exportMembers',
    'runAll',
    'isRunning',
  ];
  SINGLETON_METHODS.forEach(function (name) {
    exported[name] = function () {
      var target = instance();
      return target[name].apply(target, arguments);
    };
  });

  return exported;
});
