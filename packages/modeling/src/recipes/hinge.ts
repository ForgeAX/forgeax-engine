import { err, type Result } from '@forgeax/engine-types';
import { atan2 } from '../dmath';
import { type ModelingError, modelingError } from '../errors';
import { type Model, model } from '../model';
import type { Point2 } from '../primitives';
import { sel } from '../selectors';
import {
  checkAll,
  circle,
  degrees,
  finishPart,
  inRange,
  type Range,
  type RecipeNaming,
  type RecipePart,
} from './common';

export interface HingeOptions extends RecipeNaming {
  /** Length along the pin axis (+Y), centred on y = 0 (meters). */
  readonly length: number;
  /** Leaf width from the knuckle to the free edge. */
  readonly leafWidth: number;
  /** Leaf plate thickness. */
  readonly thickness: number;
  /** Pin diameter. */
  readonly pin: number;
  /** Knuckle count, odd: leaf A owns the even ones, including both ends (default 5). */
  readonly knuckles?: number;
  /** Screw holes per leaf (default 3). */
  readonly holes?: number;
  /** Angle between the leaves in degrees, 180 = flat open (default 180). */
  readonly openAngle?: number;
  /** Extra pin length above the top knuckle, for a spring or a cap (default 0). */
  readonly pinOverhang?: number;
  /** Segments around the pin (default 24). */
  readonly segments?: number;
}

/** Declared ranges; leaf sizes and the pin scale with the length. */
export const HINGE_RANGES = {
  length: [0.02, 1],
  leafWidthLengths: [0.25, 1],
  thicknessLengths: [0.01, 0.05],
  pinLengths: [0.02, 0.12],
  knuckles: [3, 9],
  holes: [0, 6],
  openAngle: [20, 340],
  segments: [12, 48],
} as const satisfies Record<string, Range>;

function leaf(
  m: Model,
  label: string,
  from: number,
  width: number,
  length: number,
  thickness: number,
  holes: number,
  hole: number,
): void {
  const outline: Point2[] = [
    [from, -length / 2],
    [from + width, -length / 2],
    [from + width, length / 2],
    [from, length / 2],
  ];
  const centers = Array.from(
    { length: holes },
    (_, i) => (length * (i + 0.5)) / holes - length / 2,
  );
  m.extrudePolygon({
    points: outline,
    holes: centers.map((y) => circle(hole, 16, [from + width * 0.55, y])),
    depth: thickness,
    label,
  });
  m.translate(sel.createdBy(label), [0, 0, -thickness / 2]);
}

/**
 * Butt hinge about the +Y pin axis: two leaves with countersunk screw holes (the
 * countersinks keep the leaf label, role `bevel`)
 * (`<name>-leaf-a` along +X, `<name>-leaf-b` turned to `openAngle`), alternating
 * hollow knuckles (`<name>-knuckle-a`, `<name>-knuckle-b`) and a headed pin
 * (`<name>-pin`, slot `chrome`); leaves and knuckles use slot `steel`. Parts clear
 * each other: knuckles by an axial gap, the pin by a radial clearance. Leaf B and its
 * knuckles are tagged `<name>-b` for opening the hinge later about the Y axis.
 * Anchors: `axisTop`, `axisBottom`, `knuckleTop`; dimensions: `knuckleRadius`, `pinRadius`,
 * `headRadius`.
 */
