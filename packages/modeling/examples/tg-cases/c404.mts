// C-404 engraving / incisions: V-groove panel lines (kernel panelLine -> mesh bake into a TRIM strip),
// the stencil code "F-01" engraved 1 mm (ANALYTIC stamp: kernel textRegion -> coverage -> height
// field -> normal + height-field AO, no high mesh needed; compared against a mesh bake of the real
// engraved geometry) and diamond knurling on a cylinder grip (ANALYTIC periodic height field, a
// TILEABLE texture wrapped 5x around the grip; compared against a mesh bake of kernel pyramids).
// usage (cwd packages/modeling): tsx examples/tg-cases/c404.mts <outRoot> [spp=4]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { coverage, model, sel, textRegion } from '@forgeax/engine-modeling';
import { PNG } from 'pngjs';
import { aoFromHeightField, bakeModule, bakeTile, type Dump, fromModel, grid, History, merge, meshBytes, type Module, normalFromHeightField, replicate, save, type Scene, srgb8, translate, tris, verts, wrapCylinder, writeMaps, writeMesh } from './lib.mts';

const [outRoot, sppArg] = process.argv.slice(2);
const OUT = join(outRoot!, 'C-404'), SPP = Number(sppArg ?? 4) as 4;
const hist = new History('C-404', 'Engraving: panel lines, stencil code, knurling');
const ATLAS = 512, TX = 0.32;
const PBR = {
  paint: { color: [0.3, 0.33, 0.36] as [number, number, number], metallic: 0.25, roughness: 0.5 },
  bare: { color: [0.66, 0.66, 0.68] as [number, number, number], metallic: 1, roughness: 0.35 },
  knurl: { color: [0.58, 0.58, 0.6] as [number, number, number], metallic: 1, roughness: 0.4 },
};
const angErr = (a: Uint8Array, b: Uint8Array) => { let s = 0, n = 0; const v: number[] = []; for (let i = 0; i < a.length; i += 4) { const p = [0, 1, 2].map((c) => a[i + c]! / 127.5 - 1), q = [0, 1, 2].map((c) => b[i + c]! / 127.5 - 1); const lp = Math.hypot(...p), lq = Math.hypot(...q); const d = Math.acos(Math.max(-1, Math.min(1, (p[0]! * q[0]! + p[1]! * q[1]! + p[2]! * q[2]!) / (lp * lq)))) * 180 / Math.PI; s += d; n++; v.push(d); } v.sort((x, y) => x - y); return { meanDeg: +(s / n).toFixed(2), p95Deg: +v[Math.floor(0.95 * (v.length - 1))]!.toFixed(2) }; };
const aoMae = (a: Uint8Array, b: Uint8Array) => { let s = 0; for (let i = 0; i < a.length; i += 4) s += Math.abs(a[i]! - b[i]!); return +(s / (a.length / 4)).toFixed(2); };

// ---- A. V-groove panel line strip: 320 x 40 mm, groove 3 mm wide 1.5 mm deep along x (mesh bake)
let t0 = performance.now();
const gm = model();
gm.plane({ width: TX, height: 0.04, heightSegments: 2, center: [TX / 2, 0.02, 0], material: 'paint', tag: 'g' });
gm.panelLine({ faces: sel.all(), point: [0, 0.02, 0], normal: [0, 1, 0] }, { width: 0.003, depth: 0.0015, profile: 'v', label: 'groove' });
const grooveTile = fromModel(gm, 'groove', { mode: 'autoSmooth', angle: 30 });
hist.step({ op: 'kernel: panel line strip', summary: 'plane 320 x 40 mm, panelLine by plane (V profile, 3 mm wide, 1.5 mm deep) along x', stats: `${tris(grooveTile)} tris`, ms: Math.round(performance.now() - t0), kernel: History.journal(gm) });
const grooveMod: Module = { name: 'groove', tile: grooveTile, tx: TX, ty: 0.04, w: 512, h: 64, z0: 0, distance: 0.003, aoDistance: 0.004, periodic: 'x', spp: SPP, pbr: { paint: PBR.paint } };
const grooveBake = await bakeModule(grooveMod, join(OUT, 'maps/groove'));
hist.step({ op: 'bake: groove strip (mesh, periodic in u)', summary: 'kernel bakeMaps, 3 copies along u', stats: `${grooveBake.bakeMs} ms`, ms: grooveBake.bakeMs, image: 'maps/groove/normal.png' });

