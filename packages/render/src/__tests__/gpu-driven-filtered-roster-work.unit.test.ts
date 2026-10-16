import { expect, it, vi } from 'vitest';
import * as drawKeys from '../extract/gpu-driven';
import { freezePreparedGpuDrivenDraw } from '../gpu-driven/prepared-draw';
import {
  assembleFilteredGroups,
  buildFilteredGroups,
  type FilteredGroup,
} from '../gpu-driven/production-raster-prepare';
import { createFilterPlanFixture } from './gpu-driven-filter-plan-fixture';

function fixture() {
  const f = createFilterPlanFixture();
  const prepared = f.prepare();
  const groups = buildFilteredGroups(prepared.batchRows, undefined, f.bindings).groups;
  const first = groups.values().next().value;
  if (first === undefined || first.source.prepared === undefined) throw Error('missing group');
  return { prepared, first };
}

it('builds one material representative key for adjacent equal receipts without refreezing owned candidates', () => {
  const { prepared, first } = fixture();
  const groups = new Map(Array.from({ length: 64 }, (_, i) => [String(i), first]));
  const key = vi.spyOn(drawKeys, 'gpuDrivenMaterialArtifactKey');
  const freeze = vi.spyOn(Object, 'freeze');
  try {
    const output = assembleFilteredGroups(
      prepared.source,
      prepared.worldKeys,
      prepared.drawKeys,
      new Set(),
      groups.values(),
    );
    expect(key).toHaveBeenCalledTimes(1);
    expect(freeze.mock.calls.filter(([value]) => value === first.candidates)).toHaveLength(0);
    expect(output.batches).toHaveLength(64);
    expect(output.materialBatches).toEqual([output.batches[0]]);
    expect(output.plan.candidateCount).toBe(first.candidates.length * 64);
    for (const batch of output.plan.batches) {
      expect(Object.isFrozen(batch)).toBe(true);
      expect(Object.isFrozen(batch.candidates)).toBe(true);
      expect(batch.candidates).toBe(first.candidates);
    }
  } finally {
    key.mockRestore();
    freeze.mockRestore();
  }
});

it('keeps the first representative across alternating, missing and changing receipt observations', () => {
  const { prepared, first } = fixture();
  const original = first.source.prepared;
  if (original === undefined) throw Error('missing receipt');
  const variants = [
    original,
    { ...original, receiptGeneration: original.receiptGeneration + 1 },
    undefined,
    original,
  ];
  const groups = new Map<string, FilteredGroup>();
  variants.forEach((value, i) => {
    const { prepared: _prepared, ...source } = first.source;
    groups.set(String(i), {
      ...first,
      source: value === undefined ? source : { ...source, prepared: value },
    });
  });
  const output = assembleFilteredGroups(
    prepared.source,
    prepared.worldKeys,
    prepared.drawKeys,
    new Set(),
    groups.values(),
  );
  expect(output.materialBatches).toEqual([output.batches[0], output.batches[1]]);
  let reads = 0;
  const varying = {
    ...original,
    get receiptGeneration() {
      return original.receiptGeneration + reads++;
    },
  };
  const dynamic = { ...first, source: { ...first.source, prepared: varying } };
  const changing = assembleFilteredGroups(
    prepared.source,
    prepared.worldKeys,
    prepared.drawKeys,
    new Set(),
    new Map([
      ['a', dynamic],
      ['b', dynamic],
    ]).values(),
  );
  expect(reads).toBe(2);
  expect(changing.materialBatches).toEqual(changing.batches);
});

it('preserves source descriptor reads, extra fields and absent LOD without mutating the source', () => {
  const { prepared, first } = fixture();
  const reads: string[] = [];
  const extra = Symbol('extra source fact');
  const source = new Proxy(
    { ...first.source, [extra]: 19 },
    {
      get(target, key, receiver) {
        reads.push(`get:${String(key)}`);
        return Reflect.get(target, key, receiver);
      },
      ownKeys(target) {
        reads.push('keys');
        return Reflect.ownKeys(target);
      },
    },
  );
  const before = { ...source };
  reads.length = 0;
  const output = assembleFilteredGroups(
    prepared.source,
    prepared.worldKeys,
    prepared.drawKeys,
    new Set(),
    new Map([['one', { ...first, source, lod: undefined }]]).values(),
  );
  expect(reads[0]).toBe('get:lod');
  expect(reads.filter((read) => read === 'get:lod')).toHaveLength(1);
  expect(reads.filter((read) => read === 'keys')).toHaveLength(1);
  const batch = output.plan.batches[0];
  expect(batch).toBeDefined();
  expect(Object.hasOwn(batch ?? {}, 'lod')).toBe(false);
  expect(Reflect.get(batch ?? {}, extra)).toBe(19);
  expect(source).toEqual(before);
  expect(Object.isFrozen(source)).toBe(false);
});

it('uses the owned draw publication key across nonadjacent material representatives', () => {
  const { prepared, first } = fixture();
  const original = first.source.prepared;
  if (original === undefined) throw Error('missing receipt');
  const owned = freezePreparedGpuDrivenDraw({
    ...original,
    receiptIdentity: 'source-receipt',
    identity: Object.freeze({ ...original.identity }),
  });
  const changed = freezePreparedGpuDrivenDraw({
    ...original,
    receiptIdentity: 'source-receipt',
    identity: Object.freeze({ ...original.identity }),
    receiptGeneration: original.receiptGeneration + 1,
  });
  const groups = [owned, changed, owned].map((draw) => ({
    ...first,
    source: { ...first.source, prepared: draw },
  }));
  const key = vi.spyOn(drawKeys, 'gpuDrivenMaterialArtifactKey');
  try {
    const output = assembleFilteredGroups(
      prepared.source,
      prepared.worldKeys,
      prepared.drawKeys,
      new Set(),
      groups,
    );
    expect(key).not.toHaveBeenCalled();
    expect(output.materialBatches).toEqual([output.batches[0], output.batches[1]]);
  } finally {
    key.mockRestore();
  }
});
