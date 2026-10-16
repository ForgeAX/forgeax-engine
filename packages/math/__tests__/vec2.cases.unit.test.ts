// Consolidated by feat-20260609-test-pool-startup-reduction-merge-tiny-test-files
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: scope isolation between merged source files
//
// Source files (N=13):
//   - packages/math/src/__tests__/box3.test.ts
//   - packages/math/src/__tests__/color.test.ts
//   - packages/math/src/__tests__/euler.test.ts
//   - packages/math/src/__tests__/f32-to-f16-bytes.test.ts
//   - packages/math/src/__tests__/frustum.test.ts
//   - packages/math/src/__tests__/mat3.test.ts
//   - packages/math/src/__tests__/mat4.test.ts
//   - packages/math/src/__tests__/quat.test.ts
//   - packages/math/src/__tests__/ray.test.ts
//   - packages/math/src/__tests__/sphere.test.ts
//   - packages/math/src/__tests__/vec2.test.ts
//   - packages/math/src/__tests__/vec3.test.ts
//   - packages/math/src/__tests__/vec4.test.ts
//
// Paradigm: each block-scoped describe('<source-filename>.test.ts', ...) preserves
// source as ancestorTitles[0]. Top-level imports merged + deduped.
// import paths adjusted: ../X -> ../src/X (output is __tests__/, sources were src/__tests__/).

import { describe, expect, it } from 'vitest';
import * as box3 from '../src/box3';
import * as color from '../src/color';
import * as euler from '../src/euler';
import * as frustum from '../src/frustum';
import * as mat3 from '../src/mat3';
import * as mat4 from '../src/mat4';
import * as quat from '../src/quat';
import * as ray from '../src/ray';
import * as sphere from '../src/sphere';
import * as vec2 from '../src/vec2';
import * as vec3 from '../src/vec3';
import * as vec4 from '../src/vec4';
import { halfFloat } from '../src/index.js';
import type { EulerOrder, Mat3 as Mat3T, Mat4 as Mat4T, Vec3 as Vec3T } from '../src/types';
import {
  PERSPECTIVE_REVERSE_Z_FINITE_EXPECTED,
  PERSPECTIVE_REVERSE_Z_FINITE_INPUT,
  PERSPECTIVE_REVERSE_Z_INFINITE_EXPECTED,
  REVERSE_Z_FIXTURE_TOLERANCE,
  REVERSE_Z_PROJECTION_PROBES_FINITE,
  REVERSE_Z_PROJECTION_PROBES_INFINITE,
} from '../src/__tests__/_fixtures';

void [PERSPECTIVE_REVERSE_Z_FINITE_EXPECTED, PERSPECTIVE_REVERSE_Z_FINITE_INPUT, PERSPECTIVE_REVERSE_Z_INFINITE_EXPECTED, REVERSE_Z_FIXTURE_TOLERANCE, REVERSE_Z_PROJECTION_PROBES_FINITE, REVERSE_Z_PROJECTION_PROBES_INFINITE, box3, color, describe, euler, expect, frustum, halfFloat, it, mat3, mat4, quat, ray, sphere, vec2, vec3, vec4];
type __MergedKeep = EulerOrder | Mat3T | Mat4T | Vec3T;


