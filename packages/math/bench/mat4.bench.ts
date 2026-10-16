// mat4.bench.ts -- mat4 hot-path micro-bench (M5 / T-034, AC-13).
//
// Coverage: 4 hot paths -- multiply / invert / transpose / compose. Sink
// pattern matches vec3.bench.ts.
//
// Tinybench knobs sourced from ./_opts (FORGEAX_BENCH=fast in CI).
// Related: requirements AC-13; plan-strategy D-P11; wiki/vitest-bench section 7.2.

import { bench, describe } from 'vitest';
import * as mat4 from '../src/mat4';
import * as quat from '../src/quat';
import * as vec3 from '../src/vec3';
import { BENCH_OPTS } from './_opts';

describe('mat4 hot path', () => {
  // Compose a non-trivial TRS matrix so JIT cannot fold invert(identity)
  // back to identity.
  const t = vec3.create(1.5, -2.0, 0.75);
  const r = quat.create();
  quat.fromAxisAngle(r, vec3.create(0, 1, 0), 0.7);
  const s = vec3.create(1.2, 0.9, 1.5);

  const A = mat4.create();
  mat4.compose(A, t, r, s);
  const B = mat4.create();
  mat4.compose(B, vec3.create(0, 0, 0), r, vec3.create(2, 2, 2));

  const out = mat4.create();
  let sink = 0;

  bench(
    'mat4.multiply',
    () => {
      mat4.multiply(out, A, B);
      sink ^= out[0]! | 0;
    },
    BENCH_OPTS,
  );

  bench(
    'mat4.invert',
    () => {
      mat4.invert(out, A);
      sink ^= out[0]! | 0;
    },
    BENCH_OPTS,
  );

  bench(
    'mat4.transpose',
    () => {
      mat4.transpose(out, A);
      sink ^= out[0]! | 0;
    },
    BENCH_OPTS,
  );

  bench(
    'mat4.compose',
    () => {
      mat4.compose(out, t, r, s);
      sink ^= out[0]! | 0;
    },
    BENCH_OPTS,
  );

  bench.skip('__sink_keep_alive', () => {
    sink ^= 1;
  });
});
