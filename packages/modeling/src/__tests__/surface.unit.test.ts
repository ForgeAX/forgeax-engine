import { describe, expect, it } from 'vitest';
import type { Tuple3 } from '../geom';
import type { EditMesh } from '../mesh';
import { model } from '../model';
import { type NurbsSurface, nurbs } from '../nurbs';
import type { Point2 } from '../primitives';
import { loopWidth } from '../repair';
import { sel } from '../selectors';

const samples = (n: number) => Array.from({ length: n + 1 }, (_, i) => i / n);

/** A bicubic bump over [x0, x0 + w] x [0, 1] in XZ, height in Y. */
function bump(x0: number, w: number, h: number): NurbsSurface {
  const grid = samples(6).map((a) =>
    samples(6).map((b): Tuple3 => [x0 + a * w, h * Math.sin(Math.PI * b) * (0.6 + 0.4 * a), b]),
  );
  const s = nurbs.grid(grid);
  if (!s.ok) throw s.error;
  return s.value;
}

function plane(size: number): NurbsSurface {
  return {
    degreeU: 1,
    degreeV: 1,
    points: [
      [
        [0, 0, 0],
        [0, size, 0],
      ],
      [
        [size, 0, 0],
        [size, size, 0],
      ],
    ],
    knotsU: [0, 0, 1, 1],
    knotsV: [0, 0, 1, 1],
  };
}

function boundaryEdges(mesh: EditMesh): [number, number][] {
  return mesh
    .edges()
    .filter((e) => mesh.isBoundaryEdge(e))
    .map((e) => mesh.edgeVertices(e));
}

function meshArea(mesh: EditMesh): number {
  let area = 0;
  for (const f of mesh.faces()) {
    const p = mesh.faceVertices(f).map((v) => mesh.position(v));
    for (let k = 1; k + 1 < p.length; k++) {
      const a = p[0] as Tuple3;
      const b = p[k] as Tuple3;
      const c = p[k + 1] as Tuple3;
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      area +=
        Math.hypot(
          (u[1] as number) * (v[2] as number) - (u[2] as number) * (v[1] as number),
          (u[2] as number) * (v[0] as number) - (u[0] as number) * (v[2] as number),
          (u[0] as number) * (v[1] as number) - (u[1] as number) * (v[0] as number),
        ) / 2;
    }
  }
  return area;
}

