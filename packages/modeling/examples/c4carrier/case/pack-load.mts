// C-600 turret Pack cook and load check: the Import Pack worklist with the turret cooker (as the C-410 show test does),
// then every mesh decoded from its cooked body, the LOD chain topology, and the texture/material artifacts.
// usage: node pack-load.mts [outDir=/tmp/c4-turret-asset/out]; writes <outDir>/pack-load.json and <outDir>/lod.json
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeMeshBinary, unpackMeshBin } from '@forgeax/engine-geometry';
import { buildScriptablePackWorklist, createScriptablePackProductCache, createStandardAssetOutputProducerRegistry } from '@forgeax/engine-import';
import { lodTopologyReport } from '@forgeax/engine-modeling';
import { AssetGuid } from '@forgeax/engine-pack/source';
import { inventoryScriptablePackSource, loadScriptablePack } from '@forgeax/engine-pack/source-node';
import { createTurretCooker, lodKeys, materialKey, meshKey, textureKey, TURRET, TURRET_LODS } from '../turret-job.ts';

const [outDir = '/tmp/c4-turret-asset/out'] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const PACK = fileURLToPath(new URL('../turret.pack.ts', import.meta.url));
const load = async () => {
  const loaded = await loadScriptablePack(PACK);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.error));
  return loaded.value;
};
const definition = await load();
const outputs = createStandardAssetOutputProducerRegistry();
const cookers = [createTurretCooker()];
const cache = await createScriptablePackProductCache({ root: process.env.FORGEAX_C600_DDC ?? mkdtempSync(join(tmpdir(), 'c600-ddc-')), outputVersions: outputs.versions(), cookers });
const sourceClosure = await inventoryScriptablePackSource(PACK);
const cook = async () => {
  const t = performance.now();
  const res = await buildScriptablePackWorklist({ subjects: [{ definition: await load(), sourcePath: PACK, sourceClosure }], outputs, cache, cookers });
  if (!res.ok) throw new Error(JSON.stringify(res.error).slice(0, 1500));
  return { res, ms: Math.round(performance.now() - t) };
};
const first = await cook();
const second = await cook();
const bp = first.res.value.buildProducts[0] as unknown as { assets?: never[]; product?: { assets: never[] } };
const assets = (bp.assets ?? bp.product?.assets) as { guid: string; artifacts: Record<string, { bytes?: Uint8Array; mediaType?: string }> }[];
const entry = (key: string) => {
  const guid = AssetGuid.format(AssetGuid.derive(definition.packageId, key)).toLowerCase();
  const a = assets.find((x) => x.guid.toLowerCase() === guid);
  if (a === undefined) throw new Error(`missing published asset ${key}`);
  return a;
};
const artifactBytes = (key: string) => Object.fromEntries(Object.entries(entry(key).artifacts).map(([k, v]) => [k, v.bytes?.byteLength ?? 0]));
const total = (key: string) => Object.values(artifactBytes(key)).reduce((n, b) => n + b, 0);
const decode = (key: string) => {
  const refs = (entry(key) as unknown as { refs?: { guid: string }[] }).refs?.map((r) => r.guid) ?? [];
  const mesh = decodeMeshBinary(entry(key).artifacts.body?.bytes as Uint8Array, refs);
  if (mesh === undefined) throw new Error(`mesh ${key} does not decode: ${JSON.stringify(unpackMeshBin(entry(key).artifacts.body?.bytes as Uint8Array)).slice(0, 600)} ${JSON.stringify(Object.entries(entry(key).artifacts).map(([k, v]) => [k, v.mediaType, v.bytes?.byteLength]))}`);
  return mesh;
};
const tris = (m: ReturnType<typeof decode>) => m.submeshes.reduce((n, s) => n + s.indexCount / 3, 0);

const parts: Record<string, unknown> = {};
const lod: Record<string, unknown> = {};
let lodTotals: number[] = TURRET_LODS.levels.map(() => 0);
let lod0Total = 0;
for (const part of TURRET.parts) {
  const levels = [meshKey(part), ...lodKeys(meshKey(part))].map(decode);
  const counts = levels.map(tris);
  lod0Total += counts[0] as number;
  lodTotals = lodTotals.map((n, i) => n + (counts[i + 1] as number));
  const topo = lodTopologyReport(levels);
  parts[part] = { mesh: meshKey(part), bytes: total(meshKey(part)), lodBytes: lodKeys(meshKey(part)).map(total), submeshes: levels[0]?.submeshes.length, lods: levels.map((m) => m.lods?.length ?? 0) };
  lod[part] = { triangles: counts, ratios: counts.map((c) => c / (counts[0] as number)), topology: topo };
}
const textures = Object.fromEntries(TURRET.maps.map((m) => [textureKey(m), { artifacts: artifactBytes(textureKey(m)), mediaTypes: Object.fromEntries(Object.entries(entry(textureKey(m)).artifacts).map(([k, v]) => [k, v.mediaType])) }]));
const materials = Object.fromEntries((['baked', 'plain'] as const).map((k) => {
  const a = entry(materialKey(k)) as unknown as { kind: string; payload: Record<string, unknown>; refs?: { guid: string }[] };
  return [materialKey(k), { kind: a.kind, artifactBytes: artifactBytes(materialKey(k)), payloadKeys: Object.keys(a.payload), textureRefs: (a.refs ?? []).map((r) => r.guid), pointsAtPublishedTextures: (a.refs ?? []).every((r) => assets.some((x) => x.guid.toLowerCase() === r.guid.toLowerCase())) }];
}));
const commit = execSync('git rev-parse HEAD', { cwd: fileURLToPath(new URL('.', import.meta.url)) }).toString().trim();
const command = `node examples/c4carrier/case/pack-load.mts ${outDir}`;
const textureBytes = TURRET.maps.reduce((n, m) => n + total(textureKey(m)), 0);
writeFileSync(join(outDir, 'pack-load.json'), JSON.stringify({
  command, commit, pack: 'examples/c4carrier/turret.pack.ts', packageId: String(definition.packageId), quality: 'page',
  coldMs: first.ms, warmMs: second.ms, publishedAssets: assets.length,
  load: 'Import buildScriptablePackWorklist with createTurretCooker; mesh bodies decoded by decodeMeshBinary',
  parts, textures, materials, lod0Triangles: lod0Total, lodTriangles: lodTotals, textureBytes, publishedBytes: assets.reduce((n, a) => n + Object.values(a.artifacts).reduce((m, v) => m + (v.bytes?.byteLength ?? 0), 0), 0),
}, null, 1));
writeFileSync(join(outDir, 'lod.json'), JSON.stringify({ command, commit, request: TURRET_LODS, lod0Triangles: lod0Total, lodTriangles: lodTotals, parts: lod }, null, 1));
console.log('cold', first.ms, 'warm', second.ms, 'lod0', lod0Total, 'lods', lodTotals, 'textureBytes', textureBytes);
