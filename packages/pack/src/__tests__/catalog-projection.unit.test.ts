import { describe, expect, it, vi } from 'vitest';
import { projectExternalCatalogEntries, projectRuntimeCatalogRow } from '../catalog-projection.js';
import { projectRuntimePack } from '../runtime-projection.js';

describe('catalog projection admission', () => {
  it('samples a producer name once and preserves its first answer', () => {
    const nameFor = vi.fn().mockReturnValueOnce('first').mockReturnValueOnce('second');
    const rows = projectExternalCatalogEntries(
      { schemaVersion: 3 },
      'source',
      'pack',
      [{ guid: 'asset', kind: 'mesh' }],
      nameFor,
    );
    expect(nameFor).toHaveBeenCalledTimes(1);
    expect(rows[0]?.name).toBe('first');
  });
  it.each([
    'scopeId',
    'generation',
    'digest',
    'outputSetDigest',
  ] as const)('refuses an incomplete %s in both runtime publication projections', (field) => {
    const tuple = { scopeId: 'play', generation: 1, digest: 'pack', outputSetDigest: 'outputs' };
    const incomplete = { ...tuple, [field]: field === 'generation' ? 0 : '' };
    expect(projectRuntimePack({ ...incomplete, assets: [] }).ok).toBe(false);
    expect(
      projectRuntimeCatalogRow({ ...incomplete, guid: 'asset', kind: 'mesh', packageUrl: 'pack' })
        .ok,
    ).toBe(false);
  });
});
