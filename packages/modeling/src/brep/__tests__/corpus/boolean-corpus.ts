import { ok, type Result } from '@forgeax/engine-types';
import type { ModelingError } from '../../../errors';
import { type BooleanOp, booleanSolids } from '../../boolean';
import { box, cone, cylinder, extrude, sphere, torus } from '../../build';
import { applyPattern, circularPattern, linearPattern } from '../../pattern';
import { makeFrame } from '../../surfaces';
import type { Shape } from '../../types';

/**
 * Deterministic boolean corpus. Each case builds its operands with fixed numbers and runs one
 * kernel operation. `volume` is the analytic volume of a correct result; `tolRel` bounds the
 * relative error accepted for an ok result (planar closed forms are exact, curved faces get 1e-6).
 * The expectation table next to this file pins the observed outcome of every case.
 */
export type CorpusClass = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H';

export const CLASS_TITLES: Record<CorpusClass, string> = {
  A: 'box/box planar crossings',
  B: 'repeated pockets on one rail',
  C: 'cylinder crossings',
  D: 'sphere, torus and cone against a half-space',
  E: 'extruded profiles (non-convex, holes)',
  F: 'circular and linear patterns of tools',
  G: 'chained operations',
  H: 'contact, nesting and disjoint operands',
};

export interface CorpusCase {
  readonly id: string;
  readonly cls: CorpusClass;
  readonly title: string;
  readonly volume: number;
  readonly tolRel: number;
  readonly run: () => Result<Shape, ModelingError>;
}

type Vec = readonly [number, number, number];

function must<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(`corpus operand failed: ${JSON.stringify(result.error)}`);
  return result.value;
}

const PLANAR = 1e-9;
const CURVED = 1e-6;

const block = (size: Vec, centre: Vec): Shape =>
  must(box({ size, frame: makeFrame(centre, [0, 0, 1], [1, 0, 0]), tol: 1e-8 }));

const cyl = (radius: number, height: number, centre: Vec, axis: Vec = [0, 0, 1]): Shape =>
  must(cylinder({ radius, height, frame: makeFrame(centre, axis) }));

const bool = (a: Shape, b: Shape, op: BooleanOp) => () => booleanSolids(a, b, op);

// Rail and pocket shared by class B: the pocket is open through the rail top (z 0.08..0.14 over
// a rail top at 0.12), so each identical pocket removes 0.06 * 0.02 * 0.04 from the rail.
const RAIL = (length: number): Shape => block([length, 0.16, 0.24], [0, 0, 0]);
const POCKET = (x: number): Shape => block([0.06, 0.02, 0.06], [x, 0, 0.11]);
const POCKET_REMOVED = 0.06 * 0.02 * 0.04;

const pocketsAt = (xs: readonly number[]) => () =>
  applyPattern(
    RAIL(1.2),
    xs.map((x) => POCKET(x)),
    'difference',
  );

// Through mortises on a 2.4 rail: each 0.04 x 0.06 tool passes the full rail height 0.24.
const LONG_RAIL = (): Shape => block([2.4, 0.16, 0.24], [0, 0, 0]);
const MORTISE = (x: number): Shape => block([0.04, 0.06, 0.4], [x, 0, 0]);
const MORTISE_REMOVED = 0.04 * 0.06 * 0.24;
const ROW_30 = Array.from({ length: 30 }, (_, i) => -1.0875 + 0.075 * i);
const ROW_10 = Array.from({ length: 10 }, (_, i) => -0.9 + 0.2 * i);

/** Rail minus 30 through mortises, as one pattern or as 30 explicit `booleanSolids` calls. */
export function mortiseRail(form: 'pattern' | 'sequential'): Result<Shape, ModelingError> {
  if (form === 'pattern') {
    const row = must(
      linearPattern(MORTISE(ROW_30[0] as number), {
        direction: [1, 0, 0],
        spacing: 0.075,
        count: 30,
      }),
    );
    return applyPattern(LONG_RAIL(), row, 'difference');
  }
  let shape = LONG_RAIL();
  for (const x of ROW_30) {
    const next = booleanSolids(shape, MORTISE(x), 'difference');
    if (!next.ok) return next;
    shape = next.value;
  }
  return ok(shape);
}

