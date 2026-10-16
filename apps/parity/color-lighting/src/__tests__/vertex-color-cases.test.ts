import { describe, expect, it } from 'vitest';
import {
  VERTEX_COLOR_CASE_IDS,
  VERTEX_COLOR_REQUIRED_CASES,
} from '../coverage/required-cases';

describe('vertex-color parity roster', () => {
  it('freezes the seven required independent cases', () => {
    expect(VERTEX_COLOR_REQUIRED_CASES.map((entry) => entry.caseId)).toEqual([...VERTEX_COLOR_CASE_IDS]);
    expect(VERTEX_COLOR_REQUIRED_CASES).toHaveLength(7);
    for (const entry of VERTEX_COLOR_REQUIRED_CASES) {
      expect(entry.required).toBe(true);
      expect(entry.requiredBackends).toEqual(['browser-webgpu', 'dawn']);
      expect(entry.frameCount).toBe(60);
      expect(entry.epsilon.rgb).toBeLessThanOrEqual(0.05);
      expect(entry.epsilon.alpha).toBeLessThanOrEqual(0.05);
      expect(entry.samplePoints.length).toBeGreaterThan(0);
      expect(entry.samplePoints.every((sample) => sample.coordinate.length === 2)).toBe(true);
    }
  });

  it('requires a content-addressed semantic fixture before a case can execute', () => {
    for (const entry of VERTEX_COLOR_REQUIRED_CASES) {
      expect(entry.sourceFixtureHash, `${entry.caseId} sourceFixtureHash`).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('keeps the no-color case as an absence check, not a white-color substitute', () => {
    const noColor = VERTEX_COLOR_REQUIRED_CASES.find((entry) => entry.caseId === 'vertex-color-no-color-baseline');
    expect(noColor?.falsifier).toBe('no-color-baseline');
  });
});
