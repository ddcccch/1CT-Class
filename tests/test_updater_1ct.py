"""升级1CT.exe（单文件双击升级器）的构建契约、自动定位链与端到端行为测试。

用户诉求：「有没有那种双击就能升级的，而不是再解压覆盖目录感觉这样好麻烦」，
以及「只发一个 exe 给别人，双击就行吗？它会自动找到原来的 1CT 目录吗？」。
所以交付物是一个自带新版 ``app.asar`` 的 WinExe：双击 → 自动定位 1CT →
关 1CT → 备份 → 覆盖 → 重启。

定位链（本测试逐条覆盖）：
    S1 自身所在目录含 resources\\app.asar          → locate=self
    S2 自身目录下的 1CT\\                           → locate=sibling
    S3 日志线索（%APPDATA%\\1CT\\logs\\*.log）       → locate=logs
    S4 有界扫描（常见位置，限深限时）                → locate=scan
    S5 多候选 → 候选列表对话框（--silent 下退出码 6）
    S6 一个都没有 → 文件夹选择框（--silent 下退出码 3）
    --target 永远最高优先级                          → locate=arg

**隔离铁律**：测试只碰系统临时目录里伪造的 1CT 树，绝不读写真实的 ``1CT\\`` 与
``%APPDATA%\\1CT``（用户数据）。日志目录用 ``--log-dir`` 注入空目录/临时假日志，
扫描根用 ``--scan-root`` 注入临时目录，所以 S3/S4 永远不会看到本机的真实安装。

测试策略（全部真实执行，不 mock）：
- 用 ``build_updater_1ct.py --payload-asar <4KB 假 asar> --out <临时目录>`` 编一个
  小升级器（csc 真实编译，内嵌资源小 → 快）；
- 断言 PE 头 Subsystem=2（WINDOWS_GUI，双击无控制台窗口）；
- ``--dry-run`` 只输出计划、不改文件，且计划里有 ``locate=``；
- ``--silent --no-launch --no-kill --target <假 1CT>`` 成功：asar 被替换、备份可读、
  ``upgrade.log`` 含旧/新 sha256、``.1ct-install.json`` 的 patched_asar_sha256 更新；
- 再跑一次 → 退出码 2（已是最新）且文件未被改写；
- 目标非法 → 退出码 3 且不写任何文件；
- 只读 app.asar → 退出码 4（写失败）且内容仍是旧字节（Windows 上可稳定复现：
  File.Replace / File.Delete 对只读文件都抛 UnauthorizedAccessException）；
- 多候选 + ``--silent`` → 退出码 6（需要人工选择），一个都不动。

约定：测试**从不**触发 taskkill 分支（始终传 ``--no-kill``），避免误伤本机正在运行的
1CT；关闭进程的行为由 ``--dry-run`` 的计划输出与代码审查覆盖。
GUI 分支（S5 候选列表对话框、S6 文件夹选择框）**未**自动化，见报告里的「未覆盖边界」。

运行方式：
    python -m unittest tests.test_updater_1ct -v
    python -m unittest discover -s tests -p "test_updater_1ct.py"
"""

from __future__ import annotations

import hashlib
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
BUILDER_PATH = REPO_ROOT / "desktop" / "build_updater_1ct.py"
UPDATER_SOURCE = REPO_ROOT / "desktop" / "Updater1CT.cs"
EXE_NAME = "升级1CT.exe"
README_NAME = "升级说明.txt"
IS_WINDOWS = os.name == "nt"


