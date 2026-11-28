import { cross3, dot3, len3, type P3, scale3, sub3 } from '../vec';

/** Oriented bounding box: centre, orthonormal axes and half-extents along them. */
export interface Obb {
  readonly c: P3;
  readonly e: readonly [P3, P3, P3];
  readonly r: readonly [number, number, number];
}

const WORLD: readonly [P3, P3, P3] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

function normalized(v: P3): P3 | undefined {
  const n = len3(v);
  return n > 1e-14 ? scale3(v, 1 / n) : undefined;
}

function perpendicular(e: P3): P3 {
  const k =
    Math.abs(e[0]) <= Math.abs(e[1]) && Math.abs(e[0]) <= Math.abs(e[2])
      ? 0
      : Math.abs(e[1]) <= Math.abs(e[2])
        ? 1
        : 2;
  const w = WORLD[k] as P3;
  const q = sub3(w, scale3(e, dot3(w, e)));
  return scale3(q, 1 / len3(q));
}

/**
 * An orthonormal frame whose first axis follows the longer of `a`, `b` and whose second spans
 * the other. Any orthonormal frame gives a valid box, so a degenerate pair (a pole) only loses tightness.
 */
export function orthoFrame(a: P3, b: P3 = [0, 0, 0]): readonly [P3, P3, P3] {
  const long = len3(a) >= len3(b) ? a : b;
  const short = long === a ? b : a;
  const e1 = normalized(long) ?? (WORLD[0] as P3);
  let q = sub3(short, scale3(e1, dot3(short, e1)));
  q = sub3(q, scale3(e1, dot3(q, e1)));
  const e2 =
    len3(q) > 1e-9 * Math.max(len3(short), 1e-300) ? scale3(q, 1 / len3(q)) : perpendicular(e1);
  return [e1, e2, cross3(e1, e2)];
}

export function obbPointDistance(b: Obb, p: P3): number {
  const d = sub3(p, b.c);
  let s = 0;
  for (let i = 0; i < 3; i++) {
    const q = Math.abs(dot3(d, b.e[i] as P3)) - (b.r[i] as number);
    if (q > 0) s += q * q;
  }
  return Math.sqrt(s);
}

function support(b: Obb, n: P3): number {
  return (
    (b.r[0] as number) * Math.abs(dot3(b.e[0], n)) +
    (b.r[1] as number) * Math.abs(dot3(b.e[1], n)) +
    (b.r[2] as number) * Math.abs(dot3(b.e[2], n))
  );
}

function isPoint(b: Obb): boolean {
  return b.r[0] === 0 && b.r[1] === 0 && b.r[2] === 0;
}

const SLACK = 1e-12;

/**
 * A lower bound on the distance between any point of `a` and any point of `b`: the best gap over
 * separating axes (the face normals of both boxes, their pairwise cross products and the centre
 * line). Every unit axis gives a valid bound; thin boxes make the normal axes nearly tight.
 */
export function obbDistance(a: Obb, b: Obb): number {
  if (isPoint(b)) return obbPointDistance(a, b.c);
  if (isPoint(a)) return obbPointDistance(b, a.c);
  const d = sub3(b.c, a.c);
  const axes: P3[] = [...a.e, ...b.e];
  for (const x of a.e) for (const y of b.e) axes.push(cross3(x, y));
  axes.push(d);
  let best = 0;
  for (const axis of axes) {
    const n = len3(axis);
    if (n < 1e-8) continue;
    const u = scale3(axis, 1 / n);
    const gap = Math.abs(dot3(d, u)) - support(a, u) - support(b, u);
    if (gap > best) best = gap;
  }
  const mag = len3(d) + Math.max(a.r[0], a.r[1], a.r[2]) + Math.max(b.r[0], b.r[1], b.r[2]);
  return Math.max(0, best - SLACK * (1 + mag));
}

/** The box with the given centre and frame that holds every point of `points`. */
export function obbOfPoints(frame: readonly [P3, P3, P3], origin: P3, points: Iterable<P3>): Obb {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const p of points) {
    const d = sub3(p, origin);
    for (let i = 0; i < 3; i++) {
      const s = dot3(d, frame[i] as P3);
      if (s < (lo[i] as number)) lo[i] = s;
      if (s > (hi[i] as number)) hi[i] = s;
    }
  }
  const mid = [0, 1, 2].map((i) => ((lo[i] as number) + (hi[i] as number)) / 2);
  const c: P3 = [
    origin[0] +
      (mid[0] as number) * frame[0][0] +
      (mid[1] as number) * frame[1][0] +
      (mid[2] as number) * frame[2][0],
    origin[1] +
      (mid[0] as number) * frame[0][1] +
      (mid[1] as number) * frame[1][1] +
      (mid[2] as number) * frame[2][1],
    origin[2] +
      (mid[0] as number) * frame[0][2] +
      (mid[1] as number) * frame[1][2] +
      (mid[2] as number) * frame[2][2],
  ];
  return {
    c,
    e: frame,
    r: [
      ((hi[0] as number) - (lo[0] as number)) / 2,
      ((hi[1] as number) - (lo[1] as number)) / 2,
      ((hi[2] as number) - (lo[2] as number)) / 2,
    ],
  };
}

export function obbSize(b: Obb): number {
  return Math.max(b.r[0], b.r[1], b.r[2]);
}
