// C-402 nets (see-through): welded wire mesh, expanded-metal grating, chain-link. High = kernel
// periods (cylinders, tilted strand boxes, rounded zig-zag sweeps cut to one period); low = one
// quad per panel with tiling uv + opacity cutout (albedo.A, alphaCutoff 0.5). Bright backdrop.
// usage (cwd packages/modeling): tsx examples/tg-cases/c402.mts <outRoot> [spp=4]
import { join } from 'node:path';
import { model, path, sel } from '@forgeax/engine-modeling';
import { bakeModule, fromModel, grid, History, merge, meshBytes, type Module, planarUv, replicate, save, type Scene, tris, writeMesh } from './lib.mts';

const [outRoot, sppArg] = process.argv.slice(2);
const OUT = join(outRoot!, 'C-402'), SPP = Number(sppArg ?? 4) as 4;
const hist = new History('C-402', 'Nets: welded mesh, expanded metal, chain-link (opacity cutout)');
const circ = (r: number, n: number) => Array.from({ length: n }, (_, i) => [r * Math.cos((2 * Math.PI * i) / n), r * Math.sin((2 * Math.PI * i) / n)] as [number, number]);

// ---- welded wire mesh: 25 mm pitch, wire r 1.6 mm; x wires on top of y wires, touching (welded)
const WP = 0.025, WR = 0.0016;
let t0 = performance.now();
const wm = model();
wm.cylinder({ radiusTop: WR, radiusBottom: WR, height: WP, radialSegments: 12, openEnded: true, center: [WP / 2, WP / 2, -WR], material: 'galv', tag: 'wy' });
wm.cylinder({ radiusTop: WR, radiusBottom: WR, height: WP, radialSegments: 12, openEnded: true, center: [0, 0, 0], material: 'galv', tag: 'wx' });
wm.rotate(sel.tag('wx'), 'z', 90, [0, 0, 0]);
wm.translate(sel.tag('wx'), [WP / 2, WP / 2, WR]);
const welded = fromModel(wm, 'welded', { mode: 'smooth' });
hist.step({ op: 'kernel: welded mesh period', summary: '2 open cylinders (r 1.6 mm, 12 seg) exactly one 25 mm period long, x wire rotated and laid on the y wire', stats: `${tris(welded)} tris / period`, ms: Math.round(performance.now() - t0), kernel: History.journal(wm) });

// ---- expanded metal: diamond 40 x 20 mm, strands 3.5 x 1.5 mm tilted 30 deg about their axis
const EL = 0.04, ES = 0.02;
t0 = performance.now();
const em = model();
const segs: [number, number, number, number][] = [[0, 0, EL / 2, ES / 2], [EL / 2, ES / 2, EL, 0], [0, ES, EL / 2, ES / 2], [EL / 2, ES / 2, EL, ES]];
segs.forEach(([x0, y0, x1, y1], i) => {
  const k = `s${i}`, len = Math.hypot(x1 - x0, y1 - y0) + 0.0035;
  em.box({ size: [len, 0.0035, 0.0015], center: [0, 0, 0], material: 'paint', tag: k });
  em.rotate(sel.tag(k), 'x', 30, [0, 0, 0]);
  em.rotate(sel.tag(k), 'z', (Math.atan2(y1 - y0, x1 - x0) * 180) / Math.PI, [0, 0, 0]);
  em.translate(sel.tag(k), [(x0 + x1) / 2, (y0 + y1) / 2, 0]);
});
const expanded = fromModel(em, 'expanded', { mode: 'flat' });
hist.step({ op: 'kernel: expanded-metal period', summary: '4 strand boxes (3.5 x 1.5 mm) per 40 x 20 mm diamond, rotated 30 deg about the strand axis (the characteristic tilt), turned and placed node to node', stats: `${tris(expanded)} tris / period`, ms: Math.round(performance.now() - t0), kernel: History.journal(em) });

