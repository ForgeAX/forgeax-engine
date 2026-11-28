"""Writes font-reference.json: fontTools facts and numpy nonzero-winding reference rasters (TrueType fill rule).

Usage: python3 -I generate-font-reference.py NotoSansSC-Bold-subset.ttf font-reference.json
(python3 -I disables the user site, so fontTools and numpy are added explicitly below.)
"""
import glob
import json
import os
import sys

for site in glob.glob(os.path.expanduser('~/.local/lib/python3*/site-packages')):
    sys.path.insert(0, site)

import numpy as np
from fontTools.pens.areaPen import AreaPen
from fontTools.pens.basePen import BasePen
from fontTools.pens.boundsPen import BoundsPen
from fontTools.ttLib import TTFont

CHARS = ['0', '8', 'A', '\u5c71', '\u95e8']  # U+5C71 shan, U+95E8 men
GRID = 80
X0, X1 = 0.0, 1.0
Y0, Y1 = -0.2, 1.0
SUBDIVISIONS = 64


class Flatten(BasePen):
    def __init__(self, glyph_set):
        super().__init__(glyph_set)
        self.rings = []
        self.current = None

    def _moveTo(self, pt):
        self.current = [pt]
        self.rings.append(self.current)

    def _lineTo(self, pt):
        self.current.append(pt)

    def _qCurveToOne(self, p1, p2):
        p0 = self.current[-1]
        for k in range(1, SUBDIVISIONS + 1):
            t = k / SUBDIVISIONS
            u = 1 - t
            self.current.append((u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
                                 u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]))

    def _curveToOne(self, p1, p2, p3):
        raise ValueError('cubic outlines are not expected in TrueType')

    def _closePath(self):
        pass

    def _endPath(self):
        pass


def signed_area(ring):
    pts = np.array(ring, dtype=float)
    nxt = np.roll(pts, -1, axis=0)
    return float(np.sum(pts[:, 0] * nxt[:, 1] - nxt[:, 0] * pts[:, 1]) / 2)


def nonzero(rings):
    xs = (np.arange(GRID) + 0.5) / GRID * (X1 - X0) + X0
    ys = (np.arange(GRID) + 0.5) / GRID * (Y1 - Y0) + Y0
    px, py = np.meshgrid(xs, ys)
    winding = np.zeros(px.shape, dtype=int)
    for ring in rings:
        pts = np.array(ring, dtype=float) / 1000.0
        if len(pts) < 3:
            continue
        nxt = np.roll(pts, -1, axis=0)
        x1, y1 = pts[:, 0][:, None, None], pts[:, 1][:, None, None]
        x2, y2 = nxt[:, 0][:, None, None], nxt[:, 1][:, None, None]
        up = (y1 <= py) & (y2 > py)
        down = (y2 <= py) & (y1 > py)
        cross = (x2 - x1) * (py - y1) - (px - x1) * (y2 - y1)
        winding += (up & (cross > 0)).sum(axis=0)
        winding -= (down & (cross < 0)).sum(axis=0)
    return winding != 0




def main(font_path, out_path):
    font = TTFont(font_path)
    cmap = font.getBestCmap()
    glyph_set = font.getGlyphSet()
    hmtx = font['hmtx']
    vmtx = font['vmtx'] if 'vmtx' in font else None
    facts = {}
    rasters = {}
    for ch in CHARS:
        name = cmap[ord(ch)]
        bounds = BoundsPen(glyph_set)
        glyph_set[name].draw(bounds)
        area = AreaPen(glyph_set)
        glyph_set[name].draw(area)
        flat = Flatten(glyph_set)
        glyph_set[name].draw(flat)
        rings = [r for r in flat.rings if len(r) >= 3]
        advance = hmtx[name][0]
        tsb = vmtx[name][1] if vmtx is not None else 0
        facts[ch] = {
            'glyph': name,
            'advance': advance,
            'bounds': list(bounds.bounds) if bounds.bounds else None,
            'area': area.value,
            'contours': len(rings),
            'holes': sum(1 for r in rings if signed_area(r) > 0),
            'verticalAdvance': vmtx[name][0] if vmtx is not None else 0,
            'topSideBearing': tsb,
        }
        mask = nonzero(rings)
        rasters[ch] = [''.join('1' if mask[row, col] else '0' for col in range(GRID))
                       for row in range(GRID - 1, -1, -1)]
    doc = {
        'source': os.path.basename(font_path),
        'grid': {'size': GRID, 'x0': X0, 'x1': X1, 'y0': Y0, 'y1': Y1, 'order': 'rows top to bottom'},
        'glyphs': facts,
        'rasters': rasters,
    }
    with open(out_path, 'w', encoding='utf-8') as handle:
        json.dump(doc, handle, indent=1, ensure_ascii=True)
        handle.write('\n')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
