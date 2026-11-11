# -*- coding: utf-8 -*-
"""生成中性的内置兜底照片（不含任何个人信息）并写回 desktop/1ct/fallback-photo.js。

原兜底图是「拍自己笔记本屏幕」的实拍照片，画面里有桌面图标、窗口标题、文件名列表，
属于个人信息，不能随包分发。这里改用程序合成的中性画面（柔和渐变 + 细颗粒 + 轻暗角），
看起来像一张对着浅色墙面/地面拍的普通现场照，但没有任何可识别内容。

用法：python tools/gen_neutral_fallback_photo.py
"""

from __future__ import annotations

import base64
import io
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
TARGET_JS = ROOT / "desktop" / "1ct" / "fallback-photo.js"
PREVIEW = ROOT / "artifacts" / "fallback-photo-neutral-preview.jpg"

W, H = 800, 1066
SEED = 20261108


def build_image() -> Image.Image:
    rng = np.random.default_rng(SEED)

    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)

    # 1) 底色：浅灰米色（像白墙 / 水泥地），几乎无饱和
    arr = np.zeros((H, W, 3), dtype=np.float32)
    arr[:, :, 0] = 168.0
    arr[:, :, 1] = 166.0
    arr[:, :, 2] = 161.0

    # 2) 大尺度明暗起伏：几团柔和的光斑/阴影（模拟室内漫反射）
    blobs = [
        (0.30, 0.18, 0.42, +26.0),
        (0.78, 0.62, 0.50, -20.0),
        (0.50, 0.92, 0.38, -14.0),
        (0.12, 0.72, 0.33, +12.0),
    ]
    for cxr, cyr, rad, amp in blobs:
        d2 = ((xx - cxr * W) ** 2 + (yy - cyr * H) ** 2) / ((rad * W) ** 2)
        arr += (np.exp(-d2)[:, :, None] * amp)

    # 3) 多尺度表面质感（涂料/水泥的细微不平整）
    for scale, amp in ((3.0, 4.2), (9.0, 3.0), (26.0, 1.8)):
        layer = rng.normal(0, 1, size=(int(H / scale) + 2, int(W / scale) + 2)).astype(np.float32)
        span = float(layer.max() - layer.min()) + 1e-6
        soft = np.asarray(
            Image.fromarray(((layer - layer.min()) / span * 255).astype(np.uint8))
            .resize((W, H), Image.BICUBIC)
            .filter(ImageFilter.GaussianBlur(radius=scale * 0.6)),
            dtype=np.float32,
        )[:, :, None]
        arr = arr + (soft - 128.0) / 128.0 * amp

    # 4) 传感器颗粒
    arr = arr + rng.normal(0, 2.6, size=(H, W, 1)).astype(np.float32)

    # 5) 轻暗角
    cx, cy = W / 2.0, H / 2.0
    r = np.sqrt(((xx - cx) / cx) ** 2 + ((yy - cy) / cy) ** 2)
    arr = arr * np.clip(1.0 - 0.20 * np.clip(r - 0.5, 0, None) ** 1.5, 0.7, 1.0)[:, :, None]

    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))


def main() -> None:
    img = build_image()
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=72, optimize=True, progressive=False)
    raw = buf.getvalue()

    b64 = base64.b64encode(raw).decode("ascii")
    data_url = "data:image/jpeg;base64," + b64

    PREVIEW.parent.mkdir(parents=True, exist_ok=True)
    PREVIEW.write_bytes(raw)

    body = (
        "/* 内置兜底照片（二课拍照/定位签到用；图库没有图时提交它）。\n"
        " * 由 tools/gen_neutral_fallback_photo.py 合成：柔和渐变 + 细颗粒 + 轻暗角 → 800px / q72 → data URL。\n"
        " * 刻意做成**不含任何可识别内容**的中性画面（没有人物、屏幕、文字、桌面图标、EXIF），\n"
        " * 避免把使用者本人的照片随安装包分发。\n"
        " * 内联而不运行时 fetch：打包后渲染层是 file:// 源，fetch file:// 会被 CORS 拦。\n"
        " */\n"
        "(function () {\n"
        "  var DATA_URL = '" + data_url + "';\n"
        "  window.ONE_CT_FALLBACK_PHOTO = DATA_URL;\n"
        "  if (typeof module !== 'undefined' && module.exports) module.exports = DATA_URL;\n"
        "}());\n"
    )
    TARGET_JS.write_text(body, encoding="utf-8", newline="\n")

    print(f"image bytes={len(raw)} b64={len(b64)} js={TARGET_JS.stat().st_size} sha256(stub)=n/a")
    print(f"preview -> {PREVIEW}")
    im = Image.open(io.BytesIO(raw))
    print("size", im.size, "format", im.format, "exif entries", len(dict(im.getexif())))


if __name__ == "__main__":
    main()
