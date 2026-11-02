import { type BakeSettings, type DomainRegion, type Model, model, nurbs, type Point2, proceduralMaterials, sel, type StandardMaterialOptions, type SurfacePatch, type TextureSink, type Tuple3 } from '@forgeax/engine-modeling';
import { PAINT, panelMaterials } from '../body-panels/panels.ts';
import type { SessionFactory } from '../case/record.ts';
import { bodyPatches, bodyPoint, closures, cutIntakes, LINES, lifted } from './s3-rough.ts';
import { featureLines, featureY } from './reference.ts';
import { ON_CAR, SPLITS, WHEELS } from './s2-body.ts';
import { frontSplitter, rearWing } from './s6a-aero.ts';
import { LAMPS } from './s6a-anchors.ts';

/**
 * Case C-100 stage S6 (code name mech-gt): the final exterior parts. The S3 panels are
 * finished per part group, one Pack each so every build stays inside the Pack budget:
 * every visible panel edge is chamfered, every face carries a procedural material, and the
 * groups add the parts S3 left out (fascias, rear wing, splitter, finished tires) and cut the
 * openings the S6c lamp cavities and intake meshes fill. Part tags
 * stay the S3 rig's `part:<id>`, so the S4 rig and the S7 animation bind the same parts.
 */
export const S6_GROUPS = {
  front: ['hood-l', 'hood-r', 'front-fender-l', 'front-fender-r'],
  nose: ['bumper-center', 'bumper-corner-l', 'bumper-corner-r', 'windshield'],
  cabin: ['roof-front', 'roof-rear', 'door-l-outer', 'door-r-outer', 'door-l-inner', 'door-r-inner', 'side-intake-l', 'side-intake-r'],
  rear: ['rear-fender-l-front', 'rear-fender-l-rear', 'rear-fender-r-front', 'rear-fender-r-rear', 'engine-cover-l', 'engine-cover-r', 'diffuser-center', 'diffuser-l', 'diffuser-r', 'rear-wing'],
  wheels: ['front-wheel-l', 'front-wheel-r', 'rear-wheel-l', 'rear-wheel-r'],
} as const;
export type S6Group = keyof typeof S6_GROUPS;

const WALL = 0.003;
/**
 * Edge break of every visible panel edge: a 1.2 mm chamfer, shaded round by the smoothed
 * export normals. Two-segment rounds leave curved corner n-gons past the planarity tolerance.
 */
export const ROUND = { width: 0.0012, segments: 1 } as const;

/** Slots whose visible panel edges are rounded. */
const ROUNDED = ['paint', 'louvre', 'carbon', 'glass', 'badge', 'number-l', 'number-r', 'headlight', 'taillight'];

/** Panels that are carbon instead of paint. */
const CARBON = ['diffuser-center', 'diffuser-l', 'diffuser-r'];

/** The openings cut from each host panel patch (by patch name); the S6c cavities fill them. */
const OPENINGS: Readonly<Record<string, readonly (keyof typeof LAMPS)[]>> = {
  'bumper-corner-l': ['headlight', 'frontIntake'],
  'bumper-corner-r': ['headlight', 'frontIntake'],
  'diffuser-center-l': ['taillight'],
  'diffuser-center-r': ['taillight'],
};

/** An opening [z0, z1] x [t0, t1] of the body surface as a trim in the normalized domain of `host` (point inversion of its outline). */
function opening(host: SurfacePatch, region: (typeof LAMPS)[keyof typeof LAMPS], sign: 1 | -1, n = 8): DomainRegion {
  const [[u0, u1], [v0, v1]] = nurbs.surfaceDomain(host.surface);
  const [z0, z1] = region.z;
  const [t0, t1] = region.t;
  const edge: [number, number][] = [];
  for (let k = 0; k < n; k++) edge.push([z0 + ((z1 - z0) * k) / n, t0]);
  for (let k = 0; k < n; k++) edge.push([z1, t0 + ((t1 - t0) * k) / n]);
  for (let k = 0; k < n; k++) edge.push([z1 - ((z1 - z0) * k) / n, t1]);
  for (let k = 0; k < n; k++) edge.push([z0, t1 - ((t1 - t0) * k) / n]);
  const uv = edge.map(([z, t]): Point2 => {
    const c = nurbs.closest(host.surface, bodyPoint(z, t, sign));
    return [(c.u - u0) / (u1 - u0), (c.v - v0) / (v1 - v0)];
  });
  return { uv };
}

