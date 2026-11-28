import { describe, expect, it } from 'vitest';
import { type Model, model } from '../../model';
import { box, extrude } from '../build';
import * as stage from '../index';
import { measure } from '../measure';
import { faceReference, selectFace, selectFaces } from '../select';
import type { Shape } from '../types';
import { validate } from '../validate';

type Pt = [number, number];

function must<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

function code(r: { ok: boolean; error?: { detail?: unknown } }): unknown {
  return r.ok ? 'ok' : (r.error?.detail as { brep?: string } | undefined)?.brep;
}

/** Even-odd containment of a (x, y) point in the face's loops of a z-extruded planar profile. */
function inside(p: readonly number[], rings: Pt[][]): boolean {
  let hit = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i] as Pt;
      const b = ring[j] as Pt;
      if (a[1] > (p[1] as number) !== b[1] > (p[1] as number)) {
        const x = a[0] + (((p[1] as number) - a[1]) * (b[0] - a[0])) / (b[1] - a[1]);
        if ((p[0] as number) < x) hit = !hit;
      }
    }
  }
  return hit;
}

function topOf(shape: Shape): number {
  return must(
    selectFace(shape, { normal: { dir: [0, 0, 1] }, near: { point: [5, 5, 1], radius: 1e9 } }),
  );
}

describe('O1: large profiles never throw and stay near-linear', () => {
  const circle = (n: number): Pt[] =>
    Array.from({ length: n }, (_, i) => [
      Math.cos((2 * Math.PI * i) / n),
      Math.sin((2 * Math.PI * i) / n),
    ]);

  it('a 4096-point profile builds, validates and measures within 1e-3 of the disc', () => {
    const t = Date.now();
    const shape = must(extrude({ profile: circle(4096), depth: 1 }));
    expect(Date.now() - t).toBeLessThan(10_000);
    expect(validate(shape).ok).toBe(true);
    expect(Math.abs(must(measure(shape)).volume / Math.PI - 1)).toBeLessThan(1e-3);
  });

  it('doubling the points does not quadruple the build time', () => {
    const time = (n: number) => {
      const t = performance.now();
      must(extrude({ profile: circle(n), depth: 1 }));
      return performance.now() - t;
    };
    time(256);
    const small = time(512);
    const large = time(2048);
    expect(large / small).toBeLessThan(12);
  });

  it('a 4096-point model op returns a Result (never throws)', () => {
    const m = model({ exact: stage });
    const r = m.brep.extrude('disc', { profile: circle(4096), depth: 1 });
    expect(['ok', 'failed']).toContain(r.status);
  });
});

describe('O9: select rejects non-finite query inputs', () => {
  const plate = must(box({ size: [2, 3, 4] }));
  const bad: [string, Parameters<typeof selectFaces>[1]][] = [
    ['string direction element', { normal: { dir: ['1', 0, 0] as never } }],
    ['string angle', { normal: { dir: [0, 0, 1], angle: '1' as never } }],
    ['null near', { near: null as never }],
    ['null normal', { normal: null as never }],
    ['string radius', { near: { point: [0, 0, 0], radius: '1' as never } }],
    ['Infinity direction', { normal: { dir: [Infinity, 0, 1] } }],
    ['NaN direction', { normal: { dir: [NaN, 0, 1] } }],
    ['short direction', { normal: { dir: [0, 1] as never } }],
    ['NaN point', { near: { point: [NaN, 0, 0], radius: 1 } }],
    ['Infinity point', { near: { point: [0, Infinity, 0], radius: 1 } }],
    ['missing point', { near: { radius: 1 } as never }],
  ];
  for (const [name, query] of bad) {
    it(`${name} is brep-bad-argument, not a match-all`, () => {
      const r = selectFaces(plate, query);
      expect(code(r)).toBe('brep-bad-argument');
      expect(code(selectFace(plate, query))).toBe('brep-bad-argument');
    });
  }
});

