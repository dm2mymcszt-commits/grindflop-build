#!/usr/bin/env python3
"""Draws the decoy home-screen icons the iPhone app can switch to.

    python scripts/make-disguise-icons.py

Writes src-tauri/ios-launch/AlternateIcons/Disguise<Name>*.png, which
scripts/apply-ios-launch-screen.sh lays into the generated Xcode project and
src-tauri/Info.plist lists under CFBundleAlternateIcons. Needs Pillow.

The pictures are plain shapes on purpose: nothing here is copied from another
app's icon. iOS rounds the corners itself, so each one is a full square with
no transparency, and what matters sits well inside the edges.
"""
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "src-tauri" / "ios-launch" / "AlternateIcons"

# Drawn large and scaled down, so every edge comes out smooth.
SIZE = 1024
SCALE = 2
S = SIZE * SCALE

# file suffix -> pixels. iPhone home screen at 2x and 3x, then the two iPad sizes.
OUTPUTS = {
    "@2x": 120,
    "@3x": 180,
    "-76@2x": 152,
    "-83.5@2x": 167,
}


def px(value):
    """A length given on the 1024 grid, in the pixels actually drawn."""
    return int(round(value * SCALE))


def vertical_gradient(top, bottom):
    image = Image.new("RGB", (S, S), top)
    draw = ImageDraw.Draw(image)
    for y in range(S):
        t = y / (S - 1)
        colour = tuple(int(round(top[i] + (bottom[i] - top[i]) * t)) for i in range(3))
        draw.line([(0, y), (S, y)], fill=colour)
    return image


def calculator():
    image = vertical_gradient((44, 44, 46), (20, 20, 22))
    draw = ImageDraw.Draw(image)
    grey = (72, 72, 76)
    orange = (255, 159, 10)
    white = (255, 255, 255)

    margin, gap = 150, 56
    key = (SIZE - 2 * margin - gap) / 2
    stroke = px(34)
    arm = 92  # half the length of a sign's stroke

    def key_box(column, row):
        left = margin + column * (key + gap)
        top = margin + row * (key + gap)
        return left, top, left + key, top + key

    def centre(box):
        return (box[0] + box[2]) / 2, (box[1] + box[3]) / 2

    def line(a, b):
        draw.line([(px(a[0]), px(a[1])), (px(b[0]), px(b[1]))], fill=white, width=stroke)
        # Round ends, which Pillow's lines do not have.
        r = stroke / 2
        for x, y in (a, b):
            draw.ellipse([px(x) - r, px(y) - r, px(x) + r, px(y) + r], fill=white)

    for column, row, colour in ((0, 0, grey), (1, 0, grey), (0, 1, grey), (1, 1, orange)):
        box = key_box(column, row)
        draw.rounded_rectangle([px(v) for v in box], radius=px(86), fill=colour)

    cx, cy = centre(key_box(0, 0))  # plus
    line((cx - arm, cy), (cx + arm, cy))
    line((cx, cy - arm), (cx, cy + arm))

    cx, cy = centre(key_box(1, 0))  # minus
    line((cx - arm, cy), (cx + arm, cy))

    cx, cy = centre(key_box(0, 1))  # times
    d = arm * 0.72
    line((cx - d, cy - d), (cx + d, cy + d))
    line((cx - d, cy + d), (cx + d, cy - d))

    cx, cy = centre(key_box(1, 1))  # equals
    line((cx - arm, cy - 46), (cx + arm, cy - 46))
    line((cx - arm, cy + 46), (cx + arm, cy + 46))
    return image


def notes():
    image = Image.new("RGB", (S, S), (253, 253, 248))
    draw = ImageDraw.Draw(image)
    band = 300
    header = vertical_gradient((255, 221, 60), (255, 196, 0)).crop((0, 0, S, px(band)))
    image.paste(header, (0, 0))
    draw.rectangle([0, px(band), S, px(band + 10)], fill=(222, 184, 40))

    line_colour = (205, 205, 212)
    left, right = 170, SIZE - 170
    for index, y in enumerate((470, 620, 770)):
        # The last line stops short, like a sentence that ends.
        end = right if index < 2 else left + (right - left) * 0.58
        draw.rounded_rectangle([px(left), px(y - 17), px(end), px(y + 17)], radius=px(17), fill=line_colour)
    return image


def weather():
    image = vertical_gradient((86, 170, 255), (24, 104, 222))
    draw = ImageDraw.Draw(image)
    sun = (255, 214, 10)
    white = (255, 255, 255)

    cx, cy, r = 640, 400, 185
    draw.ellipse([px(cx - r), px(cy - r), px(cx + r), px(cy + r)], fill=sun)

    # A cloud: three bumps on a rounded base, partly in front of the sun.
    base = (220, 560, 800, 760)
    draw.rounded_rectangle([px(v) for v in base], radius=px(100), fill=white)
    for bx, by, br in ((370, 560, 130), (540, 500, 170), (690, 590, 110)):
        draw.ellipse([px(bx - br), px(by - br), px(bx + br), px(by + br)], fill=white)
    return image


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for name, draw_icon in (("Calculator", calculator), ("Notes", notes), ("Weather", weather)):
        master = draw_icon().resize((SIZE, SIZE), Image.LANCZOS)
        for suffix, pixels in OUTPUTS.items():
            path = OUT / f"Disguise{name}{suffix}.png"
            master.resize((pixels, pixels), Image.LANCZOS).save(path, optimize=True)
            print(path.relative_to(OUT.parent.parent.parent))


if __name__ == "__main__":
    main()
