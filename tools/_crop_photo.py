# -*- coding: utf-8 -*-
from pathlib import Path

from PIL import Image

src = Path("artifacts/fallback-photo-probe.jpg")
out_dir = Path("artifacts/photo-crops")
out_dir.mkdir(parents=True, exist_ok=True)

im = Image.open(src)

crops = {
    "win-title": (140, 355, 620, 392),
    "win-left": (140, 470, 460, 680),
    "win-right": (450, 355, 800, 680),
    "screen-bottom": (140, 660, 800, 790),
}

for name, box in crops.items():
    c = im.crop(box)
    scale = max(2, int(1400 / max(1, c.width)))
    c = c.resize((c.width * scale, c.height * scale), Image.LANCZOS)
    p = out_dir / f"{name}.png"
    c.save(p)
    print(name, box, c.size, "->", p)
