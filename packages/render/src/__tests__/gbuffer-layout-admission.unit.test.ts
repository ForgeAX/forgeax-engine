import { createStandardPbrArtifactReceipt } from '@forgeax/engine-shader';
import { describe, expect, it } from 'vitest';
import { requireStandardGBufferReceipt } from '../material-program-inputs';
import {
  SCENE_DATA_STANDARD_GBUFFER_NORMAL_V2_SCHEMA,
  SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA,
} from '../temporal/scene-data';
import { createSceneDataCatalog } from '../temporal/scene-data-catalog';

describe('versioned Standard GBuffer admission', () => {
  it('refuses a cold legacy writer even when its ordinary Standard ABI is valid', () => {
    const old = JSON.parse(JSON.stringify(createStandardPbrArtifactReceipt()));
    delete old.gbuffer;
    expect(() => requireStandardGBufferReceipt(old)).toThrow(
      /producer-certified standard-gbuffer\/2/,
    );
    expect(() => requireStandardGBufferReceipt(undefined)).toThrow(/producer-certified/);
    expect(() =>
      requireStandardGBufferReceipt({ ...old, gbuffer: 'standard-gbuffer/1' }),
    ).toThrow();
    expect(() =>
      requireStandardGBufferReceipt({ ...old, gbuffer: 'standard-gbuffer/2' }),
    ).not.toThrow();
  });

  it.each([
    'forward',
    'deferred',
  ] as const)('publishes only the actual %s normal schema', (renderPath) => {
    const catalog = createSceneDataCatalog({
      featureIdentity: 'test',
      viewIdentity: 'view',
      generation: 1,
      deviceGeneration: 2,
      planIdentity: 'test:view:1',
      rgba16floatRenderable: true,
      surfaceAdmission: {
        identity: 'surface',
        viewIdentity: 'view',
        generation: 1,
        deviceGeneration: 2,
        lane: 'direct',
        renderPath,
        status: 'available',
        missingContributorIds: [],
        producer:
          renderPath === 'deferred' ? 'standard-deferred-gbuffer' : 'standard-forward-surface-pass',
      },
    });
    const requested =
      renderPath === 'deferred'
        ? SCENE_DATA_STANDARD_GBUFFER_NORMAL_V2_SCHEMA
        : SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA;
    const other =
      renderPath === 'deferred'
        ? SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA
        : SCENE_DATA_STANDARD_GBUFFER_NORMAL_V2_SCHEMA;
    const token = catalog.require(requested);
    expect(token.schema).toBe(requested);
    expect(token.format).toBe(renderPath === 'deferred' ? 'rg32uint' : 'r32uint');
    expect(catalog.validate(token).ok).toBe(true);
    expect(catalog.availabilityFor(other)).toMatchObject({
      status: 'unavailable',
      reason: 'producer-missing',
    });
    expect(() => catalog.require(other)).toThrow();
  });
});
