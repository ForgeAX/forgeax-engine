import type { BakeSlot, Model, NormalMode, OpReport } from '@forgeax/engine-modeling';
import { model, Selector, sel } from '@forgeax/engine-modeling';
import { check } from './kit.ts';
import { BARREL_X } from './proportions.ts';
import { buildTurret, TURRET_DEFAULTS } from './turret.ts';

/**
 * C-600 turret game asset: the low (form) mesh is the automatic `lowpoly` of each rigid part of
 * the finished turret (the high), kept as one mesh part per rig joint binding. The recipe slots
 * fold into eight bake classes (the material-id palette holds eight colors).
 */
export const BAKE_CLASSES = ['armor', 'plate', 'steel', 'barrel', 'frame', 'marking', 'glass', 'hazard'] as const;
export type BakeClass = (typeof BAKE_CLASSES)[number];
const FOLD: Readonly<Record<string, BakeClass>> = { Default: 'frame', trim: 'steel', vent: 'frame' };

/**
 * The low keeps its >45 degree dihedrals inside UV islands (the seam plan does not respect sharp edges), so its
 * normals split only on seams: no hard edge lies inside an island and the baked normal map carries the creases.
 */
export const LOW_NORMALS: NormalMode = { mode: 'autoSmooth', angle: 45, split: 'seams' };
export const HIGH_NORMALS: NormalMode = { mode: 'autoSmooth', angle: 35 };

/** Export-triangle budget of the automatic low of each rigid part (the starboard barrel is a copy of the port one). */
export const LOW_BUDGET: Readonly<Record<string, number>> = { barbette: 3600, house: 5900, cradle: 700, mantlet: 1700, apron: 800, 'barrel-port': 2600 };
/**
 * Per bake group cage. The low is the form alone, so the details cut from it (brake ports, rods, recoil bores, mantlet
 * bolts, hatch recesses) stand proud of or sink into the cage; the kernel 'auto' cage measures that reach per group
 * and clips fewer samples than hand-swept values for every group but the house (1024 sweep: barrels 187 vs 607 clipped,
 * mantlet 609 vs 696, roof trim 167 vs 776). The house keeps the swept 0.15/0.6 m cage (auto clips 4808 vs 2980). The
 * barrels' remaining 1.3 % ray misses do not depend on the cage: the brake ports are cut through the whole barrel, so
 * rays aimed at them leave through the far opening. The roof plate bakes as its own `trim` group because its eyes and
 * rivets stand in a thin band.
 */
const AUTO_CAGE = { cage: { offset: 'auto', maxRay: 'auto' } } as const;
export const CAGE_GROUPS: Readonly<Record<string, { cage: { offset: number | 'auto'; maxRay: number | 'auto' } }>> = {
  barbette: AUTO_CAGE,
  'barrel-port': AUTO_CAGE,
  'barrel-starboard': AUTO_CAGE,
  mantlet: AUTO_CAGE,
  house: { cage: { offset: 0.15, maxRay: 0.6 } },
  trim: AUTO_CAGE,
};

/** The bake of the low turret from its high (the C-410 'after' settings, one group per rig part). */
export const bakeSettings = (aoRays: number) =>
  ({
    maps: ['normal', 'curvature', 'materialId', 'baseColor', 'ormh', 'emissive'],
    slots: SLOTS,
    normals: LOW_NORMALS,
    detailNormals: HIGH_NORMALS,
    mips: false,
    direction: { blend: 0.02 },
    cage: { offset: 0.05, maxRay: 0.11 },
    groups: CAGE_GROUPS,
    ao: { rays: aoRays, distance: 0.12, scope: 'all' },
    tags: { groupPrefix: 'bake:', floater: 'floater' },
    gutter: 'fill',
  }) as const;

/**
 * Width in meters under which `lowpoly` removes sliver faces, per part. The house form carries 0.1 m chamfer ribbons
 * up to 14 m long around its base: chamfers of that width are normal-map detail, and as faces they only unwrap to
 * strips a few texels wide.
 */
export const LOW_SLIVERS: Readonly<Record<string, number>> = { house: 0.08 };

const WORK = { budget: { work: 4e9 } } as const;

