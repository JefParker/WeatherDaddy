#!/usr/bin/env python3
"""Build script for WeatherDaddy PWA assets.

Generates icons, maskable icons, monochrome icons, Apple touch icons,
favicons, and iOS splash screens from the master SVG sources in this
folder.  Idempotent — re-run any time the master art changes.
"""

import os
import subprocess
import sys
from pathlib import Path

from PIL import Image

HERE = Path(__file__).parent
ROOT = HERE.parent.parent
ICONS_OUT = ROOT / 'assets' / 'icons'
SPLASH_OUT = ROOT / 'assets' / 'splash'

ICONS_OUT.mkdir(parents=True, exist_ok=True)
SPLASH_OUT.mkdir(parents=True, exist_ok=True)

BG_DARK = '#121212'

# ---- Standard icon sizes ---------------------------------------------------
# Used by manifest.json + apple-touch-icon + favicons.
STANDARD_SIZES = [16, 32, 48, 72, 96, 128, 144, 152, 167, 180, 192, 256, 384, 512, 1024]

# ---- Maskable icon sizes (Android adaptive icons) -------------------------
MASKABLE_SIZES = [192, 512]

# ---- Monochrome icon sizes (Android themed icons) -------------------------
MONOCHROME_SIZES = [192, 512]

# ---- iOS splash sizes ------------------------------------------------------
# (filename, width, height, orientation) — both portrait and landscape for
# every modern iPhone and iPad.  Names follow the convention used by
# Apple's <link rel="apple-touch-startup-image"> media queries.
SPLASH_SIZES = [
    # iPhone 14 Pro Max
    ('iphone-14-pro-max-portrait',  1290, 2796, 'portrait'),
    ('iphone-14-pro-max-landscape', 2796, 1290, 'landscape'),
    # iPhone 14 Pro / 15 Pro
    ('iphone-14-pro-portrait',  1179, 2556, 'portrait'),
    ('iphone-14-pro-landscape', 2556, 1179, 'landscape'),
    # iPhone 14 Plus / 13 Pro Max / 12 Pro Max
    ('iphone-14-plus-portrait',  1284, 2778, 'portrait'),
    ('iphone-14-plus-landscape', 2778, 1284, 'landscape'),
    # iPhone 14 / 13 / 12 / 13 Pro / 12 Pro
    ('iphone-14-portrait',  1170, 2532, 'portrait'),
    ('iphone-14-landscape', 2532, 1170, 'landscape'),
    # iPhone 13 mini / 12 mini / 11 Pro / X / XS
    ('iphone-x-portrait',  1125, 2436, 'portrait'),
    ('iphone-x-landscape', 2436, 1125, 'landscape'),
    # iPhone 11 Pro Max / XS Max
    ('iphone-xs-max-portrait',  1242, 2688, 'portrait'),
    ('iphone-xs-max-landscape', 2688, 1242, 'landscape'),
    # iPhone 11 / XR
    ('iphone-xr-portrait',  828, 1792, 'portrait'),
    ('iphone-xr-landscape', 1792, 828, 'landscape'),
    # iPhone 8 Plus / 7 Plus / 6 Plus
    ('iphone-8-plus-portrait',  1242, 2208, 'portrait'),
    ('iphone-8-plus-landscape', 2208, 1242, 'landscape'),
    # iPhone 8 / 7 / 6 / SE2 / SE3
    ('iphone-8-portrait',  750, 1334, 'portrait'),
    ('iphone-8-landscape', 1334, 750, 'landscape'),
    # iPhone SE (1st gen) / 5s
    ('iphone-se-portrait',  640, 1136, 'portrait'),
    ('iphone-se-landscape', 1136, 640, 'landscape'),
    # iPad mini (6th gen)
    ('ipad-mini-portrait',  1488, 2266, 'portrait'),
    ('ipad-mini-landscape', 2266, 1488, 'landscape'),
    # iPad 10.2"
    ('ipad-portrait',  1620, 2160, 'portrait'),
    ('ipad-landscape', 2160, 1620, 'landscape'),
    # iPad Air (10.9") / iPad Pro 11"
    ('ipad-air-portrait',  1640, 2360, 'portrait'),
    ('ipad-air-landscape', 2360, 1640, 'landscape'),
    # iPad Pro 12.9"
    ('ipad-pro-12-portrait',  2048, 2732, 'portrait'),
    ('ipad-pro-12-landscape', 2732, 2048, 'landscape'),
]


