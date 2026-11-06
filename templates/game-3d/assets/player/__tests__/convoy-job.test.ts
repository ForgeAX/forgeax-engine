import { isDeepStrictEqual } from 'node:util';
import { type AssetsJob, assetsJobSources, bakeMaps, createMeshJobCooker, model, sel } from '@forgeax/engine/modeling';
import { AssetGuid, definePackageId } from '@forgeax/engine/pack/source';
import { type Asset, type ByteCache, ok } from '@forgeax/engine/types';
import { expect, it } from 'vitest';
import { CONVOY_DELIVERY_MAPS } from '../convoy-job.ts';
import { convoyBakeSettings } from '../convoy-model.ts';
import { finishConvoyTextures } from '../convoy-finish.ts';

it('shares an offline asset build across outputs and recovers disposable bake entries', async () => {
  const packageId = definePackageId('019fb7ce-3700-7000-8000-00000000c00f');
  const entries = new Map<string, Uint8Array>();
  let writes = 0, builds = 0;
  const cache: ByteCache = { get: key => entries.get(key), put(key, bytes) { writes++; entries.set(key, bytes.slice()); } };
  const outputs = ['mesh/fixture', ...Object.values(CONVOY_DELIVERY_MAPS).map(map => `texture/fixture-${map}`)];
  const job: AssetsJob<{ resolution: number }> = {
    kind: 'assets', name: 'convoy-finish-fixture',
    build({ resolution }, context) {
      builds++;
      const base = model();
      base.box({ size: [1, 1, 1], material: 'red' });
      base.assign(sel.facing('+x'), 'steel');
      base.assign(sel.facing('-z'), 'glass');
      base.uv.auto({ resolution, padding: 1 });
      const mesh = base.finish({ key: 'fixture' });
      if (!mesh.ok) return mesh;
      const baked = bakeMaps({ base, detail: base, ...convoyBakeSettings(resolution), resolution, mips: false, cache: context.cache });
      if (!baked.ok) return baked;
      const maps = finishConvoyTextures(baked.value.textures);
      return ok({ ...mesh.value, ...Object.fromEntries(Object.entries(CONVOY_DELIVERY_MAPS).map(([map, suffix]) => [`texture/fixture-${suffix}`, maps[map]!])) });
    },
  };
  const cook = async (resolution: number) => {
    const sources = await assetsJobSources(job, { key: 'fixture', packageId, params: { resolution }, outputs });
    if (!sources.ok) throw sources.error;
    const cooker = createMeshJobCooker([job], { timeoutMs: 180000 });
    const out: Record<string, Asset> = {};
    for (const [key, entry] of Object.entries(sources.value)) {
      if (!('source' in entry)) throw new Error('Expected a deferred source');
      out[key] = (await cooker.cook({ guid: AssetGuid.format(AssetGuid.derive(packageId, key)), source: entry.source }, { cache })).payload;
    }
    return out;
  };
  const first = await cook(32);
  expect(builds).toBe(1);
  expect(Object.keys(first).sort()).toEqual([...outputs].sort());
  const firstWrites = writes;
  expect(firstWrites).toBeGreaterThan(0);
  expect(isDeepStrictEqual(await cook(32), first)).toBe(true);
  expect(builds).toBe(2);
  expect(writes).toBe(firstWrites);
  const changed = await cook(16);
  expect(builds).toBe(3);
  expect(writes).toBeGreaterThan(firstWrites);
  expect(changed['texture/fixture-normal']).toHaveProperty('shape.extent.width', 16);
  for (const key of entries.keys()) entries.set(key, new Uint8Array([1, 2, 3]));
  const beforeRecovery = writes;
  expect(isDeepStrictEqual(await cook(32), first)).toBe(true);
  expect(builds).toBe(4);
  expect(writes).toBeGreaterThan(beforeRecovery);
});
