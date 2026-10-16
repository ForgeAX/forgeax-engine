import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { sceneAssetDecoder } from '../assets/scene-decoder.js';
import {
  resolveSceneEntity,
  type SceneEntityRef,
  sceneEntity,
  sceneEntityAddressKey,
  validateSceneEntityKeys,
} from '../instances/binding.js';
import { externalizeSceneAsset } from '../instances/externalization.js';

describe('SceneEntityRef instance address', () => {
  const bindings = (address: SceneEntityRef['address'], value: number) =>
    new Map([[sceneEntityAddressKey(address), value]]);

  it('resolves by scene source and authored entity address', () => {
    const ref: SceneEntityRef = sceneEntity('level/main', 'player');
    const first = resolveSceneEntity(ref, {
      sceneSourceKey: 'level/main',
      bindings: bindings('player', 11),
    });
    const second = resolveSceneEntity(ref, {
      sceneSourceKey: 'level/main',
      bindings: bindings('player', 22),
    });

    expect(first).toEqual({ ok: true, value: 11 });
    expect(second).toEqual({ ok: true, value: 22 });
  });

  it('rejects a missing or cross-instance address with a closed error', () => {
    const result = resolveSceneEntity(sceneEntity('level/main', 'camera'), {
      sceneSourceKey: 'level/main',
      bindings: bindings('player', 11),
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'scene-binding-missing',
        expected: expect.stringContaining('entity key'),
        hint: expect.stringContaining('declare'),
        detail: { sceneSourceKey: 'level/main', address: 'camera' },
      },
    });
  });

  it('rejects a reference from another concrete SceneInstance', () => {
    const result = resolveSceneEntity(sceneEntity('level/other', 'player'), {
      sceneSourceKey: 'level/main',
      bindings: bindings('player', 11),
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'scene-binding-wrong-instance',
        detail: { sceneSourceKey: 'level/other', address: 'player' },
      },
    });
  });

  it('requires an explicit anonymous source key for direct POD scenes', () => {
    const anonymous = resolveSceneEntity(sceneEntity('', 'player'), {
      sceneSourceKey: '',
      bindings: bindings('player', 11),
    });
    const fabricated = resolveSceneEntity(sceneEntity('unrelated/source', 'player'), {
      sceneSourceKey: '',
      bindings: bindings('player', 11),
    });
    expect(anonymous).toEqual({ ok: true, value: 11 });
    expect(fabricated).toMatchObject({
      ok: false,
      error: { code: 'scene-binding-wrong-instance' },
    });
  });

  it('rejects duplicate authored entity keys before publication', () => {
    const result = validateSceneEntityKeys('level/main', ['player', 'player']);

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'scene-binding-duplicate',
        expected: expect.stringContaining('unique'),
        hint: expect.stringContaining('rename'),
        detail: { sceneSourceKey: 'level/main', address: 'player' },
      },
    });
  });

  it('supports nested addresses without using display names or paths', () => {
    const ref = sceneEntity('level/main', ['house', 'door']);
    expect(ref).toEqual({ sceneSourceKey: 'level/main', address: ['house', 'door'] });
    expect(ref).not.toHaveProperty('name');
    expect(ref).not.toHaveProperty('path');
  });

  it('treats a one-segment address array as the same direct key', () => {
    const direct = resolveSceneEntity(sceneEntity('level/main', 'player'), {
      sceneSourceKey: 'level/main',
      bindings: bindings('player', 11),
    });
    const array = resolveSceneEntity(sceneEntity('level/main', ['player']), {
      sceneSourceKey: 'level/main',
      bindings: bindings(['player'], 11),
    });
    expect(direct).toEqual({ ok: true, value: 11 });
    expect(array).toEqual(direct);
  });

  it('keeps literal and nested addresses distinct', () => {
    const literal = '["house","door"]';
    const nested = ['house', 'door'] as const;
    const map = new Map([
      [sceneEntityAddressKey(literal), 11],
      [sceneEntityAddressKey(nested), 22],
    ]);
    const literalResult = resolveSceneEntity(sceneEntity('level/main', literal), {
      sceneSourceKey: 'level/main',
      bindings: map,
    });
    const nestedResult = resolveSceneEntity(sceneEntity('level/main', nested), {
      sceneSourceKey: 'level/main',
      bindings: map,
    });
    expect(literalResult).toEqual({ ok: true, value: 11 });
    expect(nestedResult).toEqual({ ok: true, value: 22 });
  });

  it('preserves keyed scene data through decode and externalization', async () => {
    const envelope = {
      guid: '00000000-0000-0000-0000-000000000021',
      kind: 'scene',
      payload: {
        kind: 'scene' as const,
        entities: { player: { components: {} } },
      },
      refs: [],
      artifacts: {},
    } as unknown as Parameters<typeof sceneAssetDecoder.decode>[0]['envelope'];
    const decoded = await sceneAssetDecoder.decode({
      envelope,
      artifacts: { read: async () => ok(new Uint8Array()) },
      signal: new AbortController().signal,
    });
    expect(decoded).toMatchObject({
      ok: true,
      value: { entities: { player: { components: {} } } },
    });
    if (!decoded.ok) return;

    const externalized = externalizeSceneAsset(decoded.value, () => ({}));
    expect(externalized).toMatchObject({
      ok: true,
      value: { payload: { entities: { player: { components: {} } } } },
    });
  });

  it('keeps legacy binding keys when decoding an array SceneAsset', async () => {
    const envelope = {
      guid: '00000000-0000-0000-0000-000000000022',
      kind: 'scene',
      payload: {
        kind: 'scene' as const,
        entities: [
          { localId: 0, bindingKey: 'root', components: {} },
          { localId: 1, bindingKey: 'player', components: { ChildOf: { parent: 0 } } },
        ],
      },
      refs: [],
      artifacts: {},
    } as unknown as Parameters<typeof sceneAssetDecoder.decode>[0]['envelope'];
    const decoded = await sceneAssetDecoder.decode({
      envelope,
      artifacts: { read: async () => ok(new Uint8Array()) },
      signal: new AbortController().signal,
    });
    expect(decoded).toMatchObject({
      ok: true,
      value: {
        entities: {
          root: { components: {} },
          player: { components: { ChildOf: { parent: 'root' } } },
        },
      },
    });
  });

  it('migrates the 0.1.27 numeric template fields at the externalization boundary', () => {
    const legacy = {
      kind: 'scene',
      entities: [
        { localId: 0, components: { Name: { value: 'Root' } } },
        {
          localId: 1,
          components: {
            ChildOf: { parent: 0 },
            DirectionalLight: { pcfKernelSize: 3 },
          },
        },
      ],
    } as unknown as import('@forgeax/engine-types').SceneAsset;
    const externalized = externalizeSceneAsset(legacy, (componentName) => {
      if (componentName === 'ChildOf') return { parent: 'entity' };
      if (componentName === 'DirectionalLight') {
        return { pcfKernelSize: 'f32', shadowFilter: 'f32' };
      }
      return {};
    });
    expect(externalized).toMatchObject({
      ok: true,
      value: {
        payload: {
          entities: {
            '1': {
              components: {
                ChildOf: { parent: '0' },
                DirectionalLight: { shadowFilter: 2 },
              },
            },
          },
        },
      },
    });
    if (!externalized.ok) return;
    expect(externalized.value.payload.entities).not.toHaveProperty(
      '1.components.DirectionalLight.pcfKernelSize',
    );
  });
});

