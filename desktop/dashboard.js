/**
 * 3CT AutoDashboard —— 全屏「自动化看板」（纯 DOM/SVG，零外部依赖、零网络）。
 *
 * 打开方式（由 panel 调用，或 smoke 直接调用）：
 *   window.Auto3CTDashboard.open({ engine, store, accountId })
 *   window.Auto3CTDashboard.close()
 *   window.Auto3CTDashboard.isOpen()
 *   window.Auto3CTDashboard.refresh()
 *
 * 数据来源（全部只读）：
 *  - 积分：engine.getScoreSnapshot() / engine.getScorePolicyStatus() /
 *          engine.refreshScores({force}) / engine.getScreenshotInitialSnapshot() /
 *          engine.importScoreSnapshot(snapshot)
 *  - 历史：store.list(filter) / store.summary(filter) / store.exportJSON(filter)（Auto3CTResults）
 *  - 策略常量：window.Auto3CTScorePolicy（缺失时降级，不崩溃）
 *
 * 安全/口径（与 lead 确认）：
 *  - 所有文本走 textContent，绝不用 innerHTML 渲染外部数据（XSS 安全）；
 *  - 成功 = 上游已接受 action（status==='success'），提交成功 ≠ 官方入账，本看板不加分；
 *  - 积分表始终来自 snapshot（source=manual/official/截图初值并标注非实时），缺失不补 0；
 *  - 已达标模块只阻止“新增报名”，已报名活动继续签到/签退；
 *  - 历史默认按当前账号隔离（ek/tanma 分组），可显式切换“全部”；
 *  - 预览/dry-run 轮次不落库（由 result-store 保证）；
 *  - 不显示姓名/完整手机号；账号统一掩码。
 */
