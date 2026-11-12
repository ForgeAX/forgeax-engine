// C-401 ordered point arrays: diamond tread plate + perforated vent plate (hex hole array).
// High = kernel tiles (one period), harness repeats them into a super-tile and a 3x3 periodic
// bake neighbourhood; low = one quad per panel with tiling uv. Output: cases/C-401.
// usage (cwd packages/modeling): tsx examples/tg-cases/c401.mts <outRoot> [N=512] [spp=4] [control=1]
import { join } from 'node:path';
import { model, sel } from '@forgeax/engine-modeling';
import { readFileSync } from 'node:fs';
import { bakeModule, bakeTile, shiftCompare, shiftedBake, fromModel, grid, History, merge, type Module, planarUv, replicate, save, seam, type Scene, tris, writeMesh, meshBytes } from './lib.mts';

const [outRoot, nArg, sppArg, ctrlArg] = process.argv.slice(2);
const OUT = join(outRoot!, 'C-401'), N = Number(nArg ?? 512), SPP = Number(sppArg ?? 4) as 4;
const hist = new History('C-401', 'Ordered point arrays: tread plate + perforated vent');

// ---- tread plate: one 40 mm period, 4 tapered lozenges at +-45 deg on a plate quad
const T = 0.04, L = 0.026, Wd = 0.007, Hb = 0.0016;
const lens: [number, number][] = [];
for (let i = 0; i <= 12; i++) { const s = -1 + (2 * i) / 12; lens.push([(s * L) / 2, (Wd / 2) * (1 - s * s)]); }
for (let i = 11; i >= 1; i--) { const s = -1 + (2 * i) / 12; lens.push([(s * L) / 2, (-Wd / 2) * (1 - s * s)]); }
const tread = model();
let t0 = performance.now();
tread.plane({ width: T, height: T, center: [T / 2, T / 2, 0], material: 'steel', tag: 'plate' });
const spots: [number, number, number][] = [[0.25, 0.25, 45], [0.75, 0.25, -45], [0.25, 0.75, -45], [0.75, 0.75, 45]];
spots.forEach(([u, v, a], i) => {
  const k = `loz${i}`;
  tread.extrudePolygon({ points: lens, depth: Hb, label: k, tag: k, material: 'steel' });
  tread.delete(sel.createdBy(k, 'bottom'));
  tread.scale(sel.createdBy(k, 'top'), [0.82, 0.45, 1], [0, 0, Hb]);
  tread.rotate(sel.tag(k), 'z', a, [0, 0, 0]);
  tread.translate(sel.tag(k), [u * T, v * T, 0]);
});
const treadPeriod = fromModel(tread, 'tread-period');
const treadKernelMs = performance.now() - t0;
hist.step({ op: 'kernel: tread period', summary: 'plane 40 mm + 4 lens extrudePolygon (1.6 mm), bottom deleted, top scaled (taper), rotated +-45 deg, placed on a 2x2 grid', stats: `${tris(treadPeriod)} tris / period`, ms: Math.round(treadKernelMs), kernel: History.journal(tread) });

