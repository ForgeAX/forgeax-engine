import { describe, expect, expectTypeOf, it } from 'vitest';
import type { TextureAsset, TextureMipPolicy, TextureShape } from '../index.js';

const shape: TextureShape = {
  viewDimension: '2d',
  extent: { width: 4, height: 2 },
};

const mips: TextureMipPolicy = { kind: 'none' };

describe('TextureAsset contract', () => {
  it('uses one closed shape and one mip policy', () => {
    const asset = {
      kind: 'texture',
      shape,
      format: 'rgba8unorm',
      data: new Uint8Array(32),
      colorSpace: 'linear',
      mips,
    } satisfies TextureAsset;

    expect(asset.shape.viewDimension).toBe('2d');
    expect(asset.mips.kind).toBe('none');
    expectTypeOf(asset).toMatchTypeOf<TextureAsset>();
  });

  it('rejects the retired width/height and mip facts', () => {
    const legacy: TextureAsset = {
      kind: 'texture',
      // @ts-expect-error - width is retired from the closed shape.
      width: 4,
      height: 2,
      format: 'rgba8unorm',
      data: new Uint8Array(32),
      colorSpace: 'linear',
      mipmap: false,
    };
    void legacy;

    const secondKind: TextureAsset = {
      // @ts-expect-error - only the single public texture kind is accepted.
      kind: 'texture3d',
      shape: { viewDimension: '3d', extent: { width: 1, height: 1, depth: 1 } },
      format: 'r8unorm',
      data: new Uint8Array(1),
      colorSpace: 'linear',
      mips,
    };
    void secondKind;
  });
});
