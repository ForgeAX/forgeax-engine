import type { MeshAsset } from '@forgeax/engine-types';
import { type BakeSettings, type Model, model, type NormalMode, sel } from '@forgeax/engine-modeling';
import { check, HIGH, type Level, LOW } from './kit.ts';
import { GROUPS, type Group, type GroupName, WAIST } from './mech.ts';
import { SLOTS } from './palette.ts';

/**
 * C-410 pipeline pieces shared by the case scripts and the unit test: group builds with the
 * slot vocabulary normalized to the eight bake classes, triangle-mesh export ("dumps"),
 * the per-set low atlas (uv.auto over every group of a set) and the left-side mirror.
 */
export const BAKE_SLOTS = ['armor', 'accent', 'frame', 'steel', 'rubber', 'glow', 'hazard', 'dark'] as const;
export type BakeClass = (typeof BAKE_SLOTS)[number];
/** Recipe slots folded into the bake classes (the material-id palette holds eight colors). */
const FOLD: Readonly<Record<string, BakeClass>> = { paint: 'accent', chrome: 'steel', spring: 'hazard', bronze: 'steel', stencil: 'dark', Default: 'frame' };

/** Low export normals: hard edges above 45 degrees, the same for bake and render. */
export const LOW_NORMALS: NormalMode = { mode: 'autoSmooth', angle: 45 };
export const HIGH_NORMALS: NormalMode = { mode: 'autoSmooth', angle: 35 };

/**
 * Bake settings of one texture set. Bake groups are the face tags `bake:<group>.<element>`.
 * `after` (B20 S1a): the averaged-normal cage blended to the face normal 2 cm from hard edges
 * (no seam at the edge, no skew of bolts on flat panels), a 5 cm / 11 cm cage (the automatic
 * cage measured up to 11 cm / 26 cm on the torso, where it reaches across neighbouring plates),
 * AO over every group (hoses shade the plates behind them), stencil and chevron floaters, and
 * the gutter filled to the next chart. `before`: the pre-cage behaviour this case first used,
 * kept as the falsifier: split shading normals and a fixed 4.5 cm / 9 cm projection, AO per
 * group, 8 gutter texels. Occlusion (the `ormh` red channel) reaches 12 cm; the slot maps come
 * from the palette's kernel slots; mips come from the KTX2 encode.
 */
export function bakeSettings(mode: 'after' | 'before', aoRays = 16) {
  const common = { maps: ['normal', 'curvature', 'materialId', 'baseColor', 'ormh', 'emissive'], slots: SLOTS, tags: { groupPrefix: 'bake:' }, normals: LOW_NORMALS, detailNormals: HIGH_NORMALS, mips: false } as const;
  return mode === 'after'
    ? ({ ...common, direction: { blend: 0.02 }, cage: { offset: 0.05, maxRay: 0.11 }, ao: { rays: aoRays, distance: 0.12, scope: 'all' }, tags: { groupPrefix: 'bake:', floater: 'floater' }, gutter: 'fill' } as const satisfies Partial<BakeSettings>)
    : ({ ...common, direction: 'shading', cage: { offset: 0.045, maxRay: 0.09 }, ao: { rays: aoRays, distance: 0.12, scope: 'group' }, gutter: 8 } as const satisfies Partial<BakeSettings>);
}

export function buildGroup(g: Group, l: Level): Model {
  const m = g.build(l);
  if (g.lean) check(m, m.rotate(sel.all(), 'x', g.lean, WAIST), 'lean');
  for (const slot of m.inspect().materials) {
    const to = FOLD[slot];
    if (to !== undefined && m.count(sel.material(slot)) > 0) check(m, m.assign(sel.material(slot), to), `fold ${slot}`);
  }
  return m;
}

/**
 * Recessed openings the low form leaves out (vents, grilles, glow slits): the hole walls with
 * their rim bevel, floors, perforated sheets and louvres. The bake carries them as normal,
 * height and opacity texels, so they are designed out of the watertight reference.
 */
