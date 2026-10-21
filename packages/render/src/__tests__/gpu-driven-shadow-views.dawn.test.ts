import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { frustum, mat4, vec3 } from '@forgeax/engine-math';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { RhiCommandEncoder } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-webgpu';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { GpuResidencyCache } from '../device/gpu-residency';
import { batchLevelStride } from '../gpu-driven/batch-layout';
import { BatchTopology } from '../gpu-driven/batch-topology';
import type { LodViewCamera } from '../gpu-driven/lod-projection.wgsl';
import { GpuDrivenProduction } from '../gpu-driven/production-raster';
import { type ShadowViewIdentity, ShadowViewStatePool } from '../gpu-driven/shadow-views';
import { GPU_DRIVEN_VIEW_WGSL, GpuDrivenView } from '../gpu-driven/view-gpu';
import { GpuScene } from '../gpu-scene';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_MAP_READ } from '../gpu-usage';
import { MaterialResource } from '../material-resource';
import { buildGpuDrivenPbrInstancesBindGroupLayout } from '../pbr-pipeline';
import { worldRenderResources } from '../publication/resource-scope';
import { makeZeroCameraFallbackSnapshot } from '../record/frame-snapshot';
import { ShadowRasterLedger } from '../record/shadow-raster-ledger';
import type { RenderPipelineFrame, RenderPipelineTopology } from '../render-pipeline';
import type { RenderableSnapshot } from '../render-system-extract';
import { RenderScene } from '../scene/render-scene';
import { addTypedShadowPasses } from '../typed-shadow-passes';
import {
  admitGpuFixture,
  preparedPbrSnapshot,
  standardPbrInputs,
} from './gpu-driven-production-fixture';
import { updateGpuView, updateShadowView } from './helpers/gpu-input-read-domain';
import { nativeDeviceFixture } from './native-device-fixture';

const GPU_MAP_MODE_READ = 0x0001;

const material = new MaterialResource({
  passes: [],
  baseColor: vec3.create(1, 1, 1),
  metallic: 0,
  roughness: 1,
});

function snapshot(entityKey: number, assetHandle = 3, x = 0): RenderableSnapshot {
  const world = new Float32Array(mat4.identity(mat4.create()));
  world[12] = x;
  return {
    assetHandle,
    transform: { world },
    localAabb: new Float32Array([-1, -1, -1, 1, 1, 1]),
    material,
    materials: [material],
    materialBindingSources: ['engine-default'],
    worldId: 0,
    entityKey,
    gpuDrivenDraws: [
      {
        kind: 'indexed',
        first: 0,
        count: 36,
        baseVertex: 0,
        materialSlot: 0,
        topology: 'triangle-list',
        pipelineClass: 'opaque',
        materialResourceClass: 'plain',
        geometry: {
          receipt: {
            identity: 'shadow',
            vertexInputs: [],
            topology: 'triangle-list',
            indexed: true,
          },
          draw: { kind: 'indexed', first: 0, count: 36, baseVertex: 0, topology: 'triangle-list' },
          deformation: 'rigid',
        },
      },
    ],
  };
}

function updateSnapshot(value: RenderableSnapshot) {
  return {
    kind: 'update' as const,
    worldId: value.worldId,
    entityKey: value.entityKey,
    snapshot: value,
  };
}

function topology(): RenderPipelineTopology {
  return {
    pipelineId: 'forgeax::standard',
    config: undefined,
    surface: {
      width: 64,
      height: 64,
      storageFormat: 'rgba8unorm',
      viewFormat: 'rgba8unorm',
    },
    camera: { tonemap: 'aces-filmic', antialias: 'fxaa', bloom: 'off', bloomIntensity: 1 },
    shadow: {
      directional: { mapSize: 32, cascadeCount: 2 },
      spotMapSize: 32,
      pointCount: 1,
      pointFaceSize: 16,
      spotCount: 1,
    },
    lane: {
      compute: true,
      storageBuffer: true,
      multisample: false,
      maxColorAttachments: 8,
    },
    featureTopologySignature: 'shadow-view-dawn-test',
    gpuDrivenTopologySignature: 'shadow-view-dawn-test',
  };
}

const identities: readonly ShadowViewIdentity[] = [
  { kind: 'directional', index: 0 },
  { kind: 'point', index: 0, face: 0 },
  { kind: 'spot', index: 0 },
];

