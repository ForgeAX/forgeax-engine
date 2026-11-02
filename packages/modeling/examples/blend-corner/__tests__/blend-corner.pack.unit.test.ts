import { describe, expect, it } from 'vitest';
import pack from '../blend-corner.pack';

/** C-120 Pack: every `step` choice builds a non-empty `mesh/blend-corner` well under the 15 s budget. */
const STEPS = ['sharp', 'roll', 'run-out', 'corner'] as const;

describe('C-120 blend-corner Pack', () => {
  it('declares one enum parameter with the four steps, defaulting to run-out', () => {
    expect(pack.parameters?.map((p) => p.name)).toEqual(['step']);
    expect(pack.parameters?.[0]).toMatchObject({ type: 'enum', default: 'run-out', values: [...STEPS] });
  });

  it.each(STEPS)('builds %s', { timeout: 15000 }, async (step) => {
    const t0 = performance.now();
    const out = await pack.build({ values: { step }, packageId: pack.packageId } as never);
    const ms = performance.now() - t0;
    console.log(`blend-corner ${step}: ${ms.toFixed(0)} ms`);
    const result = out as unknown as { ok?: boolean; value?: unknown; error?: unknown };
    expect(result.ok, JSON.stringify(result.error)).toBe(true);
    const mesh = (result.value as Record<string, { vertices: ArrayLike<number>; indices?: ArrayLike<number> }>)['mesh/blend-corner'];
    expect(mesh).toBeDefined();
    expect(mesh?.vertices.length).toBeGreaterThan(0);
    expect(mesh?.indices?.length ?? 0).toBeGreaterThan(0);
    expect(ms).toBeLessThan(10000);
  });
});
