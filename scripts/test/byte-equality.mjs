/** Compare the complete byte payload without enumerating a property for every byte. */
export function equalBytes(actual, expected) {
  if (actual === expected) return true;
  if (actual === undefined || expected === undefined || actual.byteLength !== expected.byteLength)
    return false;
  for (let index = 0; index < actual.byteLength; index++)
    if (actual[index] !== expected[index]) return false;
  return true;
}

/** Snapshot maps retain exact membership and the complete payload for every key. */
export function equalByteMaps(actual, expected) {
  if (actual === expected) return true;
  if (actual === undefined || expected === undefined || actual.size !== expected.size) return false;
  for (const [key, bytes] of actual)
    if (!expected.has(key) || !equalBytes(bytes, expected.get(key))) return false;
  return true;
}
