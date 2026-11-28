import type { Result } from '@forgeax/engine-types';
import { booleanSolids } from '../../src/brep/boolean.ts';
import { box, cylinder, revolve } from '../../src/brep/build.ts';
import { loft } from '../../src/brep/loft.ts';
import { sweep } from '../../src/brep/sweep.ts';
import type { Shape } from '../../src/brep/types.ts';
import type { P3 } from '../../src/brep/vec.ts';
import type { ModelingError } from '../../src/errors.ts';
import { must } from '../brep-heal/damage.ts';
import { move, pin, polygon } from './parts.ts';

export type Owner = 'e1 boolean' | 'trimface' | 'offset' | 'sweep';

/** Repro status: `fixed` repros are asserted to succeed by the boolean regression suite. */
export type GapStatus = 'open' | 'fixed';

/** A fail-close the stress parts route around, with a repro that is small enough to paste. */
export interface Gap {
  readonly id: string;
  readonly owner: Owner;
  readonly status: GapStatus;
  readonly summary: string;
  /** The minimal construction, as source text. */
  readonly repro: string;
  readonly run: () => Result<Shape, ModelingError>;
}

const frame = { o: [0, 0, 0] as P3, x: [1, 0, 0] as P3, y: [0, 1, 0] as P3, z: [0, 0, 1] as P3 };

export const GAPS: readonly Gap[] = [
  {
    id: 'G1',
    owner: 'trimface',
    status: 'fixed',
    summary:
      'A bore coaxial with a boss unioned on a plate: the plate cap, now a face with an outer circle and the boss circle, classifies out of its own trim.',
    repro:
      'booleanSolids(booleanSolids(cylinder({ radius: 60, height: 8 }), cylinder r16 z-6..20, "union"), cylinder r7 z-10..30, "difference")',
    run: () => {
      const bossed = booleanSolids(
        must(cylinder({ radius: 60, height: 8 })),
        pin(16, -6, 20),
        'union',
      );
      return bossed.ok ? booleanSolids(bossed.value, pin(7, -10, 30), 'difference') : bossed;
    },
  },
  {
    id: 'G2',
    owner: 'e1 boolean',
    status: 'fixed',
    summary:
      'Union only: a planar tool face crossing a cylinder cap plate now splits the cap along the straight section line (G2 section cap, single-loop case). Difference, intersect and multi-loop caps still fail closed (model-partial). Rib, gusset and side-port unions on a round plate build through this path.',
    repro:
      'booleanSolids(cylinder({ radius: 60, height: 8 }), move(box({ size: [20, 4, 10] }), [26, 0, 5]), "union")',
    run: () =>
      booleanSolids(
        must(cylinder({ radius: 60, height: 8 })),
        move(must(box({ size: [20, 4, 10] })), [26, 0, 5]),
        'union',
      ),
  },
  {
    id: 'G3',
    owner: 'e1 boolean',
    status: 'open',
    summary:
      'A hollow ring (annulus cap) unioned over a plate: one of its circles lies neither wholly in nor out of the plate face.',
    repro:
      'booleanSolids(cylinder({ radius: 60, height: 8 }), revolve({ profile: [[48,0],[60,0],[60,10],[48,10],[48,0]] }) moved to z0, "union")',
    run: () =>
      booleanSolids(
        must(cylinder({ radius: 60, height: 8 })),
        move(
          must(
            revolve({
              profile: [
                [48, 0],
                [60, 0],
                [60, 10],
                [48, 10],
                [48, 0],
              ],
            }),
          ),
          [0, 0, 2],
        ),
        'union',
      ),
  },
  {
    id: 'G4',
    owner: 'sweep',
    status: 'open',
    summary:
      'A swept (NURBS) tube has no plane/NURBS intersection in the boolean, so a stub cannot be unioned onto a plate or flange.',
    repro:
      'booleanSolids(cylinder({ radius: 60, height: 8 }), sweep({ profile: polygon(6), path: quarter circle r19 at z4 }), "union")',
    run: () =>
      booleanSolids(
        must(cylinder({ radius: 60, height: 8 })),
        must(
          sweep({
            profile: polygon(6),
            path: { kind: 'circle', frame: { ...frame, o: [29, 0, 4] }, radius: 19 },
            range: [0, Math.PI / 2],
            stations: 12,
          }),
        ),
        'union',
      ),
  },
  {
    id: 'G5',
    owner: 'trimface',
    status: 'fixed',
    summary:
      'A boss unioned on a flange that already carries a bore: the flange cap again classifies out of its trim.',
    repro:
      'booleanSolids(booleanSolids(cylinder({ radius: 50, height: 10 }), cylinder r26 bore, "difference"), cylinder r5 at y34 z-22..-4, "union")',
    run: () => {
      const bored = booleanSolids(
        must(cylinder({ radius: 50, height: 10 })),
        pin(26, -20, 20),
        'difference',
      );
      return bored.ok ? booleanSolids(bored.value, pin(5, -17, 1, 0, 34), 'union') : bored;
    },
  },
  {
    id: 'G6',
    owner: 'e1 boolean',
    status: 'open',
    summary:
      'Lofted (NURBS) and swept (NURBS) faces have no NURBS/plane or NURBS/NURBS surface intersection, so flange and pipe cannot be unioned to the transition.',
    repro:
      'booleanSolids(loft({ sections: [square z0, circle r22 z40], mode: "ruled" }), cylinder({ radius: 50, height: 10 }) at z-5, "union")',
    run: () =>
      booleanSolids(
        must(
          loft({
            mode: 'ruled',
            samples: 32,
            sections: [
              {
                profile: [
                  [-35, -35],
                  [35, -35],
                  [35, 35],
                  [-35, 35],
                ],
                frame,
              },
              { profile: polygon(22, 32), frame: { ...frame, o: [0, 0, 40] } },
            ],
          }),
        ),
        pin(50, -10, 0),
        'union',
      ),
  },
];