export const recesses = () => sel.createdBy('slab', 'hole').or(sel.createdBy('rp', 'hole')).grow(1).or(sel.tag('floor')).or(sel.tag('grille')).or(sel.tag('slat'));

/**
 * The design surface a low group must cover: its detail source without the recesses.
 * Proud fasteners and greebles stay in: they stand at most COVER_TOLERANCE off the low skin.
 */
export function coverageReference(g: Group): Model {
  const high = buildGroup(g, HIGH);
  check(high, high.delete(recesses()), 'recesses');
  return high;
}
/** Measured C-410 maximum 40.0 mm (shin, a proud bolt head); interior p95 at most 16 mm. */
export const COVER_TOLERANCE = 0.04;

export interface Dump {
  readonly position: Float32Array;
  readonly normal: Float32Array;
  readonly uv: Float32Array;
  readonly indices: Uint32Array;
  readonly submeshes: readonly { readonly indexOffset: number; readonly indexCount: number; readonly materialSlot: number }[];
  readonly slots: readonly string[];
}
export const tris = (d: Dump) => d.indices.length / 3;
export const verts = (d: Dump) => d.position.length / 3;

export function toDump(a: MeshAsset): Dump {
  const at = a.attributes as unknown as Record<string, Float32Array>;
  const vc = (at.position as Float32Array).length / 3;
  return {
    position: at.position as Float32Array,
    normal: at.normal as Float32Array,
    uv: at.uv ?? new Float32Array(vc * 2),
    indices: new Uint32Array(a.indices as ArrayLike<number>),
    submeshes: a.submeshes.map((s) => ({ indexOffset: s.indexOffset, indexCount: s.indexCount, materialSlot: s.materialSlot })),
    slots: a.materialSlots.map((s) => s.slotName),
  };
}

export function exportDump(m: Model, key: string, normals: NormalMode): Dump {
  const r = m.finish({ key, normals });
  if (!r.ok) throw new Error(`finish ${key}: ${r.error.code} ${r.error.expected}`);
  return toDump(Object.values(r.value)[0] as MeshAsset);
}

/** Mirror across x = 0: positions and normals negate x, triangles flip winding (uv kept: shared texels). */
export function mirrorDump(d: Dump): Dump {
  const position = d.position.slice(), normal = d.normal.slice(), indices = d.indices.slice();
  for (let i = 0; i < position.length; i += 3) {
    position[i] = -(position[i] as number);
    normal[i] = -(normal[i] as number);
  }
  for (let i = 0; i < indices.length; i += 3) {
    const b = indices[i + 1] as number;
    indices[i + 1] = indices[i + 2] as number;
    indices[i + 2] = b;
  }
  return { ...d, position, normal, uv: d.uv.slice(), indices };
}

/** Merge dumps; slots merge by name, one submesh per slot. */
export function merge(parts: readonly Dump[]): Dump {
  const slots: string[] = [];
  for (const p of parts) for (const s of p.slots) if (!slots.includes(s)) slots.push(s);
  const nv = parts.reduce((a, p) => a + verts(p), 0);
  const position = new Float32Array(nv * 3), normal = new Float32Array(nv * 3), uv = new Float32Array(nv * 2);
  const perSlot: number[][] = slots.map(() => []);
  let vo = 0;
  for (const p of parts) {
    position.set(p.position, vo * 3);
    normal.set(p.normal, vo * 3);
    uv.set(p.uv, vo * 2);
    for (const s of p.submeshes) {
      const out = perSlot[slots.indexOf(p.slots[s.materialSlot] as string)] as number[];
      for (let i = s.indexOffset; i < s.indexOffset + s.indexCount; i++) out.push((p.indices[i] as number) + vo);
    }
    vo += verts(p);
  }
  const indices = new Uint32Array(perSlot.reduce((a, s) => a + s.length, 0));
  const submeshes: { indexOffset: number; indexCount: number; materialSlot: number }[] = [];
  let io = 0;
  perSlot.forEach((s, k) => {
    if (s.length === 0) return;
    indices.set(s, io);
    submeshes.push({ indexOffset: io, indexCount: s.length, materialSlot: k });
    io += s.length;
  });
  return { position, normal, uv, indices, submeshes, slots };
}

