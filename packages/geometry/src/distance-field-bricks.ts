import type { FieldVec3, MeshDistanceField } from '@forgeax/engine-types';

/** Combined indirection and f32 payload budget, independent of virtual volume size. */
export const MAX_DISTANCE_FIELD_BYTES = 32 * 1024 * 1024;

/** First lattice sample of brick `index`; bricks hold 4^3 samples in x-fastest order. */
export function fieldBrickStart(dimensions: FieldVec3, index: number): FieldVec3 {
  const bx = Math.ceil(dimensions[0] / 4),
    by = Math.ceil(dimensions[1] / 4);
  return [(index % bx) * 4, (Math.floor(index / bx) % by) * 4, Math.floor(index / (bx * by)) * 4];
}

/** Lane holding brick sample (i, j, k): the sample itself inside the volume, the clamped edge sample in padding. */
export function fieldBrickLane(
  dimensions: FieldVec3,
  start: FieldVec3,
  i: number,
  j: number,
  k: number,
): number {
  return (
    (Math.min(k, dimensions[2] - 1 - start[2]) * 4 + Math.min(j, dimensions[1] - 1 - start[1])) *
      4 +
    Math.min(i, dimensions[0] - 1 - start[0])
  );
}

/**
 * Build-time storage; full word comparison resolves hash collisions, including signed zero.
 * Producers write in-volume lanes only: `store` replicates edge samples into padded lanes.
 */
export class FieldBrickBuilder {
  readonly bricks: Uint32Array;
  private readonly dimensions: FieldVec3;
  private values: Float32Array;
  private words: Uint32Array;
  private used = 0;
  private readonly chains = new Map<number, number[]>();

  constructor(dimensions: FieldVec3) {
    this.dimensions = dimensions;
    this.bricks = new Uint32Array(dimensions.reduce((n, v) => n * Math.ceil(v / 4), 1));
    this.values = new Float32Array(1024);
    this.words = new Uint32Array(this.values.buffer);
  }

  store(index: number, values: Float32Array): boolean {
    const start = fieldBrickStart(this.dimensions, index);
    for (let k = 0; k < 4; k++)
      for (let j = 0; j < 4; j++)
        for (let i = 0; i < 4; i++) {
          const lane = (k * 4 + j) * 4 + i,
            source = fieldBrickLane(this.dimensions, start, i, j, k);
          if (source !== lane) values[lane] = values[source] ?? NaN;
        }
    const words = new Uint32Array(values.buffer, values.byteOffset, 64);
    let hash = 2166136261;
    for (const word of words) hash = Math.imul(hash ^ word, 16777619) >>> 0;
    const candidates = this.chains.get(hash);
    if (candidates)
      for (const offset of candidates) {
        let equal = true;
        for (let i = 0; i < 64; i++)
          if (this.words[offset + i] !== words[i]) {
            equal = false;
            break;
          }
        if (equal) {
          this.bricks[index] = offset;
          return true;
        }
      }
    const end = this.used + 64;
    if (this.bricks.byteLength + end * 4 > MAX_DISTANCE_FIELD_BYTES) return false;
    if (end > this.values.length) {
      const grown = new Float32Array(
        Math.min(
          this.values.length * 2,
          Math.floor((MAX_DISTANCE_FIELD_BYTES - this.bricks.byteLength) / 256) * 64,
        ),
      );
      grown.set(this.values);
      this.values = grown;
      this.words = new Uint32Array(grown.buffer);
    }
    this.words.set(words, this.used);
    this.bricks[index] = this.used;
    if (candidates) candidates.push(this.used);
    else this.chains.set(hash, [this.used]);
    this.used = end;
    return true;
  }

  finish(): Pick<MeshDistanceField, 'bricks' | 'values'> {
    return { bricks: this.bricks, values: this.values.slice(0, this.used) };
  }
}

/** Exact lattice sample; callers use validated dimensions and coordinates. */
export function distanceFieldTexel(
  field: Pick<MeshDistanceField, 'dimensions' | 'bricks' | 'values'>,
  x: number,
  y: number,
  z: number,
): number {
  const [nx, ny] = field.dimensions;
  const brick =
    (Math.floor(z / 4) * Math.ceil(ny / 4) + Math.floor(y / 4)) * Math.ceil(nx / 4) +
    Math.floor(x / 4);
  const offset = field.bricks[brick];
  if (offset === undefined) throw new RangeError('distance-field brick outside validated volume');
  const value = field.values[offset + ((z % 4) * 4 + (y % 4)) * 4 + (x % 4)];
  if (value === undefined) throw new RangeError('distance-field sample outside validated payload');
  return value;
}

/** Geometric fields keep their exact dense computation, then publish the same brick contract. */
export function brickDistanceFieldValues(
  dimensions: FieldVec3,
  values: Float32Array,
): Pick<MeshDistanceField, 'bricks' | 'values'> | null {
  const builder = new FieldBrickBuilder(dimensions),
    brick = new Float32Array(64);
  const [nx, ny] = dimensions;
  for (let index = 0; index < builder.bricks.length; index++) {
    const start = fieldBrickStart(dimensions, index),
      [x, y, z] = start;
    for (let k = 0; k < 4; k++)
      for (let j = 0; j < 4; j++)
        for (let i = 0; i < 4; i++) {
          const lane = (k * 4 + j) * 4 + i;
          if (fieldBrickLane(dimensions, start, i, j, k) === lane)
            brick[lane] = values[((z + k) * ny + y + j) * nx + x + i] ?? NaN;
        }
    if (!builder.store(index, brick)) return null;
  }
  return builder.finish();
}

/** Validate addresses, exact edge padding and the logical negative-sample count. */
export function fieldBrickNegativeSamples(field: MeshDistanceField): number | null {
  const { dimensions, bricks, values } = field;
  if (
    !(bricks instanceof Uint32Array) ||
    !(values instanceof Float32Array) ||
    bricks.length !== dimensions.reduce((n, d) => n * Math.ceil(d / 4), 1) ||
    values.length === 0 ||
    values.length % 64 !== 0 ||
    bricks.byteLength + values.byteLength > MAX_DISTANCE_FIELD_BYTES ||
    !values.every(Number.isFinite)
  )
    return null;
  const words = new Uint32Array(values.buffer, values.byteOffset, values.length);
  const counts = new Int8Array(values.length / 64),
    seen = new Uint8Array(counts.length);
  for (let b = 0; b < counts.length; b++)
    for (let i = 0; i < 64; i++)
      if ((values[b * 64 + i] ?? 0) < 0) counts[b] = (counts[b] ?? 0) + 1;
  const [nx, ny, nz] = dimensions;
  let negative = 0;
  for (const [index, offset] of bricks.entries()) {
    if (offset % 64 || offset + 64 > values.length) return null;
    seen[offset / 64] = 1;
    const start = fieldBrickStart(dimensions, index),
      [x, y, z] = start;
    if (x + 4 <= nx && y + 4 <= ny && z + 4 <= nz) negative += counts[offset / 64] ?? 0;
    else
      for (let k = 0; k < 4; k++)
        for (let j = 0; j < 4; j++)
          for (let i = 0; i < 4; i++) {
            const lane = (k * 4 + j) * 4 + i,
              source = fieldBrickLane(dimensions, start, i, j, k);
            if (source === lane) {
              if ((values[offset + lane] ?? 0) < 0) negative++;
            } else if (words[offset + lane] !== words[offset + source]) return null;
          }
  }
  return seen.every((v) => v === 1) ? negative : null;
}
