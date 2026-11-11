"""desktop/repack_1ct_incremental.py 的离线测试。

背景：本仓库的 ``3CT\\`` 源目录已空、原始基线 asar（``028d4695…``）不在磁盘上，
唯一可用基线是 ``1CT/resources/app.asar.bak`` —— 它**本身是打过补丁的 1.2.1 发布包**，
于是 ``desktop/install_1ct.py`` 的 ``patch_main_js`` 必然报「期望唯一命中 1 次，实际 0 次」。
增量重打包器补的是**幂等语义**，不是绕过守卫，因此这里要证明：

- 基线已是 1CT 文案时 main.js 字节原样保留（幂等），且不改动白名单外条目；
- 基线仍是 3CT 文案时正常打补丁，并保住功能性保护串；
- 基线处于「两种状态都不是」的中间态时一律拒绝（不猜、不半成品）；
- 基线 sha256 / 输出 sha256 断言不符时中止，且不留下半成品文件；
- 白名单之外的条目变化一律拒绝（防止悄悄改动别的文件）；
- 默认拒绝写入含 ``.1ct-install.json`` 的已安装副本目录。

全部在临时目录里用自造的最小 asar 夹具完成：不启动 Electron、不访问网络、
不读真实 profile、不写真实安装目录。
"""

from __future__ import annotations

import importlib.util
import json
import os
import struct
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
REPACK_PATH = REPO_ROOT / "desktop" / "repack_1ct_incremental.py"


def load_module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


repack = load_module(REPACK_PATH, "desktop_repack_1ct_incremental_test")
installer = repack._load_installer()


# ---------------------------------------------------------------------------
# 最小 ASAR 写入器（独立实现，避免用被测代码造夹具）
# ---------------------------------------------------------------------------


