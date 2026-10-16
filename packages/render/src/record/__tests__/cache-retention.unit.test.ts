import { describe, expect, it, vi } from 'vitest';
import { cleanPerFrameCaches } from '../fold-buckets';
import { instanceCollectionCacheKey, worldEntityKey } from '../frame-snapshot';

it('retains instance collections separately from material owners and retires dead resources once', () => {
  const entity = worldEntityKey(1, 42);
  const later = worldEntityKey(2, 43);
  const retained = worldEntityKey(3, 44);
  const collection = instanceCollectionCacheKey(1, { cacheKey: 42, collectionId: 7 });
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
    morphBuffers: new Map([
      [entity, entry()],
      [collection, entry()],
    ]),
  };
  const rows = [
    { source: { worldId: 1, entityKey: 42, instances: { cacheKey: 42, collectionId: 7 } } },
    { source: { worldId: 2, entityKey: 43 } },
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
  expect([...state.morphBuffers.keys()]).toEqual([entity]);
  expect(destroy).toHaveBeenCalledTimes(3);
  expect(fire).not.toHaveBeenCalled();
  cleanPerFrameCaches(
    { errorRegistry: { fire } } as never,
    state as never,
    rows as never,
    new Set([retained]),
  );
  expect(destroy).toHaveBeenCalledTimes(3);
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
