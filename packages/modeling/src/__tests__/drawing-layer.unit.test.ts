import { describe, expect, it } from 'vitest';
import {
  type Drawing,
  type DrawingItem,
  drawingCurve3,
  drawingDxf,
  drawingSvg,
  drawingViewFrame,
  fromView,
  model,
  nurbs,
  resolveCurveSpec,
  resolveDrawing,
  toView,
} from '../index';

function svgOf(...args: Parameters<typeof drawingSvg>): string {
  const r = drawingSvg(...args);
  if (!r.ok) throw r.error;
  return r.value;
}

function dxfOf(...args: Parameters<typeof drawingDxf>): string {
  const r = drawingDxf(...args);
  if (!r.ok) throw r.error;
  return r.value;
}

const square: [number, number][] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

const drawing: Drawing = {
  name: 'test sheet',
  sources: [{ title: 'public spec sheet', url: 'https://example.com/spec' }],
  views: [
    { id: 'side', ortho: 'right' },
    { id: 'plan', ortho: 'top' },
    { id: 'z1', section: { axis: 'z', at: 1 } },
  ],
  items: [
    {
      id: 'outline',
      view: 'side',
      role: 'silhouette',
      kind: 'curve',
      curve: { kind: 'spline', points: square },
      closed: true,
      tolerance: 0.001,
    },
    {
      id: 'belt@side',
      view: 'side',
      role: 'feature',
      link: 'belt',
      kind: 'curve',
      curve: {
        kind: 'polyline',
        points: [
          [-1, 0.5],
          [1, 0.6],
        ],
      },
    },
    {
      id: 'belt@plan',
      view: 'plan',
      role: 'feature',
      link: 'belt',
      kind: 'curve',
      curve: {
        kind: 'fit',
        points: Array.from({ length: 21 }, (_, i): [number, number] => [
          0.8 + 0.0005 * Math.sin(i),
          -1 + i / 10,
        ]),
      },
    },
    {
      id: 'arch',
      view: 'side',
      role: 'package',
      kind: 'curve',
      curve: { kind: 'arc', center: [0, 0.35], radius: 0.4, from: 0, to: Math.PI },
    },
    {
      id: 'wheel',
      view: 'side',
      role: 'package',
      kind: 'point',
      at: [0, 0.35],
      depth: 0.8,
      basis: 'public',
    },
    { id: 'nose', view: 'side', role: 'package', kind: 'point', at: [-2, 0] },
    { id: 'tail', view: 'side', role: 'package', kind: 'point', at: [2, 0] },
    {
      id: 'length',
      view: 'side',
      role: 'package',
      kind: 'dimension',
      measure: 'distance',
      refs: ['nose', 'tail'],
      value: 4,
      basis: 'public',
    },
    {
      id: 'axle-height',
      view: 'side',
      role: 'package',
      kind: 'dimension',
      measure: 'dy',
      refs: ['wheel'],
      value: 0.35,
    },
    {
      id: 'arch-radius',
      view: 'side',
      role: 'package',
      kind: 'dimension',
      measure: 'radius',
      refs: ['arch'],
      value: 0.4,
    },
    {
      id: 'clearance',
      view: 'side',
      role: 'package',
      kind: 'dimension',
      measure: 'dy',
      refs: [],
      value: 0.12,
      basis: 'estimate',
    },
    {
      id: 'shut',
      view: 'z1',
      role: 'section',
      kind: 'curve',
      curve: {
        kind: 'nurbs',
        curve: {
          degree: 2,
          points: [
            [0, 0, 0],
            [0.5, 1, 0],
            [1, 0, 0],
          ],
          knots: [0, 0, 0, 1, 1, 1],
        },
      },
      tolerance: 0.0005,
    },
    {
      id: 'cowl',
      view: 'plan',
      role: 'break',
      kind: 'curve',
      curve: {
        kind: 'polyline',
        points: [
          [0, -1],
          [0.8, -1],
        ],
      },
    },
    {
      id: 'why',
      view: 'side',
      role: 'construction',
      kind: 'note',
      refs: ['belt@side'],
      text: 'belt sits on the shoulder',
    },
  ],
};

