import { ok, type Result } from '@forgeax/engine-types';
import { type DistanceFieldError, distanceFieldFailure } from './distance-field';

const MAX_TRIANGLES = 1_048_576;
function countValid(count: number) {
  return Number.isInteger(count) && count >= 0 && count <= MAX_TRIANGLES;
}

/** Exact one-bit representation of the source's closed 0/1 sidedness domain. */
export function packTriangleSidedness(
  flags: ArrayLike<number>,
): Result<Uint32Array, DistanceFieldError> {
  if (!countValid(flags.length)) return distanceFieldFailure('invalid triangle sidedness count');
  const words = new Uint32Array(Math.ceil(flags.length / 32));
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    if (flag !== 0 && flag !== 1)
      return distanceFieldFailure('triangle sidedness must be exactly 0 or 1');
    words[i >>> 5] = (words[i >>> 5] ?? 0) | (flag << (i & 31));
  }
  return ok(words);
}

export function validateTriangleSidedness(
  words: Uint32Array,
  count: number,
): Result<void, DistanceFieldError> {
  if (!countValid(count) || words.length !== Math.ceil(count / 32))
    return distanceFieldFailure('triangle sidedness span does not match its count');
  const tail = count & 31;
  if (tail && (words[words.length - 1] ?? 0) >>> tail !== 0)
    return distanceFieldFailure('triangle sidedness padding must be zero');
  return ok(undefined);
}

export function triangleSidednessAt(
  words: Uint32Array,
  count: number,
  index: number,
): Result<0 | 1, DistanceFieldError> {
  const valid = validateTriangleSidedness(words, count);
  if (!valid.ok) return valid;
  if (!Number.isInteger(index) || index < 0 || index >= count)
    return distanceFieldFailure('triangle sidedness index outside source');
  return ok((((words[index >>> 5] ?? 0) >>> (index & 31)) & 1) as 0 | 1);
}
