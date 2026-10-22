import { deriveVertexLayoutProjection } from '@forgeax/engine-geometry';
import { vec3 } from '@forgeax/engine-math';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { type RhiNullDevice, rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import type { MeshGpuHandles } from '../device/gpu-residency';
import { BatchTopology } from '../gpu-driven/batch-topology';
import type { GpuDrawSelection } from '../gpu-driven/draw-selection';
import { GpuDrivenProduction } from '../gpu-driven/production-raster';
import {
  type PreparedProductionPlan,
  prepareBatchRows,
} from '../gpu-driven/production-raster-prepare';
import { GpuBuffer } from '../gpu-resource';
import { GpuScene } from '../gpu-scene';
import { GPU_SCENE_LAYOUTS } from '../gpu-scene-schema';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_INDEX,
  GPU_BUFFER_USAGE_VERTEX,
} from '../gpu-usage';
import { MaterialResource } from '../material-resource';
import { makeZeroCameraFallbackSnapshot } from '../record/frame-snapshot';
import type { RenderPipelineFrame } from '../render-pipeline';
import type { RenderableSnapshot } from '../render-system-extract';
import { RenderScene } from '../scene/render-scene';
import { observeCandidateReads } from './gpu-driven-candidate-read-observer';
import {
  admitGpuFixture,
  preparedPbrSnapshot,
  standardPbrInputs,
} from './gpu-driven-production-fixture';
import { observeGpuInputBytes } from './helpers/gpu-input-bytes';

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
  const material = new MaterialResource({
    baseColor: vec3.create(1, 1, 1),
    metallic: 0,
    roughness: 1,
    passes: [],
    materialShaderId: 'forgeax::default-unlit',
  });
  const source: Parameters<typeof preparedPbrSnapshot>[0] = {
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
  const shared = new Map<number, MaterialResource>();
  const delta = projection.apply(
    Array.from({ length: entityCount }, (_, index) => {
      const source = snapshot(index + 1, withLod, worldOf(index));
      const material = shared.get(source.worldId) ?? source.material;
      shared.set(source.worldId, material);
      return updateSnapshot({ ...source, material, materials: [material] });
    }),
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

function selectedCount(
  selection: GpuDrawSelection,
  slots: ReturnType<RenderScene['slotsSnapshot']>,
): number {
  return slots.reduce(
    (sum, slot) =>
      sum +
      (slot.snapshot.gpuDrivenDraws ?? []).filter((draw, index) =>
        selection.ownsSlot(slot.snapshot, draw.drawItemIndex ?? index, slot.slot, slot.generation),
      ).length,
    0,
  );
}

describe('GPU-driven filtered-plan cache', () => {
  it.each([
    false,
    true,
  ])('observes raw membership growth and removal through partitions and LOD (bindings=%s)', async (bindings) => {
    const f = await fixture(true, 1);
    const source = f.topology.query(f.topology.sourcePlan(), undefined);
    const batch = source.batches.at(0);
    const member = batch?.members?.at(0);
    const candidate = batch?.candidates.at(0);
    if (batch === undefined || member === undefined || candidate === undefined)
      throw Error('expected source membership');
    const candidates = [candidate];
    const members = [member];
    const mutableBatch = { ...batch, candidates, members };
    const plan = { ...source, batches: [mutableBatch] };
    const slots = f.projection.slotsSnapshot();
    const bytes = observeGpuInputBytes(f.device);
    const classes = bindings ? new Map([[`0:${member.entityKey}`, 'probe:0']]) : undefined;
    const cachedLodCount = () =>
      (
        f.production as unknown as {
          preparations: { forward: { cached: { value: PreparedProductionPlan } } };
        }
      ).preparations.forward.cached.value.lodPlan.groups.reduce(
        (sum, group) => sum + group.candidateCount,
        0,
      );
    const prepare = (z: number) => {
      const input = admitGpuFixture({
        ...f.pbrInputs,
        scene: { scene: f.availability.scene, plan, slots, slotAt: f.projection.slotAt },
        camera: { ...makeZeroCameraFallbackSnapshot(), position: vec3.create(0, 0, z) },
        meshBySlot: new Map(slots.map((slot) => [slot.slot, f.gpuMesh])),
        viewBindGroupLayout: f.viewLayout,
        ...(classes === undefined ? {} : { materialBindingClasses: classes }),
      });
      const frame = f.production.prepare(input).unwrap();
      if (frame === undefined) throw Error('expected prepared frame');
      frame._commitResourceReplacement();
      return bytes.header().getUint32(4, true);
    };
    try {
      expect(prepare(5)).toBe(1);
      candidates.push({ ...candidate });
      members[0] = { ...member, instanceCount: 2 };
      expect(prepare(5)).toBe(2);
      expect(bytes.members()).toHaveLength(2);
      expect(prepare(50)).toBe(2);
      expect(cachedLodCount()).toBe(2);
      // The mutable batch itself remains identical through raw -> canonical A
      // -> canonical B. Only captured row/root facts can qualify reuse.
      Object.assign(mutableBatch, { candidates: batch.candidates, members: batch.members });
      expect(prepare(5)).toBe(1);
      expect(cachedLodCount()).toBe(1);
      const original = slots.at(0)?.snapshot;
      if (original === undefined) throw Error('expected source snapshot');
      const transforms = new Float32Array(32);
      transforms.set(original.transform.world);
      transforms.set(original.transform.world, 16);
      const delta = f.projection.apply([
        updateSnapshot({
          ...original,
          instances: {
            instanceCount: 2,
            transforms,
            cacheKey: 1,
            archVersion: 1,
          },
        }),
      ]);
      f.availability.scene.sync(delta).unwrap();
      f.topology.apply(delta);
      const next = f.topology.query(f.topology.sourcePlan(), undefined);
      const nextBatch = next.batches.at(0);
      if (nextBatch === undefined) throw Error('expected new canonical root');
      Object.assign(plan, { sourceGroups: next.sourceGroups });
      Object.assign(mutableBatch, {
        candidates: nextBatch.candidates,
        members: nextBatch.members,
      });
      expect(prepare(5)).toBe(2);
      expect(cachedLodCount()).toBe(2);
      expect(prepare(5)).toBe(2);
      expect(f.production.inspect().preparedBatchBuilds).toBe(0);
      Object.assign(mutableBatch, { candidates, members });
      candidates[0] = { ...candidate, generation: candidate.generation + 1 };
      expect(prepare(5)).toBe(2);
      expect(bytes.members()[0]?.generation).toBe(candidate.generation + 1);
      candidates[0] = candidate;
      candidates.pop();
      members[0] = member;
      expect(prepare(5)).toBe(1);
      expect(bytes.members()).toHaveLength(1);
      expect(cachedLodCount()).toBe(1);
    } finally {
      bytes.close();
      f.production.dispose();
      f.availability.scene.dispose();
    }
  });

  it.each([
    false,
    true,
  ])('captures LOD columns and observes raw edits on reuse (resident=%s)', async (resident) => {
    const f = await fixture(resident, 1);
    const source = f.topology.query(f.topology.sourcePlan(), undefined);
    const batch = source.batches.at(0);
    if (batch?.binding === undefined) throw Error('expected shared batch');
    const coverages = [1, 0.5];
    const range = { first: 3, count: 1, baseVertex: 0 };
    const ranges: (typeof range | undefined)[] = [range];
    if (resident) Object.assign(f.gpuMesh, { lodRanges: [[batch.key], [range]] });
    const rawBatch = { ...batch, lod: { coverages, ranges, hysteresis: 0.08, crossfade: true } };
    const plan = { ...source, batches: [rawBatch] };
    const slots = f.projection.slotsSnapshot();
    const admitted = admitGpuFixture({
      ...f.pbrInputs,
      scene: { scene: f.availability.scene, plan, slots, slotAt: f.projection.slotAt },
      camera: makeZeroCameraFallbackSnapshot(),
      meshBySlot: new Map(slots.map((slot) => [slot.slot, f.gpuMesh])),
      viewBindGroupLayout: f.viewLayout,
    });
    const execution = admitted.batchExecutions.get(batch.binding)?.forward;
    if (execution?.route !== 'gpu') throw Error('expected GPU execution');
    const captured = prepareBatchRows(rawBatch, {
      mesh: f.gpuMesh,
      execution,
      worldKeys: undefined,
    });
    const bytes = observeGpuInputBytes(f.device);
    const prepare = () => {
      const frame = f.production.prepare(admitted).unwrap();
      if (frame === undefined) throw Error('expected prepared frame');
      return frame;
    };
    // Bounded actual task header, level 1: first/count/base/coverage.
    const row = () => {
      const header = bytes.header();
      return [
        header.getUint32(52 + 32 + 8, true),
        header.getUint32(52 + 32 + 12, true),
        header.getInt32(52 + 32 + 16, true),
        header.getFloat32(52 + 32 + 20, true),
      ];
    };
    try {
      prepare()._commitResourceReplacement();
      expect(row()).toEqual([3, 1, 0, 0.5]);
      coverages[1] = 0.25;
      range.first = 7;
      range.count = 2;
      range.baseVertex = -1;
      expect(captured.lod).toEqual({
        coverages: [1, 0.5],
        ranges: [{ first: 3, count: 1, baseVertex: 0 }],
        hysteresis: 0.08,
        crossfade: true,
      });
      prepare()._commitResourceReplacement();
      expect(row()).toEqual([7, 2, -1, 0.25]);
      expect(f.production.inspect().preparedBatchBuilds).toBe(1);
      prepare()._commitResourceReplacement();
      expect(f.production.inspect().preparedBatchBuilds).toBe(0);
      expect(f.production.inspect().batchUploadBytes).toBe(0);
      ranges[0] = undefined;
      if (resident) Object.assign(f.gpuMesh, { lodRanges: [[batch.key], [undefined]] });
      prepare()._commitResourceReplacement();
      expect(row()).toEqual([batch.key.first, batch.key.count, batch.key.baseVertex, 0.25]);
      expect(captured.lod?.ranges?.[0]?.first).toBe(3);
    } finally {
      bytes.close();
      f.production.dispose();
      f.availability.scene.dispose();
    }
  });

  it('retains default bindings and adopts immutable object binding publications', async () => {
    const { availability, production, projection, topology, gpuMesh, viewLayout, pbrInputs } =
      await fixture(false, 64);
    let classes: ReadonlyMap<string, string> = new Map();
    const slots = projection.slotsSnapshot();
    const first = slots.at(0)?.snapshot;
    if (first === undefined) throw Error('expected first receiver');
    let filteredCalls = 0;
    const prepare = (bindings: ReadonlyMap<string, string> | undefined = classes) => {
      const frame = production
        .prepare(
          admitGpuFixture({
            ...pbrInputs,
            scene: {
              scene: availability.scene,
              plan: topology.query(topology.sourcePlan(), undefined),
              slots: projection.slotsSnapshot(),
              slotAt: projection.slotAt,
            },
            camera: makeZeroCameraFallbackSnapshot(),
            meshBySlot: new Map(slots.map((slot) => [slot.slot, gpuMesh])),
            viewBindGroupLayout: viewLayout,
            ...(bindings === undefined ? {} : { materialBindingClasses: bindings }),
            profilePhase: (phase, action) => {
              if (phase === 'record/gpu-driven-prepare/filter/main-plan') filteredCalls++;
              return action();
            },
          }),
        )
        .unwrap();
      if (frame === undefined) throw Error('expected GPU frame');
      expect(selectedCount(frame.selection, slots)).toBe(64);
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
        expect(prepare(classes).filteredPlanBuilds).toBe(0);
      }
      expect(filteredCalls).toBe(1);
      classes = new Map([[`${first.worldId}:${first.entityKey}`, 'probe:7']]);
      expect(prepare().indirectDrawCount).toBe(2);
      expect(filteredCalls).toBe(2);
      classes = new Map();
      expect(prepare().indirectDrawCount).toBe(1);
      expect(filteredCalls).toBe(3);
      expect(prepare().filteredPlanBuilds).toBe(0);
      expect(filteredCalls).toBe(3);
      // A same-cardinality mesh content edit must still refresh the prepared rows.
      Object.assign(gpuMesh, { contentEpoch: gpuMesh.contentEpoch + 1 });
      expect(prepare().preparedBatchBuilds).toBeGreaterThan(0);
      expect(filteredCalls).toBe(4);
    } finally {
      production.dispose();
      availability.scene.dispose();
    }
  });

  it('invalidates bindings only for prepared GPU draws while retaining CPU material classes', async () => {
    const { availability, production, projection, topology, gpuMesh, viewLayout, pbrInputs } =
      await fixture(false, 64);
    const cpuBase = snapshot(9001, false);
    const cpuMaterial = new MaterialResource({ ...cpuBase.material.snapshot, materialHandle: 900 });
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
    const stablePlan = topology.query(topology.sourcePlan(), undefined);
    const observations: Array<{
      phase: string;
      preparedBatchBuilds: number;
      filteredPlanBuilds: number;
      sharedInputUploadBytes: number;
      batchUploadBytes: number;
      drawCount: number;
    }> = [];
    let classes = new Map(
      projection
        .slotsSnapshot()
        .map(({ snapshot }) => [`${snapshot.worldId}:${snapshot.entityKey}`, 'probe:0']),
    );
    const prepare = (
      phase: string,
      edit?: (classes: Map<string, string>) => Map<string, string>,
    ) => {
      const slots = projection.slotsSnapshot();
      expect(classes.has(`${cpuSource.worldId}:${cpuSource.entityKey}`)).toBe(true);
      if (edit !== undefined) classes = edit(classes);
      const frame = production
        .prepare(
          admitGpuFixture({
            ...pbrInputs,
            scene: {
              scene: availability.scene,
              plan: topology.query(topology.sourcePlan(), undefined),
              slots,
              slotAt: projection.slotAt,
            },
            camera: makeZeroCameraFallbackSnapshot(),
            meshBySlot: new Map(slots.map((slot) => [slot.slot, gpuMesh])),
            viewBindGroupLayout: viewLayout,
            materialBindingClasses: classes,
          }),
        )
        .unwrap();
      if (frame === undefined) throw new Error('expected GPU frame');
      const { preparedBatchBuilds, filteredPlanBuilds, sharedInputUploadBytes, batchUploadBytes } =
        production.inspect();
      observations.push({
        phase,
        preparedBatchBuilds,
        filteredPlanBuilds,
        sharedInputUploadBytes,
        batchUploadBytes,
        drawCount: selectedCount(frame.selection, slots),
      });
      frame._commitResourceReplacement();
    };
    try {
      prepare('initial');
      prepare('stable');
      const swapped = new MaterialResource({ ...cpuMaterial.snapshot, materialHandle: 901 });
      cpuSource = { ...cpuSource, material: swapped, materials: [swapped] };
      apply(cpuSource);
      expect(topology.query(topology.sourcePlan(), undefined)).toBe(stablePlan);
      prepare('cpu-material-swap');
      prepare('map-order-only', (classes) => new Map([...classes].reverse()));
      const changeGpuBinding = (previous: Map<string, string>) => {
        const classes = new Map(previous);
        const first = projection.slotsSnapshot().at(0)?.snapshot;
        if (first === undefined) throw new Error('expected GPU source');
        classes.set(`${first.worldId}:${first.entityKey}`, 'probe:7');
        return classes;
      };
      prepare('gpu-binding-change', changeGpuBinding);
      cpuSource = cpuBase;
      apply(cpuSource);
      expect(topology.query(topology.sourcePlan(), undefined)).not.toBe(stablePlan);
      prepare('cpu-promoted-to-gpu', changeGpuBinding);
      const stable = (phase: string) => ({
        phase,
        preparedBatchBuilds: 0,
        filteredPlanBuilds: 0,
        sharedInputUploadBytes: 0,
        batchUploadBytes: 0,
        drawCount: 64,
      });
      expect(observations.slice(1, 4), JSON.stringify(observations)).toEqual([
        stable('stable'),
        // Four radix pages plus the new 12-byte descriptor; GPU task headers stay fixed.
        { ...stable('cpu-material-swap'), sharedInputUploadBytes: 4 * 1024 + 12 },
        { ...stable('map-order-only'), filteredPlanBuilds: 1 },
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

  it('shares object bindings across submeshes while material adoption changes execution', async () => {
    const f = await fixture(false, 1);
    const slot = f.projection.slotsSnapshot().at(0);
    const source = slot?.snapshot;
    const draw = source?.gpuDrivenDraws?.[0];
    if (slot === undefined || source === undefined || draw === undefined)
      throw Error('missing source');
    const cpu = new MaterialResource({
      ...source.material.snapshot,
      passes: source.material.snapshot.passes.map((pass) => ({
        ...pass,
        renderState: { ...pass.renderState, blend: { color: {}, alpha: {} } },
      })),
    });
    const delta = f.projection.apply([
      updateSnapshot({
        ...source,
        materials: [source.material, cpu],
        gpuDrivenDraws: [
          { ...draw, drawItemIndex: 0 },
          { ...draw, drawItemIndex: 1, materialSlot: 1 },
        ],
      }),
    ]);
    f.availability.scene.sync(delta).unwrap();
    f.topology.apply(delta);
    const plan = f.topology.query(f.topology.sourcePlan(), undefined);
    const slots = f.projection.slotsSnapshot();
    const classes = new Map([[`${source.worldId}:${source.entityKey}`, 'probe:7']]);
    const prepare = () => {
      const frame = f.production
        .prepare(
          admitGpuFixture({
            ...f.pbrInputs,
            scene: {
              scene: f.availability.scene,
              plan: f.topology.query(f.topology.sourcePlan(), undefined),
              slots,
              slotAt: f.projection.slotAt,
            },
            camera: makeZeroCameraFallbackSnapshot(),
            meshBySlot: new Map([[slot.slot, f.gpuMesh]]),
            viewBindGroupLayout: f.viewLayout,
            materialBindingClasses: classes,
          }),
        )
        .unwrap();
      if (frame === undefined) throw Error('missing frame');
      const count = selectedCount(frame.selection, slots);
      frame._commitResourceReplacement();
      return count;
    };
    try {
      expect(prepare()).toBe(1);
      expect(prepare()).toBe(1);
      expect(f.production.inspect()).toMatchObject({
        filteredPlanBuilds: 0,
        preparedBatchBuilds: 0,
        sharedInputUploadBytes: 0,
        batchUploadBytes: 0,
      });
      cpu.adopt({ ...cpu.snapshot, passes: source.material.snapshot.passes });
      f.availability.scene.sync({ ...f.projection.apply([]), materialUpdates: [cpu] }).unwrap();
      expect(f.topology.query(f.topology.sourcePlan(), undefined)).toBe(plan);
      expect(prepare()).toBe(2);
      expect(f.production.inspect().planRebuildCandidates).toBe(0);
    } finally {
      f.production.dispose();
      f.availability.scene.dispose();
    }
  });

  it('skips empty shadow ownership and restores directional, point and spot views', async () => {
    const { availability, production, projection, topology, gpuMesh, viewLayout, pbrInputs } =
      await fixture(false, 2, (index) => index);
    const slots = projection.slotsSnapshot();
    for (const slot of slots)
      slot.snapshot.material.adopt({
        ...slot.snapshot.material.snapshot,
        passes: [
          ...slot.snapshot.material.snapshot.passes,
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
    availability.scene
      .sync({
        ...projection.apply([]),
        materialUpdates: slots.map((slot) => slot.snapshot.material),
      })
      .unwrap();
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
          .prepare(
            admitGpuFixture({
              ...pbrInputs,
              scene: {
                scene: availability.scene,
                plan: topology.query(topology.sourcePlan(), undefined),
                slots,
                slotAt: projection.slotAt,
              },
              camera: makeZeroCameraFallbackSnapshot(),
              meshBySlot: new Map(slots.map((slot) => [slot.slot, gpuMesh] as const)),
              viewBindGroupLayout: viewLayout,
              shadowViews: enabled,
              profilePhase: (phase, action) => {
                phases.push(phase);
                return action();
              },
            }),
          )
          .unwrap();
        if (prepared === undefined) throw new Error('expected GPU frame');
        expect(selectedCount(prepared.selection, slots)).toBe(2);
        if (!enabled) {
          expect(phases.filter((phase) => phase.includes('/shadow-'))).toEqual([]);
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
          expect(prepared.shadowBatchProjections?.size ?? 0).toBe(0);
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
    const source = topology.query(topology.sourcePlan(), undefined);
    // A shared LOD chain never splits membership; the level is a GPU choice.
    expect(source.batches).toHaveLength(1);
    let visits = 0;
    let viewVisits = 0;
    const plan = source;
    const stopObserving = observeCandidateReads(
      source.batches.map((batch) => batch.candidates),
      () => {
        const stack = new Error().stack;
        if (stack?.includes('prepareBatchRows')) visits++;
        if (stack?.includes('buildFilteredGroups')) viewVisits++;
      },
    );
    function prepareBatchRowsControl() {
      return Array.from(source.batches.at(0)?.candidates ?? []);
    }
    expect(prepareBatchRowsControl()).toHaveLength(entityCount);
    expect(visits).toBeGreaterThan(0);
    visits = 0;
    try {
      for (const [index, epoch] of [1, 1, 2, 3].entries()) {
        if (index === 3) Object.assign(gpuMesh, { contentEpoch: epoch });
        visits = 0;
        viewVisits = 0;
        const prepared = production
          .prepare(
            admitGpuFixture({
              ...pbrInputs,
              scene: { scene: availability.scene, plan, slots, slotAt: projection.slotAt },
              camera: { ...makeZeroCameraFallbackSnapshot(), position: vec3.create(0, 0, 5) },
              meshBySlot: new Map(slots.map((slot) => [slot.slot, gpuMesh] as const)),
              viewBindGroupLayout: viewLayout,
              ...(index === 1 ? { activeEntityKeys: new Set([1]) } : {}),
            }),
          )
          .unwrap();
        expect(prepared).toBeDefined();
        expect(prepared).toBeDefined();
        if (prepared === undefined) throw Error('missing GPU frame');
        expect(selectedCount(prepared.selection, slots)).toBe(entityCount);
        prepared._commitResourceReplacement();
        // Visibility and unrelated residency reuse facts; an in-place write refreshes them.
        expect(visits).toBe(0);
        expect(viewVisits).toBe(0);
      }
    } finally {
      stopObserving();
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
      plan: topology.query(topology.sourcePlan(), undefined),
      slots,
      slotAt: projection.slotAt,
    };
    const meshes = new Map(slots.map((slot) => [slot.slot, gpuMesh] as const));
    let phases: string[] = [];
    const prepareAt = (z: number) => {
      phases = [];
      const prepared = production
        .prepare(
          admitGpuFixture({
            ...pbrInputs,
            scene,
            camera: { ...makeZeroCameraFallbackSnapshot(), position: vec3.create(0, 0, z) },
            meshBySlot: meshes,
            viewBindGroupLayout: viewLayout,
            profilePhase: (phase, action) => {
              phases.push(phase);
              return action();
            },
          }),
        )
        .unwrap();
      prepared?._commitResourceReplacement();
      return prepared;
    };

    expect(prepareAt(5)).toBeDefined();
    expect(production.inspect()).toMatchObject({
      filteredPlanBuilds: 1,
      planRebuildBatches: scene.plan.batches.length,
      planRebuildCandidates: 0,
      lodSelectionChanges: 0,
    });
    expect(production.inspect().sharedInputUploadBytes).toBeGreaterThan(0);
    expect(phases).toContain('record/gpu-driven-prepare/filter/main-plan');

    expect(prepareAt(5.1)).toBeDefined();
    expect(production.inspect()).toMatchObject({
      filteredPlanBuilds: 0,
      preparedBatchBuilds: 0,
      planRebuildBatches: 0,
      planRebuildCandidates: 0,
      lodSelectionChanges: 0,
      sharedInputUploadBytes: 0,
      batchUploadBytes: 0,
      batchCount: 1,
    });
    // The plan checks retained facts; default Main bindings need no further walk.
    expect(phases).not.toContain('record/gpu-driven-prepare/filter/main-plan');

    // Crossing a LOD threshold is GPU-selected: no plan rebuild, no candidate
    // or height upload. The CPU mirror still counts the selection change.
    expect(prepareAt(50)).toBeDefined();
    expect(production.inspect()).toMatchObject({
      filteredPlanBuilds: 0,
      planRebuildBatches: 0,
      lodSelectionChanges: 2,
      sharedInputUploadBytes: 0,
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
      plan: topology.query(topology.sourcePlan(), undefined),
      slots,
      slotAt: slots.slotAt,
    };
    const meshes = new Map(slots.map((slot) => [slot.slot, gpuMesh] as const));

    const first = production
      .prepare(
        admitGpuFixture({
          ...pbrInputs,
          scene,
          camera,
          meshBySlot: meshes,
          viewBindGroupLayout: viewLayout,
        }),
      )
      .unwrap();
    expect(first).toBeDefined();
    first?._commitResourceReplacement();
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
    expect(slots.at(1)?.snapshot.transform.world[14]).toBe(0);
    expect(projection.slotsSnapshot().at(1)?.snapshot.transform.world[14]).toBe(50);
    availability.scene.sync(movedDelta).unwrap();
    const movedSlots = projection.slotsSnapshot();
    expect(movedSlots.slotAt).not.toBe(slots.slotAt);

    const moved = production
      .prepare(
        admitGpuFixture({
          ...pbrInputs,
          scene: { ...scene, slots: movedSlots, slotAt: movedSlots.slotAt },
          camera,
          meshBySlot: meshes,
          viewBindGroupLayout: viewLayout,
        }),
      )
      .unwrap();
    expect(moved).toBeDefined();
    moved?._commitResourceReplacement();
    expect(production.inspect()).toMatchObject({
      filteredPlanBuilds: 0,
      preparedBatchBuilds: 0,
      planRebuildBatches: 0,
      batchCount: 1,
      indirectDrawCount: 2,
      sharedInputUploadBytes: 0,
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
      plan: topology.query(topology.sourcePlan(), undefined),
      slots,
      slotAt: slots.slotAt,
    };
    const meshes = new Map(slots.map((slot) => [slot.slot, gpuMesh] as const));
    const prepare = () => {
      const currentSlots = projection.slotsSnapshot();
      const frame = production
        .prepare(
          admitGpuFixture({
            ...pbrInputs,
            scene: { ...scene, slots: currentSlots, slotAt: currentSlots.slotAt },
            camera,
            meshBySlot: meshes,
            viewBindGroupLayout: viewLayout,
          }),
        )
        .unwrap();
      frame?._commitResourceReplacement();
      return frame;
    };

    expect(prepare()).toBeDefined();
    expect(production.inspect().filteredPlanBuilds).toBe(1);
    const movedDelta = projection.apply([updateWorld(2, 50)]);
    availability.scene.sync(movedDelta).unwrap();
    expect(projection.slotsSnapshot().slotAt).not.toBe(slots.slotAt);
    expect(prepare()).toBeDefined();
    expect(production.inspect()).toMatchObject({
      filteredPlanBuilds: 0,
      preparedBatchBuilds: 0,
      planRebuildBatches: 0,
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
    const scene = {
      scene: gpuScene,
      plan: topology.query(topology.sourcePlan(), undefined),
      slots,
      slotAt: projection.slotAt,
    };
    const meshes = new Map(slots.map((slot) => [slot.slot, gpuMesh] as const));
    let projected = false;
    const frame = (temporal: boolean) => {
      const prepared = production
        .prepare(
          admitGpuFixture({
            ...pbrInputs,
            scene,
            camera: { ...makeZeroCameraFallbackSnapshot(), position: vec3.create(0, 0, 5) },
            meshBySlot: meshes,
            viewBindGroupLayout: viewLayout,
            ...(temporal ? { temporalSources: [] } : {}),
          }),
        )
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
      gpuScene.materialBuffer,
    ]);
    try {
      const first = frame(false);
      expect(first.inspection).toMatchObject({
        batchCount: BATCHES,
        preparedBatchBuilds: topology.query(topology.sourcePlan(), undefined).batches.length,
      });
      expect(selectedCount(first.prepared.selection, slots)).toBe(BATCHES * PER_BATCH);
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
