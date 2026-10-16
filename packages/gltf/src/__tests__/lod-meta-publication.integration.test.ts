import { describe, expect, it } from 'vitest';
import { projectGltfLodMeta } from '../lod/project-meta.js';

describe('glTF LOD Meta publication candidate', () => {
  it('uses declared GUIDs and leaves publication to the shared host', () => {
    const result = projectGltfLodMeta({
      rootSourceKey: 'mesh/root',
      levels: [
        { sourceKey: 'mesh/lod1', guid: 'guid-1' },
        { sourceKey: 'mesh/lod2', guid: 'guid-2' },
      ],
      previous: undefined,
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        lods: [
          { meshGuid: 'guid-1', screenCoverage: 0.5 },
          { meshGuid: 'guid-2', screenCoverage: 0.2 },
        ],
      },
    });
  });
});
