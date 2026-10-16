#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import UPNG from 'upng-js';

const [path, widthArg, heightArg] = process.argv.slice(2);
const width = Number(widthArg),
  height = Number(heightArg);
if (
  !path ||
  !Number.isSafeInteger(width) ||
  !Number.isSafeInteger(height) ||
  width < 1 ||
  height < 1
)
  throw new Error(
    'usage: node scripts/raytracing/visualize-surfaces.mjs <raw.rgba32uint> <width> <height>',
  );
const bytes = await readFile(path);
if (bytes.byteLength !== width * height * 16) throw new Error('expected tightly packed rgba32uint');
const words = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const scale = Math.max(1, Math.floor(384 / Math.max(width, height)));
const panelWidth = width * scale,
  panelHeight = height * scale;
const gap = 8,
  imageWidth = panelWidth * 2 + gap,
  imageHeight = panelHeight * 2 + gap;
const rgba = new Uint8Array(imageWidth * imageHeight * 4);
const palette = (id) => {
  const hash = Math.imul((id + 1) >>> 0, 2654435761) >>> 0;
  return [0, 8, 16].map((shift) => 64 + ((hash >>> shift) & 191));
};
const normal = (packed) => {
  let x = ((packed & 4095) / 4095) * 2 - 1;
  let y = (((packed >>> 12) & 4095) / 4095) * 2 - 1;
  const z = 1 - Math.abs(x) - Math.abs(y);
  if (z < 0) [x, y] = [(1 - Math.abs(y)) * (x < 0 ? -1 : 1), (1 - Math.abs(x)) * (y < 0 ? -1 : 1)];
  const length = Math.hypot(x, y, z);
  return [x, y, z].map((v) => Math.round(((v / length) * 0.5 + 0.5) * 255));
};
const rows = new Map();
let covered = 0,
  front = 0,
  invalid = 0;
for (let y = 0; y < height; y++)
  for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 16;
    const [row, primitive, packed, flags] = [0, 4, 8, 12].map((o) =>
      words.getUint32(offset + o, true),
    );
    const isCovered = (flags & 1) !== 0;
    if (isCovered) {
      covered++;
      if (flags & 2) front++;
      if (row === 0) invalid++;
      const entry = rows.get(row) ?? { pixels: 0, primitives: new Set() };
      entry.pixels++;
      entry.primitives.add(primitive);
      rows.set(row, entry);
    }
    const panels = isCovered
      ? [
          row === 0 ? [255, 0, 255] : palette(row),
          palette(primitive),
          normal(packed),
          flags & 2 ? [60, 210, 135] : [240, 160, 40],
        ]
      : Array.from({ length: 4 }, () => [12, 16, 24]);
    for (let panel = 0; panel < 4; panel++)
      for (let sy = 0; sy < scale; sy++)
        for (let sx = 0; sx < scale; sx++) {
          const px = (panel % 2) * (panelWidth + gap) + x * scale + sx;
          const py = Math.floor(panel / 2) * (panelHeight + gap) + y * scale + sy;
          rgba.set([...panels[panel], 255], (py * imageWidth + px) * 4);
        }
  }
const prefix = path.replace(/\.rgba32uint$/, '');
await writeFile(
  `${prefix}.png`,
  new Uint8Array(UPNG.encode([rgba.buffer], imageWidth, imageHeight, 0)),
);
const report = {
  kind: 'visible-surface-diagnostic',
  source: path.slice(dirname(path).length + 1),
  sha256: createHash('sha256').update(bytes).digest('hex'),
  width,
  height,
  scale,
  panels: [
    'top-left: frame row identity',
    'top-right: draw-local primitive',
    'bottom-left: geometric normal RGB',
    'bottom-right: front green / back orange / uncovered dark',
  ],
  covered,
  front,
  back: covered - front,
  invalid,
  rows: [...rows]
    .sort((a, b) => a[0] - b[0])
    .map(([row, value]) => ({
      row,
      pixels: value.pixels,
      primitives: [...value.primitives].sort((a, b) => a - b),
    })),
};
await writeFile(`${prefix}.json`, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ image: `${prefix}.png`, covered, front, invalid, rows: rows.size }));
