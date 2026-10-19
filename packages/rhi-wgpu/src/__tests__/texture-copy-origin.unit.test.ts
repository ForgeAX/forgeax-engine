import type { Texture } from '@forgeax/engine-rhi';
import { describe, expect, it, vi } from 'vitest';
import { makeRhiBuffer } from '../buffer';
import { makeRhiCommandEncoder } from '../command-encoder';
import { makeRhiQueue } from '../queue';
import { rawCommandEncoder } from './raw-command-fixtures';

const origins: readonly [string, () => GPUOrigin3D | undefined, readonly number[]][] = [
  ['omitted', () => undefined, [0, 0, 0]],
  ['dictionary', () => ({ x: 2, y: 3, z: 1 }), [2, 3, 1]],
  ['partial dictionary', () => ({ y: 3 }), [0, 3, 0]],
  ['array', () => [2, 3, 1], [2, 3, 1]],
  ['short array', () => [2], [2, 0, 0]],
  // WebIDL accepts iterables beyond the number[] spelling in @webgpu/types.
  ['typed array', () => new Uint32Array([2, 3, 1]) as unknown as GPUOrigin3D, [2, 3, 1]],
  ['iterator', () => [2, 3, 1].values() as unknown as GPUOrigin3D, [2, 3, 1]],
];

describe.each(origins)('texture origin: %s', (_name, origin, expected) => {
  const texture = {} as Texture;
  const buffer = makeRhiBuffer({});
  const copy = () => {
    const value = origin();
    return { texture, ...(value === undefined ? {} : { origin: value }) };
  };

  it('preserves coordinates on queue writes', () => {
    const writeTexture = vi.fn();
    makeRhiQueue({ writeTexture }).writeTexture(copy(), new Uint8Array(4), {}, [1, 1, 1]).unwrap();
    expect(writeTexture.mock.calls[0]?.slice(2, 5)).toEqual(expected);
  });

  it('preserves coordinates in every command copy direction', () => {
    const copyBufferToTexture = vi.fn();
    const copyTextureToBuffer = vi.fn();
    const copyTextureToTexture = vi.fn();
    const encoder = makeRhiCommandEncoder(
      rawCommandEncoder({
        copyBufferToTexture,
        copyTextureToBuffer,
        copyTextureToTexture,
      }),
    );
    encoder.copyBufferToTexture({ buffer }, copy(), [1, 1, 1]);
    encoder.copyTextureToBuffer(copy(), { buffer }, [1, 1, 1]);
    encoder.copyTextureToTexture(copy(), copy(), [1, 1, 1]);
    expect(copyBufferToTexture.mock.calls[0]?.slice(6, 9)).toEqual(expected);
    expect(copyTextureToBuffer.mock.calls[0]?.slice(2, 5)).toEqual(expected);
    expect(copyTextureToTexture.mock.calls[0]?.slice(2, 5)).toEqual(expected);
    expect(copyTextureToTexture.mock.calls[0]?.slice(8, 11)).toEqual(expected);
  });
});
