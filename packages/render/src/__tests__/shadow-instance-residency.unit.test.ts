import { vec3 } from '@forgeax/engine-math';
import type { BindGroup, RenderPipeline, RhiRenderPassEncoder } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { waterBodyOwnerKey } from '@forgeax/engine-water';
import { expect, it, vi } from 'vitest';
import { GpuBuffer } from '../gpu-resource';
import { disposeInstanceBuffers } from '../instance-buffer-cache';
import { MaterialResource } from '../material-resource';
import { waterMaterialRecordContext } from '../record/main-pass';
import { resolveGeometryInstanceBuffer } from '../record/main-pass-geometry';
import { MaterialBgAssemblyCache } from '../record/material-bg-assembly-cache';
import { getOrCreateFromChain } from '../record/mesh-ssbo';
import type { _InternalRenderPipelineContext } from '../record/render-context';
import { createShadowPipelineSelectionOwner, recordShadowCasterDraws } from '../record/shadow-pass';
import { MaterialDispatch } from '../scene/material-dispatch';

const matrix = (x: number) => Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1);

it.each([
  true,
  false,
])('shares shadow and Forward uploads while isolating distinct entities (storage=%s)', async (storageBuffer) => {
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
  const pipelineLookup = vi.fn(
    (
      ..._args: Parameters<
        NonNullable<_InternalRenderPipelineContext['runtime']['getMaterialShaderPipelineEntry']>
      >
    ) => ({ pipeline, group2Contract: 'mesh' as const }),
  );
  const counts = { createBindGroup: 0, keys: [] };
  const shadowMaterialBindGroups = new WeakMap<object, unknown>();
  const materialLayout = {};
  const sampler = {};
  const normalView = {};
  const colorView = {};
  const world = { identity: 'shadow-instance-fixture' };
  const bodyKey = waterBodyOwnerKey(world.identity, 'shadow-water-body', 1, 1);
  const waterTarget = 'shadow-water-info';
  const waterBindings = (frameGeneration: number) => ({
    waterInfoTargetName: waterTarget,
    bodyTargetNames: new Map([[bodyKey, waterTarget]]),
    bodyTargetFormats: new Map([[bodyKey, 'rgba16float']]),
    bodyIndices: new Map([[bodyKey, 0]]),
    bodyGenerations: new Map([[bodyKey, 1]]),
    bodyZoneGenerations: new Map([[bodyKey, 1]]),
    bodyIndexDynamicOffsets: new Map([[bodyKey, 0]]),
    waterInfoDescriptorDynamicOffsets: new Map([[bodyKey, 0]]),
    waterMeshInstanceOffsetAlignment: 64,
    waterMeshInstanceDynamicOffsets: new Map(),
    waterMeshTransitionTargetsByDraw: new Map(),
    waterMeshInstanceBytes: new Uint8Array(64),
    viewIdentity: 'camera:1',
    deviceGeneration: 0,
    frameGeneration,
  });
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
    immutableValues: true,
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
  const { immutableValues: _ownedValues, ...borrowedSnapshot } = material.snapshot;
  const borrowedMaterial = new MaterialResource({ ...borrowedSnapshot, materialHandle: 2 });
  const entry = {
    renderableIndex: 0,
    meshSlot: 0,
    source: {
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
      deviceGeneration: 0,
      rendererFrameNumber: 1,
      errorRegistry: { fire: vi.fn() },
      getMaterialShaderPipelineEntry: pipelineLookup,
      getWaterMaterialFrameBindings: ({ frameGeneration }: { frameGeneration: number }) =>
        new Map([[waterTarget, waterBindings(frameGeneration)]]) as never,
      getParamSchema: () => [],
    },
    materialBgAssemblyCache: new MaterialBgAssemblyCache(),
    store: { materialResourceEpoch: 0 },
    world,
    resourceScopes: world,
    camera: { entityKey: 1, position: [0, 0, 0] },
    materialFrame: new MaterialDispatch().materials().with(material).with(borrowedMaterial),
    materialSlots: [material.snapshot, borrowedMaterial.snapshot],
    materialSlotIndices: [[0], [1]],
    pipelineState: {
      device,
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
  } as unknown as _InternalRenderPipelineContext & {
    resourceScopes: NonNullable<_InternalRenderPipelineContext['resourceScopes']>;
    materialFrame: NonNullable<_InternalRenderPipelineContext['materialFrame']>;
  };
  Object.assign(c, { resourceScopes: c.world });
  Object.assign(c, { shadowPipelineSelectionOwner: createShadowPipelineSelectionOwner(c) });
  expect(c.shadowPipelineSelectionOwner).toBeDefined();
  const setBindGroup = vi.fn();
  const drawShadow = vi.fn();
  const pass = {
    setVertexBuffer: vi.fn(),
    setBindGroup,
    draw: drawShadow,
  } as unknown as RhiRenderPassEncoder;
  const creates = vi.spyOn(device, 'createBuffer');
  const groups = vi.spyOn(device, 'createBindGroup');
  const writes = vi.spyOn(device.queue, 'writeBuffer');
  const draw = c.validatedOrdered[0];
  if (draw === undefined) throw new Error('missing draw');
  const record = (
    context: _InternalRenderPipelineContext,
    reuse = true,
    reflected = false,
    terrainReceiver?: { readonly worldId: number; readonly entityKey: number },
  ) =>
    recordShadowCasterDraws(
      context,
      pass,
      pipeline,
      materialGroup,
      undefined,
      reflected,
      undefined,
      false,
      terrainReceiver,
      0xffffffff,
      reuse,
    );
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

    const waterEntry = {
      ...entry,
      source: {
        ...entry.source,
        waterOwner: {
          guid: 'shadow-water-body',
          generation: 1,
          worldIdentity: world.identity,
          zoneGuid: 'shadow-water-zone',
          zoneGeneration: 1,
          targetFormat: 'rgba16float',
          viewIdentity: 'camera:1',
        },
      },
    };
    const borrowedEntry = {
      ...entry,
      renderableIndex: 1,
      source: {
        ...entry.source,
        entityKey: 2,
        material: borrowedMaterial,
        materials: [borrowedMaterial],
      },
    };
    expect(c.materialFrame?.hasBorrowedValues).toBe(true);
    Object.assign(c, { validatedOrdered: [waterEntry, borrowedEntry] });
    pipelineLookup.mockClear();
    drawShadow.mockClear();
    setBindGroup.mockClear();
    const requestsPerCascade: number[] = [];
    for (let cascade = 0; cascade < 3; cascade++) {
      const waterContext = waterMaterialRecordContext(c, undefined);
      expect(waterContext).not.toBe(c);
      expect(waterContext.shadowPipelineSelectionOwner).toBe(c.shadowPipelineSelectionOwner);
      const requestsBefore = pipelineLookup.mock.calls.length;
      record(waterContext);
      requestsPerCascade.push(pipelineLookup.mock.calls.length - requestsBefore);
    }
    expect(requestsPerCascade).toEqual([2, 1, 1]);
    expect(pipelineLookup).toHaveBeenCalledTimes(4);
    expect(drawShadow).toHaveBeenCalledTimes(6);
    const reusedDraws = drawShadow.mock.calls.map((call) => [...call]);
    const reusedBindings = setBindGroup.mock.calls.map((call) => [...call]);

    pipelineLookup.mockClear();
    drawShadow.mockClear();
    setBindGroup.mockClear();
    for (let cascade = 0; cascade < 3; cascade++) record(c, false);
    expect(pipelineLookup).toHaveBeenCalledTimes(6);
    expect(drawShadow.mock.calls).toEqual(reusedDraws);
    expect(setBindGroup.mock.calls).toEqual(reusedBindings);

    pipelineLookup.mockClear();
    Object.assign(c, { shadowPipelineSelectionOwner: createShadowPipelineSelectionOwner(c) });
    Object.assign(c, { validatedOrdered: [waterEntry] });
    record(waterMaterialRecordContext(c, undefined));
    expect(
      pipelineLookup.mock.calls.filter((args) => args[0] === 'forgeax::default-shadow-caster'),
    ).toHaveLength(1);

    pipelineLookup.mockClear();
    drawShadow.mockClear();
    Object.assign(c, { shadowPipelineSelectionOwner: createShadowPipelineSelectionOwner(c) });
    Object.assign(c, { validatedOrdered: [waterEntry] });
    const originalLookup = pipelineLookup.getMockImplementation();
    if (originalLookup === undefined) throw new Error('missing shadow pipeline lookup');
    let enteredNestedRecord = false;
    pipelineLookup.mockImplementation((...args) => {
      if (!enteredNestedRecord) {
        enteredNestedRecord = true;
        record(waterMaterialRecordContext(c, undefined));
      }
      return originalLookup(...args);
    });
    record(waterMaterialRecordContext(c, undefined));
    expect(enteredNestedRecord).toBe(true);
    expect(pipelineLookup).toHaveBeenCalledTimes(2);
    expect(drawShadow).toHaveBeenCalledTimes(2);
    record(waterMaterialRecordContext(c, undefined));
    expect(pipelineLookup).toHaveBeenCalledTimes(2);
    pipelineLookup.mockImplementation(originalLookup);

    const skinnedVariant = {
      ...waterEntry,
      source: { ...waterEntry.source, skinBinding: {} },
    };
    Object.assign(c, {
      validatedOrdered: [waterEntry, skinnedVariant],
      shadowPipelineSelectionOwner: createShadowPipelineSelectionOwner(c),
    });
    pipelineLookup.mockClear();
    record(c);
    expect(pipelineLookup).toHaveBeenCalledTimes(2);
    expect(new Set(pipelineLookup.mock.calls.map((args) => args[5])).size).toBe(2);

    Object.assign(c, {
      validatedOrdered: [waterEntry],
      shadowPipelineSelectionOwner: createShadowPipelineSelectionOwner(c),
    });
    pipelineLookup.mockClear();
    pipelineLookup.mockImplementationOnce(() => null as never);
    expect(() => record(c)).toThrow('CPU ShadowCaster pipeline');
    record(c);
    expect(pipelineLookup).toHaveBeenCalledTimes(2);
    pipelineLookup.mockImplementation(originalLookup);

    const formatFallback = {
      ...entry,
      source: {
        ...entry.source,
        waterOwner: {
          guid: 'shadow-water-body',
          generation: 1,
          worldIdentity: world.identity,
          zoneGuid: 'shadow-water-zone',
          zoneGeneration: 1,
          targetFormat: undefined,
          viewIdentity: 'camera:1',
        },
      },
    };
    const formatExplicit = {
      ...entry,
      source: {
        ...entry.source,
        entityKey: 2,
        waterOwner: {
          guid: 'shadow-water-body',
          generation: 1,
          worldIdentity: world.identity,
          zoneGuid: 'shadow-water-zone',
          zoneGeneration: 1,
          targetFormat: 'rgba32float',
          viewIdentity: 'camera:1',
        },
      },
    };
    Object.assign(c, {
      waterInfoFormat: 'rgba16float',
      validatedOrdered: [formatFallback, formatExplicit],
      materialSlotIndices: [[0], [0]],
      shadowPipelineSelectionOwner: createShadowPipelineSelectionOwner(c),
    });
    pipelineLookup.mockClear();
    record(c);
    expect(pipelineLookup).toHaveBeenCalledTimes(2);
    expect(pipelineLookup.mock.calls.map((args) => args[22])).toEqual([
      'rgba16float',
      'rgba32float',
    ]);
    expect(pipelineLookup.mock.calls.map((args) => args[5])).toEqual([
      expect.stringContaining('WATER_INFO_RGBA16=true'),
      expect.stringContaining('WATER_INFO_RGBA16=false'),
    ]);

    Object.assign(c, { validatedOrdered: entries });
    const firstBuffer = resolveGeometryInstanceBuffer(c, draw, [], false)?.[0]?.instanceBuffer;
    entries.push({
      ...entry,
      source: {
        ...entry.source,
        entityKey: entry.source.entityKey + 1,
        instances: { ...instances, cacheKey: 2, transforms: matrix(1000) },
        temporal: {
          previousTransform: { world: matrix(0) },
          previousInstances: { ...previousInstances, transforms: matrix(999) },
        },
      },
    });
    recordShadowCasterDraws(c, pass, pipeline, materialGroup, undefined, false);
    const other = c.validatedOrdered[1];
    if (other === undefined) throw new Error('missing second entity draw');
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
