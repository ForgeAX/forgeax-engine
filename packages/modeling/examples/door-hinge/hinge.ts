import {
  clearanceRadius,
  type Model,
  model,
  type Point2,
  type RecipePart,
  recipes,
  sel,
} from '@forgeax/engine-modeling';
import type { SessionFactory } from '../case/record.ts';

/**
 * Case C-103 (a C-100 part): the upper door hinge of the car. A hinge recipe (leaves,
 * three knuckles, a pin with a long upper overhang) is bolted with M8 bolts and nuts to
 * a body bracket on the pillar side and a door bracket on the door side. A hold-open
 * coil spring sits on the pin overhang, and a trim cover on the body bracket carries a
 * rounded rim and panel lines: a U groove along a closed edge loop (a hatch outline) and a
 * V seam cut by a plane across the front. Finally the door side opens about the pin axis (+Y).
 * Straight-line code: tools map every journal entry to its line.
 */
export interface DoorHingeParameters {
  /** Angle between the hinge leaves in degrees (180 = door flush with the body). */
  readonly openAngle: number;
}

export const DOOR_HINGE_DEFAULTS: DoorHingeParameters = { openAngle: 110 };

const LENGTH = 0.11;
const LEAF = 0.06;
const THICKNESS = 0.005;
const BRACKET = 0.008;
const GAP = 0.0003;

function unwrap(part: ReturnType<typeof recipes.hinge>): RecipePart {
  if (!part.ok) throw part.error;
  return part.value;
}

function circle(center: Point2, radius: number, n = 24): Point2[] {
  return Array.from({ length: n }, (_, i) => {
    const t = (2 * Math.PI * i) / n;
    return [center[0] + radius * Math.cos(t), center[1] + radius * Math.sin(t)] as Point2;
  });
}

function rectangle(x0: number, y0: number, x1: number, y1: number): Point2[] {
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
}