// ---- perforated vent: hex array, holes 10 mm at 15 mm pitch, plate 1.5 mm over a dark backing 8 mm below
const P = 0.015, Ph = P * Math.sqrt(3), R = 0.005, tP = 0.0015, back = -0.008;
const circle = (cx: number, cy: number, n = 20) => Array.from({ length: n }, (_, i) => [cx + R * Math.cos((2 * Math.PI * i) / n), cy + R * Math.sin((2 * Math.PI * i) / n)] as [number, number]);
const holes: [number, number][][] = [];
for (let j = -1; j <= 1; j++) for (let i = -1; i <= 2; i++) for (const [cx, cy] of [[P / 2 + i * P, Ph / 4 + j * Ph], [i * P, (3 * Ph) / 4 + j * Ph]] as const) {
  if (cx - R > -P + 1e-4 && cx + R < 2 * P - 1e-4 && cy - R > -Ph + 1e-4 && cy + R < 2 * Ph - 1e-4) holes.push(circle(cx, cy));
}
const vent = model();
t0 = performance.now();
vent.extrudePolygon({ points: [[-P, -Ph], [2 * P, -Ph], [2 * P, 2 * Ph], [-P, 2 * Ph]], holes, depth: tP, label: 'perf', tag: 'perf', material: 'paint' });
vent.translate(sel.tag('perf'), [0, 0, -tP]);
vent.delete(sel.createdBy('perf', 'bottom'));
vent.planeCut({ point: [0, 0, 0], normal: [1, 0, 0], keep: 'positive' });
vent.planeCut({ point: [P, 0, 0], normal: [1, 0, 0], keep: 'negative' });
vent.planeCut({ point: [0, 0, 0], normal: [0, 1, 0], keep: 'positive' });
vent.planeCut({ point: [0, Ph, 0], normal: [0, 1, 0], keep: 'negative' });
// The bake source is the perforated plate alone: its holes are see-through (opacity), so the
// height map encodes only the 1.5 mm plate relief and parallax never digs the 8 mm wells. The
// dark backing stays real geometry in both the high and the low render meshes.
const ventPlate = fromModel(vent, 'vent-plate');
vent.plane({ width: P, height: Ph, center: [P / 2, Ph / 2, back], material: 'dark', tag: 'backing' });
const ventPeriod = fromModel(vent, 'vent-period');
hist.step({ op: 'kernel: vent period', summary: 'extrudePolygon plate with 2 hex-array hole rows over a 3x3-period block, 4 planeCuts to one exact period (15 x 25.98 mm), backing plane 8 mm below', stats: `${tris(ventPeriod)} tris / period, ${holes.length} holes cut`, ms: Math.round(performance.now() - t0), kernel: History.journal(vent) });