function withOpenings(p: SurfacePatch): SurfacePatch {
  const regions = OPENINGS[p.name ?? ''];
  if (regions === undefined) return p;
  const sign = p.name?.endsWith('-r') ? -1 : 1;
  return { ...p, trims: [...(p.trims ?? []), ...regions.map((r) => opening(p, LAMPS[r], sign))] };
}

/** The waist crease: a V groove along the blueprint's waist line, from the side intake's front tip forward. */
export const WAIST = { from: -0.1, to: 0.93, width: 0.003, depth: 0.0015, margin: 0.03 } as const;

/** The waist crease as a plane across the car through the line's ends (the drawn line is straight within 3 mm there). */
export function waistPlane(): { readonly point: Tuple3; readonly normal: Tuple3 } {
  const yAt = featureY('waist', ON_CAR);
  const zs = featureLines('waist', ON_CAR).flat().map((q) => q[0]);
  const at = (z: number) => yAt(Math.min(Math.max(...zs), Math.max(Math.min(...zs), z))) as number;
  const [y0, y1] = [at(WAIST.from), at(WAIST.to)];
  const [dy, dz] = [y1 - y0, WAIST.to - WAIST.from];
  const l = Math.hypot(dy, dz);
  return { point: [0, y0, WAIST.from], normal: [0, -dz / l, dy / l] };
}

/** Grooves the outer skin of the closed panels (a groove before the shell would leave strips thinner than the wall). */
function waistLine(m: Model, wanted: ReadonlySet<string>): void {
  const plane = waistPlane();
  for (const side of ['l', 'r'] as const) {
    const parts = [`door-${side}-outer`, `front-fender-${side}`].filter((p) => wanted.has(p));
    if (parts.length === 0) continue;
    const skin = sel.all().minus(sel.createdBy('wall', 'rim')).minus(sel.createdBy('wall', 'inner'));
    // The groove stops WAIST.margin short of each shut line: run into the rim, it leaves degenerate round corners.
    const band = (z0: number, z1: number) => sel.inBox([-2, 0, z0 + WAIST.margin], [2, 2, z1 - WAIST.margin], { by: 'all' });
    const spans: Record<string, readonly [number, number]> = { [`door-${side}-outer`]: [Math.max(WAIST.from, SPLITS.doorRear), SPLITS.doorFront], [`front-fender-${side}`]: [SPLITS.doorFront, WAIST.to] };
    const faces = parts.map((p) => sel.tag(`part:${p}`).and(skin).and(band(...(spans[p] as readonly [number, number])))).reduce((a, b) => a.or(b));
    m.panelLine({ faces, ...plane }, { width: WAIST.width, depth: WAIST.depth, profile: 'v', label: `waist-${side}` });
  }
}

/** Shell the open panels of `part` (if any) into closed parts with an underside, and append them to `m`. */
function closedInto(m: Model, part: Model, wall: number): void {
  if (part.inspect().faces === 0) return;
  part.cleanup.slivers(undefined, { width: 0.0002, quiet: true });
  part.shell(sel.all(), { thickness: wall, label: 'wall' });
  // The rim keeps the panel's finish, so a shut line shows the panel's return edge, not a void.
  part.assign(sel.createdBy('wall', 'inner'), 'underside');
  if (part.poisoned !== undefined) throw part.poisoned;
  m.append(part.snapshot());
}

/** Chamfer every outer panel edge (where the outer skin meets its shell rim), one material at a time. */
function roundEdges(m: Model, materials: readonly string[]): void {
  const rim = sel.createdBy('wall', 'rim');
  const inner = sel.createdBy('wall', 'inner');
  const rails = rim.toEdges('touching').and(sel.all().minus(rim).minus(inner).toEdges('touching'));
  for (const material of materials) {
    const edges = rails.and(sel.material(material).toEdges('touching'));
    if (m.count(edges) === 0) continue;
    m.bevel(edges, { ...ROUND, label: `round-${material}`, material });
  }
}

