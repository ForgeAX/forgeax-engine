import { writeFileSync } from 'node:fs';
import { assetsJobOutputs, createMeshJobCooker } from '@forgeax/engine-modeling';
import { NativeCookerRegistry } from '@forgeax/engine-pack/native-cooker';
import { AssetGuid } from '@forgeax/engine-pack/source';
import { describe, expect, it } from 'vitest';
import cabin from '../s6-cabin.pack';
import front from '../s6-front.pack';
import { S6_JOBS, S6_OUTPUTS, s6JobOf } from '../s6-job';
import nose from '../s6-nose.pack';
import rear from '../s6-rear.pack';
import wheels from '../s6-wheels.pack';
import { S7_JOB } from '../s7-job';

/**
 * C-100 S6, the mech-gt gate: each S6 group job builds exactly the outputs its Pack lists
 * (FORGEAX_UPDATE_GOLDEN=1 rewrites s6.outputs.json), and the shared `modeling-mesh-job`
 * cooker (S7 and S6 jobs in one registration, as a project registers them) cooks the nose
 * group's outputs equal to the job's own.
 */
const PACKS = { front, nose, cabin, rear, wheels } as const;
const UPDATE = process.env.FORGEAX_UPDATE_GOLDEN === '1';

describe.runIf(process.env.FORGEAX_MECH_GT_SCAN === '1' || UPDATE)('C-100 S6 group jobs', () => {
  it('every group job builds the outputs its Pack lists', { timeout: 3600000 }, async () => {
    const listed: Record<string, readonly string[]> = {};
    for (const [group, pack] of Object.entries(PACKS) as [keyof typeof PACKS, (typeof PACKS)[keyof typeof PACKS]][]) {
      const out = await assetsJobOutputs(s6JobOf(group), { key: `s6-${group}`, packageId: pack.packageId, params: {} });
      if (!out.ok) throw new Error(JSON.stringify(out.error));
      listed[group] = out.value;
    }
    if (UPDATE) writeFileSync(new URL('../s6.outputs.json', import.meta.url), `${JSON.stringify(listed, null, 2)}\n`);
    expect(listed).toEqual(S6_OUTPUTS);
  });

  it('the shared cooker cooks the nose group equal to its job', { timeout: 1800000 }, async () => {
    const registry = new NativeCookerRegistry();
    registry.register(createMeshJobCooker([S7_JOB, ...S6_JOBS]));
    const built = await nose.build({ values: {}, packageId: nose.packageId } as never);
    if (!built.ok) throw new Error(JSON.stringify(built.error));
    const direct = await s6JobOf('nose').build({}, { packageId: nose.packageId });
    if (!direct.ok) throw new Error(JSON.stringify(direct.error));
    // LOD chain: each level a separate mesh with fewer triangles than the one before.
    const tris = ['mesh/s6-nose', 'mesh/s6-nose/lod1', 'mesh/s6-nose/lod2'].map((k) => ((direct.value[k] as { indices?: ArrayLike<number> }).indices?.length ?? 0) / 3);
    expect([(tris[1] as number) < (tris[0] as number), (tris[2] as number) < (tris[1] as number)]).toEqual([true, true]);
    const bytes = (v: unknown) => JSON.stringify(v, (_k, x) => (ArrayBuffer.isView(x) ? Array.from(x as Uint8Array) : x));
    for (const [key, entry] of Object.entries(built.value)) {
      const guid = AssetGuid.format(AssetGuid.derive(nose.packageId, key));
      const draft = await registry.runDraft('modeling-mesh-job', { guid, source: JSON.parse(JSON.stringify((entry as { source: unknown }).source)) });
      if (!draft.ok) throw new Error(JSON.stringify(draft.error));
      expect([key, bytes(draft.value.payload) === bytes(direct.value[key])]).toEqual([key, true]);
    }
  });
});
