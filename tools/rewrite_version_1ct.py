# -*- coding: utf-8 -*-
"""重写 VERSION-1CT.txt：修掉控制字符（\\1 / \\a 被当成转义），并写明包内不含个人信息。

上一版是手工拼串写的，`%APPDATA%\\1CT` 里的 `\\1` 被 Python 解释成 0x01，
`resources\\app.asar` 里的 `\\a` 被解释成 0x07，落到文件里就是乱码。
这里全部用显式转义 + 校验：写完后 assert 文件里没有 < 0x20 的控制字符（\\r\\n 除外）。
"""

from __future__ import annotations

import sys
from pathlib import Path

ASAR_SHA = sys.argv[1] if len(sys.argv) > 1 else ""
ASAR_SIZE = sys.argv[2] if len(sys.argv) > 2 else ""

TARGETS = [
    Path("1CT/VERSION-1CT.txt"),
    Path("dist/1CT-1.2.3/1CT/VERSION-1CT.txt"),
]

BODY = (
    "1CT 1.2.3 校园跑补跑 / 二课照片 / 俱乐部报名修复 · 2026-11-08\r\n"
    "asar sha256: {sha}\r\n"
    "asar 大小  : {size} 字节\r\n"
    "修复内容   : 校园跑(配速夹取/当日补跑/校区键位/自动拉云端校区/校区库迁移)、\r\n"
    "             二课(照片上传失败不提交空照片/重试预算后扣/unknown 有界重试/\r\n"
    "             SignWay3 零坐标拦截/errcode 字符串兼容)、\r\n"
    "             俱乐部(无 optionStatus 也能报名/记录歧义放宽/坐标记忆/跨 3 天预读)\r\n"
    "用户数据   : %APPDATA%\\1CT（升级不碰；首次启动自动迁移 3CT 的 unirun 校区库）\r\n"
    "回滚方法   : 把同级备份的 app.asar 复制回 resources\\app.asar\r\n"
    "分发说明   : 本包不含任何个人信息（无作者机器路径 / 用户名 / 手机号 / 真实坐标 /\r\n"
    "             登录凭据）；内置兜底照片为程序合成的中性画面，不是真人照片。\r\n"
)


def main() -> None:
    for p in TARGETS:
        text = BODY.format(sha=ASAR_SHA or "(见同目录 asar)", size=ASAR_SIZE or "?")
        p.write_bytes(text.encode("utf-8"))
        data = p.read_bytes()
        ctrl = [b for b in data if b < 0x20 and b not in (0x0D, 0x0A)]
        assert not ctrl, f"{p} 里仍有控制字符: {ctrl[:8]}"
        print(f"{p}  {len(data)} B  ok（无控制字符）")


if __name__ == "__main__":
    main()
