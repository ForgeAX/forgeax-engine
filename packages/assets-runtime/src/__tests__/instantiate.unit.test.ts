// @forgeax/engine-assets-runtime -- keyed SceneAsset instantiate coverage.

import { defineComponent, World } from '@forgeax/engine-ecs';
import {
  ChildOf,
  Children,
  worldDespawnScene,
  worldGetSceneInstanceState,
  worldRemoveSceneOverride,
  worldSetSceneOverride,
} from '@forgeax/engine-scene';
import { SkinJointPathUnresolvedError } from '@forgeax/engine-skinning';
import type { Asset, SceneAsset } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { AssetRegistry } from '../asset-registry';
import type { PostSpawnHook } from '../registry/instantiate';
import { resolveAssetHandle } from '../resolve-asset-handle';
import { defined } from './assert-defined.js';

const T709Tag = defineComponent('T709Tag', { value: 'f32' });
const T709MaterialCarrier = defineComponent('T709MaterialCarrier', {
  materials: 'array<shared<MaterialAsset>>',
});
const SceneInstance = defineComponent('SceneInstance', {
  source: 'shared<SceneAsset>',
  mapping: 'array<entity>',
  state: 'unique<SceneInstanceState>',
});

const MATERIAL_GUID = '11111111-1111-4111-8111-111111111111';
const CHILD_GUID = '22222222-2222-4222-8222-222222222222';
const PARENT_GUID = '33333333-3333-4333-8333-333333333333';

function makeRegistry(postSpawnHook?: PostSpawnHook): AssetRegistry {
  return new AssetRegistry(
    {
      getMaterialShaderManifest: vi.fn().mockReturnValue(undefined),
      findMaterialArtifact: vi.fn().mockReturnValue({ ok: false, error: new Error('mock') }),
      getPipeline: vi.fn().mockReturnValue(undefined),
      installMaterialArtifact: vi.fn(),
      inspect: vi.fn().mockReturnValue({ materialShaders: [] }),
    } as unknown as import('@forgeax/engine-shader').ShaderRegistry,
    undefined,
    undefined,
    postSpawnHook,
  );
}

function makeWorld(): World {
  const world = new World();
  for (const component of [T709Tag, T709MaterialCarrier, SceneInstance]) {
    world.components.register(component).unwrap();
  }
  return world;
}

function twoEntityScene(): SceneAsset {
  return {
    kind: 'scene',
    entities: {
      first: { components: { T709Tag: { value: 1 } } },
      second: { components: { T709Tag: { value: 2 } } },
    },
  };
}

function material(): Asset {
  return {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        program: { module: 'forgeax::default-unlit' },
        renderState: { tags: { LightMode: 'Forward' } },
      },
    ],
    values: {},
  } as unknown as Asset;
}

