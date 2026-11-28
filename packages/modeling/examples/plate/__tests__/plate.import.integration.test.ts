import { fileURLToPath } from 'node:url';
import { decodeMeshBinary } from '@forgeax/engine-geometry';
import { buildScriptablePack, createStandardAssetOutputProducerRegistry } from '@forgeax/engine-import';
import { createMeshJobCooker } from '@forgeax/engine-modeling';
import { AssetGuid } from '@forgeax/engine-pack/source';
import { loadScriptablePack } from '@forgeax/engine-pack/source-node';
import { describe, expect, it } from 'vitest';
import { PLATE_JOB } from '../plate';

/**
 * Check on the real Import build kernel: the C-700 Pack defers its exact-stage plate
 * program as a `modeling-mesh-job` cook source; with the project's cooker
 * registered, Import publishes it as an ordinary mesh-binary `mesh/plate`.
 */
const PACK = fileURLToPath(new URL('../plate.pack.ts', import.meta.url));

async function build(withCooker: boolean) {
  const loaded = await loadScriptablePack(PACK);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.error));
  const built = await buildScriptablePack({
    definition: loaded.value,
    sourcePath: PACK,
    outputs: createStandardAssetOutputProducerRegistry(),
    ...(withCooker ? { cookers: [createMeshJobCooker([PLATE_JOB])] } : {}),
  });
  return { built, packageId: loaded.value.packageId };
}

describe('C-700 plate through the Import Pack build', () => {
  it('cooks the deferred mesh job and publishes an ordinary mesh-binary', { timeout: 300000 }, async () => {
    const { built, packageId } = await build(true);
    if (!built.ok) throw new Error(JSON.stringify(built.error));
    const guid = AssetGuid.format(AssetGuid.derive(packageId, 'mesh/plate')).toLowerCase();
    const assets = built.value.product.assets;
    expect(assets.map((a) => a.guid.toLowerCase())).toEqual([guid]);
    const body = assets[0]?.artifacts.body;
    expect(body?.assetCodec).toMatchObject({ name: 'mesh-binary' });
    const mesh = decodeMeshBinary(body?.bytes as Uint8Array, []);
    expect(mesh?.kind).toBe('mesh');
    expect((mesh?.indices?.length ?? 0) / 3).toBe(12);
    expect(mesh?.submeshes).toHaveLength(2);
  });

  it('fails with a structured error when the project registers no mesh-job cooker', { timeout: 120000 }, async () => {
    const { built } = await build(false);
    expect(built.ok).toBe(false);
    if (!built.ok) expect(JSON.stringify(built.error)).toContain('modeling-mesh-job');
  });
});
