/**
 * Decoder output becomes an owner fact at this boundary. Freeze the ordinary
 * POD graph so a caller cannot mutate the payload between loads. A frozen node
 * is an adopted subtree and is not walked again; freezing a node before its
 * children also lets a cyclic graph terminate.
 * Typed-array storage is deliberately left as an opaque byte/vector carrier:
 * JavaScript cannot freeze a non-empty typed array without changing its public
 * engine type, so owners must treat those carriers as read-only by contract.
 */
export function freezeRuntimePayload<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) freezeRuntimePayload(child);
  return value;
}