describe('AssetRegistry.instantiate', () => {
  it.each([
    'anchor',
    'flat',
  ] as const)('keeps Result helpers and the original %s post-spawn failure', (mode) => {
    const failure = new SkinJointPathUnresolvedError(0, ['missing'], 0);
    const reg = makeRegistry(() => ({ ok: false, error: failure }));
    const world = makeWorld();
    const handle = world.allocSharedRef('SceneAsset', twoEntityScene());
    const result =
      mode === 'anchor' ? reg.instantiate(handle, world) : reg.instantiateFlat(handle, world);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected the post-spawn failure');
    expect(result.error).toBe(failure);
    expect(typeof result.unwrap).toBe('function');
    expect(result.unwrapOr('fallback')).toBe('fallback');
    try {
      result.unwrap();
      throw new Error('expected unwrap to throw the original failure');
    } catch (cause) {
      expect(cause).toBe(failure);
    }
    expect(world.inspect().entityCount).toBe(0);
    expect(world.sharedRefs._liveCount()).toBe(1);
    world.sharedRefs.release(handle).unwrap();
  });

  it.each([
    'anchor',
    'flat',
  ] as const)('rejects a stale authored %s instance override before spawning its child', (mode) => {
    const reg = makeRegistry();
    const world = makeWorld();
    world.components.register(ChildOf).unwrap();
    world.components.register(Children).unwrap();
    const stale = world.allocSharedRef('MaterialAsset', material());
    world.sharedRefs.release(stale).unwrap();
    reg
      .catalog(CHILD_GUID, {
        kind: 'scene',
        entities: { child: { components: { T709Tag: { value: 1 } } } },
      })
      .unwrap();
    const handle = world.allocSharedRef('SceneAsset', {
      kind: 'scene',
      entities: {
        nested: {
          components: {},
          instance: {
            source: CHILD_GUID,
            overrides: [
              { target: ['child'], components: { T709MaterialCarrier: { materials: [stale] } } },
            ],
          },
        },
      },
    } as SceneAsset);
    const baseline = world.inspect().entityCount;
    expect(
      mode === 'anchor' ? reg.instantiate(handle, world) : reg.instantiateFlat(handle, world),
    ).toMatchObject({ ok: false, error: { code: 'shared-ref-stale' } });
    expect(world.inspect().entityCount).toBe(baseline);
    expect(world.sharedRefs._liveCount()).toBe(1);
    world.sharedRefs.release(handle).unwrap();
  });
  it.each([
    'anchor',
    'flat',
  ] as const)('applies authored %s array overrides that add a component without leaking grants', (mode) => {
    const reg = makeRegistry();
    const world = makeWorld();
    world.components.register(ChildOf).unwrap();
    world.components.register(Children).unwrap();
    reg.catalog(MATERIAL_GUID, material()).unwrap();
    reg
      .catalog(CHILD_GUID, {
        kind: 'scene',
        entities: { child: { components: { T709Tag: { value: 7 } } } },
      })
      .unwrap();
    const handle = world.allocSharedRef('SceneAsset', {
      kind: 'scene',
      entities: {
        nested: {
          components: {},
          instance: {
            source: CHILD_GUID,
            overrides: [
              {
                target: ['child'],
                components: { T709MaterialCarrier: { materials: [MATERIAL_GUID] } },
              },
            ],
          },
        },
      },
    } as SceneAsset);
    for (let cycle = 0; cycle < 3; cycle++) {
      const roots =
        mode === 'anchor'
          ? [reg.instantiate(handle, world).unwrap()]
          : reg.instantiateFlat(handle, world).unwrap();
      const members = roots.flatMap((root) => [root, ...world.iterDescendants(root)]);
      const member = defined(
        members.find((entity) => world.hasComponent(entity, T709MaterialCarrier)),
      );
      expect(world.get(member, T709Tag).unwrap().value).toBe(7);
      const refs = world.get(member, T709MaterialCarrier).unwrap().materials;
      expect(refs.length).toBe(1);
      expect(world.sharedRefs.resolve(refs[0] as never).ok).toBe(true);
      for (const root of roots) worldDespawnScene(world, root).unwrap();
      expect(world.sharedRefs._liveCount()).toBe(1);
      expect(world.inspect().entityCount).toBe(0);
    }
    world.sharedRefs.release(handle).unwrap();
    expect(world.sharedRefs._liveCount()).toBe(0);
  });
  it.each([
    'anchor',
    'flat',
  ] as const)('releases each %s acquisition when GUID aliases share one payload handle', (mode) => {
    const reg = makeRegistry();
    const world = makeWorld();
    const payload = material();
    reg.catalog(MATERIAL_GUID, payload).unwrap();
    reg.catalog(CHILD_GUID, payload).unwrap();
    const scene: SceneAsset = {
      kind: 'scene',
      entities: {
        box: { components: { T709MaterialCarrier: { materials: [MATERIAL_GUID, CHILD_GUID] } } },
      },
    };
    const handle = world.allocSharedRef('SceneAsset', scene);
    for (let cycle = 0; cycle < 3; cycle++) {
      const roots =
        mode === 'anchor'
          ? [reg.instantiate(handle, world).unwrap()]
          : reg.instantiateFlat(handle, world).unwrap();
      const sibling =
        mode === 'anchor'
          ? [reg.instantiate(handle, world).unwrap()]
          : reg.instantiateFlat(handle, world).unwrap();
      const first = reg._resolveSceneGuids(scene, world).unwrap();
      const fields = first.entities.box?.components.T709MaterialCarrier as { materials: number[] };
      expect(fields.materials[0]).toBe(fields.materials[1]);
      // Direct resolver calls also own one temporary grant for each GUID acquisition.
      for (const ref of fields.materials) world.sharedRefs.release(ref as never).unwrap();
      for (const root of roots) worldDespawnScene(world, root).unwrap();
      expect(world.sharedRefs.resolve(fields.materials[0] as never).ok).toBe(true);
      for (const root of sibling) worldDespawnScene(world, root).unwrap();
      expect(world.sharedRefs._liveCount()).toBe(1);
    }
    world.sharedRefs.release(handle).unwrap();
    expect(world.sharedRefs._liveCount()).toBe(0);
  });
  it.each([
    'anchor',
    'flat',
  ] as const)('keeps nested %s source references available for override removal and releases them on failure/close', (mode) => {
    let failing = false;
    const reg = makeRegistry(() =>
      failing
        ? {
            ok: false,
            error: new SkinJointPathUnresolvedError(0, ['injected preparation failure'], 0),
          }
        : { ok: true },
    );
    const world = makeWorld();
    world.components.register(ChildOf).unwrap();
    world.components.register(Children).unwrap();
    reg.catalog(MATERIAL_GUID, material()).unwrap();
    reg
      .catalog(CHILD_GUID, {
        kind: 'scene',
        entities: {
          child: { components: { T709MaterialCarrier: { materials: [MATERIAL_GUID] } } },
        },
      })
      .unwrap();
    const handle = world.allocSharedRef('SceneAsset', {
      kind: 'scene',
      entities: { nested: { components: {}, instance: { source: CHILD_GUID } } },
    } as SceneAsset);
    const roots =
      mode === 'anchor'
        ? [reg.instantiate(handle, world).unwrap()]
        : reg.instantiateFlat(handle, world).unwrap();
    const root = defined(roots[0]);
    const nested =
      mode === 'anchor'
        ? defined(worldGetSceneInstanceState(world, root).unwrap().mountRoots[0])
        : defined(
            [root, ...world.iterDescendants(root)].find((entity) =>
              world.hasComponent(entity, SceneInstance),
            ),
          );
    const state = worldGetSceneInstanceState(world, nested).unwrap();
    const member = defined(
      [...state.entityToLocalId.keys()].find((entity) =>
        world.hasComponent(entity, T709MaterialCarrier),
      ),
    );
    const original = world.get(member, T709MaterialCarrier).unwrap().materials[0];
    worldSetSceneOverride(world, nested, member, T709MaterialCarrier, 'materials', []).unwrap();
    expect(world.sharedRefs.resolve(original as never).ok).toBe(true);
    worldRemoveSceneOverride(world, nested, member, T709MaterialCarrier, 'materials').unwrap();
    expect(world.get(member, T709MaterialCarrier).unwrap().materials[0]).toBe(original);
    for (const root of roots) worldDespawnScene(world, root).unwrap();
    expect(world.sharedRefs._liveCount()).toBe(1);
    failing = true;
    expect(
      mode === 'anchor' ? reg.instantiate(handle, world).ok : reg.instantiateFlat(handle, world).ok,
    ).toBe(false);
    expect(world.sharedRefs._liveCount()).toBe(1);
    world.sharedRefs.release(handle).unwrap();
    expect(world.sharedRefs._liveCount()).toBe(0);
  });
  it('materialises keyed entities and returns a synthetic root', () => {
    const reg = makeRegistry();
    const world = makeWorld();
    const handle = world.allocSharedRef('SceneAsset', twoEntityScene());
    const result = reg.instantiate(handle, world);
    expect(result.ok).toBe(true);
    if (result.ok) expect(typeof result.value).toBe('number');
  });

  it('materialises keyed entities flat for authoring', () => {
    const reg = makeRegistry();
    const world = makeWorld();
    const handle = world.allocSharedRef('SceneAsset', twoEntityScene());
    const result = reg.instantiateFlat(handle, world);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.length).toBe(2);
  });

  it('releases temporary scene grants across repeated flat playback', () => {
    const reg = makeRegistry();
    const world = makeWorld();
    const handle = world.allocSharedRef('SceneAsset', twoEntityScene());
    const baseline = world.sharedRefs._liveCount();
    for (let cycle = 0; cycle < 20; cycle++) {
      const entities = reg.instantiateFlat(handle, world).unwrap();
      for (const entity of entities) world.despawn(entity).unwrap();
      expect(world.sharedRefs._liveCount()).toBe(baseline);
    }
    expect(world.sharedRefs.resolve(handle).ok).toBe(true);
  });
});

