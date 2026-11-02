import { type BakeResult, type BakeSettings, bakeMaps, type Model, model, sel } from '@forgeax/engine-modeling';
import type { SessionFactory } from '../case/record.ts';

/**
 * Case C-110 (C-100 part, code name mech-gt): a detail map bake for the mech's left
 * shoulder armor. The detail plate carries a vent grille (inset + sunk slots), two
 * panel line grooves and a row of bolts; the low-poly base is the same plate as a
 * 6 x 4 grid. Both get the same dome, taper and curl. `uv.auto` charts the base
 * (sharp rims as hard boundaries), and one bake pass maps the detail onto it as
 * tangent-space normal, ambient occlusion and material-id maps.
 * Straight-line code: tools map every journal entry back to its source line.
 */
export interface ArmorParameters {
  /** Plate length across the shoulder before the curl (meters). */
  readonly length: number;
  /** Plate width front to back (meters). */
  readonly width: number;
  /** Curl over the shoulder (degrees). */
  readonly curl: number;
  /** Texels per side of the baked maps. */
  readonly resolution: number;
}

export const ARMOR_DEFAULTS: ArmorParameters = { length: 0.7, width: 0.9, curl: 50, resolution: 512 };

/** Plate thickness (meters). */
const THICK = 0.06;
/** Bolt heads along the front and back rim: [x, z] as fractions of length and width. */
const BOLTS: readonly (readonly [number, number])[] = [
  [-0.36, -0.43],
  [-0.12, -0.43],
  [0.12, -0.43],
  [-0.36, 0.43],
  [-0.12, 0.43],
  [0.12, 0.43],
];

/** Export normals of the base for both the bake and rendering (tangent frame gate). */
export const BASE_NORMALS = { mode: 'autoSmooth', angle: 40 } as const;

/** The C-110 bake: tangent-space normal, AO and material ids, one mip level. */
export function armorBake(p: ArmorParameters): BakeSettings {
  return { maps: ['normal', 'ao', 'materialId'], resolution: p.resolution, normals: BASE_NORMALS, detailNormals: BASE_NORMALS, mips: false, ao: { rays: 32, distance: 0.05 } };
}

export interface ArmorParts {
  readonly base: Model;
  readonly detail: Model;
}

export interface Armor extends ArmorParts {
  readonly bake: BakeResult;
}

export function buildArmorParts(p: ArmorParameters = ARMOR_DEFAULTS, session: SessionFactory = () => model()): ArmorParts {
  const half = p.length / 2;
  const top = THICK / 2;
  const cellX = p.length / 24;
  const cellZ = p.width / 16;
  // Explicit deformation frames: the bolts must not change the bounds the shape follows.
  const shape: { min: [number, number, number]; max: [number, number, number] } = { min: [-half, -top, -p.width / 2], max: [half, top, p.width / 2] };

  // Detail plate: a dense grid with a vent grille, panel lines and bolts on top.
  const d = session('detail');
  d.box({ size: [p.length, THICK, p.width], segments: [24, 1, 16], label: 'plate', tag: 'armor', material: 'paint' });
  d.inset(sel.tag('armor').and(sel.facing('+y')).and(sel.inBox([cellX * 3, -1, -cellZ * 3], [cellX * 9, 1, cellZ * 3])), { thickness: 0.009, region: 'perFace', label: 'vent' });
  d.extrude(sel.createdBy('vent', 'inner'), { distance: -0.012, region: 'perFace', label: 'vent-slot' });
  d.panelLine({ faces: sel.tag('armor').and(sel.facing('+y')), point: [-cellX * 4.5, 0, 0], normal: [1, 0, 0] }, { width: 0.006, depth: 0.004, label: 'seam-cross', material: 'groove' });
  d.panelLine({ faces: sel.tag('armor').and(sel.facing('+y')).and(sel.inBox([-cellX * 3.5, -1, -1], [1, 1, 1])), point: [0, 0, -cellZ * 4.5], normal: [0, 0, 1] }, { width: 0.005, depth: 0.003, label: 'seam-front', material: 'groove' });
  d.panelLine({ faces: sel.tag('armor').and(sel.facing('+y')).and(sel.inBox([-cellX * 3.5, -1, -1], [1, 1, 1])), point: [0, 0, cellZ * 4.5], normal: [0, 0, 1] }, { width: 0.005, depth: 0.003, label: 'seam-back', material: 'groove' });
  for (const [bx, bz] of BOLTS) {
    d.cylinder({ radiusTop: 0.011, radiusBottom: 0.014, height: 0.009, radialSegments: 16, center: [bx * p.length, top + 0.0045, bz * p.width], tag: 'bolt' });
  }
  d.assign(sel.createdBy('vent-slot'), 'vent');
  d.assign(sel.tag('bolt'), 'bolt');
  d.lattice(sel.all(), { resolution: [3, 2, 3], bounds: shape, offsets: [{ index: [1, 0, 1], offset: [0, 0.05, 0] }, { index: [1, 1, 1], offset: [0, 0.05, 0] }] });
  d.taper(sel.all(), { axis: 'x', factor: 0.8, axes: ['z'], range: [-half, half], origin: [0, 0, 0] });
  d.bend(sel.all(), { axis: 'x', toward: '-y', angle: p.curl, range: [-half + 0.1, half], origin: [0, 0, 0] });
  d.uv.project({ mode: 'box', scale: 0.25 });

  // Low-poly base: the same plate as a 6 x 4 grid, shaped identically.
  const b = session('base');
  b.box({ size: [p.length, THICK, p.width], segments: [6, 1, 4], label: 'plate', tag: 'armor' });
  b.lattice(sel.all(), { resolution: [3, 2, 3], bounds: shape, offsets: [{ index: [1, 0, 1], offset: [0, 0.05, 0] }, { index: [1, 1, 1], offset: [0, 0.05, 0] }] });
  b.taper(sel.all(), { axis: 'x', factor: 0.8, axes: ['z'], range: [-half, half], origin: [0, 0, 0] });
  b.bend(sel.all(), { axis: 'x', toward: '-y', angle: p.curl, range: [-half + 0.1, half], origin: [0, 0, 0] });
  b.markSharp(sel.edges.dihedral('>', 40));
  b.assign(sel.all(), 'baked');
  b.uv.auto({ resolution: p.resolution, padding: 8 });
  return { base: b, detail: d };
}

/** Parts plus one correspondence pass onto the base (in place; Packs defer it with bakeSources). */
export function buildArmor(p: ArmorParameters = ARMOR_DEFAULTS, session: SessionFactory = () => model()): Armor {
  const parts = buildArmorParts(p, session);
  const baked = bakeMaps({ base: parts.base, detail: parts.detail, ...armorBake(p) });
  if (!baked.ok) throw baked.error;
  return { ...parts, bake: baked.value };
}
