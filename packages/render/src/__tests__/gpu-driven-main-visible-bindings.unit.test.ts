import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { mat4, vec3 } from '@forgeax/engine-math';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { type BindGroup, err, ok, RhiError } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { deriveMaterialDynamicInputLayout } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { GpuResidencyCache } from '../device/gpu-residency';
import { BatchTopology } from '../gpu-driven/batch-topology';
import { materialBindingKey } from '../gpu-driven/material-bindings';
import { PreparedRasterBundleCache } from '../gpu-driven/prepared-raster-bundle';
import { GpuDrivenProduction } from '../gpu-driven/production-raster';
import { MaterialAbiRasterAdapter } from '../gpu-driven/production-raster-material';
import { GpuDrivenView } from '../gpu-driven/view-gpu';
import { GpuScene } from '../gpu-scene';
import {
  getOpaqueResourceIdentity,
  makeZeroCameraFallbackSnapshot,
} from '../record/frame-snapshot';
import type { RenderPipelineFrame } from '../render-pipeline';
import type { RenderableSnapshot } from '../render-system-extract';
import { RenderScene } from '../scene/render-scene';
import { ReadonlyDynamicInputPage } from '../surface/dynamic-input';
import {
  type SurfacePassName,
  SurfaceSubmissionObservationOwner,
} from '../surface/submission-observation';
import { preparedPbrSnapshot, standardPbrInputs } from './gpu-driven-production-fixture';

const schema = {
  name: 'windowEvents',
  fields: [{ name: 'strength', type: 'f32' as const }],
  maxRecords: 4,
  maxDomains: 1,
  maxPageBytes: 256,
  maxBindings: 1,
  maxEventsPerSample: 1,
};

