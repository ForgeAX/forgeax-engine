import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decodeMeshBinary } from '@forgeax/engine-geometry';
import { buildScriptablePack, createStandardAssetOutputProducerRegistry } from '@forgeax/engine-import';
import { assetsJobOutputs, createMeshJobCooker } from '@forgeax/engine-modeling';
import { AssetGuid } from '@forgeax/engine-pack/source';
import { loadScriptablePack } from '@forgeax/engine-pack/source-node';
import { describe, expect, it } from 'vitest';
import { G7_JOB, G7_KEY, G7_OUTPUTS } from '../g7-face-job.ts';

/**
 * C-200 G7 on the real Import build kernel: the Pack build only emits the job's outputs as
 * `modeling-mesh-job` cook sources (well within the 15 s Pack budget); the project's cooker
 * builds the figure once and Import publishes meshes, materials and textures.
 * FORGEAX_UPDATE_GOLDEN=1 rewrites g7-face.outputs.json.
 */
const PACK = fileURLToPath(new URL('../g7-face.pack.ts', import.meta.url));
const UPDATE = process.env.FORGEAX_UPDATE_GOLDEN === '1';

async function build(withCooker: boolean) {
  const loaded = await loadScriptablePack(PACK);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.error));
  const built = await buildScriptablePack({
    definition: loaded.value,
    sourcePath: PACK,
    outputs: createStandardAssetOutputProducerRegistry(),
    ...(withCooker ? { cookers: [createMeshJobCooker([G7_JOB])] } : {}),
  });
  return { built, packageId: loaded.value.packageId };
}

describe('C-200 G7 face pack through the Import Pack build', () => {
  it.runIf(UPDATE)('lists the job outputs', { timeout: 900000 }, async () => {
    const loaded = await loadScriptablePack(PACK);
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.error));
    const out = await assetsJobOutputs(G7_JOB, { key: G7_KEY, packageId: loaded.value.packageId, params: {} });
    if (!out.ok) throw new Error(JSON.stringify(out.error));
    writeFileSync(new URL('../g7-face.outputs.json', import.meta.url), `${JSON.stringify(out.value, null, 2)}\n`);
  });

  it.skipIf(UPDATE)('cooks the job and publishes meshes, materials and textures', { timeout: 900000 }, async () => {
    const started = performance.now();
    const { built, packageId } = await build(true);
    if (!built.ok) throw new Error(JSON.stringify(built.error));
    console.log(`cold build ${Math.round(performance.now() - started)} ms`);
    const assets = built.value.product.assets;
    const guid = (key: string) => AssetGuid.format(AssetGuid.derive(packageId, key)).toLowerCase();
    expect(assets.map((a) => a.guid.toLowerCase()).sort()).toEqual(G7_OUTPUTS.map(guid).sort());
    const whole = assets.find((a) => a.guid.toLowerCase() === guid(`mesh/${G7_KEY}`));
    expect(whole?.artifacts.body?.assetCodec).toMatchObject({ name: 'mesh-binary' });
    const mesh = decodeMeshBinary(whole?.artifacts.body?.bytes as Uint8Array, []);
    expect((mesh?.indices?.length ?? 0) / 3).toBeGreaterThan(10000);
    for (const key of ['material/hair-0', 'material/hair-5', 'material/tail', 'material/face', 'material/apron-front', 'texture/maid-whale-face', 'texture/maid-whale-apron-emblem']) {
      expect(G7_OUTPUTS).toContain(key);
    }
    const parts = G7_OUTPUTS.filter((k) => k.startsWith(`mesh/${G7_KEY}.`));
    expect(parts.length).toBeGreaterThan(10);
    const tris = (key: string) => {
      const a = assets.find((x) => x.guid.toLowerCase() === guid(key));
      return (decodeMeshBinary(a?.artifacts.body?.bytes as Uint8Array, [])?.indices?.length ?? 0) / 3;
    };
    const sizes = Object.fromEntries(parts.map((k) => [k, tris(k)]));
    console.log(JSON.stringify(sizes));
    // The parts partition the figure: nothing dropped or doubled.
    expect(Object.values(sizes).reduce((a, b) => a + b, 0)).toBe(tris(`mesh/${G7_KEY}`));
  });

  it.skipIf(UPDATE)('builds the Pack within its budget: without the cooker it fails at once, naming the job kind', { timeout: 120000 }, async () => {
    const started = performance.now();
    const { built } = await build(false);
    expect(performance.now() - started).toBeLessThan(15000);
    expect(built.ok).toBe(false);
    if (!built.ok) expect(JSON.stringify(built.error)).toContain('modeling-mesh-job');
  });
});
