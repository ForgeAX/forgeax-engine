import { mat4, vec3 } from '@forgeax/engine-math';
import type { RenderPipelineDescriptor } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it } from 'vitest';
import {
  BatchTopology,
  batchLodLevelCount,
  batchVisibleSpan,
  buildBatchAlignedSubmission,
  type SubmissionPlan,
} from '../gpu-driven/batch-topology';
import { FilteredPlanContributionOwner } from '../gpu-driven/filtered-plan-contributions';
import { ShadowClaimTable } from '../gpu-driven/shadow-claims';
import { SHADOW_CASTER_SHADER_ID } from '../pbr-pipeline';
import { RenderBundleCache } from '../record/render-bundle-cache';
import type { RenderableSnapshot, ShadowCasterMembership } from '../render-system-extract';
import { RenderScene } from '../scene/render-scene';
import { createFilterPlanFixture } from './gpu-driven-filter-plan-fixture';
import { expectFilteredPlan } from './gpu-driven-filtered-plan-assertions';
import { preparedPbrSnapshot } from './gpu-driven-production-fixture';

function sourceFixture(firstInstances = 1) {
  const scene = new RenderScene();
  const snapshots = Array.from({ length: 3 }, (_, index) => {
    const world = mat4.identity(mat4.create());
    const material = { baseColor: vec3.create(1, 1, 1), metallic: 0, roughness: 1 };
    const instanceCount = index === 0 ? firstInstances : 1;
    return preparedPbrSnapshot({
      worldId: 0,
      entityKey: index + 1,
      assetHandle: index + 7,
      transform: { world },
      localAabb: new Float32Array([-1, -1, -1, 1, 1, 1]),
      material,
      materials: [material],
      materialBindingSources: ['engine-default'],
      instances: {
        transforms: new Float32Array(
          Array.from({ length: instanceCount }, () => [...world]).flat(),
        ),
        instanceCount,
        cacheKey: index,
        archVersion: 0,
      },
      gpuDrivenDraws: [
        {
          kind: 'indexed',
          first: 0,
          count: 3,
          baseVertex: 0,
          materialSlot: 0,
          topology: 'triangle-list',
          pipelineClass: 'standard-pbr',
          materialResourceClass: 'standard-pbr-resources',
        },
      ],
    } as RenderableSnapshot);
  });
  scene.apply(
    snapshots.map((snapshot) => ({
      kind: 'update' as const,
      worldId: 0,
      entityKey: snapshot.entityKey,
      snapshot,
    })),
  );
  const topology = new BatchTopology();
  topology.rebuild(scene.slotsSnapshot());
  return { scene, topology, snapshots };
}

it('retains unaffected source and shadow command windows through removal and cardinality shrink', () => {
  const f = sourceFixture();
  const before = f.topology.plan();
  const rebuilt = f.topology.inspect().batchesRebuilt;
  const selected = buildBatchAlignedSubmission(
    before,
    new Map(before.batches.slice(1).map((batch) => [batch.batchId, batch.candidates])),
  );
  expect(selected.batches.map((batch) => [batch.visibleBase, batch.indirectOffset])).toEqual(
    before.batches.slice(1).map((batch) => [batch.visibleBase, batch.indirectOffset]),
  );
  f.topology.apply(f.scene.apply([{ kind: 'remove', worldId: 0, entityKey: 1 }]));
  const after = f.topology.plan();
  expect(after.batches[0]).toBe(before.batches[1]);
  expect(after.batches[1]).toBe(before.batches[2]);
  expect(f.topology.inspect().batchesRebuilt).toBe(rebuilt);

  const g = sourceFixture(65);
  const large = g.topology.plan();
  const original = g.snapshots[0];
  if (original?.instances === undefined) throw Error('Missing fixture instances');
  g.topology.apply(
    g.scene.apply([
      {
        kind: 'update',
        worldId: 0,
        entityKey: 1,
        instances: {
          ...original.instances,
          instanceCount: 64,
          transforms: original.instances.transforms.slice(0, 64 * 16),
        },
      },
    ]),
  );
  const small = g.topology.plan();
  expect(small.batches[1]).toBe(large.batches[1]);
  expect(small.batches[2]).toBe(large.batches[2]);
  expect(small.batches[0]?.candidates).toHaveLength(64);
});

