import os
import sys

from PIL import Image

SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
MARGIN = 0.03


def build(src, dst):
    img = Image.open(src).convert("RGBA")
    box = img.getchannel("A").point(lambda a: 255 if a > 8 else 0).getbbox()
    if box:
        img = img.crop(box)
    side = max(img.size)
    pad = round(side * MARGIN)
    canvas = Image.new("RGBA", (side + pad * 2, side + pad * 2), (0, 0, 0, 0))
    canvas.paste(img, ((canvas.width - img.width) // 2, (canvas.height - img.height) // 2), img)
    master = canvas.resize((256, 256), Image.LANCZOS)
    master.save(dst, format="ICO", sizes=[(s, s) for s in SIZES])
    canvas.resize((512, 512), Image.LANCZOS).save(os.path.splitext(dst)[0] + "_512.png")
    print(f"OK: {dst}")


if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(here, "icon.png")
    dst = sys.argv[2] if len(sys.argv) > 2 else os.path.join(here, "icon.ico")
    build(src, dst)
