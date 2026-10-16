import * as SceneOwner from '@forgeax/engine-scene';

// feat-20260707-engine-world-clone-transient-for-editor-ssot M1 / m1t2:
// Collect transient skip test (AC-02 + AC-03).
//
// AC-02: After transient mechanism is in place, rootsToSceneAsset:
//   (a) no entity carries SceneInstance in output — caught by transient check.
//   (b) root entities carry no ChildOf — isRoot && ChildOf instance-level skip retained.
//   (c) non-root entities retain ChildOf component.
//
// AC-03 control: non-transient components (Transform) produce output matching
// pre-fix baseline — boolean judgment does not falsely swallow non-transient components.

import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { defineComponent, World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { LocalEntityId, SceneAsset, SceneEntity } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { rootsToSceneAsset } from '../collect-scene-asset';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';
import { registerSceneComponents } from './helpers/register-scene-components';

function makeRegistry(): AssetRegistry {
  return new AssetRegistry(makeMockShaderRegistry());
}

function _localId(n: number): LocalEntityId {
  return n as LocalEntityId;
}

// biome-ignore lint/suspicious/noExplicitAny: branded Handle types differ between allocSharedRef and instantiateScene
function registerSceneAsset(world: World, asset: SceneAsset): any {
  return world.allocSharedRef('SceneAsset', asset);
}

function hasComp(entity: SceneEntity, name: string): boolean {
  return (entity.components as Record<string, Record<string, unknown>>)[name] !== undefined;
}

describe('m1t2 — collect transient skip (AC-02 + AC-03)', () => {
  it('(a) SceneInstance absent from collect output', () => {
    const asset: SceneAsset = {
      kind: 'scene',
      entities: { 'entity-0': { components: {} } },
    };

    const world = new World();
    registerSceneComponents(world);
    const reg = makeRegistry();
    const sg = AssetGuid.parse('00000000-0000-0000-0000-000000000000');
    if (sg.ok) reg.catalog(sg.value, asset);
    const handle = registerSceneAsset(world, asset);
    const res = SceneOwner.worldInstantiateScene(world, handle);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const collected = rootsToSceneAsset(reg, world, [res.value.root]);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;

    for (const ent of Object.values(collected.value.entities)) {
      expect(hasComp(ent, 'SceneInstance')).toBe(false);
    }
  });

  it('(b) root entities have no ChildOf in collect output', () => {
    // A scene with entities — collect always exposes root with no ChildOf
    // (instance-level isRoot && ChildOf skip is independent of transient).
    const asset: SceneAsset = {
      kind: 'scene',
      entities: { 'entity-0': { components: {} }, 'entity-1': { components: {} } },
    };

    const world = new World();
    registerSceneComponents(world);
    const reg = makeRegistry();
    const sg = AssetGuid.parse('00000000-0000-0000-0000-000000000000');
    if (sg.ok) reg.catalog(sg.value, asset);
    const handle = registerSceneAsset(world, asset);
    const res = SceneOwner.worldInstantiateScene(world, handle);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const collected = rootsToSceneAsset(reg, world, [res.value.root]);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;

    // Both entities are authored roots. Their runtime ChildOf edges point to
    // the transient synthetic root and are therefore omitted on collect.
    let childrenWithChildOf = 0;

    for (const ent of Object.values(collected.value.entities)) {
      if (hasComp(ent, 'ChildOf')) {
        childrenWithChildOf++;
      }
    }

    expect(childrenWithChildOf).toBe(0);
  });

  it('(c) non-root entities retain ChildOf', () => {
    // Non-root entities (instantiated from SceneAsset localIds) must carry ChildOf.
    const asset: SceneAsset = {
      kind: 'scene',
      entities: {
        'entity-0': { components: {} },
        'entity-1': { components: { ChildOf: { parent: 'entity-0' } } },
      },
    };

    const world = new World();
    registerSceneComponents(world);
    const reg = makeRegistry();
    const sg = AssetGuid.parse('00000000-0000-0000-0000-000000000000');
    if (sg.ok) reg.catalog(sg.value, asset);
    const handle = registerSceneAsset(world, asset);
    const res = SceneOwner.worldInstantiateScene(world, handle);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const collected = rootsToSceneAsset(reg, world, [res.value.root]);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;

    // The explicit authored edge survives; the implicit synthetic-root edges
    // are omitted by the collector.
    const childOfEntities = Object.values(collected.value.entities).filter((e) =>
      hasComp(e, 'ChildOf'),
    );
    expect(childOfEntities.length).toBe(1);

    // Each child ChildOf.parent should point to root handle.
    for (const c of childOfEntities) {
      const childOf = (c.components as Record<string, Record<string, unknown>>).ChildOf;
      expect(childOf).toBeDefined();
      expect(childOf?.parent).toBeDefined();
    }
  });

  it('(d) control: non-transient component appears unchanged in output', () => {
    const Control = defineComponent('M1T2_Ctrl', { val: 'f32', label: 'string' });

    const asset: SceneAsset = {
      kind: 'scene',
      entities: { 'entity-0': { components: { M1T2_Ctrl: { val: 42, label: 'hello' } } } },
    };

    const world = new World();
    registerSceneComponents(world, [Control]);
    const reg = makeRegistry();
    const sg = AssetGuid.parse('00000000-0000-0000-0000-000000000000');
    if (sg.ok) reg.catalog(sg.value, asset);
    const handle = registerSceneAsset(world, asset);
    const res = SceneOwner.worldInstantiateScene(world, handle);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const collected = rootsToSceneAsset(reg, world, [res.value.root]);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;

    const found = Object.values(collected.value.entities).find((e) => hasComp(e, 'M1T2_Ctrl'));
    expect(found).toBeDefined();
    const c = (found?.components as Record<string, Record<string, unknown>>).M1T2_Ctrl;
    expect(c).toBeDefined();
    expect(c?.val).toBe(42);
    expect(c?.label).toBe('hello');
  });
});
