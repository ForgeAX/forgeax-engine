import { expect, test } from 'vitest';
import { visualizeCardAtlas } from '../raytracing/visualize-card-atlas.mjs';

function fixture() {
  const rgba = (words: number[]) => new Uint8Array(Uint16Array.from(words).buffer);
  return {
    albedoRoughness: rgba([0x3c00, 0, 0, 0x3800, 0, 0, 0, 0]),
    // Shading +X and geometry -Z are separate oct pairs; all-zero is +Z, not empty.
    normals: rgba([0x3c00, 0, 0x3c00, 0x3c00, 0, 0, 0, 0]),
    emissionMetallic: rgba([0, 0x3c00, 0, 0x3c00, 0, 0, 0, 0]),
    f0Validity: rgba([0, 0, 0, 0x3c00, 0, 0, 0, 0]),
    depth: new Uint8Array(Float32Array.from([0.25, 0]).buffer),
  };
}

test('decodes both oct normals and separates black F0 from empty coverage', () => {
  const result = visualizeCardAtlas(fixture(), 2, 1);
  const panel = (index: number, x = 0) => {
    const pixel = Math.floor(index / 3) * 9 * result.width + (index % 3) * 10 + x;
    return [...result.rgba.slice(pixel * 4, pixel * 4 + 4)];
  };
  expect(result.report.counts).toEqual({
    empty: 1,
    admitted: 1,
    unsupported: 0,
    coverageRejected: 0,
  });
  expect(panel(0)).toEqual([255, 0, 0, 255]);
  expect(panel(1)).toEqual([128, 128, 128, 255]);
  expect(panel(2)).toEqual([255, 128, 128, 255]);
  expect(panel(3)).toEqual([128, 128, 0, 255]);
  expect(panel(4)).toEqual([0, 188, 0, 255]);
  expect(panel(6)).toEqual([0, 0, 0, 255]);
  expect(panel(7)).toEqual([40, 190, 70, 255]);
  expect(panel(8)).toEqual([64, 64, 64, 255]);
  expect(panel(2, 1)).toEqual([12, 16, 24, 255]);
});

test('rejects wrong packing, nonfinite texels and invalid display dimensions', () => {
  expect(() => visualizeCardAtlas(fixture(), 3, 1)).toThrow(/tightly packed/);
  const bad = fixture();
  new DataView(bad.depth.buffer).setFloat32(0, NaN, true);
  expect(() => visualizeCardAtlas(bad, 2, 1)).toThrow(/nonfinite.*texel 0/);
  expect(() => visualizeCardAtlas(fixture(), 2, 1, 0)).toThrow(/positive integer/);
});
