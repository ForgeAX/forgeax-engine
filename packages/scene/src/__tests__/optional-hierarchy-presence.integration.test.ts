import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { type Component, defineComponent, type EntityHandle, World } from '@forgeax/engine-ecs';
import type { SceneAsset } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { collectSubtree } from '../collect-subtree';
import {
  ChildOf,
  Children,
  sceneEntityAddressKey,
  worldDespawnScene,
  worldGetSceneInstanceState,
} from '../index';
import { instantiateSource } from './managed-scene-fixture';

const SceneInstance = defineComponent('SceneInstance', {
  source: { type: 'asset<scene>' },
  mapping: { type: 'array<entity>' },
  state: { type: 'unique<SceneInstanceState>' },
});
const Marker = defineComponent('OptionalPresenceMarker', { value: 'i32' });

function register(world: World): void {
  for (const component of [SceneInstance, ChildOf, Children, Marker]) {
    world.components.register(component).unwrap();
  }
}

function child(world: World, parent: EntityHandle): EntityHandle {
  return world.spawn({ component: ChildOf, data: { parent } }).unwrap();
}

function missingReads(reads: ReturnType<typeof spyReads>, componentName: string): number {
  return reads.mock.calls.filter(([, component], index) => {
    const result = reads.mock.results[index];
    return (
      component.name === componentName &&
      result?.type === 'return' &&
      !result.value.ok &&
      result.value.error.code === 'component-not-present'
    );
  }).length;
}

function spyReads(world: World) {
  return vi.spyOn(world, 'get');
}

const WORLD_INTERNAL_KEY: unique symbol = Symbol.for(
  'forgeax.ecs.worldInternal',
) as unknown as typeof WORLD_INTERNAL_KEY;

interface WorldWithMalformedMirror {
  readonly [WORLD_INTERNAL_KEY]: {
    getArrayView(
      entity: EntityHandle,
      component: Component,
      field: string,
    ): Uint32Array | undefined;
  };
}

describe('optional hierarchy component presence', () => {
  it('preserves breadth-first order and visited/dead-root behavior without absent Children reads', () => {
    const assets = new AssetRegistry();
    const world = new World({ assets });
    register(world);
    const root = world.spawn().unwrap();
    const a = child(world, root);
    const b = child(world, root);
    const leaf = child(world, a);
    const dead = world.spawn().unwrap();
    world.despawn(dead).unwrap();
    const reads = spyReads(world);
    try {
      expect([...collectSubtree(world, root)]).toEqual([root, a, b, leaf]);
      const visited = new Set<number>([b]);
      expect(collectSubtree(world, root, visited)).toBe(visited);
      expect([...visited]).toEqual([b, root, a, leaf]);
      const alreadyVisited = new Set<number>([root]);
      const before = reads.mock.calls.length;
      expect(collectSubtree(world, root, alreadyVisited)).toBe(alreadyVisited);
      expect(reads.mock.calls.length).toBe(before);
      expect([...collectSubtree(world, dead)]).toEqual([dead]);
      expect(missingReads(reads, 'Children')).toBe(0);
    } finally {
      reads.mockRestore();
      world.despawn(root).unwrap();
    }
  });

  it('terminates a malformed mirror cycle using the original visited and queue order', () => {
    const assets = new AssetRegistry();
    const world = new World({ assets });
    register(world);
    const root = world.spawn().unwrap();
    const a = child(world, root);
    const b = child(world, root);
    const grandchild = child(world, a);
    const tail = child(world, grandchild);
    // Normal writes reject cycles. Corrupt only the fixture's existing mirror slot.
    const internal = (world as unknown as WorldWithMalformedMirror)[WORLD_INTERNAL_KEY];
    const mirror = internal.getArrayView(grandchild, Children, 'entities');
    if (mirror === undefined || mirror.length !== 1) throw new Error('Missing fixture mirror slot');
    mirror[0] = root;
    try {
      expect([...collectSubtree(world, root)]).toEqual([root, a, b, grandchild]);
    } finally {
      // Traversal performs no structural writes, so this captured slot remains live.
      mirror[0] = tail;
      world.despawn(root).unwrap();
    }
  });

  it('attaches owned roots to the synthetic root while retaining authored and caller parents', () => {
    const assets = new AssetRegistry();
    const world = new World({ assets });
    register(world);
    const caller = world.spawn().unwrap();
    const source: SceneAsset = {
      kind: 'scene',
      entities: {
        a: { components: { OptionalPresenceMarker: { value: 1 } } },
        b: { components: { OptionalPresenceMarker: { value: 2 } } },
        leaf: {
          components: { OptionalPresenceMarker: { value: 3 }, ChildOf: { parent: 'a' } },
        },
      },
    };
    const reads = spyReads(world);
    let root: EntityHandle | undefined;
    try {
      root = instantiateSource(assets, world, source, caller).unwrap().root;
      const absentChildOfReads = missingReads(reads, 'ChildOf');
      const state = worldGetSceneInstanceState(world, root).unwrap();
      const a = state.bindings.get(sceneEntityAddressKey('a'));
      const b = state.bindings.get(sceneEntityAddressKey('b'));
      const leaf = state.bindings.get(sceneEntityAddressKey('leaf'));
      if (a === undefined || b === undefined || leaf === undefined)
        throw new Error('Missing binding');
      expect(world.get(a, ChildOf).unwrap().parent).toBe(root);
      expect(world.get(b, ChildOf).unwrap().parent).toBe(root);
      expect(world.get(leaf, ChildOf).unwrap().parent).toBe(a);
      expect(world.get(root, ChildOf).unwrap().parent).toBe(caller);
      expect(Array.from(world.get(root, Children).unwrap().entities)).toEqual([a, b]);
      expect(Array.from(world.get(a, Children).unwrap().entities)).toEqual([leaf]);
      expect([...collectSubtree(world, root)]).toEqual([root, a, b, leaf]);
      expect(runtimeAssets(assets).inspect().assets).toBe(1);
      expect(absentChildOfReads).toBe(0);
    } finally {
      reads.mockRestore();
      if (root !== undefined) worldDespawnScene(world, root).unwrap();
      world.despawn(caller).unwrap();
      expect(runtimeAssets(assets).inspect().assets).toBe(0);
    }
  });

  it('returns the real addComponent error when a caller parent is stale', () => {
    const assets = new AssetRegistry();
    const world = new World({ assets });
    register(world);
    const staleParent = world.spawn().unwrap();
    world.despawn(staleParent).unwrap();
    const additions = vi.spyOn(world, 'addComponent');
    let failedRoot: EntityHandle | undefined;
    try {
      const result = instantiateSource(
        assets,
        world,
        {
          kind: 'scene',
          entities: { a: { components: { OptionalPresenceMarker: { value: 1 } } } },
        },
        staleParent,
      );
      expect(result.ok).toBe(false);
      const index = additions.mock.calls.findIndex(
        ([, data]) =>
          data.component.name === 'ChildOf' &&
          'parent' in data.data &&
          data.data.parent === staleParent,
      );
      expect(index).toBeGreaterThanOrEqual(0);
      const actual = additions.mock.results[index];
      failedRoot = additions.mock.calls[index]?.[0];
      expect(actual?.type).toBe('return');
      if (actual?.type !== 'return' || actual.value.ok || result.ok) {
        throw new Error('Expected a real failed ECS addition');
      }
      expect(result.error).toBe(actual.value.error);
    } finally {
      additions.mockRestore();
      if (failedRoot !== undefined) worldDespawnScene(world, failedRoot).unwrap();
      expect(runtimeAssets(assets).inspect().assets).toBe(0);
    }
  });
});
