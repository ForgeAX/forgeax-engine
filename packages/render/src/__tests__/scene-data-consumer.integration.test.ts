import { describe, expect, it } from 'vitest';
import {
  createSceneDataCatalog,
  type RenderFeatureWorkPlan,
  SCENE_DATA_TEMPORAL_V1_SCHEMA,
  SceneDataUnavailableError,
} from '../index';

const availableOptions = {
  featureIdentity: 'consumer::taa',
  generation: 7,
  planIdentity: 'consumer::taa:7',
  lane: 'direct' as const,
  rgba16floatRenderable: true,
  producerPresent: true,
  coverageComplete: true,
};

describe('public semantic scene-data consumer path', () => {
  it('builds a sampled-only plan from the typed catalog token', () => {
    const catalog = createSceneDataCatalog(availableOptions);
    const target = catalog.require(SCENE_DATA_TEMPORAL_V1_SCHEMA);
    const plan: RenderFeatureWorkPlan = {
      resources: [],
      passes: [
        {
          kind: 'raster',
          name: 'taa-resolve',
          colorAttachments: [{ target: 'swapchain', loadOp: 'load', storeOp: 'store' }],
          sampledTargets: [target],
          draws: [],
        },
      ],
    };

    expect(catalog.validate(target).ok).toBe(true);
    expect(plan.passes[0]).toMatchObject({ sampledTargets: [target] });
    expect(catalog.inspect()).toMatchObject({
      schema: SCENE_DATA_TEMPORAL_V1_SCHEMA,
      status: 'available',
      completeness: 'exact',
    });
    expect(JSON.stringify(plan)).not.toContain('rhi');
  });

  it('returns a bounded structured unavailable error for the recovery path', () => {
    const catalog = createSceneDataCatalog({
      ...availableOptions,
      rgba16floatRenderable: false,
      missingContributorIds: Array.from({ length: 34 }, (_, index) => `producer-${index}`),
    });

    expect(() => catalog.require(SCENE_DATA_TEMPORAL_V1_SCHEMA)).toThrow(SceneDataUnavailableError);
    try {
      catalog.require(SCENE_DATA_TEMPORAL_V1_SCHEMA);
    } catch (error) {
      expect(error).toBeInstanceOf(SceneDataUnavailableError);
      if (error instanceof SceneDataUnavailableError) {
        expect(error.code).toBe('scene-data-unavailable');
        expect(error.detail.reason).toBe('capability-missing');
        expect(error.detail.recovery).toBe('enable-capability');
        expect(error.detail.missingContributorIds).toHaveLength(32);
        expect(error.detail.omittedMissingContributorCount).toBe(2);
      }
    }
  });
});
