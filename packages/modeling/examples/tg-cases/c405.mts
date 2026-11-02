// C-405 woven fabric: plain weave and 2/2 twill from swept yarns (catmull-rom over/under paths,
// flat elliptic sections), cut to one exact period, baked TILEABLE; applied to two banners whose
// shape (a gentle curve) stays geometry. Coarse 8 mm yarn pitch (heavy webbing) to keep the HIGH
// render geometry tractable.
// usage (cwd packages/modeling): tsx examples/tg-cases/c405.mts <outRoot> [spp=4]
import { join } from 'node:path';
import { model, path, sel } from '@forgeax/engine-modeling';
import { PNG } from 'pngjs';
import { readFileSync } from 'node:fs';
import { shiftCompare, shiftedBake, bakeModule, fromModel, grid, History, merge, meshBytes, type Module, planarUv, replicate, save, type Scene, translate, tris, wrapCylinder, writeMesh } from './lib.mts';

const [outRoot, sppArg] = process.argv.slice(2);
const OUT = join(outRoot!, 'C-405'), SPP = Number(sppArg ?? 4) as 4;
const hist = new History('C-405', 'Woven fabric: plain weave and twill');
const S = 0.008, A = 0.00055, YW = 0.0076, YT = 0.0014;
const ell = Array.from({ length: 8 }, (_, i) => [(YW / 2) * Math.cos((2 * Math.PI * i) / 8), (YT / 2) * Math.sin((2 * Math.PI * i) / 8)] as [number, number]);
/** One period of a weave: n warps (along Y) x n wefts (along X); warp j is over weft i when over(i, j). */
function weave(n: number, over: (i: number, j: number) => boolean, slot: string) {
  const m = model(), T = n * S;
  for (let j = 0; j < n; j++) {
    const pts: [number, number, number][] = [];
    for (let i = -2; i < n + 2; i++) pts.push([(j + 0.5) * S, (i + 0.5) * S, over(((i % n) + n) % n, j) ? A : -A]);
    m.sweep({ profile: ell, path: path.catmullRom(pts, 3), frame: 'up', up: [0, 0, 1], caps: false, material: slot, tag: `warp${j}` });
  }
  for (let i = 0; i < n; i++) {
    const pts: [number, number, number][] = [];
    for (let j = -2; j < n + 2; j++) pts.push([(j + 0.5) * S, (i + 0.5) * S, over(i, ((j % n) + n) % n) ? -A : A]);
    m.sweep({ profile: ell, path: path.catmullRom(pts, 3), frame: 'up', up: [0, 0, 1], caps: false, material: slot, tag: `weft${i}` });
  }
  m.planeCut({ point: [0, 0, 0], normal: [0, 1, 0], keep: 'positive' });
  m.planeCut({ point: [0, T, 0], normal: [0, 1, 0], keep: 'negative' });
  m.planeCut({ point: [0, 0, 0], normal: [1, 0, 0], keep: 'positive' });
  m.planeCut({ point: [T, 0, 0], normal: [1, 0, 0], keep: 'negative' });
  return m;
}
let t0 = performance.now();
const pm = weave(2, (i, j) => (i + j) % 2 === 0, 'red');
const plain = fromModel(pm, 'plain', { mode: 'smooth' }, false);
hist.step({ op: 'kernel: plain weave period', summary: '2 warps + 2 wefts: sweep of an 8-point ellipse (7.6 x 1.4 mm) along catmull-rom over/under paths (+-0.55 mm), frame up +Z, 4 planeCuts to one 16 mm period', stats: `${tris(plain)} tris / period`, ms: Math.round(performance.now() - t0), kernel: History.journal(pm) });
t0 = performance.now();
const tm = weave(4, (i, j) => (((i - j) % 4) + 4) % 4 < 2, 'olive');
const twill = fromModel(tm, 'twill', { mode: 'smooth' }, false);
hist.step({ op: 'kernel: 2/2 twill period', summary: '4 warps + 4 wefts, warp j over weft i when (i - j) mod 4 < 2 (diagonal wale), same yarn sweep, 4 planeCuts to one 32 mm period', stats: `${tris(twill)} tris / period`, ms: Math.round(performance.now() - t0), kernel: History.journal(tm) });

