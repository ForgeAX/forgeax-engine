// C-410 U83 demo: the automatic low (m.lowpoly over the HIGH group) against the hand low (the
// LOW form level) at no more of its triangles, for the torso and the shin. Reports triangles,
// Hausdorff to the HIGH, silhouette IoU at six gameplay views and a normal bake onto each low.
// usage: node lowpoly.mts <outDir> [groups=torso,shin] [resolution=512] [source=low|high]
// source: the parts lowpoly unions (default low: the form level, as a hand low starts from).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bakeMaps, diffMeshes, type Model, model, type PerspectiveView, sel, silhouetteIoU } from '@forgeax/engine-modeling';
import { check, HIGH, LOW } from '../kit.ts';
import { GROUPS, type Group } from '../mech.ts';
import { buildGroup, exportDump, HIGH_NORMALS, LOW_NORMALS, tris } from '../pipeline.ts';

type V3 = [number, number, number];
const [outDir, groupsArg, resArg] = process.argv.slice(2);
const OUT = outDir ?? '/tmp/c410-lowpoly';
const NAMES = (groupsArg ?? 'torso,shin').split(',');
const RES = Number(resArg ?? 512);
const SOURCE = process.argv[5] === 'high' ? HIGH : LOW;
mkdirSync(OUT, { recursive: true });

function bounds(m: Model): { c: V3; r: number } {
  const b = m.bounds(sel.all());
  if (!b.ok) throw new Error(`bounds: ${b.error.code}`);
  const { min: lo, max: hi } = b.value;
  return { c: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2], r: Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2 };
}

/** Six gameplay views: four around at eye height, one from above-front, one from below-back. */
function gameplayViews(c: V3, r: number): PerspectiveView[] {
  const d = r * 3;
  const dirs: V3[] = [[0.3, 0.15, 1], [1, 0.15, -0.2], [-0.3, 0.15, -1], [-1, 0.15, 0.2], [0.5, 1, 0.7], [-0.6, -0.5, -0.6]];
  return dirs.map((v) => {
    const n = Math.hypot(...v);
    return { eye: [c[0] + (v[0] / n) * d, c[1] + (v[1] / n) * d, c[2] + (v[2] / n) * d], target: c, fovY: 40, pixels: 256 };
  });
}

const r4 = (x: number) => Math.round(x * 10000) / 10000;
const hd = (d: { hausdorff: { ab: number; ba: number; max: number } }) => ({ lowToHigh: d.hausdorff.ab, highToLow: d.hausdorff.ba, max: d.hausdorff.max });

function measure(name: string, low: Model, high: Uint8Array, views: readonly PerspectiveView[]) {
  const snap = low.snapshot();
  const t = tris(exportDump(low, name, LOW_NORMALS));
  const diff = diffMeshes(snap, high);
  if (!diff.ok) throw new Error(`diff ${name}: ${diff.error.code}`);
  const iou = views.map((v) => {
    const r = silhouetteIoU(snap, v, high);
    if (!r.ok) throw new Error(`iou ${name}: ${r.error.code}`);
    return r.value.iou;
  });
  const t0 = performance.now();
  const b = bakeMaps({ base: snap, detail: high, maps: ['normal'], resolution: RES, normals: LOW_NORMALS, detailNormals: HIGH_NORMALS, direction: { blend: 0.02 }, cage: { offset: 0.05, maxRay: 0.11 }, gutter: 'fill', mips: false, budget: 1e15 });
  if (!b.ok) return { tris: t, hausdorff: hd(diff.value), iou: iou.map(r4), iouMin: Math.min(...iou), bake: { error: `${b.error.code}: ${b.error.expected}` } };
  const g = b.value.provenance.groups;
  const samples = g.reduce((n, x) => n + x.samples, 0), hits = g.reduce((n, x) => n + x.rayHits, 0);
  return {
    tris: t,
    hausdorff: hd(diff.value),
    iou: iou.map(r4),
    iouMin: Math.min(...iou),
    bake: { ms: Math.round(performance.now() - t0), pass: b.value.pass, rayHits: samples ? hits / samples : 0, clipped: g.reduce((n, x) => n + (x.clipped ?? 0), 0), issues: b.value.issues.map((i) => ({ code: i.code, severity: i.severity })) },
  };
}

const results: Record<string, unknown> = {};
for (const name of NAMES) {
  const g = GROUPS.find((x) => x.name === name) as Group;
  const high = buildGroup(g, HIGH);
  const highSnap = high.snapshot();
  const { c, r } = bounds(high);
  const views = gameplayViews(c, r);

  const hand = buildGroup(g, LOW);
  check(hand, hand.markSharp(sel.edges.dihedral('>', 45)));
  check(hand, hand.uv.auto({ resolution: RES, padding: 4 }), 'hand uv');
  const handM = measure(`${name}-hand`, hand, highSnap, views);

  // The union and remesh of a full HIGH group exceed the default 2e8 work units.
  const auto = model({ budget: { work: 4e9 } });
  check(auto, auto.append(SOURCE === HIGH ? highSnap : buildGroup(g, LOW).snapshot()), 'append source');
  const t0 = performance.now();
  const rep = check(auto, auto.lowpoly(undefined, { targetFaces: handM.tris, silhouette: { views }, uv: { resolution: RES, padding: 4 }, tags: { groupPrefix: 'bake:auto' } }), 'lowpoly');
  const lowpolyMs = Math.round(performance.now() - t0);
  const info = rep.diagnostics?.find((d) => d.message.startsWith('lowpoly'))?.detail as Record<string, unknown> | undefined;
  const autoM = measure(`${name}-auto`, auto, highSnap, views);
  results[name] = { radius: r, source: SOURCE === HIGH ? 'high' : 'low', hand: handM, auto: { ...autoM, lowpolyMs, report: { pass: info?.pass, issues: info?.issues, union: info?.union, fallback: info?.fallback, parts: info?.parts, quadAreaRatio: info?.quadAreaRatio, hausdorffToUnion: info?.hausdorff, simplify: info?.simplify } } };
  writeFileSync(join(OUT, `${name}.hand.fxem`), hand.snapshot());
  writeFileSync(join(OUT, `${name}.auto.fxem`), auto.snapshot());
  writeFileSync(join(OUT, `${name}.high.fxem`), highSnap);
  console.log(name, JSON.stringify(results[name]));
}
writeFileSync(join(OUT, 'lowpoly.json'), JSON.stringify(results, null, 1));
