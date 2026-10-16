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
  // --- from vec4.test.ts ---
// Vec4 unit tests — TDD red phase (T-011).
//
// Three tiers: normal / boundary / degenerate (covers NaN propagation + 0-vec normalize silent fall-back).
// vec4 ≥ 14 functions: same shape as vec2/vec3 (no cross / perp).
//
// Related: requirements §Surface vec4 lower bound 14; plan-strategy §6 M2 + AC-06 degenerate tests;
//          wiki/gl-matrix-overview Out-param four ironclad rules.


describe('vec4.create', () => {
  it('returns Float32Array length 4 zero by default (normal)', () => {
    const v = vec4.create();
    expect(v).toBeInstanceOf(Float32Array);
    expect(v.length).toBe(4);
    for (let i = 0; i < 4; i++) expect(v[i]).toBe(0);
  });

  it('accepts explicit components (boundary)', () => {
    const v = vec4.create(1, 2, 3, 4);
    expect(Array.from(v)).toEqual([1, 2, 3, 4]);
  });

  it('NaN stored verbatim (degenerate)', () => {
    const v = vec4.create(Number.NaN, 0, 0, 0);
    expect(Number.isNaN(v[0])).toBe(true);
  });
});

describe('vec4.clone', () => {
  it('produces new Float32Array with same values (normal)', () => {
    const a = vec4.create(1, 2, 3, 4);
    const b = vec4.clone(a);
    expect(b).not.toBe(a);
    expect(Array.from(b)).toEqual([1, 2, 3, 4]);
  });
});

describe('vec4.copy', () => {
  it('copies a -> out and returns out (normal)', () => {
    const out = vec4.copy(vec4.create(), vec4.create(7, 11, 13, 17));
    expect(Array.from(out)).toEqual([7, 11, 13, 17]);
  });

  it('aliasing-safe: copy(v, v) is no-op (degenerate)', () => {
    const v = vec4.create(1, 2, 3, 4);
    vec4.copy(v, v);
    expect(Array.from(v)).toEqual([1, 2, 3, 4]);
  });
});

describe('vec4.set', () => {
  it('writes components and returns out (normal)', () => {
    const out = vec4.create();
    const ret = vec4.set(out, 5, 6, 7, 8);
    expect(ret).toBe(out);
    expect(Array.from(out)).toEqual([5, 6, 7, 8]);
  });
});

describe('vec4.equals', () => {
  it('exact equality returns true (normal)', () => {
    expect(vec4.equals(vec4.create(1, 2, 3, 4), vec4.create(1, 2, 3, 4))).toBe(true);
  });

  it('within epsilon returns true (boundary)', () => {
    expect(vec4.equals(vec4.create(1, 2, 3, 4), vec4.create(1 + 1e-7, 2, 3, 4))).toBe(true);
  });

  it('NaN never equals NaN (degenerate)', () => {
    expect(vec4.equals(vec4.create(Number.NaN, 0, 0, 0), vec4.create(Number.NaN, 0, 0, 0))).toBe(
      false,
    );
  });
});

describe('vec4.add', () => {
  it('component-wise add (normal)', () => {
    const out = vec4.add(vec4.create(), vec4.create(1, 2, 3, 4), vec4.create(5, 6, 7, 8));
    expect(Array.from(out)).toEqual([6, 8, 10, 12]);
  });

  it('aliasing-safe: add(v, v, v) doubles (degenerate)', () => {
    const v = vec4.create(1, 2, 3, 4);
    vec4.add(v, v, v);
    expect(Array.from(v)).toEqual([2, 4, 6, 8]);
  });
});

describe('vec4.sub', () => {
  it('component-wise sub (normal)', () => {
    const out = vec4.sub(vec4.create(), vec4.create(5, 7, 9, 11), vec4.create(1, 2, 3, 4));
    expect(Array.from(out)).toEqual([4, 5, 6, 7]);
  });

  it('a - a = 0 (boundary)', () => {
    const a = vec4.create(3, 4, 5, 6);
    const out = vec4.sub(vec4.create(), a, a);
    expect(Array.from(out)).toEqual([0, 0, 0, 0]);
  });
});

describe('vec4.scale', () => {
  it('scales by scalar (normal)', () => {
    const out = vec4.scale(vec4.create(), vec4.create(1, 2, 3, 4), 2);
    expect(Array.from(out)).toEqual([2, 4, 6, 8]);
  });

  it('scale by 0 yields zero (boundary)', () => {
    const out = vec4.scale(vec4.create(), vec4.create(7, 11, 13, 17), 0);
    expect(Array.from(out)).toEqual([0, 0, 0, 0]);
  });
});