function panelGroup(m: Model, group: Exclude<S6Group, 'wheels'>): void {
  const wanted = new Set<string>(S6_GROUPS[group]);
  const panels = model();
  for (const [part, patches] of Object.entries(bodyPatches())) {
    if (wanted.has(part)) panels.surface({ patches: patches.map(withOpenings), chord: 0.003, angle: 12, label: part, tag: `part:${part}`, material: CARBON.includes(part) ? 'carbon' : VENTED(group).includes(part) ? 'louvre' : 'paint' });
  }
  if (wanted.has('side-intake-l')) cutIntakes(panels);
  const glass = sel.tag('part:windshield').minus(sel.tag('a-pillar-l')).minus(sel.tag('a-pillar-r')).minus(sel.tag('a-pillar-l-foot')).minus(sel.tag('a-pillar-r-foot')).or(sel.tag('part:door-l-inner')).or(sel.tag('part:door-r-inner'));
  if (panels.count(glass) > 0) panels.assign(glass, 'glass');
  closedInto(m, panels, WALL);
  // The arch liners of the final car are S6c's ribbed recipe (s6c-wheels).
  for (const c of closures()) if (wanted.has(c.part) && c.kind !== 'arch-liner') m.append(c.build().snapshot());
  if (wanted.has('rear-wing')) m.append(rearWing().snapshot());
  if (wanted.has('bumper-center')) m.append(frontSplitter().snapshot());
  m.checkpoint('panels');
  roundEdges(m, ROUNDED);
  waistLine(m, wanted);
  // Triangles stay planar where the panels curve tightly and the rounds pull quad corners
  // (after the rounds, whose corner faces would otherwise meet the extra edges as slivers).
  const corners = ROUNDED.map((mat) => sel.createdBy(`round-${mat}`, 'corner')).reduce((a, b) => a.or(b));
  m.triangulate(sel.all().minus(corners));
  // Rounds meeting a trimmed opening can leave sub-0.2 mm specks and needles: collapse them.
  m.cleanup.slivers(undefined, { width: 0.0002, quiet: true });
  m.checkpoint('rounds');
}

/** A finished tire about +Y at the origin; the rim, brake and caliper are S6c's wheel recipe (s6c-wheels). */
function tire(m: Model, part: string, w: (typeof WHEELS)[number]): void {
  const r = w.d / 2;
  const rim = w.rim / 2;
  const h = w.w / 2;
  const t = model();
  t.revolve({ points: [[rim, -h], [r - 0.025, -h], [r - 0.004, -h + 0.02], [r, -h + 0.05], [r, h - 0.05], [r - 0.004, h - 0.02], [r - 0.025, h], [rim, h], [rim, -h]], segments: 72, label: `${part}-tire`, tag: `part:${part}`, material: 'tire' });
  t.uv.project({ mode: 'cylinder', axis: 'y', scale: 1, channel: 'uv1' });
  m.append(t);
}

function wheelGroup(m: Model): void {
  for (const w of WHEELS) {
    const part = `${w.z > 0 ? 'front' : 'rear'}-wheel-${w.x > 0 ? 'l' : 'r'}`;
    const one = model();
    tire(one, part, w);
    one.rotate(sel.all(), 'z', 90);
    one.translate(sel.all(), [w.x, w.d / 2, w.z]);
    m.append(one);
  }
  m.checkpoint('wheels');
  roundEdges(m, []);
}

/** One S6 part group of the car form, every part tagged `part:<id>`. */
export function buildS6(group: S6Group, session: SessionFactory = () => model()): Model {
  const m = session(group);
  if (group === 'wheels') wheelGroup(m);
  else panelGroup(m, group);
  // uv1: meters for the tiling recipes (the tires keep their cylinder unroll, the number
  // panels their patch domain for the decal sheet); uv0: the automatic atlas the bake maps use.
  const decals = sel.material('number-l').or(sel.material('number-r')).minus(sel.createdBy('round-number-l')).minus(sel.createdBy('round-number-r'));
  const boxed = sel.all().minus(sel.material('tire')).minus(decals);
  if (m.count(boxed) > 0) m.uv.project({ mode: 'box', scale: 1, faces: boxed, channel: 'uv1' });
  atlas(m, group);
  return m;
}

/**
 * The uv0 atlas of each group and its bake: the resolution per group holds one texel density
 * across the exterior (about 400 texels/m; the vented rear 512, so a louver rib spans 4 texels),
 * measured by `texelDensity` in the unit tests.
 */
