# -*- coding: utf-8 -*-
"""扫描交付物里是否夹带本机/个人信息。

两类检查：
  A. 精确标记（本机路径、Windows 用户名、真实手机号、真实坐标、真实校区 id）
  B. 宽泛正则（手机号 / 身份证 / 凭据），带边界，跳过二进制噪声

用法：
    python tools/scan_personal_info.py
    python tools/scan_personal_info.py --path dist/1CT-1.2.3-完整便携版-fix-20261108.zip
"""

from __future__ import annotations

import argparse
import re
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# A. 精确标记 —— 命中即必须修
EXACT = [
    b"D:\\1111",
    b"D:/1111",
    b"1111\\2class",
    b"1111/2class",
    b"C:\\Users\\\xe5\x85\x91",       # C:\Users\兑（UTF-8）
    "C:\\Users\\兑".encode("utf-8"),
    b"18788907622",
    b"30.583253",
    b"103.986817",
    b"1793444520000",
    b"1792404120000",
    b"1792210699000",
    b"cuit_konggang",
]

# A2. 会话凭据的「值」形态（只看键名不算，登录态泄漏才致命）
CREDENTIAL_PATTERNS = [
    (rb"(?i)(jsessionid|access_token|refresh_token|openid)[\"']?\s*[:=]\s*[\"']?([A-Za-z0-9\-_\.]{16,})", "凭据值"),
    (rb"(?i)Bearer\s+([A-Za-z0-9\-_\.]{24,})", "Bearer token"),
]

# B. 宽泛正则（仅 UTF-8 文本，带字母数字边界）
PATTERNS = [
    (rb"(?<![0-9A-Za-z])1[3-9]\d{9}(?![0-9A-Za-z])", "手机号"),
    (rb"(?<![0-9A-Za-z])\d{17}[\dXx](?![0-9A-Za-z])", "身份证号"),
] + CREDENTIAL_PATTERNS

TEXT_EXT = {".js", ".cjs", ".mjs", ".json", ".txt", ".md", ".html", ".css", ".yml", ".yaml", ".cmd", ".ps1", ".cs", ".py"}


def should_regex(name: str) -> bool:
    return Path(name).suffix.lower() in TEXT_EXT


def scan_bytes(name: str, data: bytes, hits: list[tuple[str, str, str]]) -> None:
    for pat in EXACT:
        start = 0
        while True:
            idx = data.find(pat, start)
            if idx < 0:
                break
            ctx = data[max(0, idx - 50): idx + 50]
            hits.append((name, pat.decode("utf-8", "ignore")[:24], ctx.decode("utf-8", "ignore").replace("\n", " ")))
            start = idx + 1
            if len([h for h in hits if h[0] == name]) > 40:
                break
    if not should_regex(name):
        return
    for pat, label in PATTERNS:
        for m in re.finditer(pat, data):
            ctx = data[max(0, m.start() - 50): m.end() + 50]
            hits.append((name, label, ctx.decode("utf-8", "ignore").replace("\n", " ")))


def scan_file(path: Path, hits: list) -> None:
    key = str(path.relative_to(ROOT)) if path.is_relative_to(ROOT) else str(path)
    try:
        data = path.read_bytes()
    except Exception as e:  # noqa: BLE001
        hits.append((key, "读取失败", str(e)))
        return
    scan_bytes(key, data, hits)


def scan_zip(path: Path, hits: list) -> None:
    with zipfile.ZipFile(path) as z:
        for info in z.infolist():
            if info.is_dir():
                continue
            scan_bytes(f"{path.name}!{info.filename}", z.read(info.filename), hits)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--path", action="append", default=None)
    args = ap.parse_args()

    targets = args.path or [
        str(ROOT / "1CT" / "resources" / "app.asar"),
        str(ROOT / "dist" / "1CT升级包-1.2.3-fix-20261108" / "升级1CT.exe"),
        str(ROOT / "dist" / "1CT升级包-1.2.3-fix-20261108" / "升级说明.txt"),
        str(ROOT / "dist" / "1CT-1.2.3-完整便携版-fix-20261108.zip"),
    ]

    hits: list[tuple[str, str, str]] = []
    for t in targets:
        p = Path(t)
        if not p.exists():
            hits.append((t, "缺失", ""))
            continue
        if p.suffix.lower() == ".zip":
            scan_zip(p, hits)
        elif p.is_dir():
            for f in p.rglob("*"):
                if f.is_file():
                    scan_file(f, hits)
        else:
            scan_file(p, hits)

    if not hits:
        print("PASS：未发现本机路径 / 用户名 / 手机号 / 身份证 / 真实坐标 / 真实校区 id / 会话凭据")
        return

    # 归类统计
    by_label: dict[str, list[str]] = {}
    for name, label, _ctx in hits:
        by_label.setdefault(label, []).append(name)
    print(f"命中 {len(hits)} 处，涉及 {len(by_label)} 类标记：")
    for label, names in sorted(by_label.items(), key=lambda kv: -len(kv[1])):
        uniq = sorted(set(names))
        print(f"\n  【{label}】{len(uniq)} 个文件，共 {len(names)} 处")
        for n in uniq[:6]:
            print(f"      {n}")
        if len(uniq) > 6:
            print(f"      …还有 {len(uniq) - 6} 个")
    print("\nFAIL")


if __name__ == "__main__":
    main()
