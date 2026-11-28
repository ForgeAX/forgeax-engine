// C-600 turret bake: kernel bakeMapsParallel of the UV-unwrapped low (work/low-uv.fxem) from the high (work/high.fxem),
// one bake group per rig part (`bake:<part>`), the C-410 'after' settings and this asset's slots.
// Raw maps go to <outDir>/maps/<map>.rgba and bake.json holds the command, commit and every number.
// usage: node bake.mts [outDir] [resolution=1024] [samples=4] [aoRays=16] [workers=8]
// env: LOW_FXEM and HIGH_FXEM override the input snapshots (default work/low-uv.fxem, work/high.fxem).
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { bakeMapsParallel } from '@forgeax/engine-modeling';
import { bakeWorkers } from '@forgeax/engine-modeling/tools';
import { bakeSettings } from '../asset.ts';

const [outDir = '/tmp/c4-turret-asset/out', resArg = '1024', sppArg = '4', raysArg = '16', wArg = '8'] = process.argv.slice(2);
const N = Number(resArg), SPP = Number(sppArg) as 1 | 4 | 9 | 16, RAYS = Number(raysArg), WORKERS = Number(wArg);
const dir = join(outDir, 'maps');
mkdirSync(dir, { recursive: true });
const base = new Uint8Array(readFileSync(process.env.LOW_FXEM ?? '/tmp/c4-turret-asset/work/low-uv.fxem'));
const detail = new Uint8Array(readFileSync(process.env.HIGH_FXEM ?? '/tmp/c4-turret-asset/work/high.fxem'));
const settings = bakeSettings(RAYS);
const t0 = performance.now();
const r = await bakeMapsParallel({ base, detail, ...settings, resolution: N, samples: SPP, budget: 1e15 } as never, bakeWorkers({ workers: WORKERS }));
const ms = Math.round(performance.now() - t0);
if (!r.ok) {
  console.error('bake failed', r.error.code, r.error.expected, JSON.stringify(r.error.detail).slice(0, 800));
  process.exit(1);
}
const B = r.value;
for (const [k, t] of Object.entries(B.textures)) {
  const level0 = (t as { data: Uint8Array }).data.subarray(0, N * N * 4);
  writeFileSync(join(dir, `${k}.rgba`), level0);
  const png = new PNG({ width: N, height: N });
  png.data = Buffer.from(level0);
  writeFileSync(join(dir, `${k}.png`), PNG.sync.write(png));
}
const out = {
  command: `node examples/c4carrier/case/bake.mts ${outDir} ${N} ${SPP} ${RAYS} ${WORKERS}`,
  commit: execSync('git rev-parse HEAD', { cwd: new URL('.', import.meta.url).pathname }).toString().trim(),
  resolution: N, samples: SPP, aoRays: RAYS, workers: WORKERS, ms, settings,
  pass: B.pass, issues: B.issues, provenance: B.provenance, report: B.report, diagnostics: B.diagnostics,
};
writeFileSync(join(outDir, 'bake.json'), JSON.stringify(out, null, 1));
const m = (B.report as { metrics?: Record<string, unknown> }).metrics ?? {};
console.log('ms', ms, 'covered', m.covered, 'rayHits', m.rayHits, 'nearest', m.nearest, 'hardEdges', m.hardEdges, 'pass', B.pass, 'issues', JSON.stringify(B.issues).slice(0, 800));
