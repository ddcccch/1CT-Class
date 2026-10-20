'use strict';
/**
 * 3CT-Auto 早期 bootstrap。
 *
 * package.json 的 "main" 指向本文件；它在原主进程入口 dist/main/main.js 之前执行，
 * 因此可以：
 *   1) 禁用自动更新（设空 CT_UPDATE_URL 让原 setupAutoUpdate 直接 return，
 *      再兜底覆盖 electron-updater 的下载/安装入口，避免副本被官方更新替换）；
 *   2) 关闭窗口后台节流，保证最小化后渲染层的自动化计时器仍按计划触发；
 *   3) 之后 require 原 main.js（同目录，行为与原版一致，仅多了上面两条保护）。
 *
 * 注意：本文件位于 ASAR 内 dist/main/ 下，require('./main.js') 解析到原入口；
 * 不修改原 main.js，不使用 eval/code injection。
 */

process.env.CT_UPDATE_URL = '';

try {
  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.checkForUpdates = async () => {
    throw new Error('3CT-Auto 已禁用自动更新');
  };
  autoUpdater.quitAndInstall = () => {};
  autoUpdater.setFeedURL = () => {};
} catch (err) {
  // electron-updater 不可用时忽略：原程序自身也会在 setupAutoUpdate 里捕获异常。
}

let electron = null;
try {
  electron = require('electron');
} catch (err) {
  electron = null;
}

if (electron && electron.app) {
  const { app } = electron;
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
}

require('./main.js');