async function fixture(
  surface = false,
  count = 2,
  instanceCount = 8,
  firstInstanceIndirect = false,
) {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  // Window lifetime regressions exercise the portable path explicitly.
  Object.defineProperty(device, 'caps', { value: { ...device.caps, firstInstanceIndirect } });
  const store = new GpuResidencyCache();
  store.configureGpuDevice(
    device,
    undefined,
    () => {
      throw new Error('unused cubemap');
    },
    device.caps,
  );
  const world = new World();
  const pod = createBoxGeometry(1, 1, 1).unwrap();
  const handles = Array.from({ length: count === 2 ? 1 : count }, () =>
    world.allocSharedRef('MeshAsset', { ...pod }),
  );
  const meshes = handles.map((handle) =>
    store
      .ensureResident(handle, pod, world, [
        {
          ...pod,
          indices: defined(pod.indices).slice(0, 24),
          submeshes: pod.submeshes.map((entry) => ({ ...entry, indexCount: 24 })),
        },
      ])
      .unwrap(),
  );
  const projection = new RenderScene();
  const snapshots = Array.from({ length: count }, (_, index) => {
    const matrix = mat4.identity(mat4.create());
    const transforms = new Float32Array(instanceCount * 16);
    for (let i = 0; i < instanceCount; i++) transforms.set(matrix, i * 16);
    const material = {
      baseColor: vec3.create(1, 1, 1),
      metallic: 0,
      roughness: 1,
      materialHandle: index + 100,
    };
    return preparedPbrSnapshot({
      worldId: 0,
      entityKey: index + 1,
      assetHandle: Number(defined(handles[index] ?? handles[0])),
      transform: { world: matrix },
      localAabb: new Float32Array([-1, -1, -1, 1, 1, 1]),
      material,
      materials: [material],
      materialBindingSources: ['engine-default'],
      instances: { transforms, instanceCount, cacheKey: index + 1, archVersion: 1 },
      lods: [{ mesh: '00000000-0000-7000-8000-000000000001' as never, screenCoverage: 0.5 }],
      gpuDrivenDraws: [
        {
          kind: 'indexed',
          first: 0,
          count: 36,
          baseVertex: 0,
          materialSlot: 0,
          topology: 'triangle-list',
          pipelineClass: 'fixture',
          materialResourceClass: 'fixture',
          lodRanges: [{ first: (index % 2) * 12, count: 12, baseVertex: 0 }],
        },
      ],
    });
  });
  const delta = projection.apply(
    snapshots.map((snapshot) => ({
      kind: 'update' as const,
      worldId: 0,
      entityKey: snapshot.entityKey,
      snapshot,
    })),
  );
  const available = GpuScene.create(device, Math.max(32, count * instanceCount)).unwrap();
  if (available.status !== 'available') throw new Error('Expected Null GPU Scene');
  available.scene.sync(delta).unwrap();
  const topology = new BatchTopology();
  topology.rebuild(projection.slotsSnapshot());
  const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const layout = device.createBindGroupLayout({ entries: [] }).unwrap();
  const group = device.createBindGroup({ layout, entries: [] }).unwrap();
  const programs = standardPbrInputs(device, shader, layout);
  const artifact = defined(programs.standardPbrArtifact);
  const dynamicLayout = deriveMaterialDynamicInputLayout(schema).unwrap();
  const page = (pageId: number) =>
    ReadonlyDynamicInputPage.create({ sourceId: 'main-windows', pageId, schema }).unwrap();
  const production = new GpuDrivenProduction(device, { createShaderModule: () => ok(shader) });
  const input: Parameters<GpuDrivenProduction['prepare']>[0] = {
    ...programs,
    ...(surface
      ? {
          standardPbrArtifact: {
            ...artifact,
            receipt: {
              ...defined(artifact.receipt),
              surface: {
                model: 'single-layer-medium',
                module: 'forgeax::single-layer-medium',
                inputAbi: 'SingleLayerMediumSurfaceInput',
                outputAbi: 'SingleLayerMediumSurfaceData',
                passes: ['nearest-layer', 'color'],
                dynamicInput: {
                  layout: dynamicLayout,
                  group: 3,
                  binding: 3,
                  readOnly: true,
                  accessor: `read_${dynamicLayout.name}`,
                },
              },
            },
          },
          surfaceDynamicInput: { page: page(1), ranges: [], projectionRevision: 1, frameTime: 0 },
        }
      : {}),
    scene: {
      scene: available.scene,
      plan: topology.plan(),
      slots: projection.slotsSnapshot(),
      slotAt: projection.slotAt,
      worldIdentities: ['main-window-world'],
    },
    camera: makeZeroCameraFallbackSnapshot(),
    meshBySlot: new Map(
      projection
        .slotsSnapshot()
        .map((slot, index) => [slot.slot, defined(meshes[index] ?? meshes[0])]),
    ),
    viewBindGroupLayout: layout,
    meshResidencyEpoch: store.meshResidencyEpoch,
  };
  const prepare = (overrides: Partial<typeof input> = {}) =>
    defined(production.prepare({ ...input, ...overrides }).unwrap());
  return {
    device,
    production,
    input,
    prepare,
    projection,
    topology,
    page,
    group,
    delta,
    snapshots,
    publish(rows: readonly RenderableSnapshot[]) {
      const delta = projection.apply(
        rows.map((snapshot) => ({
          kind: 'update' as const,
          worldId: snapshot.worldId,
          entityKey: snapshot.entityKey,
          snapshot,
        })),
      );
      available.scene.sync(delta).unwrap();
      topology.apply(delta);
      return { ...defined(input.scene), plan: topology.plan(), slots: projection.slotsSnapshot() };
    },
    close() {
      production.dispose();
      available.scene.dispose();
      store.destroyAll();
    },
  };
}

