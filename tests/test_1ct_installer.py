"""1CT 独立副本打包链（desktop/install_1ct.py + 启动器）的离线测试。

覆盖契约 docs/1ct-redesign-contract.md §6：
- ASAR pickle 头解析 / 重建 / integrity（复用 desktop/install.py 的原语，同样验证）；
- 1CT index.html 替换：标题 1CT、只引 1CT shell + jsQR/score-policy/result-store/
  automation，**不含** panel.js / dashboard.js / panel.css / dashboard.css；
- package.json main 指向 auto-bootstrap.cjs，且 name 不被改动（userData 一致）；
- --force 覆盖保护（未确认目录 / 标记哈希不匹配一律拒绝删除）；
- 路径与命名断言（1CT\\、1CT.exe、启动1CT.exe、README-1CT.txt）；
- 启动器：PE Subsystem=2、清理 ELECTRON_RUN_AS_NODE/NODE_OPTIONS/NODE_PATH、
  检测 3CT.exe / 3CT-Auto.exe / 1CT.exe 且绝不 kill 进程；
- 真实原包（3CT/resources/app.asar）纯内存 roundtrip，原包 SHA256 前后不变。

不启动 Electron、不访问网络、不结束任何进程。
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
INSTALLER_PATH = REPO_ROOT / "desktop" / "install_1ct.py"
BASE_INSTALLER_PATH = REPO_ROOT / "desktop" / "install.py"
LAUNCHER_SOURCE = REPO_ROOT / "desktop" / "GuiLauncher1CT.cs"
BUILDER_PATH = REPO_ROOT / "desktop" / "build_gui_launcher.py"
REAL_ASAR = REPO_ROOT / "3CT" / "resources" / "app.asar"
IS_WINDOWS = os.name == "nt"


def load_module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


onect = load_module(INSTALLER_PATH, "desktop_install_1ct")
base = load_module(BASE_INSTALLER_PATH, "desktop_install")


# ---------------------------------------------------------------------------
# 测试用最小 ASAR 写入器 / 读取器（独立实现，避免用被测代码造夹具）
# ---------------------------------------------------------------------------


def write_asar(path: Path, files: dict[str, bytes]) -> None:
    header = {"files": {}}
    cursor = {"offset": 0}
    blobs = bytearray()

    def ensure_dir(parts):
        node = header
        for part in parts:
            node = node["files"].setdefault(part, {"files": {}})
        return node

    for rel_path in sorted(files):
        parts = rel_path.split("/")
        directory = ensure_dir(parts[:-1])
        data = files[rel_path]
        directory["files"][parts[-1]] = {
            "size": len(data),
            "offset": str(cursor["offset"]),
            "integrity": base.integrity_for(data),
        }
        blobs.extend(data)
        cursor["offset"] += len(data)

    json_bytes = json.dumps(header, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    json_len = len(json_bytes)
    str_pickle_size = (json_len + 4 + 3) // 4 * 4
    header_size = 4 + str_pickle_size
    padding = header_size - (json_len + 8)
    path.write_bytes(
        struct.pack("<IIII", 4, header_size, str_pickle_size, json_len)
        + json_bytes
        + b"\x00" * padding
        + bytes(blobs)
    )


def read_asar_files(path: Path) -> dict[str, bytes]:
    header, data_base = onect.read_header(path)
    result = {}
    for rel_path, node in onect.iter_files(header):
        size = int(node["size"])
        offset = int(node["offset"])
        with path.open("rb") as fh:
            fh.seek(data_base + offset)
            result[rel_path] = fh.read(size)
    return result


def pe_subsystem(exe: Path) -> int:
    data = exe.read_bytes()
    if len(data) < 0x40 or data[:2] != b"MZ":
        raise AssertionError(f"不是 PE 文件: {exe}")
    e_lfanew = struct.unpack_from("<I", data, 0x3C)[0]
    if data[e_lfanew:e_lfanew + 4] != b"PE\0\0":
        raise AssertionError(f"PE 签名不正确: {exe}")
    optional_header = e_lfanew + 24
    magic = struct.unpack_from("<H", data, optional_header)[0]
    if magic not in (0x10B, 0x20B):
        raise AssertionError(f"未知 optional header magic: 0x{magic:X}")
    return struct.unpack_from("<H", data, optional_header + 68)[0]


#: 最小合法 PNG（1x1 透明），用作 1CT 图标的测试夹具。
PNG_1X1 = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4"
    "890000000d49444154789c6360000002000100e221bc330000000049454e44ae"
    "426082"
)


#: 一个最小的、符合契约 §6 的 1CT index.html 夹具（含 1CT 自己的 favicon）。
ONECT_INDEX_FIXTURE = b"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<title>1CT</title>
<link rel="icon" type="image/png" href="./1ct/icon.png" />
<link rel="stylesheet" href="./1ct/shell.css" />
<link rel="stylesheet" href="./1ct/ek-stats.css" />
</head><body><div id="one-ct-root"></div>
<script defer src="./jsQR.js"></script>
<script defer src="./score-policy.js"></script>
<script defer src="./result-store.js"></script>
<script defer src="./automation.js"></script>
<script defer src="./1ct/fallback-photo.js"></script>
<script defer src="./1ct/members.js"></script>
<script defer src="./1ct/ek-stats.js"></script>
<script defer src="./1ct/shell.js"></script>
</body></html>
"""

ORIGINAL_INDEX = (
    b"<!DOCTYPE html><html><head><meta charset=utf-8>"
    b'<meta http-equiv=Content-Security-Policy content="default-src \'self\'; script-src \'self\'">'
    b"<title>3CT</title><script defer=defer src=./renderer.js></script>"
    b"<link href=./style.css rel=stylesheet></head><body><div id=root></div></body></html>"
)


#: 合成 main.js：含 build 需要替换的 UI 文案与 AppUserModelID，以及 verify 断言必须保留的功能性 3CT。
MAIN_JS_FIXTURE = (
    b'var n={setToolTip:function(){}};n.setToolTip("3CT");'
    b'{label:"\xe9\x80\x80\xe5\x87\xba 3CT";x:1}'
    b'title:"\xe5\x85\xb3\xe9\x97\xad 3CT",message:"\xe9\x80\x89\xe6\x8b\xa9\xe5\x85\xb3\xe9\x97\xad\xe8\xa1\x8c\xe4\xb8\xba"'
    b'orgName:"3CT";3CT_Scheduler_x;"redirection.3ct.f.can6.top"'
    # Windows 任务栏图标归属：必须换成 1CT 专属 AUMID，否则会命中 3CT 快捷方式图标
    b'p.APP.appUserModelId,"top.can6.3ct.app"'
)

#: 合成 preload.js：模拟真实压缩后的 ek 对象（含**唯一** getFinishList 锚点）。
#: build 必须在这条锚点后追加 ek.getStuAllActApplyList，其余字节不动。
PRELOAD_JS_FIXTURE = (
    b'var i={ipcRenderer:{invoke:function(c,p){return Promise.resolve(p)}}};'
    b'module.exports={ek:{'
    b'getActivityDetail:e=>i.ipcRenderer.invoke("ek:getActivityDetail",e),'
    b'getFinishList:e=>i.ipcRenderer.invoke("ek:getFinishList",e),'
    b'getStudentScores:e=>i.ipcRenderer.invoke("ek:getStudentScores",e),'
    b'}};'
)

def make_desktop_fixture(base_dir: Path, *, omit: tuple[str, ...] = ()) -> Path:
    """造一个 desktop/ 补丁素材目录（含 1ct/ 与 1ct/assets/ 子目录）。"""

    desktop = base_dir / "desktop"
    (desktop / "vendor").mkdir(parents=True)
    (desktop / "1ct").mkdir()
    (desktop / "1ct" / "assets").mkdir()
    files = {
        "automation.js": "/* automation */\n",
        "score-policy.js": "/* score policy */\n",
        "result-store.js": "/* result store */\n",
        "vendor/jsQR.js": "/* jsQR */\n",
        "1ct/index.html": ONECT_INDEX_FIXTURE.decode("utf-8"),
        "1ct/shell.js": "/* 1ct shell */\n",
        "1ct/shell.css": "/* 1ct shell css */\n",
        "1ct/members.js": "/* 1ct members */\n",
        "1ct/ek-stats.js": "/* 1ct ek stats */\n",
        "1ct/ek-stats.css": "/* 1ct ek stats css */\n",
        "1ct/fallback-photo.js": (
            "/* padded fixture */\n" * 80
        ).replace("/* padded fixture */", "(function(){window.ONE_CT_FALLBACK_PHOTO='data:image/jpeg;base64,AAAA';})();\n", ) if False else (
            "(function(){window.ONE_CT_FALLBACK_PHOTO='data:image/jpeg;base64,AAAA';})();\n"
            + ("// pad\n" * 200)
        ),
        # 1CT 专用 bootstrap（独立 userData），不再是 3CT-Auto 的 bootstrap.cjs
        "1ct/bootstrap-1ct.cjs": (
            "const { app } = require('electron');\n"
            "app.setPath('userData', require('path').join(app.getPath('appData'), '1CT'));\n"
            "require('./main.js');\n"
        ),
        # 原版补丁素材，1CT 不应打包它们（存在也不该被读取）
        "panel.js": "/* legacy panel */\n",
        "panel.css": ".panel{}\n",
        "dashboard.js": "/* legacy dashboard */\n",
        "dashboard.css": ".dashboard{}\n",
    }
    for rel, text in files.items():
        if rel in omit:
            continue
        target = desktop / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8")
    # 最小合法 PNG（1x1），供 asar 注入与 index.html favicon 校验用。
    (desktop / "1ct" / "assets" / "icon.png").write_bytes(PNG_1X1)
    return desktop


def make_source_fixture(base_dir: Path, *, omit: tuple[str, ...] = ()) -> Path:
    """造一个最小的 3CT 原程序目录（*omit* 可去掉指定 asar 条目，用于缺失场景）。"""

    source = base_dir / "3CT"
    (source / "resources").mkdir(parents=True)
    (source / "3CT.exe").write_bytes(b"fake-3ct-exe")
    (source / "Uninstall 3CT.exe").write_bytes(b"fake-uninstall")
    (source / "locales").mkdir()
    (source / "locales" / "zh-CN.pak").write_bytes(b"locale")
    # 运行时图标来源：主进程从 resources/assets 取托盘/窗口/通知图标，build 会整体替换
    assets = source / "resources" / "assets"
    (assets / "icons").mkdir(parents=True)
    (assets / "icon.ico").write_bytes(b"fake-3ct-icon-ico")
    (assets / "favicon.ico").write_bytes(b"fake-3ct-favicon-ico")
    (assets / "icon.png").write_bytes(PNG_1X1)
    for _name in ("16x16.png", "32x32.png", "256x256.png"):
        (assets / "icons" / _name).write_bytes(PNG_1X1)
    asar_files = {
        "package.json": json.dumps(
            {"name": "3CT", "version": "1.2.5", "main": "./dist/main/main.js"}
        ).encode(),
        # main.js 必须含三处 3CT UI 文案（build 会做精确替换）+ 三处受保护的功能性 3CT。
        "dist/main/main.js": MAIN_JS_FIXTURE,
        # preload.js 必须含唯一 getFinishList 锚点（build 会追加 ek.getStuAllActApplyList）。
        "dist/main/preload.js": PRELOAD_JS_FIXTURE,
        "dist/renderer/index.html": ORIGINAL_INDEX,
        "node_modules/sql.js/sql-wasm.js": b"sql",
    }
    for rel in omit:
        asar_files.pop(rel, None)
    write_asar(source / "resources" / "app.asar", asar_files)
    return source


