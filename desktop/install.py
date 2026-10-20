"""生成独立可启动的 3CT-Auto 副本（只改副本，原程序完全保留）。

本工具只使用 Python 标准库，不依赖 npm / node / 任何第三方包。

做什么
------
1. 原样复制 `3CT/` 的全部运行文件到 `3CT-Auto/`（跳过原版卸载器，避免误卸载原程序；
   主程序 exe 改名为 `3CT-Auto.exe`，便于启动脚本区分原版进程）；
2. 读取 `3CT/resources/app.asar`，完整保留原包全部条目（415 个条目，其中 347 个文件、
   其余为目录；含全部 node_modules），只新增/替换少量文件后按 ASAR 规范重建，并更新
   offset/size 与 SHA256 integrity（blockSize=4194304，逐块 SHA256）；重建后共 352 个文件；
3. 补丁内容：
   - `dist/renderer/index.html`：标题加 Auto，追加 jsQR/automation/panel 的本地
     `<script defer>` 与 `<link panel.css>`（不依赖 eval 注入，符合原 CSP 'self'）；
   - `package.json`：`main` 改为 `./dist/main/auto-bootstrap.cjs`（早期 bootstrap，
     在 require 原 `main.js` 之前禁用自动更新、关闭后台节流）；
   - 新增 `dist/main/auto-bootstrap.cjs`、`dist/renderer/{jsQR,automation,panel}.js`、
     `dist/renderer/panel.css`；
4. 校验：重建后的 ASAR 可被重新解析，未改动文件内容逐字节一致，原 ASAR 的
   SHA256 前后不变（绝不修改原程序）；
5. 写入 `README-3CT-Auto.txt`，声明与原版共享 userData / 单实例锁、勿自动更新、
   电脑唤醒/应用打开才执行等注意事项。

注意
----
- 原版 3CT 若正在运行，副本会因单实例锁无法启动；启动脚本只提示用户先退出，
  **绝不结束或修改原版进程**。
- 副本与原版共享 userData（这样能直接复用现有登录态），因此不要同时运行两个。
- 副本内自动更新已禁用，禁止在副本里安装官方更新覆盖原程序。

用法
----
    python desktop/install.py build                 # 生成 3CT-Auto/
    python desktop/install.py build --force         # 覆盖已有 3CT-Auto/
    python desktop/install.py extract-vendor        # 从原 ASAR 的 sourcemap 提取 jsQR
    python desktop/install.py verify                # 校验已生成的副本
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import struct
import sys
from datetime import datetime
from pathlib import Path

MAGIC = 4
BLOCK_SIZE = 4 * 1024 * 1024
MARKER_NAME = ".3ct-auto-install.json"
REPO_ROOT = Path(__file__).resolve().parent.parent
SOURCE_DIR = REPO_ROOT / "3CT"
DEST_DIR = REPO_ROOT / "3CT-Auto"
DESKTOP_DIR = REPO_ROOT / "desktop"
VENDOR_DIR = DESKTOP_DIR / "vendor"
DEFAULT_ASAR = SOURCE_DIR / "resources" / "app.asar"
START_SCRIPT_NAME = "start-3ct-auto.cmd"

#: 原版里不要复制的文件（卸载器会卸载原程序；其余全部复制）。
COPY_EXCLUDE_NAMES = frozenset({"Uninstall 3CT.exe"})
#: 原版主程序 exe 改名后的名字，用于与运行中的原版进程区分。
EXE_SOURCE_NAME = "3CT.exe"
EXE_DEST_NAME = "3CT-Auto.exe"

INDEX_HTML_PATH = "dist/renderer/index.html"
PACKAGE_JSON_PATH = "package.json"
BOOTSTRAP_PATH = "dist/main/auto-bootstrap.cjs"
INDEX_TITLE_OLD = "<title>3CT</title>"
INDEX_TITLE_NEW = "<title>3CT Auto</title>"
INDEX_STYLES = '<link href=./panel.css rel=stylesheet><link href=./dashboard.css rel=stylesheet>'
INDEX_SCRIPTS = (
    "<script defer=defer src=./jsQR.js></script>"
    "<script defer=defer src=./score-policy.js></script>"
    "<script defer=defer src=./result-store.js></script>"
    "<script defer=defer src=./automation.js></script>"
    "<script defer=defer src=./dashboard.js></script>"
    "<script defer=defer src=./panel.js></script>"
)
RENDERER_SCRIPTS = (
    "jsQR.js",
    "score-policy.js",
    "result-store.js",
    "automation.js",
    "dashboard.js",
    "panel.js",
    "panel.css",
    "dashboard.css",
)
#: 新文件：ASAR 内路径 -> desktop 目录下的来源（bootstrap 单独处理）。
PATCH_SOURCES = {
    "dist/renderer/jsQR.js": VENDOR_DIR / "jsQR.js",
    "dist/renderer/score-policy.js": DESKTOP_DIR / "score-policy.js",
    "dist/renderer/result-store.js": DESKTOP_DIR / "result-store.js",
    "dist/renderer/automation.js": DESKTOP_DIR / "automation.js",
    "dist/renderer/dashboard.js": DESKTOP_DIR / "dashboard.js",
    "dist/renderer/panel.js": DESKTOP_DIR / "panel.js",
    "dist/renderer/panel.css": DESKTOP_DIR / "panel.css",
    "dist/renderer/dashboard.css": DESKTOP_DIR / "dashboard.css",
    BOOTSTRAP_PATH: DESKTOP_DIR / "bootstrap.cjs",
}

README_NAME = "README-3CT-Auto.txt"
LAUNCHER_NAME = START_SCRIPT_NAME
README_TEXT = """3CT-Auto（独立自动化副本）
==============================

