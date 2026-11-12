import { MESH_JOB_COOK_KIND } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import pack from '../s7.pack';
import { S7_OUTPUTS } from '../s7-job';

/**
 * The S7 Pack build returns at once: every output is a `modeling-mesh-job` cook source
 * (the rig is built by the cooker, outside the Pack build budget).
 */
describe('C-100 S7 Pack as rig-job cook sources', () => {
  it('returns one cook source per listed output, quickly', async () => {
    const started = performance.now();
    const built = await pack.build({
      values: { sheet: 0, roundTrip: 1 },
      packageId: pack.packageId,
    } as never);
    expect(performance.now() - started).toBeLessThan(2000);
    if (!built.ok) throw new Error(JSON.stringify(built.error));
    const entries = Object.entries(built.value);
    expect(entries.map(([key]) => key)).toEqual([...S7_OUTPUTS].sort());
    for (const [, entry] of entries) {
      expect(entry).toMatchObject({ kind: MESH_JOB_COOK_KIND, execution: 'cooked' });
    }
    expect(S7_OUTPUTS).toContain('scene/s7');
    expect(S7_OUTPUTS).toContain('animation-clip/s7');
  });
});
