import { describe, expect, it } from 'vitest';
import { cos, sin } from '../dmath';
import { type Model, model } from '../model';
import type { Point2 } from '../primitives';
import { sel } from '../selectors';
import { expectContract, sharpEdges } from './contract';

function slab(segments: readonly [number, number, number] = [1, 1, 1]): Model {
  const m = model();
  m.box({ size: [1, 0.2, 1], segments, label: 'slab' });
  return m;
}

const top = () => sel.facing('+y');

describe('panelLine across a plane', () => {
  it('cuts a square groove into the selected faces only', () => {
    const m = slab();
    const op = m.panelLine(
      { faces: top(), point: [0, 0, 0], normal: [1, 0, 0] },
      { width: 0.02, depth: 0.01, label: 'seam' },
    );
    expect(op.status).toBe('ok');
    expect(op.roles).toEqual({ groove: 1, lip: 2 });
    const report = m.validate();
    expect(report.closed).toBe(true);
    expect(report.volume).toBeCloseTo(0.2 - 0.02 * 0.01 * 1, 12);
    const floor = m.bounds(sel.createdBy('seam', 'groove'));
    if (!floor.ok) throw floor.error;
    expect(floor.value.min[1]).toBeCloseTo(0.09, 12);
    expect(floor.value.max[0] - floor.value.min[0]).toBeCloseTo(0.02, 12);
    expect(m.count(sel.facing('-y'))).toBe(1);
    expectContract(m);
  });

  it('runs a closed groove around every face the plane crosses', () => {
    const m = slab();
    const sharp = sharpEdges(m.editMesh);
    const op = m.panelLine(
      { faces: sel.all(), point: [0.1, 0, 0], normal: [1, 0, 0] },
      { width: 0.01, depth: 0.004, label: 'band', material: 'gap' },
    );
    expect(op.roles).toEqual({ groove: 4, lip: 8 });
    expect(m.count(sel.material('gap'))).toBe(12);
    const report = m.validate();
    expect(report.closed).toBe(true);
    expect(report.volume).toBeLessThan(0.2);
    expect(sharpEdges(m.editMesh)).toBeGreaterThanOrEqual(sharp + 16);
    expectContract(m);
  });

  it('sinks V and U profiles without walls and keeps the rim in place', () => {
    for (const profile of ['v', 'u'] as const) {
      const m = slab();
      const op = m.panelLine(
        { faces: top(), point: [0, 0, 0], normal: [0, 0, 1] },
        { width: 0.03, depth: 0.006, profile, label: 'seam' },
      );
      expect(op.status).toBe('ok');
      expect(op.roles).toEqual(profile === 'v' ? { groove: 2 } : { groove: 2, lip: 2 });
      const floor = m.bounds(sel.createdBy('seam'));
      if (!floor.ok) throw floor.error;
      expect(floor.value.min[1]).toBeCloseTo(0.1 - 0.006, 12);
      expect(floor.value.max[2] - floor.value.min[2]).toBeCloseTo(0.03, 12);
      const report = m.validate();
      expect(report.closed).toBe(true);
      const removed = 0.2 - report.volume;
      const expected =
        profile === 'v' ? 0.5 * 0.03 * 0.006 : 0.0075 * 0.006 * (1 + 2 * Math.sqrt(0.75));
      expect(removed).toBeCloseTo(expected, 6);
      expectContract(m);
    }
  });

  it('follows a curved surface with per-vertex depth', () => {
    const m = model();
    m.cylinder({
      radiusTop: 0.1,
      radiusBottom: 0.1,
      height: 0.3,
      radialSegments: 24,
      label: 'can',
    });
    const op = m.panelLine(
      { faces: sel.createdBy('can', 'side'), point: [0, 0, 0], normal: [0, 1, 0] },
      { width: 0.01, depth: 0.003, label: 'ring' },
    );
    expect(op.status).toBe('ok');
    expect(op.roles).toEqual({ groove: 24, lip: 48 });
    expect(op.diagnostics).toBeUndefined();
    const floor = m.bounds(sel.createdBy('ring', 'groove'));
    if (!floor.ok) throw floor.error;
    expect(floor.value.max[0]).toBeCloseTo(0.1 - 0.003 / cos(Math.PI / 24), 12);
    expectContract(m);
  });
});

