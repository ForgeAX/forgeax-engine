import { defineComponent, World } from '@forgeax/engine-ecs';
import { err, type Handle, ok, type SceneAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { ChildOf, Children, compileKeyedSceneAsset, type KeyedSceneCompileContext } from '../index';

const Marker = defineComponent('KeyedSceneMarker', { value: 'i32' });
const DirectionalLight = defineComponent('DirectionalLight', { shadowFilter: 'f32' });

function register(world: World): void {
  for (const component of [ChildOf, Children, Marker, DirectionalLight])
    world.components.register(component).unwrap();
}

function compile(
  world: World,
  handle: Handle<'SceneAsset', 'shared'>,
  asset: SceneAsset,
  assets: ReadonlyMap<number, SceneAsset>,
  handles: ReadonlyMap<string, Handle<'SceneAsset', 'shared'>>,
): ReturnType<typeof compileKeyedSceneAsset> {
  const context: KeyedSceneCompileContext = {
    resolveSource: (source, _parent) => {
      const child = handles.get(source);
      return child === undefined ? err({ code: 'missing-source' }) : ok(child);
    },
    resolveAsset: (child) => {
      const value = assets.get(Number(child));
      return value === undefined ? err({ code: 'missing-asset' }) : ok(value);
    },
    stack: new Set([Number(handle)]),
  };
  return compileKeyedSceneAsset(world, handle, asset, context);
}

describe('keyed SceneAsset compiler', () => {
  it('sorts keys, resolves same-scene and nested addresses, and derives private slots', () => {
    const world = new World();
    register(world);
    const child: SceneAsset = {
      kind: 'scene',
      entities: {
        'door/slash': { components: { KeyedSceneMarker: { value: 2 } } },
        leaf: { components: { KeyedSceneMarker: { value: 3 } } },
      },
    };
    const parent: SceneAsset = {
      kind: 'scene',
      entities: {
        z: {
          components: {
            KeyedSceneMarker: { value: 1 },
            ChildOf: { parent: 'root' },
          },
        },
        instance: {
          components: { ChildOf: { parent: 'root' } },
          instance: {
            source: 'child-guid',
            overrides: [{ target: ['door/slash'], components: { KeyedSceneMarker: { value: 9 } } }],
          },
        },
        root: {
          components: {
            KeyedSceneMarker: { value: 0 },
          },
        },
      },
    };
    const childHandle = world.allocSharedRef('SceneAsset', child);
    const parentHandle = world.allocSharedRef('SceneAsset', parent);
    const result = compile(
      world,
      parentHandle,
      parent,
      new Map([
        [Number(childHandle), child],
        [Number(parentHandle), parent],
      ]),
      new Map([['child-guid', childHandle]]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.value.keyByLocalId.values()]).toEqual(['root', 'z', 'instance']);
    expect(result.value.resolveAddress('root')).toBe(0);
    expect(result.value.resolveAddress(['instance', 'door/slash'])).toBe(3);
    expect(result.value.asset.mounts?.[0]?.memberCount).toBe(2);
    expect(result.value.asset.mounts?.[0]?.overrides?.[0]?.localId).toBe(3);
  });

  it('keeps independent instance ranges, converted carrier components, and nested hierarchy overrides together', () => {
    const world = new World();
    register(world);
    const grandchild: SceneAsset = {
      kind: 'scene',
      entities: { leaf: { components: { KeyedSceneMarker: { value: 7 } } } },
    };
    const child: SceneAsset = {
      kind: 'scene',
      entities: {
        leaf: { components: { KeyedSceneMarker: { value: 2 }, ChildOf: { parent: 'inner' } } },
        inner: { components: {}, instance: { source: 'grandchild' } },
      },
    };
    const parent: SceneAsset = {
      kind: 'scene',
      entities: {
        root: { components: {} },
        z: { components: {}, instance: { source: 'child' } },
        a: {
          components: {
            ChildOf: { parent: 'root' },
            Children: { entities: ['z', ['z', 'inner', 'leaf']] },
          },
          instance: {
            source: 'child',
            overrides: [
              { target: ['leaf'], components: { KeyedSceneMarker: { value: 9 } } },
              { target: ['inner', 'leaf'], components: { ChildOf: { parent: 'root' } } },
            ],
          },
        },
      },
    };
    const grandHandle = world.allocSharedRef('SceneAsset', grandchild);
    const childHandle = world.allocSharedRef('SceneAsset', child);
    const parentHandle = world.allocSharedRef('SceneAsset', parent);
    const result = compile(
      world,
      parentHandle,
      parent,
      new Map([
        [Number(grandHandle), grandchild],
        [Number(childHandle), child],
        [Number(parentHandle), parent],
      ]),
      new Map([
        ['grandchild', grandHandle],
        ['child', childHandle],
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.asset.mounts).toMatchObject([
      {
        localId: 1,
        memberFirst: 3,
        memberCount: 3,
        parent: 0,
        components: { Children: { entities: [2, 8] } },
        overrides: [
          { localId: 3, comp: 'KeyedSceneMarker', field: 'value', value: 9 },
          { localId: 5, comp: 'ChildOf', value: { parent: 0 } },
        ],
      },
      { localId: 2, memberFirst: 6, memberCount: 3 },
    ]);
    expect(result.value.asset.mounts?.[0]?.components?.ChildOf).toBeUndefined();
    expect(result.value.rootLocalIds).toEqual([0, 2]);
    expect(
      [...result.value.hierarchyParentByLocalId].sort(([left], [right]) => left - right),
    ).toEqual([
      [1, 0],
      [3, 4],
      [4, 1],
      [5, 0],
      [6, 7],
      [7, 2],
      [8, 7],
    ]);
    expect(result.value.resolveAddress(['a', 'inner', 'leaf'])).toBe(5);
    expect(result.value.resolveAddress(['z', 'inner', 'missing'])).toBeUndefined();
  });

  it('rejects hierarchy cycles before producing a runtime projection', () => {
    const world = new World();
    register(world);
    const handle = world.allocSharedRef('SceneAsset', { kind: 'scene', entities: {} });
    const asset: SceneAsset = {
      kind: 'scene',
      entities: {
        a: { components: { ChildOf: { parent: 'b' } } },
        b: { components: { ChildOf: { parent: 'a' } } },
      },
    };
    const result = compile(world, handle, asset, new Map([[Number(handle), asset]]), new Map());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ detail: { reason: 'hierarchy cycle' } });
  });

  it('rejects hierarchy cycles that cross an instance carrier', () => {
    const world = new World();
    register(world);
    const child: SceneAsset = {
      kind: 'scene',
      entities: { leaf: { components: {} } },
    };
    const parent: SceneAsset = {
      kind: 'scene',
      entities: {
        root: { components: { ChildOf: { parent: 'instance' } } },
        instance: {
          components: { ChildOf: { parent: 'root' } },
          instance: { source: 'child-guid' },
        },
      },
    };
    const childHandle = world.allocSharedRef('SceneAsset', child);
    const parentHandle = world.allocSharedRef('SceneAsset', parent);
    const result = compile(
      world,
      parentHandle,
      parent,
      new Map([
        [Number(childHandle), child],
        [Number(parentHandle), parent],
      ]),
      new Map([['child-guid', childHandle]]),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { detail: { reason: 'hierarchy cycle' } },
    });
  });

  it('rejects a carrier parented to a root in its own child scene', () => {
    const world = new World();
    register(world);
    const child: SceneAsset = {
      kind: 'scene',
      entities: {
        root: { components: {} },
        door: { components: { ChildOf: { parent: 'root' } } },
      },
    };
    const parent: SceneAsset = {
      kind: 'scene',
      entities: {
        outer: {
          components: { ChildOf: { parent: ['outer', 'door'] } },
          instance: { source: 'child-guid' },
        },
      },
    };
    const childHandle = world.allocSharedRef('SceneAsset', child);
    const parentHandle = world.allocSharedRef('SceneAsset', parent);
    const result = compile(
      world,
      parentHandle,
      parent,
      new Map([
        [Number(childHandle), child],
        [Number(parentHandle), parent],
      ]),
      new Map([['child-guid', childHandle]]),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { detail: { reason: 'hierarchy cycle' } },
    });
  });

  it('keeps every segment of a deeply nested address', () => {
    const world = new World();
    register(world);
    const leaf: SceneAsset = { kind: 'scene', entities: { door: { components: {} } } };
    const inside: SceneAsset = {
      kind: 'scene',
      entities: { inside: { components: {}, instance: { source: 'leaf-guid' } } },
    };
    const outer: SceneAsset = {
      kind: 'scene',
      entities: { outer: { components: {}, instance: { source: 'inside-guid' } } },
    };
    const leafHandle = world.allocSharedRef('SceneAsset', leaf);
    const insideHandle = world.allocSharedRef('SceneAsset', inside);
    const outerHandle = world.allocSharedRef('SceneAsset', outer);
    const result = compile(
      world,
      outerHandle,
      outer,
      new Map([
        [Number(leafHandle), leaf],
        [Number(insideHandle), inside],
        [Number(outerHandle), outer],
      ]),
      new Map([
        ['leaf-guid', leafHandle],
        ['inside-guid', insideHandle],
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.resolveAddress(['outer', 'inside', 'door'])).toBe(2);
  });

  it('rejects unknown component fields before runtime projection', () => {
    const world = new World();
    register(world);
    const asset: SceneAsset = {
      kind: 'scene',
      entities: { root: { components: { KeyedSceneMarker: { typo: 1 } } } },
    };
    const handle = world.allocSharedRef('SceneAsset', asset);
    const result = compile(world, handle, asset, new Map([[Number(handle), asset]]), new Map());
    expect(result).toMatchObject({
      ok: false,
      error: {
        detail: {
          reason: 'unknown component field',
          component: 'KeyedSceneMarker',
          field: 'typo',
          entity: 'root',
        },
      },
    });
  });

  it('migrates numeric 0.1.27 entity addresses and pcfKernelSize at compile time', () => {
    const world = new World();
    register(world);
    const asset = {
      kind: 'scene',
      entities: {
        '0': { components: { KeyedSceneMarker: { value: 0 } } },
        '1': {
          components: {
            ChildOf: { parent: 0 },
            DirectionalLight: { pcfKernelSize: 3 },
          },
        },
      },
    } as unknown as SceneAsset;
    const handle = world.allocSharedRef('SceneAsset', asset);
    const result = compile(world, handle, asset, new Map([[Number(handle), asset]]), new Map());
    expect(result).toMatchObject({
      ok: true,
      value: {
        asset: {
          entities: [
            { components: { KeyedSceneMarker: { value: 0 } } },
            {
              components: {
                ChildOf: { parent: 0 },
                DirectionalLight: { shadowFilter: 2 },
              },
            },
          ],
        },
      },
    });
  });
});
