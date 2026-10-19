#!/usr/bin/env python3
"""Generate the extension icons (stdlib only): two interlocked rings on a rounded square."""
import struct
import sys
import zlib
from pathlib import Path

BG = (15, 118, 110)
FG = (236, 253, 250)
SS = 4  # supersampling per axis


def inside_rrect(x, y, s, r):
    cx = min(max(x, r), s - r)
    cy = min(max(y, r), s - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def in_ring(x, y, cx, cy, r, w):
    d2 = (x - cx) ** 2 + (y - cy) ** 2
    return (r - w / 2) ** 2 <= d2 <= (r + w / 2) ** 2


def render(size):
    rows = []
    r = size * 0.22
    ring_r = size * 0.19
    ring_w = max(1.2, size * 0.075)
    for py in range(size):
        row = bytearray([0])
        for px in range(size):
            bg = fg = 0
            for sy in range(SS):
                for sx in range(SS):
                    x = px + (sx + 0.5) / SS
                    y = py + (sy + 0.5) / SS
                    if inside_rrect(x, y, size, r):
                        bg += 1
                        if in_ring(x, y, size * 0.40, size * 0.5, ring_r, ring_w) or \
                           in_ring(x, y, size * 0.60, size * 0.5, ring_r, ring_w):
                            fg += 1
            n = SS * SS
            a = bg / n
            if bg == 0:
                row += bytes([0, 0, 0, 0])
                continue
            mix = fg / bg
            col = tuple(round(BG[i] * (1 - mix) + FG[i] * mix) for i in range(3))
            row += bytes([*col, round(255 * a)])
        rows.append(bytes(row))
    return b"".join(rows)


def png(size):
    raw = render(size)

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)) +
            chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


if __name__ == "__main__":
    out = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / "icons")
    out.mkdir(parents=True, exist_ok=True)
    for s in (16, 32, 48, 128):
        (out / f"icon{s}.png").write_bytes(png(s))
        print("wrote", out / f"icon{s}.png")
