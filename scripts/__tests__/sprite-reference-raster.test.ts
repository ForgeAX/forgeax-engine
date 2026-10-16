import { describe, expect, it } from 'vitest';
import { rasterizeSpriteReference } from '../../apps/hello/sprite/scripts/reference-raster.mjs';

const input = {
  width: 2,
  height: 2,
  clear: [0, 0, 0, 1],
  layout: { pivot: [0.5, 0.5], sprites: [{ pos: [0, 0, 0] }] },
  tints: [[1, 1, 1, 1]],
  scale: 2,
  tonemap: 'none',
  texture: { width: 1, height: 1, data: new Uint8Array([128, 128, 128, 255]) },
};

describe('sprite source-derived raster reference', () => {
  it('round-trips sRGB exactly once rather than inheriting a captured double encode', () => {
    const output = rasterizeSpriteReference(input);
    expect([...output.pixels.slice(0, 4)]).toEqual([128, 128, 128, 255]);
  });

  it('blends premultiplied alpha in linear light before output encoding', () => {
    const output = rasterizeSpriteReference({
      ...input,
      tints: [[1, 1, 1, 0.5]],
      texture: { width: 1, height: 1, data: new Uint8Array([255, 255, 255, 255]) },
    });
    expect([...output.pixels.slice(0, 4)]).toEqual([188, 188, 188, 255]);
  });

  it('maps pivot and texture orientation independently of shader source', () => {
    const output = rasterizeSpriteReference({
      ...input,
      texture: {
        width: 2,
        height: 2,
        data: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]),
      },
    });
    expect([...output.pixels]).toEqual([
      0, 0, 255, 255, 255, 255, 255, 255, 255, 0, 0, 255, 0, 255, 0, 255,
    ]);
    const shifted = rasterizeSpriteReference({
      ...input,
      layout: { ...input.layout, pivot: [0, 0] },
    });
    expect([...shifted.pixels]).toEqual([
      0, 0, 0, 255, 128, 128, 128, 255, 0, 0, 0, 255, 0, 0, 0, 255,
    ]);
  });

  it('applies luminance-domain Reinhard extended before the single output transfer', () => {
    const output = rasterizeSpriteReference({
      ...input,
      tonemap: 'reinhard',
      texture: { width: 1, height: 1, data: new Uint8Array([255, 255, 255, 255]) },
    });
    expect([...output.pixels.slice(0, 4)]).toEqual([189, 189, 189, 255]);
  });
});