const PBR = { red: { color: [0.42, 0.05, 0.035] as [number, number, number], metallic: 0, roughness: 0.85 }, olive: { color: [0.2, 0.22, 0.12] as [number, number, number], metallic: 0, roughness: 0.85 } };
const mods: Module[] = [
  { name: 'plain', tile: replicate(plain, 8, 8, 2 * S, 2 * S), tx: 16 * S, ty: 16 * S, w: 512, h: 512, z0: 0, distance: 0.002, aoDistance: 0.003, periodic: 'xy', spp: SPP, pbr: { red: PBR.red } },
  { name: 'twill', tile: replicate(twill, 4, 4, 4 * S, 4 * S), tx: 16 * S, ty: 16 * S, w: 512, h: 512, z0: 0, distance: 0.002, aoDistance: 0.003, periodic: 'xy', spp: SPP, pbr: { olive: PBR.olive } },
];
const bakes: Record<string, Awaited<ReturnType<typeof bakeModule>>> = {};
for (const m of mods) {
  bakes[m.name] = await bakeModule(m, join(OUT, 'maps', m.name));
  const b = bakes[m.name]!;
  hist.step({ op: `bake: ${m.name} (tileable)`, summary: 'kernel bakeMaps on the centre tile of a 3x3 periodic copy', stats: `${b.bakeMs} ms, ${b.detailTris} detail tris, ${b.tile.mmPerTexel.join(' x ')} mm/texel`, ms: b.bakeMs, image: `maps/${m.name}/normal.png` });
  console.log(m.name, b.bakeMs, JSON.stringify(b.seams.normal));
}
// seam falsifier on the twill (largest edge/interior ratio): bake with the origin shifted by half a tile
const tw = mods[1]!, sh = shiftedBake(tw.tile, tw);
const rdm = (k: string) => new Uint8Array(PNG.sync.read(readFileSync(join(OUT, 'maps/twill', `${k}.png`))).data);
const shiftTest = { module: 'twill', normal: shiftCompare(rdm('normal'), sh.normal, 512, 512, 3), ao: shiftCompare(rdm('ao'), sh.ao, 512, 512, 1), ms: Math.round(sh.ms) };
hist.step({ op: 'seam falsifier (shift test, twill)', summary: 'twill re-baked with the origin moved half a tile; mean abs texel difference in the 4-texel border band vs the rest', stats: JSON.stringify(shiftTest), data: shiftTest });
console.log('shift', JSON.stringify(shiftTest));
// banners 0.384 x 0.576 m (24 x 36 yarn pitches), curved around a vertical axis (R 0.6 m) = form geometry
const BW = 0.384, BH = 0.576, R = 0.6;
const curve = (d: ReturnType<typeof grid>, cx: number) => translate(wrapCylinder(translate(d, [-BW / 2, 0, 0]), R), [cx, 0.05, -R]);
const plainHigh = curve(replicate(plain, 24, 36, 2 * S, 2 * S), -0.22), twillHigh = curve(replicate(twill, 12, 18, 4 * S, 4 * S), 0.22);
const plainLow = curve(planarUv(grid(BW, BH, 24, 1, 1, 1, 'plain'), 16 * S, 16 * S), -0.22), twillLow = curve(planarUv(grid(BW, BH, 24, 1, 1, 1, 'twill'), 16 * S, 16 * S), 0.22);
const high = merge([plainHigh, twillHigh]), low = merge([plainLow, twillLow]);
const MD = join(OUT, 'meshes');
const mm = { high: writeMesh(MD, 'high', high), low: writeMesh(MD, 'low', low) };
const scene: Scene = {
  W: 1280, H: 720, fov: Math.PI / 5, meshes: ['high', 'low'],
  textures: { plain: { w: 512, h: 512, dir: join(OUT, 'maps/plain') }, twill: { w: 512, h: 512, dir: join(OUT, 'maps/twill') } },
  materials: { red: { ...PBR.red }, olive: { ...PBR.olive }, 'plain-maps': { color: [1, 1, 1], metallic: 1, roughness: 1, maps: 'plain' }, 'twill-maps': { color: [1, 1, 1], metallic: 1, roughness: 1, maps: 'twill' }, 'plain-flat': { ...PBR.red }, 'twill-flat': { ...PBR.olive } },
  variants: {
    high: [{ mesh: 'high', materials: high.slots }],
    low: [{ mesh: 'low', materials: low.slots.map((s) => `${s}-maps`) }],
    lowflat: [{ mesh: 'low', materials: low.slots.map((s) => `${s}-flat`) }],
    lowmip: [{ mesh: 'low', materials: low.slots.map((s) => `${s}-maps@mip`) }],
  },
  views: {
    near: { eye: [0.0, 0.42, 1.0], target: [0.0, 0.34, 0] },
    mid: { eye: [1.2, 1.4, 4.7], target: [0.0, 0.34, 0] },
    far: { eye: [5.5, 6.0, 23.5], target: [0.0, 0.34, 0] },
    grazing: { eye: [1.15, 0.36, 0.35], target: [0.15, 0.34, -0.03] },
  },
  jobs: [],
};
for (const v of Object.keys(scene.views)) for (const vr of ['high', 'low', 'lowflat']) scene.jobs.push({ view: v, variant: vr, out: `${v}-${vr}` });
for (const v of Object.keys(scene.views)) for (const vr of ['high', 'low']) scene.jobs.push({ view: v, variant: vr, out: `${v}-${vr}-id`, id: true });
for (const vr of ['high', 'low', 'lowmip']) for (const [i, j] of [[0, 0], [0.5, 0], [0, 0.5], [0.5, 0.5]] as const) scene.jobs.push({ view: 'far', variant: vr, out: `far-${vr}-j${i * 2}${j * 2}`, jitter: [i, j] });
scene.jobs.push({ view: 'mid', variant: 'lowmip', out: 'mid-lowmip' }, { view: 'near', variant: 'lowmip', out: 'near-lowmip' });
save(join(OUT, 'scene.json'), scene);
const P = (h: typeof high, l: typeof low) => ({ highTris: tris(h), lowTris: tris(l), highBytes: meshBytes(h), lowBytes: meshBytes(l) });
save(join(OUT, 'facts.json'), { case: 'C-405', spp: SPP, periods: { plain: tris(plain), twill: tris(twill) }, panels: { plain: P(plainHigh, plainLow), twill: P(twillHigh, twillLow) }, bakes, shiftTest, meshes: mm });
save(join(OUT, 'history.partial.json'), hist.steps);
console.log(JSON.stringify({ high: tris(high), low: tris(low) }));
void sel;
