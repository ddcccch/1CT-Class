"""启动器（start-3ct-auto.cmd）的离线行为测试。

真实用户双击窗口一闪即退，根因（真实 cmd 复现）：
1. 脚本曾是 UTF-8（无 BOM）+ LF 行尾。cmd 默认代码页 936（GBK）下，UTF-8 中文
   被按两字节配对解码，会吞掉换行/引号等 ASCII，导致 if 块被破坏、中文整行被
   当命令执行（stderr: `'PP' is not recognized`、中文残片 `is not recognized`）；
2. 用户环境存在 ELECTRON_RUN_AS_NODE=1 / NODE_OPTIONS / NODE_PATH，被 exe 继承后
   Electron 以 Node 模式运行，直接 `bad option` 退出（隔离 profile headless 复现：
   exit=9 `bad option: --scheduler-run-task`；清除后正常进入 headless 分支）。

本测试守护：
- 三个 launcher 必须是纯 ASCII + CRLF + 无 BOM，且 .gitattributes 固定 eol=crlf；
- 必须在 setlocal 内清除 ELECTRON_RUN_AS_NODE / NODE_OPTIONS / NODE_PATH（仅子进程）；
- 真实 cmd 行为：dry-run 钩子能解析 APP 路径、清理后的 env 为空、输出不含
  “is not recognized” 解析错误；缺 exe 时给出可读错误并非 0 退出（不闪退/不卡死）；
- 进程检查用 fake findstr 注入 fixture 覆盖：原版正在运行 → 提示先退出且不杀进程；
  副本已在运行 → 不重复启动；
- 支持普通参数 %* 透传（供隔离 profile 的真实入口验证），双击无参行为不变；
- mutation 回归：临时副本删掉 env 清理后，本测试必须能抓住（输出出现污染值）。
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
LAUNCHERS = [
    REPO_ROOT / "start-3ct-auto.cmd",
    REPO_ROOT / "desktop" / "start-3ct-auto.cmd",
    REPO_ROOT / "3CT-Auto" / "start-3ct-auto.cmd",
]
GITATTRIBUTES = REPO_ROOT / ".gitattributes"
DRY_RUN_ENV = "AUTO3CT_LAUNCHER_DRY_RUN"
IS_WINDOWS = os.name == "nt"


def run_cmd(args: list[str], cwd: Path, env_extra: dict[str, str], timeout: int = 30):
    env = dict(os.environ)
    env.update(env_extra)
    return subprocess.run(
        ["cmd", "/d", "/c", *args],
        cwd=cwd,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=timeout,
    )


def decode_console(data: bytes) -> str:
    """按 Windows 控制台 ANSI 代码页解码（实际路径可能含中文用户名）。"""

    for encoding in ("mbcs", "cp936", "utf-8"):
        try:
            return data.decode(encoding)
        except (LookupError, UnicodeDecodeError):
            continue
    return data.decode("utf-8", "replace")


class LauncherEncodingTests(unittest.TestCase):
    def test_all_launchers_exist(self):
        for path in LAUNCHERS:
            with self.subTest(path=str(path)):
                self.assertTrue(path.is_file(), f"缺少启动器: {path}")

    def test_launchers_are_pure_ascii(self):
        for path in LAUNCHERS:
            with self.subTest(path=path.name):
                data = path.read_bytes()
                non_ascii = [b for b in data if b > 0x7F]
                self.assertEqual(
                    non_ascii,
                    [],
                    f"{path} 含非 ASCII 字节 {non_ascii[:8]}；cmd 默认代码页会错误解析",
                )

    def test_launchers_use_crlf_and_no_bom(self):
        for path in LAUNCHERS:
            with self.subTest(path=path.name):
                data = path.read_bytes()
                self.assertFalse(data.startswith(b"\xef\xbb\xbf"), f"{path} 不应带 BOM")
                stripped = data.replace(b"\r\n", b"")
                self.assertNotIn(b"\n", stripped, f"{path} 存在 LF-only 行尾（cmd 需 CRLF）")
                self.assertNotIn(b"\r", stripped, f"{path} 存在孤立 CR")
                self.assertGreaterEqual(data.count(b"\r\n"), 10)

    def test_gitattributes_pins_launcher_crlf(self):
        self.assertTrue(GITATTRIBUTES.is_file(), "缺少 .gitattributes")
        text = GITATTRIBUTES.read_text(encoding="utf-8-sig")
        self.assertIn("start-3ct-auto.cmd text eol=crlf", text)
        self.assertIn("desktop/start-3ct-auto.cmd text eol=crlf", text)
        # 仅按 launcher 路径固定，不做全局 text=auto
        for line in text.splitlines():
            stripped = line.strip()
            self.assertNotEqual(stripped, "* text=auto")
            self.assertFalse(stripped.startswith("* "), "不要全局修改换行策略")

    def test_launchers_clear_electron_node_mode_env_inside_setlocal(self):
        for path in LAUNCHERS:
            with self.subTest(path=path.name):
                text = path.read_text(encoding="ascii")
                lowered = text.lower()
                self.assertIn("setlocal", lowered)
                setlocal_at = lowered.index("setlocal")
                for variable in ("ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "NODE_PATH"):
                    needle = f'set "{variable}="'.lower()
                    self.assertIn(needle, lowered, f"{path} 缺少 {variable} 清理")
                    self.assertGreater(
                        lowered.index(needle), setlocal_at, f"{path} 清理必须在 setlocal 之后"
                    )

    def test_launchers_never_kill_original_process(self):
        for path in LAUNCHERS:
            with self.subTest(path=path.name):
                text = path.read_text(encoding="ascii").lower()
                for forbidden in ("taskkill", "stop-process", "wmic process"):
                    self.assertNotIn(forbidden, text, f"{path} 不应包含 {forbidden}")

    def test_launchers_keep_process_guards_and_forward_arguments(self):
        for path in LAUNCHERS:
            with self.subTest(path=path.name):
                text = path.read_text(encoding="ascii")
                self.assertIn('tasklist /FI "IMAGENAME eq 3CT.exe"', text)
                self.assertIn('tasklist /FI "IMAGENAME eq 3CT-Auto.exe"', text)
                self.assertIn("findstr /I /C:", text)
                self.assertNotIn("| find /I", text)
                self.assertIn('start "" "%APP%" %*', text)

    def test_dry_run_hook_is_after_process_checks(self):
        """dry-run 只用于测试 path/env，不得绕过缺失 exe / 进程检查。"""

        for path in LAUNCHERS:
            with self.subTest(path=path.name):
                text = path.read_text(encoding="ascii")
                self.assertIn("AUTO3CT_LAUNCHER_DRY_RUN", text)
                dry_at = text.index("AUTO3CT_LAUNCHER_DRY_RUN")
                self.assertGreater(dry_at, text.index('tasklist /FI "IMAGENAME eq 3CT.exe"'))
                self.assertGreater(dry_at, text.index('tasklist /FI "IMAGENAME eq 3CT-Auto.exe"'))
                self.assertLess(dry_at, text.index('start "" "%APP%" %*'))

    def test_three_launchers_are_identical(self):
        contents = {path.read_bytes() for path in LAUNCHERS}
        self.assertEqual(len(contents), 1, "根/desktop/副本 三个 launcher 必须完全一致")


@unittest.skipUnless(IS_WINDOWS, "需要 Windows cmd")
class LauncherBehaviorTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = Path(self._tmp.name)
        self.script = self.dir / "start-3ct-auto.cmd"
        shutil.copy2(LAUNCHERS[0], self.script)
        self.fake_app = self.dir / "3CT-Auto" / "3CT-Auto.exe"
        self.fake_bin = self.dir / "fake-bin"
        self.fake_bin.mkdir()
        self._install_fake_findstr()

    # ---- fixtures -----------------------------------------------------
    def _install_fake_findstr(self) -> None:
        """注入 fake findstr：按 FAKE_PROCESS_MATCH 模拟 tasklist 命中，避免依赖真实进程。"""

        script = self.fake_bin / "findstr.cmd"
        script.write_bytes(
            b"@echo off\r\n"
            b"setlocal EnableDelayedExpansion\r\n"
            b"set \"MATCH=%FAKE_PROCESS_MATCH%\"\r\n"
            b"if \"%MATCH%\"==\"\" exit /b 1\r\n"
            b"set \"ALL=%*\"\r\n"
            b"if not \"!ALL:%MATCH%=!\"==\"!ALL!\" exit /b 0\r\n"
            b"exit /b 1\r\n"
        )

    def make_fake_app(self) -> None:
        self.fake_app.parent.mkdir(parents=True, exist_ok=True)
        self.fake_app.write_bytes(b"fake-exe-not-executed")

    def env_extra(self, process_match: str = "", **overrides) -> dict[str, str]:
        env = {
            DRY_RUN_ENV: "1",
            "FAKE_PROCESS_MATCH": process_match,
            "PATH": str(self.fake_bin) + os.pathsep + os.environ.get("PATH", ""),
        }
        env.update(overrides)
        return env

    # ---- tests --------------------------------------------------------
    def test_dry_run_resolves_app_path(self):
        self.make_fake_app()

        result = run_cmd([str(self.script)], self.dir, self.env_extra())

        output = decode_console(result.stdout)
        self.assertEqual(result.returncode, 0, output)
        # cmd 输出路径编码取决于当前控制台代码页；用 UTF-8 / GBK 两种编码分别尝试
        candidates = [str(self.fake_app).encode(enc) for enc in ("utf-8", "mbcs")]
        self.assertTrue(
            any(candidate in result.stdout for candidate in candidates),
            f"APP 路径未出现在 dry-run 输出中: {result.stdout[:400]!r}",
        )
        self.assertIn("[dry-run]", output)

    def test_dry_run_proves_polluted_env_is_cleared_for_child(self):
        self.make_fake_app()

        result = run_cmd(
            [str(self.script)],
            self.dir,
            self.env_extra(
                ELECTRON_RUN_AS_NODE="1",
                NODE_OPTIONS="--inspect=0",
                NODE_PATH=r"C:\evil\node_modules",
            ),
        )

        output = decode_console(result.stdout)
        self.assertEqual(result.returncode, 0, output)
        self.assertIn("ELECTRON_RUN_AS_NODE=[]", output)
        self.assertIn("NODE_OPTIONS=[]", output)
        self.assertIn("NODE_PATH=[]", output)

    def test_real_cmd_parses_without_command_not_recognized_errors(self):
        self.make_fake_app()

        for polluted in (
            {"ELECTRON_RUN_AS_NODE": "1"},
            {"ELECTRON_RUN_AS_NODE": "1", "NODE_OPTIONS": "--inspect=0"},
        ):
            with self.subTest(polluted=polluted):
                result = run_cmd([str(self.script)], self.dir, self.env_extra(**polluted))
                output = decode_console(result.stdout)
                self.assertEqual(result.returncode, 0, output)
                for marker in ("is not recognized", "未被识别", "不是内部或外部命令"):
                    self.assertNotIn(marker, output)

    def test_missing_app_prints_readable_error_and_exits_nonzero(self):
        result = run_cmd([str(self.script)], self.dir, self.env_extra(), timeout=20)

        output = decode_console(result.stdout)
        self.assertNotEqual(result.returncode, 0, output)
        self.assertIn("Cannot find 3CT-Auto.exe", output)
        self.assertIn("install.py build", output)
        self.assertNotIn("is not recognized", output)

    def test_missing_app_without_dry_run_does_not_hang_or_flash(self):
        result = run_cmd(
            [str(self.script)],
            self.dir,
            {**self.env_extra(ELECTRON_RUN_AS_NODE="1"), DRY_RUN_ENV: ""},
            timeout=20,
        )

        output = decode_console(result.stdout)
        self.assertNotEqual(result.returncode, 0, output)
        self.assertIn("Cannot find 3CT-Auto.exe", output)
        self.assertNotIn("is not recognized", output)

    def test_original_3ct_running_is_reported_and_not_killed(self):
        self.make_fake_app()

        result = run_cmd(
            [str(self.script)], self.dir, self.env_extra(process_match="3CT.exe"), timeout=20
        )

        output = decode_console(result.stdout)
        self.assertEqual(result.returncode, 1, output)
        self.assertIn("The original 3CT is running", output)
        self.assertIn("never kills or modifies the original 3CT", output)
        self.assertNotIn("[dry-run]", output)
        self.assertNotIn("is not recognized", output)

    def test_copy_already_running_is_not_started_again(self):
        self.make_fake_app()

        result = run_cmd(
            [str(self.script)], self.dir, self.env_extra(process_match="3CT-Auto.exe"), timeout=20
        )

        output = decode_console(result.stdout)
        self.assertEqual(result.returncode, 0, output)
        self.assertIn("already running", output)
        self.assertNotIn("[dry-run]", output)
        self.assertNotIn("is not recognized", output)

    def test_app_is_launched_only_after_all_checks_with_forwarded_args(self):
        """无 dry-run 且检查通过时才会走到 start；此处只验证脚本包含 %* 转发。

        真实 GUI 启动由 lead 用隔离 profile 手动验证，测试不启动真实 user profile。
        """

        text = LAUNCHERS[0].read_text(encoding="ascii")
        start_line = next(
            line for line in text.splitlines() if line.strip().startswith('start ""')
        )
        self.assertEqual(start_line.strip(), 'start "" "%APP%" %*')

    # ---- mutation 回归（不动共享原文件） ----
    def test_removing_env_clear_is_caught_by_behavior_test(self):
        self.make_fake_app()
        original = LAUNCHERS[0].read_bytes()

        mutated = original
        for line in (
            b'set "ELECTRON_RUN_AS_NODE="\r\n',
            b'set "NODE_OPTIONS="\r\n',
            b'set "NODE_PATH="\r\n',
        ):
            self.assertIn(line, mutated)
            mutated = mutated.replace(line, b"")
        mutated_script = self.dir / "mutated.cmd"
        mutated_script.write_bytes(mutated)

        broken = run_cmd(
            [str(mutated_script)],
            self.dir,
            self.env_extra(ELECTRON_RUN_AS_NODE="1"),
        )
        broken_output = decode_console(broken.stdout)
        self.assertIn(
            "ELECTRON_RUN_AS_NODE=[1]",
            broken_output,
            "mutation 后应能观察到 env 未被清理（证明现有测试能抓住该回归）",
        )

        fixed = run_cmd(
            [str(self.script)],
            self.dir,
            self.env_extra(ELECTRON_RUN_AS_NODE="1"),
        )
        fixed_output = decode_console(fixed.stdout)
        self.assertIn("ELECTRON_RUN_AS_NODE=[]", fixed_output)


if __name__ == "__main__":
    unittest.main()
