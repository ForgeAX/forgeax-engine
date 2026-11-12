// C-406 surfaces formed by ropes: 3-strand laid rope (true 3D bake onto a cylinder band), cable
// coiled on a drum and friction tape wound on a pipe (bakes in the unwrapped flat domain, then the
// high source is wrapped exactly onto the cylinder for rendering). Low = cylinders with tiling uv
// along the length (u = full circumference, v = period along the axis).
// usage (cwd packages/modeling): tsx examples/tg-cases/c406.mts <outRoot> [spp=4]
import { join } from 'node:path';
import { model, path, sel } from '@forgeax/engine-modeling';
import { bake, crop, type Dump, fromModel, grid, History, merge, meshBytes, type Pbr, compose, rotY, save, type Scene, seam, transform, translate, tris, wrapCylinder, writeMaps, writeMesh, grey } from './lib.mts';

const [outRoot, sppArg] = process.argv.slice(2);
const OUT = join(outRoot!, 'C-406'), SPP = Number(sppArg ?? 4) as 4;
const hist = new History('C-406', 'Surfaces formed by ropes: laid rope, cable coil, taped pipe');
const circ = (r: number, n: number) => Array.from({ length: n }, (_, i) => [r * Math.cos((2 * Math.PI * i) / n), r * Math.sin((2 * Math.PI * i) / n)] as [number, number]);
const N = 512;
const PBR: Record<string, Pbr> = {
  hemp: { color: [0.52, 0.42, 0.27], metallic: 0, roughness: 0.88 },
  cable: { color: [0.05, 0.05, 0.055], metallic: 0, roughness: 0.55 },
  drum: { color: [0.55, 0.12, 0.08], metallic: 0.3, roughness: 0.5 },
  tape: { color: [0.11, 0.11, 0.1], metallic: 0, roughness: 0.8 },
  pipe: { color: [0.6, 0.6, 0.62], metallic: 1, roughness: 0.35 },
};
const results: Record<string, unknown> = {};
async function finishModule(name: string, b: ReturnType<typeof bake>, w: number, h: number, pbr: Record<string, Pbr>) {
  const c = (img: Uint8Array) => crop(img, N, 0, 0, w, h);
  const bb = { normal: c(b.normal), ao: c(b.ao), height: c(b.height), curvature: c(b.curvature), materialId: c(b.materialId), materials: b.materials, w, h };
  const { albedo, orm } = compose(bb, pbr);
  const seams = { normal: seam(bb.normal, w, h), ao: seam(bb.ao, w, h, 1), height: seam(bb.height, w, h, 1) };
  const bytes = await writeMaps(join(OUT, 'maps', name), w, h, { normal: bb.normal, ao: bb.ao, height: bb.height, curvature: bb.curvature, materialId: bb.materialId, albedo, orm }, { normal: 'linear', albedo: 'srgb', orm: 'linear' });
  return { bakeMs: Math.round(b.ms), seams, bytes, report: b.report, materials: b.materials, opacity: false };
}