/** Real production project/encode through the graph and Null RHI, retaining its graph between frames. */
function recorder(
  f: Awaited<ReturnType<typeof fixture>>,
  initial = f.prepare(),
  late = true,
  preparedBundles = false,
) {
  let current = initial;
  const graph = new RenderGraphBuilder<RenderPipelineFrame>();
  const main = initial
    .project(graph, 'rgba8unorm', 1, undefined, undefined, late, preparedBundles)
    .unwrap();
  const color = graph
    .createTexture('color', { format: 'rgba8unorm', size: { width: 1, height: 1 } })
    .unwrap();
  const colorView = graph.view(color).unwrap();
  if (late) {
    const pyramid = graph
      .createTexture('pyramid', { format: 'r32float', size: { width: 1, height: 1 } })
      .unwrap();
    const pyramidView = graph.view(pyramid).unwrap();
    graph
      .addRasterPass('initialize-pyramid', {
        accesses: [{ resource: pyramidView, usage: 'color-attachment' }],
        colorAttachments: [
          {
            view: pyramidView,
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
          },
        ],
        encode: () => undefined,
      })
      .unwrap();
    defined(main.addLateOcclusion)(pyramidView).unwrap();
  }
  const bindings: BindGroup[] = [];
  graph
    .addRasterPass('main-window-witness', {
      accesses: [...main.accesses, { resource: colorView, usage: 'color-attachment' }],
      colorAttachments: [
        {
          view: colorView,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
      encode: ({ pass, resources }) => {
        const setGroup = pass.setBindGroup.bind(pass);
        vi.spyOn(pass, 'setBindGroup').mockImplementation((index, group, ...rest) => {
          if (index === 3) bindings.push(group);
          setGroup(index, group, ...rest);
        });
        const frameResources = {
          ...current.standardPbrFrameResources,
          ...(preparedBundles
            ? { bundleDescriptor: { colorFormats: ['rgba8unorm' as const] } }
            : {}),
          materialBindGroups: [f.group],
          materialSlotIndicesByEntity: new Map(),
        };
        for (const phase of late ? (['all', 'late'] as const) : (['all'] as const)) {
          for (const entry of [undefined, 'fs_gbuffer', 'fs_temporal']) {
            main.encode(f.group, pass, resources, frameResources, undefined, entry, false, phase);
          }
        }
      },
    })
    .unwrap();
  const compiled = graph
    .compile({ device: f.device, surfaceSize: { width: 1, height: 1 } })
    .unwrap();
  return {
    record(frame = current) {
      current = frame;
      bindings.length = 0;
      const encoder = f.device.createCommandEncoder().unwrap();
      compiled.execute({ encoder } as RenderPipelineFrame).unwrap();
      f.device.queue.submit([encoder.finish().unwrap()]).unwrap();
      frame._commitResourceReplacement();
      return [...bindings];
    },
    close: () => compiled.retire(),
  };
}

function defined<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('Expected fixture value');
  return value;
}

describe('Main GPU-driven prepared visible windows', () => {
  it('observes the physical medium pipeline across raster classes and cache hits', async () => {
    const f = await fixture(true, 3);
    const prepared = f.prepare();
    const graph = new RenderGraphBuilder<RenderPipelineFrame>();
    const gpu = prepared.project(graph, 'rgba8unorm', 1).unwrap();
    const color = graph
      .createTexture('medium-color', { format: 'rgba8unorm', size: { width: 1, height: 1 } })
      .unwrap();
    const view = graph.view(color).unwrap();
    const observations = new SurfaceSubmissionObservationOwner(() => 1);
    const begin = (frameId: number) =>
      observations.begin({
        frameId,
        requestedLane: 'gpu-driven',
        deviceGeneration: 1,
        resourceGeneration: undefined,
      });
    let observation = begin(0);
    const physical = new Map<SurfacePassName, number[]>();
    for (const [surfacePass, entry] of [
      ['nearest-layer', 'fs_nearest_layer'],
      ['color', 'fs_color'],
    ] as const) {
      graph
        .addRasterPass(surfacePass, {
          accesses: [...gpu.accesses, { resource: view, usage: 'color-attachment' }],
          colorAttachments: [
            { view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } },
          ],
          encode: ({ pass, resources }) => {
            let pipelineIdentity = 0;
            const commands: number[] = [];
            const setPipeline = pass.setPipeline.bind(pass);
            pass.setPipeline = (pipeline) => {
              pipelineIdentity = getOpaqueResourceIdentity(pipeline as object);
              setPipeline(pipeline);
            };
            const draw = pass.drawIndexedIndirect.bind(pass);
            pass.drawIndexedIndirect = (buffer, offset) => {
              commands.push(pipelineIdentity);
              draw(buffer, offset);
            };
            gpu.encode(
              f.group,
              pass,
              resources,
              {
                ...prepared.standardPbrFrameResources,
                materialBindGroups: [f.group],
                materialSlotIndicesByEntity: new Map(),
                surfaceSubmissionObservation: observation,
              },
              'single-layer-medium',
              entry,
            );
            physical.set(surfacePass, commands);
          },
        })
        .unwrap();
    }
    const compiled = graph
      .compile({ device: f.device, surfaceSize: { width: 1, height: 1 } })
      .unwrap();
    try {
      let first: Array<readonly number[]> | undefined;
      for (let frame = 1; frame <= 2; frame++) {
        observation = begin(frame);
        const encoder = f.device.createCommandEncoder().unwrap();
        compiled.execute({ encoder } as RenderPipelineFrame).unwrap();
        f.device.queue.submit([encoder.finish().unwrap()]).unwrap();
        const completed = f.device.queue.onSubmittedWorkDone();
        observation.submit(completed, 1);
        await completed;
        const submission = defined(observations.inspect());
        expect(submission.status).toBe('completed');
        expect(submission.passes).toHaveLength(2);
        const current = submission.passes.map((pass) => {
          const identities = pass.commands.map((command) => command.pipelineIdentity);
          expect(identities).toHaveLength(6);
          expect(new Set(physical.get(pass.pass)).size).toBe(1);
          expect(identities).toEqual(physical.get(pass.pass));
          return identities;
        });
        if (first === undefined) first = current;
        else expect(current).toEqual(first);
      }
    } finally {
      await compiled.retire();
      f.close();
    }
  });

  it('shares one physical visible binding across 96 capable batches, LODs and phases', async () => {
    const f = await fixture(false, 96, 64, true);
    const r = recorder(f, f.prepare());
    const lookup = vi.spyOn(MaterialAbiRasterAdapter.prototype, 'visibleWindowBindGroupForBuffer');
    try {
      const first = r.record();
      expect(f.production.inspect().batchCount).toBe(96);
      expect(first.length).toBeGreaterThan(0);
      expect(new Set(first).size).toBe(1);
      lookup.mockClear();
      expect(r.record(f.prepare())).toEqual(first);
      expect(lookup).not.toHaveBeenCalled();
    } finally {
      await r.close();
      f.close();
      lookup.mockRestore();
    }
  });

  it('retains native commands for stable batch resources across repeated graph execution', async () => {
    const f = await fixture(false, 3, 64);
    const initial = f.prepare();
    const r = recorder(f, initial, true, true);
    const create = vi.spyOn(f.device, 'createRenderBundleEncoder');
    const resolve = vi.spyOn(PreparedRasterBundleCache.prototype, 'resolve');
    try {
      r.record();
      const first = resolve.mock.calls.map((call) => call[3].map((binding) => binding.windows));
      expect(first).toHaveLength(6);
      for (let batch = 0; batch < 3; batch += 1) {
        expect(first[1]?.[batch]).toBe(first[0]?.[batch]);
        expect(first[2]?.[batch]).toBe(first[0]?.[batch]);
        expect(first[3]?.[batch]).not.toBe(first[0]?.[batch]);
        expect(first[4]?.[batch]).toBe(first[3]?.[batch]);
        expect(first[5]?.[batch]).toBe(first[3]?.[batch]);
      }
      resolve.mockClear();
      expect(create).toHaveBeenCalledTimes(6);
      expect(f.production.inspect().preparedBundleBuilds).toBe(6);
      create.mockClear();
      r.record(f.prepare());
      expect(create).not.toHaveBeenCalled();
      expect(resolve).toHaveBeenCalledTimes(6);
      for (const [pass, call] of resolve.mock.calls.entries()) {
        for (const [batch, binding] of call[3].entries()) {
          expect(binding.windows).toBe(first[pass]?.[batch]);
        }
      }
      expect(f.production.inspect().preparedBundleHits).toBe(6);
      expect(f.production.inspect().encodedIndirectDraws).toBe(36);
    } finally {
      resolve.mockRestore();
      create.mockRestore();
      await r.close();
      await f.close();
    }
  });

  it('retains native scene-owned sibling assembly after a local topology change', async () => {
    const f = await fixture(false, 3, 8);
    try {
      const snapshots = f.snapshots.map((snapshot) => {
        const { lods: _lods, ...withoutLod } = snapshot;
        const { lodRanges: _ranges, ...draw } = defined(snapshot.gpuDrivenDraws?.[0]);
        return { ...withoutLod, gpuDrivenDraws: [draw] };
      });
      const scene = f.publish(snapshots);
      f.prepare({ scene });
      const before = f.production.inspect();
      const source = defined(snapshots[1]);
      const instances = defined(source.instances);
      const transforms = new Float32Array(9 * 16);
      transforms.set(instances.transforms);
      transforms.set(mat4.identity(mat4.create()), 8 * 16);
      const changed = f.publish([
        { ...source, instances: { ...instances, transforms, instanceCount: 9, archVersion: 2 } },
      ]);
      expect(changed.plan.batches[0]).toBe(scene.plan.batches[0]);
      expect(changed.plan.batches[2]).toBe(scene.plan.batches[2]);
      f.prepare({ scene: changed });
      const after = f.production.inspect();
      // Main and shadow each rebuild one group and retain both native siblings.
      expect(defined(after.filteredAssemblyBuilds) - defined(before.filteredAssemblyBuilds)).toBe(
        2,
      );
      expect(defined(after.filteredAssemblyHits) - defined(before.filteredAssemblyHits)).toBe(4);
    } finally {
      f.close();
    }
  });

  it.each([
    { instanceCount: 63, resolvedWindows: 0, retainedBatches: 96 },
    { instanceCount: 65, resolvedWindows: 4, retainedBatches: 95 },
  ])('reuses unaffected windows after one of 96 batches changes to $instanceCount instances', async ({
    instanceCount,
    resolvedWindows,
    retainedBatches,
  }) => {
    const f = await fixture(false, 96, 64);
    const initial = f.prepare();
    const r = recorder(f, initial);
    const lookup = vi.spyOn(MaterialAbiRasterAdapter.prototype, 'visibleWindowBindGroupForBuffer');
    try {
      const first = r.record();
      expect(f.production.inspect().batchCount).toBe(96);
      expect(new Set(first).size).toBe(96 * 2 * 2);
      const buffer = defined(lookup.mock.calls[0])[0];
      const source = defined(f.snapshots[48]);
      const instances = defined(source.instances);
      const transforms = new Float32Array(instanceCount * 16);
      transforms.set(instances.transforms.subarray(0, instanceCount * 16));
      if (instanceCount > 64) transforms.set(mat4.identity(mat4.create()), 64 * 16);
      const delta = f.projection.apply([
        {
          kind: 'update',
          worldId: 0,
          entityKey: source.entityKey,
          snapshot: {
            ...source,
            instances: {
              ...instances,
              transforms,
              instanceCount,
              archVersion: 2,
            },
          },
        },
      ]);
      defined(f.input.scene).scene.sync(delta).unwrap();
      f.topology.apply(delta);
      const scene = {
        ...defined(f.input.scene),
        plan: f.topology.plan(),
        slots: f.projection.slotsSnapshot(),
      };
      const changed = f.prepare({ scene });
      expect(changed.topologySignature).toBe(initial.topologySignature);
      lookup.mockClear();
      const next = r.record(changed);
      expect(lookup).toHaveBeenCalledTimes(resolvedWindows);
      expect(new Set(next.filter((group) => first.includes(group))).size).toBe(
        retainedBatches * 2 * 2,
      );
      expect(lookup.mock.calls.filter(([, , capacity]) => capacity === 128)).toHaveLength(
        instanceCount === 65 ? 4 : 0,
      );
      expect(lookup.mock.calls.every(([current]) => current === buffer)).toBe(true);
      lookup.mockClear();
      expect(r.record(f.prepare({ scene }))).toEqual(next);
      expect(lookup).not.toHaveBeenCalled();
    } finally {
      lookup.mockRestore();
      await r.close();
      f.close();
    }
  });

  it('resolves each used LOD/phase once across main passes and unchanged prepare/record', async () => {
    const f = await fixture();
    const lookup = vi.spyOn(MaterialAbiRasterAdapter.prototype, 'visibleWindowBindGroupForBuffer');
    const r = recorder(f);
    try {
      const first = r.record();
      expect(first.length).toBeGreaterThan(4);
      expect(lookup).toHaveBeenCalledTimes(new Set(first).size);
      expect(new Set(lookup.mock.calls.map(([, base]) => base)).size).toBe(new Set(first).size);
      lookup.mockClear();
      expect(r.record(f.prepare())).toEqual(first);
      expect(r.record(f.prepare())).toEqual(first);
      expect(lookup).not.toHaveBeenCalled();
    } finally {
      lookup.mockRestore();
      await r.close();
      f.close();
    }
  });

  it('keeps the late phase slot correct when a trailing batch loses one LOD', async () => {
    const f = await fixture(false, 3, 64);
    const initial = f.prepare();
    const r = recorder(f, initial, true, true);
    const lookup = vi.spyOn(MaterialAbiRasterAdapter.prototype, 'visibleWindowBindGroupForBuffer');
    const resolve = vi.spyOn(PreparedRasterBundleCache.prototype, 'resolve');
    let next: ReturnType<typeof recorder> | undefined;
    try {
      r.record();
      const oldWindows = resolve.mock.calls.flatMap((call) => call[3].map((b) => b.windows));
      const oldContents = oldWindows.map((windows) => [...windows]);
      const oldCalls = [...lookup.mock.calls];
      expect(oldCalls).toHaveLength(12);
      const source = defined(f.snapshots[2]);
      const { lods: _lods, ...withoutLod } = source;
      const { lodRanges: _lodRanges, ...draw } = defined(source.gpuDrivenDraws?.[0]);
      const scene = f.publish([{ ...withoutLod, gpuDrivenDraws: [draw] }]);
      const changed = f.prepare({ scene });
      lookup.mockClear();
      next = recorder(f, changed);
      const groups = next.record();
      expect(oldWindows).toEqual(oldContents);
      expect(lookup).toHaveBeenCalledTimes(2);
      expect(new Set(groups).size).toBe(10);
      // The late window must use the late base, never the old level-one slot.
      expect(lookup.mock.calls[0]?.[1]).toBe(oldCalls[4]?.[1]);
      expect(lookup.mock.calls[1]?.[1]).toBe(defined(oldCalls[10])[1]);
      expect(lookup.mock.calls.every(([buffer]) => buffer === oldCalls[0]?.[0])).toBe(true);
      lookup.mockClear();
      expect(next.record(f.prepare({ scene }))).toEqual(groups);
      expect(lookup).not.toHaveBeenCalled();
    } finally {
      resolve.mockRestore();
      lookup.mockRestore();
      await next?.close();
      await r.close();
      f.close();
    }
  });

  it('keeps visible windows private to productions sharing the same scene and device', async () => {
    const f = await fixture(false, 3, 64);
    const shader = (await rhi.createShaderModule(f.device, { code: 'synthetic' })).unwrap();
    const other = new GpuDrivenProduction(f.device, { createShaderModule: () => ok(shader) });
    const prepare = () => defined(other.prepare(f.input).unwrap());
    const r = recorder(f, f.prepare(), true, true);
    const second = recorder({ ...f, production: other, prepare }, prepare(), true, true);
    const resolve = vi.spyOn(PreparedRasterBundleCache.prototype, 'resolve');
    try {
      r.record();
      const first = resolve.mock.calls.flatMap((call) => call[3].map((b) => b.windows));
      resolve.mockClear();
      second.record();
      const next = resolve.mock.calls.flatMap((call) => call[3].map((b) => b.windows));
      expect(next).toHaveLength(first.length);
      const firstGroups = new Set(first.flat());
      for (const windows of next) {
        expect(first).not.toContain(windows);
        expect(windows.every((group) => !firstGroups.has(group))).toBe(true);
      }
      resolve.mockClear();
      r.record(f.prepare());
      const retained = resolve.mock.calls.flatMap((call) => call[3].map((b) => b.windows));
      retained.forEach((windows, index) => {
        expect(windows).toBe(first[index]);
      });
    } finally {
      resolve.mockRestore();
      await second.close();
      await r.close();
      other.dispose();
      f.close();
    }
  });

  it('does not prepare unused late windows', async () => {
    const f = await fixture();
    const lookup = vi.spyOn(MaterialAbiRasterAdapter.prototype, 'visibleWindowBindGroupForBuffer');
    const r = recorder(f, f.prepare(), false);
    try {
      expect(lookup).not.toHaveBeenCalled();
      const first = r.record();
      expect(lookup).toHaveBeenCalledTimes(new Set(first).size);
      lookup.mockClear();
      expect(r.record(f.prepare())).toEqual(first);
      expect(lookup).not.toHaveBeenCalled();
    } finally {
      lookup.mockRestore();
      await r.close();
      f.close();
    }
  });

  it('rebinds ProbeBlend and scene tables while retaining the logical source plan', async () => {
    const f = await fixture();
    const lookup = vi.spyOn(MaterialAbiRasterAdapter.prototype, 'visibleWindowBindGroupForBuffer');
    const created = vi.spyOn(f.device, 'createBindGroup');
    const probe = f.device.createBuffer({ size: 4096, usage: 128 }).unwrap();
    const r = recorder(f);
    let second: ReturnType<typeof recorder> | undefined;
    let scene: GpuScene | undefined;
    try {
      const old = r.record();
      const frame = f.prepare({ probeBlendRecordBuffer: probe });
      lookup.mockClear();
      const next = r.record(frame);
      expect(next.every((group) => !old.includes(group))).toBe(true);
      expect(lookup).toHaveBeenCalledTimes(new Set(next).size);
      for (const group of new Set(next)) {
        const index = created.mock.results.findIndex(
          (result) => result.type === 'return' && result.value.ok && result.value.value === group,
        );
        expect(created.mock.calls[index]?.[0].entries).toContainEqual({
          binding: 1,
          resource: { kind: 'buffer', value: { buffer: probe } },
        });
      }
      const available = GpuScene.create(f.device, 64).unwrap();
      if (available.status !== 'available') throw new Error('Expected replacement scene');
      scene = available.scene;
      scene.sync(f.delta).unwrap();
      const replacement = f.prepare({ scene: { ...defined(f.input.scene), scene } });
      second = recorder(f, replacement);
      const rebound = second.record();
      expect(rebound.every((group) => !next.includes(group))).toBe(true);
      lookup.mockClear();
      expect(second.record(f.prepare({ scene: { ...defined(f.input.scene), scene } }))).toEqual(
        rebound,
      );
      expect(lookup).not.toHaveBeenCalled();
    } finally {
      lookup.mockRestore();
      created.mockRestore();
      await second?.close();
      await r.close();
      f.close();
      scene?.dispose();
      f.device.destroyBuffer(probe);
    }
  });

  it('uses current windows through material split/rejoin while reusing the compiled graph', async () => {
    const f = await fixture();
    const key = materialBindingKey({ worldId: 0, entityKey: 1 }, 100);
    const bindings = new Map([[key, 'separate-probe-binding']]);
    f.prepare({ materialBindingClasses: bindings });
    const merged = f.prepare();
    const r = recorder(f, merged);
    const lookup = vi.spyOn(MaterialAbiRasterAdapter.prototype, 'visibleWindowBindGroupForBuffer');
    try {
      const first = r.record();
      const split = f.prepare({ materialBindingClasses: bindings });
      expect(split.topologySignature).toBe(merged.topologySignature);
      const splitGroups = r.record(split);
      expect(splitGroups.length).toBeGreaterThan(first.length);
      lookup.mockClear();
      expect(r.record(f.prepare({ materialBindingClasses: bindings }))).toEqual(splitGroups);
      expect(lookup).not.toHaveBeenCalled();
      expect(r.record(f.prepare())).toEqual(first);
      lookup.mockClear();
      expect(r.record(f.prepare())).toEqual(first);
      expect(lookup).not.toHaveBeenCalled();
    } finally {
      lookup.mockRestore();
      await r.close();
      f.close();
    }
  });

  it('replaces early and late windows after view-only capacity growth', async () => {
    const f = await fixture();
    const initial = f.prepare();
    const r = recorder(f, initial, true, true);
    const lookup = vi.spyOn(MaterialAbiRasterAdapter.prototype, 'visibleWindowBindGroupForBuffer');
    const resolve = vi.spyOn(PreparedRasterBundleCache.prototype, 'resolve');
    let next: ReturnType<typeof recorder> | undefined;
    try {
      r.record();
      const oldWindows = resolve.mock.calls.flatMap((call) => call[3].map((b) => b.windows));
      const oldContents = oldWindows.map((windows) => [...windows]);
      const first = oldWindows.flat();
      const firstBuffer = defined(lookup.mock.calls[0])[0];
      const instanceBuffer = defined(f.input.scene).scene.instanceBuffer;
      const bindings = new Map([[materialBindingKey({ worldId: 0, entityKey: 1 }, 100), 'split']]);
      const grown = f.prepare({ materialBindingClasses: bindings });
      expect(grown.topologySignature).not.toBe(initial.topologySignature);
      expect(defined(f.input.scene).scene.instanceBuffer).toBe(instanceBuffer);
      lookup.mockClear();
      next = recorder(f, grown);
      const groups = next.record();
      expect(oldWindows).toEqual(oldContents);
      expect(groups.every((group) => !first.includes(group))).toBe(true);
      expect(lookup.mock.calls.every(([buffer]) => buffer !== firstBuffer)).toBe(true);
      expect(lookup).toHaveBeenCalledTimes(new Set(groups).size);
      lookup.mockClear();
      expect(next.record(f.prepare({ materialBindingClasses: bindings }))).toEqual(groups);
      expect(lookup).not.toHaveBeenCalled();
    } finally {
      resolve.mockRestore();
      lookup.mockRestore();
      await next?.close();
      await r.close();
      f.close();
    }
  });

  it('does not retain a failed binding and retries the same physical window after abort', async () => {
    const f = await fixture();
    const r = recorder(f);
    const original = MaterialAbiRasterAdapter.prototype.visibleWindowBindGroupForBuffer;
    const lookup = vi.spyOn(MaterialAbiRasterAdapter.prototype, 'visibleWindowBindGroupForBuffer');
    const submit = vi.spyOn(f.device.queue, 'submit');
    try {
      const failure = new RhiError({
        code: 'rhi-descriptor-invalid',
        expected: 'injected second window failure',
        hint: 'retry the same source window',
      });
      lookup.mockImplementationOnce(original);
      lookup.mockReturnValueOnce(err(failure));
      expect(() => r.record()).toThrow();
      expect(submit).not.toHaveBeenCalled();
      expect(
        lookup.mock.results.some(
          (result) =>
            result.type === 'return' && !result.value.ok && result.value.error === failure,
        ),
      ).toBe(true);
      const firstWindow = lookup.mock.calls[0];
      const frame = f.prepare();
      frame._abortResourceReplacement?.();
      lookup.mockClear();
      const accepted = r.record(f.prepare());
      expect(submit).toHaveBeenCalledOnce();
      expect(accepted.length).toBeGreaterThan(0);
      expect(lookup.mock.calls[0]).toEqual(firstWindow);
      lookup.mockClear();
      expect(r.record(f.prepare())).toEqual(accepted);
      expect(lookup).not.toHaveBeenCalled();
    } finally {
      submit.mockRestore();
      lookup.mockRestore();
      await r.close();
      f.close();
    }
  });

  it('rebinds a replaced Surface page but reuses bindings for content-only writes', async () => {
    const f = await fixture(true);
    const lookup = vi.spyOn(MaterialAbiRasterAdapter.prototype, 'visibleWindowBindGroupForBuffer');
    const r = recorder(f);
    try {
      const initial = r.record();
      const current = defined(f.input.surfaceDynamicInput);
      current.page.writeRecord(0, { strength: 1 }).unwrap();
      lookup.mockClear();
      expect(r.record(f.prepare())).toEqual(initial);
      expect(lookup).not.toHaveBeenCalled();
      const changed = { ...current, page: f.page(2) };
      const replacement = f.prepare({ surfaceDynamicInput: changed });
      const next = r.record(replacement);
      expect(next.every((group) => !initial.includes(group))).toBe(true);
      lookup.mockClear();
      expect(r.record(f.prepare({ surfaceDynamicInput: changed }))).toEqual(next);
      expect(lookup).not.toHaveBeenCalled();
    } finally {
      lookup.mockRestore();
      await r.close();
      f.close();
    }
  });
});

