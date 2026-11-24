import { expect, it } from 'vitest';
import { packCardLookupProjections } from '../../raytracing/card-lookup';
import { rebuildCardOwnerIndex, updateCardProjectionRows } from '../../raytracing/card-owner-index';
import type { SurfaceCapture } from '../../raytracing/surface-cards';

function table(
  owners: readonly number[],
  states: readonly number[] = [],
  capacity = owners.length,
) {
  const bytes = new Uint8Array(Math.max(1, capacity) * 80);
  const view = new DataView(bytes.buffer);
  for (let tile = 0; tile < Math.max(1, capacity); tile++) {
    view.setUint32(tile * 80 + 64, owners[tile] ?? 0xffffffff, true);
    view.setUint32(tile * 80 + 68, states[tile] ?? 1, true);
  }
  return bytes;
}

/** Independent reader of the byte contract, not the producer's Map/sort. */
function selected(bytes: Uint8Array, count: number, owner: number) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const word = (tile: number, offset: number) => view.getUint32(tile * 80 + offset, true);
  let lo = 0,
    hi = count,
    comparisons = 0;
  while (lo < hi) {
    comparisons++;
    const mid = lo + Math.floor((hi - lo) / 2),
      head = word(mid, 72);
    if (head === 0 || word(head - 1, 64) >= owner) hi = mid;
    else lo = mid + 1;
  }
  let head = lo === count ? 0 : word(lo, 72);
  const tiles: number[] = [];
  if (head !== 0 && word(head - 1, 64) === owner && owner !== 0xffffffff) {
    while (head !== 0) {
      expect(head).toBeLessThanOrEqual(count);
      expect(tiles.at(-1) ?? -1).toBeLessThan(head - 1);
      expect(word(head - 1, 64)).toBe(owner);
      tiles.push(head - 1);
      head = word(head - 1, 76);
    }
  }
  return { tiles, comparisons };
}

it('indexes id zero and the maximum legal owner while keeping pending/stale and free slots distinct', () => {
  const owners = [0xffffffff, 0, 0xfffffffe, 7, 0, 0xffffffff, 7, 0xfffffffe];
  const bytes = table(owners, [0, 0, 2, 1, 1, 0, 0, 1], 12);
  const before = bytes.slice();
  rebuildCardOwnerIndex(bytes, owners.length);
  for (const owner of [0, 7, 0xfffffffe, 0xffffffff, 42])
    expect(selected(bytes, owners.length, owner).tiles).toEqual(
      owners.flatMap((id, tile) => (id === owner && id !== 0xffffffff ? [tile] : [])),
    );
  for (let tile = 0; tile < 12; tile++)
    expect(bytes.slice(tile * 80, tile * 80 + 72)).toEqual(before.slice(tile * 80, tile * 80 + 72));
});

it('keeps physical tie/stale order through interleaved owners, holes, eviction and slot reuse', () => {
  const bytes = table([4, 8, 4, 0xffffffff, 4, 8], [1, 0, 2, 0, 0, 1]);
  rebuildCardOwnerIndex(bytes, 6);
  expect(selected(bytes, 6, 4).tiles).toEqual([0, 2, 4]);
  const view = new DataView(bytes.buffer);
  for (const tile of [0, 2, 4]) view.setUint32(tile * 80 + 64, 0xffffffff, true);
  view.setUint32(3 * 80 + 64, 2, true);
  rebuildCardOwnerIndex(bytes, 6);
  expect(selected(bytes, 6, 4).tiles).toEqual([]);
  expect(selected(bytes, 6, 2).tiles).toEqual([3]);
  expect(selected(bytes, 6, 8).tiles).toEqual([1, 5]);
  expect([0, 1, 2, 3, 4, 5].map((tile) => view.getUint32(tile * 80 + 72, true))).toEqual([
    4, 2, 0, 0, 0, 0,
  ]);
});