describe('panelLine along edges', () => {
  it('turns an interior edge into a groove through a flat bevel', () => {
    const m = slab([2, 1, 1]);
    const seam = top().toEdges('contained').and(sel.edges.dihedral('<', 1));
    expect(m.count(seam)).toBe(1);
    const op = m.panelLine(seam, { width: 0.02, depth: 0.005, label: 'seam' });
    expect(op.status).toBe('ok');
    expect(op.roles.groove).toBeGreaterThanOrEqual(1);
    expect(op.roles.lip).toBeGreaterThanOrEqual(2);
    const floor = m.bounds(sel.createdBy('seam', 'groove').and(sel.facing('+y')));
    if (!floor.ok) throw floor.error;
    expect(floor.value.min[1]).toBeCloseTo(0.095, 9);
    expect(floor.value.max[1]).toBeCloseTo(0.095, 9);
    expect(floor.value.max[0] - floor.value.min[0]).toBeCloseTo(0.02, 9);
    const report = m.validate();
    expect(report.closed).toBe(true);
    expect(report.volume).toBeLessThan(0.2);
    expectContract(m);
  });

  it('meets crossing paths in one corner and supports every profile', () => {
    for (const profile of ['square', 'v', 'u'] as const) {
      const m = slab([2, 1, 2]);
      const seams = top().toEdges('contained').and(sel.edges.dihedral('<', 1));
      expect(m.count(seams)).toBe(4);
      const op = m.panelLine(seams, { width: 0.02, depth: 0.004, profile, label: 'cross' });
      expect(op.status).toBe('ok');
      expect(m.validate().closed).toBe(true);
      expect(m.validate().volume).toBeLessThan(0.2);
      expectContract(m);
    }
  });
  it('grooves a closed edge loop and gives every produced face a groove or lip role', () => {
    for (const profile of ['square', 'v', 'u'] as const) {
      const m = model();
      m.box({ size: [0.09, 0.05, 0.007], segments: [3, 3, 1], label: 'cover' });
      const cell = sel
        .createdBy('cover')
        .and(sel.facing('+z'))
        .and(sel.inBox([-0.016, -0.01, -1], [0.016, 0.01, 1]));
      const op = m.panelLine(cell.boundary(), {
        width: 0.0022,
        depth: 0.001,
        profile,
        label: 'seam',
      });
      expect(op.status).toBe('ok');
      const roles = m.inspect().labels.find((l) => l.label === 'seam')?.roles ?? {};
      expect(Object.keys(roles).sort(), profile).toEqual(
        profile === 'v' ? ['groove'] : ['groove', 'lip'],
      );
      expect(roles).toEqual(op.roles);
      expectContract(m);
    }
  });
});

