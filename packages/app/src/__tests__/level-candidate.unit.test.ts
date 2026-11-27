import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { Disabled, Entity, type EntityHandle, World } from '@forgeax/engine-ecs';
import { GlobalTransform, Transform } from '@forgeax/engine-scene';
import type { SceneAsset } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { createLevelCandidate } from '../levels/candidate';
import { LEVEL_STREAMING_SOURCE_COMPONENTS } from '../levels/source-preflight';

it.each([
  'cancel',
  'asset',
  'member',
  'derived',
] as const)('settles a suspended real materializer after %s', (mode) => {
  const assets = new AssetRegistry();
  const world = new World({ assets });
  for (const component of LEVEL_STREAMING_SOURCE_COMPONENTS)
    world.components.register(component).unwrap();
  const scene = assets
    .create<SceneAsset>({
      kind: 'scene',
      entities: {
        first: { components: { Transform: {} } },
        second: { components: { Transform: {} } },
      },
    })
    .unwrap();
  const candidate = createLevelCandidate({ world, assets, scene });
  try {
    for (let step = 0; step < 10000 && candidate.members.length === 0; step++) {
      expect(candidate.step().ok).toBe(true);
    }
    expect(candidate.inspect().phase).toBe('materialize');
    expect(candidate.members.length).toBeGreaterThan(0);
    if (mode === 'derived') {
      for (let step = 0; step < 10000; step++) {
        if (
          candidate.inspect().phase === 'transforms' &&
          candidate.members.some((entity) => world.hasComponent(entity, GlobalTransform))
        )
          break;
        expect(candidate.step().ok).toBe(true);
      }
      const parent = candidate.members.find((entity) =>
        world.hasComponent(entity, GlobalTransform),
      );
      if (parent === undefined) throw Error('missing prepared transform');
      const matrix = world.get(parent, GlobalTransform).unwrap().world.slice();
      matrix[12] = 99;
      world.set(parent, GlobalTransform, { world: matrix }).unwrap();
      expect(candidate.step().ok).toBe(false);
    }
    if (mode === 'asset') {
      assets.replace(scene, { kind: 'scene', entities: {} }).unwrap();
      expect(candidate.step().ok).toBe(false);
    } else if (mode === 'member') {
      const member = candidate.members[0];
      if (member === undefined) throw Error('missing materialized member');
      world.set(member, Transform, { pos: [7, 0, 0] }).unwrap();
      expect(candidate.step().ok).toBe(false);
    }
    expect(() => {
      for (let step = 0; candidate.inspect().phase !== 'retired' && step < 10000; step++) {
        candidate.retireStep().unwrap();
      }
    }).not.toThrow();
    expect(candidate.inspect().phase).toBe('retired');
    expect(runtimeAssets(assets).inspect().snapshots).toBe(0);
    expect(runtimeAssets(assets).inspect().snapshotBytes).toBe(0);
  } finally {
    assets.dispose();
  }
});

it('cancels before acquisition and cannot restart a retired candidate', () => {
  const assets = new AssetRegistry();
  const world = new World({ assets });
  const scene = assets.create<SceneAsset>({ kind: 'scene', entities: {} }).unwrap();
  const candidate = createLevelCandidate({ world, assets, scene });
  try {
    for (let step = 0; candidate.inspect().phase !== 'retired' && step < 10000; step++)
      candidate.retireStep().unwrap();
    expect(candidate.inspect().phase).toBe('retired');
    expect(candidate.step()).toMatchObject({ ok: false, error: { detail: { reason: 'closed' } } });
    expect(candidate.retireStep().unwrap().phase).toBe('retired');
    expect(candidate.members).toHaveLength(0);
    expect(runtimeAssets(assets).inspect().snapshots).toBe(0);
  } finally {
    assets.dispose();
  }
});

