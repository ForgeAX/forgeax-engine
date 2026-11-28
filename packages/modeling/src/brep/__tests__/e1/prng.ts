/** Seeded generator of the SSI corpus: mulberry32 draws in [0, 1), so a seed fixes every pose and height field. */
export interface Prng {
  next(): number;
  range(lo: number, hi: number): number;
  /** Integer in [lo, hi]. */
  int(lo: number, hi: number): number;
  /** Unit vector with a uniform direction (rejection sampled in the cube). */
  direction(): readonly [number, number, number];
}

export function prng(seed: number): Prng {
  let s = seed >>> 0;
  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const range = (lo: number, hi: number): number => lo + (hi - lo) * next();
  return {
    next,
    range,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    direction() {
      for (;;) {
        const x = range(-1, 1);
        const y = range(-1, 1);
        const z = range(-1, 1);
        const l = Math.hypot(x, y, z);
        if (l > 0.1 && l <= 1) return [x / l, y / l, z / l];
      }
    },
  };
}
