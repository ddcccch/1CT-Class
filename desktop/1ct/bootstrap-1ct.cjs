'use strict';
/**
 * 1CT 早期 bootstrap（package.json 的 "main" 指向本文件）。
 *
 * 它在原主进程入口 `dist/main/main.js` **之前**执行，所以可以做三件事：
 *
 * 1) **独立 userData**（默认）：把 `app.getPath('userData')` 从
 *    `%APPDATA%\3CT` 改到 `%APPDATA%\1CT`，让 1CT 与 3CT / 3CT-Auto
 *    真正独立 —— 各自一份用户数据、各自一把单实例锁，**可以同时运行**，
 *    互不干扰（代价：1CT 首次启动需要重新登录，不共享 3CT 的登录态）。
 *    这是刻意的设计，见 desktop/1ct/packaging.md。
 *
 *    必须在 main.js 之前设置，因为原 main.js 顶层的
 *    `appSettings` / `proxyRouting` 等模块在**模块加载时**就会立即调用
 *    `app.getPath('userData')` 去读文件；晚一步就会读到旧目录，
 *    造成一半状态在新目录、一半在旧目录。
 *
 *    想回到共用模式（与 3CT / 3CT-Auto 共享 userData + 单实例锁，
 *    不能同时运行），用：
 *       1CT.exe --shared-user-data
 *    或  设置环境变量 CT_SHARE_USER_DATA=1
 *
 * 2) **禁自动更新 + 关后台节流**（与 3CT-Auto 的 bootstrap.cjs 相同）：
 *    禁用自动更新（设空 CT_UPDATE_URL 让原 setupAutoUpdate 直接 return，
 *    再兜底覆盖 electron-updater 的下载/安装入口），并关闭窗口后台节流，
 *    保证最小化后渲染层的自动化计时器仍按计划触发。
 *
 * 3) **二课「报名/完成列表」主进程桥接**（1CT 新增，3CT 没有）：
 *    原版 ctAPI 的 `ek.getSignList`（GetStuActSignList）对部分活动返回 0 条；
 *    官网「报名/完成列表」页的数据源
 *    `GetStuAllActApplyList` 才带 SignD=已签到 / SignT=已签退 状态，但 3CT 从未
 *    在 preload 暴露它。这里在主进程注册
 *    `ipcMain.handle('ek:getStuAllActApplyList', ...)` 直连官网（只读 GET，固定
 *    host/path，15s 超时）；preload 里的同名方法由 desktop/install_1ct.py 在打包时
 *    追加（见该脚本 PRELOAD_JS_ADDITION）。会话只从渲染层入参读取，
 *    **绝不打印 token / JSESSIONID**；注册失败只忽略，不影响启动。
 *
 * 不修改原 main.js，不使用 eval / 代码注入。
 */

const path = require('path');
const https = require('node:https');
const { app, ipcMain } = require('electron');

// ─────────────────────────── 1) 独立 userData ───────────────────────────
//
// 判定顺序：命令行 --shared-user-data 优先，其次环境变量。
// 只做 app.setPath，不改 package.json 的 name —— name 仍为 3CT 是刻意的，
// 见 packaging.md「为什么不动 productName/name」。
const USER_DATA_NAME = '1CT';
const SHARED_FLAGS = new Set(['--shared-user-data', '--shared-user-data=true']);

function wantsSharedUserData(argv, env) {
  if (Array.isArray(argv) && argv.some((arg) => SHARED_FLAGS.has(String(arg)))) {
    return true;
  }
  const raw = env && env.CT_SHARE_USER_DATA;
  return String(raw || '').trim() === '1';
}

/**
 * 命令行是否显式传了 `--user-data-dir`。
 *
 * 这是 Electron/Chromium 自带的开关，在 JS 执行**之前**就已经改掉 userData，
 * 常见于隔离测试（打包冒烟）与多开调试。此时**必须尊重用户的显式选择**，
 * 不能再覆盖成 %APPDATA%\1CT —— 否则隔离 profile 失效，测试会写进真实用户目录。
 */
function hasExplicitUserDataDir(argv) {
  if (!Array.isArray(argv)) return false;
  return argv.some((arg) => {
    const text = String(arg);
    return text === '--user-data-dir' || text.startsWith('--user-data-dir=');
  });
}