describe('GPU-driven shadow views Dawn structural evidence', () => {
  it('shares candidate plans while preserving three independent GPU frusta for 60 submissions', async () => {
    const { device, native } = await nativeDeviceFixture();
    native.pushErrorScope('validation');
    const shader = (await rhi.createShaderModule(device, { code: GPU_DRIVEN_VIEW_WGSL })).unwrap();
    const shaderModuleFactory = { createShaderModule: () => ok(shader) };
    const residency = new GpuResidencyCache();
    residency.configureGpuDevice(device, undefined, device.caps);
    const assets = new AssetRegistry();
    const world = new World({ assets });
    const geometry = createBoxGeometry(2, 2, 2).unwrap();
    const meshHandle = assets.create(geometry).unwrap();
    const mesh = residency
      .ensureResident(meshHandle, geometry, worldRenderResources(world))
      .unwrap();
    const preparedSource = preparedPbrSnapshot(snapshot(0, Number(meshHandle), 0));
    preparedSource.material.adopt({
      ...preparedSource.material.snapshot,
      passes: [
        ...(preparedSource.material.snapshot.passes ?? []),
        {
          name: 'shadow',
          program: { module: 'forgeax::default-standard-pbr' },
          renderState: { tags: { LightMode: 'ShadowCaster' } },
        },
      ],
      materialProgramKeys: {
        forward: 'forgeax::default-standard-pbr',
        shadow: 'forgeax::default-standard-pbr',
      },
    });
    const preparedAt = (entityKey: number, x: number) => ({
      ...preparedSource,
      entityKey,
      transform: snapshot(entityKey, Number(meshHandle), x).transform,
    });
    const viewLayout = device.createBindGroupLayout({ entries: [] }).unwrap();
    const programs = standardPbrInputs(device, shader, viewLayout);
    const state = programs.materialPipelineState;
    if (state === undefined) throw Error('expected prepared material pipeline');
    const instancesLayout = buildGpuDrivenPbrInstancesBindGroupLayout(device, device.caps);
    const materialLayout = device.createBindGroupLayout({ entries: [] }).unwrap();
    const pipelineLayout = device
      .createPipelineLayout({
        bindGroupLayouts: [viewLayout, materialLayout, state.meshBindGroupLayout, instancesLayout],
      })
      .unwrap();
    const productionInputs = {
      ...programs,
      materialPipelineState: {
        ...state,
        pbrPipelineLayout: pipelineLayout,
        gpuDrivenPbrPipelineLayout: pipelineLayout,
        instancesBindGroupLayout: instancesLayout,
        gpuDrivenInstancesBindGroupLayout: instancesLayout,
      },
      camera: makeZeroCameraFallbackSnapshot(),
      viewBindGroupLayout: viewLayout,
    };
    const projection = new RenderScene();
    const available = GpuScene.create(device, 8).unwrap();
    if (available.status !== 'available') throw Error('GPU Scene unavailable');
    const scene = available.scene;
    const source = new BatchTopology();
    const apply = (operations: Parameters<RenderScene['apply']>[0]) => {
      const delta = projection.apply(operations);
      scene.sync(delta, undefined, (slot) => projection.cullingWorldBoundsAt(slot)).unwrap();
      source.apply(delta);
    };
    apply([updateSnapshot(preparedAt(1, -4)), updateSnapshot(preparedAt(2, 4))]);
    const lightView = mat4.lookAt(mat4.create(), [0, 0, 10], [0, 0, 0], [0, 1, 0]);
    const views = [
      [-6, -2],
      [2, 6],
      [-6, 6],
    ].map(([left = -6, right = 6], index) => {
      const matrix = mat4.multiply(
        mat4.create(),
        mat4.orthographic(mat4.create(), left, right, -2, 2, 0.1, 100),
        lightView,
      );
      return {
        identity: { kind: 'directional' as const, index, layer: 'static' as const },
        matrix,
        planes: frustum.fromViewProjection(frustum.create(), matrix),
        candidatePrimitiveIndices: [0, 1],
      };
    });
    let production = new GpuDrivenProduction(device, shaderModuleFactory);
    const readback = device
      .createBuffer({
        size: 192,
        usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
      })
      .unwrap();
    try {
      for (let frame = 0; frame < 60; frame++) {
        if (frame === 30) {
          apply([{ kind: 'remove', worldId: 0, entityKey: 2 }, updateSnapshot(preparedAt(3, 4))]);
        }
        if (frame === 45) {
          production.dispose();
          production = new GpuDrivenProduction(device, shaderModuleFactory);
        }
        const slots = projection.slotsSnapshot();
        const preparationInput = admitGpuFixture({
          ...productionInputs,
          shadowViews: true,
          scene: {
            scene,
            plan: source.query(source.sourcePlan(), undefined),
            slots,
            slotAt: projection.slotAt,
          },
          meshBySlot: new Map(slots.map((slot) => [slot.slot, mesh])),
        });
        let prepared = production.prepare(preparationInput).unwrap();
        if (prepared === undefined || prepared.shadowViewPool === undefined)
          throw Error('expected admitted production shadow owner');
        let pool = prepared.shadowViewPool;
        pool.invalidate('view-clipping-changed');
        const update = () => {
          if (prepared?.updateShadowViews === undefined) throw Error('expected shadow projection');
          prepared.updateShadowViews(views).unwrap();
          return views.map(({ identity }) => {
            const submitted = pool.submission(identity);
            if (submitted === undefined) throw Error('expected projected production shadow view');
            return submitted;
          });
        };
        let current = update();
        if (frame === 20) {
          const aborted = current[0]?.plan;
          if (prepared._abortResourceReplacement === undefined)
            throw Error('expected production submission abort');
          prepared._abortResourceReplacement();
          prepared = production.prepare(preparationInput).unwrap();
          if (prepared?.shadowViewPool === undefined) throw Error('expected retry preparation');
          pool = prepared.shadowViewPool;
          current = update();
          expect(current[0]?.plan).not.toBe(aborted);
        }
        expect(new Set(current.map((view) => view.plan)).size).toBe(1);
        expect(new Set(current.map((view) => view.view.visibleBuffer)).size).toBe(3);
        const graph = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
        for (const view of views) pool.project(graph, view.identity).unwrap();
        const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
        const encoder = device.createCommandEncoder().unwrap();
        compiled.execute({ encoder }).unwrap();
        for (const [index, { view }] of current.entries()) {
          const indirect = view.indirectBuffer;
          const visible = view.visibleBuffer;
          if (indirect === undefined || visible === undefined) throw Error('view outputs missing');
          encoder.copyBufferToBuffer(indirect, 0, readback, index * 64, 20);
          encoder.copyBufferToBuffer(visible, 0, readback, index * 64 + 32, 32);
        }
        prepared._sealResourceReads().unwrap();
        device.queue.submit([encoder.finish().unwrap()]).unwrap();
        const completed = device.queue.onSubmittedWorkDone();
        prepared._trackSubmittedWork(completed);
        await completed;
        prepared._commitResourceReplacement();
        const mapped = (await readback.mapAsync(GPU_MAP_MODE_READ)).unwrap();
        const words = new Uint32Array(mapped.getMappedRange().unwrap());
        try {
          for (let index = 0; index < 3; index++) {
            const slots = index === 0 ? [0] : index === 1 ? [1] : [0, 1];
            expect([...words.subarray(index * 16, index * 16 + 5)]).toEqual([
              36,
              slots.length,
              0,
              0,
              0,
            ]);
            const instances = slots.map((_, offset) => words[index * 16 + 8 + offset * 4]);
            expect(instances.sort()).toEqual(
              slots.map((slot) => scene.instanceIndexForSlot(slot, 0)).sort(),
            );
          }
        } finally {
          mapped.unmap();
        }
        (await compiled.retire()).unwrap();
      }
      expect(await native.popErrorScope()).toBeNull();
    } finally {
      device.destroyBuffer(readback).unwrap();
      production.dispose();
      scene.dispose();
      residency.destroyAll();
    }
  });

  it('observes shadow cull counters for 60 submissions without decoding visible members', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const shader = (await rhi.createShaderModule(device, { code: GPU_DRIVEN_VIEW_WGSL })).unwrap();
    const shaderModuleFactory = { createShaderModule: () => ok(shader) };
    const projection = new RenderScene();
    const small = (entityKey: number) => ({
      ...snapshot(entityKey),
      localAabb: new Float32Array([-0.001, -0.001, -0.001, 0.001, 0.001, 0.001]),
    });
    const available = GpuScene.create(device, 4).unwrap();
    if (available.status !== 'available') throw new Error('GPU Scene unavailable');
    const scene = available.scene;
    scene.sync(projection.apply([updateSnapshot(snapshot(1)), updateSnapshot(small(2))])).unwrap();
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    const identity: ShadowViewIdentity = { kind: 'directional', index: 0, layer: 'static' };
    const matrix = mat4.identity(mat4.create());
    const planes = frustum.fromViewProjection(frustum.create(), matrix);
    let pool = ShadowViewStatePool.create({ device, shaderModuleFactory }).unwrap();
    const fullSelections = vi.spyOn(GpuDrivenView.prototype, 'readLodSelection');
    // Upload legitimately resolves instance rows. Only the post-submit
    // observation is forbidden from walking them for two batch counters.
    const instanceRows = vi.spyOn(scene, 'instanceIndexForSlot');
    const observe = () =>
      vi.spyOn(
        pool as unknown as { observeCulling(key: string, record: unknown): Promise<void> },
        'observeCulling',
      );
    let observations = observe();
    let observedInstanceLookups = 0;
    try {
      for (let frame = 0; frame < 60; frame += 1) {
        if (frame === 30) {
          scene.sync(projection.apply([updateSnapshot(small(3))])).unwrap();
          topology.rebuild(projection.slotsSnapshot());
        }
        if (frame === 45) {
          observations.mockRestore();
          pool.dispose();
          pool = ShadowViewStatePool.create({ device, shaderModuleFactory }).unwrap();
          observations = observe();
        }
        pool.invalidate('view-clipping-changed');
        const input = {
          identity,
          sourcePlan: topology.query(topology.sourcePlan(), undefined),
          scene,
          planes,
          matrix,
          targetSize: 32,
        };
        updateShadowView(pool, input).unwrap();
        if (frame === 20) {
          pool._abortResourceReplacement();
          updateShadowView(pool, input).unwrap();
        }
        const graph = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
        pool.project(graph, identity).unwrap();
        const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
        const encoder = device.createCommandEncoder().unwrap();
        compiled.execute({ encoder }).unwrap();
        device.queue.submit([encoder.finish().unwrap()]).unwrap();
        await device.queue.onSubmittedWorkDone();
        instanceRows.mockClear();
        observations.mockClear();
        pool._commitResourceReplacement();
        expect(observations).toHaveBeenCalledTimes(1);
        await observations.mock.results[0]?.value;
        expect(pool.texelCulled(identity)).toBe(frame < 30 ? 1 : 2);
        observedInstanceLookups += instanceRows.mock.calls.length;
        (await compiled.retire()).unwrap();
      }
      expect(fullSelections).not.toHaveBeenCalled();
      expect(observedInstanceLookups).toBe(0);
    } finally {
      observations.mockRestore();
      fullSelections.mockRestore();
      instanceRows.mockRestore();
      pool.dispose();
      scene.dispose();
    }
  });

  it.each([
    0, 1,
  ])('retains initialized spot depth through 60 completed frames with spotCount=%s', async (spotCount) => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const graph = new RenderGraphBuilder<RenderPipelineFrame>();
    const base = topology();
    const input = {
      ...base,
      shadow: { ...base.shadow, directional: 'disabled' as const, pointCount: 0, spotCount },
    };
    const targets = addTypedShadowPasses(graph, input).unwrap();
    // Keep the original 32x32/60-frame depth readback for real shadow demand,
    // plus every texel of the one-texel no-shadow target.
    const spotSize = spotCount === 0 ? 1 : input.shadow.spotMapSize;
    const bytes = spotSize * 256;
    const readback = device
      .createBuffer({ size: bytes, usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST })
      .unwrap();
    const output = graph
      .importBuffer(
        'empty-spot-readback',
        { size: bytes, usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST },
        () => readback,
      )
      .unwrap();
    graph
      .addCopyPass('empty-spot-depth-readback', {
        accesses: [
          { resource: targets.spot.view, usage: 'copy-src' },
          { resource: output, usage: 'copy-dst' },
        ],
        encode: ({ encoder, resources }) =>
          encoder.copyTextureToBuffer(
            { texture: resources.texture(targets.spot.texture).unwrap() },
            {
              buffer: resources.buffer(output).unwrap(),
              bytesPerRow: 256,
              rowsPerImage: spotSize,
            },
            { width: spotSize, height: spotSize, depthOrArrayLayers: 1 },
          ),
      })
      .unwrap();
    const compiled = graph.compile({ device, surfaceSize: { width: 64, height: 64 } }).unwrap();
    let rasterPasses = 0;
    const shadowRaster = new ShadowRasterLedger();
    for (let frameId = 0; frameId < 60; frameId++) {
      const encoder = device.createCommandEncoder().unwrap();
      const begin = vi.spyOn(encoder, 'beginRenderPass');
      shadowRaster.begin();
      compiled
        .execute({
          encoder,
          frameState: { spotShadowSnapshots: [], shadowRaster },
        } as unknown as RenderPipelineFrame)
        .unwrap();
      rasterPasses += begin.mock.calls.length;
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      shadowRaster.commit();
      await device.queue.onSubmittedWorkDone();
      const mapped = (await readback.mapAsync(GPU_MAP_MODE_READ)).unwrap();
      const depth = new Float32Array(mapped.getMappedRange().unwrap().slice(0));
      mapped.unmap();
      for (let row = 0; row < spotSize; row++)
        expect(depth.subarray(row * 64, row * 64 + spotSize).every((value) => value === 0)).toBe(
          true,
        );
    }
    expect(rasterPasses).toBe(spotCount === 0 ? 1 : 60);
    (await compiled.retire()).unwrap();
    device.destroyBuffer(readback).unwrap();
  });

  it('selects each LOD level on the GPU from the view camera without reuploading topology', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const shader = (await rhi.createShaderModule(device, { code: GPU_DRIVEN_VIEW_WGSL })).unwrap();
    const projection = new RenderScene();
    const delta = projection.apply([updateSnapshot(snapshot(1))]);
    const availability = GpuScene.create(device, 1).unwrap();
    if (availability.status !== 'available') throw new Error('GPU Scene unavailable');
    availability.scene.sync(delta).unwrap();
    const topologyOwner = new BatchTopology();
    topologyOwner.rebuild(projection.slotsSnapshot());
    const source = topologyOwner.query(topologyOwner.sourcePlan(), undefined);
    const plan = {
      ...source,
      batches: source.batches.map((batch) => ({
        ...batch,
        lod: { coverages: [0, 0.5], ranges: [{ first: 7, count: 12, baseVertex: 0 }] },
      })),
    };
    const view = GpuDrivenView.create({
      device,
      shaderModuleFactory: { createShaderModule: () => ok(shader) },
    }).unwrap();
    const planes = frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create()));
    const readback = device
      .createBuffer({
        size: 40,
        usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
      })
      .unwrap();
    // Orthographic projected height is 2 * |half extent| / (top - bottom);
    // the unit-cube bounds give 2 * sqrt(3) / span.
    const renderAt = async (height: number) => {
      const span = (2 * Math.sqrt(3)) / height;
      const lodCamera = {
        position: new Float32Array([0, 0, 5]),
        projection: 'orthographic',
        fov: 0,
        orthoTop: span / 2,
        orthoBottom: -span / 2,
      } as unknown as LodViewCamera;
      updateGpuView(view, plan, availability.scene, planes, lodCamera).unwrap();
      const graph = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
      view.addPasses(graph).unwrap();
      const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
      const encoder = device.createCommandEncoder().unwrap();
      compiled.execute({ encoder }).unwrap();
      const indirect = view.indirectBuffer;
      if (indirect === undefined) throw new Error('indirect buffer missing');
      encoder.copyBufferToBuffer(indirect, 0, readback, 0, 40);
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      await device.queue.onSubmittedWorkDone();
      view._commitResourceReplacement();
      const mapped = (await readback.mapAsync(GPU_MAP_MODE_READ)).unwrap();
      const words = new Uint32Array(mapped.getMappedRange().unwrap().slice(0));
      mapped.unmap();
      return Array.from(words);
    };

    // One indirect command per level; the unselected level draws nothing.
    expect(await renderAt(0.6)).toEqual([36, 1, 0, 0, 0, 12, 0, 7, 0, 0]);
    expect(await renderAt(0.4)).toEqual([36, 0, 0, 0, 0, 12, 1, 7, 0, 0]);
    expect(view.inspect()).toMatchObject({
      sharedInputUploadBytes: 0,
      batchUploadBytes: 0,
    });

    device.destroyBuffer(readback);
    view.dispose();
    availability.scene.dispose();
  });

  it('emits a crossfade pair into both level segments with opposite signed coverage', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const shader = (await rhi.createShaderModule(device, { code: GPU_DRIVEN_VIEW_WGSL })).unwrap();
    const projection = new RenderScene();
    const delta = projection.apply([updateSnapshot(snapshot(1))]);
    const availability = GpuScene.create(device, 1).unwrap();
    if (availability.status !== 'available') throw new Error('GPU Scene unavailable');
    availability.scene.sync(delta).unwrap();
    const topologyOwner = new BatchTopology();
    topologyOwner.rebuild(projection.slotsSnapshot());
    const source = topologyOwner.query(topologyOwner.sourcePlan(), undefined);
    const plan = {
      ...source,
      batches: source.batches.map((batch) => ({
        ...batch,
        lod: {
          coverages: [1, 0.5],
          hysteresis: 0.08,
          crossfade: true,
          ranges: [{ first: 7, count: 12, baseVertex: 0 }],
        },
      })),
    };
    const batch = plan.batches.at(0);
    if (batch === undefined) throw new Error('missing LOD batch');
    const view = GpuDrivenView.create({
      device,
      shaderModuleFactory: { createShaderModule: () => ok(shader) },
    }).unwrap();
    const planes = frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create()));
    const indirectReadback = device
      .createBuffer({ size: 40, usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST })
      .unwrap();
    const visibleReadback = device
      .createBuffer({ size: 32, usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST })
      .unwrap();
    const renderAt = async (height: number) => {
      const span = (2 * Math.sqrt(3)) / height;
      const lodCamera = {
        position: new Float32Array([0, 0, 5]),
        projection: 'orthographic',
        fov: 0,
        orthoTop: span / 2,
        orthoBottom: -span / 2,
      } as unknown as LodViewCamera;
      updateGpuView(view, plan, availability.scene, planes, lodCamera).unwrap();
      const graph = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
      view.addPasses(graph).unwrap();
      const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
      const encoder = device.createCommandEncoder().unwrap();
      compiled.execute({ encoder }).unwrap();
      const indirect = view.indirectBuffer;
      const visible = view.visibleBuffer;
      if (indirect === undefined || visible === undefined) throw new Error('outputs missing');
      encoder.copyBufferToBuffer(indirect, 0, indirectReadback, 0, 40);
      const levelBytes = batchLevelStride(batch) * 16;
      encoder.copyBufferToBuffer(visible, batch.visibleBase * 16, visibleReadback, 0, 16);
      encoder.copyBufferToBuffer(
        visible,
        batch.visibleBase * 16 + levelBytes,
        visibleReadback,
        16,
        16,
      );
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      await device.queue.onSubmittedWorkDone();
      view._commitResourceReplacement();
      const args = (await indirectReadback.mapAsync(GPU_MAP_MODE_READ)).unwrap();
      const words = Array.from(new Uint32Array(args.getMappedRange().unwrap().slice(0)));
      args.unmap();
      const items = (await visibleReadback.mapAsync(GPU_MAP_MODE_READ)).unwrap();
      const fades = new Float32Array(items.getMappedRange().unwrap().slice(0));
      items.unmap();
      return { instances: [words[1], words[6]], fades: [fades[3], fades[7]] };
    };

    // Exactly on the boundary both levels draw, with complementary +t / -t.
    const paired = await renderAt(0.5);
    expect(paired.instances).toEqual([1, 1]);
    expect(paired.fades[0]).toBeCloseTo(0.5, 5);
    expect(paired.fades[1]).toBe(-(paired.fades[0] ?? Number.NaN));
    // Falsifier: outside the band exactly one level draws at full coverage.
    const hard = await renderAt(0.9);
    expect(hard.instances).toEqual([1, 0]);
    expect(hard.fades[0]).toBe(0);
    expect(view.inspect()).toMatchObject({ sharedInputUploadBytes: 0, batchUploadBytes: 0 });
    device.destroyBuffer(indirectReadback).unwrap();
    device.destroyBuffer(visibleReadback).unwrap();
    view.dispose();
    availability.scene.dispose();
  });

  it('keeps all shadow attachments depth-write owned by the typed graph', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const graph = new RenderGraphBuilder<RenderPipelineFrame>();
    const added = addTypedShadowPasses(graph, topology());
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    const compiled = graph.compile({ device, surfaceSize: { width: 64, height: 64 } }).unwrap();
    const shadowPasses = compiled
      .inspect()
      .passes.filter(
        (pass) =>
          pass.name.startsWith('shadowCascade') ||
          pass.name.startsWith('point-shadow-') ||
          pass.name.startsWith('spot-shadow-'),
      );
    expect(shadowPasses).toHaveLength(9);
    expect(
      shadowPasses.every((pass) =>
        pass.accesses.some((access) => access.usage === 'depth-stencil-write'),
      ),
    ).toBe(true);
  });

  it('executes three view-local culls and reads one indirect result per view', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const shader = (
      await rhi.createShaderModule(device, {
        code: GPU_DRIVEN_VIEW_WGSL,
        label: 'gpu-driven-shadow-views-dawn',
      })
    ).unwrap();
    const projection = new RenderScene();
    const delta = projection.apply([
      updateSnapshot(snapshot(1, 3, -0.5)),
      updateSnapshot(snapshot(2, 4, 0.5)),
    ]);
    const sceneAvailability = GpuScene.create(device, 2).unwrap();
    expect(sceneAvailability.status).toBe('available');
    if (sceneAvailability.status !== 'available') return;
    sceneAvailability.scene.sync(delta).unwrap();
    const topologyOwner = new BatchTopology();
    topologyOwner.rebuild(projection.slotsSnapshot());
    const planes = frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create()));
    const pool = ShadowViewStatePool.create({
      device,
      shaderModuleFactory: { createShaderModule: () => ok(shader) },
    }).unwrap();
    const inputs = identities.map((identity) => ({
      identity,
      sourcePlan: topologyOwner.query(topologyOwner.sourcePlan(), undefined),
      scene: sceneAvailability.scene,
      planes,
      candidatePrimitiveIndices: [0, 1],
    }));
    for (const input of inputs) {
      const update = updateShadowView(pool, input, input.sourcePlan).unwrap();
      expect(update.cache).toBe('invalidated');
      expect(update.plan.candidateCount).toBe(2);
      expect(update.plan.batches).toHaveLength(2);
    }

    const graph = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
    const projections = identities.map((identity) => pool.project(graph, identity).unwrap());
    const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
    const passNames = compiled.inspect().passes.map((pass) => pass.name);
    expect(passNames).toEqual(
      identities.flatMap((identity) => {
        const prefix =
          identity.kind === 'directional'
            ? `gpu-driven.shadow.directional-cascade-${identity.index}`
            : identity.kind === 'point'
              ? `gpu-driven.shadow.point-cube-face-${identity.index}-${identity.face}`
              : `gpu-driven.shadow.spot-atlas-${identity.index}`;
        return [
          `${prefix}.view-reset`,
          `${prefix}.frustum-compact`,
          `${prefix}.finalize-indirect`,
          `${prefix}.lod-selection-readback`,
        ];
      }),
    );

    const readbacks = projections.map((projection, index) => {
      const view = projection.view;
      const visible = view.visibleBuffer;
      const indirect = view.indirectBuffer;
      const overflow = view.overflowBuffer;
      if (visible === undefined || indirect === undefined || overflow === undefined) {
        throw new Error(`shadow view ${index} has no GPU output buffers`);
      }
      return {
        view,
        visible,
        indirect,
        overflow,
        visibleReadback: device
          .createBuffer({
            label: `shadow-view-${index}-visible-readback`,
            size: 1040,
            usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
          })
          .unwrap(),
        indirectReadback: device
          .createBuffer({
            label: `shadow-view-${index}-indirect-readback`,
            size: 40,
            usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
          })
          .unwrap(),
        overflowReadback: device
          .createBuffer({
            label: `shadow-view-${index}-overflow-readback`,
            size: 4,
            usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
          })
          .unwrap(),
      };
    });
    const uploadsBeforeObservation = sceneAvailability.scene.inputs.uploadBytes;
    const materialReads = sceneAvailability.scene.inputs.capture();
    const materialInputBuffer = materialReads.buffer().unwrap().buffer;
    expect(sceneAvailability.scene.inputs.uploadBytes).toBe(uploadsBeforeObservation);
    materialReads.seal().unwrap();
    const encoder = device.createCommandEncoder({ label: 'gpu-driven-shadow-views-dawn' }).unwrap();
    compiled.execute({ encoder }).unwrap();
    const materialsReadback = device
      .createBuffer({ size: 8, usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST })
      .unwrap();
    for (let slot = 0; slot < 2; slot++) {
      const descriptor = sceneAvailability.scene.materialIndexForSlot(slot, 0);
      if (descriptor === undefined) throw new Error('Missing scene material descriptor');
      encoder.copyBufferToBuffer(
        materialInputBuffer,
        descriptor * 4,
        materialsReadback,
        slot * 4,
        4,
      );
    }
    for (const readback of readbacks) {
      encoder.copyBufferToBuffer(readback.visible, 0, readback.visibleReadback, 0, 1040);
      encoder.copyBufferToBuffer(readback.indirect, 0, readback.indirectReadback, 0, 40);
      encoder.copyBufferToBuffer(
        readback.overflow,
        readback.view.overflowByteOffset,
        readback.overflowReadback,
        0,
        4,
      );
    }
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    await device.queue.onSubmittedWorkDone();
    materialReads.release();
    pool._commitResourceReplacement();

    const materialMap = (await materialsReadback.mapAsync(GPU_MAP_MODE_READ)).unwrap();
    const materialRows = new Uint32Array(materialMap.getMappedRange().unwrap().slice(0));
    materialMap.unmap();
    device.destroyBuffer(materialsReadback);
    for (const readback of readbacks) {
      const visibleMap = (await readback.visibleReadback.mapAsync(GPU_MAP_MODE_READ)).unwrap();
      const visible = new Uint32Array(visibleMap.getMappedRange().unwrap().slice(0));
      visibleMap.unmap();
      const indirectMap = (await readback.indirectReadback.mapAsync(GPU_MAP_MODE_READ)).unwrap();
      const indirect = new Uint32Array(indirectMap.getMappedRange().unwrap().slice(0));
      indirectMap.unmap();
      const overflowMap = (await readback.overflowReadback.mapAsync(GPU_MAP_MODE_READ)).unwrap();
      const overflow = new Uint32Array(overflowMap.getMappedRange().unwrap().slice(0));
      overflowMap.unmap();
      // Visible items address the shared GPU Scene tables directly:
      // (instance row, material row, candidate row for unskinned draws,
      // LOD fade bits).
      const scene = sceneAvailability.scene;
      expect(Array.from(visible.slice(0, 4))).toEqual([
        scene.instanceIndexForSlot(0, 0),
        materialRows[0],
        0,
        0,
      ]);
      expect(Array.from(visible.slice(256, 260))).toEqual([
        scene.instanceIndexForSlot(1, 0),
        materialRows[1],
        1,
        0,
      ]);
      expect(scene.instanceIndexForSlot(1, 0)).not.toBe(scene.instanceIndexForSlot(0, 0));
      expect(Array.from(indirect)).toEqual([36, 1, 0, 0, 0, 36, 1, 0, 0, 0]);
      expect(Array.from(overflow)).toEqual([0]);
      device.destroyBuffer(readback.visibleReadback);
      device.destroyBuffer(readback.indirectReadback);
      device.destroyBuffer(readback.overflowReadback);
    }

    for (const input of inputs)
      expect(updateShadowView(pool, input, input.sourcePlan).unwrap().cache).toBe('hit');

    const hitGraph = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
    for (const identity of identities)
      expect(pool.project(hitGraph, identity).unwrap().passNames).toEqual([]);
    expect(
      hitGraph
        .compile({ device, surfaceSize: { width: 1, height: 1 } })
        .unwrap()
        .inspect().passes,
    ).toHaveLength(0);

    const pointIdentity = identities[1];
    const pointInput = inputs[1];
    if (pointIdentity === undefined || pointInput === undefined) {
      throw new Error('point shadow input missing');
    }
    pool.invalidate('skin-palette-changed', pointIdentity);
    expect(updateShadowView(pool, pointInput, pointInput.sourcePlan).unwrap().cache).toBe(
      'invalidated',
    );
    const invalidatedGraph = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
    const directionalIdentity = identities[0];
    const spotIdentity = identities[2];
    if (directionalIdentity === undefined || spotIdentity === undefined) {
      throw new Error('shadow identities missing');
    }
    expect(pool.project(invalidatedGraph, directionalIdentity).unwrap().passNames).toEqual([]);
    expect(pool.project(invalidatedGraph, pointIdentity).unwrap().passNames).toHaveLength(3);
    expect(pool.project(invalidatedGraph, spotIdentity).unwrap().passNames).toEqual([]);
    expect(
      invalidatedGraph
        .compile({ device, surfaceSize: { width: 1, height: 1 } })
        .unwrap()
        .inspect().passes,
    ).toHaveLength(4);

    const publishEncoder = device.createCommandEncoder().unwrap();
    compiled.execute({ encoder: publishEncoder }).unwrap();
    device.queue.submit([publishEncoder.finish().unwrap()]).unwrap();
    await device.queue.onSubmittedWorkDone();
    pool._commitResourceReplacement();

    // Moving casters and the light changes culling/depth, but not candidate
    // addresses. Exercise the retained plan on the real GPU for 60 submissions.
    const retainedPlans = inputs.map((input) => pool.submission(input.identity)?.plan);
    const countReadbacks = inputs.map(() =>
      device
        .createBuffer({
          size: 40,
          usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
        })
        .unwrap(),
    );
    const matrix = mat4.identity(mat4.create());
    for (let frame = 0; frame < 60; frame += 1) {
      const outside = frame % 2 === 0;
      const moved = projection.apply([updateSnapshot(snapshot(1, 3, outside ? 4 : -0.5))]);
      sceneAvailability.scene.sync(moved).unwrap();
      topologyOwner.apply(moved);
      matrix[12] = frame % 2 === 0 ? 0.125 : 0;
      const movedPlanes = frustum.fromViewProjection(frustum.create(), matrix);
      for (const [index, input] of inputs.entries()) {
        const sourcePlan = topologyOwner.query(topologyOwner.sourcePlan(), undefined);
        const update = updateShadowView(
          pool,
          { ...input, sourcePlan, matrix, planes: movedPlanes },
          sourcePlan,
        ).unwrap();
        expect(update.cache).toBe('invalidated');
        expect(update.plan).toBe(retainedPlans[index]);
        expect(update.view.inspect()).toMatchObject({
          sharedInputUploadBytes: 0,
          batchUploadBytes: 0,
        });
      }
      const movedEncoder = device.createCommandEncoder().unwrap();
      compiled.execute({ encoder: movedEncoder }).unwrap();
      for (const [index, readback] of readbacks.entries()) {
        const target = countReadbacks[index];
        if (target === undefined) throw new Error('expected count readback');
        movedEncoder.copyBufferToBuffer(readback.indirect, 0, target, 0, 40);
      }
      device.queue.submit([movedEncoder.finish().unwrap()]).unwrap();
      await device.queue.onSubmittedWorkDone();
      pool._commitResourceReplacement();
      for (const target of countReadbacks) {
        const mapped = (await target.mapAsync(GPU_MAP_MODE_READ)).unwrap();
        const counts = new Uint32Array(mapped.getMappedRange().unwrap().slice(0));
        mapped.unmap();
        expect(Array.from(counts)).toEqual([36, outside ? 0 : 1, 0, 0, 0, 36, 1, 0, 0, 0]);
      }
    }
    for (const target of countReadbacks) device.destroyBuffer(target);
    pool.dispose();
    sceneAvailability.scene.dispose();
  });
});
