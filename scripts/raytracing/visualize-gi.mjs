#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import UPNG from 'upng-js';

const [directory] = process.argv.slice(2);
if (!directory)
  throw new Error('usage: node scripts/raytracing/visualize-gi.mjs <evidence-directory>');
const summaries = {};
for (const [stem, size, exposure] of [
  ['gi', 16, 4],
  ['room', 32, 1],
]) {
  const outputs = [];
  for (const name of ['reference', 'field', ...(stem === 'gi' ? ['pt'] : [])]) {
    const bytes = await readFile(join(directory, `${stem}-${name}.bin`));
    if (bytes.length !== size * size * 80) throw new Error(`unexpected ${stem}-${name} extent`);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = 256,
      rgba = new Uint8Array(width * width * 4),
      support = rgba.slice();
    const counts = { complete: 0, background: 0, incomplete: 0, invalidMaterial: 0 };
    for (let i = 0; i < size * size; i++) {
      if (
        name === 'pt' &&
        (view.getUint32(i * 80 + 12, true) !== 512 || view.getUint32(i * 80 + 28, true) !== 0)
      )
        throw new Error('unqualified PT sample');
      const status = name === 'pt' ? 1 : view.getUint32(i * 80 + 64, true);
      const state = ['background', 'complete', 'incomplete', 'invalidMaterial'][status];
      if (!state) throw new Error(`unexpected status ${status}`);
      counts[state]++;
      const rgb = [0, 1, 2].map((c) => {
        const raw = view.getFloat32(i * 80 + (name === 'pt' ? 0 : 48) + c * 4, true);
        if (!Number.isFinite(raw) || raw < 0)
          throw new Error(`invalid radiance in ${stem}-${name}`);
        const value = (exposure * raw) / (1 + exposure * raw);
        return Math.round(
          255 * (value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055),
        );
      });
      for (let y = 0; y < width / size; y++)
        for (let x = 0; x < width / size; x++) {
          const target =
            (((Math.floor(i / size) * width) / size + y) * width +
              ((i % size) * width) / size +
              x) *
            4;
          rgba.set([...(status === 0 || status === 1 ? rgb : [190, 0, 170]), 255], target);
          support.set(
            [...(status === 1 ? [40, 190, 70] : status === 0 ? [0, 0, 0] : [190, 0, 170]), 255],
            target,
          );
        }
    }
    summaries[`${stem}-${name}`] = counts;
    outputs.push(rgba);
    for (const [suffix, data] of [
      ['', rgba],
      ['-support', support],
    ]) {
      await writeFile(
        join(directory, `${stem}-${name}${suffix}.png`),
        new Uint8Array(UPNG.encode([data.buffer], width, width, 0)),
      );
    }
  }
  const combined = new Uint8Array(256 * outputs.length * 256 * 4);
  for (let row = 0; row < 256; row++)
    for (const [column, data] of outputs.entries())
      combined.set(
        data.subarray(row * 1024, (row + 1) * 1024),
        (row * outputs.length + column) * 1024,
      );
  await writeFile(
    join(directory, `${stem}-comparison.png`),
    new Uint8Array(UPNG.encode([combined.buffer], 256 * outputs.length, 256, 0)),
  );
}
await writeFile(
  join(directory, 'gi-visual-summary.json'),
  `${JSON.stringify(summaries, null, 2)}\n`,
);
