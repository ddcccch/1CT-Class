"""构建「升级1CT.exe」—— 单文件双击升级器（C# WinExe，内嵌新版 app.asar）。

用户诉求：「有没有那种双击就能升级的，而不是再解压覆盖目录感觉这样好麻烦」。
这个脚本把 ``desktop/Updater1CT.cs`` 和一份 ``app.asar`` 一起编进**一个 exe**：
用户双击它，就完成「关 1CT → 备份 → 覆盖 → 重启」，不需要再解压覆盖目录。

只依赖 Windows 自带的 .NET Framework ``csc.exe`` 与 Python 标准库
（``find_csc`` 复用 ``desktop/build_gui_launcher.py``，不重复实现）。

用法：
    python desktop/build_updater_1ct.py --force
    python desktop/build_updater_1ct.py --payload-asar <小文件> --out <临时目录> --force
    python desktop/build_updater_1ct.py --source 1CT --out 1CT升级包 --force

产物：
    <out>\\升级1CT.exe      单文件升级器（自带 payload，双击即用）
    <out>\\升级说明.txt     给用户看的升级/回滚说明

安全边界：本脚本只读 ``<source>\\resources\\app.asar``，不写 ``1CT\\`` 里的任何东西，
也不碰 ``%APPDATA%\\1CT``（用户数据）。编译后的自检都在**系统临时目录**里做：
1) ``--dry-run`` 只输出计划、不改任何文件；
2) 定位自检 ``--no-scan --log-dir <临时空目录> --target <临时假 1CT>`` 走一遍真升级
   （只动临时目录，验证「定位可注入、可跑通」）。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DESKTOP_DIR = REPO_ROOT / "desktop"
SOURCE_CS = DESKTOP_DIR / "Updater1CT.cs"
ICON = DESKTOP_DIR / "1ct" / "assets" / "icon.ico"
RCEDIT = DESKTOP_DIR / "1ct" / "assets" / "tools" / "rcedit.exe"

EXE_NAME = "升级1CT.exe"
README_NAME = "升级说明.txt"

#: 内嵌资源名（C# 侧按后缀识别：*.asar / *.json，见 Updater1CT.Payload.Load）。
ASAR_RESOURCE_NAME = "payload.app.asar"
JSON_RESOURCE_NAME = "payload.payload.json"


class BuildError(Exception):
    """构建升级器失败。"""


# ---------------------------------------------------------------- 小工具


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def decode_output(raw: bytes | None) -> str:
    """子进程输出在中文 Windows 上可能是 UTF-8 也可能是 GBK。"""

    if not raw:
        return ""
    for encoding in ("utf-8", "gbk"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", "replace")


def find_csc() -> Path:
    """复用 build_gui_launcher.find_csc()（脚本被 import 时也能找到它）。"""

    desktop = str(DESKTOP_DIR)
    if desktop not in sys.path:
        sys.path.insert(0, desktop)
    try:
        import build_gui_launcher  # type: ignore
    except Exception as exc:  # pragma: no cover - 只在仓库结构异常时触发
        raise BuildError(f"无法 import desktop/build_gui_launcher.py: {exc}") from exc
    csc = build_gui_launcher.find_csc()
    if csc is None:
        raise BuildError("找不到 .NET Framework csc.exe（需要 Windows 自带 .NET Framework 4.x）")
    return Path(csc)


def resolve_icon(icon: Path | None = ICON) -> Path | None:
    """图标存在就用（/win32icon:），不存在就跳过并提示（不因为图标失败）。"""

    if icon is None:
        return None
    icon = Path(icon)
    return icon if icon.is_file() else None


def default_version_line(source: Path) -> str:
    """默认版本行：优先读 <source>\\VERSION-1CT.txt，退化为「1CT <日期> 俱乐部签到修复」。"""

    version_file = Path(source) / "VERSION-1CT.txt"
    if version_file.is_file():
        try:
            lines = version_file.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            lines = []
        for line in lines:
            text = line.strip()
            if not text or set(text) <= {"="}:
                continue
            if "版本信息" in text:
                continue
            if text.startswith("1CT"):
                return text
        for line in lines:
            text = line.strip()
            if text.startswith("构建时间"):
                stamp = text.split(":", 1)[-1].strip() if ":" in text else text
                return f"1CT 构建于 {stamp}"
    return f"1CT {datetime.now():%Y-%m-%d} 俱乐部签到修复"


# ---------------------------------------------------------------- 编译


def compile_updater(
    source_cs: Path,
    out_exe: Path,
    *,
    payload_json: Path,
    payload_asar: Path,
    icon: Path | None,
    csc: Path | None = None,
) -> subprocess.CompletedProcess:
    """用 csc.exe 把 C# 源码 + 两个内嵌资源编成单文件 WinExe。"""

    csc = Path(csc) if csc is not None else find_csc()
    source_cs = Path(source_cs).resolve()
    if not source_cs.is_file():
        raise BuildError(f"C# 源文件不存在: {source_cs}")
    out_exe = Path(out_exe).resolve()
    out_exe.parent.mkdir(parents=True, exist_ok=True)

    command = [
        str(csc),
        "/nologo",
        "/target:winexe",
        "/platform:anycpu",
        "/optimize+",
        "/utf8output",
        "/reference:System.Windows.Forms.dll",
        "/reference:System.Drawing.dll",
        "/out:" + str(out_exe),
        # 内嵌 payload：新版 asar + 构建信息。C# 侧用 ManifestResourceStream 读。
        f"/resource:{Path(payload_json).resolve()},{JSON_RESOURCE_NAME}",
        f"/resource:{Path(payload_asar).resolve()},{ASAR_RESOURCE_NAME}",
        str(source_cs),
    ]
    if icon is not None:
        command.append("/win32icon:" + str(Path(icon).resolve()))

    completed = subprocess.run(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=600,
    )
    output = decode_output(completed.stdout)
    if completed.returncode != 0:
        raise BuildError(
            f"csc.exe 编译失败（exit={completed.returncode}）:\n{output.strip()}"
        )
    if not out_exe.is_file():
        raise BuildError(f"csc.exe 未生成目标文件: {out_exe}")
    return subprocess.CompletedProcess(command, completed.returncode, completed.stdout or b"", b"")


