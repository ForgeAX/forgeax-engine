import type { Result } from '@forgeax/engine-types';
import { sin } from '../dmath';
import type { ModelingError } from '../errors';
import { model } from '../model';
import type { Point2 } from '../primitives';
import { sel } from '../selectors';
import {
  checkAll,
  finishPart,
  inRange,
  type Range,
  type RecipeNaming,
  type RecipePart,
} from './common';

export interface RackOptions extends RecipeNaming {
  /** Module m, the same as the meshing gear's (meters). */
  readonly module: number;
  readonly teeth: number;
  /** Face width along +Z, centred on z = 0 (meters). */
  readonly width: number;
  /** Body depth below the tooth roots (default 2 x module). */
  readonly height?: number;
  /** Pressure angle in degrees, the same as the meshing gear's (default 20). */
  readonly pressureAngle?: number;
  /** Thinning of every tooth at the pitch line, so a meshing gear runs clear (default 0.05 x module). */
  readonly backlash?: number;
  /** Width of the 45 degree chamfers on the tooth rims (default: as the gear recipe). */
  readonly chamfer?: number;
}

/** Declared ranges; `width`, `height`, `backlash` and `chamfer` are given in modules. */
export const RACK_RANGES = {
  module: [0.0005, 0.02],
  teeth: [2, 400],
  widthModules: [2, 30],
  heightModules: [1, 20],
  pressureAngle: [14.5, 25],
  backlashModules: [0, 0.2],
  chamferModules: [0, 0.25],
} as const satisfies Record<string, Range>;

/**
 * Involute spur rack along +X: straight flanks at the pressure angle, addendum m and
 * dedendum 1.25 m around the pitch line y = 0, tooth `k` centred at x = k * pitch
 * (pitch = pi * m), tips toward +Y, a body of `height` below the roots; label `<name>`,
 * slot `steel`, tooth rims chamfered (`<name>-chamfer`).
 *
 * Pairing with `recipes.gear` of the same module and pressure angle: put the gear centre
 * at (x, r, 0) with r = m * teeth / 2 over a tooth gap, x = (k + 1/2) * pitch, turned -90
 * degrees about Z so one of its teeth points down (-Y). Turning the gear by theta radians
 * about +Z then moves the rack by r * theta along +X. Gears with fewer than
 * `minPinionTeeth` teeth (2 / sin^2 of the pressure angle) undercut on a rack.
 * Anchors: `pitchStart`, `pitchEnd` (centres of the first and last tooth on the pitch
 * line); dimensions: `pitch`, `addendum`, `dedendum`, `length`, `height`, `backlash`,
 * `minPinionTeeth`.
 */
export function rack(options: RackOptions): Result<RecipePart, ModelingError> {
  const name = options.name ?? 'rack';
  const m = options.module;
  const pressureAngle = options.pressureAngle ?? 20;
  const height = options.height ?? 2 * m;
  const backlash = options.backlash ?? 0.05 * m;
  const checked = checkAll([
    () => inRange('module', m, RACK_RANGES.module),
    () => inRange('teeth', options.teeth, RACK_RANGES.teeth, true),
    () => inRange('width', options.width, [m * 2, m * 30]),
    () => inRange('height', height, [m, m * 20]),
    () => inRange('pressureAngle', pressureAngle, RACK_RANGES.pressureAngle),
    () => inRange('backlash', backlash, [0, 0.2 * m]),
    () => inRange('chamfer', options.chamfer ?? 0, [0, 0.25 * m]),
  ]);
  if (!checked.ok) return checked;
  const alpha = (pressureAngle * Math.PI) / 180;
  const slope = sin(alpha) / Math.sqrt(1 - sin(alpha) * sin(alpha));
  const pitch = Math.PI * m;
  const addendum = m;
  const dedendum = 1.25 * m;
  // Half tooth width at height y above the pitch line.
  const half = (y: number) => pitch / 4 - backlash / 2 - y * slope;
  const tipLand = 2 * half(addendum);
  const end = pitch / 2;
  const bottom = -dedendum - height;
  const teeth = options.teeth;
  const points: Point2[] = [
    [-end, bottom],
    [(teeth - 1) * pitch + end, bottom],
    [(teeth - 1) * pitch + end, -dedendum],
  ];
  for (let k = teeth - 1; k >= 0; k--) {
    const x = k * pitch;
    points.push([x + half(-dedendum), -dedendum]);
    points.push([x + half(addendum), addendum]);
    points.push([x - half(addendum), addendum]);
    points.push([x - half(-dedendum), -dedendum]);
  }
  points.push([-end, -dedendum]);
  const r = model();
  r.extrudePolygon({ points, depth: options.width, label: name });
  r.translate(sel.all(), [0, 0, -options.width / 2]);
  // One cap n-gon along the whole rack has collinear root vertices that ear clipping fans
  // into slivers, which collapse once a turned rack is exported in f32. Cutting at every
  // tooth gap keeps each cap piece one pitch long.
  for (let k = 0; k + 1 < teeth; k++)
    r.bisect({ point: [(k + 0.5) * pitch, 0, 0], normal: [1, 0, 0] });
  const chamfer = options.chamfer ?? Math.min(0.08 * m, 0.25 * tipLand, 0.15 * options.width);
  if (chamfer > 0) {
    const caps = sel.facing('+z').or(sel.facing('-z')).toEdges('touching');
    const teethFaces = sel.createdBy(name, 'side').minus(sel.facing('-y'));
    r.bevel(teethFaces.toEdges('touching').and(caps), {
      width: chamfer,
      segments: 1,
      label: `${name}-chamfer`,
    });
  }
  r.assign(sel.all(), 'steel');
  return finishPart(
    r,
    name,
    { pitchStart: [0, 0, 0], pitchEnd: [(teeth - 1) * pitch, 0, 0] },
    {
      pitch,
      module: m,
      addendum,
      dedendum,
      length: teeth * pitch,
      height,
      backlash,
      chamfer,
      minPinionTeeth: Math.ceil(2 / (sin(alpha) * sin(alpha))),
    },
  );
}