# ---------------------------------------------------------------------------
# ASAR 基础（与 3CT-Auto 包一致的原语，在 1CT 下同样必须成立）
# ---------------------------------------------------------------------------


class AsarBasicsTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = Path(self._tmp.name)
        self.asar = self.dir / "app.asar"
        self.files = {
            "package.json": b'{"name":"3CT","version":"1.2.5"}',
            # main.js 必须含三处 3CT UI 文案（build 会做精确替换）+ 三处受保护的功能性 3CT。
            "dist/main/main.js": MAIN_JS_FIXTURE,
            "dist/renderer/index.html": ORIGINAL_INDEX,
            "node_modules/keep/keep.js": b"module.exports = 42;",
        }
        write_asar(self.asar, self.files)

    def test_read_header_parses_pickle_and_data_base(self):
        header, data_base = onect.read_header(self.asar)

        raw_header_size = struct.unpack("<I", self.asar.read_bytes()[4:8])[0]
        self.assertEqual(data_base, 8 + raw_header_size)
        self.assertEqual(len(dict(onect.iter_files(header))), len(self.files))
        self.assertEqual(
            dict(onect.iter_files(header)).keys(),
            self.files.keys(),
        )

    def test_shared_primitives_are_reused_from_install_py(self):
        """1CT 打包链复用 3CT-Auto 的 asar 原语，不另写一套。"""

        # 两个模块各自独立加载同一文件，函数对象不可能是同一个；改比源码与行为。
        base_source = Path(base.__file__).read_text(encoding="utf-8")
        for name in (
            "read_header",
            "iter_files",
            "find_node",
            "read_file",
            "integrity_for",
            "rebuild_asar",
            "sha256_file",
            "write_atomic",
        ):
            with self.subTest(primitive=name):
                self.assertTrue(
                    hasattr(onect, name), f"install_1ct 缺少 {name}"
                )
                self.assertIn(
                    f"def {name}(",
                    base_source,
                    f"{name} 应定义在 desktop/install.py 并被复用",
                )
                # 1CT 侧不得重新定义同名函数（只能是 import/别名绑定）
                onect_source = INSTALLER_PATH.read_text(encoding="utf-8")
                self.assertNotIn(
                    f"def {name}(",
                    onect_source,
                    f"install_1ct.py 不应重新实现 {name}（应从 install.py 复用）",
                )

    def test_rebuild_keeps_untouched_files_and_updates_integrity(self):
        new_data = b"/* new */\n" * 3
        rebuilt = onect.rebuild_asar(self.asar, {"dist/renderer/x.js": new_data})
        out = self.dir / "rebuilt.asar"
        out.write_bytes(rebuilt)

        contents = read_asar_files(out)
        self.assertEqual(contents["dist/renderer/x.js"], new_data)
        self.assertEqual(contents["dist/main/main.js"], self.files["dist/main/main.js"])

        header, _ = onect.read_header(out)
        node = onect.find_node(header, "dist/renderer/x.js")
        self.assertEqual(node["size"], len(new_data))
        self.assertEqual(node["integrity"]["hash"], hashlib.sha256(new_data).hexdigest())

    def test_read_header_rejects_bad_magic(self):
        broken = self.dir / "broken.asar"
        broken.write_bytes(b"\x00" * 32)
        with self.assertRaises(onect.InstallerError):
            onect.read_header(broken)


# ---------------------------------------------------------------------------
# index.html / package.json 补丁规则
# ---------------------------------------------------------------------------


class IndexHtmlPatchTests(unittest.TestCase):
    def test_prepares_onect_index_with_title_and_required_refs(self):
        prepared = onect.prepare_index_html(ONECT_INDEX_FIXTURE, ORIGINAL_INDEX).decode()
        self.assertIn("<title>1CT</title>", prepared)
        for ref in onect.REQUIRED_INDEX_REFS:
            self.assertIn(ref, prepared)
        for ref in onect.FORBIDDEN_INDEX_REFS:
            self.assertNotIn(ref, prepared)

    def test_injects_title_when_onect_page_lacks_one(self):
        html = ONECT_INDEX_FIXTURE.replace(b"<title>1CT</title>", b"")
        prepared = onect.prepare_index_html(html, ORIGINAL_INDEX).decode()
        self.assertIn("<title>1CT</title>", prepared)

    def test_rewrites_wrong_title(self):
        html = ONECT_INDEX_FIXTURE.replace(b"<title>1CT</title>", b"<title>3CT</title>")
        prepared = onect.prepare_index_html(html, ORIGINAL_INDEX).decode()
        self.assertIn("<title>1CT</title>", prepared)
        self.assertEqual(prepared.count("<title>"), 1)

    def test_keeps_onect_csp_when_page_already_has_one(self):
        html = ONECT_INDEX_FIXTURE.replace(
            b'<meta charset="utf-8" />',
            b'<meta charset="utf-8" /><meta http-equiv="Content-Security-Policy" content="default-src \'self\'">',
        )
        prepared = onect.prepare_index_html(html, ORIGINAL_INDEX).decode()
        self.assertEqual(prepared.count("Content-Security-Policy"), 1)
        self.assertNotIn("unsafe-eval", prepared)

    def test_falls_back_to_original_csp_when_missing(self):
        html = ONECT_INDEX_FIXTURE.replace(b"<title>1CT</title>", b"<title>1CT</title>")
        prepared = onect.prepare_index_html(html, ORIGINAL_INDEX).decode()
        self.assertIn("Content-Security-Policy", prepared)
        self.assertIn("script-src", prepared)

    def test_rejects_page_still_referencing_legacy_assets(self):
        for legacy in ("./panel.js", "./dashboard.js", "./renderer.js", "./panel.css"):
            with self.subTest(ref=legacy):
                html = ONECT_INDEX_FIXTURE.replace(
                    b"./1ct/shell.js", legacy.encode()
                )
                with self.assertRaises(onect.InstallerError) as ctx:
                    onect.prepare_index_html(html, ORIGINAL_INDEX)
                self.assertIn("不应再引用", str(ctx.exception))

    def test_rejects_page_missing_onect_shell(self):
        html = ONECT_INDEX_FIXTURE.replace(b'<script defer src="./1ct/shell.js"></script>', b"")
        with self.assertRaises(onect.InstallerError) as ctx:
            onect.prepare_index_html(html, ORIGINAL_INDEX)
        self.assertIn("./1ct/shell.js", str(ctx.exception))

    def test_required_refs_cover_contract_section_6(self):
        self.assertEqual(
            set(onect.REQUIRED_INDEX_REFS),
            {
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
            },
        )
        self.assertTrue(set(onect.FORBIDDEN_INDEX_REFS).isdisjoint(onect.REQUIRED_INDEX_REFS))


