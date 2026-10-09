#!/usr/bin/env python3
"""Draws the toolbar/store icons (a briefcase on a blue tile) with no dependencies. Run once; the PNGs are committed."""
import struct, sys, zlib, os

def rrect(x, y, x0, y0, x1, y1, r):
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r

def pixel(u, v):
    """u, v in 0..1 -> (r, g, b, a) at one sample."""
    if not rrect(u, v, 0.02, 0.02, 0.98, 0.98, 0.22):
        return (0, 0, 0, 0)
    white = (255, 255, 255)
    blue = (39, 118, 208)
    # handle: ring above the body
    outer = rrect(u, v, 0.34, 0.20, 0.66, 0.42, 0.06)
    inner = rrect(u, v, 0.41, 0.27, 0.59, 0.45, 0.03)
    body = rrect(u, v, 0.18, 0.34, 0.82, 0.78, 0.07)
    clasp = rrect(u, v, 0.44, 0.50, 0.56, 0.62, 0.02)
    seam = 0.505 <= v <= 0.535 and 0.18 <= u <= 0.82 and not clasp
    if body and clasp:
        return (*blue, 255)
    if body and seam:
        return (*blue, 255)
    if body or (outer and not inner):
        return (*white, 255)
    return (*blue, 255)

def render(size, ss=4):
    rows = []
    for py in range(size):
        row = bytearray([0])
        for px in range(size):
            acc = [0, 0, 0, 0]
            for sy in range(ss):
                for sx in range(ss):
                    r, g, b, a = pixel((px + (sx + 0.5) / ss) / size, (py + (sy + 0.5) / ss) / size)
                    acc[0] += r * a; acc[1] += g * a; acc[2] += b * a; acc[3] += a
            n = ss * ss
            a = acc[3]
            if a:
                row += bytes([round(acc[0] / a), round(acc[1] / a), round(acc[2] / a), round(a / n)])
            else:
                row += bytes([0, 0, 0, 0])
        rows.append(bytes(row))
    raw = b"".join(rows)
    def chunk(t, d):
        c = struct.pack(">I", len(d)) + t + d
        return c + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")

out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "icons")
os.makedirs(out, exist_ok=True)
for s in (16, 32, 48, 128):
    with open(os.path.join(out, f"icon-{s}.png"), "wb") as f:
        f.write(render(s))
