import { describe, expect, it } from 'vitest';
import {
  authoredBoxClear,
  authoredBoxesClear,
  authoredTransportClear,
  authoredTriangleBlocks,
  type ClearanceCandidate,
  type ClearanceWitness,
  clearanceQualificationWitness,
  independentClearanceQualification,
  legacyFallbackPolicyModel,
} from './irradiance-field-clearance-qualification.fixture';

function replaceFirst(w: ClearanceWitness, patch: Partial<ClearanceCandidate>): ClearanceWitness {
  return { ...w, alternative: w.alternative.map((c, i) => (i === 0 ? { ...c, ...patch } : c)) };
}
describe('independent clearance geometry and qualification oracle', () => {
  it('separates the third edge from two independently clear edges', () => {
    const biased = [25, 120, 165] as const,
      anchor = [73, 120, 101] as const,
      probe = [0, 80, 80] as const;
    const lo = [30, -80, 70] as const,
      hi = [50, 320, 90] as const;
    expect(authoredBoxClear(biased, anchor, lo, hi)).toBe(true);
    expect(authoredBoxClear(biased, probe, lo, hi)).toBe(true);
    expect(authoredBoxClear(anchor, probe, lo, hi)).toBe(false);
  });
  it('checks all twelve authored triangles against independent slab halfspaces', () => {
    // x>=3 implies a segment stays strictly outside convex slab x<=1.
    expect(authoredTransportClear([3, 2, 0], [8, 8, 0])).toBe(true);
    // x changes3->-4 while y/z stay inside the slab footprint: it must hit.
    expect(authoredTransportClear([3, 2, 0], [-4, 8, 0])).toBe(false);
    expect(authoredTransportClear([3, 2, 0], [3, 1, 0])).toBe(true);
    expect(authoredTransportClear([3, 2, 0], [-3, 1, 0])).toBe(false);
  });
  it('keeps closed face edges and reversed winding geometrically identical', () => {
    const a = [1, -2, -2] as const,
      b = [1, 2, -2] as const,
      c = [1, 2, 2] as const;
    expect(authoredTriangleBlocks([3, 0, 0], [-3, 0, 0], [a, b, c])).toBe(true);
    expect(authoredTriangleBlocks([3, 0, 0], [-3, 0, 0], [c, b, a])).toBe(true);
    expect(authoredTriangleBlocks([3, 0, 4], [-3, 0, 4], [a, b, c])).toBe(false);
  });
  it('supports independent known clearance while never consuming pending color', () => {
    const w = clearanceQualificationWitness();
    expect(independentClearanceQualification(w)).toBe(true);
    expect(
      independentClearanceQualification({
        ...w,
        ordinary: w.ordinary.map((c) =>
          c.state === 'pending' ? { ...c, color: [NaN, Infinity, -1e30] } : c,
        ),
      }),
    ).toBe(true);
  });
  it('keeps truly untraced, invalid and unsupported angular data unavailable', () => {
    const w = clearanceQualificationWitness();
    for (const state of ['untraced', 'invalid', 'pending'] as const)
      expect(independentClearanceQualification(replaceFirst(w, { state }))).toBe(false);
    expect(independentClearanceQualification(replaceFirst(w, { angularSupport: false }))).toBe(
      false,
    );
    expect(independentClearanceQualification(replaceFirst(w, { transportAvailable: false }))).toBe(
      false,
    );
    expect(
      independentClearanceQualification({
        ...w,
        ordinary: w.ordinary.map((c) => (c.state === 'pending' ? { ...c, state: 'untraced' } : c)),
      }),
    ).toBe(false);
  });
  it('rejects bad pending metadata and an unavailable or wall-crossing anchor', () => {
    const w = clearanceQualificationWitness();
    expect(
      independentClearanceQualification({
        ...w,
        ordinary: w.ordinary.map((c) => (c.state === 'pending' ? { ...c, updates: 1 } : c)),
      }),
    ).toBe(false);
    expect(independentClearanceQualification({ ...w, anchorAvailable: false })).toBe(false);
    expect(independentClearanceQualification({ ...w, anchor: [-3, 1, 0] })).toBe(false);
  });
  it('keeps side and zero-trilinear rejection before missing-state qualification', () => {
    const w = clearanceQualificationWitness(),
      missing = {
        ...w.alternative[0],
        id: 'unused',
        state: 'untraced' as const,
        point: [4, -2, 0] as const,
      } as ClearanceCandidate;
    expect(
      independentClearanceQualification({ ...w, alternative: [...w.alternative, missing] }),
    ).toBe(true);
    expect(
      independentClearanceQualification({
        ...w,
        alternative: [...w.alternative, { ...missing, point: [4, 8, 0], trilinear: 0 }],
      }),
    ).toBe(true);
  });
  it('accepts supported black and inside geometry without promoting them to active', () => {
    const w = clearanceQualificationWitness();
    expect(
      independentClearanceQualification({
        ...w,
        ordinary: w.ordinary.map((c) => (c.state === 'pending' ? { ...c, state: 'inside' } : c)),
        alternative: w.alternative.map((c) => ({ ...c, color: [0, 0, 0] })),
      }),
    ).toBe(true);
    expect(
      independentClearanceQualification({
        ...w,
        alternative: w.alternative.map((c) => ({ ...c, state: 'inside' })),
      }),
    ).toBe(false);
  });
  it('rejects another-side bright source rather than hiding its geometry with radiance', () => {
    const w = clearanceQualificationWitness();
    expect(
      independentClearanceQualification({
        ...w,
        alternative: w.alternative.map((c) => ({
          ...c,
          point: [-4, 8, 0],
          color: [1e20, 1e20, 1e20],
        })),
      }),
    ).toBe(false);
    expect(independentClearanceQualification(replaceFirst(w, { point: [-4, 8, 0] }))).toBe(true);
  });
  it('proves the actual four-cubed GPU witness has a positive-side pending corner and clear alternatives', () => {
    // All positions in1/80 author units. Pending38=(2,1,2)+offset(0,0,.25).
    expect((160 - 85) * -3 + (180 - 85) * 4).toBe(155);
    expect((1 / 16) * (1 / 2) * (1 / 16)).toBe(1 / 512);
    expect(Math.floor(85 / 80)).toBe(1);
    expect(Math.floor(73 / 80)).toBe(0);
    const anchor = [73, 120, 101] as const,
      biased = [73, 120, 109] as const;
    expect(authoredBoxesClear(biased, anchor)).toBe(true);
    for (const y of [80, 160])
      for (const z of [80, 160]) {
        expect(authoredBoxesClear(anchor, [0, y, z])).toBe(true);
        expect(authoredBoxesClear(biased, [0, y, z])).toBe(true);
      }
  });
});
describe('historical old-policy model explanation, not the production regression', () => {
  it('records old rejection separately from independently qualified support', () => {
    const w = clearanceQualificationWitness();
    expect(
      independentClearanceQualification(w),
      'Independent authored geometry and complete alternative qualification',
    ).toBe(true);
    expect(
      legacyFallbackPolicyModel(w),
      'Historical original policy sets fallbackAllowed=false; persistent production regression belongs to the Dawn test',
    ).toBe(false);
  });
});
