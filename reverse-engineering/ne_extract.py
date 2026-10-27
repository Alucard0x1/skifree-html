"""Minimal Win16 NE (New Executable) resource extractor for SKI.EXE.

Parses the MZ + NE headers, walks the resource table, dumps every entry and
extracts RT_BITMAP resources as PNG (for reference only) plus RT_RCDATA blobs.
"""
import json
import struct
import sys
from pathlib import Path

from PIL import Image

RT = {1: "CURSOR", 2: "BITMAP", 3: "ICON", 4: "MENU", 5: "DIALOG", 6: "STRING",
      7: "FONTDIR", 8: "FONT", 9: "ACCELERATOR", 10: "RCDATA", 11: "MESSAGETABLE",
      12: "GROUP_CURSOR", 14: "GROUP_ICON", 15: "NAME_TABLE"}


def read_cstr(data: bytes, off: int) -> str:
    end = data.index(b"\x00", off)
    return data[off:end].decode("cp1252", errors="replace")


class NE:
    def __init__(self, path: Path):
        self.data = data = path.read_bytes()
        if data[:2] != b"MZ":
            raise SystemExit("not MZ")
        ne_off = struct.unpack_from("<I", data, 0x3C)[0]
        self.ne_off = ne_off
        if data[ne_off:ne_off + 2] != b"NE":
            raise SystemExit("not NE at %#x" % ne_off)
        (self.ne_level, self.cpu, self.os) = struct.unpack_from("<HHH", data, ne_off + 2)
        self.flags, self.auto_data, self.heap, self.stack = struct.unpack_from("<HHHH", data, ne_off + 0x0C)
        self.cs_ip, self.ss_sp = struct.unpack_from("<II", data, ne_off + 0x14)
        self.seg_count, self.mod_count = struct.unpack_from("<HH", data, ne_off + 0x1C)
        self.rsrc_off = struct.unpack_from("<H", data, ne_off + 0x24)[0]
        self.rsrc_off_abs = ne_off + self.rsrc_off
        self.resident_off = ne_off + struct.unpack_from("<H", data, ne_off + 0x26)[0]
        self.module_off = ne_off + struct.unpack_from("<H", data, ne_off + 0x28)[0]
        self.import_off = ne_off + struct.unpack_from("<H", data, ne_off + 0x2A)[0]
        self.entry_off = ne_off + struct.unpack_from("<H", data, ne_off + 0x2C)[0]
        self.nonres_off = ne_off + struct.unpack_from("<H", data, ne_off + 0x2E)[0]

    def resident_names(self):
        out, off = [], self.resident_off
        while self.data[off] != 0:
            n = self.data[off]
            out.append(self.data[off + 1:off + 1 + n].decode("cp1252", errors="replace"))
            off += 1 + n
        return out

    def modules(self):
        out, off = [], self.module_off
        for _ in range(self.mod_count):
            start = off
            h = struct.unpack_from("<H", self.data, off)
            off += 2
            n = self.data[off]
            name = self.data[off + 1:off + 1 + n].decode("cp1252", errors="replace")
            out.append({"name": name, "ordinal": h[0]})
            off = start + h[0]
        return out

    def resource_table(self):
        data, base = self.data, self.rsrc_off_abs
        shift = struct.unpack_from("<H", data, base)[0]
        off = base + 2
        types = []
        while True:
            type_id, count = struct.unpack_from("<HH", data, off)
            if type_id == 0 and count == 0:
                break
            off += 8  # type id, count, reserved dword
            type_name = RT.get(type_id, "0x%04x" % type_id)
            if type_id & 0x8000:
                # name string offset into the resource table
                type_name = read_cstr(data, base + (type_id & 0x7FFF))
            entries = []
            for _ in range(count):
                r_off, r_len, r_flags, r_id, _handle, _usage = struct.unpack_from("<HHHHHH", data, off)
                off += 12
                name = r_id
                if r_flags & 0x8000:
                    name = read_cstr(data, base + (r_id & 0x7FFF))
                entries.append({
                    "name": name,
                    "offset": r_off << shift,
                    "length": r_len << shift,
                    "flags": "0x%04x" % r_flags,
                })
            types.append({"type": type_name, "entries": entries})
        return shift, types

    def slice(self, offset, length):
        return self.data[offset:offset + length]


