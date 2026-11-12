import type { Result } from '@forgeax/engine-types';
import { cos, hypot3, sin } from '../dmath';
import type { ModelingError } from '../errors';
import { cross, dot, length, sub, type Tuple3 } from '../geom';
import { model } from '../model';
import { sel } from '../selectors';
import {
  checkAll,
  finishPart,
  inRange,
  type Range,
  type RecipeNaming,
  type RecipePart,
} from './common';

export interface CoilSpringOptions extends RecipeNaming {
  /** Mean coil radius (meters), to the wire centre. */
  readonly radius: number;
  /** Wire diameter. */
  readonly wire: number;
  /** Axial advance per turn. */
  readonly pitch: number;
  readonly turns: number;
  /** Segments per turn (default 16). */
  readonly segments?: number;
  /** Segments around the wire (default 8). */
  readonly wireSegments?: number;
}

/** Declared ranges; `wire` is a fraction of the coil radius and `pitch` a multiple of the wire. */
export const COIL_SPRING_RANGES = {
  radius: [0.002, 0.5],
  wireRadii: [0.05, 0.4],
  pitchWires: [1.15, 6],
  turns: [0.5, 20],
  segments: [8, 24],
  wireSegments: [6, 12],
} as const satisfies Record<string, Range>;

/** Unit tangent of the helix (R cos t, p t / 2 pi, -R sin t) at angle t. */
function tangent(radius: number, pitch: number, t: number): Tuple3 {
  const x = -radius * sin(t);
  const y = pitch / (2 * Math.PI);
  const z = -radius * cos(t);
  const l = hypot3(x, y, z);
  return [x / l, y / l, z / l];
}

/**
 * Helical compression spring about +Y from the origin, built only from ordinary
 * operations: the wire section is extruded a little and screwed (rotated about +Y and
 * raised) to the next station, so every station is the same section moved along the
 * helix. Where the screwed wire quads twist beyond the tolerance they are split into
 * triangles. Label `<name>` (roles `side`, `top`, `cap`), slot `spring`.
 * Anchors: `bottom`, `top` (axis points); dimensions: `freeLength`.
 */
export function coilSpring(options: CoilSpringOptions): Result<RecipePart, ModelingError> {
  const name = options.name ?? 'spring';
  const { radius, wire, pitch, turns } = options;
  const segments = options.segments ?? 16;
  const wireSegments = options.wireSegments ?? 8;
  const checked = checkAll([
    () => inRange('radius', radius, COIL_SPRING_RANGES.radius),
    () => inRange('wire', wire, [radius * 0.05, radius * 0.4]),
    () => inRange('pitch', pitch, [wire * 1.15, wire * 6]),
    () => inRange('turns', turns, COIL_SPRING_RANGES.turns),
    () => inRange('segments', segments, COIL_SPRING_RANGES.segments, true),
    () => inRange('wireSegments', wireSegments, COIL_SPRING_RANGES.wireSegments, true),
  ]);
  if (!checked.ok) return checked;
  const stations = Math.max(1, Math.round(turns * segments));
  const step = (2 * Math.PI * turns) / stations;
  const rise = (pitch * turns) / stations;
  const t0 = tangent(radius, pitch, 0);
  const u: Tuple3 = [1, 0, 0];
  const w: Tuple3 = [
    t0[1] * u[2] - t0[2] * u[1],
    t0[2] * u[0] - t0[0] * u[2],
    t0[0] * u[1] - t0[1] * u[0],
  ];
  const r = wire / 2;
  const section = Array.from({ length: wireSegments }, (_, i) => {
    const a = (2 * Math.PI * i) / wireSegments;
    const c = r * cos(a);
    const s = r * sin(a);
    return [radius + c * u[0] + s * w[0], c * u[1] + s * w[1], c * u[2] + s * w[2]] as Tuple3;
  });
  const m = model();
  m.polygon({ points: section, label: name });
  const lead = wire * 0.01;
  for (let k = 1; k <= stations; k++) {
    const end = sel.createdBy(name, k === 1 ? 'face' : 'top');
    m.extrude(end, { distance: lead, region: 'merged', label: name });
    m.rotate(sel.createdBy(name, 'top'), 'y', (step * 180) / Math.PI);
    const tk = tangent(radius, pitch, k * step);
    m.translate(sel.createdBy(name, 'top'), [-lead * tk[0], rise - lead * tk[1], -lead * tk[2]]);
  }
  m.fillHoles(sel.edges.meshBoundary(), { label: name });
  // Every wire quad is the same quad screwed along the helix: one twist test covers all.
  const a = section[0] as Tuple3;
  const b = section[1] as Tuple3;
  const screw = (p: Tuple3): Tuple3 => [
    p[0] * cos(step) + p[2] * sin(step),
    p[1] + rise,
    -p[0] * sin(step) + p[2] * cos(step),
  ];
  const sa = screw(a);
  const n = cross(sub(b, a), sub(sa, a));
  const twist = Math.abs(dot(sub(screw(b), a), n)) / length(n);
  if (twist > m.tolerance * 5) m.triangulate(sel.createdBy(name, 'side'));
  m.assign(sel.all(), 'spring');
  return finishPart(
    m,
    name,
    { bottom: [0, -r, 0], top: [0, pitch * turns + r, 0] },
    { freeLength: pitch * turns + wire, stations },
  );
}
