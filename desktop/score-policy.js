/**
 * 二课（EK）积分缺口策略 —— 纯函数模块。零 IO、零网络、零凭证、无副作用。
 *
 * 数据口径全部来自恢复的 3CT 真实源码：
 *  - 八个模块与 required 分值：renderer/.../SecondClass/EkScoresPanel.tsx 的 `EK_SCORE_NEED`
 *  - 官方成绩接口：ctAPI.ek.getStudentScores({requestsData})
 *      -> { Info:{StudentId,SumGetNum,...}, TypeList:[{CurriculumName, SumScore, ScoreList}] }
 *  - 活动类别：详情 ActivityInfo.ModuleCodeText（首选，exact 中文名）
 *              列表 item.ModuleCode + 官方 ModuleCodeList（真实字段 label|Label + value|Value）
 *
 * 安全原则：
 *  - 官方数据缺失/结构异常 -> 该模块 current = null（trusted:false），**绝不当作 0**
 *  - 类别未知（无法映射）-> category:null，策略一律不允许报名（fail closed）
 *  - snapshot 必须绑定 accountId；账号显式不一致时拒绝覆盖官方数据
 *  - 已达标模块只阻断「新增报名」，不影响已报名活动的签到/签退（由 engine 保证）
 *
 * 用法：
 *   Node:  const P = require('./score-policy.js')
 *   Browser: <script src="score-policy.js"> -> window.Auto3CTScorePolicy
 */