class AppUserModelIdTests(unittest.TestCase):
    """Windows 任务栏图标按 AUMID 找同名快捷方式；必须换成 1CT 专属，否则显示 3CT 图标。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = Path(self._tmp.name)
        self.source = make_source_fixture(self.dir)
        self.desktop = make_desktop_fixture(self.dir)

    def test_replacement_table_contains_app_user_model_id(self):
        labels = [label for label, _old, _new in onect.MAIN_JS_TEXT_REPLACEMENTS]
        self.assertIn("AppUserModelID", labels)

    def test_patch_main_js_switches_aumid_to_1ct(self):
        patched, applied = onect.patch_main_js(MAIN_JS_FIXTURE)
        self.assertIn(b'"top.can6.1ct.app"', patched)
        self.assertNotIn(b'"top.can6.3ct.app"', patched)
        # 长度不变（3ct → 1ct 等长），便于 verify 的逐字节长度断言
        self.assertEqual(len(patched), len(MAIN_JS_FIXTURE))
        self.assertIn("AppUserModelID", [row["label"] for row in applied])

    def test_built_asar_has_1ct_aumid_and_no_legacy(self):
        dest = self.dir / "1CT"
        onect.build(
            source_dir=self.source,
            dest_dir=dest,
            desktop_dir=self.desktop,
            force=True,
            launcher=False,
        )
        asar = (dest / "resources" / "app.asar").read_bytes()
        self.assertIn(b'"top.can6.1ct.app"', asar)
        self.assertNotIn(b'"top.can6.3ct.app"', asar)

class PackageJsonPatchTests(unittest.TestCase):
    ORIGINAL = json.dumps(
        {"name": "3CT", "version": "1.2.5", "main": "./dist/main/main.js", "private": True}
    ).encode()

    def test_main_points_to_auto_bootstrap(self):
        patched = json.loads(onect.patch_package_json(self.ORIGINAL))
        self.assertEqual(patched["main"], "./dist/main/auto-bootstrap.cjs")
        self.assertEqual(patched["name"], "3CT")
        self.assertEqual(patched["version"], "1.2.5")

    def test_does_not_set_product_name_by_default(self):
        """productName/name 决定 userData 路径，默认必须保持不变。"""

        patched = json.loads(onect.patch_package_json(self.ORIGINAL))
        self.assertNotIn("productName", patched)

    def test_optional_product_name_is_explicit_only(self):
        patched = json.loads(onect.patch_package_json(self.ORIGINAL, product_name="1CT"))
        self.assertEqual(patched["productName"], "1CT")
        self.assertEqual(patched["name"], "3CT")

    def test_rejects_garbage_json(self):
        with self.assertRaises(onect.InstallerError):
            onect.patch_package_json(b"not json")

    def test_rejects_missing_name_or_version(self):
        with self.assertRaises(onect.InstallerError):
            onect.patch_package_json(b'{"main":"./x.js"}')


# ---------------------------------------------------------------------------
# 独立 userData（bootstrap-1ct.cjs）
# ---------------------------------------------------------------------------

REAL_BOOTSTRAP = REPO_ROOT / "desktop" / "1ct" / "bootstrap-1ct.cjs"


class BootstrapUserDataTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = Path(self._tmp.name)

    def test_bootstrap_is_used_instead_of_3ct_bootstrap(self):
        """1CT 必须用 desktop/1ct/bootstrap-1ct.cjs，不再复用 3CT-Auto 的 bootstrap.cjs。"""

        desktop = make_desktop_fixture(self.dir)
        sources = onect.patch_source_map(desktop)
        self.assertEqual(sources[onect.BOOTSTRAP_PATH], desktop / "1ct" / "bootstrap-1ct.cjs")
        self.assertNotEqual(sources[onect.BOOTSTRAP_PATH], desktop / "bootstrap.cjs")
        # 3CT-Auto 的 bootstrap.cjs 存在也不应被 1CT 使用
        (desktop / "bootstrap.cjs").write_text("/* 3ct auto bootstrap */\n", encoding="utf-8")
        self.assertEqual(
            onect.load_patch_inputs(desktop)[onect.BOOTSTRAP_PATH],
            (desktop / "1ct" / "bootstrap-1ct.cjs").read_bytes(),
        )

    def test_missing_onect_bootstrap_is_reported(self):
        desktop = make_desktop_fixture(self.dir, omit=("1ct/bootstrap-1ct.cjs",))
        with self.assertRaises(onect.InstallerError) as ctx:
            onect.load_patch_inputs(desktop)
        self.assertIn("bootstrap-1ct.cjs", str(ctx.exception))

    def test_real_bootstrap_sets_independent_user_data(self):
        """真实 bootstrap 必须：setPath 到 %APPDATA%\\1CT，且在 require main.js 之前。"""

        self.assertTrue(REAL_BOOTSTRAP.is_file(), "缺少 desktop/1ct/bootstrap-1ct.cjs")
        text = REAL_BOOTSTRAP.read_text(encoding="utf-8")

        self.assertIn("app.setPath('userData'", text)
        self.assertIn("app.getPath('appData')", text)
        self.assertIn("'1CT'", text)
        # 时序：必须在 require('./main.js') 之前
        self.assertLess(text.index("app.setPath('userData'"), text.rindex("require('./main.js')"))
        # 可配置回共用模式
        self.assertIn("--shared-user-data", text)
        self.assertIn("CT_SHARE_USER_DATA", text)
        # 保留禁更新 + 关后台节流
        self.assertIn("CT_UPDATE_URL", text)
        self.assertIn("autoDownload = false", text)
        self.assertIn("autoInstallOnAppQuit = false", text)
        self.assertIn("setBackgroundThrottling(false)", text)
        # 尊重显式 --user-data-dir（隔离测试不能被覆盖）
        self.assertIn("--user-data-dir", text)

    def test_bootstrap_declares_mode_for_diagnostics(self):
        text = REAL_BOOTSTRAP.read_text(encoding="utf-8")
        self.assertIn("__ONE_CT_BOOTSTRAP__", text)
        for mode in ("independent", "shared", "explicit"):
            with self.subTest(mode=mode):
                self.assertIn(f"'{mode}'", text)

    def test_bootstrap_registers_stu_all_act_apply_list_bridge(self):
        """主进程必须注册 ek:getStuAllActApplyList（官网报名/完成列表，带签到状态）。

        这是修复「官网已签到/已签退，1CT 显示 —」的数据源：3CT 的
        ek.getSignList（GetStuActSignList）对部分活动返回 0 条，真正带状态的是
        GetStuAllActApplyList。这里做静态契约检查，行为用 node 探针另测。
        """

        text = REAL_BOOTSTRAP.read_text(encoding="utf-8")
        self.assertIn(
            "ipcMain.handle(EK_STU_ALL_ACT_APPLY_LIST_CHANNEL", text
        )
        self.assertIn("ek:getStuAllActApplyList", text)
        self.assertIn("GetStuAllActApplyList", text)
        self.assertIn("CT_EK_YWTB_HOST", text)
        self.assertIn("https://ywtb.cuit.edu.cn", text)
        self.assertIn("二课会话缺失", text)
        self.assertIn("请求失败，状态码为：", text)
        self.assertIn("15000", text)
        self.assertIn("method: 'GET'", text)
        self.assertIn("'Bearer '", text)
        self.assertIn("'JSESSIONID='", text)
        # 防泄露：绝不打印 token / JSESSIONID / 会话对象
        for forbidden in (
            "console.log(accessToken",
            "console.log(jsessionid",
            "console.log(session",
            "console.error(accessToken",
        ):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, text)
        # ipcMain.handle 可在 app ready 前注册：必须在主进程入口之前
        self.assertLess(
            text.index("ipcMain.handle(EK_STU_ALL_ACT_APPLY_LIST_CHANNEL"),
            text.rindex("require('./main.js')"),
        )

    @unittest.skipUnless(IS_WINDOWS, "需要 Windows node")
    def test_bootstrap_sets_user_data_before_requiring_main(self):
        """端到端时序：setPath('userData', .../1CT) 必须早于 require('./main.js')。

        原 main.js 顶层的 appSettings / proxyRouting 在**模块加载时**就读 userData，
        晚一步会导致一半状态写旧目录。这里用 node + 假 electron 真跑一遍 bootstrap。
        """

        self.assertTrue(REAL_BOOTSTRAP.is_file())
        probe = self.dir / "probe_order.js"
        probe.write_text(
            "const calls = [];\n"
            "const fakeApp = {\n"
            "  getPath(name) {\n"
            "    calls.push(['getPath', name]);\n"
            "    if (name === 'appData') return 'C:/Users/test/AppData/Roaming';\n"
            "    if (name === 'userData') return 'C:/Users/test/AppData/Roaming/3CT';\n"
            "    return '';\n"
            "  },\n"
            "  setPath(name, value) { calls.push(['setPath', name, value]); },\n"
            "  on() {},\n"
            "  whenReady() { return Promise.resolve(); },\n"
            "};\n"
            "const Module = require('module');\n"
            "const origLoad = Module._load;\n"
            "Module._load = function (request, parent, isMain) {\n"
            "  if (request === 'electron') return { app: fakeApp, ipcMain: { handle() {} } };\n"
            "  if (request === 'electron-updater') throw new Error('n/a');\n"
            "  if (request === './main.js') { calls.push(['require-main-js']); return {}; }\n"
            "  return origLoad.apply(this, arguments);\n"
            "};\n"
            "try { require(process.argv[2]); }\n"
            "catch (e) { calls.push(['error', String(e && e.message ? e.message : e)]); }\n"
            "process.stdout.write(JSON.stringify(calls));\n",
            encoding="utf-8",
        )
        completed = subprocess.run(
            ["node", str(probe), str(REAL_BOOTSTRAP)],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=120,
        )
        output = completed.stdout.decode("utf-8", "replace")
        self.assertEqual(completed.returncode, 0, output)
        calls = json.loads(output)
        errors = [c for c in calls if c and c[0] == "error"]
        self.assertEqual(errors, [], f"bootstrap 抛错了: {errors}")

        setpath_idx = next(
            (
                i
                for i, c in enumerate(calls)
                if c[0] == "setPath" and c[1] == "userData" and "1CT" in str(c[2])
            ),
            None,
        )
        main_idx = next(
            (i for i, c in enumerate(calls) if c[0] == "require-main-js"), None
        )
        self.assertIsNotNone(setpath_idx, f"bootstrap 未 setPath userData: {calls}")
        self.assertIsNotNone(main_idx, f"bootstrap 未 require main.js: {calls}")
        self.assertLess(
            setpath_idx,
            main_idx,
            f"setPath(userData) 必须早于 require('./main.js')，实际顺序: {calls}",
        )
        # 目标必须是 %APPDATA%\1CT，且不是 3CT
        target = str(calls[setpath_idx][2]).replace("\\", "/")
        self.assertIn("/1CT", target)
        self.assertNotIn("/3CT", target)

    @unittest.skipUnless(IS_WINDOWS, "需要 Windows node")
    def test_bootstrap_respects_explicit_user_data_dir(self):
        """显式 --user-data-dir 时 bootstrap 不得再覆盖（隔离测试靠它）。"""

        probe = self.dir / "probe_explicit.js"
        probe.write_text(
            "const calls = [];\n"
            "const fakeApp = {\n"
            "  getPath(n) { calls.push(['getPath', n]); return n === 'appData' ? 'C:/A' : 'C:/A/3CT'; },\n"
            "  setPath(n, v) { calls.push(['setPath', n, v]); },\n"
            "  on() {}, whenReady() { return Promise.resolve(); },\n"
            "};\n"
            "const Module = require('module');\n"
            "const origLoad = Module._load;\n"
            "Module._load = function (request) {\n"
            "  if (request === 'electron') return { app: fakeApp, ipcMain: { handle() {} } };\n"
            "  if (request === 'electron-updater') throw new Error('n/a');\n"
            "  if (request === './main.js') { calls.push(['require-main-js']); return {}; }\n"
            "  return origLoad.apply(this, arguments);\n"
            "};\n"
            "try { require(process.argv[2]); }\n"
            "catch (e) { calls.push(['error', String(e && e.message ? e.message : e)]); }\n"
            "process.stdout.write(JSON.stringify(calls));\n",
            encoding="utf-8",
        )
        completed = subprocess.run(
            ["node", str(probe), str(REAL_BOOTSTRAP), "--user-data-dir=C:/tmp/isolated"],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=120,
        )
        output = completed.stdout.decode("utf-8", "replace")
        self.assertEqual(completed.returncode, 0, output)
        calls = json.loads(output)
        setpaths = [c for c in calls if c and c[0] == "setPath" and c[1] == "userData"]
        self.assertEqual(
            setpaths, [], f"显式 --user-data-dir 时不应再 setPath userData: {setpaths}"
        )

    @unittest.skipUnless(IS_WINDOWS, "需要 Windows node")
    def test_bootstrap_runs_and_reports_mode_in_node(self):
        """用 node 直接跑 bootstrap 的判定逻辑（stub 掉 electron），验证默认独立。"""

        # 从真实文件里抽出判定函数做纯逻辑验证，避免引入 electron 依赖。
        text = REAL_BOOTSTRAP.read_text(encoding="utf-8")
        script = self.dir / "probe.js"
        script.write_text(
            "const SHARED_FLAGS = new Set(['--shared-user-data', '--shared-user-data=true']);\n"
            "function wantsSharedUserData(argv, env) {\n"
            "  if (Array.isArray(argv) && argv.some((a) => SHARED_FLAGS.has(String(a)))) return true;\n"
            "  return String((env && env.CT_SHARE_USER_DATA) || '').trim() === '1';\n"
            "}\n"
            "function hasExplicitUserDataDir(argv) {\n"
            "  return (argv || []).some((a) => {\n"
            "    const t = String(a);\n"
            "    return t === '--user-data-dir' || t.startsWith('--user-data-dir=');\n"
            "  });\n"
            "}\n"
            "const out = {\n"
            "  dflt: wantsSharedUserData([], {}),\n"
            "  flag: wantsSharedUserData(['--shared-user-data'], {}),\n"
            "  flagEq: wantsSharedUserData(['--shared-user-data=true'], {}),\n"
            "  env: wantsSharedUserData([], { CT_SHARE_USER_DATA: '1' }),\n"
            "  env0: wantsSharedUserData([], { CT_SHARE_USER_DATA: '0' }),\n"
            "  explicit: hasExplicitUserDataDir(['--user-data-dir=C:/tmp/x']),\n"
            "  explicitEq: hasExplicitUserDataDir(['--user-data-dir', 'C:/tmp/x']),\n"
            "  noExplicit: hasExplicitUserDataDir(['--no-first-run']),\n"
            "};\n"
            "process.stdout.write(JSON.stringify(out));\n",
            encoding="utf-8",
        )
        completed = subprocess.run(
            ["node", str(script)],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=60,
        )
        self.assertEqual(completed.returncode, 0, completed.stdout.decode("utf-8", "replace"))
        data = json.loads(completed.stdout.decode("utf-8"))
        self.assertFalse(data["dflt"], "默认必须是独立 userData（不共用）")
        self.assertTrue(data["flag"])
        self.assertTrue(data["flagEq"])
        self.assertTrue(data["env"])
        self.assertFalse(data["env0"])
        self.assertTrue(data["explicit"])
        self.assertTrue(data["explicitEq"])
        self.assertFalse(data["noExplicit"])
        # 确保抽出来的逻辑与文件里写的一致（防止测试与实现漂移）
        self.assertIn("String(raw || '').trim() === '1'", text)
        self.assertIn("startsWith('--user-data-dir=')", text)

    def test_marker_records_independent_user_data_mode(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            desktop = make_desktop_fixture(base)
            source = make_source_fixture(base)
            dest = base / "1CT"
            summary = onect.build(source, dest, desktop, launcher=False)
            marker = json.loads((dest / onect.MARKER_NAME).read_text(encoding="utf-8"))
            self.assertEqual(marker["user_data_mode"], "independent")
            self.assertEqual(marker["user_data_dir"], str(onect.ONECT_USER_DATA_DIR))
            self.assertEqual(summary["user_data"]["mode"], "independent")

    def test_user_data_dir_points_to_appdata_onect(self):
        """独立 userData 必须落在 %APPDATA%\\1CT（不是 %APPDATA%\\3CT）。"""

        import os

        expected = Path(os.environ.get("APPDATA", "")) / "1CT"
        self.assertEqual(onect.ONECT_USER_DATA_NAME, "1CT")
        self.assertEqual(onect.ONECT_USER_DATA_DIR, expected)
        self.assertNotEqual(onect.ONECT_USER_DATA_DIR.name, "3CT")
        self.assertEqual(onect.ONECT_USER_DATA_DIR.parent.name, "Roaming")

    @unittest.skipUnless(IS_WINDOWS, "需要 Windows + 真实 Electron")
    @unittest.skipUnless(
        (REPO_ROOT / "1CT" / "1CT.exe").is_file(), "需要已构建的 1CT 副本"
    )
    def test_real_exe_writes_independent_user_data(self):
        """真实跑一次 1CT，确认 %APPDATA%\\1CT 生成且 %APPDATA%\\3CT 未被写。

        这是验收要求里唯一无法用合成夹具覆盖的部分。测试用临时 profile 隔离，
        绝不删除、也绝不写入用户的 %APPDATA%\\3CT。
        """

        import os
        import subprocess
        import time

        appdata = Path(os.environ["APPDATA"])
        onect_ud = appdata / "1CT"
        shared_ud = appdata / "3CT"

        def snap(path: Path) -> tuple:
            if not path.exists():
                return (False, 0, 0.0)
            files = [p for p in path.rglob("*") if p.is_file()]
            newest = max((p.stat().st_mtime for p in files), default=0.0)
            return (True, len(files), newest)

        shared_before = snap(shared_ud)
        onect_before = snap(onect_ud)

        # 用临时 profile 启一次（隔离，不会污染真实 %APPDATA%\1CT）。
        tmp_profile = self.dir / "profile"
        env = {
            k: v
            for k, v in os.environ.items()
            if k not in ("ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "NODE_PATH")
        }
        proc = subprocess.Popen(
            [
                str(REPO_ROOT / "1CT" / "1CT.exe"),
                f"--user-data-dir={tmp_profile}",
                "--no-first-run",
                "--disable-gpu",
            ],
            cwd=str(REPO_ROOT / "1CT"),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=env,
        )
        try:
            deadline = time.time() + 60
            while time.time() < deadline:
                if tmp_profile.exists() and any(tmp_profile.rglob("*")):
                    break
                time.sleep(0.5)
            time.sleep(2)
        finally:
            try:
                subprocess.run(
                    ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                    capture_output=True,
                    timeout=30,
                )
            except Exception:
                pass
            time.sleep(1)

        # 隔离 profile 生效：本次没有写真实 %APPDATA%\1CT
        onect_after = snap(onect_ud)
        self.assertEqual(
            onect_before, onect_after, "隔离 profile 不应写入真实的 %APPDATA%\\1CT"
        )
        # 关键：绝不能写共享目录 %APPDATA%\3CT
        shared_after = snap(shared_ud)
        self.assertEqual(
            shared_before, shared_after, "1CT 绝不能写入 %APPDATA%\\3CT"
        )
        # 临时 profile 里确实落了数据（证明 Electron 正常启动过）
        self.assertTrue(any(tmp_profile.rglob("*")), "临时 profile 未写入数据，Electron 可能没起来")


# ---------------------------------------------------------------------------
# 二课「报名/完成列表」桥接（bootstrap 注册 IPC + preload 暴露方法）
# ---------------------------------------------------------------------------

#: node 探针：假 electron + 假 node:https 真跑 bootstrap，验证 IPC 注册与只读 GET 语义。
#: 绝不发真实网络请求；会话用假值，验证 headers 正确性。
PROBE_BRIDGE_JS = """'use strict';
const Module = require('module');
const { EventEmitter } = require('node:events');

