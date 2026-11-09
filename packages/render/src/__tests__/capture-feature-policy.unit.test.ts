import { describe, expect, it } from 'vitest';
import { featureRecordsInCapture } from '../capture/feature-policy';

describe('feature capture policy', () => {
  it('defaults to display-only', () => {
    expect(featureRecordsInCapture(undefined, 'planar')).toBe(false);
  });
  it('all admits every face kind', () => {
    for (const k of ['planar', 'probe', 'cube'] as const) {
      expect(featureRecordsInCapture('all', k)).toBe(true);
    }
  });
  it('face list admits only listed kinds', () => {
    expect(featureRecordsInCapture({ faces: ['planar'] }, 'planar')).toBe(true);
    expect(featureRecordsInCapture({ faces: ['planar'] }, 'cube')).toBe(false);
  });
});
