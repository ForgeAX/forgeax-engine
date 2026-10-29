import { expect, it } from 'vitest';
import { BatchTopology } from '../gpu-driven/batch-topology';
import { GpuDrawSelection } from '../gpu-driven/draw-selection';
import { suppressedPrimitiveWords } from '../gpu-driven/production-raster-prepare';
import { MaterialResource } from '../material-resource';
import type { RenderSceneSlot } from '../scene/render-scene-types';
import { preparedSnapshot } from './gpu-driven-production-fixture';

it('queries shared geometry/material identity without expanding its consumers', () => {
  const source = preparedSnapshot(1, 3);
  const topology = new BatchTopology();
  topology.rebuild([
    { slot: 0, generation: 0, version: 0, worldId: 0, entityKey: 1, snapshot: source },
  ]);
  const owned = new GpuDrawSelection(topology.query(topology.sourcePlan(), undefined).batches);
  expect(owned.ownsAll(source)).toBe(true);
  expect(owned.ownsAll({ ...source, entityKey: 99 })).toBe(true);
  expect(owned.ownsAll({ ...source, worldId: 1 })).toBe(false);
  expect(owned.ownsAll({ ...source, assetHandle: 4 })).toBe(false);
  const independent = new MaterialResource(source.material.snapshot);
  expect(owned.ownsAll({ ...source, material: independent, materials: [independent] })).toBe(false);
  expect(owned.ownsAll({ ...source, instances: { instanceCount: 0 } as never })).toBe(false);
  const direct = new GpuDrawSelection([]);
  source.material.adopt({ ...source.material.snapshot, transparent: true });
  expect(owned.ownsAll(source)).toBe(true);
  expect(direct.ownsAll(source)).toBe(false);
});

it('keeps sparse source draw indices and partial GPU ownership', () => {
  const source = preparedSnapshot(1, 3);
  const first = source.gpuDrivenDraws?.[0];
  if (first === undefined) throw new Error('Missing source geometry');
  const sparse = { ...source, gpuDrivenDraws: [{ ...first, drawItemIndex: 7 }] };
  const topology = new BatchTopology();
  topology.rebuild([
    { slot: 0, generation: 0, version: 0, worldId: 0, entityKey: 1, snapshot: sparse },
  ]);
  const owned = new GpuDrawSelection(topology.query(topology.sourcePlan(), undefined).batches);
  expect(owned.has(sparse, 7)).toBe(true);
  expect(owned.has(sparse, 0)).toBe(false);
  const other = new MaterialResource(source.material.snapshot);
  const mixed = {
    ...sparse,
    materials: [source.material, other],
    gpuDrivenDraws: [...sparse.gpuDrivenDraws, { ...first, materialSlot: 1, drawItemIndex: 8 }],
  };
  expect(owned.has(mixed, 7)).toBe(true);
  expect(owned.has(mixed, 8)).toBe(false);
  expect(owned.ownsAll(mixed)).toBe(false);
});

it('projects visibility from scene slots with independent state during nested evaluation', () => {
  const source = preparedSnapshot(1, 3);
  const slots: RenderSceneSlot[] = [1, 33].map((slot, index) => ({
    slot,
    generation: 0,
    version: 0,
    worldId: 0,
    entityKey: 10 + index,
    snapshot: { ...source, entityKey: 10 + index },
  }));
  let nested: Uint32Array | undefined;
  const active = new Set<number>([11]);
  active.has = (entity: number) => {
    if (entity === 10) nested = suppressedPrimitiveWords(slots, undefined, new Set([10]), 64);
    return entity === 11;
  };
  expect([...suppressedPrimitiveWords(slots, undefined, active, 64)]).toEqual([2, 0]);
  expect(nested === undefined ? undefined : [...nested]).toEqual([0, 2]);
  expect([...suppressedPrimitiveWords(slots, undefined, new Set([10, 11]), 64)]).toEqual([0, 0]);
});