def rsvg(src: Path, dst: Path, size: int) -> None:
    """Render an SVG to a square PNG at the requested pixel size."""
    subprocess.run(
        ['rsvg-convert',
         '-w', str(size), '-h', str(size),
         '-f', 'png',
         '-o', str(dst),
         str(src)],
        check=True
    )


def rsvg_rect(src: Path, dst: Path, width: int, height: int, bg: str = BG_DARK) -> None:
    """Render an SVG centered into a rectangular PNG with a background fill.

    rsvg-convert's --background-color flag fills the canvas before rendering,
    which is what we want for splash screens (icon centered on dark canvas).
    """
    # Pick the larger dimension so the artwork is scaled to fit without crop.
    # Splash template is 1000x1000 with preserveAspectRatio="xMidYMid meet",
    # so rendering into width x height with the template's intrinsic ratio
    # will fit + center, leaving background fill on the long axis.
    subprocess.run(
        ['rsvg-convert',
         '-w', str(width), '-h', str(height),
         '-a',  # preserve aspect ratio (letterbox)
         '-b', bg,
         '-f', 'png',
         '-o', str(dst),
         str(src)],
        check=True
    )


def make_favicon_ico(png_dir: Path, dst: Path, sizes=(16, 32, 48)) -> None:
    """Bundle several PNGs into a single multi-resolution .ico file."""
    images = [Image.open(png_dir / f'icon-{s}.png').convert('RGBA') for s in sizes]
    images[0].save(dst, format='ICO', sizes=[(s, s) for s in sizes], append_images=images[1:])


def main():
    master = HERE / 'icon-master.svg'
    maskable = HERE / 'icon-maskable-master.svg'
    monochrome = HERE / 'icon-monochrome-master.svg'
    splash_tpl = HERE / 'splash-template.svg'

    if not all(p.exists() for p in (master, maskable, monochrome, splash_tpl)):
        print('Missing one of the master SVGs', file=sys.stderr)
        sys.exit(1)

    print('Standard icons:')
    for s in STANDARD_SIZES:
        out = ICONS_OUT / f'icon-{s}.png'
        rsvg(master, out, s)
        print(f'  {out.relative_to(ROOT)}')

    print('Maskable icons:')
    for s in MASKABLE_SIZES:
        out = ICONS_OUT / f'maskable-{s}.png'
        rsvg(maskable, out, s)
        print(f'  {out.relative_to(ROOT)}')

    print('Monochrome icons:')
    for s in MONOCHROME_SIZES:
        out = ICONS_OUT / f'monochrome-{s}.png'
        rsvg(monochrome, out, s)
        print(f'  {out.relative_to(ROOT)}')

    print('Apple touch icon:')
    rsvg(master, ICONS_OUT / 'apple-touch-icon.png', 180)
    print(f'  assets/icons/apple-touch-icon.png')

    print('Favicons:')
    favicon = ROOT / 'favicon.ico'
    make_favicon_ico(ICONS_OUT, favicon)
    print(f'  favicon.ico (16, 32, 48)')
    # Also copy a 32px PNG for modern browsers
    Image.open(ICONS_OUT / 'icon-32.png').save(ROOT / 'favicon-32.png')

    print('Splash screens:')
    for name, w, h, _ in SPLASH_SIZES:
        out = SPLASH_OUT / f'{name}.png'
        rsvg_rect(splash_tpl, out, w, h)
        print(f'  {out.relative_to(ROOT)}  ({w}x{h})')

    # Also overwrite the top-level legacy icons used by the existing code so
    # nothing breaks if anything still points there.
    Image.open(ICONS_OUT / 'icon-192.png').save(ROOT / 'assets' / 'icon-192.png')
    Image.open(ICONS_OUT / 'icon-512.png').save(ROOT / 'assets' / 'icon-512.png')
    Image.open(ICONS_OUT / 'icon-1024.png').save(ROOT / 'assets' / 'app-icon.png')

    print('Done.')


if __name__ == '__main__':
    main()
