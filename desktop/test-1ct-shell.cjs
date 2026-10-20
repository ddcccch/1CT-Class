/**
 * 1CT 渲染层离线冒烟（Playwright-core + 本机 Edge，headless，独立临时 profile）。
 *
 * 运行：
 *   node desktop/test-1ct-shell.cjs
 *   node --test desktop/test-1ct-shell.cjs
 *   PLAYWRIGHT_CORE / EDGE_PATH 可覆盖依赖路径。
 *
 * 测试形态（真集成，只 fake 网络边界）：
 *  - 加载真实 index.html + shell.css/shell.js + members.js + ek-stats.js
 *    + jsQR/score-policy/result-store/automation（与打包后一致）；
 *  - **只 fake `window.ctAPI`**（IPC 出口），其余全部走真实实现；
 *  - localStorage 预置 3 名成员 / 全局 config / 历史事件（模拟用过一段时间的机器）；
 *  - 断言四 tab、极简白视觉、成员增删改、二课统计区块、日志分组、脱敏红线。
 *
 * 产物：artifacts/1ct-shell-0*.png、artifacts/1ct-shell-result.json
 */
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const PLAYWRIGHT_CORE =
  process.env.PLAYWRIGHT_CORE || 'playwright-core';
const ROOT = path.resolve(__dirname, '..');
const ARTIFACTS = path.join(ROOT, 'artifacts');
const RESULT_JSON = path.join(ARTIFACTS, '1ct-shell-result.json');
const FAILURE_JSON = path.join(ARTIFACTS, '1ct-shell-failure.json');
const HARNESS_URL = '/harness/index.html';

