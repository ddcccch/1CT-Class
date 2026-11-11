/**
 * 用本机真实数据验证 1CT 三模块修复。
 * 输入：artifacts/live-config-1ct.json（从 1CT leveldb 解出的真实配置）、
 *       %APPDATA%\3CT\unirun\localdb.v1.json（真实校区库/地图库）、
 *       %APPDATA%\3CT\scheduler-tasks.json（真实俱乐部签到任务坐标）。
 * 输出：artifacts/verify-live-1ct-fixes.json（不含密码/token/照片原文）。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('../desktop/automation.js');

const ROOT = path.join(__dirname, '..');
const APP_DATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (e) { return fallback; }
}

function makeStorage(seed) {
  const map = new Map(Object.entries(seed || {}));
  return {
    get: (k) => (map.has(k) ? map.get(k) : null),
    set: (k, v) => { map.set(k, String(v)); },
    remove: (k) => { map.delete(k); },
  };
}

function makeApi(table) {
  const calls = [];
  const api = {};
  Object.keys(table).forEach((group) => {
    api[group] = {};
    Object.keys(table[group]).forEach((name) => {
      api[group][name] = async (payload) => {
        calls.push({ name: group + '.' + name, payload });
        const v = table[group][name];
        const out = typeof v === 'function' ? await v(payload) : v;
        if (out instanceof Error) throw out;
        return out;
      };
    });
  });
  api.__calls = calls;
  api.__count = (n) => calls.filter((c) => c.name === n).length;
  return api;
}

const BJ = (y, m, d, hh, mm) => Date.UTC(y, m - 1, d, hh - 8, mm, 0);
const makeClock = (ms) => { let t = ms; return { now: () => t, advance: (d) => { t += d; } }; };
const omit = (k, v) => (k === 'fallbackPhoto' ? '<omitted>' : v);

const liveCfg = readJson(path.join(ROOT, 'artifacts', 'live-config-1ct.json'), {});
const live3ct = readJson(path.join(APP_DATA, '3CT', 'unirun', 'localdb.v1.json'), { campuses: [], maps: [] });
const tasks3ct = readJson(path.join(APP_DATA, '3CT', 'scheduler-tasks.json'), { tasks: [] });

const campusRows = (live3ct.campuses || []).map((c) => ({
  id: c.id, label: c.label, mapName: c.map_name,
  schoolSiteIndex: c.school_site_index, updatedAt: c.updated_at_ms,
}));
const clubTask = (tasks3ct.tasks || []).find((t) => t.handlerPayload && t.handlerPayload.latitude) || null;
const clubPayload = clubTask ? clubTask.handlerPayload : null;

const results = {
  generatedAt: new Date().toISOString(),
  liveInputs: {
    configKeys: Object.keys(liveCfg),
    unirun: liveCfg.unirun || null,
    campusIdConfigured: String((liveCfg.unirun || {}).campusId || ''),
    campusesIn3ctLib: campusRows.map((c) => c.id + ':' + c.mapName),
    clubSignTaskFrom3ct: clubPayload
      ? { activityId: clubPayload.activityId, latitude: clubPayload.latitude, longitude: clubPayload.longitude }
      : null,
    fallbackPhotoChars: String(((liveCfg.ek || {}).fallbackPhoto) || '').length,
    ekConfig: { enabled: (liveCfg.ek || {}).enabled, allowAll: (liveCfg.ek || {}).allowAll },
  },
  cases: [],
};

async function caseUnirun() {
  const api = makeApi({
    unirun: {
      campusLocalList: () => (api.__pulled ? campusRows : []),
      campusCloudList: campusRows,
      campusCloudPull: ({ campusId }) => {
        api.__pulled = true;
        return { campuses: campusRows.filter((c) => c.id === campusId), mapName: 'cuit_konggang.json' };
      },
      autoRun: { code: 10000, response: { recordId: 20261031 }, msg: 'ok' },
    },
  });
  const storage = makeStorage({
    ct_unirun_accounts_v1: JSON.stringify({ items: [{ id: 'u1', phone: '13700001111', password: 'pw', remark: '' }], selected: 'u1' }),
  });
  const clock = makeClock(BJ(2026, 10, 31, 20, 30));
  const logs = [];
  const engine = A.createEngine({
    api, storage, clock,
    logger: { log: (m) => logs.push(String(m)) },
    config: {
      dryRun: false,
      unirun: { enabled: true, runTime: 35, runDistance: 1100 },
      ek: { enabled: false }, club: { enabled: false },
    },
    random: () => 0,
  });
  const out = await engine.runOnce();
  const r = (out.results || []).find((x) => x.module === 'unirun');
  const call = api.__calls.find((c) => c.name === 'unirun.autoRun');
  results.cases.push({
    name: '校园跑：真实配置 1100 米/35 分钟 + 空校区库 + 窗口后 30 分钟',
    status: r && r.status,
    reason: r && r.reason,
    runTimeSubmitted: call && call.payload.runTime,
    runDistanceSubmitted: call && call.payload.runDistance,
    campusUsed: call && { mapName: call.payload.mapName, schoolSiteIndex: call.payload.schoolSiteIndex },
    catchUp: r && r.catchUp,
    lateByMinutes: r && r.lateByMinutes,
    paceAdjusted: r && r.paceAdjusted,
    autoRunCalls: api.__count('unirun.autoRun'),
    cloudPulls: api.__count('unirun.campusCloudPull'),
    configUnchanged: { runTime: engine.getConfig().unirun.runTime, runDistance: engine.getConfig().unirun.runDistance },
    logs: logs.filter((l) => l.indexOf('[unirun]') === 0),
  });
}

async function caseClub() {
  const lat = clubPayload ? String(clubPayload.latitude) : '30.583253';
  const lng = clubPayload ? String(clubPayload.longitude) : '103.986817';
  const activityId = clubPayload ? Number(clubPayload.activityId) : 50011;
  // 已报名的那一场（用来验签到），以及同一批列表里另一场**未报名且上游不下发 optionStatus**的（用来验报名）
  const item = {
    activityId, clubActivityId: activityId,
    activityName: '体能锻炼（航空港）',
    startTime: '2026-10-31 19:00:00', endTime: '2026-10-31 19:30:00',
    maxStudent: 40,
  };
  const joinTarget = {
    activityId: activityId + 1, clubActivityId: activityId + 1,
    activityName: '志愿服务（航空港）',
    startTime: '2026-10-31 19:00:00', endTime: '2026-10-31 19:30:00',
    maxStudent: 40,
    // 真实上游常见形态：**不下发 optionStatus**
  };
  const api = makeApi({
    club: {
      myActivityList: () => ({
        code: 10000,
        response: { list: [{ clubActivityId: activityId, activityName: item.activityName, startTime: item.startTime, endTime: item.endTime }] },
      }),
      activityList: () => ({ code: 10000, response: { list: [item, joinTarget] } }),
      studentRecord: () => ({ code: 10000, response: { list: [] } }),
      currentSignTask: () => ({
        code: 10000,
        response: { clubActivityId: activityId, startTime: item.startTime, endTime: item.endTime, latitude: lat, longitude: lng },
      }),
      joinActivity: { code: 10000 },
      signInOrSignBack: { code: 10000 },
    },
  });
  const clock = makeClock(BJ(2026, 10, 31, 19, 2));
  const storage = makeStorage({
    ct_unirun_accounts_v1: JSON.stringify({ selectedId: 'acc-1', items: [{ id: 'acc-1', phone: '13800000000', password: 'pw', remark: '主号', updatedAt: 1 }] }),
  });
  const engine = A.createEngine({
    api, storage, clock, logger: { log: () => {} },
    config: { dryRun: false, club: { enabled: true, allowAll: true, join: true, signIn: true, signOut: true, dailyJoinLimit: 5 } },
  });
  const out = await engine.runOnce();
  const join = (out.results || []).find((x) => x.module === 'club' && x.action === 'join');
  const signIn = (out.results || []).find((x) => x.module === 'club' && x.action === 'signIn');
  const sub = api.__calls.find((c) => c.name === 'club.signInOrSignBack');
  const state = JSON.parse(storage.get('auto3ct:state') || '{}');
  const joinCall = api.__calls.find((c) => c.name === 'club.joinActivity');
  results.cases.push({
    name: '俱乐部：上游不下发 optionStatus 也要能报名 + 学校下发签到位（真实坐标）',
    joinStatus: join && join.status,
    joinReason: join && join.reason,
    joinCalls: api.__count('club.joinActivity'),
    joinActivityId: joinCall && joinCall.payload.activityId,
    signInStatus: signIn && signIn.status,
    signInCoordSource: signIn && signIn.coordSource,
    submitted: sub && { latitude: sub.payload.latitude, longitude: sub.payload.longitude, signType: sub.payload.signType },
    rememberedCoords: state.clubCoords || {},
    failedLocked: Object.keys(state.failed || {}).length,
  });
}

async function caseEk() {
  const fallback = String((liveCfg.ek || {}).fallbackPhoto || 'data:image/jpeg;base64,AAAA');

  function mk(uploadUrl) {
    const api = makeApi({
      ek: {
        getActivitiesList: {
          List: { Items: [{ Id: 'ek-500', ActivityId: 'ek-500', ActivityName: '形势与政策', ActivityStatus: '1' }] },
        },
        getActivityDetail: {
          ActivityInfo: {
            Id: 'ek-500',
            ActivityName: '形势与政策',
            ModuleCodeText: '思想政治与道德修养',
            SignWay: 3,
            SignWayText: '定位+拍照',
            latitude: 30.583253,
            longitude: 103.986817,
            IsNeedSignInText: '是',
            IsNeedSignOutText: '是',
            StuETime: '2026-10-20 09:00:00 至 2026-10-31 18:00:00',
            ActivityQDDate: '2026-10-31 18:00:00 至 2026-10-31 18:30:00',
            ActivityQTDate: '2026-10-31 20:00:00 至 2026-10-31 20:30:00',
          },
          ApplyInfo: { Id: 'sign-500', ActivityId: 'ek-500' },
        },
        activityBoundImages: { items: [] },
        imageUploadToSignActivity: { url: uploadUrl },
        signInOutByOthers: { errcode: 0 },
      },
    });
    const storage = makeStorage({
      ct_ek_session_v1: JSON.stringify({
        JSESSIONID: 'sid', access_token: 'tok', refresh_token: 'rtok',
        user_info: { loginName: '20230001', userName: '测试' },
      }),
      ct_unirun_accounts_v1: JSON.stringify({
        selectedId: 'acc-1',
        items: [{ id: 'acc-1', phone: '13800000000', password: 'pw', remark: '主号', updatedAt: 1 }],
      }),
    });
    const clock = makeClock(BJ(2026, 10, 31, 18, 5));
    const engine = A.createEngine({
      api, storage, clock, logger: { log: () => {} },
      config: {
        dryRun: false,
        ek: { enabled: true, allowAll: true, keywords: [], backendGallery: false, fallbackPhoto: fallback },
      },
    });
    return { api, engine, storage };
  }

  {
    const { api, engine, storage } = mk(null);
    const out = await engine.runOnce();
    const r = (out.results || []).find((x) => x.module === 'ek' && x.action === 'signIn');
    const state = JSON.parse(storage.get('auto3ct:state') || '{}');
    results.cases.push({
      name: '二课定位+拍照：真实兜底照片上传失败（旧版会提交空照片）',
      status: r && r.status,
      reason: r && r.reason,
      submitCalls: api.__count('ek.signInOutByOthers'),
      uploadCalls: api.__count('ek.imageUploadToSignActivity'),
      photoChecksBurned: Object.keys(state.photoChecks || {}).length,
      failedLocked: Object.keys(state.failed || {}).length,
    });
  }
  {
    const { api, engine } = mk('http://ek.cuit.edu.cn/official/live.jpg');
    const out = await engine.runOnce();
    const r = (out.results || []).find((x) => x.module === 'ek' && x.action === 'signIn');
    const sub = api.__calls.find((c) => c.name === 'ek.signInOutByOthers');
    const img = sub && sub.payload.signModel.Photos.Imgs[0];
    results.cases.push({
      name: '二课定位+拍照：上传成功 → 带照片 + 真实坐标提交',
      status: r && r.status,
      photo: r && r.photo,
      imgsSubmitted: sub && sub.payload.signModel.Photos.Imgs.length,
      imgUrl: img && img.url,
      latitude: sub && sub.payload.signModel.Latitude,
      longitude: sub && sub.payload.signModel.Longitude,
      signWay: sub && sub.payload.signModel.SignWay,
    });
  }
}

(async () => {
  await caseUnirun();
  await caseClub();
  await caseEk();
  const out = path.join(ROOT, 'artifacts', 'verify-live-1ct-fixes.json');
  fs.writeFileSync(out, JSON.stringify(results, omit, 2), 'utf-8');
  console.log(JSON.stringify(results, omit, 2));
  console.log('written: ' + out);
})().catch((e) => {
  console.error('FAILED', (e && e.stack) || e);
  process.exit(1);
});