// ---- B. stencil code "F-01", 60 mm cap height, engraved 1 mm square, region 320 x 160 mm (512 x 256 texels)
const RW = 0.32, RH = 0.16, TW = 512, TH = 256, DEPTH = 0.001;
t0 = performance.now();
const txt = textRegion('F-01', { height: 0.06, weight: 0.14, align: 'center' });
if (!txt.ok) throw new Error(JSON.stringify(txt.error));
const region = txt.value.region.map((s) => ({ outer: s.outer.map(([x, y]) => [x + RW / 2, y + RH / 2 - 0.03] as [number, number]), holes: (s.holes ?? []).map((h) => h.map(([x, y]) => [x + RW / 2, y + RH / 2 - 0.03] as [number, number])) }));
const cov = coverage(region, TW, TH, [0, 0, RW, RH], 4);
const hfText = new Float64Array(TW * TH);
for (let i = 0; i < hfText.length; i++) hfText[i] = -DEPTH * cov[i]!;
const tNormal = normalFromHeightField(hfText, TW, TH, RW, RH);
const tAo = aoFromHeightField(hfText, TW, TH, RW, RH, 0.003);
const analyticTextMs = performance.now() - t0;
hist.step({ op: 'analytic stamp: stencil text', summary: 'kernel textRegion("F-01", 60 mm, weight 0.14) -> kernel coverage (4x4 AA) -> height = -1 mm x coverage -> central-difference normal + height-field AO (16 dirs x 7 elevations, 3 mm); no high mesh, no rays', stats: `${region.length} shapes, ${Math.round(analyticTextMs)} ms`, ms: Math.round(analyticTextMs) });
// real engraved geometry (for the HIGH render and the mesh-bake comparison)
t0 = performance.now();
const tm = model();
tm.extrudePolygon({ points: [[0, 0], [RW, 0], [RW, RH], [0, RH]], holes: region.map((s) => s.outer), depth: DEPTH, label: 'plate', tag: 'tp', material: 'paint' });
region.forEach((s, i) => (s.holes ?? []).forEach((h, j) => tm.extrudePolygon({ points: h, depth: DEPTH, label: `island${i}-${j}`, tag: 'tp', material: 'paint' })));
tm.delete(sel.createdBy('plate', 'bottom'));
for (let i = 0; i < region.length; i++) for (let j = 0; j < (region[i]!.holes ?? []).length; j++) tm.delete(sel.createdBy(`island${i}-${j}`, 'bottom'));
tm.translate(sel.tag('tp'), [0, 0, -DEPTH]);
tm.plane({ width: RW, height: RH, center: [RW / 2, RH / 2, -DEPTH], material: 'bare', tag: 'floor' });
const textTile = fromModel(tm, 'text', { mode: 'autoSmooth', angle: 30 });
hist.step({ op: 'kernel: engraved stencil geometry', summary: 'extrudePolygon plate (1 mm) with the letter outlines as holes, letter counters as islands, floor plane (bare metal) 1 mm below', stats: `${tris(textTile)} tris`, ms: Math.round(performance.now() - t0), kernel: History.journal(tm) });
const textMeshBake = bakeTile(textTile, { tx: RW, ty: RH, w: TW, h: TH, z0: 0, spp: SPP, distance: 0.002, aoDistance: 0.003, periodic: 'none' });
const textCmp = { normal: angErr(tNormal, textMeshBake.normal), aoMae: aoMae(new Uint8Array(Array.from(tAo, (a) => Math.round(a * 255)).flatMap((g) => [g, g, g, 255])), textMeshBake.ao), meshBakeMs: Math.round(textMeshBake.ms), analyticMs: Math.round(analyticTextMs) };
hist.step({ op: 'compare: analytic stamp vs mesh bake (text)', summary: 'same region baked from the engraved geometry with kernel bakeMaps', stats: JSON.stringify(textCmp), image: 'maps/text/normal.png' });

