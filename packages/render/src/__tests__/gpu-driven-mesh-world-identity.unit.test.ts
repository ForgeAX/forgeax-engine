import { World } from '@forgeax/engine-ecs';
import { deriveVertexLayoutProjection } from '@forgeax/engine-geometry';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { type RhiNullDevice, rhi } from '@forgeax/engine-rhi-null';
import { type MeshAsset, ok } from '@forgeax/engine-types';
import { assert, describe, expect, it, vi } from 'vitest';
import { GpuResidencyCache, type MeshGpuHandles } from '../device/gpu-residency';
import {
  BatchTopology,
  type GpuDrivenBatchBinding,
  type SubmissionPlan,
} from '../gpu-driven/batch-topology';
import {
  collectGpuDrivenMaterialArtifacts,
  GpuDrivenMaterialProgramProjection,
} from '../gpu-driven/material-artifacts';
import { GpuDrivenProduction } from '../gpu-driven/production-raster';
import { GpuBuffer } from '../gpu-resource';
import { GpuScene } from '../gpu-scene';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_INDEX,
  GPU_BUFFER_USAGE_VERTEX,
} from '../gpu-usage';
import type { RenderResourceScope } from '../publication/resource-scope';
import { worldRenderResources } from '../publication/resource-scope';
import { makeZeroCameraFallbackSnapshot } from '../record/frame-snapshot';
import type { RenderSystemInternals } from '../record/render-context';
import { gpuDrivenMeshesForFrame } from '../record/resident-meshes';
import type { RenderPipelineFrame } from '../render-pipeline';
import type { RenderableSnapshot } from '../render-system-extract';
import { MaterialDispatch } from '../scene/material-dispatch';
import { type PersistentGpuDrivenState, RenderScene } from '../scene/render-scene';
import {
  admitGpuFixture,
  snapshot as gpuSnapshot,
  preparedPbrSnapshot,
  standardPbrInputs,
} from './gpu-driven-production-fixture';

function bindingAt(plan: SubmissionPlan, index = 0): GpuDrivenBatchBinding {
  const binding = plan.batches.at(index)?.binding;
  assert(binding);
  return binding;
}

function snapshot(worldId: number, entityKey: number, assetHandle: number): RenderableSnapshot {
  return { ...gpuSnapshot(entityKey, assetHandle), worldId };
}

function updateSnapshot(value: RenderableSnapshot) {
  return {
    kind: 'update' as const,
    worldId: value.worldId,
    entityKey: value.entityKey,
    snapshot: value,
  };
}

function mesh(device: RhiNullDevice, indexCount: number): MeshGpuHandles {
  const vertex = device
    .createBuffer({
      size: 144,
      usage: GPU_BUFFER_USAGE_VERTEX | GPU_BUFFER_USAGE_COPY_DST,
    })
    .unwrap();
  const index = device
    .createBuffer({
      size: Math.max(8, indexCount * 2),
      usage: GPU_BUFFER_USAGE_INDEX | GPU_BUFFER_USAGE_COPY_DST,
    })
    .unwrap();
  return {
    vertexBuffer: new GpuBuffer(device, vertex),
    indexBuffer: new GpuBuffer(device, index),
    contentEpoch: 0,
    vboBytes: 144,
    iboBytes: Math.max(8, indexCount * 2),
    indexCount,
    indexFormat: 'uint16',
    layoutProjection: deriveVertexLayoutProjection({
      position: new Float32Array(9),
      normal: new Float32Array(9),
      uv: new Float32Array(6),
      tangent: new Float32Array(12),
    }),
    uvSetCount: 1,
    vertexCount: 3,
    indexed: true,
    topology: 'triangle-list',
    submeshes: [
      {
        indexOffset: 0,
        indexCount,
        vertexCount: 3,
        materialSlot: 0,
        topology: 'triangle-list',
      },
    ],
  };
}