{
  // --- from vec2.test.ts ---
// Vec2 unit tests — TDD red phase (T-011).
//
// Three tiers: normal / boundary / degenerate (covers NaN propagation + 0-vec normalize silent fall-back).
// vec2 ≥ 14 functions, includes perp (2D 90° rotation), excludes cross.
//
// Related: requirements §Surface vec2 lower bound 14; plan-strategy §6 M2 + AC-06 degenerate tests;
//          wiki/gl-matrix-overview Out-param four ironclad rules.


describe('vec2.create', () => {
  it('returns Float32Array length 2 zero by default (normal)', () => {
    const v = vec2.create();
    expect(v).toBeInstanceOf(Float32Array);
    expect(v.length).toBe(2);
    expect(v[0]).toBe(0);
    expect(v[1]).toBe(0);
  });

  it('accepts explicit components (boundary)', () => {
    const v = vec2.create(3, -4);
    expect(v[0]).toBe(3);
    expect(v[1]).toBe(-4);
  });

  it('NaN/Infinity stored verbatim per Float32Array semantics (degenerate)', () => {
    const v = vec2.create(Number.NaN, Number.POSITIVE_INFINITY);
    expect(Number.isNaN(v[0])).toBe(true);
    expect(v[1]).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('vec2.clone', () => {
  it('produces a new Float32Array with same values (normal)', () => {
    const a = vec2.create(1, 2);
    const b = vec2.clone(a);
    expect(b).not.toBe(a);
    expect(b[0]).toBe(1);
    expect(b[1]).toBe(2);
  });

  it('clone of zero vec is zero vec (boundary)', () => {
    const a = vec2.create();
    const b = vec2.clone(a);
    expect(b[0]).toBe(0);
    expect(b[1]).toBe(0);
  });
});

describe('vec2.copy', () => {
  it('copies a -> out and returns out (normal)', () => {
    const a = vec2.create(7, 11);
    const out = vec2.create();
    const ret = vec2.copy(out, a);
    expect(ret).toBe(out);
    expect(out[0]).toBe(7);
    expect(out[1]).toBe(11);
  });

  it('aliasing-safe: copy(v, v) is a no-op (degenerate)', () => {
    const v = vec2.create(1, 2);
    vec2.copy(v, v);
    expect(v[0]).toBe(1);
    expect(v[1]).toBe(2);
  });
});

describe('vec2.set', () => {
  it('writes components and returns out (normal)', () => {
    const out = vec2.create();
    const ret = vec2.set(out, 5, 6);
    expect(ret).toBe(out);
    expect(out[0]).toBe(5);
    expect(out[1]).toBe(6);
  });
});

describe('vec2.equals', () => {
  it('exact equality returns true (normal)', () => {
    expect(vec2.equals(vec2.create(1, 2), vec2.create(1, 2))).toBe(true);
  });

  it('within epsilon equality returns true (boundary)', () => {
    expect(vec2.equals(vec2.create(1, 2), vec2.create(1 + 1e-7, 2))).toBe(true);
  });

  it('NaN never equals NaN (degenerate)', () => {
    expect(vec2.equals(vec2.create(Number.NaN, 0), vec2.create(Number.NaN, 0))).toBe(false);
  });
});

describe('vec2.add', () => {
  it('component-wise add (normal)', () => {
    const out = vec2.add(vec2.create(), vec2.create(1, 2), vec2.create(3, 4));
    expect(out[0]).toBe(4);
    expect(out[1]).toBe(6);
  });

  it('aliasing-safe: add(v, v, v) doubles (degenerate)', () => {
    const v = vec2.create(1, 2);
    vec2.add(v, v, v);
    expect(v[0]).toBe(2);
    expect(v[1]).toBe(4);
  });
});

describe('vec2.sub', () => {
  it('component-wise sub (normal)', () => {
    const out = vec2.sub(vec2.create(), vec2.create(5, 7), vec2.create(1, 2));
    expect(out[0]).toBe(4);
    expect(out[1]).toBe(5);
  });

  it('a - a = 0 (boundary)', () => {
    const a = vec2.create(3, 4);
    const out = vec2.sub(vec2.create(), a, a);
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(0);
  });
});

describe('vec2.scale', () => {
  it('scales by scalar (normal)', () => {
    const out = vec2.scale(vec2.create(), vec2.create(1, 2), 3);
    expect(out[0]).toBe(3);
    expect(out[1]).toBe(6);
  });

  it('scale by 0 yields zero (boundary)', () => {
    const out = vec2.scale(vec2.create(), vec2.create(7, 11), 0);
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(0);
  });
});

describe('vec2.negate', () => {
  it('flips sign (normal)', () => {
    const out = vec2.negate(vec2.create(), vec2.create(1, -2));
    expect(out[0]).toBe(-1);
    expect(out[1]).toBe(2);
  });

  it('negate of zero is zero (boundary)', () => {
    const out = vec2.negate(vec2.create(), vec2.create());
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(0);
  });
});

describe('vec2.dot', () => {
  it('computes dot product (normal)', () => {
    expect(vec2.dot(vec2.create(1, 2), vec2.create(3, 4))).toBe(11);
  });

  it('orthogonal vectors → 0 (boundary)', () => {
    expect(vec2.dot(vec2.create(1, 0), vec2.create(0, 1))).toBe(0);
  });

  it('dot with zero is 0 (degenerate)', () => {
    expect(vec2.dot(vec2.create(), vec2.create(123, 456))).toBe(0);
  });
});

describe('vec2.lengthSq / length', () => {
  it('lengthSq of (3,4) is 25 (normal)', () => {
    expect(vec2.lengthSq(vec2.create(3, 4))).toBe(25);
  });

  it('length of (3,4) is 5 (normal)', () => {
    expect(vec2.length(vec2.create(3, 4))).toBeCloseTo(5);
  });

  it('length of zero is 0 (boundary)', () => {
    expect(vec2.length(vec2.create())).toBe(0);
  });
});

describe('vec2.distance', () => {
  it('distance between (1,1) and (4,5) is 5 (normal)', () => {
    expect(vec2.distance(vec2.create(1, 1), vec2.create(4, 5))).toBeCloseTo(5);
  });

  it('distance to self is 0 (boundary)', () => {
    const a = vec2.create(7, 11);
    expect(vec2.distance(a, a)).toBe(0);
  });
});

describe('vec2.normalize', () => {
  it('normalizes non-zero vec to unit length (normal)', () => {
    const out = vec2.normalize(vec2.create(), vec2.create(3, 4));
    expect(vec2.length(out)).toBeCloseTo(1);
    expect(out[0]).toBeCloseTo(0.6);
    expect(out[1]).toBeCloseTo(0.8);
  });

  it('zero vec → zero vec, no NaN, no throw (degenerate / D-P12)', () => {
    const out = vec2.normalize(vec2.create(), vec2.create());
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(0);
  });
});

describe('vec2.lerp', () => {
  it('t=0 returns a (boundary)', () => {
    const out = vec2.lerp(vec2.create(), vec2.create(1, 2), vec2.create(5, 6), 0);
    expect(out[0]).toBeCloseTo(1);
    expect(out[1]).toBeCloseTo(2);
  });

  it('t=1 returns b (boundary)', () => {
    const out = vec2.lerp(vec2.create(), vec2.create(1, 2), vec2.create(5, 6), 1);
    expect(out[0]).toBeCloseTo(5);
    expect(out[1]).toBeCloseTo(6);
  });

  it('t=0.5 returns midpoint (normal)', () => {
    const out = vec2.lerp(vec2.create(), vec2.create(0, 0), vec2.create(2, 4), 0.5);
    expect(out[0]).toBeCloseTo(1);
    expect(out[1]).toBeCloseTo(2);
  });
});

describe('vec2.min / max', () => {
  it('component-wise min (normal)', () => {
    const out = vec2.min(vec2.create(), vec2.create(1, 5), vec2.create(3, 2));
    expect(out[0]).toBe(1);
    expect(out[1]).toBe(2);
  });

  it('component-wise max (normal)', () => {
    const out = vec2.max(vec2.create(), vec2.create(1, 5), vec2.create(3, 2));
    expect(out[0]).toBe(3);
    expect(out[1]).toBe(5);
  });
});

describe('vec2.perp', () => {
  it('perp of (1,0) is (0,1) — 90° CCW (normal)', () => {
    const out = vec2.perp(vec2.create(), vec2.create(1, 0));
    expect(out[0]).toBeCloseTo(0);
    expect(out[1]).toBeCloseTo(1);
  });

  it('perp of (0,1) is (-1,0) (boundary)', () => {
    const out = vec2.perp(vec2.create(), vec2.create(0, 1));
    expect(out[0]).toBeCloseTo(-1);
    expect(out[1]).toBeCloseTo(0);
  });

  it('perp of zero is zero (degenerate)', () => {
    const out = vec2.perp(vec2.create(), vec2.create());
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(0);
  });

  it('perp(perp(v)) = -v (degenerate, involutive up to sign)', () => {
    const v = vec2.create(2, 3);
    const a = vec2.perp(vec2.create(), v);
    const b = vec2.perp(vec2.create(), a);
    expect(b[0]).toBeCloseTo(-2);
    expect(b[1]).toBeCloseTo(-3);
  });
});

describe('vec2 — V8 elements-kinds guard', () => {
  it('all returns are Float32Array (no number[] coercion)', () => {
    const a = vec2.create(1, 2);
    const b = vec2.create(3, 4);
    expect(vec2.add(vec2.create(), a, b)).toBeInstanceOf(Float32Array);
    expect(vec2.normalize(vec2.create(), a)).toBeInstanceOf(Float32Array);
    expect(vec2.lerp(vec2.create(), a, b, 0.5)).toBeInstanceOf(Float32Array);
    expect(vec2.perp(vec2.create(), a)).toBeInstanceOf(Float32Array);
  });
});

}