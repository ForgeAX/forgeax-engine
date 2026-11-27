import { compileShader } from '@forgeax/engine-shader-compiler';
import { expect, it } from 'vitest';
import {
  x01AssociationWorkKernel,
  x01Composition,
  x01CursorRows,
  x01LocalProjectionRows,
  x01NearbyBoxes,
  x01OwnerRows,
  x01OwnerVisits,
  x01ReverseId,
  x01SpatialOwnerRows,
} from './card-candidate-x01.fixture';
import { cardOwnerIndexWorkKernel } from './card-owner-index.fixture';

it('preserves the independently authored nearby cube rows over genuine 3D fixed-density sizes', async () => {
  for (const count of [8, 64, 256, 512, 1024]) {
    const scene = await x01Composition(count);
    for (const point of [
      [0, 0, 0.75],
      [0.75, 0.75, 0.75],
      [4, 4, 4.75],
    ] as const) {
      const expected = x01NearbyBoxes(scene.centers, point),
        actual = x01CursorRows(scene.composition.data.bounds, point);
      expect(new Set(actual.rows).size).toBe(actual.rows.length);
      for (const row of expected) expect(actual.rows).toContain(row);
    }
  }
});

it('keeps complete fallback rows for disabled, wrong-radius and outside-domain indexes', async () => {
  const scene = await x01Composition(1024),
    original = scene.composition.data.bounds;
  for (const mode of ['disabled', 'wrong-radius', 'outside'] as const) {
    const bytes = original.slice(),
      data = new DataView(bytes.buffer);
    if (mode === 'disabled') data.setUint32(28, 0, true);
    if (mode === 'wrong-radius') data.setFloat32(44, 0, true);
    const point = mode === 'outside' ? ([10000, 10000, 10000] as const) : ([0, 0, 0.75] as const);
    const actual = x01CursorRows(bytes, point);
    expect(actual.mode).toBe('roster');
    expect(actual.rows).toEqual(Array.from({ length: 1024 }, (_, row) => row));
  }
});

it('detects a valid-range derived-row omission rather than treating fewer visits as acceleration', async () => {
  const scene = await x01Composition(1024),
    bytes = scene.composition.data.bounds.slice(),
    data = new DataView(bytes.buffer);
  expect(data.getUint32(28, true)).toBe(1);
  const first = data.getUint32(68, true),
    count = data.getUint32(72, true);
  for (let i = 0; i < count; i++)
    if (data.getUint32((first + i) * 4, true) === 0) data.setUint32((first + i) * 4, 1, true);
  const point = [0, 0, 0.75] as const;
  expect(x01NearbyBoxes(scene.centers, point)).toContain(0);
  expect(x01CursorRows(bytes, point).rows).not.toContain(0);
});

it('retains overlap beyond four and a nearby missing field in the complete candidate domain', async () => {
  const overlap = await x01Composition(512, 'overlap'),
    missing = await x01Composition(512, 'missing'),
    point = [0, 0, 0.75] as const;
  const expected = x01NearbyBoxes(overlap.centers, point);
  expect(expected).toHaveLength(6);
  for (const row of expected)
    expect(x01CursorRows(overlap.composition.data.bounds, point).rows).toContain(row);
  expect(x01CursorRows(missing.composition.data.bounds, point).rows).toContain(511);
  // Required geometry coverage is independent of the four retained output IDs.
  // This CPU test does not execute SDF sample/rank/overflow GPU arithmetic.
});

it('preserves actual binary-ID control and complete scan recovery independently of row order', async () => {
  const scene = await x01Composition(1024),
    bytes = scene.composition.data.bounds,
    id = scene.ids[1023];
  if (id === undefined) throw Error('Last sparse identity required');
  expect(x01ReverseId(bytes, scene.composition.data.instances, id).row).toBe(1023);
  const disabled = bytes.slice();
  new DataView(disabled.buffer).setUint32(28, 0, true);
  const fallback = x01ReverseId(disabled, scene.composition.data.instances, id);
  expect(fallback.row).toBe(1023);
  expect(fallback.identityLoads).toBe(1024);
});