describe('design drawings', () => {
  it('samples every curve kind within its tolerance', () => {
    const r = resolveDrawing(drawing);
    if (!r.ok) throw r.error;
    const curve = (id: string) => r.value.curves.find((c) => c.id === id)?.points ?? [];
    // A closed spline item samples exactly as its curve spec.
    const contour = resolveCurveSpec(
      { kind: 'spline', points: square },
      { closed: true, tolerance: 0.001 },
    );
    if (!contour.ok) throw contour.error;
    expect(new Set(curve('outline').map((p) => p.join()))).toEqual(
      new Set(contour.value.points.map((p) => p.join())),
    );
    expect(curve('belt@side')).toEqual([
      [-1, 0.5],
      [1, 0.6],
    ]);
    // The open fit keeps its ends and drops the 0.5 mm wiggle.
    const fit = curve('belt@plan');
    expect(fit[0]?.[1]).toBeCloseTo(-1, 12);
    expect(fit.at(-1)?.[1]).toBeCloseTo(1, 12);
    expect(fit.length).toBeLessThan(21);
    for (const p of curve('arch')) expect(Math.hypot(p[0], p[1] - 0.35)).toBeCloseTo(0.4, 12);
    const arch = curve('arch');
    for (let i = 1; i < arch.length; i++) {
      const [a, b] = [arch[i - 1] as readonly number[], arch[i] as readonly number[]];
      const mid = Math.hypot(
        ((a[0] as number) + (b[0] as number)) / 2,
        ((a[1] as number) + (b[1] as number)) / 2 - 0.35,
      );
      expect(0.4 - mid).toBeLessThanOrEqual(0.002);
    }
    const nc = drawing.items.find((i) => i.id === 'shut');
    if (nc?.kind !== 'curve' || nc.curve.kind !== 'nurbs') throw new Error('fixture');
    const shut = curve('shut');
    for (let i = 1; i < shut.length; i++) {
      // Every sample lies on the curve; chords stay within the tolerance of its midpoints.
      const [a, b] = [
        shut[i - 1] as readonly [number, number],
        shut[i] as readonly [number, number],
      ];
      expect(Math.abs((a[0] as number) * 2 * (1 - (a[0] as number)) - a[1])).toBeLessThan(1e-12);
      expect(b[0]).toBeGreaterThan(a[0]);
    }
    const t = 0.37;
    const p = nurbs.point(nc.curve.curve, t);
    const near = Math.min(...shut.map((q) => Math.hypot(q[0] - p[0], q[1] - p[1])));
    expect(near).toBeLessThan(0.05);
  });

  it('derives dimension spans from their refs', () => {
    const r = resolveDrawing(drawing);
    if (!r.ok) throw r.error;
    const dim = (id: string) => r.value.dimensions.find((d) => d.id === id);
    expect([dim('length')?.from, dim('length')?.to]).toEqual([
      [-2, 0],
      [2, 0],
    ]);
    expect([dim('axle-height')?.from, dim('axle-height')?.to]).toEqual([
      [0, 0],
      [0, 0.35],
    ]);
    expect(dim('arch-radius')?.from).toEqual([0, 0.35]);
    expect(dim('clearance')?.from).toBeUndefined();
    expect(dim('clearance')?.basis).toBe('estimate');
  });

  it('maps view coordinates to world points through the view frames, sections at their station', () => {
    const side = drawingViewFrame({ id: 's', ortho: 'right' });
    expect(side.depth).toBe(0);
    expect(fromView(side.frame, [-1.2, 0.5], 0.8)).toEqual([0.8, 0.5, 1.2]);
    expect(toView(side.frame, [0.8, 0.5, 1.2])).toEqual([-1.2, 0.5, 0.8]);
    expect(fromView('right', [-1.2, 0.5], 0.8)).toEqual([0.8, 0.5, 1.2]);
    for (const [axis, k] of [
      ['x', 0],
      ['y', 1],
      ['z', 2],
    ] as const) {
      const station = drawingViewFrame({ id: 'q', section: { axis, at: 1.4 } });
      const p = fromView(station.frame, [0.6, 0.9], station.depth);
      expect(p[k]).toBeCloseTo(1.4, 12);
      expect(toView(station.frame, p).slice(0, 2)).toEqual([0.6, 0.9]);
    }
  });

  it('attaches to a session without changing the mesh', () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    const before = m.snapshot();
    expect(m.drawing(drawing).status).toBe('ok');
    expect(m.snapshot()).toEqual(before);
    expect(m.diagnostics().drawings[0]?.name).toBe('test sheet');
  });

  it('rejects malformed drawings with structured errors', () => {
    const bad = (d: unknown) => {
      const r = resolveDrawing(d as Drawing);
      return r.ok ? 'ok' : r.error.code;
    };
    const items = drawing.items;
    expect(bad({ ...drawing, image: 'data:image/png;base64,AAAA' })).toBe('model-invalid-argument');
    expect(bad({ ...drawing, items: [{ ...items[5], pixels: [1, 2] }] })).toBe(
      'model-invalid-argument',
    );
    expect(bad({ ...drawing, items: [items[5], items[5]] })).toBe('model-invalid-argument');
    // Views and items share one id namespace; the error names the first holder and how to fix it.
    const clash = resolveDrawing({
      ...drawing,
      items: [{ ...items[5], id: 'side' } as DrawingItem],
    });
    expect(clash.ok ? undefined : clash.error).toMatchObject({
      code: 'model-invalid-argument',
      detail: { at: 'items[0]', id: 'side', first: 'views[0]' },
    });
    expect(clash.ok ? '' : `${clash.error.expected} ${clash.error.hint}`).toMatch(
      /already the id of view views\[0\].*rename/,
    );
    expect(bad({ ...drawing, items: [{ ...items[5], view: 'iso' }] })).toBe(
      'model-invalid-argument',
    );
    expect(bad({ ...drawing, items: [{ ...items[5], role: 'hatch' }] })).toBe(
      'model-invalid-argument',
    );
    expect(bad({ ...drawing, items: [items[5], { ...items[7], refs: ['nose', 'missing'] }] })).toBe(
      'model-invalid-argument',
    );
    expect(
      bad({
        ...drawing,
        items: [
          { ...items[1], id: 'a' },
          { ...items[1], id: 'b' },
        ],
      }),
    ).toBe('model-invalid-argument');
    expect(
      bad({ ...drawing, views: [{ id: 'q', section: { axis: 'w', at: 0 } }], items: [] }),
    ).toBe('model-invalid-argument');
    expect(
      bad({
        ...drawing,
        items: [
          {
            id: 'c',
            view: 'side',
            role: 'feature',
            kind: 'curve',
            curve: {
              kind: 'nurbs',
              curve: {
                degree: 1,
                points: [
                  [0, 0, 0],
                  [1, 0, 0.1],
                ],
                knots: [0, 0, 1, 1],
              },
            },
          },
        ],
      }),
    ).toBe('model-invalid-argument');
    expect(
      bad({
        ...drawing,
        items: [{ ...items[3], curve: { kind: 'arc', center: [0, 0], radius: 1, from: 0, to: 0 } }],
      }),
    ).toBe('model-invalid-argument');
    // Angles: exactly 3 points in the angle's view, rays of non-zero length.
    const angle = (refs: string[], extra: Drawing['items'] = []) =>
      bad({
        ...drawing,
        items: [
          items[4],
          items[5],
          items[6],
          ...extra,
          {
            id: 'a',
            view: 'side',
            role: 'package',
            kind: 'dimension',
            measure: 'angle',
            refs,
            value: 1,
          },
        ],
      });
    expect(angle(['nose', 'wheel', 'tail'])).toBe('ok');
    expect(angle(['nose', 'tail'])).toBe('model-invalid-argument');
    expect(angle(['nose', 'wheel', 'tail', 'nose'])).toBe('model-invalid-argument');
    expect(
      angle(
        ['nose', 'wheel', 'p'],
        [{ id: 'p', view: 'plan', role: 'package', kind: 'point', at: [1, 1] }],
      ),
    ).toBe('model-invalid-argument');
    expect(angle(['nose', 'wheel', 'arch'], [items[3] as Drawing['items'][number]])).toBe(
      'model-invalid-argument',
    );
    expect(
      angle(
        ['nose', 'wheel', 'w2'],
        [{ id: 'w2', view: 'side', role: 'package', kind: 'point', at: [0, 0.35] }],
      ),
    ).toBe('model-degenerate');
    const m = model();
    m.drawing({ ...drawing, items: [{ ...items[5], kind: 'raster' } as never] });
    expect(m.poisoned?.code).toBe('model-invalid-argument');
  });

  it('exports an SVG sheet and DXF R12 with a layer per role', () => {
    const r = resolveDrawing(drawing);
    if (!r.ok) throw r.error;
    const svg = svgOf(r.value);
    for (const id of ['outline', 'belt@side', 'belt@plan', 'arch', 'wheel', 'shut', 'length'])
      expect(svg).toContain(`data-id="${id}"`);
    expect(svg).toContain('data-role="silhouette"');
    expect(svg).toContain('stroke-dasharray');
    const dxf = dxfOf(r.value);
    expect(dxf).toContain('AC1009');
    expect(dxf).not.toContain('LWPOLYLINE');
    expect(dxf.match(/\nPOLYLINE\n/g)?.length).toBe(r.value.curves.length);
    expect(dxf.match(/\nSEQEND\n/g)?.length).toBe(r.value.curves.length);
    for (const layer of ['SILHOUETTE', 'FEATURE', 'PACKAGE', 'SECTION', 'ANNOTATION'])
      expect(dxf).toContain(`\n${layer}\n`);
    expect(dxf.trimEnd().endsWith('EOF')).toBe(true);
    // Only the views asked for are placed.
    expect(svgOf(r.value, { views: ['plan'] })).not.toContain('data-id="outline"');
  });

  it('labels points readably: free corners, no view suffix, leaders when crowded; angles in degrees', () => {
    const crowd: Drawing = {
      name: 'labels',
      views: [{ id: 'pose', ortho: 'right' }],
      items: [
        ...['M1', 'M2', 'G1', 'G2', 'G3', 'G4'].map(
          (n): DrawingItem => ({
            id: `${n}@pose`,
            view: 'pose',
            role: 'pivot',
            kind: 'point',
            at: [0, 0],
          }),
        ),
        { id: 'far@pose', view: 'pose', role: 'pivot', kind: 'point', at: [1, 1] },
        { id: 'arm', view: 'pose', role: 'pivot', kind: 'point', at: [1, 0] },
        {
          id: 'mu',
          view: 'pose',
          role: 'linkage',
          kind: 'dimension',
          measure: 'angle',
          refs: ['far@pose', 'M1@pose', 'arm'],
          value: Math.PI / 4,
        },
      ],
    };
    const r = resolveDrawing(crowd);
    if (!r.ok) throw r.error;
    const svg = svgOf(r.value);
    const labels = [
      ...svg.matchAll(/<text x="([\d.]+)" y="([\d.]+)" stroke="none"[^>]*>([^<]+)<\/text>/g),
    ]
      .map((m) => ({
        x: Number(m[1]),
        y: Number(m[2]),
        text: m[3] as string,
      }))
      .filter((l) => !l.text.startsWith('mu '));
    // The view suffix goes; ids without it keep their name.
    expect(labels.map((l) => l.text).sort()).toEqual(
      ['G1', 'G2', 'G3', 'G4', 'M1', 'M2', 'arm', 'far'].sort(),
    );
    // Six coincident points: four corners, then two moved out with leaders; no two labels share a spot.
    expect(new Set(labels.map((l) => `${l.x},${l.y}`)).size).toBe(labels.length);
    expect(
      svg.match(/<line x1="[^"]*" y1="[^"]*" x2="[^"]*" y2="[^"]*" stroke-width="0.18"\/>/g),
    ).toHaveLength(2);
    expect(svg).toContain('mu 45.0 deg');
    const dxf = dxfOf(r.value).split('\n');
    expect(dxf).toContain('mu 45.0 deg');
    expect(dxf).toContain('M1');
    expect(dxf).not.toContain('M1@pose');
  });

  it('draws notes under their view with a leader from their first ref, escaped', () => {
    const noted: Drawing = {
      ...drawing,
      items: [
        ...drawing.items,
        {
          id: 'gap',
          view: 'side',
          role: 'break',
          kind: 'note',
          refs: ['nose'],
          text: 'gap < 3 mm & flush\nsecond line',
        },
      ],
    };
    const r = resolveDrawing(noted);
    if (!r.ok) throw r.error;
    const svg = svgOf(r.value);
    const gap = svg.split('\n').filter((l) => l.includes('data-id="gap"'));
    expect(gap).toHaveLength(2);
    expect(gap[0]).toContain('gap: gap &lt; 3 mm &amp; flush');
    expect(gap[0]).toContain('<polyline');
    expect(gap[0]).toContain('stroke-dasharray');
    expect(gap[1]).toContain('>second line<');
    expect(gap[1]).not.toContain('<polyline');
    expect(svg).toContain('data-id="why"');
    expect(svg).not.toContain('< 3 mm');
    const dxf = dxfOf(r.value).split('\n');
    const value = (t: string) => dxf.indexOf(t);
    const first = value('gap: gap < 3 mm & flush');
    expect(first).toBeGreaterThan(0);
    expect(value('second line')).toBeGreaterThan(first);
    // TEXT on the role's layer: the layer code (8) precedes the entity's values.
    const entity = dxf.lastIndexOf('TEXT', first);
    expect(dxf[entity + 2]).toBe('BREAK');
    expect(dxf.some((l) => l.includes('\r'))).toBe(false);
  });

  it('lifts a line drawn in side and plan views into one space curve', () => {
    // x = 0.8 + 0.1 w^2, y = 0.5 + 0.2 w, z = -1 + 2 w.
    const at = (w: number): [number, number, number] => [
      0.8 + 0.1 * w * w,
      0.5 + 0.2 * w,
      -1 + 2 * w,
    ];
    const ws = Array.from({ length: 41 }, (_, i) => i / 40);
    const lineDrawing = (plan: [number, number][]): Drawing => ({
      name: 'lift',
      views: [
        { id: 'side', ortho: 'right' },
        { id: 'plan', ortho: 'top' },
      ],
      items: [
        {
          id: 'belt@side',
          view: 'side',
          role: 'feature',
          link: 'belt',
          kind: 'curve',
          curve: {
            kind: 'polyline',
            points: ws.map((w): [number, number] => [-at(w)[2], at(w)[1]]),
          },
        },
        {
          id: 'belt@plan',
          view: 'plan',
          role: 'feature',
          link: 'belt',
          kind: 'curve',
          curve: { kind: 'polyline', points: plan },
        },
      ],
    });
    const lift = (plan: [number, number][], link = 'belt') => {
      const r = resolveDrawing(lineDrawing(plan));
      if (!r.ok) throw r.error;
      return drawingCurve3(r.value, link);
    };
    const curve = lift(ws.map((w): [number, number] => [at(w)[0], -at(w)[2]]));
    if (!curve.ok) throw curve.error;
    for (const w of [0.1, 0.37, 0.5, 0.82]) {
      const truth = at(w);
      const near = Math.min(
        ...Array.from({ length: 2001 }, (_, i) => {
          const q = nurbs.point(curve.value, i / 2000);
          return Math.hypot(q[0] - truth[0], q[1] - truth[1], q[2] - truth[2]);
        }),
      );
      expect(near).toBeLessThan(0.002);
    }
    // The fit is checked against the curve, not its samples: a 2 m line fits within 0.1 mm,
    // far below the 2 mm spacing of a 1025-point sampling.
    const tight = resolveDrawing(
      lineDrawing(ws.map((w): [number, number] => [at(w)[0], -at(w)[2]])),
    );
    if (!tight.ok) throw tight.error;
    const fine = drawingCurve3(tight.value, 'belt', { tolerance: 1e-4 });
    if (!fine.ok) throw fine.error;
    for (const w of [0.1, 0.37, 0.5, 0.82]) {
      const truth = at(w);
      // The fitted point at the truth's station (z is monotonic along the curve).
      let [lo, hi] = [0, 1];
      for (let k = 0; k < 60; k++) {
        const mid = (lo + hi) / 2;
        if (nurbs.point(fine.value, mid)[2] < truth[2]) lo = mid;
        else hi = mid;
      }
      const q = nurbs.point(fine.value, lo);
      expect(Math.hypot(q[0] - truth[0], q[1] - truth[1], q[2] - truth[2])).toBeLessThan(2e-4);
    }
    // A plan curve that folds back along z is not single-valued: precondition.
    const fold = lift([
      [0.8, 1],
      [0.85, 0],
      [0.9, 0.5],
      [0.95, -1],
    ]);
    expect(fold.ok ? '' : fold.error.code).toBe('model-precondition');
    // A link drawn in one view only, or not at all, cannot be lifted.
    const none = lift(
      ws.map((w): [number, number] => [at(w)[0], -at(w)[2]]),
      'missing',
    );
    expect(none.ok ? '' : none.error.code).toBe('model-invalid-argument');
  });
});
