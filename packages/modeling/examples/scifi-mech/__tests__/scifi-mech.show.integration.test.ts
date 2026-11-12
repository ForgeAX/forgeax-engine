import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeMeshBinary } from '@forgeax/engine-geometry';
import { buildScriptablePackWorklist, createScriptablePackProductCache, createStandardAssetOutputProducerRegistry } from '@forgeax/engine-import';
import { AssetGuid } from '@forgeax/engine-pack/source';
import { inventoryScriptablePackSource, loadScriptablePack } from '@forgeax/engine-pack/source-node';
import { describe, expect, it } from 'vitest';
import { HIGH } from '../kit';
import { GROUPS } from '../mech';
import { buildGroup, exportDump, HIGH_NORMALS, tris } from '../pipeline';
import { SHOW_META } from '../show';
import { createC410Cooker } from '../show-job';
import stats from '../show.stats.json';

/**
 * The full C-410 cook through the Import Pack build with the show cooker registered (three
 * 2048 bakes with composition and KTX2 delivery, and the decimated preview). Opt in with
 * FORGEAX_C410_COOK=1; FORGEAX_UPDATE_GOLDEN=1 rewrites show.stats.json from the cooked
 * outputs (SHOW_META.stats reads it), otherwise the run must reproduce it.
 */
const PACK = fileURLToPath(new URL('../scifi-mech.pack.ts', import.meta.url));
const UPDATE = process.env.FORGEAX_UPDATE_GOLDEN === '1';

describe.runIf(process.env.FORGEAX_C410_COOK === '1')('C-410 show Pack, cooked', () => {
  it('publishes every key; the preview is within 300k triangles; stats are the cooked sizes', { timeout: 3_600_000 }, async () => {
    // An executor lease serves one build, so each cook loads the Pack again.
    const load = async () => {
      const loaded = await loadScriptablePack(PACK);
      if (!loaded.ok) throw new Error(JSON.stringify(loaded.error));
      return loaded.value;
    };
    const definition = await load();
    const outputs = createStandardAssetOutputProducerRegistry();
    const cookers = [createC410Cooker()];
    const cache = await createScriptablePackProductCache({ root: mkdtempSync(join(tmpdir(), 'c410-ddc-')), outputVersions: outputs.versions(), cookers });
    // The product cache reads and writes only subjects with a source closure, as the scanner supplies.
    const sourceClosure = await inventoryScriptablePackSource(PACK);
    const cook = async () => {
      const t = performance.now();
      const res = await buildScriptablePackWorklist({ subjects: [{ definition: await load(), sourcePath: PACK, sourceClosure }], outputs, cache, cookers });
      if (!res.ok) throw new Error(JSON.stringify(res.error));
      return { res, ms: Math.round(performance.now() - t) };
    };
    const first = await cook();
    const ms = first.ms;
    const second = await cook();
    console.log('C410 cold ms', ms, 'warm ms', second.ms);
    expect(second.ms).toBeLessThan(Math.max(30_000, ms / 10));
    const bp = first.res.value.buildProducts[0] as unknown as { assets?: never[]; product?: { assets: never[] } };
    const assets = (bp.assets ?? bp.product?.assets) as { guid: string; artifacts: Record<string, { bytes?: Uint8Array }> }[];
    const entry = (key: string) => {
      const guid = AssetGuid.format(AssetGuid.derive(definition.packageId, key)).toLowerCase();
      const a = assets.find((x) => x.guid.toLowerCase() === guid);
      expect(a, key).toBeDefined();
      return a;
    };
    const bytesOf = (key: string) => Object.values(entry(key)?.artifacts ?? {}).reduce((n, art) => n + ((art as { bytes?: Uint8Array }).bytes?.byteLength ?? 0), 0);
    const trisOf = (key: string) => ((decodeMeshBinary(entry(key)?.artifacts.body?.bytes as Uint8Array, [])?.indices?.length ?? 0) / 3);

    const bytes: Record<string, number> = {};
    let lowTris = 0;
    for (const part of SHOW_META.parts) {
      const key = `mesh/c410-low.${part}`;
      bytes[key] = bytesOf(key);
      lowTris += trisOf(key);
    }
    bytes['mesh/c410-high'] = bytesOf('mesh/c410-high');
    const highPreviewTris = trisOf('mesh/c410-high');
    let textureBytes = 0;
    for (const slot of SHOW_META.slots) for (const key of Object.values(slot.maps)) textureBytes += bytes[key as string] = bytesOf(key as string);
    const highTris = GROUPS.reduce((n, g) => {
      const m = buildGroup(g, HIGH);
      m.uv.project({ mode: 'box', scale: 0.5 });
      return n + tris(exportDump(m, g.name, HIGH_NORMALS)) * (g.mirrored ? 2 : 1);
    }, 0);
    const measured = { highTris, highPreviewTris, lowTris, textureBytes, bytes };
    console.log('C410 cook ms', ms, JSON.stringify(measured));
    if (UPDATE) writeFileSync(new URL('../show.stats.json', import.meta.url), `${JSON.stringify(measured, null, 2)}\n`);
    expect(highPreviewTris).toBeLessThanOrEqual(300_000);
    expect(highPreviewTris).toBeGreaterThan(100_000);
    if (!UPDATE) expect(measured).toEqual(stats);
  });
});