it('retains actual filtered main and shadow windows when an unrelated group disappears', () => {
  const f = createFilterPlanFixture();
  const prepared = f.prepare();
  const main = new FilteredPlanContributionOwner();
  const before = main.update(prepared, 'values', undefined, f.bindings);
  const reduced = {
    ...f.source,
    candidateCount: 2,
    batches: f.source.batches
      .map((batch) => ({
        ...batch,
        candidates: batch.candidates.filter((candidate) => candidate.primitiveIndex === 1),
      }))
      .filter((batch) => batch.candidates.length),
  };
  const after = main.update(f.prepare(reduced), 'values', undefined, f.bindings);
  const original = before.plan.batches[1];
  expect(after.plan.batches[0]?.candidates).toEqual(original?.candidates);
  expect(after.plan.batches[0]).toMatchObject({
    batchId: original?.batchId,
    visibleBase: original?.visibleBase,
    indirectOffset: original?.indirectOffset,
  });
  expect(after.batches[0]?.mesh).toBe(before.batches[1]?.mesh);
  expect(after.batches[0]?.artifact).toBe(before.batches[1]?.artifact);

  const memberships: ShadowCasterMembership[] = f.slots.map((slot) => ({
    worldEntity: slot.snapshot.entityKey,
    renderableIndex: slot.slot,
    drawItemIndex: 0,
    materialHandle: slot.snapshot.material.materialHandle ?? -1,
    passIndex: 0,
    materialShaderId: SHADOW_CASTER_SHADER_ID,
    renderState: { cullMode: 'back' },
    gpuDrivenEligible: true,
  }));
  const claims = (rows: readonly ShadowCasterMembership[]) => new ShadowClaimTable(undefined, rows);
  const shadow = new FilteredPlanContributionOwner();
  const shadowBefore = shadow.update(prepared, 'values', claims(memberships), f.bindings);
  const shadowAfter = shadow.update(
    prepared,
    'values',
    claims(memberships.map((row) => ({ ...row, gpuDrivenEligible: row.renderableIndex === 1 }))),
    f.bindings,
  );
  const shadowOriginal = shadowBefore.plan.batches[1];
  expect(shadowAfter.plan.batches[0]?.candidates).toEqual(shadowOriginal?.candidates);
  expect(shadowAfter.plan.batches[0]).toMatchObject({
    batchId: shadowOriginal?.batchId,
    visibleBase: shadowOriginal?.visibleBase,
    indirectOffset: shadowOriginal?.indirectOffset,
  });
});

function expectDisjointRanges(plan: SubmissionPlan) {
  for (const [start, length] of [
    [(batch) => batch.visibleBase, batchVisibleSpan],
    [(batch) => batch.indirectOffset, (batch) => batchLodLevelCount(batch) * 20],
  ] as const satisfies readonly (readonly [
    (batch: SubmissionPlan['batches'][number]) => number,
    (batch: SubmissionPlan['batches'][number]) => number,
  ])[]) {
    const ordered = [...plan.batches].sort((a, b) => start(a) - start(b));
    for (let index = 1; index < ordered.length; index++) {
      const previous = ordered[index - 1];
      const current = ordered[index];
      if (previous === undefined || current === undefined) throw Error('Missing range');
      expect(start(previous) + length(previous)).toBeLessThanOrEqual(start(current));
    }
  }
  expect(plan.visibleCapacity).toBe(
    Math.max(0, ...plan.batches.map((batch) => batch.visibleBase + batchVisibleSpan(batch))),
  );
}

it('reclaims retired ranges through repeated growth and reuse without moving surviving batches', () => {
  const f = sourceFixture();
  const initial = f.topology.plan();
  const original = f.snapshots[0];
  if (original?.instances === undefined) throw Error('Missing fixture instances');
  for (let cycle = 0; cycle < 60; cycle++) {
    const instanceCount = cycle % 3 === 0 ? 129 : cycle % 3 === 1 ? 65 : 1;
    const snapshot = {
      ...original,
      instances: {
        ...original.instances,
        instanceCount,
        transforms: new Float32Array(
          Array.from({ length: instanceCount }, () => [...original.transform.world]).flat(),
        ),
      },
    };
    f.topology.apply(f.scene.apply([{ kind: 'update', worldId: 0, entityKey: 1, snapshot }]));
    const grown = f.topology.plan();
    expect(grown.batches[1]).toBe(initial.batches[1]);
    expect(grown.batches[2]).toBe(initial.batches[2]);
    expect(grown.batches[0]?.candidates).toHaveLength(instanceCount);
    expectDisjointRanges(grown);
    expect(grown.visibleCapacity).toBeLessThanOrEqual(384);
    f.topology.apply(f.scene.apply([{ kind: 'remove', worldId: 0, entityKey: 1 }]));
    expectDisjointRanges(f.topology.plan());
  }
  f.topology.rebuild(f.scene.slotsSnapshot());
  const rebuilt = f.topology.plan();
  expectDisjointRanges(rebuilt);
  expect(rebuilt.visibleCapacity).toBe(128);
});

