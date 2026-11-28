// Hero-blaster faces that kept triangles after the rounded-rectangle caps (#671), rebuilt standalone (centimetres).
import { booleanSolids } from '../../src/brep/boolean.ts';
import { box, cylinder, extrude } from '../../src/brep/build.ts';
import { filletPrism } from '../../src/brep/fillet-prism.ts';
import { applyPattern, circularPattern } from '../../src/brep/pattern.ts';
import { transformShape } from '../../src/brep/transform.ts';
import type { Shape } from '../../src/brep/types.ts';
import type { P3 } from '../../src/brep/vec.ts';
import { cos, sin } from '../../src/dmath.ts';
import { must } from '../brep-heal/damage.ts';

const ID: [P3, P3, P3] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
// local (x, y, z) -> world (z, x, y): a prism extruded along local z runs along world +x
const FWD: [P3, P3, P3] = [
  [0, 0, 1],
  [1, 0, 0],
  [0, 1, 0],
];

function place(shape: Shape, t: P3, rot: [P3, P3, P3] = ID): Shape {
  return must(transformShape(shape, { rot, t }));
}

export function roundedRect(w: number, h: number, r: number, n = 5): [number, number][] {
  const c: [number, number][] = [
    [w / 2 - r, h / 2 - r],
    [-(w / 2 - r), h / 2 - r],
    [-(w / 2 - r), -(h / 2 - r)],
    [w / 2 - r, -(h / 2 - r)],
  ];
  const out: [number, number][] = [];
  for (let k = 0; k < 4; k++) {
    for (let i = 0; i <= n; i++) {
      const a = (k * Math.PI) / 2 + ((Math.PI / 2) * i) / n;
      const [cx, cy] = c[k] as [number, number];
      out.push([cx + r * cos(a), cy + r * sin(a)]);
    }
  }
  return out;
}

/** Plate 9 x 5 x 0.4 with four rounded corners and six bores on a r1.8 bolt circle. */
export function boltPlate(): Shape {
  const plate = must(
    filletPrism({
      profile: [
        [-4.5, -2.5],
        [4.5, -2.5],
        [4.5, 2.5],
        [-4.5, 2.5],
      ],
      height: 0.4,
      radii: [1, 1, 1, 1],
    }),
  );
  const bolts = circularPattern(place(must(cylinder({ radius: 0.3, height: 2 })), [1.8, 0, 0.2]), {
    axis: { origin: [0, 0, 0], direction: [0, 0, 1] },
    count: 6,
  });
  return must(applyPattern(plate, must(bolts), 'difference'));
}

/** Trigger blade: vertex-rounded trapezoid prism. */
export function triggerBlade(): Shape {
  return must(
    filletPrism({
      profile: [
        [12.0, 4.6],
        [13.3, 4.6],
        [12.9, 7.2],
        [12.3, 7.2],
      ],
      height: 0.7,
      radii: [0.2, 0.2, 0.25, 0.25],
    }),
  );
}

/** Ejection module slice with a through-slot across the top (second segment of the blaster module). */
export function moduleSlot(): Shape {
  const prism = place(
    must(extrude({ profile: roundedRect(9, 10, 3), depth: 4.5 })),
    [11.5, 0, 0],
    FWD,
  );
  const groove = place(must(box({ size: [0.2, 12, 0.6] })), [15.8, 0, 5]);
  const lined = must(booleanSolids(prism, groove, 'difference'));
  return must(
    booleanSolids(lined, place(must(box({ size: [2.5, 2.6, 14] })), [13.75, 0, 0]), 'difference'),
  );
}
