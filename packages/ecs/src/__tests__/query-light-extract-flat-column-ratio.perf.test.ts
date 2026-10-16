// feat-20260709 M2 / w6: light-extract flat-column A/B perf ratio bench (AC-10, D-2/D-6).
//
// Independent of the TRS bench (query-trs-flat-column-ratio.perf.test.ts, D-2):
// light extract is a distinct hot path (q7) -- it multiplies each color lane by
// intensity while reading direction, so its per-row work differs from the
// propagate/getField path. This bench models the render-system-extract light
// loop over QuerySpan columns, NOT the TRS path, and does not reuse its
// baseline.
//
// In-process ratio gate, NOT absolute wallclock (memory
// absolute-wallclock-perf-gate-flakes-use-in-process-ratio): the same process,
// same JIT tier, and same allocator time both sides, so the candidate/baseline
// ratio isolates the column-shape effect from host noise.
//
//   Baseline:  directionX/Y/Z + colorR/G/B + intensity (7 per-axis f32 scalar
//              columns, the pre-migration light shape, synthesized here so the
//              gate survives the migration).
//   Candidate: direction array<f32,3> / color array<f32,3> + intensity (the
//              post-migration shape), read via the query bundle's flat stride-N
//              subarray -- direction[i*3+a] / color[i*3+a], zero per-call
//              allocation (research Finding 5 adjudication table, allowed row;
//              D-6 forbids .get() materialize / _getArrayView per-call alloc).
//
// Gate: ratio = candidate_min / baseline_min <= 1.15 (N=10_000 entities,
// min-of-5 rounds, sides alternate per round to cancel warm-up drift).
// Expected ratio is ~1.0 or below (contiguous 3-wide lanes have better locality
// than 7 scattered columns); 1.15 is anti-noise headroom, not a concession.
//
// Falsifiability (plan-strategy 5.4, one-time manual check, not in CI):
// swapping the candidate reader to the world.get(e, C).color materializing path
// blows the ratio past the gate (precedent magnitude ~51) -- verified once by hand
// during w6 (see milestone report), then restored to the flat form below.

import { describe, expect, it } from 'vitest';
import { defineComponent } from '../component';
import { World } from '../world';
import { worldInternal } from '../world-internal';

const N = 10_000;
const ROUNDS = 5;
const INNER_REPEATS = 30;
const RATIO_GATE = 1.15;

const BaselineLight7 = defineComponent('W6_BaselineLight7', {
  directionX: 'f32',
  directionY: 'f32',
  directionZ: 'f32',
  colorR: 'f32',
  colorG: 'f32',
  colorB: 'f32',
  intensity: 'f32',
});

const CandidateLightVec = defineComponent('W6_CandidateLightVec', {
  direction: { type: 'array<f32, 3>', default: new Float32Array(3) },
  color: { type: 'array<f32, 3>', default: new Float32Array([1, 1, 1]) },
  intensity: { type: 'f32', default: 1 },
});

function spawnBaselineWorld(): World {
  const world = new World();
  for (let i = 0; i < N; i++) {
    world.spawn({
      component: BaselineLight7,
      data: {
        directionX: i,
        directionY: i * 2,
        directionZ: i * 3,
        colorR: 0.5,
        colorG: 0.6,
        colorB: 0.7,
        intensity: 2,
      },
    });
  }
  return world;
}

function spawnCandidateWorld(): World {
  const world = new World();
  for (let i = 0; i < N; i++) {
    world.spawn({
      component: CandidateLightVec,
      data: { direction: [i, i * 2, i * 3], color: [0.5, 0.6, 0.7], intensity: 2 },
    });
  }
  return world;
}

// Preallocated snapshot sinks (mirrors extract writing into a fixed array).
const snapDir = new Float32Array(N * 3);
const snapColor = new Float32Array(N * 3);

/** Extract-shaped loop over per-axis scalar columns. */
function traverseBaseline(world: World): number {
  const query = world.query({ read: [BaselineLight7] }).unwrap();
  let sum = 0;
  for (let rep = 0; rep < INNER_REPEATS; rep++) {
    for (const span of query.spans().unwrap()) {
      const b = span.get(BaselineLight7);
      const n = span.length;
      for (let i = 0; i < n; i++) {
        const intensity = b.intensity[i] as number;
        snapDir[i * 3] = b.directionX[i] as number;
        snapDir[i * 3 + 1] = b.directionY[i] as number;
        snapDir[i * 3 + 2] = b.directionZ[i] as number;
        snapColor[i * 3] = (b.colorR[i] as number) * intensity;
        snapColor[i * 3 + 1] = (b.colorG[i] as number) * intensity;
        snapColor[i * 3 + 2] = (b.colorB[i] as number) * intensity;
        sum += (snapDir[i * 3] as number) + (snapColor[i * 3] as number);
      }
    }
  }
  return sum;
}

