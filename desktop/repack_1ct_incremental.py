"""严格增量重打包：从「已打过补丁的基线 asar」重建 1CT 的 app.asar。

背景（为什么需要这个脚本）
--------------------------------------------------------------------------
``desktop/install_1ct.py`` 的官方路径是「官方 3CT 原包 → 1CT 副本」：
它要求基线 asar 里仍是**原始 3CT 文案**（``patch_main_js`` 断言 ``n.setToolTip("3CT")``
唯一命中 1 次）。但本仓库的 ``3CT\\`` 源目录已为空、原始基线
（``source_asar_sha256=028d4695…``）在磁盘上不存在，唯一可用基线是
``1CT/resources/app.asar.bak`` —— 它**本身就是打过补丁的 1.2.1 发布 asar**，
于是官方脚本在 main.js 处必然报「期望唯一命中 1 次，实际 0 次」。

这个脚本不是「绕过守卫」，而是补上**幂等语义**：
  * 基线必须是显式给定的 patched 基线，其 sha256 必须与调用方声明一致；
  * 只允许改动白名单条目（``patch_source_map`` 的注入项 + ``REPLACED_PATHS``），
    其余条目必须逐字节不变，否则整次重打包失败；
  * main.js / preload.js 这类「文案/IPC 补丁」在基线已满足后置条件时保留原字节
    （幂等），并逐条记账命中次数，绝不二次改写；
  * 输出前做完整 integrity 复核（每个条目的 integrity 与重算值一致）+ 条目集合
    与顺序不变 + 未改动条目字节不变。

等价性证据（历史快照，2026-10-31 10:1x 实测）
--------------------------------------------------------------------------
那次实测用的输入是一份**冻结快照**（不是现在的 desktop 字节，源码此后已按
业务修复改动，因此「现在的 desktop 字节」不应、也不会再重现 1.2.2）：

* 基线：``1CT/resources/app.asar.bak``
  sha256 ``cec871b2c7ce1dce3f7885181539c710a3ed1520f2fba307f913183b1267c423``
* 快照输入（当时三个唯一变化的条目来源）：
  - ``desktop/1ct/shell.js``  ``2e32fd61edd49f64a0453bb8de269f20bfd666528fd32c446b4a3462106ad27a``
  - ``desktop/1ct/members.js`` ``63d34d253f3245f61c7b256e12eced5af9ba3506b0cc39369ea89cb68f0e0103``
  - ``desktop/automation.js`` ``3af0ac4fb07e42659fcfa6e0c2377431e69e590e6dcedc8ba66e1c23df149d25``
* 那次输出：sha256 ``fa8acd3236cd26feb1822ae6bf4ed431910540c022309fa4e2c536d9601ef692``，
  56437878 字节，与当时现装的 ``1CT/resources/app.asar`` 逐字节相同
  （360 条目 0 差异；相对基线仅上述 3 个条目变化，integrity 全过）。

该结论由 ``tests/test_repack_1ct_incremental.py`` 里的「快照等价」用例守护：
**只有当输入 sha 仍等于上面这组快照值时**才断言输出 == ``fa8acd32…``，
否则 skip —— 避免把历史结论误当成「当前源码可重现 1.2.2」。

用法
--------------------------------------------------------------------------
    python desktop/repack_1ct_incremental.py \\
        --baseline 1CT/resources/app.asar.bak \\
        --out dist/1CT-1.2.3/1CT/resources/app.asar \\
        --expect-baseline-sha cec871b2c7ce1dce3f7885181539c710a3ed1520f2fba307f913183b1267c423 \\
        --expect-inputs-sha dist/1CT-1.2.3/inputs-freeze.json \\
        --report dist/1CT-1.2.3/repack-report.json

``--expect-baseline-sha`` 是**必填**的（正式构建必须声明基线身份）；
``--expect-inputs-sha`` 可选，传入则对补丁素材做冻结校验（源码变了就拒绝构建）。

安全约束
--------------------------------------------------------------------------
* 默认拒绝写入任何带 ``.1ct-install.json`` 的目录（即已安装的 1CT 副本），
  必须显式 ``--allow-in-place`` 才允许；安装目录的原地 patch 走
  ``install_1ct.py`` 自己的流程，不归本脚本管。
* **即使 ``--allow-in-place``**，输出路径等于基线路径也一律拒绝（会毁掉唯一基线）。
* 只支持普通文件条目：基线/产物出现 ``link``/``unpacked`` 条目、或条目缺 integrity
  时直接拒绝，绝不「跳过一部分却声称全量 integrity」。
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
INSTALLER_PATH = REPO_ROOT / "desktop" / "install_1ct.py"
DEFAULT_DESKTOP_DIR = REPO_ROOT / "desktop"
MARKER_NAME = ".1ct-install.json"


class RepackError(RuntimeError):
    """重打包前置条件或后置校验失败（一律中止，不产出半成品）。"""


def _load_installer(path: Path = INSTALLER_PATH):
    """加载 desktop/install_1ct.py（复用它的 asar 原语与全部补丁函数）。"""

    spec = importlib.util.spec_from_file_location("desktop_install_1ct_for_repack", path)
    if spec is None or spec.loader is None:  # pragma: no cover - 环境异常
        raise RepackError(f"无法加载 {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def allowed_paths(installer) -> set[str]:
    """本次重打包**允许**发生变化的 asar 条目（其余必须逐字节不变）。"""

    injected = set(installer.patch_source_map(DEFAULT_DESKTOP_DIR).keys())
    return injected | set(installer.REPLACED_PATHS)


def input_manifest(desktop_dir: Path) -> dict[str, dict[str, Any]]:
    """补丁素材清单：asar 路径 → {source, sha256, size}（用于冻结输入）。

    ``--expect-inputs-sha`` 就是拿这份清单的 sha256 去比对，防止「构建时读到的
    源文件」与评审/冻结时看到的不是同一份字节（并发改写、忘保存、编辑器重排）。
    """

    installer = _load_installer()
    desktop_dir = Path(desktop_dir).resolve()
    manifest: dict[str, dict[str, Any]] = {}
    for archive_path, source in sorted(installer.patch_source_map(desktop_dir).items()):
        data = source.read_bytes()
        manifest[archive_path] = {
            "source": source.name if source.parent == desktop_dir / "1ct" else str(source),
            "sha256": sha256_bytes(data),
            "size": len(data),
        }
    return manifest


def manifest_from_inputs(
    installer, desktop_dir: Path, inputs: dict[str, bytes]
) -> dict[str, dict[str, Any]]:
    """用**构建时真正读到的字节**生成素材清单（而不是另读一遍磁盘）。

    这一点很重要：``input_manifest()`` 是给评审/冻结用的独立读数，若构建路径再读一次
    磁盘，两次读之间源文件被改写就会形成 TOCTOU 窗口——冻结清单校验的是旧字节，
    实际打进 asar 的却是新字节。这里统一从 ``load_patch_inputs()`` 的返回值算 sha，
    保证「校验的字节」与「打包的字节」是同一份内存数据。
    """

    desktop_dir = Path(desktop_dir).resolve()
    sources = installer.patch_source_map(desktop_dir)
    manifest: dict[str, dict[str, Any]] = {}
    for archive_path in sorted(sources):
        source = sources[archive_path]
        data = inputs[archive_path]
        manifest[archive_path] = {
            "source": source.name if source.parent == desktop_dir / "1ct" else str(source),
            "sha256": sha256_bytes(data),
            "size": len(data),
        }
    return manifest


def _check_input_freeze(
    manifest: dict[str, dict[str, Any]], expect_inputs_sha: dict[str, str]
) -> None:
    """输入冻结校验：清单必须是**完整集合**，且每个 sha256 与构建字节一致。

    只遍历「声明的键」是错的——传一份单项清单也能通过，冻结就失去意义。
    这里先比集合（漏项/多余都拒绝），再逐项比 sha。
    """

    if not isinstance(expect_inputs_sha, dict):
        raise RepackError("冻结清单必须是 {asar 路径: sha256} 的字典")
    if not expect_inputs_sha:
        raise RepackError(
            "冻结清单为空（显式传了 {}）：拒绝把「没声明任何素材」当成「全部冻结」"
        )

    expected_paths = set(expect_inputs_sha)
    actual_paths = set(manifest)
    missing = sorted(expected_paths - actual_paths)
    extra = sorted(actual_paths - expected_paths)
    if missing or extra:
        raise RepackError(
            "冻结清单与实际补丁素材不是同一集合，拒绝构建："
            f"漏项={missing[:5]}（清单里没有、素材里存在）"
            f" 多余={extra[:5]}（清单里有、素材里不存在）"
            f" 期望 {len(expected_paths)} 项 / 实际 {len(actual_paths)} 项"
        )

    mismatched = []
    for archive_path in sorted(expect_inputs_sha):
        row = manifest[archive_path]
        expected = str(expect_inputs_sha[archive_path]).strip().lower()
        if not expected:
            mismatched.append(f"{archive_path}: 冻结值为空")
        elif row["sha256"].lower() != expected:
            mismatched.append(
                f"{archive_path}: 构建字节={row['sha256'][:12]} 冻结={expected[:12]}"
            )
    if mismatched:
        raise RepackError(
            "补丁素材与冻结清单不一致，拒绝构建（源码已变或冻结清单过期）："
            + "；".join(mismatched)
        )


def _read_entries(installer, archive: Path) -> tuple[dict[str, dict], int, list[str]]:
    header, data_base = installer.read_header(archive)
    files = dict(installer.iter_files(header))
    return files, data_base, list(files.keys())


def _patch_main_js_idempotent(installer, main_bytes: bytes) -> tuple[bytes, dict[str, Any]]:
    """main.js 文案补丁；基线已打过补丁时保留原字节并逐条记账。

    与 ``install_1ct.py`` 的严格守卫等价，只多一种合法状态：
    「旧串 0 次 + 新串 1 次 + 功能性保护串全在」= 已应用（幂等）。
    """

    try:
        patched, applied = installer.patch_main_js(main_bytes)
        return patched, {
            "state": "patched-from-3ct",
            "applied": [
                {"label": row["label"], "count": row["count"], "offset": row["offset"]}
                for row in applied
            ],
        }
    except installer.InstallerError as exc:
        text = main_bytes.decode("utf-8")
        checks = [
            {
                "label": label,
                "old_count": text.count(old),
                "new_count": text.count(new),
            }
            for label, old, new in installer.MAIN_JS_TEXT_REPLACEMENTS
        ]
        missing_protected = [n for n in installer.PROTECTED_MAIN_JS_STRINGS if n not in text]
        idempotent_ok = all(
            row["old_count"] == 0 and row["new_count"] == 1 for row in checks
        )
        if not idempotent_ok or missing_protected:
            raise RepackError(
                "基线 main.js 既不是原始 3CT 文案、也不是已应用状态："
                f"{checks} 缺失保护串={missing_protected}；installer 原始错误={exc}"
            ) from exc
        return main_bytes, {"state": "already-applied", "checks": checks}


def build_patched_bytes(
    baseline: Path,
    desktop_dir: Path,
    *,
    expect_baseline_sha: str,
    product_name: str | None = None,
    expect_inputs_sha: dict[str, str] | None = None,
) -> tuple[bytes, dict[str, Any]]:
    """在内存里生成重打包后的 asar 字节，并返回记账信息。

    *expect_baseline_sha* 是**必填**的：正式构建必须声明「我以为的基线是哪个 sha」，
    否则「基线被换掉」这类事故无法在构建期发现。*expect_inputs_sha* 可选，
    传入则对补丁素材做冻结校验。
    """

    if not expect_baseline_sha or not str(expect_baseline_sha).strip():
        raise RepackError("必须显式声明基线 sha256（expect_baseline_sha），拒绝在未声明基线的情况下构建")

    installer = _load_installer()
    baseline = Path(baseline).resolve()
    desktop_dir = Path(desktop_dir).resolve()
    if not baseline.is_file():
        raise RepackError(f"基线 asar 不存在: {baseline}")

    baseline_sha = sha256_file(baseline)
    if baseline_sha.lower() != str(expect_baseline_sha).strip().lower():
        raise RepackError(
            "基线 asar 的 sha256 与声明不一致，拒绝重打包："
            f"磁盘={baseline_sha} 声明={expect_baseline_sha}"
        )

    # 只读一次素材：校验用这份内存字节，打包也用这份内存字节（消除 TOCTOU 窗口）。
    inputs = installer.load_patch_inputs(desktop_dir)
    manifest = manifest_from_inputs(installer, desktop_dir, inputs)
    if expect_inputs_sha is not None:
        _check_input_freeze(manifest, expect_inputs_sha)

    header, data_base = installer.read_header(baseline)
    index_node = installer.find_node(header, installer.INDEX_HTML_PATH)
    package_node = installer.find_node(header, installer.PACKAGE_JSON_PATH)
    main_node = installer.find_node(header, installer.MAIN_JS_PATH)
    preload_node = installer.find_node(header, installer.PRELOAD_JS_PATH)
    for label, node in (
        ("index.html", index_node),
        ("package.json", package_node),
        ("main.js", main_node),
        ("preload.js", preload_node),
    ):
        if node is None:
            raise RepackError(f"基线 asar 缺少 {label}，无法增量重打包")

    # 基线必须是「已打补丁的 1CT 包」：注入路径本来就存在，才能保证条目集合不变。
    present = {path for path, _node in installer.iter_files(header)}
    absent = sorted(allowed_paths(installer) - present)
    if absent:
        raise RepackError(
            "基线不是已打补丁的 1CT 包（缺少注入路径 "
            + ", ".join(absent[:4])
            + " 等 "
            + str(len(absent))
            + " 项）：请用 1CT 发布包/回滚包作基线，不要用官方 3CT 原包"
        )

    replacements: dict[str, bytes] = dict(inputs)

    original_index = installer.read_file(baseline, index_node, data_base)
    replacements[installer.INDEX_HTML_PATH] = installer.prepare_index_html(
        inputs[installer.ONECT_INDEX_ASAR_PATH], original_index
    )
    replacements[installer.PACKAGE_JSON_PATH] = installer.patch_package_json(
        installer.read_file(baseline, package_node, data_base), product_name=product_name
    )
    patched_main, main_note = _patch_main_js_idempotent(
        installer, installer.read_file(baseline, main_node, data_base)
    )
    replacements[installer.MAIN_JS_PATH] = patched_main
    replacements[installer.PRELOAD_JS_PATH] = installer.patch_preload_js(
        installer.read_file(baseline, preload_node, data_base)
    )

    patched_bytes = installer.rebuild_asar(baseline, replacements)
    note = {
        "baseline": str(baseline),
        "baseline_sha256": baseline_sha,
        "desktop_dir": str(desktop_dir),
        "inputs_manifest": manifest,
        "inputs_frozen": expect_inputs_sha is not None,
        # 后置校验用：产物里这些条目的字节必须等于构建时读到的输入字节。
        "expect_entry_sha": {path: row["sha256"] for path, row in manifest.items()},
        "injected_inputs": {
            path: row["sha256"] for path, row in manifest.items()
        },
        "main_js": main_note,
        "preload_js": {"state": "idempotent-or-patched"},
        "replaced_entries": sorted(replacements.keys()),
    }
    return patched_bytes, note


def verify_incremental(
    installer,
    baseline: Path,
    patched: Path,
    allowed: set[str],
    expect_entry_sha: dict[str, str] | None = None,
) -> dict[str, Any]:
    """完整后置校验：条目集合/顺序、integrity、未改动条目字节不变。

    *expect_entry_sha* 是**产物侧**的注入源校验：{asar 路径: sha256}，取自构建时
    真正读到的内存字节（见 ``manifest_from_inputs``）。它把「打包时读到的素材」
    与「最终写进 asar 的字节」钉在一起，避免构建中途源文件被改写（TOCTOU）。
    """

    baseline_files, baseline_base, baseline_order = _read_entries(installer, baseline)
    patched_files, patched_base, patched_order = _read_entries(installer, patched)

    if baseline_order != patched_order:
        missing = sorted(set(baseline_order) - set(patched_order))
        added = sorted(set(patched_order) - set(baseline_order))
        raise RepackError(
            "重打包改变了 asar 条目集合或顺序："
            f"缺失={missing[:5]} 新增={added[:5]}"
        )

    # 只支持普通文件条目：link/unpacked 既无法逐字节比对，也无法保证 integrity，
    # 与其「跳过并声称全量校验」，不如直接拒绝（本基线 360 条均为普通条目）。
    for label, nodes in (("基线", baseline_files), ("产物", patched_files)):
        unsupported = sorted(
            path for path, node in nodes.items() if node.get("link") or node.get("unpacked")
        )
        if unsupported:
            raise RepackError(
                f"{label}含不支持的 link/unpacked 条目（本工具只处理普通文件条目）: "
                + ", ".join(unsupported[:5])
            )

    changed: list[dict[str, Any]] = []
    unchanged: list[str] = []
    integrity_checked = 0
    source_checked = 0
    for path in patched_order:
        node = patched_files[path]
        data = installer.read_file(patched, node, patched_base)
        expected_integrity = node.get("integrity")
        if not isinstance(expected_integrity, dict) or not expected_integrity:
            raise RepackError(
                f"产物条目缺少 integrity，无法做完整校验（拒绝产出）: {path}"
            )
        recomputed = installer.integrity_for(data)
        if recomputed != expected_integrity:
            raise RepackError(f"integrity 复核失败: {path}")
        integrity_checked += 1

        if expect_entry_sha is not None and path in expect_entry_sha:
            expected_source = str(expect_entry_sha[path]).strip().lower()
            actual_source = sha256_bytes(data)
            if not expected_source or actual_source != expected_source:
                raise RepackError(
                    f"产物条目字节与构建时读到的注入素材不一致（TOCTOU/串包）: {path}"
                    f"（产物={actual_source[:12]} 输入={expected_source[:12] or '空'}）"
                )
            source_checked += 1

        baseline_data = installer.read_file(baseline, baseline_files[path], baseline_base)
        if data == baseline_data:
            unchanged.append(path)
            continue
        if path not in allowed:
            raise RepackError(
                f"出现白名单之外的条目变化，拒绝产出: {path}"
                f"（baseline={sha256_bytes(baseline_data)[:12]} patched={sha256_bytes(data)[:12]}）"
            )
        changed.append(
            {
                "path": path,
                "baseline_size": len(baseline_data),
                "patched_size": len(data),
                "baseline_sha256": sha256_bytes(baseline_data),
                "patched_sha256": sha256_bytes(data),
            }
        )

    if integrity_checked != len(patched_order):
        # 走不到这里（上面已逐条强制），保留断言防止日后改动悄悄放宽。
        raise RepackError(
            f"integrity 覆盖不完整：{integrity_checked}/{len(patched_order)}（拒绝声称全量校验）"
        )

    unchanged_digest = hashlib.sha256(
        "\n".join(
            f"{path}:{sha256_bytes(installer.read_file(patched, patched_files[path], patched_base))}"
            for path in unchanged
        ).encode("utf-8")
    ).hexdigest()

    if expect_entry_sha is not None and source_checked != len(expect_entry_sha):
        raise RepackError(
            "注入源校验覆盖不完整："
            f"{source_checked}/{len(expect_entry_sha)}（清单里有产物不存在的条目）"
        )

    return {
        "entries": len(patched_order),
        "integrity_checked": integrity_checked,
        "source_checked": source_checked,
        "changed_entries": changed,
        "unchanged_entries": len(unchanged),
        "unchanged_digest_sha256": unchanged_digest,
        "allowed_entries": sorted(allowed),
    }


def _refuse_installed_target(out_path: Path) -> None:
    """默认拒绝写入已安装的 1CT 副本（避免误覆写用户正在用的程序）。"""

    for parent in [out_path.parent, *out_path.parents]:
        if (parent / MARKER_NAME).is_file():
            raise RepackError(
                f"拒绝写入已安装的 1CT 副本: {parent}"
                f"（含 {MARKER_NAME}）；如确需原地替换请显式 --allow-in-place"
            )


def repack(
    baseline: Path,
    out_path: Path,
    *,
    expect_baseline_sha: str,
    desktop_dir: Path = DEFAULT_DESKTOP_DIR,
    expect_inputs_sha: dict[str, str] | None = None,
    expect_output_sha: str | None = None,
    product_name: str | None = None,
    report_path: Path | None = None,
    allow_in_place: bool = False,
) -> dict[str, Any]:
    """执行一次严格增量重打包，返回报告（失败抛 RepackError，不产出半成品）。"""

    installer = _load_installer()
    baseline = Path(baseline).resolve()
    out_path = Path(out_path).resolve()
    if out_path == baseline or (out_path.exists() and out_path.samefile(baseline)):
        # 即使 --allow-in-place 也拒绝：把产物写回基线等于当场销毁唯一的可用基线。
        raise RepackError(
            f"输出路径与基线相同，拒绝构建（会毁掉基线）: {out_path}；"
            "请输出到新目录（例如 dist/1CT-1.2.3/1CT/resources/app.asar）"
        )
    if not allow_in_place:
        _refuse_installed_target(out_path)

    baseline_sha_before = sha256_file(baseline)
    patched_bytes, note = build_patched_bytes(
        baseline,
        desktop_dir,
        expect_baseline_sha=expect_baseline_sha,
        product_name=product_name,
        expect_inputs_sha=expect_inputs_sha,
    )
    output_sha = sha256_bytes(patched_bytes)
    if expect_output_sha and output_sha.lower() != expect_output_sha.lower():
        raise RepackError(
            "输出 sha256 与声明不一致："
            f"实际={output_sha} 声明={expect_output_sha}（输入可能已变，请核对注入源文件）"
        )

    out_path.parent.mkdir(parents=True, exist_ok=True)
    # 唯一临时名：同一输出目录内（保证 os.replace 原子），但绝不与历史残留或并发构建撞名。
    fd, tmp_name = tempfile.mkstemp(
        prefix="." + out_path.name + ".", suffix=".repack-tmp", dir=str(out_path.parent)
    )
    os.close(fd)
    tmp_path = Path(tmp_name)
    try:
        tmp_path.write_bytes(patched_bytes)
        evidence = verify_incremental(
            installer,
            baseline,
            tmp_path,
            allowed_paths(installer),
            expect_entry_sha=note["expect_entry_sha"],
        )
        # 后置基线校验：构建过程（含写入/校验）不得改动基线一个字节，否则拒绝产出。
        baseline_sha_after = sha256_file(baseline)
        if baseline_sha_after != baseline_sha_before:
            raise RepackError(
                "基线在构建过程中被改动，拒绝产出："
                f"构建前={baseline_sha_before} 构建后={baseline_sha_after}"
            )
        os.replace(tmp_path, out_path)
    except BaseException:
        tmp_path.unlink(missing_ok=True)
        raise

    report = {
        "generator": "desktop/repack_1ct_incremental.py",
        "mode": "strict-incremental",
        "output": str(out_path),
        "output_sha256": output_sha,
        "output_size": len(patched_bytes),
        "baseline_sha256_before": baseline_sha_before,
        "baseline_sha256_after": baseline_sha_after,
        "baseline_unchanged": True,
        "tmp_strategy": "tempfile.mkstemp(dir=out.parent)",
        **note,
        "verification": evidence,
    }
    if report_path is not None:
        report_path = Path(report_path)
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(
            json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8"
        )
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="从已打补丁的基线 asar 严格增量重建 1CT app.asar（幂等补丁 + 条目不变校验）"
    )
    parser.add_argument("--baseline", required=True, help="已打补丁的基线 app.asar（例如 1CT/resources/app.asar.bak）")
    parser.add_argument("--out", required=True, help="输出 app.asar 路径（默认拒绝写入已安装副本）")
    parser.add_argument(
        "--expect-baseline-sha",
        required=True,
        help="基线 sha256 断言（必填：正式构建必须声明基线身份，不一致即中止）",
    )
    parser.add_argument("--desktop-dir", default=str(DEFAULT_DESKTOP_DIR), help="补丁素材目录（默认 desktop/）")
    parser.add_argument(
        "--expect-inputs-sha",
        default=None,
        help="补丁素材冻结清单 JSON（{asar路径: sha256} 或含 inputs_manifest 的报告），不一致即中止",
    )
    parser.add_argument("--expect-output-sha", default=None, help="输出 sha256 断言（不一致即中止）")
    parser.add_argument("--product-name", default=None, help="覆盖 package.json productName（不推荐）")
    parser.add_argument("--report", default=None, help="把完整报告写成 JSON")
    parser.add_argument(
        "--allow-in-place",
        action="store_true",
        help="允许写入含 .1ct-install.json 的目录（危险：会覆盖用户正在用的程序）",
    )
    args = parser.parse_args(argv)

    expect_inputs_sha = None
    if args.expect_inputs_sha:
        try:
            frozen = json.loads(Path(args.expect_inputs_sha).read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            print(f"错误: 无法读取冻结清单 {args.expect_inputs_sha}: {exc}", file=sys.stderr)
            return 1
        if isinstance(frozen, dict) and isinstance(frozen.get("inputs_manifest"), dict):
            expect_inputs_sha = {
                path: row.get("sha256", "")
                for path, row in frozen["inputs_manifest"].items()
            }
        elif isinstance(frozen, dict):
            expect_inputs_sha = {str(k): str(v) for k, v in frozen.items()}
        else:
            print("错误: 冻结清单格式应为 {asar路径: sha256} 或含 inputs_manifest 的报告", file=sys.stderr)
            return 1

    try:
        report = repack(
            Path(args.baseline),
            Path(args.out),
            expect_baseline_sha=args.expect_baseline_sha,
            desktop_dir=Path(args.desktop_dir),
            expect_inputs_sha=expect_inputs_sha,
            expect_output_sha=args.expect_output_sha,
            product_name=args.product_name,
            report_path=Path(args.report) if args.report else None,
            allow_in_place=args.allow_in_place,
        )
    except RepackError as exc:
        print(f"错误: {exc}", file=sys.stderr)
        return 1

    print(
        json.dumps(
            {
                "output": report["output"],
                "output_sha256": report["output_sha256"],
                "output_size": report["output_size"],
                "baseline_sha256": report["baseline_sha256"],
                "changed_entries": [
                    {"path": row["path"], "size": row["patched_size"]}
                    for row in report["verification"]["changed_entries"]
                ],
                "unchanged_entries": report["verification"]["unchanged_entries"],
                "integrity_checked": report["verification"]["integrity_checked"],
                "main_js": report["main_js"]["state"],
            },
            indent=2,
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
