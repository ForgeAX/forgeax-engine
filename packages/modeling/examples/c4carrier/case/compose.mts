// C-600 turret compose: the C-410 wear layer over the baked slot maps (scifi-mech/maps.ts), on the low atlas.
// Reads <outDir>/bake.json + maps/*.rgba and work/low-uv.fxem; writes maps/{albedo,orm,emissive}.{rgba,png} and compose.json.
// usage: node compose.mts [outDir] [resolution=1024]
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { model } from '@forgeax/engine-modeling';
import { PNG } from 'pngjs';
import { composeVariant, prepareSet, WEAR } from '../../scifi-mech/maps.ts';
import { LOW_NORMALS } from '../asset.ts';
import { check } from '../kit.ts';

const [outDir = '/tmp/c4-turret-asset/out', resArg = '1024'] = process.argv.slice(2);
const N = Number(resArg);
const dir = join(outDir, 'maps');
const info = JSON.parse(readFileSync(join(outDir, 'bake.json'), 'utf8'));
const read = (k: string) => new Uint8Array(readFileSync(join(dir, `${k}.rgba`)));
const maps = Object.fromEntries(['normal', 'curvature', 'materialId', 'baseColor', 'ormh', 'emissive'].map((k) => [k, read(k)])) as never;
const low = model({ budget: { work: 4e9 } });
check(low.append(new Uint8Array(readFileSync('/tmp/c4-turret-asset/work/low-uv.fxem'))), 'load low');
const exported = low.toMesh({ normals: LOW_NORMALS });
if (!exported.ok) throw exported.error;
const mesh = exported.value.mesh as unknown as { attributes: { position: Float32Array; normal: Float32Array; uv: Float32Array }; indices: { data: ArrayLike<number> } | ArrayLike<number> };
const indices = 'data' in (mesh.indices as object) ? (mesh.indices as { data: ArrayLike<number> }).data : (mesh.indices as ArrayLike<number>);
const t0 = performance.now();
const prepared = prepareSet(N, { position: mesh.attributes.position, normal: mesh.attributes.normal, uv: mesh.attributes.uv, indices }, maps, info.provenance.materials);
const { albedo, orm, emissive } = composeVariant(prepared, 'art');
const ms = Math.round(performance.now() - t0);
for (const [k, v] of Object.entries({ albedo, orm, emissive })) {
  writeFileSync(join(dir, `${k}.rgba`), v);
  const png = new PNG({ width: N, height: N });
  png.data = Buffer.from(v);
  writeFileSync(join(dir, `${k}.png`), PNG.sync.write(png));
}
const out = {
  command: `node examples/c4carrier/case/compose.mts ${outDir} ${N}`,
  commit: execSync('git rev-parse HEAD', { cwd: new URL('.', import.meta.url).pathname }).toString().trim(),
  resolution: N,
  ms,
  slots: prepared.slotNames,
  coveredTexels: prepared.covered,
  coverage: prepared.covered / (N * N),
  wearContext: prepared.wear,
  wear: { ...WEAR, bareFraction: WEAR.bare / Math.max(1, WEAR.painted), rustFraction: WEAR.rust / Math.max(1, WEAR.painted), grimeFraction: WEAR.grime / Math.max(1, WEAR.painted) },
};
writeFileSync(join(outDir, 'compose.json'), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out));
