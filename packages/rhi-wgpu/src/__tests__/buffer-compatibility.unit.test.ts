import type { Texture } from '@forgeax/engine-rhi';
import { describe, expect, it, vi } from 'vitest';
import { makeRhiBuffer, type RawBufferLike } from '../buffer';
import { makeRhiCommandEncoder } from '../command-encoder';
import { makeRhiQueue } from '../queue';
import { rawCommandEncoder } from './raw-command-fixtures';

describe('wgpu buffer and sequence compatibility', () => {
  it.each([undefined, 0, 12])('expands shorthand size %s before native u64 conversion', (size) => {
    const rawSource = { size: 16 } as RawBufferLike;
    const rawDestination = { size: 32 } as RawBufferLike;
    const copy = vi.fn();
    const encoder = makeRhiCommandEncoder(rawCommandEncoder({ copyBufferToBuffer: copy }));
    encoder.copyBufferToBuffer(makeRhiBuffer(rawSource), makeRhiBuffer(rawDestination), size);
    expect(copy).toHaveBeenCalledWith(rawSource, 0n, rawDestination, 0n, BigInt(size ?? 16));
  });

  it('converts TypedArray element ranges after preserving the source view', () => {
    const write = vi.fn();
    const data = new Float32Array(new ArrayBuffer(32), 8, 4);
    const result = makeRhiQueue({ writeBuffer: write }).writeBuffer(
      makeRhiBuffer({}),
      4,
      data,
      1,
      2,
    );
    expect(result.ok).toBe(true);
    const args = write.mock.calls[0];
    expect(args?.[2]).toBeInstanceOf(Uint8Array);
    expect(args?.[2].byteOffset).toBe(8);
    expect(args?.slice(3)).toEqual([4n, 8n]);
  });

  it('rejects source overflow instead of letting the WASM provider truncate it', () => {
    const write = vi.fn();
    const result = makeRhiQueue({ writeBuffer: write }).writeBuffer(
      makeRhiBuffer({}),
      0,
      new Uint32Array(4),
      3,
      2,
    );
    expect(result.ok).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it.each([
    ['dictionary', () => ({ width: 4, height: 2 })],
    ['array', () => [4, 2]],
    ['typed array', () => new Uint32Array([4, 2])],
    ['iterator', () => [4, 2].values()],
    ['set', () => new Set([4, 2])],
  ] as const)('preserves %s texture extents', (_name, extent) => {
    const write = vi.fn();
    makeRhiQueue({ writeTexture: write })
      .writeTexture({ texture: {} as Texture }, new Uint8Array(32), {}, extent())
      .unwrap();
    expect(write.mock.calls[0]?.slice(-3)).toEqual([4, 2, 1]);
  });
});

it.each([
  () => [4, undefined].values(),
  () => [4, Number.NaN].values(),
  () => [4, -1].values(),
  () => [4, 0x1_0000_0000].values(),
])('rejects invalid sequence coordinates before the WASM boundary', (extent) => {
  const write = vi.fn();
  const result = makeRhiQueue({ writeTexture: write }).writeTexture(
    { texture: {} as Texture },
    new Uint8Array(32),
    {},
    extent() as Iterable<number>,
  );
  expect(result.ok).toBe(false);
  expect(write).not.toHaveBeenCalled();
});

it('preserves coordinate conversion, omitted dimensions and explicit zero', () => {
  const write = vi.fn();
  const queue = makeRhiQueue({ writeTexture: write });
  queue
    .writeTexture({ texture: {} as Texture }, new Uint8Array(32), {}, [4.9, 2.9].values())
    .unwrap();
  queue.writeTexture({ texture: {} as Texture }, new Uint8Array(0), {}, [4, 0].values()).unwrap();
  expect(write.mock.calls.map((call) => call.slice(-3))).toEqual([
    [4, 2, 1],
    [4, 0, 1],
  ]);
});
