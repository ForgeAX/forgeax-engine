// quat.bench.ts -- quat hot-path micro-bench (M5 / T-034, AC-13).
//
// Coverage: 4 hot paths -- multiply / slerp / normalize / fromAxisAngle.
//
// Tinybench knobs sourced from ./_opts (FORGEAX_BENCH=fast in CI).
// Related: requirements AC-13; plan-strategy D-P11; wiki/vitest-bench section 7.

import { bench, describe } from 'vitest';
import * as quat from '../src/quat';
import * as vec3 from '../src/vec3';
import { BENCH_OPTS } from './_opts';

describe('quat hot path', () => {
  const a = quat.create();
  quat.fromAxisAngle(a, vec3.create(0, 1, 0), 0.5);
  const b = quat.create();
  quat.fromAxisAngle(b, vec3.create(1, 0, 0), 0.8);
  const axis = vec3.create(0, 0, 1);

  const out = quat.create();
  let sink = 0;

  bench(
    'quat.multiply',
    () => {
      quat.multiply(out, a, b);
      sink ^= out[0]! | 0;
    },
    BENCH_OPTS,
  );

  bench(
    'quat.slerp',
    () => {
      quat.slerp(out, a, b, 0.42);
      sink ^= out[0]! | 0;
    },
    BENCH_OPTS,
  );

  bench(
    'quat.normalize',
    () => {
      quat.normalize(out, a);
      sink ^= out[0]! | 0;
    },
    BENCH_OPTS,
  );

  bench(
    'quat.fromAxisAngle',
    () => {
      quat.fromAxisAngle(out, axis, 0.314);
      sink ^= out[0]! | 0;
    },
    BENCH_OPTS,
  );

  bench.skip('__sink_keep_alive', () => {
    sink ^= 1;
  });
});
