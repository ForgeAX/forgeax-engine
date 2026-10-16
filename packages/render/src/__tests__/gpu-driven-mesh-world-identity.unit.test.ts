import { World } from '@forgeax/engine-ecs';
import { deriveVertexLayoutProjection } from '@forgeax/engine-geometry';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { type RhiNullDevice, rhi } from '@forgeax/engine-rhi-null';
import { type MeshAsset, ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { GpuResidencyCache, type MeshGpuHandles } from '../device/gpu-residency';
import { gpuDrivenMaterialArtifactKey } from '../extract/gpu-driven';
import { BatchTopology } from '../gpu-driven/batch-topology';
import { GpuDrivenProduction } from '../gpu-driven/production-raster';
import { GpuBuffer } from '../gpu-resource';
import { GpuScene } from '../gpu-scene';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_INDEX,
  GPU_BUFFER_USAGE_VERTEX,
} from '../gpu-usage';
import { gpuDrivenMeshesForFrame, overlayGpuDrivenMeshes } from '../record/frame';
import { makeZeroCameraFallbackSnapshot } from '../record/frame-snapshot';
import type { PipelineState, RenderSystemInternals } from '../record/render-context';
import type { RenderPipelineFrame } from '../render-pipeline';
import type { MaterialSnapshot, RenderableSnapshot } from '../render-system-extract';
import {
  type PersistentGpuDrivenState,
  RenderScene,
  type RenderSceneSlot,
} from '../scene/render-scene';
import { preparedPbrSnapshot, standardPbrInputs } from './gpu-driven-production-fixture';

function slot(
  slot: number,
  worldId: number,
  entityKey: number,
  assetHandle: number,
): RenderSceneSlot {
  return {
    slot,
    generation: 1,
    worldId,
    entityKey,
    snapshot: {
      assetHandle,
      worldId,
      entityKey,
      transform: { world: new Float32Array(16) },
      material: undefined,
      materials: [],
      materialBindingSources: [],
    } as never,
  };
}