it.each([
  false,
  true,
])('captures actual production command metadata including cached bundles=%s without changing submission', async (bundles) => {
  const f = await fixture(false, 3, 4),
    initial = f.prepare(),
    r = recorder(f, initial, true, bundles);
  const read = vi.spyOn(GpuDrivenView.prototype, 'readGeometryCommands').mockResolvedValue({
    commands: [],
    viewConstants: {
      scope: 'submitted-gpu-cull-view-constants' as const,
      depthPyramid: 'unobserved' as const,
      frustumPlanes: Array(24).fill(0),
      occlusionEnabled: false,
      occlusionHistoryValid: false,
    },
  });
  try {
    // The ordinary fixture never activates the collector.
    r.record();
    expect((await f.production.observeGeometry({ frameId: 17, deviceGeneration: 9 })).status).toBe(
      'unavailable',
    );
    expect(read).not.toHaveBeenCalled();
    f.production.beginGeometryObservation((slot) => ({
      worldIdentity: 'published-world',
      meshGuid: `mesh-${slot.snapshot.assetHandle}`,
      sourceKey: 'scene-cluster',
      sourceRevision: 45,
    }));
    r.record(f.prepare());
    expect((await f.production.observeGeometry({ frameId: 17, deviceGeneration: 9 })).status).toBe(
      'complete',
    );
    const commands = read.mock.calls[0]?.[0];
    expect(commands).toHaveLength(36);
    expect(commands?.some((c) => c.phase === 'late')).toBe(true);
    expect(commands?.some((c) => c.level === 1)).toBe(true);
    const members = commands?.flatMap((c) => [...c.sources.values()]);
    expect(members?.some((m) => m.instanceOrdinal === 3)).toBe(true);
    expect(members?.every((m) => m.sourceRevision === 45 && m.sourceKey === 'scene-cluster')).toBe(
      true,
    );
    const submitted = vi.spyOn(f.device.queue, 'submit');
    f.production.beginGeometryObservation(() => {
      throw Error('controlled attribution failure');
    });
    expect(() => r.record(f.prepare())).not.toThrow();
    expect(submitted).toHaveBeenCalledTimes(1);
    expect(await f.production.observeGeometry({ frameId: 18, deviceGeneration: 9 })).toMatchObject({
      status: 'unavailable',
      reason: 'controlled attribution failure',
    });
    submitted.mockRestore();
  } finally {
    read.mockRestore();
    await r.close();
    f.close();
  }
});