// ---- super-tiles (one texture repeat): tread 4x4 periods = 160 mm; vent 9x5 periods = 135 x 129.9 mm
const treadTile = replicate(treadPeriod, 4, 4, T, T);
const ventTile = replicate(ventPlate, 9, 5, P, Ph);
const PBR = {
  steel: { color: [0.56, 0.57, 0.58] as [number, number, number], metallic: 1, roughness: 0.38 },
  paint: { color: [0.2, 0.23, 0.18] as [number, number, number], metallic: 0.2, roughness: 0.55 },
  dark: { color: [0.02, 0.02, 0.022] as [number, number, number], metallic: 0, roughness: 0.9 },
};
const mods: Module[] = [
  { name: 'tread', tile: treadTile, tx: 4 * T, ty: 4 * T, w: N, h: N, z0: 0, distance: 0.003, aoDistance: 0.004, periodic: 'xy', spp: SPP, pbr: { steel: PBR.steel } },
  { name: 'vent', tile: ventTile, tx: 9 * P, ty: 5 * Ph, w: N, h: N, z0: 0, distance: 0.0095, aoDistance: 0.008, periodic: 'xy', spp: SPP, pbr: { paint: PBR.paint }, opacity: true, heightRange: [-tP, 0] },
];
if (ctrlArg === 'shift') {
  // seam falsifier: periodic and non-periodic vent bakes vs a half-tile-shifted periodic reference
  const m = mods[1]!;
  const per = bakeTile(ventTile, m), non = bakeTile(ventTile, { ...m, periodic: 'none' }), sh = shiftedBake(ventTile, m);
  const cmp = (b: typeof per) => ({ ao: shiftCompare(b.ao, sh.ao, N, N, 1), height: shiftCompare(b.height, sh.height, N, N, 1), normal: shiftCompare(b.normal, sh.normal, N, N, 3) });
  const shiftTest = { module: 'vent', periodic: cmp(per), nonPeriodic: cmp(non), ms: Math.round(per.ms + non.ms + sh.ms) };
  const f = JSON.parse(readFileSync(join(OUT, 'facts.json'), 'utf8')); f.shiftTest = shiftTest; save(join(OUT, 'facts.json'), f);
  const h = JSON.parse(readFileSync(join(OUT, 'history.partial.json'), 'utf8'));
  h.push({ n: h.length + 1, op: 'seam falsifier (shift test)', summary: 'vent baked periodic, non-periodic, and with the origin shifted by half a tile; mean abs texel difference in the 4-texel border band vs the rest', stats: `AO band/rest periodic ${shiftTest.periodic.ao.ratio}, non-periodic ${shiftTest.nonPeriodic.ao.ratio}`, image: 'maps/vent/control-ao.png', data: shiftTest });
  save(join(OUT, 'history.partial.json'), h);
  console.log('shift', JSON.stringify(shiftTest));
  process.exit(0);
}
const bakes: Record<string, Awaited<ReturnType<typeof bakeModule>>> = {};
for (const m of mods) {
  bakes[m.name] = await bakeModule(m, join(OUT, 'maps', m.name));
  const b = bakes[m.name]!;
  hist.step({ op: `bake: ${m.name} (tileable)`, summary: `kernel bakeMaps on the centre super-tile of a 3x3 periodic copy (${b.detailTris} detail tris); maps normal/ao/height/curvature/materialId -> albedo + ORM; ${N}^2, ${SPP} spp`,
    stats: `${b.bakeMs} ms, ${b.tile.mmPerTexel.join(' x ')} mm/texel, seam ratio normal u ${(b.seams.normal as { u: { ratio: number } }).u.ratio} v ${(b.seams.normal as { v: { ratio: number } }).v.ratio}; KTX2 UASTC ${b.bytes.totals.uastc} B / ETC1S ${b.bytes.totals.etc1s} B`, ms: b.bakeMs, image: `maps/${m.name}/normal.png` });
  console.log(m.name, JSON.stringify({ ms: b.bakeMs, seams: b.seams, bytes: b.bytes.totals }));
}
// control: the same vent bake without the periodic neighbourhood (seam check falsifier; the vent
// holes cross the tile border, the tread lozenges do not)
let control: unknown;
if (ctrlArg !== '0') {
  const c = bakeTile(ventTile, { ...mods[1]!, periodic: 'none' });
  control = { bakeMs: Math.round(c.ms), normal: seam(c.normal, c.w, c.h), ao: seam(c.ao, c.w, c.h, 1), height: seam(c.height, c.w, c.h, 1) };
  const { savePng } = await import('./lib.mts');
  savePng(join(OUT, 'maps/vent/control-height.png'), c.height, c.w, c.h); savePng(join(OUT, 'maps/vent/control-ao.png'), c.ao, c.w, c.h);
  hist.step({ op: 'bake: vent control (non-periodic)', summary: 'same bake with only one super-tile as detail: falsifier for the seam metric', stats: JSON.stringify(control), image: 'maps/vent/control-ao.png' });
  console.log('control', JSON.stringify(control));
}

// ---- render meshes: two vertical panels facing +Z (Y up). tread x in [-0.82,-0.02], vent x in [0.02,0.80]
const MD = join(OUT, 'meshes');
const tX0 = -0.82, vX0 = 0.02;
const highTread = replicate(treadPeriod, 20, 20, T, T, tX0, 0);
const highVent = replicate(ventPeriod, 52, 30, P, Ph, vX0, 0);
const lowTread = planarUv(grid(20 * T, 20 * T, 1, 1, 1, 1, 'tread', tX0, 0), 4 * T, 4 * T, -tX0 / (4 * T));
const lowVent = planarUv(grid(52 * P, 30 * Ph, 1, 1, 1, 1, 'vent', vX0, 0), 9 * P, 5 * Ph, -vX0 / (9 * P));
const lowBacking = grid(52 * P, 30 * Ph, 1, 1, 1, 1, 'dark', vX0, 0, back);
const meshes = { high: merge([highTread, highVent]), low: merge([lowTread, lowVent, lowBacking]) };
const mm: Record<string, unknown> = {};
for (const [k, d] of Object.entries(meshes)) mm[k] = writeMesh(MD, k, d);