function snapshot(worldId: number, entityKey: number, assetHandle: number): RenderableSnapshot {
  const material = {
    baseColor: new Float32Array([1, 1, 1]),
    metallic: 0,
    roughness: 1,
    materialShaderId: 'forgeax::default-unlit',
  } as MaterialSnapshot;
  const world = new Float32Array(16);
  world[0] = 1;
  world[5] = 1;
  world[10] = 1;
  world[15] = 1;
  return {
    assetHandle,
    transform: { world },
    localAabb: new Float32Array([-0.25, -0.25, -0.25, 0.25, 0.25, 0.25]),
    material,
    materials: [material],
    materialBindingSources: ['engine-default'],
    worldId,
    entityKey,
    gpuDrivenDraws: [
      {
        kind: 'indexed',
        first: 0,
        count: 3,
        baseVertex: 0,
        materialSlot: 0,
        topology: 'triangle-list',
        pipelineClass: 'forgeax::default-unlit|triangle-list|null',
        materialResourceClass: JSON.stringify({ textures: [], samplers: [], video: [] }),
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
  return {
    device,
    shader,
    viewLayout,
    projection,
    availability,
    topology,
    inputs: standardPbrInputs(device, shader, viewLayout),
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
    const getMeshGpuHandles = vi.fn((_handle: number, world: World) =>
      world === worldA ? meshA : world === worldB ? meshB : undefined,
    );
    const internals = {
      gpuStore: {
        meshResidencyEpoch: 1,
        getMeshGpuHandles,
        ensureResident: vi.fn(() => ok(meshA)),
      },
      assets: {},
    } as unknown as RenderSystemInternals;
    const pipelineState = {
      meshes: new Map<number, MeshGpuHandles>(),
    } as unknown as PipelineState;
    const state = {
      scene: {},
      plan: {},
      slots: [slot(3, 0, 11, 2048), slot(9, 1, 22, 2048)],
      worldKeys: [101, 202],
    } as unknown as PersistentGpuDrivenState;

    const result = gpuDrivenMeshesForFrame(internals, pipelineState, [worldA, worldB], state);

    expect(getMeshGpuHandles).toHaveBeenCalledTimes(2);
    expect(result.get(3)).toBe(meshA);
    expect(result.get(9)).toBe(meshB);
    expect(result.get(2048)).toBeUndefined();
  });

  it('refreshes the slot projection when the World source changes at the same residency epoch', () => {
    const worldA = new World();
    const worldB = new World();
    const meshA = { vboBytes: 144 } as unknown as MeshGpuHandles;
    const meshB = { vboBytes: 288 } as unknown as MeshGpuHandles;
    const getMeshGpuHandles = vi.fn((_handle: number, world: World) =>
      world === worldA ? meshA : world === worldB ? meshB : undefined,
    );
    const internals = {
      gpuStore: {
        meshResidencyEpoch: 4,
        getMeshGpuHandles,
        ensureResident: vi.fn(() => ok(meshA)),
      },
      assets: {},
    } as unknown as RenderSystemInternals;
    const pipelineState = {
      meshes: new Map<number, MeshGpuHandles>(),
    } as unknown as PipelineState;
    const state = {
      scene: {},
      plan: {},
      slots: [slot(3, 0, 11, 2048)],
    } as unknown as PersistentGpuDrivenState;

    const first = gpuDrivenMeshesForFrame(internals, pipelineState, [worldA], state);
    const afterSourceEdit = gpuDrivenMeshesForFrame(internals, pipelineState, [worldB], state);

    expect(first.get(3)).toBe(meshA);
    expect(afterSourceEdit.get(3)).toBe(meshB);
    expect(getMeshGpuHandles).toHaveBeenCalledTimes(2);
  });

  it.each([
    1, 2,
  ])('resides LOD %i independently, then upgrades the remaining ordinary LOD asset', async (readyLevel) => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap() as RhiNullDevice;
    const gpuStore = new GpuResidencyCache();
    gpuStore.configureGpuDevice(
      device,
      undefined,
      () => {
        throw new Error('cubemap registration is not part of this test');
      },
      device.caps,
    );
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
    const world = new World();
    const rootHandle = world.allocSharedRef('MeshAsset', root);
    const assetsByGuid = new Map(
      readyLevel === 1 ? [[middleGuid, middle]] : [[lowestGuid, lowest]],
    );
    const internals = {
      gpuStore,
      assets: { lookup: (guid: string) => assetsByGuid.get(guid) },
    } as unknown as RenderSystemInternals;
    const pipelineState = { meshes: new Map<number, MeshGpuHandles>() } as unknown as PipelineState;
    const baseSlot = slot(0, 0, 11, Number(rootHandle));
    const renderSlot = {
      ...baseSlot,
      snapshot: { ...baseSlot.snapshot, lods: root.lods },
    } as RenderSceneSlot;
    const state = {
      scene: {},
      plan: {},
      slots: [renderSlot],
    } as unknown as PersistentGpuDrivenState;

    try {
      const beforeLowest = gpuDrivenMeshesForFrame(internals, pipelineState, [world], state).get(0);
      expect(beforeLowest?.lodRanges).toHaveLength(3);
      expect(beforeLowest?.lodRanges?.[readyLevel]?.[0]).toMatchObject({ count: 3 });
      expect(beforeLowest?.lodRanges?.[3 - readyLevel]).toEqual([]);
      expect(beforeLowest?.vboBytes).toBe(root.vertices.byteLength + middle.vertices.byteLength);
      expect(gpuDrivenMeshesForFrame(internals, pipelineState, [world], state).get(0)).toBe(
        beforeLowest,
      );

      assetsByGuid.set(middleGuid, middle);
      assetsByGuid.set(lowestGuid, lowest);
      const afterLowest = gpuDrivenMeshesForFrame(internals, pipelineState, [world], state).get(0);

      expect(afterLowest).toBeDefined();
      expect(afterLowest).not.toBe(beforeLowest);
      expect(afterLowest?.lodRanges).toHaveLength(3);
      expect(afterLowest?.lodRanges?.[1]?.[0]).toMatchObject({ count: 3 });
      expect(afterLowest?.lodRanges?.[2]?.[0]).toMatchObject({ count: 3 });
      expect(gpuStore.getMeshGpuHandles(rootHandle, world)).toBe(afterLowest);
    } finally {
      gpuStore.destroyAll();
      world.sharedRefs.release(rootHandle).unwrap();
    }
  });

  it('projects distinct final raster mesh resources for two Worlds sharing one handle', async () => {
    const fixture = await productionFixture();
    const slots = fixture.projection.slotsSnapshot();
    const first = slots[0];
    const second = slots[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) return;
    const firstMesh = mesh(fixture.device, 3);
    const secondMesh = mesh(fixture.device, 6);
    const meshes = new Map<number, MeshGpuHandles>([
      [first.slot, firstMesh],
      [second.slot, secondMesh],
      // Keep the old raw entry in the fixture so this regression also catches
      // production code that silently falls back to the handle key.
      [2048, firstMesh],
    ]);
    const prepared = fixture.production
      .prepare({
        ...fixture.inputs,
        scene: {
          scene: fixture.availability.scene,
          plan: fixture.topology.plan(),
          slots,
          slotAt: fixture.projection.slotAt,
        },
        camera: makeZeroCameraFallbackSnapshot(),
        meshBySlot: meshes,
        viewBindGroupLayout: fixture.viewLayout,
        meshResidencyEpoch: 1,
      })
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
    const first = slots[0];
    const second = slots[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) return;
    const firstMesh = mesh(fixture.device, 3);
    const secondMesh = mesh(fixture.device, 6);
    const sourcePlan = fixture.topology.plan();
    const baseScene = {
      scene: fixture.availability.scene,
      plan: sourcePlan,
      slots,
      slotAt: fixture.projection.slotAt,
    } satisfies PersistentGpuDrivenState;
    const firstPrepared = fixture.production
      .prepare({
        ...fixture.inputs,
        scene: baseScene,
        camera: makeZeroCameraFallbackSnapshot(),
        meshBySlot: new Map<number, MeshGpuHandles>([
          [first.slot, firstMesh],
          [second.slot, secondMesh],
          [2048, firstMesh],
        ]),
        viewBindGroupLayout: fixture.viewLayout,
        meshResidencyEpoch: 1,
      })
      .unwrap();
    expect(firstPrepared).toBeDefined();
    if (firstPrepared === undefined) return;
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
      .prepare({
        ...fixture.inputs,
        scene: {
          ...baseScene,
          slots: editedSlots,
          slotAt: (index: number) => editedSlots.find((value) => value.slot === index),
        },
        camera: makeZeroCameraFallbackSnapshot(),
        meshBySlot: new Map<number, MeshGpuHandles>([
          [first.slot, secondMesh],
          [second.slot, secondMesh],
          [2048, firstMesh],
        ]),
        viewBindGroupLayout: fixture.viewLayout,
        meshResidencyEpoch: 1,
      })
      .unwrap();
    expect(secondPrepared).toBeDefined();
    expect(fixture.production.inspect().filteredPlanBuilds).toBe(1);
    expect(secondPrepared?.topologySignature).not.toBe(firstPrepared.topologySignature);
    // A fresh slots snapshot with the same structure and resident meshes is
    // not a structural edit: prepared rows and the filtered plan are retained.
    const retainedMeshes = () =>
      new Map<number, MeshGpuHandles>([
        [first.slot, firstMesh],
        [second.slot, secondMesh],
      ]);
    const prepareRetained = (meshBySlot: ReadonlyMap<number, MeshGpuHandles>) =>
      fixture.production
        .prepare({
          ...fixture.inputs,
          scene: { ...baseScene, slots: Object.freeze([...slots]) },
          camera: makeZeroCameraFallbackSnapshot(),
          meshBySlot,
          viewBindGroupLayout: fixture.viewLayout,
          meshResidencyEpoch: 1,
        })
        .unwrap();
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
      new Map<number, MeshGpuHandles>([
        [first.slot, firstMesh],
        [second.slot, firstMesh],
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
    const artifact = fixture.inputs.standardPbrArtifact;
    const prepared = fixture.topology.plan().batches[0]?.prepared;
    if (artifact === undefined || prepared === undefined) throw new Error('missing artifact');
    const key = gpuDrivenMaterialArtifactKey({
      material: prepared.identity.material,
      deformation: prepared.identity.deformation,
      receiptIdentity: prepared.receiptIdentity,
      receiptGeneration: prepared.receiptGeneration,
    });
    const { fragmentEntry: _fragmentEntry, ...implicit } = artifact;
    const explicit = { ...implicit, fragmentEntry: 'fs_main' };
    const source = {
      scene: fixture.availability.scene,
      plan: fixture.topology.plan(),
      slots,
      slotAt: fixture.projection.slotAt,
    };
    const meshBySlot = new Map(slots.map((slot) => [slot.slot, mesh(fixture.device, 3)]));
    const prepare = (selected: typeof artifact) =>
      fixture.production
        .prepare({
          ...fixture.inputs,
          scene: source,
          camera: makeZeroCameraFallbackSnapshot(),
          meshBySlot,
          viewBindGroupLayout: fixture.viewLayout,
          meshResidencyEpoch: 1,
          materialArtifacts: new Map([[key, selected]]),
        })
        .unwrap();
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
    const artifact = fixture.inputs.standardPbrArtifact;
    const prepared = fixture.topology.plan().batches[0]?.prepared;
    if (artifact === undefined || prepared === undefined)
      throw new Error('missing fixture artifact');
    const materialKey = gpuDrivenMaterialArtifactKey({
      material: prepared.identity.material,
      deformation: prepared.identity.deformation,
      receiptIdentity: prepared.receiptIdentity,
      receiptGeneration: prepared.receiptGeneration,
    });
    const source = {
      scene: fixture.availability.scene,
      plan: fixture.topology.plan(),
      slots,
      slotAt: fixture.projection.slotAt,
    };
    const meshBySlot = new Map(slots.map((slot) => [slot.slot, mesh(fixture.device, 3)]));
    const prepare = (artifacts: Map<string, typeof artifact>) =>
      fixture.production
        .prepare({
          ...fixture.inputs,
          scene: source,
          camera: makeZeroCameraFallbackSnapshot(),
          meshBySlot,
          viewBindGroupLayout: fixture.viewLayout,
          meshResidencyEpoch: 1,
          materialArtifacts: artifacts,
        })
        .unwrap();
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

it.each([
  false,
  true,
])('routes mesh overlays in the source World namespace (native index: %s)', (native) => {
  const projection = new RenderScene();
  projection.apply([updateSnapshot(snapshot(0, 11, 2048)), updateSnapshot(snapshot(1, 11, 2048))]);
  const state = {
    slots: projection.slotsSnapshot(),
    ...(native ? { slotForEntity: projection.slot } : {}),
  } as PersistentGpuDrivenState;
  const firstMesh = { contentEpoch: 1 } as MeshGpuHandles;
  const secondMesh = { contentEpoch: 2 } as MeshGpuHandles;
  const shadowMesh = { contentEpoch: 3 } as MeshGpuHandles;
  const row = (worldId: number, mesh: MeshGpuHandles) =>
    ({ source: snapshot(worldId, 11, 2048), mesh }) as Parameters<
      typeof overlayGpuDrivenMeshes
    >[2][number];
  const meshes = new Map<number, MeshGpuHandles>();
  const maps = vi.spyOn(Array.prototype, 'map');
  let scans: number;
  try {
    overlayGpuDrivenMeshes(
      meshes,
      state,
      [row(0, firstMesh), row(1, secondMesh)],
      [row(1, shadowMesh)],
    );
    scans = maps.mock.contexts.filter((value) => value === state.slots).length;
  } finally {
    maps.mockRestore();
  }
  expect(scans).toBe(native ? 0 : 1);
  expect(meshes.get(projection.slot(0, 11)?.slot ?? -1)).toBe(firstMesh);
  expect(meshes.get(projection.slot(1, 11)?.slot ?? -1)).toBe(shadowMesh);
  if (native) {
    projection.apply([{ kind: 'remove', worldId: 0, entityKey: 11 }]);
    const afterRetirement = new Map<number, MeshGpuHandles>();
    overlayGpuDrivenMeshes(afterRetirement, state, [row(0, firstMesh)]);
    expect(afterRetirement.size).toBe(0);
  }
});
