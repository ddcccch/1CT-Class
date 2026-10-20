"""Minimal, dependency-free ASAR reader/extractor.

Only Python standard library. Designed for offline analysis of Electron
``app.asar`` archives: read the Chromium-pickle header, list the virtual file
tree, and extract selected subtrees while skipping huge trees such as
``node_modules``.

ASAR layout (Chromium pickle)::

    offset 0   uint32  4                (header size field of the outer pickle)
    offset 4   uint32  header_size      (bytes of the inner pickle below)
    offset 8   uint32  str_pickle_size  (bytes of the string pickle)
    offset 12  uint32  json_len         (JSON header length)
    offset 16  bytes   json header      (the file tree)
    ...        padding to 4-byte align
    data_base = 8 + header_size         (first payload byte)

Each JSON file node is ``{"size": N, "offset": "byte-offset-from-data_base"}``;
directories are ``{"files": {...}}``. ``"unpacked": true`` means the payload
lives next to the archive in ``<archive>.unpacked``. ``"link"`` nodes are
symlinks inside the archive.

Usage::

    python asar_extract.py --archive app.asar --list
    python asar_extract.py --archive app.asar --out extracted \
        --skip node_modules --only "dist/" --only "package.json"
"""
from __future__ import annotations

import argparse
import json
import os
import struct
import sys

MAGIC = 4  # first uint32 of every valid ASAR header
DEFAULT_SKIP = {"node_modules"}


class AsarError(Exception):
    """Raised when the archive is malformed or unreadable."""


def read_header(archive):
    """Return ``(header_tree, data_base)`` for *archive*."""
    try:
        with open(archive, "rb") as fh:
            head = fh.read(16)
            if len(head) < 16:
                raise AsarError("%s: file too short to be an ASAR" % archive)
            magic, header_size, _str_pickle_size, json_len = struct.unpack("<IIII", head)
            if magic != MAGIC:
                raise AsarError(
                    "%s: unexpected ASAR magic %d (expected %d)" % (archive, magic, MAGIC)
                )
            if json_len <= 0 or header_size < json_len or header_size > 512 * 1024 * 1024:
                raise AsarError(
                    "%s: implausible header sizes header_size=%d json_len=%d"
                    % (archive, header_size, json_len)
                )
            fh.seek(16)
            raw = fh.read(json_len)
    except OSError as exc:  # pragma: no cover - environment-specific
        raise AsarError("%s: cannot read: %s" % (archive, exc)) from exc

    if len(raw) != json_len:
        raise AsarError("%s: truncated JSON header" % archive)
    try:
        header = json.loads(raw.decode("utf-8", "replace"))
    except ValueError as exc:
        raise AsarError("%s: invalid JSON header: %s" % (archive, exc)) from exc
    if not isinstance(header, dict):
        raise AsarError("%s: header is not a JSON object" % archive)
    header.setdefault("files", {})
    data_base = 8 + header_size
    return header, data_base


def is_dir(node):
    return isinstance(node, dict) and "files" in node


def is_unpacked(node):
    return isinstance(node, dict) and bool(node.get("unpacked"))


def is_link(node):
    return isinstance(node, dict) and "link" in node


def iter_files(tree, prefix=""):
    """Yield ``(relative_path, node)`` for every file node, depth-first."""
    files = tree.get("files") if isinstance(tree, dict) else None
    if not isinstance(files, dict):
        return
    for name in sorted(files):
        node = files[name]
        rel = prefix + name
        if is_dir(node):
            yield from iter_files(node, rel + "/")
        else:
            yield rel, node


def walk(header):
    """Yield ``(relative_path, node)`` including directories.

    Directory nodes are yielded before their children.
    """
    def rec(node, prefix):
        for name in sorted(node.get("files", {})):
            child = node["files"][name]
            rel = prefix + name
            yield rel, child
            if is_dir(child):
                yield from rec(child, rel + "/")

    if not isinstance(header, dict):
        return
    yield from rec(header, "")


def _format_size(node):
    if is_link(node):
        return "-> " + str(node.get("link"))
    return str(node.get("size", "?"))


def list_tree(header):
    """Return human-readable listing lines, one per entry."""
    lines = []
    for rel, node in walk(header):
        if is_dir(node):
            lines.append("D %s/" % rel)
        elif is_unpacked(node):
            lines.append("U %s %s" % (rel, _format_size(node)))
        elif is_link(node):
            lines.append("L %s %s" % (rel, _format_size(node)))
        else:
            lines.append("  %s %s" % (rel, _format_size(node)))
    return lines


def _safe_target(out_dir, rel):
    """Return an absolute path inside *out_dir* or raise AsarError."""
    rel = rel.replace("\\", "/")
    if rel.startswith("/") or ":" in rel.split("/")[0]:
        raise AsarError("absolute path in archive: %r" % rel)
    parts = [p for p in rel.split("/") if p not in ("", ".")]
    if any(p == ".." for p in parts):
        raise AsarError("path traversal in archive: %r" % rel)
    target = os.path.abspath(os.path.join(out_dir, *parts))
    root = os.path.abspath(out_dir)
    if target != root and not target.startswith(root + os.sep):
        raise AsarError("path escapes output dir: %r" % rel)
    return target


