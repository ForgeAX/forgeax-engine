import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry, deriveVertexLayoutProjection } from '@forgeax/engine-geometry';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { type RhiNullDevice, RhiNullRenderPassEncoder, rhi } from '@forgeax/engine-rhi-null';
import { createMaterialShaderProgram, type MaterialShaderArtifact } from '@forgeax/engine-shader';
import { ok } from '@forgeax/engine-types';
import { assert, expect, it, vi } from 'vitest';
import { GpuResidencyCache, type MeshGpuHandles } from '../device/gpu-residency';
import { gpuDrivenMaterialResourceClass } from '../extract/gpu-driven';
import { prepareBatchExecution } from '../gpu-driven/batch-execution';
import { BatchTopology } from '../gpu-driven/batch-topology';
import { GpuDrivenProduction } from '../gpu-driven/production-raster';
import { prepareBatchRows } from '../gpu-driven/production-raster-prepare';
import { GpuBuffer } from '../gpu-resource';
import { GpuScene } from '../gpu-scene';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_INDEX,
  GPU_BUFFER_USAGE_VERTEX,
} from '../gpu-usage';
import { RhiErrorListenerRegistry } from '../lifecycle';
import { MaterialResource } from '../material-resource';
import { worldRenderResources } from '../publication/resource-scope';
import { makeZeroCameraFallbackSnapshot, type RenderFrameState } from '../record/frame-snapshot';
import type { PipelineState, RenderSystemInternals } from '../record/render-context';
import { ensureCompiledFrameGraph } from '../record/typed-frame-graph';
import type { RenderPipeline, RenderPipelineFrame } from '../render-pipeline';
import type { MaterialSnapshot, RenderableSnapshot } from '../render-system-extract';
import { RenderScene } from '../scene/render-scene';
import { createTemporalFrameTransaction, TemporalViewHistory } from '../temporal/frame';
import type { ViewLights } from '../world/render-lights';
import {
  admitGpuFixture,
  preparedPbrSnapshot as preparedPbrFixture,
  snapshot,
  standardPbrInputs,
} from './gpu-driven-production-fixture';

function updateSnapshot(value: RenderableSnapshot) {
  return {
    kind: 'update' as const,
    worldId: value.worldId,
    entityKey: value.entityKey,
    snapshot: value,
  };
}

function mesh(device: RhiNullDevice, indexed = true, withLod = false): MeshGpuHandles {
  const vertex = device
    .createBuffer({
      size: 144,
      usage: GPU_BUFFER_USAGE_VERTEX | GPU_BUFFER_USAGE_COPY_DST,
    })
    .unwrap();
  const index = indexed
    ? device
        .createBuffer({
          size: 16,
          usage: GPU_BUFFER_USAGE_INDEX | GPU_BUFFER_USAGE_COPY_DST,
        })
        .unwrap()
    : null;
  return {
    vertexBuffer: new GpuBuffer(device, vertex),
    indexBuffer: index === null ? null : new GpuBuffer(device, index),
    contentEpoch: 0,
    vboBytes: 144,
    iboBytes: indexed ? 16 : 0,
    indexCount: indexed ? 3 : 0,
    indexFormat: 'uint16',
    layoutProjection: deriveVertexLayoutProjection({
      position: new Float32Array(9),
      normal: new Float32Array(9),
      uv: new Float32Array(6),
      tangent: new Float32Array(12),
    }),
    uvSetCount: 1,
    vertexCount: 3,
    indexed,
    topology: 'triangle-list',
    submeshes: [
      {
        indexOffset: 0,
        indexCount: 3,
        vertexCount: 3,
        materialSlot: 0,
        topology: 'triangle-list',
      },
    ],
    ...(withLod
      ? {
          lodRanges: [
            [{ first: 0, count: 3, baseVertex: 0 }],
            [{ first: 3, count: 1, baseVertex: 0 }],
          ],
        }
      : {}),
  };
}