it('keeps malformed local references on the complete fallback domain', async () => {
  const scene = await x01Composition(512),
    bytes = scene.composition.data.bounds.slice(),
    data = new DataView(bytes.buffer),
    point = [0, 0, 0.75] as const;
  expect(x01CursorRows(bytes, point).mode).toBe('indexed');
  const first = data.getUint32(68, true),
    count = data.getUint32(72, true);
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i++) data.setUint32((first + i) * 4, 512, true);
  const fallback = x01CursorRows(bytes, point);
  expect(fallback.mode).toBe('roster');
  expect(fallback.rows).toEqual(Array.from({ length: 512 }, (_, row) => row));
});

it('visits only owned physical Card chains while retaining holes, stale rows and global order', () => {
  for (const count of [8, 64, 256, 1024])
    for (const perOwner of [1, 6, 12]) {
      const ids = Array.from({ length: count }, (_, row) => 1_000_003 + row * 17),
        owner = ids[count - 1];
      if (owner === undefined) throw Error('Sparse owner required');
      const rows = x01OwnerRows(ids, perOwner),
        actual = x01OwnerVisits(rows.bytes, owner);
      const expected = rows.owners.flatMap((id, tile) => (id === owner ? [tile] : []));
      expect(actual.visited).toEqual(expected);
      expect(actual.visited.length).toBe(perOwner);
      expect(actual.directorySteps).toBeLessThanOrEqual(
        Math.ceil(Math.log2(rows.owners.length)) + 1,
      );
    }
});

it('detects an omitted owner-link without compacting physical atlas slots', () => {
  const rows = x01OwnerRows([7, 23, 89, 401, 809, 1601, 3203, 6407], 6),
    original = x01OwnerVisits(rows.bytes, 7);
  expect(original.visited).toHaveLength(6);
  const first = original.visited[0];
  if (first === undefined) throw Error('Physical head required');
  new DataView(rows.bytes.buffer).setUint32(first * 80 + 76, 0, true);
  expect(x01OwnerVisits(rows.bytes, 7).visited).not.toEqual(original.visited);
});

it('prepares actual association and owner work bindings through the source compiler without a device', async () => {
  for (const [entry, code] of [
    ['x01Candidates', x01AssociationWorkKernel()],
    ['main', cardOwnerIndexWorkKernel()],
  ] as const) {
    const result = await compileShader(code, { id: `card-x01-${entry}`, computeEntry: entry });
    expect(result.ok, result.ok ? '' : JSON.stringify(result.error)).toBe(true);
    if (!result.ok) throw Error('Actual source preparation failed');
    expect(
      result.value.reflection.boundGlobals.filter((binding) => binding.addressSpace === 'storage')
        .length,
    ).toBeLessThanOrEqual(7);
  }
});

it('records the single large owner distinction from local 3D projection support', () => {
  for (const count of [8, 64, 256, 512]) {
    const bytes = x01SpatialOwnerRows(count),
      current = x01OwnerVisits(bytes, 7),
      possible = x01LocalProjectionRows(bytes, [0, 0, 0.5]);
    expect(current.visited).toHaveLength(count * 6);
    expect(possible).toEqual([0]);
  }
});
it('keeps complete acceleration within the existing work-growth target at the mid-scale grid cliff', async () => {
  const reference = await x01Composition(64),
    referenceVisits = x01CursorRows(reference.composition.data.bounds, [0, 0, 0.75]).rows.length;
  for (const count of [256, 512]) {
    const scene = await x01Composition(count),
      bounds = scene.composition.data.bounds;
    expect(
      new DataView(bounds.buffer).getUint32(28, true),
      'A feasible complete conservative grid must survive oversized pressure',
    ).toBe(1);
    const actual = x01CursorRows(bounds, [0, 0, 0.75]);
    expect(actual.rows.length).toBeLessThanOrEqual(referenceVisits * 2.5);
    for (const row of x01NearbyBoxes(scene.centers, [0, 0, 0.75]))
      expect(actual.rows).toContain(row);
  }
});
