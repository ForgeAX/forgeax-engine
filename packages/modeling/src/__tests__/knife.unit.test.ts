import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Tuple3 } from '../geom';
import { type Model, model, type OpReport } from '../model';
import { sel } from '../selectors';

function slab(segments = 4): Model {
  const m = model();
  m.box({ size: [1, 1, 0.2], segments: [segments, segments, 1], tag: 'panel' });
  m.uv.project({ mode: 'box', scale: 1 });
  return m;
}

const square = (half: number, z = 1): Tuple3[] => [
  [-half, -half, z],
  [half, -half, z],
  [half, half, z],
  [-half, half, z],
];

function info(r: OpReport): Record<string, unknown> {
  return (
    r.diagnostics?.find((d) => d.severity === 'info' && d.message.startsWith('knife cut'))
      ?.detail ?? {}
  );
}

function clean(m: Model) {
  const issues = m
    .validate()
    .issues.filter((i) => i.severity === 'error' || i.code === 'uv-missing');
  expect(issues).toEqual([]);
}

function centroids(m: Model, selector = sel.createdBy('hole', 'inside')): Tuple3[] {
  const mesh = m.editMesh;
  return selector.evaluate(mesh).map((f) => {
    const loop = mesh.faceVertices(f).map((v) => mesh.position(v));
    return [0, 1, 2].map(
      (k) => loop.reduce((s, p) => s + (p[k] as number), 0) / loop.length,
    ) as Tuple3;
  });
}

