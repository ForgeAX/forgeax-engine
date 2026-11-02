// C-410 bake of one texture set: kernel bakeMaps with bake groups from <case>/bake/<set>.high.fxem
// onto <set>.base.fxem; raw maps to <outDir>/<set>/<map>.rgba + bake.json.
// mode 'after' (S1a: averaged cage blended to the face normal, auto cage, AO over all groups,
// floaters) or 'before' (the pre-cage behaviour: split shading normals, a fixed 4.5 cm / 9 cm
// projection, AO per group): the deliberate hard-edge comparison.
// usage: node bake.mts <caseDir> <outDir> <set> [resolution=2048] [samples=4] [aoRays=16] [mode=after]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bakeMaps } from '@forgeax/engine-modeling';
import { bakeSettings } from '../pipeline.ts';

const [caseDir, outDir, set, resArg, sppArg, raysArg, modeArg] = process.argv.slice(2);
const N = Number(resArg ?? 2048), SPP = Number(sppArg ?? 4) as 1 | 4 | 9 | 16, RAYS = Number(raysArg ?? 16);
const mode = (modeArg ?? 'after') as 'after' | 'before';
const dir = join(outDir!, set!);
mkdirSync(dir, { recursive: true });
const base = new Uint8Array(readFileSync(join(caseDir!, 'bake', `${set}.base.fxem`)));
const detail = new Uint8Array(readFileSync(join(caseDir!, 'bake', `${set}.high.fxem`)));
const settings = bakeSettings(mode, RAYS);
const t0 = performance.now();
const r = bakeMaps({ base, detail, ...settings, resolution: N, samples: SPP, budget: 1e15 });
const ms = performance.now() - t0;
if (!r.ok) {
  console.error('bake failed', set, r.error.code, r.error.expected, JSON.stringify(r.error.detail).slice(0, 600));
  process.exit(1);
}
const B = r.value;
for (const [k, t] of Object.entries(B.textures)) writeFileSync(join(dir, `${k}.rgba`), (t as { data: Uint8Array }).data.subarray(0, N * N * 4));
const out = { set, mode, resolution: N, samples: SPP, aoRays: RAYS, ms: Math.round(ms), settings, provenance: B.provenance, report: B.report, diagnostics: B.diagnostics };
writeFileSync(join(dir, 'bake.json'), JSON.stringify(out, null, 1));
const m = (B.report as { metrics?: Record<string, unknown> }).metrics ?? {};
console.log(set, mode, 'ms', Math.round(ms), 'covered', m.covered, 'rayHits', m.rayHits, 'nearest', m.nearest, 'hardEdges', m.hardEdges);
