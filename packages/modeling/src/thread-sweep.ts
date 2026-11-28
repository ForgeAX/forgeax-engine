import { maxOf } from './arrays';
import { path } from './curve';
import { cos, sin } from './dmath';
import type { Point2 } from './primitives';
import type { SweepOptions } from './sweep';
import type { ThreadSpec } from './threads';

export type ThreadGeometry = 'cosmetic' | 'modeled';

/** Axial clearance per flank between a modeled bolt ridge and its groove, as a fraction of the pitch. */
const CLEARANCE = 0.05;

/** Radius of the flat facet middles of a ring of `segments` vertices on `radius`. */
function apothem(radius: number, segments: number): number {
  return radius * cos(Math.PI / segments);
}

/**
 * Radii shared by a modeled hole and its bolt. The helix path runs on the tap-drill radius `bore`;
 * the bolt root stays inside the bore's facets and its crest inside the groove's, so ridge and
 * groove clear each other whatever the vertex phases of the two rings.
 */
export function threadRadii(spec: ThreadSpec, segments: number) {
  const bore = spec.tapDrill / 2;
  const major = spec.major / 2;
  return {
    bore,
    major,
    root: 0.99 * apothem(bore, segments),
    crest: 0.99 * apothem(major, segments),
  };
}

function profile(spec: ThreadSpec, segments: number, kind: 'groove' | 'ridge'): Point2[] {
  const { bore, major, root, crest } = threadRadii(spec, segments);
  const slope = sin((spec.flankAngle * Math.PI) / 360) / cos((spec.flankAngle * Math.PI) / 360);
  const flat = spec.pitch / 16;
  const sag = (r: number): number => r - apothem(r, segments);
  if (kind === 'groove') {
    const inner = bore - Math.max(0.15 * (major - bore), 2 * sag(bore));
    const wide = flat + (major - inner) * slope;
    return [
      [bore - inner, -wide],
      [bore - major, -flat],
      [bore - major, flat],
      [bore - inner, wide],
    ];
  }
  const inner = root - Math.max(0.1 * (crest - root), 3 * sag(root));
  const crown = flat + (major - crest) * slope - CLEARANCE * spec.pitch;
  const wide = crown + (crest - inner) * slope;
  return [
    [bore - inner, -wide],
    [bore - crest, -crown],
    [bore - crest, crown],
    [bore - inner, wide],
  ];
}

/** Axial half extent of the groove or ridge section about its helix center line. */
export function threadReach(spec: ThreadSpec, segments: number, kind: 'groove' | 'ridge'): number {
  return maxOf(profile(spec, segments, kind).map((p) => Math.abs(p[1])));
}

/**
 * Sweep options for the helical groove of a tapped hole or the ridge of a bolt, about the +Y axis
 * through the origin, right-handed, center line from `from` to `to`. Groove and ridge share the path
 * radius and the phase `2 pi y / pitch` from +Z toward +X, so a bolt whose axis lies on the hole's,
 * a whole number of pitches along, fits with the flank clearance. The section is constant and ends
 * abruptly.
 */
export function threadSweep(
  spec: ThreadSpec,
  kind: 'groove' | 'ridge',
  from: number,
  to: number,
  segments: number,
): SweepOptions {
  const turns = (to - from) / spec.pitch;
  const start = ((((360 * from) / spec.pitch) % 360) + 360) % 360;
  return {
    profile: profile(spec, segments, kind),
    path: path.helix({
      radius: threadRadii(spec, segments).bore,
      pitch: spec.pitch,
      turns,
      segments,
      center: [0, from, 0],
      startAngle: start,
    }),
    frame: 'up',
    up: [0, 1, 0],
  };
}
