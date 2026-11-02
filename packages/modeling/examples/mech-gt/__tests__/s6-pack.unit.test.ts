import { MESH_JOB_COOK_KIND } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import front from '../s6-front.pack';
import cabin from '../s6-cabin.pack';
import nose from '../s6-nose.pack';
import rear from '../s6-rear.pack';
import wheels from '../s6-wheels.pack';
import { S6_OUTPUTS } from '../s6-job';

/**
 * The S6 exterior group Packs return at once: every output is a `modeling-mesh-job` cook
 * source of the group's job (built, baked and LOD-reduced by the cooker, outside the Pack
 * build budget).
 */
describe('C-100 S6 group Packs as assets-job cook sources', () => {
  it.each([
    ['front', front],
    ['nose', nose],
    ['cabin', cabin],
    ['rear', rear],
    ['wheels', wheels],
  ] as const)('%s returns one cook source per listed output, quickly', async (group, pack) => {
    const started = performance.now();
    const built = await pack.build({ values: {}, packageId: pack.packageId } as never);
    expect(performance.now() - started).toBeLessThan(2000);
    if (!built.ok) throw new Error(JSON.stringify(built.error));
    const entries = Object.entries(built.value);
    expect(entries.map(([key]) => key)).toEqual([...S6_OUTPUTS[group]].sort());
    expect(S6_OUTPUTS[group]).toContain(`mesh/s6-${group}`);
    for (const [, entry] of entries) expect(entry).toMatchObject({ kind: MESH_JOB_COOK_KIND, execution: 'cooked' });
  });
});
