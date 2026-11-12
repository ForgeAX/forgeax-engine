import { describe, expect, it } from 'vitest';
import {
  type DrawnLine,
  drawingSvg,
  lookFrame,
  meshViewLines,
  model,
  type Point2,
  resolveDrawing,
  sel,
} from '../index';

const lines = (r: ReturnType<typeof meshViewLines>): DrawnLine[] => {
  if (!r.ok) throw new Error(r.error.code);
  return r.value;
};
const pts = (l: DrawnLine): readonly Point2[] => {
  if (!('points' in l.curve)) throw new Error('curve');
  return l.curve.points;
};
const length = (ls: readonly DrawnLine[]): number => {
  let sum = 0;
  for (const l of ls) {
    const p = pts(l);
    for (let i = 0; i + 1 < p.length; i++)
      sum += Math.hypot(
        (p[i + 1] as Point2)[0] - (p[i] as Point2)[0],
        (p[i + 1] as Point2)[1] - (p[i] as Point2)[1],
      );
    if (l.closed) {
      const a = p[p.length - 1] as Point2;
      const b = p[0] as Point2;
      sum += Math.hypot(a[0] - b[0], a[1] - b[1]);
    }
  }
  return sum;
};
const role = (ls: readonly DrawnLine[], r: string) => ls.filter((l) => l.role === r);

describe('meshViewLines', () => {
  it('a cube seen face-on has only its square outline; the back edges lie on it', () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    const ls = lines(meshViewLines(m.editMesh, 'front', { id: 'f' }));
    expect(length(role(ls, 'visible'))).toBeCloseTo(4, 9);
    expect(role(ls, 'hidden')).toHaveLength(0);
  });

  it('a box behind a larger one is hidden where the larger covers it', () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    m.box({ size: [0.4, 0.4, 0.4], center: [0.4, 0, -1] });
    const ls = lines(meshViewLines(m.editMesh, 'front', { id: 'f' }));
    const hidden = length(role(ls, 'hidden'));
    // The small square spans u 0.2..0.6; the part inside |u| < 0.5 is hidden: 0.3 wide.
    // Its outline inside the big square: top and bottom 0.3 each, left side 0.4.
    expect(hidden).toBeCloseTo(1.0, 6);
    const visible = length(role(ls, 'visible'));
    expect(visible).toBeCloseTo(4 + (1.6 - 1.0), 6);
  });

  it('a bore along the view axis shows hidden lines from the side', () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    const tool = model();
    tool.cylinder({ radiusTop: 0.2, radiusBottom: 0.2, height: 2, radialSegments: 16 });
    tool.rotate(sel.all(), 'x', 90);
    const d = m.difference(tool, {});
    expect(d.status).toBe('ok');
    const side = lines(meshViewLines(m.editMesh, 'right', { id: 's' }));
    const hidden = role(side, 'hidden');
    expect(hidden.length).toBeGreaterThan(0);
    for (const l of hidden)
      for (const p of pts(l)) expect(Math.abs(p[1])).toBeLessThanOrEqual(0.2 + 1e-9);
    const front = lines(meshViewLines(m.editMesh, 'front', { id: 'f' }));
    expect(role(front, 'hidden')).toHaveLength(0);
  });

  it('a cylinder silhouette is its two side lines', () => {
    const m = model();
    m.cylinder({ radiusTop: 0.5, radiusBottom: 0.5, height: 1, radialSegments: 4 });
    const ls = lines(meshViewLines(m.editMesh, 'front', { id: 'c' }));
    const contour = role(ls, 'visible').filter((l) => l.id.includes('/contour-'));
    expect(contour.length).toBeGreaterThan(0);
  });

  it('the crease angle decides which fold edges are drawn', () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    const oblique = lookFrame([1, 1, 1]);
    if (oblique === undefined) throw new Error('frame');
    const some = lines(meshViewLines(m.editMesh, oblique, { id: 'o', sharp: false }));
    const none = lines(
      meshViewLines(m.editMesh, oblique, { id: 'o', sharp: false, creaseAngle: 100 }),
    );
    expect(role(some, 'visible').filter((l) => l.id.includes('crease')).length).toBeGreaterThan(0);
    expect(role(none, 'visible').filter((l) => l.id.includes('crease'))).toHaveLength(0);
  });

  it('fails with a structured error past the work limit and on bad arguments', () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    const r = meshViewLines(m.editMesh, 'front', { id: 'f', workLimit: 1 });
    expect(!r.ok && r.error.code).toBe('model-work-budget');
    const bad = meshViewLines(m.editMesh, 'front', { id: '' });
    expect(!bad.ok && bad.error.code).toBe('model-invalid-argument');
  });

  it('is byte-deterministic and mirror-stable', () => {
    const build = (sx: number) => {
      const m = model();
      m.box({ size: [1, 1, 1] });
      m.box({ size: [0.4, 0.4, 0.4], center: [0.4 * sx, 0, -1] });
      return m.editMesh;
    };
    const a = JSON.stringify(meshViewLines(build(1), 'front', { id: 'f' }));
    expect(JSON.stringify(meshViewLines(build(1), 'front', { id: 'f' }))).toBe(a);
    const mirrored = lines(meshViewLines(build(-1), 'front', { id: 'f' }));
    const plain = lines(meshViewLines(build(1), 'front', { id: 'f' }));
    expect(length(role(mirrored, 'hidden'))).toBeCloseTo(length(role(plain, 'hidden')), 9);
  });
});

