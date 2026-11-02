// C-403 bolts and rivets as a TRIM sheet: a rivet row along a lap seam (strip, periodic in u),
// hex bolts with washers on a flange bar (strip, periodic in u), a bolted flange ring (unique
// region) and a plain row, in one 512^2 atlas at 0.625 mm/texel. Split: the lap step and
// rivets (<= 3.5 mm) and all bolt heads/washers are baked; the flange bar (4 mm) and flange ring
// (6 mm) stay low geometry because they carry the silhouette at grazing angles.
// usage (cwd packages/modeling): tsx examples/tg-cases/c403.mts <outRoot> [spp=4]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { model, recipes, sel } from '@forgeax/engine-modeling';
import { bakeModule, type Dump, fromModel, History, merge, meshBytes, type Module, replicate, save, type Scene, translate, tris, verts, writeMaps, writeMesh } from './lib.mts';

const [outRoot, sppArg] = process.argv.slice(2);
const OUT = join(outRoot!, 'C-403'), SPP = Number(sppArg ?? 4) as 4;
const hist = new History('C-403', 'Bolts and rivets: trim strips + flange region');
const ATLAS = 512, MM = 0.32 / ATLAS; // 0.625 mm per texel
const TX = 0.32; // strip period (one atlas width)
const PBR = {
  paint: { color: [0.26, 0.29, 0.25] as [number, number, number], metallic: 0.25, roughness: 0.5 },
  steel: { color: [0.62, 0.62, 0.64] as [number, number, number], metallic: 1, roughness: 0.32 },
};
const ok = (r: { status: string; error?: unknown }, what: string, m?: { journal: readonly { op: string; status: string; error?: unknown }[] }) => { if (r.status !== 'ok') throw new Error(`${what}: ${JSON.stringify(r.error)} ${JSON.stringify(m?.journal.find((j) => j.status === 'failed'))}`); };

// ---- rivet seam strip (80 mm tall): lower plate z = 0 (y 0..40 mm), lap plate 1.5 mm (y 40..80 mm)
// with a chamfered lap edge, 8 domed rivets (head r 4.5 mm, 2 mm high) at 40 mm pitch, 12 mm above the edge
const rv = model();
let t0 = performance.now();
rv.plane({ width: TX, height: 0.04, center: [TX / 2, 0.02, 0], material: 'paint', tag: 'lower' });
rv.box({ size: [TX, 0.04, 0.0015], center: [TX / 2, 0.06, 0.00075], material: 'paint', tag: 'lap', label: 'lap' });
rv.delete(sel.tag('lap').and(sel.facing('-z', 5)));
rv.delete(sel.tag('lap').and(sel.facing('+x', 5).or(sel.facing('-x', 5))));
rv.delete(sel.tag('lap').and(sel.facing('+y', 5)));
rv.bevel(sel.tag('lap').and(sel.facing('-y', 5)).toEdges('touching').and(sel.tag('lap').and(sel.facing('+z', 5)).toEdges('touching')), { width: 0.0007, segments: 2, label: 'lap-edge' });
const dome: [number, number][] = [[0, 0.002]];
for (let i = 1; i <= 8; i++) { const a = (i / 8) * (Math.PI / 2); dome.push([0.0045 * Math.sin(a), 0.002 * Math.cos(a)]); }
dome.reverse();
rv.revolve({ points: dome, segments: 24, label: 'rivet', tag: 'rivet0', material: 'paint' });
rv.rotate(sel.tag('rivet0'), 'x', 90, [0, 0, 0]);
rv.translate(sel.tag('rivet0'), [0.02, 0.052, 0.0015]);
ok(rv.array(sel.tag('rivet0'), { linear: { count: 8, offset: [0.04, 0, 0] }, label: 'rivets' }), 'rivet array', rv);
const rivetTile = fromModel(rv, 'rivet-strip', { mode: 'autoSmooth', angle: 40 });
hist.step({ op: 'kernel: rivet seam strip', summary: 'plane + lap box (open faces deleted), lap edge bevel 0.7 mm, domed rivet revolve, rotate, translate, array x8 at 40 mm', stats: `${tris(rivetTile)} tris / 320 mm`, ms: Math.round(performance.now() - t0), kernel: History.journal(rv) });

