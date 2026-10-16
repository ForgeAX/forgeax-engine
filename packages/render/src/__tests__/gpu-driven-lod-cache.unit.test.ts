import { deriveVertexLayoutProjection } from '@forgeax/engine-geometry';
import { vec3 } from '@forgeax/engine-math';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { type RhiNullDevice, rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import type { MeshGpuHandles } from '../device/gpu-residency';
import { BatchTopology } from '../gpu-driven/batch-topology';
import { materialBindingKey, projectMaterialBindingClasses } from '../gpu-driven/material-bindings';
import { GpuDrivenProduction } from '../gpu-driven/production-raster';
import { GpuBuffer } from '../gpu-resource';
import { GpuScene } from '../gpu-scene';
import { GPU_SCENE_LAYOUTS } from '../gpu-scene-schema';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_INDEX,
  GPU_BUFFER_USAGE_VERTEX,
} from '../gpu-usage';
import { makeZeroCameraFallbackSnapshot } from '../record/frame-snapshot';
import type { RenderPipelineFrame } from '../render-pipeline';
import type { MaterialSnapshot, RenderableSnapshot } from '../render-system-extract';
import { RenderScene } from '../scene/render-scene';
import { preparedPbrSnapshot, standardPbrInputs } from './gpu-driven-production-fixture';

const EMPTY_RESOURCE_CLASS = JSON.stringify({ textures: [], samplers: [], video: [] });
const LOD_MESH_GUID = '00000000-0000-7000-8000-000000000001' as never;

function identityWorld(z = 0): Float32Array {
  const world = new Float32Array(16);
  world[0] = 1;
  world[5] = 1;
  world[10] = 1;
  world[14] = z;
  world[15] = 1;
  return world;
}