describe('drawing standard v2 sheet', () => {
  const part = () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    m.box({ size: [0.4, 0.4, 0.4], center: [0.4, 0, -1] });
    return m.editMesh;
  };
  const sheetOf = (options: object = {}, extra: object[] = []) => {
    const items: object[] = [];
    for (const v of ['front', 'top', 'right'] as const)
      items.push(...lines(meshViewLines(part(), v, { id: v })));
    const d = resolveDrawing({
      name: 'hlr',
      views: ['front', 'top', 'right'].map((v) => ({ id: v, ortho: v })),
      items: [...items, ...extra],
    } as never);
    if (!d.ok) throw d.error;
    const svg = drawingSvg(d.value, options);
    if (!svg.ok) throw svg.error;
    return svg.value;
  };

  it('draws hidden lines dashed and visible lines solid, in named layers', () => {
    const svg = sheetOf({ layers: true });
    expect(svg).toMatch(
      /<g id="layer:front:hidden" data-layer="hidden" data-role="hidden"[^>]*stroke-dasharray="2 1"/,
    );
    expect(svg).toMatch(
      /<g id="layer:front:visible" data-layer="visible" data-role="visible"(?![^>]*dasharray)/,
    );
    expect(sheetOf()).not.toContain('data-layer');
  });

  it('places views by projection: third angle puts top above, first angle below', () => {
    const y = (svg: string, view: string) =>
      Number(new RegExp(`<g data-view="${view}"><text x="[\\d.]+" y="([\\d.]+)"`).exec(svg)?.[1]);
    const x = (svg: string, view: string) =>
      Number(new RegExp(`<g data-view="${view}"><text x="([\\d.]+)"`).exec(svg)?.[1]);
    const third = sheetOf({ projection: 'third' });
    expect(y(third, 'top')).toBeLessThan(y(third, 'front'));
    expect(x(third, 'right')).toBeGreaterThan(x(third, 'front'));
    const first = sheetOf({ projection: 'first' });
    expect(y(first, 'top')).toBeGreaterThan(y(first, 'front'));
    expect(x(first, 'right')).toBeLessThan(x(first, 'front'));
    expect(sheetOf({ projection: 'third' })).toBe(third);
  });

  it('rejects an unknown projection', () => {
    const d = resolveDrawing({
      name: 'x',
      views: [{ id: 'front', ortho: 'front' }],
      items: [],
    } as never);
    if (!d.ok) throw d.error;
    const r = drawingSvg(d.value, { projection: 'second' as never });
    expect(!r.ok && r.error.code).toBe('model-invalid-argument');
  });

  it('shows a deviation balloon, red past its tolerance, without a table row', () => {
    const balloon = (id: string, deviation: number) => ({
      id,
      view: 'front',
      role: 'guide',
      kind: 'note',
      refs: [],
      text: id,
      at: [0, 0.8],
      balloon: true,
      deviation,
      tolerance: 0.002,
    });
    const svg = sheetOf({}, [balloon('B1', 0.0031), balloon('B2', -0.0005)]);
    expect(svg).toContain('+3.1 mm');
    expect(svg).toContain('-0.5 mm');
    expect(svg).toMatch(/data-id="B1"[^>]*stroke="#c0392b"/);
    expect(svg).toMatch(/data-id="B2"[^>]*stroke="#7f8c8d"/);
    const dup = resolveDrawing({
      name: 'x',
      views: [{ id: 'front', ortho: 'front' }],
      items: [balloon('B1', 0.1), balloon('B1', 0.2)],
    } as never);
    expect(dup.ok).toBe(false);
    const notBalloon = resolveDrawing({
      name: 'x',
      views: [{ id: 'front', ortho: 'front' }],
      items: [{ ...balloon('B1', 0.1), balloon: false }],
    } as never);
    expect(notBalloon.ok).toBe(false);
  });
});
