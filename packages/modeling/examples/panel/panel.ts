import { type Model, model, sel } from '@forgeax/engine-modeling';
import type { SessionFactory } from '../case/record.ts';

/**
 * Case C-011: an equipment panel cut and joined with the boolean compute jobs. A
 * chamfered plate gets a 2 x 4 mounting-hole array (one difference with eight tool
 * components), four rounded vent slots (each slot itself a union of a box and two
 * cylinders), a flush pocket with a boss unioned onto its floor and bored through
 * (nested differences on coplanar faces), a U-handle unioned from two posts and a
 * bar, a domed knob made by intersecting a cylinder with a sphere, and an access
 * cover split out of the plate with splitBy and lifted. Straight-line code: tools map
 * every journal entry back to the call on its source line.
 */
export interface PanelParameters {
  /** Extent along X (meters). */
  readonly width: number;
  /** Extent along Z (meters). */
  readonly depth: number;
  /** Plate thickness (meters). */
  readonly thickness: number;
}

export const PANEL_DEFAULTS: PanelParameters = { width: 0.32, depth: 0.2, thickness: 0.012 };


export function buildPanel(
  p: PanelParameters = PANEL_DEFAULTS,
  session: SessionFactory = () => model(),
): Model {
  const w = p.width / 2;
  const d = p.depth / 2;
  const t = p.thickness;
  const c = Math.min(w, d) * 0.15;
  const pitch = (p.width - 0.08) / 3;
  const row = d - 0.018;
  const slotX = w * 0.375;
  const slotLength = p.depth * 0.35;
  const pocketX = -w * 0.44;
  const pocketWidth = w * 0.75;
  const pocketDepth = t / 2;
  const floor = t - pocketDepth;
  const handleX = w * 0.14;
  const knobX = w * 0.84;

  // Plate: a chamfered outline extruded and laid flat (top face at y = thickness).
  const m = session('panel');
  m.extrudePolygon({ points: [[-w + c, -d], [w - c, -d], [w, -d + c], [w, d - c], [w - c, d], [-w + c, d], [-w, d - c], [-w, -d + c]], depth: t, label: 'plate', tag: 'panel' });
  m.rotate(sel.all(), 'x', -90);

  // Mounting holes: one drill bit doubled into a 2 x 4 array (eight closed components).
  const drills = session('drills');
  drills.cylinder({ radiusTop: 0.0045, radiusBottom: 0.0045, height: t * 3, radialSegments: 16, center: [-w + 0.04, t / 2, -row], label: 'bit' });
  drills.duplicate(sel.all(), { label: 'pair' });
  drills.translate(sel.createdBy('pair', 'copy'), [pitch, 0, 0]);
  drills.duplicate(sel.all(), { label: 'quad' });
  drills.translate(sel.createdBy('quad', 'copy'), [pitch * 2, 0, 0]);
  drills.duplicate(sel.all(), { label: 'rows' });
  drills.translate(sel.createdBy('rows', 'copy'), [0, 0, row * 2]);
  m.difference(drills, { label: 'drill', tag: 'holes' });

  // Vent slots: a box with two round ends (a union), doubled into four rounded slots.
  const ends = session('ends');
  ends.cylinder({ radiusTop: 0.004, radiusBottom: 0.004, height: t * 3, radialSegments: 16, center: [slotX, t / 2, -slotLength / 2], label: 'end' });
  ends.duplicate(sel.all(), { label: 'far-end' });
  ends.translate(sel.createdBy('far-end', 'copy'), [0, 0, slotLength]);
  const slots = session('slots');
  slots.box({ size: [0.008, t * 3, slotLength], center: [slotX, t / 2, 0], label: 'slot' });
  slots.union(ends, { label: 'slot-ends' });
  slots.duplicate(sel.all(), { label: 'slot-2' });
  slots.translate(sel.createdBy('slot-2', 'copy'), [0.016, 0, 0]);
  slots.duplicate(sel.all(), { label: 'slot-4' });
  slots.translate(sel.createdBy('slot-4', 'copy'), [0.032, 0, 0]);
  m.difference(slots, { label: 'vent', tag: 'vents' });

  // Pocket flush with the top, a boss unioned onto its floor, then bored through.
  const pocket = session('pocket');
  pocket.box({ size: [pocketWidth, pocketDepth + 0.01, p.depth * 0.55], center: [pocketX, floor + (pocketDepth + 0.01) / 2, 0], label: 'recess' });
  m.difference(pocket, { label: 'pocket', tag: 'pocket' });
  const boss = session('boss');
  boss.cylinder({ radiusTop: 0.018, radiusBottom: 0.018, height: pocketDepth * 0.8, radialSegments: 24, center: [pocketX, floor + pocketDepth * 0.3, 0], label: 'post' });
  m.union(boss, { label: 'boss', tag: 'boss' });
  const bore = session('bore');
  bore.cylinder({ radiusTop: 0.007, radiusBottom: 0.007, height: t * 3, radialSegments: 16, center: [pocketX, t / 2, 0], label: 'bit' });
  m.difference(bore, { label: 'bore', tag: 'bore' });

  // U-handle: two posts and a bar unioned, then unioned onto the plate.
  const handle = session('handle');
  handle.box({ size: [0.012, 0.034, 0.012], center: [handleX, t + 0.015, -0.04], label: 'post', tag: 'handle' });
  handle.box({ size: [0.012, 0.034, 0.012], center: [handleX, t + 0.015, 0.04], label: 'post', tag: 'handle' });
  const bar = session('bar');
  bar.cylinder({ radiusTop: 0.0065, radiusBottom: 0.0065, height: 0.1, radialSegments: 16, label: 'grip', tag: 'handle' });
  bar.rotate(sel.all(), 'x', 90);
  bar.translate(sel.all(), [handleX, t + 0.03, 0]);
  handle.union(bar, { label: 'grip' });
  m.union(handle, { label: 'handle' });

  // Knob: a cylinder intersected with a sphere gives a domed button.
  const knob = session('knob');
  knob.cylinder({ radiusTop: 0.012, radiusBottom: 0.012, height: 0.02, radialSegments: 24, center: [knobX, t + 0.006, 0], label: 'stem', tag: 'knob' });
  const dome = session('dome');
  dome.sphere({ radius: 0.02, widthSegments: 24, heightSegments: 12, label: 'dome' });
  dome.translate(sel.all(), [knobX, t - 0.006, 0]);
  knob.intersection(dome, { label: 'crown', tag: 'knob' });
  m.union(knob, { label: 'knob' });

  // Access cover: split out of the plate between the slots and the hole row, then lifted.
  const cover = session('cover');
  cover.box({ size: [w * 0.4, t * 3, 0.02], center: [slotX + 0.02, t / 2, d * 0.6], label: 'outline' });
  m.splitBy(cover, { label: 'cover', tag: 'cover' });
  m.translate(sel.createdBy('cover', 'piece'), [0, 0.004, 0]);

  m.markSharp(sel.edges.dihedral('>', 30));
  m.assign(sel.tag('panel').or(sel.createdBy('cover', 'cutB')), 'aluminum');
  m.assign(sel.tag('pocket').or(sel.tag('boss')), 'anodized');
  m.assign(sel.createdBy('drill', 'cutB').or(sel.createdBy('bore', 'cutB')).or(sel.createdBy('vent', 'cutB')), 'bore');
  m.assign(sel.tag('handle'), 'rubber');
  m.assign(sel.tag('knob'), 'knob');
  m.assign(sel.createdBy('cover', 'piece'), 'cover');
  m.uv.project({ mode: 'box', scale: 0.1 });
  return m;
}
