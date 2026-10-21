// Scene child provenance derives from component schemas and the owning source references.

import { type Component, defineComponent } from '@forgeax/engine-ecs';
import type { Asset, SceneAsset } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { AssetRegistry } from '../asset-registry';
import { createCatalogSource } from '../catalog-source';
import { buildSceneChildContext, createSceneChildContextLookup } from '../registry/instantiate';
import * as sceneHandleFields from '../scene-handle-fields';

const T709CtxMeshFilter = defineComponent('T709CtxMeshFilter', {
  assetHandle: 'asset<mesh>',
});

function makeRegistry(includeMaterials = false): AssetRegistry {
  return new AssetRegistry({
    shaderRegistry: {
      getMaterialShaderManifest: vi.fn().mockReturnValue(undefined),
      findMaterialArtifact: vi.fn().mockReturnValue({ ok: false, error: new Error('mock') }),
      getPipeline: vi.fn().mockReturnValue(undefined),
      installMaterialArtifact: vi.fn(),
      inspect: vi.fn().mockReturnValue({ materialShaders: [] }),
    } as unknown as import('@forgeax/engine-shader').ShaderRegistry,
    components: new Map<string, Component>([
      [T709CtxMeshFilter.name, T709CtxMeshFilter],
      ...(includeMaterials ? [[T709CtxMaterials.name, T709CtxMaterials] as const] : []),
    ]),
  });
}

const SUB_GUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function sceneWithMeshRef(): Asset & { kind: 'scene' } {
  return {
    kind: 'scene',
    entities: { 'entity-7': { components: { T709CtxMeshFilter: { assetHandle: SUB_GUID } } } },
  } as unknown as Asset & { kind: 'scene' };
}

describe('buildSceneChildContext', () => {
  it('recovers entityKey + component.field via the entity walk fallback', () => {
    const reg = makeRegistry();
    const ctx = buildSceneChildContext(reg, sceneWithMeshRef(), SUB_GUID.toLowerCase());
    expect(ctx?.sceneEntityKey).toBe('entity-7');
    expect(ctx?.componentField).toBe('T709CtxMeshFilter.assetHandle');
    expect(ctx?.sourceField).toMatchObject({
      componentName: 'T709CtxMeshFilter',
      fieldName: 'assetHandle',
    });
  });

  it('returns undefined when the sub-asset GUID is not referenced by any entity', () => {
    const reg = makeRegistry();
    const ctx = buildSceneChildContext(
      reg,
      sceneWithMeshRef(),
      'ffffffff-ffff-4fff-8fff-ffffffffffff',
    );
    expect(ctx).toBeUndefined();
  });
});

const SCENE_GUID = '11111111-1111-4111-8111-111111111111';
const OTHER_SCENE_GUID = '22222222-2222-4222-8222-222222222222';
const ARRAY_GUID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TEXTURE_GUID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const T709CtxMaterials = defineComponent('T709CtxMaterials', {
  materials: 'array<asset<material>>',
});

