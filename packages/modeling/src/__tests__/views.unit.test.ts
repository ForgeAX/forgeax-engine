import { describe, expect, it } from 'vitest';
import { cross } from '../geom';
import {
  type CurveSpec,
  captureModels,
  type Drawing,
  decodeSnapshot,
  evenOddFill,
  evenOddHatch,
  explodeMesh,
  fromView,
  meshVolume,
  model,
  ORTHO_VIEW_NAMES,
  ORTHO_VIEWS,
  type OrthoView,
  outlineDeviation,
  planeFrame,
  resolveCurveSpec,
  type Segment2,
  sectionSegments,
  toView,
} from '../index';

const circle = (r: number, n: number, cx = 0, cy = 0): [number, number][] =>
  Array.from({ length: n }, (_, i) => [
    cx + r * Math.cos((2 * Math.PI * i) / n),
    cy + r * Math.sin((2 * Math.PI * i) / n),
  ]);

/** One closed construction curve per ortho view; the item id is the view name. */
const sheet = (curves: readonly (readonly [OrthoView, CurveSpec])[]): Drawing => ({
  name: 'test sheet',
  views: curves.map(([view]) => ({ id: `${view} view`, ortho: view })),
  items: curves.map(([view, curve]) => ({
    id: view,
    view: `${view} view`,
    role: 'construction',
    kind: 'curve',
    closed: true,
    curve,
  })),
});

const ring = (points: readonly (readonly [number, number])[]): Segment2[] =>
  points.map((p, i) => [p, points[(i + 1) % points.length] as readonly [number, number]]);

describe('ortho view frames', () => {
  it('are right-handed and invert through fromView', () => {
    for (const view of ORTHO_VIEW_NAMES) {
      const f = ORTHO_VIEWS[view];
      expect(cross(f.right, f.up).map((c) => c + 0)).toEqual(f.toward);
      const p = fromView(view, [0.3, -1.2], 0.7);
      expect(toView(view, p).map((c) => Math.round(c * 1e9) / 1e9)).toEqual([0.3, -1.2, 0.7]);
    }
    // The side view reads the nose (+Z) on the left: u = -z.
    expect(toView('right', [0, 0, 2])[0]).toBe(-2);
    expect(toView('top', [0, 0, 2])[1]).toBe(-2);
  });
});

describe('contours', () => {
  it('samples a spline within its tolerance and orients it counter-clockwise', () => {
    const square: [number, number][] = [
      [1, 1],
      [-1, 1],
      [-1, -1],
      [1, -1],
    ];
    const coarse = resolveCurveSpec(
      { kind: 'spline', points: square },
      { closed: true, tolerance: 0.05 },
    );
    const fine = resolveCurveSpec(
      { kind: 'spline', points: [...square].reverse() },
      { closed: true, tolerance: 0.001 },
    );
    if (!coarse.ok || !fine.ok) throw new Error('spline failed');
    expect(fine.value.points.length).toBeGreaterThan(coarse.value.points.length);
    // The fine sampling of the same spline stays within the coarse tolerance of it.
    expect(outlineDeviation(fine.value.points, coarse.value.points)).toBeLessThanOrEqual(
      0.05 + 1e-9,
    );
    let area = 0;
    const pts = fine.value.points;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i] as readonly [number, number];
      const b = pts[(i + 1) % pts.length] as readonly [number, number];
      area += a[0] * b[1] - b[0] * a[1];
    }
    expect(area).toBeGreaterThan(0);
    // Interpolating: the control points stay on the outline.
    for (const p of square) expect(fine.value.points).toContainEqual(p);
  });

  it('fits dense samples to few points within the tolerance', () => {
    const samples = circle(1, 720);
    for (const smooth of [false, true]) {
      const fit = resolveCurveSpec(
        { kind: 'fit', points: samples, smooth },
        { closed: true, tolerance: 0.004 },
      );
      if (!fit.ok) throw fit.error;
      expect(fit.value.deviation).toBeLessThanOrEqual(0.004);
      expect(fit.value.points.length).toBeLessThan(samples.length / 4);
      expect(outlineDeviation(samples, fit.value.points)).toBeCloseTo(fit.value.deviation, 12);
    }
  });

  it('rejects bad specs with structured errors', () => {
    const bad = (spec: unknown) => {
      const r = resolveCurveSpec(spec as never, { closed: true });
      return r.ok ? 'ok' : r.error.code;
    };
    expect(bad({ kind: 'bezier', points: circle(1, 4) })).toBe('model-invalid-argument');
    expect(
      bad({
        kind: 'polyline',
        points: [
          [0, 0],
          [1, 1],
        ],
      }),
    ).toBe('model-invalid-argument');
    expect(
      bad({
        kind: 'polyline',
        points: [
          [0, 0],
          [1, 1],
          [2, 2],
        ],
      }),
    ).toBe('model-degenerate');
    expect(
      bad({
        kind: 'polyline',
        points: [
          [0, 0],
          [1, Number.NaN],
          [2, 2],
        ],
      }),
    ).toBe('model-invalid-argument');
  });

  it('extrudes along the view axis between the view depths', () => {
    const m = model();
    const side = sheet([
      [
        'right',
        {
          kind: 'polyline',
          points: [
            [-2, 0],
            [2, 0],
            [2, 1],
            [-2, 1],
          ],
        },
      ],
    ]);
    m.extrudeContour(side, 'right', { depth: [-0.5, 0.5], tag: 'side' });
    expect(m.poisoned).toBeUndefined();
    const report = m.validate();
    expect(report.closed).toBe(true);
    expect(meshVolume(m.editMesh)).toBeCloseTo(4, 9);
    const xs = m.editMesh.vertices().map((v) => m.editMesh.position(v));
    // Side view: u = -z spans the length on Z, depth spans X.
    expect(Math.min(...xs.map((p) => p[2]))).toBeCloseTo(-2, 12);
    expect(Math.max(...xs.map((p) => p[0]))).toBeCloseTo(0.5, 12);
    expect(m.diagnostics().contours).toHaveLength(1);
    m.extrudeContour(sheet([['top', { kind: 'polyline', points: circle(1, 6) }]]), 'top', {
      depth: [1, 1],
    });
    expect(m.poisoned?.code).toBe('model-invalid-argument');
  });

  it('extrudes only closed curve items of ortho views', () => {
    const open: Drawing = {
      name: 'open',
      views: [{ id: 'side', ortho: 'right' }],
      items: [
        {
          id: 'belt',
          view: 'side',
          role: 'feature',
          kind: 'curve',
          curve: { kind: 'polyline', points: circle(1, 6) },
        },
      ],
    };
    for (const [d, id] of [
      [open, 'belt'],
      [open, 'missing'],
    ] as const) {
      const m = model();
      m.extrudeContour(d, id, { depth: [0, 1] });
      expect(m.poisoned?.code).toBe('model-invalid-argument');
    }
  });
});