def write_asar(path: Path, files: dict[str, bytes]) -> None:
    header: dict = {"files": {}}
    offset = 0
    blobs = bytearray()

    for rel_path in sorted(files):
        parts = rel_path.split("/")
        node = header
        for part in parts[:-1]:
            node = node["files"].setdefault(part, {"files": {}})
        data = files[rel_path]
        node["files"][parts[-1]] = {
            "size": len(data),
            "offset": str(offset),
            "integrity": installer.integrity_for(data),
        }
        blobs.extend(data)
        offset += len(data)

    json_bytes = json.dumps(header, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    json_len = len(json_bytes)
    str_pickle_size = (json_len + 4 + 3) // 4 * 4
    header_size = 4 + str_pickle_size
    padding = header_size - (json_len + 8)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(
        struct.pack("<IIII", 4, header_size, str_pickle_size, json_len)
        + json_bytes
        + b"\x00" * padding
        + bytes(blobs)
    )


def read_asar_files(path: Path) -> dict[str, bytes]:
    header, data_base = installer.read_header(path)
    return {
        rel_path: installer.read_file(path, node, data_base)
        for rel_path, node in installer.iter_files(header)
    }


# ---------------------------------------------------------------------------
# 夹具
# ---------------------------------------------------------------------------

ONECT_INDEX_FIXTURE = b"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<title>1CT</title>
<link rel="icon" type="image/png" href="./1ct/icon.png" />
""" + b"".join(
    b'<link rel="stylesheet" href="' + ref.encode() + b'" />\n'
    if ref.endswith(".css")
    else b'<script src="' + ref.encode() + b'"></script>\n'
    for ref in installer.REQUIRED_INDEX_REFS
) + b"""</head><body><div id="app"></div></body></html>
"""

ORIGINAL_INDEX_FIXTURE = (
    b'<!DOCTYPE html><html><head><meta charset="utf-8" />'
    b'<meta http-equiv="Content-Security-Policy" content="default-src \'self\'">'
    b"<title>3CT</title></head><body></body></html>"
)

PRELOAD_FIXTURE = (
    b'var ctAPI={ek:{' + installer.PRELOAD_JS_ANCHOR + b'}};\n'
)


def main_js_text(*, patched: bool, broken: bool = False) -> bytes:
    """构造 main.js 夹具：patched=1CT 文案，否则 3CT 原文案；broken 制造中间态。"""

    chunks = []
    for _label, old, new in installer.MAIN_JS_TEXT_REPLACEMENTS:
        chunks.append(new if patched else old)
    if broken:
        # 少一处新串：既不是完整已应用，也不能被当作原文案打补丁。
        chunks = chunks[:-1]
    chunks.extend(installer.PROTECTED_MAIN_JS_STRINGS)
    return ("var x=1;" + ";".join(chunks) + ";").encode("utf-8")


def make_desktop_dir(root: Path) -> Path:
    """造一个形状正确的 desktop/ 补丁素材目录（内容为占位字节）。"""

    desktop_dir = root / "desktop"
    for archive_path, source in installer.patch_source_map(desktop_dir).items():
        source.parent.mkdir(parents=True, exist_ok=True)
        if source.name == "index.html":
            source.write_bytes(ONECT_INDEX_FIXTURE)
        elif source.suffix == ".css":
            source.write_bytes(b"/* " + archive_path.encode() + b" */\n")
        else:
            source.write_bytes(b"// " + archive_path.encode() + b"\n")
    return desktop_dir


def make_baseline(path: Path, *, patched_main: bool, broken_main: bool = False) -> None:
    """造一个「已打过补丁」形状的基线 asar（含全部注入路径，内容为旧占位）。"""

    files: dict[str, bytes] = {
        "package.json": json.dumps(
            {"name": "3CT", "version": "1.2.1", "main": "dist/main/main.js"},
            separators=(",", ":"),
        ).encode("utf-8"),
        installer.MAIN_JS_PATH: main_js_text(patched=patched_main, broken=broken_main),
        installer.PRELOAD_JS_PATH: PRELOAD_FIXTURE,
        installer.INDEX_HTML_PATH: ORIGINAL_INDEX_FIXTURE,
        "dist/renderer/other.js": b"// unrelated baseline content\n",
    }
    for archive_path in installer.patch_source_map(Path("/nonexistent-desktop")):
        files.setdefault(archive_path, b"OLD:" + archive_path.encode() + b"\n")
    files[installer.ONECT_INDEX_ASAR_PATH] = ORIGINAL_INDEX_FIXTURE
    write_asar(path, files)


class RepackIdempotentTests(unittest.TestCase):
    """main.js 幂等：已应用的基线不被二次改写。"""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.desktop_dir = make_desktop_dir(self.root)
        self.baseline = self.root / "baseline.asar"
        make_baseline(self.baseline, patched_main=True)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_already_applied_baseline_keeps_main_js_bytes(self) -> None:
        out = self.root / "out" / "app.asar"
        report = repack.repack(
            self.baseline,
            out,
            expect_baseline_sha=repack.sha256_file(self.baseline),
            desktop_dir=self.desktop_dir,
            allow_in_place=True,
        )

        self.assertEqual(report["main_js"]["state"], "already-applied")
        before = read_asar_files(self.baseline)
        after = read_asar_files(out)
        self.assertEqual(after[installer.MAIN_JS_PATH], before[installer.MAIN_JS_PATH])
        self.assertEqual(
            sorted(after), sorted(before), "增量重打包不得增删 asar 条目"
        )
        self.assertEqual(report["verification"]["entries"], len(before))
        self.assertEqual(
            report["verification"]["integrity_checked"], len(before)
        )
        changed = {row["path"] for row in report["verification"]["changed_entries"]}
        allowed = repack.allowed_paths(installer)
        self.assertTrue(changed <= allowed, f"出现白名单外改动: {changed - allowed}")
        self.assertNotIn("dist/renderer/other.js", changed)
        self.assertEqual(
            after["dist/renderer/other.js"], before["dist/renderer/other.js"]
        )
        self.assertTrue(report["verification"]["unchanged_digest_sha256"])

    def test_injected_entries_take_desktop_bytes(self) -> None:
        out = self.root / "out" / "app.asar"
        repack.repack(
            self.baseline,
            out,
            expect_baseline_sha=repack.sha256_file(self.baseline),
            desktop_dir=self.desktop_dir,
            allow_in_place=True,
        )
        after = read_asar_files(out)
        for archive_path, source in installer.patch_source_map(self.desktop_dir).items():
            if archive_path == installer.ONECT_INDEX_ASAR_PATH:
                continue  # index.html 由 prepare_index_html 规范化
            self.assertEqual(
                after[archive_path], source.read_bytes(), f"{archive_path} 未取用 desktop 字节"
            )

    def test_report_records_baseline_and_output_sha(self) -> None:
        out = self.root / "out" / "app.asar"
        report_path = self.root / "report.json"
        report = repack.repack(
            self.baseline,
            out,
            expect_baseline_sha=repack.sha256_file(self.baseline),
            desktop_dir=self.desktop_dir,
            report_path=report_path,
            allow_in_place=True,
        )
        self.assertEqual(report["baseline_sha256"], repack.sha256_file(self.baseline))
        self.assertEqual(report["output_sha256"], repack.sha256_file(out))
        self.assertEqual(report["mode"], "strict-incremental")
        self.assertEqual(
            json.loads(report_path.read_text(encoding="utf-8"))["output_sha256"],
            report["output_sha256"],
        )


class RepackPatchFromOriginalTests(unittest.TestCase):
    """基线仍是 3CT 文案时正常打补丁（保留功能性保护串）。"""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.desktop_dir = make_desktop_dir(self.root)
        self.baseline = self.root / "baseline.asar"
        make_baseline(self.baseline, patched_main=False)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_original_baseline_gets_patched(self) -> None:
        out = self.root / "out" / "app.asar"
        report = repack.repack(
            self.baseline,
            out,
            expect_baseline_sha=repack.sha256_file(self.baseline),
            desktop_dir=self.desktop_dir,
            allow_in_place=True,
        )
        self.assertEqual(report["main_js"]["state"], "patched-from-3ct")
        text = read_asar_files(out)[installer.MAIN_JS_PATH].decode("utf-8")
        for _label, old, new in installer.MAIN_JS_TEXT_REPLACEMENTS:
            self.assertNotIn(old, text)
            self.assertEqual(text.count(new), 1)
        for needle in installer.PROTECTED_MAIN_JS_STRINGS:
            self.assertIn(needle, text)

    def test_middle_state_baseline_is_rejected(self) -> None:
        broken = self.root / "broken.asar"
        make_baseline(broken, patched_main=True, broken_main=True)
        out = self.root / "out-broken" / "app.asar"
        with self.assertRaises(repack.RepackError):
            repack.repack(
                broken,
                out,
                expect_baseline_sha=repack.sha256_file(broken),
                desktop_dir=self.desktop_dir,
                allow_in_place=True,
            )
        self.assertFalse(out.exists(), "失败时不得留下产物")
        self.assertFalse(
            out.with_name(out.name + ".repack-tmp").exists(), "失败时不得留下临时文件"
        )


class RepackGuardTests(unittest.TestCase):
    """断言/白名单/安装目录守卫。"""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.desktop_dir = make_desktop_dir(self.root)
        self.baseline = self.root / "baseline.asar"
        make_baseline(self.baseline, patched_main=True)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_baseline_sha_mismatch_refused(self) -> None:
        out = self.root / "out" / "app.asar"
        with self.assertRaises(repack.RepackError):
            repack.repack(
                self.baseline,
                out,
                desktop_dir=self.desktop_dir,
                expect_baseline_sha="0" * 64,
                allow_in_place=True,
            )
        self.assertFalse(out.exists())

    def test_output_sha_mismatch_refused(self) -> None:
        out = self.root / "out" / "app.asar"
        with self.assertRaises(repack.RepackError):
            repack.repack(
                self.baseline,
                out,
                expect_baseline_sha=repack.sha256_file(self.baseline),
                desktop_dir=self.desktop_dir,
                expect_output_sha="0" * 64,
                allow_in_place=True,
            )
        self.assertFalse(out.exists())

    def test_non_whitelisted_entry_change_rejected(self) -> None:
        before = read_asar_files(self.baseline)
        mutated = dict(before)
        mutated["dist/renderer/other.js"] = b"// silently changed!\n"
        other = self.root / "other.asar"
        write_asar(other, mutated)

        with self.assertRaises(repack.RepackError):
            repack.verify_incremental(installer, self.baseline, other, allowed=set())

    def test_whitelisted_entry_change_accepted(self) -> None:
        before = read_asar_files(self.baseline)
        mutated = dict(before)
        mutated["dist/renderer/other.js"] = b"// intentionally changed\n"
        other = self.root / "other-ok.asar"
        write_asar(other, mutated)

        evidence = repack.verify_incremental(
            installer, self.baseline, other, allowed={"dist/renderer/other.js"}
        )
        self.assertEqual(
            [row["path"] for row in evidence["changed_entries"]],
            ["dist/renderer/other.js"],
        )
        self.assertEqual(evidence["integrity_checked"], len(before))

    def test_installed_copy_target_refused_by_default(self) -> None:
        installed = self.root / "1CT"
        (installed / "resources").mkdir(parents=True)
        (installed / ".1ct-install.json").write_text("{}", encoding="utf-8")
        out = installed / "resources" / "app.asar"
        with self.assertRaises(repack.RepackError):
            repack.repack(
                self.baseline,
                out,
                expect_baseline_sha=repack.sha256_file(self.baseline),
                desktop_dir=self.desktop_dir,
            )
        self.assertFalse(out.exists())


class RepackCliTests(unittest.TestCase):
    """CLI 契约：成功 exit 0 且打印 output_sha256；失败 exit 1。"""

    def test_cli_success_and_failure_exit_codes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            desktop_dir = make_desktop_dir(root)
            baseline = root / "baseline.asar"
            make_baseline(baseline, patched_main=True)
            out = root / "out" / "app.asar"

            code = repack.main(
                [
                    "--baseline", str(baseline),
                    "--expect-baseline-sha", repack.sha256_file(baseline),
                    "--out", str(out),
                    "--desktop-dir", str(desktop_dir),
                    "--allow-in-place",
                ]
            )
            self.assertEqual(code, 0)
            self.assertTrue(out.is_file())

            bad = repack.main(
                [
                    "--baseline", str(baseline),
                    "--expect-baseline-sha", repack.sha256_file(baseline),
                    "--out", str(root / "out2" / "app.asar"),
                    "--desktop-dir", str(desktop_dir),
                    "--expect-output-sha", "0" * 64,
                    "--allow-in-place",
                ]
            )
            self.assertEqual(bad, 1)



# ---------------------------------------------------------------------------
# 更严格的守卫：强制基线声明、毁源防护、link/unpacked、缺 integrity、输入冻结
# ---------------------------------------------------------------------------


def write_asar_mutated(path: Path, files: dict[str, bytes], mutate) -> None:
    """同 write_asar，但允许在写盘前改写 header 节点（造 link / 缺 integrity 夹具）。"""

    header: dict = {"files": {}}
    offset = 0
    blobs = bytearray()
    for rel_path in sorted(files):
        parts = rel_path.split("/")
        node = header
        for part in parts[:-1]:
            node = node["files"].setdefault(part, {"files": {}})
        data = files[rel_path]
        node["files"][parts[-1]] = {
            "size": len(data),
            "offset": str(offset),
            "integrity": installer.integrity_for(data),
        }
        blobs.extend(data)
        offset += len(data)

    mutate(header)

    json_bytes = json.dumps(header, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    json_len = len(json_bytes)
    str_pickle_size = (json_len + 4 + 3) // 4 * 4
    header_size = 4 + str_pickle_size
    padding = header_size - (json_len + 8)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(
        struct.pack("<IIII", 4, header_size, str_pickle_size, json_len)
        + json_bytes
        + b"\x00" * padding
        + bytes(blobs)
    )


class StrictGuardTests(unittest.TestCase):
    """复审提出的收紧项：必填基线、毁源、link/unpacked、缺 integrity、输入冻结。"""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.desktop_dir = make_desktop_dir(self.root)
        self.baseline = self.root / "baseline.asar"
        make_baseline(self.baseline, patched_main=True)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_empty_baseline_sha_refused(self) -> None:
        with self.assertRaises(repack.RepackError):
            repack.repack(
                self.baseline,
                self.root / "out" / "app.asar",
                expect_baseline_sha="   ",
                desktop_dir=self.desktop_dir,
                allow_in_place=True,
            )

    def test_output_same_as_baseline_refused_even_in_place(self) -> None:
        before = self.baseline.read_bytes()
        with self.assertRaises(repack.RepackError):
            repack.repack(
                self.baseline,
                self.baseline,
                expect_baseline_sha=repack.sha256_file(self.baseline),
                desktop_dir=self.desktop_dir,
                allow_in_place=True,
            )
        self.assertEqual(self.baseline.read_bytes(), before, "基线被改写（毁源）")

    def test_official_3ct_baseline_without_injected_paths_refused(self) -> None:
        official = self.root / "official-3ct.asar"
        write_asar(
            official,
            {
                "package.json": json.dumps({"name": "3CT", "version": "1.2.1"}).encode(),
                installer.MAIN_JS_PATH: main_js_text(patched=False),
                installer.PRELOAD_JS_PATH: PRELOAD_FIXTURE,
                installer.INDEX_HTML_PATH: ORIGINAL_INDEX_FIXTURE,
            },
        )
        with self.assertRaises(repack.RepackError):
            repack.repack(
                official,
                self.root / "out" / "app.asar",
                expect_baseline_sha=repack.sha256_file(official),
                desktop_dir=self.desktop_dir,
                allow_in_place=True,
            )

    def test_link_entry_rejected(self) -> None:
        files = read_asar_files(self.baseline)
        linked = self.root / "linked.asar"

        def mutate(header: dict) -> None:
            renderer = header["files"]["dist"]["files"]["renderer"]["files"]
            renderer["other.js"] = {"link": "somewhere.js"}

        write_asar_mutated(linked, files, mutate)
        with self.assertRaises(repack.RepackError):
            repack.verify_incremental(installer, self.baseline, linked, allowed=set())

    def test_unpacked_entry_rejected(self) -> None:
        files = read_asar_files(self.baseline)
        unpacked = self.root / "unpacked.asar"

        def mutate(header: dict) -> None:
            node = header["files"]["dist"]["files"]["renderer"]["files"]["other.js"]
            node["unpacked"] = True

        write_asar_mutated(unpacked, files, mutate)
        with self.assertRaises(repack.RepackError):
            repack.verify_incremental(installer, self.baseline, unpacked, allowed=set())

    def test_missing_integrity_rejected(self) -> None:
        files = read_asar_files(self.baseline)
        no_integrity = self.root / "no-integrity.asar"

        def mutate(header: dict) -> None:
            node = header["files"]["dist"]["files"]["renderer"]["files"]["other.js"]
            node.pop("integrity", None)

        write_asar_mutated(no_integrity, files, mutate)
        with self.assertRaises(repack.RepackError):
            repack.verify_incremental(installer, self.baseline, no_integrity, allowed=set())

    def test_input_freeze_mismatch_refused(self) -> None:
        frozen = {
            path: row["sha256"] for path, row in repack.input_manifest(self.desktop_dir).items()
        }
        broken = dict(frozen)
        broken["dist/renderer/automation.js"] = "0" * 64
        with self.assertRaises(repack.RepackError):
            repack.repack(
                self.baseline,
                self.root / "out" / "app.asar",
                expect_baseline_sha=repack.sha256_file(self.baseline),
                desktop_dir=self.desktop_dir,
                expect_inputs_sha=broken,
                allow_in_place=True,
            )

    def test_input_freeze_match_recorded(self) -> None:
        frozen = {
            path: row["sha256"] for path, row in repack.input_manifest(self.desktop_dir).items()
        }
        out = self.root / "out" / "app.asar"
        report = repack.repack(
            self.baseline,
            out,
            expect_baseline_sha=repack.sha256_file(self.baseline),
            desktop_dir=self.desktop_dir,
            expect_inputs_sha=frozen,
            allow_in_place=True,
        )
        self.assertTrue(report["inputs_frozen"])
        self.assertEqual(
            {path: row["sha256"] for path, row in report["inputs_manifest"].items()},
            frozen,
        )

    def test_full_integrity_claim_is_honest(self) -> None:
        out = self.root / "out" / "app.asar"
        report = repack.repack(
            self.baseline,
            out,
            expect_baseline_sha=repack.sha256_file(self.baseline),
            desktop_dir=self.desktop_dir,
            allow_in_place=True,
        )
        verification = report["verification"]
        self.assertEqual(verification["integrity_checked"], verification["entries"])
        self.assertFalse(report["inputs_frozen"])


#: 2026-10-31 10:1x 那次「1.2.2 等价性」实测的**冻结快照**（历史证据，勿改）。
#: 只有当输入字节仍等于这份快照时才断言输出 == SNAPSHOT_OUTPUT_SHA；
#: 否则 skip —— 源码按业务修复改动后，本就不该再重现 1.2.2。
SNAPSHOT_BASELINE_SHA = (
    "cec871b2c7ce1dce3f7885181539c710a3ed1520f2fba307f913183b1267c423"
)
SNAPSHOT_OUTPUT_SHA = (
    "fa8acd3236cd26feb1822ae6bf4ed431910540c022309fa4e2c536d9601ef692"
)
SNAPSHOT_INPUTS = {
    "dist/main/auto-bootstrap.cjs": "60275fee9b5212ba083d4773244ea4185c925467f9cdd1f8bf2f4ebefe4e64d4",
    "dist/renderer/1ct/ek-stats.css": "47ec2abe9dce35c9c752cc5f786fd5d758777ffdabed72e8c36b0af28fdd9db1",
    "dist/renderer/1ct/ek-stats.js": "b3b25ee6d36cc96ab28a6c903b8354d367849caed8c745665f72a39732015994",
    "dist/renderer/1ct/fallback-photo.js": "79f1075e86651f3b761357b9cd9f5086fd5b257839c6893d725f874392485d03",
    "dist/renderer/1ct/icon.png": "3c0fa557ea29f5406f2e77450c19dcd947cc8d230f597bd370797cb269b226fe",
    "dist/renderer/1ct/index.html": "34343d80cd516d59fa0c390abbb0dfd0a271a3f553d7815ce189084c144f120d",
    "dist/renderer/1ct/members.js": "63d34d253f3245f61c7b256e12eced5af9ba3506b0cc39369ea89cb68f0e0103",
    "dist/renderer/1ct/shell.css": "9f2c323f821071225f1b8fcf00fba3c5e984ef8d2d6aa55d91d206376a60e9c2",
    "dist/renderer/1ct/shell.js": "2e32fd61edd49f64a0453bb8de269f20bfd666528fd32c446b4a3462106ad27a",
    "dist/renderer/automation.js": "3af0ac4fb07e42659fcfa6e0c2377431e69e590e6dcedc8ba66e1c23df149d25",
    "dist/renderer/jsQR.js": "3ae24ef919a523ba344b15f3145e23ce15cf05cdddcd4e27e5945f86b2337ba9",
    "dist/renderer/result-store.js": "c3a617cc64b846d3c7f9ed67c14f495a12654eed2ee2f9128a5da7a58a6f4d83",
    "dist/renderer/score-policy.js": "5d95a6db2524c342c4386e0c5175a1938a2b17e6b9f351d249c43d5dd22ae70f",
}
REAL_BASELINE = REPO_ROOT / "1CT" / "resources" / "app.asar.bak"


class SnapshotEquivalenceTests(unittest.TestCase):
    """历史快照等价性：输入仍等于 1.2.2 快照时，输出必须逐字节 == fa8acd32…。"""

    def test_snapshot_reproduces_122_asar(self) -> None:
        snapshot_dir = os.environ.get("CT_SNAPSHOT_DESKTOP_DIR")
        desktop_dir = Path(snapshot_dir) if snapshot_dir else REPO_ROOT / "desktop"
        if not REAL_BASELINE.is_file():
            self.skipTest(f"缺少基线 {REAL_BASELINE}")
        if repack.sha256_file(REAL_BASELINE) != SNAPSHOT_BASELINE_SHA:
            self.skipTest("基线已不是 1.2.2 快照基线（cec871b2…）")
        manifest = repack.input_manifest(desktop_dir)
        actual = {path: row["sha256"] for path, row in manifest.items()}
        if actual != SNAPSHOT_INPUTS:
            differing = sorted(
                path
                for path in set(actual) | set(SNAPSHOT_INPUTS)
                if actual.get(path) != SNAPSHOT_INPUTS.get(path)
            )
            self.skipTest(
                "输入已偏离 1.2.2 快照（源码已按业务修复改动），跳过历史等价性断言: "
                + ", ".join(differing[:4])
            )

        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "app.asar"
            report = repack.repack(
                REAL_BASELINE,
                out,
                expect_baseline_sha=SNAPSHOT_BASELINE_SHA,
                desktop_dir=desktop_dir,
                expect_inputs_sha=SNAPSHOT_INPUTS,
                expect_output_sha=SNAPSHOT_OUTPUT_SHA,
                allow_in_place=True,
            )
            self.assertEqual(report["output_sha256"], SNAPSHOT_OUTPUT_SHA)
            self.assertEqual(
                report["verification"]["integrity_checked"],
                report["verification"]["entries"],
            )



class InputFreezeSetTests(unittest.TestCase):
    """冻结清单必须是「完整集合」：漏项、多项、显式空 dict 一律拒绝（RED 先行）。"""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.desktop_dir = make_desktop_dir(self.root)
        self.baseline = self.root / "baseline.asar"
        make_baseline(self.baseline, patched_main=True)
        self.full = {
            path: row["sha256"] for path, row in repack.input_manifest(self.desktop_dir).items()
        }

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _repack(self, expect_inputs_sha):
        return repack.repack(
            self.baseline,
            self.root / "out" / "app.asar",
            expect_baseline_sha=repack.sha256_file(self.baseline),
            desktop_dir=self.desktop_dir,
            expect_inputs_sha=expect_inputs_sha,
            allow_in_place=True,
        )

    def test_freeze_subset_refused(self) -> None:
        one = {sorted(self.full)[0]: self.full[sorted(self.full)[0]]}
        with self.assertRaises(repack.RepackError) as ctx:
            self._repack(one)
        self.assertIn("漏项", str(ctx.exception))

    def test_freeze_extra_key_refused(self) -> None:
        extra = dict(self.full)
        extra["dist/renderer/not-a-patch-input.js"] = "0" * 64
        with self.assertRaises(repack.RepackError) as ctx:
            self._repack(extra)
        self.assertIn("多余", str(ctx.exception))

    def test_freeze_explicit_empty_dict_refused(self) -> None:
        with self.assertRaises(repack.RepackError) as ctx:
            self._repack({})
        self.assertIn("空", str(ctx.exception))

    def test_freeze_full_set_accepted(self) -> None:
        report = self._repack(self.full)
        self.assertTrue(report["inputs_frozen"])
        self.assertEqual(set(report["inputs_manifest"]), set(self.full))

    def test_output_injected_entries_must_equal_inputs(self) -> None:
        """TOCTOU 后置校验：产物里的注入条目字节必须等于构建时真正读到的输入。"""

        out = self.root / "out" / "app.asar"
        report = self._repack(self.full)
        self.assertTrue(out.is_file())
        self.assertEqual(
            set(report["expect_entry_sha"]), set(self.full)
        )
        installer = repack._load_installer()
        wrong = dict(report["expect_entry_sha"])
        target = sorted(wrong)[0]
        wrong[target] = "0" * 64
        with self.assertRaises(repack.RepackError) as ctx:
            repack.verify_incremental(
                installer,
                self.baseline,
                out,
                allowed=repack.allowed_paths(installer),
                expect_entry_sha=wrong,
            )
        self.assertIn(target, str(ctx.exception))


class RepackAtomicityTests(unittest.TestCase):
    """C1/C3：失败不产出、基线构建前后不变、临时名唯一（不撞历史残留）。"""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.desktop_dir = make_desktop_dir(self.root)
        self.baseline = self.root / "baseline.asar"
        make_baseline(self.baseline, patched_main=True)
        self.out = self.root / "out" / "app.asar"

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_failure_leaves_no_output_and_baseline_intact(self) -> None:
        before = repack.sha256_file(self.baseline)
        with self.assertRaises(repack.RepackError):
            repack.repack(
                self.baseline,
                self.out,
                expect_baseline_sha=before,
                desktop_dir=self.desktop_dir,
                expect_output_sha="0" * 64,
                allow_in_place=True,
            )
        self.assertFalse(self.out.exists(), "失败后不得留下产物")
        self.assertEqual(repack.sha256_file(self.baseline), before, "失败后基线必须原封不动")
        leftovers = list(self.out.parent.glob("*.repack-tmp")) if self.out.parent.exists() else []
        self.assertEqual(leftovers, [], "失败后不得残留临时文件")

    def test_stale_fixed_tmp_name_is_not_clobbered(self) -> None:
        """历史实现用固定名 ``<out>.repack-tmp``；残留文件不得被复用/覆盖。"""
        self.out.parent.mkdir(parents=True, exist_ok=True)
        stale = self.out.parent / (self.out.name + ".repack-tmp")
        stale.write_bytes(b"STALE-SENTINEL")

        report = repack.repack(
            self.baseline,
            self.out,
            expect_baseline_sha=repack.sha256_file(self.baseline),
            desktop_dir=self.desktop_dir,
            allow_in_place=True,
        )
        self.assertTrue(self.out.is_file())
        self.assertEqual(stale.read_bytes(), b"STALE-SENTINEL", "固定名残留必须保持原样")
        self.assertTrue(report["baseline_unchanged"])
        self.assertEqual(report["baseline_sha256_before"], report["baseline_sha256_after"])

    def test_baseline_mutated_during_build_refused(self) -> None:
        real = repack.build_patched_bytes

        def mutating(baseline, desktop_dir, **kwargs):
            data, note = real(baseline, desktop_dir, **kwargs)
            with open(baseline, "ab") as handle:
                handle.write(b"\x00tampered")
            return data, note

        from unittest import mock

        with mock.patch.object(repack, "build_patched_bytes", mutating):
            with self.assertRaises(repack.RepackError) as ctx:
                repack.repack(
                    self.baseline,
                    self.out,
                    expect_baseline_sha=repack.sha256_file(self.baseline),
                    desktop_dir=self.desktop_dir,
                    allow_in_place=True,
                )
        self.assertIn("基线在构建过程中被改动", str(ctx.exception))
        self.assertFalse(self.out.exists(), "基线被动过时不得产出")


if __name__ == "__main__":
    unittest.main()