describe('surface tessellation', () => {
  it('meets the chord tolerance along every edge and writes uv1 in the domain', () => {
    const m = model();
    const surface = bump(0, 1, 0.3);
    const report = m.surface({
      patches: [{ surface, name: 'panel' }],
      chord: 0.0005,
      label: 'panel',
    });
    expect(report.status).toBe('ok');
    expect(report.roles.panel).toBeGreaterThan(16);
    const mesh = m.editMesh;
    let worst = 0;
    for (const f of mesh.faces()) {
      const halves = mesh.faceHalves(f);
      for (let k = 0; k < halves.length; k++) {
        const a = mesh.corner('uv1', halves[k] as number) as Float32Array;
        const b = mesh.corner('uv1', halves[(k + 1) % halves.length] as number) as Float32Array;
        expect(a[0]).toBeGreaterThanOrEqual(0);
        expect(a[0]).toBeLessThanOrEqual(1);
        const pa = mesh.position(mesh.hVert[halves[k] as number] as number);
        const pb = mesh.position(mesh.hVert[halves[(k + 1) % halves.length] as number] as number);
        const mid = nurbs.surfacePoint(
          surface,
          ((a[0] as number) + (b[0] as number)) / 2,
          ((a[1] as number) + (b[1] as number)) / 2,
        );
        worst = Math.max(
          worst,
          Math.hypot(
            mid[0] - (pa[0] + pb[0]) / 2,
            mid[1] - (pa[1] + pb[1]) / 2,
            mid[2] - (pa[2] + pb[2]) / 2,
          ),
        );
      }
    }
    expect(worst).toBeLessThan(0.0006);
    expect(m.count(sel.tag('panel'))).toBe(mesh.faceCount);
  });

  it('welds patches that share a boundary even with different densities', {
    timeout: 30000,
  }, () => {
    const left = bump(-1, 1, 0.3);
    // The right patch shares the left patch's boundary curve at x = 0 but differs inside.
    const edge = left.points[left.points.length - 1] as Tuple3[];
    const right: NurbsSurface = {
      ...left,
      points: left.points.map((row, i) =>
        i === 0
          ? edge
          : row.map(
              (p, j): Tuple3 => [
                (edge[j] as Tuple3)[0] + (p[0] + 1) * 1.5,
                (edge[j] as Tuple3)[1] * (1 + 0.8 * i),
                p[2],
              ],
            ),
      ),
    };
    const m = model();
    m.surface({ patches: [{ surface: left }, { surface: right }], chord: 0.0003 });
    const mesh = m.editMesh;
    const seam = boundaryEdges(mesh).filter(
      ([a, b]) => Math.abs(mesh.position(a)[0]) < 1e-9 && Math.abs(mesh.position(b)[0]) < 1e-9,
    );
    expect(seam).toEqual([]);
    expect(m.validate().issues.filter((i) => i.code === 't-junction')).toEqual([]);
  });

  it('closes the seam of a full cylinder', () => {
    const H = Math.SQRT1_2;
    const ring: Tuple3[] = [
      [1, 0, 0],
      [1, 0, 1],
      [0, 0, 1],
      [-1, 0, 1],
      [-1, 0, 0],
      [-1, 0, -1],
      [0, 0, -1],
      [1, 0, -1],
      [1, 0, 0],
    ];
    const cylinder: NurbsSurface = {
      degreeU: 2,
      degreeV: 1,
      points: ring.map((p) => [p, [p[0], 2, p[2]] as Tuple3]),
      weights: [1, H, 1, H, 1, H, 1, H, 1].map((w) => [w, w]),
      knotsU: [0, 0, 0, 0.25, 0.25, 0.5, 0.5, 0.75, 0.75, 1, 1, 1],
      knotsV: [0, 0, 1, 1],
    };
    const m = model();
    m.surface({ patches: [{ surface: cylinder, flip: true }], chord: 0.002 });
    const open = boundaryEdges(m.editMesh);
    // Only the two rims stay open.
    expect(
      open.every(([a]) => [0, 2].some((y) => Math.abs(m.editMesh.position(a)[1] - y) < 1e-9)),
    ).toBe(true);
  });

  it('closes a cylinder with caps along their closed boundary circles', { timeout: 30_000 }, () => {
    // Each rim is a closed curve: its last span is reached only by searching from x = 1.
    const H = Math.SQRT1_2;
    const ring: Tuple3[] = [
      [1, 0, 0],
      [1, 0, 1],
      [0, 0, 1],
      [-1, 0, 1],
      [-1, 0, 0],
      [-1, 0, -1],
      [0, 0, -1],
      [1, 0, -1],
      [1, 0, 0],
    ];
    const weights = [1, H, 1, H, 1, H, 1, H, 1].map((w) => [w, w]);
    const knotsU = [0, 0, 0, 0.25, 0.25, 0.5, 0.5, 0.75, 0.75, 1, 1, 1];
    const side: NurbsSurface = {
      degreeU: 2,
      degreeV: 1,
      points: ring.map((p) => [p, [p[0], 2, p[2]] as Tuple3]),
      weights,
      knotsU,
      knotsV: [0, 0, 1, 1],
    };
    const cap = (y: number): NurbsSurface => ({
      degreeU: 2,
      degreeV: 1,
      points: ring.map((p) => [[0, y, 0] as Tuple3, [p[0], y, p[2]] as Tuple3]),
      weights,
      knotsU,
      knotsV: [0, 0, 1, 1],
    });
    const m = model();
    m.surface({
      patches: [
        { surface: side, flip: true },
        { surface: cap(0), flip: true },
        { surface: cap(2) },
      ],
      chord: 0.002,
    });
    expect(boundaryEdges(m.editMesh)).toEqual([]);
    const report = m.validate();
    expect(report.closed).toBe(true);
    // Inscribed within the 2 mm chord: the rim polygon loses at most 2 x chord of radius.
    expect(report.volume).toBeLessThanOrEqual(2 * Math.PI);
    expect(report.volume).toBeGreaterThan(2 * Math.PI * (1 - 2 * 0.002));
  });

  it('measures flat patches along the normal: a disc cap is not over-refined', () => {
    const H = Math.SQRT1_2;
    const ring: Tuple3[] = [
      [1, 0, 0],
      [1, 0, 1],
      [0, 0, 1],
      [-1, 0, 1],
      [-1, 0, 0],
      [-1, 0, -1],
      [0, 0, -1],
      [1, 0, -1],
      [1, 0, 0],
    ];
    const disc: NurbsSurface = {
      degreeU: 2,
      degreeV: 1,
      points: ring.map((p) => [[0, 0, 0] as Tuple3, p]),
      weights: [1, H, 1, H, 1, H, 1, H, 1].map((w) => [w, w]),
      knotsU: [0, 0, 0, 0.25, 0.25, 0.5, 0.5, 0.75, 0.75, 1, 1, 1],
      knotsV: [0, 0, 1, 1],
    };
    const m = model();
    const report = m.surface({ patches: [{ surface: disc }], chord: 0.001 });
    expect(report.diagnostics?.some((d) => d.message.includes('maxSegments'))).not.toBe(true);
    expect(m.editMesh.faceCount).toBeLessThan(400);
  });

  it('trims a hole in the parameter domain and keeps the exact area within the chord', () => {
    const circle = (cx: number, cy: number, r: number, n = 64): Point2[] =>
      Array.from({ length: n }, (_, k) => [
        cx + r * Math.cos((2 * Math.PI * k) / n),
        cy + r * Math.sin((2 * Math.PI * k) / n),
      ]);
    const m = model();
    const report = m.surface({
      patches: [{ surface: plane(2), trims: [{ uv: circle(0.5, 0.5, 0.25, 256) }] }],
      chord: 0.001,
    });
    expect(report.status).toBe('ok');
    expect(meshArea(m.editMesh)).toBeCloseTo(4 - Math.PI * 0.25, 3);
    const hole = boundaryEdges(m.editMesh).filter(
      ([a]) => Math.hypot(m.editMesh.position(a)[0] - 1, m.editMesh.position(a)[1] - 1) < 0.6,
    );
    expect(hole.length).toBeGreaterThan(64);
    // Faces along the cut carry the tag `trim`; every hole edge borders one.
    const trim = m.editMesh.tagIndex('trim', false);
    expect(trim).toBeGreaterThanOrEqual(0);
    const tagged = m.editMesh.faces().filter((f) => m.editMesh.hasTag(f, trim));
    expect(tagged.length).toBeGreaterThan(0);
    for (const [a, b] of hole) {
      const h = m.editMesh.findHalf(a, b);
      const face = m.editMesh.hFace[h] !== -1 ? m.editMesh.hFace[h] : m.editMesh.hFace[h ^ 1];
      expect(m.editMesh.hasTag(face as number, trim)).toBe(true);
    }
  });

  it('rings a trim with quads along each cut vertex inset (trimRing)', () => {
    const circle = Array.from(
      { length: 48 },
      (_, k): Point2 => [
        0.5 + 0.2 * Math.cos((2 * Math.PI * k) / 48),
        0.5 + 0.2 * Math.sin((2 * Math.PI * k) / 48),
      ],
    );
    const m = model();
    const report = m.surface({
      patches: [{ surface: bump(0, 1, 0.2), trims: [{ uv: circle }] }],
      chord: 0.002,
      trimRing: 0.01,
    });
    expect(report.status).toBe('ok');
    const support = m.editMesh.tagIndex('support', false);
    const ring = m.editMesh.faces().filter((f) => m.editMesh.hasTag(f, support));
    expect(ring.length).toBeGreaterThanOrEqual(48);
    for (const f of ring) expect(m.editMesh.faceVertices(f)).toHaveLength(4);
    // Every hole edge belongs to a ring quad.
    for (const [a, b] of boundaryEdges(m.editMesh)) {
      const p = m.editMesh.position(a);
      if (p[0] < 0.01 || p[0] > 0.99 || p[2] < 0.01 || p[2] > 0.99) continue;
      const h = m.editMesh.findHalf(a, b);
      const face = m.editMesh.hFace[h] !== -1 ? m.editMesh.hFace[h] : m.editMesh.hFace[h ^ 1];
      expect(m.editMesh.hasTag(face as number, support)).toBe(true);
    }
    expect(m.validate().issues.filter((i) => i.severity !== 'info')).toEqual([]);
    const outside = model().surface({
      patches: [{ surface: bump(0, 1, 0.2), trims: [{ uv: circle }] }],
      trimRing: 0.5,
    });
    expect(outside.error?.code).toBe('model-precondition');
  });

  it('rings a trim reaching past the patch sides only along its cut (B15 audit A3)', () => {
    // The trim runs 0.05 past three sides: before, its ring left the patch.
    const trim: Point2[] = [
      [0.4, -0.05],
      [1.05, -0.05],
      [1.05, 1.05],
      [0.4, 1.05],
    ];
    const m = model();
    const report = m.surface({
      patches: [{ surface: plane(0.2), name: 'p', trims: [{ uv: trim }] }],
      trimRing: 0.004,
    });
    expect(report.status).toBe('ok');
    const mesh = m.editMesh;
    const support = mesh.tagIndex('support', false);
    const ring = mesh.faces().filter((f) => mesh.hasTag(f, support));
    expect(ring.length).toBeGreaterThan(0);
    // Ring faces line the cut at x = 0.08 and run the ring depth into the patch.
    for (const f of ring)
      for (const v of mesh.faceVertices(f)) expect(mesh.position(v)[0]).toBeGreaterThan(0.0759);
    expect(m.validate().issues.filter((i) => i.severity !== 'info')).toEqual([]);
    const op = m.shell(sel.tag('p'), { thickness: 0.001, flange: { reach: 0.012, depth: 0.004 } });
    expect(op.status, op.error?.expected).toBe('ok');
  });

  it('projects view trims and imprints onto a curved patch', () => {
    const surface = bump(-1, 2, 0.3);
    const arch: Point2[] = Array.from({ length: 48 }, (_, k) => [
      0.2 * Math.cos((2 * Math.PI * k) / 48),
      0.5 + 0.2 * Math.sin((2 * Math.PI * k) / 48),
    ]);
    const m = model();
    const report = m.surface({
      patches: [
        {
          surface,
          name: 'hood',
          trims: [{ view: 'top', region: arch.map(([x, z]): Point2 => [x, -z]) }],
          imprints: [
            {
              region: {
                uv: [
                  [0.05, 0.05],
                  [0.3, 0.05],
                  [0.3, 0.2],
                  [0.05, 0.2],
                ],
              },
              role: 'badge',
              material: 'decal',
              tag: 'badge',
            },
          ],
        },
      ],
      chord: 0.001,
    });
    expect(report.status).toBe('ok');
    expect(report.roles.badge).toBeGreaterThan(0);
    expect(m.count(sel.tag('badge'))).toBe(report.roles.badge);
    const mesh = m.editMesh;
    const rim = boundaryEdges(mesh)
      .map(([a]) => mesh.position(a))
      .filter((p) => Math.hypot(p[0], p[2] - 0.5) < 0.3);
    expect(rim.length).toBeGreaterThan(24);
    for (const p of rim) expect(Math.hypot(p[0], p[2] - 0.5)).toBeCloseTo(0.2, 2);
    const finished = m.toMesh();
    if (!finished.ok) throw finished.error;
    expect(finished.value.mesh.materialSlots.map((s) => s.slotName)).toContain('decal');
  });

  it('fails structurally on a malformed patch and a native-only policy', () => {
    const bad = model();
    const r = bad.surface({ patches: [{ surface: { ...plane(1), knotsU: [0, 1] } }] });
    expect(r.status).toBe('failed');
    expect(r.error?.code).toBe('model-invalid-argument');
    const native = model({ compute: 'native' });
    const n = native.surface({
      patches: [
        {
          surface: plane(1),
          trims: [
            {
              uv: [
                [0.2, 0.2],
                [0.4, 0.2],
                [0.3, 0.4],
              ],
            },
          ],
        },
      ],
    });
    expect(n.error?.code).toBe('model-capability-unavailable');
  });

  it('splits non-planar quads by default and keeps them on request', () => {
    const surface = bump(0, 1, 0.3);
    const split = model();
    const report = split.surface({ patches: [{ surface }], chord: 0.002 });
    expect(report.diagnostics?.some((d) => d.message.includes('non-planar quad'))).toBe(true);
    expect(split.validate().issues.filter((i) => i.code === 'face-nonplanar')).toEqual([]);
    const kept = model();
    kept.surface({ patches: [{ surface }], chord: 0.002, nonPlanar: 'keep' });
    expect(kept.editMesh.faces().every((f) => kept.editMesh.faceVertices(f).length === 4)).toBe(
      true,
    );
  });

  it('projects a view trim onto the side that faces the viewer only', () => {
    // A strip that folds over in the top view: up the front, then back down behind.
    const grid = samples(6).map((a) =>
      samples(8).map((b): Tuple3 => [a, b, 0.3 * Math.sin(Math.PI * b)]),
    );
    const folded = nurbs.grid(grid);
    if (!folded.ok) throw folded.error;
    const m = model();
    const square: Point2[] = [
      [0.4, -0.25],
      [0.6, -0.25],
      [0.6, -0.15],
      [0.4, -0.15],
    ];
    // Top view: v = -z; z in [0.15, 0.25] lies on both sides of the hump, and only the
    // far side (y > 0.5) faces up.
    m.surface({
      patches: [{ surface: folded.value, trims: [{ view: 'top', region: square }] }],
      chord: 0.001,
    });
    const mesh = m.editMesh;
    const hole = boundaryEdges(mesh)
      .map(([a]) => mesh.position(a))
      .filter((p) => p[0] > 0.35 && p[0] < 0.65 && p[2] > 0.1 && p[2] < 0.3);
    expect(hole.length).toBeGreaterThan(4);
    expect(hole.every((p) => p[1] > 0.5)).toBe(true);
  });

  it('carries trim and imprint crossings across a curved shared boundary (no T-junctions)', () => {
    const left = bump(-1, 1, 0.3);
    const edge = left.points[left.points.length - 1] as Tuple3[];
    const right: NurbsSurface = {
      ...left,
      points: left.points.map((row, i) =>
        i === 0
          ? edge
          : row.map(
              (p, j): Tuple3 => [
                (edge[j] as Tuple3)[0] + (p[0] + 1) * 1.5,
                (edge[j] as Tuple3)[1] * (1 + 0.8 * i),
                p[2],
              ],
            ),
      ),
    };
    const circle = (cx: number, cy: number, r: number): Point2[] =>
      Array.from({ length: 64 }, (_, k) => [
        cx + r * Math.cos((2 * Math.PI * k) / 64),
        cy + r * Math.sin((2 * Math.PI * k) / 64),
      ]);
    const m = model();
    const report = m.surface({
      patches: [
        {
          surface: left,
          trims: [{ uv: circle(0.97, 0.3, 0.12) }],
          imprints: [{ region: { uv: circle(0.98, 0.72, 0.1) }, material: 'mark' }],
        },
        { surface: right },
      ],
      chord: 0.001,
    });
    expect(report.status).toBe('ok');
    expect(m.validate().issues.filter((i) => i.code === 't-junction')).toEqual([]);
    // The imprint does not open the seam: no open edge lies on it.
    const mesh = m.editMesh;
    const onSeam = (p: readonly number[]) => Math.abs(p[0] as number) < 1e-6;
    const seamOpen = boundaryEdges(mesh).filter(
      ([a, b]) =>
        onSeam(mesh.position(a)) &&
        onSeam(mesh.position(b)) &&
        Math.abs(mesh.position(a)[2] - 0.72) < 0.2,
    );
    expect(seamOpen).toEqual([]);
  });

  it('a trim passing a grid node leaves no sliver; shell then fits (B11b R-2)', () => {
    // F1 S6a front fender at wheelbase x1.06: the arch trim passed 0.044 mm from a grid
    // node, a needle face stayed on the trimmed boundary and shell 3 mm failed.
    const surface = (() => {
      const samples = (n: number) => Array.from({ length: n }, (_, i) => i / (n - 1));
      const g = nurbs.grid(
        samples(6).map((a) =>
          samples(6).map(
            (b): Tuple3 => [a * 1.2, 0.3 * Math.sin(Math.PI * b) * (0.6 + 0.4 * a), b],
          ),
        ),
      );
      if (!g.ok) throw g.error;
      return g.value;
    })();
    for (const [cx, cy, r] of [
      [0.49977817535400393, 0.42142887115478517, 0.11841817378997803],
      [0.4674589276313782, 0.6525798320770264, 0.14620283722877503],
    ] as const) {
      const circle = Array.from(
        { length: 96 },
        (_, k): Point2 => [
          cx + r * Math.cos((2 * Math.PI * k) / 96),
          cy + r * Math.sin((2 * Math.PI * k) / 96),
        ],
      );
      const m = model();
      const report = m.surface({ patches: [{ surface, trims: [{ uv: circle }] }], chord: 0.003 });
      expect(report.status).toBe('ok');
      const mesh = m.editMesh;
      for (const f of mesh.faces()) {
        expect(loopWidth(mesh.faceVertices(f).map((v) => mesh.position(v)))).toBeGreaterThan(
          0.003 / 16,
        );
      }
      expect(m.validate().issues.filter((i) => i.severity === 'error')).toEqual([]);
      expect(m.shell(sel.all(), { thickness: 0.003 }).status).toBe('ok');
    }
  });
});