describe('panelLine failures and determinism', () => {
  it('returns structured errors for bad magnitudes, profiles and targets', () => {
    const cases: [string, (m: Model) => void][] = [
      [
        'model-invalid-argument',
        (m) =>
          m.panelLine(
            { faces: top(), point: [0, 0, 0], normal: [1, 0, 0] },
            { width: 0, depth: 0.01 },
          ),
      ],
      [
        'model-invalid-argument',
        (m) =>
          m.panelLine(
            { faces: top(), point: [0, 0, 0], normal: [1, 0, 0] },
            { width: 0.01, depth: -1 },
          ),
      ],
      [
        'model-invalid-argument',
        (m) =>
          m.panelLine(
            { faces: top(), point: [0, 0, 0], normal: [1, 0, 0] },
            { width: 0.01, depth: 0.01, profile: 'w' as never },
          ),
      ],
      [
        'model-invalid-argument',
        (m) =>
          m.panelLine(
            { faces: top(), point: [0, 0, 0], normal: [0, 0, 0] },
            { width: 0.01, depth: 0.01 },
          ),
      ],
      [
        'model-op-no-effect',
        (m) =>
          m.panelLine(
            { faces: top(), point: [5, 0, 0], normal: [1, 0, 0] },
            { width: 0.01, depth: 0.01 },
          ),
      ],
      [
        'model-selection-empty',
        (m) =>
          m.panelLine(
            { faces: sel.tag('none'), point: [0, 0, 0], normal: [1, 0, 0] },
            { width: 0.01, depth: 0.01 },
          ),
      ],
    ];
    for (const [code, run] of cases) {
      const m = slab();
      run(m);
      expect(m.poisoned?.code, code).toBe(code);
    }
    const open = model();
    open.plane({ width: 1, height: 1, widthSegments: 2 });
    open.panelLine(sel.edges.meshBoundary(), { width: 0.01, depth: 0.01 });
    expect(open.poisoned?.code).toBe('model-precondition');
  });

  it('is deterministic', () => {
    const build = () => {
      const m = slab([2, 1, 2]);
      m.panelLine(
        { faces: sel.all(), point: [0.13, 0, 0], normal: [1, 0, 0.2] },
        { width: 0.01, depth: 0.003, profile: 'u' },
      );
      m.panelLine(top().toEdges('contained').and(sel.edges.dihedral('<', 1)), {
        width: 0.012,
        depth: 0.002,
        profile: 'v',
      });
      return m.snapshot();
    };
    expect(build()).toEqual(build());
  });
});

function circle(radius: number, n: number, cx = 0, cy = 0): Point2[] {
  return Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n;
    return [cx + radius * cos(a), cy + radius * sin(a)] as Point2;
  });
}

describe('extrudePolygon holes', () => {
  it('extrudes an outline with several holes into one closed solid', () => {
    const m = model();
    const square: Point2[] = [
      [-1, -0.5],
      [1, -0.5],
      [1, 0.5],
      [-1, 0.5],
    ];
    const op = m.extrudePolygon({
      points: square,
      holes: [circle(0.2, 16, -0.5), circle(0.2, 16, 0.5).reverse()],
      depth: 0.1,
      label: 'plate',
    });
    expect(op.status).toBe('ok');
    expect(op.roles.side).toBe(4);
    expect(op.roles.hole).toBe(32);
    expect(op.roles.top).toBe(op.roles.bottom);
    const report = m.validate();
    expect(report.closed).toBe(true);
    const holeArea = 2 * 0.5 * 16 * 0.04 * sin((2 * Math.PI) / 16);
    expect(report.volume).toBeCloseTo((2 - holeArea) * 0.1, 12);
    expect(m.count(sel.createdBy('plate', 'top').and(sel.facing('+z')))).toBe(
      op.roles.top as number,
    );
    expectContract(m);
  });

  it('partitions a toothed ring into convex caps', () => {
    const teeth: Point2[] = [];
    for (let i = 0; i < 24; i++) {
      for (const [r, da] of [
        [1, -0.05],
        [1.2, -0.03],
        [1.2, 0.03],
        [1, 0.05],
      ] as const) {
        const a = (2 * Math.PI * i) / 24 + da;
        teeth.push([r * cos(a), r * sin(a)]);
      }
    }
    const m = model();
    m.extrudePolygon({ points: teeth, holes: [circle(0.4, 32)], depth: 0.2 });
    const report = m.validate();
    expect(report.closed).toBe(true);
    expect(report.issues.filter((i) => i.severity !== 'info')).toEqual([]);
    expectContract(m);
  });

  it('rejects holes outside the outline, crossing it or nested in another hole', () => {
    const square: Point2[] = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    for (const holes of [
      [circle(0.1, 8, 3, 3)],
      [circle(0.3, 8, 0.9, 0.5)],
      [circle(0.3, 8, 0.5, 0.5), circle(0.1, 8, 0.5, 0.5)],
      [
        [
          [0.2, 0.2],
          [0.2, 0.2],
          [0.3, 0.3],
        ] as Point2[],
      ],
    ]) {
      const m = model();
      m.extrudePolygon({ points: square, holes, depth: 1 });
      expect(['model-invalid-argument', 'model-degenerate']).toContain(m.poisoned?.code);
    }
  });
});