// ---- C. diamond knurl: pyramids half-diagonal 2 mm (period 4 mm), 1 mm high; tile 8 x 8 periods = 32 mm, 256^2
const RK = 0.002, HK = 0.001, KT = 0.032, KN = 256;
t0 = performance.now();
const hfK = new Float64Array(KN * KN);
for (let y = 0; y < KN; y++) for (let x = 0; x < KN; x++) {
  const px = ((x + 0.5) / KN) * KT, py = ((y + 0.5) / KN) * KT;
  let h = 0;
  for (const [ox, oy] of [[0, 0], [RK, RK]] as const) { const dx = ((px - ox) % (2 * RK) + 2 * RK) % (2 * RK), dy = ((py - oy) % (2 * RK) + 2 * RK) % (2 * RK); const ex = Math.min(dx, 2 * RK - dx), ey = Math.min(dy, 2 * RK - dy); h = Math.max(h, HK * (1 - (ex + ey) / RK)); }
  hfK[y * KN + x] = h - HK / 2;
}
const kNormal = normalFromHeightField(hfK, KN, KN, KT, KT);
const kAoF = aoFromHeightField(hfK, KN, KN, KT, KT, 0.0015);
const analyticKnurlMs = performance.now() - t0;
hist.step({ op: 'analytic stamp: diamond knurl (tileable)', summary: 'height = max over the diamond lattice of 1 mm x (1 - L1 distance / 2 mm), periodic by construction -> normal + height-field AO (1.5 mm)', stats: `${KN}^2 over 32 mm (0.125 mm/texel), ${Math.round(analyticKnurlMs)} ms`, ms: Math.round(analyticKnurlMs) });
t0 = performance.now();
const km = model();
km.cone({ radius: RK, height: HK, radialSegments: 4, material: 'knurl', tag: 'k' });
km.delete(sel.tag('k').and(sel.facing('-y', 5)));
km.rotate(sel.tag('k'), 'x', 90, [0, 0, 0]);
km.translate(sel.tag('k'), [0, 0, HK / 2]);
km.array(sel.tag('k'), { linear: { count: 8, offset: [2 * RK, 0, 0] } });
km.array(sel.all(), { linear: { count: 8, offset: [0, 2 * RK, 0] } });
km.append(km.snapshot(), { translate: [RK, RK, 0] });
const knurlTile = translate(fromModel(km, 'knurl', { mode: 'autoSmooth', angle: 30 }), [0, 0, -HK / 2]);
hist.step({ op: 'kernel: knurl pyramids', summary: 'cone with 4 radial segments (a diamond pyramid, base deleted), rotated to +Z, array 8 x 8, appended to itself shifted by half a lattice step = 128 pyramids per 32 mm tile', stats: `${tris(knurlTile)} tris / tile`, ms: Math.round(performance.now() - t0), kernel: History.journal(km) });
const knurlMeshBake = bakeTile(knurlTile, { tx: KT, ty: KT, w: KN, h: KN, z0: 0, spp: SPP, distance: 0.0015, aoDistance: 0.0015, periodic: 'xy' });
const kAo8 = new Uint8Array(KN * KN * 4); kAoF.forEach((a, i) => { const g = Math.round(a * 255); kAo8.set([g, g, g, 255], i * 4); });
const knurlCmp = { normal: angErr(kNormal, knurlMeshBake.normal), aoMae: aoMae(kAo8, knurlMeshBake.ao), meshBakeMs: Math.round(knurlMeshBake.ms), analyticMs: Math.round(analyticKnurlMs) };
hist.step({ op: 'compare: analytic vs mesh bake (knurl)', summary: 'the same tile baked from the kernel pyramids (3x3 periodic)', stats: JSON.stringify(knurlCmp), image: 'maps/knurl/normal.png' });
// knurl maps (shipped: analytic)
const kHeight8 = new Uint8Array(KN * KN * 4); hfK.forEach((h, i) => { const g = Math.round((h / HK + 0.5) * 255); kHeight8.set([g, g, g, 255], i * 4); });
const kAlb = new Uint8Array(KN * KN * 4), kOrm = new Uint8Array(KN * KN * 4);
for (let i = 0; i < KN * KN; i++) { kAlb.set([...PBR.knurl.color.map(srgb8), 255], i * 4); kOrm.set([kAo8[i * 4]!, Math.round(PBR.knurl.roughness * 255), Math.round(PBR.knurl.metallic * 255), 255], i * 4); }
const knurlBytes = await writeMaps(join(OUT, 'maps/knurl'), KN, KN, { normal: kNormal, ao: kAo8, height: kHeight8, albedo: kAlb, orm: kOrm, meshbakeNormal: knurlMeshBake.normal, meshbakeAo: knurlMeshBake.ao }, { normal: 'linear', albedo: 'srgb', orm: 'linear' });