// ---- 1. three-strand rope: R 15 mm, strands r 6.96 mm on a helix r 8.04 mm, lay pitch 100 mm (right lay)
const RS = 0.00696, RH = 0.00804, LAY = 0.1, RLOW = 0.0135;
let t0 = performance.now();
const rope = (turns: number, y0: number) => {
  const m = model();
  for (let i = 0; i < 3; i++) m.sweep({ profile: circ(RS, 14), path: path.helix({ radius: RH, pitch: LAY, turns, segments: 48, axis: 'y', center: [0, y0, 0], startAngle: i * 120 }), caps: false, material: 'hemp', tag: `strand${i}` });
  return m;
};
const ropeBakeModel = rope(1.4, -LAY / 3);
const ropeDetail = fromModel(ropeBakeModel, 'rope-src', { mode: 'smooth' }, false);
hist.step({ op: 'kernel: laid rope source', summary: '3 x sweep of a 6.96 mm circle along path.helix (r 8.04 mm, pitch 100 mm, startAngle 0/120/240 deg) = tangent strands of a 15 mm rope', stats: `${tris(ropeDetail)} tris for 1.4 lays`, ms: Math.round(performance.now() - t0), kernel: History.journal(ropeBakeModel) });
// base: cylinder band r 13.5 mm, one pattern period LAY / 3 along Y, u = angle, uv v spans h/N of the atlas
const RW = 512, RHt = 180, ropePeriod = LAY / 3;
const band = wrapCylinder(grid(2 * Math.PI * RLOW, ropePeriod, 32, 1, 2 * Math.PI * RLOW, ropePeriod / (RHt / N), 'base'), RLOW);
const rb = bake(band, ropeDetail, { N, spp: SPP, distance: 0.009, aoDistance: 0.006, baseNormals: 'smooth' });
// cyclic chart seam repair: the band's u seam is a chart border (reconstruction stops there and the
// smooth base normals split); bake again with the source turned 180 deg about the axis, roll that bake
// by half a width and blend it over the 12 texels around the seam
const rb2 = bake(band, transform(ropeDetail, rotY(180), [0, 0, 0]), { N, spp: SPP, distance: 0.009, aoDistance: 0.006, baseNormals: 'smooth' });
const seamBefore = seam(crop(rb.normal, N, 0, 0, RW, RHt), RW, RHt);
for (const k of ['normal', 'ao', 'height', 'curvature', 'materialId'] as const) {
  const a = rb[k], b = rb2[k];
  for (let y = 0; y < RHt; y++) for (let x = 0; x < RW; x++) {
    const d = Math.min(x, RW - 1 - x); if (d >= 12) continue;
    const t = d < 6 ? 1 : 1 - (d - 6) / 6, xs = (x + RW / 2) % RW;
    for (let c = 0; c < 4; c++) a[(y * N + x) * 4 + c] = Math.round(a[(y * N + x) * 4 + c]! * (1 - t) + b[(y * N + xs) * 4 + c]! * t);
  }
}
const seamRepair = { before: seamBefore.u, after: seam(crop(rb.normal, N, 0, 0, RW, RHt), RW, RHt).u, extraMs: Math.round(rb2.ms) };
console.log('rope seam', JSON.stringify(seamRepair));
results.rope = { ...(await finishModule('rope', rb, RW, RHt, { hemp: PBR.hemp! })), seamRepair };
hist.step({ op: 'bake: rope (cylinder band)', summary: 'kernel bakeMaps (search 9 mm: the valleys between touching strands reach r 4 mm) onto a 32-segment cylinder band r 13.5 mm, plus a second bake turned 180 deg to repair the cyclic u seam; one period (33.3 mm = lay / 3: the 3 strands repeat by pure translation); source spans 1.4 lays so the band sees its neighbours', stats: `${Math.round(rb.ms)} ms, ${RW}x${RHt}`, ms: Math.round(rb.ms), image: 'maps/rope/normal.png' });

