# -*- coding: utf-8 -*-
"""校验 asar 内若干条目与 desktop/ 源码逐字节一致。"""
import hashlib
import json
import struct
import sys
from pathlib import Path

PAIRS = [
    ("dist/renderer/automation.js", "desktop/automation.js"),
    ("dist/renderer/1ct/shell.js", "desktop/1ct/shell.js"),
    ("dist/renderer/1ct/members.js", "desktop/1ct/members.js"),
    ("dist/main/auto-bootstrap.cjs", "desktop/1ct/bootstrap-1ct.cjs"),
    ("dist/renderer/1ct/fallback-photo.js", "desktop/1ct/fallback-photo.js"),
]


def read_asar(path: Path) -> dict[str, bytes]:
    data = path.read_bytes()
    header_size = struct.unpack("<I", data[4:8])[0]
    json_size = struct.unpack("<I", data[12:16])[0]
    base = 8 + header_size
    header = json.loads(data[16:16 + json_size].decode("utf-8"))

    out: dict[str, bytes] = {}

    def walk(node, prefix=""):
        for name, info in node.get("files", {}).items():
            p = f"{prefix}/{name}" if prefix else name
            if "files" in info:
                walk(info, p)
            else:
                off = int(info["offset"])
                size = int(info["size"])
                out[p] = data[base + off: base + off + size]

    walk(header)
    return out


def main() -> None:
    asar = Path(sys.argv[1])
    entries = read_asar(asar)
    print(f"{asar}  root={asar.parent.name}  entries={len(entries)}  sha256={hashlib.sha256(asar.read_bytes()).hexdigest()}")
    ok = True
    for entry, src in PAIRS:
        got = entries.get(entry)
        want = Path(src).read_bytes()
        same = got == want
        ok = ok and same
        print(f"  {'OK  ' if same else 'DIFF'} {entry}  asar={len(got) if got is not None else None}B  src={len(want)}B  src_sha={hashlib.sha256(want).hexdigest()[:16]}")
    print("ALL_BYTE_IDENTICAL" if ok else "MISMATCH")
    raise SystemExit(0 if ok else 1)


if __name__ == "__main__":
    main()
