import { describe, expect, it } from 'vitest';
import { type Model, model } from '../model';
import { sel } from '../selectors';
import { expectContract } from './contract';

function plate(segments = 10): Model {
  const m = model();
  m.plane({ width: 0.1, height: 0.1, widthSegments: segments, heightSegments: segments, tag: 'p' });
  return m;
}

/** Closed, and no face pair crossing or touching apart from its neighbors. */
function expectClean(m: Model): void {
  const report = m.validate();
  expect(report.closed).toBe(true);
  expect(report.issues).toEqual([]);
  expectContract(m);
}

const FLANGE = { reach: 0.012, depth: 0.004 } as const;

describe('shell return flange', () => {
  it('folds every open edge of a plate under it, keeping the thickness through the fold', () => {
    const m = plate();
    const op = m.shell(sel.tag('p'), { thickness: 0.001, flange: FLANGE, label: 'hem' });
    expect(op.status).toBe('ok');
    expect(op.roles).toEqual({ inner: 100, flange: 184 });
    expectClean(m);
    expect(m.count(sel.createdBy('hem', 'flange'))).toBe(184);
  });

  it('caps the fold where it meets a plain rim, at a corner or along a straight edge', () => {
    for (const box of [
      [
        [-1, 0.04, -1],
        [1, 1, 1],
      ],
      [
        [-0.02, 0.04, -1],
        [0.02, 1, 1],
      ],
    ] as [number, number, number][][]) {
      const m = plate();
      const [min, max] = box as [[number, number, number], [number, number, number]];
      const at = sel.tag('p').and(sel.inBox(min, max, { by: 'centroid' }));
      const op = m.shell(sel.tag('p'), { thickness: 0.001, flange: { ...FLANGE, at } });
      expect(op.status).toBe('ok');
      expect(op.roles?.rim).toBeGreaterThan(0);
      expectClean(m);
    }
  });

  it('follows creased panels and inner corners', () => {
    for (const degrees of [30, -30, 90, -90]) {
      const m = plate();
      m.rotate(
        sel.tag('p').and(sel.inBox([0.04, -1, -1], [1, 1, 1], { by: 'all' })),
        'y',
        degrees,
        [0.04, 0, 0],
      );
      const op = m.shell(sel.tag('p'), {
        thickness: 0.001,
        flange: { reach: 0.03, depth: 0.004 },
      });
      expect(op.status, `${degrees}`).toBe('ok');
      expectClean(m);
    }
    const l = plate();
    l.delete(sel.tag('p').and(sel.inBox([0, 0, -1], [1, 1, 1], { by: 'all' })));
    expect(l.shell(sel.tag('p'), { thickness: 0.001, flange: FLANGE }).status).toBe('ok');
    expectClean(l);
  });

  it('refuses a flange deeper than a tight bend leaves room for, naming the depth that fits', () => {
    const m = plate();
    m.rotate(
      sel.tag('p').and(sel.inBox([0.04, -1, -1], [1, 1, 1], { by: 'all' })),
      'y',
      150,
      [0.04, 0, 0],
    );
    const op = m.shell(sel.tag('p'), { thickness: 0.001, flange: { reach: 0.03, depth: 0.012 } });
    expect(op.status).toBe('failed');
    expect(op.error?.code).toBe('model-precondition');
    const maxDepth = (op.error?.detail as { maxDepth: number }).maxDepth;
    expect(maxDepth).toBeGreaterThan(0.001);
    expect(maxDepth).toBeLessThan(0.012);
    const retry = plate();
    retry.rotate(
      sel.tag('p').and(sel.inBox([0.04, -1, -1], [1, 1, 1], { by: 'all' })),
      'y',
      150,
      [0.04, 0, 0],
    );
    const fits = retry.shell(sel.tag('p'), {
      thickness: 0.001,
      flange: { reach: 0.03, depth: maxDepth * 0.9 },
    });
    expect(fits.status).toBe('ok');
    expect(retry.validate().closed).toBe(true);
  });

  it('refuses a flange that ends at a concave corner, pointing at the corner', () => {
    const m = plate();
    m.delete(sel.tag('p').and(sel.inBox([0, 0, -1], [1, 1, 1], { by: 'all' })));
    // The notch's lower edge folds; its left edge stays plain: they meet at (0, 0).
    const op = m.shell(sel.tag('p'), {
      thickness: 0.001,
      flange: {
        ...FLANGE,
        at: sel.tag('p').and(sel.inBox([0, -1, -1], [1, 0, 1], { by: 'centroid' })),
      },
    });
    expect(op.status).toBe('failed');
    expect(op.error?.code).toBe('model-precondition');
    const point = (op.error?.detail as { point: number[] }).point;
    expect(point[0]).toBeCloseTo(0, 9);
    expect(point[1]).toBeCloseTo(0, 9);
  });

  it('refuses a fold over a ring narrower than the thickness, naming its width', () => {
    const m = plate();
    // The column next to x = -0.05 narrows to 0.5 mm.
    const rest = sel.tag('p').and(sel.inBox([-0.04, -1, -1], [1, 1, 1], { by: 'centroid' }));
    expect(m.scale(sel.toVerts(rest, 'touching'), [0.0995 / 0.09, 1, 1], [0.05, 0, 0]).status).toBe(
      'ok',
    );
    const op = m.shell(sel.tag('p'), { thickness: 0.001, flange: FLANGE });
    expect(op.status).toBe('failed');
    expect(op.error?.code).toBe('model-precondition');
    expect((op.error?.detail as { width: number }).width).toBeCloseTo(0.0005, 9);
    const thin = plate();
    thin.scale(sel.toVerts(rest, 'touching'), [0.0995 / 0.09, 1, 1], [0.05, 0, 0]);
    expect(thin.shell(sel.tag('p'), { thickness: 0.0004, flange: FLANGE }).status).toBe('ok');
    expectClean(thin);
  });

  it('refuses a reach past the panel and a flange with no open edge (B15 audit A11)', () => {
    // 0.1 m plate: a flange from every edge reaching 0.06 m, or one from the right edge
    // reaching 0.2 m, covers the whole panel; both used to pass silently.
    for (const [flange, panelReach] of [
      [{ ...FLANGE, reach: 0.06 }, 0.05],
      [
        [
          {
            ...FLANGE,
            reach: 0.2,
            at: sel.tag('p').and(sel.inBox([0.04, -1, -1], [1, 1, 1], { by: 'centroid' })),
          },
          {
            ...FLANGE,
            at: sel.tag('p').and(sel.inBox([-1, -1, -1], [0.04, 1, 1], { by: 'centroid' })),
          },
        ],
        0.1,
      ],
    ] as const) {
      const m = plate();
      const op = m.shell(sel.tag('p'), { thickness: 0.001, flange, label: 'hem' });
      expect(op.error?.code).toBe('model-precondition');
      expect(op.error?.detail?.panelReach).toBeCloseTo(panelReach, 9);
    }
    const near = plate();
    expect(
      near.shell(sel.tag('p'), { thickness: 0.001, flange: { ...FLANGE, reach: 0.045 } }).status,
    ).toBe('ok');
    // `at` on interior faces only: no open edge gets this flange.
    const interior = sel
      .tag('p')
      .and(sel.inBox([-0.02, -0.02, -1], [0.02, 0.02, 1], { by: 'centroid' }));
    for (const extra of [{}, { radius: 0.001 }]) {
      const m = plate();
      const op = m.shell(sel.tag('p'), {
        thickness: 0.001,
        flange: { ...FLANGE, ...extra, at: interior },
      });
      expect(op.error?.code).toBe('model-invalid-argument');
      expect(op.error?.detail?.flange).toBe(0);
    }
  });

  it('checks its arguments', () => {
    const shallow = plate().shell(sel.tag('p'), {
      thickness: 0.002,
      flange: { reach: 0.01, depth: 0.001 },
    });
    expect(shallow.error?.code).toBe('model-invalid-argument');
    const reach = plate().shell(sel.tag('p'), {
      thickness: 0.001,
      flange: { reach: 0, depth: 0.004 },
    });
    expect(reach.error?.code).toBe('model-invalid-argument');
  });

  it('builds clean flanges on random creased and notched panels, or names the depth that fits', () => {
    let seed = 11;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    let built = 0;
    for (let trial = 0; trial < 10; trial++) {
      const segments = 6 + Math.floor(random() * 6);
      const m = plate(segments);
      // A crease on a grid line, so the faces stay planar.
      const x = -0.05 + (0.1 * (1 + Math.floor(random() * (segments - 1)))) / segments;
      expect(
        m.rotate(
          sel.tag('p').and(sel.inBox([x - 1e-9, -1, -1], [1, 1, 1], { by: 'all' })),
          'y',
          -120 + random() * 240,
          [x, 0, 0],
        ).status,
      ).toBe('ok');
      if (random() < 0.5) {
        m.delete(sel.tag('p').and(sel.inBox([-1, 0.02, -1], [-0.02, 1, 1], { by: 'centroid' })));
      }
      const thickness = 0.0005 + random() * 0.001;
      const flange = {
        reach: 0.01 + random() * 0.02,
        depth: thickness * (1.5 + random() * 4),
        ...(random() < 0.5
          ? {
              at: sel
                .tag('p')
                .and(sel.inBox([-1, -1, -1], [1, random() * 0.05, 1], { by: 'centroid' })),
            }
          : {}),
      };
      const op = m.shell(sel.tag('p'), { thickness, flange });
      if (op.status === 'failed') {
        expect(op.error?.code, `trial ${trial}`).toBe('model-precondition');
        continue;
      }
      built++;
      const report = m.validate();
      expect(report.closed, `trial ${trial}`).toBe(true);
      expect(report.issues, `trial ${trial}`).toEqual([]);
    }
    expect(built).toBeGreaterThanOrEqual(6);
  });
});