(function (root) {
  'use strict';
  if (!root || !root.document) return;

  var DAY_MS = 24 * 60 * 60 * 1000;
  var BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
  // 截图初值（无 PII；用户点击后才绑定当前 ek 账号）
  var SCREENSHOT_FALLBACK = [
    { name: '思想政治与道德修养', required: 12, current: 6 },
    { name: '学术科技与创新创业', required: 8, current: 4 },
    { name: '艺术体验与审美修养', required: 12, current: 2 },
    { name: '传统文化与人文素养', required: 8, current: 8.5 },
    { name: '人际交往与沟通能力', required: 8, current: 4 },
    { name: '心理素质与身体素质', required: 12, current: 15.5 },
    { name: '社会实践与志愿服务', required: 12, current: 11 },
    { name: '社会工作与能力拓展', required: 8, current: 3.5 },
  ];

  var state = {
    engine: null,
    store: null,
    accountId: '',
    tab: 'overview',
    trendDays: 7,
    filters: { from: '', to: '', module: '', status: '', account: '' },
    snapshot: null,
    policy: null,
    message: '',
    messageKind: 'info',
  };

  var el = {};
  var mounted = false;

  // ───────────────────────── 工具 ─────────────────────────

  function h(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var value = attrs[key];
        if (value === undefined || value === null) return;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = String(value);
        else if (key === 'value') node.value = value;
        else if (
          key === 'disabled' || key === 'checked' || key === 'selected' ||
          key === 'hidden' || key === 'readOnly' || key === 'readonly'
        ) {
          // 布尔 attribute：false/undefined/null/'false'/0 一律不写 attribute 并置 DOM property=false，
          // true 才写 attribute + property=true。避免 disabled="false" 导致按钮不可点。
          var enabled = value === true || value === 'true' || value === 1 || value === '1';
          var attrName = key === 'readOnly' ? 'readonly' : key;
          var propName = key === 'readonly' ? 'readOnly' : key;
          if (enabled) node.setAttribute(attrName, '');
          else node.removeAttribute(attrName);
          try {
            node[propName] = enabled;
          } catch (e) {
            /* 个别属性只读时忽略 */
          }
        } else if (key.indexOf('on') === 0 && typeof value === 'function') {
          // 事件必须用 addEventListener/property，绝不能 setAttribute('onclick', fn)
          node.addEventListener(key.slice(2).toLowerCase(), value);
        } else node.setAttribute(key, String(value));
      });
    }
    (children || []).forEach(function (child) {
      if (child === null || child === undefined) return;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return node;
  }

  function svg(tag, attrs, children) {
    var node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        node.setAttribute(key, String(attrs[key]));
      });
    }
    (children || []).forEach(function (child) {
      if (child) node.appendChild(child);
    });
    return node;
  }

  function text(value) {
    return value === null || value === undefined ? '' : String(value);
  }

  function finite(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string' && value.trim() === '') return null;
    var number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function maskAccount(accountId) {
    var id = text(accountId).trim();
    if (!id) return '未绑定';
    if (/^1\d{10}$/.test(id)) return id.replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2');
    if (id.length <= 4) return id.charAt(0) + '***';
    return id.slice(0, 2) + '***' + id.slice(-2);
  }

  function beijingDay(ms) {
    var value = finite(ms);
    if (value === null) value = Date.now();
    return new Date(value + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
  }

  function formatDateTime(ms) {
    var value = finite(ms);
    if (value === null) return '—';
    var d = new Date(value + BEIJING_OFFSET_MS);
    var pad = function (n) {
      return String(n).padStart(2, '0');
    };
    return (
      d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) +
      ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes())
    );
  }

  function maskTime(ms) {
    var value = finite(ms);
    if (value === null) return '—';
    var d = new Date(value + BEIJING_OFFSET_MS);
    var pad = function (n) {
      return String(n).padStart(2, '0');
    };
    return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds());
  }

  function safeCall(fn, fallback) {
    try {
      var value = fn();
      return value === undefined ? fallback : value;
    } catch (e) {
      return fallback;
    }
  }

  function setMessage(kind, message) {
    state.message = message || '';
    state.messageKind = kind || 'info';
  }

  function scorePolicy() {
    return root.Auto3CTScorePolicy || null;
  }

  function storeApi() {
    if (state.store) return state.store;
    var R = root.Auto3CTResults || root.Auto3CTResultStore || null;
    if (!R || typeof R.createStore !== 'function') return null;
    try {
      state.store = R.createStore({
        storage: {
          get: function (key) {
            return root.localStorage.getItem(key);
          },
          set: function (key, value) {
            root.localStorage.setItem(key, value);
          },
          remove: function (key) {
            root.localStorage.removeItem(key);
          },
        },
        clock: { now: function () { return Date.now(); } },
      });
    } catch (e) {
      state.store = null;
    }
    return state.store;
  }

  // ───────────────────────── 数据读取 ─────────────────────────

  function readScoreData() {
    state.snapshot = null;
    state.policy = null;
    if (!state.engine) return;
    state.snapshot = safeCall(function () { return state.engine.getScoreSnapshot(); }, null) || null;
    state.policy = safeCall(function () { return state.engine.getScorePolicyStatus(); }, null) || null;
  }

  /** 把 snapshot/policy 归一成用于展示的模块列表。 */
  function moduleRows() {
    var rows = [];
    var byName = {};
    function add(name, required, current, extra) {
      var key = text(name);
      if (!key) return;
      var row = byName[key];
      if (!row) {
        row = {
          name: key,
          required: null,
          current: null,
          gap: null,
          satisfied: false,
          trusted: false,
          unknown: false,
          source: '',
        };
        byName[key] = row;
        rows.push(row);
      }
      if (required !== null && required !== undefined && finite(required) !== null) row.required = finite(required);
      if (current !== null && current !== undefined && finite(current) !== null) row.current = finite(current);
      if (extra) {
        if (extra.gap !== undefined && extra.gap !== null) row.gap = finite(extra.gap);
        if (extra.satisfied !== undefined) row.satisfied = Boolean(extra.satisfied);
        if (extra.trusted !== undefined) row.trusted = Boolean(extra.trusted);
        if (extra.unknown !== undefined) row.unknown = Boolean(extra.unknown);
        if (extra.source) row.source = extra.source;
      }
    }
    if (state.snapshot && Array.isArray(state.snapshot.modules)) {
      state.snapshot.modules.forEach(function (item) {
        add(item.name, item.required, item.current, {
          gap: item.gap,
          satisfied: item.satisfied,
          trusted: item.trusted,
        });
      });
    }
    if (state.policy && Array.isArray(state.policy.gaps)) {
      state.policy.gaps.forEach(function (item) {
        add(item.name, item.required, item.current, {
          gap: item.gap,
          satisfied: item.satisfied,
          trusted: item.trusted,
        });
      });
    }
    if (!rows.length) {
      var P = scorePolicy();
      var modules = (P && (P.getScreenshotInitialModules ? P.getScreenshotInitialModules() : P.SCREENSHOT_INITIAL)) || SCREENSHOT_FALLBACK;
      modules.forEach(function (item) {
        add(item.name, item.required, null, {});
      });
    }
    rows.forEach(function (row) {
      if (row.gap === null && row.required !== null && row.current !== null) {
        row.gap = Math.max(0, row.required - row.current);
      }
      // 仅在 trusted 完全未标记（undefined）时，才允许按有 current 推导为可信；
      // 显式 trusted===false 表示官方缺字段/数据不可信，绝不覆盖（旧值仅展示“待确认”）。
      if (row.trusted === undefined && row.current !== null && row.required !== null) {
        row.trusted = true;
      }
      if (row.trusted === true && row.required !== null && row.current !== null) {
        row.satisfied = row.current >= row.required;
      }
    });
    return rows;
  }

  function gapSummary(rows) {
    var total = 0;
    var satisfied = 0;
    var known = 0;
    var unknown = 0;
    rows.forEach(function (row) {
      var trusted = row.trusted !== false && row.current !== null;
      if (!trusted) {
        unknown += 1;
        return;
      }
      known += 1;
      if (row.gap !== null) total += row.gap;
      if (row.satisfied) satisfied += 1;
    });
    return {
      gap: known > 0 ? Math.round(total * 100) / 100 : null,
      satisfied: satisfied,
      known: known,
      unknown: unknown,
      total: rows.length,
    };
  }

  function sourceLabel(snapshot, policy) {
    var source = (snapshot && snapshot.source) || (policy && policy.source) || '';
    if (source === 'official') return '官方成绩';
    if (source === 'manual') {
      return state.importOrigin === 'screenshot' ? '手工数据（截图初值，非实时）' : '手工数据（非实时）';
    }
    if (!source) return snapshot ? '未知来源' : '尚无积分数据';
    return source;
  }

  function isStale(snapshot, policy) {
    if (policy && policy.stale !== undefined) return Boolean(policy.stale);
    if (snapshot && snapshot.stale !== undefined) return Boolean(snapshot.stale);
    return false;
  }

  /** 每次 render 都从 engine.getProfiles() 读取最新账号（避免沿用旧的 state.accountId）。 */
  function currentAccounts() {
    var hint = state.accountsHint || {};
    var profiles = safeCall(function () { return state.engine.getProfiles(); }, null) || {};
    var ek = profiles.ekAccount ? String(profiles.ekAccount) : '';
    var unirun = profiles.unirunAccountId ? String(profiles.unirunAccountId) : '';
    if (!unirun) {
      var items = Array.isArray(profiles.unirunAccounts) ? profiles.unirunAccounts : [];
      for (var i = 0; i < items.length; i += 1) {
        if (items[i] && items[i].selected && items[i].id) {
          unirun = String(items[i].id);
          break;
        }
      }
    }
    if (!ek && hint.ekAccount) ek = String(hint.ekAccount);
    if (!unirun && hint.unirunAccountId) unirun = String(hint.unirunAccountId);
    return { ekAccount: ek, unirunAccountId: unirun };
  }

  function scopeAccounts() {
    var accounts = currentAccounts();
    var list = [];
    if (accounts.ekAccount) list.push(accounts.ekAccount);
    if (accounts.unirunAccountId) list.push(accounts.unirunAccountId);
    if (!list.length && state.accountId) list.push(state.accountId);
    return list;
  }

  function currentAccount() {
    var accounts = currentAccounts();
    return accounts.ekAccount || accounts.unirunAccountId || state.accountId || '';
  }

  // ───────────────────────── 外壳 ─────────────────────────

  function ensureMounted() {
    if (mounted) return;
    mounted = true;

    el.tabs = {
      overview: tabButton('概览', 'dashboard-tab-overview', 'overview'),
      scores: tabButton('二课补分', 'dashboard-tab-scores', 'scores'),
      results: tabButton('执行记录', 'dashboard-tab-results', 'results'),
    };
    el.body = h('div', { class: 'a3d-body' });
    el.message = h('div', { class: 'a3d-message', 'data-testid': 'dashboard-message' });

    var refreshBtn = h('button', {
      class: 'a3d-btn',
      type: 'button',
      text: '刷新分数',
      'data-testid': 'dashboard-refresh',
      onclick: function () { refreshScores(true); },
    });
    var closeBtn = h('button', {
      class: 'a3d-btn a3d-btn-close',
      type: 'button',
      text: '× 关闭',
      'data-testid': 'dashboard-close',
      'aria-label': '关闭看板',
      onclick: close,
    });

    var rootNode = h('div', { class: 'auto3ct-dashboard', 'data-testid': 'dashboard-root' }, [
      h('div', { class: 'a3d-panel' }, [
        h('div', { class: 'a3d-head' }, [
          h('div', { class: 'a3d-brand' }, [
            h('span', { class: 'a3d-dot' }),
            h('span', { text: '3CT 自动化看板' }),
          ]),
          h('div', { class: 'a3d-head-actions' }, [refreshBtn, closeBtn]),
        ]),
        el.message,
        h('div', { class: 'a3d-tabs' }, [el.tabs.overview, el.tabs.scores, el.tabs.results]),
        el.body,
      ]),
    ]);
    rootNode.addEventListener('click', function (event) {
      if (event.target === rootNode) close();
    });
    el.root = rootNode;
    document.body.appendChild(rootNode);
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && el.root && el.root.style.display !== 'none') close();
    });
  }

  function tabButton(label, testid, tab) {
    return h('button', {
      class: 'a3d-tab',
      type: 'button',
      text: label,
      'data-testid': testid,
      onclick: function () { selectTab(tab); },
    });
  }

  function selectTab(tab) {
    state.tab = tab;
    render();
  }

  function render() {
    ensureMounted();
    if (!el.root) return;
    Object.keys(el.tabs).forEach(function (key) {
      el.tabs[key].classList.toggle('active', key === state.tab);
    });
    if (state.message) {
      el.message.textContent = state.message;
      el.message.className = 'a3d-message a3d-message-' + state.messageKind;
      el.message.style.display = 'block';
    } else {
      el.message.style.display = 'none';
    }
    el.body.innerHTML = '';
    readScoreData();
    // 结果仓库持久化失败/损坏时，看板顶部明确告警（不静默）
    (function () {
      var store = storeApi();
      if (!store) return;
      var info = safeCall(function () { return store.retentionInfo(); }, null);
      if (!info) return;
      if (info.corrupt) {
        setMessage('error', '执行历史存储损坏：已停止写入以保护原数据，请在「执行记录」页导出/重置后再继续。');
      } else if (info.persistenceError) {
        setMessage('error', '执行历史保存失败（' + info.persistenceError + '）：结果仅在本次内存中，请检查磁盘/权限。');
      }
    })();
    if (state.tab === 'scores') el.body.appendChild(buildScoresTab());
    else if (state.tab === 'results') el.body.appendChild(buildResultsTab());
    else el.body.appendChild(buildOverviewTab());
  }

  // ───────────────────────── 概览 ─────────────────────────

  function card(testid, title, value, hint) {
    return h('div', { class: 'a3d-card', 'data-testid': testid }, [
      h('div', { class: 'a3d-card-title', text: title }),
      h('div', { class: 'a3d-card-value', text: value }),
      hint ? h('div', { class: 'a3d-card-hint', text: hint }) : null,
    ]);
  }

  function buildOverviewTab() {
    var rows = moduleRows();
    var summary = gapSummary(rows);
    var stale = isStale(state.snapshot, state.policy);
    var accounts = currentAccounts();
    var account = accounts.ekAccount || state.accountId || '';
    var policyEnabled = state.policy && state.policy.enabled !== undefined ? Boolean(state.policy.enabled) : true;
    var hasSnapshot = Boolean(state.snapshot);
    var gapText;
    if (!hasSnapshot) gapText = '待导入/刷新';
    else if (summary.gap === null) gapText = '—（未知）';
    else if (summary.unknown > 0) gapText = '已知缺口 ' + summary.gap + ' · ' + summary.unknown + ' 项未知';
    else gapText = summary.gap + ' 分';
    var satisfiedText = hasSnapshot && summary.known > 0
      ? summary.satisfied + ' / ' + summary.total
      : '—';
    var snapshot = state.snapshot;
    var totalCurrent = 0;
    var totalRequired = 0;
    var trusted = Boolean(state.snapshot) || Boolean(state.policy && state.policy.trusted);
    rows.forEach(function (row) {
      if (row.required !== null) totalRequired += row.required;
      if (row.current !== null) totalCurrent += row.current;
    });

    var cards = h('div', { class: 'a3d-cards' }, [
      card(
        'dashboard-summary-gap',
        '总缺口',
        gapText,
        hasSnapshot ? '仅统计已知/可信模块的 max(0,要求-已得)；未知不按 0 计' : '尚未导入成绩：新增报名暂停，请先刷新官方成绩或使用截图初值',
      ),
      card(
        'dashboard-summary-satisfied',
        '已达标模块',
        satisfiedText,
        '达标后停止新增报名，已报名活动继续签到/签退',
      ),
      card(
        'dashboard-summary-policy',
        '缺口策略',
        policyEnabled ? '已启用' : '已关闭',
        policyEnabled ? '未导入/未刷新前会暂停新增报名（已报名继续签到退）' : '不按达标限制新增报名',
      ),
      card(
        'dashboard-summary-account',
        '二课账号',
        maskAccount(accounts.ekAccount || ''),
        '二课积分/报名/签到退使用该账号',
      ),
      card(
        'dashboard-summary-account-unirun',
        '校园跑账号',
        maskAccount(accounts.unirunAccountId || ''),
        '校园跑/俱乐部共用该账号（tanma）',
      ),
      card(
        'dashboard-summary-source',
        '分数来源',
        sourceLabel(snapshot, state.policy),
        '提交成功不等于官方入账，本看板不自动加分',
      ),
      card(
        'dashboard-summary-updated',
        '更新时间',
        snapshot && snapshot.updatedAt ? formatDateTime(snapshot.updatedAt) : '—',
        '截图初值不是实时成绩',
      ),
    ]);

    var staleBadge = stale
      ? h('div', { class: 'a3d-badge a3d-badge-warn', 'data-testid': 'dashboard-stale', text: '数据可能过期（stale），保留旧值' })
      : h('div', { class: 'a3d-badge a3d-badge-ok', 'data-testid': 'dashboard-stale', text: '数据新鲜' });

    var progressList = h('div', { class: 'a3d-progress-list' });
    rows.forEach(function (row) {
      progressList.appendChild(buildProgressRow(row));
    });

    var overviewParts = [h('div', { class: 'a3d-section-title', text: '二课积分进度（官方八模块）' }), staleBadge, cards, progressList];
    if (!hasSnapshot) {
      overviewParts.splice(1, 0, h('div', {
        class: 'a3d-hint',
        text: '尚未导入积分成绩：缺口未知（不是 0），缺口策略默认启用 → 新增报名暂停；已报名活动仍会继续签到/签退。可在「二课补分」页刷新官方成绩或使用截图初值。',
      }));
    } else if (totalRequired > 0) {
      overviewParts.splice(1, 0, h('div', {
        class: 'a3d-hint',
        text: '当前累计 ' + (Math.round(totalCurrent * 100) / 100) + ' / 要求 ' + totalRequired + ' 分（仅展示 snapshot 来源，不自动加分）。',
      }));
    }

    var resultStore = storeApi();
    var summaryFilter = currentFilter();
    var resultSummary = resultStore
      ? safeCall(function () { return resultStore.summary(summaryFilter); }, null)
      : null;

    overviewParts.push(h('div', { class: 'a3d-section-title', text: '最近执行结果' }));
    if (!resultStore) {
      overviewParts.push(h('div', { class: 'a3d-hint', text: '结果仓库未加载（result-store.js），暂时无法显示执行历史。' }));
    } else if (!resultSummary || resultSummary.total === 0) {
      overviewParts.push(h('div', { class: 'a3d-empty', 'data-testid': 'dashboard-empty', text: '尚无记录（真实执行后会自动累计；预览不计入）' }));
    } else {
      overviewParts.push(
        h('div', { class: 'a3d-cards' }, [
          card('dashboard-summary-total', '窗口内记录', String(resultSummary.total), '最多保留 2000 条 / 90 天'),
          card('dashboard-summary-success', '上游已接受', String(resultSummary.success), 'success=上游动作接受，非官方入账'),
          card('dashboard-summary-activities', '签到＋签退完成', String(resultSummary.activities), '同一活动 in+out 两端都成功才计；官方无需签退的活动暂无 flag，不判完整'),
          card('dashboard-summary-run', '校园跑成功', String((resultSummary.byModule && resultSummary.byModule.unirun) || 0), '仅展示已确认 metadata 的成功记录'),
          card('dashboard-summary-distance', '校园跑距离', String(Math.round((resultSummary.runDistanceMeters || 0) * 10) / 10) + ' 米', '仅 unirun 成功且有正数距离'),
        ]),
      );
      var byModuleAction = resultSummary.byModuleAction || {};
      var actionCards = [
        ['unirun.run', '校园跑成功'],
        ['club.join', '俱乐部报名'],
        ['club.signIn', '俱乐部签到'],
        ['club.signOut', '俱乐部签退'],
        ['ek.join', '二课报名'],
        ['ek.signIn', '二课签到'],
        ['ek.signOut', '二课签退'],
      ];
      overviewParts.push(
        h('div', { class: 'a3d-cards', 'data-testid': 'dashboard-module-actions' },
          actionCards.map(function (pair) {
            return card('dashboard-action-' + pair[0].replace('.', '-'), pair[1], String(byModuleAction[pair[0]] || 0), '上游已接受动作数（非到账）');
          }),
        ),
      );
      overviewParts.push(buildTrend());
    }
    return h('div', { class: 'a3d-tab-body' }, overviewParts);
  }

  function buildProgressRow(row) {
    var required = row.required;
    var current = row.current;
    var trusted = row.trusted !== false;
    var hasValue = required !== null && current !== null;
    var hasData = hasValue && trusted;
    var pct = hasData && required > 0 ? Math.min(100, Math.max(0, (current / required) * 100)) : 0;
    var gap = hasData ? Math.max(0, required - current) : null;
    var badgeText;
    var badgeClass;
    if (!hasValue) {
      badgeText = '未知';
      badgeClass = 'a3d-badge-unknown';
    } else if (!trusted) {
      // 官方缺字段但保留了旧值：显示数值但标“待确认”，不计达标/缺口
      badgeText = '待确认';
      badgeClass = 'a3d-badge-warn';
    } else if (gap === 0) {
      badgeText = '达标';
      badgeClass = 'a3d-badge-ok';
    } else {
      badgeText = '缺 ' + (Math.round(gap * 100) / 100);
      badgeClass = 'a3d-badge-gap';
    }
    return h('div', {
      class: 'a3d-progress-row',
      'data-testid': 'dashboard-progress-row',
      'data-module': row.name,
    }, [
      h('div', { class: 'a3d-progress-head' }, [
        h('span', { class: 'a3d-progress-name', text: row.name }),
        h('span', { class: 'a3d-badge ' + badgeClass, text: badgeText }),
      ]),
      h('div', { class: 'a3d-progress-track' }, [
        h('div', {
          class: 'a3d-progress-fill' + (gap === 0 ? ' done' : ''),
          'data-testid': 'dashboard-progress-bar',
          'data-module': row.name,
          'data-current': hasData ? String(current) : '',
          'data-required': hasData ? String(required) : '',
          style: 'width:' + pct.toFixed(1) + '%',
        }),
      ]),
      h('div', {
        class: 'a3d-progress-meta',
        text: !hasValue
          ? '未纳入策略/无数据（不按 0 计）'
          : !trusted
            ? current + ' / ' + required + ' 分（旧值待确认，不计达标/缺口）'
            : current + ' / ' + required + ' 分',
      }),
    ]);
  }

  function buildTrend() {
    var store = storeApi();
    var days = state.trendDays;
    var account = state.filters.account || currentAccount();
    var summary = store
      ? safeCall(function () { return store.summary({ accountIds: scopeAccounts() }); }, null)
      : null;
    // 标题是“成功趋势”，因此只统计 success（byDay 含全部状态，不能混用）
    var byDay = (summary && summary.byDaySuccess) || {};
    var today = beijingDay(Date.now());
    var todayMs = Date.parse(today + 'T00:00:00+08:00');
    var items = [];
    for (var offset = days - 1; offset >= 0; offset -= 1) {
      var day = beijingDay(todayMs - offset * DAY_MS);
      items.push({ day: day, count: byDay[day] || 0 });
    }
    var max = 1;
    items.forEach(function (item) {
      if (item.count > max) max = item.count;
    });
    var width = 560;
    var height = 150;
    var padBottom = 22;
    var barWidth = Math.min(48, Math.floor((width - 20) / items.length) - 6);
    var chart = svg('svg', { class: 'a3d-trend', viewBox: '0 0 ' + width + ' ' + height, role: 'img', 'aria-label': '最近执行趋势' });
    items.forEach(function (item, index) {
      var barHeight = Math.round(((height - padBottom - 14) * item.count) / max);
      var x = 12 + index * ((width - 20) / items.length) + (((width - 20) / items.length) - barWidth) / 2;
      var y = height - padBottom - barHeight;
      var rect = svg('rect', {
        x: x, y: y, width: barWidth, height: Math.max(0, barHeight), rx: 3,
        class: 'a3d-trend-bar',
      });
      var title = svg('title');
      title.textContent = item.day + '：' + item.count + ' 条';
      rect.appendChild(title);
      chart.appendChild(rect);
      var label = svg('text', {
        x: x + barWidth / 2, y: height - 6, 'text-anchor': 'middle', class: 'a3d-trend-label',
      });
      label.textContent = item.day.slice(5);
      chart.appendChild(label);
    });
    return h('div', { class: 'a3d-trend-wrap' }, [
      h('div', { class: 'a3d-trend-head' }, [
        h('span', { class: 'a3d-section-title', text: '成功趋势（上游已接受的 action，按天）' }),
        h('div', { class: 'a3d-inline' }, [
          h('button', {
            class: 'a3d-chip' + (days === 7 ? ' active' : ''),
            type: 'button', text: '7 天', 'data-testid': 'dashboard-trend-7',
            onclick: function () { state.trendDays = 7; render(); },
          }),
          h('button', {
            class: 'a3d-chip' + (days === 14 ? ' active' : ''),
            type: 'button', text: '14 天', 'data-testid': 'dashboard-trend-14',
            onclick: function () { state.trendDays = 14; render(); },
          }),
        ]),
      ]),
      chart,
    ]);
  }

  // ───────────────────────── 二课补分 ─────────────────────────

  function buildScoresTab() {
    var engine = state.engine;
    var canImport = Boolean(engine && typeof engine.importScoreSnapshot === 'function');
    var rows = moduleRows();
    var container = h('div', { class: 'a3d-tab-body' });

    container.appendChild(h('div', {
      class: 'a3d-hint',
      text: '积分只来自本地导入/官方成绩快照。达标模块停止新增报名；已报名活动仍会继续签到/签退。提交成功不等于加分。',
    }));

    if (!canImport) {
      container.appendChild(h('div', { class: 'a3d-empty', text: '当前 engine 未提供积分导入接口（等待 automation.js 更新）。' }));
    }

    var templateBtn = h('button', {
      class: 'a3d-btn', type: 'button', text: '使用截图初值（需绑定当前二课账号）',
      'data-testid': 'dashboard-template-apply',
      disabled: !canImport,
      onclick: applyScreenshotInitial,
    });
    var manualRows = h('div', { class: 'a3d-score-list' });
    rows.forEach(function (row) {
      manualRows.appendChild(buildScoreRow(row));
    });

    container.appendChild(h('div', { class: 'a3d-inline' }, [templateBtn]));
    container.appendChild(manualRows);
    container.appendChild(h('div', { class: 'a3d-inline' }, [
      h('button', {
        class: 'a3d-btn a3d-btn-primary', type: 'button', text: '保存本机积分（需确认）',
        'data-testid': 'dashboard-score-save',
        disabled: !canImport,
        onclick: saveManualScores,
      }),
    ]));
    return container;
  }

  function buildScoreRow(row) {
    var requiredInput = h('input', {
      class: 'a3d-input', type: 'number', min: '0', step: '0.5',
      'data-testid': 'dashboard-score-required',
      value: row.required === null ? '' : String(row.required),
    });
    var currentInput = h('input', {
      class: 'a3d-input', type: 'number', min: '0', step: '0.5',
      'data-testid': 'dashboard-score-current',
      value: row.current === null ? '' : String(row.current),
    });
    requiredInput.setAttribute('data-module', row.name);
    currentInput.setAttribute('data-module', row.name);
    var visible = row.current === null || row.required === null ? '未知' : row.current + ' / ' + row.required + ' 分';
    return h('div', { class: 'a3d-score-row', 'data-testid': 'dashboard-score-row', 'data-module': row.name }, [
      h('span', { class: 'a3d-score-name', text: row.name }),
      h('span', { class: 'a3d-score-value', 'data-testid': 'dashboard-score-value', text: visible }),
      h('label', { class: 'a3d-score-field' }, [h('span', { text: '要求' }), requiredInput]),
      h('label', { class: 'a3d-score-field' }, [h('span', { text: '已得' }), currentInput]),
    ]);
  }

  function parseInputNumber(input) {
    if (!input) return { empty: true, value: null };
    var raw = String(input.value === undefined || input.value === null ? '' : input.value).trim();
    if (raw === '') return { empty: true, value: null };
    var number = finite(raw);
    if (number === null) return { empty: false, value: null, invalid: true };
    return { empty: false, value: number };
  }

  /**
   * 读取 8 模块手工输入（lead 口径）：
   * - required 必须 > 0 的有限数字（与 score-policy 校验一致；0/负数/空都拒绝）；
   * - current 留空 = 未知（不按 0 保存），非法数字拒绝；
   * - 任一非法 -> 不保存。
   */
  function readManualModules() {
    var rows = [];
    var errors = [];
    var inputs = el.body.querySelectorAll('[data-testid="dashboard-score-row"]');
    Array.prototype.forEach.call(inputs, function (rowNode) {
      var name = rowNode.getAttribute('data-module') || '';
      var requiredParsed = parseInputNumber(rowNode.querySelector('[data-testid="dashboard-score-required"]'));
      var currentParsed = parseInputNumber(rowNode.querySelector('[data-testid="dashboard-score-current"]'));
      if (requiredParsed.empty || requiredParsed.invalid) {
        errors.push(name + '：要求分数必须是 >0 的有限数字');
      } else if (requiredParsed.value <= 0) {
        errors.push(name + '：要求分数必须 >0');
      }
      if (!currentParsed.empty && currentParsed.invalid) {
        errors.push(name + '：已得分数必须是有限数字（留空表示未知）');
      } else if (!currentParsed.empty && currentParsed.value < 0) {
        errors.push(name + '：已得分数不能为负');
      }
      rows.push({
        name: name,
        required: requiredParsed.value,
        current: currentParsed.empty || currentParsed.invalid ? null : currentParsed.value,
      });
    });
    return { modules: rows, invalid: errors.length ? errors.slice(0, 3).join('；') : '' };
  }

  function applyScreenshotInitial() {
    var engine = state.engine;
    if (!engine || typeof engine.getScreenshotInitialSnapshot !== 'function') {
      setMessage('warn', '当前 engine 没有截图初值模板接口。');
      render();
      return;
    }
    var template = null;
    try {
      template = engine.getScreenshotInitialSnapshot();
    } catch (e) {
      template = null;
    }
    if (!template) {
      setMessage('error', '读取截图初值失败。');
      render();
      return;
    }
    var account = currentAccount();
    if (!account) {
      setMessage('warn', '请先在 3CT 里登录二课账号，再使用截图初值（会绑定当前账号）。');
      render();
      return;
    }
    var ok = root.confirm(
      '将使用截图初值（8 模块共缺 29.5 分，其中 2 个已达标）并绑定当前二课账号 ' +
        maskAccount(account) + '。\n\n截图初值不是实时成绩；之后可点「刷新分数」获取官方数据覆盖。\n仅保存在本机。',
    );
    if (!ok) return;
    var result = null;
    try {
      if (typeof engine.importScoreSnapshot !== 'function') {
        setMessage('error', '当前 engine 不支持导入积分快照。');
        render();
        return;
      }
      result = engine.importScoreSnapshot(template);
    } catch (e) {
      setMessage('error', '绑定截图初值失败：' + (e && e.message ? e.message : String(e)));
      render();
      return;
    }
    // engine 约定返回 {ok, snapshot}；失败时绝不允许显示成功
    if (!result || result.ok !== true || !result.snapshot) {
      setMessage('error', '绑定截图初值失败：' + ((result && result.reason) || '未返回有效快照'));
      render();
      return;
    }
    state.importOrigin = 'screenshot';
    setMessage('info', '已绑定当前账号的截图初值（手工数据，非实时；可稍后刷新官方成绩）。');
    render();
  }

  function saveManualScores() {
    if (!root.confirm('保存会覆盖本机当前账号的积分快照（仅本机、不上传）。确定保存？')) return;
    var parsed = readManualModules();
    if (parsed.invalid) {
      setMessage('error', parsed.invalid + '（请输入 >=0 的有限数字）');
      render();
      return;
    }
    var engine = state.engine;
    var snapshot = null;
    var P = scorePolicy();
    var account = currentAccount();
    var result = null;
    try {
      if (P && typeof P.buildSnapshot === 'function') {
        snapshot = P.buildSnapshot({
          accountId: account,
          source: 'manual',
          modules: parsed.modules,
          updatedAt: Date.now(),
          accountVerified: true,
        });
      } else {
        snapshot = { accountId: account, source: 'manual', updatedAt: Date.now(), modules: parsed.modules };
      }
      result = engine.importScoreSnapshot(snapshot);
    } catch (e) {
      setMessage('error', '保存积分失败：' + (e && e.message ? e.message : String(e)));
      render();
      return;
    }
    if (!result || result.ok !== true || !result.snapshot) {
      setMessage('error', '保存积分失败：' + ((result && result.reason) || 'engine 未返回有效快照'));
      render();
      return;
    }
    state.importOrigin = 'manual';
    setMessage('info', '已保存本机积分快照（手工数据，非官方到账）。');
    render();
  }

  // ───────────────────────── 执行记录 ─────────────────────────

  function buildResultsTab() {
    var store = storeApi();
    var container = h('div', { class: 'a3d-tab-body' });
    if (!store) {
      container.appendChild(h('div', { class: 'a3d-empty', text: '结果仓库未加载（result-store.js）。' }));
      return container;
    }

    var accountStats = safeCall(function () { return store.summary({}); }, null) || { byAccount: {} };
    var accountField = selectField('dashboard-filter-account', '账号', [
      ['__current__', '当前账号组（默认）'],
      ['', '全部账号'],
    ].concat(
      Object.keys(accountStats.byAccount || {}).map(function (id) {
        return [id, maskAccount(id)];
      }),
    ), state.filters.account || '__current__');
    var moduleField = selectField('dashboard-filter-module', '模块', [
      ['', '全部模块'], ['ek', '二课'], ['club', '俱乐部'], ['unirun', '校园跑'], ['legacy', '历史动作'],
    ], state.filters.module || '');
    var statusField = selectField('dashboard-filter-status', '状态', [
      ['', '全部状态'], ['success', '上游已接受'], ['failed', '失败'], ['unknown', '结果未知'],
      ['waiting-material', '等待材料'], ['blocked', '阻断'], ['skipped', '跳过'], ['legacy', '旧动作'],
    ], state.filters.status || '');
    var fromInput = h('input', {
      class: 'a3d-input', type: 'date', value: state.filters.from || '',
      'data-testid': 'dashboard-filter-from',
    });
    var toInput = h('input', {
      class: 'a3d-input', type: 'date', value: state.filters.to || '',
      'data-testid': 'dashboard-filter-to',
    });

    var applyBtn = h('button', {
      class: 'a3d-btn a3d-btn-primary', type: 'button', text: '筛选',
      'data-testid': 'dashboard-filter-apply',
      onclick: function () {
        state.filters.from = fromInput.value || '';
        state.filters.to = toInput.value || '';
        state.filters.module = moduleField.input.value || '';
        state.filters.status = statusField.input.value || '';
        state.filters.account = accountField.input.value || '';
        render();
      },
    });
    var resetBtn = h('button', {
      class: 'a3d-btn', type: 'button', text: '重置',
      'data-testid': 'dashboard-filter-reset',
      onclick: function () {
        state.filters = { from: '', to: '', module: '', status: '', account: '__current__' };
        render();
      },
    });
    var exportBtn = h('button', {
      class: 'a3d-btn', type: 'button', text: '导出 JSON（脱敏）',
      'data-testid': 'dashboard-export',
      onclick: function () {
        var filter = currentFilter();
        var json = safeCall(function () { return store.exportJSON(filter); }, '{"version":1,"events":[]}');
        var blob = new Blob([json], { type: 'application/json;charset=utf-8' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'auto3ct-results-' + Date.now() + '.json';
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
      },
    });

    container.appendChild(h('div', { class: 'a3d-filters' }, [
      h('label', { class: 'a3d-filter' }, [h('span', { text: '从' }), fromInput]),
      h('label', { class: 'a3d-filter' }, [h('span', { text: '到' }), toInput]),
      accountField.wrapper, moduleField.wrapper, statusField.wrapper,
      applyBtn, resetBtn, exportBtn,
    ]));

    var filter = currentFilter();
    var events = safeCall(function () { return store.list(filter); }, []);
    var count = h('div', { class: 'a3d-hint', 'data-testid': 'dashboard-results-count', text: '共 ' + events.length + ' 条记录（窗口内最多 2000 条/90 天）' });
    container.appendChild(count);
    if (!events.length) {
      container.appendChild(h('div', { class: 'a3d-empty', 'data-testid': 'dashboard-empty', text: '尚无记录（预览不计入；真实执行后才落库）' }));
      return container;
    }
    var table = h('table', { class: 'a3d-table', 'data-testid': 'dashboard-results-table' }, [
      h('thead', {}, [
        h('tr', {}, ['时间', '账号', '模块', '动作', '活动', '状态', '原因'].map(function (label) {
          return h('th', { text: label });
        })),
      ]),
    ]);
    var tbody = h('tbody');
    events.forEach(function (item) {
      tbody.appendChild(h('tr', {
        'data-testid': 'dashboard-results-row',
        'data-key': item.key,
        'data-status': item.status,
      }, [
        h('td', { text: formatDateTime(item.at) }),
        h('td', { text: item.accountMask || maskAccount(item.accountId) }),
        h('td', { text: moduleLabel(item.module) }),
        h('td', { text: actionLabel(item.action) }),
        h('td', { class: 'a3d-ellipsis', text: item.activityName || (item.legacy ? '历史动作（无详情）' : '—') }),
        h('td', {}, [
          h('span', { class: 'a3d-badge a3d-badge-' + statusKind(item.status), text: statusLabel(item.status) }),
        ]),
        h('td', { class: 'a3d-ellipsis', text: item.reason || '' }),
      ]));
    });
    table.appendChild(tbody);
    container.appendChild(table);
    return container;
  }

  function selectField(testid, label, options, value) {
    var select = h('select', { class: 'a3d-input', 'data-testid': testid });
    options.forEach(function (pair) {
      var option = document.createElement('option');
      option.value = pair[0];
      option.textContent = pair[1];
      if (String(pair[0]) === String(value)) option.selected = true;
      select.appendChild(option);
    });
    select.value = String(value === undefined || value === null ? '' : value);
    var wrapper = h('label', { class: 'a3d-filter' }, [h('span', { text: label }), select]);
    return { wrapper: wrapper, input: select };
  }

  function currentFilter() {
    var account = state.filters.account || '';
    var filter = {
      from: state.filters.from || '',
      to: state.filters.to || '',
      module: state.filters.module || '',
      status: state.filters.status || '',
      accountId: '',
    };
    if (account === '__current__') {
      filter.accountIds = scopeAccounts();
      if (!filter.accountIds.length) filter.accountIds = ['__no-account__'];
    } else if (account) {
      filter.accountId = account;
    }
    return filter;
  }

  var MODULE_LABELS = {
    ek: '二课',
    club: '俱乐部',
    unirun: '校园跑',
    legacy: '历史动作',
    system: '系统',
    unknown: '未知模块',
  };

  var ACTION_LABELS = {
    apply: '报名',
    join: '报名',
    signin: '签到',
    'sign-in': '签到',
    checkin: '签到',
    'check-in': '签到',
    signout: '签退',
    'sign-out': '签退',
    checkout: '签退',
    'check-out': '签退',
    run: '跑步',
    autorun: '跑步',
    sign: '签到',
    legacy: '历史动作',
    preview: '预览',
  };

  function moduleLabel(module) {
    var key = text(module).toLowerCase();
    return MODULE_LABELS[key] || text(module) || '未知模块';
  }

  function actionLabel(action) {
    var key = text(action).toLowerCase();
    return ACTION_LABELS[key] || text(action) || '—';
  }

  function statusLabel(status) {
    return {
      success: '上游已接受', failed: '失败', unknown: '结果未知',
      'waiting-material': '等待材料', 'not-yet': '未开始', blocked: '阻断',
      skipped: '跳过', retry: '重试中', legacy: '历史动作',
    }[status] || status;
  }

  function statusKind(status) {
    if (status === 'success') return 'ok';
    if (status === 'failed' || status === 'unknown' || status === 'blocked') return 'error';
    if (status === 'legacy') return 'unknown';
    return 'warn';
  }

  // ───────────────────────── 对外 ─────────────────────────

  function open(options) {
    var opts = options || {};
    ensureMounted();
    state.engine = opts.engine || state.engine;
    state.store = opts.store || state.store;
    if (opts.accounts && typeof opts.accounts === 'object') {
      // 仅作为 engine.getProfiles() 不可用时的回退展示
      state.accountsHint = {
        ekAccount: opts.accounts.ekAccount ? String(opts.accounts.ekAccount) : '',
        unirunAccountId: opts.accounts.unirunAccountId ? String(opts.accounts.unirunAccountId) : '',
      };
    }
    state.accountId = opts.accountId ? String(opts.accountId) : state.accountId;
    state.tab = opts.tab || state.tab || 'overview';
    if (!state.filters.account) state.filters.account = '__current__';
    state.message = '';
    el.root.style.display = 'flex';
    render();
    return root.Auto3CTDashboard;
  }

  function close() {
    if (!el.root) return;
    el.root.style.display = 'none';
  }

  function isOpen() {
    return Boolean(el.root && el.root.style.display !== 'none');
  }

  function refreshScores(force) {
    var engine = state.engine;
    if (!engine || typeof engine.refreshScores !== 'function') {
      setMessage('warn', '当前 engine 没有官方成绩刷新接口。');
      render();
      return Promise.resolve(null);
    }
    setMessage('info', '正在刷新官方成绩…');
    render();
    return Promise.resolve(engine.refreshScores({ force: Boolean(force) }))
      .then(function (result) {
        if (!result || !result.ok) {
          setMessage('error', '刷新失败（保留旧值）：' + ((result && result.reason) || '未知原因'));
        } else if (result.stale) {
          setMessage('warn', '已刷新，但数据可能过期（stale），保留展示。');
        } else {
          setMessage('info', '官方成绩已刷新。');
        }
        render();
        return result;
      })
      .catch(function (e) {
        setMessage('error', '刷新失败（保留旧值）：' + (e && e.message ? e.message : String(e)));
        render();
        return null;
      });
  }

  function refresh() {
    if (isOpen()) render();
  }

  root.Auto3CTDashboard = {
    open: open,
    close: close,
    isOpen: isOpen,
    refresh: refresh,
    refreshScores: refreshScores,
  };
})(typeof window !== 'undefined' ? window : this);
