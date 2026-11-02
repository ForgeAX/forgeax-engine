import { bench, describe } from 'vitest';
import { checkInvariants } from '../src/invariants';
import { PERF_CASES } from './perf-tiers';

// `npx vitest bench bench/perf-tiers.bench.ts`: one rebuild (session ops, then finish)
// per iteration. The gate and the committed report are src/__tests__/perf-tiers.unit.test.ts.
checkInvariants(false);

for (const tier of ['runtime', 'offline'] as const) {
  describe(`${tier} tier`, () => {
    for (const c of PERF_CASES.filter((x) => x.tier === tier)) {
      bench(
        c.name,
        () => {
          const out = c.build().finish({ key: 'bench' });
          if (!out.ok) throw new Error(`${c.name}: ${out.error.message}`);
        },
        tier === 'runtime' ? { time: 500 } : { iterations: 3, time: 0 },
      );
    }
  });
}