describe('per-load scene child context lookup', () => {
  it('keeps first case-folded duplicate and exact array provenance with one extraction', () => {
    const registry = makeRegistry(true);
    const scene = {
      kind: 'scene' as const,
      entities: {
        first: { components: { T709CtxMeshFilter: { assetHandle: SUB_GUID.toUpperCase() } } },
        second: {
          components: { T709CtxMaterials: { materials: [SUB_GUID, 17, ARRAY_GUID] } },
        },
      },
    };
    const extract = vi.spyOn(sceneHandleFields, 'extractSceneEntityHandleGuids');
    try {
      const lookup = createSceneChildContextLookup(registry, scene);
      expect(lookup(SUB_GUID)).toEqual(buildSceneChildContext(registry, scene, SUB_GUID));
      expect(lookup(ARRAY_GUID)).toEqual({
        sceneEntityKey: 'second',
        componentField: 'T709CtxMaterials.materials[2]',
        sourceField: { componentName: 'T709CtxMaterials', fieldName: 'materials', arrayIndex: 2 },
      });
      expect(lookup(SUB_GUID)?.sceneEntityKey).toBe('first');
      expect(lookup(TEXTURE_GUID)).toBeUndefined();
      // One cached traversal plus the deliberately uncached public comparison.
      expect(extract).toHaveBeenCalledTimes(2);
    } finally {
      extract.mockRestore();
    }
  });

  it('decodes the owning Catalog reference indices with exact component provenance', async () => {
    const registry = makeRegistry(true);
    registry.setCatalogSource(
      createCatalogSource({
        entries: [
          {
            guid: SCENE_GUID,
            kind: 'scene',
            packageUrl: '/scene.pack.json',
            refs: [SUB_GUID.toUpperCase(), ARRAY_GUID],
          },
          {
            guid: OTHER_SCENE_GUID,
            kind: 'scene',
            packageUrl: '/other.pack.json',
            refs: [TEXTURE_GUID],
          },
        ],
      }),
    );
    (await registry.enumerateCatalog()).unwrap();
    const scene = {
      kind: 'scene' as const,
      entities: {
        object: {
          components: {
            T709CtxMeshFilter: { assetHandle: 0 },
            T709CtxMaterials: { materials: [1] },
          },
        },
      },
    };
    const lookup = createSceneChildContextLookup(registry, scene);
    expect(lookup(SUB_GUID, SCENE_GUID)).toMatchObject({
      sceneEntityKey: 'object',
      componentField: 'T709CtxMeshFilter.assetHandle',
    });
    expect(lookup(ARRAY_GUID, SCENE_GUID)).toEqual({
      sceneEntityKey: 'object',
      componentField: 'T709CtxMaterials.materials[0]',
      sourceField: {
        componentName: 'T709CtxMaterials',
        fieldName: 'materials',
        arrayIndex: 0,
      },
    });
    expect(lookup(TEXTURE_GUID, SCENE_GUID)).toBeUndefined();
  });

  it('reports only references present in component fields, even if the Catalog lists more dependencies', async () => {
    const registry = makeRegistry();
    registry.setCatalogSource(
      createCatalogSource({
        entries: [
          {
            guid: SCENE_GUID,
            kind: 'scene',
            packageUrl: '/scene.pack.json',
            refs: [SUB_GUID, TEXTURE_GUID],
          },
        ],
      }),
    );
    (await registry.enumerateCatalog()).unwrap();
    const lookup = createSceneChildContextLookup(registry, sceneWithMeshRef());
    expect(lookup(SUB_GUID, SCENE_GUID)?.sceneEntityKey).toBe('entity-7');
    expect(lookup(TEXTURE_GUID, SCENE_GUID)).toBeUndefined();
  });

  it('does not search another Scene source to decode an unowned index', async () => {
    const registry = makeRegistry();
    registry.setCatalogSource(
      createCatalogSource({
        entries: [
          {
            guid: OTHER_SCENE_GUID,
            kind: 'scene',
            packageUrl: '/other.pack.json',
            refs: [TEXTURE_GUID],
          },
          { guid: SCENE_GUID, kind: 'scene', packageUrl: '/scene.pack.json', refs: [] },
        ],
      }),
    );
    (await registry.enumerateCatalog()).unwrap();
    const scene = {
      kind: 'scene' as const,
      entities: { object: { components: { T709CtxMeshFilter: { assetHandle: 0 } } } },
    };
    const lookup = createSceneChildContextLookup(registry, scene);
    expect(lookup(TEXTURE_GUID, SCENE_GUID)).toBeUndefined();
    expect(createSceneChildContextLookup(registry, scene)(TEXTURE_GUID)).toBeUndefined();
  });

  it('has no cross-load or public-call cache after payload changes', () => {
    const registry = makeRegistry();
    const scene: { kind: 'scene'; entities: SceneAsset['entities'] } = sceneWithMeshRef();
    expect(createSceneChildContextLookup(registry, scene)(SUB_GUID)?.sceneEntityKey).toBe(
      'entity-7',
    );
    scene.entities = { next: { components: { T709CtxMeshFilter: { assetHandle: ARRAY_GUID } } } };
    expect(createSceneChildContextLookup(registry, scene)(SUB_GUID)).toBeUndefined();
    expect(buildSceneChildContext(registry, scene, ARRAY_GUID)?.sceneEntityKey).toBe('next');
    scene.entities = {};
    expect(buildSceneChildContext(registry, scene, ARRAY_GUID)).toBeUndefined();
  });

  it('propagates extraction errors and never caches a partially built fallback index', () => {
    const registry = makeRegistry();
    const scene = sceneWithMeshRef();
    const error = new Error('origin extraction failed');
    const extract = vi
      .spyOn(sceneHandleFields, 'extractSceneEntityHandleGuids')
      .mockImplementation(() => {
        throw error;
      });
    try {
      const lookup = createSceneChildContextLookup(registry, scene);
      expect(() => lookup(SUB_GUID)).toThrow(error);
      expect(() => lookup(SUB_GUID)).toThrow(error);
      expect(extract).toHaveBeenCalledTimes(2);
    } finally {
      extract.mockRestore();
    }
  });
});
