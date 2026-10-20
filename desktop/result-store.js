/**
 * Auto3CTResults —— 纯本地「自动化执行结果」历史仓库（UMD，零依赖）。
 *
 * 设计目标（与 lead / QA 冻结口径一致）：
 *  - 只记录真实提交定论（dry-run/preview 轮次不落库，绝不算成功）；
 *  - 成功 = 上游已接受 action（status === 'success'）；提交成功 ≠ 官方入账，本仓库不计算分数；
 *  - 同 key upsert：重复成功不覆盖，更丰富的 activityName/distance/stage 会合并保留；
 *    已 done 的 success 不会被 skipped/legacy 覆盖；每 tick 重复写同 key 不会刷爆；
 *  - 有界：最多 2000 条、至少保留最近 90 天；统计只按保留窗口内数据；
 *  - 不存 payload / token / 密码 / cookie / 完整手机号；手机号账号自动掩码；
 *  - 账号隔离：事件带 accountId（ek 与 tanma 历史分开筛选，不会混成空）；
 *  - 旧 scheduler state.done 可最小迁移为 legacy 事件：只显示“历史动作（无详情）”，
 *    不伪造 activityName/距离，也不把签到/签退合并算成“活动完成”；
 *  - 存储损坏不崩溃：返回空历史并标记 corrupt，之后写入自愈。
 *
 * 用法：
 *   Node:    const R = require('./result-store.js'); const store = R.createStore({storage, clock});
 *   Browser: <script src="result-store.js"></script> → window.Auto3CTResults
 *            （同时提供 window.Auto3CTResultStore 别名，兼容旧命名）
 */
