import { err, ok, type Result } from '@forgeax/engine-types';
import { atan, cos, sin } from '../dmath';
import { type ModelingError, modelingError } from '../errors';
import { model } from '../model';
import type { Point2 } from '../primitives';
import { sel } from '../selectors';
import {
  checkAll,
  circle,
  finishPart,
  inRange,
  type Range,
  type RecipeNaming,
  type RecipePart,
} from './common';

export interface GearOptions extends RecipeNaming {
  /** Module m = pitch diameter / teeth (meters). */
  readonly module: number;
  readonly teeth: number;
  /** Face width along +Z, centred on z = 0 (meters). */
  readonly width: number;
  /** Bore diameter (default: 0.6 x pitch radius, at most 1.2 x the rim radius). */
  readonly bore?: number;
  /** Pressure angle in degrees (default 20). */
  readonly pressureAngle?: number;
  /** Lightening holes through the web between hub and rim (default 0). */
  readonly webHoles?: number;
  /** Segments per involute flank (default 4). */
  readonly flankSegments?: number;
  /**
   * Width of the 45 degree chamfers on both tooth rims and on the bore (meters, default
   * 0.08 x module; 0 = sharp). Each chamfer stays below a quarter of the tooth tip land and
   * of the face width, so the declared ranges never clamp it.
   */
  readonly chamfer?: number;
  /** Hub protrusion beyond each gear face (meters, default 0 = flush, no separate hub). */
  readonly hubLength?: number;
  /** Hub outer diameter (default: bore + 2 x max(module, 0.2 x bore), within the web). */
  readonly hubDiameter?: number;
}

/** Declared ranges; `width` is given in modules here, `bore` is limited by the root circle. */
export const GEAR_RANGES = {
  module: [0.0005, 0.02],
  teeth: [8, 150],
  widthModules: [2, 30],
  pressureAngle: [14.5, 25],
  webHoles: [0, 12],
  flankSegments: [2, 12],
  chamferModules: [0, 0.25],
  hubLengthWidths: [0, 1],
} as const satisfies Record<string, Range>;

/** Involute polar angle at parameter t (radius rb * sqrt(1 + t^2)). */
function involute(t: number): number {
  return t - atan(t);
}

function polar(r: number, a: number): Point2 {
  return [r * cos(a), r * sin(a)];
}

/**
 * Involute spur gear outline (counter-clockwise): standard addendum m and dedendum
 * 1.25 m, radial flanks below the base circle, flat tip and root arcs.
 */
export function gearOutline(
  module: number,
  teeth: number,
  pressureAngle: number,
  flankSegments: number,
): Result<
  {
    points: Point2[];
    pitch: number;
    base: number;
    outer: number;
    root: number;
    /** Chord of the flat tooth tip. */
    tipLand: number;
  },
  ModelingError
> {
  const alpha = (pressureAngle * Math.PI) / 180;
  const pitch = (module * teeth) / 2;
  const base = pitch * cos(alpha);
  const outer = pitch + module;
  const root = pitch - 1.25 * module;
  const beta = Math.PI / (2 * teeth) + involute(sin(alpha) / cos(alpha));
  const tTip = Math.sqrt((outer / base) * (outer / base) - 1);
  const tRoot = root > base ? Math.sqrt((root / base) * (root / base) - 1) : 0;
  const tip = beta - involute(tTip);
  if (!(tip > 0.02 / teeth) || !(Math.PI / teeth - beta + involute(tRoot) > 0.02 / teeth)) {
    return err(
      modelingError(
        'model-degenerate',
        'gear teeth keep a tip land and a root gap',
        { teeth, pressureAngle, tipHalfAngle: tip },
        'raise the tooth count or lower the pressure angle',
      ),
    );
  }
  const points: Point2[] = [];
  const step = (2 * Math.PI) / teeth;
  for (let i = 0; i < teeth; i++) {
    const c = i * step;
    if (root < base) points.push(polar(root, c - beta));
    for (let k = 0; k <= flankSegments; k++) {
      const t = tRoot + ((tTip - tRoot) * k) / flankSegments;
      points.push(polar(base * Math.sqrt(1 + t * t), c - beta + involute(t)));
    }
    points.push(polar(outer, c));
    for (let k = flankSegments; k >= 0; k--) {
      const t = tRoot + ((tTip - tRoot) * k) / flankSegments;
      points.push(polar(base * Math.sqrt(1 + t * t), c + beta - involute(t)));
    }
    if (root < base) points.push(polar(root, c + beta));
    const gapStart = c + beta - (root < base ? 0 : involute(tRoot));
    const gapEnd = c + step - beta + (root < base ? 0 : involute(tRoot));
    for (let k = 1; k < 3; k++) points.push(polar(root, gapStart + ((gapEnd - gapStart) * k) / 3));
  }
  return ok({ points, pitch, base, outer, root, tipLand: 2 * outer * sin(tip) });
}

/**
 * Involute spur gear along +Z, centred on the origin: label `<name>` (roles `side`,
 * `hole`, `top`, `bottom`) and material slot `steel`. Tooth rims and the bore are
 * chamfered (`<name>-chamfer`, `<name>-bore-chamfer`, role `bevel`). With `hubLength`,
 * a hub (`<name>-hub`) stands out of both faces around the bore, its rims chamfered too.
 * Anchors: `center`, `hubTop`; dimensions: pitch, base, outer and root radii, `chamfer`,
 * `boreChamfer`, `hubRadius`.
 */
