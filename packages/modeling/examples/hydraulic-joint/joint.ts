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
 * Case C-102 (a C-100 part): the hydraulic joint of a mech limb. A base plate carries
 * a pivot tower and a clevis; an arm fork turns on the tower pin in two ball bearings
 * and is driven by a hydraulic cylinder pinned between the clevis and the fork. Every
 * mechanical part comes from `recipes.*`; the brackets are plain extrusions with
 * holes. The cylinder extension sets the arm angle (two-circle closure), so the
 * assembly stays consistent for any extension. Pin axes run along Z. Straight-line
 * code: tools map every journal entry to its line.
 */
export interface JointParameters {
  /** Cylinder extension as a fraction of its stroke. */
  readonly extension: number;
}

export const JOINT_DEFAULTS: JointParameters = { extension: 0.5 };

/** Main pivot, cylinder base pin and arm lever length (meters). */
export const PIVOT: Point2 = [0, 0.3];
export const BASE_PIN: Point2 = [0.2, 0.05];
const LEVER = 0.2;
const PLATE = 0.008;
const GAP = 0.0015;
const TOWER = 0.01;

function unwrap(part: ReturnType<typeof recipes.gear>): RecipePart {
  if (!part.ok) throw part.error;
  return part.value;
}

/** Arm pin position: the circle of the lever around the pivot meets the cylinder length. */
export function armPin(pinToPin: number): Point2 {
  const dx = BASE_PIN[0] - PIVOT[0];
  const dy = BASE_PIN[1] - PIVOT[1];
  const d = Math.hypot(dx, dy);
  const a = (LEVER * LEVER - pinToPin * pinToPin + d * d) / (2 * d);
  const h = Math.sqrt(LEVER * LEVER - a * a);
  const mx = PIVOT[0] + (a * dx) / d;
  const my = PIVOT[1] + (a * dy) / d;
  const one: Point2 = [mx - (h * dy) / d, my + (h * dx) / d];
  const two: Point2 = [mx + (h * dy) / d, my - (h * dx) / d];
  return one[1] > two[1] ? one : two;
}

/** Convex outline around two circles: half discs at both ends joined by straight sides. */
function link(a: Point2, ra: number, b: Point2, rb: number, n = 12): Point2[] {
  const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
  const out: Point2[] = [];
  for (let i = 0; i <= n; i++) {
    const t = angle + Math.PI / 2 + (Math.PI * i) / n;
    out.push([a[0] + ra * Math.cos(t), a[1] + ra * Math.sin(t)]);
  }
  for (let i = 0; i <= n; i++) {
    const t = angle - Math.PI / 2 + (Math.PI * i) / n;
    out.push([b[0] + rb * Math.cos(t), b[1] + rb * Math.sin(t)]);
  }
  return out;
}

/** Upper half circle from angle 0 to 180 degrees, counter-clockwise. */
function arch(center: Point2, radius: number, n = 12): Point2[] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = (Math.PI * i) / n;
    return [center[0] + radius * Math.cos(t), center[1] + radius * Math.sin(t)] as Point2;
  });
}

function hole(center: Point2, radius: number, n = 24): Point2[] {
  return Array.from({ length: n }, (_, i) => {
    const t = (2 * Math.PI * i) / n;
    return [center[0] + radius * Math.cos(t), center[1] + radius * Math.sin(t)] as Point2;
  });
}

