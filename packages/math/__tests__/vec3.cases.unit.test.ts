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
  // --- from vec3.test.ts ---
// Vec3 unit tests — TDD red phase (T-011 rewrite, turned green by T-014).
//
// Three tiers: normal / boundary / degenerate (covers NaN propagation + 0-vec normalize silent fall-back).
// vec3 ≥ 18 functions: vec2 base (without perp) + cross + distanceSq.
// Cross-type apply functions go via the reverse surface: mat4.transformVec3 / transformPoint /
// transformDirection / quat.transformVec3 (D-12 tore down the previous loop's Three.js-style promise).
//
// Related: requirements §Surface vec3 lower bound 18; plan-strategy §6 M2 + AC-06 degenerate tests;
//          wiki/gl-matrix-overview Out-param four ironclad rules + degenerate-semantics anchor.


describe('vec3.create', () => {
  it('returns Float32Array length 3 zero by default (normal)', () => {
    const v = vec3.create();
    expect(v).toBeInstanceOf(Float32Array);
    expect(v.length).toBe(3);
    expect(v[0]).toBe(0);
    expect(v[1]).toBe(0);
    expect(v[2]).toBe(0);
  });

  it('accepts explicit components (boundary)', () => {
    const v = vec3.create(1, 2, 3);
    expect(v[0]).toBe(1);
    expect(v[1]).toBe(2);
    expect(v[2]).toBe(3);
  });

  it('NaN/Infinity stored verbatim (degenerate)', () => {
    const v = vec3.create(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY);
    expect(Number.isNaN(v[0])).toBe(true);
    expect(v[1]).toBe(Number.POSITIVE_INFINITY);
    expect(v[2]).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe('vec3.clone', () => {
  it('produces new Float32Array with same values (normal)', () => {
    const a = vec3.create(1, 2, 3);
    const b = vec3.clone(a);
    expect(b).not.toBe(a);
    expect(Array.from(b)).toEqual([1, 2, 3]);
  });
});

describe('vec3.copy', () => {
  it('copies a -> out and returns out (normal)', () => {
    const a = vec3.create(7, 11, 13);
    const out = vec3.create();
    const ret = vec3.copy(out, a);
    expect(ret).toBe(out);
    expect(Array.from(out)).toEqual([7, 11, 13]);
  });

  it('aliasing-safe: copy(v, v) is a no-op (degenerate)', () => {
    const v = vec3.create(1, 2, 3);
    vec3.copy(v, v);
    expect(Array.from(v)).toEqual([1, 2, 3]);
  });
});

describe('vec3.set', () => {
  it('writes components and returns out (normal)', () => {
    const out = vec3.create();
    const ret = vec3.set(out, 5, 6, 7);
    expect(ret).toBe(out);
    expect(Array.from(out)).toEqual([5, 6, 7]);
  });
});

describe('vec3.equals', () => {
  it('exact equality returns true (normal)', () => {
    expect(vec3.equals(vec3.create(1, 2, 3), vec3.create(1, 2, 3))).toBe(true);
  });

  it('within epsilon returns true (boundary)', () => {
    expect(vec3.equals(vec3.create(1, 2, 3), vec3.create(1 + 1e-7, 2, 3))).toBe(true);
  });

  it('NaN never equals NaN (degenerate)', () => {
    expect(vec3.equals(vec3.create(Number.NaN, 0, 0), vec3.create(Number.NaN, 0, 0))).toBe(false);
  });
});

describe('vec3.add', () => {
  it('component-wise add (normal)', () => {
    const out = vec3.add(vec3.create(), vec3.create(1, 2, 3), vec3.create(4, 5, 6));
    expect(Array.from(out)).toEqual([5, 7, 9]);
  });

  it('aliasing-safe: add(v, v, v) doubles (degenerate)', () => {
    const v = vec3.create(1, 2, 3);
    vec3.add(v, v, v);
    expect(Array.from(v)).toEqual([2, 4, 6]);
  });
});

describe('vec3.sub', () => {
  it('component-wise sub (normal)', () => {
    const out = vec3.sub(vec3.create(), vec3.create(5, 7, 9), vec3.create(1, 2, 3));
    expect(Array.from(out)).toEqual([4, 5, 6]);
  });

  it('a - a = 0 (boundary)', () => {
    const a = vec3.create(3, 4, 5);
    const out = vec3.sub(vec3.create(), a, a);
    expect(Array.from(out)).toEqual([0, 0, 0]);
  });
});

describe('vec3.scale', () => {
  it('scales by scalar (normal)', () => {
    const out = vec3.scale(vec3.create(), vec3.create(1, 2, 3), 2);
    expect(Array.from(out)).toEqual([2, 4, 6]);
  });

  it('scale by 0 yields zero (boundary)', () => {
    const out = vec3.scale(vec3.create(), vec3.create(7, 11, 13), 0);
    expect(Array.from(out)).toEqual([0, 0, 0]);
  });
});

describe('vec3.negate', () => {
  it('flips sign (normal)', () => {
    const out = vec3.negate(vec3.create(), vec3.create(1, -2, 3));
    expect(Array.from(out)).toEqual([-1, 2, -3]);
  });
});

describe('vec3.dot', () => {
  it('computes dot product (normal)', () => {
    expect(vec3.dot(vec3.create(1, 2, 3), vec3.create(4, -5, 6))).toBe(4 - 10 + 18);
  });

  it('orthogonal → 0 (boundary)', () => {
    expect(vec3.dot(vec3.create(1, 0, 0), vec3.create(0, 1, 0))).toBe(0);
  });

  it('dot with zero is 0 (degenerate)', () => {
    expect(vec3.dot(vec3.create(), vec3.create(123, 456, 789))).toBe(0);
  });
});

describe('vec3.cross', () => {
  it('canonical x cross y = z (normal)', () => {
    const out = vec3.cross(vec3.create(), vec3.create(1, 0, 0), vec3.create(0, 1, 0));
    expect(Array.from(out)).toEqual([0, 0, 1]);
  });

  it('parallel vectors → 0 (boundary)', () => {
    const out = vec3.cross(vec3.create(), vec3.create(1, 2, 3), vec3.create(2, 4, 6));
    expect(Array.from(out)).toEqual([0, 0, 0]);
  });

  it('a x a = 0 (degenerate, aliasing)', () => {
    const a = vec3.create(1, -2, 3);
    const out = vec3.cross(vec3.create(), a, a);
    expect(Array.from(out)).toEqual([0, 0, 0]);
  });

  it('aliasing-safe cross(v, v, w) (degenerate)', () => {
    const v = vec3.create(1, 0, 0);
    const w = vec3.create(0, 1, 0);
    vec3.cross(v, v, w);
    expect(Array.from(v)).toEqual([0, 0, 1]);
  });
});

describe('vec3.lengthSq / length', () => {
  it('lengthSq of (3,4,0) is 25 (normal)', () => {
    expect(vec3.lengthSq(vec3.create(3, 4, 0))).toBe(25);
  });

  it('length of (3,4,0) is 5 (normal)', () => {
    expect(vec3.length(vec3.create(3, 4, 0))).toBeCloseTo(5);
  });

  it('length of zero is 0 (boundary)', () => {
    expect(vec3.length(vec3.create())).toBe(0);
  });

  it('length of unit basis is 1 (degenerate)', () => {
    expect(vec3.length(vec3.create(1, 0, 0))).toBeCloseTo(1);
    expect(vec3.length(vec3.create(0, 1, 0))).toBeCloseTo(1);
    expect(vec3.length(vec3.create(0, 0, 1))).toBeCloseTo(1);
  });
});

describe('vec3.distance / distanceSq', () => {
  it('distance between (1,1,1) and (4,5,1) is 5 (normal)', () => {
    expect(vec3.distance(vec3.create(1, 1, 1), vec3.create(4, 5, 1))).toBeCloseTo(5);
  });

  it('distanceSq of (0,0,0) to (3,4,0) is 25 (normal)', () => {
    expect(vec3.distanceSq(vec3.create(), vec3.create(3, 4, 0))).toBeCloseTo(25);
  });

  it('distance to self is 0 (boundary)', () => {
    const a = vec3.create(7, 11, 13);
    expect(vec3.distance(a, a)).toBe(0);
  });
});

describe('vec3.normalize', () => {
  it('normalizes a non-zero vec to unit length (normal)', () => {
    const out = vec3.normalize(vec3.create(), vec3.create(3, 4, 0));
    expect(vec3.length(out)).toBeCloseTo(1);
    expect(out[0]).toBeCloseTo(0.6);
    expect(out[1]).toBeCloseTo(0.8);
    expect(out[2]).toBeCloseTo(0);
  });

  it('zero vec → zero vec, no NaN, no throw (degenerate / D-P12)', () => {
    const out = vec3.normalize(vec3.create(), vec3.create());
    expect(Array.from(out)).toEqual([0, 0, 0]);
  });

  it('an already-unit vec remains unit (degenerate)', () => {
    const out = vec3.normalize(vec3.create(), vec3.create(0, 1, 0));
    expect(out[0]).toBeCloseTo(0);
    expect(out[1]).toBeCloseTo(1);
    expect(out[2]).toBeCloseTo(0);
  });
});

describe('vec3.lerp', () => {
  it('t=0 returns a (boundary)', () => {
    const out = vec3.lerp(vec3.create(), vec3.create(1, 2, 3), vec3.create(5, 6, 7), 0);
    expect(out[0]).toBeCloseTo(1);
    expect(out[1]).toBeCloseTo(2);
    expect(out[2]).toBeCloseTo(3);
  });

  it('t=1 returns b (boundary)', () => {
    const out = vec3.lerp(vec3.create(), vec3.create(1, 2, 3), vec3.create(5, 6, 7), 1);
    expect(out[0]).toBeCloseTo(5);
    expect(out[1]).toBeCloseTo(6);
    expect(out[2]).toBeCloseTo(7);
  });

  it('t=0.5 returns midpoint (normal)', () => {
    const out = vec3.lerp(vec3.create(), vec3.create(0, 0, 0), vec3.create(2, 4, 6), 0.5);
    expect(out[0]).toBeCloseTo(1);
    expect(out[1]).toBeCloseTo(2);
    expect(out[2]).toBeCloseTo(3);
  });
});

describe('vec3.min / max', () => {
  it('component-wise min (normal)', () => {
    const out = vec3.min(vec3.create(), vec3.create(1, 5, -3), vec3.create(3, 2, 0));
    expect(Array.from(out)).toEqual([1, 2, -3]);
  });

  it('component-wise max (normal)', () => {
    const out = vec3.max(vec3.create(), vec3.create(1, 5, -3), vec3.create(3, 2, 0));
    expect(Array.from(out)).toEqual([3, 5, 0]);
  });
});

describe('vec3 — V8 elements-kinds guard', () => {
  it('typed-array input yields typed-array output (no number[] coercion)', () => {
    const a = vec3.create(1, 2, 3);
    const b = vec3.create(4, 5, 6);
    expect(vec3.add(vec3.create(), a, b)).toBeInstanceOf(Float32Array);
    expect(vec3.sub(vec3.create(), a, b)).toBeInstanceOf(Float32Array);
    expect(vec3.scale(vec3.create(), a, 2)).toBeInstanceOf(Float32Array);
    expect(vec3.cross(vec3.create(), a, b)).toBeInstanceOf(Float32Array);
    expect(vec3.normalize(vec3.create(), a)).toBeInstanceOf(Float32Array);
  });
});

}