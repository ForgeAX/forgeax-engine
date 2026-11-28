// biome-ignore-all lint/style/noNonNullAssertion: fixed-size fixtures indexed under noUncheckedIndexedAccess
import { describe, expect, it } from 'vitest';
import type { ModelingError } from '../../errors';
import { box, cone, cylinder, extrude, revolve, sphere, torus } from '../build';
import { measure } from '../measure';
import { countOps } from '../ops';
import { wrapPeriod } from '../surfaces';
import { tessellate } from '../tessellate';
import type { Shape } from '../types';
import { validate } from '../validate';

type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };
type Pt = [number, number];
type Built = { ok: true; value: Shape } | { ok: false; error: ModelingError };

function clone(shape: Shape): Mutable<Shape> {
  return JSON.parse(JSON.stringify(shape)) as Mutable<Shape>;
}

function must(r: Built): Shape {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

function detail(r: Built): { brep?: string; reason?: string } {
  if (r.ok) throw new Error('expected a failure');
  return (r.error.detail ?? {}) as { brep?: string; reason?: string };
}

const sq = (x: number, y: number, s: number): Pt[] => [
  [x, y],
  [x + s, y],
  [x + s, y + s],
  [x, y + s],
];

describe('H1: extrude rejects non-simple regions', () => {
  const outline = sq(0, 0, 10);
  const cases: [string, Parameters<typeof extrude>[0], string][] = [
    [
      'a hole crossing the outline by 1e-3',
      {
        profile: outline,
        holes: [
          [
            [-1e-3, 3],
            [2, 3],
            [2, 5],
            [-1e-3, 5],
          ],
        ],
        depth: 1,
      },
      'self-intersecting-outline',
    ],
    [
      'a hole outside the outline',
      { profile: outline, holes: [sq(20, 20, 2)], depth: 1 },
      'hole-outside-outline',
    ],
    [
      'two overlapping holes',
      { profile: outline, holes: [sq(1, 1, 2), sq(2, 2, 2)], depth: 1 },
      'self-intersecting-outline',
    ],
    [
      'a hole inside another hole',
      { profile: outline, holes: [sq(1, 1, 6), sq(2, 2, 1)], depth: 1 },
      'hole-inside-hole',
    ],
    [
      'an outline vertex touching its own edge',
      {
        profile: [
          [0, 0],
          [4, 0],
          [4, 4],
          [2, 0],
          [0, 4],
        ],
        depth: 1,
      },
      'self-intersecting-outline',
    ],
    [
      'a six-point bowtie',
      {
        profile: [
          [0, 0],
          [4, 0],
          [0, 2],
          [4, 2],
          [4, 4],
          [0, 4],
        ],
        depth: 1,
      },
      'self-intersecting-outline',
    ],
    [
      'a repeated point',
      {
        profile: [
          [0, 0],
          [4, 0],
          [4, 0],
          [4, 4],
          [0, 4],
        ],
        depth: 1,
      },
      'degenerate-edge',
    ],
  ];
  for (const [name, options, reason] of cases) {
    it(`${name} is brep-bad-argument (${reason})`, () => {
      const r = extrude(options);
      expect(r.ok).toBe(false);
      expect(detail(r).brep).toBe('brep-bad-argument');
      expect(detail(r).reason).toBe(reason);
    });
  }

  it('the valid neighbours still build: a hole 1e-3 inside, a concave L, a clockwise outline', () => {
    const hole = sq(1e-3, 3, 2);
    expect(extrude({ profile: outline, holes: [hole], depth: 1 }).ok).toBe(true);
    const l: Pt[] = [
      [0, 0],
      [4, 0],
      [4, 1],
      [1, 1],
      [1, 4],
      [0, 4],
    ];
    const v = must(extrude({ profile: l, depth: 2 }));
    expect(validate(v).ok).toBe(true);
    expect(must(extrude({ profile: [...outline].reverse(), depth: 1 })).faces.length).toBe(6);
  });

  it('a four-point bowtie has zero signed area and is brep-bad-argument', () => {
    const r = extrude({
      profile: [
        [0, 0],
        [4, 4],
        [4, 0],
        [0, 4],
      ],
      depth: 1,
    });
    expect(detail(r).brep).toBe('brep-bad-argument');
  });

  it('a collinear outline is brep-bad-argument with a non-zero-area expectation', () => {
    const r = extrude({
      profile: [
        [0, 0],
        [1, 0],
        [2, 0],
      ],
      depth: 1,
    });
    expect(r.ok).toBe(false);
    expect(detail(r).brep).toBe('brep-bad-argument');
    expect(!r.ok && r.error.expected).toContain('non-zero area');
  });
});

describe('H1: revolve rejects non-simple profiles', () => {
  it('a profile crossing itself', () => {
    const r = revolve({
      profile: [
        [0, 0],
        [3, 0],
        [3, 3],
        [1, 3],
        [1, 1],
        [2, 1],
        [2, 2],
        [0, 2],
      ],
    });
    expect(detail(r).brep).toBe('brep-bad-argument');
    expect(detail(r).reason).toBe('self-intersecting-profile');
  });

  it('a profile touching the axis mid-way', () => {
    const r = revolve({
      profile: [
        [0, 0],
        [1, 1],
        [0, 2],
        [1, 3],
        [0, 4],
      ],
    });
    expect(detail(r).brep).toBe('brep-bad-argument');
    expect(detail(r).reason).toBe('profile-touches-axis');
  });

  it('a closed profile with a vertex on its own edge', () => {
    const r = revolve({
      profile: [
        [1, 0],
        [3, 0],
        [3, 2],
        [2, 0],
        [1, 2],
        [1, 0],
      ],
    });
    expect(detail(r).brep).toBe('brep-bad-argument');
    expect(detail(r).reason).toBe('self-intersecting-profile');
  });

  it('a clockwise profile and a simple one', () => {
    const cw: Pt[] = [
      [0, 0],
      [0, 2],
      [1, 2],
      [1, 0],
    ];
    expect(revolve({ profile: cw }).ok).toBe(false);
    const ccw: Pt[] = [
      [0, 0],
      [1, 0],
      [1, 2],
      [0, 2],
    ];
    expect(validate(must(revolve({ profile: ccw }))).ok).toBe(true);
  });
});

describe('H1: validate finds a self-intersecting planar face', () => {
  it('a hole slid across the outline is brep-self-intersection (and maps to model-precondition)', () => {
    const plate = clone(must(extrude({ profile: outline(), holes: [sq(3, 3, 2)], depth: 1 })));
    const inner = new Set<number>();
    for (const l of plate.loops) if (!l.outer) for (const c of l.coedges) inner.add(c);
    expect(inner.size).toBeGreaterThan(0);
    for (const c of inner) {
      const p = plate.coedges[c]!.pcurve;
      if (p.kind === 'line') p.o[0] += 8;
    }
    const report = validate(plate as Shape);
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.code === 'brep-self-intersection')).toBe(true);
  });
});