由 desktop/install.py 从原始 3CT 复制并打补丁生成；原版 3CT 目录未被修改。

使用
----
1. 先完全退出原版 3CT（含托盘中的进程）。两者共享同一个 userData 与单实例锁，
   同时运行会被锁拦住。
2. 双击 start-3ct-auto.cmd 或直接运行 3CT-Auto.exe。

注意
----
- 与原版共享 userData：现有登录态可以直接沿用，因此**不要同时打开原版和副本**。
- 副本已禁用自动更新（不会下载/安装官方更新覆盖原程序）；bootstrap 还覆盖了
  checkForUpdates / quitAndInstall / setFeedURL，并置 autoDownload=false、
  autoInstallOnAppQuit=false，即使官方更新已有缓存也不会在本副本里安装。
  请不要在副本里手动安装官方更新，也不要把它当作原版的升级替代。
- 每日任务需要应用保持打开、且电脑处于唤醒状态才会执行；关机/睡眠期间不会补跑
  （依赖应用内调度器）。建议把应用常驻并关闭系统睡眠，或每天晚上固定打开一次。
- 本副本只增加自动化面板与本地渲染脚本，不修改账号数据、不上传凭证。
"""


class InstallerError(Exception):
    """安装/打包失败（消息为简短中文）。"""


# ---------------------------------------------------------------------------
# ASAR 读写
# ---------------------------------------------------------------------------


def read_header(archive: str | Path) -> tuple[dict, int]:
    """返回 ``(header_tree, data_base)``。"""

    archive = Path(archive)
    try:
        with archive.open("rb") as fh:
            head = fh.read(16)
            if len(head) < 16:
                raise InstallerError(f"文件太短，不是有效 ASAR: {archive}")
            magic, header_size, _str_pickle_size, json_len = struct.unpack("<IIII", head)
            if magic != MAGIC:
                raise InstallerError(f"ASAR magic 不正确（{magic}，应为 {MAGIC}）: {archive}")
            if json_len <= 0 or header_size < json_len or header_size > 512 * 1024 * 1024:
                raise InstallerError(
                    f"ASAR 头长度异常 header_size={header_size} json_len={json_len}: {archive}"
                )
            fh.seek(16)
            raw = fh.read(json_len)
    except OSError as exc:
        raise InstallerError(f"无法读取 ASAR: {archive}: {exc}") from exc
    if len(raw) != json_len:
        raise InstallerError(f"ASAR 头被截断: {archive}")
    try:
        header = json.loads(raw.decode("utf-8", "replace"))
    except ValueError as exc:
        raise InstallerError(f"ASAR 头不是合法 JSON: {exc}") from exc
    if not isinstance(header, dict):
        raise InstallerError("ASAR 头不是 JSON 对象")
    header.setdefault("files", {})
    return header, 8 + header_size


def iter_files(header: dict):
    """按原始顺序深度优先产出 ``(路径, 节点)``（只含文件，不含目录）。"""

    def walk(node: dict, prefix: str):
        for name, child in node.get("files", {}).items():
            rel = prefix + name
            if isinstance(child, dict) and "files" in child:
                yield from walk(child, rel + "/")
            else:
                yield rel, child

    yield from walk(header, "")


def read_file(archive: str | Path, node: dict, data_base: int) -> bytes:
    if node.get("unpacked"):
        raise InstallerError(f"不支持 unpacked 节点: {node}")
    size = int(node.get("size", 0))
    offset = int(node.get("offset", 0))
    archive = Path(archive)
    try:
        with archive.open("rb") as fh:
            fh.seek(data_base + offset)
            data = fh.read(size)
    except OSError as exc:
        raise InstallerError(f"无法读取 ASAR 载荷: {exc}") from exc
    if len(data) != size:
        raise InstallerError(f"ASAR 载荷被截断（期望 {size} 字节，实际 {len(data)}）")
    return data


def read_file_by_path(archive: str | Path, path: str) -> bytes:
    header, data_base = read_header(archive)
    node = find_node(header, path)
    if node is None:
        raise InstallerError(f"ASAR 中不存在: {path}")
    return read_file(archive, node, data_base)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: str | Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def integrity_for(data: bytes, block_size: int = BLOCK_SIZE) -> dict:
    blocks = [
        sha256_bytes(data[index:index + block_size])
        for index in range(0, len(data), block_size)
    ]
    return {
        "algorithm": "SHA256",
        "hash": sha256_bytes(data),
        "blockSize": block_size,
        "blocks": blocks,
    }


def find_node(header: dict, path: str) -> dict | None:
    cur: dict = header
    for part in path.split("/"):
        if not isinstance(cur, dict):
            return None
        cur = cur.get("files", {}).get(part)
        if cur is None:
            return None
    return cur


def ensure_dir_node(header: dict, dir_path: str) -> dict:
    cur = header
    for part in [p for p in dir_path.split("/") if p]:
        files = cur.setdefault("files", {})
        child = files.get(part)
        if child is None:
            child = {"files": {}}
            files[part] = child
        elif not isinstance(child, dict) or "files" not in child:
            raise InstallerError(f"ASAR 路径冲突（文件占用目录）: {dir_path}")
        cur = child
    return cur


def set_file_node(header: dict, path: str, data: bytes) -> dict:
    """在头里登记一个新文件节点（offset 在布局阶段回填）。"""

    parent, _, name = path.rpartition("/")
    directory = ensure_dir_node(header, parent)
    directory.setdefault("files", {})[name] = {
        "size": len(data),
        "offset": "0",
        "integrity": integrity_for(data),
    }
    return directory["files"][name]


def rebuild_asar(
    source_archive: str | Path,
    replacements: dict[str, bytes] | None = None,
) -> bytes:
    """基于原 ASAR 重建：未替换的文件逐字节保留，替换/新增文件重算 offset+integrity。"""

    source_archive = Path(source_archive)
    replacements = dict(replacements or {})
    header, data_base = read_header(source_archive)

    # 先把新文件登记进树（保持原顺序，新文件追加到所属目录末尾）。
    for path, data in replacements.items():
        set_file_node(header, path, data)

    payload = bytearray()
    for path, node in iter_files(header):
        if path in replacements:
            data = replacements[path]
        else:
            data = read_file(source_archive, node, data_base)
        node["size"] = len(data)
        node["offset"] = str(len(payload))
        node["integrity"] = integrity_for(data)
        payload.extend(data)

    json_bytes = json.dumps(header, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    json_len = len(json_bytes)
    str_pickle_size = (json_len + 4 + 3) // 4 * 4
    header_size = 4 + str_pickle_size
    padding = header_size - (json_len + 8)
    if padding < 0:  # pragma: no cover - 数学上不可能
        raise InstallerError("ASAR 头对齐失败")
    header_bytes = (
        struct.pack("<IIII", MAGIC, header_size, str_pickle_size, json_len)
        + json_bytes
        + b"\x00" * padding
    )
    return header_bytes + bytes(payload)


def write_atomic(path: str | Path, data: bytes) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


# ---------------------------------------------------------------------------
# 补丁
# ---------------------------------------------------------------------------


def patch_index_html(original: bytes, title: str = "3CT Auto") -> bytes:
    text = original.decode("utf-8")
    if "./panel.js" in text:
        raise InstallerError("index.html 已包含自动化脚本（源包可能已被改过）")
    if INDEX_TITLE_OLD not in text:
        raise InstallerError(f"index.html 缺少预期标题 {INDEX_TITLE_OLD}")
    if "</head>" not in text:
        raise InstallerError("index.html 缺少 </head>，无法安全注入脚本")
    text = text.replace(INDEX_TITLE_OLD, f"<title>{title}</title>", 1)
    injections = INDEX_STYLES + INDEX_SCRIPTS
    text = text.replace("</head>", injections + "</head>", 1)
    encoded = text.encode("utf-8")
    if "./automation.js" not in text or "./panel.css" not in text:
        raise InstallerError("index.html 注入脚本失败")
    return encoded


def patch_package_json(original: bytes) -> bytes:
    try:
        package = json.loads(original.decode("utf-8"))
    except ValueError as exc:
        raise InstallerError(f"package.json 不是合法 JSON: {exc}") from exc
    if not isinstance(package, dict):
        raise InstallerError("package.json 顶层不是对象")
    if "name" not in package or "version" not in package:
        raise InstallerError("package.json 缺少 name/version")
    package["main"] = "./" + BOOTSTRAP_PATH
    return json.dumps(package, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def load_patch_inputs(desktop_dir: str | Path = DESKTOP_DIR) -> dict[str, bytes]:
    """收集需要写入 ASAR 的新文件；缺失时给出明确中文错误。"""

    desktop_dir = Path(desktop_dir)
    vendor_dir = desktop_dir / "vendor"
    sources = {
        "dist/renderer/jsQR.js": vendor_dir / "jsQR.js",
        "dist/renderer/score-policy.js": desktop_dir / "score-policy.js",
        "dist/renderer/result-store.js": desktop_dir / "result-store.js",
        "dist/renderer/automation.js": desktop_dir / "automation.js",
        "dist/renderer/dashboard.js": desktop_dir / "dashboard.js",
        "dist/renderer/panel.js": desktop_dir / "panel.js",
        "dist/renderer/panel.css": desktop_dir / "panel.css",
        "dist/renderer/dashboard.css": desktop_dir / "dashboard.css",
        BOOTSTRAP_PATH: desktop_dir / "bootstrap.cjs",
    }
    missing = [str(path.relative_to(desktop_dir.parent)) for path in sources.values() if not path.is_file()]
    if missing:
        raise InstallerError("缺少补丁输入文件: " + ", ".join(missing))
    return {archive_path: path.read_bytes() for archive_path, path in sources.items()}


def build_patched_asar(
    source_archive: str | Path,
    desktop_dir: str | Path = DESKTOP_DIR,
) -> bytes:
    """读取原 ASAR，应用 index.html/package.json/新文件补丁，返回重建后的字节。"""

    source_archive = Path(source_archive)
    inputs = load_patch_inputs(desktop_dir)

    header, data_base = read_header(source_archive)
    index_node = find_node(header, INDEX_HTML_PATH)
    package_node = find_node(header, PACKAGE_JSON_PATH)
    if index_node is None or package_node is None:
        raise InstallerError(f"原 ASAR 缺少 {INDEX_HTML_PATH} 或 {PACKAGE_JSON_PATH}")

    replacements = dict(inputs)
    replacements[INDEX_HTML_PATH] = patch_index_html(
        read_file(source_archive, index_node, data_base)
    )
    replacements[PACKAGE_JSON_PATH] = patch_package_json(
        read_file(source_archive, package_node, data_base)
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
    """--force 的目录安全闸：只允许本 workspace 的安装目标，或带匹配 marker 的旧副本。

    绝不凭目录名删除任意用户目录。
    """

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
    if not isinstance(marker, dict) or marker.get("generator") != "desktop/install.py":
        raise InstallerError(f"安装标记不属于本工具，拒绝删除: {marker_path}")
    current_hash = sha256_file(source_asar)
    marker_hash = marker.get("source_asar_sha256")
    if marker_hash != current_hash:
        raise InstallerError(
            "旧副本的源 ASAR 哈希与当前原程序不一致（可能原版已升级），"
            "拒绝自动删除；请手动确认后删除目标目录再重建"
        )
    marker_source = marker.get("source")
    if marker_source and Path(marker_source).resolve() != source_dir.resolve():
        raise InstallerError("旧副本的源目录与本次不一致，拒绝删除")


def write_marker(dest_dir: Path, summary: dict) -> Path:
    marker_path = dest_dir / MARKER_NAME
    marker = {
        "generator": "desktop/install.py",
        "source": summary["source"],
        "source_asar_sha256": summary["original_asar_sha256"],
        "patched_asar_sha256": summary["patched_asar_sha256"],
        "created_at": datetime.now().isoformat(timespec="seconds"),
    }
    marker_path.write_text(
        json.dumps(marker, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    return marker_path


def copy_app_tree(source_dir: Path, dest_dir: Path) -> dict:
    if source_dir.resolve() == dest_dir.resolve():
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


def write_readme(dest_dir: Path) -> Path:
    path = dest_dir / README_NAME
    path.write_text(README_TEXT, encoding="utf-8")
    return path


def write_launcher(dest_dir: Path, desktop_dir: Path) -> Path:
    """把一键启动脚本写进副本目录，交付后用户直接双击即可。"""

    source = Path(desktop_dir) / LAUNCHER_NAME
    if not source.is_file():
        raise InstallerError(f"缺少启动脚本: {source}")
    target = dest_dir / LAUNCHER_NAME
    shutil.copy2(source, target)
    return target


def _ensure_vendor(source_asar: Path, desktop_dir: Path) -> None:
    """desktop/vendor/jsQR.js 是 gitignore 的生成物；缺失时从原包 sourcemap 自动恢复。"""

    vendor_script = desktop_dir / "vendor" / "jsQR.js"
    if vendor_script.is_file():
        return
    try:
        extract_jsqr(source_asar, desktop_dir / "vendor")
    except InstallerError as exc:
        raise InstallerError(
            f"缺少 desktop/vendor/jsQR.js，且自动恢复失败: {exc}；"
            "请运行 python desktop/install.py extract-vendor"
        ) from exc


def build(
    source_dir: str | Path = SOURCE_DIR,
    dest_dir: str | Path = DEST_DIR,
    desktop_dir: str | Path = DESKTOP_DIR,
    *,
    force: bool = False,
    verify: bool = True,
) -> dict:
    """生成独立副本；原目录只读不写。"""

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
    original_hash = sha256_file(source_asar)
    _ensure_vendor(source_asar, Path(desktop_dir))
    patched_asar = build_patched_asar(source_asar, desktop_dir)

    if dest_dir.exists():
        if not force:
            raise InstallerError(f"目标目录已存在: {dest_dir}（如需重建请加 --force）")
        check_removable(dest_dir, source_asar, source_dir)
        _rmtree_confirmed(dest_dir)

    copy_summary = copy_app_tree(source_dir, dest_dir)
    write_atomic(dest_dir / "resources" / "app.asar", patched_asar)
    write_launcher(dest_dir, desktop_dir)

    after_hash = sha256_file(source_asar)
    if after_hash != original_hash:
        raise InstallerError("原程序 ASAR 被意外修改，已中止（原文件必须完全保留）")

    summary = {
        "source": str(source_dir),
        "dest": str(dest_dir),
        "original_asar_sha256": original_hash,
        "patched_asar_sha256": sha256_bytes(patched_asar),
        "patched_asar_size": len(patched_asar),
        "copied_files": copy_summary["copied"],
        "skipped": copy_summary["skipped"],
    }
    write_marker(dest_dir, summary)
    write_readme(dest_dir)
    if verify:
        summary["verify"] = verify_patched_asar(
            dest_dir / "resources" / "app.asar", source_asar, desktop_dir
        )
    return summary


def verify_patched_asar(
    patched_archive: str | Path,
    original_archive: str | Path,
    desktop_dir: str | Path | None = None,
) -> dict:
    """校验：条目齐全、未改文件内容一致、全部 integrity 与内容匹配、补丁文件正确。"""

    patched_archive = Path(patched_archive)
    original_archive = Path(original_archive)

    original_header, original_base = read_header(original_archive)
    patched_header, patched_base = read_header(patched_archive)
    original_files = dict(iter_files(original_header))
    patched_files = dict(iter_files(patched_header))

    missing = sorted(set(original_files) - set(patched_files))
    if missing:
        raise InstallerError(f"重建后丢失文件: {', '.join(missing[:5])}")

    expected_new = set(PATCH_SOURCES) | {INDEX_HTML_PATH, PACKAGE_JSON_PATH}
    unchanged = 0
    for path, node in original_files.items():
        if path in expected_new:
            continue
        if read_file(original_archive, node, original_base) != read_file(
            patched_archive, patched_files[path], patched_base
        ):
            raise InstallerError(f"重建后未改动文件内容不一致: {path}")
        unchanged += 1

    # 1) 所有文件的 integrity（hash + blocks）必须与重建后真实内容一致。
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

    # 2) 新增脚本/样式必须与 desktop 补丁源逐字节一致。
    if desktop_dir is not None:
        inputs = load_patch_inputs(desktop_dir)
        for path, expected_bytes in inputs.items():
            if read_file(patched_archive, patched_files[path], patched_base) != expected_bytes:
                raise InstallerError(f"补丁文件与补丁源不一致: {path}")

    index_html = read_file(patched_archive, patched_files[INDEX_HTML_PATH], patched_base)
    text = index_html.decode("utf-8")
    for needle in (
        "./jsQR.js",
        "./score-policy.js",
        "./result-store.js",
        "./automation.js",
        "./dashboard.js",
        "./panel.js",
        "./panel.css",
        "./dashboard.css",
        "<title>3CT Auto</title>",
    ):
        if needle not in text:
            raise InstallerError(f"index.html 补丁缺失: {needle}")

    package = json.loads(
        read_file(patched_archive, patched_files[PACKAGE_JSON_PATH], patched_base)
    )
    if package.get("main") != "./" + BOOTSTRAP_PATH:
        raise InstallerError(f"package.json main 未指向 bootstrap: {package.get('main')}")

    return {
        "entries": len(patched_files),
        "unchanged_verified": unchanged,
        "integrity_verified": len(patched_files),
        "patched_files": sorted(expected_new),
    }


# ---------------------------------------------------------------------------
# jsQR 提取（从原包 renderer sourcemap 的 sourcesContent 恢复）
# ---------------------------------------------------------------------------


def extract_jsqr(
    source_archive: str | Path = DEFAULT_ASAR,
    out_dir: str | Path = VENDOR_DIR,
) -> dict:
    """从原 ASAR 内 renderer.js.map 恢复 jsQR 的原始 UMD 构建。"""

    source_archive = Path(source_archive)
    out_dir = Path(out_dir)
    map_bytes = read_file_by_path(source_archive, "dist/renderer/renderer.js.map")
    try:
        source_map = json.loads(map_bytes.decode("utf-8", "replace"))
    except ValueError as exc:
        raise InstallerError(f"renderer.js.map 解析失败: {exc}") from exc

    sources = source_map.get("sources") or []
    contents = source_map.get("sourcesContent") or []
    target = None
    for index, name in enumerate(sources):
        if "node_modules/jsqr/dist/jsQR.js" in str(name) or "node_modules\\jsqr\\dist\\jsQR.js" in str(name):
            if index < len(contents) and contents[index]:
                target = contents[index]
                break
    if not target:
        raise InstallerError("未能在 renderer sourcemap 中找到 jsQR UMD 源码")

    ok, problem = _looks_like_jsqr(target)
    if not ok:
        raise InstallerError(f"恢复出的 jsQR 源码不完整: {problem}")

    out_dir.mkdir(parents=True, exist_ok=True)
    script = out_dir / "jsQR.js"
    script.write_text(target if target.endswith("\n") else target + "\n", encoding="utf-8")
    license_path = out_dir / "jsQR.LICENSE.txt"
    license_path.write_text(
        "jsQR (UMD build recovered from 3CT renderer.js.map sourcesContent)\n"
        "Copyright (c) 2016 Cosmo Wolfe and contributors\n"
        "Licensed under the Apache License, Version 2.0:\n"
        "https://github.com/cozmo/jsQR/blob/master/LICENSE\n"
        "\n"
        "This file is bundled for offline use inside 3CT-Auto; it is not modified\n"
        "except for being copied out of the original application archive.\n",
        encoding="utf-8",
    )
    return {
        "script": str(script),
        "license": str(license_path),
        "bytes": len(target.encode("utf-8")),
    }


def _looks_like_jsqr(source: str) -> tuple[bool, str]:
    checks = (
        ("webpackUniversalModuleDefinition", "缺少 UMD 头"),
        ("jsQR", "缺少 jsQR 标识"),
        ("binarize", "缺少 binarize 实现"),
    )
    for needle, message in checks:
        if needle not in source:
            return False, message
    if len(source) < 100_000:
        return False, "源码过短"
    return True, ""


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="生成独立可启动的 3CT-Auto 副本")
    parser.add_argument("--source", default=str(SOURCE_DIR), help="原始 3CT 目录（只读）")
    parser.add_argument("--dest", default=str(DEST_DIR), help="输出副本目录")
    parser.add_argument("--desktop-dir", default=str(DESKTOP_DIR), help="desktop 补丁素材目录")
    parser.add_argument("--archive", default=str(DEFAULT_ASAR), help="原 app.asar 路径")
    sub = parser.add_subparsers(dest="command", required=True)
    build_parser = sub.add_parser("build", help="生成 3CT-Auto 副本")
    build_parser.add_argument("--force", action="store_true", help="目标已存在时覆盖重建")
    build_parser.add_argument("--no-verify", action="store_true", help="跳过重建后校验")
    sub.add_parser("extract-vendor", help="从原包 sourcemap 提取 jsQR 到 desktop/vendor")
    sub.add_parser("verify", help="校验已生成的副本")
    args = parser.parse_args(argv)

    try:
        if args.command == "build":
            summary = build(
                args.source,
                args.dest,
                args.desktop_dir,
                force=args.force,
                verify=not args.no_verify,
            )
            print(json.dumps(summary, indent=2, ensure_ascii=False))
            print("完成：独立副本已生成，可运行 start-3ct-auto.cmd（请先退出原版 3CT）。")
            return 0
        if args.command == "extract-vendor":
            result = extract_jsqr(args.archive)
            print(json.dumps(result, indent=2, ensure_ascii=False))
            return 0
        if args.command == "verify":
            result = verify_patched_asar(
                Path(args.dest) / "resources" / "app.asar",
                Path(args.archive),
                args.desktop_dir,
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
