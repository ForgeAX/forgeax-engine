// usage: node uv.mts <outDir> [resolution=1024] [padding=4]
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { measureUv, model, sel } from '@forgeax/engine-modeling';
import { SEAM_PLAN, UV_ATLAS, unwrapLow } from '../asset.ts';
import { check } from '../kit.ts';
const [outDir = '/tmp/c4-turret-asset/out', resArg = String(UV_ATLAS.resolution), padArg = String(UV_ATLAS.padding)] = process.argv.slice(2);
const RES = Number(resArg), PAD = Number(padArg);
if (RES !== UV_ATLAS.resolution || PAD !== UV_ATLAS.padding) throw new Error('the atlas is fixed by UV_ATLAS in asset.ts');
mkdirSync(outDir, { recursive: true });
const low = model({ budget: { work: 4e9 } });
check(low.append(new Uint8Array(readFileSync('/tmp/c4-turret-asset/work/low.fxem'))), 'load low');
const t0 = performance.now();
const unwrap = unwrapLow(low);
const rep = unwrap.report;
const ms = Math.round(performance.now() - t0);
writeFileSync('/tmp/c4-turret-asset/work/low-uv.fxem', low.snapshot());
const m = measureUv(low.editMesh);
if (!m.ok) throw m.error;
const diag = (rep.diagnostics ?? []).map((d) => ({ message: d.message, detail: d.detail }));
const tpm = diag.map((d) => (d.detail as { metrics?: { texelsPerMeter?: number; coverage?: number } } | undefined)?.metrics).find((x) => x?.texelsPerMeter !== undefined);
const target = tpm?.texelsPerMeter ?? 0;
const v = low.validate({ uniqueUv: true, texelDensity: { resolution: RES, target } } as never);
const isl = m.value.islands;
const out = {
  command: `node examples/c4carrier/case/uv.mts ${outDir} ${RES} ${PAD}`,
  commit: execSync('git rev-parse HEAD', { cwd: new URL('.', import.meta.url).pathname }).toString().trim(),
  options: { resolution: RES, padding: PAD, plan: SEAM_PLAN, pack: 'raster' },
  ms,
  seamPasses: unwrap.overlapPairs,
  texelDensityTarget: target,
  islands: isl.length,
  faces: low.count(sel.all()),
  triangles: (() => { const o = low.toMesh({ normals: { mode: 'autoSmooth', angle: 45 } }); if (!o.ok) throw o.error; return o.value.report.triangles; })(),
  stretchL2: m.value.stretchL2,
  stretchLinf: m.value.stretchLinf,
  areaDistortion: m.value.areaDistortion,
  texelDensityDispersion: m.value.texelDensityDispersion,
  flipped: m.value.flipped,
  zeroArea: m.value.zeroArea,
  worstIsland: isl.slice().sort((a, b) => (b.areaDistortion ?? 0) - (a.areaDistortion ?? 0)).slice(0, 5),
  pack: tpm,
  validateIssues: v.issues.filter((i) => !i.code.startsWith('face-nonplanar')).map((i) => ({ code: i.code, severity: i.severity, detail: JSON.stringify(i.detail).slice(0, 400) })),
  diagnostics: diag.map((d) => ({ message: d.message, detail: JSON.stringify(d.detail).slice(0, 700) })),
};
writeFileSync(join(outDir, 'uv.json'), `${JSON.stringify(out, null, 1)}\n`);
console.log(JSON.stringify({ ...out, diagnostics: undefined, worstIsland: undefined }, null, 1));