function outline(): Pt[] {
  return sq(0, 0, 10);
}

describe('H2: frames must be right-handed orthonormal', () => {
  const scaled = { o: [0, 0, 0], x: [3, 0, 0], y: [0, 3, 0], z: [0, 0, 3] } as const;
  const mirrored = { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, -1] } as const;
  const skew = { o: [0, 0, 0], x: [1, 0, 0], y: [0.1, 1, 0], z: [0, 0, 1] } as const;
  const tri: Pt[] = sq(0, 0, 2);
  const builds: [string, (frame: never) => Built][] = [
    ['box', (frame) => box({ size: [1, 2, 3], frame })],
    ['cylinder', (frame) => cylinder({ radius: 1, height: 2, frame })],
    ['cone', (frame) => cone({ radius: 1, height: 2, frame })],
    ['sphere', (frame) => sphere({ radius: 1, frame })],
    ['torus', (frame) => torus({ major: 3, minor: 1, frame })],
    ['extrude', (frame) => extrude({ profile: tri, depth: 1, frame })],
    [
      'revolve',
      (frame) =>
        revolve({
          profile: [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
          ],
          frame,
        }),
    ],
  ];
  for (const [name, build] of builds) {
    for (const [what, frame] of [
      ['scaled', scaled],
      ['mirrored', mirrored],
      ['skewed', skew],
    ] as const) {
      it(`${name} rejects a ${what} frame`, () => {
        const r = build(frame as never);
        expect(r.ok).toBe(false);
        expect(detail(r).brep).toBe('brep-bad-argument');
      });
    }
  }

  it('a plane frame with z negated fails validate', () => {
    const b = clone(must(box({ size: [1, 1, 1] })));
    const s = b.surfaces.find((x) => x.kind === 'plane')!;
    s.frame.z = [-s.frame.z[0]!, -s.frame.z[1]!, -s.frame.z[2]!];
    expect(validate(b as Shape).ok).toBe(false);
  });

  it('a rotated, translated unit frame still builds', () => {
    const c = Math.SQRT1_2;
    const frame = { o: [5, -2, 7], x: [c, c, 0], y: [-c, c, 0], z: [0, 0, 1] } as const;
    const s = must(sphere({ radius: 1, frame: frame as never }));
    expect(validate(s).ok).toBe(true);
  });
});

