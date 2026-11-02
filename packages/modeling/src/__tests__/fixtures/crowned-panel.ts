import type { Tuple3 } from '../../geom';
import { type NurbsSurface, nurbs } from '../../nurbs';
import type { NamedSurface } from '../../surface-quality';

const crownX = (x: number) => 0.02 * (1 - ((x - 0.3) / 0.3) * ((x - 0.3) / 0.3));
const crownY = (y: number) => 0.012 * (1 - ((y - 0.2) / 0.2) * ((y - 0.2) / 0.2));

/** A crowned 0.6 x 0.4 m panel: two Bezier spans in u joined at x = 0.3, kinked by theta there. */
export function panel(theta: number): NurbsSurface {
  const slope = Math.tan((theta * Math.PI) / 180);
  const points = Array.from({ length: 7 }, (_, i) =>
    Array.from({ length: 4 }, (_, j): Tuple3 => {
      const x = 0.1 * i;
      const y = (0.4 * j) / 3;
      const z = i === 3 ? (crownX(0.2) + crownX(0.4)) / 2 : crownX(x);
      return [x, y, z + crownY(y) + (i >= 4 ? slope * (x - 0.3) : 0)];
    }),
  );
  return {
    degreeU: 3,
    degreeV: 3,
    points,
    knotsU: [0, 0, 0, 0, 0.5, 0.5, 0.5, 1, 1, 1, 1],
    knotsV: [0, 0, 0, 0, 1, 1, 1, 1],
  };
}

export function split(
  s: NurbsSurface,
  along: 'u' | 'v',
  at: number,
): readonly [NurbsSurface, NurbsSurface] {
  const r = nurbs.surface.split(s, along, at);
  if (!r.ok) throw r.error;
  return r.value;
}

/** The panel cut into two patches at its joint (x = 0.3), named l and r. */
export function halves(theta: number): NamedSurface[] {
  const [l, r] = split(panel(theta), 'u', 0.5);
  return [
    { name: 'l', surface: l },
    { name: 'r', surface: r },
  ];
}