describe('keyed SceneAsset GUID production', () => {
  it('resolves shared fields without changing entity keys', () => {
    const reg = makeRegistry();
    const world = makeWorld();
    expect(reg.catalog(MATERIAL_GUID, material()).ok).toBe(true);
    const scene: SceneAsset = {
      kind: 'scene',
      entities: {
        player: {
          components: { T709MaterialCarrier: { materials: [MATERIAL_GUID] } },
        },
      },
    };

    const result = reg._resolveSceneGuids(scene, world);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.value.entities)).toEqual(['player']);
    const values = result.value.entities.player?.components.T709MaterialCarrier as {
      materials: number[];
    };
    expect(values.materials).toHaveLength(1);
    expect(values.materials[0]).toBeGreaterThanOrEqual(1024);
    expect(resolveAssetHandle<Asset>(world, values.materials[0] as never).unwrap()).toBe(
      reg.assetCatalog.get(MATERIAL_GUID)?.payload,
    );
  });

  it('resolves nested keyed instances and rejects recursive identity', () => {
    const reg = makeRegistry();
    const world = makeWorld();
    const child: SceneAsset = { kind: 'scene', entities: { root: { components: {} } } };
    const parent: SceneAsset = {
      kind: 'scene',
      entities: {
        room: {
          components: {},
          instance: { source: CHILD_GUID, overrides: [{ target: ['root'], components: {} }] },
        },
      },
    };
    expect(reg.catalog(CHILD_GUID, child).ok).toBe(true);
    const resolved = reg._resolveSceneGuids(parent, world, PARENT_GUID);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.entities.room?.instance?.source).toBe(CHILD_GUID);
    expect(world.sharedRefs._liveCount()).toBe(1);

    expect(reg.catalog(PARENT_GUID, parent).ok).toBe(true);
    const cycle = reg._resolveSceneGuids(
      { kind: 'scene', entities: { loop: { components: {}, instance: { source: PARENT_GUID } } } },
      world,
      PARENT_GUID,
    );
    expect(cycle).toMatchObject({ ok: false, error: { code: 'asset-parse-failed' } });
  });

  it('reports the keyed entity when a shared GUID cannot be resolved', () => {
    const reg = makeRegistry();
    const world = makeWorld();
    const scene: SceneAsset = {
      kind: 'scene',
      entities: {
        missingMesh: { components: { T709MaterialCarrier: { materials: [MATERIAL_GUID] } } },
      },
    };
    const result = reg._resolveSceneGuids(scene, world);
    expect(result).toMatchObject({ ok: false, error: { code: 'asset-not-found' } });
    if (!result.ok) expect(result.error.hint).toContain('missingMesh');
  });
});
