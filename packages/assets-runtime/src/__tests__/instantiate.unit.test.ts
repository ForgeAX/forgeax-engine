// @forgeax/engine-assets-runtime -- keyed SceneAsset instantiate coverage.

import { type ComponentSchema, defineComponent, World } from '@forgeax/engine-ecs';
import { componentSchema } from '@forgeax/engine-ecs/internal';
import {
  ChildOf,
  Children,
  externalizeSceneAsset,
  sceneAssetContribution,
  worldDespawnScene,
  worldGetSceneInstanceState,
  worldRemoveSceneOverride,
  worldSetSceneOverride,
} from '@forgeax/engine-scene';
import { SkinJointPathUnresolvedError } from '@forgeax/engine-skinning';
import { type Asset, type AssetRef, err, type SceneAsset } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { AssetRegistry } from '../asset-registry';
import { runtimeAssets } from '../internal/runtime-assets';
import type { PostSpawnHook } from '../registry/instantiate';
import { parseScenePayload } from '../scene-payload';
import { defined } from './assert-defined.js';
import { publishRuntimeAssets } from './fixtures/runtime-publication';

const T709Tag = defineComponent('T709Tag', { value: 'f32' });
const T709MaterialCarrier = defineComponent('T709MaterialCarrier', {
  materials: 'array<asset<material>>',
});
const SceneInstance = defineComponent('SceneInstance', {
  source: 'asset<scene>',
  mapping: 'array<entity>',
  state: 'unique<SceneInstanceState>',
});

const MATERIAL_GUID = '11111111-1111-4111-8111-111111111111';
const CHILD_GUID = '22222222-2222-4222-8222-222222222222';
const PARENT_GUID = '33333333-3333-4333-8333-333333333333';

function makeRegistry(postSpawnHook?: PostSpawnHook): AssetRegistry {
  return new AssetRegistry({
    shaderRegistry: {
      getMaterialShaderManifest: vi.fn().mockReturnValue(undefined),
      findMaterialArtifact: vi.fn().mockReturnValue({ ok: false, error: new Error('mock') }),
      getPipeline: vi.fn().mockReturnValue(undefined),
      installMaterialArtifact: vi.fn(),
      inspect: vi.fn().mockReturnValue({ materialShaders: [] }),
    } as unknown as import('@forgeax/engine-shader').ShaderRegistry,
    postSpawnHook: postSpawnHook,
  });
}

function makeWorld(reg: AssetRegistry): World {
  const world = new World({ assets: reg });
  for (const component of [T709Tag, T709MaterialCarrier, SceneInstance]) {
    world.components.register(component).unwrap();
  }
  sourceWorlds.set(reg, world);
  return world;
}

const sourceWorlds = new WeakMap<AssetRegistry, World>();
const sources = new WeakMap<
  AssetRegistry,
  Map<string, { asset: Asset; refs?: readonly AssetRef[] }>
