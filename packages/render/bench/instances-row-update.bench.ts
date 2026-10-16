import { afterAll, bench, describe } from 'vitest';
import { createInstanceRowHarness } from '../src/__tests__/instances-row-harness';

const fast = process.env.FORGEAX_BENCH === 'fast';
const options = fast ? { time: 100, warmupTime: 30, warmupIterations: 2 } : {};

// One moved row through extract -> PersistentRenderScene -> GpuScene. The
// `setArrayRange` path must cost the same at 1k and 64k; `World.set` is the
// whole-column reference workload.
for (const count of [1024, 65536]) {
  describe(`Instances ${count} rows, one moving`, () => {
    const harness = createInstanceRowHarness(count);
    let x = 0;
    afterAll(() => harness.dispose());
    bench(
      'setArrayRange row move',
      () => {
        x += 1;
        harness.move(count >> 1, x);
      },
      options,
    );
    bench(
      'World.set whole-column rewrite',
      () => {
        x += 1;
        harness.rewrite(count >> 1, x);
      },
      options,
    );
  });
}
