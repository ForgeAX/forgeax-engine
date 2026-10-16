import { describe, expect, expectTypeOf, it } from 'vitest';
import { type GltfMetaJson, reimportReuseMeta } from '../reimport-reuse-meta.js';
import {
  deriveGltfSourceKeys,
  type GltfSourceKeyError,
  type GltfSourceKeyErrorCode,
} from '../source-key.js';

const META_BASE: GltfMetaJson = {
  schemaVersion: 1,
  kind: 'external-asset-package',
  importer: 'gltf',
  source: 'scene.gltf',
  subAssets: [],
  importSettings: {
    defaultSceneIndex: 0,
    diagnostics: { nodeNames: [], unsupportedExtensions: [], matrixTrsCoexistNodes: [] },
  },
};

describe('glTF producer sourceKey', () => {
  it('derives the public error-code alias from its error owner', () => {
    expectTypeOf<GltfSourceKeyErrorCode>().toEqualTypeOf<GltfSourceKeyError['code']>();
  });

  it('derives stable semantic keys without using sourceIndex or locator', () => {
    const result = deriveGltfSourceKeys([
      { kind: 'mesh', sourceIndex: 4, name: 'Hero' },
      { kind: 'material', sourceIndex: 0, name: 'Skin' },
    ]);
    expect(result).toEqual({ ok: true, keys: ['mesh:Hero', 'material:Skin'], conflicts: [] });
  });

  it('reports duplicate semantic names as a structured conflict', () => {
    const result = deriveGltfSourceKeys([
      { kind: 'mesh', sourceIndex: 0, name: 'Hero' },
      { kind: 'mesh', sourceIndex: 1, name: 'Hero' },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('duplicate-source-key');
  });

  it('uses the semantic kind for one anonymous output, never sourceIndex', () => {
    const result = deriveGltfSourceKeys([{ kind: 'mesh', sourceIndex: 7 }]);
    expect(result).toEqual({ ok: true, keys: ['mesh'], conflicts: [] });
  });

  it('persists an output display name in the generated sub-asset entry', () => {
    const result = reimportReuseMeta([{ kind: 'mesh', sourceIndex: 0, name: 'Hero' }], undefined);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.subAssets[0]).toMatchObject({
      kind: 'mesh',
      sourceKey: 'mesh:Hero',
      name: 'Hero',
    });
  });

  it('rejects two anonymous outputs of one kind as ambiguous', () => {
    const result = deriveGltfSourceKeys([
      { kind: 'mesh', sourceIndex: 7 },
      { kind: 'mesh', sourceIndex: 9 },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('ambiguous-source-key');
  });

  it('preserves keyed identity when output order changes', () => {
    const existing: GltfMetaJson = {
      ...META_BASE,
      subAssets: [
        {
          guid: '01928000-7c00-7000-8000-000000000001',
          sourceIndex: 0,
          kind: 'mesh',
          sourceKey: 'mesh:Hero',
        },
        {
          guid: '01928000-7c00-7000-8000-000000000002',
          sourceIndex: 1,
          kind: 'mesh',
          sourceKey: 'mesh:Body',
        },
      ],
    };
    const result = reimportReuseMeta(
      [
        { kind: 'mesh', sourceIndex: 0, name: 'Body' },
        { kind: 'mesh', sourceIndex: 1, name: 'Hero' },
      ],
      existing,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.subAssets).toMatchObject([
      { guid: '01928000-7c00-7000-8000-000000000002', sourceIndex: 0, sourceKey: 'mesh:Body' },
      { guid: '01928000-7c00-7000-8000-000000000001', sourceIndex: 1, sourceKey: 'mesh:Hero' },
    ]);
  });

  it('preserves keyed identity when a new output is inserted', () => {
    const existing: GltfMetaJson = {
      ...META_BASE,
      subAssets: [
        {
          guid: '01928000-7c00-7000-8000-000000000004',
          sourceIndex: 0,
          kind: 'mesh',
          sourceKey: 'mesh:Hero',
        },
        {
          guid: '01928000-7c00-7000-8000-000000000005',
          sourceIndex: 1,
          kind: 'mesh',
          sourceKey: 'mesh:Body',
        },
      ],
    };
    const result = reimportReuseMeta(
      [
        { kind: 'mesh', sourceIndex: 0, name: 'New' },
        { kind: 'mesh', sourceIndex: 1, name: 'Hero' },
        { kind: 'mesh', sourceIndex: 2, name: 'Body' },
      ],
      existing,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.subAssets.slice(1)).toMatchObject([
      { guid: '01928000-7c00-7000-8000-000000000004', sourceKey: 'mesh:Hero' },
      { guid: '01928000-7c00-7000-8000-000000000005', sourceKey: 'mesh:Body' },
    ]);
  });

  it('reuses an anonymous semantic kind key when its sourceIndex changes', () => {
    const existing: GltfMetaJson = {
      ...META_BASE,
      subAssets: [
        {
          guid: '01928000-7c00-7000-8000-000000000003',
          sourceIndex: 0,
          kind: 'scene',
          sourceKey: 'scene',
        },
      ],
    };
    const result = reimportReuseMeta([{ kind: 'scene', sourceIndex: 9 }], existing);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.subAssets).toEqual([
      {
        guid: '01928000-7c00-7000-8000-000000000003',
        sourceIndex: 9,
        kind: 'scene',
        sourceKey: 'scene',
      },
    ]);
  });
});
