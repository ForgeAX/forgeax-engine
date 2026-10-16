import { deriveVertexLayoutProjection } from '@forgeax/engine-geometry';
import { mat4, vec3 } from '@forgeax/engine-math';
import { ok } from '@forgeax/engine-rhi';
import {
  createShaderModule,
  RhiNullCommandEncoder,
  RhiNullDevice,
  RhiNullQueue,
} from '@forgeax/engine-rhi-null';
import { createMaterialShaderProgram, type MaterialShaderArtifact } from '@forgeax/engine-shader';
import { expect, it, vi } from 'vitest';
import type { MeshGpuHandles } from '../device/gpu-residency';
import { gpuDrivenMaterialArtifactKey } from '../extract/gpu-driven';
import { BatchTopology } from '../gpu-driven/batch-topology';
import { FilteredPlanContributionOwner } from '../gpu-driven/filtered-plan-contributions';
import { GpuDrivenProduction } from '../gpu-driven/production-raster';
import { MaterialAbiRasterAdapter } from '../gpu-driven/production-raster-material';
import { filteredPlan } from '../gpu-driven/production-raster-prepare';
import { ShadowViewStatePool, shadowViewIdentityKey } from '../gpu-driven/shadow-views';
import { GpuBuffer } from '../gpu-resource';
import { GpuScene } from '../gpu-scene';
import { GPU_BUFFER_USAGE_INDEX, GPU_BUFFER_USAGE_VERTEX } from '../gpu-usage';
import { makeZeroCameraFallbackSnapshot } from '../record/frame-snapshot';
import type { RenderableSnapshot, ShadowCasterMembership } from '../render-system-extract';
import { RenderScene } from '../scene/render-scene';
import { expectFilteredPlanContent } from './gpu-driven-filter-plan-fixture';
import { preparedPbrSnapshot, standardPbrInputs } from './gpu-driven-production-fixture';

