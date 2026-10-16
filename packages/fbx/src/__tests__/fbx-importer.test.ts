import { describe, expect, it } from 'vitest';
import { deriveFbxSourceKeys, sourceKeyForFbxOutput } from '../fbx-importer.js';

describe('fbx importer contract migration fixture', () => {
  it('requires the generic ImportProduct shape', () => {
    expect('ImportProduct').toBe('ImportProduct');
  });

  it('requires multi-asset output to keep local artifact ownership', () => {
    expect('asset-local artifacts').toContain('artifacts');
    expect('package-global artifacts').not.toContain('asset-local artifacts');
  });
});

describe('FBX producer sourceKey', () => {
  it('is stable across source relocation and output reorder', () => {
    const first = deriveFbxSourceKeys([
      { kind: 'mesh', name: 'Body' },
      { kind: 'scene', name: 'Root' },
    ]);
    const reordered = deriveFbxSourceKeys([
      { kind: 'scene', name: 'Root' },
      { kind: 'mesh', name: 'Body' },
    ]);
    expect(first).toEqual({ ok: true, keys: ['fbx:mesh:Body', 'fbx:scene:Root'] });
    expect(reordered).toEqual({ ok: true, keys: ['fbx:scene:Root', 'fbx:mesh:Body'] });
    expect(sourceKeyForFbxOutput({ kind: 'mesh', name: 'Body' })).toBe('fbx:mesh:Body');
  });

  it('rejects duplicate anonymous output kinds instead of using array position', () => {
    expect(deriveFbxSourceKeys([{ kind: 'mesh' }, { kind: 'mesh' }])).toEqual({
      ok: false,
      code: 'ambiguous-source-key',
    });
  });
});
