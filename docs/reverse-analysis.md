# 3CT 1.2.5 静态逆向与实现决策

## 已确认的本地证据

- 分析对象为原始 `3CT/resources/app.asar`，55,338,138 字节。
- 原包 SHA-256：`028d4695fd7ea9ad0c51a795fd4d23a4199adec087760260f618698f1bdd3adf`。
- 应用为 Electron，package name 为 `3CT`，version 为 `1.2.5`，main 为 `./dist/main/main.js`。
- sourcemap 含 `sourcesContent`，已恢复主进程业务 TypeScript、renderer TSX/TS 以及 preload 源码，不必反编译 Chromium。
- 包内业务依赖为 JS/WASM，未发现业务 `.node` 原生扩展。
- 本机 REA 已完成离线 JavaScript 应用图分析；证据输出为根目录 `rea-analysis.json`，恢复源码位于 `reverse/sources/`（生成物不入 Git）。

分析与测试没有读取原用户资料中的密码、cookie、token 值，没有以真实账号提交报名、跑步或签到业务。应用运行时使用其既有会话，与分析阶段提取凭证是两回事：升级版通过原 `window.ctAPI` 正常使用应用内已登录账号，不导出凭证。

## 架构与接口

| 模块 | 恢复源码目录 | 关键能力 |
|---|---|---|
| 二课 | `reverse/sources/main/src/main/ek/` | 登录、会话刷新、列表/详情、报名、扫码签到、通用签到、图库接口 |
| 校园跑 | `reverse/sources/main/src/main/unirun/` | 账号会话、地图校区、本地轨迹处理、上报跑步记录 |
| 俱乐部 | `reverse/sources/main/src/main/club/` | 日期活动列表、我的任务、报名、签到/签退 |
| 原生定时任务 | `reverse/sources/main/src/main/scheduler/` | 应用内和系统级计划，内置校园跑、俱乐部签到/签退处理器 |
| 插件 | `reverse/sources/main/src/main/plugins/` | 独立 webview、网络请求、插件自己的任务；没有直接开放二课/俱乐部业务 IPC |
| preload | `reverse/sources/preload/src/main/preload.ts` | 主窗口 `window.ctAPI` 的实际方法名及参数契约 |

校园跑与俱乐部共用 Tanma 账号；二课为另一套学校会话。3CT 图库来自其后端，不能把“本地已恢复客户端源码”写成“不再依赖任何远端服务”。

## 必须保持的业务口径

### 二课

- 列表容器是 `List.Items`，分页信息为 `List.TotalPages`。
- 活动状态 `Status/status/ActivityStatus`：0 可报名、1 已报名；详情 `ApplyInfo` 的有效 ID 也可提供报名证据。
- 详情包含 `ActivityInfo`，报名窗口 `StuETime`、签到窗口 `ActivityQDDate`、签退窗口 `ActivityQTDate`。
- 是否需要签到/签退来自 `IsNeedSignInText/IsNeedSignOutText`，官方完成状态来自 `ActivityListInfo.ActivitySignInfo.SignD/SignT`。
- 原实现 `SignWay`：1 扫码、2 拍照、3 拍照＋定位、4 验证码。当前自动扫码链路不能代替尚未具备材料的其他方式。
- `ctAPI.ek.activityBoundImages({key})` 获取本活动图库；上传不及时应等待有限重试，不能把缺图当成功。
- `ctAPI.ek.signByQr({requestsData,act_id,fun_type,qrcode})`：`QD` 为签到，`QT` 为签退。
- 扫码成功依据是 `errcode === 0` 且响应没有“无法/无需”等否定语义，不能只看 IPC Promise resolve。
- 源码存在无 qrcode 时本地构造 model 的 fallback，**仅证明代码存在，不证明服务器接受**。升级实现不以此冒充有效志愿者二维码。

### 校园跑与俱乐部

- 账号结构由 renderer `services/unirunAccounts.ts` 定义：本地键 `ct_unirun_accounts_v1`，值含 `selectedId` 与 `items`。
- 校区来自 `ctAPI.unirun.campusLocalList()`，不是自行猜测的 localStorage 键。
- 校园跑调用原 `ctAPI.unirun.autoRun`，业务成功码为 10000。
- 俱乐部成功码接受 10000 或 1000；可报名状态主要为 `optionStatus=6`。
- 签到 `signType='1'`，签退 `signType='2'`；官方 `signInStatus/signBackStatus` 可避免重复提交。
- 俱乐部原自动打卡 UI 以活动列表/我的任务的 `startTime/endTime` 为时间基准；日期用条目 `nextMmdd/yymmdd` 或同一条日期查询列表的查询日期。`currentSignTask` 的结束时间可能截短，不能盲作活动结束基准。

## 最终实现选择

选择**独立复制后增加自动化面板**，不覆盖原程序：

1. 保留原 Electron、preload、业务实现与用户登录流程。
2. ASAR 内加入本地 automation/panel/jsQR 资源；`index.html` 正常加载脚本，不依赖 eval 注入。
3. package main 指向早期 bootstrap，再 require 原主入口；副本禁用自动下载安装并关闭后台节流。
4. 仍保持原 name/version、用户资料与单实例锁；共享资料时必须先退出原版，测试用独立临时 profile。
5. 用户首次配置并预览后，一键开启持久运行；关机、睡眠或应用退出期间不会执行。
6. 二维码按窗口开始后延迟触发，固定间隔有限重试，不在窗口结束后盲投。

辅助 Python CLI/SQLite 模块用于本地调度和可测试性，不等同于桌面自动化的独立上游协议实现；未配置 adapter 时不能真实调用业务。

## 证据等级与验证边界

- **静态确认**：源码/参数/客户端成功码与分支。
- **离线验证**：fake API 测试状态机、时间、去重、缺材料及失败处理。
- **运行时验证**：独立临时 profile 启动真实 Electron，确认补丁加载与面板可操作。
- **未验证**：真实学校或 Tanma 平台是否接受当前账号的提交、是否最终计分、是否触发风控。

真实业务成功只能由真实平台返回和官方记录确认；不得以“代码已恢复”“单测通过”承诺积分到账。使用须符合学校与平台规则。

## 重现工具

```powershell
python reverse/asar_extract.py --archive 3CT/resources/app.asar --list
python reverse/asar_extract.py --archive 3CT/resources/app.asar --out reverse/extracted --only dist/ --only package.json
python reverse/unpack_sourcemap.py --map reverse/extracted/dist/main/main.js.map --out reverse/sources/main --skip-node-modules
python -m unittest discover -s reverse -p "test_*.py" -v
python desktop/install.py build
python desktop/install.py verify
```

ASAR 嵌套 pickle 头：JSON 长度位于偏移 12，JSON 从偏移 16 开始，数据区起点 `8 + header_size`。安装器重新计算文件偏移、size、SHA-256 hash 与 blocks，并验证所有未改动文件内容一致。
