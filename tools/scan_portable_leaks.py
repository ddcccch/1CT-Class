# -*- coding: utf-8 -*-
"""扫描便携版 zip 内文本文件是否泄漏本机绝对路径 / profile 残留。"""
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ZIP = ROOT / "dist" / "1CT-1.2.3-完整便携版-fix-20261108.zip"

PATS = [
    b"D:\\1111",
    b"1111/2class",
    b"C:\\Users",
    b"\\Users\\",
    b"AppData",
    b"leveldb",
]

with zipfile.ZipFile(ZIP) as z:
    names = z.namelist()
    hits = []
    for n in names:
        if not n.endswith((".txt", ".cmd", ".yml", ".json")):
            continue
        data = z.read(n)
        for pat in PATS:
            if pat in data:
                hits.append((n, pat.decode("utf-8", "ignore")))
    print("entries =", len(names))
    print("hits =", hits if hits else "none")
    print("PASS" if not hits else "FAIL")
