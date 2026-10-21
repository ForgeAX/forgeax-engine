import { AnimationPlayer } from '@forgeax/engine-animation';
import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { type Component, defineComponent, type EntityHandle, World } from '@forgeax/engine-ecs';
import { SceneInstance } from '@forgeax/engine-render';
import * as SceneOwner from '@forgeax/engine-scene';
import type { SceneAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { rootsToSceneAsset, serializeSceneAssetToPack } from '../collect-scene-asset';
import { publishTestAssets } from './helpers/publish-runtime-assets';
import { registerSceneComponents } from './helpers/register-scene-components';
import { testAssets } from './helpers/runtime-assets';

function componentMap(...components: readonly Component[]): ReadonlyMap<string, Component> {
  return new Map(components.map((component) => [component.name, component]));
}
function findMountedMember(w: World, rootA: EntityHandle): EntityHandle {
  for (const c of w.iterDescendants(rootA)) {
    if (c === rootA) continue;
    if (!w.get(c, SceneInstance).ok) continue;
    const st = SceneOwner.worldGetSceneInstanceState(w, c);
    if (!st.ok) continue;
    for (const [member] of st.value.entityToLocalId) return member;
  }
  throw new Error('no mounted member found');
}
function firstInstanceOverride(
  scene: SceneAsset,
  comp: string,
): { readonly value: unknown } | undefined {
  for (const entity of Object.values(scene.entities)) {
    for (const instanceOverride of entity.instance?.overrides ?? []) {
      const value = instanceOverride.components[comp];
      if (value !== undefined) return { value };
    }
  }
  return undefined;
}

describe('m3-t1: serialize refs index with schema derivation', () => {
  it('(a) asset<> scalar field GUID goes to refs[] and entity value is replaced with refs index', () => {
    const component = defineComponent('Test_SPackSharedScalar', {
      assetRef: { type: 'asset<animation-clip>' },
      // biome-ignore lint/suspicious/noExplicitAny: defineComponent constraint too strict for complex schema types
    } as any);

    const guid1 = 'a0000000-a000-0000-0000-000000000001';

    const sceneAsset: SceneAsset = {
      kind: 'scene',
      entities: { 'entity-0': { components: { Test_SPackSharedScalar: { assetRef: guid1 } } } },
    };

    const packResult = serializeSceneAssetToPack(
      sceneAsset,
      componentMap(component as Component),
      'scene-0000-0000-0000-000000000001',
    );
    expect(packResult.ok).toBe(true);
    if (!packResult.ok) return;

    const packObj = packResult.value;
    expect(packObj.schemaVersion).toBe('2.0.0');
    expect(packObj.assets).toEqual([expect.objectContaining({ artifacts: {} })]);
    expect(packObj.kind).toBe('internal-text-package');
    const assets = packObj.assets as Array<Record<string, unknown>>;
    expect(Array.isArray(assets)).toBe(true);
    expect(assets).toHaveLength(1);

    const asset = assets[0];
    if (!asset) throw new Error('asset missing');
    expect(asset.kind).toBe('scene');

    const refs = asset.refs as string[];
    expect(Array.isArray(refs)).toBe(true);
    expect(refs).toContain(guid1);

    const payload = asset.payload as Record<string, unknown>;
    const entities = Object.values(payload.entities as Record<string, Record<string, unknown>>);
    expect(entities).toHaveLength(1);

    const ent0 = entities[0];
    if (!ent0) throw new Error('entity 0 missing');
    const comps = ent0.components as Record<string, Record<string, unknown>>;
    const tf = comps.Test_SPackSharedScalar;
    if (!tf) throw new Error('Test_SPackSharedScalar missing');
    expect(tf.assetRef).toBeTypeOf('number');
  });

  it('(b) array<asset<>> field elements go to refs[] and are replaced with refs indices', () => {
    const component = defineComponent('Test_SPackSharedArray', {
      sources: { type: 'array<asset<animation-clip>>' },
      // biome-ignore lint/suspicious/noExplicitAny: defineComponent constraint too strict
    } as any);

    const guidA = 'b0000000-b000-0000-0000-000000000001';
    const guidB = 'b0000000-b000-0000-0000-000000000002';

    const sceneAsset: SceneAsset = {
      kind: 'scene',
      entities: {
        'entity-0': { components: { Test_SPackSharedArray: { sources: [guidA, guidB] } } },
      },
    };

    const packResult = serializeSceneAssetToPack(
      sceneAsset,
      componentMap(component as Component),
      'scene-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    );
    expect(packResult.ok).toBe(true);
    if (!packResult.ok) return;

    const packObj = packResult.value;
    const assets = packObj.assets as Array<Record<string, unknown>>;
    const asset = assets[0];
    if (!asset) throw new Error('asset missing');
    const refs = asset.refs as string[];
    expect(refs).toContain(guidA);
    expect(refs).toContain(guidB);

    const payload = asset.payload as Record<string, unknown>;
    const entities = Object.values(payload.entities as Record<string, Record<string, unknown>>);
    const ent0 = entities[0];
    if (!ent0) throw new Error('entity 0 missing');
    const comps = ent0.components as Record<string, Record<string, unknown>>;
    const tf = comps.Test_SPackSharedArray;
    if (!tf) throw new Error('Test_SPackSharedArray missing');
    const sources = tf.sources as unknown[];
    expect(Array.isArray(sources)).toBe(true);
    expect(sources).toHaveLength(2);
    expect(typeof sources[0]).toBe('number');
    expect(typeof sources[1]).toBe('number');
  });

  it('(c) tileset field (old-whitelist outsider) is handled via schema derivation', () => {
    const component = defineComponent('Test_STilesetPack', {
      tileset: { type: 'asset<tileset>' },
      // biome-ignore lint/suspicious/noExplicitAny: defineComponent constraint too strict
    } as any);

    const tilesetGuid = 'c0000000-c000-0000-0000-000000000001';

    const sceneAsset: SceneAsset = {
      kind: 'scene',
      entities: { 'entity-0': { components: { Test_STilesetPack: { tileset: tilesetGuid } } } },
    };

    const packResult = serializeSceneAssetToPack(
      sceneAsset,
      componentMap(component as Component),
      'scene-cccc-cccc-cccc-cccccccccccc',
    );
    expect(packResult.ok).toBe(true);
    if (!packResult.ok) return;

    const packObj = packResult.value;
    const assets = packObj.assets as Array<Record<string, unknown>>;
    const asset = assets[0];
    if (!asset) throw new Error('asset missing');
    const refs = asset.refs as string[];
    expect(refs).toContain(tilesetGuid);
  });

  it('(d) collects every asset source string before assigning refs indices', () => {
    const component = defineComponent('Test_SFailFastPack', {
      loneRef: { type: 'asset<animation-clip>' },
      // biome-ignore lint/suspicious/noExplicitAny: defineComponent constraint too strict for complex schema types
    } as any);

    const sceneAsset: SceneAsset = {
      kind: 'scene',
      entities: {
        'entity-0': {
          components: { Test_SFailFastPack: { loneRef: 'non-collected-guid-wont-be-in-refs' } },
        },
      },
    };

    const packResult = serializeSceneAssetToPack(
      sceneAsset,
      componentMap(component as Component),
      'scene-dddd-dddd-dddd-dddddddddddd',
    );
    expect(packResult.ok).toBe(true);
    if (!packResult.ok) return;

    const packObj = packResult.value;
    const assets = packObj.assets as Array<Record<string, unknown>>;
    const asset = assets[0];
    if (!asset) throw new Error('asset missing');
    const refs = asset.refs as string[];
    expect(refs).toContain('non-collected-guid-wont-be-in-refs');
  });
});

describe('m3-t2: unregistered component silently skipped', () => {
  it('(a) unregistered component in SceneAsset does not cause error', () => {
    const component = defineComponent('Test_SRegComp', {
      val: 'f32',
    });

    const sceneAsset: SceneAsset = {
      kind: 'scene',
      entities: {
        'entity-0': {
          components: {
            Test_SRegComp: { val: 42 },
            Unreg_TestSkip: { mysteryField: 'should-survive' },
          },
        },
      },
    };

    const packResult = serializeSceneAssetToPack(
      sceneAsset,
      componentMap(component as Component),
      'scene-eeee-eeee-eeee-eeeeeeeeeeee',
    );
    expect(packResult.ok).toBe(true);
    if (!packResult.ok) return;

    const packObj = packResult.value;
    const assets = packObj.assets as Array<Record<string, unknown>>;
    const asset = assets[0];
    if (!asset) throw new Error('asset missing');
    const payload = asset.payload as Record<string, unknown>;
    const entities = Object.values(payload.entities as Record<string, Record<string, unknown>>);
    expect(entities).toHaveLength(1);

    const ent0 = entities[0];
    if (!ent0) throw new Error('entity 0 missing');
    const comps = ent0.components as Record<string, Record<string, unknown>>;

    expect(comps.Test_SRegComp).toBeDefined();

    expect(comps.Unreg_TestSkip).toBeDefined();
    if (comps.Unreg_TestSkip) {
      expect(comps.Unreg_TestSkip.mysteryField).toBe('should-survive');
    }
  });

  it('(b) unregistered component skip does not block other registered components on same entity', () => {
    const component = defineComponent('Test_SRegComp2', {
      count: 'i32',
    });

    const sceneAsset: SceneAsset = {
      kind: 'scene',
      entities: {
        'entity-0': {
          components: {
            Test_SRegComp2: { count: 99 },
            Unreg_TestSkip2: { ghostField: 12345 },
          },
        },
      },
    };

    const packResult = serializeSceneAssetToPack(
      sceneAsset,
      componentMap(component as Component),
      'scene-ffff-ffff-ffff-ffffffffffff',
    );
    expect(packResult.ok).toBe(true);
    if (!packResult.ok) return;

    const packObj = packResult.value;
    const assets = packObj.assets as Array<Record<string, unknown>>;
    const asset = assets[0];
    if (!asset) throw new Error('asset missing');
    const payload = asset.payload as Record<string, unknown>;
    const entities = Object.values(payload.entities as Record<string, Record<string, unknown>>);
    expect(entities).toHaveLength(1);

    const ent0 = entities[0];
    if (!ent0) throw new Error('entity 0 missing');
    const comps = ent0.components as Record<string, Record<string, unknown>>;

    expect(comps.Test_SRegComp2).toBeDefined();
    if (comps.Test_SRegComp2) {
      expect(comps.Test_SRegComp2.count).toBe(99);
    }

    expect(comps.Unreg_TestSkip2).toBeDefined();
  });
});

const W18_CLIP0 = 'a1a1a1a1-1111-4111-8111-111111111111';
const W18_CLIP1 = 'b2b2b2b2-2222-4222-8222-222222222222';
const W18_CHILD = 'c3c3c3c3-3333-4333-8333-333333333333';
const W18_SCALAR = 'e5e5e5e5-5555-4555-8555-555555555555';

const W18_ScalarShared = defineComponent('W18_ScalarShared', {
  asset: { type: 'asset<animation-clip>' },
  tag: 'f32',
  // biome-ignore lint/suspicious/noExplicitAny: defineComponent constraint too strict for asset<>
} as any) as Component;

async function mintCatalogued(reg: AssetRegistry, guid: string, duration: number) {
  publishTestAssets(reg, [
    {
      guid,
      kind: 'animation-clip',
      payload: {
        kind: 'animation-clip',
        duration,
        channels: [],
      },
    },
  ]);
  return (await reg.load(guid, 'animation-clip')).unwrap();
}

async function mountOne(reg: AssetRegistry, w: World): Promise<EntityHandle> {
  registerSceneComponents(w, [AnimationPlayer, W18_ScalarShared]);
  const child: SceneAsset = {
    kind: 'scene',
    entities: { 'entity-0': { components: { Transform: { pos: [1, 0, 0] } } } },
  };
  publishTestAssets(reg, [{ guid: W18_CHILD, kind: 'scene', payload: child }]);
  const source = (await reg.load(W18_CHILD, 'scene')).unwrap();
  const parent = reg
    .create({
      kind: 'scene',
      entities: {
        'entity-0': { components: { Transform: { pos: [0, 0, 0] } } },
        child: { components: {}, instance: { source } },
      },
    })
    .unwrap();
  return reg.instantiate(parent, w).unwrap();
}

describe('w18 — override-value asset handle→GUID two-state NULL-sentinel (AC-05)', () => {
  it('(a) array<asset<>> mixed valid handle + NULL sentinel -> GUID string + placeholder 0', async () => {
    const w = new World();
    const reg = testAssets(w);
    const root = await mountOne(reg, w);
    const member = findMountedMember(w, root);

    const clipH = await mintCatalogued(reg, W18_CLIP0, 0);
    const add = w.addComponent(member, {
      component: AnimationPlayer,
      data: { clips: [clipH, 0, 0, 0] } as never,
    });
    expect(add.ok).toBe(true);

    const collect = rootsToSceneAsset(reg, w, [root]);
    expect(collect.ok).toBe(true);
    if (!collect.ok) return;
    const ov = firstInstanceOverride(collect.value, 'AnimationPlayer');
    expect(ov).toBeDefined();
    if (!ov) return;
    const clips = (ov.value as Record<string, unknown>).clips as unknown[];
    expect(Array.isArray(clips)).toBe(true);
    expect(typeof clips[0]).toBe('string');
    expect(clips[0]).toBe(W18_CLIP0);
    expect(clips[1]).toBe(0);
    expect(clips[2]).toBe(0);
    expect(clips[3]).toBe(0);
  });

  it('(b) array<asset<>> two valid handles at slots 0 and 1 -> two distinct GUIDs', async () => {
    const w = new World();
    const reg = testAssets(w);
    const root = await mountOne(reg, w);
    const member = findMountedMember(w, root);

    const h0 = await mintCatalogued(reg, W18_CLIP0, 10);
    const h1 = await mintCatalogued(reg, W18_CLIP1, 11);
    const add = w.addComponent(member, {
      component: AnimationPlayer,
      data: { clips: [h0, h1] } as never,
    });
    expect(add.ok).toBe(true);

    const collect = rootsToSceneAsset(reg, w, [root]);
    expect(collect.ok).toBe(true);
    if (!collect.ok) return;
    const ov = firstInstanceOverride(collect.value, 'AnimationPlayer');
    expect(ov).toBeDefined();
    if (!ov) return;
    const clips = (ov.value as Record<string, unknown>).clips as unknown[];
    expect(clips.length).toBe(2);
    expect(clips[0]).toBe(W18_CLIP0);
    expect(clips[1]).toBe(W18_CLIP1);
  });

  it('(c) scalar asset<> valid handle -> GUID string (non-null branch)', async () => {
    expect(W18_ScalarShared.name).toBe('W18_ScalarShared');
    const w = new World();
    const reg = testAssets(w);
    const root = await mountOne(reg, w);
    const member = findMountedMember(w, root);

    const h = await mintCatalogued(reg, W18_SCALAR, 0);
    const add = w.addComponent(member, {
      component: W18_ScalarShared,
      data: { asset: h, tag: 7 } as never,
    });
    expect(add.ok).toBe(true);

    const collect = rootsToSceneAsset(reg, w, [root]);
    expect(collect.ok).toBe(true);
    if (!collect.ok) return;
    const ov = firstInstanceOverride(collect.value, 'W18_ScalarShared');
    expect(ov).toBeDefined();
    if (!ov) return;
    const val = ov.value as Record<string, unknown>;
    expect(val.asset).toBe(W18_SCALAR); // valid handle -> GUID string
    expect(val.tag).toBe(7);
  });

  it('(d) scalar asset<> handle 0 -> field omitted (NULL-sentinel branch)', async () => {
    const w = new World();
    const reg = testAssets(w);
    const root = await mountOne(reg, w);
    const member = findMountedMember(w, root);

    const add = w.addComponent(member, {
      component: W18_ScalarShared,
      data: { asset: 0, tag: 3 } as never,
    });
    expect(add.ok).toBe(true);

    const collect = rootsToSceneAsset(reg, w, [root]);
    expect(collect.ok).toBe(true);
    if (!collect.ok) return;
    const ov = firstInstanceOverride(collect.value, 'W18_ScalarShared');
    expect(ov).toBeDefined();
    if (!ov) return;
    const val = ov.value as Record<string, unknown>;
    expect('asset' in val).toBe(false);
    expect(val.tag).toBe(3);
  });
});