it.each([
  'vertex',
  'index',
  'both',
  'neither',
  'index-format',
] as const)('binds current shared physical %s buffers outside stock graph resources', async (shared) => {
  const device = (
    await (await rhi.requestAdapter()).unwrap().requestDevice()
  ).unwrap() as RhiNullDevice;
  const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const viewLayout = device.createBindGroupLayout({ entries: [] }).unwrap();
  const viewGroup = device.createBindGroup({ layout: viewLayout, entries: [] }).unwrap();
  const materialLayout = device.createBindGroupLayout({ entries: [] }).unwrap();
  const materialGroup = device.createBindGroup({ layout: materialLayout, entries: [] }).unwrap();
  const first = mesh(device);
  const independent = mesh(device);
  const second = {
    ...independent,
    vertexBuffer:
      shared === 'vertex' || shared === 'both' ? first.vertexBuffer : independent.vertexBuffer,
    indexBuffer:
      shared === 'index' || shared === 'both' || shared === 'index-format'
        ? first.indexBuffer
        : independent.indexBuffer,
    indexFormat: shared === 'index-format' ? ('uint32' as const) : independent.indexFormat,
  };
  const projection = new RenderScene();
  const topology = new BatchTopology();
  const availability = GpuScene.create(device, 4).unwrap();
  if (availability.status !== 'available') throw Error('GPU scene unavailable');
  const rows = [
    preparedPbrFixture(snapshot(1, 3)),
    { ...preparedPbrFixture(snapshot(2, 5)), worldId: 1 },
  ];
  const delta = projection.apply(rows.map(updateSnapshot));
  topology.apply(delta);
  availability.scene.sync(delta).unwrap();
  const production = new GpuDrivenProduction(device, { createShaderModule: () => ok(shader) });
  const frame = production
    .prepare(
      admitGpuFixture({
        ...standardPbrInputs(device, shader, viewLayout),
        scene: {
          scene: availability.scene,
          plan: topology.query(topology.sourcePlan(), undefined),
          slots: projection.slotsSnapshot(),
          slotAt: projection.slotAt,
        },
        camera: makeZeroCameraFallbackSnapshot(),
        meshBySlot: new Map([
          [0, first],
          [1, second],
        ]),

        viewBindGroupLayout: viewLayout,
      }),
    )
    .unwrap();
  if (frame === undefined) throw Error('expected GPU frame');
  const graph = new RenderGraphBuilder<RenderPipelineFrame>();
  const gpu = frame.project(graph, 'rgba8unorm', 1, undefined, undefined, false, true).unwrap();
  const color = graph
    .createTexture('physical-import-color', { format: 'rgba8unorm', size: { width: 1, height: 1 } })
    .unwrap();
  const view = graph.view(color).unwrap();
  graph
    .addRasterPass('physical-imports', {
      accesses: [...gpu.accesses, { resource: view, usage: 'color-attachment' }],
      colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }],
      encode: ({ pass, resources }) =>
        gpu.encode(viewGroup, pass, resources, {
          ...frame.standardPbrFrameResources,
          prepareMaterialBinding: (
            (groups: readonly (import('@forgeax/engine-rhi').BindGroup | undefined)[]) =>
            (slot: number) => {
              const group = groups[slot];
              return group === undefined ? undefined : { group, byteOffset: slot * 1280 };
            }
          )([materialGroup]),
        }),
    })
    .unwrap();
  const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
  const vertices = vi.spyOn(RhiNullRenderPassEncoder.prototype, 'setVertexBuffer');
  const indices = vi.spyOn(RhiNullRenderPassEncoder.prototype, 'setIndexBuffer');
  const draws = vi.spyOn(RhiNullRenderPassEncoder.prototype, 'drawIndexedIndirect');
  try {
    const encoder = device.createCommandEncoder().unwrap();
    compiled.execute({ encoder } as RenderPipelineFrame).unwrap();
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    frame._commitResourceReplacement();
    expect(draws).toHaveBeenCalledTimes(2);
    expect(new Set(vertices.mock.calls.map(([, buffer]) => buffer))).toEqual(
      new Set([first.vertexBuffer.handle, second.vertexBuffer.handle]),
    );
    expect(new Set(indices.mock.calls.map(([buffer]) => buffer))).toEqual(
      new Set([first.indexBuffer?.handle, second.indexBuffer?.handle]),
    );
    const sameIndexBinding =
      first.indexBuffer === second.indexBuffer && first.indexFormat === second.indexFormat;
    expect(indices.mock.calls.map(([buffer, format]) => [buffer, format])).toEqual(
      sameIndexBinding
        ? [[first.indexBuffer?.handle, first.indexFormat]]
        : [
            [first.indexBuffer?.handle, first.indexFormat],
            [second.indexBuffer?.handle, second.indexFormat],
          ],
    );
    const info = compiled.inspect();
    const resources = info.resources.filter((row) => row.label.startsWith('gpu-driven.standard.'));
    const accesses = info.passes.find((pass) => pass.name === 'physical-imports')?.accesses;
    expect(resources.filter((row) => row.label.endsWith('.vertex'))).toHaveLength(0);
    expect(resources.filter((row) => row.label.endsWith('.index'))).toHaveLength(0);
    expect(accesses?.filter((access) => access.usage === 'vertex-read')).toHaveLength(0);
    expect(accesses?.filter((access) => access.usage === 'index-read')).toHaveLength(0);
  } finally {
    vertices.mockRestore();
    indices.mockRestore();
    draws.mockRestore();
    await compiled.retire();
    // The graph borrows buffers; their residency owner still controls destruction.
    for (const resident of [first, independent]) {
      expect(resident.vertexBuffer.isDestroyed).toBe(false);
      expect(resident.indexBuffer?.isDestroyed).toBe(false);
      resident.vertexBuffer.destroy().unwrap();
      resident.indexBuffer?.destroy().unwrap();
    }
    production.dispose();
    availability.scene.dispose();
  }
});

