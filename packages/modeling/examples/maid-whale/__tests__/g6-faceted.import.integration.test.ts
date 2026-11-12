import { fileURLToPath } from 'node:url';
import { decodeMeshBinary } from '@forgeax/engine-geometry';
import { buildScriptablePack, createStandardAssetOutputProducerRegistry } from '@forgeax/engine-import';
import { createMeshJobCooker } from '@forgeax/engine-modeling';
import { AssetGuid } from '@forgeax/engine-pack/source';
import { loadScriptablePack } from '@forgeax/engine-pack/source-node';
import { describe, expect, it } from 'vitest';
import { G6_JOB } from '../faceting.ts';

/**
 * C-200 G6 on the real Import build kernel: the Pack build only emits the faceting job as a
 * `modeling-mesh-job` cook source (well within the 15 s Pack budget); the project's cooker
 * builds it and Import publishes an ordinary mesh-binary `mesh/maid-whale-faceted`.
 */
const PACK = fileURLToPath(new URL('../g6-faceted.pack.ts', import.meta.url));

async function build(withCooker: boolean) {
  const loaded = await loadScriptablePack(PACK);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.error));
  const built = await buildScriptablePack({
    definition: loaded.value,
    sourcePath: PACK,
    outputs: createStandardAssetOutputProducerRegistry(),
    ...(withCooker ? { cookers: [createMeshJobCooker([G6_JOB])] } : {}),
  });
  return { built, packageId: loaded.value.packageId };
}

describe('C-200 G6 faceted mesh through the Import Pack build', () => {
  it('cooks the deferred faceting job and publishes the faceted mesh-binary', { timeout: 600000 }, async () => {
    const { built, packageId } = await build(true);
    if (!built.ok) throw new Error(JSON.stringify(built.error));
    const guid = AssetGuid.format(AssetGuid.derive(packageId, 'mesh/maid-whale-faceted')).toLowerCase();
    const assets = built.value.product.assets;
    expect(assets.map((a) => a.guid.toLowerCase())).toEqual([guid]);
    const body = assets[0]?.artifacts.body;
    expect(body?.assetCodec).toMatchObject({ name: 'mesh-binary' });
    const mesh = decodeMeshBinary(body?.bytes as Uint8Array, []);
    expect(mesh?.kind).toBe('mesh');
    expect((mesh?.indices?.length ?? 0) / 3).toBeGreaterThan(10000);
  });

  it('builds the Pack within its budget: without the cooker it fails at once, naming the job kind', { timeout: 120000 }, async () => {
    const started = performance.now();
    const { built } = await build(false);
    expect(performance.now() - started).toBeLessThan(15000);
    expect(built.ok).toBe(false);
    if (!built.ok) expect(JSON.stringify(built.error)).toContain('modeling-mesh-job');
  });
});