describe('shared null wire sentinel', () => {
  it('keeps zero shared handles distinct from reference index zero', () => {
    const scene = {
      kind: 'scene',
      entities: {
        car: {
          components: {
            MeshFilter: { assetHandle: 'mesh-guid' },
            MeshRenderer: { materials: [0, 'material-guid', 0] },
            VolumetricFog: { density: 0, light: null },
            Transform: { pos: [0, 1, 0] },
          },
        },
      },
    } as unknown as import('@forgeax/engine-types').SceneAsset;
    const schemas: Record<string, Readonly<Record<string, string>>> = {
      MeshFilter: { assetHandle: 'shared<MeshAsset>' },
      MeshRenderer: { materials: 'array<shared<MaterialAsset>>' },
      VolumetricFog: { density: 'shared<TextureAsset>', light: 'string' },
      Transform: { pos: 'array<f32,3>' },
    };
    const result = externalizeSceneAsset(scene, (name) => schemas[name]);
    expect(result).toMatchObject({
      ok: true,
      value: {
        payload: {
          entities: {
            car: {
              components: {
                MeshFilter: { assetHandle: 0 },
                MeshRenderer: { materials: [null, 1, null] },
                VolumetricFog: { density: null, light: null },
                Transform: { pos: [0, 1, 0] },
              },
            },
          },
        },
        refs: [{ guid: 'mesh-guid' }, { guid: 'material-guid' }],
      },
    });
  });
});