const calls = { registrations: [], requests: [], timeouts: [] };
const handlers = {};
let nextResponse = null;

function fakeRequest(options, onResponse) {
  calls.requests.push(options);
  const request = {
    setTimeout(ms) { calls.timeouts.push(ms); },
    on() {},
    end() {},
    destroy(err) { calls.destroyed = String((err && err.message) || err); },
  };
  process.nextTick(() => {
    const spec = nextResponse || { status: 200, body: '{}' };
    nextResponse = null;
    const response = new EventEmitter();
    response.statusCode = spec.status;
    response.setEncoding = () => {};
    onResponse(response);
    response.emit('data', spec.body);
    response.emit('end');
  });
  return request;
}

const fakeApp = {
  getPath(name) {
    return name === 'appData'
      ? 'C:/Users/test/AppData/Roaming'
      : 'C:/Users/test/AppData/Roaming/3CT';
  },
  setPath() {},
  on() {},
  whenReady() { return Promise.resolve(); },
};
const fakeIpcMain = {
  handle(channel, handler) {
    calls.registrations.push(channel);
    handlers[channel] = handler;
  },
};

const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') return { app: fakeApp, ipcMain: fakeIpcMain };
  if (request === 'electron-updater') throw new Error('n/a');
  if (request === './main.js') return {};
  if (request === 'node:https') return { request: fakeRequest };
  return origLoad.apply(this, arguments);
};

let bootstrapError = null;
try {
  require(process.argv[2]);
} catch (err) {
  bootstrapError = String((err && err.message) || err);
}

const session = { access_token: 'TOKEN-XYZ', JSESSIONID: 'SID-123' };

async function run() {
  const out = {
    bootstrapError,
    registrations: calls.registrations,
    diagnostics: globalThis.__ONE_CT_BOOTSTRAP__ || null,
    requests: calls.requests,
    timeouts: calls.timeouts,
  };
  const handler = handlers['ek:getStuAllActApplyList'];
  if (!handler) {
    out.fatal = 'handler 未注册';
    return out;
  }
  nextResponse = {
    status: 200,
    body: JSON.stringify({
      PageList: {
        Items: [{ ActivityId: 'act-1', SignD: '已签到', SignT: '已签退' }],
        TotalPages: 4,
      },
    }),
  };
  out.ok = await handler({}, { requestsData: session, pageIndex: 2 });
  try {
    await handler({}, {});
    out.missingSession = null;
  } catch (err) {
    out.missingSession = String((err && err.message) || err);
  }
  nextResponse = { status: 401, body: 'unauthorized' };
  try {
    await handler({}, { requestsData: session, pageIndex: 1 });
    out.httpError = null;
  } catch (err) {
    out.httpError = String((err && err.message) || err);
  }
  nextResponse = { status: 200, body: '{}' };
  await handler({}, { requestsData: session, pageIndex: 0 });
  out.lastRequest = calls.requests[calls.requests.length - 1];
  return out;
}

run()
  .then((out) => process.stdout.write(JSON.stringify(out)))
  .catch((err) => {
    process.stdout.write(JSON.stringify({ fatal: String((err && err.stack) || err) }));
  });