async function fixture(count = 3, instanceCount = 1) {
  const device = new RhiNullDevice(
    new RhiNullQueue(),
    (bookkeeper, owner) => new RhiNullCommandEncoder(bookkeeper, owner),
  );
  const shader = (await createShaderModule(device, { code: 'synthetic' })).unwrap();
  const viewLayout = device.createBindGroupLayout({ entries: [] }).unwrap();
  const pbr = standardPbrInputs(device, shader, viewLayout);
  const baseArtifact = pbr.standardPbrArtifact;
  if (baseArtifact === undefined) throw Error('Missing material fixture');
  const materials = new Map<string, MaterialShaderArtifact>();
  const snapshots = Array.from({ length: count }, (_, index): RenderableSnapshot => {
    const materialShaderId = `material-${index}`;
    const material = { baseColor: vec3.create(1, 1, 1), metallic: 0, roughness: 1 };
    const transforms = new Float32Array(instanceCount * 16);
    for (let ordinal = 0; ordinal < instanceCount; ordinal++)
      transforms.set(mat4.identity(mat4.create()), ordinal * 16);
    const source = preparedPbrSnapshot({
      worldId: 0,
      entityKey: index + 1,
      assetHandle: index + 1,
      transform: { world: mat4.identity(mat4.create()) },
      localAabb: new Float32Array([-1, -1, -1, 1, 1, 1]),
      material,
      materials: [material],
      materialBindingSources: ['engine-default'],
      ...(instanceCount === 1
        ? {}
        : {
            instances: { transforms, instanceCount, cacheKey: index + 1, archVersion: 1 },
          }),
      gpuDrivenDraws: [
        {
          kind: 'indexed',
          first: 0,
          count: 3,
          baseVertex: 0,
          materialSlot: 0,
          topology: 'triangle-list',
          pipelineClass: 'standard-pbr',
          materialResourceClass: '',
        },
      ],
    });
    const draw = source.gpuDrivenDraws?.[0];
    if (draw?.prepared === undefined) throw Error('Missing prepared fixture');
    const prepared = {
      ...draw.prepared,
      identity: { ...draw.prepared.identity, material: materialShaderId },
    };
    materials.set(
      gpuDrivenMaterialArtifactKey({
        ...prepared.identity,
        receiptIdentity: prepared.receiptIdentity,
        receiptGeneration: prepared.receiptGeneration,
      }),
      { ...baseArtifact, material: materialShaderId },
    );
    const selected = { ...source.material, materialShaderId };
    return {
      ...source,
      material: selected,
      materials: [selected],
      gpuDrivenDraws: [{ ...draw, prepared }],
    };
  });
  const vertexBuffer = new GpuBuffer(
    device,
    device.createBuffer({ size: 144, usage: GPU_BUFFER_USAGE_VERTEX }).unwrap(),
  );
  const indexBuffer = new GpuBuffer(
    device,
    device.createBuffer({ size: 12, usage: GPU_BUFFER_USAGE_INDEX }).unwrap(),
  );
  const mesh: MeshGpuHandles = {
    vertexBuffer,
    indexBuffer,
    contentEpoch: 0,
    vboBytes: 144,
    iboBytes: 12,
    indexCount: 3,
    indexFormat: 'uint16',
    uvSetCount: 1,
    vertexCount: 3,
    indexed: true,
    topology: 'triangle-list',
    layoutProjection: deriveVertexLayoutProjection({
      position: new Float32Array(9),
      normal: new Float32Array(9),
      uv: new Float32Array(6),
      tangent: new Float32Array(12),
    }),
    submeshes: [
      { indexOffset: 0, indexCount: 3, vertexCount: 3, materialSlot: 0, topology: 'triangle-list' },
    ],
  };
  const projection = new RenderScene();
  const availability = GpuScene.create(device, count).unwrap();
  if (availability.status !== 'available') throw Error('GPU scene unavailable');
  const scene = availability.scene;
  const topology = new BatchTopology();
  const apply = (rows: readonly RenderableSnapshot[]) => {
    const delta = projection.apply(
      rows.map((snapshot) => ({
        kind: 'update' as const,
        worldId: 0,
        entityKey: snapshot.entityKey,
        snapshot,
      })),
    );
    scene.sync(delta).unwrap();
    topology.apply(delta);
  };
  apply(snapshots);
  const create = () => new GpuDrivenProduction(device, { createShaderModule: () => ok(shader) });
  const prepare = (
    production: GpuDrivenProduction,
    shadowCasterMembership: readonly ShadowCasterMembership[] = [],
    shadowMaterialArtifacts?: ReadonlyMap<string, MaterialShaderArtifact>,
  ) => {
    const slots = projection.slotsSnapshot();
    const result = production
      .prepare({
        ...pbr,
        materialArtifacts: materials,
        ...(shadowMaterialArtifacts === undefined ? {} : { shadowMaterialArtifacts }),
        scene: { scene, plan: topology.plan(), slots, slotAt: projection.slotAt },
        camera: makeZeroCameraFallbackSnapshot(),
        meshBySlot: new Map(slots.map((slot) => [slot.slot, mesh])),
        meshResidencyEpoch: 1,
        viewBindGroupLayout: viewLayout,
        shadowCasterMembership,
        // Custom materials use the producer factory, never the Standard-only
        // fixture module lookup. This fixture stops before raster recording.
        materialPipelineFactory: () => {
          throw Error('Projection fixture must not record a raster pass');
        },
      })
      .unwrap();
    if (result === undefined) throw Error('Missing production frame');
    return result;
  };
  return {
    materials,
    snapshots,
    apply,
    create,
    prepare,
    baseArtifact,
    close() {
      scene.dispose();
      vertexBuffer.destroy().unwrap();
      indexBuffer.destroy().unwrap();
    },
  };
}

