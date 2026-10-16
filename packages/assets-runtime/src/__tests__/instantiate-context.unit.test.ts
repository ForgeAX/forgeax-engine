// @forgeax/engine-assets-runtime -- buildSceneChildContext coverage (fix issue
// #709). The breadcrumb-provenance resolver walks the recursing scene's
// envelope.refs edges (prod) or falls back to the entity component walk (dev
// catalog()) to recover the (entityKey, component.field) path for a sub-asset
// GUID. Driven through an AssetRegistry with a mock ShaderRegistry.

import { type Component, defineComponent } from '@forgeax/engine-ecs';
import type { Asset, SceneAsset } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { AssetRegistry } from '../asset-registry';
import { buildSceneChildContext, createSceneChildContextLookup } from '../registry/instantiate';
import * as sceneHandleFields from '../scene-handle-fields';

const T709CtxMeshFilter = defineComponent('T709CtxMeshFilter', {
  assetHandle: 'shared<MeshAsset>',
});

function makeRegistry(includeMaterials = false): AssetRegistry {
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
    undefined,
    undefined,
    new Map<string, Component>([
      [T709CtxMeshFilter.name, T709CtxMeshFilter],
      ...(includeMaterials ? [[T709CtxMaterials.name, T709CtxMaterials] as const] : []),
    ]),
  );
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
  materials: 'array<shared<MaterialAsset>>',
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

  it('selects own rich envelope before legacy scene without extracting payload fields', () => {
    const registry = makeRegistry();
    const scene = sceneWithMeshRef();
    expect(
      registry.catalog(OTHER_SCENE_GUID, scene, [
        {
          guid: SUB_GUID,
          sceneEntityKey: 'legacy',
          sourceField: { componentName: 'Old', fieldName: 'mesh' },
        },
      ]).ok,
    ).toBe(true);
    const sourceField = { componentName: 'Own', fieldName: 'items', arrayIndex: 4 };
    expect(
      registry.catalog(SCENE_GUID, scene, [{ guid: SUB_GUID.toUpperCase(), sourceField }]).ok,
    ).toBe(true);
    const extract = vi.spyOn(sceneHandleFields, 'extractSceneEntityHandleGuids');
    try {
      const lookup = createSceneChildContextLookup(registry, scene);
      expect(lookup(SUB_GUID, SCENE_GUID)).toEqual({ componentField: 'Own.items[4]', sourceField });
      expect(lookup(SUB_GUID)).toEqual({
        sceneEntityKey: 'legacy',
        componentField: 'Old.mesh',
        sourceField: { componentName: 'Old', fieldName: 'mesh' },
      });
      expect(extract).not.toHaveBeenCalled();
    } finally {
      extract.mockRestore();
    }
  });

  it('retains texture empty-defined versus missing undefined and incomplete sourceField', () => {
    const registry = makeRegistry();
    const scene = sceneWithMeshRef();
    const sourceField = { fieldName: 'texture' };
    expect(
      registry.catalog(SCENE_GUID, scene, [
        { guid: TEXTURE_GUID },
        { guid: ARRAY_GUID, sourceField },
      ]).ok,
    ).toBe(true);
    const lookup = createSceneChildContextLookup(registry, scene);
    expect(lookup(TEXTURE_GUID, SCENE_GUID)).toEqual({});
    expect(lookup(ARRAY_GUID, SCENE_GUID)).toEqual({ sourceField });
    expect(lookup(OTHER_SCENE_GUID, SCENE_GUID)).toBeUndefined();
    expect(lookup(SUB_GUID, SCENE_GUID)).toEqual(
      buildSceneChildContext(registry, scene, SUB_GUID, SCENE_GUID),
    );
  });

  it('does not substitute a legacy envelope when the own scene has no refs', () => {
    const registry = makeRegistry();
    const scene = sceneWithMeshRef();
    expect(registry.catalog(OTHER_SCENE_GUID, scene, [{ guid: TEXTURE_GUID }]).ok).toBe(true);
    expect(registry.catalog(SCENE_GUID, scene, []).ok).toBe(true);
    const lookup = createSceneChildContextLookup(registry, scene);
    expect(lookup(TEXTURE_GUID, SCENE_GUID)).toBeUndefined();
    expect(lookup(TEXTURE_GUID)).toEqual({});
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
