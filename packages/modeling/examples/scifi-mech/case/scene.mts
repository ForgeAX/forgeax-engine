// C-410 scene description for render.dawn.test.ts. usage: node scene.mts <caseDir> <mapsDir|-> [jobs regexp]
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EMISSIVE_SCALE, PBR } from '../palette.ts';

type V3 = [number, number, number];
const [dir, maps, only] = process.argv.slice(2);
const BEFORE = process.env.C410_BEFORE;
const meta = (n: string) => JSON.parse(readFileSync(join(dir!, 'meshes', `${n}.meta.json`), 'utf8'));
const high = meta('high'), low = meta('low');
const materials: Record<string, unknown> = { ...PBR };
const textures: Record<string, unknown> = {};
for (const set of ['set1', 'set2', 'set3']) {
  materials[`${set}-flat`] = PBR.armor;
  if (maps && maps !== '-') {
    for (const variant of ['art', 'fair']) {
      const m = JSON.parse(readFileSync(join(maps, variant, set, 'set.json'), 'utf8'));
      textures[`${set}-${variant}`] = { w: m.resolution, h: m.resolution, dir: join(maps, variant, set) };
      materials[`${set}-${variant}`] = { color: [1, 1, 1], metallic: 1, roughness: 1, maps: `${set}-${variant}`, ei: EMISSIVE_SCALE };
    }
    materials[`${set}-normal`] = { ...PBR.armor, maps: `${set}-fair`, layers: ['normal'] };
    if (BEFORE) {
      textures[`${set}-before`] = { w: 2048, h: 2048, dir: join(BEFORE, 'fair', set) };
      materials[`${set}-before`] = { color: [1, 1, 1], metallic: 1, roughness: 1, maps: `${set}-before`, ei: EMISSIVE_SCALE };
      materials[`${set}-beforenormal`] = { ...PBR.armor, maps: `${set}-before`, layers: ['normal'] };
    }
  }
}
const lowVariant = (suffix: string) => [{ mesh: 'low', materials: (low.slots as string[]).map((s) => `${s}-${suffix}`) }];
const TT = Number(process.env.C410_TT ?? 0);
const variants: Record<string, unknown> = {
  high: [{ mesh: 'high', materials: high.slots }],
  lowflat: lowVariant('flat'),
  ...(maps && maps !== '-' ? { low: lowVariant('art'), lowfair: lowVariant('fair'), lownormal: lowVariant('normal'), lowmip: lowVariant('fair@mip') } : {}),
  ...(BEFORE ? { lowbefore: lowVariant('before'), lowbeforenormal: lowVariant('beforenormal') } : {}),
};
for (const s of ['form', 'bevel', 'panels', 'vents', 'fasteners', 'hydraulics']) variants[`high-${s}`] = [{ mesh: `high-${s}`, materials: meta(`high-${s}`).slots }];
const views: Record<string, { eye: V3; target: V3 }> = {
  front: { eye: [3.0, 1.2, 5.6], target: [0.05, 1.78, 0] },
  hero: { eye: [3.9, 0.8, 5.5], target: [0.1, 1.72, 0.1] },
  side: { eye: [6.3, 1.3, 1.5], target: [0, 1.78, 0] },
  back: { eye: [-3.4, 1.5, -5.4], target: [0, 1.82, 0] },
  chest: { eye: [1.75, 3.05, 2.2], target: [0.35, 2.75, 0.2] },
  knee: { eye: [1.6, 1.4, -1.3], target: [0.42, 1.0, -0.12] },
  grazing: { eye: [0.75, 2.3, 1.05], target: [0.4, 0.55, 0.14] },
  rim: { eye: [0.98, 1.02, 0.78], target: [0.6, 0.93, 0.25] },
  far: { eye: [6.6, 2.6, 11.0], target: [0, 1.75, 0] },
};
// Presentation mode (C410_STUDIO=1): flat #5D6169 clear colour, no floor or backdrop,
// the case-two-light default lighting, 1600x1200, subject centred with the limiting axis at 84 %.
const STUDIO = !!process.env.C410_STUDIO;
const STUDIO_FOV = Math.PI / 5;
if (STUDIO) {
  const raw = readFileSync(join(dir!, 'meshes', 'low.bin'));
  const pts = new Float32Array(raw.buffer, raw.byteOffset, (low.verts as number) * 3);
  // Vertex extents of the low mesh (the corner-box fit leaves the robot at about 60 % of the frame).
  const b = [1e9, 1e9, 1e9, -1e9, -1e9, -1e9];
  for (let k = 0; k < (low.verts as number); k++) for (let a = 0; a < 3; a++) { b[a] = Math.min(b[a]!, pts[k * 3 + a]!); b[a + 3] = Math.max(b[a + 3]!, pts[k * 3 + a]!); }
  const c: V3 = [(b[0]! + b[3]!) / 2, (b[1]! + b[4]!) / 2, (b[2]! + b[5]!) / 2];
  const presets: Record<string, V3> = { 'three-quarter': [0.56, 0.42, 0.71], front: [0, 0.12, 1], side: [1, 0.12, 0], rear: [0, 0.12, -1], top: [0, 1, 0.001] };
  const fit = (dir: V3) => {
    const l = Math.hypot(...dir), f: V3 = [-dir[0] / l, -dir[1] / l, -dir[2] / l];
    const r = ((): V3 => { const x: V3 = [f[2], 0, -f[0]]; const k = Math.hypot(...x); return [x[0] / k, 0, x[2] / k]; })();
    const u: V3 = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
    const t = Math.tan(STUDIO_FOV / 2), aspect = 4 / 3;
    let lo = 0.5, hi = 200;
    for (let i = 0; i < 60; i++) {
      const d = (lo + hi) / 2;
      let m = 0;
      for (let k = 0; k < (low.verts as number); k++) {
        const x = pts[k * 3]!, y = pts[k * 3 + 1]!, z = pts[k * 3 + 2]!;
        const q: V3 = [x - c[0] + f[0] * d, y - c[1] + f[1] * d, z - c[2] + f[2] * d];
        const depth = q[0] * f[0] + q[1] * f[1] + q[2] * f[2];
        m = Math.max(m, Math.abs(q[0] * r[0] + q[1] * r[1] + q[2] * r[2]) / (depth * t * aspect), Math.abs(q[0] * u[0] + q[1] * u[1] + q[2] * u[2]) / (depth * t));
      }
      if (m > 0.84) lo = d; else hi = d;
    }
    const d = hi;
    return { eye: [c[0] - f[0] * d, c[1] - f[1] * d, c[2] - f[2] * d] as V3, target: c };
  };
  for (const k of Object.keys(views)) delete views[k];
  for (const [k, dir] of Object.entries(presets)) views[k] = fit(dir);
}
const jobs: { view: string; variant: string; out: string; jitter?: [number, number]; id?: boolean }[] = [];
const hasMaps = !!(maps && maps !== '-');
for (const v of STUDIO ? [] : Object.keys(views)) {
  const vs = ['high', 'lowflat', ...(hasMaps ? ['low', 'lowfair'] : [])];
  if (hasMaps && (v === 'chest' || v === 'knee')) vs.push('lownormal');
  if (BEFORE && (v === 'chest' || v === 'knee' || v === 'grazing' || v === 'rim')) vs.push('lowbefore', 'lowbeforenormal', ...(v === 'rim' ? ['lownormal'] : []));
  for (const variant of vs) jobs.push({ view: v, variant, out: `${v}-${variant}` });
  jobs.push({ view: v, variant: 'high', out: `${v}-high-id`, id: true });
  jobs.push({ view: v, variant: hasMaps ? 'low' : 'lowflat', out: `${v}-low-id`, id: true });
}
if (STUDIO) {
  for (const v of Object.keys(views)) for (const variant of ['high', ...(hasMaps ? ['low'] : [])]) jobs.push({ view: v, variant, out: `studio/${v}-${variant}` });
  for (const s of ['form', 'bevel', 'panels', 'vents', 'fasteners', 'hydraulics']) jobs.push({ view: 'three-quarter', variant: `high-${s}`, out: `studio/step-${s}` });
  jobs.push({ view: 'three-quarter', variant: 'lowflat', out: 'studio/step-lowflat' });
}
for (const s of STUDIO ? [] : ['form', 'bevel', 'panels', 'vents', 'fasteners', 'hydraulics']) jobs.push({ view: 'front', variant: `high-${s}`, out: `step-${s}` });
for (const s of STUDIO ? [] : ['form', 'bevel', 'panels', 'vents', 'fasteners', 'hydraulics']) jobs.push({ view: 'chest', variant: `high-${s}`, out: `step-chest-${s}` });
if (hasMaps && !STUDIO) for (const j of ['00', '10', '01', '11']) for (const variant of ['high', 'lowfair', 'lowmip']) jobs.push({ view: 'far', variant, out: `far-${variant === 'lowfair' ? 'low' : variant}-j${j}`, jitter: [Number(j[0]) * 0.5, Number(j[1]) * 0.5] });
if (hasMaps && !STUDIO) for (const v of ['far', 'front']) jobs.push({ view: v, variant: 'lowmip', out: `${v}-lowmip` });
// Presentation turntable: a fixed distance that frames the worst azimuth at 84 %, so the subject does not breathe.
const ttView = (a: number): { eye: V3; target: V3 } => {
  const c = views['three-quarter']!.target;
  const dist = Math.max(...['three-quarter', 'front', 'side', 'rear'].map((k) => Math.hypot(...views[k]!.eye.map((v, i) => v - c[i]!))));
  return { eye: [c[0] + dist * Math.sin(a), c[1] + dist * 0.12, c[2] + dist * Math.cos(a)], target: c };
};
// Turntable: an orbit of TT frames, HIGH and LOW+maps (art) per frame.
for (let f = 0; f < TT; f++) {
  const a = (2 * Math.PI * f) / TT + 0.55;
  views[`tt${f}`] = STUDIO ? ttView(a) : { eye: [7.4 * Math.sin(a), 2.45, 7.4 * Math.cos(a)], target: [0, 1.75, 0] };
  for (const variant of STUDIO ? ['low'] : ['high', 'low']) jobs.push({ view: `tt${f}`, variant, out: `tt/${variant}-${String(f).padStart(3, '0')}` });
}
const scene = STUDIO ? {
  W: 1600, H: 1200, fov: STUDIO_FOV, clearColor: [0.1095, 0.1195, 0.1413, 1],
  meshes: ['high', 'low', ...['form', 'bevel', 'panels', 'vents', 'fasteners', 'hydraulics'].map((s) => `high-${s}`)],
  textures, materials, variants, views,
  jobs: only && only !== '-' ? jobs.filter((j) => new RegExp(only).test(j.out)) : jobs,
} : {
  W: 1280, H: 720, fov: 0.6283185307179586,
  backdrop: { center: [0, 0, 0], size: [1, 1], normal: [0, 0, 1], color: [0.012, 0.013, 0.017], intensity: 1 },
  floor: { size: 16, color: [0.006, 0.006, 0.007], roughness: 0.92 },
  skylight: 0.4,
  lights: [
    { direction: [0.55, -0.7, -0.45], color: [1, 0.9, 0.78], intensity: 4.2, shadow: true },
    { direction: [-0.7, -0.3, 0.65], color: [0.3, 0.8, 1], intensity: 4.4 },
    { direction: [0.75, -0.25, 0.6], color: [1, 0.48, 0.15], intensity: 3.1 },
  ],
  meshes: ['high', 'low', ...['form', 'bevel', 'panels', 'vents', 'fasteners', 'hydraulics'].map((s) => `high-${s}`)],
  textures, materials, variants, views,
  jobs: only && only !== '-' ? jobs.filter((j) => new RegExp(only).test(j.out)) : jobs,
};
writeFileSync(join(dir!, 'scene.json'), JSON.stringify(scene, null, 1));
console.log('jobs', scene.jobs.length);