# ---------------------------------------------------------------- 自检


def make_self_check_tree(root: Path, payload_sha: str) -> Path:
    """造一个假 1CT 目录（只在临时目录里，绝不碰真实 1CT\\）。"""

    target = Path(root) / "1CT"
    (target / "resources").mkdir(parents=True, exist_ok=True)
    (target / "1CT.exe").write_bytes(b"MZ-self-check-1ct")
    (target / "resources" / "app.asar").write_bytes(b"OLD-ASAR-FOR-SELF-CHECK")
    (target / ".1ct-install.json").write_text(
        json.dumps(
            {
                "generator": "desktop/build_updater_1ct.py",
                "brand": "1CT",
                "patched_asar_sha256": "0" * 64,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    return target


def self_check(exe: Path, payload_sha: str) -> dict:
    """编译后自检 1：--dry-run 只输出计划，退出码 0，且不改任何文件。"""

    work = Path(tempfile.mkdtemp(prefix="updater-selfcheck-"))
    try:
        target = make_self_check_tree(work, payload_sha)
        asar = target / "resources" / "app.asar"
        before = asar.read_bytes()
        completed = subprocess.run(
            [str(exe), "--dry-run", "--target", str(target)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=300,
        )
        output = decode_output(completed.stdout) + decode_output(completed.stderr)
        if completed.returncode != 0:
            raise BuildError(
                f"自检失败：--dry-run 退出码 {completed.returncode}（期望 0）\n{output.strip()}"
            )
        if "UPGRADE-PLAN" not in output:
            raise BuildError(f"自检失败：--dry-run 没有输出计划\n{output.strip()}")
        if "locate=arg" not in output:
            raise BuildError(f"自检失败：--dry-run 计划里没有 locate=arg\n{output.strip()}")
        if payload_sha not in output:
            raise BuildError("自检失败：--dry-run 输出里没有内嵌 asar 的 sha256")
        if asar.read_bytes() != before:
            raise BuildError("自检失败：--dry-run 改动了目标 app.asar")
        if (target / ".backup").exists():
            raise BuildError("自检失败：--dry-run 创建了 .backup 目录")
        return {"exit": completed.returncode, "plan_lines": len(output.strip().splitlines())}
    finally:
        shutil.rmtree(work, ignore_errors=True)


def self_check_locate(exe: Path, payload_sha: str) -> dict:
    """编译后自检 2（定位自检）：在临时假 1CT 上走通 --no-scan + --target 的真升级。

    真实的 ``%APPDATA%\\1CT`` 不好伪造，所以这里只验证「定位链路可注入、可跑通」：
    ``--no-scan`` 关掉日志线索与常见位置扫描，``--log-dir`` 指向临时空目录，
    ``--target`` 指向临时假 1CT —— 全程不读写真实的 ``%APPDATA%\\1CT``。
    """

    work = Path(tempfile.mkdtemp(prefix="updater-locate-check-"))
    try:
        target = make_self_check_tree(work, payload_sha)
        empty_logs = work / "logs"
        empty_logs.mkdir()
        asar = target / "resources" / "app.asar"
        before = asar.read_bytes()
        completed = subprocess.run(
            [
                str(exe),
                "--silent",
                "--no-launch",
                "--no-kill",
                "--no-scan",
                "--log-dir",
                str(empty_logs),
                "--target",
                str(target),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=300,
        )
        output = decode_output(completed.stdout) + decode_output(completed.stderr)
        if completed.returncode != 0:
            raise BuildError(
                f"定位自检失败：退出码 {completed.returncode}（期望 0）\n{output.strip()}"
            )
        if "locate=arg" not in output:
            raise BuildError(f"定位自检失败：计划里没有 locate=arg\n{output.strip()}")
        if "status=success" not in output:
            raise BuildError(f"定位自检失败：没有 status=success\n{output.strip()}")
        after = sha256_file(asar)
        if after != payload_sha:
            raise BuildError(
                f"定位自检失败：目标 asar sha256={after}，期望 {payload_sha}"
            )
        backups = list((target / ".backup").glob("*/app.asar"))
        if len(backups) != 1 or backups[0].read_bytes() != before:
            raise BuildError("定位自检失败：备份不是恰好一份旧字节")
        log_text = (backups[0].parent / "upgrade.log").read_text(encoding="utf-8")
        if "定位" not in log_text:
            raise BuildError("定位自检失败：upgrade.log 里没有定位记录")
        return {"exit": completed.returncode, "locate": "arg", "old_sha256": sha256_bytes(before)}
    finally:
        shutil.rmtree(work, ignore_errors=True)


# ---------------------------------------------------------------- 说明文件


def readme_text(*, version_line: str, payload_sha: str, payload_size: int, built_at: str) -> str:
    return f"""升级1CT.exe —— 双击就升级（放哪都行，程序自己找 1CT）
====================================================

怎么用（发给同学只需要这一个 exe）
----------------------------------
1) 把 升级1CT.exe 放到**任意**地方（桌面、下载、U 盘、聊天工具的文件目录都行），双击它。
   不需要解压、不需要放进 1CT 目录、也不需要知道 1CT 装在哪。
2) 程序会**自己找** 1CT，顺序是：
   (1) exe 自己所在目录，以及它下面的 1CT 子目录；
   (2) 日志线索：%APPDATA%\\1CT\\logs 里的日志记着 1CT 的真实安装路径（最准）；
   (3) 有界**扫描**：桌面 / 下载 / 文档 / OneDrive / Program Files / 各盘根目录
       （限深、限时几秒，跳过 %APPDATA% 与系统目录）；
   (4) 以上都找不到，才弹框让你手动选目录（选 1CT 文件夹，里面有 1CT.exe 和 resources）。
3) 找到后自动关闭 1CT（含托盘图标），把旧的 resources\\app.asar 备份到
   1CT\\.backup\\<时间戳>\\app.asar，然后覆盖成新版本，最后自动重新启动 1CT。
4) 看到「升级完成」就是好了；看到「已经是最新版本，无需升级」说明不用升。
5) 万一找到多个 1CT，会弹一个候选列表让你点「立即升级这个」，程序不会自己乱挑。

升级不会碰什么
--------------
用户数据在 %APPDATA%\\1CT（成员、配置、执行历史、兜底照片）——升级完全不碰它。
升级只改 1CT 程序目录里的三个文件：
    resources\\app.asar      新版本本体
    VERSION-1CT.txt          版本说明
    .1ct-install.json        只更新 patched_asar_sha256 字段

回滚方法
--------
把 1CT\\.backup\\<时间戳>\\app.asar 复制回 1CT\\resources\\app.asar，再双击 启动1CT.exe。

日志
----
1CT\\.backup\\<时间戳>\\upgrade.log（定位走了哪一步 locate=…、时间、旧/新 sha256、字节数、步骤、结果）。

这个包里的内容
--------------
版本行    : {version_line}
asar sha256: {payload_sha}
asar 大小 : {payload_size} 字节
构建时间  : {built_at}

命令行（一般用户用不到）
------------------------
升级1CT.exe [--target <目录>] [--silent] [--no-launch] [--no-kill] [--dry-run]
            [--no-scan] [--log-dir <目录>] [--scan-root <目录>]
  --target    直接指定 1CT 目录（最高优先级，跳过自动查找）
  --no-scan   跳过「日志线索 + 常见位置扫描」，只做 exe 旁 / 手动选择（排错用）
  --log-dir   覆盖日志线索的扫描目录（默认 %APPDATA%\\1CT\\logs）
  --scan-root 覆盖扫描根目录，可重复（默认按上面 (3) 的常见位置）
退出码：0 成功 / 2 已是最新（--silent）/ 3 找不到或目标不合法 / 4 写失败（已回滚）/
        5 取消 / 6 找到多个 1CT 且无法交互（需要人工选择，什么都没改）。
"""


# ---------------------------------------------------------------- 主流程


def build_updater(
    *,
    source: Path = REPO_ROOT / "1CT",
    out_dir: Path = REPO_ROOT / "1CT升级包",
    payload_asar: Path | None = None,
    version_line: str | None = None,
    icon: Path | None = ICON,
    force: bool = False,
    run_self_check: bool = True,
    csc: Path | None = None,
) -> dict:
    """构建升级器并返回结果字典（exe 路径、大小、内嵌 asar sha256 等）。"""

    source = Path(source).resolve()
    out_dir = Path(out_dir).resolve()
    payload_asar = Path(payload_asar).resolve() if payload_asar else source / "resources" / "app.asar"
    if not payload_asar.is_file():
        raise BuildError(
            f"找不到 payload asar: {payload_asar}\n"
            "先跑 python desktop\\install_1ct.py build，或用 --payload-asar 指定一个文件"
        )
    if not SOURCE_CS.is_file():
        raise BuildError(f"缺少 C# 源码: {SOURCE_CS}")

    exe_path = out_dir / EXE_NAME
    readme_path = out_dir / README_NAME
    if not force and (exe_path.exists() or readme_path.exists()):
        raise BuildError(
            f"产物已存在: {exe_path}\n要覆盖请加 --force（例：python desktop\\build_updater_1ct.py --force）"
        )

    payload_bytes = payload_asar.read_bytes()
    if not payload_bytes:
        raise BuildError(f"payload asar 是空文件，拒绝构建: {payload_asar}")
    payload_sha = sha256_bytes(payload_bytes)
    payload_size = len(payload_bytes)
    version_line = version_line or default_version_line(source)
    built_at = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")

    out_dir.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix="updater-build-"))
    try:
        payload_json = staging / "payload.json"
        payload_json.write_text(
            json.dumps(
                {
                    "target": "1CT",
                    "versionLine": version_line,
                    "asarSha256": payload_sha,
                    "asarSize": payload_size,
                    "builtAt": built_at,
                    "notes": "由 desktop/build_updater_1ct.py 生成；内嵌在 升级1CT.exe 里",
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )

        resolved_icon = resolve_icon(icon)
        completed = compile_updater(
            SOURCE_CS,
            exe_path,
            payload_json=payload_json,
            payload_asar=payload_asar,
            icon=resolved_icon,
            csc=csc,
        )
    finally:
        shutil.rmtree(staging, ignore_errors=True)

    # 内嵌校验：payload.json 以文本形式编进 exe，能在 exe 里找到 sha256 就说明资源真的进去了。
    embedded = exe_path.read_bytes()
    if payload_sha.encode("ascii") not in embedded:
        raise BuildError("构建产物里找不到内嵌 payload 的 sha256，资源没有正确嵌入")

    readme_path.write_text(
        readme_text(
            version_line=version_line,
            payload_sha=payload_sha,
            payload_size=payload_size,
            built_at=built_at,
        ),
        encoding="utf-8-sig",
    )

    check = self_check(exe_path, payload_sha) if run_self_check else None
    locate_check = self_check_locate(exe_path, payload_sha) if run_self_check else None

    return {
        "exe": exe_path,
        "readme": readme_path,
        "exe_bytes": exe_path.stat().st_size,
        "payload_asar": payload_asar,
        "payload_sha256": payload_sha,
        "payload_bytes": payload_size,
        "version_line": version_line,
        "built_at": built_at,
        "icon": resolved_icon,
        "compiler_output": decode_output(completed.stdout).strip(),
        "self_check": check,
        "locate_check": locate_check,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="构建 升级1CT.exe（单文件双击升级器，自带新版 app.asar）"
    )
    parser.add_argument("--source", default=str(REPO_ROOT / "1CT"), help="1CT 目录（默认 1CT）")
    parser.add_argument("--out", default=str(REPO_ROOT / "1CT升级包"), help="输出目录（默认 1CT升级包）")
    parser.add_argument(
        "--payload-asar",
        default=None,
        help="要内嵌的 asar（默认 <source>\\resources\\app.asar；测试可用小文件）",
    )
    parser.add_argument("--version-line", default=None, help="版本行（默认读 <source>\\VERSION-1CT.txt）")
    parser.add_argument("--no-icon", action="store_true", help="不嵌入图标（排错用）")
    parser.add_argument(
        "--no-self-check",
        action="store_true",
        help="跳过编译后的自检（--dry-run 计划自检 + 定位自检）",
    )
    parser.add_argument("--force", action="store_true", help="覆盖已存在的产物")
    args = parser.parse_args(argv)

    try:
        result = build_updater(
            source=Path(args.source),
            out_dir=Path(args.out),
            payload_asar=Path(args.payload_asar) if args.payload_asar else None,
            version_line=args.version_line,
            icon=None if args.no_icon else ICON,
            force=args.force,
            run_self_check=not args.no_self_check,
        )
    except BuildError as exc:
        print(f"错误: {exc}", file=sys.stderr)
        return 1

    if result["compiler_output"]:
        print(result["compiler_output"])

    size = result["exe_bytes"]
    print(f"已生成单文件升级器: {result['exe']}")
    print(f"  大小: {size} 字节（{size / 1024 / 1024:.2f} MB）")
    print(f"  内嵌 asar sha256: {result['payload_sha256']}")
    print(f"  内嵌 asar 大小: {result['payload_bytes']} 字节")
    print(f"  版本行: {result['version_line']}")
    print(f"  用户说明: {result['readme']}")
    if result["icon"]:
        print(f"  图标: {result['icon']}")
    else:
        print("  图标: 未嵌入（找不到 desktop/1ct/assets/icon.ico）")
    check = result["self_check"]
    if check:
        print(f"自检: --dry-run 通过（exit={check['exit']}，计划 {check['plan_lines']} 行，未改动文件）")
    locate_check = result["locate_check"]
    if locate_check:
        print(
            "定位自检: --no-scan + --target 在临时假 1CT 上升级通过"
            f"（exit={locate_check['exit']}，locate={locate_check['locate']}，"
            f"旧 sha256={locate_check['old_sha256'][:12]}…）"
        )
    print("用法: 把 升级1CT.exe 发给别人、放哪都行，双击即可；它会自己找 1CT"
          "（日志线索 → 常见位置扫描 → 找不到才让你选目录）。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
