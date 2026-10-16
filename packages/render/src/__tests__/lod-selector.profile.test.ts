import { describe, expect, it } from 'vitest';
import { projectedHeight, selectLod } from '../scene/visibility/lod-selector';

describe('LOD selector profile evidence', () => {
  it('records stable fixture identity with projected height and selected level', () => {
    const fixture = 'lod-three-level-perspective';
    const build = process.env.FORGEAX_BUILD_ID ?? 'workspace';
    const height = projectedHeight({
      radius: 1,
      depth: 10,
      projection: 'perspective',
      fov: Math.PI / 2,
    });
    const selection = selectLod({
      levels: [{ screenCoverage: 0.5 }, { screenCoverage: 0.2 }],
      projectedHeight: height,
      previousLevel: 0,
      hysteresis: 0.1,
      ready: [true, true, true],
      historyValid: false,
    });

    expect({
      fixture,
      build,
      projectedHeight: Math.round(height * 1e6) / 1e6,
      selectedLevel: selection.level,
    }).toEqual({
      fixture,
      build,
      projectedHeight: 0.2,
      selectedLevel: 1,
    });
  });
});
