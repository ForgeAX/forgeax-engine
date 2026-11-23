import { expect, it } from 'vitest';
import { applyTextureContentWrite, textureRangeCovered } from '../content-ranges.js';
import type { GraphTextureContentRange } from '../types.js';

it('matches individual aspect cells through overlapping writes, discards and repairs', () => {
  const committed: GraphTextureContentRange[] = [];
  const cells = new Uint8Array(12);
  const aspects = ['all', 'depth-only', 'stencil-only'] as const;
  const ranges: GraphTextureContentRange[] = [];
  for (let mipStart = 0; mipStart < 3; mipStart++)
    for (let mipEnd = mipStart + 1; mipEnd <= 3; mipEnd++)
      for (let layerStart = 0; layerStart < 4; layerStart++)
        for (let layerEnd = layerStart + 1; layerEnd <= 4; layerEnd++)
          for (const aspect of aspects)
            ranges.push({ mipStart, mipEnd, layerStart, layerEnd, aspect });

  function mask(aspect: GPUTextureAspect): number {
    return aspect === 'all' ? 3 : aspect === 'depth-only' ? 1 : 2;
  }
  for (let step = 0; step < ranges.length; step++) {
    const write = ranges[(step * 73) % ranges.length] as GraphTextureContentRange;
    const stored = step % 5 !== 1;
    applyTextureContentWrite(committed, write, stored);
    for (let mip = write.mipStart; mip < write.mipEnd; mip++) {
      for (let layer = write.layerStart; layer < write.layerEnd; layer++) {
        const slot = mip * 4 + layer;
        const previous = cells[slot] ?? 0;
        cells[slot] = stored ? previous | mask(write.aspect) : previous & ~mask(write.aspect);
      }
    }
    for (const read of ranges) {
      let initialized = true;
      const required = mask(read.aspect);
      for (let mip = read.mipStart; mip < read.mipEnd; mip++)
        for (let layer = read.layerStart; layer < read.layerEnd; layer++)
          if (((cells[mip * 4 + layer] ?? 0) & required) !== required) initialized = false;
      if (textureRangeCovered(read, committed) !== initialized)
        throw new Error(`coverage mismatch at write ${step}, read ${JSON.stringify(read)}`);
    }
  }
  expect(committed.length).toBeGreaterThan(0);
});

it('keeps one validity rectangle for ordered mip/layer uploads and subsequent partial stores', () => {
  const committed: GraphTextureContentRange[] = [];
  for (let layer = 0; layer < 64; layer++)
    for (let mip = 0; mip < 8; mip++)
      for (const aspect of ['depth-only', 'stencil-only'] as const)
        applyTextureContentWrite(
          committed,
          { mipStart: mip, mipEnd: mip + 1, layerStart: layer, layerEnd: layer + 1, aspect },
          true,
        );
  expect(committed).toEqual([
    { mipStart: 0, mipEnd: 8, layerStart: 0, layerEnd: 64, aspect: 'all' },
  ]);
  const fullRange = committed[0];
  const oneCell = {
    mipStart: 2,
    mipEnd: 3,
    layerStart: 7,
    layerEnd: 8,
    aspect: 'depth-only',
  } as const;
  applyTextureContentWrite(committed, oneCell, true);
  expect(committed[0]).toBe(fullRange);
  expect(committed).toHaveLength(1);
  applyTextureContentWrite(committed, oneCell, false);
  expect(textureRangeCovered(oneCell, committed)).toBe(false);
  expect(textureRangeCovered({ ...oneCell, aspect: 'stencil-only' }, committed)).toBe(true);
});