// Crossing rows: a top pocket (x 0.06, y -0.04..0.04, z 0..0.12) and a side pocket entering from
// +y (x 0.04, y 0..0.08, z -0.04..0.04) at the same x meet in a 0.04 x 0.04 x 0.04 cell.
const TOP_POCKET = (x: number): Shape => block([0.06, 0.08, 0.2], [x, 0, 0.1]);
const SIDE_POCKET = (x: number): Shape => block([0.04, 0.12, 0.08], [x, 0.06, 0]);
const CROSSING_REMOVED = 0.06 * 0.08 * 0.12 + 0.04 * 0.08 * 0.08 - 0.04 * 0.04 * 0.04;

// Open-side notch: its -y wall lies in the rail face y = -0.08, so it opens to the top and side.
const SIDE_NOTCH = (x: number): Shape => block([0.06, 0.08, 0.08], [x, -0.04, 0.1]);
const SIDE_NOTCH_REMOVED = 0.06 * 0.08 * 0.06;

// Blind pockets entering from the rail bottom (z -0.12..-0.06 inside the rail).
const BOTTOM_POCKET = (x: number): Shape => block([0.05, 0.03, 0.1], [x, 0.02, -0.11]);
const BOTTOM_POCKET_REMOVED = 0.05 * 0.03 * 0.06;

// Two boxes offset in z so that no pair of faces is coplanar: P 2x1x1, Q 1x2x1 raised by 0.2.
const P = (): Shape => block([2, 1, 1], [0, 0, 0]);
const Q = (): Shape => block([1, 2, 1], [0, 0, 0.2]);
const CROSS_OVERLAP = 1 * 1 * 0.8; // x in [-0.5,0.5], y in [-0.5,0.5], z in [-0.3,0.5]

// Parallel cylinders of radius 1 at distance 1: the cross-section lens area is 2pi/3 - sqrt3/2.
const LENS_AREA = (2 * Math.PI) / 3 - Math.sqrt(3) / 2;

const SLAB_HOLE_REMOVED = (() => {
  // Cylinder of radius 0.3 along x through a slab |z| <= 0.25 over x in [-1, 1]:
  // the disc part with |z| <= a has area 2 * (a sqrt(r^2 - a^2) + r^2 asin(a / r)).
  const r = 0.3;
  const a = 0.25;
  const discArea = 2 * (a * Math.sqrt(r * r - a * a) + r * r * Math.asin(a / r));
  return discArea * 2;
})();

// Hub cylinder r 0.5, h 0.3 with a spoke box x in [0.4, 1.4], y in [-0.1, 0.1], z in [-0.15, 0.15].
// Cross-section overlap: the strip x in [0.4, 0.5], |y| <= 0.1 inside the disc of radius 0.5.
// The disc chord reaches the strip half-width 0.1 at x0 = sqrt(0.24); beyond x0 the chord is shorter.
const HUB_R = 0.5;
const SPOKE_X0 = Math.sqrt(HUB_R * HUB_R - 0.1 * 0.1);
const discHalf = (x: number): number =>
  (x / 2) * Math.sqrt(HUB_R * HUB_R - x * x) + (HUB_R * HUB_R * Math.asin(x / HUB_R)) / 2;
const SPOKE_OVERLAP_AREA = 2 * (0.1 * (SPOKE_X0 - 0.4) + discHalf(HUB_R) - discHalf(SPOKE_X0));

const HOLE_R = 0.3;
const SLOT_REMOVED = 0.4 * 0.2 * 0.5;
// A slot at x 0.3..1 clears the one-hole and four-hole rows; the hole rows use radius 0.1.
const SLOT_CLEAR_REMOVED = 0.7 * 0.2 * 0.5;
const HOLE_01_REMOVED = Math.PI * 0.1 ** 2 * 0.5;
// A wide slot (x 0.6..1, |y| <= 0.3) cuts a bore of radius 0.2 centred at x 0.5 along the circular segment past x 0.6.
const SLOT_WIDE_REMOVED = 0.4 * 0.6 * 0.5;
const SEGMENT_OVERLAP = 0.2 ** 2 * Math.acos(0.5) - 0.1 * Math.sqrt(0.2 ** 2 - 0.1 ** 2);
// A keyway |y| <= 0.1, x 0.3..0.9 through the hub of radius HUB_R: the strip area inside the disc past x 0.3.
const KEYWAY_BREAK = Math.sqrt(HUB_R * HUB_R - 0.1 * 0.1);
const KEYWAY_AREA =
  2 * 0.1 * (KEYWAY_BREAK - 0.3) +
  (HUB_R * HUB_R * Math.PI) / 2 -
  KEYWAY_BREAK * 0.1 -
  HUB_R * HUB_R * Math.asin(KEYWAY_BREAK / HUB_R);

