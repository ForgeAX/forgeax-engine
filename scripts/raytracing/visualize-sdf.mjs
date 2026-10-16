#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import UPNG from 'upng-js';
import { distanceFieldTexel } from '../../packages/geometry/dist/index.mjs';
import { CARD_LOOKUP_STRIDE } from '../../packages/render/dist/internal.mjs';

const [directory] = process.argv.slice(2);
if (!directory)
  throw new Error('usage: node scripts/raytracing/visualize-sdf.mjs <evidence-directory>');
const fixture = JSON.parse(await readFile(join(directory, 'sdf-prepared.json'), 'utf8'));
async function png(name, width, height, pixel, scale = 6) {
  const data = new Uint8Array(width * height * scale * scale * 4);
  for (let y = 0; y < height * scale; y++)
    for (let x = 0; x < width * scale; x++)
      data.set(
        [...pixel(Math.floor(x / scale), Math.floor(y / scale)), 255],
        (y * width * scale + x) * 4,
      );
  await writeFile(
    join(directory, `${name}.png`),
    new Uint8Array(UPNG.encode([data.buffer], width * scale, height * scale, 0)),
  );
}
const field = {
    ...fixture.field,
    bricks: Uint32Array.from(fixture.field.bricks),
    values: Float32Array.from(fixture.field.values),
  },
  [nx, ny, nz] = field.dimensions;
await png(
  'sdf-slice',
  nx,
  ny,
  (x, y) => {
    const d = distanceFieldTexel(field, x, y, Math.floor(nz / 2));
    const s = Math.min(1, Math.abs(d) / 0.8);
    return Math.abs(d) < field.spacing * 0.15
      ? [255, 220, 70]
      : d < 0
        ? [Math.round(80 + 175 * s), 40, 30]
        : [30, Math.round(60 + 120 * s), 210];
  },
  8,
);
const hits = await readFile(join(directory, 'sdf-hits.bin')),
  lookup = await readFile(join(directory, 'sdf-lookup.bin'));
if (hits.length !== (1024 + 3) * 64 || lookup.length !== (1024 + 3) * CARD_LOOKUP_STRIDE)
  throw new Error('expected 32x32 SDF corpus plus three diagnostic rays');
const hv = new DataView(hits.buffer, hits.byteOffset, hits.byteLength),
  lv = new DataView(lookup.buffer, lookup.byteOffset, lookup.byteLength);
const statusColors = [
  [20, 25, 35],
  [65, 195, 225],
  [255, 170, 40],
  [235, 65, 65],
  [205, 65, 210],
];
await png('sdf-status', 32, 32, (x, y) => statusColors[hv.getUint32((3 + y * 32 + x) * 64, true)]);
await png(
  'card-mapping',
  32,
  32,
  (x, y) =>
    [
      [20, 25, 35],
      [70, 205, 95],
      [240, 75, 180],
      [255, 170, 40],
    ][lv.getUint32((3 + y * 32 + x) * CARD_LOOKUP_STRIDE, true)],
);
function half(view, offset) {
  const v = view.getUint16(offset, true),
    e = (v >> 10) & 31,
    m = v & 1023;
  return (v & 32768 ? -1 : 1) * (e === 0 ? m * 2 ** -24 : (1 + m / 1024) * 2 ** (e - 15));
}
const srgb = (v) =>
  Math.round(
    255 * Math.max(0, Math.min(1, v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)),
  );
function decodeNormal(x, y) {
  const z = 1 - Math.abs(x) - Math.abs(y);
  if (z < 0) [x, y] = [(1 - Math.abs(y)) * (x < 0 ? -1 : 1), (1 - Math.abs(x)) * (y < 0 ? -1 : 1)];
  const length = Math.hypot(x, y, z);
  return [x, y, z].map((v) => Math.round(255 * ((v / length) * 0.5 + 0.5)));
}
for (let plane = 0; plane < 4; plane++) {
  const bytes = await readFile(join(directory, `card-plane-${plane}.bin`)),
    view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  await png(`card-plane-${plane}`, 96, 16, (x, y) => {
    const offset = (y * 96 + x) * 8;
    if (plane === 1) return decodeNormal(half(view, offset), half(view, offset + 2));
    return [0, 1, 2].map((c) => {
      const v = half(view, offset + c * 2);
      return srgb(plane === 2 ? v / (1 + v) : v);
    });
  });
  if (plane === 1)
    await png('card-geometric-normal', 96, 16, (x, y) => {
      const offset = (y * 96 + x) * 8;
      return decodeNormal(half(view, offset + 4), half(view, offset + 6));
    });
}
