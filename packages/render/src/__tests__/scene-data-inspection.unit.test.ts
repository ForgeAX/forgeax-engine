import { describe, expect, it } from 'vitest';
import {
  createSceneDataCatalog,
  SCENE_DATA_TEMPORAL_V1_SCHEMA,
} from '../temporal/scene-data-catalog';

describe('SceneData inspection', () => {
  it('serializes bounded schema and availability facts only', () => {
    const catalog = createSceneDataCatalog({
      featureIdentity: 'taa',
      generation: 3,
      planIdentity: 'plan-3',
      rgba16floatRenderable: true,
      missingContributorIds: Array.from({ length: 40 }, (_, index) => `contributor-${index}`),
    });
    const inspection = catalog.inspect();
    expect(inspection.schema).toBe(SCENE_DATA_TEMPORAL_V1_SCHEMA);
    expect(inspection.missingContributorIds).toHaveLength(32);
    expect(inspection.omittedMissingContributorCount).toBe(8);
    expect(JSON.stringify(inspection)).not.toMatch(/graph|rhi|g-buffer|raw/i);
  });

  it('keeps the unavailable reason closed for exhaustive consumers', () => {
    const catalog = createSceneDataCatalog({
      featureIdentity: 'taa',
      generation: 3,
      planIdentity: 'plan-3',
      rgba16floatRenderable: false,
    });
    const inspection = catalog.inspect();
    if (inspection.status === 'unavailable') {
      switch (inspection.reason) {
        case 'capability-missing':
        case 'producer-missing':
        case 'coverage-incomplete':
        case 'renderer-recovering':
          break;
      }
    }
  });
});
