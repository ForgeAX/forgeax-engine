import { describe, expect, it } from 'vitest';
import { type ExistingExternalAssetPackage, reimportReuseMeta } from '../reimport-reuse-meta.js';
import { deriveImageSourceKey } from '../source-key.js';
import { subAssetKey } from '../sub-asset-key.js';

const GUID = '01928000-7c00-7000-8000-000000000042';

function existing(): ExistingExternalAssetPackage {
  return {
    schemaVersion: '1.0.0',
    kind: 'external-asset-package',
    importer: 'image',
    source: 'renamed.png',
    importSettings: {},
    subAssets: [{ guid: GUID, sourceIndex: 0, kind: 'texture', sourceKey: 'image:texture' }],
  };
}

describe('image producer sourceKey', () => {
  it('uses a role key independent of path and sourceIndex', () => {
    expect(deriveImageSourceKey('texture')).toBe('image:texture');
    expect(deriveImageSourceKey('texture', { sourcePath: 'moved/wood.png', sourceIndex: 8 })).toBe(
      'image:texture',
    );
  });

  it('rejects an empty role instead of manufacturing an index key', () => {
    expect(deriveImageSourceKey('')).toBeUndefined();
  });

  it('keeps legacy indexFallback separate from producer sourceKey', () => {
    expect(subAssetKey({ kind: 'texture', sourceIndex: 0 })).toEqual({
      kind: 'texture',
      indexFallback: 'textures/0',
    });
    expect(deriveImageSourceKey('texture')).not.toContain('0');
  });

  it('reuses identity after source relocation while emitting the role key', () => {
    const result = reimportReuseMeta(existing());
    expect(result[0]).toMatchObject({ guid: GUID, sourceIndex: 0, sourceKey: 'image:texture' });
  });
  it('preserves source-order precedence between legacy and semantic identity matches', () => {
    const meta = existing();
    const legacy = { guid: GUID, kind: 'texture', sourceIndex: 0 };
    const semantic = {
      guid: '01928000-7c00-7000-8000-000000000043',
      kind: 'texture',
      sourceIndex: 9,
      sourceKey: 'image:texture',
    };
    expect(reimportReuseMeta({ ...meta, subAssets: [legacy, semantic] })[0]?.guid).toBe(
      legacy.guid,
    );
    expect(reimportReuseMeta({ ...meta, subAssets: [semantic, legacy] })[0]?.guid).toBe(
      semantic.guid,
    );
  });

  it('does not reuse a named legacy locator without the semantic source identity', () => {
    const meta = {
      ...existing(),
      subAssets: [{ guid: GUID, kind: 'texture', sourceIndex: 0, name: 'Other' }],
    };
    expect(reimportReuseMeta(meta)[0]?.guid).not.toBe(GUID);
  });
});