>();
function declareSource<T extends Asset>(
  reg: AssetRegistry,
  guid: string,
  asset: T,
  refs?: readonly AssetRef[],
): T {
  let entries = sources.get(reg);
  if (entries === undefined) {
    entries = new Map();
    sources.set(reg, entries);
  }
  entries.set(guid, { asset, ...(refs === undefined ? {} : { refs }) });
  return asset;
}
async function loadPublishedScene(reg: AssetRegistry, guid: string, _kind: 'scene') {
  try {
    const entries = [...(sources.get(reg) ?? [])].map(([guid, { asset, refs }]) => {
      if (asset.kind !== 'scene') return { guid, asset, refs: refs?.map((ref) => ref.guid) ?? [] };
      if (refs !== undefined) return { guid, asset, refs: refs.map((ref) => ref.guid) };
      const cooked = externalizeSceneAsset(asset, (name) => {
        const component = sourceWorlds.get(reg)?.components.resolve(name);
        return component === undefined ? undefined : componentSchema(component);
      }).unwrap();
      return {
        guid,
        asset: cooked.payload as SceneAsset,
        refs: cooked.refs.map((ref) => ref.guid),
      };
    });
    reg.installDecoder(sceneAssetContribution.kind, sceneAssetContribution.decoder);
    publishRuntimeAssets(reg, entries);
    return reg.load(guid, 'scene');
  } catch (error) {
    return err(error);
  }
}
let sceneSequence = 0;
async function loadScene(reg: AssetRegistry, scene: SceneAsset, refs?: readonly AssetRef[]) {
  const guid = `aaaaaaaa-aaaa-4aaa-8aaa-${String(++sceneSequence).padStart(12, '0')}`;
  declareSource(reg, guid, scene, refs);
  return loadPublishedScene(reg, guid, 'scene');
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
  it('preserves native asset handles in a code-created Scene', async () => {
    const reg = makeRegistry();
    const world = makeWorld(reg);
    const Native = defineComponent('ReflectedNativeHandles', {
      arbitrary: 'asset<material>',
      empty: 'asset<material>',
      fixed: 'array<asset<material>, 2>',
    });
    world.components.register(Native).unwrap();
    const payload = material();
    const materialHandle = reg.create(payload).unwrap();
    const scene = declareSource(reg, PARENT_GUID, {
      kind: 'scene',
      entities: {
        root: {
          components: {
            [Native.name]: {
              arbitrary: materialHandle,
              empty: 0,
              fixed: new Uint32Array([0, materialHandle]),
            },
          },
        },
      },
    } as SceneAsset);
    const handle = reg.create(scene).unwrap();
    const root = reg.instantiate(handle, world).unwrap();
    const entity = defined(
      [...world.iterDescendants(root)].find((e) => world.hasComponent(e, Native)),
    );
    const row = world.get(entity, Native).unwrap();
    expect(runtimeAssets(world.assets).resolveAsset(row.arbitrary).unwrap()).toEqual(payload);
    expect(row.empty).toBe(0);
    expect(Array.from(row.fixed)).toEqual([0, materialHandle]);
    worldDespawnScene(world, root).unwrap();
    reg.release(handle).unwrap();
    reg.release(materialHandle).unwrap();
    expect(world.sharedRefs._liveCount()).toBe(0);
  });

  it('rejects an explicit wire index zero against an empty table before spawning', async () => {
    const reg = makeRegistry();
    const world = makeWorld(reg);
    const Carrier = defineComponent('ReflectedEmptyWireTable', { arbitrary: 'asset<mesh>' });
    world.components.register(Carrier).unwrap();
    const scene = declareSource(
      reg,
      PARENT_GUID,
      {
        kind: 'scene',
        entities: { root: { components: { [Carrier.name]: { arbitrary: 0 } } } },
      } as SceneAsset,
      [],
    );
    const result = await loadScene(reg, scene, []);
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'asset-parse-failed',
        detail: {
          entityKey: 'root',
          component: Carrier.name,
          field: 'arbitrary',
          index: 0,
          refsLength: 0,
        },
      },
    });
    expect(world.inspect().entityCount).toBe(0);
    expect(world.execution.fault).toBeNull();
    expect(world.sharedRefs._liveCount()).toBe(0);
  });

  it.each([
    () => new Float32Array([1, -2]),
    () => new Uint16Array([1000, 2000, 3000]).subarray(1),
    () => new DataView(new Uint8Array([9, 3, 2, 8]).buffer, 1, 2),
    () => new Uint8Array([0, 255]).buffer,
    () => new SharedArrayBuffer(3),
  ])('round-trips the exact byte window of every native buffer input', async (makeBuffer) => {
    const input = makeBuffer();
    const expected = Array.from(
      ArrayBuffer.isView(input)
        ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
        : new Uint8Array(input),
    );
    const BufferCarrier = defineComponent('ReflectedByteWindow', {
      bytes: 'buffer',
      fixed: `buffer<${expected.length}>`,
    });
    const reg = makeRegistry();
    const world = makeWorld(reg);
    world.components.register(BufferCarrier).unwrap();
    const cooked = externalizeSceneAsset(
      {
        kind: 'scene',
        entities: {
          root: { components: { [BufferCarrier.name]: { bytes: input, fixed: input } } },
        },
      },
      () => componentSchema(BufferCarrier),
    ).unwrap();
    const parsed = parseScenePayload(JSON.parse(JSON.stringify(cooked.payload)), []);
    if (!parsed) throw new Error('expected Scene payload');
    const handle = (await loadScene(reg, parsed)).unwrap();
    const root = reg.instantiate(handle, world).unwrap();
    const entity = defined(
      [...world.iterDescendants(root)].find((e) => world.hasComponent(e, BufferCarrier)),
    );
    const row = world.get(entity, BufferCarrier).unwrap();
    expect(Array.from(row.bytes)).toEqual(expected);
    expect(Array.from(row.fixed)).toEqual(expected);
    worldDespawnScene(world, root).unwrap();
    reg.release(handle).unwrap();
  });

  it('uses each nested Scene reference table and the parent table for instance overrides', async () => {
    const reg = makeRegistry();
    const world = makeWorld(reg);
    world.components.register(ChildOf).unwrap();
    world.components.register(Children).unwrap();
    const Carrier = defineComponent('ReflectedNestedCarrier', {
      arbitrary: 'asset<material>',
      choices: 'array<asset<material>, 2>',
      density: 'f32',
    });
    world.components.register(Carrier).unwrap();
    const otherGuid = '44444444-4444-4444-8444-444444444444';
    const a = material(),
      b = material();
    declareSource(reg, MATERIAL_GUID, a);
    declareSource(reg, otherGuid, b);
    const publish = (guid: string, source: SceneAsset) => {
      const cooked = externalizeSceneAsset(source, (name) => {
        const token = world.components.resolve(name);
        return token === undefined ? undefined : componentSchema(token);
      }).unwrap();
      const parsed = parseScenePayload(
        cooked.payload,
        cooked.refs.map((ref) => ref.guid),
      );
      if (!parsed || !('kind' in parsed)) throw new Error('expected Scene');
      return declareSource(reg, guid, parsed, cooked.refs);
    };
    publish(CHILD_GUID, {
      kind: 'scene',
      entities: {
        body: {
          components: {
            [Carrier.name]: { arbitrary: otherGuid, choices: [0, otherGuid], density: 1 },
          },
        },
      },
    });
    publish(PARENT_GUID, {
      kind: 'scene',
      entities: {
        child: {
          components: {},
          instance: {
            source: CHILD_GUID,
            overrides: [
              {
                target: ['body'],
                components: {
                  [Carrier.name]: { arbitrary: MATERIAL_GUID, choices: [MATERIAL_GUID, 0] },
                },
              },
            ],
          },
        },
      },
    });
    for (const [guid, expected, index] of [
      [PARENT_GUID, a, 0],
      [CHILD_GUID, b, 1],
    ] as const) {
      const handle = (await loadPublishedScene(reg, guid, 'scene')).unwrap();
      const root = reg.instantiate(handle, world).unwrap();
      const entity = defined(
        [...world.iterDescendants(root)].find((e) => world.hasComponent(e, Carrier)),
      );
      const row = world.get(entity, Carrier).unwrap();
      expect(
        runtimeAssets(world.assets)
          .resolveAsset(row.arbitrary as never)
          .unwrap(),
      ).toEqual(expected);
      expect(
        runtimeAssets(world.assets)
          .resolveAsset(row.choices[index] as never)
          .unwrap(),
      ).toEqual(expected);
      expect(row.choices[1 - index]).toBe(0);
      expect(row.density).toBe(1);
      worldDespawnScene(world, root).unwrap();
      reg.release(handle).unwrap();
      expect(world.sharedRefs._liveCount()).toBe(0);
    }
  });

  it.each([
    -1, 1, 0.5,
  ])('rejects a malformed custom shared reference %s before any entity survives', async (index) => {
    const reg = makeRegistry();
    const world = makeWorld(reg);
    const Custom = defineComponent('ReflectedInvalidIndex', { custom: 'asset<material>' });
    world.components.register(Custom).unwrap();
    declareSource(reg, MATERIAL_GUID, material());
    const scene = declareSource(
      reg,
      PARENT_GUID,
      {
        kind: 'scene',
        entities: {
          root: {
            components: {
              T709MaterialCarrier: { materials: [MATERIAL_GUID] },
              [Custom.name]: { custom: index },
            },
          },
        },
      } as SceneAsset,
      [{ guid: MATERIAL_GUID }],
    );
    const result = await loadScene(reg, scene, [{ guid: MATERIAL_GUID }]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejected reference');
    expect(result.error).toMatchObject({
      code: 'asset-parse-failed',
      detail: {
        entityKey: 'root',
        component: Custom.name,
        field: 'custom',
        index,
        refsLength: 1,
      },
    });
    expect(world.inspect().entityCount).toBe(0);
    expect(world.sharedRefs._liveCount()).toBe(0);
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])('rejects a nonfinite native reference %s before JSON transport', (reference) => {
    const reg = makeRegistry();
    const world = makeWorld(reg);
    const Custom = defineComponent('NonfiniteNativeReference', { custom: 'asset<material>' });
    world.components.register(Custom).unwrap();
    const result = reg.create({
      kind: 'scene',
      entities: {
        root: {
          components: {
            [Custom.name]: { custom: reference },
          },
        },
      },
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'asset-reference-invalid' } });
    expect(world.inspect().entityCount).toBe(0);
    expect(world.sharedRefs._liveCount()).toBe(0);
  });

  it.each([
    ['bytes', [-1]],
    ['bytes', [256]],
    ['bytes', [1.5]],
    ['bytes', 'bad'],
    ['fixedBytes', [1, 2]],
    ['fixedBytes', [1, 2, 3, 4]],
    ['vector', [1, 2]],
    ['fixedRefs', []],
    ['fixedEntities', ['target']],
  ])('rejects invalid reflected %s input without spawning', async (field, value) => {
    const reg = makeRegistry();
    const world = makeWorld(reg);
    const Custom = defineComponent('ReflectedInvalidArray', {
      bytes: 'buffer',
      fixedBytes: 'buffer<3>',
      vector: 'array<f32, 3>',
      fixedRefs: 'array<asset<material>, 2>',
      fixedEntities: 'array<entity, 2>',
    });
    world.components.register(Custom).unwrap();
    const handle = (
      await loadScene(reg, {
        kind: 'scene',
        entities: {
          source: { components: { [Custom.name]: { [field as string]: value } } },
          target: { components: { T709Tag: { value: 1 } } },
        },
      } as SceneAsset)
    ).unwrap();
    expect(reg.instantiate(handle, world).ok).toBe(false);
    expect(world.inspect().entityCount).toBe(0);
    reg.release(handle).unwrap();
    expect(world.sharedRefs._liveCount()).toBe(0);
  });

  it('round-trips every ECS storage family using custom component schema reflection', async () => {
    const reg = makeRegistry();
    const world = makeWorld(reg);
    const scalars = {
      f32: 0.25,
      f64: 0.5,
      i32: -3,
      u32: 3,
      i16: -2,
      u16: 2,
      i8: -1,
      u8: 1,
      bool: true,
      enum: 2,
      ref: 7,
    } as const;
    const schema: ComponentSchema = {};
    const values: Record<string, unknown> = {};
    for (const [type, value] of Object.entries(scalars)) {
      schema[`scalar_${type}`] = type as keyof typeof scalars;
      schema[`variable_${type}`] = `array<${type as keyof typeof scalars}>`;
      schema[`fixed_${type}`] = `array<${type as keyof typeof scalars}, 2>`;
      values[`scalar_${type}`] = value;
      const item = Number(value);
      values[`variable_${type}`] = new Float64Array([item, item]);
      values[`fixed_${type}`] = [item, item];
    }
    const All = defineComponent('ReflectedSceneAllStorage', {
      ...schema,
      text: 'string',
      bytes: 'buffer',
      fixedBytes: 'buffer<3>',
      owned: { type: 'unique<SceneNestedFixture>', shape: 'nested' },
      target: 'entity',
      optionalTarget: { type: 'entity', shape: 'optional', default: null },
      targets: 'array<entity>',
      fixedTargets: 'array<entity, 2>',
      arbitraryAsset: 'asset<material>',
      arbitraryAssets: 'array<asset<material>>',
      fixedAssets: 'array<asset<material>, 2>',
      emptyAssets: 'array<asset<material>, 2>',
      vector: { type: 'array<f32, 3>', shape: 'vector' },
      quaternion: { type: 'array<f32, 4>', shape: 'quaternion' },
    });
    world.components.register(All).unwrap();
    const payload = material();
    declareSource(reg, MATERIAL_GUID, payload);
    const nested = { count: 3, values: [1, 2] };
    const owned = world.allocUniqueRef('SceneNestedFixture', nested);
    Object.assign(values, {
      text: MATERIAL_GUID,
      bytes: new Uint8Array([0, 1, 255]),
      fixedBytes: [3, 2, 1],
      owned,
      target: 'target',
      optionalTarget: null,
      targets: ['target'],
      fixedTargets: ['target', 'target'],
      arbitraryAsset: MATERIAL_GUID,
      arbitraryAssets: [MATERIAL_GUID, 0],
      fixedAssets: [0, MATERIAL_GUID],
      emptyAssets: new Uint32Array(2),
      vector: [1, 2, 3],
      quaternion: [0, 0, 0, 1],
    });
    const authored: SceneAsset = {
      kind: 'scene',
      entities: {
        source: { components: { [All.name]: values } },
        target: { components: { T709Tag: { value: 42 } } },
      },
    };
    const cooked = externalizeSceneAsset(authored, (name) => {
      const token = world.components.resolve(name);
      return token === undefined ? undefined : componentSchema(token);
    }).unwrap();
    expect(cooked.payload.entities).toMatchObject({
      source: {
        components: { [All.name]: { emptyAssets: [null, null], variable_f32: [0.25, 0.25] } },
      },
    });
    const wire = JSON.parse(
      JSON.stringify(cooked.payload, (_key, value) =>
        ArrayBuffer.isView(value) && 'length' in value
          ? Array.from(value as unknown as ArrayLike<number>)
          : value,
      ),
    );
    const parsed = parseScenePayload(
      wire,
      cooked.refs.map((ref) => ref.guid),
    );
    if (!parsed || !('kind' in parsed)) throw new Error('expected a structural Scene payload');
    // The loader owns no World and must not guess component reference fields.
    expect(parsed.entities.source?.components[All.name]?.arbitraryAsset).toBe(0);
    declareSource(reg, PARENT_GUID, parsed, cooked.refs);
    const handle = (await loadPublishedScene(reg, PARENT_GUID, 'scene')).unwrap();
    const root = reg.instantiate(handle, world).unwrap();
    const members = [...world.iterDescendants(root)];
    const source = defined(members.find((entity) => world.hasComponent(entity, All)));
    const target = defined(members.find((entity) => world.hasComponent(entity, T709Tag)));
    const data = world.get(source, All).unwrap() as Record<string, unknown>;
    for (const [type, value] of Object.entries(scalars)) {
      expect(data[`scalar_${type}`]).toBe(value);
      expect(Array.from(data[`variable_${type}`] as ArrayLike<number>)).toEqual([
        type === 'bool' ? 1 : value,
        type === 'bool' ? 1 : value,
      ]);
      expect(Array.from(data[`fixed_${type}`] as ArrayLike<number>)).toEqual([
        type === 'bool' ? 1 : value,
        type === 'bool' ? 1 : value,
      ]);
    }
    expect(data.text).toBe(MATERIAL_GUID);
    expect(Array.from(data.bytes as Uint8Array)).toEqual([0, 1, 255]);
    expect(Array.from(data.fixedBytes as Uint8Array)).toEqual([3, 2, 1]);
    expect(world.resolveUniqueRef(data.owned as never).unwrap()).toBe(nested);
    expect(data.target).toBe(target);
    expect(data.optionalTarget).toBeNull();
    expect(Array.from(data.targets as Uint32Array)).toEqual([target]);
    expect(Array.from(data.fixedTargets as Uint32Array)).toEqual([target, target]);
    expect(
      runtimeAssets(world.assets)
        .resolveAsset(data.arbitraryAsset as never)
        .unwrap(),
    ).toEqual(payload);
    expect(Array.from(data.arbitraryAssets as Uint32Array)).toEqual([data.arbitraryAsset, 0]);
    expect(Array.from(data.fixedAssets as Uint32Array)).toEqual([0, data.arbitraryAsset]);
    expect(Array.from(data.emptyAssets as Uint32Array)).toEqual([0, 0]);
    expect(Array.from(data.vector as Float32Array)).toEqual([1, 2, 3]);
    expect(Array.from(data.quaternion as Float32Array)).toEqual([0, 0, 0, 1]);
    worldDespawnScene(world, root).unwrap();
    reg.release(handle).unwrap();
    expect(world.sharedRefs._liveCount()).toBe(0);
  });
  it.each([
    'anchor',
    'flat',
  ] as const)('keeps Result helpers and the original %s post-spawn failure', async (mode) => {
    const failure = new SkinJointPathUnresolvedError(0, ['missing'], 0);
    const reg = makeRegistry(() => ({ ok: false, error: failure }));
    const world = makeWorld(reg);
    const handle = (await loadScene(reg, twoEntityScene())).unwrap();
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
    expect(world.sharedRefs._liveCount()).toBe(0);
    reg.release(handle).unwrap();
  });

  it.each([
    'anchor',
    'flat',
  ] as const)('rejects a stale authored %s instance override before spawning its child', async (_mode) => {
    const reg = makeRegistry();
    const world = makeWorld(reg);
    world.components.register(ChildOf).unwrap();
    world.components.register(Children).unwrap();
    const stale = reg.create(material()).unwrap();
    reg.release(stale).unwrap();
    declareSource(reg, CHILD_GUID, {
      kind: 'scene',
      entities: { child: { components: { T709Tag: { value: 1 } } } },
    });
    const result = await loadScene(reg, {
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
    expect(result).toMatchObject({ ok: false, error: { code: 'asset-parse-failed' } });
    expect(world.inspect().entityCount).toBe(baseline);
    expect(world.sharedRefs._liveCount()).toBe(0);
  });
  it.each([
    'anchor',
    'flat',
  ] as const)('applies authored %s array overrides that add a component without leaking grants', async (mode) => {
    const reg = makeRegistry();
    const world = makeWorld(reg);
    world.components.register(ChildOf).unwrap();
    world.components.register(Children).unwrap();
    declareSource(reg, MATERIAL_GUID, material());
    declareSource(reg, CHILD_GUID, {
      kind: 'scene',
      entities: { child: { components: { T709Tag: { value: 7 } } } },
    });
    const handle = (
      await loadScene(reg, {
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
      } as SceneAsset)
    ).unwrap();
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
      expect(reg.read(refs[0] as never).ok).toBe(true);
      for (const root of roots) worldDespawnScene(world, root).unwrap();
      expect(world.sharedRefs._liveCount()).toBe(0);
      expect(world.inspect().entityCount).toBe(0);
    }
    reg.release(handle).unwrap();
    expect(world.sharedRefs._liveCount()).toBe(0);
  });
  it.each([
    'anchor',
    'flat',
  ] as const)('keeps independent source identities for equal payloads across %s instances', async (mode) => {
    const reg = makeRegistry();
    const world = makeWorld(reg);
    const payload = material();
    declareSource(reg, MATERIAL_GUID, payload);
    declareSource(reg, CHILD_GUID, payload);
    const scene: SceneAsset = {
      kind: 'scene',
      entities: {
        box: { components: { T709MaterialCarrier: { materials: [MATERIAL_GUID, CHILD_GUID] } } },
      },
    };
    const handle = (await loadScene(reg, scene)).unwrap();
    for (let cycle = 0; cycle < 3; cycle++) {
      const roots =
        mode === 'anchor'
          ? [reg.instantiate(handle, world).unwrap()]
          : reg.instantiateFlat(handle, world).unwrap();
      const sibling =
        mode === 'anchor'
          ? [reg.instantiate(handle, world).unwrap()]
          : reg.instantiateFlat(handle, world).unwrap();
      const first = reg.read(handle).unwrap();
      const fields = first.entities.box?.components.T709MaterialCarrier as { materials: number[] };
      expect(fields.materials[0]).not.toBe(fields.materials[1]);
      for (const root of roots) worldDespawnScene(world, root).unwrap();
      expect(reg.read(fields.materials[0] as never).ok).toBe(true);
      for (const root of sibling) worldDespawnScene(world, root).unwrap();
      expect(world.sharedRefs._liveCount()).toBe(0);
    }
    reg.release(handle).unwrap();
    expect(world.sharedRefs._liveCount()).toBe(0);
  });
  it.each([
    'anchor',
    'flat',
  ] as const)('keeps nested %s source references available for override removal and releases them on failure/close', async (mode) => {
    let failing = false;
    const reg = makeRegistry(() =>
      failing
        ? {
            ok: false,
            error: new SkinJointPathUnresolvedError(0, ['injected preparation failure'], 0),
          }
        : { ok: true },
    );
    const world = makeWorld(reg);
    world.components.register(ChildOf).unwrap();
    world.components.register(Children).unwrap();
    declareSource(reg, MATERIAL_GUID, material());
    declareSource(reg, CHILD_GUID, {
      kind: 'scene',
      entities: {
        child: { components: { T709MaterialCarrier: { materials: [MATERIAL_GUID] } } },
      },
    });
    const handle = (
      await loadScene(reg, {
        kind: 'scene',
        entities: { nested: { components: {}, instance: { source: CHILD_GUID } } },
      } as SceneAsset)
    ).unwrap();
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
    expect(reg.read(original as never).ok).toBe(true);
    worldRemoveSceneOverride(world, nested, member, T709MaterialCarrier, 'materials').unwrap();
    expect(world.get(member, T709MaterialCarrier).unwrap().materials[0]).toBe(original);
    for (const root of roots) worldDespawnScene(world, root).unwrap();
    expect(world.sharedRefs._liveCount()).toBe(0);
    failing = true;
    expect(
      mode === 'anchor' ? reg.instantiate(handle, world).ok : reg.instantiateFlat(handle, world).ok,
    ).toBe(false);
    expect(world.sharedRefs._liveCount()).toBe(0);
    reg.release(handle).unwrap();
    expect(world.sharedRefs._liveCount()).toBe(0);
  });
  it('materialises keyed entities and returns a synthetic root', async () => {
    const reg = makeRegistry();
    const world = makeWorld(reg);
    const handle = (await loadScene(reg, twoEntityScene())).unwrap();
    const result = reg.instantiate(handle, world);
    expect(result.ok).toBe(true);
    if (result.ok) expect(typeof result.value).toBe('number');
  });

  it('materialises keyed entities flat for authoring', async () => {
    const reg = makeRegistry();
    const world = makeWorld(reg);
    const handle = (await loadScene(reg, twoEntityScene())).unwrap();
    const result = reg.instantiateFlat(handle, world);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.length).toBe(2);
  });

  it('releases temporary scene grants across repeated flat playback', async () => {
    const reg = makeRegistry();
    const world = makeWorld(reg);
    const handle = (await loadScene(reg, twoEntityScene())).unwrap();
    const baseline = world.sharedRefs._liveCount();
    for (let cycle = 0; cycle < 20; cycle++) {
      const entities = reg.instantiateFlat(handle, world).unwrap();
      for (const entity of entities) world.despawn(entity).unwrap();
      expect(world.sharedRefs._liveCount()).toBe(baseline);
    }
    expect(reg.read(handle).ok).toBe(true);
  });
});

