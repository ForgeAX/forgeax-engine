import { describe, expect, it } from 'vitest';
import { projectFbxLodMeta } from '../lod/project-meta.js';

describe('FBX LOD Meta publication candidate', () => {
  it('materializes shared default screen coverage from level count', () => {
    const result = projectFbxLodMeta({
      rootSourceKey: 'mesh/root',
      levels: [
        { sourceKey: 'mesh/lod1', guid: '019e3969-1d48-7c3b-ac24-6d68f4570651' },
        { sourceKey: 'mesh/lod2', guid: '019e3969-1d48-7c3b-ac24-6d68f4570652' },
      ],
    });
    expect(result).toMatchObject({
      ok: true,
      value: { lods: [{ screenCoverage: 0.5 }, { screenCoverage: 0.2 }] },
    });
  });
});
