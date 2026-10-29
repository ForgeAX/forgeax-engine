import { expect, it } from 'vitest';
import { receiptRow } from '../../__tests__/gpu-draw-selection-fixture';
import { BatchTopology } from '../../gpu-driven/batch-topology';
import { GpuDrawSelection } from '../../gpu-driven/draw-selection';
import { MaterialResource } from '../../material-resource';
import { defaultMaterialSnapshot, type RenderableSnapshot } from '../../render-system-extract';
import { RenderScene } from '../render-scene';
import { ResidualRoster } from '../residual-roster';

const covered = new MaterialResource(defaultMaterialSnapshot(1));
// A distinct texture binding keeps the residual material out of the covered row-material batch.
const residual = new MaterialResource({
  ...defaultMaterialSnapshot(2),
  textureHandles: new Map([['baseColorTexture', 2]]),
} as unknown as ReturnType<typeof defaultMaterialSnapshot>);

function source(entityKey: number, material: MaterialResource, batched = true): RenderableSnapshot {
  const base = receiptRow().source;
  return {
    ...base,
    entityKey,
    material,
    materials: [material],
    gpuDrivenDraws: batched ? (base.gpuDrivenDraws?.slice(0, 1) ?? []) : [],
  };
}

function fixture(count: number) {
  const scene = new RenderScene();
  const topology = new BatchTopology();
  const write = (sources: readonly RenderableSnapshot[]) =>
    topology.apply(
      scene.apply(
        sources.map((snapshot) => ({
          kind: 'update' as const,
          worldId: 0,
          entityKey: snapshot.entityKey,
          snapshot,
        })),
      ),
    );
  write([
    ...Array.from({ length: count }, (_, index) => source(index, covered)),
    ...Array.from({ length: 8 }, (_, index) => source(count + index, residual)),
  ]);
  const select = (material: MaterialResource) =>
    new GpuDrawSelection(
      topology
        .query(topology.sourcePlan(), undefined)
        .batches.filter((batch) => batch.binding?.material === material),
    );
  const roster = new ResidualRoster();
  const sync = (selection: GpuDrawSelection) =>
    roster.sync(topology.sourcePlan(), topology.unbatchedSlots, selection);
  const entities = () =>
    [...roster.slots].map((slot) => scene.slotsSnapshot().slotAt(slot)?.entityKey);
  return { scene, topology, write, select, roster, sync, entities };
}

it('keeps the residual set from diffs: steady syncs and covered members cost nothing', () => {
  const f = fixture(10_000);
  const selection = f.select(covered);
  f.sync(selection);
  expect(f.entities()).toEqual([10_000, 10_001, 10_002, 10_003, 10_004, 10_005, 10_006, 10_007]);
  const before = { ...f.roster.work };
  f.sync(selection);
  f.sync(f.select(covered));
  expect(f.roster.work).toEqual(before);

  // One residual and one covered row change: one member each way at most, no batch walk.
  f.write([source(10_008, residual), source(10_009, covered)]);
  f.sync(f.select(covered));
  expect(f.roster.work.members - before.members).toBe(1);
  expect(f.roster.work.cold).toBe(before.cold);
  expect(f.entities()).toContain(10_008);
  expect(f.entities()).not.toContain(10_009);

  // Unbatched geometry enters and leaves through the topology's fixed set.
  f.write([source(20_000, residual, false)]);
  f.sync(f.select(covered));
  expect(f.entities()).toContain(20_000);
  f.topology.apply(f.scene.apply([{ kind: 'remove', worldId: 0, entityKey: 20_000 }]));
  f.sync(f.select(covered));
  expect(f.entities()).not.toContain(20_000);
});

it('moves only the flipped batch when the GPU selection changes coverage', () => {
  const f = fixture(1_000);
  f.sync(f.select(covered));
  const before = { ...f.roster.work };
  // Covering the residual binding instead moves 8 + 1000 members, one batch each way.
  f.sync(f.select(residual));
  expect(f.roster.work.batches - before.batches).toBe(2);
  expect(f.roster.work.members - before.members).toBe(1_008);
  expect(f.entities()).toHaveLength(1_000);
  expect(f.entities()).not.toContain(1_000);
});
