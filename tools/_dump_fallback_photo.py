# -*- coding: utf-8 -*-
"""把 data URL 形式的图片落盘，便于肉眼确认是否为真人照片。"""
import base64
import re
import sys
from pathlib import Path

src = Path(sys.argv[1])
out = Path(sys.argv[2])
s = src.read_text(encoding="utf-8", errors="ignore")
m = re.search(r"data:image/([a-z]+);base64,([A-Za-z0-9+/=]+)", s)
if not m:
    print("no data url")
    raise SystemExit(1)
data = base64.b64decode(m.group(2))
out.write_bytes(data)
print(f"fmt={m.group(1)} bytes={len(data)} -> {out}")
