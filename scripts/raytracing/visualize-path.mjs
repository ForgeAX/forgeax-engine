#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import UPNG from 'upng-js';

const [directory] = process.argv.slice(2);
if (!directory)
  throw new Error('usage: node scripts/raytracing/visualize-path.mjs <evidence-directory>');
const bytes = await readFile(join(directory, 'gallery-accumulation.bin'));
if (bytes.length !== 64 * 64 * 80)
  throw new Error('expected the 64x64 reference gallery accumulation');
const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const rgba = new Uint8Array(64 * 64 * 4),
  albedo = rgba.slice(),
  normal = rgba.slice();
for (let i = 0; i < 4096; i++) {
  if (view.getUint32(i * 80 + 12, true) !== 128 || view.getUint32(i * 80 + 28, true) !== 0)
    throw new Error(`unqualified pixel ${i}`);
  for (let c = 0; c < 3; c++) {
    const raw = view.getFloat32(i * 80 + c * 4, true);
    if (!Number.isFinite(raw) || raw < 0) throw new Error(`invalid HDR pixel ${i}`);
    const ldr = raw / (1 + raw);
    rgba[i * 4 + c] = Math.round(
      255 * (ldr <= 0.0031308 ? 12.92 * ldr : 1.055 * ldr ** (1 / 2.4) - 0.055),
    );
    albedo[i * 4 + c] = Math.round(
      255 * Math.max(0, Math.min(1, view.getFloat32(i * 80 + 32 + c * 4, true))),
    );
    normal[i * 4 + c] = Math.round(255 * (view.getFloat32(i * 80 + 48 + c * 4, true) * 0.5 + 0.5));
  }
  rgba[i * 4 + 3] = 255;
  albedo[i * 4 + 3] = 255;
  normal[i * 4 + 3] = 255;
}
for (const [name, data] of [
  ['gallery', rgba],
  ['gallery-albedo', albedo],
  ['gallery-normal', normal],
])
  await writeFile(
    join(directory, `${name}.png`),
    new Uint8Array(UPNG.encode([data.buffer], 64, 64, 0)),
  );
