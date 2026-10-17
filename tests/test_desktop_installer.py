"""3CT-Auto 独立副本打包工具的离线测试。

- 合成 ASAR：自建最小包，验证重建/补丁/roundtrip/路径安全；
- 真实包：读取 3CT/resources/app.asar 做纯内存 roundtrip 校验，确认原包 415 个条目
  （347 个文件；重建后 352 个文件）内容零变化、原包 SHA256 前后不变（不启动原程序、
  不访问任何业务接口）；
- 不启动 Electron，不做任何网络操作。
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import shutil
import struct
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
INSTALLER_PATH = REPO_ROOT / "desktop" / "install.py"
REAL_ASAR = REPO_ROOT / "3CT" / "resources" / "app.asar"


def load_installer():
    spec = importlib.util.spec_from_file_location("desktop_install", INSTALLER_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


install = load_installer()


# ---------------------------------------------------------------------------
# 测试用最小 ASAR 写入器（独立实现，避免用被测代码造夹具）
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
            "integrity": install.integrity_for(data),
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
    header, data_base = install.read_header(path)
    result = {}
    for rel_path, node in install.iter_files(header):
        size = int(node["size"])
        offset = int(node["offset"])
        with path.open("rb") as fh:
            fh.seek(data_base + offset)
            result[rel_path] = fh.read(size)
    return result


class SyntheticAsarTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = Path(self._tmp.name)
        self.asar = self.dir / "app.asar"
        self.files = {
            "package.json": json.dumps(
                {"name": "3CT", "version": "1.2.5", "main": "./dist/main/main.js"}
            ).encode(),
            "dist/main/main.js": b"console.log('original main');",
            "dist/renderer/index.html": (
                "<!DOCTYPE html><html><head><title>3CT</title>"
                "<script defer=defer src=./renderer.js></script>"
                "<link href=./style.css rel=stylesheet></head><body><div id=root></div></body></html>"
            ).encode(),
            "node_modules/keep/keep.js": b"module.exports = 42;",
        }
        write_asar(self.asar, self.files)

    def test_read_header_and_data_base(self):
        header, data_base = install.read_header(self.asar)

        self.assertIn("files", header)
        self.assertEqual(data_base, 8 + struct.unpack("<I", self.asar.read_bytes()[4:8])[0])
        self.assertEqual(len(dict(install.iter_files(header))), len(self.files))

    def test_rebuild_keeps_untouched_files_byte_identical(self):
        rebuilt = install.rebuild_asar(
            self.asar, {"node_modules/keep/keep.js": b"module.exports = 43;"}
        )
        out = self.dir / "rebuilt.asar"
        out.write_bytes(rebuilt)

        contents = read_asar_files(out)
        self.assertEqual(contents["node_modules/keep/keep.js"], b"module.exports = 43;")
        for path in ("dist/main/main.js", "package.json", "dist/renderer/index.html"):
            with self.subTest(path=path):
                self.assertEqual(contents[path], self.files[path])

    def test_rebuild_updates_integrity_size_and_offsets(self):
        new_data = b"new payload" * 10
        rebuilt = install.rebuild_asar(self.asar, {"dist/renderer/extra.js": new_data})
        out = self.dir / "rebuilt.asar"
        out.write_bytes(rebuilt)

        header, _ = install.read_header(out)
        node = install.find_node(header, "dist/renderer/extra.js")
        self.assertIsNotNone(node)
        self.assertEqual(node["size"], len(new_data))
        self.assertEqual(node["integrity"]["hash"], hashlib.sha256(new_data).hexdigest())
        self.assertEqual(int(node["offset"]) + node["size"] <= out.stat().st_size, True)
        self.assertEqual(read_asar_files(out)["dist/renderer/extra.js"], new_data)

    def test_rebuild_adds_new_directory_levels(self):
        rebuilt = install.rebuild_asar(self.asar, {"a/b/c/new.txt": b"hi"})
        out = self.dir / "deep.asar"
        out.write_bytes(rebuilt)

        contents = read_asar_files(out)
        self.assertEqual(contents["a/b/c/new.txt"], b"hi")
        self.assertEqual(contents["dist/main/main.js"], self.files["dist/main/main.js"])

    def test_rebuild_original_untouched(self):
        before = hashlib.sha256(self.asar.read_bytes()).hexdigest()
        install.rebuild_asar(self.asar, {"x.txt": b"1"})
        after = hashlib.sha256(self.asar.read_bytes()).hexdigest()
        self.assertEqual(before, after)

    def test_read_header_rejects_bad_magic(self):
        broken = self.dir / "broken.asar"
        broken.write_bytes(b"\x00" * 32)
        with self.assertRaises(install.InstallerError):
            install.read_header(broken)

    def test_read_header_rejects_missing_file(self):
        with self.assertRaises(install.InstallerError):
            install.read_header(self.dir / "nope.asar")

    def test_verify_detects_tampered_integrity(self):
        original = self.asar
        patched_path = self.dir / "patched.asar"
        patched_path.write_bytes(install.rebuild_asar(original, {}))
        header, data_base = install.read_header(patched_path)
        node = install.find_node(header, "dist/main/main.js")
        node["integrity"] = dict(node["integrity"])
        node["integrity"]["hash"] = "0" * 64
        node["integrity"]["blocks"] = ["0" * 64]
        payload = patched_path.read_bytes()[data_base:]
        json_bytes = json.dumps(header, separators=(",", ":"), ensure_ascii=True).encode()
        json_len = len(json_bytes)
        str_pickle_size = (json_len + 4 + 3) // 4 * 4
        header_size = 4 + str_pickle_size
        patched_path.write_bytes(
            struct.pack("<IIII", 4, header_size, str_pickle_size, json_len)
            + json_bytes
            + b"\x00" * (header_size - (json_len + 8))
            + payload
        )

        with self.assertRaises(install.InstallerError) as ctx:
            install.verify_patched_asar(patched_path, original)
        self.assertIn("integrity 与内容不匹配", str(ctx.exception))


class PatchTests(unittest.TestCase):
    ORIGINAL_HTML = (
        b"<!DOCTYPE html><html><head><meta charset=utf-8><title>3CT</title>"
        b"<script defer=defer src=./renderer.js></script>"
        b"<link href=./style.css rel=stylesheet></head><body><div id=root></div></body></html>"
    )

    def test_patch_index_html_adds_scripts_css_and_title(self):
        patched = install.patch_index_html(self.ORIGINAL_HTML).decode()

        self.assertIn("<title>3CT Auto</title>", patched)
        self.assertIn("./panel.css", patched)
        for script in ("./jsQR.js", "./automation.js", "./panel.js"):
            self.assertIn(f"src={script}", patched)
        self.assertLess(patched.index("./jsQR.js"), patched.index("./automation.js"))
        self.assertLess(patched.index("./automation.js"), patched.index("./panel.js"))
        self.assertLess(patched.index("./panel.js"), patched.index("</head>"))

    def test_patch_index_html_keeps_renderer_before_automation(self):
        patched = install.patch_index_html(self.ORIGINAL_HTML).decode()
        self.assertLess(patched.index("./renderer.js"), patched.index("./automation.js"))

    def test_patch_index_html_is_not_applied_twice(self):
        patched = install.patch_index_html(self.ORIGINAL_HTML)
        with self.assertRaises(install.InstallerError):
            install.patch_index_html(patched)

    def test_patch_index_html_requires_expected_markers(self):
        with self.assertRaises(install.InstallerError):
            install.patch_index_html(b"<html><head></head><body></body></html>")

    def test_patch_package_json_sets_bootstrap_main(self):
        original = json.dumps({"name": "3CT", "version": "1.2.5", "main": "./dist/main/main.js"}).encode()
        patched = json.loads(install.patch_package_json(original))

        self.assertEqual(patched["main"], "./dist/main/auto-bootstrap.cjs")
        self.assertEqual(patched["name"], "3CT")
        self.assertEqual(patched["version"], "1.2.5")

    def test_patch_package_json_rejects_garbage(self):
        with self.assertRaises(install.InstallerError):
            install.patch_package_json(b"not json")

    def test_load_patch_inputs_reports_missing_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            desktop = Path(tmp) / "desktop"
            desktop.mkdir()
            with self.assertRaises(install.InstallerError) as ctx:
                install.load_patch_inputs(desktop)
            self.assertIn("缺少补丁输入文件", str(ctx.exception))


class FixtureDesktopMixin:
    def make_desktop_fixture(self, base: Path, *, include_all: bool = True) -> Path:
        desktop = base / "desktop"
        (desktop / "vendor").mkdir(parents=True)
        (desktop / "bootstrap.cjs").write_text("process.env.CT_UPDATE_URL='';\nrequire('./main.js');\n", encoding="utf-8")
        (desktop / "automation.js").write_text("/* automation */\n", encoding="utf-8")
        (desktop / "panel.css").write_text(".panel{color:red}\n", encoding="utf-8")
        (desktop / "vendor" / "jsQR.js").write_text("/* jsQR */\n", encoding="utf-8")
        (desktop / install.LAUNCHER_NAME).write_text(
            "@echo off\r\nstart \"\" \"%~dp03CT-Auto.exe\"\r\n", encoding="utf-8"
        )
        if include_all:
            (desktop / "panel.js").write_text("/* panel */\n", encoding="utf-8")
        return desktop


class BuildFromSyntheticTests(FixtureDesktopMixin, unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.base = Path(self._tmp.name)
        self.source = self.base / "3CT"
        (self.source / "resources").mkdir(parents=True)
        (self.source / "3CT.exe").write_bytes(b"fake-exe")
        (self.source / "Uninstall 3CT.exe").write_bytes(b"fake-uninstall")
        (self.source / "locales").mkdir()
        (self.source / "locales" / "zh-CN.pak").write_bytes(b"locale")
        write_asar(
            self.source / "resources" / "app.asar",
            {
                "package.json": json.dumps(
                    {"name": "3CT", "version": "1.2.5", "main": "./dist/main/main.js"}
                ).encode(),
                "dist/main/main.js": b"main",
                "dist/renderer/index.html": (
                    b"<html><head><title>3CT</title></head><body></body></html>"
                ),
                "node_modules/sql.js/sql-wasm.js": b"sql",
            },
        )
        self.desktop = self.make_desktop_fixture(self.base)
        self.dest = self.base / "3CT-Auto"

    def test_build_creates_independent_copy_with_patched_asar(self):
        summary = install.build(self.source, self.dest, self.desktop)

        self.assertEqual(summary["skipped"], ["Uninstall 3CT.exe"])
        self.assertTrue((self.dest / "3CT-Auto.exe").is_file())
        self.assertFalse((self.dest / "3CT.exe").exists())
        self.assertFalse((self.dest / "Uninstall 3CT.exe").exists())
        self.assertTrue((self.dest / "locales" / "zh-CN.pak").is_file())
        self.assertTrue((self.dest / install.README_NAME).is_file())
        self.assertTrue((self.dest / install.LAUNCHER_NAME).is_file())
        self.assertIn(
            "3CT-Auto.exe",
            (self.dest / install.LAUNCHER_NAME).read_text(encoding="utf-8", errors="replace"),
        )

        patched = read_asar_files(self.dest / "resources" / "app.asar")
        self.assertIn(b"<title>3CT Auto</title>", patched["dist/renderer/index.html"])
        self.assertIn(b"./panel.js", patched["dist/renderer/index.html"])
        self.assertEqual(patched["dist/renderer/panel.css"], (self.desktop / "panel.css").read_bytes())
        self.assertEqual(patched["dist/renderer/jsQR.js"], (self.desktop / "vendor" / "jsQR.js").read_bytes())
        self.assertEqual(patched["dist/main/auto-bootstrap.cjs"], self.desktop.joinpath("bootstrap.cjs").read_bytes())
        package = json.loads(patched["package.json"])
        self.assertEqual(package["main"], "./dist/main/auto-bootstrap.cjs")
        self.assertEqual(package["name"], "3CT")
        self.assertEqual(patched["node_modules/sql.js/sql-wasm.js"], b"sql")
        self.assertEqual(patched["dist/main/main.js"], b"main")

    def test_build_does_not_modify_original_tree(self):
        original_hash = hashlib.sha256((self.source / "resources" / "app.asar").read_bytes()).hexdigest()
        source_files_before = sorted(p.name for p in self.source.iterdir())

        summary = install.build(self.source, self.dest, self.desktop)

        self.assertEqual(summary["original_asar_sha256"], original_hash)
        self.assertEqual(
            hashlib.sha256((self.source / "resources" / "app.asar").read_bytes()).hexdigest(),
            original_hash,
        )
        self.assertEqual(sorted(p.name for p in self.source.iterdir()), source_files_before)

    def test_build_refuses_existing_destination_without_force(self):
        self.dest.mkdir()
        (self.dest / "keep.txt").write_text("old", encoding="utf-8")

        with self.assertRaises(install.InstallerError) as ctx:
            install.build(self.source, self.dest, self.desktop)
        self.assertIn("--force", str(ctx.exception))
        self.assertTrue((self.dest / "keep.txt").is_file())

    def test_build_force_recreates_destination(self):
        self.dest.mkdir()
        (self.dest / "stale.txt").write_text("old", encoding="utf-8")

        with self.assertRaises(install.InstallerError) as ctx:
            install.build(self.source, self.dest, self.desktop, force=True)
        self.assertIn("拒绝删除未确认的目录", str(ctx.exception))
        self.assertTrue((self.dest / "stale.txt").is_file())

    def test_force_refuses_stale_marker_hash(self):
        install.build(self.source, self.dest, self.desktop)
        marker_path = self.dest / install.MARKER_NAME
        marker = json.loads(marker_path.read_text(encoding="utf-8"))
        marker["source_asar_sha256"] = "0" * 64
        marker_path.write_text(json.dumps(marker), encoding="utf-8")

        with self.assertRaises(install.InstallerError) as ctx:
            install.build(self.source, self.dest, self.desktop, force=True)

        self.assertIn("哈希与当前原程序不一致", str(ctx.exception))

    def test_force_rebuilds_previously_generated_copy(self):
        install.build(self.source, self.dest, self.desktop)
        stale = self.dest / "stale.txt"
        stale.write_text("old", encoding="utf-8")

        install.build(self.source, self.dest, self.desktop, force=True)

        self.assertFalse(stale.exists())
        self.assertTrue((self.dest / "3CT-Auto.exe").is_file())
        marker = json.loads((self.dest / install.MARKER_NAME).read_text(encoding="utf-8"))
        self.assertEqual(marker["generator"], "desktop/install.py")
        self.assertEqual(
            marker["source_asar_sha256"],
            hashlib.sha256((self.source / "resources" / "app.asar").read_bytes()).hexdigest(),
        )

    def test_force_with_missing_inputs_keeps_existing_copy_intact(self):
        install.build(self.source, self.dest, self.desktop)
        asar_path = self.dest / "resources" / "app.asar"
        before = hashlib.sha256(asar_path.read_bytes()).hexdigest()
        (self.desktop / "panel.js").unlink()

        with self.assertRaises(install.InstallerError):
            install.build(self.source, self.dest, self.desktop, force=True)

        self.assertEqual(hashlib.sha256(asar_path.read_bytes()).hexdigest(), before)
        self.assertTrue((self.dest / install.MARKER_NAME).is_file())

    def test_build_writes_marker_with_source_hash(self):
        summary = install.build(self.source, self.dest, self.desktop)

        marker = json.loads((self.dest / install.MARKER_NAME).read_text(encoding="utf-8"))
        self.assertEqual(marker["generator"], "desktop/install.py")
        self.assertEqual(marker["source_asar_sha256"], summary["original_asar_sha256"])
        self.assertEqual(marker["patched_asar_sha256"], summary["patched_asar_sha256"])

    def test_build_fails_clearly_when_patch_inputs_missing(self):
        desktop = self.make_desktop_fixture(self.base / "half", include_all=False)

        with self.assertRaises(install.InstallerError) as ctx:
            install.build(self.source, self.dest, desktop)
        self.assertIn("panel.js", str(ctx.exception))
        self.assertFalse(self.dest.exists())

    def test_build_rejects_dest_inside_source(self):
        with self.assertRaises(install.InstallerError):
            install.build(self.source, self.source / "nested" / "3CT-Auto", self.desktop)

    def test_check_removable_refuses_unconfirmed_directory(self):
        other = self.base / "important"
        other.mkdir()
        with self.assertRaises(install.InstallerError):
            install.check_removable(
                other,
                self.source / "resources" / "app.asar",
                self.source,
            )
        self.assertTrue(other.exists())

    def test_ignore_guard_covers_generated_copy(self):
        gitignore = (REPO_ROOT / ".gitignore").read_text(encoding="utf-8")
        self.assertIn("/3CT-Auto/", gitignore)


@unittest.skipUnless(REAL_ASAR.is_file(), "需要原始 3CT/resources/app.asar")
class RealArchiveTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = Path(self._tmp.name)

    def test_real_asar_roundtrip_preserves_every_entry(self):
        before_hash = hashlib.sha256(REAL_ASAR.read_bytes()).hexdigest()
        original_files = read_asar_files(REAL_ASAR)

        rebuilt = install.rebuild_asar(REAL_ASAR, {})
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
        desktop = FixtureDesktopMixin()
        fixture = desktop.make_desktop_fixture(self.dir)
        before_hash = hashlib.sha256(REAL_ASAR.read_bytes()).hexdigest()

        patched = install.build_patched_asar(REAL_ASAR, fixture)
        patched_path = self.dir / "patched.asar"
        patched_path.write_bytes(patched)

        result = install.verify_patched_asar(patched_path, REAL_ASAR, fixture)
        self.assertEqual(result["entries"], 352)
        self.assertEqual(result["integrity_verified"], 352)
        self.assertEqual(
            hashlib.sha256(REAL_ASAR.read_bytes()).hexdigest(), before_hash
        )

        patched_files = read_asar_files(patched_path)
        index_html = patched_files["dist/renderer/index.html"].decode()
        for needle in ("./jsQR.js", "./automation.js", "./panel.js", "./panel.css"):
            self.assertIn(needle, index_html)
        self.assertIn("<title>3CT Auto</title>", index_html)
        self.assertEqual(json.loads(patched_files["package.json"])["main"], "./dist/main/auto-bootstrap.cjs")
        self.assertEqual(
            patched_files["node_modules/electron-updater/package.json"],
            read_asar_files(REAL_ASAR)["node_modules/electron-updater/package.json"],
        )

    def test_extract_jsqr_from_real_sourcemap(self):
        result = install.extract_jsqr(REAL_ASAR, self.dir / "vendor")

        script = Path(result["script"]).read_text(encoding="utf-8")
        self.assertIn("webpackUniversalModuleDefinition", script)
        self.assertIn("jsQR", script)
        self.assertIn("binarize", script)
        self.assertGreater(len(script), 100_000)
        self.assertTrue(Path(result["license"]).is_file())


class StartupFilesTests(unittest.TestCase):
    def test_bootstrap_runs_before_original_main_and_disables_updates(self):
        text = (REPO_ROOT / "desktop" / "bootstrap.cjs").read_text(encoding="utf-8")

        self.assertIn("CT_UPDATE_URL", text)
        self.assertIn("autoDownload = false", text)
        self.assertIn("autoInstallOnAppQuit = false", text)
        self.assertIn("setBackgroundThrottling(false)", text)
        self.assertIn("require('./main.js')", text)
        self.assertLess(text.index("CT_UPDATE_URL"), text.rindex("require('./main.js')"))
        self.assertLess(
            text.index("setBackgroundThrottling(false)"), text.rindex("require('./main.js')")
        )

    def test_start_script_checks_original_instance_without_killing(self):
        for path in (
            REPO_ROOT / "start-3ct-auto.cmd",
            REPO_ROOT / "desktop" / "start-3ct-auto.cmd",
        ):
            with self.subTest(path=path.name):
                text = path.read_text(encoding="utf-8")
                self.assertIn("3CT-Auto.exe", text)
                self.assertIn("3CT-Auto\\3CT-Auto.exe", text)
                self.assertIn("tasklist", text)
                self.assertIn('"IMAGENAME eq 3CT.exe"', text)
                self.assertIn('"IMAGENAME eq 3CT-Auto.exe"', text)
                self.assertIn("pause", text)
                self.assertNotIn("taskkill", text.lower())
                self.assertNotIn("Stop-Process", text)
                self.assertIn("共享同一用户数据和单实例锁", text)

    def test_build_writes_launcher_into_copy(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = FixtureDesktopMixin().make_desktop_fixture(Path(tmp))
            source = Path(tmp) / "3CT"
            (source / "resources").mkdir(parents=True)
            (source / "3CT.exe").write_bytes(b"exe")
            write_asar(
                source / "resources" / "app.asar",
                {
                    "package.json": b'{"name":"3CT","version":"1.2.5","main":"./dist/main/main.js"}',
                    "dist/main/main.js": b"main",
                    "dist/renderer/index.html": b"<html><head><title>3CT</title></head><body></body></html>",
                },
            )
            dest = Path(tmp) / "3CT-Auto"

            install.build(source, dest, fixture)

            launcher = dest / install.LAUNCHER_NAME
            self.assertTrue(launcher.is_file())
            self.assertIn("3CT-Auto", launcher.read_text(encoding="utf-8", errors="replace"))

    def test_readme_documents_background_and_no_update_constraints(self):
        text = install.README_TEXT
        self.assertIn("userData", text)
        self.assertIn("自动更新", text)
        self.assertIn("唤醒", text)
        self.assertIn("单实例锁", text)


if __name__ == "__main__":
    unittest.main()