const tex = (n: string) => ({ w: N, h: N, dir: join(OUT, 'maps', n) });
const scene: Scene = {
  W: 1280, H: 720, fov: Math.PI / 5,
  meshes: ['high', 'low'],
  textures: { tread: tex('tread'), vent: tex('vent') },
  materials: {
    steel: { ...PBR.steel }, paint: { ...PBR.paint }, dark: { ...PBR.dark },
    'tread-maps': { color: [1, 1, 1], metallic: 1, roughness: 1, maps: 'tread' }, 'vent-maps': { color: [1, 1, 1], metallic: 1, roughness: 1, maps: 'vent', alphaCutoff: 0.5 },
    'tread-flat': { ...PBR.steel }, 'vent-flat': { ...PBR.paint },
  },
  variants: {
    high: [{ mesh: 'high', materials: ['steel', 'paint', 'dark'] }],
    low: [{ mesh: 'low', materials: ['tread-maps', 'vent-maps', 'dark'] }],
    lowflat: [{ mesh: 'low', materials: ['tread-flat', 'vent-flat', 'dark'] }],
    lowmip: [{ mesh: 'low', materials: ['tread-maps@mip', 'vent-maps@mip', 'dark'] }],
  },
  views: {
    near: { eye: [0.0, 0.62, 1.0], target: [0.0, 0.4, 0] },
    mid: { eye: [1.2, 1.7, 4.7], target: [0.0, 0.4, 0] },
    far: { eye: [5.5, 6.5, 23.5], target: [0.0, 0.4, 0] },
    grazing: { eye: [1.76, 0.5, 0.36], target: [0.41, 0.39, 0] },
  },
  jobs: [],
};
for (const v of Object.keys(scene.views)) for (const vr of ['high', 'low', 'lowflat']) { scene.jobs.push({ view: v, variant: vr, out: `${v}-${vr}` }); }
for (const v of Object.keys(scene.views)) for (const vr of ['high', 'low']) scene.jobs.push({ view: v, variant: vr, out: `${v}-${vr}-id`, id: true });
for (const vr of ['high', 'low', 'lowmip']) for (const [i, j] of [[0, 0], [0.5, 0], [0, 0.5], [0.5, 0.5]] as const) scene.jobs.push({ view: 'far', variant: vr, out: `far-${vr}-j${i * 2}${j * 2}`, jitter: [i, j] });
scene.jobs.push({ view: 'mid', variant: 'lowmip', out: 'mid-lowmip' }, { view: 'near', variant: 'lowmip', out: 'near-lowmip' });
save(join(OUT, 'scene.json'), scene);

const facts = {
  case: 'C-401', N, spp: SPP,
  periods: { tread: { tris: tris(treadPeriod), size: [T, T] }, vent: { tris: tris(ventPeriod), size: [P, Ph] } },
  superTiles: { tread: { periods: [4, 4], tris: tris(treadTile) }, vent: { periods: [9, 5], tris: tris(ventTile) } },
  panels: { tread: { periods: [20, 20], size: [0.8, 0.8], highTris: tris(highTread), lowTris: tris(lowTread), highBytes: meshBytes(highTread), lowBytes: meshBytes(lowTread) },
    vent: { periods: [52, 30], size: [52 * P, 30 * Ph], highTris: tris(highVent), lowTris: tris(lowVent), highBytes: meshBytes(highVent), lowBytes: meshBytes(lowVent) } },
  meshes: mm, bakes, control,
};
save(join(OUT, 'facts.json'), facts);
save(join(OUT, 'history.partial.json'), hist.steps);
console.log(JSON.stringify(facts.panels));