// ---- bolt strip: the flange bar TOP (40 mm wide); 4 x M10 hex bolts + washers at 80 mm pitch
t0 = performance.now();
const bt = model();
const bolt = recipes.hexBolt({ size: 'M10', length: 0.016, name: 'bolt' });
const wsh = recipes.washer({ size: 'M10', name: 'washer' });
if (!bolt.ok || !wsh.ok) throw new Error('recipes');
const wt = wsh.value.dimensions.thickness!;
ok(bt.append(wsh.value.model, { translate: [0, 0, 0], tag: 'b0' }), 'washer', bt);
ok(bt.append(bolt.value.model, { translate: [0, wt, 0], tag: 'b0' }), 'bolt', bt);
bt.rotate(sel.tag('b0'), 'x', 90, [0, 0, 0]);
bt.planeCut({ point: [0, 0, 0.0002], normal: [0, 0, 1], keep: 'positive' }); // drop the hidden shank below the bar top
bt.translate(sel.tag('b0'), [0.04, 0.02, 0]);
ok(bt.array(sel.tag('b0'), { linear: { count: 4, offset: [0.08, 0, 0] }, label: 'bolts' }), 'bolt array', bt);
bt.plane({ width: TX, height: 0.04, center: [TX / 2, 0.02, 0], material: 'paint', tag: 'bar' });
const boltTile = fromModel(bt, 'bolt-strip', { mode: 'autoSmooth', angle: 40 });
hist.step({ op: 'kernel: bolt strip', summary: 'recipes.hexBolt M10 (chamfered hex, thread rings) + recipes.washer M10 appended, rotated to +Z, shank cut at the bar top (planeCut), array x4 at 80 mm on the bar top plane', stats: `${tris(boltTile)} tris / 320 mm`, ms: Math.round(performance.now() - t0), kernel: History.journal(bt) });

// ---- flange ring region (160 x 160 mm): ring top face at z = 0 with 8 x M8 bolts + washers on a 120 mm circle
t0 = performance.now();
const fl = model();
const ring = (r: number, n: number) => Array.from({ length: n }, (_, i) => [r * Math.cos((2 * Math.PI * i) / n), r * Math.sin((2 * Math.PI * i) / n)] as [number, number]);
const b8 = recipes.hexBolt({ size: 'M8', length: 0.012, name: 'fbolt' }), w8 = recipes.washer({ size: 'M8', name: 'fwasher' });
if (!b8.ok || !w8.ok) throw new Error('recipes');
const wt8 = w8.value.dimensions.thickness!;
ok(fl.append(w8.value.model, { tag: 'fb' }), 'w8', fl); ok(fl.append(b8.value.model, { translate: [0, wt8, 0], tag: 'fb' }), 'b8', fl);
fl.rotate(sel.tag('fb'), 'x', 90, [0, 0, 0]);
fl.planeCut({ point: [0, 0, 0.0002], normal: [0, 0, 1], keep: 'positive' });
fl.translate(sel.tag('fb'), [0.06, 0, 0]);
ok(fl.array(sel.tag('fb'), { radial: { count: 8, axis: 'z', center: [0, 0, 0] }, label: 'fbolts' }), 'radial', fl);
fl.extrudePolygon({ points: ring(0.075, 64), holes: [ring(0.045, 64)], depth: 0.006, label: 'ring', tag: 'ring', material: 'paint' });
fl.delete(sel.createdBy('ring', 'bottom'));
fl.bevel(sel.createdBy('ring', 'top').toEdges('touching').and(sel.createdBy('ring', 'side').or(sel.createdBy('ring', 'hole')).toEdges('touching')), { width: 0.0012, segments: 2, label: 'ring-chamfer' });
fl.translate(sel.tag('ring'), [0, 0, -0.006]);
fl.translate(sel.all(), [0.08, 0.08, 0]);
const flangeTile = fromModel(fl, 'flange', { mode: 'autoSmooth', angle: 40 });
hist.step({ op: 'kernel: bolted flange ring', summary: 'extrudePolygon ring (OD 150 / ID 90, 6 mm, 64 seg), top rims chamfered (bevel), M8 hexBolt + washer, radial array x8 on a 120 mm circle', stats: `${tris(flangeTile)} tris`, ms: Math.round(performance.now() - t0), kernel: History.journal(fl) });