export const CORPUS: readonly CorpusCase[] = [
  // ---- A: box/box planar crossings (convex operands, every face pair non-coplanar)
  {
    id: 'A1-union',
    cls: 'A',
    title: 'two crossing boxes, union',
    volume: 2 + 2 - CROSS_OVERLAP,
    tolRel: PLANAR,
    run: bool(P(), Q(), 'union'),
  },
  {
    id: 'A2-difference',
    cls: 'A',
    title: 'box minus a crossing box',
    volume: 2 - CROSS_OVERLAP,
    tolRel: PLANAR,
    run: bool(P(), Q(), 'difference'),
  },
  {
    id: 'A3-difference-reversed',
    cls: 'A',
    title: 'crossing box minus the first box',
    volume: 2 - CROSS_OVERLAP,
    tolRel: PLANAR,
    run: bool(Q(), P(), 'difference'),
  },
  {
    id: 'A4-intersect',
    cls: 'A',
    title: 'two crossing boxes, intersection',
    volume: CROSS_OVERLAP,
    tolRel: PLANAR,
    run: bool(P(), Q(), 'intersect'),
  },
  {
    id: 'A5-corner-union',
    cls: 'A',
    title: 'unit cubes overlapping at a corner, union',
    volume: 1 + 1 - 0.125,
    tolRel: PLANAR,
    run: bool(block([1, 1, 1], [0, 0, 0]), block([1, 1, 1], [0.5, 0.5, 0.5]), 'union'),
  },

  // ---- B: repeated pockets on one rail (identical planes from every pocket wall)
  {
    id: 'B0-single-pocket',
    cls: 'B',
    title: 'one pocket on the rail',
    volume: 0.04608 - POCKET_REMOVED,
    tolRel: PLANAR,
    run: pocketsAt([0.3]),
  },
  {
    id: 'B1-two-pockets',
    cls: 'B',
    title: 'two identical pockets at x = +-0.3',
    volume: 0.04608 - 2 * POCKET_REMOVED,
    tolRel: PLANAR,
    run: pocketsAt([-0.3, 0.3]),
  },
  {
    id: 'B2-three-pockets',
    cls: 'B',
    title: 'three pockets at x = -0.3, 0, 0.3',
    volume: 0.04608 - 3 * POCKET_REMOVED,
    tolRel: PLANAR,
    run: pocketsAt([-0.3, 0, 0.3]),
  },
  {
    id: 'B3-pocket-row-30',
    cls: 'B',
    title: 'row of 30 pockets, pitch 0.075, on a 2.4 rail',
    volume: 0.09216 - 30 * POCKET_REMOVED,
    tolRel: PLANAR,
    run: () => {
      const row = must(
        linearPattern(POCKET(-1.0875), { direction: [1, 0, 0], spacing: 0.075, count: 30 }),
      );
      return applyPattern(block([2.4, 0.16, 0.24], [0, 0, 0]), row, 'difference');
    },
  },
  {
    id: 'B4-same-pocket-twice',
    cls: 'B',
    title: 'the same pocket applied twice (second cut is coincident)',
    volume: 0.04608 - POCKET_REMOVED,
    tolRel: PLANAR,
    run: () => applyPattern(RAIL(1.2), [POCKET(0.3), POCKET(0.3)], 'difference'),
  },

  {
    id: 'B5-mortise-row-30-pattern',
    cls: 'B',
    title: '30 identical through mortises as one linear pattern',
    volume: 0.09216 - 30 * MORTISE_REMOVED,
    tolRel: PLANAR,
    run: () => mortiseRail('pattern'),
  },
  {
    id: 'B6-mortise-row-30-sequential',
    cls: 'B',
    title: 'the same 30 mortises as 30 sequential differences',
    volume: 0.09216 - 30 * MORTISE_REMOVED,
    tolRel: PLANAR,
    run: () => mortiseRail('sequential'),
  },
  {
    id: 'B7-blind-bottom-pockets',
    cls: 'B',
    title: 'row of 10 blind pockets entering from the rail bottom',
    volume: 0.09216 - 10 * BOTTOM_POCKET_REMOVED,
    tolRel: PLANAR,
    run: () =>
      applyPattern(
        LONG_RAIL(),
        ROW_10.map((x) => BOTTOM_POCKET(x)),
        'difference',
      ),
  },
  {
    id: 'B8-crossing-pocket-rows',
    cls: 'B',
    title: 'top and side pocket rows meeting inside the rail (mortise crossing)',
    volume: 0.09216 - 10 * CROSSING_REMOVED,
    tolRel: PLANAR,
    run: () =>
      applyPattern(
        LONG_RAIL(),
        [...ROW_10.map((x) => TOP_POCKET(x)), ...ROW_10.map((x) => SIDE_POCKET(x))],
        'difference',
      ),
  },
  {
    id: 'B9-open-side-notches',
    cls: 'B',
    title: 'notches whose wall lies in the rail side face (open to top and side)',
    volume: 0.09216 - 10 * SIDE_NOTCH_REMOVED,
    tolRel: PLANAR,
    run: () =>
      applyPattern(
        LONG_RAIL(),
        ROW_10.map((x) => SIDE_NOTCH(x)),
        'difference',
      ),
  },
  {
    id: 'B10-mortise-then-tenon',
    cls: 'B',
    title: 'three mortises, then matching tenons unioned back (original volume)',
    volume: 0.09216,
    tolRel: PLANAR,
    run: () => {
      const xs = [-0.6, 0, 0.6];
      const cut = applyPattern(
        LONG_RAIL(),
        xs.map((x) => MORTISE(x)),
        'difference',
      );
      if (!cut.ok) return cut;
      return applyPattern(
        cut.value,
        xs.map((x) => block([0.04, 0.06, 0.24], [x, 0, 0])),
        'union',
      );
    },
  },

  // ---- C: cylinder crossings
  {
    id: 'C1-vertical-hole',
    cls: 'C',
    title: 'plate minus a vertical through hole',
    volume: 2 - Math.PI * 0.09 * 0.5,
    tolRel: CURVED,
    run: bool(block([2, 2, 0.5], [0, 0, 0]), cyl(0.3, 2, [0, 0, 0]), 'difference'),
  },
  {
    id: 'C2-horizontal-hole',
    cls: 'C',
    title: 'plate minus a cylinder along x through its thickness',
    volume: 2 - SLAB_HOLE_REMOVED,
    tolRel: CURVED,
    run: bool(block([2, 2, 0.5], [0, 0, 0]), cyl(0.3, 3, [0, 0, 0], [1, 0, 0]), 'difference'),
  },
  {
    id: 'C3-steinmetz-intersect',
    cls: 'C',
    title: 'equal perpendicular cylinders, intersection (Steinmetz)',
    volume: (16 * 1) / 3,
    tolRel: CURVED,
    run: bool(cyl(1, 4, [0, 0, 0], [1, 0, 0]), cyl(1, 4, [0, 0, 0], [0, 1, 0]), 'intersect'),
  },
  {
    id: 'C4-steinmetz-union',
    cls: 'C',
    title: 'equal perpendicular cylinders, union',
    volume: 8 * Math.PI - 16 / 3,
    tolRel: CURVED,
    run: bool(cyl(1, 4, [0, 0, 0], [1, 0, 0]), cyl(1, 4, [0, 0, 0], [0, 1, 0]), 'union'),
  },
  {
    id: 'C5-steinmetz-difference',
    cls: 'C',
    title: 'equal perpendicular cylinders, difference',
    volume: 4 * Math.PI - 16 / 3,
    tolRel: CURVED,
    run: bool(cyl(1, 4, [0, 0, 0], [1, 0, 0]), cyl(1, 4, [0, 0, 0], [0, 1, 0]), 'difference'),
  },
  {
    id: 'C6-parallel-lens',
    cls: 'C',
    title: 'parallel cylinders at distance 1, intersection (lens)',
    volume: LENS_AREA * 2,
    tolRel: CURVED,
    run: bool(cyl(1, 2, [0, 0, 0]), cyl(1, 3, [1, 0, 0]), 'intersect'),
  },
  {
    id: 'C7-parallel-union',
    cls: 'C',
    title: 'parallel cylinders at distance 1, union',
    volume: 2 * Math.PI + 3 * Math.PI - LENS_AREA * 2,
    tolRel: CURVED,
    run: bool(cyl(1, 2, [0, 0, 0]), cyl(1, 3, [1, 0, 0]), 'union'),
  },
  {
    id: 'C8-hub-keyway',
    cls: 'C',
    title: 'hub cylinder minus a keyway slot through its full height',
    volume: Math.PI * HUB_R * HUB_R * 0.6 - KEYWAY_AREA * 0.6,
    tolRel: CURVED,
    run: bool(cyl(HUB_R, 0.6, [0, 0, 0]), block([0.6, 0.2, 2], [0.6, 0, 0]), 'difference'),
  },

  // ---- D: sphere, torus and cone against a half-space or a cap
  {
    id: 'D1-sphere-dimple',
    cls: 'D',
    title: 'block minus a sphere centred on its top face',
    volume: 4 - (2 / 3) * Math.PI * 0.5 ** 3,
    tolRel: CURVED,
    run: bool(
      block([2, 2, 1], [0, 0, 0]),
      must(sphere({ radius: 0.5, frame: makeFrame([0, 0, 0.5], [0, 0, 1], [1, 0, 0]) })),
      'difference',
    ),
  },
  {
    id: 'D2-sphere-bump',
    cls: 'D',
    title: 'block union a sphere centred on its top face',
    volume: 4 + (2 / 3) * Math.PI * 0.5 ** 3,
    tolRel: CURVED,
    run: bool(
      block([2, 2, 1], [0, 0, 0]),
      must(sphere({ radius: 0.5, frame: makeFrame([0, 0, 0.5], [0, 0, 1], [1, 0, 0]) })),
      'union',
    ),
  },
  {
    id: 'D3-torus-half',
    cls: 'D',
    title: 'torus minus the upper half-space',
    volume: Math.PI ** 2 * 1 * 0.25 ** 2,
    tolRel: CURVED,
    run: bool(must(torus({ major: 1, minor: 0.25 })), block([4, 4, 4], [0, 0, 2]), 'difference'),
  },
  {
    id: 'D4-cone-frustum',
    cls: 'D',
    title: 'cone minus the upper half-space',
    volume: (Math.PI / 6) * (0.25 + 0.125 + 0.0625),
    tolRel: CURVED,
    run: bool(must(cone({ radius: 0.5, height: 1 })), block([4, 4, 4], [0, 0, 2]), 'difference'),
  },

  // ---- E: extruded profiles
  {
    id: 'E1-l-profile-cut',
    cls: 'E',
    title: 'L-shaped extrusion minus a half-space on one leg',
    volume: 2.5,
    tolRel: PLANAR,
    run: bool(
      must(
        extrude({
          profile: [
            [0, 0],
            [2, 0],
            [2, 1],
            [1, 1],
            [1, 2],
            [0, 2],
          ],
          depth: 1,
        }),
      ),
      block([1.5, 4, 3], [2.25, 1, 0.5]),
      'difference',
    ),
  },
  {
    id: 'E2-holed-extrusion-cut',
    cls: 'E',
    title: 'square tube (one through hole) minus a slab that clips its edge',
    volume: 2.6,
    tolRel: PLANAR,
    run: bool(
      must(
        extrude({
          profile: [
            [0, 0],
            [2, 0],
            [2, 2],
            [0, 2],
          ],
          holes: [
            [
              [0.5, 0.5],
              [1.5, 0.5],
              [1.5, 1.5],
              [0.5, 1.5],
            ],
          ],
          depth: 1,
        }),
      ),
      block([1, 4, 3], [2.3, 1, 0.5]),
      'difference',
    ),
  },

  // ---- F: circular and linear patterns of tools
  {
    id: 'F1-bolt-circle-boxes',
    cls: 'F',
    title: 'flange minus six box holes on a bolt circle',
    volume: Math.PI * 0.2 - 6 * 0.2 * 0.2 * 0.2,
    tolRel: CURVED,
    run: () => {
      const tools = must(
        circularPattern(block([0.2, 0.2, 0.4], [0.6, 0, 0]), {
          axis: { origin: [0, 0, 0], direction: [0, 0, 1] },
          count: 6,
        }),
      );
      return applyPattern(cyl(1, 0.2, [0, 0, 0]), tools, 'difference');
    },
  },
  {
    id: 'F2-bolt-circle-cylinders',
    cls: 'F',
    title: 'flange minus six cylinder holes on a bolt circle',
    volume: Math.PI * 0.2 - 6 * Math.PI * 0.1 ** 2 * 0.2,
    tolRel: CURVED,
    run: () => {
      const tools = must(
        circularPattern(cyl(0.1, 0.4, [0.6, 0, 0]), {
          axis: { origin: [0, 0, 0], direction: [0, 0, 1] },
          count: 6,
        }),
      );
      return applyPattern(cyl(1, 0.2, [0, 0, 0]), tools, 'difference');
    },
  },

  // ---- G: chained operations
  {
    id: 'G1-hub-spoke-union',
    cls: 'G',
    title: 'hub cylinder union one spoke box',
    volume: Math.PI * 0.25 * 0.3 + 1 * 0.2 * 0.2 - SPOKE_OVERLAP_AREA * 0.2,
    tolRel: CURVED,
    run: bool(cyl(0.5, 0.3, [0, 0, 0]), block([1, 0.2, 0.2], [0.9, 0, 0]), 'union'),
  },
  {
    id: 'G2-hole-then-slot',
    cls: 'G',
    title: 'plate minus a vertical hole, then minus a slot',
    volume: 2 - Math.PI * HOLE_R ** 2 * 0.5 - SLOT_REMOVED,
    tolRel: CURVED,
    run: () => {
      const holed = must(
        booleanSolids(block([2, 2, 0.5], [0, 0, 0]), cyl(HOLE_R, 2, [0, 0, 0]), 'difference'),
      );
      return booleanSolids(holed, block([0.6, 0.2, 2], [0.9, 0, 0]), 'difference');
    },
  },
  {
    id: 'G3-slot-then-hole',
    cls: 'G',
    title: 'plate minus a slot, then minus a vertical hole through the slot-free part',
    volume: 2 - SLOT_REMOVED - Math.PI * HOLE_R ** 2 * 0.5,
    tolRel: CURVED,
    run: () => {
      const slotted = must(
        booleanSolids(
          block([2, 2, 0.5], [0, 0, 0]),
          block([0.6, 0.2, 2], [0.9, 0, 0]),
          'difference',
        ),
      );
      return booleanSolids(slotted, cyl(HOLE_R, 2, [0, 0, 0]), 'difference');
    },
  },
  {
    id: 'G4-hole-then-slot-clear',
    cls: 'G',
    title: 'plate with one hole, then a slot clear of the hole',
    volume: 2 - HOLE_01_REMOVED - SLOT_CLEAR_REMOVED,
    tolRel: CURVED,
    run: () => {
      const holed = must(
        booleanSolids(block([2, 2, 0.5], [0, 0, 0]), cyl(0.1, 2, [-0.5, 0, 0]), 'difference'),
      );
      return booleanSolids(holed, block([0.9, 0.2, 2], [0.75, 0, 0]), 'difference');
    },
  },
  {
    id: 'G5-four-holes-then-slot-clear',
    cls: 'G',
    title: 'plate with four holes, then a slot clear of all four',
    volume: 2 - 4 * HOLE_01_REMOVED - SLOT_CLEAR_REMOVED,
    tolRel: CURVED,
    run: () => {
      let plate = block([2, 2, 0.5], [0, 0, 0]);
      for (const [x, y] of [
        [-0.6, 0.4],
        [-0.6, -0.4],
        [-0.2, 0.4],
        [-0.2, -0.4],
      ] as const) {
        plate = must(booleanSolids(plate, cyl(0.1, 2, [x, y, 0]), 'difference'));
      }
      return booleanSolids(plate, block([0.9, 0.2, 2], [0.75, 0, 0]), 'difference');
    },
  },
  {
    id: 'G6-hole-then-slot-through-hole',
    cls: 'G',
    title: 'plate with a hole, then a wide slot that cuts through the hole',
    volume: 2 - SLOT_WIDE_REMOVED - Math.PI * 0.2 ** 2 * 0.5 + SEGMENT_OVERLAP * 0.5,
    tolRel: CURVED,
    run: () => {
      const holed = must(
        booleanSolids(block([2, 2, 0.5], [0, 0, 0]), cyl(0.2, 2, [0.5, 0, 0]), 'difference'),
      );
      return booleanSolids(holed, block([0.6, 0.6, 2], [0.9, 0, 0]), 'difference');
    },
  },

  // ---- H: contact, nesting and disjoint operands
  {
    id: 'H1-face-touch-union',
    cls: 'H',
    title: 'two cubes sharing a face, union',
    volume: 2,
    tolRel: PLANAR,
    run: bool(block([1, 1, 1], [0, 0, 0]), block([1, 1, 1], [1, 0, 0]), 'union'),
  },
  {
    id: 'H2-edge-touch-union',
    cls: 'H',
    title: 'two cubes touching along one edge, union',
    volume: 2,
    tolRel: PLANAR,
    run: bool(block([1, 1, 1], [0, 0, 0]), block([1, 1, 1], [1, 1, 0]), 'union'),
  },
  {
    id: 'H3-tangent-cylinder-union',
    cls: 'H',
    title: 'cube and a cylinder tangent to its side, union',
    volume: 1 + Math.PI * 0.25,
    tolRel: CURVED,
    run: bool(block([1, 1, 1], [0, 0, 0]), cyl(0.5, 1, [1, 0, 0]), 'union'),
  },
  {
    id: 'H4-nested-void',
    cls: 'H',
    title: 'cube minus a strictly nested cube (inner void)',
    volume: 8 - 1,
    tolRel: PLANAR,
    run: bool(block([2, 2, 2], [0, 0, 0]), block([1, 1, 1], [0, 0, 0]), 'difference'),
  },
  {
    id: 'H5-disjoint-union',
    cls: 'H',
    title: 'two disjoint cubes, union (two components)',
    volume: 2,
    tolRel: PLANAR,
    run: bool(block([1, 1, 1], [0, 0, 0]), block([1, 1, 1], [3, 0, 0]), 'union'),
  },
  {
    id: 'H6-face-touch-intersect',
    cls: 'H',
    title: 'two cubes sharing a face, intersect (empty)',
    volume: 1,
    tolRel: PLANAR,
    run: bool(block([1, 1, 1], [0, 0, 0]), block([1, 1, 1], [1, 0, 0]), 'intersect'),
  },
  {
    id: 'H7-face-touch-difference',
    cls: 'H',
    title: 'two cubes sharing a face, difference (first cube unchanged)',
    volume: 1,
    tolRel: PLANAR,
    run: bool(block([1, 1, 1], [0, 0, 0]), block([1, 1, 1], [1, 0, 0]), 'difference'),
  },
  {
    id: 'H8-tenon-on-drilled-plate',
    cls: 'H',
    title: 'plate with a vertical hole, then a tenon block fused onto its top face, union',
    volume: 2 - Math.PI * HOLE_R ** 2 * 0.5 + 0.4 * 0.4 * 0.4,
    tolRel: CURVED,
    run: () => {
      const drilled = must(
        booleanSolids(block([2, 2, 0.5], [0, 0, 0]), cyl(HOLE_R, 2, [0, 0, 0]), 'difference'),
      );
      return booleanSolids(drilled, block([0.4, 0.4, 0.4], [0.7, 0.6, 0.45]), 'union');
    },
  },
];
