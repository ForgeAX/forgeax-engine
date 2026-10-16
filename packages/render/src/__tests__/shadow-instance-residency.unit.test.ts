import type { BindGroup, RenderPipeline, RhiRenderPassEncoder } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { GpuBuffer } from '../gpu-resource';
import { disposeInstanceBuffers } from '../instance-buffer-cache';
import { resolveGeometryInstanceBuffer } from '../record/main-pass-geometry';
import { getOrCreateFromChain } from '../record/mesh-ssbo';
import type { _InternalRenderPipelineContext } from '../record/render-context';
import { recordShadowCasterDraws } from '../record/shadow-pass';

const matrix = (x: number) => Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1);

it.each([
  true,
  false,
])('shares shadow and Forward uploads while isolating Worlds (storage=%s)', async (storageBuffer) => {
  const backing = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const device = new Proxy(backing, {
    get(target, property, receiver) {
      if (property === 'caps') return { ...target.caps, storageBuffer };
      return Reflect.get(target, property, receiver);
    },
  });
  const identity = device.createBuffer({ size: 128, usage: 0x88 }).unwrap();
  const vertex = new GpuBuffer(device, device.createBuffer({ size: 36, usage: 0x20 }).unwrap());
  const layout = device
    .createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: 1,
          buffer: { type: storageBuffer ? 'read-only-storage' : 'uniform' },
        },
      ],
    })
    .unwrap();
  const materialGroup = {} as BindGroup;
  const pipeline = {} as RenderPipeline;
  const counts = { createBindGroup: 0, keys: [] };
  const shadowMaterialBindGroups = new WeakMap<object, unknown>();
  const materialLayout = {};
  const sampler = {};
  const normalView = {};
  const colorView = {};
  getOrCreateFromChain(
    shadowMaterialBindGroups,
    [materialLayout, identity, sampler, normalView, colorView, identity],
    'shadow-material-singleton',
    () => materialGroup,
    counts,
  );
  const instances = {
    transforms: matrix(0),
    instanceCount: 1,
    cacheKey: 1,
    archVersion: 0,
    revision: 0,
    generations: Uint32Array.of(7),
  };
  const previousInstances = { transforms: matrix(0), generations: Uint32Array.of(7) };
  const entry = {
    renderableIndex: 0,
    source: {
      worldId: 0,
      entityKey: 1,
      instances,
      temporal: { previousInstances },
      material: { materialHandle: 1 },
      materials: [{ materialHandle: 1 }],
    },
    mesh: {
      vertexBuffer: vertex,
      indexed: false,
      indexBuffer: null,
      submeshes: [
        {
          topology: 'triangle-list',
          materialSlot: 0,
          vertexCount: 3,
          indexCount: 0,
          indexOffset: 0,
        },
      ],
    },
  };
  const entries = [entry];
  const c = {
    runtime: { device, errorRegistry: { fire: vi.fn() } },
    pipelineState: {
      identityInstanceBuffer: identity,
      instancesBindGroupLayout: layout,
      skylightFallback: null,
      materialBindGroupLayout: materialLayout,
      materialUniformBuffer: { buffer: identity },
      meshStorageBuffer: { buffer: identity },
      defaultSampler: sampler,
      defaultNormalTextureView: normalView,
      fallbackTextureView: colorView,
    },
    frameState: {
      instanceBuffers: new Map(),
      instancesBgShared: new WeakMap(),
      shadowMaterialBindGroups,
    },
    validatedOrdered: entries,
    bindGroupCounts: counts,
  } as unknown as _InternalRenderPipelineContext;
  const pass = {
    setVertexBuffer: vi.fn(),
    setBindGroup: vi.fn(),
    draw: vi.fn(),
  } as unknown as RhiRenderPassEncoder;
  const creates = vi.spyOn(device, 'createBuffer');
  const groups = vi.spyOn(device, 'createBindGroup');
  const writes = vi.spyOn(device.queue, 'writeBuffer');
  const draw = c.validatedOrdered[0];
  if (draw === undefined) throw new Error('missing draw');
  try {
    for (let frame = 1; frame <= 60; frame++) {
      instances.revision = frame;
      instances.transforms = matrix(frame);
      previousInstances.transforms = matrix(frame - 1);
      for (let cascade = 0; cascade < 3; cascade++) {
        recordShadowCasterDraws(c, pass, pipeline, materialGroup, null, null, new Map(), undefined);
      }
      const forward = resolveGeometryInstanceBuffer(c, draw, [], false);
      expect(forward?.[0]?.instanceCount).toBe(1);
      const payload = writes.mock.calls.at(-1)?.[2] as Float32Array;
      expect(payload[12]).toBe(frame);
      if (storageBuffer) expect(payload[28]).toBe(frame - 1);
    }
    expect(creates).toHaveBeenCalledTimes(1);
    expect(groups).toHaveBeenCalledTimes(1);
    expect(writes).toHaveBeenCalledTimes(60);
    expect(pass.draw).toHaveBeenCalledTimes(180);

    const firstBuffer = resolveGeometryInstanceBuffer(c, draw, [], false)?.[0]?.instanceBuffer;
    entries.push({
      ...entry,
      source: {
        ...entry.source,
        worldId: 1,
        instances: { ...instances, transforms: matrix(1_000) },
        temporal: {
          previousInstances: { ...previousInstances, transforms: matrix(999) },
        },
      },
    });
    recordShadowCasterDraws(c, pass, pipeline, materialGroup, null, null, new Map(), undefined);
    const other = c.validatedOrdered[1];
    if (other === undefined) throw new Error('missing second World draw');
    const secondBuffer = resolveGeometryInstanceBuffer(c, other, [], false)?.[0]?.instanceBuffer;
    expect(firstBuffer).toBeDefined();
    expect(secondBuffer).toBeDefined();
    expect(secondBuffer).not.toBe(firstBuffer);
    expect(resolveGeometryInstanceBuffer(c, draw, [], false)?.[0]?.instanceBuffer).toBe(
      firstBuffer,
    );
    expect(creates).toHaveBeenCalledTimes(2);
    expect(groups).toHaveBeenCalledTimes(2);
    expect(writes).toHaveBeenCalledTimes(61);
    const secondPayload = writes.mock.calls.at(-1)?.[2] as Float32Array;
    expect(secondPayload[12]).toBe(1_000);
    if (storageBuffer) expect(secondPayload[28]).toBe(999);
    expect(c.runtime.errorRegistry.fire).not.toHaveBeenCalled();
  } finally {
    disposeInstanceBuffers(c.frameState.instanceBuffers);
    vertex.destroy().unwrap();
    device.destroyBuffer(identity).unwrap();
  }
});
