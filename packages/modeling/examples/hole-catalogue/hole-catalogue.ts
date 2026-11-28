import { type Model, model, type Point2, recipes, sel, threads } from '@forgeax/engine-modeling';
import type { SessionFactory } from '../case/record.ts';

/**
 * Case SC-L3: the hole operator. One plate carries the four hole kinds twice, through
 * (row at +Z) and blind (row at -Z): simple, counterbore, countersink and a cosmetic M8 tap.
 * A second plate holds a real helical M8 thread (`threadGeometry: 'modeled'`) with a modeled
 * hex bolt seated in it, four pitches above the face so the thread phases agree without
 * turning the bolt; it is appended beside the catalogue plate. Straight-line code: tools
 * map every journal entry to its line.
 */
export interface HoleCatalogueParameters {
  /** Depth of the blind row in meters (the plates are 20 mm thick). */
  readonly blindDepth: number;
}

export const HOLE_CATALOGUE_DEFAULTS: HoleCatalogueParameters = { blindDepth: 0.012 };

const THICKNESS = 0.02;
const TOP = sel.facing('+y');

export function buildHoleCatalogue(
  p: HoleCatalogueParameters = HOLE_CATALOGUE_DEFAULTS,
  session: SessionFactory = () => model(),
): Model {
  const pitch = threads.lookup('M8');
  if (!pitch.ok) throw pitch.error;
  const seat = 4 * pitch.value.pitch;
  const columns = [-0.054, -0.018, 0.018, 0.054];
  const row = (z: number): Point2[] => columns.map((x) => [z, x] as Point2);
  const at = (z: number, column: number): Point2[] => [row(z)[column] as Point2];

  const assembly = session('assembly');
  assembly.box({ size: [0.04, THICKNESS, 0.04], center: [0, -THICKNESS / 2, 0], label: 'lower' });
  assembly.hole(sel.createdBy('lower').and(TOP), {
    kind: 'tapped',
    thread: 'M8',
    depth: 'through',
    threadGeometry: 'modeled',
    centers: [[0, 0]],
    label: 'lower-hole',
  });
  const bolt = recipes.hexBolt({
    size: 'M8',
    length: seat + 0.012,
    threadGeometry: 'modeled',
    segments: 24,
  });
  if (!bolt.ok) throw bolt.error;
  assembly.append(bolt.value.model, { translate: [0, seat, 0], tag: 'bolt' });

  const m = session('catalogue');
  m.box({ size: [0.16, THICKNESS, 0.08], center: [0, -THICKNESS / 2, 0], label: 'plate' });
  const face = sel.createdBy('plate').and(TOP);
  m.hole(face, { kind: 'simple', diameter: 0.008, depth: 'through', centers: at(0.02, 0), label: 'through-simple' });
  m.hole(face, {
    kind: 'counterbore',
    diameter: 0.006,
    counterbore: { diameter: 0.012, depth: 0.006 },
    depth: 'through',
    centers: at(0.02, 1),
    label: 'through-counterbore',
  });
  m.hole(face, {
    kind: 'countersink',
    diameter: 0.006,
    countersink: { diameter: 0.012 },
    depth: 'through',
    centers: at(0.02, 2),
    label: 'through-countersink',
  });
  m.hole(face, { kind: 'tapped', thread: 'M8', depth: 'through', centers: at(0.02, 3), label: 'through-tapped' });
  m.hole(face, { kind: 'simple', diameter: 0.008, depth: p.blindDepth, centers: at(-0.02, 0), label: 'blind-simple' });
  m.hole(face, {
    kind: 'counterbore',
    diameter: 0.006,
    counterbore: { diameter: 0.012, depth: 0.004 },
    depth: p.blindDepth,
    centers: at(-0.02, 1),
    label: 'blind-counterbore',
  });
  m.hole(face, {
    kind: 'countersink',
    diameter: 0.006,
    countersink: { diameter: 0.012 },
    depth: p.blindDepth,
    centers: at(-0.02, 2),
    label: 'blind-countersink',
  });
  m.hole(face, { kind: 'tapped', thread: 'M8', depth: p.blindDepth, centers: at(-0.02, 3), label: 'blind-tapped' });
  m.append(assembly, { translate: [0.13, 0, 0] });
  m.uv.project({ mode: 'box', scale: 0.5 });
  return m;
}
