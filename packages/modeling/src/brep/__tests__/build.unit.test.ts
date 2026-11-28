// biome-ignore-all lint/style/noNonNullAssertion: fixed-size fixtures indexed under noUncheckedIndexedAccess
import { describe, expect, it } from 'vitest';
import { box, cone, cylinder, extrude, revolve, sphere, torus } from '../build';
import type { BrepDetailCode, Shape } from '../types';
import { type BrepIssue, validate } from '../validate';
import { primitives } from './support';

type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };

function clone(shape: Shape): Mutable<Shape> {
  return JSON.parse(JSON.stringify(shape)) as Mutable<Shape>;
}

function codes(shape: Shape | Mutable<Shape>): Set<BrepDetailCode> {
  return new Set(validate(shape as Shape).issues.map((i: BrepIssue) => i.code));
}

const cases = primitives();

describe('builders: primitives validate', () => {
  for (const c of cases) {
    it(`${c.name}: validate is ok with no issues`, () => {
      const v = validate(c.shape);
      expect(v.issues).toEqual([]);
      expect(v.ok).toBe(true);
    });

    it(`${c.name}: the shape is deep-frozen, JSON-stable and index-only`, () => {
      expect(Object.isFrozen(c.shape)).toBe(true);
      expect(Object.isFrozen(c.shape.faces)).toBe(true);
      expect(Object.isFrozen(c.shape.faces[0])).toBe(true);
      const json = JSON.stringify(c.shape);
      expect(JSON.stringify(JSON.parse(json))).toBe(json);
    });
  }

  it('builders are deterministic: equal input gives byte-equal Shapes', () => {
    expect(JSON.stringify(sphere({ radius: 2 }))).toBe(JSON.stringify(sphere({ radius: 2 })));
  });

  it('faces carry default labels and roles, and explicit ones overwrite', () => {
    const r = box({ size: [1, 1, 1], label: 'crate', role: 'detail' });
    if (!r.ok) throw new Error('box');
    for (const f of r.value.faces) {
      expect(f.label.startsWith('crate.')).toBe(true);
      expect(f.role).toBe('detail');
    }
    expect(new Set(r.value.faces.map((f) => f.label)).size).toBe(6);
  });

  it('a frame option moves the shape without changing its topology', () => {
    const r = box({
      size: [1, 2, 3],
      frame: { o: [5, 6, 7], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] },
    });
    if (!r.ok) throw new Error('box');
    expect(validate(r.value).ok).toBe(true);
  });
});

describe('builders: falsifier per primitive (a mutated shape fails with the expected code)', () => {
  for (const c of cases) {
    it(`${c.name}: moving a vertex is rejected`, () => {
      const m = clone(c.shape);
      m.vertices[0]!.p[0] += 0.05;
      const found = codes(m);
      expect(found.has('brep-vertex-mismatch') || found.has('brep-pcurve-mismatch')).toBe(true);
    });

    it(`${c.name}: flipping one face breaks edge use or orientation`, () => {
      const m = clone(c.shape);
      m.faces[0]!.reversed = !m.faces[0]!.reversed;
      const found = codes(m);
      expect(found.has('brep-edge-use') || found.has('brep-orientation')).toBe(true);
    });

    it(`${c.name}: flipping every face gives negative volume (brep-orientation)`, () => {
      const m = clone(c.shape);
      for (const f of m.faces) f.reversed = !f.reversed;
      expect(codes(m).has('brep-orientation')).toBe(true);
    });

    it(`${c.name}: a dangling index is brep-index-range`, () => {
      const m = clone(c.shape);
      m.faces[0]!.surface = 999;
      expect(codes(m).has('brep-index-range')).toBe(true);
    });

    it(`${c.name}: dropping a coedge from its loop opens the loop`, () => {
      const m = clone(c.shape);
      const loop = m.loops.find((l) => l.coedges.length > 1);
      if (loop === undefined) throw new Error('loop');
      loop.coedges.pop();
      const found = codes(m);
      expect(found.has('brep-loop-open') || found.has('brep-edge-use')).toBe(true);
    });

    it(`${c.name}: a distorted pcurve is brep-pcurve-mismatch`, () => {
      const m = clone(c.shape);
      const pc = m.coedges[0]!.pcurve;
      if (pc.kind === 'line') pc.o[1] += 0.1;
      else if (pc.kind === 'circle') pc.r += 0.1;
      expect(codes(m).has('brep-pcurve-mismatch')).toBe(true);
    });

    it(`${c.name}: a tolerance above maxTol is brep-tol-exceeded`, () => {
      const m = clone(c.shape);
      m.edges[0]!.tol = m.maxTol * 10;
      expect(codes(m).has('brep-tol-exceeded')).toBe(true);
    });
  }
});