// ---- bakes (strips periodic in u only). The atlas is one POM texture with one scale/bias, so
// every module bakes height into the union of the measured relief extents (z of each tile);
// per-module +-distance encodings would overstate the shallow rivets 2.4x under the shared scale.
const zExtent = (d: Dump): [number, number] => { let lo = 0, hi = 0; for (let i = 2; i < d.position.length; i += 3) { lo = Math.min(lo, d.position[i]!); hi = Math.max(hi, d.position[i]!); } return [lo, hi]; };
const extents = { rivets: zExtent(rivetTile), bolts: zExtent(boltTile), flange: zExtent(flangeTile) };
const HR: [number, number] = [Math.min(...Object.values(extents).map((e) => e[0])), Math.max(...Object.values(extents).map((e) => e[1]))];
const mods: Module[] = [
  { name: 'rivets', heightRange: HR, tile: rivetTile, tx: TX, ty: 0.08, w: 512, h: 128, z0: 0, distance: 0.005, aoDistance: 0.006, periodic: 'x', spp: SPP, pbr: PBR },
  { name: 'bolts', heightRange: HR, tile: boltTile, tx: TX, ty: 0.04, w: 512, h: 64, z0: 0, distance: 0.012, aoDistance: 0.01, periodic: 'x', spp: SPP, pbr: PBR },
  { name: 'flange', heightRange: HR, tile: flangeTile, tx: 0.16, ty: 0.16, w: 256, h: 256, z0: 0, distance: 0.012, aoDistance: 0.01, periodic: 'none', spp: SPP, pbr: PBR },
];
const bakes: Record<string, Awaited<ReturnType<typeof bakeModule>>> = {};
for (const m of mods) {
  bakes[m.name] = await bakeModule(m, join(OUT, 'maps', m.name));
  const b = bakes[m.name]!;
  hist.step({ op: `bake: ${m.name}`, summary: `kernel bakeMaps, ${m.periodic === 'x' ? 'centre of 3 copies along u (periodic in u)' : 'single region'}; ${b.tile.w}x${b.tile.h}, ${SPP} spp`, stats: `${b.bakeMs} ms, ${b.detailTris} detail tris, seam u ${(b.seams.ao as { u: { ratio: number } }).u.ratio} (AO)`, ms: b.bakeMs, image: `maps/${m.name}/normal.png` });
  console.log(m.name, b.bakeMs, JSON.stringify(b.seams));
}
// ---- atlas assembly: rows 0-127 rivets, 128-191 bolts, 192-255 plain, [256,512) x [0,256) flange, rest plain
const rd = (n: string, k: string) => new Uint8Array(PNG.sync.read(readFileSync(join(OUT, 'maps', n, `${k}.png`))).data);
const atlas: Record<string, Uint8Array> = {};
const plainPx: Record<string, number[]> = { normal: [128, 128, 255, 255], ao: [255, 255, 255, 255], height: Array(3).fill(Math.round((255 * -HR[0]) / (HR[1] - HR[0]))).concat(255), curvature: [128, 128, 128, 255], materialId: [0, 0, 0, 255], albedo: [...PBR.paint.color.map((c) => Math.round((c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055) * 255)), 255], orm: [255, Math.round(PBR.paint.roughness * 255), Math.round(PBR.paint.metallic * 255), 255] };
for (const k of ['normal', 'ao', 'height', 'albedo', 'orm']) {
  const img = new Uint8Array(ATLAS * ATLAS * 4);
  for (let i = 0; i < ATLAS * ATLAS; i++) img.set(plainPx[k]!, i * 4);
  const put = (src: Uint8Array, w: number, h: number, x0: number, y0: number) => { for (let y = 0; y < h; y++) img.set(src.subarray(y * w * 4, (y + 1) * w * 4), ((y0 + y) * ATLAS + x0) * 4); };
  put(rd('rivets', k), 512, 128, 0, 0); put(rd('bolts', k), 512, 64, 0, 128); put(rd('flange', k), 256, 256, 0, 256);
  atlas[k] = img;
}
const atlasBytes = await writeMaps(join(OUT, 'maps', 'atlas'), ATLAS, ATLAS, atlas, { normal: 'linear', albedo: 'srgb', orm: 'linear' });
save(join(OUT, 'maps', 'atlas', 'bake.json'), { heightRange: HR, extents });
hist.step({ op: 'trim atlas', summary: 'rows 0-127 rivet strip, 128-191 bolt strip (both wrap in u across the full width), 192-255 plain, flange 256x256 at [0,256), rest plain', stats: `512^2, ${(MM * 1000).toFixed(3)} mm/texel; KTX2 UASTC ${atlasBytes.totals.uastc} B, ETC1S ${atlasBytes.totals.etc1s} B`, image: 'maps/atlas/normal.png' });

