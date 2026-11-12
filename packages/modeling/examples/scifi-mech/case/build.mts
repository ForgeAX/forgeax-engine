// C-410 build: HIGH (per stage) and LOW meshes for the renderer, per-group bake inputs (FXEM),
// statistics. usage: node build.mts <outDir> [resolution=2048] [padding=16]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeTangentVec4 } from '@forgeax/engine-geometry';
import { model, sel } from '@forgeax/engine-modeling';
import { check, collectOps, COUNTS, HIGH, highUpTo, type Level, LOW, OPS, resetCounts, STAGES } from '../kit.ts';
import { GROUPS } from '../mech.ts';
import { buildGroup, buildLowSet, type Dump, exportDump, HIGH_NORMALS, LOW_NORMALS, merge, mirrorDump, tris, verts } from '../pipeline.ts';

const [outDir, resArg, padArg] = process.argv.slice(2);
const RES = Number(resArg ?? 2048), PAD = Number(padArg ?? 16);
const OUT = outDir!;
mkdirSync(join(OUT, 'meshes'), { recursive: true });
mkdirSync(join(OUT, 'bake'), { recursive: true });

type TDump = Dump & { tangent: Float32Array };
function withTangents(d: Dump): TDump {
  const t = computeTangentVec4(d.position, d.normal, d.uv, d.indices);
  if (!t.ok) throw new Error(`tangent: ${JSON.stringify(t.error)}`);
  return { ...d, tangent: t.value };
}
function aabb(d: Dump) {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < d.position.length; i += 3) for (let k = 0; k < 3; k++) { b[k] = Math.min(b[k]!, d.position[i + k]!); b[k + 3] = Math.max(b[k + 3]!, d.position[i + k]!); }
  return b;
}
function writeMesh(name: string, d0: Dump) {
  const d = withTangents(d0);
  const parts = [d.position, d.normal, d.uv, d.tangent, d.indices];
  writeFileSync(join(OUT, 'meshes', `${name}.bin`), Buffer.concat(parts.map((p) => Buffer.from(p.buffer, p.byteOffset, p.byteLength))));
  const meta = { verts: verts(d), indexCount: d.indices.length, tris: tris(d), attrs: [['position', 3], ['normal', 3], ['uv', 2], ['tangent', 4]], submeshes: d.submeshes, slots: d.slots, aabb: aabb(d), bytes: verts(d) * 48 + d.indices.length * 4 };
  writeFileSync(join(OUT, 'meshes', `${name}.meta.json`), JSON.stringify(meta));
  return meta;
}
const withSlot = (d: Dump, slot: string): Dump => merge([{ ...d, slots: d.slots.map(() => slot) }]);
const both = (d: Dump, mirrored: boolean) => (mirrored ? [d, mirrorDump(d)] : [d]);

const stats: Record<string, unknown> = { resolution: RES, padding: PAD, groups: {}, stages: {} };
const G = stats.groups as Record<string, Record<string, unknown>>;

// HIGH per stage (history) and final.
const highFinal: Dump[] = [];
for (const stage of process.env.C410_STAGES === '0' ? (['markings'] as const) : STAGES) {
  const level: Level = stage === 'markings' ? HIGH : highUpTo(stage);
  const parts: Dump[] = [];
  const t0 = performance.now();
  let ops = 0;
  const stageOps = new Map<string, number>();
  for (const g of GROUPS) {
    const t1 = performance.now();
    resetCounts();
    collectOps();
    const m = buildGroup(g, level);
    const counts = { ...COUNTS };
    check(m, m.uv.project({ mode: 'box', scale: 0.5 }));
    const d = exportDump(m, g.name, HIGH_NORMALS);
    OPS.clear();
    ops += collectOps();
    for (const [k, n] of OPS) stageOps.set(k, (stageOps.get(k) ?? 0) + n);
    parts.push(...both(d, g.mirrored));
    if (stage === 'markings') {
      writeFileSync(join(OUT, 'bake', `${g.name}.high.fxem`), m.snapshot());
      G[g.name] = { ...G[g.name], highTris: tris(d), highVerts: verts(d), highSlots: d.slots, highOps: m.journal.length, highMs: Math.round(performance.now() - t1), mirrored: g.mirrored, set: g.set, counts, ops: Object.fromEntries(OPS) };
      highFinal.push(...both(d, g.mirrored));
    }
  }
  const merged = merge(parts);
  const meta = writeMesh(`high-${stage}`, merged);
  (stats.stages as Record<string, unknown>)[stage] = { tris: meta.tris, verts: meta.verts, bytes: meta.bytes, ops, opsByName: Object.fromEntries(stageOps), ms: Math.round(performance.now() - t0) };
  console.log('stage', stage, meta.tris, 'tris', Math.round(performance.now() - t0), 'ms');
}
const high = writeMesh('high', merge(highFinal));

