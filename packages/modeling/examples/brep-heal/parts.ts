import { cylinder, extrude } from '../../src/brep/build.ts';
import type { Shape } from '../../src/brep/types.ts';
import type { P2 } from '../../src/brep/vec.ts';
import { buildBracket } from '../brep-edit/bracket.ts';
import { must } from './damage.ts';

function ring(cx: number, cy: number, r: number, n: number): P2[] {
  return Array.from({ length: n }, (_, k): P2 => {
    const a = ((k + 0.5) * 2 * Math.PI) / n;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  });
}

/** Cut corners of a w x h rectangle by c. */
function chamfered(w: number, h: number, c: number): P2[] {
  return [
    [c, 0],
    [w - c, 0],
    [w, c],
    [w, h - c],
    [w - c, h],
    [c, h],
    [0, h - c],
    [0, c],
  ];
}

/**
 * A B-rep stand-in for a device housing: a chamfered-corner shell body with a wide window and four screw
 * holes. (examples/housing is mesh-based and cannot be healed as a Shape.)
 */
export function buildHousing(): Shape {
  return must(
    extrude({
      profile: chamfered(80, 50, 6),
      holes: [
        [
          [20, 14],
          [60, 14],
          [60, 36],
          [20, 36],
        ],
        ring(8, 8, 2.5, 12),
        ring(72, 8, 2.5, 12),
        ring(8, 42, 2.5, 12),
        ring(72, 42, 2.5, 12),
      ],
      depth: 18,
    }),
  );
}

/** A turned standoff: curved faces for the damage that must stay on a cylinder. */
export function buildStandoff(): Shape {
  return must(cylinder({ radius: 6, height: 20 }));
}

export function buildPlate(): Shape {
  return buildBracket().raw;
}
