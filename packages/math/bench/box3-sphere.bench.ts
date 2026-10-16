// box3-sphere.bench.ts -- hot-path micro-bench for Box3 / Sphere (M3 / w7).
//
// Coverage: expandByPoint / containsPoint / intersectsBox for both namespaces
// + sphere.fromPoints as the most expensive routine. Each bench body uses the
// sink pattern (outer closure accumulator) to prevent JIT dead-code elimination
// (wiki/vitest-bench section 7.1 ironclad rules; vec3.bench.ts template).
//
// Tinybench knobs sourced from ./_opts (FORGEAX_BENCH=fast in CI).
// Related: requirements AC-13 hot-path bench (Box3/Sphere extension);
//          plan-strategy M3 range + section 4.4 bench SSOT;
//          plan-tasks.json w7 acceptanceCheck (`bench:json` emits Box3 / Sphere entries).

import { bench, describe } from 'vitest';
import * as box3 from '../src/box3';
import * as sphere from '../src/sphere';
import { BENCH_OPTS } from './_opts';

describe('box3 hot path', () => {
  const b = box3.create(-1, -1, -1, 1, 1, 1);
  const b2 = box3.create(0.5, 0.5, 0.5, 2, 2, 2);
  const p: [number, number, number] = [0.25, 0.5, 0.75];
  let sink = 0;

  bench(
    'box3.expandByPoint',
    () => {
      box3.expandByPoint(b, p);
      sink ^= b[0]! | 0;
    },
    BENCH_OPTS,
  );

  bench(
    'box3.containsPoint',
    () => {
      sink ^= box3.containsPoint(b, p) ? 1 : 0;
    },
    BENCH_OPTS,
  );

  bench(
    'box3.intersectsBox',
    () => {
      sink ^= box3.intersectsBox(b, b2) ? 1 : 0;
    },
    BENCH_OPTS,
  );

  bench.skip('__sink_keep_alive', () => {
    sink ^= 1;
  });
});

describe('sphere hot path', () => {
  const s = sphere.create(0, 0, 0, 1);
  const b = box3.create(-1, -1, -1, 1, 1, 1);
  const p: [number, number, number] = [0.5, 0.5, 0.5];
  const points: readonly [number, number, number][] = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];
  let sink = 0;

  bench(
    'sphere.expandByPoint',
    () => {
      sphere.expandByPoint(s, p);
      sink ^= s[3]! | 0;
    },
    BENCH_OPTS,
  );

  bench(
    'sphere.containsPoint',
    () => {
      sink ^= sphere.containsPoint(s, p) ? 1 : 0;
    },
    BENCH_OPTS,
  );

  bench(
    'sphere.intersectsBox',
    () => {
      sink ^= sphere.intersectsBox(s, b) ? 1 : 0;
    },
    BENCH_OPTS,
  );

  bench(
    'sphere.fromPoints',
    () => {
      const out = sphere.create();
      sphere.fromPoints(out, points);
      sink ^= out[3]! | 0;
    },
    BENCH_OPTS,
  );

  bench.skip('__sink_keep_alive', () => {
    sink ^= 1;
  });
});