(function (root, factory) {
  'use strict';
  var mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  if (root) {
    root.Auto3CTResults = mod;
    root.Auto3CTResultStore = mod; // 兼容别名：同一对象
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var KEY = 'auto3ct:results';
  var VERSION = 1;
  var MAX_EVENTS = 2000;
  // 保留窗口：最多 90 天且最多 2000 条（先到者即淘汰，不保证至少 90 天）
  var RETAIN_DAYS = 90;
  var DAY_MS = 24 * 60 * 60 * 1000;
  var BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
  var PHONE_RE = /^1\d{10}$/;
  var MAX_NAME_LEN = 200;
  var MAX_REASON_LEN = 300;

  var STATUSES = {
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

  // 允许持久化的字段（白名单；payload/token/密码/手机号等一律丢弃）
  var ALLOWED_FIELDS = [
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
  ];

  function text(value, maxLen) {
    if (value === null || value === undefined) return '';
    var str = String(value).trim();
    if (maxLen && str.length > maxLen) str = str.slice(0, maxLen);
    return str;
  }

  function finiteNumberOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    var number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function maskPhone(phone) {
    return phone.replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2');
  }

  function maskAccount(accountId) {
    var id = text(accountId);
    if (!id) return '';
    if (PHONE_RE.test(id)) return maskPhone(id);
    if (id.length <= 4) return id.charAt(0) + '***';
    return id.slice(0, 2) + '***' + id.slice(-2);
  }

  /** 北京时区的日期字符串 YYYY-MM-DD。 */
  function beijingDay(atMs) {
    var value = Number(atMs);
    if (!Number.isFinite(value)) value = 0;
    return new Date(value + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
  }

  /** 过滤参数里的日期/毫秒统一转成北京日字符串。 */
  function toDay(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number' && Number.isFinite(value)) return beijingDay(value);
    var str = String(value).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.slice(0, 10);
    var parsed = Date.parse(str);
    return Number.isFinite(parsed) ? beijingDay(parsed) : null;
  }

  function normalizeStatus(raw) {
    var status = text(raw).toLowerCase().replace(/_/g, '-');
    if (status === 'dry-run' || status === 'preview') return null; // 预览绝不入库
    if (status === 'already-done') return 'skipped';
    if (!status) return 'unknown';
    return STATUSES[status] ? status : status;
  }

  /** 固定 reason code 白名单：不接受任意 raw 异常/secret 文本。 */
  var REASON_CODE_RE = /^[a-z][a-z0-9-]{0,63}$/;

  function sanitizeReason(raw) {
    var reason = text(raw, MAX_REASON_LEN);
    if (!reason) return '';
    // 只保留固定 code；含空格/路径/等号/引号/中文堆叠等一律视为不可信文本
    if (REASON_CODE_RE.test(reason)) return reason;
    return 'suppressed-untrusted-reason';
  }

  /** 对可能含手机号/敏感串的 key 做脱敏（保留可读前缀 + 短哈希，避免冲突也不落完整号）。 */
  function sanitizeKey(rawKey) {
    var key = text(rawKey, 240);
    if (!key) return '';
    key = key.replace(/1\d{10}/g, function (phone) {
      return hashedToken(phone);
    });
    if (/token|password|passwd|cookie|secret/i.test(key)) {
      key = key.replace(/(token|password|passwd|cookie|secret)[^|:;\s]*/gi, function (matched) {
        return matched.split(/[=:]/)[0] + '=redacted';
      });
    }
    return key;
  }

  function hashedToken(value) {
    var hash = 2166136261;
    var str = text(value);
    for (var i = 0; i < str.length; i += 1) {
      hash ^= str.charCodeAt(i);
      hash = (hash * 16777619) >>> 0;
    }
    return 'h' + hash.toString(36);
  }

  /** 账号身份：opaque id 保持不变；手机号必须 hash，避免用 mask 当过滤键。 */
  function normalizeAccountId(raw) {
    var id = text(raw);
    if (!id) return '';
    if (PHONE_RE.test(id)) return 'phone-' + hashedToken(id);
    return id;
  }

  /**
   * 把任意输入事件规范化为可持久化结构；返回 null 表示拒绝。
   * 拒绝：preview/dryRun、缺少 key、非法对象。
   */
  function normalizeEvent(raw, defaults) {
    if (!raw || typeof raw !== 'object') return null;
    var base = defaults || {};
    if (raw.preview === true || raw.dryRun === true) return null;
    if (base.preview === true || base.dryRun === true) return null;

    var rawStatus = text(raw.status).toLowerCase().replace(/_/g, '-');
    if (rawStatus === 'dry-run' || rawStatus === 'dry_run' || rawStatus === 'preview') return null;

    var key = sanitizeKey(raw.key || raw.dedupeKey || base.key);
    if (!key) {
      // engine onResult 若暂时没带 key：用稳定身份合成（同日/账号/模块/动作/活动），
      // 仍满足幂等 upsert，不会每 tick 刷爆；含手机号的账号会被规范化脱敏。
      var synthAccount = normalizeAccountId(raw.accountId || base.accountId);
      var synthModule = text(raw.module || base.module).toLowerCase();
      var synthAction = text(raw.action || base.action);
      if (synthAccount && synthModule && synthAction) {
        var synthAt = finiteNumberOrNull(raw.at);
        var synthDay = beijingDay(synthAt === null ? 0 : synthAt);
        var synthActivity = text(raw.activityId || raw.activityName);
        key = sanitizeKey(
          ['auto', synthDay, synthAccount, synthModule, synthAction, synthActivity].join('|'),
        );
      }
    }
    if (!key) return null;

    var at = finiteNumberOrNull(raw.at);
    if (at === null) at = finiteNumberOrNull(base.at);
    if (at === null) at = finiteNumberOrNull(base.now);

    var accountRaw = text(raw.accountId || base.accountId);
    var accountId = normalizeAccountId(accountRaw);

    var statusValue = normalizeStatus(raw.status);
    if (statusValue === null) return null;
    var event = {
      key: key,
      at: at === null ? 0 : at,
      day: text(raw.day) && /^\d{4}-\d{2}-\d{2}$/.test(text(raw.day)) ? text(raw.day).slice(0, 10) : null,
      accountId: accountId,
      accountMask: text(raw.accountMask) || maskAccount(accountRaw),
      module: text(raw.module || base.module || 'unknown').toLowerCase(),
      action: text(raw.action || base.action || 'unknown'),
      activityId: text(raw.activityId),
      activityName: text(raw.activityName, MAX_NAME_LEN),
      category: text(raw.category),
      status: statusValue,
      reason: sanitizeReason(raw.reason),
      stage: text(raw.stage),
      distanceMeters: finiteNumberOrNull(raw.distanceMeters),
      attempt: finiteNumberOrNull(raw.attempt),
      preview: false,
      dryRun: false,
      legacy: raw.legacy === true,
      source: text(raw.source) || (raw.legacy === true ? 'legacy' : 'auto'),
    };
    if (!event.day) event.day = beijingDay(event.at);
    if (event.attempt !== null) event.attempt = Math.max(0, Math.round(event.attempt));
    if (event.distanceMeters !== null && event.distanceMeters < 0) event.distanceMeters = null;
    if (event.legacy) {
      // 旧记录只保留动作身份，不伪造明细
      event.activityName = '';
      event.distanceMeters = null;
      event.stage = '';
    }
    return sanitize(event);
  }

  /** 白名单裁剪：只保留允许字段。 */
  function sanitize(event) {
    var out = {};
    for (var i = 0; i < ALLOWED_FIELDS.length; i += 1) {
      var field = ALLOWED_FIELDS[i];
      if (event[field] !== undefined && event[field] !== null && event[field] !== '') {
        out[field] = event[field];
      }
    }
    // preview/dryRun 固定 false，保留字段以便 UI 显式判断
    out.preview = false;
    out.dryRun = false;
    if (!out.day) out.day = beijingDay(out.at);
    return out;
  }

  /** 合并 upsert：保留已有信息，新信息更丰富时覆盖；success 不被 skipped/legacy 降级。 */
  function mergeEvent(existing, incoming) {
    var merged = {};
    var i;
    for (i = 0; i < ALLOWED_FIELDS.length; i += 1) {
      var field = ALLOWED_FIELDS[i];
      if (existing[field] !== undefined) merged[field] = existing[field];
    }
    var existingSuccess = existing.status === 'success';
    var incomingSuccess = incoming.status === 'success';
    if (existingSuccess && !incomingSuccess) {
      // 已成功，但本次是 skipped/failed/waiting 等：只保留首次成功事实，任何字段都不改写
      merged.status = 'success';
      return sanitize(merged);
    }
    if (existingSuccess) {
      // 已成功：首次 success 的真实时间/日期/reason 必须稳定，
      // 后续 skipped/failed/重复 success 只能补缺更丰富字段，不得改写历史。
      merged.status = 'success';
      if ((merged.activityName === undefined || merged.activityName === '') && incoming.activityName) {
        merged.activityName = incoming.activityName;
      }
      if ((merged.activityId === undefined || merged.activityId === '') && incoming.activityId) {
        merged.activityId = incoming.activityId;
      }
      if ((merged.category === undefined || merged.category === '') && incoming.category) {
        merged.category = incoming.category;
      }
      if (merged.distanceMeters === undefined && incoming.distanceMeters !== null && incoming.distanceMeters !== undefined) {
        merged.distanceMeters = incoming.distanceMeters;
      }
      if ((merged.stage === undefined || merged.stage === '') && incoming.stage) {
        merged.stage = incoming.stage;
      }
      if (incoming.legacy) merged.legacy = false;
      return sanitize(merged);
    }
    for (i = 0; i < ALLOWED_FIELDS.length; i += 1) {
      var name = ALLOWED_FIELDS[i];
      var next = incoming[name];
      if (next === undefined || next === null || next === '') continue;
      var prev = merged[name];
      if (prev === undefined || prev === null || prev === '') {
        merged[name] = next;
        continue;
      }
      if (name === 'at') {
        merged.at = Math.max(Number(prev) || 0, Number(next) || 0);
      } else if (name === 'distanceMeters' || name === 'attempt') {
        merged[name] = next;
      } else if (name === 'status') {
        merged.status = existingSuccess ? 'success' : next;
      } else if (name === 'activityName' || name === 'stage' || name === 'reason') {
        merged[name] = next; // 更新更丰富/更新鲜的信息
      } else if (name === 'legacy') {
        merged.legacy = Boolean(prev) && Boolean(next);
      } else {
        merged[name] = prev; // 其余保持首次值（例如 day/currency）
      }
    }
    if (incoming.status === 'success') merged.status = 'success';
    return sanitize(merged);
  }

  function dedupeKeyOf(raw, index) {
    var key = text(raw && (raw.key || raw.dedupeKey));
    return key || 'anon-' + index;
  }

  function createStore(options) {
    var opts = options || {};
    var storage = opts.storage;
    if (!storage || typeof storage.get !== 'function' || typeof storage.set !== 'function') {
      throw new Error('createStore 需要 storage {get,set,remove}');
    }
    var clock = opts.clock || { now: function () { return Date.now(); } };
    var maxEvents = Number(opts.maxEvents) > 0 ? Math.floor(Number(opts.maxEvents)) : MAX_EVENTS;
    var retainDays = Number(opts.retainDays) >= 90 ? Math.floor(Number(opts.retainDays)) : RETAIN_DAYS;
    var corrupt = false;
    var lastPersistError = '';

    function now() {
      var value = Number(clock.now());
      return Number.isFinite(value) ? value : Date.now();
    }

    function load() {
      var raw;
      try {
        raw = storage.get(KEY);
      } catch (e) {
        corrupt = true;
        return { version: VERSION, events: [] };
      }
      if (raw === null || raw === undefined || raw === '') {
        return { version: VERSION, events: [] };
      }
      var parsed;
      try {
        parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch (e) {
        corrupt = true;
        return { version: VERSION, events: [] };
      }
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.events)) {
        corrupt = true;
        return { version: VERSION, events: [] };
      }
      corrupt = false;
      var events = [];
      for (var i = 0; i < parsed.events.length; i += 1) {
        var item = parsed.events[i];
        if (item && typeof item === 'object' && typeof item.key === 'string') {
          events.push(sanitize(item));
        }
      }
      return { version: VERSION, events: events };
    }

    function prune(events) {
      var cutoff = beijingDay(now() - retainDays * DAY_MS);
      var kept = [];
      for (var i = 0; i < events.length; i += 1) {
        var item = events[i];
        var day = item.day || beijingDay(item.at);
        if (day >= cutoff) kept.push(item);
      }
      kept.sort(function (a, b) {
        if (b.at !== a.at) return b.at - a.at;
        return b.key < a.key ? -1 : b.key > a.key ? 1 : 0;
      });
      if (kept.length > maxEvents) kept = kept.slice(0, maxEvents);
      return kept;
    }

    function save(events) {
      var payload = JSON.stringify({ version: VERSION, events: events });
      try {
        storage.set(KEY, payload);
        corrupt = false;
        return true;
      } catch (e) {
        corrupt = true;
        return false;
      }
    }

    function snapshot() {
      var data = load();
      var events = prune(data.events);
      return { version: VERSION, events: events };
    }

    function append(rawEvent) {
      var event = normalizeEvent(rawEvent, { now: now() });
      if (!event) return false;
      var data = snapshot();
      var events = data.events;
      var existingIndex = -1;
      for (var i = 0; i < events.length; i += 1) {
        if (events[i].key === event.key) {
          existingIndex = i;
          break;
        }
      }
      if (corrupt) {
        // 历史损坏：不静默覆盖用户数据，必须由用户显式 clear() 后才允许写入
        lastPersistError = 'storage-corrupt';
        return false;
      }
      var nextEvents = events.slice();
      if (existingIndex >= 0) {
        nextEvents[existingIndex] = mergeEvent(nextEvents[existingIndex], event);
      } else {
        nextEvents.push(event);
      }
      var pruned = prune(nextEvents);
      var persisted = save(pruned);
      if (!persisted) {
        lastPersistError = 'storage-write-failed';
        return false;
      }
      lastPersistError = '';
      return true;
    }

    /** 处理 engine 一轮结果：preview/dry-run 轮不落库；其余按 key upsert。 */
    function recordRound(round) {
      var result = { recorded: 0, inserted: 0, updated: 0, skipped: 0, preview: false };
      if (!round || typeof round !== 'object') return result;
      if (round.dryRun === true || round.preview === true) {
        result.preview = true;
        return result;
      }
      var rows = Array.isArray(round.results) ? round.results : [];
      var baseAt = finiteNumberOrNull(round.at);
      if (baseAt === null) baseAt = now();
      for (var i = 0; i < rows.length; i += 1) {
        var row = rows[i];
        if (!row || typeof row !== 'object') {
          result.skipped += 1;
          continue;
        }
        var rowStatus = text(row.status).toLowerCase().replace(/_/g, '-');
        if (rowStatus === 'dry-run' || rowStatus === 'preview') {
          result.skipped += 1;
          continue;
        }
        var key = sanitizeKey(row.key || row.dedupeKey);
        if (!key) {
          result.skipped += 1;
          continue;
        }
        var existed = false;
        var current = snapshot().events;
        for (var j = 0; j < current.length; j += 1) {
          if (current[j].key === key) {
            existed = true;
            break;
          }
        }
        var ok = append({
          key: key,
          at: finiteNumberOrNull(row.at) === null ? baseAt : row.at,
          accountId: row.accountId,
          module: row.module,
          action: row.action,
          activityId: row.activityId,
          activityName: row.activityName,
          category: row.category,
          status: row.status,
          reason: row.reason,
          stage: row.stage,
          distanceMeters: row.distanceMeters,
          attempt: row.attempt,
          source: row.source,
        });
        if (!ok) {
          result.skipped += 1;
          result.persistenceError = lastPersistError || 'storage-write-failed';
          continue;
        }
        result.recorded += 1;
        if (existed) result.updated += 1;
        else result.inserted += 1;
      }
      return result;
    }

    function list(filter) {
      var f = filter || {};
      var fromDay = toDay(f.from);
      var toDayValue = toDay(f.to);
      var module = text(f.module).toLowerCase();
      var status = text(f.status).toLowerCase();
      var accountId = text(f.accountId);
      var accountIds = Array.isArray(f.accountIds)
        ? f.accountIds.map(function (value) { return text(value); }).filter(Boolean)
        : [];
      var events = snapshot().events;
      var result = [];
      for (var i = 0; i < events.length; i += 1) {
        var item = events[i];
        if (fromDay && item.day < fromDay) continue;
        if (toDayValue && item.day > toDayValue) continue;
        if (module && item.module !== module) continue;
        if (status && item.status !== status) continue;
        if (accountId) {
          if (item.accountId !== accountId) continue;
        } else if (accountIds.length > 0) {
          var inScope = false;
          for (var a = 0; a < accountIds.length; a += 1) {
            if (item.accountId === accountIds[a]) { inScope = true; break; }
          }
          if (!inScope) continue;
        }
        result.push(clone(item));
      }
      return result;
    }

    function summary(filter) {
      var events = list(filter);
      var summaryResult = {
        total: events.length,
        success: 0,
        failed: 0,
        unknown: 0,
        waiting: 0,
        blocked: 0,
        skipped: 0,
        legacy: 0,
        other: 0,
        activities: 0,
        byModule: {},
        byAccount: {},
        byDay: {},
        byDaySuccess: {},
        byAction: {},
        byStatus: {},
        byModuleAction: {},
        runDistanceMeters: 0,
        firstAt: null,
        lastAt: null,
      };
      var activityIds = {};
      for (var i = 0; i < events.length; i += 1) {
        var item = events[i];
        var status = item.status;
        summaryResult.byStatus[status] = (summaryResult.byStatus[status] || 0) + 1;
        if (status === 'success') summaryResult.success += 1;
        else if (status === 'failed') summaryResult.failed += 1;
        else if (status === 'unknown') summaryResult.unknown += 1;
        else if (status === 'waiting-material' || status === 'not-yet') summaryResult.waiting += 1;
        else if (status === 'blocked') summaryResult.blocked += 1;
        else if (status === 'skipped') summaryResult.skipped += 1;
        else if (status === 'legacy') summaryResult.legacy += 1;
        else summaryResult.other += 1;

        summaryResult.byModule[item.module] = (summaryResult.byModule[item.module] || 0) + 1;
        summaryResult.byAccount[item.accountId] = (summaryResult.byAccount[item.accountId] || 0) + 1;
        summaryResult.byDay[item.day] = (summaryResult.byDay[item.day] || 0) + 1;
        summaryResult.byAction[item.action] = (summaryResult.byAction[item.action] || 0) + 1;
        if (status === 'success') {
          var moduleActionKey = item.module + '.' + item.action;
          summaryResult.byModuleAction[moduleActionKey] = (summaryResult.byModuleAction[moduleActionKey] || 0) + 1;
          // 官方实际 action 名与看板展示键的兼容别名：
          // ek 报名真实 action 是 apply（历史/展示用 join）；校园跑是 autoRun（展示用 run）。
          if (moduleActionKey === 'ek.apply') {
            summaryResult.byModuleAction['ek.join'] = (summaryResult.byModuleAction['ek.join'] || 0) + 1;
          } else if (moduleActionKey === 'unirun.autoRun') {
            summaryResult.byModuleAction['unirun.run'] = (summaryResult.byModuleAction['unirun.run'] || 0) + 1;
          }
        }

        if (summaryResult.firstAt === null || item.at < summaryResult.firstAt) summaryResult.firstAt = item.at;
        if (summaryResult.lastAt === null || item.at > summaryResult.lastAt) summaryResult.lastAt = item.at;

        // 活动完成数（lead 口径）：仅成功、非旧记录、非校园跑，且必须
        // 同时有「签到(in/check-in)」与「签退(out/check-out)」才算该活动完成；
        // 同一 activityId 的签到+签退只算一次；只有 apply/signIn 不算完成。
        if (
          status === 'success' &&
          item.activityId &&
          item.module !== 'unirun' &&
          item.action !== 'run' &&
          item.legacy !== true
        ) {
          var action = String(item.action || '').toLowerCase().replace(/[_-]/g, '');
          var isIn = action === 'in' || action === 'checkin' || action === 'signin' || action === 'attend';
          var isOut = action === 'out' || action === 'checkout' || action === 'signout' || action === 'leave';
          // 身份必须含 module+account+activity+日期，避免 A 签到 + B 签退拼成假完成
          var identity = [item.module, item.accountId, item.activityId, item.day].join('\u0001');
          var record = activityIds[identity] || (activityIds[identity] = { in: false, out: false });
          if (isIn) record['in'] = true;
          if (isOut) record.out = true;
        }

        if (status === 'success') {
          summaryResult.byDaySuccess[item.day] = (summaryResult.byDaySuccess[item.day] || 0) + 1;
          if (item.module === 'unirun') {
            var distance = finiteNumberOrNull(item.distanceMeters);
            if (distance !== null && distance > 0) {
              summaryResult.runDistanceMeters += distance;
            }
          }
        }
      }
      summaryResult.activities = 0;
      Object.keys(activityIds).forEach(function (identity) {
        var record = activityIds[identity];
        if (record && record['in'] && record.out) summaryResult.activities += 1;
      });
      return summaryResult;
    }

    /**
     * 导入旧 scheduler 的 state.done（最小迁移）：只保留动作身份，
     * 显示为“历史动作（无详情）”，不参与成功/活动完成统计。
     */
    function importLegacy(doneMap) {
      if (!doneMap || typeof doneMap !== 'object') return 0;
      var keys = Object.keys(doneMap);
      var imported = 0;
      for (var i = 0; i < keys.length; i += 1) {
        var rawKey = keys[i];
        var parts = String(rawKey).split('::').join('|').split('|');
        var day = null;
        for (var p = 0; p < parts.length; p += 1) {
          if (/^\d{4}-\d{2}-\d{2}$/.test(parts[p])) {
            day = parts[p];
            break;
          }
        }
        if (!day) day = beijingDay(now());
        var action = parts.length > 1 ? parts[parts.length - 1] : 'legacy';
        var module = parts.length > 2 ? parts[parts.length - 3] : 'legacy';
        if (!/^[a-z0-9_-]+$/i.test(module)) module = 'legacy';
        var at = Date.parse(day + 'T12:00:00+08:00');
        if (!Number.isFinite(at)) at = now();
        var key = 'legacy:' + rawKey;
        var existing = snapshot().events;
        var duplicate = false;
        for (var e = 0; e < existing.length; e += 1) {
          if (existing[e].key === key) {
            duplicate = true;
            break;
          }
        }
        if (duplicate) continue;
        var ok = append({
          key: key,
          at: at,
          day: day,
          accountId: '', // 旧 done 无账号信息：标记为未知，不混入任何当前账号筛选项
          module: module,
          action: action,
          status: 'legacy',
          reason: 'imported-legacy-done',
          legacy: true,
          source: 'legacy',
        });
        if (ok) imported += 1;
      }
      return imported;
    }

    function clear() {
      try {
        if (typeof storage.remove === 'function') storage.remove(KEY);
        else storage.set(KEY, JSON.stringify({ version: VERSION, events: [] }));
        corrupt = false;
      } catch (e) {
        corrupt = true;
      }
    }

    function retentionInfo() {
      var data = snapshot();
      return {
        maxEvents: maxEvents,
        retainDays: retainDays,
        count: data.events.length,
        oldest: data.events.length ? data.events[data.events.length - 1].day : null,
        newest: data.events.length ? data.events[0].day : null,
        corrupt: corrupt,
        persistenceError: lastPersistError,
      };
    }

    function exportJSON(filter) {
      var events = list(filter);
      var exported = { version: VERSION, exportedAt: now(), events: events };
      return JSON.stringify(exported, null, 2);
    }

    return {
      append: append,
      recordRound: recordRound,
      list: list,
      summary: summary,
      importLegacy: importLegacy,
      clear: clear,
      retentionInfo: retentionInfo,
      exportJSON: exportJSON,
    };
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  return {
    KEY: KEY,
    VERSION: VERSION,
    MAX_EVENTS: MAX_EVENTS,
    RETAIN_DAYS: RETAIN_DAYS,
    createStore: createStore,
    beijingDay: beijingDay,
    maskAccount: maskAccount,
  };
});
