import {
  distanceFieldTexel,
  type MeshDistanceField,
  validateMeshDistanceField,
} from '@forgeax/engine-geometry';
import { fnv1a32, ok, type Result } from '@forgeax/engine-types';
import { type RayReferenceError, rayReferenceFailure } from './scene';

/** Private packed storage captured by an exact asset-version owner. */
export class SdfFieldUpload {
  readonly #words: Uint32Array;
  private constructor(
    readonly field: MeshDistanceField,
    words: Uint32Array,
  ) {
    this.#words = words;
  }

  static capture(field: MeshDistanceField): Result<SdfFieldUpload, RayReferenceError> {
    if (!validateMeshDistanceField(field).ok)
      return rayReferenceFailure('invalid or incomplete SDF payload');
    const words =
      field.policy.kind === 'sampled-visibility'
        ? packSampledField(field.values, field.bricks, field.policy.distanceBand, 4_194_304)
        : packGeometricField(field, 4_194_304);
    return words === null
      ? rayReferenceFailure('SDF sample memory exceeds 16 MiB', true)
      : ok(new SdfFieldUpload(field, words));
  }

  get length(): number {
    return this.#words.length;
  }

  copyInto(target: Uint32Array, offset: number): void {
    target.set(this.#words, offset);
  }
}
/** GPU SNORM16 payloads retain the canonical four-cubed field lattice.
 * Nearest encoding differs in magnitude by less than band/32767. For finite
 * |value|<=band, the two binary64 operations have <2^-36 code-unit error;
 * adding the nearest-integer half unit remains strictly below one whole unit.
 * This is only quantization error, not the source unsigned-distance certificate. */
export const SDF_BRICK_EDGE = 4;
function sampledCode(value: number | undefined, band: number): number | null {
  if (value === undefined || !Number.isFinite(value) || Math.abs(value) > band) return null;
  return Math.max(-32767, Math.min(32767, Math.round((value / band) * 32767))) & 65535;
}
/** Every table entry addresses a payload; hashes only select exact-comparison buckets. */
export function packSampledField(
  values: Float32Array,
  bricks: Uint32Array,
  band: number,
  maxWords: number,
): Uint32Array | null {
  const table = bricks.length,
    brickWords = 32;
  if (!(band > 0) || !Number.isFinite(band)) return null;
  if (table + brickWords > maxWords) return null;
  const words = new Uint32Array(Math.min(maxWords, table * (1 + brickWords))),
    brick = new Uint32Array(brickWords),
    chains = new Map<number, number[]>();
  let end = table;
  const encodedOffsets = new Map<number, number>();
  for (const [index, sourceOffset] of bricks.entries()) {
    if (sourceOffset > values.length || values.length - sourceOffset < 64) return null;
    const prior = encodedOffsets.get(sourceOffset);
    if (prior !== undefined) {
      words[index] = prior;
      continue;
    }
    brick.fill(0);
    for (let local = 0; local < 64; local++) {
      const code = sampledCode(values[sourceOffset + local], band);
      if (code === null) return null;
      brick[local >> 1] = (brick[local >> 1] ?? 0) | (code << ((local & 1) * 16));
    }
    const hash = fnv1a32(brick);
    let found = -1;
    const offsets = chains.get(hash);
    if (offsets)
      for (const offset of offsets) {
        let equal = true;
        for (let i = 0; i < brickWords; i++)
          if (words[offset + i] !== brick[i]) {
            equal = false;
            break;
          }
        if (equal) {
          found = offset;
          break;
        }
      }
    if (found < 0) {
      if (end + brickWords > maxWords) return null;
      found = end;
      words.set(brick, end);
      end += brickWords;
      if (offsets) offsets.push(found);
      else chains.set(hash, [found]);
    }
    words[index] = found;
    encodedOffsets.set(sourceOffset, found);
  }
  return words.slice(0, end);
}

/** Geometric uploads stay linear f32; storage indirection does not alter their GPU decoder. */
export function packGeometricField(field: MeshDistanceField, maxWords: number): Uint32Array | null {
  const [nx, ny, nz] = field.dimensions,
    count = nx * ny * nz;
  if (count > maxWords) return null;
  const values = new Float32Array(count);
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++)
        values[(z * ny + y) * nx + x] = distanceFieldTexel(field, x, y, z);
  return new Uint32Array(values.buffer);
}
