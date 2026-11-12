/**
 * Decoder output becomes an owner fact at this boundary. Freeze the ordinary
 * POD graph so a caller cannot mutate the cached payload between loads.
 * Typed-array storage is deliberately left as an opaque byte/vector carrier:
 * JavaScript cannot freeze a non-empty typed array without changing its public
 * engine type, so owners must treat those carriers as read-only by contract.
 */
export function freezeRuntimePayload<T>(value: T): T {
  const walked: object[] = [];
  const frozen = freeze(value, new WeakSet<object>(), walked);
  // Recorded only after the whole walk finished: a walk that throws leaves no claim.
  for (const node of walked) frozenTrees.add(node);
  return frozen;
}

/**
 * Nodes a completed walk froze together with every descendant. A frozen node
 * cannot gain, lose or swap a property, so its subtree stays frozen and walking
 * it again would change nothing: later payloads that share it skip it.
 */
const frozenTrees = new WeakSet<object>();

function freeze<T>(value: T, seen: WeakSet<object>, walked: object[]): T {
  if (value === null || typeof value !== 'object') return value;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
  if (frozenTrees.has(value) || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) freeze(child, seen, walked);
  Object.freeze(value);
  walked.push(value);
  return value;
}