describe('Scene runtime admission', () => {
  it('loads component references before publication without changing entity keys', async () => {
    const reg = makeRegistry();
    makeWorld(reg);
    declareSource(reg, MATERIAL_GUID, material());
    const handle = (
      await loadScene(reg, {
        kind: 'scene',
        entities: {
          player: { components: { T709MaterialCarrier: { materials: [MATERIAL_GUID] } } },
        },
      })
    ).unwrap();
    const value = reg.read(handle).unwrap();
    expect(Object.keys(value.entities)).toEqual(['player']);
    const values = value.entities.player?.components.T709MaterialCarrier as { materials: number[] };
    expect(values.materials).toHaveLength(1);
    expect(reg.read(values.materials[0] as never).unwrap()).toEqual(material());
    reg.dispose();
  });

  it('links nested runtime identities and rejects dependency cycles atomically', () => {
    const reg = makeRegistry();
    makeWorld(reg);
    const child = reg.create({ kind: 'scene', entities: { root: { components: {} } } }).unwrap();
    const parent = reg
      .create({
        kind: 'scene',
        entities: { room: { components: {}, instance: { source: child } } },
      })
      .unwrap();
    expect(reg.read(parent).unwrap().entities.room?.instance?.source).toBe(child);
    const fixed = reg.snapshot(child).unwrap();
    expect(
      reg.replace(child, {
        kind: 'scene',
        entities: { loop: { components: {}, instance: { source: parent } } },
      }),
    ).toMatchObject({ ok: false, error: { code: 'asset-reference-invalid' } });
    expect(fixed.matchesCurrent()).toBe(true);
    reg.release(child).unwrap();
    expect(reg.validate(child).ok).toBe(true);
    reg.release(parent).unwrap();
    expect(reg.validate(child).ok).toBe(false);
    fixed.dispose();
    reg.dispose();
  });

  it('reports a missing source and leaves no partially adopted runtime identities', async () => {
    const reg = makeRegistry();
    const world = makeWorld(reg);
    const result = await loadScene(reg, {
      kind: 'scene',
      entities: {
        missingMesh: { components: { T709MaterialCarrier: { materials: [MATERIAL_GUID] } } },
      },
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'asset-not-found' } });
    expect(world.inspect().entityCount).toBe(0);
    expect(runtimeAssets(reg).inspect().assets).toBe(0);
    reg.dispose();
  });
});

