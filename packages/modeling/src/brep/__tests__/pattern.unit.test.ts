import { describe, expect, it } from 'vitest';
import { interpolate } from '../../nurbs';
import { box, cylinder } from '../build';
import { measure } from '../measure';
import {
  applyPattern,
  circularPattern,
  linearPattern,
  mirrorPair,
  type PatternLine,
} from '../pattern';
import { sweep } from '../sweep';
import { tessellate } from '../tessellate';
import { type Placement, transformShape } from '../transform';
import type { Shape } from '../types';
import { validate } from '../validate';
import type { P3 } from '../vec';
import { deviation, nurbsSurfaceCount, tessellationGap } from './placement-support';

function must<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

const Z: PatternLine = { origin: [0, 0, 0], direction: [0, 0, 1] };
const IDENTITY: Placement['rot'] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
const IDENTITY_PLACEMENT: Placement = { rot: IDENTITY, t: [0, 0, 0] };

/** A bore turned 0.37 rad about its own axis so its seam is off the flange's, then moved to `at`. */
function bore(radius: number, at: P3, height = 20): Shape {
  const c = Math.cos(0.37);
  const s = Math.sin(0.37);
  const p: Placement = {
    rot: [
      [c, -s, 0],
      [s, c, 0],
      [0, 0, 1],
    ],
    t: at,
  };
  return must(transformShape(must(cylinder({ radius, height })), p));
}

/** Axis point of a tool copy: the origin of its cylinder surface frame. */
function centre(s: Shape): P3 {
  for (const surface of s.surfaces) if (surface.kind === 'cylinder') return surface.frame.o;
  throw new Error('no cylinder surface');
}

const near = (a: P3, b: P3, eps = 1e-9) => a.every((x, i) => Math.abs(x - (b[i] as number)) < eps);

describe('linearPattern', () => {
  it('places count copies spacing apart along the unit direction, copy 0 untouched', () => {
    const tool = bore(2, [1, 2, 0]);
    const copies = must(linearPattern(tool, { direction: [0, 3, 0], spacing: 5, count: 4 }));
    expect(copies).toHaveLength(4);
    for (let i = 0; i < copies.length; i++) {
      expect(near(centre(copies[i] as Shape), [1, 2 + 5 * i, 0])).toBe(true);
    }
  });

  it('follows a slanted direction by the normalised vector', () => {
    const tool = bore(2, [0, 0, 0]);
    const copies = must(linearPattern(tool, { direction: [3, 4, 0], spacing: 10, count: 3 }));
    expect(near(centre(copies[2] as Shape), [12, 16, 0])).toBe(true);
  });

  it('refuses bad arguments with brep-bad-argument', () => {
    const tool = bore(2, [0, 0, 0]);
    const bads = [
      { direction: [0, 0, 0] as P3, spacing: 1, count: 2 },
      { direction: [1, 0, 0] as P3, spacing: 0, count: 2 },
      { direction: [1, 0, 0] as P3, spacing: Number.NaN, count: 2 },
      { direction: [1, 0, 0] as P3, spacing: 1, count: 0 },
      { direction: [1, 0, 0] as P3, spacing: 1, count: 2.5 },
      { direction: [1, 0, 0] as P3, spacing: 1, count: 5000 },
      { direction: [Number.NaN, 0, 0] as P3, spacing: 1, count: 2 },
    ];
    for (const o of bads) {
      const r = linearPattern(tool, o);
      expect(r.ok).toBe(false);
      if (!r.ok) expect((r.error.detail as { brep?: string }).brep).toBe('brep-bad-argument');
    }
  });
});