export function gear(options: GearOptions): Result<RecipePart, ModelingError> {
  const name = options.name ?? 'gear';
  const m = options.module;
  const pressureAngle = options.pressureAngle ?? 20;
  const flankSegments = options.flankSegments ?? 4;
  const webHoles = options.webHoles ?? 0;
  const checked = checkAll([
    () => inRange('module', m, GEAR_RANGES.module),
    () => inRange('teeth', options.teeth, GEAR_RANGES.teeth, true),
    () => inRange('width', options.width, [m * 2, m * 30]),
    () => inRange('pressureAngle', pressureAngle, GEAR_RANGES.pressureAngle),
    () => inRange('webHoles', webHoles, GEAR_RANGES.webHoles, true),
    () => inRange('flankSegments', flankSegments, GEAR_RANGES.flankSegments, true),
    () => inRange('chamfer', options.chamfer ?? 0, [0, 0.25 * m]),
    () => inRange('hubLength', options.hubLength ?? 0, [0, options.width]),
  ]);
  if (!checked.ok) return checked;
  const outline = gearOutline(m, options.teeth, pressureAngle, flankSegments);
  if (!outline.ok) return outline;
  const { points, pitch, base, outer, root, tipLand } = outline.value;
  const rim = root - 1.25 * m;
  const bore = options.bore ?? Math.min(0.6 * pitch, rim * 1.6);
  const boreOk = inRange('bore', bore, [0.5 * m, 2 * rim]);
  if (!boreOk.ok) return boreOk;
  const hubLength = options.hubLength ?? 0;
  const web = rim - 0.5 * m;
  const hubRadius =
    (options.hubDiameter ?? Math.min(bore + 2 * Math.max(m, 0.2 * bore), 2 * (web - m))) / 2;
  if (hubLength > 0) {
    const hubOk = inRange('hubDiameter', hubRadius * 2, [bore + 2 * 0.5 * m, 2 * web]);
    if (!hubOk.ok) return hubOk;
  }
  // The hub overlaps the web, so the union cuts clean circles into both faces.
  const holes: Point2[][] = [circle(hubLength > 0 ? (bore / 2 + hubRadius) / 2 : bore / 2, 32)];
  if (webHoles > 0) {
    const hub = Math.max(bore / 2 + Math.max(m, 0.2 * bore), hubLength > 0 ? hubRadius : 0);
    const ring = (hub + rim) / 2;
    const radius = Math.min((rim - hub) / 2 - 0.5 * m, ring * sin(Math.PI / webHoles) - 0.5 * m);
    if (!(radius >= m)) {
      return err(
        modelingError(
          'model-invalid-argument',
          'the web between hub and rim has room for the lightening holes',
          { webHoles, room: radius },
          'reduce webHoles or the bore, or raise the tooth count',
        ),
      );
    }
    for (let k = 0; k < webHoles; k++) {
      const a = Math.PI / webHoles + (2 * Math.PI * k) / webHoles;
      holes.push(circle(radius, 20, [ring * cos(a), ring * sin(a)]));
    }
  }
  const g = model();
  g.extrudePolygon({ points, holes, depth: options.width, label: name });
  g.translate(sel.all(), [0, 0, -options.width / 2]);
  const z = options.width / 2 + hubLength;
  if (hubLength > 0) {
    const hub = model();
    hub.extrudePolygon({
      points: circle(hubRadius, 32),
      holes: [circle(bore / 2, 32)],
      depth: 2 * z,
      label: `${name}-hub`,
    });
    hub.translate(sel.all(), [0, 0, -z]);
    g.union(hub);
  }
  const caps = sel.facing('+z').or(sel.facing('-z')).toEdges('touching');
  const chamfer = options.chamfer ?? Math.min(0.08 * m, 0.25 * tipLand, 0.15 * options.width);
  const boreChamfer = Math.min(chamfer, 0.08 * bore, 0.15 * z);
  if (chamfer > 0) {
    g.bevel(sel.createdBy(name, 'side').toEdges('touching').and(caps), {
      width: chamfer,
      segments: 1,
      label: `${name}-chamfer`,
    });
    // The 32 bore walls are the faces nearest the centre (caps lie at least width / 2 away).
    const boreWall = sel.near([0, 0, 0], 32);
    g.bevel(boreWall.toEdges('touching').and(caps), {
      width: boreChamfer,
      segments: 1,
      label: `${name}-bore-chamfer`,
    });
    if (hubLength > 0) {
      const ends = sel.extreme('+z').or(sel.extreme('-z')).toEdges('touching');
      g.bevel(sel.createdBy(`${name}-hub`, 'side').toEdges('touching').and(ends), {
        width: Math.min(boreChamfer, 0.15 * hubLength),
        segments: 1,
        label: `${name}-hub-chamfer`,
      });
    }
  }
  g.assign(sel.all(), 'steel');
  return finishPart(
    g,
    name,
    { center: [0, 0, 0], hubTop: [0, 0, z] },
    {
      pitchRadius: pitch,
      baseRadius: base,
      outerRadius: outer,
      rootRadius: root,
      bore,
      width: options.width,
      chamfer,
      boreChamfer: chamfer > 0 ? boreChamfer : 0,
      hubRadius: hubLength > 0 ? hubRadius : 0,
    },
  );
}