describe('O10: faceReference lies on the face for holed and non-convex planar faces', () => {
  const cases: [string, Pt[], Pt[][]][] = [
    [
      'plate with a central hole',
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ],
      [
        [
          [4, 4],
          [6, 4],
          [6, 6],
          [4, 6],
        ],
      ],
    ],
    [
      'U extrusion',
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [7, 10],
        [7, 3],
        [3, 3],
        [3, 10],
        [0, 10],
      ],
      [],
    ],
    [
      'L extrusion',
      [
        [0, 0],
        [10, 0],
        [10, 3],
        [3, 3],
        [3, 10],
        [0, 10],
      ],
      [],
    ],
    [
      'plate with an off-centre hole and a notch',
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [6, 10],
        [6, 7],
        [4, 7],
        [4, 10],
        [0, 10],
      ],
      [
        [
          [1, 1],
          [9, 1],
          [9, 5],
          [1, 5],
        ],
      ],
    ],
  ];
  for (const [name, outline, holes] of cases) {
    it(`${name}: the top reference is inside the region and a near query at it finds the face`, () => {
      const shape = must(extrude({ profile: outline, holes, depth: 1 }));
      const top = must(
        selectFaces(shape, { normal: { dir: [0, 0, 1] }, near: { point: [5, 5, 1], radius: 1e9 } }),
      ).filter((f) => faceReference(shape, f).point[2] > 0.5)[0] as number;
      const ref = faceReference(shape, top);
      expect(inside(ref.point, [outline, ...holes])).toBe(true);
      expect(ref.point[2]).toBeCloseTo(1, 12);
      const found = must(
        selectFaces(shape, {
          normal: { dir: [0, 0, 1] },
          near: { point: ref.point, radius: 1e-6 },
        }),
      );
      expect(found).toEqual([top]);
    });
  }

  it('a near query at the hole centre does not select the top face', () => {
    const shape = must(
      extrude({
        profile: [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
        ],
        holes: [
          [
            [4, 4],
            [6, 4],
            [6, 6],
            [4, 6],
          ],
        ],
        depth: 1,
      }),
    );
    expect(
      must(
        selectFaces(shape, { normal: { dir: [0, 0, 1] }, near: { point: [5, 5, 1], radius: 0.5 } }),
      ),
    ).toEqual([]);
    expect(topOf(shape)).toBeGreaterThanOrEqual(0);
  });
});

describe('Lows from the re-audit', () => {
  it('a frame origin far from the part is rejected (precision), a near origin is accepted', () => {
    const far = box({
      size: [1, 1, 1],
      frame: { o: [1e15, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] },
    });
    expect(code(far)).toBe('brep-bad-argument');
    expect(!far.ok && (far.error.detail as { reason?: string }).reason).toBe('origin-too-far');
    const near = box({
      size: [1, 1, 1],
      frame: { o: [1e5, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] },
    });
    expect(near.ok).toBe(true);
  });

  it('JSON null tolerances (a NaN round trip) are rejected by validate', () => {
    const shape = JSON.parse(JSON.stringify(must(box({ size: [1, 1, 1] })))) as {
      edges: { tol: unknown }[];
      vertices: { tol: unknown }[];
    };
    (shape.edges[0] as { tol: unknown }).tol = null;
    expect(validate(shape as unknown as Shape).ok).toBe(false);
    const other = JSON.parse(JSON.stringify(must(box({ size: [1, 1, 1] })))) as typeof shape;
    (other.vertices[0] as { tol: unknown }).tol = null;
    expect(validate(other as unknown as Shape).ok).toBe(false);
  });

  const partial = (m: Record<string, unknown>) => ({ ...stage, ...m }) as never;
  const broken: [string, unknown][] = [
    ['null', null],
    ['an empty object', {}],
    ['a stage without box', partial({ box: undefined })],
    ['a stage without tessellate', partial({ tessellate: undefined })],
    ['a stage without limits', partial({ BREP_LIMITS: undefined })],
    ['a stage with NaN face limit', partial({ BREP_LIMITS: { faces: Number.NaN, edges: 4096 } })],
    ['a stage with a missing edge limit', partial({ BREP_LIMITS: { faces: 4096 } })],
  ];
  for (const [name, value] of broken) {
    it(`exact: ${name} fails at injection with model-invalid-argument`, () => {
      const m: Model = model({ exact: value as never });
      expect(m.poisoned?.code).toBe('model-invalid-argument');
      const r = m.brep.box('b', { size: [1, 1, 1] });
      expect(r.status).toBe('skipped');
    });
  }

  it('a complete stage is accepted and no stage at all stays capability-unavailable with a correct hint', () => {
    expect(model({ exact: stage }).poisoned).toBeUndefined();
    const r = model().brep.box('b', { size: [1, 1, 1] });
    expect(r.error?.code).toBe('model-capability-unavailable');
    expect(r.error?.hint).toContain('@forgeax/engine-modeling/brep');
    expect(r.error?.hint).not.toContain('toolchain');
  });
});

