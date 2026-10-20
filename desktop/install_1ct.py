"""生成独立可启动的 **1CT** 副本（只改副本，原程序 3CT 完全保留）。

只使用 Python 标准库（复用同目录 ``install.py`` 的 ASAR 读写/校验实现），
不依赖 npm / node / 任何第三方包。

做什么（契约 docs/1ct-redesign-contract.md §6）
---------------------------------------------
1. 原样复制 ``3CT/`` 的全部运行文件到 ``1CT/``（跳过原版卸载器，避免误卸载原程序；
   主程序 exe 改名为 ``1CT.exe``，便于启动器区分 3CT / 3CT-Auto / 1CT 进程）；
2. 读取 ``3CT/resources/app.asar``，完整保留原包全部条目（415 个条目、347 个文件，
   含全部 node_modules），只做这些替换/新增后按 ASAR 规范重建（更新 offset/size 与
   SHA256 integrity，blockSize=4194304，逐块 SHA256）：
   - ``dist/renderer/index.html``：替换为 ``desktop/1ct/index.html``（标题 ``1CT``，
     只加载 1CT shell + jsQR/score-policy/result-store/automation；**不再加载**
     panel.js / dashboard.js / panel.css / dashboard.css / renderer.js）；
   - ``dist/renderer/1ct/{shell.js,shell.css,members.js,ek-stats.js,ek-stats.css,index.html}``：
     新增（契约 §1/§7 文件归属在 desktop/1ct/，本脚本只消费，不修改）；
   - ``dist/renderer/{jsQR,score-policy,result-store,automation}.js``：新增；
   - ``dist/main/auto-bootstrap.cjs``：新增（禁自动更新 + 关后台节流 + 二课
     「报名/完成列表」主进程桥接 ``ek:getStuAllActApplyList``）；
   - ``dist/main/preload.js``：最小补丁——在已确认唯一的
     ``getFinishList:e=>i.ipcRenderer.invoke("ek:getFinishList",e),`` 之后追加
     ``getStuAllActApplyList:e=>i.ipcRenderer.invoke("ek:getStuAllActApplyList",e),``，
     把官网「报名/完成列表」端点（带 SignD/SignT 签到/签退状态）暴露给渲染层；
   - ``package.json``：``main`` 指向 ``./dist/main/auto-bootstrap.cjs``；
     **刻意不改 productName/name/appId**（见下方“为什么不动 productName”）；
3. 生成 ``1CT/启动1CT.exe``（C# WinExe，无控制台）与仓库根同名入口，双击即启动
   ``1CT/1CT.exe``；启动器会检测 3CT / 3CT-Auto / 1CT 进程并清理
   ELECTRON_RUN_AS_NODE / NODE_OPTIONS / NODE_PATH 后启动；
4. 校验：重建后的 ASAR 可被重新解析，未改动文件逐字节一致，全部 integrity 与内容
   匹配，补丁文件与 desktop 源逐字节一致，index.html 注入清单正确，package.json
   main 正确，1CT.exe 与源 exe 字节一致，**原 ASAR 的 SHA256 前后不变**（绝不修改原程序）；
5. 写入 ``README-1CT.txt`` 与 ``.1ct-install.json`` 安装标记（--force 删除旧副本时
   必须匹配该标记，避免误删用户目录）。

为什么不动 productName（与 Lead 口述“productName 改成 1CT”的差异，已记录在
desktop/1ct/packaging.md）
----------------------------------------------------------------------
Electron 的 ``app.name`` 优先取 package.json 的 ``productName``，而默认
``app.getPath('userData')`` = ``%APPDATA%\\<app.name>``。把 productName 改成 1CT 会把
userData 从 ``%APPDATA%\\3CT`` 变成 ``%APPDATA%\\1CT``，直接破坏“1CT 与 3CT-Auto
共用 userData / 共用单实例锁”的设计（登录态要复用、且两者不能同时跑）。
契约 §6 只要求“窗口标题：1CT”，该标题由 1CT 版 index.html 的 ``<title>1CT</title>``
决定（原 main.js 的 BrowserWindow 未写死 title），因此默认不动 productName。
确需实验时可用 ``--product-name 1CT`` 显式打开（不推荐，会分叉 userData）。

注意
----
- 1CT / 3CT-Auto / 原版 3CT 共享同一 userData 与单实例锁，**不能同时运行**；
  启动器只提示用户先退出，**绝不结束或修改任何已有进程**。
- 1CT 内自动更新已禁用，禁止在副本里安装官方更新覆盖原程序。

用法
----
    python desktop/install_1ct.py build                 # 生成 1CT/ 并构建启动器
    python desktop/install_1ct.py build --force         # 覆盖已有 1CT/
    python desktop/install_1ct.py build --no-launcher   # 只重建副本，不编译启动器
    python desktop/install_1ct.py verify                # 校验已生成的 1CT/
    python desktop/install_1ct.py extract-vendor        # 从原 ASAR sourcemap 提取 jsQR
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import shutil
import struct
import subprocess
import sys
from datetime import datetime
from pathlib import Path

# ---------------------------------------------------------------------------
# 复用 desktop/install.py 的 ASAR 读写与校验原语（同一仓库、同一规范）
# ---------------------------------------------------------------------------


def _load_sibling(module_name: str):
    path = Path(__file__).resolve().parent / (module_name + ".py")
    spec = importlib.util.spec_from_file_location("_1ct_" + module_name, path)
    if spec is None or spec.loader is None:  # pragma: no cover - 环境异常
        raise ImportError(f"无法加载 {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


base = _load_sibling("install")

# 这些原语与 3CT-Auto 打包链完全一致，直接复用（含 pickle 头解析、integrity、重建）。
InstallerError = base.InstallerError
MAGIC = base.MAGIC
BLOCK_SIZE = base.BLOCK_SIZE
read_header = base.read_header
iter_files = base.iter_files
find_node = base.find_node
read_file = base.read_file
read_file_by_path = base.read_file_by_path
sha256_bytes = base.sha256_bytes
sha256_file = base.sha256_file
integrity_for = base.integrity_for
rebuild_asar = base.rebuild_asar
write_atomic = base.write_atomic
extract_jsqr = base.extract_jsqr

# ---------------------------------------------------------------------------
# 1CT 常量（契约 §6）
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parent.parent
DESKTOP_DIR = REPO_ROOT / "desktop"
ONECT_DIR = DESKTOP_DIR / "1ct"
VENDOR_DIR = DESKTOP_DIR / "vendor"
SOURCE_DIR = REPO_ROOT / "3CT"
DEST_DIR = REPO_ROOT / "1CT"
DEFAULT_ASAR = SOURCE_DIR / "resources" / "app.asar"

MARKER_NAME = ".1ct-install.json"
README_NAME = "README-1CT.txt"
#: 版本信息（分发/升级时用于区分副本，用户可读）
VERSION_NAME = "VERSION-1CT.txt"
LAUNCHER_NAME = "启动1CT.exe"
START_SCRIPT_NAME = "start-1ct.cmd"

#: 1CT bundle-id 风格的 userData 目录名（与 bootstrap-1ct.cjs 的常量保持一致）。
ONECT_USER_DATA_NAME = "1CT"
#: 独立 userData 的默认绝对路径（%APPDATA%\1CT）。
ONECT_USER_DATA_DIR = Path(os.environ.get("APPDATA", "")) / ONECT_USER_DATA_NAME

#: 原版里不要复制的文件（卸载器会卸载原程序；其余全部复制）。
COPY_EXCLUDE_NAMES = frozenset({"Uninstall 3CT.exe"})
#: 原版主程序 exe 改名后的名字，用于与运行中的原版/自动版进程区分。
EXE_SOURCE_NAME = "3CT.exe"
EXE_DEST_NAME = "1CT.exe"

INDEX_HTML_PATH = "dist/renderer/index.html"
PACKAGE_JSON_PATH = "package.json"
#: 主进程入口（托盘/窗口/通知的图标与文案都在这里引用）。
MAIN_JS_PATH = "dist/main/main.js"
#: preload 入口：原版 ctAPI 在这里暴露给渲染层；1CT 追加一个二课只读桥方法。
PRELOAD_JS_PATH = "dist/main/preload.js"
#: preload 补丁：原串在真实 asar 里已确认**唯一**（位于 ek 对象字面量内），
#: 在它后面追加新方法即可，不改变其余字节。
PRELOAD_JS_ANCHOR = b'getFinishList:e=>i.ipcRenderer.invoke("ek:getFinishList",e),'
#: 追加的新方法：渲染层 ctAPI.ek.getStuAllActApplyList 走 bootstrap 注册的 IPC。
PRELOAD_JS_ADDITION = (
    b'getStuAllActApplyList:e=>i.ipcRenderer.invoke("ek:getStuAllActApplyList",e),'
)
PRELOAD_JS_METHOD_NAME = "getStuAllActApplyList"
#: 1CT 专用 bootstrap（独立 userData），不再复用 3CT-Auto 的 desktop/bootstrap.cjs。
BOOTSTRAP_SOURCE = ONECT_DIR / "bootstrap-1ct.cjs"
BOOTSTRAP_PATH = "dist/main/auto-bootstrap.cjs"
ONECT_ASAR_DIR = "dist/renderer/1ct"
ONECT_INDEX_ASAR_PATH = ONECT_ASAR_DIR + "/index.html"
ONECT_ICON_PNG_PATH = ONECT_ASAR_DIR + "/icon.png"
WINDOW_TITLE = "1CT"
INDEX_TITLE_NEW = f"<title>{WINDOW_TITLE}</title>"
EXPECTED_MAIN = "./" + BOOTSTRAP_PATH

#: 1CT 专属图标（由图标所有者生成；本脚本只消费，不覆盖）。
ICON_DIR = ONECT_DIR / "assets"
ICON_ICO = ICON_DIR / "icon.ico"
ICON_PNG = ICON_DIR / "icon.png"
#: 随仓库走的 rcedit（给副本 exe 打图标）；缺失时降级。
RCEDIT_CANDIDATES = (
    ICON_DIR / "tools" / "rcedit.exe",
    ICON_DIR / "tools" / "rcedit-x64.exe",
)
RCEDIT_DOWNLOAD_HINT = "https://github.com/electron/rcedit/releases（rcedit.exe v2.0.0）"

#: index.html 必须加载的资源（契约 §6；顺序即推荐加载顺序）。
REQUIRED_INDEX_REFS = (
    "./jsQR.js",
    "./score-policy.js",
    "./result-store.js",
    "./automation.js",
    "./1ct/shell.css",
    "./1ct/fallback-photo.js",
    "./1ct/shell.js",
    "./1ct/members.js",
    "./1ct/ek-stats.js",
    "./1ct/ek-stats.css",
)
#: index.html 必须带的 favicon 链接（1CT 自己的图标，不用 3CT 的）。
REQUIRED_INDEX_ICON_REFS = ("./1ct/icon.png",)
#: 契约 §1/§6：这些资源**不得**再出现在 1CT 的 index.html 里。
FORBIDDEN_INDEX_REFS = (
    "./panel.js",
    "./panel.css",
    "./dashboard.js",
    "./dashboard.css",
    "./renderer.js",
)

#: 1CT 专属新文件（desktop/1ct/ 下，属于其它 teammate；本脚本只读消费）。
ONECT_SOURCE_FILES = (
    "index.html",
    "shell.js",
    "shell.css",
    "members.js",
    "ek-stats.js",
    "ek-stats.css",
)
#: 会被替换（而不是新增）的既有条目。
REPLACED_PATHS = frozenset(
    {INDEX_HTML_PATH, PACKAGE_JSON_PATH, MAIN_JS_PATH, PRELOAD_JS_PATH}
)
#: 新增的图标资源（asar 内路径 -> desktop/1ct/ 下的相对路径）。
ICON_SOURCES = {ONECT_ICON_PNG_PATH: "assets/icon.png"}

#: 兜底照片（图库没有图时用它走官方上传）：被打包进 asar，渲染层 fetch 后转 data URL。
FALLBACK_PHOTO_SOURCE = "fallback-photo.js"
FALLBACK_PHOTO_ASAR_PATH = ONECT_ASAR_DIR + "/fallback-photo.js"
FALLBACK_PHOTO_MAX_BYTES = 4 * 1024 * 1024

# ---------------------------------------------------------------------------
# 运行期图标（副本 resources/assets/，主进程从这里取托盘/窗口/通知图标）
# ---------------------------------------------------------------------------

#: 1CT 图标资产目录（由图标所有者生成；本脚本只读消费，绝不覆盖）。
#:   assets/icon.ico          —— 7 尺寸 ico
#:   assets/icon.png          —— 256×256
#:   assets/icons/*.png       —— 10 个静态尺寸（与 3CT 原文件名一一对应）
#:   assets/tools/rcedit.exe  —— 给副本 exe 打图标
ICON_ICONS_DIR = ICON_DIR / "icons"

#: 主进程写死取这两个文件：
#:   util.ts ASSETS_PATH = app.isPackaged ? path.join(process.resourcesPath, 'assets') : ...
#:   windowManager.ts:81  tray  -> getAssetPath('icon.ico' | 'icon.png')
#:   windowManager.ts:169 窗口 -> getAssetPath('favicon.ico' | 'icon.png')
#: 所以托盘图标来自 icon.ico、主窗口/任务栏图标来自 favicon.ico（Windows），
#: 通知图标来自 icon.png。三者都必须替换成 1CT，运行时图标才会跟着变。
RUNTIME_ASSET_FILES = (
    # (副本内相对 resources/ 的路径, desktop/1ct/assets/ 下的来源文件名)
    ("assets/icon.ico", "icon.ico"),
    ("assets/favicon.ico", "icon.ico"),   # 任务栏/标题栏图标，决定用户观感
    ("assets/icon.png", "icon.png"),
)
#: 静态尺寸目录（副本 resources/assets/icons/ 下按**同名**逐个覆盖）。
RUNTIME_ICON_DIR_REL = "assets/icons"

# ---------------------------------------------------------------------------
# 主进程内三处 3CT 文案（托盘 tooltip / 托盘菜单 / 关闭框标题）
# ---------------------------------------------------------------------------

#: 替换的纯 UI 文案 + Windows 应用身份（AppUserModelID）。
#: 均为压缩后 main.js 里**唯一**出现的精确串。
#:
#: AppUserModelID 必须换：Windows 任务栏按钮的图标是按 AUMID 去找**同名快捷方式**的，
#: 原版 `top.can6.3ct.app` 命中的是 3CT 安装时创建的快捷方式 → 任务栏永远显示 3CT 图标，
#: 哪怕 exe 本身已经换成 1CT 图标（rcedit 已改）。换成 1CT 专属 AUMID 后，
#: Windows 找不到对应快捷方式，就回落到窗口图标（resources/assets/favicon.ico）与 exe 图标，
#: 两者都已是 1CT。
#:
#: 刻意**不**替换这些功能性 3CT（替换会破功能）：
#:   `["3CT"]` 日志前缀、`orgName:"3CT"` Casdoor 组织、`3CT_Scheduler_` 调度器任务名前缀、
#:   `redirection.3ct.f.can6.top` 回调域名、renderer 里的界面文案。
MAIN_JS_TEXT_REPLACEMENTS = (
    # (说明, 原文, 替换)
    ("托盘 tooltip", 'n.setToolTip("3CT")', 'n.setToolTip("1CT")'),
    ("托盘菜单「退出」", '{label:"退出 3CT"', '{label:"退出 1CT"'),
    ("关闭框标题", 'title:"关闭 3CT",message:"选择关闭行为"', 'title:"关闭 1CT",message:"选择关闭行为"'),
    # Windows 应用身份：决定任务栏图标归属（见上方说明）
    ("AppUserModelID", '"top.can6.3ct.app"', '"top.can6.1ct.app"'),
)
#: 替换后必须仍然存在的功能性 3CT（防误伤；verify 会断言）。
PROTECTED_MAIN_JS_STRINGS = (
    'orgName:"3CT"',
    '3CT_Scheduler_',
    "redirection.3ct.f.can6.top",
)

README_TEXT = """1CT（完全独立的精简副本）
=========================

