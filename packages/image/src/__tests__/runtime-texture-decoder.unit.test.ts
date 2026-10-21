import type { AssetDecoderInput, TextureAsset, TextureShape } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { textureContribution } from '../runtime/asset-decoders';

it.each<TextureShape>([
  { viewDimension: '2d-array', extent: { width: 2, height: 2, layers: 3 } },
  { viewDimension: '3d', extent: { width: 2, height: 2, depth: 3 } },
])('decodes complete $viewDimension images and rejects truncated storage', async (shape) => {
  const pixels = new Uint8Array(2 * 2 * 3 * 4);
  pixels.set([16, 32, 48, 255], pixels.length - 4);
  const payload: TextureAsset = {
    kind: 'texture',
    shape,
    format: 'rgba8unorm',
    colorSpace: 'linear',
    mips: { kind: 'none' },
    data: pixels,
  };
  const input: AssetDecoderInput<TextureAsset> = {
    envelope: {
      guid: '11111111-1111-4111-8111-111111111111',
      kind: 'texture',
      payload,
      refs: [],
      artifacts: {},
    },
    artifacts: {
      read: async () => {
        throw new Error('inline pixels do not need artifact I/O');
      },
    },
    signal: new AbortController().signal,
  };
  const accepted = (await textureContribution.decoder.decode(input)).unwrap();
  expect(accepted.shape).toEqual(shape);
  expect(accepted.data).toEqual(pixels);
  expect(
    await textureContribution.decoder.decode({
      ...input,
      envelope: { ...input.envelope, payload: { ...payload, data: pixels.slice(0, -1) } },
    }),
  ).toMatchObject({ ok: false, error: { code: 'asset-package-invalid' } });
  for (const patch of [
    { shape: null },
    { shape: {} },
    { shape: { viewDimension: '3d', extent: { width: 2, height: 2 } } },
    { shape: { viewDimension: 'unknown', extent: { width: 2, height: 2 } } },
    { mips: null },
    { mips: { kind: 'unknown' } },
  ]) {
    expect(
      await textureContribution.decoder.decode({
        ...input,
        envelope: { ...input.envelope, payload: { ...payload, ...patch } as TextureAsset },
      }),
    ).toMatchObject({ ok: false, error: { code: 'asset-package-invalid' } });
  }
});
