"""构建 3CT 自动版图形启动器（C# WinExe，双击无 cmd 窗口）。

只依赖 Windows 自带的 .NET Framework csc.exe 与 Python 标准库，不依赖 NuGet/npm。
不会重新打包 app.asar，也不修改主程序 3CT-Auto.exe。

用法：
    python desktop/install.py build          # 先有 3CT-Auto 副本（一次即可）
    python desktop/build_gui_launcher.py     # 再生成 GUI 启动器入口

产物：
    启动3CT自动版.exe                        # 仓库根，双击入口
    3CT-Auto/启动3CT自动版.exe               # 副本目录内的同名入口

也可以只构建到指定路径（测试用）：
    python desktop/build_gui_launcher.py --out <path> [--no-icon]
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DESKTOP_DIR = REPO_ROOT / "desktop"
SOURCE = DESKTOP_DIR / "GuiLauncher.cs"
ICON = REPO_ROOT / "3CT" / "resources" / "assets" / "icon.ico"
LAUNCHER_NAME = "启动3CT自动版.exe"
ROOT_EXE = REPO_ROOT / LAUNCHER_NAME
COPY_EXE = REPO_ROOT / "3CT-Auto" / LAUNCHER_NAME

CSC_CANDIDATES = (
    Path(r"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"),
    Path(r"C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe"),
    Path(r"C:\Windows\Microsoft.NET\Framework64\v3.5\csc.exe"),
    Path(r"C:\Windows\Microsoft.NET\Framework\v3.5\csc.exe"),
)


class BuildError(Exception):
    """启动器编译失败。"""


def find_csc() -> Path | None:
    """返回可用的 .NET Framework csc.exe；找不到返回 None。"""

    for candidate in CSC_CANDIDATES:
        if candidate.is_file():
            return candidate
    return None


def build_csharp(
    source: Path,
    out_exe: Path,
    *,
    target: str = "winexe",
    icon: Path | None = None,
    csc: Path | None = None,
) -> subprocess.CompletedProcess:
    """用 csc.exe 编译一个 C# 源文件；失败抛 :class:`BuildError`（附编译器输出）。"""

    csc = csc or find_csc()
    if csc is None:
        raise BuildError("找不到 .NET Framework csc.exe（需要 Windows 自带 .NET Framework 4.x）")
    source = Path(source).resolve()
    if not source.is_file():
        raise BuildError(f"C# 源文件不存在: {source}")
    out_exe = Path(out_exe).resolve()
    out_exe.parent.mkdir(parents=True, exist_ok=True)

    command = [
        str(csc),
        "/nologo",
        "/target:" + target,
        "/platform:anycpu",
        "/optimize+",
        "/utf8output",
        # WinForms 的 MessageBox / 图标等类型在 System.Windows.Forms.dll；
        # 不依赖 csc.rsp 的隐式引用，显式声明保证在干净环境下也能编译。
        "/reference:System.Windows.Forms.dll",
        "/reference:System.Drawing.dll",
        "/out:" + str(out_exe),
        str(source),
    ]
    if icon is not None:
        icon = Path(icon).resolve()
        if not icon.is_file():
            raise BuildError(f"图标文件不存在: {icon}")
        command.append("/win32icon:" + str(icon))

    completed = subprocess.run(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=180,
    )
    output = completed.stdout.decode("utf-8", "replace") if completed.stdout else ""
    if completed.returncode != 0:
        raise BuildError(
            "csc.exe 编译失败（exit=%d）:\n%s" % (completed.returncode, output.strip())
        )
    if not out_exe.is_file():
        raise BuildError(f"csc.exe 未生成目标文件: {out_exe}")
    completed_output = completed.stdout or b""
    return subprocess.CompletedProcess(command, completed.returncode, completed_output, b"")


def build_launcher(
    out_exe: Path,
    *,
    icon: Path | None = ICON,
    source: Path = SOURCE,
    csc: Path | None = None,
) -> subprocess.CompletedProcess:
    """编译 GUI 启动器（WinExe，无控制台）。"""

    return build_csharp(source, out_exe, target="winexe", icon=icon, csc=csc)


def sync_to_copy(root_exe: Path = ROOT_EXE, copy_dir: Path = REPO_ROOT / "3CT-Auto") -> Path:
    """把根入口复制到副本目录（installer 之外的一次性同步，不重打包 app.asar）。"""

    root_exe = Path(root_exe)
    copy_dir = Path(copy_dir)
    if not root_exe.is_file():
        raise BuildError(f"根启动器不存在: {root_exe}")
    copy_dir.mkdir(parents=True, exist_ok=True)
    target = copy_dir / root_exe.name
    shutil.copy2(root_exe, target)
    return target


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="构建 3CT 自动版 C# 图形启动器（WinExe）")
    parser.add_argument("--out", default=None, help=f"只构建到指定 exe（默认 {ROOT_EXE}）")
    parser.add_argument("--no-icon", action="store_true", help="不嵌入图标（测试/排错用）")
    parser.add_argument(
        "--no-sync",
        action="store_true",
        help="只构建根入口，不复制到 3CT-Auto 目录",
    )
    args = parser.parse_args(argv)

    icon = None if args.no_icon else ICON
    if icon is not None and not Path(icon).is_file():
        print(f"警告: 图标不存在，跳过图标: {icon}", file=sys.stderr)
        icon = None

    out_exe = Path(args.out) if args.out else ROOT_EXE
    try:
        completed = build_launcher(out_exe, icon=icon)
    except BuildError as exc:
        print(f"错误: {exc}", file=sys.stderr)
        return 1
    output = (completed.stdout or b"").decode("utf-8", "replace").strip()
    if output:
        print(output)
    print(f"已生成 GUI 启动器: {out_exe.resolve()}")
    if args.out is None and not args.no_sync:
        target = sync_to_copy(out_exe)
        print(f"已同步到副本目录: {target.resolve()}")
    print("提示：双击入口即可；首次使用请先确保 3CT-Auto 副本已 build。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
