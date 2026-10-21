import { expect, it } from 'vitest';
import { decodeTerrainHeight, encodeTerrainHeight, terrainHeightAtlas } from '../height-atlas';

it('round-trips raw finite f32 values without a global range', () => {
  for (const value of [-3e38, -1e8, -0.1, -0, 0, 0.1, 1e12, 3e38]) {
    const bytes = Uint8Array.from(encodeTerrainHeight(value));
    expect(Object.is(decodeTerrainHeight(bytes, 0), Math.fround(value))).toBe(true);
  }
});

it('bounds physical atlas axes for every admitted grid aspect ratio', () => {
  for (let n = 2; n <= 128; n *= 2) {
    for (let columns = n; columns * n <= 4194304; columns += n - 1) {
      const rows = Math.floor((Math.floor(4194304 / columns) - 1) / (n - 1)) * (n - 1) + 1;
      const atlas = terrainHeightAtlas({ columns, rows, subsectionVertices: n });
      if (atlas.width > 4096 || atlas.height > 4096 || atlas.width % n || atlas.height % n)
        throw new Error(`unbounded atlas: ${columns}x${rows} / ${n}`);
    }
  }
});

it('recovers logical section coordinates from admitted f32 section metres', () => {
  for (const count of [1, 3, 2047, 65535, 2097151]) {
    for (const spacing of [1e-20, 0.0003, 0.1, 0.37, 1, 137.21, 1e20]) {
      for (const index of [0, 1, Math.floor(count / 2), count - 1]) {
        if (index >= count) continue;
        const recovered = Math.round(
          Math.fround(Math.fround(index * spacing) / Math.fround(spacing)),
        );
        expect(recovered, `section ${index}, count ${count}, spacing ${spacing}`).toBe(index);
      }
    }
  }
});
