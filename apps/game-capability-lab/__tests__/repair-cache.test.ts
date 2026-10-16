import { readFileSync } from 'node:fs';
import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { SceneAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  expandLoadedScene,
  NESTED_SCENE_GUID,
  SCENE_GUID,
  type LoadedScene,
} from '../assets/plugins/scene-runtime.js';
import { resolveRepairCacheImpact } from '../assets/plugins/repair-cache.js';

describe('game-default nested repair cache', () => {
  it('opens only for a charged hit admitted on the authored target', () => {
    expect(resolveRepairCacheImpact({ authoredTarget: true, impactScale: 1, opened: false })).toBe('ordinary');
    expect(resolveRepairCacheImpact({ authoredTarget: false, impactScale: 2, opened: false })).toBe('other-target');
    expect(resolveRepairCacheImpact({ authoredTarget: true, impactScale: 2, opened: false })).toBe('open');
    expect(resolveRepairCacheImpact({ authoredTarget: true, impactScale: 2, opened: true })).toBe('already-open');
  });

  it('authors one hidden repair pickup under NestedTarget', () => {
    const pack = JSON.parse(readFileSync(new URL('../assets/scene.pack.json', import.meta.url), 'utf8')) as {
      assets: Record<string, {
        kind: string;
        refs: string[];
        payload: {
          entities?: Record<string, { components: Record<string, Record<string, unknown>>; instance?: { source: number } }>;
        };
      }>;
    };
    const primary = pack.assets['scene/main'];
    const nested = pack.assets['scene/nested-target'];
    expect(SCENE_GUID).toBe('4a673a93-24b5-56d8-9413-0f2e4e82c088');
    expect(NESTED_SCENE_GUID).toBe('69a0b0d8-74bc-53a0-958d-f8d02ae14b11');
    const repair = nested?.payload.entities?.nestedrepairpickup;

    const nestedRef = primary?.payload.entities?.['instance-23']?.instance?.source;
    expect(typeof nestedRef).toBe('number');
    expect(nestedRef === undefined ? undefined : primary?.refs[nestedRef]).toBe(NESTED_SCENE_GUID);
    expect(repair).toMatchObject({
      components: {
        Name: { value: 'NestedRepairPickup' },
        ChildOf: { parent: 'nestedtarget' },
        Transform: { pos: [0, 0.8, -1.2], scale: [0.38, 0.38, 0.38] },
      },
    });
  });

  it('expands a keyed nested instance through the AssetRegistry', async () => {
    const nested = {
      kind: 'scene',
      entities: {
        nestedtarget: { components: { Name: { value: 'NestedTarget' } } },
        nestedrepairpickup: { components: { Name: { value: 'NestedRepairPickup' } } },
      },
    } as SceneAsset;
    const assets = {
      loadByGuid: async () => ({ ok: true, value: nested }),
    } as unknown as AssetRegistry;
    const authored = {
      kind: 'scene',
      entities: { carrier: { components: {}, instance: { source: NESTED_SCENE_GUID } } },
    } as SceneAsset;
    const loaded = { mapping: new Map(), nodes: [] } as LoadedScene;

    const expanded = await expandLoadedScene(assets, authored, loaded);

    expect(expanded.nodes.map((node) => [node.localId, node.components.Name?.value])).toEqual([
      [0, undefined],
      [1, 'NestedRepairPickup'],
      [2, 'NestedTarget'],
    ]);
  });
});
