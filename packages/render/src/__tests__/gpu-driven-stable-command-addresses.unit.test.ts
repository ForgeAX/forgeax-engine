import { mat4, vec3 } from '@forgeax/engine-math';
import type { RenderPipelineDescriptor } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it } from 'vitest';
import { batchLodLevelCount, batchVisibleSpan } from '../gpu-driven/batch-layout';
import {
  BatchTopology,
  buildBatchAlignedSubmission,
  type GpuDrivenBatch,
  type SubmissionPlan,
} from '../gpu-driven/batch-topology';
import { FilteredPlanContributionOwner } from '../gpu-driven/filtered-plan-contributions';
import {
  PreparedRasterBundleCache,
  PreparedRasterPass,
} from '../gpu-driven/prepared-raster-bundle';
import { MaterialResource } from '../material-resource';
import { RenderScene } from '../scene/render-scene';
import { createFilterPlanFixture } from './gpu-driven-filter-plan-fixture';
import { expectFilteredPlan } from './gpu-driven-filtered-plan-assertions';
import { preparedPbrSnapshot } from './gpu-driven-production-fixture';

function sourceFixture(firstInstances = 1) {
  const scene = new RenderScene();
  const snapshots = Array.from({ length: 3 }, (_, index) => {
    const world = mat4.identity(mat4.create());
    const material = new MaterialResource({
      baseColor: vec3.create(1, 1, 1),
      metallic: 0,
      roughness: 1,
      passes: [],
    });
    const instanceCount = index === 0 ? firstInstances : 1;
    return preparedPbrSnapshot({
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
    });
  });
  scene.apply(
    snapshots.map((snapshot) => ({
      kind: 'update' as const,
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
  const before = f.topology.query(f.topology.sourcePlan(), undefined).active;
  const rebuilt = f.topology.inspect().batchesRebuilt;
  const selected = buildBatchAlignedSubmission(
    before,
    new Map(before.batches.slice(1).map((batch) => [batch.batchId, batch.candidates])),
  );
  expect(selected.batches.map((batch) => [batch.visibleBase, batch.indirectOffset])).toEqual(
    before.batches.slice(1).map((batch) => [batch.visibleBase, batch.indirectOffset]),
  );
  f.topology.apply(f.scene.apply([{ kind: 'remove', entityKey: 1 }]));
  const after = f.topology.query(f.topology.sourcePlan(), undefined).active;
  expect(after.batches.at(0)).toBe(before.batches.at(1));
  expect(after.batches.at(1)).toBe(before.batches.at(2));
  expect(f.topology.inspect().batchesRebuilt).toBe(rebuilt);

  const g = sourceFixture(65);
  const large = g.topology.query(g.topology.sourcePlan(), undefined).active;
  const original = g.snapshots[0];
  if (original?.instances === undefined) throw Error('Missing fixture instances');
  g.topology.apply(
    g.scene.apply([
      {
        kind: 'update',
        entityKey: 1,
        instances: {
          ...original.instances,
          instanceCount: 64,
          transforms: original.instances.transforms.slice(0, 64 * 16),
        },
      },
    ]),
  );
  const small = g.topology.query(g.topology.sourcePlan(), undefined).active;
  expect(small.batches.at(1)).toBe(large.batches.at(1));
  expect(small.batches.at(2)).toBe(large.batches.at(2));
  expect(small.batches.at(0)?.candidates).toHaveLength(64);
});

it('retains actual filtered main and shadow windows when an unrelated group disappears', () => {
  const f = createFilterPlanFixture();
  const prepared = f.prepare();
  const main = new FilteredPlanContributionOwner();
  const before = main.update(prepared, f.bindings).active;
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
  const after = main.update(f.prepare(reduced), f.bindings).active;
  const original = before.plan.batches.at(1);
  expect([...(after.plan.batches.at(0)?.candidates ?? [])]).toEqual([
    ...(original?.candidates ?? []),
  ]);
  expect(after.plan.batches.at(0)).toMatchObject({
    batchId: original?.batchId,
    visibleBase: original?.visibleBase,
    indirectOffset: original?.indirectOffset,
  });
  expect(after.batches.at(0)?.mesh).toBe(before.batches.at(1)?.mesh);
  expect(after.batches.at(0)?.artifact.program).toBe(before.batches.at(1)?.artifact.program);

  const selected = buildBatchAlignedSubmission(
    before.plan,
    new Map([[original?.batchId ?? -1, original?.candidates ?? []]]),
  );
  expect(selected.batches).toHaveLength(1);
  expect(selected.batches.at(0)?.visibleBase).toBe(original?.visibleBase);
  expect(selected.batches.at(0)?.indirectOffset).toBe(original?.indirectOffset);
});

function expectDisjointRanges(plan: SubmissionPlan) {
  for (const [start, length] of [
    [(batch) => batch.visibleBase, batchVisibleSpan],
    [(batch) => batch.indirectOffset, (batch) => batchLodLevelCount(batch) * 20],
  ] as const satisfies readonly (readonly [
    (batch: GpuDrivenBatch) => number,
    (batch: GpuDrivenBatch) => number,
  ])[]) {
    const ordered = [...plan.batches].sort((a, b) => start(a) - start(b));
    for (let index = 1; index < ordered.length; index++) {
      const previous = ordered[index - 1];
      const current = ordered[index];
      if (previous === undefined || current === undefined) throw Error('Missing range');
      expect(start(previous) + length(previous)).toBeLessThanOrEqual(start(current));
    }
  }
  expect(plan.visibleCapacity).toBeGreaterThanOrEqual(
    Math.max(0, ...plan.batches.map((batch) => batch.visibleBase + batchVisibleSpan(batch))),
  );
}

it('reclaims retired ranges through repeated growth and reuse without moving surviving batches', () => {
  const f = sourceFixture();
  const initial = f.topology.query(f.topology.sourcePlan(), undefined).active;
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
    f.topology.apply(f.scene.apply([{ kind: 'update', entityKey: 1, snapshot }]));
    const grown = f.topology.query(f.topology.sourcePlan(), undefined).active;
    expect(grown.batches.at(1)).toBe(initial.batches.at(1));
    expect(grown.batches.at(2)).toBe(initial.batches.at(2));
    expect(grown.batches.at(0)?.candidates).toHaveLength(instanceCount);
    expectDisjointRanges(grown);
    expect(grown.visibleCapacity).toBeLessThanOrEqual(384);
    f.topology.apply(f.scene.apply([{ kind: 'remove', entityKey: 1 }]));
    expectDisjointRanges(f.topology.query(f.topology.sourcePlan(), undefined).active);
  }
  f.topology.rebuild(f.scene.slotsSnapshot());
  const rebuilt = f.topology.query(f.topology.sourcePlan(), undefined).active;
  expectDisjointRanges(rebuilt);
  expect(rebuilt.visibleCapacity).toBe(128);
});

it('reuses filtered holes across binding splits, merges and a complete reset', () => {
  const f = createFilterPlanFixture({ sharedGeometry: true });
  const prepared = f.prepare();
  const owner = new FilteredPlanContributionOwner();
  const initial = owner.update(prepared, f.bindings).active;
  const originalB = initial.plan.batches.at(1);
  const keyA = [...f.bindings.keys()][0];
  if (originalB === undefined || keyA === undefined) throw Error('Missing fixture binding');
  for (let cycle = 0; cycle < 60; cycle++) {
    const split = cycle % 2 === 0;
    const bindings = new Map(f.bindings).set(keyA, split ? 'C' : 'A');
    const result = owner.update(prepared, bindings).active;
    expect(result.plan.batches).toHaveLength(split ? 3 : 2);
    expect(result.plan.candidateCount).toBe(6);
    expect(
      result.plan.batches.find((batch) => batch.candidates.at(0)?.primitiveIndex === 1),
    ).toMatchObject({
      batchId: originalB.batchId,
      visibleBase: originalB.visibleBase,
      indirectOffset: originalB.indirectOffset,
      candidates: originalB.candidates,
    });
    expectDisjointRanges(result.plan);
    expect(result.plan.visibleCapacity).toBeLessThanOrEqual(3 * 2 * 64);
  }
  owner.clear();
  const reset = owner.update(prepared, f.bindings).active;
  expectFilteredPlan(reset, initial);
  expect(
    reset.plan.batches.map((batch) => [batch.batchId, batch.visibleBase, batch.indirectOffset]),
  ).toEqual(
    initial.plan.batches.map((batch) => [batch.batchId, batch.visibleBase, batch.indirectOffset]),
  );
  expectDisjointRanges(reset.plan);
});

it.each([
  'pipeline',
  'group',
] as const)('keeps surviving native bundles when another batch retires or changes its %s', async (change) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const indirect = device.createBuffer({ size: 512, usage: 0x1a0 }).unwrap();
  const pipelines = Array.from({ length: 4 }, () =>
    device.createRenderPipeline({} as RenderPipelineDescriptor).unwrap(),
  );
  const layout = device.createBindGroupLayout({ entries: [] }).unwrap();
  const groups = Array.from({ length: 4 }, () =>
    device.createBindGroup({ layout, entries: [] }).unwrap(),
  );
  const pass = new PreparedRasterPass({ colorFormats: [] });
  const batches = Array.from({ length: 3 }, (_, index) => ({
    owner: new PreparedRasterBundleCache(),
    address: index * 20,
    variant: index,
  }));
  const counters = { hits: 0, builds: 0, commands: 0, evictions: 0 };
  const prepare = () =>
    batches.map(({ owner, address, variant }) => {
      const view = groups[change === 'group' ? variant : 0];
      const pipeline = pipelines[change === 'pipeline' ? variant : 0];
      if (!view || !pipeline) throw Error('Missing fixture binding');
      return owner.resolveOne(
        pass,
        device,
        {
          pipeline,
          view,
          viewOffset: 0,
          material: view,
          materialOffset: undefined,
          mesh: view,
          meshOffsets: [],
          vertex: indirect,
          indexFormat: 'uint16',
          indirect,
          indirectOffset: address,
          indexed: false,
          windows: [view],
        },
        counters,
      );
    });
  const original = prepare();
  expect(prepare()).toEqual(original);
  batches.shift()?.owner.retire(pass, counters);
  const remaining = prepare();
  expect(remaining[0]).toBe(original[1]);
  expect(remaining[1]).toBe(original[2]);
  const first = batches[0];
  if (!first) throw Error('Missing surviving batch');
  first.variant = 3;
  const changed = prepare();
  expect(changed[0]).not.toBe(original[1]);
  expect(changed[1]).toBe(original[2]);
  expect(counters).toMatchObject({ hits: 6, builds: 4, evictions: 1 });
  device.destroyBuffer(indirect).unwrap();
});
