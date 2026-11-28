// C-600 turret rig clip: clearance scan (rig.scan) of the fire cycle over the baked low turret, with the pose at each strip frame.
// Reads work/low-uv.fxem; writes <outDir>/clip-dmu.json.
// usage: node clip.mts [outDir=/tmp/c4-turret-asset/out]
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { model } from '@forgeax/engine-modeling';
import { CLIP_FRAMES, ELEVATE, FIRE_CYCLE, TRAIN } from '../clip.ts';
import { check } from '../kit.ts';
import { ELEVATION, RECOIL, TRAVERSE } from '../proportions.ts';
import { TURRET_PARTS, turretRig } from '../rig.ts';

const [outDir = '/tmp/c4-turret-asset/out'] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const CLEARANCE = 0.02;
const REPORT = 0.15;
const low = model({ budget: { work: 4e9 } });
check(low.append(new Uint8Array(readFileSync('/tmp/c4-turret-asset/work/low-uv.fxem'))), 'load low');
const rig = turretRig(low);
const parts = rig.parts();
if (!parts.ok) throw parts.error;
const t0 = performance.now();
const scan = rig.scan(FIRE_CYCLE, { step: 0.01, maxTravel: 0.1, clearance: REPORT });
if (!scan.ok) throw scan.error;
const ms = Math.round(performance.now() - t0);
const pairs = Object.fromEntries(scan.value.pairs.map((p) => [p.parts.join('~'), { status: p.status, minDistance: p.minDistance }]));
const worst = Math.min(Infinity, ...scan.value.pairs.map((p) => p.minDistance as number));
const frames = CLIP_FRAMES.map((f) => {
  const sampled = rig.sample(FIRE_CYCLE, f.u);
  if (!sampled.ok) throw sampled.error;
  const at = rig.interference(sampled.value);
  if (!at.ok) throw at.error;
  return { ...f, pose: sampled.value, interference: at.value.pass, pairs: at.value.pairs.length };
});
const out = {
  command: `node examples/c4carrier/case/clip.mts ${outDir}`,
  commit: execSync('git rev-parse HEAD', { cwd: new URL('.', import.meta.url).pathname }).toString().trim(),
  subject: 'baked low turret (work/low-uv.fxem) on the rig of examples/c4carrier/rig.ts',
  parts: parts.value.map((p) => ({ name: p.name, closed: p.closed })),
  partOrder: [...TURRET_PARTS],
  clip: { name: 'fire-cycle', interpolation: FIRE_CYCLE.interpolation, keys: FIRE_CYCLE.keys, train: TRAIN, elevate: ELEVATE },
  limits: { traverse: TRAVERSE, elevation: ELEVATION, recoil: RECOIL },
  scan: { step: 0.01, maxTravel: 0.1, reportBelow: REPORT, clearanceThreshold: CLEARANCE, ms },
  samples: scan.value.samples.length,
  evaluated: scan.value.evaluated,
  clamped: scan.value.clamped,
  confirmed: scan.value.pairs.filter((p) => p.status === 'confirmed').length,
  pairs,
  minimumDistance: worst,
  pass: scan.value.clamped.length === 0 && scan.value.pairs.every((p) => p.status !== 'confirmed') && worst > CLEARANCE,
  frames,
};
writeFileSync(join(outDir, 'clip-dmu.json'), JSON.stringify(out, null, 1));
console.log(JSON.stringify({ pass: out.pass, minimumDistance: worst, samples: out.samples, evaluated: out.evaluated, pairs, ms }));