it.each([
  'texture',
  'sampler',
  'alphaCutoff',
])('retains the compiled graph after a live %s source update', async (kind) => {
  const device = (
    await (await rhi.requestAdapter()).unwrap().requestDevice()
  ).unwrap() as RhiNullDevice;
  const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const viewLayout = device.createBindGroupLayout({ entries: [] }).unwrap();
  const viewGroup = device.createBindGroup({ layout: viewLayout, entries: [] }).unwrap();
  const pbr = standardPbrInputs(device, shader, viewLayout);
  const source = preparedPbrFixture(snapshot(1, 3));
  const store = new GpuResidencyCache();
  store.configureGpuDevice(device, undefined, device.caps);
  const assets = new AssetRegistry();
  const world = new World({ assets });
  const texture = (value: number) => ({
    kind: 'texture' as const,
    shape: { viewDimension: '2d' as const, extent: { width: 1, height: 1 } },
    format: 'rgba8unorm' as const,
    colorSpace: 'linear' as const,
    mips: { kind: 'none' as const },
    data: new Uint8Array([value, value, value, 255]),
  });
  const assetA = texture(32),
    assetB = texture(128);
  const handleA = assets.create(assetA).unwrap(),
    handleB = assets.create(assetB).unwrap();
  const residentA = store.ensureResident(handleA, assetA, worldRenderResources(world)).unwrap();
  const residentB = store.ensureResident(handleB, assetB, worldRenderResources(world)).unwrap();
  const leaseA = store.retainTextureResidency(handleA, worldRenderResources(world));
  if (leaseA === undefined) throw Error('missing texture residency lease');
  let finishSubmittedA = () => {};
  const submittedA = new Promise<void>((resolve) => {
    finishSubmittedA = resolve;
  });
  leaseA.track(submittedA);
  const samplerA = device.createSampler({ minFilter: 'nearest' }).unwrap();
  const samplerB = device.createSampler({ minFilter: 'linear' }).unwrap();
  const materialLayout = device
    .createBindGroupLayout({
      entries: [
        { binding: 0, visibility: 2, texture: {} },
        { binding: 1, visibility: 2, sampler: { type: 'filtering' } },
      ],
    })
    .unwrap();
  const materialGroupA = device
    .createBindGroup({
      layout: materialLayout,
      entries: [
        { binding: 0, resource: { kind: 'textureView', value: residentA.view } },
        { binding: 1, resource: { kind: 'sampler', value: samplerA } },
      ],
    })
    .unwrap();
  const materialGroupB = device
    .createBindGroup({
      layout: materialLayout,
      entries: [
        {
          binding: 0,
          resource: {
            kind: 'textureView',
            value: kind === 'texture' ? residentB.view : residentA.view,
          },
        },
        {
          binding: 1,
          resource: { kind: 'sampler', value: kind === 'sampler' ? samplerB : samplerA },
        },
      ],
    })
    .unwrap();
  let materialGroup = materialGroupA;
  const firstMaterial = new MaterialResource(source.material.snapshot);
  const secondMaterial = new MaterialResource(source.material.snapshot);
  const row = (changed: boolean, material: MaterialResource) => {
    material.adopt({
      ...source.material.snapshot,
      standardTextureMask: 1,
      deferredPass: false,
      paramSnapshot: { alphaCutoff: kind === 'alphaCutoff' && changed ? 0.5 : 0 },
      textureHandles: new Map([
        ['baseColorTexture', kind === 'texture' && changed ? handleB : handleA],
      ]),
      samplerHandles: new Map([
        ['baseColorTexture', (kind === 'sampler' && changed ? 2 : 1) as never],
      ]),
    });
    return {
      ...source,
      material,
      materials: [material],
      gpuDrivenDraws: (source.gpuDrivenDraws ?? []).map((draw) => ({
        ...draw,
        materialResourceClass: gpuDrivenMaterialResourceClass(material.snapshot),
      })),
    };
  };
  const projection = new RenderScene();
  const availability = GpuScene.create(device, 4).unwrap();
  if (availability.status !== 'available') throw Error('GPU scene unavailable');
  const topology = new BatchTopology();
  const apply = (changed: boolean) => {
    const delta = projection.apply([
      updateSnapshot(row(changed, firstMaterial)),
      // A different binding source keeps the second row out of the edited row's batch.
      updateSnapshot({
        ...row(true, secondMaterial),
        entityKey: 2,
        materialBindingSources: ['mesh-default'],
      }),
    ]);
    availability.scene.sync(delta).unwrap();
    topology.apply(delta);
  };
  apply(false);
  expect(topology.query(topology.sourcePlan(), undefined).batches.length).toBe(2);
  const production = new GpuDrivenProduction(device, { createShaderModule: () => ok(shader) });
  const sharedMesh = mesh(device);
  const prepare = () => {
    const current = production
      .prepare(
        admitGpuFixture({
          ...pbr,
          scene: {
            scene: availability.scene,
            plan: topology.query(topology.sourcePlan(), undefined),
            slots: projection.slotsSnapshot(),
            slotAt: projection.slotAt,
          },
          camera: makeZeroCameraFallbackSnapshot(),
          meshBySlot: new Map([
            [0, sharedMesh],
            [1, sharedMesh],
          ]),

          viewBindGroupLayout: viewLayout,
        }),
      )
      .unwrap();
    if (current === undefined) throw Error('expected GPU frame');
    return current;
  };
  let current = prepare();
  const firstSignature = current.topologySignature;
  const firstResourceGeneration = current.standardPbrFrameResources.resourceGeneration;
  const bound = vi.spyOn(RhiNullRenderPassEncoder.prototype, 'setBindGroup');
  const pipelines = vi.spyOn(device, 'createRenderPipeline');
  const activePipeline: RenderPipeline = {
    build: ({ graph, projectGpuDriven }) => {
      const gpu = projectGpuDriven({ format: 'rgba8unorm', sampleCount: 1 }).unwrap();
      if (gpu === undefined) throw Error('missing GPU projection');
      const color = graph
        .createTexture('diagnostic-color', { format: 'rgba8unorm', size: { width: 1, height: 1 } })
        .unwrap();
      const view = graph.view(color).unwrap();
      graph
        .addRasterPass('diagnostic-raster', {
          accesses: [...gpu.accesses, { resource: view, usage: 'color-attachment' }],
          colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }],
          encode: ({ pass, resources }) =>
            gpu.encode(viewGroup, pass, resources, {
              ...current.standardPbrFrameResources,
              prepareMaterialBinding: (
                (groups: readonly (import('@forgeax/engine-rhi').BindGroup | undefined)[]) =>
                (slot: number) => {
                  const group = groups[slot];
                  return group === undefined ? undefined : { group, byteOffset: slot * 1280 };
                }
              )([materialGroup]),
            }),
        })
        .unwrap();
      return ok(undefined);
    },
  };
  const state = {
    temporalFrameTransaction: createTemporalFrameTransaction({ deviceEpoch: 0 }),
    temporalView: new TemporalViewHistory(),
    compiledFrameGraph: null,
    compiledFrameGraphGeneration: 0,
    retiredCompiledFrameGraphs: new Set(),
    activePipeline,
    installedPipelineConfig: undefined,
  } as unknown as RenderFrameState;
  const errors: unknown[] = [];
  const errorRegistry = new RhiErrorListenerRegistry();
  errorRegistry.add((error) => errors.push(error));
  const internals = { device, errorRegistry } as unknown as RenderSystemInternals;
  const pipelineState = {
    format: 'rgba8unorm',
    colorAttachmentFormat: 'rgba8unorm',
  } as unknown as PipelineState;
  const lights = {
    cascades: undefined,
    pointShadow: [],
    spot: [],
    shadowViews: [],
  } as unknown as ViewLights;
  const compile = () =>
    ensureCompiledFrameGraph(
      internals,
      state,
      pipelineState,
      makeZeroCameraFallbackSnapshot(),
      lights,
      1,
      1,
      undefined,
      current,
    );
  const encode = (graph: NonNullable<ReturnType<typeof compile>>) => {
    bound.mockClear();
    const encoder = device.createCommandEncoder().unwrap();
    const result = graph.execute({ encoder } as RenderPipelineFrame);
    if (result.ok) {
      const command = encoder.finish().unwrap();
      device.queue.submit([command]).unwrap();
      current._commitResourceReplacement();
    }
    return result;
  };
  try {
    const first = compile();
    if (first === null) throw Error('missing compiled graph');
    const firstInfo = first.inspect();
    encode(first).unwrap();
    expect(bound.mock.calls.some(([index, value]) => index === 1 && value === materialGroupA)).toBe(
      true,
    );
    materialGroup = materialGroupB;
    const pipelineCount = pipelines.mock.calls.length;
    apply(true);
    current = prepare();
    expect(topology.query(topology.sourcePlan(), undefined).batches.length).toBe(2);
    expect(current.topologySignature).toBe(firstSignature);
    encode(first).unwrap();
    expect(bound.mock.calls.some(([index, value]) => index === 1 && value === materialGroupB)).toBe(
      true,
    );
    const next = compile();
    if (next === null) throw Error('missing changed graph');
    encode(next).unwrap();
    const afterInfo = next.inspect();
    const boundCurrentGroup = bound.mock.calls.some(
      ([index, value]) => index === 1 && value === materialGroupB,
    );
    expect(boundCurrentGroup).toBe(true);
    expect(pipelines.mock.calls.length).toBe(pipelineCount);
    expect(current.standardPbrFrameResources.resourceGeneration).toBe(firstResourceGeneration);
    const selectedSource = projection.slotsSnapshot().at(0);
    assert(selectedSource);
    expect(current.selection.has(selectedSource.snapshot, 0)).toBe(true);
    expect(errors).toHaveLength(0);
    expect(next).toBe(first);
    expect(state.compiledFrameGraphGeneration).toBe(1);
    expect(afterInfo.resources).toEqual(firstInfo.resources);
    expect(afterInfo.passes).toEqual(firstInfo.passes);
    // Retiring either graph must not own or destroy either asset texture.
    await first.retire();
    await next.retire();
    expect(residentA.texture.isDestroyed).toBe(false);
    expect(residentB.texture.isDestroyed).toBe(false);
    await device.queue.onSubmittedWorkDone();
    store.invalidateTexture(handleA, worldRenderResources(world));
    const releasedA = leaseA.release(false);
    expect(residentA.texture.isDestroyed).toBe(false);
    finishSubmittedA();
    await submittedA;
    await releasedA;
    expect(residentA.texture.isDestroyed).toBe(true);
    expect(residentB.texture.isDestroyed).toBe(false);
  } finally {
    finishSubmittedA();
    await leaseA.release(false);
    bound.mockRestore();
    pipelines.mockRestore();
    await state.compiledFrameGraph?.graph.retire();
    for (const graph of state.retiredCompiledFrameGraphs) await graph.retire();
    production.dispose();
    availability.scene.dispose();
    store.destroyAll();
  }
});