export function buildJoint(
  p: JointParameters = JOINT_DEFAULTS,
  session: SessionFactory = () => model(),
): Model {
  const cylinder = unwrap(recipes.hydraulicCylinder({ bore: 0.05, rod: 0.028, stroke: 0.15, extension: p.extension, pin: 0.0102, name: 'cylinder' }));
  const bearingFront = unwrap(recipes.ballBearing({ bore: 0.014, outer: 0.032, width: PLATE, name: 'bearing-front' }));
  const bearingBack = unwrap(recipes.ballBearing({ bore: 0.014, outer: 0.032, width: PLATE, name: 'bearing-back' }));
  const pivotBolt = unwrap(recipes.hexBolt({ size: 'M12', length: 0.13, name: 'pivot-bolt' }));
  const pivotNut = unwrap(recipes.hexNut({ size: 'M12', name: 'pivot-nut' }));
  const pivotWasher = unwrap(recipes.washer({ size: 'M12', name: 'pivot-washer' }));
  const baseBolt = unwrap(recipes.hexBolt({ size: 'M10', length: 0.056, name: 'base-pin' }));
  const baseNut = unwrap(recipes.hexNut({ size: 'M10', name: 'base-nut' }));
  const armBolt = unwrap(recipes.hexBolt({ size: 'M10', length: 0.096, name: 'arm-pin' }));
  const armNut = unwrap(recipes.hexNut({ size: 'M10', name: 'arm-nut' }));
  const anchor = unwrap(recipes.hexBolt({ size: 'M8', length: 0.024, name: 'anchor' }));

  const eyeHalf = (cylinder.dimensions.eyeThickness as number) / 2;
  const clevis = eyeHalf + GAP;
  // The fork clears the barrel radius, so the arm never meets the cylinder at any angle.
  const inner = 0.031 + GAP;
  const outer = inner + PLATE;
  const tower = outer + GAP;
  const spacer = clearanceRadius(0.005, 24);
  const arm = armPin(cylinder.dimensions.pinToPin as number);
  const axis = Math.atan2(arm[0] - BASE_PIN[0], arm[1] - BASE_PIN[1]);
  const pinHole = clearanceRadius(0.005, 24);
  const pivotHole = clearanceRadius(0.006, 24);
  const bearingHole = clearanceRadius(0.016, 32, 0.01);
  const washerTop = tower + TOWER + 0.0024;
  const corners: Point2[] = [[-0.07, -0.05], [0.25, -0.05], [0.25, 0.05], [-0.07, 0.05]];

  const m = session('joint');
  // Base plate: a slab with four anchor holes, laid flat under y = 0.
  m.extrudePolygon({ points: [[-0.1, -0.08], [0.28, -0.08], [0.28, 0.08], [-0.1, 0.08]], holes: corners.map((c) => hole(c, clearanceRadius(0.004, 24))), depth: 0.012, label: 'base', tag: 'frame' });
  m.rotate(sel.createdBy('base'), 'x', -90);
  m.translate(sel.createdBy('base'), [0, -0.012, 0]);
  // Pivot tower: two tapered plates outside the arm fork, drilled for the M12 pivot.
  m.extrudePolygon({ points: [[-0.05, 0], [0.05, 0], ...arch(PIVOT, 0.03)], holes: [hole(PIVOT, pivotHole)], depth: TOWER, label: 'tower', tag: 'frame' });
  m.translate(sel.createdBy('tower'), [0, 0, tower]);
  m.extrudePolygon({ points: [[-0.05, 0], [0.05, 0], ...arch(PIVOT, 0.03)], holes: [hole(PIVOT, pivotHole)], depth: TOWER, label: 'tower-back', tag: 'frame' });
  m.translate(sel.createdBy('tower-back'), [0, 0, -tower - TOWER]);
  // Clevis: two ears either side of the cylinder base eye, inside its axial reach.
  m.extrudePolygon({ points: [[BASE_PIN[0] - 0.017, 0], [BASE_PIN[0] + 0.017, 0], ...arch(BASE_PIN, 0.017)], holes: [hole(BASE_PIN, pinHole)], depth: PLATE, label: 'clevis', tag: 'frame' });
  m.translate(sel.createdBy('clevis'), [0, 0, clevis]);
  m.extrudePolygon({ points: [[BASE_PIN[0] - 0.017, 0], [BASE_PIN[0] + 0.017, 0], ...arch(BASE_PIN, 0.017)], holes: [hole(BASE_PIN, pinHole)], depth: PLATE, label: 'clevis-back', tag: 'frame' });
  m.translate(sel.createdBy('clevis-back'), [0, 0, -clevis - PLATE]);
  m.checkpoint('frame');
  // Cylinder: placed with its base eye on the clevis pin, then turned onto the arm pin.
  m.append(cylinder.model, { translate: [BASE_PIN[0], BASE_PIN[1] - (cylinder.anchors.baseEye?.[1] ?? 0), 0], tag: 'cylinder' });
  m.rotate(sel.tag('cylinder'), 'z', (-axis * 180) / Math.PI, [BASE_PIN[0], BASE_PIN[1], 0]);
  // Arm fork: two links from the pivot to the rod eye, bored for the bearings and the pin.
  m.extrudePolygon({ points: link(PIVOT, 0.024, arm, 0.017), holes: [hole(PIVOT, bearingHole, 32), hole(arm, pinHole)], depth: PLATE, label: 'arm', tag: 'arm' });
  m.translate(sel.createdBy('arm'), [0, 0, inner]);
  m.extrudePolygon({ points: link(PIVOT, 0.024, arm, 0.017), holes: [hole(PIVOT, bearingHole, 32), hole(arm, pinHole)], depth: PLATE, label: 'arm-back', tag: 'arm' });
  m.translate(sel.createdBy('arm-back'), [0, 0, -outer]);
  // Spacers: tubes on the arm pin that centre the rod eye in the wide fork.
  m.revolve({ points: [[spacer, eyeHalf + 0.0005], [0.009, eyeHalf + 0.0005], [0.009, inner - 0.0005], [spacer, inner - 0.0005], [spacer, eyeHalf + 0.0005]], segments: 24, label: 'spacer', tag: 'spacer' });
  m.revolve({ points: [[spacer, -inner + 0.0005], [0.009, -inner + 0.0005], [0.009, -eyeHalf - 0.0005], [spacer, -eyeHalf - 0.0005], [spacer, -inner + 0.0005]], segments: 24, label: 'spacer', tag: 'spacer' });
  m.rotate(sel.tag('spacer'), 'x', 90);
  m.translate(sel.tag('spacer'), [arm[0], arm[1], 0]);
  m.checkpoint('linkage');
  // Bearings: one pressed into each arm link, turned so their axes run along Z.
  m.append(bearingFront.model, { translate: [PIVOT[0], PIVOT[1], inner + PLATE / 2], tag: 'bearing-front' });
  m.rotate(sel.tag('bearing-front'), 'x', 90, [PIVOT[0], PIVOT[1], inner + PLATE / 2]);
  m.append(bearingBack.model, { translate: [PIVOT[0], PIVOT[1], -inner - PLATE / 2], tag: 'bearing-back' });
  m.rotate(sel.tag('bearing-back'), 'x', 90, [PIVOT[0], PIVOT[1], -inner - PLATE / 2]);
  // Pivot: an M12 bolt through tower, bearings and tower, with washers and a nut.
  m.append(pivotWasher.model, { translate: [PIVOT[0], PIVOT[1], tower + TOWER + 0.0003], tag: 'pivot-washer' });
  m.rotate(sel.tag('pivot-washer'), 'x', 90, [PIVOT[0], PIVOT[1], tower + TOWER + 0.0003]);
  m.append(pivotBolt.model, { translate: [PIVOT[0], PIVOT[1], washerTop + 0.0006], tag: 'pivot-bolt' });
  m.rotate(sel.tag('pivot-bolt'), 'x', 90, [PIVOT[0], PIVOT[1], washerTop + 0.0006]);
  m.append(pivotNut.model, { translate: [PIVOT[0], PIVOT[1], -tower - TOWER - 0.0003], tag: 'pivot-nut' });
  m.rotate(sel.tag('pivot-nut'), 'x', -90, [PIVOT[0], PIVOT[1], -tower - TOWER - 0.0003]);
  // Cylinder pins: M10 bolts and nuts through the clevis and through the arm fork.
  m.append(baseBolt.model, { translate: [BASE_PIN[0], BASE_PIN[1], clevis + PLATE + 0.0005], tag: 'base-pin' });
  m.rotate(sel.tag('base-pin'), 'x', 90, [BASE_PIN[0], BASE_PIN[1], clevis + PLATE + 0.0005]);
  m.append(baseNut.model, { translate: [BASE_PIN[0], BASE_PIN[1], -clevis - PLATE - 0.0005], tag: 'base-nut' });
  m.rotate(sel.tag('base-nut'), 'x', -90, [BASE_PIN[0], BASE_PIN[1], -clevis - PLATE - 0.0005]);
  m.append(armBolt.model, { translate: [arm[0], arm[1], outer + 0.0005], tag: 'arm-pin' });
  m.rotate(sel.tag('arm-pin'), 'x', 90, [arm[0], arm[1], outer + 0.0005]);
  m.append(armNut.model, { translate: [arm[0], arm[1], -outer - 0.0005], tag: 'arm-nut' });
  m.rotate(sel.tag('arm-nut'), 'x', -90, [arm[0], arm[1], -outer - 0.0005]);
  // Anchors: four M8 bolts standing in the base plate holes.
  m.append(anchor.model, { translate: [corners[0]?.[0] ?? 0, 0.0005, -(corners[0]?.[1] ?? 0)], tag: 'anchor' });
  m.append(anchor.model, { translate: [corners[1]?.[0] ?? 0, 0.0005, -(corners[1]?.[1] ?? 0)], tag: 'anchor' });
  m.append(anchor.model, { translate: [corners[2]?.[0] ?? 0, 0.0005, -(corners[2]?.[1] ?? 0)], tag: 'anchor' });
  m.append(anchor.model, { translate: [corners[3]?.[0] ?? 0, 0.0005, -(corners[3]?.[1] ?? 0)], tag: 'anchor' });
  m.checkpoint('assembled');
  m.assign(sel.tag('frame'), 'frame');
  m.assign(sel.tag('arm'), 'arm');
  m.assign(sel.tag('spacer'), 'steel');
  m.uv.project({ mode: 'box', scale: 0.1 });
  return m;
}
