/**
 * Decoder output becomes an owner fact at this boundary. Freeze the ordinary
 * POD graph so a caller cannot mutate the cached payload between loads.
 * Typed-array storage is deliberately left as an opaque byte/vector carrier:
 * JavaScript cannot freeze a non-empty typed array without changing its public
 * engine type, so owners must treat those carriers as read-only by contract.
 */
export function freezeRuntimePayload<T>(value: T): T {
  const seen = new WeakSet<object>();
  return freeze(value, seen);
}

function freeze<T>(value: T, seen: WeakSet<object>): T {
  if (value === null || typeof value !== 'object') return value;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) freeze(child, seen);
  return Object.freeze(value);
}
