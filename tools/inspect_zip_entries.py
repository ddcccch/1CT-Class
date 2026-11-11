# -*- coding: utf-8 -*-
"""列出交付包的条目清单并抽查是否夹带用户数据。"""
import sys
import zipfile
from pathlib import Path

z = Path(sys.argv[1] if len(sys.argv) > 1 else "dist/1CT-1.2.3-完整便携版-fix-20261108.zip")
with zipfile.ZipFile(z) as f:
    infos = [i for i in f.infolist() if not i.is_dir()]
    print(f"条目数 {len(infos)}  总解压 {sum(i.file_size for i in infos)} B")
    weird = []
    for i in infos:
        n = i.filename
        low = n.lower()
        if any(k in low for k in ("preferences", "local storage", "session storage", "code cache",
                                  "gpucache", "logs/", "cache/", "userdata", ".1ct-install.json",
                                  "repack-report", "inputs-manifest", "升级1ct.exe", "app.asar.prev",
                                  "app.asar.bak", ".backup")):
            weird.append(n)
    print("\n--- 可疑条目 ---")
    print("\n".join(weird) if weird else "(none)")
    print("\n--- 顶层结构 ---")
    tops = sorted({n.split("/")[0] for n in (i.filename for i in infos)})
    print("\n".join(tops))
    print("\n--- readme 里的学校/环境词 ---")
    for i in infos:
        if i.filename.lower().endswith((".txt", ".md")):
            body = f.read(i.filename).decode("utf-8", "ignore")
            for w in ("成信", "航空港", "龙泉", "1111", "Users", "兑", "18788907622", "30.58", "103.98", "cuit_konggang", "187889"):
                if w in body:
                    print(f"  HIT {w} in {i.filename}")
    print("done")
