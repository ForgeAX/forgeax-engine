import { describe, expect, it } from 'vitest';
import { curvePoint } from '../../curves';
import { surfacePoint } from '../../surfaces';
import type { Shape, Surface } from '../../types';
import { dist3, type P3 } from '../../vec';
import { type Closest, closestOnEdge, closestOnFace, closestOnShape } from '../distance';
import { probes, specimens } from './corpus';
import { bruteForce } from './oracle';

/** Tolerance of the dense oracle (3 zoom rounds on a 160 grid); the result must also never exceed it. */
const ORACLE_TOL = 2e-7;

function footPoint(shape: Shape, c: Closest): P3 {
  if (c.foot.kind === 'face') {
    const f = shape.faces[c.foot.id] as Shape['faces'][number];
    return surfacePoint(shape.surfaces[f.surface] as Surface, c.foot.u, c.foot.v);
  }
  if (c.foot.kind === 'vertex') return (shape.vertices[c.foot.id] as Shape['vertices'][number]).p;
  const e = shape.edges[c.foot.id] as Shape['edges'][number];
  return curvePoint(shape.curves[e.curve] as Shape['curves'][number], c.foot.t);
}

describe('closest point on a shape vs dense brute force', () => {
  for (const { name, shape } of specimens()) {
    it(name, () => {
      let worstGap = 0;
      const oracleOf = bruteForce(shape);
      for (const p of probes(shape, 14, 20260109)) {
        const r = closestOnShape(shape, p);
        if (!r.ok) throw new Error(JSON.stringify(r.error));
        const oracle = oracleOf(p);
        // The foot is a real point of the shape at the reported distance.
        expect(
          dist3(footPoint(shape, r.value), r.value.point),
          JSON.stringify(r.value),
        ).toBeLessThan(1e-9);
        expect(Math.abs(dist3(r.value.point, p) - r.value.distance)).toBeLessThan(1e-9);
        // Oracle points are real surface points, so the exact minimum can only be smaller; the
        // reported interval [distance - errorBound, distance] must therefore reach down to it.
        expect(r.value.distance - r.value.errorBound).toBeLessThanOrEqual(oracle + 1e-12);
        expect(oracle - r.value.distance).toBeLessThan(ORACLE_TOL);
        expect(r.value.errorBound).toBeLessThan(1e-7);
        worstGap = Math.max(worstGap, oracle - r.value.distance);
      }
      expect(worstGap).toBeLessThan(ORACLE_TOL);
    });
  }
});

describe('closest point on one face and one edge', () => {
  it('a box face reports its own face id and edge id on the rim', () => {
    const { shape } = specimens()[0] as { shape: Shape };
    const onFace = closestOnFace(shape, 0, [7, 0.3, 0.2]);
    if (!onFace.ok) throw new Error('face');
    expect(onFace.value.foot.kind).toBe('face');
    const far = closestOnFace(shape, 0, [30, 0.3, 30]);
    if (!far.ok) throw new Error('face far');
    expect(far.value.foot.kind).toBe('edge');
    const onEdge = closestOnEdge(shape, 0, [0, 0, 0]);
    if (!onEdge.ok) throw new Error('edge');
    expect(onEdge.value.foot.kind).toBe('edge');
  });

  it('rejects out-of-range indices with a structured error', () => {
    const { shape } = specimens()[0] as { shape: Shape };
    const r = closestOnFace(shape, 99, [0, 0, 0]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.detail).toMatchObject({ reason: 'distance-index' });
  });
});