def _select(rel, node, only_prefixes, skip_dir_names, skip_names, unpacked_only):
    parts = rel.replace("\\", "/").split("/")
    if skip_dir_names and any(p in skip_dir_names for p in parts[:-1]):
        return False
    if is_dir(node):
        # prune whole directories up front
        return not (skip_dir_names and parts[-1] in skip_dir_names)
    if skip_names and parts[-1] in skip_names:
        return False
    if unpacked_only and not is_unpacked(node):
        return False
    if only_prefixes:
        norm = rel.replace("\\", "/")
        return any(norm == p or norm.startswith(p) for p in only_prefixes)
    return True


def extract_tree(archive, header, data_base, out_dir, only_prefixes=None,
                 skip_dir_names=None, skip_names=None, unpacked_only=False):
    """Extract selected nodes. Return a summary dict.

    ``blocked`` lists archive paths rejected as unsafe (traversal/absolute).
    """
    only_prefixes = [p.replace("\\", "/") for p in (only_prefixes or [])]
    skip_dir_names = set(skip_dir_names or ())
    skip_names = set(skip_names or ())
    os.makedirs(out_dir, exist_ok=True)
    unpacked_root = archive + ".unpacked"
    summary = {"extracted": 0, "skipped": 0, "blocked": [], "unpacked": 0,
               "links": 0, "bytes": 0, "errors": []}

    counts = {"total": 0}
    for rel, node in iter_files(header):
        counts["total"] += 1
        if not _select(rel, node, only_prefixes, skip_dir_names, skip_names, unpacked_only):
            summary["skipped"] += 1
            continue
        try:
            target = _safe_target(out_dir, rel)
        except AsarError:
            summary["blocked"].append(rel)
            continue
        if is_link(node):
            summary["links"] += 1
            continue
        try:
            data = read_file(archive, node, data_base, unpacked_root)
        except (AsarError, OSError) as exc:
            summary["errors"].append("%s: %s" % (rel, exc))
            continue
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, "wb") as fh:
            fh.write(data)
        summary["extracted"] += 1
        summary["bytes"] += len(data)
        if is_unpacked(node):
            summary["unpacked"] += 1
    summary["total"] = counts["total"]
    return summary


def read_file(archive, node, data_base, unpacked_root=None):
    """Return the bytes of one file node."""
    if is_unpacked(node):
        if not unpacked_root:
            raise AsarError("unpacked node but no unpacked root")
        rel = node.get("_path")
        if rel is None:
            raise AsarError("unpacked node without a known path")
        with open(os.path.join(unpacked_root, *rel.split("/")), "rb") as fh:
            return fh.read()
    size = int(node.get("size", 0))
    offset = int(node.get("offset", 0))
    with open(archive, "rb") as fh:
        fh.seek(data_base + offset)
        data = fh.read(size)
    if len(data) != size:
        raise AsarError("truncated payload (wanted %d, got %d)" % (size, len(data)))
    return data


def extract(archive, out_dir, only_prefixes=None, skip_dir_names=None,
            skip_names=None, unpacked_only=False):
    """Read header then extract. See :func:`extract_tree`."""
    header, data_base = read_header(archive)
    return extract_tree(archive, header, data_base, out_dir,
                        only_prefixes=only_prefixes,
                        skip_dir_names=skip_dir_names,
                        skip_names=skip_names,
                        unpacked_only=unpacked_only)


def _cmd_list(archive, pattern=None):
    header, _ = read_header(archive)
    total = 0
    for line in list_tree(header):
        total += 1
        if pattern is None or pattern.lower() in line.lower():
            print(line)
    print("# %d entries" % total, file=sys.stderr)


def main(argv=None):
    parser = argparse.ArgumentParser(description="List/extract Electron app.asar")
    parser.add_argument("--archive", required=True, help="path to app.asar")
    parser.add_argument("--list", action="store_true", help="print file tree")
    parser.add_argument("--grep", default=None, help="case-insensitive filter for --list")
    parser.add_argument("--out", default=None, help="output directory for extraction")
    parser.add_argument("--only", action="append", default=[],
                        help="extract only these archive path prefixes (repeatable)")
    parser.add_argument("--skip", action="append", default=[],
                        help="skip directory names (repeatable; default: node_modules)")
    parser.add_argument("--skip-file", action="append", default=[],
                        help="skip file base names (repeatable)")
    parser.add_argument("--keep-node-modules", action="store_true",
                        help="do not skip node_modules")
    parser.add_argument("--unpacked-only", action="store_true",
                        help="extract only nodes stored in app.asar.unpacked")
    args = parser.parse_args(argv)

    if args.list or not args.out:
        _cmd_list(args.archive, args.grep)
        if not args.out:
            return 0

    skip = set(args.skip)
    if not args.keep_node_modules:
        skip |= DEFAULT_SKIP
    summary = extract(args.archive, args.out, only_prefixes=args.only,
                      skip_dir_names=skip, skip_names=set(args.skip_file),
                      unpacked_only=args.unpacked_only)
    print(json.dumps(summary, indent=2))
    return 0 if not summary["errors"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