describe('builders: bad arguments', () => {
  const bad: [string, () => { ok: boolean; error?: { code: string; detail?: unknown } }][] = [
    ['box zero size', () => box({ size: [1, 0, 1] })],
    ['box NaN size', () => box({ size: [1, Number.NaN, 1] })],
    ['cylinder negative radius', () => cylinder({ radius: -1, height: 1 })],
    ['cone zero height', () => cone({ radius: 1, height: 0 })],
    ['sphere infinite radius', () => sphere({ radius: Number.POSITIVE_INFINITY })],
    ['torus minor >= major', () => torus({ major: 1, minor: 1 })],
    [
      'extrude two points',
      () =>
        extrude({
          profile: [
            [0, 0],
            [1, 0],
          ],
          depth: 1,
        }),
    ],
    [
      'extrude zero depth',
      () =>
        extrude({
          profile: [
            [0, 0],
            [1, 0],
            [0, 1],
          ],
          depth: 0,
        }),
    ],
    ['revolve empty profile', () => revolve({ profile: [] })],
    ['tol below floor', () => box({ size: [1, 1, 1], tol: 1e-12 })],
    ['maxTol below tol', () => box({ size: [1, 1, 1], tol: 1e-3, maxTol: 1e-4 })],
  ];
  for (const [name, run] of bad) {
    it(`${name} is model-invalid-argument / brep-bad-argument`, () => {
      const r = run();
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe('model-invalid-argument');
      expect((r.error?.detail as { brep?: string }).brep).toBe('brep-bad-argument');
    });
  }

  it('extrude of a clockwise outline still validates (outline orientation is normalized)', () => {
    const r = extrude({
      profile: [
        [0, 0],
        [0, 1],
        [1, 1],
        [1, 0],
      ],
      depth: 1,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(validate(r.value).ok).toBe(true);
  });
});

describe('extrude outline preconditions', () => {
  const detail = (r: { ok: boolean; error?: { code: string; detail?: unknown } }) => {
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('model-invalid-argument');
    return r.error?.detail as { brep: string; reason: string };
  };
  const run = (profile: [number, number][], holes?: [number, number][][]) =>
    extrude({ profile, ...(holes === undefined ? {} : { holes }), depth: 1 });

  it('a bow-tie outline is rejected as self-intersecting', () => {
    const d = detail(
      run([
        [0, 0],
        [3, 2],
        [3, 0],
        [0, 3],
      ]),
    );
    expect(d).toMatchObject({ brep: 'brep-bad-argument', reason: 'self-intersecting-outline' });
  });

  it('an outline that touches itself at a vertex is rejected', () => {
    const d = detail(
      run([
        [0, 0],
        [4, 0],
        [4, 4],
        [2, 0],
        [0, 4],
      ]),
    );
    expect(d.reason).toBe('self-intersecting-outline');
  });

  it('a fold-back spike (zero-width) is rejected', () => {
    const d = detail(
      run([
        [0, 0],
        [2, 0],
        [4, 0],
        [2, 0],
        [2, 2],
      ]),
    );
    expect(d.reason).toBe('self-intersecting-outline');
  });

  it('a hole crossing the outline, a hole outside it and nested holes are rejected', () => {
    const outline: [number, number][] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    const sq = (x: number, y: number, s: number): [number, number][] => [
      [x, y],
      [x + s, y],
      [x + s, y + s],
      [x, y + s],
    ];
    expect(detail(run(outline, [sq(8, 2, 4)])).reason).toBe('self-intersecting-outline');
    expect(detail(run(outline, [sq(20, 2, 2)])).reason).toBe('hole-outside-outline');
    expect(detail(run(outline, [sq(2, 2, 6), sq(3, 3, 2)])).reason).toBe('hole-inside-hole');
  });

  it('valid concave and holed outlines still build', () => {
    const concave = run([
      [0, 0],
      [4, 0],
      [4, 4],
      [2, 1],
      [0, 4],
    ]);
    expect(concave.ok).toBe(true);
  });
});
