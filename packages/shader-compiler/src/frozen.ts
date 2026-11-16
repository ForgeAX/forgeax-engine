/**
 * Detached read-only snapshot of compiler output. Containers are copied once and
 * frozen; strings are immutable and shared. `bytes` charges each distinct string
 * once plus a fixed cost per container, approximating what the snapshot holds.
 * Returns undefined for anything that is not plain JSON-like data.
 */
export function freezeSnapshot<T>(value: T): { value: T; bytes: number } | undefined {
  const strings = new Set<string>();
  let containers = 0;
  let unsupported = false;
  const seen = new Set<object>();
  const copy = (input: unknown): unknown => {
    if (typeof input === 'string') {
      strings.add(input);
      return input;
    }
    if (input === null || typeof input !== 'object') {
      if (typeof input === 'function' || typeof input === 'symbol' || typeof input === 'bigint')
        unsupported = true;
      return input;
    }
    const prototype = Object.getPrototypeOf(input);
    const array = Array.isArray(input);
    if (seen.has(input) || (!array && prototype !== Object.prototype && prototype !== null)) {
      unsupported = true;
      return input;
    }
    seen.add(input);
    containers++;
    const output: Record<string, unknown> | unknown[] = array ? new Array(input.length) : {};
    for (const key of Reflect.ownKeys(input)) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (typeof key !== 'string' || descriptor === undefined || !('value' in descriptor)) {
        unsupported = true;
        return input;
      }
      if (array && key === 'length') continue;
      if (!descriptor.enumerable) continue;
      (output as Record<string, unknown>)[key] = copy(descriptor.value);
      if (unsupported) return input;
    }
    seen.delete(input);
    return Object.freeze(output);
  };
  const snapshot = copy(value) as T;
  if (unsupported) return undefined;
  let bytes = containers * 64;
  for (const text of strings) bytes += text.length * 2;
  return { value: snapshot, bytes };
}
