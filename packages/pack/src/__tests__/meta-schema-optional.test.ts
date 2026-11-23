import { describe, expect, it } from 'vitest';
import { validateMeta } from '../schema-compiled.js';
import { SCRIPTABLE_PACK_ASSET_KINDS } from '../scriptable-pack.js';

const subAsset = { guid: '00000000-0000-4000-8000-000000000001', sourceIndex: 0 };
const meta = {
  schemaVersion: '1.0.0',
  kind: 'external-asset-package',
  importer: 'image',
  importSettings: {},
  subAssets: [{ ...subAsset, kind: 'texture' }],
};

describe('Meta schema', () => {
  it('accepts both implicit and explicit source paths', () => {
    expect(validateMeta(meta)).toBe(true);
    expect(validateMeta({ ...meta, source: 'foo.png' })).toBe(true);
  });

  it('accepts published kinds, legacy names, and producer extensions', () => {
    const kinds = new Set([
      ...SCRIPTABLE_PACK_ASSET_KINDS,
      'mesh',
      'material',
      'scene',
      'texture',
      'image',
      'cube-texture',
      'material-shader',
      'skeleton',
      'skin',
      'animation-clip',
      'audio',
      'font',
      'reel-game-blob',
    ]);
    for (const kind of kinds) {
      expect(validateMeta({ ...meta, subAssets: [{ ...subAsset, kind }] }), kind).toBe(true);
    }
  });

  it.each([undefined, '', 42])('requires a non-empty string kind (%s)', (kind) => {
    expect(validateMeta({ ...meta, subAssets: [{ ...subAsset, kind }] })).toBe(false);
  });
});
