import { type Model, model, sel } from '@forgeax/engine-modeling';

/** Selector-synthesis subjects with ranged parameters, built only from kernel operators. */
export interface BracketParameters {
  readonly length: number;
  readonly height: number;
  readonly depth: number;
}

export const BRACKET_DEFAULTS: BracketParameters = { length: 0.14, height: 0.1, depth: 0.09 };

/**
 * An angle bracket with a chamfered boss on the outer face of its upright, and a separately
 * tagged foot block whose segmented top has no feature to name but its position.
 */
export function buildBracket(p: BracketParameters = BRACKET_DEFAULTS): Model {
  const t = 0.014;
  const m = model();
  m.extrudePolygon({
    points: [
      [0, 0],
      [p.length, 0],
      [p.length, t],
      [t, t],
      [t, p.height],
      [0, p.height],
    ],
    depth: p.depth,
    label: 'body',
    tag: 'bracket',
  });
  m.inset(sel.facing('-x').largest(), {
    thickness: Math.min(p.depth * 0.28, p.height * 0.3),
    region: 'merged',
    label: 'pad',
  });
  m.extrude(sel.createdBy('pad', 'inner'), { distance: t * 0.7, region: 'merged', label: 'boss' });
  m.bevel(sel.createdBy('boss', 'top').boundary(), {
    width: t * 0.12,
    segments: 1,
    label: 'boss-chamfer',
  });
  m.box({
    size: [0.04, t, p.depth],
    center: [p.length - 0.02, t * 1.5, p.depth / 2],
    segments: [4, 1, 6],
    label: 'foot',
    tag: 'foot',
  });
  m.uv.project({ mode: 'box', scale: 0.1 });
  return m;
}

export interface RimParameters {
  readonly diameter: number;
  readonly spokes: number;
}

export const RIM_DEFAULTS: RimParameters = { diameter: 0.4, spokes: 5 };

/** Lug bolts on a 112 mm pitch circle. */
const PCD = 0.112;

/**
 * A wheel disc whose windows are one prism arrayed around the axle and cut in one
 * difference, with five lug seats and through holes drilled the same way.
 */
export function buildRim(p: RimParameters = RIM_DEFAULTS): Model {
  const r = p.diameter / 2;
  const disc = model();
  disc.cylinder({
    radiusTop: r,
    radiusBottom: r,
    height: 0.02,
    radialSegments: 40,
    label: 'disc',
    tag: 'disc',
  });
  const windows = model();
  windows.box({ size: [0.03, 0.04, r * 0.4], center: [0, 0, r * 0.6], label: 'window' });
  windows.array(sel.all(), { radial: { count: p.spokes, axis: 'y' }, label: 'window-array' });
  disc.difference(windows, { label: 'windows', tag: 'windows' });
  const seats = model();
  seats.cylinder({
    radiusTop: 0.0115,
    radiusBottom: 0.0115,
    height: 0.01,
    radialSegments: 12,
    center: [0, 0.01, PCD / 2],
    label: 'seat',
  });
  seats.array(sel.all(), { radial: { count: 5, axis: 'y' }, label: 'seat-array' });
  const lugs = model();
  lugs.cylinder({
    radiusTop: 0.0072,
    radiusBottom: 0.0072,
    height: 0.04,
    radialSegments: 12,
    center: [0, 0, PCD / 2],
    label: 'bit',
  });
  lugs.array(sel.all(), { radial: { count: 5, axis: 'y' }, label: 'lug-array' });
  disc.difference(seats, { label: 'lug-seats', tag: 'hub' });
  disc.difference(lugs, { label: 'lugs', tag: 'hub' });
  disc.uv.project({ mode: 'box', scale: 0.1 });
  return disc;
}
