import type { AssetGuid, FontAsset, TextureAsset } from '@forgeax/engine/types';

const BITMAPS: Readonly<Record<string, readonly string[]>> = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01111', '10000', '10000', '10111', '10001', '10001', '01111'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
};

const DOT = 8;
const PAD = 8;
const CELL_W = 5 * DOT + PAD * 2;
const CELL_H = 7 * DOT + PAD * 2;
const RANGE = 8;

/**
 * Builds a single-channel SDF atlas (same distance in R, G and B, so the MSDF median is the SDF)
 * from 5x7 bitmap glyphs; metrics are in atlas pixels like a baked FontAsset.
 */
export function buildSdfFont(
  atlasGuid: AssetGuid,
  samplerGuid: AssetGuid,
): { atlas: TextureAsset; font: FontAsset } {
  const chars = Object.keys(BITMAPS);
  const width = CELL_W * chars.length;
  const height = CELL_H;
  const data = new Uint8Array(width * height * 4);
  const glyphs: Record<number, FontAsset['glyphs'][number]> = {};
  chars.forEach((ch, index) => {
    const rows = BITMAPS[ch] ?? [];
    const rects: [number, number][] = [];
    rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x++)
        if (row[x] === '1') rects.push([PAD + x * DOT, PAD + y * DOT]);
    });
    const ox = index * CELL_W;
    for (let py = 0; py < CELL_H; py++) {
      for (let px = 0; px < CELL_W; px++) {
        const cx = px + 0.5;
        const cy = py + 0.5;
        let outside = Number.POSITIVE_INFINITY;
        let inside = false;
        for (const [rx, ry] of rects) {
          const dx = Math.max(rx - cx, 0, cx - (rx + DOT));
          const dy = Math.max(ry - cy, 0, cy - (ry + DOT));
          const d = Math.hypot(dx, dy);
          if (d === 0) inside = true;
          outside = Math.min(outside, d);
        }
        let signed = -outside;
        if (inside) {
          let edge = Number.POSITIVE_INFINITY;
          for (let sy = -RANGE; sy <= RANGE; sy++) {
            for (let sx = -RANGE; sx <= RANGE; sx++) {
              const qx = Math.floor((cx + sx - PAD) / DOT);
              const qy = Math.floor((cy + sy - PAD) / DOT);
              const filled = rows[qy]?.[qx] === '1';
              if (!filled) edge = Math.min(edge, Math.hypot(sx, sy));
            }
          }
          signed = Math.min(edge, RANGE);
        }
        const v = Math.round(Math.min(Math.max(0.5 + signed / RANGE / 2, 0), 1) * 255);
        const o = (py * width + ox + px) * 4;
        data[o] = v;
        data[o + 1] = v;
        data[o + 2] = v;
        data[o + 3] = 255;
      }
    }
    glyphs[ch.codePointAt(0) as number] = {
      advance: CELL_W - PAD,
      bearingX: 0,
      bearingY: 0,
      size: { w: CELL_W, h: CELL_H },
      region: { x: ox, y: 0, w: CELL_W, h: CELL_H },
    };
  });
  glyphs[32] = {
    advance: CELL_W - PAD,
    bearingX: 0,
    bearingY: 0,
    size: { w: 0, h: 0 },
    region: { x: 0, y: 0, w: 0, h: 0 },
  };
  const atlas: TextureAsset = {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width, height } },
    format: 'rgba8unorm',
    data,
    colorSpace: 'linear',
    mips: { kind: 'none' },
  };
  const font: FontAsset = {
    kind: 'font',
    atlas: atlasGuid,
    sampler: samplerGuid,
    glyphs,
    common: {
      lineHeight: CELL_H,
      base: CELL_H - PAD,
      distanceRange: RANGE * 2,
      pxRange: RANGE * 2,
      atlasWidth: width,
      atlasHeight: height,
    },
  } as FontAsset;
  return { atlas, font };
}
