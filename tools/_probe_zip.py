# -*- coding: utf-8 -*-
import re
import zipfile
from pathlib import Path

p = Path("desktop/1ct/fallback-photo.js")
s = p.read_text(encoding="utf-8", errors="ignore")
m = re.search(r"data:image/[a-z]+;base64,([A-Za-z0-9+/=]+)", s)
print("fallback-photo.js bytes:", p.stat().st_size, "b64 len:", len(m.group(1)) if m else None)

marks = [
    "成信", "航空港", "龙泉", r"D:\1111", "1111/2class", r"C:\Users", "\\Users\\",
    "18788907622", "30.583253", "103.986817", "cuit_konggang", "兑",
]

z = "dist/1CT-1.2.3-完整便携版-fix-20261108.zip"
with zipfile.ZipFile(z) as f:
    for i in f.infolist():
        if i.is_dir():
            continue
        if i.filename.lower().endswith((".txt", ".cmd", ".json", ".html", ".js", ".cjs")):
            body = f.read(i.filename).decode("utf-8", "ignore")
            hit = [mk for mk in marks if mk in body]
            print(f"{i.filename}  {i.file_size}B  hits={hit}")