export const ATLAS = { resolution: { front: 1728, nose: 1088, cabin: 1600, rear: 2304, wheels: 1408 } as Readonly<Record<S6Group, number>>, padding: 4, budget: 2e9 } as const;

/**
 * The group atlas on uv0: `uv.auto` charts every panel skin, chamfer, rim, inner wall and
 * wheel body, with the creases (where the export normals break) as hard chart boundaries.
 * The front group's C-106 panels need more than the default work budget.
 */
/** Texels per meter of the uv0 atlas over the whole group: sqrt(atlas area in texels / surface area). */
export function texelDensity(m: Model, resolution: number): number {
  const mesh = m.editMesh;
  const uv = mesh.channel('uv0');
  let surface = 0;
  let mapped = 0;
  for (const f of mesh.faces()) {
    const hs = mesh.faceHalves(f);
    const p = hs.map((h) => mesh.position(mesh.hVert[h] as number));
    const q = hs.map((h): Point2 => [uv.values[h * 2] as number, uv.values[h * 2 + 1] as number]);
    for (let k = 1; k + 1 < hs.length; k++) {
      const [o, b, c] = [p[0] as readonly number[], p[k] as readonly number[], p[k + 1] as readonly number[]];
      const u = [(b[0] as number) - (o[0] as number), (b[1] as number) - (o[1] as number), (b[2] as number) - (o[2] as number)];
      const w = [(c[0] as number) - (o[0] as number), (c[1] as number) - (o[1] as number), (c[2] as number) - (o[2] as number)];
      surface += Math.hypot((u[1] as number) * (w[2] as number) - (u[2] as number) * (w[1] as number), (u[2] as number) * (w[0] as number) - (u[0] as number) * (w[2] as number), (u[0] as number) * (w[1] as number) - (u[1] as number) * (w[0] as number)) / 2;
      const [a2, b2, c2] = [q[0] as Point2, q[k] as Point2, q[k + 1] as Point2];
      mapped += Math.abs((b2[0] - a2[0]) * (c2[1] - a2[1]) - (b2[1] - a2[1]) * (c2[0] - a2[0])) / 2;
    }
  }
  return resolution * Math.sqrt(mapped / surface);
}

function atlas(m: Model, group: S6Group): void {
  m.markSharp(sel.edges.dihedral('>', S6_NORMALS.angle));
  m.uv.auto({ resolution: ATLAS.resolution[group], padding: ATLAS.padding, budget: ATLAS.budget });
}

/**
 * LOD levels of every group (Import's meshoptimizer chain; the error is relative to the
 * group's extent): half and a quarter of the triangles, for half and a fifth of the screen.
 */
export const S6_LODS = {
  maxError: 0.004,
  levels: [
    { triangleRatio: 0.5, screenCoverage: 0.5 },
    { triangleRatio: 0.25, screenCoverage: 0.2, maxError: 0.015 },
  ],
} as const;

/** Export normals of every group, for both the bake and rendering. */
export const S6_NORMALS = { mode: 'autoSmooth', angle: 40 } as const;

/**
 * Engine-cover louvers: rounded ribs across the cover at evenly spaced stations, only on the
 * bake source; the cover gets them as a baked normal map. Each rib follows the body surface
 * S(z, t) from the shoulder toward the centerline, lifted clear of the panel by the panels'
 * 3 mm tessellation chord (on concave stretches the facets lie outside the true surface).
 */
/** Louver ribs across the engine cover, from 0.06 above its shoulder edge to t = 0.94. */
const LOUVERS = { count: 9, from: SPLITS.tail + 0.25, to: SPLITS.deck - 0.2, margin: 0.06, t1: 0.94, radius: 0.004, lift: 0.008 } as const;
const VENTED_GROUPS: Partial<Record<S6Group, readonly string[]>> = { rear: ['engine-cover-l', 'engine-cover-r'] };

/** The parts of a group whose material takes the baked normal map. */
export const VENTED = (group: S6Group): readonly string[] => VENTED_GROUPS[group] ?? [];

