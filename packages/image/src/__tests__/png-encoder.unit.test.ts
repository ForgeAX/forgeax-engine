import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { loadUpng } from '../image-decoder-node';
import { encodePng } from '../png-encoder';

describe('PNG output', () => {
  it('encodes a deterministic, valid RGBA8 PNG', () => {
    const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 255, 9, 9, 9, 9]);
    const png = encodePng(2, 2, rgba);
    expect(Array.from(png.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(encodePng(2, 2, rgba)).toEqual(png);
    const view = new DataView(png.buffer, png.byteOffset);
    expect(view.getUint32(16)).toBe(2);
    const idatLength = view.getUint32(33);
    const raw = inflateSync(png.subarray(41, 41 + idatLength));
    expect(Array.from(raw)).toEqual([0, ...rgba.subarray(0, 8), 0, ...rgba.subarray(8)]);
  });

  it('preserves offset RGBA views, transparent RGB and rows through an independent decoder', async () => {
    const upng = await loadUpng();
    for (const [width, height] of [
      [1, 1],
      [2, 3],
      [17, 33],
    ] as const) {
      const storage = Uint8Array.from({ length: width * height * 4 + 9 }, (_, i) => i * 73);
      const rgba = storage.subarray(5, 5 + width * height * 4);
      rgba[0] = 19;
      rgba[1] = 39;
      rgba[2] = 59;
      rgba[3] = 0;
      const png = encodePng(width, height, rgba);
      const decoded = upng.decode(png.slice().buffer);
      expect([decoded.width, decoded.height, decoded.depth, decoded.ctype]).toEqual([
        width,
        height,
        8,
        6,
      ]);
      expect(upng.toRGBA8(decoded)).toEqual([rgba.slice().buffer]);
    }
  });
});