// LOW: one uv.auto atlas per set. Bake groups (S1a, tag `bake:<group>.<element>`): each
// group split by kit element with its own low geometry (body, hoses, rams), on the low set and
// on the high detail alike, so a hose's rays never land on the plate under it.
const units: { unit: string; group: string; set: string; sub: string; lowFaces: number; highFaces: number }[] = [];
const SUBS: readonly (readonly [string, () => ReturnType<typeof sel.all>])[] = [
  ['body', () => sel.all().minus(sel.tag('hose').or(sel.tag('ram')).or(sel.tag('spring')).or(sel.tag('rod')))],
  ['hose', () => sel.tag('hose')],
  ['ram', () => sel.tag('ram').or(sel.tag('spring')).or(sel.tag('rod'))],
];
const lowParts: Dump[] = [];
const lowFlatParts: Dump[] = [];
const sets: Record<string, unknown> = {};
for (const set of ['set1', 'set2', 'set3'] as const) {
  const t0 = performance.now();
  const { model: s, groups } = buildLowSet(set, RES, PAD);
  const uvAuto = s.journal.find((j) => j.op === 'uv.auto');
  sets[set] = { ms: Math.round(performance.now() - t0), uvAuto: uvAuto?.diagnostics ?? [], groups };
  const detail = model();
  for (const name of groups) {
    const g = GROUPS.find((x) => x.name === name)!;
    const hi = model();
    check(hi, hi.append(new Uint8Array(readFileSync(join(OUT, 'bake', `${name}.high.fxem`)))));
    for (const [sub, pick] of SUBS) {
      const lowSel = sel.material(name).and(pick());
      const lowFaces = s.count(lowSel);
      if (lowFaces === 0) continue;
      const highFaces = hi.count(pick());
      if (highFaces === 0) throw new Error(`unit ${name}.${sub}: low faces without a detail source`);
      check(s, s.tag(lowSel, `bake:${name}.${sub}`));
      check(hi, hi.tag(pick(), `bake:${name}.${sub}`));
      units.push({ unit: `${name}.${sub}`, group: name, set, sub, lowFaces, highFaces });
    }
    check(detail, detail.append(hi));
    const b = model();
    check(b, b.append(s.snapshot()));
    check(b, b.delete(sel.all().minus(sel.material(name))));
    const d = exportDump(b, name, LOW_NORMALS);
    G[name] = { ...G[name], lowTris: tris(d), lowVerts: verts(d) };
    lowParts.push(...both(withSlot(d, set), g.mirrored));
    lowFlatParts.push(...both(withSlot(d, `${set}-${name}`), g.mirrored));
    writeMesh(`low-${name}`, d);
  }
  writeFileSync(join(OUT, 'bake', `${set}.base.fxem`), s.snapshot());
  writeFileSync(join(OUT, 'bake', `${set}.high.fxem`), detail.snapshot());
  writeMesh(`lowset-${set}`, exportDump(s, set, LOW_NORMALS));
}
stats.units = units;
stats.sets = sets;
const totals: Record<string, number> = {};
for (const [name, v] of Object.entries(G)) for (const [k, n] of Object.entries((v.counts ?? {}) as Record<string, number>)) totals[k] = (totals[k] ?? 0) + n * (GROUPS.find((x) => x.name === name)!.mirrored ? 2 : 1);
stats.featureCounts = totals;
const low = writeMesh('low', merge(lowParts));
writeMesh('low-groups', merge(lowFlatParts));
stats.totals = { high: { tris: high.tris, verts: high.verts, bytes: high.bytes }, low: { tris: low.tris, verts: low.verts, bytes: low.bytes }, triReduction: 1 - low.tris / high.tris };
writeFileSync(join(OUT, 'build.json'), JSON.stringify(stats, null, 1));
console.log(JSON.stringify(stats.totals), JSON.stringify(sets).slice(0, 1500));
void LOW;
