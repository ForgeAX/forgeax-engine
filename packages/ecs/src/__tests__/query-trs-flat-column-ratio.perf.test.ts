// feat-20260709 M2 / w5: query flat-column A/B perf ratio bench (AC-09, D-2/D-9).
//
// In-process ratio gate, NOT absolute wallclock (memory
// absolute-wallclock-perf-gate-flakes-use-in-process-ratio): the same
// process, same JIT tier, and same allocator time both sides, so the
// candidate/baseline ratio isolates the column-shape effect from host noise.
//
//   Baseline:  10 per-axis f32 scalar columns (the pre-migration Transform
//              shape, synthesized here so the gate survives the migration).
//   Candidate: pos array<f32,3> / quat array<f32,4> / scale array<f32,3>
//              (the post-migration shape), read via the query bundle's flat
//              stride-N subarray -- `pos[i*3+a]`, zero per-call allocation
//              (research Finding 5 adjudication table, allowed row).
//
// Gate: ratio = candidate_min / baseline_min <= 1.15 (N=10_000 entities,
// min-of-5 rounds, sides alternate per round to cancel warm-up drift).
// Expected ratio is ~1.0 or below (3/4-wide contiguous lanes have better
// locality than 10 scattered columns); 1.15 is anti-noise headroom, not a
// performance concession.
//
// Falsifiability (plan-strategy 5.4, one-time manual check, not in CI):
// swapping the candidate reader to the `world.get(e, C).pos` materializing
// path makes the ratio blow past the gate -- verified once by hand during
// w5 (see milestone report), then restored to the flat form below.
//
// skipIf escape hatch (D-2): default OFF. If a specific CI host proves
// noisy, gate on an env flag here (e.g. FORGEAX_SKIP_TRS_RATIO_BENCH) --
// deliberately not wired until real-world flake data demands it.

import { describe, expect, it } from 'vitest';
import { defineComponent } from '../component';
import { World } from '../world';

const N = 10_000;
const ROUNDS = 5;
const INNER_REPEATS = 300;
const RATIO_GATE = 1.15;

const BaselineTrs10 = defineComponent('W5_BaselineTrs10', {
  posX: 'f32',
  posY: 'f32',
  posZ: 'f32',
  quatX: 'f32',
  quatY: 'f32',
  quatZ: 'f32',
  quatW: 'f32',
  scaleX: 'f32',
  scaleY: 'f32',
  scaleZ: 'f32',
});

const CandidateTrsVec = defineComponent('W5_CandidateTrsVec', {
  pos: { type: 'array<f32, 3>', default: new Float32Array(3) },
  quat: { type: 'array<f32, 4>', default: new Float32Array([0, 0, 0, 1]) },
  scale: { type: 'array<f32, 3>', default: new Float32Array([1, 1, 1]) },
});

function spawnBaselineWorld(): World {
  const world = new World();
  for (let i = 0; i < N; i++) {
    world.spawn({
      component: BaselineTrs10,
      data: {
        posX: i,
        posY: i * 2,
        posZ: i * 3,
        quatX: 0,
        quatY: 0,
        quatZ: 0,
        quatW: 1,
        scaleX: 1,
        scaleY: 1,
        scaleZ: 1,
      },
    });
  }
  return world;
}

function spawnCandidateWorld(): World {
  const world = new World();
  for (let i = 0; i < N; i++) {
    world.spawn({
      component: CandidateTrsVec,
      data: { pos: [i, i * 2, i * 3], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
    });
  }
  return world;
}

/** Sum all 10 TRS lanes over every entity via per-axis scalar columns. */
function traverseBaseline(world: World): number {
  const query = world.query({ read: [BaselineTrs10] }).unwrap();
  let sum = 0;
  for (let rep = 0; rep < INNER_REPEATS; rep++) {
    for (const span of query.spans().unwrap()) {
      const b = span.get(BaselineTrs10);
      const n = span.length;
      for (let i = 0; i < n; i++) {
        sum +=
          (b.posX[i] as number) +
          (b.posY[i] as number) +
          (b.posZ[i] as number) +
          (b.quatX[i] as number) +
          (b.quatY[i] as number) +
          (b.quatZ[i] as number) +
          (b.quatW[i] as number) +
          (b.scaleX[i] as number) +
          (b.scaleY[i] as number) +
          (b.scaleZ[i] as number);
      }
    }
  }
  return sum;
}

/** Sum all 10 TRS lanes over every entity via flat stride-N array columns. */
function traverseCandidate(world: World): number {
  const query = world.query({ read: [CandidateTrsVec] }).unwrap();
  let sum = 0;
  for (let rep = 0; rep < INNER_REPEATS; rep++) {
    for (const span of query.spans().unwrap()) {
      const c = span.get(CandidateTrsVec);
      const pos = c.pos;
      const quat = c.quat;
      const scale = c.scale;
      const n = span.length;
      for (let i = 0; i < n; i++) {
        sum +=
          (pos[i * 3] as number) +
          (pos[i * 3 + 1] as number) +
          (pos[i * 3 + 2] as number) +
          (quat[i * 4] as number) +
          (quat[i * 4 + 1] as number) +
          (quat[i * 4 + 2] as number) +
          (quat[i * 4 + 3] as number) +
          (scale[i * 3] as number) +
          (scale[i * 3 + 1] as number) +
          (scale[i * 3 + 2] as number);
      }
    }
  }
  return sum;
}

describe('w5 -- TRS flat-column A/B perf ratio (AC-09)', () => {
  it(`candidate/baseline traversal ratio stays <= ${RATIO_GATE} (min-of-${ROUNDS}, N=${N})`, () => {
    const baselineWorld = spawnBaselineWorld();
    const candidateWorld = spawnCandidateWorld();

    // Warm-up: bring both traversal fns to the same JIT tier before timing.
    let sink = 0;
    sink += traverseBaseline(baselineWorld);
    sink += traverseCandidate(candidateWorld);

    const baselineTimes: number[] = [];
    const candidateTimes: number[] = [];

    for (let round = 0; round < ROUNDS; round++) {
      // Alternate side order per round to cancel residual warm-up drift.
      const baselineFirst = round % 2 === 0;
      if (baselineFirst) {
        const b0 = performance.now();
        sink += traverseBaseline(baselineWorld);
        baselineTimes.push(performance.now() - b0);
        const c0 = performance.now();
        sink += traverseCandidate(candidateWorld);
        candidateTimes.push(performance.now() - c0);
      } else {
        const c0 = performance.now();
        sink += traverseCandidate(candidateWorld);
        candidateTimes.push(performance.now() - c0);
        const b0 = performance.now();
        sink += traverseBaseline(baselineWorld);
        baselineTimes.push(performance.now() - b0);
      }
    }

    // Both sides sum identical values -- equality doubles as a correctness
    // check and keeps the traversal loops from being dead-code-eliminated.
    expect(sink).toBeGreaterThan(0);

    const baselineMin = Math.min(...baselineTimes);
    const candidateMin = Math.min(...candidateTimes);
    const ratio = candidateMin / baselineMin;

    // biome-ignore lint/suspicious/noConsole: surface the measured ratio in test output for AC-09 review
    console.info(
      `[w5 perf ratio] baseline_min=${baselineMin.toFixed(3)}ms candidate_min=${candidateMin.toFixed(3)}ms ratio=${ratio.toFixed(3)}`,
    );

    expect(ratio).toBeLessThanOrEqual(RATIO_GATE);
  });
});