/** 返回本次实际生效的 userData 目录（便于日志/诊断，不抛错）。 */
function resolveUserData() {
  if (hasExplicitUserDataDir(process.argv)) {
    return { mode: 'explicit', shared: false, dir: null, note: '--user-data-dir 显式指定' };
  }
  if (wantsSharedUserData(process.argv, process.env)) {
    return { mode: 'shared', shared: true, dir: null };
  }
  const target = path.join(app.getPath('appData'), USER_DATA_NAME);
  try {
    app.setPath('userData', target);
  } catch (err) {
    // setPath 失败时保持 Electron 默认行为（%APPDATA%\3CT），绝不因此阻断启动。
    return {
      mode: 'shared',
      shared: true,
      dir: null,
      error: String((err && err.message) || err),
    };
  }
  return { mode: 'independent', shared: false, dir: target };
}

const userData = resolveUserData();

// ───────────────────── 2) 禁自动更新 + 关后台节流 ─────────────────────
process.env.CT_UPDATE_URL = '';

try {
  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.checkForUpdates = async () => {
    throw new Error('1CT 已禁用自动更新');
  };
  autoUpdater.quitAndInstall = () => {};
  autoUpdater.setFeedURL = () => {};
} catch (err) {
  // electron-updater 不可用时忽略：原程序自身也会在 setupAutoUpdate 里捕获异常。
}

try {
  app.on('browser-window-created', (_event, window) => {
    try {
      window.webContents.setBackgroundThrottling(false);
    } catch (err) {
      /* 单窗口设置失败不影响启动 */
    }
  });
  app.whenReady().then(() => {
    // 原 main.js 的 setupAutoUpdate 也在 whenReady 中执行，这里在其之后兜底一次。
    try {
      const { autoUpdater } = require('electron-updater');
      autoUpdater.autoDownload = false;
      autoUpdater.autoInstallOnAppQuit = false;
    } catch (err) {
      /* ignore */
    }
  });
} catch (err) {
  /* ignore */
}

// ───────────────── 3) 二课「报名/完成列表」主进程桥接 ─────────────────
//
// 为什么需要它：3CT 的 ctAPI.ek.getSignList（GetStuActSignList）对部分活动返回 0 条，
// 而用户已经在官网签到/签退成功。真正带状态的是官网「报名/完成列表」页的数据源
// GetStuAllActApplyList，响应形如：
//   { PageList: { Items: [{ ActivityId, SignD:'已签到', SignT:'已签退', ... }],
//                 TotalPages: 4, ... } }
// 该端点 3CT 从未暴露，所以 1CT 在自己的 bootstrap 里注册 IPC，再由打包脚本给
// preload 追加同名方法（ctAPI.ek.getStuAllActApplyList）。
//
// 安全/稳定性约束：
//   * host 固定为 https://ywtb.cuit.edu.cn（仅允许 CT_EK_YWTB_HOST 覆盖，隔离测试用），
//     path 与 query 固定；只发**只读 GET**，不做任何写操作；
//   * 会话（access_token / JSESSIONID）只从渲染层入参 payload.requestsData 读取，
//     本文件**绝不** console.log / 打印 / 落盘它们；缺失直接抛「二课会话缺失」；
//   * 注册失败（例如 ipcMain 不可用或重复注册）只忽略，绝不影响应用启动。
const EK_STU_ALL_ACT_APPLY_LIST_CHANNEL = 'ek:getStuAllActApplyList';
const EK_STU_ALL_ACT_APPLY_LIST_METHOD = 'getStuAllActApplyList';
const EK_YWTB_HOST_ENV = 'CT_EK_YWTB_HOST';
const EK_YWTB_HOST_DEFAULT = 'https://ywtb.cuit.edu.cn';
const EK_STU_ALL_ACT_APPLY_LIST_PATH =
  '/third_api/cxek/PhoneApi/api/Activity/GetStuAllActApplyList';
//: 与 3CT client 一致的 iOS UA（服务端按 UA 返回移动端 JSON）。
const EK_IOS_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';
const EK_YWTB_REFERER = 'https://ywtb.cuit.edu.cn/';
const EK_REQUEST_TIMEOUT_MS = 15000;