describe('circularPattern', () => {
  it('spaces a full turn by 2 pi / count and keeps the radius', () => {
    const copies = must(circularPattern(bore(2, [10, 0, 0]), { axis: Z, count: 6 }));
    for (let i = 0; i < copies.length; i++) {
      const a = (2 * Math.PI * i) / 6;
      expect(near(centre(copies[i] as Shape), [10 * Math.cos(a), 10 * Math.sin(a), 0])).toBe(true);
    }
  });

  it('spaces a partial sweep by sweep / (count - 1) so both ends are hit', () => {
    const copies = must(
      circularPattern(bore(2, [10, 0, 0]), { axis: Z, count: 3, sweep: Math.PI / 2 }),
    );
    expect(
      near(centre(copies[1] as Shape), [10 * Math.cos(Math.PI / 4), 10 * Math.sin(Math.PI / 4), 0]),
    ).toBe(true);
    expect(near(centre(copies[2] as Shape), [0, 10, 0], 1e-9)).toBe(true);
  });

  it('turns about an axis that does not pass through the origin', () => {
    const axis: PatternLine = { origin: [5, 5, 0], direction: [0, 0, 2] };
    const copies = must(circularPattern(bore(1, [8, 5, 0]), { axis, count: 4 }));
    expect(near(centre(copies[1] as Shape), [5, 8, 0])).toBe(true);
    expect(near(centre(copies[2] as Shape), [2, 5, 0])).toBe(true);
  });

  it('turns about a tilted axis (Rodrigues) and keeps copies congruent', () => {
    const tilt: PatternLine = { origin: [0, 0, 0], direction: [1, 0, 0] };
    const tool = bore(1, [0, 4, 0], 6);
    const copies = must(circularPattern(tool, { axis: tilt, count: 4 }));
    expect(near(centre(copies[1] as Shape), [0, 0, 4], 1e-9)).toBe(true);
    expect(near(centre(copies[2] as Shape), [0, -4, 0], 1e-9)).toBe(true);
    const v0 = must(measure(tool)).volume;
    for (const c of copies) expect(must(measure(c)).volume).toBeCloseTo(v0, 9);
  });

  it('refuses bad arguments with brep-bad-argument', () => {
    const tool = bore(1, [4, 0, 0]);
    const bads = [
      { axis: { origin: [0, 0, 0] as P3, direction: [0, 0, 0] as P3 }, count: 3 },
      { axis: Z, count: 0 },
      { axis: Z, count: 3, sweep: 0 },
      { axis: Z, count: 3, sweep: 7 },
      { axis: Z, count: 3, sweep: Number.NaN },
    ];
    for (const o of bads) {
      const r = circularPattern(tool, o);
      expect(r.ok).toBe(false);
      if (!r.ok) expect((r.error.detail as { brep?: string }).brep).toBe('brep-bad-argument');
    }
  });
});

describe('mirrorPair', () => {
  it('returns the tool and its half turn about the line', () => {
    const [a, b] = must(
      mirrorPair(bore(2, [7, 0, 0]), { origin: [0, 0, 0], direction: [0, 0, 1] }),
    );
    expect(near(centre(a as Shape), [7, 0, 0])).toBe(true);
    expect(near(centre(b as Shape), [-7, 0, 0])).toBe(true);
  });

  it('rejects a zero direction', () => {
    expect(mirrorPair(bore(2, [7, 0, 0]), { origin: [0, 0, 0], direction: [0, 0, 0] }).ok).toBe(
      false,
    );
  });
});

describe('applyPattern: bolt circle on a flange', () => {
  const R = 40;
  const T = 8;
  const flange = () => must(cylinder({ radius: R, height: T }));

  it.each([1, 2, 3, 6, 8, 12, 16])('cuts %i bores: volume and face count are exact', (n) => {
    const r = 3;
    const tools = must(circularPattern(bore(r, [28, 0, 0]), { axis: Z, count: n }));
    const out = must(applyPattern(flange(), tools));
    expect(validate(out).ok).toBe(true);
    expect(out.faces).toHaveLength(3 + n);
    const expected = Math.PI * R * R * T - n * Math.PI * r * r * T;
    expect(Math.abs(must(measure(out)).volume - expected)).toBeLessThan(1e-7);
  });

  it('union of copies adds their volume above the flange', () => {
    const stud = bore(2, [28, 0, 7], 10);
    const tools = must(circularPattern(stud, { axis: Z, count: 6 }));
    const out = must(applyPattern(flange(), tools, 'union'));
    const expected = Math.PI * R * R * T + 6 * Math.PI * 4 * 8;
    expect(Math.abs(must(measure(out)).volume - expected)).toBeLessThan(1e-7);
  });

  it('fail-closes at the first copy whose bore touches its neighbour, naming the copy and the boolean', () => {
    const tools = must(circularPattern(bore(6, [28, 0, 0]), { axis: Z, count: 15 }));
    const r = applyPattern(flange(), tools);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const d = r.error.detail as {
        reason?: string;
        copy?: number;
        copies?: number;
        cause?: string;
      };
      expect(d.reason).toBe('pattern-step');
      expect(d.copy).toBe(1);
      expect(d.copies).toBe(15);
      expect(d.cause).toBe('a circle partly inside the planar face');
    }
  });

  it('fail-closes (not a wrong shape) for a bore that crosses the rim', () => {
    const r = applyPattern(flange(), [bore(8, [36, 0, 0])]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.error.detail as { copy?: number }).copy).toBe(0);
  });

  it('refuses an empty tool list', () => {
    const r = applyPattern(flange(), []);
    expect(r.ok).toBe(false);
  });
});