// ---- panel 1.28 x 0.9 m facing +Z. Lower plate y 0..0.6 (z 0), lap plate y 0.6..0.9 (z 1.5 mm),
// flange bar y 0.20..0.24 (4 mm, x full width), flange ring centred (0.35, 0.40)
const X0 = -0.64, PW = 1.28;
const Y_SEAM = 0.56, Y_BAR = 0.2, BAR_H = 0.004, FC: [number, number] = [0.35, 0.4];
const plate = (x0: number, x1: number, y0: number, y1: number, z: number): Dump => {
  const m = model();
  m.plane({ width: x1 - x0, height: y1 - y0, center: [(x0 + x1) / 2, (y0 + y1) / 2, z], material: 'paint', tag: 'p' });
  return fromModel(m, 'plate', { mode: 'flat' });
};
// HIGH = the same detail sources placed on the panel + plain plates + bar sides
const barSides = (() => { const m = model(); m.box({ size: [PW, 0.04, BAR_H], center: [X0 + PW / 2, Y_BAR + 0.02, BAR_H / 2], material: 'paint', tag: 'b' }); m.delete(sel.tag('b').and(sel.facing('-z', 5).or(sel.facing('+z', 5)))); return fromModel(m, 'bar-sides', { mode: 'flat' }); })();
const highParts: Dump[] = [
  plate(X0, X0 + PW, 0, Y_BAR, 0), plate(X0, X0 + PW, Y_BAR + 0.04, Y_SEAM, 0),
  replicate(rivetTile, 4, 1, TX, 0, X0, Y_SEAM),
  plate(X0, X0 + PW, Y_SEAM + 0.08, 0.9, 0.0015),
  barSides, translate(replicate(boltTile, 4, 1, TX, 0, X0, Y_BAR), [0, 0, BAR_H]),
  translate(flangeTile, [FC[0] - 0.08, FC[1] - 0.08, 0.006]),
];
// flange ring sides + chamfer region come from the flange tile (it includes the ring); the ring stands on the plate
const high = merge(highParts);

// LOW: plates + strip quads + bar box + flange ring (32 segments), every face uv-mapped into the atlas
const uvPlain = (d: Dump): Dump => { const uv = new Float32Array(verts(d) * 2); for (let i = 0; i < verts(d); i++) { uv[i * 2] = 0.1 + d.position[i * 3]! * 0.3 + d.position[i * 3 + 2]! * 0.3; uv[i * 2 + 1] = (200 + (d.position[i * 3 + 1]! * 0.4 + d.position[i * 3 + 2]! * 0.4) * 40) / ATLAS; } return { ...d, uv }; };
const uvRect = (d: Dump, x0: number, y0: number, sx: number, sy: number, u0: number, v0: number, du: number, dv: number): Dump => { const uv = new Float32Array(verts(d) * 2); for (let i = 0; i < verts(d); i++) { uv[i * 2] = u0 + ((d.position[i * 3]! - x0) / sx) * du; uv[i * 2 + 1] = v0 + ((d.position[i * 3 + 1]! - y0) / sy) * dv; } return { ...d, uv }; };
const lowRing = (() => { const m = model(); m.extrudePolygon({ points: ring(0.075, 32), holes: [ring(0.045, 32)], depth: 0.006, label: 'r', tag: 'r', material: 'paint' }); m.delete(sel.createdBy('r', 'bottom')); return translate(fromModel(m, 'lring', { mode: 'flat' }), [FC[0], FC[1], 0]); })();
const splitTop = (d: Dump) => { // top (+z) triangles vs others
  const top: number[] = [], rest: number[] = [];
  for (let t = 0; t < d.indices.length; t += 3) { const a = d.indices[t]!; (d.normal[a * 3 + 2]! > 0.9 ? top : rest).push(d.indices[t]!, d.indices[t + 1]!, d.indices[t + 2]!); }
  const mk = (idx: number[]): Dump => ({ ...d, indices: new Uint32Array(idx), submeshes: [{ indexOffset: 0, indexCount: idx.length, materialSlot: 0 }], slots: [d.slots[0]!] });
  return { top: mk(top), rest: mk(rest) };
};
const lr = splitTop(lowRing);
const lowBar = (() => { const m = model(); m.box({ size: [PW, 0.04, BAR_H], center: [X0 + PW / 2, Y_BAR + 0.02, BAR_H / 2], material: 'paint', tag: 'b' }); m.delete(sel.tag('b').and(sel.facing('-z', 5))); return splitTop(fromModel(m, 'lbar', { mode: 'flat' })); })();
const lowPlate = (y0: number, y1: number, z: number) => plate(X0, X0 + PW, y0, y1, z);
// half-texel inset of the strips in v: without it the repeat sampler blends row 0 with row 511
// (the opposite atlas edge) and the bolt strip with its neighbours (seen in renders/near-low-wrapbleed.png)
const IN = 0.5 / ATLAS;
const lowParts: Dump[] = [
  uvPlain(lowPlate(0, Y_BAR, 0)), uvPlain(lowPlate(Y_BAR + 0.04, Y_SEAM, 0)), uvPlain(lowPlate(Y_SEAM + 0.08, 0.9, 0.0015)),
  uvRect(lowPlate(Y_SEAM, Y_SEAM + 0.08, 0), X0, Y_SEAM, TX, 0.08, 0, IN, 1, (128 - 2 * IN * ATLAS) / ATLAS),
  uvRect(lowBar.top, X0, Y_BAR, TX, 0.04, 0, 128 / ATLAS + IN, 1, (64 - 2 * IN * ATLAS) / ATLAS), uvPlain(lowBar.rest),
  uvRect(lr.top, FC[0] - 0.08, FC[1] - 0.08, 0.16, 0.16, 0, 256 / ATLAS, 0.5, 0.5), uvPlain(lr.rest),
];
const low = merge(lowParts.map((d) => ({ ...d, slots: ['trim'] })));
const MD = join(OUT, 'meshes');
const mm = { high: writeMesh(MD, 'high', high), low: writeMesh(MD, 'low', low) };