it('keeps main contributions local across unrelated and consumed program edits, abort and recovery', async () => {
  const f = await fixture();
  let production = f.create();
  const updates = vi.spyOn(FilteredPlanContributionOwner.prototype, 'update');
  const current = () => {
    const input = updates.mock.calls.at(-1);
    const result = updates.mock.results.at(-1);
    if (input === undefined || result?.type !== 'return')
      throw Error('Missing contribution update');
    const output = result.value;
    expectFilteredPlanContent(output, filteredPlan(input[0], input[2], input[3]));
    return output;
  };
  try {
    f.prepare(production)._commitResourceReplacement();
    const first = current();
    expect(production.inspect()).toMatchObject({ preparedBatchBuilds: 3, filteredBatchBuilds: 3 });
    f.materials.set('unconsumed', {
      ...f.baseArtifact,
      program: createMaterialShaderProgram('unconsumed'),
    });
    const source = f.snapshots[0];
    if (source === undefined) throw Error('Missing source');
    f.apply([{ ...source, assetHandle: 100 }]);
    f.prepare(production)._commitResourceReplacement();
    const local = current();
    expect(production.inspect()).toMatchObject({ preparedBatchBuilds: 1, filteredBatchBuilds: 1 });
    for (const old of first.batches.slice(1)) {
      const next = local.batches.find(
        (row) => row.batch.key.assetHandle === old.batch.key.assetHandle,
      );
      expect(next?.batch.candidates).toBe(old.batch.candidates);
    }
    const selectedKey = [...f.materials.keys()][1];
    if (selectedKey === undefined) throw Error('Missing selected material');
    const selected = f.materials.get(selectedKey);
    if (selected === undefined) throw Error('Missing selected artifact');
    const replacement = { ...selected, program: createMaterialShaderProgram('replacement') };
    f.materials.set(selectedKey, replacement);
    const aborted = f.prepare(production);
    const changed = current();
    expect(production.inspect()).toMatchObject({ preparedBatchBuilds: 1, filteredBatchBuilds: 1 });
    expect(
      changed.batches.find((row) => row.artifact.material === replacement.material)?.artifact,
    ).toBe(replacement);
    aborted._abortResourceReplacement?.();
    const retry = f.prepare(production);
    expect(current()).toBe(changed);
    expect(retry.drawKeys).toEqual(aborted.drawKeys);
    retry._commitResourceReplacement();
    expect(production.inspect()).toMatchObject({
      preparedBatchBuilds: 0,
      filteredBatchBuilds: 0,
      retryCount: 1,
      filteredPlanBuilds: 0,
    });
    production.dispose();
    production = f.create();
    const recovered = f.prepare(production);
    expectFilteredPlanContent(current(), changed);
    expect(recovered.drawKeys).toEqual(retry.drawKeys);
    expect(production.inspect()).toMatchObject({ preparedBatchBuilds: 3, filteredBatchBuilds: 3 });
    recovered._commitResourceReplacement();
  } finally {
    updates.mockRestore();
    production.dispose();
    f.close();
  }
});

it('reprojects only the consumed shadow batch when one caster membership changes', async () => {
  const f = await fixture(96, 64);
  const production = f.create();
  const updates = vi.spyOn(FilteredPlanContributionOwner.prototype, 'update');
  const original = f.snapshots.map(
    (snapshot, renderableIndex): ShadowCasterMembership => ({
      worldEntity: snapshot.entityKey,
      renderableIndex,
      drawItemIndex: 0,
      materialHandle: snapshot.material.materialHandle ?? -1,
      passIndex: 0,
      gpuDrivenEligible: true,
    }),
  );
  const current = () => {
    const input = updates.mock.calls.at(-1);
    const result = updates.mock.results.at(-1);
    if (input?.[2] === undefined || result?.type !== 'return')
      throw Error('Missing shadow contribution update');
    expectFilteredPlanContent(result.value, filteredPlan(input[0], input[2], input[3]));
    return result.value;
  };
  try {
    f.prepare(production, original)._commitResourceReplacement();
    const first = current();
    expect(production.inspect()).toMatchObject({
      preparedBatchBuilds: 96,
      filteredBatchBuilds: 192,
    });
    const changed = original.map((entry, index) =>
      index === 48 ? { ...entry, gpuDrivenEligible: false } : { ...entry },
    );
    f.prepare(production, changed)._commitResourceReplacement();
    const next = current();
    expect(next.plan.candidateCount).toBe(95 * 64);
    expect(next.plan.batches.some((batch) => batch.key.assetHandle === 49)).toBe(false);
    expect(production.inspect()).toMatchObject({ preparedBatchBuilds: 0, filteredBatchBuilds: 1 });
    const owner = updates.mock.contexts.at(-1);
    if (!(owner instanceof FilteredPlanContributionOwner))
      throw Error('Missing contribution owner');
    expect(owner.lastWork).toMatchObject({ projectedBatches: 1, projectedCandidates: 64 });
    for (const before of first.batches) {
      if (before.batch.key.assetHandle === 49) continue;
      const retained = next.batches.find(
        (row) => row.batch.key.assetHandle === before.batch.key.assetHandle,
      );
      expect(retained?.batch.candidates).toBe(before.batch.candidates);
      expect(retained?.batch).toMatchObject({
        batchId: before.batch.batchId,
        visibleBase: before.batch.visibleBase,
        indirectOffset: before.batch.indirectOffset,
      });
    }
  } finally {
    updates.mockRestore();
    production.dispose();
    f.close();
  }
});

