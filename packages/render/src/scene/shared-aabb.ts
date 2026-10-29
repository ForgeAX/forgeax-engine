const copies = new WeakMap<object, Float32Array>();

/**
 * One immutable Float32Array copy per source bounds array instead of one per
 * holder. A content check re-copies when the source was rewritten in place,
 * so holders of an earlier copy keep their exact values.
 */
export function sharedAabb(source: ArrayLike<number> & object): Float32Array {
  const cached = copies.get(source);
  if (cached !== undefined && cached.length === source.length) {
    let same = true;
    for (let index = 0; index < cached.length; index++)
      if (!Object.is(cached[index], Math.fround(source[index] ?? 0))) same = false;
    if (same) return cached;
  }
  const copy = new Float32Array(source);
  copies.set(source, copy);
  copies.set(copy, copy);
  return copy;
}