describe('M1: tolerance follows the part size, not its offset', () => {
  for (const off of [0, 1e3, 1e5, 1e6]) {
    it(`a unit square extruded at offset ${off} keeps tol <= 1e-5 and validates`, () => {
      const s = must(extrude({ profile: sq(off, off, 1), depth: 1 }));
      expect(s.tol).toBeLessThan(1e-5);
      expect(s.maxTol).toBeLessThan(1e-3);
      expect(validate(s).ok).toBe(true);
      const m = measure(s);
      expect(m.ok && Math.abs(m.value.volume - 1)).toBeLessThan(1e-3);
    });
  }

  it('a vertex gap of 1% of a far-away unit part is rejected', () => {
    const s = clone(must(extrude({ profile: sq(1e5, 1e5, 1), depth: 1 })));
    s.vertices[0]!.p[0] += 0.01;
    expect(validate(s as Shape).ok).toBe(false);
  });
});

describe('M2: build and tessellation cost do not scale with length', () => {
  it('a 1e5-long cylinder builds fast with its exact volume', () => {
    const t0 = Date.now();
    const s = must(cylinder({ radius: 1, height: 1e5 }));
    expect(Date.now() - t0).toBeLessThan(5000);
    const m = measure(s);
    expect(m.ok && Math.abs(m.value.volume / (Math.PI * 1e5) - 1)).toBeLessThan(1e-9);
  });

  it('measuring a cylinder does not scale its quadrature with length', () => {
    const quadratures = (height: number) => {
      const s = must(cylinder({ radius: 1, height }));
      const { value, counts } = countOps(() => measure(s));
      expect(value.ok && Math.abs(value.value.volume / (Math.PI * height) - 1)).toBeLessThan(1e-9);
      return counts.quadratureEvals;
    };
    const short = quadratures(1);
    const t0 = Date.now();
    const long = quadratures(1e4);
    expect(long).toBe(short);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('tall and short cylinders and cones tessellate to the same face count', () => {
    for (const make of [cylinder, cone]) {
      const a = tessellate(must(make({ radius: 1, height: 1 })));
      const b = tessellate(must(make({ radius: 1, height: 1e4 })));
      if (!a.ok || !b.ok) throw new Error('tessellate');
      expect(b.value.faces().length).toBe(a.value.faces().length);
    }
  });
});

describe('M3: validate never throws and rejects malformed shapes', () => {
  const base = must(box({ size: [1, 2, 3] }));
  const mutations: [string, (m: Mutable<Shape>) => void][] = [
    [
      'NaN vertex coordinate',
      (m) => {
        m.vertices[0]!.p[1] = Number.NaN;
      },
    ],
    [
      'NaN tol',
      (m) => {
        m.tol = Number.NaN;
      },
    ],
    [
      'NaN maxTol',
      (m) => {
        m.maxTol = Number.NaN;
      },
    ],
    [
      'tol 0',
      (m) => {
        m.tol = 0;
      },
    ],
    [
      'negative tol',
      (m) => {
        m.tol = -1;
      },
    ],
    [
      'maxTol below tol',
      (m) => {
        m.maxTol = m.tol / 2;
      },
    ],
    [
      'Infinity in a surface frame',
      (m) => {
        const s0 = m.surfaces[0]!;
        if (s0.kind !== 'nurbs') s0.frame.o[0] = Number.POSITIVE_INFINITY;
      },
    ],
    [
      'NaN in a pcurve',
      (m) => {
        (m.coedges[0]!.pcurve as { o: number[] }).o[0] = Number.NaN;
      },
    ],
    [
      'unknown surface kind',
      (m) => {
        (m.surfaces[0] as { kind: string }).kind = 'blob';
      },
    ],
    [
      'unknown curve kind',
      (m) => {
        (m.curves[0] as { kind: string }).kind = 'blob';
      },
    ],
    [
      'unknown pcurve kind',
      (m) => {
        (m.coedges[0]!.pcurve as { kind: string }).kind = 'blob';
      },
    ],
    [
      'empty shell list',
      (m) => {
        m.shells.length = 0;
      },
    ],
    [
      'open shell (a face dropped)',
      (m) => {
        m.shells[0]!.faces.pop();
      },
    ],
    [
      'a face in two shells',
      (m) => {
        m.shells.push({ faces: [0] });
      },
    ],
    [
      'duplicate loop reference',
      (m) => {
        m.faces[0]!.loops = [m.faces[0]!.loops[0]!, m.faces[0]!.loops[0]!];
      },
    ],
    [
      'a second outer loop',
      (m) => {
        m.faces[0]!.loops.push(m.faces[1]!.loops[0]!);
      },
    ],
    [
      'non-string label',
      (m) => {
        (m.faces[0] as { label: unknown }).label = 5;
      },
    ],
    [
      'dangling edge curve',
      (m) => {
        m.edges[0]!.curve = 99;
      },
    ],
    [
      'fractional index',
      (m) => {
        m.faces[0]!.surface = 0.5;
      },
    ],
    [
      'a coedge in two loops',
      (m) => {
        m.loops[1]!.coedges.push(m.loops[0]!.coedges[0]!);
      },
    ],
    [
      'missing array',
      (m) => {
        (m as { faces?: unknown }).faces = undefined;
      },
    ],
    [
      'vertex with two coordinates',
      (m) => {
        (m.vertices[0]!.p as number[]).length = 2;
      },
    ],
  ];
  for (const [name, mutate] of mutations) {
    it(`${name}: validate returns not-ok without throwing`, () => {
      const m = clone(base);
      mutate(m);
      let report: ReturnType<typeof validate> | undefined;
      expect(() => {
        report = validate(m as Shape);
      }).not.toThrow();
      expect(report?.ok).toBe(false);
      expect(report?.issues.length).toBeGreaterThan(0);
      expect(() => measure(m as Shape)).not.toThrow();
      expect(() => tessellate(m as Shape)).not.toThrow();
    });
  }

  it('non-objects do not throw', () => {
    for (const v of [null, undefined, 3, 'x', [], {}]) {
      expect(validate(v as never).ok).toBe(false);
    }
  });

  it('the unmutated box is still ok', () => {
    expect(validate(clone(base) as Shape).ok).toBe(true);
  });

  it('measure and tessellate refuse a dangling curve instead of throwing or answering', () => {
    const m = clone(base);
    m.edges[0]!.curve = 99;
    const a = measure(m as Shape);
    const b = tessellate(m as Shape);
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
  });
});

describe('M4: former mutation survivors', () => {
  it('wrapPeriod maps any angle into [0, 2 pi) and snaps the seam', () => {
    const TAU = 2 * Math.PI;
    expect(wrapPeriod(-0.5)).toBeCloseTo(TAU - 0.5, 12);
    expect(wrapPeriod(-7)).toBeCloseTo(TAU * 2 - 7, 12);
    expect(wrapPeriod(7)).toBeCloseTo(7 - TAU, 12);
    expect(wrapPeriod(4 * Math.PI + 0.25)).toBeCloseTo(0.25, 9);
    expect(wrapPeriod(-4 * Math.PI - 0.25)).toBeCloseTo(TAU - 0.25, 9);
    expect(wrapPeriod(-1e-12)).toBe(0);
    expect(wrapPeriod(-1e-10)).toBe(0);
    expect(wrapPeriod(TAU)).toBe(0);
    expect(wrapPeriod(4 * Math.PI)).toBe(0);
  });

  it('the angle bound holds on a circle whose span is not a multiple of it', () => {
    const angle = 1;
    const m = tessellate(must(cylinder({ radius: 1, height: 2 })), { angle });
    if (!m.ok) throw new Error('tessellate');
    const top: number[] = [];
    for (let v = 0; v < m.value.vertexHighWater; v++) {
      const p = m.value.position(v);
      if (Math.abs((p[2] as number) - 1) < 1e-9)
        top.push(Math.atan2(p[1] as number, p[0] as number));
    }
    expect(top.length).toBe(7);
    top.sort((a, b) => a - b);
    top.push((top[0] as number) + 2 * Math.PI);
    let widest = 0;
    for (let i = 1; i < top.length; i++)
      widest = Math.max(widest, (top[i] as number) - (top[i - 1] as number));
    expect(widest).toBeLessThanOrEqual(angle + 1e-9);
  });

  it('the role reaches the mesh faces', () => {
    const m = tessellate(must(box({ size: [1, 1, 1], role: 'detail' })));
    if (!m.ok) throw new Error('tessellate');
    expect(m.value.roleNames).toContain('detail');
    const idx = m.value.roleNames.indexOf('detail');
    for (const f of m.value.faces()) expect(m.value.fRole[f]).toBe(idx);
  });

  it('a vertex moved by 1e-4 is reported as a vertex mismatch specifically', () => {
    const m = clone(must(box({ size: [2, 3, 4] })));
    m.vertices[0]!.p[0] += 1e-4;
    const report = validate(m as Shape);
    expect(report.issues.some((i) => i.code === 'brep-vertex-mismatch')).toBe(true);
  });

  it('a pcurve wrong only between its endpoints is caught by the interior samples', () => {
    const m = clone(must(cylinder({ radius: 1, height: 2 })));
    const e = m.coedges.find(
      (c) =>
        c.pcurve.kind === 'line' &&
        Math.abs(c.pcurve.d[0]) > 0.5 &&
        Math.abs(c.pcurve.d[1]) < 1e-12,
    );
    if (e === undefined || e.pcurve.kind !== 'line') throw new Error('rim coedge');
    const t0 = m.edges[e.edge]!.t0;
    const d0 = e.pcurve.d[0];
    e.pcurve = { kind: 'line', o: [e.pcurve.o[0] + 2 * d0 * t0, e.pcurve.o[1]], d: [-d0, 0] };
    const report = validate(m as Shape);
    expect(report.issues.some((i) => i.code === 'brep-pcurve-mismatch')).toBe(true);
  });

  it('an outer loop declared inner (and the reverse) is brep-orientation', () => {
    const m = clone(must(extrude({ profile: outline(), holes: [sq(3, 3, 2)], depth: 1 })));
    const face = m.faces.find((f) => f.loops.length === 2)!;
    for (const l of face.loops) m.loops[l]!.outer = !m.loops[l]!.outer;
    const report = validate(m as Shape);
    expect(report.issues.some((i) => i.code === 'brep-orientation')).toBe(true);
  });

  it('a zero-area outline is stopped by the builder guard, not by a later topology error', () => {
    const r = extrude({
      profile: [
        [0, 0],
        [1, 1],
        [2, 2],
      ],
      depth: 1,
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.expected).toContain('non-zero area');
  });
});