/** The bake source of a group: the finished group plus the louver ribs. */
export function buildS6Detail(group: S6Group, base: Model, session: SessionFactory = () => model()): Model {
  const d = session(`${group}-detail`);
  d.append(base.snapshot());
  for (const part of VENTED(group)) {
    const sign = part.endsWith('-l') ? 1 : -1;
    for (let k = 0; k < LOUVERS.count; k++) {
      const z = LOUVERS.from + ((LOUVERS.to - LOUVERS.from) * (k + 0.5)) / LOUVERS.count;
      const t0 = LINES.shoulder(z) + LOUVERS.margin;
      const path = Array.from({ length: 33 }, (_, i) => lifted(z, t0 + ((LOUVERS.t1 - t0) * i) / 32, sign, LOUVERS.radius + LOUVERS.lift));
      d.sweep({ profile: Array.from({ length: 8 }, (_, i): Point2 => [LOUVERS.radius * Math.cos((Math.PI * i) / 4), LOUVERS.radius * Math.sin((Math.PI * i) / 4)]), path, label: `louver-${part}-${k}`, tag: `part:${part}`, material: 'louvre' });
      for (const channel of ['uv0', 'uv1'] as const) d.uv.project({ mode: 'box', scale: 1, faces: sel.createdBy(`louver-${part}-${k}`), channel });
    }
  }
  return d;
}

/** Bake settings of a group: AO everywhere, the tangent-space normal where it has vents. */
export function s6Bake(group: S6Group): BakeSettings {
  return { maps: VENTED(group).length === 0 ? ['ao'] : ['normal', 'ao'], resolution: ATLAS.resolution[group], normals: S6_NORMALS, detailNormals: S6_NORMALS, ao: { rays: 32, distance: 0.12 } };
}

const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: Error }): T => {
  if (!r.ok) throw r.error;
  return r.value;
};

/**
 * The S6 material set: one Standard recipe per slot, every texture generated. Tiling
 * textures sit on uv1 (meters); uv0 is the group atlas the baked maps use, which the Pack
 * adds (`occlusionTexture` everywhere, the baked normal map on `louvre`).
 */
export function s6Materials(options: { readonly mips?: boolean } = {}): Record<string, (texture: TextureSink) => StandardMaterialOptions> {
  const placement = { set: 1, ...(options.mips === false ? { mips: false } : {}) } as const;
  const paint = (texture: TextureSink) => unwrap(proceduralMaterials.carPaint({ color: PAINT, texture, placement }));
  return {
    ...panelMaterials(options),
    paint,
    // Louvered panels: the same paint without flakes, so the baked louver normals own the normal slot.
    louvre: (texture) => unwrap(proceduralMaterials.carPaint({ color: PAINT, texture, flake: 0, placement })),
    carbon: (texture) => unwrap(proceduralMaterials.carbonFiber({ texture, placement })),
    glass: () => proceduralMaterials.glass({ tint: [0.55, 0.6, 0.62], roughness: 0.02 }),
    headlight: (texture) => unwrap(proceduralMaterials.emissive({ color: [1, 0.96, 0.9], intensity: 4, segments: { count: 6, gap: 0.35, texture }, placement: { ...placement, tile: 0.22 }, key: 'headlight' })),
    taillight: (texture) => unwrap(proceduralMaterials.emissive({ color: [1, 0.06, 0.03], intensity: 3, segments: { count: 10, gap: 0.25, texture }, placement: { ...placement, tile: 0.3 }, key: 'taillight' })),
    tire: (texture) => unwrap(proceduralMaterials.tire({ texture, pattern: 'blocks', pitch: 0.075, placement: { ...placement, rotation: 90 } })),
    rim: (texture) => unwrap(proceduralMaterials.metal({ finish: 'satin', texture, color: [0.62, 0.63, 0.66], placement })),
    chrome: () => unwrap(proceduralMaterials.metal({ finish: 'chrome' })),
    brake: (texture) => unwrap(proceduralMaterials.metal({ finish: 'brushed', texture, color: [0.45, 0.45, 0.46], placement, key: 'brake' })),
    caliper: () => ({ baseColor: [0.75, 0.42, 0.04, 1], metallic: 0.1, roughness: 0.45 }),
    // Intake backs and the nose cap: dark satin, so openings read as depth.
    intake: () => ({ baseColor: [0.025, 0.025, 0.03, 1], metallic: 0.2, roughness: 0.65 }),
  };
}
