import { describe, expect, it } from 'vitest';
import {
  createSceneDataCatalog,
  SCENE_DATA_TEMPORAL_V1_SCHEMA,
} from '../temporal/scene-data-catalog';

describe('SceneDataCatalog authorization', () => {
  it('issues a frozen sampled-read token for the active plan generation', () => {
    const catalog = createSceneDataCatalog({
      featureIdentity: 'taa',
      generation: 7,
      planIdentity: 'plan-7',
      rgba16floatRenderable: true,
    });
    const result = catalog.require(SCENE_DATA_TEMPORAL_V1_SCHEMA);
    expect(Object.isFrozen(result)).toBe(true);
    expect(result).toMatchObject({
      kind: 'scene-data',
      schema: SCENE_DATA_TEMPORAL_V1_SCHEMA,
      access: 'sampled-read',
      format: 'rgba16float',
      sampleCount: 1,
      extent: 'render-resolution',
    });
    expect(catalog.validate(result).ok).toBe(true);
  });

  it('rejects forged, stale, foreign, and write-shaped tokens', () => {
    const catalog = createSceneDataCatalog({
      featureIdentity: 'taa',
      generation: 7,
      planIdentity: 'plan-7',
      rgba16floatRenderable: true,
    });
    const foreign = createSceneDataCatalog({
      featureIdentity: 'motion-blur',
      generation: 7,
      planIdentity: 'plan-7',
      rgba16floatRenderable: true,
    });
    const issued = catalog.require(SCENE_DATA_TEMPORAL_V1_SCHEMA);

    expect(foreign.validate(issued).ok).toBe(false);
    expect(catalog.validate({ ...issued }).ok).toBe(false);
    expect(catalog.validate({ ...issued, access: 'write' } as never).ok).toBe(false);
    expect(catalog.validate(issued, 8).ok).toBe(false);
  });

  it('reports capability absence without issuing a physical target', () => {
    const catalog = createSceneDataCatalog({
      featureIdentity: 'taa',
      generation: 7,
      planIdentity: 'plan-7',
      rgba16floatRenderable: false,
    });
    expect(() => catalog.require(SCENE_DATA_TEMPORAL_V1_SCHEMA)).toThrow();
    expect(catalog.inspect().status).toBe('unavailable');
  });
});
