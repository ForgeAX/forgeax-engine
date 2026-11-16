import { err, ok, RhiError } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { PROBE_BLEND_RECORD_BYTE_SIZE } from '../../scene/probe-blend-record';
import { CPU_SETUP_SHADER, cpuSetupFixture } from './main-pass-cpu-setup-fixture';

it.each([
  ['forward', 1, 'single-layer-medium', 'ready'],
  ['forward', 3, 'single-layer-medium', 'ready'],
  ['temporal', 1, 'single-layer-medium', 'ready'],
  ['temporal', 3, 'single-layer-medium', 'ready'],
  ['temporal', 1, 'standard', 'ready'],
  ['deferred', 1, 'single-layer-medium', 'ready'],
  ['temporal', 1, 'single-layer-medium', 'rejected'],
  ['temporal', 1, 'single-layer-medium', 'absent'],
] as const)('preserves %s binding authority for %s instances of %s with a %s producer', async (kind, count, surfaceModel, producer) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const module = (await rhi.createShaderModule(device, { code: CPU_SETUP_SHADER })).unwrap();
  const f = cpuSetupFixture(device, module);
  const entry = f.add({ entity: 7, submeshes: 1, instances: count });
  entry.source.material.adopt({
    ...entry.source.material.snapshot,
    materialShaderId: 'forgeax::default-standard-pbr',
    surfaceModel,
  });
  Object.assign(entry.source, {
    probeBlendRecord: {
      objectKey: 7,
      generation: 1,
      localBlendFraction: 0,
      shPreblend: [],
      bytes: new Uint8Array(PROBE_BLEND_RECORD_BYTE_SIZE),
      byteLength: PROBE_BLEND_RECORD_BYTE_SIZE,
      candidate: false,
      accepted: true,
      lastKnownGood: false,
    },
  });
  const probeLayout = device
    .createBindGroupLayout({
      label: 'pbr-probe-instances-bgl',
      entries: [
        { binding: 0, visibility: 1, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: 3, buffer: { type: 'uniform', hasDynamicOffset: true } },
      ],
    })
    .unwrap();
  const directLayout = device
    .createBindGroupLayout({
      label: 'pbr-surface-direct-instances-bgl',
      entries: [{ binding: 6, visibility: 1, buffer: { type: 'uniform' } }],
    })
    .unwrap();
  const address = device.createBuffer({ size: 16, usage: 64 | 8 }).unwrap();
  const direct = device
    .createBindGroup({
      layout: directLayout,
      entries: [{ binding: 6, resource: { kind: 'buffer', value: { buffer: address } } }],
    })
    .unwrap();
  Object.assign(f.c.pipelineState, { probeInstancesBindGroupLayout: probeLayout });
  Object.assign(f.c.frameState, {
    probeBlendBuffers: new Map(),
    probeBlendRecordBufferCapacity: 0,
  });
  const rejected = new RhiError({
    code: 'rhi-not-available',
    expected: 'the accepted direct Surface draw identity is prepared',
    hint: 'prepare the exact retained Surface source before recording',
  });
  const resolve = vi.fn(() =>
    producer === 'rejected'
      ? err(rejected)
      : ok({
          bindGroup: direct,
          dynamicOffsets: [2048, 256],
          frameBase: 13,
          memberIds: ['medium'],
        }),
  );
  Object.assign(f.c, {
    gpuDrivenStandardPbrFrameResources:
      producer === 'absent' ? {} : { surfaceDirectInstances: resolve },
  });
  const lookup = vi.spyOn(f.c.runtime, 'getMaterialShaderPipelineEntry');
  const pass = device.createCommandEncoder().unwrap().beginRenderPass({ colorAttachments: [] });
  const groups = vi.spyOn(pass, 'setBindGroup');
  try {
    f.record(pass, kind);
    const directExpected = surfaceModel === 'single-layer-medium' && kind !== 'deferred';
    expect(lookup.mock.calls[0]?.[15]).toBe(directExpected ? 'surface-direct-pbr' : undefined);
    const expectedInput = {
      entityKey: 7,
      drawItemIndex: 0,
      instanceCount: count,
      firstInstanceOrdinal: 0,
      instanceBuffer: expect.anything(),
      probeBuffer: expect.anything(),
      probeOffset: 2048,
    };
    if (directExpected && producer !== 'absent')
      expect(resolve).toHaveBeenCalledExactlyOnceWith(expectedInput);
    else expect(resolve).not.toHaveBeenCalled();
    const instanceGroups = groups.mock.calls.filter(([slot]) => slot === 3);
    if (directExpected && producer === 'ready') {
      expect(instanceGroups).toEqual([[3, direct, [2048, 256]]]);
    } else if (directExpected) {
      expect(instanceGroups).toEqual([]);
      expect(f.receipts).toEqual([]);
      expect(f.errors).toHaveLength(1);
      if (producer === 'rejected') expect(f.errors[0]).toBe(rejected);
      return;
    } else {
      expect(instanceGroups).toEqual([[3, expect.anything(), [2048]]]);
      expect(instanceGroups[0]?.[1]).not.toBe(direct);
    }
    expect(f.receipts).toEqual([{ entity: 7, submesh: 0 }]);
    expect(f.errors).toEqual([]);
  } finally {
    pass.end();
    f.dispose();
    f.c.frameState.probeBlendRecordBuffer?.destroy();
    device.destroyBuffer(address).unwrap();
  }
});