// ---- 2. cable coil on a drum: drum R 200 mm, cable r 6 mm, pitch 12.5 mm; flat (unwrapped) domain:
// x around (C = 2 pi R), y along the axis; one turn is a straight diagonal cylinder
const RD = 0.2, RC = 0.006, CP = 0.0125, CC = 2 * Math.PI * RD;
const diag = (len: number, r: number, segs: number, slot: string, x0: number, y0: number, z: number, radial = 12) => {
  const m = model();
  const a = Math.atan2(CP, CC) * (180 / Math.PI);
  m.cylinder({ radiusTop: r, radiusBottom: r, height: len, radialSegments: radial, heightSegments: segs, openEnded: true, material: slot, tag: 'c' });
  m.rotate(sel.tag('c'), 'z', -(90 - a), [0, 0, 0]);
  const dir: [number, number] = [Math.cos((a * Math.PI) / 180), Math.sin((a * Math.PI) / 180)];
  m.translate(sel.tag('c'), [x0 + (dir[0] * len) / 2, y0 + (dir[1] * len) / 2, z]);
  return m;
};
t0 = performance.now();
const coilParts: Dump[] = [];
let coilJournal: unknown;
for (let k = -2; k <= 2; k++) { const m = diag(3.4 * Math.hypot(CC, CP), RC, Math.round(3.4 * 64), 'cable', -1.2 * CC, k * CP - 1.2 * CP, RC); coilParts.push(fromModel(m, 'coil', { mode: 'smooth' })); coilJournal ??= History.journal(m); }
const coilDetail = merge(coilParts);
hist.step({ op: 'kernel: cable coil source (unwrapped)', summary: 'cylinder r 6 mm (12 radial segs, 64 per turn) rotated to the helix slope atan(12.5 mm / 1.257 m), 5 parallel turns covering the 3x3 neighbourhood in the flat domain', stats: `${tris(coilDetail)} tris`, ms: Math.round(performance.now() - t0), kernel: coilJournal });
const CW = 512, CH = 64;
const cb = bake(grid(CC, CP, 1, 1, CC, CP / (CH / N), 'base', 0, 0, RC), coilDetail, { N, spp: SPP, distance: 0.007, aoDistance: 0.008 });
results.coil = await finishModule('coil', cb, CW, CH, { cable: PBR.cable! });
hist.step({ op: 'bake: coil (flat, periodic)', summary: 'base = one turn x one pitch (1.257 m x 12.5 mm) at the cable centre height; 512 x 64 (2.45 x 0.2 mm/texel: the pattern varies along the axis, drifts slowly around)', stats: `${Math.round(cb.ms)} ms`, ms: Math.round(cb.ms), image: 'maps/coil/normal.png' });

// ---- 3. friction tape on a pipe: pipe R 30 mm, tape 25 mm wide, 0.6 mm, pitch 12.5 mm (50 % overlap):
// a plane strip tilted across its width (shingle ramp 0.6 mm) and turned to the helix slope
const RP = 0.03, TP = 0.0125, TW = 0.025, TT = 0.0006, PC = 2 * Math.PI * RP;
const tapeStrip = (len: number, x0: number, y0: number) => {
  const m = model();
  const a = Math.atan2(TP, PC) * (180 / Math.PI);
  m.plane({ width: len, height: TW, widthSegments: Math.ceil(len / 0.006), material: 'tape', tag: 't' });
  m.rotate(sel.tag('t'), 'x', -Math.atan2(TT, TW) * (180 / Math.PI), [0, 0, 0]);
  m.rotate(sel.tag('t'), 'z', a, [0, 0, 0]);
  const dir: [number, number] = [Math.cos((a * Math.PI) / 180), Math.sin((a * Math.PI) / 180)];
  m.translate(sel.tag('t'), [x0 + (dir[0] * len) / 2, y0 + (dir[1] * len) / 2, TT]);
  return m;
};
t0 = performance.now();
const tapeParts: Dump[] = [];
let tapeJournal: unknown;
for (let k = -3; k <= 3; k++) { const m = tapeStrip(3.4 * Math.hypot(PC, TP), -1.2 * PC, k * TP - 1.2 * TP); tapeParts.push(fromModel(m, 'tape', { mode: 'flat' })); tapeJournal ??= History.journal(m); }
const tapeDetail = merge(tapeParts);
hist.step({ op: 'kernel: taped pipe source (unwrapped)', summary: 'plane strip 25 mm wide rotated about its length by atan(0.6/25) (shingle ramp) and about Z to the helix slope; 7 parallel turns (50 % overlap)', stats: `${tris(tapeDetail)} tris`, ms: Math.round(performance.now() - t0), kernel: tapeJournal });
const TWd = 512, THt = 64;
const tb = bake(grid(PC, TP, 1, 1, PC, TP / (THt / N), 'base', 0, 0, TT), tapeDetail, { N, spp: SPP, distance: 0.002, aoDistance: 0.002 });
results.tape = await finishModule('tape', tb, TWd, THt, { tape: PBR.tape! });
hist.step({ op: 'bake: tape (flat, periodic)', summary: 'base = one turn x one pitch (188.5 x 12.5 mm), 512 x 64 (0.37 x 0.2 mm/texel)', stats: `${Math.round(tb.ms)} ms`, ms: Math.round(tb.ms), image: 'maps/tape/normal.png' });

