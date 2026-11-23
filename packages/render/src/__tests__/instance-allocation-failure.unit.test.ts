import { err, RhiError } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { GPU_SHADER_STAGE_VERTEX } from '../gpu-stage';
import { GPU_BUFFER_USAGE_STORAGE } from '../gpu-usage';
import { PassGeometryInstances, resolveGeometryInstanceBuffer } from '../record/main-pass-geometry';

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

it('retains the prepared identity draw when a rigid row has no probe binding', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const buffer = device.createBuffer({ size: 128, usage: GPU_BUFFER_USAGE_STORAGE }).unwrap();
  const layout = device
    .createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPU_SHADER_STAGE_VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    })
    .unwrap();
  const group = device
    .createBindGroup({
      layout,
      entries: [{ binding: 0, resource: { kind: 'buffer', value: { buffer } } }],
    })
    .unwrap();
  const identity = [
    { instanceBuffer: buffer, instanceBindGroup: group, probeOffset: -1, instanceCount: 1 },
  ];
  const context = {
    runtime: { device },
    pipelineState: { identityInstanceBuffer: buffer, instancesBindGroupLayout: layout },
    frameState: { instanceBuffers: new Map() },
    bindGroupCounts: { createBindGroup: 0, keys: [] },
  } as unknown as Parameters<typeof resolveGeometryInstanceBuffer>[0];
  const row = { source: { entityKey: 1 } } as Parameters<typeof resolveGeometryInstanceBuffer>[1];
  try {
    expect(resolveGeometryInstanceBuffer(context, row, identity, false)).toBe(identity);
  } finally {
    device.destroyBuffer(buffer).unwrap();
  }
});

it('binds the live sentinel once per pass across changing rigid entities and buffer replacement', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const instance = device.createBuffer({ size: 128, usage: GPU_BUFFER_USAGE_STORAGE }).unwrap();
  const instanceEntry = {
    binding: 0,
    visibility: GPU_SHADER_STAGE_VERTEX,
    buffer: { type: 'read-only-storage' as const },
  };
  const plain = device.createBindGroupLayout({ entries: [instanceEntry] }).unwrap();
  const withProbe = device
    .createBindGroupLayout({
      entries: [
        instanceEntry,
        {
          ...instanceEntry,
          binding: 1,
          buffer: { type: 'read-only-storage', hasDynamicOffset: true },
        },
      ],
    })
    .unwrap();
  const state: Parameters<
    typeof import('../record/probe-blend-buffer').ensureProbeBlendRecordBuffer
  >[1] = {
    probeBlendRecordBufferCapacity: 0,
    probeBlendBuffers: new Map(),
  };
  const groups = vi.spyOn(device, 'createBindGroup');
  const pass = new PassGeometryInstances({
    runtime: { device },
    frameState: state,
    pipelineState: {
      identityInstanceBuffer: instance,
      instancesBindGroupLayout: plain,
      probeInstancesBindGroupLayout: withProbe,
    },
    bindGroupCounts: { createBindGroup: 0, keys: [] },
  } as unknown as ConstructorParameters<typeof PassGeometryInstances>[0]);
  const entry = (entityKey: number) =>
    ({ source: { entityKey } }) as Parameters<typeof pass.resolve>[0];
  try {
    const first = pass.resolve(entry(1), true);
    expect(first?.[0]?.probeOffset).toBe(0);
    for (let i = 0; i < 256; i++) {
      expect(pass.resolve(entry(i), true)).toBe(first);
      expect(pass.resolve(entry(i), false)).toBe(pass.identity());
    }
    expect(groups).toHaveBeenCalledTimes(2);
    state.probeBlendRecordBuffer?.destroy().unwrap();
    const replacement = pass.resolve(entry(257), true);
    expect(replacement?.[0]?.probeBuffer).not.toBe(first?.[0]?.probeBuffer);
    expect(replacement?.[0]?.probeOffset).toBe(0);
    expect(groups).toHaveBeenCalledTimes(3);
  } finally {
    groups.mockRestore();
    state.probeBlendRecordBuffer?.destroy().unwrap();
    device.destroyBuffer(instance).unwrap();
  }
});