describe('captured steps', () => {
  it('keep the state after every successful operation only when asked', async () => {
    const build = () => {
      const m = model();
      m.box({ size: [1, 1, 1] });
      m.extrudeContour(sheet([['front', { kind: 'polyline', points: circle(0.2, 8) }]]), 'front', {
        depth: [0.5, 0.8],
      });
      return m;
    };
    const plain = await captureModels(build);
    const stepped = await captureModels(build, { steps: true });
    if (!plain.ok || !stepped.ok) throw new Error('capture failed');
    expect(plain.value.sessions[0]?.diagnostics().steps).toEqual([]);
    const steps = stepped.value.sessions[0]?.diagnostics().steps ?? [];
    expect(steps.map((s) => s.opIndex)).toEqual([0, 1]);
    const first = decodeSnapshot(steps[0]?.snapshot as Uint8Array);
    expect(first.ok && first.value.faceCount).toBe(6);
    expect(stepped.value.sessions[0]?.diagnostics().stepsTruncated).toBe(false);
  });
});

describe('section and explode geometry', () => {
  it('fills nested outlines even-odd and hatches only the material', () => {
    const outer = ring(circle(1, 64));
    const inner = ring(circle(0.5, 48).reverse());
    const filled = evenOddFill([...outer, ...inner]);
    if (!filled.ok) throw filled.error;
    let area = 0;
    const t = filled.value;
    for (let i = 0; i < t.length; i += 3) {
      const [a, b, c] = [t[i], t[i + 1], t[i + 2]] as [
        readonly [number, number],
        readonly [number, number],
        readonly [number, number],
      ];
      const twice = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      expect(twice).toBeGreaterThan(0);
      area += twice / 2;
    }
    const polygon = (r: number, n: number) => (n * r * r * Math.sin((2 * Math.PI) / n)) / 2;
    expect(area).toBeCloseTo(polygon(1, 64) - polygon(0.5, 48), 9);
    const hatch = evenOddHatch([...outer, ...inner], 0.1, 45);
    if (!hatch.ok) throw hatch.error;
    for (const [a, b] of hatch.value) {
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] as const;
      const r = Math.hypot(mid[0], mid[1]);
      expect(r).toBeGreaterThan(0.49);
      expect(r).toBeLessThan(1.001);
    }
  });

  it('outlines a plane cut with the boundary edges on the plane', () => {
    const m = model();
    m.box({ size: [2, 1, 1] });
    m.planeCut({ point: [0.25, 0, 0], normal: [1, 0, 0], keep: 'negative' });
    const frame = planeFrame([0.25, 0, 0], [1, 0, 0]);
    const segments = sectionSegments(m.editMesh, frame, 1e-6);
    expect(segments).toHaveLength(4);
    const filled = evenOddFill(segments);
    if (!filled.ok) throw filled.error;
    expect(filled.value.length).toBeGreaterThan(0);
  });

  it('moves parts apart along authored or computed directions', () => {
    const m = model();
    m.box({ size: [1, 1, 1], tag: 'body' });
    m.box({ size: [0.2, 0.2, 0.2], center: [0, 0.8, 0], tag: 'cap' });
    m.box({ size: [0.2, 0.2, 0.2], center: [0.9, 0, 0], tag: 'side' });
    const moved = explodeMesh(m.editMesh, {
      by: 'tag',
      distance: 0.5,
      directions: { side: [0, 0, 2] },
    });
    if (!moved.ok) throw moved.error;
    const parts = Object.fromEntries(moved.value.parts.map((p) => [p.name, p]));
    expect(parts.side?.offset).toEqual([0, 0, 0.5]);
    expect(parts.side?.authored).toBe(true);
    expect(parts.cap?.offset[1]).toBeGreaterThan(0.4);
    expect(moved.value.mesh.faceCount).toBe(m.editMesh.faceCount);
    expect(meshVolume(moved.value.mesh)).toBeCloseTo(meshVolume(m.editMesh), 9);
    const islands = explodeMesh(m.editMesh, { by: 'island', distance: 1 });
    expect(islands.ok && islands.value.parts.length).toBe(3);
    const unknown = explodeMesh(m.editMesh, {
      by: 'tag',
      distance: 1,
      directions: { wing: [1, 0, 0] },
    });
    expect(unknown.ok ? '' : unknown.error.code).toBe('model-selection-empty');
  });
});