// ---- render meshes: everything along X (rotate the Y-axis builds by -90 deg about Z)
const toX = (d: Dump, c: [number, number, number]) => transform(d, [0, 1, 0, -1, 0, 0, 0, 0, 1], c); // (x,y,z) -> (y,-x,z): +Y axis becomes +X
void rotY;
// rope: 10 lays = 1.0 m
const ropeHighM = rope(10, -0.5);
const ropeHigh = toX(fromModel(ropeHighM, 'rope', { mode: 'smooth' }, false), [0, 0.62, 0]);
const ropeLow = toX(wrapCylinder(grid(2 * Math.PI * RLOW, 1.0, 32, 1, 2 * Math.PI * RLOW, ropePeriod, 'rope', 0, -0.5), RLOW), [0, 0.62, 0]);
// coil: 32 turns = 0.4 m; drum flanges as geometry in both
const TURNS = 32, LEN = TURNS * CP;
const coilHigh = (() => { const m = diag(TURNS * Math.hypot(CC, CP), RC, TURNS * 96, 'cable', 0, 0, RC); return fromModel(m, 'coilh', { mode: 'smooth' }); })();
const flanges = (() => { const m = model(); for (const y of [-0.005, LEN + 0.005]) m.cylinder({ radiusTop: 0.26, radiusBottom: 0.26, height: 0.01, radialSegments: 64, center: [0, y, 0], material: 'drum', tag: `f${y}` });
  m.cylinder({ radiusTop: RD, radiusBottom: RD, height: LEN, radialSegments: 96, openEnded: true, center: [0, LEN / 2, 0], material: 'drum', tag: 'core' }); return fromModel(m, 'fl', { mode: 'autoSmooth', angle: 30 }); })();