/** Extract-shaped loop over flat stride-N array columns (D-6 hot-path form). */
function traverseCandidate(world: World): number {
  const query = world.query({ read: [CandidateLightVec] }).unwrap();
  let sum = 0;
  for (let rep = 0; rep < INNER_REPEATS; rep++) {
    for (const span of query.spans().unwrap()) {
      const c = span.get(CandidateLightVec);
      const direction = c.direction;
      const color = c.color;
      const n = span.length;
      for (let i = 0; i < n; i++) {
        const intensity = c.intensity[i] as number;
        snapDir[i * 3] = direction[i * 3] as number;
        snapDir[i * 3 + 1] = direction[i * 3 + 1] as number;
        snapDir[i * 3 + 2] = direction[i * 3 + 2] as number;
        snapColor[i * 3] = (color[i * 3] as number) * intensity;
        snapColor[i * 3 + 1] = (color[i * 3 + 1] as number) * intensity;
        snapColor[i * 3 + 2] = (color[i * 3 + 2] as number) * intensity;
        sum += (snapDir[i * 3] as number) + (snapColor[i * 3] as number);
      }
    }
  }
  return sum;
}

describe('w6 -- light-extract flat-column A/B perf ratio (AC-10)', () => {
  it(`candidate/baseline extract ratio stays <= ${RATIO_GATE} (min-of-${ROUNDS}, N=${N})`, () => {
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

    // Both sides write identical values -- keeps the loops from being
    // dead-code-eliminated and doubles as a smoke correctness check.
    expect(sink).toBeGreaterThan(0);

    const baselineMin = Math.min(...baselineTimes);
    const candidateMin = Math.min(...candidateTimes);
    const ratio = candidateMin / baselineMin;

    // biome-ignore lint/suspicious/noConsole: surface the measured ratio in test output for AC-10 review
    console.info(
      `[w6 perf ratio] baseline_min=${baselineMin.toFixed(3)}ms candidate_min=${candidateMin.toFixed(3)}ms ratio=${ratio.toFixed(3)}`,
    );

    expect(ratio).toBeLessThanOrEqual(RATIO_GATE);
  });
});

describe('M5 -- wide table versus sparse tag-flip trend', () => {
  const widths = [1, 4, 8, 16] as const;
  const TableFlipTag = defineComponent('M5WideTableFlipTag', {});
  const SparseFlipTag = defineComponent('M5WideSparseFlipTag', {}, { storage: 'sparse' });

  function makeWideComponent(width: number) {
    const schema: Record<string, 'f32'> = {};
    for (let index = 0; index < width; index++) schema[`f${index}`] = 'f32';
    return defineComponent(`M1WideFlip${width}`, schema);
  }

  function bytesIn(table: {
    storage: Map<number, { fields: Map<string, { buffer: ArrayBufferLike }> }>;
  }): number {
    let bytes = 0;
    for (const { fields } of table.storage.values()) {
      for (const column of fields.values()) bytes += column.buffer.byteLength;
    }
    return bytes;
  }

  it('keeps sparse copied bytes flat at zero while table migration grows with arity', () => {
    const tableCopiedBytes: number[] = [];
    const sparseCopiedBytes: number[] = [];
    for (const width of widths) {
      const wide = makeWideComponent(width);
      const tableWorld = new World();
      const tableEntity = tableWorld.spawn({ component: wide, data: {} as never }).unwrap();
      const tableBefore = tableWorld[worldInternal].getGraph().tables[0];
      if (tableBefore === undefined) throw new Error('source table missing');
      tableCopiedBytes.push(bytesIn(tableBefore));
      tableWorld.addComponent(tableEntity, { component: TableFlipTag, data: {} }).unwrap();

      const sparseWorld = new World();
      const sparseEntity = sparseWorld.spawn({ component: wide, data: {} as never }).unwrap();
      const sparseBefore = sparseWorld[worldInternal].getGraph().tables[0];
      if (sparseBefore === undefined) throw new Error('source table missing');
      sparseWorld.addComponent(sparseEntity, { component: SparseFlipTag, data: {} }).unwrap();
      const sparseAfter = sparseWorld[worldInternal].getGraph().tables[0];
      sparseCopiedBytes.push(sparseAfter === sparseBefore ? 0 : bytesIn(sparseBefore));
    }

    // biome-ignore lint/suspicious/noConsole: the trend is the characterization output
    console.info(
      `[m5 tag-flip] widths=${widths.join(',')} tableCopiedBytes=${tableCopiedBytes.join(',')} sparseCopiedBytes=${sparseCopiedBytes.join(',')}`,
    );
    const [first, second, third, fourth] = tableCopiedBytes;
    if (
      first === undefined ||
      second === undefined ||
      third === undefined ||
      fourth === undefined
    ) {
      throw new Error('wide-tag trend did not produce four samples');
    }
    expect(first).toBeLessThan(second);
    expect(second).toBeLessThan(third);
    expect(third).toBeLessThan(fourth);
    expect(sparseCopiedBytes).toEqual([0, 0, 0, 0]);
  });
});
