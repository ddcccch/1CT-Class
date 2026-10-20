"""图形启动器（3CT自动版.exe / 启动3CT自动版.exe）的离线构建与行为测试。

目标：用户双击得到与原版一致的“无 cmd 窗口”入口。启动器是 C# WinExe：
- 直接 Process.Start 真实 3CT-Auto.exe（UseShellExecute=false / CreateNoWindow=true）；
- 仅对子进程清除 ELECTRON_RUN_AS_NODE / NODE_OPTIONS / NODE_PATH；
- 不调用 cmd/powershell/VBS，不改主程序 exe/asar；
- 副本已在运行时只激活已有窗口；原版运行时报错提示先退出（MessageBox）。

测试策略：
- PE 头校验 Subsystem=2（WINDOWS_GUI，双击无控制台）；
- 用 /target:exe 构建一个只读 env/argv 的 helper，放在临时目录冒充
  “3CT-Auto\3CT-Auto.exe”，由启动器真实 Process.Start 拉起，断言参数转发
  的 Windows 引号规则与子进程 env 已清理；
- --diagnose 模式只解析并写 JSON，不启动、不弹框，用于覆盖缺失 exe 等错误分支；
- 不执行任何真实用户业务、不读取用户 profile、不杀/重启正在运行的副本。
"""

from __future__ import annotations

import importlib.util
import json
import os
import shutil
import struct
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
BUILDER_PATH = REPO_ROOT / "desktop" / "build_gui_launcher.py"
LAUNCHER_SOURCE = REPO_ROOT / "desktop" / "GuiLauncher.cs"
ICON = REPO_ROOT / "3CT" / "resources" / "assets" / "icon.ico"
ROOT_EXE = REPO_ROOT / "启动3CT自动版.exe"
COPY_EXE = REPO_ROOT / "3CT-Auto" / "启动3CT自动版.exe"
IS_WINDOWS = os.name == "nt"

HELPER_SOURCE = r"""
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;

internal static class Helper
{
    private static string Esc(string value)
    {
        if (value == null) return "null";
        var sb = new StringBuilder("\"");
        foreach (char c in value)
        {
            if (c == '\\') sb.Append("\\\\");
            else if (c == '\"') sb.Append("\\\"");
            else if (c == '\n') sb.Append("\\n");
            else if (c == '\r') sb.Append("\\r");
            else if (c == '\t') sb.Append("\\t");
            else if (c < ' ') sb.Append("\\u").Append(((int)c).ToString("x4"));
            else sb.Append(c);
        }
        return sb.Append('"').ToString();
    }

    private static string EnvOrNull(string name)
    {
        string value = Environment.GetEnvironmentVariable(name);
        return value == null ? null : value;
    }

    private static int Main(string[] args)
    {
        string outPath = null;
        var forwarded = new List<string>();
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--out" && i + 1 < args.Length) { outPath = args[i + 1]; i++; continue; }
            forwarded.Add(args[i]);
        }
        if (outPath == null) return 3;
        var sb = new StringBuilder();
        sb.Append("{\"args\":[");
        for (int i = 0; i < forwarded.Count; i++)
        {
            if (i > 0) sb.Append(',');
            sb.Append(Esc(forwarded[i]));
        }
        sb.Append("],\"env\":{");
        string[] names = { "ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "NODE_PATH" };
        for (int i = 0; i < names.Length; i++)
        {
            if (i > 0) sb.Append(',');
            sb.Append(Esc(names[i])).Append(':').Append(Esc(EnvOrNull(names[i])));
        }
        sb.Append("},\"cwd\":").Append(Esc(Directory.GetCurrentDirectory())).Append('}');
        File.WriteAllText(outPath, sb.ToString(), new UTF8Encoding(false));
        return 0;
    }
}
"""


