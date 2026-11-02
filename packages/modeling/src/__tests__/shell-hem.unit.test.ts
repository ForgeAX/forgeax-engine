import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { faceCentroid, faceNormal, type Tuple3 } from '../geom';
import { type Model, model } from '../model';
import { sel } from '../selectors';
import { expectContract } from './contract';

const T = 0.001;
const DEPTH = 0.004;

function plate(curved = false): Model {
  const m = model();
  m.plane({ width: 0.1, height: 0.1, widthSegments: 10, heightSegments: 10, tag: 'p' });
  if (curved) m.bend(sel.tag('p'), { axis: 'x', toward: '-z', angle: 30 });
  return m;
}

function expectClean(m: Model): void {
  const report = m.validate();
  expect(report.closed).toBe(true);
  expect(report.issues).toEqual([]);
  expectContract(m);
}

const dot = (a: Tuple3, b: Tuple3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Tuple3, b: Tuple3): Tuple3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (a: Tuple3) => Math.sqrt(dot(a, a));

/**
 * The fold's section at y = 0 on the edge x = +0.05, in the last skin face's frame (u out
 * across the edge, h along its normal, origin at the skin edge): distances of the section's
 * vertices to the two bend centers, inner (-t - r, -t - r) and (-t - r, -depth + r).
 */
function foldSection(m: Model, curved: boolean, radius: number) {
  const ref = plate(curved).editMesh;
  const on = ref
    .vertices()
    .map((v) => ref.position(v) as Tuple3)
    .filter((p) => Math.abs(p[1]) < 1e-9)
    .sort((a, b) => b[0] - a[0]);
  const edge = on[0] as Tuple3;
  const before = on[1] as Tuple3;
  const u = sub(edge, before);
  const uu = u.map((x) => x / norm(u)) as Tuple3;
  // y x u, pointing up (+z).
  const h: Tuple3 = [uu[2], 0, -uu[0]];
  const hh = (h[2] < 0 ? h.map((x) => -x) : h) as Tuple3;
  const mesh = m.editMesh;
  const local = mesh
    .vertices()
    .map((v) => mesh.position(v) as Tuple3)
    .filter((p) => Math.abs(p[1]) < 1e-9)
    .map((p) => [dot(sub(p, edge), uu), dot(sub(p, edge), hh)] as const)
    .filter(([x]) => x >= -T - radius - 1e-7);
  const top = [-T - radius, -T - radius] as const;
  const bottom = [-T - radius, -DEPTH + radius] as const;
  const distances = (c: readonly [number, number], keep: (y: number) => boolean) =>
    local.filter(([, y]) => keep(y)).map(([x, y]) => Math.sqrt((x - c[0]) ** 2 + (y - c[1]) ** 2));
  return {
    top: distances(top, (y) => y >= top[1] - 1e-7),
    bottom: distances(bottom, (y) => y <= bottom[1] + 1e-7),
  };
}

/** Bend radii read from section distances: every one is the inner or the outer radius. */
function expectRadii(distances: readonly number[], radius: number): void {
  const inner = distances.filter((d) => Math.abs(d - radius) <= radius * 0.05);
  const outer = distances.filter((d) => Math.abs(d - radius - T) <= (radius + T) * 0.05);
  expect(inner.length + outer.length, `${distances}`).toBe(distances.length);
  expect(inner.length).toBeGreaterThanOrEqual(7);
  expect(outer.length).toBeGreaterThanOrEqual(7);
}

/**
 * Largest angle between the normals of neighbouring faces across the edges along y of the
 * fold at x = +0.05, away from the panel corners, degrees.
 */
function largestDihedral(m: Model, faces: readonly number[]): number {
  const mesh = m.editMesh;
  let worst = 0;
  for (const f of faces) {
    const c = faceCentroid(mesh, f);
    if (c[0] < 0.03 || Math.abs(c[1]) > 0.035) continue;
    for (const h of mesh.faceHalves(f)) {
      const g = mesh.hFace[h ^ 1] as number;
      const d = sub(
        mesh.position(mesh.hVert[mesh.hNext[h] as number] as number),
        mesh.position(mesh.hVert[h] as number),
      );
      if (g < 0 || Math.abs(d[1]) < norm(d) * 0.999) continue;
      const cos = Math.min(1, Math.max(-1, dot(faceNormal(mesh, f), faceNormal(mesh, g))));
      worst = Math.max(worst, (Math.acos(cos) * 180) / Math.PI);
    }
  }
  return worst;
}

const faces = (m: Model, label: string, role: string): number[] => {
  const r = sel.createdBy(label, role).resolve(m.editMesh);
  if (!r.ok) throw r.error;
  return r.value;
};