function snapshot(entityKey: number, withLod: boolean, worldId = 0): RenderableSnapshot {
  const material = {
    baseColor: new Float32Array([1, 1, 1]),
    metallic: 0,
    roughness: 1,
    materialShaderId: 'forgeax::default-unlit',
  } as MaterialSnapshot;
  const source: RenderableSnapshot = {
    assetHandle: 3,
    transform: { world: identityWorld() },
    // A radius large enough to cross the 0.5 screen-coverage threshold at z=5.
    localAabb: new Float32Array([-1, -1, -1, 1, 1, 1]),
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
        materialResourceClass: EMPTY_RESOURCE_CLASS,
      },
    ],
  };
  const prepared = preparedPbrSnapshot(source);
  if (!withLod) return prepared;
  const draw = prepared.gpuDrivenDraws?.[0];
  if (draw === undefined) throw new Error('LOD fixture draw is missing');
  return {
    ...prepared,
    lods: [{ mesh: LOD_MESH_GUID, screenCoverage: 0.5 }],
    gpuDrivenDraws: [{ ...draw, lodRanges: [{ first: 3, count: 1, baseVertex: 0 }] }],
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

function updateWorld(entityKey: number, z: number, worldId = 0) {
  return {
    kind: 'update' as const,
    worldId,
    entityKey,
    world: identityWorld(z),
  };
}

function mesh(device: RhiNullDevice, withLod: boolean): MeshGpuHandles {
  const vertex = device
    .createBuffer({ size: 144, usage: GPU_BUFFER_USAGE_VERTEX | GPU_BUFFER_USAGE_COPY_DST })
    .unwrap();
  const index = device
    .createBuffer({ size: 8, usage: GPU_BUFFER_USAGE_INDEX | GPU_BUFFER_USAGE_COPY_DST })
    .unwrap();
  return {
    vertexBuffer: new GpuBuffer(device, vertex),
    indexBuffer: new GpuBuffer(device, index),
    contentEpoch: 0,
    vboBytes: 144,
    iboBytes: 8,
    indexCount: 3,
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

async function fixture(withLod: boolean, entityCount = 2, worldOf = (_index: number) => 0) {
  const adapter = (await rhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice()).unwrap() as RhiNullDevice;
  const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const viewLayout = device
    .createBindGroupLayout({
      entries: [{ binding: 0, visibility: 0x1, buffer: { type: 'uniform' } }],
    })
    .unwrap();
  const pbrInputs = standardPbrInputs(device, shader, viewLayout);
  const projection = new RenderScene();
  const delta = projection.apply(
    Array.from({ length: entityCount }, (_, index) =>
      updateSnapshot(snapshot(index + 1, withLod, worldOf(index))),
    ),
  );
  const availability = GpuScene.create(device, entityCount).unwrap();
  if (availability.status !== 'available') throw new Error('GPU Scene unavailable');
  availability.scene.sync(delta).unwrap();
  const topology = new BatchTopology();
  topology.rebuild(projection.slotsSnapshot());
  const production = new GpuDrivenProduction(device, {
    createShaderModule: () => ok(shader),
  });
  const gpuMesh = mesh(device, withLod);
  return {
    device,
    viewLayout,
    pbrInputs,
    projection,
    availability,
    topology,
    production,
    gpuMesh,
  };
}

describe('GPU-driven filtered-plan cache', () => {
  it('skips retained default bindings and observes empty/nonempty transitions on the same Map', async () => {
    const { availability, production, projection, topology, gpuMesh, viewLayout, pbrInputs } =
      await fixture(false, 64);
    const classes = new Map<string, string>();
    const slots = projection.slotsSnapshot();
    const first = slots[0]?.snapshot;
    if (first === undefined) throw Error('expected first receiver');
    let filteredCalls = 0;
    const prepare = (bindings: ReadonlyMap<string, string> | undefined = classes) => {
      const frame = production
        .prepare({
          ...pbrInputs,
          scene: {
            scene: availability.scene,
            plan: topology.plan(),
            slots: projection.slotsSnapshot(),
            slotAt: projection.slotAt,
          },
          camera: makeZeroCameraFallbackSnapshot(),
          meshBySlot: new Map(slots.map((slot) => [slot.slot, gpuMesh])),
          viewBindGroupLayout: viewLayout,
          meshResidencyEpoch: 1,
          ...(bindings === undefined ? {} : { materialBindingClasses: bindings }),
          shadowCasterMembership: [],
          profilePhase: (phase, action) => {
            if (phase === 'record/gpu-driven-prepare/filter/main-plan') filteredCalls++;
            return action();
          },
        })
        .unwrap();
      if (frame === undefined) throw Error('expected GPU frame');
      expect(frame.drawKeys?.size).toBe(64);
      frame._commitResourceReplacement();
      return production.inspect();
    };
    try {
      expect(prepare().indirectDrawCount).toBe(1);
      expect(filteredCalls).toBe(1);
      for (let frame = 0; frame < 12; frame++) {
        const delta = projection.apply([updateWorld(first.entityKey, frame / 100)]);
        availability.scene.sync(delta).unwrap();
        topology.apply(delta);
        expect(prepare(frame % 2 === 0 ? classes : new Map()).filteredPlanBuilds).toBe(0);
      }
      expect(filteredCalls).toBe(1);
      classes.set(
        materialBindingKey(first, first.material.materialHandle ?? -1),
        'forward|probe:7',
      );
      expect(prepare().indirectDrawCount).toBe(2);
      expect(filteredCalls).toBe(2);
      classes.clear();
      expect(prepare().indirectDrawCount).toBe(1);
      expect(filteredCalls).toBe(3);
      expect(prepare().filteredPlanBuilds).toBe(0);
      expect(filteredCalls).toBe(3);
      // A same-cardinality mesh content edit must still refresh the prepared rows.
      Object.assign(gpuMesh, { contentEpoch: gpuMesh.contentEpoch + 1 });
      expect(prepare().preparedBatchBuilds).toBeGreaterThan(0);
      expect(filteredCalls).toBe(4);
      // Empty iteration is not empty binding authority for borrowed Map methods.
      const failure = new Error('borrowed binding read');
      class BorrowedBindings extends Map<string, string> {
        override get(): string | undefined {
          throw failure;
        }
      }
      expect(() => prepare(new BorrowedBindings())).toThrow(failure);
      expect(filteredCalls).toBe(5);
      expect(prepare().indirectDrawCount).toBe(1);
      expect(filteredCalls).toBe(5);
    } finally {
      production.dispose();
      availability.scene.dispose();
    }
  });

  it('invalidates bindings only for prepared GPU draws while retaining CPU material classes', async () => {
    const { availability, production, projection, topology, gpuMesh, viewLayout, pbrInputs } =
      await fixture(false, 64);
    const cpuBase = snapshot(9001, false);
    const cpuMaterial = { ...cpuBase.material, materialHandle: 900 };
    let cpuSource = {
      ...cpuBase,
      gpuDrivenDraws: [],
      material: cpuMaterial,
      materials: [cpuMaterial],
    } as RenderableSnapshot;
    const apply = (source: RenderableSnapshot) => {
      const delta = projection.apply([updateSnapshot(source)]);
      availability.scene.sync(delta).unwrap();
      topology.apply(delta);
    };
    apply(cpuSource);
    const stablePlan = topology.plan();
    const observations: Array<{
      phase: string;
      preparedBatchBuilds: number;
      filteredPlanBuilds: number;
      candidateUploadBytes: number;
      batchUploadBytes: number;
      drawCount: number;
    }> = [];
    const prepare = (
      phase: string,
      edit?: (classes: Map<string, string>) => Map<string, string>,
    ) => {
      const slots = projection.slotsSnapshot();
      let classes = new Map(
        projectMaterialBindingClasses(slots.map(({ snapshot: source }) => ({ source }))),
      );
      // CPU consumers still require their full binding table.
      expect(
        classes.get(materialBindingKey(cpuSource, cpuSource.material.materialHandle ?? -1)),
      ).toBe('forward|probe:');
      if (edit !== undefined) classes = edit(classes);
      const frame = production
        .prepare({
          ...pbrInputs,
          scene: {
            scene: availability.scene,
            plan: topology.plan(),
            slots,
            slotAt: projection.slotAt,
          },
          camera: makeZeroCameraFallbackSnapshot(),
          meshBySlot: new Map(slots.map((slot) => [slot.slot, gpuMesh])),
          viewBindGroupLayout: viewLayout,
          meshResidencyEpoch: 1,
          materialBindingClasses: classes,
          shadowCasterMembership: [],
        })
        .unwrap();
      if (frame === undefined || frame.drawKeys === undefined)
        throw new Error('expected GPU frame');
      const { preparedBatchBuilds, filteredPlanBuilds, candidateUploadBytes, batchUploadBytes } =
        production.inspect();
      observations.push({
        phase,
        preparedBatchBuilds,
        filteredPlanBuilds,
        candidateUploadBytes,
        batchUploadBytes,
        drawCount: frame.drawKeys.size,
      });
      frame._commitResourceReplacement();
    };
    try {
      prepare('initial');
      prepare('stable');
      const swapped = { ...cpuMaterial, materialHandle: 901 };
      cpuSource = { ...cpuSource, material: swapped, materials: [swapped] };
      apply(cpuSource);
      expect(topology.plan()).toBe(stablePlan);
      prepare('cpu-material-swap');
      prepare('map-order-only', (classes) => new Map([...classes].reverse()));
      const changeGpuBinding = (classes: Map<string, string>) => {
        const first = projection.slotsSnapshot()[0]?.snapshot;
        if (first === undefined) throw new Error('expected GPU source');
        classes.set(
          materialBindingKey(first, first.material.materialHandle ?? -1),
          'forward|probe:7',
        );
        return classes;
      };
      prepare('gpu-binding-change', changeGpuBinding);
      cpuSource = cpuBase;
      apply(cpuSource);
      expect(topology.plan()).not.toBe(stablePlan);
      prepare('cpu-promoted-to-gpu', changeGpuBinding);
      const stable = (phase: string) => ({
        phase,
        preparedBatchBuilds: 0,
        filteredPlanBuilds: 0,
        candidateUploadBytes: 0,
        batchUploadBytes: 0,
        drawCount: 64,
      });
      expect(observations.slice(1, 4)).toEqual([
        stable('stable'),
        stable('cpu-material-swap'),
        stable('map-order-only'),
      ]);
      expect(observations[4]).toMatchObject({
        phase: 'gpu-binding-change',
        filteredPlanBuilds: 1,
        drawCount: 64,
      });
      expect(observations[5]).toMatchObject({
        phase: 'cpu-promoted-to-gpu',
        filteredPlanBuilds: 1,
        drawCount: 65,
      });
    } finally {
      production.dispose();
      availability.scene.dispose();
    }
  });

  it('ignores a rejected material slot until that slot is admitted to the GPU lane', async () => {
    const { availability, production, projection, topology, gpuMesh, viewLayout, pbrInputs } =
      await fixture(false, 1);
    const first = projection.slotsSnapshot()[0]?.snapshot;
    const draw = first?.gpuDrivenDraws?.[0];
    if (first === undefined || draw === undefined) throw new Error('expected source draw');
    let cpuMaterial = { ...first.material, materialHandle: 901, transparent: true };
    const applyMixed = () => {
      const delta = projection.apply([
        updateSnapshot({
          ...first,
          materials: [first.material, cpuMaterial],
          gpuDrivenDraws: [
            { ...draw, drawItemIndex: 0 },
            { ...draw, drawItemIndex: 1, materialSlot: 1 },
          ],
        }),
      ]);
      availability.scene.sync(delta).unwrap();
      topology.apply(delta);
    };
    applyMixed();
    const classes = new Map(
      projectMaterialBindingClasses(
        projection.slotsSnapshot().map(({ snapshot: source }) => ({ source })),
      ),
    );
    const prepare = () => {
      const slots = projection.slotsSnapshot();
      const frame = production
        .prepare({
          ...pbrInputs,
          scene: {
            scene: availability.scene,
            plan: topology.plan(),
            slots,
            slotAt: projection.slotAt,
          },
          camera: makeZeroCameraFallbackSnapshot(),
          meshBySlot: new Map(slots.map((slot) => [slot.slot, gpuMesh])),
          viewBindGroupLayout: viewLayout,
          meshResidencyEpoch: 1,
          materialBindingClasses: classes,
          shadowCasterMembership: [],
        })
        .unwrap();
      if (frame === undefined || frame.drawKeys === undefined)
        throw new Error('expected GPU frame');
      frame._commitResourceReplacement();
      return frame.drawKeys;
    };
    try {
      expect(prepare().size).toBe(1);
      prepare();
      classes.set(materialBindingKey(first, 901), 'forward|probe:9');
      expect(prepare().size).toBe(1);
      expect(production.inspect()).toMatchObject({
        filteredPlanBuilds: 0,
        preparedBatchBuilds: 0,
        candidateUploadBytes: 0,
        batchUploadBytes: 0,
      });
      classes.set(
        materialBindingKey(first, first.material.materialHandle ?? -1),
        'forward|probe:7',
      );
      expect(prepare().size).toBe(1);
      expect(production.inspect().filteredPlanBuilds).toBe(1);
      cpuMaterial = { ...cpuMaterial, transparent: false };
      applyMixed();
      const admitted = prepare();
      expect(admitted.size).toBe(2);
      expect(production.inspect().filteredPlanBuilds).toBe(1);
    } finally {
      production.dispose();
      availability.scene.dispose();
    }
  });

  it('skips empty shadow ownership and restores directional, point and spot views', async () => {
    const { availability, production, projection, topology, gpuMesh, viewLayout, pbrInputs } =
      await fixture(false, 2, (index) => index);
    const slots = projection.slotsSnapshot();
    const phases: string[] = [];
    const identities = [
      { kind: 'directional' as const, index: 0 },
      { kind: 'directional' as const, index: 1 },
      { kind: 'point' as const, index: 0, face: 0 },
      { kind: 'spot' as const, index: 0 },
      { kind: 'spot' as const, index: 1 },
    ];
    try {
      for (const enabled of [true, false, false, true]) {
        phases.length = 0;
        const prepared = production
          .prepare({
            ...pbrInputs,
            scene: {
              scene: availability.scene,
              plan: topology.plan(),
              slots,
              slotAt: projection.slotAt,
            },
            camera: makeZeroCameraFallbackSnapshot(),
            meshBySlot: new Map(slots.map((slot) => [slot.slot, gpuMesh] as const)),
            viewBindGroupLayout: viewLayout,
            meshResidencyEpoch: 1,
            ...(enabled ? {} : { shadowCasterMembership: [] }),
            profilePhase: (phase, action) => {
              phases.push(phase);
              return action();
            },
          })
          .unwrap();
        if (prepared === undefined) throw new Error('expected GPU frame');
        expect(prepared.drawKeys?.size).toBe(2);
        if (!enabled) {
          expect(phases.filter((phase) => phase.includes('/shadow-'))).toEqual([]);
          expect(prepared.shadowDrawKeys?.size).toBe(0);
        }
        phases.length = 0;
        expect(
          prepared.updateShadowViews?.(
            enabled
              ? identities.map((identity) => ({ identity, planes: new Float32Array(24) }))
              : [],
          ).ok,
        ).toBe(true);
        for (const identity of identities) {
          expect(prepared.shadowViewPool?.isActive(identity)).toBe(enabled);
        }
        if (!enabled) {
          expect(phases).toEqual([]);
          expect(prepared.shadowDrawKeysByView?.size).toBe(0);
        }
        prepared._commitResourceReplacement();
      }
    } finally {
      production.dispose();
      availability.scene.dispose();
    }
  });

  it.each(
    [false, true].flatMap((withLod) =>
      [8, 64, 256].map((entityCount) => ({ withLod, entityCount })),
    ),
  )('prepares $entityCount source candidates only on scene changes (LOD=$withLod)', async ({
    withLod,
    entityCount,
  }) => {
    const { availability, production, projection, topology, gpuMesh, viewLayout, pbrInputs } =
      await fixture(withLod, entityCount);
    const slots = projection.slotsSnapshot();
    const source = topology.plan();
    // A shared LOD chain never splits membership; the level is a GPU choice.
    expect(source.batches).toHaveLength(1);
    let visits = 0;
    let viewVisits = 0;
    const plan = {
      ...source,
      batches: source.batches.map((batch) => ({
        ...batch,
        candidates: new Proxy(batch.candidates, {
          get(target, key, receiver) {
            if (key === Symbol.iterator) {
              return function* () {
                for (const candidate of target) {
                  const stack = new Error().stack;
                  if (stack?.includes('prepareBatchRows')) visits += 1;
                  if (stack?.includes('buildFilteredGroups')) viewVisits += 1;
                  yield candidate;
                }
              };
            }
            return Reflect.get(target, key, receiver);
          },
        }),
      })),
    };
    try {
      for (const [index, epoch] of [1, 1, 2, 3].entries()) {
        if (index === 3) Object.assign(gpuMesh, { contentEpoch: epoch });
        visits = 0;
        viewVisits = 0;
        const prepared = production
          .prepare({
            ...pbrInputs,
            scene: { scene: availability.scene, plan, slots, slotAt: projection.slotAt },
            camera: { ...makeZeroCameraFallbackSnapshot(), position: vec3.create(0, 0, 5) },
            meshBySlot: new Map(slots.map((slot) => [slot.slot, gpuMesh] as const)),
            viewBindGroupLayout: viewLayout,
            meshResidencyEpoch: epoch,
            ...(index === 1 ? { activeEntityKeys: new Set([1]) } : {}),
          })
          .unwrap();
        expect(prepared).toBeDefined();
        expect(production.inspect().gpuOwnedEntityCount).toBe(entityCount);
        // Visibility and unrelated residency reuse facts; an in-place write refreshes them.
        const rebuilt = index === 0 || index === 3;
        expect(visits).toBe(rebuilt ? entityCount : 0);
        expect(viewVisits).toBe(rebuilt ? entityCount * 2 : 0);
      }
    } finally {
      production.dispose();
      availability.scene.dispose();
    }
  });

  it('keeps the filtered plan stable across LOD thresholds because the GPU selects the level', async () => {
    const fixtureValue = await fixture(true);
    const { availability, production, projection, topology, gpuMesh, viewLayout, pbrInputs } =
      fixtureValue;
    const slots = projection.slotsSnapshot();
    const scene = {
      scene: availability.scene,
      plan: topology.plan(),
      slots,
      slotAt: projection.slotAt,
    };
    const meshes = new Map(slots.map((slot) => [slot.slot, gpuMesh] as const));
    let phases: string[] = [];
    const prepareAt = (z: number) => {
      phases = [];
      return production
        .prepare({
          ...pbrInputs,
          scene,
          camera: { ...makeZeroCameraFallbackSnapshot(), position: vec3.create(0, 0, z) },
          meshBySlot: meshes,
          viewBindGroupLayout: viewLayout,
          meshResidencyEpoch: 1,
          profilePhase: (phase, action) => {
            phases.push(phase);
            return action();
          },
        })
        .unwrap();
    };

    expect(prepareAt(5)).toBeDefined();
    expect(production.inspect()).toMatchObject({
      filteredPlanBuilds: 1,
      planRebuildBatches: scene.plan.batches.length,
      planRebuildCandidates: 2,
      lodSelectionChanges: 0,
      candidateUploadBytes: 2 * 304,
    });
    expect(phases).toEqual([
      'record/gpu-driven-prepare/plan',
      'record/gpu-driven-prepare/plan/rows',
      'record/gpu-driven-prepare/plan/admission',
      'record/gpu-driven-prepare/filter',
      'record/gpu-driven-prepare/filter/lod',
      'record/gpu-driven-prepare/filter/lod/projection',
      'record/gpu-driven-prepare/filter/lod/selection',
      'record/gpu-driven-prepare/filter/lod/identity',
      'record/gpu-driven-prepare/filter/main-plan',
      'record/gpu-driven-prepare/filter/main-plan/groups',
      'record/gpu-driven-prepare/filter/main-plan/groups/key',
      'record/gpu-driven-prepare/filter/main-plan/groups/key',
      'record/gpu-driven-prepare/filter/main-plan/batches',
      'record/gpu-driven-prepare/filter/counts',
      'record/gpu-driven-prepare/filter/shadow-ownership',
      'record/gpu-driven-prepare/filter/shadow-plan',
      'record/gpu-driven-prepare/filter/shadow-plan/groups',
      'record/gpu-driven-prepare/filter/shadow-plan/groups/key',
      'record/gpu-driven-prepare/filter/shadow-plan/groups/key',
      'record/gpu-driven-prepare/filter/shadow-plan/batches',
      'record/gpu-driven-prepare/filter/admission',
    ]);

    expect(prepareAt(5.1)).toBeDefined();
    expect(production.inspect()).toMatchObject({
      filteredPlanBuilds: 0,
      preparedBatchBuilds: 0,
      planRebuildBatches: 0,
      planRebuildCandidates: 0,
      lodSelectionChanges: 0,
      candidateUploadBytes: 0,
      batchUploadBytes: 0,
      batchCount: 1,
    });
    // The plan checks retained facts; default Main bindings need no further walk.
    expect(phases).toEqual([
      'record/gpu-driven-prepare/plan',
      'record/gpu-driven-prepare/plan/rows',
      'record/gpu-driven-prepare/filter',
      'record/gpu-driven-prepare/filter/lod',
      'record/gpu-driven-prepare/filter/lod/projection',
      'record/gpu-driven-prepare/filter/lod/selection',
      'record/gpu-driven-prepare/filter/lod/identity',
      'record/gpu-driven-prepare/filter/counts',
      'record/gpu-driven-prepare/filter/shadow-ownership',
      'record/gpu-driven-prepare/filter/admission',
    ]);

    // Crossing a LOD threshold is GPU-selected: no plan rebuild, no candidate
    // or height upload. The CPU mirror still counts the selection change.
    expect(prepareAt(50)).toBeDefined();
    expect(production.inspect()).toMatchObject({
      filteredPlanBuilds: 0,
      planRebuildBatches: 0,
      lodSelectionChanges: 2,
      candidateUploadBytes: 0,
      batchUploadBytes: 0,
    });

    production.dispose();
    availability.scene.dispose();
  });

  it('keeps LOD membership and the filtered plan after a root matrix-only scene update', async () => {
    const fixtureValue = await fixture(true);
    const { availability, production, projection, topology, gpuMesh, viewLayout, pbrInputs } =
      fixtureValue;
    const slots = projection.slotsSnapshot();
    const camera = { ...makeZeroCameraFallbackSnapshot(), position: vec3.create(0, 0, 5) };
    const scene = {
      scene: availability.scene,
      plan: topology.plan(),
      slots,
      slotAt: projection.slotAt,
    };
    const meshes = new Map(slots.map((slot) => [slot.slot, gpuMesh] as const));

    const first = production
      .prepare({
        ...pbrInputs,
        scene,
        camera,
        meshBySlot: meshes,
        viewBindGroupLayout: viewLayout,
        meshResidencyEpoch: 1,
      })
      .unwrap();
    expect(first).toBeDefined();
    // One batch, one indirect command per LOD level.
    expect(production.inspect()).toMatchObject({
      filteredPlanBuilds: 1,
      batchCount: 1,
      indirectDrawCount: 2,
    });

    const movedDelta = projection.apply([updateWorld(2, 50)]);
    expect(movedDelta.updated).toBe(1);
    expect(movedDelta.contentUpdatedSlots).toHaveLength(0);
    expect(movedDelta.instanceUpdatedSlots).toHaveLength(0);
    expect(projection.slotsSnapshot()).toBe(slots);
    availability.scene.sync(movedDelta).unwrap();

    const moved = production
      .prepare({
        ...pbrInputs,
        scene,
        camera,
        meshBySlot: meshes,
        viewBindGroupLayout: viewLayout,
        meshResidencyEpoch: 1,
      })
      .unwrap();
    expect(moved).toBeDefined();
    expect(production.inspect()).toMatchObject({
      filteredPlanBuilds: 0,
      batchCount: 1,
      indirectDrawCount: 2,
      candidateUploadBytes: 0,
    });

    production.dispose();
    availability.scene.dispose();
  });

  it('reuses an unchanged no-LOD source after a root matrix-only update', async () => {
    const fixtureValue = await fixture(false);
    const { availability, production, projection, topology, gpuMesh, viewLayout, pbrInputs } =
      fixtureValue;
    const slots = projection.slotsSnapshot();
    const camera = { ...makeZeroCameraFallbackSnapshot(), position: vec3.create(0, 0, 5) };
    const scene = {
      scene: availability.scene,
      plan: topology.plan(),
      slots,
      slotAt: projection.slotAt,
    };
    const meshes = new Map(slots.map((slot) => [slot.slot, gpuMesh] as const));
    const prepare = () =>
      production
        .prepare({
          ...pbrInputs,
          scene,
          camera,
          meshBySlot: meshes,
          viewBindGroupLayout: viewLayout,
          meshResidencyEpoch: 1,
        })
        .unwrap();

    expect(prepare()).toBeDefined();
    expect(production.inspect().filteredPlanBuilds).toBe(1);
    const movedDelta = projection.apply([updateWorld(2, 50)]);
    availability.scene.sync(movedDelta).unwrap();
    expect(prepare()).toBeDefined();
    expect(production.inspect()).toMatchObject({
      filteredPlanBuilds: 0,
      batchCount: 1,
      indirectDrawCount: 1,
    });

    production.dispose();
    availability.scene.dispose();
  });
});
const TRANSFORM_FLOATS = GPU_SCENE_LAYOUTS.transform.stride / 4;
const PREVIOUS_FLOAT = TRANSFORM_FLOATS / 2;

/**
 * CPU mirror of the GPU Scene transform table, fed by queue writes, plus a
 * per-buffer byte ledger so a test can prove which tables a phase touched.
 */
function mirrorSceneWrites(device: RhiNullDevice, scene: GpuScene) {
  const transforms = new Float32Array(scene.rowCapacity * TRANSFORM_FLOATS);
  const bytesByBuffer = new Map<unknown, number>();
  const createBuffer = device.createBuffer.bind(device);
  const createdLabels: string[] = [];
  vi.spyOn(device, 'createBuffer').mockImplementation((descriptor) => {
    createdLabels.push(descriptor.label ?? '');
    return createBuffer(descriptor);
  });
  const writeBuffer = device.queue.writeBuffer.bind(device.queue);
  vi.spyOn(device.queue, 'writeBuffer').mockImplementation((buffer, offset, data, ...rest) => {
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    bytesByBuffer.set(buffer, (bytesByBuffer.get(buffer) ?? 0) + bytes.byteLength);
    if (buffer === scene.transformBuffer) {
      new Uint8Array(transforms.buffer).set(bytes, offset);
    }
    return writeBuffer(buffer, offset, data, ...rest);
  });
  return {
    createdLabels,
    /** Bytes written per buffer since the last call. */
    drain() {
      const drained = new Map(bytesByBuffer);
      bytesByBuffer.clear();
      return drained;
    },
    /** Transform rows whose current world translation z equals `z`. */
    rowsAt(z: number) {
      const found: Float32Array[] = [];
      for (let base = 0; base + TRANSFORM_FLOATS <= transforms.length; base += TRANSFORM_FLOATS) {
        if (transforms[base + 14] === z)
          found.push(transforms.subarray(base, base + TRANSFORM_FLOATS));
      }
      return found;
    },
  };
}

describe('GPU-driven dirty scene rows', () => {
  const BATCHES = 64;
  const PER_BATCH = 64;

  it('uploads only the moved transform row of 64 x 64 retained batches', async () => {
    const {
      device,
      availability,
      production,
      projection,
      topology,
      gpuMesh,
      viewLayout,
      pbrInputs,
    } = await fixture(false, BATCHES * PER_BATCH, (index) => index % BATCHES);
    const gpuScene = availability.scene;
    const mirror = mirrorSceneWrites(device, gpuScene);
    const slots = projection.slotsSnapshot();
    const scene = { scene: gpuScene, plan: topology.plan(), slots, slotAt: projection.slotAt };
    const meshes = new Map(slots.map((slot) => [slot.slot, gpuMesh] as const));
    let projected = false;
    const frame = (temporal: boolean) => {
      const prepared = production
        .prepare({
          ...pbrInputs,
          scene,
          camera: { ...makeZeroCameraFallbackSnapshot(), position: vec3.create(0, 0, 5) },
          meshBySlot: meshes,
          viewBindGroupLayout: viewLayout,
          meshResidencyEpoch: 1,
          ...(temporal ? { temporalSources: [] } : {}),
        })
        .unwrap();
      if (prepared === undefined) throw new Error('expected a prepared GPU-driven frame');
      // The graph is cached by topology: only the first frame projects it.
      if (!projected) {
        prepared.project(new RenderGraphBuilder<RenderPipelineFrame>(), 'rgba8unorm', 1).unwrap();
        projected = true;
      }
      prepared._commitResourceReplacement();
      return { prepared, inspection: production.inspect() };
    };
    const sceneTables = new Set<unknown>([
      gpuScene.primitiveBuffer,
      gpuScene.instanceBuffer,
      gpuScene.transformBuffer,
      gpuScene.drawTemplateBuffer,
      gpuScene.materialBuffer,
    ]);
    try {
      const first = frame(false);
      expect(first.inspection).toMatchObject({
        batchCount: BATCHES,
        gpuOwnedEntityCount: BATCHES * PER_BATCH,
        preparedBatchBuilds: topology.plan().batches.length,
      });
      // Scene-index draws read the shared GPU Scene tables; no per-draw Mesh
      // row copy exists to keep in sync.
      expect(mirror.createdLabels.filter((label) => label.includes('scene-meshes'))).toEqual([]);
      for (const temporal of [false, true]) {
        for (let step = 0; step < 10; step += 1) {
          const entityIndex = (step * 97 + (temporal ? 13 : 0)) % (BATCHES * PER_BATCH);
          const z = 100 + step + (temporal ? 50 : 0);
          mirror.drain();
          const delta = projection.apply([updateWorld(entityIndex + 1, z, entityIndex % BATCHES)]);
          gpuScene.sync(delta, undefined, (slot) => projection.cullingWorldBoundsAt(slot)).unwrap();
          const synced = mirror.drain();
          expect(synced.get(gpuScene.transformBuffer)).toBe(GPU_SCENE_LAYOUTS.transform.stride);
          const moved = frame(temporal);
          expect(moved.prepared.topologySignature).toBe(first.prepared.topologySignature);
          expect(moved.inspection).toMatchObject({
            preparedBatchBuilds: 0,
            filteredBatchBuilds: 0,
            filteredPlanBuilds: 0,
          });
          const prepareWrites = mirror.drain();
          for (const buffer of sceneTables) expect(prepareWrites.has(buffer)).toBe(false);
          expect(mirror.rowsAt(z)).toHaveLength(1);
        }
      }
    } finally {
      production.dispose();
      availability.scene.dispose();
    }
  }, 60_000);

  // Falsifier for the retired prev = current quirk: a moving object without
  // LOD must carry its previous pose too, or TAA sees a zero motion vector.
  it.each([
    true,
    false,
  ])('carries the committed previous pose on moving transform rows (LOD=%s)', async (withLod) => {
    const { device, availability, projection } = await fixture(withLod, 4);
    const gpuScene = availability.scene;
    const mirror = mirrorSceneWrites(device, gpuScene);
    try {
      gpuScene.commitTemporalFrame().unwrap();
      let previousZ = 0;
      for (const z of [-1, -2, -3]) {
        gpuScene.sync(projection.apply([updateWorld(2, z)])).unwrap();
        const row = mirror.rowsAt(z)[0];
        expect(row).toBeDefined();
        if (row === undefined) return;
        expect(row[PREVIOUS_FLOAT + 14]).toBe(previousZ);
        expect(row[PREVIOUS_FLOAT + 14]).not.toBe(row[14]);
        gpuScene.commitTemporalFrame().unwrap();
        previousZ = z;
      }
      // One committed frame after the stop, prev settles to current.
      gpuScene.sync(projection.apply([])).unwrap();
      const settled = mirror
        .rowsAt(previousZ)
        .find((row) => row[PREVIOUS_FLOAT + 14] === previousZ);
      expect(settled).toBeDefined();
    } finally {
      availability.scene.dispose();
    }
  });
});