def decode_output(raw: bytes) -> str:
    """C# WinExe / Python 子进程的 stdout 在中文 Windows 上可能是 GBK，也可能是 UTF-8。"""

    if not raw:
        return ""
    for encoding in ("utf-8", "gbk"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", "replace")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(Path(path).read_bytes())


def pe_subsystem(path: Path) -> int:
    """返回 PE 可选头的 Subsystem（2 = WINDOWS_GUI，双击不弹控制台）。"""

    data = Path(path).read_bytes()
    pe_offset = struct.unpack_from("<I", data, 0x3C)[0]
    if data[pe_offset : pe_offset + 4] != b"PE\0\0":
        raise AssertionError(f"不是合法 PE 文件: {path}")
    optional_header = pe_offset + 24
    return struct.unpack_from("<H", data, optional_header + 68)[0]


def make_marker(old_sha: str) -> str:
    """与真实 1CT\\.1ct-install.json 同形状（含嵌套对象），用于验证“只改一个字段”。"""

    return (
        "{\n"
        '  "generator": "tests/test_updater_1ct.py",\n'
        '  "brand": "1CT",\n'
        '  "source_asar_sha256": "' + ("a" * 64) + '",\n'
        '  "patched_asar_sha256": "' + old_sha + '",\n'
        '  "user_data_mode": "independent",\n'
        '  "exe_icon": "applied",\n'
        '  "patched_in_place": {\n'
        '    "at": "2026-10-23",\n'
        '    "backup": "resources/app.asar.bak"\n'
        "  }\n"
        "}\n"
    )


def electron_stack_line(install_root: Path, func: str = "setupAutoUpdate") -> str:
    """造一行和真实 main.log 同形状的 Electron 栈帧（指向 install_root 这个 1CT 树）。"""

    return (
        f"    at {func} ({install_root}\\resources\\app.asar\\dist\\main\\"
        f"webpack:\\3CT\\src\\main\\app\\updater.ts:234:15)\n"
    )


class UpdaterBuildTestCase(unittest.TestCase):
    """一个小升级器（4KB 假 payload）覆盖全部行为分支。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls.work = Path(tempfile.mkdtemp(prefix="updater-1ct-test-"))
        #: 几 KB 的假 asar：内容确定性生成，便于断言字节完全一致。
        cls.payload = bytes((index * 37 + 11) % 251 for index in range(4096))
        cls.payload_path = cls.work / "fake-app.asar"
        cls.payload_path.write_bytes(cls.payload)
        cls.payload_sha = sha256_bytes(cls.payload)
        cls.out_dir = cls.work / "out"
        cls.build = subprocess.run(
            [
                sys.executable,
                str(BUILDER_PATH),
                "--payload-asar",
                str(cls.payload_path),
                "--out",
                str(cls.out_dir),
                "--version-line",
                "1CT 测试构建 2026-10-24",
                "--force",
            ],
            cwd=str(REPO_ROOT),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=600,
        )
        cls.build_output = decode_output(cls.build.stdout or b"")
        cls.exe = cls.out_dir / EXE_NAME

    @classmethod
    def tearDownClass(cls) -> None:
        shutil.rmtree(cls.work, ignore_errors=True)

    # ---- 工具 ----------------------------------------------------------

    def require_build(self) -> None:
        if self.build.returncode != 0 or not self.exe.is_file():
            self.fail(
                "构建 升级1CT.exe 失败（exit=%s）:\n%s"
                % (self.build.returncode, self.build_output.strip())
            )

    def make_target(self, name: str, old_bytes: bytes = b"OLD-ASAR-CONTENT") -> Path:
        """在临时目录里造一个假 1CT 树：1CT.exe + resources\\app.asar + 标记。"""

        root = Path(tempfile.mkdtemp(prefix=name + "-", dir=str(self.work)))
        (root / "1CT.exe").write_bytes(b"MZ-fake-1ct-exe")
        resources = root / "resources"
        resources.mkdir()
        (resources / "app.asar").write_bytes(old_bytes)
        (root / ".1ct-install.json").write_text(
            make_marker(sha256_bytes(old_bytes)), encoding="utf-8"
        )
        return root

    def make_install_at(self, root: Path, old_bytes: bytes = b"OLD-ASAR-CONTENT") -> Path:
        """在**指定路径**造一个假 1CT 树（用于 S3/S4 的布局控制）。"""

        root = Path(root)
        (root / "resources").mkdir(parents=True, exist_ok=True)
        (root / "1CT.exe").write_bytes(b"MZ-fake-1ct-exe")
        (root / "resources" / "app.asar").write_bytes(old_bytes)
        (root / ".1ct-install.json").write_text(
            make_marker(sha256_bytes(old_bytes)), encoding="utf-8"
        )
        return root

    def make_log_dir(self, name: str, log_text: str) -> Path:
        """造一个**临时**日志目录（绝不指向真实 %APPDATA%\\1CT\\logs）。"""

        logs = Path(tempfile.mkdtemp(prefix=name + "-", dir=str(self.work)))
        (logs / "main.log").write_text(log_text, encoding="utf-8")
        return logs

    def empty_dir(self, name: str) -> Path:
        return Path(tempfile.mkdtemp(prefix=name + "-", dir=str(self.work)))

    def lonely_updater_dir(self, name: str) -> tuple[Path, Path]:
        """把升级器复制到一个**没有** 1CT 的临时目录，返回 (目录, exe 路径)。"""

        lonely = self.empty_dir(name)
        copied = lonely / EXE_NAME
        shutil.copy2(self.exe, copied)
        return lonely, copied

    def run_updater(self, *args: str, cwd: Path | None = None, exe: Path | None = None):
        self.require_build()
        completed = subprocess.run(
            [str(exe or self.exe), *args],
            cwd=str(cwd or self.work),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=180,
        )
        return completed.returncode, decode_output(completed.stdout or b"") + decode_output(
            completed.stderr or b""
        )

    # ---- 构建契约 ------------------------------------------------------

    def test_build_produces_single_file_exe_with_gui_subsystem(self) -> None:
        self.require_build()
        self.assertEqual(pe_subsystem(self.exe), 2, "必须是 WINDOWS_GUI 子系统（双击无控制台）")
        self.assertGreater(self.exe.stat().st_size, 0)
        readme = self.out_dir / README_NAME
        self.assertTrue(readme.is_file(), "必须同时产出 升级说明.txt")
        text = readme.read_text(encoding="utf-8")
        for keyword in ("双击", "备份", "app.asar", "%APPDATA%", "回滚"):
            self.assertIn(keyword, text)

    def test_build_reports_payload_sha256_matching_the_input_asar(self) -> None:
        self.require_build()
        self.assertIn(self.payload_sha, self.build_output, "构建输出必须打印内嵌 asar 的 sha256")
        self.assertIn(EXE_NAME, self.build_output)

    def test_build_without_force_refuses_to_overwrite_existing_package(self) -> None:
        self.require_build()
        again = subprocess.run(
            [
                sys.executable,
                str(BUILDER_PATH),
                "--payload-asar",
                str(self.payload_path),
                "--out",
                str(self.out_dir),
            ],
            cwd=str(REPO_ROOT),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=600,
        )
        self.assertNotEqual(again.returncode, 0, "已存在的产物需要 --force 才能覆盖")
        self.assertIn("--force", decode_output(again.stdout or b""))

    def test_readme_tells_the_recipient_the_updater_finds_1ct_by_itself(self) -> None:
        """说明文件必须改成「发给同学：放哪都行，程序自己找 1CT」。"""

        self.require_build()
        text = (self.out_dir / README_NAME).read_text(encoding="utf-8")
        for keyword in ("发给", "任意", "自己找", "日志", "扫描"):
            self.assertIn(keyword, text, "升级说明.txt 的「怎么用」必须写明自动查找：" + keyword)
        self.assertNotIn("把 升级1CT.exe 放进 1CT 目录（或它的上一层）", text)

    def test_build_self_check_covers_locate_with_no_scan_and_target(self) -> None:
        """构建自检除 --dry-run 外还要跑一条「定位自检」（--no-scan + --target）。"""

        self.require_build()
        self.assertIn("定位自检", self.build_output)

    # ---- 定位链 S1/S2（exe 旁 / 子目录） -------------------------------

    def test_dry_run_uses_its_own_directory_when_asar_is_beside_the_updater(self) -> None:
        self.require_build()
        target = self.make_target("discover-self", b"OLD-SELF")
        copied = target / EXE_NAME
        shutil.copy2(self.exe, copied)
        code, output = self.run_updater(
            "--dry-run",
            "--no-kill",
            "--log-dir",
            str(self.empty_dir("logs-self-empty")),
            cwd=target,
            exe=copied,
        )
        self.assertEqual(code, 0, output)
        self.assertIn("target=" + str(target), output)
        self.assertIn("locate=self", output, "S1 命中时计划里必须写 locate=self")

    def test_dry_run_prefers_the_sibling_1ct_directory(self) -> None:
        self.require_build()
        parent = self.empty_dir("discover-sibling")
        target = parent / "1CT"
        (target / "resources").mkdir(parents=True)
        (target / "1CT.exe").write_bytes(b"MZ-fake")
        (target / "resources" / "app.asar").write_bytes(b"OLD-SIBLING")
        copied = parent / EXE_NAME
        shutil.copy2(self.exe, copied)
        code, output = self.run_updater(
            "--dry-run",
            "--no-kill",
            "--log-dir",
            str(self.empty_dir("logs-sibling-empty")),
            cwd=parent,
            exe=copied,
        )
        self.assertEqual(code, 0, output)
        self.assertIn("target=" + str(target), output)
        self.assertIn("locate=sibling", output, "S2 命中时计划里必须写 locate=sibling")

    # ---- 定位优先级 ----------------------------------------------------

    def test_target_argument_beats_sibling_and_log_clues(self) -> None:
        """--target 最高优先级：同目录有 1CT、日志也指向别处，仍然用 --target。"""

        self.require_build()
        parent = self.empty_dir("arg-priority")
        sibling = parent / "1CT"
        (sibling / "resources").mkdir(parents=True)
        (sibling / "1CT.exe").write_bytes(b"MZ-sibling")
        (sibling / "resources" / "app.asar").write_bytes(b"OLD-SIBLING-KEEP")
        chosen = self.make_install_at(self.work / "arg-chosen" / "1CT", b"OLD-CHOSEN")
        logs = self.make_log_dir("logs-arg", electron_stack_line(sibling))

        copied = parent / EXE_NAME
        shutil.copy2(self.exe, copied)
        code, output = self.run_updater(
            "--silent",
            "--no-launch",
            "--no-kill",
            "--log-dir",
            str(logs),
            "--target",
            str(chosen),
            cwd=parent,
            exe=copied,
        )

        self.assertEqual(code, 0, output)
        self.assertIn("locate=arg", output)
        self.assertIn("target=" + str(chosen), output)
        self.assertEqual((chosen / "resources" / "app.asar").read_bytes(), self.payload)
        self.assertEqual(
            (sibling / "resources" / "app.asar").read_bytes(),
            b"OLD-SIBLING-KEEP",
            "S1/S2/S3 的候选都不许被 --target 覆盖时误改",
        )

    # ---- 定位链 S3（日志线索） -----------------------------------------

    def test_log_clue_locates_install_and_upgrades_it(self) -> None:
        """exe 放在没有 1CT 的目录里，靠 main.log 里的栈帧找到安装根并升级成功。"""

        self.require_build()
        tree = self.make_install_at(self.work / "s3tree" / "1CT", b"OLD-FROM-LOGS")
        logs = self.make_log_dir(
            "logs-s3",
            "[2026-10-23 18:45:44.843] [info] 启动\n"
            + electron_stack_line(tree)
            + electron_stack_line(tree, "bootstrap"),
        )
        lonely, copied = self.lonely_updater_dir("lonely-s3")

        code, output = self.run_updater(
            "--silent",
            "--no-launch",
            "--no-kill",
            "--log-dir",
            str(logs),
            "--scan-root",
            str(self.empty_dir("scan-s3-unused")),
            cwd=lonely,
            exe=copied,
        )

        self.assertEqual(code, 0, output)
        self.assertIn("locate=logs", output, "日志线索命中必须写 locate=logs")
        self.assertIn("target=" + str(tree), output)
        asar = tree / "resources" / "app.asar"
        self.assertEqual(asar.read_bytes(), self.payload, "S3 定位后必须完成升级")
        self.assertEqual(sha256_file(asar), self.payload_sha)
        backups = list((tree / ".backup").glob("*/app.asar"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_bytes(), b"OLD-FROM-LOGS")
        log_text = (backups[0].parent / "upgrade.log").read_text(encoding="utf-8")
        self.assertIn("定位", log_text, "upgrade.log 必须记录定位过程")
        self.assertIn("logs", log_text, "upgrade.log 必须记录命中的是日志线索")
        self.assertIn(str(tree), log_text)

    def test_log_clue_pointing_at_a_non_install_falls_through(self) -> None:
        """日志里的路径不合法（没有 1CT.exe / app.asar）→ 不算候选，继续往下走。"""

        self.require_build()
        bogus = self.empty_dir("s3-bogus") / "not-a-1ct"
        bogus.mkdir(parents=True, exist_ok=True)
        (bogus / "resources").mkdir(exist_ok=True)
        (bogus / "resources" / "app.asar").write_bytes(b"NOT-AN-INSTALL-NO-EXE")
        logs = self.make_log_dir("logs-s3-bogus", electron_stack_line(bogus))
        lonely, copied = self.lonely_updater_dir("lonely-s3-bogus")

        code, output = self.run_updater(
            "--silent",
            "--no-launch",
            "--no-kill",
            "--no-scan",
            "--log-dir",
            str(logs),
            cwd=lonely,
            exe=copied,
        )

        self.assertEqual(code, 3, output)
        self.assertIn("status=invalid-target", output)
        self.assertEqual(
            (bogus / "resources" / "app.asar").read_bytes(), b"NOT-AN-INSTALL-NO-EXE"
        )

    # ---- 定位链 S4（有界扫描） -----------------------------------------

    def test_scan_root_finds_the_unique_install_and_upgrades_it(self) -> None:
        self.require_build()
        scan_root = self.empty_dir("scan-root")
        tree = self.make_install_at(scan_root / "nested" / "1CT", b"OLD-FROM-SCAN")
        logs = self.empty_dir("logs-scan-empty")  # 空日志目录 → S3 必然未命中
        lonely, copied = self.lonely_updater_dir("lonely-scan")

        code, output = self.run_updater(
            "--silent",
            "--no-launch",
            "--no-kill",
            "--log-dir",
            str(logs),
            "--scan-root",
            str(scan_root),
            cwd=lonely,
            exe=copied,
        )

        self.assertEqual(code, 0, output)
        self.assertIn("locate=scan", output, "有界扫描命中必须写 locate=scan")
        self.assertIn("target=" + str(tree), output)
        self.assertEqual((tree / "resources" / "app.asar").read_bytes(), self.payload)
        backups = list((tree / ".backup").glob("*/app.asar"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_bytes(), b"OLD-FROM-SCAN")

    def test_scan_root_with_no_install_reports_invalid_target(self) -> None:
        self.require_build()
        scan_root = self.empty_dir("scan-empty")
        (scan_root / "just-a-folder").mkdir()
        lonely, copied = self.lonely_updater_dir("lonely-scan-empty")

        code, output = self.run_updater(
            "--silent",
            "--no-launch",
            "--no-kill",
            "--log-dir",
            str(self.empty_dir("logs-scan-none")),
            "--scan-root",
            str(scan_root),
            cwd=lonely,
            exe=copied,
        )

        self.assertEqual(code, 3, output)
        self.assertIn("status=invalid-target", output)

    # ---- 定位链 S5（多候选）/ S6（一个都没有） --------------------------

    def test_multiple_candidates_without_gui_exits_6_and_touches_nothing(self) -> None:
        """两个合法 1CT + --silent（无交互）→ 退出码 6，绝不静默挑一个。"""

        self.require_build()
        scan_root = self.empty_dir("scan-multi")
        first = self.make_install_at(scan_root / "alpha" / "1CT", b"OLD-ALPHA")
        second = self.make_install_at(scan_root / "beta" / "1CT", b"OLD-BETA")
        lonely, copied = self.lonely_updater_dir("lonely-multi")

        code, output = self.run_updater(
            "--silent",
            "--no-launch",
            "--no-kill",
            "--log-dir",
            str(self.empty_dir("logs-multi-empty")),
            "--scan-root",
            str(scan_root),
            cwd=lonely,
            exe=copied,
        )

        self.assertEqual(code, 6, "多候选且无法交互时必须用退出码 6 表达「需要人工选择」")
        self.assertIn("status=need-selection", output)
        self.assertIn("exit=6", output)
        self.assertEqual(output.count("candidate="), 2, output)
        self.assertIn(str(first), output)
        self.assertIn(str(second), output)
        for tree, old in ((first, b"OLD-ALPHA"), (second, b"OLD-BETA")):
            self.assertEqual((tree / "resources" / "app.asar").read_bytes(), old)
            self.assertFalse((tree / ".backup").exists(), "退出码 6 时不允许写任何文件")
            self.assertFalse((tree / "VERSION-1CT.txt").exists())

    def test_multiple_candidates_in_dry_run_also_exit_6(self) -> None:
        self.require_build()
        scan_root = self.empty_dir("scan-multi-dry")
        self.make_install_at(scan_root / "a" / "1CT", b"OLD-A")
        self.make_install_at(scan_root / "b" / "1CT", b"OLD-B")
        lonely, copied = self.lonely_updater_dir("lonely-multi-dry")

        code, output = self.run_updater(
            "--dry-run",
            "--log-dir",
            str(self.empty_dir("logs-multi-dry-empty")),
            "--scan-root",
            str(scan_root),
            cwd=lonely,
            exe=copied,
        )

        self.assertEqual(code, 6, output)
        self.assertEqual(output.count("candidate="), 2, output)

    def test_silent_run_without_discoverable_target_exits_3(self) -> None:
        self.require_build()
        lonely, copied = self.lonely_updater_dir("discover-none")
        code, output = self.run_updater(
            "--silent",
            "--no-kill",
            "--no-scan",
            "--log-dir",
            str(self.empty_dir("logs-none-empty")),
            cwd=lonely,
            exe=copied,
        )
        self.assertEqual(code, 3, output)
        self.assertIn("status=invalid-target", output)

    def test_no_scan_with_empty_roots_exits_3_and_writes_nothing(self) -> None:
        """--no-scan + 空目录 + --silent → 退出码 3，且目标目录一个文件都不多。"""

        self.require_build()
        lonely, copied = self.lonely_updater_dir("discover-none-noscan")
        scan_root = self.empty_dir("scan-ignored")
        before_lonely = sorted(path.name for path in lonely.iterdir())
        before_scan = sorted(path.name for path in scan_root.iterdir())

        code, output = self.run_updater(
            "--silent",
            "--no-launch",
            "--no-kill",
            "--no-scan",
            "--log-dir",
            str(self.empty_dir("logs-noscan-empty")),
            "--scan-root",
            str(scan_root),
            cwd=lonely,
            exe=copied,
        )

        self.assertEqual(code, 3, output)
        self.assertIn("status=invalid-target", output)
        self.assertEqual(sorted(path.name for path in lonely.iterdir()), before_lonely)
        self.assertEqual(sorted(path.name for path in scan_root.iterdir()), before_scan)
        self.assertFalse((lonely / ".backup").exists())
        self.assertFalse((scan_root / "1CT").exists())

    # ---- 端到端升级 ----------------------------------------------------

    def test_dry_run_prints_plan_and_changes_nothing(self) -> None:
        old = b"OLD-DRY-RUN"
        target = self.make_target("dry-run", old)
        asar = target / "resources" / "app.asar"
        before = asar.read_bytes()

        code, output = self.run_updater("--dry-run", "--target", str(target))

        self.assertEqual(code, 0, output)
        self.assertIn("UPGRADE-PLAN", output)
        self.assertIn("locate=arg", output)
        self.assertIn("old_sha256=" + sha256_bytes(old), output)
        self.assertIn("new_sha256=" + self.payload_sha, output)
        self.assertIn("already_latest=no", output)
        self.assertIn("backup_dir=", output)
        self.assertEqual(asar.read_bytes(), before, "--dry-run 不允许改动目标 asar")
        self.assertFalse((target / ".backup").exists(), "--dry-run 不允许创建备份目录")
        self.assertFalse((target / "VERSION-1CT.txt").exists(), "--dry-run 不允许写版本文件")

    def test_silent_upgrade_replaces_asar_backs_up_and_updates_marker(self) -> None:
        old = b"OLD-BYTES-TO-BE-REPLACED" * 8
        target = self.make_target("upgrade", old)
        asar = target / "resources" / "app.asar"
        old_sha = sha256_bytes(old)

        code, output = self.run_updater(
            "--silent", "--no-launch", "--no-kill", "--target", str(target)
        )

        self.assertEqual(code, 0, output)
        self.assertEqual(asar.read_bytes(), self.payload, "目标 asar 必须等于内嵌 payload")
        self.assertEqual(sha256_file(asar), self.payload_sha)

        backups = list((target / ".backup").glob("*/app.asar"))
        self.assertEqual(len(backups), 1, "必须留下恰好一份备份")
        self.assertEqual(backups[0].read_bytes(), old, "备份必须是升级前的旧字节")

        log_path = backups[0].parent / "upgrade.log"
        self.assertTrue(log_path.is_file(), "备份目录里必须有 upgrade.log")
        log_text = log_path.read_text(encoding="utf-8")
        self.assertIn(old_sha, log_text, "日志必须记录旧 sha256")
        self.assertIn(self.payload_sha, log_text, "日志必须记录新 sha256")
        self.assertIn(str(len(self.payload)), log_text, "日志必须记录字节数")

        marker = json.loads((target / ".1ct-install.json").read_text(encoding="utf-8"))
        self.assertEqual(marker["patched_asar_sha256"], self.payload_sha)
        self.assertEqual(marker["patched_by"], "升级1CT.exe")
        self.assertEqual(marker["brand"], "1CT", "其它字段必须原样保留")
        self.assertEqual(marker["patched_in_place"]["backup"], "resources/app.asar.bak")

        version = (target / "VERSION-1CT.txt").read_text(encoding="utf-8")
        self.assertIn("1CT 测试构建 2026-10-24", version)

    def test_second_silent_run_reports_already_latest_and_touches_nothing(self) -> None:
        target = self.make_target("latest", b"OLD-FOR-LATEST")
        args = ("--silent", "--no-launch", "--no-kill", "--target", str(target))
        first_code, first_output = self.run_updater(*args)
        self.assertEqual(first_code, 0, first_output)

        asar = target / "resources" / "app.asar"
        before_bytes = asar.read_bytes()
        before_mtime = asar.stat().st_mtime_ns
        backups_before = len(list((target / ".backup").glob("*")))

        second_code, second_output = self.run_updater(*args)

        self.assertEqual(second_code, 2, "已经是最新版本时 --silent 用退出码 2 表达")
        self.assertIn("status=already-latest", second_output)
        self.assertEqual(asar.read_bytes(), before_bytes)
        self.assertEqual(asar.stat().st_mtime_ns, before_mtime, "已是最新时不得重写文件")
        self.assertEqual(len(list((target / ".backup").glob("*"))), backups_before)

    def test_invalid_target_exits_3_and_writes_nothing(self) -> None:
        root = Path(tempfile.mkdtemp(prefix="invalid-", dir=str(self.work)))
        (root / "resources").mkdir()
        (root / "resources" / "app.asar").write_bytes(b"OLD-NO-EXE")
        before = sorted(path.name for path in root.iterdir())

        code, output = self.run_updater(
            "--silent", "--no-launch", "--no-kill", "--target", str(root)
        )

        self.assertEqual(code, 3, output)
        self.assertIn("status=invalid-target", output)
        self.assertEqual(sorted(path.name for path in root.iterdir()), before)
        self.assertFalse((root / ".backup").exists())
        self.assertFalse((root / "VERSION-1CT.txt").exists())
        self.assertEqual((root / "resources" / "app.asar").read_bytes(), b"OLD-NO-EXE")

    def test_readonly_asar_makes_write_fail_with_exit_4_and_keeps_old_content(self) -> None:
        old = b"OLD-READONLY-CONTENT"
        target = self.make_target("readonly", old)
        asar = target / "resources" / "app.asar"
        os.chmod(asar, 0o444)
        try:
            code, output = self.run_updater(
                "--silent", "--no-launch", "--no-kill", "--target", str(target)
            )
            self.assertEqual(code, 4, output)
            self.assertIn("status=", output)
            self.assertIn("write-failed", output)
            self.assertEqual(asar.read_bytes(), old, "写失败后必须仍是旧内容（未破坏安装）")
            backups = list((target / ".backup").glob("*/app.asar"))
            self.assertEqual(len(backups), 1, "写失败前也应先留下备份")
            self.assertEqual(backups[0].read_bytes(), old)
        finally:
            os.chmod(asar, 0o666)

    def test_upgrade_log_records_steps_in_backup_directory(self) -> None:
        target = self.make_target("log-steps", b"OLD-LOG-STEPS")
        code, output = self.run_updater(
            "--silent", "--no-launch", "--no-kill", "--target", str(target)
        )
        self.assertEqual(code, 0, output)
        logs = list((target / ".backup").glob("*/upgrade.log"))
        self.assertEqual(len(logs), 1)
        text = logs[0].read_text(encoding="utf-8")
        for step in ("目标目录", "备份", "替换", "校验", "结果"):
            self.assertIn(step, text, "upgrade.log 必须写清步骤：" + step)


class PayloadIntegrityTests(unittest.TestCase):
    """内嵌 payload 的自洽性：payload.json 声明的 sha 与内嵌字节不一致 = 坏包/串包。

    为什么要测：升级器是「双击就把用户程序换掉」的写操作，一旦把错的 asar 覆盖进去，
    用户看到的是「升级成功但功能没变/更糟」，而日志里只有一行警告，事后极难发现。
    所以声明与字节不一致时必须**硬失败、不写盘**。
    """

    @classmethod
    def setUpClass(cls) -> None:
        sys.path.insert(0, str(REPO_ROOT / "desktop"))
        import build_updater_1ct as builder  # noqa: E402  （只在测试内导入，避免污染 sys.path）

        cls.builder = builder
        cls.work = Path(tempfile.mkdtemp(prefix="updater-1ct-badpayload-"))
        cls.payload = bytes((index * 53 + 7) % 251 for index in range(4096))
        cls.payload_path = cls.work / "fake-app.asar"
        cls.payload_path.write_bytes(cls.payload)
        cls.payload_sha = sha256_bytes(cls.payload)

        # 故意把声明写成另一个 sha（模拟「payload.json 与 asar 不同源」的串包/坏包）。
        cls.declared_wrong = "f" * 64
        payload_json = cls.work / "payload.json"
        payload_json.write_text(
            json.dumps(
                {
                    "target": "1CT",
                    "versionLine": "1CT 坏包测试",
                    "asarSha256": cls.declared_wrong,
                    "asarSize": len(cls.payload),
                    "builtAt": "2026-10-31T00:00:00",
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        cls.exe = cls.work / ("bad-" + EXE_NAME)
        builder.compile_updater(
            UPDATER_SOURCE,
            cls.exe,
            payload_json=payload_json,
            payload_asar=cls.payload_path,
            icon=None,
        )

    @classmethod
    def tearDownClass(cls) -> None:
        shutil.rmtree(cls.work, ignore_errors=True)

    def make_target(self, name: str, old_bytes: bytes = b"OLD-ASAR-CONTENT") -> Path:
        root = Path(tempfile.mkdtemp(prefix=name + "-", dir=str(self.work)))
        (root / "1CT.exe").write_bytes(b"MZ-fake-1ct-exe")
        resources = root / "resources"
        resources.mkdir()
        (resources / "app.asar").write_bytes(old_bytes)
        (root / ".1ct-install.json").write_text(
            make_marker(sha256_bytes(old_bytes)), encoding="utf-8"
        )
        return root

    def test_declared_sha_mismatch_refuses_to_upgrade(self) -> None:
        target = self.make_target("bad-sha")
        before = (target / "resources" / "app.asar").read_bytes()

        completed = subprocess.run(
            [
                str(self.exe),
                "--silent",
                "--no-launch",
                "--no-kill",
                "--target",
                str(target),
            ],
            cwd=str(self.work),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=180,
        )
        output = decode_output(completed.stdout or b"") + decode_output(
            completed.stderr or b""
        )
        self.assertNotEqual(
            completed.returncode,
            0,
            "声明 sha 与内嵌字节不一致时必须失败，不能继续升级；实际输出：" + output,
        )
        self.assertEqual(
            completed.returncode,
            3,
            "坏包应按「目标不合法/包损坏」退出（3），便于脚本判断；实际输出：" + output,
        )
        self.assertEqual(
            (target / "resources" / "app.asar").read_bytes(),
            before,
            "坏包绝不能改动目标 app.asar",
        )
        self.assertFalse(
            (target / ".backup").exists(),
            "坏包在写盘前就该停下，不应该产生备份目录",
        )
        # --silent 下对话框文案不出现在 stdout，所以按「状态标记 + 两个 sha」断言可诊断性。
        self.assertIn("payload-mismatch", output, "必须给出 payload 校验失败的状态标记")
        self.assertIn(self.declared_wrong, output, "必须打印声明 sha，便于判断是不是坏包")
        self.assertIn(self.payload_sha, output, "必须打印实际 sha，便于和发布记录对照")


if __name__ == "__main__":
    unittest.main(verbosity=2)