// ---- chain-link: diamond 50 mm, wire r 1.5 mm; two zig-zag wires per period that meet at the bends,
// z = -r at left bends and +r at right bends (over/under), corners rounded, swept, cut to one period
const CA = 0.025, CP = 0.05, CR = 0.0015;
t0 = performance.now();
const cl = model();
const zig = (xe: number, ze: number, xo: number, zo: number) => {
  const pts: [number, number, number][] = [];
  for (let k = -2; k <= 4; k++) pts.push(k % 2 === 0 ? [xe, (k * CP) / 2, ze] : [xo, (k * CP) / 2, zo]);
  return pts;
};
cl.sweep({ profile: circ(CR, 10), path: path.polyline(zig(0, -CR, CA, CR), { radius: 0.005, segments: 5 }), caps: false, material: 'galv', tag: 'w0' });
cl.sweep({ profile: circ(CR, 10), path: path.polyline(zig(2 * CA, CR, CA, -CR), { radius: 0.005, segments: 5 }), caps: false, material: 'galv', tag: 'w1' });
cl.planeCut({ point: [0, 0, 0], normal: [0, 1, 0], keep: 'positive' });
cl.planeCut({ point: [0, CP, 0], normal: [0, 1, 0], keep: 'negative' });
const chain = fromModel(cl, 'chain', { mode: 'smooth' }, false);
hist.step({ op: 'kernel: chain-link period', summary: '2 zig-zag polylines (bends rounded r 5 mm) swept with a 1.5 mm circle, over/under by z = -+r at the bends, 2 planeCuts to one 50 mm period', stats: `${tris(chain)} tris / period`, ms: Math.round(performance.now() - t0), kernel: History.journal(cl) });

const PBR = {
  galv: { color: [0.62, 0.63, 0.64] as [number, number, number], metallic: 1, roughness: 0.42 },
  paint: { color: [0.16, 0.18, 0.16] as [number, number, number], metallic: 0.3, roughness: 0.6 },
};
const mods: Module[] = [
  { name: 'welded', tile: replicate(welded, 8, 8, WP, WP), tx: 8 * WP, ty: 8 * WP, w: 512, h: 512, z0: 0, distance: 0.0045, aoDistance: 0.005, periodic: 'xy', spp: SPP, pbr: { galv: PBR.galv }, opacity: true },
  { name: 'expanded', tile: replicate(expanded, 5, 10, EL, ES), tx: 5 * EL, ty: 10 * ES, w: 512, h: 512, z0: 0, distance: 0.003, aoDistance: 0.004, periodic: 'xy', spp: SPP, pbr: { paint: PBR.paint }, opacity: true },
  { name: 'chain', tile: replicate(chain, 4, 4, 2 * CA, CP), tx: 8 * CA, ty: 4 * CP, w: 512, h: 512, z0: 0, distance: 0.0045, aoDistance: 0.005, periodic: 'xy', spp: SPP, pbr: { galv: PBR.galv }, opacity: true },
];
const bakes: Record<string, Awaited<ReturnType<typeof bakeModule>>> = {};
for (const m of mods) {
  bakes[m.name] = await bakeModule(m, join(OUT, 'maps', m.name));
  const b = bakes[m.name]!;
  hist.step({ op: `bake: ${m.name} (tileable + opacity)`, summary: `kernel bakeMaps on the centre tile of a 3x3 periodic copy; opacity = orthographic coverage of the high source along -Z (4x4 supersampled, wrapped) into albedo.A`, stats: `${b.bakeMs} ms, ${b.detailTris} detail tris, ${b.tile.mmPerTexel.join(' x ')} mm/texel, opacity seam u ${(b.seams.opacity as { u: { ratio: number } }).u.ratio}`, ms: b.bakeMs, image: `maps/${m.name}/opacity.png` });
  console.log(m.name, b.bakeMs, JSON.stringify(b.seams.opacity));
}

