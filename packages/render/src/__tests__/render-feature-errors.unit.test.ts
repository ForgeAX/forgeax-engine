import { describe, expect, it } from 'vitest';
import type {
  RenderError,
  RenderFeatureErrorCode,
  RenderFeatureErrorDescriptor,
  SceneDataUnavailableDetail,
} from '../errors/render';
import { ObservationUnavailableError, SceneDataUnavailableError } from '../errors/render';

const renderFeatureErrorCodes: readonly RenderFeatureErrorCode[] = [
  'render-feature-registration-conflict',
  'render-feature-stage-failed',
  'render-feature-capability-missing',
  'render-feature-pass-order-conflict',
  'render-feature-preparation-failed',
  'render-feature-prepared-state-mismatch',
  'render-feature-draw-recording-failed',
  'render-feature-input-unavailable',
  'render-feature-batch-incomplete',
];

function describeError(error: RenderFeatureErrorDescriptor): string {
  switch (error.code) {
    case 'render-feature-registration-conflict':
      return error.detail.featureIdentity;
    case 'render-feature-stage-failed':
      return `${error.detail.featureIdentity}:${error.detail.stage}`;
    case 'render-feature-capability-missing':
      return error.detail.featureIdentity;
    case 'render-feature-pass-order-conflict':
      return error.detail.featureIdentity;
    case 'render-feature-preparation-failed':
      return error.detail.featureIdentity;
    case 'render-feature-prepared-state-mismatch':
      return error.detail.featureIdentity;
    case 'render-feature-draw-recording-failed':
      return error.detail.featureIdentity;
    case 'render-feature-input-unavailable':
      return error.detail.view;
    case 'render-feature-batch-incomplete':
      return error.detail.missing.join(',');
  }
}

describe('scene-data render error contract', () => {
  it('allows exhaustive handling of scene-data-unavailable', () => {
    const detail: SceneDataUnavailableDetail = {
      featureIdentity: 'taa',
      schema: 'forgeax::scene-data::temporal-v1',
      lane: 'direct',
      reason: 'capability-missing',
      missingContributorIds: [],
      omittedMissingContributorCount: 0,
      recovery: 'next-frame',
    };
    const error = new SceneDataUnavailableError(detail) satisfies RenderError;

    expect(error.code).toBe('scene-data-unavailable');
    switch (error.detail.reason) {
      case 'capability-missing':
      case 'producer-missing':
      case 'coverage-incomplete':
      case 'renderer-recovering':
        expect(error.detail.recovery).toBeTruthy();
        break;
    }
  });
});

describe('render feature error vocabulary', () => {
  it('keeps the feature codes closed and machine-readable', () => {
    expect(renderFeatureErrorCodes).toHaveLength(9);
    expect(describeError).toBeTypeOf('function');
  });

  it('keeps observation recovery structured and producer-owned', () => {
    const error = new ObservationUnavailableError('stale', 'draw a fresh current frame');
    expect(error.code).toBe('observation-unavailable');
    expect(error.expected).toContain('rgba16float');
    expect(error.hint).toContain('fresh');
    expect(error.detail).toEqual({ reason: 'stale', recovery: 'draw-current-frame' });
  });
});