it('reuses filtered holes across binding splits, merges and a complete reset', () => {
  const f = createFilterPlanFixture();
  const prepared = f.prepare();
  const owner = new FilteredPlanContributionOwner();
  const initial = owner.update(prepared, 'values', undefined, f.bindings);
  const originalB = initial.plan.batches[1];
  const keyA = [...f.bindings.keys()][0];
  if (originalB === undefined || keyA === undefined) throw Error('Missing fixture binding');
  for (let cycle = 0; cycle < 60; cycle++) {
    const split = cycle % 2 === 0;
    const bindings = new Map(f.bindings).set(keyA, split ? 'C' : 'A');
    const result = owner.update(prepared, 'values', undefined, bindings);
    expect(result.plan.batches).toHaveLength(split ? 3 : 2);
    expect(result.plan.candidateCount).toBe(6);
    expect(
      result.plan.batches.find((batch) => batch.candidates[0]?.primitiveIndex === 1),
    ).toMatchObject({
      batchId: originalB.batchId,
      visibleBase: originalB.visibleBase,
      indirectOffset: originalB.indirectOffset,
      candidates: originalB.candidates,
    });
    expectDisjointRanges(result.plan);
    expect(result.plan.visibleCapacity).toBeLessThanOrEqual(322);
  }
  owner.clear();
  const reset = owner.update(prepared, 'values', undefined, f.bindings);
  expectFilteredPlan(reset, initial);
  expect(
    reset.plan.batches.map((batch) => [batch.batchId, batch.visibleBase, batch.indirectOffset]),
  ).toEqual(
    initial.plan.batches.map((batch) => [batch.batchId, batch.visibleBase, batch.indirectOffset]),
  );
  expectDisjointRanges(reset.plan);
});

it('reuses physical indirect segments after deletion while rejecting a changed pipeline at the same address', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const indirect = device.createBuffer({ size: 512, usage: 0x180 }).unwrap();
  const pipelines = Array.from({ length: 4 }, () =>
    device.createRenderPipeline({} as RenderPipelineDescriptor).unwrap(),
  );
  const cache = new RenderBundleCache({ colorFormats: [] });
  const frame = (draws: readonly (readonly [number, number])[]) => {
    const counters = { hits: 0, misses: 0 };
    const encoder = device.createCommandEncoder().unwrap();
    const pass = encoder.beginRenderPass({ colorAttachments: [] });
    cache.encode(
      device,
      pass,
      (commands) => {
        for (const [pipeline, offset] of draws) {
          const handle = pipelines[pipeline];
          if (handle === undefined) throw Error('Missing fixture pipeline');
          commands.setPipeline(handle);
          commands.drawIndirect(indirect, offset);
        }
      },
      counters,
    );
    pass.end();
    return counters;
  };
  const original = [
    [0, 0],
    [1, 20],
    [2, 40],
  ] as const;
  frame(original);
  frame(original);
  expect(frame(original)).toEqual({ hits: 3, misses: 0 });
  expect(
    frame([
      [1, 20],
      [2, 40],
    ]),
  ).toEqual({ hits: 2, misses: 0 });
  expect(
    frame([
      [3, 20],
      [2, 40],
    ]),
  ).toEqual({ hits: 1, misses: 1 });
  device.destroyBuffer(indirect);
});

it('matches the complete effective binding commands when deletion changes an overwritten inherited prelude', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const indirect = device.createBuffer({ size: 512, usage: 0x180 }).unwrap();
  const pipeline = device.createRenderPipeline({} as RenderPipelineDescriptor).unwrap();
  const layout = device.createBindGroupLayout({ entries: [] }).unwrap();
  const groups = Array.from({ length: 4 }, () =>
    device.createBindGroup({ layout, entries: [] }).unwrap(),
  );
  const cache = new RenderBundleCache({ colorFormats: [] });
  const frame = (draws: readonly (readonly [number, number])[]) => {
    const counters = { hits: 0, misses: 0 };
    const encoder = device.createCommandEncoder().unwrap();
    const pass = encoder.beginRenderPass({ colorAttachments: [] });
    cache.encode(
      device,
      pass,
      (commands) => {
        for (const [group, offset] of draws) {
          const handle = groups[group];
          if (handle === undefined) throw Error('Missing fixture group');
          commands.setPipeline(pipeline);
          commands.setBindGroup(0, handle);
          commands.drawIndirect(indirect, offset);
        }
      },
      counters,
    );
    pass.end();
    return counters;
  };
  const original = [
    [0, 0],
    [1, 20],
    [2, 40],
  ] as const;
  frame(original);
  frame(original);
  expect(frame(original)).toEqual({ hits: 3, misses: 0 });
  expect(
    frame([
      [1, 20],
      [2, 40],
    ]),
  ).toEqual({ hits: 2, misses: 0 });
  expect(
    frame([
      [3, 20],
      [2, 40],
    ]),
  ).toEqual({ hits: 1, misses: 1 });
  device.destroyBuffer(indirect);
});