async function productionFixture() {
  const adapter = (await rhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice()).unwrap() as RhiNullDevice;
  const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const viewLayout = device
    .createBindGroupLayout({
      entries: [{ binding: 0, visibility: 0x1, buffer: { type: 'uniform' } }],
    })
    .unwrap();
  const projection = new RenderScene();
  const assetHandle = 2048;
  const delta = projection.apply([
    updateSnapshot(preparedPbrSnapshot(snapshot(0, 11, assetHandle))),
    updateSnapshot(preparedPbrSnapshot(snapshot(1, 22, assetHandle))),
  ]);
  const availability = GpuScene.create(device, 2).unwrap();
  if (availability.status !== 'available') throw new Error('GPU Scene unavailable');
  availability.scene.sync(delta).unwrap();
  const topology = new BatchTopology();
  topology.rebuild(projection.slotsSnapshot());
  const inputs = standardPbrInputs(device, shader, viewLayout);
  const dispatch = new MaterialDispatch();
  for (const slot of projection.slotsSnapshot()) dispatch.bind(slot.slot, slot.snapshot);
  const programs = new GpuDrivenMaterialProgramProjection().project(
    dispatch.query(projection.slotsSnapshot()),
    dispatch.materials(),
  );
  const selected = (artifact = inputs.materialArtifact) =>
    collectGpuDrivenMaterialArtifacts({
      batches: topology.query(topology.sourcePlan(), undefined).batches,
      programs,
      resolve: () => artifact,
      clustered: false,
      reflectionFallback: false,
      probeBlend: false,
      shadowViews: false,
    });
  return {
    device,
    shader,
    viewLayout,
    projection,
    availability,
    topology,
    inputs: { ...inputs, ...selected() },
    selected,
    production: new GpuDrivenProduction(device, {
      createShaderModule: () => ok(shader),
    }),
  };
}

