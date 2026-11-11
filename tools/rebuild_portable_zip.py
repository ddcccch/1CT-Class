# -*- coding: utf-8 -*-
"""重建「完整便携版」zip：把 dist/1CT-1.2.3 打成一个干净的顶层目录。

只做打包与校验，不碰 1CT\\ 与 %APPDATA%\\1CT。
用法：python tools/rebuild_portable_zip.py --out dist/1CT-1.2.3-完整便携版-fix-20261108.zip
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "dist" / "1CT-1.2.3"
TOP = "1CT-1.2.3-完整便携版"

FORBIDDEN = [
    "升级1CT.exe",
    "inputs-manifest.json",
    "repack-report.json",
    ".1ct-install.json",
    "Preferences",
    "Local Storage",
    "Code Cache",
    "GPUCache",
    "/logs/",
    "userData",
    "Cache/",
]

# 便携版说明里已过时的三处（校园跑配速拦截 / 无内置校区 / 俱乐部无坐标必失败），
# 本次修复后行为变了，必须同步改，否则用户按说明操作会误判。
README_PATCHES = [
    (
        "2. **配速按学校要求 4–10 km/h 校验**：像 1100 米 / 35 分钟（约 1.9 km/h）这种组合会被拦下，显示\n"
        "   `配速超出官方客户端要求的 4–10 km/h（已拦截，请调整里程或时长）`。\n"
        "   点卡片里的「**恢复自动合法参数**」按钮即可按官方配速自动匹配里程与时长。",
        "2. **配速由程序自动夹到合法区间**：像 1100 米 / 35 分钟（约 1.9 km/h）这种组合，程序会按官方\n"
        "   4–10 km/h 自动改成本次提交 16 分钟（只影响本次提交，**不改你的配置**）。\n"
        "   想让配置本身也合法，点卡片里的「**恢复自动合法参数**」；想恢复旧行为（越界就拦），\n"
        "   在配置里设 `unirun.strictPace = true`。",
    ),
    (
        "1. **必须先选校区**：1CT 的配置是独立的，里面**没有内置校区库**。第一次请到「校园跑」卡片里：\n"
        "   先用「从云端获取校区列表」→ 选择自己的学校/校区（本次测试用的是「成信大-航空港」）→\n"
        "   再「下载并保存」地图（列表里没有可点「从云端获取更多校区」）。\n"
        "   没保存校区时，每轮只会显示 `未选择跑步校区（请在「校园跑」卡片里选校区）`、不会提交 —— 这是保护，不是故障。",
        "1. **校区库会自动就位**：首次启动时会把 3CT 的校区库/地图（`%APPDATA%\\3CT\\unirun`）自动复制一份过来；\n"
        "   本机没有 3CT 数据时，程序会自己从云端拉一次校区列表并下载地图。\n"
        "   想手工指定，仍可到「校园跑」卡片里「从云端获取校区列表」→ 选学校/校区 →「下载并保存」。\n"
        "   实在拿不到校区时，每轮只显示 `未选择跑步校区`、不会提交 —— 这是保护，不是故障。",
    ),
    (
        "2. 签到需要活动的**真实签到点坐标**：实测活动列表未带坐标；窗口外当前签到任务也可能为空。\n"
        "   若当时接口未提供坐标，需要在界面里配置真实的签到点兜底坐标，否则签到可能失败。",
        "2. 签到坐标来源（按优先级）：学校下发的当前签到任务坐标 → **程序记住过的同一活动坐标** →\n"
        "   界面里配的兜底坐标 → 活动中心点（需显式开启）。学校下发过一次后，后续场次不用再手填。",
    ),
    (
        "3. **本版本的俱乐部链路没有在真实活动窗口内做过端到端验收**（只做了代码、单元测试与打包冒烟验证）。\n"
        "   实际能不能签上，请以「记录」页里的结果和学校端为准；失败原因会以中文写清楚（例如\n"
        "   `上游拒绝`、`不在签到窗口`），不要把它当成“已经全自动成功”。",
        "3. 报名不再要求活动必须下发 `optionStatus`（旧版会因此一行结果都不产出）；活动列表会往后多看 3 天，\n"
        "   避免明天/后天的场次错过报名（`club.lookAheadDays`，设 0 恢复只看今天）。\n"
        "   结果仍以「记录」页与学校端为准；失败原因会以中文写清楚（例如 `上游拒绝`、`不在签到窗口`）。",
    ),
]


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=str(SRC))
    ap.add_argument("--out", default=str(ROOT / "dist" / "1CT-1.2.3-完整便携版-fix-20261108.zip"))
    args = ap.parse_args()

    src = Path(args.src)
    out = Path(args.out)
    if not (src / "1CT" / "resources" / "app.asar").is_file():
        raise SystemExit(f"源目录不完整: {src}")

    readme_path = src / "使用说明.txt"
    readme = readme_path.read_text(encoding="utf-8")
    for old, new in README_PATCHES:
        if new in readme:
            continue  # 已打过（可重复执行）
        if old not in readme:
            raise SystemExit("使用说明.txt 里找不到待替换段落（说明文本已变），请先人工核对:\n" + old[:80])
        readme = readme.replace(old, new, 1)
    readme_path.write_text(readme, encoding="utf-8")

    files: list[tuple[Path, str]] = []
    files.append((src / "使用说明.txt", f"{TOP}/使用说明.txt"))
    files.append((src / "启动1CT.exe", f"{TOP}/启动1CT.exe"))
    for p in sorted((src / "1CT").rglob("*")):
        if p.is_file():
            files.append((p, f"{TOP}/1CT/{p.relative_to(src / '1CT').as_posix()}"))

    names = [arc for _, arc in files]
    stray = [n for n in names if n.count("/") == 1 and not (n.endswith("使用说明.txt") or n.endswith("启动1CT.exe"))]
    if stray:
        raise SystemExit(f"顶层混入多余文件: {stray}")
    bad = {f: [n for n in names if f in n][:3] for f in FORBIDDEN}
    bad = {k: v for k, v in bad.items() if v}
    if bad:
        raise SystemExit(f"含禁止条目: {json.dumps(bad, ensure_ascii=False)}")

    out.parent.mkdir(parents=True, exist_ok=True)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for path, arc in files:
            z.write(path, arc)
    data = buf.getvalue()
    out.write_bytes(data)
    digest = sha256_bytes(data)
    sidecar = out.with_suffix(out.suffix + ".sha256.txt")
    sidecar.write_text(f"{digest}  {out.name}\n", encoding="utf-8")

    # 自检
    with zipfile.ZipFile(out) as z:
        got = z.namelist()
        asar = z.read(f"{TOP}/1CT/resources/app.asar")
    print(f"zip      = {out}")
    print(f"size     = {len(data)} B, entries = {len(got)}")
    print(f"sha256   = {digest}")
    print(f"sidecar  = {sidecar}")
    print(f"asar sha = {sha256_bytes(asar)} ({len(asar)} B)")
    assert sha256_bytes(asar) == sha256_bytes((src / "1CT" / "resources" / "app.asar").read_bytes())
    assert len(got) == len(files), (len(got), len(files))
    print("自检通过：条目数一致、包内 asar 与 1CT\\resources\\app.asar 逐字节相同。")


if __name__ == "__main__":
    main()
