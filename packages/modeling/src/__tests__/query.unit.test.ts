import { describe, expect, it } from 'vitest';
import { model } from '../model';
import { sel } from '../selectors';

function grid(n: number) {
  const m = model();
  m.plane({ width: n, height: n, widthSegments: n, heightSegments: n });
  return m;
}

describe('topology selectors', () => {
  it('loop runs straight through valence-4 vertices; ring crosses opposite edges', () => {
    const m = grid(4);
    const seeds = sel.near([0.5, 0.5, 0], 1).toEdges('touching').and(sel.edges.parallel('x'));
    expect(m.count(seeds)).toBe(2);
    const loop = seeds.loop();
    expect(m.count(loop)).toBe(8);
    expect(m.count(loop.and(sel.edges.parallel('x')))).toBe(8);
    const ring = seeds.ring();
    expect(m.count(ring)).toBe(5);
    expect(m.bounds(ring)).toEqual({ ok: true, value: { min: [0, -2, 0], max: [1, 2, 0] } });
  });

  it('shrink drops faces bordering unselected faces but not the mesh boundary', () => {
    const m = grid(5);
    const block = sel.inBox([-1.6, -1.6, -1], [1.6, 1.6, 1]);
    expect(m.count(block)).toBe(9);
    expect(m.count(block.shrink(1))).toBe(1);
    expect(m.count(sel.all().shrink(1))).toBe(25);
  });

  it('near, toVerts inclusion and perpendicular edges', () => {
    const m = grid(2);
    expect(m.count(sel.near([0.9, 0.9, 0], 2))).toBe(2);
    const corner = sel.near([0.5, 0.5, 0], 1);
    expect(m.count(corner.toVerts('touching'))).toBe(4);
    expect(m.count(corner.toVerts('contained'))).toBe(1);
    const box = model();
    box.box({ size: [1, 1, 1] });
    expect(box.count(sel.edges.perpendicular('y'))).toBe(8);
  });
});

describe('feature selectors', () => {
  it('concave finds the inner corners of a U prism', () => {
    const m = model();
    m.extrudePolygon({
      points: [
        [0, 0],
        [3, 0],
        [3, 2],
        [2, 2],
        [2, 1],
        [1, 1],
        [1, 2],
        [0, 2],
      ],
      depth: 1,
    });
    expect(m.count(sel.edges.concave())).toBe(2);
    expect(m.count(sel.edges.concave().and(sel.edges.parallel('z')))).toBe(2);
    const box = model();
    box.box({ size: [1, 1, 1] });
    expect(box.count(sel.edges.concave())).toBe(0);
  });

  it('thin finds faces whose opposite wall is closer than maxWidth', () => {
    const m = model();
    m.box({ size: [1, 1, 0.05], segments: [2, 2, 1] });
    expect(m.count(sel.thin(0.1))).toBe(8);
    expect(m.count(sel.thin(0.1).and(sel.facing('+z')))).toBe(4);
    expect(m.count(sel.thin(0.01))).toBe(0);
  });
});

describe('session queries, cancellation and budget', () => {
  it('bounds reports touched vertices and refuses poisoned or empty queries', () => {
    const m = model();
    m.box({ size: [2, 2, 2], center: [1, 2, 3] });
    expect(m.bounds(sel.facing('+y'))).toEqual({
      ok: true,
      value: { min: [0, 3, 2], max: [2, 3, 4] },
    });
    const empty = m.bounds(sel.tag('missing'));
    expect(!empty.ok && empty.error.code).toBe('model-selection-empty');
    m.box({ size: [0, 1, 1] });
    const poisoned = m.bounds(sel.all());
    expect(!poisoned.ok && poisoned.error.code).toBe('model-invalid-argument');
    expect(m.count(sel.all())).toBe(0);
  });

  it('a cancelled signal fails the next operation and the build', () => {
    const signal = { aborted: false };
    const m = model({ signal });
    expect(m.box({ size: [1, 1, 1] }).status).toBe('ok');
    signal.aborted = true;
    expect(m.extrude(sel.facing('+y'), { distance: 1, region: 'merged' }).error?.code).toBe(
      'model-cancelled',
    );
    const out = m.finish({ key: 'cancelled' });
    expect(!out.ok && out.error.code).toBe('model-cancelled');
  });

  it('a face budget fails the operation that exceeds it', () => {
    const m = model({ budget: { faces: 10 } });
    expect(m.box({ size: [1, 1, 1] }).status).toBe('ok');
    const op = m.sphere({ radius: 1, widthSegments: 8, heightSegments: 4 });
    expect(op.error?.code).toBe('model-work-budget');
    expect(op.error?.detail?.faces).toBe(38);
  });

  it('selector parameters are validated, also through composition', () => {
    const m = grid(3);
    const invalid = [
      sel.near([0, 0, 0], -1),
      sel.near([0, 0, 0], 1.5),
      sel.near([Number.NaN, 0, 0], 1),
      sel.thin(-1),
      sel.thin(Number.NaN),
      sel.all().shrink(-1),
      sel.all().grow(0.5),
      sel.all().and(sel.near([0, 0, 0], 0)),
      sel.near([0, 0, 0], -1).toEdges('touching').loop(),
    ];
    for (const selector of invalid) {
      const out = m.bounds(selector);
      expect([selector.description, !out.ok && out.error.code]).toEqual([
        selector.description,
        'model-invalid-argument',
      ]);
      expect(m.count(selector)).toBe(0);
    }
    const op = m.tag(sel.near([0, 0, 0], 0), 'x');
    expect(op.error?.code).toBe('model-invalid-argument');
    expect(op.error?.detail?.count).toBe(0);
  });
});