it('separates physical layouts, specializations and selected programs after resource groups share a class', async () => {
  const device = (
    await (await rhi.requestAdapter()).unwrap().requestDevice()
  ).unwrap() as RhiNullDevice;
  const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const viewLayout = device.createBindGroupLayout({ entries: [] }).unwrap();
  const artifact = standardPbrInputs(device, shader, viewLayout).materialArtifact;
  if (artifact === undefined || artifact.receipt === undefined) throw Error('missing material');
  const original = preparedPbrFixture(snapshot(1, 3));
  const originalMesh = mesh(device);
  const replacedMesh = mesh(device);
  const classFor = (
    source: RenderableSnapshot,
    resident: MeshGpuHandles,
    selected: MaterialShaderArtifact,
  ) => {
    const projection = new RenderScene();
    const topology = new BatchTopology();
    topology.apply(projection.apply([updateSnapshot(source)]));
    const batch = topology.query(topology.sourcePlan(), undefined).batches.at(0);
    if (batch === undefined) throw Error('missing admitted batch');
    const binding = batch.binding;
    if (binding === undefined) throw Error('missing shared binding');
    const accepted = binding.material.snapshot;
    assert(accepted.materialShaderId);
    const execution = prepareBatchExecution(
      binding.geometry,
      accepted,
      {
        kind: 'forward',
        shaderId: accepted.materialShaderId,
        ...(accepted.renderState === undefined ? {} : { renderState: accepted.renderState }),
      },
      () => selected,
    ).unwrap();
    const rows = prepareBatchRows(batch, { mesh: resident, worldKeys: undefined, execution });
    const key = rows.fact?.rasterClassKey;
    if (key === undefined) throw Error('missing prepared raster class');
    return key;
  };
  const materialSource = (snapshot: MaterialSnapshot): RenderableSnapshot => {
    const material = new MaterialResource(snapshot);
    return { ...original, material, materials: [material] };
  };
  const mirroredWorld = new Float32Array(original.transform.world);
  mirroredWorld[0] = -1;
  const mirrored = { ...original, transform: { world: mirroredWorld } };
  const baseline = classFor(original, originalMesh, artifact);
  const cases: readonly [string, RenderableSnapshot, MeshGpuHandles, MaterialShaderArtifact][] = [
    ['model winding', mirrored, originalMesh, artifact],
    ['physical buffers', original, replacedMesh, artifact],
    [
      'vertex buffer',
      original,
      { ...originalMesh, vertexBuffer: replacedMesh.vertexBuffer },
      artifact,
    ],
    [
      'index buffer',
      original,
      { ...originalMesh, indexBuffer: replacedMesh.indexBuffer },
      artifact,
    ],
    ['index format', original, { ...originalMesh, indexFormat: 'uint32' }, artifact],
    ['shader UV ABI', original, originalMesh, { ...artifact, uvSetCount: 2 }],
    [
      'vertex layout',
      original,
      {
        ...originalMesh,
        layoutProjection: deriveVertexLayoutProjection({ position: new Float32Array(0) }),
      },
      artifact,
    ],
    [
      'texture specialization',
      materialSource({ ...original.material.snapshot, standardTextureMask: 4 }),
      originalMesh,
      artifact,
    ],
    [
      'raster state',
      materialSource({ ...original.material.snapshot, renderState: { cullMode: 'front' } }),
      originalMesh,
      artifact,
    ],
    [
      'sampler binding shape',
      original,
      originalMesh,
      {
        ...artifact,
        layoutIdentity: 'comparison-sampler',
        receipt: {
          ...artifact.receipt,
          reflection: { ...artifact.receipt.reflection, layoutIdentity: 'comparison-sampler' },
        },
      },
    ],
    ...['clipping', 'displacement', 'alphaHash'].map(
      (feature): [string, RenderableSnapshot, MeshGpuHandles, MaterialShaderArtifact] => [
        `${feature} program`,
        original,
        originalMesh,
        {
          ...artifact,
          program: createMaterialShaderProgram(`selected-${feature}-program`),
          variantSet: `${feature}=true`,
        },
      ],
    ),
  ];
  try {
    for (const [name, source, resident, selected] of cases) {
      expect(classFor(source, resident, selected), name).not.toBe(baseline);
    }
    const customId = 'game::custom-coverage';
    const customMaterial = { ...original.material.snapshot, materialShaderId: customId };
    const customSource = {
      ...materialSource(customMaterial),
      gpuDrivenDraws: (original.gpuDrivenDraws ?? []).map((draw) => {
        if (draw.prepared === undefined) throw Error('missing prepared draw');
        return {
          ...draw,
          prepared: {
            ...draw.prepared,
            identity: { ...draw.prepared.identity, material: customId },
          },
        };
      }),
    };
    expect(classFor(customSource, originalMesh, { ...artifact, material: customId })).not.toBe(
      baseline,
    );
  } finally {
    for (const resident of [originalMesh, replacedMesh]) {
      resident.vertexBuffer.destroy().unwrap();
      resident.indexBuffer?.destroy().unwrap();
    }
  }
});

