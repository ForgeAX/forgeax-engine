import { expect, it } from 'vitest';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_UNIFORM } from '../../gpu-usage';
import { resolveFoldInstanceBuffer } from '../fold-instance-buffer';
import { type FoldBucket, INSTANCE_UBO_FULL_ARRAY_BYTES } from '../mesh-ssbo';
import type { _InternalRenderPipelineContext } from '../render-context';
import { uploadSpriteInstanceBuffer } from '../sprite-instance-buffer';

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
    frameState: { instanceBuffers: new Map() },
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
