/**
 * Structural equality of immutable render facts and received descriptor
 * copies: plain records by own enumerable keys (an absent key differs from an
 * explicit `undefined`; prototypes are not compared, so a structured clone
 * equals its source), arrays, Maps, and typed views by bytes. Keys in `ignore`
 * are skipped on the top-level record only. Allocation-free: no key arrays.
 *
 * Callers may reuse and mutate the objects they compare, so identity is only a
 * fast path for the very same object.
 */
export function sameValue(left: unknown, right: unknown, ignore?: ReadonlySet<string>): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null)
    return false;
  if (ArrayBuffer.isView(left) || ArrayBuffer.isView(right)) return sameBytes(left, right);
  if (Array.isArray(left) || Array.isArray(right)) return sameArray(left, right);
  if (left instanceof Map || right instanceof Map) return sameMap(left, right);
  return sameRecord(left as Record<string, unknown>, right as Record<string, unknown>, ignore);
}

function sameBytes(left: object, right: object): boolean {
  if (!ArrayBuffer.isView(left) || !ArrayBuffer.isView(right)) return false;
  if (left.byteLength !== right.byteLength) return false;
  const leftBytes = new Uint8Array(left.buffer, left.byteOffset, left.byteLength);
  const rightBytes = new Uint8Array(right.buffer, right.byteOffset, right.byteLength);
  for (let index = 0; index < leftBytes.length; index += 1)
    if (leftBytes[index] !== rightBytes[index]) return false;
  return true;
}

function sameArray(left: object, right: object): boolean {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1)
    if (!sameValue(left[index], right[index])) return false;
  return true;
}

function sameMap(left: object, right: object): boolean {
  if (!(left instanceof Map) || !(right instanceof Map) || left.size !== right.size) return false;
  for (const [key, value] of left)
    if (!right.has(key) || !sameValue(value, right.get(key))) return false;
  return true;
}

function sameRecord(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
  ignore: ReadonlySet<string> | undefined,
): boolean {
  let count = 0;
  for (const key in left) {
    if (!Object.hasOwn(left, key) || ignore?.has(key) === true) continue;
    count += 1;
    if (!Object.hasOwn(right, key) || !sameValue(left[key], right[key])) return false;
  }
  for (const key in right) if (Object.hasOwn(right, key) && ignore?.has(key) !== true) count -= 1;
  return count === 0;
}
