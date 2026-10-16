import { describe, expect, it } from 'vitest';
import {
  createLightResourceUnavailable,
  type LightResourceFailureReason,
  LightResourceUnavailableError,
} from '../errors/render';

describe('light resource unavailable error', () => {
  it('keeps a closed, property-addressable detail', () => {
    const reasons: LightResourceFailureReason[] = ['asset', 'format', 'capability', 'capacity'];
    for (const reason of reasons) {
      const error = createLightResourceUnavailable({
        entity: 7,
        feature: 'cookie',
        generation: 4,
        sourceKey: 'cookie-four-quadrants',
        reason,
        expected: 'accepted uploaded resource',
        actual: 'missing',
        hint: 'retry the same GUID after producer recovery',
      });
      expect(error).toBeInstanceOf(LightResourceUnavailableError);
      expect(error.code).toBe('light-resource-unavailable');
      expect(error.detail.reason).toBe(reason);
      expect(error.hint).toContain('retry');
    }
  });

  it('does not make recovery consumers parse the message', () => {
    const error = createLightResourceUnavailable({
      entity: 1,
      feature: 'ies',
      generation: 2,
      sourceKey: 'ies-asymmetric',
      reason: 'capacity',
      expected: 'slice <= 32',
      actual: '33',
      hint: 'repair capacity and retry the same GUID',
    });
    expect(error.detail.sourceKey).toBe('ies-asymmetric');
    expect(error.detail.generation).toBe(2);
  });
});