(function (root, factory) {
  'use strict';
  var mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  if (root) root.Auto3CTScorePolicy = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** 八个真实模块与达标分值（与 EkScoresPanel.tsx 的 EK_SCORE_NEED 完全一致） */
  var MODULES = [
    { name: '思想政治与道德修养', required: 12 },
    { name: '学术科技与创新创业', required: 8 },
    { name: '艺术体验与审美修养', required: 12 },
    { name: '传统文化与人文素养', required: 8 },
    { name: '人际交往与沟通能力', required: 8 },
    { name: '心理素质与身体素质', required: 12 },
    { name: '社会实践与志愿服务', required: 12 },
    { name: '社会工作与能力拓展', required: 8 },
  ];

  var MODULE_NAME_SET = MODULES.reduce(function (acc, m) {
    acc[m.name] = true;
    return acc;
  }, {});

  /** 用户截图的八模块初值（公开模板，无 PII；仅用户显式导入并绑定账号后生效） */
  var SCREENSHOT_INITIAL = [
    { name: '思想政治与道德修养', required: 12, current: 6 },
    { name: '学术科技与创新创业', required: 8, current: 4 },
    { name: '艺术体验与审美修养', required: 12, current: 2 },
    { name: '传统文化与人文素养', required: 8, current: 8.5 },
    { name: '人际交往与沟通能力', required: 8, current: 4 },
    { name: '心理素质与身体素质', required: 12, current: 15.5 },
    { name: '社会实践与志愿服务', required: 12, current: 11 },
    { name: '社会工作与能力拓展', required: 8, current: 3.5 },
  ];

  var DEFAULT_STALE_MS = 24 * 60 * 60 * 1000;
  /** updatedAt 允许的最大未来漂移（防本机时钟/伪造时间戳） */
  var MAX_FUTURE_DRIFT_MS = 5 * 60 * 1000;
  var VALID_SOURCES = { manual: true, official: true };

  // ───────────────────────── 基础工具 ─────────────────────────

  function isFiniteNumber(v) {
    return typeof v === 'number' && Number.isFinite(v);
  }

  /** 字符串/数字 → 有限数字；其余 → null（缺失绝不当 0） */
  function toFiniteOrNull(v) {
    if (isFiniteNumber(v)) return v;
    if (typeof v === 'string' && v.trim() !== '') {
      var n = Number(v);
      if (Number.isFinite(n)) return n;
    }
    return null;
  }

  function text(v) {
    return typeof v === 'string' ? v.trim() : '';
  }

  function round2(n) {
    return Number(n.toFixed(2));
  }

  function moduleByName(name) {
    for (var i = 0; i < MODULES.length; i += 1) {
      if (MODULES[i].name === name) return MODULES[i];
    }
    return null;
  }

  /** 截图初值模板（深拷贝，避免调用方修改常量） */
  function getScreenshotInitialModules() {
    return SCREENSHOT_INITIAL.map(function (m) {
      return { name: m.name, required: m.required, current: m.current };
    });
  }

  // ───────────────────────── snapshot ─────────────────────────

  /**
   * 构造 snapshot（会严格校验，非法直接抛错 —— 绝不悄悄回默认值）。
   * @param {{accountId:string, source?:string, modules:Array, updatedAt?:number, accountVerified?:boolean}} input
   */
  function buildSnapshot(input) {
    var src = input || {};
    var accountId = text(src.accountId);
    if (!accountId) throw new Error('snapshot 缺少 accountId（必须绑定当前二课账号）');

    var source = src.source === undefined ? 'manual' : src.source;
    if (!VALID_SOURCES[source]) throw new Error('snapshot.source 仅允许 manual | official');

    var nowMs = Date.now();
    var updatedAt = src.updatedAt === undefined ? nowMs : src.updatedAt;
    if (!isFiniteNumber(updatedAt) || updatedAt <= 0) throw new Error('snapshot.updatedAt 必须是正数毫秒时间戳');
    if (updatedAt > nowMs + MAX_FUTURE_DRIFT_MS) throw new Error('snapshot.updatedAt 不得是未来时间');

    var rawModules = Array.isArray(src.modules) ? src.modules : [];
    if (rawModules.length === 0) throw new Error('snapshot 至少需要一个模块');

    var seen = {};
    var modules = rawModules.map(function (m) {
      var name = text(m && m.name);
      if (!MODULE_NAME_SET[name]) throw new Error('snapshot 含未知模块：' + (name || '（空）'));
      if (seen[name]) throw new Error('snapshot 模块重复：' + name);
      seen[name] = true;

      // required：未提供时用策略默认；提供则必须是有限正数（NaN/字符串非法值一律拒绝）
      var required;
      if (m && m.required === undefined) {
        required = moduleByName(name).required;
      } else {
        required = toFiniteOrNull(m && m.required);
        if (required === null) throw new Error('模块 required 必须是有效数字：' + name);
        if (!(required > 0)) throw new Error('模块 required 必须大于 0：' + name);
      }

      // current：未提供/null 表示未知；提供则必须是有限非负数
      var current;
      if (!m || m.current === undefined || m.current === null) {
        current = null;
      } else {
        current = toFiniteOrNull(m.current);
        if (current === null) throw new Error('模块 current 必须是有效数字或 null：' + name);
        if (current < 0) throw new Error('模块 current 不能为负：' + name);
      }

      var trusted = current !== null && !(m && m.trusted === false);
      return { name: name, required: required, current: current, trusted: trusted };
    });

    return {
      accountId: accountId,
      source: source,
      updatedAt: updatedAt,
      accountVerified: Boolean(src.accountVerified),
      modules: modules,
    };
  }

  /**
   * 校验 snapshot 是否可作为策略输入（严格）。
   * @returns {{ok:boolean, reason?:string}}
   */
  function validateSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return { ok: false, reason: 'missing-snapshot' };
    if (!text(snapshot.accountId)) return { ok: false, reason: 'missing-account' };
    if (!ARRAY(snapshot.modules) || snapshot.modules.length === 0) {
      return { ok: false, reason: 'empty-modules' };
    }
    if (snapshot.source !== undefined && !VALID_SOURCES[snapshot.source]) {
      return { ok: false, reason: 'invalid-source' };
    }
    var updatedAt = snapshot.updatedAt;
    if (!isFiniteNumber(updatedAt) || updatedAt <= 0) {
      return { ok: false, reason: 'invalid-updated-at' };
    }
    if (updatedAt > Date.now() + MAX_FUTURE_DRIFT_MS) {
      return { ok: false, reason: 'future-timestamp' };
    }

    var seen = {};
    for (var i = 0; i < snapshot.modules.length; i += 1) {
      var m = snapshot.modules[i] || {};
      var name = text(m.name);
      if (!MODULE_NAME_SET[name]) return { ok: false, reason: 'unknown-module' };
      if (seen[name]) return { ok: false, reason: 'duplicate-module' };
      seen[name] = true;

      var required = toFiniteOrNull(m.required);
      if (required === null || !(required > 0)) return { ok: false, reason: 'invalid-required' };

      if (m.current !== undefined && m.current !== null) {
        var current = toFiniteOrNull(m.current);
        if (current === null || current < 0) return { ok: false, reason: 'invalid-current' };
      }
    }
    return { ok: true };
  }

  function ARRAY(v) {
    return Array.isArray(v);
  }

  // ───────────────────────── 缺口 ─────────────────────────

  /**
   * 逐模块计算缺口。
   * current 缺失 -> trusted:false、gap:null（绝不按 0 计算）。
   */
  function computeGaps(snapshot) {
    var modules = Array.isArray(snapshot && snapshot.modules) ? snapshot.modules : [];
    var out = [];
    var totalGap = 0;
    var satisfied = [];
    var trustedAll = modules.length > 0;

    // 以 MODULES 的固定顺序输出，保证 UI 稳定
    MODULES.forEach(function (defined) {
      var found = null;
      for (var i = 0; i < modules.length; i += 1) {
        if (modules[i] && modules[i].name === defined.name) {
          found = modules[i];
          break;
        }
      }
      if (!found) {
        // snapshot 里没有该模块：未知，不可信
        trustedAll = false;
        out.push({
          name: defined.name,
          required: defined.required,
          current: null,
          gap: null,
          satisfied: false,
          trusted: false,
        });
        return;
      }
      var required = toFiniteOrNull(found.required);
      if (required === null) required = defined.required;
      var current = toFiniteOrNull(found.current);
      var explicitlyUntrusted = found.trusted === false;
      if (current === null || explicitlyUntrusted) {
        // 不可信：不产生缺口数值、不计入 totalGap（绝不按 0 制造伪缺口）
        if (current === null) trustedAll = false;
        if (explicitlyUntrusted) trustedAll = false;
        out.push({
          name: defined.name,
          required: required,
          current: current === null ? null : current,
          gap: null,
          satisfied: false,
          trusted: false,
        });
        return;
      }
      var gap = round2(Math.max(0, required - current));
      var satisfiedFlag = current >= required;
      if (satisfiedFlag) satisfied.push(defined.name);
      totalGap += gap;
      out.push({
        name: defined.name,
        required: required,
        current: current,
        gap: gap,
        satisfied: satisfiedFlag,
        trusted: true,
      });
    });

    return {
      modules: out,
      totalGap: round2(totalGap),
      satisfiedModules: satisfied,
      satisfiedCount: satisfied.length,
      trusted: trustedAll,
    };
  }

  // ───────────────────────── 官方成绩解析 ─────────────────────────

  /**
   * 解析 ctAPI.ek.getStudentScores 的返回。
   * @returns {{ok:boolean, accountHint:string, modules:Array<{name,current,trusted}>, unknown:Array, reason?:string}}
   */
  function parseOfficialScores(resp) {
    if (!resp || typeof resp !== 'object') return { ok: false, reason: 'no-response', accountHint: '', modules: [], unknown: [] };
    var typeList = Array.isArray(resp.TypeList) ? resp.TypeList : null;
    if (!typeList || typeList.length === 0) {
      return { ok: false, reason: 'empty-typelist', accountHint: '', modules: [], unknown: [] };
    }

    var modules = [];
    var unknown = [];
    var recognized = 0;
    var duplicateNames = {};

    typeList.forEach(function (item) {
      if (!item || typeof item !== 'object') return;
      var name = text(item.CurriculumName);
      if (!name) return;
      var current = toFiniteOrNull(item.SumScore);
      if (!MODULE_NAME_SET[name]) {
        // 官方出现了策略外模块：记录但不参与策略（更不按 0 均摊）
        if (current !== null) unknown.push({ name: name, current: current });
        return;
      }
      // 同一模块重复出现：不 last-wins 瞎选，直接判不可信
      if (duplicateNames[name]) {
        duplicateNames[name] += 1;
        return;
      }
      duplicateNames[name] = 1;
      recognized += 1;
      modules.push({
        name: name,
        current: current,
        trusted: current !== null,
      });
    });

    var duplicated = Object.keys(duplicateNames).filter(function (n) {
      return duplicateNames[n] > 1;
    });
    if (duplicated.length > 0) {
      return { ok: false, reason: 'duplicate-module', accountHint: '', modules: [], unknown: unknown };
    }

    if (recognized === 0) {
      return { ok: false, reason: 'no-recognized-module', accountHint: '', modules: [], unknown: unknown };
    }

    var info = resp.Info && typeof resp.Info === 'object' ? resp.Info : {};
    // StudentId 可能是数字：必须 String 化，否则空串会逃过身份比对
    var accountHint =
      text(info.StudentId) ||
      (isFiniteNumber(info.StudentId) ? String(info.StudentId) : '') ||
      text(info.LoginName) ||
      (isFiniteNumber(info.LoginName) ? String(info.LoginName) : '') ||
      text(info.StudentNo) ||
      (isFiniteNumber(info.StudentNo) ? String(info.StudentNo) : '');

    return { ok: true, accountHint: accountHint, modules: modules, unknown: unknown };
  }

  /**
   * 把官方解析结果合并进旧 snapshot。
   *  - 保留 required（来自策略，不依赖上游）
   *  - 用官方 current 覆盖；官方缺字段的模块保留旧 current 但标 trusted:false
   *  - accountHint 与 accountId 显式不一致 -> 抛 account-mismatch（拒绝覆盖）
   */
  function mergeOfficialSnapshot(oldSnapshot, parsed, accountId, updatedAt) {
    if (!parsed || !parsed.ok) {
      throw new Error('官方成绩不可信，拒绝覆盖：' + String((parsed && parsed.reason) || 'unknown'));
    }
    var account = text(accountId);
    if (!account) throw new Error('缺少当前账号，拒绝覆盖官方成绩');

    var hint = text(parsed.accountHint);
    if (hint && hint !== account) {
      throw new Error('account-mismatch：官方成绩属于其他账号（' + hint + '），拒绝覆盖');
    }

    var baseModules = Array.isArray(oldSnapshot && oldSnapshot.modules) ? oldSnapshot.modules : [];
    var officialByName = {};
    (parsed.modules || []).forEach(function (m) {
      officialByName[m.name] = m;
    });

    var merged = MODULES.map(function (defined) {
      var old = null;
      for (var i = 0; i < baseModules.length; i += 1) {
        if (baseModules[i] && baseModules[i].name === defined.name) {
          old = baseModules[i];
          break;
        }
      }
      // 保留用户可能编辑过的合法 required（仅当为有限正数）
      var oldRequired = old ? toFiniteOrNull(old.required) : null;
      var required = oldRequired !== null && oldRequired > 0 ? oldRequired : defined.required;

      var official = officialByName[defined.name];
      var oldCurrent = old ? toFiniteOrNull(old.current) : null;
      if (official && official.current !== null) {
        return { name: defined.name, required: required, current: official.current, trusted: true };
      }
      // 官方没有该模块的分：保留旧值（若有），但标记不可信
      return {
        name: defined.name,
        required: required,
        current: oldCurrent,
        trusted: false,
      };
    });

    return {
      accountId: account,
      source: 'official',
      updatedAt: isFiniteNumber(updatedAt) ? updatedAt : Date.now(),
      accountVerified: Boolean(hint),
      modules: merged,
    };
  }

  // ───────────────────────── 模块选项 ─────────────────────────

  /**
   * 规范化官方 ModuleCodeList。
   * 真实源码（EkActivitiesPanel.tsx normalizeOptions）只认 label|Label + value|Value；
   * 此处严格保持该口径（Text/Value 不认，避免与真实字段漂移）。
   */
  function normalizeModuleOptions(raw) {
    if (!Array.isArray(raw)) return [];
    var out = [];
    raw.forEach(function (it) {
      if (!it || typeof it !== 'object') return;
      var label = text(it.label) || text(it.Label);
      var value = text(it.value) || text(it.Value);
      if (!label || !value) return;
      out.push({ label: label, value: value });
    });
    return out;
  }

  // ───────────────────────── 活动归类 ─────────────────────────

  /**
   * 判定活动属于哪个二课模块（严格，不猜）。
   *  1) 详情 ActivityInfo.ModuleCodeText exact 命中八模块 -> via:'text'
   *  2) 列表 item.ModuleCode 经官方 ModuleCodeList 的 value->label exact 映射 -> via:'code'
   *  3) 都失败 -> category:null, reason:'category-unknown'
   * 绝不使用活动标题/字母/拼音推断。
   */
  function resolveActivityCategory(input) {
    var args = input || {};
    var info = args.detailInfo && typeof args.detailInfo === 'object' ? args.detailInfo : {};
    var listItem = args.listItem && typeof args.listItem === 'object' ? args.listItem : {};
    var options = Array.isArray(args.moduleOptions) ? args.moduleOptions : [];

    var textName = text(info.ModuleCodeText) || text(info.ModuleName);
    if (textName) {
      if (MODULE_NAME_SET[textName]) return { category: textName, reason: '', via: 'text' };
      return { category: null, reason: 'category-unknown', via: null };
    }

    var code = text(listItem.ModuleCode) || text(listItem.ModuleCodeValue);
    if (code) {
      for (var i = 0; i < options.length; i += 1) {
        var opt = options[i] || {};
        if (text(opt.value) === code) {
          var label = text(opt.label);
          if (MODULE_NAME_SET[label]) return { category: label, reason: '', via: 'code' };
          return { category: null, reason: 'category-unknown', via: null };
        }
      }
      return { category: null, reason: 'category-unknown', via: null };
    }

    return { category: null, reason: 'category-unknown', via: null };
  }

  // ───────────────────────── 策略判定 ─────────────────────────

  /**
   * 评估当前策略。
   * @param {{snapshot:object|null, accountId:string, now?:number, staleMs?:number, enabled?:boolean}} input
   */
  function evaluatePolicy(input) {
    var args = input || {};
    var now = isFiniteNumber(args.now) ? args.now : Date.now();
    var staleMs = isFiniteNumber(args.staleMs) ? args.staleMs : DEFAULT_STALE_MS;
    var accountId = text(args.accountId);
    var enabled = args.enabled === undefined ? true : Boolean(args.enabled);
    var snapshot = args.snapshot;

    var check = validateSnapshot(snapshot);
    var result = {
      enabled: enabled,
      trusted: false,
      accountMatch: false,
      stale: false,
      reason: '',
      gaps: [],
      modules: [],
      satisfiedModules: [],
      totalGap: null,
      refreshedAt: snapshot && isFiniteNumber(snapshot.updatedAt) ? snapshot.updatedAt : null,
      source: (snapshot && text(snapshot.source)) || 'unknown',
    };

    if (!check.ok) {
      result.reason = check.reason === 'missing-account' ? 'score-account-mismatch' : 'score-snapshot-missing';
      if (check.reason === 'unknown-module' || check.reason === 'empty-modules') result.reason = 'score-untrusted';
      result.trusted = false;
      return result;
    }

    result.accountMatch = Boolean(accountId) && text(snapshot.accountId) === accountId;
    if (!result.accountMatch) {
      result.reason = 'score-account-mismatch';
      return result;
    }

    var gaps = computeGaps(snapshot);
    result.gaps = gaps.modules;
    result.modules = gaps.modules;
    result.satisfiedModules = gaps.satisfiedModules;
    result.totalGap = gaps.totalGap;

    var updatedAt = isFiniteNumber(snapshot.updatedAt) ? snapshot.updatedAt : 0;
    result.stale = updatedAt > 0 ? now - updatedAt > staleMs : true;

    if (!gaps.trusted) {
      result.reason = 'score-untrusted';
      return result;
    }
    if (result.stale) {
      result.reason = 'score-stale';
      return result;
    }
    // 禁用策略时不限制（但仍返回缺口用于展示）
    result.trusted = true;
    result.reason = enabled ? 'ok' : 'policy-disabled';
    return result;
  }

  /**
   * 是否允许为某类别新增报名。
   * @returns {{allow:boolean, reason:string}}
   */
  function canApplyCategory(policy, category) {
    var p = policy || {};
    var name = text(category);
    if (!name || !MODULE_NAME_SET[name]) return { allow: false, reason: 'category-unknown' };
    if (p.enabled === false) return { allow: true, reason: 'policy-disabled' };
    if (!p.trusted) return { allow: false, reason: p.reason || 'score-untrusted' };
    if (p.stale) return { allow: false, reason: 'score-stale' };
    for (var i = 0; i < (p.satisfiedModules || []).length; i += 1) {
      if (p.satisfiedModules[i] === name) return { allow: false, reason: 'module-satisfied' };
    }
    return { allow: true, reason: 'ok' };
  }

  return {
    MODULES: MODULES,
    SCREENSHOT_INITIAL: SCREENSHOT_INITIAL,
    DEFAULT_STALE_MS: DEFAULT_STALE_MS,
    getScreenshotInitialModules: getScreenshotInitialModules,
    buildSnapshot: buildSnapshot,
    validateSnapshot: validateSnapshot,
    computeGaps: computeGaps,
    parseOfficialScores: parseOfficialScores,
    mergeOfficialSnapshot: mergeOfficialSnapshot,
    normalizeModuleOptions: normalizeModuleOptions,
    resolveActivityCategory: resolveActivityCategory,
    evaluatePolicy: evaluatePolicy,
    canApplyCategory: canApplyCategory,
    // 供测试/上层复用的工具
    toFiniteOrNull: toFiniteOrNull,
    moduleByName: moduleByName,
  };
});