describe('knife', () => {
  it('knife project: a closed outline cuts the visible side only and marks its inside', () => {
    const m = slab();
    const faces = m.editMesh.faceCount;
    const r = m.knife({
      points: square(0.3),
      direction: [0, 0, -1],
      closed: true,
      label: 'hole',
      tag: 'aperture',
    });
    expect(r.status).toBe('ok');
    expect(m.editMesh.faceCount).toBeGreaterThan(faces);
    const inside = centroids(m);
    expect(inside.length).toBeGreaterThan(0);
    for (const c of inside) {
      expect(c[2]).toBeCloseTo(0.1, 9);
      expect(Math.abs(c[0])).toBeLessThan(0.3);
      expect(Math.abs(c[1])).toBeLessThan(0.3);
    }
    expect(m.count(sel.tag('aperture'))).toBe(inside.length);
    // The cut runs exactly along the outline: inside area = 0.6 x 0.6.
    const mesh = m.editMesh;
    let area = 0;
    for (const f of sel.createdBy('hole', 'inside').evaluate(mesh)) {
      const p = mesh.faceVertices(f).map((v) => mesh.position(v));
      for (let i = 1; i + 1 < p.length; i++) {
        const a = p[0] as Tuple3;
        const b = p[i] as Tuple3;
        const c = p[i + 1] as Tuple3;
        area += Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
      }
    }
    expect(area).toBeCloseTo(0.36, 9);
    clean(m);
  });

  it('through: the same outline also cuts the far side', () => {
    const m = slab();
    m.knife({
      points: square(0.3),
      direction: [0, 0, -1],
      closed: true,
      through: true,
      label: 'hole',
    });
    const sides = new Set(centroids(m).map((c) => Math.sign(c[2])));
    expect(sides).toEqual(new Set([1, -1]));
    clean(m);
  });

  it('cuts through vertices and along edges without slivers', () => {
    const m = slab();
    // Grid vertices of the 4 x 4 front lie at multiples of 0.25; the square's corners are on them.
    const r = m.knife({ points: square(0.25), direction: [0, 0, -1], closed: true, label: 'hole' });
    expect(r.status).toBe('ok');
    expect(info(r)).toMatchObject({ crossings: 0 });
    expect(centroids(m)).toHaveLength(4);
    clean(m);
    // A diagonal through grid vertices.
    const d = slab();
    const diagonal = d.knife({
      points: [
        [-0.5, -0.5, 1],
        [0.5, 0.5, 1],
      ],
      direction: [0, 0, -1],
    });
    expect(diagonal.status).toBe('ok');
    expect(info(diagonal)).toMatchObject({ crossings: 0, faces: 4 });
    clean(d);
  });

  it('snaps crossings near a vertex onto it', () => {
    const m = slab();
    const r = m.knife({
      points: [
        [-0.6, 0.0004, 1],
        [0.6, 0.0004, 1],
      ],
      direction: [0, 0, -1],
    });
    expect(r.status).toBe('ok');
    // y = 0.0004 is within 1 % of the 0.25 m edges of y = 0: no new vertices.
    expect(info(r)).toMatchObject({ crossings: 0 });
    const loose = slab();
    loose.knife({
      points: [
        [-0.6, 0.0004, 1],
        [0.6, 0.0004, 1],
      ],
      direction: [0, 0, -1],
      snap: 0,
    });
    expect(loose.editMesh.vertexCount).toBeGreaterThan(m.editMesh.vertexCount);
    clean(loose);
  });

  it('an open path ending inside a face is trimmed to that face and reported', () => {
    const m = slab();
    const r = m.knife({
      points: [
        [-0.1, 0.1, 1],
        [0.4, 0.1, 1],
      ],
      direction: [0, 0, -1],
      sharp: true,
    });
    expect(r.status).toBe('ok');
    expect(r.diagnostics?.some((d) => d.message.includes('trimmed'))).toBe(true);
    expect(m.count(sel.edges.sharp())).toBeGreaterThan(0);
    clean(m);
  });

  it('a surface path around a sphere cuts a seam; its left side is the inside', () => {
    const m = model();
    m.sphere({ radius: 0.5, widthSegments: 24, heightSegments: 12, tag: 'ball' });
    // Counter-clockwise seen from +y (outside the cap above y = 0.2).
    const ring: Tuple3[] = Array.from({ length: 16 }, (_, i) => {
      const a = (-2 * Math.PI * i) / 16;
      const r = Math.sqrt(0.25 - 0.04);
      return [r * Math.cos(a), 0.2, r * Math.sin(a)];
    });
    const r = m.knife({ points: ring, closed: true, seam: true, label: 'hole' });
    expect(r.status, JSON.stringify(r.error)).toBe('ok');
    const inside = centroids(m);
    expect(inside.length).toBeGreaterThan(0);
    for (const c of inside) expect(c[1]).toBeGreaterThan(0.15);
    expect(m.count(sel.edges.seam())).toBeGreaterThan(0);
    clean(m);
  });

  it('knife project onto a curved panel cuts the near side only', () => {
    const m = model();
    m.sphere({ radius: 0.5, widthSegments: 32, heightSegments: 16, tag: 'hull' });
    const outline: Tuple3[] = Array.from({ length: 12 }, (_, i) => {
      const a = (2 * Math.PI * i) / 12;
      return [0.18 * Math.cos(a), 0.12 * Math.sin(a) + 0.05, 2];
    });
    const r = m.knife({
      points: outline,
      direction: [0, 0, -1],
      closed: true,
      sharp: true,
      label: 'hole',
    });
    expect(r.status).toBe('ok');
    const inside = centroids(m);
    expect(inside.length).toBeGreaterThan(4);
    for (const c of inside) expect(c[2]).toBeGreaterThan(0.4);
    // Every cut edge lies on the projected outline: its points stay inside the ellipse band.
    const mesh = m.editMesh;
    for (const e of sel.edges.sharp().evaluate(mesh)) {
      for (const v of mesh.edgeVertices(e)) {
        const [x, y, z] = mesh.position(v);
        expect(z).toBeGreaterThan(0.3);
        const q = (x / 0.18) ** 2 + ((y - 0.05) / 0.12) ** 2;
        expect(q).toBeGreaterThan(0.85);
        expect(q).toBeLessThan(1.0001);
      }
    }
    clean(m);
  });

  it('rejects bad paths and options; a path missing the mesh has no effect', () => {
    for (const options of [
      { points: [[0, 0, 1]] as Tuple3[], direction: [0, 0, -1] as Tuple3 },
      { points: square(0.3), through: true },
      { points: square(0.3), direction: [0, 0, 0] as Tuple3 },
      { points: square(0.3), direction: [0, 0, -1] as Tuple3, snap: -1 },
      {
        points: [
          [0, 0, 1],
          [0, 0, Number.NaN],
        ] as Tuple3[],
        direction: [0, 0, -1] as Tuple3,
      },
    ]) {
      expect(slab().knife(options).error?.code).toBe('model-invalid-argument');
    }
    expect(
      slab().knife({
        points: [
          [0, 0, 1],
          [0, 0, 2],
        ],
        direction: [0, 0, -1],
      }).error?.code,
    ).toBe('model-degenerate');
    expect(
      slab().knife({
        points: square(0.3).map((p) => [p[0] + 5, p[1], p[2]] as Tuple3),
        direction: [0, 0, -1],
        closed: true,
      }).error?.code,
    ).toBe('model-op-no-effect');
    expect(
      slab().knife({ points: square(0.3), direction: [0, 0, -1], faces: sel.tag('none') }).error
        ?.code,
    ).toBe('model-selection-empty');
  });

  it('property: random closed outlines on a dense panel validate clean and keep UVs', () => {
    let seed = 3;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let trial = 0; trial < 12; trial++) {
      const m = slab(6);
      const count = 3 + Math.floor(random() * 6);
      const radius = 0.15 + random() * 0.25;
      const cx = (random() - 0.5) * 0.2;
      const cy = (random() - 0.5) * 0.2;
      const points = Array.from({ length: count }, (_, i) => {
        const a = (2 * Math.PI * i) / count + random() * 0.3;
        const r = radius * (0.7 + random() * 0.3);
        return [cx + r * Math.cos(a), cy + r * Math.sin(a), 1] as Tuple3;
      });
      const r = m.knife({
        points,
        direction: [0, 0, -1],
        closed: true,
        label: 'hole',
        through: trial % 3 === 0,
      });
      expect(r.status, `trial ${trial} ${JSON.stringify(r.error)}`).toBe('ok');
      clean(m);
      expect(centroids(m).length).toBeGreaterThan(0);
    }
  });

  it('is deterministic', () => {
    const build = () => {
      const m = slab(5);
      m.knife({ points: square(0.33), direction: [0.1, 0, -1], closed: true, label: 'hole' });
      return m.snapshot();
    };
    expect(build()).toEqual(build());
  });
  it('surface loops along existing edges separate their inside, oriented by the path', () => {
    // Counter-clockwise seen from +z: on grid vertices, corners on edges, and edge stretches.
    const loops: Tuple3[][] = [
      [
        [-0.25, -0.25, 0.1],
        [0.25, -0.25, 0.1],
        [0.25, 0.25, 0.1],
        [-0.25, 0.25, 0.1],
      ],
      [
        [-0.25, -0.1, 0.1],
        [0.25, -0.1, 0.1],
        [0.25, 0.1, 0.1],
        [-0.25, 0.1, 0.1],
      ],
    ];
    for (const points of loops) {
      const m = slab();
      const r = m.knife({ points, closed: true, label: 'hole' });
      expect(r.status, JSON.stringify(r.error)).toBe('ok');
      expect(r.diagnostics?.filter((d) => d.severity === 'warn') ?? []).toEqual([]);
      const inside = centroids(m);
      expect(inside).toHaveLength(4);
      for (const c of inside) {
        expect(Math.abs(c[0])).toBeLessThan(0.25);
        expect(Math.abs(c[1])).toBeLessThan(0.25);
        expect(c[2]).toBeCloseTo(0.1, 9);
      }
      clean(m);
    }
  });

  it('a surface loop across a box corner with its corners on edges cuts and separates', () => {
    const m = model();
    m.box({ size: [0.4, 0.2, 0.4], segments: [4, 2, 4], tag: 'body' });
    m.uv.project({ mode: 'box', scale: 1 });
    const r = m.knife({
      points: [
        [0.2, 0.05, 0.1],
        [0.1, 0.05, 0.2],
        [0.1, -0.05, 0.2],
        [0.2, -0.05, 0.1],
      ],
      closed: true,
      label: 'hole',
    });
    expect(r.status, JSON.stringify(r.error)).toBe('ok');
    const inside = centroids(m);
    expect(inside).toHaveLength(4);
    for (const c of inside) expect(c[0] + c[2]).toBeGreaterThan(0.3);
    clean(m);
  });

  it('a clockwise surface loop warns that its inside is the larger side', () => {
    const m = slab();
    const r = m.knife({
      points: [
        [-0.2, 0.1, 0.1],
        [0.2, 0.1, 0.1],
        [0.2, -0.1, 0.1],
        [-0.2, -0.1, 0.1],
      ],
      closed: true,
      label: 'hole',
    });
    expect(r.status).toBe('ok');
    expect(r.diagnostics?.some((d) => d.severity === 'warn' && d.message.includes('reverse'))).toBe(
      true,
    );
  });

  it('a projected outline overhanging a panel edge marks only faces turned to the viewer', () => {
    const m = model();
    m.box({ size: [0.4, 0.4, 0.4], segments: [4, 4, 4], tag: 'body' });
    m.uv.project({ mode: 'box', scale: 1 });
    const r = m.knife({
      points: [
        [-0.08, 0.05, 1],
        [0.08, 0.05, 1],
        [0.08, 0.3, 1],
        [-0.08, 0.3, 1],
      ],
      direction: [0, 0, -1],
      closed: true,
      label: 'hole',
    });
    expect(r.status).toBe('ok');
    const inside = centroids(m);
    expect(inside.length).toBeGreaterThan(0);
    for (const c of inside) expect(c[2]).toBeCloseTo(0.2, 9);
    // The top face, seen edge-on, is not cut either.
    const mesh = m.editMesh;
    expect(sel.facing('+y').evaluate(mesh)).toHaveLength(16);
    clean(m);
  });

  it('a large snap never creates crossings or one-vertex chains (B11b R-4)', () => {
    // Crossings snapped onto one vertex, or across a chain already split, used to fail with
    // "paths cross each other" or "a face needs at least 3 vertices" (F1 S6a intake panels).
    for (const snap of [0.01, 0.03, 0.06, 0.1]) {
      const m = slab(8);
      const points = Array.from({ length: 12 }, (_, i) => {
        const a = (2 * Math.PI * i) / 12;
        return [0.3 * Math.cos(a), 0.2 * Math.sin(a), 1] as Tuple3;
      });
      const r = m.knife({ points, direction: [0, 0, -1], closed: true, snap, label: 'hole' });
      expect(r.status, `snap ${snap} ${r.error?.expected}`).toBe('ok');
      expect(centroids(m).length).toBeGreaterThan(0);
      clean(m);
    }
  });

  it('a corner inside a large n-gon cap still cuts it (B11c P1 candidate faces)', () => {
    // The 64-gon cap of a cylinder: its centre is far from every vertex relative to its
    // short edges, so corner candidates must reach by the face diameter.
    const m = model();
    m.cylinder({ radiusTop: 0.5, radiusBottom: 0.5, height: 0.2, radialSegments: 64, tag: 'can' });
    const r = m.knife({
      points: [
        [0, 0.5, 0],
        [0.8, 0.5, 0.3],
        [0.8, 0.5, -0.3],
      ],
      direction: [0, -1, 0],
      closed: true,
      label: 'wedge',
    });
    expect(r.status, JSON.stringify(r.error)).toBe('ok');
    const mesh = m.editMesh;
    const centre = mesh.vertices().filter((v) => {
      const [x, y, z] = mesh.position(v);
      return Math.abs(x) < 1e-9 && Math.abs(z) < 1e-9 && y > 0.09;
    });
    expect(centre).toHaveLength(1);
    expect(m.count(sel.createdBy('wedge', 'inside'))).toBeGreaterThan(0);
    clean(m);
  });
});