it('retains the filtered publication when a direct-only caster changes shadow membership', async () => {
  const f = await fixture(32, 4);
  const production = f.create();
  const source = f.snapshots[0];
  if (source === undefined) throw Error('Missing direct-only source');
  f.apply([{ ...source, entityKey: 1000, assetHandle: 1000, gpuDrivenDraws: [] }]);
  const membership: ShadowCasterMembership[] = f.snapshots.map((snapshot, renderableIndex) => ({
    worldEntity: snapshot.entityKey,
    renderableIndex,
    drawItemIndex: 0,
    materialHandle: snapshot.material.materialHandle ?? -1,
    passIndex: 0,
    gpuDrivenEligible: true,
  }));
  const direct: ShadowCasterMembership = {
    worldEntity: 1000,
    renderableIndex: 32,
    drawItemIndex: 0,
    materialHandle: source.material.materialHandle ?? -1,
    passIndex: 0,
    gpuDrivenEligible: false,
  };
  const updates = vi.spyOn(FilteredPlanContributionOwner.prototype, 'update');
  try {
    f.prepare(production, [...membership, direct])._commitResourceReplacement();
    const first = updates.mock.results.at(-1)?.value;
    expect(first).toBeDefined();
    for (let passIndex = 1; passIndex <= 3; passIndex++) {
      f.prepare(production, [...membership, { ...direct, passIndex }])._commitResourceReplacement();
      expect(production.inspect().filteredPlanBuilds).toBe(0);
      expect(updates.mock.results.at(-1)?.value).toBe(first);
      const owner = updates.mock.contexts.at(-1);
      if (!(owner instanceof FilteredPlanContributionOwner)) throw Error('Missing shadow owner');
      expect(owner.lastWork.projectedBatches).toBe(0);
      const input = updates.mock.calls.at(-1);
      if (input === undefined) throw Error('Missing contribution input');
      expectFilteredPlanContent(first, filteredPlan(input[0], input[2], input[3]));
    }
  } finally {
    updates.mockRestore();
    production.dispose();
    f.close();
  }
});

it('keeps graph and unaffected material caches when only a unique shadow receiver leaves and rejoins', async () => {
  const f = await fixture(3);
  const production = f.create();
  const clearPipelines = vi.spyOn(MaterialAbiRasterAdapter.prototype, 'invalidatePipelineCache');
  const invalidateShadows = vi.spyOn(ShadowViewStatePool.prototype, 'invalidate');
  const membership = f.snapshots.map(
    (snapshot, renderableIndex): ShadowCasterMembership => ({
      worldEntity: snapshot.entityKey,
      renderableIndex,
      drawItemIndex: 0,
      materialHandle: snapshot.material.materialHandle ?? -1,
      passIndex: 0,
      gpuDrivenEligible: true,
    }),
  );
  try {
    const first = f.prepare(production, membership);
    first._commitResourceReplacement();
    clearPipelines.mockClear();
    invalidateShadows.mockClear();
    for (const eligible of [false, true]) {
      const changed = membership.map((entry, index) =>
        index === 1 ? { ...entry, gpuDrivenEligible: eligible } : entry,
      );
      const next = f.prepare(production, changed);
      next._commitResourceReplacement();
      expect.soft(next.topologySignature).toBe(first.topologySignature);
      expect.soft(clearPipelines).not.toHaveBeenCalled();
      expect
        .soft(invalidateShadows.mock.calls.filter(([reason]) => reason === 'artifact-changed'))
        .toHaveLength(0);
      expect(production.inspect()).toMatchObject({
        preparedBatchBuilds: 0,
        filteredBatchBuilds: 1,
      });
      clearPipelines.mockClear();
      invalidateShadows.mockClear();
    }
  } finally {
    clearPipelines.mockRestore();
    invalidateShadows.mockRestore();
    production.dispose();
    f.close();
  }
});