describe('three-view intersection', () => {
  it('intersects the view prisms: three circles give the tricylinder', () => {
    const m = model();
    const views = ['right', 'top', 'front'] as const;
    m.threeView(
      sheet(views.map((view) => [view, { kind: 'polyline', points: circle(1, 48) }])),
      views,
      {
        label: 'hull',
      },
    );
    expect(m.poisoned).toBeUndefined();
    expect(m.validate().closed).toBe(true);
    // Steinmetz tricylinder 8 (2 - sqrt 2) r^3; 48-gon inscribed circles shrink it slightly.
    const volume = meshVolume(m.editMesh);
    expect(volume).toBeGreaterThan(8 * (2 - Math.SQRT2) * 0.97);
    expect(volume).toBeLessThan(8 * (2 - Math.SQRT2));
    expect(m.journal.map((e) => e.op)).toEqual([
      'extrudeContour',
      'extrudeContour',
      'intersection',
      'extrudeContour',
      'intersection',
    ]);
    expect(m.inspect().tags).toEqual(['view-right', 'view-top', 'view-front']);
  });

  it('returns the failing step, not a later skipped one', () => {
    // A 1 mm slot in the third view closes once that outline grows by 2 x 0.5 mm.
    const rect = (w: number, h: number): [number, number][] => [
      [-w / 2, -h / 2],
      [w / 2, -h / 2],
      [w / 2, h / 2],
      [-w / 2, h / 2],
    ];
    const slot: [number, number][] = [
      [-0.5, -0.25],
      [0.5, -0.25],
      [0.5, 0.25],
      [0.0005, 0.25],
      [0.0005, 0.05],
      [-0.0005, 0.05],
      [-0.0005, 0.25],
      [-0.5, 0.25],
    ];
    const m = model();
    const report = m.threeView(
      sheet([
        ['right', { kind: 'polyline', points: rect(0.8, 0.5) }],
        ['top', { kind: 'polyline', points: rect(1, 0.8) }],
        ['front', { kind: 'polyline', points: slot }],
      ]),
      ['right', 'top', 'front'],
    );
    expect(report).toMatchObject({ op: 'extrudeContour', status: 'failed' });
    expect(report.error?.code).toBe(m.poisoned?.code);
  });

  it('needs two or three distinct view axes', () => {
    const m = model();
    const square = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as [number, number][];
    m.threeView(
      sheet([
        ['front', { kind: 'polyline', points: square }],
        ['back', { kind: 'polyline', points: square }],
      ]),
      ['front', 'back'],
    );
    expect(m.poisoned?.code).toBe('model-invalid-argument');
    const two = model();
    two.threeView(
      sheet([
        ['right', { kind: 'polyline', points: square }],
        ['top', { kind: 'polyline', points: circle(1, 24) }],
      ]),
      ['right', 'top'],
    );
    expect(two.poisoned).toBeUndefined();
    // A cylinder along Y: the top circle, grown by the 0.5 mm clearance, through the
    // side square's height.
    const perimeter = 48 * Math.sin(Math.PI / 24);
    expect(meshVolume(two.editMesh)).toBeCloseTo(
      2 * (12 * Math.sin((2 * Math.PI) / 24) + perimeter * 0.0005),
      4,
    );
  });
});
