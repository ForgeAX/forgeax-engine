import { vec3 } from '@forgeax/engine-math';
import type { BindGroup, RenderPipeline, RhiRenderPassEncoder } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { GpuBuffer } from '../gpu-resource';
import { disposeInstanceBuffers } from '../instance-buffer-cache';
import { MaterialResource } from '../material-resource';
import { resolveGeometryInstanceBuffer } from '../record/main-pass-geometry';
import { MaterialBgAssemblyCache } from '../record/material-bg-assembly-cache';
import { getOrCreateFromChain } from '../record/mesh-ssbo';
import type { _InternalRenderPipelineContext } from '../record/render-context';
import { recordShadowCasterDraws } from '../record/shadow-pass';
import { MaterialDispatch } from '../scene/material-dispatch';

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
  const identity = device.createBuffer({ size: 16384, usage: 0x88 }).unwrap();
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
  const material = new MaterialResource({
    materialHandle: 1,
    baseColor: vec3.create(1, 1, 1),
    metallic: 0,
    roughness: 1,
    passes: [
      {
        name: 'shadow',
        program: { module: 'forgeax::default-shadow-caster' },
        renderState: { tags: { LightMode: 'ShadowCaster' } },
      },
    ],
  });
  const entry = {
    renderableIndex: 0,
    meshSlot: 0,
    source: {
      worldId: 0,
      entityKey: 1,
      transform: { world: matrix(0) },
      instances,
      temporal: { previousInstances, previousTransform: { world: matrix(0) } },
      material,
      materials: [material],
    },
    mesh: {
      vertexBuffer: vertex,
      layoutProjection: { attributes: [] },
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
    runtime: {
      device,
      errorRegistry: { fire: vi.fn() },
      getMaterialShaderPipelineEntry: () => ({ pipeline, group2Contract: 'mesh' }),
      getParamSchema: () => [],
    },
    materialBgAssemblyCache: new MaterialBgAssemblyCache(),
    store: { materialResourceEpoch: 0 },
    world: { identity: 'shadow-instance-fixture' },
    materialFrame: new MaterialDispatch().materials().with(material),
    materialSlots: [material.snapshot],
    materialSlotIndices: [[0], [0]],
    pipelineState: {
      identityInstanceBuffer: identity,
      instancesBindGroupLayout: layout,
      skylightFallback: {
        sampler,
        intensityBuffer: identity,
        irradianceView: colorView,
        prefilterView: colorView,
        brdfLutView: colorView,
      },
      materialBindGroupLayout: materialLayout,
      materialUniformBuffer: { buffer: identity },
      meshStorageBuffer: { buffer: identity },
      defaultSampler: sampler,
      defaultNormalTextureView: normalView,
      defaultWhiteTextureView: colorView,
      fallbackTextureView: colorView,
    },
    frameState: {
      instanceBuffers: new Map(),
      materialBgShared: new Map(),
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
        recordShadowCasterDraws(c, pass, pipeline, materialGroup, undefined);
      }
      const forward = resolveGeometryInstanceBuffer(c, draw, [], false);
      expect(forward?.[0]?.instanceCount).toBe(1);
      const payload = writes.mock.calls
        .filter(([buffer]) => buffer === forward?.[0]?.instanceBuffer)
        .at(-1)?.[2] as Float32Array;
      expect(payload[12]).toBe(frame);
      if (storageBuffer) expect(payload[28]).toBe(frame - 1);
    }
    expect(creates).toHaveBeenCalledTimes(1);
    expect(groups.mock.calls.filter(([descriptor]) => descriptor.layout === layout)).toHaveLength(
      1,
    );
    expect(writes.mock.calls.filter(([buffer]) => buffer !== identity)).toHaveLength(60);
    expect(pass.draw).toHaveBeenCalledTimes(180);

    const firstBuffer = resolveGeometryInstanceBuffer(c, draw, [], false)?.[0]?.instanceBuffer;
    entries.push({
      ...entry,
      source: {
        ...entry.source,
        worldId: 1,
        instances: { ...instances, transforms: matrix(1_000) },
        temporal: {
          previousTransform: { world: matrix(0) },
          previousInstances: { ...previousInstances, transforms: matrix(999) },
        },
      },
    });
    recordShadowCasterDraws(c, pass, pipeline, materialGroup, undefined);
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
    expect(groups.mock.calls.filter(([descriptor]) => descriptor.layout === layout)).toHaveLength(
      2,
    );
    expect(writes.mock.calls.filter(([buffer]) => buffer !== identity)).toHaveLength(61);
    const secondPayload = writes.mock.calls
      .filter(([buffer]) => buffer === secondBuffer)
      .at(-1)?.[2] as Float32Array;
    expect(secondPayload[12]).toBe(1_000);
    if (storageBuffer) expect(secondPayload[28]).toBe(999);
    expect(c.runtime.errorRegistry.fire).not.toHaveBeenCalled();
  } finally {
    disposeInstanceBuffers(c.frameState.instanceBuffers);
    vertex.destroy().unwrap();
    device.destroyBuffer(identity).unwrap();
  }
});