it.each([
  'material pass',
  'mesh UV metadata',
] as const)('retains the real graph for record-time %s while routing draws and rebuilding changed ABI', async (kind) => {
  const device = (
    await (await rhi.requestAdapter()).unwrap().requestDevice()
  ).unwrap() as RhiNullDevice;
  const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const viewLayout = device.createBindGroupLayout({ entries: [] }).unwrap();
  const viewGroup = device.createBindGroup({ layout: viewLayout, entries: [] }).unwrap();
  const materialGroup = device.createBindGroup({ layout: viewLayout, entries: [] }).unwrap();
  const pbr = standardPbrInputs(device, shader, viewLayout);
  if (pbr.materialArtifact === undefined || pbr.materialPipelineState === undefined)
    throw Error('missing prepared Standard material');
  const originalArtifact = pbr.materialArtifact;
  let artifact = originalArtifact;
  let shaderUvSetCount = 1;
  const source = preparedPbrFixture(snapshot(1, 3));
  const projection = new RenderScene();
  const availability = GpuScene.create(device, 4).unwrap();
  if (availability.status !== 'available') throw Error('GPU scene unavailable');
  const topology = new BatchTopology();
  let deferred = false;
  const apply = () => {
    const material = source.material;
    material.adopt({ ...source.material.snapshot, deferredPass: deferred });
    const delta = projection.apply([
      updateSnapshot({ ...source, material, materials: [material] }),
    ]);
    availability.scene.sync(delta).unwrap();
    topology.apply(delta);
  };
  apply();
  const originalMesh = mesh(device);
  let resident = originalMesh;

  const production = new GpuDrivenProduction(device, {
    createShaderModule: () => ok(shader),
  });
  const prepare = () => {
    const prepared = production
      .prepare(
        admitGpuFixture({
          materialArtifact: artifact,
          materialPipelineState: {
            ...pbr.materialPipelineState,
            standardPbrShaderUvSetCount: shaderUvSetCount,
          } as PipelineState,
          scene: {
            scene: availability.scene,
            plan: topology.query(topology.sourcePlan(), undefined),
            slots: projection.slotsSnapshot(),
            slotAt: projection.slotAt,
          },
          camera: makeZeroCameraFallbackSnapshot(),
          meshBySlot: new Map([[0, resident]]),

          viewBindGroupLayout: viewLayout,
        }),
      )
      .unwrap();
    if (prepared === undefined) throw Error('expected GPU frame');
    return prepared;
  };
  let current = prepare();
  const resourceGeneration = current.standardPbrFrameResources.resourceGeneration;
  const draws = vi.spyOn(RhiNullRenderPassEncoder.prototype, 'drawIndexedIndirect');
  const pipelines = vi.spyOn(device, 'createRenderPipeline');
  const routes: Array<readonly [string, number, boolean]> = [];
  const activePipeline: RenderPipeline = {
    build: ({ graph, projectGpuDriven }) => {
      const gpu = projectGpuDriven({ format: 'rgba8unorm', sampleCount: 1 }).unwrap();
      if (gpu === undefined) throw Error('missing GPU projection');
      for (const filter of ['deferred-opaque', 'forward-only-opaque'] as const) {
        const color = graph
          .createTexture(filter, {
            format: 'rgba8unorm',
            size: { width: 1, height: 1 },
          })
          .unwrap();
        const view = graph.view(color).unwrap();
        graph
          .addRasterPass(filter, {
            accesses: [...gpu.accesses, { resource: view, usage: 'color-attachment' }],
            colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }],
            encode: ({ pass, resources }) => {
              const before = draws.mock.calls.length;
              gpu.encode(
                viewGroup,
                pass,
                resources,
                {
                  ...current.standardPbrFrameResources,
                  prepareMaterialBinding: (
                    (groups: readonly (import('@forgeax/engine-rhi').BindGroup | undefined)[]) =>
                    (slot: number) => {
                      const group = groups[slot];
                      return group === undefined ? undefined : { group, byteOffset: slot * 1280 };
                    }
                  )([materialGroup]),
                },
                filter,
                filter === 'deferred-opaque' ? 'fs_gbuffer' : 'fs_opaque',
              );
              routes.push([filter, draws.mock.calls.length - before, gpu.hasWork(filter)]);
            },
          })
          .unwrap();
      }
      return ok(undefined);
    },
  };
  const state = {
    temporalFrameTransaction: createTemporalFrameTransaction({ deviceEpoch: 0 }),
    temporalView: new TemporalViewHistory(),
    compiledFrameGraph: null,
    compiledFrameGraphGeneration: 0,
    retiredCompiledFrameGraphs: new Set(),
    activePipeline,
    installedPipelineConfig: undefined,
  } as unknown as RenderFrameState;
  const errors: unknown[] = [];
  const errorRegistry = new RhiErrorListenerRegistry();
  errorRegistry.add((error) => errors.push(error));
  const compile = () => {
    const graph = ensureCompiledFrameGraph(
      { device, errorRegistry } as unknown as RenderSystemInternals,
      state,
      { format: 'rgba8unorm', colorAttachmentFormat: 'rgba8unorm' } as PipelineState,
      makeZeroCameraFallbackSnapshot(),
      { cascades: undefined, pointShadow: [], spot: [], shadowViews: [] } as unknown as ViewLights,
      1,
      1,
      undefined,
      current,
    );
    if (graph === null) throw Error(`graph failed: ${String(errors[0])}`);
    return graph;
  };
  const encode = (graph: ReturnType<typeof compile>) => {
    routes.length = 0;
    const encoder = device.createCommandEncoder().unwrap();
    graph.execute({ encoder } as RenderPipelineFrame).unwrap();
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    current._commitResourceReplacement();
    expect(routes).toEqual([
      ['deferred-opaque', deferred ? 1 : 0, deferred],
      ['forward-only-opaque', deferred ? 0 : 1, !deferred],
    ]);
    const selectedSource = projection.slotsSnapshot().at(0);
    assert(selectedSource);
    expect(current.selection.has(selectedSource.snapshot, 0)).toBe(true);
    expect(current.standardPbrFrameResources.resourceGeneration).toBe(resourceGeneration);
    expect(errors).toHaveLength(0);
  };
  try {
    const first = compile();
    encode(first);
    const initialVertexLayout = pipelines.mock.calls[0]?.[0].vertex.buffers;
    expect(initialVertexLayout).toBeDefined();
    let warmedPipelineCount = 0;
    for (const [index, changed] of [true, false, true, false].entries()) {
      if (kind === 'material pass') {
        deferred = changed;
        apply();
      } else {
        resident = { ...originalMesh, uvSetCount: changed ? 2 : 1 };
      }
      current = prepare();
      const next = compile();
      encode(next);
      expect(state.compiledFrameGraphGeneration).toBe(1);
      expect(next).toBe(first);
      // The first Deferred draw may lazily create its PSO; subsequent route
      // changes must reuse the graph's already selected pipeline closures.
      if (index === 0) warmedPipelineCount = pipelines.mock.calls.length;
      else expect(pipelines.mock.calls.length).toBe(warmedPipelineCount);
    }

    // A different physical vertex layout is a compiled pipeline fact even
    // when both buffer handles and allocated byte counts stay unchanged.
    resident = {
      ...originalMesh,
      layoutProjection: deriveVertexLayoutProjection({
        position: new Float32Array(9),
        normal: new Float32Array(9),
        uv: new Float32Array(6),
      }),
    };

    current = prepare();
    const changedLayout = compile();
    encode(changedLayout);
    expect(changedLayout).not.toBe(first);
    expect(state.compiledFrameGraphGeneration).toBe(2);
    const changedVertexLayout = pipelines.mock.calls.at(-1)?.[0].vertex.buffers;
    expect(changedVertexLayout).not.toEqual(initialVertexLayout);

    // Shader UV ABI is independent of mesh metadata. The selected artifact
    // and Standard shader input count change together at publication.
    artifact = { ...originalArtifact, uvSetCount: 2 };
    shaderUvSetCount = 2;
    current = prepare();
    const changedAbi = compile();
    encode(changedAbi);
    expect(changedAbi).not.toBe(changedLayout);
    expect(state.compiledFrameGraphGeneration).toBe(3);
    expect(pipelines.mock.calls.at(-1)?.[0].vertex.buffers).not.toEqual(changedVertexLayout);
  } finally {
    draws.mockRestore();
    pipelines.mockRestore();
    await state.compiledFrameGraph?.graph.retire();
    for (const graph of state.retiredCompiledFrameGraphs) await graph.retire();
    production.dispose();
    availability.scene.dispose();
    originalMesh.vertexBuffer.destroy().unwrap();
    originalMesh.indexBuffer?.destroy().unwrap();
  }
});

