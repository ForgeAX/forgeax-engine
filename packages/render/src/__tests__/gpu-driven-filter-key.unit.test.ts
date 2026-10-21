import { expect, it, vi } from 'vitest';
import { createFilterPlanFixture, freshFilteredPlan } from './gpu-driven-filter-plan-fixture';

it('does not serialize retained material identities once per instance during view projection', () => {
  const f = createFilterPlanFixture({ sharedGeometry: true, instances: 4096 });
  const prepared = f.prepare();
  const encode = JSON.stringify;
  let bytes = 0;
  const stringify = vi.spyOn(JSON, 'stringify').mockImplementation((value, replacer, space) => {
    const result = encode(value, replacer as never, space);
    bytes += result?.length ?? 0;
    return result;
  });
  try {
    const output = freshFilteredPlan(prepared);
    expect(output.plan.candidateCount).toBe(12288);
    expect(output.plan.batches).toHaveLength(1);
    expect(output.plan.batches.at(0)?.candidates).toBe(prepared.source.batches.at(0)?.candidates);
    expect(bytes).toBeLessThan(16 * 1024);
    expect(stringify.mock.calls.length).toBeLessThan(16);
  } finally {
    stringify.mockRestore();
  }
});