export function buildDoorHinge(
  p: DoorHingeParameters = DOOR_HINGE_DEFAULTS,
  session: SessionFactory = () => model(),
): Model {
  const hinge = unwrap(recipes.hinge({ length: LENGTH, leafWidth: LEAF, thickness: THICKNESS, pin: 0.012, knuckles: 3, holes: 2, pinOverhang: 0.05, name: 'hinge' }));
  const bolt = (name: string) => unwrap(recipes.hexBolt({ size: 'M8', length: 0.024, thread: 0.012, name }));
  const nut = (name: string) => unwrap(recipes.hexNut({ size: 'M8', name }));
  const spring = unwrap(recipes.coilSpring({ radius: 0.0095, wire: 0.0025, pitch: 0.0058, turns: 7, segments: 20, name: 'spring' }));

  const from = hinge.dimensions.leafFrom as number;
  const holeX = from + LEAF * 0.55;
  const holeY = LENGTH / 4;
  const front = THICKNESS / 2 + GAP;
  const back = -THICKNESS / 2 - GAP;
  const behind = back - BRACKET - GAP;
  const boltHole = clearanceRadius(0.004, 24);
  const springBase = (hinge.anchors.knuckleTop?.[1] ?? 0) + (hinge.dimensions.gap as number) + 0.0004;
  const coverX = from + 0.05;

  const m = session('hinge');
  // Hinge: leaves, knuckles and the pin from the recipe, laid flat (door closed flush).
  m.append(hinge.model, { tag: 'hinge' });
  // Brackets: the body bracket (with room below for the trim cover) and the door bracket.
  m.extrudePolygon({ points: rectangle(from + 0.002, -0.125, from + 0.1, 0.07), holes: [circle([holeX, -holeY], boltHole), circle([holeX, holeY], boltHole)], depth: BRACKET, label: 'body', tag: 'body' });
  m.translate(sel.createdBy('body'), [0, 0, back - BRACKET]);
  m.extrudePolygon({ points: rectangle(-from - 0.085, -0.07, -from - 0.002, 0.07), holes: [circle([-holeX, -holeY], boltHole), circle([-holeX, holeY], boltHole)], depth: BRACKET, label: 'door', tag: 'door' });
  m.translate(sel.createdBy('door'), [0, 0, back - BRACKET]);
  m.checkpoint('brackets');
  // Body side: two M8 bolts through leaf A and the body bracket, nuts behind.
  m.append(bolt('body-bolt-1').model, { translate: [holeX, -holeY, front], tag: 'body-bolt-1' });
  m.rotate(sel.tag('body-bolt-1'), 'x', 90, [holeX, -holeY, front]);
  m.append(bolt('body-bolt-2').model, { translate: [holeX, holeY, front], tag: 'body-bolt-2' });
  m.rotate(sel.tag('body-bolt-2'), 'x', 90, [holeX, holeY, front]);
  m.append(nut('body-nut-1').model, { translate: [holeX, -holeY, behind], tag: 'body-nut-1' });
  m.rotate(sel.tag('body-nut-1'), 'x', -90, [holeX, -holeY, behind]);
  m.append(nut('body-nut-2').model, { translate: [holeX, holeY, behind], tag: 'body-nut-2' });
  m.rotate(sel.tag('body-nut-2'), 'x', -90, [holeX, holeY, behind]);
  // Door side: the same through leaf B and the door bracket.
  m.append(bolt('door-bolt-1').model, { translate: [-holeX, -holeY, front], tag: 'door-bolt-1' });
  m.rotate(sel.tag('door-bolt-1'), 'x', 90, [-holeX, -holeY, front]);
  m.append(bolt('door-bolt-2').model, { translate: [-holeX, holeY, front], tag: 'door-bolt-2' });
  m.rotate(sel.tag('door-bolt-2'), 'x', 90, [-holeX, holeY, front]);
  m.append(nut('door-nut-1').model, { translate: [-holeX, -holeY, behind], tag: 'door-nut-1' });
  m.rotate(sel.tag('door-nut-1'), 'x', -90, [-holeX, -holeY, behind]);
  m.append(nut('door-nut-2').model, { translate: [-holeX, holeY, behind], tag: 'door-nut-2' });
  m.rotate(sel.tag('door-nut-2'), 'x', -90, [-holeX, holeY, behind]);
  m.checkpoint('bolted');
  // Hold-open spring: a coil on the pin overhang, resting on the top knuckle.
  m.append(spring.model, { translate: [0, springBase - (spring.anchors.bottom?.[1] ?? 0), 0], tag: 'spring' });
  // Trim cover: a box on the body bracket below the hinge, its front rim rounded.
  m.box({ size: [0.09, 0.05, 0.007], center: [coverX, -0.095, back + GAP + 0.0035], segments: [3, 3, 1], label: 'cover', tag: 'cover' });
  m.bevel(sel.createdBy('cover').and(sel.facing('+z')).boundary(), { width: 0.0015, segments: 3, label: 'cover-round' });
  // Panel lines: a U groove along the closed edge loop around the middle front cell (a
  // hatch outline), and a V seam where the plane x = cover left third crosses the front.
  m.panelLine(sel.createdBy('cover').and(sel.facing('+z')).and(sel.inBox([coverX - 0.016, -0.105, -1], [coverX + 0.016, -0.085, 1])).boundary(), { width: 0.0022, depth: 0.001, profile: 'u', label: 'cover-seam' });
  m.panelLine({ faces: sel.createdBy('cover').and(sel.facing('+z')), point: [coverX - 0.03, 0, 0], normal: [1, 0, 0] }, { width: 0.0016, depth: 0.0008, profile: 'v', label: 'cover-band' });
  m.checkpoint('trimmed');
  // Open the door: leaf B, its knuckles, the door bracket and its fasteners turn about the pin.
  m.rotate(sel.tag('hinge-b').or(sel.tag('door')).or(sel.tag('door-bolt-1')).or(sel.tag('door-bolt-2')).or(sel.tag('door-nut-1')).or(sel.tag('door-nut-2')), 'y', 180 - p.openAngle);
  m.assign(sel.tag('body').or(sel.tag('door')), 'bracket');
  m.assign(sel.tag('cover'), 'trim');
  m.uv.project({ mode: 'box', scale: 0.05 });
  return m;
}
