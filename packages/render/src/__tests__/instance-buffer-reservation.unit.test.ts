import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { GPU_SHADER_STAGE_VERTEX } from '../gpu-stage';
import { GPU_BUFFER_USAGE_STORAGE } from '../gpu-usage';
import { resolveGeometryInstanceBuffer } from '../record/main-pass-geometry';
import { INSTANCE_STORAGE_STRIDE_FLOATS } from '../record/mesh-ssbo';

const STRIDE = INSTANCE_STORAGE_STRIDE_FLOATS * Float32Array.BYTES_PER_ELEMENT;

function transformsFor(count: number): Float32Array {
  const transforms = new Float32Array(count * 16);
  for (let row = 0; row < count; row += 1) {
    transforms[row * 16] = 1;
    transforms[row * 16 + 5] = 1;
    transforms[row * 16 + 10] = 1;
    transforms[row * 16 + 12] = row;
    transforms[row * 16 + 15] = 1;
  }
  return transforms;
}

it('keeps a direct instance buffer and bind group while a dynamic count fits its reservation', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const identity = device.createBuffer({ size: 128, usage: GPU_BUFFER_USAGE_STORAGE }).unwrap();
  const layout = device
    .createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPU_SHADER_STAGE_VERTEX,
          buffer: { type: 'read-only-storage' },
        },
      ],
    })
    .unwrap();
  const createBuffer = vi.spyOn(device, 'createBuffer');
  const createBindGroup = vi.spyOn(device, 'createBindGroup');
  const writeBuffer = vi.spyOn(device.queue, 'writeBuffer');
  const instanceBuffers = new Map();
  const context = {
    runtime: { device, errorRegistry: { fire: vi.fn() } },
    pipelineState: {
      identityInstanceBuffer: identity,
      instancesBindGroupLayout: layout,
    },
    frameState: { instanceBuffers, instancesBgShared: new WeakMap() },
    bindGroupCounts: { createBindGroup: 0, keys: [] },
  } as unknown as Parameters<typeof resolveGeometryInstanceBuffer>[0];
  let revision = 0;
  const draw = (count: number) => {
    revision += 1;
    writeBuffer.mockClear();
    const draws = resolveGeometryInstanceBuffer(
      context,
      {
        source: {
          worldId: 0,
          entityKey: 1,
          instances: {
            transforms: transformsFor(count),
            instanceCount: count,
            cacheKey: 1,
            archVersion: 0,
            revision,
          },
        },
      } as Parameters<typeof resolveGeometryInstanceBuffer>[1],
      [],
      false,
    );
    const first = draws?.[0];
    if (first === undefined) throw new Error('expected one instance draw');
    const uploaded = writeBuffer.mock.calls.reduce(
      (sum, call) =>
        sum + ((call[4] as number | undefined) ?? (call[2] as ArrayBufferView).byteLength),
      0,
    );
    return {
      buffer: first.instanceBuffer,
      group: first.instanceBindGroup,
      count: first.instanceCount,
      uploaded,
    };
  };
  try {
    const initial = draw(64);
    expect(createBuffer).toHaveBeenCalledTimes(1);
    // Shrinking fits the exact buffer; the first growth reserves headroom; later changes inside it reuse
    // the buffer and its bind group and upload the whole new payload.
    expect(draw(60).buffer).toBe(initial.buffer);
    const reserved = draw(80);
    expect(reserved.buffer).not.toBe(initial.buffer);
    expect(createBuffer).toHaveBeenCalledTimes(2);
    expect(createBuffer.mock.calls[1]?.[0].size).toBe((80 + 40) * STRIDE);
    for (const count of [40, 120, 31, 100]) {
      const next = draw(count);
      expect(next.buffer).toBe(reserved.buffer);
      expect(next.group).toBe(reserved.group);
      expect(next.count).toBe(count);
      expect(next.uploaded).toBe(count * STRIDE);
    }
    expect(createBuffer).toHaveBeenCalledTimes(2);
    expect(createBindGroup).toHaveBeenCalledTimes(2);
    // Outgrowing the reservation allocates a new, larger one.
    const grown = draw(121);
    expect(grown.buffer).not.toBe(reserved.buffer);
    expect(createBuffer).toHaveBeenCalledTimes(3);
  } finally {
    createBuffer.mockRestore();
    createBindGroup.mockRestore();
    writeBuffer.mockRestore();
  }
});