/**
 * Two 6 x 20 cm panels in z = 0 facing +z with a 3.5 mm shut line along x = 0, each shelled
 * 1 mm with a flange at every edge; panel `a` takes `flange` settings on top.
 */
function pair(flange: { readonly radius?: number; readonly round?: number } = {}): Model {
  const m = model();
  for (const [name, side] of [
    ['a', -1],
    ['b', 1],
  ] as const) {
    m.plane({
      width: 0.06,
      height: 0.2,
      widthSegments: 6,
      heightSegments: 20,
      center: [side * (0.03 + 0.00175), 0, 0],
      tag: name,
    });
    const own = name === 'a' ? flange : {};
    const op = m.shell(sel.tag(name), {
      thickness: T,
      flange: { reach: 0.012, depth: DEPTH, ...own },
      label: name,
    });
    expect(op.status, op.error?.expected).toBe('ok');
  }
  return m;
}

function shutLine(m: Model) {
  const r = m.shutLines({ table: [{ id: 'D', parts: ['a', 'b'] }], ends: 0.02 });
  if (!r.ok) throw r.error;
  return r.value.rows[0];
}

describe('shell flange fold radius, skin round and per-edge flanges', () => {
  it.each([false, true])('rounds the fold concentrically (curved: %s)', (curved) => {
    for (const radius of [0.0005, 0.001, 0.0014]) {
      const m = plate(curved);
      const op = m.shell(sel.tag('p'), {
        thickness: T,
        flange: { reach: 0.012, depth: DEPTH, radius },
        label: 'hem',
      });
      expect(op.status, `${curved} ${radius} ${op.error?.expected}`).toBe('ok');
      expectClean(m);
      expect(op.roles?.flange).toBeGreaterThan(0);
      expect(op.roles?.bevel).toBeGreaterThan(0);
      const { top, bottom } = foldSection(m, curved, radius);
      expectRadii(top, radius);
      expectRadii(bottom, radius);
      // The fold is smooth: consecutive bend faces turn by 90 / 6 degrees.
      expect(largestDihedral(m, faces(m, 'hem', 'bevel'))).toBeLessThan(15.01);
    }
  }, 30_000);

  it('keeps the square fold byte for byte without radius or round', () => {
    const digest = (flange: object) => {
      const m = plate();
      m.shell(sel.tag('p'), { thickness: T, flange: { reach: 0.012, depth: DEPTH, ...flange } });
      return createHash('sha256').update(m.snapshot()).digest('hex');
    };
    const square = digest({});
    // The square fold of the kernel before radius and round existed.
    expect(square).toBe('865ef4c8f5622d45c7a3ebeed8c880be1a116765c838fc52c9538780b06212fc');
    expect(digest({ radius: 0, round: 0 })).toBe(square);
    expect(digest({ radius: 0.001 })).not.toBe(square);
  });

  it('rounds the skin edge tangentially through the bevel engine', () => {
    for (const round of [0.0006, 0.002]) {
      const m = plate(true);
      const op = m.shell(sel.tag('p'), {
        thickness: T,
        flange: { reach: 0.012, depth: DEPTH, round },
        label: 'hem',
      });
      expect(op.status, op.error?.expected).toBe('ok');
      expectClean(m);
      const rounds = faces(m, 'hem', 'bevel');
      expect(rounds.length).toBeGreaterThan(0);
      expect(largestDihedral(m, rounds)).toBeLessThan(15.01);
    }
  }, 30_000);

  it('widens the visual gap of a shut line, not its gap, with a round or a hem radius', () => {
    const base = shutLine(pair());
    expect(base?.gap?.mean).toBeCloseTo(0.0035, 5);
    let last = base?.visualGap?.mean as number;
    const rows = [{ round: 0.001 }, { round: 0.002 }, { radius: 0.0012 }].map((flange) => {
      const r = shutLine(pair(flange));
      expect(Math.abs((r?.gap?.mean as number) - (base?.gap?.mean as number))).toBeLessThan(5e-5);
      expect(Math.abs((r?.gap?.max as number) - (base?.gap?.max as number))).toBeLessThan(5e-5);
      return r;
    });
    for (const r of rows.slice(0, 2)) {
      expect(r?.visualGap?.mean).toBeGreaterThan(last + 0.0005);
      last = r?.visualGap?.mean as number;
    }
    // A hem of radius 1.2 mm rounds the skin edge with 2.2 mm.
    expect(rows[2]?.visualGap?.mean).toBeGreaterThan(rows[1]?.visualGap?.mean as number);
  }, 30_000);

  it('gives each flange of an array its own reach and radius', () => {
    const m = plate();
    const box = (min: Tuple3, max: Tuple3) =>
      sel.tag('p').and(sel.inBox(min, max, { by: 'centroid' }));
    const right = box([0.04, -0.044, -1], [1, 0.044, 1]);
    const rest = box([-1, -1, -1], [0.035, 1, 1])
      .or(box([0.04, 0.044, -1], [1, 1, 1]))
      .or(box([0.04, -1, -1], [1, -0.044, 1]));
    const op = m.shell(sel.tag('p'), {
      thickness: T,
      flange: [
        { at: right, reach: 0.025, depth: DEPTH, radius: 0.001 },
        { at: rest, reach: 0.008, depth: DEPTH },
      ],
      label: 'hem',
    });
    expect(op.status, op.error?.expected).toBe('ok');
    expectClean(m);
    const { top, bottom } = foldSection(m, false, 0.001);
    expectRadii(top, 0.001);
    expectRadii(bottom, 0.001);
    const mesh = m.editMesh;
    const xs = mesh
      .vertices()
      .map((v) => mesh.position(v))
      .filter(
        (p) => Math.abs((p[2] as number) + DEPTH + T) < 1e-9 && Math.abs(p[1] as number) < 0.03,
      )
      .map((p) => p[0] as number);
    // Right: two rings back (25 mm reach), its bottom bend rounded; left: one ring, square.
    expect(Math.min(...xs.filter((x) => x > 0))).toBeCloseTo(0.03, 9);
    expect(Math.max(...xs.filter((x) => x > 0))).toBeCloseTo(0.05 - 0.001 - T, 9);
    expect(Math.max(...xs.filter((x) => x < 0))).toBeCloseTo(-0.04, 9);
    expect(Math.min(...xs)).toBeCloseTo(-0.05, 9);
  }, 30_000);

  it('refuses overlapping flanges, misfit radii and mixed settings with structured errors', () => {
    const shell = (flange: object) =>
      plate().shell(sel.tag('p'), {
        thickness: T,
        flange: flange as { reach: number; depth: number },
      });
    const right = sel.tag('p').and(sel.inBox([0.04, -1, -1], [1, 1, 1], { by: 'centroid' }));
    const top = sel.tag('p').and(sel.inBox([-1, 0.04, -1], [1, 1, 1], { by: 'centroid' }));
    const overlap = shell([
      { at: right, reach: 0.012, depth: DEPTH },
      { at: top, reach: 0.012, depth: DEPTH },
    ]);
    expect(overlap.error?.code).toBe('model-invalid-argument');
    expect(overlap.error?.expected).toContain('at most one flange');
    const all = shell([
      { reach: 0.012, depth: DEPTH },
      { at: top, reach: 0.012, depth: DEPTH },
    ]);
    expect(all.error?.code).toBe('model-invalid-argument');
    const depths = shell([
      { at: right, reach: 0.025, depth: DEPTH },
      {
        at: sel.tag('p').and(sel.inBox([-1, 0.04, -1], [0.035, 1, 1], { by: 'centroid' })),
        reach: 0.025,
        depth: 0.005,
      },
    ]);
    expect(depths.error?.code).toBe('model-invalid-argument');
    expect(shell({ reach: 0.012, depth: DEPTH, radius: -0.001 }).error?.code).toBe(
      'model-invalid-argument',
    );
    expect(shell({ reach: 0.012, depth: DEPTH, round: Number.NaN }).error?.code).toBe(
      'model-invalid-argument',
    );
    const deep = shell({ reach: 0.012, depth: DEPTH, radius: 0.002 });
    expect(deep.error?.code).toBe('model-invalid-argument');
    expect((deep.error?.detail as { maxRadius: number }).maxRadius).toBeCloseTo(0.0014, 9);
    expect(shell({ reach: 0.012, depth: DEPTH, radius: 0.0014 }).status).toBe('ok');
    expect(shell({ reach: 0.002, depth: DEPTH, radius: 0.0012 }).error?.code).toBe(
      'model-invalid-argument',
    );
    expect(shell({ reach: 0.012, depth: DEPTH, radius: 0.001, round: 0.001 }).error?.code).toBe(
      'model-invalid-argument',
    );
    // A rounded fold cannot end in a cap where a plain rim goes on.
    const plain = shell({ at: right, reach: 0.012, depth: DEPTH, radius: 0.001 });
    expect(plain.error?.code).toBe('model-precondition');
    expect(plain.error?.expected).toContain('plain rim');
    // A round wider than the faces along the edge leave room for is not clamped silently.
    const wide = shell({ reach: 0.012, depth: DEPTH, round: 0.012 });
    expect(wide.error?.code).toBe('model-precondition');
  }, 30_000);
});