/** 从渲染层入参取二课会话；只读，缺失时抛统一中文错误（不带出任何凭证）。 */
function ekSessionFromPayload(payload) {
  const requestsData = payload && payload.requestsData;
  const accessToken = requestsData && requestsData.access_token;
  const jsessionid = requestsData && requestsData.JSESSIONID;
  if (!accessToken || !jsessionid) {
    throw new Error('二课会话缺失');
  }
  return { accessToken: String(accessToken), jsessionid: String(jsessionid) };
}

/** pageIndex 只接受正整数，其余（含 undefined / 0 / 负数 / NaN）一律回落到 1。 */
function ekPageIndex(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return parsed;
}

/** 解析 host（默认官网）；环境变量只用于隔离测试，非法值回落默认，避免启动期崩溃。 */
function ekYwtbUrl() {
  const raw = String(process.env[EK_YWTB_HOST_ENV] || '').trim();
  try {
    return new URL(raw || EK_YWTB_HOST_DEFAULT);
  } catch (err) {
    return new URL(EK_YWTB_HOST_DEFAULT);
  }
}

/**
 * 只读 GET 官网「报名/完成列表」。
 *
 * 2xx 返回解析后的 JSON；非 2xx 抛 `请求失败，状态码为：<status>`（与 3CT client 文案一致）；
 * 15s 超时；绝不打印任何会话内容。
 */
function fetchStuAllActApplyList(payload) {
  const session = ekSessionFromPayload(payload);
  const pageIndex = ekPageIndex(payload && payload.pageIndex);
  const host = ekYwtbUrl();
  const requestPath =
    EK_STU_ALL_ACT_APPLY_LIST_PATH +
    '?activityType=&activityName=&qdType=&qtType=&pageIndex=' +
    pageIndex;

  return new Promise((resolve, reject) => {
    let request;
    try {
      request = https.request(
        {
          hostname: host.hostname,
          port: host.port || undefined,
          path: requestPath,
          method: 'GET',
          headers: {
            Authorization: 'Bearer ' + session.accessToken,
            Cookie: 'JSESSIONID=' + session.jsessionid,
            'User-Agent': EK_IOS_USER_AGENT,
            Referer: EK_YWTB_REFERER,
            Accept: 'application/json, text/plain, */*',
          },
        },
        (response) => {
          const chunks = [];
          response.setEncoding('utf8');
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () => {
            const status = Number(response.statusCode) || 0;
            if (status < 200 || status >= 300) {
              reject(new Error('请求失败，状态码为：' + status));
              return;
            }
            try {
              resolve(JSON.parse(chunks.join('')));
            } catch (err) {
              reject(err);
            }
          });
          response.on('error', reject);
        }
      );
    } catch (err) {
      reject(err);
      return;
    }
    request.setTimeout(EK_REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error('二课请求超时（' + EK_REQUEST_TIMEOUT_MS + 'ms）'));
    });
    request.on('error', reject);
    request.end();
  });
}

let ekBridgeRegistered = false;
try {
  ipcMain.handle(EK_STU_ALL_ACT_APPLY_LIST_CHANNEL, (_event, payload) =>
    fetchStuAllActApplyList(payload)
  );
  ekBridgeRegistered = true;
} catch (err) {
  // 注册失败不影响启动：渲染层调用时会得到“功能未就绪”，其余功能照常。
}

// ───────────────────────────── 4) 进入主进程 ─────────────────────────────

//: 供打包冒烟/排错读取：确认独立 userData 与二课桥接是否真的生效。
try {
  Object.defineProperty(globalThis, '__ONE_CT_BOOTSTRAP__', {
    value: Object.freeze({
      mode: userData.mode,
      sharedUserData: userData.shared,
      userData: userData.dir,
      userDataError: userData.error || null,
      note: userData.note || null,
      argv: process.argv.slice(1),
      ekBridge: Object.freeze({
        channel: EK_STU_ALL_ACT_APPLY_LIST_CHANNEL,
        method: EK_STU_ALL_ACT_APPLY_LIST_METHOD,
        registered: ekBridgeRegistered,
      }),
    }),
    configurable: true,
    writable: false,
  });
} catch (err) {
  /* ignore */
}

require('./main.js');
