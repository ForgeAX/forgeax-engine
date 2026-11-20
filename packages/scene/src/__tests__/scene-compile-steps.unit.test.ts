import { World } from '@forgeax/engine-ecs';
import {
  type AssetHandle,
  err,
  type LocalEntityId,
  ok,
  type SceneAsset,
} from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { ChildOf, Children, Name, Transform } from '../index';
import type { CompiledSceneResult, KeyedSceneCompileContext } from '../instances/keyed';
import * as compiler from '../instances/keyed';
import { sceneTopoSort, sceneTopoSortSteps } from '../instances/scene-topology';

function fixture() {
  const world = new World();
  for (const component of [Transform, Name, ChildOf, Children])
    world.components.register(component).unwrap();
  const handle = 1 as AssetHandle<'scene'>;
  const child = 2 as AssetHandle<'scene'>;
  const childScene: SceneAsset = {
    kind: 'scene',
    entities: { wall: { components: { Transform: { pos: [1, 2, 3] }, Name: { value: 'wall' } } } },
  };
  const context: KeyedSceneCompileContext = {
    stack: new Set(),
    resolveSource: () => ok(child),
    resolveAsset: () => ok(childScene),
  };
  const source: SceneAsset = {
    kind: 'scene',
    entities: {
      anchor: { components: { Transform: {} } },
      room: {
        components: { Transform: {}, ChildOf: { parent: 'anchor' } },
        instance: {
          source: child,
          overrides: [{ target: ['wall'], components: { Transform: { pos: [9, 0, 0] } } }],
        },
      },
    },
  };
  return { world, handle, source, context };
}

function facts(compiled: CompiledSceneResult) {
  return {
    asset: compiled.asset,
    keys: [...compiled.keyByLocalId],
    mounts: [...compiled.mountKeyByLocalId],
    roots: compiled.rootLocalIds,
    parents: [...compiled.hierarchyParentByLocalId],
    address: compiled.resolveAddress(['room', 'wall']),
  };
}

describe('resumable keyed Scene compilation', () => {
  it('preserves nested address and override semantics while yielding inside nested work', () => {
    const { world, handle, source, context } = fixture();
    const expected = compiler.compileKeyedSceneAsset(world, handle, source, context).unwrap();
    const steps = compiler.compileKeyedSceneAssetSteps(world, handle, source, context);
    let yields = 0;
    let next = steps.next();
    while (!next.done) {
      expect(world.inspect().entityCount).toBe(0);
      yields++;
      next = steps.next();
    }
    expect(yields).toBeGreaterThan(6);
    expect(facts(next.value.unwrap())).toEqual(facts(expected));
    expect(world.inspect().entityCount).toBe(0);
  });

  it('does not collapse a large entity roster into a single continuation', () => {
    const { world, handle, context } = fixture();
    const source: SceneAsset = {
      kind: 'scene',
      entities: Object.fromEntries(
        Array.from({ length: 512 }, (_, index) => [
          `node-${index}`,
          { components: { Transform: { pos: [index, 0, 0] } } },
        ]),
      ),
    };
    const steps = compiler.compileKeyedSceneAssetSteps(world, handle, source, context);
    let next = steps.next();
    let yields = 0;
    while (!next.done) {
      yields++;
      next = steps.next();
    }
    expect(yields).toBeGreaterThanOrEqual(512);
    expect(next.value.unwrap().asset.entities).toHaveLength(512);
  });

  it('rejects late invalid input and hierarchy cycles without materializing partial entities', () => {
    const { world, handle, context } = fixture();
    for (const entities of [
      { a: { components: { Transform: {} } }, z: { components: { Transform: { pos: 'bad' } } } },
      {
        a: { components: { Transform: {}, ChildOf: { parent: 'b' } } },
        b: { components: { Transform: {}, ChildOf: { parent: 'a' } } },
      },
    ]) {
      const source = { kind: 'scene', entities } as unknown as SceneAsset;
      const expected = compiler.compileKeyedSceneAsset(world, handle, source, context);
      const steps = compiler.compileKeyedSceneAssetSteps(world, handle, source, context);
      let next = steps.next();
      while (!next.done) next = steps.next();
      expect(next.value).toEqual(expected);
      expect(next.value.ok).toBe(false);
      expect(world.inspect().entityCount).toBe(0);
    }
  });

  it('can abandon a continuation without spawning or retaining a World member', () => {
    const { world, handle, source, context } = fixture();
    const steps = compiler.compileKeyedSceneAssetSteps(world, handle, source, context);
    expect(steps.next().done).toBe(false);
    expect(steps.return(err('cancelled')).done).toBe(true);
    expect(steps.next().done).toBe(true);
    expect(world.inspect().entityCount).toBe(0);
  });

  it('validates a deep forest without repeatedly walking each settled ancestor chain', () => {
    const { world, handle, context } = fixture();
    const count = 4096;
    const source: SceneAsset = {
      kind: 'scene',
      entities: Object.fromEntries(
        Array.from({ length: count }, (_, index) => [
          `n${String(index).padStart(4, '0')}`,
          {
            components:
              index === 0
                ? { Transform: {} }
                : {
                    Transform: {},
                    ChildOf: { parent: `n${String(index - 1).padStart(4, '0')}` },
                  },
          },
        ]),
      ),
    };
    const steps = compiler.compileKeyedSceneAssetSteps(world, handle, source, context);
    let next = steps.next();
    let work = 0;
    while (!next.done) {
      work++;
      expect(work).toBeLessThan(count * 20);
      next = steps.next();
    }
    expect(next.value.unwrap().hierarchyParentByLocalId.size).toBe(count - 1);
  });

  it('keeps continuation topology scratch independent of closed and reused FrameArena scopes', () => {
    const world = new World();
    const nodes: compiler.CompiledSceneEntity[] = Array.from({ length: 512 }, (_, index) => ({
      localId: index as LocalEntityId,
      components:
        index === 511
          ? { Transform: {} }
          : {
              Transform: {},
              ChildOf: { parent: index + 1 },
            },
    }));
    const expected = sceneTopoSort(world, nodes);
    const steps = sceneTopoSortSteps(nodes);
    let next = steps.next();
    while (!next.done) {
      world
        .withFrameArena(() => {
          world.frameArena.alloc(Uint32Array, 1024).unwrap().fill(0xdeadbeef);
          return ok(undefined);
        })
        .unwrap();
      next = steps.next();
    }
    expect(next.value).toEqual(expected);
    expect(next.value[0]).toBe(511);
    expect(next.value.at(-1)).toBe(0);
  });
});
