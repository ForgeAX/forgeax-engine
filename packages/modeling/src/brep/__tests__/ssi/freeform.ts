import type { Tuple3 } from '../../../geom';
import {
  type NurbsCurve,
  type NurbsSurface,
  nurbs,
  surfaceDomain,
  surfacePoint,
} from '../../../nurbs';
import type { Prng } from './prng';

function must<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

/** A surface over the xy plane: `z = h(x, y)` through a seeded grid of heights, uniformly parameterized, so x and y are exactly linear in (u, v). */
export interface HeightField {
  readonly surface: NurbsSurface;
  /** Height at `(x, y)`, or `undefined` outside the footprint. */
  height(x: number, y: number): number | undefined;
}

export function heightField(
  rng: Prng,
  options: { size: number; count: number; amplitude: number; base?: number; slope?: number },
): HeightField {
  const { size, count, amplitude } = options;
  const rows: Tuple3[][] = [];
  for (let i = 0; i < count; i++) {
    const row: Tuple3[] = [];
    for (let j = 0; j < count; j++) {
      row.push([
        -size + (2 * size * i) / (count - 1),
        -size + (2 * size * j) / (count - 1),
        (options.base ?? 0) +
          (options.slope ?? 0) * (-size + (2 * size * i) / (count - 1)) +
          rng.range(-amplitude, amplitude),
      ]);
    }
    rows.push(row);
  }
  const surface = must(nurbs.grid(rows, { parametrization: 'uniform' }));
  const [[u0, u1], [v0, v1]] = surfaceDomain(surface);
  return {
    surface,
    height(x, y) {
      const s = (x + size) / (2 * size);
      const t = (y + size) / (2 * size);
      if (s < 0 || s > 1 || t < 0 || t > 1) return undefined;
      return (surfacePoint(surface, u0 + (u1 - u0) * s, v0 + (v1 - v0) * t) as Tuple3)[2];
    },
  };
}

const W = Math.SQRT1_2;
const CIRCLE: readonly (readonly [number, number, number])[] = [
  [1, 0, 1],
  [1, 1, W],
  [0, 1, 1],
  [-1, 1, W],
  [-1, 0, 1],
  [-1, -1, W],
  [0, -1, 1],
  [1, -1, W],
  [1, 0, 1],
];
const CIRCLE_KNOTS = [0, 0, 0, 0.25, 0.25, 0.5, 0.5, 0.75, 0.75, 1, 1, 1];

function circle(centre: Tuple3, radius: number, tilt: number): NurbsCurve {
  const ct = Math.cos(tilt);
  const st = Math.sin(tilt);
  return {
    degree: 2,
    points: CIRCLE.map(([c, d]): Tuple3 => {
      const x = radius * c;
      const y = radius * d;
      return [centre[0] + x, centre[1] + y * ct, centre[2] + y * st];
    }),
    weights: CIRCLE.map(([, , w]) => w),
    knots: CIRCLE_KNOTS,
  };
}

/**
 * A bent tube along +x: circular sections (closed in u) with a seeded radius, centre path and tilt,
 * skinned in v. The radius varies, so the surface is no quadric.
 */
export function tube(
  rng: Prng,
  options: { length: number; sections: number; radius: number; wobble: number },
): NurbsSurface {
  const curves: NurbsCurve[] = [];
  for (let k = 0; k < options.sections; k++) {
    const x = -options.length / 2 + (options.length * k) / (options.sections - 1);
    const r = options.radius * (1 + rng.range(-0.3, 0.3));
    curves.push(
      circle(
        [x, rng.range(-options.wobble, options.wobble), rng.range(-options.wobble, options.wobble)],
        r,
        rng.range(-0.4, 0.4),
      ),
    );
  }
  return must(nurbs.loft(curves, { degree: 3, parametrization: 'chord' }));
}

/** A ribbon twisted about +x by a seeded angle per section: line sections of half width `width`, skinned in v. */
export function ribbon(
  rng: Prng,
  options: { length: number; sections: number; width: number; twist: number },
): NurbsSurface {
  const curves: NurbsCurve[] = [];
  let angle = 0;
  for (let k = 0; k < options.sections; k++) {
    const x = -options.length / 2 + (options.length * k) / (options.sections - 1);
    angle += rng.range(0.4, 1) * options.twist;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const w = options.width;
    curves.push({
      degree: 1,
      points: [
        [x, -w * c, -w * s],
        [x, w * c, w * s],
      ],
      knots: [0, 0, 1, 1],
    });
  }
  return must(nurbs.loft(curves, { degree: 3, parametrization: 'chord' }));
}