// ---- atlas: rows 0-63 groove strip, rows 64-319 text region, rows 320-511 plain
const rd = (n: string, k: string) => new Uint8Array(PNG.sync.read(readFileSync(join(OUT, 'maps', n, `${k}.png`))).data);
const tAo8 = new Uint8Array(TW * TH * 4); tAo.forEach((a, i) => { const g = Math.round(a * 255); tAo8.set([g, g, g, 255], i * 4); });
const tH8 = new Uint8Array(TW * TH * 4); hfText.forEach((h, i) => { const g = Math.round((0.5 + h / 0.004) * 255); tH8.set([g, g, g, 255], i * 4); });
const mix = (a: number, b: number, t: number) => Math.round(a + (b - a) * t);
const tAlb = new Uint8Array(TW * TH * 4), tOrm = new Uint8Array(TW * TH * 4);
for (let i = 0; i < TW * TH; i++) { const c = cov[i]!; tAlb.set([0, 1, 2].map((k) => mix(srgb8(PBR.paint.color[k]!), srgb8(PBR.bare.color[k]!), c)).concat(255), i * 4); tOrm.set([tAo8[i * 4]!, mix(PBR.paint.roughness * 255, PBR.bare.roughness * 255, c), mix(PBR.paint.metallic * 255, PBR.bare.metallic * 255, c), 255], i * 4); }
await writeMaps(join(OUT, 'maps/text'), TW, TH, { normal: tNormal, ao: tAo8, height: tH8, albedo: tAlb, orm: tOrm, meshbakeNormal: textMeshBake.normal, meshbakeAo: textMeshBake.ao }, {});
const plain: Record<string, number[]> = { normal: [128, 128, 255, 255], ao: [255, 255, 255, 255], height: [128, 128, 128, 255], albedo: [...PBR.paint.color.map(srgb8), 255], orm: [255, Math.round(PBR.paint.roughness * 255), Math.round(PBR.paint.metallic * 255), 255] };
const text: Record<string, Uint8Array> = { normal: tNormal, ao: tAo8, height: tH8, albedo: tAlb, orm: tOrm };
const atlas: Record<string, Uint8Array> = {};
for (const k of ['normal', 'ao', 'height', 'albedo', 'orm']) {
  const img = new Uint8Array(ATLAS * ATLAS * 4);
  for (let i = 0; i < ATLAS * ATLAS; i++) img.set(plain[k]!, i * 4);
  img.set(rd('groove', k), 0);
  img.set(text[k]!, 64 * ATLAS * 4);
  atlas[k] = img;
}
const atlasBytes = await writeMaps(join(OUT, 'maps/atlas'), ATLAS, ATLAS, atlas, { normal: 'linear', albedo: 'srgb', orm: 'linear' });
hist.step({ op: 'trim atlas', summary: 'rows 0-63 groove strip (mesh bake), 64-319 stencil region (analytic), 320-511 plain; 0.625 mm/texel', stats: `KTX2 UASTC ${atlasBytes.totals.uastc} B, ETC1S ${atlasBytes.totals.etc1s} B`, image: 'maps/atlas/normal.png' });