const scene: Scene = {
  W: 1280, H: 720, fov: Math.PI / 5, meshes: ['high', 'low'],
  textures: { atlas: { w: ATLAS, h: ATLAS, dir: join(OUT, 'maps', 'atlas') } },
  materials: { paint: { ...PBR.paint }, steel: { ...PBR.steel }, trim: { color: [1, 1, 1], metallic: 1, roughness: 1, maps: 'atlas' }, 'trim-flat': { ...PBR.paint } },
  variants: {
    high: [{ mesh: 'high', materials: high.slots.map((s) => s) }],
    low: [{ mesh: 'low', materials: ['trim'] }], lowflat: [{ mesh: 'low', materials: ['trim-flat'] }], lowmip: [{ mesh: 'low', materials: ['trim@mip'] }],
  },
  views: {
    near: { eye: [0.05, 0.62, 1.0], target: [0.05, 0.42, 0] },
    mid: { eye: [1.2, 1.7, 4.7], target: [0.0, 0.45, 0] },
    far: { eye: [5.5, 6.5, 23.5], target: [0.0, 0.45, 0] },
    grazing: { eye: [1.55, 0.47, 0.32], target: [0.3, 0.4, 0] },
  },
  jobs: [],
};
for (const v of Object.keys(scene.views)) for (const vr of ['high', 'low', 'lowflat']) scene.jobs.push({ view: v, variant: vr, out: `${v}-${vr}` });
for (const v of Object.keys(scene.views)) for (const vr of ['high', 'low']) scene.jobs.push({ view: v, variant: vr, out: `${v}-${vr}-id`, id: true });
for (const vr of ['high', 'low', 'lowmip']) for (const [i, j] of [[0, 0], [0.5, 0], [0, 0.5], [0.5, 0.5]] as const) scene.jobs.push({ view: 'far', variant: vr, out: `far-${vr}-j${i * 2}${j * 2}`, jitter: [i, j] });
scene.jobs.push({ view: 'mid', variant: 'lowmip', out: 'mid-lowmip' }, { view: 'near', variant: 'lowmip', out: 'near-lowmip' });
save(join(OUT, 'scene.json'), scene);
const detailTris = tris(replicate(rivetTile, 4, 1, TX, 0)) + tris(replicate(boltTile, 4, 1, TX, 0)) + tris(flangeTile);
save(join(OUT, 'facts.json'), {
  case: 'C-403', spp: SPP, atlas: { size: ATLAS, mmPerTexel: MM * 1000, bytes: atlasBytes },
  modules: { rivets: { tris: tris(rivetTile), period: TX }, bolts: { tris: tris(boltTile), period: TX }, flange: { tris: tris(flangeTile) } },
  panels: { panel: { module: 'atlas', highTris: tris(high), lowTris: tris(low), highBytes: meshBytes(high), lowBytes: meshBytes(low), detailTrisReplaced: detailTris } },
  bakes: { ...bakes, atlas: { bytes: atlasBytes } }, meshes: mm,
});
save(join(OUT, 'history.partial.json'), hist.steps);
console.log(JSON.stringify({ high: tris(high), low: tris(low), atlas: atlasBytes.totals }));