const encode = (c: number) => Math.max(0, Math.min(1, c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
const PBR: Record<BakeClass, { color: readonly [number, number, number]; metallic: number; roughness: number }> = {
  armor: { color: [0.2, 0.23, 0.26], metallic: 0.05, roughness: 0.55 },
  plate: { color: [0.12, 0.14, 0.17], metallic: 0.05, roughness: 0.6 },
  steel: { color: [0.55, 0.55, 0.57], metallic: 1, roughness: 0.3 },
  barrel: { color: [0.06, 0.065, 0.075], metallic: 0.8, roughness: 0.4 },
  frame: { color: [0.025, 0.027, 0.03], metallic: 0.8, roughness: 0.45 },
  marking: { color: [0.7, 0.7, 0.66], metallic: 0, roughness: 0.6 },
  glass: { color: [0.01, 0.02, 0.03], metallic: 0, roughness: 0.15 },
  hazard: { color: [0.8, 0.5, 0.015], metallic: 0.05, roughness: 0.5 },
};
export const SLOTS: Record<string, BakeSlot & { readonly baseColor: readonly [number, number, number, number] }> = Object.fromEntries(
  Object.entries(PBR).map(([slot, p]) => [slot, { baseColor: [encode(p.color[0]), encode(p.color[1]), encode(p.color[2]), 1], roughness: p.roughness, metallic: p.metallic }]),
);

/** The detail source folds its recipe slots into the bake classes. */
function fold(m: Model): void {
  for (const slot of m.inspect().materials) {
    const to = FOLD[slot];
    if (to !== undefined && m.count(sel.material(slot)) > 0) check(m.assign(sel.material(slot), to), `fold ${slot}`);
  }
}

/** Rig tags that one low mesh covers (the pin is part of the cradle casting). */
export const LOW_PARTS: Readonly<Record<string, readonly string[]>> = { barbette: ['barbette'], house: ['house'], cradle: ['cradle', 'pin'], mantlet: ['mantlet'], apron: ['apron'], 'barrel-port': ['barrel-port'] };

/** Edges (welded by float32 position) used by more than two faces. */
function nonManifoldEdges(mesh: { attributes: { position: Float32Array }; indices: { data?: ArrayLike<number> } | ArrayLike<number> }): number {
  const pos = mesh.attributes.position;
  const idx = ((mesh.indices as { data?: ArrayLike<number> }).data ?? mesh.indices) as ArrayLike<number>;
  const key = (i: number): string => `${pos[i * 3]},${pos[i * 3 + 1]},${pos[i * 3 + 2]}`;
  const uses = new Map<string, number>();
  for (let t = 0; t < idx.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = key(idx[t + k] as number);
      const b = key(idx[t + ((k + 1) % 3)] as number);
      const e = a < b ? `${a}|${b}` : `${b}|${a}`;
      uses.set(e, (uses.get(e) ?? 0) + 1);
    }
  }
  let n = 0;
  for (const v of uses.values()) if (v > 2) n++;
  return n;
}

/** One rigid low part of the high turret as its own session (faces carrying any of its tags). */
function partOf(high: Uint8Array, name: string): Model {
  const p = model(WORK);
  check(p.append(high), `append ${name}`);
  const keep = (LOW_PARTS[name] as readonly string[]).map((t) => sel.tag(t)).reduce((a, b) => a.or(b));
  check(p.delete(sel.all().minus(keep)), `isolate ${name}`);
  return p;
}

export interface LowPartReport {
  readonly part: string;
  readonly highTriangles: number;
  readonly lowTriangles: number;
  readonly lowpoly: unknown;
}

export interface TurretAsset {
  readonly high: Model;
  readonly low: Model;
  readonly reports: readonly LowPartReport[];
}

/**
 * The folded high turret and its low form. Both carry the rig part tags and `bake:<part>` bake
 * group tags (one group per rig part), so a bake of the low reads the detail of its own part.
 */
export function buildTurretAsset(): TurretAsset {
  const turret = buildTurret({ ...TURRET_DEFAULTS, details: 'float' });
  fold(turret);
  const lowSource = buildTurret({ ...TURRET_DEFAULTS, details: 'omit' });
  fold(lowSource);
  const snapshot = lowSource.snapshot();
  const low = model(WORK);
  const reports: LowPartReport[] = [];
  const source: Record<string, Uint8Array> = {};
  for (const tag of Object.keys(LOW_BUDGET)) {
    const hi = partOf(snapshot, tag);
    source[tag] = hi.snapshot();
    const part = model(WORK);
    check(part.append(source[tag] as Uint8Array), `append ${tag}`);
    check(part.uv.plan(SEAM_PLAN), `uv.plan form ${tag}`);
    const r = check(part.lowpoly(undefined, { targetFaces: LOW_BUDGET[tag] as number, quads: false, ...(LOW_SLIVERS[tag] === undefined ? {} : { slivers: LOW_SLIVERS[tag] }) }), `lowpoly ${tag}`);
    const info = r.diagnostics?.find((d) => d.message.startsWith('lowpoly'))?.detail;
    const crossings = part.validate({}).issues.find((i) => i.code === 'self-intersection');
    if (crossings !== undefined) throw new Error(`low part ${tag} self-intersects after lowpoly at budget ${LOW_BUDGET[tag]}: ${JSON.stringify(crossings.detail).slice(0, 200)}`);
    const out = part.toMesh({ normals: LOW_NORMALS });
    if (out.ok) {
      const nm = nonManifoldEdges(out.value.mesh as never);
      if (nm > 0) throw new Error(`low part ${tag} has ${nm} edges shared by more than two faces at budget ${LOW_BUDGET[tag]}`);
    }
    const hiOut = hi.toMesh({ normals: HIGH_NORMALS });
    if (!out.ok || !hiOut.ok) throw new Error(`export ${tag}`);
    reports.push({ part: tag, highTriangles: hiOut.value.report.triangles, lowTriangles: out.value.report.triangles, lowpoly: info });
    if (tag === 'barrel-port') {
      check(low.append(part.snapshot(), { tag: 'barrel-port' }), 'append barrel-port');
      check(low.append(part.snapshot(), { translate: [-2 * BARREL_X, 0, 0], tag: 'barrel-starboard' }), 'append barrel-starboard');
    } else {
      check(low.append(part.snapshot(), { tag }), `append ${tag}`);
    }
  }
  for (const tag of LOW_TAGS) if (low.count(tag === 'barrel-port' ? sel.tag(tag).minus(sel.tag('barrel-starboard')) : sel.tag(tag)) === 0) throw new Error(`low part ${tag} is empty`);
  if (low.count(sel.tag('house').and(ROOF_TRIM)) === 0) throw new Error('low roof trim is empty');
  check(low.bakeGroups({ parts: BAKE_PARTS }), 'bake groups low');
  check(turret.bakeGroups({ parts: BAKE_PARTS }), 'bake groups high');
  check(low.markSharp(sel.edges.dihedral('>', 45)), 'markSharp');
  return { high: turret, low, reports };
}

/**
 * Roof trim: the roof plate with its chamfered rim, lifting eyes (0.055 m tube rings) and rivet rows (everything of the
 * house above the 7.1 m wall top). Low and high carry the same plate, so it bakes as its own group with a thin cage: the
 * house cage (0.05 m offset, 0.11 m rays) reaches into the wall under the 0.12 m rim chamfer and is as deep as an eye tube.
 */
const ROOF_TRIM = sel.inBox([-9.6, 7.05, -9], [9.6, 9, 9]);

/**
 * Part tags to bake groups, in priority order: the starboard barrel carries its port original's tag too, the roof trim is
 * carved out of the house, and the pin belongs to the cradle casting.
 */
const BAKE_PARTS = [
  { tag: 'house', group: 'trim', where: ROOF_TRIM },
  'barrel-starboard',
  'barrel-port',
  'barbette',
  'house',
  'cradle',
  { tag: 'pin', group: 'cradle' },
  'mantlet',
  'apron',
] as const;

/** Rig parts of the low turret (the mesh of `cradle` covers the J2 assembly). */
export const LOW_TAGS = ['barbette', 'house', 'cradle', 'mantlet', 'apron', 'barrel-port', 'barrel-starboard'] as const;

/** One 1024 atlas for the whole low turret; island rectangles sit on whole texels and each rig part fills one atlas block. */
export const UV_ATLAS = { resolution: 1024, padding: 4, snap: true, groups: LOW_TAGS } as const;

/**
 * Semantic seams, planned once on each part's form before `lowpoly`: edges steeper than 75 degrees, material and
 * tag borders, with thin or elongated islands merged; the stretch- and overlap-bounded cut is the safety net for
 * what stays distorted. The simplifier keeps the seam edges, so the low re-plans in `manual` mode on the marked
 * seams only. Sharp edges are not seams by themselves: the normals are baked, so a 45 degree crease needs no cut.
 */
const MAX_SEAM_PASSES = 6;
export const SEAM_PLAN = { hardAngle: 75, smallGroup: 8, maxStretch: 1.6, respectSharp: false, refine: 'slim' } as const;

export interface Unwrap {
  readonly plan: OpReport;
  /** The pack report; its metrics carry the atlas density. */
  readonly report: OpReport;
  /** UV-overlapping face pairs after each pass (pass 0 is the plain plan + pack); a later pass first cuts seams around the faces of the previous pairs. */
  readonly overlapPairs: readonly number[];
}

function overlapFaces(low: Model): number[][] {
  const issue = low.validate({ uniqueUv: true } as never).issues.find((i) => i.code === 'uv-overlap');
  return issue === undefined ? [] : (issue.detail as { faces: number[][] }).faces;
}

/**
 * Unwrap the low turret: plan the seams on the finished low, then pack the islands. A chart whose
 * best layout still overlaps itself is the one place a measured cut is added: seams go around the
 * overlapping faces and the plan reruns on the marked seams until no UV pair overlaps.
 */
export function unwrapLow(low: Model): Unwrap {
  const run = () => ({ plan: check(low.uv.plan({ ...SEAM_PLAN, manual: true, mergeMarked: true }), 'uv.plan'), report: check(low.uv.pack({ ...UV_ATLAS, method: 'raster' }), 'uv.pack') });
  let { plan, report } = run();
  let pairs = overlapFaces(low);
  const overlapPairs = [pairs.length];
  for (let pass = 1; pass <= MAX_SEAM_PASSES && pairs.length > 0; pass++) {
    const ids = [...new Set(pairs.flat())];
    check(low.markSeam(new Selector('face', 'uv-overlap faces', () => ids).toEdges('touching')), 'markSeam overlap');
    ({ plan, report } = run());
    pairs = overlapFaces(low);
    overlapPairs.push(pairs.length);
  }
  return { plan, report, overlapPairs };
}