/** One slot's triangles as their own dump (unused vertices kept: the renderer only reads indexed ones). */
export function slotDump(d: Dump, slot: string): Dump {
  const k = d.slots.indexOf(slot);
  const sm = d.submeshes.find((s) => s.materialSlot === k);
  if (sm === undefined) throw new Error(`slot ${slot} not in dump`);
  const indices = d.indices.slice(sm.indexOffset, sm.indexOffset + sm.indexCount);
  return { ...d, indices, submeshes: [{ indexOffset: 0, indexCount: indices.length, materialSlot: 0 }], slots: [slot] };
}

/** Elements that move against the body or are decals: never merged into its rigid shell. Hoses and cables are static at game resolution and join the union. */
const articulated = () => sel.tag('ram').or(sel.tag('spring')).or(sel.tag('rod')).or(sel.tag('floater'));

/** Face tag of the merged rigid shells when `mergeRigid` removes slivers: the scope of `assertNoSlivers`. */
const RIGID = 'rigid-shell';

/**
 * Merge the rigid parts of a built group into shells (U82/U83 union, no simplification):
 * plates, struts and hubs that overlap or touch become one closed shell with fresh edges at
 * the intersection curves, so triangulation, sharp edges and `uv.auto` see the merged surface
 * and not the buried pieces. Hoses and cables join the union; rams, springs, rods and decal floaters stay separate.
 * `slivers` (a width in meters, `lowpoly`'s option) removes the faces narrower than it from
 * the shells and tags them `rigid-shell` for `assertNoSlivers`.
 */
export function mergeRigid(m: Model, name: string, options: { readonly slivers?: number } = {}): void {
  const rigid = sel.all().minus(articulated());
  if (m.count(rigid) === 0) return;
  check(m, m.lowpoly(rigid, { targetFaces: 1_000_000, quads: false, ...options }), `merge ${name}`);
  if (options.slivers !== undefined) check(m, m.tag(sel.all().minus(articulated()), RIGID), `tag ${name}`);
}

/** The gate of `mergeRigid`'s sliver pass: throws naming the count and first faces while a merged shell has a face narrower than `width`. */
export function assertNoSlivers(m: Model, name: string, width: number): void {
  const found = m.validate({ slivers: { width, part: RIGID } }).issues.find((i) => i.code === 'face-degenerate');
  if (found !== undefined) throw new Error(`${name}: slivers remain ${JSON.stringify(found.detail)}`);
}

/** The gate of `mergeRigid`'s union: throws naming the crossings while merged rigid shells still cross each other (articulated parts cross the body by design and are left out). */
export function assertRigidUnion(m: Model, name: string): void {
  const rigid = model();
  check(rigid, rigid.append(m.snapshot()), `snapshot ${name}`);
  if (rigid.count(articulated()) > 0) check(rigid, rigid.delete(articulated()), `articulated ${name}`);
  const found = rigid.validate({ shells: {} }).issues.find((i) => i.code === 'shell-overlap');
  if (found !== undefined) throw new Error(`${name}: rigid shells cross ${JSON.stringify(found.detail)}`);
}

/**
 * The low (form) mesh of one texture set: every group of the set at the low level, its rigid
 * parts merged (`mergeRigid`), its faces in a slot named after the group, hard edges above 45 degrees, one `uv.auto`
 * atlas over the whole set (charts never cross a hard edge, so hard edges are UV seams).
 */
