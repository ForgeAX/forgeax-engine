import { describe, expect, it } from 'vitest';
import { buildThreeLightProbeSh } from '../lighting-reference';
import { constantProbeSh, evaluateProbeReference, PROBE_REFERENCE_R_MIN, type ProbeReferenceInput } from '../probe-reference';

const sky = [0.7, 0.4, 0.2] as const;
const redProbe: ProbeReferenceInput = {
  identity: 'red',
  position: [0, 0, 0],
  radius: 2,
  irradiance: constantProbeSh([2, 0, 0]),
};
const blueProbe: ProbeReferenceInput = {
  identity: 'blue',
  position: [1, 0, 0],
  radius: 4,
  irradiance: constantProbeSh([0, 0, 2]),
};

describe('independent finite-volume probe reference', () => {
  it('rejects the exact radius boundary and uses the true Sky residual', () => {
    const result = evaluateProbeReference({ objectKey: 'boundary', position: [2, 0, 0], normal: [0, 0, 1], skyIrradiance: sky }, [redProbe]);
    expect(result.terms[0]).toMatchObject({ active: false, c: 0, scaledQ: 0, alpha: 0 });
    expect(result.Q).toBe(0);
    expect(result.C).toBe(0);
    expect(result.S).toBe(1);
    expect(result.trueE_skyResidual).toEqual(sky);
    expect(result.diffuse).toEqual(sky);
  });

  it('computes all active contributors with scaled q, C, alpha, and SH_preblend', () => {
    const result = evaluateProbeReference({ objectKey: 'blend', position: [0.5, 0, 0], normal: [0, 0, 1], skyIrradiance: sky }, [blueProbe, redProbe]);
    expect(result.terms.map((term) => term.identity)).toEqual(['blue', 'red']);
    expect(result.terms.every((term) => term.active)).toBe(true);
    expect(result.terms[0]?.scaledQ).toBeCloseTo((1 - (0.5 / 4) ** 2) * (2 / 4) ** 2, 12);
    expect(result.terms[1]?.scaledQ).toBeCloseTo(1 - (0.5 / 2) ** 2, 12);
    expect(result.terms.reduce((sum, term) => sum + term.alpha, 0)).toBeCloseTo(1, 12);
    expect(result.C).toBeCloseTo(1 - (0.5 / 4) ** 2 * (0.5 / 2) ** 2, 12);
    expect(result.S).toBeCloseTo(1 - result.C, 12);
    expect(result.SH_preblend[0]).toBeGreaterThan(0);
    expect(result.trueE_skyResidual[0]).toBeCloseTo(sky[0] * result.S, 12);
    expect(result.trueE_skyResidual[1]).toBeCloseTo(sky[1] * result.S, 12);
  });

  it('preserves the finite contract at R_MIN and under a uniform scale', () => {
    const radius = PROBE_REFERENCE_R_MIN;
    const base = evaluateProbeReference({ objectKey: 'minimum', position: [0, 0, 0], normal: [0, 0, 1], skyIrradiance: sky }, [{ ...redProbe, radius, position: [0, 0, 0] }]);
    const scaled = evaluateProbeReference({ objectKey: 'minimum-scaled', position: [0, 0, 0], normal: [0, 0, 1], skyIrradiance: sky }, [{ ...redProbe, radius: radius * 1000, position: [0, 0, 0] }]);
    expect(base.finite).toBe(true);
    expect(scaled.finite).toBe(true);
    expect(base.C).toBe(1);
    expect(scaled.C).toBe(1);
    expect(base.diffuse).toEqual(scaled.diffuse);
  });

  it('retains per-object position and adds the true Sky residual to Three L00', () => {
    const left = evaluateProbeReference({ objectKey: 'left', position: [-1, 0, 0], normal: [0, 0, 1], skyIrradiance: sky }, [redProbe]);
    const right = evaluateProbeReference({ objectKey: 'right', position: [1, 0, 0], normal: [0, 0, 1], skyIrradiance: sky }, [redProbe]);
    expect(left.position).toEqual([-1, 0, 0]);
    expect(right.position).toEqual([1, 0, 0]);
    expect(left.objectKey).not.toBe(right.objectKey);
    const leftShL00 = buildThreeLightProbeSh(left)[0] ?? 0;
    expect(leftShL00).toBeCloseTo((left.SH_preblend[0] ?? 0) / Math.PI + left.trueE_skyResidual[0] / 0.886227, 12);
    expect(leftShL00).not.toBeCloseTo((left.SH_preblend[0] ?? 0) / Math.PI, 12);
  });
});