// ---- scene: panel x [-0.32, 0.32], y [0.2, 0.6] facing +Z; groove strips y [0.26,0.30] and [0.50,0.54];
// text region x [-0.16, 0.16], y [0.32, 0.48]; knurled grip along X at (0, 0.1, 0.05)
const plane = (x0: number, x1: number, y0: number, y1: number): Dump => { const m = model(); m.plane({ width: x1 - x0, height: y1 - y0, center: [(x0 + x1) / 2, (y0 + y1) / 2, 0], material: 'paint', tag: 'p' }); return fromModel(m, 'p', { mode: 'flat' }); };
const S1 = 0.26, S2 = 0.5, TY = 0.32;
const plainRects: [number, number, number, number][] = [[-0.32, 0.32, 0.2, S1], [-0.32, 0.32, S1 + 0.04, TY], [-0.32, 0.32, TY + RH, S2], [-0.32, 0.32, S2 + 0.04, 0.6], [-0.32, -0.16, TY, TY + RH], [0.16, 0.32, TY, TY + RH]];
const IN = 0.5 / ATLAS;
const uvRect = (d: Dump, x0: number, y0: number, sx: number, sy: number, u0: number, v0: number, du: number, dv: number): Dump => { const uv = new Float32Array(verts(d) * 2); for (let i = 0; i < verts(d); i++) { uv[i * 2] = u0 + ((d.position[i * 3]! - x0) / sx) * du; uv[i * 2 + 1] = v0 + ((d.position[i * 3 + 1]! - y0) / sy) * dv; } return { ...d, uv }; };
const uvPlain = (d: Dump) => uvRect(d, -1, 0, 4, 1, 0, 340 / ATLAS, 1, 140 / ATLAS);
// grip: R = 160 mm / 2 pi, 160 mm long, 5 x 5 knurl tiles; collars as geometry
const RG = 0.16 / (2 * Math.PI);
const toX = (d: Dump, c: [number, number, number]) => { const { tangent: _t, ...rest } = d; const t = { ...rest, position: d.position.slice(), normal: d.normal.slice() }; for (let i = 0; i < verts(d); i++) { const [x, y, z] = [d.position[i * 3]!, d.position[i * 3 + 1]!, d.position[i * 3 + 2]!]; t.position.set([y + c[0], -x + c[1], z + c[2]], i * 3); const [a, b, e] = [d.normal[i * 3]!, d.normal[i * 3 + 1]!, d.normal[i * 3 + 2]!]; t.normal.set([b, -a, e], i * 3); } return t as Dump; };
const collars = (() => { const m = model(); for (const y of [-0.004, 0.164]) m.cylinder({ radiusTop: RG + 0.003, radiusBottom: RG + 0.003, height: 0.008, radialSegments: 48, center: [0, y, 0], material: 'knurl', tag: `c${y}` }); return fromModel(m, 'col', { mode: 'autoSmooth', angle: 30 }); })();
const GC: [number, number, number] = [-0.08, 0.1, 0.05];
const gripHigh = toX(merge([wrapCylinder(translate(replicate(knurlTile, 5, 5, KT, KT), [0, 0, HK / 2]), RG), collars]), GC);
const gripLow = toX(merge([wrapCylinder(grid(0.16, 0.16, 64, 1, KT, KT, 'grip', 0, 0, HK / 2), RG), collars]), GC);
const textHigh = translate(textTile, [-0.16, TY, 0]);
const high = merge([...plainRects.map(([a, b, c, d]) => plane(a, b, c, d)), replicate(grooveTile, 2, 1, TX, 0, -0.32, S1), replicate(grooveTile, 2, 1, TX, 0, -0.32, S2), textHigh, gripHigh]);
const lowPanel = merge([
  ...plainRects.map(([a, b, c, d]) => uvPlain(plane(a, b, c, d))),
  uvRect(plane(-0.32, 0.32, S1, S1 + 0.04), -0.32, S1, TX, 0.04, 0, IN, 1, (64 - 1) / ATLAS),
  uvRect(plane(-0.32, 0.32, S2, S2 + 0.04), -0.32, S2, TX, 0.04, 0, IN, 1, (64 - 1) / ATLAS),
  uvRect(plane(-0.16, 0.16, TY, TY + RH), -0.16, TY, RW, RH, 0, 64 / ATLAS + IN, 1, (256 - 1) / ATLAS),
].map((d) => ({ ...d, slots: ['trim'] })));
const low = merge([lowPanel, gripLow]);
const MD = join(OUT, 'meshes');
const mm = { high: writeMesh(MD, 'high', high), low: writeMesh(MD, 'low', low) };
const scene: Scene = {
  W: 1280, H: 720, fov: Math.PI / 5, meshes: ['high', 'low'],
  textures: { atlas: { w: ATLAS, h: ATLAS, dir: join(OUT, 'maps/atlas') }, knurl: { w: KN, h: KN, dir: join(OUT, 'maps/knurl') } },
  materials: { paint: { ...PBR.paint }, bare: { ...PBR.bare }, knurl: { ...PBR.knurl }, trim: { color: [1, 1, 1], metallic: 1, roughness: 1, maps: 'atlas' }, grip: { color: [1, 1, 1], metallic: 1, roughness: 1, maps: 'knurl' }, 'trim-flat': { ...PBR.paint }, 'grip-flat': { ...PBR.knurl } },
  variants: {
    high: [{ mesh: 'high', materials: high.slots }],
    low: [{ mesh: 'low', materials: low.slots.map((s) => (s === 'trim' || s === 'grip' ? s : s)) }],
    lowflat: [{ mesh: 'low', materials: low.slots.map((s) => (s === 'trim' || s === 'grip' ? `${s}-flat` : s)) }],
    lowmip: [{ mesh: 'low', materials: low.slots.map((s) => (s === 'trim' || s === 'grip' ? `${s}@mip` : s)) }],
  },
  views: {
    near: { eye: [0.0, 0.45, 1.0], target: [0.0, 0.35, 0] },
    mid: { eye: [1.2, 1.5, 4.7], target: [0.0, 0.35, 0] },
    far: { eye: [5.5, 6.0, 23.5], target: [0.0, 0.35, 0] },
    grazing: { eye: [0.95, 0.4, 0.26], target: [-0.05, 0.4, 0] },
  },
  jobs: [],
};
for (const v of Object.keys(scene.views)) for (const vr of ['high', 'low', 'lowflat']) scene.jobs.push({ view: v, variant: vr, out: `${v}-${vr}` });
for (const v of Object.keys(scene.views)) for (const vr of ['high', 'low']) scene.jobs.push({ view: v, variant: vr, out: `${v}-${vr}-id`, id: true });
for (const vr of ['high', 'low', 'lowmip']) for (const [i, j] of [[0, 0], [0.5, 0], [0, 0.5], [0.5, 0.5]] as const) scene.jobs.push({ view: 'far', variant: vr, out: `far-${vr}-j${i * 2}${j * 2}`, jitter: [i, j] });
scene.jobs.push({ view: 'mid', variant: 'lowmip', out: 'mid-lowmip' }, { view: 'near', variant: 'lowmip', out: 'near-lowmip' });
scene.jobs.push({ view: 'grip', variant: 'high', out: 'grip-high' }, { view: 'grip', variant: 'low', out: 'grip-low' }, { view: 'grip', variant: 'lowflat', out: 'grip-lowflat' }, { view: 'grip', variant: 'high', out: 'grip-high-id', id: true }, { view: 'grip', variant: 'low', out: 'grip-low-id', id: true });
(scene.views as Record<string, unknown>).grip = { eye: [0.05, 0.2, 0.32], target: [0.0, 0.1, 0.05] };
save(join(OUT, 'scene.json'), scene);
const P = (h: Dump, l: Dump) => ({ highTris: tris(h), lowTris: tris(l), highBytes: meshBytes(h), lowBytes: meshBytes(l) });
const panelHigh = merge([...plainRects.map(([a, b, c, d]) => plane(a, b, c, d)), replicate(grooveTile, 2, 1, TX, 0, -0.32, S1), replicate(grooveTile, 2, 1, TX, 0, -0.32, S2), textHigh]);
save(join(OUT, 'facts.json'), { case: 'C-404', spp: SPP, panels: { panel: { ...P(panelHigh, lowPanel), module: 'atlas' }, grip: { ...P(gripHigh, gripLow), module: 'knurl' } }, bakes: { groove: grooveBake, atlas: { bytes: atlasBytes }, knurl: { bytes: knurlBytes, analyticMs: Math.round(analyticKnurlMs) } }, compare: { text: textCmp, knurl: knurlCmp }, meshes: mm });
save(join(OUT, 'history.partial.json'), hist.steps);
console.log(JSON.stringify({ textCmp, knurlCmp, high: tris(high), low: tris(low) }));