export function buildLowSet(set: Group['set'], resolution: number, padding: number): { model: Model; groups: GroupName[] } {
  const s = model();
  const groups: GroupName[] = [];
  for (const g of GROUPS.filter((x) => x.set === set)) {
    const m = buildGroup(g, LOW);
    mergeRigid(m, g.name);
    check(m, m.assign(sel.all(), g.name));
    check(s, s.append(m, { tag: g.name }), `append ${g.name}`);
    groups.push(g.name);
  }
  check(s, s.markSharp(sel.edges.dihedral('>', 45)));
  check(s, s.uv.auto({ resolution, padding }), `uv.auto ${set}`);
  return { model: s, groups };
}

/** Kit elements of a group that bake as their own bake group (`bake:<group>.<sub>`). */
const BAKE_SUBS: readonly (readonly [string, () => ReturnType<typeof sel.all>])[] = [
  ['body', () => sel.all().minus(sel.tag('hose').or(sel.tag('ram')).or(sel.tag('spring')).or(sel.tag('rod')))],
  ['hose', () => sel.tag('hose')],
  ['ram', () => sel.tag('ram').or(sel.tag('spring')).or(sel.tag('rod'))],
];

/**
 * One texture set's bake pair: the low atlas model (`buildLowSet`) and the detail source of its
 * groups at the full HIGH level (box-projected), both carrying the same `bake:<group>.<sub>`
 * tags so every kit element bakes onto its own low geometry.
 */
export function buildSetBake(set: Group['set'], resolution: number, padding: number): { low: Model; detail: Model; groups: GroupName[] } {
  const { model: low, groups } = buildLowSet(set, resolution, padding);
  const detail = model();
  for (const name of groups) {
    const hi = buildGroup(GROUPS.find((g) => g.name === name) as Group, HIGH);
    check(hi, hi.uv.project({ mode: 'box', scale: 0.5 }));
    for (const [sub, pick] of BAKE_SUBS) {
      const lowSel = sel.material(name).and(pick());
      if (low.count(lowSel) === 0) continue;
      if (hi.count(pick()) === 0) throw new Error(`bake unit ${name}.${sub}: low faces without a detail source`);
      check(low, low.tag(lowSel, `bake:${name}.${sub}`));
      check(hi, hi.tag(pick(), `bake:${name}.${sub}`));
    }
    check(detail, detail.append(hi), `append ${name}`);
  }
  return { low, detail, groups };
}

/** Part names of a group in the Pack: a mirrored group is built at +X (`-r`) and mirrored to -X (`-l`). */
export const partsOf = (g: Group): string[] => (g.mirrored ? [`${g.name}-r`, `${g.name}-l`] : [g.name]);

/**
 * One group of a set atlas as game meshes: `key` + part name, a single slot named after the
 * set; a mirrored group adds its -X side sharing the same texels. Keys are `<prefix>.<part>`.
 */
export function lowParts(low: Model, g: Group, prefix: string): Record<string, MeshAsset> {
  const part = model();
  check(part, part.append(low.snapshot()));
  check(part, part.delete(sel.all().minus(sel.material(g.name))));
  check(part, part.assign(sel.all(), g.set));
  const out: Record<string, MeshAsset> = {};
  const parts = partsOf(g);
  const first = part.finish({ key: `${prefix}.${parts[0]}`, normals: LOW_NORMALS });
  if (!first.ok) throw new Error(`finish ${prefix}.${parts[0]}: ${first.error.code} ${first.error.expected}`);
  Object.assign(out, first.value);
  if (g.mirrored) {
    check(part, part.mirror({ axis: 'x' }));
    check(part, part.delete(sel.inBox([0, -10, -10], [10, 10, 10])));
    const second = part.finish({ key: `${prefix}.${parts[1]}`, normals: LOW_NORMALS });
    if (!second.ok) throw new Error(`finish ${prefix}.${parts[1]}: ${second.error.code} ${second.error.expected}`);
    Object.assign(out, second.value);
  }
  return out;
}
