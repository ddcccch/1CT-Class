/**
 * 3CT AutoPanel 业务自动化引擎（纯前端 JS，渲染层可直接运行）。
 *
 * 口径：默认 dry-run；去重 fail-closed（inflight 落盘失败即不提交，状态损坏禁用自动写）；
 * 失败终态锁定；单飞；一律北京时间；缺材料 → waiting-material，绝不假成功；
 * 结果/日志/导出不含 token、密码、完整手机号。
 *
 * 依赖注入（便于 Node 测试）：{ api, storage, clock, decodeQr, logger, config }；
 * api 形状 = 3CT preload 的 window.ctAPI（ek/club/unirun/scheduler）。
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

  /**
   * 俱乐部签到/签退窗口默认宽度（分钟）。
   * 历史上固定 5 分钟，实测太窄（用户进场/找定位的时延就会错过），默认改为 15 分钟；
   * 仍可用 `club.signInWindowMinutes` / `club.signOutWindowMinutes` 覆盖。
   */
  var CLUB_SIGNIN_WINDOW_MIN = 15;
  var CLUB_SIGNOUT_WINDOW_MIN = 15;

  /**
   * 校园跑官方配速区间（与上游一致）：给定里程，时长必须让配速落在 4~10 km/h。
   * 区间 = [ceil(km/10*60), floor(km/4*60)] ∩ [5, 300] 分钟。
   * 历史上那套「31~39 分钟 + 末位非 0 + 非 5 的倍数」是臆测规则，已删除。
   */
  var UNIRUN_MIN_SPEED_KMH = 4;
  var UNIRUN_MAX_SPEED_KMH = 10;
  var UNIRUN_MIN_RUNTIME_MIN = 5;
  var UNIRUN_MAX_RUNTIME_MIN = 300;

  var DEFAULTS = {
    dryRun: true,
    accountId: '',
    campusId: '',
    tickMs: 60000, // 默认 60s 一次；窗口内面板可调至 >=15s
    windowTickMs: 20000,
    unirun: {
      enabled: false, // 模块开关：首次默认关，由用户勾选
      // 每日执行时刻，界面可改；非法/空值回落到这个默认值
      runAt: '19:00',
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
       *    默认 1000~1099；当天固定（持久化在 state.unirunDistance），跨天重新随机。
       *  注意：**没有**「末位不得为 0 / 不能是 5 的倍数」这类限制——那是历史臆测，上游并无此规则。
       */
      runDistance: null,
      runDistanceMin: 1000,
      runDistanceMax: 1099,
      /**
       * 时长（分钟）。
       *  - 显式配置（有效数字）→ 用它，但必须满足官方配速（4~10 km/h），否则拦成 pace-out-of-range；
       *  - 未配置（null/''/undefined）→ **按当日里程推导**：时长区间 = 官方 4~10km/h 可行区间 ∩ [5,300]，
       *    在其内随机取整数；当天固定（持久化在 state.unirunTime），跨天重新随机。
       *  - runTimeMin/runTimeMax 默认 null（=不额外限制，只按里程推）。显式给出时与可行区间取**交集**，
       *    交集为空则明确拦下（不猜、不改写用户值）。不要再用「全局 31~39」这种固定区间：
       *    它会让 3km 这类长距离直接无解。
       */
      runTime: null,
      runTimeMin: null,
      runTimeMax: null,
    },
    club: {
      enabled: false,
      keywords: [],
      allowAll: false,
      join: true,
      signIn: true,
      signOut: true,
      dailyJoinLimit: 1,
      /** 签到窗口 = [活动开始, 开始 + N 分钟]（默认 15，旧行为固定 5 分钟） */
      signInWindowMinutes: CLUB_SIGNIN_WINDOW_MIN,
      /** 签退窗口 = [活动结束 - N 分钟, 活动结束]（默认 15，旧行为固定 5 分钟） */
      signOutWindowMinutes: CLUB_SIGNOUT_WINDOW_MIN,
      /**
       * 签到/签退失败重试：最多 N 次尝试、两次之间至少间隔 M 分钟。
       * 只有「学校端明确拒绝（failed）」才重试；unknown（结果不确定）仍立即锁定。
       */
      retryMaxAttempts: 3,
      retryIntervalMinutes: 2,
      /**
       * 坐标来源兜底开关（默认 false）：
       *  - false：只接受 currentSignTask 下发且 activityId 与活动一致时的坐标；
       *  - true ：缺失时允许用活动列表里的 latitude/longitude 兜底，并在结果行 detail 标注 activity-coords。
       * 默认关闭是因为列表坐标可能是另一个校区（用户实测「报到龙泉校区」）。
       * 注意：真实上游的活动列表/我的任务条目**并不下发 latitude/longitude**（2026-10-23 实测字段全集），
       * 所以这条兜底在真实数据上常常取不到值；真正可用的兜底是下面的「签到点坐标」。
       */
      allowActivityCoords: false,
      /**
       * 签到点坐标兜底（成员自己的签到点，例如学院田径场门口）：
       * 学校没下发 currentSignTask 坐标时用它提交，结果行标注 coordSource=fallback-coords。
       * 只在「该活动属于本成员」时使用（跨校区活动已被 club.campusName 拦下）。
       */
      fallbackLatitude: '',
      fallbackLongitude: '',
      /**
       * 校区（'' = 不筛选，保持旧行为；'航空港' / '龙泉' = 只报名/签到本校区的活动）。
       * 上游只在活动名/地址文本里带校区（如「体能锻炼（龙泉）」「龙泉校区第一田径场」），
       * 没有任何结构化校区别；两个校区的活动在同一天同一时段同时出现在同一份列表里，
       * 不筛选就会出现「报名到另一个校区 → 本校区活动没有可用签到点 → 龙泉签不上」。
       */
      campusName: '',
      /** true = 允许跨校区（默认 false，避免把记录落到别的校区） */
      allowOtherCampus: false,
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
      /**
       * 拍照/定位签到（SignWay=2/3）延迟触发：官方窗口开始后延迟 N 分钟才提交。
       * null/未配置 → 沿用 `qrDelayMinutes`（默认 2 分钟），与二维码分支行为一致。
       */
      photoDelayMinutes: null,
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
    /**
     * 完整时间（含日期）：官方口径是「前缀匹配」，`2026-09-17 18:00:00` / `20260921 18:00` 都要认。
     * 上游活动列表实测形态：`18:00`（只给时刻）、`2026-11-03 17:30`（官方报名列表）。
     */
    var full = /^(\d{4})[-/]?(\d{1,2})[-/]?(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(raw);
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
    /**
     * 只有时刻：前缀匹配（官方 clubUtils 口径），`18:00:00.000` / `18:00 至 19:00` 都能取到 18:00。
     * 历史上要求整串严格等于 `HH:mm[:ss]`，上游只要多带一个 '.' 就整场算不出日期 → missing-date。
     */
    var clock = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(raw);
    if (!clock) return null;
    var dateText = null;
    for (var i = 0; i < (dateSources || []).length; i += 1) {
      var src = String(dateSources[i] == null ? '' : dateSources[i]).trim();
      // 接受 `2026-09-21` / `2026/9/21` / 紧凑 `20260921`（官方都认）
      if (/^(?:\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{8})(?!\d)/.test(src)) {
        dateText = src;
        break;
      }
    }
    if (!dateText) return null;
    var dm = /^(\d{4})[-/]?(\d{1,2})[-/]?(\d{1,2})/.exec(dateText);
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

  /**
   * 完整日期（`2026-09-21` / `2026/9/21` / 紧凑 `20260921`）→ `YYYY-MM-DD`；否则 ''。
   * 也接受**日期+时刻**（`2026-09-21 18:00` / `2026-09-21T18:00:30` / `20260921 18:00`）：
   * 上游 `nextStartTime`/`nextEndTime` 实测就是这种形态，只取其中的日期部分作为日期源；
   * 时刻部分在这里不参与判定（场次时刻另由 clubHhmmss 单独校验）。
   * 必须校验**真实日历**：2026-02-30、2026-13-01、2026-04-31 这类不存在的日期一律拒绝，
   * 否则证据关联会把不存在的日期归一成合法日期而误命中。
   */
  function clubFullDateText(value) {
    var text = String(value == null ? '' : value).trim();
    var m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?)?$/.exec(text);
    if (!m) m = /^(\d{4})(\d{2})(\d{2})(?:[ T]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?)?$/.exec(text);
    if (!m) return '';
    var year = Number(m[1]);
    var month = Number(m[2]);
    var day = Number(m[3]);
    if (year < 2000 || year > 2100) return '';
    if (month < 1 || month > 12 || day < 1 || day > 31) return '';
    // 用北京时区回读校验（2-30 之类被 JS 进位后回读不一致 → 丢弃）
    var back = beijingParts(beijingToMs(year, month, day, 0, 0, 0));
    if (back.year !== year || back.month !== month || back.day !== day) return '';
    return year + '-' + pad2(month) + '-' + pad2(day);
  }

  /**
   * 俱乐部日期归一（实测 `queryMyActivityList.mmdd = '10-22'` 只有月日）：
   *  - 完整日期/紧凑 8 位 → 直接归一；
   *  - 只有 `MM-DD` → 推断年份：取离 today 最近的一次（year-1 / year / year+1），
   *    并列时取过去，避免跨年把过期任务当成今天；
   * 解析不出来返回 ''，绝不猜。
   */
  function resolveClubDateText(value, todayMs) {
    var full = clubFullDateText(value);
    if (full) return full;
    var text = String(value == null ? '' : value).trim();
    var md = /^(\d{1,2})[-/](\d{1,2})$/.exec(text);
    if (!md) return '';
    var month = Number(md[1]);
    var day = Number(md[2]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return '';
    var ref = typeof todayMs === 'number' && isFinite(todayMs) ? todayMs : Date.now();
    var year = beijingParts(ref).year;
    var best = null;
    [year - 1, year, year + 1].forEach(function (y) {
      var ms = beijingToMs(y, month, day, 0, 0, 0);
      var p = beijingParts(ms);
      // 非法日期（2-30 之类被 JS 进位）直接丢弃，不将错就错
      if (p.month !== month || p.day !== day) return;
      var dist = Math.abs(ms - ref);
      if (!best || dist < best.dist || (dist === best.dist && ms < best.ms)) best = { ms: ms, dist: dist, y: y };
    });
    if (!best) return '';
    return best.y + '-' + pad2(month) + '-' + pad2(day);
  }

  /**
   * 时刻归一到 `HH:MM:SS`：
   *  - 时/分/秒必须落在真实范围（24:00、18:60、18:00:60 一律拒绝）；
   *  - 只吸收等价的小数秒（`.0` / `.000` 全零）；**非零小数秒是不同的瞬间**，
   *    秒精度表达不了 → 拒绝，绝不截断（否则 18:00:30.5 会误合并成 18:00:30 那个场次）；
   *  - 秒必须参与比较（18:00:30 与 18:00:00 是不同场次）。
   */
  function clubHhmmss(value) {
    var m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.(\d+))?$/.exec(String(value == null ? '' : value).trim());
    if (!m) return '';
    var hour = Number(m[1]);
    var minute = Number(m[2]);
    var second = m[3] === undefined ? 0 : Number(m[3]);
    var frac = m[4] === undefined ? '' : m[4];
    if (frac && /[^0]/.test(frac)) return '';
    if (hour > 23 || minute > 59 || second > 59) return '';
    return pad2(hour) + ':' + pad2(minute) + ':' + pad2(second);
  }

  /** 活动名归一：全角括号→半角、去所有空白；保留校区字样，绝不做子串/模糊匹配。 */
  function clubNameKey(value) {
    return String(value == null ? '' : value)
      .trim()
      .replace(/（/g, '(')
      .replace(/）/g, ')')
      .replace(/\s+/g, '');
  }

  /**
   * 用记录接口（getStudentClubRecord）判断**指定场次**的签到状态。
   * 记录条目只有 configurationId，与 myTask 的 clubActivityId / configurationTimeId 不是同一 id 空间
   * → 绝不按 id 对号。必须「活动名（含校区）+ 完整日期 + 开始时刻 + 结束时刻」四元组全等，
   * 且候选唯一，才采用其 signStatus；缺任一字段或出现多条歧义一律不授权（返回空状态）。
   * signStatus 语义（实测）：'0'=未签到、'3'=已签到未签退、'1'=已完成。
   */
  function clubRecordSignState(records, session) {
    var out = { status: '', matched: 0, ambiguous: false };
    if (!Array.isArray(records) || !session) return out;
    if (!session.name || !session.date || !session.startTime || !session.endTime) return out;
    var nameKey = clubNameKey(session.name);
    if (!nameKey) return out;
    var hits = [];
    records.forEach(function (item) {
      if (!item || typeof item !== 'object') return;
      // 注意：这里不能复用 planClub 内的 activityNameOf（不在本作用域），按同一优先级就地取
      var itemName = item.activityName != null ? item.activityName : item.ActivityName;
      if (clubNameKey(itemName) !== nameKey) return;
      if (clubFullDateText(item.yymmdd) !== session.date) return;
      if (clubHhmmss(item.startTime) !== session.startTime) return;
      if (clubHhmmss(item.endTime) !== session.endTime) return;
      hits.push(String(item.signStatus == null ? '' : item.signStatus).trim());
    });
    out.matched = hits.length;
    if (hits.length !== 1) {
      out.ambiguous = hits.length > 1;
      return out;
    }
    out.status = hits[0] === '0' || hits[0] === '1' || hits[0] === '3' ? hits[0] : '';
    return out;
  }

  /**
   * `value` 自带完整日期+时刻时，直接按**真实日历/时钟**构造，不交给 parseMoment 的进位兜底：
   * parseMoment 用前缀正则 + Date.UTC，`2026-02-30 18:00` 会被静默进位成 `2026-03-02 18:00`，
   * 那等于把不存在的场次算成存在，签退窗口就会落到错误的日期上。
   * 非法（日历/时钟越界、非零小数秒）→ null，绝不猜。
   */
  function clubDateTimeMs(value) {
    var text = String(value == null ? '' : value).trim();
    var m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.(\d+))?$/.exec(text);
    if (!m) return null;
    var year = Number(m[1]);
    var month = Number(m[2]);
    var day = Number(m[3]);
    var hour = Number(m[4]);
    var minute = Number(m[5]);
    var second = m[6] === undefined ? 0 : Number(m[6]);
    var frac = m[7] === undefined ? '' : m[7];
    if (frac && /[^0]/.test(frac)) return null;
    if (year < 2000 || year > 2100) return null;
    if (hour > 23 || minute > 59 || second > 59) return null;
    var ms = beijingToMs(year, month, day, hour, minute, second);
    var back = beijingParts(ms);
    if (back.year !== year || back.month !== month || back.day !== day) return null;
    if (back.hour !== hour || back.minute !== minute || back.second !== second) return null;
    return ms;
  }

  function parseClubMoment(value, dateSources, todayMs) {
    var sources = dateSources || [];
    var ref = typeof todayMs === 'number' && isFinite(todayMs) ? todayMs : Date.now();
    // 0) value 自己就带完整日期+时刻 → 走严格校验（日历/时钟），绝不 rollover
    if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}[ T]/.test(String(value == null ? '' : value).trim())) {
      return clubDateTimeMs(value);
    }
    // 1) 完整日期优先：只要有完整日期，就不用推断出来的 MM-DD
    var resolved = [];
    sources.forEach(function (s) {
      var full = clubFullDateText(s);
      if (full && resolved.indexOf(full) < 0) resolved.push(full);
    });
    // 2) 没有完整日期时才做 MM-DD 推断
    if (!resolved.length) {
      sources.forEach(function (s) {
        var d = resolveClubDateText(s, ref);
        if (d && resolved.indexOf(d) < 0) resolved.push(d);
      });
    }
    return parseMoment(value, resolved);
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

  /**
   * 俱乐部活动的可读文本（校区只存在于文本里，没有任何结构化字段）。
   * 真实上游条目字段：activityName（如「体能锻炼（龙泉）」）、addressDetail（如「龙泉校区第一田径场」）。
   */
  function clubText(item) {
    if (!item) return '';
    return ['activityName', 'ActivityName', 'address', 'addressDetail', 'itemName', 'clubIntroduction', 'teacherName']
      .map(function (k) {
        return item[k] == null ? '' : String(item[k]);
      })
      .join(' ');
  }

  /** 从活动文本里识别校区：'航空港' / '龙泉' / ''（识别不出） */
  function clubCampusOf(item) {
    var text = clubText(item);
    if (!text) return '';
    if (text.indexOf('航空港') >= 0) return '航空港';
    if (text.indexOf('龙泉') >= 0) return '龙泉';
    return '';
  }

  /**
   * 校区闸门：配置了成员校区且未开 allowOtherCampus 时，只放行「本校区」或「识别不出校区」的活动。
   * 识别不出时放行（宁可多签一场，也不因文本变化误杀）。
   */
  function clubPassesCampus(item, cfg) {
    var member = String((cfg && cfg.campusName) || '').trim();
    if (!member) return true;
    if (cfg && cfg.allowOtherCampus === true) return true;
    var found = clubCampusOf(item);
    if (!found) return true;
    return found === member;
  }

  /**
   * 清除某天的俱乐部重试计数（供 UI「清除今日失败锁定」调用）。
   * 只清 state.failed 而不清 clubChecks，会让用户「清了也永远停在 club-attempts-exhausted」。
   */
  function clearClubCheckLocks(state, dayText) {
    var day = String(dayText || '').trim();
    var src = state && state.clubChecks && typeof state.clubChecks === 'object' ? state.clubChecks : null;
    if (!src) return 0;
    var removed = 0;
    Object.keys(src).forEach(function (k) {
      if (!day || k.indexOf(day + '|') === 0) {
        delete src[k];
        removed += 1;
      }
    });
    return removed;
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

  /**
   * 统一脱敏口径（sanitizeError / 上游失败原因共用）：
   *  - 凭证：裸 `key=value`、**带引号的 JSON 键**（`{"password":"..."}`）、
   *    camelCase 变体（accessToken/refreshToken/oauthToken）、`Authorization: Bearer xxx` 一律打码；
   *  - 手机号打码；
   *  - 路径：只遮用户名（保留 ENOENT 语义与文件名，便于定位问题），栈帧整体截断；
   *  - 压缩空白并截断，避免把整包响应写进日志/结果。
   */
  function redactText(text, maxLen) {
    var out = String(text == null ? '' : text);
    // 1) 栈帧：`\n    at fn (path)` 之后全部丢弃（路径/用户名都藏在栈里，且对定位无用）
    var stackAt = out.search(/\n\s+at\s+/);
    if (stackAt > 0) out = out.slice(0, stackAt);
    return out
      // 2) 带引号的值：**先于任何 Bearer 规则**，把整段引号内容一起打码。
      //    值里可能含空格（`{"password":"my secret pass"}`）甚至内嵌 Bearer
      //    （`{"Authorization":"Bearer eyJ.a b"}`）——若让 Bearer 规则先跑，它只会吃掉
      //    `Bearer eyJ.a` 这一段，剩下 ` b` 这类短尾巴（低于裸值「吞后续 token」阈值）
      //    就会原样留在日志/结果里。
      .replace(
        /(password|passwd|pwd|access[_]?token|refresh[_]?token|id[_]?token|oauth[_]?token|jsessionid|authorization|secret|otp|captcha|token)(["']?\s*[:=]\s*)(["'])([\s\S]*?)\3/gi,
        '$1=***',
      )
      // 3) `Authorization: Bearer <token>` 整体吃掉（先于通用 Bearer，避免留下 `Bearer *** ***`）
      .replace(/\bauthorization["']?\s*[:=]\s*["']?Bearer\s+[A-Za-z0-9\-._~+/=]+/gi, 'authorization=***')
      // 4) 裸 Bearer 令牌
      .replace(/\bBearer\s+[A-Za-z0-9\-._~+/=]+/gi, 'Bearer ***')
      // 5) 裸 key=value：先吃掉首个 token，再吞掉紧随其后、看起来仍是密钥片段的若干 token
      //    （避免 `password=abc def ghi` 只遮住 `abc`；中文诊断文字不含空格，不会被误吞）
      .replace(
        /(password|passwd|pwd|access[_]?token|refresh[_]?token|id[_]?token|oauth[_]?token|jsessionid|authorization|secret|otp|captcha|token)["']?\s*[:=]\s*["']?[^\s,;&"'}]+((?:\s+[A-Za-z0-9._~+/=!@#$%^*\-]{3,}){0,3})/gi,
        '$1=***',
      )
      // 6) 用户名遮罩（保留路径其余部分与文件名）：用户名本身可能含空格，不能按空格截断
      .replace(/([A-Za-z]:\\Users\\)[^\\"']+(?=\\|["']|$)/g, '$1<user>')
      .replace(/(\/Users\/|\/home\/)[^\/"'\n]+(?=\/|["']|$)/g, '$1<user>')
      .replace(/\b1[3-9]\d{9}\b/g, '1**********')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, maxLen || 200);
  }

  /**
   * 异常 → 可落盘的脱敏原因。
   * 纯字符串 throw 必须保留（Electron 的 ipcRenderer.invoke rejection 常是字符串）；
   * 有 message 用 message；其它对象只取 code/name，绝不喂整对象（避免整包响应进日志）。
   */
  function sanitizeError(e) {
    var text = '';
    if (typeof e === 'string') text = e;
    else if (e && e.message) text = String(e.message);
    else if (e && (e.code || e.name)) text = String(e.code || e.name);
    return redactText(text, 140);
  }

  /**
   * 提交阶段抛异常（非业务响应）的原因分类。
   * 只产出固定的安全文案码：原始异常文本只经 sanitizeError 脱敏后进 detail，绝不进 reason。
   * 分类不确定时保持既有 `submission-result-unknown`，避免被误判成可重试失败。
   */
  function classifyThrownReason(e) {
    var text = e && e.message ? String(e.message) : String(e == null ? '' : e);
    if (/timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|network|网络|fetch failed|socket/i.test(text)) {
      return 'submission-network-error';
    }
    if (/\b401\b|\b403\b|未登录|请登录|重新登录|登录已|会话|鉴权|unauthorized|forbidden/i.test(text)) {
      return 'submission-auth-error';
    }
    if (/坐标|定位|latitude|longitude|不在.{0,6}范围|超出.{0,6}范围/i.test(text)) {
      return 'submission-coordinate-error';
    }
    if (/未开始|已结束|未报名|未签到|活动不存在|任务不存在|不满足|前置/.test(text)) {
      return 'submission-precondition-error';
    }
    return 'submission-result-unknown';
  }

  /** 从响应里取第一个非空文本字段（不整包 JSON 落盘，只取明确的报错文案） */
  function firstText(candidates) {
    for (var i = 0; i < candidates.length; i += 1) {
      var v = candidates[i];
      if (v === undefined || v === null) continue;
      var text = String(v).trim();
      if (text) return text;
    }
    return '';
  }

  /**
   * 上游业务失败原因（脱敏、截断 200 字）。
   *  - 二课：`res.errcode` / `res.errmsg`（含 `data` 嵌套）
   *  - 俱乐部/校园跑：`res.code` / `res.msg`
   * 只提取明确的报错字段，绝不整包 JSON 落盘；取不到时返回 ''（不伪造原因）。
   */
  function upstreamFailureDetail(moduleName, res) {
    if (!res || typeof res !== 'object') return '';
    var inner =
      res.data && typeof res.data === 'object'
        ? res.data
        : res.response && typeof res.response === 'object'
          ? res.response
          : null;
    var codeLabel = moduleName === 'ek' ? 'errcode' : 'code';
    var codeValue;
    if (moduleName === 'ek') {
      if (res.errcode !== undefined && res.errcode !== null) codeValue = res.errcode;
      else if (inner && inner.errcode !== undefined && inner.errcode !== null) codeValue = inner.errcode;
    } else if (res.code !== undefined && res.code !== null) {
      codeValue = res.code;
    } else if (inner && inner.code !== undefined && inner.code !== null) {
      codeValue = inner.code;
    }
    var msg = firstText([
      moduleName === 'ek' ? res.errmsg : res.msg,
      moduleName === 'ek' ? res.msg : res.errmsg,
      res.message,
      inner && (moduleName === 'ek' ? inner.errmsg : inner.msg),
      inner && inner.message,
    ]);
    var parts = [];
    if (codeValue !== undefined && codeValue !== null && String(codeValue).trim() !== '') {
      parts.push(codeLabel + '=' + redactText(codeValue, 32));
    }
    if (msg) parts.push('errmsg=' + msg);
    if (parts.length === 0) return '';
    return redactText(parts.join(' '), 200);
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

    /**
     * lastFailure 只保留最近 7 天：纯诊断数据，过期即无价值，避免 state 无界增长。
     */
    function pruneLastFailure(raw) {
      var src = raw && typeof raw === 'object' ? raw : {};
      var out = {};
      var keepMs = 7 * 24 * 60 * 60 * 1000;
      Object.keys(src).forEach(function (k) {
        var at = Number(src[k] && src[k].at) || 0;
        if (at > 0 && now() - at <= keepMs) out[k] = src[k];
      });
      return out;
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
          clubChecks: {},
          lastFailure: {},
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
        // 俱乐部签到/签退尝试计数：{ [key]: {count,lastAt} }
        clubChecks: s.clubChecks && typeof s.clubChecks === 'object' ? s.clubChecks : {},
        // 最近一次业务失败原因（脱敏、截断 200 字）：{ [key]: {detail, attempts, at} }
        lastFailure: pruneLastFailure(s.lastFailure),
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
        clubChecks: state.clubChecks || {},
        lastFailure: state.lastFailure || {},
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

    /** 已锁定终态的附加诊断字段：把上次上游失败原因带给界面/日志（已脱敏） */
    function lockedRowExtra(locked, baseExtra) {
      var extra = mergeConfig(baseExtra || {});
      if (locked && locked.lastError) extra.detail = String(locked.lastError);
      if (locked && locked.attempts) extra.attempts = Number(locked.attempts) || 0;
      return extra;
    }

    /**
     * 提交前的本地终态短路（done / failed 锁定）。
     * 供「自己管理尝试预算」的调用方（二课二维码/拍照、俱乐部）在消耗预算前先判一次，
     * 避免「已达上限/已锁定」时把行状态从 blocked·locked-* 改写成 waiting-material。
     * 返回 null 表示可以继续。
     */
    function settledRow(state, moduleName, action, activityId, key, extra) {
      if (state.done[key]) {
        return row(moduleName, action, activityId, 'skipped', 'already-done', mergeConfig(extra || {}, { key: key }));
      }
      var locked = state.failed[key];
      if (locked) {
        return row(
          moduleName,
          action,
          activityId,
          'blocked',
          'locked-' + String(locked.status || 'failed'),
          lockedRowExtra(locked, mergeConfig(extra || {}, { key: key })),
        );
      }
      return null;
    }

    /**
     * 单动作执行（安全核心）。
     *  - state 损坏 / inflight / failed 终态 → 直接阻塞，不提交；
     *  - dry-run → 只出预览行；
     *  - 提交前先持久化 inflight，**写失败则不提交**（fail-closed）；
     *  - 成功落 done；业务失败落 failed 终态（有界重试未用尽时先不落）；异常保留 inflight 并落 unknown 终态；
     *  - 落盘失败一律告警，且内存态仍保留，避免同进程重复提交。
     *
     * 有界重试（可选）：调用方通过
     *  - `meta.attemptsSoFar`：本次是第几次尝试（1 起算，调用方自己的计数器已自增）
     *  - `meta.maxAttempts`：本阶段允许的最大尝试次数
     * 传入时，`failed` 且 attemptsSoFar < maxAttempts 不写 state.failed（下一 tick 继续用新码/新图重试）；
     * 达到上限才落 failed 终态。`unknown`（结果不确定）永远立即锁定，防止重复提交。
     * 不传这两个字段（如二课报名）→ 保持「一次失败即终态」的旧行为。
     */
    function perform(state, meta, submit, classify) {
      var key = meta.key;
      var config = meta.config;
      var attemptNo = Number(meta.attemptsSoFar);
      if (!Number.isFinite(attemptNo) || attemptNo <= 0) attemptNo = 0;
      var maxAttempts = Number(meta.maxAttempts);
      if (!Number.isFinite(maxAttempts) || maxAttempts <= 0) maxAttempts = 0;
      /** 还有重试余额：本次失败不落终态，交给下一 tick 再试（由调用方计数器收敛） */
      var canRetry = attemptNo > 0 && maxAttempts > 0 && attemptNo < maxAttempts;
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
          row(
            meta.module,
            meta.action,
            meta.activityId,
            'blocked',
            'locked-' + String(locked.status || 'failed'),
            lockedRowExtra(locked, baseExtra),
          ),
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
           * 失败原因落盘（脱敏、截断 200 字）：
           * 学校端的 errmsg/errcode 必须留下来，否则用户事后完全不知道为什么失败。
           * 只取明确的报错字段，不整包 JSON 落盘。
           */
          var failureDetail = verdict === 'success' ? '' : upstreamFailureDetail(meta.module, res);
          if (verdict === 'success') {
            state.done[key] = now();
            if (meta.dailyKey) dailyAdd(state, meta.dailyKey);
          } else if (verdict === 'failed') {
            /**
             * 有界重试：签到码/现场照片都会滚动过期，服务端拒绝一次不代表当天签不上。
             * 只要调用方给了 attemptsSoFar/maxAttempts 且仍有余额，就不写 failed 终态，
             * 下一 tick 继续（次数由调用方计数器收敛，不会无限重试爆量）。
             */
            if (failureDetail) {
              state.lastFailure = state.lastFailure && typeof state.lastFailure === 'object' ? state.lastFailure : {};
              state.lastFailure[key] = { detail: failureDetail, attempts: attemptNo, at: now() };
            }
            if (!canRetry) {
              state.failed[key] = {
                status: 'failed',
                at: now(),
                attempts: attemptNo,
                lastError: failureDetail || '',
              };
            }
          } else {
            // unknown：结果不确定 → 保留终态锁定，避免下一 tick 盲重试造成重复提交
            state.failed[key] = { status: 'unknown', at: now(), lastError: failureDetail || '' };
          }
          var persistFailed = false;
          try {
            saveState(state);
          } catch (e) {
            persistFailed = true;
            logger.log('[storage] 结果落盘失败（内存态仍生效，需人工核查）：' + sanitizeError(e));
          }
          logger.log(
            '[' + meta.module + '] ' + meta.action + ' ' + String(meta.activityId) + ' → ' + verdict
              + (attemptNo > 0 && maxAttempts > 0 ? '（第 ' + attemptNo + '/' + maxAttempts + ' 次）' : '')
              + (failureDetail ? ' 原因：' + failureDetail : '')
              + (verdict === 'failed' && canRetry ? '（下轮继续重试）' : ''),
          );
          var status = verdict;
          var reason = '';
          if (persistFailed) {
            status = verdict === 'success' ? 'unknown' : verdict;
            reason = 'persist-after-result-failed';
          } else if (verdict !== 'success') {
            reason = 'upstream-rejected';
          }
          emitResult(meta, status, reason, failureDetail);
          // 合并 meta 中的安全诊断字段，便于日志定位
          var diagExtra = { key: key };
          ['accountId', 'activityName', 'category', 'listStatus', 'classify', 'decision', 'scoreGate', 'applyWindowStart', 'applyWindowEnd', 'stage', 'distanceMeters', 'windowMinutes', 'runTime', 'signWay', 'photo', 'captchaFrom', 'coordSource', 'dateSource', 'signInEvidence'].forEach(function (k) {
            if (meta[k] !== undefined) diagExtra[k] = meta[k];
          });
          if (failureDetail) diagExtra.detail = failureDetail;
          if (attemptNo > 0) {
            diagExtra.attempts = attemptNo;
            if (maxAttempts > 0) diagExtra.maxAttempts = maxAttempts;
            if (verdict === 'failed') diagExtra.retryable = canRetry;
          }
          if (status === 'success') diagExtra.decision = 'applicable';
          return row(meta.module, meta.action, meta.activityId, status, reason, diagExtra);
        })
        .catch(function (e) {
          delete state.inflight[key];
          // 异常原因必须保留（脱敏+截断）：否则当天永久锁死却让用户无从判断原因
          var caughtDetail = sanitizeError(e);
          var caughtReason = classifyThrownReason(e);
          state.failed[key] = { status: 'unknown', at: now(), lastError: caughtDetail };
          try {
            saveState(state);
          } catch (err) {
            logger.log('[storage] unknown 状态落盘失败：' + sanitizeError(err));
          }
          logger.log(
            '[' + meta.module + '] ' + meta.action + ' ' + String(meta.activityId) + ' → unknown'
              + (caughtDetail ? ' 原因：' + caughtDetail : ''),
          );
          // reason 只用固定分类码；原始异常仅以脱敏 detail 暴露，避免凭证/整包响应外泄
          emitResult(meta, 'unknown', caughtReason, caughtDetail);
          var unknownExtra = { key: key };
          if (caughtDetail) unknownExtra.detail = caughtDetail;
          return row(meta.module, meta.action, meta.activityId, 'unknown', caughtReason, unknownExtra);
        });
    }

    /**
     * 结果事件回调（供 result-store 做历史/看板）。
     * 只在**真实提交定论**后触发：dry-run / skipped / blocked / waiting 都不触发。
     * 行内绝不含 payload / token / 密码 / 完整手机号。
     */
    function emitResult(meta, status, reason, detail) {
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
        // 上游拒绝原因（已脱敏、截断 200 字）：让历史里能看到「为什么失败」
        if (detail) event.detail = String(detail);
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

    /** 闭区间内取整数随机值（[min,max] 都含端点）。 */
    function pickIntInRange(minV, maxV) {
      var span = maxV - minV + 1;
      var rand = typeof opts.random === 'function' ? opts.random() : Math.random();
      var unit = Number(rand);
      if (!Number.isFinite(unit) || unit < 0) unit = 0;
      if (unit >= 1) unit = 0.9999999999;
      var picked = minV + Math.floor(unit * span);
      if (picked < minV) picked = minV;
      if (picked > maxV) picked = maxV;
      return picked;
    }

    /**
     * 官方配速契约（与上游一致）：时长必须落在 **4~10 km/h** 对应的区间
     *   `[ceil(km/10*60), floor(km/4*60)]`，再与全局 `[5, 300]` 分钟取交。
     * 例：1000m → 6~15 分钟；1100m → 7~16 分钟；3000m → 18~45 分钟。
     * 区间为空（里程过小/过大）返回 null，调用方必须拦下而不是猜一个值。
     */
    function unirunPaceRange(distanceMeters) {
      var km = Number(distanceMeters) / 1000;
      if (!(km > 0) || !isFinite(km)) return null;
      var lo = Math.max(Math.ceil((km / UNIRUN_MAX_SPEED_KMH) * 60), UNIRUN_MIN_RUNTIME_MIN);
      var hi = Math.min(Math.floor((km / UNIRUN_MIN_SPEED_KMH) * 60), UNIRUN_MAX_RUNTIME_MIN);
      if (!(lo <= hi)) return null;
      return { min: lo, max: hi };
    }

    function isPaceValid(distanceMeters, runTime) {
      var range = unirunPaceRange(distanceMeters);
      if (!range) return false;
      var n = Number(runTime);
      if (!isFinite(n)) return false;
      return n >= range.min && n <= range.max;
    }

    /**
     * 解析本次运行应使用的里程（米）。
     *
     * 优先级与口径：
     *  1. `config.unirun.runDistance` 显式为有效数字 → 直接用它（向后兼容手填/旧配置/旧测试）。
     *  2. 否则用 `[runDistanceMin, runDistanceMax]`（默认 1000~1099）随机取整数：
     *     - 里程**不做任何末位限制**（「末位非 0」是历史臆测，上游无此规则）；真正约束在时长一侧的 4~10km/h 配速；
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

      // 3) 当天固定：已有持久值直接复用，但必须仍然落在**当前** [min,max] 内
      //    （用户改过 runDistanceMin/Max 之后，旧缓存越界不得继续用）
      var dateStr = beijingDateString(now());
      var stateKey = unirunDistanceStateKey(dateStr, account);
      state.unirunDistance = state.unirunDistance && typeof state.unirunDistance === 'object' ? state.unirunDistance : {};
      var cached = numInRange(state.unirunDistance[stateKey], minM, maxM);
      if (cached !== null) {
        return { ok: true, runDistance: Math.round(cached), persisted: false };
      }

      // 4) 首次随机（[min,max] 闭区间，不再对末位做任何人为修正）
      var picked = pickIntInRange(minM, maxM);

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
      logger.log('[unirun] 今日随机里程为 ' + picked + ' 米（' + minM + '~' + maxM + '）');
      return { ok: true, runDistance: picked, persisted: true };
    }

    /**
     * 当天「时长（分钟）」随机值的 state 键：`<date>|<account>`（与里程/窗口同一口径，账号隔离）。
     */
    function unirunTimeStateKey(dateStr, account) {
      return String(dateStr) + '|' + String(account || 'local');
    }

    /**
     * 解析本次运行应使用的时长（分钟）——**必须同时满足官方配速 4~10km/h**。
     *
     * 口径：
     *  1. 先由里程算出可行区间 `pace = [ceil(km/10*60), floor(km/4*60)] ∩ [5,300]`；
     *  2. 显式 `runTime` → 必须在 pace 内，否则 `pace-out-of-range`（**不改写用户值**，交给 UI 让用户自己改）；
     *  3. 否则区间 = pace ∩ 显式 `[runTimeMin, runTimeMax]`（默认都 null = 不额外限制）；
     *     交集为空 → `pace-out-of-range`（明确拦，不猜）；
     *  4. 当天固定（`state.unirunTime`）：缓存必须 pace 合法**且**落在当前有效区间才复用，否则重算并落盘；
     *  5. fail-closed：落盘失败不提交。
     *
     * @returns {{ok:boolean, runTime?:number, reason?:string, persisted?:boolean,
     *            detail?:{distanceMeters:number, runTime?:number, suggestedMin:number, suggestedMax:number}}}
     */
    function resolveUnirunTime(state, config, account, runDistance) {
      var u = config.unirun || {};
      var distance = Number(runDistance);
      var pace = unirunPaceRange(distance);
      if (!pace) return { ok: false, reason: 'invalid-run-params' };

      function paceBlocked(explicitTime) {
        var detail = { distanceMeters: Math.round(distance), suggestedMin: pace.min, suggestedMax: pace.max };
        if (explicitTime !== undefined) detail.runTime = explicitTime;
        return { ok: false, reason: 'pace-out-of-range', detail: detail };
      }

      // 1) 显式时长：只拦不改写
      var explicitRaw = u.runTime;
      if (explicitRaw !== null && explicitRaw !== undefined && String(explicitRaw).trim() !== '') {
        var explicit = numInRange(explicitRaw, UNIRUN_MIN_RUNTIME_MIN, UNIRUN_MAX_RUNTIME_MIN);
        if (explicit === null) {
          return { ok: false, reason: 'invalid-run-params' };
        }
        var explicitTime = Math.round(explicit);
        if (!isPaceValid(distance, explicitTime)) return paceBlocked(explicitTime);
        return { ok: true, runTime: explicitTime, persisted: false };
      }

      // 2) 有效区间 = pace ∩ 显式 [runTimeMin, runTimeMax]（显式非法 → invalid-run-params）
      var lo = pace.min;
      var hi = pace.max;
      var boundMin = null;
      var boundMax = null;
      if (u.runTimeMin !== null && u.runTimeMin !== undefined && String(u.runTimeMin).trim() !== '') {
        boundMin = numInRange(u.runTimeMin, UNIRUN_MIN_RUNTIME_MIN, UNIRUN_MAX_RUNTIME_MIN);
        if (boundMin === null) return { ok: false, reason: 'invalid-run-params' };
        boundMin = Math.round(boundMin);
      }
      if (u.runTimeMax !== null && u.runTimeMax !== undefined && String(u.runTimeMax).trim() !== '') {
        boundMax = numInRange(u.runTimeMax, UNIRUN_MIN_RUNTIME_MIN, UNIRUN_MAX_RUNTIME_MIN);
        if (boundMax === null) return { ok: false, reason: 'invalid-run-params' };
        boundMax = Math.round(boundMax);
      }
      if (boundMin !== null) lo = Math.max(lo, boundMin);
      if (boundMax !== null) hi = Math.min(hi, boundMax);
      if (lo > hi) return paceBlocked();

      // 3) 当天固定：缓存必须 pace 合法且落在当前有效区间
      var dateStr = beijingDateString(now());
      var stateKey = unirunTimeStateKey(dateStr, account);
      state.unirunTime = state.unirunTime && typeof state.unirunTime === 'object' ? state.unirunTime : {};
      var cached = numInRange(state.unirunTime[stateKey], UNIRUN_MIN_RUNTIME_MIN, UNIRUN_MAX_RUNTIME_MIN);
      if (cached !== null) {
        var cachedTime = Math.round(cached);
        if (isPaceValid(distance, cachedTime) && cachedTime >= lo && cachedTime <= hi) {
          return { ok: true, runTime: cachedTime, persisted: false };
        }
      }

      // 4) 随机取有效区间内的整数，再复检一次 pace（防区间算法漂移）
      var picked = pickIntInRange(lo, hi);
      if (!isPaceValid(distance, picked)) return paceBlocked(picked);

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
      logger.log(
        '[unirun] 今日随机时长为 ' + picked + ' 分钟（' + distance + ' 米 → 有效区间 ' + lo + '~' + hi
          + ' 分钟，对应 ' + UNIRUN_MIN_SPEED_KMH + '~' + UNIRUN_MAX_SPEED_KMH + 'km/h）',
      );
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
        // 非法/空值兜底：按默认时刻继续，只记一条 info，不抛错、不中断本轮
        var badRunAt = String(config.unirun.runAt == null ? '' : config.unirun.runAt).trim();
        startMin = parseHhmm(DEFAULTS.unirun.runAt);
        logger.log(
          '[unirun] 执行时刻「' + (badRunAt ? badRunAt.slice(0, 16) : '空')
            + '」无法识别，今天先按默认 ' + DEFAULTS.unirun.runAt + ' 执行（可在界面重新设置）',
        );
      }
      if (startMin === null) {
        // 默认值本身异常（正常不会发生）：明确失败，不猜时刻
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
      // 里程：显式配置优先，否则当天在 [runDistanceMin, runDistanceMax] 随机
      var distance = resolveUnirunDistance(state, config, account);
      if (!distance.ok) {
        results.push(row('unirun', 'autoRun', '', 'failed', distance.reason || 'invalid-run-params'));
        return Promise.resolve();
      }
      var runDistance = distance.runDistance;
      // 时长：必须满足官方 4~10km/h（随里程推区间）；显式越界 → 拦下并给人类可读建议区间
      var duration = resolveUnirunTime(state, config, account, runDistance);
      if (!duration.ok) {
        if (duration.reason === 'pace-out-of-range') {
          var paceDetail = duration.detail || {};
          var suggested = paceDetail.suggestedMin + '~' + paceDetail.suggestedMax;
          results.push(row('unirun', 'autoRun', '', 'waiting-material', 'pace-out-of-range', {
            distanceMeters: runDistance,
            runTime: paceDetail.runTime === undefined ? null : paceDetail.runTime,
            suggestedMin: paceDetail.suggestedMin,
            suggestedMax: paceDetail.suggestedMax,
            detail: '里程 ' + runDistance + ' 米只支持 ' + suggested + ' 分钟（官方配速 '
              + UNIRUN_MIN_SPEED_KMH + '~' + UNIRUN_MAX_SPEED_KMH + 'km/h），请调整里程或时长后再跑',
          }));
          return Promise.resolve();
        }
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
      /**
       * 关键词闸门只约束「新增报名」：已报名活动的签到/签退必须继续执行。
       * 历史实现是整段早退，导致「报名了但没签到」（与二课 2116-2122 的口径不一致，这里对齐：只告警不早退）。
       */
      var keywordGateOff = (config.club.keywords || []).length === 0 && config.club.allowAll !== true;
      if (keywordGateOff) {
        results.push(row('club', 'list', '', 'waiting-material', 'need-keywords'));
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
            // 真实字段：nextMmdd / mmdd（实测 `10-22` 只有月日）/ 历史 yymmdd；
            // 统一归一成完整日期再当 queryDate，MM-DD 按「离今天最近、并列取过去」推断
            [item && item.nextMmdd, item && item.mmdd, item && item.yymmdd].forEach(function (d) {
              var norm = resolveClubDateText(d, now());
              if (norm && dates.indexOf(norm) < 0) dates.push(norm);
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

          // 1) 报名：可报名(6)、关键词通过、本校区、每日成功数受 dailyJoinLimit 限制
          if (config.club.join && !keywordGateOff) {
            var limit = Math.max(0, Number(config.club.dailyJoinLimit) || 0);
            var countKey = dailyKey(today, account, 'club', 'join');
            var joinedToday = dailyCount(state, countKey);
            Object.keys(activityById).forEach(function (idText) {
              var item = activityById[idText];
              var id = Number(idText);
              if (myIds[id]) return;
              if (clubEffectiveStatus(item) !== '6') return;
              // 校区闸门：同一天两个校区各有一场同时段活动，不筛就会报名到另一个校区
              if (!clubPassesCampus(item, config.club)) {
                results.push(row('club', 'join', id, 'skipped', 'other-campus', {
                  activityName: activityNameOf(item),
                  campus: clubCampusOf(item),
                  memberCampus: String(config.club.campusName || ''),
                }));
                return;
              }
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
            /**
             * 记录接口（getStudentClubRecord）提供**外部签到证据**：它是「人已在手机上签到」的独立来源，
             * 与 getSignInTf 任务口径互为补充——当前任务可能缺少阶段状态（窗口外实测恒为全 null），
             * 只靠任务口径会永远判 need-sign-in-first。
             * 注意口径边界：历史证据只证明「窗口外/无进行中任务时 getSignInTf 下发 null」，
             * **不能**推断「手机签到后任务一定消失」，所以两条证据都要用，谁都不当唯一权威。
             * 这里只做**补充证据**：接口缺失/失败一律当没有，绝不因此降级本地 done 或任务证据。
             */
            var clubRecords = [];
            var recordsLoaded = typeof api.club.studentRecord === 'function'
              ? Promise.resolve()
                .then(function () {
                  return api.club.studentRecord(cred);
                })
                .then(function (res) {
                  // 只认成功码：失败码即使带残留 response（伪 record）也一律忽略
                  if (!isClubSuccess(res)) {
                    logger.log('[club] 记录接口未返回成功码，忽略外部签到证据');
                    return;
                  }
                  var list = extractList(res);
                  if (list) clubRecords = list;
                })
                .catch(function (e) {
                  logger.log('[club] 记录接口不可用，忽略外部签到证据：' + sanitizeError(e));
                })
              : Promise.resolve();
            ops.push(
              recordsLoaded
                .then(function () {
                  return api.club.currentSignTask(cred);
                })
                .then(function (res) {
                  // 只认成功码：失败码带残留 response（伪坐标/伪已签到）不得采信
                  if (!isClubSuccess(res)) return null;
                  return res && res.response && typeof res.response === 'object' ? res.response : null;
                })
                .catch(function () {
                  return null;
                })
                .then(function (currentTask) {
                  var inner = [];
                  myTasks.forEach(function (taskItem) {
                    var id = clubActivityId(taskItem);
                    var listed = id ? activityById[id] || null : null;
                    var base = listed || taskItem;
                    var name = activityNameOf(taskItem, base);
                    if (!id) {
                      // 静默会掩盖上游字段变化：没有可用活动 id 也要留一行（历史实现直接 return）
                      results.push(row('club', 'signIn', '', 'skipped', 'missing-activity-id', { activityName: name }));
                      return;
                    }
                    // 校区闸门：另一个校区的活动不报名也不签到（否则记录会落到别的校区）
                    if (!clubPassesCampus(base, config.club)) {
                      results.push(row('club', 'signIn', id, 'skipped', 'other-campus', {
                        activityName: name,
                        campus: clubCampusOf(base),
                        memberCampus: String(config.club.campusName || ''),
                      }));
                      return;
                    }

                    // 日期来源：nextMmdd → mmdd → yymmdd → 同 id 的「今天活动列表」查询日期；
                    // 不无条件用 today，避免把过期任务当成今天。
                    var dateSources = [taskItem.nextMmdd, taskItem.mmdd, taskItem.yymmdd,
                      taskItem.nextStartTime, taskItem.nextEndTime];
                    if (listed && listed.__queryDate) dateSources.push(listed.__queryDate);

                    var startMs = parseClubMoment(base.startTime || taskItem.startTime || taskItem.nextStartTime, dateSources, now());
                    var endMs = parseClubMoment(base.endTime || taskItem.endTime || taskItem.nextEndTime, dateSources, now());

                    var sameTask = Boolean(currentTask) && clubActivityId(currentTask) === id;

                    /**
                     * 记录接口补充证据（外部/手机端签到）：必须与**本场次**严格匹配——
                     * 活动名（含校区）+ 完整日期 + 开始时刻 + 结束时刻四元组全等且唯一命中。
                     * 历史同 id/同名的其它日期记录一律不授权今日签退。
                     */
                    var sessionStartText = base.startTime || taskItem.startTime || taskItem.nextStartTime;
                    var sessionEndText = base.endTime || taskItem.endTime || taskItem.nextEndTime;
                    var recordState = clubRecordSignState(clubRecords, {
                      name: name,
                      date: startMs === null ? '' : beijingDateString(startMs),
                      startTime: clubHhmmss(sessionStartText),
                      endTime: clubHhmmss(sessionEndText),
                    });
                    var recordCompleted = recordState.status === '1';
                    var recordSignedIn = recordState.status === '3' || recordCompleted;
                    var dateSource = '';
                    if (startMs !== null) {
                      dateSource = dateSources.some(function (s) {
                        return Boolean(clubFullDateText(s));
                      })
                        ? 'full-date'
                        : 'mmdd-inferred';
                    }

                    /**
                     * 官方已签到/签退信号：签到任务口径优先，再补列表口径（任一来源说「已签」即视为已签）。
                     * 只看列表条目会漏掉「人已经在手机上签过」→ 重复提交被学校拒绝 → 白烧当天重试预算。
                     * 注意**不能用**列表条目的 `signStatus`：实测我的任务里它恒为 '1'（那是报名/有效语义），
                     * 而同一活动的记录接口 signStatus 才是 '0'=未签到 / '3'=未签退 / '1'=已完成。
                     */
                    var taskSignedIn =
                      clubSignDone(sameTask ? currentTask.signInStatus : '') ||
                      clubSignDone(base.signInStatus) ||
                      clubSignDone(taskItem.signInStatus);
                    var taskSignedOut =
                      clubSignDone(sameTask ? currentTask.signBackStatus : '') ||
                      clubSignDone(base.signBackStatus) ||
                      clubSignDone(taskItem.signBackStatus);
                    // 记录接口是补充证据：任务口径没有时用它兜「手机已签到/已完成」
                    var officialIn = taskSignedIn || recordSignedIn;
                    var officialOut = taskSignedOut || recordCompleted;

                    /**
                     * 已完成（列表口径 optionStatus=4 且官方签到签退都齐）→ 只留一行说明，不再消耗预算。
                     * 除此之外**不再按 optionStatus 静默跳过**：真实上游「我的任务」条目常见 optionStatus='4'
                     * 或字段缺失，历史实现要求 ∈{1,2}，龙泉那批活动因此一行结果都不产出（用户只看到「什么都没发生」）。
                     */
                    if (recordCompleted || (clubEffectiveStatus(taskItem) === '4' && officialIn && officialOut)) {
                      results.push(row('club', 'signIn', id, 'skipped', 'already-signed-out-upstream', {
                        activityName: name,
                        optionStatus: clubEffectiveStatus(taskItem),
                        signInEvidence: recordCompleted ? 'record' : 'sign-task',
                      }));
                      return;
                    }

                    /**
                     * 坐标来源（顺序即安全口径）：
                     *  1) currentSignTask 下发、且 activityId 与当前活动一致 → 唯一可信来源（官方口径）；
                     *  2) 配置的签到点（club.fallbackLatitude/Longitude）→ 标注 fallback-coords；
                     *  3) club.allowActivityCoords=true 时才允许用**本活动自己**的 latitude/longitude。
                     * 真实上游条目并不下发 latitude/longitude（2026-10-23 实测），所以 2 才是可用兜底。
                     */
                    var coordInfo = resolveClubCoord(config, currentTask, id, base);
                    var coord = coordInfo.coord;
                    var coordSource = coordInfo.source;

                    var signInWindowMs = clubWindowMinutes(config.club.signInWindowMinutes, CLUB_SIGNIN_WINDOW_MIN) * 60000;
                    var signOutWindowMs = clubWindowMinutes(config.club.signOutWindowMinutes, CLUB_SIGNOUT_WINDOW_MIN) * 60000;

                    if (config.club.signIn) {
                      if (startMs === null) {
                        results.push(row('club', 'signIn', id, 'waiting-material', 'missing-date', { activityName: name }));
                      } else if (officialIn) {
                        results.push(row('club', 'signIn', id, 'skipped', 'already-signed-in-upstream', { activityName: name }));
                      } else {
                        // 实参顺序与形参严格对齐：canRun 是函数、activityName 是字符串（历史实现这两处是反的）
                        inner.push(
                          planClubSign(state, config, account, results, cred, id, 'signIn', '1', startMs, startMs + signInWindowMs, coord,
                            function () {
                              return true; // 签到无前置依赖
                            }, name, coordSource, { dateSource: dateSource }),
                        );
                      }
                    }
                    if (config.club.signOut) {
                      if (endMs === null) {
                        results.push(row('club', 'signOut', id, 'waiting-material', 'missing-date', { activityName: name }));
                      } else if (officialOut) {
                        results.push(row('club', 'signOut', id, 'skipped', 'already-signed-out-upstream', { activityName: name }));
                      } else {
                        var inKey = dedupeKey({ date: today, account: account, module: 'club', activityId: id, action: 'signIn' });
                        // 签退前置证据留痕：本地提交 > 任务口径 > 记录口径
                        var signInEvidence = state.done[inKey] ? 'local' : (taskSignedIn ? 'sign-task' : (recordSignedIn ? 'record' : ''));
                        inner.push(
                          planClubSign(
                            state, config, account, results, cred, id, 'signOut', '2',
                            endMs - signOutWindowMs, endMs, coord,
                            function () {
                              // 签退依赖：本地签到成功 或 官方已签到（任务口径/记录口径）
                              return Boolean(state.done[inKey]) || officialIn;
                            },
                            name,
                            coordSource,
                            { dateSource: dateSource, signInEvidence: signInEvidence },
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

    /** 俱乐部窗口分钟数：非法/越界 → 默认值（0 或负数会把窗口压成无，24h 以上视为配错） */
    function clubWindowMinutes(value, fallback) {
      var n = numInRange(value, 1, 24 * 60);
      return n === null ? fallback : n;
    }

    /** 俱乐部坐标取值：有效非零数字才认，否则 null（缺坐标就该等，不能拿 0/空串硬提交） */
    function clubCoord(src, latRaw, lngRaw) {
      if (!src) return null;
      var lat = String(latRaw == null ? '' : latRaw).trim();
      var lng = String(lngRaw == null ? '' : lngRaw).trim();
      if (!lat || !lng) return null;
      var latNum = Number(lat);
      var lngNum = Number(lng);
      if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) return null;
      if (latNum === 0 || lngNum === 0) return null;
      return { lat: lat, lng: lng };
    }

    /**
     * 俱乐部签到坐标解析（顺序即安全口径）：
     *  1) currentSignTask 下发、且 activityId 与当前活动一致 → 唯一可信来源（官方口径）；
     *  2) 配置的签到点（club.fallbackLatitude/Longitude）→ 标注 fallback-coords；
     *  3) club.allowActivityCoords=true → 用同一条活动自己的 latitude/longitude（真实上游常不下发）。
     * 都拿不到 → null，由调用方产出 need-coords（明确等待，绝不用别的活动的坐标硬提交）。
     */
    function resolveClubCoord(config, currentTask, id, base) {
      if (currentTask && clubActivityId(currentTask) === id) {
        var fromTask = clubCoord(currentTask, currentTask.latitude, currentTask.longitude);
        if (fromTask) return { coord: fromTask, source: 'sign-task' };
      }
      var fromConfig = clubCoord(config, config.club.fallbackLatitude, config.club.fallbackLongitude);
      if (fromConfig) return { coord: fromConfig, source: 'fallback-coords' };
      if (config.club.allowActivityCoords === true) {
        var fromList = clubCoord(base, base.latitude, base.longitude);
        if (fromList) return { coord: fromList, source: 'activity-coords' };
      }
      return { coord: null, source: '' };
    }

    function planClubSign(state, config, account, results, cred, id, action, signType, windowStart, windowEnd, coord, canRun, activityName, coordSource, info) {
      var t = now();
      var name = String(activityName == null ? '' : activityName);
      if (t < windowStart) {
        results.push(row('club', action, id, 'not-yet', 'before-window', { activityName: name }));
        return Promise.resolve();
      }
      if (t > windowEnd) {
        results.push(row('club', action, id, 'expired', 'window-passed', { activityName: name }));
        return Promise.resolve();
      }
      if (typeof canRun === 'function' && !canRun()) {
        results.push(row('club', action, id, 'waiting-material', 'need-sign-in-first', { activityName: name }));
        return Promise.resolve();
      }
      var today = beijingDateString(t);
      var key = dedupeKey({ date: today, account: account, module: 'club', activityId: id, action: action });
      // 已锁定/已完成 → 先短路，不再消耗重试预算，也不再改写行状态
      var settled = settledRow(state, 'club', action, id, key);
      if (settled) {
        results.push(settled);
        return Promise.resolve();
      }

      var lat = coord && String(coord.lat == null ? '' : coord.lat).trim();
      var lng = coord && String(coord.lng == null ? '' : coord.lng).trim();
      if (!lat || !lng || Number(lat) === 0 || Number(lng) === 0) {
        /**
         * 拿不到可信坐标就明确等（绝不用别的活动的坐标硬提交）。
         * 注：真实上游条目不下发 latitude/longitude，若学校也没下发签到位，唯一出路是
         * 在俱乐部卡片里填「签到点坐标」（club.fallbackLatitude/Longitude）——否则会一直停在这里。
         * 诊断必须**可操作**：告诉用户去哪儿填、填哪个校区（多校区时最容易填错点位）。
         */
        var coordCampus = clubCampusOf({ activityName: name });
        var coordHint = '活动「' + (name || id) + '」缺少签到坐标：请在运行页填写「签到点坐标（纬度/经度）」，'
          + '或在该成员页单独设置'
          + (coordCampus ? '（本场次校区：' + coordCampus + '，请填该校区签到点）' : '')
          + '；学校下发签到位后会自动优先使用学校坐标。';
        results.push(
          row('club', action, id, 'waiting-material', 'need-coords',
            { activityName: name, coordSource: coordSource || 'none', detail: coordHint }),
        );
        return Promise.resolve();
      }

      /**
       * 有界重试：学校端拒绝一次不锁死当天任务（用户实测：一次被拒 → 整场没签上）。
       * 次数/间隔可配（club.retryMaxAttempts / club.retryIntervalMinutes）；
       * 结果不确定（unknown）仍由 perform 立即锁定，不重试。
       * dry-run 只出预览行，**不消耗重试预算**（否则试跑几轮就把当天次数烧光）。
       */
      var retryMax = Math.max(1, Number(config.club.retryMaxAttempts) || 3);
      var retryMs = Math.max(0, Number(config.club.retryIntervalMinutes) || 0) * 60000;
      var attemptNo = 0;
      if (!config.dryRun) {
        state.clubChecks = state.clubChecks && typeof state.clubChecks === 'object' ? state.clubChecks : {};
        var check = state.clubChecks[key] || { count: 0, lastAt: 0 };
        if (check.count >= retryMax) {
          results.push(
            row('club', action, id, 'waiting-material', 'club-attempts-exhausted',
              { activityName: name, attempts: check.count, maxAttempts: retryMax }),
          );
          return Promise.resolve();
        }
        if (check.lastAt && retryMs > 0 && t < check.lastAt + retryMs) {
          results.push(
            row('club', action, id, 'waiting-material', 'club-retry-pending',
              { activityName: name, attempts: check.count, maxAttempts: retryMax }),
          );
          return Promise.resolve();
        }
        check.count += 1;
        check.lastAt = t;
        state.clubChecks[key] = check;
        try {
          saveState(state);
        } catch (e) {
          logger.log('[storage] clubChecks 写入失败，已阻止提交：' + sanitizeError(e));
          results.push(row('club', action, id, 'blocked', 'storage-error'));
          return Promise.resolve();
        }
        attemptNo = check.count;
      }

      var extra = {};
      if (coordSource) extra.coordSource = coordSource;
      // 诊断留痕：日期来自完整日期还是 MM-DD 推断 / 签到证据来自哪里（本地·任务·记录）
      if (info && info.dateSource) extra.dateSource = info.dateSource;
      if (info && info.signInEvidence) extra.signInEvidence = info.signInEvidence;
      return perform(
        state,
        Object.assign(
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
            // 有界重试：本次是第几次尝试 / 上限（由 clubChecks 收敛）
            attemptsSoFar: attemptNo,
            maxAttempts: retryMax,
            // 真正提交前的截止校验：过了签到/签退窗口就不再提交
            deadlineMs: windowEnd,
          },
          extra,
        ),
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
        // 坐标来自活动列表兜底时在结果行留痕（便于回溯「报到另一个校区」这类问题）
        if (coordSource === 'activity-coords' && !r.detail) r.detail = 'activity-coords';
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
        results.push(
          row(
            'ek',
            task.action,
            id,
            'blocked',
            'locked-' + String(state.failed[key].status || 'failed'),
            lockedRowExtra(state.failed[key], { key: key }),
          ),
        );
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
                  // 有界重试：与二维码路径共用 qrChecks 预算（本次是第几次尝试 / 上限）
                  attemptsSoFar: check.count,
                  maxAttempts: maxAttempts,
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
              // 有界重试：本次是第几次尝试 / 上限（由 qrChecks 收敛）
              attemptsSoFar: check.count,
              maxAttempts: maxAttempts,
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
      /**
       * 延迟闸门（与二维码分支一致）：官方窗口开始后延迟 photoDelayMinutes 再提交。
       * 未配置 photoDelayMinutes → 沿用 qrDelayMinutes（默认 2 分钟）；
       * 显式 0 表示窗口一开始就提交。
       */
      var photoDelayRaw = cfg.photoDelayMinutes;
      if (photoDelayRaw === undefined || photoDelayRaw === null || String(photoDelayRaw).trim() === '') {
        photoDelayRaw = cfg.qrDelayMinutes;
      }
      var delayMin = Math.max(0, Number(photoDelayRaw) || 0);
      var gateMs = range.start + delayMin * 60000;
      if (gateMs > range.end) {
        results.push(row('ek', task.action, id, 'waiting-material', 'photo-delay-exceeds-window', { signWay: signWay }));
        gateMs = range.start + Math.min(delayMin * 60000, Math.max(0, range.end - range.start - 15000));
      }
      if (t < gateMs) {
        results.push(row('ek', task.action, id, 'not-yet', 'before-photo-gate', { signWay: signWay }));
        return Promise.resolve();
      }
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
              // 有界重试：本次是第几次尝试 / 上限（由 photoChecks 收敛）
              attemptsSoFar: check.count,
              maxAttempts: maxAttempts,
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
          clubChecks: {},
          lastFailure: {},
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
    redactText: redactText,
    sanitizeError: sanitizeError,
    classifyThrownReason: classifyThrownReason,
    clubHhmmss: clubHhmmss,
    clubNameKey: clubNameKey,
    clubRecordSignState: clubRecordSignState,
    clubFullDateText: clubFullDateText,
    resolveClubDateText: resolveClubDateText,
    clubText: clubText,
    clubCampusOf: clubCampusOf,
    clubPassesCampus: clubPassesCampus,
    clearClubCheckLocks: clearClubCheckLocks,
    extractList: extractList,
    extractBoundImageItems: extractBoundImageItems,
    keywordMatch: keywordMatch,
    passesKeyword: passesKeyword,
  };
});
