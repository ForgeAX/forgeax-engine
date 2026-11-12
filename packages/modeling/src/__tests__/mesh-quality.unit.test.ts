import { describe, expect, it } from 'vitest';
import type { Tuple3 } from '../geom';
import { type Model, model } from '../model';
import { sel } from '../selectors';

function report(m: Model, faces?: Parameters<Model['meshQuality']>[0]) {
  const r = m.meshQuality(faces);
  if (!r.ok) throw new Error(r.error.expected);
  return r.value;
}

/** A triangulated grid: right isosceles triangles (aspect 2, angles 45 and 90), valence 6. */
function grid(width: number, height: number, segments: [number, number], label = 'grid'): Model {
  const m = model();
  m.plane({ width, height, widthSegments: segments[0], heightSegments: segments[1], label });
  m.triangulate(sel.all());
  return m;
}

describe('meshQuality: triangle tiling against the R5 faceting thresholds', () => {
  it('passes an even triangulated grid and measures it exactly', () => {
    const q = report(grid(1, 1, [10, 10]));
    expect(q.failed).toEqual([]);
    expect(q.triangles).toBe(200);
    expect(q.ngons).toBe(0);
    expect(q.area).toBeCloseTo(1, 9);
    expect(q.density).toBeCloseTo(200, 6);
    expect(q.aspect.p50).toBeCloseTo(2, 9);
    expect(q.minAngle.p10).toBeCloseTo(45, 6);
    expect(q.sizeRatio.max).toBeCloseTo(1, 9);
    // Every interior vertex of a consistently split grid has six neighbours.
    expect(q.valence.byValence).toEqual({ 6: q.valence.interior });
  });

  it('fails slivers (aspect and smallest angle): a grid stretched 10 to 1', () => {
    const q = report(grid(10, 1, [10, 10]));
    expect(q.aspect.p90).toBeGreaterThan(6);
    expect(q.failed).toEqual(
      expect.arrayContaining(['aspectP50', 'aspectP90', 'over6', 'minAngleP10']),
    );
  });

  it('fails fans: the poles of a triangulated UV sphere have valence 16', () => {
    const m = model();
    m.sphere({ radius: 1, widthSegments: 16, heightSegments: 8 });
    m.triangulate(sel.all());
    const q = report(m);
    expect(q.valence.byValence[16]).toBe(2);
    expect(q.valence.bad).toBeGreaterThan(0.01);
    expect(q.failed).toContain('badValence');
  });

  it('fails abrupt size jumps between neighbours', () => {
    const m = grid(1, 1, [2, 2], 'coarse');
    m.subdivide(sel.all().and(sel.inBox([-0.5, -0.5, -1], [0, 0, 1], { by: 'centroid' })), {
      levels: 2,
      scheme: 'simple',
    });
    m.triangulate(sel.all());
    const q = report(m);
    expect(q.sizeRatio.max).toBeGreaterThan(2);
  });

  it('counts n-gons and measures only triangles; rejects bad limits', () => {
    const m = model();
    m.plane({ width: 1, height: 1, widthSegments: 2, heightSegments: 2 });
    const q = report(m);
    expect(q.ngons).toBe(4);
    expect(q.triangles).toBe(0);
    const bad = m.meshQuality(undefined, { aspectP90: -1 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe('model-invalid-argument');
  });

  it('gates named parts in validate: failing and unknown parts are warnings, passing parts are silent', () => {
    const m = grid(1, 1, [10, 10], 'even');
    const stretched = grid(10, 1, [10, 10], 'stretched');
    m.append(stretched, { label: 'stretched', translate: [0, 0, 1] });
    const issues = m
      .validate({ quality: [{ part: 'even' }, { part: 'stretched' }, { part: 'missing' }] })
      .issues.filter((i) => i.code === 'mesh-quality');
    expect(issues.map((i) => i.detail.part)).toEqual(['stretched', 'missing']);
    expect(issues[0]?.detail.failed).toContain('aspectP90');
    expect(issues[1]?.detail.reason).toBe('unknown-part');
    // Limits per part: relaxed enough, the stretched grid passes.
    const relaxed = m.validate({
      quality: [
        { part: 'stretched', limits: { aspectP50: 50, aspectP90: 50, over6: 1, minAngleP10: 0 } },
      ],
    });
    expect(relaxed.issues.filter((i) => i.code === 'mesh-quality')).toEqual([]);
  });
});

describe('meshQuality flow', () => {
  /** A 2 x 1 m plane in XY of 0.5 x 0.125 m cells, triangulated: long edges 14 degrees off X. */
  function strip(label: string, center: [number, number, number] = [0, 0, 0]) {
    const m = model();
    m.plane({ width: 2, height: 1, widthSegments: 4, heightSegments: 8, center, label });
    m.triangulate(sel.all());
    return m;
  }

  it('measures the long edges against the flow and gates p75', () => {
    const m = strip('s');
    const along = m.meshQuality(undefined, {}, { flow: [{ flow: { along: [1, 0, 0] } }] });
    if (!along.ok) throw along.error;
    expect(along.value.flow?.measured).toBe(64);
    expect(along.value.flow?.skipped).toBe(0);
    expect(along.value.flow?.p75).toBeCloseTo((Math.atan2(0.125, 0.5) * 180) / Math.PI, 6);
    expect(along.value.failed).not.toContain('flowP75');
    // Falsifier: the same tiling against the cross direction fails.
    const across = m.meshQuality(undefined, {}, { flow: [{ flow: { along: [0, 1, 0] } }] });
    expect(across.ok && across.value.flow?.p75).toBeGreaterThan(70);
    expect(across.ok && across.value.failed).toContain('flowP75');
    // Without flow there is no flow report and no flow limit.
    const plain = m.meshQuality();
    expect(plain.ok && plain.value.flow).toBeUndefined();
    expect(plain.ok && plain.value.failed.filter((f) => f.startsWith('flow'))).toEqual([]);
  });

  it('scopes guides by faces, first match wins', () => {
    const m = strip('a');
    m.append(strip('b', [0, 3, 0]).snapshot());
    const report = m.meshQuality(
      undefined,
      {},
      {
        flow: [
          { faces: sel.createdBy('b'), flow: { along: [0, 1, 0] } },
          { flow: { along: [1, 0, 0] } },
        ],
      },
    );
    if (!report.ok) throw report.error;
    expect(report.value.flow?.measured).toBe(128);
    // Half the triangles (b) are measured against Y: p75 is the large angle.
    expect(report.value.flow?.p50).toBeLessThan(20);
    expect(report.value.flow?.p75).toBeGreaterThan(70);
  });

  it('reports border rows apart and gates the interior and the border share', () => {
    // Two strips side by side in X, a label seam between them at x = 1: the seam runs along Y.
    const pair = () => {
      const m = strip('left');
      m.append(strip('right', [2, 0, 0]).snapshot());
      m.weld({ distance: 1e-6 });
      return m;
    };
    const m = pair();
    const crossing = (along: Tuple3, limits = {}) => {
      const r = m.meshQuality(sel.all(), limits, {
        flow: [{ flow: { along }, border: { crossing: 45 } }],
      });
      if (!r.ok) throw r.error;
      return r.value;
    };
    const plain = m.meshQuality(sel.all(), {}, { flow: [{ flow: { along: [1, 0, 0] } }] });
    if (!plain.ok) throw plain.error;
    // Flow along X crosses the seam and the strips' short open ends (Y edges) at 90 degrees.
    const across = crossing([1, 0, 0]);
    // p75 keeps its meaning (every measured triangle), byte for byte.
    expect(across.flow?.p75).toBe(plain.value.flow?.p75);
    expect(across.flow?.measured).toBe(plain.value.flow?.measured);
    const border = across.flow?.border;
    const interior = across.flow?.interior;
    expect(border?.n).toBeGreaterThan(0);
    expect((border?.n ?? 0) + (interior?.n ?? 0)).toBe(across.flow?.measured);
    expect(border?.share).toBeCloseTo((border?.n ?? 0) / (across.flow?.measured ?? 1), 12);
    // The long open X edges run along the flow and do not count; the Y lines (each strip's two
    // ends, the seam among them) cross it: one triangle of each of their 8 cells, 32 of 128.
    expect(border?.n).toBe(32);
    expect(border?.share).toBe(0.25);
    // The share gate: at the default 0.25 it holds; above a lower limit the unit fails as a whole.
    expect(across.failed).not.toContain('flowBorderShare');
    expect(crossing([1, 0, 0], { flowBorderShare: 0.2 }).failed).toContain('flowBorderShare');
    // Falsifier: a flow along Y runs along the seam and the ends; only the X edges cross it.
    const along = crossing([0, 1, 0]);
    const xBorder = along.flow?.border?.n ?? 0;
    expect(xBorder).toBeLessThan(border?.n ?? 0);
    // Without the option there is no split and no share gate.
    expect(plain.value.flow?.border).toBeUndefined();
    expect(plain.value.flow?.interior).toBeUndefined();
    expect(plain.value.failed).not.toContain('flowBorderShare');
  });

  it('gates the interior p75 when border rows are split off', () => {
    const m = strip('s');
    // A sharp line across the flow at x = 0 (the column of Y edges there).
    const left = sel.inBox([-2, -1, -1], [0, 1, 1], { by: 'centroid' }).toEdges('touching');
    const right = sel.inBox([0, -1, -1], [2, 1, 1], { by: 'centroid' }).toEdges('touching');
    m.markSharp(left.and(right).and(sel.edges.parallel('y')));
    const r = m.meshQuality(
      sel.all(),
      { flowBorderShare: 1 },
      {
        flow: [{ flow: { along: [1, 0, 0] }, border: { crossing: 45 } }],
      },
    );
    if (!r.ok) throw r.error;
    expect(r.value.flow?.border?.n).toBeGreaterThan(0);
    expect(r.value.failed).not.toContain('flowP75');
    // An invalid crossing is a structured argument error.
    const bad = m.meshQuality(
      sel.all(),
      {},
      {
        flow: [{ flow: { along: [1, 0, 0] }, border: { crossing: 0 } }],
      },
    );
    expect(bad.ok ? undefined : bad.error.code).toBe('model-invalid-argument');
  });

  it('skips triangles too round to have a long edge and gates the skipped share', () => {
    const m = model();
    m.polygon({
      points: [
        [0, 0, 0],
        [1, 0, 0],
        [0.5, Math.sqrt(3) / 2, 0],
      ],
      label: 'equilateral',
    });
    const report = m.meshQuality(undefined, {}, { flow: [{ flow: { along: [1, 0, 0] } }] });
    if (!report.ok) throw report.error;
    expect(report.value.flow).toMatchObject({ measured: 0, skipped: 1 });
    // A vacuous measure fails: nothing measured, everything skipped.
    expect(report.value.failed).toEqual(expect.arrayContaining(['flowP75', 'flowSkipped']));
  });
});