it('refreshes only views and batch projections consuming a changed shadow receipt', async () => {
  const f = await fixture(3);
  let production = f.create();
  const shadowMaterials = new Map(
    [...f.materials].map(([key, artifact]) => {
      if (artifact.receipt === undefined) throw Error('Missing fixture receipt');
      const unobserved = () => {
        throw Error('Shadow observations must not enumerate unrelated fields');
      };
      const receipt = new Proxy({ ...artifact.receipt }, { ownKeys: unobserved });
      return [key, new Proxy({ ...artifact, receipt }, { ownKeys: unobserved })] satisfies [
        string,
        MaterialShaderArtifact,
      ];
    }),
  );
  const membership = f.snapshots.map((snapshot, renderableIndex) => ({
    worldEntity: snapshot.entityKey,
    renderableIndex,
    drawItemIndex: 0,
    materialHandle: snapshot.material.materialHandle ?? -1,
    passIndex: 0,
    gpuDrivenEligible: true,
  }));
  const views = [0, 1, 2].map((index) => ({
    identity: { kind: 'directional' as const, index, layer: 'static' as const },
    planes: new Float32Array(24),
    candidatePrimitiveIndices: [index],
  }));
  const prepare = () => {
    const frame = f.prepare(production, membership, shadowMaterials);
    frame.updateShadowViews?.(views).unwrap();
    return frame;
  };
  const projectionFor = (frame: ReturnType<typeof prepare>, index: number) => {
    const value = frame.shadowBatchProjections
      ?.get(shadowViewIdentityKey({ kind: 'directional', index, layer: 'static' }))
      ?.values()
      .next().value;
    if (value === undefined) throw Error('Missing shadow projection');
    return value;
  };
  const invalidated = vi.spyOn(ShadowViewStatePool.prototype, 'invalidate');
  const cleared = vi.spyOn(MaterialAbiRasterAdapter.prototype, 'invalidatePipelineCache');
  try {
    const first = prepare();
    const signature = first.topologySignature;
    const unaffected = projectionFor(first, 0);
    first._commitResourceReplacement();
    const selected = [...shadowMaterials.values()][1];
    if (selected === undefined) throw Error('Missing selected shadow program');
    const mutations = [
      () => {
        selected.program = createMaterialShaderProgram('shadow-replacement');
      },
      () => {
        selected.receipt.generation += 1;
      },
      () => {
        selected.vertexEntry = 'vs-replacement';
      },
      () => {
        selected.fragmentEntry = 'fs-replacement';
      },
    ];
    for (const mutate of mutations) {
      const previous = prepare();
      expect(views.map(({ identity }) => previous.shadowViewPool?.cacheState(identity))).toEqual([
        'hit',
        'hit',
        'hit',
      ]);
      previous._commitResourceReplacement();
      const before = projectionFor(previous, 1);
      invalidated.mockClear();
      cleared.mockClear();
      mutate();
      const next = prepare();
      expect(next.topologySignature).toBe(signature);
      expect(views.map(({ identity }) => next.shadowViewPool?.cacheState(identity))).toEqual([
        'hit',
        'invalidated',
        'hit',
      ]);
      expect(invalidated.mock.calls.filter(([reason]) => reason === 'artifact-changed')).toEqual([
        ['artifact-changed', views[1]?.identity],
      ]);
      expect(projectionFor(next, 0)).toBe(unaffected);
      expect(projectionFor(next, 1)).not.toBe(before);
      expect(projectionFor(next, 1).shadowArtifact).toBe(selected);
      expect(cleared).not.toHaveBeenCalled();
      next._commitResourceReplacement();
    }
    const key = [...shadowMaterials.keys()][1];
    if (key === undefined) throw Error('Missing selected shadow key');
    const unconsumed = f.prepare(production, membership, shadowMaterials);
    const replacement = {
      ...f.baseArtifact,
      material: selected.material,
      receipt: selected.receipt,
      program: createMaterialShaderProgram('unconsumed-shadow'),
    };
    shadowMaterials.set(key, replacement);
    f.prepare(production, membership, shadowMaterials);
    shadowMaterials.set(key, selected);
    unconsumed.updateShadowViews?.(views).unwrap();
    expect(views.map(({ identity }) => unconsumed.shadowViewPool?.cacheState(identity))).toEqual([
      'hit',
      'hit',
      'hit',
    ]);
    unconsumed._commitResourceReplacement();
    for (const entries of [membership, membership.slice(0, 2)]) {
      const pending = f.prepare(production, entries, shadowMaterials);
      const current = {
        ...replacement,
        program: createMaterialShaderProgram(`late-shadow-${entries.length}`),
      };
      shadowMaterials.set(key, current);
      pending.updateShadowViews?.(views).unwrap();
      expect(projectionFor(pending, 1).shadowArtifact === current).toBe(true);
      expect(
        pending.shadowViewPool?.cacheState({ kind: 'directional', index: 0, layer: 'static' }),
      ).toBe('hit');
      expect(
        pending.shadowViewPool?.cacheState({ kind: 'directional', index: 1, layer: 'static' }),
      ).toBe('invalidated');
      pending._commitResourceReplacement();
    }
    production.dispose();
    production = f.create();
    const recovered = prepare();
    expect(recovered.topologySignature).not.toBe(signature);
    expect(views.map(({ identity }) => recovered.shadowViewPool?.cacheState(identity))).toEqual([
      'invalidated',
      'invalidated',
      'invalidated',
    ]);
    recovered._commitResourceReplacement();
  } finally {
    invalidated.mockRestore();
    cleared.mockRestore();
    production.dispose();
    f.close();
  }
});
