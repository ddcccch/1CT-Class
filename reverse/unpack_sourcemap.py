"""Recover original sources from webpack source maps bundled in app.asar.

Usage::

    python unpack_sourcemap.py --map extracted/dist/main/main.js.map --out sources/main
    python unpack_sourcemap.py --map extracted/dist/renderer/renderer.js.map \
        --out sources/renderer --skip-node-modules
    python unpack_sourcemap.py --map <map> --out <dir> --list   # list only

Writes each ``sourcesContent`` entry to a file under *out*, preserving the path
after ``webpack://<project>/``. Path traversal is rejected.
"""
from __future__ import annotations

import argparse
import json
import os
import re

SAFE_NAME = re.compile(r"^[A-Za-z0-9._@+\-()\[\] ]+$")


def normalize_source(source):
    """Return a safe relative path for a sourcemap ``sources`` entry."""
    s = source.replace("\\", "/")
    # webpack://3CT/./src/main/x.ts  |  webpack://3CT/../node_modules/y  |  file:///...
    marker = "webpack://"
    if marker in s:
        s = s.split(marker, 1)[1]
        # drop the project namespace segment ("3CT/")
        if "/" in s:
            s = s.split("/", 1)[1]
    elif s.startswith("file:///"):
        s = s[len("file:///"):]
    s = s.lstrip("/")
    parts = [p for p in s.split("/") if p not in ("", ".", "..")]
    if not parts:
        parts = ["unknown"]
    # Sanitize each segment; keep readable names.
    return "/".join(
        seg if SAFE_NAME.match(seg) else re.sub(r"[^A-Za-z0-9._@+\-]", "_", seg)
        for seg in parts
    )


def load_map(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def iter_sources(mapping):
    sources = mapping.get("sources") or []
    contents = mapping.get("sourcesContent") or []
    for idx, src in enumerate(sources):
        content = contents[idx] if idx < len(contents) else None
        yield idx, src, content


def unpack(map_path, out_dir, skip_node_modules=False, only=None, dry_run=False):
    mapping = load_map(map_path)
    written = skipped = 0
    seen = {}
    for idx, src, content in iter_sources(mapping):
        if content is None:
            skipped += 1
            continue
        rel = normalize_source(src)
        if skip_node_modules and ("node_modules" in rel.split("/")):
            skipped += 1
            continue
        if only and not any(rel.startswith(p) for p in only):
            skipped += 1
            continue
        if rel in seen:
            rel = rel.replace(".", "~%d." % idx, 1)
        seen[rel] = True
        target = os.path.abspath(os.path.join(out_dir, *rel.split("/")))
        root = os.path.abspath(out_dir)
        if not target.startswith(root + os.sep):
            skipped += 1
            continue
        if not dry_run:
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, "w", encoding="utf-8", newline="\n") as fh:
                fh.write(content)
        written += 1
    return {"written": written, "skipped": skipped, "sources": len(mapping.get("sources") or [])}


def list_sources(map_path, skip_node_modules=True, only=None):
    mapping = load_map(map_path)
    rows = []
    for idx, src, content in iter_sources(mapping):
        rel = normalize_source(src)
        if skip_node_modules and "node_modules" in rel.split("/"):
            continue
        if only and not any(rel.startswith(p) for p in only):
            continue
        rows.append((rel, len(content) if content else 0))
    return sorted(rows)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Recover sources from a webpack source map")
    parser.add_argument("--map", required=True)
    parser.add_argument("--out", default=None)
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--skip-node-modules", action="store_true")
    parser.add_argument("--only", action="append", default=[])
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)

    if args.list or not args.out:
        for rel, size in list_sources(args.map, args.skip_node_modules, args.only):
            print("%9d  %s" % (size, rel))
        return 0

    summary = unpack(args.map, args.out, skip_node_modules=args.skip_node_modules,
                     only=args.only, dry_run=args.dry_run)
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
