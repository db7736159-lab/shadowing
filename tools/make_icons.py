# -*- coding: utf-8 -*-
"""生成 PWA 图标（不依赖字体，纯图形）。"""
import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "icons")
os.makedirs(OUT, exist_ok=True)

BG = (14, 17, 22, 255)
ACCENT = (79, 140, 255, 255)
WHITE = (232, 237, 245, 255)


def make(size):
    img = Image.new("RGBA", (size, size), BG)
    d = ImageDraw.Draw(img)
    s = size
    # 圆角底
    r = int(s * 0.22)
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=r, fill=BG)

    cx, cy = s / 2, s * 0.46
    # 麦克风：胶囊 + 支架
    mw = s * 0.13
    mh = s * 0.30
    d.rounded_rectangle([cx - mw / 2, cy - mh / 2, cx + mw / 2, cy + mh / 2], radius=mw / 2, fill=WHITE)
    d.arc([cx - s * 0.17, cy - mh * 0.55, cx + s * 0.17, cy + mh * 0.85],
          start=0, end=180, fill=WHITE, width=max(2, int(s * 0.035)))
    d.line([(cx, cy + mh * 0.78), (cx, cy + mh * 1.15)], fill=WHITE, width=max(2, int(s * 0.035)))
    # 底部声波
    base_y = s * 0.80
    heights = [0.10, 0.18, 0.26, 0.18, 0.10]
    bw = s * 0.055
    gap = s * 0.085
    total = len(heights) * bw + (len(heights) - 1) * gap
    x = (s - total) / 2
    for hh in heights:
        hgt = s * hh / 2
        d.rounded_rectangle([x, base_y - hgt, x + bw, base_y + hgt], radius=bw / 2, fill=ACCENT)
        x += bw + gap
    img.save(os.path.join(OUT, f"icon-{size}.png"))


for n in (192, 512):
    make(n)
    print("icon", n)