it('keeps existing instance restoration values while template edits affect future instances, with exact dependency release', () => {
  const reg = makeRegistry();
  const world = makeWorld(reg);
  world.components.register(ChildOf).unwrap();
  world.components.register(Children).unwrap();
  const red = reg.create(material()).unwrap();
  const green = reg.create(material()).unwrap();
  const child = reg
    .create({
      kind: 'scene',
      entities: { child: { components: { T709MaterialCarrier: { materials: [red] } } } },
    })
    .unwrap();
  const parent = reg
    .create({
      kind: 'scene',
      entities: { nested: { components: {}, instance: { source: child } } },
    })
    .unwrap();
  reg.release(child).unwrap();
  reg.release(red).unwrap();
  const first = reg.instantiate(parent, world).unwrap();
  const nested = defined(worldGetSceneInstanceState(world, first).unwrap().mountRoots[0]);
  const state = worldGetSceneInstanceState(world, nested).unwrap();
  const member = defined(
    [...state.entityToLocalId.keys()].find((entity) =>
      world.hasComponent(entity, T709MaterialCarrier),
    ),
  );
  const before = runtimeAssets(reg).refcount(red);
  worldSetSceneOverride(world, nested, member, T709MaterialCarrier, 'materials', []).unwrap();
  expect(runtimeAssets(reg).refcount(red)).toBe(before - 1);
  reg
    .update(child, {
      entities: { child: { components: { T709MaterialCarrier: { materials: [green] } } } },
    })
    .unwrap();
  reg.release(green).unwrap();
  expect(reg.validate(red).ok).toBe(true);
  worldRemoveSceneOverride(world, nested, member, T709MaterialCarrier, 'materials').unwrap();
  expect(world.get(member, T709MaterialCarrier).unwrap().materials[0]).toBe(red);
  const second = reg.instantiate(parent, world).unwrap();
  const next = defined(
    [...world.iterDescendants(second)].find((entity) =>
      world.hasComponent(entity, T709MaterialCarrier),
    ),
  );
  expect(world.get(next, T709MaterialCarrier).unwrap().materials[0]).toBe(green);
  reg.release(parent).unwrap();
  worldDespawnScene(world, first).unwrap();
  expect(reg.validate(red).ok).toBe(false);
  worldDespawnScene(world, second).unwrap();
  expect(runtimeAssets(reg).inspect().assets).toBe(0);
  reg.dispose();
});