// ---- panels 0.6 x 0.6 m facing +Z, side by side
const xs = { welded: -0.98, expanded: -0.3, chain: 0.38 };
const per = { welded: [welded, WP, WP], expanded: [expanded, EL, ES], chain: [chain, 2 * CA, CP] } as const;
const highs = Object.entries(per).map(([k, [d, px, py]]) => replicate(d, Math.round(0.6 / px), Math.round(0.6 / py), px, py, xs[k as keyof typeof xs], 0));
const lows = mods.map((m) => planarUv(grid(0.6, 0.6, 1, 1, 1, 1, m.name, xs[m.name as keyof typeof xs], 0), m.tx, m.ty, -xs[m.name as keyof typeof xs] / m.tx));
const high = merge(highs), low = merge(lows);
const MD = join(OUT, 'meshes');
const mm = { high: writeMesh(MD, 'high', high), low: writeMesh(MD, 'low', low) };
const scene: Scene = {
  W: 1280, H: 720, fov: Math.PI / 5, meshes: ['high', 'low'],
  backdrop: { center: [0, 0, 0], size: [1, 1], normal: [0, 0, 1], color: [0.9, 0.92, 0.95], intensity: 1.6 },
  textures: Object.fromEntries(mods.map((m) => [m.name, { w: 512, h: 512, dir: join(OUT, 'maps', m.name) }])),
  materials: {
    galv: { ...PBR.galv }, paint: { ...PBR.paint },
    ...Object.fromEntries(mods.map((m) => [`${m.name}-maps`, { color: [1, 1, 1] as [number, number, number], metallic: 1, roughness: 1, maps: m.name, alphaCutoff: 0.5 }])),
    ...Object.fromEntries(mods.map((m) => [`${m.name}-flat`, { ...Object.values(m.pbr)[0]! }])),
  },
  variants: {
    high: [{ mesh: 'high', materials: high.slots }],
    low: [{ mesh: 'low', materials: low.slots.map((s) => `${s}-maps`) }],
    lowflat: [{ mesh: 'low', materials: low.slots.map((s) => `${s}-flat`) }],
    lowmip: [{ mesh: 'low', materials: low.slots.map((s) => `${s}-maps@mip`) }],
  },
  views: {
    near: { eye: [0.0, 0.42, 1.0], target: [0.0, 0.3, 0] },
    mid: { eye: [1.2, 1.4, 4.7], target: [0.0, 0.3, 0] },
    far: { eye: [5.5, 6.0, 23.5], target: [0.0, 0.3, 0] },
    grazing: { eye: [1.35, 0.35, 0.33], target: [0.05, 0.3, 0] },
  },
  jobs: [],
};
for (const v of Object.keys(scene.views)) for (const vr of ['high', 'low', 'lowflat']) scene.jobs.push({ view: v, variant: vr, out: `${v}-${vr}` });
for (const v of Object.keys(scene.views)) for (const vr of ['high', 'low']) scene.jobs.push({ view: v, variant: vr, out: `${v}-${vr}-id`, id: true });
for (const vr of ['high', 'low', 'lowmip']) for (const [i, j] of [[0, 0], [0.5, 0], [0, 0.5], [0.5, 0.5]] as const) scene.jobs.push({ view: 'far', variant: vr, out: `far-${vr}-j${i * 2}${j * 2}`, jitter: [i, j] });
scene.jobs.push({ view: 'mid', variant: 'lowmip', out: 'mid-lowmip' }, { view: 'near', variant: 'lowmip', out: 'near-lowmip' });
scene.jobs.push({ view: 'mid', variant: 'lowmip', out: 'mid-lowmip-id', id: true });
save(join(OUT, 'scene.json'), scene);
const panels = Object.fromEntries(Object.keys(per).map((k, i) => [k, { highTris: tris(highs[i]!), lowTris: tris(lows[i]!), highBytes: meshBytes(highs[i]!), lowBytes: meshBytes(lows[i]!) }]));
save(join(OUT, 'facts.json'), { case: 'C-402', spp: SPP, periods: { welded: tris(welded), expanded: tris(expanded), chain: tris(chain) }, panels, bakes, meshes: mm });
save(join(OUT, 'history.partial.json'), hist.steps);
console.log(JSON.stringify(panels));
