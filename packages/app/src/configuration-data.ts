import { EngineConfigurationError } from './configuration-error';

export function invalid(path: string, reason: string): never {
  throw new EngineConfigurationError('configuration-invalid', { path, reason });
}

function validateArrayData(
  value: readonly unknown[],
  keys: readonly PropertyKey[],
  path: string,
): void {
  if (
    keys.length !== value.length + 1 ||
    keys.some(
      (key) =>
        key !== 'length' &&
        (typeof key !== 'string' ||
          String(Number(key)) !== key ||
          !Number.isInteger(Number(key)) ||
          Number(key) < 0 ||
          Number(key) >= value.length),
    )
  )
    invalid(path, 'arrays must be dense data with no extra properties');
}

/** Copy only parameter data, without invoking accessors or retaining caller objects. */
export function ownConfigurationData(
  value: unknown,
  path = 'configuration',
  seen = new Set<object>(),
): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid(path, 'numbers must be finite');
    return value;
  }
  if (typeof value !== 'object') invalid(path, 'expected parameter data');
  if (seen.has(value)) invalid(path, 'cyclic parameter data');
  const proto = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null)
    invalid(path, 'expected a plain data object');
  seen.add(value);
  const output: Record<string, unknown> = {};
  const keys = Reflect.ownKeys(value);
  if (Array.isArray(value)) validateArrayData(value, keys, path);
  for (const key of keys) {
    if (Array.isArray(value) && key === 'length') continue;
    if (typeof key !== 'string' || key === '__proto__') invalid(path, 'invalid parameter key');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor))
      invalid(`${path}.${key}`, 'accessors are not parameter data');
    output[key] = ownConfigurationData(descriptor.value, `${path}.${key}`, seen);
  }
  seen.delete(value);
  return Array.isArray(value) ? Object.values(output) : output;
}

export function freezeConfiguration<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeConfiguration(child);
    Object.freeze(value);
  }
  return value;
}

/** Parameter trees merge by field; arrays and primitives replace, never append. */
export function mergeConfiguration<T>(base: T, patch: unknown): T {
  if (patch === undefined) return base;
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch as T;
  const output = { ...(base as object) } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch))
    output[key] = mergeConfiguration(output[key], value);
  return output as T;
}

export function recordSources(
  value: unknown,
  source: string,
  output: Record<string, string>,
  path = 'settings',
): void {
  if (value === undefined) return;
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value))
      recordSources(child, source, output, `${path}.${key}`);
  } else output[path] = source;
}