export function hinge(options: HingeOptions): Result<RecipePart, ModelingError> {
  const name = options.name ?? 'hinge';
  const { length, leafWidth, thickness, pin } = options;
  const knuckles = options.knuckles ?? 5;
  const holes = options.holes ?? 3;
  const openAngle = options.openAngle ?? 180;
  const segments = options.segments ?? 24;
  const overhang = options.pinOverhang ?? 0;
  const checked = checkAll([
    () => inRange('length', length, HINGE_RANGES.length),
    () => inRange('leafWidth', leafWidth, [length * 0.25, length]),
    () => inRange('thickness', thickness, [length * 0.01, length * 0.05]),
    () => inRange('pin', pin, [length * 0.02, length * 0.12]),
    () => inRange('knuckles', knuckles, HINGE_RANGES.knuckles, true),
    () => inRange('holes', holes, HINGE_RANGES.holes, true),
    () => inRange('openAngle', openAngle, HINGE_RANGES.openAngle),
    () => inRange('segments', segments, HINGE_RANGES.segments, true),
    () => inRange('pinOverhang', overhang, [0, length * 0.5]),
  ]);
  if (!checked.ok) return checked;
  if (knuckles % 2 === 0) {
    return err(
      modelingError(
        'model-invalid-argument',
        'knuckles is odd',
        { knuckles },
        'pass an odd knuckle count',
      ),
    );
  }
  const hole = Math.min(leafWidth * 0.12, length / (holes * 2 + 1) / 2, thickness * 1.6);
  const bore = (pin / 2) * 1.06;
  const knuckle = bore + Math.max(thickness, pin * 0.25);
  const gap = length * 0.006;
  const pitch = (length - gap * (knuckles - 1)) / knuckles;
  const from = knuckle * 1.02;
  const closest = degrees(2 * atan2(thickness / 2, from)) + 2;
  const angleOk = inRange('openAngle', openAngle, [closest, 360 - closest]);
  if (!angleOk.ok) return angleOk;
  const m = model();
  leaf(m, `${name}-leaf-a`, from, leafWidth, length, thickness, holes, hole);
  leaf(m, `${name}-leaf-b`, from, leafWidth, length, thickness, holes, hole);
  m.rotate(sel.createdBy(`${name}-leaf-b`), 'y', 180);
  if (holes > 0) {
    // 45 degree countersinks for flat-head screws, on the face both leaves show when the
    // hinge lies flat (+Z): leaf B is turned over, so its countersinks go in its bottom.
    for (const [label, face] of [
      [`${name}-leaf-a`, 'top'],
      [`${name}-leaf-b`, 'bottom'],
    ] as const) {
      m.bevel(
        sel
          .createdBy(label, 'hole')
          .toEdges('touching')
          .and(sel.createdBy(label, face).toEdges('touching')),
        {
          width: Math.min(0.4 * hole, 0.45 * thickness),
          segments: 1,
          label,
        },
      );
    }
  }
  for (let i = 0; i < knuckles; i++) {
    const y0 = -length / 2 + i * (pitch + gap);
    m.revolve({
      points: [
        [bore, y0],
        [knuckle, y0],
        [knuckle, y0 + pitch],
        [bore, y0 + pitch],
        [bore, y0],
      ],
      segments,
      label: `${name}-knuckle-${i % 2 === 0 ? 'a' : 'b'}`,
    });
  }
  const head = length * 0.03;
  const end = length / 2 + gap;
  const rp = pin / 2;
  m.revolve({
    points: [
      [0, -end - head],
      [knuckle * 0.9, -end - head],
      [knuckle * 0.9, -end],
      [rp, -end],
      [rp, end + overhang],
      [knuckle * 0.9, end + overhang],
      [knuckle * 0.9, end + overhang + head],
      [0, end + overhang + head],
    ],
    segments,
    label: `${name}-pin`,
  });
  const partB = sel.createdBy(`${name}-leaf-b`).or(sel.createdBy(`${name}-knuckle-b`));
  m.tag(partB, `${name}-b`);
  if (openAngle !== 180) m.rotate(sel.tag(`${name}-b`), 'y', 180 - openAngle);
  m.assign(sel.all(), 'steel');
  m.assign(sel.createdBy(`${name}-pin`), 'chrome');
  return finishPart(
    m,
    name,
    {
      axisTop: [0, end + overhang + head, 0],
      axisBottom: [0, -end - head, 0],
      knuckleTop: [0, length / 2, 0],
    },
    { knuckleRadius: knuckle, pinRadius: rp, headRadius: knuckle * 0.9, leafFrom: from, hole, gap },
  );
}
