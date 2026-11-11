/* 1CT 二课统计：把本机执行记录 + 官方成绩算成「签到/签退次数 + 八模块缺口」，并渲染成只读区块；不读取、不输出任何凭据与完整手机号。 */
(function (root, factory) {
  'use strict';
  var mod = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = mod;
  if (root) root.OneCTStats = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var VERSION = 1;
  /** 统计窗口天数（与 result-store RETAIN_DAYS 一致，不在此处另设口径）。 */
  var WINDOW_DAYS = 90;
  var DAY_MS = 24 * 60 * 60 * 1000;
  var BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
  /** 积分快照「过期」阈值：优先取 score-policy.DEFAULT_STALE_MS（24h）。 */
  var DEFAULT_STALE_MS = DAY_MS;
  var MAX_TEXT_LEN = 200;
  var MAX_REASON_LEN = 80;
  var DEFAULT_MAX_ACTIVITIES = 8;

  var MODULE_EK = 'ek';

  /** 二课会话状态（成员维度，来自 OneCTMembers）：只认这三个值。 */
  var EK_STATUSES = { ok: true, expired: true, none: true };
  var EK_STATUS_LABELS = {
    ok: '二课已登录',
    expired: '二课会话已过期，需重新登录',
    none: '未登录二课',
  };

  /** 与 result-store/summary 相同的等待类状态。 */
  var WAITING_STATUSES = { 'waiting-material': true, 'not-yet': true };

  /** 与 result-store/summary 相同的签到/签退 action 别名（引擎实际发 signIn/signOut）。 */
  var IN_ACTIONS = { signin: true, checkin: true, in: true, attend: true };
  var OUT_ACTIONS = { signout: true, checkout: true, out: true, leave: true };

  var STATUS_LABELS = {
    success: '成功',
    failed: '失败',
    unknown: '未知',
    'waiting-material': '等待',
    'not-yet': '未开始',
    blocked: '拦截',
    skipped: '跳过',
    retry: '重试',
    legacy: '历史',
  };

  // ───────────────────────── 基础工具 ─────────────────────────

  function isFiniteNumber(value) {
    return typeof value === 'number' && isFinite(value);
  }

  function finiteNumberOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    var number = typeof value === 'number' ? value : Number(value);
    return isFinite(number) ? number : null;
  }

  /** 取第一个有限数字；全不合法时返回 null。 */
  function firstFiniteNumber() {
    for (var i = 0; i < arguments.length; i += 1) {
      var number = finiteNumberOrNull(arguments[i]);
      if (number !== null) return number;
    }
    return null;
  }

  function toCount(value) {
    var number = finiteNumberOrNull(value);
    if (number === null) return 0;
    return Math.max(0, Math.round(number));
  }

  function round2(value) {
    return Math.round(value * 100) / 100;
  }

  /** 纯文本裁剪（不做掩码；需要对外展示时用 safeText/maskPhones）。 */
  function text(value, maxLen) {
    if (value === null || value === undefined) return '';
    var str = String(value).trim();
    if (maxLen && str.length > maxLen) str = str.slice(0, maxLen);
    return str;
  }

  /** 11 位手机号 -> 前 3 + **** + 后 4。 */
  function maskPhones(value) {
    var str = value === null || value === undefined ? '' : String(value);
    return str.replace(/1\d{10}/g, function (matched) {
      return matched.slice(0, 3) + '****' + matched.slice(7);
    });
  }

  /** 对外展示/导出文本：先裁剪再掩码。 */
  function safeText(value, maxLen) {
    return maskPhones(text(value, maxLen));
  }

  function beijingParts(ms) {
    var value = finiteNumberOrNull(ms);
    if (value === null) return null;
    var iso = new Date(value + BEIJING_OFFSET_MS).toISOString();
    return {
      year: iso.slice(0, 4),
      month: iso.slice(5, 7),
      day: iso.slice(8, 10),
      hour: iso.slice(11, 13),
      minute: iso.slice(14, 16),
    };
  }

  /** 北京日期 YYYY-MM-DD（与 result-store.beijingDay 同口径）。 */
  function beijingDay(ms) {
    var value = finiteNumberOrNull(ms);
    var safe = value === null ? 0 : value;
    return new Date(safe + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
  }

  /** YYYY-MM-DD HH:mm（北京时区）。 */
  function formatAt(ms) {
    var parts = beijingParts(ms);
    if (!parts) return '';
    return parts.year + '-' + parts.month + '-' + parts.day + ' ' + parts.hour + ':' + parts.minute;
  }

  /** MM-DD HH:mm（北京时区；卡片用的紧凑时间）。 */
  function formatShortAt(ms) {
    var parts = beijingParts(ms);
    if (!parts) return '';
    return parts.month + '-' + parts.day + ' ' + parts.hour + ':' + parts.minute;
  }

  /** 数值展示：整数不带小数点，小数最多保留 2 位。 */
  function formatNumber(value) {
    var number = finiteNumberOrNull(value);
    if (number === null) return '';
    return String(round2(number));
  }

  /** 把「当前 / 要求」拆成两段，缺失时分别显示「—」与「未填」，避免与脚注重复。 */
  function scoreParts(moduleData) {
    var required = finiteNumberOrNull(moduleData && moduleData.required);
    var current = finiteNumberOrNull(moduleData && moduleData.current);
    var trusted = moduleData && moduleData.trusted !== false;
    return {
      required: required === null ? '—' : formatNumber(required),
      current: current === null ? '—' : formatNumber(current),
      trusted: trusted,
      hasCurrent: current !== null,
    };
  }

  function normalizeAction(action) {
    return text(action).toLowerCase().replace(/[\s_-]+/g, '');
  }

  function actionKind(action) {
    var normalized = normalizeAction(action);
    if (IN_ACTIONS[normalized]) return 'in';
    if (OUT_ACTIONS[normalized]) return 'out';
    return null;
  }

  function normalizeStatus(status) {
    var value = text(status).toLowerCase().replace(/_/g, '-');
    if (!value) return '';
    if (value === 'already-done') return 'skipped';
    return value;
  }

  function statusLabel(status) {
    var value = normalizeStatus(status);
    if (!value) return '';
    return STATUS_LABELS[value] || value;
  }

  function resolveNow(args) {
    var value = args && args.now;
    if (!isFiniteNumber(value) && args && args.clock && typeof args.clock.now === 'function') {
      try {
        value = args.clock.now();
      } catch (e) {
        value = undefined;
      }
    }
    var number = finiteNumberOrNull(value);
    return number !== null && number > 0 ? number : Date.now();
  }

  // ───────────────────────── score-policy 运行时解析 ─────────────────────────

  /** 运行时解析 score-policy：浏览器 window.Auto3CTScorePolicy 优先，Node require 兜底。 */
  function loadScorePolicy() {
    if (root && root.Auto3CTScorePolicy) return root.Auto3CTScorePolicy;
    if (typeof require === 'function') {
      try {
        var policy = require('../score-policy.js');
        if (policy && policy.MODULES) return policy;
      } catch (e) {
        /* 浏览器/打包环境无 require，忽略 */
      }
    }
    if (root && root.OneCTScorePolicy) return root.OneCTScorePolicy;
    return null;
  }

  /** 八模块定义（来自 score-policy；不可用时返回空数组，不复制常量）。 */
  function getModules() {
    var policy = loadScorePolicy();
    var defs = policy && Array.isArray(policy.MODULES) ? policy.MODULES : [];
    var out = [];
    for (var i = 0; i < defs.length; i += 1) {
      var def = defs[i] || {};
      var name = text(def.name);
      if (!name) continue;
      out.push({ name: name, required: finiteNumberOrNull(def.required) });
    }
    return out;
  }

  // ───────────────────────── 事件输入与过滤 ─────────────────────────

  /**
   * 事件入参：数组（`OneCTMembers.loadResults()` 返回裸数组）或 `{version, events}` 包装。
   *
   * 刻意**不接受** Auto3CTResults 的 store 实例（带 snapshot()/list()/recordRound()/append() 的对象）：
   * result-store 的 ALLOWED_FIELDS 白名单不含 memberId/memberName，load() 会重新 sanitize，
   * 经它读出来的事件必然丢失成员归属（实测只剩 key,at,day,module,action,status,preview,dryRun,legacy,source），
   * 按成员分组会静默变成空组。这类误用直接抛错，避免「统计全 0 但界面不报错」的隐形故障。
   */
  function normalizeEventsInput(input) {
    if (!input) return [];
    if (Array.isArray(input)) return input;
    if (typeof input !== 'object') return [];
    if (Array.isArray(input.events)) return input.events;
    var looksLikeResultStore =
      typeof input.snapshot === 'function' ||
      typeof input.list === 'function' ||
      typeof input.recordRound === 'function' ||
      typeof input.append === 'function';
    if (looksLikeResultStore) {
      throw new TypeError(
        'OneCTStats.build: events 必须传事件数组或 OneCTMembers.loadResults() 的返回值；' +
          '不要传 Auto3CTResults store 实例——其字段白名单不含 memberId，会丢失成员归属导致统计全空。'
      );
    }
    return [];
  }

  /**
   * 成员隔离：默认只保留 event.memberId === memberId 的事件；
   * 无 memberId 的历史事件默认丢弃（多成员下无法归属），includeUnscoped 可显式纳入。
   * memberId 为空时（无成员上下文）不做过滤。
   */
  function filterEventsForMember(events, memberId, includeUnscoped) {
    if (!Array.isArray(events) || events.length === 0) return [];
    var out = [];
    for (var i = 0; i < events.length; i += 1) {
      var event = events[i];
      if (!event || typeof event !== 'object') continue;
      var eventMemberId = text(event.memberId);
      if (!memberId) {
        out.push(event);
      } else if (eventMemberId === memberId) {
        out.push(event);
      } else if (!eventMemberId && includeUnscoped) {
        out.push(event);
      }
    }
    return out;
  }

  function eventDay(event) {
    var day = text(event && event.day);
    if (/^\d{4}-\d{2}-\d{2}$/.test(day)) return day;
    return beijingDay(event && event.at);
  }

  /** 最近 N 天（按北京日期与 result-store 同口径）。 */
  function filterRecent(events, nowMs, windowDays) {
    if (!Array.isArray(events) || events.length === 0) return [];
    var cutoff = beijingDay(nowMs - windowDays * DAY_MS);
    var out = [];
    for (var i = 0; i < events.length; i += 1) {
      var event = events[i];
      if (!event || typeof event !== 'object') continue;
      if (eventDay(event) < cutoff) continue;
      out.push(event);
    }
    return out;
  }

  function isCountableEkEvent(event) {
    if (!event || typeof event !== 'object') return false;
    if (event.preview === true || event.dryRun === true) return false;
    if (event.legacy === true) return false;
    return text(event.module).toLowerCase() === MODULE_EK;
  }

  // ───────────────────────── 签到 / 签退计数 ─────────────────────────

  function emptyBucket() {
    return {
      success: 0,
      failed: 0,
      waiting: 0,
      lastAt: null,
      lastSuccessAt: null,
      blocked: 0,
      skipped: 0,
      unknown: 0,
      total: 0,
    };
  }

  function bumpBucket(bucket, status, at) {
    bucket.total += 1;
    if (status === 'success') {
      bucket.success += 1;
      if (at !== null && at > 0) bucket.lastSuccessAt = Math.max(bucket.lastSuccessAt || 0, at);
    } else if (status === 'failed') {
      bucket.failed += 1;
    } else if (WAITING_STATUSES[status]) {
      bucket.waiting += 1;
    } else if (status === 'blocked') {
      bucket.blocked += 1;
    } else if (status === 'skipped' || status === 'legacy') {
      bucket.skipped += 1;
    } else {
      bucket.unknown += 1;
    }
    if (at !== null && at > 0) bucket.lastAt = Math.max(bucket.lastAt || 0, at);
  }

  /** kind: 'in' | 'out'。 */
  function buildBucket(events, kind) {
    var bucket = emptyBucket();
    for (var i = 0; i < events.length; i += 1) {
      var event = events[i];
      if (actionKind(event && event.action) !== kind) continue;
      bumpBucket(bucket, normalizeStatus(event.status), finiteNumberOrNull(event.at));
    }
    if (bucket.lastAt === 0) bucket.lastAt = null;
    if (bucket.lastSuccessAt === 0) bucket.lastSuccessAt = null;
    return bucket;
  }

  // ───────────────────────── 活动维度 ─────────────────────────

  function applyActionStatus(record, kind, status, event, at) {
    var statusField = kind === 'in' ? 'signInStatus' : 'signOutStatus';
    var reasonField = kind === 'in' ? 'signInReason' : 'signOutReason';
    var atField = kind === 'in' ? '_inAt' : '_outAt';
    var reason = normalizeStatus(status) === 'success' ? '' : safeText(event.reason, MAX_REASON_LEN);
    // 已成功过：保持 success，不被后续 failed/skipped 降级（与 result-store merge 口径一致）
    if (record[statusField] === 'success') return;
    if (normalizeStatus(status) === 'success') {
      record[statusField] = 'success';
      record[reasonField] = '';
      record[atField] = at;
      return;
    }
    if (record[statusField] === null) {
      record[statusField] = normalizeStatus(status) || 'unknown';
      record[reasonField] = reason;
      record[atField] = at;
      return;
    }
    if (at !== null && (record[atField] === null || at >= record[atField])) {
      record[statusField] = normalizeStatus(status) || 'unknown';
      record[reasonField] = reason;
      record[atField] = at;
    }
  }

  /**
   * 活动维度：只纳入至少有一次签/退动作的 ek 活动；
   * 每个活动的签到/签退状态取「有过成功 -> success；否则取最近一次的状态」。
   */
  function buildActivities(events) {
    var records = {};
    var order = [];
    for (var i = 0; i < events.length; i += 1) {
      var event = events[i];
      var kind = actionKind(event.action);
      if (!kind) continue;
      var activityId = safeText(event.activityId, MAX_TEXT_LEN);
      var name = safeText(event.activityName, MAX_TEXT_LEN);
      var category = safeText(event.category, MAX_TEXT_LEN);
      var key = activityId ? 'id:' + activityId : 'name:' + (name || category);
      var record = records[key];
      if (!record) {
        record = records[key] = {
          activityId: activityId,
          name: '',
          category: '',
          signInStatus: null,
          signOutStatus: null,
          signInReason: '',
          signOutReason: '',
          lastAt: null,
          _inAt: null,
          _outAt: null,
        };
        order.push(key);
      }
      var status = normalizeStatus(event.status);
      var at = finiteNumberOrNull(event.at);
      if (at !== null && at > 0 && (record.lastAt === null || at > record.lastAt)) record.lastAt = at;
      if (status === 'success') {
        if (name) record.name = name;
        if (category) record.category = category;
      } else {
        if (!record.name && name) record.name = name;
        if (!record.category && category) record.category = category;
      }
      applyActionStatus(record, kind, status, event, at);
    }

    var activities = [];
    for (var j = 0; j < order.length; j += 1) {
      var item = records[order[j]];
      activities.push({
        activityId: item.activityId,
        name: item.name || item.activityId || '（未命名活动）',
        category: item.category || '',
        signInStatus: item.signInStatus,
        signOutStatus: item.signOutStatus,
        lastAt: item.lastAt,
        signInReason: item.signInReason,
        signOutReason: item.signOutReason,
      });
    }
    activities.sort(function (a, b) {
      var diff = (b.lastAt || 0) - (a.lastAt || 0);
      if (diff !== 0) return diff;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
    return activities;
  }

  // ───────────────────────── 八模块 ─────────────────────────

  function moduleByName(list, name) {
    if (!Array.isArray(list)) return null;
    for (var i = 0; i < list.length; i += 1) {
      var item = list[i];
      if (item && text(item.name) === name) return item;
    }
    return null;
  }

  function validRequired(value) {
    var number = finiteNumberOrNull(value);
    return number !== null && number > 0 ? number : null;
  }

  /** score-policy 不可用时：从已有数据推导模块清单（不复制八模块常量）。 */
  function deriveModuleDefs(memberModules, snapshotModules) {
    var defs = [];
    var seen = {};
    var sources = [memberModules, snapshotModules];
    for (var s = 0; s < sources.length; s += 1) {
      var list = Array.isArray(sources[s]) ? sources[s] : [];
      for (var i = 0; i < list.length; i += 1) {
        var item = list[i] || {};
        var name = text(item.name);
        if (!name || seen[name]) continue;
        seen[name] = true;
        defs.push({ name: name, required: validRequired(item.required) });
      }
    }
    return defs;
  }

  /** score-policy 不可用时的本地缺口计算（口径同 computeGaps：缺失不当 0）。 */
  function computeGapsFallback(candidate) {
    var modules = [];
    var totalGap = 0;
    for (var i = 0; i < candidate.length; i += 1) {
      var item = candidate[i];
      var current = finiteNumberOrNull(item.current);
      var required = validRequired(item.required);
      var trusted = current !== null && required !== null && item.trusted !== false;
      var gap = null;
      var satisfied = false;
      if (trusted) {
        gap = round2(Math.max(0, required - current));
        satisfied = current >= required;
        totalGap += gap;
      }
      modules.push({
        name: item.name,
        required: required,
        current: current,
        gap: gap,
        satisfied: satisfied,
        trusted: trusted,
      });
    }
    var allTrusted = modules.length > 0;
    for (var j = 0; j < modules.length; j += 1) {
      if (modules[j].trusted !== true) {
        allTrusted = false;
        break;
      }
    }
    return { modules: modules, totalGap: round2(totalGap), trusted: allTrusted };
  }

  /**
   * 解析 scoreEntry：
   *  - {snapshot, refreshedAt, ...}（引擎 1ct:scores:<id>.accounts[accountId] 条目）
   *  - {version, accounts: {...}}（引擎原样 auto3ct:scores / 1ct:scores:<id>）
   *  - {modules: [...], updatedAt}（snapshot 本体）
   */
  function resolveScoreEntry(input, member) {
    var raw = input;
    if (!raw || typeof raw !== 'object') return { snapshot: null, refreshedAt: null, lastRefreshError: '' };
    if (raw.snapshot && typeof raw.snapshot === 'object') {
      return {
        snapshot: raw.snapshot,
        refreshedAt: firstFiniteNumber(raw.refreshedAt, raw.snapshot.updatedAt),
        lastRefreshError: text(raw.lastRefreshError, 60),
      };
    }
    if (raw.accounts && typeof raw.accounts === 'object') {
      var entry = pickAccountEntry(raw.accounts, member);
      if (!entry || entry === raw) return { snapshot: null, refreshedAt: null, lastRefreshError: '' };
      return resolveScoreEntry(entry, member);
    }
    if (Array.isArray(raw.modules)) {
      return {
        snapshot: raw,
        refreshedAt: firstFiniteNumber(raw.updatedAt),
        lastRefreshError: text(raw.lastRefreshError, 60),
      };
    }
    return {
      snapshot: null,
      refreshedAt: firstFiniteNumber(raw.refreshedAt),
      lastRefreshError: text(raw.lastRefreshError, 60),
    };
  }

  function pickAccountEntry(accounts, member) {
    var accountId = memberAccountId(member);
    if (accountId && accounts[accountId] && typeof accounts[accountId] === 'object') {
      return accounts[accountId];
    }
    var keys = Object.keys(accounts);
    if (keys.length === 0) return null;
    if (keys.length === 1) return accounts[keys[0]];
    // 多账号且无法确定：取最近刷新的一条（只用于展示，不冒充其他成员）
    var picked = null;
    var pickedAt = -1;
    for (var i = 0; i < keys.length; i += 1) {
      var candidate = accounts[keys[i]];
      if (!candidate || typeof candidate !== 'object') continue;
      var at = firstFiniteNumber(candidate.refreshedAt, candidate.snapshot && candidate.snapshot.updatedAt);
      if (at !== null && at > pickedAt) {
        picked = candidate;
        pickedAt = at;
      }
    }
    return picked;
  }

  /** 成员二课会话状态：只认 'ok' | 'expired' | 'none'，其余按 'none' 处理（不猜）。 */
  function normalizeEkStatus(member) {
    if (!member || typeof member !== 'object') return 'none';
    var raw = text(member.ekStatus).toLowerCase();
    return EK_STATUSES[raw] ? raw : 'none';
  }

  function ekStatusLabel(member) {
    var status = normalizeEkStatus(member);
    return EK_STATUS_LABELS[status] || EK_STATUS_LABELS.none;
  }

  /** 成员二课账号 id：引擎用 ek.user_info.loginName 作为 scores.accounts 的键。 */
  function memberAccountId(member) {
    if (!member || typeof member !== 'object') return '';
    var userInfo = member.ek && member.ek.user_info;
    if (userInfo && typeof userInfo === 'object') {
      var loginName = text(userInfo.loginName || userInfo.LoginName);
      if (loginName) return loginName;
      var userName = text(userInfo.userName || userInfo.UserName);
      if (userName) return userName;
    }
    return text(member.accountId || (member.ek && member.ek.accountId));
  }

  function collectModules(member, scoreEntry, nowMs, args) {
    var policy = loadScorePolicy();
    var snapshot = scoreEntry && scoreEntry.snapshot ? scoreEntry.snapshot : null;
    var snapshotModules = snapshot && Array.isArray(snapshot.modules) ? snapshot.modules : [];
    var memberModules = member && Array.isArray(member.ekModules) ? member.ekModules : [];
    var defs = policy && Array.isArray(policy.MODULES) && policy.MODULES.length
      ? policy.MODULES
      : deriveModuleDefs(memberModules, snapshotModules);

    var candidate = [];
    for (var i = 0; i < defs.length; i += 1) {
      var def = defs[i] || {};
      var name = text(def.name);
      if (!name) continue;
      var fromSnapshot = moduleByName(snapshotModules, name);
      var fromMember = moduleByName(memberModules, name);
      var snapshotCurrent = fromSnapshot ? finiteNumberOrNull(fromSnapshot.current) : null;
      var memberCurrent = fromMember ? finiteNumberOrNull(fromMember.current) : null;
      // 官方/引擎快照优先；缺失时回落到成员页手填值（绝不互相覆盖成 0）
      var current = snapshotCurrent !== null ? snapshotCurrent : memberCurrent;
      var required = firstValidRequired(
        fromSnapshot && fromSnapshot.required,
        fromMember && fromMember.required,
        def.required
      );
      var explicitlyUntrusted =
        (snapshotCurrent !== null && fromSnapshot && fromSnapshot.trusted === false) ||
        (snapshotCurrent === null && memberCurrent !== null && fromMember && fromMember.trusted === false);
      candidate.push({
        name: name,
        required: required,
        current: current,
        trusted: current !== null && explicitlyUntrusted !== true,
      });
    }

    var gaps = null;
    if (policy && typeof policy.computeGaps === 'function') {
      try {
        gaps = policy.computeGaps({ accountId: 'one-ct-stats', modules: candidate });
      } catch (e) {
        gaps = null;
      }
    }
    if (!gaps || !Array.isArray(gaps.modules)) gaps = computeGapsFallback(candidate);

    var modules = [];
    var satisfiedCount = 0;
    var unknownCount = 0;
    for (var j = 0; j < gaps.modules.length; j += 1) {
      var item = gaps.modules[j] || {};
      var moduleItem = {
        name: text(item.name),
        required: finiteNumberOrNull(item.required),
        current: finiteNumberOrNull(item.current),
        gap: finiteNumberOrNull(item.gap),
        satisfied: item.satisfied === true,
        trusted: item.trusted === true,
      };
      if (moduleItem.satisfied) satisfiedCount += 1;
      if (moduleItem.gap === null) unknownCount += 1;
      modules.push(moduleItem);
    }

    var totalGap = finiteNumberOrNull(gaps.totalGap);
    if (totalGap === null) totalGap = 0;
    var refreshedAt = firstFiniteNumber(scoreEntry && scoreEntry.refreshedAt, snapshot && snapshot.updatedAt);
    var staleMs = firstFiniteNumber(args && args.staleMs, policy && policy.DEFAULT_STALE_MS, DEFAULT_STALE_MS);
    if (staleMs === null || staleMs <= 0) staleMs = DEFAULT_STALE_MS;
    // 无刷新时间戳：有快照视为过期；纯手填（member.ekModules）不算过期
    var stale;
    if (refreshedAt === null) stale = snapshotModules.length > 0;
    else stale = nowMs - refreshedAt > staleMs;

    return {
      modules: modules,
      totalGap: round2(totalGap),
      trusted: gaps.trusted === true && modules.length > 0,
      stale: stale,
      refreshedAt: refreshedAt,
      satisfiedCount: satisfiedCount,
      unknownCount: unknownCount,
      staleMs: staleMs,
      hasSnapshot: snapshotModules.length > 0,
      hasMemberModules: memberModules.length > 0,
      snapshotSource: snapshot ? text(snapshot.source) : '',
    };
  }

  function firstValidRequired() {
    for (var i = 0; i < arguments.length; i += 1) {
      var number = validRequired(arguments[i]);
      if (number !== null) return number;
    }
    return null;
  }

  // ───────────────────────── build / buildAll ─────────────────────────

  /**
   * 可观测计数（与 OneCTMembers.resultsHealth() 同口径）：
   *  - eventsTotal：窗口内事件总数（所有模块，不只是 ek）
   *  - unscopedEventCount：窗口内无 memberId 的事件数 —— 这类事件进不了任何成员统计
   *  - orphanedEventCount：窗口内 memberId 指向已不在 members 里的事件数（需成员 id 集合）
   */
  function countAttribution(events, memberIds) {
    var total = 0;
    var unscoped = 0;
    var orphaned = 0;
    var hasIdSet = memberIds && typeof memberIds === 'object';
    for (var i = 0; i < events.length; i += 1) {
      var event = events[i];
      if (!event || typeof event !== 'object') continue;
      total += 1;
      var id = text(event.memberId);
      if (!id) {
        unscoped += 1;
        continue;
      }
      if (hasIdSet && memberIds[id] !== true) orphaned += 1;
    }
    return { eventsTotal: total, unscopedEventCount: unscoped, orphanedEventCount: orphaned };
  }

  function buildMemberIdSet(members) {
    var ids = {};
    if (!Array.isArray(members)) return ids;
    for (var i = 0; i < members.length; i += 1) {
      var member = members[i];
      if (!member || typeof member !== 'object') continue;
      var id = text(member.id);
      if (id) ids[id] = true;
    }
    return ids;
  }

  /**
   * 单成员统计。
   * @param {{member?:object, events?:Array|object, scoreEntry?:object,
   *          now?:number, clock?:{now:Function}, includeUnscoped?:boolean, staleMs?:number}} input
   *   now/clock/includeUnscoped/staleMs 为可选测试钩子；业务调用只需 member/events/scoreEntry。
   */
  function build(input) {
    var args = input && typeof input === 'object' ? input : {};
    var member = args.member && typeof args.member === 'object' ? args.member : {};
    var nowMs = resolveNow(args);
    var memberId = text(member.id || args.memberId, 120);
    var memberName = safeText(member.name || args.memberName, MAX_TEXT_LEN);
    var scoreEntry = resolveScoreEntry(args.scoreEntry, member);

    var allEvents = normalizeEventsInput(args.events);
    // 先按时间窗口裁剪（所有模块），再按成员归属过滤，最后只留 ek 可计数事件
    var recentAll = filterRecent(allEvents, nowMs, WINDOW_DAYS);
    var scoped = filterEventsForMember(recentAll, memberId, args.includeUnscoped === true);
    var events = [];
    for (var i = 0; i < scoped.length; i += 1) {
      if (isCountableEkEvent(scoped[i])) events.push(scoped[i]);
    }
    var attribution = countAttribution(recentAll, args.memberIdSet);

    var signIn = buildBucket(events, 'in');
    var signOut = buildBucket(events, 'out');
    var activities = buildActivities(events);
    var moduleInfo = collectModules(member, scoreEntry, nowMs, args);
    var ekStatus = normalizeEkStatus(member);
    var ekUpdatedAt = firstFiniteNumber(member.ekUpdatedAt);
    // 积分来源（official=从学校二课接口同步；manual=成员页手填）——脚注据此换文案
    var ekModulesSource =
      member && member.ekModulesSource === 'official' ? 'official' : 'manual';
    var ekModulesUpdatedAt = firstFiniteNumber(member && member.ekModulesUpdatedAt);

    return {
      memberId: memberId,
      memberName: memberName,
      ekStatus: ekStatus,
      ekUpdatedAt: ekUpdatedAt,
      ekModulesSource: moduleInfo.hasMemberModules ? ekModulesSource : null,
      ekModulesUpdatedAt: ekModulesUpdatedAt,
      signIn: signIn,
      signOut: signOut,
      activities: activities,
      modules: moduleInfo.modules,
      totalGap: moduleInfo.totalGap,
      trusted: moduleInfo.trusted,
      stale: moduleInfo.stale,
      refreshedAt: moduleInfo.refreshedAt,
      meta: {
        windowDays: WINDOW_DAYS,
        eventCount: events.length,
        activityCount: activities.length,
        satisfiedCount: moduleInfo.satisfiedCount,
        unknownModules: moduleInfo.unknownCount,
        staleMs: moduleInfo.staleMs,
        hasSnapshot: moduleInfo.hasSnapshot,
        hasMemberModules: moduleInfo.hasMemberModules,
        snapshotSource: moduleInfo.snapshotSource,
        ekStatus: ekStatus,
        refreshError: safeText(scoreEntry && scoreEntry.lastRefreshError, 60),
        // 归属可观测（与 OneCTMembers.resultsHealth() 同口径）：
        // 无 memberId 的事件不会进任何成员统计，UI 可据此提示「历史数据无归属」
        eventsTotal: attribution.eventsTotal,
        unscopedEventCount: attribution.unscopedEventCount,
      },
    };
  }

  /**
   * 多成员汇总。
   * @param {{members:Array, events?:Array|object, scoresByMember?:Object,
   *          now?:number, clock?:{now:Function}, staleMs?:number}} input
   * scoresByMember: { [memberId]: scoreEntry | 引擎原样 scores 存储 }。
   */
  function buildAll(input) {
    var args = input && typeof input === 'object' ? input : {};
    var members = Array.isArray(args.members) ? args.members : [];
    var events = normalizeEventsInput(args.events);
    var scoresByMember = args.scoresByMember && typeof args.scoresByMember === 'object' ? args.scoresByMember : {};
    var nowMs = resolveNow(args);
    var memberIdSet = buildMemberIdSet(members);

    var stats = [];
    for (var i = 0; i < members.length; i += 1) {
      var member = members[i];
      if (!member || typeof member !== 'object') continue;
      var memberId = text(member.id);
      var scoreEntry = Object.prototype.hasOwnProperty.call(scoresByMember, memberId)
        ? scoresByMember[memberId]
        : null;
      stats.push(
        build({
          member: member,
          events: events,
          scoreEntry: scoreEntry,
          now: nowMs,
          staleMs: args.staleMs,
          includeUnscoped: args.includeUnscoped === true,
          memberIdSet: memberIdSet,
        })
      );
    }

    // 归属可观测：以窗口内全部事件（所有模块）为基数，口径同 OneCTMembers.resultsHealth()
    var attribution = countAttribution(filterRecent(events, nowMs, WINDOW_DAYS), memberIdSet);

    var totals = {
      members: stats.length,
      signInSuccess: 0,
      signOutSuccess: 0,
      signInFailed: 0,
      signOutFailed: 0,
      signInWaiting: 0,
      signOutWaiting: 0,
      activityCount: 0,
      totalGap: 0,
      trustedMembers: 0,
      staleMembers: 0,
      ekExpiredMembers: 0,
      lastAt: null,
    };
    for (var j = 0; j < stats.length; j += 1) {
      var stat = stats[j];
      totals.signInSuccess += toCount(stat.signIn.success);
      totals.signOutSuccess += toCount(stat.signOut.success);
      totals.signInFailed += toCount(stat.signIn.failed);
      totals.signOutFailed += toCount(stat.signOut.failed);
      totals.signInWaiting += toCount(stat.signIn.waiting);
      totals.signOutWaiting += toCount(stat.signOut.waiting);
      totals.activityCount += stat.activities.length;
      totals.totalGap += finiteNumberOrNull(stat.totalGap) || 0;
      if (stat.trusted) totals.trustedMembers += 1;
      if (stat.stale) totals.staleMembers += 1;
      if (stat.ekStatus === 'expired') totals.ekExpiredMembers += 1;
      [stat.signIn.lastAt, stat.signOut.lastAt].forEach(function (at) {
        var value = finiteNumberOrNull(at);
        if (value !== null && value > 0 && (totals.lastAt === null || value > totals.lastAt)) totals.lastAt = value;
      });
    }
    totals.totalGap = round2(totals.totalGap);
    // 归属可观测字段：无归属事件进不了任何成员统计；孤儿事件指向已删除成员
    totals.eventsTotal = attribution.eventsTotal;
    totals.unscopedEventCount = attribution.unscopedEventCount;
    totals.orphanedEventCount = attribution.orphanedEventCount;

    return { members: stats, totals: totals };
  }

  // ───────────────────────── 原生 DOM 渲染 ─────────────────────────

  function h(doc, tagName, className, value) {
    var node = doc.createElement(tagName);
    if (className) node.className = className;
    if (value !== undefined && value !== null) node.textContent = String(value);
    return node;
  }

  function clearContainer(el) {
    if (typeof el.replaceChildren === 'function') {
      el.replaceChildren();
      return;
    }
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  function buildTitleText(stat) {
    var memberName = safeText(stat && stat.memberName, MAX_TEXT_LEN);
    return memberName ? memberName + ' · 二课统计' : '二课统计';
  }

  function buildStatCard(doc, label, kind, bucket) {
    var card = h(doc, 'div', 'one-ct-stats-card');
    card.setAttribute('data-one-ct', 'card-' + kind);
    card.appendChild(h(doc, 'div', 'one-ct-stats-card-label', label));

    var success = toCount(bucket.success);
    var valueClass = 'one-ct-stats-card-value' + (success > 0 ? ' one-ct-stats-ok' : '');
    var value = h(doc, 'div', valueClass, formatNumber(success));
    value.setAttribute('data-one-ct', 'stat-' + kind + '-success');
    card.appendChild(value);

    var metaParts = [];
    if (toCount(bucket.total) === 0) {
      metaParts.push('最近 ' + WINDOW_DAYS + ' 天暂无记录');
    } else {
      metaParts.push('失败 ' + toCount(bucket.failed));
      metaParts.push('等待 ' + toCount(bucket.waiting));
      if (toCount(bucket.blocked) > 0) metaParts.push('拦截 ' + toCount(bucket.blocked));
      if (bucket.lastAt) metaParts.push('最近 ' + formatShortAt(bucket.lastAt));
    }
    card.appendChild(h(doc, 'div', 'one-ct-stats-card-meta', metaParts.join(' · ')));
    return card;
  }

  function totalGapText(stat, modules) {
    if (!modules.length) return '缺口未知';
    var unknown = 0;
    for (var i = 0; i < modules.length; i += 1) {
      if (finiteNumberOrNull(modules[i].gap) === null) unknown += 1;
    }
    if (unknown === modules.length) return '缺口未知';
    var totalGap = finiteNumberOrNull(stat.totalGap);
    if (totalGap === null) totalGap = 0;
    if (unknown === 0 && totalGap === 0) return '已全部达标';
    var textValue = '缺口合计 ' + formatNumber(totalGap) + ' 分';
    if (unknown > 0) textValue += ' · ' + unknown + ' 项未填';
    return textValue;
  }

  function totalGapClass(stat, modules) {
    var unknown = 0;
    for (var i = 0; i < modules.length; i += 1) {
      if (finiteNumberOrNull(modules[i].gap) === null) unknown += 1;
    }
    var base = 'one-ct-stats-total-gap';
    if (!modules.length || unknown === modules.length) return base + ' one-ct-stats-muted';
    var totalGap = finiteNumberOrNull(stat.totalGap);
    if (unknown === 0 && (totalGap === null || totalGap === 0)) return base + ' one-ct-stats-ok';
    return base;
  }

  function moduleScoreText(moduleData) {
    var parts = scoreParts(moduleData);
    var value = parts.current + ' / ' + parts.required;
    if (parts.hasCurrent && parts.trusted === false) return value + ' · 未确认';
    return value;
  }

  function buildModuleRow(doc, moduleData) {
    var name = safeText(moduleData && moduleData.name, MAX_TEXT_LEN) || '未知模块';
    var required = finiteNumberOrNull(moduleData && moduleData.required);
    var current = finiteNumberOrNull(moduleData && moduleData.current);
    var gap = finiteNumberOrNull(moduleData && moduleData.gap);
    var trusted = moduleData && moduleData.trusted !== false;
    var satisfied = moduleData && moduleData.satisfied === true;

    var row = h(doc, 'div', 'one-ct-stats-module');
    row.setAttribute('data-one-ct', 'module');

    var top = h(doc, 'div', 'one-ct-stats-module-top');
    top.appendChild(h(doc, 'span', 'one-ct-stats-module-name', name));
    top.appendChild(h(doc, 'span', 'one-ct-stats-module-score', moduleScoreText(moduleData)));
    row.appendChild(top);

    var bar = h(doc, 'div', 'one-ct-stats-bar');
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-label', name + ' 完成进度');
    var percent = 0;
    if (required !== null && required > 0) {
      bar.setAttribute('aria-valuemin', '0');
      bar.setAttribute('aria-valuemax', formatNumber(required));
      if (current !== null && trusted) {
        percent = Math.max(0, Math.min(100, Math.round((current / required) * 1000) / 10));
      }
    }
    var fillClass = 'one-ct-stats-bar-fill';
    if (current === null || !trusted) fillClass += ' one-ct-stats-bar-fill-muted';
    else if (satisfied) fillClass += ' one-ct-stats-bar-fill-ok';
    var fill = h(doc, 'div', fillClass);
    fill.setAttribute('style', 'width:' + percent + '%');
    if (current !== null && trusted) fill.setAttribute('aria-valuenow', formatNumber(current));
    bar.appendChild(fill);
    row.appendChild(bar);

    var foot = h(doc, 'div', 'one-ct-stats-module-foot');
    var gapClass = 'one-ct-stats-module-gap';
    var gapTextValue;
    if (current === null) {
      gapClass += ' one-ct-stats-muted';
      gapTextValue = '未填';
    } else if (!trusted) {
      gapClass += ' one-ct-stats-muted';
      gapTextValue = '数据未确认';
    } else if (satisfied) {
      gapClass += ' one-ct-stats-ok';
      gapTextValue = '已达标';
    } else if (gap !== null) {
      gapTextValue = '差 ' + formatNumber(gap) + ' 分';
    } else {
      gapClass += ' one-ct-stats-muted';
      gapTextValue = '—';
    }
    foot.appendChild(h(doc, 'span', gapClass, gapTextValue));
    row.appendChild(foot);
    return row;
  }

  function badgeClass(status) {
    var normalized = normalizeStatus(status);
    if (normalized === 'success') return 'one-ct-stats-badge one-ct-stats-badge-ok';
    if (normalized === 'failed' || normalized === 'blocked') return 'one-ct-stats-badge one-ct-stats-badge-err';
    if (WAITING_STATUSES[normalized]) return 'one-ct-stats-badge one-ct-stats-badge-warn';
    if (!normalized) return 'one-ct-stats-badge one-ct-stats-badge-muted';
    return 'one-ct-stats-badge one-ct-stats-badge-muted';
  }

  function badgeText(status) {
    var label = statusLabel(status);
    return label || '—';
  }

  function buildActivityRow(doc, activity) {
    var row = h(doc, 'tr', 'one-ct-stats-activity-row');
    row.setAttribute('data-one-ct', 'activity-row');

    var nameCell = h(doc, 'td', 'one-ct-stats-cell');
    var nameSpan = h(doc, 'span', 'one-ct-stats-activity-name', safeText(activity.name, MAX_TEXT_LEN) || '（未命名活动）');
    nameSpan.setAttribute('data-one-ct', 'activity-name');
    nameCell.appendChild(nameSpan);
    row.appendChild(nameCell);

    row.appendChild(
      h(doc, 'td', 'one-ct-stats-cell one-ct-stats-cell-muted', safeText(activity.category, MAX_TEXT_LEN) || '—')
    );

    var inCell = h(doc, 'td', 'one-ct-stats-cell');
    var inBadge = h(doc, 'span', badgeClass(activity.signInStatus), badgeText(activity.signInStatus));
    inBadge.setAttribute('data-one-ct', 'activity-signin');
    inCell.appendChild(inBadge);
    row.appendChild(inCell);

    var outCell = h(doc, 'td', 'one-ct-stats-cell');
    var outBadge = h(doc, 'span', badgeClass(activity.signOutStatus), badgeText(activity.signOutStatus));
    outBadge.setAttribute('data-one-ct', 'activity-signout');
    outCell.appendChild(outBadge);
    row.appendChild(outCell);

    row.appendChild(
      h(doc, 'td', 'one-ct-stats-cell one-ct-stats-cell-time', formatAt(activity.lastAt) || '—')
    );
    return row;
  }

  /**
   * 渲染统计区块（纯 DOM，极简白；样式全部由 ek-stats.css 的 .one-ct-stats-* 类负责）。
   * @param {Element} el 容器
   * @param {object} stat build() 的返回值
   * @param {{title?:string, maxActivities?:number, showModules?:boolean,
   *          showActivities?:boolean, showFoot?:boolean}} [opts]
   */
  function renderInto(el, stat, opts) {
    if (!el || typeof el.appendChild !== 'function') {
      throw new TypeError('renderInto(el, stat)：el 必须是可 appendChild 的容器元素');
    }
    var options = opts && typeof opts === 'object' ? opts : {};
    var doc = el.ownerDocument || (typeof document !== 'undefined' ? document : null);
    if (!doc || typeof doc.createElement !== 'function') {
      throw new Error('renderInto(el, stat)：缺少 DOM 环境（document.createElement 不可用）');
    }

    var data = stat && typeof stat === 'object' ? stat : {};
    var modules = Array.isArray(data.modules) ? data.modules : [];
    var activities = Array.isArray(data.activities) ? data.activities : [];
    var signIn = data.signIn && typeof data.signIn === 'object' ? data.signIn : emptyBucket();
    var signOut = data.signOut && typeof data.signOut === 'object' ? data.signOut : emptyBucket();
    var meta = data.meta && typeof data.meta === 'object' ? data.meta : {};

    clearContainer(el);
    var rootEl = h(doc, 'div', 'one-ct-stats-root');
    rootEl.setAttribute('data-one-ct', 'stats');
    el.appendChild(rootEl);

    // ── 归属异常提示：无归属 / 孤儿事件不进统计，必须让用户看得见 ──
    var unscopedCount = toCount(meta.unscopedEventCount);
    var orphanedCount = toCount(meta.orphanedEventCount);
    if (unscopedCount > 0 || orphanedCount > 0) {
      var noticeParts = [];
      if (unscopedCount > 0) noticeParts.push(unscopedCount + ' 条历史事件无成员归属，未计入任何成员');
      if (orphanedCount > 0) noticeParts.push(orphanedCount + ' 条事件属于已删除成员');
      var notice = h(doc, 'div', 'one-ct-stats-notice', noticeParts.join('；'));
      notice.setAttribute('data-one-ct', 'attribution-notice');
      rootEl.appendChild(notice);
    }

    // ── 头部：成员名 + 会话状态 + 窗口/刷新/可信度 ──
    var head = h(doc, 'div', 'one-ct-stats-head');
    var titleRow = h(doc, 'div', 'one-ct-stats-title-row');
    titleRow.appendChild(
      h(doc, 'div', 'one-ct-stats-title', options.title ? safeText(options.title, MAX_TEXT_LEN) : buildTitleText(data))
    );
    var ekStatus = EK_STATUSES[data.ekStatus] ? data.ekStatus : 'none';
    var ekBadge = h(
      doc,
      'span',
      'one-ct-stats-session one-ct-stats-session-' + ekStatus,
      EK_STATUS_LABELS[ekStatus]
    );
    ekBadge.setAttribute('data-one-ct', 'ek-status');
    ekBadge.setAttribute('data-ek-status', ekStatus);
    titleRow.appendChild(ekBadge);
    head.appendChild(titleRow);

    var metaParts = ['最近 ' + WINDOW_DAYS + ' 天'];
    if (data.ekUpdatedAt) metaParts.push('会话更新于 ' + formatAt(data.ekUpdatedAt));
    if (data.refreshedAt) {
      metaParts.push('积分刷新于 ' + formatAt(data.refreshedAt));
    } else if (meta.hasMemberModules) {
      metaParts.push('积分来自成员页填写');
    } else {
      metaParts.push('积分未配置');
    }
    if (data.trusted === false) metaParts.push('缺口不完整');
    if (data.stale === true) metaParts.push('积分数据可能过期');
    if (meta.refreshError) metaParts.push('刷新失败：' + safeText(meta.refreshError, 60));
    head.appendChild(h(doc, 'div', 'one-ct-stats-meta', metaParts.join(' · ')));
    rootEl.appendChild(head);

    // ── 两张统计卡：签到成功 / 签退成功 ──
    var cards = h(doc, 'div', 'one-ct-stats-cards');
    cards.setAttribute('data-one-ct', 'cards');
    cards.appendChild(buildStatCard(doc, '签到成功', 'signIn', signIn));
    cards.appendChild(buildStatCard(doc, '签退成功', 'signOut', signOut));
    rootEl.appendChild(cards);

    // ── 八模块进度 ──
    if (options.showModules !== false) {
      var moduleSection = h(doc, 'section', 'one-ct-stats-section');
      moduleSection.setAttribute('data-one-ct', 'modules');
      var moduleHead = h(doc, 'div', 'one-ct-stats-section-head');
      moduleHead.appendChild(h(doc, 'span', 'one-ct-stats-section-title', '八模块进度'));
      moduleHead.appendChild(h(doc, 'span', totalGapClass(data, modules), totalGapText(data, modules)));
      moduleSection.appendChild(moduleHead);

      var moduleList = h(doc, 'div', 'one-ct-stats-modules');
      if (modules.length === 0) {
        moduleList.appendChild(
          h(doc, 'div', 'one-ct-stats-empty', '未配置八模块（在成员页填写，或刷新官方成绩）')
        );
      } else {
        for (var i = 0; i < modules.length; i += 1) {
          moduleList.appendChild(buildModuleRow(doc, modules[i]));
        }
      }
      moduleSection.appendChild(moduleList);
      rootEl.appendChild(moduleSection);
    }

    // ── 最近活动表 ──
    if (options.showActivities !== false) {
      var activitySection = h(doc, 'section', 'one-ct-stats-section');
      activitySection.setAttribute('data-one-ct', 'activities');
      var activityHead = h(doc, 'div', 'one-ct-stats-section-head');
      activityHead.appendChild(h(doc, 'span', 'one-ct-stats-section-title', '最近活动'));
      var maxActivities =
        options.maxActivities === undefined ? DEFAULT_MAX_ACTIVITIES : toCount(options.maxActivities);
      var shown = maxActivities > 0 ? activities.slice(0, maxActivities) : activities.slice();
      activityHead.appendChild(
        h(
          doc,
          'span',
          'one-ct-stats-count',
          activities.length === 0
            ? '最近 ' + WINDOW_DAYS + ' 天无记录'
            : '共 ' + activities.length + ' 条 · 显示 ' + shown.length + ' 条'
        )
      );
      activitySection.appendChild(activityHead);

      var wrap = h(doc, 'div', 'one-ct-stats-table-wrap');
      var table = h(doc, 'table', 'one-ct-stats-table');
      table.setAttribute('data-one-ct', 'activity-table');
      var thead = h(doc, 'thead', 'one-ct-stats-thead');
      var headRow = h(doc, 'tr', 'one-ct-stats-row');
      var columns = ['活动', '类别', '签到', '签退', '时间'];
      for (var c = 0; c < columns.length; c += 1) {
        headRow.appendChild(h(doc, 'th', 'one-ct-stats-th', columns[c]));
      }
      thead.appendChild(headRow);
      table.appendChild(thead);

      var tbody = h(doc, 'tbody', 'one-ct-stats-tbody');
      if (shown.length === 0) {
        var emptyRow = h(doc, 'tr', 'one-ct-stats-activity-row');
        var emptyCell = h(doc, 'td', 'one-ct-stats-empty', '最近 ' + WINDOW_DAYS + ' 天没有二课签到/签退记录');
        emptyCell.setAttribute('colspan', '5');
        emptyRow.appendChild(emptyCell);
        tbody.appendChild(emptyRow);
      } else {
        for (var a = 0; a < shown.length; a += 1) {
          tbody.appendChild(buildActivityRow(doc, shown[a]));
        }
      }
      table.appendChild(tbody);
      wrap.appendChild(table);
      activitySection.appendChild(wrap);
      rootEl.appendChild(activitySection);
    }

    // ── 脚注：数据来源（不含任何凭证） ──
    if (options.showFoot !== false) {
      var sourceText;
      // official = 从学校二课接口同步（member.ekModulesSource === 'official'）；不再称"手动填写"
      var officialModules = Boolean(stat && stat.ekModulesSource === 'official');
      if (meta.hasSnapshot)
        sourceText = officialModules
          ? '积分来源：二课官方同步（已刷新快照）'
          : '积分来源：官方成绩快照';
      else if (meta.hasMemberModules)
        sourceText = officialModules
          ? '积分来源：二课官方同步'
          : '积分来源：成员页手动填写';
      else sourceText = '积分来源：未配置';
      var foot = h(
        doc,
        'div',
        'one-ct-stats-foot',
        '统计口径：module=ek，状态 success 才算签到/签退成功；' + sourceText + '；不含任何账号凭证'
      );
      foot.setAttribute('data-one-ct', 'foot');
      rootEl.appendChild(foot);
    }

    return el;
  }

  // ───────────────────────── CSV 导出 ─────────────────────────

  /** CSV 文本单元格：掩码手机号 + 公式注入防护 + RFC4180 转义。 */
  function csvCell(value) {
    var str = maskPhones(text(value, MAX_TEXT_LEN));
    if (/^[=+\-@\t\r]/.test(str)) str = "'" + str;
    if (/[",\r\n]/.test(str)) str = '"' + str.replace(/"/g, '""') + '"';
    return str;
  }

  function csvNumber(value) {
    var number = finiteNumberOrNull(value);
    return number === null ? '' : formatNumber(number);
  }

  function csvStatus(status) {
    var label = statusLabel(status);
    return label ? csvCell(label) : '';
  }

  function statList(stats) {
    if (Array.isArray(stats)) return stats.filter((item) => item && typeof item === 'object');
    if (stats && typeof stats === 'object') {
      if (Array.isArray(stats.members)) return stats.members;
      if (Array.isArray(stats.modules) || Array.isArray(stats.activities) || stats.memberId !== undefined) {
        return [stats];
      }
    }
    return [];
  }

  /**
   * 导出 CSV（两段表：模块缺口 + 活动明细）。
   * 默认带 UTF-8 BOM（Excel 直接打开中文不乱码），opts.bom === false 可去掉；
   * 行尾 CRLF；缺省值（current/gap 为 null）导出为空单元格，绝不写成 0。
   * @param {object} stats build() 结果或 buildAll() 结果
   * @param {{bom?:boolean}} [opts]
   */
  function toCSV(stats, opts) {
    var options = opts && typeof opts === 'object' ? opts : {};
    var list = statList(stats);
    var blocks = [];

    var moduleRows = [['成员', '模块', '要求', '当前', '缺口']];
    for (var i = 0; i < list.length; i += 1) {
      var stat = list[i] || {};
      var memberName = csvCell(safeText(stat.memberName, MAX_TEXT_LEN) || '（未命名成员）');
      var modules = Array.isArray(stat.modules) ? stat.modules : [];
      for (var m = 0; m < modules.length; m += 1) {
        var moduleData = modules[m] || {};
        moduleRows.push([
          memberName,
          csvCell(safeText(moduleData.name, MAX_TEXT_LEN)),
          csvNumber(moduleData.required),
          csvNumber(moduleData.current),
          csvNumber(moduleData.gap),
        ]);
      }
    }
    blocks.push(moduleRows);

    var activityRows = [['成员', '活动ID', '活动', '类别', '签到', '签退', '最近时间']];
    for (var j = 0; j < list.length; j += 1) {
      var item = list[j] || {};
      var activityMember = csvCell(safeText(item.memberName, MAX_TEXT_LEN) || '（未命名成员）');
      var activities = Array.isArray(item.activities) ? item.activities : [];
      for (var a = 0; a < activities.length; a += 1) {
        var activity = activities[a] || {};
        activityRows.push([
          activityMember,
          csvCell(safeText(activity.activityId, MAX_TEXT_LEN)),
          csvCell(safeText(activity.name, MAX_TEXT_LEN)),
          csvCell(safeText(activity.category, MAX_TEXT_LEN)),
          csvStatus(activity.signInStatus),
          csvStatus(activity.signOutStatus),
          csvCell(formatAt(activity.lastAt)),
        ]);
      }
    }
    blocks.push(activityRows);

    var lines = [];
    for (var b = 0; b < blocks.length; b += 1) {
      if (b > 0) lines.push('');
      for (var r = 0; r < blocks[b].length; r += 1) {
        lines.push(blocks[b][r].join(','));
      }
    }
    var body = lines.join('\r\n') + '\r\n';
    return (options.bom === false ? '' : '\uFEFF') + body;
  }

  return {
    VERSION: VERSION,
    WINDOW_DAYS: WINDOW_DAYS,
    DEFAULT_STALE_MS: DEFAULT_STALE_MS,
    DEFAULT_MAX_ACTIVITIES: DEFAULT_MAX_ACTIVITIES,
    build: build,
    buildAll: buildAll,
    renderInto: renderInto,
    toCSV: toCSV,
    // 供 UI / 测试复用的只读工具（不参与契约字段）
    getModules: getModules,
    beijingDay: beijingDay,
    formatAt: formatAt,
    statusLabel: statusLabel,
    ekStatusLabel: ekStatusLabel,
    maskPhones: maskPhones,
  };
});
