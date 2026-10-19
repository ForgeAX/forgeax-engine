import type { EquirectAsset, TextureAsset } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import {
  describeTextureView,
  textureViewSource,
  validateTextureViewOptions,
} from '../texture-view.js';

const texture: TextureAsset = {
  kind: 'texture',
  shape: { viewDimension: '2d-array', extent: { width: 8, height: 4, layers: 2 } },
  format: 'rgba8unorm',
  data: new Uint8Array(344),
  colorSpace: 'srgb',
  mips: { kind: 'packed', levelCount: 4 },
};

it('derives the actual packed mip chain and array layers without rewriting source bytes', () => {
  const info = describeTextureView(texture);
  expect(info).toMatchObject({ mipCount: 4, depth: 2, width: 8, height: 4, sourceBytes: 344 });
  expect(textureViewSource(texture)).toBe(texture);
  expect(validateTextureViewOptions(info, { mip: 3, layer: 1 }).mip).toBe(3);
  for (const patch of [
    { mip: 4 },
    { mip: -1 },
    { layer: 2 },
    { mip: 0.5 },
    { exposure: NaN },
    { projection: 'environment' },
    { unknown: 1 },
    { toString: 1 },
  ]) {
    expect(() => validateTextureViewOptions(info, patch)).toThrow();
  }
});

it('keeps source equirectangular HDR pixels and reports one source mip, not IBL roughness mips', () => {
  const data = new Uint8Array(8 * 4 * 8);
  const asset: EquirectAsset = {
    kind: 'equirect',
    width: 8,
    height: 4,
    format: 'rgba16float',
    data,
    colorSpace: 'linear',
  };
  const source = textureViewSource(asset);
  expect(source.data.buffer).toBe(data.buffer);
  expect(source.mips).toEqual({ kind: 'none' });
  const info = describeTextureView(asset);
  expect(info).toMatchObject({
    kind: 'equirect',
    mipCount: 1,
    options: { projection: 'environment' },
  });
  expect(validateTextureViewOptions(info, { projection: 'face', face: 5 }).face).toBe(5);
  expect(() => validateTextureViewOptions(info, { mip: 1 })).toThrow();
});

it('bounds volume slices at the selected mip and detaches accepted option arrays', () => {
  const volume: TextureAsset = {
    ...texture,
    shape: { viewDimension: '3d', extent: { width: 4, height: 4, depth: 4 } },
    data: new Uint8Array(288),
    mips: { kind: 'packed', levelCount: 2 },
  };
  const info = describeTextureView(volume);
  expect(() => validateTextureViewOptions(info, { mip: 1, layer: 2 })).toThrow();
  const channels = [true, false, false, false];
  const options = validateTextureViewOptions(info, { mip: 1, layer: 1, channels });
  channels[0] = false;
  expect(options.channels).toEqual([true, false, false, false]);
  expect(info.options.mip).toBe(0);
});

it('rejects non-color sample types before allocating a float texture binding', () => {
  for (const format of ['rgba8uint', 'rgba8sint', 'depth32float', 'stencil8'] as const) {
    expect(() => describeTextureView({ ...texture, format })).toThrow('float-sampled color format');
  }
});
