import { describe, expect, it, vi } from 'vitest';
import { cleanPerFrameCaches } from '../fold-buckets';
import { instanceCollectionCacheKey } from '../frame-snapshot';

it('retains instance collections separately from material owners and retires dead resources once', () => {
  const entity = 42;
  const later = 43;
  const retained = 44;
  const collection = instanceCollectionCacheKey({ cacheKey: 42, collectionId: 7 });
  const destroy = vi.fn(() => ({ ok: true, value: undefined }));
  const entry = () => ({ buffer: { isDestroyed: false, destroy } });
  const state = {
    materialBgPerEntity: new Map(
      [entity, later, retained, collection, 999].map((key) => [key, new Map()]),
    ),
    instancesBgPerEntity: new Map([entity, later, collection, 999].map((key) => [key, new Map()])),
    instanceBuffers: new Map(
      [entity, later, retained, collection, 999].map((key) => [key, entry()]),
    ),
    instanceBufferChunks: new Map([
      [collection, new Map([[0, entry()]])],
      [999, new Map([[0, entry()]])],
    ]),
  };
  const rows = [
    { source: { entityKey: 42, instances: { cacheKey: 42, collectionId: 7 } } },
    { source: { entityKey: 43 } },
  ];
  const fire = vi.fn();
  cleanPerFrameCaches(
    { errorRegistry: { fire } } as never,
    state as never,
    rows as never,
    new Set([retained]),
  );
  expect([...state.materialBgPerEntity.keys()]).toEqual([entity, later, retained]);
  expect([...state.instancesBgPerEntity.keys()]).toEqual([entity, later]);
  expect([...state.instanceBuffers.keys()]).toEqual([entity, later, retained, collection]);
  expect([...state.instanceBufferChunks.keys()]).toEqual([collection]);
  expect(destroy).toHaveBeenCalledTimes(2);
  expect(fire).not.toHaveBeenCalled();
  cleanPerFrameCaches(
    { errorRegistry: { fire } } as never,
    state as never,
    rows as never,
    new Set([retained]),
  );
  expect(destroy).toHaveBeenCalledTimes(2);
});

it('namespaces authored, generated, and legacy instance cache owners', () => {
  const authored = instanceCollectionCacheKey({ cacheKey: 42, collectionId: 0x1_0000_0000 });
  const legacy = instanceCollectionCacheKey({ cacheKey: 42 });
  const waterIdentity = (worldIdentity: string) =>
    JSON.stringify([worldIdentity, 'scene-entity:42', 3, 'zone-a', 2, 'camera:7:left', 'tile:0:0']);
  const water = instanceCollectionCacheKey({
    cacheKey: 42,
    cacheIdentity: waterIdentity('world-a'),
  });

  expect(authored).toBe('collection:4294967296');
  expect(legacy).toBe('legacy-instance:42');
  expect(water).toBe(`water:${waterIdentity('world-a')}`);
  expect(water).not.toBe(
    instanceCollectionCacheKey({ cacheKey: 42, cacheIdentity: waterIdentity('world-b') }),
  );
  expect(water).not.toBe(authored);
  expect(water).not.toBe(legacy);
});

describe('empty retained input', () => {
  it('retires all resource owners when no rows remain', () => {
    const destroy = vi.fn(() => ({ ok: true, value: undefined }));
    const state = {
      materialBgPerEntity: new Map(),
      instancesBgPerEntity: new Map(),
      instanceBuffers: new Map([[1, { buffer: { isDestroyed: false, destroy } }]]),
    };
    cleanPerFrameCaches({ errorRegistry: { fire: vi.fn() } } as never, state as never, []);
    expect(state.instanceBuffers.size).toBe(0);
    expect(destroy).toHaveBeenCalledOnce();
  });
});

it('does not enumerate retained rows without resource owners, while disposing transient buffers', () => {
  let rowReads = 0;
  const rows = Array.from({ length: 2048 }, (_, entityKey) => ({
    get source() {
      rowReads += 1;
      return { entityKey };
    },
  }));
  const iterateRows = vi.spyOn(rows, Symbol.iterator);
  const retained = new Set([4096]);
  const iterateRetained = vi.spyOn(retained, Symbol.iterator);
  const destroy = vi.fn(() => ({ ok: true, value: undefined }));
  const fire = vi.fn();
  const state = {
    materialBgPerEntity: new Map(),
    instancesBgPerEntity: new Map(),
    instanceBuffers: new Map(),
    instanceBufferChunks: new Map(),
    transientInstanceBuffers: [{ buffer: { isDestroyed: false, destroy } }],
  };
  cleanPerFrameCaches(
    { errorRegistry: { fire } } as never,
    state as never,
    rows as never,
    retained,
  );
  expect(destroy).toHaveBeenCalledOnce();
  expect(state.transientInstanceBuffers).toHaveLength(0);
  expect(fire).not.toHaveBeenCalled();
  expect(rowReads).toBe(0);
  expect(iterateRows).not.toHaveBeenCalled();
  expect(iterateRetained).not.toHaveBeenCalled();
});
