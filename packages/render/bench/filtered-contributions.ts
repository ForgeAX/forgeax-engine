// Pure CPU diagnostic of the production post-residency owner. No spies or GPU.
// Bundle this entry at baseline/candidate source and load both from the same runner.
import { deepStrictEqual } from 'node:assert';
import { RhiNullCommandEncoder, RhiNullDevice, RhiNullQueue } from '@forgeax/engine-rhi-null';
import {
  createMaterialShaderProgram,
  createStandardPbrArtifactReceipt,
} from '@forgeax/engine-shader';
import {
  mesh,
  preparedSnapshot,
  updateSnapshot,
} from '../src/__tests__/gpu-driven-production-fixture';
import { BatchTopology } from '../src/gpu-driven/batch-topology';
import { FilteredPlanContributionOwner } from '../src/gpu-driven/filtered-plan-contributions';
import {
  assemblePreparedPlan,
  filteredPlan,
  prepareBatchRows,
} from '../src/gpu-driven/production-raster-prepare';
import { ShadowClaimTable } from '../src/gpu-driven/shadow-claims';
import { RenderScene } from '../src/scene/render-scene';

export const modes = [
  'stable',
  'one-dirty',
  'sixteen-dirty',
  'all-dirty',
  'shadow-fresh-equal',
] as const;

export function createCase(mode: (typeof modes)[number], batchCount = 2300) {
  const device = new RhiNullDevice(
    new RhiNullQueue(),
    (bookkeeper, owner) => new RhiNullCommandEncoder(bookkeeper, owner),
  );
  const resident = mesh(device);
  const scene = new RenderScene();
  const snapshots = Array.from({ length: batchCount }, (_, i) => preparedSnapshot(i + 1, i + 1));
  scene.apply(snapshots.map(updateSnapshot));
  const slots = scene.slotsSnapshot();
  const topology = new BatchTopology();
  topology.rebuild(slots);
  const source = topology.plan();
  const receipt = createStandardPbrArtifactReceipt();
  const artifact = {
    material: 'forgeax::default-standard-pbr',
    pass: 'forward',
    program: createMaterialShaderProgram('synthetic'),
    layoutIdentity: receipt.reflection.layoutIdentity,
    bindings: [],
    deps: [],
    receipt,
    vertexInputs: receipt.vertexInputs as unknown as readonly Readonly<Record<string, unknown>>[],
  };
  const inputs = {
    slotAt: scene.slotAt,
    meshBySlot: new Map(slots.map((slot) => [slot.slot, resident])),
    worldKeys: undefined,
    materialArtifact: artifact,
    skinArtifact: undefined,
    materialArtifacts: undefined,
  };
  const prepared = assemblePreparedPlan(
    source,
    source.batches.map((batch) => prepareBatchRows(batch, inputs)),
    slots,
    undefined,
  );
  const dirtyCount =
    mode === 'one-dirty'
      ? 1
      : mode === 'sixteen-dirty'
        ? 16
        : mode === 'all-dirty'
          ? batchCount
          : 0;
  // Alternate independently derived immutable row facts. Preparation is outside
  // timing; the owner still sees actual facts replacements, never a dirty token.
  const alternate = {
    ...prepared,
    batchRows: prepared.batchRows.map((row, index) =>
      index < dirtyCount ? { ...row, facts: new Map(row.facts) } : row,
    ),
  };
  const membership = slots.map((slot) => ({
    worldEntity: slot.snapshot.entityKey,
    renderableIndex: slot.slot,
    drawItemIndex: 0,
    materialHandle: -1,
    passIndex: 0,
    gpuDrivenEligible: true,
  }));
  const claims =
    mode === 'shadow-fresh-equal'
      ? [
          new ShadowClaimTable(undefined, membership),
          new ShadowClaimTable(
            undefined,
            membership.map((entry) => ({ ...entry, renderableIndex: entry.renderableIndex + 1 })),
          ),
        ]
      : [undefined, undefined];
  const owner = new FilteredPlanContributionOwner();
  const plans = [prepared, alternate];
  let step = 0;
  let value = owner.update(prepared, 'current-values', claims[0]);
  if (value.plan.batches.length !== batchCount) throw Error('Unexpected benchmark batch roster');
  const shape = (result: typeof value) => ({
    batches: result.plan.batches.map((batch) => ({
      key: batch.key,
      candidates: batch.candidates,
      lod: batch.lod,
    })),
    drawKeys: [...result.drawKeys].sort(),
    shadowDrawKeys: [...result.shadowDrawKeys].sort(),
  });
  for (const index of [1, 0]) {
    const plan = plans[index];
    if (plan === undefined) throw Error('Missing benchmark plan');
    value = owner.update(plan, 'current-values', claims[index]);
    deepStrictEqual(shape(value), shape(filteredPlan(plan, claims[index])));
    if (owner.lastWork.projectedBatches !== dirtyCount) throw Error('Unexpected benchmark work');
  }
  return {
    run(iterations: number) {
      const start = performance.now();
      for (let i = 0; i < iterations; i++) {
        step = 1 - step;
        const plan = plans[step];
        if (plan === undefined) throw Error('Missing benchmark plan');
        value = owner.update(plan, 'current-values', claims[step]);
      }
      return (performance.now() - start) / iterations;
    },
    inspect: () => ({
      batchCount: value.plan.batches.length,
      candidateCount: value.plan.candidateCount,
      ...owner.lastWork,
    }),
    close() {
      resident.vertexBuffer.destroy().unwrap();
      resident.indexBuffer?.destroy().unwrap();
    },
  };
}
