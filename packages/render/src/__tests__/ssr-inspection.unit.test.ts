import { describe, expect, it } from 'vitest';
import { admitSsrSpatial, type SsrSpatialEnvironment } from '../ssr/admission';
import {
  projectSsrSpatialInspection,
  SSR_INSPECTION_MAX_PASSES,
  serializeSsrSpatialInspection,
} from '../ssr/inspection';

const camera = {
  projection: 'perspective' as const,
  near: 0.1,
  far: 100,
  screenSpaceReflection: { maxDistance: 40, thickness: 0.2, maxRoughness: 0.6 },
};

const environment: SsrSpatialEnvironment = {
  lane: 'deferred',
  m0: { status: 'admitted' },
  sceneInputs: true,
  temporal: true,
  reflectionFallback: true,
  capabilities: {
    compute: true,
    storageTexture: true,
    rgba16floatRenderable: true,
    r32floatSampledStorage: true,
  },
};

describe('SSR bounded spatial inspection', () => {
  it('detaches admitted facts and remains serializable without live handles', () => {
    const admission = admitSsrSpatial({ camera, environment });
    const inspection = projectSsrSpatialInspection(admission);
    expect(inspection.status).toBe('admitted');
    expect(inspection.coverage).toEqual({
      hitCount: null,
      fallbackCount: null,
      excludedCount: null,
    });
    expect(inspection.history).toEqual({ state: 'not-owned', bytes: 0, resetCount: 0 });
    expect(inspection.passRoster).toEqual([]);
    expect(JSON.parse(serializeSsrSpatialInspection(inspection))).toEqual(inspection);
  });

  it('projects unavailable reason and exact zero work', () => {
    const admission = admitSsrSpatial({
      camera,
      environment: { ...environment, lane: 'direct' },
    });
    const inspection = projectSsrSpatialInspection(admission);
    expect(inspection.status).toBe('fallback-only');
    expect(inspection.work).toEqual({
      attachmentCount: 0,
      passCount: 0,
      bindingCount: 0,
      resourceCount: 0,
      historyCount: 0,
      temporalDemand: 0,
    });
    expect(inspection.failure).toMatchObject({ detail: { reason: 'lane-unsupported' } });
  });

  it('accepts only detached execution enrichment', () => {
    const admission = admitSsrSpatial({ camera, environment });
    const inspection = projectSsrSpatialInspection(admission, {
      status: 'structural-only',
      history: { state: 'stable', bytes: 128, resetCount: 2 },
      passRoster: ['depth-pyramid-seed', 'ssr-trace', 'ssr-compose'],
      fallbackSource: 'probe',
      coverage: { hitCount: 3, fallbackCount: 1, excludedCount: 2 },
    });
    expect(inspection).toMatchObject({
      status: 'structural-only',
      history: { state: 'stable', bytes: 128, resetCount: 2 },
      coverage: { hitCount: 3, fallbackCount: 1, excludedCount: 2 },
      passRoster: ['depth-pyramid-seed', 'ssr-trace', 'ssr-compose'],
      fallbackSource: 'probe',
    });
    expect(Object.isFrozen(inspection)).toBe(true);
    expect(Object.isFrozen(inspection.history)).toBe(true);
    expect(Object.isFrozen(inspection.passRoster)).toBe(true);
  });

  it('caps pass names and rejects non-finite or fractional counters', () => {
    const admission = admitSsrSpatial({ camera, environment });
    const passRoster = Array.from(
      { length: SSR_INSPECTION_MAX_PASSES + 8 },
      (_, index) => `ssr-pass-${index}`,
    );
    const inspection = projectSsrSpatialInspection(admission, { passRoster });
    expect(inspection.passRoster).toHaveLength(SSR_INSPECTION_MAX_PASSES);
    expect(passRoster).toHaveLength(SSR_INSPECTION_MAX_PASSES + 8);
    expect(() =>
      projectSsrSpatialInspection(admission, { coverage: { hitCount: Number.NaN } }),
    ).toThrow('coverage.hitCount');
    expect(() =>
      projectSsrSpatialInspection(admission, { coverage: { fallbackCount: 1.5 } }),
    ).toThrow('coverage.fallbackCount');
    expect(() =>
      projectSsrSpatialInspection(admission, {
        history: { state: 'stable', bytes: -1, resetCount: 0 },
      }),
    ).toThrow('history.bytes');
  });
});
