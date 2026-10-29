// rng.ts — seeded pseudo-random stream for deterministic procedural content.
//
// Algorithm: sfc32 (Chris Doty-Humphrey's Small Fast Chaotic generator, 128-bit
// state, passes PractRand to multiple TB), seeded by four splitmix32 outputs of
// a uint32 seed. String seeds and fork labels are hashed with FNV-1a over
// UTF-16 code units followed by the murmur3 fmix32 finalizer. Every step uses
// int32 arithmetic (`| 0`, `>>> 0`, `Math.imul`), so a seed yields the same
// stream on every conforming JavaScript engine.

/** Deterministic stream; one instance per independent consumer. */
export interface Rng {
  /** uint32 seed this stream was derived from (stable identity for `fork`). */
  readonly seed: number;
  /** Next float in [0, 1); multiples of 2^-32. */
  next(): number;
  /**
   * Integer in the inclusive interval [min, max].
   * @degrade bounds are rounded inward (`ceil(min)`, `floor(max)`); an empty interval returns `ceil(min)`.
   */
  int(min: number, max: number): number;
  /** Float in [min, max). */
  range(min: number, max: number): number;
  /** Uniform element of `items`; `undefined` only for an empty array. */
  pick<T>(items: readonly T[]): T | undefined;
  /**
   * Labelled child stream derived from `seed` and `label` only — independent of
   * how many values this stream has drawn, and drawing from it leaves this
   * stream untouched. Adding a new consumer therefore never shifts others.
   */
  fork(label: string): Rng;
}

const FNV_OFFSET = 0x811c9dc5;

function hashString(text: string, basis: number): number {
  let h = basis;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

function fromSeed32(seed: number): Rng {
  let s = seed;
  const splitmix = (): number => {
    s = (s + 0x9e3779b9) | 0;
    let t = s ^ (s >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t ^= t >>> 15;
    t = Math.imul(t, 0x735a2d97);
    return t ^ (t >>> 15);
  };
  let a = splitmix();
  let b = splitmix();
  let c = splitmix();
  let d = splitmix();
  const next = (): number => {
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  return {
    seed,
    next,
    int(min, max) {
      const lo = Math.ceil(min);
      const span = Math.floor(max) - lo + 1;
      return span > 0 ? lo + Math.floor(next() * span) : lo;
    },
    range: (min, max) => min + next() * (max - min),
    pick: (items) => items[Math.floor(next() * items.length)],
    fork: (label) => fromSeed32(hashString(label, seed)),
  };
}

/**
 * Create a deterministic stream. Same seed, same sequence, on every platform.
 *
 * @degrade number seeds are reduced with ToUint32 (`seed >>> 0`): fractional
 * parts and bits above 2^32 are discarded and NaN / ±Infinity become 0. Pass a
 * string for seeds outside that range (e.g. `String(Date.now())`).
 * @example
 * const world = rng.create('island-7');
 * const trees = world.fork('trees');
 * const x = trees.range(-50, 50);
 */
export function create(seed: number | string): Rng {
  return fromSeed32(typeof seed === 'string' ? hashString(seed, FNV_OFFSET) : seed >>> 0);
}
