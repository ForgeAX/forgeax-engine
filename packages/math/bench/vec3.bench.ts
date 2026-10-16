// vec3.bench.ts -- vec3 hot-path micro-bench (M5 / T-034, AC-13).
//
// Coverage: 4 hot paths -- add / dot / normalize / cross. Each bench body
// uses the sink pattern (outer closure accumulator) to prevent JIT
// dead-code elimination (wiki/vitest-bench section 7.1).
//
// File location: packages/math/bench/*.bench.ts (D-P11 / wiki section 5);
// physically isolated from src/__tests__/ so `vitest run` and `vitest bench`
// stay on independent channels (wiki section 5).
//
// Tinybench knobs sourced from ./_opts (FORGEAX_BENCH=fast in CI).
// Related: requirements AC-13 hot-path bench; plan-strategy D-P11;
//          wiki/vitest-bench section 3 bench API + section 7 templates.

import { bench, describe } from 'vitest';
import * as vec3 from '../src/vec3';
import { BENCH_OPTS } from './_opts';

describe('vec3 hot path', () => {
  const a = vec3.create(1.5, 2.25, -0.125);
  const b = vec3.create(0.5, -1.0, 4.0);
  const out = vec3.create();
  let sink = 0;

  bench(
    'vec3.add',
    () => {
      vec3.add(out, a, b);
      sink ^= out[0]! | 0; // bitwise sink to force read
    },
    BENCH_OPTS,
  );

  bench(
    'vec3.dot',
    () => {
      sink ^= vec3.dot(a, b) | 0;
    },
    BENCH_OPTS,
  );

  bench(
    'vec3.normalize',
    () => {
      vec3.normalize(out, a);
      sink ^= out[0]! | 0;
    },
    BENCH_OPTS,
  );

  bench(
    'vec3.cross',
    () => {
      vec3.cross(out, a, b);
      sink ^= out[0]! | 0;
    },
    BENCH_OPTS,
  );

  // Defeat 'sink declared but never used' lint
  bench.skip('__sink_keep_alive', () => {
    sink ^= 1;
  });
});