// Pre-optimization FXEM bytes preserve projection arithmetic, roles, tags and topology.
const projectionSnapshots = [
  {
    through: false,
    direction: [0, 0, -1],
    digest: '917fe82a5e4498bc6ca6b680a6c5d70cb49611eb7a1d3ab99b5067950f88ebd7',
    faces: 2076,
  },
  {
    through: false,
    direction: [0.25, 0.15, -1],
    digest: 'dc593d102dcb6f929810cbc215235c9de7c1ffb5a155e38a7aabe4d42fc8ea63',
    faces: 2071,
  },
  {
    through: true,
    direction: [0, 0, -1],
    digest: '5c39e1ab3074d000ccebda837c1a34e95b6aba13ad6047a3377d31e0872590c6',
    faces: 2104,
  },
  {
    through: true,
    direction: [0.25, 0.15, -1],
    digest: '77a20fb1ac0eeeb8b2bc1320d7e4974c4cee675d142762de9eba133a7e8f4e31',
    faces: 2097,
  },
] as const;
it.each(
  projectionSnapshots,
)('keeps exact projected hull bytes (through=$through, direction=$direction)', ({
  through,
  direction,
  digest,
  faces,
}) => {
  const m = model();
  m.sphere({ radius: 0.5, widthSegments: 64, heightSegments: 32, tag: 'hull' });
  const result = m.knife({
    points: [
      [-0.2, -0.12, 2],
      [0.2, -0.12, 2],
      [0.2, 0.12, 2],
      [-0.2, 0.12, 2],
    ],
    direction: [...direction],
    through,
    closed: true,
    label: 'aperture',
  });
  expect(result.status).toBe('ok');
  expect(m.editMesh.faceCount).toBe(faces);
  expect(createHash('sha256').update(m.snapshot()).digest('hex')).toBe(digest);
  clean(m);
});
