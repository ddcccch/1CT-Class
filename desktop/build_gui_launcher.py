"""构建图形启动器（C# WinExe，双击无 cmd 窗口）—— 同时支持 3CT 自动版与 1CT。

只依赖 Windows 自带的 .NET Framework csc.exe 与 Python 标准库，不依赖 NuGet/npm。
不会重新打包 app.asar，也不修改主程序 exe。

两个品牌
--------
===========  ==========================  =====================  ============
brand        源码                         产物                   目标程序
===========  ==========================  =====================  ============
``3ct``      ``desktop/GuiLauncher.cs``  ``启动3CT自动版.exe``  ``3CT-Auto\\3CT-Auto.exe``
``1ct``      ``desktop/GuiLauncher1CT.cs`` ``启动1CT.exe``      ``1CT\\1CT.exe``
===========  ==========================  =====================  ============

1CT 启动器额外做进程检测：原版 3CT 或 3CT 自动版正在运行时提示先退出（三者共享
同一 userData 与单实例锁），绝不 kill 已有进程。

用法：
    python desktop/install.py build              # 先有 3CT-Auto 副本（一次即可）
    python desktop/install_1ct.py build          # 先有 1CT 副本（一次即可）
    python desktop/build_gui_launcher.py         # 默认只刷新 3CT 自动版入口（历史行为）
    python desktop/build_gui_launcher.py --brand 1ct     # 只刷新 1CT 入口
    python desktop/build_gui_launcher.py --brand all     # 两个品牌都刷新
    python desktop/build_gui_launcher.py --brand 3ct --no-sync

也可以只构建到指定路径（测试用）：
    python desktop/build_gui_launcher.py --out <path> [--brand 1ct] [--no-icon]
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

#: 3CT 自动版（历史行为，默认 brand，保持既有调用方/测试不变）。
LAUNCHER_NAME = "启动3CT自动版.exe"
ROOT_EXE = REPO_ROOT / LAUNCHER_NAME
COPY_DIR = REPO_ROOT / "3CT-Auto"
COPY_EXE = COPY_DIR / LAUNCHER_NAME

#: 1CT。
ONECT_LAUNCHER_NAME = "启动1CT.exe"
ONECT_SOURCE = DESKTOP_DIR / "GuiLauncher1CT.cs"
ONECT_ROOT_EXE = REPO_ROOT / ONECT_LAUNCHER_NAME
ONECT_COPY_DIR = REPO_ROOT / "1CT"
ONECT_COPY_EXE = ONECT_COPY_DIR / ONECT_LAUNCHER_NAME
#: 1CT 自己的图标（不再用 3CT 的 resources/assets/icon.ico）。
ONECT_ICON = DESKTOP_DIR / "1ct" / "assets" / "icon.ico"

CSC_CANDIDATES = (
    Path(r"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"),
    Path(r"C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe"),
    Path(r"C:\Windows\Microsoft.NET\Framework64\v3.5\csc.exe"),
    Path(r"C:\Windows\Microsoft.NET\Framework\v3.5\csc.exe"),
)


class BuildError(Exception):
    """启动器编译失败。"""


class Brand:
    """一个启动器品牌（源码 + 产物位置 + 图标）。"""

    def __init__(
        self,
        key: str,
        source: Path,
        launcher_name: str,
        copy_dir: Path,
        icon: Path | None = None,
    ):
        self.key = key
        self.source = source
        self.launcher_name = launcher_name
        self.root_exe = REPO_ROOT / launcher_name
        self.copy_dir = copy_dir
        self.copy_exe = copy_dir / launcher_name
        self.icon = icon

    def __repr__(self) -> str:  # pragma: no cover - 仅调试用
        return f"Brand({self.key!r})"


BRANDS = {
    "3ct": Brand("3ct", SOURCE, LAUNCHER_NAME, COPY_DIR),
    "1ct": Brand("1ct", ONECT_SOURCE, ONECT_LAUNCHER_NAME, ONECT_COPY_DIR, icon=ONECT_ICON),
}
DEFAULT_BRAND = "3ct"
#: 不带 --brand 时 main() 刷新的品牌：保持历史行为（只刷 3CT 自动版），
#: 以免在 3CT-Auto 正在使用时改写其入口；1CT 入口由 install_1ct.py 自动构建。
DEFAULT_MAIN_BRANDS = ("3ct",)
#: ``--brand all`` 展开为两个品牌。
ALL_BRANDS = ("3ct", "1ct")


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


#: ``icon`` 参数的“自动选图标”哨兵：显式传 ``None`` 表示**不要图标**（测试用），
#: 不传则按品牌自动选择（3CT → 3CT 图标；1CT → desktop/1ct/assets/icon.ico）。
AUTO_ICON = object()


def get_brand(brand: str | Brand | None = None) -> Brand:
    """把 brand 名字解析为 :class:`Brand`（None/默认 → 3CT 自动版）。"""

    if isinstance(brand, Brand):
        return brand
    key = brand or DEFAULT_BRAND
    if key not in BRANDS:
        raise BuildError(f"未知品牌: {key}（支持: {', '.join(sorted(BRANDS))}）")
    return BRANDS[key]


def resolve_icon(brand: str | Brand | None, icon) -> Path | None:
    """按品牌解析图标：未显式指定时用品牌自己的图标。"""

    if icon is AUTO_ICON:
        profile = get_brand(brand)
        return profile.icon if profile.icon is not None else ICON
    return icon


def build_launcher(
    out_exe: Path,
    *,
    icon=AUTO_ICON,
    source: Path | None = None,
    csc: Path | None = None,
    brand: str | Brand | None = None,
) -> subprocess.CompletedProcess:
    """编译 GUI 启动器（WinExe，无控制台）。

    不传 *source* 时按 *brand* 选择源码；不传 *brand* 时保持历史行为（3CT 自动版）。
    *icon* 不传则按品牌自动选（1CT 用自己的图标）；传 ``None`` 表示不嵌入图标。
    """

    profile = get_brand(brand)
    return build_csharp(
        Path(source) if source is not None else profile.source,
        out_exe,
        target="winexe",
        icon=resolve_icon(profile, icon),
        csc=csc,
    )


def sync_to_copy(
    root_exe: Path = ROOT_EXE,
    copy_dir: Path = COPY_DIR,
) -> Path:
    """把根入口复制到副本目录（installer 之外的一次性同步，不重打包 app.asar）。"""

    root_exe = Path(root_exe)
    copy_dir = Path(copy_dir)
    if not root_exe.is_file():
        raise BuildError(f"根启动器不存在: {root_exe}")
    copy_dir.mkdir(parents=True, exist_ok=True)
    target = copy_dir / root_exe.name
    shutil.copy2(root_exe, target)
    return target


def build_brand(
    brand: str | Brand,
    *,
    out_exe: Path | None = None,
    icon=AUTO_ICON,
    sync: bool = True,
    csc: Path | None = None,
) -> dict:
    """构建某个品牌的根入口；3CT 品牌默认再同步一份到其副本目录。

    1CT 品牌**不同步**到副本目录：用户要求「工程文件夹里 1CT.exe 和 启动1CT.exe
    只留一个」，所以 1CT 只有仓库根这一个 ``启动1CT.exe`` 入口，
    副本内的 ``1CT.exe`` 是 Electron 本体（不可删、也不再放同名启动器）。
    """

    profile = get_brand(brand)
    target = Path(out_exe) if out_exe is not None else profile.root_exe
    resolved_icon = resolve_icon(profile, icon)
    completed = build_launcher(target, icon=resolved_icon, csc=csc, brand=profile)
    payload = {
        "brand": profile.key,
        "source": str(profile.source),
        "icon": str(resolved_icon) if resolved_icon is not None else None,
        "root_exe": str(target.resolve()),
        "exe_bytes": target.stat().st_size,
        "copied_to": None,
        "compiler_output": (completed.stdout or b"").decode("utf-8", "replace").strip(),
    }
    # 1CT：只留仓库根一个入口，不复制到副本目录。
    should_sync = sync and profile.key != "1ct"
    if out_exe is None and should_sync:
        payload["copied_to"] = str(sync_to_copy(profile.root_exe, profile.copy_dir).resolve())
    elif profile.key == "1ct":
        payload["note"] = "1CT 只产出仓库根入口（副本内不再放同名启动器）"
    return payload


def parse_brands(raw: list[str] | None) -> list[str]:
    """把 ``--brand`` 值展开成品牌 key 列表（``all`` 展开为全部）。"""

    keys: list[str] = []
    for value in raw or []:
        item = value.strip().lower()
        candidates = list(ALL_BRANDS) if item == "all" else [item]
        for key in candidates:
            if key not in BRANDS:
                raise BuildError(f"未知品牌: {key}（支持: all, {', '.join(sorted(BRANDS))}）")
            if key not in keys:
                keys.append(key)
    return keys


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="构建 3CT 自动版 / 1CT C# 图形启动器（WinExe）")
    parser.add_argument("--out", default=None, help="只构建到指定 exe（需配合 --brand，默认 3ct）")
    parser.add_argument("--brand", action="append", default=None, help="要构建的品牌：3ct / 1ct / all（可重复）")
    parser.add_argument("--no-icon", action="store_true", help="不嵌入图标（测试/排错用）")
    parser.add_argument(
        "--no-sync",
        action="store_true",
        help="只构建根入口，不复制到副本目录（3CT-Auto / 1CT）",
    )
    args = parser.parse_args(argv)

    try:
        brands = parse_brands(args.brand) or list(DEFAULT_MAIN_BRANDS)
        if args.out is not None:
            # --out 只构建一个品牌到指定路径，不做副本同步。
            brands = brands[:1] or [DEFAULT_BRAND]
            payload = build_brand(
                brands[0],
                out_exe=Path(args.out),
                icon=None if args.no_icon else AUTO_ICON,
                sync=False,
            )
            results = [payload]
        else:
            results = [
                build_brand(
                    key,
                    icon=None if args.no_icon else AUTO_ICON,
                    sync=not args.no_sync,
                )
                for key in brands
            ]
    except BuildError as exc:
        print(f"错误: {exc}", file=sys.stderr)
        return 1

    for payload in results:
        if payload["compiler_output"]:
            print(payload["compiler_output"])
        print(f"已生成 GUI 启动器（{payload['brand']}）: {payload['root_exe']}")
        if payload["icon"]:
            print(f"  图标: {payload['icon']}")
        if payload["copied_to"]:
            print(f"已同步到副本目录: {payload['copied_to']}")
    print("提示：双击入口即可；首次使用请先确保对应副本已 build。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