describe('GPU-driven mesh world identity', () => {
  it('keeps same numeric asset handles distinct across World residency namespaces', () => {
    const worldA = new World();
    const worldB = new World();
    const meshA = { vboBytes: 144 } as unknown as MeshGpuHandles;
    const meshB = { vboBytes: 288 } as unknown as MeshGpuHandles;
    const getMeshGpuHandles = vi.fn((_handle: number, scope: RenderResourceScope) =>
      scope === worldRenderResources(worldA)
        ? meshA
        : scope === worldRenderResources(worldB)
          ? meshB
          : undefined,
    );
    const internals = {
      gpuStore: {
        getMeshGpuHandles,
        ensureResident: vi.fn(() => ok(meshA)),
      },
      assets: {},
    } as unknown as RenderSystemInternals;
    const state = {
      scene: {},
      plan: {
        batches: [
          { binding: { worldId: 0, assetHandle: 2048 } },
          { binding: { worldId: 1, assetHandle: 2048 } },
        ],
      },
      worldKeys: [101, 202],
    } as unknown as PersistentGpuDrivenState;

    const result = gpuDrivenMeshesForFrame(
      internals,
      [worldA, worldB].map(worldRenderResources),
      state,
    );

    expect(getMeshGpuHandles).toHaveBeenCalledTimes(2);
    expect(result.get(bindingAt(state.plan, 0))).toBe(meshA);
    expect(result.get(bindingAt(state.plan, 1))).toBe(meshB);
  });

  it('refreshes shared residency when the World source changes at the same residency epoch', () => {
    const worldA = new World();
    const worldB = new World();
    const meshA = { vboBytes: 144 } as unknown as MeshGpuHandles;
    const meshB = { vboBytes: 288 } as unknown as MeshGpuHandles;
    const getMeshGpuHandles = vi.fn((_handle: number, scope: RenderResourceScope) =>
      scope === worldRenderResources(worldA)
        ? meshA
        : scope === worldRenderResources(worldB)
          ? meshB
          : undefined,
    );
    const internals = {
      gpuStore: {
        meshResidencyEpoch: 4,
        getMeshGpuHandles,
        ensureResident: vi.fn(() => ok(meshA)),
      },
      assets: {},
    } as unknown as RenderSystemInternals;
    const state = {
      scene: {},
      plan: { batches: [{ binding: { worldId: 0, assetHandle: 2048 } }] },
    } as unknown as PersistentGpuDrivenState;

    const first = gpuDrivenMeshesForFrame(internals, [worldA].map(worldRenderResources), state);
    const afterSourceEdit = gpuDrivenMeshesForFrame(
      internals,
      [worldB].map(worldRenderResources),
      state,
    );

    expect(first.get(bindingAt(state.plan, 0))).toBe(meshA);
    expect(afterSourceEdit.get(bindingAt(state.plan, 0))).toBe(meshB);
    expect(getMeshGpuHandles).toHaveBeenCalledTimes(2);
  });

  it.each([
    1, 2,
  ])('resides LOD %i independently, then upgrades the remaining ordinary LOD asset', async (readyLevel) => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap() as RhiNullDevice;
    const gpuStore = new GpuResidencyCache();
    gpuStore.configureGpuDevice(device, undefined, device.caps);
    const makeMeshAsset = (value: number): MeshAsset => ({
      kind: 'mesh',
      vertices: new Float32Array(36).fill(value),
      indices: new Uint16Array([0, 1, 2]),
      attributes: {
        position: new Float32Array(9),
        normal: new Float32Array(9),
        uv: new Float32Array(6),
        tangent: new Float32Array(12),
      },
      submeshes: [
        {
          indexOffset: 0,
          indexCount: 3,
          vertexCount: 3,
          topology: 'triangle-list',
          materialSlot: 0,
        },
      ],
      materialSlots: [{ slotName: 'default' }],
    });
    const middleGuid = '00000000-0000-7000-8000-000000000001';
    const lowestGuid = '00000000-0000-7000-8000-000000000002';
    const root: MeshAsset = {
      ...makeMeshAsset(0),
      lods: [
        { mesh: middleGuid as never, screenCoverage: 0.5 },
        { mesh: lowestGuid as never, screenCoverage: 0.2 },
      ],
    };
    const middle = makeMeshAsset(1);
    const lowest = makeMeshAsset(2);
    const rootHandle = 123 as never;
    const assetsByGuid = new Map(
      readyLevel === 1 ? [[middleGuid, middle]] : [[lowestGuid, lowest]],
    );
    const world = {
      identity: 'published-lod-test',
      resolveAsset: (handle: number) =>
        ok(handle === 123 ? root : assetsByGuid.get(handle === 124 ? middleGuid : lowestGuid)),
      handleForGuid: (guid: string) =>
        assetsByGuid.has(guid) ? (guid === middleGuid ? 124 : 125) : undefined,
    } as unknown as RenderResourceScope;
    const internals = { gpuStore } as unknown as RenderSystemInternals;
    const source = gpuSnapshot(1, rootHandle);
    const geometry = source.gpuDrivenDraws?.[0]?.geometry;
    assert(geometry);
    const binding: GpuDrivenBatchBinding = {
      material: source.material,
      geometry,
      drawItemIndex: 0,
      worldId: 0,
      assetHandle: rootHandle,
      lods: (root.lods ?? []).map((lod) => lod.mesh),
    };
    const state = { plan: { batches: [{ binding }] } } as unknown as PersistentGpuDrivenState;

    try {
      const beforeLowest = gpuDrivenMeshesForFrame(internals, [world], state).get(binding);
      expect(beforeLowest?.lodRanges).toHaveLength(3);
      expect(beforeLowest?.lodRanges?.[readyLevel]?.[0]).toMatchObject({ count: 3 });
      expect(beforeLowest?.lodRanges?.[3 - readyLevel]).toEqual([]);
      expect(beforeLowest?.vboBytes).toBe(root.vertices.byteLength + middle.vertices.byteLength);
      expect(gpuDrivenMeshesForFrame(internals, [world], state).get(binding)).toBe(beforeLowest);

      assetsByGuid.set(middleGuid, middle);
      assetsByGuid.set(lowestGuid, lowest);
      const afterLowest = gpuDrivenMeshesForFrame(internals, [world], state).get(binding);

      expect(afterLowest).toBeDefined();
      expect(afterLowest).not.toBe(beforeLowest);
      expect(afterLowest?.lodRanges).toHaveLength(3);
      expect(afterLowest?.lodRanges?.[1]?.[0]).toMatchObject({ count: 3 });
      expect(afterLowest?.lodRanges?.[2]?.[0]).toMatchObject({ count: 3 });
      expect(gpuStore.getMeshGpuHandles(rootHandle, world)).toBe(afterLowest);
    } finally {
      gpuStore.destroyAll();
    }
  });

  it('projects distinct final raster mesh resources for two Worlds sharing one handle', async () => {
    const fixture = await productionFixture();
    const slots = fixture.projection.slotsSnapshot();
    const first = slots.at(0);
    const second = slots.at(1);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) return;
    const firstMesh = mesh(fixture.device, 3);
    const secondMesh = mesh(fixture.device, 6);
    const meshes = new Map<GpuDrivenBatchBinding, MeshGpuHandles>([
      [bindingAt(fixture.topology.query(fixture.topology.sourcePlan(), undefined), 0), firstMesh],
      [bindingAt(fixture.topology.query(fixture.topology.sourcePlan(), undefined), 1), secondMesh],
    ]);
    const prepared = fixture.production
      .prepare(
        admitGpuFixture({
          ...fixture.inputs,
          scene: {
            scene: fixture.availability.scene,
            plan: fixture.topology.query(fixture.topology.sourcePlan(), undefined),
            slots,
            slotAt: fixture.projection.slotAt,
          },
          camera: makeZeroCameraFallbackSnapshot(),
          meshByBinding: meshes,
          viewBindGroupLayout: fixture.viewLayout,
        }),
      )
      .unwrap();
    expect(prepared).toBeDefined();
    if (prepared === undefined) return;
    const projected = prepared
      .project(new RenderGraphBuilder<RenderPipelineFrame>(), 'rgba8unorm', 1)
      .unwrap();
    expect(projected.accesses.filter((access) => access.usage === 'vertex-read')).toHaveLength(2);
    expect(projected.accesses.filter((access) => access.usage === 'index-read')).toHaveLength(2);
    expect(fixture.production.inspect()).toMatchObject({ batchCount: 2, indirectDrawCount: 2 });
    fixture.production.dispose();
    fixture.availability.scene.dispose();
  });

  it('rebuilds filtered mesh selection after a composition source edit with an unchanged plan', async () => {
    const fixture = await productionFixture();
    const slots = fixture.projection.slotsSnapshot();
    const first = slots.at(0);
    const second = slots.at(1);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) return;
    const firstMesh = mesh(fixture.device, 3);
    const secondMesh = mesh(fixture.device, 6);
    const sourcePlan = fixture.topology.query(fixture.topology.sourcePlan(), undefined);
    const baseScene = {
      scene: fixture.availability.scene,
      plan: sourcePlan,
      slots,
      slotAt: fixture.projection.slotAt,
    } satisfies PersistentGpuDrivenState;
    const firstPrepared = fixture.production
      .prepare(
        admitGpuFixture({
          ...fixture.inputs,
          scene: baseScene,
          camera: makeZeroCameraFallbackSnapshot(),
          meshByBinding: new Map<GpuDrivenBatchBinding, MeshGpuHandles>([
            [
              bindingAt(fixture.topology.query(fixture.topology.sourcePlan(), undefined), 0),
              firstMesh,
            ],
            [
              bindingAt(fixture.topology.query(fixture.topology.sourcePlan(), undefined), 1),
              secondMesh,
            ],
          ]),
          viewBindGroupLayout: fixture.viewLayout,
        }),
      )
      .unwrap();
    expect(firstPrepared).toBeDefined();
    if (firstPrepared === undefined) return;
    firstPrepared._commitResourceReplacement();
    const editedSlots = Object.freeze(
      slots.map((value) =>
        value.slot === first.slot
          ? {
              ...value,
              snapshot: { ...value.snapshot, transform: { world: new Float32Array(16) } },
            }
          : value,
      ),
    );
    const secondPrepared = fixture.production
      .prepare(
        admitGpuFixture({
          ...fixture.inputs,
          scene: {
            ...baseScene,
            slots: editedSlots,
            slotAt: (index: number) => editedSlots.find((value) => value.slot === index),
          },
          camera: makeZeroCameraFallbackSnapshot(),
          meshByBinding: new Map<GpuDrivenBatchBinding, MeshGpuHandles>([
            [
              bindingAt(fixture.topology.query(fixture.topology.sourcePlan(), undefined), 0),
              secondMesh,
            ],
            [
              bindingAt(fixture.topology.query(fixture.topology.sourcePlan(), undefined), 1),
              secondMesh,
            ],
          ]),
          viewBindGroupLayout: fixture.viewLayout,
        }),
      )
      .unwrap();
    expect(secondPrepared).toBeDefined();
    secondPrepared?._commitResourceReplacement();
    expect(fixture.production.inspect().filteredPlanBuilds).toBe(1);
    expect(secondPrepared?.topologySignature).not.toBe(firstPrepared.topologySignature);
    // A fresh slots snapshot with the same structure and resident meshes is
    // not a structural edit: prepared rows and the filtered plan are retained.
    const retainedMeshes = () =>
      new Map<GpuDrivenBatchBinding, MeshGpuHandles>([
        [bindingAt(fixture.topology.query(fixture.topology.sourcePlan(), undefined), 0), firstMesh],
        [
          bindingAt(fixture.topology.query(fixture.topology.sourcePlan(), undefined), 1),
          secondMesh,
        ],
      ]);
    const prepareRetained = (meshByBinding: ReadonlyMap<GpuDrivenBatchBinding, MeshGpuHandles>) => {
      const frame = fixture.production
        .prepare(
          admitGpuFixture({
            ...fixture.inputs,
            scene: { ...baseScene, slots: Object.freeze([...slots]) },
            camera: makeZeroCameraFallbackSnapshot(),
            meshByBinding,
            viewBindGroupLayout: fixture.viewLayout,
          }),
        )
        .unwrap();
      frame?._commitResourceReplacement();
      return frame;
    };
    prepareRetained(retainedMeshes());
    prepareRetained(retainedMeshes());
    expect(fixture.production.inspect()).toMatchObject({
      filteredPlanBuilds: 0,
      preparedBatchBuilds: 0,
      filteredBatchBuilds: 0,
    });
    // Replacing one slot's resident mesh at the same epoch re-derives only the
    // batch that consulted it.
    prepareRetained(
      new Map<GpuDrivenBatchBinding, MeshGpuHandles>([
        [bindingAt(fixture.topology.query(fixture.topology.sourcePlan(), undefined), 0), firstMesh],
        [bindingAt(fixture.topology.query(fixture.topology.sourcePlan(), undefined), 1), firstMesh],
      ]),
    );
    expect(fixture.production.inspect()).toMatchObject({
      filteredPlanBuilds: 1,
      preparedBatchBuilds: 1,
    });
    fixture.production.dispose();
    fixture.availability.scene.dispose();
  });

  it('retains forward preparation across implicit and explicit fs_main entries', async () => {
    const fixture = await productionFixture();
    const slots = fixture.projection.slotsSnapshot();
    const artifact = fixture.inputs.materialArtifact;
    if (artifact === undefined) throw new Error('missing artifact');
    const { fragmentEntry: _fragmentEntry, ...implicit } = artifact;
    const explicit = { ...implicit, fragmentEntry: 'fs_main' };
    const source = {
      scene: fixture.availability.scene,
      plan: fixture.topology.query(fixture.topology.sourcePlan(), undefined),
      slots,
      slotAt: fixture.projection.slotAt,
    };
    const meshByBinding = new Map(
      source.plan.batches.map((_, index) => [
        bindingAt(source.plan, index),
        mesh(fixture.device, 3),
      ]),
    );
    const prepare = (selected: typeof artifact) => {
      const frame = fixture.production
        .prepare(
          admitGpuFixture({
            ...fixture.inputs,
            scene: source,
            camera: makeZeroCameraFallbackSnapshot(),
            meshByBinding,
            viewBindGroupLayout: fixture.viewLayout,
            ...fixture.selected(selected),
          }),
        )
        .unwrap();
      frame?._commitResourceReplacement();
      return frame;
    };
    try {
      const initial = prepare(implicit);
      for (const selected of [explicit, implicit, explicit]) {
        const next = prepare(selected);
        expect(fixture.production.inspect()).toMatchObject({
          preparedBatchBuilds: 0,
          filteredPlanBuilds: 0,
          filteredBatchBuilds: 0,
        });
        expect(next?.topologySignature).toBe(initial?.topologySignature);
      }
      const custom = prepare({ ...explicit, fragmentEntry: 'fs_custom' });
      expect(fixture.production.inspect().preparedBatchBuilds).toBe(source.plan.batches.length);
      expect(custom?.topologySignature).not.toBe(initial?.topologySignature);
    } finally {
      fixture.production.dispose();
      fixture.availability.scene.dispose();
    }
  });

  it('keeps prepared batches when an unrelated material enters or leaves the publication', async () => {
    const fixture = await productionFixture();
    const slots = fixture.projection.slotsSnapshot();
    const artifact = fixture.inputs.materialArtifact;
    if (artifact === undefined) throw new Error('missing artifact');
    const materialKey = fixture.inputs.materialArtifacts.keys().next().value;
    assert(materialKey);
    const source = {
      scene: fixture.availability.scene,
      plan: fixture.topology.query(fixture.topology.sourcePlan(), undefined),
      slots,
      slotAt: fixture.projection.slotAt,
    };
    const meshByBinding = new Map(
      source.plan.batches.map((_, index) => [
        bindingAt(source.plan, index),
        mesh(fixture.device, 3),
      ]),
    );
    const prepare = (artifacts: Map<string, typeof artifact>) => {
      const frame = fixture.production
        .prepare(
          admitGpuFixture({
            ...fixture.inputs,
            scene: source,
            camera: makeZeroCameraFallbackSnapshot(),
            meshByBinding,
            viewBindGroupLayout: fixture.viewLayout,
            ...fixture.selected(artifacts.get(materialKey)),
            materialArtifacts: artifacts,
          }),
        )
        .unwrap();
      frame?._commitResourceReplacement();
      return frame;
    };
    try {
      prepare(new Map([[materialKey, artifact]]));
      prepare(
        new Map([
          [materialKey, { ...artifact }],
          ['unrelated', { ...artifact, material: 'unrelated' }],
        ]),
      );
      expect(fixture.production.inspect()).toMatchObject({
        preparedBatchBuilds: 0,
        filteredPlanBuilds: 0,
      });
      prepare(new Map([[materialKey, artifact]]));
      expect(fixture.production.inspect()).toMatchObject({
        preparedBatchBuilds: 0,
        filteredPlanBuilds: 0,
      });
      for (const change of [
        { fragmentEntry: 'replacement' },
        { uvSetCount: 2 },
        { reflectionFallbackOutputAvailable: true },
      ]) {
        const original = prepare(new Map([[materialKey, artifact]]));
        const replaced = prepare(new Map([[materialKey, { ...artifact, ...change }]]));
        expect(fixture.production.inspect()).toMatchObject({
          preparedBatchBuilds: source.plan.batches.length,
          filteredPlanBuilds: 1,
        });
        expect(replaced?.topologySignature).not.toBe(original?.topologySignature);
      }
    } finally {
      fixture.production.dispose();
      fixture.availability.scene.dispose();
    }
  });
});