describe('vec4.negate', () => {
  it('flips sign (normal)', () => {
    const out = vec4.negate(vec4.create(), vec4.create(1, -2, 3, -4));
    expect(Array.from(out)).toEqual([-1, 2, -3, 4]);
  });
});

describe('vec4.dot', () => {
  it('computes dot product (normal)', () => {
    expect(vec4.dot(vec4.create(1, 2, 3, 4), vec4.create(5, 6, 7, 8))).toBe(5 + 12 + 21 + 32);
  });

  it('dot with zero is 0 (degenerate)', () => {
    expect(vec4.dot(vec4.create(), vec4.create(1, 2, 3, 4))).toBe(0);
  });
});

describe('vec4.lengthSq / length', () => {
  it('lengthSq of (1,2,2,0) is 9 (normal)', () => {
    expect(vec4.lengthSq(vec4.create(1, 2, 2, 0))).toBe(9);
  });

  it('length of (1,2,2,0) is 3 (normal)', () => {
    expect(vec4.length(vec4.create(1, 2, 2, 0))).toBeCloseTo(3);
  });

  it('length of zero is 0 (boundary)', () => {
    expect(vec4.length(vec4.create())).toBe(0);
  });
});

describe('vec4.distance', () => {
  it('distance between (0,0,0,0) and (1,2,2,0) is 3 (normal)', () => {
    expect(vec4.distance(vec4.create(), vec4.create(1, 2, 2, 0))).toBeCloseTo(3);
  });

  it('distance to self is 0 (boundary)', () => {
    const a = vec4.create(7, 11, 13, 17);
    expect(vec4.distance(a, a)).toBe(0);
  });
});

describe('vec4.normalize', () => {
  it('normalizes a non-zero vec to unit length (normal)', () => {
    const out = vec4.normalize(vec4.create(), vec4.create(1, 2, 2, 0));
    expect(vec4.length(out)).toBeCloseTo(1);
  });

  it('zero vec → zero vec, no NaN, no throw (degenerate / D-P12)', () => {
    const out = vec4.normalize(vec4.create(), vec4.create());
    expect(Array.from(out)).toEqual([0, 0, 0, 0]);
  });
});

describe('vec4.lerp', () => {
  it('t=0 returns a (boundary)', () => {
    const out = vec4.lerp(vec4.create(), vec4.create(1, 2, 3, 4), vec4.create(5, 6, 7, 8), 0);
    expect(Array.from(out).map((x) => Math.round(x))).toEqual([1, 2, 3, 4]);
  });

  it('t=1 returns b (boundary)', () => {
    const out = vec4.lerp(vec4.create(), vec4.create(1, 2, 3, 4), vec4.create(5, 6, 7, 8), 1);
    expect(Array.from(out).map((x) => Math.round(x))).toEqual([5, 6, 7, 8]);
  });

  it('t=0.5 returns midpoint (normal)', () => {
    const out = vec4.lerp(vec4.create(), vec4.create(0, 0, 0, 0), vec4.create(2, 4, 6, 8), 0.5);
    expect(Array.from(out)).toEqual([1, 2, 3, 4]);
  });
});

describe('vec4.min / max', () => {
  it('component-wise min (normal)', () => {
    const out = vec4.min(vec4.create(), vec4.create(1, 5, -3, 7), vec4.create(3, 2, 0, -1));
    expect(Array.from(out)).toEqual([1, 2, -3, -1]);
  });

  it('component-wise max (normal)', () => {
    const out = vec4.max(vec4.create(), vec4.create(1, 5, -3, 7), vec4.create(3, 2, 0, -1));
    expect(Array.from(out)).toEqual([3, 5, 0, 7]);
  });
});

describe('vec4 — V8 elements-kinds guard', () => {
  it('all returns are Float32Array (no number[] coercion)', () => {
    const a = vec4.create(1, 2, 3, 4);
    const b = vec4.create(5, 6, 7, 8);
    expect(vec4.add(vec4.create(), a, b)).toBeInstanceOf(Float32Array);
    expect(vec4.sub(vec4.create(), a, b)).toBeInstanceOf(Float32Array);
    expect(vec4.normalize(vec4.create(), a)).toBeInstanceOf(Float32Array);
    expect(vec4.lerp(vec4.create(), a, b, 0.5)).toBeInstanceOf(Float32Array);
  });
});

}