def dib_to_png(dib: bytes, out: Path):
    """Decode a Windows 3.x DIB (BITMAPINFOHEADER + palette + XOR bitmap)."""
    hdr_size, w, h, planes, bpp = struct.unpack_from("<IiiHH", dib, 0)
    compression, = struct.unpack_from("<I", dib, 16)
    clr_used, = struct.unpack_from("<I", dib, 32)
    if bpp not in (1, 4, 8):
        raise ValueError("bpp %d unsupported here" % bpp)
    if clr_used in (0, 0xFFFFFFFF):
        clr_used = 1 << bpp
    pal_off = hdr_size
    palette = []
    for i in range(clr_used):
        b, g, r, _ = struct.unpack_from("<BBBB", dib, pal_off + i * 4)
        palette.append((r, g, b))
    bits_off = pal_off + clr_used * 4
    stride = ((w * bpp + 31) // 32) * 4
    img = Image.new("P", (w, abs(h)))
    flat = []
    for c in palette:
        flat += list(c)
    flat += [0, 0, 0] * (256 - len(palette))
    img.putpalette(flat)
    px = []
    for row in range(abs(h)):
        src_row = row if h < 0 else abs(h) - 1 - row
        base = bits_off + src_row * stride
        for x in range(w):
            byte = dib[base + (x * bpp) // 8]
            if bpp == 8:
                idx = byte
            elif bpp == 4:
                idx = (byte >> 4) if x % 2 == 0 else (byte & 0xF)
            else:
                idx = (byte >> (7 - x % 8)) & 1
            px.append(idx)
    img.putdata(px)
    img.save(out)
    return {"width": w, "height": abs(h), "bpp": bpp, "colors": clr_used,
            "top_down": h < 0, "compression": compression, "bytes": len(dib)}


def main():
    exe = Path(sys.argv[1])
    outdir = Path(sys.argv[2])
    raw = outdir / "resources"
    raw.mkdir(parents=True, exist_ok=True)
    ne = NE(exe)
    shift, types = ne.resource_table()
    report = {
        "file": exe.name,
        "size": len(ne.data),
        "ne_header_offset": ne.ne_off,
        "ne_level": ne.ne_level,
        "target_os": ne.os,
        "expected_windows_version": "%d.%d" % (ne.os >> 8, ne.os & 0xFF),
        "segments": ne.seg_count,
        "modules": ne.mod_count,
        "cs_ip": "0x%08x" % ne.cs_ip,
        "ss_sp": "0x%08x" % ne.ss_sp,
        "heap_bytes": ne.heap,
        "stack_bytes": ne.stack,
        "resource_shift": shift,
        "resident_names": ne.resident_names(),
        "modules_list": ne.modules(),
        "resources": [],
    }
    for t in types:
        row = {"type": t["type"], "count": len(t["entries"]), "entries": []}
        for i, e in enumerate(t["entries"]):
            info = dict(e)
            blob = ne.slice(e["offset"], e["length"])
            if t["type"] == "BITMAP":
                png = raw / ("%s_%s_%d.png" % (t["type"], e["name"], i))
                try:
                    info.update(dib_to_png(blob, png))
                    info["png"] = str(png)
                except Exception as exc:  # noqa: BLE001
                    info["decode_error"] = str(exc)
            elif t["type"] == "RCDATA":
                (raw / ("RCDATA_%s_%d.bin" % (e["name"], i))).write_bytes(blob)
                printable = sum(1 for b in blob if 32 <= b < 127)
                info["printable_ratio"] = round(printable / max(1, len(blob)), 3)
            row["entries"].append(info)
        report["resources"].append(row)
    (outdir / "ne_report.json").write_text(json.dumps(report, indent=1), encoding="utf-8")
    print(json.dumps({k: v for k, v in report.items() if k != "resources"}, indent=1, ensure_ascii=False))
    for row in report["resources"]:
        print("\n== %s (%d)" % (row["type"], row["count"]))
        for e in row["entries"]:
            extra = ""
            if "width" in e:
                extra = " %dx%d %dbpp palette=%d" % (e["width"], e["height"], e["bpp"], e["colors"])
            elif "printable_ratio" in e:
                extra = " printable=%.2f" % e["printable_ratio"]
            print("  - %-14s off=%-6d len=%-6d%s" % (e["name"], e["offset"], e["length"], extra))


if __name__ == "__main__":
    main()
