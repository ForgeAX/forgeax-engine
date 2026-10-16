import { describe, expect, it } from 'vitest';
import { createLightResourceUnavailable } from '../errors/render';
import { projectLightInspection } from '../inspection-types';
import {
  createExtendedLightingState,
  projectExtendedLightingInspection,
  recordExtendedLightingFailure,
} from '../prepare/extended-lighting/state';

describe('light inspection projection', () => {
  it('returns readonly POD state and generation-deduped failures', () => {
    const inspection = projectLightInspection({
      generation: 5,
      candidate: 'loading',
      accepted: 'ready',
      lastKnownGood: 'ready',
      failure: undefined,
      failureKeys: ['cookie:5'],
      resourceCount: 3,
      uploadBytes: 128,
    });
    expect(inspection).toEqual({
      generation: 5,
      candidate: 'loading',
      accepted: 'ready',
      lastKnownGood: 'ready',
      failure: undefined,
      failureKeys: ['cookie:5'],
      resourceCount: 3,
      uploadBytes: 128,
    });
    expect(Object.isFrozen(inspection)).toBe(true);
  });

  it('deduplicates one structured failure per entity, feature, and generation', () => {
    const state = createExtendedLightingState(5);
    const failure = createLightResourceUnavailable({
      entity: 7,
      feature: 'cookie',
      generation: 5,
      sourceKey: 'cookie-four-quadrants',
      reason: 'format',
      expected: 'rgba8unorm',
      actual: 'rgba16float',
      hint: 'repair the source and retry the same GUID',
    });

    const recorded = recordExtendedLightingFailure(state, failure);
    expect(recordExtendedLightingFailure(recorded, failure)).toBe(recorded);
    expect(projectExtendedLightingInspection(recorded)).toMatchObject({
      failure: 'light-resource-unavailable',
      failureKeys: ['7:cookie:5'],
    });
  });
});
