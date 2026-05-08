#!/usr/bin/env python3
"""Generate icon.icns + tray template PNGs for NightOwl.

Run from repo root:
    python3 scripts/generate-icon.py

Produces:
    packages/desktop/resources/icons/icon.png         (1024x1024 base)
    packages/desktop/resources/icons/icon.icns        (macOS app icon)
    packages/desktop/resources/icons/icon.ico         (Windows app icon)
    packages/desktop/resources/icons/trayTemplate.png (16x16 monochrome)
    packages/desktop/resources/icons/trayTemplate@2x.png (32x32)
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
ICON_DIR = ROOT / "packages" / "desktop" / "resources" / "icons"
ICON_DIR.mkdir(parents=True, exist_ok=True)


def draw_owl(size: int, *, monochrome: bool = False) -> Image.Image:
    """Draw a simple owl-on-a-moon icon at the given square size."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    if monochrome:
        bg_color = (0, 0, 0, 0)  # transparent for tray template
        owl_color = (0, 0, 0, 255)
        eye_white = (0, 0, 0, 0)
        eye_black = (255, 255, 255, 255)
        moon_color = (0, 0, 0, 255)
    else:
        bg_color = (10, 10, 20, 255)        # near-black night sky
        owl_color = (90, 60, 30, 255)        # brown owl body
        eye_white = (245, 220, 130, 255)     # warm yellow
        eye_black = (10, 10, 10, 255)
        moon_color = (235, 225, 200, 255)    # pale moon

    # Background rounded square (skip for tray template; transparent).
    if not monochrome:
        radius = int(size * 0.22)
        d.rounded_rectangle(
            [(0, 0), (size, size)], radius=radius, fill=bg_color
        )

    # Moon — a circle, with a smaller bg-circle bite to look crescent.
    moon_r = int(size * 0.32)
    moon_cx = int(size * 0.74)
    moon_cy = int(size * 0.30)
    d.ellipse(
        [
            (moon_cx - moon_r, moon_cy - moon_r),
            (moon_cx + moon_r, moon_cy + moon_r),
        ],
        fill=moon_color,
    )
    if not monochrome:
        bite_r = int(size * 0.28)
        bite_cx = moon_cx + int(size * 0.12)
        bite_cy = moon_cy - int(size * 0.04)
        d.ellipse(
            [
                (bite_cx - bite_r, bite_cy - bite_r),
                (bite_cx + bite_r, bite_cy + bite_r),
            ],
            fill=bg_color,
        )

    # Owl body — fat oval centered lower-left of the canvas.
    body_w = int(size * 0.62)
    body_h = int(size * 0.66)
    body_cx = int(size * 0.42)
    body_cy = int(size * 0.62)
    d.ellipse(
        [
            (body_cx - body_w // 2, body_cy - body_h // 2),
            (body_cx + body_w // 2, body_cy + body_h // 2),
        ],
        fill=owl_color,
    )

    # Eyes — two big round circles.
    eye_r = int(size * 0.13)
    eye_offset_x = int(size * 0.13)
    eye_offset_y = int(size * 0.10)
    for sign in (-1, 1):
        ex = body_cx + sign * eye_offset_x
        ey = body_cy - eye_offset_y
        d.ellipse(
            [(ex - eye_r, ey - eye_r), (ex + eye_r, ey + eye_r)],
            fill=eye_white,
        )
        # Pupil
        pr = int(eye_r * 0.45)
        d.ellipse(
            [(ex - pr, ey - pr), (ex + pr, ey + pr)],
            fill=eye_black,
        )

    # Beak — small triangle between eyes.
    beak_w = int(size * 0.05)
    beak_h = int(size * 0.06)
    beak_top = (body_cx, body_cy + int(size * 0.02))
    d.polygon(
        [
            beak_top,
            (body_cx - beak_w, beak_top[1] + beak_h),
            (body_cx + beak_w, beak_top[1] + beak_h),
        ],
        fill=(255, 180, 60, 255) if not monochrome else owl_color,
    )

    return img


def main() -> int:
    # 1024x1024 master.
    master = draw_owl(1024)
    master_path = ICON_DIR / "icon.png"
    master.save(master_path, "PNG")
    print(f"wrote {master_path}")

    # Build .iconset/ for iconutil.
    iconset = ICON_DIR / "icon.iconset"
    if iconset.exists():
        shutil.rmtree(iconset)
    iconset.mkdir()

    sizes = [
        (16, "icon_16x16.png"),
        (32, "icon_16x16@2x.png"),
        (32, "icon_32x32.png"),
        (64, "icon_32x32@2x.png"),
        (128, "icon_128x128.png"),
        (256, "icon_128x128@2x.png"),
        (256, "icon_256x256.png"),
        (512, "icon_256x256@2x.png"),
        (512, "icon_512x512.png"),
        (1024, "icon_512x512@2x.png"),
    ]
    for size, name in sizes:
        master.resize((size, size), Image.LANCZOS).save(iconset / name, "PNG")

    # Convert to .icns using macOS built-in iconutil.
    icns_path = ICON_DIR / "icon.icns"
    if icns_path.exists():
        icns_path.unlink()
    subprocess.run(
        ["iconutil", "-c", "icns", str(iconset), "-o", str(icns_path)],
        check=True,
    )
    print(f"wrote {icns_path}")
    shutil.rmtree(iconset)

    # Windows .ico — multi-resolution.
    ico_path = ICON_DIR / "icon.ico"
    master.save(
        ico_path,
        format="ICO",
        sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    print(f"wrote {ico_path}")

    # Tray template (monochrome, transparent bg).
    tray16 = draw_owl(16, monochrome=True)
    tray32 = draw_owl(32, monochrome=True)
    (ICON_DIR / "trayTemplate.png").write_bytes(b"")
    tray16.save(ICON_DIR / "trayTemplate.png", "PNG")
    tray32.save(ICON_DIR / "trayTemplate@2x.png", "PNG")
    print(f"wrote {ICON_DIR / 'trayTemplate.png'} and @2x")

    return 0


if __name__ == "__main__":
    sys.exit(main())