it('settles a missing Render owner once and retains its real source until retirement', () => {
  const assets = new AssetRegistry();
  const world = new World({ assets });
  for (const component of LEVEL_STREAMING_SOURCE_COMPONENTS)
    world.components.register(component).unwrap();
  const scene = assets
    .create<SceneAsset>({
      kind: 'scene',
      entities: { first: { components: { Transform: {} } } },
    })
    .unwrap();
  const candidate = createLevelCandidate({ world, assets, scene });
  try {
    let result = candidate.step();
    for (let step = 0; result.ok && step < 10000; step++) result = candidate.step();
    expect(result).toMatchObject({
      ok: false,
      error: { detail: { reason: 'render-unavailable', phase: 'render-source' } },
    });
    if (result.ok) throw Error('missing Render remained pending');
    expect(candidate.step()).toEqual(result);
    expect(candidate.inspect().failure).toBe(result.error);
    expect(candidate.members.length).toBeGreaterThan(0);
    expect(runtimeAssets(assets).inspect().snapshots).toBe(1);
    for (let step = 0; candidate.inspect().phase !== 'retired' && step < 10000; step++)
      candidate.retireStep().unwrap();
    expect(candidate.inspect().phase).toBe('retired');
    expect(candidate.step()).toEqual(result);
    expect(runtimeAssets(assets).inspect().snapshots).toBe(0);
  } finally {
    assets.dispose();
  }
});

it('rejects a foreign asset owner before acquiring any candidate content', () => {
  const assets = new AssetRegistry();
  const foreign = new AssetRegistry();
  const world = new World({ assets: foreign });
  const scene = assets.create<SceneAsset>({ kind: 'scene', entities: {} }).unwrap();
  foreign.create<SceneAsset>({ kind: 'scene', entities: {} }).unwrap();
  const candidate = createLevelCandidate({ world, assets, scene });
  try {
    expect(candidate.step()).toMatchObject({
      ok: false,
      error: { detail: { reason: 'asset-owner' } },
    });
    expect(runtimeAssets(assets).inspect().snapshots).toBe(0);
    expect(runtimeAssets(foreign).inspect().snapshots).toBe(0);
  } finally {
    for (let step = 0; candidate.inspect().phase !== 'retired' && step < 10000; step++)
      candidate.retireStep().unwrap();
    assets.dispose();
    foreign.dispose();
  }
});

it('keeps retirement ownership private when a consumer changes roster observations', () => {
  const assets = new AssetRegistry();
  const world = new World({ assets });
  for (const component of LEVEL_STREAMING_SOURCE_COMPONENTS)
    world.components.register(component).unwrap();
  const permanent = world
    .spawn({ component: Disabled, data: {} }, { component: Transform, data: {} })
    .unwrap();
  const scene = assets
    .create<SceneAsset>({ kind: 'scene', entities: { first: { components: { Transform: {} } } } })
    .unwrap();
  const candidate = createLevelCandidate({ world, assets, scene });
  try {
    for (let step = 0; candidate.members.length === 0 && step < 10000; step++)
      candidate.step().unwrap();
    const owned = [...candidate.members];
    expect(owned.length).toBeGreaterThan(0);
    try {
      const exposed = candidate.members as EntityHandle[];
      exposed.splice(0, exposed.length, permanent);
    } catch {
      /* Frozen observations may refuse writes. */
    }
    (candidate.authorDisabled as Set<EntityHandle>).add(permanent);
    expect(candidate.members).toEqual(owned);
    expect(candidate.authorDisabled.has(permanent)).toBe(false);
    for (let step = 0; candidate.inspect().phase !== 'retired' && step < 10000; step++)
      candidate.retireStep().unwrap();
    expect(candidate.inspect().phase).toBe('retired');
    expect(world.get(permanent, Entity).ok).toBe(true);
    expect(owned.every((entity) => !world.get(entity, Entity).ok)).toBe(true);
    expect(runtimeAssets(assets).inspect().snapshots).toBe(0);
  } finally {
    assets.dispose();
  }
});
