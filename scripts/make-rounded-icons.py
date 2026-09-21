#!/usr/bin/env python3
"""生成圆角应用图标并替换 assets/icons 目录下的全部图标。"""
import os
import sys
from pathlib import Path
from PIL import Image, ImageDraw

SRC = Path("D:/Trae/assets/icons/icon-1024.png")
OUT_DIR = Path("D:/Trae/assets/icons")
SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024]


def rounded_mask(size: int, radius_ratio: float = 0.28) -> Image.Image:
    """生成圆角矩形遮罩（L 模式）。"""
    radius = int(size * radius_ratio)
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle((0, 0, size, size), radius=radius, fill=255)
    return mask


def make_icon(src: Image.Image, size: int) -> Image.Image:
    """从源图生成单个圆角图标。"""
    # 统一按正方形处理，使用高质量 lanczos 缩放
    img = src.convert("RGBA").resize((size, size), Image.Resampling.LANCZOS)
    mask = rounded_mask(size)
    # 先清空四角
    bg = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    bg.paste(img, (0, 0), mask)
    return bg


def main() -> int:
    if not SRC.exists():
        print(f"source not found: {SRC}", file=sys.stderr)
        return 1

    src = Image.open(SRC)
    # 源图可能是矩形，先裁成最大正方形居中
    w, h = src.size
    min_side = min(w, h)
    left = (w - min_side) // 2
    top = (h - min_side) // 2
    src = src.crop((left, top, left + min_side, top + min_side))

    images = {}
    for size in SIZES:
        out = make_icon(src, size)
        out_path = OUT_DIR / f"icon-{size}.png"
        out.save(out_path, "PNG")
        images[size] = out
        print(f"written: {out_path}")

    # 生成 Windows 多尺寸 .ico
    # electron-builder 要求 .ico 至少包含 256x256，且通常把最大尺寸放在首张
    ico_path = OUT_DIR / "icon.ico"
    ico_sizes = [256, 128, 64, 48, 32, 24, 16]
    ico_images = [images[s] for s in ico_sizes]
    ico_images[0].save(
        ico_path,
        format="ICO",
        sizes=[(s, s) for s in ico_sizes],
        append_images=ico_images[1:],
    )
    print(f"written: {ico_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