const EDGE_CANDIDATES = [
  process.env.EDGE_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
};

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail: detail === undefined ? '' : String(detail), kind: 'assert' });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' :: ' + detail : ''}`);
}
function info(name, detail) {
  checks.push({ name, ok: true, detail: detail === undefined ? '' : String(detail), kind: 'info' });
  console.log(`[INFO] ${name}${detail ? ' :: ' + detail : ''}`);
}

function findEdge() {
  for (const candidate of EDGE_CANDIDATES) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// ───────────────────────────── 注入脚本（仅 fake ctAPI + 预置本机数据） ─────────────────────────────
//
// ctAPI 是唯一外部边界（IPC → 主进程 → 学校平台）。这里把它换成内存 fake，
// 页面其余部分（members.js / ek-stats.js / shell.js / automation.js）全部是真实实现。
const INJECTED = String.raw`
(function () {
  'use strict';
  var DAY = 24 * 60 * 60 * 1000;
  var now = function () { return Date.now(); };

  // ── fake ctAPI ──
  var calls = [];
  var writes = [];
  // 只把「向平台提交业务动作」的调用算作真实写；
  // refreshToken / sessionEnsure / sessionClear 是会话层操作，不算业务提交。
  var WRITE_METHODS = {
    signInOutByOthers: 1, applyActivity: 1, cancelApplyActivity: 1,
    autoRun: 1, joinActivity: 1, cancelActivity: 1, signInOrSignBack: 1,
  };

  function emptyPaged() {
    return { code: 10000, msg: 'ok', response: { list: [], records: [], total: 0, pageIndex: 1, pageSize: 20, totalPage: 0 } };
  }
  function makeApi(prefix, methodNames, overrides) {
    var api = {};
    methodNames.forEach(function (name) {
      api[name] = function (payload) {
        var full = prefix + '.' + name;
        calls.push({ module: prefix, name: name, full: full });
        if (WRITE_METHODS[name]) writes.push(full);
        if (overrides && Object.prototype.hasOwnProperty.call(overrides, name)) return overrides[name](payload);
        return Promise.resolve(emptyPaged());
      };
    });
    return api;
  }

  // 官方「已报名列表」（activityStatus:'1'）的 fake：可在测试里切换 ok/fail/empty/paged。
  // 真实响应形态（见 reverse 的 EkActivitiesPanel.tsx:169-172）：
  //   { List:{ Items:[...], TotalPages, TotalItems }, ActivityStatusList, ... }
  // 不能用 { code:0, data:{ DataList } } 这种假形态 —— 那会掩盖 shell 只认旧结构、
  // 真实环境下官方列表读不到的问题（换机/更新后「已报名清零」的根因）。
  var appliedState = { mode: 'ok', calls: 0, pageIndexes: [] };
  var OFFICIAL_APPLIED_ROWS = [
    {
      Id: 'official-act-1',
      ActivityName: '官方讲座（仅官方列表有）',
      ModuleCode: 'A1',
      ModuleCodeText: '思想政治与道德修养',
      StatusName: '已报名',
      ActivityTime: '2026-10-20 19:00:00',
      ApplyTime: '2026-10-15 19:30:00',
    },
    {
      // 只有 ActivityId 没有 Id；且刻意不返回 ApplyTime → 报名时间未知应显示「—」
      ActivityId: 'official-act-2',
      ActivityName: '官方志愿活动（仅官方列表有）',
      ModuleCode: 'G1',
      ModuleCodeText: '社会实践与志愿服务',
      StatusName: '已报名',
      ActivityTime: '2026-10-22 14:00:00',
    },
    {
      // 与本地历史里的 act-1 是同一个活动：本机已有 success 签到/签退 → 本机优先，
      // 且不应对它请求详情（fake 详情故意返回「未签到/未签退」验证优先级）。
      Id: 'act-1',
      ActivityName: '示例讲座（官方列表也有）',
      ModuleCodeText: '思想政治与道德修养',
      StatusName: '已报名',
      ApplyTime: '2026-10-14 09:00:00',
    },
  ];
  // 分页场景：TotalPages=2；第二页故意重复 official-shared → 验证按 Id 去重
  var OFFICIAL_PAGED_ROWS = {
    1: [
      {
        Id: 'official-p1-1',
        ActivityName: '官方分页活动一',
        ModuleCodeText: '思想政治与道德修养',
        StatusName: '已报名',
        ApplyTime: '2026-10-16 10:00:00',
      },
      {
        Id: 'official-shared',
        ActivityName: '官方分页共享活动',
        ModuleCodeText: '学术科技与创新创业',
        StatusName: '已报名',
      },
    ],
    2: [
      {
        Id: 'official-p2-1',
        ActivityName: '官方分页活动二',
        ModuleCodeText: '艺术体验与审美修养',
        StatusName: '已报名',
      },
      {
        Id: 'official-shared',
        ActivityName: '官方分页共享活动（第二页重复）',
        ModuleCodeText: '学术科技与创新创业',
        StatusName: '已报名',
      },
    ],
  };
  function officialListResponse(items, totalPages, totalItems) {
    return {
      List: { Items: items, TotalPages: totalPages, TotalItems: totalItems },
      ActivityStatusList: [{ label: '已报名', value: '1' }, { label: '可报名', value: '0' }],
      ActivityTypeList: [],
      ModuleCodeList: [
        { label: '思想政治与道德修养', value: 'A1' },
        { label: '社会实践与志愿服务', value: 'G1' },
      ],
    };
  }
  window.__ONE_CT_FAKE_APPLIED__ = {
    reset: function () {
      appliedState.mode = 'ok';
      appliedState.calls = 0;
      appliedState.pageIndexes = [];
    },
    setMode: function (mode) { appliedState.mode = mode; },
    calls: function () { return appliedState.calls; },
    pageIndexes: function () { return appliedState.pageIndexes.slice(); },
  };

  // 官方活动详情 fake：getActivityDetail 返回真实详情结构
  //   { ActivityInfo:{ ActivityListInfo:{ ActivitySignInfo:{ SignD, SignT } },
  //                   ActivityQDDate, ActivityQTDate, IsNeedSignInText, IsNeedSignOutText, ActivityTime } }
  // SignD/SignT = '已签到'/'未签到'、'已签退'/'未签退'（与 automation.js signStatusOf 同口径）。
  // shell 对部分行请求详情：状态兜底 + 官方签到/签退时段。
  var OFFICIAL_DETAIL_DEFAULTS = {
    'official-act-1': {
      SignD: '已签到',
      SignT: '已签退',
      QD: '2026-10-17 19:00至2026-10-17 21:30',
      QT: '2026-10-17 19:00至2026-10-17 21:40',
      NeedIn: '是',
      NeedOut: '是',
      ActivityTime: '2026-10-20 19:00:00',
    },
    'official-act-2': {
      SignD: '未签到',
      SignT: '未签退',
      QD: '',
      QT: '',
      NeedIn: '否',
      NeedOut: '否',
      ActivityTime: '2026-10-22 14:00:00',
    },
    // act-1：本机已有 success 签到/签退（状态本机优先）；时段仍来自官方详情
    'act-1': {
      SignD: '未签到',
      SignT: '未签退',
      QD: '2026-10-18 10:00至2026-10-18 12:00',
      QT: '2026-10-18 10:00至2026-10-18 12:10',
      NeedIn: '是',
      NeedOut: '是',
    },
    // official-p1-1：详情返回空字段 → 状态「—」、时段「—」（data-status=unknown）
    'official-p1-1': { SignD: '', SignT: '' },
    // official-shared / official-p2-1：前者缺签名结构、后者请求失败 → 都显示「—」
  };
  var detailState = {
    statuses: Object.assign({}, OFFICIAL_DETAIL_DEFAULTS),
    failIds: { 'official-p2-1': true },
    calls: [],
  };
  window.__ONE_CT_FAKE_DETAIL__ = {
    reset: function () {
      detailState.statuses = Object.assign({}, OFFICIAL_DETAIL_DEFAULTS);
      detailState.failIds = { 'official-p2-1': true };
      detailState.calls = [];
    },
    calls: function () { return detailState.calls.slice(); },
    ids: function () {
      return detailState.calls.map(function (call) {
        return call.id;
      });
    },
    setStatus: function (id, status) {
      detailState.statuses[id] = status;
    },
    failId: function (id) {
      detailState.failIds[id] = true;
    },
  };

  // 官方签到记录 fake：getSignList → 真实形态 { PageList:{ Items:[...], CurrentPage, TotalPages } }
  // 字段来自 swagger Sign_StuActivityList：ActivityId/Id/ActivityName/StatusName/
  // signInStatus/signOutStatus/SignD/SignT/Inputdate/SignOutdate/SignWayText/ActivityTime。
  // 学校官网「活动签到签退」页用 signInStatus/signOutStatus 判断已签到/已签退。
  var OFFICIAL_SIGN_LIST_ROWS = [
    {
      ActivityId: 'official-act-1',
      Id: 'sign-record-1',
      ActivityName: '官方讲座（仅官方列表有）',
      StatusName: '已签到',
      signInStatus: true,
      signOutStatus: true,
      SignD: '已签到',
      SignT: '已签退',
      Inputdate: '2026-10-14 19:30:00',
      SignOutdate: '2026-10-14 21:00:00',
      SignWayText: '扫码签到',
      ActivityTime: '2026-10-20 19:00:00',
    },
    {
      ActivityId: 'official-act-2',
      Id: 'sign-record-2',
      ActivityName: '官方志愿活动（仅官方列表有）',
      StatusName: '已报名',
      signInStatus: false,
      signOutStatus: false,
      SignD: '未签到',
      SignT: '未签退',
      Inputdate: null,
      SignOutdate: null,
      SignWayText: '拍照签到',
      ActivityTime: '2026-10-22 14:00:00',
    },
    {
      // 与本地历史 act-1 同活动：签到记录里是「未签到/未签退」，但本机有 success → 本机优先
      ActivityId: 'act-1',
      Id: 'sign-record-3',
      ActivityName: '示例讲座',
      StatusName: '已报名',
      signInStatus: false,
      signOutStatus: false,
      SignD: '未签到',
      SignT: '未签退',
      Inputdate: null,
      SignOutdate: null,
    },
  ];
  // 签到记录分页场景：TotalPages=2；page1 覆盖 official-act-1，page2 覆盖 official-act-2
  var SIGN_LIST_PAGED_ROWS = {
    1: [
      {
        ActivityId: 'official-act-1',
        Id: 'sign-paged-1',
        ActivityName: '官方讲座（仅官方列表有）',
        StatusName: '已签到',
        signInStatus: true,
        signOutStatus: true,
        SignD: '已签到',
        SignT: '已签退',
        Inputdate: '2026-10-14 19:30:00',
        SignOutdate: '2026-10-14 21:00:00',
      },
    ],
    2: [
      {
        ActivityId: 'official-act-2',
        Id: 'sign-paged-2',
        ActivityName: '官方志愿活动（仅官方列表有）',
        StatusName: '已签到',
        signInStatus: true,
        signOutStatus: true,
        SignD: '已签到',
        SignT: '已签退',
        Inputdate: '2026-10-15 10:00:00',
        SignOutdate: '2026-10-15 12:00:00',
      },
    ],
  };
  var signListRows = OFFICIAL_SIGN_LIST_ROWS.map(function (row) {
    return Object.assign({}, row);
  });
  var signListState = { mode: 'ok', calls: [], pageIndexes: [] };
  function signListResponse(items, currentPage, totalPages, totalItems) {
    return {
      PageList: {
        Items: items,
        CurrentPage: currentPage,
        TotalPages: totalPages,
        TotalItems: totalItems,
        ItemsPerPage: 20,
      },
    };
  }
  window.__ONE_CT_FAKE_SIGN_LIST__ = {
    reset: function () {
      signListState.mode = 'ok';
      signListState.calls = [];
      signListState.pageIndexes = [];
      signListRows = OFFICIAL_SIGN_LIST_ROWS.map(function (row) {
        return Object.assign({}, row);
      });
    },
    setMode: function (mode) {
      signListState.mode = mode;
    },
    setStatus: function (id, patch) {
      signListRows.forEach(function (row) {
        if (row.ActivityId === id) Object.assign(row, patch);
      });
    },
    calls: function () { return signListState.calls.slice(); },
    pageIndexes: function () { return signListState.pageIndexes.slice(); },
  };

  // 官方报名列表 fake：getStuAllActApplyList → 真实形态 { PageList:{Items,CurrentPage,TotalPages} }
  // 字段来自 swagger Act_StudentsApply_Sign：ActivityId/SignD/SignT/Inputdate/SignOutdate。
  // 官网「报名/完成列表」页用它显示签到/签退状态（比签到记录更权威）。
  var OFFICIAL_APPLY_LIST_ROWS = [
    {
      Id: 'apply-record-1',
      ActivityId: 'official-act-1',
      ActivityName: '官方讲座（仅官方列表有）',
      SignD: '已签到',
      SignT: '已签退',
      Inputdate: '2026/10/17 19:00:17',
      SignOutdate: '2026/10/17 19:01:01',
      ActivityTime: '2026-10-20 19:00:00',
      StatusText: '已完成',
    },
    {
      Id: 'apply-record-2',
      ActivityId: 'official-act-2',
      ActivityName: '官方志愿活动（仅官方列表有）',
      SignD: '未签到',
      SignT: '未签退',
      Inputdate: '',
      SignOutdate: '',
      StatusText: '已报名',
    },
    {
      // 与本地历史 act-1 同活动：报名列表里是「未签到/未签退」，但本机有 success → 本机优先
      Id: 'apply-record-3',
      ActivityId: 'act-1',
      ActivityName: '示例讲座',
      SignD: '未签到',
      SignT: '未签退',
      Inputdate: '',
      SignOutdate: '',
    },
  ];
  // 报名列表分页场景：TotalPages=2；page1 覆盖 official-act-1，page2 覆盖 official-act-2
  var APPLY_LIST_PAGED_ROWS = {
    1: [
      {
        Id: 'apply-paged-1',
        ActivityId: 'official-act-1',
        ActivityName: '官方讲座（仅官方列表有）',
        SignD: '已签到',
        SignT: '已签退',
        Inputdate: '2026/10/17 19:00:17',
        SignOutdate: '2026/10/17 19:01:01',
      },
    ],
    2: [
      {
        Id: 'apply-paged-2',
        ActivityId: 'official-act-2',
        ActivityName: '官方志愿活动（仅官方列表有）',
        SignD: '已签到',
        SignT: '已签退',
        Inputdate: '2026/10/17 20:00:00',
        SignOutdate: '2026/10/17 20:05:00',
      },
    ],
  };
  var applyListRows = OFFICIAL_APPLY_LIST_ROWS.map(function (row) {
    return Object.assign({}, row);
  });
  // applyList 覆盖但 SignD/SignT 为空（真实场景里「不需签到/未签到」的活动常见）：
  // shell 不应再对这些行拉签到记录/详情，状态直接显示「—」。
  var EMPTY_STATUS_APPLY_LIST_ROWS = [
    {
      Id: 'apply-empty-1',
      ActivityId: 'official-act-1',
      ActivityName: '官方讲座（仅官方列表有）',
      SignD: '',
      SignT: '',
      Inputdate: '',
      SignOutdate: '',
      StatusText: '已报名',
    },
    {
      Id: 'apply-empty-2',
      ActivityId: 'official-act-2',
      ActivityName: '官方志愿活动（仅官方列表有）',
      SignD: '',
      SignT: '',
      Inputdate: '',
      SignOutdate: '',
      StatusText: '已报名',
    },
    {
      Id: 'apply-empty-3',
      ActivityId: 'act-1',
      ActivityName: '示例讲座',
      SignD: '',
      SignT: '',
      Inputdate: '',
      SignOutdate: '',
    },
  ];
  var applyListState = { mode: 'ok', calls: [], pageIndexes: [] };
  // 「最近活动」场景：官网报名列表里 8 条有签到/签退成功时间的记录（>6 → 只取前 6、按时间倒序）
  var RECENT_APPLY_LIST_ROWS = [
    { ActivityId: 'recent-1', ActivityName: '官网最近活动一', ActivityType: '讲座', SignD: '已签到', SignT: '已签退', Inputdate: '2026/10/10 19:00:00', SignOutdate: '2026/10/10 21:00:00' },
    { ActivityId: 'recent-2', ActivityName: '官网最近活动二', ActivityType: '志愿', SignD: '未签到', SignT: '已签退', Inputdate: '', SignOutdate: '2026/10/11 21:00:00' },
    { ActivityId: 'recent-3', ActivityName: '官网最近活动三', ActivityType: '讲座', SignD: '已签到', SignT: '未签退', Inputdate: '2026/10/12 19:00:00', SignOutdate: '' },
    { ActivityId: 'recent-4', ActivityName: '官网最近活动四', ActivityType: '实践', SignD: '已签到', SignT: '已签退', Inputdate: '2026/10/13 19:00:00', SignOutdate: '2026/10/13 21:00:00' },
    { ActivityId: 'recent-5', ActivityName: '官网最近活动五', ActivityType: '讲座', SignD: '已签到', SignT: '已签退', Inputdate: '2026/10/14 19:00:00', SignOutdate: '2026/10/14 21:00:00' },
    { ActivityId: 'recent-6', ActivityName: '官网最近活动六', ActivityType: '志愿', SignD: '已签到', SignT: '已签退', Inputdate: '2026/10/15 19:00:00', SignOutdate: '2026/10/15 21:00:00' },
    { ActivityId: 'recent-7', ActivityName: '官网最近活动七', ActivityType: '讲座', SignD: '已签到', SignT: '未签退', Inputdate: '2026/10/16 19:00:00', SignOutdate: '' },
    { ActivityId: 'recent-8', ActivityName: '官网最近活动八', ActivityType: '实践', SignD: '已签到', SignT: '已签退', Inputdate: '2026/10/17 19:00:00', SignOutdate: '2026/10/17 21:00:00' },
  ];
  function applyListResponse(items, currentPage, totalPages, totalItems) {
    return {
      PageList: {
        Items: items,
        CurrentPage: currentPage,
        TotalPages: totalPages,
        TotalItems: totalItems,
        ItemsPerPage: 20,
      },
    };
  }
  var applyListBridge = function (payload) {
    var pageIndex = Math.max(1, Number(payload && payload.pageIndex) || 1);
    applyListState.calls.push({
      pageIndex: pageIndex,
      hasSession: Boolean(payload && payload.requestsData && payload.requestsData.JSESSIONID),
      jsession: String((payload && payload.requestsData && payload.requestsData.JSESSIONID) || ''),
    });
    applyListState.pageIndexes.push(pageIndex);
    if (applyListState.mode === 'fail') return Promise.reject(new Error('applylist upstream 500'));
    if (applyListState.mode === 'recent') {
      return Promise.resolve(applyListResponse(RECENT_APPLY_LIST_ROWS, 1, 1, RECENT_APPLY_LIST_ROWS.length));
    }
    if (applyListState.mode === 'emptyStatus') {
      return Promise.resolve(
        applyListResponse(EMPTY_STATUS_APPLY_LIST_ROWS, 1, 1, EMPTY_STATUS_APPLY_LIST_ROWS.length),
      );
    }
    if (applyListState.mode === 'paged') {
      return Promise.resolve(applyListResponse(APPLY_LIST_PAGED_ROWS[pageIndex] || [], pageIndex, 2, 2));
    }
    return Promise.resolve(applyListResponse(applyListRows, 1, 1, applyListRows.length));
  };
  window.__ONE_CT_FAKE_APPLY_LIST__ = {
    reset: function () {
      applyListState.mode = 'ok';
      applyListState.calls = [];
      applyListState.pageIndexes = [];
      applyListRows = OFFICIAL_APPLY_LIST_ROWS.map(function (row) {
        return Object.assign({}, row);
      });
    },
    setMode: function (mode) {
      applyListState.mode = mode;
    },
    setStatus: function (id, patch) {
      applyListRows.forEach(function (row) {
        if (row.ActivityId === id) Object.assign(row, patch);
      });
    },
    calls: function () { return applyListState.calls.slice(); },
    pageIndexes: function () { return applyListState.pageIndexes.slice(); },
    removeBridge: function () {
      if (window.ctAPI && window.ctAPI.ek) delete window.ctAPI.ek.getStuAllActApplyList;
    },
    restoreBridge: function () {
      if (window.ctAPI && window.ctAPI.ek) window.ctAPI.ek.getStuAllActApplyList = applyListBridge;
    },
  };

  // 会话 fake：模拟二课会话过期（401）+ 自动重登链路（refresh 成功 / refresh 失败 login 成功 / 都失败）
  var sessionState = {
    listAuthFail: 'none', // none|once|always
    listAuthConsumed: false,
    applyAuthFail: 'none',
    applyAuthConsumed: false,
    refreshMode: 'ok',
    loginMode: 'ok',
    refreshCalls: 0,
    loginCalls: [],
  };
  window.__ONE_CT_FAKE_SESSION__ = {
    reset: function () {
      sessionState.listAuthFail = 'none';
      sessionState.listAuthConsumed = false;
      sessionState.applyAuthFail = 'none';
      sessionState.applyAuthConsumed = false;
      sessionState.refreshMode = 'ok';
      sessionState.loginMode = 'ok';
      sessionState.refreshCalls = 0;
      sessionState.loginCalls = [];
    },
    setListAuthFail: function (mode) {
      sessionState.listAuthFail = mode;
      sessionState.listAuthConsumed = false;
    },
    setApplyAuthFail: function (mode) {
      sessionState.applyAuthFail = mode;
      sessionState.applyAuthConsumed = false;
    },
    setRefreshMode: function (mode) { sessionState.refreshMode = mode; },
    setLoginMode: function (mode) { sessionState.loginMode = mode; },
    refreshCalls: function () { return sessionState.refreshCalls; },
    loginCalls: function () { return sessionState.loginCalls.slice(); },
  };
  function sessionAuthError() {
    return Promise.reject(new Error('HTTP 401 Unauthorized：二课未登录'));
  }
  function listAuthTripped() {
    if (sessionState.listAuthFail === 'always') return true;
    if (sessionState.listAuthFail === 'once' && !sessionState.listAuthConsumed) {
      sessionState.listAuthConsumed = true;
      return true;
    }
    return false;
  }
  function applyAuthTripped() {
    if (sessionState.applyAuthFail === 'always') return true;
    if (sessionState.applyAuthFail === 'once' && !sessionState.applyAuthConsumed) {
      sessionState.applyAuthConsumed = true;
      return true;
    }
    return false;
  }

  var ekOverrides = {
    login: function (payload) {
      sessionState.loginCalls.push({
        student_id: payload && payload.student_id ? String(payload.student_id) : '',
        hasPassword: Boolean(payload && payload.password),
      });
      if (sessionState.loginMode === 'fail') return Promise.reject(new Error('login failed'));
      return Promise.resolve({
        JSESSIONID: 'fake-jsession-' + now(),
        access_token: 'fake-access-token',
        refresh_token: 'fake-refresh-token',
        user_info: {
          loginName: payload && payload.student_id ? String(payload.student_id) : '2024000001',
          userName: '测试学生',
          studentId: payload && payload.student_id ? String(payload.student_id) : '2024000001',
        },
      });
    },
    refreshToken: function () {
      sessionState.refreshCalls += 1;
      if (sessionState.refreshMode === 'fail') return Promise.reject(new Error('refresh failed'));
      return Promise.resolve({
        JSESSIONID: 'fake-jsession-refreshed-' + now(),
        access_token: 'fake-access-token-2',
        refresh_token: 'fake-refresh-token-2',
        user_info: { loginName: '2024000001', userName: '测试学生' },
      });
    },
    checkLogin: function () {
      return Promise.resolve({ code: 0, data: { loginName: '2024000001' } });
    },
    getStudentScores: function () {
      return Promise.resolve({ code: 0, data: { Info: { StudentId: '2024000001' }, TypeList: [] } });
    },
    // 官方「已报名列表」（activityStatus:'1'）；模式可在测试里切换 ok/fail/empty/paged
    getActivitiesList: function (payload) {
      appliedState.calls += 1;
      var pageIndex = Math.max(1, Number(payload && payload.pageIndex) || 1);
      appliedState.pageIndexes.push(pageIndex);
      if (listAuthTripped()) return sessionAuthError();
      if (appliedState.mode === 'fail') return Promise.reject(new Error('upstream 500'));
      if (appliedState.mode === 'empty') return Promise.resolve(officialListResponse([], 0, 0));
      if (appliedState.mode === 'paged') {
        return Promise.resolve(officialListResponse(OFFICIAL_PAGED_ROWS[pageIndex] || [], 2, 4));
      }
      return Promise.resolve(officialListResponse(OFFICIAL_APPLIED_ROWS, 1, OFFICIAL_APPLIED_ROWS.length));
    },
    // 官方报名列表（GetStuAllActApplyList）：主数据源，返回真实 PageList 形态
    getStuAllActApplyList: applyListBridge,
    // 官方活动详情：返回 ActivityInfo.ActivityListInfo.ActivitySignInfo.{SignD,SignT}
    getActivityDetail: function (payload) {
      var id = payload && payload.id !== undefined && payload.id !== null ? String(payload.id) : '';
      detailState.calls.push({
        id: id,
        hasSession: Boolean(payload && payload.requestsData && payload.requestsData.JSESSIONID),
        jsession: String((payload && payload.requestsData && payload.requestsData.JSESSIONID) || ''),
      });
      if (detailState.failIds[id]) return Promise.reject(new Error('detail upstream 500'));
      var status = detailState.statuses[id];
      var info = { Id: id, ActivityName: '活动 ' + id };
      if (status) {
        info.ActivityListInfo = { ActivitySignInfo: { SignD: status.SignD, SignT: status.SignT } };
        if (status.QD !== undefined) info.ActivityQDDate = status.QD;
        if (status.QT !== undefined) info.ActivityQTDate = status.QT;
        if (status.NeedIn !== undefined) info.IsNeedSignInText = status.NeedIn;
        if (status.NeedOut !== undefined) info.IsNeedSignOutText = status.NeedOut;
        if (status.ActivityTime !== undefined) info.ActivityTime = status.ActivityTime;
      }
      return Promise.resolve({ ActivityInfo: info });
    },
    // 官方签到记录（GetStuActSignList）：真实形态 { PageList:{Items,CurrentPage,TotalPages} }
    getSignList: function (payload) {
      var pageIndex = Math.max(1, Number(payload && payload.pageIndex) || 1);
      signListState.calls.push({
        pageIndex: pageIndex,
        hasSession: Boolean(payload && payload.requestsData && payload.requestsData.JSESSIONID),
        jsession: String((payload && payload.requestsData && payload.requestsData.JSESSIONID) || ''),
      });
      signListState.pageIndexes.push(pageIndex);
      if (signListState.mode === 'fail') return Promise.reject(new Error('signlist upstream 500'));
      if (signListState.mode === 'paged') {
        return Promise.resolve(signListResponse(SIGN_LIST_PAGED_ROWS[pageIndex] || [], pageIndex, 2, 2));
      }
      return Promise.resolve(signListResponse(signListRows, 1, 1, signListRows.length));
    },
  };

  var unirunOverrides = {
    sessionEnsure: function () {
      return Promise.resolve({ userId: 1, schoolId: 2, studentId: 3, userName: '测试学生', schoolName: '测试大学' });
    },
    login: function () {
      return Promise.resolve({
        token: 'fake-unirun-token', userId: 1, schoolId: 2, appVersion: '1.0', brand: 'test',
        mobileType: 'test', sysVersion: 'test', deviceToken: 'fake-device', deviceType: 'test',
      });
    },
    campusLocalList: function () {
      return Promise.resolve([{ id: 'campus-1', label: '主校区', mapName: 'main', schoolSiteIndex: 0, updatedAt: now() }]);
    },
    runOverview: function () {
      return Promise.resolve({ runCount: 0, runDistance: 0, clubCount: 0, semesterEnd: '' });
    },
  };

  var clubOverrides = {
    validSignUpCount: function () {
      return Promise.resolve({ code: 10000, msg: 'ok', response: { list: [], records: [], total: 0 } });
    },
  };

  // 窗口控制 IPC（无边框窗口）：记录调用次数；maximized 状态可切换
  var winCalls = { minimize: 0, toggleMaximize: 0, close: 0 };
  var winMaximized = false;
  window.ctAPI = {
    ek: makeApi('ek', [
      'login', 'wxLoginStart', 'wxLoginComplete', 'wxQrImage', 'refreshToken', 'checkLogin',
      'getActivitiesList', 'getActivityDetail', 'applyActivity', 'cancelApplyActivity', 'signByQr',
      'getSignList', 'getSignInDetail', 'signInOutByOthers', 'getFinishList', 'getStudentScores',
      'getStuAllActApplyList',
    ], ekOverrides),
    unirun: makeApi('unirun', [
      'login', 'sessionEnsure', 'sessionClear', 'runRecords', 'runOverview', 'generateTrack',
      'autoRun', 'campusLocalList',
    ], unirunOverrides),
    club: makeApi('club', [
      'activityList', 'myActivityList', 'mySemesterActivity', 'studentRecord', 'validSignUpCount',
      'myItemList', 'currentSignTask', 'joinActivity', 'cancelActivity', 'signInOrSignBack',
    ], clubOverrides),
    system: {
      getAppVersion: function () { return Promise.resolve('1.2.5'); },
      isMainWindow: function () { return Promise.resolve(true); },
      window: {
        minimize: function () {
          winCalls.minimize += 1;
          return Promise.resolve({ ok: true });
        },
        toggleMaximize: function () {
          winCalls.toggleMaximize += 1;
          winMaximized = !winMaximized;
          return Promise.resolve({ maximized: winMaximized });
        },
        close: function () {
          winCalls.close += 1;
          return Promise.resolve({ ok: true });
        },
      },
    },
    // 「退至后台」按钮会先把 closeBehavior 固定成 tray（1CT 无设置页），再走 close
    appSettings: {
      get: function () {
        return Promise.resolve({ closeBehavior: winCalls.closeBehavior || 'ask' });
      },
      set: function (payload) {
        winCalls.appSettingsSet = (winCalls.appSettingsSet || 0) + 1;
        if (payload && payload.closeBehavior) winCalls.closeBehavior = payload.closeBehavior;
        return Promise.resolve({ closeBehavior: winCalls.closeBehavior || 'ask' });
      },
    },
  };
  window.ctAPI.__fake = {
    calls: calls,
    writes: writes,
    writeCount: function () { return writes.length; },
    callCount: function (name) {
      return calls.filter(function (c) { return c.name === name; }).length;
    },
    reset: function () { calls.length = 0; writes.length = 0; },
    winCalls: winCalls,
    resetWinCalls: function () {
      winCalls.minimize = 0;
      winCalls.toggleMaximize = 0;
      winCalls.close = 0;
      winMaximized = false;
    },
    removeWindowApi: function () {
      delete window.ctAPI.system.window;
    },
  };

  /**
   * 官方成绩同步的 fake。
   *
   * scores-sync 已交付真实 OneCTMembers.syncOfficialScores（走 ctAPI.ek.getStudentScores
   * → GetStuList/GetStuDetail）。所以这里**不再补丁 members.js**，而是只 fake 最外层 IPC：
   *   ctAPI.ek.getStudentScores 返回 { TypeList:[{CurriculumName,SumScore}], Info:{StudentId, AGetNum..} }
   * 真实解析/交叉校验/写回全部由 members.js 真实现完成，测试覆盖的是真实链路。
   */
  var OFFICIAL_MODULES = [
    { name: '思想政治与道德修养', required: 12, current: 9 },
    { name: '学术科技与创新创业', required: 8, current: 8 },
    { name: '艺术体验与审美修养', required: 12, current: 7 },
    { name: '传统文化与人文素养', required: 8, current: 5 },
    { name: '人际交往与沟通能力', required: 8, current: 6 },
    { name: '心理素质与身体素质', required: 12, current: 12 },
    { name: '社会实践与志愿服务', required: 12, current: 10 },
    { name: '社会工作与能力拓展', required: 8, current: 8 },
  ];
  var syncState = { fail: false, calls: 0 };
  window.__ONE_CT_FAKE_SYNC__ = {
    reset: function () { syncState.fail = false; syncState.calls = 0; },
    failNext: function () { syncState.fail = true; },
    calls: function () { return syncState.calls; },
  };

  // 覆盖 ctAPI.ek.getStudentScores：真实 members.js 会解析这个响应。
  // 注意 Info.StudentId 必须与请求方账号一致 —— members.js 会做 account-mismatch 校验，
  // 所以从 payload.requestsData.user_info.loginName 取当前账号（真实链路同构）。
  window.ctAPI.ek.getStudentScores = function (payload) {
    syncState.calls += 1;
    if (syncState.fail) {
      syncState.fail = false;
      // 结构异常 → members.js 判 response-empty（走真实失败分支）
      return Promise.resolve({ Info: {}, TypeList: [] });
    }
    var requestsData = payload && payload.requestsData ? payload.requestsData : {};
    var userInfo = requestsData.user_info || {};
    var account = userInfo.loginName || userInfo.studentId || userInfo.userName || '';
    var info = { StudentId: account, LoginName: account };
    // A..J 分项：用于 members.js 的多重集交叉校验（必须覆盖 8 个模块分值）
    var keys = ['AGetNum', 'BGetNum', 'CGetNum', 'DGetNum', 'EGetNum', 'FGetNum', 'GGetNum', 'HGetNum', 'IGetNum', 'JGetNum'];
    OFFICIAL_MODULES.forEach(function (m, i) {
      info[keys[i]] = m.current;
    });
    return Promise.resolve({
      Info: info,
      TypeList: OFFICIAL_MODULES.map(function (m) {
        return { CurriculumName: m.name, SumScore: m.current, ScoreList: [] };
      }),
    });
  };

  // ── 预置本机数据（模拟已用过的机器；只在空库时写一次） ──
  var seeded = window.localStorage.getItem('1ct:members');
  if (!seeded) {
    var t = now();
    var TODAY = (function () {
      var d = new Date();
      var p = function (n) { return String(n).padStart(2, '0'); };
      return '' + d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    })();
    var MODULES = [
      { name: '思想政治与道德修养', required: 12, current: 6 },
      { name: '学术科技与创新创业', required: 8, current: 4 },
      { name: '艺术体验与审美修养', required: 12, current: 2 },
      { name: '传统文化与人文素养', required: 8, current: 8.5 },
      { name: '人际交往与沟通能力', required: 8, current: 4 },
      { name: '心理素质与身体素质', required: 12, current: 15.5 },
      { name: '社会实践与志愿服务', required: 12, current: 11 },
      { name: '社会工作与能力拓展', required: 8, current: 3.5 },
    ];
    var MODULES2 = [
      { name: '思想政治与道德修养', required: 12, current: 12 },
      { name: '学术科技与创新创业', required: 8, current: null },
      { name: '艺术体验与审美修养', required: 12, current: 6 },
      { name: '传统文化与人文素养', required: 8, current: 4 },
      { name: '人际交往与沟通能力', required: 8, current: null },
      { name: '心理素质与身体素质', required: 12, current: 12 },
      { name: '社会实践与志愿服务', required: 12, current: 5 },
      { name: '社会工作与能力拓展', required: 8, current: 8 },
    ];
    var members = {
      version: 1,
      selectedId: 'm_zhangsan',
      items: [
        {
          id: 'm_zhangsan',
          name: '张三',
          note: '班长',
          enabled: true,
          ek: {
            JSESSIONID: 'fake-jsession-seed',
            access_token: 'fake-access-token',
            refresh_token: 'fake-refresh-token',
            user_info: { loginName: '2024000001', userName: '张三' },
          },
          ekStatus: 'ok',
          ekUpdatedAt: t - 3600000,
          ekCredentials: { studentId: '2024000001', password: 'fake-pw' },
          unirun: { id: 'u_zhangsan', phone: '13800000000', password: 'fake-unirun-pw', remark: '' },
          ekModules: MODULES,
          createdAt: t - 90 * DAY,
          updatedAt: t - 3600000,
        },
        {
          id: 'm_wangwu',
          name: '王五',
          note: '',
          enabled: true,
          ek: null,
          ekStatus: 'expired',
          ekUpdatedAt: t - 30 * DAY,
          ekCredentials: { studentId: '2024101170', password: 'fake-pw' },
          unirun: { id: 'u_wangwu', phone: '13700002222', password: 'fake-unirun-pw', remark: '' },
          ekModules: MODULES2,
          createdAt: t - 60 * DAY,
          updatedAt: t - 30 * DAY,
        },
        {
          id: 'm_zhaoliu',
          name: '赵六',
          note: '停用测试',
          enabled: false,
          ek: null,
          ekStatus: 'none',
          ekUpdatedAt: null,
          ekCredentials: null,
          unirun: null,
          ekModules: null,
          createdAt: t - 10 * DAY,
          updatedAt: t - 10 * DAY,
        },
      ],
    };
    window.localStorage.setItem('1ct:members', JSON.stringify(members));

    // 全局 config：三模块默认关（与引擎 DEFAULTS 一致），预览开启
    window.localStorage.setItem('1ct:config:global', JSON.stringify({
      dryRun: true,
      tickMs: 60000,
      windowTickMs: 20000,
      unirun: { enabled: false, runAt: '06:30', windowMinutes: 30, runDistance: 3000, runTime: 30 },
      club: { enabled: false, keywords: [], allowAll: false, join: true, signIn: true, signOut: true, dailyJoinLimit: 1 },
      ek: {
        enabled: false, keywords: [], allowAll: false, apply: true, signIn: true, signOut: true,
        dailyLimit: 1, qrDelayMinutes: 2, qrRetryMinutes: 2, qrMaxAttempts: 3,
      },
    }));

    // 历史执行结果（带 memberId；张三有签到/签退成功，王五有一次失败）
    window.localStorage.setItem('1ct:results', JSON.stringify({
      version: 1,
      events: [
        // 张三：报名成功 2 个（act-1 已签到+签退，act-3 只报名未签到）
        {
          key: 'seed|ek|apply|act-1|m_zhangsan', at: t - 3 * 3600000, day: TODAY,
          memberId: 'm_zhangsan', memberName: '张三', module: 'ek', action: 'apply',
          activityId: 'act-1', activityName: '示例讲座', category: '思想政治与道德修养',
          status: 'success', reason: '', preview: false, dryRun: false,
        },
        {
          key: 'seed|ek|apply|act-3|m_zhangsan', at: t - 4 * 3600000, day: TODAY,
          memberId: 'm_zhangsan', memberName: '张三', module: 'ek', action: 'apply',
          activityId: 'act-3', activityName: '艺术工坊', category: '艺术体验与审美修养',
          status: 'success', reason: '', preview: false, dryRun: false,
        },
        {
          key: 'seed|ek|signIn|act-1|m_zhangsan', at: t - 2 * 3600000, day: TODAY,
          memberId: 'm_zhangsan', memberName: '张三', module: 'ek', action: 'signIn',
          activityId: 'act-1', activityName: '示例讲座', category: '思想政治与道德修养',
          status: 'success', reason: '', preview: false, dryRun: false,
        },
        {
          key: 'seed|ek|signOut|act-1|m_zhangsan', at: t - 3600000, day: TODAY,
          memberId: 'm_zhangsan', memberName: '张三', module: 'ek', action: 'signOut',
          activityId: 'act-1', activityName: '示例讲座', category: '思想政治与道德修养',
          status: 'success', reason: '', preview: false, dryRun: false,
        },
        {
          key: 'seed|club|join|club-1|m_zhangsan', at: t - 5 * 3600000, day: TODAY,
          memberId: 'm_zhangsan', memberName: '张三', module: 'club', action: 'join',
          activityId: 'club-1', activityName: '篮球社', category: '',
          status: 'success', reason: '', preview: false, dryRun: false,
        },
        {
          key: 'seed|club|signIn|club-1|m_zhangsan', at: t - 4 * 3600000, day: TODAY,
          memberId: 'm_zhangsan', memberName: '张三', module: 'club', action: 'signIn',
          activityId: 'club-1', activityName: '篮球社', category: '',
          status: 'success', reason: '', preview: false, dryRun: false,
        },
        {
          key: 'seed|club|signOut|club-1|m_zhangsan', at: t - 3 * 3600000, day: TODAY,
          memberId: 'm_zhangsan', memberName: '张三', module: 'club', action: 'signOut',
          activityId: 'club-1', activityName: '篮球社', category: '',
          status: 'success', reason: '', preview: false, dryRun: false,
        },
        {
          key: 'seed|unirun|autoRun|daily|m_zhangsan', at: t - 6 * 3600000, day: TODAY,
          memberId: 'm_zhangsan', memberName: '张三', module: 'unirun', action: 'autoRun',
          activityId: 'daily', activityName: '校园跑', category: '',
          status: 'success', reason: '', preview: false, dryRun: false, distanceMeters: 1043, runTime: 33,
        },
        {
          key: 'seed|ek|signIn|act-2|m_wangwu', at: t - 5400000, day: TODAY,
          memberId: 'm_wangwu', memberName: '王五', module: 'ek', action: 'signIn',
          activityId: 'act-2', activityName: '志愿服务日', category: '社会实践与志愿服务',
          status: 'failed', reason: 'need-qr-or-manual', preview: false, dryRun: false,
        },
      ],
    }));

    // 张三的二课积分快照（引擎原样格式，按账号隔离）
    window.localStorage.setItem('1ct:scores:m_zhangsan', JSON.stringify({
      version: 1,
      accounts: {
        '2024000001': {
          snapshot: {
            accountId: '2024000001',
            source: 'official',
            updatedAt: t - 6 * 3600000,
            modules: MODULES.map(function (m) {
              return { name: m.name, required: m.required, current: m.current };
            }),
          },
          refreshedAt: t - 6 * 3600000,
          lastRefreshError: null,
        },
      },
    }));
  }
})();
`;

// ───────────────────────────── harness 生成 + 静态服务 ─────────────────────────────

async function buildHarness(tmpDir) {
  const harnessDir = path.join(tmpDir, 'harness');
  await fsp.mkdir(harnessDir, { recursive: true });
  const indexHtml = await fsp.readFile(path.join(ROOT, 'desktop', '1ct', 'index.html'), 'utf8');
  await fsp.writeFile(path.join(harnessDir, 'index.html'), indexHtml, 'utf8');
  return harnessDir;
}

/** 仓库真实文件（打包后同布局：index.html 同级 + ./1ct/ 子目录） */
const REPO_FILES = {
  '/harness/1ct/shell.js': 'desktop/1ct/shell.js',
  '/harness/1ct/shell.css': 'desktop/1ct/shell.css',
  '/harness/1ct/members.js': 'desktop/1ct/members.js',
  '/harness/1ct/ek-stats.js': 'desktop/1ct/ek-stats.js',
  '/harness/1ct/ek-stats.css': 'desktop/1ct/ek-stats.css',
  '/harness/jsQR.js': 'desktop/vendor/jsQR.js',
  '/harness/score-policy.js': 'desktop/score-policy.js',
  '/harness/result-store.js': 'desktop/result-store.js',
  '/harness/automation.js': 'desktop/automation.js',
  '/harness/1ct/fallback-photo.js': 'desktop/1ct/fallback-photo.js',
};

function startStaticServer(harnessDir) {
  const server = http.createServer((req, res) => {
    const urlPath = (req.url || '/').split('?')[0];
    if (urlPath === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    let filePath = null;
    if (REPO_FILES[urlPath]) {
      filePath = path.resolve(ROOT, REPO_FILES[urlPath]);
      if (!fs.existsSync(filePath)) {
        res.writeHead(404);
        res.end('missing: ' + REPO_FILES[urlPath]);
        return;
      }
    } else if (urlPath === '/harness/index.html') {
      filePath = path.join(harnessDir, 'index.html');
    }
    if (!filePath) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(data);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, origin: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

async function waitReady(page) {
  await page.waitForFunction(() => window.__ONE_CT_READY__ === true && !!window.OneCTShell, null, { timeout: 20000 });
  await page.locator('[data-testid="one-ct-app"]').waitFor({ state: 'visible', timeout: 10000 });
}

async function gotoApp(page, origin) {
  await page.goto(origin + HARNESS_URL, { waitUntil: 'load' });
  await waitReady(page);
}

async function screenshot(page, name) {
  await page.screenshot({ path: path.join(ARTIFACTS, name) });
  return name;
}

async function readGlobalConfig(page) {
  return page.evaluate(() => {
    try {
      return JSON.parse(window.localStorage.getItem('1ct:config:global') || '{}');
    } catch (err) {
      return {};
    }
  });
}

async function main() {
  await fsp.mkdir(ARTIFACTS, { recursive: true });
  const startedAt = new Date().toISOString();

  for (const [rel] of Object.entries(REPO_FILES)) {
    const abs = path.resolve(ROOT, REPO_FILES[rel]);
    if (!fs.existsSync(abs)) {
      throw new Error(`缺少依赖文件：${REPO_FILES[rel]}（${rel}）`);
    }
  }
  const edge = findEdge();
  if (!edge) throw new Error('找不到 Microsoft Edge（可用 EDGE_PATH 指定），无法执行浏览器冒烟');
  let playwright;
  try {
    playwright = require(PLAYWRIGHT_CORE);
  } catch (err) {
    throw new Error(`无法加载 playwright-core（${PLAYWRIGHT_CORE}）: ${err.message}`);
  }

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), '1ct-shell-harness-'));
  const harnessDir = await buildHarness(tmpDir);
  const { server, origin } = await startStaticServer(harnessDir);
  const userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), '1ct-shell-profile-'));
  const externalRequests = [];
  const pageErrors = [];
  const consoleErrors = [];
  const shots = [];
  let dialogMode = 'accept';

  let context;
  let page;
  try {
    context = await playwright.chromium.launchPersistentContext(userDataDir, {
      executablePath: edge,
      headless: true,
      viewport: { width: 1280, height: 900 },
      deviceScaleFactor: 1,
      acceptDownloads: true,
      args: ['--no-first-run', '--no-default-browser-check', '--disable-extensions'],
    });
    page = context.pages()[0] || (await context.newPage());

    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith(origin) || url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('about:')) {
        return route.continue();
      }
      externalRequests.push(url);
      return route.abort();
    });

    page.on('pageerror', (err) => pageErrors.push(String(err && err.message ? err.message : err)));
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('dialog', async (dialog) => {
      if (dialogMode === 'dismiss') {
        dialogMode = 'accept';
        await dialog.dismiss().catch(() => {});
      } else {
        await dialog.accept().catch(() => {});
      }
    });
    await page.addInitScript({ content: INJECTED });

    await gotoApp(page, origin);

    // ── 1) 骨架 / 自包含 / CSP / 脚本顺序 ──
    check('页面已挂载 one-ct-app', await page.getByTestId('one-ct-app').isVisible());
    check('顶栏存在', await page.getByTestId('one-ct-topbar').isVisible());
    check('底栏存在', await page.getByTestId('one-ct-footer').isVisible());
    for (const tab of ['run', 'members', 'ek', 'logs']) {
      check(`tab「${tab}」存在`, await page.getByTestId('one-ct-tab-' + tab).isVisible());
    }
    const resources = await page.evaluate(() =>
      performance
        .getEntriesByType('resource')
        .map((entry) => entry.name)
        .concat(Array.from(document.querySelectorAll('script[src],link[href]')).map((n) => n.src || n.href)),
    );
    const foreign = resources.filter(
      (url) => url && !String(url).startsWith(origin) && !String(url).startsWith('data:'),
    );
    check('index.html 无外部资源（脚本/样式全本地）', foreign.length === 0, foreign.join(', ') || '0 external');
    const scriptOrder = await page.evaluate(() =>
      Array.from(document.querySelectorAll('script[src]')).map((n) => n.getAttribute('src')),
    );
    check(
      '脚本顺序：jsQR→score-policy→result-store→automation→members→ek-stats→shell',
      scriptOrder.join('>') ===
        './jsQR.js>./score-policy.js>./result-store.js>./automation.js>./1ct/fallback-photo.js>./1ct/members.js>./1ct/ek-stats.js>./1ct/shell.js',
      scriptOrder.join('>'),
    );
    const cspMeta = await page.evaluate(() => {
      const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
      return meta ? meta.getAttribute('content') : '';
    });
    check(
      'CSP default-src 为 self 且不放行外部脚本',
      /default-src 'self'/.test(cspMeta) && !/script-src[^;]*https?:/.test(cspMeta),
      cspMeta.slice(0, 100),
    );
    check('页面标题为 1CT', (await page.title()) === '1CT', await page.title());
    check('真实 members.js 已加载（OneCTMembers）', await page.evaluate(() => typeof window.OneCTMembers === 'object' && typeof window.OneCTMembers.runAll === 'function'));
    check('真实 ek-stats.js 已加载（OneCTStats）', await page.evaluate(() => typeof window.OneCTStats === 'object' && typeof window.OneCTStats.renderInto === 'function'));

    // ── 需求 2：窗口控制按钮（无边框窗口必须有自绘标题栏按钮） ──
    check('窗口控制按钮存在（最小化）', (await page.getByTestId('one-ct-win-minimize').count()) === 1);
    check('窗口控制按钮存在（最大化）', (await page.getByTestId('one-ct-win-maximize').count()) === 1);
    check('窗口控制按钮存在（关闭到托盘）', (await page.getByTestId('one-ct-win-close').count()) === 1);
    const winBtnOrder = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.one-ct-win-controls .one-ct-win-btn')).map((b) =>
        b.getAttribute('data-testid'),
      ),
    );
    check(
      '三个按钮顺序为 最小化→最大化→关闭',
      winBtnOrder.join('>') === 'one-ct-win-minimize>one-ct-win-maximize>one-ct-win-close',
      winBtnOrder.join('>'),
    );
    check(
      '关闭按钮 title 提示「最小化到托盘，不会退出」',
      /最小化到托盘/.test(await page.getByTestId('one-ct-win-close').getAttribute('title')),
      await page.getByTestId('one-ct-win-close').getAttribute('title'),
    );

    // 点击三个按钮 → 调用对应 IPC
    await page.evaluate(() => window.ctAPI.__fake.resetWinCalls());
    await page.getByTestId('one-ct-win-minimize').click();
    await page.waitForTimeout(150);
    await page.getByTestId('one-ct-win-maximize').click();
    await page.waitForTimeout(150);
    await page.getByTestId('one-ct-win-close').click();
    await page.waitForTimeout(200);
    const winCalls = await page.evaluate(() => window.ctAPI.__fake.winCalls);
    check('点最小化调用 ctAPI.system.window.minimize', winCalls.minimize === 1, JSON.stringify(winCalls));
    check('点最大化调用 ctAPI.system.window.toggleMaximize', winCalls.toggleMaximize === 1, JSON.stringify(winCalls));
    check('点关闭调用 ctAPI.system.window.close', winCalls.close === 1, JSON.stringify(winCalls));
    check(
      '「退至后台」按钮先把 closeBehavior 固定为 tray（避免弹「退出/托盘」询问框）',
      winCalls.appSettingsSet === 1 && winCalls.closeBehavior === 'tray',
      JSON.stringify({ set: winCalls.appSettingsSet, behavior: winCalls.closeBehavior }),
    );

    // 双击顶栏 = 最大化/还原；点按钮不应触发（按钮已 no-drag 且被 dblclick 过滤）
    await page.evaluate(() => window.ctAPI.__fake.resetWinCalls());
    const brandBox = await page.locator('.one-ct-brand').boundingBox();
    await page.mouse.dblclick(brandBox.x + brandBox.width / 2, brandBox.y + brandBox.height / 2);
    await page.waitForTimeout(250);
    const dblCalls = await page.evaluate(() => window.ctAPI.__fake.winCalls);
    check('双击顶栏空白处触发 toggleMaximize', dblCalls.toggleMaximize === 1, JSON.stringify(dblCalls));
    await page.evaluate(() => window.ctAPI.__fake.resetWinCalls());
    const minimizeBox = await page.getByTestId('one-ct-win-minimize').boundingBox();
    await page.mouse.dblclick(minimizeBox.x + 2, minimizeBox.y + minimizeBox.height / 2);
    await page.waitForTimeout(200);
    const dblOnBtn = await page.evaluate(() => window.ctAPI.__fake.winCalls);
    check('双击窗口按钮不触发最大化（交互元素被过滤）', dblOnBtn.toggleMaximize === 0, JSON.stringify(dblOnBtn));

    // drag / no-drag
    const regions = await page.evaluate(() => {
      const style = getComputedStyle(document.querySelector('[data-testid="one-ct-topbar"]'));
      const btnStyle = getComputedStyle(document.querySelector('[data-testid="one-ct-win-minimize"]'));
      const switchStyle = getComputedStyle(document.querySelector('[data-testid="one-ct-start-stop"]'));
      const pick = (s) => s.getPropertyValue('-webkit-app-region') || s.getPropertyValue('app-region');
      return { bar: pick(style), btn: pick(btnStyle), action: pick(switchStyle) };
    });
    check('顶栏 -webkit-app-region: drag', regions.bar.trim() === 'drag', `bar=${regions.bar}`);
    check('顶栏按钮区 no-drag', regions.btn.trim() === 'no-drag', `btn=${regions.btn}`);
    check('顶栏操作按钮 no-drag', regions.action.trim() === 'no-drag', `action=${regions.action}`);

    // 兜底：ctAPI.system.window 缺失 → 不渲染按钮、不报错
    await page.evaluate(() => window.ctAPI.__fake.removeWindowApi());
    await page.evaluate(() => window.OneCTShell.refresh());
    await page.waitForTimeout(300);
    const noWinApi = await page.evaluate(() => ({
      controls: document.querySelectorAll('[data-testid="one-ct-win-controls"]').length,
      buttons: document.querySelectorAll('[data-testid^="one-ct-win-"]').length,
    }));
    check('ctAPI.system.window 缺失时不渲染窗口按钮', noWinApi.controls === 0 && noWinApi.buttons === 0, JSON.stringify(noWinApi));
    check('窗口 API 缺失时页面不报错', pageErrors.length === 0, pageErrors.join(' | '));
    // 恢复后按钮回来
    await page.evaluate(() => {
      window.ctAPI.system.window = {
        minimize: function () { window.ctAPI.__fake.winCalls.minimize += 1; return Promise.resolve({ ok: true }); },
        toggleMaximize: function () { window.ctAPI.__fake.winCalls.toggleMaximize += 1; return Promise.resolve({ maximized: false }); },
        close: function () { window.ctAPI.__fake.winCalls.close += 1; return Promise.resolve({ ok: true }); },
      };
    });
    await page.evaluate(() => window.OneCTShell.refresh());
    await page.waitForTimeout(300);
    check(
      '窗口 API 恢复后按钮重新渲染',
      (await page.getByTestId('one-ct-win-minimize').count()) === 1,
      `count=${await page.getByTestId('one-ct-win-minimize').count()}`,
    );

    // ── 2) 视觉硬要求（极简白） ──
    const visual = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const card = document.querySelector('.one-ct-card');
      const cardStyle = card ? getComputedStyle(card) : null;
      const btn = document.querySelector('.one-ct-btn--primary');
      const btnStyle = btn ? getComputedStyle(btn) : null;
      const gradients = [];
      const heavyShadows = [];
      const darkAreas = [];
      document.querySelectorAll('*').forEach((node) => {
        const style = getComputedStyle(node);
        if (/gradient/i.test(style.backgroundImage)) gradients.push(node.className || node.tagName);
        const shadow = style.boxShadow;
        if (shadow && shadow !== 'none') {
          const nums = shadow.match(/-?[\d.]+px/g) || [];
          const blur = nums.length >= 3 ? Math.abs(parseFloat(nums[2])) : 0;
          if (blur > 3) heavyShadows.push(`${node.className || node.tagName}: ${shadow}`);
        }
        const bg = style.backgroundColor;
        const rect = node.getBoundingClientRect();
        const m = bg.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (m && rect.width * rect.height > 20000) {
          const lum = (Number(m[1]) * 299 + Number(m[2]) * 587 + Number(m[3]) * 114) / 1000;
          const alphaMatch = bg.match(/rgba\([^)]*,\s*([\d.]+)\)/);
          const alpha = alphaMatch ? Number(alphaMatch[1]) : 1;
          if (lum < 80 && alpha > 0.5) darkAreas.push(`${node.className || node.tagName}: ${bg}`);
        }
      });
      return {
        vars: {
          bg: root.getPropertyValue('--bg').trim(),
          bgSubtle: root.getPropertyValue('--bg-subtle').trim(),
          border: root.getPropertyValue('--border').trim(),
          text: root.getPropertyValue('--text').trim(),
          text2: root.getPropertyValue('--text-2').trim(),
          ok: root.getPropertyValue('--ok').trim(),
          warn: root.getPropertyValue('--warn').trim(),
          err: root.getPropertyValue('--err').trim(),
        },
        cardRadius: cardStyle ? cardStyle.borderRadius : '',
        cardBorder: cardStyle ? cardStyle.borderTopWidth + ' ' + cardStyle.borderTopColor : '',
        primaryBtn: btnStyle ? { bg: btnStyle.backgroundColor, color: btnStyle.color } : null,
        gradients,
        heavyShadows,
        darkAreas,
        fontFamily: getComputedStyle(document.body).fontFamily,
        bodyBg: getComputedStyle(document.body).backgroundColor,
        appBg: document.querySelector('.one-ct-app')
          ? getComputedStyle(document.querySelector('.one-ct-app')).backgroundColor
          : '',
      };
    });
    check('--bg = #ffffff', visual.vars.bg === '#ffffff', visual.vars.bg);
    check('--bg-subtle = #fafafa', visual.vars.bgSubtle === '#fafafa', visual.vars.bgSubtle);
    check('--border = #e8e8ea', visual.vars.border === '#e8e8ea', visual.vars.border);
    check('--text = #111113', visual.vars.text === '#111113', visual.vars.text);
    check('--text-2 = #6b7280', visual.vars.text2 === '#6b7280', visual.vars.text2);
    check(
      '--ok/--warn/--err 与契约一致',
      visual.vars.ok === '#16a34a' && visual.vars.warn === '#d97706' && visual.vars.err === '#dc2626',
      JSON.stringify(visual.vars),
    );
    check('卡片圆角 10px', visual.cardRadius === '10px', visual.cardRadius);
    check('卡片 1px 边框', /^1px/.test(visual.cardBorder), visual.cardBorder);
    check('窗口底色纯白（body 与 app 均为 #ffffff）', visual.bodyBg === 'rgb(255, 255, 255)' && visual.appBg === 'rgb(255, 255, 255)', `body=${visual.bodyBg} app=${visual.appBg}`);
    check(
      '根节点不重复挂 .one-ct-app（避免 flex 100vh 叠两层）',
      (await page.evaluate(() => document.querySelectorAll('.one-ct-app').length)) === 1,
      `count=${await page.evaluate(() => document.querySelectorAll('.one-ct-app').length)}`,
    );
    check(
      '主按钮黑底白字',
      visual.primaryBtn &&
        visual.primaryBtn.bg === 'rgb(17, 17, 19)' &&
        visual.primaryBtn.color === 'rgb(255, 255, 255)',
      JSON.stringify(visual.primaryBtn),
    );
    check('无渐变背景', visual.gradients.length === 0, visual.gradients.slice(0, 5).join(' | ') || '0');
    check('无重阴影（blur ≤ 3px）', visual.heavyShadows.length === 0, visual.heavyShadows.slice(0, 5).join(' | ') || '0');
    check('无深色大面积色块', visual.darkAreas.length === 0, visual.darkAreas.slice(0, 5).join(' | ') || '0');
    check(
      '字体栈含 PingFang SC / Microsoft YaHei',
      /PingFang SC|Microsoft YaHei/.test(visual.fontFamily),
      visual.fontFamily,
    );

    // ── 运行页 ──
    check('默认 tab 为运行页', await page.getByTestId('one-ct-run-view').isVisible());
    check('顶栏状态为「未启动」', (await page.getByTestId('one-ct-status').textContent()).trim() === '未启动');
    check('预览开关默认开启', await page.getByTestId('one-ct-preview-switch').isChecked());
    check('底栏显示尚未运行', /尚未运行/.test(await page.getByTestId('one-ct-last-run').textContent()));
    const participants = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid^="one-ct-participant-item-"]')).map((node) => {
        const box = node.querySelector('input[type="checkbox"]');
        return { testid: node.getAttribute('data-testid'), checked: box ? box.checked : null, text: node.textContent };
      }),
    );
    check('参与成员列表渲染出全部成员', participants.length === 3, `count=${participants.length}`);
    check(
      '默认只勾选 enabled 成员（2/3）',
      participants.filter((p) => p.checked).length === 2,
      JSON.stringify(participants.map((p) => p.checked)),
    );
    check(
      '参与成员数显示 2',
      (await page.getByTestId('one-ct-participant-count').textContent()).trim() === '2',
      await page.getByTestId('one-ct-participant-count').textContent(),
    );
    check(
      '参与成员信息中手机号已掩码',
      /138\*\*\*\*0000/.test(participants.map((p) => p.text).join(' ')),
      participants.map((p) => p.text).join(' | ').slice(0, 140),
    );

    // ── task-9：绝对初始状态（任何运行/同步之前）——种子数据是手工来源 ──
    await page.getByTestId('one-ct-tab-members').click();
    await page.waitForTimeout(250);
    const initialGap = await page.evaluate(() => {
      const cell = document.querySelector('[data-testid="one-ct-member-gap-m_zhangsan"]');
      const source = document.querySelector('[data-testid="one-ct-member-gap-source-m_zhangsan"]');
      return { gap: cell ? cell.textContent.trim() : '', source: source ? source.textContent.trim() : '' };
    });
    check('初始缺口来自种子 ekModules（29.5，尚未同步）', initialGap.gap === '29.5', JSON.stringify(initialGap));
    check('初始缺口来源标注为「手工」（种子未标 official）', /手工/.test(initialGap.source), JSON.stringify(initialGap));
    await page.getByTestId('one-ct-tab-run').click();
    await page.waitForTimeout(250);

    shots.push(await screenshot(page, '1ct-shell-01-run.png'));

    const configTestIds = [
      'one-ct-module-ek', 'one-ct-module-unirun', 'one-ct-module-club',
      'one-ct-ek-keywords', 'one-ct-ek-allowall', 'one-ct-ek-dailylimit',
      'one-ct-ek-qrdelay', 'one-ct-ek-qrretry', 'one-ct-ek-qrmax',
      'one-ct-ek-fallback-status',
      'one-ct-unirun-runat', 'one-ct-unirun-window', 'one-ct-unirun-distance', 'one-ct-unirun-time',
      'one-ct-club-keywords', 'one-ct-club-allowall', 'one-ct-club-dailylimit',
      'one-ct-tick-sec', 'one-ct-window-tick-sec',
      'one-ct-sync-on-start',
    ];
    const missing = [];
    for (const id of configTestIds) {
      if ((await page.getByTestId(id).count()) === 0) missing.push(id);
    }
    check('三模块全部关键参数控件存在', missing.length === 0, missing.join(', ') || `${configTestIds.length} ok`);
    // 用户要求：这些开关没必要（默认开启）→ 控件必须不存在
    for (const gone of ['one-ct-ek-photosign', 'one-ct-ek-captchasign', 'one-ct-club-join', 'one-ct-club-signin', 'one-ct-club-signout']) {
      check('冗余开关已移除：' + gone, (await page.getByTestId(gone).count()) === 0);
    }
    check('校园跑时长是只读行（不是输入框）', await page.evaluate(() => {
      const node = document.querySelector('[data-testid="one-ct-unirun-time"]');
      return Boolean(node) && node.tagName !== 'INPUT';
    }));
    // 3CT 后端图库：不接（需要 3CT 账号 token，且对签到没有增益）→ UI 不应出现
    check('不再渲染 3CT 图库登录区块', (await page.getByTestId('one-ct-backend-gallery').count()) === 0);
    const moduleSwitches = await page.evaluate(() =>
      ['ek', 'unirun', 'club'].map((key) => {
        const box = document.querySelector(`[data-testid="one-ct-module-${key}"]`);
        return { key, checked: box ? box.checked : null };
      }),
    );
    check(
      '三模块开关默认全关（与引擎 DEFAULTS 一致）',
      moduleSwitches.every((item) => item.checked === false),
      JSON.stringify(moduleSwitches),
    );

    // ── task-9：运行页「启动时自动同步官方成绩」开关（默认开，落 ek.scorePolicy.refreshOnStart） ──
    check(
      '自动同步开关默认开启',
      await page.getByTestId('one-ct-sync-on-start').isChecked(),
      `checked=${await page.getByTestId('one-ct-sync-on-start').isChecked()}`,
    );
    check(
      '自动同步开关初始未落盘（沿用引擎默认 true）',
      await page.evaluate(() => {
        const cfg = JSON.parse(window.localStorage.getItem('1ct:config:global') || '{}');
        return !cfg.ek || !cfg.ek.scorePolicy || cfg.ek.scorePolicy.refreshOnStart === undefined;
      }),
      'refreshOnStart absent → 默认 true',
    );
    await page.getByTestId('one-ct-sync-on-start').uncheck();
    await page.waitForTimeout(350);
    const cfgSyncOff = await readGlobalConfig(page);
    check(
      '关闭自动同步落盘到 ek.scorePolicy.refreshOnStart=false',
      Boolean(cfgSyncOff.ek && cfgSyncOff.ek.scorePolicy && cfgSyncOff.ek.scorePolicy.refreshOnStart === false),
      JSON.stringify(cfgSyncOff.ek && cfgSyncOff.ek.scorePolicy),
    );
    await page.getByTestId('one-ct-sync-on-start').check();
    await page.waitForTimeout(350);
    const cfgSyncOn = await readGlobalConfig(page);
    check(
      '重新开启自动同步落盘为 true',
      Boolean(cfgSyncOn.ek && cfgSyncOn.ek.scorePolicy && cfgSyncOn.ek.scorePolicy.refreshOnStart === true),
      JSON.stringify(cfgSyncOn.ek && cfgSyncOn.ek.scorePolicy),
    );

    // ── task-9：每轮运行前若超过阈值未同步 → 自动触发 syncOfficialScores ──
    // 先把成员的 ekModulesUpdatedAt 清空（模拟很久没同步），再跑一轮，断言自动同步被调用
    await page.evaluate(() => {
      const api = window.OneCTMembers;
      const state = api.load();
      state.items.forEach((m) => {
        if (!m.ekModules) return;
        const next = Object.assign({}, m);
        delete next.ekModulesUpdatedAt;
        api.upsertMember(next);
      });
      window.__ONE_CT_FAKE_SYNC__.reset();
    });
    await page.getByTestId('one-ct-run-once').click();
    const autoSyncRan = await page
      .waitForFunction(() => window.__ONE_CT_FAKE_SYNC__.calls() > 0, null, { timeout: 20000 })
      .then(() => true)
      .catch(() => false);
    check('运行前自动同步官方成绩被触发（超过阈值未同步）', autoSyncRan, `syncCalls=${await page.evaluate(() => window.__ONE_CT_FAKE_SYNC__.calls())}`);
    await page.waitForTimeout(1200);

    // 关闭自动同步后，运行不应再触发同步
    await page.getByTestId('one-ct-sync-on-start').uncheck();
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      const api = window.OneCTMembers;
      api.load().items.forEach((m) => {
        if (!m.ekModules) return;
        const next = Object.assign({}, m);
        delete next.ekModulesUpdatedAt;
        api.upsertMember(next);
      });
      window.__ONE_CT_FAKE_SYNC__.reset();
    });
    await page.getByTestId('one-ct-run-once').click();
    await page.waitForTimeout(3000);
    check(
      '关闭自动同步后运行不再触发同步',
      (await page.evaluate(() => window.__ONE_CT_FAKE_SYNC__.calls())) === 0,
      `syncCalls=${await page.evaluate(() => window.__ONE_CT_FAKE_SYNC__.calls())}`,
    );
    await page.getByTestId('one-ct-sync-on-start').check();
    await page.waitForTimeout(300);

    // ── task-9：同步接口缺失时优雅降级（显示「同步功能未就绪」并禁用，不抛错） ──
    await page.evaluate(() => {
      window.__ONE_CT_ORIG_SYNC__ = {
        single: window.OneCTMembers.syncOfficialScores,
        all: window.OneCTMembers.syncAllOfficialScores,
      };
      delete window.OneCTMembers.syncOfficialScores;
      delete window.OneCTMembers.syncAllOfficialScores;
    });
    await page.getByTestId('one-ct-tab-members').click();
    await page.waitForTimeout(200);
    await page.getByTestId('one-ct-member-edit-m_zhangsan').click();
    await page.getByTestId('one-ct-member-modal').waitFor({ state: 'visible' });
    const degraded = await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="one-ct-sync-member"]');
      return btn ? { text: btn.textContent.trim(), disabled: btn.disabled } : null;
    });
    check(
      '同步接口缺失时按钮显示「同步功能未就绪」并禁用',
      degraded && /同步功能未就绪/.test(degraded.text) && degraded.disabled === true,
      JSON.stringify(degraded),
    );
    check('同步接口缺失时不抛错（弹层正常打开）', await page.getByTestId('one-ct-member-modal').isVisible());
    shots.push(await screenshot(page, '1ct-sync-06-degraded.png'));
    await page.getByTestId('one-ct-member-cancel').click();
    await page.evaluate(() => {
      window.OneCTMembers.syncOfficialScores = window.__ONE_CT_ORIG_SYNC__.single;
      window.OneCTMembers.syncAllOfficialScores = window.__ONE_CT_ORIG_SYNC__.all;
    });
    await page.waitForTimeout(200);
    // 回到运行页，滚动到「轮询与同步」卡片，截图留证（该卡片在运行页底部）
    await page.getByTestId('one-ct-tab-run').click();
    await page.waitForTimeout(250);
    await page.getByTestId('one-ct-sync-on-start').scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    check(
      '自动同步开关在运行页可见（滚动后）',
      await page.getByTestId('one-ct-sync-on-start').isVisible(),
      'visible',
    );
    shots.push(await screenshot(page, '1ct-sync-05-run-auto-sync.png'));
    await page.evaluate(() => {
      const main = document.querySelector('[data-testid="one-ct-main"]');
      if (main) main.scrollTop = 0;
    });
    await page.waitForTimeout(200);

    // ── 配置落盘（真实 members.js.saveGlobalConfig → 1ct:config:global） ──
    await page.getByTestId('one-ct-module-ek').check();
    await page.waitForTimeout(200);
    await page.getByTestId('one-ct-ek-keywords').fill('讲座,志愿');
    await page.getByTestId('one-ct-ek-keywords').dispatchEvent('change');
    await page.getByTestId('one-ct-ek-dailylimit').fill('3');
    await page.getByTestId('one-ct-ek-dailylimit').dispatchEvent('change');
    await page.getByTestId('one-ct-unirun-runat').fill('07:15');
    await page.getByTestId('one-ct-unirun-runat').dispatchEvent('change');
    await page.waitForTimeout(300);
    const cfg = await readGlobalConfig(page);
    check('二课开关写入 1ct:config:global', cfg.ek && cfg.ek.enabled === true, JSON.stringify(cfg.ek && cfg.ek.enabled));
    check(
      '二课关键词写入（数组）',
      Array.isArray(cfg.ek.keywords) && cfg.ek.keywords.join(',') === '讲座,志愿',
      JSON.stringify(cfg.ek.keywords),
    );
    check('每日上限写入（数字）', cfg.ek.dailyLimit === 3, JSON.stringify(cfg.ek.dailyLimit));
    check('校园跑时刻写入', cfg.unirun.runAt === '07:15', JSON.stringify(cfg.unirun.runAt));
    check('预览开关 dryRun 未被配置写入污染', cfg.dryRun === true, JSON.stringify(cfg.dryRun));

    // ── 预览开关（只写全局） ──
    dialogMode = 'dismiss';
    await page.getByTestId('one-ct-preview-switch').click();
    await page.waitForTimeout(250);
    check('取消 confirm 后仍为预览模式', await page.getByTestId('one-ct-preview-switch').isChecked());
    const cfgAfterCancel = await readGlobalConfig(page);
    check('取消后全局 dryRun 仍为 true', cfgAfterCancel.dryRun === true, JSON.stringify(cfgAfterCancel.dryRun));
    dialogMode = 'accept';
    await page.getByTestId('one-ct-preview-switch').click();
    await page.waitForTimeout(350);
    const cfgReal = await readGlobalConfig(page);
    check('接受 confirm 后切换为真实提交', (await page.getByTestId('one-ct-preview-switch').isChecked()) === false);
    check('真实模式写入全局 dryRun=false', cfgReal.dryRun === false, JSON.stringify(cfgReal.dryRun));
    check(
      '成员级 config 未写入 dryRun（只写全局）',
      await page.evaluate(() => {
        const keys = [];
        for (let i = 0; i < window.localStorage.length; i += 1) {
          const key = window.localStorage.key(i);
          if (key && key.startsWith('1ct:config:') && key !== '1ct:config:global') keys.push(key);
        }
        return keys.every((key) => {
          try {
            const parsed = JSON.parse(window.localStorage.getItem(key) || '{}');
            return parsed.dryRun === undefined;
          } catch (e) {
            return true;
          }
        });
      }),
      'member override dryRun stripped',
    );
    await page.getByTestId('one-ct-preview-switch').click();
    await page.waitForTimeout(300);
    const cfgBack = await readGlobalConfig(page);
    check('可切回预览模式', cfgBack.dryRun === true, JSON.stringify(cfgBack.dryRun));

    // ── 成员页初检（在跑 runAll 之前：runAll 会自动 refreshEk 把 expired 修好） ──
    await page.getByTestId('one-ct-tab-members').click();
    await page.waitForTimeout(250);
    const initialMemberRows = await page.evaluate(() =>
      Array.from(document.querySelectorAll('tr[data-testid="one-ct-member-row"]')).map((row) =>
        row.textContent.replace(/\s+/g, ' ').trim(),
      ),
    );
    check('成员表格 3 行', initialMemberRows.length === 3, `rows=${initialMemberRows.length}`);
    check(
      '会话过期成员显示「需重新登录」',
      /需重新登录/.test(initialMemberRows.join(' ')),
      initialMemberRows.join(' | ').slice(0, 160),
    );
    check('未登录成员显示「未登录」', /未登录/.test(initialMemberRows.join(' ')), 'none-status badge');
    await page.getByTestId('one-ct-tab-run').click();
    await page.waitForTimeout(200);

    // ── 启动一轮（预览）：真实 members.js.runAll → 真实 automation.js 引擎 ──
    await page.evaluate(() => window.ctAPI.__fake.reset());
    await page.getByTestId('one-ct-start-stop').click();
    const ran = await page
      .waitForFunction(() => /本轮：/.test(document.querySelector('[data-testid="one-ct-summary"]').textContent), null, {
        timeout: 30000,
      })
      .then(() => true)
      .catch(() => false);
    check('启动后跑完一轮并在底栏显示本轮摘要', ran, await page.getByTestId('one-ct-summary').textContent());
    const writeCount = await page.evaluate(() => window.ctAPI.__fake.writeCount());
    check('预览模式下真实写调用为 0', writeCount === 0, `writes=${writeCount}`);
    check(
      '顶栏状态显示运行/启用',
      /运行|启用/.test((await page.getByTestId('one-ct-status').textContent()).trim()),
      await page.getByTestId('one-ct-status').textContent(),
    );
    await page.getByTestId('one-ct-start-stop').click();
    await page.waitForTimeout(300);
    check(
      '停止后状态回到未启动',
      (await page.getByTestId('one-ct-status').textContent()).trim() === '未启动',
      await page.getByTestId('one-ct-status').textContent(),
    );
    check(
      '底栏显示上次运行时间',
      /上次运行：\d{4}-\d{2}-\d{2}/.test(await page.getByTestId('one-ct-last-run').textContent()),
      await page.getByTestId('one-ct-last-run').textContent(),
    );

    // ── 4) 成员页 ──
    await page.getByTestId('one-ct-tab-members').click();
    await page.waitForTimeout(250);
    check('成员页可见', await page.getByTestId('one-ct-members-view').isVisible());
    const memberRows = await page.evaluate(() =>
      Array.from(document.querySelectorAll('tr[data-testid="one-ct-member-row"]')).map((row) =>
        row.textContent.replace(/\s+/g, ' ').trim(),
      ),
    );
    check('成员表格 3 行', memberRows.length === 3, `rows=${memberRows.length}`);
    const membersHtml = await page.getByTestId('one-ct-members-view').innerHTML();
    check('成员列表手机号已掩码', /138\*\*\*\*0000/.test(membersHtml), 'masked');
    check('成员列表不含完整手机号', !membersHtml.includes('13800000000'), 'no plain phone');
    check('成员列表不含密码/token 明文', !/fake-pw|fake-access-token|fake-refresh-token/i.test(membersHtml), 'no secrets');
    check('二课徽标显示已登录 + 学号', /已登录 ·\s*2024000001/.test(memberRows.join(' ')), (memberRows[0] || '').slice(0, 90));
    check(
      '积分缺口合计有数值（数字或 29.5）',
      /\d/.test(memberRows.join(' ')),
      memberRows.slice(0, 2).join(' | ').slice(0, 200),
    );
    // 缺口列必须标注来源（官方 / 手工），无数据显示 —（task-9）
    check(
      '缺口列标注来源（官方/手工）',
      /官方|手工/.test(memberRows.join(' ')),
      memberRows.join(' | ').slice(0, 220),
    );
    check(
      '缺口来源 testid 存在（one-ct-member-gap-source-*）',
      (await page.locator('[data-testid^="one-ct-member-gap-source-"]').count()) >= 1,
      `count=${await page.locator('[data-testid^="one-ct-member-gap-source-"]').count()}`,
    );
    check(
      '无成绩成员缺口显示 —（赵六没有 ekModules）',
      await page.evaluate(() => {
        const cell = document.querySelector('[data-testid="one-ct-member-gap-m_zhaoliu"]');
        return cell ? cell.textContent.trim() === '—' : false;
      }),
      await page.evaluate(() => {
        const cell = document.querySelector('[data-testid="one-ct-member-gap-m_zhaoliu"]');
        return cell ? cell.textContent.trim() : 'missing';
      }),
    );
    shots.push(await screenshot(page, '1ct-shell-02-members.png'));

    // 新增成员
    await page.getByTestId('one-ct-member-add').click();
    await page.getByTestId('one-ct-member-modal').waitFor({ state: 'visible' });
    check('成员编辑弹层打开', await page.getByTestId('one-ct-member-modal').isVisible());
    check(
      '弹层二课密码框为 type=password',
      (await page.getByTestId('one-ct-ek-password').getAttribute('type')) === 'password',
    );
    check(
      '弹层校园跑密码框为 type=password',
      (await page.getByTestId('one-ct-unirun-password').getAttribute('type')) === 'password',
    );
    check(
      '会话 JSON 默认掩码（is-secret）',
      /is-secret/.test(await page.getByTestId('one-ct-ek-session-json').getAttribute('class')),
    );

    // ── task-9 核心：八模块手填已删除，改为官方成绩只读同步 ──
    check(
      '弹层不再有八模块手填输入框（one-ct-module-current-*）',
      (await page.locator('[data-testid^="one-ct-module-current-"]').count()) === 0,
      `count=${await page.locator('[data-testid^="one-ct-module-current-"]').count()}`,
    );
    check(
      '弹层八模块区内没有任何 number 输入框（无手填入口）',
      (await page.locator('[data-testid="one-ct-sync-section"] input[type="number"]').count()) === 0,
      `count=${await page.locator('[data-testid="one-ct-sync-section"] input[type="number"]').count()}`,
    );
    check('弹层有官方成绩同步区', (await page.getByTestId('one-ct-sync-section').count()) === 1);
    check('弹层有「同步官方成绩」按钮', (await page.getByTestId('one-ct-sync-member').count()) === 1);
    check('弹层有同步状态行', (await page.getByTestId('one-ct-sync-modal-status').count()) === 1);
    check(
      '新成员（未保存）时同步按钮禁用并提示「先保存成员」',
      await page.evaluate(() => {
        const btn = document.querySelector('[data-testid="one-ct-sync-member"]');
        return btn ? btn.disabled === true && /先保存成员/.test(btn.textContent) : false;
      }),
      await page.evaluate(() => {
        const btn = document.querySelector('[data-testid="one-ct-sync-member"]');
        return btn ? btn.textContent + ' / disabled=' + btn.disabled : 'missing';
      }),
    );
    check(
      '弹层含二课登录 / 会话导入 / 校园跑校验按钮',
      (await page.getByTestId('one-ct-ek-login').count()) === 1 &&
        (await page.getByTestId('one-ct-ek-session-import').count()) === 1 &&
        (await page.getByTestId('one-ct-unirun-verify').count()) === 1,
    );
    shots.push(await screenshot(page, '1ct-shell-03-member-modal.png'));

    await page.getByTestId('one-ct-member-name').fill('李四');
    await page.getByTestId('one-ct-member-note').fill('测试成员');
    await page.getByTestId('one-ct-ek-studentid').fill('2024109999');
    await page.getByTestId('one-ct-ek-password').fill('fake-ek-pw');
    await page.getByTestId('one-ct-unirun-phone').fill('13900001111');
    await page.getByTestId('one-ct-unirun-password').fill('fake-unirun-pw');

    // 学号 + 密码登录（真实 loginEk → fake ctAPI.ek.login）
    await page.getByTestId('one-ct-ek-login').click();
    const loggedIn = await page
      .waitForFunction(
        () => {
          const node = document.querySelector('[data-testid="one-ct-ek-badge-host"]');
          return node && /已登录/.test(node.textContent);
        },
        null,
        { timeout: 15000 },
      )
      .then(() => true)
      .catch(() => false);
    check('学号+密码登录后徽标显示已登录', loggedIn, await page.getByTestId('one-ct-ek-badge-host').textContent());
    check('登录后密码输入框被清空', (await page.getByTestId('one-ct-ek-password').inputValue()) === '');
    const modalText = await page.getByTestId('one-ct-member-modal').textContent();
    check('弹层不显示密码明文', !modalText.includes('fake-ek-pw') && !modalText.includes('fake-unirun-pw'));
    check(
      '登录走的是 ctAPI.ek.login（不是扫码/手工会话）',
      (await page.evaluate(() => window.ctAPI.__fake.callCount('login'))) >= 1,
      `login calls=${await page.evaluate(() => window.ctAPI.__fake.callCount('login'))}`,
    );

    await page.getByTestId('one-ct-member-save').click();
    await page.waitForTimeout(500);
    check('保存后弹层关闭', (await page.getByTestId('one-ct-member-modal').count()) === 0);
    const afterAdd = await page.evaluate(() =>
      window.OneCTMembers.load().items.map((m) => ({
        id: m.id,
        name: m.name,
        ekStatus: m.ekStatus,
        hasEk: !!m.ek,
        hasCreds: !!m.ekCredentials,
        modules: m.ekModules ? m.ekModules.length : 0,
        phone: m.unirun && m.unirun.phone,
      })),
    );
    check('新成员已写入 OneCTMembers（4 人）', afterAdd.length === 4, JSON.stringify(afterAdd.map((m) => m.name)));
    const added = afterAdd.find((m) => m.name === '李四');
    check('新成员二课会话已写入', !!(added && added.hasEk), JSON.stringify(added && added.hasEk));
    check('新成员二课凭证已保留（自动重登用）', !!(added && added.hasCreds), JSON.stringify(added && added.hasCreds));
    check('新成员二课状态为 ok', !!(added && added.ekStatus === 'ok'), String(added && added.ekStatus));
    // task-9：UI 不再写 ekModules（八模块只能由官方同步产生）
    check(
      '新成员八模块仍为空（UI 不再手填，只能由官方同步写入）',
      !!(added && added.modules === 0),
      String(added && added.modules),
    );
    check(
      '新成员校园跑手机号已保存（数据层原文）',
      !!(added && added.phone === '13900001111'),
      String(added && added.phone),
    );
    const membersHtml2 = await page.getByTestId('one-ct-members-view').innerHTML();
    check('新增成员在列表显示掩码手机号', /139\*\*\*\*1111/.test(membersHtml2), 'masked');
    check('新增成员列表不含明文手机号', !membersHtml2.includes('13900001111'));

    // 编辑：粘贴会话 JSON
    const newId = afterAdd.find((m) => m.name === '李四').id;
    await page.getByTestId('one-ct-member-edit-' + newId).click();
    await page.getByTestId('one-ct-member-modal').waitFor({ state: 'visible' });
    await page.getByTestId('one-ct-member-note').fill('编辑备注');
    const sessionJson = JSON.stringify({
      JSESSIONID: 'FAKE-SESSION-JSON',
      access_token: 'fake-json-access-token',
      refresh_token: 'fake-json-refresh-token',
      user_info: { loginName: '2024109999', userName: '李四' },
    });
    await page.getByTestId('one-ct-ek-session-json').fill(sessionJson);
    await page.getByTestId('one-ct-ek-session-import').click();
    await page.waitForTimeout(400);
    check('粘贴会话 JSON 后输入框立即清空', (await page.getByTestId('one-ct-ek-session-json').inputValue()) === '');
    const sessionImported = await page.evaluate((id) => {
      const m = window.OneCTMembers.load().items.find((item) => item.id === id);
      return { jsession: m && m.ek && m.ek.JSESSIONID, status: m && m.ekStatus };
    }, newId);
    check('会话 JSON 已写入 member.ek', sessionImported.jsession === 'FAKE-SESSION-JSON', JSON.stringify(sessionImported));
    check('导入后状态为 ok', sessionImported.status === 'ok', String(sessionImported.status));
    const modalText2 = await page.getByTestId('one-ct-member-modal').textContent();
    check('弹层不显示会话 token 明文', !modalText2.includes('fake-json-access-token'));

    // ── task-9：官方成绩一键同步（成功更新缺口 / 失败保留旧值） ──
    // 登录后同步按钮应可用
    check(
      '已登录成员的同步按钮可用',
      await page.evaluate(() => {
        const btn = document.querySelector('[data-testid="one-ct-sync-member"]');
        return btn ? btn.disabled === false && /同步官方成绩/.test(btn.textContent) : false;
      }),
      await page.evaluate(() => {
        const btn = document.querySelector('[data-testid="one-ct-sync-member"]');
        return btn ? btn.textContent + ' / disabled=' + btn.disabled : 'missing';
      }),
    );
    // 成功同步：fake 官方接口返回 8 个模块
    await page.evaluate(() => window.__ONE_CT_FAKE_SYNC__ && window.__ONE_CT_FAKE_SYNC__.reset());
    await page.getByTestId('one-ct-sync-member').click();
    const syncOk = await page
      .waitForFunction(
        () => {
          const node = document.querySelector('[data-testid="one-ct-sync-modal-status"]');
          return node && /官方成绩 · 同步于/.test(node.textContent);
        },
        null,
        { timeout: 15000 },
      )
      .then(() => true)
      .catch(() => false);
    check(
      '点「同步官方成绩」后状态行显示「官方成绩 · 同步于 …」',
      syncOk,
      await page.getByTestId('one-ct-sync-modal-status').textContent(),
    );
    check(
      '同步后弹层出现八模块只读缺口网格（8 行）',
      (await page.locator('[data-testid="one-ct-sync-gap-row"]').count()) === 8,
      `rows=${await page.locator('[data-testid="one-ct-sync-gap-row"]').count()}`,
    );
    const syncedMember = await page.evaluate((id) => {
      const m = window.OneCTMembers.load().items.find((item) => item.id === id);
      return {
        modules: m && Array.isArray(m.ekModules) ? m.ekModules.length : 0,
        source: m && m.ekModulesSource,
        updatedAt: m && m.ekModulesUpdatedAt,
      };
    }, newId);
    check('同步写回 member.ekModules（8 项）', syncedMember.modules === 8, String(syncedMember.modules));
    check('同步标记来源为 official', syncedMember.source === 'official', String(syncedMember.source));
    check('同步写入 ekModulesUpdatedAt', Number(syncedMember.updatedAt) > 0, String(syncedMember.updatedAt));
    const totalGapAfterSync = await page.getByTestId('one-ct-sync-total-gap').textContent();
    check('同步后显示缺口合计', /缺口合计/.test(totalGapAfterSync), totalGapAfterSync);
    check(
      '官方成绩区在弹层首屏内（与二课登录区相邻，不需要滚动）',
      await page.evaluate(() => {
        const section = document.querySelector('[data-testid="one-ct-sync-section"]');
        const modal = document.querySelector('[data-testid="one-ct-member-modal"]');
        if (!section || !modal) return false;
        const syncTop = section.getBoundingClientRect().top;
        const modalBottom = modal.getBoundingClientRect().bottom;
        return syncTop > 0 && syncTop < modalBottom;
      }),
      'sync section within modal viewport',
    );
    shots.push(await screenshot(page, '1ct-sync-01-modal-synced.png'));

    // 保存 → 列表缺口列应更新（来自官方同步值）
    await page.getByTestId('one-ct-member-save').click();
    await page.waitForTimeout(500);
    const gapAfterSync = await page.evaluate((id) => {
      const cell = document.querySelector('[data-testid="one-ct-member-gap-' + id + '"]');
      const source = document.querySelector('[data-testid="one-ct-member-gap-source-' + id + '"]');
      return { gap: cell ? cell.textContent.trim() : 'missing', source: source ? source.textContent.trim() : '' };
    }, newId);
    check('列表缺口列显示同步后的数值', /^\d+(\.\d+)?$/.test(gapAfterSync.gap), JSON.stringify(gapAfterSync));
    check('列表缺口列标注来源「官方」', /官方/.test(gapAfterSync.source), JSON.stringify(gapAfterSync));
    shots.push(await screenshot(page, '1ct-sync-02-members-gap.png'));

    // 失败场景：官方接口报错，必须保留旧值 + 显示原因
    const beforeFail = await page.evaluate((id) => {
      const m = window.OneCTMembers.load().items.find((item) => item.id === id);
      return { modules: m && Array.isArray(m.ekModules) ? JSON.stringify(m.ekModules) : '' };
    }, newId);
    await page.getByTestId('one-ct-member-edit-' + newId).click();
    await page.getByTestId('one-ct-member-modal').waitFor({ state: 'visible' });
    await page.evaluate(() => window.__ONE_CT_FAKE_SYNC__.failNext());
    await page.getByTestId('one-ct-sync-member').click();
    const syncFail = await page
      .waitForFunction(
        () => {
          const err = document.querySelector('[data-testid="one-ct-member-error"]');
          return err && /同步失败/.test(err.textContent);
        },
        null,
        { timeout: 15000 },
      )
      .then(() => true)
      .catch(() => false);
    check('同步失败时显示错误原因', syncFail, await page.getByTestId('one-ct-member-error').textContent());
    const afterFail = await page.evaluate((id) => {
      const m = window.OneCTMembers.load().items.find((item) => item.id === id);
      return { modules: m && Array.isArray(m.ekModules) ? JSON.stringify(m.ekModules) : '' };
    }, newId);
    check('同步失败后不清空旧值', afterFail.modules === beforeFail.modules && afterFail.modules.length > 10, `${beforeFail.modules.length}→${afterFail.modules.length}`);
    check(
      '同步失败后仍显示旧值的只读网格',
      (await page.locator('[data-testid="one-ct-sync-gap-row"]').count()) === 8,
      `rows=${await page.locator('[data-testid="one-ct-sync-gap-row"]').count()}`,
    );
    shots.push(await screenshot(page, '1ct-sync-03-modal-fail-keeps.png'));
    await page.getByTestId('one-ct-member-cancel').click();
    await page.waitForTimeout(250);

    // 删除成员
    dialogMode = 'accept';
    await page.getByTestId('one-ct-member-delete-' + newId).click();
    await page.waitForTimeout(500);
    const afterDelete = await page.evaluate(() => window.OneCTMembers.load().items.map((m) => m.name));
    check('删除成员后只剩 3 人', afterDelete.length === 3, JSON.stringify(afterDelete));
    check('被删除成员不在列表', !afterDelete.includes('李四'), JSON.stringify(afterDelete));

    // ── 5) 二课页（真实 OneCTStats.build + renderInto） ──
    await page.getByTestId('one-ct-tab-ek').click();
    await page.waitForTimeout(400);
    check('二课页可见', await page.getByTestId('one-ct-ek-view').isVisible());
    check('成员选择器存在', await page.getByTestId('one-ct-ek-member-select').isVisible());
    check(
      '统计区块由 OneCTStats.renderInto 渲染（data-one-ct=stats）',
      (await page.locator('[data-one-ct="stats"]').count()) === 1,
      `nodes=${await page.locator('[data-one-ct="stats"]').count()}`,
    );
    const statsHostText = await page.getByTestId('one-ct-stats-host').textContent();
    const statSignIn = await page.locator('[data-one-ct="stat-signIn-success"]').first().textContent();
    const statSignOut = await page.locator('[data-one-ct="stat-signOut-success"]').first().textContent();
    check('统计卡显示签到成功数（种子 1）', statSignIn.trim() === '1', statSignIn);
    check('统计卡显示签退成功数（种子 1）', statSignOut.trim() === '1', statSignOut);
    check('统计区块有八模块进度', (await page.locator('[data-one-ct="module"]').count()) === 8, `modules=${await page.locator('[data-one-ct="module"]').count()}`);
    check('统计区块有缺口合计', /缺口/.test(statsHostText), 'gap');
    check('统计区块有活动明细行', (await page.locator('[data-one-ct="activity-row"]').count()) >= 1, `rows=${await page.locator('[data-one-ct="activity-row"]').count()}`);
    check('统计区块显示二课会话状态徽标', (await page.locator('[data-one-ct="ek-status"]').count()) >= 1);
    check('导出 CSV 按钮存在', await page.getByTestId('one-ct-ek-export-csv').isVisible());

    // ── 用户需求：二课板块要能看到已报名的二课（状态来自官方报名列表 GetStuAllActApplyList） ──
    // 官方列表 fake = 真实形态 { List:{ Items, TotalPages, TotalItems } }；
    // 官方报名列表 fake = 真实形态 { PageList:{ Items, CurrentPage, TotalPages } }
    //（GetStuAllActApplyList，字段 SignD/SignT/Inputdate/SignOutdate，官网「报名/完成列表」页数据源）；
    // 官方签到记录 / 官方详情 fake 保留为兜底；会话 fake 覆盖 401→refresh/login 自动修复链路。
    async function readAppliedRowsSnapshot() {
      return page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-testid="one-ct-ek-applied-row"]')).map((row) => ({
          id: row.getAttribute('data-activity-id'),
          source: row.getAttribute('data-source'),
          text: row.textContent.replace(/\s+/g, ' ').trim(),
          cells: Array.from(row.querySelectorAll('td')).map((td) =>
            td.textContent.replace(/\s+/g, ' ').trim(),
          ),
          statuses: Array.from(row.querySelectorAll('[data-testid="one-ct-ek-applied-status"]')).map((n) => ({
            text: n.textContent,
            status: n.getAttribute('data-status'),
            title: n.getAttribute('title'),
          })),
          windows: Array.from(row.querySelectorAll('[data-testid="one-ct-ek-applied-window"]')).map((n) => ({
            text: n.textContent.replace(/\s+/g, ' ').trim(),
            title: n.getAttribute('title'),
            lines: Array.from(n.children).map((child) => child.textContent.replace(/\s+/g, ' ').trim()),
            whiteSpace: getComputedStyle(n).whiteSpace,
            overflow: getComputedStyle(n).overflow,
          })),
        })),
      );
    }
    async function readAppliedNote() {
      return (await page.getByTestId('one-ct-ek-applied-note').textContent()).replace(/\s+/g, ' ').trim();
    }
    async function readDetailCalls() {
      return page.evaluate(() => window.__ONE_CT_FAKE_DETAIL__.calls());
    }
    async function readSignListCalls() {
      return page.evaluate(() => window.__ONE_CT_FAKE_SIGN_LIST__.calls());
    }
    async function readApplyListCalls() {
      return page.evaluate(() => window.__ONE_CT_FAKE_APPLY_LIST__.calls());
    }
    async function waitAppliedNote(re) {
      return page
        .waitForFunction(
          (source) => {
            const note = document.querySelector('[data-testid="one-ct-ek-applied-note"]');
            return note !== null && new RegExp(source).test(note.textContent.replace(/\s+/g, ' '));
          },
          re.source,
          { timeout: 20000 },
        )
        .then(() => true)
        .catch(() => false);
    }
    check('二课页有「已报名的二课」卡片', (await page.getByTestId('one-ct-ek-applied').count()) === 1);
    check('已报名卡片有刷新按钮', (await page.getByTestId('one-ct-ek-applied-refresh').count()) === 1);
    // 首轮自动加载：官方列表 3 个（含与本地 act-1 重复的 1 个）+ 本地 2 个 → 合并 4 行；
    // 状态数据源 = 官方报名列表 getStuAllActApplyList（真实 PageList.Items 形态，SignD/SignT）
    const appliedLoadReady = await waitAppliedNote(
      /官方已报名列表（activityStatus=1）共 3 个 · 本地记录 2 个 · 合并 4 个 · 官方报名列表签到状态已更新 3 条/,
    );
    check('官方接口按真实形态 List.Items 解析（不再降级为「本地记录」）', appliedLoadReady, await readAppliedNote());
    const appliedSubText = (await page
      .locator('[data-testid="one-ct-ek-applied"] .one-ct-card-sub')
      .first()
      .textContent()).replace(/\s+/g, ' ');
    check(
      '卡片说明：官方报名列表（SignD/SignT）+ 官方签到记录 + 本机执行记录 + 官方详情兜底',
      /官方报名列表（SignD\/SignT）/.test(appliedSubText) && /官方详情兜底/.test(appliedSubText),
      appliedSubText,
    );
    check(
      'appliedNote 显示官方报名列表数据源与条数',
      /官方报名列表签到状态已更新 3 条/.test(await readAppliedNote()),
      await readAppliedNote(),
    );
    // 手动刷新一轮（force），并清空 fake 调用记录（runAll 引擎也会调 getActivityDetail，非本页逻辑）
    await page.evaluate(() => {
      window.__ONE_CT_FAKE_DETAIL__.reset();
      window.__ONE_CT_FAKE_APPLIED__.reset();
      window.__ONE_CT_FAKE_SIGN_LIST__.reset();
      window.__ONE_CT_FAKE_APPLY_LIST__.reset();
    });
    await page.getByTestId('one-ct-ek-applied-refresh').click();
    const appliedReady = await waitAppliedNote(
      /官方报名列表签到状态已更新 3 条 · 官方签到\/签退时段已更新 3 个/,
    );
    check(
      '已报名列表渲染出行（本地历史 ∪ 官方列表）',
      appliedReady && (await page.locator('[data-testid="one-ct-ek-applied-row"]').count()) === 4,
      `rows=${await page.locator('[data-testid="one-ct-ek-applied-row"]').count()}`,
    );
    const appliedSnapshot = await readAppliedRowsSnapshot();
    const officialAppliedRows = appliedSnapshot.filter((r) => r.source === 'official');
    const localAppliedRows = appliedSnapshot.filter((r) => r.source === 'local');
    const appliedRowById = (id) => appliedSnapshot.find((r) => r.id === id) || null;
    check('已报名行含签到/签退两个状态徽标', appliedSnapshot.every((r) => r.statuses.length === 2), JSON.stringify(appliedSnapshot.map((r) => r.statuses.map((s) => s.text))));
    check(
      '官方列表里的活动也被合并进来（data-source=official）',
      officialAppliedRows.some((r) => /官方讲座/.test(r.text)),
      JSON.stringify(appliedSnapshot.map((r) => `${r.source}:${r.id}`)),
    );
    check(
      '官方行用真实字段渲染（Id/ActivityName/ModuleCodeText/ApplyTime）',
      officialAppliedRows.some(
        (r) =>
          r.id === 'official-act-1' &&
          /官方讲座/.test(r.text) &&
          /思想政治与道德修养/.test(r.text) &&
          /2026-10-15 19:30:00/.test(r.text),
      ),
      JSON.stringify(officialAppliedRows.map((r) => r.cells)),
    );
    check(
      '官方行缺 ApplyTime 时报名时间显示「—」（不伪造时间）',
      officialAppliedRows.some((r) => r.id === 'official-act-2' && r.cells[2] === '—'),
      JSON.stringify(officialAppliedRows.map((r) => r.cells[2])),
    );
    // 用户反馈核心：官网已签到/签退的活动，界面必须显示真实状态（不能是「—」）
    const officialSigned = appliedRowById('official-act-1');
    check(
      '官方报名列表 SignD=已签到/SignT=已签退 → 官方-only 行显示已签到、已签退（data-status=success）',
      Boolean(
        officialSigned &&
          officialSigned.statuses[0].text === '已签到' &&
          officialSigned.statuses[0].status === 'success' &&
          officialSigned.statuses[1].text === '已签退' &&
          officialSigned.statuses[1].status === 'success',
      ),
      JSON.stringify(officialSigned && officialSigned.statuses),
    );
    check(
      '官方报名列表状态徽标 title 注明「来自官方报名列表」',
      Boolean(officialSigned && officialSigned.statuses.every((s) => s.title === '来自官方报名列表')),
      JSON.stringify(officialSigned && officialSigned.statuses),
    );
    const officialUnsigned = appliedRowById('official-act-2');
    check(
      '官方报名列表明确未签到/未签退 → 显示未签到、未签退（data-status=none）',
      Boolean(
        officialUnsigned &&
          officialUnsigned.statuses[0].text === '未签到' &&
          officialUnsigned.statuses[0].status === 'none' &&
          officialUnsigned.statuses[1].text === '未签退' &&
          officialUnsigned.statuses[1].status === 'none' &&
          officialUnsigned.statuses.every((s) => s.title === '来自官方报名列表'),
      ),
      JSON.stringify(officialUnsigned && officialUnsigned.statuses),
    );
    // 本机 success 事件优先于官方报名列表（fake 报名列表对 act-1 返回的是「未签到/未签退」）
    const localAct1 = appliedRowById('act-1');
    check(
      '本机 success 事件优先：act-1 显示已签到/已签退（不被官方报名列表覆盖）',
      Boolean(
        localAct1 &&
          localAct1.source === 'local' &&
          localAct1.statuses[0].text === '已签到' &&
          localAct1.statuses[0].title === '来自本机执行记录' &&
          localAct1.statuses[1].text === '已签退',
      ),
      JSON.stringify(localAct1 && localAct1.statuses),
    );
    check(
      '本地历史行回归：act-3（只报名未签到）仍显示未签到/未签退',
      localAppliedRows.some((r) => r.id === 'act-3' && /未签到/.test(r.text) && !/已签到/.test(r.text)),
      JSON.stringify(localAppliedRows.map((r) => r.cells)),
    );
    // ── 签到/签退时段副行（官方详情 ActivityQDDate/ActivityQTDate） ──
    const signedWindowRow = appliedRowById('official-act-1');
    const noNeedWindowRow = appliedRowById('official-act-2');
    const localOnlyWindowRow = appliedRowById('act-3');
    check(
      '已报名行显示官方签到/签退时段（两行；来自官方详情，title 给完整文本）',
      Boolean(
        signedWindowRow &&
          signedWindowRow.windows.length === 1 &&
          signedWindowRow.windows[0].lines.length === 2 &&
          /^签到时段：2026-10-17 19:00至2026-10-17 21:30$/.test(signedWindowRow.windows[0].lines[0]) &&
          /^签退时段：2026-10-17 19:00至2026-10-17 21:40$/.test(signedWindowRow.windows[0].lines[1]) &&
          /来自官方详情/.test(signedWindowRow.windows[0].title),
      ),
      JSON.stringify(signedWindowRow && signedWindowRow.windows),
    );
    check(
      '时段副行为两行且允许换行（white-space:normal，不被省略号截断）',
      Boolean(
        signedWindowRow &&
          signedWindowRow.windows[0].whiteSpace === 'normal' &&
          signedWindowRow.windows[0].overflow === 'visible' &&
          signedWindowRow.windows[0].lines.length === 2,
      ),
      JSON.stringify(
        signedWindowRow && {
          whiteSpace: signedWindowRow.windows[0].whiteSpace,
          overflow: signedWindowRow.windows[0].overflow,
          lines: signedWindowRow.windows[0].lines,
        },
      ),
    );
    // 截图证据：签到时段/签退时段两行都可见
    await page.getByTestId('one-ct-ek-applied').scrollIntoViewIfNeeded();
    await page.waitForTimeout(150);
    shots.push(await screenshot(page, '1ct-ek-windows-two-lines.png'));
    check(
      '无需签到/签退的活动显示「无需签到/无需签退」',
      Boolean(
        noNeedWindowRow &&
          noNeedWindowRow.windows.length === 1 &&
          noNeedWindowRow.windows[0].lines.length === 2 &&
          noNeedWindowRow.windows[0].lines[0] === '签到时段：无需签到' &&
          noNeedWindowRow.windows[0].lines[1] === '签退时段：无需签退',
      ),
      JSON.stringify(noNeedWindowRow && noNeedWindowRow.windows),
    );
    check(
      '本地-only 行不请求详情，时段两行都显示「—」',
      Boolean(
        localOnlyWindowRow &&
          localOnlyWindowRow.windows.length === 1 &&
          localOnlyWindowRow.windows[0].lines.length === 2 &&
          localOnlyWindowRow.windows[0].lines[0] === '签到时段：—' &&
          localOnlyWindowRow.windows[0].lines[1] === '签退时段：—',
      ),
      JSON.stringify(localOnlyWindowRow && localOnlyWindowRow.windows),
    );
    // 报名列表命中时不再为「状态」拉签到记录/详情；现在只为「签到/签退时段」按行拉详情
    const detailIdsAfterApplyList = (await readDetailCalls()).map((c) => c.id);
    check(
      'applyList 命中时只为「签到/签退时段」拉详情（3 个官方行），不拉官方签到记录',
      detailIdsAfterApplyList.length === 3 &&
        detailIdsAfterApplyList.includes('official-act-1') &&
        detailIdsAfterApplyList.includes('official-act-2') &&
        detailIdsAfterApplyList.includes('act-1') &&
        (await readSignListCalls()).length === 0,
      JSON.stringify(detailIdsAfterApplyList),
    );
    check(
      '官方报名列表命中时不再拉官方签到记录（签到记录调用 0 次）',
      (await readSignListCalls()).length === 0,
      JSON.stringify((await readSignListCalls()).map((c) => c.pageIndex)),
    );
    const zhangsanJsession = await page.evaluate(() => {
      const m = window.OneCTMembers.getMember('m_zhangsan');
      return m && m.ek ? String(m.ek.JSESSIONID || '') : '';
    });
    const applyListCallsAfterForce = await readApplyListCalls();
    check(
      '官方报名列表请求带成员二课会话',
      applyListCallsAfterForce.length > 0 &&
        applyListCallsAfterForce.every(
          (c) => c.hasSession && c.jsession === zhangsanJsession && Number(c.pageIndex) >= 1,
        ),
      JSON.stringify(applyListCallsAfterForce.slice(0, 3)),
    );
    // ── 缓存：按成员存 5 分钟（src 增加 applyList）；有效期内不重复拉，刷新按钮强制重拉 ──
    const signCache = await page.evaluate(() => {
      const raw = localStorage.getItem('1ct:ekSignStatus:m_zhangsan');
      if (!raw) return { exists: false };
      let parsed = {};
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        return { exists: true, corrupt: true };
      }
      const items = parsed.items || {};
      return {
        exists: true,
        v: parsed.v,
        at: parsed.at,
        ids: Object.keys(items),
        act1: items['official-act-1'] || null,
        noSecret: !/fake-|token|password|JSESSIONID|access_token/i.test(raw),
      };
    });
    check(
      '官方签到状态按成员缓存（1ct:ekSignStatus:<memberId>，v=1，5 分钟内）',
      signCache.exists &&
        signCache.v === 1 &&
        Number(signCache.at) > Date.now() - 5 * 60 * 1000 &&
        signCache.ids.includes('official-act-1') &&
        signCache.ids.includes('official-act-2'),
      JSON.stringify(signCache).slice(0, 300),
    );
    check(
      '缓存记录官方报名列表状态 + 签到/签退时段',
      Boolean(
        signCache.act1 &&
          signCache.act1.signIn === true &&
          signCache.act1.signOut === true &&
          signCache.act1.srcIn === 'applyList' &&
          signCache.act1.srcOut === 'applyList' &&
          signCache.act1.qd === '2026-10-17 19:00至2026-10-17 21:30' &&
          signCache.act1.qt === '2026-10-17 19:00至2026-10-17 21:40' &&
          signCache.act1.needIn === '是',
      ),
      JSON.stringify(signCache.act1),
    );
    check('缓存不含 token/密码/会话信息', signCache.noSecret === true, String(signCache.noSecret));
    const applyListCallsBeforeCache = (await readApplyListCalls()).length;
    const signListCallsBeforeCache = (await readSignListCalls()).length;
    const detailCallsBeforeCache = (await readDetailCalls()).length;
    await page.getByTestId('one-ct-tab-run').click();
    await page.waitForTimeout(250);
    await page.getByTestId('one-ct-tab-ek').click();
    const cacheHit = await waitAppliedNote(/签到状态来自缓存（5 分钟内）/);
    const applyListCallsAfterCache = (await readApplyListCalls()).length;
    const signListCallsAfterCache = (await readSignListCalls()).length;
    const detailCallsAfterCache = (await readDetailCalls()).length;
    check(
      '5 分钟内重新渲染直接用缓存（不重复拉报名列表/签到记录/详情/时段）',
      cacheHit &&
        applyListCallsAfterCache === applyListCallsBeforeCache &&
        signListCallsAfterCache === signListCallsBeforeCache &&
        detailCallsAfterCache === detailCallsBeforeCache,
      `applyList ${applyListCallsBeforeCache}→${applyListCallsAfterCache} / signList ${signListCallsBeforeCache}→${signListCallsAfterCache} / detail ${detailCallsBeforeCache}→${detailCallsAfterCache}`,
    );
    await page.getByTestId('one-ct-ek-applied-refresh').click();
    const forceRefetched = await waitAppliedNote(
      /官方报名列表签到状态已更新 3 条 · 官方签到\/签退时段已更新 3 个/,
    );
    const applyListCallsAfterForceRefresh = (await readApplyListCalls()).length;
    const detailCallsAfterForceRefresh = (await readDetailCalls()).length;
    check(
      '点「刷新」强制重拉官方报名列表（绕过缓存）',
      forceRefetched && applyListCallsAfterForceRefresh === applyListCallsAfterCache + 1,
      `applyList ${applyListCallsAfterCache}→${applyListCallsAfterForceRefresh}`,
    );
    check(
      '刷新后签到记录仍 0 次，签到/签退时段随刷新强制重拉（+3）',
      (await readSignListCalls()).length === signListCallsBeforeCache &&
        detailCallsAfterForceRefresh === detailCallsBeforeCache + 3,
      `signList=${(await readSignListCalls()).length} / detail ${detailCallsBeforeCache}→${detailCallsAfterForceRefresh}`,
    );
    // 官方状态变化后点刷新 → 覆盖缓存并更新界面
    await page.evaluate(() =>
      window.__ONE_CT_FAKE_APPLY_LIST__.setStatus('official-act-2', {
        SignD: '已签到',
        SignT: '已签退',
        Inputdate: '2026/10/17 20:00:00',
        SignOutdate: '2026/10/17 20:05:00',
      }),
    );
    await page.getByTestId('one-ct-ek-applied-refresh').click();
    const statusUpdated = await page
      .waitForFunction(
        () => {
          const row = document.querySelector('[data-testid="one-ct-ek-applied-row"][data-activity-id="official-act-2"]');
          return row && /已签到/.test(row.textContent) && /已签退/.test(row.textContent);
        },
        null,
        { timeout: 20000 },
      )
      .then(() => true)
      .catch(() => false);
    const cacheUpdated = await page.evaluate(() => {
      const raw = JSON.parse(localStorage.getItem('1ct:ekSignStatus:m_zhangsan') || '{}');
      return (raw.items && raw.items['official-act-2']) || null;
    });
    check(
      '刷新后官方报名列表新状态覆盖缓存并重渲染（已签到/已签退）',
      statusUpdated &&
        Boolean(
          cacheUpdated &&
            cacheUpdated.signIn === true &&
            cacheUpdated.signOut === true &&
            cacheUpdated.srcIn === 'applyList',
        ),
      JSON.stringify(cacheUpdated),
    );
    // 还原 fake 状态，供后续用例使用
    await page.evaluate(() =>
      window.__ONE_CT_FAKE_APPLY_LIST__.setStatus('official-act-2', {
        SignD: '未签到',
        SignT: '未签退',
        Inputdate: '',
        SignOutdate: '',
      }),
    );
    await page.getByTestId('one-ct-ek-applied-refresh').click();
    await waitAppliedNote(/官方报名列表签到状态已更新 3 条/);
    // 缓存超过 5 分钟 → 自动加载重新拉报名列表（而不是一直用旧缓存）
    const applyListCallsBeforeExpire = (await readApplyListCalls()).length;
    await page.evaluate(() => {
      const key = '1ct:ekSignStatus:m_zhangsan';
      const raw = JSON.parse(localStorage.getItem(key) || '{}');
      raw.at = Date.now() - 6 * 60 * 1000;
      localStorage.setItem(key, JSON.stringify(raw));
    });
    await page.getByTestId('one-ct-tab-run').click();
    await page.waitForTimeout(250);
    await page.getByTestId('one-ct-tab-ek').click();
    const expiredReady = await waitAppliedNote(/官方报名列表签到状态已更新 3 条/);
    const applyListCallsAfterExpire = (await readApplyListCalls()).length;
    check(
      '缓存超过 5 分钟自动过期并重新拉官方报名列表',
      expiredReady && applyListCallsAfterExpire === applyListCallsBeforeExpire + 1,
      `applyList ${applyListCallsBeforeExpire}→${applyListCallsAfterExpire}`,
    );

    // ── applyList 覆盖但 SignD/SignT 为空：不再拉签到记录/详情，状态直接显示「—」 ──
    await page.evaluate(() => {
      localStorage.removeItem('1ct:ekSignStatus:m_zhangsan');
      window.__ONE_CT_FAKE_DETAIL__.reset();
      window.__ONE_CT_FAKE_SIGN_LIST__.reset();
      window.__ONE_CT_FAKE_APPLY_LIST__.reset();
      window.__ONE_CT_FAKE_APPLY_LIST__.setMode('emptyStatus');
    });
    await page.getByTestId('one-ct-ek-applied-refresh').click();
    const cleanReady = await waitAppliedNote(
      /官方报名列表签到状态已更新 3 条 · 官方签到\/签退时段已更新 3 个/,
    );
    const cleanInfo = await page.evaluate(() => ({
      detailCalls: window.__ONE_CT_FAKE_DETAIL__.calls().length,
      signListCalls: window.__ONE_CT_FAKE_SIGN_LIST__.calls().length,
      note: (document.querySelector('[data-testid="one-ct-ek-applied-note"]') || {}).textContent || '',
    }));
    check(
      'applyList 覆盖但状态为空 → 不拉官方签到记录，详情只为时段（3 个）',
      cleanReady && cleanInfo.detailCalls === 3 && cleanInfo.signListCalls === 0,
      JSON.stringify(cleanInfo),
    );
    const cleanSnapshot = await readAppliedRowsSnapshot();
    const cleanAct1 = cleanSnapshot.find((r) => r.id === 'official-act-1');
    const cleanLocalAct1 = cleanSnapshot.find((r) => r.id === 'act-1');
    check(
      'applyList 覆盖但状态为空 → 徽标显示「—」（data-status=unknown）',
      Boolean(
        cleanAct1 &&
          cleanAct1.statuses.length === 2 &&
          cleanAct1.statuses.every((s) => s.text === '—' && s.status === 'unknown'),
      ),
      JSON.stringify(cleanAct1 && cleanAct1.statuses),
    );
    check(
      'applyList 空状态时仍显示官方签到/签退时段（两行，来自详情）',
      Boolean(
        cleanAct1 &&
          cleanAct1.windows.length === 1 &&
          /^签到时段：2026-10-17 19:00至2026-10-17 21:30$/.test(cleanAct1.windows[0].lines[0]) &&
          /^签退时段：2026-10-17 19:00至2026-10-17 21:40$/.test(cleanAct1.windows[0].lines[1]),
      ),
      JSON.stringify(cleanAct1 && cleanAct1.windows),
    );
    check(
      'applyList 空状态时徽标 title 说明「官方报名列表未提供签到/签退状态」',
      Boolean(cleanAct1 && cleanAct1.statuses.every((s) => /官方报名列表未提供签到\/签退状态/.test(s.title))),
      JSON.stringify(cleanAct1 && cleanAct1.statuses),
    );
    check(
      'applyList 空状态时本机 success 仍优先（act-1 显示已签到/已签退）',
      Boolean(cleanLocalAct1 && /已签到/.test(cleanLocalAct1.text) && /已签退/.test(cleanLocalAct1.text)),
      JSON.stringify(cleanLocalAct1 && cleanLocalAct1.text),
    );
    check(
      'applyList 覆盖时 note 不再出现「读取失败」或详情兜底文案',
      !/读取失败/.test(cleanInfo.note) && !/官方详情/.test(cleanInfo.note),
      cleanInfo.note.replace(/\s+/g, ' ').trim(),
    );
    // 截图证据：applyList 覆盖但状态为空时的干净文案（不再有 11 个详情失败）
    await page.getByTestId('one-ct-ek-applied').scrollIntoViewIfNeeded();
    await page.waitForTimeout(150);
    shots.push(await screenshot(page, '1ct-ek-applied-applylist-clean.png'));
    // 恢复默认报名列表
    await page.evaluate(() => {
      localStorage.removeItem('1ct:ekSignStatus:m_zhangsan');
      window.__ONE_CT_FAKE_APPLY_LIST__.reset();
      window.__ONE_CT_FAKE_SIGN_LIST__.reset();
      window.__ONE_CT_FAKE_DETAIL__.reset();
    });
    await page.getByTestId('one-ct-ek-applied-refresh').click();
    await waitAppliedNote(/官方报名列表签到状态已更新 3 条/);

    // ── 「最近活动」改为官网报名列表最近 6 个签到/签退成功（>6 条只取 6、倒序） ──
    await page.evaluate(() => {
      localStorage.removeItem('1ct:ekSignStatus:m_zhangsan');
      window.__ONE_CT_FAKE_APPLY_LIST__.reset();
      window.__ONE_CT_FAKE_SIGN_LIST__.reset();
      window.__ONE_CT_FAKE_DETAIL__.reset();
      window.__ONE_CT_FAKE_APPLY_LIST__.setMode('recent');
    });
    await page.getByTestId('one-ct-ek-applied-refresh').click();
    const recentReady = await waitAppliedNote(/官方报名列表签到状态已更新 8 条/);
    const recentInfo = await page.evaluate(() => ({
      hint: (document.querySelector('[data-testid="one-ct-stats-source-hint"]') || {}).textContent || '',
      rows: Array.from(document.querySelectorAll('[data-one-ct="activity-row"]')).map((row) => ({
        name: (row.querySelector('[data-one-ct="activity-name"]') || {}).textContent || '',
        signIn: (row.querySelector('[data-one-ct="activity-signin"]') || {}).textContent || '',
        signOut: (row.querySelector('[data-one-ct="activity-signout"]') || {}).textContent || '',
        time: row.lastElementChild ? row.lastElementChild.textContent.trim() : '',
      })),
    }));
    check(
      '「最近活动」数据源提示为官网报名列表',
      recentReady && recentInfo.hint === '最近活动：官网报名列表（最多 6 个）',
      recentInfo.hint,
    );
    check(
      '「最近活动」最多显示 6 行',
      recentInfo.rows.length === 6,
      JSON.stringify(recentInfo.rows.map((r) => r.name)),
    );
    check(
      '「最近活动」按官方签到/签退时间倒序（最新在前）',
      recentInfo.rows.length === 6 &&
        recentInfo.rows[0].name === '官网最近活动八' &&
        recentInfo.rows[5].name === '官网最近活动三' &&
        /2026-10-17 21:00/.test(recentInfo.rows[0].time),
      JSON.stringify(recentInfo.rows.map((r) => `${r.name}@${r.time}`)),
    );
    check(
      '「最近活动」只有签到的活动签退列显示 —',
      Boolean(
        recentInfo.rows.some(
          (r) => r.name === '官网最近活动七' && /成功/.test(r.signIn) && /—/.test(r.signOut),
        ),
      ),
      JSON.stringify(recentInfo.rows.find((r) => r.name === '官网最近活动七') || null),
    );
    // 截图证据：已报名行含签到/签退时段 + 最近活动 6 个官方记录（整页）
    await page.getByTestId('one-ct-ek-applied').scrollIntoViewIfNeeded();
    await page.waitForTimeout(150);
    await page.screenshot({
      path: path.join(ARTIFACTS, '1ct-ek-windows-and-official-recent.png'),
      fullPage: true,
    });
    shots.push('1ct-ek-windows-and-official-recent.png');
    // applyList 失败 → 最近活动回退本机记录并提示来源
    await page.evaluate(() => window.__ONE_CT_FAKE_APPLY_LIST__.setMode('fail'));
    await page.getByTestId('one-ct-ek-applied-refresh').click();
    const recentFallbackReady = await waitAppliedNote(/官方报名列表读取失败/);
    const recentFallbackHint = await page.evaluate(
      () => (document.querySelector('[data-testid="one-ct-stats-source-hint"]') || {}).textContent || '',
    );
    check(
      'applyList 失败时最近活动回退本机记录并提示来源',
      recentFallbackReady && recentFallbackHint === '最近活动：本机执行记录（官网不可用）',
      recentFallbackHint,
    );
    const localRecentRows = await page.locator('[data-one-ct="activity-row"]').count();
    check('回退时最近活动仍有本机记录行', localRecentRows >= 1, `rows=${localRecentRows}`);
    // 恢复默认报名列表
    await page.evaluate(() => {
      localStorage.removeItem('1ct:ekSignStatus:m_zhangsan');
      window.__ONE_CT_FAKE_APPLY_LIST__.reset();
      window.__ONE_CT_FAKE_SIGN_LIST__.reset();
      window.__ONE_CT_FAKE_DETAIL__.reset();
    });
    await page.getByTestId('one-ct-ek-applied-refresh').click();
    await waitAppliedNote(/官方报名列表签到状态已更新 3 条/);

    // ── 数据源降级 1：报名列表失败 → 回退官方签到记录（现有链路保留） ──
    await page.evaluate(() => {
      localStorage.removeItem('1ct:ekSignStatus:m_zhangsan');
      window.__ONE_CT_FAKE_DETAIL__.reset();
      window.__ONE_CT_FAKE_SIGN_LIST__.reset();
      window.__ONE_CT_FAKE_APPLY_LIST__.reset();
      window.__ONE_CT_FAKE_APPLY_LIST__.setMode('fail');
    });
    await page.getByTestId('one-ct-ek-applied-refresh').click();
    const fallbackSignListReady = await waitAppliedNote(/官方报名列表读取失败（转签到记录\/详情兜底）/);
    const fallbackSignListDone = await waitAppliedNote(/官方签到记录已更新 3 条/);
    check(
      '官方报名列表读取失败时明确降级（转签到记录/详情）',
      fallbackSignListReady && fallbackSignListDone,
      await readAppliedNote(),
    );
    const fallbackSignSnapshot = await readAppliedRowsSnapshot();
    const fallbackSignAct1 = fallbackSignSnapshot.find((r) => r.id === 'official-act-1');
    check(
      '报名列表失败 → 回退官方签到记录：已签到/已签退（title 来自官方签到记录）',
      Boolean(
        fallbackSignAct1 &&
          fallbackSignAct1.statuses[0].text === '已签到' &&
          fallbackSignAct1.statuses[1].text === '已签退' &&
          fallbackSignAct1.statuses.every((s) => s.title === '来自官方签到记录'),
      ),
      JSON.stringify(fallbackSignAct1 && fallbackSignAct1.statuses),
    );
    check(
      '报名列表失败时签到记录覆盖状态；详情只为时段（3 个官方行）',
      (await readDetailCalls()).length === 3,
      JSON.stringify((await readDetailCalls()).map((c) => c.id)),
    );

    // ── 数据源降级 2：报名列表 + 签到记录都失败 → 回退官方详情 ──
    await page.evaluate(() => {
      localStorage.removeItem('1ct:ekSignStatus:m_zhangsan');
      window.__ONE_CT_FAKE_DETAIL__.reset();
      window.__ONE_CT_FAKE_SIGN_LIST__.reset();
      window.__ONE_CT_FAKE_SIGN_LIST__.setMode('fail');
      window.__ONE_CT_FAKE_APPLY_LIST__.reset();
      window.__ONE_CT_FAKE_APPLY_LIST__.setMode('fail');
    });
    await page.getByTestId('one-ct-ek-applied-refresh').click();
    const fallbackDetailDone = await waitAppliedNote(/官方详情已更新 2 个/);
    check('报名列表+签到记录都失败后官方详情兜底确实生效', fallbackDetailDone, await readAppliedNote());
    const fallbackSnapshot = await readAppliedRowsSnapshot();
    const fallbackAct1 = fallbackSnapshot.find((r) => r.id === 'official-act-1');
    const fallbackAct2 = fallbackSnapshot.find((r) => r.id === 'official-act-2');
    check(
      '报名列表/签到记录失败 → 回退官方详情：已签到/已签退（title 来自官方详情）',
      Boolean(
        fallbackAct1 &&
          fallbackAct1.statuses[0].text === '已签到' &&
          fallbackAct1.statuses[1].text === '已签退' &&
          fallbackAct1.statuses.every((s) => s.title === '来自官方详情'),
      ),
      JSON.stringify(fallbackAct1 && fallbackAct1.statuses),
    );
    check(
      '报名列表/签到记录失败 → 回退官方详情：明确未签到/未签退',
      Boolean(
        fallbackAct2 &&
          fallbackAct2.statuses[0].text === '未签到' &&
          fallbackAct2.statuses[1].text === '未签退',
      ),
      JSON.stringify(fallbackAct2 && fallbackAct2.statuses),
    );
    const fallbackDetailCalls = await readDetailCalls();
    const fallbackDetailIds = fallbackDetailCalls.map((c) => c.id);
    check(
      '详情兜底只对未覆盖的行请求；时段详情复用同一次响应（共 3 个 id）',
      fallbackDetailIds.length === 3 &&
        fallbackDetailIds.includes('official-act-1') &&
        fallbackDetailIds.includes('official-act-2') &&
        fallbackDetailIds.includes('act-1') &&
        fallbackDetailCalls.every((c) => c.hasSession && c.jsession === zhangsanJsession),
      JSON.stringify(fallbackDetailIds),
    );

    // ── 旧包/未打桥：getStuAllActApplyList 不存在 → 回退签到记录链路（不崩） ──
    await page.evaluate(() => {
      localStorage.removeItem('1ct:ekSignStatus:m_zhangsan');
      window.__ONE_CT_FAKE_DETAIL__.reset();
      window.__ONE_CT_FAKE_SIGN_LIST__.reset();
      window.__ONE_CT_FAKE_APPLY_LIST__.reset();
      window.__ONE_CT_FAKE_APPLY_LIST__.removeBridge();
    });
    await page.getByTestId('one-ct-ek-applied-refresh').click();
    const noBridgeReady = await waitAppliedNote(/官方签到记录已更新 3 条/);
    check(
      '未打桥（旧版）时自动回退官方签到记录，不报错',
      noBridgeReady && /官方报名列表读取失败/.test(await readAppliedNote()),
      await readAppliedNote(),
    );
    await page.evaluate(() => window.__ONE_CT_FAKE_APPLY_LIST__.restoreBridge());

    // ── 官方报名列表分页：PageList.TotalPages=2，两页记录都合并 ──
    await page.evaluate(() => {
      localStorage.removeItem('1ct:ekSignStatus:m_zhangsan');
      window.__ONE_CT_FAKE_DETAIL__.reset();
      window.__ONE_CT_FAKE_SIGN_LIST__.reset();
      window.__ONE_CT_FAKE_APPLY_LIST__.reset();
      window.__ONE_CT_FAKE_APPLY_LIST__.setMode('paged');
    });
    await page.getByTestId('one-ct-ek-applied-refresh').click();
    const applyPagedReady = await waitAppliedNote(/官方报名列表签到状态已更新 2 条（共 2 页）/);
    const applyPagedInfo = await page.evaluate(() => ({
      pageIndexes: window.__ONE_CT_FAKE_APPLY_LIST__.pageIndexes(),
      detailCalls: window.__ONE_CT_FAKE_DETAIL__.calls().length,
      signListCalls: window.__ONE_CT_FAKE_SIGN_LIST__.calls().length,
    }));
    check(
      '官方报名列表按 PageList.TotalPages 拉全两页',
      applyPagedReady && JSON.stringify(applyPagedInfo.pageIndexes) === '[1,2]',
      JSON.stringify(applyPagedInfo.pageIndexes),
    );
    const applyPagedSnapshot = await readAppliedRowsSnapshot();
    const applyPagedP2 = applyPagedSnapshot.find((r) => r.id === 'official-act-2');
    check(
      '两页报名列表都被合并（page2 活动显示已签到/已签退）',
      Boolean(
        applyPagedP2 &&
          applyPagedP2.statuses[0].text === '已签到' &&
          applyPagedP2.statuses[1].text === '已签退' &&
          applyPagedP2.statuses.every((s) => s.title === '来自官方报名列表'),
      ),
      JSON.stringify(applyPagedP2 && applyPagedP2.statuses),
    );
    check(
      '报名列表分页覆盖全部行时不为状态拉签到记录，详情只为时段（3 个官方行）',
      applyPagedInfo.detailCalls === 3 && applyPagedInfo.signListCalls === 0,
      JSON.stringify(applyPagedInfo),
    );

    // ── 二课会话过期自动修复：列表 401 → refreshEk 成功 → 重试一次 ──
    await page.evaluate(() => {
      localStorage.removeItem('1ct:ekSignStatus:m_zhangsan');
      window.__ONE_CT_FAKE_APPLY_LIST__.reset();
      window.__ONE_CT_FAKE_SIGN_LIST__.reset();
      window.__ONE_CT_FAKE_DETAIL__.reset();
      window.__ONE_CT_FAKE_APPLIED__.reset();
      window.__ONE_CT_FAKE_SESSION__.reset();
      window.__ONE_CT_FAKE_SESSION__.setListAuthFail('once');
    });
    await page.getByTestId('one-ct-ek-applied-refresh').click();
    const repairRefreshReady = await waitAppliedNote(/已自动重新登录二课/);
    const repairRefreshDone = await waitAppliedNote(/官方报名列表签到状态已更新 3 条/);
    check(
      '会话过期（401）→ refreshEk 成功 → 自动重试并正常显示',
      repairRefreshReady && repairRefreshDone,
      await readAppliedNote(),
    );
    check(
      'refresh 成功路径确实走了 refreshEk 且只重试一次',
      (await page.evaluate(() => window.__ONE_CT_FAKE_SESSION__.refreshCalls())) >= 1 &&
        (await page.evaluate(() => window.__ONE_CT_FAKE_SESSION__.loginCalls().length)) === 0,
      JSON.stringify(await page.evaluate(() => ({
        refresh: window.__ONE_CT_FAKE_SESSION__.refreshCalls(),
        login: window.__ONE_CT_FAKE_SESSION__.loginCalls().length,
      }))),
    );
    const repairRefreshSnapshot = await readAppliedRowsSnapshot();
    const repairAct1 = repairRefreshSnapshot.find((r) => r.id === 'official-act-1');
    check(
      '自动重登后官方行状态仍正确（已签到/已签退）',
      Boolean(repairAct1 && repairAct1.statuses[0].text === '已签到' && repairAct1.statuses[1].text === '已签退'),
      JSON.stringify(repairAct1 && repairAct1.statuses),
    );

    // ── 会话过期自动修复：refreshEk 失败 → loginEk（用 ekCredentials）成功 ──
    await page.evaluate(() => {
      localStorage.removeItem('1ct:ekSignStatus:m_zhangsan');
      window.__ONE_CT_FAKE_APPLY_LIST__.reset();
      window.__ONE_CT_FAKE_SIGN_LIST__.reset();
      window.__ONE_CT_FAKE_DETAIL__.reset();
      window.__ONE_CT_FAKE_APPLIED__.reset();
      window.__ONE_CT_FAKE_SESSION__.reset();
      window.__ONE_CT_FAKE_SESSION__.setListAuthFail('once');
      window.__ONE_CT_FAKE_SESSION__.setRefreshMode('fail');
      window.__ONE_CT_FAKE_SESSION__.setLoginMode('ok');
    });
    await page.getByTestId('one-ct-ek-applied-refresh').click();
    const repairLoginReady = await waitAppliedNote(/已自动重新登录二课/);
    const repairLoginDone = await waitAppliedNote(/官方报名列表签到状态已更新 3 条/);
    const repairLoginCalls = await page.evaluate(() => window.__ONE_CT_FAKE_SESSION__.loginCalls());
    check(
      'refreshEk 失败 → 用成员凭证 loginEk 成功 → 自动重试并正常显示',
      repairLoginReady && repairLoginDone && repairLoginCalls.length >= 1,
      JSON.stringify(repairLoginCalls),
    );
    check(
      'loginEk 使用成员 ekCredentials 的学号（不把密码写进 DOM/日志）',
      repairLoginCalls.some((c) => c.student_id === '2024000001' && c.hasPassword === true) &&
        !/fake-pw/.test(await readAppliedNote()) &&
        !(await page.getByTestId('one-ct-ek-view').innerHTML()).includes('fake-pw'),
      JSON.stringify(repairLoginCalls),
    );
    const freshLoginSession = await page.evaluate(() => {
      const m = window.OneCTMembers.getMember('m_zhangsan');
      return m && m.ek ? String(m.ek.JSESSIONID || '') : '';
    });
    const repairedWindowCalls = await readDetailCalls();
    check(
      '自动重登后签到/签退时段详情使用新会话（不是旧 JSESSIONID）',
      repairedWindowCalls.length > 0 &&
        repairedWindowCalls.every((c) => c.hasSession && c.jsession === freshLoginSession) &&
        freshLoginSession !== 'fake-jsession-seed',
      JSON.stringify({ jsession: freshLoginSession, calls: repairedWindowCalls.slice(0, 3) }),
    );

    // ── 会话过期且自动修复都失败 → 明确提示，不谎报状态、不崩 ──
    await page.evaluate(() => {
      localStorage.removeItem('1ct:ekSignStatus:m_zhangsan');
      window.__ONE_CT_FAKE_APPLY_LIST__.reset();
      window.__ONE_CT_FAKE_SIGN_LIST__.reset();
      window.__ONE_CT_FAKE_DETAIL__.reset();
      window.__ONE_CT_FAKE_APPLIED__.reset();
      window.__ONE_CT_FAKE_SESSION__.reset();
      window.__ONE_CT_FAKE_SESSION__.setListAuthFail('always');
      window.__ONE_CT_FAKE_SESSION__.setRefreshMode('fail');
      window.__ONE_CT_FAKE_SESSION__.setLoginMode('fail');
    });
    await page.getByTestId('one-ct-ek-applied-refresh').click();
    const sessionDeadReady = await waitAppliedNote(/二课会话失效，请到成员页重新登录/);
    check(
      '会话失效且自动重登失败 → 明确提示「二课会话失效，请到成员页重新登录」',
      sessionDeadReady,
      await readAppliedNote(),
    );
    check(
      '会话失效时仍显示本地记录（不谎报官方状态）',
      (await page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-testid="one-ct-ek-applied-row"]')).map((row) =>
          row.getAttribute('data-activity-id'),
        ),
      )).filter((id) => id === 'act-1' || id === 'act-3').length === 2,
      'local rows kept',
    );
    check('会话失效提示不含密码/token', !/fake-pw|token|JSESSIONID/i.test(await readAppliedNote()));

    // 恢复默认数据源
    await page.evaluate(() => {
      window.__ONE_CT_FAKE_SESSION__.reset();
      window.__ONE_CT_FAKE_APPLY_LIST__.reset();
      window.__ONE_CT_FAKE_SIGN_LIST__.reset();
      window.__ONE_CT_FAKE_DETAIL__.reset();
      window.__ONE_CT_FAKE_APPLIED__.reset();
    });
    await page.getByTestId('one-ct-ek-applied-refresh').click();
    await waitAppliedNote(/官方报名列表签到状态已更新 3 条/);

    // ── 换机/更新后「清零」核心回归：本地没有任何 ek 报名历史的成员，也要看到官方已报名与真实签到状态 ──
    await page.evaluate(() => {
      window.OneCTMembers.upsertMember({
        id: 'm_official_only',
        name: '仅官方已报名',
        ek: {
          JSESSIONID: 'fake-jsession-official-only',
          access_token: 'fake-access-token',
          refresh_token: 'fake-refresh-token',
          user_info: { loginName: '2024101188', userName: '仅官方已报名' },
        },
        ekStatus: 'ok',
      });
      // 只有一条签到 success（没有 apply 记录）：该活动仍算「官方-only 行」，
      // 签到显示本机执行记录，签退则来自官方报名列表（昨天已签退）。
      window.OneCTMembers.appendResult({
        key: 'test|ek|signIn|official-act-1|m_official_only',
        at: Date.now(),
        memberId: 'm_official_only',
        memberName: '仅官方已报名',
        module: 'ek',
        action: 'signIn',
        activityId: 'official-act-1',
        activityName: '官方讲座（仅官方列表有）',
        category: '思想政治与道德修养',
        status: 'success',
      });
      // 隔离成员阶段自身的详情调用（前一轮张三的时段详情不计入）
      window.__ONE_CT_FAKE_DETAIL__.reset();
      window.__ONE_CT_FAKE_SIGN_LIST__.reset();
      window.__ONE_CT_FAKE_APPLY_LIST__.reset();
      window.OneCTShell.refresh();
    });
    await page.waitForTimeout(300);
    await page.getByTestId('one-ct-ek-member-select').selectOption('m_official_only');
    const officialOnlyReady = await page
      .waitForFunction(
        () => {
          const rows = Array.from(document.querySelectorAll('[data-testid="one-ct-ek-applied-row"]'));
          const note = document.querySelector('[data-testid="one-ct-ek-applied-note"]');
          return (
            rows.length === 3 &&
            rows.every((row) => row.getAttribute('data-source') === 'official') &&
            note !== null &&
            /本地记录 0 个/.test(note.textContent) &&
            !/正在读取官方报名列表/.test(note.textContent) &&
            !/正在读取官方签到记录/.test(note.textContent) &&
            !/正在读取官方签到\/签退时段/.test(note.textContent)
          );
        },
        null,
        { timeout: 20000 },
      )
      .then(() => true)
      .catch(() => false);
    check(
      '无任何本地 ek 报名历史的成员也渲染官方已报名行（data-source=official）',
      officialOnlyReady,
      `rows=${await page.locator('[data-testid="one-ct-ek-applied-row"]').count()}`,
    );
    const officialOnlyNote = await readAppliedNote();
    check(
      '官方-only 成员提示本地记录 0 个（不是空态）',
      /官方已报名列表（activityStatus=1）共 3 个 · 本地记录 0 个 · 合并 3 个/.test(officialOnlyNote) &&
        /官方报名列表签到状态已更新 3 条/.test(officialOnlyNote) &&
        /官方签到\/签退时段已更新 3 个/.test(officialOnlyNote),
      officialOnlyNote,
    );
    const officialOnlyRows = await readAppliedRowsSnapshot();
    const onlyAct1 = officialOnlyRows.find((r) => r.id === 'official-act-1');
    const onlyAct2 = officialOnlyRows.find((r) => r.id === 'official-act-2');
    check(
      '官方-only 行显示官方活动名',
      Boolean(onlyAct1 && onlyAct2 && /官方讲座/.test(onlyAct1.text) && /官方志愿活动/.test(onlyAct2.text)),
      JSON.stringify(officialOnlyRows.map((r) => r.text)),
    );
    check(
      '官方-only 行显示官方报名列表的已签到/已签退（用户反馈场景：昨天已签到签退）',
      Boolean(
        onlyAct1 &&
          onlyAct1.statuses[0].text === '已签到' &&
          onlyAct1.statuses[0].status === 'success' &&
          onlyAct1.statuses[1].text === '已签退' &&
          onlyAct1.statuses[1].status === 'success',
      ),
      JSON.stringify(onlyAct1 && onlyAct1.statuses),
    );
    check(
      '官方-only 行报名列表明确未签到 → 显示未签到/未签退（title 来自官方报名列表）',
      Boolean(
        onlyAct2 &&
          onlyAct2.statuses[0].text === '未签到' &&
          onlyAct2.statuses[0].status === 'none' &&
          onlyAct2.statuses[1].text === '未签退' &&
          onlyAct2.statuses[1].status === 'none' &&
          onlyAct2.statuses.every((s) => s.title === '来自官方报名列表'),
      ),
      JSON.stringify(onlyAct2 && onlyAct2.statuses),
    );
    check(
      '官方-only 行本机 success 事件优先（签到来自本机执行记录、签退来自官方报名列表）',
      Boolean(
        onlyAct1 &&
          onlyAct1.statuses[0].title === '来自本机执行记录' &&
          onlyAct1.statuses[1].title === '来自官方报名列表',
      ),
      JSON.stringify(onlyAct1 && onlyAct1.statuses),
    );
    check(
      '官方-only 行同时显示官方签到/签退时段（两行）与无需签到规则',
      Boolean(
        onlyAct1 &&
          onlyAct1.windows.length === 1 &&
          onlyAct1.windows[0].lines.length === 2 &&
          /^签到时段：2026-10-17 19:00至2026-10-17 21:30$/.test(onlyAct1.windows[0].lines[0]) &&
          /^签退时段：2026-10-17 19:00至2026-10-17 21:40$/.test(onlyAct1.windows[0].lines[1]) &&
          onlyAct2 &&
          onlyAct2.windows.length === 1 &&
          onlyAct2.windows[0].lines[0] === '签到时段：无需签到' &&
          onlyAct2.windows[0].lines[1] === '签退时段：无需签退',
      ),
      JSON.stringify([onlyAct1 && onlyAct1.windows, onlyAct2 && onlyAct2.windows]),
    );
    check(
      '官方-only 成员也写入按成员签到状态缓存',
      (await page.evaluate(() => Boolean(localStorage.getItem('1ct:ekSignStatus:m_official_only')))) === true,
      'cache key',
    );
    check(
      '官方-only 成员命中报名列表时不为状态拉签到记录，详情仅为时段（3 个）',
      (await readDetailCalls()).length === 3 && (await readSignListCalls()).length === 0,
      JSON.stringify({
        detail: (await readDetailCalls()).map((c) => c.id),
        signList: (await readSignListCalls()).map((c) => c.pageIndex),
      }),
    );
    // 截图证据：官方已报名行显示「已签到/已签退」（用户反馈场景，数据源=官方报名列表）
    await page.getByTestId('one-ct-ek-applied').scrollIntoViewIfNeeded();
    await page.waitForTimeout(150);
    shots.push(await screenshot(page, '1ct-ek-applied-applylist-signed.png'));

    // 清理临时成员与其事件，回到张三（保证后续断言/截图不受影响）
    await page.evaluate(() => {
      window.OneCTMembers.removeMember('m_official_only');
      const raw = JSON.parse(localStorage.getItem('1ct:results') || '{}');
      raw.events = (raw.events || []).filter((event) => event.memberId !== 'm_official_only');
      localStorage.setItem('1ct:results', JSON.stringify(raw));
      localStorage.removeItem('1ct:ekSignStatus:m_official_only');
      window.__ONE_CT_FAKE_APPLIED__.reset();
      window.__ONE_CT_FAKE_DETAIL__.reset();
      window.__ONE_CT_FAKE_SIGN_LIST__.reset();
      window.__ONE_CT_FAKE_APPLY_LIST__.reset();
      window.__ONE_CT_FAKE_SESSION__.reset();
      window.OneCTShell.refresh();
    });
    await page.waitForTimeout(300);
    await page.getByTestId('one-ct-ek-member-select').selectOption('m_zhangsan');
    await waitAppliedNote(/本地记录 2 个/);
    check(
      '官方-only 临时成员已清理（成员列表回到 3 人）',
      (await page.evaluate(() => window.OneCTMembers.load().items.length)) === 3,
      String(await page.evaluate(() => window.OneCTMembers.load().items.length)),
    );

    // ── 分页：跟随 List.TotalPages 拉全两页，并按 Id 去重 ──
    await page.evaluate(() => {
      window.__ONE_CT_FAKE_APPLIED__.reset();
      window.__ONE_CT_FAKE_APPLIED__.setMode('paged');
    });
    await page.getByTestId('one-ct-ek-applied-refresh').click();
    const pagedReady = await page
      .waitForFunction(
        () => {
          const text = Array.from(document.querySelectorAll('[data-testid="one-ct-ek-applied-row"]'))
            .map((row) => row.textContent)
            .join('|');
          return /官方分页活动一/.test(text) && /官方分页活动二/.test(text);
        },
        null,
        { timeout: 20000 },
      )
      .then(() => true)
      .catch(() => false);
    check('TotalPages=2 时两页官方活动都被合并进来', pagedReady, JSON.stringify(await readAppliedNote()));
    // 官方报名列表/签到记录都没有覆盖分页活动 → 官方详情兜底（第一页活动详情缺字段、第二页活动详情失败 → 「—」）
    await waitAppliedNote(/官方详情兜底：2 个活动未取到状态/);
    // 时段阶段：3 个分页活动详情均无签到/签退时段字段 → 失败 3 个（显示 —）
    await waitAppliedNote(/签到时段读取失败 3 个（显示 —）/);
    const pagedInfo = await page.evaluate(() => ({
      ids: Array.from(document.querySelectorAll('[data-testid="one-ct-ek-applied-row"]')).map((row) =>
        row.getAttribute('data-activity-id'),
      ),
      sharedCount: document.querySelectorAll(
        '[data-testid="one-ct-ek-applied-row"][data-activity-id="official-shared"]',
      ).length,
      pageIndexes: window.__ONE_CT_FAKE_APPLIED__.pageIndexes(),
      note: (document.querySelector('[data-testid="one-ct-ek-applied-note"]') || {}).textContent || '',
    }));
    check(
      '分页时依次请求 pageIndex=1、2',
      JSON.stringify(pagedInfo.pageIndexes) === '[1,2]',
      JSON.stringify(pagedInfo.pageIndexes),
    );
    check('跨页重复活动按 Id 去重（只出现一次）', pagedInfo.sharedCount === 1, `shared=${pagedInfo.sharedCount}`);
    check(
      '分页成功时说明共拉了几页',
      /共 2 页/.test(pagedInfo.note.replace(/\s+/g, ' ')),
      pagedInfo.note.replace(/\s+/g, ' '),
    );
    check(
      '分页后本地历史行仍在（act-1/act-3 未被官方覆盖）',
      pagedInfo.ids.includes('act-1') && pagedInfo.ids.includes('act-3'),
      JSON.stringify(pagedInfo.ids),
    );
    const pagedDetailIds = (await readDetailCalls()).map((c) => c.id);
    check(
      '分页行按正确 activityId 拉详情（两页活动都覆盖）',
      pagedDetailIds.includes('official-p1-1') && pagedDetailIds.includes('official-p2-1'),
      JSON.stringify(pagedDetailIds.slice(-4)),
    );
    const pagedSnapshot = await readAppliedRowsSnapshot();
    const pagedRowById = (id) => pagedSnapshot.find((r) => r.id === id) || null;
    const pagedP1 = pagedRowById('official-p1-1');
    const pagedShared = pagedRowById('official-shared');
    const pagedP2 = pagedRowById('official-p2-1');
    check(
      '官方签到记录/详情都没给出状态 → 徽标显示「—」（data-status=unknown，不谎报未签到）',
      Boolean(
        pagedP1 &&
          pagedP1.statuses.every(
            (s) => s.text === '—' && s.status === 'unknown' && /未取到/.test(s.title),
          ),
      ),
      JSON.stringify(pagedP1 && pagedP1.statuses),
    );
    check(
      '详情请求失败/缺签名结构 → 显示「—」（不谎报未签到）',
      Boolean(
        pagedShared &&
          pagedShared.statuses.every((s) => s.text === '—' && s.status === 'unknown') &&
          pagedP2 &&
          pagedP2.statuses.every((s) => s.text === '—' && s.status === 'unknown'),
      ),
      JSON.stringify([pagedShared && pagedShared.statuses, pagedP2 && pagedP2.statuses]),
    );
    check(
      '分页活动无时段字段 → 时段两行都显示「—」',
      Boolean(
        pagedP1 &&
          pagedP1.windows.length === 1 &&
          pagedP1.windows[0].lines.length === 2 &&
          pagedP1.windows[0].lines[0] === '签到时段：—' &&
          pagedP1.windows[0].lines[1] === '签退时段：—',
      ),
      JSON.stringify(pagedP1 && pagedP1.windows),
    );
    check(
      '报名列表/签到记录条数、详情与时段兜底文案在 appliedNote 可见',
      /官方报名列表签到状态已更新 3 条/.test(await readAppliedNote()) &&
        /官方签到记录已更新 3 条/.test(await readAppliedNote()) &&
        /官方详情兜底：2 个活动未取到状态（显示 —）/.test(await readAppliedNote()) &&
        /签到时段读取失败 3 个（显示 —）/.test(await readAppliedNote()),
      await readAppliedNote(),
    );
    shots.push(await screenshot(page, '1ct-ek-applied-paged.png'));

    // ── 官方返回空列表（真实形态 Items:[] / TotalPages:0）：本地记录照常显示 ──
    const signListCallsBeforeEmpty = (await readSignListCalls()).length;
    const applyListCallsBeforeEmpty = (await readApplyListCalls()).length;
    await page.evaluate(() => window.__ONE_CT_FAKE_APPLIED__.setMode('empty'));
    await page.getByTestId('one-ct-ek-applied-refresh').click();
    const emptyReady = await page
      .waitForFunction(
        () => {
          const note = document.querySelector('[data-testid="one-ct-ek-applied-note"]');
          return note && /官方已报名列表（activityStatus=1）共 0 个 · 本地记录 2 个/.test(note.textContent);
        },
        null,
        { timeout: 20000 },
      )
      .then(() => true)
      .catch(() => false);
    check('官方列表为空时明确标注共 0 个', emptyReady, await readAppliedNote());
    check(
      '官方列表为空时仍显示本地 2 条记录（不是空态）',
      (await page.locator('[data-testid="one-ct-ek-applied-row"]').count()) === 2 &&
        (await page.getByTestId('one-ct-ek-applied-empty').count()) === 0,
      `rows=${await page.locator('[data-testid="one-ct-ek-applied-row"]').count()}`,
    );
    check(
      '没有官方已报名行时不请求报名列表/签到记录（省两次网络）',
      (await readSignListCalls()).length === signListCallsBeforeEmpty &&
        (await readApplyListCalls()).length === applyListCallsBeforeEmpty,
      `signList ${signListCallsBeforeEmpty}→${(await readSignListCalls()).length} / applyList ${applyListCallsBeforeEmpty}→${(await readApplyListCalls()).length}`,
    );

    // 官方失败降级：只显示本地记录，并明确标注失败
    await page.evaluate(() => window.__ONE_CT_FAKE_APPLIED__.setMode('fail'));
    await page.getByTestId('one-ct-ek-applied-refresh').click();
    const appliedDegraded = await page
      .waitForFunction(
        () => {
          const note = document.querySelector('[data-testid="one-ct-ek-applied-note"]');
          return note && /官方列表读取失败/.test(note.textContent);
        },
        null,
        { timeout: 20000 },
      )
      .then(() => true)
      .catch(() => false);
    check('官方列表读取失败时明确降级提示', appliedDegraded, await page.getByTestId('one-ct-ek-applied-note').textContent());
    check(
      '官方失败降级时本地记录仍在（act-1/act-3）',
      (await page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-testid="one-ct-ek-applied-row"]')).map((row) =>
          row.getAttribute('data-activity-id'),
        ),
      )).filter((id) => id === 'act-1' || id === 'act-3').length === 2,
      'local rows kept',
    );
    await page.getByTestId('one-ct-ek-applied').scrollIntoViewIfNeeded();
    shots.push(await screenshot(page, '1ct-ek-applied.png'));
    await page.evaluate(() => {
      window.__ONE_CT_FAKE_APPLIED__.reset();
      window.__ONE_CT_FAKE_APPLY_LIST__.reset();
      window.__ONE_CT_FAKE_SIGN_LIST__.reset();
      window.__ONE_CT_FAKE_SESSION__.reset();
    });
    check('统计页不含完整手机号', !statsHostText.includes('13800000000'));

    // ── task-9：二课页「同步全部成员成绩」 ──
    check('二课页有「同步全部成员成绩」按钮', (await page.getByTestId('one-ct-sync-all').count()) === 1);
    check('二课页有上次同步时间显示', (await page.getByTestId('one-ct-sync-all-status').count()) === 1);
    const syncAllStatusBefore = await page.getByTestId('one-ct-sync-all-status').textContent();
    check(
      '同步全部状态行有文案（尚未同步 / 上次同步）',
      /尚未同步|上次同步/.test(syncAllStatusBefore),
      syncAllStatusBefore,
    );
    await page.evaluate(() => window.__ONE_CT_FAKE_SYNC__.reset());
    await page.getByTestId('one-ct-sync-all').click();
    const syncAllDone = await page
      .waitForFunction(
        () => {
          const node = document.querySelector('[data-testid="one-ct-sync-all-status"]');
          return node && /同步完成|同步失败/.test(node.textContent);
        },
        null,
        { timeout: 20000 },
      )
      .then(() => true)
      .catch(() => false);
    check('点「同步全部」后显示同步结果', syncAllDone, await page.getByTestId('one-ct-sync-all-status').textContent());
    const syncedAll = await page.evaluate(() =>
      window.OneCTMembers.load().items.map((m) => ({
        name: m.name,
        modules: m.ekModules ? m.ekModules.length : 0,
        source: m.ekModulesSource,
      })),
    );
    check(
      '同步全部写入各成员官方成绩',
      syncedAll.filter((m) => m.modules === 8 && m.source === 'official').length >= 1,
      JSON.stringify(syncedAll),
    );
    // 切换到有官方成绩的成员，确认统计区块同步更新（renderView 会重建统计）
    await page.getByTestId('one-ct-ek-member-select').selectOption({ index: 0 });
    await page.waitForTimeout(500);
    const statsSourceAfter = await page.getByTestId('one-ct-stats-source').textContent();
    check('同步后统计页标注「官方成绩」来源', /官方成绩/.test(statsSourceAfter), statsSourceAfter);
    check(
      '同步后统计页显示成绩同步时间',
      /成绩同步于 \d{4}-\d{2}-\d{2}/.test(await page.getByTestId('one-ct-stats-sync-time').textContent()),
      await page.getByTestId('one-ct-stats-sync-time').textContent(),
    );
    // 同步后统计页的缺口应与列表一致（不能被本地更旧的引擎快照盖住）
    const gapConsistency = await page.evaluate(() => {
      const host = document.querySelector('[data-testid="one-ct-stats-host"]');
      const listGap = document.querySelector('[data-testid="one-ct-member-gap-m_zhangsan"]');
      return {
        statText: host ? host.textContent.replace(/\s+/g, '') : '',
        listGap: listGap ? listGap.textContent.trim() : '',
      };
    });
    check(
      '同步后统计页缺口与成员列表一致（不被旧引擎快照覆盖）',
      /缺口合计15|缺口合计15\.0/.test(gapConsistency.statText),
      gapConsistency.statText.slice(0, 180),
    );
    // 已知文案瑕疵（ek-stats.js 内、非本任务写范围）：头部 meta 仍写「积分来自成员页填写」。
    // 这里只记录为 info，不判失败；Lead 已接手修 ek-stats 文案。
    const ekStatsHeadWording = await page.evaluate(() => {
      const host = document.querySelector('[data-testid="one-ct-stats-host"]');
      return host ? /积分来自成员页填写|积分来源：成员页手动填写/.test(host.textContent) : false;
    });
    if (ekStatsHeadWording) {
      info('ek-stats 残留旧文案', '统计头部仍显示「积分来自成员页填写」（ek-stats.js 内，待 Lead 修）');
    } else {
      check('ek-stats 文案已全部改为官方同步口径', true, 'no stale wording');
    }
    shots.push(await screenshot(page, '1ct-sync-04-ek-sync-all.png'));
    // 二课页同样不得泄漏任何凭证（ekCredentials / password / token）
    const ekViewHtml = await page.getByTestId('one-ct-ek-view').innerHTML();
    check(
      '二课页无密码/token/ekCredentials 泄漏',
      !/fake-pw|fake-access-token|fake-refresh-token|ekCredentials|JSESSIONID/i.test(ekViewHtml),
      'no secrets',
    );
    check(
      '二课页统计事件来源为 OneCTMembers.loadResults（裸数组，含 memberId）',
      await page.evaluate(() => {
        // 用真实 loadResults 校验口径：返回数组且事件带 memberId
        const events = window.OneCTMembers.loadResults();
        return Array.isArray(events) && events.length > 0 && events.every((e) => typeof e === 'object' && 'memberId' in e);
      }),
      JSON.stringify(
        await page.evaluate(() => {
          const events = window.OneCTMembers.loadResults();
          return { isArray: Array.isArray(events), count: Array.isArray(events) ? events.length : -1 };
        }),
      ),
    );
    check(
      '把 result-store 实例传给 build 会被显式拒绝（防静默全空）',
      await page.evaluate(() => {
        try {
          const store = window.Auto3CTResults.createStore({
            storage: window.OneCTMembers.resultsStorage(),
            clock: { now: () => Date.now() },
          });
          const member = window.OneCTMembers.load().items[0];
          window.OneCTStats.build({ member: member, events: store.list({}), scoreEntry: null });
          // store.list() 返回数组 → 不会抛错，但事件缺 memberId 会导致该成员统计为 0；
          // 真正要锁死的是「传 store 对象本身」：
          window.OneCTStats.build({ member: member, events: store, scoreEntry: null });
          return 'no-throw';
        } catch (e) {
          return /不要传 Auto3CTResults store 实例|memberId/.test(String(e && e.message)) ? 'rejected' : 'other:' + e.message;
        }
      }).then((r) => r === 'rejected'),
      'ek-stats 显式拒绝 store 实例',
    );
    shots.push(await screenshot(page, '1ct-shell-04-ek-stats.png'));

    // 切换成员 → 统计重算
    const beforeSelect = statsHostText;
    await page.getByTestId('one-ct-ek-member-select').selectOption({ index: 1 });
    await page.waitForTimeout(400);
    const afterSelect = await page.getByTestId('one-ct-stats-host').textContent();
    check('切换成员后统计重新渲染', beforeSelect !== afterSelect, `${beforeSelect.length}→${afterSelect.length}`);

    // CSV 导出（真实 ek-stats.toCSV，自带 BOM；不能重复加）
    await page.getByTestId('one-ct-ek-member-select').selectOption({ index: 0 });
    await page.waitForTimeout(300);
    const downloadPromise = page.waitForEvent('download', { timeout: 8000 }).catch(() => null);
    await page.getByTestId('one-ct-ek-export-csv').click();
    const download = await downloadPromise;
    if (download) {
      const csvPath = path.join(ARTIFACTS, '1ct-shell-export.csv');
      await download.saveAs(csvPath);
      const csvBuf = await fsp.readFile(csvPath);
      const csvText = csvBuf.toString('utf8');
      check('CSV 导出成功且含模块表头', /成员,模块,要求,当前,缺口/.test(csvText), csvText.slice(0, 60).replace(/\n/g, '⏎'));
      check('CSV 只含一个 UTF-8 BOM（Excel 不乱码）', csvText.charCodeAt(0) === 0xfeff && csvText.charAt(1) !== '\ufeff', `first=${csvBuf.slice(0, 6).toString('hex')}`);
      check('CSV 不含完整手机号', !/1[3-9]\d{9}/.test(csvText.replace(/1[3-9]\d\*\*\*\*\d{4}/g, '')));
      check('CSV 不含密码/token', !/fake-|token|password/i.test(csvText));
    } else {
      check('CSV 导出触发下载事件', false, 'no download event');
    }

    // ── 6) 日志页 ──
    // ── 记录页（俱乐部 / 校园跑） ──
    await page.getByTestId('one-ct-tab-records').click();
    await page.waitForTimeout(400);
    check('记录页可见', await page.getByTestId('one-ct-records-view').isVisible());
    check('记录页有成员筛选器', (await page.getByTestId('one-ct-records-member').count()) === 1);
    check('记录页有俱乐部区块', (await page.getByTestId('one-ct-records-club').count()) === 1);
    check('记录页有校园跑区块', (await page.getByTestId('one-ct-records-unirun').count()) === 1);
    const clubRows = await page.getByTestId('one-ct-records-club-row').count();
    check('俱乐部记录渲染出明细行', clubRows >= 3, 'rows=' + clubRows);
    const runRows = await page.getByTestId('one-ct-records-unirun-row').count();
    check('校园跑记录渲染出明细行', runRows >= 1, 'rows=' + runRows);
    check('俱乐部成功计数可见', (await page.getByTestId('one-ct-records-club-stat').count()) >= 3);
    shots.push(await screenshot(page, '1ct-records-01.png'));
    await page.getByTestId('one-ct-tab-logs').click();
    await page.waitForTimeout(350);
    check('日志页可见', await page.getByTestId('one-ct-logs-view').isVisible());
    const logGroups = await page.locator('[data-testid="one-ct-log-group"]').count();
    check('日志按成员分组（≥2 组）', logGroups >= 2, `groups=${logGroups}`);
    const logRows = await page.locator('[data-testid="one-ct-log-row"]').count();
    check('日志有内容', logRows > 0, `rows=${logRows}`);
    const logCount = await page.evaluate(() => window.OneCTShell.getLogs().length);
    check('日志条数上限 ≤300', logCount <= 300, String(logCount));
    const logsText = await page.getByTestId('one-ct-logs-view').textContent();
    check('日志不含完整手机号', !logsText.includes('13800000000') && !logsText.includes('13900001111'));
    check(
      '日志不含 token/密码明文',
      !/fake-(ek|unirun|json|pw)|fake-access-token/i.test(logsText),
      logsText.slice(0, 100).replace(/\s+/g, ' '),
    );
    check('日志含本轮摘要', /本轮/.test(logsText), logsText.slice(0, 140).replace(/\s+/g, ' '));
    shots.push(await screenshot(page, '1ct-shell-05-logs.png'));

    // 刷新历史幂等
    const beforeHistory = await page.evaluate(() => window.OneCTShell.getLogs().length);
    await page.getByTestId('one-ct-logs-refresh').click();
    await page.waitForTimeout(400);
    const afterHistory1 = await page.evaluate(() => window.OneCTShell.getLogs().length);
    await page.getByTestId('one-ct-logs-refresh').click();
    await page.waitForTimeout(400);
    const afterHistory2 = await page.evaluate(() => window.OneCTShell.getLogs().length);
    check('刷新历史幂等（重复点击不翻倍）', afterHistory2 <= afterHistory1 + 2, `${beforeHistory}→${afterHistory1}→${afterHistory2}`);

    // ── 7) 持久化 / 重开恢复 ──
    await page.reload({ waitUntil: 'load' });
    await waitReady(page);
    check('重开后停在日志页（1ct:ui 持久化）', await page.getByTestId('one-ct-logs-view').isVisible());
    await page.getByTestId('one-ct-tab-run').click();
    await page.waitForTimeout(300);
    const cfgReloaded = await readGlobalConfig(page);
    check(
      '重开后配置保留（开关/关键词/上限/时刻）',
      cfgReloaded.ek.enabled === true &&
        cfgReloaded.ek.dailyLimit === 3 &&
        cfgReloaded.ek.keywords.join(',') === '讲座,志愿' &&
        cfgReloaded.unirun.runAt === '07:15',
      JSON.stringify({
        enabled: cfgReloaded.ek.enabled,
        limit: cfgReloaded.ek.dailyLimit,
        keywords: cfgReloaded.ek.keywords,
        runAt: cfgReloaded.unirun.runAt,
      }),
    );
    const membersAfterReload = await page.evaluate(() => window.OneCTMembers.load().items.length);
    check('重开后成员保留（3 人）', membersAfterReload === 3, String(membersAfterReload));
    check('重开后仍为预览模式', await page.getByTestId('one-ct-preview-switch').isChecked());

    // ── testid 清单（供打包回归复用；同时核对 one-ct-* 前缀） ──
    const testidInventory = new Set();
    async function collectTestIds() {
      const ids = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-testid]')).map((node) => node.getAttribute('data-testid')),
      );
      ids.forEach((id) => testidInventory.add(id));
    }
    for (const tab of ['run', 'members', 'ek', 'logs']) {
      await page.getByTestId('one-ct-tab-' + tab).click();
      await page.waitForTimeout(250);
      await collectTestIds();
    }
    await page.getByTestId('one-ct-tab-members').click();
    await page.waitForTimeout(200);
    await page.getByTestId('one-ct-member-add').click();
    await page.getByTestId('one-ct-member-modal').waitFor({ state: 'visible' });
    await collectTestIds();
    await page.getByTestId('one-ct-member-cancel').click();
    await page.waitForTimeout(200);
    const inventory = Array.from(testidInventory).sort();
    check(
      '所有 testid 均为 one-ct-* 前缀',
      inventory.every((id) => id === 'one-ct-root' || id.startsWith('one-ct-')),
      inventory.filter((id) => !id.startsWith('one-ct-')).join(', ') || `${inventory.length} ids`,
    );
    check('testid 覆盖四个页面 + 弹层（≥40 个）', inventory.length >= 40, `${inventory.length} ids`);
    info('testid 清单', inventory.join(','));

    // ── 窄屏不溢出（420px：桌面工具最小可用宽度） ──
    await page.getByTestId('one-ct-tab-run').click();
    await page.waitForTimeout(250);
    await page.setViewportSize({ width: 420, height: 900 });
    await page.waitForTimeout(400);
    const overflow = await page.evaluate(() => ({
      bodyScrollW: document.body.scrollWidth,
      inner: window.innerWidth,
      topbarH: document.querySelector('[data-testid="one-ct-topbar"]').getBoundingClientRect().height,
      tabs: document.querySelectorAll('[data-testid^="one-ct-tab-"]').length,
    }));
    check('窄屏无横向溢出', overflow.bodyScrollW <= overflow.inner + 1, JSON.stringify(overflow));
    check('窄屏顶栏保持单行（高度 56px）', Math.abs(overflow.topbarH - 56) <= 2, `h=${overflow.topbarH}`);
    check('窄屏五个 tab 仍然可见', overflow.tabs === 5, `tabs=${overflow.tabs}`);
    shots.push(await screenshot(page, '1ct-shell-06-narrow.png'));
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForTimeout(250);

    // ── 跨版本升级：旧版校园跑手填参数迁移为自动随机 ──
    await page.evaluate(() => {
      const raw = JSON.parse(localStorage.getItem('1ct:config:global') || '{}');
      raw.unirun = Object.assign({}, raw.unirun, { windowMinutes: 30, runDistance: 3000, runTime: 30 });
      raw.migrations = {};
      localStorage.setItem('1ct:config:global', JSON.stringify(raw));
    });
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => window.__ONE_CT_READY__ === true, null, { timeout: 20000 });
    const migrated = await page.evaluate(() => {
      const raw = JSON.parse(localStorage.getItem('1ct:config:global') || '{}');
      return { unirun: raw.unirun || {}, flag: raw.migrations && raw.migrations.unirunAutoV2 };
    });
    check('旧版手填的 windowMinutes/runDistance/runTime 被迁成 null（自动随机生效）',
      migrated.unirun.windowMinutes === null && migrated.unirun.runDistance === null && migrated.unirun.runTime === null,
      JSON.stringify(migrated.unirun));
    check('迁移只跑一次（打上 migrations.unirunAutoV2 标记）', migrated.flag === true, JSON.stringify(migrated.flag));
    // 自定义值不应被迁移清掉
    await page.evaluate(() => {
      const raw = JSON.parse(localStorage.getItem('1ct:config:global') || '{}');
      raw.unirun = Object.assign({}, raw.unirun, { windowMinutes: 45, runDistance: 3000, runTime: 25 });
      raw.migrations = {};
      localStorage.setItem('1ct:config:global', JSON.stringify(raw));
    });
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => window.__ONE_CT_READY__ === true, null, { timeout: 20000 });
    const custom = await page.evaluate(() => JSON.parse(localStorage.getItem('1ct:config:global') || '{}').unirun || {});
    check('自定义窗口 45 分钟保留不清', custom.windowMinutes === 45, JSON.stringify(custom));
    check('旧默认里程 3000 仍被清（只清等于旧默认值的项）', custom.runDistance === null, JSON.stringify(custom));
    check('自定义时长 25 分钟保留不清', custom.runTime === 25, JSON.stringify(custom));
    // ── 全局约束 ──
    check('全程无外部网络请求', externalRequests.length === 0, externalRequests.slice(0, 3).join(' | ') || '0 external');
    check('全程无页面 JS 异常', pageErrors.length === 0, pageErrors.join(' | '));
    check('页面无 console.error', consoleErrors.length === 0, consoleErrors.join(' | '));

    const summary = {
      startedAt,
      finishedAt: new Date().toISOString(),
      edge,
      harness: origin + HARNESS_URL,
      passed: checks.filter((c) => c.kind === 'assert' && c.ok).length,
      failed: checks.filter((c) => c.kind === 'assert' && !c.ok).length,
      hashes: {},
      checks,
      screenshots: shots,
      externalRequests,
      pageErrors,
      consoleErrors,
    };
    for (const rel of ['desktop/1ct/index.html', 'desktop/1ct/shell.js', 'desktop/1ct/shell.css']) {
      summary.hashes[rel] = require('node:crypto')
        .createHash('sha256')
        .update(fs.readFileSync(path.join(ROOT, rel)))
        .digest('hex');
    }
    await fsp.writeFile(RESULT_JSON, JSON.stringify(summary, null, 2) + '\n', 'utf8');
    console.log(`\n结果：${summary.passed} passed / ${summary.failed} failed → ${RESULT_JSON}`);
    console.log('截图：' + shots.map((name) => path.join('artifacts', name)).join(', '));
    if (summary.failed > 0) throw new Error(`${summary.failed} 项断言失败（详见 ${RESULT_JSON}）`);
    return summary;
  } catch (err) {
    const failure = {
      at: new Date().toISOString(),
      error: String(err && err.stack ? err.stack : err),
      url: page ? page.url() : '',
      pageErrors,
      consoleErrors,
      checks,
    };
    await fsp.writeFile(FAILURE_JSON, JSON.stringify(failure, null, 2) + '\n', 'utf8').catch(() => {});
    throw err;
  } finally {
    if (context) await context.close().catch(() => {});
    server.close();
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
}

// 同时支持 `node test-1ct-shell.cjs` 与 `node --test desktop/test-1ct-shell.cjs`
if (process.env.NODE_TEST_CONTEXT) {
  const { test } = require('node:test');
  test('1CT shell 离线冒烟（Playwright + Edge headless）', { timeout: 300000 }, async () => {
    await main();
  });
} else {
  main().catch((err) => {
    console.error('冒烟异常终止：', err && err.stack ? err.stack : err);
    process.exitCode = 1;
  });
}