由 desktop/install_1ct.py 从原始 3CT 复制并打补丁生成；原版 3CT 目录未被修改。
渲染层替换为极简白 1CT 界面（成员管理 / 二课统计 / 三大自动化模块），
并换成 1CT 自己的图标（不再是 3CT 的图标）。

怎么启动（只有一个入口）
------------------------
**请只双击仓库根目录的 启动1CT.exe**，那是 1CT 唯一的用户入口。
它会无控制台地启动本目录的 1CT.exe。

本目录里的 1CT.exe 是 **Electron 本体**，删掉程序就起不来；
它不需要你手动点，交给 启动1CT.exe 就行。
（为避免出现两个入口，本目录内**不再**放 启动1CT.exe 的副本。）

start-1ct.cmd 是纯文本兜底入口，仅在 GUI 启动器出问题时排错用。

首次启动需要**重新登录**：1CT 有自己的用户数据目录，不继承 3CT 的登录态
（这正是"独立"的代价和目的）。

用户数据是独立的（可与 3CT / 3CT-Auto 同时运行）
------------------------------------------------
1CT 默认使用**自己的**用户数据目录：

    %APPDATA%\\1CT          ← 1CT 专用
    %APPDATA%\\3CT          ← 原版 3CT 与 3CT 自动版（1CT 不读也不写）

因此：
  - 三个程序目录可以同时存在，互不干扰；
  - 1CT 与 3CT / 3CT-Auto **可以同时运行**（各有各的单实例锁）；
  - 但 1CT 自己同一时刻仍然只能开一个。

想回到"与 3CT 共用 userData"的旧行为（会要求先退出 3CT / 3CT-Auto）：

    1CT.exe --shared-user-data
    或  设置环境变量 CT_SHARE_USER_DATA=1

构建命令（在仓库根目录执行）
-----------------------------------------------
    python desktop\\install_1ct.py build              生成/更新 1CT 副本 + 启动器
    python desktop\\install_1ct.py build --force      覆盖重建（有安全闸，见 packaging.md）
    python desktop\\install_1ct.py verify             校验成品（注入清单/哈希/启动器/图标）
    python desktop\\build_gui_launcher.py --brand 1ct 只刷新 启动1CT.exe
    python -m unittest discover -s tests -p "test_1ct*.py"

注意
----
- 副本已禁用自动更新（不会下载/安装官方更新覆盖原程序）；bootstrap 覆盖了
  checkForUpdates / quitAndInstall / setFeedURL，并置 autoDownload=false、
  autoInstallOnAppQuit=false。请不要在副本里手动安装官方更新。
- 每日任务需要应用保持打开、且电脑处于唤醒状态才会执行；关机/睡眠期间不会补跑
  （依赖应用内调度器）。建议把应用常驻并关闭系统睡眠。
- 本副本只替换渲染层脚本并新增本地文件，不修改账号数据、不上传凭证。
"""

#: 除 README 外，副本里再放一份纯 ASCII 的启动说明（便于任何编码/控制台环境阅读）。
START_NOTE_NAME = "HOW-TO-START-1CT.txt"
START_NOTE_TEXT = """1CT - how to start this independent copy
==========================================

Generated by desktop/install_1ct.py from the original 3CT folder.
The original 3CT folder is never modified.

START
-----
1. Double-click the GUI launcher in this folder: the file name ends with "1CT.exe"
   and is prefixed with two Chinese characters meaning "start". It is a GUI launcher
   (no console window) and starts 1CT.exe from this folder. A copy of it also sits
   in the repo root.
2. You may also run 1CT.exe directly (same program, without the process checks).
3. start-1ct.cmd is an ASCII fallback entry point for troubleshooting only.
4. The FIRST start needs a fresh login: 1CT keeps its own user data and does NOT
   inherit the login state of 3CT. That independence is intentional.

INDEPENDENT USER DATA (can run alongside 3CT / 3CT-Auto)
--------------------------------------------------------
1CT uses its OWN user data folder by default:

    %APPDATA%\\1CT     <- used only by 1CT
    %APPDATA%\\3CT     <- the original 3CT and the 3CT auto copy (untouched by 1CT)

Consequences:
  - all three program folders can coexist on disk;
  - 1CT CAN run at the same time as 3CT / 3CT-Auto (separate single-instance locks);
  - only one 1CT instance at a time.

To fall back to the old behaviour (share userData with 3CT; then you must quit
3CT / 3CT-Auto first):

    1CT.exe --shared-user-data
    or set the environment variable CT_SHARE_USER_DATA=1

WHY package.json name stays 3CT
-------------------------------
Electron derives the DEFAULT userData from app.name; renaming it would fork user
data in a way that is hard to migrate. Instead the bootstrap sets the path
explicitly to %APPDATA%\\1CT, so package.json stays untouched while the runtime
still uses an independent folder. The window title is 1CT, taken from this copy's
index.html <title>1CT</title>.

ICON
----
This copy uses its own icon everywhere:
- 1CT.exe  : patched with rcedit (file/taskbar icon of the process);
- QiDong1CT.exe : compiled with /win32icon (the only user-facing entry point);
- resources\\assets\\{icon.ico,favicon.ico,icon.png,icons\\*.png} : replaced so the
  RUNTIME tray icon, main-window title-bar/taskbar icon and notification icon are
  1CT too (the main process loads them from resources\\assets at runtime).

The original 3CT\\3CT.exe and 3CT\\resources\\assets\\* keep the vendor icon and are
never modified.

ONE ENTRY POINT
---------------
The only user-facing entry point is QiDong1CT.exe in the repo root. This folder keeps
1CT.exe because it is the Electron executable itself (the app cannot start without
it); do NOT double-click it. To avoid two confusing entries, this folder no longer
contains a copy of QiDong1CT.exe.

BUILD
-----
    python desktop\\install_1ct.py build              build/refresh this copy
    python desktop\\install_1ct.py build --force      rebuild (guarded, see packaging.md)
    python desktop\\install_1ct.py verify             verify the packaged copy
    python desktop\\build_gui_launcher.py --brand 1ct refresh only the launcher

NOTES
-----
- Auto-update is disabled inside this copy (autoDownload=false,
  autoInstallOnAppQuit=false, checkForUpdates/quitAndInstall/setFeedURL overridden).
  Do not install official updates inside this copy.
- Daily automation only runs while the app is open and the PC is awake; it does not
  catch up after shutdown/sleep.
