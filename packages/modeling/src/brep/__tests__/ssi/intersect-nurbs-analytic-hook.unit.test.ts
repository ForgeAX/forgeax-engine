import { describe, expect, it } from 'vitest';
import { surfaceDomain } from '../../../nurbs';
import { type BranchPCurve, intersectSurfaces } from '../../intersect';
import { makeFrame } from '../../surfaces';
import { tube } from './freeform';
import { prng } from './prng';

// The public boolean-facing route: intersectSurfaces(NURBS, plane) returns the SSI branches in the
// IntersectionBranch shape, with the SSI receipt, and never silently drops a stop.
const skin = () => tube(prng(1), { length: 6, sections: 8, radius: 1, wobble: 0.3 });
const plane = (o: readonly [number, number, number], n: readonly [number, number, number]) => ({
  kind: 'plane' as const,
  frame: makeFrame([...o], [...n]),
});

describe('intersectSurfaces: NURBS x plane / cylinder hook', () => {
  it('returns IntersectionBranch shapes with a fitted receipt inside tolerance', {
    timeout: 120000,
  }, () => {
    const r = intersectSurfaces(
      { kind: 'nurbs', surface: skin() },
      plane([0, 0, 0], [0, 0, 1]),
      1e-7,
      {
        window: { c: [0, 0, 0], r: 6 },
      },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.partials).toEqual([]);
    expect(r.value.branches.length).toBeGreaterThan(0);
    for (const b of r.value.branches) {
      expect(b.curve.kind).toBe('nurbs');
      expect(b.onA.kind).toBe('nurbs');
      expect(b.onB.kind).toBe('nurbs');
      expect(b.t0).toBe(0);
      expect(b.t1).toBe(1);
      expect(typeof b.receipt === 'object' && b.receipt.bound <= 1e-7).toBe(true);
    }
  });

  it('is symmetric: plane first gives the same branch count', { timeout: 240000 }, () => {
    const p = plane([0, 0, 0], [0, 0, 1]);
    const w = { window: { c: [0, 0, 0] as [number, number, number], r: 6 } };
    const ab = intersectSurfaces({ kind: 'nurbs', surface: skin() }, p, 1e-7, w);
    const ba = intersectSurfaces(p, { kind: 'nurbs', surface: skin() }, 1e-7, w);
    expect(ab.ok && ba.ok).toBe(true);
    if (!ab.ok || !ba.ok) return;
    expect(ba.value.branches.length).toBe(ab.value.branches.length);
  });

  // Two identical skins are coincident, so every seed is a tangent contact. The NURBS x NURBS
  // marcher runs to its seed budget (measured 89 s alone on the shared host, 160 s inside a
  // loaded full-suite gate run). The result is structured: no branch, a budget partial, and
  // tangent partials only.
  it('a coincident NURBS x NURBS pair reports structured partials, not branches', {
    timeout: 240000,
  }, () => {
    const r = intersectSurfaces(
      { kind: 'nurbs', surface: skin() },
      { kind: 'nurbs', surface: skin() },
      1e-7,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.branches).toEqual([]);
    const codes = new Set(r.value.partials.map((p) => p.code));
    expect(codes.has('brep-ssi-tangent')).toBe(true);
    expect([...codes].every((c) => c === 'brep-ssi-tangent' || c === 'brep-ssi-unsupported')).toBe(
      true,
    );
    expect(r.value.partials.some((p) => p.code === 'brep-ssi-unsupported')).toBe(true);
  });

  it('plane-first returns pcurves on the same faces as the NURBS-first call', {
    timeout: 120000,
  }, () => {
    const p = plane([0, 0, 0], [0, 0, 1]);
    const w = { window: { c: [0, 0, 0] as [number, number, number], r: 6 } };
    const ab = intersectSurfaces({ kind: 'nurbs', surface: skin() }, p, 1e-7, w);
    const ba = intersectSurfaces(p, { kind: 'nurbs', surface: skin() }, 1e-7, w);
    expect(ab.ok && ba.ok).toBe(true);
    if (!ab.ok || !ba.ok) return;
    expect(ba.value.branches.length).toBe(ab.value.branches.length);
    // The NURBS pcurve of the NURBS-first call is onA; for the plane-first call it is onB.
    const first = ab.value.branches[0];
    const swapped = ba.value.branches[0];
    if (first === undefined || swapped === undefined) throw new Error('expected a branch');
    expect(swapped.onB).toEqual(first.onA);
    expect(swapped.onA).toEqual(first.onB);
    // Absolute: the NURBS pcurve's v stays in the NURBS domain (u may run past it across the periodic
    // seam); the plane pcurve stays inside the plane box |x|, |y| <= 6.
    const [, [v0, v1]] = surfaceDomain(skin());
    const nurbsPoints = (pc: BranchPCurve): readonly (readonly number[])[] => {
      if (pc.kind !== 'nurbs') throw new Error('expected a NURBS pcurve');
      return pc.curve.points;
    };
    const ys = (points: readonly (readonly number[])[]) => points.map((q) => q[1] ?? 0);
    const inBox = (points: readonly (readonly number[])[]) =>
      points.every((q) => Math.abs(q[0] ?? 0) <= 6 && Math.abs(q[1] ?? 0) <= 6);
    expect(ys(nurbsPoints(first.onA)).every((y) => y >= v0 - 1e-9 && y <= v1 + 1e-9)).toBe(true);
    expect(inBox(nurbsPoints(first.onB))).toBe(true);
  });

  it('with no window the default covers the control net, matching a wide explicit window', {
    timeout: 120000,
  }, () => {
    const p = plane([0, 0, 0], [0, 0, 1]);
    const none = intersectSurfaces({ kind: 'nurbs', surface: skin() }, p, 1e-7);
    const wide = intersectSurfaces({ kind: 'nurbs', surface: skin() }, p, 1e-7, {
      window: { c: [0, 0, 0], r: 100 },
    });
    expect(none.ok && wide.ok).toBe(true);
    if (!none.ok || !wide.ok) return;
    expect(none.value.branches.length).toBe(wide.value.branches.length);
    expect(none.value.branches.length).toBeGreaterThan(0);
  });

  it('NURBS x cylinder: marched branches stay inside tolerance on both faces', {
    timeout: 120000,
  }, () => {
    const bore = {
      kind: 'cylinder' as const,
      frame: makeFrame([0, 0, 0], [0, 0, 1]),
      radius: 0.5,
    };
    const r = intersectSurfaces({ kind: 'nurbs', surface: skin() }, bore, 1e-7);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.partials).toEqual([]);
    expect(r.value.branches.length).toBeGreaterThan(0);
    for (const b of r.value.branches) {
      expect(typeof b.receipt === 'object' && b.receipt.bound <= 1e-7).toBe(true);
    }
    const flipped = intersectSurfaces(bore, { kind: 'nurbs', surface: skin() }, 1e-7);
    expect(flipped.ok && flipped.value.branches.length).toBe(r.value.branches.length);
  });
});
