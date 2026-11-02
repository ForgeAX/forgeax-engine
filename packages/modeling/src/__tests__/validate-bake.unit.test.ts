import { describe, expect, it } from 'vitest';
import { model } from '../model';
import type { Issue } from '../report';
import { sel } from '../selectors';
import type { ValidationCode } from '../validate';

/** A 1 m plane of 4 x 4 quads with one continuous planar uv0. */
function plane() {
  const m = model();
  m.plane({ width: 1, height: 1, widthSegments: 4, heightSegments: 4 });
  m.uv.project({ mode: 'planar', axis: 'z', scale: 1 });
  return m;
}

const bakeIssues = (issues: readonly Issue<ValidationCode>[]) =>
  issues.filter((i) => i.code === 'bake');

/** The four interior edges on x = 0 (the boundary of the faces with centroid x > 0). */
const middleLine = sel.side([0, 0, 0], [1, 0, 0], { by: 'centroid' }).boundary();

describe('validate({ bake }): V1 sharp-not-seam', () => {
  it('a continuous uv0 with no hard edge has no bake finding', () => {
    expect(bakeIssues(plane().validate({ bake: true }).issues)).toEqual([]);
  });

  it('falsifier: a hard edge line without a UV seam is reported edge by edge', () => {
    const m = plane();
    m.markSharp(middleLine);
    const [issue, ...rest] = bakeIssues(m.validate({ bake: true }).issues);
    expect(rest).toEqual([]);
    expect(issue).toMatchObject({
      code: 'bake',
      severity: 'warn',
      detail: { check: 'sharp-not-seam', count: 4 },
    });
    expect((issue?.detail.edges as number[]).length).toBe(4);
    expect((issue?.detail.faces as number[]).length).toBe(8);
  });

  it('cutting the seam along the hard edge (uv.auto respects sharp edges) clears it', () => {
    const m = plane();
    m.markSharp(middleLine);
    expect(m.uv.auto({ resolution: 64, padding: 2 }).status).toBe('ok');
    expect(bakeIssues(m.validate({ bake: true }).issues)).toEqual([]);
  });

  it('checks the hard edges of the export normal mode, and only on request', () => {
    const m = plane();
    // Flat export normals make every interior edge hard: 2 x 4 x 3 interior edges.
    expect(
      bakeIssues(m.validate({ bake: { normals: { mode: 'flat' } } }).issues)[0]?.detail,
    ).toMatchObject({
      check: 'sharp-not-seam',
      count: 24,
    });
    m.markSharp(middleLine);
    expect(bakeIssues(m.validate().issues)).toEqual([]);
    expect(bakeIssues(m.validate({ bake: { checks: [] } }).issues)).toEqual([]);
  });
});

describe('validate({ bake }): V9 subpixel-bevel', () => {
  function bevelled(width: number) {
    const m = model();
    m.box({ size: [1, 1, 1] });
    m.bevel(sel.edges.all(), { width, segments: 1, label: 'chamfer' });
    return m;
  }
  // 1080 px over a 60 degree field at 10 m: 93.5 px per meter.
  const view = { distance: 10 };

  it('falsifier: a 2 mm chamfer is a fifth of a pixel at 10 m and is reported', () => {
    const issue = bakeIssues(bevelled(0.002).validate({ bake: { view } }).issues).find(
      (i) => i.detail.check === 'subpixel-bevel',
    );
    expect(issue?.detail.count).toBe(12);
    expect(issue?.detail.pxPerMeter as number).toBeCloseTo(93.53, 1);
    expect(issue?.detail.narrowestPx as number).toBeLessThan(0.3);
  });

  it('a 5 cm chamfer covers several pixels and passes; without a view the check stays off', () => {
    expect(bakeIssues(bevelled(0.05).validate({ bake: { view } }).issues)).toEqual([]);
    expect(bakeIssues(bevelled(0.002).validate({ bake: true }).issues)).toEqual([]);
  });

  it('reports an impossible view instead of guessing', () => {
    const [issue] = bakeIssues(bevelled(0.05).validate({ bake: { view: { distance: 0 } } }).issues);
    expect(issue?.detail).toMatchObject({ check: 'subpixel-bevel', reason: 'invalid-view' });
  });
});