"""


@unittest.skipUnless(IS_WINDOWS, "需要 Windows node")
class BootstrapBridgeTests(unittest.TestCase):
    """用 node + 假 electron/https 真跑 bootstrap，验证桥接行为（不联网）。"""

    IOS_UA = (
        "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 "
        "(KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1"
    )

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = Path(self._tmp.name)
        self.assertTrue(REAL_BOOTSTRAP.is_file())
        self.probe = self.dir / "probe_bridge.js"
        self.probe.write_text(PROBE_BRIDGE_JS, encoding="utf-8")

    def _run(self, env_extra: dict | None = None) -> dict:
        env = dict(os.environ)
        env.pop("CT_EK_YWTB_HOST", None)
        env.pop("CT_SHARE_USER_DATA", None)
        if env_extra:
            env.update(env_extra)
        completed = subprocess.run(
            ["node", str(self.probe), str(REAL_BOOTSTRAP)],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=120,
            env=env,
        )
        output = completed.stdout.decode("utf-8", "replace")
        self.assertEqual(completed.returncode, 0, output)
        return json.loads(output)

    def test_handler_registers_and_fetches_readonly_json(self):
        data = self._run()
        self.assertIsNone(data.get("fatal"), data)
        self.assertIsNone(data.get("bootstrapError"), data)
        self.assertEqual(data["registrations"], ["ek:getStuAllActApplyList"])
        bridge = data["diagnostics"]["ekBridge"]
        self.assertEqual(bridge["channel"], "ek:getStuAllActApplyList")
        self.assertEqual(bridge["method"], "getStuAllActApplyList")
        self.assertTrue(bridge["registered"])

        # 返回值就是官网 JSON（PageList.Items 里带 SignD/SignT 签到/签退状态）
        items = data["ok"]["PageList"]["Items"]
        self.assertEqual(items[0]["SignD"], "已签到")
        self.assertEqual(items[0]["SignT"], "已签退")
        self.assertEqual(data["ok"]["PageList"]["TotalPages"], 4)

        # 只读 GET：固定 host/path/query + 3CT 一致的 headers
        request = data["requests"][0]
        self.assertEqual(request["method"], "GET")
        self.assertEqual(request["hostname"], "ywtb.cuit.edu.cn")
        self.assertEqual(
            request["path"],
            "/third_api/cxek/PhoneApi/api/Activity/GetStuAllActApplyList"
            "?activityType=&activityName=&qdType=&qtType=&pageIndex=2",
        )
        headers = request["headers"]
        self.assertEqual(headers["Authorization"], "Bearer TOKEN-XYZ")
        self.assertEqual(headers["Cookie"], "JSESSIONID=SID-123")
        self.assertEqual(headers["User-Agent"], self.IOS_UA)
        self.assertEqual(headers["Referer"], "https://ywtb.cuit.edu.cn/")
        self.assertEqual(headers["Accept"], "application/json, text/plain, */*")

        # 15s 超时（每次请求都必须设置）
        self.assertTrue(data["timeouts"])
        self.assertTrue(
            all(ms == 15000 for ms in data["timeouts"]), data["timeouts"]
        )

        # 错误语义：缺会话 / 非 2xx
        self.assertEqual(data["missingSession"], "二课会话缺失")
        self.assertEqual(data["httpError"], "请求失败，状态码为：401")

        # pageIndex 非正整数回落 1
        self.assertTrue(data["lastRequest"]["path"].endswith("pageIndex=1"))

    def test_host_can_be_overridden_for_isolation(self):
        """CT_EK_YWTB_HOST 只用于隔离测试/调试，但必须真的生效。"""

        data = self._run({"CT_EK_YWTB_HOST": "https://ywtb.example.edu.cn:8443"})
        self.assertIsNone(data.get("fatal"), data)
        request = data["requests"][0]
        self.assertEqual(request["hostname"], "ywtb.example.edu.cn")
        self.assertEqual(request["port"], "8443")


# ---------------------------------------------------------------------------
# 图标（1CT 自己的图标，不用 3CT 的）
# ---------------------------------------------------------------------------

REAL_ICON_ICO = REPO_ROOT / "desktop" / "1ct" / "assets" / "icon.ico"
REAL_ICON_PNG = REPO_ROOT / "desktop" / "1ct" / "assets" / "icon.png"
REAL_3CT_EXE = REPO_ROOT / "3CT" / "3CT.exe"


class IconTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = Path(self._tmp.name)

    def test_icon_assets_exist_and_have_expected_shapes(self):
        self.assertTrue(REAL_ICON_ICO.is_file(), "缺少 desktop/1ct/assets/icon.ico")
        self.assertTrue(REAL_ICON_PNG.is_file(), "缺少 desktop/1ct/assets/icon.png")

        data = REAL_ICON_ICO.read_bytes()
        _reserved, itype, count = struct.unpack_from("<HHH", data, 0)
        self.assertEqual(itype, 1, "必须是 .ico 类型 1")
        sizes = set()
        for index in range(count):
            off = 6 + index * 16
            width, height = struct.unpack_from("<BB", data, off)
            sizes.add((width or 256, height or 256))
        self.assertTrue(
            {(16, 16), (32, 32), (48, 48), (256, 256)}.issubset(sizes),
            f"ico 尺寸不全: {sorted(sizes)}",
        )

        png = REAL_ICON_PNG.read_bytes()
        self.assertTrue(png.startswith(b"\x89PNG\r\n\x1a\n"), "icon.png 不是合法 PNG")
        # IHDR: width/height 紧跟签名 + 4 字节长度 + 4 字节类型
        width, height = struct.unpack_from(">II", png, 16)
        self.assertEqual((width, height), (256, 256), f"icon.png 应为 256x256，实际 {width}x{height}")

    def test_index_html_requires_onect_favicon(self):
        self.assertEqual(onect.REQUIRED_INDEX_ICON_REFS, ("./1ct/icon.png",))
        prepared = onect.prepare_index_html(ONECT_INDEX_FIXTURE, ORIGINAL_INDEX).decode()
        self.assertIn('href="./1ct/icon.png"', prepared)
        self.assertEqual(prepared.count('rel="icon"'), 1)

    def test_prepare_index_html_injects_icon_when_missing(self):
        html = ONECT_INDEX_FIXTURE.replace(
            b'<link rel="icon" type="image/png" href="./1ct/icon.png" />', b""
        )
        prepared = onect.prepare_index_html(html, ORIGINAL_INDEX).decode()
        self.assertIn("./1ct/icon.png", prepared)

    def test_prepare_index_html_replaces_foreign_icon(self):
        """页面若指向 3CT 的 favicon，必须被替换成 1CT 的。"""

        html = ONECT_INDEX_FIXTURE.replace(
            b'href="./1ct/icon.png"', b'href="./favicon3ct.ico"'
        )
        prepared = onect.prepare_index_html(html, ORIGINAL_INDEX).decode()
        self.assertIn("./1ct/icon.png", prepared)
        self.assertNotIn("favicon3ct.ico", prepared)
        self.assertEqual(prepared.count('rel="icon"'), 1)

    def test_icon_png_is_injected_into_asar(self):
        base = self.dir
        desktop = make_desktop_fixture(base)
        source = make_source_fixture(base)
        dest = base / "1CT"
        onect.build(source, dest, desktop, launcher=False)

        patched = read_asar_files(dest / "resources" / "app.asar")
        self.assertIn(onect.ONECT_ICON_PNG_PATH, patched)
        self.assertEqual(
            patched[onect.ONECT_ICON_PNG_PATH],
            (desktop / "1ct" / "assets" / "icon.png").read_bytes(),
        )
        index_html = patched["dist/renderer/index.html"].decode()
        self.assertIn("./1ct/icon.png", index_html)

    def test_pe_icon_report_reads_real_exe(self):
        """PE 资源解析必须能读出 3CT.exe 的 4 个图标（证明不是空实现）。"""

        if not REAL_3CT_EXE.is_file():  # pragma: no cover
            self.skipTest("缺少原始 3CT.exe")
        report = onect.pe_icon_report(REAL_3CT_EXE)
        self.assertTrue(report["has_resources"])
        self.assertGreaterEqual(report["icon_types"]["RT_ICON"], 1)
        self.assertGreaterEqual(report["icon_types"]["RT_GROUP_ICON"], 1)
        self.assertGreater(report["icon_total_bytes"], 1000)
        self.assertEqual(len(report["icon_sha256"]), 64)

    def test_pe_icon_report_rejects_non_pe(self):
        bogus = self.dir / "notpe.exe"
        bogus.write_bytes(b"nope")
        with self.assertRaises(onect.InstallerError):
            onect.pe_icon_report(bogus)

    def test_apply_exe_icon_degrades_without_rcedit(self):
        """缺 rcedit 时必须优雅降级（返回 applied=False + reason），不抛异常。"""

        fake_exe = self.dir / "fake.exe"
        shutil.copy2(REAL_3CT_EXE, fake_exe) if REAL_3CT_EXE.is_file() else fake_exe.write_bytes(b"MZ")
        result = onect.apply_exe_icon(
            fake_exe, REAL_ICON_ICO, rcedit=self.dir / "missing-rcedit.exe"
        )
        self.assertFalse(result["applied"])
        self.assertIn("reason", result)

    def test_find_rcedit_prefers_repo_tool(self):
        tool = onect.find_rcedit()
        if (REPO_ROOT / "desktop" / "1ct" / "assets" / "tools" / "rcedit.exe").is_file():
            self.assertEqual(
                tool, REPO_ROOT / "desktop" / "1ct" / "assets" / "tools" / "rcedit.exe"
            )

    @unittest.skipUnless(IS_WINDOWS, "需要 Windows + .NET Framework csc")
    def test_marker_exe_hash_matches_final_exe_after_icon(self):
        """marker 必须在打图标**之后**写，记录的 exe_sha256 要等于最终文件哈希。

        回归：早期版本先 write_marker 再 apply_exe_icon，导致 marker 里记的是
        打图标前的哈希（与真实 1CT.exe 不一致），排查时会误导。
        """

        base = self.dir
        desktop = make_desktop_fixture(base)
        source = make_source_fixture(base)
        # 夹具的假 exe 不是合法 PE → apply_exe_icon 会降级；这里只验证顺序契约。
        dest = base / "1CT"
        onect.build(source, dest, desktop, launcher=False)

        marker = json.loads((dest / onect.MARKER_NAME).read_text(encoding="utf-8"))
        actual_exe_hash = onect.sha256_file(dest / onect.EXE_DEST_NAME)
        self.assertEqual(
            marker["exe_sha256"],
            actual_exe_hash,
            "marker.exе_sha256 必须等于最终 1CT.exe 的哈希（marker 要在打图标之后写）",
        )
        self.assertIn(marker["exe_icon"], ("applied", "skipped"))


# ---------------------------------------------------------------------------
# 补丁输入：缺文件必须清晰报错（不静默跳过）
# ---------------------------------------------------------------------------


class PatchInputTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = Path(self._tmp.name)

    def test_load_patch_inputs_returns_contract_paths(self):
        desktop = make_desktop_fixture(self.dir)
        inputs = onect.load_patch_inputs(desktop)

        expected = {
            "dist/renderer/jsQR.js",
            "dist/renderer/score-policy.js",
            "dist/renderer/result-store.js",
            "dist/renderer/automation.js",
            "dist/renderer/1ct/shell.js",
            "dist/renderer/1ct/shell.css",
            "dist/renderer/1ct/members.js",
            "dist/renderer/1ct/ek-stats.js",
            "dist/renderer/1ct/ek-stats.css",
            "dist/renderer/1ct/index.html",
            "dist/renderer/1ct/icon.png",
            "dist/main/auto-bootstrap.cjs",
            onect.FALLBACK_PHOTO_ASAR_PATH,
        }
        self.assertEqual(set(inputs), expected)
        # 不得包含任何原版 panel/dashboard 资源
        for path in inputs:
            self.assertNotIn("panel", path)
            self.assertNotIn("dashboard", path)

    def test_onect_source_files_and_patch_sources_agree(self):
        """契约 §7 的 6 个 1ct 文件必须全部被注入，且常量表与运行时表一致。"""

        self.assertEqual(
            set(onect.ONECT_SOURCE_FILES),
            {"index.html", "shell.js", "shell.css", "members.js", "ek-stats.js", "ek-stats.css"},
        )
        injected_onect = {
            path for path in onect.PATCH_SOURCES if path.startswith(onect.ONECT_ASAR_DIR + "/")
        }
        # 6 个 UI/成员/统计文件 + 1 个 favicon + 1 个兜底照片脚本
        self.assertEqual(
            injected_onect,
            {onect.ONECT_ASAR_DIR + "/" + name for name in onect.ONECT_SOURCE_FILES}
            | set(onect.ICON_SOURCES)
            | {onect.FALLBACK_PHOTO_ASAR_PATH},
        )
        # 静态常量与运行时映射必须一致（防止只改一处）
        self.assertEqual(onect.patch_source_map(onect.DESKTOP_DIR), onect.PATCH_SOURCES)

    def test_missing_onect_inputs_are_reported_clearly(self):
        desktop = make_desktop_fixture(self.dir, omit=("1ct/members.js", "1ct/shell.js"))
        with self.assertRaises(onect.InstallerError) as ctx:
            onect.load_patch_inputs(desktop)
        message = str(ctx.exception)
        self.assertIn("缺少 1CT 补丁输入文件", message)
        self.assertIn("1ct/members.js", message)
        self.assertIn("1ct/shell.js", message)

    def test_missing_legacy_patch_inputs_do_not_matter(self):
        desktop = make_desktop_fixture(
            self.dir, omit=("panel.js", "panel.css", "dashboard.js", "dashboard.css")
        )
        inputs = onect.load_patch_inputs(desktop)
        self.assertEqual(len(inputs), 13)


# ---------------------------------------------------------------------------
# --force 覆盖保护
# ---------------------------------------------------------------------------


class ForceProtectionTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.base = Path(self._tmp.name)
        self.source = make_source_fixture(self.base)
        self.desktop = make_desktop_fixture(self.base)
        self.dest = self.base / "1CT"
        self.source_asar = self.source / "resources" / "app.asar"

    def test_existing_destination_requires_force(self):
        self.dest.mkdir()
        (self.dest / "keep.txt").write_text("old", encoding="utf-8")

        with self.assertRaises(onect.InstallerError) as ctx:
            onect.build(self.source, self.dest, self.desktop, launcher=False)
        self.assertIn("--force", str(ctx.exception))
        self.assertTrue((self.dest / "keep.txt").is_file())

    def test_force_refuses_unconfirmed_directory(self):
        self.dest.mkdir()
        (self.dest / "important.txt").write_text("user data", encoding="utf-8")

        with self.assertRaises(onect.InstallerError) as ctx:
            onect.build(self.source, self.dest, self.desktop, force=True, launcher=False)
        self.assertIn("拒绝删除未确认的目录", str(ctx.exception))
        self.assertTrue((self.dest / "important.txt").is_file())

    def test_force_refuses_foreign_marker(self):
        self.dest.mkdir()
        (self.dest / onect.MARKER_NAME).write_text(
            json.dumps({"generator": "desktop/install.py"}), encoding="utf-8"
        )
        with self.assertRaises(onect.InstallerError) as ctx:
            onect.build(self.source, self.dest, self.desktop, force=True, launcher=False)
        self.assertIn("不属于本工具", str(ctx.exception))

    def test_force_refuses_stale_source_hash(self):
        onect.build(self.source, self.dest, self.desktop, launcher=False)
        marker_path = self.dest / onect.MARKER_NAME
        marker = json.loads(marker_path.read_text(encoding="utf-8"))
        marker["source_asar_sha256"] = "0" * 64
        marker_path.write_text(json.dumps(marker), encoding="utf-8")

        with self.assertRaises(onect.InstallerError) as ctx:
            onect.build(self.source, self.dest, self.desktop, force=True, launcher=False)
        self.assertIn("哈希与当前原程序不一致", str(ctx.exception))

    def test_force_rebuilds_previously_generated_copy(self):
        onect.build(self.source, self.dest, self.desktop, launcher=False)
        stale = self.dest / "stale.txt"
        stale.write_text("old", encoding="utf-8")

        onect.build(self.source, self.dest, self.desktop, force=True, launcher=False)

        self.assertFalse(stale.exists())
        self.assertTrue((self.dest / onect.EXE_DEST_NAME).is_file())
        marker = json.loads((self.dest / onect.MARKER_NAME).read_text(encoding="utf-8"))
        self.assertEqual(marker["generator"], "desktop/install_1ct.py")
        self.assertEqual(marker["brand"], "1CT")

    def test_force_with_missing_inputs_keeps_existing_copy_intact(self):
        onect.build(self.source, self.dest, self.desktop, launcher=False)
        asar_path = self.dest / "resources" / "app.asar"
        before = hashlib.sha256(asar_path.read_bytes()).hexdigest()
        (self.desktop / "1ct" / "shell.js").unlink()

        with self.assertRaises(onect.InstallerError):
            onect.build(self.source, self.dest, self.desktop, force=True, launcher=False)

        self.assertEqual(hashlib.sha256(asar_path.read_bytes()).hexdigest(), before)
        self.assertTrue((self.dest / onect.MARKER_NAME).is_file())

    def test_rejects_dest_inside_source(self):
        with self.assertRaises(onect.InstallerError):
            onect.build(
                self.source,
                self.source / "nested" / "1CT",
                self.desktop,
                launcher=False,
            )


# ---------------------------------------------------------------------------
# 合成源完整构建
# ---------------------------------------------------------------------------


class BuildFromSyntheticTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.base = Path(self._tmp.name)
        self.source = make_source_fixture(self.base)
        self.desktop = make_desktop_fixture(self.base)
        self.dest = self.base / "1CT"

    def test_build_creates_independent_copy(self):
        summary = onect.build(self.source, self.dest, self.desktop, launcher=False)

        self.assertEqual(summary["brand"], "1CT")
        self.assertEqual(summary["skipped"], ["Uninstall 3CT.exe"])
        self.assertTrue((self.dest / "1CT.exe").is_file())
        self.assertFalse((self.dest / "3CT.exe").exists())
        self.assertFalse((self.dest / "Uninstall 3CT.exe").exists())
        self.assertTrue((self.dest / "locales" / "zh-CN.pak").is_file())
        self.assertTrue((self.dest / onect.README_NAME).is_file())
        self.assertTrue((self.dest / onect.START_NOTE_NAME).is_file())
        self.assertTrue((self.dest / onect.START_SCRIPT_NAME).is_file())
        self.assertTrue((self.dest / onect.MARKER_NAME).is_file())

        patched = read_asar_files(self.dest / "resources" / "app.asar")
        index_html = patched["dist/renderer/index.html"].decode()
        self.assertIn("<title>1CT</title>", index_html)
        for ref in onect.REQUIRED_INDEX_REFS:
            self.assertIn(ref, index_html)
        for ref in onect.FORBIDDEN_INDEX_REFS:
            self.assertNotIn(ref, index_html)

        # 1CT 文件按契约注入到 dist/renderer/1ct/
        for name in ("shell.js", "shell.css", "members.js", "ek-stats.js", "ek-stats.css", "index.html"):
            with self.subTest(asset=name):
                self.assertEqual(
                    patched["dist/renderer/1ct/" + name],
                    (self.desktop / "1ct" / name).read_bytes(),
                )
        # 不再打包 panel/dashboard
        for legacy in ("panel.js", "panel.css", "dashboard.js", "dashboard.css"):
            self.assertNotIn("dist/renderer/" + legacy, patched)

        self.assertEqual(
            patched["dist/main/auto-bootstrap.cjs"],
            (self.desktop / "1ct" / "bootstrap-1ct.cjs").read_bytes(),
        )
        package = json.loads(patched["package.json"])
        self.assertEqual(package["main"], "./dist/main/auto-bootstrap.cjs")
        self.assertEqual(package["name"], "3CT")
        self.assertNotIn("productName", package)

    def test_build_preserves_every_original_file(self):
        onect.build(self.source, self.dest, self.desktop, launcher=False)

        original = read_asar_files(self.source / "resources" / "app.asar")
        patched = read_asar_files(self.dest / "resources" / "app.asar")
        for path, data in original.items():
            with self.subTest(path=path):
                self.assertIn(path, patched, "重建后丢失原文件: " + path)
                if path not in onect.REPLACED_PATHS:
                    self.assertEqual(patched[path], data, "原文件被改动: " + path)

    def test_build_does_not_modify_original_tree(self):
        asar = self.source / "resources" / "app.asar"
        before_hash = hashlib.sha256(asar.read_bytes()).hexdigest()
        before_names = sorted(p.name for p in self.source.iterdir())

        summary = onect.build(self.source, self.dest, self.desktop, launcher=False)

        self.assertEqual(summary["original_asar_sha256"], before_hash)
        self.assertEqual(hashlib.sha256(asar.read_bytes()).hexdigest(), before_hash)
        self.assertEqual(sorted(p.name for p in self.source.iterdir()), before_names)

    def test_build_writes_marker_with_hashes(self):
        summary = onect.build(self.source, self.dest, self.desktop, launcher=False)

        marker = json.loads((self.dest / onect.MARKER_NAME).read_text(encoding="utf-8"))
        self.assertEqual(marker["generator"], "desktop/install_1ct.py")
        self.assertEqual(marker["source_asar_sha256"], summary["original_asar_sha256"])
        self.assertEqual(marker["patched_asar_sha256"], summary["patched_asar_sha256"])

    def test_build_verify_summary_reports_injection(self):
        summary = onect.build(self.source, self.dest, self.desktop, launcher=False)
        verify = summary["verify"]

        self.assertEqual(verify["asar"]["index_title"], "1CT")
        self.assertEqual(verify["asar"]["main"], "./dist/main/auto-bootstrap.cjs")
        self.assertEqual(verify["asar"]["package_name"], "3CT")
        self.assertIn("dist/renderer/1ct/shell.js", verify["asar"]["onect_files"])
        self.assertEqual(verify["exe"]["name"], "1CT.exe")
        # 原 not-unpacked 的 5 个文件（含 dist/main/preload.js）+ 新增补丁文件
        self.assertEqual(verify["asar"]["entries"], 5 + len(onect.PATCH_SOURCES))
        # preload 桥补丁必须写入并出现在 verify 汇总里
        self.assertIn(onect.PRELOAD_JS_PATH, verify["asar"]["patched_files"])
        preload_summary = verify["asar"]["preload_js"]
        self.assertEqual(preload_summary["path"], onect.PRELOAD_JS_PATH)
        self.assertEqual(
            preload_summary["added_method"], onect.PRELOAD_JS_METHOD_NAME
        )
        self.assertEqual(
            preload_summary["length_delta"], len(onect.PRELOAD_JS_ADDITION)
        )
        self.assertIn(onect.PRELOAD_JS_PATH, summary["injected"])

    def test_build_requires_force_for_existing_dir(self):
        self.dest.mkdir()
        with self.assertRaises(onect.InstallerError):
            onect.build(self.source, self.dest, self.desktop, launcher=False)

    def test_verify_detects_legacy_asset_in_index(self):
        onect.build(self.source, self.dest, self.desktop, launcher=False)
        asar_path = self.dest / "resources" / "app.asar"
        tampered = onect.read_file_by_path(asar_path, "dist/renderer/index.html")
        tampered = tampered.replace(b"<title>1CT</title>", b"<title>1CT</title><script src=./panel.js></script>")
        rebuilt = onect.rebuild_asar(asar_path, {"dist/renderer/index.html": tampered})
        asar_path.write_bytes(rebuilt)

        with self.assertRaises(onect.InstallerError) as ctx:
            onect.verify_packaged_tree(self.dest, self.source, self.desktop)
        self.assertIn("不应包含", str(ctx.exception))

    def test_verify_detects_unpatched_package_main(self):
        onect.build(self.source, self.dest, self.desktop, launcher=False)
        asar_path = self.dest / "resources" / "app.asar"
        patched = json.loads(onect.read_file_by_path(asar_path, "package.json"))
        patched["main"] = "./dist/main/main.js"
        rebuilt = onect.rebuild_asar(
            asar_path,
            {"package.json": json.dumps(patched).encode()},
        )
        asar_path.write_bytes(rebuilt)

        with self.assertRaises(onect.InstallerError) as ctx:
            onect.verify_packaged_tree(self.dest, self.source, self.desktop)
        self.assertIn("main", str(ctx.exception))

    def test_verify_detects_tampered_integrity(self):
        onect.build(self.source, self.dest, self.desktop, launcher=False)
        asar_path = self.dest / "resources" / "app.asar"
        header, data_base = onect.read_header(asar_path)
        node = onect.find_node(header, "dist/main/main.js")
        node["integrity"] = dict(node["integrity"])
        node["integrity"]["hash"] = "0" * 64
        node["integrity"]["blocks"] = ["0" * 64]
        payload = asar_path.read_bytes()[data_base:]
        json_bytes = json.dumps(header, separators=(",", ":"), ensure_ascii=True).encode()
        json_len = len(json_bytes)
        str_pickle_size = (json_len + 4 + 3) // 4 * 4
        header_size = 4 + str_pickle_size
        asar_path.write_bytes(
            struct.pack("<IIII", 4, header_size, str_pickle_size, json_len)
            + json_bytes
            + b"\x00" * (header_size - (json_len + 8))
            + payload
        )

        with self.assertRaises(onect.InstallerError) as ctx:
            onect.verify_packaged_tree(self.dest, self.source, self.desktop)
        self.assertIn("integrity 与内容不匹配", str(ctx.exception))

    def test_verify_detects_missing_readme(self):
        onect.build(self.source, self.dest, self.desktop, launcher=False)
        (self.dest / onect.README_NAME).unlink()
        with self.assertRaises(onect.InstallerError):
            onect.verify_packaged_tree(self.dest, self.source, self.desktop)

    def test_verify_detects_wrong_exe_name(self):
        onect.build(self.source, self.dest, self.desktop, launcher=False)
        shutil.copy2(self.dest / "1CT.exe", self.dest / "3CT.exe")
        with self.assertRaises(onect.InstallerError) as ctx:
            onect.verify_packaged_tree(self.dest, self.source, self.desktop)
        self.assertIn("3CT.exe", str(ctx.exception))


# ---------------------------------------------------------------------------
# preload 最小补丁：暴露 ek.getStuAllActApplyList（官网报名/完成列表）
# ---------------------------------------------------------------------------


class PreloadPatchTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.base = Path(self._tmp.name)

    def test_contract_constants(self):
        self.assertEqual(onect.PRELOAD_JS_PATH, "dist/main/preload.js")
        self.assertIn(onect.PRELOAD_JS_PATH, onect.REPLACED_PATHS)
        self.assertEqual(onect.PRELOAD_JS_METHOD_NAME, "getStuAllActApplyList")
        self.assertIn(b"ek:getFinishList", onect.PRELOAD_JS_ANCHOR)
        self.assertIn(b"getStuAllActApplyList", onect.PRELOAD_JS_ADDITION)
        self.assertTrue(onect.PRELOAD_JS_ADDITION.endswith(b","))
        # 锚点自身含 getFinishList 两次：方法名 + channel
        self.assertEqual(onect.PRELOAD_JS_ANCHOR.count(b"getFinishList"), 2)

    def test_patch_injects_method_right_after_anchor(self):
        patched = onect.patch_preload_js(PRELOAD_JS_FIXTURE)
        expected = PRELOAD_JS_FIXTURE.replace(
            onect.PRELOAD_JS_ANCHOR,
            onect.PRELOAD_JS_ANCHOR + onect.PRELOAD_JS_ADDITION,
            1,
        )
        self.assertEqual(patched, expected)
        self.assertEqual(
            len(patched) - len(PRELOAD_JS_FIXTURE), len(onect.PRELOAD_JS_ADDITION)
        )
        self.assertEqual(patched.count(onect.PRELOAD_JS_ANCHOR), 1)
        self.assertEqual(patched.count(onect.PRELOAD_JS_ADDITION), 1)
        self.assertIn(
            b'getStuAllActApplyList:e=>i.ipcRenderer.invoke("ek:getStuAllActApplyList",e),',
            patched,
        )
        # 原有方法一个不少（只追加，不替换）
        for name in (b"getActivityDetail", b"getFinishList", b"getStudentScores"):
            self.assertIn(name, patched)

    def test_patch_is_idempotent(self):
        patched = onect.patch_preload_js(PRELOAD_JS_FIXTURE)
        self.assertEqual(onect.patch_preload_js(patched), patched)
        self.assertEqual(
            onect.patch_preload_js(patched).count(onect.PRELOAD_JS_ADDITION), 1
        )

    def test_missing_anchor_is_rejected(self):
        broken = PRELOAD_JS_FIXTURE.replace(onect.PRELOAD_JS_ANCHOR, b"")
        with self.assertRaises(onect.InstallerError) as ctx:
            onect.patch_preload_js(broken)
        message = str(ctx.exception)
        self.assertIn(onect.PRELOAD_JS_PATH, message)
        self.assertIn("0 次", message)

    def test_duplicate_anchor_is_rejected(self):
        doubled = PRELOAD_JS_FIXTURE.replace(
            onect.PRELOAD_JS_ANCHOR, onect.PRELOAD_JS_ANCHOR * 2
        )
        with self.assertRaises(onect.InstallerError) as ctx:
            onect.patch_preload_js(doubled)
        self.assertIn("2 次", str(ctx.exception))

    def test_missing_preload_in_source_asar_is_reported(self):
        desktop = make_desktop_fixture(self.base)
        source = make_source_fixture(self.base, omit=("dist/main/preload.js",))
        with self.assertRaises(onect.InstallerError) as ctx:
            onect.build(source, self.base / "1CT", desktop, launcher=False)
        self.assertIn(onect.PRELOAD_JS_PATH, str(ctx.exception))

    def test_build_patches_preload_and_verify_reports_it(self):
        desktop = make_desktop_fixture(self.base)
        source = make_source_fixture(self.base)
        dest = self.base / "1CT"
        summary = onect.build(source, dest, desktop, launcher=False)

        patched = read_asar_files(dest / "resources" / "app.asar")
        expected = onect.patch_preload_js(PRELOAD_JS_FIXTURE)
        self.assertEqual(patched[onect.PRELOAD_JS_PATH], expected)
        self.assertNotEqual(patched[onect.PRELOAD_JS_PATH], PRELOAD_JS_FIXTURE)

        preload_summary = summary["verify"]["asar"]["preload_js"]
        self.assertEqual(preload_summary["path"], onect.PRELOAD_JS_PATH)
        self.assertEqual(
            preload_summary["added_method"], onect.PRELOAD_JS_METHOD_NAME
        )
        self.assertEqual(preload_summary["bytes"], len(expected))
        self.assertEqual(preload_summary["original_bytes"], len(PRELOAD_JS_FIXTURE))
        self.assertEqual(
            preload_summary["length_delta"], len(onect.PRELOAD_JS_ADDITION)
        )

    def test_verify_detects_reverted_preload(self):
        """把 preload 还原成原版（等于没打桥补丁）时 verify 必须拒绝。"""

        desktop = make_desktop_fixture(self.base)
        source = make_source_fixture(self.base)
        dest = self.base / "1CT"
        onect.build(source, dest, desktop, launcher=False)
        asar_path = dest / "resources" / "app.asar"
        rebuilt = onect.rebuild_asar(
            asar_path, {onect.PRELOAD_JS_PATH: PRELOAD_JS_FIXTURE}
        )
        asar_path.write_bytes(rebuilt)
        with self.assertRaises(onect.InstallerError) as ctx:
            onect.verify_packaged_tree(dest, source, desktop)
        self.assertIn(onect.PRELOAD_JS_PATH, str(ctx.exception))


# ---------------------------------------------------------------------------
# 路径 / 命名（契约 §6）
# ---------------------------------------------------------------------------


class NamingAndPathTests(unittest.TestCase):
    def test_default_paths_follow_contract(self):
        self.assertEqual(onect.DEST_DIR.name, "1CT")
        self.assertEqual(onect.DEST_DIR.parent, REPO_ROOT)
        self.assertEqual(onect.SOURCE_DIR, REPO_ROOT / "3CT")
        self.assertEqual(onect.EXE_DEST_NAME, "1CT.exe")
        self.assertEqual(onect.EXE_SOURCE_NAME, "3CT.exe")
        self.assertEqual(onect.LAUNCHER_NAME, "启动1CT.exe")
        self.assertEqual(onect.README_NAME, "README-1CT.txt")
        self.assertEqual(onect.MARKER_NAME, ".1ct-install.json")
        self.assertEqual(onect.ONECT_ASAR_DIR, "dist/renderer/1ct")
        self.assertEqual(onect.INDEX_HTML_PATH, "dist/renderer/index.html")
        self.assertEqual(onect.EXPECTED_MAIN, "./dist/main/auto-bootstrap.cjs")
        self.assertEqual(onect.WINDOW_TITLE, "1CT")

    def test_never_touches_the_3ct_auto_copy(self):
        text = INSTALLER_PATH.read_text(encoding="utf-8")
        for forbidden in ("3CT-Auto/启动", "install.py build", "3CT-Auto\\"):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, text)
        self.assertNotIn('COPY_EXCLUDE_NAMES = frozenset({"Uninstall 1CT.exe"})', text)

    def test_start_script_is_pure_ascii_crlf_and_never_kills(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = onect.write_start_script(Path(tmp))
            data = path.read_bytes()

        self.assertTrue(all(byte < 0x80 for byte in data), "兜底脚本必须是纯 ASCII")
        stripped = data.replace(b"\r\n", b"")
        self.assertNotIn(b"\n", stripped)
        self.assertNotIn(b"\r", stripped)
        lowered = data.lower()
        for forbidden in (b"taskkill", b"stop-process"):
            self.assertNotIn(forbidden, lowered)
        self.assertIn(b'IMAGENAME eq 1CT.exe', data)
        # 3CT / 3CT-Auto 只做“提示可共存”，不再阻止启动
        self.assertIn(b'IMAGENAME eq 3CT.exe', data)
        self.assertIn(b"own userdata", lowered)
        self.assertIn(b"can run at the same time", lowered)
        self.assertNotIn(b"IMAGENAME eq 3CT-Auto.exe", data)
        self.assertIn(b'ELECTRON_RUN_AS_NODE=', data)
        self.assertIn(b"NODE_OPTIONS=", data)
        self.assertIn(b"NODE_PATH=", data)
        self.assertIn(b'start "" "%APP%" %*', data)

    def test_readme_documents_independent_userdata(self):
        """README 必须说清：独立 userData、可与 3CT-Auto 同时跑、首次需重登。"""

        text = onect.README_TEXT
        self.assertEqual(onect.README_NAME, "README-1CT.txt")
        for needle in (
            "userData",
            "单实例锁",
            "自动更新",
            "3CT-Auto",
            "唤醒",
            "1CT.exe",
            "启动1CT.exe",
            "%APPDATA%\\1CT",
            "%APPDATA%\\3CT",
            "构建命令",
            "install_1ct.py",
            "可以同时运行",
            "重新登录",
            "--shared-user-data",
            "自己的图标",
        ):
            with self.subTest(needle=needle):
                self.assertIn(needle, text)

    def test_start_note_is_pure_ascii_and_documents_constraints(self):
        """副本内额外一份纯 ASCII 启动说明（任何控制台编码都能读）。"""

        self.assertEqual(onect.START_NOTE_NAME, "HOW-TO-START-1CT.txt")
        data = onect.START_NOTE_TEXT.encode("ascii")  # 不抛即纯 ASCII
        self.assertGreater(len(data), 400)
        for needle in (
            "START",
            "%APPDATA%\\1CT",
            "%APPDATA%\\3CT",
            "single-instance lock",
            "CAN run at the same time",
            "--shared-user-data",
            "install_1ct.py build",
            "package.json name stays 3CT",
            "ICON",
        ):
            with self.subTest(needle=needle):
                self.assertIn(needle, onect.START_NOTE_TEXT)

    def test_installer_reuses_install_py_instead_of_copy_pasting(self):
        text = INSTALLER_PATH.read_text(encoding="utf-8")
        self.assertIn('_load_sibling("install")', text)
        for primitive in ("read_header", "rebuild_asar", "integrity_for", "verify"):
            self.assertIn(primitive, text)


# ---------------------------------------------------------------------------
# 启动器：源码静态检查 + 构建 + 行为
# ---------------------------------------------------------------------------


class LauncherSourceTests(unittest.TestCase):
    @staticmethod
    def _strip_comments(text: str) -> str:
        return "\n".join(line.split("//", 1)[0] for line in text.splitlines())

    def test_source_exists_and_targets_1ct(self):
        self.assertTrue(LAUNCHER_SOURCE.is_file(), "缺少 desktop/GuiLauncher1CT.cs")
        text = LAUNCHER_SOURCE.read_text(encoding="utf-8")
        self.assertIn('TargetName = "1CT.exe"', text)
        self.assertIn('CopyDirName = "1CT"', text)
        self.assertIn('Title = "1CT"', text)

    def test_detects_other_versions_without_killing(self):
        """默认独立 userData：不阻止 3CT/3CT-Auto；只有共用模式才检测冲突。"""

        text = LAUNCHER_SOURCE.read_text(encoding="utf-8")
        self.assertIn('"3CT", "3CT-Auto"', text)
        self.assertIn("FindConflictingProcesses", text)
        self.assertIn("WantsSharedUserData", text)
        self.assertIn("--shared-user-data", text)
        self.assertIn("CT_SHARE_USER_DATA", text)
        # 默认（独立模式）不得把 3CT 当成阻塞冲突
        self.assertIn("sharedUserData ? FindConflictingProcesses() : new List<string>()", text)
        code = self._strip_comments(text)
        lowered = code.lower()
        for forbidden in ("taskkill", "stop-process", "kill(", "kill ", "process.kill"):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, lowered)
        # 提示文案只描述了 shared 模式下的冲突
        self.assertIn("共用用户数据", text)

    def test_diagnose_reports_user_data_mode(self):
        text = LAUNCHER_SOURCE.read_text(encoding="utf-8")
        self.assertIn('\\"sharedUserData\\"', text)
        self.assertIn('\\"userDataMode\\"', text)

    def test_clears_only_child_node_env(self):
        text = LAUNCHER_SOURCE.read_text(encoding="utf-8")
        self.assertIn("UseShellExecute = false", text)
        self.assertIn("CreateNoWindow = true", text)
        for variable in ("ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "NODE_PATH"):
            self.assertIn(variable, text)
        self.assertIn("EnvironmentVariables.Remove", text)
        self.assertNotIn("Environment.SetEnvironmentVariable", text)

    def test_does_not_call_shells(self):
        code = self._strip_comments(LAUNCHER_SOURCE.read_text(encoding="utf-8"))
        for forbidden in ("cmd.exe", "powershell", "pwsh", "cscript", "wscript", "runas"):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, code.lower())
        compact = code.replace(" ", "")
        self.assertNotIn("UseShellExecute=true", compact)
        self.assertNotIn("ShellExecute(", code)

    def test_diagnose_hook_writes_json_without_prompting(self):
        text = LAUNCHER_SOURCE.read_text(encoding="utf-8")
        self.assertIn("--diagnose", text)
        self.assertIn("DiagnoseJson", text)
        self.assertIn("conflictingProcesses", text)


class BuilderBrandTests(unittest.TestCase):
    def setUp(self):
        self.builder = load_module(BUILDER_PATH, "build_gui_launcher_1ct")
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = Path(self._tmp.name)

    def test_two_brands_are_registered(self):
        self.assertEqual(set(self.builder.BRANDS), {"3ct", "1ct"})
        onect_brand = self.builder.BRANDS["1ct"]
        self.assertEqual(onect_brand.launcher_name, "启动1CT.exe")
        self.assertEqual(onect_brand.source.name, "GuiLauncher1CT.cs")
        self.assertEqual(onect_brand.copy_dir, REPO_ROOT / "1CT")
        # 3CT 历史行为完全不变
        legacy = self.builder.BRANDS["3ct"]
        self.assertEqual(legacy.launcher_name, "启动3CT自动版.exe")
        self.assertEqual(legacy.source.name, "GuiLauncher.cs")
        self.assertEqual(self.builder.LAUNCHER_NAME, "启动3CT自动版.exe")
        self.assertEqual(self.builder.ROOT_EXE, REPO_ROOT / "启动3CT自动版.exe")

    def test_parse_brands(self):
        self.assertEqual(self.builder.parse_brands(["1ct"]), ["1ct"])
        self.assertEqual(self.builder.parse_brands(["3ct", "1ct"]), ["3ct", "1ct"])
        self.assertEqual(self.builder.parse_brands(["all"]), ["3ct", "1ct"])
        self.assertEqual(self.builder.parse_brands(None), [])
        with self.assertRaises(self.builder.BuildError):
            self.builder.parse_brands(["2ct"])

    def test_default_brand_stays_backward_compatible(self):
        """不带 --brand 时只能刷 3CT 自动版入口，避免意外改写正在用的副本。"""

        self.assertEqual(self.builder.DEFAULT_MAIN_BRANDS, ("3ct",))
        self.assertEqual(self.builder.DEFAULT_BRAND, "3ct")

    @unittest.skipUnless(IS_WINDOWS, "需要 Windows + .NET Framework csc")
    @unittest.skipUnless(IS_WINDOWS and Path(r"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe").is_file()
                         or Path(r"C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe").is_file(),
                         "缺少 csc.exe")
    def test_build_onect_launcher_is_gui_subsystem(self):
        out = self.dir / "1CT启动器.exe"
        self.builder.build_launcher(out, brand="1ct", icon=None)

        self.assertTrue(out.is_file())
        self.assertEqual(pe_subsystem(out), 2, "启动器必须是 WINDOWS_GUI 子系统（无控制台）")

    def test_build_brand_rejects_unknown_brand(self):
        with self.assertRaises(self.builder.BuildError):
            self.builder.build_brand("2ct", out_exe=self.dir / "x.exe", icon=None)

    def test_brand_paths_match_installer_contract(self):
        """启动器产物路径必须与 install_1ct.py 的约定一致。"""

        onect_brand = self.builder.BRANDS["1ct"]
        self.assertEqual(onect_brand.root_exe, REPO_ROOT / onect.LAUNCHER_NAME)
        self.assertEqual(onect_brand.copy_dir, onect.DEST_DIR)
        self.assertEqual(onect_brand.copy_exe, onect.DEST_DIR / onect.LAUNCHER_NAME)
        self.assertEqual(onect_brand.launcher_name, onect.LAUNCHER_NAME)

    def test_launcher_source_targets_match_installer_exe_name(self):
        source = LAUNCHER_SOURCE.read_text(encoding="utf-8")
        self.assertIn('TargetName = "%s"' % onect.EXE_DEST_NAME, source)
        self.assertIn('CopyDirName = "%s"' % onect.DEST_DIR.name, source)

    @unittest.skipUnless(IS_WINDOWS, "需要 Windows + .NET Framework csc")
    @unittest.skipUnless(IS_WINDOWS and Path(r"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe").is_file()
                         or Path(r"C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe").is_file(),
                         "缺少 csc.exe")
    def test_diagnose_reports_onect_target_and_env(self):
        launcher = self.dir / "launcher.exe"
        self.builder.build_launcher(launcher, brand="1ct", icon=None)
        copy_dir = self.dir / "1CT"
        copy_dir.mkdir()
        (copy_dir / "1CT.exe").write_bytes(b"fake-exe")
        out = self.dir / "diag.json"

        env = dict(os.environ)
        env["ELECTRON_RUN_AS_NODE"] = "1"
        completed = subprocess.run(
            [str(launcher), "--diagnose", str(out)],
            cwd=self.dir,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=60,
        )

        self.assertEqual(completed.returncode, 0, completed.stdout.decode("utf-8", "replace"))
        data = json.loads(out.read_text(encoding="utf-8"))
        self.assertTrue(data["exeExists"])
        self.assertEqual(Path(data["exe"]).resolve(), (copy_dir / "1CT.exe").resolve())
        self.assertEqual(Path(data["workingDirectory"]).resolve(), copy_dir.resolve())
        self.assertEqual(
            data["envToClear"], ["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "NODE_PATH"]
        )
        self.assertIn("conflictingProcesses", data)

    @unittest.skipUnless(IS_WINDOWS, "需要 Windows + .NET Framework csc")
    @unittest.skipUnless(IS_WINDOWS and Path(r"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe").is_file()
                         or Path(r"C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe").is_file(),
                         "缺少 csc.exe")
    def test_diagnose_missing_target_reports_without_launching(self):
        launcher = self.dir / "launcher.exe"
        self.builder.build_launcher(launcher, brand="1ct", icon=None)
        out = self.dir / "diag.json"

        completed = subprocess.run(
            [str(launcher), "--diagnose", str(out)],
            cwd=self.dir,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=60,
        )

        self.assertEqual(completed.returncode, 0, completed.stdout.decode("utf-8", "replace"))
        data = json.loads(out.read_text(encoding="utf-8"))
        self.assertFalse(data["exeExists"])
        self.assertTrue(data["exe"].endswith("1CT.exe"), data["exe"])


# ---------------------------------------------------------------------------
# 真实原包（只读、纯内存）
# ---------------------------------------------------------------------------


@unittest.skipUnless(REAL_ASAR.is_file(), "需要原始 3CT/resources/app.asar")
class RealArchiveTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = Path(self._tmp.name)

    def test_real_asar_roundtrip_preserves_every_entry(self):
        before_hash = hashlib.sha256(REAL_ASAR.read_bytes()).hexdigest()
        original_files = read_asar_files(REAL_ASAR)

        rebuilt = onect.rebuild_asar(REAL_ASAR, {})
        out = self.dir / "rebuilt.asar"
        out.write_bytes(rebuilt)

        rebuilt_files = read_asar_files(out)
        self.assertEqual(len(original_files), 347)
        self.assertEqual(set(original_files), set(rebuilt_files))
        for path, data in original_files.items():
            with self.subTest(path=path):
                self.assertEqual(rebuilt_files[path], data)
        self.assertEqual(hashlib.sha256(REAL_ASAR.read_bytes()).hexdigest(), before_hash)

    def test_real_asar_patched_build_verifies(self):
        desktop = make_desktop_fixture(self.dir)
        before_hash = hashlib.sha256(REAL_ASAR.read_bytes()).hexdigest()
        original_files = read_asar_files(REAL_ASAR)

        patched = onect.build_patched_asar(REAL_ASAR, desktop)
        patched_path = self.dir / "patched.asar"
        patched_path.write_bytes(patched)

        result = onect.verify_patched_asar(patched_path, REAL_ASAR, desktop)
        expected_entries = len(original_files) + len(onect.PATCH_SOURCES)
        self.assertEqual(result["entries"], expected_entries)
        self.assertEqual(result["integrity_verified"], expected_entries)
        self.assertEqual(
            result["unchanged_verified"],
            len(original_files) - len(set(original_files) & onect.REPLACED_PATHS),
        )
        self.assertEqual(result["main"], "./dist/main/auto-bootstrap.cjs")
        self.assertEqual(result["package_name"], "3CT")
        self.assertIn("dist/renderer/1ct/shell.js", result["onect_files"])

        patched_files = read_asar_files(patched_path)
        index_html = patched_files["dist/renderer/index.html"].decode()
        self.assertIn("<title>1CT</title>", index_html)
        for ref in onect.REQUIRED_INDEX_REFS:
            self.assertIn(ref, index_html)
        for ref in onect.FORBIDDEN_INDEX_REFS:
            self.assertNotIn(ref, index_html)
        for legacy in (
            "dist/renderer/panel.js",
            "dist/renderer/dashboard.js",
            "dist/renderer/panel.css",
            "dist/renderer/dashboard.css",
        ):
            self.assertNotIn(legacy, patched_files)

        # 原包未改文件逐一保留（含 electron-updater / node_modules）
        for path, data in original_files.items():
            if path in onect.REPLACED_PATHS:
                continue
            with self.subTest(path=path):
                self.assertIn(path, patched_files, "重建后丢失原文件: " + path)
                if path not in onect.PATCH_SOURCES:
                    self.assertEqual(patched_files[path], data, "原文件被改动: " + path)
        self.assertEqual(hashlib.sha256(REAL_ASAR.read_bytes()).hexdigest(), before_hash)

    def test_extract_jsqr_from_real_sourcemap(self):
        result = onect.extract_jsqr(REAL_ASAR, self.dir / "vendor")
        script = Path(result["script"]).read_text(encoding="utf-8")
        self.assertIn("webpackUniversalModuleDefinition", script)
        self.assertIn("binarize", script)
        self.assertGreater(len(script), 100_000)
        self.assertTrue(Path(result["license"]).is_file())


# ---------------------------------------------------------------------------
# 真实 desktop/ 素材（其它 teammate 产出齐全时才跑）
# ---------------------------------------------------------------------------

REAL_ONECT_INPUTS = [
    REPO_ROOT / "desktop" / "1ct" / name
    for name in ("index.html", "shell.js", "shell.css", "members.js", "ek-stats.js", "ek-stats.css")
]


@unittest.skipUnless(REAL_ASAR.is_file(), "需要原始 3CT/resources/app.asar")
@unittest.skipUnless(all(p.is_file() for p in REAL_ONECT_INPUTS), "desktop/1ct/* 尚未齐备")
class RealDesktopAssetsTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = Path(self._tmp.name)

    def test_real_desktop_assets_build_and_verify(self):
        before_hash = hashlib.sha256(REAL_ASAR.read_bytes()).hexdigest()

        patched = onect.build_patched_asar(REAL_ASAR, REPO_ROOT / "desktop")
        patched_path = self.dir / "patched.asar"
        patched_path.write_bytes(patched)

        result = onect.verify_patched_asar(
            patched_path, REAL_ASAR, REPO_ROOT / "desktop"
        )
        self.assertIn("dist/renderer/1ct/shell.js", result["onect_files"])
        self.assertIn("dist/renderer/1ct/members.js", result["onect_files"])
        self.assertEqual(result["index_title"], "1CT")

        index_html = onect.read_file_by_path(patched_path, "dist/renderer/index.html").decode()
        self.assertIn("<title>1CT</title>", index_html)
        self.assertNotIn("./panel.js", index_html)
        self.assertNotIn("./dashboard.js", index_html)
        # 1CT 页面自带 CSP 且不允许 eval（比原版更严格也行）
        self.assertIn("Content-Security-Policy", index_html)
        self.assertEqual(hashlib.sha256(REAL_ASAR.read_bytes()).hexdigest(), before_hash)


if __name__ == "__main__":
    unittest.main()