it('retains shared mesh residency when replacement grows the shared GPU input buffer', async () => {
  const device = (
    await (await rhi.requestAdapter()).unwrap().requestDevice()
  ).unwrap() as RhiNullDevice;
  const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const viewLayout = device.createBindGroupLayout({ entries: [] }).unwrap();
  const inputs = standardPbrInputs(device, shader, viewLayout);
  const assets = new AssetRegistry();
  const world = new World({ assets });
  const store = new GpuResidencyCache();
  store.configureGpuDevice(device, undefined, device.caps);
  const upload = () => {
    const payload = createBoxGeometry(1, 1, 1).unwrap();
    const handle = assets.create(payload).unwrap();
    return {
      handle,
      mesh: store.ensureResident(handle, payload, worldRenderResources(world)).unwrap(),
    };
  };
  const first = upload(),
    replacement = upload();
  expect(replacement.handle).not.toBe(first.handle);
  expect(replacement.mesh).not.toBe(first.mesh);
  expect(replacement.mesh.vertexBuffer).toBe(first.mesh.vertexBuffer);
  expect(replacement.mesh.indexBuffer).toBe(first.mesh.indexBuffer);
  const projection = new RenderScene();
  const availability = GpuScene.create(device, 4).unwrap();
  if (availability.status !== 'available') throw Error('GPU scene unavailable');
  const topology = new BatchTopology();
  const production = new GpuDrivenProduction(device, { createShaderModule: () => ok(shader) });
  const prepare = (resident: typeof first) => {
    const delta = projection.apply([
      updateSnapshot(preparedPbrFixture(snapshot(1, Number(resident.handle)))),
    ]);
    availability.scene.sync(delta).unwrap();
    topology.apply(delta);
    const prepared = production
      .prepare(
        admitGpuFixture({
          ...inputs,
          scene: {
            scene: availability.scene,
            plan: topology.query(topology.sourcePlan(), undefined),
            slots: projection.slotsSnapshot(),
            slotAt: projection.slotAt,
          },
          camera: makeZeroCameraFallbackSnapshot(),
          meshBySlot: new Map([[0, resident.mesh]]),
          viewBindGroupLayout: viewLayout,
        }),
      )
      .unwrap();
    if (prepared === undefined) throw Error('expected GPU frame');
    return prepared;
  };
  let current = prepare(first);
  const beforeSignature = current.topologySignature;
  const viewGroup = device.createBindGroup({ layout: viewLayout, entries: [] }).unwrap();
  const materialLayout = device.createBindGroupLayout({ entries: [] }).unwrap();
  const materialGroup = device.createBindGroup({ layout: materialLayout, entries: [] }).unwrap();
  const activePipeline: RenderPipeline = {
    build: ({ graph, projectGpuDriven }) => {
      const gpu = projectGpuDriven({ format: 'rgba8unorm', sampleCount: 1 }).unwrap();
      if (gpu === undefined) throw Error('missing GPU projection');
      const color = graph
        .createTexture('shared-mesh-color', { format: 'rgba8unorm', size: { width: 1, height: 1 } })
        .unwrap();
      const view = graph.view(color).unwrap();
      graph
        .addRasterPass('shared-mesh', {
          accesses: [...gpu.accesses, { resource: view, usage: 'color-attachment' }],
          colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }],
          encode: ({ pass, resources }) =>
            gpu.encode(viewGroup, pass, resources, {
              ...current.standardPbrFrameResources,
              prepareMaterialBinding: (
                (groups: readonly (import('@forgeax/engine-rhi').BindGroup | undefined)[]) =>
                (slot: number) => {
                  const group = groups[slot];
                  return group === undefined ? undefined : { group, byteOffset: slot * 1280 };
                }
              )([materialGroup]),
            }),
        })
        .unwrap();
      return ok(undefined);
    },
  };
  const state = {
    temporalFrameTransaction: createTemporalFrameTransaction({ deviceEpoch: 0 }),
    temporalView: new TemporalViewHistory(),
    compiledFrameGraph: null,
    compiledFrameGraphGeneration: 0,
    retiredCompiledFrameGraphs: new Set(),
    activePipeline,
    installedPipelineConfig: undefined,
  } as unknown as RenderFrameState;
  const errors: unknown[] = [];
  const errorRegistry = new RhiErrorListenerRegistry();
  errorRegistry.add((error) => errors.push(error));
  const internals = { device, errorRegistry } as unknown as RenderSystemInternals;
  const compile = () =>
    ensureCompiledFrameGraph(
      internals,
      state,
      { format: 'rgba8unorm', colorAttachmentFormat: 'rgba8unorm' } as unknown as PipelineState,
      makeZeroCameraFallbackSnapshot(),
      { cascades: undefined, pointShadow: [], spot: [], shadowViews: [] } as unknown as ViewLights,
      1,
      1,
      undefined,
      current,
    );
  const vertices = vi.spyOn(RhiNullRenderPassEncoder.prototype, 'setVertexBuffer');
  const indices = vi.spyOn(RhiNullRenderPassEncoder.prototype, 'setIndexBuffer');
  const draws = vi.spyOn(RhiNullRenderPassEncoder.prototype, 'drawIndexedIndirect');
  const encode = (graph: NonNullable<ReturnType<typeof compile>>) => {
    vertices.mockClear();
    indices.mockClear();
    draws.mockClear();
    const encoder = device.createCommandEncoder().unwrap();
    graph.execute({ encoder } as RenderPipelineFrame).unwrap();
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    current._commitResourceReplacement();
    expect(
      vertices.mock.calls.some(([, buffer]) => buffer === replacement.mesh.vertexBuffer.handle),
    ).toBe(true);
    expect(
      indices.mock.calls.some(([buffer]) => buffer === replacement.mesh.indexBuffer?.handle),
    ).toBe(true);
    expect(draws).toHaveBeenCalledOnce();
  };
  const lease = store.retainMeshResidency(first.handle, worldRenderResources(world));
  if (lease === undefined) throw Error('missing old residency lease');
  let finishOld = () => {},
    finishNew = () => {};
  const oldCompleted = new Promise<void>((resolve) => {
    finishOld = resolve;
  });
  const newCompleted = new Promise<void>((resolve) => {
    finishNew = resolve;
  });
  try {
    const graph = compile();
    if (graph === null) throw Error('missing compiled graph');
    encode(graph);
    store.trackMeshSubmission(oldCompleted);
    const beforeInfo = graph.inspect();
    const resourceGeneration = production.inspect().resourceGeneration;
    const oldInputs = availability.scene.inputs.capture();
    const oldCapacity = oldInputs.buffer().unwrap().byteLength;
    oldInputs.release();
    // Stable material allocation can make an ordinary replacement fit. Force
    // actual arena growth instead of relying on that former allocation order.
    for (let i = 0; i <= oldCapacity / 8; i++)
      availability.scene.inputs.arena.allocateDescriptor(2);
    current = prepare(replacement);
    // Graph passes resolve the current member-input arena when they execute,
    // so its capacity replacement alone keeps the compiled graph.
    expect(production.inspect().resourceGeneration).toBe(resourceGeneration);
    expect(current.topologySignature).toBe(beforeSignature);
    const replacementGraph = compile();
    if (replacementGraph === null) throw Error('missing replacement graph');
    expect(replacementGraph).toBe(graph);
    store.invalidateMesh(first.handle, worldRenderResources(world));
    const released = lease.release(false);
    expect(store.getMeshGpuHandles(first.handle, worldRenderResources(world))).toBeUndefined();
    expect(replacement.mesh.vertexBuffer.isDestroyed).toBe(false);
    expect(replacement.mesh.indexBuffer?.isDestroyed).toBe(false);
    encode(replacementGraph);
    store.trackMeshSubmission(newCompleted);
    expect(state.compiledFrameGraphGeneration).toBe(1);
    expect(replacementGraph.inspect().passes.map((pass) => pass.name)).toEqual(
      beforeInfo.passes.map((pass) => pass.name),
    );
    expect(errors).toHaveLength(0);
    // Graph imports borrow physical buffers; retired asset handles and both
    // submitted frames still retain the shared allocation independently.
    store.invalidateMesh(replacement.handle, worldRenderResources(world));
    finishNew();
    await newCompleted;
    expect(replacement.mesh.vertexBuffer.isDestroyed).toBe(false);
    expect(replacement.mesh.indexBuffer?.isDestroyed).toBe(false);
    finishOld();
    await oldCompleted;
    await released;
    expect(replacement.mesh.vertexBuffer.isDestroyed).toBe(true);
    expect(replacement.mesh.indexBuffer?.isDestroyed).toBe(true);
  } finally {
    finishNew();
    finishOld();
    await Promise.all([oldCompleted, newCompleted]);
    await lease.release(false);
    vertices.mockRestore();
    indices.mockRestore();
    draws.mockRestore();
    await state.compiledFrameGraph?.graph.retire();
    for (const graph of state.retiredCompiledFrameGraphs) await graph.retire();
    production.dispose();
    availability.scene.dispose();
    store.destroyAll();
  }
});
