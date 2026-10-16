import { distanceFieldTexel, type MeshDistanceField } from '@forgeax/engine-geometry';
/** GPU SNORM16 payloads retain the canonical four-cubed field lattice. */
export const SDF_BRICK_EDGE = 4;
/** Every table entry addresses a payload; hashes only select exact-comparison buckets. */
export function packSampledField(
  values: Float32Array,
  bricks: Uint32Array,
  band: number,
  maxWords: number,
): Uint32Array | null {
  const table = bricks.length,
    brickWords = 32;
  if (table + brickWords > maxWords) return null;
  const words = new Uint32Array(Math.min(maxWords, table * (1 + brickWords))),
    brick = new Uint32Array(brickWords),
    chains = new Map<number, number[]>();
  let end = table;
  const encodedOffsets = new Map<number, number>();
  for (const [index, sourceOffset] of bricks.entries()) {
    const prior = encodedOffsets.get(sourceOffset);
    if (prior !== undefined) {
      words[index] = prior;
      continue;
    }
    brick.fill(0);
    for (let local = 0; local < 64; local++) {
      const code =
        Math.max(
          -32767,
          Math.min(32767, Math.round(((values[sourceOffset + local] ?? 0) / band) * 32767)),
        ) & 65535;
      brick[local >> 1] = (brick[local >> 1] ?? 0) | (code << ((local & 1) * 16));
    }
    let hash = 2166136261;
    for (const word of brick) hash = Math.imul(hash ^ word, 16777619) >>> 0;
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
