/**
 * Structural equality of immutable render facts and received descriptor
 * copies: plain records by own enumerable keys (an absent key differs from an
 * explicit `undefined`; prototypes are not compared, so a structured clone
 * equals its source), arrays, Maps, and typed views by bytes. Keys in `ignore`
 * are skipped on the top-level record only. No key arrays are allocated.
 *
 * Callers may reuse and mutate the objects they compare, so identity is only a
 * fast path for the very same object. A caller that holds both sides unchanged
 * for a while (one received packet against frozen owned values) may pass
 * `proven`: every right node found equal records the left node it equals, and
 * a later comparison of that same pair, anywhere in the tree, ends there.
 */
export function sameValue(
  left: unknown,
  right: unknown,
  ignore?: ReadonlySet<string>,
  proven?: Map<object, object>,
): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null)
    return false;
  if (ArrayBuffer.isView(left) || ArrayBuffer.isView(right)) return sameBytes(left, right);
  if (proven?.get(right) === left) return true;
  const equal =
    Array.isArray(left) || Array.isArray(right)
      ? sameArray(left, right, proven)
      : left instanceof Map || right instanceof Map
        ? sameMap(left, right, proven)
        : sameRecord(
            left as Record<string, unknown>,
            right as Record<string, unknown>,
            ignore,
            proven,
          );
  // A comparison that skipped keys proves nothing about the whole node.
  if (equal && ignore === undefined) proven?.set(right, left);
  return equal;
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

function sameArray(left: object, right: object, proven: Map<object, object> | undefined): boolean {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1)
    if (!sameValue(left[index], right[index], undefined, proven)) return false;
  return true;
}

function sameMap(left: object, right: object, proven: Map<object, object> | undefined): boolean {
  if (!(left instanceof Map) || !(right instanceof Map) || left.size !== right.size) return false;
  for (const [key, value] of left)
    if (!right.has(key) || !sameValue(value, right.get(key), undefined, proven)) return false;
  return true;
}

function sameRecord(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
  ignore: ReadonlySet<string> | undefined,
  proven: Map<object, object> | undefined,
): boolean {
  let count = 0;
  for (const key in left) {
    if (!Object.hasOwn(left, key) || ignore?.has(key) === true) continue;
    count += 1;
    if (!Object.hasOwn(right, key) || !sameValue(left[key], right[key], undefined, proven))
      return false;
  }
  for (const key in right) if (Object.hasOwn(right, key) && ignore?.has(key) !== true) count -= 1;
  return count === 0;
}
