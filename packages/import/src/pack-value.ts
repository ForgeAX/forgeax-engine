/**
 * Shared digest and Pack projection: supported numeric views become arrays,
 * rather than the indexed objects that JSON.stringify produces for native views.
 * Objects and arrays remain owned copies; primitive values need no view checks.
 */
export function normaliseForPack(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (
    value instanceof Float32Array ||
    value instanceof Float64Array ||
    value instanceof Uint8Array ||
    value instanceof Uint16Array ||
    value instanceof Uint32Array ||
    value instanceof Int8Array ||
    value instanceof Int16Array ||
    value instanceof Int32Array
  ) {
    return Array.from(value as ArrayLike<number>);
  }
  if (Array.isArray(value)) {
    return value.map(normaliseForPack);
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = normaliseForPack(v);
  }
  return out;
}