describe('applyPattern: hole grid on a plate', () => {
  const plate = () => must(box({ size: [100, 70, 8] }));

  function grid(nx: number, ny: number, sp: number, r: number): Shape[] {
    const tools: Shape[] = [];
    for (let j = 0; j < ny; j++) {
      const start = bore(r, [(-sp * (nx - 1)) / 2, (-sp * (ny - 1)) / 2 + j * sp, 0]);
      tools.push(...must(linearPattern(start, { direction: [1, 0, 0], spacing: sp, count: nx })));
    }
    return tools;
  }

  // Measured 141 s alone on the shared host (a synchronous 12-bore boolean, not a hang); x1.5 headroom.
  it('a 3 x 4 grid of r4 holes: 12 through bores, exact volume', { timeout: 212000 }, () => {
    const out = must(applyPattern(plate(), grid(3, 4, 20, 4)));
    expect(validate(out).ok).toBe(true);
    expect(out.faces).toHaveLength(6 + 12);
    const expected = 100 * 70 * 8 - 12 * Math.PI * 16 * 8;
    expect(Math.abs(must(measure(out)).volume - expected)).toBeLessThan(1e-7);
  });

  it('holes of r9 on a pitch of 20 fail-close at copy 0 (the boolean cannot trace the box face)', () => {
    const r = applyPattern(plate(), grid(3, 4, 20, 9));
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.error.detail as { copy?: number }).copy).toBe(0);
  });
});

describe('linearPattern and circularPattern of a swept NURBS part', () => {
  const SQUARE = [
    [-0.25, -0.25],
    [0.25, -0.25],
    [0.25, 0.25],
    [-0.25, 0.25],
  ] as const;
  const path = () =>
    must(
      interpolate(
        [
          [0, 0, 0],
          [1, 0.5, 1],
          [0.5, 1.5, 2],
          [-0.5, 1, 3],
        ],
        { degree: 3 },
      ),
    );
  const bracket = () =>
    must(
      sweep({
        profile: SQUARE,
        path: { kind: 'nurbs', curve: path() },
        xHint: [0, 0, 1],
        stations: 9,
      }),
    );

  it('linearPattern: each copy is a valid NURBS shape exactly offset by its spacing', () => {
    const part = bracket();
    const copies = must(linearPattern(part, { direction: [0, 0, 1], spacing: 4, count: 4 }));
    expect(copies).toHaveLength(4);
    const expectOffset = (i: number) => ({ rot: IDENTITY, t: [0, 0, 4 * i] as P3 });
    for (let i = 0; i < copies.length; i++) {
      const copy = copies[i] as Shape;
      expect(validate(copy).ok).toBe(true);
      expect(deviation(part, copy, expectOffset(i))).toBeLessThanOrEqual(1e-12);
      expect(Math.abs(must(measure(copy)).area - must(measure(part)).area)).toBeLessThan(1e-9);
    }
  });

  it('circularPattern: 12 copies of a swept bracket around a tilted axis, all valid and exactly placed', () => {
    const part = bracket();
    const axis = { origin: [4, 0, 0] as P3, direction: [0, 1, 1] as P3 };
    const t0 = performance.now();
    const copies = must(circularPattern(part, { axis, count: 12 }));
    const elapsed = performance.now() - t0;
    expect(copies).toHaveLength(12);
    for (let i = 0; i < copies.length; i++) {
      const copy = copies[i] as Shape;
      expect(validate(copy).ok, `copy ${i}`).toBe(true);
      expect(nurbsSurfaceCount(copy)).toBe(nurbsSurfaceCount(part));
      expect(Math.abs(must(measure(copy)).volume - must(measure(part)).volume)).toBeLessThan(
        1e-3 * Math.abs(must(measure(part)).volume),
      );
    }
    expect(copies.every((c) => c !== undefined)).toBe(true);
    // Copy 0 is the tool itself; the transform of a full turn is exact for every copy.
    expect(deviation(part, copies[0] as Shape, IDENTITY_PLACEMENT)).toBeLessThanOrEqual(1e-12);
    expect(elapsed).toBeLessThan(60000);
  });

  it('tessellates one swept copy to the same mesh as its source, moved by the copy placement', () => {
    const part = bracket();
    const copies = must(linearPattern(part, { direction: [1, 0, 0], spacing: 2, count: 2 }));
    const copy = copies[1] as Shape;
    const p = { rot: IDENTITY, t: [2, 0, 0] as P3 };
    expect(tessellationGap(must(tessellate(part)), must(tessellate(copy)), p)).toBeLessThanOrEqual(
      1e-9,
    );
  });
});