describe('O10 round 2: the reference never lies on a loop edge', () => {
  function edgeDistance(p: readonly number[], rings: Pt[][]): number {
    let best = Infinity;
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i] as Pt;
        const b = ring[j] as Pt;
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const t = Math.max(
          0,
          Math.min(
            1,
            (((p[0] as number) - a[0]) * dx + ((p[1] as number) - a[1]) * dy) / (dx * dx + dy * dy),
          ),
        );
        best = Math.min(
          best,
          Math.hypot((p[0] as number) - a[0] - t * dx, (p[1] as number) - a[1] - t * dy),
        );
      }
    }
    return best;
  }
  function checkFaces(outline: Pt[], holes: Pt[][]): void {
    const shape = must(extrude({ profile: outline, holes, depth: 1 }));
    for (let f = 0; f < shape.faces.length; f++) {
      const ref = faceReference(shape, f);
      if (Math.abs(ref.normal[2]) < 0.5) continue;
      expect(inside(ref.point, [outline, ...holes])).toBe(true);
      expect(edgeDistance(ref.point, [outline, ...holes])).toBeGreaterThan(1e-6);
    }
  }

  it('L profile and 8x8 plate with the [2,6] hole', () => {
    checkFaces(
      [
        [0, 0],
        [4, 0],
        [4, 2],
        [2, 2],
        [2, 4],
        [0, 4],
      ],
      [],
    );
    checkFaces(
      [
        [0, 0],
        [10, 0],
        [10, 3],
        [3, 3],
        [3, 10],
        [0, 10],
      ],
      [],
    );
    checkFaces(
      [
        [0, 0],
        [8, 0],
        [8, 8],
        [0, 8],
      ],
      [
        [
          [2, 2],
          [6, 2],
          [6, 6],
          [2, 6],
        ],
      ],
    );
  });

  // Measured 98.9 s alone and 160 s on the shared host under load (a synchronous 723-plate sweep, not a
  // hang). The limit covers the loaded measurement with headroom; the assertions are unchanged.
  it('723 seeded plates: every top and bottom reference is strictly interior', {
    timeout: 300000,
  }, () => {
    let seed = 12345;
    const next = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    let plates = 0;
    while (plates < 723) {
      const size = 6 + next(10);
      const x0 = 1 + next(size - 4);
      const y0 = 1 + next(size - 4);
      const x1 = x0 + 1 + next(size - 1 - x0);
      const y1 = y0 + 1 + next(size - 1 - y0);
      checkFaces(
        [
          [0, 0],
          [size, 0],
          [size, size],
          [0, size],
        ],
        [
          [
            [x0, y0],
            [x1, y0],
            [x1, y1],
            [x0, y1],
          ],
        ],
      );
      plates++;
    }
  });
});
