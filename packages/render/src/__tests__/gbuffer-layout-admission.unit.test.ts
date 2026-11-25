import { createStandardPbrArtifactReceipt } from '@forgeax/engine-shader';
import { describe, expect, it } from 'vitest';
import { requireStandardGBufferReceipt } from '../material-program-inputs';
import {
  SCENE_DATA_STANDARD_GBUFFER_NORMAL_V2_SCHEMA,
  SCENE_DATA_STANDARD_SURFACE_DEPTH_V1_SCHEMA,
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

  it('requires the compact writer certificate independently of the full-layout writer', () => {
    const full = createStandardPbrArtifactReceipt();
    expect(() => requireStandardGBufferReceipt(full)).not.toThrow();
    expect(() => requireStandardGBufferReceipt(full, true)).toThrow(/standard-gbuffer\/4/);
    expect(() =>
      requireStandardGBufferReceipt({ ...full, compactGbuffer: 'standard-gbuffer/4' }, true),
    ).not.toThrow();
  });

  it.each([
    'forward',
    'deferred',
  ] as const)('publishes supported %s surface schemas and rejects the retired Forward normal schema', (renderPath) => {
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
    const depth = catalog.require(SCENE_DATA_STANDARD_SURFACE_DEPTH_V1_SCHEMA);
    expect(depth.format).toBe('depth32float-stencil8');
    expect(catalog.validate(depth).ok).toBe(true);
    const unavailable = { status: 'unavailable', reason: 'producer-missing' };
    const gbuffer = SCENE_DATA_STANDARD_GBUFFER_NORMAL_V2_SCHEMA;
    if (renderPath === 'deferred') {
      const token = catalog.require(gbuffer);
      expect(token.format).toBe('rg32uint');
      expect(catalog.validate(token).ok).toBe(true);
    } else {
      expect(catalog.availabilityFor(gbuffer)).toEqual(unavailable);
      expect(() => catalog.require(gbuffer)).toThrow();
    }
    const retired = SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA;
    expect(catalog.availabilityFor(retired)).toEqual(unavailable);
    expect(() => catalog.require(retired)).toThrow();
  });
});
