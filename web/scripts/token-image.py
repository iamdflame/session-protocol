"""The $BELL token image.

Not a logo someone drew — the same geometry every other surface uses. A
24-hour ring carrying the real 6.5h / 17.5h split, warm through the session
and cool through the night, with a strike at 16:00 ET where the bell actually
rings. A holder who has seen the site's clock recognises the token, because
it is the same object.

Drawn rather than exported, so the proportions come from the same constants
as the SVG and cannot drift from it.

    python3 scripts/token-image.py
"""

from math import cos, sin, pi
from PIL import Image, ImageDraw

SIZE = 512
SS = 4                      # supersample, then downscale: PIL has no AA on arcs
GROUND = (11, 14, 22)       # --ground, the site's night ink
NIGHT = (57, 135, 229)      # validated blue
DAY = (217, 89, 38)         # validated orange
STRIKE = (245, 246, 250)

DAY_FROM, DAY_TO = 9.5, 16.0   # 09:30 → 16:00 ET


def angle(hours: float) -> float:
    """Degrees for PIL: 0h at the top, clockwise, 0° at 3 o'clock."""
    return (hours / 24.0) * 360.0 - 90.0


def point(cx: float, cy: float, r: float, hours: float):
    a = (hours / 24.0) * 2 * pi - pi / 2
    return cx + r * cos(a), cy + r * sin(a)


def cap(d: ImageDraw.ImageDraw, cx, cy, r, hours, w, fill):
    """A round cap, since PIL's arc has none.

    `arc` grows its width *inward* from the bounding box, so the stroke's
    centreline sits at `r - w/2`, not at `r`. Placing caps on `r` puts them
    half a stroke outside the ring, which reads as a lump rather than a cap.
    """
    x, y = point(cx, cy, r - w / 2, hours)
    d.ellipse([x - w / 2, y - w / 2, x + w / 2, y + w / 2], fill=fill)


def draw() -> Image.Image:
    n = SIZE * SS
    img = Image.new("RGB", (n, n), GROUND)
    d = ImageDraw.Draw(img)

    c = n / 2
    r = n * 0.325
    w = n * 0.125
    box = [c - r, c - r, c + r, c + r]

    # The night is the long arc: 17.5 of the 24 hours, which is the whole point.
    d.arc(box, angle(DAY_TO), angle(DAY_FROM) + 360, fill=NIGHT, width=int(w))
    d.arc(box, angle(DAY_FROM), angle(DAY_TO), fill=DAY, width=int(w))
    cap(d, c, c, r, DAY_FROM, w, DAY)
    cap(d, c, c, r, DAY_TO, w, DAY)

    # The hand, at 16:00 — the instant the bell rings and the classes change
    # hands. A tick outside the ring read as a stray pin; a hand reads as a
    # clock, which is what this is.
    hx, hy = point(c, c, r - w * 1.12, DAY_TO)
    d.line([c, c, hx, hy], fill=STRIKE, width=int(w * 0.30))
    hub = w * 0.22
    d.ellipse([c - hub, c - hub, c + hub, c + hub], fill=STRIKE)

    return img.resize((SIZE, SIZE), Image.LANCZOS)


if __name__ == "__main__":
    out = "public/bell.png"
    draw().save(out, "PNG", optimize=True)
    import os
    print(f"{out}  {SIZE}x{SIZE}  {os.path.getsize(out) / 1024:.0f}kb")
