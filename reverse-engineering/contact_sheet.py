"""Build a labeled contact sheet of the extracted SkiFree bitmap resources and
decode the RT_STRING blocks, so the sprite inventory can be identified visually.
"""
import json
import struct
from pathlib import Path

from PIL import Image, ImageDraw

root = Path(r"C:/skifree-re")
idx = json.loads((root / "analysis/sprites32_index.json").read_text(encoding="utf-8"))
exe = (root / "artifacts/v32/ski32.exe").read_bytes()

bitmaps = [r for r in idx if r["type"] == 2 and "png" in r]
SCALE = 3
PAD = 26
cols = 10
cw = max(r["width"] for r in bitmaps) * SCALE + 12
ch = max(r["height"] for r in bitmaps) * SCALE + PAD + 12
rows = (len(bitmaps) + cols - 1) // cols
sheet = Image.new("RGB", (cols * cw, rows * ch), (24, 28, 38))
d = ImageDraw.Draw(sheet)
for i, r in enumerate(bitmaps):
    im = Image.open(r["png"]).convert("RGB")
    im = im.resize((im.width * SCALE, im.height * SCALE), Image.NEAREST)
    x = (i % cols) * cw + 6
    y = (i // cols) * ch + PAD
    sheet.paste(im, (x, y))
    d.text((x, y - 16), "#%d %dx%d" % (r["name"], r["width"], r["height"]), fill=(255, 220, 120))
out = root / "analysis/contact_sheet.png"
sheet.save(out)
print("sheet", out, sheet.size)

# RT_STRING decode: blocks of 16 length-prefixed UTF-16LE strings
strings = {}
for r in idx:
    if r["type"] == 6:
        blob = exe[r["offset"]:r["offset"] + r["size"]]
        pos = 0
        base_id = (r["name"] - 1) * 16
        for j in range(16):
            (n,) = struct.unpack_from("<H", blob, pos)
            pos += 2
            raw = blob[pos:pos + n * 2]
            pos += n * 2
            if n:
                strings[base_id + j] = raw.decode("utf-16-le", errors="replace")
    if r["type"] == 10:
        blob = exe[r["offset"]:r["offset"] + r["size"]]
        (root / ("analysis/rcd_%s.bin" % r["name"])).write_bytes(blob)
print(json.dumps(strings, indent=1, ensure_ascii=False))
(root / "analysis/strings.json").write_text(json.dumps(strings, indent=1, ensure_ascii=False), encoding="utf-8")