"""


# ---------------------------------------------------------------------------
# 补丁：index.html / package.json
# ---------------------------------------------------------------------------


def _extract_csp(html: str) -> str | None:
    """从原版 index.html 取出 CSP content（保持原样）。"""

    match = re.search(
        r"<meta[^>]*http-equiv=[\"']?Content-Security-Policy[\"']?[^>]*>",
        html,
        re.IGNORECASE,
    )
    if not match:
        return None
    tag = match.group(0)
    # 属性值本身可能含另一种引号（如 content="default-src 'self'"），不能简单用 [^"']*。
    content = re.search(
        r"content=(?:\"([^\"]*)\"|'([^']*)')", tag, re.IGNORECASE
    )
    if not content:
        return None
    return content.group(1) if content.group(1) is not None else content.group(2)


def _insert_into_head(html: str, fragment: str) -> str:
    """把 *fragment* 插到 ``<head>`` 开头；没有 head 就插到 ``</head>`` 前。"""

    match = re.search(r"<head[^>]*>", html, re.IGNORECASE)
    if match:
        return html[: match.end()] + fragment + html[match.end():]
    if "</head>" in html:
        return html.replace("</head>", fragment + "</head>", 1)
    raise InstallerError("1CT index.html 缺少 <head>，无法注入标题/CSP")


def prepare_index_html(
    onect_html: bytes,
    original_html: bytes | None = None,
    *,
    title: str = WINDOW_TITLE,
) -> bytes:
    """把 desktop/1ct/index.html 规范化为可打包的 renderer 入口。

    - 校验必须加载的 1CT 资源齐全，且不再引用 panel/dashboard/renderer；
    - 保证 ``<title>1CT</title>``；
    - 保证带 1CT 自己的 favicon ``<link rel="icon" href="./1ct/icon.png">``
      （用户要求：别用 3CT 的图标）；
    - 若 1CT 页面自身没写 CSP，则沿用原版 index.html 的 CSP（file:// 下的保底）。
    """

    try:
        text = onect_html.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise InstallerError(f"1CT index.html 不是合法 UTF-8: {exc}") from exc

    lowered = text.lower()
    forbidden = [ref for ref in FORBIDDEN_INDEX_REFS if ref in text]
    if forbidden:
        raise InstallerError(
            "1CT index.html 不应再引用 " + ", ".join(forbidden)
            + "（契约 §6：不再打包 panel/dashboard，也不加载原版 renderer.js）"
        )
    missing = [ref for ref in REQUIRED_INDEX_REFS if ref not in text]
    if missing:
        raise InstallerError(
            "1CT index.html 缺少必须加载的资源: " + ", ".join(missing)
        )

    wanted_title = f"<title>{title}</title>"
    if wanted_title not in text:
        if re.search(r"<title[^>]*>.*?</title>", text, re.IGNORECASE | re.DOTALL):
            text = re.sub(
                r"<title[^>]*>.*?</title>",
                wanted_title,
                text,
                count=1,
                flags=re.IGNORECASE | re.DOTALL,
            )
        else:
            text = _insert_into_head(text, wanted_title)

    # favicon：用户明确要求 1CT 用自己的图标（别用 3CT 的）。
    # 若页面已有 icon link 但指向别处（例如 3CT 的），替换成 1CT 的。
    icon_ref = REQUIRED_INDEX_ICON_REFS[0]
    icon_tag = f'<link rel="icon" type="image/png" href="{icon_ref}">'
    icon_pattern = re.compile(
        r"<link[^>]*\brel=[\"']?[^\"'>]*\bicon\b[^>]*>", re.IGNORECASE
    )
    existing_icon = icon_pattern.search(text)
    if existing_icon:
        if icon_ref not in existing_icon.group(0):
            text = text[: existing_icon.start()] + icon_tag + text[existing_icon.end():]
    else:
        text = _insert_into_head(text, icon_tag)

    if "content-security-policy" not in lowered and original_html is not None:
        try:
            original_text = original_html.decode("utf-8", "replace")
        except Exception:  # pragma: no cover - decode 不会走到这里
            original_text = ""
        csp = _extract_csp(original_text)
        if csp:
            escaped = csp.replace('"', "&quot;")
            text = _insert_into_head(
                text,
                f'<meta http-equiv="Content-Security-Policy" content="{escaped}">',
            )

    encoded = text.encode("utf-8")
    # 最终自检：注入后的内容必须同时满足标题、清单与图标要求。
    final = encoded.decode("utf-8")
    if INDEX_TITLE_NEW not in final:
        raise InstallerError("1CT index.html 标题注入失败")
    still_forbidden = [ref for ref in FORBIDDEN_INDEX_REFS if ref in final]
    if still_forbidden:
        raise InstallerError("1CT index.html 规范化后仍引用 " + ", ".join(still_forbidden))
    for ref in REQUIRED_INDEX_ICON_REFS:
        if ref not in final:
            raise InstallerError(f"1CT index.html 缺少 favicon 链接: {ref}")
    return encoded


def patch_package_json(original: bytes, *, product_name: str | None = None) -> bytes:
    """把 package.json 的 main 指向 auto-bootstrap，并按需设置 productName。

    默认**不改** name/productName/appId：Electron 用其一决定 userData 路径，
    改了会把 1CT 的 userData 从 ``%APPDATA%\\3CT`` 分叉出去，破坏与 3CT-Auto
    共享登录态/单实例锁的设计（详见模块 docstring 与 packaging.md）。
    """

    try:
        package = json.loads(original.decode("utf-8"))
    except ValueError as exc:
        raise InstallerError(f"package.json 不是合法 JSON: {exc}") from exc
    if not isinstance(package, dict):
        raise InstallerError("package.json 顶层不是对象")
    if "name" not in package or "version" not in package:
        raise InstallerError("package.json 缺少 name/version")
    package["main"] = EXPECTED_MAIN
    if product_name:
        package["productName"] = product_name
    return json.dumps(package, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


# ---------------------------------------------------------------------------
# 补丁输入
# ---------------------------------------------------------------------------


def _display_path(path: Path, desktop_dir: Path) -> str:
    """尽量用仓库内/desktop 内相对路径展示，便于用户直接定位。"""

    resolved = path.resolve()
    for anchor in (desktop_dir, REPO_ROOT):
        try:
            return resolved.relative_to(anchor.resolve()).as_posix()
        except ValueError:
            continue
    return str(resolved)


def patch_source_map(desktop_dir: str | Path = DESKTOP_DIR) -> dict[str, Path]:
    """ASAR 内路径 -> desktop 侧实际来源文件（唯一事实来源，加载/漂移检测共用）。"""

    desktop_dir = Path(desktop_dir)
    onect_dir = desktop_dir / "1ct"
    sources = {
        "dist/renderer/jsQR.js": desktop_dir / "vendor" / "jsQR.js",
        "dist/renderer/score-policy.js": desktop_dir / "score-policy.js",
        "dist/renderer/result-store.js": desktop_dir / "result-store.js",
        "dist/renderer/automation.js": desktop_dir / "automation.js",
        ONECT_ASAR_DIR + "/shell.js": onect_dir / "shell.js",
        ONECT_ASAR_DIR + "/shell.css": onect_dir / "shell.css",
        ONECT_ASAR_DIR + "/members.js": onect_dir / "members.js",
        ONECT_ASAR_DIR + "/ek-stats.js": onect_dir / "ek-stats.js",
        ONECT_ASAR_DIR + "/ek-stats.css": onect_dir / "ek-stats.css",
        ONECT_INDEX_ASAR_PATH: onect_dir / "index.html",
        # 1CT 专用 bootstrap（独立 userData），不是 3CT-Auto 的 bootstrap.cjs
        BOOTSTRAP_PATH: onect_dir / "bootstrap-1ct.cjs",
    }
    for archive_path, rel in ICON_SOURCES.items():
        sources[archive_path] = onect_dir / rel
    # 兜底照片（可选但默认必须存在：没有它冷门活动就签不上）
    sources[FALLBACK_PHOTO_ASAR_PATH] = onect_dir / FALLBACK_PHOTO_SOURCE
    return sources


#: 新文件：ASAR 内路径 -> desktop 目录下的来源（默认布局下的静态快照，
#: index.html / package.json 单独处理）。运行时以 :func:`patch_source_map` 为准。
PATCH_SOURCES = patch_source_map(DESKTOP_DIR)


def load_patch_inputs(desktop_dir: str | Path = DESKTOP_DIR) -> dict[str, bytes]:
    """收集需要写入 ASAR 的新文件；缺失时给出明确中文错误（不要静默跳过）。"""

    desktop_dir = Path(desktop_dir).resolve()
    sources = patch_source_map(desktop_dir)
    missing = [
        _display_path(path, desktop_dir) for path in sources.values() if not path.is_file()
    ]
    if missing:
        raise InstallerError(
            "缺少 1CT 补丁输入文件: "
            + ", ".join(missing)
            + "（desktop/1ct/* 由 ui-shell/members-core/ek-stats 产出，文件齐了再构建）"
        )
    return {archive_path: path.read_bytes() for archive_path, path in sources.items()}


def _ensure_vendor(source_asar: Path, desktop_dir: Path) -> None:
    """desktop/vendor/jsQR.js 是 gitignore 的生成物；缺失时从原包 sourcemap 恢复。"""

    vendor_script = desktop_dir / "vendor" / "jsQR.js"
    if vendor_script.is_file():
        return
    try:
        extract_jsqr(source_asar, desktop_dir / "vendor")
    except InstallerError as exc:
        raise InstallerError(
            f"缺少 desktop/vendor/jsQR.js，且自动恢复失败: {exc}；"
            "请运行 python desktop/install_1ct.py extract-vendor"
        ) from exc


def patch_main_js(original: bytes) -> tuple[bytes, list[dict]]:
    """把 asar 内 ``dist/main/main.js`` 的三处 3CT UI 文案换成 1CT。

    契约：**只改文案，不改逻辑**。做法是对压缩后的 main.js 做精确串替换，
    三处串都必须是**唯一出现**，否则直接报错（宁可不改，也不要改错代码）。

    刻意不动的功能性字符串见 :data:`PROTECTED_MAIN_JS_STRINGS`。

    返回 ``(new_bytes, applied)``，``applied`` 含每处替换的命中次数与偏移，
    供 verify 逐条复核。
    """

    try:
        text = original.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise InstallerError(f"{MAIN_JS_PATH} 不是合法 UTF-8: {exc}") from exc

    applied: list[dict] = []
    for label, old, new in MAIN_JS_TEXT_REPLACEMENTS:
        count = text.count(old)
        if count != 1:
            raise InstallerError(
                f"{MAIN_JS_PATH} 文案替换失败（{label}）：期望唯一命中 1 次，实际 {count} 次。"
                f" 目标串={old!r}。原程序可能已升级，请重新核对文案。"
            )
        offset = text.index(old)
        text = text.replace(old, new, 1)
        applied.append(
            {"label": label, "old": old, "new": new, "count": count, "offset": offset}
        )

    # 保护性自检：功能性 3CT 必须原样还在。
    for needle in PROTECTED_MAIN_JS_STRINGS:
        if needle not in text:
            raise InstallerError(
                f"{MAIN_JS_PATH} 替换误伤功能性字符串: {needle!r}（拒绝产出这种补丁）"
            )

    encoded = text.encode("utf-8")
    return encoded, applied


def patch_preload_js(original: bytes) -> bytes:
    """向原版 ``dist/main/preload.js`` 追加二课「报名/完成列表」桥方法。

    背景：3CT 的 ctAPI 从未暴露 ``GetStuAllActApplyList``（官网「报名/完成列表」
    页真正的数据源，带 SignD=已签到 / SignT=已签退），而 ``ek.getSignList`` 对部分
    活动返回 0 条。1CT 因此由 bootstrap 注册对应 IPC，并在 preload 的 ek 对象里
    补一个同名方法。

    做法是**最小补丁**：只在已确认唯一的锚点后插入一个方法，其余字节一律不动。
    - 锚点必须恰好出现 1 次，否则报错（原程序升级/被改动过时宁可不打包）；
    - 幂等：已打过补丁的输入原样返回，重复调用不会重复插入。

    返回替换后的新字节；不修改入参。
    """

    anchor = PRELOAD_JS_ANCHOR
    addition = PRELOAD_JS_ADDITION
    if original.count(anchor + addition) == 1 and original.count(anchor) == 1:
        # 已经打过补丁（锚点后紧跟新方法）→ 幂等返回，避免重复插入。
        return original
    count = original.count(anchor)
    if count != 1:
        raise InstallerError(
            f"{PRELOAD_JS_PATH} preload 补丁失败：锚点期望唯一命中 1 次，实际 {count} 次。"
            f" 锚点={anchor!r}。原程序可能已升级（preload 被重新压缩），"
            "请重新核对 preload.js 里的 getFinishList 定义再打包。"
        )
    return original.replace(anchor, anchor + addition, 1)


def build_patched_asar(
    source_archive: str | Path,
    desktop_dir: str | Path = DESKTOP_DIR,
    *,
    product_name: str | None = None,
    inputs: dict[str, bytes] | None = None,
) -> bytes:
    """读取原 ASAR，应用 1CT 的 index.html/package.json/新文件补丁，返回重建字节。

    *inputs* 可传入已收集的补丁素材快照（构建时只读一次磁盘，避免与并行写冲突）。
    """

    source_archive = Path(source_archive).resolve()
    desktop_dir = Path(desktop_dir).resolve()
    if inputs is None:
        inputs = load_patch_inputs(desktop_dir)
    else:
        inputs = dict(inputs)

    header, data_base = read_header(source_archive)
    index_node = find_node(header, INDEX_HTML_PATH)
    package_node = find_node(header, PACKAGE_JSON_PATH)
    main_node = find_node(header, MAIN_JS_PATH)
    preload_node = find_node(header, PRELOAD_JS_PATH)
    if index_node is None or package_node is None:
        raise InstallerError(f"原 ASAR 缺少 {INDEX_HTML_PATH} 或 {PACKAGE_JSON_PATH}")

    original_index = read_file(source_archive, index_node, data_base)
    replacements = dict(inputs)
    replacements[INDEX_HTML_PATH] = prepare_index_html(
        inputs[ONECT_INDEX_ASAR_PATH], original_index
    )
    replacements[PACKAGE_JSON_PATH] = patch_package_json(
        read_file(source_archive, package_node, data_base), product_name=product_name
    )

    # 三处 3CT UI 文案 -> 1CT（托盘 tooltip / 托盘菜单退出 / 关闭框标题）。
    # main.js 必须存在；缺失说明原包结构变了，宁可报错也不要静默跳过。
    if main_node is None:
        raise InstallerError(
            f"原 ASAR 缺少 {MAIN_JS_PATH}，无法替换托盘/窗口文案"
            "（原程序结构可能已升级，请重新核对）"
        )
    patched_main, _applied = patch_main_js(
        read_file(source_archive, main_node, data_base)
    )
    replacements[MAIN_JS_PATH] = patched_main

    # preload 最小补丁：暴露 ek.getStuAllActApplyList（官网报名/完成列表，带签到状态）。
    # 缺失说明原包结构变了，宁可报错也不要静默产出“渲染层没有桥方法”的包。
    if preload_node is None:
        raise InstallerError(
            f"原 ASAR 缺少 {PRELOAD_JS_PATH}，无法向 preload 暴露 "
            f"{PRELOAD_JS_METHOD_NAME}（原程序结构可能已升级，请重新核对）"
        )
    replacements[PRELOAD_JS_PATH] = patch_preload_js(
        read_file(source_archive, preload_node, data_base)
    )
    return rebuild_asar(source_archive, replacements)


# ---------------------------------------------------------------------------
# 复制与生成
# ---------------------------------------------------------------------------


def _is_within(child: Path, parent: Path) -> bool:
    try:
        child.relative_to(parent)
        return True
    except ValueError:
        return False


def _rmtree_confirmed(path: Path) -> None:
    """仅在调用方已完成目录归属确认后删除。"""

    path = path.resolve()
    if path == Path(path.anchor):
        raise InstallerError(f"拒绝删除磁盘根目录: {path}")
    if path.exists():
        shutil.rmtree(path)


def check_removable(dest_dir: Path, source_asar: Path, source_dir: Path) -> None:
    """--force 的目录安全闸：只允许本仓库的安装目标，或带匹配 marker 的旧副本。"""

    dest_dir = dest_dir.resolve()
    expected = DEST_DIR.resolve()
    if dest_dir == expected:
        return
    marker_path = dest_dir / MARKER_NAME
    if not marker_path.is_file():
        raise InstallerError(
            f"拒绝删除未确认的目录: {dest_dir}"
            f"（只允许 {expected}，或包含 {MARKER_NAME} 且源哈希匹配的旧副本）"
        )
    try:
        marker = json.loads(marker_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise InstallerError(f"安装标记无法读取，拒绝删除: {exc}") from exc
    if not isinstance(marker, dict) or marker.get("generator") != "desktop/install_1ct.py":
        raise InstallerError(f"安装标记不属于本工具，拒绝删除: {marker_path}")
    current_hash = sha256_file(source_asar)
    if marker.get("source_asar_sha256") != current_hash:
        raise InstallerError(
            "旧副本的源 ASAR 哈希与当前原程序不一致（可能原版已升级），"
            "拒绝自动删除；请手动确认后删除目标目录再重建"
        )
    marker_source = marker.get("source")
    if marker_source and Path(marker_source).resolve() != source_dir.resolve():
        raise InstallerError("旧副本的源目录与本次不一致，拒绝删除")


def write_marker(dest_dir: Path, summary: dict) -> Path:
    marker_path = dest_dir / MARKER_NAME
    dest_dir = Path(dest_dir)
    exe_path = dest_dir / EXE_DEST_NAME
    marker = {
        "generator": "desktop/install_1ct.py",
        "brand": "1CT",
        "source": summary["source"],
        "source_asar_sha256": summary["original_asar_sha256"],
        "patched_asar_sha256": summary["patched_asar_sha256"],
        "user_data_mode": "independent",
        "user_data_dir": str(ONECT_USER_DATA_DIR),
        # 打图标后 1CT.exe 的哈希会与 3CT.exe 不同（这正是独立化的证据）。
        "exe_sha256": sha256_file(exe_path) if exe_path.is_file() else None,
        "exe_icon": summary.get("exe_icon"),
        "created_at": datetime.now().isoformat(timespec="seconds"),
    }
    marker_path.write_text(
        json.dumps(marker, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    return marker_path


def copy_app_tree(source_dir: Path, dest_dir: Path) -> dict:
    source_dir = Path(source_dir).resolve()
    dest_dir = Path(dest_dir).resolve()
    if source_dir == dest_dir:
        raise InstallerError("源目录与目标目录相同")
    dest_dir.mkdir(parents=True, exist_ok=False)

    copied = 0
    skipped: list[str] = []
    for entry in sorted(source_dir.iterdir(), key=lambda item: item.name):
        if entry.name in COPY_EXCLUDE_NAMES:
            skipped.append(entry.name)
            continue
        target_name = EXE_DEST_NAME if entry.name == EXE_SOURCE_NAME else entry.name
        target = dest_dir / target_name
        if entry.is_dir():
            shutil.copytree(entry, target)
            copied += sum(1 for _ in target.rglob("*") if _.is_file())
        else:
            shutil.copy2(entry, target)
            copied += 1
    return {"copied": copied, "skipped": skipped}


def _load_icon_asset(name: str) -> bytes:
    path = ICON_DIR / name
    if not path.is_file():
        raise InstallerError(
            f"缺少 1CT 运行期图标资产: {_display_path(path, DESKTOP_DIR)}"
            f"（图标由 desktop/1ct/assets/ 提供，本脚本只消费）"
        )
    return path.read_bytes()


def replace_runtime_assets(src_assets: Path, dest_assets: Path) -> dict:
    """把副本 ``resources/assets/`` 下的图标换成 1CT 的（**只改副本**）。

    主进程从 ``process.resourcesPath/assets`` 取图：
      - ``icon.ico``     → 托盘图标 + 通知图标（win）
      - ``favicon.ico``  → **主窗口标题栏/任务栏图标**（win）
      - ``icon.png``     → 通知图标 / 非 Windows 窗口图标
      - ``icons/*.png``  → 多尺寸静态图标（安装包/快捷方式等）
    这些如果还是 3CT 的，运行时托盘与任务栏就仍然显示 3CT。

    *src_assets* 是**原版** assets 目录（只读，用于列出真实文件名）；
    *dest_assets* 是副本 assets 目录（可写）。
    """

    if not dest_assets.is_dir():
        raise InstallerError(f"副本缺少 resources/assets 目录: {dest_assets}")
    if not ICON_DIR.is_dir():
        raise InstallerError(f"缺少 1CT 图标资产目录: {ICON_DIR}")

    replaced: list[dict] = []

    # 1) 三个主图标（注意 favicon.ico 与 icon.ico 同源，但**都必须**写）。
    for rel, source_name in RUNTIME_ASSET_FILES:
        data = _load_icon_asset(source_name)
        target = dest_assets / rel.split("/", 1)[1]
        before = sha256_file(target) if target.is_file() else None
        write_atomic(target, data)
        replaced.append(
            {
                "file": rel.split("/", 1)[1],
                "bytes": len(data),
                "sha256": sha256_bytes(data),
                "before_sha256": before,
            }
        )

    # 2) icons/*.png：按**原版实际文件名**逐个同名覆盖（不按尺寸硬套）。
    src_icons = src_assets / "icons"
    dest_icons = dest_assets / "icons"
    icon_rows: list[dict] = []
    if src_icons.is_dir():
        if not ICON_ICONS_DIR.is_dir():
            raise InstallerError(f"缺少 1CT 静态图标目录: {ICON_ICONS_DIR}")
        available = {
            p.name: p for p in ICON_ICONS_DIR.iterdir() if p.is_file() and p.suffix == ".png"
        }
        missing_sources: list[str] = []
        for src_file in sorted(src_icons.iterdir(), key=lambda p: p.name):
            if not src_file.is_file():
                continue
            source = available.get(src_file.name)
            if source is None:
                missing_sources.append(src_file.name)
                continue
            data = source.read_bytes()
            target = dest_icons / src_file.name
            before = sha256_file(target) if target.is_file() else None
            write_atomic(target, data)
            icon_rows.append(
                {
                    "file": src_file.name,
                    "bytes": len(data),
                    "sha256": sha256_bytes(data),
                    "before_sha256": before,
                    "source_before_sha256": sha256_file(src_file),
                }
            )
        if missing_sources:
            raise InstallerError(
                "desktop/1ct/assets/icons/ 缺少这些原版尺寸: "
                + ", ".join(missing_sources)
                + "（1CT 图标必须按原版文件名 1:1 覆盖，不能少）"
            )
        replaced.append({"icons_dir": [row["file"] for row in icon_rows], "count": len(icon_rows)})
    else:
        raise InstallerError(f"原版缺少 resources/assets/icons 目录: {src_icons}")

    return {"files": replaced, "icons": icon_rows}


def write_readme(dest_dir: Path) -> Path:
    """写中文 README 与一份纯 ASCII 启动说明（两种编码环境都可读）。"""

    dest_dir = Path(dest_dir)
    path = dest_dir / README_NAME
    path.write_text(README_TEXT, encoding="utf-8")
    note = dest_dir / START_NOTE_NAME
    note.write_text(START_NOTE_TEXT, encoding="ascii", newline="\r\n")
    return path




def write_version_file(dest_dir: Path, summary: dict) -> Path:
    """写 VERSION-1CT.txt：构建时间 + asar 哈希 + 升级说明（分发/升级时用来区分副本）。"""

    dest_dir = Path(dest_dir)
    path = dest_dir / VERSION_NAME
    lines = [
        "1CT 版本信息（分发/升级时用这个文件区分新旧副本）",
        "================================================",
        "",
        "构建时间   : " + datetime.now().isoformat(timespec="seconds"),
        "asar sha256: " + str(summary.get("patched_asar_sha256", "")),
        "源 asar    : " + str(summary.get("original_asar_sha256", "")),
        "",
        "安装形态：便携版（解压即用，无需安装）",
        "",
        "用户数据在哪（升级不影响）",
        "--------------------------",
        "    %APPDATA%\\1CT",
        "",
        "成员、配置、执行历史、兜底照片都在上面这个目录；",
        "升级时只要替换程序目录，用户数据自动保留。",
        "",
        "升级步骤",
        "--------",
        "1) 先退出 1CT（托盘图标右键退出，或任务管理器结束 1CT.exe）",
        "2) 用新压缩包整个替换旧的 1CT 目录（不要只覆盖部分文件）",
        "3) 重新双击 启动1CT.exe",
        "",
        "注意：程序运行中替换会因文件占用失败；先关再换。",
        "",
    ]
    path.write_text("\n".join(lines), encoding="utf-8", newline="\r\n")
    return path


def write_start_script(dest_dir: Path) -> Path:
    """写一个纯 ASCII 的 CMD 兜底入口（GUI 启动器不可用时的排错备用）。"""

    script = (
        b"@echo off\r\n"
        b"title 1CT Launcher\r\n"
        b"rem 1CT fallback launcher (double-click friendly). Prefer the GUI exe.\r\n"
        b"rem This file MUST stay pure ASCII with CRLF line endings.\r\n"
        b"rem 1CT has its OWN userData (%%APPDATA%%\\1CT) and its own single-instance\r\n"
        b"rem lock, so it CAN run at the same time as 3CT / 3CT-Auto.\r\n"
        b"rem It never kills any process.\r\n"
        b"setlocal\r\n"
        b'set "ELECTRON_RUN_AS_NODE="\r\n'
        b'set "NODE_OPTIONS="\r\n'
        b'set "NODE_PATH="\r\n'
        b'cd /d "%~dp0"\r\n'
        b"\r\n"
        b'set "APP="\r\n'
        b'if exist "%~dp01CT.exe" set "APP=%~dp01CT.exe"\r\n'
        b'if not defined APP if exist "%~dp01CT\\1CT.exe" set "APP=%~dp01CT\\1CT.exe"\r\n'
        b"if not defined APP (\r\n"
        b"  echo [1CT] Cannot find 1CT.exe.\r\n"
        b"  echo [1CT] Build the copy first, from the repo root:\r\n"
        b"  echo [1CT]     python desktop\\install_1ct.py build\r\n"
        b"  pause\r\n"
        b"  exit /b 1\r\n"
        b")\r\n"
        b"\r\n"
        b'tasklist /FI "IMAGENAME eq 1CT.exe" 2>nul | findstr /I /C:"1CT.exe" >nul\r\n'
        b"if not errorlevel 1 (\r\n"
        b"  echo [1CT] 1CT is already running. Not starting another instance.\r\n"
        b"  pause\r\n"
        b"  exit /b 0\r\n"
        b")\r\n"
        b"\r\n"
        b'tasklist /FI "IMAGENAME eq 3CT.exe" 2>nul | findstr /I /C:"3CT.exe" >nul\r\n'
        b"if not errorlevel 1 (\r\n"
        b"  echo [1CT] The original 3CT is running.\r\n"
        b"  echo [1CT] That is fine: 1CT has its own userData %%APPDATA%%\\1CT.\r\n"
        b"  echo [1CT] Both can run at the same time. Continuing...\r\n"
        b")\r\n"
        b"\r\n"
        b'echo [1CT] Starting...\r\n'
        b'start "" "%APP%" %*\r\n'
        b"exit /b 0\r\n"
    )
    path = Path(dest_dir) / START_SCRIPT_NAME
    path.write_bytes(script)
    return path


# ---------------------------------------------------------------------------
# 启动器（复用 desktop/build_gui_launcher.py 的 1CT 品牌）
# ---------------------------------------------------------------------------


def _load_launcher_builder():
    return _load_sibling("build_gui_launcher")


def build_launcher(
    *,
    dest_dir: Path | None = None,
    root_exe: Path | None = None,
    icon: Path | None = None,
    csc: Path | None = None,
    also_copy_to_dest: bool = False,
) -> dict:
    """编译 启动1CT.exe（WinExe / PE Subsystem=2）。

    **默认只产出仓库根入口**（用户要求「只留一个」）。``also_copy_to_dest=True``
    才会再往副本目录里放一份同名入口（历史行为，默认关闭）。

    编译失败只抛 :class:`InstallerError`；找不到 csc 时由调用方决定是否降级。
    """

    builder = _load_launcher_builder()
    profile = builder.BRANDS["1ct"]
    root_target = Path(root_exe) if root_exe is not None else profile.root_exe
    dest_target = Path(dest_dir) / LAUNCHER_NAME if dest_dir is not None else None
    try:
        builder.build_csharp(profile.source, root_target, target="winexe", icon=icon, csc=csc)
        copied = None
        if also_copy_to_dest and dest_target is not None:
            dest_target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(root_target, dest_target)
            copied = str(dest_target.resolve())
    except builder.BuildError as exc:
        raise InstallerError(f"构建 1CT GUI 启动器失败: {exc}") from exc
    return {
        "source": str(profile.source),
        "root_exe": str(root_target.resolve()),
        "copy_exe": copied,
        "exe_bytes": root_target.stat().st_size,
    }


def remove_duplicate_launcher(dest_dir: Path) -> dict:
    """删掉副本目录内的 ``启动1CT.exe``（用户要求「只留一个」）。

    保留仓库根的 ``启动1CT.exe`` 作为唯一用户入口；副本内 ``1CT.exe`` 必须保留
    （它是 Electron 本体，删了启动器就找不到主程序）。
    """

    duplicate = Path(dest_dir) / LAUNCHER_NAME
    if duplicate.is_file():
        duplicate.unlink()
        return {"removed": str(duplicate), "duplicate_present": False}
    return {"removed": None, "duplicate_present": False}


# ---------------------------------------------------------------------------
# exe 图标（rcedit；只改副本，绝不碰 3CT\3CT.exe）
# ---------------------------------------------------------------------------


def find_rcedit() -> Path | None:
    """返回可用的 rcedit.exe：仓库内置优先，其次 PATH / TEMP。"""

    for candidate in RCEDIT_CANDIDATES:
        if candidate.is_file():
            return candidate
    for name in ("rcedit.exe", "rcedit-x64.exe"):
        found = shutil.which(name)
        if found:
            return Path(found)
    env = os.environ
    for temp_dir in {env.get("TEMP"), env.get("TMP"), env.get("LOCALAPPDATA")}:
        if not temp_dir:
            continue
        for name in ("rcedit.exe", "rcedit-x64.exe"):
            candidate = Path(temp_dir) / name
            if candidate.is_file():
                return candidate
    return None


def pe_icon_report(exe: str | Path) -> dict:
    """读出 exe 的 ICON / GROUP_ICON 资源指纹（用于证明图标已换、且与 3CT 不同）。

    只用标准库解析 PE 资源目录，不依赖 pefile。
    """

    exe = Path(exe)
    data = exe.read_bytes()
    if len(data) < 0x40 or data[:2] != b"MZ":
        raise InstallerError(f"不是 PE 文件: {exe}")
    e_lfanew = struct.unpack_from("<I", data, 0x3C)[0]
    if data[e_lfanew:e_lfanew + 4] != b"PE\0\0":
        raise InstallerError(f"PE 签名不正确: {exe}")

    machine, nsec = struct.unpack_from("<HH", data, e_lfanew + 4)
    size_opt = struct.unpack_from("<H", data, e_lfanew + 20)[0]
    opt = e_lfanew + 24
    magic = struct.unpack_from("<H", data, opt)[0]
    dd_off = opt + (96 if magic == 0x10B else 112)
    sections_off = opt + size_opt

    def rva_to_offset(rva: int) -> int | None:
        for index in range(nsec):
            base = sections_off + index * 40
            _name, vsize, vaddr, rsize, raddr = struct.unpack_from(
                "<8sIIII", data, base
            )
            span = max(vsize, rsize)
            if vaddr <= rva < vaddr + span:
                return raddr + (rva - vaddr)
        return None

    resource_rva, resource_size = struct.unpack_from("<II", data, dd_off + 2 * 8)
    if not resource_rva or not resource_size:
        return {"has_resources": False, "icon_types": {}, "icon_sha256": None,
                "icon_total_bytes": 0}

    base_off = rva_to_offset(resource_rva)
    if base_off is None:
        return {"has_resources": False, "icon_types": {}, "icon_sha256": None,
                "icon_total_bytes": 0}

    def read_dir(off: int) -> list[tuple]:
        """读一个 IMAGE_RESOURCE_DIRECTORY：返回 [(name_field, target)]。"""

        named, ids = struct.unpack_from("<HH", data, base_off + off + 12)
        entries = []
        for index in range(named + ids):
            entry_off = base_off + off + 16 + index * 8
            name_field, target = struct.unpack_from("<II", data, entry_off)
            entries.append((name_field, target))
        return entries

    def read_data_entry(target: int) -> dict | None:
        """target 指向 IMAGE_RESOURCE_DATA_ENTRY（叶子），取出资源字节。"""

        entry_off = base_off + (target & 0x7FFFFFFF)
        data_rva, data_size, _codepage, _reserved = struct.unpack_from(
            "<IIII", data, entry_off
        )
        blob_off = rva_to_offset(data_rva)
        if blob_off is None:
            return None
        blob = data[blob_off:blob_off + data_size]
        return {"bytes": data_size, "sha256": sha256_bytes(blob)}

    def collect_leaves(target: int) -> list[dict]:
        """递归收集一个资源类型下的全部叶子（类型 → ID → 语言 → 数据）。"""

        if not (target & 0x80000000):
            item = read_data_entry(target)
            return [item] if item else []
        found: list[dict] = []
        for _name_field, child in read_dir(target & 0x7FFFFFFF):
            if child & 0x80000000:
                # 还有一层（语言维度），继续下钻。
                found.extend(collect_leaves(child))
            else:
                item = read_data_entry(child)
                if item:
                    found.append(item)
        return found

    icon_types: dict[int, list[dict]] = {}
    for name_field, target in read_dir(0):
        type_id = name_field & 0x7FFFFFFF
        if type_id not in (3, 14):  # RT_ICON / RT_GROUP_ICON
            continue
        icon_types[type_id] = collect_leaves(target)

    icons = icon_types.get(3, [])
    groups = icon_types.get(14, [])
    digest = sha256_bytes(
        b"".join(bytes.fromhex(item["sha256"]) for item in icons)
        + b"".join(bytes.fromhex(item["sha256"]) for item in groups)
    )
    return {
        "has_resources": True,
        "icon_types": {
            "RT_ICON": len(icons),
            "RT_GROUP_ICON": len(groups),
            "icons": icons,
        },
        "icon_sha256": digest,
        "icon_total_bytes": sum(item["bytes"] for item in icons),
    }


def apply_exe_icon(
    exe_path: str | Path,
    icon_path: str | Path = ICON_ICO,
    *,
    rcedit: Path | None = None,
    timeout: int = 180,
) -> dict:
    """用 rcedit 给 *exe_path* 写入 1CT 图标（**只改副本**）。

    缺 rcedit / 缺 ico / 执行失败都返回 ``{"applied": False, "reason": ...}``，
    由调用方决定是否降级（绝不因为图标失败而毁掉整个构建）。
    """

    exe_path = Path(exe_path)
    icon_path = Path(icon_path)
    if not exe_path.is_file():
        return {"applied": False, "reason": f"exe 不存在: {exe_path}"}
    if not icon_path.is_file():
        return {"applied": False, "reason": f"图标不存在: {icon_path}"}

    before_hash = sha256_file(exe_path)
    try:
        before_icon = pe_icon_report(exe_path)
    except InstallerError as exc:
        # 不是合法 PE（例如测试夹具用的假 exe）：不阻断构建，明确降级。
        return {
            "applied": False,
            "reason": f"exe 不是合法 PE，跳过图标: {exc}",
            "exe_sha256_before": before_hash,
        }
    tool = rcedit or find_rcedit()
    if tool is None:
        return {
            "applied": False,
            "reason": f"找不到 rcedit.exe（可放到 {RCEDIT_CANDIDATES[0]}，"
                      f"来源 {RCEDIT_DOWNLOAD_HINT}）",
            "before": before_icon,
        }

    try:
        completed = subprocess.run(
            [str(tool), str(exe_path), "--set-icon", str(icon_path)],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=timeout,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return {
            "applied": False,
            "reason": f"rcedit 执行失败: {exc}",
            "tool": str(tool),
            "before": before_icon,
        }

    output = (completed.stdout or b"").decode("utf-8", "replace").strip()
    try:
        after_icon = pe_icon_report(exe_path)
    except InstallerError as exc:
        return {
            "applied": False,
            "reason": f"rcedit 后 exe 不是合法 PE: {exc}",
            "tool": str(tool),
            "exit_code": completed.returncode,
            "output": output,
            "before": before_icon,
        }
    after_hash = sha256_file(exe_path)
    ok = (
        completed.returncode == 0
        and before_icon.get("icon_sha256") != after_icon.get("icon_sha256")
    )
    return {
        "applied": ok,
        "tool": str(tool),
        "exit_code": completed.returncode,
        "output": output,
        "icon": str(icon_path),
        "exe_sha256_before": before_hash,
        "exe_sha256_after": after_hash,
        "exe_bytes_before": before_icon.get("icon_total_bytes"),
        "icon_before": before_icon,
        "icon_after": after_icon,
        "reason": None if ok else (
            "rcedit 返回非 0" if completed.returncode != 0
            else "替换后图标指纹未变化"
        ),
    }


# ---------------------------------------------------------------------------
# 校验
# ---------------------------------------------------------------------------


def pe_subsystem(path: str | Path) -> int:
    """读取 PE optional header 的 Subsystem（2 = WINDOWS_GUI，双击无控制台）。"""

    import struct

    data = Path(path).read_bytes()
    if len(data) < 0x40 or data[:2] != b"MZ":
        raise InstallerError(f"不是 PE 文件: {path}")
    e_lfanew = struct.unpack_from("<I", data, 0x3C)[0]
    if data[e_lfanew:e_lfanew + 4] != b"PE\0\0":
        raise InstallerError(f"PE 签名不正确: {path}")
    optional_header = e_lfanew + 24
    magic = struct.unpack_from("<H", data, optional_header)[0]
    if magic not in (0x10B, 0x20B):
        raise InstallerError(f"未知 optional header magic: 0x{magic:X}")
    return struct.unpack_from("<H", data, optional_header + 68)[0]


def verify_patched_asar(
    patched_archive: str | Path,
    original_archive: str | Path,
    desktop_dir: str | Path | None = None,
    *,
    product_name: str | None = None,
    expected_inputs: dict[str, bytes] | None = None,
) -> dict:
    """校验 1CT 的 ASAR：条目齐全、未改文件一致、integrity 正确、注入清单正确。

    *expected_inputs* 用于校验“写入 ASAR 的字节确实就是构建时注入的字节”（构建后立即
    自检）；不传时从 *desktop_dir* 重新读取磁盘（``verify`` 子命令的严格口径）。
    """

    patched_archive = Path(patched_archive)
    original_archive = Path(original_archive)
    inputs = (
        dict(expected_inputs)
        if expected_inputs is not None
        else load_patch_inputs(desktop_dir or DESKTOP_DIR)
    )

    original_header, original_base = read_header(original_archive)
    patched_header, patched_base = read_header(patched_archive)
    original_files = dict(iter_files(original_header))
    patched_files = dict(iter_files(patched_header))

    missing = sorted(set(original_files) - set(patched_files))
    if missing:
        raise InstallerError(f"重建后丢失原文件: {', '.join(missing[:5])}")

    unchanged = 0
    for path, node in original_files.items():
        if path in REPLACED_PATHS:
            continue
        if read_file(original_archive, node, original_base) != read_file(
            patched_archive, patched_files[path], patched_base
        ):
            raise InstallerError(f"重建后未改动文件内容不一致: {path}")
        unchanged += 1

    # 1) 每个文件的 integrity（hash + blocks）必须与真实内容一致。
    for path, node in patched_files.items():
        data = read_file(patched_archive, node, patched_base)
        integrity = node.get("integrity")
        if not isinstance(integrity, dict):
            raise InstallerError(f"缺少 integrity: {path}")
        block_size = int(integrity.get("blockSize", BLOCK_SIZE))
        expected = integrity_for(data, block_size)
        if (
            integrity.get("algorithm") != "SHA256"
            or len(integrity.get("blocks") or []) != len(expected["blocks"])
            or integrity.get("hash") != expected["hash"]
            or list(integrity.get("blocks") or []) != expected["blocks"]
        ):
            raise InstallerError(f"integrity 与内容不匹配: {path}")

    # 2) 补丁文件必须与 desktop 侧源逐字节一致（index.html 单独规范化，另校验）。
    for path, expected_bytes in inputs.items():
        if path == ONECT_INDEX_ASAR_PATH:
            continue
        if read_file(patched_archive, patched_files[path], patched_base) != expected_bytes:
            raise InstallerError(f"补丁文件与补丁源不一致: {path}")

    # 3) 1CT index.html：标题 + 只加载 1CT 资源 + 1CT 自己的 favicon。
    index_html = read_file(patched_archive, patched_files[INDEX_HTML_PATH], patched_base)
    text = index_html.decode("utf-8")
    for needle in REQUIRED_INDEX_REFS:
        if needle not in text:
            raise InstallerError(f"1CT index.html 补丁缺失资源: {needle}")
    for needle in FORBIDDEN_INDEX_REFS:
        if needle in text:
            raise InstallerError(f"1CT index.html 不应包含: {needle}")
    for needle in REQUIRED_INDEX_ICON_REFS:
        if needle not in text:
            raise InstallerError(f"1CT index.html 缺少 favicon 链接: {needle}")
    if INDEX_TITLE_NEW not in text:
        raise InstallerError(f"1CT index.html 标题不是 {WINDOW_TITLE}")

    # 3b) 图标必须真的进包（favicon 指向它）。
    icon_in_asar = read_file(
        patched_archive, patched_files[ONECT_ICON_PNG_PATH], patched_base
    )
    if not icon_in_asar.startswith(b"\x89PNG\r\n\x1a\n"):
        raise InstallerError(f"asar 内 {ONECT_ICON_PNG_PATH} 不是合法 PNG")

    # 3b-2) 兜底照片必须真的进包（冷门活动图库无图时靠它提交）
    fallback_in_asar = read_file(
        patched_archive, patched_files[FALLBACK_PHOTO_ASAR_PATH], patched_base
    )
    if b"data:image/jpeg;base64," not in fallback_in_asar:
        raise InstallerError(f"asar 内 {FALLBACK_PHOTO_ASAR_PATH} 不是内联 JPEG data URL")
    if len(fallback_in_asar) < 1024:
        raise InstallerError(f"asar 内兜底照片过小（{len(fallback_in_asar)} 字节）")
    # 3c) main.js 三处 3CT UI 文案必须已换成 1CT，且**只**改了这三处。
    original_main = read_file(
        original_archive, original_files[MAIN_JS_PATH], original_base
    )
    patched_main = read_file(
        patched_archive, patched_files[MAIN_JS_PATH], patched_base
    )
    expected_main, _applied = patch_main_js(original_main)
    if patched_main != expected_main:
        raise InstallerError(
            f"{MAIN_JS_PATH} 与预期的“仅替换三处文案”结果不一致"
            "（可能有额外改动，拒绝通过）"
        )
    patched_main_text = patched_main.decode("utf-8")
    for label, old, new in MAIN_JS_TEXT_REPLACEMENTS:
        if new not in patched_main_text:
            raise InstallerError(f"{MAIN_JS_PATH} 文案替换未生效（{label}）: {new!r}")
        if old in patched_main_text:
            raise InstallerError(f"{MAIN_JS_PATH} 文案替换残留旧串（{label}）: {old!r}")
    for needle in PROTECTED_MAIN_JS_STRINGS:
        if needle not in patched_main_text:
            raise InstallerError(
                f"{MAIN_JS_PATH} 功能性字符串被误伤: {needle!r}"
            )
    # 除三处文案外必须与原文逐字节一致（长度差为 0：3CT→1CT 等长）。
    if len(patched_main) != len(original_main):
        raise InstallerError(
            f"{MAIN_JS_PATH} 补丁后长度变化（{len(original_main)} → {len(patched_main)}），"
            "说明除了三处文案还有别的改动"
        )

    # 3d) preload.js：必须在唯一锚点后追加 getStuAllActApplyList，其余字节不变。
    if PRELOAD_JS_PATH not in original_files:
        raise InstallerError(f"原 ASAR 缺少 {PRELOAD_JS_PATH}，无法校验 preload 桥")
    original_preload = read_file(
        original_archive, original_files[PRELOAD_JS_PATH], original_base
    )
    patched_preload = read_file(
        patched_archive, patched_files[PRELOAD_JS_PATH], patched_base
    )
    expected_preload = patch_preload_js(original_preload)
    if patched_preload != expected_preload:
        raise InstallerError(
            f"{PRELOAD_JS_PATH} 与预期的 preload 补丁结果不一致"
            "（可能有额外改动，拒绝通过）"
        )
    if PRELOAD_JS_ADDITION not in patched_preload:
        raise InstallerError(
            f"{PRELOAD_JS_PATH} 缺少二课桥方法 {PRELOAD_JS_METHOD_NAME}"
        )
    if patched_preload.count(PRELOAD_JS_ADDITION) != 1:
        raise InstallerError(
            f"{PRELOAD_JS_PATH} 二课桥方法出现次数异常"
            f"（期望 1 次，实际 {patched_preload.count(PRELOAD_JS_ADDITION)} 次）"
        )
    if PRELOAD_JS_ANCHOR not in patched_preload:
        raise InstallerError(f"{PRELOAD_JS_PATH} 原锚点丢失（getFinishList 被破坏）")
    preload_length_delta = len(patched_preload) - len(original_preload)
    expected_preload_delta = (
        len(PRELOAD_JS_ADDITION) if expected_preload != original_preload else 0
    )
    if preload_length_delta != expected_preload_delta:
        raise InstallerError(
            f"{PRELOAD_JS_PATH} 补丁后长度变化异常（{len(original_preload)} → "
            f"{len(patched_preload)}，期望 +{expected_preload_delta}）"
        )

    # 4) package.json main 必须指向 bootstrap，name 保持不变（userData 一致）。
    package = json.loads(
        read_file(patched_archive, patched_files[PACKAGE_JSON_PATH], patched_base).decode(
            "utf-8"
        )
    )
    if package.get("main") != EXPECTED_MAIN:
        raise InstallerError(f"package.json main 未指向 bootstrap: {package.get('main')}")
    original_package = json.loads(
        read_file(original_archive, original_files[PACKAGE_JSON_PATH], original_base).decode(
            "utf-8"
        )
    )
    if package.get("name") != original_package.get("name"):
        raise InstallerError(
            f"package.json name 被改动（会分叉 userData）: {package.get('name')}"
        )
    if product_name:
        if package.get("productName") != product_name:
            raise InstallerError(f"package.json productName 未设置: {package.get('productName')}")
    elif "productName" in package and package["productName"] != original_package.get("productName"):
        raise InstallerError("package.json 意外设置了 productName（会分叉 userData）")

    return {
        "entries": len(patched_files),
        "unchanged_verified": unchanged,
        "integrity_verified": len(patched_files),
        "patched_files": sorted(set(inputs) | REPLACED_PATHS),
        "onect_files": sorted(
            path for path in patched_files if path.startswith(ONECT_ASAR_DIR + "/")
        ),
        "index_refs": list(REQUIRED_INDEX_REFS),
        "index_icon_refs": list(REQUIRED_INDEX_ICON_REFS),
        "index_title": WINDOW_TITLE,
        "main": package.get("main"),
        "package_name": package.get("name"),
        "icon_in_asar": ONECT_ICON_PNG_PATH,
        "icon_bytes": len(icon_in_asar),
        "main_js_text": [
            {"label": label, "applied": True}
            for label, _old, _new in MAIN_JS_TEXT_REPLACEMENTS
        ],
        "main_js_bytes": len(patched_main),
        "main_js_length_delta": len(patched_main) - len(original_main),
        "preload_js": {
            "path": PRELOAD_JS_PATH,
            "bytes": len(patched_preload),
            "original_bytes": len(original_preload),
            "length_delta": preload_length_delta,
            "added_method": PRELOAD_JS_METHOD_NAME,
            "anchor": PRELOAD_JS_ANCHOR.decode("utf-8"),
        },
    }


def verify_runtime_assets(src_assets: Path, dest_assets: Path) -> dict:
    """校验副本 ``resources/assets/`` 的图标确实换成了 1CT（且与 3CT 不同）。

    断言：
    1. 三个主图标（icon.ico / favicon.ico / icon.png）在副本里存在，
       与 ``3CT`` 同名文件 sha **不同**，且与 ``desktop/1ct/assets/`` 源**一致**；
    2. ``icons/`` 下**每一个**原版文件，副本里都存在、sha 与 3CT 不同、与源一致；
    3. 原版 ``3CT/resources/assets/`` 一个字节都没被改（读两次哈希比对）。
    """

    src_assets = Path(src_assets)
    dest_assets = Path(dest_assets)
    if not dest_assets.is_dir():
        raise InstallerError(f"成品缺少 resources/assets 目录: {dest_assets}")

    results: list[dict] = []

    def compare(name: str, rel: str, expected: Path) -> dict:
        src_path = src_assets / rel
        dest_path = dest_assets / rel
        if not dest_path.is_file():
            raise InstallerError(f"成品缺少运行期图标: {rel}")
        if not expected.is_file():
            raise InstallerError(f"缺少 1CT 图标源: {expected}")
        src_hash = sha256_file(src_path) if src_path.is_file() else None
        dest_hash = sha256_file(dest_path)
        expected_hash = sha256_file(expected)
        if dest_hash != expected_hash:
            raise InstallerError(
                f"运行期图标与 1CT 源不一致: {rel}"
                f"（副本 {dest_hash[:16]}… vs 源 {expected_hash[:16]}…）"
            )
        if src_hash is None:
            raise InstallerError(f"原版缺少对应图标，无法确认已替换: {rel}")
        if dest_hash == src_hash:
            raise InstallerError(f"运行期图标仍是 3CT 原版: {rel}（请检查图标替换步骤）")
        return {
            "file": rel,
            "dest_sha256": dest_hash,
            "source_3ct_sha256": src_hash,
            "icon_source_sha256": expected_hash,
            "differs_from_3ct": True,
        }

    # 1) 三个主图标
    for rel, source_name in RUNTIME_ASSET_FILES:
        filename = rel.split("/", 1)[1]
        results.append(compare(filename, filename, ICON_DIR / source_name))

    # 2) icons/ 全部
    src_icons = src_assets / "icons"
    if not src_icons.is_dir():
        raise InstallerError(f"原版缺少 resources/assets/icons 目录: {src_icons}")
    icon_rows: list[dict] = []
    for src_file in sorted(src_icons.iterdir(), key=lambda p: p.name):
        if not src_file.is_file():
            continue
        rel = "icons/" + src_file.name
        row = compare(src_file.name, rel, ICON_ICONS_DIR / src_file.name)
        icon_rows.append(row)
    if not icon_rows:
        raise InstallerError(f"原版 icons 目录为空: {src_icons}")

    # 3) 原版 assets 必须一个字节没变（再算一次哈希，确认没被写过）。
    for rel, _source_name in RUNTIME_ASSET_FILES:
        filename = rel.split("/", 1)[1]
        src_path = src_assets / filename
        if src_path.is_file():
            if sha256_file(src_path) != results[
                [r["file"] for r in results].index(filename)
            ]["source_3ct_sha256"]:
                raise InstallerError(f"原版 resources/assets/{filename} 被意外修改")

    return {
        "files": results,
        "icons": icon_rows,
        "icons_count": len(icon_rows),
    }


def verify_packaged_tree(
    dest_dir: str | Path = DEST_DIR,
    source_dir: str | Path = SOURCE_DIR,
    desktop_dir: str | Path = DESKTOP_DIR,
    *,
    require_launcher: bool = False,
    expected_inputs: dict[str, bytes] | None = None,
    exe_icon_applied: bool | None = None,
) -> dict:
    """校验成品 1CT/：asar 补丁 + 主程序改名 + 图标 + 原始程序未被改动 + 启动器。"""

    dest_dir = Path(dest_dir).resolve()
    source_dir = Path(source_dir).resolve()
    desktop_dir = Path(desktop_dir).resolve()
    source_asar = source_dir / "resources" / "app.asar"
    if not (dest_dir / EXE_DEST_NAME).is_file():
        raise InstallerError(f"成品缺少 {EXE_DEST_NAME}: {dest_dir}")
    if not (dest_dir / "resources" / "app.asar").is_file():
        raise InstallerError(f"成品缺少 resources/app.asar: {dest_dir}")
    if (dest_dir / EXE_SOURCE_NAME).exists():
        raise InstallerError(f"成品不应保留 {EXE_SOURCE_NAME}（会与原版进程混淆）: {dest_dir}")

    asar_result = verify_patched_asar(
        dest_dir / "resources" / "app.asar",
        source_asar,
        desktop_dir,
        expected_inputs=expected_inputs,
    )

    # 运行期图标：副本 resources/assets/ 下每个图标都必须与 3CT 原名文件**不同**，
    # 且与 1CT 资产逐字节一致（托盘/任务栏/通知图标是否真的换掉了）。
    runtime_assets = verify_runtime_assets(
        source_dir / "resources" / "assets", dest_dir / "resources" / "assets"
    )

    source_exe_path = source_dir / EXE_SOURCE_NAME
    dest_exe_path = dest_dir / EXE_DEST_NAME
    source_exe_hash = sha256_file(source_exe_path)
    dest_exe_hash = sha256_file(dest_exe_path)

    # 图标：1CT.exe 的图标必须与 3CT.exe 不同（用户要求「别用 3CT 的」）。
    # 假 exe（测试夹具）解析不了 PE，此时退化为“exe 与源字节一致即视为未打图标”。
    try:
        source_icon = pe_icon_report(source_exe_path)
        dest_icon = pe_icon_report(dest_exe_path)
        icons_parsable = True
    except InstallerError:
        source_icon = {"icon_sha256": None}
        dest_icon = {"icon_sha256": None}
        icons_parsable = False
    icon_differs = (
        source_icon.get("icon_sha256") != dest_icon.get("icon_sha256")
        if icons_parsable
        else False
    )
    if exe_icon_applied is None:
        # 独立 verify 时：只要图标不同就算 OK；相同则要求 exe 与源字节一致（未打图标）。
        if icons_parsable and not icon_differs and dest_exe_hash == source_exe_hash:
            raise InstallerError(
                f"{EXE_DEST_NAME} 仍使用 3CT 的原始图标（exe 与源字节一致）；"
                f"请确认 {ICON_ICO} 存在且 rcedit 可用后再重建"
            )
    elif exe_icon_applied and not icon_differs:
        raise InstallerError(f"{EXE_DEST_NAME} 图标未变化（rcedit 未生效）")
    elif not exe_icon_applied and dest_exe_hash != source_exe_hash:
        raise InstallerError(
            f"未打图标时 {EXE_DEST_NAME} 应与源 {EXE_SOURCE_NAME} 字节一致"
        )

    marker_path = dest_dir / MARKER_NAME
    marker = None
    if marker_path.is_file():
        try:
            marker = json.loads(marker_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise InstallerError(f"安装标记损坏: {marker_path}: {exc}") from exc
        if marker.get("generator") != "desktop/install_1ct.py":
            raise InstallerError(f"安装标记不属于本工具: {marker_path}")

    # 启动器只允许存在**一个**：仓库根 `启动1CT.exe`。
    # 副本内不允许再放同名入口（用户要求「只留一个」）；`1CT.exe` 必须保留
    # （Electron 本体，删了就起不来）。
    duplicate_launcher = dest_dir / LAUNCHER_NAME
    if duplicate_launcher.exists():
        raise InstallerError(
            f"副本内不应再有 {LAUNCHER_NAME}（用户要求只留一个入口）: {duplicate_launcher}"
            "；请重建或手动删除"
        )
    if not (dest_dir / EXE_DEST_NAME).is_file():
        raise InstallerError(f"副本必须保留 Electron 本体 {EXE_DEST_NAME}: {dest_dir}")

    launcher_path = REPO_ROOT / LAUNCHER_NAME
    launcher = None
    if launcher_path.is_file():
        subsystem = pe_subsystem(launcher_path)
        if subsystem != 2:
            raise InstallerError(
                f"{LAUNCHER_NAME} 不是 GUI 子系统（Subsystem={subsystem}，应为 2）"
            )
        try:
            launcher_icon = pe_icon_report(launcher_path).get("icon_sha256")
        except InstallerError:
            launcher_icon = None
        launcher = {
            "path": str(launcher_path),
            "bytes": launcher_path.stat().st_size,
            "pe_subsystem": subsystem,
            "icon_sha256": launcher_icon,
            "in_repo_root": True,
        }
        # 启动器不能沿用 3CT 的图标（仅在双方图标都可解析时强制）。
        if (
            icons_parsable
            and launcher_icon is not None
            and launcher_icon == source_icon.get("icon_sha256")
        ):
            raise InstallerError(f"{LAUNCHER_NAME} 仍在用 3CT 的原始图标")
    elif require_launcher:
        raise InstallerError(
            f"仓库根缺少 GUI 启动器 {LAUNCHER_NAME}；"
            "请运行 python desktop/build_gui_launcher.py --brand 1ct"
        )

    if not (dest_dir / README_NAME).is_file():
        raise InstallerError(f"成品缺少 {README_NAME}")
    if not (dest_dir / START_NOTE_NAME).is_file():
        raise InstallerError(f"成品缺少 {START_NOTE_NAME}")
    if not (dest_dir / VERSION_NAME).is_file():
        raise InstallerError(f"成品缺少 {VERSION_NAME}")
    if not (dest_dir / START_SCRIPT_NAME).is_file():
        raise InstallerError(f"成品缺少兜底启动脚本 {START_SCRIPT_NAME}")

    return {
        "dest": str(dest_dir),
        "asar": asar_result,
        "runtime_assets": runtime_assets,
        "exe": {
            "name": EXE_DEST_NAME,
            "sha256": dest_exe_hash,
            "source_sha256": source_exe_hash,
            "differs_from_source": dest_exe_hash != source_exe_hash,
            "icon_sha256": dest_icon.get("icon_sha256"),
            "source_icon_sha256": source_icon.get("icon_sha256"),
            "icon_differs_from_source": icon_differs,
            "icon_count": len(
                (dest_icon.get("icon_types") or {}).get("icons") or []
            ),
        },
        "user_data": {
            "mode": "independent",
            "dir": str(ONECT_USER_DATA_DIR),
        },
        "launcher": launcher,
        "marker": marker,
        "original_asar_sha256": sha256_file(source_asar),
    }


# ---------------------------------------------------------------------------
# 构建
# ---------------------------------------------------------------------------


def build(
    source_dir: str | Path = SOURCE_DIR,
    dest_dir: str | Path = DEST_DIR,
    desktop_dir: str | Path = DESKTOP_DIR,
    *,
    force: bool = False,
    verify: bool = True,
    launcher: bool = True,
    product_name: str | None = None,
    csc: Path | None = None,
) -> dict:
    """生成 1CT 独立副本；原目录只读不写。"""

    source_dir = Path(source_dir).resolve()
    dest_dir = Path(dest_dir).resolve()
    desktop_dir = Path(desktop_dir).resolve()

    if not (source_dir / EXE_SOURCE_NAME).is_file():
        raise InstallerError(f"源目录不完整（缺少 {EXE_SOURCE_NAME}）: {source_dir}")
    source_asar = source_dir / "resources" / "app.asar"
    if not source_asar.is_file():
        raise InstallerError(f"源目录缺少 resources/app.asar: {source_dir}")
    if _is_within(dest_dir, source_dir) or _is_within(source_dir, dest_dir):
        raise InstallerError("目标目录不能与源目录互相包含")

    # 先完成所有可能失败的构建步骤，最后才清理旧输出，避免缺输入时毁掉可运行副本。
    # 补丁素材只加载一次（快照），构建后自检也用同一份，避免与并行写文件竞争。
    original_hash = sha256_file(source_asar)
    _ensure_vendor(source_asar, desktop_dir)
    inputs = load_patch_inputs(desktop_dir)
    patched_asar = build_patched_asar(
        source_asar, desktop_dir, product_name=product_name, inputs=inputs
    )

    if dest_dir.exists():
        if not force:
            raise InstallerError(f"目标目录已存在: {dest_dir}（如需重建请加 --force）")
        check_removable(dest_dir, source_asar, source_dir)
        _rmtree_confirmed(dest_dir)

    copy_summary = copy_app_tree(source_dir, dest_dir)
    write_atomic(dest_dir / "resources" / "app.asar", patched_asar)
    write_start_script(dest_dir)

    # 运行期图标：副本 resources/assets/ 全部换成 1CT（托盘/任务栏/通知否则仍是 3CT）。
    runtime_assets = replace_runtime_assets(
        source_dir / "resources" / "assets", dest_dir / "resources" / "assets"
    )

    after_hash = sha256_file(source_asar)
    if after_hash != original_hash:
        raise InstallerError("原程序 ASAR 被意外修改，已中止（原文件必须完全保留）")

    summary = {
        "brand": "1CT",
        "source": str(source_dir),
        "dest": str(dest_dir),
        "original_asar_sha256": original_hash,
        "patched_asar_sha256": sha256_bytes(patched_asar),
        "patched_asar_size": len(patched_asar),
        "copied_files": copy_summary["copied"],
        "skipped": copy_summary["skipped"],
        "injected": sorted(set(PATCH_SOURCES) | REPLACED_PATHS),
        "runtime_assets": {
            "files": [row for row in runtime_assets["files"] if "file" in row],
            "icons_count": len(runtime_assets["icons"]),
            "icons": runtime_assets["icons"],
        },
        "main_js_text": [
            {"label": label, "count": 1}
            for label, _old, _new in MAIN_JS_TEXT_REPLACEMENTS
        ],
        "user_data": {
            "mode": "independent",
            "dir": str(ONECT_USER_DATA_DIR),
            "shared_flag": "--shared-user-data / CT_SHARE_USER_DATA=1",
        },
    }
    write_readme(dest_dir)

    # exe 图标：只改副本的 1CT.exe，绝不碰 3CT\3CT.exe。
    # 必须在 write_marker 之前完成，否则 marker 里记的是打图标**前**的 exe 哈希。
    exe_icon = apply_exe_icon(dest_dir / EXE_DEST_NAME, ICON_ICO)
    summary["exe_icon"] = "applied" if exe_icon["applied"] else "skipped"
    summary["exe_icon_detail"] = exe_icon
    if not exe_icon["applied"]:
        summary["exe_icon_reason"] = exe_icon.get("reason")

    launcher_summary = None
    launcher_warning = None
    if launcher:
        try:
            # 只产出仓库根入口；副本内不再放第二份 启动1CT.exe（用户要求只留一个）。
            launcher_summary = build_launcher(
                dest_dir=dest_dir,
                root_exe=REPO_ROOT / LAUNCHER_NAME,
                icon=ICON_ICO if ICON_ICO.is_file() else None,
                csc=csc,
                also_copy_to_dest=False,
            )
        except InstallerError as exc:
            launcher_warning = str(exc)
    # 无论本次是否编译启动器，都清掉副本内可能残留的重复入口。
    summary["duplicate_launcher"] = remove_duplicate_launcher(dest_dir)
    summary["launcher"] = launcher_summary
    if launcher_warning:
        summary["launcher_warning"] = launcher_warning

    # marker 最后写：此时 exe 图标已打好，记录的是最终哈希。
    write_marker(dest_dir, summary)
    # 版本信息（分发/升级时用来区分副本）
    write_version_file(dest_dir, summary)

    if verify:
        summary["verify"] = verify_packaged_tree(
            dest_dir,
            source_dir,
            desktop_dir,
            require_launcher=False,
            expected_inputs=inputs,
            exe_icon_applied=bool(exe_icon["applied"]),
        )
        # 提示：如果 desktop/1ct/* 在构建期间被其它 teammate 更新，成品不会自动跟随。
        summary["input_drift"] = _input_drift(inputs)
    return summary


def _input_drift(inputs: dict[str, bytes], desktop_dir: Path = DESKTOP_DIR) -> list[str]:
    """返回构建后磁盘上已与注入快照不一致的补丁素材（并行开发时的提示）。"""

    desktop_dir = Path(desktop_dir).resolve()
    drifted: list[str] = []
    sources = patch_source_map(desktop_dir)
    for archive_path, injected in inputs.items():
        path = sources.get(archive_path)
        if path is None:
            continue
        try:
            current = path.read_bytes()
        except OSError:
            drifted.append(archive_path + " (missing)")
            continue
        if current != injected:
            drifted.append(_display_path(path, desktop_dir))
    return sorted(drifted)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="生成独立可启动的 1CT 副本")
    parser.add_argument("--source", default=str(SOURCE_DIR), help="原始 3CT 目录（只读）")
    parser.add_argument("--dest", default=str(DEST_DIR), help="输出副本目录")
    parser.add_argument("--desktop-dir", default=str(DESKTOP_DIR), help="desktop 补丁素材目录")
    parser.add_argument("--archive", default=str(DEFAULT_ASAR), help="原 app.asar 路径")
    sub = parser.add_subparsers(dest="command", required=True)
    build_parser = sub.add_parser("build", help="生成 1CT 副本并构建启动器")
    build_parser.add_argument("--force", action="store_true", help="目标已存在时覆盖重建")
    build_parser.add_argument("--no-verify", action="store_true", help="跳过重建后校验")
    build_parser.add_argument("--no-launcher", action="store_true", help="不编译 启动1CT.exe")
    build_parser.add_argument(
        "--product-name",
        default=None,
        help="显式设置 package.json productName（不推荐：会把 userData 分叉到 %%APPDATA%%\\<name>）",
    )
    sub.add_parser("extract-vendor", help="从原包 sourcemap 提取 jsQR 到 desktop/vendor")
    verify_parser = sub.add_parser("verify", help="校验已生成的 1CT 副本")
    verify_parser.add_argument(
        "--require-launcher", action="store_true", help="缺少 启动1CT.exe 时报错"
    )
    args = parser.parse_args(argv)

    try:
        if args.command == "build":
            summary = build(
                args.source,
                args.dest,
                args.desktop_dir,
                force=args.force,
                verify=not args.no_verify,
                launcher=not args.no_launcher,
                product_name=args.product_name,
            )
            print(json.dumps(summary, indent=2, ensure_ascii=False))
            print(
                "完成：1CT 独立副本已生成。请先退出原版 3CT / 3CT-Auto，"
                f"再双击 {LAUNCHER_NAME}（或 {EXE_DEST_NAME}）。"
            )
            return 0
        if args.command == "extract-vendor":
            result = extract_jsqr(args.archive)
            print(json.dumps(result, indent=2, ensure_ascii=False))
            return 0
        if args.command == "verify":
            result = verify_packaged_tree(
                Path(args.dest),
                Path(args.source),
                Path(args.desktop_dir),
                require_launcher=args.require_launcher,
            )
            print(json.dumps(result, indent=2, ensure_ascii=False))
            print("校验通过。")
            return 0
    except InstallerError as exc:
        print(f"错误: {exc}", file=sys.stderr)
        return 1
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