it('handles an empty table, a singleton, byte-offset views and explicit index bounds', () => {
  const storage = new Uint8Array(176),
    bytes = storage.subarray(8, 168);
  new DataView(bytes.buffer, bytes.byteOffset).setUint32(64, 0, true);
  rebuildCardOwnerIndex(bytes, 0);
  expect(selected(bytes, 0, 0).tiles).toEqual([]);
  rebuildCardOwnerIndex(bytes, 1);
  expect(selected(bytes, 1, 0).tiles).toEqual([0]);
  expect(storage.subarray(0, 8)).toEqual(new Uint8Array(8));
  for (const count of [-1, 3, 0.5, Infinity, NaN])
    expect(() => rebuildCardOwnerIndex(bytes, count)).toThrow();
  expect(() => rebuildCardOwnerIndex(bytes.subarray(1), 0)).toThrow();
});

it('preserves both index words on geometry, stale, pending and validation writes', () => {
  const bytes = table([5, 1, 5], [2, 1, 0]);
  rebuildCardOwnerIndex(bytes, 3);
  const before = new Uint32Array(bytes.slice().buffer);
  const changed = table([5, 1], [1, 0]);
  updateCardProjectionRows(bytes, 0, changed);
  const after = new Uint32Array(bytes.buffer);
  for (const word of [18, 19, 38, 39, 58, 59]) expect(after[word]).toBe(before[word]);
  expect(after[17]).toBe(1);
  expect(after[37]).toBe(0);
  expect(() => updateCardProjectionRows(bytes, 3, changed)).toThrow();
});

it('limits unrelated owner directory probes logarithmically without a finite candidate cap', () => {
  const count = 8192,
    owners = Array.from({ length: count }, (_, tile) => (tile % 3 === 0 ? 17 : tile + 100));
  const bytes = table(owners);
  rebuildCardOwnerIndex(bytes, count);
  const found = selected(bytes, count, 17);
  expect(found.tiles).toEqual(owners.flatMap((owner, tile) => (owner === 17 ? [tile] : [])));
  expect(found.comparisons).toBeLessThanOrEqual(14);
  expect(selected(bytes, count, 0xfffffffe).tiles).toEqual([]);
});

it('clears spare directory/link words when the admitted window becomes smaller', () => {
  const bytes = table([3, 1, 2], [], 5);
  const view = new DataView(bytes.buffer);
  for (let tile = 0; tile < 5; tile++) {
    view.setUint32(tile * 80 + 72, 99, true);
    view.setUint32(tile * 80 + 76, 99, true);
  }
  rebuildCardOwnerIndex(bytes, 1);
  expect([0, 1, 2, 3, 4].map((tile) => view.getUint32(tile * 80 + 72, true))).toEqual([
    1, 0, 0, 0, 0,
  ]);
  expect([0, 1, 2, 3, 4].map((tile) => view.getUint32(tile * 80 + 76, true))).toEqual([
    0, 0, 0, 0, 0,
  ]);
  expect(() => updateCardProjectionRows(bytes.subarray(1), 0, new Uint8Array(80))).toThrow();
});

it('publishes an owner-sorted directory without moving the physical Card tiles', () => {
  const projection = {
    origin: [0, 0, 0],
    u: [1, 0, 0],
    v: [0, 1, 0],
    n: [0, 0, 1],
    width: 1,
    height: 1,
    depth: 1,
  };
  const cache = {
    allocatedTiles: 3,
    entries: [
      {
        instanceId: 9,
        firstTile: 0,
        geometryKey: 'g9',
        captureKey: 'k9',
        projections: [projection, projection],
      },
      {
        instanceId: 1,
        firstTile: 2,
        geometryKey: 'g1',
        captureKey: 'k1',
        projections: [projection],
      },
    ],
  } as unknown as SurfaceCapture;
  const packed = packCardLookupProjections(
    cache,
    [
      { instanceId: 9, key: 'g9' },
      { instanceId: 1, key: 'g1' },
    ],
    [
      { instance: { instanceId: 9 }, captureKey: 'k9' },
      { instance: { instanceId: 1 }, captureKey: 'k1' },
    ] as never,
  );
  const words = new Uint32Array(packed.bytes.buffer);
  expect([words[16], words[36], words[56]]).toEqual([9, 9, 1]);
  expect([words[18], words[38], words[58]]).toEqual([3, 1, 0]);
  expect([words[19], words[39], words[59]]).toEqual([2, 0, 0]);
});