const drumHigh = toX(merge([wrapCylinder(coilHigh, RD), flanges]), [-0.25 - LEN / 2, 0.22, 0]);
const drumLow = toX(merge([wrapCylinder(grid(CC, LEN, 96, 1, CC, CP, 'coil', 0, 0, RC), RD), flanges]), [-0.25 - LEN / 2, 0.22, 0]);
// taped pipe: 32 turns = 0.4 m, pipe stubs 0.05 m bare at both ends
const tapeHighFlat = (() => { const m = tapeStrip(TURNS * Math.hypot(PC, TP), 0, -TW / 2 + TP); return fromModel(m, 'tapeh', { mode: 'flat' }); })();
const pipe = (() => { const m = model(); m.cylinder({ radiusTop: RP, radiusBottom: RP, height: LEN + 0.1, radialSegments: 48, center: [0, LEN / 2, 0], material: 'pipe', tag: 'p' }); return fromModel(m, 'pipe', { mode: 'autoSmooth', angle: 30 }); })();
const pipeHigh = toX(merge([wrapCylinder(tapeHighFlat, RP), pipe]), [0.35 - LEN / 2, 0.22, 0]);
const pipeLow = toX(merge([wrapCylinder(grid(PC, LEN, 48, 1, PC, TP, 'tape', 0, 0, TT), RP), pipe]), [0.35 - LEN / 2, 0.22, 0]);
const high = merge([ropeHigh, drumHigh, pipeHigh]), low = merge([ropeLow, drumLow, pipeLow]);
const MD = join(OUT, 'meshes');
const mm = { high: writeMesh(MD, 'high', high), low: writeMesh(MD, 'low', low) };
void translate; void grey;
const scene: Scene = {
  W: 1280, H: 720, fov: Math.PI / 5, meshes: ['high', 'low'],
  backdrop: { center: [0, 0, 0], size: [1, 1], normal: [0, 0, 1], color: [0.72, 0.75, 0.8], intensity: 1.1 },
  textures: { rope: { w: RW, h: RHt, dir: join(OUT, 'maps/rope') }, coil: { w: CW, h: CH, dir: join(OUT, 'maps/coil') }, tape: { w: TWd, h: THt, dir: join(OUT, 'maps/tape') } },
  materials: {
    ...Object.fromEntries(Object.entries(PBR).map(([k, p]) => [k, { ...p }])),
    'rope-maps': { color: [1, 1, 1], metallic: 1, roughness: 1, maps: 'rope' }, 'coil-maps': { color: [1, 1, 1], metallic: 1, roughness: 1, maps: 'coil' }, 'tape-maps': { color: [1, 1, 1], metallic: 1, roughness: 1, maps: 'tape' },
    'rope-flat': { ...PBR.hemp! }, 'coil-flat': { ...PBR.cable! }, 'tape-flat': { ...PBR.tape! },
  },
  variants: {
    high: [{ mesh: 'high', materials: high.slots }],
    low: [{ mesh: 'low', materials: low.slots.map((s) => (['rope', 'coil', 'tape'].includes(s) ? `${s}-maps` : s)) }],
    lowflat: [{ mesh: 'low', materials: low.slots.map((s) => (['rope', 'coil', 'tape'].includes(s) ? `${s}-flat` : s)) }],
    lowmip: [{ mesh: 'low', materials: low.slots.map((s) => (['rope', 'coil', 'tape'].includes(s) ? `${s}-maps@mip` : s)) }],
  },
  views: {
    near: { eye: [0.0, 0.5, 1.05], target: [0.0, 0.4, 0] },
    mid: { eye: [1.2, 1.5, 4.7], target: [0.0, 0.4, 0] },
    far: { eye: [5.5, 6.0, 23.5], target: [0.0, 0.4, 0] },
    grazing: { eye: [0.58, 0.62, 0.13], target: [0.1, 0.62, 0] },
    close: { eye: [0.0, 0.66, 0.3], target: [0.0, 0.62, 0] },
  },
  jobs: [],
};
for (const v of Object.keys(scene.views)) for (const vr of ['high', 'low', 'lowflat']) scene.jobs.push({ view: v, variant: vr, out: `${v}-${vr}` });
for (const v of Object.keys(scene.views)) for (const vr of ['high', 'low']) scene.jobs.push({ view: v, variant: vr, out: `${v}-${vr}-id`, id: true });
for (const vr of ['high', 'low', 'lowmip']) for (const [i, j] of [[0, 0], [0.5, 0], [0, 0.5], [0.5, 0.5]] as const) scene.jobs.push({ view: 'far', variant: vr, out: `far-${vr}-j${i * 2}${j * 2}`, jitter: [i, j] });
scene.jobs.push({ view: 'mid', variant: 'lowmip', out: 'mid-lowmip' }, { view: 'near', variant: 'lowmip', out: 'near-lowmip' });
save(join(OUT, 'scene.json'), scene);
const P = (h: Dump, l: Dump) => ({ highTris: tris(h), lowTris: tris(l), highBytes: meshBytes(h), lowBytes: meshBytes(l) });
const panels = { rope: P(ropeHigh, ropeLow), drum: { ...P(drumHigh, drumLow), module: 'coil' }, pipe: { ...P(pipeHigh, pipeLow), module: 'tape' } };
save(join(OUT, 'facts.json'), { case: 'C-406', spp: SPP, panels, bakes: results, meshes: mm, flangesTris: tris(flanges), pipeTris: tris(pipe) });
save(join(OUT, 'history.partial.json'), hist.steps);
console.log(JSON.stringify(panels), JSON.stringify(Object.fromEntries(Object.entries(results).map(([k, v]) => [k, (v as { bakeMs: number }).bakeMs]))));
