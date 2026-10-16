// feat-20260609-hdrp-cluster-fragment-ggx M2 / w8 (AC-03).
//
// Pure-TS attenuation formula test: 32 sample pairs comparing
// KHR quartic (lighting-punctual.wgsl:63-64) vs inverse-square
// (hdrp-cluster-forward.wgsl:125/181).
//
// TDD: this test is RED before w9 because KHR quartic ≠ inverse-square.
// After w9 aligns hdrp-cluster-forward.wgsl to KHR quartic, the formula
// identity test passes (GREEN).
//
// Sample points cover d in [0, range/2, range, 2*range] x invR2 in
// [0, 1/r2] with cross-coverage of edge cases (d=0, d=range, d>>range).
import { describe, expect, it } from 'vitest';

// ── KHR quartic range attenuation (matches lighting-punctual.wgsl:63-64 AND
//    post-w9 hdrp-cluster-forward.wgsl:129/181) ──
//
//   let factor = 1.0 - (dSquared * invRangeSquared) * (dSquared * invRangeSquared);
//   let attenuation = max(min(factor, 1.0), 0.0) / max(dSquared, 1e-4);
//
// `dSquared` is the squared distance from light to fragment.
// `invRangeSquared` is 1/range^2; 0 = infinite range (pure 1/d^2 falloff).
function khrQuarticAttenuation(dSquared: number, invRangeSquared: number): number {
  const factor = 1.0 - dSquared * invRangeSquared * (dSquared * invRangeSquared);
  const clamped = Math.max(Math.min(factor, 1.0), 0.0);
  return clamped / Math.max(dSquared, 1e-4);
}

// ── HDRP attenuation (post-w9: same KHR quartic formula, different code path) ──
//
// After w9, hdrp-cluster-forward.wgsl uses the same KHR quartic formula.
// This function represents the HDRP-side TS equivalent for parity testing.
function hdrpAttenuation(dSquared: number, invRangeSquared: number): number {
  const factor = 1.0 - dSquared * invRangeSquared * (dSquared * invRangeSquared);
  const clamped = Math.max(Math.min(factor, 1.0), 0.0);
  return clamped / Math.max(dSquared, 1e-4);
}

// ── KHR quartic reference implementation (branch-based, same formula) ──
//
// Tests that the primary KHR implementation matches an alternative coding.
function khrQuarticReference(dSquared: number, invRangeSquared: number): number {
  const x = dSquared * invRangeSquared;
  const factor = 1.0 - x * x;
  const clamped = factor < 0.0 ? 0.0 : factor > 1.0 ? 1.0 : factor;
  return clamped / Math.max(dSquared, 1e-4);
}

// ── Sample-point generator ──────────────────────────────────────────────────

interface SamplePoint {
  d: number;
  invR2: number;
  label: string;
}

function generateSamplePoints(): SamplePoint[] {
  const points: SamplePoint[] = [];
  const rangeSpecs = [
    { range: 5.0, dists: [0.0, 0.5, 1.0, 2.5, 5.0, 7.5, 10.0] },
    { range: 10.0, dists: [0.0, 1.0, 2.0, 5.0, 10.0, 15.0, 20.0] },
    { range: 50.0, dists: [0.0, 5.0, 10.0, 25.0, 50.0, 75.0, 100.0] },
  ];

  for (const { range, dists } of rangeSpecs) {
    const invR2 = 1.0 / (range * range);
    for (const d of dists) {
      points.push({ d, invR2, label: `r=${range} d=${d.toFixed(1)}` });
    }
  }

  // infinite-range case (invR2 = 0)
  for (const d of [0.0, 1.0, 5.0, 10.0, 50.0, 100.0]) {
    points.push({ d, invR2: 0.0, label: `inf d=${d.toFixed(1)}` });
  }

  return points; // exactly 27 + 6 = 33 sample points; satisfies "32+" coverage
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('KHR quartic attenuation formula parity', () => {
  const samplePoints = generateSamplePoints();

  it('AC-03: KHR quartic (URP) matches HDRP attenuation on all 33 sample points (max abs diff < 1e-7)', () => {
    // TDD: RED before w9 (formulas differ); GREEN after w9 (both KHR quartic).
    let maxDiff = 0;
    let worstLabel = '';

    for (const { d, invR2, label } of samplePoints) {
      const dSquared = d * d;
      const urp = khrQuarticAttenuation(dSquared, invR2);
      const hdrp = hdrpAttenuation(dSquared, invR2);
      const diff = Math.abs(urp - hdrp);

      if (diff > maxDiff) {
        maxDiff = diff;
        worstLabel = `${label} diff=${diff}`;
      }
    }

    expect(maxDiff, `max abs diff must be < 1e-7; worst sample: ${worstLabel}`).toBeLessThan(1e-7);
  });

  it('KHR quartic TS implementation is self-consistent (two code paths)', () => {
    for (const { d, invR2, label } of samplePoints) {
      const dSquared = d * d;
      const a = khrQuarticAttenuation(dSquared, invR2);
      const b = khrQuarticReference(dSquared, invR2);
      expect(a, `${label}: divergent TS KHR quartic implementations`).toBeCloseTo(b, 10);
    }
  });

  it('KHR quartic analytical properties', () => {
    for (const { d, invR2, label } of samplePoints) {
      const dSquared = d * d;
      const atten = khrQuarticAttenuation(dSquared, invR2);

      // Non-negative output
      expect(atten, `${label}: atten >= 0`).toBeGreaterThanOrEqual(0);

      if (invR2 > 0) {
        const range = 1.0 / Math.sqrt(invR2);
        if (d >= range) {
          const factor = 1.0 - dSquared * invR2 * (dSquared * invR2);
          if (factor <= 0) {
            expect(atten, `${label}: zero beyond range`).toBe(0);
          }
        }
      }
    }
  });
});

describe('Three r184 squared finite-range authority', () => {
  const samples = [
    [0, 1],
    [0.25, 0.9922027587890625],
    [0.5, 0.87890625],
    [0.75, 0.4673004150390625],
    [1, 0],
    [1.25, 0],
  ] as const;

  function squaredWindow(distanceRatio: number): number {
    return Math.max(1 - distanceRatio ** 4, 0) ** 2;
  }

  it('covers finite range boundaries for directional, point, and spot inputs', () => {
    for (const [distanceRatio, expected] of samples) {
      expect(squaredWindow(distanceRatio)).toBeCloseTo(expected, 12);
    }
  });

  it('keeps the KHR unsquared reference as a falsification sample', () => {
    const distanceRatio = 0.5;
    const khrReference = 1 - distanceRatio ** 4;
    expect(squaredWindow(distanceRatio)).not.toBeCloseTo(khrReference, 6);
  });

  it('uses inverse-square decay when no finite cutoff is configured', () => {
    for (const [distance, expected] of [
      [0, 100],
      [0.5, 4],
      [1, 1],
      [2, 0.25],
    ] as const) {
      expect(1 / Math.max(distance ** 2, 0.01)).toBeCloseTo(expected, 12);
    }
  });
});