def load_builder():
    spec = importlib.util.spec_from_file_location("build_gui_launcher", BUILDER_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def csc_path():
    builder = load_builder()
    return builder.find_csc()


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


def original_3ct_running() -> bool:
    try:
        result = subprocess.run(
            ["tasklist", "/FI", "IMAGENAME eq 3CT.exe", "/NH"],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=15,
        )
        return b"3CT.exe" in result.stdout
    except (OSError, subprocess.SubprocessError):
        return False


class GuiLauncherSourceTests(unittest.TestCase):
    def test_source_and_builder_exist(self):
        self.assertTrue(LAUNCHER_SOURCE.is_file(), "缺少 desktop/GuiLauncher.cs")
        self.assertTrue(BUILDER_PATH.is_file(), "缺少 desktop/build_gui_launcher.py")

    @staticmethod
    def _strip_comments(text: str) -> str:
        lines = []
        for line in text.splitlines():
            stripped = line.split("//", 1)[0]
            lines.append(stripped)
        return "\n".join(lines)

    def test_launcher_does_not_call_shells(self):
        source = LAUNCHER_SOURCE.read_text(encoding="utf-8")
        code = self._strip_comments(source)
        # 只禁止真正调用 shell/脚本宿主或 shell 式启动，不禁 UseShellExecute 属性名。
        for forbidden in ("cmd.exe", "powershell", "pwsh", "cscript", "wscript", "runas"):
            self.assertNotIn(forbidden, code.lower(), f"启动器不应调用 {forbidden}")
        compact = code.replace(" ", "")
        self.assertNotIn("UseShellExecute=true", compact, "不得用 shell 方式启动")
        self.assertNotIn("ShellExecute(", code, "不得调用 ShellExecute 启动")
        self.assertIn("UseShellExecute = false", code)

    def test_launcher_clears_only_child_node_env(self):
        text = LAUNCHER_SOURCE.read_text(encoding="utf-8")
        self.assertIn("UseShellExecute = false", text)
        self.assertIn("CreateNoWindow = true", text)
        for variable in ("ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "NODE_PATH"):
            self.assertIn(variable, text)
        self.assertIn("EnvironmentVariables.Remove", text)
        # 不修改用户系统环境（不做 Environment.SetEnvironmentVariable 的进程级写入）
        self.assertNotIn("Environment.SetEnvironmentVariable", text)


@unittest.skipUnless(IS_WINDOWS, "需要 Windows + .NET Framework csc")
@unittest.skipUnless(csc_path() is not None, "缺少 csc.exe")
class GuiLauncherBuildTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = Path(self._tmp.name)
        self.builder = load_builder()

    def test_build_launcher_is_gui_subsystem(self):
        out = self.dir / "3CT自动版.exe"
        self.builder.build_launcher(out)

        self.assertTrue(out.is_file())
        self.assertEqual(pe_subsystem(out), 2, "启动器必须是 WINDOWS_GUI 子系统（无控制台）")

    def test_build_does_not_touch_asar_or_app_exe(self):
        asar = REPO_ROOT / "3CT-Auto" / "resources" / "app.asar"
        app_exe = REPO_ROOT / "3CT-Auto" / "3CT-Auto.exe"
        before = {
            "asar_hash": __import__("hashlib").sha256(asar.read_bytes()).hexdigest() if asar.is_file() else None,
            "exe_size": app_exe.stat().st_size if app_exe.is_file() else None,
        }

        self.builder.build_launcher(self.dir / "3CT自动版.exe")

        after = {
            "asar_hash": __import__("hashlib").sha256(asar.read_bytes()).hexdigest() if asar.is_file() else None,
            "exe_size": app_exe.stat().st_size if app_exe.is_file() else None,
        }
        self.assertEqual(before, after, "构建启动器不得修改 app.asar / 主程序 exe")

    def test_repo_launcher_artifacts_exist_and_are_gui(self):
        for exe in (ROOT_EXE, COPY_EXE):
            with self.subTest(path=str(exe)):
                self.assertTrue(exe.is_file(), f"缺少交付入口: {exe}")
                self.assertEqual(pe_subsystem(exe), 2)


@unittest.skipUnless(IS_WINDOWS, "需要 Windows + .NET Framework csc")
@unittest.skipUnless(csc_path() is not None, "缺少 csc.exe")
class GuiLauncherBehaviorTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = Path(self._tmp.name)
        self.builder = load_builder()
        self.launcher = self.dir / "launcher.exe"
        self.builder.build_launcher(self.launcher, icon=None)
        self.copy_dir = self.dir / "3CT-Auto"
        self.copy_dir.mkdir()
        self.helper = self.copy_dir / "3CT-Auto.exe"

    def build_helper(self) -> None:
        source = self.dir / "Helper.cs"
        source.write_text(HELPER_SOURCE, encoding="utf-8")
        self.builder.build_csharp(source, self.helper, target="exe", icon=None)

    def run_launcher(self, *args: str, env_extra: dict[str, str] | None = None):
        env = dict(os.environ)
        env.update(env_extra or {})
        return subprocess.run(
            [str(self.launcher), *args],
            cwd=self.dir,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=60,
        )

    def test_diagnose_missing_app_reports_without_launching_or_messagebox(self):
        out = self.dir / "diag.json"

        result = self.run_launcher("--diagnose", str(out), env_extra={"ELECTRON_RUN_AS_NODE": "1"})

        self.assertEqual(result.returncode, 0, result.stdout.decode("utf-8", "replace"))
        data = json.loads(out.read_text(encoding="utf-8"))
        self.assertFalse(data["exeExists"])
        self.assertEqual(data["forwardedArgs"], [])
        self.assertIn("ELECTRON_RUN_AS_NODE", data["envToClear"])
        self.assertTrue(data["argsCommandLine"] == "")

    def test_diagnose_resolves_copy_layout_and_args_with_quoting(self):
        self.build_helper()
        out = self.dir / "diag.json"
        forwarded = ["a b", 'c"d', "e\\", "f\\\\", "g h", ""]

        result = self.run_launcher("--diagnose", str(out), *forwarded)

        self.assertEqual(result.returncode, 0, result.stdout.decode("utf-8", "replace"))
        data = json.loads(out.read_text(encoding="utf-8"))
        self.assertTrue(data["exeExists"], data)
        self.assertEqual(Path(data["exe"]).resolve(), self.helper.resolve())
        self.assertEqual(data["forwardedArgs"], forwarded)
        self.assertTrue(data["argsCommandLine"])

    @unittest.skipIf(original_3ct_running(), "原版 3CT 正在运行，避免测试被前置检查拦截")
    def test_real_child_gets_forwarded_args_and_clean_env(self):
        self.build_helper()
        out_file = self.dir / "child.json"

        forwarded = ["arg with spaces", 'quote"inside', "back\\slash", ""]
        result = self.run_launcher(
            "--out",
            str(out_file),
            *forwarded,
            env_extra={
                "ELECTRON_RUN_AS_NODE": "1",
                "NODE_OPTIONS": "--inspect=0",
                "NODE_PATH": r"C:\evil\node_modules",
            },
        )

        self.assertEqual(result.returncode, 0, result.stdout.decode("utf-8", "replace"))
        child = json.loads(out_file.read_text(encoding="utf-8"))
        self.assertEqual(child["args"], forwarded)
        self.assertIsNone(child["env"]["ELECTRON_RUN_AS_NODE"])
        self.assertIsNone(child["env"]["NODE_OPTIONS"])
        self.assertIsNone(child["env"]["NODE_PATH"])

    @unittest.skipIf(original_3ct_running(), "原版 3CT 正在运行，避免测试被前置检查拦截")
    def test_child_working_directory_is_copy_dir(self):
        self.build_helper()
        out_file = self.dir / "cwd.json"

        self.run_launcher("--out", str(out_file))

        self.assertTrue(out_file.is_file(), "child 未写出报告")
        child = json.loads(out_file.read_text(encoding="utf-8"))
        self.assertEqual(Path(child["cwd"]).resolve(), self.copy_dir.resolve())

    @unittest.skipIf(original_3ct_running(), "原版 3CT 正在运行，避免测试被前置检查拦截")
    def test_launcher_inside_copy_dir_resolves_same_directory_exe(self):
        self.build_helper()
        copy_launcher = self.copy_dir / "launcher.exe"
        shutil.copy2(self.launcher, copy_launcher)
        out_file = self.dir / "same-dir.json"

        result = subprocess.run(
            [str(copy_launcher), "--out", str(out_file)],
            cwd=self.copy_dir,
            env=dict(os.environ),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=60,
        )

        self.assertEqual(result.returncode, 0, result.stdout.decode("utf-8", "replace"))
        child = json.loads(out_file.read_text(encoding="utf-8"))
        # helper 自身消费 --out <path>，其余转发参数为空
        self.assertEqual(child["args"], [])


if __name__ == "__main__":
    unittest.main()
