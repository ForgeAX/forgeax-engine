import { err, RhiError } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { GPU_SHADER_STAGE_VERTEX } from '../gpu-stage';
import { GPU_BUFFER_USAGE_STORAGE } from '../gpu-usage';
import { resolveGeometryInstanceBuffer } from '../record/main-pass-geometry';

it('refuses an instance draw when allocation fails instead of drawing the identity fallback', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const identity = device.createBuffer({ size: 128, usage: GPU_BUFFER_USAGE_STORAGE }).unwrap();
  const layout = device
    .createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPU_SHADER_STAGE_VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    })
    .unwrap();
  const failure = new RhiError({
    code: 'rhi-not-available',
    expected: 'an instance buffer allocation',
    hint: 'recover the renderer',
  });
  const allocation = vi.spyOn(device, 'createBuffer').mockReturnValue(err(failure));
  const bindGroup = vi.spyOn(device, 'createBindGroup');
  const fire = vi.fn();
  try {
    const result = resolveGeometryInstanceBuffer(
      {
        runtime: { device, errorRegistry: { fire } },
        pipelineState: { identityInstanceBuffer: identity, instancesBindGroupLayout: layout },
        frameState: { instanceBuffers: new Map() },
        bindGroupCounts: { createBindGroup: 0, keys: [] },
      } as unknown as Parameters<typeof resolveGeometryInstanceBuffer>[0],
      {
        source: {
          worldId: 0,
          entityKey: 1,
          instances: {
            transforms: new Float32Array(32),
            instanceCount: 2,
            cacheKey: 1,
            archVersion: 0,
          },
        },
      } as Parameters<typeof resolveGeometryInstanceBuffer>[1],
      [],
      false,
    );
    expect(result).toBeNull();
    expect(fire).toHaveBeenCalledWith(failure);
    expect(bindGroup).not.toHaveBeenCalled();
  } finally {
    allocation.mockRestore();
    bindGroup.mockRestore();
    device.destroyBuffer(identity).unwrap();
  }
});
