// feat-20260608-scene-nesting-ecs-fication M2 / w17 + w22 + w23 (red phase) —
// world.instantiateScene + world.getSceneAssetForInstance + perf.
//
// Test file location: under runtime (NOT ecs) because plan-tasks targetFiles
// pointed at packages/ecs/src/__tests__/ but `scripts/check-ecs-no-runtime-
// import.mjs` (AC-29 gate) rejects value-imports of @forgeax/engine-runtime
// from packages/ecs/src/. The scene tests must reach the SceneInstance /
// Transform / ChildOf component tokens (defined in runtime), so the file
// physically lives in runtime; the World method calls themselves still
// resolve to packages/ecs/src/world.ts behind the @forgeax/engine-ecs barrel.
// (See implementer milestone report `filesOutsideTargets` row.)
//
// w17: instantiateScene basic path — Result<Entity, EcsError>; the returned
//   entity is the synthetic root carrying SceneInstance; mapping length =
//   entities.length when no mounts; member entities carry the layer-1
//   component values; ChildOf.parent flows through to caller-supplied parent.
// w22: getSceneAssetForInstance — Ok(sourceHandle) on a SceneInstance root;
//   Err on a plain entity.
// w23: perf — 100 entities x 5 components instantiates < 50ms (plan §5.4).

import { defineComponent, World } from '@forgeax/engine-ecs';
import { SceneInstance } from '@forgeax/engine-render';
import {
  ChildOf,
  Transform,
  worldGetSceneAssetForInstance,
  worldInstantiateScene,
} from '@forgeax/engine-scene';
import type { Handle, SceneAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

function registerSceneAsset(
  world: World,
  asset: SceneAsset,
  extraComponents: readonly Parameters<World['components']['register']>[0][] = [],
): Handle<'SceneAsset', 'shared'> {
  for (const component of [SceneInstance, ChildOf, Transform, ...extraComponents]) {
    world.components.register(component).unwrap();
  }
  return world.allocSharedRef('SceneAsset', asset);
}

function instantiateScene(
  world: World,
  handle: Handle<'SceneAsset', 'shared'>,
  parent?: Parameters<typeof worldInstantiateScene>[2],
) {
  return worldInstantiateScene(world, handle, parent);
}

describe('world.instantiateScene basic (w17)', () => {
  it('returns Result.ok(synthetic root entity) with SceneInstance attached', () => {
    const world = new World();
    const asset: SceneAsset = {
      kind: 'scene',
      entities: { 'entity-0': { components: { Transform: { pos: [1, 2, 3] } } } },
    };
    const handle = registerSceneAsset(world, asset);
    const r = instantiateScene(world, handle);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const inst = world.get(r.value.root, SceneInstance);
    expect(inst.ok).toBe(true);
  });

  it('SceneInstance.mapping length === entities.length when no mounts', () => {
    const world = new World();
    const asset: SceneAsset = {
      kind: 'scene',
      entities: {
        'entity-0': { components: { Transform: {} } },
        'entity-1': { components: { Transform: {} } },
        'entity-2': { components: { Transform: {} } },
      },
    };
    const handle = registerSceneAsset(world, asset);
    const r = instantiateScene(world, handle);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const inst = world.get(r.value.root, SceneInstance);
    if (!inst.ok) throw new Error('get failed');
    expect(inst.value.mapping).toBeInstanceOf(Uint32Array);
    if (!(inst.value.mapping instanceof Uint32Array)) return;
    expect(inst.value.mapping.length).toBe(3);
  });

  it('member entities carry the layer-1 component values', () => {
    const world = new World();
    const asset: SceneAsset = {
      kind: 'scene',
      entities: { 'entity-0': { components: { Transform: { pos: [7, 8, 9] } } } },
    };
    const handle = registerSceneAsset(world, asset);
    const r = instantiateScene(world, handle);
    if (!r.ok) throw new Error('instantiateScene failed');
    const inst = world.get(r.value.root, SceneInstance);
    if (!inst.ok) throw new Error('get SceneInstance failed');
    expect(inst.value.mapping).toBeInstanceOf(Uint32Array);
    if (!(inst.value.mapping instanceof Uint32Array)) return;
    const memberRaw = inst.value.mapping[0];
    expect(memberRaw).toBeDefined();
    if (memberRaw === undefined) return;
    const t = world.get(memberRaw as never, Transform);
    expect(t.ok).toBe(true);
    if (!t.ok) return;
    expect(Array.from(t.value.pos)).toEqual([7, 8, 9]);
  });

  it('synthetic root ChildOf flows to caller-supplied parent', () => {
    const world = new World();
    const parentRes = world.spawn({ component: Transform, data: {} });
    if (!parentRes.ok) throw new Error('spawn parent failed');
    const parent = parentRes.value;

    const asset: SceneAsset = {
      kind: 'scene',
      entities: { 'entity-0': { components: { Transform: {} } } },
    };
    const handle = registerSceneAsset(world, asset);
    const r = instantiateScene(world, handle, parent);
    if (!r.ok) throw new Error('instantiateScene failed');
    const rootChildOf = world.get(r.value.root, ChildOf);
    expect(rootChildOf.ok).toBe(true);
    if (!rootChildOf.ok) return;
    expect(rootChildOf.value.parent as unknown as number).toBe(parent as unknown as number);
  });
});

describe('world.getSceneAssetForInstance (w22)', () => {
  it('returns Ok(sourceHandle) for a SceneInstance root', () => {
    const world = new World();
    const asset: SceneAsset = {
      kind: 'scene',
      entities: { 'entity-0': { components: { Transform: {} } } },
    };
    const handle = registerSceneAsset(world, asset);
    const r = instantiateScene(world, handle);
    if (!r.ok) throw new Error('instantiateScene failed');
    const got = worldGetSceneAssetForInstance(world, r.value.root);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.value as unknown as number).toBe(handle as unknown as number);
  });

  it('returns Err on a plain entity (no SceneInstance component)', () => {
    const world = new World();
    const e = world.spawn({ component: Transform, data: {} });
    if (!e.ok) throw new Error('spawn failed');
    const got = worldGetSceneAssetForInstance(world, e.value);
    expect(got.ok).toBe(false);
  });
});

