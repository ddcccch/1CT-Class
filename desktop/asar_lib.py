"""ASAR（Electron 应用归档格式）读写与校验原语。

1CT 打包链（``desktop/install_1ct.py``、``desktop/repack_1ct_incremental.py``）
共用本模块。本模块只做归档格式本身的事：解析 pickle 头、按目录树枚举条目、
读取载荷、重算 offset / size / SHA256 integrity、原子写盘、从 sourcemap 恢复
jsQR。**不包含任何品牌/品牌构建逻辑**，也不读写业务配置。

只使用 Python 标准库，不依赖 npm / node / 任何第三方包。
"""

from __future__ import annotations

import hashlib
import json
import os
import struct
from pathlib import Path

MAGIC = 4
BLOCK_SIZE = 4 * 1024 * 1024


class InstallerError(Exception):
    """归档读写 / 打包失败（消息为简短中文）。"""


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
# jsQR 提取（从原包 renderer sourcemap 的 sourcesContent 恢复）
# ---------------------------------------------------------------------------


def extract_jsqr(source_archive: str | Path, out_dir: str | Path) -> dict:
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
        "jsQR (UMD build recovered from the original renderer.js.map sourcesContent)\n"
        "Copyright (c) 2016 Cosmo Wolfe and contributors\n"
        "Licensed under the Apache License, Version 2.0:\n"
        "https://github.com/cozmo/jsQR/blob/master/LICENSE\n"
        "\n"
        "This file is bundled for offline use inside 1CT; it is not modified\n"
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