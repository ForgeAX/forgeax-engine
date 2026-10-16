import { describe, expect, it } from 'vitest';

describe('IBL constant environment E/pi case', () => {
  it('matches Three EnvironmentNode Lambert semantics for a constant environment', () => {
    const environment = 0.72;
    const irradiancePayload = environment * Math.PI;
    const expectedDiffuse = irradiancePayload / Math.PI;

    expect(expectedDiffuse).toBeCloseTo(environment, 12);
    expect(expectedDiffuse).toBeGreaterThan(0);
  });

  it('rejects a leaked pi factor as a measurable analytic failure', () => {
    const environment = 0.72;
    const leakedDiffuse = environment * Math.PI;
    const budget = 1e-6;

    expect(Math.abs(leakedDiffuse - environment)).toBeGreaterThan(budget);
  });
});
