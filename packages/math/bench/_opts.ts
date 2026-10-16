// CI bench knobs forwarded to tinybench via bench(name, fn, opts).
//
// Defaults are tuned for `metrics-validate` consumption (median ns/op only;
// see scripts/metrics/run-all.mjs#collectBenchMedians). tinybench defaults
// (time=500 / warmupTime=100 / warmupIterations=5) emit ~20M samples per
// case which is overkill for a single percentile -- FORGEAX_BENCH=fast
// (set in CI) shrinks to ~120ms total per case, retaining median stability
// well within the 1.5x threshold band used downstream.
//
// Local `pnpm bench` keeps the tinybench defaults so developers see the
// statistically-tight numbers (RME / p99) used for ad-hoc tuning sessions.

const fast = process.env.FORGEAX_BENCH === 'fast';

export const BENCH_OPTS = fast
  ? { time: 100, warmupTime: 30, warmupIterations: 2 }
  : {};
