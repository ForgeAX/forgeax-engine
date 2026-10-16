// m1-t4: Glyph + tilemap worldId collision test (TDD red).
//
// Verify D-1a #6 (glyph bakeCache) and #7 (tilemap layer caches) worldId
// namespace isolation:
//
//   Glyph:  dual-world same entity-index → bakeRecord not shared
//           (meshHandleId different)
//   Tilemap: dual-world same layer entity handle → layer caches not shared
//
// Anchors:
//   plan-tasks.json m1-t4
//   plan-strategy D-1a #6/#7
//   requirements AC-07

import { describe, expect, it } from 'vitest';
import { worldEntityKey } from '../../../render/src/record/frame-snapshot';

// ─── Glyph bakeCache: worldEntityKey key compositing ────────────────────────

describe('glyph bakeCache key compositing', () => {
  it('dual-world same entity-index → different worldEntityKey values', () => {
    // bakeCache is a Map<number, BakeRecord> keyed by the entity index.
    // With worldId compositing, the key becomes worldEntityKey(worldId, index).
    const keyA = worldEntityKey(0, 42); // worldA entity index 42
    const keyB = worldEntityKey(1, 42); // worldB entity index 42 (same index!)
    expect(keyA).not.toBe(keyB);
  });

  it('bakeCache lookup: worldA entity(42) does not hit worldB entity(42) entry', () => {
    // Simulate the bakeCache Map behavior
    const bakeCache = new Map<number, { meshHandleId: number }>();

    const keyA = worldEntityKey(0, 42);
    const keyB = worldEntityKey(1, 42);

    // worldA entity(42) writes a bakeRecord
    bakeCache.set(keyA, { meshHandleId: 100 });
    // worldB entity(42) writes a different bakeRecord
    bakeCache.set(keyB, { meshHandleId: 200 });

    // Verify isolation
    expect(bakeCache.get(keyA)?.meshHandleId).toBe(100);
    expect(bakeCache.get(keyB)?.meshHandleId).toBe(200);
    expect(bakeCache.get(keyA)?.meshHandleId).not.toBe(bakeCache.get(keyB)?.meshHandleId);
  });

  it('bakeCache: worldA entity(42) misses when not yet written', () => {
    const bakeCache = new Map<number, { meshHandleId: number }>();
    const keyA = worldEntityKey(0, 42);
    expect(bakeCache.get(keyA)).toBeUndefined();
  });
});

// ─── Tilemap layer cache: worldEntityKey key compositing ────────────────────

describe('tilemap layer cache key compositing', () => {
  it('dual-world same layer entity handle → different worldEntityKey values', () => {
    // layer caches use unwrapHandle(layerEntity) which is the entity's
    // shared-ref slot number. With worldId compositing:
    const keyA = worldEntityKey(0, 5); // worldA layer entity slot 5
    const keyB = worldEntityKey(1, 5); // worldB layer entity slot 5 (same slot!)
    expect(keyA).not.toBe(keyB);
  });

  it('layerDerivedEntities: worldA layer(5) entries not visible from worldB', () => {
    const cache = new Map<number, number[]>();

    const keyA = worldEntityKey(0, 5);
    const keyB = worldEntityKey(1, 5);

    cache.set(keyA, [1, 2, 3]);
    cache.set(keyB, [4, 5]);

    expect(cache.get(keyA)).toEqual([1, 2, 3]);
    expect(cache.get(keyB)).toEqual([4, 5]);
    expect(cache.get(keyA)).not.toEqual(cache.get(keyB));
  });

  it('layerEverBuilt: worldA layer(5) built flag independent of worldB', () => {
    const cache = new Set<number>();

    const keyA = worldEntityKey(0, 5);
    const keyB = worldEntityKey(1, 5);

    cache.add(keyA);

    expect(cache.has(keyA)).toBe(true);
    expect(cache.has(keyB)).toBe(false);
  });

  it('layerStreamCache: worldA layer(5) stream data not visible from worldB', () => {
    const cache = new Map<number, { specs: string[] }>();

    const keyA = worldEntityKey(0, 5);
    const keyB = worldEntityKey(1, 5);

    cache.set(keyA, { specs: ['a', 'b'] });
    cache.set(keyB, { specs: ['c'] });

    expect(cache.get(keyA)?.specs).toEqual(['a', 'b']);
    expect(cache.get(keyB)?.specs).toEqual(['c']);
  });

  it('layerChunkActive: worldA layer(5) active chunks independent of worldB', () => {
    const cache = new Map<number, Set<number>>();

    const keyA = worldEntityKey(0, 5);
    const keyB = worldEntityKey(1, 5);

    cache.set(keyA, new Set([0, 1]));
    cache.set(keyB, new Set([2]));

    expect(cache.get(keyA)?.has(0)).toBe(true);
    expect(cache.get(keyA)?.has(2)).toBe(false);
    expect(cache.get(keyB)?.has(2)).toBe(true);
    expect(cache.get(keyB)?.has(0)).toBe(false);
  });
});

// ─── String composite key prefixing ─────────────────────────────────────────

describe('string composite key prefixing', () => {
  it('tilemap chunk key prefixed with worldId', () => {
    // D-1a #7: string key "${layerKey}:${chunkIdx}" becomes
    // "${worldId}:${layerKey}:${chunkIdx}"
    const worldId = 0;
    const layerKey = worldEntityKey(worldId, 5);
    const chunkIdx = 3;
    const key = `${worldId}:${layerKey}:${chunkIdx}`;

    expect(key).toBe('0:5:3');
  });

  it('worldA and worldB chunk keys differ for same layer/chunk', () => {
    const layerKeyA = worldEntityKey(0, 5);
    const layerKeyB = worldEntityKey(1, 5);
    const chunkIdx = 3;

    const keyA = `0:${layerKeyA}:${chunkIdx}`;
    const keyB = `1:${layerKeyB}:${chunkIdx}`;

    expect(keyA).not.toBe(keyB);
    expect(keyA).toBe('0:5:3');
    expect(keyB).toBe('1:4294967301:3');
  });
});