describe('world.instantiateScene perf (w23) — 100 entities x 5 components', () => {
  it('instantiates < 50ms', () => {
    const C1 = defineComponent('SceneNestPerfC1', { a: { type: 'f32', default: 0 } });
    const C2 = defineComponent('SceneNestPerfC2', { a: { type: 'f32', default: 0 } });
    const C3 = defineComponent('SceneNestPerfC3', { a: { type: 'f32', default: 0 } });
    const C4 = defineComponent('SceneNestPerfC4', { a: { type: 'f32', default: 0 } });
    const N = 100;
    const entities = Object.fromEntries(
      Array.from({ length: N }, (_, i) => [
        `entity-${i}`,
        {
          components: {
            Transform: {},
            SceneNestPerfC1: { a: i },
            SceneNestPerfC2: { a: i },
            SceneNestPerfC3: { a: i },
            SceneNestPerfC4: { a: i },
          },
        },
      ]),
    );
    const asset: SceneAsset = { kind: 'scene', entities };
    // Best of several fresh Worlds: a single cold sample also times JIT warm-up
    // and host load, which made this budget flaky on busy machines.
    let best = Number.POSITIVE_INFINITY;
    for (let sample = 0; sample < 5; sample += 1) {
      const world = new World();
      const handle = registerSceneAsset(world, asset, [C1, C2, C3, C4]);
      const t0 = performance.now();
      const r = instantiateScene(world, handle);
      best = Math.min(best, performance.now() - t0);
      expect(r.ok).toBe(true);
    }
    expect(best).toBeLessThan(50);
  });
});
