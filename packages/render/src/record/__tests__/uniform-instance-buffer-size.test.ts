import { expect, it, vi } from 'vitest';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_UNIFORM } from '../../gpu-usage';
import { resolveFoldInstanceBuffer } from '../fold-instance-buffer';
import { type FoldBucket, INSTANCE_UBO_FULL_ARRAY_BYTES } from '../mesh-ssbo';
import type { _InternalRenderPipelineContext } from '../render-context';
import { resolveSpriteInstanceDraws, uploadSpriteInstanceBuffer } from '../sprite-instance-buffer';

// bug-20261011-webgl2-sprite-uniform-instance-range: the uniform fallback shader
// binds `array<InstanceData, 128>`, so a buffer sized to a two-sprite payload
// failed WebGL2 submit with BindingSizeTooSmall. WebGL2 also reports a zero
// storage binding limit, which must not gate the uniform payload.
function uniformContext() {
  const sizes: number[] = [];
  const fired: { code: string }[] = [];
  const device = {
    caps: { storageBuffer: false },
    limits: { maxStorageBufferBindingSize: 0 },
    createBuffer: (desc: { size: number }) => {
      sizes.push(desc.size);
      return { ok: true, value: { size: desc.size } };
    },
    destroyBuffer: () => ({ ok: true, value: undefined }),
    queue: { writeBuffer: () => ({ ok: true, value: undefined }) },
  };
  const c = {
    runtime: {
      device,
      errorRegistry: {
        fire: (e: { code: string }) => {
          fired.push(e);
        },
      },
    },
    frameState: {
      instanceBuffers: new Map(),
      instanceBufferChunks: new Map(),
      transientInstanceBuffers: [],
    },
  } as unknown as _InternalRenderPipelineContext;
  return { c, sizes, fired };
}

it('sizes fold uniform instance buffers to the full shader array', () => {
  const { c, sizes, fired } = uniformContext();
  const bucket = {
    entries: [],
    bucketSize: 2,
    transforms: new Float32Array(32),
    materialHandle: 1,
    layer: 0,
    sortKey: 0,
  } satisfies FoldBucket;
  expect(resolveFoldInstanceBuffer(c, bucket, 0)).not.toBeNull();
  expect(resolveFoldInstanceBuffer(c, bucket, 0)).not.toBeNull();
  expect(fired).toEqual([]);
  expect(sizes).toEqual([INSTANCE_UBO_FULL_ARRAY_BYTES]);
});

it('sizes sprite uniform instance buffers to the full shader array', () => {
  const { c, sizes, fired } = uniformContext();
  const buffer = uploadSpriteInstanceBuffer(
    c,
    0,
    { archVersion: 1, cacheKey: 7 },
    new Float32Array(40),
    GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
    'hint',
  );
  expect(fired).toEqual([]);
  expect(buffer).not.toBeNull();
  expect(sizes).toEqual([INSTANCE_UBO_FULL_ARRAY_BYTES]);
});

it('caps sprite uniform payloads at the shader array instead of storage limits', () => {
  const { c, sizes, fired } = uniformContext();
  const buffer = uploadSpriteInstanceBuffer(
    c,
    0,
    { archVersion: 1, cacheKey: 7 },
    new Float32Array(INSTANCE_UBO_FULL_ARRAY_BYTES / 4 + 20),
    GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
    'hint',
  );
  expect(buffer).toBeNull();
  expect(fired.map((e) => e.code)).toEqual(['limit-exceeded']);
  expect(sizes).toEqual([]);
});

it.each([
  undefined,
  0,
])('isolates equal Sprite collection keys across Worlds at page %s', (page) => {
  const { c, sizes, fired } = uniformContext();
  const snapshot = { archVersion: 1, cacheKey: 7 };
  const upload = (world: number, version = 1) =>
    uploadSpriteInstanceBuffer(
      c,
      world,
      { ...snapshot, archVersion: version },
      new Float32Array(40),
      GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
      'hint',
      page,
    );
  const first = upload(0);
  const other = upload(1);
  expect(first).not.toBeNull();
  expect(other).not.toBeNull();
  expect(other).not.toBe(first);
  expect(upload(0)).toBe(first);
  expect(upload(1)).toBe(other);
  expect(sizes).toHaveLength(2);
  expect(upload(0, 2)).not.toBe(first);
  expect(upload(1)).toBe(other);
  expect(sizes).toHaveLength(3);
  expect(fired).toEqual([]);
});

it.each([
  129, 257, 10000,
])('pages %i Sprite/Tilemap atlas instances through the upload owner', (count) => {
  const { c, sizes, fired } = uniformContext();
  const writes: Float32Array[] = [];
  const write = vi
    .spyOn(c.runtime.device.queue, 'writeBuffer')
    .mockImplementation((_buffer, _offset, bytes) => {
      writes.push(new Float32Array((bytes as Float32Array).slice()));
      return { ok: true, value: undefined } as never;
    });
  const transforms = new Float32Array(count * 16);
  const regions = new Float32Array(count * 4);
  for (let index = 0; index < count; index++) {
    transforms[index * 16 + 12] = index;
    regions[index * 4] = index / count;
  }
  const snapshot = { transforms, regions, instanceCount: count, cacheKey: 7, archVersion: 1 };
  const entry = {
    source: { worldId: 0, spriteInstances: snapshot },
  } as _InternalRenderPipelineContext['validatedOrdered'][number];
  try {
    const draws = resolveSpriteInstanceDraws(c, entry);
    expect(draws.map((draw) => draw.count)).toEqual(
      Array.from({ length: Math.ceil(count / 128) }, (_, page) =>
        Math.min(128, count - page * 128),
      ),
    );
    expect(new Set(draws.map((draw) => draw.buffer)).size).toBe(draws.length);
    expect(sizes.every((size) => size === INSTANCE_UBO_FULL_ARRAY_BYTES)).toBe(true);
    for (const [page, payload] of writes.entries()) {
      for (let local = 0; local < payload.length / 20; local++) {
        const ordinal = page * 128 + local;
        expect(payload[local * 20 + 12]).toBe(ordinal);
        expect(payload[local * 20 + 16]).toBe(regions[ordinal * 4]);
      }
    }
    writes.length = 0;
    transforms[128 * 16 + 12] = -42;
    const repeated = resolveSpriteInstanceDraws(c, entry);
    expect(repeated.map((draw) => draw.buffer)).toEqual(draws.map((draw) => draw.buffer));
    expect(writes[1]?.[12]).toBe(-42);
    Object.assign(snapshot, { instanceCount: 0 });
    expect(resolveSpriteInstanceDraws(c, entry)).toEqual([]);
    expect(
      [...(c.frameState.instanceBufferChunks?.values() ?? [])].every((pages) => pages.size === 0),
    ).toBe(true);
    expect(fired).toEqual([]);
  } finally {
    write.mockRestore();
  }
});
