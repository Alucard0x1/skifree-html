"""Extract RT_BITMAP resources from SkiFree's PE (ski32.exe) using REA's
inspect-pe-resources Evidence JSON, decode each DIB, and write PNGs.
"""
import json
from pathlib import Path

from PIL import Image

root = Path(r"C:/skifree-re")
ev = json.loads((root / "analysis/pe_resources.json").read_text(encoding="utf-8"))
exe = (root / "artifacts/v32/ski32.exe").read_bytes()
res = ev["normalized_result"]["resources"]
out = root / "analysis/sprites32"
out.mkdir(parents=True, exist_ok=True)

TYPE = {1: "CURSOR", 2: "BITMAP", 3: "ICON", 4: "MENU", 5: "DIALOG", 6: "STRING",
        9: "ACCEL", 10: "RCDATA", 12: "GRPCURSOR", 14: "GRPICON", 16: "VERSION", 24: "MANIFEST"}


def decode_dib(dib: bytes, png: Path):
    hdr, w, h, planes, bpp = __import__("struct").unpack_from("<IiiHH", dib, 0)
    hdr_size, w, h, planes, bpp = __import__("struct").unpack_from("<IiiHH", dib, 0)
    clr_used, = __import__("struct").unpack_from("<I", dib, 32)
    if bpp not in (1, 4, 8, 24, 32):
        raise ValueError("bpp %d" % bpp)
    if clr_used in (0, 0xFFFFFFFF):
        clr_used = 0 if bpp >= 24 else (1 << bpp)
    pal_off = hdr_size
    palette = []
    for i in range(clr_used):
        b, g, r, _ = __import__("struct").unpack_from("<BBBB", dib, pal_off + i * 4)
        palette.append((r, g, b))
    bits = pal_off + clr_used * 4
    stride = ((w * bpp + 31) // 32) * 4
    H = abs(h)
    img = Image.new("RGB", (w, H), (255, 0, 255))
    px = img.load()
    for row in range(H):
        src_row = row if h < 0 else H - 1 - row
        base = bits + src_row * stride
        for x in range(w):
            if bpp == 8:
                idx = dib[base + x]
                c = palette[idx] if idx < len(palette) else (255, 0, 255)
            elif bpp == 4:
                byte = dib[base + (x >> 1)]
                idx = (byte >> 4) if x % 2 == 0 else (byte & 0xF)
                c = palette[idx] if idx < len(palette) else (255, 0, 255)
            elif bpp == 1:
                byte = dib[base + (x >> 3)]
                idx = (byte >> (7 - (x & 7))) & 1
                c = palette[idx] if idx < len(palette) else (255, 0, 255)
            else:  # 24/32 bpp BGR(A)
                o = base + x * (bpp // 8)
                c = (dib[o + 2], dib[o + 1], dib[o])
            px[x, row] = c
    img.save(png)
    return {"width": w, "height": H, "bpp": bpp, "palette": len(palette)}


def rid(node):
    if isinstance(node, dict):
        return node.get("name") if node.get("kind") == "name" else node.get("id")
    return node


index = []
for r in res:
    t_id = rid(r.get("type")) or r.get("type", {}).get("id")
    t_name = TYPE.get(r["type"].get("id"), str(r["type"].get("id"))) if "id" in r["type"] else "named"
    name = rid(r.get("name"))
    payload = r["payload"]
    off, size = payload["location"]["offset"], payload["location"]["bytes"]
    blob = exe[off:off + size]
    rec = {"type": t_id, "type_name": t_name, "name": name, "offset": off, "size": size,
           "sha256": payload.get("sha256")}
    if t_id == 2:
        png = out / ("bitmap_%03d.png" % name)
        try:
            rec.update(decode_dib(blob, png))
            rec["png"] = str(png)
        except Exception as exc:  # noqa: BLE001
            rec["error"] = str(exc)
            (out / ("bitmap_%03d.bin" % name)).write_bytes(blob)
    index.append(rec)

(root / "analysis/sprites32_index.json").write_text(json.dumps(index, indent=1), encoding="utf-8")
for rec in index:
    if rec["type"] == 2:
        print("BITMAP %-3s %-6s off=%-7d len=%-6d %s" % (
            rec["name"], "%dx%d" % (rec.get("width", 0), rec.get("height", 0)),
            rec["offset"], rec["size"], rec.get("error", "")))
    else:
        print("%-9s %-4s off=%-7d len=%d" % (rec["type_name"], rec["name"], rec["offset"], rec["size"]))
